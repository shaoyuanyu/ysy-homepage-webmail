import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { createApiServer } from "../src/api.js";
import { makeContext, type TestContext } from "./context.js";
import { connectUser, startDovecot, waitReady, type DovecotHandle } from "./dovecot.js";
import { startSmtpSink, type SmtpSink } from "./smtp-sink.js";

/** 无 Sent 邮箱的配置（验证「找不到已发送文件夹则拒发」） */
const PLAIN_CONF = `protocols = imap
listen = *
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login
mail_location = maildir:/srv/mail/%u
mail_privileged_group = mail
namespace inbox {
  inbox = yes
}
passdb {
  driver = passwd-file
  args = /etc/dovecot/users
}
userdb {
  driver = static
  args = uid=1000 gid=1000 home=/srv/mail/%u
}
log_path = /dev/stderr
`;

describe("webmaild 发信", () => {
  describe("正常路径", () => {
    let dovecot: DovecotHandle;
    let sink: SmtpSink;
    let tc: TestContext;
    let server: Server;
    let base: string;

    beforeAll(async () => {
      dovecot = startDovecot("send");
      await waitReady(dovecot);
      sink = await startSmtpSink();
      tc = makeContext(dovecot, sink.port, "send");
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

    it("SMTP 发出与 APPEND 留底是同一份字节，Message-ID 一致（红线 6）", async () => {
      const res = await fetch(`${base}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "acc1",
          to: ["someone@example.org"],
          subject: "第一封测试信",
          text: "正文内容",
        }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { messageId: string; sentFolder: string };
      expect(result.messageId).toMatch(/^<.+@local>$/);
      expect(result.sentFolder).toBe("Sent");

      // SMTP 接收端收到一封，Message-ID 与返回值一致
      expect(sink.received.length).toBe(1);
      const smtpRaw = sink.received[0];
      const smtpParsed = await simpleParser(smtpRaw);
      expect(smtpParsed.messageId).toBe(result.messageId);
      expect(smtpParsed.subject).toBe("第一封测试信");

      // IMAP 侧「已发送」里留底的字节与 SMTP 收到的逐字节一致
      const client = await connectUser(dovecot, "test", "test");
      try {
        await client.mailboxOpen("Sent", { readOnly: true });
        const uids = (await client.search({}, { uid: true })) || [];
        expect(uids.length).toBe(1);
        const msg = await client.fetchOne(String(uids[0]), { uid: true, source: true }, { uid: true });
        if (!msg || !msg.source) throw new Error("Sent 里取不到留底邮件");
        const appended = msg.source as Buffer;
        expect(appended.equals(smtpRaw)).toBe(true);
      } finally {
        await client.logout().catch(() => {});
      }

      // 同步后本地索引出现该消息（副本在 Sent）
      await fetch(`${base}/sync`, { method: "POST" });
      const list = (await (await fetch(`${base}/messages`)).json()) as {
        items: { messageId: string; copies: { folder: string }[]; subject: string }[];
      };
      const sent = list.items.find((i) => i.subject === "第一封测试信");
      expect(sent).toBeDefined();
      expect(sent!.copies.some((c) => c.folder === "Sent")).toBe(true);
    });

    it("非法收件地址被拒", async () => {
      const before = sink.received.length;
      const res = await fetch(`${base}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "acc1", to: ["not-an-address"], subject: "x" }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("非法地址");
      expect(sink.received.length).toBe(before);
    });
  });

  describe("找不到「已发送」文件夹", () => {
    let dovecot: DovecotHandle;
    let sink: SmtpSink;
    let tc: TestContext;
    let server: Server;
    let base: string;

    beforeAll(async () => {
      dovecot = startDovecot("send-nosent", PLAIN_CONF);
      await waitReady(dovecot);
      sink = await startSmtpSink();
      tc = makeContext(dovecot, sink.port, "send-nosent");
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

    it("拒发且 SMTP 不发出（先探测后发信）", async () => {
      const res = await fetch(`${base}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accountId: "acc1",
          to: ["someone@example.org"],
          subject: "x",
          text: "x",
        }),
      });
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("已发送");
      expect(sink.received.length).toBe(0);
    });
  });
});
