import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import type { AccountConfig } from "./types.js";

/**
 * 指令认证（3.6，2026-10 修订）：按来信通道分两路——
 * · 域内直投（顶层 Received 是阿里云提交服务章 `by smtp.aliyun-inc.com`）：From 在白名单即指令。
 *   域内投递要求 SMTP 认证提交，外部伪造由本域 SPF `-all` 在 MX 门口硬拒；下游结构性不可验（不签 DKIM）。
 * · 外部来信：From 在白名单 + SPF 与 DKIM 双双通过（maild 自验，不依赖服务商的 Authentication-Results）。
 * 认证在投任务前完成（maild 侧，持有原文）；结果记台账。
 */

export interface CommandAuthResult {
  from: string;
  inWhitelist: boolean;
  /** 来信通道：域内直投（阿里云内部提交，信任）/ 外部（须 SPF+DKIM 双过） */
  channel: "intra-domain" | "external";
  /** mailauth 的 SPF 结果（pass/fail/...）；域内通道不验，恒 "skipped" */
  spf: string;
  /** DKIM：至少一个签名验过即 pass；无任何签名为 none；域内通道恒 "skipped" */
  dkim: string;
  isCommand: boolean;
  reason: string;
}

/** 指令白名单 = 注册表里除 agent 外的全部账号地址（3.6：你的三个地址） */
export function commandWhitelist(accounts: AccountConfig[]): Set<string> {
  return new Set(accounts.filter((a) => !a.isAgent).map((a) => a.email.toLowerCase()));
}

interface AuthOpts {
  /** DNS 解析器注入点（测试用假 resolver；缺省走系统 DNS） */
  resolver?: (name: string, recordType: string) => Promise<string[][]>;
}

/** 取顶层 Received 的完整逻辑行（重组折行；只扫头部前 64KB）。 */
function topReceivedLine(eml: Buffer): string | undefined {
  const headText = eml.subarray(0, Math.min(eml.length, 64 * 1024)).toString("utf-8");
  const head = headText.split(/\r?\n\r?\n/)[0] ?? "";
  const logical: string[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && logical.length > 0) {
      logical[logical.length - 1] += " " + line.trim();
    } else {
      logical.push(line);
    }
  }
  return logical.find((l) => /^received:/i.test(l));
}

/**
 * 从顶层 Received 头提取 client IP 与 envelope MAIL FROM（真机实测：阿里云外部入站信的首个
 * Received 形如 `from xmbg7.mail.qq.com(mailfrom:shaoyuanyu@foxmail.com ip:101.91.44.167) by mx1.aliyun-inc.com`，
 * 两项都藏在括号注释里、非 mailauth 认识的标准格式——不注入则 SPF 因缺 client IP 恒 temperror；
 * 且阿里云不盖 Return-Path，mailauth 会拿 HELO 名兜底成 `postmaster@<helo>` 去查 SPF，
 * 查到的是中继主机名（无记录）而非真实发信域）。
 *
 * 安全前提：MTA 收信时把 Received 章 prepend 在顶部，伪造者的假章永远压在真实接收章**之下**
 * → 只取第一个 Received；域内信首章是 `from 127.0.0.1(mailfrom:me@...fp:...)` 无 ip: 字段，
 * clientIp 提取不到 → SPF 仍 temperror（域内不可验，走域内通道）。
 */
export function extractSenderFromTopReceived(eml: Buffer): { clientIp?: string; mailFrom?: string } {
  const topReceived = topReceivedLine(eml);
  if (!topReceived) return {};
  // 阿里云注释格式：`mailfrom:<地址> ip:<IPv4/IPv6 字面量>`
  const clientIp = /\bip:\s*\[?([0-9a-fA-F.:]{3,45})\]?/i.exec(topReceived)?.[1];
  const mailFrom = /\bmailfrom:\s*([^\s)]+)/i.exec(topReceived)?.[1]?.toLowerCase();
  return { clientIp, mailFrom };
}

/** 域内直投章的 `by` 主机名（阿里云提交服务；换服务商时改这里） */
export const INTRA_DOMAIN_SUBMISSION_BY = "smtp.aliyun-inc.com";

/**
 * 域内直投识别（3.6）：顶层 Received 是阿里云**提交服务**所盖（`from 127.0.0.1(…) by smtp.aliyun-inc.com`），
 * 即发送方经 SMTP 认证提交、同域直投，未经外部 MX。域内信阿里云不签 DKIM、不盖 Authentication-Results，
 * 下游结构性不可验；而外部伪造 `me@` 会在 MX 门口被本域 SPF `-all` 硬拒——入口检查是阿里云的本职，信任之。
 * 伪造者写在信内的假 Received 永远压在真章之下（MTA prepend），只读顶层即免疫。
 */
export function isIntraDomainSubmission(eml: Buffer): boolean {
  const top = topReceivedLine(eml);
  if (!top) return false;
  const byHost = INTRA_DOMAIN_SUBMISSION_BY.replace(/[.]/g, "\\.");
  return new RegExp(`^received:\\s*from\\s+127\\.0\\.0\\.1[\\s(]`, "i").test(top) &&
    new RegExp(`\\bby\\s+${byHost}\\b`, "i").test(top);
}

export async function authenticateCommand(
  eml: Buffer,
  accounts: AccountConfig[],
  opts: AuthOpts = {}
): Promise<CommandAuthResult> {
  const parsed = await simpleParser(eml);
  const fromAddr = parsed.from?.value[0]?.address?.toLowerCase() ?? "";
  const inWhitelist = fromAddr.length > 0 && commandWhitelist(accounts).has(fromAddr);
  const channel = isIntraDomainSubmission(eml) ? "intra-domain" as const : "external" as const;

  let spf = "skipped";
  let dkim = "skipped";
  if (channel === "external") {
    try {
      const { clientIp, mailFrom } = extractSenderFromTopReceived(eml);
      const r = await authenticate(eml, {
        trustReceived: true,
        // 显式 ip / sender 优先于 trustReceived 推断（mailauth: `if (ip && !opts.ip)`）
        ...(clientIp ? { ip: clientIp } : {}),
        ...(mailFrom ? { sender: mailFrom } : {}),
        ...(opts.resolver ? { resolver: opts.resolver } : {}),
      });
      // spf 可能是 false（无法评估）；SPFResult.status.result 才是结论
      spf = r.spf && typeof r.spf === "object" ? (r.spf.status?.result ?? "none") : "none";
      // dkim：有任一签名验过即 pass；有签名但全没验过为 fail；无签名为 none
      const dkimResults = r.dkim?.results ?? [];
      if (dkimResults.some((d) => d.status?.result === "pass")) {
        dkim = "pass";
      } else if (dkimResults.some((d) => d.status?.result === "fail")) {
        dkim = "fail";
      } else {
        dkim = "none";
      }
    } catch {
      // 校验本身出错（DNS 不可达等）一律按不通过处理——宁可误判为普通邮件
      spf = "error";
      dkim = "error";
    }
  }

  const isCommand = inWhitelist && (channel === "intra-domain" || (spf === "pass" && dkim === "pass"));
  const reason = !inWhitelist
    ? "From 不在白名单"
    : channel === "intra-domain"
      ? "域内直投（阿里云认证提交）+ From 在白名单"
      : spf !== "pass"
        ? `SPF 未通过（${spf}）`
        : dkim !== "pass"
          ? `DKIM 未通过（${dkim}）`
          : "白名单 + SPF + DKIM 均通过";
  return { from: fromAddr, inWhitelist, channel, spf, dkim, isCommand, reason };
}
