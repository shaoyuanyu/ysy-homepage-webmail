import { randomUUID } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import type { Db } from "../../mail/src/db.js";
import { connectAccount } from "../../mail/src/imap.js";
import { pruneOrphanMessages, removeEmlFiles } from "../../mail/src/message.js";
import { getDraft, type Draft } from "./drafts.js";
import { withAccountLock } from "./locks.js";
// ⚠ 只是类型：`api.ts` 运行时会 import 本模块，值导入会构成循环
import type { WebmailContext } from "./api.js";
import { detectDraftsFolder } from "./write.js";

/**
 * 草稿存储（2026-10-10 起：**服务商的草稿文件夹是唯一事实源**）。
 *
 * 背景（这个模块存在的理由）：草稿原先有两套——webmaild 的本地 `drafts` 表（写信页防抖
 * 自动保存）与账号服务商的「草稿」文件夹（`draft-mirror.ts` 单向投递，好让手机/网页端
 * 也能看到）。用户 2026-10-10 指出这"两条渠道"会干扰心智，要求统一到服务商草稿文件夹。
 *
 * 于是：`drafts` 表降级为**本地暂存 + 解析缓存**，服务器草稿文件夹成为用户可见的唯一草稿箱。
 * 本模块负责：
 * - `purgeIndexedDrafts`：把历史上"被当成邮件索引进来的草稿"清出本地库（阶段 0 的一次性清理，
 *   见 [api.ts](../../webmail/src/api.ts) 的 `NOT_DRAFT_SQL`）；
 * - 后续的服务器草稿读写（list/get/create/update/delete）也在这里。
 */

export interface PurgeResult {
  /** 删掉的副本行数（账号 × 文件夹 × uid） */
  copies: number;
  /** 随之清理掉的邮件本体 + 全文索引行数 */
  messages: number;
  /** 删掉的 `.eml` 原文文件数 */
  eml: number;
}

/**
 * 清掉本地库里**带 `\Draft` 标记**的副本，以及因此变成孤儿的邮件本体。
 *
 * 为什么必须有这一步：`\Drafts` 一进同步白名单，草稿就被当成普通邮件索引（`.eml` 落盘 +
 * messages 行 + FTS 行）。实测用户 QQ 账号积累了 141 封存活草稿（最早 2014-08-31），
 * 它们在「全部」里冒充邮件。展示层已由 `NOT_DRAFT_SQL` 挡住，这里把数据库里的死重量
 * （以及全文索引、磁盘上的原文）一并收掉——**服务器上的草稿一封都不会动**。
 *
 * 幂等：没有草稿副本时直接返回。在 webmaild 启动时跑一次即可（此后白名单里不再有草稿
 * 文件夹，草稿也不会再进这个索引）。
 */
export function purgeIndexedDrafts(db: Db, dataDir: string): PurgeResult {
  const rows = db
    .prepare("SELECT DISTINCT message_id FROM copies WHERE instr(' ' || flags || ' ', ' \\Draft ') > 0")
    .all() as { message_id: string }[];
  if (rows.length === 0) return { copies: 0, messages: 0, eml: 0 };

  const ids = rows.map((r) => r.message_id);
  const { copies, pruned } = db.transaction(() => {
    const deleted = db
      .prepare("DELETE FROM copies WHERE instr(' ' || flags || ' ', ' \\Draft ') > 0")
      .run().changes;
    // ⚠ 孤儿清理必须集合化（pruneOrphanMessages 内部用临时表，2026-10-08 的性能事故见其注记）
    return { copies: deleted, pruned: pruneOrphanMessages(db, { candidates: ids, collectEml: true }) };
  })();
  // 原文文件在事务提交后再删（与 deleteMessages 同一约定）
  const eml = removeEmlFiles(dataDir, pruned.emlPaths);
  return { copies, messages: pruned.removed, eml };
}

export interface DraftRefreshError {
  accountId: string;
  error: string;
}

/** 服务器草稿在本地缓存里的位置 */
interface ServerRef {
  accountId: string;
  folder: string;
  uid: number;
  uidvalidity: string;
}

/** 列表要用的 envelope 子集（IMAP `envelope` 便宜：不需要下载正文） */
interface EnvelopeRow {
  uid: number;
  subject: string;
  to: string;
  date: string;
  inReplyTo: string;
}

/**
 * 地址头 → 写信页用的原始串（`名字 <地址>, 名字 <地址>`）。
 *
 * ⚠ 两种形状都要吃：IMAP `envelope.to` 是 `{name, address}[]`，mailparser 的
 * `parsed.to` 是 `{value: {name, address}[]}`——所以这里按 `unknown` 收、显式归一，
 * 别去套任何一方的类型（两边并不兼容）。
 */
function addressText(v: unknown): string {
  const list = Array.isArray(v) ? v : v ? [v] : [];
  const out: string[] = [];
  for (const item of list) {
    const obj = item as { value?: { name?: string; address?: string }[]; name?: string; address?: string };
    const items = Array.isArray(obj.value) ? obj.value : [obj];
    for (const a of items) {
      if (!a?.address && !a?.name) continue;
      out.push(a.name ? `${a.name} <${a.address ?? ""}>` : (a.address ?? ""));
    }
  }
  return out.join(", ");
}

/** Date 头 → ISO（拿不到就用当前时刻，宁可时间不准也别丢字段） */
function isoDate(v: Date | string | undefined): string {
  if (!v) return new Date().toISOString();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

/** 一手消息 → 缓存字段（`getDraft` 侧的读法见 drafts.ts 的 toDraft） */
export interface ParsedDraftFields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  readReceipt: boolean;
  inReplyTo: string;
  references: string[];
  attachments: { filename: string; contentType: string; size: number }[];
}

export function draftFieldsFromParsed(parsed: ParsedMail): ParsedDraftFields {
  const refs = Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : [];
  const kindHeaders = parsed.headers;
  return {
    to: addressText(parsed.to),
    cc: addressText(parsed.cc),
    bcc: addressText(parsed.bcc),
    subject: parsed.subject ?? "",
    body: parsed.text ?? "",
    // 回执：写 Disposition-Notification-To 头（send.ts 同一判据）
    readReceipt: kindHeaders.has("disposition-notification-to"),
    inReplyTo: parsed.inReplyTo ?? "",
    references: refs.filter((r): r is string => typeof r === "string"),
    attachments: parsed.attachments.map((a) => ({
      filename: a.filename ?? "(未命名)",
      contentType: a.contentType ?? "application/octet-stream",
      size: a.size ?? 0,
    })),
  };
}

/**
 * 草稿的自定义头（`mirrorDrafts` 写、解析时读回）：把**本地才有**的"归属键"带过 IMAP 这一程。
 *
 * `kind` / `kindRef` 回答"这封草稿是给哪封信的回复/转发"，写信页据此支援
 * 「写一半离开，再从同一封邮件点回复能接着写」。MIME 里没有对应字段（回复能从
 * In-Reply-To/References 推，**转发推不出来**），所以自己写两个 X- 头；
 * 服务商通常会原样保留未知头，丢失时退化为"全新草稿"（优雅降级）。
 */
export const DRAFT_KIND_HEADER = "X-Webmail-Draft-Kind";
export const DRAFT_REF_HEADER = "X-Webmail-Draft-Ref";

function draftKeyFromParsed(parsed: ParsedMail): { kind: Draft["kind"]; kindRef: string } {
  const rawKind = String(parsed.headers.get(DRAFT_KIND_HEADER) ?? "").trim();
  const kindRef = String(parsed.headers.get(DRAFT_REF_HEADER) ?? "").trim();
  if (rawKind === "reply" || rawKind === "forward" || rawKind === "new") {
    return { kind: rawKind, kindRef };
  }
  // 外部客户端写的草稿：只能从引用链推——有 In-Reply-To 就是"回复"，转发无法识别
  if (parsed.inReplyTo) return { kind: "reply", kindRef: parsed.inReplyTo };
  return { kind: "new", kindRef: "" };
}

/** 把一批服务器草稿写进本地缓存（新出现的建行，已存在的只刷新 envelope 字段） */
function upsertEnvelopes(
  db: Db,
  ref: Omit<ServerRef, "uid">,
  rows: EnvelopeRow[]
): void {
  const findByUid = db.prepare(
    `SELECT id, server_dirty FROM drafts
      WHERE server_account = ? AND server_folder = ? AND server_uid = ? AND server_uidvalidity = ?`
  );
  const insert = db.prepare(
    `INSERT INTO drafts (id, kind, kind_ref, account_id, to_text, cc_text, bcc_text, subject, body,
       read_receipt, in_reply_to, references_json, created_at, updated_at, server_dirty,
       server_account, server_folder, server_uid, server_uidvalidity, server_parsed, attachments_json)
     VALUES (?, ?, ?, ?, ?, '', '', ?, '', 0, ?, '[]', ?, ?, 0, ?, ?, ?, ?, 0, '[]')`
  );
  // ⚠ 只刷新 envelope 来的三个字段：正文/附件是解析缓存，与 UID 绑定、不会过期
  const touch = db.prepare("UPDATE drafts SET to_text = ?, subject = ?, updated_at = ? WHERE id = ?");
  const tx = db.transaction(() => {
    for (const r of rows) {
      const hit = findByUid.get(ref.accountId, ref.folder, r.uid, ref.uidvalidity) as
        | { id: string; server_dirty: number }
        | undefined;
      if (hit) {
        // 本地有未投递的新版本时，服务器上那份是**旧版**：别拿它盖住用户刚写的内容
        if (hit.server_dirty === 1) continue;
        touch.run(r.to, r.subject, r.date, hit.id);
        continue;
      }
      insert.run(
        randomUUID(),
        r.inReplyTo ? "reply" : "new",
        r.inReplyTo,
        ref.accountId,
        r.to,
        r.subject,
        r.inReplyTo,
        r.date,
        r.date,
        ref.accountId,
        ref.folder,
        r.uid,
        ref.uidvalidity
      );
    }
  });
  tx();
}

/**
 * 清掉"服务器上已经没有了"的缓存行，以及 uidvalidity 变了的作废行。
 * ⚠ 只动 `server_dirty = 0` 的行：本地待投递的草稿不能被服务端的现状抹掉。
 */
function pruneEnvelopes(
  db: Db,
  ref: Omit<ServerRef, "uid">,
  liveUids: number[]
): void {
  const placeholders = liveUids.map(() => "?").join(", ");
  const base = "server_account = ? AND server_folder = ? AND server_dirty = 0 AND server_uid IS NOT NULL";
  if (liveUids.length > 0) {
    db.prepare(`DELETE FROM drafts WHERE ${base} AND server_uidvalidity = ? AND server_uid NOT IN (${placeholders})`)
      .run(ref.accountId, ref.folder, ref.uidvalidity, ...liveUids);
  } else {
    db.prepare(`DELETE FROM drafts WHERE ${base} AND server_uidvalidity = ?`)
      .run(ref.accountId, ref.folder, ref.uidvalidity);
  }
  // 邮箱被重建（uidvalidity 变了）：那一批 UID 全部失效
  db.prepare(`DELETE FROM drafts WHERE ${base} AND server_uidvalidity <> ?`)
    .run(ref.accountId, ref.folder, ref.uidvalidity);
}

export interface RefreshResult {
  errors: DraftRefreshError[];
  /** 刷到的服务器草稿数（不含本地待投递的） */
  synced: number;
}

/**
 * 每个账号最近一次成功刷新的时刻。
 *
 * ⚠ 为什么要 TTL（2026-10-10 实测）：QQ 那 153 封草稿的一次 `FETCH 1:*` envelope + 邮箱
 * SELECT 实测 **12.7 秒**（跨境 IMAP）。而前端是"先出缓存、再后台核对"两条请求，
 * 用户来回切 tab 时不该反复吃这 12 秒。60 秒内重复请求直接复用上一次结果。
 * 需要更实时时把 `WEBMAIL_DRAFT_REFRESH_TTL_MS` 调小（0 = 每次真刷）。
 */
const lastRefreshAt = new Map<string, number>();
/** ⚠ 每次调用现读环境变量：测试要把它设成 0（否则同一账号连刷两次会被 TTL 短路） */
function refreshTtlMs(): number {
  const n = Number(process.env.WEBMAIL_DRAFT_REFRESH_TTL_MS ?? 60_000);
  return Number.isFinite(n) ? n : 60_000;
}

/**
 * 去服务商的草稿文件夹对一遍（草稿箱的同步点）。
 *
 * 单个账号失败**不拦整次**：把错误收集起来返回——断网时草稿箱照样能用本地缓存打开。
 */
export async function refreshDraftBox(ctx: WebmailContext): Promise<RefreshResult> {
  const errors: DraftRefreshError[] = [];
  let synced = 0;
  for (const account of ctx.accounts.values()) {
    if (!account.enabled) continue;
    const cred = ctx.credentials.get(account.id);
    if (!cred) continue;
    const last = lastRefreshAt.get(account.id) ?? 0;
    const ttl = refreshTtlMs();
    if (ttl > 0 && Date.now() - last < ttl) continue;
    try {
      const rows = await withAccountLock(account.id, async () => {
        const client = await connectAccount(account, cred);
        try {
          const folder = await detectDraftsFolder(client);
          // 这个账号在服务商那边**根本没有草稿文件夹**（例如从没写过草稿）：它就是没有草稿，
          // 不是错误——别让草稿箱为此显示"部分账号读不到"。
          if (!folder) return [];
          const mb = await client.mailboxOpen(folder, { readOnly: true });
          const uidvalidity = String(mb.uidValidity ?? "");
          const out: EnvelopeRow[] = [];
          // ⚠ 空文件夹必须跳过：Dovecot 对 `FETCH 1:*` 在 0 封的邮箱上直接回 `BAD Invalid
          //   messageset`（用例实测），会把它记成"这个账号的草稿箱读不到"——而它只是空的。
          if ((mb.exists ?? 0) > 0) {
            for await (const msg of client.fetch("1:*", { uid: true, flags: true, envelope: true })) {
              const flags = [...(msg.flags ?? [])];
              // 僵尸草稿：被标记删除但服务端从未 EXPUNGE（用户的 QQ 草稿箱里有 12 封）
              if (flags.includes("\\Deleted")) continue;
              const env = msg.envelope;
              out.push({
                uid: msg.uid,
                subject: env?.subject ?? "",
                to: addressText(env?.to),
                date: isoDate(env?.date),
                inReplyTo: env?.inReplyTo ?? "",
              });
            }
          }
          upsertEnvelopes(ctx.db, { accountId: account.id, folder, uidvalidity }, out);
          pruneEnvelopes(ctx.db, { accountId: account.id, folder, uidvalidity }, out.map((r) => r.uid));
          return out;
        } finally {
          await client.logout().catch(() => {});
        }
      });
      synced += rows.length;
      lastRefreshAt.set(account.id, Date.now());
    } catch (err) {
      errors.push({ accountId: account.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { errors, synced };
}

/**
 * 打开一封草稿：服务器草稿的正文/附件**按需抓原文解析**（列表只用 envelope，没读过正文）。
 * 本地暂存的草稿内容本来就在本地表里，直接返回。
 *
 * 抓不到（网络/认证/服务端已删）时返回缓存里的行，不抛错——写信页宁可显示"没有正文"，
 * 也不能因为一封草稿打不开就整页失败。
 */
export async function readDraft(ctx: WebmailContext, id: string): Promise<Draft | null> {
  const row = getDraft(ctx.db, id);
  if (!row) return null;
  if (row.contentLoaded) return row;
  const ref = serverRefOf(ctx.db, id);
  const account = ctx.accounts.get(row.accountId);
  const cred = ctx.credentials.get(row.accountId);
  if (!ref || !account || !cred) return row;
  try {
    const raw = await withAccountLock(account.id, async () => {
      const client = await connectAccount(account, cred);
      try {
        const mb = await client.mailboxOpen(ref.folder, { readOnly: true });
        // uidvalidity 不一致 = 邮箱被重建，这个 UID 已经没有意义了
        if (String(mb.uidValidity ?? "") !== ref.uidvalidity) return null;
        const msg = await client.fetchOne(String(ref.uid), { source: true }, { uid: true });
        return msg && msg.source ? msg.source : null;
      } finally {
        await client.logout().catch(() => {});
      }
    });
    if (!raw) return row;
    const parsed = await simpleParser(raw);
    const fields = draftFieldsFromParsed(parsed);
    const key = draftKeyFromParsed(parsed);
    ctx.db
      .prepare(
        `UPDATE drafts SET to_text = ?, cc_text = ?, bcc_text = ?, subject = ?, body = ?,
           read_receipt = ?, in_reply_to = ?, references_json = ?, attachments_json = ?,
           server_parsed = 1, updated_at = ? WHERE id = ?`
      )
      .run(
        fields.to,
        fields.cc,
        fields.bcc,
        fields.subject,
        fields.body,
        fields.readReceipt ? 1 : 0,
        fields.inReplyTo,
        JSON.stringify(fields.references),
        JSON.stringify(fields.attachments),
        row.updatedAt, // 时间用 envelope 的（= 草稿最后写入时刻），别被"打开"这个动作改掉
        id
      );
    // 归属键只在本地为空时补（站内自己写的草稿已经有正确的 kind/kindRef，包括 forward）
    if (key.kindRef && !row.kindRef) {
      ctx.db.prepare("UPDATE drafts SET kind = ?, kind_ref = ? WHERE id = ?").run(key.kind, key.kindRef, id);
    }
  } catch {
    // 打不开就算了：返回缓存（可能没有正文）
  }
  return getDraft(ctx.db, id);
}

/** 某一行的服务器位置（不存在 / 未投递返回 null） */
function serverRefOf(db: Db, id: string): ServerRef | null {
  const r = db
    .prepare(
      `SELECT server_account, server_folder, server_uid, server_uidvalidity FROM drafts WHERE id = ?`
    )
    .get(id) as
    | { server_account: string; server_folder: string; server_uid: number | null; server_uidvalidity: string }
    | undefined;
  if (!r || r.server_uid === null || !r.server_account) return null;
  return {
    accountId: r.server_account,
    folder: r.server_folder,
    uid: r.server_uid,
    uidvalidity: r.server_uidvalidity,
  };
}

