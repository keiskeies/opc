/**
 * 本地鉴权（计划 Task 2.1，规格 §20.3 的签名思路 + 计划自定的本机 token 约定）。
 *
 * 一句话立场：token 是【HMAC 的密钥】，不是【请求头里的口令】—— 它从不上线。
 *
 * 为什么这样分，而不是「token 放 Authorization 头，比对相等就放行」：
 * 放头里的话，任何一处把请求记全了的地方（本地代理抓包、调试日志、将来接的
 * 观测层）都把口令抄了一遍，而这份口令是【长期有效】的（一次启动内所有请求共用）。
 * 改成签名后线上跑的是 HMAC 结果，抄到它的人拿不到密钥，也就换不来下一次调用。
 * 代价是每次请求多算一次 HMAC —— 本机回环上可以忽略。
 *
 * 与 §20.3 的关系要说准（详见 api.ts 文件头那条更正）：§20.3 讲的是【IM 层】的
 * 签名 + 一次性 token（飞书卡片回调那条路，凭据落 im_tokens 表）。
 * 本机桌面 token 是【计划新增的约定】，不是 §20.3 的引用。所以：
 *  - 本模块【不落库】。im_tokens 是 IM 侧的一次性审批凭据，语义是「一次消费」；
 *    把桌面 token 塞进那张表会同时毁掉两边的语义（它要么变得一次性到不能用，
 *    要么让那张表出现长期行，而它的 schema 假定行会很快被消费掉）。
 *  - 也【不落 secrets 表】。secrets 的注释写着「加密 at rest」，加密就要有密钥，
 *    密钥又得放哪 —— 这个 token 的全部作用就是【不落盘】：它只在 Hub 进程的内存里，
 *    进程重启就换一个。落盘的代价是重启不换，那正是它想避免的。
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/** 签名允许的时间偏移。太短会让本机时钟抖一下就全 401；太长等于放宽重放窗口。 */
export const MAX_CLOCK_SKEW_MS = 60_000;

/** 重放防护的 nonce 记忆窗口（见 NonceGuard：这一维是【有界】的，不是完备的）。 */
export const NONCE_WINDOW_MS = 2 * MAX_CLOCK_SKEW_MS;

export const HEADER_SIGNATURE = "x-opc-signature";
export const HEADER_TIMESTAMP = "x-opc-timestamp";
export const HEADER_NONCE = "x-opc-nonce";

/** 生成一次启动期的本地密钥。32 字节 = HMAC-SHA256 的原生键长，不做截断。 */
export function newLocalToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 待签名的规范串。
 *
 * 【target 而不是 path】—— 这一条是被真 socket 上的测试逼出来的，不是措辞偏好：
 * 服务端做路由要的是【解码后、剥掉 query】的路径，而客户端签名时手上只有
 * 它准备发出去的那一整个请求目标（"/events?cursor=17"）。
 * 若规范串里放服务端剥过 query 的那一份，两侧算出来的串【永远不同】，
 * 于是【任何带 query 的请求都无法通过鉴权】—— 症状不是报错，是 GET /events?cursor=…
 * 恒 401，也就是【断线重连这条路整个是死的】，而它看起来像「凭据不对」。
 * （contract 层的单测看不见这件事：那边手写的 path 与签名的 path 是同一个人写的同一个值。
 * 只有真发一次带 query 的请求才会撞上 —— 见 test/http/server.test.ts。）
 * 所以签的是【原始 target】：客户端签它实际发出去的那串字节，服务端原样用它算。
 *
 * 顺手拿到的第二条性质：query 进了签名，于是【游标不能被中途改】。
 * 本机回环上其实没有【在路上】这个位置（同机进程要改别人的字节早就有代码执行权了），
 * 所以这条是白得的，不作为引入它的理由 —— 理由只有一个：两侧必须算同一个东西。
 *
 * 每一段【为什么在里面】：
 *  - method + target：不带它们，同一个签名就能在【任意】端点之间复用 —— 只读端点上
 *    取到的签名可以拿去 POST /approvals。这是这类实现最常漏的一洞。
 *  - body 的 sha256 而不是 body 原文：规范串要拼成长度可控的一行，
 *    而 body 可以是 4000 字符的想法。
 *  - ts + nonce：重放防护的输入。
 * 段间用 \n 而不是空格：body 摘要与方法名里都不可能出现 \n，拼接不会歧义。
 * 【不做 JSON 规范化】：body 按【原始字节】摘要，客户端不对 JSON 重新序列化。
 * 一旦引入「先规范化再签」，两侧各有一套键序/空白规则就会静默签名不匹配，
 * 而那类 bug 的报错长得像「凭据不对」。
 * 【同样不做 query 规范化】：?a=1&b=2 与 ?b=2&a=1 是两个不同的签名，
 * 这是刻意的 —— 与 body 那条同一个理由，两侧各有一套排序规则必然漂移。
 */
export function canonicalString(o: {
  readonly method: string;
  /** 原始请求目标：路径 + 原样的 query，未解码、未排序、未剥 query。 */
  readonly target: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
}): string {
  const digest = createHash("sha256").update(o.body, "utf8").digest("hex");
  return [
    o.method.toUpperCase(),
    o.target,
    digest,
    String(o.timestamp),
    o.nonce,
  ].join("\n");
}

export function signRequest(o: {
  readonly token: string;
  readonly method: string;
  readonly target: string;
  readonly body: string;
  readonly timestamp: number;
  readonly nonce: string;
}): string {
  return createHmac("sha256", o.token)
    .update(canonicalString(o), "utf8")
    .digest("hex");
}

export type VerifyFailure =
  | { ok: false; code: "missing_header"; header: string }
  | { ok: false; code: "malformed_timestamp" }
  | { ok: false; code: "stale_timestamp"; skewMs: number }
  | { ok: false; code: "replayed_nonce" }
  | { ok: false; code: "bad_signature" };

export type VerifyInput = {
  readonly token: string;
  readonly method: string;
  /**
   * 原始请求目标（含 query）。【与客户端签名时用的是同一个字段名、同一个值】是
   * 这一层能工作的前提，所以两侧都叫 target、都不许偷偷换成剥过 query 的 path
   * —— 换掉的表现不是编译错误，是「带 query 的请求全 401」。
   */
  readonly target: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly now: number;
  /** 已见过的 nonce 集合；不传 ⇒ 不做重放防护（并在结论里如实反映，见 ok 分支注释）。 */
  readonly nonces?: NonceGuard;
};

/**
 * 校验一次请求。
 *
 * 【顺序】：先结构（头在不在、时间戳格式）→ 再新鲜度 → 再签名。
 * 为什么签名判在最【后】而不是最前：签名要算 HMAC，而结构错误能零成本判掉。
 * 一台被脚本扫的本地端口会以很高的频率撞上没有头的请求，
 * 让每条这样的请求都付一次 HMAC 是把自己变成 DoS 的靶子。
 * 新鲜度排在签名之前是同一个理由的延长版，而且它不依赖密钥 —— 一个过期请求
 * 无论签名对不对都该拒，先拒掉可以省下 HMAC。
 */
export function verifyRequest(i: VerifyInput): { ok: true } | VerifyFailure {
  const sig = header(i, HEADER_SIGNATURE);
  if (sig === null) return { ok: false, code: "missing_header", header: HEADER_SIGNATURE };
  const tsRaw = header(i, HEADER_TIMESTAMP);
  if (tsRaw === null) return { ok: false, code: "missing_header", header: HEADER_TIMESTAMP };
  const nonceRaw = header(i, HEADER_NONCE);
  if (nonceRaw === null) return { ok: false, code: "missing_header", header: HEADER_NONCE };

  const ts = Number(tsRaw);
  if (!Number.isSafeInteger(ts)) return { ok: false, code: "malformed_timestamp" };
  const skew = Math.abs(i.now - ts);
  if (skew > MAX_CLOCK_SKEW_MS) {
    return { ok: false, code: "stale_timestamp", skewMs: skew };
  }
  if (i.nonces?.check(nonceRaw, i.now) === "replay") {
    return { ok: false, code: "replayed_nonce" };
  }

  const want = signRequest({
    token: i.token,
    method: i.method,
    target: i.target,
    body: i.body,
    timestamp: ts,
    nonce: nonceRaw,
  });
  if (!equalHex(want, sig.trim())) return { ok: false, code: "bad_signature" };
  // nonce 只在【整体通过】之后才记账。反过来先记账会怎样：一次签名错误的请求
  // 就把那个 nonce 烧掉了，随后真正合法的那一次反而被判成重放。
  // 也就是说拒绝一次失败尝试的副作用是让成功的那次失败 —— 攻击者不需要破签名，
  // 只需要抢在合法请求之前用同一个 nonce 打一枪。
  i.nonces?.commit(nonceRaw, i.now);
  return { ok: true };
}

function header(
  i: VerifyInput,
  name: string,
): string | null {
  // HTTP 头名大小写不敏感（HTTP/1.1 规范原文），而 Node 的 http 模块会给小写、
  // Hono 的 c.req.header() 自己做了大小写归一。这里不能假设调用方已归一：
  // 只按小写取，一旦某个客户端（或测试夹具）写了 X-OPC-Signature，
  // 结论就是 missing_header ⇒ 401，而症状是「某些客户端永远登不上」。
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(i.headers)) {
    if (k.toLowerCase() !== lower) continue;
    if (v === undefined || v.trim() === "") return null;
    return v;
  }
  return null;
}

/**
 * 定长比较。两个坑都避开了：
 *  - timingSafeEqual 在【长度不等】时直接抛错，所以先比长度；
 *  - 长度不等时短路返回 false 会泄漏长度信息，但签名是定长十六进制，
 *    长度不等的唯一含义是「不是本算法产出的」，长度本身就是公开信息。
 */
function equalHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
  } catch {
    return false;
  }
}

/**
 * nonce 记忆。
 *
 * 诚实说明它的边界，不把它写成「防重放」的完整方案：这是一个【有界窗口】的
 * 重放防护 —— 只记得最近 NONCE_WINDOW_MS 内的 nonce。窗口外重放拦不住。
 * 为什么够用：时间戳那一维已经把可重放的区间限在 ±MAX_CLOCK_SKEW_MS 内，
 * nonce 窗口取它的两倍，覆盖「时间戳在窗口边缘 + 网络排队」的组合。
 * 真要完备就得让服务端给每个会话发序号并单调递增，那是会话管理，
 * 本机回环上单用户不值得。这段写在这里，是为了下一个想「顺手把 nonce 去掉」
 * 的人能看见它挡的是哪一段（去掉后重放窗口就是整整 60 秒，
 * 而 60 秒足够把一次「批准付款」再放一遍）。
 */
export class NonceGuard {
  readonly #seen = new Map<string, number>();

  /** 查而不记。 */
  check(nonce: string, now: number): "fresh" | "replay" {
    const at = this.#seen.get(nonce);
    if (at === undefined) return "fresh";
    // 记着但已出窗 ⇒ 当作新鲜的，顺带更新时间戳（下面 commit 会写）
    return now - at <= NONCE_WINDOW_MS ? "replay" : "fresh";
  }

  commit(nonce: string, now: number): void {
    this.#seen.set(nonce, now);
    this.#evict(now);
  }

  /**
   * 淘汰。每次 commit 后扫一遍 —— 量级是窗口内的请求数（本机最多几十条），
   * 不做定时器也不做惰性分批：那是为了一个不会成为瓶颈的地方引入一个
   * 需要测试与清理的后台任务。真到需要的那天，这里换 LRU 就够。
   */
  #evict(now: number): void {
    for (const [k, at] of this.#seen) {
      if (now - at > NONCE_WINDOW_MS) this.#seen.delete(k);
    }
  }

  get size(): number {
    return this.#seen.size;
  }
}

/** 一次请求的签名材料生成器（客户端侧用；放这里以便与服务端共用规范串实现）。 */
export function signedHeaders(token: string, o: {
  readonly method: string;
  /** 要发出去的【那一整个请求目标】，含 query，原样。见 canonicalString 的文件头。 */
  readonly target: string;
  readonly body: string;
  readonly now: number;
}): Record<string, string> {
  const nonce = randomUUID();
  // 字段名在两侧不同是刻意的：调用方给的是「现在几点」（now，一个时刻），
  // 而规范串里那一项是「被签名的那个时间戳」（timestamp）。
  // 直接把 now 一路传下去会让【签名的】与【写进头里的】变成两次不同的取值 ——
  // 若哪天有人在中间读一次时钟，头里是 t1、签名里是 t2，服务端算出来永远对不上，
  // 症状是「某些请求随机 401」。这里做一次显式映射，两侧共用同一个值。
  return {
    [HEADER_SIGNATURE]: signRequest({
      token,
      method: o.method,
      target: o.target,
      body: o.body,
      timestamp: o.now,
      nonce,
    }),
    [HEADER_TIMESTAMP]: String(o.now),
    [HEADER_NONCE]: nonce,
  };
}
