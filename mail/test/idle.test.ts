import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { watchAccount } from "../src/idle.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

let handle: DovecotHandle;
let db: Db;
let dataDir: string;
let account: AccountConfig;
let cred: AccountCredential;
let watcher: Promise<void> | undefined;
const controller = new AbortController();

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** 轮询直到行数达标（事件驱动是异步的，不能直接断言时序） */
async function waitFor(sql: string, expected: number, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (count(sql) === expected) return;
    if (Date.now() > deadline) {
      throw new Error(`等待超时：「${sql}」应为 ${expected}，实际 ${count(sql)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  handle = startDovecot("idle");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml"]);

  dataDir = join(workRoot, "db-idle");
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
  const c = loadCredentials(dataDir)[account.id];
  if (!c) throw new Error("凭据缺失");
  cred = c;
  db = openDb(join(dataDir, "mail.db"));

  watcher = watchAccount(db, dataDir, account, cred, controller.signal);
}, 180_000);

afterAll(async () => {
  controller.abort();
  await watcher;
  db?.close();
  handle?.cleanup();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("maild IDLE 监听", () => {
  it("启动后先补抓存量邮件", async () => {
    await waitFor("SELECT COUNT(*) AS n FROM messages", 1);
  });

  it("IDLE 唤醒：新邮件到达后数秒内自动入库", async () => {
    const t0 = Date.now();
    await deliverFixtures(handle, ["02.eml"]);
    await waitFor("SELECT COUNT(*) AS n FROM messages", 2);
    // 事件驱动应在数秒内完成，而非等到 3 分钟兜底轮询
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("优雅停机：abort 后 watcher 干净退出", async () => {
    controller.abort();
    await watcher;
    watcher = undefined;
  });
});
