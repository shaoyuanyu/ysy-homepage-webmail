import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer, runSync } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import { deliverFixtures, startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

/**
 * 「收到新邮件」提醒的口径（2026-10-11）：**只有收件箱里真的新到的信**才算。
 *
 * `lastNewMail` 由增量入库推着走（`mail/src/fetcher.ts` 的 `ingested`），而 MOVE 之后
 * 目标文件夹给这封信分配的是**新 UID**（RFC 6851）：用户自己的搬动（「标为垃圾」「移出
 * 垃圾」「撤销标为垃圾」）在同步器眼里与刚到的新信无从区分，于是每搬一次就弹一条
 * 「收到 N 封新邮件」。这里锁住修复后的三条语义：
 * 1. 收件箱里新到的信照旧推进；
 * 2. 用户自己搬的信一律不推进——搬进垃圾夹、搬回收件箱都一样；
 * 3. 垃圾夹自己收到的新信也不推进（「收到邮件」只认收件箱）。
 *
 * ⚠ 「不推进」必须与「这封确实是被增量抓进来的」一起断言（`ingested`）：少了后者，
 * 一封压根没抓到的信也能让「lastNewMail 没动」通过。
 */

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

/** 被用户搬来搬去的那封（收件箱里新到 → 标为垃圾 → 移出垃圾 → 撤销标为垃圾） */
const MID_MOVED = "mid:w03@test.local";
/** 垃圾夹自己收到的新信 */
const MID_JUNK_ARRIVAL = "mid:w06@test.local";

interface Copy {
  accountId: string;
  folder: string;
  uid: number;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status, `${path} 应成功`).toBe(200);
  return res.json();
}

/** 跑一轮 acc1 的同步，返回「文件夹 → 本轮**增量**入库的库键」（`ingested` 不含历史回填） */
async function syncAcc1(): Promise<Map<string, string[]>> {
  const round = await runSync(tc.ctx, "acc1");
  const results = (
    round.results as { folder: string; ingested: { messageId: string }[] }[][]
  ).flat();
  return new Map(results.map((r) => [r.folder, r.ingested.map((i) => i.messageId)]));
}

/** 本地索引里这封邮件现在有哪些副本（目标文件夹那一封被抓进来了才会出现） */
function foldersOf(messageId: string): string[] {
  const rows = tc.ctx.db
    .prepare("SELECT folder FROM copies WHERE message_id = ?")
    .all(messageId) as { folder: string }[];
  return rows.map((r) => r.folder);
}

async function lastNewMail(): Promise<string | null> {
  const body = (await (await fetch(`${base}/health`)).json()) as {
    accounts: { id: string; lastNewMail: string | null }[];
  };
  return body.accounts.find((a) => a.id === "acc1")!.lastNewMail;
}

/** 列表里这封邮件的副本（走真实列表接口，与前端拿到的是同一份数据） */
async function copiesOf(messageId: string): Promise<Copy[]> {
  const list = (await (await fetch(`${base}/messages`)).json()) as {
    items: { messageId: string; copies: Copy[] }[];
  };
  const item = list.items.find((i) => i.messageId === messageId);
  expect(item, `${messageId} 应在列表里`).toBeTruthy();
  return item!.copies;
}

/** 垃圾视图（前端「垃圾」tab 的查询）里这封邮件的垃圾夹副本 */
async function junkCopyOf(messageId: string): Promise<Copy> {
  const list = (await (
    await fetch(`${base}/messages?folder=${encodeURIComponent("acc1|Junk")}`)
  ).json()) as { items: { messageId: string; copies: Copy[] }[] };
  const item = list.items.find((i) => i.messageId === messageId);
  expect(item, `${messageId} 应在垃圾视图里`).toBeTruthy();
  const copy = item!.copies.find((c) => c.accountId === "acc1" && c.folder === "Junk");
  expect(copy, "应有一份 acc1 的垃圾夹副本").toBeTruthy();
  return copy!;
}

beforeAll(async () => {
  dovecot = startDovecot("new-mail");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "new-mail");
  // 垃圾文件夹要在同步白名单里：真实账号上「标为垃圾」的目标副本就是这么被索引到的
  // （不索引它时，那封邮件压根不会进本地索引，也就无从弹提醒）
  const acc1 = tc.ctx.accounts.get("acc1")!;
  acc1.folders = [...acc1.folders, "Junk"];
  await deliverFixtures(dovecot, "test", "test", ["01.eml"]);
  // 预热垃圾夹的增量水位线：文件夹第一次被同步时，里头已有的邮件走历史回填、不进 `ingested`。
  // 不预热的话「标为垃圾」那一条会走过回填（本来就不弹提醒），用例就成了空断言。
  await deliverFixtures(dovecot, "test", "test", ["05.eml"], "Junk");
  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await runSync(tc.ctx);
}, 180_000);

afterAll(async () => {
  server.close();
  await sink.close();
  tc.cleanup();
  dovecot.cleanup();
});

describe("「收到新邮件」的口径", () => {
  it("收件箱里新到的信：照旧算「收到新邮件」", async () => {
    await deliverFixtures(dovecot, "test", "test", ["03.eml"]);
    const before = await lastNewMail();
    const ingested = await syncAcc1();
    expect(ingested.get("INBOX")).toContain(MID_MOVED);
    const after = await lastNewMail();
    expect(after).not.toBe(before);
    expect(new Date(after!).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("「标为垃圾」：搬进垃圾夹的那封不算「收到新邮件」", async () => {
    const copy = (await copiesOf(MID_MOVED)).find(
      (c) => c.accountId === "acc1" && c.folder === "INBOX",
    )!;
    const moved = (await post("/move", { copies: [copy], to: "\\Junk" })) as {
      affected: number;
    };
    expect(moved.affected).toBe(1);

    const before = await lastNewMail();
    const ingested = await syncAcc1();
    expect(ingested.get("Junk"), "垃圾夹那一封确实走的是增量").toContain(MID_MOVED);
    expect(foldersOf(MID_MOVED)).toContain("Junk");
    expect(await lastNewMail()).toBe(before);
  });

  it("「移出垃圾」：搬回收件箱的那封不算「收到新邮件」", async () => {
    const copy = await junkCopyOf(MID_MOVED);
    const moved = (await post("/move", { copies: [copy], to: "INBOX" })) as {
      affected: number;
    };
    expect(moved.affected).toBe(1);

    const before = await lastNewMail();
    const ingested = await syncAcc1();
    expect(ingested.get("INBOX"), "收件箱那一封确实走的是增量").toContain(MID_MOVED);
    expect(foldersOf(MID_MOVED)).toContain("INBOX");
    expect(await lastNewMail()).toBe(before);
  });

  it("撤销「标为垃圾」：搬回收件箱的那封不算「收到新邮件」", async () => {
    // 先重新标为垃圾（撤销要在垃圾夹里按 Message-ID 找它）
    const copy = (await copiesOf(MID_MOVED)).find(
      (c) => c.accountId === "acc1" && c.folder === "INBOX",
    )!;
    await post("/move", { copies: [copy], to: "\\Junk" });
    await syncAcc1();

    const before = await lastNewMail();
    const undone = (await post("/unmove", {
      messageId: MID_MOVED,
      targets: [{ accountId: "acc1", folder: "INBOX" }],
    })) as { restored: number };
    expect(undone.restored).toBe(1);
    const ingested = await syncAcc1();
    expect(ingested.get("INBOX"), "搬回来的那一封确实走的是增量").toContain(MID_MOVED);
    expect(foldersOf(MID_MOVED)).toContain("INBOX");
    expect(await lastNewMail()).toBe(before);
  });

  it("垃圾夹自己收到的新信：不算「收到新邮件」", async () => {
    await deliverFixtures(dovecot, "test", "test", ["06.eml"], "Junk");
    const before = await lastNewMail();
    const ingested = await syncAcc1();
    expect(ingested.get("Junk")).toContain(MID_JUNK_ARRIVAL);
    expect(foldersOf(MID_JUNK_ARRIVAL)).toContain("Junk");
    expect(await lastNewMail()).toBe(before);
  });
});
