/**
 * IM 身份绑定那四条路由【对外开放的那一面】（0031）。
 *
 * ── 与 test/bindings/im.test.ts 的分工 ───────────────────────────────
 * 那一篇测的是【判据】：DDL 那七条性质 + im.ts 那三个写入口的判决形状。
 * 它直接调函数，不碰 HTTP。本文件测的是从 HTTP 进来会发生什么：
 * 状态码、请求体的严格程度、署名从哪来、以及那两条【只在 HTTP 层存在】的判据
 * （回环门 + 装配方署名）。
 *
 * 这个分工不是「一个测函数一个测路由」的分类癖。判据在 im.ts 那一侧全绿，
 * 而 HTTP 这一侧仍然可以把它整套绕掉 —— 三种真实绕法本文件各有一发：
 *  ① handler 自己拼 SQL（绕开全部预检）——由 im.test.ts 那条扫 src 的守卫挡，
 *     本文件配一发反向对照（响应体里出现不了表内形状）；
 *  ② 把署名从请求体里读进来（0030 §4 那条 DDL 判据当场作废）；
 *  ③ 把路由开到非回环（远程自校验 = 任何人自封 CEO 身份）。
 *
 * ── 库与队列都是【真的】──────────────────────────────────────────────
 * 不用假 db：这三条写路径的价值全在【DDL 触发器真的会响】，
 * 而触发器只活在 migration 建出来的那个库文件里。
 * 「TS 侧的判决返回 ok 而库里是另一个形状」正是 0021 §1 抓过的那族，
 * 假替身让它无处可现（im.test.ts 的文件头写的是同一条理由）。
 * 写走真 WriteQueue，读走它自己的只读连接 —— 与 buildHubDeps 装配的完全同构。
 *
 * ⚠ 时钟是【可推进的】而不是常量。这一句决定了下面一条用例有没有内容：
 * 「重复校验不刷新 verified_at」在 now() 恒定时代码怎么写都绿（两个值天然相等）。
 * 所以这里给一个能 advance 的 now，并在用例里真的推进它。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTP_CONFLICT, HTTP_NOT_FOUND, HTTP_NOT_IMPLEMENTED } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { handleRequest, matchRoute, type HubDeps, type HubRequest } from "../../src/http/app.js";
import {
  assertLoopbackBindingRoute,
  listBindingsRoute,
  rebindBindingRoute,
  requestBindingRoute,
  verifyBindingRoute,
} from "../../src/http/bindings.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";

const TMP = fixtureTmp("http-bindings-route", import.meta.url);

const UNAUTHORIZED = 401;
const UNPROCESSABLE = 422;
const VERIFIER = "keiskeis";
/** 同一 WiFi 上的另一台机器。 */
const LAN_PEER = "192.168.1.7";
/** 起点。用可推进的时钟，理由见文件头那条 ⚠。 */
const T0 = 1_700_000_000_000;
const STEP = 60_000;

const queues: WriteQueue[] = [];
let fileSeq = 0;

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

interface Harness {
  readonly deps: HubDeps;
  readonly db: Db;
  /** 写连接：断言【库里到底是什么形状】用它，不用 deps.db（那条是只读的）。 */
  readonly write: Db;
  readonly sign: (method: string, target: string, body?: string) => Record<string, string>;
  readonly req: (o: Partial<HubRequest> & { method: string; path: string }) => HubRequest;
  /** 推进时钟。返回推进后的值。 */
  readonly advance: (ms?: number) => number;
  readonly token: string;
}

/**
 * 一份真装配。
 *
 * @param o.verifier 不给 ⇒ HubDeps.bindingVerifier 缺席 ⇒ verify 路由该 501。
 * @param o.writer   false ⇒ bindingWriter 缺席 ⇒ 三条写路由该 501 而读侧照旧 200。
 */
async function harness(
  o: { verifier?: string; writer?: boolean } = {},
): Promise<Harness> {
  const path = join(TMP, "br-" + process.pid + "-" + ++fileSeq + ".db");
  const queue = new WriteQueue(path);
  queues.push(queue);
  const write = queue.writeConnection() as unknown as Db;
  migrate(write as never);
  const read = queue.readConnection() as unknown as Db;
  const token = newLocalToken();
  let clock = T0;
  const sign = (method: string, target: string, body = ""): Record<string, string> =>
    signedHeaders(token, { method, target, body, now: clock });
  const deps: HubDeps = {
    db: read as never,
    bus: new InMemoryEventBus(),
    token,
    now: () => clock,
    ...(o.writer === false ? {} : { bindingWriter: queue as never }),
    ...(o.verifier === undefined ? {} : { bindingVerifier: o.verifier }),
    // 这三条在本文件里从不被触发（四条路由都不碰它们），但 HubDeps 要求它们存在。
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    // 这台夹具扮演的是哪一台 Hub（HubDeps.driverState 必填的理由在那边）：这四条测的是鉴权与路由形状，与驱动器无关；选 OFF 是让【夹具扮演的这台】没在推，看板那一格不参与这些断言。
    driverState: () => DRIVER_OFF,
  };
  return {
    deps,
    db: read,
    write,
    token,
    sign,
    advance: (ms = STEP) => {
      clock += ms;
      return clock;
    },
    // 与 contract.test.ts 的 fixture 同一条纪律：【签名由这里自己做】，
    // 签的是 path+query 派生出的那个 target。让每个调用点自己保证一致 = 安排一次遗忘
    // （那边就踩过：签 /events 而发 /events?cursor=abc ⇒ 401）。
    req: (q) => {
      const target = q.path;
      return {
        query: {},
        body: "",
        ...q,
        target,
        peer: q.peer ?? LOOPBACK_HOST,
        headers: q.headers ?? sign(q.method, target, q.body ?? ""),
      };
    },
  };
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

const bindingBody = (
  o: { platform?: string; external_user_id?: string; role?: string } = {},
): string =>
  JSON.stringify({
    platform: o.platform ?? "feishu",
    external_user_id: o.external_user_id ?? "ou_alice",
    role: o.role ?? "dev",
  });

function bindingRow(write: Db, platform: string, ext: string): Row | undefined {
  return write
    .prepare(
      "SELECT id, platform, external_user_id, ceo_role, verified, created_at, " +
        "verified_at, verified_by FROM im_bindings " +
        "WHERE platform = ? AND external_user_id = ?",
    )
    .get(platform, ext) as Row | undefined;
}

/* ══════════════════ ① 路由形状 ══════════════════ */

describe("① matchRoute：四条各归各的，拼错的段是 404 而不是体面答复", () => {
  it("四条各自匹到自己的 kind 与 endpoint", () => {
    expect(matchRoute("GET", "/bindings")?.kind).toBe("list_bindings");
    expect(matchRoute("POST", "/bindings")?.kind).toBe("request_binding");
    expect(matchRoute("POST", "/bindings/verify")?.kind).toBe("verify_binding");
    expect(matchRoute("POST", "/bindings/rebind")?.kind).toBe("rebind_binding");
    // endpoint 字段【也】点名：kind 对而 endpoint 错，isImplemented 与 501 文案都会指错端点。
    expect(matchRoute("POST", "/bindings/verify")?.endpoint).toBe("POST /bindings/verify");
    expect(matchRoute("POST", "/bindings/rebind")?.endpoint).toBe("POST /bindings/rebind");
  });

  it("⭐ 方法【不互换】：GET 打不到写路由，POST 打不到读路由", () => {
    // 这一发的意义不在「方法要匹配」（matchRoute 每条都判 method），
    // 而在我加这四条时【极易】写成 `segs[0] === "bindings"` 而不看方法 ——
    // 那时 GET /bindings/verify 会匹到 verify_binding，一个【读】请求就完成了一次校验。
    expect(matchRoute("GET", "/bindings/verify")).toBeNull();
    expect(matchRoute("GET", "/bindings/rebind")).toBeNull();
    expect(matchRoute("GET", "/bindings/anything")).toBeNull();
    expect(matchRoute("POST", "/bindings/")).toBeNull();
    expect(matchRoute("DELETE", "/bindings")).toBeNull();
  });

  it("⭐ 第二段的字面值承重：拼错一个字母是 null（404），不是「把这一段当 id」", () => {
    // 四条路由都没有 id 段（见 Route 类型旁那段）。若把 verify 写成
    // `{ kind: "verify_binding", id: segs[1] }`，/bindings/verfy 会匹配成功，
    // 得到一次 2xx/4xx 里最误导人的那种，而 404 才是事实。
    expect(matchRoute("POST", "/bindings/verfy")).toBeNull();
    expect(matchRoute("POST", "/bindings/Verify")).toBeNull();
    expect(matchRoute("POST", "/bindings/verify/extra")).toBeNull();
    expect(matchRoute("POST", "/bindings/rebind/x")).toBeNull();
  });

  it("既有路由【没被新前缀抢走】（反向对照，防 /bindings 那条写得太宽）", () => {
    expect(matchRoute("GET", "/approvals")?.kind).toBe("list_approvals");
    expect(matchRoute("GET", "/tasks")?.kind).toBe("list_tasks");
    expect(matchRoute("GET", "/replay/t1")?.kind).toBe("replay");
  });
});

/* ══════════════════ ② GET /bindings ══════════════════ */

describe("② GET /bindings", () => {
  it("空表 ⇒ 200 + 空数组 + pendingTotal 0 + asOfMs 带出去", async () => {
    const h = await harness();
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bindings: [], pendingTotal: 0, asOfMs: T0 });
  });

  it("⭐ 已验证的排前面，pendingTotal 只数【未验证】的", async () => {
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody({ external_user_id: "u1" }) }),
    );
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody({ external_user_id: "u2" }) }),
    );
    await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "u2" }),
      }),
    );
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    const body = res.body as {
      bindings: { external_user_id: string; verified: boolean }[];
      pendingTotal: number;
    };
    expect(body.bindings.map((b) => [b.external_user_id, b.verified])).toEqual([
      ["u2", true],
      ["u1", false],
    ]);
    // 两个 false 是断言的一部分，不是只数长度：一个把 pendingTotal 写成
    // 「行数」的实现会让 2 与 0 都对得上，只有这一发分得开。
    expect(body.pendingTotal).toBe(1);
  });

  it("对外行的键【恰好】是契约那八个（不泄 id 之外的内部列）", async () => {
    const h = await harness();
    await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody() }),
    );
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    const row = (res.body as { bindings: Record<string, unknown>[] }).bindings[0] as Record<
      string,
      unknown
    >;
    expect(Object.keys(row).sort()).toEqual([
      "created_at",
      "external_user_id",
      "id",
      "platform",
      "role",
      "verified",
      "verified_at",
      "verified_by",
    ]);
    // 库里那一列叫 ceo_role，对外叫 role —— 这一格量的就是那次改名【真的发生了】。
    expect("ceo_role" in row).toBe(false);
  });

  it("未校验的行：verified=false 且 verified_by 是 null 而不是空串", async () => {
    // 「没署名」与「署了一个空名字」在一张 append-only 的表里是两件事，
    // 而 DDL 第 7 条（0030 §7）拦的是「未验证的行挂着署名」——
    // 空串是那个形状的漏网之鱼（它 IS NOT NULL），所以视图层必须交 null。
    const h = await harness();
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody() }));
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    const row = (res.body as { bindings: Record<string, unknown>[] }).bindings[0] as Record<
      string,
      unknown
    >;
    expect(row["verified"]).toBe(false);
    expect(row["verified_by"]).toBeNull();
    expect(row["verified_at"]).toBeNull();
  });

  it("bindingWriter 缺席 ⇒ 读侧【照旧 200】（读不该被一条没接的写路径挡住）", async () => {
    const h = await harness({ writer: false });
    const res = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    expect(res.status).toBe(200);
  });
});

/* ══════════════════ ③ POST /bindings（申请）══════════════════ */

describe("③ POST /bindings", () => {
  it("合法 ⇒ 201，而库里那一行是 verified=0 且【两处署名都是 NULL】", async () => {
    const h = await harness({ verifier: VERIFIER });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody({ role: "dev" }) }),
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, role: "dev", verified: false });
    // ★ 这一发是本文件的第一发「HTTP 层没能把 DDL 判据绕掉」：
    // 201 只说明 handler 满意，verified=false 只说明【响应里】这么说。
    // 库里那两个 NULL 才是「申请不是校验」这件事真的成立。
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["verified"]).toBe(0);
    expect(row["verified_by"]).toBeNull();
    expect(row["verified_at"]).toBeNull();
  });

  it("⭐ 重复申请 ⇒ 409，且第二次的 role【没有】覆盖第一行", async () => {
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody({ role: "dev" }) }));
    const again = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody({ role: "ceo" }) }),
    );
    expect(again.status).toBe(HTTP_CONFLICT);
    // 幂等 201 是最顺手的写法（「同一个身份再来一次，当然算成功」），
    // 而它的响应在撒谎：调用方提交了 role=ceo，生效的还是 dev。
    expect((bindingRow(h.write, "feishu", "ou_alice") as Row)["ceo_role"]).toBe("dev");
  });

  it("⭐ 请求体带 verified / verified_by ⇒ 422（schema 是 strict，不是「不看它」）", async () => {
    // 0030 §3 那次「申请与校验分成两次写」的判据，在 HTTP 层的形状就是这一发。
    // 非 strict 的 schema 会让 {platform, external_user_id, role, verified: 1}
    // 静静穿过校验层，而 im.ts 收不到那个字段 ⇒ 结果正确但**接口允许了一句假话**：
    // 客户端以为自己要到了 verified=1。当场 422 才让那次意图可见。
    const h = await harness({ verifier: VERIFIER });
    for (const extra of [
      { verified: true },
      { verified: 1 },
      { verified_by: VERIFIER },
      { role: "dev", verified_by: "ceo" },
    ]) {
      const res = await handleRequest(
        h.deps,
        h.req({
          method: "POST",
          path: "/bindings",
          body: JSON.stringify({
            platform: "feishu",
            external_user_id: "ou_x",
            role: "dev",
            ...extra,
          }),
        }),
      );
      expect(res.status, "实到 " + JSON.stringify(res.status) + "，请求体 +" + JSON.stringify(extra)).toBe(
        UNPROCESSABLE,
      );
    }
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });

  it("平台不在白名单 ⇒ 422 且【库里一行不剩】", async () => {
    const h = await harness({ verifier: VERIFIER });
    for (const p of ["wechat", "fake", "telegram", "", "  "]) {
      const res = await handleRequest(
        h.deps,
        h.req({
          method: "POST",
          path: "/bindings",
          body: bindingBody({ platform: p }),
        }),
      );
      expect(res.status, "平台 " + JSON.stringify(p)).toBe(UNPROCESSABLE);
    }
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });

  it("⭐ 大小写与空白在【进判据之前】被归一化：' Feishu ' ⇒ 201，库里落的是 'feishu'", async () => {
    // 这一发写的不是我先前以为的那件事，所以把它钉准。
    // 0030 §2 那段「'Feishu' 走不到白名单里任何一项 ⇒ 当场被拦」说的是
    // 【绕过写侧直接写库】那一侧（SQLite TEXT 的 BINARY 排序），
    // 而 normalizePlatform 明确做了 trim + toLowerCase —— 归一化在【校验之前】。
    // 我第一版在这里断言 'Feishu' 被拒，跑出来是 201，而**代码是对的、我错了**：
    // 用户在界面上手滑打个大写，应当得到一次成功的申请，而不是一句数据库报错。
    // 于是这两侧的分工是：写侧【宽】（ forgiving 输入），DDL【严】（只收三种精确写法）。
    const h = await harness({ verifier: VERIFIER });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody({ platform: " Feishu " }) }),
    );
    expect(res.status).toBe(201);
    // 库里那一格是归一化【之后】的值 —— 这条比状态码要紧：
    // 若存的是 ' Feishu '，读侧按 'feishu' 查恒 null，
    // 症状是「申请提交了、列表里看不见、永远批不掉」，而 201 说过它成功了。
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["platform"]).toBe("feishu");
  });

  it("空 body / 坏 JSON ⇒ 422，而不是 500", async () => {
    const h = await harness({ verifier: VERIFIER });
    for (const body of ["", "{", "null", "[]", "\"x\""]) {
      const res = await handleRequest(
        h.deps,
        h.req({ method: "POST", path: "/bindings", body }),
      );
      expect(res.status, "body " + JSON.stringify(body)).toBe(UNPROCESSABLE);
    }
  });

  it("bindingWriter 缺席 ⇒ 501 而【不是】401/404/500", async () => {
    const h = await harness({ writer: false });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings", body: bindingBody() }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
  });
});

/* ══════════════════ ④ POST /bindings/verify ══════════════════ */

describe("④ POST /bindings/verify", () => {
  it("未装配署名来源 ⇒ 501 且库里【一字未动】", async () => {
    const h = await harness(); // 没有 verifier
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody() }));
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
      }),
    );
    expect(res.status).toBe(HTTP_NOT_IMPLEMENTED);
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["verified"]).toBe(0);
    expect(row["verified_by"]).toBeNull();
  });

  it("合法 ⇒ 200，而库里 verified=1 + 署名是【装配那个名字】+ 时刻是服务端那个", async () => {
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody() }));
    const at = h.advance();
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, verified: true, verified_at: at });
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["verified"]).toBe(1);
    expect(row["verified_by"]).toBe(VERIFIER);
    expect(row["verified_at"]).toBe(at);
  });

  it("⭐ 请求体里塞 verified_by ⇒ 422，且库里那一行【不会因为多带一个键就被署名】", async () => {
    // 这是本文件最贵的一发。把署名做成请求字段看起来完全合理
    // （「调用方告诉我是谁验的」），而它让【任何人】POST
    // { verified_by: "ceo" } 就得到一行「ceo 校验过」——
    // 0030 §4 那条 DDL 判据（置 1 必须交出署名）验的是「这一格有没有值」，
    // 验不了「这句话是不是真的」。所以署名只能从装配来源来。
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody() }));
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({
          platform: "feishu",
          external_user_id: "ou_alice",
          verified_by: "someone-else",
        }),
      }),
    );
    expect(res.status).toBe(UNPROCESSABLE);
    expect(JSON.stringify(res.body)).not.toContain("someone-else");
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["verified"]).toBe(0);
    expect(row["verified_by"]).toBeNull();
  });

  it("⭐ 重复校验 ⇒ 409，且 verified_at / verified_by 【都没被刷新】", async () => {
    // 时钟在这里【必须真的推进】：now() 恒定时 verified_at 两次天然相等，
    // 这一发就变成一条只会绿的装饰（0007 §4.1 那一族）。
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody() }));
    const first = h.advance();
    await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
      }),
    );
    const second = h.advance(3_600_000);
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
      }),
    );
    expect(res.status).toBe(HTTP_CONFLICT);
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["verified_at"]).toBe(first);
    expect(row["verified_at"]).not.toBe(second);
    // 为什么这条不是洁癖：markVerified 的 SQL 带 `AND verified = 0`，
    // 重复调用在库里改动为零；回 200 幂等就是在说「你的校验生效了」而它没生效。
    // 200 与 409 的修法完全不同（一个是「我点重了，没事」，一个是「这一次没发生」）。
    expect(second).toBeGreaterThan(first as number);
  });

  it("没申请过 ⇒ 404，而报错里【不出现】任何别的身份", async () => {
    const h = await harness({ verifier: VERIFIER });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ghost" }),
      }),
    );
    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it("平台不合法 ⇒ 422；装配方没有 verifier 时也仍是 501（判据顺序：装配先于解析）", async () => {
    const h = await harness({ verifier: VERIFIER });
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "fake", external_user_id: "u" }),
      }),
    );
    expect(res.status).toBe(UNPROCESSABLE);

    // 顺序这一格有内容：一个未装配的 Hub 上，连【非法平台】的请求都拿到 501 而不是 422。
    // 反过来（先解析后问装配）会得到「参数错了」这种指向调用方的报错，
    // 而调用方改参数也解决不了 —— 与 mintToken 那种「先看没接线」的次序同一条口径。
    const bare = await harness();
    const gated = await handleRequest(
      bare.deps,
      bare.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "fake", external_user_id: "u" }),
      }),
    );
    expect(gated.status).toBe(HTTP_NOT_IMPLEMENTED);
  });
});

/* ══════════════════ ⑤ POST /bindings/rebind ══════════════════ */

describe("⑤ POST /bindings/rebind", () => {
  it("⭐ 改一个【已校验】的绑定 ⇒ 200 + verified=false，而库里【署名一起被清掉】", async () => {
    // 这一发把 0030 §7 那条 DDL 判据从 HTTP 走一遍：
    // 改身份必须同一条语句把 verified 落回 0，而 §7 要求【同时】清掉那两处署名。
    // 少了 §7，库里会留下一行 verified=0 而 verified_by='ceo' ——
    // 一句挂在未校验身份上的假话，而它此刻在 GET /bindings 的响应里。
    const h = await harness({ verifier: VERIFIER });
    await handleRequest(h.deps, h.req({ method: "POST", path: "/bindings", body: bindingBody({ role: "dev" }) }));
    await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings/verify",
        body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
      }),
    );
    expect((bindingRow(h.write, "feishu", "ou_alice") as Row)["verified_by"]).toBe(VERIFIER);

    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings/rebind", body: bindingBody({ role: "ceo" }) }),
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, role: "ceo", verified: false });
    const row = bindingRow(h.write, "feishu", "ou_alice") as Row;
    expect(row["ceo_role"]).toBe("ceo");
    expect(row["verified"]).toBe(0);
    expect(row["verified_by"]).toBeNull();
    expect(row["verified_at"]).toBeNull();

    // 而 GET 那一侧读回来【也是】这句话。库里对、响应错同样是事故（0021 §2 同族）。
    const listed = await handleRequest(h.deps, h.req({ method: "GET", path: "/bindings" }));
    const view = (listed.body as { bindings: Record<string, unknown>[] }).bindings[0] as Record<
      string,
      unknown
    >;
    expect(view["role"]).toBe("ceo");
    expect(view["verified"]).toBe(false);
    expect(view["verified_by"]).toBeNull();
  });

  it("没申请过 ⇒ 404（改绑不是创建的第二条路）", async () => {
    const h = await harness({ verifier: VERIFIER });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/bindings/rebind", body: bindingBody() }),
    );
    expect(res.status).toBe(HTTP_NOT_FOUND);
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });
});

/* ══════════════════ ⑥ 回环门 ══════════════════ */

describe("⑥ 四条路由【全部】只开回环", () => {
  const four = [
    { name: "GET /bindings", method: "GET", path: "/bindings", body: "" },
    { name: "POST /bindings", method: "POST", path: "/bindings", body: bindingBody() },
    {
      name: "POST /bindings/verify",
      method: "POST",
      path: "/bindings/verify",
      body: JSON.stringify({ platform: "feishu", external_user_id: "ou_alice" }),
    },
    { name: "POST /bindings/rebind", method: "POST", path: "/bindings/rebind", body: bindingBody() },
  ] as const;

  it("⭐ 带【真签名】的非回环请求 ⇒ 四条全 401", async () => {
    // 这一发是本文件与 tokens-route.test.ts 的【关键差别】，值得写准：
    // mintToken 那道门端到端【打不到】（远程持票人在第一道门就被弹掉），
    // 而那一条论证不适用于这里 —— 只要请求带着【合法 HMAC 签名】，
    // route() 就会放进 dispatch()，于是这里的回环门是【可达的】。
    // 「签名合法但人不在本机」在生产里签不出来（密钥不落盘），所以它今天不可达；
    // 可达性由下面那条【反向对照】负责证明这一发不是恒真的 401。
    const h = await harness({ verifier: VERIFIER });
    for (const r of four) {
      const res = await handleRequest(
        h.deps,
        h.req({ method: r.method, path: r.path, body: r.body, peer: LAN_PEER }),
      );
      expect(res.status, r.name).toBe(UNAUTHORIZED);
    }
    // 而且【四条都没写进去一行】：远程连一次申请都登记不上。
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });

  it("⭐ 反向对照：【同一发请求】从回环发出 ⇒ 不是 401", async () => {
    // 没有这一发，上面那四条 401 与「四条 handler 无条件抛 401」在绿屏上无法区分。
    const h = await harness({ verifier: VERIFIER });
    for (const r of four) {
      const res = await handleRequest(
        h.deps,
        h.req({ method: r.method, path: r.path, body: r.body }),
      );
      expect(res.status, r.name).not.toBe(UNAUTHORIZED);
    }
  });

  it("⭐ 非回环的答复与【鉴权失败】逐字同形（响应体不暴露「这里有一道回环门」）", async () => {
    // 两条不同的失败（签名不对 / 签名对但不在本机）必须给出【同一个】body。
    // 否则远程扫端点的人能靠响应体差异区分「路径存在且有门」与「压根没这条路由」，
    // 而那正是 route() 上面那段「未授权者看到的只有一种形状」在守的东西。
    const h = await harness({ verifier: VERIFIER });
    const unsigned = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/bindings", headers: {} }),
    );
    const remote = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/bindings", peer: LAN_PEER }),
    );
    expect(unsigned.status).toBe(UNAUTHORIZED);
    expect(remote.status).toBe(UNAUTHORIZED);
    expect(remote.body).toEqual(unsigned.body);
    expect(JSON.stringify(remote.body)).not.toMatch(/loopback|回环|bindings|peer/iu);
  });

  it("判据本身：assertLoopbackBindingRoute 对非回环交出一个可直发的响应", async () => {
    // 直接问那个函数，是因为端到端那一发【同时】测了 HMAC 与这道门；
    // 这里钉的是「门自己会拦」—— 撤掉门 ⇒ 这一发红，而端到端那一发可能还绿。
    // （与 mintToken 的「门二单独测」同一个道理。）
    const req = {
      method: "GET",
      path: "/bindings",
      target: "/bindings",
      query: {},
      headers: {},
      body: "",
      peer: LAN_PEER,
    } as HubRequest;
    const blocked = assertLoopbackBindingRoute(req);
    expect(blocked).not.toBeNull();
    expect(blocked?.status).toBe(UNAUTHORIZED);
    expect(assertLoopbackBindingRoute({ ...req, peer: "::ffff:127.0.0.1" })).toBeNull();
    expect(assertLoopbackBindingRoute({ ...req, peer: LOOPBACK_HOST })).toBeNull();
  });

  it("IPv6 回环与 IPv4-mapped 也算本机（不然桌面端换个栈就整条读不到）", async () => {
    const h = await harness({ verifier: VERIFIER });
    for (const peer of ["::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
      const res = await handleRequest(
        h.deps,
        h.req({ method: "GET", path: "/bindings", peer }),
      );
      expect(res.status, "peer " + peer).toBe(200);
    }
  });

  it("⭐ 判据不借默认值：peer 是必填的，四个 handler 都收 req 整体", () => {
    // 结构守卫。这一族判据一旦改成 `peer?: string` + 「缺省当回环」，
    // 失效方式是【下一个调用方忘了传 ⇒ 远程被当成本机】，静默。
    // 类型层面挡不住「有人加个 ?」，但能挡住【handler 签名不收 req】——
    // 不收 req 就拿不到 peer，那才是这道门消失的形状。
    for (const f of [listBindingsRoute, requestBindingRoute, verifyBindingRoute, rebindBindingRoute]) {
      expect(f.length, f.name).toBe(2);
    }
    // 并且这四个函数【不 import 那张表】：判据住在 bindings/im.ts，这里是入口。
    // （扫 src 的那条守卫在 test/bindings/im.test.ts，本文件只钉这四个。）
  });
});

/* ══════════════════ ⑦ 鉴权仍然在最前面 ══════════════════ */

describe("⑦ 回环门【不取代】HMAC", () => {
  it("回环对端但【没签名】⇒ 401（回环 ≠ 免鉴权）", async () => {
    // 这一发防的是把两条判据合成一条的写法：「回环就放行」看起来无害
    // （桌面端本来就在本机），而它让这台机器上【任何进程】都能改绑定 ——
    // 一个浏览器页面通过 DNS rebinding 打到 127.0.0.1 就是那个形状。
    const h = await harness({ verifier: VERIFIER });
    for (const r of [
      { method: "GET", path: "/bindings" },
      { method: "POST", path: "/bindings", body: bindingBody() },
    ]) {
      const res = await handleRequest(
        h.deps,
        h.req({ method: r.method, path: r.path, ...(r.body === undefined ? {} : { body: r.body }), headers: {} }),
      );
      expect(res.status, r.path).toBe(UNAUTHORIZED);
    }
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });

  it("签名签的是【别的路径】⇒ 401（签名覆盖路径，四条都是）", async () => {
    const h = await harness({ verifier: VERIFIER });
    const body = bindingBody();
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/bindings",
        body,
        headers: h.sign("POST", "/tasks", body),
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    expect(h.write.prepare("SELECT COUNT(*) AS c FROM im_bindings").get()).toEqual({ c: 0 });
  });
});
