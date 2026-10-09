import type { ImapFlow } from "imapflow";
import type { Db } from "./db.js";
import { markConnected, markFailure, markSyncOk } from "./health.js";
import { connectAccount } from "./imap.js";
import { syncAccount, hasPendingBackfill } from "./fetcher.js";
import type { AccountConfig, AccountCredential, SyncResult } from "./types.js";

/** 兜底轮询间隔：IDLE 不可用或漏事件时仍有新鲜度保证（5.1） */
const POLL_INTERVAL_MS = 3 * 60 * 1000;
/**
 * 历史回填节拍（2026-10-08）：有待回填的文件夹时，把兜底轮询换成这个节拍，
 * 一次只吃一块（fetcher.ts 的 `mode: "backfill"`）——首轮铺满整个邮箱的时间因此
 * 从「3 分钟一块」变成十几分钟，而每块的连接持有只有几秒。
 * ⚠ 密集回填期间**不重跑标记回读**（`mode: "backfill"` 不含它）：每 1.5 秒拉一次
 *   90 天的 FLAGS 会把服务商打爆（3.5 的窗口约束）。完整轮（增量 + 标记回读）
 *   仍按 POLL_INTERVAL_MS 的节奏至少跑一次。
 */
const BACKFILL_TICK_MS = Number(process.env.MAIL_AGENT_BACKFILL_TICK_MS ?? 1500);

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
      markConnected(account.id);
      await idleLoop(db, dataDir, client, account, cred, signal, onSynced);
    } catch (err) {
      if (signal?.aborted) return;
      failures++;
      markFailure(account.id, err);
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
  /** 有同步在跑时又来了请求：`pendingFull` 记住「要不要顺带跑完整轮」 */
  let pending = false;
  let pendingFull = false;
  let lastFullAt = 0;
  let timer: NodeJS.Timeout | undefined;

  /** 下一次该等多久：还有历史回填要推进就快跑，否则回到 3 分钟兜底 */
  const schedule = (): void => {
    const wait = hasPendingBackfill(db, account.id) ? BACKFILL_TICK_MS : POLL_INTERVAL_MS;
    timer = setTimeout(() => void resync(), wait);
    timer.unref?.();
  };

  const resync = async (force?: "full"): Promise<void> => {
    if (syncing) {
      pending = true;
      if (force === "full") pendingFull = true;
      return;
    }
    syncing = true;
    // 回填未完成、且距上次完整轮还不到一个兜底周期 → 这一拍只推进一块回填
    // （完整轮的标记回读很贵，不能按回填节拍重跑；见文件头 BACKFILL_TICK_MS）
    const mode: "full" | "backfill" =
      force === "full" || !hasPendingBackfill(db, account.id) || Date.now() - lastFullAt >= POLL_INTERVAL_MS
        ? "full"
        : "backfill";
    try {
      const results = await syncAccount(db, dataDir, account, cred, client, { mode });
      markSyncOk(account.id);
      if (mode === "full") lastFullAt = Date.now();
      const backfilled = results.reduce((sum, r) => sum + r.backfilled, 0);
      for (const r of results) {
        if (r.fetched > 0) {
          console.log(
            `[${r.accountId}] ${r.folder}: +${r.fetched} 封` +
              (backfilled > 0 ? `（其中历史回填 ${r.backfilled} 封，剩余 ${r.backfillRemaining}）` : "")
          );
        }
      }
      // ⚠ 触发接线只吃增量（fetcher.ts 的 ingested 语义）：
      //   回填的几千封旧邮件不该被投成 judge/command 任务
      onSynced?.(results);
    } catch (err) {
      // 同步失败：断开连接，由 idle() 的异常冒到外层重连（重连后会先补抓）
      console.error(`[${account.id}] 同步失败，断开以触发重连`, err);
      client.close();
    } finally {
      syncing = false;
      if (pending) {
        const full = pendingFull;
        pending = false;
        pendingFull = false;
        void resync(full ? "full" : undefined);
      } else {
        if (timer) clearTimeout(timer);
        schedule();
      }
    }
  };

  // 重连后先补一次增量（红线 14）
  await resync("full");
  await client.mailboxOpen("INBOX", { readOnly: true });
  // 新邮件到达必须走完整轮（IDLE 的 exists 事件是最新鲜的信号，不能因为回填被降级）
  client.on("exists", () => void resync("full"));
  schedule();
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
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    client.removeAllListeners("exists");
  }
}
