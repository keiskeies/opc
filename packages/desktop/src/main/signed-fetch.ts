/**
 * 桌面主进程侧的【签名 + 发请求】（计划 Task 2.2 的最后一格）。
 *
 * ── 这个文件补的是什么 ─────────────────────────────────────────────
 * `main/channels.ts` 的 `dispatch()` 早就写好了，它要的 `MainDeps.signedFetch`
 * 也声明好了 —— 而**全仓没有任何一处实现它**。存在的只有
 * `test/desktop/ipc-surface.test.ts` 里那个返回固定 JSON 的桩。
 * 也就是说：通道表、参数闸门、错误三态、端点映射都测过并且绿，
 * 而**把它们接到 Hub 上的那一格是空的**。桌面壳今天起不来不是缺 `BrowserWindow`
 * 那两行胶水，是缺这一格 —— 胶水接上一个没有实现的 fetch，得到的是一个
 * 打开后每一页都转圈的空窗口。
 *
 * ── 为什么签名在这里【手抄】一份 ───────────────────────────────────
 * 规范串住在 `packages/hub/src/http/auth.ts` 的 `canonicalString`。
 * desktop 不许 import hub（§5.6.1 的编译期边界，test/arch/dependency-boundary.test.ts
 * 拿 biome 真跑过），所以只能抄。抄本身是被边界逼出来的，**抄错只表现为 401**：
 * auth.ts 的验签刻意不区分「签名不对 / 时间窗过期 / nonce 重放」（防探测），
 * 于是「少拼一个 \n」「段序写反」「忘了 method 大写」「先把 query 摘掉再签」
 * 这四种错法在界面上与「你的 token 配错了」**完全同形**。
 * 排查的人会去查部署凭据，而真凶在本文件的 join 那一行。
 *
 * 所以本文件**不靠注释自觉**（「与 auth.ts 逐字一致」这句注释是本仓记过至少三次的
 * 恒绿装饰形状 —— 注释不参与编译，也不会随漂移变红）。
 * 它的分母在 `test/desktop/signed-fetch.test.ts`：同一组输入喂两边，
 * 用 **hub 自己的 `signRequest`** 而不是本文件重写一份来算期望值，
 * 再逐个承重位单独扰动。那条测试是这个文件存在的全部理由。
 *
 * ── 为什么 token 是构造参数而不是读 env ────────────────────────────
 * `serve` 把 token 打在标准输出上**恰好一次**（0038 那条），由启动器交给壳。
 * 读 env 会造出第二种配置来源：同一个 Hub 连着两个各读各的 token 的壳时，
 * 症状是其中一个是 401 而两个界面都"连上了"。做成必填参数 = 忘了传就编译不过。
 *
 * ── 为什么 fetchImpl 是【必填】而我不给 globalThis.fetch ────────────
 * 三个理由叠在一起，任一条单独都不够：
 *  ① 本机离线的 @types/node 把 undici 的 `Response` 解析成一个【零成员】类型
 *     （`lib` 只有 ES2023、没有 DOM），于是 `res.status` 报 TS2339 而**不是**
 *     报「你缺依赖」—— 一个环境缺件的错会以「你的代码写错了」的形状出现。
 *     加 `as` 能压掉，但那是**用类型断言压掉一个我并不知道真的兼容的兼容假设**；
 *     而这条兼容假设恰好是本文件唯一会「编译过而线上 401/TypeError」的位置。
 *  ② 真实用法并不需要 global fetch：`web/src/dev-server.ts` 用的是 `node:http`
 *     的 `request`，理由写在那文件里（SSE 必须按流透传）。主进程同一条约束成立，
 *     所以装配点会传一个 `node:http` 的适配器 —— 它【精确满足】下面那个最小类型。
 *     一个没有调用方的默认值 = 「没传就是 null」而不是「忘了传」。
 *  ③ 这一格的全部风险都在【发出的字节】上。默认值让调用点看起来什么都没做，
 *     而线上炸的是它兜住的那条路径（离线机器上 `globalThis.fetch` 甚至可能是
 *     undefined ⇒ 第一次 invoke 就 unreachable，症状与「Hub 没起来」同形）。
 * 要接真 Hub 的人写 8 行 node:http 适配器，那 8 行归 Electron 装配层（0052 §7 第 1 条）。
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import type { MainDeps, MainFetchResult } from "./channels.js";

/**
 * 一次请求用得到的那一小部分 Response。
 *
 * ⚠ 刻意**不写** `typeof globalThis.fetch`，也刻意只留两个成员：
 *  · 留两个成员是因为 `dispatch()` 只读这两个（channels.ts：status 判三态、
 *    bodyText 进 parseMaybeJson）。多声明的用不到的成员，等于给实现者一个
 *    「顺便也依赖上它」的口子，而线上炸在那儿。
 *  · 不写 typeof fetch 的理由见文件头 ①：本机那个类型是空壳，而「兼容」这件事
 *    必须由**装配点那一次赋值**去证，不能由这里的断言自称。
 */
export interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

/**
 * `init.body` 是**可选键**而不是 `string | undefined`
 * （`exactOptionalPropertyTypes: true`：后者不接受"这个键不存在"）。
 * 这个区分在下面是有内容的：GET 不带 body 键，而 POST 恒带（哪怕是 `"{}"`）。
 */
export interface FetchInitLike {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface FetchLike {
  (url: string, init: FetchInitLike): Promise<FetchResponseLike>;
}

/** 与 auth.ts 的 HEADER_* 三个常量逐字一致（抄，理由见文件头）。 */
export const HEADER_SIGNATURE = "x-opc-signature";
export const HEADER_TIMESTAMP = "x-opc-timestamp";
export const HEADER_NONCE = "x-opc-nonce";

/**
 * 规范串：`方法\n目标\nbody摘要\n时间戳\nnonce`。
 *
 * 四个承重位（每一个在 test/desktop/signed-fetch.test.ts 里都单独有一发扰动）：
 *  · **段序** —— 方法、target、body 摘要、时间戳、nonce
 *  · **分隔符 `\n`** —— 不是空格：body 摘要与方法名里都不可能出现换行，拼接无歧义
 *  · **method 大写** —— 服务端按 `o.method.toUpperCase()` 重算，这里不转就是不等
 *  · **target 含原样 query** —— 不排序、不解码、不剥 query。两侧各有一套规范化规则
 *    必然漂移，而漂移的症状是【所有带 query 的请求 401】（收件箱那一页正好带 query）
 */
export function canonicalString(o: {
  readonly method: string;
  readonly target: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
}): string {
  const digest = createHash("sha256").update(o.body, "utf8").digest("hex");
  return [o.method.toUpperCase(), o.target, digest, String(o.timestamp), o.nonce].join("\n");
}

export interface SignedFetchOptions {
  /** 本机部署 token。必填，见文件头那条。 */
  readonly token: string;
  /** Hub 的 `host:port`，如 `127.0.0.1:8765`。不带 scheme —— 由本函数拼，避免两处各拼一份。 */
  readonly hubAddress: string;
  /** 发请求的那一手。必填，理由在文件头那三条。 */
  readonly fetchImpl: FetchLike;
  readonly now?: () => number;
  readonly nonce?: () => string;
}

/**
 * 空 token 的判据与那句报错【只写一处】。
 *
 * 我第一版在 `makeSignedFetch` 与 `signedHeaders` 各写了一份，
 * 连那句话都是逐字节相同的两份 —— 那正是本仓为 `kindOf()` 立过的那条规矩
 * （0026 §0：同一判据两份字面写法，漂了不会有人发现）要拦的形状，
 * 而我是在【自己刚写的文件里】第二次撞上它。
 *
 * 两处【调用】是保留的，因为时机不同而两个时机都要：
 *  · `makeSignedFetch` 在【构造时】查 ⇒ 忘了传 token 的壳起不来，而不是一用就 401；
 *  · `signedHeaders` 在【每次签】时查 ⇒ 事件流那条路不经过 makeSignedFetch，
 *    只留构造时那一发的话，那条路会把空 token 一路带到线上。
 * 留一处判据、两处时机，才既拦得住又不留两份会漂的文本。
 */
export function assertUsableToken(token: string): void {
  if (token.trim() === "") {
    // 空 token 不在这里悄悄签出一种必然 401 的头：那会把「没配 token」
    // 伪装成「token 不对」。前者是配置缺失（该去查启动器有没有传），
    // 后者会让人去换凭据 —— 而 auth.ts 的 401 刻意不区分这两者。
    throw new Error("token 不能是空串：桌面壳拿它当 HMAC 密钥，空串签出的每个请求都会 401。");
  }
}

/**
 * 三个签名头。`makeSignedFetch` 内部走的也是这一份 ——
 * 存在它的**唯一理由**是事件流那条路：`GET /events?cursor=N` 是一条
 * 【长期挂着的流】，而 `MainDeps.signedFetch` 的形状是 `{status, bodyText}`
 * （整段缓冲），它装不下一条活着的流（dev-server 那边同一判断，
 * 那边靠 `r.pipe(res)` 解决）。所以 event-stream.ts 只要头、不要 body，
 * 而自己拿 node:http 开流。
 *
 * 这一格如果各自抄一份，漂了的症状是【只有断线续订 401】——
 * auth.ts 与 dev-server.ts 各记过一次同一个死法，而那里的原话是
 * 「断线续订整条是死的，而普通 JSON 请求全好」。
 */
export function signedHeaders(o: {
  readonly token: string;
  readonly method: string;
  readonly target: string;
  readonly body: string;
  readonly now?: () => number;
  readonly nonce?: () => string;
}): Record<string, string> {
  assertUsableToken(o.token);
  const timestamp = (o.now ?? Date.now)();
  const nonce = (o.nonce ?? randomUUID)();
  const signature = createHmac("sha256", o.token)
    .update(
      canonicalString({
        method: o.method,
        target: o.target,
        body: o.body,
        timestamp,
        nonce,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    [HEADER_SIGNATURE]: signature,
    [HEADER_TIMESTAMP]: String(timestamp),
    [HEADER_NONCE]: nonce,
  };
}

/**
 * 造出 `MainDeps` —— 也就是 `main/channels.ts` 的 `dispatch()` 缺的那一格。
 *
 * 返回的是【一个对象】而不是一个可调用的东西：`MainDeps` 的形状是
 * `{ signedFetch }`，把函数本身也做成可调用会造出「同一个东西有两个身份」，
 * 于是 `dispatch(deps, …)` 与 `deps.signedFetch(…)` 两条写法都成立而只有一条是契约。
 *
 * ⚠ 签的是【发出去的那一整串】，不是 path。`toHttpRequest` 会拼出
 * `/approvals?status=pending&limit=5`，而服务端按**原始请求目标**验签
 * （auth.ts 的 canonicalString，那是真 socket 上撞出来的教训）。
 * 所以这里**不能再对 target 做任何加工** —— 传进来什么就签什么、发什么。
 * 有人在这里"顺手 normalize 一下 URL"，症状是收件箱那一页整页 401，
 * 而看板那一页（无 query）照旧正常 —— 一半能用比全都不能用更难定位。
 */
export function makeSignedFetch(o: SignedFetchOptions): MainDeps {
  // 构造时就查（时机理由见 assertUsableToken 的文件内说明）
  assertUsableToken(o.token);
  const base = "http://" + o.hubAddress;

  const signedFetch = async (path: string, init: { method: string; body?: string }): Promise<MainFetchResult> => {
    // 签名这件事【只在这里发生一次】，且走的是 signedHeaders ——
    // 不为整齐：事件流那一路也要签同一个串，两处各写一遍 HMAC 就是两份抄件，
    // 而它漂了的形状是「事件流 401 而看板正常」（signedHeaders 的注释里那条）。
    const headers = signedHeaders({
      token: o.token,
      method: init.method,
      target: path,
      body: init.body ?? "",
      // 两个都是【条件展开】而不是直接传：`o.now` 的类型是 `(() => number) | undefined`，
      // 而下面是可选属性 —— exactOptionalPropertyTypes 下「不传」与「传 undefined」
      // 是两件事，后者编译不过。（同一族错在 0051 §4 那条 onCost 上犯过一次，
      // 这次是在我自己刚写的那一段里犯的。）
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.nonce === undefined ? {} : { nonce: o.nonce }),
    });
    const res = await o.fetchImpl(base + path, {
      // 线上发【大写】而规范串里也大写，两者取自同一个入参：
      // channels.ts 今天给的已经是 GET/POST，所以这行看着像多余的 ——
      // 它挡的不是今天，是「有人从渲染进程那边传进来一个小写 method」的那一刻：
      // canonicalString 自己会 toUpperCase，所以签名会按 GET 算而线上发 get，
      // 于是【签名对而 HTTP 语义错】，症状由服务端决定，不由这里决定。
      method: init.method.toUpperCase(),
      headers: { "content-type": "application/json", ...headers },
      // 【键存在与否跟着 init 走】，不是「永远带上 body 键、GET 时它是 undefined」。
      // 两条理由：① exactOptionalPropertyTypes 下后者编译不过（这是机械拦的那一半）；
      // ② 真适配器面对 `body: undefined` 会去做 `Buffer.from(undefined)`，
      //   或者给 GET 发一个 `content-length: 0` 而服务端签的是另一个摘要 ——
      //   那正是 ① 那条编译期错误存在的原因，不只是洁癖。
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    return { status: res.status, bodyText: await res.text() };
  };
  return { signedFetch };
}
