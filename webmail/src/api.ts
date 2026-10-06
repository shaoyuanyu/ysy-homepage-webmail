import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import type { Db } from "../../mail/src/db.js";
import { connectAccount } from "../../mail/src/imap.js";
import { syncAccount } from "../../mail/src/fetcher.js";
import { searchMessages } from "../../mail/src/search.js";
import { threadMessageIds } from "../../mail/src/thread.js";
import type { AccountCredential } from "../../mail/src/types.js";
import type { CopyRef, FlagChange, SendInput, WebmailAccount } from "./types.js";
import {
  ContactError,
  contactNameMap,
  createContact,
  deleteContact,
  findContactByEmail,
  listContacts,
  listKnownSendersExcluding,
  suggestContacts,
  updateContact,
} from "./contacts.js";
import { AccountError, addAccount, deleteAccount, setRemoteImageDomains, updateAccount, type AddAccountInput, type UpdateAccountInput } from "./accounts.js";
import { deleteServerDraftCopy, readDraftServerRef } from "./draft-mirror.js";
import { createDraft, deleteDraft, listDrafts, updateDraft, type DraftInput } from "./drafts.js";
import { withAccountLock } from "./locks.js";
import { renderMailHtml } from "./render.js";
import { sendMessage } from "./send.js";
import { deleteUid, isSentFolderName, moveUid, SENT_FOLDER_NAMES, setFlags, setSeenBatch } from "./write.js";

/** 前端代理前缀：cid 内联附件重写到这个前缀下（webmaild 自身只绑回环） */
const PUBLIC_PREFIX = process.env.WEBMAIL_PUBLIC_PREFIX ?? "/api/mail";
/** POST body 上限：附件 base64 会膨胀约 1/3，放宽到 40MB */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

export interface SyncState {
  lastSync: string | null;
  lastError: string | null;
  /** 上次本轮同步实际抓进新邮件的时刻（fetched > 0 才刷新）；安静期保持不变 */
  lastNewMail: string | null;
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
  refs_json: string | null;
  has_attach: number;
}

// 红线 10（同一账号的 IMAP 操作串行）的锁在 locks.ts——新增草稿镜像模块后，
// api 与 draft-mirror 都要用它，放这里会形成循环 import

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

function listItem(ctx: WebmailContext, row: MessageRow, names?: Map<string, string>) {
  const copies = copiesOf(ctx, row.message_id);
  const seen = copies.length > 0 && copies.every((c) => c.flags.split(" ").includes("\\Seen"));
  const flagged = copies.some((c) => c.flags.split(" ").includes("\\Flagged"));
  return {
    messageId: row.message_id,
    date: row.date,
    subject: row.subject ?? "",
    fromAddr: row.from_addr ?? "",
    // 通讯录里存过该发件人时，优先显示通讯录里的名字
    fromName: names?.get((row.from_addr ?? "").toLowerCase()) ?? row.from_name ?? "",
    // 收件人列表：列表行对发件邮件显示「发给 X」（4.9），详情页的 To 行也用它
    to: JSON.parse(row.to_json) as { name?: string; address?: string }[],
    snippet: row.snippet,
    size: row.size,
    truncated: row.truncated === 1,
    seen,
    flagged,
    hasAttach: row.has_attach === 1,
    copies: copies.map((c) => ({ accountId: c.account_id, folder: c.folder, uid: c.uid })),
    accounts: [...new Set(copies.map((c) => c.account_id))],
  };
}

/** 标记匹配统一用「两侧补空格后整词匹配」，避免 `\Seen` 被子串误伤（与 listItem 的 split 口径一致） */
const HAS_SEEN_SQL = "instr(' ' || c.flags || ' ', ' \\Seen ') > 0";
const HAS_FLAGGED_SQL = "instr(' ' || c.flags || ' ', ' \\Flagged ') > 0";

/**
 * 状态 / 方向筛选（4.2、4.9），两个维度互相独立、可组合：
 * - `filter`（状态）：逗号分隔多值（2026-10-04 起）——`unseen` = 存在任一副本无 `\Seen`；
 *   `flagged` = 存在任一副本有 `\Flagged`。多值取交集（`unseen,flagged` = 未读且加星，
 *   前端「星标」视图 + 「未读」开关需要这种组合）；单值写法不变。
 * - `direction`（方向）：`received` = 存在 INBOX 副本（收到的）；`sent` = 副本**全部**在
 *   「已发送」类文件夹（我发出的）
 *
 * ⚠ `sent` 的口径必须与前端 `isSentItem`（`lib/mail/kind.ts`）完全一致，
 * 否则会出现「筛出来不对」的矛盾；两边共用同一份文件夹名名单（各持一份，改动同步）。
 */
function matchFilter(
  ctx: WebmailContext,
  messageId: string,
  filter: string | null,
  direction: string | null,
): boolean {
  const filters = new Set((filter ?? "").split(",").filter(Boolean));
  if (!filters.size && !direction) return true;
  const copies = copiesOf(ctx, messageId);
  if (filters.has("unseen") && !copies.some((c) => !c.flags.split(" ").includes("\\Seen"))) return false;
  if (filters.has("flagged") && !copies.some((c) => c.flags.split(" ").includes("\\Flagged"))) return false;
  if (direction === "received" && !copies.some((c) => c.folder.trim().toUpperCase() === "INBOX")) return false;
  if (direction === "sent" && !(copies.length > 0 && copies.every((c) => isSentFolderName(c.folder)))) return false;
  return true;
}

/**
 * 合并视图：跨账号按时间倒序，游标（date, messageId）分页。
 * `account` 支持逗号分隔多值（2026-10-05 起，多选账号筛选取**并集**；单值写法不变）。
 */
function listMessages(ctx: WebmailContext, url: URL) {
  const accountIds = (url.searchParams.get("account") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const q = url.searchParams.get("q")?.trim();
  const before = url.searchParams.get("before");
  const filter = url.searchParams.get("filter");
  const direction = url.searchParams.get("direction");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);
  const names = contactNameMap(ctx.db);

  if (q) {
    const hits = searchMessages(ctx.db, q, limit);
    const items = hits
      .map((h) => messageOf(ctx, h.messageId))
      .filter((r): r is MessageRow => !!r)
      .filter(
        (r) =>
          !accountIds.length ||
          copiesOf(ctx, r.message_id).some((c) => accountIds.includes(c.account_id)),
      )
      .filter((r) => matchFilter(ctx, r.message_id, filter, direction))
      .map((r) => listItem(ctx, r, names));
    return { items, next: null };
  }

  const params: unknown[] = [];
  let where = "1=1";
  if (accountIds.length) {
    where += ` AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND c.account_id IN (${accountIds.map(() => "?").join(", ")}))`;
    params.push(...accountIds);
  }
  // filter 支持逗号分隔多值（交集语义，与 matchFilter 的 JS 路径同口径）
  const filters = new Set((filter ?? "").split(",").filter(Boolean));
  if (filters.has("unseen")) {
    where += ` AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND NOT ${HAS_SEEN_SQL})`;
  }
  if (filters.has("flagged")) {
    where += ` AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND ${HAS_FLAGGED_SQL})`;
  }
  if (direction === "received") {
    where += " AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND upper(trim(c.folder)) = 'INBOX')";
  } else if (direction === "sent") {
    // 副本全在「已发送」类文件夹：至少有一个副本，且不存在任何不在名单内的副本
    // （⚠ 与 matchFilter 的 JS 路径同口径；SQLite 的 lower/upper 只处理 ASCII，
    //   中文文件夹名不受影响——名字本来就无大小写）
    const placeholders = SENT_FOLDER_NAMES.map(() => "?").join(", ");
    where += " AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id)";
    where += ` AND NOT EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND lower(trim(c.folder)) NOT IN (${placeholders}))`;
    params.push(...SENT_FOLDER_NAMES.map((n) => n.toLowerCase()));
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
  return { items: page.map((r) => listItem(ctx, r, names)), next };
}

async function messageDetail(ctx: WebmailContext, messageId: string) {
  const row = messageOf(ctx, messageId);
  if (!row) return null;
  const base = {
    ...listItem(ctx, row, contactNameMap(ctx.db)),
    cc: JSON.parse(row.cc_json),
    // 引用链（4.7）：回复时带上，自己发出的信才能继续挂进会话
    refs: JSON.parse(row.refs_json ?? "[]") as string[],
    // 发件人是否已在通讯录（详情页「存入通讯录」按钮态）
    fromContactId: row.from_addr ? (findContactByEmail(ctx.db, row.from_addr)?.id ?? null) : null,
  };
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

/**
 * 批量标已读（2026-10-05，供 /mail 的「全部标为已读」）：
 * 把**范围内可见的未读消息**的每个缺 \Seen 副本补上 \Seen。
 *
 * 口径与列表一致：「消息级未读」= 存在任一副本缺 \Seen（`listItem.seen` / `filter=unseen`
 * 的 EXISTS 口径）——要让它变成已读，就把每个缺 \Seen 的副本都写上（含范围外账号的
 * 副本，与单条 `applyFlags` 的「所有副本一起写」同一条红线 8）。
 *
 * 范围 = `accountIds`（空 = 全部账号）：只计入「至少有一个副本落在这些账号里」的消息。
 * 方向 / 搜索 / 星标不参与——未读本质是收件箱概念，「全部已读」按账号范围清最为直觉。
 *
 * 性能：所选副本按账号分组、账号内再按文件夹分组，**每文件夹一次 STORE**（见 setSeenBatch），
 * 每账号一次连接。单账号失败只记 skipped，不阻断其它账号（与批量写操作的整体风格一致）。
 */
async function markAllRead(ctx: WebmailContext, accountIds: string[]) {
  const params: unknown[] = [];
  let scope = "";
  if (accountIds.length) {
    scope = ` AND EXISTS (SELECT 1 FROM copies cs WHERE cs.message_id = c.message_id AND cs.account_id IN (${accountIds.map(() => "?").join(", ")}))`;
    params.push(...accountIds);
  }
  const rows = ctx.db
    .prepare(
      `SELECT c.account_id, c.folder, c.uid, c.message_id FROM copies c
       WHERE instr(' ' || c.flags || ' ', ' \\Seen ') = 0${scope}`,
    )
    .all(...params) as { account_id: string; folder: string; uid: number; message_id: string }[];

  const result: { updated: number; messages: number; skipped: { account: string; folder: string; uid: number; reason: string }[] } = {
    updated: 0,
    messages: new Set(rows.map((r) => r.message_id)).size,
    skipped: [],
  };

  const byAccount = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }

  for (const [accountId, list] of byAccount) {
    const account = ctx.accounts.get(accountId);
    const cred = ctx.credentials.get(accountId);
    if (!account || !cred) {
      result.skipped.push(...list.map((r) => ({ account: accountId, folder: r.folder, uid: r.uid, reason: "账号或凭据缺失" })));
      continue;
    }
    await withAccountLock(accountId, async () => {
      const client = await connectAccount(account, cred);
      try {
        const byFolder = new Map<string, number[]>();
        for (const r of list) {
          const uids = byFolder.get(r.folder) ?? [];
          uids.push(r.uid);
          byFolder.set(r.folder, uids);
        }
        for (const [folder, uids] of byFolder) {
          try {
            await setSeenBatch(client, folder, uids);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            result.skipped.push(...uids.map((uid) => ({ account: accountId, folder, uid, reason })));
            continue;
          }
          // 服务端写成功后更新本地索引（与服务端一致的「加 \Seen」语义）
          const upd = ctx.db.prepare(
            "UPDATE copies SET flags = trim(flags || ' \\Seen') WHERE account_id = ? AND folder = ? AND uid = ?",
          );
          for (const uid of uids) {
            upd.run(accountId, folder, uid);
            result.updated++;
          }
        }
      } finally {
        await client.logout().catch(() => {});
      }
    });
  }
  return result;
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
    const state: SyncState = ctx.syncStates.get(account.id) ?? { lastSync: null, lastError: null, lastNewMail: null };
    try {
      const r = await withAccountLock(account.id, () =>
        syncAccount(ctx.db, ctx.dataDir, account, cred)
      );
      const now = new Date().toISOString();
      state.lastSync = now;
      state.lastError = null;
      // 本轮确实抓进新邮件才刷新 lastNewMail——「上次收到新邮件」的语义，
      // 与「同步循环还活着」（lastSync，60s 一轮恒新鲜）分开（5.5）
      if (r.some((x) => x.fetched > 0)) state.lastNewMail = now;
      // 进程重启后内存态丢失：用库里最新一封的日期兜底初始化，
      // 否则重启后要干等下一封新邮件才显示得出时间
      if (!state.lastNewMail) {
        const row = ctx.db
          .prepare(
            "SELECT MAX(m.date) AS d FROM messages m JOIN copies c ON c.message_id = m.message_id WHERE c.account_id = ?"
          )
          .get(account.id) as { d: string | null };
        state.lastNewMail = row.d ?? null;
      }
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
            ...(ctx.syncStates.get(a.id) ?? { lastSync: null, lastError: null, lastNewMail: null }),
          })),
        });
      }

      if (req.method === "GET" && path === "/accounts") {
        // 未读数口径（4.2）：只算 INBOX 中无 \Seen 的副本——「已发送」等文件夹不计
        const unreadStmt = ctx.db.prepare(
          `SELECT COUNT(*) AS n FROM copies c WHERE c.account_id = ? AND c.folder = 'INBOX' AND NOT ${HAS_SEEN_SQL}`
        );
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
            // 发件人姓名（随邮件发出的 From 显示名；与备注名 displayName 区分，2026-10-06）
            senderName: a.senderName ?? "",
            // 连接字段（账号管理弹窗的编辑表单预填；**不含密码**，密码只写不读）
            imapHost: a.imapHost,
            imapPort: a.imapPort,
            imapSecure: a.imapSecure,
            smtpHost: a.smtpHost,
            smtpPort: a.smtpPort,
            smtpSecure: a.smtpSecure,
            username: ctx.credentials.get(a.id)?.username ?? "",
            unread: (unreadStmt.get(a.id) as { n: number }).n,
          }))
        );
      }

      // 新增账号：先连接测试（IMAP 登录 + SMTP verify）通过才落盘
      if (req.method === "POST" && path === "/accounts") {
        const body = (await readBody(req)) as AddAccountInput;
        return json(res, 201, await addAccount(ctx, body));
      }

      // 远程图片白名单（4.4）：全局设置，账号管理弹窗里维护；写后即时生效
      if (req.method === "GET" && path === "/remote-image-domains") {
        return json(res, 200, { domains: ctx.remoteImageDomains });
      }
      if (req.method === "PUT" && path === "/remote-image-domains") {
        const body = (await readBody(req)) as { domains?: unknown } | undefined;
        return json(res, 200, setRemoteImageDomains(ctx, body?.domains));
      }

      const accountMatch = path.match(/^\/accounts\/([^/]+)$/);
      if (accountMatch && req.method === "DELETE") {
        return json(res, 200, deleteAccount(ctx, decodeURIComponent(accountMatch[1])));
      }
      // 修改账号（2026-10-06）：备注名 / 发件人姓名 / 连接字段；连接字段变了先做连接测试
      if (accountMatch && req.method === "PUT") {
        const body = (await readBody(req)) as UpdateAccountInput;
        return json(res, 200, await updateAccount(ctx, decodeURIComponent(accountMatch[1]), body));
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

      const threadMatch = path.match(/^\/message\/([^/]+)\/thread$/);
      if (req.method === "GET" && threadMatch) {
        const id = decodeURIComponent(threadMatch[1]);
        if (!messageOf(ctx, id)) return json(res, 404, { error: "消息不存在" });
        const names = contactNameMap(ctx.db);
        const items = threadMessageIds(ctx.db, id)
          .map((mid) => messageOf(ctx, mid))
          .filter((r): r is MessageRow => !!r)
          .map((r) => listItem(ctx, r, names));
        return json(res, 200, { current: id, items });
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
        // 来自草稿的发送：成功后删除该草稿（幂等；失败不拦——发送已成功）。
        // 服务器镜像副本同步清理（2026-10-06）：先读位置再删本地行；清理失败只记日志
        // （草稿已发出，不能因为清理失败而报错；阿里云侧最多留一个手动可删的副本）。
        if (input.draftId) {
          const ref = readDraftServerRef(ctx.db, input.draftId);
          deleteDraft(ctx.db, input.draftId);
          if (ref && ref.uid !== null) {
            deleteServerDraftCopy(ctx, ref).catch((err) =>
              console.error("[webmaild] 发送后清理服务器草稿副本失败：", err instanceof Error ? err.message : err)
            );
          }
        }
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

      if (req.method === "POST" && path === "/mark-all-read") {
        const body = (await readBody(req)) as { accounts?: unknown };
        const accounts = Array.isArray(body.accounts)
          ? body.accounts.filter((a): a is string => typeof a === "string" && a.length > 0)
          : [];
        return json(res, 200, await markAllRead(ctx, accounts));
      }

      if (req.method === "POST" && (path === "/move" || path === "/delete")) {
        const body = (await readBody(req)) as { copies?: CopyRef[]; to?: string };
        if (!Array.isArray(body.copies) || body.copies.length === 0) {
          return json(res, 400, { error: "缺少 copies" });
        }
        const op = path === "/move" ? "move" : "delete";
        return json(res, 200, await applyCopiesOp(ctx, body.copies, op, body.to));
      }

      if (req.method === "GET" && path === "/contacts") {
        const q = url.searchParams.get("q")?.trim() ?? "";
        return json(res, 200, { items: listContacts(ctx.db, q) });
      }

      // ---- 草稿（2026-10-06）：写信页自动保存 / 草稿箱 ----
      // 列表（按最近更新倒序）：写信页据此找回同一原信 / 新建的最新草稿
      if (req.method === "GET" && path === "/drafts") {
        return json(res, 200, { items: listDrafts(ctx.db) });
      }
      if (req.method === "POST" && path === "/drafts") {
        const body = (await readBody(req)) as DraftInput;
        return json(res, 201, createDraft(ctx.db, body ?? {}));
      }
      const draftMatch = path.match(/^\/drafts\/([^/]+)$/);
      if (draftMatch && req.method === "PUT") {
        const body = (await readBody(req)) as DraftInput;
        const updated = updateDraft(ctx.db, decodeURIComponent(draftMatch[1]), body ?? {});
        if (!updated) return json(res, 404, { error: "草稿不存在" });
        return json(res, 200, updated);
      }
      if (draftMatch && req.method === "DELETE") {
        const id = decodeURIComponent(draftMatch[1]);
        // 服务器镜像副本先删（2026-10-06）：本地删掉后就没地方查 UID 了。
        // 真失败（网络/认证）→ 502 且**保留本地草稿**（用户可重试，两端不出现
        // 「本地没了、阿里云还在」的漂移）；uidvalidity 变化（邮箱被重建、不能按
        // 旧 UID 安全删）与从未投递过不算失败，照常删本地。
        const ref = readDraftServerRef(ctx.db, id);
        if (ref) {
          const r = await deleteServerDraftCopy(ctx, ref);
          if (!r.deleted && r.reason !== "never-mirrored" && r.reason !== "uidvalidity" && r.reason !== "account-missing") {
            return json(res, 502, { error: `服务器草稿删除失败：${r.reason ?? "未知"}` });
          }
        }
        deleteDraft(ctx.db, id);
        return json(res, 200, { ok: true });
      }

      // 自动收录：通信过但未保存进通讯录的地址（按频次排序，排除自己各账号）
      if (req.method === "GET" && path === "/contacts/known") {
        const own = new Set([...ctx.accounts.values()].map((a) => a.email.toLowerCase()));
        const items = listKnownSendersExcluding(ctx.db, own, {
          q: url.searchParams.get("q") ?? "",
          limit: Number(url.searchParams.get("limit") ?? 50) || 50,
        });
        return json(res, 200, { items });
      }

      // 写信自动补全：已保存联系人在前，自动收录在后
      if (req.method === "GET" && path === "/contacts/suggest") {
        const own = new Set([...ctx.accounts.values()].map((a) => a.email.toLowerCase()));
        return json(res, 200, suggestContacts(ctx.db, own, url.searchParams.get("q") ?? ""));
      }

      if (req.method === "POST" && path === "/contacts") {
        const body = (await readBody(req)) as { name?: string; email?: string; note?: string; account?: string };
        if (!body.email?.trim()) return json(res, 400, { error: "缺少 email" });
        return json(res, 201, createContact(ctx.db, { name: body.name, email: body.email, note: body.note, account: body.account }));
      }

      const contactMatch = path.match(/^\/contacts\/([^/]+)$/);
      if (contactMatch && req.method === "PATCH") {
        const body = (await readBody(req)) as { name?: string; email?: string; note?: string; account?: string };
        const updated = updateContact(ctx.db, decodeURIComponent(contactMatch[1]), body);
        if (!updated) return json(res, 404, { error: "联系人不存在" });
        return json(res, 200, updated);
      }
      if (contactMatch && req.method === "DELETE") {
        const removed = deleteContact(ctx.db, decodeURIComponent(contactMatch[1]));
        if (!removed) return json(res, 404, { error: "联系人不存在" });
        return json(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/sync") {
        const body = (await readBody(req)) as { accountId?: string };
        return json(res, 200, await runSync(ctx, body.accountId));
      }

      return json(res, 404, { error: `未知端点：${req.method} ${path}` });
    } catch (err) {
      if (err instanceof ContactError) return json(res, err.status, { error: err.message });
      if (err instanceof AccountError) return json(res, err.status, { error: err.message });
      const message = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: message });
    }
  });
}

export { runSync };
