import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { resolveMessageKey, type Db } from "./db.js";

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
    .prepare("SELECT message_id, date, from_addr, from_name, subject, snippet, truncated, eml_path FROM messages WHERE message_id = ?")
    .get(key) as MessageRow;
}

function getCopies(db: Db, messageId: string): CopyRow[] {
  return db
    .prepare("SELECT account_id, folder, uid, flags FROM copies WHERE message_id = ?")
    .all(messageId) as CopyRow[];
}

async function parseEml(dataDir: string, row: MessageRow) {
  if (row.truncated === 1 || !row.eml_path) {
    throw new Error("该邮件原文未留存（超大小阈值），暂不支持按需拉取（v1）");
  }
  return simpleParser(readFileSync(join(dataDir, row.eml_path)), { keepCidLinks: true });
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
    attachments: parsed.attachments.map((a, i) => ({
      index: i,
      filename: a.filename ?? `attachment-${i}`,
      contentType: a.contentType,
      size: a.size,
      inline: a.contentDisposition === "inline",
    })),
    copies: getCopies(db, row.message_id).map((c) => ({
      account: c.account_id,
      folder: c.folder,
      uid: c.uid,
      flags: c.flags ? c.flags.split(" ") : [],
    })),
  };
}

export async function getAttachment(db: Db, dataDir: string, messageId: string, index: number) {
  const row = getMessageRow(db, messageId);
  const parsed = await parseEml(dataDir, row);
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
