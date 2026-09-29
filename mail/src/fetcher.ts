import type { ImapFlow } from "imapflow";
import type { Db } from "./db.js";
import { connectAccount, fetchSource, listFlagsSince, listNewMeta, openReadOnly } from "./imap.js";
import { ingestMessage } from "./message.js";
import type { AccountConfig, AccountCredential, SyncResult } from "./types.js";

/** 标记回读窗口（3.5：收窄范围，全量重取会打爆服务商） */
const FLAGS_WINDOW_DAYS = 90;
/** 超过该大小的邮件只存元数据，原文不下载（红线 12：大附件一律按需） */
const MAX_SOURCE_BYTES = Number(process.env.MAIL_MAX_SOURCE_BYTES ?? 50 * 1024 * 1024);

export async function syncFolder(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  account: AccountConfig,
  folder: string
): Promise<SyncResult> {
  const uidValidity = await openReadOnly(client, folder);
  const state = db
    .prepare("SELECT uidvalidity, last_seen_uid FROM folders WHERE account_id = ? AND path = ?")
    .get(account.id, folder) as { uidvalidity: number | null; last_seen_uid: number } | undefined;

  let lastSeenUid = state?.last_seen_uid ?? 0;
  let rebuilt = false;

  if (state && state.uidvalidity !== null && state.uidvalidity !== uidValidity) {
    // UIDVALIDITY 变化：该文件夹索引重来，孤儿 message 一并清理
    const orphans = db
      .prepare("SELECT DISTINCT message_id FROM copies WHERE account_id = ? AND folder = ?")
      .all(account.id, folder) as { message_id: string }[];
    db.prepare("DELETE FROM copies WHERE account_id = ? AND folder = ?").run(account.id, folder);
    for (const { message_id } of orphans) {
      const left = db
        .prepare("SELECT COUNT(*) AS n FROM copies WHERE message_id = ?")
        .get(message_id) as { n: number };
      if (left.n === 0) {
        db.prepare("DELETE FROM messages WHERE message_id = ?").run(message_id);
        db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(message_id);
      }
    }
    lastSeenUid = 0;
    rebuilt = true;
  }

  // 增量：先取 envelope 级元数据，按大小决定是否下载原文
  let fetched = 0;
  const ingested: { messageId: string; created: boolean }[] = [];
  for (const meta of await listNewMeta(client, folder, lastSeenUid)) {
    const source = meta.size > MAX_SOURCE_BYTES ? undefined : (await fetchSource(client, meta.uid)) ?? undefined;
    const r = await ingestMessage(db, dataDir, { accountId: account.id, folder, meta, source });
    ingested.push({ messageId: r.messageId, created: r.created });
    fetched++;
    if (meta.uid > lastSeenUid) lastSeenUid = meta.uid;
  }

  // 标记回读（纯读取）：自己写的 \Seen / 手机上读过的，回到本地索引。
  // 计数只算实际变化的行（changes() 对值不变的 UPDATE 也记匹配数）
  let flagsUpdated = 0;
  const since = new Date(Date.now() - FLAGS_WINDOW_DAYS * 86_400_000);
  const updateFlags = db.prepare(
    "UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ? AND flags != ?"
  );
  for (const entry of await listFlagsSince(client, folder, since)) {
    const flags = entry.flags.join(" ");
    flagsUpdated += updateFlags.run(flags, account.id, folder, entry.uid, flags).changes;
  }

  db.prepare(
    `INSERT INTO folders (account_id, path, uidvalidity, last_seen_uid, last_flags_sync)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id, path) DO UPDATE SET
       uidvalidity = excluded.uidvalidity,
       last_seen_uid = excluded.last_seen_uid,
       last_flags_sync = excluded.last_flags_sync`
  ).run(account.id, folder, uidValidity, lastSeenUid, new Date().toISOString());

  return { accountId: account.id, folder, rebuilt, fetched, flagsUpdated, ingested };
}

export async function syncAccount(
  db: Db,
  dataDir: string,
  account: AccountConfig,
  cred: AccountCredential,
  existingClient?: ImapFlow
): Promise<SyncResult[]> {
  // 红线 10：同一账号串行一条连接；IDLE 监听复用已有连接，不开第二条
  const client = existingClient ?? (await connectAccount(account, cred));
  try {
    const results: SyncResult[] = [];
    for (const folder of account.folders) {
      results.push(await syncFolder(db, dataDir, client, account, folder));
    }
    return results;
  } finally {
    if (!existingClient) {
      await client.logout().catch(() => {});
    }
  }
}
