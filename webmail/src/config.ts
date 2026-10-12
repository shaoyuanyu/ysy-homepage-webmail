import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialsFile } from "../../mail/src/types.js";
import type { WebmailAccount, WebmailAccountsFile } from "./types.js";

/** webmail 数据根目录：accounts.json / credentials.json / webmail.db / eml/（与 agent 侧各自持有，4.5） */
export function webmailDataDir(): string {
  return process.env.WEBMAIL_DATA_DIR ?? join(process.cwd(), "data", "webmail");
}

export function loadAccounts(dir: string = webmailDataDir()): {
  accounts: WebmailAccount[];
  remoteImageDomains: string[];
} {
  const raw = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")) as WebmailAccountsFile;
  if (!Array.isArray(raw.accounts)) {
    throw new Error("accounts.json 缺少 accounts 数组");
  }
  for (const a of raw.accounts) {
    // ⚠ `displayName` 允许**空串**（2026-10-11：没有备注名，站内显示退回邮箱地址）。
    //   它是必需字段，但不必有内容：写成 `!a.displayName` 会让「没备注名」的账号在
    //   webmaild 下次启动时直接抛错起不来（accounts.json 是 persistAccounts 写回的）。
    if (!a.id || typeof a.displayName !== "string" || !a.email || !a.imapHost) {
      throw new Error(`accounts.json: 账号缺少必填字段（id/displayName/email/imapHost）`);
    }
    if (!Number.isInteger(a.imapPort) || typeof a.imapSecure !== "boolean") {
      throw new Error(`accounts.json: ${a.id} 的 imapPort / imapSecure 非法`);
    }
    if (!a.smtpHost || !Number.isInteger(a.smtpPort) || typeof a.smtpSecure !== "boolean") {
      throw new Error(`accounts.json: ${a.id} 缺少 SMTP 字段（smtpHost/smtpPort/smtpSecure）`);
    }
    if (!Array.isArray(a.folders) || a.folders.length === 0) {
      throw new Error(`accounts.json: ${a.id} 的 folders 为空`);
    }
  }
  const remoteImageDomains = (raw.remoteImageDomains ?? []).map((d) => d.toLowerCase());
  return { accounts: raw.accounts, remoteImageDomains };
}

export function loadCredentials(dir: string = webmailDataDir()): CredentialsFile {
  return JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as CredentialsFile;
}
