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
    // 空跑的 it 必须红：把某条用例的整个 body 掏空（标题与条数一字未动），
    // 默认配置下它照样绿 —— 实测过。开这个开关后同一条刀当场失败，而全仓 307 条
    // 真用例无一误伤，包括体内不写 expect、只 await fn() 委托的包装用例
    // （判定发生在运行时，委托里跑到的 expect 也算）。见 0006 §7 第 59 条。
    expect: { requireAssertions: true },
    testTimeout: 180_000,
    /*
     * 覆盖率阈值。计划 Task 1.2 要的是「门控判定分支 ≥ 95%，阈值写进 config」。
     *
     * 【这一项目前没有落地。】它此前藏起来的方式是一行注释：「覆盖率阈值写进配置…
     * CI 强制而非靠自觉」，而阈值四个全是 0 —— 0 等于不设限。
     * 一句声称有强制的注释配一个恒不拦的数值，症状与门控那个「注释承诺了实现没有的
     * 性质」是同一个形状（同类的还在 sha256File 写着流式而实现整读、
     * independentReviewerPath 写着多跳而实现只看一跳）。注释比数值更容易被信，
     * 所以这次【改注释而不是改数值】，理由如下。
     *
     * 为什么不直接把 branches 填成 95：两个理由，第二个是硬的。
     *  ① 作用域不对。thresholds 作用于上面的 include: packages/hub/src/** ——
     *    整个 Hub 的源码，而计划要求 95% 的对象是【门控判定分支】。把 95 填在全局上，
     *    红了之后读不出是门控覆盖不够还是别的模块覆盖不够，而那正是这条阈值唯一
     *    该回答的问题。
     *  ② 我现在【无从测量】。本机没有 vitest（pnpm verify 跑不起来，见 0008 与本仓
     *    门禁的口径），所以我没法知道真实数字是多少。在这种情况下填一个 95，
     *    我报出去的就是一次【没有测过的通过】—— 那比不设限更坏：不设限是已知的洞，
     *    填 95 是一个假装合不上的洞。
     *
     * 正确做法（Task 1.8 的前置，别绕过）：能跑 vitest 的环境里先量一次
     * `pnpm vitest run --coverage`，再把门控那几个文件（src/graph/gates/**）单独
     * 圈一个作用域去设阈值 —— vitest 的 thresholds 没有「按 glob 给不同阈值」的
     * 形状，所以要么用 projects 拆成两份配置，要么把 95 加在只含门控的第二份
     * coverage 配置上。谁做这件事，请把量到的数字一并写回这里，别让下一个人数。
     */
    coverage: {
      provider: "v8",
      include: ["packages/hub/src/**"],
      thresholds: { branches: 0, functions: 0, lines: 0, statements: 0 },
    },
  },
});
