import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import {
  connectUser,
  deliverFixtures,
  startDovecot,
  waitReady,
  type DovecotHandle,
} from "./dovecot.js";
import { deleteUid } from "../src/write.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

let dovecot: DovecotHandle;
let sink: SmtpSink;
let tc: TestContext;
let server: Server;
let base: string;

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}${path}`, init);
}

beforeAll(async () => {
  dovecot = startDovecot("api");
  await waitReady(dovecot);
  sink = await startSmtpSink();
  tc = makeContext(dovecot, sink.port, "api");
  // w01 投递到两个账号（同一 Message-ID 的多副本），w03/w04/w05/w06 只在 acc1，w02 只在 acc2
  // w05/w06 是同一会话的两环（w06 的 References 指向 w05）
  await deliverFixtures(dovecot, "test", "test", ["01.eml", "03.eml", "04.eml", "05.eml", "06.eml"]);
  await deliverFixtures(dovecot, "test2", "test2", ["01.eml", "02.eml"]);
  server = createApiServer(tc.ctx);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  server.close();
  await sink.close();
  tc.cleanup();
  dovecot.cleanup();
});

describe("webmaild HTTP API", () => {
  it("同步后合并视图按时间倒序，跨账号副本聚合在一条消息上", async () => {
    const res = await api("/sync", { method: "POST" });
    expect(res.status).toBe(200);

    const list = (await (await api("/messages")).json()) as {
      items: { messageId: string; accounts: string[]; copies: unknown[]; subject: string }[];
      next: string | null;
    };
    expect(list.items.length).toBe(6);
    const dates = list.items.map((i) => i.subject);
    expect(dates).toEqual([
      "Re: Project kickoff",
      "Project kickoff",
      "Report with attachment",
      "HTML Newsletter",
      "Weekly Digest",
      "面试通知",
    ]);
    const shared = list.items.find((i) => i.messageId === "mid:w01@test.local");
    expect(shared).toBeDefined();
    expect(shared!.accounts.sort()).toEqual(["acc1", "acc2"]);
    expect(shared!.copies.length).toBe(2);
  });

  it("账号筛选只返回该账号可见的消息", async () => {
    const list = (await (await api("/messages?account=acc2")).json()) as {
      items: { messageId: string }[];
    };
    expect(list.items.map((i) => i.messageId).sort()).toEqual([
      "mid:w01@test.local",
      "mid:w02@test.local",
    ]);
  });

  it("账号筛选支持逗号多值（并集，2026-10-05）：acc1,acc2 = 全部；重复 id 不重复计数", async () => {
    const both = (await (await api("/messages?account=acc1,acc2")).json()) as {
      items: { messageId: string }[];
    };
    expect(both.items.length).toBe(6); // 与无筛选一致 = 两账号并集（旧实现按整串匹配只得 0 条）

    const dup = (await (await api("/messages?account=acc2,acc2")).json()) as {
      items: { messageId: string }[];
    };
    expect(dup.items.map((i) => i.messageId).sort()).toEqual([
      "mid:w01@test.local",
      "mid:w02@test.local",
    ]);
  });

  it("搜索：中文 4 字符走 trigram，2 字符走 LIKE 兜底", async () => {
    const tri = (await (await api("/messages?q=周五下午")).json()) as {
      items: { messageId: string }[];
    };
    expect(tri.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);

    const like = (await (await api("/messages?q=面试")).json()) as {
      items: { messageId: string }[];
    };
    expect(like.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);
  });

  it("游标分页：第一页拿满 limit，第二页取剩余", async () => {
    const p1 = (await (await api("/messages?limit=4")).json()) as {
      items: { messageId: string }[];
      next: string | null;
    };
    expect(p1.items.length).toBe(4);
    expect(p1.next).toBeTruthy();
    const p2 = (await (
      await api(`/messages?limit=4&before=${encodeURIComponent(p1.next!)}`)
    ).json()) as { items: { messageId: string }[]; next: string | null };
    expect(p2.items.length).toBe(2);
    expect(p2.next).toBeNull();
    const all = new Set([...p1.items, ...p2.items].map((i) => i.messageId));
    expect(all.size).toBe(6);
  });

  it("HTML 邮件：白名单外远程图片剥除，白名单内保留，cid 重写到附件端点，style 里的 url() 被剥除", async () => {
    const detail = (await (await api(`/message/${encodeURIComponent("mid:w03@test.local")}`)).json()) as {
      html: string;
      remoteBlocked: number;
      attachments: { cid: string | null; inline: boolean }[];
    };
    expect(detail.remoteBlocked).toBe(1);
    expect(detail.html).toContain('data-remote-src="https://tracker.example.com/pixel.png"');
    // 属性名 data-remote-src 也含子串 src=，断言要用带前导空格的 src="
    expect(detail.html).not.toContain(' src="https://tracker.example.com/pixel.png"');
    expect(detail.html).toContain('src="https://pics.edu.cn/logo.png"');
    expect(detail.html).toContain("/api/mail/message/mid%3Aw03%40test.local/attachment/0");
    // sanitize-html 会把 style 重序列化为紧凑形式（color: red → color:red）
    expect(detail.html).toContain("color:red");
    expect(detail.html).not.toContain("url(");
    expect(detail.attachments.length).toBe(1);
    expect(detail.attachments[0].cid).toBeTruthy();
  });

  it("附件端点返回原始字节", async () => {
    const res = await api(
      `/message/${encodeURIComponent("mid:w04@test.local")}/attachment/0`
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.toString("utf8")).toBe("hello report\n");
  });

  it("健康检查报告每账号最近同步状态", async () => {
    const health = (await (await api("/health")).json()) as {
      ok: boolean;
      accounts: { id: string; lastSync: string | null; lastError: string | null }[];
    };
    expect(health.ok).toBe(true);
    for (const a of health.accounts) {
      expect(a.lastSync).toBeTruthy();
      expect(a.lastError).toBeNull();
    }
  });

  it("不存在的消息返回 404", async () => {
    const res = await api(`/message/${encodeURIComponent("mid:nope@test.local")}`);
    expect(res.status).toBe(404);
  });

  it("列表项带 hasAttach：有可下载附件为 true，纯文本为 false", async () => {
    const list = (await (await api("/messages")).json()) as {
      items: { messageId: string; hasAttach: boolean }[];
    };
    const byId = new Map(list.items.map((i) => [i.messageId, i.hasAttach]));
    expect(byId.get("mid:w04@test.local")).toBe(true);
    expect(byId.get("mid:w01@test.local")).toBe(false);
  });

  it("状态筛选：unseen 排除全副本已读，flagged 只留加星；恢复后计数复原", async () => {
    const unseen0 = (await (await api("/messages?filter=unseen")).json()) as {
      items: { messageId: string }[];
    };
    expect(unseen0.items.length).toBe(6);
    const flagged0 = (await (await api("/messages?filter=flagged")).json()) as {
      items: { messageId: string }[];
    };
    expect(flagged0.items.length).toBe(0);

    // w06 标记已读 → unseen 少一条；w02 加星 → flagged 只剩它
    const f1 = await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w06@test.local", seen: true }),
    });
    expect(f1.status).toBe(200);
    const f2 = await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w02@test.local", flagged: true }),
    });
    expect(f2.status).toBe(200);

    const unseen1 = (await (await api("/messages?filter=unseen")).json()) as {
      items: { messageId: string }[];
    };
    expect(unseen1.items.length).toBe(5);
    expect(unseen1.items.map((i) => i.messageId)).not.toContain("mid:w06@test.local");
    const flagged1 = (await (await api("/messages?filter=flagged")).json()) as {
      items: { messageId: string }[];
    };
    expect(flagged1.items.map((i) => i.messageId)).toEqual(["mid:w02@test.local"]);

    // 逗号组合（2026-10-04，前端「星标」视图 + 「未读」开关需要两个条件同时成立）：
    // 此刻 w02 未读且加星、w06 已读未加星 → unseen,flagged 只留 w02
    const both = (await (await api("/messages?filter=unseen,flagged")).json()) as {
      items: { messageId: string }[];
    };
    expect(both.items.map((i) => i.messageId)).toEqual(["mid:w02@test.local"]);
    // 搜索路径同样吃组合 filter
    const searchBoth = (await (
      await api("/messages?q=Digest&filter=unseen,flagged")
    ).json()) as { items: { messageId: string }[] };
    expect(searchBoth.items.map((i) => i.messageId)).toEqual(["mid:w02@test.local"]);

    // 搜索路径同样吃 filter 参数（搜索命中 w01，加星后仍在 flagged 结果里）
    await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w01@test.local", flagged: true }),
    });
    const searchFlagged = (await (
      await api("/messages?q=面试&filter=flagged")
    ).json()) as { items: { messageId: string }[] };
    expect(searchFlagged.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);

    // 恢复现场，避免影响后续用例
    await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w06@test.local", seen: false }),
    });
    await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w02@test.local", flagged: false }),
    });
    await api("/flags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId: "mid:w01@test.local", flagged: false }),
    });
  });

  it("账号列表带 INBOX 未读数（只算 INBOX，不算已发送）", async () => {
    const accounts = (await (await api("/accounts")).json()) as {
      id: string;
      unread: number;
    }[];
    const byId = new Map(accounts.map((a) => [a.id, a.unread]));
    expect(byId.get("acc1")).toBe(5);
    expect(byId.get("acc2")).toBe(2);
  });

  /**
   * 方向筛选（2026-10-04）：received = 有 INBOX 副本；sent = 副本**全部**在「已发送」类文件夹。
   * 方向（`direction`）与状态（`filter`）是两个互相独立的参数，可组合。
   * ⚠ 口径必须与前端 `isSentItem`（lib/mail/kind.ts）一致（同一份文件夹名名单，见 src/write.ts 的注释）。
   */
  it("方向筛选：received 只看有 INBOX 副本的，sent 只看副本全在「已发送」的", async () => {
    // 投一封到 acc1 的「已发送」（07.eml 的 From 是 test@local 自己）；列表走 SQL 路径，需先同步
    await deliverFixtures(dovecot, "test", "test", ["07.eml"], "Sent");
    await api("/sync", { method: "POST" });

    const received = (await (await api("/messages?direction=received")).json()) as {
      items: { messageId: string }[];
    };
    const sent = (await (await api("/messages?direction=sent")).json()) as {
      items: { messageId: string; copies: { accountId: string; folder: string; uid: number }[] }[];
    };
    // sent 只命中刚投的那封；种子邮件都有 INBOX 副本，不可能被判成发件
    expect(sent.items.map((i) => i.messageId)).toEqual(["mid:w07@test.local"]);
    expect(received.items.map((i) => i.messageId)).not.toContain("mid:w07@test.local");
    // received = 种子 6 封（w01..w06 都有 INBOX 副本）
    expect(received.items.length).toBe(6);

    // 组合筛选：方向与状态互相独立、可叠加——未读 + 发件 = 刚投的这封（未读、发件）
    const unseenSent = (await (await api("/messages?filter=unseen&direction=sent")).json()) as {
      items: { messageId: string }[];
    };
    expect(unseenSent.items.map((i) => i.messageId)).toEqual(["mid:w07@test.local"]);

    // 清理：IMAP 里删掉这封，索引行也直接清掉（两步都要）。
    // ⚠ 不能只删 IMAP 再 /sync：同步不做「删除检测」（只在 UIDVALIDITY 变化时重建索引），
    //   服务端删掉的信会留在索引里；正常删除走 webmaild 的 /delete（它连索引一起清）。
    //   测试里两步都做，确保不对后续用例留下任何残留（副本数、总数都不变）。
    const client = await connectUser(dovecot, "test", "test");
    try {
      await deleteUid(client, "Sent", sent.items[0].copies[0].uid);
    } finally {
      await client.logout().catch(() => {});
    }
    tc.ctx.db.prepare("DELETE FROM copies WHERE message_id = ?").run("mid:w07@test.local");
    tc.ctx.db.prepare("DELETE FROM messages WHERE message_id = ?").run("mid:w07@test.local");
    const after = (await (await api("/messages")).json()) as { items: { messageId: string }[] };
    expect(after.items.map((i) => i.messageId)).not.toContain("mid:w07@test.local");
    expect(after.items.length).toBe(6);
  });

  it("thread：按引用链双向组装，孤信自成一线，不存在返回 404", async () => {
    const t5 = (await (
      await api(`/message/${encodeURIComponent("mid:w05@test.local")}/thread`)
    ).json()) as { current: string; items: { messageId: string; date: string }[] };
    expect(t5.current).toBe("mid:w05@test.local");
    // 时间升序：w05（14:00）在前，w06（15:00）在后
    expect(t5.items.map((i) => i.messageId)).toEqual([
      "mid:w05@test.local",
      "mid:w06@test.local",
    ]);

    // 从回复端反向查，结果一致
    const t6 = (await (
      await api(`/message/${encodeURIComponent("mid:w06@test.local")}/thread`)
    ).json()) as { items: { messageId: string }[] };
    expect(t6.items.map((i) => i.messageId)).toEqual([
      "mid:w05@test.local",
      "mid:w06@test.local",
    ]);

    // 无引用链的信：会话只有自身
    const t1 = (await (
      await api(`/message/${encodeURIComponent("mid:w01@test.local")}/thread`)
    ).json()) as { items: { messageId: string }[] };
    expect(t1.items.map((i) => i.messageId)).toEqual(["mid:w01@test.local"]);

    const missing = await api(`/message/${encodeURIComponent("mid:nope@test.local")}/thread`);
    expect(missing.status).toBe(404);
  });

  it("通讯录 CRUD：新增 / 查重 409 / 非法邮箱 400 / 改名 / 删除", async () => {
    // 新增
    const created = (await (
      await api("/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "张三", email: "zhang@example.com", note: "校友" }),
      })
    ).json()) as { id: string; name: string; email: string };
    expect(created.id).toBeTruthy();

    // 重复邮箱（大小写不敏感）→ 409
    const dup = await api("/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "ZHANG@example.com" }),
    });
    expect(dup.status).toBe(409);

    // 非法邮箱 → 400
    const bad = await api("/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(bad.status).toBe(400);

    // 列表含新联系人
    const list = (await (await api("/contacts")).json()) as {
      items: { id: string; name: string }[];
    };
    expect(list.items.some((c) => c.id === created.id)).toBe(true);

    // 改名 + 改备注
    const updated = (await (
      await api(`/contacts/${created.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "张三（改名）" }),
      })
    ).json()) as { name: string };
    expect(updated.name).toBe("张三（改名）");

    // 改不存在的 id → 404
    const nope = await api("/contacts/non-existent", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(nope.status).toBe(404);

    // 删除 → 再删 404
    const del = await api(`/contacts/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const del2 = await api(`/contacts/${created.id}`, { method: "DELETE" });
    expect(del2.status).toBe(404);
  });

  it("自动收录：从 messages 现算通信对象，排除自己账号与已保存联系人", async () => {
    const known = (await (await api("/contacts/known")).json()) as {
      items: { name: string; email: string; times: number }[];
    };
    const emails = known.items.map((k) => k.email);
    //  fixture 里的外部发件人被收录
    expect(emails).toContain("zhang@example.com");
    expect(emails).toContain("alice@example.com");
    // 自己的账号地址不出现
    expect(emails).not.toContain("test@local");
    expect(emails).not.toContain("test2@local");
    // 显示名取自邮件头
    expect(known.items.find((k) => k.email === "zhang@example.com")?.name).toBe("张老师");

    // 保存进通讯录后从收录列表消失
    await api("/contacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
    });
    const known2 = (await (await api("/contacts/known")).json()) as {
      items: { email: string }[];
    };
    expect(known2.items.map((k) => k.email)).not.toContain("alice@example.com");

    // q 过滤
    const filtered = (await (await api("/contacts/known?q=zhang")).json()) as {
      items: { email: string }[];
    };
    expect(filtered.items.map((k) => k.email)).toEqual(["zhang@example.com"]);
  });

  it("suggest：已保存联系人在前，收录在后；空 query 返回空", async () => {
    // 上一条用例已保存 alice@example.com
    const s = (await (await api("/contacts/suggest?q=example")).json()) as {
      contacts: { email: string }[];
      known: { email: string }[];
    };
    expect(s.contacts.map((c) => c.email)).toContain("alice@example.com");
    expect(s.known.map((k) => k.email)).toContain("zhang@example.com");
    // 已保存的不会再出现在 known
    expect(s.known.map((k) => k.email)).not.toContain("alice@example.com");

    const empty = (await (await api("/contacts/suggest?q=")).json()) as {
      contacts: unknown[];
      known: unknown[];
    };
    expect(empty.contacts).toEqual([]);
    expect(empty.known).toEqual([]);
  });

  it("列表与详情：通讯录里的名字覆盖邮件头显示名，detail 带 fromContactId", async () => {
    // alice@example.com 已在通讯录（上条用例），名字 Alice
    const list = (await (await api("/messages?q=Project")).json()) as {
      items: { messageId: string; fromAddr: string; fromName: string }[];
    };
    const w05 = list.items.find((i) => i.messageId === "mid:w05@test.local");
    expect(w05?.fromAddr).toBe("alice@example.com");
    expect(w05?.fromName).toBe("Alice");

    const detail = (await (
      await api(`/message/${encodeURIComponent("mid:w05@test.local")}`)
    ).json()) as { fromName: string; fromContactId: string | null };
    expect(detail.fromName).toBe("Alice");
    expect(detail.fromContactId).toBeTruthy();

    // 未保存的发件人：fromContactId 为 null
    const other = (await (
      await api(`/message/${encodeURIComponent("mid:w01@test.local")}`)
    ).json()) as { fromContactId: string | null };
    expect(other.fromContactId).toBeNull();
  });

  it("草稿：创建 / 缺省字段保持原值 / 列表倒序 / 删除幂等 / 404", async () => {
    // 创建（回复态草稿：带 kindRef 与引用链）
    const created = (await (
      await api("/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "reply",
          kindRef: "mid:w01@test.local",
          accountId: "acc1",
          to: "a@example.com",
          subject: "草稿一",
          body: "写了一半",
          readReceipt: true,
          inReplyTo: "<w01@test.local>",
          references: ["<w01@test.local>"],
        }),
      })
    ).json()) as {
      id: string;
      kind: string;
      readReceipt: boolean;
      references: string[];
      kindRef: string;
    };
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe("reply");
    expect(created.kindRef).toBe("mid:w01@test.local");
    expect(created.readReceipt).toBe(true);
    expect(created.references).toEqual(["<w01@test.local>"]);

    // 更新：只传部分字段，缺省 = 保持原值（整体替换语义）
    const updated = (await (
      await api(`/drafts/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "草稿一（改）", to: "a@example.com, b@example.com" }),
      })
    ).json()) as { subject: string; to: string; readReceipt: boolean; kind: string };
    expect(updated.subject).toBe("草稿一（改）");
    expect(updated.to).toBe("a@example.com, b@example.com");
    expect(updated.readReceipt).toBe(true);
    expect(updated.kind).toBe("reply");

    // 第二封 → 列表按最近更新倒序（新的在前）
    const second = (await (
      await api("/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "草稿二" }),
      })
    ).json()) as { id: string };
    const list = (await (await api("/drafts")).json()) as { items: { id: string }[] };
    expect(list.items.map((d) => d.id)).toEqual([second.id, created.id]);

    // 更新不存在的 → 404
    const nope = await api("/drafts/non-existent", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "x" }),
    });
    expect(nope.status).toBe(404);

    // 删除幂等（发送成功后的清理不因草稿已被删而失败）
    expect((await api(`/drafts/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/drafts/${created.id}`, { method: "DELETE" })).status).toBe(200);
    const after = (await (await api("/drafts")).json()) as { items: { id: string }[] };
    expect(after.items.map((d) => d.id)).toEqual([second.id]);
    // 清理（不影响后续断言，两个用例共享后端）
    await api(`/drafts/${second.id}`, { method: "DELETE" });
  });
});
