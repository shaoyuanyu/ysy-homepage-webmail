import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import {
  deliverFixtures,
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

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
  dovecot = startDovecot("api");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "api");
  // w01 投递到两个账号（同一 Message-ID 的多副本），w03/w04 只在 acc1，w02 只在 acc2
  await deliverFixtures(dovecot, "test", "test", ["01.eml", "03.eml", "04.eml"]);
  await deliverFixtures(dovecot, "test2", "test2", ["01.eml", "02.eml"]);
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

describe("webmaild HTTP API", () => {
  it("同步后合并视图按时间倒序，跨账号副本聚合在一条消息上", async () => {
    const res = await api("/sync", { method: "POST" });
    expect(res.status).toBe(200);

    const list = (await (await api("/messages")).json()) as {
      items: { messageId: string; accounts: string[]; copies: unknown[]; subject: string }[];
      next: string | null;
    };
    expect(list.items.length).toBe(4);
    const dates = list.items.map((i) => i.subject);
    expect(dates).toEqual([
      "Report with attachment",
      "HTML Newsletter",
      "Weekly Digest",
      "面试通知",
    ]);
    const shared = list.items.find((i) => i.messageId === "mid:w01@test.local");
    expect(shared).toBeDefined();
    expect(shared!.accounts.sort()).toEqual(["acc1", "acc2"]);
    expect(shared!.copies.length).toBe(2);
  });

  it("账号筛选只返回该账号可见的消息", async () => {
    const list = (await (await api("/messages?account=acc2")).json()) as {
      items: { messageId: string }[];
    };
    expect(list.items.map((i) => i.messageId).sort()).toEqual([
      "mid:w01@test.local",
      "mid:w02@test.local",
    ]);
  });

  it("搜索：中文 4 字符走 trigram，2 字符走 LIKE 兜底", async () => {
    const tri = (await (await api("/messages?q=周五下午")).json()) as {
      items: { messageId: string }[];
    };
    expect(tri.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);

    const like = (await (await api("/messages?q=面试")).json()) as {
      items: { messageId: string }[];
    };
    expect(like.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);
  });

  it("游标分页：第一页拿满 limit，第二页取剩余", async () => {
    const p1 = (await (await api("/messages?limit=2")).json()) as {
      items: { messageId: string }[];
      next: string | null;
    };
    expect(p1.items.length).toBe(2);
    expect(p1.next).toBeTruthy();
    const p2 = (await (
      await api(`/messages?limit=2&before=${encodeURIComponent(p1.next!)}`)
    ).json()) as { items: { messageId: string }[]; next: string | null };
    expect(p2.items.length).toBe(2);
    expect(p2.next).toBeNull();
    const all = new Set([...p1.items, ...p2.items].map((i) => i.messageId));
    expect(all.size).toBe(4);
  });

  it("HTML 邮件：白名单外远程图片剥除，白名单内保留，cid 重写到附件端点，style 里的 url() 被剥除", async () => {
    const detail = (await (await api(`/message/${encodeURIComponent("mid:w03@test.local")}`)).json()) as {
      html: string;
      remoteBlocked: number;
      attachments: { cid: string | null; inline: boolean }[];
    };
    expect(detail.remoteBlocked).toBe(1);
    expect(detail.html).toContain('data-remote-src="https://tracker.example.com/pixel.png"');
    // 属性名 data-remote-src 也含子串 src=，断言要用带前导空格的 src="
    expect(detail.html).not.toContain(' src="https://tracker.example.com/pixel.png"');
    expect(detail.html).toContain('src="https://pics.edu.cn/logo.png"');
    expect(detail.html).toContain("/api/mail/message/mid%3Aw03%40test.local/attachment/0");
    // sanitize-html 会把 style 重序列化为紧凑形式（color: red → color:red）
    expect(detail.html).toContain("color:red");
    expect(detail.html).not.toContain("url(");
    expect(detail.attachments.length).toBe(1);
    expect(detail.attachments[0].cid).toBeTruthy();
  });

  it("附件端点返回原始字节", async () => {
    const res = await api(
      `/message/${encodeURIComponent("mid:w04@test.local")}/attachment/0`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString("utf8")).toBe("hello report\n");
  });

  it("健康检查报告每账号最近同步状态", async () => {
    const health = (await (await api("/health")).json()) as {
      ok: boolean;
      accounts: { id: string; lastSync: string | null; lastError: string | null }[];
    };
    expect(health.ok).toBe(true);
    for (const a of health.accounts) {
      expect(a.lastSync).toBeTruthy();
      expect(a.lastError).toBeNull();
    }
  });

  it("不存在的消息返回 404", async () => {
    const res = await api(`/message/${encodeURIComponent("mid:nope@test.local")}`);
    expect(res.status).toBe(404);
  });
});
