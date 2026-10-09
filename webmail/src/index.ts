import { join } from "node:path";
import { openDb } from "../../mail/src/db.js";
import { hasPendingBackfill } from "../../mail/src/fetcher.js";
import { backfillRefs } from "../../mail/src/message.js";
import { createApiServer, isFullSyncInFlight, runSync, type WebmailContext } from "./api.js";
import { repairAccountColorsFile } from "./accounts.js";
import { loadAccounts, loadCredentials, webmailDataDir } from "./config.js";
import { MIRROR_SWEEP_MS, mirrorDrafts } from "./draft-mirror.js";

const PORT = Number(process.env.WEBMAIL_PORT ?? 9710);
/** 监听地址：缺省回环（本机信任边界）；容器/私有网络部署时由 WEBMAIL_HOST 覆盖（如 0.0.0.0） */
const HOST = process.env.WEBMAIL_HOST ?? "127.0.0.1";
const SYNC_INTERVAL_MS = Number(process.env.WEBMAIL_SYNC_INTERVAL_MS ?? 60_000);
/**
 * 回填泵节拍（2026-10-08）：还有历史回填没做完时，用这个节拍驱动「一次一块」的
 * 回填轮（fetcher.ts 的 `mode: "backfill"`）。60s 的常规轮只吃一块，靠它才能把
 * 首轮铺满整个邮箱的时间压到十几分钟；而每块的账号锁持有只有几秒，
 * 期间 LIST / 发信 / 标记都能插进来。
 */
const BACKFILL_TICK_MS = Number(process.env.WEBMAIL_BACKFILL_TICK_MS ?? 1500);

async function main() {
  const dataDir = webmailDataDir();
  const { accounts, remoteImageDomains } = loadAccounts(dataDir);
  // 撞色自动修复（2026-10-09）：缺省色写死年代留下的账号至今同色，用户不该为此手动改。
  const recolored = repairAccountColorsFile(dataDir, accounts);
  if (recolored.length > 0) {
    console.log(
      `[webmaild] 账号颜色撞色已自动重新分配：${recolored
        .map((id) => `${id}=${accounts.find((a) => a.id === id)?.color}`)
        .join("、")}`
    );
  }
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

  // 历史回填泵（见文件头 BACKFILL_TICK_MS）：没有待回填的文件夹时几乎是空转
  // （一次 hasPendingBackfill 查询）；有活干时每拍吃一块，直到铺满。
  // ⚠ 让路规则：全量轮在飞时跳过这一拍——否则回填轮会把 60s 常规轮（增量 + 标记
  //   回读）一并顶掉（api.ts 的 runSync 语义 3）。
  const backfillTimer = setInterval(() => {
    if (isFullSyncInFlight()) return;
    if (!hasPendingBackfill(db)) return;
    runSync(ctx, undefined, { mode: "backfill" }).catch((err) =>
      console.error("[webmaild] 历史回填失败：", err)
    );
  }, BACKFILL_TICK_MS);

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
    clearInterval(backfillTimer);
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
