import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { authenticateCommand, commandWhitelist } from "../src/auth.js";
import type { AccountConfig } from "../src/types.js";

/**
 * 指令认证（3.6）：From 白名单 + SPF/DKIM 双通过才算指令。
 * 测试注入假 DNS resolver（mailauth 的 resolver 参数），离线完成真实 SPF/DKIM 验签：
 * - 签名是真的（mailauth.dkimSign + 真 RSA 密钥对）
 * - SPF 记录也是真的语义（ip4 匹配第一跳 Received IP）
 * 不是 mock——同一份代码在生产走系统 DNS。
 */

const OWNER = "owner@example.com";
const HOP_IP = "203.0.113.10"; // TEST-NET-3，指令信「第一跳」的 IP
const SELECTOR = "s1";
const SIGN_DOMAIN = "example.com";

const ACCOUNTS: AccountConfig[] = [
  {
    id: "me",
    displayName: "Me",
    email: OWNER,
    provider: "test",
    color: "#000",
    imapHost: "h",
    imapPort: 1,
    imapSecure: false,
    folders: ["INBOX"],
    enabled: true,
  },
  {
    id: "agent",
    displayName: "Agent",
    email: "agent@example.com",
    provider: "test",
    color: "#000",
    imapHost: "h",
    imapPort: 1,
    imapSecure: false,
    folders: ["INBOX"],
    enabled: true,
    isAgent: true,
  },
];

let privateKeyPem: string;
let dkimRecord: string;

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  dkimRecord = `v=DKIM1; k=rsa; p=${Buffer.from(spkiDer).toString("base64")}`;
});

/** 假 DNS：example.com 的 SPF 放行第一跳 IP；s1._domainkey 给 DKIM 公钥 */
async function fakeResolver(name: string, recordType: string): Promise<string[][]> {
  if (recordType === "TXT") {
    if (name === SIGN_DOMAIN) return [[`v=spf1 ip4:${HOP_IP} -all`]];
    if (name === `${SELECTOR}._domainkey.${SIGN_DOMAIN}`) return [[dkimRecord]];
  }
  return [];
}

function rawCommandEml(from: string = OWNER): string {
  return [
    `Return-Path: <${from}>`,
    `Received: from mail.example.com (mail.example.com [${HOP_IP}]) by mx.local with ESMTPS id a1b2; Tue, 23 Sep 2026 10:00:00 +0000`,
    `From: Owner <${from}>`,
    `To: agent@example.com`,
    `Subject: 指令测试`,
    `Date: Tue, 23 Sep 2026 10:00:01 +0000`,
    `Message-ID: <cmd-1@example.com>`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `把编辑部那封信标成已读。`,
  ].join("\r\n");
}

async function signedEml(raw: string): Promise<Buffer> {
  // dkimSign 只产出 DKIM-Signature 头，拼回原文前面；签名配置必须走 signatureData
  // （类型定义把 signingDomain 标成顶层必填是错的——实现只读 signatureData）
  const r = await dkimSign(raw, {
    signatureData: [{ signingDomain: SIGN_DOMAIN, selector: SELECTOR, privateKey: privateKeyPem }],
  } as never);
  if (r.errors.length > 0) throw new Error(`dkimSign 失败：${JSON.stringify(r.errors)}`);
  return Buffer.from(r.signatures + raw, "utf8");
}

describe("指令认证（3.6）", () => {
  it("白名单不含 agent 自己的地址", () => {
    const wl = commandWhitelist(ACCOUNTS);
    expect(wl.has(OWNER)).toBe(true);
    expect(wl.has("agent@example.com")).toBe(false);
  });

  it("白名单 + SPF pass + DKIM pass → 是指令", async () => {
    const eml = await signedEml(rawCommandEml());
    const r = await authenticateCommand(eml, ACCOUNTS, { resolver: fakeResolver });
    expect(r.inWhitelist).toBe(true);
    expect(r.spf, r.reason).toBe("pass");
    expect(r.dkim, r.reason).toBe("pass");
    expect(r.isCommand).toBe(true);
  });

  it("From 不在白名单 → 不是指令（SPF/DKIM 都过也不行）", async () => {
    // 白名单外的人拿到同一域名密钥签出有效签名，也不能下达指令
    const eml = await signedEml(rawCommandEml("intruder@example.com"));
    const r = await authenticateCommand(eml, ACCOUNTS, { resolver: fakeResolver });
    expect(r.spf).toBe("pass");
    expect(r.dkim).toBe("pass");
    expect(r.inWhitelist).toBe(false);
    expect(r.isCommand).toBe(false);
  });

  it("SPF 不匹配（伪造来源 IP）→ 不是指令", async () => {
    const eml = await signedEml(rawCommandEml().replace(HOP_IP, "198.51.100.7"));
    const r = await authenticateCommand(eml, ACCOUNTS, { resolver: fakeResolver });
    expect(r.inWhitelist).toBe(true);
    expect(r.spf).not.toBe("pass");
    expect(r.isCommand).toBe(false);
  });

  it("缺 DKIM 签名 → 不是指令", async () => {
    const r = await authenticateCommand(Buffer.from(rawCommandEml()), ACCOUNTS, { resolver: fakeResolver });
    expect(r.dkim).toBe("none");
    expect(r.isCommand).toBe(false);
  });

  it("签名后篡改正文 → DKIM fail → 不是指令", async () => {
    const signed = await signedEml(rawCommandEml());
    const tampered = Buffer.from(signed.toString("utf8").replace("标成已读", "全部删除"));
    const r = await authenticateCommand(tampered, ACCOUNTS, { resolver: fakeResolver });
    expect(r.dkim).not.toBe("pass");
    expect(r.isCommand).toBe(false);
  });

  it("校验基础设施异常（DNS 全灭）→ 按普通邮件处理，不误判为指令", async () => {
    const deadResolver = async (): Promise<string[][]> => {
      throw new Error("DNS 不可达");
    };
    const eml = await signedEml(rawCommandEml());
    const r = await authenticateCommand(eml, ACCOUNTS, { resolver: deadResolver });
    expect(r.isCommand).toBe(false);
  });
});
