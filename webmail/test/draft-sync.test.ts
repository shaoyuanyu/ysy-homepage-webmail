import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { createApiServer } from "../src/api.js";
import { mirrorDrafts } from "../src/draft-mirror.js";
import { makeContext, type TestContext } from "./context.js";
import { connectUser, startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

/**
 * 草稿 → 服务器「草稿」文件夹镜像（2026-10-06）。
 * 起因：本地草稿只存在 webmaild 的 SQLite，阿里云官方网页端看不到。
 *
 * 测试直接调用 mirrorDrafts（绕过 4 秒定时器与 10 秒安静期，传 quietMs: 0），
 * 用 IMAP 直读服务器侧草稿箱断言。
 */

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** 直读服务器草稿文件夹（webmaild 的 /messages 不索引它，必须走 IMAP） */
async function serverDrafts(): Promise<
  { uid: number; subject: string; flags: string[]; text: string }[]
> {
  const client = await connectUser(dovecot, "test", "test");
  try {
    await client.mailboxOpen("Drafts", { readOnly: true });
    const uids = (await client.search({}, { uid: true })) || [];
    const out: { uid: number; subject: string; flags: string[]; text: string }[] = [];
    for (const uid of uids) {
      const msg = await client.fetchOne(String(uid), { uid: true, flags: true, source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source as Buffer);
      out.push({
        uid,
        subject: parsed.subject ?? "",
        flags: msg.flags ? [...msg.flags] : [],
        text: parsed.text ?? "",
      });
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}

/** 轮询等待条件成立（发送后的服务器草稿清理是异步的，见 api.ts /send） */
async function waitFor<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(async () => {
  dovecot = startDovecot("draft");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "draft");
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

describe("webmaild 草稿镜像（本地 → 服务器草稿箱）", () => {
  it("未安静满的草稿不投递（合并连续自动保存）", async () => {
    const created = (await (
      await api("/drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: "acc1", to: "a@example.org", subject: "安静期测试" }),
      })
    ).json()) as { id: string };

    // quietMs = 60s：刚创建的草稿还没安静满，不应投递
    const r = await mirrorDrafts(tc.ctx, { quietMs: 60_000 });
    expect(r.mirrored).toBe(0);
    expect(await serverDrafts()).toHaveLength(0);

    // 清场（走 API：删除路径同时会尝试清理服务器副本，此处尚无副本）
    await api(`/drafts/${created.id}`, { method: "DELETE" });
  });

  it("新建草稿 → 投递到服务器草稿箱（\\Draft 标记、主题与正文正确）", async () => {
    const created = (await (
      await api("/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc1",
          to: "bob@example.org",
          subject: "镜像一",
          body: "第一版正文",
          readReceipt: true,
        }),
      })
    ).json()) as { id: string };

    const r = await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(r).toEqual({ mirrored: 1, failed: 0 });

    const drafts = await serverDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].subject).toBe("镜像一");
    expect(drafts[0].text).toContain("第一版正文");
    expect(drafts[0].flags).toContain("\\Draft");
    // 草稿不标已读（\Seen 只属于「读过的信」，草稿不是）
    expect(drafts[0].flags).not.toContain("\\Seen");

    // 再扫一轮：已同步（dirty=0）不再重复投递
    const r2 = await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(r2.mirrored).toBe(0);
    expect(await serverDrafts()).toHaveLength(1);

    // 更新 → 替换（服务器上仍只有一封，内容是新版）
    const put = await api(`/drafts/${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ subject: "镜像一（改）", body: "第二版正文" }),
    });
    expect(put.status).toBe(200);
    const r3 = await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(r3).toEqual({ mirrored: 1, failed: 0 });
    const updated = await serverDrafts();
    expect(updated).toHaveLength(1);
    expect(updated[0].subject).toBe("镜像一（改）");
    expect(updated[0].text).toContain("第二版正文");

    // 删除草稿 → 服务器副本一并删除
    const del = await api(`/drafts/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await serverDrafts()).toHaveLength(0);
  });

  it("发送带 draftId → 发送成功后服务器草稿副本被清理（异步，轮询等待）", async () => {
    const created = (await (
      await api("/drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: "acc1", to: "carol@example.org", subject: "要发出去的草稿", body: "内容" }),
      })
    ).json()) as { id: string };
    await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(await serverDrafts()).toHaveLength(1);

    const before = sink.received.length;
    const res = await api("/send", {
      method: "POST",
      body: JSON.stringify({
        accountId: "acc1",
        to: ["carol@example.org"],
        subject: "要发出去的草稿",
        text: "内容",
        draftId: created.id,
      }),
    });
    expect(res.status).toBe(200);
    expect(sink.received.length).toBe(before + 1);

    // 清理是 fire-and-forget（发送已成功不因清理失败而报错）→ 轮询等待
    const left = await waitFor(() => serverDrafts(), (v) => v.length === 0);
    expect(left).toHaveLength(0);
  });

  it("uidvalidity 变化 → 不按旧 UID 删除（防误删），只追加新版本", async () => {
    const created = (await (
      await api("/drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: "acc1", to: "dave@example.org", subject: "uidvalidity" }),
      })
    ).json()) as { id: string };
    await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(await serverDrafts()).toHaveLength(1);

    // 模拟「服务器邮箱被重建」：本地记录的 uidvalidity 与服务器现状不符
    tc.ctx.db.prepare("UPDATE drafts SET server_uidvalidity = '1', server_dirty = 1 WHERE id = ?").run(created.id);

    const r = await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(r).toEqual({ mirrored: 1, failed: 0 });
    // 安全优先：旧副本（UID 不可信）保留不动，新版本照常追加 → 暂时两封
    expect(await serverDrafts()).toHaveLength(2);

    // 记录中的 uidvalidity 已更新为新值，下一轮替换恢复正常（清场：删本地草稿 + 手动清不掉的旧副本）
    await api(`/drafts/${created.id}`, { method: "DELETE" });
    // 新副本已被删除路径清掉；旧副本（uidvalidity 不符时删除路径也会跳过）残留一封——
    // 这正是「宁多勿误删」的代价，测试末端用管理方式（UILess）清场由容器销毁承担
  });
});
