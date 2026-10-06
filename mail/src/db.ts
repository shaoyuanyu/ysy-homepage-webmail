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

    -- 通讯录：手动维护的联系人（自动收录的通信对象不落表，
    -- 由 webmail 侧对 messages 表现算，见 webmail/src/contacts.ts）
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS contacts_email ON contacts(email COLLATE NOCASE);

    -- 草稿（webmail 侧写信页的服务器端自动保存，见 webmail/src/drafts.ts）：
    -- 与 messages 无关的独立表——草稿不参与合并视图 / 未读统计（「草稿」tab
    -- 单独从 /drafts 读，不计入「全部」）
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'new',
      kind_ref TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL DEFAULT '',
      to_text TEXT NOT NULL DEFAULT '',
      cc_text TEXT NOT NULL DEFAULT '',
      bcc_text TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      read_receipt INTEGER NOT NULL DEFAULT 0,
      in_reply_to TEXT NOT NULL DEFAULT '',
      references_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- 服务器镜像（2026-10-06，见 webmail/src/draft-mirror.ts）：草稿同时投递到
      -- 账号服务商的「草稿」文件夹（阿里云 = 草稿），官方网页端才看得到。
      -- server_* 记录镜像副本的位置（uidvalidity 变化时不再按 UID 删除，防误删）；
      -- server_dirty = 1 表示本地更新后尚未同步到服务器（定时扫描处理）。
      server_dirty INTEGER NOT NULL DEFAULT 0,
      server_account TEXT NOT NULL DEFAULT '',
      server_folder TEXT NOT NULL DEFAULT '',
      server_uid INTEGER,
      server_uidvalidity TEXT NOT NULL DEFAULT ''
    );
  `);

  // 草稿服务器镜像列（见上）：ALTER 不走 CREATE IF NOT EXISTS，按列存在性判断
  const draftCols = db.prepare("PRAGMA table_info(drafts)").all() as { name: string }[];
  if (!draftCols.some((c) => c.name === "server_dirty")) {
    db.exec("ALTER TABLE drafts ADD COLUMN server_dirty INTEGER NOT NULL DEFAULT 0");
    db.exec("ALTER TABLE drafts ADD COLUMN server_account TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE drafts ADD COLUMN server_folder TEXT NOT NULL DEFAULT ''");
    db.exec("ALTER TABLE drafts ADD COLUMN server_uid INTEGER");
    db.exec("ALTER TABLE drafts ADD COLUMN server_uidvalidity TEXT NOT NULL DEFAULT ''");
    // 存量草稿一次性标记待投递：它们建于镜像功能上线前，阿里云网页端还看不到
    // （只在本分支执行——全新库的 CREATE TABLE 已带该列，不会走到这里）
    db.exec("UPDATE drafts SET server_dirty = 1");
  }

  // 4.7 会话组装新增列：refs_json（规范化引用链，NULL = 存量行待回填）、
  // has_attach（是否有可下载附件）。ALTER 不走 CREATE IF NOT EXISTS，按列存在性判断。
  const cols = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "refs_json")) {
    db.exec("ALTER TABLE messages ADD COLUMN refs_json TEXT");
  }
  if (!cols.some((c) => c.name === "has_attach")) {
    db.exec("ALTER TABLE messages ADD COLUMN has_attach INTEGER NOT NULL DEFAULT 0");
  }

  // 联系人归属账号（4.14）：'' = 本地联系人（不归属任何账号）。存量行默认为本地。
  const contactCols = db.prepare("PRAGMA table_info(contacts)").all() as { name: string }[];
  if (!contactCols.some((c) => c.name === "account")) {
    db.exec("ALTER TABLE contacts ADD COLUMN account TEXT NOT NULL DEFAULT ''");
  }
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
