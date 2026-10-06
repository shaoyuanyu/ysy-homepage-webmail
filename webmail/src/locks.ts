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
  accountLocks.set(accountId, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (accountLocks.get(accountId) === gate) accountLocks.delete(accountId);
  }
}
