import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { syncAccount } from "../src/fetcher.js";
import { openAgentDb, type AgentDb } from "../src/ledger.js";
import { createToolsServer } from "../src/mcp.js";
import { TOOLS } from "../src/tools.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * 受限工具面（5.3）：MCP over streamable HTTP + 非 MCP 的 JSON 端点。
 * - tools/list 恰好是 8 个固定工具，且没有任何删除/移动能力（「不能删」靠没有这个函数）
 * - 每次调用经 callTool 落台账（成功/失败都记），工具层写、不可绕过
 * - /ledger、/pending-sends、/health 给前端/人工；confirm 不 exposed 成 MCP 工具
 */

let handle: DovecotHandle;
let server: Server;
let port: number;
let db: Db;
let agentDb: AgentDb;

/** POST /mcp 的最小 JSON-RPC 客户端（响应是 SSE，取 data: 行） */
async function mcp(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const r = (await mcp("tools/call", { name, arguments: args })) as {
    result?: { isError?: boolean; content?: { text: string }[] };
    error?: { message: string };
  };
  if (r.error) throw new Error(`MCP error: ${r.error.message}`);
  const result = r.result;
  if (!result?.content?.[0]) throw new Error(`无 content：${JSON.stringify(r)}`);
  const text = result.content[0].text;
  if (result.isError) throw new Error(text);
  return JSON.parse(text);
}

beforeAll(async () => {
  handle = startDovecot("tools");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml", "02.eml"]);

  const dataDir = join(workRoot, "db-tools");
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    join(dataDir, "accounts.json"),
    JSON.stringify({
      accounts: [
        {
          id: "test",
          displayName: "Test",
          email: "test@local",
          provider: "dovecot",
          color: "#000000",
          imapHost: "127.0.0.1",
          imapPort: handle.port,
          imapSecure: false,
          folders: ["INBOX"],
          enabled: true,
        },
      ],
    })
  );
  writeFileSync(
    join(dataDir, "credentials.json"),
    JSON.stringify({ test: { username: "test", password: "test" } })
  );

  const accounts = loadAccounts(dataDir);
  const creds = loadCredentials(dataDir);
  db = openDb(join(dataDir, "mail.db"));
  agentDb = openAgentDb(join(dataDir, "agent.db"));
  await syncAccount(db, dataDir, accounts[0], creds[accounts[0].id]);

  server = createToolsServer({ db, agentDb, dataDir, accounts, creds, caldav: null });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}, 180_000);

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
  db.close();
  agentDb.close();
  handle.cleanup();
});

describe("受限工具面（MCP）", () => {
  it("tools/list 恰好 8 个固定工具，无删除/移动/EXPUNGE 能力", async () => {
    const r = (await mcp("tools/list", {})) as { result: { tools: { name: string }[] } };
    const names = r.result.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "create_event",
        "get_attachment",
        "get_ledger",
        "list_accounts",
        "read_message",
        "search_messages",
        "send_as_agent",
        "set_flags",
      ].sort()
    );
    for (const n of names) expect(n).not.toMatch(/delete|move|expunge|purge/i);
    // 与 TOOLS 表一致（防 MCP 层与分发层漂移）
    expect(names).toEqual(TOOLS.map((t) => t.name).sort());
  });

  it("list_accounts 不含凭据字段", async () => {
    const rows = (await callTool("list_accounts", {})) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("test");
    expect(JSON.stringify(rows[0])).not.toMatch(/password|username|secret/i);
  });

  it("search → read：库键直通，正文与副本形状正确", async () => {
    const hits = (await callTool("search_messages", { query: "面试" })) as {
      messageId: string;
      subject: string;
    }[];
    expect(hits.length).toBe(1);
    expect(hits[0].messageId).toBe("mid:m1@test.local");

    const msg = (await callTool("read_message", { messageId: hits[0].messageId })) as {
      subject: string;
      text: string;
      copies: { account: string; folder: string; flags: string[] }[];
      attachments: unknown[];
    };
    expect(msg.subject).toContain("面试通知");
    expect(msg.text).toContain("周五下午三点");
    // Dovecot 会给新投递的邮件带会话级 \Recent——只断言归属与「未读」，不逐字比对 flags
    expect(msg.copies.length).toBe(1);
    expect(msg.copies[0]).toMatchObject({ account: "test", folder: "INBOX", uid: 1 });
    expect(msg.copies[0].flags).not.toContain("\\Seen");
  });

  it("read_message 接受裸 Message-ID（宽容归一），不存在的消息报错并落失败台账", async () => {
    const msg = (await callTool("read_message", { messageId: "<m2@test.local>" })) as {
      messageId: string;
    };
    expect(msg.messageId).toBe("mid:m2@test.local");

    await expect(callTool("read_message", { messageId: "<ghost@nowhere>" })).rejects.toThrow(
      "本地索引不存在"
    );
    const failed = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'read_message' AND ok = 0")
      .all() as { error: string }[];
    expect(failed.length).toBe(1);
    expect(failed[0].error).toContain("本地索引不存在");
  });

  it("set_flags 经工具分发：服务端标记变化 + 台账含调用行与副本明细", async () => {
    const r = (await callTool("set_flags", { messageId: "m2@test.local", seen: true })) as {
      updated: number;
    };
    expect(r.updated).toBe(1);

    const call = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'set_flags' AND ok = 1")
      .all() as { detail_json: string }[];
    expect(call.length).toBe(1);
    const copies = agentDb
      .prepare("SELECT * FROM tool_ledger WHERE tool = 'set_flags.copy' AND ok = 1")
      .all() as { detail_json: string }[];
    expect(copies.length).toBe(1);
    expect(JSON.parse(copies[0].detail_json).after).toContain("\\Seen");
  });

  it("get_ledger 经 MCP 返回台账（此前全部调用行都在）", async () => {
    const rows = (await callTool("get_ledger", { limit: 50 })) as {
      tool: string;
      ok: number;
    }[];
    const tools = new Set(rows.map((r) => r.tool));
    // 本文件前面几条用例的调用都应已在台账里
    for (const t of ["list_accounts", "search_messages", "read_message", "set_flags"]) {
      expect(tools.has(t)).toBe(true);
    }
  });

  it("create_event 未配置 CalDAV 时报错（不落 CalDAV，落失败台账）", async () => {
    await expect(
      callTool("create_event", { title: "x", start: "2026-09-28T14:00:00+08:00" })
    ).rejects.toThrow("未配置 CalDAV");
  });
});

describe("工具面的非 MCP JSON 端点", () => {
  it("GET /health 与 /（工具清单）", async () => {
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      ok: boolean;
    };
    expect(health.ok).toBe(true);
    const root = (await (await fetch(`http://127.0.0.1:${port}/`)).json()) as {
      tools: string[];
    };
    expect(root.tools.length).toBe(8);
  });

  it("GET /agent/health：每账号同步健康（5.5），连续失败达阈值后告警", async () => {
    const { markConnected, markFailure, markSyncOk } = await import("../src/health.js");
    // 工具面 server 自己不做抓取，这里模拟一轮「连接成功 + 抓取成功」
    markConnected("test");
    markSyncOk("test");
    const healthy = (await (
      await fetch(`http://127.0.0.1:${port}/agent/health`)
    ).json()) as {
      ok: boolean;
      threshold: number;
      accounts: {
        id: string;
        displayName: string;
        email: string;
        lastOk: string | null;
        failures: number;
        connected: boolean;
        alert: boolean;
      }[];
    };
    expect(healthy.ok).toBe(true);
    expect(healthy.threshold).toBe(3);
    expect(healthy.accounts).toHaveLength(1);
    expect(healthy.accounts[0]).toMatchObject({
      id: "test",
      email: "test@local",
      failures: 0,
      connected: true,
      alert: false,
    });
    expect(healthy.accounts[0].lastOk).not.toBeNull();
    // ⚠ 主机、端口、文件夹、凭据不出现在健康视图里（与 /agent/accounts 同一红线）
    expect(JSON.stringify(healthy.accounts[0])).not.toMatch(/imapHost|smtpHost|password|folders/);

    // 连续失败达到阈值 → 告警态（用例末尾恢复，避免污染其它用例）
    for (let i = 0; i < 3; i++) markFailure("test", new Error("boom"));
    const alerting = (await (
      await fetch(`http://127.0.0.1:${port}/agent/health`)
    ).json()) as { ok: boolean; accounts: { alert: boolean; failures: number }[] };
    expect(alerting.ok).toBe(false);
    expect(alerting.accounts[0]).toMatchObject({ alert: true, failures: 3 });
    markConnected("test");
  });

  it("GET /ledger 分页形状与 /pending-sends", async () => {
    const ledger = (await (
      await fetch(`http://127.0.0.1:${port}/ledger?limit=5`)
    ).json()) as { items: { id: number; tool: string }[] };
    expect(ledger.items.length).toBeGreaterThan(0);
    expect(ledger.items.length).toBeLessThanOrEqual(5);
    // 倒序（最近优先）
    const ids = ledger.items.map((i) => i.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);

    const pending = (await (
      await fetch(`http://127.0.0.1:${port}/pending-sends`)
    ).json()) as { items: unknown[] };
    expect(pending.items).toEqual([]);
  });

  it("GET /agent/accounts：只出 id/显示名/地址/isAgent/enabled，主机与凭据不出门", async () => {
    const body = (await (
      await fetch(`http://127.0.0.1:${port}/agent/accounts`)
    ).json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: "test",
      displayName: "Test",
      email: "test@local",
      isAgent: false,
      enabled: true,
    });
    // 邮件主机/端口/文件夹（以及任何凭据）一律不得出现在响应里
    expect(JSON.stringify(body)).not.toMatch(/imapHost|imapPort|smtp|folders|password|username/i);
  });

  it("confirm/discard 不存在的 id 报错；未知端点 404", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pending-sends/999/confirm`, {
      method: "POST",
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("不存在");

    const nf = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(nf.status).toBe(404);
  });
});
