import type { Db } from "./db.js";

export interface SearchHit {
  messageId: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  date: string | null;
  snippet: string;
  accounts: string[];
}

interface MessageRow {
  message_id: string;
  subject: string | null;
  from_addr: string | null;
  from_name: string | null;
  date: string | null;
  snippet: string;
  accounts: string | null;
}

/**
 * 模糊搜索：3 个字符以上走 trigram FTS（子串命中）；
 * 1~2 个字符的查询在 trigram 索引下静默返回空，走 LIKE 兜底（6.1 实测结论）。
 */
export function searchMessages(db: Db, query: string, limit = 50): SearchHit[] {
  const q = query.trim();
  if (q.length === 0) return [];

  const rows = (
    q.length >= 3
      ? db
          .prepare("SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?")
          .all(quoteFts(q), limit)
      : db
          .prepare(
            `SELECT message_id FROM messages_fts
             WHERE subject LIKE ? OR from_text LIKE ? OR to_text LIKE ? OR body LIKE ? LIMIT ?`
          )
          .all(like(q), like(q), like(q), like(q), limit)
  ) as { message_id: string }[];

  const detail = db.prepare(
    `SELECT m.message_id, m.subject, m.from_addr, m.from_name, m.date, m.snippet,
            (SELECT GROUP_CONCAT(DISTINCT c.account_id) FROM copies c WHERE c.message_id = m.message_id) AS accounts
     FROM messages m WHERE m.message_id = ?`
  );

  const hits: SearchHit[] = [];
  for (const { message_id } of rows) {
    const r = detail.get(message_id) as MessageRow | undefined;
    if (!r) continue;
    hits.push({
      messageId: r.message_id,
      subject: r.subject ?? "",
      fromAddr: r.from_addr ?? "",
      fromName: r.from_name ?? "",
      date: r.date,
      snippet: r.snippet,
      accounts: r.accounts ? r.accounts.split(",") : [],
    });
  }
  return hits;
}

/** 双引号包成短语查询，内部引号双写转义（trigram 下短语即连续子串） */
function quoteFts(q: string): string {
  return `"${q.replace(/"/g, '""')}"`;
}

function like(q: string): string {
  return `%${q}%`;
}
