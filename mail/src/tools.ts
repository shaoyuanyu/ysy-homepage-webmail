import { z } from "zod";
import type { Db } from "./db.js";
import { listLedger, type AgentDb } from "./ledger.js";
import { appendLedger } from "./ledger.js";
import { searchMessages } from "./search.js";
import { readMessage, getAttachment } from "./reader.js";
import { setMessageFlags } from "./flags.js";
import { sendAsAgent } from "./send.js";
import { createEvent, type CaldavTarget } from "./events.js";
import type { AccountConfig, CredentialsFile } from "./types.js";

/**
 * 受限工具面（5.3）：agent 能调的函数只有这 8 个。
 * 没有删除、移动、EXPUNGE 的函数——「不能删邮件」靠的是没有这个函数，不是靠提示词。
 * 每次调用经 callTool 分发并落台账；台账由工具层写，agent 侧无法跳过。
 */

export interface ToolsContext {
  db: Db;
  agentDb: AgentDb;
  /** 邮件数据目录（.eml 原文的相对路径基准） */
  dataDir: string;
  accounts: AccountConfig[];
  creds: CredentialsFile;
  caldav: CaldavTarget | null;
}

export interface ToolDef {
  name: string;
  description: string;
  /** zod raw shape（MCP registerTool 直接用） */
  schema: Record<string, z.ZodTypeAny>;
  run(ctx: ToolsContext, args: Record<string, unknown>): Promise<unknown>;
}

const messageIdArg = z.string().min(3).describe("邮件的 Message-ID（来自 search_messages / list 结果）");

export const TOOLS: ToolDef[] = [
  {
    name: "list_accounts",
    description: "列出邮件账号（id、显示名、地址、服务商、颜色）。不含凭据。",
    schema: {},
    async run(ctx) {
      return ctx.accounts
        .filter((a) => a.enabled)
        .map((a) => ({
          id: a.id,
          displayName: a.displayName,
          email: a.email,
          provider: a.provider,
          color: a.color,
          isAgent: a.isAgent === true,
        }));
    },
  },
  {
    name: "search_messages",
    description: "模糊搜索邮件（主题/发件人/收件人/正文）。3 个字符以上走 trigram 索引，1~2 字符走 LIKE。",
    schema: {
      query: z.string().min(1),
      account: z.string().optional().describe("限定账号 id，缺省全部"),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async run(ctx, args) {
      const query = args.query as string;
      const account = args.account as string | undefined;
      const limit = (args.limit as number | undefined) ?? 30;
      const hits = searchMessages(ctx.db, query, Math.min(limit * 2, 200));
      const filtered = account ? hits.filter((h) => h.accounts.includes(account)) : hits;
      return filtered.slice(0, limit);
    },
  },
  {
    name: "read_message",
    description: "读一封邮件的完整内容：头部、纯文本正文（超长截断）、附件元数据、各副本的标记状态。",
    schema: { messageId: messageIdArg },
    async run(ctx, args) {
      return readMessage(ctx.db, ctx.dataDir, args.messageId as string);
    },
  },
  {
    name: "get_attachment",
    description: "取某封邮件的某个附件内容（base64）。附件按需取；超过 10MB 拒绝。",
    schema: {
      messageId: messageIdArg,
      index: z.number().int().min(0).describe("附件序号（来自 read_message 的 attachments[].index）"),
    },
    async run(ctx, args) {
      return getAttachment(ctx.db, ctx.dataDir, args.messageId as string, args.index as number);
    },
  },
  {
    name: "set_flags",
    description:
      "对一封邮件的所有副本一起写 \\Seen / \\Flagged（3.5 允许的两个标记，只增删不整体替换）。不能改任何其它标记。",
    schema: {
      messageId: messageIdArg,
      seen: z.boolean().optional(),
      flagged: z.boolean().optional(),
    },
    async run(ctx, args) {
      return setMessageFlags({
        db: ctx.db,
        agentDb: ctx.agentDb,
        accounts: ctx.accounts,
        creds: ctx.creds,
        messageId: args.messageId as string,
        change: { seen: args.seen as boolean | undefined, flagged: args.flagged as boolean | undefined },
        source: "agent",
      });
    },
  },
  {
    name: "send_as_agent",
    description:
      "以 agent@ 名义发信（纯文本）。收件人全部在白名单（站主的账号地址）内则直发；否则进待确认队列，等站主确认后才发出。",
    schema: {
      to: z.array(z.string()).min(1),
      cc: z.array(z.string()).optional(),
      subject: z.string(),
      text: z.string(),
      inReplyTo: z.string().optional().describe("回复时填原信的 Message-ID"),
    },
    async run(ctx, args) {
      return sendAsAgent({
        agentDb: ctx.agentDb,
        accounts: ctx.accounts,
        creds: ctx.creds,
        req: {
          to: args.to as string[],
          cc: args.cc as string[] | undefined,
          subject: args.subject as string,
          text: args.text as string,
          inReplyTo: args.inReplyTo as string | undefined,
        },
      });
    },
  },
  {
    name: "get_ledger",
    description: "读工具调用台账（最近优先，游标分页）。工具层记录「读了哪封、写了什么」，不可绕过。",
    schema: {
      limit: z.number().int().min(1).max(200).optional(),
      beforeId: z.number().int().optional().describe("翻页游标：只取 id 小于该值的行"),
    },
    async run(ctx, args) {
      return listLedger(ctx.agentDb, {
        limit: args.limit as number | undefined,
        beforeId: args.beforeId as number | undefined,
      });
    },
  },
  {
    name: "create_event",
    description:
      "把提取出的日程写入主站 CalDAV 日历（agent-schedule 集合，/calendar 可见）。v1 只支持定时日程，时间用 ISO 8601。",
    schema: {
      title: z.string().min(1),
      start: z.string().describe("开始时间，ISO 8601（带时区偏移）"),
      end: z.string().optional().describe("结束时间，缺省开始 +1 小时"),
      location: z.string().optional(),
      description: z.string().optional(),
    },
    async run(ctx, args) {
      if (!ctx.caldav) throw new Error("未配置 CalDAV（accounts.json 缺 caldav 段或凭据）");
      return createEvent({
        agentDb: ctx.agentDb,
        caldav: ctx.caldav,
        event: {
          title: args.title as string,
          start: args.start as string,
          end: args.end as string | undefined,
          location: args.location as string | undefined,
          description: args.description as string | undefined,
        },
      });
    },
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/**
 * 唯一分发入口：每次调用先落台账（成功/失败都记），再返回/抛出。
 * 注意 set_flags / send_as_agent / create_event 内部还会写各自的明细行，这里记的是调用行。
 */
export async function callTool(
  ctx: ToolsContext,
  name: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`未知工具：${name}`);
  const started = Date.now();
  try {
    const result = await tool.run(ctx, args);
    appendLedger(ctx.agentDb, {
      tool: name,
      ok: true,
      messageId: typeof args.messageId === "string" ? args.messageId : undefined,
      detail: { args, ms: Date.now() - started },
    });
    return result;
  } catch (err) {
    appendLedger(ctx.agentDb, {
      tool: name,
      ok: false,
      messageId: typeof args.messageId === "string" ? args.messageId : undefined,
      detail: { args },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
