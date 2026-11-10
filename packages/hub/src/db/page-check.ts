/**
 * `PRAGMA integrity_check` 的结果怎么读：一条判据 + 一段报告文本。
 *
 * ── 为什么单独一个文件，只有两个纯函数 ──────────────────────────────
 * 这条判据有【两个执行位置】：worker 线程里（Task 6.2 的主路径）与主线程上
 * （显式 opt-in 的那一支）。两侧拿不到同一个数据库连接，所以过去各写了一份
 * 「看起来一样」的判据 —— 那种形状本仓量过代价（0006 §7 第 55、56 条：
 * 复制的判据会漂移，而且漂移方向永远是【两边都还在绿】）。
 * 唯一的收口办法是让两侧 import 同一个函数。为此这个文件必须：
 *  - 【零 import】：worker 的模块图要小到「不可能因为缺包而加载不起来」
 *    （integrity.worker.ts 文件头第 2 条讲的就是这件事）。一个谁都能加载的
 *    纯函数模块，正是那条纪律允许的形状。
 *  - 【不碰数据库】：入参是已经取回来的行。判据因此可单测，不需要造库。
 *
 * 这也意味着【新增第三条判据时放这里，而不是任何一侧】：放一侧就又是一份副本。
 */

/**
 * 结果行 → 报告文本。
 * 取【每行第一个值】而不是按列名取：这一列的名字在不同 SQLite 版本里不稳
 * （本机 3.51.2 给的是 `integrity_check`）。按位置取不受列名影响。
 */
export function reportText(rows: readonly Record<string, string>[]): string {
  return rows.map((r) => String(Object.values(r)[0] ?? "")).join("\n");
}

/**
 * 判据：【恰有一行，且那一行恰为 "ok"】。不是【包含 "ok"】。
 *
 * 实测损坏库返回的是多行诊断文本（"*** in database main ***\nTree 2 page 4
 * cell 11: Offset 65173 out of range…"）。那段文本里【出现 "ok" 这个子串】
 * 由损坏内容自己决定 —— 用「包含」判过，等于给一个损坏库发通行证。
 */
export function isPageOk(rows: readonly Record<string, string>[]): boolean {
  return rows.length === 1 && String(Object.values(rows[0] ?? {})[0] ?? "") === "ok";
}
