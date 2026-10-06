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
  };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** 草稿列表（按最近更新倒序）；写信页据此找回「同一原信 / 新建」的最新草稿 */
export function listDrafts(db: Db): Draft[] {
  const rows = db
    .prepare("SELECT * FROM drafts ORDER BY updated_at DESC, id DESC")
    .all() as DraftRow[];
  return rows.map(toDraft);
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
