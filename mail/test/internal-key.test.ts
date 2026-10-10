import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.js";
import { internalKeyMatches, isLoopbackHost } from "../src/internal-key.js";
import { openAgentDb } from "../src/ledger.js";
import { createToolsServer } from "../src/mcp.js";
import type { ToolsContext } from "../src/tools.js";

describe("内部密钥的判定", () => {
  it("回环地址不需要密钥，其它地址需要", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", " 127.0.0.1 "]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of ["0.0.0.0", "::", "10.0.0.5", "webmail"]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });

  it("完全一致才算命中：缺值、长度不同、内容不同都判否", () => {
    expect(internalKeyMatches("abc123", "abc123")).toBe(true);
    expect(internalKeyMatches(undefined, "abc123")).toBe(false);
    expect(internalKeyMatches("", "abc123")).toBe(false);
    expect(internalKeyMatches("abc12", "abc123")).toBe(false);
    expect(internalKeyMatches("abc124", "abc123")).toBe(false);
    expect(internalKeyMatches("abc123 ", "abc123")).toBe(false);
  });
});

describe("工具面：配了内部密钥就校验请求头", () => {
  let server: Server;
  let base: string;
  let db: ReturnType<typeof openDb>;
  let agentDb: ReturnType<typeof openAgentDb>;

  beforeAll(async () => {
    db = openDb(":memory:");
    agentDb = openAgentDb(":memory:");
    const ctx: ToolsContext = { db, agentDb, dataDir: ".", accounts: [], creds: {}, caldav: null };
    server = createToolsServer(ctx, { internalKey: "s3cret" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(() => r(undefined)));
    db.close();
    agentDb.close();
  });

  it("缺请求头 / 值不对 → 401；值一致 → 200", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/health`, { headers: { "x-internal-key": "wrong" } })).status
    ).toBe(401);
    const ok = await fetch(`${base}/health`, { headers: { "x-internal-key": "s3cret" } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, ts: expect.any(String) });
  });

  it("工具面端点（/mcp）同样受保护", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("只读视图端点（/agent/timeline）同样受保护", async () => {
    expect((await fetch(`${base}/agent/timeline`)).status).toBe(401);
  });
});
