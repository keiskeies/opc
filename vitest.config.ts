import { defineConfig } from "vitest/config";

// 边界与 PoC 测试都要真跑子进程 / 真读 SQLite，故默认 node 环境、不并发共享 DB。
export default defineConfig({
  test: {
    environment: "node",
    // 测试前构建 @opc/contracts：跨包 import 靠 package exports 解析到 dist，
    // 而 dist 被 gitignore（clone 下来就是空的）。必须在模块解析【之前】完成，
    // 所以是 globalSetup —— 测试文件里的 beforeAll 太晚，实测一个测试都不会跑。
    globalSetup: ["test/global-setup/build-contracts.ts"],
    // 根 test/ 放跨包与 PoC 测试；包内 test/ 放只依赖本包的测试（如 Task 0.3 的驱动预检）。
    include: ["test/**/*.test.{ts,tsx}", "packages/*/test/**/*.test.{ts,tsx}"],
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