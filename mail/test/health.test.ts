import { describe, expect, it } from "vitest";
import {
  alertThreshold,
  healthReport,
  markConnected,
  markFailure,
  markSyncOk,
} from "../src/health.js";
import type { AccountConfig } from "../src/types.js";

/**
 * 健康监控（5.5）纯单元测试：连续失败计数 / 阈值告警 / 成功清零 / 报告形状。
 * 状态是模块级单例，各用例用不同账号 id 隔离。
 */

function acct(id: string): AccountConfig {
  return {
    id,
    displayName: `账号-${id}`,
    email: `${id}@local`,
    provider: "test",
    color: "#000000",
    imapHost: "127.0.0.1",
    imapPort: 143,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 25,
    smtpSecure: false,
    folders: ["INBOX"],
    enabled: true,
  } as AccountConfig;
}

describe("健康监控（5.5）", () => {
  it("初始状态：从未成功、零失败、未连接、不告警", () => {
    const r = healthReport([acct("h-init")]);
    expect(r.ok).toBe(true);
    expect(r.threshold).toBe(3);
    expect(r.accounts[0]).toMatchObject({
      id: "h-init",
      lastOk: null,
      failures: 0,
      lastError: null,
      connected: false,
      alert: false,
    });
  });

  it("成功抓取记录 lastOk 并清除 lastError", () => {
    markFailure("h-ok", new Error("boom"));
    markSyncOk("h-ok");
    const r = healthReport([acct("h-ok")]);
    expect(r.accounts[0].lastOk).not.toBeNull();
    expect(r.accounts[0].lastError).toBeNull();
    // ⚠ markSyncOk 不清失败计数——连续失败只由「重新连接成功」清零（5.1 重连语义）
    expect(r.accounts[0].failures).toBe(1);
  });

  it("连续失败达到阈值（默认 3）进入告警态，报告 ok=false", () => {
    for (let i = 0; i < 3; i++) markFailure("h-alert", new Error(`err${i}`));
    const r = healthReport([acct("h-alert")]);
    const a = r.accounts[0];
    expect(a.failures).toBe(3);
    expect(a.alert).toBe(true);
    expect(a.connected).toBe(false);
    expect(a.lastError).toBe("err2");
    expect(r.ok).toBe(false);
  });

  it("连接成功清零失败计数并置在线（重连恢复即解除告警）", () => {
    for (let i = 0; i < 5; i++) markFailure("h-recover", "down");
    expect(healthReport([acct("h-recover")]).accounts[0].alert).toBe(true);
    markConnected("h-recover");
    const a = healthReport([acct("h-recover")]).accounts[0];
    expect(a.failures).toBe(0);
    expect(a.connected).toBe(true);
    expect(a.alert).toBe(false);
  });

  it("阈值以下的失败不告警；非 Error 原因转字符串", () => {
    markFailure("h-below", "string reason");
    markFailure("h-below", "string reason");
    const a = healthReport([acct("h-below")]).accounts[0];
    expect(a.failures).toBe(2);
    expect(a.alert).toBe(false);
    expect(a.lastError).toBe("string reason");
  });

  it("任一账号告警则整体 ok=false；未告警账号不受影响", () => {
    markConnected("h-multi-ok");
    markSyncOk("h-multi-ok");
    for (let i = 0; i < 3; i++) markFailure("h-multi-bad", "x");
    const r = healthReport([acct("h-multi-ok"), acct("h-multi-bad")]);
    expect(r.ok).toBe(false);
    expect(r.accounts[0].alert).toBe(false);
    expect(r.accounts[1].alert).toBe(true);
  });

  it("alertThreshold：MAILD_ALERT_FAILURES 可覆盖，非法值回退 3", () => {
    const orig = process.env.MAILD_ALERT_FAILURES;
    try {
      delete process.env.MAILD_ALERT_FAILURES;
      expect(alertThreshold()).toBe(3);
      process.env.MAILD_ALERT_FAILURES = "5";
      expect(alertThreshold()).toBe(5);
      process.env.MAILD_ALERT_FAILURES = "abc";
      expect(alertThreshold()).toBe(3);
      process.env.MAILD_ALERT_FAILURES = "0";
      expect(alertThreshold()).toBe(3);
    } finally {
      if (orig === undefined) delete process.env.MAILD_ALERT_FAILURES;
      else process.env.MAILD_ALERT_FAILURES = orig;
    }
  });
});
