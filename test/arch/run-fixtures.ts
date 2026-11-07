/**
 * 运行期夹具：测试【故意】写进 packages/<pkg>/src/ 的临时文件，跑完即删。
 *
 * 为什么需要一份唯一真相：dependency-boundary.test.ts 必须在真实源码目录里放一个
 * 引用 better-sqlite3 的文件，才能证明 biome 的边界规则真的会挡 —— 写进系统临时目录
 * 就不落在规则的路径范围内，那个测试等于什么都没测。代价是这个文件活着的那几百毫秒里，
 * 任何并行跑动的源码扫描都会看见一个【真实存在的越界 import】：
 *
 *   · no-native-deps.test.ts 早就知道这件事，它按文件名排除；
 *   · production-deps.test.ts 是第三个消费者，它不知道，于是随机红
 *     （实测：单跑 3 次全绿；与 dependency-boundary 并发跑 3 次红 1 次）。
 *
 * 探针名此前在两个文件里各写一遍，靠一句注释提醒同步 —— 注释不是机制，它没能拦住
 * 第三个消费者（也就是我自己）。现在只有这一处定义，改名由 import 强制传播。
 */
export const BOUNDARY_PROBE = "__boundary_probe.ts";

/** 扫描源码时须视同"不是源码"的文件名。 */
const FIXTURES: ReadonlySet<string> = new Set<string>([BOUNDARY_PROBE]);

export function isRuntimeFixture(name: string): boolean {
  return FIXTURES.has(name);
}
