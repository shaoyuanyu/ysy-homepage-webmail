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

  it("推荐同步集 = INBOX + 已发送 / 垃圾邮件（⚠ 刻意不含草稿与已删除，见 SUGGESTED_USES）", () => {
    // 草稿：站内草稿是本地的表 + 单向镜像写回服务器，抓回来只会让镜像出去的草稿以邮件身份
    //   回流到「全部」；已删除：删除 = MOVE 进 \Trash，抓回来等于"删了又自己回来"。
    expect(suggestSyncFolders(toFolderInfo(ALIYUN_LIST))).toEqual(["INBOX", "已发送", "垃圾邮件"]);
  });

  it("归档在推荐集里（顺序：已发送 → 垃圾 → 归档）", () => {
    const info = toFolderInfo([
      { path: "INBOX", name: "INBOX", delimiter: "/" },
      { path: "Archives", name: "Archives", delimiter: "/", specialUse: "\\Archive" },
      { path: "Junk", name: "Junk", delimiter: "/", specialUse: "\\Junk" },
      { path: "Sent Messages", name: "Sent Messages", delimiter: "/", specialUse: "\\Sent" },
    ]);
    expect(suggestSyncFolders(info)).toEqual(["INBOX", "Sent Messages", "Junk", "Archives"]);
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
    // 类型带上已读态相关字段：第九轮起「垃圾」tab 里也验行自己的 seen / hasReadState
    return (await res.json()) as {
      items: { messageId: string; seen: boolean; hasReadState: boolean }[];
    };
  };

  beforeAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    // 注册表放两个账号（只为 `/accounts` 的未读角标口径用例；本套用例不发任何 IMAP 请求）
    const accounts = ["acc1", "acc2"].map((id) => ({
      id,
      displayName: id,
      email: `${id}@local`,
      provider: "test",
      color: "sky",
      imapHost: "127.0.0.1",
      imapPort: 1,
      imapSecure: false,
      smtpHost: "127.0.0.1",
      smtpPort: 1,
      smtpSecure: false,
      folders: ["INBOX"],
      enabled: true,
    }));
    writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts }));
    writeFileSync(join(dir, "credentials.json"), JSON.stringify({}));
    ctx = {
      db: openDb(join(dir, "webmail.db")),
      dataDir: dir,
      accounts: new Map(accounts.map((a) => [a.id, a])),
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
    // 草稿（2026-10-10 阶段 0）：服务器草稿文件夹里的信被同步索引进来时，绝不能当邮件出现
    seed("mid:draft@x", "2026-10-06T00:00:00Z", [
      { accountId: "acc1", folder: "草稿", uid: 9, flags: "\\Draft \\Seen" },
    ]);

    server = createApiServer(ctx);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(root, { recursive: true, force: true });
  });

  it("不给 folder 时返回全部邮件（合并视图），**草稿与垃圾都不算邮件**", async () => {
    const r = await list("limit=50");
    // 库里 6 封：mid:draft@x 带 \Draft 标记、mid:junk@x 与 mid:acc2junk@x 只躺在「垃圾邮件」里
    // → 合并视图只剩 3 封（2026-10-10 第六轮：垃圾邮件不属于「邮件」，只能在「垃圾」tab 里看）
    expect(r.items.map((i) => i.messageId).sort()).toEqual([
      "mid:both@x",
      "mid:inbox@x",
      "mid:sent@x",
    ]);
    expect(r.items.map((i) => i.messageId)).not.toContain("mid:draft@x");
    expect(r.items.map((i) => i.messageId)).not.toContain("mid:junk@x");
    // 搜索路径（JS matchFilter）同口径：垃圾邮件与草稿都不该被搜出来
    const searched = await list(`q=${encodeURIComponent("主题")}`);
    expect(searched.items.map((i) => i.messageId)).not.toContain("mid:junk@x");
    expect(searched.items.map((i) => i.messageId)).not.toContain("mid:draft@x");
  });

  /**
   * 未读的两面（2026-10-10 第九轮用户定稿「对齐协议」）：
   * - **数字**只数收件箱：`/accounts` 的 `unread`、大标题角标、底栏、「不带 `folder` 的
   *   `filter=unseen`」四处同口径（第六轮定稿，第九轮没有改）；
   * - **垃圾箱里的未读照样是未读**：给了 `folder`（「垃圾」tab）时 `filter=unseen` 就地筛出
   *   垃圾里未读的那几封，行的 `seen` / `hasReadState` 也由垃圾副本决定。
   * ⚠ 反向验证：去掉 `unseenClause` 的 folder 分支 → 「垃圾」tab 的就地筛选立刻变空；
   *   把不带 folder 的那条改回旧的「任一副本无 \Seen」→ 未读筛选会多出垃圾那两封。
   */
  it("未读：数字只数收件箱，但「垃圾」tab 里按 folder 筛时垃圾未读照样算", async () => {
    // 合并视图（不给 folder）里收件箱未读 = mid:inbox@x 与 mid:both@x（mid:sent@x 已读）
    const unseen = await list("filter=unseen");
    expect(unseen.items.map((i) => i.messageId).sort()).toEqual(["mid:both@x", "mid:inbox@x"]);
    // 只躺在垃圾里的 mid:junk@x 虽然未读，但**不算收件箱未读** → 不进这个筛选
    expect(unseen.items.map((i) => i.messageId)).not.toContain("mid:junk@x");
    // 显式按垃圾文件夹 + 未读 = 垃圾箱里未读的那几封（「垃圾」tab 的就地筛选）
    const junkUnseen = await list(`folder=${encodeURIComponent("acc1|垃圾邮件")}&filter=unseen`);
    expect(junkUnseen.items.map((i) => i.messageId)).toEqual(["mid:junk@x"]);
    // 行的已读态与筛选同判据：垃圾副本自己未读 → 不加粗，但**有**「标为已读」可给
    expect(junkUnseen.items[0].seen).toBe(false);
    expect(junkUnseen.items[0].hasReadState).toBe(true);
    // 纯路径写法（跨账号同名垃圾文件夹）同样就地筛
    const byPath = await list(`folder=${encodeURIComponent("垃圾邮件")}&filter=unseen`);
    expect(byPath.items.map((i) => i.messageId).sort()).toEqual(["mid:acc2junk@x", "mid:junk@x"]);
    // 搜索路径（JS matchFilter）同口径：不给 folder 时仍然只认收件箱
    const searched = await list(`q=${encodeURIComponent("主题")}&filter=unseen`);
    expect(searched.items.map((i) => i.messageId).sort()).toEqual(["mid:both@x", "mid:inbox@x"]);
  });

  /**
   * 用户报障的**正面契约**（2026-10-10 第六轮）：**开关上的数字 == 打开后列出的条数**。
   * 数字来自 `/accounts` 的 `unread`（每个副本都算，只数 INBOX），条数来自
   * `/messages?filter=unseen`（消息去重）——两处必须同一个口径，否则就是用户遇到的
   * 「开关写 2、点开列出 7 封」。逐账号比对（全局求和与消息数在"同一封同时进了两个
   * 账号收件箱"时本来就不等：那是两个不同的量，实测用户数据里这种组合为 0 条）。
   * ⚠ 反向验证：把 UNSEEN_SQL 改回「任一副本无 \Seen」，acc1 立刻 2 → 3（垃圾那封进来了）。
   */
  it("账号角标的未读数 == 该账号未读筛选的条数（逐账号同口径）", async () => {
    // 造一封 acc2 的 INBOX 未读，避免第二个账号退化成「0 == 0」的空断言
    // ⚠ 用后即清必须放 finally：断言先红时若跳过清理，泄漏的桩数据会把后面的用例一起带红
    //   （2026-10-10 反向验证时正是这样多红了一条，掩盖了真正的失败点）
    seed("mid:acc2inbox@x", "2026-10-08T00:00:00Z", [
      { accountId: "acc2", folder: "INBOX", uid: 21 },
    ]);
    try {
      const accounts = (await (await fetch(`${base}/accounts`)).json()) as {
        id: string;
        unread: number;
      }[];
      const unread = new Map(accounts.map((a) => [a.id, a.unread]));
      // acc1 = mid:inbox@x + mid:both@x（垃圾里的 mid:junk@x 不算）；acc2 = 刚造的那封
      expect(unread.get("acc1")).toBe(2);
      expect(unread.get("acc2")).toBe(1);
      // ⚠ 账号范围要连「未读」一起限定：mid:both@x 的未读 INBOX 副本在 acc1，
      //   不该因为它另有一份 acc2 的副本就出现在「acc2 + 未读」里（否则角标 0、列表 1）
      expect((await list("account=acc2&filter=unseen")).items.map((i) => i.messageId)).toEqual([
        "mid:acc2inbox@x",
      ]);
      for (const a of accounts) {
        const r = await list(`account=${a.id}&filter=unseen`);
        expect(
          r.items.length,
          `账号 ${a.id}：角标写 ${a.unread}，未读筛选却列出 ${r.items.length} 封`,
        ).toBe(a.unread);
      }
    } finally {
      for (const id of ["mid:acc2inbox@x"]) {
        ctx.db.prepare("DELETE FROM copies WHERE message_id = ?").run(id);
        ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run(id);
        ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(id);
      }
    }
  });

  it("同时有 INBOX 与垃圾副本的邮件仍算正常邮件（存在非垃圾副本即可）", async () => {
    // 实测数据里这种组合为 0 条，但判定必须写成「存在非垃圾副本」而不是「不存在垃圾副本」
    seed("mid:inboxjunk@x", "2026-10-07T00:00:00Z", [
      { accountId: "acc1", folder: "垃圾邮件", uid: 11 },
      { accountId: "acc1", folder: "INBOX", uid: 12 },
    ]);
    try {
      const r = await list("limit=50");
      expect(r.items.map((i) => i.messageId)).toContain("mid:inboxjunk@x");
      // 它同时也是「收件箱未读」
      const unseen = await list("filter=unseen");
      expect(unseen.items.map((i) => i.messageId)).toContain("mid:inboxjunk@x");
    } finally {
      ctx.db.prepare("DELETE FROM copies WHERE message_id = ?").run("mid:inboxjunk@x");
      ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run("mid:inboxjunk@x");
      ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run("mid:inboxjunk@x");
    }
  });

  it("草稿在任何视图与搜索里都不出现（含显式按它的文件夹筛）", async () => {
    // 即使有人把「草稿」勾进同步白名单、前端又按该文件夹筛，草稿也不该以邮件身份返回
    const byFolder = await list(`folder=${encodeURIComponent("acc1|草稿")}`);
    expect(byFolder.items).toEqual([]);
    // 搜索走 JS 路径（matchFilter），同口径
    const bySearch = await list(`q=${encodeURIComponent("主题 mid:draft")}`);
    expect(bySearch.items).toEqual([]);
    // 方向视图 / 未读组合里同样没有它
    expect((await list("direction=received")).items.map((i) => i.messageId)).not.toContain("mid:draft@x");
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

  /**
   * 一封邮件只有一个已读态（2026-10-10 第九轮定稿的收敛）：同一封信同时有收件箱与垃圾副本
   * 时**以收件箱副本为准**——「垃圾」tab 里那一行也不跟着垃圾副本走。
   *
   * 为什么这样收敛：若按"每份副本各显示各的"，同一封信会在「收件」里粗、在「垃圾」里不粗，
   * 而详情页只能改其中一份——正是用户第七轮报过的「同一个状态存在多处、只更新一处」。
   * （实测用户数据里这种组合 0 条，但判据必须先定死，见 readCopiesOf 的注记。）
   */
  it("同时有收件箱与垃圾副本：两个 tab 显示同一个已读态（收件箱优先）", async () => {
    // ① 收件箱那份未读、垃圾那份已读 → 两边都显示未读
    seed("mid:bothboxes@x", "2026-10-09T00:00:00Z", [
      { accountId: "acc1", folder: "垃圾邮件", uid: 12, flags: "\\Seen" },
      { accountId: "acc1", folder: "INBOX", uid: 13 },
    ]);
    // ② 反过来：收件箱那份已读、垃圾那份未读 → 两边都显示已读（垃圾副本状态不参与）
    seed("mid:bothboxes2@x", "2026-10-09T01:00:00Z", [
      { accountId: "acc1", folder: "垃圾邮件", uid: 14 },
      { accountId: "acc1", folder: "INBOX", uid: 15, flags: "\\Seen" },
    ]);
    try {
      const junkTab = await list(`folder=${encodeURIComponent("acc1|垃圾邮件")}`);
      const row1 = junkTab.items.find((i) => i.messageId === "mid:bothboxes@x");
      expect(row1, "同时有收件箱副本的邮件也出现在垃圾 tab 里").toBeTruthy();
      expect(row1!.seen, "收件箱那份未读 → 显示未读").toBe(false);
      expect(row1!.hasReadState).toBe(true);
      expect(
        junkTab.items.find((i) => i.messageId === "mid:bothboxes2@x")!.seen,
        "垃圾那份未读、收件箱那份已读 → 显示已读",
      ).toBe(true);

      // 就地筛未读用同一个判据：① 在，② 不在
      const junkUnseen = await list(`folder=${encodeURIComponent("acc1|垃圾邮件")}&filter=unseen`);
      const ids = junkUnseen.items.map((i) => i.messageId);
      expect(ids).toContain("mid:bothboxes@x");
      expect(ids).not.toContain("mid:bothboxes2@x");
    } finally {
      for (const id of ["mid:bothboxes@x", "mid:bothboxes2@x"]) {
        ctx.db.prepare("DELETE FROM copies WHERE message_id = ?").run(id);
        ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run(id);
        ctx.db.prepare("DELETE FROM messages_fts WHERE message_id = ?").run(id);
      }
    }
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
