import type { ImapFlow } from "imapflow";
import { resolveMessageKey, type Db } from "./db.js";
import type { AgentDb } from "./ledger.js";
import { appendLedger } from "./ledger.js";
import { connectAccount } from "./imap.js";
import type { AccountConfig, CredentialsFile } from "./types.js";

/**
 * 全包唯一可以发 STORE 的地方（3.5）。约束逐条落实：
 * - 只碰 \Seen / \Flagged（FLAG_SEEN / FLAG_FLAGGED 之外的标记没有入口）；
 * - imapflow 的 messageFlagsAdd/Remove 即 +FLAGS/-FLAGS 语义，绝不整体替换；
 * - 一律 { uid: true }；
 * - 只接受本地索引（copies 表）里已存在的消息与 UID；
 * - 对该 Message-ID 的所有副本一起写（红线 8）；
 * - 逐副本写台账：账号、文件夹、UID、前值、后值、来源。
 * 连接策略：短时第二条连接 + 账号级互斥，不打断抓取器的 IDLE（5.3）。
 */

const FLAG_SEEN = "\\Seen";
const FLAG_FLAGGED = "\\Flagged";

export interface FlagChange {
  seen?: boolean;
  flagged?: boolean;
}

/** 账号级互斥：同一账号的写操作串行（工具面内部并发也安全） */
const accountLocks = new Map<string, Promise<unknown>>();

export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  accountLocks.set(
    accountId,
    next.catch(() => {})
  );
  return next;
}

interface CopyRow {
  account_id: string;
  folder: string;
  uid: number;
  flags: string;
}

export interface SetFlagsResult {
  updated: number;
  skipped: { account: string; folder: string; uid: number; reason: string }[];
}

export async function setMessageFlags(opts: {
  db: Db;
  agentDb: AgentDb;
  accounts: AccountConfig[];
  creds: CredentialsFile;
  messageId: string;
  change: FlagChange;
  /** 来源标注（agent / user:webmail 等），进台账 */
  source: string;
}): Promise<SetFlagsResult> {
  const { db, agentDb, accounts, creds, change, source } = opts;
  if (change.seen === undefined && change.flagged === undefined) {
    throw new Error("set_flags 至少要给 seen 或 flagged 之一");
  }

  // 宽容归一（库键 / 裸 Message-ID 均可）；3.5：只接受本地索引里已存在的消息
  const messageId = resolveMessageKey(db, opts.messageId);
  if (!messageId) {
    throw new Error(`本地索引不存在该消息：${opts.messageId}`);
  }

  const copies = db
    .prepare("SELECT account_id, folder, uid, flags FROM copies WHERE message_id = ?")
    .all(messageId) as CopyRow[];

  const byAccount = new Map<string, CopyRow[]>();
  for (const c of copies) {
    const list = byAccount.get(c.account_id) ?? [];
    list.push(c);
    byAccount.set(c.account_id, list);
  }

  const result: SetFlagsResult = { updated: 0, skipped: [] };
  for (const [accountId, rows] of byAccount) {
    const account = accounts.find((a) => a.id === accountId);
    const cred = creds[accountId];
    if (!account || !cred) {
      for (const r of rows) {
        result.skipped.push({ account: accountId, folder: r.folder, uid: r.uid, reason: "账号或凭据缺失" });
      }
      continue;
    }
    await withAccountLock(accountId, async () => {
      let client: ImapFlow | undefined;
      try {
        client = await connectAccount(account, cred);
        for (const row of rows) {
          try {
            await writeOneCopy(client, db, agentDb, account, row, messageId, change, source, result);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            result.skipped.push({ account: accountId, folder: row.folder, uid: row.uid, reason });
            appendLedger(agentDb, {
              tool: "set_flags.copy",
              ok: false,
              messageId,
              detail: { account: accountId, folder: row.folder, uid: row.uid, change, source },
              error: reason,
            });
          }
        }
      } finally {
        if (client) await client.logout().catch(() => {});
      }
    });
  }
  return result;
}

async function writeOneCopy(
  client: ImapFlow,
  db: Db,
  agentDb: AgentDb,
  account: AccountConfig,
  row: CopyRow,
  messageId: string,
  change: FlagChange,
  source: string,
  result: SetFlagsResult
): Promise<void> {
  // STORE 需要写模式打开（SELECT）——全包唯一非 readOnly 的 mailboxOpen
  await client.mailboxOpen(row.folder);

  // 前值从服务端现取（不用本地缓存），并核对 UID 仍指向同一封信
  // （库键是 `mid:裸id`，服务端的 envelope.messageId 带尖括号——两边都归一成裸小写再比）
  const before1 = await client.fetchOne(String(row.uid), { uid: true, flags: true, envelope: true }, { uid: true });
  if (!before1) throw new Error("UID 在服务端已不存在");
  const bare = (s: string) => s.replace(/[<>]/g, "").trim().toLowerCase();
  const serverMid = (before1.envelope as { messageId?: string } | undefined)?.messageId;
  if (serverMid && messageId.startsWith("mid:") && bare(serverMid) !== bare(messageId.slice(4))) {
    throw new Error(`UID 已错位（服务端 ${serverMid}），待下次同步重建`);
  }
  const before = before1.flags ? [...before1.flags].sort() : [];

  if (change.seen === true) await client.messageFlagsAdd(String(row.uid), [FLAG_SEEN], { uid: true });
  if (change.seen === false) await client.messageFlagsRemove(String(row.uid), [FLAG_SEEN], { uid: true });
  if (change.flagged === true) await client.messageFlagsAdd(String(row.uid), [FLAG_FLAGGED], { uid: true });
  if (change.flagged === false) await client.messageFlagsRemove(String(row.uid), [FLAG_FLAGGED], { uid: true });

  // 后值同样从服务端现取，以服务端为准
  const after1 = await client.fetchOne(String(row.uid), { uid: true, flags: true }, { uid: true });
  const after = after1 && after1.flags ? [...after1.flags].sort() : [];

  db.prepare("UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?").run(
    after.join(" "),
    row.account_id,
    row.folder,
    row.uid
  );
  result.updated++;

  appendLedger(agentDb, {
    tool: "set_flags.copy",
    ok: true,
    messageId,
    detail: {
      account: row.account_id,
      folder: row.folder,
      uid: row.uid,
      change,
      before,
      after,
      source,
    },
  });
}
