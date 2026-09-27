import { randomBytes } from "node:crypto";
import type { AgentDb } from "./ledger.js";
import { appendLedger } from "./ledger.js";

/**
 * create_event：把提取出的日程写入主站 CalDAV（Radicale）的 agent-schedule 集合（5.3）。
 * 复用 /calendar 展示，邮件系统里不造第二套日历。
 * v1 只支持定时日程（DTSTART/DTEND），不支持全天事件。
 * 注意：这是站主自己的 Radicale 账号下的集合，与会议 deadline 的 conference-ddl 互不干扰。
 */

export interface CaldavTarget {
  url: string;
  collection: string;
  username: string;
  password: string;
}

export interface EventInput {
  title: string;
  /** ISO 8601 时间（带时区偏移；UTC 化后写入） */
  start: string;
  end?: string;
  location?: string;
  description?: string;
}

export interface EventResult {
  uid: string;
  path: string;
}

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`非法时间：${iso}`);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function fold(line: string): string[] {
  // RFC 5545：行超 75 字节要折行；中文按 UTF-8 字节算，保守折在 60 字符内
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest, "utf8") > 73) {
    let cut = 73;
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), "utf8") > 73) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out;
}

export function buildEventIcs(uid: string, ev: EventInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//maild//agent-schedule//CN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${toIcsUtc(new Date().toISOString())}`,
    `DTSTART:${toIcsUtc(ev.start)}`,
    `DTEND:${toIcsUtc(ev.end ?? new Date(new Date(ev.start).getTime() + 3600_000).toISOString())}`,
    `SUMMARY:${esc(ev.title)}`,
  ];
  if (ev.location) lines.push(`LOCATION:${esc(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${esc(ev.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return lines.flatMap(fold).join("\r\n") + "\r\n";
}

export async function createEvent(opts: {
  agentDb: AgentDb;
  caldav: CaldavTarget;
  event: EventInput;
}): Promise<EventResult> {
  const { agentDb, caldav, event } = opts;
  if (!event.title?.trim()) throw new Error("日程标题为空");
  const uid = `agent-${Date.now()}.${randomBytes(8).toString("hex")}@shaoyuanyu.cn`;
  const ics = buildEventIcs(uid, event);
  const auth = "Basic " + Buffer.from(`${caldav.username}:${caldav.password}`).toString("base64");
  const base = `${caldav.url}/${encodeURIComponent(caldav.username)}/${encodeURIComponent(caldav.collection)}`;

  // 集合不存在则先建（MKCOL 需标准 CalDAV XML，空 body 会 400）
  const probe = await fetch(`${base}/`, {
    method: "PROPFIND",
    headers: { Authorization: auth, Depth: "0" },
  });
  if (probe.status === 404) {
    const mkcol = await fetch(`${base}/`, {
      method: "MKCOL",
      headers: { Authorization: auth, "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:mkcol xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:set><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
  <D:displayname>${caldav.collection}</D:displayname></D:prop></D:set>
</C:mkcol>`,
    });
    if (!mkcol.ok && mkcol.status !== 405) {
      throw new Error(`MKCOL 建集合失败：${mkcol.status} ${await mkcol.text()}`);
    }
  } else if (probe.status === 401 || probe.status === 403) {
    throw new Error(`CalDAV 认证失败：${probe.status}`);
  }

  const path = `${base}/${uid}.ics`;
  const put = await fetch(path, {
    method: "PUT",
    headers: { Authorization: auth, "Content-Type": "text/calendar; charset=utf-8" },
    body: ics,
  });
  if (!put.ok && put.status !== 204 && put.status !== 201) {
    const err = `CalDAV PUT 失败：${put.status} ${await put.text()}`;
    appendLedger(agentDb, {
      tool: "create_event",
      ok: false,
      detail: { title: event.title, start: event.start, collection: caldav.collection },
      error: err,
    });
    throw new Error(err);
  }

  appendLedger(agentDb, {
    tool: "create_event",
    ok: true,
    detail: { title: event.title, start: event.start, end: event.end ?? null, uid, path, collection: caldav.collection },
  });
  return { uid, path };
}
