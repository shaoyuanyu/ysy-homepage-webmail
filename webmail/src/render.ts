import sanitizeHtml from "sanitize-html";

/**
 * HTML 邮件渲染管线（4.4）：
 * 1. sanitize-html 白名单标签与属性，去掉 script/form/link/meta/base 及全部事件处理器；
 * 2. 远程资源默认剥除——img 的远程 src 换成占位图，原 URL 存 data-remote-src 供「显示图片」逐封加载；
 * 3. 白名单域名的远程图片直接加载；
 * 4. cid: 内联附件重写到附件端点；
 * 5. style 属性里的 url() 一律剥除（远程字体 / 背景图同样是跟踪通道）。
 */

const PLACEHOLDER_IMG =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E";

const ALLOWED_TAGS = [
  "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "font",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "ins", "li", "mark",
  "ol", "p", "pre", "q", "s", "small", "span", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
];

export interface RenderResult {
  html: string;
  /** 被剥除的远程资源数（>0 时前端显示「显示图片」按钮） */
  remoteBlocked: number;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function whitelisted(url: string, domains: string[]): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/** style 属性：按分号切开，丢弃含 url() 的声明（远程字体 / 背景图），其余保留 */
function sanitizeStyle(style: string): string {
  return style
    .split(";")
    .map((decl) => decl.trim())
    .filter((decl) => decl.length > 0 && !/url\s*\(/i.test(decl))
    .join("; ");
}

/**
 * @param html 原始 HTML
 * @param whitelist 远程图片白名单域名（小写）
 * @param cidResolver 把 cid 字符串解析成附件端点 URL；解析不了返回 null（剥除该 img）
 */
export function renderMailHtml(
  html: string,
  whitelist: string[],
  cidResolver: (cid: string) => string | null
): RenderResult {
  let remoteBlocked = 0;

  const out = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    // form/script/link/meta/base 连同内容一起丢弃
    nonTextTags: ["script", "style", "textarea", "option", "form", "link", "meta", "base", "iframe", "object", "embed"],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height", "data-remote-src"],
      td: ["colspan", "rowspan", "width", "align", "valign", "bgcolor"],
      th: ["colspan", "rowspan", "width", "align", "valign", "bgcolor"],
      table: ["width", "align", "bgcolor", "cellpadding", "cellspacing", "border"],
      col: ["width"],
      font: ["color", "size", "face"],
      "*": ["style"],
    },
    allowedSchemes: ["http", "https", "mailto", "cid", "data"],
    // data: 只允许图片
    allowedSchemesByTag: { img: ["http", "https", "cid", "data"] },
    transformTags: {
      img: (tagName, attribs) => {
        const src = attribs.src ?? "";
        if (src.startsWith("cid:")) {
          const resolved = cidResolver(src.slice(4));
          if (!resolved) {
            return { tagName: "span", attribs: {}, text: "" };
          }
          return { tagName, attribs: { ...attribs, src: resolved } };
        }
        if (/^https?:\/\//i.test(src) && !whitelisted(src, whitelist)) {
          remoteBlocked++;
          return {
            tagName,
            attribs: { ...attribs, src: PLACEHOLDER_IMG, "data-remote-src": src },
          };
        }
        return { tagName, attribs };
      },
      "*": (tagName, attribs) => {
        if (attribs.style) {
          const cleaned = sanitizeStyle(attribs.style);
          if (cleaned) {
            return { tagName, attribs: { ...attribs, style: cleaned } };
          }
          const rest = { ...attribs };
          delete rest.style;
          return { tagName, attribs: rest };
        }
        return { tagName, attribs };
      },
    },
  });

  return { html: out, remoteBlocked };
}
