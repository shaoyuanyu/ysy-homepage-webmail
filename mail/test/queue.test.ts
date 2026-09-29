import { describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/ledger.js";
import {
  claimTask,
  enqueueTask,
  failTask,
  finishTask,
  recentFailedTasks,
  taskCounts,
} from "../src/queue.js";

/**
 * 任务队列（agent.db tasks 表，5.1）：
 * - 原子领取按优先级降序、同优先级按 id 升序
 * - run_after 未到期不领取
 * - 失败指数退避重投，3 次后标 failed（5.5 的告警面）
 */

function db(): AgentDb {
  return openAgentDb(":memory:");
}

describe("任务队列", () => {
  it("领取顺序：command > report > judge，同优先级按 id", () => {
    const adb = db();
    enqueueTask(adb, "judge", { messageId: "mid:a" });
    enqueueTask(adb, "report");
    enqueueTask(adb, "judge", { messageId: "mid:b" });
    enqueueTask(adb, "command", { messageId: "mid:c" });

    const t1 = claimTask(adb);
    expect(t1?.kind).toBe("command");
    const t2 = claimTask(adb);
    expect(t2?.kind).toBe("report");
    const t3 = claimTask(adb);
    expect(t3?.message_id).toBe("mid:a");
    const t4 = claimTask(adb);
    expect(t4?.message_id).toBe("mid:b");
    expect(claimTask(adb)).toBeNull();
  });

  it("run_after 未到期不领取；到期后领取", () => {
    const adb = db();
    enqueueTask(adb, "judge", { messageId: "mid:future", runAfter: new Date(Date.now() + 3600_000) });
    expect(claimTask(adb)).toBeNull();
    adb.prepare("UPDATE tasks SET run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')").run();
    expect(claimTask(adb)?.message_id).toBe("mid:future");
  });

  it("领取置 running 且 attempts+1；finish 置 done", () => {
    const adb = db();
    const id = enqueueTask(adb, "judge", { messageId: "mid:x" });
    const t = claimTask(adb);
    expect(t?.status).toBe("running");
    expect(t?.attempts).toBe(1);
    expect(t?.started_at).toBeTruthy();
    finishTask(adb, id);
    const row = adb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as { status: string; finished_at: string };
    expect(row.status).toBe("done");
    expect(row.finished_at).toBeTruthy();
  });

  it("失败退避重投：前两次回 pending 且 run_after 在未来，第三次标 failed", () => {
    const adb = db();
    const id = enqueueTask(adb, "judge", { messageId: "mid:flaky" });

    // 第 1 次失败：回 pending，退避 2 分钟
    claimTask(adb);
    failTask(adb, id, "模型超时");
    let row = adb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as {
      status: string;
      attempts: number;
      run_after: string;
      error: string;
    };
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.error).toBe("模型超时");
    expect(new Date(row.run_after).getTime()).toBeGreaterThan(Date.now());
    expect(claimTask(adb)).toBeNull(); // 退避期内不领取

    // 第 2 次失败：attempts=2，仍回 pending
    adb.prepare("UPDATE tasks SET run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')").run();
    claimTask(adb);
    failTask(adb, id, "模型超时");
    row = adb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as typeof row;
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(2);

    // 第 3 次失败：标 failed（5.5 的告警面）
    adb.prepare("UPDATE tasks SET run_after = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 second')").run();
    claimTask(adb);
    failTask(adb, id, "模型持续超时");
    row = adb.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as typeof row;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.error).toBe("模型持续超时");
    expect(claimTask(adb)).toBeNull();

    const failed = recentFailedTasks(adb);
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("模型持续超时");
  });

  it("taskCounts 汇总各状态数量", () => {
    const adb = db();
    enqueueTask(adb, "judge", { messageId: "mid:1" });
    enqueueTask(adb, "judge", { messageId: "mid:2" });
    const t = claimTask(adb);
    expect(taskCounts(adb)).toEqual({ pending: 1, running: 1, done: 0, failed: 0 });
    finishTask(adb, t!.id);
    expect(taskCounts(adb)).toEqual({ pending: 1, running: 0, done: 1, failed: 0 });
  });
});
