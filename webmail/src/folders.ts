import type { ImapFlow } from "imapflow";
import { connectAccount } from "../../mail/src/imap.js";
import type { AccountCredential } from "../../mail/src/types.js";
import { withAccountLock } from "./locks.js";
import type { WebmailAccount } from "./types.js";
import {
  DRAFTS_FOLDER_NAMES,
  JUNK_FOLDER_NAMES,
  SENT_FOLDER_NAMES,
  TRASH_FOLDER_NAMES,
} from "./write.js";

/**
 * 文件夹清单（2026-10-07 新增）。
 *
 * 起因：在「同步文件夹」只能手打逗号字符串之前，账号注册表里的 `folders` 全靠人猜
 * 服务器上的名字（「已发送」还是「Sent」？），猜错就静默少同步一个文件夹——最典型
 * 的症状是**新账号的「发件」页永远为空**（发送时 APPEND 进了服务器「已发送」，
 * 但那个文件夹不在白名单里、本地索引没有它）。
 *
 * 这里给出两条能力：
 * - `listAccountFolders`：已保存账号 → IMAP `LIST` 结果（账号管理弹窗的文件夹选择器）；
 * - `suggestSyncFolders`：从清单里挑出「推荐同步」的一组（INBOX + 特殊用途文件夹），
 *   新增账号时自动预填，用户不必知道服务器上的文件夹叫什么。
 *
 * 特殊用途的判定优先用 imapflow 给的 `specialUse`（RFC 6154 标志位；服务商不支持时
 * imapflow 会按**本地化名字**推断，阿里云的「已发送 / 草稿 / 垃圾邮件 / 已删除邮件」
 * 都在它的名单里），再用本包的常见名回退名单兜一层（与 detectSentFolder 同一套名单）。
 */

export interface FolderInfo {
  /** 服务器路径（写回注册表、MOVE 的目标都用它） */
  path: string;
  /** 路径最后一段（UI 展示） */
  name: string;
  delimiter: string;
  /** `\Sent` / `\Drafts` / `\Trash` / `\Junk` / `\Archive` / `\All`；判定不出为空串 */
  specialUse: string;
  /** specialUse 的来源：extension（服务端标志位）/ name（本地化名字推断）/ 空 */
  specialUseSource: string;
  /** 可否被 SELECT（容器节点 `\Noselect` 为 false） */
  selectable: boolean;
}

/** 特殊用途的展示顺序（清单排序用；推荐集另见 SUGGESTED_USES） */
const SPECIAL_USE_ORDER = ["\\Sent", "\\Drafts", "\\Trash", "\\Junk", "\\Archive", "\\All"];

/**
 * **推荐同步**用的特殊用途清单——与 `SPECIAL_USE_ORDER` 刻意分开（2026-10-10）。
 *
 * ⚠ 为什么推荐集里没有 `\Drafts` 与 `\Trash`（用户问过"为什么没勾草稿却能看草稿"）：
 * - `\Drafts`：站内草稿是 webmaild 自己的表（`drafts.ts`，`/mail` 的「草稿」tab 只读它），
 *   另有单向镜像（`draft-mirror.ts`）把草稿写回服务器。把服务器的 `\Drafts` 抓进本地库
 *   只会让**镜像出去的那份草稿以邮件的身份回流**，在「全部」里多出一堆草稿副本；
 * - `\Trash`：删除 = `MOVE` 进 `\Trash`（`write.ts` 的 `deleteMessages`），本地副本随之清掉；
 *   若 `\Trash` 在白名单里，下一轮同步会把刚删掉的邮件**重新抓回来**，用户看到的是
 *   "删了又自己回来了"（列表查询对 `\Trash` 没有任何排除逻辑）。
 *
 * 两者都仍然可以被用户**手动**勾上（`GET /folders` 照常返回它们、前端也能勾），
 * 只是不再作为新账号的缺省。
 */
const SUGGESTED_USES = ["\\Sent", "\\Junk", "\\Archive", "\\All"];

/** 名称回退名单（服务端不给 special-use、imapflow 也没按名字认出时用） */
const NAME_FALLBACK: { use: string; names: string[] }[] = [
  { use: "\\Sent", names: SENT_FOLDER_NAMES },
  { use: "\\Drafts", names: DRAFTS_FOLDER_NAMES },
  { use: "\\Trash", names: TRASH_FOLDER_NAMES },
  { use: "\\Junk", names: JUNK_FOLDER_NAMES },
];

function rank(f: FolderInfo): number {
  if (f.path.toUpperCase() === "INBOX") return -1;
  const idx = SPECIAL_USE_ORDER.indexOf(f.specialUse);
  return idx === -1 ? SPECIAL_USE_ORDER.length : idx;
}

/** imapflow 的 LIST 结果 → 前端可用的 FolderInfo[]（排序：INBOX → 特殊用途 → 其余按路径） */
export function toFolderInfo(
  boxes: {
    path: string;
    name?: string;
    delimiter?: string | null;
    flags?: Set<string>;
    specialUse?: string;
    specialUseSource?: string;
  }[]
): FolderInfo[] {
  const list: FolderInfo[] = boxes.map((b) => {
    const name = b.name ?? b.path.split(b.delimiter ?? "/").pop() ?? b.path;
    let specialUse = b.specialUse ?? "";
    let source = b.specialUseSource ?? "";
    if (!specialUse) {
      const hit = NAME_FALLBACK.find((entry) =>
        entry.names.some((n) => n.toLowerCase() === b.path.trim().toLowerCase())
      );
      if (hit) {
        specialUse = hit.use;
        source = "name";
      }
    }
    return {
      path: b.path,
      name,
      delimiter: b.delimiter ?? "/",
      specialUse,
      specialUseSource: source,
      // \Noselect 的容器节点不能 EXAMINE/SELECT，不能进同步白名单
      selectable: !(b.flags?.has("\\Noselect") ?? false),
    };
  });
  return list.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.path.localeCompare(b.path);
  });
}

/** 用一条已有连接列文件夹（调用方负责连接的建立与关闭） */
export async function listFoldersWith(client: ImapFlow): Promise<FolderInfo[]> {
  return toFolderInfo(await client.list());
}

/** 列出某个账号的文件夹（短时连接 + 账号锁，与其它 IMAP 操作串行） */
export async function listAccountFolders(
  account: WebmailAccount,
  cred: AccountCredential
): Promise<FolderInfo[]> {
  return withAccountLock(account.id, async () => {
    const client = await connectAccount(account, cred);
    try {
      return await listFoldersWith(client);
    } finally {
      await client.logout().catch(() => {});
    }
  });
}

/**
 * 推荐同步的文件夹：INBOX + 已发送 / 垃圾邮件 / 归档（`SUGGESTED_USES`，⚠ 不含草稿与已删除，
 * 理由见该常量的注记）。
 *
 * 新增账号时用它预填注册表的 `folders`——「发件」页依赖服务器「已发送」在白名单里，
 * 不预填的话新账号的「发件」页会一直是空的（用户得自己猜名字）。
 */
export function suggestSyncFolders(folders: FolderInfo[]): string[] {
  const selectable = folders.filter((f) => f.selectable);
  const out: string[] = [];
  const inbox = selectable.find((f) => f.path.toUpperCase() === "INBOX");
  out.push(inbox?.path ?? "INBOX");
  for (const use of SUGGESTED_USES) {
    const hit = selectable.find((f) => f.specialUse === use);
    if (hit && !out.includes(hit.path)) out.push(hit.path);
  }
  return out;
}
