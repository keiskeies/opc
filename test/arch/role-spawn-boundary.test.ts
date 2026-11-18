/**
 * 安全边界守卫的测试。四格判据各配一发合成变异，外加真仓库那一半。
 *
 * ── 为什么必须先说清楚「真仓库那一发证明不了什么」──────────────────
 * 真仓库那几发是照着今天的形状写的，所以它今天必然绿。它证明的是「判据对现状成立」，
 * 不证明「判据对坏掉的形状会红」—— 后者只有变异能买（本仓第 N 次记这一族：
 * round274 的 M3、round275 的 P1/P4、round276 的 G4 全是同一课）。
 * 所以下面那四发合成变异才是这条守卫的验收，真仓库那一半只是让它不悬空。
 *
 * ⚠ 本文件是【语料之外】的一处陷阱聚集地，写的时候踩到三条老规矩：
 *  · 合成夹具里的 `"--permission-mode"` 是【字符串内容】，判据只看 f.adapter，
 *    不会扫到本文件 —— 所以这里可以直写坏形状，不需要像 plan-refs.test.ts 那样拼装。
 *  · 但 `checkBoundary` 的【红话】里含 HONESTY_MARK 那句原文，所以断言一律断
 *    【前缀】而不是整句，否则将来改措辞时会红在一个不相干的地方。
 *  · 每一发变异都配一句「它红了之后红的是哪一格」的期望，不只断"非空"。
 *    round275-P1 那一发的教训：断"返回几条"会在一发红换成另一发红时照样绿。
 */

import { describe, expect, it } from "vitest";

import {
  type BoundaryFacts,
  checkBoundary,
  codeStrings,
  HONESTY_MARK,
  listSrc,
  PROBE_KEYS,
  planModeAdjacent,
  readFacts,
  repoRoot,
  SPAWN_SITES_BASELINE,
  spawnCallSites,
} from "./role-spawn-boundary.js";

/** 一份【全都好】的夹具底座。每发变异只在这一份上改一处。 */
const GOOD_ADAPTER = [
  "/**",
  " * ⚠ 今天真的员工身上唯一生效的安全边界是本文件那两个参数 ⚠",
  " */",
  'export const ARGS = ["--permission-mode", "plan", "--output-format", "json"];',
  "export const p = spawn(bin, ARGS, { cwd, env });",
].join("\n");

const GOOD_TEST =
  'process.env["FAKE_CLAUDE_WRITE_TO"] = target;' +
  'process.env["FAKE_CLAUDE_NO_PLAN"] = "1";';

const facts = (over: Partial<BoundaryFacts>): BoundaryFacts => ({
  spawns: new Map([
    ["engine/claude.ts", 1],
    ["serve/dev-entry.ts", 1],
  ]),
  adapter: GOOD_ADAPTER,
  adapterTest: GOOD_TEST,
  ...over,
});

const red = (f: BoundaryFacts): string => checkBoundary(f).join("\n");

describe("安全边界守卫：四格判据（合成变异）", () => {
  it("底座：一份全都好的夹具必须【不红】", () => {
    // 这条不是凑数。缺了它，下面每一发「红」都可能只是夹具本身写坏了。
    expect(red(facts({}))).toBe("");
  });

  it("B1：把 plan 换成 bypassPermissions ⇒ 只有边界那一格红", () => {
    const f = facts({
      adapter: GOOD_ADAPTER.replaceAll('"plan"', '"bypassPermissions"'),
    });
    const msg = red(f);
    expect(msg).toContain('下一项不是 "plan"');
    // 反向对照：其余三格【不】跟着红。它们红说明夹具坏了，而不是这一发抓到了三件事。
    expect(msg).not.toContain("多出一个起子进程的位置");
    expect(msg).not.toContain(HONESTY_MARK);
    expect(msg).not.toContain("行为探针");
  });

  it("B2：--permission-mode 与它的值被拆开 ⇒ 相邻判据红，而「两处都有」那种写法是绿的", () => {
    // 这一发是【判据形状】的对照，不是坏法的对照：换成一个更松的判据它就绿了。
    // "plan" 仍在代码区里，只是不再紧跟参数名 —— 例如有人把参数表拆成两个常量。
    const loose = [
      "/**",
      " * ⚠ 今天真的员工身上唯一生效的安全边界是本文件那两个参数 ⚠",
      " */",
      'export const FLAG = "--permission-mode";',
      'export const OTHER = "--output-format";',
      'export const MODE = "plan";',
      "export const p = spawn(bin, [FLAG, OTHER, MODE], { cwd, env });",
    ].join("\n");
    expect(planModeAdjacent(loose)).toBe(false);
    // 松判据（只查两处都在）在这一发面前是【绿的】—— 这正是选「相邻」的理由。
    const s = codeStrings(loose);
    expect(s.includes("--permission-mode")).toBe(true);
    expect(s.includes("plan")).toBe(true);
    expect(red(facts({ adapter: loose }))).toContain('下一项不是 "plan"');
  });

  it("B3：诚实标注挪到代码之后 ⇒ 红（边界没变，读的人被误导了）", () => {
    const noMark = GOOD_ADAPTER.replace(
      " * ⚠ 今天真的员工身上唯一生效的安全边界是本文件那两个参数 ⚠\n",
      "",
    );
    const after =
      noMark +
      "\n/** 补一句：今天真的员工身上唯一生效的安全边界是本文件那两个参数 */\n";
    expect(red(facts({ adapter: after }))).toContain("第一行代码之前");
    // 反向对照一：同一份夹具【整句去掉】⇒ 也只红这一格（红因不是别的格）。
    expect(checkBoundary(facts({ adapter: noMark }))).toHaveLength(1);
    // 反向对照二：同一句话写在【第一行代码之前】的任意位置 ⇒ 不红。
    // 判的是位置（读代码之前先读到它），不是它处在哪一行 —— 后者是一个会腐烂的数：
    // 这里最初写的就是「文件头 15 行内」，而那句话今天在第 21 行，落地即红。
    expect(
      planModeAdjacent(GOOD_ADAPTER) &&
        checkBoundary(
          facts({
            adapter:
              "/**\n * 无关的一段\n * 又一行\n *\n * 今天真的员工身上唯一生效的安全边界在这里\n */\n" +
              'export const ARGS = ["--permission-mode", "plan"];\n' +
              "export const p = spawn(bin, ARGS);",
          }),
        ),
    ).toEqual([]);
  });

  it("B4：行为探针的对照那一半被摘掉 ⇒ 红", () => {
    for (const k of PROBE_KEYS) {
      const f = facts({ adapterTest: GOOD_TEST.replaceAll(k, "别的") });
      expect(red(f), k).toContain(k);
    }
  });

  it("B5：多一个 spawn( 的位置 ⇒ 红，且红话点名是谁", () => {
    const f = facts({
      spawns: new Map([
        ...[...facts({}).spawns],
        ["engine/new-runner.ts", 1] as [string, number],
      ]),
    });
    expect(red(f)).toContain("engine/new-runner.ts");
  });

  it("B6：判据自己的取材不能是空的（空集合会让上面五发全绿）", () => {
    // 这条是本仓最贵的一族：口径被改窄 ⇒ 判据静默不判。这里用「底座不红但取材为空」
    // 复现那个形状 —— 如果不钉住取材，B5 那种「多一个位置」永远不会有下一个。
    expect(red(facts({ spawns: new Map() }))).toContain("engine/claude.ts");
  });
});

describe("安全边界守卫：真仓库", () => {
  const root = repoRoot();
  const factsReal = readFacts(root);

  it("四格全过", () => {
    expect(checkBoundary(factsReal)).toEqual([]);
  });

  it("取材是真的：spawn( 命中集合与基线【逐字】同源，且每一处都有计数", () => {
    const hits = [...factsReal.spawns.keys()].sort();
    expect(hits).toEqual([...SPAWN_SITES_BASELINE].sort());
    for (const rel of SPAWN_SITES_BASELINE) {
      expect(factsReal.spawns.get(rel), rel).toBeGreaterThan(0);
    }
  });

  it("spawn( 的口径认得出 spawn / spawnSync 的差别，也不把注释算进来", () => {
    expect(spawnCallSites('spawn("a", []);')).toBe(1);
    expect(spawnCallSites('spawnSync("a", []);')).toBe(0);
    expect(spawnCallSites("// spawn(x)\n/* spawn(y) */ 'spawn(z)'")).toBe(0);
  });

  it("src 取材非空：至少 listSrc 的数量级不会一夜之间掉光", () => {
    // 下限而不是等值：等值会随每一次加文件而过期（本仓的家规）。
    expect(listSrc(root).length).toBeGreaterThan(80);
  });
});
