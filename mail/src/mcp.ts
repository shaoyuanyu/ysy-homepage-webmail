import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callTool, TOOLS, type ToolsContext } from "./tools.js";
import { listLedger, listPendingSends } from "./ledger.js";
import { confirmPendingSend, discardPendingSend } from "./send.js";
import {
  agentJudgments,
  agentMessage,
  agentMessageEml,
  agentMessageRfc822,
  agentReasoning,
  agentTimeline,
  AgentViewError,
} from "./agentview.js";

/**
 * 工具面 HTTP 服务（5.3）：MCP over streamable HTTP + 给前端/人工的 JSON 端点。
 * 绑 127.0.0.1、不做认证（与 webmaild 同一信任边界）。
 * - POST /mcp                          MCP 工具面（无状态，每请求一个 transport）
 * - GET  /health                       存活
 * - GET  /ledger?limit=&beforeId=      台账只读视图（前端台账页签用）
 * - GET  /pending-sends                待确认外发队列（不含 MIME 字节）
 * - POST /pending-sends/:id/confirm    确认发出（人操作；不进 MCP，agent 不能给自己开闸）
 * - POST /pending-sends/:id/discard    丢弃
 * - GET  /agent/*                      `/mail/agent` 只读视图（第 5 步）：timeline/message/eml/rfc822/judgments/reasoning
 */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function buildMcpServer(ctx: ToolsContext): McpServer {
  const server = new McpServer({ name: "maild", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args) => {
        const result = await callTool(ctx, tool.name, args as Record<string, unknown>);
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      }
    );
  }
  return server;
}

export function createToolsServer(ctx: ToolsContext): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "POST" && url.pathname === "/mcp") {
        const server = buildMcpServer(ctx);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        const body = await readBody(req);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true, ts: new Date().toISOString() });
      }
      if (req.method === "GET" && url.pathname === "/") {
        return sendJson(res, 200, { tools: TOOLS.map((t) => t.name) });
      }
      if (req.method === "GET" && url.pathname === "/ledger") {
        const limit = url.searchParams.get("limit");
        const beforeId = url.searchParams.get("beforeId");
        return sendJson(res, 200, {
          items: listLedger(ctx.agentDb, {
            limit: limit ? Number(limit) : undefined,
            beforeId: beforeId ? Number(beforeId) : undefined,
          }),
        });
      }
      if (req.method === "GET" && url.pathname === "/pending-sends") {
        return sendJson(res, 200, { items: listPendingSends(ctx.agentDb) });
      }

      // ---- /agent/* 只读视图（第 5 步；4.5：前端读 agent 导出的只读视图，无写路径）----
      // 台账/待确认在 /agent 下再挂一份：前端只跟 /agent/* 打交道（站点代理一条通路）
      if (req.method === "GET" && url.pathname === "/agent/ledger") {
        const limit = url.searchParams.get("limit");
        const beforeId = url.searchParams.get("beforeId");
        return sendJson(res, 200, {
          items: listLedger(ctx.agentDb, {
            limit: limit ? Number(limit) : undefined,
            beforeId: beforeId ? Number(beforeId) : undefined,
          }),
        });
      }
      if (req.method === "GET" && url.pathname === "/agent/pending-sends") {
        return sendJson(res, 200, { items: listPendingSends(ctx.agentDb) });
      }
      const agentPendingMatch = url.pathname.match(/^\/agent\/pending-sends\/(\d+)\/(confirm|discard)$/);
      if (req.method === "POST" && agentPendingMatch) {
        const id = Number(agentPendingMatch[1]);
        if (agentPendingMatch[2] === "confirm") {
          const r = await confirmPendingSend({
            agentDb: ctx.agentDb,
            accounts: ctx.accounts,
            creds: ctx.creds,
            id,
          });
          return sendJson(res, 200, r);
        }
        await discardPendingSend({ agentDb: ctx.agentDb, id });
        return sendJson(res, 200, { discarded: true });
      }
      if (req.method === "GET" && url.pathname === "/agent/timeline") {
        return sendJson(
          res,
          200,
          agentTimeline(ctx.db, ctx.accounts, {
            limit: numOpt(url.searchParams.get("limit")),
            before: url.searchParams.get("before") ?? undefined,
          })
        );
      }
      if (req.method === "GET" && url.pathname === "/agent/judgments") {
        return sendJson(
          res,
          200,
          agentJudgments(ctx.agentDb, ctx.db, {
            limit: numOpt(url.searchParams.get("limit")),
            before: url.searchParams.get("before") ?? undefined,
          })
        );
      }
      if (req.method === "GET" && url.pathname === "/agent/reasoning") {
        const message = url.searchParams.get("message");
        if (!message) throw new AgentViewError("缺少 message 参数");
        return sendJson(res, 200, { items: agentReasoning(ctx.agentDb, message) });
      }
      const msgMatch = url.pathname.match(/^\/agent\/message\/([^/]+)(?:\/(eml|rfc822)(?:\/(\d+))?)?$/);
      if (req.method === "GET" && msgMatch) {
        const key = decodeURIComponent(msgMatch[1]);
        const sub = msgMatch[2];
        if (!sub) {
          return sendJson(res, 200, await agentMessage(ctx.db, ctx.agentDb, ctx.dataDir, ctx.accounts, key));
        }
        if (sub === "eml") {
          const { body, filename } = agentMessageEml(ctx.db, ctx.dataDir, ctx.accounts, key);
          res.writeHead(200, {
            "content-type": "message/rfc822",
            "content-disposition": `attachment; filename="${filename}"`,
          });
          return res.end(body);
        }
        const index = Number(msgMatch[3]);
        if (!Number.isInteger(index)) throw new AgentViewError("rfc822 需要附件下标");
        return sendJson(
          res,
          200,
          await agentMessageRfc822(ctx.db, ctx.dataDir, ctx.accounts, key, index)
        );
      }

      const pendingMatch = url.pathname.match(/^\/pending-sends\/(\d+)\/(confirm|discard)$/);
      if (req.method === "POST" && pendingMatch) {
        const id = Number(pendingMatch[1]);
        if (pendingMatch[2] === "confirm") {
          const r = await confirmPendingSend({
            agentDb: ctx.agentDb,
            accounts: ctx.accounts,
            creds: ctx.creds,
            id,
          });
          return sendJson(res, 200, r);
        }
        await discardPendingSend({ agentDb: ctx.agentDb, id });
        return sendJson(res, 200, { discarded: true });
      }

      sendJson(res, 404, { error: `未知端点：${req.method} ${url.pathname}` });
    } catch (err) {
      const status = err instanceof AgentViewError ? err.status : 500;
      sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

function numOpt(v: string | null): number | undefined {
  return v ? Number(v) : undefined;
}

export const TOOLS_PORT = Number(process.env.MAILD_TOOLS_PORT ?? 9711);
