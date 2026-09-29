import type { AgentDb } from "./ledger.js";

/**
 * 任务队列（5.1）：抓取器投任务，worker 池原子领取。
 * better-sqlite3 是同步 API，单进程内所有语句天然串行——
 * 一条 UPDATE...RETURNING 即原子领取，不存在并发重复取。
 */

export type TaskKind = "judge" | "command" | "report";
export type TaskStatus = "pending" | "running" | "done" | "failed";

export interface Task {
  id: number;
  kind: TaskKind;
  message_id: string | null;
  payload_json: string;
  priority: number;
  status: TaskStatus;
  attempts: number;
  run_after: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

/** 指令任务优先级最高（5.1） */
const PRIORITY: Record<TaskKind, number> = { command: 100, report: 10, judge: 0 };
/** 最大尝试次数：超过标 failed（5.5 的告警面），指数退避 run_after */
const MAX_ATTEMPTS = 3;

export function enqueueTask(
  db: AgentDb,
  kind: TaskKind,
  opts: { messageId?: string; payload?: unknown; runAfter?: Date } = {}
): number {
  const r = db
    .prepare(
      `INSERT INTO tasks (kind, message_id, payload_json, priority, run_after)
       VALUES (?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))`
    )
    .run(
      kind,
      opts.messageId ?? null,
      JSON.stringify(opts.payload ?? {}),
      PRIORITY[kind],
      opts.runAfter ? opts.runAfter.toISOString() : null
    );
  return Number(r.lastInsertRowid);
}

/** 原子领取一条到期任务（优先级降序、同优先级按 id）；没有则 null */
export function claimTask(db: AgentDb): Task | null {
  const row = db
    .prepare(
      `UPDATE tasks SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
              attempts = attempts + 1
       WHERE id = (
         SELECT id FROM tasks
         WHERE status = 'pending' AND run_after <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY priority DESC, id LIMIT 1
       )
       RETURNING *`
    )
    .get() as Task | undefined;
  return row ?? null;
}

export function finishTask(db: AgentDb, id: number): void {
  db.prepare(
    `UPDATE tasks SET status = 'done', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`
  ).run(id);
}

/** 失败：未满 MAX_ATTEMPTS 退避重投，否则标 failed */
export function failTask(db: AgentDb, id: number, error: string): void {
  const row = db.prepare("SELECT attempts FROM tasks WHERE id = ?").get(id) as { attempts: number };
  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE tasks SET status = 'failed', finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), error = ? WHERE id = ?`
    ).run(error, id);
    return;
  }
  // 指数退避：2^attempts 分钟
  const delayMin = 2 ** row.attempts;
  db.prepare(
    `UPDATE tasks SET status = 'pending',
       run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' minutes'), error = ?
     WHERE id = ?`
  ).run(delayMin, error, id);
}

export function taskCounts(db: AgentDb): Record<TaskStatus, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM tasks GROUP BY status").all() as {
    status: TaskStatus;
    n: number;
  }[];
  const out: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/** 持续失败计数（5.5：连续 N 次抓取/处理失败要告警，这里先提供数据面） */
export function recentFailedTasks(db: AgentDb, limit = 20): Task[] {
  return db
    .prepare("SELECT * FROM tasks WHERE status = 'failed' ORDER BY id DESC LIMIT ?")
    .all(limit) as Task[];
}
