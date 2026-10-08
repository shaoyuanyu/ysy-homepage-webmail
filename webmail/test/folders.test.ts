import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../../mail/src/db.js";
import { createApiServer, parseFolderParams, type WebmailContext } from "../src/api.js";
import { suggestSyncFolders, toFolderInfo } from "../src/folders.js";

/**
 * 文件夹维度（2026-10-07）。全部**不依赖 Dovecot**：
 * - `toFolderInfo` / `suggestSyncFolders` 是纯函数（特殊用途识别、排序、推荐集）；
 * - 列表的文件夹筛选走 HTTP + 内存库（直接写 messages/copies 行），验证 SQL 与 JS
 *   两条路径的同口径。
 */
const root = join(import.meta.dirname, "..", ".test-data", "folders");

/** 阿里企业邮实测的文件夹形状：SPECIAL-USE 不生效，靠本地化名字推断 */
const ALIYUN_LIST = [
  { path: "INBOX", name: "INBOX", delimiter: "/" },
  { path: "已发送", name: "已发送", delimiter: "/", specialUse: "\\Sent", specialUseSource: "name" },
  { path: "草稿", name: "草稿", delimiter: "/", specialUse: "\\Drafts", specialUseSource: "name" },
  { path: "垃圾邮件", name: "垃圾邮件", delimiter: "/", specialUse: "\\Junk", specialUseSource: "name" },
  { path: "已删除邮件", name: "已删除邮件", delimiter: "/", specialUse: "\\Trash", specialUseSource: "name" },
];

describe("toFolderInfo / suggestSyncFolders", () => {
  it("IMAP LIST → 排序：INBOX 在首，特殊用途次之，其余按路径", () => {
    const info = toFolderInfo([
      { path: "工作", name: "工作", delimiter: "/" },
      { path: "已删除邮件", name: "已删除邮件", delimiter: "/", specialUse: "\\Trash" },
      { path: "已发送", name: "已发送", delimiter: "/", specialUse: "\\Sent" },
      { path: "INBOX", name: "INBOX", delimiter: "/" },
    ]);
    expect(info.map((f) => f.path)).toEqual(["INBOX", "已发送", "已删除邮件", "工作"]);
  });

  it("服务端不给 special-use 时按本地化名字兜底（阿里云场景）", () => {
    const info = toFolderInfo(
      ALIYUN_LIST.map(({ path, name, delimiter }) => ({ path, name, delimiter }))
    );
    const byPath = new Map(info.map((f) => [f.path, f]));
    expect(byPath.get("已发送")?.specialUse).toBe("\\Sent");
    expect(byPath.get("草稿")?.specialUse).toBe("\\Drafts");
    expect(byPath.get("垃圾邮件")?.specialUse).toBe("\\Junk");
    expect(byPath.get("已删除邮件")?.specialUse).toBe("\\Trash");
    expect(byPath.get("已发送")?.specialUseSource).toBe("name");
  });

  it("推荐同步集 = INBOX + 特殊用途文件夹（顺序：已发送 → 草稿 → 已删除 → 垃圾）", () => {
    expect(suggestSyncFolders(toFolderInfo(ALIYUN_LIST))).toEqual([
      "INBOX",
      "已发送",
      "草稿",
      "已删除邮件",
      "垃圾邮件",
    ]);
  });

  it("\\Noselect 的容器节点不进推荐集（也不标 selectable）", () => {
    const info = toFolderInfo([
      { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set<string>() },
      { path: "归档", name: "归档", delimiter: "/", flags: new Set(["\\Noselect"]) },
      { path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent", flags: new Set<string>() },
    ]);
    expect(info.find((f) => f.path === "归档")?.selectable).toBe(false);
    expect(suggestSyncFolders(info)).toEqual(["INBOX", "Sent"]);
  });

  it("清单里没有 INBOX 时推荐集仍以 INBOX 起头（不产生空数组）", () => {
    const info = toFolderInfo([{ path: "Sent", name: "Sent", delimiter: "/", specialUse: "\\Sent" }]);
    expect(suggestSyncFolders(info)).toEqual(["INBOX", "Sent"]);
    expect(suggestSyncFolders([])).toEqual(["INBOX"]);
  });

  it("name 缺失时用路径末段；delimiter 缺失回退 /", () => {
    const info = toFolderInfo([{ path: "INBOX/子文件夹" }]);
    expect(info[0].name).toBe("子文件夹");
    expect(info[0].delimiter).toBe("/");
  });
});

describe("parseFolderParams", () => {
  it("支持「账号|路径」与纯路径两种写法", () => {
    expect(parseFolderParams(["acc1|已发送"])).toEqual([{ account: "acc1", path: "已发送" }]);
    expect(parseFolderParams(["已发送"])).toEqual([{ account: "", path: "已发送" }]);
    expect(parseFolderParams(["acc1|a|b"])).toEqual([{ account: "acc1", path: "a|b" }]);
    expect(parseFolderParams([""])).toEqual([]);
    expect(parseFolderParams([null])).toEqual([]);
    expect(parseFolderParams(["|x"])).toEqual([{ account: "", path: "|x" }]);
  });

  it("多个 folder 参数取并集（2026-10-08「垃圾」tab 用）", () => {
    expect(parseFolderParams(["acc1|垃圾邮件", "acc1|[Gmail]/Spam"])).toEqual([
      { account: "acc1", path: "垃圾邮件" },
      { account: "acc1", path: "[Gmail]/Spam" },
    ]);
    // 空串参数被忽略；每个参数自带账号（多账号下各自限定，不互相污染）
    expect(parseFolderParams(["", "acc2|Spam", "acc1|垃圾邮件"])).toEqual([
      { account: "acc2", path: "Spam" },
      { account: "acc1", path: "垃圾邮件" },
    ]);
  });
});

describe("列表的文件夹筛选（HTTP + 内存库）", () => {
  let server: Server;
  let base: string;
  let ctx: WebmailContext;
  const dir = join(root, "data");

  const seed = (
    messageId: string,
    date: string,
    copies: { accountId: string; folder: string; uid: number; flags?: string }[]
  ) => {
    ctx.db
      .prepare(
        `INSERT INTO messages (message_id, date, from_addr, from_name, to_json, cc_json, subject,
           snippet, size, truncated, first_seen, eml_path, refs_json, has_attach)
         VALUES (?, ?, 'a@b.c', 'A', '[]', '[]', ?, ?, 1, 0, ?, '', '[]', 0)`
      )
      .run(messageId, date, `主题 ${messageId}`, `摘要 ${messageId}`, date);
    // 搜索走 FTS 表（trigram），js 路径的用例需要它
    ctx.db
      .prepare(
        "INSERT INTO messages_fts (message_id, subject, from_text, to_text, body) VALUES (?, ?, ?, ?, ?)"
      )
      .run(messageId, `主题 ${messageId}`, "a@b.c", "", `摘要 ${messageId}`);
    for (const c of copies) {
      ctx.db
        .prepare(
          "INSERT INTO copies (account_id, folder, uid, message_id, flags) VALUES (?, ?, ?, ?, ?)"
        )
        .run(c.accountId, c.folder, c.uid, messageId, c.flags ?? "");
    }
  };

  const list = async (query: string) => {
    const res = await fetch(`${base}/messages?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { messageId: string }[] };
  };

  beforeAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: [] }));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({}));
    ctx = {
      db: openDb(join(dir, "webmail.db")),
      dataDir: dir,
      accounts: new Map(),
      credentials: new Map(),
      remoteImageDomains: [],
      syncStates: new Map(),
    };
    seed("mid:inbox@x", "2026-10-01T00:00:00Z", [{ accountId: "acc1", folder: "INBOX", uid: 1 }]);
    seed("mid:sent@x", "2026-10-02T00:00:00Z", [
      { accountId: "acc1", folder: "已发送", uid: 2, flags: "\\Seen" },
    ]);
    seed("mid:junk@x", "2026-10-03T00:00:00Z", [
      { accountId: "acc1", folder: "垃圾邮件", uid: 3 },
    ]);
    seed("mid:acc2junk@x", "2026-10-04T00:00:00Z", [
      { accountId: "acc2", folder: "垃圾邮件", uid: 7 },
    ]);
    // 多副本：同时在 INBOX 与「已发送」（跨账号去重场景）
    seed("mid:both@x", "2026-10-05T00:00:00Z", [
      { accountId: "acc1", folder: "INBOX", uid: 4 },
      { accountId: "acc2", folder: "已发送", uid: 8 },
    ]);

    server = createApiServer(ctx);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("不给 folder 时返回全部邮件（合并视图）", async () => {
    const r = await list("limit=50");
    expect(r.items.length).toBe(5);
  });

  it("纯路径：命中所有账号里该文件夹的副本", async () => {
    const r = await list(`folder=${encodeURIComponent("垃圾邮件")}`);
    expect(r.items.map((i) => i.messageId).sort()).toEqual(["mid:acc2junk@x", "mid:junk@x"]);
  });

  it("多个 folder 参数取并集：跨账号一次筛出各自的垃圾文件夹", async () => {
    // 现实里 acc1 叫「垃圾邮件」、acc2 可能叫别的名字（Gmail 是 [Gmail]/Spam）——
    // 前端逐个账号探测后把路径一起发过来，服务端做并集
    const r = await list(
      `folder=${encodeURIComponent("acc1|垃圾邮件")}&folder=${encodeURIComponent("acc2|垃圾邮件")}`
    );
    expect(r.items.map((i) => i.messageId).sort()).toEqual(["mid:acc2junk@x", "mid:junk@x"]);
    // 带上账号参数时只在账号内匹配（两个参数同属一个账号）
    const one = await list(
      `folder=${encodeURIComponent("acc2|垃圾邮件")}&folder=${encodeURIComponent("acc2|INBOX")}`
    );
    expect(one.items.map((i) => i.messageId)).toEqual(["mid:acc2junk@x"]);
  });

  it("「账号|路径」：限定在该账号内", async () => {
    const r = await list(`folder=${encodeURIComponent("acc1|垃圾邮件")}`);
    expect(r.items.map((i) => i.messageId)).toEqual(["mid:junk@x"]);
  });

  it("多副本邮件在任一副本所在文件夹里都能被筛到", async () => {
    const inbox = await list(`folder=${encodeURIComponent("acc1|INBOX")}`);
    expect(inbox.items.map((i) => i.messageId).sort()).toEqual(["mid:both@x", "mid:inbox@x"]);
    // mid:both@x 的另一份副本在 acc2 的「已发送」里：只有 acc2 的该文件夹能筛到它
    const acc1Sent = await list(`folder=${encodeURIComponent("acc1|已发送")}`);
    expect(acc1Sent.items.map((i) => i.messageId)).toEqual(["mid:sent@x"]);
    const acc2Sent = await list(`folder=${encodeURIComponent("acc2|已发送")}`);
    expect(acc2Sent.items.map((i) => i.messageId)).toEqual(["mid:both@x"]);
  });

  it("文件夹 + 未读组合筛选（与 SQL 口径一致）", async () => {
    const r = await list(`folder=${encodeURIComponent("acc1|垃圾邮件")}&filter=unseen`);
    expect(r.items.map((i) => i.messageId)).toEqual(["mid:junk@x"]);
  });

  it("搜索路径（q）与 SQL 路径同口径：限定文件夹后结果一致", async () => {
    // 走 JS 路径（带 q），关键词命中所有「主题 mid:…」——靠 folder 收窄
    const r = await list(`q=${encodeURIComponent("主题")}&folder=${encodeURIComponent("acc1|垃圾邮件")}`);
    expect(r.items.map((i) => i.messageId)).toEqual(["mid:junk@x"]);
  });

  it("不存在的文件夹返回空列表（不报错）", async () => {
    const r = await list(`folder=${encodeURIComponent("acc1|不存在的文件夹")}`);
    expect(r.items).toEqual([]);
  });
});
