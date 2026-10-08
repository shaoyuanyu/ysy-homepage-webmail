/**
 * 账号级 IMAP 操作锁（红线 10）：同一账号的所有 IMAP 操作——同步、标记、发送、
 * 草稿镜像——串行执行，任何时刻不会并发开第二条连接。
 *
 * 2026-10-06 从 `api.ts` 抽出为独立模块：草稿镜像（draft-mirror.ts）也要上锁，
 * 若从 api.ts 导出会形成 api ↔ draft-mirror 的循环 import。
 */
const accountLocks = new Map<string, Promise<void>>();

export async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  // ⚠ 存的必须是**派生后的那条 promise**（`prev.then(() => gate)`）：finally 里要拿它
  // 与 Map 的当前值比对。曾存派生值却拿 `gate` 去比，条件恒不成立 → 表项永不清除、
  // promise 链随获取次数无限增长（占用可控但语义不对，2026-10-07 修）。
  const chained = prev.then(() => gate);
  accountLocks.set(accountId, chained);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (accountLocks.get(accountId) === chained) accountLocks.delete(accountId);
  }
}
