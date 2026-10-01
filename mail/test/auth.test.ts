import { describe, expect, it, beforeAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import {
  authenticateCommand,
  commandWhitelist,
  extractSenderFromTopReceived,
  isIntraDomainSubmission,
} from "../src/auth.js";
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

describe("顶层 Received 提取（阿里云真机格式）", () => {
  // 真机留存：外部入站信首个 Received 的 IP 与 envelope 藏在括号注释里，
  // 且阿里云不盖 Return-Path——两项都要由我们注入给 mailauth
  const ALIYUN_EXTERNAL = [
    "Received: from xmbg7.mail.qq.com(mailfrom:shaoyuanyu@foxmail.com ip:101.91.44.167)",
    "          by mx1.aliyun-inc.com;",
    "          Wed, 30 Sep 2026 12:36:35 +0800",
  ].join("\r\n");

  it("阿里云外部入站格式（折行）→ 提取 clientIp + mailFrom", () => {
    const eml = Buffer.from(`${ALIYUN_EXTERNAL}\r\nFrom: a@b.c\r\n\r\nbody`);
    const r = extractSenderFromTopReceived(eml);
    expect(r.clientIp).toBe("101.91.44.167");
    expect(r.mailFrom).toBe("shaoyuanyu@foxmail.com");
  });

  it("域内信（from 127.0.0.1，无 ip: 字段）→ clientIp 为空、mailFrom 可取", () => {
    // 域内信首章：`from 127.0.0.1(mailfrom:me@...fp:SMTPD_---...)` —— 注意 fp: 不得误匹配为 ip:
    const eml = Buffer.from(
      "Received: from 127.0.0.1(mailfrom:me@mail.shaoyuanyu.cn fp:SMTPD_---.jRchtBs_1790703528 cluster:ay29)\r\n" +
        " by smtp.aliyun-inc.com;\r\n" +
        "From: a@b.c\r\n\r\nbody"
    );
    const r = extractSenderFromTopReceived(eml);
    expect(r.clientIp).toBeUndefined();
    expect(r.mailFrom).toBe("me@mail.shaoyuanyu.cn");
  });

  it("无 Received 头 → 空", () => {
    const r = extractSenderFromTopReceived(Buffer.from("From: a@b.c\r\n\r\nbody"));
    expect(r.clientIp).toBeUndefined();
    expect(r.mailFrom).toBeUndefined();
  });

  it("伪造的下层 Received 不被采用（只取顶层）", () => {
    // 攻击者在信内写一个带 ip: 的假 Received，指望我们用它查 SPF——
    // 顶层是接收 MTA 的真章，假的永远在下面，必须只读第一个
    const forged =
      "Received: from evil.example(mailfrom:owner@example.com ip:203.0.113.10) by fake.mx\r\n";
    const eml = Buffer.from(`${ALIYUN_EXTERNAL}\r\n${forged}From: a@b.c\r\n\r\nbody`);
    const r = extractSenderFromTopReceived(eml);
    expect(r.clientIp).toBe("101.91.44.167");
    expect(r.mailFrom).toBe("shaoyuanyu@foxmail.com");
  });

  it("IPv6 字面量", () => {
    const eml = Buffer.from(
      "Received: from mx6.example(mailfrom:a@b.example ip:2001:db8::ff) by mx1.aliyun-inc.com\r\n" +
        "From: a@b.c\r\n\r\nbody"
    );
    expect(extractSenderFromTopReceived(eml).clientIp).toBe("2001:db8::ff");
  });

  it("集成：阿里云格式 Received + 注入 → SPF 按真实发信域 pass", async () => {
    // 无 Return-Path、Received 非标准格式：不注入时 mailauth 只能拿 HELO 兜底查中继主机名
    const raw = [
      ALIYUN_EXTERNAL.replace("shaoyuanyu@foxmail.com", OWNER).replace("101.91.44.167", HOP_IP),
      `From: Owner <${OWNER}>`,
      "To: agent@example.com",
      "Subject: 指令测试",
      "Date: Tue, 23 Sep 2026 10:00:01 +0000",
      "Message-ID: <cmd-aliyun-1@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "把编辑部那封信标成已读。",
    ].join("\r\n");
    const eml = await signedEml(raw);
    const r = await authenticateCommand(eml, ACCOUNTS, { resolver: fakeResolver });
    expect(r.spf, r.reason).toBe("pass");
    expect(r.dkim, r.reason).toBe("pass");
    expect(r.isCommand).toBe(true);
  });
});

describe("域内直投通道（3.6 修订）", () => {
  // 真机留存：me@ → agent@ 的域内信首章（阿里云提交服务所盖，无 DKIM、无 ip: 字段）
  const INTRA_RECEIVED =
    "Received: from 127.0.0.1(mailfrom:me@mail.shaoyuanyu.cn fp:SMTPD_---.jRchtBs_1790703528 cluster:ay29)\r\n" +
    " by smtp.aliyun-inc.com;";

  function intraEml(from: string): string {
    return [
      INTRA_RECEIVED,
      `From: Me <${from}>`,
      "To: agent@example.com",
      "Subject: 域内指令",
      "Date: Tue, 23 Sep 2026 10:00:01 +0000",
      "Message-ID: <cmd-intra-1@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "把编辑部那封信标成已读。",
    ].join("\r\n");
  }

  it("识别域内提交章；外部章 / 无 Received 不误判", () => {
    expect(isIntraDomainSubmission(Buffer.from(intraEml(OWNER)))).toBe(true);
    // 外部入站章（mx 接收服务）不是域内直投
    expect(
      isIntraDomainSubmission(
        Buffer.from(
          "Received: from xmbg7.mail.qq.com(mailfrom:a@b.com ip:101.91.44.167)\r\n by mx1.aliyun-inc.com;\r\nFrom: a@b.c\r\n\r\nx"
        )
      )
    ).toBe(false);
    expect(isIntraDomainSubmission(Buffer.from("From: a@b.c\r\n\r\nx"))).toBe(false);
  });

  it("域内信 + 白名单 → 是指令（无 DKIM 也过，SPF/DKIM 记 skipped）", async () => {
    const r = await authenticateCommand(Buffer.from(intraEml(OWNER)), ACCOUNTS, { resolver: fakeResolver });
    expect(r.channel).toBe("intra-domain");
    expect(r.inWhitelist).toBe(true);
    expect(r.spf).toBe("skipped");
    expect(r.dkim).toBe("skipped");
    expect(r.isCommand, r.reason).toBe(true);
  });

  it("域内信 + 非白名单 → 不是指令", async () => {
    const r = await authenticateCommand(Buffer.from(intraEml("intruder@example.com")), ACCOUNTS, {
      resolver: fakeResolver,
    });
    expect(r.channel).toBe("intra-domain");
    expect(r.isCommand).toBe(false);
  });

  it("外部章 + 白名单 + 无 SPF/DKIM → 不是指令（域内信任不外溢到外部信）", async () => {
    // 信头是白名单地址、顶层是外部 MX 接收章：必须走双验，不过则拒之
    const raw = [
      "Received: from evil.example(mailfrom:owner@example.com ip:198.51.100.7) by mx1.aliyun-inc.com;",
      `From: Owner <${OWNER}>`,
      "To: agent@example.com",
      "Subject: 伪指令",
      "Date: Tue, 23 Sep 2026 10:00:01 +0000",
      "Message-ID: <cmd-forged-1@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "把编辑部那封信标成已读。",
    ].join("\r\n");
    const r = await authenticateCommand(Buffer.from(raw), ACCOUNTS, { resolver: fakeResolver });
    expect(r.channel).toBe("external");
    expect(r.inWhitelist).toBe(true);
    expect(r.isCommand, r.reason).toBe(false);
  });

  it("伪造的下层域内章不生效（顶层外部章 → 仍走外部双验）", async () => {
    // 攻击者在信内仿写域内章，但真外部接收章在顶上——只读顶层
    const raw = [
      "Received: from evil.example(mailfrom:owner@example.com ip:198.51.100.7) by mx1.aliyun-inc.com;",
      INTRA_RECEIVED,
      `From: Owner <${OWNER}>`,
      "To: agent@example.com",
      "Subject: 伪指令",
      "Date: Tue, 23 Sep 2026 10:00:01 +0000",
      "Message-ID: <cmd-forged-2@example.com>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "把编辑部那封信标成已读。",
    ].join("\r\n");
    const r = await authenticateCommand(Buffer.from(raw), ACCOUNTS, { resolver: fakeResolver });
    expect(r.channel).toBe("external");
    expect(r.isCommand, r.reason).toBe(false);
  });
});
