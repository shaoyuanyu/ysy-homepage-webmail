import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ACCOUNT_COLOR_PALETTE,
  AccountError,
  addAccount,
  deleteAccount,
  normalizeAccountInput,
  repairAccountColors,
} from "../src/accounts.js";
import { createApiServer } from "../src/api.js";
import type { WebmailAccountsFile } from "../src/types.js";
import { makeContext, type TestContext } from "./context.js";
import { startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

/** 指向 dovecot test 用户的合法新增输入（与 acc1 同服务器、不同 id/邮箱） */
function validInput(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "镜像",
    email: "mirror@local",
    imapHost: dovecot.host,
    imapPort: dovecot.port,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: sink.port,
    smtpSecure: false,
    username: "test",
    password: "test",
    folders: ["INBOX"],
    ...overrides,
  };
}

function readAccounts(dir: string): WebmailAccountsFile {
  return JSON.parse(readFileSync(join(dir, "accounts.json"), "utf8")) as WebmailAccountsFile;
}

beforeAll(async () => {
  dovecot = startDovecot("accounts");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "accounts");
  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  server.close();
  await sink.close();
  tc.cleanup();
  dovecot.cleanup();
});

describe("账号管理：输入校验（normalizeAccountInput）", () => {
  const existing = new Set(["me"]);

  it("缺显示名称 / 邮箱非法 / 缺密码 / 端口非法分别报错", () => {
    expect(() => normalizeAccountInput({}, existing)).toThrow("缺少显示名称");
    expect(() =>
      normalizeAccountInput({ displayName: "x", email: "not-an-email" }, existing)
    ).toThrow("邮箱地址非法");
    expect(() =>
      normalizeAccountInput(
        { displayName: "x", email: "a@b.c", imapHost: "h", smtpHost: "h", imapPort: 993, smtpPort: 465, imapSecure: true, smtpSecure: true },
        existing
      )
    ).toThrow("缺少密码");
    expect(() =>
      normalizeAccountInput(
        { displayName: "x", email: "a@b.c", imapHost: "h", smtpHost: "h", imapPort: 0, smtpPort: 465, imapSecure: true, smtpSecure: true, password: "p" },
        existing
      )
    ).toThrow("IMAP 端口非法");
  });

  it("id 冲突报 409；自动推导 id 并去重", () => {
    const base = {
      displayName: "x",
      email: "Me@Example.com",
      imapHost: "h",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "h",
      smtpPort: 465,
      smtpSecure: true,
      password: "p",
    };
    expect(() => normalizeAccountInput({ ...base, id: "me" }, new Set(["me"]))).toThrowError(
      AccountError
    );
    const { account } = normalizeAccountInput(base, new Set(["me"]));
    expect(account.id).toBe("me-2");
  });

  it("用户名缺省回退邮箱；folders 缺省 INBOX；全空 folders 报错", () => {
    const { account, cred } = normalizeAccountInput(
      { displayName: "x", email: "a@b.c", imapHost: "h", imapPort: 993, imapSecure: true, smtpHost: "h", smtpPort: 465, smtpSecure: true, password: "p" },
      new Set()
    );
    expect(cred.username).toBe("a@b.c");
    expect(account.folders).toEqual(["INBOX"]);
    expect(() =>
      normalizeAccountInput(
        { displayName: "x", email: "a@b.c", imapHost: "h", imapPort: 993, imapSecure: true, smtpHost: "h", smtpPort: 465, smtpSecure: true, password: "p", folders: [" ", ""] },
        new Set()
      )
    ).toThrow("同步文件夹");
  });

  /**
   * 缺省色必须随已有账号变化（2026-10-09 用户报「账号指示器里多个账号颜色没有区别」）：
   * 以前缺省写死 #0ea5e9，从界面加的账号全是同一个色，色点等于没有信息。
   * 顺序 = 「每次取离已用色最远」贪心解（cyan → pink → violet → orange → teal）。
   */
  it("颜色：显式指定原样保留；缺省取色板里第一个未占用的色（顺序 = 差异最大优先）", () => {
    const base = {
      displayName: "x",
      email: "a@b.c",
      imapHost: "h",
      imapPort: 993,
      imapSecure: true,
      smtpHost: "h",
      smtpPort: 465,
      smtpSecure: true,
      password: "p",
    };
    expect(normalizeAccountInput({ ...base, color: "#123456" }, new Set()).account.color).toBe(
      "#123456"
    );
    expect(normalizeAccountInput(base, new Set()).account.color).toBe("cyan");
    // 第 2 个账号拿的是色板里排在 cyan 后面那一格（顺序 = 观感序，不是紧邻色；
    // 统一明度/彩度后任意两色的 OKLab ΔE 都 ≥0.95×2C，顺序影响 <1%——见 MAIL-AGENT.md 4.2）
    expect(normalizeAccountInput(base, new Set(), ["cyan"]).account.color).toBe("pink");
    expect(normalizeAccountInput(base, new Set(), ["cyan", "pink"]).account.color).toBe("violet");
    expect(normalizeAccountInput(base, new Set(), ["cyan", "violet"]).account.color).toBe("pink");
    // 大小写/空白归一：已占用的颜色名照样算占用
    expect(normalizeAccountInput(base, new Set(), [" CYAN ", "PINK"]).account.color).toBe("violet");
    // 历史缺省色 #0ea5e9 视作 cyan 占位（否则新账号又会拿到同一种蓝）
    expect(normalizeAccountInput(base, new Set(), ["#0EA5E9"]).account.color).toBe("pink");
    expect(ACCOUNT_COLOR_PALETTE).toContain(
      normalizeAccountInput(base, new Set(), ACCOUNT_COLOR_PALETTE).account.color
    );
  });

  /**
   * 撞色自动修复（2026-10-09 用户要求「不要手动分配」）：存量账号（缺省色写死年代进来的）
   * 在 webmaild 启动时被自动分开，不需要用户挨个进弹窗改色。
   */
  it("颜色：撞色自动修复——同色只改后面的那个，修完再跑一次幂等", () => {
    const mk = (id: string, color: string) =>
      ({ id, displayName: id, email: `${id}@x.c`, color }) as unknown as Parameters<
        typeof repairAccountColors
      >[0][number];
    // 两个账号都是历史缺省色 → 第二个改取「离 cyan 最远」的 pink
    const dup = [mk("me", "#0ea5e9"), mk("other", "#0ea5e9")];
    expect(repairAccountColors(dup)).toEqual(["other"]);
    expect(dup.map((a) => a.color)).toEqual(["#0ea5e9", "pink"]);
    // 幂等：再跑一次没有任何改动、也不写盘
    expect(repairAccountColors(dup)).toEqual([]);
    // 三色同值 → 后两个分别拿到 pink / violet；第一个原样不动
    const triple = [mk("a", "cyan"), mk("b", "cyan"), mk("c", "cyan")];
    expect(repairAccountColors(triple)).toEqual(["b", "c"]);
    expect(triple.map((a) => a.color)).toEqual(["cyan", "pink", "violet"]);
    // 空色（手改配置漏了 color）也算撞色，补一个
    const blank = [mk("a", "cyan"), mk("b", "")];
    expect(repairAccountColors(blank)).toEqual(["b"]);
    expect(blank[1].color).toBe("pink");
    // 账号数超过色板长度：撞色不可避免，但不能每次启动都重写注册表（无改动 = 不算修复）
    const six = ACCOUNT_COLOR_PALETTE.map((c, i) => mk(`a${i}`, c));
    six.push(mk("a5", ACCOUNT_COLOR_PALETTE[0]));
    expect(repairAccountColors(six)).toEqual([]);
  });
});

describe("账号管理：增删（真实 dovecot + smtp sink）", () => {
  it("连接测试失败（密码错误）不落盘、不进 ctx", async () => {
    const before = readAccounts(tc.dir).accounts.length;
    await expect(addAccount(tc.ctx, validInput({ password: "wrong" }))).rejects.toThrow("IMAP 连接失败");
    expect(readAccounts(tc.dir).accounts.length).toBe(before);
    expect(tc.ctx.accounts.has("mirror")).toBe(false);
  });

  it("连接被拒（不可达端口）反复尝试不落盘、进程不挂（ImapFlow 异步 error 回归）", async () => {
    const unreachable = validInput({ imapPort: 1 }); // 127.0.0.1:1 → ECONNREFUSED
    await expect(addAccount(tc.ctx, unreachable)).rejects.toThrow("IMAP 连接失败");
    await expect(addAccount(tc.ctx, unreachable)).rejects.toThrow("IMAP 连接失败");
    // 若 ImapFlow 的异步 error 事件未被吞掉，进程已在此刻崩溃、后续断言不会执行
    expect(tc.ctx.accounts.has("mirror")).toBe(false);
  });

  it("HTTP：校验失败 400，连接失败 502", async () => {
    const bad = await api("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(bad.status).toBe(400);

    const noConn = await api("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput({ password: "wrong" })),
    });
    expect(noConn.status).toBe(502);
  });

  it("HTTP：添加成功 → 201 + 落盘（credentials 600）；删除成功 → 数据与配置一并清理", async () => {
    const added = await api("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validInput()),
    });
    expect(added.status).toBe(201);
    const summary = (await added.json()) as { id: string };
    expect(summary.id).toBe("mirror");

    // 落盘校验
    const onDisk = readAccounts(tc.dir);
    expect(onDisk.accounts.map((a) => a.id)).toContain("mirror");
    const creds = JSON.parse(readFileSync(join(tc.dir, "credentials.json"), "utf8")) as Record<string, unknown>;
    expect(creds.mirror).toEqual({ username: "test", password: "test" });
    expect(statSync(join(tc.dir, "credentials.json")).mode & 0o777).toBe(0o600);
    // remoteImageDomains 等顶层字段不被覆盖
    expect(onDisk.remoteImageDomains).toEqual(["edu.cn"]);

    // GET /accounts 能见到（含未读数）
    const list = (await (await api("/accounts")).json()) as { id: string }[];
    expect(list.map((a) => a.id)).toContain("mirror");

    // 删除
    const del = await api("/accounts/mirror", { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(readAccounts(tc.dir).accounts.map((a) => a.id)).not.toContain("mirror");
    const credsAfter = JSON.parse(readFileSync(join(tc.dir, "credentials.json"), "utf8")) as Record<string, unknown>;
    expect(credsAfter.mirror).toBeUndefined();
    expect(tc.ctx.accounts.has("mirror")).toBe(false);
  });

  it("HTTP：新增账号不传 folders → 自动按服务端清单预填（INBOX + 特殊用途文件夹）", async () => {
    // 2026-10-07：以前缺省只同步 INBOX，而「发件」页依赖服务器「已发送」在白名单里
    // → 新账号的「发件」页永远为空。现在 addAccount 用连接测试顺带拿到的 LIST 结果预填。
    const res = await api("/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validInput({ email: "auto@local" }), folders: undefined }),
    });
    expect(res.status).toBe(201);
    const summary = (await res.json()) as { id: string; folders: string[] };
    // dovecot 测试容器：INBOX / Sent(\Sent) / Drafts(\Drafts) / Trash(\Trash) 带 special_use
    expect(summary.folders[0]).toBe("INBOX");
    expect(summary.folders).toContain("Sent");
    expect(summary.folders).toContain("Drafts");
    expect(summary.folders).toContain("Trash");
    const onDisk = readAccounts(tc.dir).accounts.find((a) => a.email === "auto@local");
    expect(onDisk?.folders).toEqual(summary.folders);
    // 清理：后续用例（「删到只剩一个 409」）依赖账号数量，别把这个账号留下
    const del = await api(`/accounts/${summary.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("HTTP：GET /folders 返回清单 + 推荐集 + 当前白名单；POST /folders 预览（无需落盘）", async () => {
    const res = await api("/folders?account=acc1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      folders: { path: string; specialUse: string; selectable: boolean }[];
      suggested: string[];
      synced: string[];
    };
    expect(body.folders.map((f) => f.path)).toContain("INBOX");
    expect(body.folders.find((f) => f.path === "Sent")?.specialUse).toBe("\\Sent");
    expect(body.suggested[0]).toBe("INBOX");
    expect(body.synced).toEqual(["INBOX", "Sent", "Trash"]);

    // 未知账号 / 缺参数 → 404（文案区分两种情形）
    expect((await api("/folders?account=nope")).status).toBe(404);
    expect((await api("/folders")).status).toBe(404);

    // 预览：用表单里的连接参数登录，不落盘
    const before = readAccounts(tc.dir).accounts.length;
    const preview = await api("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "mirror@local",
        imapHost: dovecot.host,
        imapPort: dovecot.port,
        imapSecure: false,
        username: "test",
        password: "test",
      }),
    });
    expect(preview.status).toBe(200);
    const pv = (await preview.json()) as { folders: { path: string }[]; suggested: string[] };
    expect(pv.folders.map((f) => f.path)).toContain("Sent");
    expect(pv.suggested).toContain("Drafts");
    expect(readAccounts(tc.dir).accounts.length).toBe(before);

    // 预览：密码错 → 502，且不落盘
    const bad = await api("/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "mirror@local",
        imapHost: dovecot.host,
        imapPort: dovecot.port,
        imapSecure: false,
        username: "test",
        password: "wrong",
      }),
    });
    expect(bad.status).toBe(502);
    expect(readAccounts(tc.dir).accounts.length).toBe(before);
  });

  it("HTTP：修改账号（PUT）——备注名/发件人姓名/文件夹；元数据变更不测连接；404/400", async () => {
    // 只改元数据（备注名 / 发件人姓名 / 文件夹）：不触发连接测试，立即 200
    const res = await api("/accounts/acc2", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: "学校（改）",
        senderName: "Shaoyuan Yu",
        folders: ["INBOX", "Sent"],
      }),
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as {
      displayName: string;
      senderName: string;
      folders: string[];
      email: string;
    };
    expect(summary.displayName).toBe("学校（改）");
    expect(summary.senderName).toBe("Shaoyuan Yu");
    expect(summary.folders).toEqual(["INBOX", "Sent"]);

    // 落盘 + ctx 即时生效
    const onDisk = readAccounts(tc.dir).accounts.find((a) => a.id === "acc2");
    expect(onDisk?.displayName).toBe("学校（改）");
    expect(onDisk?.senderName).toBe("Shaoyuan Yu");
    expect(tc.ctx.accounts.get("acc2")?.senderName).toBe("Shaoyuan Yu");
    // 凭据未动（username / password 缺省 = 保持原值）
    const creds = JSON.parse(readFileSync(join(tc.dir, "credentials.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(creds.acc2).toEqual({ username: "test2", password: "test2" });

    // 清空发件人姓名（空串 = From 只发地址）
    const cleared = (await (
      await api("/accounts/acc2", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ senderName: "" }),
      })
    ).json()) as { senderName: string };
    expect(cleared.senderName).toBe("");
    expect(tc.ctx.accounts.get("acc2")?.senderName).toBeUndefined();

    // 不存在的账号 → 404；备注名清空 → 400
    const nope = await api("/accounts/nope", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "x" }),
    });
    expect(nope.status).toBe(404);
    const bad = await api("/accounts/acc1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: "" }),
    });
    expect(bad.status).toBe(400);
  });

  it("删除不存在的账号 404；删到只剩一个时 409", async () => {
    const notFound = await api("/accounts/nope", { method: "DELETE" });
    expect(notFound.status).toBe(404);

    deleteAccount(tc.ctx, "acc2");
    expect(() => deleteAccount(tc.ctx, "acc1")).toThrow("至少保留一个账号");
  });
});

describe("远程图片白名单（4.4）：GET/PUT /remote-image-domains", () => {
  it("GET 返回当前白名单", async () => {
    const res = await api("/remote-image-domains");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { domains: string[] }).domains).toEqual(["edu.cn"]);
  });

  it("PUT：归一化（小写 / trim / 去重 / 去空）+ 落盘 + ctx 即时生效", async () => {
    const accountsBefore = readAccounts(tc.dir).accounts.map((a) => a.id);
    const res = await api("/remote-image-domains", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: [" EDU.cn ", "cdn.Example.com", "edu.cn", ""] }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { domains: string[] }).domains).toEqual([
      "edu.cn",
      "cdn.example.com",
    ]);
    // 落盘
    expect(readAccounts(tc.dir).remoteImageDomains).toEqual(["edu.cn", "cdn.example.com"]);
    // ctx 即时生效（renderMailHtml 每次渲染现读 ctx.remoteImageDomains）
    expect(tc.ctx.remoteImageDomains).toEqual(["edu.cn", "cdn.example.com"]);
    // accounts 数组不受影响
    expect(readAccounts(tc.dir).accounts.map((a) => a.id)).toEqual(accountsBefore);
  });

  it("PUT：非法域名 400 且不改变现状；非数组 400", async () => {
    for (const bad of [["not a domain"], ["-bad-.com"], ["localhost"], ["a".repeat(254) + ".com"]]) {
      const res = await api("/remote-image-domains", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ domains: bad }),
      });
      expect(res.status).toBe(400);
    }
    const notArray = await api("/remote-image-domains", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: "edu.cn" }),
    });
    expect(notArray.status).toBe(400);
    // 现状未变
    expect(tc.ctx.remoteImageDomains).toEqual(["edu.cn", "cdn.example.com"]);
    expect(readAccounts(tc.dir).remoteImageDomains).toEqual(["edu.cn", "cdn.example.com"]);
  });

  it("PUT：清空为合法操作（回到全拦截默认）", async () => {
    const res = await api("/remote-image-domains", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ domains: [] }),
    });
    expect(res.status).toBe(200);
    expect(tc.ctx.remoteImageDomains).toEqual([]);
    expect(readAccounts(tc.dir).remoteImageDomains).toEqual([]);
  });
});
