import { join } from "node:path";
import { loadAccounts, loadCaldav, loadCredentials, loadModel, mailDataDir } from "./config.js";
import { openDb } from "./db.js";
import { syncAccount } from "./fetcher.js";
import { markSyncOk } from "./health.js";
import { watchAccount } from "./idle.js";
import { agentDbPath, openAgentDb, type AgentDb } from "./ledger.js";
import { createToolsServer, TOOLS_PORT } from "./mcp.js";
import { backfillRefs } from "./message.js";
import { createModel } from "./model.js";
import { enqueueTask } from "./queue.js";
import { enqueueForIngested } from "./trigger.js";
import type { AccountConfig, SyncResult } from "./types.js";
import { WorkerPool } from "./worker.js";

const dataDir = mailDataDir();
const once = process.argv.includes("--once");

/** 监听地址：缺省回环（本机信任边界）；容器/私有网络部署时由 MAIL_AGENT_HOST 覆盖（如 0.0.0.0） */
const HOST = process.env.MAIL_AGENT_HOST ?? "127.0.0.1";
/** worker 自连工具面的目标：监听 0.0.0.0 时回落回环（0.0.0.0 不是可连接的目标地址） */
const SELF_HOST = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;

const db = openDb(join(dataDir, "mail.db"));
const agentDb = openAgentDb(agentDbPath(dataDir));

// 存量回填 refs_json / has_attach（4.7，幂等）
backfillRefs(db, dataDir).then((r) => {
  if (r.updated || r.failed) {
    console.log(`[mailagentd] refs 回填：更新 ${r.updated} 行，失败 ${r.failed} 行`);
  }
});
const accounts = loadAccounts(dataDir).filter((a) => a.enabled);
const creds = loadCredentials(dataDir);
const caldav = loadCaldav(dataDir);
const modelCfg = loadModel(dataDir);

if (accounts.length === 0) {
  console.error("accounts.json 中没有启用的账号");
  process.exit(1);
}

/** agent worker 池（5.1）：配置了 model 段 + apiKey 才启用；未配置时任务仍入库，配置后重启即消费 */
const pool = modelCfg ? buildPool(agentDb, accounts, modelCfg) : null;

function buildPool(
  adb: AgentDb,
  accts: AccountConfig[],
  cfg: { baseURL: string; model: string; apiKey: string }
): WorkerPool {
  const reportTo = accts.find((a) => !a.isAgent)?.email;
  if (!reportTo) throw new Error("accounts.json 没有非 agent 账号作为汇报收件人（reportTo）");
  return new WorkerPool({
    agentDb: adb,
    mcpUrl: `http://${SELF_HOST}:${TOOLS_PORT}/mcp`,
    model: createModel(cfg),
    modelName: cfg.model,
    reportTo,
  });
}

/** 触发接线：新邮件 → 指令认证 → 投任务（3.6 / 5.1）；投完唤醒 worker */
async function onIngested(results: SyncResult[]): Promise<void> {
  const n = await enqueueForIngested({ db, agentDb, dataDir, accounts, results });
  if (n.judge + n.command > 0) {
    console.log(
      `投任务：judge ${n.judge}、command ${n.command}${n.skipped > 0 ? `（跳过重复入库 ${n.skipped}）` : ""}`
    );
    pool?.notify();
  }
}

/** 每日汇报定时器：到点投 report 任务并唤醒 worker（3.7 的待确认提醒随汇报走） */
function startReportTimer(adb: AgentDb, p: WorkerPool, reportHour: number): void {
  const scheduleNext = (): void => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(reportHour, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    const timer = setTimeout(() => {
      enqueueTask(adb, "report");
      p.notify();
      scheduleNext();
    }, next.getTime() - now.getTime());
    timer.unref(); // 不单独阻止进程退出
  };
  scheduleNext();
}

for (const account of accounts) {
  const cred = creds[account.id];
  if (!cred) {
    throw new Error(`credentials.json 缺少账号 ${account.id} 的凭据`);
  }
  const results = await syncAccount(db, dataDir, account, cred);
  markSyncOk(account.id);
  for (const r of results) {
    console.log(
      `[${r.accountId}] ${r.folder}: +${r.fetched} 封, 标记更新 ${r.flagsUpdated}${r.rebuilt ? ", 已重建" : ""}`
    );
  }
  await onIngested(results);
}

if (!once) {
  console.log("进入 IDLE 监听（Ctrl-C 退出）");
  const toolsServer = createToolsServer({ db, agentDb, dataDir, accounts, creds, caldav });
  toolsServer.listen(TOOLS_PORT, HOST, () => {
    console.log(`受限工具面（MCP）已监听 ${HOST}:${TOOLS_PORT}`);
    if (pool && modelCfg) {
      const concurrency = Number(process.env.MAIL_AGENT_WORKER_CONCURRENCY ?? 3);
      void pool.run(concurrency);
      console.log(`agent worker 池已启动（模型 ${modelCfg.model}，并发 ${concurrency}）`);
      startReportTimer(agentDb, pool, modelCfg.reportHour);
    } else {
      console.log("未配置 model 段与 apiKey：agent worker 池不启动（任务仍会入库，配置后重启即消费）");
    }
  });
  await Promise.all([
    ...accounts.map((a) => {
      const cred = creds[a.id];
      if (!cred) throw new Error(`credentials.json 缺少账号 ${a.id} 的凭据`);
      return watchAccount(db, dataDir, a, cred, undefined, (results) =>
        void onIngested(results).catch((err) => console.error("投任务失败", err))
      );
    }),
    new Promise<void>((resolve) => toolsServer.on("close", resolve)),
  ]);
}
