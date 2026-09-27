import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { confirmPendingSend, discardPendingSend, sendAsAgent } from "../src/send.js";
import { listPendingSends, openAgentDb, type AgentDb, type LedgerRow } from "../src/ledger.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import { startSmtpSink, type SmtpSink } from "../../webmail/test/smtp-sink.js";
import { startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";
import { ImapFlow } from "imapflow";

/**
 * send_as_agent 的发信闸门（3.7）：
 * - 白名单内直发：SMTP 发出 + APPEND 到 agent@ 自己的「已发送」，同一份字节（红线 6）
 * - 白名单外进待确认队列；确认（人操作）后原样发出；丢弃则永不发出
 * - 找不到「已发送」文件夹时拒发（红线 5）
 */

const ME = "me@mail.shaoyuanyu.cn";
const AGENT = "agent@mail.shaoyuanyu.cn";

let dovecot: DovecotHandle;
let sink: SmtpSink;
let agentDb: AgentDb;
let accounts: AccountConfig[];
let creds: Record<string, AccountCredential>;

function makeAccounts(smtpPort: number): AccountConfig[] {
  return [
    {
      id: "me",
      displayName: "Me",
      email: ME,
      provider: "aliyun",
      color: "#000000",
      imapHost: "127.0.0.1",
      imapPort: 1, // 不使用
      imapSecure: false,
      folders: ["INBOX"],
      enabled: true,
    },
    {
      id: "agent",
      displayName: "Agent",
      email: AGENT,
      provider: "aliyun",
      color: "#111111",
      imapHost: "127.0.0.1",
      imapPort: dovecot.port,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort,
      smtpSecure: false,
      isAgent: true,
      folders: ["INBOX"],
      enabled: true,
    },
  ];
}

/** 从 Dovecot 的 Sent 读回全部留底原文 */
async function readSentSources(): Promise<Buffer[]> {
  const client = new ImapFlow({
    host: dovecot.host,
    port: dovecot.port,
    secure: false,
    auth: { user: "test", pass: "test" },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen("Sent", { readOnly: true });
    const out: Buffer[] = [];
    for await (const m of client.fetch("1:*", { uid: true, source: true }, { uid: true })) {
      if (m.source) out.push(m.source as Buffer);
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
}

function ledger(tool: string): LedgerRow[] {
  return agentDb
    .prepare("SELECT * FROM tool_ledger WHERE tool = ? ORDER BY id")
    .all(tool) as LedgerRow[];
}

beforeAll(async () => {
  dovecot = startDovecot("send", { specialUse: true });
  await waitReady(dovecot);
  sink = await startSmtpSink();
  agentDb = openAgentDb(":memory:");
  accounts = makeAccounts(sink.port);
  creds = { agent: { username: "test", password: "test" } };
}, 180_000);

afterAll(async () => {
  agentDb.close();
  await sink.close();
  dovecot.cleanup();
});

describe("send_as_agent 发信闸门（3.7）", () => {
  it("白名单内直发：SMTP 与 Sent 留底是同一份字节（红线 6）", async () => {
    const r = await sendAsAgent({
      agentDb,
      accounts,
      creds,
      req: { to: [ME], subject: "闸门测试-直发", text: "白名单内，直接发出。" },
    });
    expect(r.status).toBe("sent");
    if (r.status !== "sent") return;

    expect(sink.received.length).toBe(1);
    const parsed = await simpleParser(sink.received[0]);
    expect(parsed.messageId).toBe(r.messageId);
    expect(parsed.subject).toBe("闸门测试-直发");
    // From 必须是 agent@（3.4：发信身份只有它）
    expect(parsed.from?.value[0]?.address).toBe(AGENT);

    const sent = await readSentSources();
    expect(sent.length).toBe(1);
    expect(sent[0].equals(sink.received[0])).toBe(true);

    const rows = ledger("send_as_agent");
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].detail_json)).toMatchObject({ decision: "direct" });
  });

  it("白名单外进待确认队列：不发出，MIME 已就绪，台账记 pending", async () => {
    const r = await sendAsAgent({
      agentDb,
      accounts,
      creds,
      req: { to: ["someone@example.org"], subject: "闸门测试-待确认", text: "等站主确认。" },
    });
    expect(r.status).toBe("pending");
    expect(sink.received.length).toBe(1); // 没有新发出

    const items = listPendingSends(agentDb);
    expect(items.length).toBe(1);
    expect(items[0].subject).toBe("闸门测试-待确认");
    expect(JSON.parse(items[0].to_json)).toEqual(["someone@example.org"]);
    expect(items[0]).not.toHaveProperty("mime"); // 列表不带 MIME 字节

    const rows = ledger("send_as_agent");
    expect(JSON.parse(rows[1].detail_json)).toMatchObject({ decision: "pending", pendingId: items[0].id });
  });

  it("确认后原样发出（队列里存的那份字节），重复确认拒绝", async () => {
    const id = listPendingSends(agentDb)[0].id;
    const r = await confirmPendingSend({ agentDb, accounts, creds, id });
    expect(r.messageId).toMatch(/^<.+@mail\.shaoyuanyu\.cn>$/);

    expect(sink.received.length).toBe(2);
    const parsed = await simpleParser(sink.received[1]);
    expect(parsed.subject).toBe("闸门测试-待确认");
    expect(parsed.messageId).toBe(r.messageId);

    const sent = await readSentSources();
    expect(sent.length).toBe(2);
    expect(sent[1].equals(sink.received[1])).toBe(true);

    expect(listPendingSends(agentDb).length).toBe(0);
    await expect(confirmPendingSend({ agentDb, accounts, creds, id })).rejects.toThrow("已处理");
    expect(ledger("confirm_send").length).toBe(1);
  });

  it("丢弃后永不发出，重复丢弃/丢弃后确认都拒绝", async () => {
    const r = await sendAsAgent({
      agentDb,
      accounts,
      creds,
      req: { to: ["other@example.net"], cc: [ME], subject: "闸门测试-丢弃", text: "cc 含白名单也算外发。" },
    });
    expect(r.status).toBe("pending");
    if (r.status !== "pending") return;

    await discardPendingSend({ agentDb, id: r.id });
    expect(listPendingSends(agentDb).length).toBe(0);
    expect(sink.received.length).toBe(2); // 没有新发出
    await expect(discardPendingSend({ agentDb, id: r.id })).rejects.toThrow("已处理");
    await expect(confirmPendingSend({ agentDb, accounts, creds, id: r.id })).rejects.toThrow("已处理");
    expect(ledger("discard_send").length).toBe(1);
  });

  it("cc 里的白名单外地址同样触发闸门", async () => {
    const r = await sendAsAgent({
      agentDb,
      accounts,
      creds,
      req: { to: [ME], cc: ["external@example.com"], subject: "闸门测试-cc", text: "x" },
    });
    expect(r.status).toBe("pending");
    await discardPendingSend({ agentDb, id: (r as { id: number }).id });
  });

  it("非法地址与空收件人直接拒绝", async () => {
    await expect(
      sendAsAgent({ agentDb, accounts, creds, req: { to: [], subject: "x", text: "x" } })
    ).rejects.toThrow("收件人为空");
    await expect(
      sendAsAgent({ agentDb, accounts, creds, req: { to: ["not-an-address"], subject: "x", text: "x" } })
    ).rejects.toThrow("非法地址");
  });
});

describe("发信闸门：找不到「已发送」时拒发（红线 5）", () => {
  it("无 \\Sent 且无常见名 → 报错，SMTP 不发出", async () => {
    // 第二个 Dovecot：不带 special_use 块，也没有任何叫 Sent 的文件夹
    const plain = startDovecot("send-plain");
    await waitReady(plain);
    try {
      const noSentAccounts = makeAccounts(sink.port).map((a) =>
        a.id === "agent" ? { ...a, imapPort: plain.port } : a
      );
      const before = sink.received.length;
      await expect(
        sendAsAgent({
          agentDb,
          accounts: noSentAccounts,
          creds,
          req: { to: [ME], subject: "不该发出", text: "x" },
        })
      ).rejects.toThrow("已发送");
      expect(sink.received.length).toBe(before);
    } finally {
      plain.cleanup();
    }
  });
});
