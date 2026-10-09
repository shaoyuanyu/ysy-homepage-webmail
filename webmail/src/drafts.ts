import { randomUUID } from "node:crypto";
import type { Db } from "../../mail/src/db.js";

/**
 * 服务器端草稿（2026-10-06）：写信页自动保存到 webmaild，草稿箱（/mail 的「草稿」
 * tab）由此渲染。
 *
 * - **与 messages 完全分离**：草稿不参与合并视图、不计入未读/「全部」——「草稿」
 *   是独立视图（用户指定：草稿不算入「全部」）。
 * - `kind` / `kindRef` 用于「从原信再次进入写信页」时找回对应草稿：
 *   new（全新写信，ref 空）/ reply（回复，ref = 原信 messageId）/ forward（转发，ref 同）。
 * - 附件不随草稿保存（体积原因，维持 4.9 的本地草稿语义）：正文与地址串保存原文
 *   （不解析成数组——保真优先，发送解析在写信页与 /send 两端已有）。
 */
export interface Draft {
  id: string;
  kind: "new" | "reply" | "forward";
  kindRef: string;
  accountId: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  readReceipt: boolean;
  inReplyTo: string;
  references: string[];
  createdAt: string;
  updatedAt: string;
  /**
   * 正文/附件是否已从服务器读取（2026-10-10 阶段 1）。
   *
   * 服务商草稿文件夹成为唯一事实源后，列表只用 IMAP `envelope` 就能拼出来（主题 / 收件人 /
   * 时间，便宜），**正文与附件要抓原文**——所以列表里的服务器草稿可能"还没读过内容"：
   * `contentLoaded: false` 时 `body` 是空串（**不是**"这封草稿没有正文"），界面必须区分这两件事。
   */
  contentLoaded: boolean;
  /** 附件清单（读过的服务器草稿才有；站内暂存的草稿为 []）。只读展示 + 保存时原样保留 */
  attachments: { filename: string; contentType: string; size: number }[];
}

export interface DraftInput {
  kind?: string;
  kindRef?: string;
  accountId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  readReceipt?: boolean;
  inReplyTo?: string;
  references?: string[];
}

interface DraftRow {
  id: string;
  kind: string;
  kind_ref: string;
  account_id: string;
  to_text: string;
  cc_text: string;
  bcc_text: string;
  subject: string;
  body: string;
  read_receipt: number;
  in_reply_to: string;
  references_json: string;
  created_at: string;
  updated_at: string;
  server_uid: number | null;
  server_dirty: number;
  server_parsed: number;
  attachments_json: string;
}

const KINDS = new Set(["new", "reply", "forward"]);

function toDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    kind: (KINDS.has(row.kind) ? row.kind : "new") as Draft["kind"],
    kindRef: row.kind_ref,
    accountId: row.account_id,
    to: row.to_text,
    cc: row.cc_text,
    bcc: row.bcc_text,
    subject: row.subject,
    body: row.body,
    readReceipt: row.read_receipt === 1,
    inReplyTo: row.in_reply_to,
    references: JSON.parse(row.references_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // 本地暂存的草稿（还没投递、或投递后又改过）内容就在本地表里 → 一律算"已读取"；
    // 只有"服务器上有、本地只见过 envelope"的那种才需要按需抓原文
    contentLoaded:
      row.server_dirty === 1 || row.server_uid === null || row.server_parsed === 1,
    attachments: JSON.parse(row.attachments_json || "[]") as Draft["attachments"],
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** 草稿列表（按最近更新倒序）；写信页据此找回「同一原信 / 新建」的最新草稿 */
export function listDrafts(db: Db): Draft[] {
  const rows = db
    // ⚠ 必须有 rowid 这个次序键：同一毫秒内建的两条草稿 updated_at 相同，只按 id（随机 uuid）
    //   排序的话先后是随机的——写信页「找回最新草稿」与测试都会因此抖（2026-10-07 实测到）。
    //   rowid 随插入递增、UPDATE 不动它，故「后建的在前」在这里是稳定的正确语义。
    .prepare("SELECT * FROM drafts ORDER BY updated_at DESC, rowid DESC")
    .all() as DraftRow[];
  return rows.map(toDraft);
}

/**
 * 从**本地缓存**里找草稿（写信页的"找回同一原信的最新草稿"用）。
 *
 * ⚠ 故意只读本地、不发 IMAP：写信页是高频入口（写邮件/回复/转发每次都会问一次），
 *   每个账号一次登录的代价不能压在这里。新鲜度由**草稿箱**负责——打开草稿箱会带
 *   `?refresh=1` 去服务商那边对一遍（手机写了一半的回复由此进入缓存）。
 */
export function findDrafts(db: Db, opts: { kind?: string; kindRef?: string }): Draft[] {
  let sql = "SELECT * FROM drafts";
  const params: string[] = [];
  const where: string[] = [];
  if (opts.kind) {
    where.push("kind = ?");
    params.push(opts.kind);
  }
  if (opts.kindRef !== undefined) {
    where.push("kind_ref = ?");
    params.push(opts.kindRef);
  }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY updated_at DESC, rowid DESC";
  return (db.prepare(sql).all(...params) as DraftRow[]).map(toDraft);
}

export function getDraft(db: Db, id: string): Draft | null {
  const row = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return row ? toDraft(row) : null;
}

export function createDraft(db: Db, input: DraftInput): Draft {
  const now = new Date().toISOString();
  const draft: Draft = {
    id: randomUUID(),
    kind: (KINDS.has(str(input.kind)) ? str(input.kind) : "new") as Draft["kind"],
    kindRef: str(input.kindRef),
    accountId: str(input.accountId),
    to: str(input.to),
    cc: str(input.cc),
    bcc: str(input.bcc),
    subject: str(input.subject),
    body: str(input.body),
    readReceipt: input.readReceipt === true,
    inReplyTo: str(input.inReplyTo),
    references: Array.isArray(input.references)
      ? input.references.filter((r): r is string => typeof r === "string")
      : [],
    createdAt: now,
    updatedAt: now,
    contentLoaded: true,
    attachments: [],
  };
  db.prepare(
    `INSERT INTO drafts (id, kind, kind_ref, account_id, to_text, cc_text, bcc_text,
       subject, body, read_receipt, in_reply_to, references_json, created_at, updated_at, server_dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    draft.id,
    draft.kind,
    draft.kindRef,
    draft.accountId,
    draft.to,
    draft.cc,
    draft.bcc,
    draft.subject,
    draft.body,
    draft.readReceipt ? 1 : 0,
    draft.inReplyTo,
    JSON.stringify(draft.references),
    draft.createdAt,
    draft.updatedAt
  );
  return draft;
}

/** 整体替换（写信页每次自动保存提交全部字段）；不存在返回 null */
export function updateDraft(db: Db, id: string, input: DraftInput): Draft | null {
  const existing = getDraft(db, id);
  if (!existing) return null;
  const next: Draft = {
    ...existing,
    kind: KINDS.has(str(input.kind)) ? (str(input.kind) as Draft["kind"]) : existing.kind,
    kindRef: input.kindRef !== undefined ? str(input.kindRef) : existing.kindRef,
    accountId: input.accountId !== undefined ? str(input.accountId) : existing.accountId,
    to: input.to !== undefined ? str(input.to) : existing.to,
    cc: input.cc !== undefined ? str(input.cc) : existing.cc,
    bcc: input.bcc !== undefined ? str(input.bcc) : existing.bcc,
    subject: input.subject !== undefined ? str(input.subject) : existing.subject,
    body: input.body !== undefined ? str(input.body) : existing.body,
    readReceipt: typeof input.readReceipt === "boolean" ? input.readReceipt : existing.readReceipt,
    inReplyTo: input.inReplyTo !== undefined ? str(input.inReplyTo) : existing.inReplyTo,
    references: Array.isArray(input.references)
      ? input.references.filter((r): r is string => typeof r === "string")
      : existing.references,
    updatedAt: new Date().toISOString(),
  };
  db.prepare(
    `UPDATE drafts SET kind = ?, kind_ref = ?, account_id = ?, to_text = ?, cc_text = ?,
       bcc_text = ?, subject = ?, body = ?, read_receipt = ?, in_reply_to = ?,
       references_json = ?, updated_at = ?, server_dirty = 1 WHERE id = ?`
  ).run(
    next.kind,
    next.kindRef,
    next.accountId,
    next.to,
    next.cc,
    next.bcc,
    next.subject,
    next.body,
    next.readReceipt ? 1 : 0,
    next.inReplyTo,
    JSON.stringify(next.references),
    next.updatedAt,
    id
  );
  return next;
}

/** 删除（幂等：不存在返回 false，发送成功后的清理不因草稿已被删而失败） */
export function deleteDraft(db: Db, id: string): boolean {
  return db.prepare("DELETE FROM drafts WHERE id = ?").run(id).changes > 0;
}
