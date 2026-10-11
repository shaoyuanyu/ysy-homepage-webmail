import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import type { DovecotHandle } from "./dovecot.js";

/**
 * 「全选」的范围 = **视图口径下全部匹配**（2026-10-11）。
 *
 * 之前「全选」只选**已加载的那几页**（每页 50），用户要求改成「当前筛选范围内的全部邮件」。
 * 实现拆成两半：
 *   · `GET /messages/count` —— 与 `/messages` 同一套参数，给前端一个数字；
 *   · `POST /flags|/delete` 的 `scope` —— 前端把加载列表用的那串查询串原样发过来，服务端
 *     用同一个 `parseListQuery` 解析后**全量执行**（不受页数限制）。
 * 本文件只覆盖**不碰 IMAP** 的部分（计数口径、范围解析、上限拒绝）——写回服务端的部分
 * 在 write.test.ts（那里有 Dovecot）。
 *
 * 造库不启 Dovecot：读路径与范围解析都不上网。
 */

/** 60 封 > 默认页大小 50 —— 「计数不受分页限制」这条断言需要它 */
const BULK = 60;

let tc: TestContext;
let server: Server;
let base: string;

async function countOf(query = ""): Promise<number> {
  const res = await fetch(`${base}/messages/count${query ? `?${query}` : ""}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** messages 表的行数（「上限拒绝时一行都没动」要断言它） */
function messageRows(): number {
  return (tc.ctx.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
}

beforeAll(async () => {
  const handle = {
    container: "none",
    host: "127.0.0.1",
    port: 1,
    dir: "",
    cleanup() {},
  } satisfies DovecotHandle;
  tc = makeContext(handle, 1, "scope");

  const db = tc.ctx.db;
  const insertMessage = db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, subject, snippet, first_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insertCopy = db.prepare(
    "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES (?, ?, ?, ?, ?)"
  );
  const insertFts = db.prepare(
    "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)"
  );

  // ① 收件箱 60 封未读（acc1）—— 日期递增，保证有稳定顺序
  for (let i = 0; i < BULK; i++) {
    const id = `mid:bulk-${String(i).padStart(2, "0")}@test.local`;
    // 月/日两位数递减：i 越大日期越早（列表是 date DESC）
    const day = String(28 - (i % 28)).padStart(2, "0");
    const hour = String(23 - Math.floor(i / 28)).padStart(2, "0");
    insertMessage.run(
      id,
      `2026-09-${day}T${hour}:00:00.000Z`,
      `sender${i}@local`,
      `发件人${i}`,
      `第 ${i} 封`,
      `片段 ${i}`,
      "2026-10-11T00:00:00.000Z"
    );
    insertCopy.run("acc1", "INBOX", i + 1, id, "");
    // 前 3 封进 FTS，供搜索路径的计数用例
    if (i < 3) insertFts.run(id, `第 ${i} 封`, "发件人", "我", "会议纪要 第 " + i + " 段");
  }

  // ② 我自己发出的一封（副本全在 Sent）—— `direction=sent` 用
  insertMessage.run(
    "mid:sent@test.local",
    "2026-09-20T10:00:00.000Z",
    "me@local",
    "我",
    "我发出的",
    "片段",
    "2026-10-11T00:00:00.000Z"
  );
  insertCopy.run("acc1", "Sent", 101, "mid:sent@test.local", "");

  // ③ 只躺在垃圾文件夹里的一封 —— 不给 folder 时**不算「邮件」**
  insertMessage.run(
    "mid:junk@test.local",
    "2026-09-19T10:00:00.000Z",
    "spam@local",
    "垃圾",
    "垃圾信",
    "片段",
    "2026-10-11T00:00:00.000Z"
  );
  insertCopy.run("acc1", "垃圾邮件", 102, "mid:junk@test.local", "");

  // ④ 一封草稿（副本带 \Draft）—— 任何视图都不出现，包括计数
  insertMessage.run(
    "mid:draft@test.local",
    "2026-09-18T10:00:00.000Z",
    "me@local",
    "我",
    "草稿",
    "片段",
    "2026-10-11T00:00:00.000Z"
  );
  insertCopy.run("acc1", "Drafts", 103, "mid:draft@test.local", "\\Draft");

  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  tc.cleanup();
});

describe("GET /messages/count：视图口径的计数", () => {
  it("与列表同一口径，且**不受分页限制**（列表只给 50 + 游标，计数给全部 61）", async () => {
    const list = (await (await fetch(`${base}/messages`)).json()) as {
      items: unknown[];
      next: string | null;
    };
    expect(list.items.length).toBe(50);
    expect(list.next).not.toBeNull();
    // 61 = 收件箱 60 + 我发出的 1（草稿与「只躺在垃圾里」的被排除）
    expect(await countOf()).toBe(BULK + 1);
  });

  it("草稿不是邮件：不计入（与列表同口径）", async () => {
    // 草稿单独查也查不到（NOT_DRAFT_SQL 无条件生效）
    expect(await countOf("q=草稿")).toBe(0);
  });

  it("「只躺在垃圾文件夹里」不计入；显式按该文件夹查才计入（垃圾 tab 那条路）", async () => {
    expect(await countOf()).toBe(BULK + 1);
    expect(await countOf(`folder=${encodeURIComponent("垃圾邮件")}`)).toBe(1);
  });

  it("账号范围收窄计数（acc1 有全部，acc2 为空）", async () => {
    expect(await countOf("account=acc1")).toBe(BULK + 1);
    expect(await countOf("account=acc2")).toBe(0);
  });

  it("方向筛选：direction=sent 只算副本全在「已发送」类文件夹的", async () => {
    expect(await countOf("direction=sent")).toBe(1);
    // received = 有 INBOX 副本（我发出的那封不在内）
    expect(await countOf("direction=received")).toBe(BULK);
  });

  it("未读筛选与列表同一判据（默认读范围 = 收件箱）", async () => {
    expect(await countOf("filter=unseen")).toBe(BULK);
    // 把 5 封收件箱邮件的副本标为已读 → 计数跟着落 5（⚠ 本用例会改库，放在最后）
    const ids = (
      tc.ctx.db.prepare("SELECT message_id FROM copies WHERE folder = 'INBOX' LIMIT 5").all() as {
        message_id: string;
      }[]
    ).map((r) => r.message_id);
    // ⚠ SQL 字面量里写一个反斜杠就够（SQLite 不处理 `\\` 转义）——多写一层会变成两个
    //   反斜杠，而判据是整词匹配 `' \Seen '`，于是"标了却筛不出来"
    const upd = tc.ctx.db.prepare("UPDATE copies SET flags = '\\Seen' WHERE message_id = ?");
    for (const id of ids) upd.run(id);
    expect(await countOf("filter=unseen")).toBe(BULK - 5);
    expect(await countOf("filter=unseen,flagged")).toBe(0);
  });

  it("搜索路径：计数与列表同一上限（搜索没有游标，命中数就是上限）", async () => {
    const q = encodeURIComponent("会议纪要");
    const list = (await (await fetch(`${base}/messages?q=${q}`)).json()) as { items: unknown[] };
    expect(list.items.length).toBe(3);
    expect(await countOf(`q=${q}`)).toBe(3);
  });
});

describe("POST /delete|/move 的 scope：范围解析与上限", () => {
  it("删除范围超过上限（20 封）→ 400，且本地一行都没动", async () => {
    const before = messageRows();
    const res = await post("/delete", { scope: "account=acc1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("最多删除 20 封");
    expect(messageRows()).toBe(before);
  });

  it("/move 不接受 scope（范围移动没有语义，也不在需求里）", async () => {
    const res = await post("/move", { scope: "account=acc1", to: "Trash" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("scope 只支持 delete");
  });
});
