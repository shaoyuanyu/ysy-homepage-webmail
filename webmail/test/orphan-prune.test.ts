import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openDb, type Db } from "../../mail/src/db.js";
import { pruneOrphanMessages } from "../../mail/src/message.js";
import { deleteAccount } from "../src/accounts.js";
import type { WebmailContext } from "../src/api.js";
import type { WebmailAccount } from "../src/types.js";

/**
 * 孤儿邮件清理的集合化（2026-10-08 事故回归）。
 *
 * 事故：删除一个已同步 6516 封的账号，前端「确认」后**硬卡 41.3 秒**。
 * 根因是 `messages_fts` 的 `message_id` 是 UNINDEXED 列，
 * `DELETE FROM messages_fts WHERE message_id = ?` 每次都要全表扫 FTS 内容表——
 * 逐封删 = O(n²)；且 better-sqlite3 是同步 API，这期间 webmaild 的事件循环
 * 被整个占住（连 /health 都不响应）。
 *
 * 两条用例分工：
 * 1. **源码扫描**（确定性）：禁止再出现「按 message_id 删 FTS」的批量写法；
 * 2. **规模行为**：造 5000 封的库跑真实 deleteAccount，断言「结果一致 + 不再是 O(n²)」。
 *    （旧实现 5000 封约 24 秒，新实现 < 1 秒，阈值 10 秒两边都有充足余量。）
 */

const root = join(import.meta.dirname, "..", ".test-data", "orphan-prune");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function listSources(dir: string): { file: string; code: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, code: readFileSync(join(dir, f), "utf8") }));
}

describe("源码扫描：FTS 行不能按 message_id 逐条删（O(n²) 回归）", () => {
  it("只有单封替换（source.ts）允许 `DELETE ... messages_fts WHERE message_id =`", () => {
    const trees = [
      join(import.meta.dirname, "..", "..", "mail", "src"),
      join(import.meta.dirname, "..", "src"),
    ];
    const hits: string[] = [];
    for (const tree of trees) {
      for (const { file, code } of listSources(tree)) {
        code.split("\n").forEach((line, i) => {
          if (/DELETE\s+FROM\s+messages_fts\s+WHERE\s+message_id/i.test(line)) {
            hits.push(`${file}:${i + 1}`);
          }
        });
      }
    }
    // source.ts 是「单封邮件补取原文后换一行 FTS」的场景（一次一行，代价可接受）
    // ⚠ 断言**文件**而不是具体行号：行号会因为旁边加一行注释/代码而漂移，
    //   那样红灯就成了假警报（2026-10-08：加一行就让这条用例误报）
    expect(hits.map((h) => h.split(":")[0]), `命中：${hits.join(", ")}`).toEqual(["source.ts"]);
    expect(hits).toHaveLength(1);
  });
});

/** 造一个 5000 封的库（直接写表，不走 MIME 解析），返回 ctx 与计数函数 */
function makeBigContext(suffix: string, count: number) {
  const dir = join(root, suffix);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const accounts: WebmailAccount[] = [
    {
      id: "big", displayName: "大账号", email: "big@test.local", provider: "test", color: "#000",
      imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1,
      smtpSecure: false, folders: ["INBOX"], enabled: true,
    },
    {
      id: "keep", displayName: "保留", email: "keep@test.local", provider: "test", color: "#000",
      imapHost: "127.0.0.1", imapPort: 1, imapSecure: false, smtpHost: "127.0.0.1", smtpPort: 1,
      smtpSecure: false, folders: ["INBOX"], enabled: true,
    },
  ];
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts }, null, 2));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({ big: { username: "u", password: "p" }, keep: { username: "u", password: "p" } })
  );

  const db: Db = openDb(join(dir, "webmail.db"));
  const body = "基准测试正文 ".repeat(200);
  const insMsg = db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
     VALUES (?, ?, 'a@b.c', 'A', '[]', '[]', ?, ?, ?, 0, ?, '', '[]', 0)`
  );
  const insFts = db.prepare(
    "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, 'a@b.c', '', ?)"
  );
  const insCopy = db.prepare(
    "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES (?, ?, ?, ?, '')"
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const mid = `mid:big-${i}@test.local`;
      insMsg.run(mid, new Date(Date.UTC(2016, 0, 1, 0, i % 1440)).toISOString(), `t${i}`, `s${i}`, body.length, new Date().toISOString());
      insFts.run(mid, `t${i}`, body);
      insCopy.run("big", "INBOX", i + 1, mid);
    }
    // 同一个 Message-ID 在另一个账号也有副本（各 3 封）：删掉大账号后这几封必须留下
    for (let i = 0; i < 3; i++) {
      const mid = `mid:shared-${i}@test.local`;
      insMsg.run(mid, new Date().toISOString(), `shared ${i}`, `shared ${i}`, 10, new Date().toISOString());
      insFts.run(mid, `shared ${i}`, "shared body");
      insCopy.run("big", "INBOX", count + i + 1, mid);
      insCopy.run("keep", "INBOX", i + 1, mid);
    }
  })();

  const ctx: WebmailContext = {
    db,
    dataDir: dir,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    credentials: new Map(accounts.map((a) => [a.id, { username: "u", password: "p" }])),
    remoteImageDomains: [],
    syncStates: new Map(),
  };
  const count1 = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return { ctx, db, dir, count: count1 };
}

describe("deleteAccount：5000 封规模下结果一致且不再是 O(n²)", () => {
  it("删完无孤儿、FTS 与 messages 行数一致、共有邮件保留", () => {
    const { ctx, db, count } = makeBigContext("big", 5000);
    // 5000（大账号）+ 3 + 3（同一 Message-ID 在两个账号各一份副本）
    expect(count("SELECT COUNT(*) AS n FROM copies")).toBe(5006);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(5003);

    const t0 = Date.now();
    deleteAccount(ctx, "big");
    const ms = Date.now() - t0;

    // 只剩 keep 账号里那 3 封共有邮件
    expect(count("SELECT COUNT(*) AS n FROM copies")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts")).toBe(3);
    // 没有孤儿（messages 里不存在没有任何副本的行）
    expect(
      count(
        "SELECT COUNT(*) AS n FROM messages m WHERE NOT EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id)"
      )
    ).toBe(0);
    // ⚠ 性能回归哨兵：旧实现（逐封删 FTS）在这个规模约 24 秒
    expect(ms, `deleteAccount 5000 封耗时 ${ms}ms（旧实现约 24s）`).toBeLessThan(10_000);
    db.close();
  });
});

describe("pruneOrphanMessages：原文文件回收", () => {
  it("删账号会把 eml/ 里的原文一起清掉（索引与磁盘同时回收）", () => {
    const { ctx, db, dir } = makeBigContext("eml", 20);
    // 给其中 5 封造出真实的 eml 文件 + eml_path 指向它
    const emlDir = join(dir, "eml");
    mkdirSync(emlDir, { recursive: true });
    const rows = db
      .prepare("SELECT message_id FROM messages ORDER BY message_id LIMIT 5")
      .all() as { message_id: string }[];
    const upd = db.prepare("UPDATE messages SET eml_path = ? WHERE message_id = ?");
    for (const [i, r] of rows.entries()) {
      const rel = `eml/file-${i}.eml`;
      writeFileSync(join(dir, rel), "Subject: x\n\nbody");
      upd.run(rel, r.message_id);
    }
    // 再放一个「孤立的」老文件：它不该被这次删除碰到（只删本事务清理出的那些）
    writeFileSync(join(dir, "eml/untouched.eml"), "keep me");

    deleteAccount(ctx, "big");
    expect(readdirSync(emlDir).sort()).toEqual(["untouched.eml"]);
    // 剩下的 3 封共有邮件里若还有引用，也不受影响（这里都没有 eml_path）
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM messages WHERE eml_path != ''").get() as { n: number }).n
    ).toBe(0);
    db.close();
  });
});

describe("pruneOrphanMessages：候选集语义", () => {
  it("只删「确实没有副本」的；同一封还有别的副本时连 FTS 一起保留", () => {
    const { ctx, db, count } = makeBigContext("partial", 50);
    const shared = "mid:shared-0@test.local";

    // 只删大账号的那一份副本 → 共有邮件必须留下，且 FTS 行完整
    db.prepare("DELETE FROM copies WHERE account_id = 'big' AND message_id = ?").run(shared);
    expect(pruneOrphanMessages(db, { candidates: [shared] }).removed).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE message_id = ?", shared)).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = ?", shared)).toBe(1);

    // 再删最后一份副本 → 这次才真的清理（messages 与 FTS 一起走）
    db.prepare("DELETE FROM copies WHERE account_id = 'keep' AND message_id = ?").run(shared);
    expect(pruneOrphanMessages(db, { candidates: [shared] }).removed).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages WHERE message_id = ?", shared)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts WHERE message_id = ?", shared)).toBe(0);
    // 其它邮件不受影响
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(52);
    db.close();
  });
});
