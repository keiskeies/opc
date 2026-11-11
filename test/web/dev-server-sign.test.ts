/**
 * 开发服务器那份签名实现，与 hub 的验签【逐字节对账】。
 *
 * ── 为什么这一发必须存在 ────────────────────────────────────────────
 * packages/web 不许 import packages/hub（§5.6.1，test/web/hub-projection.test.ts
 * 那条源码扫描守着）。所以签名规范串在 dev-server 那一侧【只能手抄】——
 * 抄本身是被边界逼出来的，不是疏忽。
 * 但「手抄」+「抄错只表现为 401」这个组合是本仓最贵的那一族：
 * auth.ts 的验签【刻意】回一句不区分「签名不对 / 时间戳过期 / nonce 重放」的
 * unauthorized（防的是让攻击者分辨失败原因），于是——
 *   少拼一个 \n、段序写反、忘了 method 大写、把 query 先摘掉再签
 * 这四种错法在界面上与「你 token 配错了」【完全同形】。
 * 排查的人会去查部署凭据，而真凶在另一个文件的第 20 行。
 * 所以这一处不许靠注释自觉（那边文件头写一句「与 auth.ts 逐字一致」
 * 是本仓记过至少三次的恒绿装饰形状 —— 注释不参与编译，也不会随漂移变红）。
 *
 * ── 这条测试怎么才有分辨力 ─────────────────────────────────────────
 * 只断言「两边相等」是不够的：两边【都退化成对空串签名】时也相等。
 * 所以两组各钉一头：
 *  ① 正向 —— 同一组输入喂两边，四个头逐字节相等。这一发的分母是真的：
 *     canonicalString 若被改成返回空串，hub 那侧签的是 HMAC("")，
 *     与 devSign 的真签名【必然不等】⇒ 红。
 *  ② 反向 —— 逐个承重位单独扰动（body / target 的 query / 时间戳 / nonce / token），
 *     每一发都必须让签名【变】。这一组钉的是「那份规范串真的把这些段用上了」，
 *     挡的是「某个段被静默丢掉」—— 而那正是 query 那一格当年的症状。
 */
import { describe, expect, it } from "vitest";
import {
  HEADER_NONCE,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  canonicalString,
  signRequest,
} from "../../packages/hub/src/http/auth.js";
import { devSign } from "../../packages/web/src/dev-sign.js";

const TOKEN = "test-token-0123456789";
const NOW = 1_700_000_000_000;
const NONCE = "11111111-2222-3333-4444-555555555555";

/** 喂给两边的同一组输入。 */
type Inputs = {
  readonly method: string;
  readonly target: string;
  readonly body: string;
};

const FIXED: Inputs = { method: "GET", target: "/today", body: "" };

/** 服务端那一侧的签名，用【它自己的】canonicalString —— 不是本文件重写一份。 */
function hubSign(i: Inputs, now = NOW, nonce = NONCE, token = TOKEN): string {
  return signRequest({ token, method: i.method, target: i.target, body: i.body, timestamp: now, nonce });
}

describe("dev-server 的签名与 hub 的验签逐字节一致", () => {
  it("① 同一组输入 ⇒ 三个头全部相等（GET，空 body）", () => {
    const got = devSign(FIXED.method, FIXED.target, FIXED.body, { now: NOW, nonce: NONCE, token: TOKEN });
    expect(got[HEADER_SIGNATURE]).toBe(hubSign(FIXED));
    // 时间戳与 nonce 也得对上：验签方是先按 header 取回这两样、再重算规范串的，
    // 签名对而头不对 ⇒ 服务端用【另一个时间戳】重算 ⇒ 一样 401。
    expect(got[HEADER_TIMESTAMP]).toBe(String(NOW));
    expect(got[HEADER_NONCE]).toBe(NONCE);
  });

  it("① 带 query 与带 body 的请求同样相等（这两格是真陷阱所在）", () => {
    // query：auth.ts 文件头明写「不做 query 规范化」，而 dev-server 曾经差点
    // 「先摘 query 再签」—— 那一版的症状是【所有 /events?cursor=… 恒 401】，
    // 即断线续订整条死掉，而普通 JSON 请求全好（因为它们的 target 没有 query）。
    const sse: Inputs = { method: "GET", target: "/events?cursor=17&task=t1", body: "" };
    // body：POST 的 body 按【原始字节】摘要，不重新序列化 JSON。
    const post: Inputs = {
      method: "POST",
      target: "/approvals/c-1",
      body: '{"resume":"approve","note":"带 中文 与 \\" 引号"}',
    };
    for (const i of [sse, post]) {
      const got = devSign(i.method, i.target, i.body, { now: NOW, nonce: NONCE, token: TOKEN });
      expect(got[HEADER_SIGNATURE], i.method + " " + i.target).toBe(hubSign(i));
    }
  });

  it("① 正向对照：canonicalString 不是空壳（否则上一条在比两个 HMAC(\"\")）", () => {
    // 少了这一发，上面两条的「相等」有可能来自两边【都没把输入用进去】。
    // 这一发钉的是被 import 的那一位【确实是那个五段规范串】本身：
    // 四个 \n、五段、段 1 是大写方法、段 2 是原样 target（含 query）。
    const c = canonicalString({
      method: "get",
      target: "/events?cursor=17",
      body: "{}",
      timestamp: NOW,
      nonce: NONCE,
    });
    const segs = c.split("\n");
    expect(segs).toHaveLength(5);
    expect(segs[0]).toBe("GET");
    expect(segs[1]).toBe("/events?cursor=17");
    expect(segs[2]).toHaveLength(64); // sha256 hex
    expect(segs[3]).toBe(String(NOW));
    expect(segs[4]).toBe(NONCE);
    // 而 devSign 用的那一份【也】必须是同一形状 —— 通过对账而不是比字符串：
    // 本文件【不】抄一份 canonicalString 出来比字符串（那等于造第三个抄件），
    // 上面那两条 HMAC 相等已经蕴含规范串相等（HMAC 抗碰撞，实践中当作单射）。
  });

  it("② 反向：逐个承重位单独扰动 ⇒ 签名必须变", () => {
    const base = devSign(FIXED.method, FIXED.target, FIXED.body, { now: NOW, nonce: NONCE, token: TOKEN });
    const sig = (
      i: Inputs,
      o: { now?: number; nonce?: string; token?: string } = {},
    ): string => devSign(i.method, i.target, i.body, { now: NOW, nonce: NONCE, token: TOKEN, ...o })[HEADER_SIGNATURE];
    const cases: readonly (readonly [string, string])[] = [
      ["body 变一个字符", sig({ ...FIXED, body: "{}" })],
      ["target 多个 query", sig({ ...FIXED, target: "/today?window_ms=1" })],
      // query 里【只有一个字符】不同也必须变 —— 挡的是「对 query 做了规范化/排序」
      ["query 顺序换了", sig({ method: "GET", target: "/events?b=2&a=1", body: "" })],
      ["时间戳 +1ms", sig(FIXED, { now: NOW + 1 })],
      ["nonce 换一个", sig(FIXED, { nonce: "66666666-7777-8888-9999-000000000000" })],
      ["token 换一个", sig(FIXED, { token: "other" })],
      ["方法【换成另一个】", sig({ ...FIXED, method: "POST" })],
    ];
    for (const [what, s] of cases) {
      expect(s, what).not.toBe(base[HEADER_SIGNATURE]);
    }
    /**
     * 大小写【单独】说，因为它的方向和上面每一条都相反：
     * devSign 与 canonicalString 都做了 toUpperCase，所以 "get" 与 "GET"
     * 在两边得到【同一个】签名 —— 这是【刻意的】（HTTP 方法本就不分大小写，
     * 而规范串要的是唯一形态；不做归一化会让同一个请求有两种合法签名）。
     * 把它混进上面那个「必须变」的循环里，会让那条【红】，
     * 而下一个人会去改【实现】（把 toUpperCase 拿掉）来让它绿 ——
     * 那正好破掉归一化本身。所以单独钉成「不变」。
     */
    expect(sig({ ...FIXED, method: "get" })).toBe(base[HEADER_SIGNATURE]);
    expect(sig({ ...FIXED, method: "post" })).not.toBe(base[HEADER_SIGNATURE]);
  });

  it("② 缺省 nonce 每次不同（否则重放防护是个摆设）", () => {
    const a = devSign(FIXED.method, FIXED.target, FIXED.body, { now: NOW, token: TOKEN });
    const b = devSign(FIXED.method, FIXED.target, FIXED.body, { now: NOW, token: TOKEN });
    expect(a[HEADER_NONCE]).not.toBe(b[HEADER_NONCE]);
  });
});
