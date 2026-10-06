import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccountError, addAccount, deleteAccount, normalizeAccountInput } from "../src/accounts.js";
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
