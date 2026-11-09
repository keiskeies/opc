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
