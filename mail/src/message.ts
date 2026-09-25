import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleParser, type AddressObject } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Db } from "./db.js";
import type { NewMeta } from "./imap.js";

/** Message-ID 规范化：去尖括号、去空白、小写（副本去重键，4.2） */
export function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/[<>]/g, "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/** mailparser 的地址头：同名头出现多次时是数组，归一化后平铺 value */
function addressValues(v: AddressObject | AddressObject[] | undefined) {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap((a) => a.value);
}

function sha1(input: string | Buffer): string {
  return createHash("sha1").update(input).digest("hex");
}

function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

function snippetOf(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Message-ID 缺失时的回退键：(From, Date, Subject) 规范化哈希（副本间三者一致） */
function messageKey(mid: string | null, fromAddr: string, dateIso: string, subject: string): string {
  if (mid) return `mid:${mid}`;
  return `auto:${sha1(`${fromAddr}|${dateIso}|${subject}`)}`;
}

export interface IngestInput {
  accountId: string;
  folder: string;
  meta: NewMeta;
  /** 完整原文；超阈值邮件缺省（只存元数据，truncated=1） */
  source?: Buffer;
}

export interface IngestResult {
  messageId: string;
  created: boolean;
}

/**
 * 一封邮件入库：messages 按 Message-ID 只存一份（多副本共享），
 * copies 按（账号, 文件夹, UID）各存一行。幂等：重复入库不产生新行。
 */
export async function ingestMessage(
  db: Db,
  dataDir: string,
  input: IngestInput
): Promise<IngestResult> {
  const { meta } = input;
  const env = meta.envelope;
  const fromAddr = env?.from?.[0]?.address ?? "";
  const fromName = env?.from?.[0]?.name ?? "";
  const dateIso = (env?.date ?? meta.internalDate ?? new Date()).toISOString();
  const subject = env?.subject ?? "";
  const mid = normalizeMessageId(env?.messageId);

  let bodyText = "";
  let toJson = "[]";
  let ccJson = "[]";
  let size = meta.size;

  if (input.source) {
    const parsed = await simpleParser(input.source);
    bodyText = parsed.text ?? (typeof parsed.html === "string" ? stripHtml(parsed.html) : "");
    toJson = JSON.stringify(addressValues(parsed.to));
    ccJson = JSON.stringify(addressValues(parsed.cc));
    size = input.source.length;
  } else if (env) {
    toJson = JSON.stringify(env.to ?? []);
    ccJson = JSON.stringify(env.cc ?? []);
  }

  const messageId = messageKey(mid, fromAddr, dateIso, subject);
  const truncated = input.source ? 0 : 1;
  const emlRel = input.source ? join("eml", `${sha1(messageId)}.eml`) : "";

  const existing = db
    .prepare("SELECT message_id FROM messages WHERE message_id = ?")
    .get(messageId) as { message_id: string } | undefined;

  let created = false;
  if (!existing) {
    if (input.source) {
      // 原文 .eml 原子写入（先查再写，单进程无并发）
      const abs = join(dataDir, emlRel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs + ".tmp", input.source);
      renameSync(abs + ".tmp", abs);
    }
    const insertAll = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        messageId,
        dateIso,
        fromAddr,
        fromName,
        toJson,
        ccJson,
        subject,
        snippetOf(bodyText),
        size,
        truncated,
        new Date().toISOString(),
        emlRel
      );
      db.prepare(
        "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)"
      ).run(messageId, subject, `${fromName} ${fromAddr}`.trim(), toAddresses(toJson), bodyText);
    });
    insertAll();
    created = true;
  }

  db.prepare(
    `INSERT INTO copies (account_id, folder, uid, message_id, flags)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, folder, uid) DO UPDATE SET message_id = excluded.message_id, flags = excluded.flags`
  ).run(input.accountId, input.folder, meta.uid, messageId, meta.flags.join(" "));

  return { messageId, created };
}

function toAddresses(toJson: string): string {
  const list = JSON.parse(toJson) as { address?: string }[];
  return list.map((a) => a.address ?? "").join(" ");
}
