import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { syncAccount } from "../src/fetcher.js";
import { connectAccount } from "../src/imap.js";
import { searchMessages } from "../src/search.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import {
  deliverFixtures,
  resetMaildir,
  startDovecot,
  waitReady,
  workRoot,
  type DovecotHandle,
} from "./dovecot.js";

let handle: DovecotHandle;
let db: Db;
let dataDir: string;
let account: AccountConfig;
let cred: AccountCredential;

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** 用独立连接读取 INBOX 全部 flags（EXAMINE，不影响服务端状态） */
async function readAllFlags(): Promise<Map<number, string[]>> {
  const client = await connectAccount(account, cred);
  try {
    await client.mailboxOpen("INBOX", { readOnly: true });
    const map = new Map<number, string[]>();
    for await (const m of client.fetch("1:*", { uid: true, flags: true }, { uid: true })) {
      map.set(m.uid, m.flags ? [...m.flags].sort() : []);
    }
    return map;
  } finally {
    await client.logout().catch(() => {});
  }
}

beforeAll(async () => {
  handle = startDovecot("main");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml", "02.eml", "03.eml"]);

  dataDir = join(workRoot, "db-main");
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

  account = loadAccounts(dataDir)[0];
  const creds = loadCredentials(dataDir);
  const c = creds[account.id];
  if (!c) throw new Error("凭据缺失");
  cred = c;
  db = openDb(join(dataDir, "mail.db"));
}, 180_000);

afterAll(() => {
  db?.close();
  handle?.cleanup();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("mailagentd 抓取与索引", () => {
  it("首轮同步入库，且全程不改动 \\Seen（PEEK 常驻断言）", async () => {
    const before = await readAllFlags();
    expect(before.size).toBe(3);

    const results = await syncAccount(db, dataDir, account, cred);
    expect(results).toHaveLength(1);
    expect(results[0].fetched).toBe(3);
    expect(results[0].rebuilt).toBe(false);

    // 7.1：抓取前后 \\Seen 集合必须完全一致
    const after = await readAllFlags();
    expect(after.size).toBe(before.size);
    for (const [uid, flags] of before) {
      expect(after.get(uid)).toEqual(flags);
    }
    for (const flags of after.values()) {
      expect(flags).not.toContain("\\Seen");
    }

    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM copies")).toBe(3);
    const emlCount = readdirSync(join(dataDir, "eml")).filter((f) => f.endsWith(".eml")).length;
    expect(emlCount).toBe(3);

    const hits = searchMessages(db, "试的通知");
    expect(hits).toHaveLength(1);
    expect(hits[0].subject).toContain("面试通知");
  });

  it("重复同步幂等", async () => {
    const results = await syncAccount(db, dataDir, account, cred);
    expect(results[0].fetched).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(3);
  });

  it("新邮件到达后增量入库", async () => {
    await deliverFixtures(handle, ["04.eml"]);
    const results = await syncAccount(db, dataDir, account, cred);
    expect(results[0].fetched).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(4);
  });

  it("标记回读：服务端置 \\Seen 后同步回本地索引", async () => {
    const row = db
      .prepare(
        `SELECT c.uid AS uid FROM copies c JOIN messages m ON m.message_id = c.message_id
         WHERE m.subject LIKE '%面试%'`
      )
      .get() as { uid: number };

    // 用独立连接把该邮件标成已读（模拟手机端读信）
    const client = await connectAccount(account, cred);
    try {
      await client.mailboxOpen("INBOX");
      await client.messageFlagsAdd(String(row.uid), ["\\Seen"], { uid: true });
    } finally {
      await client.logout().catch(() => {});
    }

    const results = await syncAccount(db, dataDir, account, cred);
    expect(results[0].flagsUpdated).toBeGreaterThan(0);
    const flags = (
      db.prepare("SELECT flags FROM copies WHERE uid = ?").get(row.uid) as { flags: string }
    ).flags;
    expect(flags).toContain("\\Seen");
  });

  it("UIDVALIDITY 变化后重建该文件夹索引", async () => {
    resetMaildir(handle);
    // dovecot 的 UIDVALIDITY 是秒级时间戳，跨秒再投放以确保新旧值不同
    await new Promise((r) => setTimeout(r, 1100));
    await deliverFixtures(handle, ["01.eml", "04.eml"]);
    handle.restart();
    await waitReady(handle);

    const results = await syncAccount(db, dataDir, account, cred);
    expect(results[0].rebuilt).toBe(true);
    expect(results[0].fetched).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM copies")).toBe(2);
    expect(searchMessages(db, "面试")).toHaveLength(1);
    expect(searchMessages(db, "学术动态")).toHaveLength(0);
  });
});
