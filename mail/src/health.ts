import type { AccountConfig } from "./types.js";

/**
 * 健康监控（MAIL-AGENT.md 5.5）：每账号「上次成功抓取时间 / 连续失败计数 /
 * 当前连接状态」。后台批处理最怕安静失效（专用密码过期、服务商改 IMAP 策略，
 * 表现都是抓取失败但没有报错），这里把运行状态显式化，由 /agent/health 暴露给
 * /mail 页面的常驻状态条（告警通道不依赖邮件——凭据失效时邮件通道自己也坏了）。
 *
 * maild 是独立长驻进程，模块级单例即可（主站 Next.js 那套「模块逐请求重求值」
 * 的陷阱不适用于本进程）。
 */

export interface AccountHealth {
  /** 上次成功抓取时间（ISO）；启动后从未成功为 null */
  lastOk: string | null;
  /** 连续失败次数（连接中断与同步失败都计入，连接成功清零） */
  failures: number;
  /** 最近一次失败原因 */
  lastError: string | null;
  /** IDLE 连接当前是否在线 */
  connected: boolean;
}

const states = new Map<string, AccountHealth>();

function stateOf(accountId: string): AccountHealth {
  let s = states.get(accountId);
  if (!s) {
    s = { lastOk: null, failures: 0, lastError: null, connected: false };
    states.set(accountId, s);
  }
  return s;
}

/** 成功抓取一轮（启动首轮 / IDLE 增量 / 兜底轮询都算） */
export function markSyncOk(accountId: string): void {
  const s = stateOf(accountId);
  s.lastOk = new Date().toISOString();
  s.lastError = null;
}

/** IDLE 连接建立：置在线，连续失败计数清零（5.1 的重连成功同理） */
export function markConnected(accountId: string): void {
  const s = stateOf(accountId);
  s.connected = true;
  s.failures = 0;
}

/** 连接中断 / 同步失败：计入连续失败（5.5：IDLE 断开即计入失败计数） */
export function markFailure(accountId: string, err: unknown): void {
  const s = stateOf(accountId);
  s.connected = false;
  s.failures += 1;
  s.lastError = err instanceof Error ? err.message : String(err);
}

/** 告警阈值：连续 N 次抓取失败产生告警（默认 3，可用 MAILD_ALERT_FAILURES 覆盖） */
export function alertThreshold(): number {
  const n = Number(process.env.MAILD_ALERT_FAILURES ?? 3);
  return Number.isInteger(n) && n >= 1 ? n : 3;
}

export interface AccountHealthReport extends AccountHealth {
  id: string;
  displayName: string;
  email: string;
  /** 是否达到告警态（连续失败 ≥ 阈值） */
  alert: boolean;
}

/** 给 /agent/health 的报告：全部账号未达告警态时 ok=true */
export function healthReport(accounts: AccountConfig[]): {
  ok: boolean;
  threshold: number;
  accounts: AccountHealthReport[];
} {
  const threshold = alertThreshold();
  const items = accounts.map((a) => {
    const s = stateOf(a.id);
    return {
      id: a.id,
      displayName: a.displayName,
      email: a.email,
      ...s,
      alert: s.failures >= threshold,
    };
  });
  return { ok: items.every((i) => !i.alert), threshold, accounts: items };
}
