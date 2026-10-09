import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import type { Db } from "../../mail/src/db.js";
import { connectAccount } from "../../mail/src/imap.js";
import { backfillProgress, hasPendingBackfill, syncAccount, type SyncOptions } from "../../mail/src/fetcher.js";
import { searchMessages } from "../../mail/src/search.js";
import { pruneOrphanMessages, removeEmlFiles } from "../../mail/src/message.js";
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
import { AccountError, addAccount, deleteAccount, previewFolders, setRemoteImageDomains, updateAccount, type AddAccountInput, type UpdateAccountInput } from "./accounts.js";
import { resolveAttachmentHeaders } from "./attachment.js";
import { fetchDeferredAttachment } from "./source.js";
import type { AttachmentEntry } from "../../mail/src/mime.js";
import { fetchTruncatedSource, readSource } from "./source.js";
import { listAccountFolders, suggestSyncFolders } from "./folders.js";
import { deleteServerDraftCopy, readDraftServerRef } from "./draft-mirror.js";
import { readDraft, refreshDraftBox } from "./draft-store.js";
import { createDraft, deleteDraft, findDrafts, listDrafts, updateDraft, type DraftInput } from "./drafts.js";
import { withAccountLock } from "./locks.js";
import { renderMailHtml } from "./render.js";
import { sendMessage } from "./send.js";
import { applyFlagChange, deleteUid, isSentFolderName, JUNK_FOLDER_NAMES, moveUid, resolveMoveTarget, SENT_FOLDER_NAMES, setFlags, setFlagsBatch, setSeenBatch, specialMoveTargetLabel } from "./write.js";

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
  /** 精简原文的附件清单（NULL = 原文完整；见 mail/src/mime.ts） */
  attachments_json: string | null;
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
 * 「有任一副本被标记为草稿」= 这封不是邮件，是草稿（2026-10-10，阶段 0）。
 *
 * 起因：服务器草稿文件夹里的信被同步当成普通邮件索引进来，于是**「全部」列表里混着一堆
 * 草稿**——实测用户 QQ 账号有 141 封存活草稿（最早 2014-08-31），它们在站内既不是"待写"
 * 也不是"已收发"，纯属污染。草稿从此归**草稿箱**（`/drafts`，服务商草稿文件夹为唯一事实源，
 * 见 draft-store.ts），邮件侧一律不看带 `\Draft` 标记的副本。
 *
 * ⚠ 判据用**标记**而不是文件夹名：文件夹名各服务商不同（草稿/`Drafts`/`[Gmail]/Drafts`），
 *   而 `\Draft` 是 RFC 3501 的系统标记；我们 APPEND 草稿时也带它（draft-mirror.ts）。
 *   这样即使有人把 `\Drafts` 勾进同步白名单，草稿也进不了邮件列表。
 */
const NOT_DRAFT_SQL =
  "NOT EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND instr(' ' || c.flags || ' ', ' \\Draft ') > 0)";

/**
 * 「未读」= 存在无 `\Seen` 的 **INBOX** 副本（2026-10-10 第六轮起；旧口径是「任一副本无 `\Seen`」）。
 *
 * 全站只有一个「未读」：账号角标（`/accounts` 的 `unread` 只数 INBOX 副本）、底部状态栏、
 * 「全部标为已读」、本筛选，四处同口径。起因见 NOT_JUNK_ONLY_SQL 上方那段（用户报障：
 * 角标写 2、点开「未读」却列出 7 封——多出来的 5 封是垃圾箱里的未读信）。
 *
 * ⚠ **给了 `account` 时要连账号一起限定**（`unseenSql(accountIds)`）：角标是**逐账号**数的，
 *   不做限定就会漏出这种消息——A 账号的 INBOX 副本未读，而这封同时另有 B 账号的副本，
 *   于是「选 B + 未读」列出它、B 的角标却写 0（同一类不一致，只是换了个方向）。
 *   实测用户数据里这种组合当前为 0 条，但判定必须写成账号内命中。
 */
function unseenSql(accountIds: string[]): string {
  const scope = accountIds.length
    ? ` AND c.account_id IN (${accountIds.map(() => "?").join(", ")})`
    : "";
  return `EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id${scope} AND upper(trim(c.folder)) = 'INBOX' AND NOT (${HAS_SEEN_SQL}))`;
}

/** 不带账号范围时的写法（合并视图） */
const UNSEEN_SQL = unseenSql([]);

/**
 * 「这封是正常邮件（至少有一份非垃圾副本）」——垃圾邮件不属于「邮件」（2026-10-10 第六轮）。
 *
 * 起因（用户报障）：大标题角标与「未读」开关都写「2」，点开「未读」却列出 7 封。查证后是
 * **两套口径**：角标 = 收件箱未读（只数 INBOX 副本），而 `filter=unseen` 当时是「存在任一
 * 副本无 `\Seen`」——2026-10-08 把「垃圾邮件」放进同步白名单后，垃圾箱里的未读信也被算了
 * 进来（用户 QQ 账号 Junk 里正好 5 封未读 + 收件箱 2 封 = 7）。更糟的是这些垃圾邮件
 * **混在「全部」里、行上没有任何标记**，跟正常邮件长得一模一样，多出来的 5 封是什么完全看不出。
 *
 * 定稿（用户 2026-10-10 选「全站同一个数」方案）：
 * - **未读 = 收件箱未读**（见 UNSEEN_SQL）；
 * - **垃圾邮件不算「邮件」**：不进「全部」、不进搜索结果，只能在「垃圾」tab 里显式按文件夹
 *   查（那条路带 `folder` 参数，本排除**不生效**，否则垃圾 tab 会永远是空的）；
 * - 判定用**文件夹名**：`copies` 表只有路径这一个线索（special-use 要连 IMAP LIST，
 *   而列表查询不能依赖网络），故复用 write.ts 的 `JUNK_FOLDER_NAMES`——与「标为垃圾」的
 *   移动目标探测、`folders.ts` 的名字回退是**同一份名单**。
 *   ⚠ 名字不在名单里的自定义垃圾文件夹仍会漏进「全部」（「垃圾」tab 靠 special-use 标志位，
 *   不受影响）；真要根治得把探测到的路径落库，见 MAIL-AGENT.md 4.9 的说明。
 *
 * ⚠ 消息**同时**有 INBOX 与垃圾副本时仍算正常邮件（`EXISTS` 命中 INBOX 那份）——实测数据里
 * 这种组合不存在（0 条），但判定必须写成「存在非垃圾副本」而不是「不存在垃圾副本」。
 */
const JUNK_NAMES_LOWER = JUNK_FOLDER_NAMES.map((n) => n.trim().toLowerCase());

/** 副本是否在垃圾文件夹（名字口径，见上） */
function isJunkFolder(folder: string): boolean {
  return JUNK_NAMES_LOWER.includes(folder.trim().toLowerCase());
}

/** 「至少一份非垃圾副本」；占位符与 `JUNK_NAMES_LOWER` 一一对应，绑参顺序必须与 where 拼接顺序一致 */
const NOT_JUNK_ONLY_SQL = `EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND lower(trim(c.folder)) NOT IN (${JUNK_NAMES_LOWER.map(() => "?").join(", ")}))`;

/**
 * 分页大小：缺失 / 非数字 / 非正数一律回退 50，上限 200。
 * ⚠ 必须显式拒绝非正数——SQLite 的 `LIMIT -5` 等于**无上限**，会把整表读进内存
 * （旧写法 `Math.min(Number(x) || 50, 200)` 对 `limit=-5` 原样放行，2026-10-07 修）。
 */
export function parseLimit(raw: string | null | undefined): number {
  const n = Number(raw ?? "");
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.trunc(n), 200);
}

/**
 * 状态 / 方向筛选（4.2、4.9），两个维度互相独立、可组合：
 * - `filter`（状态）：逗号分隔多值（2026-10-04 起）——`unseen` = **存在无 `\Seen` 的 INBOX
 *   副本**（收件箱未读，2026-10-10 第六轮改，见 `unseenSql`；旧口径「任一副本无 `\Seen`」
 *   会把垃圾箱里的未读也算进来），且**给了 `account` 时限定在该账号内**（与账号角标同口径）；
 *   `flagged` = 存在任一副本有 `\Flagged`。多值取交集（`unseen,flagged` = 未读且加星，
 *   前端「星标」视图 + 「未读」开关需要这种组合）；单值写法不变。
 * - `direction`（方向）：`received` = 存在 INBOX 副本（收到的）；`sent` = 副本**全部**在
 *   「已发送」类文件夹（我发出的）
 * - 不给 `folder` 时还排除「只躺在垃圾文件夹里」的邮件（见 `NOT_JUNK_ONLY_SQL`）；
 *   给了 `folder` 就是「垃圾」tab 那条路，不排除。
 *
 * ⚠ `sent` 的口径必须与前端 `isSentItem`（`lib/mail/kind.ts`）完全一致，
 * 否则会出现「筛出来不对」的矛盾；两边共用同一份文件夹名名单（各持一份，改动同步）。
 * ⚠ 本函数的 JS 路径（搜索）与 `listMessages` 的 SQL 路径必须**逐条同口径**：
 *   草稿 → `NOT_DRAFT_SQL` / 垃圾 → `NOT_JUNK_ONLY_SQL` / 未读 → `unseenSql`。
 */
function matchFilter(
  ctx: WebmailContext,
  messageId: string,
  filter: string | null,
  direction: string | null,
  folder?: FolderParam[] | null,
  /** 账号范围（空 = 不限）：未读判定要跟着它收窄，见 `unseenSql` */
  accountIds: string[] = [],
): boolean {
  const copies = copiesOf(ctx, messageId);
  // 草稿不是邮件（见 NOT_DRAFT_SQL）：任何视图都不出现，包括搜索结果
  if (copies.some((c) => c.flags.split(" ").includes("\\Draft"))) return false;
  // 垃圾不是邮件（见 NOT_JUNK_ONLY_SQL）：只在显式按文件夹查时（「垃圾」tab）才出现
  if (!folder?.length && !copies.some((c) => !isJunkFolder(c.folder))) return false;
  const filters = new Set((filter ?? "").split(",").filter(Boolean));
  if (!filters.size && !direction && !folder) return true;
  // 未读 = 收件箱未读（`unseenSql` 的 JS 版）：垃圾/发件/归档里的未读副本不算，
  // 且给了账号范围时只认该账号的 INBOX 副本（与账号角标逐账号同口径）
  if (
    filters.has("unseen") &&
    !copies.some(
      (c) =>
        (!accountIds.length || accountIds.includes(c.account_id)) &&
        c.folder.trim().toUpperCase() === "INBOX" &&
        !c.flags.split(" ").includes("\\Seen"),
    )
  ) {
    return false;
  }
  if (filters.has("flagged") && !copies.some((c) => c.flags.split(" ").includes("\\Flagged"))) return false;
  if (direction === "received" && !copies.some((c) => c.folder.trim().toUpperCase() === "INBOX")) return false;
  if (direction === "sent" && !(copies.length > 0 && copies.every((c) => isSentFolderName(c.folder)))) return false;
  if (folder?.length) {
    if (
      !copies.some((c) =>
        folder.some(
          (f) =>
            f.path.trim().toLowerCase() === c.folder.trim().toLowerCase() &&
            (!f.account || f.account === c.account_id),
        ),
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `folder` 查询参数：`<账号 id>|<文件夹路径>` 或纯文件夹路径（跨账号匹配）。
 * 路径里可能含 `|`（极少见），故只按**第一个** `|` 切分。
 *
 * 2026-10-08 起**可以给多个**（`?folder=a&folder=b`，取并集）——「垃圾」tab 要一次筛出
 * 多个账号各自的垃圾文件夹（阿里云叫「垃圾邮件」、Gmail 叫 `[Gmail]/Spam`……名字不同，
 * 靠前端逐个探测 `GET /folders` 拿到路径后一起发过来）。⚠ 不用逗号分隔：文件夹名里
 * 可以有逗号，而重复查询参数没有这个歧义。
 * ⚠ **每个参数自带账号**（不共用）：多账号下 `acc1|垃圾邮件&acc2|[Gmail]/Spam` 必须
 *   各自限定在自己的账号内，否则第二个路径会去 acc1 里找。
 */
export interface FolderParam {
  /** 空 = 不限账号（跨账号匹配同名文件夹） */
  account: string;
  path: string;
}

export function parseFolderParams(rawValues: (string | null)[]): FolderParam[] {
  const entries: FolderParam[] = [];
  for (const raw of rawValues) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const sep = value.indexOf("|");
    if (sep <= 0) entries.push({ account: "", path: value });
    else entries.push({ account: value.slice(0, sep), path: value.slice(sep + 1) });
  }
  return entries;
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
  const folder = parseFolderParams(url.searchParams.getAll("folder"));
  const limit = parseLimit(url.searchParams.get("limit"));
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
      .filter((r) => matchFilter(ctx, r.message_id, filter, direction, folder, accountIds))
      .map((r) => listItem(ctx, r, names));
    return { items, next: null };
  }

  const params: unknown[] = [];
  let where = `1=1 AND ${NOT_DRAFT_SQL}`;
  // 垃圾邮件不是「邮件」（见 NOT_JUNK_ONLY_SQL）：不给 folder 时排除「只躺在垃圾文件夹里」的。
  // ⚠ 本段的占位符必须**紧跟其后**绑参（params 是位置绑定的，顺序错了会静默错配）
  if (!folder?.length) {
    where += ` AND ${NOT_JUNK_ONLY_SQL}`;
    params.push(...JUNK_NAMES_LOWER);
  }
  if (accountIds.length) {
    where += ` AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND c.account_id IN (${accountIds.map(() => "?").join(", ")}))`;
    params.push(...accountIds);
  }
  // filter 支持逗号分隔多值（交集语义，与 matchFilter 的 JS 路径同口径）
  const filters = new Set((filter ?? "").split(",").filter(Boolean));
  if (filters.has("unseen")) {
    where += ` AND ${unseenSql(accountIds)}`;
    // ⚠ 限定账号时该子句才有占位符；无账号时 push 空数组是无操作（顺序也天然对齐）
    params.push(...accountIds);
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
  // 文件夹筛选（2026-10-07）：命中「在该文件夹里有一份副本」的邮件（路径大小写不敏感，
  // 与 matchFilter 的 JS 路径同口径）；给了账号则再限定在该账号内。
  // 2026-10-08：可给多个 folder 参数（并集），「垃圾」tab 用它一次筛出各账号的垃圾文件夹
  if (folder?.length) {
    const clauses: string[] = [];
    for (const f of folder) {
      if (f.account) {
        clauses.push("(c.account_id = ? AND lower(trim(c.folder)) = lower(trim(?)))");
        params.push(f.account, f.path);
      } else {
        clauses.push("lower(trim(c.folder)) = lower(trim(?))");
        params.push(f.path);
      }
    }
    where += ` AND EXISTS (SELECT 1 FROM copies c WHERE c.message_id = m.message_id AND (${clauses.join(" OR ")}))`;
  }
  const rows = ctx.db
    .prepare(`SELECT m.* FROM messages m WHERE ${where} ORDER BY m.date DESC, m.message_id DESC LIMIT ?`)
    .all(...params, limit + 1) as MessageRow[];
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = rows.length > limit && last?.date ? `${last.date}|${last.message_id}` : null;
  return { items: page.map((r) => listItem(ctx, r, names)), next };
}

/** 附件清单（精简原文才有；NULL = 原文完整，按整封解析） */
function attachmentManifest(row: { attachments_json?: string | null }): AttachmentEntry[] | null {
  if (!row.attachments_json) return null;
  try {
    return JSON.parse(row.attachments_json) as AttachmentEntry[];
  } catch {
    return null;
  }
}

/** cid 归一：两边都可能带/不带尖括号（mailparser 去、BODYSTRUCTURE 留） */
function normCid(cid: string | null | undefined): string {
  return (cid ?? "").replace(/[<>]/g, "").trim().toLowerCase();
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
    // 只有索引（超大邮件、或结构解析失败的兜底）：正文与附件都没有
    return { ...base, text: "", html: "", attachments: [], remoteBlocked: 0, partial: false };
  }
  const raw = readFileSync(join(ctx.dataDir, row.eml_path));
  // keepCidLinks：cid 引用交给 renderMailHtml 的重写管线（统一到附件端点，不内嵌 base64）
  const parsed = await simpleParser(raw, { keepCidLinks: true });
  // ⚠ 清单优先（2026-10-08）：精简原文里**没有**那些被推迟的附件，重新解析出来的序号
  //   与「补取整封后」不一致——附件列表与 cid 映射必须以同步时记下的清单为准。
  const manifest = attachmentManifest(row);
  const attachments = manifest
    ? manifest.map((m) => ({
        index: m.index,
        filename: m.filename,
        contentType: m.contentType,
        size: m.size,
        cid: m.cid,
        inline: m.inline,
        // 没留存 → 点开时才去服务器取（附件端点负责）
        deferred: m.deferred,
      }))
    : parsed.attachments.map((a, index) => ({
        index,
        filename: a.filename ?? `attachment-${index}`,
        contentType: a.contentType,
        size: a.size,
        cid: a.cid ?? null,
        inline: a.contentDisposition === "inline",
        deferred: false,
      }));
  const cidResolver = (cid: string): string | null => {
    const want = normCid(cid);
    const hit = attachments.findIndex((a) => normCid(a.cid) === want);
    if (hit < 0) return null;
    return `${PUBLIC_PREFIX}/message/${encodeURIComponent(messageId)}/attachment/${attachments[hit].index}`;
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
    // 精简原文（正文可读、附件没下载）：前端据此把附件标成「点击取回」，
    // 并且**不再**显示「正文与附件都没下载」那块空态提示
    partial: !!manifest,
    // 原始邮件头（2026-10-07，取证用）：按邮件里的原始顺序与原始行给，**不要**用
    // parsed.headers 的 Map（顺序与折行都丢）——排查要看的就是头部原样
    headers: parsed.headerLines.map((h) => ({ key: h.key, line: h.line })),
  };
}

/**
 * 取附件内容。
 *
 * 两条路（2026-10-08）：
 * - 原文完整（没有清单）→ 读本地 .eml 按序号取（老路径）；
 * - **精简原文**（有清单）→ 以清单序号为准：
 *   · 已留存（内嵌图）→ 从本地精简原文里按 **cid** 找（不能按序号，序号是清单的）；
 *   · 被推迟的 → 向服务器**只取那一个部件**（`BODY.PEEK[n]`，不下载整封）；
 *   · 取不到（或老数据没有部件号）→ 退回整封补取一次，再按整封解析取。
 */
async function attachmentContent(
  ctx: WebmailContext,
  messageId: string,
  index: number
): Promise<{ filename: string; contentType: string; content: Buffer; inline: boolean } | null> {
  const row = messageOf(ctx, messageId);
  if (!row || !row.eml_path) return null;
  const manifest = attachmentManifest(row);
  if (manifest) {
    const entry = manifest.find((e) => e.index === index);
    if (!entry) return null;
    const raw = readFileSync(join(ctx.dataDir, row.eml_path));
    if (!entry.deferred) {
      const parsed = await simpleParser(raw);
      const want = normCid(entry.cid);
      const att = parsed.attachments.find((a) => normCid(a.cid) === want);
      if (!att) return null;
      return {
        filename: att.filename ?? entry.filename,
        contentType: att.contentType,
        content: att.content,
        inline: true,
      };
    }
    const part = await fetchDeferredAttachment(ctx, messageId, entry);
    if (part) {
      return {
        filename: entry.filename,
        contentType: entry.contentType,
        content: part,
        inline: entry.inline,
      };
    }
    // 退路：整封补取一次（会清掉清单），再走「原文完整」那条路
    await fetchTruncatedSource(ctx, messageId);
    return attachmentContent(ctx, messageId, index);
  }
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
    // 服务端写成功后更新本地索引（口径见 write.ts 的 applyFlagChange，与红线 2 对应）
    for (const c of rows) {
      ctx.db
        .prepare("UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?")
        .run(applyFlagChange(c.flags, change), c.account_id, c.folder, c.uid);
    }
  }
  return { updated: copies.length };
}

/**
 * 多选批量标记（2026-10-07，与「全部标为已读」同风格）：对**一批 Message-ID** 的
 * **全部副本**一起写（红线 8），按账号 → 文件夹分组，每文件夹一次 STORE。
 *
 * 与 `applyFlags` 的差别只在规模：单条标记每次开一条连接，多选几十封若逐条走会开几十次
 * IMAP 登录（服务商侧登录频率压力 + 用户等两秒以上）。这里每账号一条连接、每文件夹一次
 * 命令；单账号失败只记 `skipped` 不阻断其它账号（部分成功的语义与 markAllRead 一致）。
 */
async function applyFlagsBatch(
  ctx: WebmailContext,
  messageIds: string[],
  change: FlagChange
): Promise<{
  updated: number;
  messages: number;
  skipped: { account: string; folder: string; uid: number; reason: string }[];
}> {
  const rows: (CopyRow & { message_id: string })[] = [];
  for (const id of messageIds) {
    for (const c of copiesOf(ctx, id)) rows.push({ ...c, message_id: id });
  }
  const result = {
    updated: 0,
    messages: new Set(rows.map((r) => r.message_id)).size,
    skipped: [] as { account: string; folder: string; uid: number; reason: string }[],
  };

  const byAccount = new Map<string, (CopyRow & { message_id: string })[]>();
  for (const r of rows) {
    const list = byAccount.get(r.account_id) ?? [];
    list.push(r);
    byAccount.set(r.account_id, list);
  }

  for (const [accountId, list] of byAccount) {
    const account = ctx.accounts.get(accountId);
    const cred = ctx.credentials.get(accountId);
    if (!account || !cred) {
      result.skipped.push(
        ...list.map((r) => ({ account: accountId, folder: r.folder, uid: r.uid, reason: "账号或凭据缺失" })),
      );
      continue;
    }
    await withAccountLock(accountId, async () => {
      const client = await connectAccount(account, cred);
      try {
        const byFolder = new Map<string, (CopyRow & { message_id: string })[]>();
        for (const r of list) {
          const arr = byFolder.get(r.folder) ?? [];
          arr.push(r);
          byFolder.set(r.folder, arr);
        }
        for (const [folder, group] of byFolder) {
          try {
            await setFlagsBatch(client, folder, group.map((g) => g.uid), change);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            result.skipped.push(...group.map((g) => ({ account: accountId, folder, uid: g.uid, reason })));
            continue;
          }
          const upd = ctx.db.prepare(
            "UPDATE copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?"
          );
          for (const g of group) {
            upd.run(applyFlagChange(g.flags, change), accountId, folder, g.uid);
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

/**
 * 批量标已读（2026-10-05，供 /mail 的「全部标为已读」）：
 * 把**范围内可见的未读消息**的每个缺 \Seen 副本补上 \Seen（含范围外账号的副本，
 * 与单条 `applyFlags` 的「所有副本一起写」同一条红线 8）。
 *
 * ⚠ 口径说明（2026-10-10 第六轮）：本动作的范围是**所有文件夹**里缺 \Seen 的副本
 * （含垃圾 / 归档），而**「未读」这个筛选只认收件箱**（`UNSEEN_SQL`）——即本动作是显示口径
 * 的**超集**。这是有意的：按钮的可用性由收件箱未读数决定（`unreadTotal`），点它就是把
 * 未读清干净（服务商侧的垃圾未读也一并清掉，不影响本站任何显示）。若将来要收窄成
 * 「只清收件箱」，在这里加 `AND upper(trim(c.folder)) = 'INBOX'` 即可。
 *
 * 范围 = `accountIds`（空 = 全部账号）：只计入「至少有一个副本落在这些账号里」的消息。
 * 方向 / 搜索 / 星标不参与——「全部已读」按账号范围清最为直觉。
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
  /** 被跳过的账号：移动目标在该账号上不存在（例如它没有垃圾邮件文件夹） */
  const skipped: { accountId: string; reason: string }[] = [];
  for (const [accountId, rows] of byAccount) {
    const account = ctx.accounts.get(accountId);
    const cred = ctx.credentials.get(accountId);
    if (!account || !cred) throw new Error(`账号未配置：${accountId}`);
    /** 本账号**真正动过**的副本——只有它们才清本地索引（被跳过的账号一行都不能清） */
    const handled: CopyRef[] = [];
    await withAccountLock(accountId, async () => {
      const client = await connectAccount(account, cred);
      try {
        let target: string | null = null;
        if (op === "move") {
          if (!dest) throw new Error("move 缺少目标文件夹");
          // 目标可以是特殊用途记号（`\Junk`）：在本账号上探测一次，逐条复用。
          // 探测不到（该账号没这个文件夹）→ 跳过**本账号**并记 skipped，不阻断其它账号
          // （与 /flags 批量、mark-all-read 同一姿态：局部不可用不拖垮整体）。
          target = await resolveMoveTarget(client, dest);
          if (target === null) {
            skipped.push({ accountId, reason: `该账号没有「${specialMoveTargetLabel(dest) ?? dest}」文件夹` });
            return;
          }
        }
        for (const c of rows) {
          if (op === "move") {
            // 已经在目标文件夹里：不发多余的 MOVE。特殊用途记号的解析结果只有服务端知道，
            // 前端无从预判，故这道兜底必须在服务端（本地行照旧不动——信确实还在那儿）。
            if (c.folder === target) continue;
            await moveUid(client, c.folder, c.uid, target!);
          } else {
            await deleteUid(client, c.folder, c.uid);
          }
          handled.push(c);
          affected++;
        }
      } finally {
        await client.logout().catch(() => {});
      }
    });
    // 源位置的副本行删除；目标文件夹由下一轮同步发现。
    // 整段放进一个事务（2026-10-07）：中途抛错时不会留下「copies 已删、messages 还在」
    // 或「messages 已删、FTS 行还在」的半截状态（FTS 是外部内容表，不受外键级联保护）。
    // ⚠ 孤儿清理走 pruneOrphanMessages（集合化，2026-10-08）：旧实现逐封 COUNT + 逐封删
    //   FTS，FTS 的 message_id 是 UNINDEXED 列 → 每封一次全表扫，批量删 500 封时就明显卡。
    const affectedMessages = new Set<string>();
    const pruned = ctx.db.transaction(() => {
      for (const c of handled) {
        const row = ctx.db
          .prepare("SELECT message_id FROM copies WHERE account_id = ? AND folder = ? AND uid = ?")
          .get(c.accountId, c.folder, c.uid) as { message_id: string } | undefined;
        ctx.db
          .prepare("DELETE FROM copies WHERE account_id = ? AND folder = ? AND uid = ?")
          .run(c.accountId, c.folder, c.uid);
        if (row) affectedMessages.add(row.message_id);
      }
      return pruneOrphanMessages(ctx.db, { candidates: [...affectedMessages], collectEml: true });
    })();
    // 原文文件在事务提交后再删（见 removeEmlFiles 的说明）
    removeEmlFiles(ctx.dataDir, pruned.emlPaths);
  }
  return { affected, skipped };
}

/** 一轮同步的结果：成功结果与逐账号错误分开收集 */
export interface SyncRoundResult {
  results: unknown[];
  errors: { accountId: string; error: string }[];
}

/** 进行中的全量轮（见 runSync 语义 2）；只允许存在一条 */
let fullSyncInFlight: Promise<SyncRoundResult> | null = null;
/** 进行中的回填轮（见 runSync 语义 3）：与全量轮分开计数，谁在跑都不叠第二条 */
let backfillInFlight: Promise<SyncRoundResult> | null = null;

/**
 * 同步一轮（定时器、启动、`POST /sync`、回填泵共用）。
 *
 * ⚠ 三条语义：
 * 1. **单个账号失败不再中断整轮**（2026-10-07 修）。旧实现在 catch 里 rethrow：第一个坏账号
 *    会让后面的账号这一轮完全不抓（它一直坏 = 后面的账号永远排不上），且 /health 上其它
 *    账号的状态静默陈旧。现在按账号隔离，错误逐个记进 `errors` 与该账号的 `lastError`。
 * 2. **同一时刻只跑一轮全量**。60s 定时器与页面刷新的 `/sync` 会叠加，一轮超过 60s 时
 *    旧实现把新请求无界地排在账号锁后面。现在进行中的全量轮被复用（await 同一条
 *    promise）。指定 `accountId` 的同步不受此限（用户显式动作，且失败要抛给调用方）。
 * 3. **回填轮（`mode: "backfill"`）单独计数**（2026-10-08）：首轮历史回填由「回填泵」
 *    高频驱动（一次只吃一块，见 fetcher.ts），若与全量轮共用同一个在飞标记，60s 的常规轮
 *    会被泵的轮次顶掉——增量与标记回读就再也不跑了。故回填轮只在**没有全量轮**时开跑，
 *    且回填轮之间也不叠加。
 */
export function runSync(
  ctx: WebmailContext,
  onlyAccount?: string,
  opts: SyncOptions = {}
): Promise<SyncRoundResult> {
  // 指定账号 = 用户显式动作：串行执行、失败抛给调用方（不参与去重语义）
  if (onlyAccount) return doRunSync(ctx, onlyAccount, opts);
  if (opts.mode === "backfill") {
    if (fullSyncInFlight || backfillInFlight) return fullSyncInFlight ?? backfillInFlight!;
    const tracked: Promise<SyncRoundResult> = doRunSync(ctx, undefined, opts).finally(() => {
      if (backfillInFlight === tracked) backfillInFlight = null;
    });
    backfillInFlight = tracked;
    return tracked;
  }
  if (fullSyncInFlight) return fullSyncInFlight;
  const tracked: Promise<SyncRoundResult> = doRunSync(ctx, undefined, opts).finally(() => {
    if (fullSyncInFlight === tracked) fullSyncInFlight = null;
  });
  fullSyncInFlight = tracked;
  return tracked;
}

/** 是否有全量轮在飞（回填泵据此让路，避免把常规轮挤掉） */
export function isFullSyncInFlight(): boolean {
  return fullSyncInFlight !== null;
}

async function doRunSync(
  ctx: WebmailContext,
  onlyAccount?: string,
  opts: SyncOptions = {}
): Promise<SyncRoundResult> {
  const out: SyncRoundResult = { results: [], errors: [] };
  for (const account of ctx.accounts.values()) {
    if (!account.enabled) continue;
    if (onlyAccount && account.id !== onlyAccount) continue;
    const cred = ctx.credentials.get(account.id);
    const state: SyncState = ctx.syncStates.get(account.id) ?? { lastSync: null, lastError: null, lastNewMail: null };
    if (!cred) {
      const message = `账号 ${account.id} 缺少凭据`;
      state.lastError = message;
      ctx.syncStates.set(account.id, state);
      out.errors.push({ accountId: account.id, error: message });
      console.error(`[webmaild] ${message}`);
      continue;
    }
    try {
      const r = await withAccountLock(account.id, () =>
        syncAccount(ctx.db, ctx.dataDir, account, cred, undefined, opts)
      );
      const now = new Date().toISOString();
      state.lastSync = now;
      state.lastError = null;
      // 本轮确实抓进**新**邮件才刷新 lastNewMail——「上次收到新邮件」的语义，
      // 与「同步循环还活着」（lastSync，60s 一轮恒新鲜）分开（5.5）。
      // ⚠ 回填的历史邮件不算新邮件（`fetched - backfilled`）：否则首轮每抓一块
      //   都会把前端提醒刷成「收到 N 封新邮件」，几百封旧信被当成刚到的。
      if (r.some((x) => x.fetched - x.backfilled > 0)) state.lastNewMail = now;
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
      out.results.push(r);
    } catch (err) {
      state.lastError = err instanceof Error ? err.message : String(err);
      ctx.syncStates.set(account.id, state);
      out.errors.push({ accountId: account.id, error: state.lastError });
      console.error(`[webmaild] 账号 ${account.id} 同步失败：`, state.lastError);
      continue;
    }
    ctx.syncStates.set(account.id, state);
  }
  if (onlyAccount && out.errors.length > 0) {
    // 指定账号的同步是用户显式动作（POST /sync {accountId}），失败要能让调用方看见
    throw new Error(out.errors[0].error);
  }
  return out;
}

export function createApiServer(ctx: WebmailContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;

      if (req.method === "GET" && path === "/health") {
        // backfill（2026-10-08）：该账号历史回填的剩余量/总量，前端据此显示
        // 「正在抓取历史邮件 x/y」并在回填期间自动刷新列表。null = 已回填完（正常态）。
        return json(res, 200, {
          ok: true,
          accounts: [...ctx.accounts.values()].map((a) => {
            const folders = backfillProgress(ctx.db, a.id);
            const remaining = folders.reduce((sum, f) => sum + f.remaining, 0);
            const total = folders.reduce((sum, f) => sum + f.total, 0);
            return {
              id: a.id,
              enabled: a.enabled,
              ...(ctx.syncStates.get(a.id) ?? { lastSync: null, lastError: null, lastNewMail: null }),
              backfill: folders.length
                ? {
                    remaining,
                    total,
                    done: Math.max(0, total - remaining),
                    // 当前最靠前的（剩余最多的）那个文件夹名，供文案「正在抓取「收件箱」历史邮件」
                    folder: folders[0].path,
                    folders,
                  }
                : null,
            };
          }),
        });
      }

      if (req.method === "GET" && path === "/accounts") {
        // 未读数口径（4.2）：只算 INBOX 中无 \Seen 的副本——「已发送」等文件夹不计
        const unreadStmt = ctx.db.prepare(
          `SELECT COUNT(*) AS n FROM copies c WHERE c.account_id = ? AND c.folder = 'INBOX' AND NOT ${HAS_SEEN_SQL}`
        );
        // 本地副本总数（2026-10-08）：删除账号的确认弹窗要告诉用户会清掉多少本地数据。
        // 走 copies 的主键前缀（account_id, folder, uid），是索引区间计数，几千行也是毫秒级。
        const localStmt = ctx.db.prepare(
          "SELECT COUNT(*) AS n FROM copies WHERE account_id = ?"
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
            localMessages: (localStmt.get(a.id) as { n: number }).n,
          }))
        );
      }

      // 新增账号：先连接测试（IMAP 登录 + SMTP verify）通过才落盘
      if (req.method === "POST" && path === "/accounts") {
        const body = (await readBody(req)) as AddAccountInput;
        const summary = await addAccount(ctx, body);
        // 立刻为该账号起一轮同步（不等待）：新账号的首封邮件不必等 60s 定时器，
        // 而且首轮是「最新优先」的倒序回填——几秒内列表里就有最近的邮件（2026-10-08）
        void runSync(ctx, summary.id).catch((err) =>
          console.error(`[webmaild] 新账号 ${summary.id} 首次同步失败：`, err)
        );
        return json(res, 201, summary);
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
        const id = decodeURIComponent(accountMatch[1]);
        const before = ctx.accounts.get(id);
        const summary = await updateAccount(ctx, id, body);
        // 同步文件夹白名单变了 → 立刻按新白名单跑一轮（新增的文件夹当场开始回填，
        // 不必等 60s 定时器；2026-10-08）
        const foldersChanged =
          !!before && before.folders.slice().sort().join("\u0000") !== summary.folders.slice().sort().join("\u0000");
        if (foldersChanged) {
          void runSync(ctx, id).catch((err) =>
            console.error(`[webmaild] 账号 ${id} 白名单变更后同步失败：`, err)
          );
        }
        return json(res, 200, summary);
      }

      if (req.method === "GET" && path === "/messages") {
        return json(res, 200, listMessages(ctx, url));
      }

      // 文件夹清单（2026-10-07）：账号管理弹窗的文件夹选择器 + 详情页「移动」的目标列表
      if (req.method === "GET" && path === "/folders") {
        const accountId = url.searchParams.get("account")?.trim() ?? "";
        const account = ctx.accounts.get(accountId);
        const cred = ctx.credentials.get(accountId);
        if (!account || !cred) {
          return json(res, 404, { error: accountId ? `账号未配置：${accountId}` : "缺少 account 参数" });
        }
        let folders;
        try {
          folders = await listAccountFolders(account, cred);
        } catch (err) {
          // 连不上 = 上游不可用（502），与账号连接测试同一语义；别落成兜底 500
          throw new AccountError(
            `IMAP 连接失败：${err instanceof Error ? err.message : String(err)}`,
            502
          );
        }
        return json(res, 200, {
          folders,
          // 推荐同步的一组（INBOX + 已发送/草稿/已删除/垃圾）与当前注册表里的白名单
          suggested: suggestSyncFolders(folders),
          synced: account.folders,
        });
      }
      // 文件夹预览（新增账号时账号还没落盘，UI 拿不到 id）：用表单里现填的连接参数登录
      if (req.method === "POST" && path === "/folders") {
        const body = (await readBody(req)) as {
          id?: string;
          email?: string;
          imapHost?: string;
          imapPort?: number;
          imapSecure?: boolean;
          username?: string;
          password?: string;
        };
        return json(res, 200, await previewFolders(ctx, body ?? {}));
      }

      const msgMatch = path.match(/^\/message\/([^/]+)$/);
      if (req.method === "GET" && msgMatch) {
        const detail = await messageDetail(ctx, decodeURIComponent(msgMatch[1]));
        if (!detail) return json(res, 404, { error: "消息不存在" });
        return json(res, 200, detail);
      }

      // 原文（2026-10-07）：
      // - GET  下载 .eml 原件（有原文时才算，否则 404）
      // - POST 按需取原文（truncated 的超大邮件：显式点击才下载一次，落盘并回填索引）
      const srcMatch = path.match(/^\/message\/([^/]+)\/source$/);
      if (srcMatch && req.method === "GET") {
        const id = decodeURIComponent(srcMatch[1]);
        const raw = readSource(ctx, id);
        if (!raw) return json(res, 404, { error: "没有原文（这封邮件只入库了索引）" });
        res.writeHead(200, {
          // 一律 octet-stream + attachment：.eml 里的 Content-Type 不受信（同附件端点的顾虑）
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${id.replace(/[^\w.-]+/g, "_").slice(0, 80)}.eml"`,
          "x-content-type-options": "nosniff",
        });
        return res.end(raw);
      }
      if (srcMatch && req.method === "POST") {
        return json(res, 200, await fetchTruncatedSource(ctx, decodeURIComponent(srcMatch[1])));
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
        // 安全头决策见 attachment.ts：邮件里的 Content-Type 不受信，非白名单类型
        // 一律降级为 application/octet-stream + attachment（否则发信人可用一封
        // inline text/html 附件在站点源上执行脚本）
        const headers = resolveAttachmentHeaders(att);
        res.writeHead(200, {
          "content-type": headers.contentType,
          "content-disposition": headers.contentDisposition,
          ...headers.extraHeaders,
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
        const body = (await readBody(req)) as {
          messageId?: string;
          messageIds?: unknown;
        } & FlagChange;
        if (body.seen === undefined && body.flagged === undefined) {
          return json(res, 400, { error: "缺少标记变更（seen / flagged）" });
        }
        // 批量（2026-10-07，多选）：messageIds 优先；单条仍用 messageId
        const ids = Array.isArray(body.messageIds)
          ? body.messageIds.filter((m): m is string => typeof m === "string" && m.length > 0)
          : [];
        if (ids.length > 0) {
          if (ids.length > 500) return json(res, 400, { error: "一次最多 500 封" });
          return json(res, 200, await applyFlagsBatch(ctx, ids, body));
        }
        if (!body.messageId) return json(res, 400, { error: "缺少 messageId" });
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

      // ---- 草稿（2026-10-06 建，2026-10-10 改为「服务商草稿文件夹 = 唯一事实源」）----
      // 列表按最近更新倒序。两种读法各有用处：
      // - `?refresh=1`：草稿箱打开时用——**去服务商那边对一遍**（手机写的新草稿由此进来、
      //   服务端删掉的从缓存清掉）。这是唯一的同步点；
      // - 不带 refresh：只读本地缓存——写信页高频调它来找回"同一原信的最新草稿"，
      //   每次登录一遍账号的代价不能压在那里。
      // `?kind=&kindRef=` 让写信页只取它关心的那一封，不必把整个草稿箱拉过去。
      if (req.method === "GET" && path === "/drafts") {
        let errors: { accountId: string; error: string }[] = [];
        if (url.searchParams.get("refresh") === "1") {
          const r = await refreshDraftBox(ctx);
          errors = r.errors;
        }
        const kind = url.searchParams.get("kind")?.trim();
        const kindRef = url.searchParams.get("kindRef")?.trim();
        const items =
          kind || kindRef ? findDrafts(ctx.db, { kind, kindRef }) : listDrafts(ctx.db);
        return json(res, 200, { items, errors });
      }
      if (req.method === "POST" && path === "/drafts") {
        const body = (await readBody(req)) as DraftInput;
        return json(res, 201, createDraft(ctx.db, body ?? {}));
      }
      const draftMatch = path.match(/^\/drafts\/([^/]+)$/);
      // 打开一封草稿：服务器草稿的正文/附件在这里**按需抓原文解析**（列表只用 envelope）
      if (draftMatch && req.method === "GET") {
        const draft = await readDraft(ctx, decodeURIComponent(draftMatch[1]));
        if (!draft) return json(res, 404, { error: "草稿不存在" });
        return json(res, 200, draft);
      }
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
          limit: parseLimit(url.searchParams.get("limit")),
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
