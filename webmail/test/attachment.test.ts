import { describe, expect, it } from "vitest";
import {
  asciiFilename,
  baseContentType,
  isInlineSafe,
  resolveAttachmentHeaders,
} from "../src/attachment.js";

/**
 * 附件响应头决策（2026-10-07 安全加固）。
 *
 * 这组用例是**纯函数**测试，不需要 Dovecot/容器——加固的核心判断（哪些类型可以
 * 原样 inline、哪些必须降级）都在 `attachment.ts` 里，回归成本为零。
 * 端到端的字节与状态码断言仍在 api.test.ts（需要容器）。
 */
describe("附件响应头（安全加固）", () => {
  it("inline 的 text/html 附件必须降级：发信人不能借它在站点源上执行脚本", () => {
    const h = resolveAttachmentHeaders({
      contentType: "text/html; charset=utf-8",
      filename: "invoice.html",
      inline: true,
    });
    expect(h.contentType).toBe("application/octet-stream");
    expect(h.contentDisposition).toContain("attachment");
    expect(h.contentDisposition).not.toContain("inline");
  });

  it("inline 的 SVG 同样降级（SVG 顶层文档会执行脚本）", () => {
    const h = resolveAttachmentHeaders({
      contentType: "image/svg+xml",
      filename: "logo.svg",
      inline: true,
    });
    expect(h.contentType).toBe("application/octet-stream");
    expect(h.contentDisposition).toContain("attachment");
  });

  it("远程可执行类类型一律降级（xml / javascript / xhtml）", () => {
    for (const type of [
      "application/xhtml+xml",
      "application/xml",
      "text/xml",
      "application/javascript",
      "text/javascript",
      "application/x-shockwave-flash",
      "multipart/x-mixed-replace",
    ]) {
      const h = resolveAttachmentHeaders({ contentType: type, filename: "a.bin", inline: true });
      expect(h.contentType, type).toBe("application/octet-stream");
      expect(h.contentDisposition, type).toContain("attachment");
    }
  });

  it("白名单内的图片保留原类型并可 inline（cid 内嵌图靠这条渲染）", () => {
    const h = resolveAttachmentHeaders({
      contentType: "image/png",
      filename: "pixel.png",
      inline: true,
    });
    expect(h.contentType).toBe("image/png");
    expect(h.contentDisposition).toContain("inline");
  });

  it("带参数的 Content-Type 取主类型；非 inline 的图片仍是下载", () => {
    const h = resolveAttachmentHeaders({
      contentType: "image/jpeg; name=\"photo.jpg\"",
      filename: "photo.jpg",
      inline: false,
    });
    expect(h.contentType).toBe("image/jpeg");
    expect(h.contentDisposition).toContain("attachment");
  });

  it("纯文本附件保留 text/plain（既有 api 用例的 report.txt 靠这条）", () => {
    const h = resolveAttachmentHeaders({
      contentType: "text/plain; charset=UTF-8",
      filename: "report.txt",
      inline: false,
    });
    expect(h.contentType).toBe("text/plain");
    expect(h.contentDisposition).toContain("attachment");
  });

  it("缺失/畸形 Content-Type 不报错，按二进制处理", () => {
    for (const bad of [undefined, null, "", "not-a-mime", "text/html; charset=", "  "]) {
      const h = resolveAttachmentHeaders({ contentType: bad, filename: "x", inline: true });
      expect(h.contentType).toBe("application/octet-stream");
      expect(h.contentDisposition).toContain("attachment");
    }
  });

  it("所有附件响应都带 nosniff 与 sandbox CSP", () => {
    for (const input of [
      { contentType: "image/png", filename: "a.png", inline: true },
      { contentType: "text/html", filename: "a.html", inline: true },
      { contentType: undefined, filename: "a", inline: false },
    ]) {
      const h = resolveAttachmentHeaders(input);
      expect(h.extraHeaders["x-content-type-options"]).toBe("nosniff");
      expect(h.extraHeaders["content-security-policy"]).toContain("sandbox");
    }
  });

  it("文件名剥掉 CR/LF 与引号，响应头不会被注入", () => {
    const h = resolveAttachmentHeaders({
      contentType: "text/plain",
      filename: 'evil\r\nX-Injected: 1"; drop.txt',
      inline: false,
    });
    expect(h.contentDisposition).not.toMatch(/[\r\n]/);
    expect(h.contentDisposition).toContain('filename="evilX-Injected: 1; drop.txt"');
    // filename* 走 encodeURIComponent，同样不含裸 CR/LF
    expect(h.contentDisposition).toContain("filename*=UTF-8''");
  });

  it("文件名缺失时回退为 attachment（不产生空 filename）", () => {
    const h = resolveAttachmentHeaders({ contentType: "text/plain", filename: null, inline: false });
    expect(h.contentDisposition).toContain('filename="attachment"');
  });

  it("baseContentType / isInlineSafe 的边界", () => {
    expect(baseContentType("IMAGE/PNG")).toBe("image/png");
    expect(baseContentType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(baseContentType("garbage")).toBeNull();
    expect(isInlineSafe("image/webp")).toBe(true);
    expect(isInlineSafe("image/svg+xml")).toBe(false);
    expect(isInlineSafe("image/svg+xml; charset=utf-8")).toBe(false);
  });

  it("asciiFilename 只留可打印字符", () => {
    expect(asciiFilename('a"b\\c\u0000d')).toBe("abcd");
    expect(asciiFilename("   ")).toBe("attachment");
  });
});
