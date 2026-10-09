import type { PartLeaf, StructureNode } from "./imap.js";

/**
 * 「精简原文」（2026-10-08）：同步时**不下载附件**，只留邮件头 + 正文 + 内嵌图。
 *
 * ## 为什么要自己拼一份 MIME
 *
 * 站内每个功能（正文渲染、cid 内嵌图、附件清单、.eml 下载、引用链解析、全文搜索、
 * agent 读信）都建立在「本地有一份能解析的 .eml」之上。IMAP 只能按部件取，取回来的
 * 是碎片，所以要把「顶层头 + 保留的部件」重新拼成一份**合法的 MIME**，让 mailparser
 * 照常解析——不这么做，所有下游都得改成「可能只有部件」的两套代码。
 *
 * ## 规则（与 fetcher 的分流一致）
 *
 * - **保留**：正文部件（`text/plain` / `text/html` 且不是 attachment）、内嵌图
 *   （`Content-Disposition: inline` 或带 `Content-ID` 的图片）；
 * - **丢弃**：其余（真附件）——但要记进 `attachments_json` 清单，界面照样列出来，
 *   点击时才按部件号向服务器取（见 webmail/src/source.ts）。
 *
 * ⚠ 两个必须守住的点：
 * 1. **附件清单的序号 = 整封邮件解析出来的序号**（`flattenStructure` 的深度优先顺序
 *    与 mailparser `parsed.attachments` 一致）。补取整封之后序号必须还对得上，否则
 *    「点第 2 个附件拿到第 3 个文件」。
 * 2. **任何异常都不许把信变得读不了**：调用方在拼装失败时必须回退成「整封下载」
 *    （宁可多下几个字节，也不能出现空白/乱码的邮件）。
 */

/** 清单里的一项（存进 `messages.attachments_json`，界面与按需取附件都用它） */
export interface AttachmentEntry {
  /** 序号：与整封解析的 `attachments[index]` 一致 */
  index: number;
  filename: string;
  contentType: string;
  size: number;
  cid: string | null;
  /** 内嵌图（已随精简原文一起留存） */
  inline: boolean;
  /** **没有**留存在本地，点开时才按 `part` 取（附件端点的判据） */
  deferred: boolean;
  /** IMAP 部件编号，按需取用；缺失（老数据）时回退成「补取整封」 */
  part?: string;
  /**
   * 传输编码（base64 / quoted-printable / 7bit…）。
   * ⚠ 按需取部件时 `BODY.PEEK[n]` 给的是**未解码**的字节，而本地解析出来的是解码后的——
   *   必须按它解一遍，否则同一封邮件「本地取」与「服务器取」会给出完全不同的两个文件
   *   （2026-10-08 实测踩坑：点附件下回来的是 base64 文本）。
   */
  encoding?: string;
}

/**
 * 把 `BODY.PEEK[n]` 取回的部件内容解码成「mailparser 会给的字节」。
 * base64 与 quoted-printable 是实际会遇到的两种；其余（7bit/8bit/binary）原样返回。
 */
export function decodePartPayload(payload: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? "7bit").toLowerCase();
  if (enc === "base64") {
    // 去掉换行与空白再解；容忍缺失的 padding
    const text = payload.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    return Buffer.from(text, "base64");
  }
  if (enc === "quoted-printable") {
    const text = payload.toString("latin1");
    const out: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "=") {
        // 软换行（"=" 后跟 CRLF 或 LF）：整段吞掉
        if (text[i + 1] === "\r" && text[i + 2] === "\n") {
          i += 2;
          continue;
        }
        if (text[i + 1] === "\n") {
          i += 1;
          continue;
        }
        const hex = text.slice(i + 1, i + 3);
        if (/^[0-9a-fA-F]{2}$/.test(hex)) {
          out.push(parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(out);
  }
  return payload;
}

/**
 * 判定一个部件是否要**留下**（正文或内嵌图）。
 *
 * ⚠ 不能只看 `Content-Disposition`：大量简报的内嵌图**根本没有 disposition**，只靠 HTML 里的
 * `cid:` 引用；反过来 `text/csv` 这种「文本附件」必须丢掉。所以判据是
 * 「文本正文 或 （有 Content-ID 的图片）」且**显式声明为 attachment 的一律丢**。
 */
export function isKeptPart(leaf: PartLeaf): boolean {
  const isAttachment = leaf.disposition === "attachment";
  const isTextBody = (leaf.type === "text/plain" || leaf.type === "text/html") && !isAttachment;
  const isInlineImage = leaf.type.startsWith("image/") && !isAttachment && (!!leaf.id || leaf.disposition === "inline");
  return isTextBody || isInlineImage;
}

/**
 * 结构里的 `size` 是**编码后**的字节数（base64 会大 1/3），而界面与 mailparser 用的是
 * **解码后**的大小。基 64 可精确换算，其余（quoted-printable / 7bit）按原值近似——
 * 目的是让「补取整封前后」界面显示的附件大小一致，不要一会大一会小。
 */
function decodedSize(leaf: PartLeaf): number {
  if (leaf.encoding === "base64") return Math.floor((leaf.size * 3) / 4);
  return leaf.size;
}

/** 按 RFC 2231 编码文件名（含非 ASCII 时），避免拼出非法的 MIME 头 */
function dispositionFilename(filename: string): string {
  // eslint-disable-next-line no-control-regex
  const ascii = /^[\x20-\x7e]*$/.test(filename);
  if (ascii) {
    return `filename="${filename.replace(/["\\]/g, "")}"`;
  }
  return `filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** 结构节点的 `type` 归一（imapflow 给的是合并好的 `text/plain`，原始 IMAP 是分开的） */
export function normalizeType(node: { type?: string; subtype?: string }): string {
  const raw = (node.type ?? "").toLowerCase().replace(/\/+$/, "");
  return raw.includes("/") ? raw : `${raw}/${(node.subtype ?? "").toLowerCase()}`.replace(/\/+$/, "");
}

/** 参数（charset / name…）拼成 MIME 头里的形式 */
function formatParameters(params: Record<string, string>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (k.toLowerCase() === "name") continue; // name 跟着 Content-Disposition 的 filename 走
    const ascii = /^[\x20-\x7e]*$/.test(v);
    parts.push(ascii ? `${k}="${v.replace(/["\\]/g, "")}"` : `${k}*=UTF-8''${encodeURIComponent(v)}`);
  }
  return parts.length ? `; ${parts.join("; ")}` : "";
}

/** 为一个保留部件拼它自己的 MIME 头（类型 / 编码 / Content-ID / 文件名都来自结构） */
function partHeader(leaf: PartLeaf): string {
  const lines = [`Content-Type: ${leaf.type}${formatParameters(leaf.parameters)}`];
  if (leaf.encoding) lines.push(`Content-Transfer-Encoding: ${leaf.encoding}`);
  if (leaf.id) lines.push(`Content-ID: ${leaf.id}`);
  if (leaf.disposition) {
    const fn = leaf.filename ? `; ${dispositionFilename(leaf.filename)}` : "";
    lines.push(`Content-Disposition: ${leaf.disposition}${fn}`);
  } else if (leaf.filename) {
    // 没有 disposition 但有文件名（Content-Type 的 name）：按 inline 写回，信息不丢
    lines.push(`Content-Disposition: inline; ${dispositionFilename(leaf.filename)}`);
  }
  return lines.join("\r\n");
}

/**
 * 顶层邮件头过滤：去掉 MIME 结构相关的行（含折行续行），其余**原样逐行保留**
 * （Received 链、自定头、折行都别动——原始邮件弹窗就是看这个的）。
 */
export function stripStructureHeaders(topHeaders: string): string {
  const out: string[] = [];
  let dropping = false;
  for (const line of topHeaders.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      // 续行：跟随上一行的去留
      if (!dropping) out.push(line);
      continue;
    }
    dropping = /^(content-type|content-transfer-encoding|content-disposition|mime-version)\s*:/i.test(line);
    if (!dropping) out.push(line);
  }
  return out.join("\r\n").replace(/(\r?\n)+$/, "");
}

/**
 * 剪枝后的结构树：容器（multipart/*）与叶子（可取的部件）原样保留原邮件的**嵌套关系**。
 *
 * ⚠ 为什么不能拍平成一条 `multipart/mixed`（2026-10-08 踩坑）：mailparser 对
 *   `multipart/alternative` 会分别给 `text` 与 `html`，而 `multipart/mixed` 里两个文本
 *   部件会被**拼成一段纯文本**（真机信里 text/plain + text/html 是常态，拍平后
 *   `parsed.html` 直接没了）。容器的类型与层次是语义的一部分，必须保真——只换 boundary。
 */
export interface TrimNode {
  leaf?: PartLeaf;
  container?: { type: string; parameters: Record<string, string> };
  children?: TrimNode[];
}

/** 剪枝：丢掉不被保留的叶子；子节点全被丢掉的容器也丢掉 */
export function pruneTree(node: StructureNode | undefined): TrimNode | null {
  if (!node) return null;
  const children = (node.childNodes ?? [])
    .map((child) => pruneTree(child))
    .filter((c): c is TrimNode => !!c);
  if (children.length > 0) {
    return {
      container: {
        type: `${node.type ?? "multipart/mixed"}`.toLowerCase(),
        parameters: node.parameters ?? {},
      },
      children,
    };
  }
  if (!node.part) return null;
  const leaf: PartLeaf = {
    part: node.part,
    type: normalizeType(node),
    encoding: (node.encoding ?? "7bit").toLowerCase(),
    size: node.size ?? 0,
    id: node.id ?? null,
    disposition: node.disposition ? node.disposition.toLowerCase() : null,
    filename: node.dispositionParameters?.filename ?? node.parameters?.name ?? null,
    parameters: node.parameters ?? {},
  };
  return isKeptPart(leaf) ? { leaf } : null;
}

/** 剪枝后还需要向服务器取哪些部件（顺序 = 邮件里的出现顺序） */
export function collectPartIds(tree: TrimNode | null): string[] {
  if (!tree) return [];
  if (tree.leaf) return [tree.leaf.part];
  return (tree.children ?? []).flatMap((c) => collectPartIds(c));
}

export interface BuildTrimmedInput {
  /** 顶层邮件头（原始字节，`BODY.PEEK[HEADER]` 取回来的） */
  topHeaders: Buffer;
  /** 剪枝后的结构树 */
  tree: TrimNode;
  /** 部件号 → 原始（仍带传输编码的）内容 */
  payloads: Map<string, Buffer>;
}

/** 生成一个新 boundary（不复用原邮件的：原结构已经被我们剪过，复用只会拼出坏邮件） */
function freshBoundary(): string {
  return `----ysy-trimmed-${Math.random().toString(36).slice(2, 12)}`;
}

/** 容器自己的 Content-Type 头（boundary 换成新的，其余参数保留） */
function containerHeader(container: { type: string; parameters: Record<string, string> }, boundary: string): string {
  const others = Object.entries(container.parameters)
    .filter(([k]) => k.toLowerCase() !== "boundary")
    .map(([k, v]) => `${k}="${v.replace(/["\\]/g, "")}"`);
  return `Content-Type: ${container.type}; boundary="${boundary}"${others.length ? "; " + others.join("; ") : ""}`;
}

function serialize(tree: TrimNode, payloads: Map<string, Buffer>, out: Buffer[]): void {
  if (tree.leaf) {
    out.push(Buffer.from(`${partHeader(tree.leaf)}\r\n\r\n`, "utf8"));
    out.push(payloads.get(tree.leaf.part) ?? Buffer.alloc(0));
    return;
  }
  const container = tree.container!;
  const boundary = freshBoundary();
  out.push(Buffer.from(`${containerHeader(container, boundary)}\r\n\r\n`, "utf8"));
  for (const child of tree.children ?? []) {
    out.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    serialize(child, payloads, out);
    out.push(Buffer.from("\r\n", "utf8"));
  }
  out.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
}

/**
 * 拼一份精简 MIME：原顶层头（摘掉结构头）+ 剪枝后的结构树。
 * ⚠ 任何异常都不许把信变得读不了——调用方在失败时回退成「整封下载」（见 fetcher.ts）。
 */
export function buildTrimmedSource(input: BuildTrimmedInput): Buffer {
  const header = stripStructureHeaders(input.topHeaders.toString("utf8"));
  const missing = collectPartIds(input.tree).filter((id) => !input.payloads.has(id));
  if (missing.length > 0) {
    // 部件没取全：宁可让调用方回退整封，也别拼一封缺正文的信
    throw new Error(`部件缺失：${missing.join(", ")}`);
  }
  const out: Buffer[] = [Buffer.from(`${header}\r\nMIME-Version: 1.0\r\n`, "utf8")];
  serialize(input.tree, input.payloads, out);
  return Buffer.concat(out);
}

/**
 * 从结构拍平结果算出「保留哪些部件」与「附件清单」。
 *
 * 清单里的 `index` **必须**与「整封解析的 attachments 序号」一致：mailparser 把
 * 「正文部件」挑出去之后，其余按出现顺序就是 attachments。所以这里同一个顺序里
 * 只要把**被丢弃的**部件挑出来编号即可——保留的内嵌图也占一个序号（它是
 * `parsed.attachments` 的一员），所以编号要连着整份叶子表走。
 */
export function planParts(leaves: PartLeaf[]): {
  keep: PartLeaf[];
  attachments: Omit<AttachmentEntry, "deferred">[];
} {
  const keep: PartLeaf[] = [];
  const attachments: Omit<AttachmentEntry, "deferred">[] = [];
  let index = 0;
  for (const leaf of leaves) {
    if (isKeptPart(leaf)) {
      // 内嵌图既是「保留」也占一个附件序号（与 mailparser 一致）
      const keptInline = leaf.type.startsWith("image/");
      if (keptInline) {
        attachments.push({
          index: index++,
          filename: leaf.filename ?? `attachment-${index - 1}`,
          contentType: leaf.type,
          size: decodedSize(leaf),
          cid: leaf.id,
          inline: true,
          part: leaf.part,
          encoding: leaf.encoding,
        });
      }
      keep.push(leaf);
    } else {
      attachments.push({
        index: index++,
        filename: leaf.filename ?? `attachment-${index - 1}`,
        contentType: leaf.type,
        size: decodedSize(leaf),
        cid: leaf.id,
        inline: false,
        part: leaf.part,
        encoding: leaf.encoding,
      });
    }
  }
  return { keep, attachments };
}
