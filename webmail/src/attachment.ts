/**
 * 附件响应的安全头决策（2026-10-07 加固）。
 *
 * 起因：附件端点原本把邮件里的 `Content-Type` **原样**回传给浏览器，且
 * `Content-Disposition: inline` 的附件照发。发信人是完全不受信任的第三方，
 * 于是可以投一封这样的邮件：
 *
 *   Content-Type: text/html; charset=utf-8
 *   Content-Disposition: inline
 *
 * 站主在正文里点一下指向 `/api/mail/message/<id>/attachment/0` 的链接，浏览器
 * 就在**站点源**（shaoyuanyu.cn）上把这段 HTML 当文档渲染并执行脚本。会话
 * Cookie 是 HttpOnly 读不到，但同源 fetch 会自动带上它——等于把站主 API
 * （/api/ideas、/api/preferences、/api/mail/*…）交给发信人。
 *
 * 修法（本模块）：
 * 1. **只有明确安全的类型**保留原 `Content-Type` 并允许 inline——图片（不含
 *    SVG：SVG 顶层文档会执行脚本）与纯文本；其余一律降级为
 *    `application/octet-stream` + `attachment`，浏览器只会下载、不会渲染。
 * 2. 所有附件响应都补 `X-Content-Type-Options: nosniff`（禁止嗅探改写类型）
 *    与 `Content-Security-Policy: default-src 'none'; sandbox`（万一被当文档
 *    打开，也禁掉脚本、表单与同源访问）。
 * 3. `filename` 的 ASCII 回退值剥掉控制字符与引号（`filename*` 走
 *    encodeURIComponent，本就编码了 CR/LF，不存在响应头注入）。
 *
 * ⚠ 与代理层 `app/api/mail/[...path]/route.ts` 成对：代理必须把
 * `x-content-type-options` / `content-security-policy` 转发出去，否则本模块
 * 等于没写（代理只挑固定几个头转发）。
 */

/** 允许保留原 Content-Type 并 inline 的类型：图片（除 SVG）+ 纯文本 */
const INLINE_SAFE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/tiff",
  "text/plain",
]);

/** 合法 MIME 形状（小写、无参数）；不合规一律按二进制处理 */
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

const FALLBACK_TYPE = "application/octet-stream";

export interface AttachmentHeaderInput {
  /** 邮件里声明的 Content-Type（可能带 charset 等参数，也可能缺失/畸形） */
  contentType?: string | null;
  filename?: string | null;
  /** 邮件是否声明了 Content-Disposition: inline */
  inline?: boolean;
}

export interface AttachmentHeaders {
  contentType: string;
  contentDisposition: string;
  /** 无论哪种类型都追加的安全头 */
  extraHeaders: Record<string, string>;
}

/** 取 MIME 主类型（小写、去参数）；畸形返回 null */
export function baseContentType(contentType?: string | null): string | null {
  if (!contentType) return null;
  const base = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return MIME_RE.test(base) ? base : null;
}

/** 该类型是否可以保原样 + inline（安全白名单） */
export function isInlineSafe(contentType?: string | null): boolean {
  const base = baseContentType(contentType);
  return base !== null && INLINE_SAFE_TYPES.has(base);
}

/** ASCII 回退文件名：剥控制字符（含 CR/LF）与引号、反斜杠；空则用 attachment */
export function asciiFilename(filename?: string | null): string {
  const cleaned = (filename ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\]/g, "")
    .trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

export function resolveAttachmentHeaders(input: AttachmentHeaderInput): AttachmentHeaders {
  const base = baseContentType(input.contentType);
  const safe = base !== null && INLINE_SAFE_TYPES.has(base);
  // 非白名单类型：类型与 disposition 都降级，浏览器只下载不渲染
  const contentType = safe ? base : FALLBACK_TYPE;
  const disposition = safe && input.inline ? "inline" : "attachment";
  const name = asciiFilename(input.filename);
  const encoded = encodeURIComponent(input.filename ?? name);
  return {
    contentType,
    contentDisposition: `${disposition}; filename="${name}"; filename*=UTF-8''${encoded}`,
    extraHeaders: {
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  };
}
