import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/**
 * 打开（必要时创建）邮件索引库。
 * @param dbPath SQLite 文件路径，测试可传 ":memory:"
 */
export function openDb(dbPath: string): Db {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    -- 每个（账号, 文件夹）的增量抓取状态机
    CREATE TABLE IF NOT EXISTS folders (
      account_id TEXT NOT NULL,
      path TEXT NOT NULL,
      uidvalidity INTEGER,
      last_seen_uid INTEGER NOT NULL DEFAULT 0,
      last_flags_sync TEXT,
      PRIMARY KEY (account_id, path)
    );

    -- 消息本体：同一 Message-ID 在所有账号里只存一份
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      date TEXT,
      from_addr TEXT,
      from_name TEXT,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT,
      snippet TEXT NOT NULL DEFAULT '',
      size INTEGER NOT NULL DEFAULT 0,
      -- 1 = 超阈值只存了元数据，原文未留存（红线 12 的大附件按需）
      truncated INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      eml_path TEXT NOT NULL DEFAULT ''
    );

    -- 副本：同一封邮件出现在多个账号/文件夹时各一行
    CREATE TABLE IF NOT EXISTS copies (
      account_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      message_id TEXT NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
      flags TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS copies_message ON copies(message_id);

    -- 全文索引：trigram 分词，原生支持中文子串模糊搜索（MAIL-AGENT.md 6.1）
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      subject,
      from_text,
      to_text,
      body,
      tokenize = 'trigram'
    );
  `);
}

/**
 * 工具面入口的 messageId 宽容归一：库键（`mid:` / `auto:` 前缀）直接用；
 * 裸 Message-ID（`<x@y>` 或 `x@y`，大小写不敏感）补 `mid:` 前缀再查。
 * 只返回本地索引里确实存在的键，查不到返回 null（3.5：不接受任意传入的值）。
 */
export function resolveMessageKey(db: Db, input: string): string | null {
  const exists = db.prepare("SELECT 1 AS x FROM messages WHERE message_id = ?");
  if (exists.get(input)) return input;
  const bare = input.replace(/[<>]/g, "").trim().toLowerCase();
  if (bare) {
    const key = `mid:${bare}`;
    if (key !== input && exists.get(key)) return key;
  }
  return null;
}
