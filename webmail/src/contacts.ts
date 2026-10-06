import { randomUUID } from "node:crypto";
import type { Db } from "../../mail/src/db.js";

/** 手动维护的联系人（contacts 表一行） */
export interface Contact {
  id: string;
  name: string;
  email: string;
  note: string;
  /** 归属账号 id；'' = 本地联系人（不归属任何账号），4.14 */
  account: string;
  createdAt: string;
  updatedAt: string;
}

/** 自动收录的通信对象（不落表，从 messages 表现算） */
export interface KnownSender {
  name: string;
  email: string;
  /** 通信次数（该地址出现在 from/to/cc 的消息数） */
  times: number;
  /** 最近一次通信时间（ISO） */
  lastSeen: string | null;
  /** 该地址出现在哪些账号的往来里（4.14 按账号筛选；按来自 copies 表） */
  accounts: string[];
}

interface ContactRow {
  id: string;
  name: string;
  email: string;
  note: string;
  account: string;
  created_at: string;
  updated_at: string;
}

function toContact(row: ContactRow): Contact {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    note: row.note,
    account: row.account ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** 全部联系人：按姓名（空姓名排后、按邮箱）排序；q 过滤姓名/邮箱/备注 */
export function listContacts(db: Db, q?: string): Contact[] {
  const rows = db
    .prepare(
      `SELECT * FROM contacts
       WHERE (? = '' OR name LIKE '%' || ? || '%' OR email LIKE '%' || ? || '%' OR note LIKE '%' || ? || '%')
       ORDER BY (name = ''), name COLLATE NOCASE, email COLLATE NOCASE`
    )
    .all(q ?? "", q ?? "", q ?? "", q ?? "") as ContactRow[];
  return rows.map(toContact);
}

export function getContact(db: Db, id: string): Contact | null {
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as ContactRow | undefined;
  return row ? toContact(row) : null;
}

/** 邮箱 → 联系人名（列表/详情展示覆盖用）；email 大小写不敏感 */
export function contactNameMap(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT email, name FROM contacts WHERE name != ''").all() as {
    email: string;
    name: string;
  }[];
  return new Map(rows.map((r) => [r.email.toLowerCase(), r.name]));
}

export function findContactByEmail(db: Db, email: string): Contact | null {
  const row = db
    .prepare("SELECT * FROM contacts WHERE email = ? COLLATE NOCASE")
    .get(email) as ContactRow | undefined;
  return row ? toContact(row) : null;
}

export function createContact(
  db: Db,
  input: { name?: string; email: string; note?: string; account?: string }
): Contact {
  const email = input.email.trim();
  if (!isValidEmail(email)) throw new ContactError("邮箱地址格式非法");
  if (findContactByEmail(db, email)) throw new ContactError("该邮箱已在通讯录中", 409);
  const now = new Date().toISOString();
  const contact: Contact = {
    id: randomUUID(),
    name: (input.name ?? "").trim(),
    email,
    note: (input.note ?? "").trim(),
    account: (input.account ?? "").trim(),
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    "INSERT INTO contacts (id, name, email, note, account, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(contact.id, contact.name, contact.email, contact.note, contact.account, contact.createdAt, contact.updatedAt);
  return contact;
}

export function updateContact(
  db: Db,
  id: string,
  patch: { name?: string; email?: string; note?: string; account?: string }
): Contact | null {
  const existing = getContact(db, id);
  if (!existing) return null;
  const email = patch.email !== undefined ? patch.email.trim() : existing.email;
  if (!isValidEmail(email)) throw new ContactError("邮箱地址格式非法");
  const dup = findContactByEmail(db, email);
  if (dup && dup.id !== id) throw new ContactError("该邮箱已在通讯录中", 409);
  const next: Contact = {
    ...existing,
    name: patch.name !== undefined ? patch.name.trim() : existing.name,
    email,
    note: patch.note !== undefined ? patch.note.trim() : existing.note,
    account: patch.account !== undefined ? patch.account.trim() : existing.account,
    updatedAt: new Date().toISOString(),
  };
  db.prepare("UPDATE contacts SET name = ?, email = ?, note = ?, account = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    next.email,
    next.note,
    next.account,
    next.updatedAt,
    id
  );
  return next;
}

export function deleteContact(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes > 0;
}

/** 业务错误：status 400 参数非法 / 409 冲突，由 API 层映射为 HTTP 状态码 */
export class ContactError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * 自动收录的通信对象：对 messages 表的 from_addr 与 to_json/cc_json 聚合。
 * 不落表 —— 通讯录只有「手动保存」一种写入，收录永远与邮件数据一致（无回填问题）。
 * 已保存进通讯录的地址默认排除（excludeSaved）。
 */
export function listKnownSenders(
  db: Db,
  opts: { q?: string; limit?: number; excludeSaved?: boolean } = {}
): KnownSender[] {
  const limit = Math.min(opts.limit ?? 50, 200);
  // to_json / cc_json 元素形如 {"name": ..., "address": ...}（见 mail/src/message.ts 入库）
  // accounts 列（4.14）：该地址出现在哪些账号的往来里——LEFT JOIN copies 收集（每封多副本会放大
  // 行，靠 COUNT/GROUP_CONCAT 的 DISTINCT 收敛；LEFT JOIN 是为了不丢掉理论上没有副本的消息）
  const rows = db
    .prepare(
      `WITH addrs AS (
         SELECT m.message_id AS mid, m.date AS date, je.value AS entry
         FROM messages m, json_each(m.to_json) je
         UNION ALL
         SELECT m.message_id, m.date, je.value FROM messages m, json_each(m.cc_json) je
         UNION ALL
         SELECT m.message_id, m.date, json_object('name', m.from_name, 'address', m.from_addr)
         FROM messages m WHERE m.from_addr IS NOT NULL AND m.from_addr != ''
       )
       SELECT
         json_extract(a.entry, '$.address') AS email,
         MAX(json_extract(a.entry, '$.name')) AS name,
         COUNT(DISTINCT a.mid) AS times,
         MAX(a.date) AS last_seen,
         GROUP_CONCAT(DISTINCT c.account_id) AS accounts
       FROM addrs a LEFT JOIN copies c ON c.message_id = a.mid
       WHERE json_extract(a.entry, '$.address') IS NOT NULL AND json_extract(a.entry, '$.address') != ''
       GROUP BY lower(json_extract(a.entry, '$.address'))
       ORDER BY times DESC, last_seen DESC`
    )
    .all() as {
    email: string;
    name: string | null;
    times: number;
    last_seen: string | null;
    accounts: string | null;
  }[];

  const saved = opts.excludeSaved === false ? new Set<string>() : savedEmailSet(db);
  const q = (opts.q ?? "").trim().toLowerCase();
  const out: KnownSender[] = [];
  for (const r of rows) {
    const email = r.email;
    const lower = email.toLowerCase();
    if (saved.has(lower)) continue;
    if (!isValidEmail(email)) continue;
    const name = r.name ?? "";
    if (q && !name.toLowerCase().includes(q) && !lower.includes(q)) continue;
    out.push({
      name,
      email,
      times: r.times,
      lastSeen: r.last_seen,
      accounts: (r.accounts ?? "").split(",").filter(Boolean),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** 已保存邮箱集合（小写） */
function savedEmailSet(db: Db): Set<string> {
  const rows = db.prepare("SELECT email FROM contacts").all() as { email: string }[];
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/** API 层用：带「排除自己账号」的收录查询 */
export function listKnownSendersExcluding(
  db: Db,
  ownEmails: Set<string>,
  opts: { q?: string; limit?: number; excludeSaved?: boolean } = {}
): KnownSender[] {
  // 上限放宽一倍，给「排除自己」留出余量
  const raw = listKnownSenders(db, { ...opts, limit: (opts.limit ?? 50) * 2 });
  return raw.filter((r) => !ownEmails.has(r.email.toLowerCase())).slice(0, opts.limit ?? 50);
}

/** 自动补全建议：已保存联系人在前，自动收录在后，合计 limit 条 */
export function suggestContacts(
  db: Db,
  ownEmails: Set<string>,
  q: string,
  limit = 8
): { contacts: Contact[]; known: KnownSender[] } {
  const query = q.trim();
  if (!query) return { contacts: [], known: [] };
  const contacts = listContacts(db, query).slice(0, limit);
  const known = listKnownSendersExcluding(db, ownEmails, {
    q: query,
    limit: Math.max(0, limit - contacts.length),
  });
  return { contacts, known };
}
