import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type AgentDb = Database.Database;

/**
 * agent.db：工具层产物库（与原始邮件索引 mail.db 分开，MAIL-AGENT.md 5.3）。
 * - tool_ledger：工具调用台账，只追加不覆盖，由工具层写、不可绕过（5.3 第三条）
 * - pending_sends：发信闸门的待确认队列（3.7）
 * 5.2 的 judgment / reasoning 届时也进这个库。
 */
export function openAgentDb(dbPath: string): AgentDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function agentDbPath(dataDir: string): string {
  return join(dataDir, "agent.db");
}

function migrate(db: AgentDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      -- 工具名；set_flags 的逐副本明细用 set_flags.copy 另记一行
      tool TEXT NOT NULL,
      ok INTEGER NOT NULL,
      message_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}',
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS tool_ledger_ts ON tool_ledger(id DESC);

    CREATE TABLE IF NOT EXISTS pending_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      to_json TEXT NOT NULL,
      cc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      text TEXT NOT NULL,
      -- 建队时已构造好的 MIME 字节，确认后原样发出（红线 6：SMTP 与 APPEND 同一份）
      mime BLOB NOT NULL,
      message_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',  -- pending / sent / discarded
      decided_at TEXT
    );

    -- 任务队列（5.1：邮件到达即投入；worker 池原子领取）
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,              -- judge / command / report
      message_id TEXT,                 -- judge/command 关联的邮件（库键）
      payload_json TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 0,  -- 指令任务最高（3.6）
      status TEXT NOT NULL DEFAULT 'pending',  -- pending / running / done / failed
      attempts INTEGER NOT NULL DEFAULT 0,
      run_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS tasks_pick ON tasks(status, run_after, priority DESC, id);

    -- 结构化判定（5.2：一封信一行，重判覆盖；必须带模型+提示词版本）
    CREATE TABLE IF NOT EXISTS judgment (
      message_id TEXT PRIMARY KEY,
      verdict TEXT NOT NULL,           -- important / normal / noise
      labels_json TEXT NOT NULL DEFAULT '[]',  -- todo / event / ...
      confidence REAL NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      judged_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    -- 推理记录（5.2：一次处理一行，只追加不覆盖）
    CREATE TABLE IF NOT EXISTS reasoning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      run_kind TEXT NOT NULL,          -- run / followup / rejudge / command / report
      trace TEXT,                      -- 模型真实推理输出（拿得到时）
      summary TEXT,                    -- agent 自述的处理说明（不是证据，字段分开）
      model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      tokens INTEGER,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS reasoning_message ON reasoning(message_id, id DESC);
  `);
}

export interface LedgerRow {
  id: number;
  ts: string;
  tool: string;
  ok: number;
  message_id: string | null;
  detail_json: string;
  error: string | null;
}

/** 台账只追加：账号、对象、前值/后值等明细一律进 detail_json（3.5 / 5.3） */
export function appendLedger(
  db: AgentDb,
  entry: { tool: string; ok: boolean; messageId?: string; detail?: unknown; error?: string }
): void {
  db.prepare(
    "INSERT INTO tool_ledger (tool, ok, message_id, detail_json, error) VALUES (?, ?, ?, ?, ?)"
  ).run(
    entry.tool,
    entry.ok ? 1 : 0,
    entry.messageId ?? null,
    JSON.stringify(entry.detail ?? {}),
    entry.error ?? null
  );
}

/** 台账读取（get_ledger 工具与前端只读视图共用）：按 id 倒序，游标 beforeId */
export function listLedger(db: AgentDb, opts: { limit?: number; beforeId?: number } = {}): LedgerRow[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (opts.beforeId != null) {
    return db
      .prepare("SELECT * FROM tool_ledger WHERE id < ? ORDER BY id DESC LIMIT ?")
      .all(opts.beforeId, limit) as LedgerRow[];
  }
  return db.prepare("SELECT * FROM tool_ledger ORDER BY id DESC LIMIT ?").all(limit) as LedgerRow[];
}

export interface PendingSendRow {
  id: number;
  created_at: string;
  to_json: string;
  cc_json: string;
  subject: string;
  text: string;
  mime: Buffer;
  message_id: string;
  status: string;
  decided_at: string | null;
}

export function insertPendingSend(
  db: AgentDb,
  row: { to: string[]; cc: string[]; subject: string; text: string; mime: Buffer; messageId: string }
): number {
  const r = db
    .prepare(
      "INSERT INTO pending_sends (to_json, cc_json, subject, text, mime, message_id) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(JSON.stringify(row.to), JSON.stringify(row.cc), row.subject, row.text, row.mime, row.messageId);
  return Number(r.lastInsertRowid);
}

export function getPendingSend(db: AgentDb, id: number): PendingSendRow | undefined {
  return db.prepare("SELECT * FROM pending_sends WHERE id = ?").get(id) as PendingSendRow | undefined;
}

/** 列表不含 mime 字节（前端展示用） */
export function listPendingSends(db: AgentDb): Omit<PendingSendRow, "mime">[] {
  return db
    .prepare(
      `SELECT id, created_at, to_json, cc_json, subject, text, message_id, status, decided_at
       FROM pending_sends WHERE status = 'pending' ORDER BY id ASC`
    )
    .all() as Omit<PendingSendRow, "mime">[];
}

export function markPendingSend(db: AgentDb, id: number, status: "sent" | "discarded"): void {
  db.prepare(
    "UPDATE pending_sends SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
  ).run(status, id);
}
