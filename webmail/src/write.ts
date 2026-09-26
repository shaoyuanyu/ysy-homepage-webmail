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

/** 「已发送」文件夹探测：优先 \Sent 特殊用途标志位（RFC 6154），回退常见名；找不到返回 null */
export async function detectSentFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Sent", ["Sent", "Sent Items", "已发送邮件", "已发送"]);
}

/** 「回收站」文件夹探测：同上，删除时优先移入 */
export async function detectTrashFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Trash", ["Trash", "Deleted Items", "已删除邮件", "已删除"]);
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
