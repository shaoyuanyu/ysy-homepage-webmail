import type { ImapFlow } from "imapflow";
import type { Db } from "./db.js";
import { connectAccount } from "./imap.js";
import { syncAccount } from "./fetcher.js";
import type { AccountConfig, AccountCredential, SyncResult } from "./types.js";

/** 兜底轮询间隔：IDLE 不可用或漏事件时仍有新鲜度保证（5.1） */
const POLL_INTERVAL_MS = 3 * 60 * 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 事件驱动监听：连上后先补抓（重连期间到达的邮件），随后 IDLE 等待
 * exists 事件触发增量；断线指数退避重连。signal 触发优雅停机。
 * onSynced：每次增量完成后回调（触发接线投任务用，5.1）
 */
export async function watchAccount(
  db: Db,
  dataDir: string,
  account: AccountConfig,
  cred: AccountCredential,
  signal?: AbortSignal,
  onSynced?: (results: SyncResult[]) => void
): Promise<void> {
  let failures = 0;
  while (!signal?.aborted) {
    let client: ImapFlow | undefined;
    try {
      client = await connectAccount(account, cred);
      failures = 0;
      await idleLoop(db, dataDir, client, account, cred, signal, onSynced);
    } catch (err) {
      if (signal?.aborted) return;
      failures++;
      const wait = Math.min(2 ** failures * 1000, 300_000);
      console.error(`[${account.id}] 连接中断，${wait / 1000}s 后重连（第 ${failures} 次）`, err);
      await sleep(wait);
    } finally {
      if (client) await client.logout().catch(() => {});
    }
  }
}

async function idleLoop(
  db: Db,
  dataDir: string,
  client: ImapFlow,
  account: AccountConfig,
  cred: AccountCredential,
  signal?: AbortSignal,
  onSynced?: (results: SyncResult[]) => void
): Promise<void> {
  let syncing = false;
  let pending = false;
  const resync = async (): Promise<void> => {
    if (syncing) {
      pending = true;
      return;
    }
    syncing = true;
    try {
      const results = await syncAccount(db, dataDir, account, cred, client);
      for (const r of results) {
        if (r.fetched > 0) {
          console.log(`[${r.accountId}] ${r.folder}: +${r.fetched} 封`);
        }
      }
      onSynced?.(results);
    } catch (err) {
      // 同步失败：断开连接，由 idle() 的异常冒到外层重连（重连后会先补抓）
      console.error(`[${account.id}] 同步失败，断开以触发重连`, err);
      client.close();
    } finally {
      syncing = false;
      if (pending) {
        pending = false;
        void resync();
      }
    }
  };

  // 重连后先补一次增量（红线 14）
  await resync();
  await client.mailboxOpen("INBOX", { readOnly: true });
  client.on("exists", () => void resync());
  const timer = setInterval(() => void resync(), POLL_INTERVAL_MS);
  const onAbort = () => client.close();
  signal?.addEventListener("abort", onAbort);
  try {
    // imapflow 不会自动 IDLE：idle() 返回后（新事件或超时）须再次调用
    for (;;) {
      await client.idle();
      if (signal?.aborted) return;
    }
  } catch (err) {
    if (signal?.aborted) return;
    throw err;
  } finally {
    clearInterval(timer);
    signal?.removeEventListener("abort", onAbort);
    client.removeAllListeners("exists");
  }
}
