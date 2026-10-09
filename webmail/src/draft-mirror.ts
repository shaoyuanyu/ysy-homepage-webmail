import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { simpleParser } from "mailparser";
import type { ImapFlow } from "imapflow";
import type { Db } from "../../mail/src/db.js";
import { connectAccount } from "../../mail/src/imap.js";
import type { WebmailContext } from "./api.js";
import { withAccountLock } from "./locks.js";
import type { WebmailAccount } from "./types.js";
import { detectDraftsFolder } from "./write.js";

/**
 * 草稿暂存 → 服务商「草稿」文件夹的**提交层**（2026-10-06 建，2026-10-10 改定位）。
 *
 * 现在服务商的草稿文件夹是**用户可见的唯一草稿箱**（见 `draft-store.ts`）：写信页 500ms
 * 防抖只写本地 `drafts` 表（`server_dirty = 1`），由本模块在"安静 ≥10s"后把这一版
 * APPEND 上去、并**彻底删除**它的上一版——本地那一行随之变成这份服务器草稿的解析缓存。
 * 删除 / 发送后同样清掉服务器副本（`deleteServerDraftCopy`）。
 *
 * ⚠ 因此"镜像"这个名字现在只是个历史称呼：它不是第二份数据，而是**提交动作**本身；
 *   本地暂存存在的唯一理由是"防抖 + 断网也能继续写"。
 *
 * 时序模型（与 `runSync` 相同的「周期性扫描」风格，不做逐次请求触发的定时器）：
 * - 本地每次保存（POST/PUT /drafts）只把 `server_dirty` 置 1；
 * - `index.ts` 每 4 秒调一次 `mirrorDrafts()`：挑出 **安静 ≥ quietMs（默认 10 秒）**
 *   且 dirty 的草稿投递。持续打字（防抖保存每 500ms 一次）期间不会触发镜像，
 *   停下后一次 —— 否则每个按键停顿都要对 IMAP 登录一次，服务商侧会有登录频率
 *   压力（每次镜像 = 一次连接 + 可选删除 + APPEND）。
 * - 失败留 dirty 由下一轮重试，配内存退避（防凭据失效时每 4 秒重试打日志）。
 *
 * ⚠ **替换（删旧 + 追加新）必须用「彻底删除」（messageDelete/EXPUNGE），不能走
 *   `deleteUid`**（有回收站就移入）：自动保存会反复替换，若每版都丢进回收站，
 *   用户的「已删除邮件」会被草稿中间版本灌满。
 * ⚠ **按 UID 删除前必须比对 uidvalidity**：服务器重建邮箱后 UID 空间重排，拿旧
 *   UID 直接删会误删别的邮件。不一致时跳过删除、只追加新版本（最多留一个孤儿副本，
 *   下轮镜像用新 uidvalidity 记录后自愈）。
 * ⚠ 只做「本地 → 服务器」单向：在阿里云网页端改 / 删草稿不会回流到本站（草稿箱
 *   视图与 webmaild /drafts 是本地的唯一事实源；反向同步不在本版范围内）。
 */

/** 服务器副本的位置（drafts 表的 server_* 列） */
export interface DraftServerRef {
  accountId: string;
  folder: string;
  uid: number | null;
  uidvalidity: string;
}

interface MirrorRow {
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
  updated_at: string;
  server_account: string;
  server_folder: string;
  server_uid: number | null;
  server_uidvalidity: string;
  /** 解析缓存里的附件清单（非空 = 替换时必须把原件的附件原样带过去） */
  attachments_json: string;
}

/** 安静期：草稿最后一次更新后至少静置这么久才投递服务器（合并连续自动保存） */
const QUIET_MS = 10_000;
/** 扫描间隔（index.ts 的定时器周期；测试直接调 mirrorDrafts 可绕过定时） */
export const MIRROR_SWEEP_MS = 4_000;

/** 失败的草稿按指数退避重试（纯内存；重启后清零=立刻重试一次，无妨） */
const backoff = new Map<string, { attempts: number; nextAt: number }>();

function recordFailure(id: string): void {
  const b = backoff.get(id) ?? { attempts: 0, nextAt: 0 };
  b.attempts += 1;
  b.nextAt = Date.now() + Math.min(MIRROR_SWEEP_MS * 2 ** b.attempts, 60_000);
  backoff.set(id, b);
}

/** 读取草稿的服务器副本位置（删除 / 发送清理用；不存在返回全空 ref） */
export function readDraftServerRef(db: Db, id: string): DraftServerRef | null {
  const row = db
    .prepare("SELECT server_account, server_folder, server_uid, server_uidvalidity FROM drafts WHERE id = ?")
    .get(id) as
    | { server_account: string; server_folder: string; server_uid: number | null; server_uidvalidity: string }
    | undefined;
  if (!row) return null;
  return {
    accountId: row.server_account,
    folder: row.server_folder,
    uid: row.server_uid,
    uidvalidity: row.server_uidvalidity,
  };
}

/**
 * 构造草稿的 RFC822 报文。
 * - Message-ID 用 `draft-<草稿 id>@域名`（确定性、可追溯；同一草稿的历代版本共用）
 * - 地址串按用户输入的原文传入（草稿是半成品，不做发送侧的合法性拦截——校验
 *   留给发送；地址解析由 MailComposer 承担）
 * - From 显示名用 senderName（与发送路径同一规则，见 send.ts）
 */
async function buildDraftRaw(
  account: WebmailAccount,
  row: MirrorRow,
  keepAttachments: { filename: string; contentType: string; content: Buffer }[]
): Promise<Buffer> {
  const domain = account.email.split("@")[1] ?? "localhost";
  const references = JSON.parse(row.references_json) as string[];
  // 归属键（"这封草稿是给哪封信的回复/转发"）本地才有，MIME 里没字段 → 自己带两个头，
  // 解析侧照原样读回（draft-store.ts 的 draftKeyFromParsed）。丢了就退化成"全新草稿"。
  const headers: Record<string, string> = {};
  if (row.read_receipt === 1) headers["Disposition-Notification-To"] = account.email;
  if (row.kind !== "new") {
    headers["X-Webmail-Draft-Kind"] = row.kind;
    if (row.kind_ref) headers["X-Webmail-Draft-Ref"] = row.kind_ref;
  }
  const composer = new MailComposer({
    from: account.senderName ? `"${account.senderName}" <${account.email}>` : account.email,
    to: row.to_text || undefined,
    cc: row.cc_text || undefined,
    bcc: row.bcc_text || undefined,
    subject: row.subject,
    text: row.body,
    inReplyTo: row.in_reply_to || undefined,
    references: references.length > 0 ? references : undefined,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    // 原件带的附件原样带过去（站内还不能编辑附件，但**绝不能因为保存就把它们弄丢**）
    attachments:
      keepAttachments.length > 0
        ? keepAttachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            content: a.content,
          }))
        : undefined,
    messageId: `<draft-${row.id}@${domain}>`,
  });
  return composer.compile().build();
}

/**
 * 从**即将被替换掉的那一版服务器草稿**里取出附件（保存草稿时原样保留）。
 *
 * 为什么要重新抓一遍：附件字节不进本地 SQLite（可能几十 MB），本地只缓存清单
 * （`attachments_json`），所以替换前回服务器把原件读回来。
 * ⚠ 任何一步失败都**抛错中止这一轮提交**（留 dirty 下轮重试）——宁可晚 4 秒同步，
 *   也不能把用户手机上加的附件悄悄删掉。
 */
async function readKeptAttachments(
  client: ImapFlow,
  row: MirrorRow,
  folder: string,
  uidvalidity: string
): Promise<{ filename: string; contentType: string; content: Buffer }[]> {
  const expected = JSON.parse(row.attachments_json || "[]") as unknown[];
  if (expected.length === 0) return [];
  if (
    row.server_uid === null ||
    row.server_folder !== folder ||
    row.server_uidvalidity !== uidvalidity
  ) {
    // 找不到上一版（首次提交 / 邮箱被重建）：没有可保留的附件
    return [];
  }
  const msg = await client.fetchOne(String(row.server_uid), { source: true }, { uid: true });
  if (!msg || !msg.source) throw new Error("读取旧草稿原文失败（附件无法保留）");
  const parsed = await simpleParser(msg.source);
  if (parsed.attachments.length === 0) return [];
  return parsed.attachments.map((a) => ({
    filename: a.filename ?? "attachment",
    contentType: a.contentType ?? "application/octet-stream",
    content: a.content,
  }));
}

function skipDueToBackoff(id: string): boolean {
  const b = backoff.get(id);
  return b !== undefined && Date.now() < b.nextAt;
}

/** 投递单个草稿：删旧版（安全时）→ APPEND 新版 → 记录新位置 */
async function mirrorOne(ctx: WebmailContext, row: MirrorRow): Promise<void> {
  const account = ctx.accounts.get(row.account_id);
  const cred = ctx.credentials.get(row.account_id);
  if (!account || !cred) throw new Error(`账号未配置：${row.account_id}`);
  if (!account.enabled) return; // 停用账号不投递（留 dirty，重新启用后自愈）

  await withAccountLock(account.id, async () => {
    // 加锁后复核 dirty（2026-10-07）：`row` 是加锁**之前**读到的快照，等锁期间草稿
    // 可能已被发出 / 删除 / 被上一轮镜像完成——那时 server_dirty 已归 0，再投一次就会
    // 在服务商侧留下重复副本。
    const current = ctx.db
      .prepare("SELECT server_dirty FROM drafts WHERE id = ?")
      .get(row.id) as { server_dirty: number } | undefined;
    if (!current || current.server_dirty === 0) return;

    const client = await connectAccount(account, cred);
    try {
      const folder = await detectDraftsFolder(client);
      if (!folder) throw new Error(`账号 ${account.id} 找不到「草稿」文件夹（\\Drafts 与常见名均无）`);
      const mb = await client.mailboxOpen(folder, { readOnly: false });
      const uidvalidity = String(mb.uidValidity ?? "");

      // 附件：先（在删旧版之前）把旧版里的附件读回来，才能原样带进新版本
      const keepAttachments = await readKeptAttachments(client, row, folder, uidvalidity);
      const raw = await buildDraftRaw(account, row, keepAttachments);

      // 旧版本：同一账号同一文件夹且 uidvalidity 一致才按 UID 删（不一致=邮箱被重建，跳过防误删）
      if (
        row.server_uid !== null &&
        row.server_account === account.id &&
        row.server_folder === folder &&
        row.server_uidvalidity === uidvalidity
      ) {
        await client.messageDelete(String(row.server_uid), { uid: true });
      }

      const appended = await client.append(folder, raw, ["\\Draft"]);
      if (!appended || !appended.uid) throw new Error("APPEND 草稿失败（未拿到 APPENDUID）");

      ctx.db
        .prepare(
          `UPDATE drafts SET server_dirty = 0, server_account = ?, server_folder = ?,
             server_uid = ?, server_uidvalidity = ? WHERE id = ?`
        )
        .run(account.id, folder, appended.uid, uidvalidity, row.id);
    } finally {
      await client.logout().catch(() => {});
    }
  });
}

/**
 * 扫描一轮：投递所有「dirty 且已安静 quietMs」的草稿（定时器与测试共用入口）。
 *
 * ⚠ 同一时刻只允许一轮（2026-10-07）：4 秒定时器在一轮耗时 >4s 时会叠上第二轮，
 * 而两轮都会挑到同一批仍是 dirty 的行 → 同一草稿被 APPEND 两次（服务商侧重复副本）。
 */
export function mirrorDrafts(
  ctx: WebmailContext,
  opts: { quietMs?: number } = {}
): Promise<{ mirrored: number; failed: number }> {
  if (sweepInFlight) return sweepInFlight;
  const tracked: Promise<{ mirrored: number; failed: number }> = doMirrorDrafts(ctx, opts).finally(
    () => {
      if (sweepInFlight === tracked) sweepInFlight = null;
    }
  );
  sweepInFlight = tracked;
  return tracked;
}

/** 进行中的一轮扫描（见 mirrorDrafts 的并发说明） */
let sweepInFlight: Promise<{ mirrored: number; failed: number }> | null = null;

async function doMirrorDrafts(
  ctx: WebmailContext,
  opts: { quietMs?: number } = {}
): Promise<{ mirrored: number; failed: number }> {
  const quietMs = opts.quietMs ?? QUIET_MS;
  const cutoff = new Date(Date.now() - quietMs).toISOString();
  const rows = ctx.db
    .prepare("SELECT * FROM drafts WHERE server_dirty = 1 AND updated_at <= ? ORDER BY updated_at ASC")
    .all(cutoff) as MirrorRow[];

  let mirrored = 0;
  let failed = 0;
  for (const row of rows) {
    if (skipDueToBackoff(row.id)) continue;
    try {
      await mirrorOne(ctx, row);
      backoff.delete(row.id);
      mirrored++;
    } catch (err) {
      failed++;
      recordFailure(row.id);
      console.error(`[webmaild] 草稿镜像失败（${row.id}）：`, err instanceof Error ? err.message : err);
    }
  }
  return { mirrored, failed };
}

/**
 * 删除草稿的服务器副本（用户删除草稿 / 发送成功后清理）。
 * - `reason: "never-mirrored"`（从未投递过）与 `"uidvalidity"`（邮箱被重建，不能按旧
 *   UID 安全删除）都不算错误，调用方照常继续；
 * - 其它失败（网络 / 认证）返回 deleted=false，由调用方决定是否中止本地删除。
 */
export async function deleteServerDraftCopy(
  ctx: WebmailContext,
  ref: DraftServerRef
): Promise<{ deleted: boolean; reason?: string }> {
  if (!ref.accountId || !ref.folder || ref.uid === null) return { deleted: false, reason: "never-mirrored" };
  const account = ctx.accounts.get(ref.accountId);
  const cred = ctx.credentials.get(ref.accountId);
  if (!account || !cred) return { deleted: false, reason: "account-missing" };

  return withAccountLock(account.id, async () => {
    const client = await connectAccount(account, cred);
    try {
      const mb = await client.mailboxOpen(ref.folder, { readOnly: false });
      const uidvalidity = String(mb.uidValidity ?? "");
      if (ref.uidvalidity && ref.uidvalidity !== uidvalidity) {
        return { deleted: false, reason: "uidvalidity" };
      }
      await client.messageDelete(String(ref.uid), { uid: true }); // 不存在时返回 false，等价于已删
      return { deleted: true };
    } finally {
      await client.logout().catch(() => {});
    }
  });
}
