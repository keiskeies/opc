/**
 * 「有没有人调这条端点」的探针自检（0067 §9 那次误用的守卫化）。
 *
 * ── 守的是什么 ────────────────────────────────────────────────────
 * 本仓反复用「界面零调用方」当一条主张的证据：0067 用它说明分发规则配置页没做，
 * r15 用它说明组织变更的出口在哪。0067 那一发实测下来是【假探针】——两处各自独立
 * 都能让「零命中」这个读数失去意义：
 *
 * · 扫错面：命令的扫描根写成 packages/web/src + packages/desktop/src，而渲染侧
 *   全部住在 packages/web/public/*.js（真控制室 29 万字节那份）。web/src 只有
 *   五份 .ts（dev-server / dev-sign / hub/projection / humanizer / index），
 *   一行 fetch 都没有 ⇒ 那份目录里任何端点都是零命中。r15（round295）登记的
 *   正是这一族：「扫描根只列 web/src 与 desktop/src、扩展名只筛 .ts/.tsx，
 *   真控制室不在它的视野里」。
 * · 查错串：app.js 的传输层把路径拼成 fetch("/api" + path)，调用点写的是
 *   api("POST", "/org")；group.js 把前缀提成 const API = "/api/v1"，调用点写
 *   request("/groups/…")。⇒ 拿整条「/api/v1/…」去 grep 渲染侧【永远】是 0，
 *   哪怕那一页第二天就上线。
 *
 * ── 为什么必须有控制组，光扫对目录还不够 ──────────────────────────
 * 上面两处洞的共同形状是【读数恒为 0】。一个恒为 0 的判据与被验对象没有任何因果，
 * 这正是本仓对「不可能红的判据 = 假绿」的定义（0007 §4.1）。所以这条守卫不判
 * 「那条端点有没有人调」—— 那归 r27 与配置页排期 —— 它判【探针本身能不能响】：
 * 同一套扫描面 + 同一个串形状，一条【已知有调用方】的端点必须非零命中。
 * 控制组不过就响亮报错，而不是替「零命中」作证。
 *
 * 口径边界：本守卫只证明「扫描面认得渲染侧的两种前缀拼法」。它【不】证明
 * 「没有界面调 dispatch/rules」——那是一件产品事实（配置页没做，属 CEO 排期），
 * 会随前端排期而变，不该钉成一条会红的判据。r27 判的仍是【端点在不在生产装配里】。
 */

/** 渲染侧的取材根：真控制室与管理视图都在这份目录下，且是【任意扩展名】。 */
export const UI_ROOT = "packages/web/public";

/** 一条「界面发出了这条端点」的证据：路径尾串在渲染侧被命中至少一次。 */
export interface ProbeResult {
  /** 被扫的相对路径（仅用于人话报警）。 */
  readonly file: string;
  readonly hits: number;
}

/**
 * 「有没有人调 /api/v1/x」的正确查询形状：去掉 /api/v1 前缀再找。
 * 两条前缀拼法（app.js 的 "/api" 与 group.js 的 "/api/v1"）都在运行时才补上，
 * 所以字面量里能看见的只有尾串 —— 查整串 = 恒 0。
 */
export function uiPathTail(path: string): string {
  return path.replace(/^\/api\/v1/, "");
}

/**
 * 控制组必须非零命中。返回 "" = 探针可信；非空 = 人话报警（探针不可信，
 * 此时同一表面量出的「零命中」不能当成「没有调用方」的证据）。
 *
 * 判的是【至少一个文件命中】而不是命中总数：某个文件恰好改版把那一格挪走了
 * 是常事，只要渲染侧还认得这个尾串，探针就仍然有牙齿。
 */
export function probeTrustCheck(
  tail: string,
  results: readonly ProbeResult[],
): string {
  if (tail === "" || tail === "/api" || tail === "/api/v1") {
    return (
      "控制组的查询串是空串或纯前缀（读到 " +
      tail +
      "），任何文件都会命中 ⇒ 这条控制恒真，" +
      "探针对【真的没有调用方】同样会给绿"
    );
  }
  if (results.some((r) => r.hits > 0)) return "";
  const scanned = results.map((r) => r.file + "=" + r.hits).join(", ");
  return (
    "探针不可信：已知有调用方的尾串 " +
    tail +
    " 在扫描面上 0 命中（" +
    scanned +
    "）。⇒ 同一套扫描面量出的「零命中」不是「没有调用方」的证据，" +
    "先修扫描面（渲染侧在 packages/web/public/*.js，且路径前缀在运行时才拼上）"
  );
}
