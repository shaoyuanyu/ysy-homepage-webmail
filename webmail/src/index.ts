import { join } from "node:path";
import { openDb } from "../../mail/src/db.js";
import { createApiServer, runSync, type WebmailContext } from "./api.js";
import { loadAccounts, loadCredentials, webmailDataDir } from "./config.js";

const PORT = Number(process.env.WEBMAIL_PORT ?? 9710);
const SYNC_INTERVAL_MS = Number(process.env.WEBMAIL_SYNC_INTERVAL_MS ?? 60_000);

async function main() {
  const dataDir = webmailDataDir();
  const { accounts, remoteImageDomains } = loadAccounts(dataDir);
  const credentialsFile = loadCredentials(dataDir);
  const credentials = new Map(Object.entries(credentialsFile));
  const db = openDb(join(dataDir, "webmail.db"));

  const ctx: WebmailContext = {
    db,
    dataDir,
    accounts: new Map(accounts.map((a) => [a.id, a])),
    credentials,
    remoteImageDomains,
    syncStates: new Map(),
  };

  // 启动先跑一轮全量增量同步，失败不阻塞 API 起来（错误记在 /health）
  runSync(ctx).catch((err) => console.error("[webmaild] 启动同步失败：", err));

  const timer = setInterval(() => {
    runSync(ctx).catch((err) => console.error("[webmaild] 定时同步失败：", err));
  }, SYNC_INTERVAL_MS);

  const server = createApiServer(ctx);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[webmaild] API 监听 127.0.0.1:${PORT}，数据目录 ${dataDir}`);
  });

  const shutdown = () => {
    clearInterval(timer);
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[webmaild] 启动失败：", err);
  process.exit(1);
});
