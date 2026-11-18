/**
 * 门禁住址守卫（判据在 ./plan-gate-paths.ts）。
 *
 * 五发合成变异 + 三发真仓库。合成那几发是主力 —— 真仓库那一发今天必然绿
 * （住址就是本轮刚修完的），它证不了「下次再搬一次目录 / 再改一次验收行前缀时会红」。
 *
 * 本文件【不在本守卫的语料里】（本守卫只读计划文档），所以夹具里的路径可以直写；
 * 但它在 ./plan-refs.ts 的语料里，所以【编号引用】一律拼出来、不直写。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  acceptanceBlocks,
  exemptedBlocks,
  missingGatePaths,
  NOT_BUILT_TAG,
  pathTokens,
  readPlan,
} from "./plan-gate-paths.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exists = (p: string): boolean => existsSync(join(ROOT, p));

const KW = "Ta" + "sk";
const runLine = (path: string): string => "- **Run**：`pnpm test " + path + "`";

const PLAN_FIXTURE = [
  "# 计划",
  "### " + KW + " 0.3　决策门",
  runLine("packages/hub/test/db/a.test.ts"),
  "",
  "### " + KW + " 1.8　出口门禁",
  runLine("test/acceptance/b.test.ts"),
  "- **Commit**：`chore: 这里点名 packages/gone/c.ts 也不算，它不是验收行`",
  "",
].join("\n");

/** 只认这些路径存在 —— 合成语料，不碰盘。 */
const existsOnly =
  (...ok: string[]) =>
  (p: string): boolean =>
    ok.includes(p);

describe("门禁住址对账：判据本身", () => {
  it("控制组：验收行点名的路径都在 ⇒ 零；非验收行点名的路径不进射程", () => {
    const blocks = acceptanceBlocks(PLAN_FIXTURE);
    expect(blocks).toHaveLength(2);
    expect(
      missingGatePaths(
        blocks,
        existsOnly(
          "packages/hub/test/db/a.test.ts",
          "test/acceptance/b.test.ts",
        ),
      ),
    ).toEqual([]);
    // 那条 Commit 行里点的假路径不许被算进来 —— 否则守卫会去追历史叙述，
    // 而计划正文本来就该保留施工前的布局（那是它的职责，不是 bug）。
    expect(
      missingGatePaths(blocks, existsOnly("packages/hub/test/db/a.test.ts")),
    ).toEqual([{ lineNo: 6, path: "test/acceptance/b.test.ts" }]);
  });

  it("变异：一条住址漂了 ⇒ 红并点名路径与行号", () => {
    const out = missingGatePaths(
      acceptanceBlocks(PLAN_FIXTURE),
      existsOnly("test/acceptance/b.test.ts"),
    );
    expect(out).toEqual([
      { lineNo: 3, path: "packages/hub/test/db/a.test.ts" },
    ]);
  });

  it("变异：验收行前缀换了写法 ⇒ 抛红，不拿『0 条坏掉』过去", () => {
    // 计划被人整理过一次（把 Run 改成 执行）就够，而它换来的绿和判据死掉长得一样。
    // ⚠ 这一发第一版只 replace 了【第一处】，于是它没在测我以为在测的东西：夹具里有
    //   两条 Run 行，换掉一条后判据照读另一条，返回的是那条的真故障，而我断的是哨兵。
    //   「把改一处当成改全部」是这一族最常见的自欺 ⇒ 这里把两臂都钉下来。
    const partial = PLAN_FIXTURE.replace("**Run**", "**执行**");
    expect(acceptanceBlocks(partial).map((b) => b.lineNo)).toEqual([6]);
    expect(missingGatePaths(acceptanceBlocks(partial), existsOnly())).toEqual([
      { lineNo: 6, path: "test/acceptance/b.test.ts" },
    ]);
    // 两条全换掉 ⇒ 什么都取不到 ⇒ 必须是哨兵红，不是『0 条坏掉』。
    const renamed = PLAN_FIXTURE.replaceAll("**Run**", "**执行**");
    expect(acceptanceBlocks(renamed)).toEqual([]);
    expect(missingGatePaths(acceptanceBlocks(renamed), existsOnly())).toEqual([
      { lineNo: 0, path: "<计划里一条验收行都没解析到>" },
    ]);
  });

  it("变异：豁免标记被摘掉 ⇒ 同一条立刻红（豁免必须显式，不能是一句散文）", () => {
    const md =
      "# 计划\n" +
      runLine("test/e2e/never-built.spec.ts") +
      "\n  【登记：东西没建。" +
      NOT_BUILT_TAG +
      "】\n";
    const blocks = acceptanceBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(missingGatePaths(blocks, existsOnly())).toEqual([]);
    expect(exemptedBlocks(blocks)).toEqual([
      { lineNo: 2, paths: ["test/e2e/never-built.spec.ts"] },
    ]);
    // 把标记删掉 ⇒ 同一条必须红。豁免只能显式给，删了就恢复判。
    const stripped = acceptanceBlocks(md.replace(NOT_BUILT_TAG, ""));
    expect(missingGatePaths(stripped, existsOnly())).toEqual([
      { lineNo: 2, path: "test/e2e/never-built.spec.ts" },
    ]);
  });

  it("变异：把豁免标记改成肉眼可见的中文 ⇒ 红（钉的是这一串字节，不是一个意思）", () => {
    const md =
      "# 计划\n" + runLine("test/e2e/x.spec.ts") + "\n  【没建，见台账】\n";
    expect(missingGatePaths(acceptanceBlocks(md), existsOnly())).toEqual([
      { lineNo: 2, path: "test/e2e/x.spec.ts" },
    ]);
  });

  it("⭐ 反向 canary：豁免计数器【数得出 2】—— 真仓库那条 toBe(1) 不是写死的", () => {
    // 真仓库那一发把条数钉成【恰好 1】。少了这一发，一个恒返回「一条」的坏计数器
    // （比如 filter 写成 find、或者 map 前多塞一个 .slice(0,1)）在那一发上【照样绿】,
    // 而它换来的绿意味着：再多一道没建的门、或最后那条豁免被删，都不会有人看见。
    // 同一份判据、合成语料给两条标记 ⇒ 必须数出两条。这是「读数会被写死」那一族的
    // 标准解法（同 census.test.ts 那条 unresolved=1）。
    const md =
      "# 计划\n" +
      runLine("test/e2e/one.spec.ts") +
      "\n  【没建。" +
      NOT_BUILT_TAG +
      "】\n" +
      runLine("test/e2e/two.spec.ts") +
      "\n  【也没建。" +
      NOT_BUILT_TAG +
      "】\n";
    const ex = exemptedBlocks(acceptanceBlocks(md));
    expect(ex.map((e) => e.paths)).toEqual([
      ["test/e2e/one.spec.ts"],
      ["test/e2e/two.spec.ts"],
    ]);
    // 反向配对：只给一条 ⇒ 数出 1（证明上面那个 2 不是"永远数出两条"）。
    expect(
      exemptedBlocks(
        acceptanceBlocks(
          "# 计划\n" +
            runLine("test/e2e/one.spec.ts") +
            "\n  【" +
            NOT_BUILT_TAG +
            "】\n",
        ),
      ),
    ).toHaveLength(1);
  });

  it("路径 token 从反引号片段里【切】出来，不拿正则整段猜", () => {
    // 本轮我自己的前两个版本各猜错过一次：一版把「pnpm i -D vitest && pnpm test x/y.ts」
    // 整段当成一条路径去 existsSync，报了个【假故障】；另一版只认出 2 条（漏 4 条）。
    // 切 token 这一种既不会把命令当路径，也不会漏掉混写在命令末尾的路径。
    expect(pathTokens("`pnpm i -D vitest && pnpm test x/y.ts`")).toEqual([
      "x/y.ts",
    ]);
    expect(pathTokens("`pnpm verify`；`a/b.test.ts` 三条通过")).toEqual([
      "a/b.test.ts",
    ]);
    // 反引号【外】的路径不算 —— 计划正文里大量散文提到路径，那是叙述，不是验收。
    expect(pathTokens("见 test/gone/d.test.ts 这个文件")).toEqual([]);
  });
});

describe("门禁住址对账：真仓库那一半", () => {
  const plan = readPlan(ROOT);
  const blocks = acceptanceBlocks(plan);
  const missing = missingGatePaths(blocks, exists);

  it("每一条验收行点名的工件路径逐字存在，或被一行显式豁免标着", () => {
    expect(missing).toEqual([]);
  });

  it("读数可信：验收行、路径、豁免都不是空的（否则上面那条是空对空换来的绿）", () => {
    // round276 实测：6 条验收行 / 7 条路径 token / 2 条豁免（两道 Playwright 门，东西没建）。
    // ⚠ 那个「2」今天已经是 1 了（round291 建了 ceo-loop.spec.ts ⇒ 那条豁免按纪律摘掉），
    //   所以这里的下限取【当初读数的一半上下】而不是照抄 2：抄 2 会让这一发在
    //   「豁免被正当摘掉」那天恒红，而恒红的哨兵会被当噪音关掉（0055 那一族）。
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    const paths = blocks.flatMap((b) => pathTokens(b.text));
    expect(paths.length).toBeGreaterThanOrEqual(6);
  });

  it("豁免是【可数的账】：钉死为恰好那一条，且它真的豁免掉一条不存在的路径", () => {
    // round276 给的是上限 2（当时两道 Playwright 门都没建）。round293 改成【恰好 1】，
    // 理由同 comment-test-readers 那条 retracted 名单：给上下界各留一格才双向都响。
    //   往上走（2 条）= 有人又开了一道「东西没建」的门 ⇒ 该红一次，逼着当一件事登记；
    //   往下走（0 条）= 最后那条豁免被人静默删了 ⇒ mobile-approval.spec.ts 当场红，
    //     而那条红话长得像「计划里有个路径写错了」，不像「有人动了豁免」——
    //     这一格只有钉死条数才分得开。
    // 今天唯一活着的豁免是 test/e2e/mobile-approval.spec.ts：它要真飞书沙箱 + 真凭据，
    // 本机给不出可复核的形状。哪天有人真建了它，这里的 1 会变 0 ⇒ 红，来摘标记。
    const ex = exemptedBlocks(blocks);
    expect(ex.length).toBe(1);
    for (const e of ex) {
      const reallyMissing = e.paths.filter((p) => !exists(p));
      expect(
        reallyMissing.length,
        "豁免标记贴在一行【所有路径都存在】的位置上 ⇒ 它是死的豁免，该删",
      ).toBeGreaterThan(0);
    }
    // 且活着的那一条必须是 mobile-approval 那一格：换成别的路径 = 有人把标记挪了位置，
    // 那等于给一个【新的】没建的工件发了豁免，而它没经过任何论证。
    expect(ex[0]?.paths).toContain("test/e2e/mobile-approval.spec.ts");
  });

  it("本轮修的三处住址今天逐字存在（「我改过了」也要有一条能重跑的命令）", () => {
    // 这三条是本轮动手【之前】实测到的真故障（.workbuddy/round276-run-lines.ts 现数）：
    // 计划写的旧住址逐字不存在，而命令因为 vitest 的子串匹配照样绿。
    const fixed = [
      "packages/hub/test/db/driver-preflight.test.ts",
      "packages/hub/test/acceptance/phase1-gates.test.ts",
      "packages/hub/test/acceptance/phase3.test.ts",
    ];
    for (const p of fixed) expect(exists(p), p + " 应存在").toBe(true);
    // 且验收行里点名的路径集合【就是】这些真住址 —— 旧住址一条都不许残留。
    const named = new Set(blocks.flatMap((b) => pathTokens(b.text)));
    for (const p of fixed)
      expect(named.has(p), p + " 应被验收行点名").toBe(true);
    // 2026-11-17 round291：`test/e2e/ceo-loop.spec.ts` 已经建出来了，期望缺项因此【少一条】。
    // 这里必须是【精确相等】而不是 toBeEmpty / 长度下限：多出来一条没人登记的路径，
    // 与少了那条被摘掉豁免的路径，都得在这里红一次。
    // mobile-approval.spec.ts 【故意留着不建】：它要一个真飞书沙箱 + 真凭据，
    // 本机给不出可复核的形状 —— 那条豁免是活的（它确实豁免掉一条不存在的路径）。
    expect([...named].filter((p) => !exists(p))).toEqual([
      "test/e2e/mobile-approval.spec.ts",
    ]);
  });
});
