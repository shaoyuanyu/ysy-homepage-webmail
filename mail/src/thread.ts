import type { Db } from "./db.js";

/** 不动点扩展上限（4.7：个人邮箱规模下实际 1~2 轮收敛，5 轮兜底防异常数据死循环） */
const MAX_ROUNDS = 5;
/** 单条会话的返回上限（极端长会话截断，保护前端渲染） */
const MAX_ITEMS = 100;

interface IdRow {
  message_id: string;
}

/**
 * 会话组装（MAIL-AGENT.md 4.7）：以当前信的「引用链 + 自身」为种子集合做不动点扩展——
 * 正向：message_id 落在集合内；反向：refs_json 含集合内任一键。
 * 只做引用链匹配，不做主题启发式（误挂比缺链更糟）。
 * 返回按时间升序的 message_id 列表（当前信之外的成员为空时返回空数组）。
 */
export function threadMessageIds(db: Db, messageId: string): string[] {
  const seed = db
    .prepare("SELECT message_id, refs_json FROM messages WHERE message_id = ?")
    .get(messageId) as { message_id: string; refs_json: string | null } | undefined;
  if (!seed) return [];

  const set = new Set<string>([messageId]);
  for (const k of JSON.parse(seed.refs_json ?? "[]") as string[]) set.add(k);

  for (let round = 0; round < MAX_ROUNDS && set.size < MAX_ITEMS; round++) {
    const keys = [...set];
    const inPlaceholders = keys.map(() => "?").join(",");
    // 反向匹配用带引号的 JSON 元素形式（`"mid:x"`），避免子串误命中（`mid:ab` vs `mid:abc`）
    const likeConditions = keys.map(() => "instr(refs_json, ?) > 0").join(" OR ");
    const rows = db
      .prepare(
        `SELECT message_id FROM messages WHERE message_id IN (${inPlaceholders}) OR ${likeConditions}`
      )
      .all(...keys, ...keys.map((k) => `"${k}"`)) as IdRow[];
    const before = set.size;
    for (const r of rows) set.add(r.message_id);
    if (set.size === before) break;
  }

  const ids = [...set].slice(0, MAX_ITEMS);
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const ordered = db
    .prepare(`SELECT message_id FROM messages WHERE message_id IN (${placeholders}) ORDER BY date ASC, message_id ASC`)
    .all(...ids) as IdRow[];
  return ordered.map((r) => r.message_id);
}
