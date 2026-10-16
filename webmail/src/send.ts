import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { connectAccount } from "../../mail/src/imap.js";
import { acquireConnection, releaseConnection } from "./pool.js";
import type { AccountCredential } from "../../mail/src/types.js";
import type { SendInput, SendResult, WebmailAccount } from "./types.js";
import { appendRaw, detectSentFolder } from "./write.js";

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

/**
 * From 头的值（2026-10-16 起单点判定）。
 *
 * 显示名的优先级在**调用处**给（`临时署名 || 账号 senderName`），这里只管形态：
 * 有名字 = `"名字" <地址>`，没名字 = 只发地址。与 `draft-mirror.ts` 的草稿 From 同一格式
 * （那边的调用处用 `row.from_name || account.senderName`）。
 */
export function formatFrom(email: string, name?: string): string {
  // 引号 / 换行会破坏 From 头的引号包裹（也堵住自造头的注入面）：一律去掉。
  // 中文、空格、标点都留着——那些由 MailComposer 做 MIME 编码。
  const clean = name?.replace(/["\r\n]/g, "").trim();
  return clean ? `"${clean}" <${email}>` : email;
}

function assertAddresses(label: string, list: string[]): void {
  for (const addr of list) {
    if (!ADDRESS_RE.test(addr.trim())) {
      throw new Error(`${label} 含非法地址：${addr}`);
    }
  }
}

/**
 * 发信：MailComposer 构造一次 MIME → 同一份字节发两次（红线 6）：
 * SMTP 发出 + IMAP APPEND 到该账号「已发送」。
 * Message-ID 由本进程生成并写进 MIME，SMTP 与 APPEND 共用，会话不会断成两封。
 */
export async function sendMessage(
  account: WebmailAccount,
  cred: AccountCredential,
  input: SendInput
): Promise<SendResult> {
  if (input.accountId !== account.id) {
    throw new Error(`accountId 不匹配：${input.accountId} vs ${account.id}`);
  }
  if (!input.to || input.to.length === 0) throw new Error("收件人为空");
  assertAddresses("to", input.to);
  assertAddresses("cc", input.cc ?? []);
  assertAddresses("bcc", input.bcc ?? []);

  const domain = account.email.split("@")[1] ?? "localhost";
  const messageId = `<${Date.now()}.${randomBytes(12).toString("hex")}@${domain}>`;

  const composer = new MailComposer({
    // From 的显示名：**临时署名（`fromName`，写信页本封专用的「显示名」）优先**，
    // 其次才是账号的 senderName（发件人姓名，随邮件对外）——**不是** displayName
    // （本地备注名，仅站内 UI 用；2026-10-06 用户报障：备注名「我」被当成发件人姓名
    // 发出）。两者都为空 = From 只有邮箱地址，不带名字。
    from: formatFrom(account.email, (input.fromName ?? "").trim() || account.senderName),
    to: input.to.join(", "),
    cc: input.cc?.join(", "),
    bcc: input.bcc?.join(", "),
    subject: input.subject,
    text: input.text,
    html: input.html,
    inReplyTo: input.inReplyTo,
    references: input.references,
    // 已读回执请求（MDN，RFC 8098）：只写裸地址（displayName 可能含非 ASCII，
    // 自定义头不会做 MIME 编码）；Bcc 由 MailComposer 默认从头部剔除（keepBcc=false），
    // 仅进 SMTP envelope，不泄露给收件人
    headers: input.readReceipt ? { "Disposition-Notification-To": account.email } : undefined,
    messageId,
    attachments: (input.attachments ?? []).map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: Buffer.from(a.contentBase64, "base64"),
    })),
  });
  const raw = await composer.compile().build();

  // 先探测「已发送」文件夹：找不到就拒发（红线 5：不留底到错误位置、也不出现已发出却没留底）
  // ⚠ 连接走池（pool.ts）。这里它会在 **SMTP 发送期间一直握着**（可能几十秒）——取用期间
  //   池不保活，而服务端的空闲超时是分钟级，不会因此被断。
  const imap = await acquireConnection(account.id, () => connectAccount(account, cred));
  let sentFolder: string;
  try {
    const detected = await detectSentFolder(imap);
    if (!detected) {
      throw new Error(`账号 ${account.id} 找不到「已发送」文件夹（\\Sent 与常见名均无）`);
    }
    sentFolder = detected;
  } catch (err) {
    releaseConnection(imap);
    throw err;
  }

  // SMTP 与 APPEND 用同一份 raw 字节
  const transport = nodemailer.createTransport({
    host: account.smtpHost,
    port: account.smtpPort,
    secure: account.smtpSecure,
    auth: { user: cred.username, pass: cred.password },
    connectionTimeout: 30_000,
    socketTimeout: 30_000,
  });
  const envelope = {
    from: account.email,
    to: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])],
  };
  try {
    await transport.sendMail({ raw, envelope });
  } finally {
    transport.close();
  }

  try {
    await appendRaw(imap, sentFolder, raw);
  } finally {
    releaseConnection(imap);
  }

  return { messageId, sentFolder };
}
