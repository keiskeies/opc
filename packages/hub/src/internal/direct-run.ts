/**
 * 「本模块是被直接执行的吗」—— 唯一实现。
 *
 * 为什么值得单独成文件而不是各写一份：这个谓词失效的方式是【静默】的。
 * 写错（比如忘了 import.meta.url 是每个模块各自的 URL）的后果是"入口块不执行"，
 * 于是进程什么都不干、退出码 0，测试里表现为 expected 0 to be 2 之类的迷惑结果，
 * 而真正的故障在另一行。三份副本只会让同一个错误出现三次。
 *
 * @param selfUrl 调用方自己的 import.meta.url —— 必须由调用方传，
 *                在本文件里取 import.meta.url 判断的是本文件，永远是 false。
 */
import { pathToFileURL } from "node:url";

export function isDirectRun(
  selfUrl: string,
  argv1: string | undefined,
): boolean {
  if (argv1 === undefined || argv1 === "") return false;
  try {
    return pathToFileURL(argv1).href === selfUrl;
  } catch {
    // argv[1] 不是合法路径（某些打包器会塞进非路径字符串）时，
    // "不是直接执行"是唯一安全的解释：宁可什么都不做，也不要在被 import 时跑副作用。
    return false;
  }
}
