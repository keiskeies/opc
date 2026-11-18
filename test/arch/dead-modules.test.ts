/**
 * 死模块哨兵：从任何入口都走不到的模块，必须**逐个带理由**登记在案。
 *
 * 一句话：这一族防的是「有实现 + 有测试 + 零调用方，而全仓没有任何测试会因为
 * 那条边不存在而红」。它不是代码质量守卫 —— 它守的是**关于代码的陈述**会不会过期。
 *
 * 判据的完整理由（为什么是可达性而不是零 importer、这个口径在两处会坏的地方）
 * 写在同目录 dead-modules.ts 的文件头，那里是唯一出处。这一头发过两次错，
 * 两次都正好是本守卫存在的理由的形状：
 *  ① 按说明符子串匹配 ⇒ 33 个假死模块（同目录 import 写成 "./timer.js"，不含目录名）；
 *  ② 按【零 importer】数 ⇒ `harness/gateway`/`safety`/`routing` 互相 import，
 *     整目录对外零边，3300 行安全层被数成「有人用」。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../../packages/hub/test/fixtures/fixture-dir.js";
import {
  BASELINE,
  type Baseline,
  buildGraph,
  checkBaseline,
  claimSites,
  collectModules,
  deadModules,
  dynamicEntryTargets,
  entryPoints,
  invalidBaselineMarks,
  type Module,
  reachabilityOf,
  repoRoot,
  scanSpecs,
  staleBaselineEntries,
  trackedRows,
} from "./dead-modules.js";
import { BOUNDARY_PROBE, isRuntimeFixture } from "./run-fixtures.js";

/**
 * 合成取材根（那条「并行探针不进取材」的 canary 要在一棵可控的小树上判）。
 *
 * 目录名带 pid，清理在下面的 afterAll 里 —— 这是全仓的夹具家规，
 * 由 `packages/hub/test/fixtures/fixture-dir.test.ts` 那条普查机械判（漏了就红）。
 * 先试 `finally` 里就地删、被那条普查判红之后改成现在这样：普查说的是「漏一次就
 * 漏一份夹具」，它不在乎你删得多勤，只在乎**进程中途死掉时那份还在磁盘上**。
 */
const TMP = fixtureTmp("dead-mod-root", import.meta.url);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * 合成一个三模块小世界：cli → a → b。
 * 两条 canary 都跑在它上面 —— 合成输入才**能**造出「新增死模块」这种红，
 * 真实仓库里造不出来（那需要在真代码里塞垃圾）。
 */
function tinyWorld(extra: readonly Module[] = []): Module[] {
  return [
    { rel: "cli.ts", text: 'import { a } from "./a.js";\n' },
    { rel: "a.ts", text: 'import { b } from "./b.js";\n' },
    { rel: "b.ts", text: "export const b = 1;\n" },
    ...extra,
  ];
}
/** 小世界的根显式给，不蹭真 package.json —— 否则这条 canary 会随 scripts 改动而变味。 */
const TINY_ROOTS = new Set(["cli.ts"]);
const EMPTY: Baseline = new Map();

describe("死模块哨兵", () => {
  /* ── 判据的判别力（合成语料，两条方向相反的 canary）── */

  it("canary 方向 A：新增一个不可达模块 ⇒ 判据红", () => {
    const base = deadModules(buildGraph(tinyWorld()), tinyWorld(), TINY_ROOTS);
    // 前提断言：小世界里全可达，此刻没有死模块。没有这句，下面那条红
    // 可能只是因为 roots 传错，而不是因为 orphan 被抓到。
    expect(base.dead.length).toBe(0);

    const withDead = tinyWorld([
      { rel: "orphan.ts", text: "export const x = 1;\n" },
    ]);
    const r = deadModules(buildGraph(withDead), withDead, TINY_ROOTS);
    const p = checkBaseline(r.dead, EMPTY, () => []);
    expect(p.length).toBe(1);
    expect(p[0]?.kind).toBe("新增死模块");
    expect(p[0]?.mod).toBe("orphan.ts");
    // 红行必须给出【下一步动作】，只说「死了」会被当成噪音。
    expect(p[0]?.why).toContain("接上");
  });

  it("canary 方向 B：基线里的模块变得可达 ⇒ 红，且点名该改哪几行主张", () => {
    const r = deadModules(buildGraph(tinyWorld()), tinyWorld(), TINY_ROOTS);
    expect(r.dead.length).toBe(0);
    // 拿一个【可达】的模块当基线条目 —— 这就是「有人把它接上了而主张还留着」的形状。
    const base: Baseline = new Map([["b.ts", "b"]]);
    const rows = [
      {
        file: "docs/x.md",
        text: "b 今天零调用方。\n第二行不提它。\nb 无人调用。\n",
      },
    ];
    const p = checkBaseline(r.dead, base, (m) => claimSites(m, rows));
    expect(p.length).toBe(1);
    expect(p[0]?.kind).toBe("基线里的已经活了");
    expect(p[0]?.why).toContain("BASELINE");
    expect(p[0]?.why).toContain("docs/x.md:1");
    expect(p[0]?.why).toContain("docs/x.md:3");
    // 不含没有否定词的那一行 —— 定位器要是恒报，这条红就没有信息量。
    expect(p[0]?.why).not.toContain("docs/x.md:2");
  });

  it("主张定位器：模块名与否定词【同行】才算主张", () => {
    const rows = [
      {
        file: "a.md",
        text: "harness/gateway 的 checkBudget 是注入的两个函数之一。\n",
      },
      { file: "b.md", text: "harness/gateway 对外零 import。\n" },
    ];
    // 第一行讲的是同一模块，但那不是「没人用它」的主张 ⇒ 不该报。
    expect(claimSites("harness/gateway.ts", rows)).toEqual(["b.md:1"]);
  });

  it("可达性真的沿边走，不是只看根", () => {
    const mods = tinyWorld();
    const r = reachabilityOf(buildGraph(mods), mods, TINY_ROOTS);
    // b 只被 a 引，必须靠闭包才够得着。roots 判据若退化成「只比根」，这条红。
    expect(r.has("b.ts")).toBe(true);
    expect(r.has("cli.ts")).toBe(true);
  });

  it("相对说明符解析不到时必须进 unresolved，不能被当成外部包放掉", () => {
    const mods = tinyWorld([
      { rel: "c.ts", text: 'import { z } from "./nope.js";\n' },
    ]);
    const g = buildGraph(mods);
    expect(g.unresolved.join(" ")).toContain("c.ts → ./nope.js");
    // 而且它不能被塞进 external（塞进去就等于宣布「那是个外部依赖」放过了）。
    expect([...g.external.keys()].some((k) => k.startsWith("."))).toBe(false);
  });

  /* ── 「扫全文会把数据当引用」这一族：注释与字符串里的说明符不是 import ── */

  it("注释里的说明符【不算 import】，但必须留在 commentOnly 里可核对", () => {
    // 合成 canary 钉判据本身：真实语料那一发只能证明「今天没坏」，
    // 判据哪天坏回去（比如有人把挖注释那步删了）要靠这条先红。
    const mods = tinyWorld([
      {
        rel: "d.ts",
        text: '// 反例：import { z } from "./nope.js"\nexport const d = 1;\n',
      },
    ]);
    const g = buildGraph(mods);
    expect(g.unresolved.join(" ")).toBe("");
    expect(g.commentOnly.join(" ")).toContain("d.ts → ./nope.js（注释）");
  });

  it("真实语料：注释里那条 ./worker-loader.js 是全仓不存在的模块，只能待在 commentOnly", () => {
    const g = buildGraph(collectModules());
    // 这一发是实测撞出来的：worker-entry.ts 的注释拿它当【解析不了的反例】，
    // 而 worker-loader 全仓不存在。第一版把它读成真 import ⇒ unresolved 报出一条
    // 【并不存在】的悬空引用。落点必须是 commentOnly，不是 unresolved。
    expect(g.commentOnly.join("\n")).toContain(
      "db/worker-entry.ts → ./worker-loader.js（注释）",
    );
    // 反向配对：只断言「commentOnly 里有」不够 —— 还得钉「unresolved 里没有」，
    // 否则哪天两处都报，这条测试照样绿。
    expect(g.unresolved.join(" ")).not.toContain("worker-loader");
    // 全仓真实 import 一条都没被挖掉：这条边必须还在。
    const r = deadModules(g, collectModules());
    expect(r.edgeCount).toBeGreaterThan(100);
  });

  it("字符串字面量里的 import 也不算边（判据认引用，不认字节）", () => {
    const mods = tinyWorld([
      {
        rel: "e.ts",
        text: 'export const src = `import { q } from "./b.js"`;\n',
      },
    ]);
    const g = buildGraph(mods);
    // 那串文本讲的是 b.js，但它是【一段被当作数据的代码】，不是引用 ——
    // 于是 e 仍然不可达。这条红了说明字符串扫描坏了，坏起来是【凭空多一条边】，
    // 会把死模块洗成活的（比漏判更糟，正是本守卫要防的方向）。
    const r = deadModules(g, mods, TINY_ROOTS);
    expect(r.dead).toContain("e.ts");
    // 小世界只剩 cli→a→b 两条边：多一条 = 那串模板被当成了引用。
    expect(r.edgeCount).toBe(2);
  });

  it("扫描器逐条分得清代码与注释（判据的最小单元，不经 buildGraph 直接判）", () => {
    // buildGraph 只在说明符【解析得到模块】时才留下痕迹，合成语料里那些解析不到的
    // 说明符全靠这一条直接盯 scanSpecs 的返回，否则「代码/注释」这个区分没被测到。
    const hits = scanSpecs(
      [
        'import { a } from "./a.js";',
        '// 反例 import "./nope.js"',
        '/* 块里 from "./blk.js" 与 import "./blk2.js" */',
        'const t = `模板里 import "./tpl.js"`;',
        "const s = \"单引号里 import './sq.js' 不算\";",
        'const x = fooimport "./word.js";',
        'const dyn = await import("./dyn.js");',
      ].join("\n"),
    );
    const code = hits.filter((h) => !h.inComment).map((h) => h.spec);
    const cmt = hits.filter((h) => h.inComment).map((h) => h.spec);
    expect(code).toEqual(["./a.js", "./dyn.js"]);
    expect(cmt.sort()).toEqual(["./blk.js", "./blk2.js", "./nope.js"]);
    // 这三条各钉一个失败模式，缺一条就是给「凭空多一条边」留门：
    //  模板串 / 单引号串内容不算引用；`fooimport` 那个 import 不在词首，不算前导词。
    expect([...cmt, ...code].some((s) => /tpl|sq|word/.test(s))).toBe(false);
  });

  it("口径边界有哨兵：判据只认双引号说明符，而全仓 import 全是双引号", () => {
    // SPEC_RE 只匹配双引号。哪天有人写了一条单引号 import，那条边会【静】丢失，
    // 被连的模块判成不可达 ⇒ 主断言红，但红因会被误读成「多了个死模块」。
    // 这一条把真实原因摆在前头。它不锁进度：改成单引号是合法写法，那时要回来
    // 扩 SPEC_RE，不是关掉这条 —— 别照字面理解成「本仓禁止单引号」。
    const single = collectModules().filter((m) => /from\s+'/.test(m.text));
    expect(single.map((m) => m.rel).join(", ")).toBe("");
  });

  /* ── 取材与入口：判据成立的前提 ── */

  it("取材口径：src 下非测试 .ts，poc 不进范围", () => {
    const mods = collectModules();
    // 前提断言。取材一旦空掉，下面所有断言都会【全都成立】—— 恒绿装饰。
    expect(mods.length).toBeGreaterThanOrEqual(50);
    expect(mods.some((m) => m.rel.endsWith(".test.ts"))).toBe(false);
    expect(mods.some((m) => m.rel.startsWith("poc/"))).toBe(false);
    expect(mods.some((m) => m.rel === "engine/dispatch.ts")).toBe(true);
  });

  it("并行探针不进取材，而【长得像探针的真模块】照旧进（排除名单不是前缀通配）", () => {
    // 实测：并行跑 arch 全套时偶发一条「新增死模块 <探针名>」，单跑恒绿。
    // 成因是 dependency-boundary.test.ts 往 packages/hub/src/ 现场写一个探针再删掉，
    // 而本仓另三个扫描型守卫早就从 run-fixtures.ts 取排除名单，本守卫漏了这一格。
    // 「只在并发下出现的红」会被当噪音关掉（0007 §4.1），所以修在判据里而不是忽略它。
    mkdirSync(join(TMP, "packages", "hub", "src"), { recursive: true });
    const put = (n: string): void =>
      writeFileSync(
        join(TMP, "packages", "hub", "src", n),
        "export const x = 1;\n",
      );
    put("real.ts");
    put(BOUNDARY_PROBE);
    // 同一种命名风格、但【不在】排除名单里的文件：必须被取到。
    // 没有这一句，排除名单坏成「一切下划线开头的都排除」时上面那条照样绿。
    put("_other_probe.ts");
    put("keep.test.ts");
    const rels = collectModules(TMP).map((m) => m.rel);
    expect(rels).toContain("real.ts");
    expect(rels).toContain("_other_probe.ts");
    expect(rels).not.toContain(BOUNDARY_PROBE);
    expect(rels).not.toContain("keep.test.ts");
    // 反向配对：合成树【确实取到了东西】，否则上面两条 not.toContain 是空的成立。
    expect(rels.length).toBe(2);
    // 取材根必须是**真给了**才生效：默认值那条路径写死在本机，若注入被忽略、
    // 悄悄回落到真仓库，上面四条断言会全部成立而这条测试什么都没判。
    expect(collectModules(TMP).length).not.toBe(collectModules().length);
  });

  it("真语料里没有残留的运行时探针（排除名单今天确实在起作用）", () => {
    // 若哪天探针被【留下】成了源码的一部分，它会带着 better-sqlite3 那条越界 import
    // 混进活代码。那不归本守卫管，但先在这里红一次，提示去看 run-fixtures.ts。
    expect(
      collectModules()
        .filter((m) => isRuntimeFixture(m.rel))
        .map((m) => m.rel)
        .join(", "),
    ).toBe("");
  });

  it("静态入口从 package.json 的 scripts 推，且每个都指向真实模块", () => {
    const entries = entryPoints();
    expect(entries.size).toBeGreaterThanOrEqual(3);
    const rels = new Set(collectModules().map((m) => m.rel));
    for (const e of entries) {
      // 上一版在这里多拼了一次 .ts 得到 "cli.ts.ts" ⇒ 闭包空转 ⇒
      // 83 个模块里 77 个被判成死模块，而它只以「基线对不上」的形状出现。
      expect(e.endsWith(".ts.ts")).toBe(false);
      expect(rels.has(e) ? "ok" : e + " 指向一个不存在的模块").toBe("ok");
    }
  });

  it("动态入口：worker 从 selfWorkerUrl 推出来，否则可达性会判它们死了", () => {
    const mods = collectModules();
    const dyn = dynamicEntryTargets(mods);
    expect(dyn.size).toBeGreaterThanOrEqual(1);
    const r = deadModules(buildGraph(mods), mods);
    for (const d of dyn) {
      expect(d.endsWith(".worker.ts")).toBe(true);
      // 关键：推出来之后它必须【不在】死模块清单里。这一句才是这条 canary 的落点，
      // 光断言「推得出来」不判后果，等于没判。
      expect(r.dead.includes(d) ? d + " 仍被判成死模块" : "ok").toBe("ok");
    }
  });

  /* ── 真实仓库：三条主断言 ── */

  it("真实语料：解析量非零（判据坏起来的第一个症状是一条边都没解析出来）", () => {
    const mods = collectModules();
    const r = deadModules(buildGraph(mods), mods);
    expect(r.edgeCount).toBeGreaterThan(100);
    expect(r.unresolved.join(" ")).toBe("");
    console.info(
      "  [死模块哨兵] 模块 " +
        r.total +
        " · 边 " +
        r.edgeCount +
        " · 静态入口 " +
        (r.roots.length - r.dynamic.length) +
        " · 动态入口 " +
        r.dynamic.length +
        " · 不可达 " +
        r.dead.length,
    );
  });

  it("基线每条的特征串都可核对：在本模块出现，且其余 src 模块一次都不出现", () => {
    /**
     * 这一格是【防退化的下界】，不是棘轮：它只管"核对本身有没有东西可核对"，
     * 判据本体是下面那句 invalidBaselineMarks。
     *
     * 14 = 16 − 2。round281（O12 动作 2）按【设计死法方向 B】摘掉了
     * `channels/abstraction.ts` 与 `channels/approval-bridge.ts` 两条 ——
     * 那不是把下界调低一点，是两条基线条目各自兑现了它们登记的死法。
     * ⚠ 下一次动这个数字之前先问：这两条差额有没有一条登记过的死法对应？
     * 没有就是有人删了基线条目而没接线，那种删法正是这条下界存在的全部理由。
     */
    expect(BASELINE.size).toBeGreaterThanOrEqual(14);
    expect(invalidBaselineMarks(BASELINE, collectModules()).join("\n")).toBe(
      "",
    );
  });

  it("基线自证：每条今天确实还不可达（活着的条目留在表里就是假账）", () => {
    const r = deadModules(buildGraph(collectModules()), collectModules());
    expect(staleBaselineEntries(BASELINE, r.dead).join(", ")).toBe("");
  });

  it("主断言：不可达集合与基线一模一样，一个不多一个不少", () => {
    const mods = collectModules();
    const r = deadModules(buildGraph(mods), mods);
    const problems = checkBaseline(r.dead, BASELINE, (m) =>
      claimSites(m, trackedRows()),
    );
    // 红了要能认出是哪一条：数组只报 Array(1)，拼串才点名。
    expect(
      problems.map((p) => p.kind + " " + p.mod + " ⇒ " + p.why).join("\n"),
    ).toBe("");
  });

  it("主张取材本身有判别力：取材为空必须抛，不能读成【没有过期主张】", () => {
    // 注入一个返回空的取材器（0006 §7 第 22 条那个形状：没拿到 ≠ 没问题）。
    expect(() => trackedRows(repoRoot(), () => [])).toThrow(/判据失效/);
    // 反向配对：只写【为空要抛】，取材器坏成恒空时它自动成立 ⇒ 必须有一条【正常时要拿到】。
    expect(trackedRows().length).toBeGreaterThan(20);
  });

  /* ── 口径本身的证据：可达性比【零 importer】多抓到的那一族 ── */

  it("口径差异有读数：存在【有 importer 却仍不可达】的模块", () => {
    const mods = collectModules();
    const g = buildGraph(mods);
    const r = deadModules(g, mods);
    // 谁 import 了它（src 内）。
    const importers = new Map<string, string[]>();
    for (const [from, tos] of g.edges)
      for (const to of tos) {
        const a = importers.get(to) ?? [];
        a.push(from);
        importers.set(to, a);
      }
    const inherited = r.dead.filter((m) => (importers.get(m) ?? []).length > 0);
    // 这一发钉的是【口径】不是进度：`harness/*` 互相 import、`graph/gates/*` 只被
    // 不可达的簇用 —— 按【零 importer】数，它们每一个都"有人用"，全数漏判。
    // 它哪天变空，说的是这一族已被接光 ⇒ 那时要重推口径、重挑判据，不是放宽它。
    expect(inherited.length).toBeGreaterThan(0);
    for (const m of [
      "harness/gateway.ts",
      "harness/safety.ts",
      "harness/routing.ts",
    ]) {
      // 这三个互相 import ⇒ 每个都有 importer，而整目录对外零边。
      // 断言方向：它【必须】在 inherited 里（在 = 零 importer 口径会漏判它）。
      // 上一版这里三元写反了，红的是「它没在」—— 正好把这个口径的证据判成了反的。
      expect(
        inherited.includes(m) ? "ok" : m + "：不在漏判族里（口径差异没被测到）",
      ).toBe("ok");
    }
  });

  /* ── O6-1 验收：优化设计文档要的那两条，一条不落 ───────────────────── */

  /**
   * 「不许再断」不是一句口号，它是一条**四状态链**，而链条的每一环住在不同函数里。
   *
   * 优化设计文档 O6 的验收原文要两样东西：① `engine/` 必须 import `harness/gateway`，
   * 缺则红 —— 那是**接线之后**才存在的断言，今天就红的那条按 0056 的结论不能写
   * （恒不可能通过的验收命令 = 恒红断言，读久了和没有一样）。② 「`harness/` 若再次
   * 变成对外零 import，红」—— 这条**今天就能判**，而且判它的就是本文件：方向 A。
   *
   * ⚠ 而 ② 只在**基线里那条已被删掉**之后才成立。基线条目还在的时候，
   * 「死 + 在基线」正是守卫眼中的【预期状态】⇒ 绿。所以真正的保证不是方向 A 本身，
   * 而是「方向 B 会一直红，直到你把那条删掉」—— 它把【删基线】从"记得做的好事"
   * 变成"不红就得做"。这条 canary 判的就是这整条链，而不只是链尾。
   *
   * 合成小世界（不走真仓库）：根 cli → engine，gateway 挂在 engine 上或摘下。
   */
  it("「不许再断」是四状态链：接上→红着逼你删基线→删了→再断就红", () => {
    const MOD = "harness/gateway.ts";
    const withGateway = (wired: boolean): Module[] => [
      { rel: "cli.ts", text: 'import { e } from "./engine.js";\n' },
      {
        rel: "engine.ts",
        text: wired
          ? 'import { g } from "./harness/gateway.js";\nexport const e = g;\n'
          : "export const e = 1;\n",
      },
      { rel: "harness/gateway.ts", text: "export const g = 1;\n" },
    ];
    const claims = [
      { file: "docs/x.md", text: "harness/gateway 对外零 import。\n" },
    ];
    const run = (wired: boolean, base: Baseline) =>
      checkBaseline(
        deadModules(
          buildGraph(withGateway(wired)),
          withGateway(wired),
          TINY_ROOTS,
        ).dead,
        base,
        (m) => claimSites(m, claims),
      );
    const base: Baseline = new Map([[MOD, "g"]]);
    const NO = "无红";
    /** 一个状态 -> 它该判出的结论（条数 + 红因）。 */
    const verdict = (wired: boolean, b: Baseline): string => {
      const p = run(wired, b);
      return p.length === 0 ? NO : p.map((x) => x.kind).join("+");
    };

    /**
     * 五个状态【合成一条】断言。这不是省事，是为了让它【删不掉】：
     * 分五行的写法里，状态③（接上了、基线也删了 ⇒ 绿）那一行整行删掉测试照样绿
     * —— 变异实验里活下来的正是那一格。而它一旦进了下面这张表，删掉任何一行
     * 都让拼出来的串变短 ⇒ 立刻红。一行删了不改变任何结果的断言，是绿色测试里的
     * 装饰物，比没写更坏：它让后面那条看起来"有前提"。
     *
     * 状态①（= 今天）必须【是绿的】：它是「有实现、有测试、零调用方而全仓不红」
     * 那个形状本身 —— 本守卫存在的理由，不是它的失效。
     * 状态⑤是这套机制的【边界】：接过之后再断会红，但「从来没接上」不红
     * （那是 O6 的动作本体，不是守卫的账）。不写这一格，读这张表的人会以为链子更长。
     */
    const states = [
      "①断了+在基线(今天) = " + verdict(false, base),
      "②接上+在基线 = " + verdict(true, base),
      "③接上+删了基线 = " + verdict(true, EMPTY),
      "④再断+删了基线 = " + verdict(false, EMPTY),
      "⑤再断+基线还在(边界,不判) = " + verdict(false, base),
    ];
    expect(states.join(" | ")).toBe(
      [
        "①断了+在基线(今天) = " + NO,
        "②接上+在基线 = 基线里的已经活了",
        "③接上+删了基线 = " + NO,
        "④再断+删了基线 = 新增死模块",
        "⑤再断+基线还在(边界,不判) = " + NO,
      ].join(" | "),
    );

    // 状态②的红行还要额外判两样：点名模块、点名该改的主张行、并给出下一步动作。
    // （只说"它活了"会被当噪音关掉 —— checkBaseline 那段理由的实测版。）
    const wired = run(true, base);
    expect(wired[0]?.mod).toBe(MOD);
    expect(wired[0]?.why).toContain("docs/x.md:1");
    expect(wired[0]?.why).toContain("BASELINE");

    /**
     * 真实仓库此刻在状态①：四个安全层模块都还躺在基线里。
     *
     * 这一格的角色是【进度读数】而不是主判据 —— 主判据是上面「主断言」那条
     * （不可达集合 ≡ 基线）。两者都会红，但红话不一样：主判据说"集合对不上"，
     * 这一格说"你正在接线，O6 的文档状态该跟着改"。
     * 判据是 `dead ∧ inBaseline` 两个条件【都要】成立。变异实验：只留 `dead` 那半边
     * 测试仍绿（今天四个都还死着），因为"从基线被删掉而仍是死的"那条形状另有主判据
     * 兜（方向 A）。留着 BASELINE 那半边不是为了独占抓什么，是为了让这条红**说对话** ——
     * 少了它，一个已被移出基线的模块会在这里被叫成"还在状态①"，那是句假话。
     */
    const real = new Set(
      deadModules(buildGraph(collectModules()), collectModules()).dead,
    );
    const FOUR = [
      "harness/gateway.ts",
      "harness/safety.ts",
      "harness/routing.ts",
      "harness/verifier.ts",
    ] as const;
    const readout = (b: Baseline): string =>
      FOUR.map(
        (m) => m + "=" + (real.has(m) && b.has(m) ? "状态①" : "已离开状态①"),
      ).join(" ; ");
    const ALL1 = FOUR.map((m) => m + "=状态①").join(" ; ");
    expect(readout(BASELINE)).toBe(ALL1);
    // 控制组：把 gateway 那一格从基线里【临时】拿掉，读数必须翻。
    // 没有这一条，上面那句里的 `b.has(m)` 是装饰品 —— 删掉它照样绿（变异实验实测）。
    // 这才是它该有的样子：一个条件若在两个输入下给出同一个答案，它就没在判任何东西。
    //
    // ⚠ 这条控制【防的是判据坏掉】，不防"有人把这行删了"（删了它，M5 那种判据变异
    // 会重新活下来，而这条红不会自己响 —— 任何控制都自证不了自己还在）。
    // 所以别把它当冗余简化掉：上面那条在两个输入下都绿，只有这一条能分辨它们。
    expect(readout(new Map([...BASELINE].filter(([k]) => k !== MOD)))).not.toBe(
      ALL1,
    );
  });

  /**
   * 横幅必须**机器可见** —— 这条是被自己咬出来的。
   *
   * `engine/claude.ts` 头部那段「今天唯一生效的安全边界」第一版把四个模块名写在一行、
   * "对外零 import" 落在**下一行**，claimSites 一处都没扫到 ⇒ 那段话写是写了，
   * 接线那天方向 B 不会点名它，横幅就不会自删。也就是说：**它看起来兑现了 O6-1，
   * 而兑现的那一格是零。** 这正是本仓最恨的形状（有主张、有注释、零效果）。
   *
   * 所以这里不只测口径，还【逐文件】拿真横幅判：只判"全仓至少有一处"不够 ——
   * 别的文件替它说话， drift 就藏在别人的行里。
   */
  it("横幅的机器可见性：模块名与否定词必须【同一行】，换行排版就失效", () => {
    const SRC_ONLY = [
      "harness/gateway.ts",
      "harness/safety.ts",
      "harness/routing.ts",
      "harness/verifier.ts",
    ];
    const root = repoRoot();
    const rowsOf = (rel: string) => [
      {
        file: "packages/hub/src/" + rel,
        text: readFileSync(join(root, "packages/hub/src", rel), "utf8"),
      },
    ];
    const invisible: string[] = [];
    const misplaced: string[] = [];
    for (const m of SRC_ONLY) {
      const hits = claimSites(m, rowsOf(m));
      if (hits.length === 0) invisible.push(m);
      // 命中的得是【文件头那几行】，不是正文里某句巧合 —— 横幅在 line 2。
      else if (!/:[1-9]$|:1[0-5]$/.test(hits[0] as string))
        misplaced.push(m + " → " + hits[0]);
    }
    // 0 处 = 那文件的横幅对哨兵是隐形的（写反了、被重排了、被删了）。
    // 比【拼好的串】：数组只报 Array(0)，认不出是哪个模块的横幅坏了。
    // （顺带：上一版这里写成 expect(x, "说明") —— vitest 没有这个重载，
    // 于是红是 TypeError「actual must be number」而不是我的断言红，读起来像夹具坏了。）
    expect("横幅隐形：" + invisible.join(", ")).toBe("横幅隐形：");
    expect("命中不在文件头：" + misplaced.join(", ")).toBe("命中不在文件头：");

    // 口径的两面：同行才算，分两行不算。缺了反面，"恒报"也能让上面四条通过。
    const same = "harness/gateway.ts 对外零 import。\n";
    const split =
      "harness/gateway.ts、harness/safety.ts\n四个文件今天对外零 import。\n";
    const one = (t: string) =>
      claimSites("harness/gateway.ts", [{ file: "t", text: t }]);
    expect(one(same).length).toBe(1);
    // ⚠ 这条是【已知口径】不是理想行为：名字与否定词被换行拆开时，主张对哨兵隐形。
    // 记在这里而不是当场放宽正则，是因为放宽成"跨行找最近的否定词"会把
    // 「gateway 的 checkBudget 是注入函数。\n…（三段后）…没人调用它」这类正常散文判成主张。
    // 代价由上面那条真横幅守卫承担：谁重排了横幅，谁红。
    expect(one(split).length).toBe(0);
  });
});
