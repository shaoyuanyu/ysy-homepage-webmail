import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AccountCredential, CredentialsFile } from "../../mail/src/types.js";
import type { WebmailContext } from "./api.js";
import { listAccountFolders, listFoldersWith, suggestSyncFolders, type FolderInfo } from "./folders.js";
import { pruneOrphanMessages, removeEmlFiles } from "../../mail/src/message.js";
import type { WebmailAccount, WebmailAccountsFile } from "./types.js";

/** 业务错误：status 400 参数非法 / 409 冲突 / 502 连接测试失败，由 API 层映射为 HTTP 状态码 */
export class AccountError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface AddAccountInput {
  id?: string;
  displayName?: string;
  email?: string;
  provider?: string;
  color?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
  password?: string;
  folders?: string[];
  /** 发件人姓名（随邮件发出的 From 显示名；仅备注名（displayName）不会外发，见 types.ts） */
  senderName?: string;
}

/** 修改账号（PUT /accounts/:id）：全字段可选，缺省 = 保持原值；password 空/缺省 = 不改密码 */
export interface UpdateAccountInput {
  displayName?: string;
  senderName?: string;
  email?: string;
  provider?: string;
  color?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  username?: string;
  password?: string;
  folders?: string[];
}

const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 账号色板（MAIL-AGENT.md 4.2）：青 / 玫红 / 紫 / 橙 / 蓝绿——避开等级配色（红蓝绿琥珀）
 * 与邮件页自己的语义色（未读蓝、方向 emerald/amber、星标前景色）。
 *
 * ⚠ 这里只有**名字与顺序**，具体色值在前端 `components/mail/account-dot.ts` 的 `ACCOUNT_DOT`，
 *   由 `ysy-homepage-web/scripts/gen-account-colors.mjs` 按统一 OKLCH 带算出（浅色 L=0.70 /
 *   深色 L=0.78，彩度 = 各色相 sRGB 上限的最小值 0.124）。两处是同一套名字**且同一顺序**，
 *   **改动必须同步**（不一致只会让弹窗预选与落盘值对不上，不报错——属静默漂移）。
 *
 * ⚠ 顺序只决定「第 k 个账号拿到哪个色」。旧色板（Tailwind 600 档）明度/彩度各不相同，
 *   「顺序排得对不对」影响很大（第 2 个账号距离 24.5 还是 31.1）；统一明度/彩度后任意两色
 *   都 ≥0.95×2C，顺序影响降到 0%（生成器每次验算并打印声明序 vs 贪心序）。所以顺序现在是
 *   按观感定的（先蓝后粉），`nextAccountColor()` 直接按顺序取第一个未占用的即可。
 *   ⚠ 唯一的弱项是 cyan↔teal（ΔE 7.9，色相只差 33°）——要到第 5 个账号才会遇到；拉开它只能
 *   换绿色系（撞**同一行**的收件角标 emerald）或暖褐色系（撞 4 区琥珀），**换之前先跟用户确认**
 *   （2026-10-09 问过，保留现状）。
 */
export const ACCOUNT_COLOR_PALETTE = ["cyan", "pink", "violet", "orange", "teal"] as const;

/**
 * 历史遗留色 → 色板名：老版本的缺省色是写死的 `#0ea5e9`（天蓝），避让时必须把它当成
 * `cyan` 占位，否则新账号的缺省色又会落回同一种蓝（正是用户报的那个问题）。
 * 值与前端 `components/mail/account-dot.ts` 的 `LEGACY_COLOR_ALIAS` 同步。
 */
const LEGACY_COLOR_ALIAS: Record<string, string> = { "#0ea5e9": "cyan" };

/** 颜色的比较键：色板名原样、历史缺省色归到对应色板名、其余原样小写（只用于避让比较） */
export function accountColorKey(color: string): string {
  const c = color.trim().toLowerCase();
  return LEGACY_COLOR_ALIAS[c] ?? c;
}

/**
 * 下一个可用的账号色：先取色板里**没人用过**的，全占满才按已用数量轮转。
 *
 * ⚠ 新增账号的缺省色**不能是常量**（2026-10-09 用户报「账号指示器里多个账号颜色没有区别」
 *   的根因）：以前缺省写死 `#0ea5e9`，于是从界面加进来的账号全是同一个天蓝色，色点等于
 *   没有信息。缺省值必须随已有账号变化，新账号才不会一进来就撞色。
 */
export function nextAccountColor(used: Iterable<string>): string {
  const taken = new Set([...used].map(accountColorKey));
  return (
    ACCOUNT_COLOR_PALETTE.find((c) => !taken.has(c)) ??
    ACCOUNT_COLOR_PALETTE[taken.size % ACCOUNT_COLOR_PALETTE.length]
  );
}

/**
 * 撞色自动修复（2026-10-09 用户要求「不要手动分配」）：**同色账号里后出现的**改取一个
 * 未被占用的色（就地改传入的数组，返回被重新分配的账号 id）。
 *
 * 存在的理由：缺省色曾经是常量 `#0ea5e9`，那批历史账号到现在还是同一个色——光靠「新增时
 * 避让」修不了存量，而让用户挨个手动改正是用户嫌麻烦的那一步。webmaild 启动读注册表时
 * 调用一次并落盘（幂等：修完就没有重复色，再启动不再动）。
 */
export function repairAccountColors(accounts: WebmailAccount[]): string[] {
  const used: string[] = [];
  const fixed: string[] = [];
  for (const a of accounts) {
    const key = accountColorKey(a.color ?? "");
    if (key && !used.includes(key)) {
      used.push(key);
      continue;
    }
    const next = nextAccountColor(used);
    used.push(accountColorKey(next));
    // ⚠ 只有真的换了色才算「修过」：账号数超过色板长度时（≥6 个）撞色不可避免，
    //   缺省轮转给出的可能还是原色——那时不该每次启动都重写一遍注册表、刷一条日志。
    if (accountColorKey(next) === key) continue;
    a.color = next;
    fixed.push(a.id);
  }
  return fixed;
}

/**
 * 启动钩子：修注册表里的撞色并原子落盘。返回被重新分配的账号 id（空 = 无需改动、不写盘）。
 * ⚠ 只改 `color` 一个字段，其余内容原样写回（`{...raw, accounts}`）。
 */
export function repairAccountColorsFile(dataDir: string, accounts: WebmailAccount[]): string[] {
  const fixed = repairAccountColors(accounts);
  if (fixed.length === 0) return fixed;
  const file = join(dataDir, "accounts.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as WebmailAccountsFile;
  atomicWriteJson(file, { ...raw, accounts });
  return fixed;
}

/** 从邮箱地址推导账号 id（本地部分小写化、非法字符转 -；冲突时追加 -2/-3…） */
function deriveId(email: string, taken: Set<string>): string {
  const local = email.split("@")[0] ?? "account";
  const base = local.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "account";
  let id = base.slice(0, 32);
  for (let n = 2; taken.has(id); n++) id = `${base.slice(0, 28)}-${n}`;
  return id;
}

function isPort(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535;
}

/** 校验 + 归一化输入；返回可入库的账号与凭据（不做任何网络/落盘动作）
 *  `usedColors` = 现有账号已占用的颜色（缺省色从这里避开，见 nextAccountColor） */
export function normalizeAccountInput(
  input: AddAccountInput,
  existingIds: Set<string>,
  usedColors: Iterable<string> = []
): { account: WebmailAccount; cred: AccountCredential } {
  const displayName = input.displayName?.trim();
  const email = input.email?.trim();
  const imapHost = input.imapHost?.trim();
  const smtpHost = input.smtpHost?.trim();
  const password = input.password ?? "";
  if (!displayName) throw new AccountError("缺少显示名称");
  if (!email || !EMAIL_RE.test(email)) throw new AccountError("邮箱地址非法");
  if (!imapHost) throw new AccountError("缺少 IMAP 主机");
  if (!smtpHost) throw new AccountError("缺少 SMTP 主机");
  if (!isPort(input.imapPort)) throw new AccountError("IMAP 端口非法（1-65535）");
  if (!isPort(input.smtpPort)) throw new AccountError("SMTP 端口非法（1-65535）");
  if (typeof input.imapSecure !== "boolean" || typeof input.smtpSecure !== "boolean") {
    throw new AccountError("imapSecure / smtpSecure 必须是布尔值");
  }
  if (!password) throw new AccountError("缺少密码（或授权码）");

  const id = input.id?.trim() || deriveId(email, existingIds);
  if (!ID_RE.test(id)) throw new AccountError(`账号 id 非法：${id}（小写字母/数字/连字符）`);
  if (existingIds.has(id)) throw new AccountError(`账号 id 已存在：${id}`, 409);

  const folders = (input.folders ?? ["INBOX"])
    .map((f) => String(f).trim())
    .filter((f) => f.length > 0);
  if (folders.length === 0) throw new AccountError("同步文件夹至少保留一个（如 INBOX）");

  const account: WebmailAccount = {
    id,
    displayName,
    email,
    provider: input.provider?.trim() || "custom",
    color: input.color?.trim() || nextAccountColor(usedColors),
    imapHost,
    imapPort: input.imapPort!,
    imapSecure: input.imapSecure,
    smtpHost,
    smtpPort: input.smtpPort!,
    smtpSecure: input.smtpSecure,
    folders,
    enabled: true,
  };
  const senderName = input.senderName?.trim();
  if (senderName) account.senderName = senderName;
  const cred: AccountCredential = { username: input.username?.trim() || email, password };
  return { account, cred };
}

/**
 * 连接测试：IMAP 登录（connect + LIST + logout）与 SMTP verify 都通过才算可用。
 * 失败抛 AccountError（502）并带原始错误信息，不落盘、不进 ctx。
 *
 * 返回顺带列出的**文件夹清单**（2026-10-07）：新增账号时用它预填「同步文件夹」，
 * 用户不必知道服务器上的文件夹叫什么（LIST 失败不影响连接测试结论，退化为空数组）。
 */
export async function testAccountConnection(
  account: WebmailAccount,
  cred: AccountCredential
): Promise<FolderInfo[]> {
  // ⚠ 不能复用 connectAccount：必须自己持有 ImapFlow 实例并挂 error 监听——
  // 连接失败后 imapflow 仍可能异步发出 'error'（如 socketTimeout），
  // EventEmitter 无监听器的 'error' 会 throw 成未捕获异常、把整个进程打挂。
  const imap = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: cred.username, pass: cred.password },
    logger: false,
    socketTimeout: 15_000,
  });
  imap.on("error", () => {});
  try {
    await imap.connect();
  } catch (err) {
    imap.close();
    throw new AccountError(
      `IMAP 连接失败：${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
  let folders: FolderInfo[] = [];
  try {
    folders = await listFoldersWith(imap);
  } catch {
    // 列文件夹失败不算连接失败：账号仍可用，只是拿不到预填清单
    folders = [];
  }
  await imap.logout().catch(() => {});
  imap.close();
  try {
    const transporter = nodemailer.createTransport({
      host: account.smtpHost,
      port: account.smtpPort,
      secure: account.smtpSecure,
      auth: { user: cred.username, pass: cred.password },
      connectionTimeout: 15_000,
    });
    await transporter.verify();
  } catch (err) {
    throw new AccountError(
      `SMTP 连接失败：${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
  return folders;
}

/**
 * 文件夹预览（2026-10-07）：用**表单里现填的连接参数**登录并列出文件夹，
 * 供「添加账号」时的文件夹选择器使用（账号还没落盘，拿不到 id 就走这条）。
 * 已保存账号在编辑时可以不重填密码 —— 那时用已存凭据。
 */
export async function previewFolders(
  ctx: WebmailContext,
  input: {
    id?: string;
    email?: string;
    imapHost?: string;
    imapPort?: number;
    imapSecure?: boolean;
    username?: string;
    password?: string;
  }
): Promise<{ folders: FolderInfo[]; suggested: string[] }> {
  const existing = input.id ? ctx.accounts.get(input.id) : undefined;
  let account: WebmailAccount;
  let cred: AccountCredential;
  if (existing && !input.password) {
    const stored = ctx.credentials.get(existing.id);
    if (!stored) throw new AccountError(`账号 ${existing.id} 缺少凭据`, 404);
    account = existing;
    cred = stored;
  } else {
    const imapHost = input.imapHost?.trim();
    const email = input.email?.trim();
    const password = input.password ?? "";
    if (!imapHost) throw new AccountError("缺少 IMAP 主机");
    if (!isPort(input.imapPort)) throw new AccountError("IMAP 端口非法（1-65535）");
    if (typeof input.imapSecure !== "boolean") throw new AccountError("imapSecure 必须是布尔值");
    if (!password) throw new AccountError("缺少密码（或授权码）");
    if (!email || !EMAIL_RE.test(email)) throw new AccountError("邮箱地址非法");
    account = {
      id: existing?.id ?? "__preview__",
      displayName: existing?.displayName ?? email,
      email,
      provider: existing?.provider ?? "custom",
      // 探测用的临时对象，不落盘：颜色只是占位（真正入库时由 addAccount 分配）
      color: existing?.color ?? ACCOUNT_COLOR_PALETTE[0],
      imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      smtpHost: existing?.smtpHost ?? imapHost,
      smtpPort: existing?.smtpPort ?? 465,
      smtpSecure: existing?.smtpSecure ?? true,
      folders: ["INBOX"],
      enabled: true,
    };
    cred = { username: input.username?.trim() || email, password };
  }
  // 连接失败按 502 回（与新增/编辑账号的连接测试同一语义：连不上是"上游不可用"，
  // 不是客户端错误）；不包装的话会落到 API 层的兜底 500，前端与测试都分不清
  let folders: FolderInfo[];
  try {
    folders = await listAccountFolders(account, cred);
  } catch (err) {
    throw new AccountError(
      `IMAP 连接失败：${err instanceof Error ? err.message : String(err)}`,
      502
    );
  }
  return { folders, suggested: suggestSyncFolders(folders) };
}

/** 原子写 JSON（tmp + rename）；凭证文件顺手收紧到 600 */
function atomicWriteJson(file: string, value: unknown, mode?: number): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  if (mode) chmodSync(tmp, mode);
  renameSync(tmp, file);
}

function persistAccounts(ctx: WebmailContext): void {
  const file = join(ctx.dataDir, "accounts.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as WebmailAccountsFile;
  atomicWriteJson(file, { ...raw, accounts: [...ctx.accounts.values()] });
}

function persistCredentials(ctx: WebmailContext): void {
  const file = join(ctx.dataDir, "credentials.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as CredentialsFile;
  const next: CredentialsFile = { ...raw };
  for (const id of Object.keys(next)) {
    if (!ctx.accounts.has(id)) delete next[id];
  }
  for (const [id, cred] of ctx.credentials) next[id] = cred;
  atomicWriteJson(file, next, 0o600);
}

export interface AccountSummary {
  id: string;
  displayName: string;
  email: string;
  provider: string;
  color: string;
  folders: string[];
  enabled: boolean;
  /** 发件人姓名（随邮件发出的 From 显示名；空串 = 不带名字） */
  senderName: string;
}

function toSummary(a: WebmailAccount): AccountSummary {
  return {
    id: a.id,
    displayName: a.displayName,
    email: a.email,
    provider: a.provider,
    color: a.color,
    folders: a.folders,
    enabled: a.enabled,
    senderName: a.senderName ?? "",
  };
}

/**
 * 清掉某个账号 id 的**残留同步状态**（2026-10-08）：folders 行（水位线 + 回填游标）
 * 与本地副本，连带孤儿消息、FTS 行与磁盘上的原文。
 *
 * ⚠ **folders 行必须一起清**：账号 id 由邮箱地址推导（deriveId），删掉再加同一个邮箱 =
 * 同一个 id，残留的水位线（last_seen_uid）会被新账号**继承** → 服务端几千封邮件全被当成
 * 「早就抓过了」，既不抓也不回填，界面连进度都没有、也没有任何报错（用户报「加了账号
 * 毫无动静」）。同一个 id 的同步状态只属于被删的那个账号，留着它没有合法用途。
 *
 * ⚠ 删行与孤儿清理必须在一个事务里（2026-10-07）：避免中途失败留下「副本没了、正文与
 *   索引还在」的半截状态。⚠ 孤儿清理走 pruneOrphanMessages 的**集合化**写法（2026-10-08，
 *   旧实现逐封 `DELETE ... WHERE message_id = ?`：FTS 的 message_id 是 UNINDEXED 列，
 *   逐封删 = 每次全表扫 = O(n²)，6516 封实测 41.3 秒，且 better-sqlite3 是同步 API、
 *   整个 webmaild 被占住）。原文文件留到事务提交后再删（见 removeEmlFiles 的说明）。
 */
function purgeAccountState(ctx: WebmailContext, id: string): void {
  const stale = (
    ctx.db.prepare("SELECT DISTINCT message_id FROM copies WHERE account_id = ?").all(id) as {
      message_id: string;
    }[]
  ).map((r) => r.message_id);
  const pruned = ctx.db.transaction(() => {
    ctx.db.prepare("DELETE FROM folders WHERE account_id = ?").run(id);
    ctx.db.prepare("DELETE FROM copies WHERE account_id = ?").run(id);
    return stale.length > 0
      ? pruneOrphanMessages(ctx.db, { candidates: stale, collectEml: true })
      : { removed: 0, emlPaths: [] as string[] };
  })();
  removeEmlFiles(ctx.dataDir, pruned.emlPaths);
}

/**
 * 新增账号：校验 → 连接测试（可用 opts.test=false 关闭，供测试）→ 落盘 → 进 ctx。
 * 顺序保证「测试不过的账号不会出现在任何状态里」。
 */
export async function addAccount(
  ctx: WebmailContext,
  input: AddAccountInput,
  opts: { test?: boolean } = {}
): Promise<AccountSummary> {
  // 未显式指定同步文件夹（缺省或空数组）= 让服务端清单决定：新增账号时自动选中
  // INBOX + 已发送 / 草稿 / 已删除 / 垃圾邮件（2026-10-07）。不这么做的话新账号
  // 只同步 INBOX，而「发件」页依赖服务器「已发送」在白名单里 → 永远是空的。
  const autoFolders = !input.folders || input.folders.length === 0;
  const { account, cred } = normalizeAccountInput(
    autoFolders ? { ...input, folders: ["INBOX"] } : input,
    new Set(ctx.accounts.keys()),
    [...ctx.accounts.values()].map((a) => a.color)
  );
  let detected: FolderInfo[] = [];
  if (opts.test !== false) detected = await testAccountConnection(account, cred);
  if (autoFolders && detected.length > 0) {
    const suggested = suggestSyncFolders(detected);
    if (suggested.length > 0) account.folders = suggested;
  }
  // 连接测试**通过之后**才清残留（测试不过就不该动库里任何东西）：这个 id 上一次被删时
  // 留下的 folders 行会让新账号继承旧水位线，结果一封信都下不来（见 purgeAccountState）。
  purgeAccountState(ctx, account.id);
  ctx.accounts.set(account.id, account);
  ctx.credentials.set(account.id, cred);
  try {
    persistAccounts(ctx);
    persistCredentials(ctx);
  } catch (err) {
    // 落盘失败：回滚内存态，避免「内存有、磁盘无」的分裂
    ctx.accounts.delete(account.id);
    ctx.credentials.delete(account.id);
    throw err;
  }
  return toSummary(account);
}

/**
 * 修改账号（2026-10-06 用户需求）：显示名（备注）/ 发件人姓名 / 邮箱地址 / IMAP・SMTP
 * 主机端口与加密 / 用户名 / 密码（留空 = 不改）/ 同步文件夹。
 *
 * - 校验与新增同一套规则；`username` / `password` 留空保持原凭据。
 * - **连接相关字段变化（邮箱 / 主机 / 端口 / 加密 / 用户名 / 密码）才做连接测试**
 *   ——只改备注名 / 发件人姓名 / 文件夹这类元数据不必等网络往返（保存即时反馈）。
 * - 测试通过才落盘；落盘失败回滚内存态（与 addAccount 同一顺序保证）。
 */
export async function updateAccount(
  ctx: WebmailContext,
  id: string,
  input: UpdateAccountInput,
  opts: { test?: boolean } = {}
): Promise<AccountSummary> {
  const current = ctx.accounts.get(id);
  if (!current) throw new AccountError(`账号不存在：${id}`, 404);
  const cred = ctx.credentials.get(id);
  if (!cred) throw new AccountError(`账号 ${id} 缺少凭据`, 500);

  const displayName = input.displayName !== undefined ? input.displayName.trim() : current.displayName;
  const email = input.email !== undefined ? input.email.trim() : current.email;
  const imapHost = input.imapHost !== undefined ? input.imapHost.trim() : current.imapHost;
  const smtpHost = input.smtpHost !== undefined ? input.smtpHost.trim() : current.smtpHost;
  const imapPort = input.imapPort !== undefined ? input.imapPort : current.imapPort;
  const smtpPort = input.smtpPort !== undefined ? input.smtpPort : current.smtpPort;
  const imapSecure = input.imapSecure !== undefined ? input.imapSecure : current.imapSecure;
  const smtpSecure = input.smtpSecure !== undefined ? input.smtpSecure : current.smtpSecure;
  if (!displayName) throw new AccountError("缺少备注名");
  if (!email || !EMAIL_RE.test(email)) throw new AccountError("邮箱地址非法");
  if (!imapHost) throw new AccountError("缺少 IMAP 主机");
  if (!smtpHost) throw new AccountError("缺少 SMTP 主机");
  if (!isPort(imapPort)) throw new AccountError("IMAP 端口非法（1-65535）");
  if (!isPort(smtpPort)) throw new AccountError("SMTP 端口非法（1-65535）");
  if (typeof imapSecure !== "boolean" || typeof smtpSecure !== "boolean") {
    throw new AccountError("imapSecure / smtpSecure 必须是布尔值");
  }

  const folders = (
    input.folders !== undefined ? input.folders : current.folders
  )
    .map((f) => String(f).trim())
    .filter((f) => f.length > 0);
  if (folders.length === 0) throw new AccountError("同步文件夹至少保留一个（如 INBOX）");

  const nextUsername = input.username?.trim() || cred.username;
  const nextPassword = input.password ? input.password : cred.password;

  const next: WebmailAccount = {
    ...current,
    displayName,
    email,
    provider: input.provider?.trim() || current.provider,
    color: input.color?.trim() || current.color,
    imapHost,
    imapPort,
    imapSecure,
    smtpHost,
    smtpPort,
    smtpSecure,
    folders,
  };
  // senderName 允许清空（空串 = 恢复「只发地址」）；undefined = 保持原值
  if (input.senderName !== undefined) {
    const senderName = input.senderName.trim();
    if (senderName) next.senderName = senderName;
    else delete next.senderName;
  }
  const nextCred: AccountCredential = { username: nextUsername, password: nextPassword };

  const connectionChanged =
    email !== current.email ||
    imapHost !== current.imapHost ||
    imapPort !== current.imapPort ||
    imapSecure !== current.imapSecure ||
    smtpHost !== current.smtpHost ||
    smtpPort !== current.smtpPort ||
    smtpSecure !== current.smtpSecure ||
    nextUsername !== cred.username ||
    nextPassword !== cred.password;
  if (opts.test !== false && connectionChanged) await testAccountConnection(next, nextCred);

  const prevAccount = current;
  const prevCred = cred;
  ctx.accounts.set(id, next);
  ctx.credentials.set(id, nextCred);
  try {
    persistAccounts(ctx);
    persistCredentials(ctx);
  } catch (err) {
    ctx.accounts.set(id, prevAccount);
    ctx.credentials.set(id, prevCred);
    throw err;
  }
  return toSummary(next);
}

/**
 * 删除账号：移出注册表与凭据（落盘），并清掉本地已同步的副本 / 同步状态 / 孤儿邮件。
 * 服务器上的邮件不受影响（本站只做只读同步与显式删除）。
 *
 * ⚠ 清理逻辑集中在 purgeAccountState（删除与「新增前清残留」共用一份，避免两处漂移）。
 */
export function deleteAccount(ctx: WebmailContext, id: string): AccountSummary {
  const account = ctx.accounts.get(id);
  if (!account) throw new AccountError(`账号不存在：${id}`, 404);
  if (ctx.accounts.size <= 1) throw new AccountError("至少保留一个账号", 409);

  purgeAccountState(ctx, id);

  ctx.accounts.delete(id);
  ctx.credentials.delete(id);
  ctx.syncStates.delete(id);
  persistAccounts(ctx);
  persistCredentials(ctx);
  return toSummary(account);
}

/** 域名格式：至少两个标签（白名单是给公网图片域名用的，单标签如 localhost 无意义） */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * 远程图片白名单（4.4）：归一化（trim / 小写 / 去空 / 去重）+ 校验 + 落盘到
 * accounts.json 顶层字段。写 ctx 后即时生效（renderMailHtml 每次渲染现读），无需重启。
 * 匹配语义见 render.ts 的 whitelisted()：精确命中或子域名后缀匹配。
 */
export function setRemoteImageDomains(ctx: WebmailContext, input: unknown): { domains: string[] } {
  if (!Array.isArray(input)) throw new AccountError("domains 必须是字符串数组");
  const domains = [
    ...new Set(
      input.map((d) => String(d).trim().toLowerCase()).filter((d) => d.length > 0)
    ),
  ];
  for (const d of domains) {
    if (d.length > 253 || !DOMAIN_RE.test(d)) {
      throw new AccountError(`域名非法：${d}`);
    }
  }
  const file = join(ctx.dataDir, "accounts.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as WebmailAccountsFile;
  atomicWriteJson(file, { ...raw, remoteImageDomains: domains });
  ctx.remoteImageDomains = domains;
  return { domains };
}
