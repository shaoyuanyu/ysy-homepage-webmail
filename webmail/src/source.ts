import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { simpleParser } from "mailparser";
import { connectAccount, fetchSource, openReadOnly } from "../../mail/src/imap.js";
import { extractRefKeys, snippetOf } from "../../mail/src/message.js";
import { withAccountLock } from "./locks.js";
import type { WebmailContext } from "./api.js";

/**
 * 超阈值邮件的**按需取原文**（2026-10-07）。
 *
 * 背景：抓取器对 `size > MAIL_AGENT_MAX_SOURCE_BYTES`（缺省 50MB）的邮件只入库元数据
 * （红线 12：大附件不默认下载，否则磁盘很快被吃掉），`truncated = 1`、`eml_path` 为空。
 * 代价是这类邮件在站内**点开是空的**——正文、附件列表都没有，且此前 UI 也不提示，
 * 看起来像"坏掉的空邮件"。
 *
 * 这里给出补取路径：显式点击才下载一次原文，落盘并回填索引（truncated → 0），
 * 之后与普通邮件完全一致。仍然不改变"默认不下载大附件"的红线。
 */

/** 单次按需取原文的上限：超过直接拒绝，避免把进程内存打爆（比缺省的抓取阈值宽松一档） */
const MAX_ONDEMAND_BYTES = Number(process.env.WEBMAIL_MAX_ONDEMAND_BYTES ?? 200 * 1024 * 1024);

export interface SourceResult {
  /** 是否真的下载了（false = 本来就有原文，幂等） */
  fetched: boolean;
  size: number;
}

/**
 * 取一封 truncated 邮件的原文：按副本依次尝试（哪个账号/文件夹先成功就用哪个），
 * 写入 `eml/<sha1>.eml` 并回填索引。已有原文时直接返回（幂等，UI 重复点击无副作用）。
 */
export async function fetchTruncatedSource(
  ctx: WebmailContext,
  messageId: string
): Promise<SourceResult> {
  const row = ctx.db
    .prepare("SELECT truncated, eml_path, size FROM messages WHERE message_id = ?")
    .get(messageId) as { truncated: number; eml_path: string; size: number } | undefined;
  if (!row) throw new Error(`消息不存在：${messageId}`);
  if (!row.truncated && row.eml_path) return { fetched: false, size: row.size };

  const copies = ctx.db
    .prepare("SELECT account_id, folder, uid FROM copies WHERE message_id = ?")
    .all(messageId) as { account_id: string; folder: string; uid: number }[];
  if (copies.length === 0) throw new Error("这封邮件没有可用的服务器副本（可能已被删除）");
  if (row.size > MAX_ONDEMAND_BYTES) {
    throw new Error(
      `邮件 ${(row.size / 1024 / 1024).toFixed(1)}MB，超过按需取原文的上限 ` +
        `${(MAX_ONDEMAND_BYTES / 1024 / 1024).toFixed(0)}MB`
    );
  }

  let lastError: string | null = null;
  for (const copy of copies) {
    const account = ctx.accounts.get(copy.account_id);
    const cred = ctx.credentials.get(copy.account_id);
    if (!account || !cred) {
      lastError = `账号未配置：${copy.account_id}`;
      continue;
    }
    try {
      const raw = await withAccountLock(account.id, async () => {
        const client = await connectAccount(account, cred);
        try {
          await openReadOnly(client, copy.folder); // 只读打开：不写 \Seen（红线 1）
          return await fetchSource(client, copy.uid);
        } finally {
          await client.logout().catch(() => {});
        }
      });
      if (!raw || raw.length === 0) {
        lastError = `${copy.account_id}/${copy.folder}#${copy.uid} 取到空原文`;
        continue;
      }
      await storeSource(ctx, messageId, raw);
      return { fetched: true, size: raw.length };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`取原文失败：${lastError ?? "所有副本都取不到"}`);
}

/** 落盘 + 回填索引（正文摘要 / 引用链 / 附件标记 / FTS），与抓取器同一套字段口径 */
async function storeSource(ctx: WebmailContext, messageId: string, raw: Buffer): Promise<void> {
  const parsed = await simpleParser(raw);
  const emlRel = join("eml", `${createHash("sha1").update(messageId).digest("hex")}.eml`);
  const abs = join(ctx.dataDir, emlRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs + ".tmp", raw);
  renameSync(abs + ".tmp", abs);

  const bodyText = parsed.text ?? "";
  const hasAttach = parsed.attachments.some((a) => a.contentDisposition === "attachment") ? 1 : 0;
  ctx.db.transaction(() => {
    ctx.db
      .prepare(
        `UPDATE messages SET truncated = 0, eml_path = ?, size = ?, snippet = ?,
           refs_json = ?, has_attach = ? WHERE message_id = ?`
      )
      .run(
        emlRel,
        raw.length,
        snippetOf(bodyText),
        JSON.stringify(extractRefKeys(parsed)),
        hasAttach,
        messageId
      );
    // FTS 是外部内容表（不受外键级联保护），正文变了要显式换行
    ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(messageId);
    ctx.db
      .prepare(
        "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)"
      )
      .run(
        messageId,
        parsed.subject ?? "",
        `${parsed.from?.text ?? ""}`.trim(),
        "",
        bodyText
      );
  })();
}

/** 读取已落盘的原文（GET /message/:id/source 用）；没有原文时返回 null */
export function readSource(ctx: WebmailContext, messageId: string): Buffer | null {
  const row = ctx.db
    .prepare("SELECT eml_path FROM messages WHERE message_id = ?")
    .get(messageId) as { eml_path: string } | undefined;
  if (!row || !row.eml_path) return null;
  try {
    return readFileSync(join(ctx.dataDir, row.eml_path));
  } catch {
    return null;
  }
}
