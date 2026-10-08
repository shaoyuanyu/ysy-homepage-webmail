import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import {
  deliverFixtures,
  readAllFlags,
  startDovecot,
  waitReady,
  type DovecotHandle,
} from "./dovecot.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

const MESSAGE_ID = "mid:w01@test.local";

async function api(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function listIds(): Promise<{ messageId: string; seen: boolean; flagged: boolean }[]> {
  const res = await fetch(`${base}/messages`);
  return ((await res.json()) as { items: { messageId: string; seen: boolean; flagged: boolean }[] })
    .items;
}

beforeAll(async () => {
  dovecot = startDovecot("write");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "write");
  // 同一封邮件（同 Message-ID）投递到两个账号的 INBOX
  await deliverFixtures(dovecot, "test", "test", ["01.eml"]);
  await deliverFixtures(dovecot, "test2", "test2", ["01.eml"]);
  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await api("/sync");
}, 180_000);

afterAll(async () => {
  server.close();
  await sink.close();
  tc.cleanup();
  dovecot.cleanup();
});

describe("webmaild 写操作", () => {
  it("初始状态：一条消息两个副本，均未读", async () => {
    const items = await listIds();
    expect(items.length).toBe(1);
    expect(items[0].messageId).toBe(MESSAGE_ID);
    expect(items[0].seen).toBe(false);
  });

  it("标已读对所有副本一起写（红线 8）：两个账号的服务端 flags 与本地索引同步更新", async () => {
    const res = await api("/flags", { messageId: MESSAGE_ID, seen: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { updated: number }).updated).toBe(2);

    for (const [user, pass] of [["test", "test"], ["test2", "test2"]] as const) {
      const flags = await readAllFlags(dovecot, user, pass, "INBOX");
      expect(flags.size).toBe(1);
      expect([...flags.values()][0]).toContain("\\Seen");
    }
    const items = await listIds();
    expect(items[0].seen).toBe(true);
  });

  it("星标往返：置上再取消", async () => {
    await api("/flags", { messageId: MESSAGE_ID, flagged: true });
    let items = await listIds();
    expect(items[0].flagged).toBe(true);
    let flags = await readAllFlags(dovecot, "test", "test", "INBOX");
    expect([...flags.values()][0]).toContain("\\Flagged");

    await api("/flags", { messageId: MESSAGE_ID, flagged: false });
    items = await listIds();
    expect(items[0].flagged).toBe(false);
    flags = await readAllFlags(dovecot, "test", "test", "INBOX");
    expect([...flags.values()][0]).not.toContain("\\Flagged");
    // \Seen 不被星标操作触碰（+FLAGS/-FLAGS 只动指定标记）
    expect([...flags.values()][0]).toContain("\\Seen");
  });

  it("移动单个副本到回收站：源文件夹清空，另一个副本不受影响", async () => {
    const acc1Inbox = await readAllFlags(dovecot, "test", "test", "INBOX");
    const uid = [...acc1Inbox.keys()][0];
    const res = await api("/move", {
      copies: [{ accountId: "acc1", folder: "INBOX", uid }],
      to: "Trash",
    });
    expect(res.status).toBe(200);

    expect((await readAllFlags(dovecot, "test", "test", "INBOX")).size).toBe(0);
    expect((await readAllFlags(dovecot, "test", "test", "Trash")).size).toBe(1);
    // acc2 的副本原样
    expect((await readAllFlags(dovecot, "test2", "test2", "INBOX")).size).toBe(1);

    // 本地索引：副本行消失，消息仍在（acc2 副本还在）
    const items = await listIds();
    expect(items.length).toBe(1);
    const detail = (await (
      await fetch(`${base}/message/${encodeURIComponent(MESSAGE_ID)}`)
    ).json()) as { copies: { accountId: string; folder: string }[] };
    expect(detail.copies.length).toBe(1);
    expect(detail.copies[0].accountId).toBe("acc2");
  });

  it("删除最后一个副本后消息从索引消失", async () => {
    const acc2Inbox = await readAllFlags(dovecot, "test2", "test2", "INBOX");
    const uid = [...acc2Inbox.keys()][0];
    const res = await api("/delete", {
      copies: [{ accountId: "acc2", folder: "INBOX", uid }],
    });
    expect(res.status).toBe(200);

    // 有回收站 → 移入 Trash
    expect((await readAllFlags(dovecot, "test2", "test2", "INBOX")).size).toBe(0);
    const trash = await readAllFlags(dovecot, "test2", "test2", "Trash");
    expect(trash.size).toBe(1);

    // 消息的所有副本都没了 → messages 与 fts 一并清理
    expect((await listIds()).length).toBe(0);
    const res404 = await fetch(`${base}/message/${encodeURIComponent(MESSAGE_ID)}`);
    expect(res404.status).toBe(404);

    // 再删 Trash 里那封：所在文件夹即回收站 → 原地 EXPUNGE
    const trashUid = [...trash.keys()][0];
    await api("/delete", { copies: [{ accountId: "acc2", folder: "Trash", uid: trashUid }] });
    expect((await readAllFlags(dovecot, "test2", "test2", "Trash")).size).toBe(0);
  });

  it("一键已读（/mark-all-read）：按账号范围清未读，跨账号副本一起写", async () => {
    // 布局：02 → acc1+acc2 各一份（跨账号副本）；03 → 仅 acc1；04 → 仅 acc2
    await deliverFixtures(dovecot, "test", "test", ["02.eml", "03.eml"]);
    await deliverFixtures(dovecot, "test2", "test2", ["02.eml", "04.eml"]);
    await api("/sync");
    // ⚠ 上一段用例移动走的 mid:w01 副本仍在 acc1 的 Trash 里（sync 会重新索引到它，
    //   状态是已读）——下面断言只数「未见」条数，不数总条数，避免被它干扰
    expect((await listIds()).filter((i) => !i.seen).length).toBe(3);

    // 范围 = acc1：02（acc1 有副本）+ 03 被标；02 在 acc2 的副本也必须一起写
    // （消息级已读 = 所有副本都 Seen，红线 8）；04 不在范围、保持未读
    const scoped = (await (
      await api("/mark-all-read", { accounts: ["acc1"] })
    ).json()) as { updated: number; messages: number; skipped: unknown[] };
    expect(scoped.messages).toBe(2);
    expect(scoped.updated).toBe(3); // 02×2 副本 + 03×1 副本
    expect(scoped.skipped).toEqual([]);

    const acc1Flags = await readAllFlags(dovecot, "test", "test", "INBOX");
    expect([...acc1Flags.values()].every((f) => f.includes("\\Seen"))).toBe(true);
    const acc2Flags = await readAllFlags(dovecot, "test2", "test2", "INBOX");
    expect([...acc2Flags.values()].filter((f) => !f.includes("\\Seen")).length).toBe(1); // 只剩 04
    // 本地索引同步：只剩 1 封未读（04）
    const stillUnseen = (await listIds()).filter((i) => !i.seen);
    expect(stillUnseen.length).toBe(1);

    // 不传 accounts = 全部账号：剩下的 04 也被标
    const all = (await (await api("/mark-all-read", {})).json()) as {
      updated: number;
      messages: number;
    };
    expect(all.messages).toBe(1);
    expect(all.updated).toBe(1);
    expect((await listIds()).filter((i) => !i.seen).length).toBe(0);
  });

  it("批量标记（多选，2026-10-07）：一批 Message-ID 的全部副本一起写，每文件夹一次 STORE", async () => {
    // 干净的起点：全部标为未读（前面的用例把状态推到了别处）
    const ids = (await listIds()).map((i) => i.messageId);
    await api("/flags", { messageIds: ids, seen: false });
    expect((await listIds()).every((i) => !i.seen)).toBe(true);

    // 这一封当前有几个副本要先查：**同一容器里前面的用例动过副本**（移动/删除），
    // 写死 2 会随用例顺序变红（2026-10-07 首跑实测）。口径是"所有副本一起写"（红线 8），
    // 所以期望值就是当下实际的副本数。
    const listed = (await (await fetch(`${base}/messages`)).json()) as {
      items: { messageId: string; copies: { accountId: string; folder: string; uid: number }[] }[];
    };
    const target = listed.items.find((i) => i.messageId === MESSAGE_ID);
    expect(target).toBeTruthy();
    const expectedCopies = target!.copies.length;
    expect(expectedCopies).toBeGreaterThanOrEqual(1);

    // 批量标已读：对该消息的**全部副本**一起写（红线 8）
    const res = (await (
      await api("/flags", { messageIds: [MESSAGE_ID], seen: true })
    ).json()) as { updated: number; messages: number; skipped: unknown[] };
    expect(res.messages).toBe(1);
    expect(res.updated).toBe(expectedCopies);
    expect(res.skipped).toEqual([]);

    // 服务端确实写了 \Seen ——**按这封邮件副本的 UID 精确核对**
    // （不能断言"整个 INBOX 都已读"：同容器里还有别的用例留下的未读邮件）
    const acc1 = await readAllFlags(dovecot, "test", "test", "INBOX");
    const acc2 = await readAllFlags(dovecot, "test2", "test2", "INBOX");
    const flagsOf = (accountId: string) => {
      const copy = target!.copies.find((c) => c.accountId === accountId);
      if (!copy) return undefined; // 该账号的副本已被前面的用例移走/删掉
      return (accountId === "acc1" ? acc1 : acc2).get(copy.uid);
    };
    for (const accountId of ["acc1", "acc2"]) {
      const flags = flagsOf(accountId);
      if (flags === undefined) continue;
      expect(flags ?? []).toContain("\\Seen");
    }
    // 本地索引同步：w01 已读、其余仍未读（只有它被批量标记）
    const after = await listIds();
    expect(after.find((i) => i.messageId === MESSAGE_ID)?.seen).toBe(true);
    expect(after.filter((i) => i.messageId !== MESSAGE_ID).every((i) => !i.seen)).toBe(true);

    // 批量星标 + 取消星标（星标往返不触碰 \Seen）
    await api("/flags", { messageIds: ids, flagged: true });
    expect((await listIds()).every((i) => i.flagged)).toBe(true);
    await api("/flags", { messageIds: ids, flagged: false });
    expect((await listIds()).every((i) => !i.flagged)).toBe(true);
    // \Seen 没被星标往返抹掉（红线 2：只增删目标标记）
    expect((await listIds()).find((i) => i.messageId === MESSAGE_ID)?.seen).toBe(true);

    // 参数校验：既没有 messageId 也没有 messageIds → 400；超过 500 封 → 400
    const noId = await api("/flags", { seen: true });
    expect(noId.status).toBe(400);
    const tooMany = await api("/flags", {
      messageIds: Array.from({ length: 501 }, (_, i) => `mid:x${i}@test.local`),
      seen: true,
    });
    expect(tooMany.status).toBe(400);
    // 不存在的 id：不报错，updated/messages 为 0（多选里混入已删邮件是常态）
    const gone = (await (
      await api("/flags", { messageIds: ["mid:nope@test.local"], seen: true })
    ).json()) as { updated: number; messages: number };
    expect(gone).toEqual({ updated: 0, messages: 0, skipped: [] });
  });

  /**
   * 特殊用途移动目标（2026-10-07）：`to` 可以给 `\Junk` 这类 RFC 6154 记号而不是路径——
   * 前端因此不必为了"垃圾邮件夹叫什么"先 LIST 一遍（详情页「标为垃圾邮件」用的就是它）。
   */
  it("移动到 \\Junk 记号：服务端自己认出垃圾邮件文件夹", async () => {
    const listed = (await (await fetch(`${base}/messages`)).json()) as {
      items: { messageId: string; copies: { accountId: string; folder: string; uid: number }[] }[];
    };
    // 挑一封**两个账号都有副本**的（否则搬走 acc1 的副本后消息本身会消失，详情拿不到）
    const target = listed.items.find(
      (i) =>
        i.copies.some((c) => c.accountId === "acc1" && c.folder === "INBOX") &&
        i.copies.some((c) => c.accountId === "acc2" && c.folder === "INBOX"),
    );
    expect(target).toBeTruthy();
    const copy = target!.copies.find((c) => c.accountId === "acc1" && c.folder === "INBOX")!;

    const body = (await (
      await api("/move", { copies: [copy], to: "\\Junk" })
    ).json()) as { affected: number; skipped: unknown[] };
    expect(body.affected).toBe(1);
    expect(body.skipped).toEqual([]);

    // 服务端确实搬进了 Junk（夹具里带 special_use = \Junk）
    expect((await readAllFlags(dovecot, "test", "test", "INBOX")).has(copy.uid)).toBe(false);
    expect((await readAllFlags(dovecot, "test", "test", "Junk")).size).toBe(1);

    // 本地索引：那一行副本清掉（目标文件夹由下一轮同步发现）
    const detail = (await (
      await fetch(`${base}/message/${encodeURIComponent(target!.messageId)}`)
    ).json()) as { copies: { accountId: string; folder: string }[] };
    expect(detail.copies.some((c) => c.accountId === "acc1")).toBe(false);
    expect(detail.copies.some((c) => c.accountId === "acc2")).toBe(true);
  });

  it("记号在该账号上不存在：跳过该账号并记 skipped，本地索引一行不动", async () => {
    const listed = (await (await fetch(`${base}/messages`)).json()) as {
      items: { messageId: string; copies: { accountId: string; folder: string; uid: number }[] }[];
    };
    const target = listed.items.find((i) =>
      i.copies.some((c) => c.accountId === "acc2" && c.folder === "INBOX"),
    );
    expect(target).toBeTruthy();
    const copy = target!.copies.find((c) => c.accountId === "acc2" && c.folder === "INBOX")!;

    // \Archive：夹具里没有这个 mailbox、也没有同名回退 → 探测不到
    const body = (await (
      await api("/move", { copies: [copy], to: "\\Archive" })
    ).json()) as { affected: number; skipped: { accountId: string; reason: string }[] };
    expect(body.affected).toBe(0);
    expect(body.skipped).toEqual([{ accountId: "acc2", reason: "该账号没有「归档」文件夹" }]);

    // 信还在原处
    expect((await readAllFlags(dovecot, "test2", "test2", "INBOX")).has(copy.uid)).toBe(true);
    // ⚠ 本地索引必须原样保留：被跳过的账号若被当成"已搬走"清掉行，站内会凭空少一封信
    const detail = (await (
      await fetch(`${base}/message/${encodeURIComponent(target!.messageId)}`)
    ).json()) as { copies: { accountId: string; folder: string }[] };
    expect(detail.copies.some((c) => c.accountId === "acc2" && c.folder === "INBOX")).toBe(true);
  });

  it("已经在目标文件夹里：不发多余的 MOVE（affected 0、不报错、两边都不动）", async () => {
    // 上上条用例把 acc1 的一封搬进了 Junk（Junk 不在同步白名单里，索引里看不到它）
    const junk = await readAllFlags(dovecot, "test", "test", "Junk");
    const junkUid = [...junk.keys()][0];
    expect(junkUid).toBeTruthy();

    const body = (await (
      await api("/move", {
        copies: [{ accountId: "acc1", folder: "Junk", uid: junkUid }],
        to: "\\Junk",
      })
    ).json()) as { affected: number; skipped: unknown[] };
    expect(body.affected).toBe(0);
    expect(body.skipped).toEqual([]);
    expect((await readAllFlags(dovecot, "test", "test", "Junk")).size).toBe(1);
  });
});
