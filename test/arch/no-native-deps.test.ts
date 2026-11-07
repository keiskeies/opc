import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { BOUNDARY_PROBE } from "./run-fixtures.js";

/**
 * D6-a 的机械防线：生产源码不得依赖任何原生 SQLite 模块。
 *
 * 为什么不能只靠规格里写一句「我们用 node:sqlite」：官方 SqliteSaver 依赖
 * better-sqlite3，它的 build/Release/better_sqlite3.node 实测就在仓库里（1.9MB）。
 * 有人在生产路径 import 一次，打包产物就会带上平台相关的 .node —— 这正是 D6 要消灭
 * 的失效模式，而且平时测试全绿，只在打包后的用户机器上暴露。
 *
 * 与 Task 0.2 的 dependency-boundary 是不同维度，不是重复：那条按 package 划界
 * （hub 内允许 SQLite），本条在 hub 内部再切一刀：hub 生产代码只许 node:sqlite。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = join(ROOT, "packages");

// 原生 / 第三方 SQLite 实现。node:sqlite 不在其中 —— 那正是我们要用的。
const FORBIDDEN = [
  "better-sqlite3",
  "@langchain/langgraph-checkpoint-sqlite",
  "sql.js",
];

const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

/**
 * 刻意豁免：PoC 与 Phase 0 证据。
 *
 * packages/hub/src/poc、test/poc、docs/superpowers/evidence/phase0-poc 用官方
 * SqliteSaver 验证过 LangGraph 的 Checkpoint 语义（门禁 #2 的可复现证据），它们不是
 * 产品代码：.mjs 不在 hub tsconfig 的 include 内，不进 dist，也不进 Electron 产物。
 * 豁免必须显式列在这里，而不是靠「恰好没扫到」。
 */
const EXEMPT_DIRS = ["poc"];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "out"
      )
        continue;
      walk(full, out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * dependency-boundary.test.ts 的运行期夹具名。
 *
 * 那个测试【故意】往 packages/{desktop,web,hub}/src/ 写含 better-sqlite3 的越界探针，
 * 用来验证 biome 拦得住；探针随它创建、随它删除，不被 git 跟踪。vitest 跨文件并行，
 * 本守卫与它并发就会撞上（实测 pnpm verify 里间歇性假失败，连跑三次中红一次）。
 *
 * 排除它的理由不是「让测试变绿」：本守卫守的是【可能进产物的源码】，而夹具不在构建
 * 输入里、也不进 Electron 包。名字由两边各自写死并互相注释指向，改名时两边都撞得见。
 */
const TEST_FIXTURE = BOUNDARY_PROBE;

function isExempt(file: string): boolean {
  const rel = file
    .slice(ROOT.length + 1)
    .split(/[\\/]/u)
    .join(posix.sep);
  if (rel.split(posix.sep).includes(...EXEMPT_DIRS)) return true;
  // 并发夹具不是源码：见 TEST_FIXTURE 的注释
  return rel.endsWith(TEST_FIXTURE);
}

it("生产源码不依赖任何原生 SQLite 模块（D6-a）", () => {
  const files = walk(PACKAGES).filter((f) => !isExempt(f));
  // 元守卫：遍历失效会返回空清单，空清单绝不能当作「检查通过」
  expect(files.length, "扫描到 0 个文件 = 遍历失效").toBeGreaterThan(10);

  const hits: Hit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "latin1");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const mod of FORBIDDEN) {
        const quoted =
          line.includes(DQ + mod + DQ) || line.includes(SQ + mod + SQ);
        if (quoted) {
          hits.push({
            file: file.slice(ROOT.length + 1),
            line: i + 1,
            text: line.trim().slice(0, 90),
          });
        }
      }
    });
  }

  expect(
    hits,
    "原生 SQLite 依赖会毁掉 D6（零原生模块）。若确属 PoC 用途，请把所在目录加入 EXEMPT_DIRS 并写明理由：\n" +
      hits.map((h) => h.file + ":" + h.line + " " + h.text).join("\n"),
  ).toEqual([]);
});
