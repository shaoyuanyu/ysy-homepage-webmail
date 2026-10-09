import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import { deliverFixtures, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * 首轮历史回填的专用用例（2026-10-08）。
 *
 * 这段逻辑的来历见 fetcher.ts 文件头：新加一个邮箱时，旧实现是「从小到大逐封抓、
 * 整个文件夹抓完才落游标」——6500 封要十几分钟到几十分钟，期间最新的邮件根本看不到，
 * 一次重启/部署还会把进度全部作废。现在改成「最新优先、按块推进、逐块落游标」。
 *
 * 这里用 `MAIL_AGENT_BACKFILL_CHUNK=1` 把块压到最小，于是每一次 syncFolder 只吃一封，
 * 可以逐块断言「先来的是最新那封」「游标确实在往下走」「重启后不重头再来」。
 * ⚠ 必须在 import fetcher 之前设置环境变量（常量在模块加载时读取）。
 */
process.env.MAIL_AGENT_BACKFILL_CHUNK = "1";
process.env.MAIL_AGENT_BACKFILL_BUDGET_MS = "60000";
const { syncAccount, hasPendingBackfill, backfillProgress } = await import("../src/fetcher.js");

let handle: DovecotHandle;
let db: Db;
let dataDir: string;
let account: AccountConfig;
let cred: AccountCredential;

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** 库里已入库的 UID（升序） */
function uids(): number[] {
  return (db.prepare("SELECT uid FROM copies ORDER BY uid").all() as { uid: number }[]).map(
    (r) => r.uid
  );
}

beforeAll(async () => {
  handle = startDovecot("backfill");
  await waitReady(handle);
  await deliverFixtures(handle, ["01.eml", "02.eml", "03.eml", "04.eml"]);

  dataDir = join(workRoot, "db-backfill");
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

describe("首轮历史回填：最新优先、按块推进、逐块可续", () => {
  it("第一块吃的就是最新那封（不是 2014 年的第一封）", async () => {
    const results = await syncAccount(db, dataDir, account, cred);
    expect(results).toHaveLength(1);
    const r = results[0];
    // 投了 4 封，UID 1..4；最新 = UID 4
    expect(uids()).toEqual([4]);
    expect(r.backfilled).toBe(1);
    // 4 封里已抓 1 封 → 剩 3
    expect(r.backfillRemaining).toBe(3);
    // 回填的旧邮件不算「新邮件」：不喂触发接线（否则几千封历史邮件会被投成模型任务）
    expect(r.ingested).toEqual([]);
    expect(hasPendingBackfill(db, "test")).toBe(true);
    expect(backfillProgress(db, "test")).toEqual([{ path: "INBOX", remaining: 3, total: 4 }]);
  });

  it("下一块接着往下走（UID 递减），不重抓已入库的那封", async () => {
    const r = (await syncAccount(db, dataDir, account, cred))[0];
    expect(uids()).toEqual([3, 4]);
    expect(r.backfilled).toBe(1);
    expect(r.backfillRemaining).toBe(2);
  });

  it("进程重启后从游标续抓（重新开库 + 重新连接，不做任何内存态传递）", async () => {
    // 模拟重启：关掉库、重新打开（游标在 folders 表里），连接也是新的一条
    db.close();
    db = openDb(join(dataDir, "mail.db"));
    const r = (await syncAccount(db, dataDir, account, cred))[0];
    expect(uids()).toEqual([2, 3, 4]);
    expect(r.backfilled).toBe(1);
    expect(r.backfillRemaining).toBe(1);
  });

  it("铺满后回填收尾：游标清空、进度归零、再同步 0 封", async () => {
    const last = (await syncAccount(db, dataDir, account, cred))[0];
    expect(uids()).toEqual([1, 2, 3, 4]);
    expect(last.backfillRemaining).toBe(0);
    expect(hasPendingBackfill(db, "test")).toBe(false);
    expect(backfillProgress(db, "test")).toEqual([]);

    const idle = (await syncAccount(db, dataDir, account, cred))[0];
    expect(idle.fetched).toBe(0);
    expect(idle.backfilled).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(4);
  });

  it("回填完成后新到的邮件走增量：进 ingested、不算回填", async () => {
    await deliverFixtures(handle, ["05-rfc822.eml"]);
    const r = (await syncAccount(db, dataDir, account, cred))[0];
    expect(r.fetched).toBe(1);
    expect(r.backfilled).toBe(0);
    expect(r.ingested).toHaveLength(1);
    expect(r.ingested[0].created).toBe(true);
    expect(r.backfillRemaining).toBe(0);
  });

  it("回填途中新到的邮件立即走增量（不等历史抓完）", async () => {
    // 制造「历史回填重新开始」：删掉 folders 行 = 从未同步过的账号（这也正是从旧
    // schema 升级上来的样子——旧库的 last_seen_uid 停在 0、没有回填游标）。
    // copies 还在，所以重新回填是幂等的。
    db.prepare("DELETE FROM folders").run();
    const first = (await syncAccount(db, dataDir, account, cred))[0];
    expect(first.backfilled).toBe(1);
    expect(first.backfillRemaining).toBe(4);
    expect(uids()).toEqual([1, 2, 3, 4, 5]);

    // 历史还没抓完，来了一封新邮件
    await deliverFixtures(handle, ["06-thread-reply.eml"]);
    const r = (await syncAccount(db, dataDir, account, cred))[0];
    // 增量优先：新邮件（UID 6）当场入库
    expect(r.ingested).toHaveLength(1);
    const newUid = (
      db.prepare("SELECT uid FROM copies WHERE message_id = ?").get(r.ingested[0].messageId) as {
        uid: number;
      }
    ).uid;
    expect(newUid).toBe(6);
    // 同一轮里回填也往下走了一块（UID 4），两者互不阻塞
    expect(r.backfilled).toBe(1);
    expect(uids()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(backfillProgress(db, "test")[0].remaining).toBe(3);
  });
});

/**
 * 被删账号的残留同步状态（2026-10-08 事故回归）。
 *
 * 事故：删掉一个邮箱后再把**同一个**邮箱加回来，一封信都不下来、界面上也没有任何进度，
 * 而且不报错。链路是——账号 id 由邮箱地址推导（webmail 的 deriveId），所以「删掉再加」
 * 得到同一个 id；旧 deleteAccount 只清 copies/messages、**不清 folders 行**，于是新的
 * 账号继承了旧账号的水位线（`last_seen_uid = 6711`）：服务端那 6711 封全被当成
 * 「早就抓过了」，`backfill_uid` 又是 NULL（旧账号的回填已经跑完）→ 既不抓也不回填。
 *
 * 修了两处：deleteAccount 清 folders 行（根因）+ syncFolder 的自愈判据（已被污染的库
 * 兜底）。这里锁的是自愈这一半。
 */
describe("残留同步状态的自愈：水位线在、本地却一封副本都没有", () => {
  it("当作从未同步过重来——重新钉水位线 + 从头倒序回填", async () => {
    const copiesBefore = count("SELECT COUNT(*) AS n FROM copies");
    const messagesBefore = count("SELECT COUNT(*) AS n FROM messages");
    expect(copiesBefore).toBeGreaterThan(0);

    // 复刻旧 deleteAccount 留下的样子：copies / messages / FTS 清空，folders 行原样留着
    // （⚠ 先把回填游标清掉——那正是事故现场：旧账号的历史已经回填完，游标是 NULL，
    //   于是新账号连「有待回填」都不算，界面上连进度都没有）
    db.prepare("UPDATE folders SET backfill_uid = NULL, backfill_remaining = 0").run();
    db.prepare("DELETE FROM copies").run();
    db.prepare("DELETE FROM messages_fts").run();
    db.prepare("DELETE FROM messages").run();
    const stale = db
      .prepare("SELECT last_seen_uid, backfill_uid FROM folders")
      .get() as { last_seen_uid: number; backfill_uid: number | null };
    expect(stale.last_seen_uid).toBeGreaterThan(0);
    expect(stale.backfill_uid).toBeNull();
    // 没有这行 folders 残留时，下面的同步会一封都不抓（fetched / backfilled 全 0）——
    // 这正是用户报的「加了账号毫无动静」，也是这条用例存在的理由
    expect(hasPendingBackfill(db, "test")).toBe(false);

    const first = (await syncAccount(db, dataDir, account, cred))[0];
    expect(first.backfilled).toBe(1); // 自愈：重新从最新那封开始吃
    expect(first.backfillRemaining).toBe(copiesBefore - 1);
    expect(hasPendingBackfill(db, "test")).toBe(true);
    expect(backfillProgress(db, "test")).toEqual([
      { path: "INBOX", remaining: copiesBefore - 1, total: copiesBefore },
    ]);

    // 铺满：每一轮一块，直到没有待回填
    for (let i = 0; i < copiesBefore + 2 && hasPendingBackfill(db, "test"); i++) {
      await syncAccount(db, dataDir, account, cred);
    }
    expect(hasPendingBackfill(db, "test")).toBe(false);
    // 邮件全部回来了（幂等重抓，数量与清空之前一致）
    expect(count("SELECT COUNT(*) AS n FROM copies")).toBe(copiesBefore);
    expect(count("SELECT COUNT(*) AS n FROM messages")).toBe(messagesBefore);
    expect(count("SELECT COUNT(*) AS n FROM messages_fts")).toBe(messagesBefore);
  });
});

/**
 * 回填期间「标记回读」让路（2026-10-08 第二轮）。
 *
 * 起因是实测：QQ 上标记回读每个文件夹 ~2 秒（贵的是一条 `SEARCH SINCE`：只有 1 封邮件的
 * 「已发送」也要 1.9s），一个 6 文件夹的账号每轮 ~12 秒，而回填期间每 60 秒就有一轮全量。
 * 首轮回填时这些回读基本没有收益（回填入库每封时 flags 已经一起写进去了），却实打实和
 * 回填抢账号锁。现在退到 10 分钟一次，回填一结束立刻恢复每轮都读。
 *
 * 这里用 `folders.last_flags_sync` 是否推进来观察「这一轮有没有真的回读」。
 */
describe("回填期间标记回读让路", () => {
  const lastFlags = (): string | null =>
    (db.prepare("SELECT last_flags_sync AS t FROM folders WHERE path = 'INBOX'").get() as
      | { t: string | null }
      | undefined)?.t ?? null;

  it("回填待办时不再每轮刷新 last_flags_sync，回填完成后恢复", async () => {
    // 回到「从未同步过」：有待回填，且 last_flags_sync 为空 → 第一轮一定会读
    db.prepare("DELETE FROM folders").run();
    await syncAccount(db, dataDir, account, cred);
    const first = lastFlags();
    expect(first, "第一轮应当真的回读了标记").not.toBeNull();
    expect(hasPendingBackfill(db, "test"), "此时仍应有待回填").toBe(true);

    // 第二轮（仍待回填、距上次 <10 分钟）→ 跳过：时间戳不动
    await new Promise((r) => setTimeout(r, 10));
    await syncAccount(db, dataDir, account, cred);
    expect(lastFlags(), "回填期间应当跳过标记回读").toBe(first);

    // 铺满回填后 → 恢复每轮都读
    for (let i = 0; i < 12 && hasPendingBackfill(db, "test"); i++) {
      await syncAccount(db, dataDir, account, cred);
    }
    expect(hasPendingBackfill(db, "test")).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    await syncAccount(db, dataDir, account, cred);
    expect(lastFlags(), "回填结束后应当恢复标记回读").not.toBe(first);
  });
});
