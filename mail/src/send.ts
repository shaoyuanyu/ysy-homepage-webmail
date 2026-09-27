import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ImapFlow } from "imapflow";
import { connectAccount } from "./imap.js";
import type { AccountConfig, CredentialsFile } from "./types.js";
import {
  appendLedger,
  getPendingSend,
  insertPendingSend,
  markPendingSend,
  type AgentDb,
} from "./ledger.js";
import { withAccountLock } from "./flags.js";

/**
 * send_as_agent：agent 唯一的发信通道（3.4），带 3.7 的发信闸门。
 * - 白名单（= 注册表里除 agent 外全部账号地址）内直发；
 * - 白名单外进 pending_sends 待确认队列，由人通过 HTTP 端点 confirm/discard
 *   （不 exposed 成 MCP 工具，agent 不能自己开闸）。
 * v1 只支持纯文本正文，不支持附件（5.3）。
 */

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

function assertAddresses(label: string, list: string[]): void {
  for (const addr of list) {
    if (!ADDRESS_RE.test(addr.trim())) {
      throw new Error(`${label} 含非法地址：${addr}`);
    }
  }
}

export interface AgentSendRequest {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
}

export type AgentSendResult =
  | { status: "sent"; messageId: string }
  | { status: "pending"; id: number };

function requireAgentAccount(accounts: AccountConfig[], creds: CredentialsFile) {
  const agent = accounts.find((a) => a.isAgent);
  if (!agent) throw new Error("accounts.json 中没有 isAgent 账号");
  const cred = creds[agent.id];
  if (!cred) throw new Error(`credentials.json 缺少 agent 账号 ${agent.id} 的凭据`);
  if (!agent.smtpHost || !agent.smtpPort || typeof agent.smtpSecure !== "boolean") {
    throw new Error(`agent 账号 ${agent.id} 缺少 SMTP 字段（smtpHost/smtpPort/smtpSecure）`);
  }
  return { agent, cred };
}

/** 发信闸门白名单：注册表里除 agent 外的全部账号地址（3.7：你的三个地址） */
export function sendWhitelist(accounts: AccountConfig[]): Set<string> {
  return new Set(accounts.filter((a) => !a.isAgent).map((a) => a.email.toLowerCase()));
}

export async function sendAsAgent(opts: {
  agentDb: AgentDb;
  accounts: AccountConfig[];
  creds: CredentialsFile;
  req: AgentSendRequest;
}): Promise<AgentSendResult> {
  const { agentDb, accounts, creds, req } = opts;
  const { agent, cred } = requireAgentAccount(accounts, creds);
  if (!req.to || req.to.length === 0) throw new Error("收件人为空");
  assertAddresses("to", req.to);
  assertAddresses("cc", req.cc ?? []);

  const domain = agent.email.split("@")[1] ?? "localhost";
  const messageId = `<${Date.now()}.${randomBytes(12).toString("hex")}@${domain}>`;
  const composer = new MailComposer({
    from: agent.displayName ? `"${agent.displayName}" <${agent.email}>` : agent.email,
    to: req.to.join(", "),
    cc: req.cc?.length ? req.cc.join(", ") : undefined,
    subject: req.subject,
    text: req.text,
    inReplyTo: req.inReplyTo,
    references: req.inReplyTo ? [req.inReplyTo] : undefined,
    messageId,
  });
  // MIME 在闸门判定前构造：待确认队列存的就是这份字节，确认后原样发出
  const mime = await composer.compile().build();
  const recipients = [...req.to, ...(req.cc ?? [])];

  const whitelist = sendWhitelist(accounts);
  const blocked = recipients.filter((r) => !whitelist.has(r.trim().toLowerCase()));

  if (blocked.length > 0) {
    const id = insertPendingSend(agentDb, {
      to: req.to,
      cc: req.cc ?? [],
      subject: req.subject,
      text: req.text,
      mime,
      messageId,
    });
    appendLedger(agentDb, {
      tool: "send_as_agent",
      ok: true,
      messageId,
      detail: { to: req.to, cc: req.cc ?? [], subject: req.subject, decision: "pending", pendingId: id, blocked },
    });
    return { status: "pending", id };
  }

  await deliver(agent, cred, mime, recipients);
  appendLedger(agentDb, {
    tool: "send_as_agent",
    ok: true,
    messageId,
    detail: { to: req.to, cc: req.cc ?? [], subject: req.subject, decision: "direct" },
  });
  return { status: "sent", messageId };
}

/** 确认待确认队列中的外发（人操作，HTTP 端点；非 MCP 工具） */
export async function confirmPendingSend(opts: {
  agentDb: AgentDb;
  accounts: AccountConfig[];
  creds: CredentialsFile;
  id: number;
}): Promise<{ messageId: string }> {
  const { agentDb, accounts, creds, id } = opts;
  // 先查行（不存在的 id 报「不存在」而不是「没有 isAgent 账号」——错误要先说人话）
  const row = getPendingSend(agentDb, id);
  if (!row) throw new Error(`待确认队列不存在：${id}`);
  if (row.status !== "pending") throw new Error(`该外发已处理（${row.status}）：${id}`);
  const { agent, cred } = requireAgentAccount(accounts, creds);

  const recipients = [
    ...(JSON.parse(row.to_json) as string[]),
    ...(JSON.parse(row.cc_json) as string[]),
  ];
  await deliver(agent, cred, row.mime, recipients);
  markPendingSend(agentDb, id, "sent");
  appendLedger(agentDb, {
    tool: "confirm_send",
    ok: true,
    messageId: row.message_id,
    detail: { pendingId: id, to: recipients, subject: row.subject },
  });
  return { messageId: row.message_id };
}

export async function discardPendingSend(opts: {
  agentDb: AgentDb;
  id: number;
}): Promise<void> {
  const { agentDb, id } = opts;
  const row = getPendingSend(agentDb, id);
  if (!row) throw new Error(`待确认队列不存在：${id}`);
  if (row.status !== "pending") throw new Error(`该外发已处理（${row.status}）：${id}`);
  markPendingSend(agentDb, id, "discarded");
  appendLedger(agentDb, {
    tool: "discard_send",
    ok: true,
    messageId: row.message_id,
    detail: { pendingId: id, subject: row.subject },
  });
}

/**
 * 同一份 MIME 字节发两次（红线 6）：SMTP 发出 + APPEND 到 agent@ 自己的「已发送」（3.3）。
 * 连接策略同 set_flags：短时第二条连接 + 账号互斥（5.3）。
 */
async function deliver(
  agent: AccountConfig,
  cred: { username: string; password: string },
  mime: Buffer,
  recipients: string[]
): Promise<void> {
  await withAccountLock(agent.id, async () => {
    const imap = await connectAccount(agent, cred);
    let sentFolder: string;
    try {
      // 先探测「已发送」：找不到就拒发（红线 5）
      const detected = await detectSentFolder(imap);
      if (!detected) {
        throw new Error(`agent 账号 ${agent.id} 找不到「已发送」文件夹（\\Sent 与常见名均无）`);
      }
      sentFolder = detected;
    } catch (err) {
      await imap.logout().catch(() => {});
      throw err;
    }

    const transport = nodemailer.createTransport({
      host: agent.smtpHost,
      port: agent.smtpPort,
      secure: agent.smtpSecure,
      auth: { user: cred.username, pass: cred.password },
      connectionTimeout: 30_000,
      socketTimeout: 30_000,
    });
    try {
      await transport.sendMail({ raw: mime, envelope: { from: agent.email, to: recipients } });
    } finally {
      transport.close();
    }

    try {
      const ok = await imap.append(sentFolder, mime, ["\\Seen"]);
      if (!ok) throw new Error(`APPEND 到 ${sentFolder} 失败`);
    } finally {
      await imap.logout().catch(() => {});
    }
  });
}

/** 「已发送」文件夹探测：优先 \Sent 特殊用途标志位（RFC 6154），回退常见名；找不到返回 null */
async function detectSentFolder(client: ImapFlow): Promise<string | null> {
  const boxes = await client.list();
  const byFlag = boxes.find((b) => b.specialUse === "\\Sent");
  if (byFlag) return byFlag.path;
  for (const name of ["Sent", "Sent Items", "已发送邮件", "已发送"]) {
    const hit = boxes.find((b) => b.path.toLowerCase() === name.toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}
