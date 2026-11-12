/**
 * Task 4.1 的 HTTP 层：签票与兑换这两条路由【对外开放的那一面】。
 *
 * ── 这个文件与 tokens.test.ts 的分工 ──────────────────────────────────
 * tokens.test.ts 测的是【判据】（一次/一张/过期/不可逆/库里存哈希），
 * 它直接调 tokens.ts 的纯函数，不碰 HTTP。本文件测的是【判据到状态码到响应体】
 * 那一段：同一条 `irreversible_denied`，判据在那一侧算得全对，
 * 翻成 401 仍然是错的产品行为（CEO 会去重签一张本来就有效的票）。
 *
 * ── 本文件最贵的一发是「签票对远程不可达」，以及它【只证到哪一步】 ──────
 * 签票路由上有【两道独立的门】：
 *    门一 remoteTokenAuth 里那句「只有 kind === 'decide' 允许靠 token 通过」；
 *    门二 mintToken 顶上那句 isLoopbackAddress(req.peer)。
 * 走 handleRequest 时，一个远程持票请求在【门一】就被弹掉，所以端到端测试
 * 【永远打不到门二】。我先写的就是那样一发：它绿了，而它测的是门一。
 *
 * ⚠ 我原本在文件头写的分工是「走 handleRequest 那一发挡有人改门一，
 * 直接调 mintToken 那一发挡有人改门二」。**三次变异把前半句证伪了**：
 *   M-A 只撤门二 ⇒ 2 红（那一发端到端的【照样绿】，如预期）
 *   M-B 只放宽门一（把白名单从 decide 扩到 decide+mint_token，
 *       正是 app.ts 里预言的「读收件箱时那一次很自然的改动」）⇒ 【18 全绿，0 红】
 *   M-C 两道门同时撤 ⇒ 3 红
 * 所以准确的分工是：**门二那一发挡「改门二」；端到端那一发只在【两道门都没了】时红；
 * 而「只改门一」这件事本文件（以及全仓）【测不出来】—— 它是被门二单独兜住的。**
 * 这个结论比原句子弱，而它是真的：门二存在的意义恰恰是「让改门一的人不必知道这里有依赖」，
 * 所以改门一【不该】有测试红 —— 有红反而说明两道门焊在一起了。
 * 我差点把「M-B 全绿」当成测试没写够而去补一发「门一确实拒 mint_token」的直调，
 * 那一发会把两道门焊成一条判据（正是 app.ts 那段论证反对的事）。
 * 记在这里，因为「能杀掉」与「知道自己哪里有守卫」是两件事（0026 §8 同族）。
 *
 * deps 上 redeem/issue 两个注入点接的是【真 tokens.ts + 真库】而不是替身 ——
 * 替身随手回一个自造字符串也能过，而那两个注入点的返回类型本轮刚从 string
 * 收窄成 TokenRejectReason / TokenIssueReject 联合（收窄才是本轮买到的东西）。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HTTP_CONFLICT } from "@opc/contracts";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import { migrate } from "../../src/db/migrate.js";
import {
  handleRequest,
  matchRoute,
  mintToken,
  tokenHttpStatus,
  tokenIssueStatus,
  type HubDeps,
  type HubRequest,
} from "../../src/http/app.js";
import { newLocalToken, signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import {
  hashToken,
  issueToken,
  newApprovalToken,
  precheckIssue,
  redeemToken,
  TOKEN_AUDIT_ACTOR,
} from "../../src/http/tokens.js";

const TMP = fixtureTmp("http-tokens-route", import.meta.url);

const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const NOW = 1_700_000_000_000;
const TOKEN = newLocalToken();
/** 一个【非回环】对端：同一 WiFi 上的手机就是这个形状。 */
const LAN_PEER = "192.168.1.7";
const TOKEN_HEADER = "x-opc-approval-token";
const DECIDE_BODY = JSON.stringify({ resume: "approve" });

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
let fileSeq = 0;

async function newDb(): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(join(TMP, "tr-" + process.pid + "-" + ++fileSeq + ".db")) as unknown as Db;
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES (?, ?, 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run("task-1", "远程审批路由用的任务", NOW, NOW);
  return db;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * 一张卡。type 与 parameters 两条维度都能填：§11.4 那一判有【三条】判据
 * （类型标记 / parameters.irreversible / parameters 解析不出来），
 * 而这三条在 HTTP 层应当给出【同一个】403 —— 少测一条，实现里少一条判据不会红。
 */
function card(db: Db, id: string, o: { type?: string; params?: string; status?: string } = {}): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
      "VALUES (?, ?, ?, '一句话摘要', ?, ?)",
  ).run(id, "task-1", o.type ?? "budget_override", o.params ?? "{}", o.status ?? "pending");
}

/** 签一张票（走签发函数本身，不走 HTTP），返回原文。 */
function mint(db: Db, approvalId: string): string {
  const raw = newApprovalToken();
  issueToken(db as never, { rawToken: raw, approvalId, nowMs: NOW });
  return raw;
}

function tokenRow(db: Db, raw: string): Row | undefined {
  return db
    .prepare("SELECT approval_id, used, expires_at FROM im_tokens WHERE token = ?")
    .get(hashToken(raw)) as Row | undefined;
}

function countTokens(db: Db): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS c FROM im_tokens").get() as { c: number | bigint }).c,
  );
}

/**
 * 一套 deps：两个注入点接真 tokens.ts + 真库。
 *
 * recordDecision 只报 true、不写库（真写库那条在 real-deps.test.ts 测）。
 * 因此本文件里凡出现 approvals.status 的断言，说的都是【这条路径没写库】，
 * 而不是「写库写错了」—— 别把这两件事读混。
 */
async function harness(nowMs = NOW): Promise<{
  deps: HubDeps;
  db: Db;
  req: (o: Partial<HubRequest> & { method: string; path: string }) => HubRequest;
  sign: (method: string, target: string, body?: string) => Record<string, string>;
}> {
  const db = await newDb();
  const deps: HubDeps = {
    db: db as unknown as DatabaseSync,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => nowMs,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    // 这台夹具扮演的是哪一台 Hub（HubDeps.driverState 必填的理由在那边）：一次性审批票那一条与驱动器无关；OFF 让「没有事件」这个前提在测试里是真的而不是碰巧。
    driverState: () => DRIVER_OFF,
    redeemApprovalToken: async ({ token, approvalId }) => {
      const r = redeemToken(db as never, {
        rawToken: token,
        nowMs,
        expectedApprovalId: approvalId,
      });
      return r.ok === true ? { ok: true, taskId: r.taskId } : { ok: false, reason: r.reason };
    },
    issueApprovalToken: async ({ approvalId, nowMs: issuedAt }) => {
      const pre = precheckIssue(db as never, approvalId);
      if (pre.ok !== true) return pre;
      // 与 real-deps.ts 那个包装同形：先 precheck、后 issue，且在【一次同步块】里
      // （真实现里是同一个 w.node 事务；这里没有写队列，窗口这一维由 real-deps 测）。
      const rawToken = newApprovalToken();
      const { expiresAt } = issueToken(db as never, { rawToken, approvalId, nowMs: issuedAt });
      return { ok: true, token: rawToken, expiresAt };
    },
  };
  const sign = (method: string, target: string, body = ""): Record<string, string> =>
    signedHeaders(TOKEN, { method, target, body, now: nowMs });
  return {
    deps,
    db,
    sign,
    req: (o) => {
      const body = o.body ?? "";
      return {
        query: {},
        body: "",
        ...o,
        target: o.path,
        // 默认本机（与 contract.test.ts 同一个立场：默认值省的是打字，不是判据；
        // 要测远程那一发必须【显式】传 peer）。
        peer: o.peer ?? LOOPBACK_HOST,
        headers: o.headers ?? sign(o.method, o.path, body),
      };
    },
  };
}

/** 直接调内层 handler 时的最小请求：那道门只读 peer，不读签名。 */
function rawReq(peer: string): HubRequest {
  return { method: "POST", path: "", target: "", query: {}, body: "", headers: {}, peer };
}

/* ───────────────────────── 签票：路由与可达性 ───────────────────────── */

describe("POST /approvals/:id/token 的路由与【远程不可达】", () => {
  it("三段那条匹配；两段那条不被抢走；空 id 段与多一段都不匹配", () => {
    expect(matchRoute("POST", "/approvals/a-1/token")?.kind).toBe("mint_token");
    // 反向对照在承重上：若三段那条写成 `segs[2] !== undefined` 之类的宽松判定，
    // 「批准」会被解成「签票」—— 一次点击把一次决策换成一张票，
    // 两边状态码都是 2xx，看板上看不出任何异常。
    expect(matchRoute("POST", "/approvals/a-1")?.kind).toBe("decide");
    expect(matchRoute("POST", "/approvals//token")).toBeNull();
    expect(matchRoute("GET", "/approvals/a-1/token")).toBeNull();
    expect(matchRoute("POST", "/approvals/a-1/token/extra")).toBeNull();
  });

  it("⭐ 本机 + HMAC ⇒ 201 拿到票，而库里那一行存的是【哈希】不是这个原文", async () => {
    const h = await harness();
    card(h.db, "A-1");
    const res = await handleRequest(h.deps, h.req({ method: "POST", path: "/approvals/A-1/token" }));
    expect(res.status).toBe(201);
    const body = res.body as { token: string; expires_at: number };
    expect(body.token.length).toBeGreaterThan(40);
    // TTL 由服务端定，不接受调用方传（那会静默放宽泄露窗口）。
    expect(body.expires_at).toBe(NOW + 10 * 60_000);
    // 响应里那个原文对到库里【按哈希】那一行；而按原文查必然查不到。
    // 这两句一起才是「备份里不含可用凭据」这条主张在这一层的形状。
    expect(tokenRow(h.db, body.token)).toEqual({
      approval_id: "A-1",
      used: 0,
      expires_at: NOW + 10 * 60_000,
    });
    expect(
      h.db.prepare("SELECT COUNT(*) AS c FROM im_tokens WHERE token = ?").get(body.token),
    ).toEqual({ c: 0 });
  });

  it("⭐ 远程对端【持有一张有效票】来签票 ⇒ 拒，且库里一张票都没多", async () => {
    const h = await harness();
    card(h.db, "A-1");
    const raw = mint(h.db, "A-1");
    const before = countTokens(h.db);

    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/A-1/token",
        peer: LAN_PEER,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    // 判据不在状态码，在【没多一张票】。「一张票换一张票」那个洞的全部后果
    // 是 TTL 失去意义（快过期时自己续一张），而每次 HTTP 层面都是个体面的 401。
    // ⚠ 这一发今天测到的是【门一】（它先弹掉请求）。M-C 实测：只有把两道门
    // 同时撤掉它才红，只撤门一时它不红（那次改动下门二仍挡住，行为没错）。
    // 所以别把它读成「这一发守着签票的远程边界」—— 守边界的是门二那一发，
    // 这一发守的是「远程持票人拿不到票」这个【产品性质】在端到端上成立。
    expect(countTokens(h.db)).toBe(before);
  });

  it("⭐【门二自己】能挡：直接调 mintToken，此时门一【不在场】", async () => {
    // 这一发刻意【不走】 handleRequest：走的话门一先把请求弹掉，
    // 于是这一发退化成上一发的重复，而门二被删掉也没人红（M-A 实测：
    // 撤掉门二后端到端那一发确实一字不动，只有这一发与紧邻那条 peer 分类红了）。
    // 文件名里那句「门二不存在」是我写错的反义词，本行已改成「门一不在场」——
    // 这一发做的正是【把门一从图里拿掉】这件事。
    const h = await harness();
    card(h.db, "A-2");
    const res = await mintToken(h.deps, "A-2", rawReq(LAN_PEER));
    expect(res.status).toBe(UNAUTHORIZED);
    expect(res.body).toEqual({ error: "unauthorized" });
    expect(countTokens(h.db)).toBe(0);
    // 反向对照：同一份 deps、同一张卡，只换 peer ⇒ 签得出来。
    // 少了这一发，上面那个 401 可能只是「这个 handler 恒回 401」。
    expect((await mintToken(h.deps, "A-2", rawReq(LOOPBACK_HOST))).status).toBe(201);
    expect(countTokens(h.db)).toBe(1);
  });

  it("127.0.0.2 / ::ffff:127.0.0.1 / ::1 都算本机；看着像的垃圾串不算", async () => {
    // 这一发挡的方向是【误杀之后的那条更糟的路】：判据若写成 peer === "127.0.0.1"，
    // 症状是「Hub 绑在 127.0.0.2 时桌面端签不出票」，排查指向手机与网络；
    // 而如果为了让 127.0.0.2 过就改成 startsWith("127.")，127.evil.com 会跟着过。
    // 判据本身（整段 127/8 + 先确认是合法四段）在 bind.test.ts，这里钉的是
    // 【签票这一发用的是同一发判据】，不是另一份字面量比较。
    const h = await harness();
    card(h.db, "A-3");
    for (const peer of ["127.0.0.2", "::ffff:127.0.0.1", "::1"]) {
      expect((await mintToken(h.deps, "A-3", rawReq(peer))).status, peer).toBe(201);
    }
    expect((await mintToken(h.deps, "A-3", rawReq("127.evil.com"))).status).toBe(UNAUTHORIZED);
    expect((await mintToken(h.deps, "A-3", rawReq("10.0.0.5"))).status).toBe(UNAUTHORIZED);
  });

  it("装配没接签发实现 ⇒ 501 而【不是】404：卡片在，缺的是服务端", async () => {
    const h = await harness();
    card(h.db, "A-4");
    const deps: HubDeps = { ...h.deps, issueApprovalToken: undefined };
    const res = await mintToken(deps, "A-4", rawReq(LOOPBACK_HOST));
    expect(res.status).toBe(501);
    // 404 会说「这张卡不存在」，而这张卡在 —— 那会把人支去检查自己的 id。
    expect(JSON.stringify(res.body)).not.toMatch(/not found/u);
  });

  it("签票的三种拒 ⇒ 404 / 409 / 403，且【一张票都不签】", async () => {
    const h = await harness();
    card(h.db, "A-pending");
    card(h.db, "A-decided", { status: "approved" });
    card(h.db, "A-irrev", { type: "irreversible_action" });

    expect((await mintToken(h.deps, "A-nope", rawReq(LOOPBACK_HOST))).status).toBe(404);

    const stale = await mintToken(h.deps, "A-decided", rawReq(LOOPBACK_HOST));
    expect(stale.status).toBe(HTTP_CONFLICT);
    // 409 的说法必须能被行动：「不是 pending」是给服务端的人看的，
    // 「已经有人批过了」才是给点界面的人看的。
    expect(JSON.stringify(stale.body)).toContain("已经不是待批状态");

    const irrev = await mintToken(h.deps, "A-irrev", rawReq(LOOPBACK_HOST));
    expect(irrev.status).toBe(FORBIDDEN);
    expect(JSON.stringify(irrev.body)).toContain("桌面端");

    expect(countTokens(h.db)).toBe(0);
    // 反向对照：同一次调用里那张干净的卡签得出来 ——
    // 否则上面三个状态码可能只是「mintToken 恒失败」的三种写法。
    expect((await mintToken(h.deps, "A-pending", rawReq(LOOPBACK_HOST))).status).toBe(201);
  });

  it("parameters 解析不出来的卡也算不可逆 ⇒ 403（判据复用兑换那一侧那一发）", async () => {
    // 三条判据里的第三条（脏 JSON ⇒ 判不出 ⇒ 算不可逆）在 HTTP 层的形状。
    // 这一发之所以单独列出来：如果签发侧「顺手」写一份自己的不可逆判据
    // （只看 approval_type），这一发会拿到 201 而上面那发仍然绿。
    const h = await harness();
    card(h.db, "A-dirty", { params: "{不是 JSON" });
    const res = await mintToken(h.deps, "A-dirty", rawReq(LOOPBACK_HOST));
    expect(res.status).toBe(FORBIDDEN);
    expect(countTokens(h.db)).toBe(0);
    // 反向：一张显式声明可逆的同类卡照常签得出 —— 证明那个 403 来自解析失败，
    // 不是来自「parameters 字段存在就拒」这种更懒的实现。
    card(h.db, "A-clean", { params: '{"irreversible":false}' });
    expect((await mintToken(h.deps, "A-clean", rawReq(LOOPBACK_HOST))).status).toBe(201);
  });
});

/* ─────────────────── 兑换：远程那条唯一的鉴权通路 ─────────────────── */

describe("远程靠一次性票批准：一条通路、一条写路径、一种状态码", () => {
  it("⭐ 有效票 ⇒ 决策落回【与桌面端同一个】 recordDecision，且【跳过了 HMAC】", async () => {
    const h = await harness();
    card(h.db, "B-1");
    const raw = mint(h.db, "B-1");
    // 【没有任何签名头】。若顺序是「先 HMAC、失败再试票」，票会先被烧掉再拿 401，
    // 那是本模块最贵的失效形状：两边的日志都读起来像「客户端忘了签名」，
    // 而真相是票已经消耗掉、决策也没做。
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/B-1",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(res.status).toBe(200);
    // 计划里那句「不得有第二条更弱的通道」在这一层的形状：远程那一支不自己写库，
    // 它落回 deps.recordDecision —— 桌面端那几发（contract.test.ts）断言的同一个注入点。
    expect(res.body).toEqual({ ok: true, replayed: false });
    // 这个 harness 的 recordDecision 是替身（不写库），所以这里钉的是
    // 【这条路径没有绕过它去改卡片】。
    expect(
      (h.db.prepare("SELECT status FROM approvals WHERE id = ?").get("B-1") as Row)["status"],
    ).toBe("pending");
    expect(tokenRow(h.db, raw)?.["used"]).toBe(1);
  });

  it("带了票却打在【别的端点】上 ⇒ 拒，而【票没被烧】", async () => {
    const h = await harness();
    card(h.db, "B-3");
    const raw = mint(h.db, "B-3");
    const res = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", peer: LAN_PEER, headers: { [TOKEN_HEADER]: raw } }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    // 这一发真正守的是【不烧票】与【不泄库】：拿票去读看板既不该消耗那张卡的
    // 正经批准机会，也不该让远程端读到任务列表（§20.3 授权出本机的只有「审批」）。
    expect(tokenRow(h.db, raw)?.["used"]).toBe(0);
    // 反向对照：换回正确的 URL，同一张票仍然有效。
    const ok = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/B-3",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(ok.status).toBe(200);
  });

  it("⭐ 带了票却打在别的端点上 ⇒ 拒的是【这一发】，不是「HMAC 反正会失败」", async () => {
    // 上一发证的是「票没被烧」。这一发证的是 app.ts 里那句
    // 「这一支【不能返回 null】—— 返回 null 的意思是交给 HMAC，
    // 结论同样是 401，可那是一次靠另一条路失败的正确」。
    // 要让那两种写法【在测试里长得不一样】，只有一个办法：给这一发配一份
    // 【真签名】。真签名在现实里代表「攻击者拿到了本机密钥」（不可能），
    // 但这一发要问的不是「他能不能签」，而是「挡住他的是哪一道」——
    // 带上真签名之后，「交给 HMAC」这一支会【放行】，于是两条路第一次能被分辨。
    const h = await harness();
    card(h.db, "B-5");
    const raw = mint(h.db, "B-5");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "GET",
        path: "/tasks",
        peer: LAN_PEER,
        headers: { ...h.sign("GET", "/tasks"), [TOKEN_HEADER]: raw },
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    // 反向对照（同一次调用里）：把票头拿掉，同样的签名 ⇒ 200。
    // 这一发是整条判据的分母 —— 少了它，上面那个 401 可能只是「远程签名验不过」。
    const noTicket = await handleRequest(
      h.deps,
      h.req({ method: "GET", path: "/tasks", peer: LAN_PEER, headers: h.sign("GET", "/tasks") }),
    );
    expect(noTicket.status).toBe(200);
    // ⚠ 上面这两句合起来读出的产品含义要说清：**一个远程对端只要持有本机 HMAC 密钥，
    // 就能靠「不带票」读到读端点，而带上票反而被拒。** 这不是漏洞，是
    // 「凭据不是候选列表，是两条互斥的路」那句话的直接后果（route() 那段注释），
    // 而它今天【不可达】的唯一理由是密钥不落盘。等哪天有「远程只读」需求时，
    // 这一发会逼着改动者重新读那段话 —— 这是它留在这里的第二个理由。
  });

  it("装配没接 token 存储 ⇒ 远程一律拒，而【不是靠「远程反正签不出」】", async () => {
    const h = await harness();
    card(h.db, "B-4");
    const deps: HubDeps = { ...h.deps, redeemApprovalToken: undefined };
    const res = await handleRequest(
      deps,
      h.req({
        method: "POST",
        path: "/approvals/B-4",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        // 带一个【真签名】。用真签名是这一发的要点：它让「退回 HMAC」那条歧路
        // 【真的能走通】，于是下面的 401 只能来自「没接 token 存储就拒」这条判据，
        // 而不是来自「远程签不出名」。少了这个签名，这一发是恒绿的装饰。
        headers: { ...h.sign("POST", "/approvals/B-4", DECIDE_BODY), [TOKEN_HEADER]: "x" },
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
  });

  it("不可逆卡在远程 ⇒ 403 + 一句人话；凭据那一族 ⇒ 401 且 body 里【连 reason 都没有】", async () => {
    const h = await harness();
    card(h.db, "B-irrev", { type: "irreversible_action" });
    const raw = mint(h.db, "B-irrev");
    const irrev = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/B-irrev",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(irrev.status).toBe(FORBIDDEN);
    expect(JSON.stringify(irrev.body)).toContain("桌面端");

    const bad = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/B-irrev",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: "a-token-we-never-issued" },
      }),
    );
    expect(bad.status).toBe(UNAUTHORIZED);
    // 「不区分失败原因」这条口径的可测形态就是这一句 toEqual：body 里不能有 reason。
    // 用 toEqual 而不是 toMatchNot 是因为「多一个字段」正是这类泄漏的唯一形状。
    expect(bad.body).toEqual({ error: "unauthorized" });
  });

  it("拿 A 的票去批 B ⇒ 拒，而【A 的票没被烧掉】", async () => {
    // 判据在 tokens.ts（不烧），这一发钉的是它在 HTTP 层的形状：
    // 「手机上点错卡片」不该连带把那张卡的正经批准机会一起烧掉 ——
    // 后果会是 CEO 必须回桌面端，而没有任何人会想到原因在这儿。
    const h = await harness();
    card(h.db, "C-1");
    card(h.db, "C-2");
    const raw = mint(h.db, "C-1");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/C-2",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(res.status).toBe(UNAUTHORIZED);
    expect(tokenRow(h.db, raw)?.["used"]).toBe(0);
    const ok = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/approvals/C-1",
        peer: LAN_PEER,
        body: DECIDE_BODY,
        headers: { [TOKEN_HEADER]: raw },
      }),
    );
    expect(ok.status).toBe(200);
  });
});

/* ───────────────────── 状态码：两张表，逐条钉 ───────────────────── */

describe("reason → 状态码：两张表各管一侧，因为「报错给谁看」不同", () => {
  it("兑换侧六条：一条 403（策略），五条 401（凭据）", () => {
    expect(tokenHttpStatus("irreversible_denied")).toBe(FORBIDDEN);
    for (const r of [
      "unknown_token",
      "expired",
      "already_used",
      "approval_mismatch",
      "approval_not_pending",
    ] as const) {
      expect(tokenHttpStatus(r), r).toBe(UNAUTHORIZED);
    }
    // 穷尽性由编译期那根 never 守卫管（漏一支编译不过）；这一发钉的是【取值方向】，
    // 表本身编译期管不了。最容易翻错的一格是 approval_not_pending：
    // 它讲的是卡片，看着像 404/409，而报错对象是一个手上只有 opaque 票的远程端。
    expect(tokenHttpStatus("approval_not_pending")).toBe(UNAUTHORIZED);
  });

  it("⭐ 签发侧三条：404 / 409 / 403，与兑换侧【只有 403 重合】", () => {
    expect(tokenIssueStatus("approval_missing")).toBe(404);
    expect(tokenIssueStatus("approval_not_pending")).toBe(HTTP_CONFLICT);
    expect(tokenIssueStatus("irreversible_denied")).toBe(FORBIDDEN);
    // 同一句 reason 在两张表里给出两个状态码，这是【刻意的】（分歧点是报错给谁看），
    // 所以这一发必须【同时】钉住两边 —— 只钉一边时，下一个人把它「统一」成 401
    // 就没人红，而那个看起来像修不一致的动作，实际是把「你点晚了」
    // 伪装成「你的凭据有问题」。
    expect(tokenHttpStatus("approval_not_pending")).toBe(UNAUTHORIZED);
    expect(tokenIssueStatus("approval_not_pending")).not.toBe(
      tokenHttpStatus("approval_not_pending"),
    );
  });

  it("⭐ 两张表都【没有兜底分支】：未知 reason 运行期也抛", () => {
    // 编译期那半（switch + never）由 tsc 管，这一发测的是运行期那半：
    // default 分支【真的抛】，而不是回一个兜底状态码。回兜底的那一版编译得过、
    // 测试也全绿，而它正是「新加的策略类理由静默落进 401」那条路 ——
    // 那一格的后果是 CEO 反复重签一张本来就有效的票。
    const fake = "some_brand_new_reason" as never;
    expect(() => tokenHttpStatus(fake)).toThrow(/没有登记状态码/u);
    expect(() => tokenIssueStatus(fake)).toThrow(/没有登记状态码/u);
    // 反向对照：合法值一律不抛 —— 否则上面的「抛」可能来自函数第一行。
    expect(() => tokenHttpStatus("expired")).not.toThrow();
    expect(() => tokenIssueStatus("approval_missing")).not.toThrow();
  });
});

describe("签票这件事不污染别处的统计", () => {
  it("烧票那行审计的署名不是 hub、也不是 ceo", () => {
    // 判据与那条链在 role-memory.ts（以及 memory 测试里那一发），这里钉的是
    // 【HTTP 这条链上没人顺手把署名改掉】。写 "hub" 会让这一行在每一次
    // 按署名查的统计里与建卡行混在一起 —— 那个「署名 OR 任务归属」的 OR
    // 是 0026 §5 那次翻案的源头。
    expect(TOKEN_AUDIT_ACTOR).toBe("approval-token");
    expect(TOKEN_AUDIT_ACTOR).not.toBe("hub");
    expect(TOKEN_AUDIT_ACTOR).not.toBe("ceo");
  });
});
