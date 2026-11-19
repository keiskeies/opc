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
  deadExemptions,
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

  it("死豁免判据：标记贴着「路径全都在」的行 ⇒ 数得出来；贴在那种豁免该在的行 ⇒ 数不出", () => {
    // 这一族在 2026-11-19 之前只活在真仓库那一发的循环里。豁免账清零（最后一条被正当
    // 摘掉）之后，那个循环遍历的是【空名单】⇒ 判据永不执行。round298 那句：
    // 「一个永远不可能进入的分支就是一句装饰」——所以判据搬进 deadExemptions，
    // 由这一发用合成语料真跑。两发方向相反，缺任一条另一条都可能是恒真/恒假。
    const md = (p: string): string =>
      "# 计划\n" + runLine(p) + "\n  【没建。" + NOT_BUILT_TAG + "】\n";
    // 该数出来：那条豁免点名的路径【全都存在】= 它是死的。
    expect(
      deadExemptions(acceptanceBlocks(md("test/e2e/dead.spec.ts")), () => true),
    ).toEqual([{ lineNo: 2, paths: ["test/e2e/dead.spec.ts"] }]);
    // 不该数出来：点名了一条真不在盘上的路径 = 那条豁免是活的（它的正当用途）。
    expect(
      deadExemptions(
        acceptanceBlocks(md("test/e2e/alive.spec.ts")),
        existsOnly(),
      ),
    ).toEqual([]);
    // ⚠ 混合行：同一块里两条路径，一条在一条不在 ⇒ 【不算死豁免】。
    // 判据是「至少一条真没建」，不是「全都没建」—— 后者会把「建了一半还留着标记」
    // 那种最该被发现的形状放过。这一发就是钉这一格的。
    const mixed =
      "# 计划\n" +
      runLine("test/e2e/one.spec.ts") +
      "\n  【`test/e2e/two.spec.ts` 也没建。" +
      NOT_BUILT_TAG +
      "】\n";
    expect(
      deadExemptions(
        acceptanceBlocks(mixed),
        existsOnly("test/e2e/one.spec.ts"),
      ),
    ).toEqual([]);
  });

  it("死豁免判据在【空名单】上返回空而不是抛（真仓库清零那天它就这么过）", () => {
    // 上面那发证「有死豁免时数得出」，这一发证「一条豁免都没有时它给出空」——
    // 真仓库那一发现在走的就是这条路。少了这一发，「名单空 ⇒ 抛」与「名单空 ⇒ 空」
    // 两种写法在这一族今天全绿的读数下分不出来。
    const md = "# 计划\n" + runLine("test/e2e/x.spec.ts") + "\n  【没建】\n";
    expect(deadExemptions(acceptanceBlocks(md), existsOnly())).toEqual([]);
    expect(exemptedBlocks(acceptanceBlocks(md))).toEqual([]);
  });

  it("⭐ 反向 canary：豁免计数器【数得出 2】—— 真仓库那条 toBe(0) 不是写死的", () => {
    // 真仓库那一发把条数钉成一个【精确值】（历史上是 1，2026-11-19 起是 0）。
    // 少了这一发，一个恒返回「一条」/「零条」的坏计数器（filter 写成 find、
    // map 前多塞一个 .slice(0,1)、或者干脆 return []）在真仓库那一发上【照样绿】,
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

  it("豁免账今天【清零】：一条都没有，而它清零之后仍是一条能红的账", () => {
    // 这条钉的是【恰好 0】，不是 toBeLessThanOrEqual(1) —— 理由是 r21 立起来的那条：
    // 单向的界只挡一个方向。清零之后方向只剩一个（有人又开一道「东西没建」的门），
    // 而它照样要红：多一条 ⇒ 这里红 ⇒ 逼着当一件事登记，而不是悄悄贴一枚标记过去。
    //
    // 这条 0 是 2026-11-19 落下来的：最后那条豁免（`test/e2e/mobile-approval.spec.ts`）
    // 的成立条件是「该文件不存在」，文件建出来那天条件就消失了。摘标记前先用本守卫
    // 自己的解析函数复算过（.workbuddy/round310-gate-block-probe.mjs）：那一条验收行
    // 点名的三条路径【全部存在】⇒ 按 deadExemptions 的定义，它当时已是「死的豁免」。
    expect(exemptedBlocks(blocks)).toEqual([]);
    // 清零之后这一发是真·空对空吗？不是：deadExemptions 在空名单上返回空，
    // 而它【判什么】由上面那三发合成语料钉着（含混合行那一发）。
    // 留在这里是为了：万一有人既贴回一枚标记、又让它贴在一行路径全都在的位置上，
    // 这一发与上面那一发【同时】红，红话一句说「有几条豁免」、一句说「其中有死的」。
    expect(deadExemptions(blocks, exists)).toEqual([]);
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
    // 2026-11-19：`test/e2e/mobile-approval.spec.ts` 也建出来了 ⇒ 期望缺项【清零】。
    // ⚠ 清零之后这一发反而【更严】了：它现在是「验收行点名的每一条路径都在盘上」，
    //   而豁免已经没有人可遮（上面那发把账钉成 0）。注意这一发【不看】豁免标记 ——
    //   所以「给一条路径全都在的行重新贴一枚标记」在这里遮不住任何东西，
    //   它只会在上面那一发上红。两发的口径差就是这一格的全部理由。
    expect([...named].filter((p) => !exists(p))).toEqual([]);
  });
});
