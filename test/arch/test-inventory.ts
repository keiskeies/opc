/**
 * 测试清单比对：只有纯函数，故单独成模块（同 index-diff.ts 的理由：noExportsInTest）。
 *
 * 这里刻意【不】复刻 vitest 的 glob 语义 —— collected 一侧来自 `vitest list --files-only`，
 * 是 vitest 自己给出的权威清单。expected 一侧用一条【比 include 更宽】的命名规则枚举磁盘：
 * 两侧若用同一套规则，规则本身的盲区会同时作用于两侧，差集恒为空 —— 那是恒真判定，
 * 见 0006 §7 第 58 条与 0007 §4。所以规则必须单向放宽：多算只会多报，绝不会漏报。
 */

const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
/**
 * 忽略目录的唯一来源。此前测试文件里另抄了一份完全相同的名单，两份各自演化没有任何
 * 东西会红（同 §7-56：真扫描恰好走不到分歧那天）；现在两边都从这里取。
 */
export const IGNORED_DIRS = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  ".tmp",
]);

export type Inventory = { expected: string[]; collected: string[] };
export type InventoryDiff = { uncollected: string[]; phantom: string[] };

/**
 * 盘点扫描期间，并行的另一条守卫会现场创建又删除探针文件（越界探针就
 * 是这种短命文件，见 dependency-boundary.test.ts）。它删除的那一瞬间恰好被
 * stat 撞上，ENOENT 就会把整轮清单扫描带崩。流动的红比没守卫更糟（0007 §4.1）。
 *
 * 只宽容「消失了」这一类（ENOENT / ENOTDIR）：清单的前提本来就是磁盘上
 * 有这个文件，没了就不该进清单。其他错误照旧抛出 —— 权限类错误若也被吞掉，
 * 等于把一个真存在的测试文件静默从名单里抹掉，那是真的假绿。
 *
 * 抽成注入式纯函数（本模块一向不 import 东西），是为了三种态都能用普通单测
 * 钉住，不必真造一个文件再当场删除去撞竞态。
 */
export function survivesStat(statIsFile: () => boolean): boolean {
  try {
    return statIsFile();
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw e;
  }
}

/** 比 vitest include 更宽：.test.* 与 .spec.*，扩展名含 mjs/js，位置不限。 */
export function looksLikeTest(rel: string): boolean {
  const segs = rel.split("/");
  if (segs.some((s) => IGNORED_DIRS.has(s))) {
    return false;
  }
  return TEST_NAME.test(segs[segs.length - 1] ?? "");
}

/**
 * `vitest list --files-only` 的输出：每行一条仓库相对路径，顺序不保证。
 *
 * 这里曾写 `new RegExp(String.fromCharCode(92), "g")` 来归一化反斜杠 —— 那是【非法正则】
 * （单个反斜杠在模式末尾即报错），而此函数当时零调用者，所以从写下那天起每次调用都会抛。
 * 现在主扫描真的调用它，这一条由那次实测固定，不再靠读代码相信。
 */
export function parseFilesOnly(out: string): string[] {
  return out
    .split(String.fromCharCode(10))
    .map((l) => l.trim().split(String.fromCharCode(92)).join("/"))
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
 * 第二个 runner：Playwright 自己认领的那份清单。
 *
 * ── 为什么必须有这一发 ───────────────────────────────────────────
 * 0007 §9.2 早就把改法写死了（原文：「认领者从『vitest 的 include』扩到
 * 『vitest include ∪ Playwright config 的 testDir/testMatch』」），并明说
 * Task 2.9 落地那一刻这条守卫会【假红】、必须同步演进。本轮 `test/e2e/ceo-loop.spec.ts`
 * 真的存在了，于是那句话从「将来时」变成「今天必须做」，而【关掉守卫】不在选项里。
 *
 * ── 为什么问 Playwright 要清单，而不是自己解析 playwright.config.ts ─────
 * 和上面 vitest 那一发同一个理由：自己解析 config 就是把【我对配置的理解】同时
 * 放到 expected 和 collected 两侧，规则读窄了两侧一起窄，差集恒空 ⇒ 恒真判定
 * （0006 §7 第 58 条 / 0007 §4）。`--list` 是 Playwright 自己算出来的清单，
 * 与磁盘宽枚举没有任何共享代码。
 *
 * 实测（1.65.1，`npx playwright test --list --reporter=json`，约 1.0 s）：
 *   · `suites[].file` 给的是【相对 rootDir】的裸文件名（"ceo-loop.spec.ts"，带反斜杠）
 *   · `config.rootDir` 是【posix 斜杠的绝对路径】("D:/item/opc/test/e2e")
 *   ⇒ 两者拼起来再对仓库根取相对，才是与 expected 同一口径的相对路径。
 *
 * `--list` 会【import】spec 文件（不 import 就数不出用例标题），所以它比 list 一个
 * 配置贵，也意味着 spec 里的 hub import 一旦崩，这里会拿到非 0 退出码 —— 那是红，
 * 不是绿，方向对。
 *
 * @param out      `--list --reporter=json` 的 stdout
 * @param repoRoot 仓库根绝对路径（与 expected 的相对口径同源）
 */
export function playwrightFiles(out: string, repoRoot: string): string[] {
  let j: unknown;
  try {
    j = JSON.parse(out);
  } catch (e) {
    // 解析不成 ⇒ 抛。这里【不许】退化成空清单：空清单会让 ceo-loop.spec.ts 落回
    // 「无人认领」，红因写的是「没人认领这个文件」，而真原因是「清单读不出来」。
    throw new Error(
      "playwright --reporter=json 的输出不是 JSON（版本变了还是被别的输出污染了）：" +
        (e instanceof Error ? e.message : String(e)),
    );
  }
  const cfg = (j as { config?: { rootDir?: unknown } }).config ?? {};
  const rootDir = cfg.rootDir;
  if (typeof rootDir !== "string" || rootDir === "") {
    throw new Error("playwright JSON 里没有 config.rootDir（字段名变了？）");
  }
  const suites = (j as { suites?: unknown }).suites;
  if (!Array.isArray(suites)) {
    throw new Error("playwright JSON 里 suites 不是数组（字段形状变了）");
  }
  const root = toPosix(repoRoot);
  const base = toPosix(rootDir);
  const out2: string[] = [];
  for (const s of suites) {
    const f = (s as { file?: unknown }).file;
    if (typeof f !== "string" || f === "") {
      continue;
    }
    const abs = base + "/" + toPosix(f);
    // 大小写不敏感：Windows 盘符大小写在两处并不保证一致。这一条【不是本轮实测到的】，
    // 是按 Windows 路径惯例做的保守处理 —— 写清是为了将来读到这句的人不去找那条实测。
    if (abs.toLowerCase().startsWith(root.toLowerCase() + "/")) {
      out2.push(abs.slice(root.length + 1));
    } else {
      // 仓库外的 spec：留着让它进 phantom，红话会把它原样打出来。
      out2.push(abs);
    }
  }
  return [...new Set(out2)].sort();
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
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
