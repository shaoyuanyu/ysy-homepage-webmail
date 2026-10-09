import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import {
  buildTrimmedSource,
  collectPartIds,
  isKeptPart,
  planParts,
  pruneTree,
  stripStructureHeaders,
  type AttachmentEntry,
} from "../src/mime.js";
import type { PartLeaf, StructureNode } from "../src/imap.js";

/**
 * 精简原文（附件门控）的拼装逻辑（2026-10-08）。
 *
 * 这层是纯函数，也是最容易出「正文乱码 / 丢图 / 附件序号错位」的地方，所以单测直接
 * 拿拼出来的字节**再用 mailparser 解析一遍**，断言正文、内嵌图、附件清单都对得上。
 */

function leaf(over: Partial<PartLeaf> & { part: string }): PartLeaf {
  return {
    type: "application/octet-stream",
    encoding: "base64",
    size: 100,
    id: null,
    disposition: null,
    filename: null,
    parameters: {},
    ...over,
  };
}

describe("isKeptPart：正文与内嵌图保留，附件丢弃", () => {
  it("正文部件（text/plain、text/html）保留", () => {
    expect(isKeptPart(leaf({ part: "1", type: "text/plain", encoding: "8bit" }))).toBe(true);
    expect(isKeptPart(leaf({ part: "2", type: "text/html", encoding: "quoted-printable" }))).toBe(true);
  });

  it("显式 attachment 一律丢——哪怕它是 text/plain（比如 text/csv 那种文本附件）", () => {
    expect(
      isKeptPart(leaf({ part: "2", type: "text/plain", disposition: "attachment", filename: "a.txt" }))
    ).toBe(false);
    expect(isKeptPart(leaf({ part: "3", type: "text/csv", disposition: "attachment" }))).toBe(false);
  });

  it("内嵌图保留：有 Content-ID 或 disposition=inline 的图片", () => {
    expect(isKeptPart(leaf({ part: "2", type: "image/png", id: "<img1@x>" }))).toBe(true);
    expect(isKeptPart(leaf({ part: "3", type: "image/jpeg", disposition: "inline" }))).toBe(true);
    // 既没有 cid 也没声明 inline 的图片：当成附件（推迟）
    expect(isKeptPart(leaf({ part: "4", type: "image/gif" }))).toBe(false);
  });

  it("其它一律丢：pdf / 压缩包 / 附带的 .eml", () => {
    expect(isKeptPart(leaf({ part: "5", type: "application/pdf", disposition: "attachment" }))).toBe(false);
    expect(isKeptPart(leaf({ part: "6", type: "message/rfc822" }))).toBe(false);
  });
});

describe("planParts：附件序号必须与整封解析一致", () => {
  it("正文不占序号，内嵌图与真附件按出现顺序各占一个", () => {
    const leaves = [
      leaf({ part: "1", type: "text/plain", encoding: "7bit", size: 10 }),
      leaf({ part: "2", type: "image/png", id: "<inline1@x>", size: 20 }),
      leaf({ part: "3", type: "application/pdf", disposition: "attachment", filename: "p.pdf", size: 30 }),
    ];
    const { keep, attachments } = planParts(leaves);
    expect(keep.map((k) => k.part)).toEqual(["1", "2"]);
    expect(attachments.map((a) => [a.index, a.filename, a.inline])).toEqual([
      [0, "attachment-0", true],
      [1, "p.pdf", false],
    ]);
    // 部件号带着，按需取附件时用
    expect(attachments[1].part).toBe("3");
  });

  it("没有附件时清单为空（正文照常保留）", () => {
    const { keep, attachments } = planParts([
      leaf({ part: "1", type: "text/plain", encoding: "7bit" }),
      leaf({ part: "2", type: "text/html", encoding: "7bit" }),
    ]);
    expect(keep).toHaveLength(2);
    expect(attachments).toEqual([]);
  });
});

describe("stripStructureHeaders：只摘掉 MIME 结构头，其余逐行原样", () => {
  it("去掉 Content-Type / CTE / Content-Disposition / MIME-Version（含折行续行）", () => {
    const raw = [
      "From: a@b.c",
      "Subject: =?UTF-8?B?5rWL6K+V?=",
      "Content-Type: multipart/mixed;",
      ' boundary="abc"',
      "MIME-Version: 1.0",
      "Content-Transfer-Encoding: 8bit",
      "Received: from x by y; Fri, 25 Sep 2026 16:00:00 +0800",
    ].join("\r\n");
    const out = stripStructureHeaders(raw);
    expect(out).toBe(
      [
        "From: a@b.c",
        "Subject: =?UTF-8?B?5rWL6K+V?=",
        "Received: from x by y; Fri, 25 Sep 2026 16:00:00 +0800",
      ].join("\r\n")
    );
  });
});

describe("buildTrimmedSource：拼出来的字节必须还能被解析成那封信", () => {
  it("单部件：顶层就是正文本身", async () => {
    const root: StructureNode = { part: "1", type: "text/plain", encoding: "8bit", size: 10, parameters: { charset: "utf-8" } };
    const tree = pruneTree(root)!;
    expect(collectPartIds(tree)).toEqual(["1"]);
    const src = buildTrimmedSource({
      topHeaders: Buffer.from("From: a@b.c\r\nSubject: hi\r\nContent-Type: text/plain\r\n", "utf8"),
      tree,
      payloads: new Map([["1", Buffer.from("hello body", "utf8")]]),
    });
    const parsed = await simpleParser(src);
    expect(parsed.subject).toBe("hi");
    expect(parsed.text?.trim()).toBe("hello body");
    expect(parsed.attachments).toHaveLength(0);
  });

  it("多部件（正文 + 内嵌图）：容器类型保真、cid 保留、附件不在", async () => {
    const html = '<p>hi</p><img src="cid:img1@x">';
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const root: StructureNode = {
      type: "multipart/related",
      parameters: { boundary: "orig" },
      childNodes: [
        { part: "1", type: "text/html", encoding: "8bit", size: html.length, parameters: { charset: "utf-8" } },
        {
          part: "2",
          type: "image/png",
          encoding: "base64",
          size: 16,
          id: "<img1@x>",
          disposition: "inline",
          dispositionParameters: { filename: "图 1.png" },
        },
        { part: "3", type: "application/pdf", encoding: "base64", size: 999, disposition: "attachment" },
      ],
    };
    const tree = pruneTree(root)!;
    expect(collectPartIds(tree)).toEqual(["1", "2"]);
    const src = buildTrimmedSource({
      topHeaders: Buffer.from(
        'From: a@b.c\r\nSubject: with inline\r\nContent-Type: multipart/related; boundary="orig"\r\n',
        "utf8"
      ),
      tree,
      payloads: new Map([
        ["1", Buffer.from(html, "utf8")],
        ["2", Buffer.from(png.toString("base64"), "utf8")],
      ]),
    });
    const parsed = await simpleParser(src, { keepCidLinks: true });
    expect(parsed.subject).toBe("with inline");
    expect(parsed.html).toContain("cid:img1@x");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].cid).toBe("img1@x");
    expect(parsed.attachments[0].content.subarray(0, 4)).toEqual(png.subarray(0, 4));
    // 非 ASCII 文件名按 RFC 2231 编码，解析回来还是原文
    expect(parsed.attachments[0].filename).toBe("图 1.png");
  });

  it("没有可保留的部件 → 剪枝结果为空（调用方据此回退成整封下载）", () => {
    const onlyAttachment: StructureNode = {
      part: "1",
      type: "application/pdf",
      encoding: "base64",
      disposition: "attachment",
    };
    expect(pruneTree(onlyAttachment)).toBeNull();
  });

  it("部件没取全时抛错（宁可回退整封，也不拼一封缺正文的信）", () => {
    const tree = pruneTree({ part: "1", type: "text/plain", encoding: "8bit" })!;
    expect(() =>
      buildTrimmedSource({ topHeaders: Buffer.from("From: a@b.c\r\n"), tree, payloads: new Map() })
    ).toThrow();
  });
});

describe("嵌套结构：容器层次必须保真（真机 QQ 形状）", () => {
  it("multipart/mixed > multipart/alternative：text 与 html 都要留下，容器不被当成附件", async () => {
    const root: StructureNode = {
      type: "multipart/mixed",
      parameters: { boundary: "outer" },
      childNodes: [
        {
          part: "1",
          type: "multipart/alternative",
          parameters: { boundary: "inner" },
          childNodes: [
            { part: "1.1", type: "text/plain", encoding: "8bit", size: 5, parameters: { charset: "utf-8" } },
            { part: "1.2", type: "text/html", encoding: "8bit", size: 9, parameters: { charset: "utf-8" } },
          ],
        },
        { part: "2", type: "application/octet-stream", encoding: "base64", size: 99, disposition: "attachment", dispositionParameters: { filename: "big.bin" } },
      ],
    };
    const tree = pruneTree(root)!;
    expect(collectPartIds(tree)).toEqual(["1.1", "1.2"]);
    const src = buildTrimmedSource({
      topHeaders: Buffer.from("From: a@b.c\r\nSubject: nested\r\n", "utf8"),
      tree,
      payloads: new Map([
        ["1.1", Buffer.from("plain", "utf8")],
        ["1.2", Buffer.from("<p>html</p>", "utf8")],
      ]),
    });
    const parsed = await simpleParser(src);
    // ⚠ 拍平成 multipart/mixed 的话，这里 text 会变成 "plain\n\n<p>html</p>"、html 为空
    expect(parsed.text?.trim()).toBe("plain");
    expect(parsed.html).toBe("<p>html</p>");
    expect(parsed.attachments).toHaveLength(0);
    // 清单里也不该有容器幻影项
    const { attachments } = planParts([
      leaf({ part: "1.1", type: "text/plain", encoding: "8bit", size: 5 }),
      leaf({ part: "1.2", type: "text/html", encoding: "8bit", size: 9 }),
      leaf({ part: "2", type: "application/octet-stream", encoding: "base64", size: 99, disposition: "attachment", filename: "big.bin" }),
    ]);
    expect(attachments.map((a) => [a.index, a.filename])).toEqual([[0, "big.bin"]]);
  });
});

describe("清单类型", () => {
  it("deferred 是抓取侧最后填的字段（mime 层只产出候选）", () => {
    const entries: Omit<AttachmentEntry, "deferred">[] = planParts([
      leaf({ part: "1", type: "text/plain", encoding: "7bit" }),
      leaf({ part: "2", type: "application/zip", disposition: "attachment", filename: "a.zip" }),
    ]).attachments;
    expect(entries[0].part).toBe("2");
  });
});
