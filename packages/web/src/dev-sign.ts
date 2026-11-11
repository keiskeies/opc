/**
 * 开发服务器的请求签名 —— 从 dev-server.ts 里【单独拆出来】的这个文件只有一个读者：
 * `test/web/dev-server-sign.test.ts`。
 *
 * ── 为什么要拆，而不是留在 dev-server.ts 里 export 一个函数 ──────────────
 * dev-server.ts 的最后一行是 `server.listen(...)`。把它 import 进测试进程就等于
 * 测试去抢一个端口：两个用例并行时 EADDRINUSE，CI 与本机行为不一致，
 * 而症状是【另一发测试红】。本仓对付「import 就有副作用」只有两条路：
 *   ① hub 那一族用的 isDirectRun（internal/direct-run.ts），
 *   ② 把要验的东西放进一个【本来就没副作用】的模块。
 * 这里选 ② 而不是 ①，理由不是省事：isDirectRun 住在 packages/hub/src 里，
 * 而 packages/web 不许 import hub（§5.6.1，test/web/hub-projection.test.ts 那条
 * 源码扫描就是它）。为了 import 一个谓词去破边界，或者在 web 里【再抄一份】
 * 那个谓词 —— 后者正是 direct-run.ts 文件头写着「三份副本只会让同一个错误出现三次」
 * 要拦的事。拆文件是那条约束下唯一不动边界的解。
 *
 * ── 这个函数为什么【必须】有测试 ────────────────────────────────────
 * 下面这份规范串是 hub/src/http/auth.ts 的 canonicalString 的【手抄】。
 * 手抄本身是被允许的（边界决定了不能 import），手抄 + 【静默失效】不行：
 * 抄错的后果不是崩，是【每个请求 401】，而 auth.ts 的验签刻意回一句
 * 不区分「签名不对 / 时间窗过期 / nonce 重放」的 unauthorized（防的是探测），
 * 于是「少拼一个 \n」与「token 配错了」在界面上长得一模一样。
 * 那种错法的排查路径是【去怀疑部署凭据】，而真凶在另一文件第 20 行。
 * 所以这一处不靠注释自觉，靠 test/web/dev-server-sign.test.ts 拿【同一组输入】
 * 喂两边逐字节对账 —— 那条测试是这个文件存在的全部理由。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * @param o.now 【毫秒数字】。刻意不接 Date 也不接 `() => number`：
 *   canonicalString 拼的是 `String(timestamp)`，喂进去一个函数会得到
 *   `"function () { return T0 }"` 这种规范串 —— 签名照样【算得出来】、
 *   照样 401。我自己撞过一次（today.test.ts 三连红，报错只写着 unauthorized）。
 * @param o.token 缺省读 ORG_TOKEN（dev-server 的真实用法）。做成入参是为了
 *   测试能塞一个已知 token 进去，让两边的 HMAC 有【可比】的输入。
 */
export function devSign(
  method: string,
  target: string,
  body: string,
  o: { readonly now?: number; readonly nonce?: string; readonly token?: string } = {},
): Record<string, string> {
  const now = o.now ?? Date.now();
  const nonce = o.nonce ?? randomUUID();
  const token = o.token ?? process.env["ORG_TOKEN"] ?? "";
  const digest = createHash("sha256").update(body, "utf8").digest("hex");
  // 四个承重位，逐字对照 auth.ts 的 canonicalString：
  //  【段序】方法, target, body 摘要, 时间戳, nonce
  //  【分隔符】\n（不是空格：body 摘要与方法名里都不可能出现 \n，拼接不会歧义）
  //  【method 大写】
  //  【target 含原样 query】不做排序、不解码、不剥 query —— 两侧各有一套规范化规则必然漂移
  const canon = [method.toUpperCase(), target, digest, String(now), nonce].join("\n");
  return {
    "content-type": "application/json",
    "x-opc-signature": createHmac("sha256", token).update(canon, "utf8").digest("hex"),
    "x-opc-timestamp": String(now),
    "x-opc-nonce": nonce,
  };
}
