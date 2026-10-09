import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { resolveMessageKey, type Db } from "./db.js";
import { connectAccount, fetchPartBody, openReadOnly } from "./imap.js";
import { decodePartPayload, type AttachmentEntry } from "./mime.js";
import type { AccountConfig, AccountCredential } from "./types.js";

/**
 * 工具面的读取侧：从本地索引 + .eml 原文组装邮件详情（read_message / get_attachment）。
 * 附件按需取（红线 12）：read_message 只给元数据，内容走 get_attachment。
 * 注意 eml_path 是相对 dataDir 的路径（与 webmail 侧同一约定），读取时必须拼 dataDir。
 */

const MAX_BODY_CHARS = 50_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

interface MessageRow {
  message_id: string;
  date: string | null;
  from_addr: string | null;
  from_name: string | null;
  subject: string | null;
  snippet: string;
  truncated: number;
  eml_path: string;
  /** 精简原文的附件清单（NULL = 原文完整；见 mime.ts） */
  attachments_json?: string | null;
}

interface CopyRow {
  account_id: string;
  folder: string;
  uid: number;
  flags: string;
}

/** 宽容归一后取消息行；索引不存在即拒绝（3.5） */
function getMessageRow(db: Db, messageIdInput: string): MessageRow {
  const key = resolveMessageKey(db, messageIdInput);
  if (!key) throw new Error(`本地索引不存在该消息：${messageIdInput}`);
  return db
    .prepare(
      "SELECT message_id, date, from_addr, from_name, subject, snippet, truncated, eml_path, attachments_json FROM messages WHERE message_id = ?"
    )
    .get(key) as MessageRow;
}

function getCopies(db: Db, messageId: string): CopyRow[] {
  return db
    .prepare("SELECT account_id, folder, uid, flags FROM copies WHERE message_id = ?")
    .all(messageId) as CopyRow[];
}

async function parseEml(dataDir: string, row: MessageRow) {
  // ⚠ truncated=1 有两种（见 db.ts）：有 eml_path = **精简原文**（正文可读、附件按需），
  //   没有 eml_path = 只存了索引。只有后者读不了。
  if (!row.eml_path) {
    throw new Error("该邮件只入库了索引（超大邮件），正文未留存");
  }
  return simpleParser(readFileSync(join(dataDir, row.eml_path)), { keepCidLinks: true });
}

/** 清单（精简原文才有） */
function manifestOf(row: MessageRow): AttachmentEntry[] | null {
  if (!row.attachments_json) return null;
  try {
    return JSON.parse(row.attachments_json) as AttachmentEntry[];
  } catch {
    return null;
  }
}

export async function readMessage(db: Db, dataDir: string, messageId: string) {
  const row = getMessageRow(db, messageId);
  const parsed = await parseEml(dataDir, row);
  const text = parsed.text ?? "";
  return {
    messageId: row.message_id,
    subject: row.subject ?? "",
    from: { name: row.from_name ?? "", address: row.from_addr ?? "" },
    to: (parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]) : []).flatMap((g) =>
      g.value.map((a) => ({ name: a.name ?? "", address: a.address ?? "" }))
    ),
    cc: (parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]) : []).flatMap((g) =>
      g.value.map((a) => ({ name: a.name ?? "", address: a.address ?? "" }))
    ),
    date: row.date,
    text: text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + "\n…[正文过长已截断]" : text,
    textTruncated: text.length > MAX_BODY_CHARS,
    // 精简原文：附件清单以**同步时记下的**为准（本地那份里没有被推迟的附件）
    attachments: (manifestOf(row) ?? parsed.attachments.map((a, i) => ({
      index: i,
      filename: a.filename ?? `attachment-${i}`,
      contentType: a.contentType,
      size: a.size,
      cid: a.cid ?? null,
      inline: a.contentDisposition === "inline",
      deferred: false,
    }))).map((a) => ({
      index: a.index,
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
      inline: a.inline,
      /** true = 本体不在本地，get_attachment 会按需向邮箱取 */
      deferred: a.deferred,
    })),
    copies: getCopies(db, row.message_id).map((c) => ({
      account: c.account_id,
      folder: c.folder,
      uid: c.uid,
      flags: c.flags ? c.flags.split(" ") : [],
    })),
  };
}

export interface AttachmentContext {
  db: Db;
  dataDir: string;
  /** 按需取被推迟的附件时要连邮箱（只读 EXAMINE + BODY.PEEK，红线 1/10） */
  accounts: AccountConfig[];
  creds: Record<string, AccountCredential>;
}

/**
 * 取附件内容（base64）。
 *
 * - 原文完整 → 从本地 .eml 按序号取（老路径）；
 * - **精简原文**（附件门控）→ 清单里的 `deferred` 项按**部件号**当场向邮箱取一次
 *   （只取那一个部件，不下载整封），再按传输编码解码；已留存的内嵌图从本地按 cid 取。
 */
export async function getAttachment(
  ctx: AttachmentContext,
  messageId: string,
  index: number
) {
  const row = getMessageRow(ctx.db, messageId);
  const manifest = manifestOf(row);
  if (manifest) {
    const entry = manifest.find((e) => e.index === index);
    if (!entry) throw new Error(`附件序号越界：${index}`);
    if (entry.size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`附件过大（${entry.size} 字节 > ${MAX_ATTACHMENT_BYTES}），请到 webmail 界面下载`);
    }
    if (!entry.deferred) {
      const parsed = await parseEml(ctx.dataDir, row);
      const want = (entry.cid ?? "").replace(/[<>]/g, "").toLowerCase();
      const att = parsed.attachments.find(
        (a) => (a.cid ?? "").replace(/[<>]/g, "").toLowerCase() === want
      );
      if (!att) throw new Error(`本地精简原文里找不到这个内嵌附件：${entry.filename}`);
      return {
        filename: att.filename ?? entry.filename,
        contentType: att.contentType,
        size: att.size,
        contentBase64: att.content.toString("base64"),
      };
    }
    const fetched = await fetchDeferredPart(ctx, messageId, entry);
    if (!fetched) {
      throw new Error(
        `附件未在本地留存，且这次没能从邮箱取回（${entry.filename}）；可在站内邮件界面点该附件重试`
      );
    }
    return {
      filename: entry.filename,
      contentType: entry.contentType,
      size: fetched.length,
      contentBase64: fetched.toString("base64"),
    };
  }

  const parsed = await parseEml(ctx.dataDir, row);
  const att = parsed.attachments[index];
  if (!att) throw new Error(`附件序号越界：${index}（共 ${parsed.attachments.length} 个）`);
  if (att.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件过大（${att.size} 字节 > ${MAX_ATTACHMENT_BYTES}），请到 webmail 界面下载`);
  }
  return {
    filename: att.filename ?? `attachment-${index}`,
    contentType: att.contentType,
    size: att.size,
    contentBase64: att.content.toString("base64"),
  };
}

/** 按副本依次尝试按部件取（只读；取回后按传输编码解码，与本地解析口径一致） */
async function fetchDeferredPart(
  ctx: AttachmentContext,
  messageId: string,
  entry: AttachmentEntry
): Promise<Buffer | null> {
  if (!entry.part) return null;
  for (const copy of getCopies(ctx.db, messageId)) {
    const account = ctx.accounts.find((a) => a.id === copy.account_id);
    const cred = ctx.creds[copy.account_id];
    if (!account || !cred) continue;
    try {
      const client = await connectAccount(account, cred);
      try {
        await openReadOnly(client, copy.folder);
        const raw = await fetchPartBody(client, copy.uid, entry.part);
        return raw ? decodePartPayload(raw, entry.encoding) : null;
      } finally {
        await client.logout().catch(() => {});
      }
    } catch {
      // 换下一个副本
    }
  }
  return null;
}
