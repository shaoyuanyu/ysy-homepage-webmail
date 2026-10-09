import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb, type Db } from "../../mail/src/db.js";
import { addAccount, deleteAccount } from "../src/accounts.js";
import type { WebmailContext } from "../src/api.js";
import type { WebmailAccount } from "../src/types.js";

/**
 * 账号删除 / 重加时的**同步状态残留**（2026-10-08 事故回归）。
 *
 * 事故：删掉一个邮箱，再把**同一个**邮箱加回来 → 一封信都不下来，界面上连进度都没有，
 * 也不报任何错。链路：
 *   1. 账号 id 由邮箱地址推导（`deriveId`）——「删掉再加同一个邮箱」拿到的是**同一个 id**；
 *   2. 旧 `deleteAccount` 只清 copies / messages，**不清 folders 行**；
 *   3. folders 行里存的是水位线 `last_seen_uid`（现场是 6711）与回填游标 `backfill_uid`
 *      （旧账号回填已完成 = NULL）→ 新账号继承水位线：服务端 6711 封全被当成
 *      「早就抓过了」，`backfill_uid` 又是 NULL（不算「有待回填」）→ 既不抓也不回填。
 *
 * 两处一起修（本文件锁这两条）：
 *   - `deleteAccount` 现在连 folders 行一起清（根因）；
 *   - `addAccount` 落盘前再清一次残留（给已经被污染的库兜底，比如升级前的 dev/prod）。
 * 判据侧的自愈在 mail 仓库（`syncFolder`），由 mail/test/backfill.test.ts 锁定。
 */

const root = join(import.meta.dirname, "..", ".test-data", "account-state");

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function account(id: string, email: string): WebmailAccount {
  return {
    id,
    displayName: id,
    email,
    provider: "test",
    color: "#000000",
    imapHost: "127.0.0.1",
    imapPort: 1,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1,
    smtpSecure: false,
    folders: ["INBOX"],
    enabled: true,
  };
}

/** 一个「已同步过 3 封」的账号 + 一个陪跑账号（至少留一个账号才能删） */
function makeContext(suffix: string) {
  const dir = join(root, suffix);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const accounts = [account("ysy", "ysy@foxmail.com"), account("keep", "keep@test.local")];
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts }, null, 2));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      ysy: { username: "ysy@foxmail.com", password: "p" },
      keep: { username: "keep@test.local", password: "p" },
    })
  );

  const db: Db = openDb(join(dir, "webmail.db"));
  const insMsg = db.prepare(
    `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject, snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
     VALUES (?, ?, 'a@b.c', 'A', '[]', '[]', ?, 'snip', 4, 0, ?, ?, '[]', 0)`
  );
  const insFts = db.prepare(
    "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, 'a@b.c', '', 'body')"
  );
  const insCopy = db.prepare(
    "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES (?, ?, ?, ?, '')"
  );
  const insFolder = db.prepare(
    `INSERT INTO folders (account_id, path, uidvalidity, last_seen_uid, last_flags_sync, backfill_uid, backfill_total, backfill_remaining)
     VALUES (?, 'INBOX', 1, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  db.transaction(() => {
    for (let i = 0; i < 3; i++) {
      const mid = `mid:ysy-${i}@test.local`;
      insMsg.run(mid, now, `s${i}`, now, `eml/${i}.eml`);
      insFts.run(mid, `s${i}`);
      insCopy.run("ysy", "INBOX", i + 1, mid);
    }
    // ysy：水位线推到 6711、回填已完成（= 事故现场里那条残留的 folders 行）
    insFolder.run("ysy", 6711, now, null, 6711, 0);
    insFolder.run("keep", 3, now, null, 3, 0);
  })();

  const ctx: WebmailContext = {
    db,
    dataDir: dir,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    credentials: new Map(accounts.map((a) => [a.id, { username: a.email, password: "p" }])),
    remoteImageDomains: [],
    syncStates: new Map(),
  };
  const n = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { n: number }).n;
  return { ctx, db, dir, n };
}

describe("deleteAccount：同步状态（folders 行）必须一起清掉", () => {
  it("删完不留水位线——否则重新加同一个邮箱会继承它、一封信都下不来", () => {
    const { ctx, db, n } = makeContext("delete");
    expect(n("SELECT COUNT(*) AS n FROM folders WHERE account_id = 'ysy'")).toBe(1);

    deleteAccount(ctx, "ysy");

    // 副本与 folders 行都没了（folders 行是关键：它就是「继承水位线」的来源）
    expect(n("SELECT COUNT(*) AS n FROM copies WHERE account_id = 'ysy'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM folders WHERE account_id = 'ysy'")).toBe(0);
    // 别的账号的状态不受影响
    expect(n("SELECT COUNT(*) AS n FROM folders WHERE account_id = 'keep'")).toBe(1);
    // 孤儿邮件与 FTS 一起回收（3 封只有 ysy 一个副本）
    expect(n("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM messages_fts")).toBe(0);
    db.close();
  });

  it("删除账号时只在磁盘上删掉本账号引用的原文（孤立文件不碰）", () => {
    const { ctx, db, dir } = makeContext("delete-eml");
    mkdirSync(join(dir, "eml"), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(dir, `eml/${i}.eml`), "Subject: x\n\nbody");
    writeFileSync(join(dir, "eml/untouched.eml"), "keep me");

    deleteAccount(ctx, "ysy");
    expect(readdirSync(join(dir, "eml")).sort()).toEqual(["untouched.eml"]);
    db.close();
  });
});

describe("addAccount：落盘前清掉同 id 的残留状态（已被污染的库兜底）", () => {
  it("旧版删除留下的 folders 行不会让新账号继承（否则永远抓不到历史邮件）", async () => {
    const { ctx, db, n } = makeContext("re-add");
    // 复刻「旧 deleteAccount 删过、folders 行还在」：账号注册表里已经没有 ysy，
    // 但 folders 行还留着一条水位线 6711 的残留
    ctx.accounts.delete("ysy");
    ctx.credentials.delete("ysy");
    expect(n("SELECT COUNT(*) AS n FROM folders WHERE account_id = 'ysy'")).toBe(1);

    // 重新加同一个邮箱 → 推导出的 id 还是 "ysy"，会撞上那条残留
    const summary = await addAccount(
      ctx,
      {
        displayName: "个人",
        email: "ysy@foxmail.com",
        imapHost: "imap.qq.com",
        imapPort: 993,
        imapSecure: true,
        smtpHost: "smtp.qq.com",
        smtpPort: 465,
        smtpSecure: true,
        // 占位符，非真实凭据：这里只需要一个非空串过校验（addAccount 会拒绝空密码）。
        // 曾用 "authcode" 导致 GitGuardian 误判为 SMTP 凭据泄露，故改为一眼可辨的假值。
        password: "FIXTURE-NOT-A-REAL-SECRET",
      },
      { test: false }
    );
    expect(summary.id).toBe("ysy");
    // 残留被清 → 下一次同步会走「首次同步」初始化（钉水位线 + 从头回填），
    // 而不是拿着 6711 的水位线一封都不抓
    expect(n("SELECT COUNT(*) AS n FROM folders WHERE account_id = 'ysy'")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM copies WHERE account_id = 'ysy'")).toBe(0);
    // 残留副本对应的孤儿邮件/索引也一起回收了
    expect(n("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(n("SELECT COUNT(*) AS n FROM messages_fts")).toBe(0);
    db.close();
  });
});
