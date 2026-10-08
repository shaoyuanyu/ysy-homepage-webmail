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
  await setFlagsBatch(client, folder, [uid], change);
}

/**
 * 批量写标记（2026-10-07，多选批量操作）：一个文件夹一次 `STORE`。
 *
 * 与 `setFlags` 同一红线（只 +FLAGS / -FLAGS，绝不裸 FLAGS 整体替换；一律 `{ uid: true }`）：
 * 把一批 UID 用逗号拼成序列集，加标记一次、去标记一次——不按 UID 逐个往返（那是 N 次
 * 命令，服务商侧也更容易被限流）。调用方保证 uids 来自本地索引（copies 表）且已按
 * 文件夹分组。
 */
export async function setFlagsBatch(
  client: ImapFlow,
  folder: string,
  uids: number[],
  change: FlagChange
): Promise<void> {
  if (uids.length === 0) return;
  const add: string[] = [];
  const del: string[] = [];
  if (change.seen === true) add.push("\\Seen");
  if (change.seen === false) del.push("\\Seen");
  if (change.flagged === true) add.push("\\Flagged");
  if (change.flagged === false) del.push("\\Flagged");
  if (add.length === 0 && del.length === 0) return;
  await openReadWrite(client, folder);
  const set = uids.join(",");
  if (add.length > 0) {
    await client.messageFlagsAdd(set, add, { uid: true });
  }
  if (del.length > 0) {
    await client.messageFlagsRemove(set, del, { uid: true });
  }
}

/**
 * 本地索引里的 flags 字符串按变更结果重算（纯函数，便于单测）。
 * 口径必须与服务端一致：只增删 `\\Seen` / `\\Flagged`，其余标记原样保留
 * （红线 2 的本地对应物——别把整串覆盖掉，`\\Answered` / `\\Draft` 会被抹掉）。
 */
export function applyFlagChange(flags: string, change: FlagChange): string {
  const set = new Set(flags.split(" ").filter(Boolean));
  if (change.seen === true) set.add("\\Seen");
  if (change.seen === false) set.delete("\\Seen");
  if (change.flagged === true) set.add("\\Flagged");
  if (change.flagged === false) set.delete("\\Flagged");
  return [...set].join(" ");
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

/** 「回收站」文件夹的回退候选名（服务器没给 `\Trash` special-use 时的兜底） */
export const TRASH_FOLDER_NAMES = ["Trash", "Deleted Items", "Deleted Messages", "已删除邮件", "已删除"];

/** 「回收站」文件夹探测：同上，删除时优先移入 */
export async function detectTrashFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Trash", TRASH_FOLDER_NAMES);
}

/**
 * 「垃圾邮件」文件夹的回退候选名（服务器没给 `\Junk` special-use 时的兜底）。
 * 阿里企业邮的文件夹名是「垃圾邮件」，已在名单内（2026-10-07 加，供「标为垃圾」用）。
 */
export const JUNK_FOLDER_NAMES = ["Junk", "Junk E-mail", "Spam", "Bulk Mail", "垃圾邮件", "垃圾箱"];

/** 「垃圾邮件」文件夹探测：优先 \Junk 特殊用途标志位，回退常见名；找不到返回 null */
export async function detectJunkFolder(client: ImapFlow): Promise<string | null> {
  return detectSpecialFolder(client, "\\Junk", JUNK_FOLDER_NAMES);
}

/**
 * 「草稿」文件夹的回退候选名（服务器没给 `\Drafts` special-use 时的兜底）。
 * 阿里企业邮实测给 `\Drafts`（草稿），此列表只作保险。
 */
export const DRAFTS_FOLDER_NAMES = ["Drafts", "Draft", "草稿", "草稿箱", "已草稿"];

/**
 * 「归档」文件夹的回退候选名（服务器没给 `\Archive` special-use 时的兜底）。
 * 站内没有"归档"动作，此表只服务 `POST /move` 的 `\Archive` 记号（自动化/脚本可用）。
 */
export const ARCHIVE_FOLDER_NAMES = ["Archive", "Archives", "归档"];

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

/**
 * 移动目标可以是**特殊用途记号**（`\Junk` 这类，RFC 6154 的 special-use 名）而不是路径：
 * 同一个概念各家服务商叫法不同（阿里云「垃圾邮件」、Gmail `[Gmail]/Spam`），让服务端在
 * **目标账号上**探测比让前端先 LIST 一遍文件夹更稳——前端不必知道它叫什么，也不会因为
 * 清单过期而把信搬错地方。
 *
 * 2026-10-07 加：前端删掉「文件夹」视图与「移动」菜单后，只剩「标为垃圾邮件」一个整理
 * 动作（详情页工具栏），它需要的正是"这个账号的垃圾邮件夹在哪"——与其为它保留一份前端
 * 文件夹清单，不如把这件事交给本来就持有 IMAP 连接的服务端。
 */
const SPECIAL_MOVE_TARGETS: Record<string, { names: string[]; label: string }> = {
  "\\Junk": { names: JUNK_FOLDER_NAMES, label: "垃圾邮件" },
  "\\Trash": { names: TRASH_FOLDER_NAMES, label: "已删除邮件" },
  "\\Sent": { names: SENT_FOLDER_NAMES, label: "已发送" },
  "\\Drafts": { names: DRAFTS_FOLDER_NAMES, label: "草稿" },
  "\\Archive": { names: ARCHIVE_FOLDER_NAMES, label: "归档" },
};

/** 特殊用途记号的展示名（错误文案用）；普通路径返回 null */
export function specialMoveTargetLabel(dest: string): string | null {
  return SPECIAL_MOVE_TARGETS[dest]?.label ?? null;
}

/**
 * 把移动目标解析成该账号上的**真实文件夹路径**：
 * - 普通路径原样返回，**不产生任何 IMAP 请求**；
 * - 特殊用途记号（`\Junk` 等）在本账号上探测（标志位 → 常见名回退），找不到返回 null
 *   ——调用方决定是跳过该账号还是报错（见 api.ts 的 applyCopiesOp）；
 * - 不认识的记号直接抛错：那是编程错误，静默当路径用会把信搬到一个诡异的名字下。
 */
export async function resolveMoveTarget(client: ImapFlow, dest: string): Promise<string | null> {
  if (!dest.startsWith("\\")) return dest;
  const spec = SPECIAL_MOVE_TARGETS[dest];
  if (!spec) throw new Error(`不支持的特殊用途目标：${dest}`);
  return detectSpecialFolder(client, dest, spec.names);
}
