import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleParser } from "mailparser";
import { loadAccounts, loadCredentials } from "../src/config.js";
import { openDb, type Db } from "../src/db.js";
import { fetchSource, openReadOnly, connectAccount } from "../src/imap.js";
import type { AccountConfig, AccountCredential } from "../src/types.js";
import { deliverRaw, startDovecot, waitReady, workRoot, type DovecotHandle } from "./dovecot.js";

/**
 * 附件门控：超阈值邮件同步时**不下载附件**（2026-10-08，用户定的策略）。
 *
 * 这里用真实 Dovecot（真 BODYSTRUCTURE / 真部件 FETCH）验证四件事：
 * 1. 附件字节**确实没下载**（存下来的 .eml 里找不到附件载荷）；
 * 2. 正文与内嵌图（cid）**照常可读**（拼出来的精简原文能被 mailparser 解析）；
 * 3. `attachments_json` 清单里的**序号与整封解析一致**——这是「点第 2 个附件不能拿到
 *    第 3 个文件」的硬约束（补取整封之后序号还得对得上）；
 * 4. 只有大正文、没有附件的邮件也走这条路，且正文完整。
 *
 * ⚠ 环境变量必须在 import fetcher 之前设置（门控常量在模块加载时读取）。
 */
process.env.MAIL_AGENT_MAX_SOURCE_BYTES = "102400"; // 100KB
const { syncAccount } = await import("../src/fetcher.js");

/** 造一封 multipart/mixed：正文 + 一个超大 base64 附件 */
function mixedFixture(marker: string, attachmentBytes: number): Buffer {
  const payload = Buffer.alloc(attachmentBytes, "A").toString("base64");
  return Buffer.from(
    [
      "From: a@b.c",
      "To: me@x.y",
      `Subject: big attachment ${marker}`,
      "Date: Fri, 25 Sep 2026 16:00:00 +0800",
      `Message-ID: <partial-${marker}@test.local>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b1"',
      "",
      "--b1",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `see attached big body ${marker}`,
      "",
      "--b1",
      'Content-Type: application/octet-stream; name="blob.bin"',
      'Content-Disposition: attachment; filename="blob.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      payload,
      "",
      "--b1--",
      "",
    ].join("\r\n"),
    "utf8"
  );
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);

/** multipart/related：HTML 正文 + cid 内嵌图 + 一个大附件 */
function relatedFixture(marker: string, attachmentBytes: number): Buffer {
  const payload = Buffer.alloc(attachmentBytes, "B").toString("base64");
  return Buffer.from(
    [
      "From: news@x.y",
      "To: me@x.y",
      `Subject: newsletter ${marker}`,
      "Date: Fri, 25 Sep 2026 17:00:00 +0800",
      `Message-ID: <related-${marker}@test.local>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/related; boundary="b2"',
      "",
      "--b2",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `<p>hello ${marker}</p><img src="cid:logo@test.local">`,
      "",
      "--b2",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      "Content-ID: <logo@test.local>",
      'Content-Disposition: inline; filename="logo.png"',
      "",
      PNG.toString("base64"),
      "",
      "--b2",
      'Content-Type: application/pdf; name="doc.pdf"',
      'Content-Disposition: attachment; filename="doc.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      payload,
      "",
      "--b2--",
      "",
    ].join("\r\n"),
    "utf8"
  );
}

/**
 * 真机 QQ 的形状（2026-10-08 探测出来的）：`multipart/mixed` 里嵌 `multipart/alternative`，
 * 容器**也带 part 编号**（`part: "1"`）。容器不是内容部件，绝不能进附件清单——
 * 否则清单里会多出幻影项，后面所有附件的序号整体错位。
 */
function nestedFixture(marker: string, attachmentBytes: number): Buffer {
  const payload = Buffer.alloc(attachmentBytes, "C").toString("base64");
  return Buffer.from(
    [
      "From: nested@x.y",
      "To: me@x.y",
      `Subject: nested ${marker}`,
      "Date: Fri, 25 Sep 2026 19:00:00 +0800",
      `Message-ID: <nested-${marker}@test.local>`,
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `plain body ${marker}`,
      "",
      "--inner",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      `<p>html body ${marker}</p>`,
      "",
      "--inner--",
      "",
      "--outer",
      'Content-Type: application/octet-stream; name="big.bin"',
      'Content-Disposition: attachment; filename="big.bin"',
      "Content-Transfer-Encoding: base64",
      "",
      payload,
      "",
      "--outer--",
      "",
    ].join("\r\n"),
    "utf8"
  );
}

/** 只有大正文、没有附件：走同一条路，正文必须完整 */
function bigBodyFixture(marker: string, bytes: number): Buffer {
  const body = `start-${marker} ` + "x".repeat(bytes) + ` end-${marker}`;
  return Buffer.from(
    [
      "From: digest@x.y",
      "To: me@x.y",
      `Subject: big body ${marker}`,
      "Date: Fri, 25 Sep 2026 18:00:00 +0800",
      `Message-ID: <bigbody-${marker}@test.local>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      body,
      "",
    ].join("\r\n"),
    "utf8"
  );
}

let handle: DovecotHandle;
let db: Db;
let dataDir: string;
let account: AccountConfig;
let cred: AccountCredential;

const readEml = (rel: string) => readFileSync(join(dataDir, rel));

beforeAll(async () => {
  handle = startDovecot("partial");
  await waitReady(handle);
  await deliverRaw(handle, [
    mixedFixture("m1", 200 * 1024),
    relatedFixture("r1", 150 * 1024),
    bigBodyFixture("b1", 200 * 1024),
    nestedFixture("n1", 180 * 1024),
  ]);

  dataDir = join(workRoot, "db-partial");
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
  await syncAccount(db, dataDir, account, cred);
}, 180_000);

afterAll(() => {
  db?.close();
  handle?.cleanup();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

interface Row {
  message_id: string;
  truncated: number;
  eml_path: string;
  size: number;
  attachments_json: string | null;
}

/** 按库键（`mid:<裸 Message-ID 小写>`）取行 */
function rowOfId(id: string): Row {
  return db
    .prepare(
      "SELECT message_id, truncated, eml_path, size, attachments_json FROM messages WHERE message_id = ?"
    )
    .get(id) as Row;
}
const rowOfMixed = (m: string) => rowOfId(`mid:partial-${m}@test.local`);
const rowOfRelated = (m: string) => rowOfId(`mid:related-${m}@test.local`);
const rowOfBigBody = (m: string) => rowOfId(`mid:bigbody-${m}@test.local`);
const rowOfNested = (m: string) => rowOfId(`mid:nested-${m}@test.local`);

describe("附件门控：超阈值邮件的附件不下载，正文与内嵌图照常可读", () => {
  it("multipart/mixed：正文在、附件不在（字节层面确认），清单标成 deferred", async () => {
    const row = rowOfMixed("m1");
    expect(row.truncated, "精简原文也是 truncated=1（本地不是完整原件）").toBe(1);
    expect(row.eml_path, "但有本地原文（靠 eml_path 与「只有索引」区分）").not.toBe("");
    const raw = readEml(row.eml_path);
    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe("see attached big body m1");
    expect(parsed.attachments, "附件没有随同步下载").toHaveLength(0);
    // ⚠ 字节层面：存的原文里绝不能出现附件载荷（base64 的连续 "QUFB"）
    expect(raw.includes("QUFBQUFBQUFBQUFB"), "存下来的原文里不该有附件载荷").toBe(false);

    const manifest = JSON.parse(row.attachments_json ?? "[]") as {
      index: number;
      filename: string;
      deferred: boolean;
      contentType: string;
      part?: string;
    }[];
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ index: 0, filename: "blob.bin", deferred: true });
    expect(manifest[0].contentType).toBe("application/octet-stream");
    expect(manifest[0].part).toBeTruthy();
    // size 记的是**原始大小**（元数据里的 RFC822.SIZE），不是精简后的字节数
    expect(row.size).toBeGreaterThan(raw.length);
  });

  it("multipart/related：HTML 正文可读、cid 内嵌图已留存，真附件推迟", async () => {
    const row = rowOfRelated("r1");
    const raw = readEml(row.eml_path);
    const parsed = await simpleParser(raw, { keepCidLinks: true });
    expect(parsed.html).toContain("hello r1");
    expect(parsed.html).toContain("cid:logo@test.local");
    // 内嵌图在（作为附件被 mailparser 列出来，带 cid）
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].cid).toBe("logo@test.local");
    expect(parsed.attachments[0].content.subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    // 真附件（pdf）没下载
    expect(raw.includes("QkJCQkJCQkJCQkI"), "pdf 载荷不该出现").toBe(false);

    const manifest = JSON.parse(row.attachments_json ?? "[]") as {
      index: number;
      filename: string;
      deferred: boolean;
      inline: boolean;
      cid: string | null;
    }[];
    expect(manifest.map((m) => [m.index, m.filename, m.deferred, m.inline])).toEqual([
      [0, "logo.png", false, true],
      [1, "doc.pdf", true, false],
    ]);
    expect(manifest[0].cid).toBe("<logo@test.local>");
  });

  it("只有大正文的邮件：正文完整、清单为空", async () => {
    const row = rowOfBigBody("b1");
    const raw = readEml(row.eml_path);
    const parsed = await simpleParser(raw);
    expect(parsed.text).toContain("start-b1");
    expect(parsed.text).toContain("end-b1");
    expect(parsed.text!.length).toBeGreaterThan(200 * 1024);
    expect(parsed.attachments).toHaveLength(0);
    expect(JSON.parse(row.attachments_json ?? "[]")).toEqual([]);
  });

  it("嵌套结构（mixed > alternative，容器带 part 号）：正文 text+html 都在，清单里没有幻影项", async () => {
    const row = rowOfNested("n1");
    const raw = readEml(row.eml_path);
    const parsed = await simpleParser(raw);
    expect(parsed.text?.trim()).toBe("plain body n1");
    expect(parsed.html).toContain("html body n1");
    const manifest = JSON.parse(row.attachments_json ?? "[]") as {
      index: number;
      filename: string;
      deferred: boolean;
      contentType: string;
    }[];
    // ⚠ 真机 QQ 的坑：容器部件（multipart/alternative，也有 part 号）**不能**进清单，
    //   否则它的序号会占掉 0，真附件被推到 1 —— 与整封解析的序号就不一致了
    expect(manifest.map((m) => [m.index, m.filename, m.deferred])).toEqual([
      [0, "big.bin", true],
    ]);
    expect(raw.includes("Q0NDQ0NDQ0NDQ0M"), "附件载荷不该出现").toBe(false);
  });

  it("agent 侧：read_message 给清单，get_attachment 按需取回并解码", async () => {
    const { readMessage, getAttachment } = await import("../src/reader.js");
    const ctx = { db, dataDir, accounts: [account], creds: { [account.id]: cred } };

    const msg = await readMessage(db, dataDir, "mid:partial-m1@test.local");
    expect(msg.text).toContain("see attached big body m1");
    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments[0]).toMatchObject({ filename: "blob.bin", deferred: true });

    // 被推迟的附件：当场按部件号向邮箱取一次，并按 base64 解码（不是把 base64 文本给出去）
    const att = await getAttachment(ctx, "mid:partial-m1@test.local", 0);
    expect(att.contentType).toBe("application/octet-stream");
    const buf = Buffer.from(att.contentBase64, "base64");
    expect(buf.length).toBe(200 * 1024);
    expect(buf.toString("utf8")).toBe("A".repeat(200 * 1024));

    // 已留存的内嵌图：从本地精简原文按 cid 取，不连邮箱
    const related = await readMessage(db, dataDir, "mid:related-r1@test.local");
    expect(related.attachments.map((a) => [a.filename, a.deferred])).toEqual([
      ["logo.png", false],
      ["doc.pdf", true],
    ]);
    const inline = await getAttachment(ctx, "mid:related-r1@test.local", 0);
    expect(Buffer.from(inline.contentBase64, "base64").subarray(0, 4)).toEqual(PNG.subarray(0, 4));

    // 只存索引的邮件：读正文要给出明确错误，而不是静默返回空
    await expect(readMessage(db, dataDir, "mid:missing@test.local")).rejects.toThrow();
  });

  it("清单序号与**整封**解析的附件序号一致（补取整封后不会点错文件）", async () => {
    const client = await connectAccount(account, cred);
    try {
      await openReadOnly(client, "INBOX");
      const uids = (
        db.prepare("SELECT uid FROM copies WHERE folder = 'INBOX' ORDER BY uid").all() as {
          uid: number;
        }[]
      ).map((r) => r.uid);
      const full = new Map<string, { filename: string; size: number }[]>();
      for (const uid of uids) {
        const raw = await fetchSource(client, uid);
        const parsed = await simpleParser(raw!);
        const subject = parsed.subject ?? "";
        full.set(
          subject,
          parsed.attachments.map((a) => ({ filename: a.filename ?? "", size: a.size }))
        );
      }
      for (const marker of ["m1", "r1", "n1"]) {
        for (const kind of ["partial", "related", "nested"]) {
          const subject =
            kind === "partial"
              ? `big attachment ${marker}`
              : kind === "related"
                ? `newsletter ${marker}`
                : `nested ${marker}`;
          const whole = full.get(subject);
          if (!whole) continue;
          const row =
            kind === "partial"
              ? rowOfMixed(marker)
              : kind === "related"
                ? rowOfRelated(marker)
                : rowOfNested(marker);
          const manifest = JSON.parse(row.attachments_json ?? "[]") as {
            index: number;
            filename: string;
          }[];
          expect(
            manifest.map((m) => m.filename),
            `${subject} 的清单序号必须与整封解析一致`
          ).toEqual(whole.map((a) => a.filename));
        }
      }
    } finally {
      await client.logout().catch(() => {});
    }
  });
});
