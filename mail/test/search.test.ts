import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../src/db.js";
import type { NewMeta } from "../src/imap.js";
import { ingestMessage } from "../src/message.js";
import { searchMessages } from "../src/search.js";
import { fixturesDir, workRoot } from "./dovecot.js";

let db: Db;
const dataDir = join(workRoot, "db-search");

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

beforeAll(async () => {
  rmSync(dataDir, { recursive: true, force: true });
  db = openDb(":memory:");
  const seeds = [
    { uid: 1, file: "01.eml", subject: "面试通知安排", mid: "<m1@test.local>" },
    { uid: 2, file: "02.eml", subject: "Team meeting", mid: "<m2@test.local>" },
    { uid: 3, file: "03.eml", subject: "Weekly Digest", mid: undefined },
  ];
  for (const s of seeds) {
    await ingestMessage(db, dataDir, {
      accountId: "a",
      folder: "INBOX",
      meta: metaOf(s.uid, s.subject, s.mid),
      source: readFileSync(join(fixturesDir, s.file)),
    });
  }
  // 同一封邮件在账号 b 的副本：messages 不加行，copies 加一行
  await ingestMessage(db, dataDir, {
    accountId: "b",
    folder: "INBOX",
    meta: metaOf(7, "面试通知安排", "<m1@test.local>"),
    source: readFileSync(join(fixturesDir, "01.eml")),
  });
});

afterAll(() => {
  db?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("trigram 模糊搜索", () => {
  it("3 字符以上子串命中", () => {
    const hits = searchMessages(db, "试的通知");
    expect(hits).toHaveLength(1);
    expect(hits[0].subject).toContain("面试通知");
  });

  it("1~2 字符走 LIKE 兜底", () => {
    expect(searchMessages(db, "面")).toHaveLength(1);
    expect(searchMessages(db, "面试")).toHaveLength(1);
  });

  it("英文词片段命中", () => {
    expect(searchMessages(db, "sync")).toHaveLength(1);
  });

  it("HTML 正文转文本后可搜", () => {
    expect(searchMessages(db, "学术动态")).toHaveLength(1);
  });

  it("无结果返回空数组", () => {
    expect(searchMessages(db, "不存在的词")).toHaveLength(0);
  });

  it("多副本聚合账号列表且消息只存一份", () => {
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toMatchObject({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM copies").get()).toMatchObject({ n: 4 });
    const hits = searchMessages(db, "面试");
    expect(hits).toHaveLength(1);
    expect(hits[0].accounts.slice().sort()).toEqual(["a", "b"]);
  });
});
