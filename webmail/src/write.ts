import type { ImapFlow } from "imapflow";
import type { FlagChange } from "./types.js";

/**
 * 读写打开（SELECT）。这是 webmail 包与 mail 包的分界线：
 * mail 包只有 EXAMINE，写操作全部集中在 webmail 包内（MAIL-AGENT.md 3.8、4.6）。
 */
export async function openReadWrite(client: ImapFlow, folder: string): Promise<void> {
  await client.mailboxOpen(folder, { readOnly: false });
}

/**
 * 按 UID 写标记（一律 +FLAGS / -FLAGS，绝不裸 FLAGS 整体替换，红线 2/3）。
 * webmail 是正常 webmail，\Seen / \Flagged / \Answered 等都在这里写。
 */
export async function setFlags(
  client: ImapFlow,
  folder: string,
  uid: number,
  change: FlagChange
): Promise<void> {
  await openReadWrite(client, folder);
  const add: string[] = [];
  const del: string[] = [];
  if (change.seen === true) add.push("\\Seen");
  if (change.seen === false) del.push("\\Seen");
  if (change.flagged === true) add.push("\\Flagged");
  if (change.flagged === false) del.push("\\Flagged");
  if (add.length > 0) {
    await client.messageFlagsAdd(String(uid), add, { uid: true });
  }
  if (del.length > 0) {
    await client.messageFlagsRemove(String(uid), del, { uid: true });
  }
}

/**
 * 批量补 \Seen（2026-10-05，「一键已读」用）：一次 STORE 写一组 UID。
 * 与 `setFlags` 同一红线（只 +FLAGS、绝不整体替换；一律 `{ uid: true }`）——
 * 「把一批未读标成已读」只需要加标记，不需要按 UID 逐个往返。
 * 调用方保证 uids 来自本地索引（copies 表），且已按文件夹分组。
 */
export async function setSeenBatch(
  client: ImapFlow,
  folder: string,
  uids: number[]
): Promise<void> {
  if (uids.length === 0) return;
  await openReadWrite(client, folder);
  await client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true });
}

/**
 * 「已发送」类文件夹的回退候选名（服务器没给 `\Sent` special-use 时的兜底，RFC 6154 之外）。
 *
 * ⚠ **与前端 `lib/mail/kind.ts` 的 `SENT_FOLDER_NAMES` 必须保持一致**（两边各一份，
 * 因为 webmail 是独立包、不能与主站互 import）：前端据它判断列表行显示发件人还是
 * 「发给 X」、webmaild 据它做 `direction=sent` 筛选——两处规则一旦不同，就会出现
 * 「筛出来显示不对」这类自相矛盾（2026-10-04 加方向筛选时两边对齐，含 Sent Messages）。
 */
export const SENT_FOLDER_NAMES = [
  "Sent",
  "Sent Items",
  "Sent Messages",
  "已发送邮件",
  "已发送",
];

/** 某个文件夹名是否属于「已发送」类（大小写不敏感；供 `direction=sent` 与前端判定复用） */
export function isSentFolderName(folder: string): boolean {
  const f = folder.trim().toLowerCase();
  return SENT_FOLDER_NAMES.some((n) => n.toLowerCase() === f);
}

/** 「已发送」文件夹探测：优先 \Sent 特殊用途标志位（RFC 6154），回退常见名；找不到返回 null */
export async function detectSentFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Sent", SENT_FOLDER_NAMES);
}

/** 「回收站」文件夹探测：同上，删除时优先移入 */
export async function detectTrashFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Trash", ["Trash", "Deleted Items", "已删除邮件", "已删除"]);
}

/**
 * 「草稿」文件夹的回退候选名（服务器没给 `\Drafts` special-use 时的兜底）。
 * 阿里企业邮实测给 `\Drafts`（草稿），此列表只作保险。
 */
export const DRAFTS_FOLDER_NAMES = ["Drafts", "Draft", "草稿", "草稿箱", "已草稿"];

/** 「草稿」文件夹探测：优先 \Drafts 特殊用途标志位（RFC 6154），回退常见名；找不到返回 null */
export async function detectDraftsFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Drafts", DRAFTS_FOLDER_NAMES);
}

async function detectSpecialFolder(
  client: ImapFlow,
  specialUse: string,
  fallbackNames: string[]
): Promise<string | null> {
  const boxes = await client.list();
  const byFlag = boxes.find((b) => b.specialUse === specialUse);
  if (byFlag) return byFlag.path;
  for (const name of fallbackNames) {
    const hit = boxes.find((b) => b.path.toLowerCase() === name.toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}

/** APPEND 原文到指定文件夹（留底用，红线 6：与 SMTP 发出的是同一份字节） */
export async function appendRaw(
  client: ImapFlow,
  folder: string,
  raw: Buffer,
  flags: string[] = ["\\Seen"]
): Promise<void> {
  const ok = await client.append(folder, raw, flags);
  if (!ok) throw new Error(`APPEND 到 ${folder} 失败`);
}

/**
 * 移动：imapflow 内部已处理 MOVE 扩展（RFC 6851）的探测，
 * 服务端不支持时回退 COPY + \Deleted + EXPUNGE。
 */
export async function moveUid(
  client: ImapFlow,
  folder: string,
  uid: number,
  dest: string
): Promise<void> {
  await openReadWrite(client, folder);
  const ok = await client.messageMove(String(uid), dest, { uid: true });
  if (!ok) throw new Error(`MOVE 失败：${folder}#${uid} → ${dest}`);
}

/**
 * 删除：有回收站则移入，否则 \Deleted + UID EXPUNGE。
 * messageDelete = 先置 \Deleted 再 UID EXPUNGE（服务端有 UIDPLUS 时只清指定 UID；
 * 无 UIDPLUS 时退化为普通 EXPUNGE，会连带清除该文件夹里其他 \Deleted 邮件）。
 */
export async function deleteUid(client: ImapFlow, folder: string, uid: number): Promise<void> {
  const trash = await detectTrashFolder(client);
  if (trash && trash !== folder) {
    await moveUid(client, folder, uid, trash);
    return;
  }
  await openReadWrite(client, folder);
  const ok = await client.messageDelete(String(uid), { uid: true });
  if (!ok) throw new Error(`删除失败：${folder}#${uid}`);
}
