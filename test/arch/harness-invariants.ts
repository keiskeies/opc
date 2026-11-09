import { readdirSync } from "node:fs";
import { join } from "node:path";

// 测试装置自身的不变量：测试有没有被发现、测试代码有没有被 lint。
//
// 为什么判据放在纯模块而不是直接写在 globalSetup 里：globalSetup 不是 *.test.ts，
// tsc 不覆盖它（0007 §5.2），也没法给它写单元测试。抽成纯函数之后，判据本身归 include
// 管辖、有 canary 钉着；globalSetup 只负责【在没有测试跑的时候也照样执行】这一件事。
//
// 为什么必须有这条通道（实测，0006 §7-41）：把 vitest 的 include 改窄成只匹配三个文件
// 的一条模式，pnpm verify 全绿 —— 因为做【测试面缩小】检查的守卫自己就在被排除的范围里。
// 任何【由测试执行】的检查都防不住【测试不被执行】。
//
// 判据只查【必需项还在】，不查有没有多余项：误报会让整套 verify 挂掉，代价比漏报高
//（0007 §4.1）。解码失败必须报问题，不许当成【没发现问题】（§7-38）。
const NL_TEXT = String.fromCharCode(10);

export interface HarnessProblem {
  readonly why: string;
}

export interface HarnessInput {
  readonly vitestInclude: readonly string[];
  /** vitest.config.ts 的 test.globalSetup 数组。 */
  readonly globalSetup: readonly string[];
  readonly biomeIncludes: readonly string[];
  readonly diskTestFiles: readonly string[];
  /**
   * vitest.config.ts 是否开着 test.expect.requireAssertions。
   *
   * 为什么要有这一样：把某条用例的整个 body 掏空（标题与条数一字未动），
   * 默认配置下它照样绿 —— 实测 test/arch/decision-index.test.ts 第一条掏空后
   * 2 例全过、退出码 0。开关开着时同一条刀当场失败，而其余 307 例无一误伤，
   * 包括体内只 await fn() 委托的包装用例（判定在运行时，委托里跑到的 expect 也算）。
   * 见 0006 §7 第 59 条。
   */
  readonly requireAssertions: boolean;
}

/**
 * 少任何一条，就会有一批测试文件静默不跑。逐字比对，不做模糊匹配。
 *
 * 抄自 vitest.config.ts，并与 test-inventory.test.ts 的 INCLUDE_PATTERNS 逐字一致 ——
 * 那条常量已被【与真配置比对】的 it 守着，所以这里是三方对齐，不靠任何人记得同步。
 */
export const REQUIRED_VITEST_INCLUDE: readonly string[] = [
  "test/**/*.test.{ts,tsx}",
  "packages/*/test/**/*.test.{ts,tsx}",
];

/** 丢掉它，测试代码就脱离 lint；这一条的代价已在 §7-38 量过（根目录 .ts 曾同样脱离）。 */
export const REQUIRED_BIOME_INCLUDES: readonly string[] = [
  "test/**/*.{ts,tsx}",
];

/**
 * globalSetup 里必须有这一个。
 *
 * 为什么这条只能由【测试】守、不能由 globalSetup 自己守：那一行被删掉时，globalSetup
 * 里这段代码根本不会执行，让它报告【我没被注册】是循环。而测试照常全绿 —— 实测只删
 * vitest.config.ts 那一行：91 个文件 / 312 例全过 / 退出码 0，没有任何一条用例变红。
 * 所以兜底只能来自【被 include 管辖的用例去读真配置】。
 */
export const REQUIRED_GLOBAL_SETUP: readonly string[] = [
  "test/global-setup/build-contracts.ts",
];
/**
 * 这一样必须是 true。写成常量供比对，不在判据里写裸字面量。
 *
 * 为什么放进模块常量而不是 RequiredLists：布尔值没有【清单为空】那一态，
 * 放进注入结构里就得为【false 表示不要求】多开一条分支，而那条分支没人走 ——
 * 新增未测分支正是 §7-53、§7-54 记过的错。写成常量后，把它翻成 false 会让
 * 真配置（读到 true）不匹配，正向那条用例立刻红，翻不动。
 */
export const REQUIRED_REQUIRE_ASSERTIONS = true;

/** 下限取保守值：只防【扫描通路整个坏掉】，不当【测试文件数目的账本】用。 */
export const MIN_TEST_FILES: number = 15;

/**
 * 必需项有没有逐字出现在读到的清单里。两条边界都算问题：
 *
 * · 清单为空 → 报一条【解码失败】，不逐条报缺失。否则【读不到配置】会被伪装成一堆缺失，
 *   或者更糟，被误当成没问题（§7-38：空解析结果是解码失败，不是零发现）。
 * · 清单非空但少某条 → 逐条点名。
 */
function missing(
  found: readonly string[],
  required: readonly string[],
  where: string,
): HarnessProblem[] {
  if (found.length === 0) {
    return [{ why: where + " 一条都没读出来，比对会退化成空对空" }];
  }
  const out: HarnessProblem[] = [];
  for (const r of required) {
    if (found.includes(r)) continue;
    out.push({ why: where + " 里缺 " + r + " —— 测试面可能被改窄" });
  }
  return out;
}

/**
 * 必需项清单本身。默认取模块里那两个常量，测试可注入别的值 ——
 * 没有这个注入口，【清单被掏空】那条分支就只能靠改模块源码才能触发，
 * 于是它从来没有被任何测试断过（实测：把它改成永不触发，本文件其余各条全绿）。
 */
export interface RequiredLists {
  readonly vitestInclude: readonly string[];
  readonly biomeIncludes: readonly string[];
  readonly globalSetup: readonly string[];
}

/**
 * @param input 由调用方读好的三样东西。本函数不碰文件系统，所以能被单测喂合成输入。
 * @param required 必需项清单；默认用模块常量，注入空清单即模拟【判据被掏空】。
 * @returns 问题列表；空列表表示测试装置完好。
 */
export function checkHarness(
  input: HarnessInput,
  required: RequiredLists = {
    vitestInclude: REQUIRED_VITEST_INCLUDE,
    biomeIncludes: REQUIRED_BIOME_INCLUDES,
    globalSetup: REQUIRED_GLOBAL_SETUP,
  },
): HarnessProblem[] {
  /* 必需项清单自己为空 = 这份守卫被掏空，不能当成【没有要求所以全过】。
     必须抢在逐条比对之前：清单为空时下面那两个循环一条也数不出来。 */
  if (
    required.vitestInclude.length === 0 ||
    required.biomeIncludes.length === 0 ||
    required.globalSetup.length === 0
  ) {
    return [{ why: "必需项清单本身是空的，判据已被掏空" }];
  }
  const out: HarnessProblem[] = [];
  out.push(
    ...missing(
      input.vitestInclude,
      required.vitestInclude,
      "vitest.config.ts 的 test.include",
    ),
  );
  out.push(
    ...missing(
      input.biomeIncludes,
      required.biomeIncludes,
      "biome.json 的 files.includes",
    ),
    ...missing(
      input.globalSetup,
      required.globalSetup,
      "vitest.config.ts 的 test.globalSetup",
    ),
  );
  if (input.requireAssertions !== REQUIRED_REQUIRE_ASSERTIONS) {
    out.push({
      why:
        "vitest.config.ts 的 test.expect.requireAssertions 不为 true" +
        " —— 被掏空断言的用例将以绿灯蒙过去",
    });
  }
  if (input.diskTestFiles.length < MIN_TEST_FILES) {
    out.push({
      why:
        "扫到磁盘测试文件 " +
        String(input.diskTestFiles.length) +
        " 个，低于下限 " +
        String(MIN_TEST_FILES) +
        " —— 扫描通路可能坏了",
    });
  }
  return out;
}

/**
 * 从 vitest.config.ts 的文本里读 include 列表。
 *
 * 解码方式必须是【双引号对】，不能按逗号切：模式里有 `{ts,tsx}` 这种带逗号的花括号，
 * 按逗号切会把一条模式切成两半 —— 我本轮真的错过一次。读不出来一律返回空数组，
 * 交给 checkHarness 报【解码失败】，而不是在这里猜。
 */
export function readVitestInclude(configText: string): string[] {
  const seg = /include: [\s\S]*?\[([\s\S]*?)\]/.exec(configText)?.[1] ?? "";
  if (seg === "") return [];
  return [...seg.matchAll(/"([^"]*)"/g)].map((m: RegExpExecArray): string =>
    String(m[1]),
  );
}

/**
 * 从 vitest.config.ts 的文本里读 test.globalSetup。读法与 readVitestInclude 同：
 * 认双引号对。
 * 那一行被整条删掉时返回空数组 —— 这里的【空】是真事故（没注册），必须走 missing() 的
 * 【一条都没读出来】，不许当成零发现（§7-38）。
 */
export function readVitestGlobalSetup(configText: string): string[] {
  const seg = /globalSetup:\s*\[([\s\S]*?)\]/.exec(configText)?.[1] ?? "";
  if (seg === "") return [];
  return [...seg.matchAll(/"([^"]*)"/g)].map((m: RegExpExecArray): string =>
    String(m[1]),
  );
}
/**
 * 从 vitest.config.ts 的文本里读 test.expect.requireAssertions。
 *
 * 只认【行首缩进后紧跟 expect: {】那一行及其后四行：配置里的散文注释也提到
 * 这个词，按全文搜会把注释当开关（§7 里同类错误记过不止一次）。读不到开关行、
 * 值不是 true、整行被删，一律返回 false —— 这里的 false 是真事故，不许当成零发现。
 * 读后面四行而不是只看一行，是为了让 biome 把对象展开成多行时不产生假红。
 */
export function readVitestRequireAssertions(configText: string): boolean {
  const lines = configText.split(/\r?\n/);
  const i = lines.findIndex((l: string): boolean =>
    /^\s*expect:\s*\{/u.test(l),
  );
  if (i < 0) {
    return false;
  }
  return /requireAssertions:\s*true/u.test(lines.slice(i, i + 5).join(NL_TEXT));
}

/** 从 biome.json 的文本里读 files.includes。JSON 坏了就当读不出来，不猜。 */
export function readBiomeIncludes(jsonText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return [];
  }
  const files: unknown = (parsed as { files?: unknown }).files;
  if (typeof files !== "object" || files === null) return [];
  const includes: unknown = (files as { includes?: unknown }).includes;
  if (!Array.isArray(includes)) return [];
  return includes.filter((x: unknown): x is string => typeof x === "string");
}

/**
 * 数磁盘上的测试文件（只数，不判断该不该被收集）。跳过依赖与产物目录。
 * 用途只有一个：给【扫描通路整个坏掉】兜底，所以宁少不多也不报错 —— 判断交给下限。
 */
const SKIP_DIRS: ReadonlySet<string> = new Set<string>([
  "node_modules",
  ".git",
  "dist",
  ".tmp",
  "coverage",
  ".next",
]);

/**
 * 遍历一棵目录树，按谓词收文件，返回【相对 rootDir、用 / 分隔】的路径。
 * 只有一份跳过语义：SKIP_DIRS。本仓出现过好几个文件各写一份目录遍历的情况，
 * 跳过清单从此只在这里长，别处复用。
 */
export function walkFiles(
  rootDir: string,
  accept: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (accept(e.name)) {
        const rel: string = dir.slice(rootDir.length);
        out.push(
          (rel + "/" + e.name).replace(/^[/\\]+/, "").replace(/\\/g, "/"),
        );
      }
    }
  };
  walk(rootDir);
  return out.sort();
}

export function countTestFiles(rootDir: string): number {
  return walkFiles(rootDir, (name: string) =>
    /\.test\.[cm]?[jt]sx?$/.test(name),
  ).length;
}
