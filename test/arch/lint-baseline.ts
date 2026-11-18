/**
 * `pnpm lint` 基线：把「verify 的第一段今天恒红」从一句散文变成一个会红的东西。
 *
 * ── 为什么是这一发 ─────────────────────────────────────────────
 * 计划（`docs/superpowers/plans/2026-11-06-opc-os-development-plan.md`）里 6 道阶段出口门
 * 有 3 道的 `**Run**` 行写着 `pnpm verify`（Task 0.11 / 1.8 / 3.8），而根 `package.json` 里
 * `verify = lint && typecheck && test`。本轮实测：typecheck 0、test 全绿、**lint 恒红**。
 * 于是那三道门的 Run 行一条都复核不了 —— 而这件事此前**只活在散文里**：
 * 0057 与 0059 各自往文档里手抄过一句「286 error / 109 warning」，
 * 今天的读数是 **292 / 109**（多出来的那几条是 round270 起那几轮自己加的文件）。
 * 手抄的数漂了 6 条，没有任何一条守卫发现 —— 这正是 O14 那一族（「当年的读数被当成今天的读数」）
 * 在**工具链**上的一次复发：以前治的是代码主张，这次红的是「我核对过」这句话本身。
 *
 * ⚠ 上面那句「3 道」是**数出来的**，但【复算时别照抄下面这条 grep】：
 * `grep -cE 'Run.*pnpm verify'` 今天给 **4** 而不是 3 —— 多出来那一发是 Task 0.2（工具链骨架），
 * 它也有 `**Run**：pnpm verify` 但它【不是出口门禁】。3 这个数的口径是
 * 「标题含『出口门禁』的 Task 里 Run 行写 verify 的」，得先按标题筛一遍（本轮实测：
 * 6 道出口门禁 → 0.11 / 1.8 / 3.8 有 verify 行，2.9 / 4.7 / 5.8 【连 Run 行都没有】）。
 * 这正是本文件开头那条主张的反面实例：一条【没带口径的 grep】写进注释，三天后就成了
 * 一条对不上的数。形状记在这儿，就是为了下一个复算的人不再被它绊一次。
 * 我先前还有个版本写着「5 道门全部写着 verify 全绿」，那是凭记忆写的假话 —— 2.9 / 4.7
 * 根本没有 `**Run**` 行，它们各要一个 Playwright E2E。而【那两道的依赖与文件状态已经变了】：
 * round291 之后 `test/e2e/ceo-loop.spec.ts` + 根 `playwright.config.ts` + 根 devDependencies
 * 里的 playwright@1.65.1 都【存在】了，4.7 那道（`mobile-approval.spec.ts`）今天仍然没有文件。
 * 「没有 Run 行」这一句【仍真】—— 所以 2.9 的复核入口是本轮新增的 `pnpm test:e2e`，
 * 不是 `pnpm verify`。
 *
 * ── 为什么是棘轮，而不是把 lint 修绿 ───────────────────────────
 * 272 条 error 里 162 是 format、119 是 organizeImports，两类**都自动可修**，
 * 但那意味着一次一次动 169 份文件的纯排版提交（169 = 现数，见 `.workbuddy/round285-lint-blast.mjs`；
 * 这一句此前写的是「200+ 文件」，那是把**诊断条数**当**文件数**读 —— 上面说过这两类的
 * 计数单位是文件，所以条数 ≠ 文件数），混在本轮这一大片未提交改动里（`git status --porcelain` 现数），
 * 之后没有任何人能从那堆 diff 里读出「哪一行是真改动」。这是判断，不是偷懒，
 * 理由与代价一起写在优化设计文档 §7 的落地块里。剩下的 11 条 lint error 有 10 条
 * 在测试文件里，是 `while ((m = re.exec(s)) !== null)` 那类**刻意的**惯用法 ——
 * 它们不是「坏了」，是「这条规则对这个用途过严」，改法应当是关规则或就地豁免，
 * 而不是把惯用法改残。
 *
 * ⚠ 上面那几个数是【立这一发那天】的读数，会随修复下调 —— 复算别抄它：
 * `npx vitest run test/arch/lint-baseline.test.ts` 里真仓库那一发读的就是今天的数，
 * 要看逐类目用 `npx tsx .workbuddy/round285-lint-own.mjs`。
 * 「272 条里 162 format / 119 organizeImports」和「剩下 11 条 lint error 有 10 条在测试里」
 * 都属于【那一天的】读数 —— 下面那张表才是当前的上限，正文只讲形状不讲数。
 * round285 就下调了两次：(a) `noSelfCompare` 与 `noConstantCondition` 两条真降到 0
 * （同一行 `expect(note).toContain("spawn" === "spawn" ? … : "")` —— 一条【永真三元】
 * 撑出来的死装饰，摘掉它行为一字不变），表里那两条豁免随之【删掉】而不是留着；
 * (b) 把 `claims-registry.test.ts` 那一发我自己新写的用例格式修齐 ⇒ format 少一条。
 * ⚠ (b) 只动【整份未入库】的文件：`organizeImports` / `format` 是【一份文件一条】的诊断，
 * 对一份早已入库的老文件做 `--write` 会把别人没碰过的行一起重排 ⇒ 那属「先 commit 再全仓修」
 * 那一格（要问），不在这条棘轮的授权范围里。
 *
 * 所以这一发买的是**方向**：error 只许减不许增，且**冒出新种类当场红并报出种类名**。
 * 修的人随时可以往下调数字（那正是它鼓励的事），往上调必须点名。
 *
 * ── 为什么只判 error ───────────────────────────────────────────
 * 109 条 warning 与 2 条 info **不让 `pnpm lint` 退出码非 0**（biome 默认 errorOnWarnings=false，
 * 实测：292 error 在 ⇒ exit 1；把 error 全消掉就是 exit 0）。判 warning 等于给自己加一条
 * 不在门禁里的判据 —— 加戏的部分不参与「verify 能不能绿」这个问题，就不占这条守卫的账。
 *
 * ── 探针必须排除，否则这条守卫会随机红 ─────────────────────────
 * `test/arch/dependency-boundary.test.ts` 为了证明 biome 的 SQLite 边界规则真的会挡，
 * 必须往**真实源码目录**写一个越界 import 的文件（写进系统临时目录就不在规则射程内，
 * 那个测试等于什么都没测 —— 见 `run-fixtures.ts` 的文件头）。它活着的那几百毫秒里，
 * 本守卫的整仓扫描会看见多出来的一条 error：实测 292 → 293（复算命令
 * `node .workbuddy/round274-lint-baseline.mjs`，它现场写探针再量差值，不抄这个数）。
 * 同一条坑此前咬过 no-native-deps（知道，按文件名排除）与 production-deps（不知道，
 * 随机红过一次）。这里从 `run-fixtures.ts` 那一份唯一真相取名单，不再抄一遍文件名。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRuntimeFixture } from "./run-fixtures.js";

/** 一条 error 类目的基线：类目名 + 当时实测条数（= 不许超过的上限）。 */
export interface BaselineEntry {
  /** biome 的 category 原文；formatter 的那一类就叫 `format`，不带 lint/ 前缀。 */
  readonly category: string;
  /** 当时实测条数，作为**上限**。往下调 = 有人在修，随时欢迎；往上调要点名。 */
  readonly atMost: number;
}

/**
 * 2026-11-17 实测（`node .workbuddy/round274-lint-baseline.mjs`，已排除运行期夹具探针）。
 * 这一份数据是**上限表**不是**期望表**：它不要求今天正好这么多，只要求不许更多。
 */
export const LINT_BASELINE: readonly BaselineEntry[] = [
  { category: "format", atMost: 161 },
  { category: "assist/source/organizeImports", atMost: 117 },
  { category: "lint/suspicious/noAssignInExpressions", atMost: 4 },
  { category: "lint/correctness/noUnsafeOptionalChaining", atMost: 3 },
  { category: "lint/suspicious/useIterableCallbackReturn", atMost: 2 },
];

/** biome JSON 读数里本守卫要看的那几个字段。 */
export interface BiomeDiagnostic {
  readonly severity: string;
  readonly category: string;
  readonly location: { readonly path: string };
}

/** 计数：只数 error，只数非探针文件。路径归一到 posix 再判文件名。 */
export function countErrorCategories(
  diagnostics: readonly BiomeDiagnostic[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of diagnostics) {
    if (d.severity !== "error") continue;
    const path = String(d.location.path).split("\\").join("/");
    const name = path.slice(path.lastIndexOf("/") + 1);
    // 运行期夹具不是源码：它是别的测试为了「让规则有射程」故意放进去的临时文件。
    if (isRuntimeFixture(name)) continue;
    out.set(d.category, (out.get(d.category) ?? 0) + 1);
  }
  return out;
}

/** 棘轮判据（纯函数，变异测试直接喂合成读数）。返回 "" 表示在基线内。 */
export function diffLintBaseline(
  counts: ReadonlyMap<string, number>,
  baseline: readonly BaselineEntry[] = LINT_BASELINE,
): string {
  const cap = new Map(baseline.map((b) => [b.category, b.atMost]));
  const over: string[] = [];
  const unregistered: string[] = [];
  for (const [category, n] of counts) {
    const allowed = cap.get(category);
    if (allowed === undefined) {
      unregistered.push(category + "=" + n);
      continue;
    }
    if (n > allowed) over.push(category + " " + allowed + "→" + n);
  }
  // 「全修完了」是这条棘轮的**目标状态**，不是失败。把它判红就造出了本仓反复清理的
  // 那个东西 —— 一条恒不可能通过的验收命令（0057 §O6 验收第 1 条 / 0060 的标题），
  // 而恒红的信号会让人学会跳过它。「扫描其实没跑」这一族假绿不在这里防，
  // 它由 .test.ts 里的两条哨兵负责：filesChecked 下限 + summary.errors 自洽。
  if (unregistered.length > 0) {
    return (
      "出现了基线外的 error 类目（" +
      unregistered.sort().join(", ") +
      "）—— 新种类的 error 必须先在 LINT_BASELINE 里点名并写明理由，" +
      "否则它会顺着「反正 lint 本来就红」混过去"
    );
  }
  if (over.length > 0) {
    return (
      "`pnpm lint` 的 error 比基线多了（" +
      over.join("；") +
      "）。这一发是棘轮：只许减不许增。" +
      "要么把新增的那几条改掉，要么在 LINT_BASELINE 里点名并说清为什么值得。"
    );
  }
  return "";
}

/**
 * 反向的一半：某类目已经修干净了，表里那条豁免就成了「永真的空壳」。
 * 不判红（修完是好事），报的是「请把这条从表里删掉」—— 与 zero-producer 那族
 * 「基线里的条目对应符号已消失 ⇒ 豁免自动失效」同一立场：豁免不许比现实活得久。
 */
export function staleBaselineEntries(
  counts: ReadonlyMap<string, number>,
  baseline: readonly BaselineEntry[] = LINT_BASELINE,
): string[] {
  return baseline
    .filter((b) => (counts.get(b.category) ?? 0) === 0)
    .map((b) => b.category);
}

/** 平台二进制定位：Windows 上 npx 是 .cmd，spawnSync 直接调会 ENOENT / EINVAL。 */
export function findBiomeBinary(root: string): string {
  const exe = process.platform === "win32" ? "biome.exe" : "biome";
  const suffixes =
    process.platform === "win32"
      ? ["win32-x64", "win32-arm64"]
      : process.platform === "darwin"
        ? ["darwin-x64", "darwin-arm64"]
        : ["linux-x64", "linux-arm64", "linux-x64-musl"];
  const pnpmRoot = join(root, "node_modules", ".pnpm");
  if (existsSync(pnpmRoot)) {
    for (const dir of readdirSync(pnpmRoot)) {
      for (const sfx of suffixes) {
        if (!dir.startsWith("@biomejs+cli-" + sfx + "@")) continue;
        const cand = join(
          pnpmRoot,
          dir,
          "node_modules",
          "@biomejs",
          "cli-" + sfx,
          exe,
        );
        if (existsSync(cand)) return cand;
      }
    }
  }
  for (const sfx of suffixes) {
    const flat = join(root, "node_modules", "@biomejs", "cli-" + sfx, exe);
    if (existsSync(flat)) return flat;
  }
  throw new Error(
    "找不到 biome 平台二进制（试过 " +
      suffixes.join(", ") +
      "）。宁可直接抛错，也不空跑成假通过。",
  );
}

export interface BiomeRun {
  readonly exitCode: number;
  readonly summary: {
    readonly errors: number;
    readonly warnings: number;
    readonly infos: number;
  };
  readonly diagnostics: BiomeDiagnostic[];
  readonly filesChecked: number;
}

/**
 * 真跑一次 `biome check .` 并解析 JSON 读数。
 * 反假绿：拿不到 JSON / 没有 summary / 扫到 0 个文件 ⇒ 抛错，绝不返回「干净」。
 */
export function runBiomeJson(root: string): BiomeRun {
  const r = spawnSync(
    findBiomeBinary(root),
    ["check", ".", "--reporter=json", "--max-diagnostics=100000"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 256 * 1024 * 1024,
      shell: false,
    },
  );
  if (r.error) throw new Error("biome 调用失败：" + r.error.message);
  const stdout = String(r.stdout ?? "");
  if (!stdout.trimStart().startsWith("{")) {
    throw new Error(
      "biome 没给出 JSON 读数（退出码 " +
        r.status +
        "）。尾 400 字：\n" +
        (stdout + String(r.stderr ?? "")).slice(-400),
    );
  }
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("summary" in parsed) ||
    !("diagnostics" in parsed)
  ) {
    throw new Error("biome JSON 缺 summary / diagnostics 字段，判据无法成立。");
  }
  const p = parsed as {
    summary: {
      errors?: number;
      warnings?: number;
      infos?: number;
      unchanged?: number;
      changed?: number;
      matches?: number;
    };
    diagnostics: BiomeDiagnostic[];
  };
  // 扫到多少个文件：summary 里是 unchanged+changed+matches 三段之和。
  const filesChecked =
    (p.summary.unchanged ?? 0) +
    (p.summary.changed ?? 0) +
    (p.summary.matches ?? 0);
  return {
    exitCode: r.status ?? -1,
    summary: {
      errors: p.summary.errors ?? 0,
      warnings: p.summary.warnings ?? 0,
      infos: p.summary.infos ?? 0,
    },
    diagnostics: p.diagnostics,
    filesChecked,
  };
}
