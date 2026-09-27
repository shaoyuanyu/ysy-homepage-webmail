import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildEventIcs, createEvent } from "../src/events.js";
import { openAgentDb, type AgentDb } from "../src/ledger.js";

/**
 * create_event 的 CalDAV 写入（5.3）。
 * 用 node:http 微型桩模拟 Radicale：记录请求方法与 body，按场景回状态码。
 * 与真实 Radicale 的联调在部署验收做（本地 .cache venv，CI 另有 kozea/radicale）。
 */

interface CaldavRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: string;
}

let server: Server;
let port: number;
let requests: CaldavRequest[] = [];
/** PROPFIND 返回码：207 = 集合存在；404 = 触发 MKCOL 路径 */
let propfindStatus = 207;
/** PUT 返回码 */
let putStatus = 201;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.method === "PROPFIND") {
        res.writeHead(propfindStatus, { "content-type": "application/xml" });
        res.end("<multistatus/>");
        return;
      }
      if (req.method === "MKCOL") {
        res.writeHead(201);
        res.end();
        return;
      }
      if (req.method === "PUT") {
        res.writeHead(putStatus);
        res.end();
        return;
      }
      res.writeHead(405);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(undefined)));
});

function freshCtx(agentDb: AgentDb) {
  requests = [];
  propfindStatus = 207;
  putStatus = 201;
  return {
    agentDb,
    caldav: {
      url: `http://127.0.0.1:${port}`,
      collection: "agent-schedule",
      username: "caladmin",
      password: "secret",
    },
  };
}

function ledgerRows(agentDb: AgentDb, tool: string) {
  return agentDb
    .prepare("SELECT * FROM tool_ledger WHERE tool = ? ORDER BY id")
    .all(tool) as { ok: number; detail_json: string; error: string | null }[];
}

describe("create_event 写 CalDAV", () => {
  it("ICS 构造：UTC 化时间、SUMMARY 转义、缺省 end = start + 1 小时", () => {
    const ics = buildEventIcs("uid-1", {
      title: "组会, 讨论; 进展",
      start: "2026-09-28T14:00:00+08:00",
      location: "线上",
    });
    expect(ics).toContain("UID:uid-1");
    expect(ics).toContain("DTSTART:20260928T060000Z");
    expect(ics).toContain("DTEND:20260928T070000Z");
    // RFC 5545：逗号分号必须转义（否则 Radicale/vobject 会截断）
    expect(ics).toContain("SUMMARY:组会\\, 讨论\\; 进展");
    expect(ics).toContain("LOCATION:线上");
  });

  it("非法时间直接抛错", () => {
    expect(() => buildEventIcs("uid-2", { title: "x", start: "not-a-date" })).toThrow("非法时间");
  });

  it("集合存在时直接 PUT，路径含用户名与集合名，台账落 create_event", async () => {
    const agentDb = openAgentDb(":memory:");
    const ctx = freshCtx(agentDb);
    const r = await createEvent({
      ...ctx,
      event: { title: "论文截稿", start: "2026-10-01T23:59:00+08:00" },
    });
    expect(r.path).toContain("/caladmin/agent-schedule/");
    expect(r.path.endsWith(`${r.uid}.ics`)).toBe(true);

    const methods = requests.map((x) => x.method);
    expect(methods).toEqual(["PROPFIND", "PUT"]);
    const put = requests[1];
    expect(put.auth).toBe("Basic " + Buffer.from("caladmin:secret").toString("base64"));
    expect(put.body).toContain("SUMMARY:论文截稿");
    expect(put.body).toContain(`UID:${r.uid}`);

    const rows = ledgerRows(agentDb, "create_event");
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(1);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({ title: "论文截稿", uid: r.uid });
  });

  it("集合不存在（404）时先 MKCOL（标准 CalDAV XML）再 PUT", async () => {
    const agentDb = openAgentDb(":memory:");
    const ctx = freshCtx(agentDb);
    propfindStatus = 404;
    await createEvent({
      ...ctx,
      event: { title: "组会", start: "2026-09-28T14:00:00+08:00", end: "2026-09-28T15:00:00+08:00" },
    });
    const methods = requests.map((x) => x.method);
    expect(methods).toEqual(["PROPFIND", "MKCOL", "PUT"]);
    // MKCOL 空 body 会 400：必须带 resourcetype 含 calendar 的 XML
    expect(requests[1].body).toContain("C:calendar");
    expect(requests[1].body).toContain("resourcetype");
  });

  it("PUT 失败抛错且台账记 ok:0", async () => {
    const agentDb = openAgentDb(":memory:");
    const ctx = freshCtx(agentDb);
    putStatus = 500;
    await expect(
      createEvent({ ...ctx, event: { title: "x", start: "2026-09-28T14:00:00+08:00" } })
    ).rejects.toThrow("CalDAV PUT 失败");
    const rows = ledgerRows(agentDb, "create_event");
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(0);
    expect(rows[0].error).toContain("500");
  });

  it("认证失败（401）抛错", async () => {
    const agentDb = openAgentDb(":memory:");
    const ctx = freshCtx(agentDb);
    propfindStatus = 401;
    await expect(
      createEvent({ ...ctx, event: { title: "x", start: "2026-09-28T14:00:00+08:00" } })
    ).rejects.toThrow("CalDAV 认证失败");
  });
});
