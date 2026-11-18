/**
 * 那一发外网 HTTP 的**自设截止**（`FEISHU_FETCH_TIMEOUT_MS` / `FeishuConfig.fetchTimeoutMs`）。
 *
 * ── 这一文件为什么单独存在 ────────────────────────────────────────────
 * `feishu.test.ts` 的文件头写了一句「一发真网络请求都不打」，那是那份文件的**优点**，
 * 不能为了测超时把它划掉。本篇正相反：它【真的开一个监听但永不应答的本地 socket】，
 * 因为超时这一格用假 fetch 只能证到「init 里有一个 signal 字段」，证不到
 * 「那个 signal 到点会真的掐掉一发请求」。
 *
 * ── 射程：三格各自归谁（越界的那一格最容易读宽）──────────────────────
 *  ① **默认实现**掐得掉：下面 A 组两发，一边不答一边秒答。这是唯一有真分母的一格。
 *  ② **适配器每一发都交出信号**：B 组。它钉的是「没有哪一发漏挂」，
 *     以及「每一发各自一个信号」（一轮共用一个 = 后面的页被第一页的时间杀掉）。
 *  ③ 注入实现【读不读】那个信号：⚠ 这一格【没有机器判据】。装配方交一份忽略
 *     `init.signal` 的实现（真接 SDK 那天完全可能），超时就在结构上失效，
 *     而没有任何一发会红。写在 `im-channels.ts` 的 `fetchImpl` 那一栏，
 *     别把它读成「超时这条路整个被管着」。
 *
 * ── 为什么不测「一轮的上限」 ─────────────────────────────────────────
 * 一轮最多是 1 次取 token + N 页读 + 1 次发卡，那个乘积不是一个能钉的数，
 * 而把它钉住会造出一条假保证（见 `FEISHU_FETCH_TIMEOUT_MS` 注释里那节「口径」）。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/channels/feishu-http.test.ts
 */
import { createServer } from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import {
  FEISHU_FETCH_TIMEOUT_MS,
  FeishuChannel,
  type FeishuFetch,
  type FeishuFetchInit,
} from "../../src/channels/feishu.js";

const APP_ID = "cli_test_app";
const SECRET = "super-secret-app-secret";

/**
 * 一个【接受连接但永不应答】的本地服务器。
 *
 * 为什么不用 `setTimeout(() => {}, 10_000)` 之类假装慢：那样测的是我自己造的那格慢，
 * 不是 fetch + signal 这一条真通路。真的 socket 挂在那里，掐它的才是那份默认实现。
 * ⚠ 请求监听里【什么都不做】正是它的用途：连 res.end 都不调。
 */
const hanging = createServer(() => {});
/** 应答正确的假飞书（只够 token + 一次空列表）。 */
const answering = createServer((req, res) => {
  const body = req.url?.includes("tenant_access_token")
    ? { code: 0, tenant_access_token: "t-1", expire: 3600 }
    : { code: 0, data: { items: [], has_more: false } };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
});
await new Promise<void>((r) => hanging.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => answering.listen(0, "127.0.0.1", r));
/** 拿端口。`address()` 的返回类型是三态联合，这里只可能是 TCP 那一支。 */
function portOf(srv: typeof hanging): number {
  const a = srv.address();
  if (a === null || typeof a === "string")
    throw new Error("没在 127.0.0.1 上listen成功");
  return a.port;
}
const hangingOrigin = "http://127.0.0.1:" + String(portOf(hanging));
const answeringOrigin = "http://127.0.0.1:" + String(portOf(answering));

afterAll(() => {
  hanging.close();
  answering.close();
});

function ch(
  over: Partial<ConstructorParameters<typeof FeishuChannel>[0]> = {},
) {
  return new FeishuChannel({
    channelId: "feishu-ceo-dm",
    appId: APP_ID,
    appSecret: SECRET,
    approverOpenId: "ou_approver_1",
    approverChatId: "oc_test_chat",
    onOverflow: () => {},
    origin: answeringOrigin,
    ...over,
  });
}

/** 记录每一发 init 的假 fetch；`reply` 决定这一发答什么。 */
function spyFetch(
  reply: (url: string, init: FeishuFetchInit) => unknown = () => ({
    code: 0,
    data: { items: [], has_more: false },
  }),
): {
  readonly fetchImpl: FeishuFetch;
  readonly inits: FeishuFetchInit[];
  readonly urls: string[];
} {
  const inits: FeishuFetchInit[] = [];
  const urls: string[] = [];
  return {
    inits,
    urls,
    fetchImpl: async (url, init) => {
      urls.push(url);
      inits.push(init);
      const token = url.includes("tenant_access_token");
      return {
        status: 200,
        json: async () =>
          token
            ? { code: 0, tenant_access_token: "t-1", expire: 3600 }
            : reply(url, init),
      };
    },
  };
}

/* ══════════════ A：默认实现真的掐得掉（本篇唯一的真分母）══════════════ */

describe("⭐ 默认那份 fetch：远端不答 ⇒ 到点就掐，不是一路挂着", () => {
  it("⭐ 挂住的服务器 ⇒ 抛，且抛的那句里没有 app_secret", async () => {
    const t0 = Date.now();
    const err = await ch({
      origin: hangingOrigin,
      fetchTimeoutMs: 150,
    })
      .pollOnce()
      .then(() => null)
      .catch((e: unknown) => e);
    const elapsed = Date.now() - t0;
    // 挂住的是【取 token】那一发（一轮的第一发），所以出口是 token 那一条 catch。
    expect(String(err)).toContain("取 tenant_access_token 时请求没走通");
    // 正半发：那个 catch 拿的是异常自身。这里证明【这一次真的走到了它】，
    // 而它没有把请求体带出来 —— 体里有 app_secret。
    expect(String(err)).not.toContain(SECRET);
    // 反空转：假绿最可能的形状是「一发根本没打出去，立刻抛了个别的东西」，
    // 那也会满足上面两句。时间下界把「确实挂过一阵」钉住。
    expect(elapsed).toBeGreaterThanOrEqual(100);
    // 上界：缺省值是 10s，这一发交的是 150ms。越过 5s 就说明读的是缺省值而不是交进去的那个。
    expect(elapsed).toBeLessThan(5_000);
  });

  it("正对照：同一个信号通路，秒答的服务器一切正常（掐人不能顺手掐活人）", async () => {
    const n = await ch({ fetchTimeoutMs: 2_000 }).pollOnce();
    expect(n).toBe(0);
  });
});

/* ══════════════ B：适配器每一发都交出【各自的】信号 ══════════════ */

describe("适配器交出信号：每一发都有，且各是一个新的", () => {
  it("⭐ 取 token 与读消息【两发都】带着未失效的信号", async () => {
    const f = spyFetch();
    await ch({ fetchImpl: f.fetchImpl }).pollOnce();
    expect(f.urls.length).toBeGreaterThanOrEqual(2);
    expect(f.inits.every((i) => i.signal instanceof AbortSignal)).toBe(true);
    expect(f.inits.every((i) => i.signal?.aborted === false)).toBe(true);
  });

  it("⭐ 翻页的两发各有各的信号：共用一个 = 第二页被第一页的时间杀掉", async () => {
    const f = spyFetch((url) =>
      url.includes("page_token=next")
        ? { code: 0, data: { items: [], has_more: false } }
        : { code: 0, data: { items: [], has_more: true, page_token: "next" } },
    );
    await ch({ fetchImpl: f.fetchImpl }).pollOnce();
    expect(f.urls.length).toBe(3);
    const [a, b, c] = f.inits;
    expect(a?.signal).not.toBe(b?.signal);
    expect(b?.signal).not.toBe(c?.signal);
  });

  it("注入实现【读了】信号 ⇒ 到点就 reject，而 supportsActionReturn 仍是 false", async () => {
    // 这一发证明「读了 signal」这条路【通】：读数 0 + 回传路判为不通，
    // 而不是把一个没把握的形状乐观地报成健康。
    const patient: FeishuFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        const s = init.signal;
        if (s === undefined) throw new Error("注入实现没拿到信号");
        s.addEventListener("abort", () =>
          reject(new Error("aborted by deadline")),
        );
      });
    const c = ch({ fetchImpl: patient, fetchTimeoutMs: 40 });
    await expect(c.pollOnce()).rejects.toThrow("aborted by deadline");
    expect(c.supportsActionReturn).toBe(false);
  });
});

/* ══════════════ C：那个数怎么给 ══════════════ */

describe("fetchTimeoutMs：交得进去，且畸形值不是「关掉超时」", () => {
  /**
   * 等过交进去的截止，看信号到点了没有 —— 从假 fetch 观测时长而又不必等 10 秒。
   *
   * ⚠ 返回的是【两个】读数而不是一个布尔：只问「到点了没有」分不开「回落到 10s」与
   *    「根本没挂信号」这两种相反的形状（两者都答「没到点」）。而后者正是
   *    「把 0 读成关掉超时」那个坏形状。
   */
  async function probe(
    timeoutMs: number | undefined,
    waitMs: number,
  ): { signal: AbortSignal | undefined; aborted: boolean } {
    const f = spyFetch();
    const over: Partial<ConstructorParameters<typeof FeishuChannel>[0]> = {
      fetchImpl: f.fetchImpl,
    };
    if (timeoutMs !== undefined) over.fetchTimeoutMs = timeoutMs;
    const p = ch(over).pollOnce();
    await new Promise((r) => setTimeout(r, waitMs));
    const signal = f.inits[0]?.signal;
    const aborted = signal?.aborted ?? false;
    await p;
    return { signal, aborted };
  }

  it("交 40ms ⇒ 那个信号在 40ms 处到点（读数确实来自交进去的那个数）", async () => {
    const r = await probe(40, 200);
    expect(r.signal).toBeInstanceOf(AbortSignal);
    expect(r.aborted).toBe(true);
  });

  it("⭐ 交 0 ⇒ 不是关掉超时：信号【在】，而 200ms 之内【没】到点", async () => {
    const r = await probe(0, 200);
    // 这一句是分母：少了它，「0 = 关掉超时」会一路绿 —— 那种形状同样是「没到点」。
    expect(r.signal).toBeInstanceOf(AbortSignal);
    expect(r.aborted).toBe(false);
  });

  it("⭐ 什么都不交 ⇒ 同样是「有信号而 200ms 内不到点」：缺省走的是那个 10s", async () => {
    const r = await probe(undefined, 200);
    expect(r.signal).toBeInstanceOf(AbortSignal);
    expect(r.aborted).toBe(false);
  });

  it("交负数 / NaN / Infinity ⇒ 同样回落到缺省值，信号照旧交出", async () => {
    expect(FEISHU_FETCH_TIMEOUT_MS).toBe(10_000);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = spyFetch();
      // `AbortSignal.timeout(Infinity)` 会 RangeError —— 回落坏了的话这里直接炸，
      // 而不是安静地变成一个「永不到点」的信号。
      const n = await new FeishuChannel({
        channelId: "c",
        appId: APP_ID,
        appSecret: SECRET,
        approverOpenId: "ou_x",
        approverChatId: "oc_x",
        onOverflow: () => {},
        origin: answeringOrigin,
        fetchImpl: f.fetchImpl,
        fetchTimeoutMs: bad,
      }).pollOnce();
      expect(n).toBe(0);
      // 取 token + 读列表两发，各带一个【还没到点】的信号（10s 之内服务器就答了）。
      expect(f.inits.length).toBe(2);
      expect(f.inits.every((i) => i.signal instanceof AbortSignal)).toBe(true);
      expect(f.inits.every((i) => i.signal?.aborted === false)).toBe(true);
    }
  });
});
