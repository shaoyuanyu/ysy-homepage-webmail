import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { simpleParser } from "mailparser";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { syncAccount } from "../src/fetcher.js";
import { insertPendingSend, openAgentDb, type AgentDb } from "../src/ledger.js";
import { createToolsServer } from "../src/mcp.js";
import { claimTask, enqueueTask, finishTask } from "../src/queue.js";
import { WorkerPool } from "../src/worker.js";
import { startSmtpSink, type SmtpSink } from "../../webmail/test/smtp-sink.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * worker 池集成测试（5.1 / 5.2）：
 * - 全链路真实：Dovecot 取信 → 真工具面（MCP over HTTP）→ agent.db 落产物；
 *   唯一注入的是模型（MockLanguageModelV4）与 CalDAV/DNS 桩——外部 API 不进测试
 * - judge：read_message（经 MCP）→ judgment/reasoning 落库；event 标签 → create_event
 * - command：多轮工具调用（search_messages）→ 回执经 send_as_agent 发给指令来源
 * - report：当日判定分布 + 待确认提醒 → 发给 reportTo
 */

const ME = "hr@example.com"; // fixture 01.eml 的发件人（指令来源，白名单内 → 回执直发）
const AGENT = "agent@mail.test";

let dovecot: DovecotHandle;
let sink: SmtpSink;
let caldav: Server;
let caldavRequests: { method: string; body: string }[];
let toolsServer: Server;
let mcpUrl: string;
let db: Db;
let agentDb: AgentDb;

const USAGE = {
  inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function makePool(model: MockLanguageModelV4): WorkerPool {
  return new WorkerPool({ agentDb, mcpUrl, model, modelName: "mock-model", reportTo: ME });
}

async function waitFor(cond: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(async () => {
  dovecot = startDovecot("worker", { specialUse: true });
  await waitReady(dovecot);
  await deliverFixtures(dovecot, ["01.eml", "02.eml"]);
  sink = await startSmtpSink();

  const dataDir = join(workRoot, "db-worker");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          id: "me",
          displayName: "Me",
          email: ME,
          provider: "test",
          color: "#000000",
          imapHost: "127.0.0.1",
          imapPort: 1, // 不连接（me 只作白名单与 reportTo）
          imapSecure: false,
          folders: ["INBOX"],
          enabled: true,
        },
        {
          id: "agent",
          displayName: "Agent",
          email: AGENT,
          provider: "test",
          color: "#111111",
          imapHost: "127.0.0.1",
          imapPort: dovecot.port,
          imapSecure: false,
          smtpHost: "127.0.0.1",
          smtpPort: sink.port,
          smtpSecure: false,
          isAgent: true,
          folders: ["INBOX"],
          enabled: true,
        },
      ],
    })
  );
  writeFileSync(
    join(dataDir, "credentials.json"),
    JSON.stringify({ agent: { username: "test", password: "test" } })
  );

  const accounts = loadAccounts(dataDir);
  const creds = loadCredentials(dataDir);
  db = openDb(join(dataDir, "mail.db"));
  agentDb = openAgentDb(join(dataDir, "agent.db"));
  await syncAccount(db, dataDir, accounts[1], creds.agent);

  // CalDAV 微型桩（与 events.test.ts 同款：记录请求，PROPFIND 207 / MKCOL·PUT 201）
  caldavRequests = [];
  caldav = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      caldavRequests.push({ method: req.method ?? "", body: Buffer.concat(chunks).toString("utf8") });
      if (req.method === "PROPFIND") {
        res.writeHead(207, { "content-type": "application/xml" });
        res.end("<multistatus/>");
        return;
      }
      res.writeHead(req.method === "MKCOL" || req.method === "PUT" ? 201 : 405);
      res.end();
    });
  });
  await new Promise<void>((r) => caldav.listen(0, "127.0.0.1", r));
  const caldavPort = (caldav.address() as AddressInfo).port;

  toolsServer = createToolsServer({
    db,
    agentDb,
    dataDir,
    accounts,
    creds,
    caldav: {
      url: `http://127.0.0.1:${caldavPort}`,
      collection: "agent-schedule",
      username: "caladmin",
      password: "secret",
    },
  });
  await new Promise<void>((r) => toolsServer.listen(0, "127.0.0.1", r));
  mcpUrl = `http://127.0.0.1:${(toolsServer.address() as AddressInfo).port}/mcp`;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => toolsServer.close(() => r(undefined)));
  await new Promise((r) => caldav.close(() => r(undefined)));
  await sink.close();
  db.close();
  agentDb.close();
  dovecot.cleanup();
});

describe("agent worker 池", () => {
  it("judge 任务（事件驱动循环）：read_message 经 MCP → judgment/reasoning 落库 + 台账留痕", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          { type: "reasoning", text: "HR 直接发给本人，含确定时间，重要且待办" },
          {
            type: "text",
            text: JSON.stringify({
              verdict: "important",
              labels: ["todo"],
              confidence: 0.88,
              summary: "面试通知，需要安排时间",
              event: null,
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      } as never,
    });
    const pool = makePool(model);
    const running = pool.run(1);
    try {
      enqueueTask(agentDb, "judge", { messageId: "mid:m1@test.local" });
      pool.notify(); // 事件驱动唤醒：不等 30s 兜底轮询
      await waitFor(
        () =>
          (agentDb.prepare("SELECT COUNT(*) AS n FROM judgment WHERE message_id = ?").get("mid:m1@test.local") as { n: number }).n > 0,
        "judgment 落库"
      );
    } finally {
      await pool.stop();
      void running.catch(() => {});
    }

    const j = agentDb.prepare("SELECT * FROM judgment WHERE message_id = ?").get("mid:m1@test.local") as {
      verdict: string;
      labels_json: string;
      model: string;
      prompt_version: string;
    };
    expect(j.verdict).toBe("important");
    expect(JSON.parse(j.labels_json)).toEqual(["todo"]);
    expect(j.model).toBe("mock-model");
    expect(j.prompt_version).toBe("judge-v1");

    const reasoning = agentDb
      .prepare("SELECT * FROM reasoning WHERE message_id = ? AND run_kind = 'run'")
      .all("mid:m1@test.local") as { trace: string | null; summary: string }[];
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].trace).toBe("HR 直接发给本人，含确定时间，重要且待办");
    expect(reasoning[0].summary).toBe("面试通知，需要安排时间");

    // read_message 是经 MCP 工具面走的 → 台账必有成功行（不可绕过）
    const ledger = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'read_message' AND ok = 1")
      .all() as unknown[];
    expect(ledger.length).toBeGreaterThan(0);
  });

  it("judge 出 event 标签 → 经 MCP create_event 写 CalDAV（判定照常落库）", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              verdict: "normal",
              labels: ["event"],
              confidence: 0.7,
              summary: "例会邀请",
              event: { title: "修稿讨论会", start: "2026-09-30T14:00:00+08:00", location: "腾讯会议" },
            }),
          },
        ],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        warnings: [],
      } as never,
    });
    const pool = makePool(model);
    try {
      enqueueTask(agentDb, "judge", { messageId: "mid:m2@test.local" });
      const task = claimTask(agentDb);
      expect(task?.kind).toBe("judge");
      await pool.handle(task!);
      finishTask(agentDb, task!.id);
    } finally {
      await pool.stop();
    }

    const j = agentDb.prepare("SELECT verdict FROM judgment WHERE message_id = ?").get("mid:m2@test.local") as {
      verdict: string;
    };
    expect(j.verdict).toBe("normal");
    const put = caldavRequests.find((r) => r.method === "PUT");
    expect(put).toBeDefined();
    expect(put!.body).toContain("修稿讨论会");
    // create_event 也落台账
    const ledger = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'create_event' AND ok = 1")
      .all() as unknown[];
    expect(ledger.length).toBeGreaterThan(0);
  });

  it("command 任务：多轮工具调用（search_messages）→ 回执发给指令来源（白名单内直发）", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{ type: "tool-call", toolCallId: "c1", toolName: "search_messages", input: JSON.stringify({ query: "面试" }) }],
          finishReason: { unified: "tool-calls", raw: "tool_calls" },
          usage: USAGE,
          warnings: [],
        },
        {
          content: [{ type: "text", text: "找到 1 封面试相关邮件：周五下午三点的面试通知。" }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: USAGE,
          warnings: [],
        },
      ] as never,
    });
    const pool = makePool(model);
    try {
      enqueueTask(agentDb, "command", { messageId: "mid:m1@test.local" });
      const task = claimTask(agentDb);
      expect(task?.kind).toBe("command");
      await pool.handle(task!);
      finishTask(agentDb, task!.id);
    } finally {
      await pool.stop();
    }

    // 模型↔工具面恰好两个来回（第一步发工具调用，第二步出终稿）
    expect(model.doGenerateCalls).toHaveLength(2);
    // search_messages 真被调过（台账 + 第二次调用带着工具结果）
    const searchLedger = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'search_messages' AND ok = 1")
      .all() as unknown[];
    expect(searchLedger.length).toBeGreaterThan(0);

    // 指令处理记 reasoning（run_kind=command）
    const reasoning = agentDb
      .prepare("SELECT * FROM reasoning WHERE message_id = ? AND run_kind = 'command'")
      .all("mid:m1@test.local") as { summary: string }[];
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].summary).toContain("面试通知");

    // 回执：发给指令来源 hr@example.com（白名单内 → 直发），From 是 agent@
    await waitFor(() => sink.received.length > 0, "回执到达 SMTP 接收端");
    const receipt = await simpleParser(sink.received[sink.received.length - 1]);
    const receiptTo = Array.isArray(receipt.to) ? receipt.to[0] : receipt.to;
    expect(receiptTo?.value[0]?.address).toBe(ME);
    expect(receipt.from?.value[0]?.address).toBe(AGENT);
    expect(receipt.subject).toContain("Re: 面试通知");
    expect(receipt.inReplyTo).toBe("<m1@test.local>");
    expect(receipt.text).toContain("找到 1 封面试相关邮件");
  });

  it("report 任务：当日判定分布 + 重要清单 + 待确认提醒 → 发给 reportTo", async () => {
    // 造一条待确认外发（3.7 的提醒随汇报走）
    insertPendingSend(agentDb, {
      to: ["someone@outside.example"],
      cc: [],
      subject: "需要站主确认的外发",
      text: "……",
      mime: Buffer.from("MIME"),
      messageId: "mid:pending-1",
    });

    const pool = makePool(new MockLanguageModelV4());
    const sinkBefore = sink.received.length;
    try {
      enqueueTask(agentDb, "report");
      const task = claimTask(agentDb);
      expect(task?.kind).toBe("report");
      await pool.handle(task!);
      finishTask(agentDb, task!.id);
    } finally {
      await pool.stop();
    }

    // handle 返回时 SMTP 投递已完成（send_as_agent 全程 await）
    expect(sink.received.length).toBe(sinkBefore + 1);
    const reportMail = await simpleParser(sink.received[sink.received.length - 1]);
    const reportTo = Array.isArray(reportMail.to) ? reportMail.to[0] : reportMail.to;
    expect(reportTo?.value[0]?.address).toBe(ME);
    expect(reportMail.subject).toContain("邮件日报");
    // 前面两条用例已判过 m1(important)/m2(normal) → 分布里都有；且有待确认提醒
    expect(reportMail.text).toMatch(/important: [1-9]/);
    expect(reportMail.text).toMatch(/normal: [1-9]/);
    expect(reportMail.text).toContain("待确认队列");

    const reasoning = agentDb
      .prepare("SELECT * FROM reasoning WHERE run_kind = 'report'")
      .all() as { summary: string }[];
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0].summary).toContain("待确认 1");
  });
});
