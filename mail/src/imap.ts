import { ImapFlow } from "imapflow";
import type { AccountConfig, AccountCredential } from "./types.js";

export async function connectAccount(
  account: AccountConfig,
  cred: AccountCredential
): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    auth: { user: cred.username, pass: cred.password },
    logger: false,
    // 显式超时：服务端无响应时 fast-fail，而非无限挂起
    socketTimeout: 30_000,
  });
  await client.connect();
  return client;
}

export interface EnvelopeInfo {
  date?: Date;
  subject?: string;
  from?: { name?: string; address?: string }[];
  to?: { name?: string; address?: string }[];
  cc?: { name?: string; address?: string }[];
  messageId?: string;
}

export interface NewMeta {
  uid: number;
  flags: string[];
  internalDate: Date | null;
  size: number;
  envelope?: EnvelopeInfo;
}

/** 打开文件夹一律 readOnly → EXAMINE，永不 SELECT（MAIL-AGENT.md 3.2） */
export async function openReadOnly(client: ImapFlow, folder: string): Promise<number> {
  await client.mailboxOpen(folder, { readOnly: true });
  const mb = client.mailbox;
  if (!mb) throw new Error(`mailboxOpen 后无 mailbox 状态：${folder}`);
  return Number(mb.uidValidity);
}

/**
 * 列出 lastSeenUid 之后的新邮件元数据（envelope 级，不含正文）。
 * 注意必须先收集完再返回：fetch 流未耗尽时在同一连接上发新命令会死锁。
 */
export async function listNewMeta(
  client: ImapFlow,
  folder: string,
  lastSeenUid: number
): Promise<NewMeta[]> {
  await openReadOnly(client, folder);
  // RFC 3501：UID n:* 永远至少命中最后一封（即使 n 大于最大 UID），必须自行过滤
  const uids = ((await client.search({ uid: `${lastSeenUid + 1}:*` }, { uid: true })) || []).filter(
    (u) => u > lastSeenUid
  );
  if (uids.length === 0) return [];
  const out: NewMeta[] = [];
  for await (const msg of client.fetch(
    uids,
    { uid: true, flags: true, internalDate: true, size: true, envelope: true },
    { uid: true }
  )) {
    out.push({
      uid: msg.uid,
      flags: msg.flags ? [...msg.flags] : [],
      internalDate: msg.internalDate ? new Date(msg.internalDate) : null,
      size: msg.size ?? 0,
      envelope: msg.envelope as EnvelopeInfo | undefined,
    });
  }
  return out;
}

/**
 * 取单封邮件完整原文。
 * imapflow 2.x 的 source 抓取走 BODY.PEEK[]（commands/fetch.js 注释明确：
 * "PEEK avoids marking messages as \Seen"），且此处另有常驻行为测试兜底（7.1）。
 */
export async function fetchSource(client: ImapFlow, uid: number): Promise<Buffer | null> {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
  if (!msg || !msg.source) return null;
  return msg.source as Buffer;
}

export interface FlagEntry {
  uid: number;
  flags: string[];
}

/** 标记回读：拉取 since 之后邮件的 FLAGS（纯读取，3.5）。同样先收集完再返回 */
export async function listFlagsSince(
  client: ImapFlow,
  folder: string,
  since: Date
): Promise<FlagEntry[]> {
  await openReadOnly(client, folder);
  const uids = (await client.search({ since }, { uid: true })) || [];
  if (uids.length === 0) return [];
  const out: FlagEntry[] = [];
  for await (const msg of client.fetch(uids, { uid: true, flags: true }, { uid: true })) {
    out.push({ uid: msg.uid, flags: msg.flags ? [...msg.flags] : [] });
  }
  return out;
}
