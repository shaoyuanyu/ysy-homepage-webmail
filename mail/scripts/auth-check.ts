import { readFileSync } from "node:fs";
import { join } from "node:path";
import dns from "node:dns";
import Database from "better-sqlite3";
import { loadAccounts } from "../src/config.js";
import { authenticateCommand } from "../src/auth.js";

/**
 * 指令认证排错（3.6）：对库里留存的原文逐封跑 authenticateCommand，打印 SPF/DKIM/白名单判定。
 * 用法：pnpm exec tsx scripts/auth-check.ts [--dns] [eml 文件路径]
 *   --dns：注入公共 DNS resolver（223.5.5.5 / 119.29.29.29），排查本机 DNS 代理干扰
 */

const dataDir = process.env.MAIL_AGENT_DATA_DIR ?? "data/mail";
const accounts = loadAccounts(dataDir);

const useDns = process.argv.includes("--dns");
const resolver = useDns
  ? (() => {
      const r = new dns.promises.Resolver();
      r.setServers(["223.5.5.5", "119.29.29.29"]);
      // dns.resolve 的重载返回 AnyRecord 联合，与 mailauth 的 resolver 签名不直接兼容
      return (name: string, type: string) => r.resolve(name, type as never) as unknown as Promise<string[][]>;
    })()
  : undefined;

async function check(eml: Buffer, label: string): Promise<void> {
  const r = await authenticateCommand(eml, accounts, resolver ? { resolver } : {});
  console.log(`${label}\n  => ${JSON.stringify(r)}`);
}

const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (file) {
  await check(readFileSync(file), file);
} else {
  const db = new Database(join(dataDir, "mail.db"), { readonly: true });
  const rows = db
    .prepare("SELECT message_id, eml_path FROM messages WHERE truncated = 0 AND eml_path != ''")
    .all() as { message_id: string; eml_path: string }[];
  db.close();
  for (const row of rows) {
    await check(readFileSync(join(dataDir, row.eml_path)), row.message_id);
  }
}
