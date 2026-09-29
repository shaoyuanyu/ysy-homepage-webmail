import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { resolveMessageKey, type Db } from "./db.js";
import { getJudgment, type JudgmentRow } from "./judge.js";
import type { AgentDb } from "./ledger.js";
import type { AccountConfig } from "./types.js";

/**
 * `/mail/agent` 只读视图（MAIL-AGENT.md 第八节 第 5 步 / 4.3 / 4.5）：
 * 前端经 maild 的 `/agent/*` 端点读 agent 产物——只查库，无任何写路径。
 * - 时间线 = agent 账号全部副本合并（收 + 发），方向按 from 是否 agent 地址
 * - 详情展示原始邮件：原始头部块 + MIME 结构 + 附件 + text 正文（不渲染 HTML）
 * - 推理只在展开单封信时才拉（5.2），详情里只带计数
 */

export class AgentViewError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

function agentAccount(accounts: AccountConfig[]): AccountConfig {
  const agent = accounts.find((a) => a.isAgent);
  if (!agent) throw new AgentViewError("accounts.json 中没有 isAgent 账号", 500);
  return agent;
}

// ---------- 时间线 ----------

export interface TimelineRow {
  messageId: string;
  date: string;
  direction: "in" | "out";
  subject: string;
  fromAddr: string;
  fromName: string;
  toJson: string;
  snippet: string;
  size: number;
  truncated: boolean;
  folders: string[];
  seen: boolean;
}

export interface TimelinePage {
  items: TimelineRow[];
  /** 下一页游标（`<date>|<messageId>`），没有更多为 null */
  next: string | null;
}

export function agentTimeline(
  db: Db,
  accounts: AccountConfig[],
  opts: { limit?: number; before?: string } = {}
): TimelinePage {
  const agent = agentAccount(accounts);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const agentEmail = agent.email.toLowerCase();

  let cursorSql = "";
  const params: unknown[] = [agent.id];
  if (opts.before) {
    const sep = opts.before.indexOf("|");
    if (sep <= 0) throw new AgentViewError("before 游标格式应为 <date>|<messageId>");
    cursorSql = "AND (m.date < ? OR (m.date = ? AND m.message_id < ?))";
    params.push(opts.before.slice(0, sep), opts.before.slice(0, sep), opts.before.slice(sep + 1));
  }
  params.push(limit + 1);

  const rows = db
    .prepare(
      `SELECT m.message_id, m.date, m.from_addr, m.from_name, m.to_json, m.subject,
              m.snippet, m.size, m.truncated,
              GROUP_CONCAT(c.folder, ' ') AS folders, GROUP_CONCAT(c.flags, ' ') AS flags
       FROM messages m JOIN copies c ON c.message_id = m.message_id
       WHERE c.account_id = ? ${cursorSql}
       GROUP BY m.message_id
       ORDER BY m.date DESC, m.message_id DESC
       LIMIT ?`
    )
    .all(...params)
    .map((r) => {
      const row = r as Record<string, unknown>;
      const fromAddr = String(row.from_addr ?? "");
      return {
        messageId: String(row.message_id),
        date: String(row.date),
        direction: (fromAddr.toLowerCase() === agentEmail ? "out" : "in") as "in" | "out",
        subject: String(row.subject ?? ""),
        fromAddr,
        fromName: String(row.from_name ?? ""),
        toJson: String(row.to_json),
        snippet: String(row.snippet ?? ""),
        size: Number(row.size),
        truncated: row.truncated === 1,
        folders: String(row.folders ?? "").split(" ").filter(Boolean),
        seen: String(row.flags ?? "").includes("\\Seen"),
      } satisfies TimelineRow;
    });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, next: hasMore && last ? `${last.date}|${last.messageId}` : null };
}

// ---------- 邮件详情（原始邮件视角） ----------

export interface PartInfo {
  kind: "text" | "html" | "attachment";
  contentType: string;
  size: number;
  filename?: string;
}

export interface Rfc822Ref {
  /** 附件数组下标（/rfc822/<index> 的定位键） */
  index: number;
  filename?: string;
  size: number;
}

export interface ParsedView {
  /** 原始头部块（折行保持原样——排查要看的就是头部原文） */
  headersRaw: string;
  subject: string;
  from: string;
  date: string | null;
  messageId: string | null;
  parts: PartInfo[];
  /** text/plain 原文；只有 HTML 时是 strip 后的纯文本（本入口不渲染 HTML，4.4） */
  text: string;
  rfc822: Rfc822Ref[];
}

function addrText(v: AddressObject | AddressObject[] | undefined): string {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list
    .flatMap((a) => a.value)
    .map((a) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? "")))
    .filter(Boolean)
    .join(", ");
}

function stripHtml(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} });
}

/** ParsedMail → 展示结构（正文/附件/rfc822 引用）；主邮件与 rfc822 展开共用 */
function describeParsed(parsed: ParsedMail): ParsedView {
  const parts: PartInfo[] = [];
  const rfc822: Rfc822Ref[] = [];
  const hasText = typeof parsed.text === "string" && parsed.text.length > 0;
  const hasHtml = typeof parsed.html === "string" && parsed.html.length > 0;
  if (hasText) parts.push({ kind: "text", contentType: "text/plain", size: Buffer.byteLength(parsed.text as string) });
  if (hasHtml) parts.push({ kind: "html", contentType: "text/html", size: Buffer.byteLength(parsed.html as string) });
  parsed.attachments.forEach((a, i) => {
    parts.push({
      kind: "attachment",
      contentType: a.contentType,
      size: a.size,
      ...(a.filename ? { filename: a.filename } : {}),
    });
    if (a.contentType === "message/rfc822") {
      rfc822.push({ index: i, ...(a.filename ? { filename: a.filename } : {}), size: a.size });
    }
  });
  return {
    headersRaw: parsed.headerLines.map((h) => h.line).join("\n"),
    subject: parsed.subject ?? "",
    from: addrText(parsed.from),
    date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId ?? null,
    parts,
    text: hasText ? (parsed.text as string) : hasHtml ? stripHtml(parsed.html as string) : "",
    rfc822,
  };
}

export interface AgentMessageDetail extends ParsedView {
  messageId: string;
  direction: "in" | "out";
  truncated: boolean;
  copies: { accountId: string; folder: string; uid: number; flags: string }[];
  judgment: JudgmentRow | null;
  /** 推理行数（本体经 /agent/reasoning 按需拉取，5.2） */
  reasoningCount: number;
}

interface MessageRow {
  message_id: string;
  eml_path: string;
  truncated: number;
}

/** 取库行且要求该信确实在 agent 账号里有副本（本入口 = agent 视角） */
function requireAgentMessage(db: Db, accounts: AccountConfig[], input: string): MessageRow {
  const agent = agentAccount(accounts);
  const key = resolveMessageKey(db, input);
  if (!key) throw new AgentViewError(`索引里不存在该邮件：${input}`, 404);
  const copy = db
    .prepare("SELECT 1 AS x FROM copies WHERE account_id = ? AND message_id = ? LIMIT 1")
    .get(agent.id, key);
  if (!copy) throw new AgentViewError("该邮件不在 agent 账号的收录范围内", 404);
  return db.prepare("SELECT message_id, eml_path, truncated FROM messages WHERE message_id = ?").get(key) as MessageRow;
}

function readEml(dataDir: string, row: MessageRow): Buffer {
  if (row.truncated === 1 || !row.eml_path) {
    throw new AgentViewError("该邮件超阈值只存了元数据，原文未留存", 404);
  }
  return readFileSync(join(dataDir, row.eml_path));
}

export async function agentMessage(
  db: Db,
  agentDb: AgentDb,
  dataDir: string,
  accounts: AccountConfig[],
  input: string
): Promise<AgentMessageDetail> {
  const agent = agentAccount(accounts);
  const row = requireAgentMessage(db, accounts, input);
  const view = describeParsed(await simpleParser(readEml(dataDir, row)));
  const copies = db
    .prepare("SELECT account_id, folder, uid, flags FROM copies WHERE message_id = ? ORDER BY account_id, folder")
    .all(row.message_id)
    .map((c) => {
      const r = c as Record<string, unknown>;
      return {
        accountId: String(r.account_id),
        folder: String(r.folder),
        uid: Number(r.uid),
        flags: String(r.flags ?? ""),
      };
    });
  return {
    ...view,
    messageId: row.message_id,
    direction: view.from.toLowerCase().includes(agent.email.toLowerCase()) ? "out" : "in",
    truncated: false,
    copies,
    judgment: getJudgment(agentDb, row.message_id) ?? null,
    reasoningCount: (
      agentDb.prepare("SELECT COUNT(*) AS n FROM reasoning WHERE message_id = ?").get(row.message_id) as { n: number }
    ).n,
  };
}

/** .eml 原件下载 */
export function agentMessageEml(
  db: Db,
  dataDir: string,
  accounts: AccountConfig[],
  input: string
): { body: Buffer; filename: string } {
  const row = requireAgentMessage(db, accounts, input);
  return { body: readEml(dataDir, row), filename: `${row.message_id.replace(/[^\w.-]+/g, "_")}.eml` };
}

/** 就地展开 message/rfc822 附件（4.3：汇报里附的原始邮件当场可核） */
export async function agentMessageRfc822(
  db: Db,
  dataDir: string,
  accounts: AccountConfig[],
  input: string,
  index: number
): Promise<ParsedView> {
  const row = requireAgentMessage(db, accounts, input);
  const parsed = await simpleParser(readEml(dataDir, row));
  const att = parsed.attachments[index];
  if (!att) throw new AgentViewError(`附件 #${index} 不存在`, 404);
  if (att.contentType !== "message/rfc822") {
    throw new AgentViewError(`附件 #${index} 不是 message/rfc822（${att.contentType}）`);
  }
  return describeParsed(await simpleParser(att.content));
}

// ---------- 判定与推理 ----------

export interface JudgmentListRow extends JudgmentRow {
  subject: string | null;
  from_addr: string | null;
  date: string | null;
}

export function agentJudgments(
  agentDb: AgentDb,
  db: Db,
  opts: { limit?: number; before?: string } = {}
): { items: JudgmentListRow[]; next: string | null } {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let cursorSql = "";
  const params: unknown[] = [];
  if (opts.before) {
    const sep = opts.before.indexOf("|");
    if (sep <= 0) throw new AgentViewError("before 游标格式应为 <judged_at>|<message_id>");
    cursorSql = "WHERE judged_at < ? OR (judged_at = ? AND message_id < ?)";
    params.push(opts.before.slice(0, sep), opts.before.slice(0, sep), opts.before.slice(sep + 1));
  }
  params.push(limit + 1);
  const rows = agentDb
    .prepare(`SELECT * FROM judgment ${cursorSql} ORDER BY judged_at DESC, message_id DESC LIMIT ?`)
    .all(...params) as JudgmentRow[];

  const meta = db.prepare("SELECT subject, from_addr, date FROM messages WHERE message_id = ?");
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows).map((j) => {
    const m = meta.get(j.message_id) as { subject: string; from_addr: string; date: string } | undefined;
    return { ...j, subject: m?.subject ?? null, from_addr: m?.from_addr ?? null, date: m?.date ?? null };
  });
  const last = items[items.length - 1];
  return { items, next: hasMore && last ? `${last.judged_at}|${last.message_id}` : null };
}

export interface ReasoningRow {
  id: number;
  message_id: string | null;
  run_kind: string;
  trace: string | null;
  summary: string | null;
  model: string;
  prompt_version: string;
  tokens: number | null;
  started_at: string;
  finished_at: string;
}

/** 该消息的全部推理行（5.2：只在展开单封信时才拉） */
export function agentReasoning(agentDb: AgentDb, input: string): ReasoningRow[] {
  return agentDb
    .prepare("SELECT * FROM reasoning WHERE message_id = ? ORDER BY id ASC")
    .all(input) as ReasoningRow[];
}
