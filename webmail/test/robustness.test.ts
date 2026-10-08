import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../mail/src/db.js";
import { parseLimit, runSync, type WebmailContext } from "../src/api.js";
import { mirrorDrafts } from "../src/draft-mirror.js";
import { applyFlagChange } from "../src/write.js";
import { withAccountLock } from "../src/locks.js";
import type { WebmailAccount } from "../src/types.js";

/**
 * 健壮性回归（2026-10-07）。全部**不依赖 Dovecot/容器**：用不可达端口
 * （127.0.0.1:1 → ECONNREFUSED）制造真实的连接失败，验证的是失败路径本身。
 */
const root = join(import.meta.dirname, "..", ".test-data", "robustness");

function makeCtx(dirName: string, accounts: Partial<WebmailAccount>[] = [{}]): WebmailContext {
  const dir = join(root, dirName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const full = accounts.map((a, i) => ({
    id: `acc${i + 1}`,
    displayName: `账号${i + 1}`,
    email: `acc${i + 1}@local`,
    provider: "test",
    color: "sky",
    // ⚠ 127.0.0.1:1 是保留端口，必然 ECONNREFUSED——比连一个黑洞 IP 快得多
    imapHost: "127.0.0.1",
    imapPort: 1,
    imapSecure: false,
    smtpHost: "127.0.0.1",
    smtpPort: 1,
    smtpSecure: false,
    folders: ["INBOX"],
    enabled: true,
    ...a,
  })) as WebmailAccount[];
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: full }, null, 2));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify(Object.fromEntries(full.map((a) => [a.id, { username: a.id, password: "x" }])))
  );
  return {
    db: openDb(join(dir, "webmail.db")),
    dataDir: dir,
    accounts: new Map(full.map((a) => [a.id, a])),
    credentials: new Map(full.map((a) => [a.id, { username: a.id, password: "x" }])),
    remoteImageDomains: [],
    syncStates: new Map(),
  };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("parseLimit：分页大小钳制", () => {
  it("缺失 / 非法 / 非正数回退 50（负数会被 SQLite 当无上限，必须拦）", () => {
    expect(parseLimit(null)).toBe(50);
    expect(parseLimit(undefined)).toBe(50);
    expect(parseLimit("")).toBe(50);
    expect(parseLimit("abc")).toBe(50);
    expect(parseLimit("0")).toBe(50);
    expect(parseLimit("-5")).toBe(50);
    expect(parseLimit("-1")).toBe(50);
    expect(parseLimit("NaN")).toBe(50);
  });

  it("正常值透传，上限 200，小数取整", () => {
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("50")).toBe(50);
    expect(parseLimit("200")).toBe(200);
    expect(parseLimit("9999")).toBe(200);
    expect(parseLimit("12.9")).toBe(12);
  });
});

describe("runSync：单账号失败不拖累其它账号", () => {
  it("两个账号都连不上时，两个都被尝试并各自记录错误（不再第一封失败就中断整轮）", async () => {
    const ctx = makeCtx("sync-isolation", [{}, {}]);
    const round = await runSync(ctx);
    expect(round.results.length).toBe(0);
    expect(round.errors.map((e) => e.accountId).sort()).toEqual(["acc1", "acc2"]);
    // 每个账号的 lastError 都被记下（/health 靠它显示告警，不再静默陈旧）
    expect(ctx.syncStates.get("acc1")?.lastError).toBeTruthy();
    expect(ctx.syncStates.get("acc2")?.lastError).toBeTruthy();
  });

  it("指定账号同步失败时把错误抛给调用方（POST /sync {accountId} 的失败语义）", async () => {
    const ctx = makeCtx("sync-single", [{}, {}]);
    await expect(runSync(ctx, "acc2")).rejects.toThrow();
    // 只尝试了指定账号
    expect(ctx.syncStates.get("acc1")?.lastError ?? null).toBeNull();
    expect(ctx.syncStates.get("acc2")?.lastError).toBeTruthy();
  });

  it("并发的全量同步复用同一轮（定时器与页面刷新不再叠加排队）", async () => {
    const ctx = makeCtx("sync-dedup", [{}]);
    const p1 = runSync(ctx);
    const p2 = runSync(ctx);
    expect(p2).toBe(p1);
    await p1;
    const p3 = runSync(ctx);
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe("withAccountLock：串行与释放", () => {
  it("同一账号的操作严格串行（先入先出）", async () => {
    const order: string[] = [];
    const task = (name: string, delay: number) =>
      withAccountLock("acc", async () => {
        order.push(`${name}:start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${name}:end`);
      });
    // 第二条故意更快，串行下也必须在第一条结束后才开始
    await Promise.all([task("a", 20), task("b", 1), task("c", 1)]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });

  it("抛错的回调也会释放锁（后续操作不被永久阻塞）", async () => {
    await expect(
      withAccountLock("acc-throw", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    const r = await withAccountLock("acc-throw", async () => "ok");
    expect(r).toBe("ok");
  });
});

describe("mirrorDrafts：并发扫描不重复投递", () => {
  it("同一时刻只跑一轮（返回值是同一 promise），完成后可再跑", async () => {
    const ctx = makeCtx("mirror-dedup", [{ enabled: true }]);
    ctx.db
      .prepare(
        `INSERT INTO drafts (id, kind, kind_ref, account_id, to_text, cc_text, bcc_text, subject,
           body, read_receipt, in_reply_to, references_json, created_at, updated_at,
           server_dirty, server_account, server_folder, server_uid, server_uidvalidity)
         VALUES ('d1','new','','acc1','a@b.c','','','s','b',0,'','[]',?,?,1,'','',NULL,'')`
      )
      .run(new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString());

    const p1 = mirrorDrafts(ctx, { quietMs: 0 });
    const p2 = mirrorDrafts(ctx, { quietMs: 0 });
    expect(p2).toBe(p1);
    const r = await p1;
    // 账号连不上：投递失败 1 条、成功 0 条（且草稿仍留 dirty，下轮重试）
    expect(r).toEqual({ mirrored: 0, failed: 1 });
    const dirty = ctx.db.prepare("SELECT server_dirty FROM drafts WHERE id = 'd1'").get() as {
      server_dirty: number;
    };
    expect(dirty.server_dirty).toBe(1);

    const p3 = mirrorDrafts(ctx, { quietMs: 0 });
    expect(p3).not.toBe(p1);
    await p3;
  });
});

describe("applyFlagChange：本地索引的标记重算（红线 2 的本地对应物）", () => {
  it("只增删 \\Seen / \\Flagged，其余标记原样保留（不整串覆盖）", () => {
    const base = "\\Answered \\Draft \\Seen";
    expect(applyFlagChange(base, { seen: false })).toBe("\\Answered \\Draft");
    expect(applyFlagChange(base, { flagged: true })).toBe("\\Answered \\Draft \\Seen \\Flagged");
    // 两个同时改
    expect(applyFlagChange(base, { seen: false, flagged: true })).toBe("\\Answered \\Draft \\Flagged");
  });

  it("幂等：重复写同一个值不产生重复标记", () => {
    expect(applyFlagChange("\\Seen", { seen: true })).toBe("\\Seen");
    expect(applyFlagChange("", { seen: false })).toBe("");
    expect(applyFlagChange("\\Flagged", { flagged: true })).toBe("\\Flagged");
  });

  it("空标记串与未指定的字段都不炸", () => {
    expect(applyFlagChange("", {})).toBe("");
    expect(applyFlagChange("\\Seen", {})).toBe("\\Seen");
  });
});
