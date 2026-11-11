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
 *
 * ── 但入口解析对了【还不够】：入口自己的兄弟 import 在 worker 线程里解析不了 ──
 * 上面那段解决的是「主线程找得到入口文件」，它没有解决
 * 「入口文件里那一行 `import { x } from "./page-check.js"`」。实测（0037 §1）：
 * **两种跑源码态的加载器都不在 worker 线程里做 `.js → .ts` 映射** ——
 *  - `node --experimental-transform-types`：它只剥类型，【不改写说明符】；
 *  - `tsx`：它把 loader 放进了 execArgv（所以 worker 线程【确实】带着它，
 *    这一点我原先判断错了），但它的 loader 在 worker 线程里【不做】这个映射。
 * 主线程那两侧则是通的（tsx 通；纯 type-stripping 不通，靠仓库那条 register 钩子）。
 * ⇒ 结果就是「入口加载起来了，然后死在第一行兄弟 import」，
 *   而两侧都有兜底分支把它报成一条普通失败 —— 于是**它不红**（同一个形状第三次）。
 *
 * ⚠ 修法为什么只能是「**入口外面再包一层**」，而不是几个更自然的写法：
 *  - 入口里 `import "./worker-loader.js"` 再 register ⇒ **那个 import 本身就是解析不了
 *    的那个东西**（先有鸡还是先有蛋，实测）。
 *  - 入口内联 `register(new URL("./worker-loader.js", import.meta.url))` 然后【静态】import 兄弟
 *    ⇒ 静态 import 在**任何顶层语句跑起来之前**就已解析，register 来不及（实测）。
 *  - ⚠⚠ **我第一版用的是「父线程把钩子塞进 `new Worker({execArgv})`」，那一版是错的**，
 *    而且是被【本仓既有的用例】抓出来的（`backup.test.ts` ⑦ 红 6 发 + 整文件挂死），
 *    不是被我新写的那 21 发抓出来的。两条独立的错，各自都够致命：
 *      1. **显式传 execArgv 会触发一道【不传就没有的】校验**。实测（`--test` 之下，
 *         同一个真入口 `backup.worker.ts`）：
 *           · `execArgv: [...process.execArgv]`（28 条）⇒ `new Worker` 当场抛
 *             `ERR_WORKER_INVALID_EXEC_ARGV: --stack-trace-limit=10, --tls-cipher-list=…`
 *           · `execArgv: []` ⇒ 起得来
 *           · **根本不传** ⇒ 起得来，而线程里 `process.execArgv` **照样是 28 条**，
 *             含 `--stack-trace-limit=10` 那条【同一个值】
 *         ⇒ 所以坏的不是「那份旗里有线程不认识的旗」（它们待在继承里无害），
 *         坏的是【显式传】这件事本身触发校验。我为了递一条钩子，
 *         把一条本来不会跑的校验跑了 —— 而抛出来的错被两侧的 `worker_unavailable`
 *         兜底分支咽掉，红的只是【备份没跑成】这个结论（同一个形状第四次）。
 *      2. 就算把旗一条条校验过再递，`--import <钩子>` 这条**内容**在两种跑源码态的
 *         加载器下也未必是那条能改道的钩子（tsx 挂的是它自己的 loader）。
 *    ⇒ 教训不是「execArgv 要过滤」，是**这一层不该碰 execArgv**：
 *      它是【跑法】的一部分，而本篇要修的正是【跑法之间不一致】。
 *      拿一个跑法相关的通道去修跑法相关的洞，等于把洞换个形状留着。
 *  - 所以钩子装在**入口外面那一层 `data:` 包装**里：`new Worker(包装)`，
 *    包装先 `register(钩子)` 再 `await import(真入口)`。execArgv 一个字不碰 ⇒
 *    Node 的继承与过滤原样保留；一处定义、两个入口一字不改、传递图一起覆盖
 *    （`backup.ts → ./pragmas.js` 也走同一个钩子）。载体用 `data:` URL 而不是仓库里的
 *    一个文件，因为文件载体要把自己的扩展名再推一遍（这个文件存在的理由就是
 *    「那种推导只允许一处」），而 `tsc` 在 `allowJs: false` 下不会把 `.mjs` 拷进 dist。
 *    **纯 `.js` 那一态里这个钩子天然空转**（同目录不存在 `.ts`，逐条落给 next）。
 *  ⚠ 代价（如实）：线程里【入口那一个模块】的 `import.meta.url` 变成 data: 而不是
 *    `…/integrity.worker.ts`。两个入口自己不用 `import.meta.url`（实测各 0 处），
 *    而 `backup.ts` 里那一处是它**自己这个模块**的 URL —— 每个模块的 import.meta
 *    是自己的，包装改不了别人的 ⇒ 不受影响。这一维有断言（worker-entry.test.ts ①）。
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

/**
 * 装进 worker 线程的那条解析钩子的**源码**。
 *
 * 写成源码而不是一个 `.mjs` 文件，有两笔账（都实测过，见本文件头）：
 *  - 文件载体得先被**加载起来**才能当钩子，而「由自己推 .ts / .js」这件事正是本文件
 *    声称【全仓只允许一处】的那种推导 —— 给钩子文件单独推一次扩展名，就是第二处；
 *  - `tsc` 在 `allowJs: false`（本仓 tsconfig.base.json 未开）下**不会把 .mjs 拷进 dist**，
 *    于是构建产物里会少一个 worker 起来必需的文件 —— 而少它的症状是
 *    「worker 起不来」，两侧都有兜底分支，**不红**。
 * `data:` URL 没有扩展名可推、也没有文件可漏，纯 `.js` 那一态里它天然空转。
 *
 * ⚠ 这一段是**字符串**而不是被 tsc 看过的代码（`test/**` 同理，0007 §5.2 那一格）：
 * 它写错了不会红在类型层，只会红在 worker 起不来的那一刻。
 * 所以它配了一条**真起线程**的用例（`worker-entry.test.ts` ② 与 ③），
 * 而不是一条「源码里含某个字面」的文本断言 —— 后者对本篇的失效形状完全无感。
 *
 * 三条写死的取舍：
 *  1. **只在三个条件同时成立时改道**：说明符是相对的、以 `.js` 结尾、parent 是 file:。
 *     少任何一个都不动它，原样交回 `next`。所以构建产物（同目录只有 `.js`）里
 *     `existsSync` 不成立 ⇒ 一条都不改道 ⇒ **钩子在那一态是透明的**。
 *  2. **不用正则**：这段源码住在模板字符串里，正则的反斜杠会先被模板字符串吃掉一层
 *     （`\.` 变成 `.`），而那是一发「读起来对、跑起来错」的写法。
 *     `startsWith(".")` 已经覆盖 `./` 与 `../`（Node 只把这两种当相对），够用。
 *  3. **只认 `.js → .ts`**，不做 `.mjs → .mts`。src 下没有一对同名 `.js`/`.ts`
 *     （由 `worker-entry.test.ts` ② 钉住），所以改道不会遮蔽一个真实存在的 `.js`。
 */
const RESOLVE_HOOK_SOURCE = `import { existsSync } from "node:fs";
import { dirname, resolve as presolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, next) {
  const parent = context.parentURL;
  if (
    typeof specifier === "string" &&
    specifier.startsWith(".") &&
    specifier.endsWith(".js") &&
    typeof parent === "string" &&
    parent.startsWith("file:")
  ) {
    const asTs = presolve(dirname(fileURLToPath(parent)), specifier.slice(0, -3) + ".ts");
    if (existsSync(asTs)) {
      return { url: pathToFileURL(asTs).href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return next(specifier, context);
}
`;

/**
 * 钩子本体。`data:` 里的内容必须是合法 JS —— 拼错了没人替你查（见上面那条 ⚠）。
 *
 * ⚠ **导出它是为了「被测的那份钩子就是跑在生产路径上的那一份」**。
 * 测试若自己抄一份钩子来验判据，测的是那份抄件：实现改了、抄件不改，用例照样绿
 * （0036 §2.1 那条「判据的特征照着旧代码写，而旧代码正是被搬走的东西」同一族）。
 * 数据 URL 可以被 `import()`，所以测试能直接把**这个字符串**装起来逐条喂说明符。
 */
export const WORKER_RESOLVE_HOOK_URL: string =
  "data:text/javascript," + encodeURIComponent(RESOLVE_HOOK_SOURCE);

/**
 * 把真入口包一层：先 `register(钩子)`，再 `await import(真入口)`。
 * 这就是交给 `new Worker(...)` 的那【第一个参数】—— 不是 execArgv，见本文件头那两条 ⚠。
 *
 * 三条实现约束，各挡一种实测过的失效：
 *  1. **必须是 URL 对象而不是字符串**。`new Worker("data:text/javascript,…")` 抛
 *     `ERR_WORKER_PATH`（「must be an absolute path or a relative path starting with
 *     './' or '../'」），而字符串形态读起来完全正常 —— 实测踩过。
 *  2. **必须 `await import()` 而不是静态 import**。静态 import 在包装自己的
 *     `register()` 跑起来【之前】就解析完了（本文件头那条），改不成静态。
 *  3. **钩子的 URL 用 `JSON.stringify` 嵌进去**。它是 data: + percent-encoding，
 *     里面有引号与 `%`；手工拼引号是一发「读起来对、跑起来 SyntaxError」的写法。
 *
 * ⚠ 线程里【包装这一个模块】的 `import.meta.url` 是 data:，不是真入口的路径。
 *   真入口自己因此拿不到「我是哪个文件」—— 两个入口今天都不需要（各自 0 处
 *   `import.meta.url`，实测），而它们 import 的模块拿到的是【那个模块自己的】URL
 *   （每个模块的 import.meta 是自己的，包装改不了别人的）⇒ `backup.ts` 那一处不受影响。
 *   这一维由 worker-entry.test.ts ① 钉住：新增 worker 入口若想在【入口文件本身】里
 *   用 `import.meta.url`，得先回头看这一段。
 *
 * @param entryUrl 真入口，通常来自 `selfWorkerUrl(import.meta.url)`。
 */
export function wrappedWorkerUrl(entryUrl: URL): URL {
  /*
   * ⚠ 这里【必须】用模板字符串，不能让 `await import(` 后面直接跟一个引号字面量。
   * `test/arch/production-deps.test.ts` 那条判据【按文本】扫 src 下的 import，
   * 它三条模式里【动态 import 那条没有行首锚点】（另两条有），
   * 所以「import( 紧跟引号」这个形状一旦出现在【源码或注释】里，
   * 引号之间那段就会被当成一个未声明的包名 ——
   * 实测：拼字符串那一版报的包名就是 ` + JSON.stringify(entryUrl.href) + `。
   * 模板字符串里 `import(` 后面跟的是 `$`，那条模式接不上 ⇒ 不红。
   * ⇒ 值得带走的是：**本仓有两条判据都读源码【文本】**（tsc 看不见 data: 里那些字符串，
   *   但文本扫描看得见，而且第 3 条模式连注释都看得见）。
   *   所以【生成代码的字符串】要写成不会被当成源码的形态 ——
   *   连【解释这件事的注释】也一样，我第一版就是红在自己那句注释里。
   */
  const source = `import { register } from "node:module";
register(${JSON.stringify(WORKER_RESOLVE_HOOK_URL)});
await import(${JSON.stringify(entryUrl.href)});
`;
  return new URL("data:text/javascript," + encodeURIComponent(source));
}

