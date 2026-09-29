import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { authenticateCommand } from "./auth.js";
import type { Db } from "./db.js";
import { appendLedger, type AgentDb } from "./ledger.js";
import { enqueueTask } from "./queue.js";
import type { AccountConfig, SyncResult } from "./types.js";

/**
 * 触发接线（5.1）：抓取器入库新邮件后投任务。
 * - 先做指令认证（3.6：白名单 + SPF/DKIM 双通过），认证结果记台账
 * - 通过 → command 任务（队列内高优先级）；否则 → judge 任务
 * - 只处理 created = true 的邮件：多副本重复入库不重复投（指令邮件尤其不能执行两次）
 * - 无原文（超大邮件只存元数据）无法认证 → 直接 judge
 */

export interface EnqueueOutcome {
  judge: number;
  command: number;
  /** 跳过（多副本重复入库）的数量 */
  skipped: number;
}

export async function enqueueForIngested(opts: {
  db: Db;
  agentDb: AgentDb;
  dataDir: string;
  accounts: AccountConfig[];
  results: SyncResult[];
  /** DNS 解析器注入点（测试用；缺省走系统 DNS，见 auth.ts） */
  resolver?: (name: string, recordType: string) => Promise<string[][]>;
}): Promise<EnqueueOutcome> {
  const out: EnqueueOutcome = { judge: 0, command: 0, skipped: 0 };
  const getEmlPath = opts.db.prepare("SELECT eml_path FROM messages WHERE message_id = ?");

  for (const result of opts.results) {
    for (const item of result.ingested) {
      if (!item.created) {
        out.skipped++;
        continue;
      }
      const row = getEmlPath.get(item.messageId) as { eml_path: string } | undefined;
      let isCommand = false;
      if (row?.eml_path) {
        try {
          const eml = await readFile(join(opts.dataDir, row.eml_path));
          const auth = await authenticateCommand(eml, opts.accounts, {
            ...(opts.resolver ? { resolver: opts.resolver } : {}),
          });
          appendLedger(opts.agentDb, {
            tool: "command_auth",
            ok: auth.isCommand,
            messageId: item.messageId,
            detail: { from: auth.from, spf: auth.spf, dkim: auth.dkim, reason: auth.reason },
          });
          isCommand = auth.isCommand;
        } catch (err) {
          // 认证流程异常（原文读不出等）：记台账后按普通邮件处理
          appendLedger(opts.agentDb, {
            tool: "command_auth",
            ok: false,
            messageId: item.messageId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      enqueueTask(opts.agentDb, isCommand ? "command" : "judge", { messageId: item.messageId });
      if (isCommand) out.command++;
      else out.judge++;
    }
  }
  return out;
}
