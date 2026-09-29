import { describe, expect, it } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import {
  getJudgment,
  judgeMessage,
  JUDGE_PROMPT_VERSION,
  recordJudgment,
  type JudgeOutput,
} from "../src/judge.js";
import { openAgentDb, type AgentDb } from "../src/ledger.js";

/**
 * 判定（5.2）：generateObject + zod 产出 verdict/labels/confidence；
 * judgment 一封信一行（重判覆盖），reasoning 一次处理一行（只追加），
 * 两行都必须带模型与 prompt_version（「当时为什么这么判」靠它可答）。
 * 模型用 MockLanguageModelV4——外部 API 不进测试。
 */

const JUDGE_JSON = JSON.stringify({
  verdict: "important",
  labels: ["todo", "event"],
  confidence: 0.92,
  summary: "编辑部催修稿，含视频会议日程",
  event: { title: "修稿讨论会", start: "2026-09-30T14:00:00+08:00", location: "腾讯会议" },
});

function mockJudgeModel(extra?: { reasoning?: string }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [
        ...(extra?.reasoning ? [{ type: "reasoning" as const, text: extra.reasoning }] : []),
        { type: "text" as const, text: JUDGE_JSON },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 40, text: 30, reasoning: 10 },
      },
      warnings: [],
    } as never,
  });
}

const INPUT = {
  messageId: "mid:judge-1@x",
  subject: "修稿提醒",
  from: "Editor <ed@journal.org>",
  date: "2026-09-29T08:00:00Z",
  text: "请在下周五前提交修改稿……",
};

describe("新邮件判定（judge）", () => {
  it("judgeMessage 产出结构化判定 + 推理文本 + token 数", async () => {
    const out = await judgeMessage({
      model: mockJudgeModel({ reasoning: "来自编辑部，催修稿，明显重要" }),
      modelName: "deepseek-chat",
      input: INPUT,
    });
    expect(out.result.verdict).toBe("important");
    expect(out.result.labels).toEqual(["todo", "event"]);
    expect(out.result.confidence).toBe(0.92);
    expect(out.result.event?.title).toBe("修稿讨论会");
    expect(out.reasoningText).toBe("来自编辑部，催修稿，明显重要");
    expect(out.tokens).toBe(140);
    expect(out.model).toBe("deepseek-chat");
  });

  it("模型不给推理时 reasoningText 为 null（两种文本分开存，5.2）", async () => {
    const out = await judgeMessage({ model: mockJudgeModel(), modelName: "kimi-k2", input: INPUT });
    expect(out.reasoningText).toBeNull();
  });

  it("recordJudgment：一封信一行（重判覆盖），reasoning 只追加", () => {
    const adb: AgentDb = openAgentDb(":memory:");
    const out: JudgeOutput = {
      result: JSON.parse(JUDGE_JSON),
      reasoningText: null,
      tokens: 10,
      model: "deepseek-chat",
    };
    recordJudgment(adb, INPUT.messageId, out, "run", new Date());

    // 重判：judgment 覆盖成行数仍为 1，字段更新
    const rejudged: JudgeOutput = {
      result: { ...out.result, verdict: "normal", confidence: 0.5 },
      reasoningText: "复审降档",
      tokens: 8,
      model: "deepseek-chat",
    };
    recordJudgment(adb, INPUT.messageId, rejudged, "rejudge", new Date());

    const rows = adb.prepare("SELECT * FROM judgment WHERE message_id = ?").all(INPUT.messageId);
    expect(rows).toHaveLength(1);
    const j = getJudgment(adb, INPUT.messageId);
    expect(j?.verdict).toBe("normal");
    expect(j?.confidence).toBe(0.5);
    expect(j?.model).toBe("deepseek-chat");
    expect(j?.prompt_version).toBe(JUDGE_PROMPT_VERSION);

    const reasoning = adb
      .prepare("SELECT * FROM reasoning WHERE message_id = ? ORDER BY id")
      .all(INPUT.messageId) as { run_kind: string; trace: string | null; prompt_version: string }[];
    expect(reasoning).toHaveLength(2);
    expect(reasoning[0].run_kind).toBe("run");
    expect(reasoning[1].run_kind).toBe("rejudge");
    expect(reasoning[1].trace).toBe("复审降档");
    expect(reasoning[0].prompt_version).toBe(JUDGE_PROMPT_VERSION);
  });
});
