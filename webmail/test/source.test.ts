import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../mail/src/db.js";
import type { WebmailContext } from "../src/api.js";
import { fetchTruncatedSource, readSource } from "../src/source.js";

/**
 * 按需取原文（2026-10-07）里**不需要 IMAP** 的部分：读原文、幂等、错误分支。
 * 真正"连上 IMAP 取回原文并回填索引"的那条路在 api.test.ts（需 Dovecot）。
 */
const root = join(import.meta.dirname, "..", ".test-data", "source");

function makeCtx(name: string): WebmailContext {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "eml"), { recursive: true });
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: [] }));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({}));
  return {
    db: openDb(join(dir, "webmail.db")),
    dataDir: dir,
    accounts: new Map(),
    credentials: new Map(),
    remoteImageDomains: [],
    syncStates: new Map(),
  };
}

function seed(
  ctx: WebmailContext,
  id: string,
  opts: { truncated: number; eml?: string; size?: number; copies?: boolean }
) {
  ctx.db
    .prepare(
      `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject,
         snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
       VALUES (?, '2026-10-01T00:00:00Z', 'a@b.c', 'A', '[]', '[]', 's', '', ?, ?, '2026-10-01T00:00:00Z', ?, '[]', 0)`
    )
    .run(id, opts.size ?? 10, opts.truncated, opts.eml ?? "");
  if (opts.copies !== false) {
    ctx.db
      .prepare("INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES ('acc1','INBOX',1,?,'')")
      .run(id);
  }
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("readSource：原文读取", () => {
  it("有原文时返回字节（emoji 与换行原样）", () => {
    const ctx = makeCtx("read");
    const raw = Buffer.from("Subject: 你好\r\n\r\n正文 🎉\r\n", "utf8");
    writeFileSync(join(ctx.dataDir, "eml", "a.eml"), raw);
    seed(ctx, "mid:a@x", { truncated: 0, eml: "eml/a.eml" });
    expect(readSource(ctx, "mid:a@x")?.toString("utf8")).toBe(raw.toString("utf8"));
  });

  it("只有索引（truncated，无 eml_path）时返回 null；不存在的消息也返回 null", () => {
    const ctx = makeCtx("empty");
    seed(ctx, "mid:t@x", { truncated: 1 });
    expect(readSource(ctx, "mid:t@x")).toBeNull();
    expect(readSource(ctx, "mid:nope@x")).toBeNull();
  });

  it("eml_path 指向的文件已丢失时返回 null（不抛错——磁盘被清理过也要能开列表）", () => {
    const ctx = makeCtx("missing-file");
    seed(ctx, "mid:gone@x", { truncated: 0, eml: "eml/nope.eml" });
    expect(readSource(ctx, "mid:gone@x")).toBeNull();
  });
});

describe("fetchTruncatedSource：错误与幂等分支", () => {
  it("消息不存在 → 抛错", async () => {
    const ctx = makeCtx("not-found");
    await expect(fetchTruncatedSource(ctx, "mid:nope@x")).rejects.toThrow("消息不存在");
  });

  it("已有原文 → 幂等返回 fetched=false，不再连 IMAP", async () => {
    const ctx = makeCtx("idempotent");
    writeFileSync(join(ctx.dataDir, "eml", "a.eml"), Buffer.from("x"));
    seed(ctx, "mid:a@x", { truncated: 0, eml: "eml/a.eml", size: 42 });
    await expect(fetchTruncatedSource(ctx, "mid:a@x")).resolves.toEqual({ fetched: false, size: 42 });
  });

  it("没有可用的服务器副本 → 抛错（不能默默什么都不做）", async () => {
    const ctx = makeCtx("no-copies");
    seed(ctx, "mid:t@x", { truncated: 1, copies: false });
    await expect(fetchTruncatedSource(ctx, "mid:t@x")).rejects.toThrow("没有可用的服务器副本");
  });

  it("超过按需上限的超大邮件 → 明确拒绝（不把进程内存打爆）", async () => {
    const ctx = makeCtx("too-big");
    seed(ctx, "mid:big@x", { truncated: 1, size: 300 * 1024 * 1024 });
    await expect(fetchTruncatedSource(ctx, "mid:big@x")).rejects.toThrow(/超过按需取原文的上限/);
  });
});
