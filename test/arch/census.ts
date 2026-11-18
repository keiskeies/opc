/**
 * §1.1 那张表的【复算方法】—— O14 动作 3 欠的那一件（round293 还）。
 *
 * ── 为什么它必须【在仓库里】，而不是一段写在文档里的描述 ──────────────
 * 本篇两处自称这件事已经做了：§8 末「所以每个数都配了复算方法而不是配一个豁免」，
 * O14 动作 3「§1 那张表里的数全部标了『口径 + 复算方法』」。
 * 而 §1.1 自己写的是「复算脚本的形状（**不写进仓库**）」—— 给的是一段【描述】。
 * ⇒ 「怎么复算」在 round293 之前【没有可执行的答案】，那两句「配了复算方法」是
 *   【把"写了口径"当成"给了方法"】。本轮第一次真去复算，四条数【全部】对不上：
 *   83→92 / 35216→40871 / 108→135，而「11」看着没变 —— 它其实是【另一批模块】，
 *   换成表上写的那条口径（排除入口）今天给的是【7】。
 * 「不写进仓库」当初要避的是【多一个会过期的成员】，代价是那四条数变成
 * 【不可复核的数】—— 那正是 O14 全文要治的形状。⇒ 这一版选【写进仓库】。
 *
 * ── 为什么复用 ./dead-modules.ts 而不是自己解析 ──────────────────────
 * §1.1 自己就记着那条坑：按说明符子串匹配会把 `from "./timer.js"` 那种同目录 import
 * 整批漏掉，第一版因此数出 33 个死模块。本轮我又当场犯了一次：grep 'store\.js'
 * 找 charter/store 的调用方时，匹到的全是 evidence/store 那一族【别的】store。
 * ⇒ 复用同一个取材 + 同一张图。两处各解析一遍 = 同一套误读同时作用于两侧
 *   ⇒ 差集恒空 = 恒真判定（§7 第 4 格那一族）。
 *
 * ── 它【只测量，不判定】，这是刻意的 ────────────────────────────────
 * 不 assert 任何一个数，恒 exit 0（除非解析器自报悬空说明符 ⇒ 那时【抛】：
 * 建立在坏图上的读数不该被人抄进文档）。
 * 「数变了要有人知道」已有归属：dead-modules 判它的基线，claim-coords 判主张坐标。
 * 这里再造一个数上限 = 再造一个要有人记得改的地方。
 * 一条恒红的验收命令等于一条恒不可能通过的断言，而人会学会跳过它
 * （docs/review/verify-open-invariants.mjs 文件头那条同形教训）。
 *
 * 跑法：npx tsx test/arch/census.ts
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildGraph,
  collectModules,
  entryPoints,
  type Module,
  repoRoot,
} from "./dead-modules.js";

export type CensusRow = {
  readonly rel: string;
  readonly lines: number;
  /** 静态 import 它的模块。测试【不算】importer —— 这一格口径出自 collectModules。 */
  readonly importers: readonly string[];
  /** 它是不是根 package.json scripts 里直接起的文件（那种文件天然没人 import 它）。 */
  readonly isEntry: boolean;
};

/** 不含文件名的那半部分：纯图上的读数，合成语料就能算出来。 */
export type CoreCensus = {
  /** packages/hub/src 下非测试 .ts 的个数（口径与 dead-modules 取材逐字一致：排 poc/ 与探针）。 */
  readonly moduleCount: number;
  /** 同一批文件的行数总和。⚠ split("\n") 计数 ⇒ 以换行结尾的文件比 wc -l 【多 1】（实测 725 vs 724）。别拿 wc 对。 */
  readonly srcLines: number;
  /**
   * 零静态 importer 的模块，按行数降序。
   * §1.1 表上那条「其中 src 内零静态 importer（**排除入口**）」走 underEntries()，
   * 这里给的是【全量】：里面混着 cli.ts / hub-serve.ts / dev-entry.ts 那些
   * 从 scripts 起的文件，它们天然零 importer 而【不是】死代码。
   */
  readonly zeroImporter: readonly CensusRow[];
  /** 解析器自报的悬空相对说明符条数（非 0 ⇒ 上面这些数建立在坏图上，别看）。 */
  readonly unresolved: number;
};

export type Census = CoreCensus & {
  /** 全仓 *.test.ts 个数，按距根的第一段目录分桶。 */
  readonly testFiles: Readonly<Record<string, number>>;
};

const lineCount = (text: string): number => text.split("\n").length;

/** 纯核心：给一批模块算普查。合成语料的 canary 走这里，不碰盘。 */
export function censusOf(
  mods: readonly Module[],
  entries: ReadonlySet<string>,
): CoreCensus {
  const g = buildGraph(mods);
  const importers = new Map<string, string[]>(mods.map((m) => [m.rel, []]));
  for (const [from, tos] of g.edges) {
    for (const to of tos) importers.get(to)?.push(from);
  }
  return {
    moduleCount: mods.length,
    srcLines: mods.reduce((a, m) => a + lineCount(m.text), 0),
    zeroImporter: mods
      .filter((m) => (importers.get(m.rel) ?? []).length === 0)
      .map((m) => ({
        rel: m.rel,
        lines: lineCount(m.text),
        importers: importers.get(m.rel) ?? [],
        isEntry: entries.has(m.rel),
      }))
      .sort((a, b) => b.lines - a.lines),
    unresolved: g.unresolved.length,
  };
}

/** 全仓 *.test.ts，按距根的第一段目录分桶。 */
function countTestFiles(root: string): Record<string, number> {
  const out: Record<string, number> = {};
  const skip = new Set(["node_modules", ".git", "dist", ".workbuddy"]);
  const walk = (dir: string, bucket: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!skip.has(e.name)) {
          walk(join(dir, e.name), bucket === "" ? e.name : bucket);
        }
        continue;
      }
      if (!e.name.endsWith(".test.ts")) continue;
      const key = bucket === "" ? "(仓库根)" : bucket;
      out[key] = (out[key] ?? 0) + 1;
    }
  };
  walk(root, "");
  return out;
}

/** 跑一遍真普查。四条口径全部写死在这里，不在文档里另留一份。 */
export function census(root: string = repoRoot()): Census {
  return {
    ...censusOf(collectModules(root), entryPoints(root)),
    testFiles: countTestFiles(root),
  };
}

/** §1.1 表上那条口径：零 importer 且【不是】scripts 入口。 */
export function underEntries(c: CoreCensus): {
  readonly rows: readonly CensusRow[];
  readonly count: number;
  readonly lines: number;
} {
  const rows = c.zeroImporter.filter((r) => !r.isEntry);
  return {
    rows,
    count: rows.length,
    lines: rows.reduce((a, r) => a + r.lines, 0),
  };
}

function main(): void {
  const c = census();
  const sum = (rows: readonly CensusRow[]): number =>
    rows.reduce((a, r) => a + r.lines, 0);
  const print = (tag: string, rows: readonly CensusRow[]): void => {
    console.log(tag, rows.length, "行数 =", sum(rows));
    for (const r of rows) {
      console.log(
        "   ",
        r.rel.padEnd(30),
        String(r.lines).padStart(5),
        r.isEntry ? "← scripts 入口" : "",
      );
    }
  };

  console.log("① packages/hub/src 模块数    =", c.moduleCount);
  console.log("② src 行数（split('\\n')）     =", c.srcLines);
  console.log();
  print("③ 零静态 importer（全量）     =", c.zeroImporter);
  console.log();
  print("④ 零 importer 且非入口       =", underEntries(c).rows);
  console.log("   ↑ §1.1 表上那条口径读这一条，不是上面那条");
  console.log();
  console.log("⑤ 全仓 *.test.ts（按顶层目录）=", JSON.stringify(c.testFiles));
  console.log(
    "   （表上那条 108 的口径是 hub/test 78 + 根 test 30；packages 桶今天全是 hub/test）",
  );
  console.log("unresolved（必须 0）         =", c.unresolved);
  if (c.unresolved > 0) {
    throw new Error(
      "解析器报出 " +
        c.unresolved +
        " 条悬空相对说明符 ⇒ 上面这批数建立在坏图上，别看它们",
    );
  }
}

if (process.argv[1]?.endsWith("census.ts") === true) {
  main();
}
