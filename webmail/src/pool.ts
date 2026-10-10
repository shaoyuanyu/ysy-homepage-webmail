import type { ImapFlow } from "imapflow";

/**
 * IMAP 写连接的池（2026-10-10 用户要求「连接池」）。
 *
 * **起因**：每次整理动作（标为垃圾 / 移出垃圾 / 删除 / 标已读）都 `connectAccount` 新建
 * 一条连接、用完 `logout()`。真机实测 `POST /move` 约 **1 秒**，其中建连（TLS 握手 +
 * 登录）占大头——用户点一下等一秒，体感就是"卡"。
 *
 * **做法**：每账号保留**一条**长连接（带 NOOP 保活），写操作复用它；连接的生死由池管，
 * 调用方**不再 `logout()`**，改成 `acquireConnection` / `releaseConnection`。
 *
 * ⚠ **每账号只一条**：阿里云 / 腾讯对同账号的并发连接都有限制（红线 10）。配合
 *   `withAccountLock`（账号级互斥），同一时刻只有一个调用方在用那条连接——IMAP 是单
 *   socket 串行协议，并发用一条连接会串味。
 * ⚠ **必须保活**：不保活的话连接会被服务端悄悄断掉，而复用时 `usable` 可能仍是 true
 *   （那只是本地状态）→ 第一次操作神秘失败。到点 `NOOP` 一下就把空闲计时重置了。
 * ⚠ **不在失败后自动重试**：写操作重试可能重复执行（`APPEND` 不是幂等的）。连接真断了
 *   就摘掉、让用户再点一次。
 * ⚠ 定时器一律 `unref()`：保活是后台家务，不该吊住进程退出。
 */

/** 空闲保活间隔：到点发一次 NOOP，防服务端把空闲连接悄悄断掉 */
const KEEPALIVE_MS = 60_000;

/**
 * 闲置回收：超过这个时长没被业务用过就主动关掉（不再保活）。
 * ⚠ 必须**短于**服务端的空闲超时（两家都在 30 分钟量级），否则池里会积压
 *   「服务端已经不要了、本地 `usable` 还是 true」的连接。
 */
const IDLE_DROP_MS = 15 * 60_000;

interface Entry {
  client: ImapFlow;
  /** 最后一次**被业务使用**的时间（保活的 NOOP 不算） */
  lastUsed: number;
  timer: NodeJS.Timeout | null;
}

const pool = new Map<string, Entry>();

function clearTimer(entry: Entry): void {
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
}

/** 从池里摘掉一条连接并关掉它 */
function drop(accountId: string): void {
  const entry = pool.get(accountId);
  if (!entry) return;
  clearTimer(entry);
  pool.delete(accountId);
  void entry.client.logout().catch(() => {});
}

function scheduleKeepalive(accountId: string): void {
  const entry = pool.get(accountId);
  if (!entry) return;
  clearTimer(entry);
  const timer = setTimeout(() => {
    void keepalive(accountId);
  }, KEEPALIVE_MS);
  // 保活是后台家务，不该吊住进程退出
  timer.unref?.();
  entry.timer = timer;
}

async function keepalive(accountId: string): Promise<void> {
  const entry = pool.get(accountId);
  if (!entry) return;
  if (Date.now() - entry.lastUsed > IDLE_DROP_MS) {
    drop(accountId);
    return;
  }
  if (!entry.client.usable) {
    drop(accountId);
    return;
  }
  try {
    await entry.client.noop();
    scheduleKeepalive(accountId);
  } catch {
    drop(accountId);
  }
}

/**
 * 取一条该账号的池化连接——池里有可用的就复用（省掉一次 TLS + 登录），否则新建并入池。
 *
 * ⚠ 调用方**必须在 `withAccountLock` 内**调用（同一账号不许两条连接同时在用），
 *   并且**用 `try/finally` 配 `releaseConnection`**。
 */
export async function acquireConnection(
  accountId: string,
  connect: () => Promise<ImapFlow>
): Promise<ImapFlow> {
  let entry = pool.get(accountId);
  if (entry) {
    // 取用期间不保活：这时候连接正被用着，NOOP 会插队
    clearTimer(entry);
    if (!entry.client.usable) {
      drop(accountId);
      entry = undefined;
    }
  }
  if (!entry) {
    const client = await connect();
    // 连接自己断了（服务端踢 / 网络抖动）→ 从池里摘掉，下一次调用自然新建
    client.on("close", () => {
      const cur = pool.get(accountId);
      if (cur?.client === client) drop(accountId);
    });
    entry = { client, lastUsed: Date.now(), timer: null };
    pool.set(accountId, entry);
  }
  entry.lastUsed = Date.now();
  return entry.client;
}

/**
 * 归还连接。**不 logout**（与池化前最大的区别）：
 * - 连接仍可用 → 留在池里 + 挂上保活定时器等下次复用；
 * - 已经不可用（命令报错且连接被服务端关掉）→ 摘掉，下次新建；
 * - 手里这条已经不归池管（被 `close` 摘过 / 换了新的）→ 直接关掉。
 *
 * ⚠ 业务错误（比如"目标文件夹不存在"）时连接是好的，照常留在池里——无脑 drop 的话
 *   下一次操作又变成一次全新建连，池就白做了。
 *
 * ⚠ 参数只收 `client`（调用方手里就这一个东西）：靠它反查账号，池里最多几个账号，
 *   这点遍历可以忽略。这样各处调用点是**同一个形状**，不易写错。
 */
export function releaseConnection(client: ImapFlow): void {
  let accountId: string | undefined;
  let entry: Entry | undefined;
  for (const [id, e] of pool) {
    if (e.client === client) {
      accountId = id;
      entry = e;
      break;
    }
  }
  if (!entry || !accountId) {
    void client.logout().catch(() => {});
    return;
  }
  if (entry.client.usable) scheduleKeepalive(accountId);
  else drop(accountId);
}

/** 诊断用：当前池里连着哪些账号 */
export function pooledAccounts(): string[] {
  return [...pool.keys()];
}

/**
 * 让某个账号的池化连接**立刻失效**（关掉并从池里摘除）。
 *
 * ⚠ 账号配置变更（host / port / 用户名）或删除账号后**必须调**：池是按 accountId 存的，
 *   不失效的话下一次操作会**拿着旧参数连过去**——症状是「改了配置还是连老服务器」或
 *   「删了账号还在发请求」，而且看上去一切正常（2026-10-10 加池时预判到的失效点）。
 */
export function dropConnection(accountId: string): void {
  drop(accountId);
}
