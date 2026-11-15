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
