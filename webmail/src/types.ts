import type { AccountConfig } from "../../mail/src/types.js";

/** webmail 侧账号：在共享注册表结构上增加 SMTP 字段（4.6：两份注册表，结构不同） */
export interface WebmailAccount extends AccountConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /**
   * 发件人姓名（2026-10-06 用户定稿）：随邮件发出的 From 显示名。
   * ⚠ 与 `displayName`（本地备注名，仅站内 UI 显示）**是两个字段**——备注名绝不会
   * 出现在外发邮件里（曾把「我」当发件人姓名发出去，用户报障）；留空 = From 只带
   * 邮箱地址，不带名字。
   */
  senderName?: string;
}

export interface WebmailAccountsFile {
  accounts: WebmailAccount[];
  /** 远程图片白名单域名（4.4），如 ["edu.cn", "springer.com"]，匹配宿主或其子域 */
  remoteImageDomains?: string[];
}

export interface SendAttachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface SendInput {
  accountId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  /** 请求已读回执（MDN）：写 Disposition-Notification-To 头 */
  readReceipt?: boolean;
  attachments?: SendAttachment[];
  /** 来自草稿的发送：成功后删除该草稿（写信页的服务器端草稿，见 drafts.ts） */
  draftId?: string;
}

export interface SendResult {
  messageId: string;
  sentFolder: string;
}

export interface CopyRef {
  accountId: string;
  folder: string;
  uid: number;
}

export interface FlagChange {
  seen?: boolean;
  flagged?: boolean;
}
