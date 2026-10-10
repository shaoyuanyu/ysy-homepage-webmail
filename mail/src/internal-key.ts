import { timingSafeEqual } from "node:crypto";

/**
 * 站点代理与邮件后端之间的共享密钥（webmaild / mailagentd 通用）。
 *
 * 后端自身不做用户认证，信任边界原本只有「绑回环 + 容器网络隔离 + 站点代理的 isOwner 守卫」。
 * 一旦部署时把监听地址改成非回环地址（`WEBMAIL_HOST=0.0.0.0` / `MAIL_AGENT_HOST=0.0.0.0`）
 * 并暴露端口，后端就是完全敞开的。这里给后端加一道与部署方式无关的门：
 * 站点代理转发时注入 `x-internal-key`，后端比对不一致就拒绝。
 *
 * 两个进程的密钥变量名各自独立（webmaild 用 WEBMAIL_INTERNAL_KEY、mailagentd 用
 * MAIL_AGENT_INTERNAL_KEY），站点侧同时持有两者并按目标注入。
 */

/** 请求头名（站点代理注入、后端校验） */
export const INTERNAL_KEY_HEADER = "x-internal-key";

/** 回环地址：绑这些地址时信任边界就是本机，不需要密钥 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "::1" || h === "[::1]" || h === "localhost";
}

/**
 * 比对接到的密钥与配置的密钥。
 * 用定长比较，避免按字符提前返回；长度不同直接判否（长度本身不是秘密）。
 */
export function internalKeyMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 从 node:http 的请求头里取单个字符串值（同名头出现多次时取第一个） */
export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}
