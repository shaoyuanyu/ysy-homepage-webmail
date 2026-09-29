import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * 模型客户端工厂（实现细则：模型客户端可注入）。
 * 生产 = AI SDK openai-compatible（DeepSeek/Kimi/GLM 同端点形态）；
 * 测试注入 MockLanguageModel，不经过本模块。worker/judge 只认 LanguageModel 实例。
 */
export interface ModelSettings {
  baseURL: string;
  model: string;
  apiKey: string;
}

export function createModel(settings: ModelSettings): LanguageModel {
  const provider = createOpenAICompatible({
    name: "mail-agent",
    baseURL: settings.baseURL,
    apiKey: settings.apiKey,
  });
  return provider.chatModel(settings.model);
}
