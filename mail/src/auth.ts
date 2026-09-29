import { authenticate } from "mailauth";
import { simpleParser } from "mailparser";
import type { AccountConfig } from "./types.js";

/**
 * 指令认证（3.6）：一封信要进入指令路径，必须同时满足——
 * ① From 在白名单（注册表里除 agent 外的账号地址）；
 * ② SPF 与 DKIM 双双通过（maild 自验，不依赖服务商的 Authentication-Results）。
 * 认证在投任务前完成（maild 侧，持有原文）；结果记台账。
 */

export interface CommandAuthResult {
  from: string;
  inWhitelist: boolean;
  /** mailauth 的 SPF 结果（pass/fail/softfail/none/...） */
  spf: string;
  /** DKIM：至少一个签名验过即 pass；无任何签名为 none */
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

export async function authenticateCommand(
  eml: Buffer,
  accounts: AccountConfig[],
  opts: AuthOpts = {}
): Promise<CommandAuthResult> {
  const parsed = await simpleParser(eml);
  const fromAddr = parsed.from?.value[0]?.address?.toLowerCase() ?? "";
  const inWhitelist = fromAddr.length > 0 && commandWhitelist(accounts).has(fromAddr);

  let spf = "error";
  let dkim = "none";
  try {
    const r = await authenticate(eml, {
      trustReceived: true,
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

  const isCommand = inWhitelist && spf === "pass" && dkim === "pass";
  const reason = !inWhitelist
    ? "From 不在白名单"
    : spf !== "pass"
      ? `SPF 未通过（${spf}）`
      : dkim !== "pass"
        ? `DKIM 未通过（${dkim}）`
        : "白名单 + SPF + DKIM 均通过";
  return { from: fromAddr, inWhitelist, spf, dkim, isCommand, reason };
}
