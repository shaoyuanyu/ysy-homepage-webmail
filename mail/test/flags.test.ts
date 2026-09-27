import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { syncAccount } from "../src/fetcher.js";
import { connectAccount } from "../src/imap.js";
import { setMessageFlags } from "../src/flags.js";
import { openAgentDb, type AgentDb, type LedgerRow } from "../src/ledger.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import {
  deliverFixtures,
  startDovecot,
  waitReady,
  workRoot,
  type DovecotHandle,
} from "./dovecot.js";
import { ImapFlow } from "imapflow";
import { readFileSync } from "node:fs";
import { fixturesDir } from "./dovecot.js";

/**
 * set_flags：全包唯一 STORE（3.5）。对真实 Dovecot 断言：
 * - 对该 Message-ID 的所有副本一起写（红线 8）：同一封信放 INBOX + Archive 两个文件夹
 * - 前值/后值从服务端现取并落台账；本地 copies 同步更新
 * - 只碰 \Seen / \Flagged：预先打上的 \Answered 不受影响
 * - 只接受本地索引已存在的消息；空 change 拒绝
 */

let handle: DovecotHandle;
let db: Db;
let agentDb: AgentDb;
let account: AccountConfig;
let cred: AccountCredential;
let accounts: AccountConfig[];
let creds: Record<string, AccountCredential>;

/** 裸 Message-ID（envelope 形态）：setMessageFlags 入参用它，验证工具的宽容归一 */
const RAW_MID = "<m1@test.local>";
/** 库键（mid: 前缀，message.ts 的 messageKey）：直接 SQL 查询用它 */
const KEY_MID = "mid:m1@test.local";

/** 用独立连接读某文件夹全部 flags（EXAMINE，不影响服务端状态） */
async function readFlags(folder: string): Promise<Map<number, string[]>> {
  const client = await connectAccount(account, cred);
  try {
    await client.mailboxOpen(folder, { readOnly: true });
    const map = new Map<number, string[]>();
    for await (const m of client.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
      map.set(m.uid, m.flags ? [...m.flags].sort() : []);
    }
    return map;
  } finally {
    await client.logout().catch(() => {});
  }
}

/** 手工对 INBOX 里 m1 那封打一个标记（制造「别的标记不受影响」的前置） */
async function manualFlag(folder: string, mid: string, flag: string): Promise<void> {
  const client = await connectAccount(account, cred);
  try {
    await client.mailboxOpen(folder);
    // 按 Message-ID 找到 UID
    let uid = 0;
    for await (const m of client.fetch("1:*", { uid: true, envelope: true }, { uid: true })) {
      if ((m.envelope as { messageId?: string } | undefined)?.messageId === mid) uid = m.uid;
    }
    if (!uid) throw new Error(`${folder} 里找不到 ${mid}`);
    await client.messageFlagsAdd(String(uid), [flag], { uid: true });
  } finally {
    await client.logout().catch(() => {});
  }
}

async function sync(): Promise<void> {
  await syncAccount(db, join(workRoot, "db-flags"), account, cred);
}

beforeAll(async () => {
  handle = startDovecot("flags");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml", "02.eml"]);

  // 第二份副本：Archive 文件夹放同一封 01.eml（同一 Message-ID）
  {
    const client = new ImapFlow({
      host: handle.host,
      port: handle.port,
      secure: false,
      auth: { user: "test", pass: "test" },
      logger: false,
    });
    await client.connect();
    await client.mailboxCreate("Archive");
    const ok = await client.append("Archive", readFileSync(join(fixturesDir, "01.eml")));
    if (!ok) throw new Error("Archive APPEND 失败");
    await client.logout().catch(() => {});
  }

  const dataDir = join(workRoot, "db-flags");
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
          folders: ["INBOX", "Archive"],
          enabled: true,
        },
      ],
    })
  );
  writeFileSync(
    join(dataDir, "credentials.json"),
    JSON.stringify({ test: { username: "test", password: "test" } })
  );

  accounts = loadAccounts(dataDir);
  creds = loadCredentials(dataDir);
  account = accounts[0];
  cred = creds[account.id];
  db = openDb(join(dataDir, "mail.db"));
  agentDb = openAgentDb(join(dataDir, "agent.db"));
  await sync();

  // 前置确认：m1 在本地索引恰有两份副本
  const copies = db.prepare("SELECT folder FROM copies WHERE message_id = ?").all(KEY_MID) as {
    folder: string;
  }[];
  expect(copies.map((c) => c.folder).sort()).toEqual(["Archive", "INBOX"]);

  // 预先给 INBOX 的 m1 打 \Answered——验证 set_flags 不动它
  await manualFlag("INBOX", RAW_MID, "\\Answered");
  await sync(); // 回读进本地索引
});

afterAll(() => {
  db.close();
  agentDb.close();
  handle.cleanup();
});

function ledger(tool?: string): LedgerRow[] {
  const rows = agentDb.prepare("SELECT * FROM tool_ledger ORDER BY id").all() as LedgerRow[];
  return tool ? rows.filter((r) => r.tool === tool) : rows;
}

describe("set_flags（唯一 STORE，3.5）", () => {
  it("对所有副本一起写 \\Seen，前后值落台账，本地索引同步", async () => {
    const r = await setMessageFlags({
      db,
      agentDb,
      accounts,
      creds,
      messageId: RAW_MID,
      change: { seen: true },
      source: "agent",
    });
    expect(r.updated).toBe(2);
    expect(r.skipped).toEqual([]);

    for (const folder of ["INBOX", "Archive"]) {
      const flags = await readFlags(folder);
      const hit = [...flags.values()].find(
        (f) => f.includes("\\Seen") || f.includes("\\Answered")
      );
      expect(hit).toContain("\\Seen");
    }
    // \Answered 还在（只增删两个允许的标记，不整体替换）
    const inbox = await readFlags("INBOX");
    expect([...inbox.values()].some((f) => f.includes("\\Answered"))).toBe(true);

    // 本地 copies 更新
    const rows = db
      .prepare("SELECT flags FROM copies WHERE message_id = ? ORDER BY folder")
      .all(KEY_MID) as { flags: string }[];
    for (const row of rows) expect(row.flags).toContain("\\Seen");

    // 台账：每个副本一条明细，含前值/后值/来源
    const detail = ledger("set_flags.copy");
    expect(detail.length).toBe(2);
    for (const row of detail) {
      const d = JSON.parse(row.detail_json);
      expect(d.change).toEqual({ seen: true });
      expect(d.source).toBe("agent");
      expect(d.after).toContain("\\Seen");
      expect(d.before).not.toContain("\\Seen");
    }
  });

  it("再写 \\Flagged 与取消 \\Seen：增删语义互不干扰", async () => {
    await setMessageFlags({
      db,
      agentDb,
      accounts,
      creds,
      messageId: RAW_MID,
      change: { flagged: true },
      source: "agent",
    });
    let inbox = await readFlags("INBOX");
    let hit = [...inbox.values()].find((f) => f.includes("\\Answered"))!;
    expect(hit).toContain("\\Flagged");
    expect(hit).toContain("\\Seen");

    await setMessageFlags({
      db,
      agentDb,
      accounts,
      creds,
      messageId: RAW_MID,
      change: { seen: false },
      source: "agent",
    });
    inbox = await readFlags("INBOX");
    hit = [...inbox.values()].find((f) => f.includes("\\Answered"))!;
    expect(hit).not.toContain("\\Seen");
    expect(hit).toContain("\\Flagged");
    expect(hit).toContain("\\Answered");
  });

  it("拒绝本地索引不存在的消息，且不落任何服务端写入", async () => {
    const before = ledger().length;
    await expect(
      setMessageFlags({
        db,
        agentDb,
        accounts,
        creds,
        messageId: "<ghost@test.local>",
        change: { seen: true },
        source: "agent",
      })
    ).rejects.toThrow("本地索引不存在");
    // 抛错发生在分发层之前（无台账行——callTool 才会记失败调用行）
    expect(ledger().length).toBe(before);
  });

  it("空 change（seen/flagged 都不给）直接拒绝", async () => {
    await expect(
      setMessageFlags({
        db,
        agentDb,
        accounts,
        creds,
        messageId: RAW_MID,
        change: {},
        source: "agent",
      })
    ).rejects.toThrow("至少要给");
  });
});
