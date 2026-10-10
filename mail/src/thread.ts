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

/**
 * 会话「根」键（2026-10-10，列表会话聚合用）：把一批邮件各自归到它所在会话的根。
 *
 * 与 `threadMessageIds` 的分工：
 * - 那个做**不动点扩展**（正向 + 反向），返回会话的**全体成员**——详情页的会话区块
 *   用它，代价是要为每封邮件扫一遍 `refs_json`；
 * - 这个只**沿引用链往上走**，返回一个稳定键——列表一页几十封，每封只需几次主键点查。
 *
 * 为什么只走 `refs[0]` 就够了：RFC 5322 要求 References 从**第一封**开始累积，
 * 所以 `refs[0]` 就是根；而只有 In-Reply-To（没有 References）的邮件，`refs[0]` = 父，
 * 继续往上走同样落到根。两条路殊途同归。
 *
 * ⚠ 根可能**不在本地库**（更早的邮件没进同步范围）：那就用那个库外键当会话键——
 *   同一会话的所有回复都指向它，键照样一致。前端只把它当分组用的不透明字符串。
 */
export function threadRootKeys(db: Db, ids: string[]): Map<string, string> {
  const roots = new Map<string, string>();
  if (ids.length === 0) return roots;
  const stmt = db.prepare("SELECT refs_json FROM messages WHERE message_id = ?");
  const cache = new Map<string, string>();

  /** 本封的 References 首环（= 向根方向的下一个）；库里没有、或它自己就是根 → null */
  const firstRef = (id: string): string | null => {
    const row = stmt.get(id) as { refs_json: string | null } | undefined;
    if (!row) return null;
    const refs = JSON.parse(row.refs_json ?? "[]") as string[];
    return refs.length > 0 ? refs[0] : null;
  };

  for (const id of ids) {
    const path: string[] = [];
    let cur = id;
    // 20 层封顶：正常引用链早到根了，这个上限只用来防异常数据成环
    while (!cache.has(cur) && !path.includes(cur) && path.length < 20) {
      path.push(cur);
      const next = firstRef(cur);
      if (!next) break;
      cur = next;
    }
    const root = cache.get(cur) ?? cur;
    for (const k of path) cache.set(k, root);
    roots.set(id, root);
  }
  return roots;
}
