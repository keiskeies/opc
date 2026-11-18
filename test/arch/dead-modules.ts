/**
 * 死模块哨兵的【纯判据】：模块图取材、可达性、基线双向核对、主张位置定位。
 *
 * 为什么单独成模块（先例：index-diff.ts、pending-inventory.ts、test-inventory.ts）：
 * biome 的 noExportsInTest 不许从 *.test.ts 导出，而这套判据要在两处用同一份 ——
 * 测试里，以及我手跑复核时。复制一份必漂移（0006 §7 第 55、56 条记的就是这个形状）。
 *
 * ── 这一族防的是什么 ────────────────────────────────────────────
 * 「有实现 + 有测试 + 零调用方」在用户那边的读数是 0，不是「快好了」。
 * 本仓有一批这样的模块，代码质量不低，而全仓没有任何测试会因为那条边不存在而红。
 * 更麻烦的是**关于这件事的陈述也会过期，而且过期时不红**：实测过三条
 * （docs/OPC-OS-功能优化设计.md §1.3），其中两条是「说没有、其实有了」。
 *
 * ── 为什么判【从入口不可达】而不是【零 importer】：这是本守卫的命门 ──────
 * 零 importer 那个口径有**两个方向的错，两个都实测踩过**：
 *  ① 假阳性：`harness/gateway`、`safety`、`routing` 互相 import，于是每个文件都有
 *     importer，而 `harness/` **整目录对外零 import**。按文件对文件数边，约 3300 行
 *     安全层会被数成「有人用」。**可达性天然解决这一条**：从入口走不到的簇，
 *     内部边再多也不计分 —— 连 `graph/gates/*` 与 `search/*` 这些
 *     「只被不可达模块用」的下游也一起抓到（继承性不可达，零 importer 口径全漏）。
 *  ② 假阴性：`db/backup.worker.ts` 由 `new Worker(...)` 起，静态 import 图看不见。
 *     可达性会把它判成死的，而它干的是最硬的活。**所以动态入口必须显式推出来**
 *     （见 dynamicEntryTargets：从代码里的起手式推，不写死名单）。
 *
 * ── 基线为什么是【双向】判 ─────────────────────────────────────
 * 只查「新增死代码」的话，名单会跟着代码一起过期而没人发现
 * （pending-inventory.ts 文件头记的就是这个形状：只查单向，名单必然烂掉）。
 * 反方向那条才是关键：**基线里的模块一旦可达 ⇒ 红，并报出该改哪几句主张**。
 * 它把「接上了」这件事变成强制回到文档的动作。代价与缓解写在 checkBaseline 里。
 *
 * ── 基线每一条都必须被数据约束 ─────────────────────────────────
 * 照 docs/review/verify-open-invariants.mjs 那条「豁免表逐条被数据约束
 * （没有『从未出现』的放行口）」的形状：每条带一个**特征串**，资格是
 * 「出现在本模块、且在全仓其余 src 模块里一次都不出现」。这个串同时钉住两件事：
 * 这条豁免指的确实是这个模块；以及**那个东西还在**。符号被删掉 ⇒ 豁免当场失效。
 * 光秃秃的名字 = 第二个「进桶即放过」。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeFixture } from "./run-fixtures.js";
import { lexTs } from "./ts-lex.js";

const NL = String.fromCharCode(10);
const SRC_REL = "packages/hub/src";
/** worker 的起手式：谁的正文里有它，同目录那个 .worker.ts 就是被 new Worker 起的。 */
const WORKER_MARK = "selfWorkerUrl(import.meta.url)";

export type Module = {
  /** 仓库相对 `packages/hub/src` 的路径，正斜杠，含 .ts 后缀。 */
  readonly rel: string;
  readonly text: string;
};

export type Graph = {
  /** rel -> 它 import 的模块（同一个 rel 口径）。 */
  readonly edges: ReadonlyMap<string, ReadonlySet<string>>;
  /** 解析不到 src 内部的说明符（外部包、@opc/*）-> 谁 import 它。 */
  readonly external: ReadonlyMap<string, ReadonlySet<string>>;
  /** 相对说明符但解析不到 —— 真缺陷，必须能被看见，不能被当成外部包放掉。 */
  readonly unresolved: readonly string[];
  /**
   * 「在**注释**里出现、且没被算成 import」的相对说明符（`模块 → 说明符`）。
   *
   * 有这一格是因为实测撞到的那一发：`db/worker-entry.ts` 的注释里举了一个解析不了的
   * 反例（`./worker-loader.js`，全仓不存在）。注释里的东西不是引用，所以 buildGraph
   * 先把注释挖掉再找说明符。但**挖注释这件事本身会坏**（正则写歪 ⇒ 真的 import 被一起
   * 挖掉 ⇒ 该模块判成不可达），所以把挖掉的东西留成可读的证据：真 import 若掉进这里，
   * 测试当场红，而不是静少一条边。
   */
  readonly commentOnly: readonly string[];
};

export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/* ========================= 取材（IO）========================= */

/**
 * 取 `packages/hub/src` 下全部非测试 .ts。
 *
 * 排除 `poc/`：它在 `tsc` 编译范围外（docs/review/README.md 的 C6 那条已把这件事
 * 记成正式口径），把它算进「活代码」会凭空多出一批可达模块。
 * 排除 `.test.ts`：测试 import 一个模块**不构成生产调用方** —— 那正是本守卫要找的
 * 那一族（`harness/verifier.ts` 有测试、零生产调用方）。
 * 排除 `isRuntimeFixture()` 认的那些名字：`dependency-boundary.test.ts` 会往
 * `packages/hub/src/` 现场写一个越界 import 探针再删掉（探针名只能出自
 * `run-fixtures.ts`，本文件也不许把那个字面量写出来 —— 连注释里都不行，
 * `production-deps.test.ts` 那条普查扫的是整个文件的字节，它分不清代码与注释）。
 * 它被并行的本守卫撞上时，会报出一条「新增死模块 <探针>」——**一条随并发出现的红**。
 * 本仓另三个扫描型守卫（`dependency-boundary` / `doc-refs` / `production-deps`）都从
 * `run-fixtures.ts` 这个唯一真相取排除名单，本守卫原先漏了这一格
 * （实测：并行跑 arch 全套偶发红，单跑恒绿 —— 那种「只在全量跑出现的红」正是
 * 0007 §4.1 说的会被关掉的东西）。
 *
 * ⚠ 排除名单只认**确切文件名**，不是前缀通配，所以它挡不住「将来有人新造一个探针」；
 * 那时会再红一次，去 `run-fixtures.ts` 登记，别在这里加通配。
 */
export function collectModules(rootDir: string = repoRoot()): Module[] {
  const base = join(rootDir, SRC_REL);
  const out: Module[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "poc" || e.name === "dist") continue;
        walk(f);
        continue;
      }
      if (!e.name.endsWith(".ts") || e.name.endsWith(".test.ts")) continue;
      if (isRuntimeFixture(e.name)) continue;
      // 只宽容「readdir 之后又被删掉」这一类（并行的探针会这样）。真少了一个模块
      // 仍然会被看见：基线里那条会由 invalidBaselineMarks 报「不在取材范围里」。
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        throw err;
      }
      out.push({
        rel: f.slice(base.length + 1).replace(/\\/g, "/"),
        text,
      });
    }
  };
  walk(base);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

/* ========================= 解析说明符 ========================= */

/**
 * 一条说明符连同它出自**代码**还是**注释**。
 *
 * ⚠ 为什么要分开 —— 这一发是实测撞出来的，不是洁癖：
 * `db/worker-entry.ts` 的**注释**里举了一个反例，说「入口里
 * `import "./worker-loader.js"` 那个写法解析不了」。`worker-loader.js` 全仓不存在，
 * 而第一版提取器扫全文，把那句注释读成了一条真 import，于是 `unresolved` 报出一条
 * **并不存在**的悬空引用。这与本仓 test/arch/comment-citations.ts 文件头第二条
 * 是同一个理由：**扫全文会把数据当引用**。那里用 TS AST 的 trivia，本守卫不想把
 * typescript 拉进判据依赖，所以用 ./ts-lex.ts 那个手写扫描器（现与
 * ./stub-terminal-write.ts 共用一份）。
 *
 * 还有两条已修的错，形状都记在测试里：
 *  ① 跨行懒匹配 `(?:import|export)[\s\S]*?from` 会在两条独立 import 之间一路吞过去。
 *  ② 更严重：中间一版先「把字符串内容挖成空格」再跑同一条正则 —— 那一步把**真**
 *     说明符也挖掉了，`from ""` 什么都匹配不上，边数从几百掉到 **0**。判据坏起来
 *     不报「扫描失败」，只报「多出 77 个死模块」。所以这里**一次扫描同时定上下文**，
 *     不给「先抹平再匹配」那种两步写法留位置。
 *
 * ⚠ 扫描器本身已抽到 ./ts-lex.ts（第二处需要「代码还是注释」的判据落地之后，
 * 两份会漂移这件事就不再是理论问题了）。这里只留说明符那两条口径。
 */
export type SpecHit = {
  readonly spec: string;
  readonly inComment: boolean;
};

/** 代码侧的说明符前导词。`export * from "x"` 走 from，动态 `import("x")` 走 import。 */
const KEYWORDS = ["from", "import", "require"] as const;

/**
 * 一次词法扫描：认出「引号里的说明符」，并说清它在代码里还是在注释里。
 *
 * 只认**双引号**，与既有口径一致；口径边界由测试里那条哨兵钉着（全仓 import 实测
 * 全是双引号，哪天出现单引号那条边会静丢 —— 那条测试先红，别靠主断言猜）。
 *
 * 刻意不为的地方（都朝【会红】的方向坏，不是静默）：
 *  · 模板串的 `${}` 嵌套、正则字面量里的引号 —— 本仓 src 里没有那种形状，
 *    真出现了最坏是把一条边读错，读错就少一条边 ⇒ 该模块判不可达 ⇒ 不在基线 ⇒ 当场红。
 *  · `import` 后换行再跟引号 —— 真实 import 不这么写。
 */
export function scanSpecs(src: string): SpecHit[] {
  const hits: SpecHit[] = [];
  lexTs(src, {
    // 注释正文里的引号是普通文本，不是定界符，所以那一侧只能靠【原文形状】。
    // 与代码侧口径已统一（见 SPEC_RE），「注释里一条空串 import」两侧现在都认。
    onComment: (text) => {
      for (const g of text.matchAll(SPEC_RE)) {
        if (g[1] !== undefined) hits.push({ spec: g[1], inComment: true });
      }
    },
    onWord: (word, end) => {
      if (!KEYWORDS.includes(word as (typeof KEYWORDS)[number])) return;
      SPEC_AT.lastIndex = end;
      const m = SPEC_AT.exec(src);
      if (m?.[1] !== undefined) hits.push({ spec: m[1], inComment: false });
    },
  });
  return hits;
}

/**
 * 注释原文用的口径。
 *
 * ⚠ 与代码侧的 SPEC_AT【必须认同样的形状】（差别只剩 `y` 锚位与注释段本身没有词界
 * 可依赖）。两边不一致的话，「注释里那条 import 会不会被当成引用」就没有确定答案，
 * 而测试只会挑到其中一侧绿 —— 剩下那一侧坏着也没人知道。这条不一致是实测量出来的：
 * `""` 那一发旧版一边认一边不认，本轮把 `+?` 改成 `*?` 统一掉。
 */
const SPEC_RE = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*"([^"\n]*)"/g;

/**
 * 代码侧：前导词**紧邻**的引号串。`y` 锚定在前导词词尾，所以既不跨行也不需要 `\b`。
 * 允许 `(` 是动态 `import("x")` 与 `require("x")` 的写法。
 */
const SPEC_AT = /\s*\(?\s*"([^"\n]*)"/y;

/**
 * ⚠ round293 起【导出】：./census.ts 要把「纯类型 import」那条说明符解析回模块路径，
 * 而它必须有【唯一一个】解析器 —— 本文件 §1.1 记过的那条坑（按说明符子串匹配 ⇒
 * 数出 33 个死模块）之所以是坑，就是因为多一份解析口径必然漂。
 */
export function resolveSpec(
  spec: string,
  fromRel: string,
  known: ReadonlySet<string>,
): string | null | "external" {
  if (!spec.startsWith(".")) return "external";
  const fromAbs = join(repoRoot(), SRC_REL, dirname(fromRel));
  const abs = resolve(fromAbs, spec).replace(/\\/g, "/");
  const root = join(repoRoot(), SRC_REL).replace(/\\/g, "/");
  if (!abs.startsWith(root + "/")) return null; // 跑出 src 了：json 之类
  const p = abs.slice(root.length + 1);
  // 编译期写 .js，源码是 .ts；目录则补 /index.ts。
  for (const c of [
    p.replace(/\.js$/, ".ts"),
    p.replace(/\.js$/, "") + "/index.ts",
  ]) {
    if (known.has(c)) return c;
  }
  return null;
}

export function buildGraph(
  mods: readonly Module[],
  rootDir: string = repoRoot(),
): Graph {
  const known = new Set<string>(mods.map((m) => m.rel));
  const edges = new Map<string, Set<string>>();
  const external = new Map<string, Set<string>>();
  const unresolved: string[] = [];
  const commentOnly: string[] = [];
  void rootDir;
  for (const m of mods) {
    const to = new Set<string>();
    // 一次扫描同时给出【代码里】和【注释里】的说明符：注释侧只用来留证据，
    // 绝不当边 —— 真把注释当引用的话，unresolved 会报出一条不存在的悬空引用。
    for (const h of scanSpecs(m.text)) {
      const spec = h.spec;
      if (h.inComment) {
        // 只登记相对说明符：注释里举的外部包反例不是本守卫要盯的形状，全量登记
        // 会把这条通道变成噪音（噪音红会被关掉 —— 见 checkBaseline 里那段）。
        if (spec.startsWith(".")) {
          const tag = m.rel + " → " + spec + "（注释）";
          if (!commentOnly.includes(tag)) commentOnly.push(tag);
        }
        continue;
      }
      const r = resolveSpec(spec, m.rel, known);
      if (r === "external") {
        const s = external.get(spec) ?? new Set<string>();
        s.add(m.rel);
        external.set(spec, s);
        continue;
      }
      if (r === null) {
        if (spec.startsWith(".")) unresolved.push(m.rel + " → " + spec);
        continue;
      }
      if (r !== m.rel) to.add(r);
    }
    edges.set(m.rel, to);
  }
  return { edges, external, unresolved, commentOnly };
}

/* ===================== 入口与动态入口 ===================== */

/**
 * 静态入口：**从根 package.json 的 scripts 里推**，不写死名单。
 *
 * 为什么不写死：写死一张入口名单 = 又一个会过期、还得有人记得改的地方，
 * 而这一整个守卫的存在理由就是消灭那种东西。scripts 是「这台机器上真能启动什么」
 * 的权威出处，它变了这里自动跟着变。
 *
 * ⚠ 这里发过一次错：往已带 `.ts` 的 token 后面又拼了一次 `.ts`，得到 `cli.ts.ts`，
 * 于是闭包空转、83 个模块里 77 个被判成死模块。**它不会以「报错」的形状出现，
 * 只会以「基线对不上」的形状出现** —— 所以测试里有一条专门钉它。
 */
export function entryPoints(rootDir: string = repoRoot()): Set<string> {
  const pkg = JSON.parse(
    readFileSync(join(rootDir, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const out = new Set<string>();
  const pre = SRC_REL + "/";
  for (const cmd of Object.values(pkg.scripts ?? {})) {
    for (const g of cmd.matchAll(/([\w./-]+\.ts)\b/g)) {
      const p = g[1];
      if (p === undefined) continue;
      const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
      if (norm.startsWith(pre)) out.add(norm.slice(pre.length));
    }
  }
  return out;
}

/**
 * 动态入口：正文含 `selfWorkerUrl(import.meta.url)` 的模块 ⇒ 同目录 `.worker.ts`
 * 是被 `new Worker` 起的，静态 import 图**看不见**它。
 *
 * 是**推**出来的不是枚举的。⚠ 它只覆盖 worker 这一族：将来出现别的动态起法
 * 或 `import(变量)`，这里推不出来 —— 那时被起模块会因「判成不可达 + 不在基线」
 * 当场红，逼登记的人回来补这一格。**这条边界要在读基线时知道**：
 * 基线里出现一个「明明在跑」的模块，第一反应应该是来查这里，不是加豁免。
 */
export function dynamicEntryTargets(mods: readonly Module[]): Set<string> {
  const known = new Set<string>(mods.map((m) => m.rel));
  const out = new Set<string>();
  for (const m of mods) {
    if (!m.text.includes(WORKER_MARK)) continue;
    const w = m.rel.replace(/\.ts$/, ".worker.ts");
    if (known.has(w)) out.add(w);
  }
  return out;
}

export function reachableFrom(
  roots: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nx of edges.get(cur) ?? []) if (!seen.has(nx)) stack.push(nx);
  }
  return seen;
}

/** 默认根 = 静态入口 ∪ 动态入口。可注入：合成语料的 canary 不走真 package.json。 */
export function defaultRoots(mods: readonly Module[]): Set<string> {
  return new Set([...entryPoints(), ...dynamicEntryTargets(mods)]);
}

export function reachabilityOf(
  g: Graph,
  mods: readonly Module[],
  roots?: ReadonlySet<string>,
): Set<string> {
  return reachableFrom(roots ?? defaultRoots(mods), g.edges);
}

export type DeadReport = {
  readonly dead: readonly string[];
  readonly roots: readonly string[];
  readonly dynamic: readonly string[];
  readonly total: number;
  readonly edgeCount: number;
  readonly unresolved: readonly string[];
};

export function deadModules(
  g: Graph,
  mods: readonly Module[],
  roots?: ReadonlySet<string>,
): DeadReport {
  const r = roots ?? defaultRoots(mods);
  const reach = reachableFrom(r, g.edges);
  let edgeCount = 0;
  for (const s of g.edges.values()) edgeCount += s.size;
  return {
    dead: mods.map((m) => m.rel).filter((x) => !reach.has(x)),
    roots: [...r].sort(),
    dynamic: [...dynamicEntryTargets(mods)].sort(),
    total: mods.length,
    edgeCount,
    unresolved: g.unresolved,
  };
}

/* ========================= 基线 ========================= */

/** 一条基线：模块 -> **可核对的**特征串（在本模块出现、在其余 src 模块不出现）。 */
export type Baseline = ReadonlyMap<string, string>;

/**
 * 今天不可达的模块。每一格都要 CEO/维护者**读过**才该增删。
 *
 * 除最后两行外都是真缺口（各自登记在 docs/OPC-OS-功能优化设计.md 的 O 项里）；
 * 最后两行 `index.ts` / `main.ts` 是**有意的占位**，不是缺口 —— 它们进表是因为
 * 判据不看意图只看可达性，而**给一条正确的例外加豁免，比让守卫天天假红好**。
 *
 * ⚠ 本轮删过两格（O2 把岗位书接进 rolePrompt，`charter/store.ts` 从此每轮真被读）：
 * `charter/store.ts` 与 `graph/gates/evaluate.ts`。**两格删掉的理由强度不一样**，
 * 而把这件事记在这里而不是只记「它们活了」，因为可达性是【模块】粒度，而缺口是
 * 【函数】粒度的：
 *  · `charter/store.ts` —— 真的活了。`readLatestCharter` / `assertCharterShape`
 *    现在每次真角色轮都跑（`engine/runtime.ts` 的 rolePrompt）。
 *  · `graph/gates/evaluate.ts` —— **只是模块被进来了**：它靠 store.ts 文件头那句
 *    `import { criteriaFromCharter }` 传递可达，而**调用它的那两个函数
 *    （`gateCriteriaForRole` / `...AtVersion`）今天仍然零生产调用方**。
 *    `evaluateGate` 的调用方仍然只有 `harness/verifier.ts`，而 `verifyFix` 自己零调用方
 *    （`packages/hub/test/acceptance/phase3.test.ts` 那两条 `callersOf` 钉的就是这一格，
 *    它们今天照样红着说真话）。⇒ 这一格**不能**被读成「门控接上了」。
 *    基线只能表达"模块走不走得到"，所以它必须删（留着就是假账，见 staleBaselineEntries），
 *    而"函数有没有人调"由 phase3 那两条函数级断言继续守着 —— 两层粒度各守各的，
 *    别拿上面那层的绿去宣布下面那层过了。
 */
export const BASELINE: Baseline = new Map([
  // 簇一：安全层。整目录对外零 import，目录内部互相 import 把每个成员伪装成有人用。
  ["harness/gateway.ts", "GATEWAY_REJECT_CODES"],
  ["harness/routing.ts", "ROUTE_STAGES"],
  ["harness/safety.ts", "SAFETY_BLOCK_CODES"],
  ["harness/verifier.ts", "VERIFY_REJECT_CODES"],
  // 簇二：只被上面那簇用的下游（继承性不可达 —— 零 importer 口径一条都抓不到）。
  ["graph/gates/author-reviewer.ts", "SameFamilyApproval"],
  ["search/mcp.ts", "SearchTransport"],
  ["search/observe.ts", "isSearchToolName"],
  ["search/policy.ts", "SEARCH_REJECT_CODES"],
  // 簇三：单点缺口。
  // ⚠ policy/auto-approve.ts 与 policy/engine.ts 两条【已摘除】（round269，O9 动作 1）：
  // approvals/query.ts 的影子判定 import 了 autoApprove（读路径，只报不批），
  // 方向 B 那条红正是这两格设计出来的死法 —— 与 approvals/timeout.ts 那一格同剧本。
  // 它们今天的诚实口径不是「零调用方」而是「有读者而无写者」：
  // recordAutoApproval 在 src 里仍然零调用（query.test.ts ⑦ 那一发源码判据钉着），
  // 「存在一条被自动批准的审批」这一发今天必须红（O9 验收第 1 条）。
  ["evidence/store.ts", "VerifyReport"],
  // ⚠ channels/abstraction.ts 与 channels/approval-bridge.ts 两条【已摘除】（round281，O12 动作 2）：
  // serve/im-channels.ts 装配了真飞书适配器，而 serve/assemble.ts 的 boot 每一轮心跳派发它。
  // 这两格的设计死法就是方向 B —— 与 approvals/timeout.ts、policy/auto-approve.ts 同剧本，
  // 红行如约出现并点名该改的主张。留在表里就是假账（见 staleBaselineEntries）。
  // ⚠ 模块活了 ≠ 整条链通了 —— 这一格曾经写着「`deliverCard`（发卡那半边）在 src 里
  // 仍然零调用方，那是 O12 动作 4，需要一张跨重启的投递台账而库里没有那张表」。
  // round283 之后那句过期：0009 建了 `card_deliveries`，`channels/deliver.ts` 成为它的
  // 第一个写方，而 `serve/im-channels.ts` 每一轮心跳调一次 ⇒ 那一格现在由 r17 机器判，
  // 不在本表（本表只判【模块级】可达，看不见函数级缺口 —— 这正是当初那句话能漂这么久的原因）。
  ["heartbeat/retry.ts", "MAX_BACKOFF_MS"],
  ["graph/branches.ts", "PARALLEL_MIN_BRANCHES"],
  ["events/batch.ts", "appendAuditBatch"],
  // 有意占位，非缺口。
  ["index.ts", "HUB_ENTRY_PENDING"],
  ["main.ts", "为什么不把参数解析也写进"],
]);

/* ========================= 双向核对 ========================= */

export type BaselineProblem = {
  readonly kind: "新增死模块" | "基线里的已经活了";
  readonly mod: string;
  readonly why: string;
};

/**
 * 双向核对。
 *
 * 方向 A：死而不在基线 ⇒ 红。「新写的死代码不再能悄悄混进来。」
 * 方向 B：在基线而**已经可达** ⇒ 红，并把该改的主张位置一起打出来。
 *
 * ⚠ 方向 B 是在**惩罚正在做接线的那个人**，这个代价要认。
 * 缓解不是砍掉这半边（砍了它就退化成一张会烂掉的名单），而是让红行**自带可执行动作**：
 * 写清「把这一条从基线删掉」+「这几个文件的这几行写着过期主张」。
 * 一行就能改完的红是有用的；读不懂的红会被关掉（0007 §4.1 记的是后者的代价）。
 */
export function checkBaseline(
  dead: readonly string[],
  baseline: Baseline,
  claimLookup: (mod: string) => readonly string[],
): BaselineProblem[] {
  const out: BaselineProblem[] = [];
  const deadSet = new Set(dead);
  for (const m of dead) {
    if (baseline.has(m)) continue;
    out.push({
      kind: "新增死模块",
      mod: m,
      why:
        "从任何入口都走不到，且不在基线里 ⇒ 三选一：接上它 / 删掉它 / " +
        "把它连**特征串**一起登记进基线（特征串须在本模块出现且其余 src 模块不出现，" +
        "光秃秃的名字不收）",
    });
  }
  for (const m of baseline.keys()) {
    if (deadSet.has(m)) continue;
    const claims = claimLookup(m);
    out.push({
      kind: "基线里的已经活了",
      mod: m,
      why:
        "现在从入口走得到了 ⇒ ① 把它从 BASELINE 删掉；② 下面这些位置写着" +
        "「没人调用」类主张，已过期，逐条改掉：" +
        (claims.length > 0
          ? claims.join(" ; ")
          : "（src/docs 里没扫到主张句 ⇒ 主张只在优化设计文档里，去改那里）"),
    });
  }
  return out;
}

/**
 * 找主张位置：哪些文件哪些行，把某个模块说成了「零 X / 没人 X」。
 *
 * 口径**故意宽**：模块名（或它的 basename）与一个否定词**同行**出现就算。
 * 宁可多报几条让人扫一眼，也不要漏 —— 漏一条就是「过期主张读起来像事实」那一族。
 * 只在 src 与 docs 里找（主张就写在这两处）。
 */
export function claimSites(
  mod: string,
  rows: ReadonlyArray<{ readonly file: string; readonly text: string }>,
): string[] {
  const base = mod.replace(/\.ts$/, "");
  const leaf = base.split("/").pop() ?? base;
  const NEG =
    /(?:零\s*(?:import|调用方|读者|命中|写入方|生产者)|没有[^。]{0,14}(?:调用方|读者|import|写入方|生产者)|无人\s*(?:调用|import|读)|对外零)/;
  const out: string[] = [];
  for (const r of rows) {
    const lines = r.text.split(NL);
    for (let n = 0; n < lines.length; n++) {
      const l = lines[n] as string;
      if (!NEG.test(l)) continue;
      if (!l.includes(base) && !l.includes(leaf)) continue;
      out.push(r.file + ":" + (n + 1));
      if (out.length >= 6) return out;
    }
  }
  return out;
}

/** 基线自证：每条今天**确实还不可达**。活着的条目留在表里就是假账。 */
export function staleBaselineEntries(
  baseline: Baseline,
  dead: readonly string[],
): string[] {
  const d = new Set(dead);
  return [...baseline.keys()].filter((k) => !d.has(k));
}

/** 基线特征串资格：出现在本模块 + 在其余 src 模块里一次都不出现。 */
export function invalidBaselineMarks(
  baseline: Baseline,
  mods: readonly Module[],
): string[] {
  const out: string[] = [];
  for (const [mod, mark] of baseline) {
    const own = mods.find((m) => m.rel === mod);
    if (own === undefined) {
      out.push(mod + "：不在取材范围里（改名、挪走或删了？）");
      continue;
    }
    if (!own.text.includes(mark)) {
      out.push(
        mod + "：本模块正文里没有特征串「" + mark + "」⇒ 这条豁免的理由已过期",
      );
      continue;
    }
    const leaked = mods.filter((m) => m.rel !== mod && m.text.includes(mark));
    if (leaked.length > 0) {
      out.push(
        mod +
          "：特征串「" +
          mark +
          "」不唯一，也出现在 " +
          leaked.map((m) => m.rel).join(", "),
      );
    }
  }
  return out;
}

/**
 * 主张取材：src 的非测试 .ts + docs 下的 .md。走 git 而不是维护名单（名单会漏新文件）。
 *
 * `listFiles` 是注入点（本仓 `io` / `cardDeps` / `act` 同一族做法），**为的是让
 * 「取材为空必须抛」这一发能被判而不必先造一个临时 git 仓**。默认值走 git。
 */
export function trackedRows(
  rootDir: string = repoRoot(),
  listFiles: (cwd: string) => string[] = gitTrackedFiles,
): Array<{ readonly file: string; readonly text: string }> {
  const paths = listFiles(rootDir)
    .filter((p) => p.startsWith(SRC_REL + "/") || p.startsWith("docs/"))
    .filter((p) => !p.endsWith(".test.ts"))
    .sort();
  if (paths.length === 0) {
    // 取材为空必须抛，不能被读成「没有过期主张」（0006 §7 第 22 条）。
    throw new Error("判据失效：没拿到任何 src/docs 文件，不是【主张全部有效】");
  }
  return paths.map((p) => ({
    file: p,
    text: readFileSync(join(rootDir, p), "utf8"),
  }));
}

function gitTrackedFiles(cwd: string): string[] {
  const raw = execFileSync(
    "git",
    ["-c", "core.quotepath=off", "ls-files", "-z", "--", "*.md", "*.ts"],
    { cwd, maxBuffer: 1 << 26 },
  );
  return Buffer.from(raw)
    .toString("utf8")
    .split(String.fromCharCode(0))
    .filter(Boolean);
}
