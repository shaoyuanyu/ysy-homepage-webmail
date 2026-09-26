import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import type { Db } from "../../mail/src/db.js";
import { connectAccount } from "../../mail/src/imap.js";
import { syncAccount } from "../../mail/src/fetcher.js";
import { searchMessages } from "../../mail/src/search.js";
import type { AccountCredential } from "../../mail/src/types.js";
import type { CopyRef, FlagChange, SendInput, WebmailAccount } from "./types.js";
import { renderMailHtml } from "./render.js";
import { sendMessage } from "./send.js";
import { deleteUid, moveUid, setFlags } from "./write.js";

/** 前端代理前缀：cid 内联附件重写到这个前缀下（webmaild 自身只绑回环） */
const PUBLIC_PREFIX = process.env.WEBMAIL_PUBLIC_PREFIX ?? "/api/mail";
/** POST body 上限：附件 base64 会膨胀约 1/3，放宽到 40MB */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

export interface SyncState {
  lastSync: string | null;
  lastError: string | null;
}

export interface WebmailContext {
  db: Db;
  dataDir: string;
  accounts: Map<string, WebmailAccount>;
  credentials: Map<string, AccountCredential>;
  remoteImageDomains: string[];
  syncStates: Map<string, SyncState>;
}

interface CopyRow {
  account_id: string;
  folder: string;
  uid: number;
  flags: string;
}

interface MessageRow {
  message_id: string;
  date: string | null;
  from_addr: string | null;
  from_name: string | null;
  to_json: string;
  cc_json: string;
  subject: string | null;
  snippet: string;
  size: number;
  truncated: number;
  eml_path: string;
}

/** 红线 10：同一账号的 IMAP 操作串行（同步与写操作共用一把锁，不会并发开第二条连接） */
const accountLocks = new Map<string, Promise<void>>();

async function withAccountLock<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountLocks.get(accountId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  accountLocks.set(accountId, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (accountLocks.get(accountId) === gate) accountLocks.delete(accountId);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("请求体超过 40MB 上限");
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function copiesOf(ctx: WebmailContext, messageId: string): CopyRow[] {
  return ctx.db
    .prepare("SELECT account_id, folder, uid, flags FROM copies WHERE message_id = ?")
    .all(messageId) as CopyRow[];
}

function messageOf(ctx: WebmailContext, messageId: string): MessageRow | undefined {
  return ctx.db
    .prepare("SELECT * FROM messages WHERE message_id = ?")
    .get(messageId) as MessageRow | undefined;
}

function listItem(ctx: WebmailContext, row: MessageRow) {
  const copies = copiesOf(ctx, row.message_id);
  const seen = copies.length > 0 && copies.every((c) => c.flags.split(" ").includes("\\Seen"));
  const flagged = copies.some((c) => c.flags.split(" ").includes("\\Flagged"));
  return {
    messageId: row.message_id,
    date: row.date,
    subject: row.subject ?? "",
    fromAddr: row.from_addr ?? "",
    fromName: row.from_name ?? "",
    snippet: row.snippet,
    size: row.size,
    truncated: row.truncated === 1,
    seen,
    flagged,
    copies: copies.map((c) => ({ accountId: c.account_id, folder: c.folder, uid: c.uid })),
    accounts: [...new Set(copies.map((c) => c.account_id))],
  };
}

/** 合并视图：跨账号按时间倒序，游标（date, messageId）分页 */
function listMessages(ctx: WebmailContext, url: URL) {
  const account = url.searchParams.get("account");
  const q = url.searchParams.get("q")?.trim();
  const before = url.searchParams.get("before");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  if (q) {
    const hits = searchMessages(ctx.db, q, limit);
    const items = hits
      .map((h) => messageOf(ctx, h.messageId))
      .filter((r): r is MessageRow => !!r)
      .filter((r) => !account || copiesOf(ctx, r.message_id).some((c) => c.account_id === account))
      .map((r) => listItem(ctx, r));
    return { items, next: null };
  }

  const params: unknown[] = [];
  let where = "1=1";
  if (account) {
    where += " AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND c.account_id = ?)";
    params.push(account);
  }
  if (before) {
    const sep = before.indexOf("|");
    if (sep <= 0) throw new Error("before 游标格式非法");
    where += " AND (m.date < ? OR (m.date = ? AND m.message_id < ?))";
    params.push(before.slice(0, sep), before.slice(0, sep), before.slice(sep + 1));
  }
  const rows = ctx.db
    .prepare(`SELECT m.* FROM messages m WHERE ${where} ORDER BY m.date DESC, m.message_id DESC LIMIT ?`)
    .all(...params, limit + 1) as MessageRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = rows.length > limit && last?.date ? `${last.date}|${last.message_id}` : null;
  return { items: page.map((r) => listItem(ctx, r)), next };
}

async function messageDetail(ctx: WebmailContext, messageId: string) {
  const row = messageOf(ctx, messageId);
  if (!row) return null;
  const copies = copiesOf(ctx, messageId);
  const base = { ...listItem(ctx, row), to: JSON.parse(row.to_json), cc: JSON.parse(row.cc_json) };
  if (!row.eml_path) {
    return { ...base, text: "", html: "", attachments: [], remoteBlocked: 0 };
  }
  const raw = readFileSync(join(ctx.dataDir, row.eml_path));
  // keepCidLinks：cid 引用交给 renderMailHtml 的重写管线（统一到附件端点，不内嵌 base64）
  const parsed = await simpleParser(raw, { keepCidLinks: true });
  const attachments = parsed.attachments.map((a, index) => ({
    index,
    filename: a.filename ?? `attachment-${index}`,
    contentType: a.contentType,
    size: a.size,
    cid: a.cid ?? null,
    inline: a.contentDisposition === "inline",
  }));
  const cidResolver = (cid: string): string | null => {
    const hit = parsed.attachments.findIndex((a) => a.cid === cid || a.cid === `<${cid}>`);
    if (hit < 0) return null;
    return `${PUBLIC_PREFIX}/message/${encodeURIComponent(messageId)}/attachment/${hit}`;
  };
  const rendered =
    typeof parsed.html === "string"
      ? renderMailHtml(parsed.html, ctx.remoteImageDomains, cidResolver)
      : { html: "", remoteBlocked: 0 };
  return {
    ...base,
    text: parsed.text ?? "",
    html: rendered.html,
    remoteBlocked: rendered.remoteBlocked,
    attachments,
  };
}

async function attachmentContent(ctx: WebmailContext, messageId: string, index: number) {
  const row = messageOf(ctx, messageId);
  if (!row || !row.eml_path) return null;
  const raw = readFileSync(join(ctx.dataDir, row.eml_path));
  const parsed = await simpleParser(raw);
  const att = parsed.attachments[index];
  if (!att) return null;
  return {
    filename: att.filename ?? `attachment-${index}`,
    contentType: att.contentType,
    content: att.content,
    inline: att.contentDisposition === "inline",
  };
}

/** 标记写回：对该 Message-ID 的所有副本一起写（红线 8），再更新本地索引 */
async function applyFlags(ctx: WebmailContext, messageId: string, change: FlagChange) {
  const copies = copiesOf(ctx, messageId);
  if (copies.length === 0) throw new Error(`消息不存在：${messageId}`);
  const byAccount = new Map<string, CopyRow[]>();
  for (const c of copies) {
    const list = byAccount.get(c.account_id) ?? [];
    list.push(c);
    byAccount.set(c.account_id, list);
  }
  for (const [accountId, rows] of byAccount) {
    const account = ctx.accounts.get(accountId);
    const cred = ctx.credentials.get(accountId);
    if (!account || !cred) throw new Error(`账号未配置：${accountId}`);
    await withAccountLock(accountId, async () => {
      const client = await connectAccount(account, cred);
      try {
        for (const c of rows) {
          await setFlags(client, c.folder, c.uid, change);
        }
      } finally {
        await client.logout().catch(() => {});
      }
    });
    // 服务端写成功后更新本地索引
    for (const c of rows) {
      const flags = new Set(c.flags.split(" ").filter(Boolean));
      if (change.seen === true) flags.add("\\Seen");
      if (change.seen === false) flags.delete("\\Seen");
      if (change.flagged === true) flags.add("\\Flagged");
      if (change.flagged === false) flags.delete("\\Flagged");
      ctx.db
        .prepare("UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?")
        .run([...flags].join(" "), c.account_id, c.folder, c.uid);
    }
  }
  return { updated: copies.length };
}

/** 移动 / 删除：按账号分组逐条执行，成功后本地副本行按「源位置已不存在」处理 */
async function applyCopiesOp(
  ctx: WebmailContext,
  copies: CopyRef[],
  op: "move" | "delete",
  dest?: string
) {
  const byAccount = new Map<string, CopyRef[]>();
  for (const c of copies) {
    const list = byAccount.get(c.accountId) ?? [];
    list.push(c);
    byAccount.set(c.accountId, list);
  }
  let affected = 0;
  for (const [accountId, rows] of byAccount) {
    const account = ctx.accounts.get(accountId);
    const cred = ctx.credentials.get(accountId);
    if (!account || !cred) throw new Error(`账号未配置：${accountId}`);
    await withAccountLock(accountId, async () => {
      const client = await connectAccount(account, cred);
      try {
        for (const c of rows) {
          if (op === "move") {
            if (!dest) throw new Error("move 缺少目标文件夹");
            await moveUid(client, c.folder, c.uid, dest);
          } else {
            await deleteUid(client, c.folder, c.uid);
          }
          affected++;
        }
      } finally {
        await client.logout().catch(() => {});
      }
    });
    // 源位置的副本行删除；目标文件夹由下一轮同步发现
    for (const c of rows) {
      const row = ctx.db
        .prepare("SELECT message_id FROM copies WHERE account_id = ? AND folder = ? AND uid = ?")
        .get(c.accountId, c.folder, c.uid) as { message_id: string } | undefined;
      ctx.db
        .prepare("DELETE FROM copies WHERE account_id = ? AND folder = ? AND uid = ?")
        .run(c.accountId, c.folder, c.uid);
      if (row) {
        const left = ctx.db
          .prepare("SELECT COUNT(*) AS n FROM copies WHERE message_id = ?")
          .get(row.message_id) as { n: number };
        if (left.n === 0) {
          ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run(row.message_id);
          ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(row.message_id);
        }
      }
    }
  }
  return { affected };
}

async function runSync(ctx: WebmailContext, onlyAccount?: string) {
  const results: unknown[] = [];
  for (const account of ctx.accounts.values()) {
    if (!account.enabled) continue;
    if (onlyAccount && account.id !== onlyAccount) continue;
    const cred = ctx.credentials.get(account.id);
    if (!cred) throw new Error(`账号 ${account.id} 缺少凭据`);
    const state: SyncState = ctx.syncStates.get(account.id) ?? { lastSync: null, lastError: null };
    try {
      const r = await withAccountLock(account.id, () =>
        syncAccount(ctx.db, ctx.dataDir, account, cred)
      );
      state.lastSync = new Date().toISOString();
      state.lastError = null;
      results.push(r);
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      ctx.syncStates.set(account.id, state);
      throw err;
    }
    ctx.syncStates.set(account.id, state);
  }
  return results;
}

export function createApiServer(ctx: WebmailContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        return json(res, 200, {
          ok: true,
          accounts: [...ctx.accounts.values()].map((a) => ({
            id: a.id,
            enabled: a.enabled,
            ...(ctx.syncStates.get(a.id) ?? { lastSync: null, lastError: null }),
          })),
        });
      }

      if (req.method === "GET" && path === "/accounts") {
        return json(
          res,
          200,
          [...ctx.accounts.values()].map((a) => ({
            id: a.id,
            displayName: a.displayName,
            email: a.email,
            provider: a.provider,
            color: a.color,
            folders: a.folders,
            enabled: a.enabled,
          }))
        );
      }

      if (req.method === "GET" && path === "/messages") {
        return json(res, 200, listMessages(ctx, url));
      }

      const msgMatch = path.match(/^\/message\/([^/]+)$/);
      if (req.method === "GET" && msgMatch) {
        const detail = await messageDetail(ctx, decodeURIComponent(msgMatch[1]));
        if (!detail) return json(res, 404, { error: "消息不存在" });
        return json(res, 200, detail);
      }

      const attMatch = path.match(/^\/message\/([^/]+)\/attachment\/(\d+)$/);
      if (req.method === "GET" && attMatch) {
        const att = await attachmentContent(ctx, decodeURIComponent(attMatch[1]), Number(attMatch[2]));
        if (!att) return json(res, 404, { error: "附件不存在" });
        res.writeHead(200, {
          "content-type": att.contentType,
          "content-disposition": `${att.inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
        });
        return res.end(att.content);
      }

      if (req.method === "POST" && path === "/send") {
        const input = (await readBody(req)) as SendInput;
        const account = ctx.accounts.get(input.accountId);
        const cred = ctx.credentials.get(input.accountId);
        if (!account || !cred) return json(res, 400, { error: `账号未配置：${input.accountId}` });
        const result = await withAccountLock(account.id, () => sendMessage(account, cred, input));
        return json(res, 200, result);
      }

      if (req.method === "POST" && path === "/flags") {
        const body = (await readBody(req)) as { messageId?: string } & FlagChange;
        if (!body.messageId) return json(res, 400, { error: "缺少 messageId" });
        if (body.seen === undefined && body.flagged === undefined) {
          return json(res, 400, { error: "缺少标记变更（seen / flagged）" });
        }
        return json(res, 200, await applyFlags(ctx, body.messageId, body));
      }

      if (req.method === "POST" && (path === "/move" || path === "/delete")) {
        const body = (await readBody(req)) as { copies?: CopyRef[]; to?: string };
        if (!Array.isArray(body.copies) || body.copies.length === 0) {
          return json(res, 400, { error: "缺少 copies" });
        }
        const op = path === "/move" ? "move" : "delete";
        return json(res, 200, await applyCopiesOp(ctx, body.copies, op, body.to));
      }

      if (req.method === "POST" && path === "/sync") {
        const body = (await readBody(req)) as { accountId?: string };
        return json(res, 200, await runSync(ctx, body.accountId));
      }

      return json(res, 404, { error: `未知端点：${req.method} ${path}` });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: message });
    }
  });
}

export { runSync };
