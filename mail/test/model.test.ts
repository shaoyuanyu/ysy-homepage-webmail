import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadModel } from "../src/config.js";
import { createModel } from "../src/model.js";
import { workRoot } from "./dovecot.js";

/**
 * 模型配置（实现细则）：accounts.json 顶层 model 段 + credentials.json 的 model 键（apiKey）。
 * createModel 只构造客户端（不发起请求）；外部 API 不进测试。
 */

const dir = join(workRoot, "model-config");

function write(modelSection: unknown, credModel: unknown): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "accounts.json"), JSON.stringify({ accounts: [], model: modelSection }));
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ model: credModel }));
}

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("模型配置加载", () => {
  it("model 段 + apiKey 齐备 → 返回完整配置（reportHour 缺省 21）", () => {
    write({ baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" }, { username: "model", password: "sk-test" });
    const cfg = loadModel(dir);
    expect(cfg).toEqual({
      baseURL: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-test",
      reportHour: 21,
    });
  });

  it("reportHour 可配；baseURL 尾部斜杠归一", () => {
    write({ baseURL: "https://api.moonshot.cn/v1/", model: "kimi-k2", reportHour: 8 }, { username: "m", password: "k" });
    expect(loadModel(dir)).toMatchObject({ baseURL: "https://api.moonshot.cn/v1", reportHour: 8 });
  });

  it("缺 model 段或缺 apiKey → null（worker 池不启动）", () => {
    write(undefined, { username: "m", password: "k" });
    expect(loadModel(dir)).toBeNull();
    write({ baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat" }, undefined);
    expect(loadModel(dir)).toBeNull();
  });

  it("createModel 构造出指定 modelId 的客户端（不发请求）", () => {
    const model = createModel({ baseURL: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test" });
    expect((model as unknown as { modelId: string }).modelId).toBe("deepseek-chat");
  });
});
