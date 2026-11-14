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
     *  ② 阈值【还没填】的原因（0039 复核，非「本机没有 vitest」）：离线能装 vitest
     *    **4.1.5** 且真跑通（0037 §7 已记；0039 复核 gate 套件在 4.1.5 下 59/59 通过），
     *    但 pin 的 **4.1.12**、以及 coverage 归因所需的 **vite@8.3.6 / esbuild@0.28.2**
     *    tarball 都不在 store（`find` 物理文件 = 0，空壳）。两款 coverage provider 都归因
     *    不了：v8 走 Node strip-types 直跑 `.ts`、没有 esbuild transform 的 sourcemap，
     *    报告出 0/130（文件列出来全是 0 行）；istanbul 的 metadata 不在 store、离线解析即
     *    `ERR_PNPM_NO_OFFLINE_META`。⇒ 真实数字拿不到，是**基础设施 blocked**，不是我没量。
     *    旧注释写「本机没有 vitest」是**假的**（4.1.5 装得上）；真实前提是「**pin 那几套
     *    装不上 / coverage 归因 offline 不可达**」（0039 §0–§2）。
     *
     * 正确做法（Task 1.8 的前置，别绕过）：能跑 vitest 的环境里先量一次
     * `pnpm vitest run --coverage`，再把门控那几个文件（src/graph/gates/**）单独
     * 圈一个作用域去设阈值 —— vitest 的 thresholds 没有「按 glob 给不同阈值」的
     * 形状，所以要么用 projects 拆成两份配置，要么把 95 加在只含门控的第二份
     * coverage 配置上。谁做这件事，请把量到的数字一并写回这里，别让下一个人数。
     * ── round189 复核（HEAD dd6f9c6）：store 现状更新 —— vite@8.3.6 / esbuild@0.28.2 /
     * @esbuild/win32-x64@0.28.2 的 tarball+metadata 现在【都在】D:\.pnpm-store\v10，
     * 0039 断言的『那两套不在』已自愈。真正还缺的只有一枚：@vitest/coverage-v8@4.1.12
     * （及其 istanbul 表亲）的 tarball 与 offline metadata 都不在 store —— 实测
     * pnpm add --offline 报 ERR_PNPM_NO_OFFLINE_META（coverage-v8.json 缺失）。
     * ⇒ 现在只需补这一枚包即可量覆盖率，不必再串整条 vite/esbuild 链。
     * ── round193 实测：@vitest/coverage-v8@4.1.12 已装（网络可达），真实数字到手：
     *   · 门控文件（graph/gates/**，仅跑 gates/escalation/phase1 测试）：lines 99.15% / branches 97.87% /
     *     functions 100% —— author-reviewer.ts 100/100/100；evaluate.ts 98.66/96.55/100。已达 95 上限。
     *   · 全 hub/src（排除 4 个设计红文件与 claude）：lines 84.73% / branches 77.99% / functions 85.68%。
     *     低于 95 的原因【恰是那 8 个设计红模块】—— charter/store、budget-sync、auto-approve 0~17%，
     *     另有入口文件 cli/index/main/hub-serve 0%。即覆盖率赤字=接线缺口，非测试缺失。
     *   ⇒ 结论维持：全局 95 会因接线缺口恒红（不可用）；门控专属 95 现可设（99.15 有余）。
     *   · round194：vitest 4.1.12 原生支持 per-glob thresholds（补在 thresholds 对象里，key=glob）——
     *     已在下方直接设上（gates 95/95/100/90），coverage 门控分支不再空转。
     * （gate 套件在 vitest 4.1.5 下实测 59/59 全绿，见 0039 §3。）
     */
    coverage: {
      provider: "v8",
      include: ["packages/hub/src/**"],
      thresholds: {
        // 全局 0 —— 全仓 lines 84.73%（round193），因 8 个设计红接线缺口模块 0~17% + 入口文件 0%。
        // 一旦接线这些缺口消失、全仓过 95，再升全局阈值。当前设非 0 会恒红且是接线缺口而非测试缺失。
        branches: 0,
        functions: 0,
        lines: 0,
        statements: 0,
        // 门控专属：graph/gates/** 实测 lines 99.15% / branches 97.87% / functions 100%（round193），
        // 95 有裕量 —— 这条让 coverage 对【门控判定分支】不再空转（0007 §4.1 反假绿）。
        "packages/hub/src/graph/gates/**.ts": {
          branches: 95,
          functions: 100,
          lines: 95,
          statements: 90,
        },
      },
    },
  },
});
