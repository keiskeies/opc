/**
 * desktop 诚实标注守卫（O13 动作 3，docs/OPC-OS-功能优化设计.md §O13）。
 *
 * ── 守的是什么主张 ────────────────────────────────────────────────
 * 「packages/desktop 是 IPC 契约层，非可运行 App」。文档 §O13 说第三态
 * （像在做而没在做）是最贵的：这个包 1557 行、每块有分母、tsc 全绿，
 * 从测试输出上【读起来像个能跑的桌面端】，而它既没有 electron 依赖也没有入口脚本。
 *
 * ── 为什么标注要配守卫，光写注释不算 ──────────────────────────────
 * 注释会朝两个方向过期，本仓对这一族的教训写在 claims-registry.ts 文件头：
 * · 标注还在、包却变真了（补了 electron / 加了入口）⇒ 标注变成假谦虚，
 *   读的人会低估已完成的东西 —— 方向 B。
 * · 标注被顺手删了、包还是假的 ⇒ 回到第三态 —— 方向 A。
 * 双向判、判据纯化（吃三串文本，不碰盘），合成输入变异 —— 同 claims-registry 家法。
 *
 * 「变真」的口径刻意取【两条都算】：package.json 出现 electron 依赖，
 * 或根 scripts 出现指向 packages/desktop 的入口。任一条成立都足以让
 * 「非可运行」这句假 —— 判据宁松勿紧，漏一条就是静默失效（r2 那一格刚演示过）。
 */

/** 标注特征串：出现在 packages/desktop/src/index.ts 文件头即「已诚实标注」。 */
export const HONEST_LABEL_MARKER = "非可运行 App";

export interface DesktopFacts {
  /** packages/desktop/package.json 的原文。 */
  readonly pkgJson: string;
  /** 根 package.json 的 scripts 段原文（渲染成 JSON 串即可，判据只看文本）。 */
  readonly rootScripts: string;
  /** packages/desktop/src/index.ts 的原文。 */
  readonly indexTs: string;
}

/**
 * 依赖面：electron 是否作为依赖出现。
 * 只认 deps 里的引号键（"electron":）——注释与字符串里提一句 electron 不算装上了；
 * @electron/* 子包也不算壳本体依赖，但它一样需要「摘标注再重登记」，
 * 所以宽松到 electron 前缀命中即算变真。
 */
export function hasElectronDep(pkgJson: string): boolean {
  return /"@?[a-z0-9-]*electron[a-z0-9/-]*"\s*:/iu.test(pkgJson);
}

/** 入口面：根 scripts 是否有指向本包的命令。 */
export function hasDesktopEntry(rootScripts: string): boolean {
  return rootScripts.includes("packages/desktop");
}

/**
 * 返回 "" = 今天自洽；非空 = 人话报警。
 * 方向 A：还是假的 ⇒ 标注必须在；
 * 方向 B：已经真了 ⇒ 标注必须摘（并去更新 §O13 与这条守卫自己的口径）。
 */
export function checkHonestLabel(f: DesktopFacts): string {
  const real = hasElectronDep(f.pkgJson) || hasDesktopEntry(f.rootScripts);
  const labeled = f.indexTs.includes(HONEST_LABEL_MARKER);
  if (!real && !labeled) {
    return (
      "packages/desktop 仍是 IPC 契约层（无 electron 依赖、无根入口脚本），" +
      "而 src/index.ts 的诚实标注「" +
      HONEST_LABEL_MARKER +
      "」不见了 —— 回到 §O13 说的第三态了"
    );
  }
  if (real && labeled) {
    return (
      "packages/desktop 有 electron 依赖或根入口脚本了（变真），" +
      "而 src/index.ts 还挂着「" +
      HONEST_LABEL_MARKER +
      "」标注 —— 摘掉它，并把 docs/OPC-OS-功能优化设计.md §O13 动作 3 一起改掉"
    );
  }
  return "";
}
