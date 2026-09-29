import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { syncAccount } from "../src/fetcher.js";
import { recordJudgment, type JudgeOutput } from "../src/judge.js";
import { openAgentDb, type AgentDb } from "../src/ledger.js";
import { createToolsServer } from "../src/mcp.js";
import type { AccountConfig } from "../src/types.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * `/agent/*` 只读视图（第八节 第 5 步 / 4.3 / 4.5）：
 * - 时间线 = agent 账号全部副本合并（收 + 发），方向按 from 判定，游标分页
 * - 详情 = 原始头部 + MIME 结构 + text 正文（不渲染 HTML）+ 判定摘要 + 推理计数
 * - .eml 原件下载、message/rfc822 附件就地展开
 * - 推理只在展开单封信时才拉（5.2）；judgments 列表关联 subject/from/date
 */

let handle: DovecotHandle;
let server: Server;
let port: number;
let db: Db;
let agentDb: AgentDb;
let account: AccountConfig;

async function get(path: string): Promise<{ status: number; body: unknown; res: Response }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body, res };
}

beforeAll(async () => {
  handle = startDovecot("agentview", { specialUse: true });
  await waitReady(handle);
  // 收：01（hr→test）；发：05（agent→me，带 message/rfc822 附件）
  await deliverFixtures(handle, ["01.eml"]);
  await deliverFixtures(handle, ["05-rfc822.eml"], "Sent");

  const dataDir = join(workRoot, "db-agentview");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          id: "agent",
          displayName: "Agent",
          email: "agent@local",
          provider: "dovecot",
          color: "#000000",
          imapHost: "127.0.0.1",
          imapPort: handle.port,
          imapSecure: false,
          folders: ["INBOX", "Sent"],
          enabled: true,
          isAgent: true,
        },
      ],
    })
  );
  writeFileSync(join(dataDir, "credentials.json"), JSON.stringify({ agent: { username: "test", password: "test" } }));

  account = loadAccounts(dataDir)[0];
  const creds = loadCredentials(dataDir);
  db = openDb(join(dataDir, "mail.db"));
  agentDb = openAgentDb(join(dataDir, "agent.db"));
  await syncAccount(db, dataDir, account, creds[account.id]);

  server = createToolsServer({ db, agentDb, dataDir, accounts: [account], creds, caldav: null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  db.close();
  agentDb.close();
  handle.cleanup();
});

describe("/agent/* 只读视图", () => {
  it("时间线：收发合并、方向正确、标注文件夹", async () => {
    const { status, body } = await get("/agent/timeline");
    expect(status).toBe(200);
    const { items, next } = body as { items: Record<string, unknown>[]; next: string | null };
    expect(items).toHaveLength(2);
    expect(next).toBeNull();
    // date 倒序：05（09-26）在 01（09-25）前
    expect(items[0].messageId).toBe("mid:agent-report-1@test.local");
    expect(items[0].direction).toBe("out");
    expect(items[0].folders).toContain("Sent");
    expect(items[1].messageId).toBe("mid:m1@test.local");
    expect(items[1].direction).toBe("in");
  });

  it("时间线分页：limit=1 拿游标，第二页拿到另一条", async () => {
    const p1 = (await get("/agent/timeline?limit=1")).body as {
      items: { messageId: string }[];
      next: string | null;
    };
    expect(p1.items).toHaveLength(1);
    expect(p1.next).toBeTruthy();
    const p2 = (await get(`/agent/timeline?limit=1&before=${encodeURIComponent(p1.next!)}`)).body as {
      items: { messageId: string }[];
      next: string | null;
    };
    expect(p2.items).toHaveLength(1);
    expect(p2.items[0].messageId).not.toBe(p1.items[0].messageId);
    expect(p2.next).toBeNull();
  });

  it("详情：原始头部 + MIME 结构 + text 正文 + rfc822 引用，不含渲染产物", async () => {
    const key = encodeURIComponent("mid:agent-report-1@test.local");
    const { status, body } = await get(`/agent/message/${key}`);
    expect(status).toBe(200);
    const d = body as Record<string, unknown>;
    expect(d.direction).toBe("out");
    // 原始头部块：编码头与 Message-ID 原文都在
    expect(String(d.headersRaw)).toContain("Message-ID: <agent-report-1@test.local>");
    expect(String(d.headersRaw)).toContain("=?UTF-8?B?");
    // MIME 结构：text/plain + message/rfc822 附件
    const parts = d.parts as { kind: string; contentType: string }[];
    expect(parts.map((p) => p.contentType)).toEqual(["text/plain", "message/rfc822"]);
    expect(String(d.text)).toContain("今日汇总");
    // rfc822 可展开引用
    expect(d.rfc822).toEqual([{ index: 0, filename: "original.eml", size: expect.any(Number) }]);
    // 副本（agent 的 Sent）
    const copies = d.copies as { folder: string }[];
    expect(copies.some((c) => c.folder === "Sent")).toBe(true);
    // 尚无判定与推理
    expect(d.judgment).toBeNull();
    expect(d.reasoningCount).toBe(0);
  });

  it(".eml 下载：原件字节逐字一致 + content-disposition", async () => {
    const key = encodeURIComponent("mid:m1@test.local");
    const { status, res, body } = await get(`/agent/message/${key}/eml`);
    expect(status).toBe(200);
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(res.headers.get("content-disposition")).toContain(".eml");
    const fixture = readFileSync(join(workRoot, "..", "test", "fixtures", "eml", "01.eml"), "utf8");
    // 服务端经 IMAP 返回 CRLF，fixture 文件是 LF——归一化行尾后必须逐字一致
    expect(String(body).replace(/\r\n/g, "\n")).toBe(fixture.replace(/\r\n/g, "\n"));
    // 且下载体确实保留了服务端原文的 CRLF（没有二次序列化）
    expect(String(body)).toContain("\r\n");
  });

  it("message/rfc822 就地展开：返回同构的头部 + 结构 + 正文（含 HTML 的 inner 只给纯文本）", async () => {
    const key = encodeURIComponent("mid:agent-report-1@test.local");
    const { status, body } = await get(`/agent/message/${key}/rfc822/0`);
    expect(status).toBe(200);
    const v = body as Record<string, unknown>;
    expect(v.subject).toBe("特刊投稿邀请");
    expect(String(v.from)).toContain("prof@example.edu");
    const parts = v.parts as { contentType: string }[];
    expect(parts.map((p) => p.contentType)).toEqual(["text/plain", "text/html"]);
    expect(String(v.text)).toContain("欢迎你投稿");
    // 纯文本来自 text/plain part；远程 <img> 根本不在返回里（4.4：一律不加载）
    expect(JSON.stringify(v)).not.toContain("tracker.example.com");
  });

  it("rfc822 越界与非 rfc822 附件报错", async () => {
    const key = encodeURIComponent("mid:agent-report-1@test.local");
    expect((await get(`/agent/message/${key}/rfc822/5`)).status).toBe(404);
    const plain = encodeURIComponent("mid:m1@test.local");
    expect((await get(`/agent/message/${plain}/rfc822/0`)).status).toBe(404);
  });

  it("索引外邮件 404；只在别的账号有副本的邮件 404（入口 = agent 视角）", async () => {
    expect((await get(`/agent/message/${encodeURIComponent("mid:nobody@x")}`)).status).toBe(404);

    // 构造一条只有 other 账号副本的消息
    db.prepare(
      `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path)
       VALUES ('mid:other-only@x', '2026-09-26T00:00:00Z', 'a@b', '', '[]', '[]', 's', '', 1, 1, '2026-09-26T00:00:00Z', '')`
    ).run();
    db.prepare("INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES ('other', 'INBOX', 1, 'mid:other-only@x', '')").run();
    const r = await get(`/agent/message/${encodeURIComponent("mid:other-only@x")}`);
    expect(r.status).toBe(404);
    expect(String((r.body as { error: string }).error)).toContain("agent 账号");
  });

  it("judgments 列表关联 subject/from；reasoning 按需拉取且两种文本分开", async () => {
    const out: JudgeOutput = {
      result: {
        verdict: "important",
        labels: ["todo"],
        confidence: 0.9,
        summary: "需要站主处理",
        event: null,
      },
      reasoningText: "真实推理过程",
      tokens: 123,
      model: "test-model",
    };
    recordJudgment(agentDb, "mid:m1@test.local", out, "run", new Date("2026-09-26T10:00:00Z"));
    recordJudgment(agentDb, "mid:m1@test.local", out, "rejudge", new Date("2026-09-26T11:00:00Z"));

    const j = (await get("/agent/judgments")).body as { items: Record<string, unknown>[] };
    expect(j.items).toHaveLength(1); // judgment 一封信一行（重判覆盖）
    expect(j.items[0].verdict).toBe("important");
    expect(j.items[0].subject).toContain("面试");
    expect(j.items[0].from_addr).toBe("hr@example.com");
    expect(j.items[0].model).toBe("test-model");
    expect(j.items[0].prompt_version).toBe("judge-v1");

    const r = (await get(`/agent/reasoning?message=${encodeURIComponent("mid:m1@test.local")}`)).body as {
      items: Record<string, unknown>[];
    };
    expect(r.items).toHaveLength(2); // reasoning 一次处理一行（只追加）
    expect(r.items[0].run_kind).toBe("run");
    expect(r.items[1].run_kind).toBe("rejudge");
    expect(r.items[0].trace).toBe("真实推理过程");
    expect(r.items[0].summary).toBe("需要站主处理");
  });
});
