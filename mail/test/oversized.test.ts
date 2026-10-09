import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * 「只存元数据」路径（红线 12：超大邮件不下载原文）在**去掉 ENVELOPE** 之后必须还拿得到头部。
 *
 * 背景（2026-10-08 性能改动）：元数据那一遍 FETCH 不再带 `envelope`（真机 QQ 实测：单独
 * 取 ENVELOPE 每封 ~15ms，而 flags/size/date 合计只要 0.7ms，元数据遍 95% 的时间花在它上面）。
 * 有原文的邮件改成从原文解析头部（`simpleParser`，原文反正要下载）；**没有原文的邮件**
 * （超过 `MAIL_AGENT_MAX_SOURCE_BYTES`，只存元数据）则由 `fetchEnvelopes()` 单独补一次信封。
 *
 * 这条用例把阈值压到 1 字节，于是**所有**邮件都走「没有原文」那条路——如果补信封那一步
 * 断了、或者 ingest 忘了用信封兜底，列表里就会出现「发件人 / 主题全空」的邮件
 * （不报错，只是索引是坏的）。⚠ 环境变量必须在 import fetcher 之前设置。
 */
process.env.MAIL_AGENT_MAX_SOURCE_BYTES = "1";
// 连「只取正文」也关掉（硬上限 1 字节）→ 全部走「只存索引」，专门锁这条兜底路径
// （门控之上的「只取正文 + 内嵌图」由 test/partial-fetch.test.ts 覆盖）
process.env.MAIL_AGENT_MAX_PARTIAL_BYTES = "1";
process.env.MAIL_AGENT_BACKFILL_CHUNK = "50";
const { syncAccount } = await import("../src/fetcher.js");

let handle: DovecotHandle;
let db: Db;
let dataDir: string;
let account: AccountConfig;
let cred: AccountCredential;

beforeAll(async () => {
  handle = startDovecot("oversized");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml", "02.eml", "03.eml"]);

  dataDir = join(workRoot, "db-oversized");
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
}, 180_000);

afterAll(() => {
  db?.close();
  handle?.cleanup();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

describe("超大邮件（只存元数据）：头部信息由 fetchEnvelopes 补齐", () => {
  it("库里没有原文，但发件人 / 主题 / 日期都完整", async () => {
    await syncAccount(db, dataDir, account, cred);

    const rows = db
      .prepare(
        `SELECT m.subject, m.from_addr, m.date, m.truncated, m.eml_path, c.uid
         FROM messages m JOIN copies c ON c.message_id = m.message_id
         WHERE c.account_id = 'test' ORDER BY c.uid`
      )
      .all() as {
      subject: string;
      from_addr: string;
      date: string;
      truncated: number;
      eml_path: string;
      uid: number;
    }[];

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      // 只存元数据：没有原文文件、truncated=1（红线 12）
      expect(r.truncated, `uid ${r.uid} 应当是 truncated`).toBe(1);
      expect(r.eml_path).toBe("");
      // ⚠ 关键：头部不是空的——它只能来自单独补的那次信封 FETCH
      expect(r.subject, `uid ${r.uid} 的主题`).not.toBe("");
      expect(r.from_addr, `uid ${r.uid} 的发件人`).toContain("@");
      expect(r.date, `uid ${r.uid} 的日期`).not.toBe("");
    }
  });
});
