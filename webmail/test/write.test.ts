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
});
