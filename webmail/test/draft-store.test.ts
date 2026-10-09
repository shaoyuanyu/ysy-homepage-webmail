import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../../mail/src/db.js";
import { purgeIndexedDrafts } from "../src/draft-store.js";

/**
 * 草稿清理（2026-10-10 阶段 0）：历史上被当成邮件索引进来的草稿要能被一次清干净，
 * 且**不能误伤**那些还有正常副本的邮件。
 */
const root = join(import.meta.dirname, "..", ".test-data", "draft-store");

describe("purgeIndexedDrafts", () => {
  const dir = join(root, "data");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "eml"), { recursive: true });
  const db = openDb(join(dir, "webmail.db"));

  const addMessage = (id: string, eml: string) => {
    db.prepare(
      `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject,
         snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
       VALUES (?, '2026-10-01T00:00:00Z', 'a@b.c', 'A', '[]', '[]', ?, '', 1, 0, '2026-10-01T00:00:00Z', ?, '[]', 0)`
    ).run(id, `主题 ${id}`, eml);
    db.prepare(
      "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, 'a@b.c', '', '')"
    ).run(id, `主题 ${id}`);
    if (eml) writeFileSync(join(dir, eml), "raw");
  };
  const addCopy = (id: string, folder: string, uid: number, flags: string) => {
    db.prepare(
      "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES ('acc1', ?, ?, ?, ?)"
    ).run(folder, uid, id, flags);
  };

  // ① 纯草稿：只有一个 \Draft 副本 → 副本、邮件本体、FTS 行、.eml 都该消失
  addMessage("mid:only-draft@x", "eml/only-draft.eml");
  addCopy("mid:only-draft@x", "草稿", 1, "\\Draft \\Seen");
  // ② 带 \Deleted 的僵尸草稿（服务端从未 EXPUNGE 的那种）同样是草稿
  addMessage("mid:zombie-draft@x", "eml/zombie.eml");
  addCopy("mid:zombie-draft@x", "Drafts", 2, "\\Deleted \\Draft");
  // ③ 既在草稿里、也在收件箱里（例如同一 Message-ID 被别的客户端 APPEND 过）→
  //    **只清草稿副本**，邮件本体与其他副本必须留着
  addMessage("mid:both-draft@x", "eml/both.eml");
  addCopy("mid:both-draft@x", "草稿", 3, "\\Draft");
  addCopy("mid:both-draft@x", "INBOX", 4, "\\Seen");
  // ④ 普通邮件：一根汗毛都不许动
  addMessage("mid:plain@x", "eml/plain.eml");
  addCopy("mid:plain@x", "INBOX", 5, "");

  it("清掉草稿副本与孤儿邮件（含 .eml），保留仍有正常副本的邮件", () => {
    const r = purgeIndexedDrafts(db, dir);
    // 3 个草稿副本（① ② ③的草稿那份）
    expect(r.copies).toBe(3);
    // ① ② 的邮件本体成为孤儿被清（③ 还有 INBOX 副本，不算孤儿）
    expect(r.messages).toBe(2);
    expect(r.eml).toBe(2);
    expect(existsSync(join(dir, "eml/only-draft.eml"))).toBe(false);
    expect(existsSync(join(dir, "eml/zombie.eml"))).toBe(false);
    expect(existsSync(join(dir, "eml/both.eml"))).toBe(true);
    expect(existsSync(join(dir, "eml/plain.eml"))).toBe(true);

    const ids = (
      db.prepare("SELECT message_id FROM messages ORDER BY message_id").all() as { message_id: string }[]
    ).map((x) => x.message_id);
    expect(ids).toEqual(["mid:both-draft@x", "mid:plain@x"]);
    const copies = (
      db.prepare("SELECT folder FROM copies ORDER BY uid").all() as { folder: string }[]
    ).map((x) => x.folder);
    expect(copies).toEqual(["INBOX", "INBOX"]);
    // FTS 行跟着孤儿一起清掉（外部内容表不受外键级联保护，靠 pruneOrphanMessages 显式删）
    const fts = db
      .prepare("SELECT message_id FROM messages_fts WHERE message_id IN ('mid:only-draft@x','mid:zombie-draft@x')")
      .all();
    expect(fts).toEqual([]);
  });

  it("幂等：没有草稿副本时直接返回 0", () => {
    expect(purgeIndexedDrafts(db, dir)).toEqual({ copies: 0, messages: 0, eml: 0 });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));
});
