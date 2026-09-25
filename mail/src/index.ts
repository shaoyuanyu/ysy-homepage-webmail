import { join } from "node:path";
import { loadAccounts, loadCredentials, mailDataDir } from "./config.js";
import { openDb } from "./db.js";
import { syncAccount } from "./fetcher.js";
import { watchAccount } from "./idle.js";

const dataDir = mailDataDir();
const once = process.argv.includes("--once");

const db = openDb(join(dataDir, "mail.db"));
const accounts = loadAccounts(dataDir).filter((a) => a.enabled);
const creds = loadCredentials(dataDir);

if (accounts.length === 0) {
  console.error("accounts.json 中没有启用的账号");
  process.exit(1);
}

for (const account of accounts) {
  const cred = creds[account.id];
  if (!cred) {
    throw new Error(`credentials.json 缺少账号 ${account.id} 的凭据`);
  }
  const results = await syncAccount(db, dataDir, account, cred);
  for (const r of results) {
    console.log(
      `[${r.accountId}] ${r.folder}: +${r.fetched} 封, 标记更新 ${r.flagsUpdated}${r.rebuilt ? ", 已重建" : ""}`
    );
  }
}

if (!once) {
  console.log("进入 IDLE 监听（Ctrl-C 退出）");
  await Promise.all(
    accounts.map((a) => {
      const cred = creds[a.id];
      if (!cred) throw new Error(`credentials.json 缺少账号 ${a.id} 的凭据`);
      return watchAccount(db, dataDir, a, cred);
    })
  );
}
