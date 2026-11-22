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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listHubSrc } from "./claims-registry.js";
import { walkFiles } from "./harness-invariants.js";
import { collect } from "./plan-refs.js";
import { listSrc } from "./role-spawn-boundary.js";
import { BOUNDARY_PROBE, isRuntimeFixture } from "./run-fixtures.js";
// round346（0054 §8 那颗「不是没有雷」的登记）：tsFiles 的 statSync 裸奔，
// 谁哪天往 src/ 里建目录夹具就是第二个 no-native-deps（并发删目录 ⇒ ENOENT 随机红）。
// 修法与本轮同形：survivesStat 吞 ENOENT/ENOTDIR ⇒ false（目录消失 = 不是目录）。
// 语义恰好匹配（单文件存在性判据），不需要再造一个 readdirSurvives 式的函数。
import { survivesStat } from "./test-inventory.js";

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
    // round346：裸 statSync 的 ENOENT 在目录夹具并发消失时会随机红（0054 §5/§8 登记
    // 的那颗雷，修法与本轮同形）。survivesStat 遇到 ENOENT/ENOTDIR ⇒ false ⇒
    // 「目录刚消失」被读成「不是目录」，照常跳过这一层；权限类错误照抛（零容忍
    // 扫描器不许静默少扫）。isRuntimeFixture 已在 statSync 之前按名字拦掉夹具。
    if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p));
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/**
 * 说明符 → 包名。
 *   @scope/pkg/sub/file.js → @scope/pkg
 *   pkg/sub                → pkg
 *   node:sqlite / ./x      → null（内置与相对路径不占 dependencies）
 *
 * 【带子路径的 scoped 说明符必须照样认出来】。这一条是实现过程中真实写错的形状：
 * 早先的版本先判 `spec.includes(sep)` 就 return null，于是
 *   import type { RunnableConfig } from "@langchain/core/runnables"
 * 被当成【不是包】而完全跳过检查 —— 而本文件的注释一直写着 `@scope/pkg/sub → @scope/pkg`。
 * 后果正是这条测试存在的理由落空：@langchain/core 若被挪进 devDependencies，
 * src/ 里唯一引用它的那一行【恰好带子路径】，于是 pnpm install --prod 之后 Hub 起不来，
 * 而这条测试全绿。分隔符的判断只能对【相对/绝对路径】生效，不能对包名生效 ——
 * 包名【本来就可能含斜杠】，这是 npm scoped 包的语法，不是路径。
 */
function packageName(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    // scoped 包名必须有前两段；"@scope" 或 "@scope/" 这种残缺写法不算包名
    if (parts.length < 2 || parts[1] === "" || parts[1] === undefined)
      return null;
    return (parts as string[]).slice(0, 2).join("/");
  }
  const head = parts[0];
  if (head === undefined || BARE_BUILTIN.has(head)) return null;
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

  it("【带子路径的 scoped 包】确实在扫描范围内", () => {
    // 上面那条 toBeGreaterThan(3) 只保证「扫到了点东西」，挡不住【专扫漏某一类】的
    // 缺陷：带子路径的 scoped import 被整类跳过时，seen 里照样有 zod、yaml，条数
    // 也能超过 3，于是扫描器少认一整类包而门禁全绿。
    // 这里直接点名 Hub 真正依赖的那两个 @langchain 包 —— 它们【只以子路径形式】
    // 被引用（"@langchain/core/runnables"、"@langchain/langgraph-checkpoint"），
    // 所以这一条就是 packageName 的回归测试。写法上用 includes 而不是精确比集合：
    // 换依赖时不该由这条来报红，那由上面那条 findings 负责。
    const hub = "@opc/hub :: ";
    const hit = [...seen].filter((s) => s.startsWith(hub));
    for (const want of ["@langchain/core", "@langchain/langgraph"]) {
      expect(
        hit.includes(hub + want),
        "扫描漏了 " +
          want +
          "。它在本仓库只以【带子路径】的形式被 import，" +
          "漏认说明 packageName 把斜杠当成路径处理了（见其注释）。实到：" +
          hit.join(", "),
      ).toBe(true);
    }
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

  /** 探针的内容：与被测的那个短命文件长得一样（越界 import 才是它存在的理由）。 */
  const PROBE_BODY = 'import D from "better-sqlite3";\nexport default D;\n';

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

  it("每一个 readdirSync 的使用者都在名单里过了一遍", () => {
    // 漏接名单的红是【随机】的 —— 只有撞上那个短命探针才红，撞上概率实测约 1/5
    //（5 次红 1 次）。随机红守不住任何东西：它会被当成 flake 重跑，重跑就绿。
    // round277 数过一遍，漏接的有 4 个（plan-refs / role-spawn-boundary / claims-registry /
    // irreversible-token），每一个都是【单跑恒绿、全量偶发红】。
    //
    // ⚠ 判据【不是】「文本里出现 packages/hub/src 就得接名单」。那样写过，连着三代假红：
    //   ① 整份文件 text.includes ⇒ 注释里举了那个路径的 no-native-deps / test-inventory 红；
    //   ② 换成 lexTs 只看代码区 ⇒ doc-refs 把一个 src 路径当【测试数据字符串】喂给
    //      纯判据（它不 walk 任何目录），test-inventory 同理，还是红。
    // 「从文本猜这段代码会不会读 src」这件事【做不到精确】，而一条会假红的守卫比没有守卫更糟
    //（0055 那条家规）。所以改成【声明式清单】：唯一的机器判据是「这个文件调用了
    //  readdirSync」——这个谓词没有歧义；清单里每条【写明要不要排夹具、为什么】。
    // 新增一个 readdirSync 使用者 ⇒ 清单里没有它 ⇒ 红，逼着做一次决定，而不是靠人想起来。
    const dir = join(ROOT, "test", "arch");
    /** 需要排夹具的（walk 进 packages/hub/src 并读文件内容）。 */
    const NEEDS = new Set([
      "claims-registry.ts",
      "dead-modules.ts",
      "lint-baseline.ts",
      "plan-refs.ts",
      "production-deps.test.ts",
      "role-spawn-boundary.ts",
      "zero-producer.test.ts",
      "no-native-deps.test.ts",
      "dependency-boundary.test.ts",
      "dead-modules.test.ts",
      "doc-refs.test.ts",
      "lint-baseline.test.ts",
      "harness-invariants.ts",
      "irreversible-token.test.ts",
      // 它自己不调 isRuntimeFixture，靠 harness-invariants.walkFiles 排 —— 但它的
      // SCAN_ROOTS 第 1 条就是 packages/hub/src。放这一格而不是 OUT_OF_SCOPE，
      // 是因为放进"不碰 src"那一格就等于给下面那条接法检查开了个洞（见下面 WIRED 注释）。
      "no-null-bytes.test.ts",
      // round290 新增：两处 walk 一处从 packages/*/src 往下走并读文件内容，
      // 另一处从仓库根收 *.test.ts 的基名 —— 前者正踩在探针的住址上。
      // 已按 WIRED 第一种接法接了 isRuntimeFixture（两处 walk 都排）。
      "comment-test-readers.test.ts",
    ]);
    /** walk 的根不含 packages/hub/src，或只收【名字像测试】的文件：短命夹具碰不到。 */
    const OUT_OF_SCOPE = new Set([
      "claims-registry.test.ts",
      // round293 新增（census.ts）。它的 readdirSync 只有 countTestFiles 那一处，从【仓库根】
      // 往下走 —— 会【路过】packages/hub/src，但只收名字以 .test.ts 结尾的项，而探针的名字
      // 不像测试 ⇒ 和上面 test-inventory 那一格同形：【按名字天然免疫】，不是【没走到】。
      // ⚠ 两条别读反：
      //   ① 别把它读成 NEEDS。普查真正读 hub/src 内容的那条 walk 在 dead-modules.collectModules
      //      里，那边已经排过夹具（唯一真相）；这里再排一遍就是第二套排除口径，必然漂。
      //   ② 哪天 countTestFiles 改成收【非测试】文件，这格立刻作废 —— 它得搬去 NEEDS。
      //      所以这一格的成立条件是【那个后缀判据还在】，由 census.test.ts 的分桶断言钉着。
      "census.ts",
      "commit-msg-refs.ts",
      "decision-index.test.ts",
      "doc-coords.ts",
      "doc-ids.test.ts",
      "index-diff.ts",
      // round301 新增（mutation-parser-screen 守卫）。它的 readdirSync 只有一处，根是
      // 【.workbuddy】且只收 `round\d+-mutate-*.mjs` ⇒ 走不到 packages/hub/src，
      // 而那几台变异机自己会写生产字节 —— 那是【它们】的并发纪律，与这里的夹具无关。
      // ⚠ 这一格的成立条件是【那个 mjs 正则还在】：哪天改成收 .ts 并往仓库根走就作废。
      "mutation-parser-screen.test.ts",
      "pending-decisions.test.ts",
      // 它调 readdirSync 只为在 node_modules/.pnpm 里找 typescript 的 tsc，
      // 一个目录名都不碰 packages/hub/src ⇒ 短命探针天然不在射程里。
      // ⚠ 它【同时】是个扫全仓的守卫（tsc 吃 test/** 与 packages/*/test/**），
      //    但那条扫描在 tsc 进程里，不在这个文件的 readdirSync 里 —— 别把它读成 NEEDS。
      "test-type-baseline.ts",
      // enumerate("") 确实从仓库根往下走（会路过 packages/hub/src），但它只收
      // looksLikeTest 认下的名字，而探针那个名字不像测试 —— 是【按名字天然免疫】，
      // 不是【没走到】。这两种在清单里得分开写，否则下次有人改 looksLikeTest 就没人提醒。
      "test-inventory.test.ts",
    ]);
    /** 接上名单的四种写法。walkFiles 算一种：它内部已经排了（第 14 格那一行），
     *  且这一格由下面那发【临时树当场验】，不是只认一个名字。带括号是为了不让
     *  「注释里提了一句 walkFiles」也算接上。 */
    const WIRED = [
      "isRuntimeFixture",
      "listHubSrc",
      "BOUNDARY_PROBE",
      "walkFiles(",
    ];
    const unlisted: string[] = [];
    const notWired: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "run-fixtures.ts") continue;
      const text = readFileSync(join(dir, name), "utf8");
      if (!text.includes("readdirSync")) continue;
      if (OUT_OF_SCOPE.has(name)) continue;
      if (!NEEDS.has(name)) {
        unlisted.push(name);
        continue;
      }
      if (!WIRED.some((w) => text.includes(w))) notWired.push(name);
    }
    expect(
      unlisted,
      "新出现的 readdirSync 使用者：去 production-deps.test.ts 二选一登记（进 NEEDS 还是 " +
        "OUT_OF_SCOPE，并写清它会不会 walk 进 packages/hub/src）：" +
        unlisted.join(", "),
    ).toEqual([] as string[]);
    expect(
      notWired,
      "清单里说要排夹具，代码里却没有任何一条接上名单：" + notWired.join(", "),
    ).toEqual([] as string[]);
  });

  it("tsFiles 的 statSync 被 survivesStat 包着（round346，0054 §8 那颗登记）", () => {
    // 0054 §5/§8 登记：tsFiles 的裸 statSync(p).isDirectory() 在「目录夹具并行建、
    // 扫描途中被删」时会随机 ENOENT —— 「不是没有雷，今天没有并发引爆者」。
    // 修法与 no-native-deps 那族同形：survivesStat 吞 ENOENT/ENOTDIR ⇒ false ⇒
    // 「目录刚消失」被读成「不是目录」，照常跳过；权限类错误照抛（零容忍扫描器
    // 不许静默少扫一片）。tsFiles 不接受注入（会话内私有函数，扫描起点由调用方给），
    // 所以确定性钉法分两半：
    //  ① survivesStat 的 ENOENT 语义（保层的真身）
    const gone = join(
      tmpdir(),
      "pd-gone-" + process.pid + "-" + Math.random().toString(36).slice(2),
    );
    expect(
      survivesStat(() => statSync(gone).isDirectory()),
      "目录不存在 ⇒ false（跳过）",
    ).toBe(false);
    const file = join(tmpdir(), "pd-file-" + process.pid + ".ts");
    writeFileSync(file, "export const x = 0;\n");
    expect(
      survivesStat(() => statSync(file).isDirectory()),
      "存在但非目录 ⇒ false",
    ).toBe(false);
    // 反向对照：真目录 ⇒ true（不是「什么都跳过」）
    const realDir = join(tmpdir(), "pd-dir-" + process.pid);
    mkdirSync(realDir, { recursive: true });
    expect(
      survivesStat(() => statSync(realDir).isDirectory()),
      "真目录 ⇒ true",
    ).toBe(true);
    // 权限类照抛：EPERM 不该被吞（拿一个必然 EPERM 的目标 —— 这里是 win32? 跳过，
    // 语义已由 survivesStat 自身那组用例覆盖（test-inventory.test.ts:298）。不重复。
    rmSync(gone, { force: true, recursive: true });
    rmSync(file, { force: true });
    rmSync(realDir, { force: true, recursive: true });

    //  ② 接线守门：tsFiles 里那句 statSync 真的被 survivesStat 包着（读自身源码）。
    //     判据用【完整调用语句】：第一版无锚点子串匹配会吞进注释与断言自身的字符串
    //     字面量（全文件命中 5 处而非 1 处）；固定 600 字节切片则对「函数上方多了
    //     几行注释」的位移敏感（变异机 M3 控制组只加注释就被推出窗口误红过）。
    //     ⚠ 探针串必须【拆开拼接】才不自我遮蔽：写成字面量时，断言自己的定义行
    //     就含完整的 `if (survivesStat(…)) out.push(…tsFiles(p));`，于是变异把
    //     tsFiles 改裸奔后 srcText 里照样找得到这段字节 ⇒ 守门永远绿（变异机 M1/M2
    //     当场实证过「全绿」）。拆成 `"…out.push(…tsFiles(p))" + ";"` 后，定义行里
    //     的字节序列不完整，srcText.includes 只可能命中 tsFiles 那一行。
    //     镜像局限仍存在（tsFiles 行与探针串同时改坏时静态守门绿）—— 那由变异机
    //     M1/M2 从外部单侧破坏来补（判别力在那侧）。
    const srcText = readFileSync(
      join(import.meta.dirname, "production-deps.test.ts"),
      "utf8",
    );
    const fullCall =
      "if (survivesStat(() => statSync(p).isDirectory())) out.push(...tsFiles(p))" +
      ";";
    expect(
      srcText.includes(fullCall),
      "tsFiles 的 statSync 调用必须原样被 survivesStat 包着（M1/M2 变异即红）",
    ).toBe(true);
  });

  it("接了名单的取材函数在【探针真的存在】时不列出它", () => {
    // 上面那条只管【接线】，管不了【接错】（比如把排除条件少写一个 ! —— 那种写法
    // 接了名单，行为完全相反）。所以这里当场造一棵临时树、【把探针真的放进去】，
    // 验三个取材函数都不列它。临时树不碰真仓库，因此这一发与那个短命探针【无关】：
    // 不管并发怎么跑它恒红或恒绿，是个确定性判据 —— 正是随机红的那条补不上来的位置。
    const root = mkdtempSync(join(tmpdir(), "probe-excl-"));
    try {
      const src = join(root, "packages", "hub", "src");
      mkdirSync(join(src, "engine"), { recursive: true });
      writeFileSync(join(src, "real.ts"), "export const a = 1;\n");
      writeFileSync(join(src, "engine", "sub.ts"), "export const b = 2;\n");
      writeFileSync(join(src, BOUNDARY_PROBE), PROBE_BODY);
      const listed = [
        ...listHubSrc(root),
        ...listSrc(root),
        ...collect(root, "packages", ".ts"),
        // walkFiles 也要验：清单里 no-null-bytes 那一格【完全靠】它排（它自己不调
        // isRuntimeFixture）。少验这一格，那条接法检查就只是在读一个没人验证过的名字。
        ...walkFiles(root, (n: string) => n.endsWith(".ts")),
      ];
      const hits = listed.filter((p) => p.endsWith(BOUNDARY_PROBE));
      expect(
        hits,
        "取材把运行期夹具列出来了，于是并发时会随机 ENOENT：" + hits.join(", "),
      ).toEqual([] as string[]);
      // 正向对照：真实文件必须在清单里。否则【全都列不出来】也能骗过上面那条断言。
      expect(listed.filter((p) => p.endsWith("real.ts")).length).toBe(4);
      expect(listed.filter((p) => p.endsWith("sub.ts")).length).toBe(4);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
