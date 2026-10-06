import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import sanitizeHtml from "sanitize-html";
import type { Db } from "./db.js";
import type { NewMeta } from "./imap.js";

/** Message-ID 规范化：去尖括号、去空白、小写（副本去重键，4.2） */
export function normalizeMessageId(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const v = raw.replace(/[<>]/g, "").trim().toLowerCase();
  return v.length > 0 ? v : null;
}

/**
 * 规范化引用键：与库键同形（`mid:<normalized>`）。
 * 额外剔除引号与反斜线——refs_json 以 JSON 存储、按带引号子串精确匹配（thread.ts），
 * 原始值若含这两类字符会破坏匹配语义（RFC 上 Message-ID 本就不允许它们）。
 */
export function refKeyOf(raw: string | undefined | null): string | null {
  const bare = raw?.replace(/[<>\\"]/g, "").trim().toLowerCase();
  return bare ? `mid:${bare}` : null;
}

/** 从解析结果提取引用链：References 各环 + In-Reply-To 尾环，去重保序（4.7） */
export function extractRefKeys(parsed: ParsedMail): string[] {
  const refs = Array.isArray(parsed.references)
    ? parsed.references
    : parsed.references
      ? [parsed.references]
      : [];
  const keys: string[] = [];
  for (const raw of [...refs, parsed.inReplyTo]) {
    const k = refKeyOf(raw);
    if (k && !keys.includes(k)) keys.push(k);
  }
  return keys;
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
  let refsJson = "[]";
  let hasAttach = 0;

  if (input.source) {
    const parsed = await simpleParser(input.source);
    bodyText = parsed.text ?? (typeof parsed.html === "string" ? stripHtml(parsed.html) : "");
    toJson = JSON.stringify(addressValues(parsed.to));
    ccJson = JSON.stringify(addressValues(parsed.cc));
    size = input.source.length;
    refsJson = JSON.stringify(extractRefKeys(parsed));
    // 附件指示口径（4.2）：只算「可下载附件」，内嵌图（inline）不算
    hasAttach = parsed.attachments.some((a) => a.contentDisposition === "attachment") ? 1 : 0;
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
        `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        emlRel,
        refsJson,
        hasAttach
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

/**
 * 存量回填（4.7）：refs_json 仍为 NULL 且留有原文的行，重解析原文提取引用链与附件标记。
 * 幂等（只动 NULL 行）；单行失败跳过并计数，不阻塞启动。
 */
export async function backfillRefs(db: Db, dataDir: string): Promise<{ updated: number; failed: number }> {
  const rows = db
    .prepare("SELECT message_id, eml_path FROM messages WHERE refs_json IS NULL AND eml_path != ''")
    .all() as { message_id: string; eml_path: string }[];
  if (rows.length === 0) return { updated: 0, failed: 0 };
  const update = db.prepare("UPDATE messages SET refs_json = ?, has_attach = ? WHERE message_id = ?");
  let updated = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const raw = readFileSync(join(dataDir, row.eml_path));
      const parsed = await simpleParser(raw);
      const hasAttach = parsed.attachments.some((a) => a.contentDisposition === "attachment") ? 1 : 0;
      update.run(JSON.stringify(extractRefKeys(parsed)), hasAttach, row.message_id);
      updated++;
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}
