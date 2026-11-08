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
export interface HarnessProblem {
  readonly why: string;
}

export interface HarnessInput {
  readonly vitestInclude: readonly string[];
  readonly biomeIncludes: readonly string[];
  readonly diskTestFiles: readonly string[];
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
 * @param input 由调用方读好的三样东西。本函数不碰文件系统，所以能被单测喂合成输入。
 * @returns 问题列表；空列表表示测试装置完好。
 */
export function checkHarness(input: HarnessInput): HarnessProblem[] {
  /* 必需项清单自己为空 = 这份守卫被掏空，不能当成【没有要求所以全过】。 */
  if (
    REQUIRED_VITEST_INCLUDE.length === 0 ||
    REQUIRED_BIOME_INCLUDES.length === 0
  ) {
    return [{ why: "必需项清单本身是空的，判据已被掏空" }];
  }
  const out: HarnessProblem[] = [];
  out.push(
    ...missing(
      input.vitestInclude,
      REQUIRED_VITEST_INCLUDE,
      "vitest.config.ts 的 test.include",
    ),
  );
  out.push(
    ...missing(
      input.biomeIncludes,
      REQUIRED_BIOME_INCLUDES,
      "biome.json 的 files.includes",
    ),
  );
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

export function countTestFiles(rootDir: string): number {
  let n = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(join(dir, e.name));
        continue;
      }
      if (/\.test\.[cm]?[jt]sx?$/.test(e.name)) n += 1;
    }
  };
  walk(rootDir);
  return n;
}
