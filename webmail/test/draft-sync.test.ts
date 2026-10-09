import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
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
  // 草稿箱刷新有 60s TTL（来回切 tab 不必反复跨境 FETCH）；用例里每次都要求真刷
  process.env.WEBMAIL_DRAFT_REFRESH_TTL_MS = "0";
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

/**
 * 草稿箱（2026-10-10 阶段 1：**服务商的草稿文件夹是唯一事实源**）。
 *
 * 上面那组是"本地 → 服务器"的提交方向；这一组是反向：别的客户端（手机/网页端）写的草稿
 * 必须出现在站内草稿箱里，而且**打开时才去抓原文**（列表只用 IMAP envelope，便宜）。
 */
describe("草稿箱：服务商草稿文件夹 → 站内", () => {
  /** 直连 Dovecot 投一封"别的客户端写的"草稿（模拟手机端），返回 uid */
  async function appendExternal(opts: {
    subject: string;
    text: string;
    to?: string;
    inReplyTo?: string;
    flags?: string[];
    attachment?: { filename: string; content: Buffer; contentType: string };
    kindHeader?: string;
    refHeader?: string;
  }): Promise<number> {
    const headers: Record<string, string> = {};
    if (opts.kindHeader) headers["X-Webmail-Draft-Kind"] = opts.kindHeader;
    if (opts.refHeader) headers["X-Webmail-Draft-Ref"] = opts.refHeader;
    const composer = new MailComposer({
      from: "test@local",
      to: opts.to ?? "someone@example.org",
      subject: opts.subject,
      text: opts.text,
      inReplyTo: opts.inReplyTo,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      attachments: opts.attachment
        ? [{ filename: opts.attachment.filename, content: opts.attachment.content, contentType: opts.attachment.contentType }]
        : undefined,
    });
    const raw = await composer.compile().build();
    const client = await connectUser(dovecot, "test", "test");
    try {
      const res = await client.append("Drafts", raw, opts.flags ?? ["\\Draft"]);
      expect(res).not.toBe(false);
      return (res as { uid: number }).uid;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  const listDrafts = async () => {
    const res = await api("/drafts?refresh=1");
    expect(res.status).toBe(200);
    return (await res.json()) as {
      items: {
        id: string;
        accountId: string;
        kind: string;
        kindRef: string;
        to: string;
        subject: string;
        body: string;
        contentLoaded: boolean;
        attachments: { filename: string; size: number }[];
      }[];
      errors: { accountId: string; error: string }[];
    };
  };

  it("别的客户端写的草稿能进站内草稿箱；列表只有 envelope，打开时才解析正文", async () => {
    const uid = await appendExternal({
      subject: "手机写了一半",
      text: "第一段还没写完",
      to: "colleague@example.org",
    });

    const { items, errors } = await listDrafts();
    expect(errors).toEqual([]);
    const hit = items.find((d) => d.accountId === "acc1" && d.subject === "手机写了一半");
    expect(hit, "外部草稿必须出现在草稿箱里").toBeTruthy();
    // 列表阶段：主题/收件人来自 envelope；正文**还没读**
    expect(hit!.to).toContain("colleague@example.org");
    expect(hit!.contentLoaded).toBe(false);
    expect(hit!.body).toBe("");

    // 打开（写信页那一步）→ 抓原文解析出正文
    const one = await api(`/drafts/${hit!.id}`);
    expect(one.status).toBe(200);
    const full = (await one.json()) as { body: string; contentLoaded: boolean; attachments: unknown[] };
    expect(full.contentLoaded).toBe(true);
    expect(full.body).toContain("第一段还没写完");
    expect(full.attachments).toEqual([]);

    // 清场：删本地 + 服务器副本
    await api(`/drafts/${hit!.id}`, { method: "DELETE" });
    expect((await serverDrafts()).some((d) => d.uid === uid)).toBe(false);
  });

  it("\Deleted 的僵尸草稿不显示（服务端从未 EXPUNGE 的那种）", async () => {
    const uid = await appendExternal({
      subject: "早就删了但没清理",
      text: "x",
      flags: ["\\Draft", "\\Deleted"],
    });
    const { items } = await listDrafts();
    expect(items.some((d) => d.subject === "早就删了但没清理")).toBe(false);
    // 不显示 ≠ 动了服务器：那一封还在（我们只读）
    expect((await serverDrafts()).some((d) => d.uid === uid)).toBe(true);
  });

  it("归属键：自定义头往返；外部草稿按 In-Reply-To 推成「回复」", async () => {
    // 站内写的转发草稿（kind=forward 推不出来，只能靠自己写的头往返）
    const created = (await (
      await api("/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId: "acc1",
          to: "eve@example.org",
          subject: "转发草稿",
          body: "转给你",
          kind: "forward",
          kindRef: "<orig@local>",
        }),
      })
    ).json()) as { id: string };
    await mirrorDrafts(tc.ctx, { quietMs: 0 });
    const afterPush = await listDrafts();
    const mine = afterPush.items.find((d) => d.id === created.id);
    expect(mine?.kind).toBe("forward");
    expect(mine?.kindRef).toBe("<orig@local>");

    // 手机端写的回复草稿：只有 In-Reply-To，没有自定义头
    await appendExternal({
      subject: "Re: 讨论",
      text: "我回一下",
      inReplyTo: "<thread@example.org>",
    });
    const list = await listDrafts();
    const ext = list.items.find((d) => d.subject === "Re: 讨论");
    expect(ext?.kind).toBe("reply");
    expect(ext?.kindRef).toBe("<thread@example.org>");

    await api(`/drafts/${created.id}`, { method: "DELETE" });
    if (ext) await api(`/drafts/${ext.id}`, { method: "DELETE" });
  });

  it("保存站内修改时保留原件附件（不能因为站内不能编辑附件就把它们弄丢）", async () => {
    const uid = await appendExternal({
      subject: "带附件的草稿",
      text: "正文里说了附件",
      attachment: { filename: "report.txt", content: Buffer.from("hello attachment"), contentType: "text/plain" },
    });
    const { items } = await listDrafts();
    const hit = items.find((d) => d.subject === "带附件的草稿");
    expect(hit).toBeTruthy();

    // 打开 → 解析出附件清单
    const full = (await (await api(`/drafts/${hit!.id}`)).json()) as {
      attachments: { filename: string; size: number }[];
    };
    expect(full.attachments.map((a) => a.filename)).toEqual(["report.txt"]);

    // 站内改正文并保存 → 提交到服务器（替换旧版）
    const put = await api(`/drafts/${hit!.id}`, {
      method: "PUT",
      body: JSON.stringify({ subject: "带附件的草稿（改）", body: "改过的正文" }),
    });
    expect(put.status).toBe(200);
    const r = await mirrorDrafts(tc.ctx, { quietMs: 0 });
    expect(r.failed).toBe(0);

    // 服务器上只剩一封，且附件还在、正文是新版
    const left = (await serverDrafts()).filter((d) => d.subject === "带附件的草稿（改）");
    expect(left).toHaveLength(1);
    const client = await connectUser(dovecot, "test", "test");
    try {
      await client.mailboxOpen("Drafts", { readOnly: true });
      const msg = await client.fetchOne(String(left[0].uid), { source: true }, { uid: true });
      expect(msg).toBeTruthy();
      const parsed = await simpleParser((msg as { source: Buffer }).source);
      expect(parsed.attachments.map((a) => a.filename)).toEqual(["report.txt"]);
      expect(parsed.attachments[0].content.toString()).toBe("hello attachment");
      expect(parsed.text ?? "").toContain("改过的正文");
    } finally {
      await client.logout().catch(() => {});
    }
    // 旧那封（带旧主题）已被替换
    expect((await serverDrafts()).some((d) => d.uid === uid)).toBe(false);

    await api(`/drafts/${hit!.id}`, { method: "DELETE" });
  });
});
