/**
 * 生产代码的 import 必须落在 dependencies 里（Task 0.10 补的边界）。
 *
 * 触发这条测试的真实缺陷：src/graph/company.ts 与 src/cli.ts 都从 @langchain/langgraph
 * 取 END / START / StateGraph / Command，而这个包当时只在 devDependencies ——
 * 因为 Task 0.8 只在测试里跑图，devDeps 够用；Task 0.10 把图接进 CLI，同一行 import
 * 的含义变了，package.json 却没人回头改。表现是 pnpm install --prod 之后 CLI 起不来
 * （Cannot find module），而 CI 里 pnpm install && pnpm test 全绿 —— 测试装了 devDeps。
 * 全绿的 CI 保护不了唯一的发布产物，这就是这条测试存在的理由。
 *
 * 为什么用文件扫描而不是 require.resolve 逐个试：resolve 只能证明这台机器上装得到，
 * 恰恰证明不了 prod 安装里有没有。要判的是【声明与用法的一致性】。
 *
 * 只扫 src/，不扫 test/：测试专用依赖（vitest、tsx）留在 devDependencies 是对的。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BOUNDARY_PROBE, isRuntimeFixture } from "./run-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * 三条模式，覆盖静态 from、副作用 import、re-export、动态 import()。
 *
 * 【为什么必须行首锚定】第一版写的是无锚点的
 *   /(?:from\s*|import\s*\(?\s*|import\s+)["']([^"']+)["']/
 * 它在真实代码上抓出 4 条假阳性：\`assertKnown(from, "未知状态…")\` 里的标识符
 * \`from\` 被当成了关键字 —— 因为 \`\s*\` 允许零个空白，于是紧邻的字符串字面量
 * 被当成模块说明符，捕到的"包名"是 \` | \` 和 \`);\n…\`。
 *
 * 后果不是"多几条噪音"：findings 一旦不可信，就等于这条测试不可信 —— 而它恰恰是
 * 用来拦"@langchain/langgraph 漏在 devDependencies"这种**只有一条真 finding**的
 * 缺陷，两条假阳性就能把它彻底埋掉。锚定到行首同时也天然避开 JSDoc 里的示例代码
 * （那些行以 \`*\` 或 \`//\` 开头）。
 */
const SPEC_RES: readonly RegExp[] = [
  // import … from "x"（含跨行的花括号列表；[^;] 保证不吞到下一条语句）
  /^[ \t]*import\s[^;]*?\bfrom\s+["']([^"']+)["']/gm,
  // export … from "x"
  /^[ \t]*export\s[^;]*?\bfrom\s+["']([^"']+)["']/gm,
  // 副作用 import "x"
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  // 动态 import("x")
  /\bimport\s*\(\s*["']([^"']+)["']/g,
];

/** 内置模块裸名（不带 node: 前缀的历史写法）。src/ 里不该出现，但不该由这条测试报错。 */
const BARE_BUILTIN = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "module",
  "os",
  "path",
  "process",
  "sqlite",
  "stream",
  "url",
  "util",
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    // 并发运行期夹具不是源码：dependency-boundary 会并行往 src/ 里写一个故意越界的
    // better-sqlite3 import（见 test/arch/run-fixtures.ts）。不排除就是随机红。
    if (isRuntimeFixture(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * 说明符 → 包名。
 *   @scope/pkg/sub/file.js → @scope/pkg
 *   pkg/sub                → pkg
 *   node:sqlite / ./x      → null（内置与相对路径不占 dependencies）
 */
function packageName(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.includes(sep))
    return null;
  if (spec.startsWith("node:")) return null;
  const head = spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0];
  if (head === undefined || (!spec.startsWith("@") && BARE_BUILTIN.has(head)))
    return null;
  return head;
}

interface Pkg {
  readonly dir: string;
  readonly name: string;
  readonly dependencies: Record<string, string>;
  readonly devDependencies: Record<string, string>;
}

function packages(): Pkg[] {
  const base = join(ROOT, "packages");
  return readdirSync(base)
    .filter((n) => statSync(join(base, n)).isDirectory())
    .map((n) => {
      const raw = JSON.parse(
        readFileSync(join(base, n, "package.json"), "utf8"),
      ) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return {
        dir: join(base, n),
        name: raw.name ?? n,
        dependencies: raw.dependencies ?? {},
        devDependencies: raw.devDependencies ?? {},
      };
    });
}

describe("依赖边界：src/ 的 import 必须在 dependencies", () => {
  const findings: string[] = [];
  const seen = new Set<string>();

  for (const pkg of packages()) {
    let files: string[];
    try {
      files = tsFiles(join(pkg.dir, "src"));
    } catch {
      continue; // 没有 src/ 的包跳过
    }
    expect(
      files.length,
      pkg.name + " 的 src/ 里没有任何 .ts —— 扫描本身失效了",
    ).toBeGreaterThan(0);

    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const re of SPEC_RES) {
        for (const m of text.matchAll(re)) {
          const spec = m[1];
          if (spec === undefined) continue;
          const name = packageName(spec);
          if (name === null) continue;
          seen.add(pkg.name + " :: " + name);
          if (pkg.dependencies[name] !== undefined) continue;
          const where =
            pkg.devDependencies[name] !== undefined
              ? "devDependencies"
              : "谁也没声明";
          findings.push(
            relative(ROOT, f).split(sep).join("/") +
              "  →  " +
              name +
              " 只在 " +
              where,
          );
        }
      }
    }
  }

  it("没有任何生产 import 落在 devDependencies 或未声明处", () => {
    // 断言前先确认扫描真的看见了东西：空 findings 可能是干净，也可能是没扫到。
    // 这条 expect 防的就是后者 —— 扫描器一坏这里立刻红，而不是假装通过。
    expect(
      seen.size,
      "一个外部包都没扫到，说明正则或目录遍历坏了",
    ).toBeGreaterThan(3);
    expect(
      findings,
      "生产代码引用了未进 dependencies 的包（prod 安装会缺模块）：\n  " +
        findings.join("\n  "),
    ).toEqual([]);
  });

  it("Phase 0 不引入真实 LLM provider 依赖", () => {
    // 计划 §10.4 第 7 条：测试全部用桩模型，不联网不计费。这条守的不是依赖整洁，
    // 是那条纪律从 package.json 侧的泄漏：哪天有人图省事把 SDK 加进 dependencies，
    // 这里就红。
    const FORBIDDEN = [
      "openai",
      "@anthropic-ai/sdk",
      "@langchain/openai",
      "@langchain/anthropic",
    ];
    const leaked = packages().flatMap((p) =>
      Object.keys(p.dependencies)
        .filter((d) => FORBIDDEN.includes(d))
        .map((d) => p.name + " → " + d),
    );
    expect(
      leaked,
      "Phase 0 引入了真实 LLM provider 依赖：" + leaked.join(", "),
    ).toEqual([]);
  });
});

describe("运行期夹具名单本身", () => {
  // 拆分写法是有意的：本测试检查的正是这个字面量，写成一整串就自我命中了。
  const LIT = "__boundary" + "_probe";

  it("探针名只允许定义在 run-fixtures.ts 里（防止再出现硬编码的消费者）", () => {
    const dir = join(ROOT, "test", "arch");
    const hits: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "run-fixtures.ts") continue;
      if (readFileSync(join(dir, name), "utf8").includes(LIT)) hits.push(name);
    }
    expect(
      hits,
      "探针名被重新硬编码，改名时会静默漏掉这些文件：" + hits.join(", "),
    ).toEqual([]);
  });

  it("名单不为空，也不吞掉真实源文件", () => {
    // 名单一旦被清空，排除就变成了"什么都不排除"，上面的竞态立刻复活；
    // 名单一旦写成通配或误伤，越界文件就会被永久漏检。两头都锁住。
    expect(isRuntimeFixture(BOUNDARY_PROBE)).toBe(true);
    expect(isRuntimeFixture("cli.ts")).toBe(false);
    expect(isRuntimeFixture("index.ts")).toBe(false);
  });
});
