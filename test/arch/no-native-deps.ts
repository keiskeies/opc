/*
 * 豁免判定：哪些文件不算【生产源码】。
 *
 * 为什么要抽出来：原来这行写在 no-native-deps.test.ts 里，写成
 *   rel.split(posix.sep).includes(...EXEMPT_DIRS)
 * 而 Array.prototype.includes 只接受一个参数，展开传参是编译期错误（TS2556）。
 * 因为 test 目录整棵都不在 tsc 的射程里（根 tsconfig 是 files: [] 加四个包引用），
 * 这个错误从未被任何柱子看见。它今天【碰巧】是对的：EXEMPT_DIRS 只有一个元素，
 * 展开一个元素恰好等价于正确写法。所以没有任何测试会因它而红 —— 它是一颗延时
 * 的雷：谁往名单里加第二个目录，那个目录就【静默地不被豁免】。
 *
 * 抽成纯函数后，【第二个及以后的豁免目录也必须生效】这件事第一次变成可测的。
 * 判定顺序照原样保留：先看目录名单，再看并发夹具的尾巴。
 */

import { lexTs } from "./ts-lex.js";

export function isExemptPosix(
  relPosix: string,
  exemptDirs: readonly string[],
  fixtureTail: string,
): boolean {
  const parts = relPosix.split("/");
  for (const dir of exemptDirs) {
    if (parts.includes(dir)) {
      return true;
    }
  }
  return relPosix.endsWith(fixtureTail);
}

/**
 * 遍历目录时，「读不动」该跳过还是该照抛 —— 注入式纯函数。
 *
 * 判据与 `test-inventory.ts` 的 `survivesStat` 是同一条，但**不 import 它**：那边判的是
 * 单个文件还在不在（stat），这边判的是一整个目录读不读得动（readdir），两者的返回语义
 * 不同（一个给 boolean 存在性，一个给「这一层要不要跳过」）。抽成纯函数的理由与那边
 * 一字不差：三种态（消失 / 在 / 权限拒绝）都能用合成输入钉住，不靠真造真删去撞时间窗 ——
 * 那种测试本身就是流动的，撞不响的那一次不是通过，只是没撞。
 *
 * 只宽容「消失了」这一类（ENOENT / ENOTDIR）：并行的另一条守卫随时在删自己上一轮留下
 * 的夹具，撞上是正常路径。**权限类错误照抛**：吞掉它等于让零容忍扫描器静默少扫一整片
 * 目录，而它的全部价值就在于「扫到的每一条都算数」。
 */
export function readdirSurvives(readdir: () => unknown[]): boolean {
  try {
    readdir();
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw e;
  }
}

/** 一次命中：说明符本身 + 所在行（1 起）。 */
export interface SpecHit {
  readonly spec: string;
  readonly line: number;
}

/**
 * 说明符算不算【指向】被禁的原生实现。
 *
 * 三条：精确等于、`名字/子路径`、以及【只按这两条】。第二条是修一个静默漏判：
 * 老口径是 `line.includes('"' + mod + '"')`，要求名字【右边紧贴引号】，于是
 *   import D from "better-sqlite3/lib/utils"   ← 真的原生依赖，老口径看不见
 *   import D from "better-sqlite3/lib/database"
 * 第二条不是假想：本机 node_modules 里就有 better-sqlite3@12.11.1，实测它的
 * package.json【没有 exports 字段】⇒ 内部路径全都能直接 import。
 * 漏判的方向是【绿】—— 比红危险得多，而 D6 的全部价值就在这条扫描「扫到的每条都算数」。
 * 第一条不收窄：整棵语法树之外的 `require("x")` / `await import("x")` 也靠它兜住。
 *
 * 为什么不干脆只认 import 位置：那会把 `require("better-sqlite3")` 放过去，
 * 而老口径今天【是】抓得到它的。收窄 = 制造新的漏判，与刚才修的是同一类错。
 */
export function isForbiddenSpec(
  name: string,
  forbidden: readonly string[],
): boolean {
  return forbidden.some((m) => name === m || name.startsWith(m + "/"));
}

/**
 * 扫【代码区】里的字符串字面量，返回指向被禁模块的那些；注释里的不算。
 *
 * ── 为什么要动这一刀 ───────────────────────────────────────────
 * 触发它的是我自己：在 packages/hub/test/acceptance/phase3.test.ts 的注释里
 * 提了一句探针的内容，D6 当场红 —— 而那条守卫给的补救指引写的是「把所在目录加入
 * EXEMPT_DIRS」。注释里出现一个包名不是依赖，照着提示做就等于【为了消掉一条假阳性
 * 而把整片目录划出 D6 的射程】。一条会把人引向「削弱防线」的假阳性，危害大于它防的那件事。
 *
 * ── 口径变与没变（别以为换了实现就什么都没变）──────────────────
 *  · 注释里：老红 → 新绿。修的就是这条。
 *  · 代码里的字符串：【与老口径一致】（老口径的「引号+名字+引号」本质就是在找代码串），
 *    所以 `throw new Error("请用 better-sqlite3")` 这种仍然算命中。这是【刻意】的：
 *    收窄到 import 位置会放过 require / 动态 import，那是拿假阳性换假阴性。
 *  · 子路径：老绿 → 新红。修的是漏判，见 isForbiddenSpec。
 * 注释与代码的区分不在这里重写一遍扫描器 —— 全仓只有 ts-lex.ts 那一份（它的文件头
 * 就是为这件事写的：「各写一份的后果是两份会漂移，而漂移的表现是其中一份悄悄不判了」）。
 */
export function forbiddenSpecs(
  src: string,
  forbidden: readonly string[],
): SpecHit[] {
  const hits: SpecHit[] = [];
  // 行号表：只在真命中时才用得上，但建表是 O(n) 且 n 是文件大小，不值当为它加分支。
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "\n") lineStarts.push(i + 1);
  }
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      // mid 恒在 [0, length) 内（lo/hi 都是表内下标），所以取值不会是 undefined；
      // noUncheckedIndexedAccess 不知道这一点，按 ts-lex.ts 同一写法断言回去。
      if ((lineStarts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  lexTs(src, {
    onString: (_kind, body, open) => {
      if (isForbiddenSpec(body, forbidden)) {
        hits.push({ spec: body, line: lineOf(open) });
      }
    },
  });
  return hits;
}
