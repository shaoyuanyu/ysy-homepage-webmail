import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { connectAccount } from "../../mail/src/imap.js";
import type { AccountCredential } from "../../mail/src/types.js";
import type { SendInput, SendResult, WebmailAccount } from "./types.js";
import { appendRaw, detectSentFolder } from "./write.js";

const ADDRESS_RE = /^[^\s@,;<>]+@[^\s@,;<>]+$/;

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
    // From 的显示名用 senderName（发件人姓名，随邮件对外）——**不是** displayName
    // （本地备注名，仅站内 UI 用；2026-10-06 用户报障：备注名「我」被当成发件人姓名
    // 发出）。senderName 为空 = From 只有邮箱地址，不带名字。
    from: account.senderName ? `"${account.senderName}" <${account.email}>` : account.email,
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
  const imap = await connectAccount(account, cred);
  let sentFolder: string;
  try {
    const detected = await detectSentFolder(imap);
    if (!detected) {
      throw new Error(`账号 ${account.id} 找不到「已发送」文件夹（\\Sent 与常见名均无）`);
    }
    sentFolder = detected;
  } catch (err) {
    await imap.logout().catch(() => {});
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
    await imap.logout().catch(() => {});
  }

  return { messageId, sentFolder };
}
