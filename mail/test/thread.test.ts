import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import type { NewMeta } from "../src/imap.js";
import { backfillRefs, extractRefKeys, ingestMessage, refKeyOf } from "../src/message.js";
import { threadMessageIds } from "../src/thread.js";
import { fixturesDir, workRoot } from "./dovecot.js";

let db: Db;
const dataDir = join(workRoot, "db-thread");

function metaOf(uid: number, subject: string, messageId?: string): NewMeta {
  return {
    uid,
    flags: [],
    internalDate: new Date("2026-09-25T10:00:00+08:00"),
    size: 100,
    envelope: {
      date: new Date("2026-09-25T10:00:00+08:00"),
      subject,
      from: [{ name: "", address: "hr@example.com" }],
      messageId,
    },
  };
}

/** 直接插一行 messages（绕过 ingest，精确控制 refs_json） */
function insertMsg(
  db: Db,
  messageId: string,
  date: string,
  refs: string[] | null,
  hasAttach = 0
): void {
  db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, subject, snippet, first_seen, refs_json, has_attach)
     VALUES (?, ?, 'a@b.c', '', ?, '', ?, ?, ?)`
  ).run(messageId, date, messageId, date, refs === null ? null : JSON.stringify(refs), hasAttach);
}

beforeAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  db = openDb(":memory:");
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe("refKeyOf / extractRefKeys", () => {
  it("规范化：去尖括号、小写、补 mid: 前缀；引号与反斜线被剔除", () => {
    expect(refKeyOf("<ABC@X.COM>")).toBe("mid:abc@x.com");
    expect(refKeyOf('  <a"b@c>  ')).toBe("mid:ab@c");
    expect(refKeyOf("")).toBeNull();
    expect(refKeyOf(undefined)).toBeNull();
  });

  it("引用链：References 各环 + In-Reply-To 尾环，去重保序", () => {
    const keys = extractRefKeys({
      references: ["<a@x>", "<B@x>"],
      inReplyTo: "<b@x>",
    } as never);
    expect(keys).toEqual(["mid:a@x", "mid:b@x"]);
    // references 为单字符串、无 inReplyTo
    const single = extractRefKeys({ references: "<c@x>" } as never);
    expect(single).toEqual(["mid:c@x"]);
    // 全空 → 空链
    expect(extractRefKeys({} as never)).toEqual([]);
  });
});

describe("threadMessageIds", () => {
  it("不动点扩展：正向找引用链成员，反向找回复，多跳收敛", () => {
    // 会话：A ← B ← C，D 是断链的第三跳（只引用了 C），E 不相干
    insertMsg(db, "mid:a@t", "2026-09-25T02:00:00.000Z", []);
    insertMsg(db, "mid:b@t", "2026-09-25T03:00:00.000Z", ["mid:a@t"]);
    insertMsg(db, "mid:c@t", "2026-09-25T04:00:00.000Z", ["mid:a@t", "mid:b@t"]);
    insertMsg(db, "mid:d@t", "2026-09-25T05:00:00.000Z", ["mid:c@t"]);
    insertMsg(db, "mid:e@t", "2026-09-25T06:00:00.000Z", []);

    // 从中间一环出发：双向都齐，按时间升序
    expect(threadMessageIds(db, "mid:b@t")).toEqual([
      "mid:a@t",
      "mid:b@t",
      "mid:c@t",
      "mid:d@t",
    ]);
    // 从链头发出发：反向扩展到链尾
    expect(threadMessageIds(db, "mid:a@t")).toEqual([
      "mid:a@t",
      "mid:b@t",
      "mid:c@t",
      "mid:d@t",
    ]);
    // 孤信自成一线
    expect(threadMessageIds(db, "mid:e@t")).toEqual(["mid:e@t"]);
    // 不存在 → 空
    expect(threadMessageIds(db, "mid:nope@t")).toEqual([]);
  });

  it("带引号精确匹配：mid:ab 不会误命中 mid:abc", () => {
    insertMsg(db, "mid:ab@t", "2026-09-25T07:00:00.000Z", []);
    insertMsg(db, "mid:abc@t", "2026-09-25T08:00:00.000Z", ["mid:ab@t"]);
    insertMsg(db, "mid:x@t", "2026-09-25T09:00:00.000Z", ["mid:ab@t.extra"]);
    // mid:ab@t 的会话只含 abc 这个真回复；x 引用的是 ab@t.extra，不混入
    expect(threadMessageIds(db, "mid:ab@t")).toEqual(["mid:ab@t", "mid:abc@t"]);
  });
});

describe("ingestMessage 与 backfillRefs", () => {
  it("ingest 填充 refs_json / has_attach；存量 NULL 行由 backfill 补齐", async () => {
    // 有引用 + 纯文本：refs 入库、has_attach = 0
    const r = await ingestMessage(db, dataDir, {
      accountId: "a",
      folder: "INBOX",
      meta: metaOf(1, "Re: Thread root", "<t06@test.local>"),
      source: readFileSync(join(fixturesDir, "06-thread-reply.eml")),
    });
    expect(r.created).toBe(true);
    const row = db
      .prepare("SELECT refs_json, has_attach FROM messages WHERE message_id = ?")
      .get(r.messageId) as { refs_json: string; has_attach: number };
    expect(JSON.parse(row.refs_json)).toEqual(["mid:t05@test.local"]);
    expect(row.has_attach).toBe(0);

    // 有附件的信：has_attach = 1
    const r2 = await ingestMessage(db, dataDir, {
      accountId: "a",
      folder: "INBOX",
      meta: metaOf(2, "With attachment", "<t07@test.local>"),
      source: readFileSync(join(fixturesDir, "07-attach.eml")),
    });
    const row2 = db
      .prepare("SELECT has_attach FROM messages WHERE message_id = ?")
      .get(r2.messageId) as { has_attach: number };
    expect(row2.has_attach).toBe(1);

    // 模拟存量：把 refs_json 拨回 NULL，由 backfill 恢复
    db.prepare("UPDATE messages SET refs_json = NULL, has_attach = 0 WHERE message_id = ?").run(
      r.messageId
    );
    const bf = await backfillRefs(db, dataDir);
    expect(bf.updated).toBe(1);
    expect(bf.failed).toBe(0);
    const restored = db
      .prepare("SELECT refs_json FROM messages WHERE message_id = ?")
      .get(r.messageId) as { refs_json: string };
    expect(JSON.parse(restored.refs_json)).toEqual(["mid:t05@test.local"]);

    // 幂等：再跑一次无可回填行
    const again = await backfillRefs(db, dataDir);
    expect(again).toEqual({ updated: 0, failed: 0 });
  });

  it("backfill 跳过无原文（truncated）与坏文件行", async () => {
    // 无原文行：eml_path 为空，不参与回填
    insertMsg(db, "mid:notrunc@t", "2026-09-25T10:00:00.000Z", null);
    // 坏行：eml_path 指向不存在的文件 → failed 计数
    db.prepare(
      `INSERT INTO messages (message_id, date, from_addr, from_name, subject, snippet, first_seen, refs_json, eml_path)
       VALUES ('mid:ghost@t', '2026-09-25T11:00:00.000Z', 'a@b.c', '', 'ghost', '', '2026-09-25T11:00:00.000Z', NULL, 'eml/no-such.eml')`
    ).run();
    const r = await backfillRefs(db, dataDir);
    expect(r.updated).toBe(0);
    expect(r.failed).toBe(1);
    // 无原文行仍未被动过（refs_json 保持 NULL，等不到原文就一直是 NULL）
    const row = db
      .prepare("SELECT refs_json FROM messages WHERE message_id = 'mid:notrunc@t'")
      .get() as { refs_json: string | null };
    expect(row.refs_json).toBeNull();
  });

  it("truncated 入库（无原文）：refs_json 为空数组而非 NULL", async () => {
    const r = await ingestMessage(db, dataDir, {
      accountId: "a",
      folder: "INBOX",
      meta: metaOf(3, "Big one", "<big@test.local>"),
      // 无 source → truncated 路径
    });
    const row = db
      .prepare("SELECT refs_json, truncated FROM messages WHERE message_id = ?")
      .get(r.messageId) as { refs_json: string; truncated: number };
    expect(row.truncated).toBe(1);
    expect(JSON.parse(row.refs_json)).toEqual([]);
  });
});