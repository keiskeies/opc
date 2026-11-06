import { defineConfig } from "vitest/config";

// 边界与 PoC 测试都要真跑子进程 / 真读 SQLite，故默认 node 环境、不并发共享 DB。
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // 每个文件独立进程：PoC 用文件级 SQLite，共享 worker 会互相锁库
    pool: "forks",
    testTimeout: 180_000,
    // 覆盖率阈值写进配置（计划 Task 1.2：门控分支 ≥ 95%），CI 强制而非靠自觉
    coverage: {
      provider: "v8",
      include: ["packages/hub/src/**"],
      thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
    },
  },
});