import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 3.2 / 3.8 审查项的机器化：mail/ 包内「写调用只有一个落点」保持字面成立。
 * 扫源码文本而非行为——这些是「代码里不出现」级别的承诺。
 * 新增写能力时必须更新这里的白名单，让审查点显式化。
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const sources = readdirSync(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, code: readFileSync(join(srcDir, f), "utf8") }));

function hits(pattern: RegExp): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const { file, code } of sources) {
    code.split("\n").forEach((text, i) => {
      if (pattern.test(text)) out.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return out;
}

describe("源码审查：写调用的唯一落点（3.2 / 3.8）", () => {
  it("STORE（messageFlags*）只允许出现在 flags.ts，且不允许整体替换语义", () => {
    for (const h of hits(/\bmessageFlags(Add|Remove|Set)\b/)) {
      expect(h.file, `${h.file}:${h.line} 出现了 STORE 调用：${h.text}`).toBe("flags.ts");
      // 裸 FLAGS（整体替换）在 imapflow 里是 messageFlagsSet——一处都不许有
      expect(h.text).not.toContain("messageFlagsSet");
    }
    // flags.ts 里必须真的有 Add/Remove（防「删光实现」也算过的假绿）
    const storeCalls = hits(/\bmessageFlags(Add|Remove)\b/).filter((h) => h.file === "flags.ts");
    expect(storeCalls.length).toBeGreaterThan(0);
  });

  it("APPEND / SMTP 只允许出现在 send.ts", () => {
    for (const h of hits(/\.append\(|createTransport/)) {
      expect(h.file, `${h.file}:${h.line} 出现了 APPEND/SMTP：${h.text}`).toBe("send.ts");
    }
    // send.ts 里必须真的有（同上，防假绿）
    expect(hits(/\.append\(/).filter((h) => h.file === "send.ts").length).toBeGreaterThan(0);
  });

  it("全包不存在 EXPUNGE / MOVE / COPY / DELETE 类调用", () => {
    const found = hits(/\.(expunge|messageMove|mailboxMove|messageDelete|mailboxDelete)\s*\(/);
    expect(found).toEqual([]);
  });

  it("EXAMINE 是唯一打开方式：flags.ts 之外的 mailboxOpen 必须 readOnly", () => {
    for (const h of hits(/mailboxOpen\(/)) {
      if (h.file === "flags.ts") continue; // STORE 需要写模式，全包唯一例外（3.5）
      expect(h.text, `${h.file}:${h.line} 的 mailboxOpen 未声明 readOnly`).toContain("readOnly");
    }
  });

  it("agent worker 侧模块不 import 凭据 / IMAP / SMTP / 工具面服务端（5.3）", () => {
    // worker 的工具调用一律经 MCP client 走 HTTP 自连：凭据只有一个落点（maild 主流程），
    // 这条把「worker 不持有凭据」机器化。新增 worker 侧模块时必须把它加进清单。
    const workerSide = ["worker.ts", "judge.ts", "queue.ts", "auth.ts", "model.ts"];
    const forbidden = [
      "imap", // IMAP 连接与读取原语
      "flags", // STORE（3.5 唯一写入例外，只能由工具面触达）
      "send", // APPEND / SMTP
      "events", // CalDAV 直连（worker 只能经工具面 create_event）
      "config", // credentials.json 加载
      "fetcher", // 抓取器（持有凭据）
      "idle", // IDLE 监听（持有凭据）
      "message", // 入库（mail.db 写侧）
      "db", // mail.db 原始索引（worker 读邮件只能经 read_message）
      "mcp", // 工具面服务端
      "tools", // 工具面分发（绕过 HTTP 就绕过了台账的唯一入口语义）
      "trigger", // 触发接线（maild 侧，持有 mail.db 与原文）
    ];
    for (const file of workerSide) {
      const entry = sources.find((s) => s.file === file);
      expect(entry, `worker 侧模块 ${file} 不存在（清单与实际漂移）`).toBeDefined();
      const imports = [...entry!.code.matchAll(/^import\s[\s\S]*?\sfrom\s+"(\.\/[^"]+)"/gm)].map((m) =>
        m[1].replace("./", "").replace(/\.js$/, "")
      );
      // 防假绿：worker.ts 必须真的 import 了产物侧模块（queue/judge/ledger）
      if (file === "worker.ts") {
        expect(imports).toEqual(expect.arrayContaining(["queue", "judge", "ledger"]));
      }
      for (const spec of imports) {
        expect(forbidden, `${file} import 了被禁模块 ./${spec}.js`).not.toContain(spec);
      }
    }
  });
});
