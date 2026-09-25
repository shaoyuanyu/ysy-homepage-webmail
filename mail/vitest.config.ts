import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 容器拉取与启动较慢
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // 多个用例共享同一个 Dovecot 容器与数据库
    fileParallelism: false,
  },
});
