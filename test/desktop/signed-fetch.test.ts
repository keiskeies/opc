/**
 * `packages/desktop/src/main/signed-fetch.ts` 的分母 —— 也是那个文件存在的全部理由。
 *
 * ── 为什么这一发必须存在，而不是「实现写完就算接上了」────────────────
 * 那个文件里的规范串是 hub/src/http/auth.ts 的 `canonicalString` 的【手抄】
 * （desktop 不许 import hub，§5.6.1）。手抄会被边界逼出来，手抄 + 【静默失效】不行：
 * auth.ts 的验签刻意回一句【不区分】「签名不对 / 时间窗过期 / nonce 重放」的 401
 * （防探测），于是「少拼一个 \n」「段序写反」「忘了 method 大写」「先把 query 摘掉再签」
 * 这四种抄法在界面上与「你的 token 配错了」**完全同形**，排查的人会去查部署凭据。
 *
 * 所以本文件不比对两份字符串（那等于造出第三个抄件），而是：
 *  ① **正向对账** —— 同一组输入喂两边，期望值用 **hub 自己的 `signRequest`** 算；
 *     并且不止比签名，直接拿 **hub 自己的 `verifyRequest`** 当裁判，
 *     对 `dispatch()` 一路走到线上的那一份头 + 那一份 body 判一次。
 *     这一发挡的是「抄件与原件不等」这一整族，包括将来有人改 auth.ts 而忘了这里。
 *  ② **正向对照** —— canonicalString 不是空壳（否则 ① 在比两个 HMAC("")）。
 *  ③ **反向扰动** —— 逐个承重位单独改，每一发都必须让验签【失败】，
 *     并且失败码必须是 `bad_signature` 而不是别的（别的说明扰动没落到签名上）。
 *  ④ **形状** —— GET 的 init 里【没有 body 这个键】、POST 有；query 逐字节透传。
 *     这两条是 signed-fetch.ts 里注释最密而编译期只拦住一半的位置。
 *
 * 跑法（离线、node v24.14.0）：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
 *     node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
 *     --test "test/desktop/signed-fetch.test.ts"
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  NonceGuard,
  canonicalString,
  signRequest,
  verifyRequest,
} from "../../packages/hub/src/http/auth.js";
import {
  HEADER_NONCE as DESKTOP_HEADER_NONCE,
  HEADER_SIGNATURE as DESKTOP_HEADER_SIGNATURE,
  HEADER_TIMESTAMP as DESKTOP_HEADER_TIMESTAMP,
  canonicalString as desktopCanonicalString,
  makeSignedFetch,
  type FetchInitLike,
  type FetchLike,
  type FetchResponseLike,
} from "../../packages/desktop/src/main/signed-fetch.js";
import { type MainDeps, dispatch } from "../../packages/desktop/src/main/channels.js";

const TOKEN = "desktop-test-token-0123456789";
const HUB = "127.0.0.1:8765";
const BASE = "http://" + HUB;
const NOW = 1_700_000_000_000;
const NONCE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface Captured {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** 抓住【发出去的那一整串】的 fetch 替身。 */
function capture(): { calls: Captured[]; fetchImpl: FetchLike } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const res: FetchResponseLike = { status: 200, text: async () => '{"ok":true}' };
    return res;
  };
  return { calls, fetchImpl };
}

/** 装一条固定 token / 固定时间戳 / 固定 nonce 的壳（固定 = 让对账可比）。 */
function shell(
  fetchImpl: FetchLike,
  over: { readonly token?: string; readonly nonce?: () => string } = {},
): MainDeps {
  return makeSignedFetch({
    token: over.token ?? TOKEN,
    hubAddress: HUB,
    fetchImpl,
    now: () => NOW,
    nonce: over.nonce ?? (() => NONCE),
  });
}

/** 从抓住的 url 还原【原始请求目标】（含 query，未解码）—— 验签要的就是这一串。 */
function targetOf(c: Captured): string {
  if (!c.url.startsWith(BASE)) throw new Error("请求发到了别处：" + c.url);
  return c.url.slice(BASE.length);
}

/** 拿 hub 自己的裁判判一次抓住的请求。返回失败码或 "ok"。 */
function verdict(c: Captured, nonces?: NonceGuard): string {
  const r = verifyRequest({
    token: TOKEN,
    method: c.method,
    target: targetOf(c),
    body: c.body ?? "",
    headers: c.headers,
    now: NOW,
    ...(nonces === undefined ? {} : { nonces }),
  });
  return r.ok === true ? "ok" : r.code;
}

describe("① 桌面壳发出的请求，hub 自己的验签判通过", () => {
  it("三个头与 hub 的 signRequest 逐字节相等（GET 无 body / GET 带 query / POST 带 body）", async () => {
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl);
    // 走 dispatch 而不是直接调 signedFetch：要验的是【通道路由那一段拼出来的串】
    // 与签名用的是同一串，而不是我自己手搓一个 target 去对账（那样中间那段没人验）。
    await dispatch(deps, "hub:listTasks", undefined);
    await dispatch(deps, "hub:listApprovals", { status: "pending", limit: 5 });
    await dispatch(deps, "hub:createTask", { idea: "做个 AI 笔记应用" });
    expect(calls.map((c) => c.method + " " + targetOf(c))).toEqual([
      "GET /tasks",
      "GET /approvals?status=pending&limit=5",
      "POST /tasks",
    ]);
    for (const c of calls) {
      const want = signRequest({
        token: TOKEN,
        method: c.method,
        target: targetOf(c),
        body: c.body ?? "",
        timestamp: NOW,
        nonce: NONCE,
      });
      expect(c.headers[HEADER_SIGNATURE], c.url).toBe(want);
      // 时间戳与 nonce 也得对上：验签方是先按头取回这两样再重算规范串的，
      // 签名对而头不对 ⇒ 服务端用【另一个时间戳】重算 ⇒ 一样 401。
      expect(c.headers[HEADER_TIMESTAMP], c.url).toBe(String(NOW));
      expect(c.headers[HEADER_NONCE], c.url).toBe(NONCE);
    }
  });

  it("⭐ 直接拿 hub 的 verifyRequest 当裁判 ⇒ 三条全部 ok", async () => {
    // 上面那发比的是签名【相等】，这一发判的是【能被验过】。
    // 差别在有内容：验签方还会判头缺不缺、时间戳格式、新鲜度、大小写归一。
    // 抄错头名（比如 x-opc-nonce 写成 x-opc-nonce:）在「比签名」那一发里是绿的
    // —— 签名本身没错，而线上是 missing_header 401。
    // 一个【共享】的 NonceGuard：三条都该过，顺带证明 nonce 不是常数。
    // 所以这一发【不】用 shell() —— 它把 nonce 钉成固定值（对账那一发需要固定才可比），
    // 而固定 nonce 配共享 guard 必然在第 2 条上 replayed_nonce。
    // 我第一版就是那么写的，红得很干净：那是替身的错，不是实现的错。
    const { calls, fetchImpl } = capture();
    const deps = makeSignedFetch({ token: TOKEN, hubAddress: HUB, fetchImpl, now: () => NOW });
    await dispatch(deps, "hub:listTasks", undefined);
    await dispatch(deps, "hub:listApprovals", { status: "pending", limit: 5 });
    await dispatch(deps, "hub:decideApproval", { approvalId: "c-1", resume: "approve", note: "可以" });
    expect(calls).toHaveLength(3);
    // 【共享】一个 guard 才有内容：三条各自 new 一个的话重放永远测不到。
    const guard = new NonceGuard();
    for (const c of calls) {
      expect(verdict(c, guard), c.method + " " + targetOf(c)).toBe("ok");
    }
  });

  it("头名两侧是【同一组字面量】（抄件漂移最安静的一格）", () => {
    // 上面那发能抓住头名写错，但报错会是 missing_header，读起来像 hub 的问题。
    // 这一发直接把两侧常量并排放，报错直接指出是哪个头漂了。
    expect(DESKTOP_HEADER_SIGNATURE).toBe(HEADER_SIGNATURE);
    expect(DESKTOP_HEADER_TIMESTAMP).toBe(HEADER_TIMESTAMP);
    expect(DESKTOP_HEADER_NONCE).toBe(HEADER_NONCE);
  });
});

describe("② 正向对照：规范串不是空壳", () => {
  it("五段、四个 \\n、段 1 大写、段 2 原样 target（含 query）", () => {
    // 少了这一发，① 的「相等」有可能来自两边【都没把输入用进去】。
    const segs = desktopCanonicalString({
      method: "get",
      target: "/approvals?status=pending&limit=5",
      body: "{}",
      timestamp: NOW,
      nonce: NONCE,
    }).split("\n");
    expect(segs).toHaveLength(5);
    expect(segs[0]).toBe("GET");
    expect(segs[1]).toBe("/approvals?status=pending&limit=5");
    expect(segs[2]).toHaveLength(64); // sha256 hex
    expect(segs[3]).toBe(String(NOW));
    expect(segs[4]).toBe(NONCE);
  });

  it("与 hub 的 canonicalString 逐字节相等（同一组输入，含中文 body）", () => {
    const i = {
      method: "post",
      target: "/tasks",
      body: '{"idea":"做个 AI 笔记应用"}',
      timestamp: NOW,
      nonce: NONCE,
    };
    expect(desktopCanonicalString(i)).toBe(canonicalString(i));
  });
});

describe("③ 反向：逐个承重位单独扰动 ⇒ 验签必须失败在【签名】上", () => {
  /**
   * 每一发只改一个段，其余不动，然后要求失败码恰是 bad_signature。
   * 为什么连失败码都要钉：本仓的验签刻意对【人】不区分（防探测），但对【测试】
   * 必须区分 —— 扰动落到别处（比如把 nonce 改成空串 ⇒ missing_header）
   * 说明那一维根本没被用上，而"红了吗"的回答是"红了"，一句真话都没有。
   */
  // target 故意【带 query】、body 故意【非空】：
  // 我第一版的 base 是 `{ method: "POST", target: "/tasks", body: '{"idea":"x"}' }`，
  // 于是「先把 query 摘掉再签」那一发是【空的】—— `"/tasks".replace("?status=…","")`
  // 返回原串，用例断"改动后的规范串 ≠ 原串"直接假绿。
  // 一发的扰动用例，它的扰动必须先【真的改动点什么】才有内容；
  // 判据是下面那条 `expect(wrong).not.toBe(want)` —— 它同时也在验扰动本身有效。
  const base = {
    method: "POST",
    target: "/approvals?status=pending&limit=5",
    body: '{"idea":"x"}',
  };
  // ⚠ 这里的 want 出自【本仓那份抄件】而不是 hub 那一份。
  // 我第一版写的是 hub 的那一份，于是整节在拿 hub 的规范串和它自己对账 ——
  // **抄件被改坏也一条不红**，而这一节存在的理由恰恰是「抄件可能被改坏」。
  // 下面那句「正确的这一份 = hub 算的那一份」也因为换了 want 才真的有内容。
  const want = desktopCanonicalString({ ...base, timestamp: NOW, nonce: NONCE });

  const sigOf = (canon: string): string =>
    // 规范串 → 签名。绕开 canonicalString 自己，直接喂 HMAC：
    // 否则「规范串变了而签名没变」这一族（比如 HMAC 的 key 用错）会看不见。
    createHmac("sha256", TOKEN).update(canon, "utf8").digest("hex");

  it("五个段各自参与规范串：改任一段 ⇒ 规范串变 ⇒ 签名变", () => {
    const segs = want.split("\n");
    const variants: readonly (readonly [string, string])[] = [
      // 段序写反（把方法挪到 body 摘要后面）
      ["段序写反", [segs[1], segs[2], segs[0], segs[3], segs[4]].join("\n")],
      // 分隔符换成空格
      ["分隔符换成空格", segs.join(" ")],
      // method 保持小写（canonicalString 里少了那个 toUpperCase）
      ["method 保持小写", ["post", segs[1], segs[2], segs[3], segs[4]].join("\n")],
      // 先把 query 摘掉再签（channels.ts 那段注释点名防的就是这个）
      ["剥掉 query", ["POST", "/approvals", segs[2], segs[3], segs[4]].join("\n")],
      // body 摘要换成原文（少了那个 sha256）
      ["body 用原文而非摘要", [segs[0], segs[1], base.body, segs[3], segs[4]].join("\n")],
      // 时间戳与 nonce 两段互换
      ["时间戳与 nonce 互换", [segs[0], segs[1], segs[2], segs[4], segs[3]].join("\n")],
    ];
    for (const [name, wrong] of variants) {
      // 先验【扰动本身有效】（这一条就是我第一版缺的那一位）
      expect(wrong, name + "：这一发没有真的改动规范串，是个空用例").not.toBe(want);
      expect(sigOf(wrong), name).not.toBe(sigOf(want));
    }
    // 而正确的这一份【确实】是 hub 算的那一份（否则上面在比两个都错的东西）
    expect(want).toBe(
      canonicalString({ method: "POST", target: "/approvals?status=pending&limit=5", body: base.body, timestamp: NOW, nonce: NONCE }),
    );
  });

  it("签名用的 target 与实际发出的 target 差一个字符 ⇒ 验签 bad_signature", async () => {
    // 这一发是①的镜像：把「签名对不上」这件事真的做出来一次，
    // 证明 verdict 真的会红 —— 否则上面那三条 ok 可能只是裁判失灵。
    const { fetchImpl } = capture();
    // 在【签名之后】偷偷给 URL 加一段（模拟"URL 在两处各拼一次"）
    const calls: Captured[] = [];
    const tampered: FetchLike = async (url, init: FetchInitLike) => {
      const r = await fetchImpl(url + "&x=1", init);
      calls.push({ url: url + "&x=1", method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
      return r;
    };
    const d2 = makeSignedFetch({ token: TOKEN, hubAddress: HUB, fetchImpl: tampered, now: () => NOW, nonce: () => NONCE });
    await d2.signedFetch("/approvals?status=pending", { method: "GET" });
    const c = calls[0];
    if (c === undefined) throw new Error("替身没抓到请求，下面那条断言会假绿");
    expect(verdict(c)).toBe("bad_signature");
    // 而原样不篡改的那一条是 ok —— 同一次运行里放个对照，防"裁判恒红"。
    // ⚠ 对照用的是【deps 自己那一份】capture，不是我另起一份：
    // 另起一份的话 deps 的请求落回 line 上面那个 capture 的数组里，
    // 而我读的那份是空的 ⇒ verdict(undefined) 直接 TypeError。
    // 那是本发第一版的真红法，而它红在测试自己的接线，不红在实现。
    const clean = capture();
    const depsClean = makeSignedFetch({
      token: TOKEN,
      hubAddress: HUB,
      fetchImpl: clean.fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    });
    await depsClean.signedFetch("/approvals?status=pending", { method: "GET" });
    expect(verdict(clean.calls[0] as Captured)).toBe("ok");
  });

  it("token 不同 ⇒ bad_signature（而不是「悄悄都算得出来」）", async () => {
    const { calls, fetchImpl } = capture();
    const wrong = makeSignedFetch({
      token: "another-token-entirely",
      hubAddress: HUB,
      fetchImpl,
      now: () => NOW,
      nonce: () => NONCE,
    });
    await wrong.signedFetch("/tasks", { method: "GET" });
    expect(verdict(calls[0] as Captured)).toBe("bad_signature");
  });

  it("时间戳过期 ⇒ stale_timestamp（新鲜度排在签名之前，不烧 HMAC）", async () => {
    const { calls, fetchImpl } = capture();
    const old = makeSignedFetch({
      token: TOKEN,
      hubAddress: HUB,
      fetchImpl,
      // 超出 MAX_CLOCK_SKEW_MS（60s）一档
      now: () => NOW - 61_000,
      nonce: () => NONCE,
    });
    await old.signedFetch("/tasks", { method: "GET" });
    expect(verdict(calls[0] as Captured)).toBe("stale_timestamp");
  });

  it("同一个 nonce 发两次 ⇒ 第二次 replayed_nonce（nonce 不是常数）", async () => {
    // 把 nonce 做成常数（提到闭包外）是本文件最容易犯的抄写错，
    // 而它在【单次】对账里完全看不出来 —— 所以这一发盯的是【两次之间会不同】。
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl, { nonce: () => "fixed-nonce" });
    await deps.signedFetch("/tasks", { method: "GET" });
    await deps.signedFetch("/tasks", { method: "GET" });
    const guard = new NonceGuard();
    expect(verdict(calls[0] as Captured, guard)).toBe("ok");
    expect(verdict(calls[1] as Captured, guard)).toBe("replayed_nonce");
  });

  it("缺省 nonce 每次不同（不注入时）", async () => {
    const { calls, fetchImpl } = capture();
    const deps = makeSignedFetch({ token: TOKEN, hubAddress: HUB, fetchImpl });
    await deps.signedFetch("/tasks", { method: "GET" });
    await deps.signedFetch("/tasks", { method: "GET" });
    expect(calls[0]?.headers[HEADER_NONCE]).not.toBe(calls[1]?.headers[HEADER_NONCE]);
  });
});

describe("④ 发出的形状：body 键的有无、query 的透传、method 的大写", () => {
  it("GET 的 init 里【没有 body 这个键】，POST 有", async () => {
    // exactOptionalPropertyTypes 在编译期拦的是【我传】`body: undefined`；
    // 这一发拦的是【实现偷偷永远带这个键】（`body: init.body ?? ""`）——
    // 那在类型层完全合法，而线上要么给 GET 发一个空 body，
    // 要么让真适配器对 undefined 做 Buffer.from。两种都不是编译期能给的警告。
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl);
    await dispatch(deps, "hub:listTasks", undefined);
    await dispatch(deps, "hub:createTask", { idea: "x" });
    expect(Object.prototype.hasOwnProperty.call(calls[0] as object, "body")).toBe(false);
    expect(calls[1]?.body).toBe('{"idea":"x"}');
  });

  it("query 逐字节透传：编码后的字节【就是被签的那一串】", async () => {
    // channels.ts 那段注释把话挑明了：拼完的串与签名用的串必须同一份。
    // 这里用【必须 URL 编码】的取值，让"规范化一下更好看"那种改法当场红。
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl);
    await dispatch(deps, "hub:listApprovals", { status: "pending", limit: 20 });
    const c = calls[0] as Captured;
    expect(targetOf(c)).toBe("/approvals?status=pending&limit=20");
    // 签的就是这一串：拿【发出的 target】验，能过就说明没有第二份规范化
    expect(verdict(c)).toBe("ok");
  });

  it("入参 method 小写时，线上发【大写】而签名也按大写算", async () => {
    // canonicalString 自己会 toUpperCase，所以「忘了在大转发时转」不会造成 401，
    // 而会造成【签名对而 HTTP 语义错】—— 那种错的后果由服务端决定，不由这里决定。
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl);
    await deps.signedFetch("/tasks", { method: "post", body: '{"idea":"x"}' });
    const c = calls[0] as Captured;
    expect(c.method).toBe("POST");
    expect(verdict(c)).toBe("ok");
  });

  it("hubAddress 拼出的是 http://host:port + 原始 path，不做任何加工", async () => {
    const { calls, fetchImpl } = capture();
    const deps = shell(fetchImpl);
    await deps.signedFetch("/tasks/a%20b?x=1&x=2", { method: "GET" });
    expect((calls[0] as Captured).url).toBe(BASE + "/tasks/a%20b?x=1&x=2");
    // 重复键、百分号编码都不许被"整理"掉
    expect(verdict(calls[0] as Captured)).toBe("ok");
  });
});

describe("⑤ token 为空 ⇒ 构造时就抛，而不是签出必然 401 的头", () => {
  it("空串与纯空白都抛", () => {
    const { fetchImpl } = capture();
    // 这两发钉的是「没配 token」与「token 配错」必须在【形状】上可分：
    // 让它签 ⇒ 症状是 401 ⇒ 排查的人去换凭据，而真凶是启动器没传。
    expect(() => makeSignedFetch({ token: "", hubAddress: HUB, fetchImpl })).toThrow(/空串/);
    expect(() => makeSignedFetch({ token: "   ", hubAddress: HUB, fetchImpl })).toThrow(/空串/);
  });

  it("fetchImpl 是【必填】：漏传在这台机器上会以编译错误出现，而不是运行期 undefined", () => {
    // 这一发没有断言可以写（类型层的闸门），它记录的是【为什么不给默认值】：
    // `?? globalThis.fetch` 会让调用点看起来什么都没做，而离线机器上
    // globalThis.fetch 甚至可能是 undefined ⇒ 第一次 invoke 就 unreachable，
    // 症状与「Hub 没起来」同形。详见 signed-fetch.ts 文件头那三条理由。
    expect(typeof makeSignedFetch({ token: TOKEN, hubAddress: HUB, fetchImpl: capture().fetchImpl }).signedFetch).toBe(
      "function",
    );
  });
});
