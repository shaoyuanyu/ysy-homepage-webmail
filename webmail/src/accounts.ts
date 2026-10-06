import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import type { AccountCredential, CredentialsFile } from "../../mail/src/types.js";
import type { WebmailContext } from "./api.js";
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

/** 校验 + 归一化输入；返回可入库的账号与凭据（不做任何网络/落盘动作） */
export function normalizeAccountInput(
  input: AddAccountInput,
  existingIds: Set<string>
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
    color: input.color?.trim() || "#0ea5e9",
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
 * 连接测试：IMAP 登录（connect + logout）与 SMTP verify 都通过才算可用。
 * 失败抛 AccountError（502）并带原始错误信息，不落盘、不进 ctx。
 */
export async function testAccountConnection(
  account: WebmailAccount,
  cred: AccountCredential
): Promise<void> {
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
 * 新增账号：校验 → 连接测试（可用 opts.test=false 关闭，供测试）→ 落盘 → 进 ctx。
 * 顺序保证「测试不过的账号不会出现在任何状态里」。
 */
export async function addAccount(
  ctx: WebmailContext,
  input: AddAccountInput,
  opts: { test?: boolean } = {}
): Promise<AccountSummary> {
  const { account, cred } = normalizeAccountInput(input, new Set(ctx.accounts.keys()));
  if (opts.test !== false) await testAccountConnection(account, cred);
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
 * 删除账号：移出注册表与凭据（落盘），并清掉本地已同步的副本/孤儿邮件。
 * 服务器上的邮件不受影响（本站只做只读同步与显式删除）。
 */
export function deleteAccount(ctx: WebmailContext, id: string): AccountSummary {
  const account = ctx.accounts.get(id);
  if (!account) throw new AccountError(`账号不存在：${id}`, 404);
  if (ctx.accounts.size <= 1) throw new AccountError("至少保留一个账号", 409);

  const messageIds = ctx.db
    .prepare("SELECT DISTINCT message_id AS mid FROM copies WHERE account_id = ?")
    .all(id) as { mid: string }[];
  ctx.db.prepare("DELETE FROM copies WHERE account_id = ?").run(id);
  for (const { mid } of messageIds) {
    const left = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM copies WHERE message_id = ?")
      .get(mid) as { n: number };
    if (left.n === 0) {
      ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run(mid);
      ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(mid);
    }
  }

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
