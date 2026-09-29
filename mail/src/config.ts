import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountConfig, AccountsFile, CredentialsFile } from "./types.js";

/** 邮件库根目录：accounts.json / credentials.json / mail.db / eml/ */
export function mailDataDir(): string {
  return process.env.MAIL_DATA_DIR ?? join(process.cwd(), "data", "mail");
}

export function loadAccounts(dir: string = mailDataDir()): AccountConfig[] {
  const raw = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")) as AccountsFile;
  if (!Array.isArray(raw.accounts)) {
    throw new Error("accounts.json 缺少 accounts 数组");
  }
  for (const a of raw.accounts) {
    if (!a.id || !a.displayName || !a.email || !a.imapHost) {
      throw new Error(`accounts.json: 账号缺少必填字段（id/displayName/email/imapHost）`);
    }
    if (!Number.isInteger(a.imapPort)) {
      throw new Error(`accounts.json: ${a.id} 的 imapPort 非法`);
    }
    if (typeof a.imapSecure !== "boolean") {
      throw new Error(`accounts.json: ${a.id} 的 imapSecure 非法`);
    }
    if (!Array.isArray(a.folders) || a.folders.length === 0) {
      throw new Error(`accounts.json: ${a.id} 的 folders 为空`);
    }
  }
  return raw.accounts;
}

export function loadCredentials(dir: string = mailDataDir()): CredentialsFile {
  return JSON.parse(readFileSync(join(dir, "credentials.json"), "utf8")) as CredentialsFile;
}

/** CalDAV 写入配置（create_event 用）：accounts.json 的 caldav 段 + credentials.json 的 "caldav" 键 */
export function loadCaldav(
  dir: string = mailDataDir()
): { url: string; collection: string; username: string; password: string } | null {
  const raw = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")) as AccountsFile;
  if (!raw.caldav?.url) return null;
  const cred = loadCredentials(dir)["caldav"];
  if (!cred) return null;
  return {
    url: raw.caldav.url.replace(/\/$/, ""),
    collection: raw.caldav.collection ?? "agent-schedule",
    username: cred.username,
    password: cred.password,
  };
}

/** 模型配置（worker 池用）：accounts.json 的 model 段 + credentials.json 的 "model" 键（apiKey） */
export function loadModel(
  dir: string = mailDataDir()
): { baseURL: string; model: string; apiKey: string; reportHour: number } | null {
  const raw = JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")) as AccountsFile;
  if (!raw.model?.baseURL || !raw.model.model) return null;
  const apiKey = loadCredentials(dir)["model"]?.password;
  if (!apiKey) return null;
  return {
    baseURL: raw.model.baseURL.replace(/\/$/, ""),
    model: raw.model.model,
    apiKey,
    reportHour: raw.model.reportHour ?? 21,
  };
}
