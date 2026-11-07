/**
 * 测试清单比对：只有纯函数，故单独成模块（同 index-diff.ts 的理由：noExportsInTest）。
 *
 * 这里刻意【不】复刻 vitest 的 glob 语义 —— collected 一侧来自 `vitest list --files-only`，
 * 是 vitest 自己给出的权威清单。expected 一侧用一条【比 include 更宽】的命名规则枚举磁盘：
 * 两侧若用同一套规则，规则本身的盲区会同时作用于两侧，差集恒为空 —— 那是恒真判定，
 * 见 0006 §7 第 11 条。所以规则必须单向放宽：多算只会多报，绝不会漏报。
 */

const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IGNORED_DIRS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".tmp",
]);

export type Inventory = { expected: string[]; collected: string[] };
export type InventoryDiff = { uncollected: string[]; phantom: string[] };

/** 比 vitest include 更宽：.test.* 与 .spec.*，扩展名含 mjs/js，位置不限。 */
export function looksLikeTest(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.some((s) => IGNORED_DIRS.has(s))) {
    return false;
  }
  return TEST_NAME.test(segs[segs.length - 1] ?? "");
}

/** `vitest list --files-only` 的输出：每行一条仓库相对路径，顺序不保证。 */
export function parseFilesOnly(out: string): string[] {
  return out
    .split(String.fromCharCode(10))
    .map((l) => l.trim().replace(new RegExp(String.fromCharCode(92), "g"), "/"))
    .filter((l) => TEST_NAME.test(l))
    .sort();
}

export function diffInventory(inv: Inventory): InventoryDiff {
  const c = new Set(inv.collected);
  const e = new Set(inv.expected);
  return {
    uncollected: [...e].filter((x) => !c.has(x)).sort(),
    phantom: [...c].filter((x) => !e.has(x)).sort(),
  };
}

/**
 * 为什么没被收集：只给诊断文案，不参与判定（判定只看差集）。三个形状都是本轮实测过的，
 * 不是推测。文案不准也不会让守卫给出错误结论。
 */
export function explain(rel: string): string {
  const name = rel.split("/").pop() ?? rel;
  const inRoot = rel.startsWith("test/");
  const inPkgTest = /^packages\/[^/]+\/test\//.test(rel);
  const named = TEST_NAME.test(name);
  if (/\.spec\.[cm]?tsx?$/.test(name)) {
    return "命名是 .spec.ts，但 vitest include 只收 *.test.{ts,tsx} —— 计划 Task 4.7 要求的正是这种命名";
  }
  if (/\.(test|spec)\.mjs$|\.(test|spec)\.js$/.test(name)) {
    return "扩展名不在 include 的 {ts,tsx} 里";
  }
  if (named && !inRoot && !inPkgTest) {
    return "位置不在 test/ 或 packages/*/test/ 下";
  }
  return "原因待查（诊断分支未覆盖此形状）";
}
