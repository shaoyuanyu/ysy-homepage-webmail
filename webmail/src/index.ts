import { join } from "node:path";
import { openDb } from "../../mail/src/db.js";
import { backfillRefs } from "../../mail/src/message.js";
import { createApiServer, runSync, type WebmailContext } from "./api.js";
import { loadAccounts, loadCredentials, webmailDataDir } from "./config.js";
import { MIRROR_SWEEP_MS, mirrorDrafts } from "./draft-mirror.js";

const PORT = Number(process.env.WEBMAIL_PORT ?? 9710);
/** 监听地址：缺省回环（本机信任边界）；容器/私有网络部署时由 WEBMAIL_HOST 覆盖（如 0.0.0.0） */
const HOST = process.env.WEBMAIL_HOST ?? "127.0.0.1";
const SYNC_INTERVAL_MS = Number(process.env.WEBMAIL_SYNC_INTERVAL_MS ?? 60_000);

async function main() {
  const dataDir = webmailDataDir();
  const { accounts, remoteImageDomains } = loadAccounts(dataDir);
  const credentialsFile = loadCredentials(dataDir);
  const credentials = new Map(Object.entries(credentialsFile));
  const db = openDb(join(dataDir, "webmail.db"));

  // 存量回填 refs_json / has_attach（4.7，幂等，不阻塞 API 起来）
  backfillRefs(db, dataDir).then((r) => {
    if (r.updated || r.failed) {
      console.log(`[webmaild] refs 回填：更新 ${r.updated} 行，失败 ${r.failed} 行`);
    }
  });

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

  // 草稿 → 服务器「草稿」文件夹镜像（2026-10-06，见 draft-mirror.ts）：
  // 每 4 秒扫一次，只投递「安静满 10 秒」的 dirty 草稿（合并连续自动保存）
  const draftTimer = setInterval(() => {
    mirrorDrafts(ctx).catch((err) => console.error("[webmaild] 草稿镜像失败：", err));
  }, MIRROR_SWEEP_MS);

  const server = createApiServer(ctx);
  server.listen(PORT, HOST, () => {
    console.log(`[webmaild] API 监听 ${HOST}:${PORT}，数据目录 ${dataDir}`);
  });

  const shutdown = () => {
    clearInterval(timer);
    clearInterval(draftTimer);
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
