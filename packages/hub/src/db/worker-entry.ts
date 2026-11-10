/**
 * 「由调用方自己的 URL 推出 worker 入口」这一件事的【唯一】实现（0036 §2）。
 *
 * ── 为什么这是一单独文件而不是各写一遍 ──────────────────────────────
 * `integrity.ts` 早在 Task 6.2 就用过这个表达式，而它旁边写着
 * 「**全仓只允许这一处**由自己的扩展名推导 worker 入口」。本篇（0036）要加第二个
 * worker 入口（备份），于是撞上那条。三个候选里：
 *  · 再抄一份同样的表达式 = 直接违反那条不变量，而它当初要防的正是「两边各改各的」；
 *  · 写死入口路径 = 只在一种形态下成立（写 `.ts` 则 `tsc -b` 之后产物里没那个文件，
 *    写 `.js` 则源码态 ENOENT）；
 *  · **抽成一处** ⇒ 那句「全仓只有一处」第一次真的有东西守着（见 §下面那条 ⚠）。
 *
 * ⚠ **原来那条断言守不住「全仓」**：`integrity.test.ts` ⑦ 数的是
 * `readFileSync("src/db/integrity.ts")` 里的命中数 —— 一条声称管全仓的不变量，
 * 配一条只看一个文件的断言。第二处出现在任何别的文件里它都看不见。
 * 现在这条断言改成扫 src 下全部 ts 文件：含推导式的文件**恰好一个**，就是这个文件。
 * ⇒ **改别人写下的守卫之前先读它的断言，不要读它的注释。**
 *
 * ── 为什么必须是「由自己的 URL 推」而不是两个候选路径轮着试 ──────────
 * 三条实测（0018 §1 第 4、5 条，本节照抄结论、不复用代码）：
 *  - `new URL("./x.worker.js", import.meta.url)` 在源码态【加载失败】：
 *    worker 是【入口】，入口解析没有 parentURL，仓库那条 `.js → .ts` 解析钩子接不上。
 *  - `.ts` 那个名字在源码态可用（type-stripping 直接吃 .ts 入口），但编译产物里没有。
 *  - 所以一个表达式同时覆盖两态：`integrity.ts → integrity.worker.ts` /
 *    `integrity.js → integrity.worker.js`。
 *    **不写两个候选再 catch** —— 那个 catch 会把「入口真的丢了」也一起咽下去，
 *    而 worker 起不来在两个调用方那边都是【有兜底分支】的
 *    （integrity 报 worker_unavailable，本篇报 worker_unavailable），
 *    于是这个洞不会让任何东西变红（0018 记过一次：写成 `.worker$1` 漏一个点，
 *    全部「走 worker」的用例其实都走的是失败分支而照样绿）。
 */

/** 只认这四种扩展名。别的（`.json` / `.node` / 无扩展名）当场抛，不去猜。 */
const CALLER_EXT: RegExp = /\.(ts|js|mts|mjs)$/u;

/**
 * 由**调用方自己的** `import.meta.url` 推出它的 worker 入口 URL。
 *
 * @param callerUrl 调用方的 `import.meta.url`。传别人的 URL 会得到别人的入口 ——
 *   这里不校验「是不是你自己的」（拿不到调用方的 URL），所以参数名把它说清楚。
 * @throws 不是 `file://`、或扩展名不在四种之内时抛。这两种都是「调用方写错了」，
 *   而不是「环境不支持」—— 后者由调用方那个 `worker_unavailable` 分支负责。
 *   这里悄悄返回一个猜出来的 URL，等于让调用方去加载一个不存在的入口，
 *   而那正是上面那条「兜底分支把洞咽下去」的形状。
 */
export function selfWorkerUrl(callerUrl: string): URL {
  if (!callerUrl.startsWith("file://")) {
    throw new TypeError(
      "selfWorkerUrl 要的是 import.meta.url（一个 file:// URL），实得 " + callerUrl,
    );
  }
  if (!CALLER_EXT.test(callerUrl)) {
    throw new TypeError(
      "selfWorkerUrl 认不出这个扩展名，无法推出 .worker<同扩展名>：" + callerUrl,
    );
  }
  return new URL(callerUrl.replace(CALLER_EXT, ".worker.$1"));
}
