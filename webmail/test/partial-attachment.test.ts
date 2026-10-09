import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeContext, type TestContext } from "./context.js";
import { deliverRaw, startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";

/**
 * 附件门控的**服务端链路**（2026-10-08）：精简原文 → 详情返回清单 → 点附件时
 * **只取那一个部件**（不下载整封）。
 *
 * ⚠ 环境变量要在 import api.js（它会 import 抓取器）之前设好——门控常量在模块加载时读。
 */
process.env.MAIL_AGENT_MAX_SOURCE_BYTES = "102400"; // 100KB
const { createApiServer: createServer } = await import("../src/api.js");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);

/** multipart/related：HTML 正文 + cid 内嵌图 + 一个 150KB 的 pdf 附件（超门控） */
function fixture(): Buffer {
  const payload = Buffer.alloc(150 * 1024, "Z").toString("base64");
  return Buffer.from(
    [
      "From: news@x.y",
      "To: test@local",
      "Subject: gated newsletter",
      "Date: Fri, 25 Sep 2026 17:00:00 +0800",
      "Message-ID: <gated-1@test.local>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="gb"',
      "",
      "--gb",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      '<p>hello gated</p><img src="cid:logo@test.local">',
      "",
      "--gb",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@test.local>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      PNG.toString("base64"),
      "",
      "--gb",
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      payload,
      "",
      "--gb--",
      "",
    ].join("\r\n"),
    "utf8"
  );
}

let dovecot: DovecotHandle;
let tc: TestContext;
let server: Server;
let base: string;

const api = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

beforeAll(async () => {
  dovecot = startDovecot("partial-att");
  await waitReady(dovecot);
  await deliverRaw(dovecot, "test", "test", [fixture()]);
  tc = makeContext(dovecot, 1, "partial-att");
  server = createServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sync = await api("/sync", { method: "POST" });
  expect(sync.status).toBe(200);
}, 180_000);

afterAll(() => {
  server.close();
  tc.cleanup();
  dovecot.cleanup();
  rmSync(join(tc.dir, ".."), { recursive: true, force: true });
});

interface Detail {
  messageId: string;
  text: string;
  html: string;
  partial: boolean;
  truncated: boolean;
  attachments: {
    index: number;
    filename: string;
    contentType: string;
    size: number;
    cid: string | null;
    inline: boolean;
    deferred: boolean;
  }[];
}

async function detailOf(): Promise<{ id: string; detail: Detail }> {
  const list = (await (await api("/messages")).json()) as { items: { messageId: string }[] };
  const id = list.items[0].messageId;
  const res = await api(`/message/${encodeURIComponent(id)}`);
  expect(res.status).toBe(200);
  return { id, detail: (await res.json()) as Detail };
}

describe("附件门控：详情给清单，附件端点只取那一个部件", () => {
  it("详情：正文与内嵌图可读，附件标成 deferred（清单序号与整封一致）", async () => {
    const { detail } = await detailOf();
    expect(detail.partial, "精简原文要标成 partial").toBe(true);
    expect(detail.html).toContain("hello gated");
    // cid 引用被重写成附件端点（用**清单的序号**，不是精简原文里的序号）
    expect(detail.html).toContain("/attachment/0");
    expect(detail.attachments.map((a) => [a.index, a.filename, a.deferred, a.inline])).toEqual([
      [0, "logo.png", false, true],
      [1, "doc.pdf", true, false],
    ]);
    // 推迟的附件也要有真实大小（界面要显示）
    expect(detail.attachments[1].size).toBeGreaterThan(100 * 1024);
  });

  it("内嵌图（已留存）直接从本地精简原文取，不走 IMAP", async () => {
    const { id } = await detailOf();
    const res = await api(`/message/${encodeURIComponent(id)}/attachment/0`);
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    expect(res.headers.get("content-type")).toContain("image/png");
  });

  it("被推迟的附件：点击时按部件号向服务器取回（不下载整封）", async () => {
    const { id } = await detailOf();
    const res = await api(`/message/${encodeURIComponent(id)}/attachment/1`);
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // 内容是**解码后**的原附件（150KB 的 "Z" 重复）：既证明按需取回来了，
    // 也证明 base64 被正确解开了（没解的话这里会是 204800 字节的 base64 文本）
    expect(buf.length).toBe(150 * 1024);
    expect(buf.toString("utf8")).toBe("Z".repeat(150 * 1024));
    // 安全头仍在（attachment.ts 的白名单逻辑没被绕过）
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-disposition")).toContain("attachment");
  });

  it("精简原文不算 .eml 原件：GET /source 必须 404，补取之后才能下", async () => {
    const { id } = await detailOf();
    const before = await api(`/message/${encodeURIComponent(id)}/source`);
    expect(before.status, "精简原文不能当原件下发").toBe(404);

    const post = await api(`/message/${encodeURIComponent(id)}/source`, { method: "POST" });
    expect(post.status).toBe(200);
    expect(((await post.json()) as { fetched: boolean }).fetched).toBe(true);

    // 补取整封之后：清单清空、partial 变 false、原件可下
    const { detail } = await detailOf();
    expect(detail.partial).toBe(false);
    expect(detail.attachments.map((a) => [a.filename, a.deferred])).toEqual([
      ["logo.png", false],
      ["doc.pdf", false],
    ]);
    const after = await api(`/message/${encodeURIComponent(id)}/source`);
    expect(after.status).toBe(200);
    expect((await after.arrayBuffer()).byteLength).toBeGreaterThan(150 * 1024);
  });
});
