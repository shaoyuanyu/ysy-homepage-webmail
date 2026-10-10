import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import type { DovecotHandle } from "./dovecot.js";

/**
 * 列表响应里的每份副本带上其文件夹的 RFC 6154 特殊用途（2026-10-10）。
 *
 * 前端据此判定「这封是不是我发出的」，不再按文件夹名字猜（名字各服务商不同）。
 * 这里直接造库，不启动 Dovecot——`GET /messages` 的查询本身不碰网络。
 */

let tc: TestContext;
let server: Server;
let base: string;

beforeAll(async () => {
  // 只用 makeContext 造数据目录、账号注册表与库；handle 的 host/port 不会被使用
  const handle = {
    container: "none",
    host: "127.0.0.1",
    port: 1,
    dir: "",
    cleanup() {},
  } satisfies DovecotHandle;
  tc = makeContext(handle, 1, "special-use");

  const db = tc.ctx.db;
  const insertMessage = db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, subject, snippet, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  insertMessage.run(
    "mid:sent@test.local",
    "2026-10-10T10:00:00.000Z",
    "me@local",
    "我",
    "自定义发件箱里的信",
    "片段",
    "2026-10-10T10:00:00.000Z"
  );
  insertMessage.run(
    "mid:plain@test.local",
    "2026-10-10T09:00:00.000Z",
    "other@local",
    "对方",
    "普通文件夹里的信",
    "片段",
    "2026-10-10T09:00:00.000Z"
  );

  const insertCopy = db.prepare(
    "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES (?, ?, ?, ?, ?)"
  );
  insertCopy.run("acc1", "Outbox", 1, "mid:sent@test.local", "");
  insertCopy.run("acc1", "INBOX", 2, "mid:plain@test.local", "");

  const insertFolder = db.prepare(
    "INSERT INTO folders (account_id, path, special_use, uidvalidity, last_seen_uid) VALUES (?, ?, ?, ?, ?)"
  );
  // Outbox 这个名字不在任何常见名单里，唯一线索就是 service 端给的特殊用途标志位
  insertFolder.run("acc1", "Outbox", "\\Sent", 1, 1);
  // INBOX 故意不写 folders 行：验证没有 folders 行时 specialUse 是空串

  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  tc.cleanup();
});

interface ListItemShape {
  messageId: string;
  copies: { accountId: string; folder: string; uid: number; specialUse: string }[];
}

describe("列表响应：copies 携带文件夹 specialUse", () => {
  it("有 folders 行时带上 RFC 6154 标志位（自定义文件夹名也能判定）", async () => {
    const res = await fetch(`${base}/messages`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: ListItemShape[] };
    const sent = body.items.find((i) => i.messageId === "mid:sent@test.local");
    expect(sent).toBeDefined();
    expect(sent!.copies).toEqual([
      { accountId: "acc1", folder: "Outbox", uid: 1, specialUse: "\\Sent" },
    ]);
  });

  it("没有 folders 行时 specialUse 是空串（前端按文件夹名回退）", async () => {
    const res = await fetch(`${base}/messages`);
    const body = (await res.json()) as { items: ListItemShape[] };
    const plain = body.items.find((i) => i.messageId === "mid:plain@test.local");
    expect(plain).toBeDefined();
    expect(plain!.copies).toEqual([
      { accountId: "acc1", folder: "INBOX", uid: 2, specialUse: "" },
    ]);
  });
});
