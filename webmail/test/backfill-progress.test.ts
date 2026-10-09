import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  deliverFixtures,
  startDovecot,
  waitReady,
  type DovecotHandle,
} from "./dovecot.js";
import { makeContext, type TestContext } from "./context.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

/**
 * `/health` 的历史回填进度（2026-10-08）。
 *
 * 前端「正在抓取历史邮件 x/y」与列表自动刷新全靠这个字段；它同时还要守住两条
 * 容易写错的语义：
 * 1. 回填**不算新邮件**——`lastNewMail` 不能被几千封旧信推进（否则前端会连弹
 *    「收到 N 封新邮件」）；
 * 2. 回填完成后 `backfill` 必须回到 `null`（前端据此停止进度显示与自动刷新）。
 *
 * ⚠ 必须在 import api/fetcher 之前把块大小压到 1（常量在模块加载时读取）。
 */
process.env.MAIL_AGENT_BACKFILL_CHUNK = "1";
process.env.MAIL_AGENT_BACKFILL_BUDGET_MS = "60000";
const { createApiServer, runSync } = await import("../src/api.js");

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

interface HealthBody {
  ok: boolean;
  accounts: {
    id: string;
    lastSync: string | null;
    lastNewMail: string | null;
    backfill: {
      remaining: number;
      total: number;
      done: number;
      folder: string;
      folders: { path: string; remaining: number; total: number }[];
    } | null;
  }[];
}

async function health(): Promise<HealthBody> {
  return (await (await fetch(`${base}/health`)).json()) as HealthBody;
}

beforeAll(async () => {
  dovecot = startDovecot("backfill-health");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "backfill-health");
  await deliverFixtures(dovecot, "test", "test", ["01.eml", "02.eml", "03.eml"]);
  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  server.close();
  await sink.close();
  tc.cleanup();
  dovecot.cleanup();
});

describe("/health：历史回填进度", () => {
  it("回填未完成时报告剩余量与总量，且不算「收到新邮件」", async () => {
    await runSync(tc.ctx);
    const h = await health();
    const acc1 = h.accounts.find((a) => a.id === "acc1")!;
    expect(acc1.lastSync).toBeTruthy();
    // 块大小 = 1：3 封里只抓了最新的 1 封
    expect(acc1.backfill).not.toBeNull();
    expect(acc1.backfill!.total).toBe(3);
    expect(acc1.backfill!.remaining).toBe(2);
    expect(acc1.backfill!.done).toBe(1);
    expect(acc1.backfill!.folder).toBe("INBOX");
    expect(acc1.backfill!.folders).toEqual([{ path: "INBOX", remaining: 2, total: 3 }]);
    // 回填的旧邮件不是新邮件：再跑一轮回填，lastNewMail 必须原地不动
    // （首轮那个值来自「库里最新一封的日期」兜底初始化，不是本轮抓取时刻）
    const before = acc1.lastNewMail;
    await runSync(tc.ctx);
    const after = (await health()).accounts.find((a) => a.id === "acc1")!;
    expect(after.lastNewMail).toBe(before);
    expect(after.backfill!.remaining).toBe(1);
    // 另一个账号（同一容器、没有邮件）没有回填
    const acc2 = h.accounts.find((a) => a.id === "acc2")!;
    expect(acc2.backfill).toBeNull();
  });

  it("回填泵跑完后进度字段回到 null", async () => {
    // 回填轮（mode: "backfill"）一次一块，直到铺满
    for (let i = 0; i < 5; i++) await runSync(tc.ctx, undefined, { mode: "backfill" });
    const h = await health();
    const acc1 = h.accounts.find((a) => a.id === "acc1")!;
    expect(acc1.backfill).toBeNull();
  });

  it("回填完成后新邮件才算 lastNewMail 前进", async () => {
    await deliverFixtures(dovecot, "test", "test", ["04.eml"]);
    await runSync(tc.ctx);
    const h = await health();
    const acc1 = h.accounts.find((a) => a.id === "acc1")!;
    expect(acc1.backfill).toBeNull();
    // 这一轮抓的是增量新邮件 → lastNewMail 被推到「本轮时刻」（而不是兜底用的邮件日期）
    expect(acc1.lastNewMail).toBeTruthy();
    expect(new Date(acc1.lastNewMail!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
