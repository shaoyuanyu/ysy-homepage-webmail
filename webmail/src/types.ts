import type { AccountConfig } from "../../mail/src/types.js";

/** webmail 侧账号：在共享注册表结构上增加 SMTP 字段（4.6：两份注册表，结构不同） */
export interface WebmailAccount extends AccountConfig {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
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
  attachments?: SendAttachment[];
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
