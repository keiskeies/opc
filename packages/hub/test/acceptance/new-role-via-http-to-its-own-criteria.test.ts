/**
 * O8 的验收句，走【界面真用的那两条 HTTP 写入口】：
 * `POST /org` 提 `kind: "add_node"` 建一个角色 → `POST /charter/:roleId` 给它签一份
 * 岗位书 → hub:engine 把一个任务 handoff 给它 → 递给 harness 的那份提示词里
 * 出现【它自己的】那条验收标准。
 *
 * ── 这一发补的是哪一个缺口（与 new-role-to-its-own-criteria.test.ts 的分工）──
 * 仓里那份 O8 验收测试逐字走了同一句验收，但它的链条用的是【非界面路径】：
 *  · 第一跳提的是 `kind: "add_edge"`，新节点是随一条无关的 add_edge 带进库的
 *    （那份文件的文件头自己写着「旁路」）；
 *  · 第二跳是 CLI 播种器 `runSeedCli(["--db", ..., "--from", templateDir(...)])`。
 * 于是那份证明的是「播种过的岗位书 + 节点在图上 ⇒ 标准进提示词」；
 * 而【界面上 CEO 真点的两个写入口】—— `POST /org` 的带判据 add_node
 * （节点本身过 validateNewNode 六条，2026-11-18 入库）与 `POST /charter/:roleId`
 * （回环 + HMAC 的岗位书写入口，同批入库）—— 此前没有任何一条测试把这两个入口
 * 串进同一条 O8 链。本文件补的就是这一格。
 *
 * ── 反向对照是本文件存在的另一半理由 ────────────────────────────────
 * `translator` 与 `data` 走【同一条链】（同一个 add_node 形状、同一份夹具、同一个
 * 读者 rolePrompt），唯一的差别是：前者在第二跳从 HTTP 签了一份岗位书，后者没有。
 * 前者那一轮的提示词里有它自己那条哨兵标准，后者只有那句 NO_CHARTER_LINE。
 * 两发共用同一个 NO_CHARTER_LINE 常量，一收一放互为对照。
 *
 * ── 射程不含 ────────────────────────────────────────────────────────
 *  · 不覆盖 CLI 播种（runSeedCli 那条路由仓里另一份文件判）；
 *  · 不覆盖前端点击（本机无浏览器/Electron，界面那一格停在「app.js 发得出载荷」）；
 *  · 不覆盖验收标准被【门控】执行的形状（condition 如何把一份产出判成不合格属
 *    gates 那族的测试；这里只判「标准有没有随提示词到达角色」）；
 *  · 不覆盖远程通道：POST /charter 只认回环 + HMAC，非回环 401 属
 *    charter-route.test.ts 的射程。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/acceptance/new-role-via-http-to-its-own-criteria.test.ts
 */
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type CharterInput,
  HTTP_UNPROCESSABLE,
  type OrgGraph,
} from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_CHARTER_LINE } from "../../src/charter/prompt.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { approveCard, pendingCards } from "../../src/engine/approve.js";
import { ensureCharterCard } from "../../src/engine/charter.js";
import {
  makeDispatch,
  type RunTurnInput,
  type TurnOutcome,
} from "../../src/engine/dispatch.js";
import { makeRuntime } from "../../src/engine/runtime.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
} from "../../src/http/app.js";
import {
  NonceGuard,
  newLocalToken,
  signedHeaders,
} from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps, insertTask } from "../../src/http/real-deps.js";
import { NODE_TO_TEMPLATE } from "../../src/roles/preset.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("acceptance-new-role-http-criteria", import.meta.url);
const NOW = 1_700_000_000_000;
const SIGNED_TASK = "t-http-o8-signed";
const UNSIGNED_TASK = "t-http-o8-unsigned";
/** 第一跳建出来的两个新角色：一个签了岗位书，一个没签。 */
const SIGNED_ROLE = "translator";
const UNSIGNED_ROLE = "data";
/**
 * 哨兵串：只出现在【这一份】岗位书里。它进没进那份 prompt，就是第四跳的全部判据；
 * 把它换成任何别的串，那条断言照样只认「HTTP 写进去的那一份」（变异取证量的就是这格）。
 */
const CRITERION = "metric:unverified_translation_lines > 0";

/** TMP = `<hub>/.tmp/<名字>-<pid>` ⇒ 退两层是 packages/hub。 */
const HUB = join(TMP, "..", "..");
/** 反空转那发要【磁盘上的文件名】，不是这里再抄一份名单。 */
const REAL_TEMPLATES = join(HUB, "resources", "charter-templates");

const queues: WriteQueue[] = [];
let fileSeq = 0;

type Row = Record<string, unknown>;

/**
 * 起点组织图：`ceo ← intake ← director`，全带 model_family。
 * 与仓里那份 O8 测试同形状（那边文件头解释了为什么【没有 dev】：新角色要【加】出来）。
 */
function baseGraph(): OrgGraph {
  const node = (
    roleId: string,
    reportsTo: string | null,
    family: string,
    canManage = true,
  ): OrgGraph["nodes"][string] => ({
    role_id: roleId,
    can_manage: canManage,
    reports_to: reportsTo,
    model_family: family,
  });
  return {
    nodes: {
      ceo: node("ceo", null, "opus"),
      intake: node("intake", "ceo", "sonnet"),
      director: node("director", "intake", "gpt"),
    },
    edges: [
      { from: "director", to: "intake", review_gate: true },
      { from: "intake", to: "ceo", review_gate: true },
    ],
  };
}

/** 一份过 charterSchema、验收标准【已签】的岗位书（蛇形 CharterInput，不带占位串）。 */
const charterOf = (roleId: string, criterion: string): CharterInput => ({
  role_id: roleId,
  display_name: "翻译",
  version: 1,
  honesty_boundaries: ["不编造没有出处的一句译文"],
  acceptance_criteria: [
    {
      condition: criterion,
      action: "reject",
      message: "这一条是新角色自己的标准",
    },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 5, per_task_usd: 1 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: {
    type: "strict_rules",
    strict_rules: [],
    bounded_judgment: [],
    full_discretion: [],
  },
  escalation_triggers: [],
});

/** POST /charter/:roleId 的请求体形状（同 charter-route.test.ts 的 charterBody）。 */
const charterBody = (config: CharterInput, changeSummary: string): string =>
  JSON.stringify({ config, change_summary: changeSummary });

function newQ(name: string): { q: WriteQueue; path: string } {
  const path = join(TMP, name + "-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(q.writeConnection());
  return { q, path };
}

beforeAll(() => mkdirSync(TMP, { recursive: true }));
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

/**
 * 一份【真装配】的 Hub：buildHubDeps + 真 WriteQueue + 真 HMAC + 真备份（异步 worker）
 * + 真 commitOrgGraph + 真 charterWriter（岗位书写入口接的是同一个队列）。
 * 这里唯一替身是「这台夹具没在推任务」（driverState）。
 */
function hub(name: string): {
  readonly q: WriteQueue;
  readonly path: string;
  readonly deps: HubDeps;
  readonly req: (o: {
    method: string;
    path: string;
    body?: string;
  }) => HubRequest;
} {
  const { q, path } = newQ(name);
  const token = newLocalToken();
  const backupDir = join(TMP, "backup-" + name);
  mkdirSync(backupDir, { recursive: true });
  const deps = buildHubDeps({
    queue: q,
    bus: new InMemoryEventBus(),
    token,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
    nonces: new NonceGuard(),
    orgDbPath: path,
    orgBackupDir: backupDir,
  });
  return {
    q,
    path,
    deps,
    req: (o) => {
      const body = o.body ?? "";
      return {
        method: o.method,
        path: o.path,
        target: o.path,
        query: {},
        peer: LOOPBACK_HOST,
        body,
        headers: signedHeaders(token, {
          method: o.method,
          target: o.path,
          body,
          now: NOW,
        }),
      };
    },
  };
}

const latestGraph = (q: WriteQueue): OrgGraph => {
  const row = q
    .readConnection()
    .prepare(
      "SELECT graph_json FROM delegation_graphs ORDER BY version DESC LIMIT 1",
    )
    .get() as Row;
  return JSON.parse(String(row["graph_json"])) as OrgGraph;
};

/**
 * 一份【没接 charterWriter】的装配（其余与 hub() 同）。
 * 它是装配负对照那发的夹具：正题那发 POST /charter 拿到 200，靠的是 buildHubDeps
 * 真把队列接上了岗位书写入口 —— 那一行装配今天只有本文件这条链在读（变异取证 M5）。
 */
function unwiredHub(name: string): {
  readonly q: WriteQueue;
  readonly deps: HubDeps;
  readonly req: (o: {
    method: string;
    path: string;
    body?: string;
  }) => HubRequest;
} {
  const { q } = newQ(name);
  const token = newLocalToken();
  const deps: HubDeps = {
    db: q.readConnection(),
    bus: new InMemoryEventBus(),
    token,
    now: () => NOW,
    recordDecision: async () => true,
    createTask: async () => {},
    resumeGraph: async () => {},
    driverState: () => DRIVER_OFF,
  };
  return {
    q,
    deps,
    req: (o) => {
      const body = o.body ?? "";
      return {
        method: o.method,
        path: o.path,
        target: o.path,
        query: {},
        peer: LOOPBACK_HOST,
        body,
        headers: signedHeaders(token, {
          method: o.method,
          target: o.path,
          body,
          now: NOW,
        }),
      };
    },
  };
}

/**
 * 第三、四跳：把任务 handoff 给一个【不在 NODE_TO_TEMPLATE 里】的新角色，
 * 并把每一轮【引擎真的递给 harness 的那一份身份提示词】捕获下来。
 * 断言抓在捕获上而不是我自己去调 rolePrompt —— 那才是「它的提示词里出现」
 * 那句话的载体（走 dispatch → runTurn 那条真通道，--append-system-prompt 那一格）。
 */
async function runChainToRole(h: ReturnType<typeof hub>, roleId: string) {
  const taskId = roleId === SIGNED_ROLE ? SIGNED_TASK : UNSIGNED_TASK;
  await insertTask(h.q, {
    id: taskId,
    title: "把这份文档译成英文",
    assignedRole: "intake",
    nowMs: NOW,
  });
  const rt = makeRuntime({
    writer: h.q,
    bus: new InMemoryEventBus(),
    maxBudgetUsd: 0.5,
    taskLimitCents: 100_000,
    cwd: TMP,
    ceoRoleId: "ceo",
    nowMs: () => NOW,
  });
  const delivered: { role: string; rolePrompt: string }[] = [];
  let say: Record<string, unknown> = { action: "pass", summary: "还没轮到" };
  const dispatch = makeDispatch({
    ...rt.deps,
    runTurn: async (i: RunTurnInput): Promise<TurnOutcome> => {
      delivered.push({ role: i.role, rolePrompt: i.rolePrompt });
      return {
        ok: true,
        text: "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(say),
        costCents: 4,
        sessionId: "sess-1",
        error: null,
      };
    },
  });

  // 章程卡由生产写入方起草、CEO 用生产写路径点掉（同仓里那份 O8 文件的理由）。
  const card = await ensureCharterCard(
    h.q,
    { taskId, nowMs: NOW, maxBudgetUsd: 0.5 },
    {
      runTurn: async () => ({
        ok: true,
        text:
          "拟好。\n\n<<<OPC_DECISION>>>\n" +
          JSON.stringify({ action: "pass", summary: "章程五栏" }),
        costCents: 3,
        sessionId: "sess-0",
        error: null,
      }),
      rolePrompt: (r: string) => "你是 " + r + "。",
      ceoRoleId: "ceo",
      ...(rt.deps.onCost === undefined ? {} : { onCost: rt.deps.onCost }),
      publish: () => {},
    },
  );
  expect(card.outcome).toBe("drafted");
  const pending = pendingCards(h.q, taskId);
  expect(pending.length).toBe(1);
  const first = pending[0];
  if (first === undefined) throw new Error("上一句刚判过非空");
  const approved = await approveCard(
    h.q,
    { taskId, approvalId: first.id, button: "approve", nowMs: NOW + 1000 },
    () => {},
  );
  expect(approved.outcome).toBe("decided");

  const roleAt = (): string =>
    String(
      (
        h.q
          .readConnection()
          .prepare("SELECT assigned_role FROM tasks WHERE id = ?")
          .get(taskId) as Row
      )["assigned_role"],
    );

  // 三推：CHARTER_APPROVED 的 pass → DECOMPOSING 的 handoff → 新角色自己的那一轮。
  say = { action: "pass", summary: "章程已签" };
  const r1 = await dispatch({
    taskId,
    nowMs: NOW + 2000,
    maxBudgetUsd: 0.5,
  });
  expect(r1.moved, "拆解前一格没动：" + r1.note).toBe(true);
  say = { action: "handoff", to_role: roleId, summary: "这段交给它" };
  const r2 = await dispatch({
    taskId,
    nowMs: NOW + 2001,
    maxBudgetUsd: 0.5,
  });
  expect(r2.moved, "handoff 那一格没动：" + r2.note).toBe(true);
  // handoff 的落点就是新角色 —— 一个【不在 NODE_TO_TEMPLATE 里】的名字。
  expect(roleAt()).toBe(roleId);
  expect(Object.keys(NODE_TO_TEMPLATE)).not.toContain(roleId);

  say = { action: "pass", summary: "干完了" };
  const r3 = await dispatch({
    taskId,
    nowMs: NOW + 2002,
    maxBudgetUsd: 0.5,
  });
  expect(r3.moved, "新角色那一格没动：" + r3.note).toBe(true);

  return { delivered, rt };
}

/* ══════════ 前提与负对照：这一发的绿不能绿在名字撞车或装配白接上 ══════════ */

describe("前提与装配", () => {
  it("前提：`translator` / `data` 既不是模板名也不是预设节点名（否则「名字进图」会造假绿）", () => {
    // 这一发不是装饰。两条链的对照全靠「新角色名不在已播种的名字里」。
    // 哪天有人把 translator / data 加进模板目录或 NODE_TO_TEMPLATE，
    // 那条对照就悄悄变成「播过了而没读」，而它照绿 —— 红因登记在这里。
    const stems = readdirSync(REAL_TEMPLATES)
      .filter((f) => /\.ya?ml$/iu.test(f))
      .map((f) => f.replace(/\.ya?ml$/iu, ""));
    expect(stems.length).toBeGreaterThan(0);
    expect(stems).not.toContain(SIGNED_ROLE);
    expect(stems).not.toContain(UNSIGNED_ROLE);
    const presetNodes = Object.keys(NODE_TO_TEMPLATE);
    expect(presetNodes).not.toContain(SIGNED_ROLE);
    expect(presetNodes).not.toContain(UNSIGNED_ROLE);
    // 反向 canary：这份扫描【读得到磁盘】—— 取一个真存在的模板文件名必须数得中，
    // 换成一个不存在的名字必须数不出。空目录与扫不到在这里同形，所以钉两条。
    const real = readFileSync(join(REAL_TEMPLATES, "ceo.yaml"), "utf8");
    expect(real).toContain("role_id");
    expect(stems).toContain("ceo");
    expect(stems).not.toContain("ceo_not_a_real_template");
  });

  it("第一跳不是随便塞的入口：缺 model_family 的 add_node 在这条链上同样 422", async () => {
    // 正题那发的 200 只证明「合法节点进得来」；这一发证明它【不是无条件放行】：
    // 同一个 add_node 少声明那一格 ⇒ 同一个夹具给出 422 + 具体 code + 零新版本。
    const h = hub("http-nofamily");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: baseGraph(),
          change: {
            kind: "add_node",
            node: {
              role_id: SIGNED_ROLE,
              can_manage: false,
              reports_to: "director",
            },
          },
          change_summary: "加一个没声明模型家族的翻译角色",
        }),
      }),
    );
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((res.body as { code?: string }).code).toBe("unknown_model_family");
    expect(
      h.q
        .readConnection()
        .prepare("SELECT COUNT(*) AS n FROM delegation_graphs")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("装配负对照：没接 charterWriter ⇒ 同一份 POST /charter 得到 501 且库里零行", async () => {
    // 正题那发的第二跳拿到 200，绿因是 buildHubDeps 里那一行 `charterWriter: o.queue`。
    // 没有这一发，那个 200 与「装配根本没接、路由随手给了个成功」区分不开。
    const h = unwiredHub("http-unwired");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/charter/" + SIGNED_ROLE,
        body: charterBody(charterOf(SIGNED_ROLE, CRITERION), "装配负对照"),
      }),
    );
    expect(res.status).toBe(501);
    expect(JSON.stringify(res.body)).toContain("charterWriter");
    expect(
      h.q
        .readConnection()
        .prepare("SELECT COUNT(*) AS n FROM role_charters")
        .get(),
    ).toEqual({ n: 0 });
  });
});

/* ══════════ O8 四跳，全走界面真用的 HTTP 写入口 ══════════ */

describe("O8 走 HTTP：add_node → POST /charter → handoff → 提示词里有它自己的标准", () => {
  it("正题（HTTP 全链路）：signed 那一轮读到的是它自己那条哨兵标准，且不是别人的", async () => {
    const h = hub("http-signed");

    // ── 跳 1：POST /org 提 kind:"add_node"（界面「加角色」按钮那一条路）──
    // graph 是【变更前】那张图；after 由 commitOrgGraph 自己算（applyChangeToGraph）。
    const org = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: baseGraph(),
          change: {
            kind: "add_node",
            node: {
              role_id: SIGNED_ROLE,
              can_manage: false,
              reports_to: "director",
              model_family: "kimi",
            },
          },
          change_summary: "加一个翻译角色",
        }),
      }),
    );
    expect(org.status).toBe(200);
    const version = Number(
      (org.body as Record<string, unknown>)["graph_version"],
    );
    expect(version).toBe(1);
    const after = latestGraph(h.q);
    expect(Object.keys(after.nodes)).toContain(SIGNED_ROLE);
    expect(after.nodes[SIGNED_ROLE]).toEqual({
      role_id: SIGNED_ROLE,
      can_manage: false,
      reports_to: "director",
      model_family: "kimi",
    });
    // add_node 不带边：委派边一条都没多（那是另一次 add_edge、另过一次 L2）。
    expect(after.edges.length).toBe(2);

    // ── 跳 2：POST /charter/:roleId（界面写岗位书那个入口：回环 + HMAC）──
    // ⚠ 不是 runSeedCli —— 那正是这一发与仓里那份 O8 测试的分界。
    const charter = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/charter/" + SIGNED_ROLE,
        body: charterBody(
          charterOf(SIGNED_ROLE, CRITERION),
          "CEO 在界面上签的第一版",
        ),
      }),
    );
    expect(charter.status).toBe(200);
    expect(charter.body).toMatchObject({ ok: true, version: 1 });
    const row = h.q
      .readConnection()
      .prepare(
        "SELECT role_id, version, created_by FROM role_charters WHERE role_id = ?",
      )
      .get(SIGNED_ROLE) as Row;
    expect(row).toEqual({
      role_id: SIGNED_ROLE,
      version: 1,
      created_by: "ceo",
    });

    // ── 跳 3 + 跳 4：任务钉在跳 1 之后那张图上，handoff 过去，读捕获的 prompt ──
    const { delivered, rt } = await runChainToRole(h, SIGNED_ROLE);
    const pinned = Number(
      (
        h.q
          .readConnection()
          .prepare("SELECT graph_version FROM tasks WHERE id = ?")
          .get(SIGNED_TASK) as Row
      )["graph_version"],
    );
    // 任务看见的是【加了新角色之后】那张图（§18.4 的版本化提交在这一跳上是真的）。
    expect(pinned).toBe(version);
    // 前提自证：rolePrompt 这条通道本身是活的 —— intake（没签岗位书）读的是那句人事查无此人。
    expect(rt.deps.rolePrompt("intake")).toContain(NO_CHARTER_LINE);

    const mine = delivered.filter((d) => d.role === SIGNED_ROLE);
    // 先判【有过这一轮】：否则下面那几条会因为「压根没跑到」而假绿/假红分不清。
    expect(
      mine.length,
      "引擎没让新角色跑过一轮，第四跳无从判起",
    ).toBeGreaterThan(0);
    const withOwnCriterion = mine.find((d) => d.rolePrompt.includes(CRITERION));
    expect(
      withOwnCriterion,
      "新角色那一轮的提示词里没有它自己那条标准",
    ).not.toBeUndefined();
    // 口径也要对：condition 是【不合格的情形】，不是目标（否则标准进来了却被读反）。
    expect(withOwnCriterion?.rolePrompt).toContain("不合格的情形");
    // 渲染方向也钉一格：condition ⇒ 打回（message 在括号里），不是把标准当目标贴上。
    expect(withOwnCriterion?.rolePrompt).toContain(CRITERION + " ⇒ 打回");
    // 而且不是「随便一份岗位书」：那句「没有你的岗位书」必须不在。
    expect(withOwnCriterion?.rolePrompt).not.toContain(NO_CHARTER_LINE);
    // 对照到同一份捕获里：intake 那些轮【没有】这条标准 —— 它不是全局注入的。
    const others = delivered.filter((d) => d.role !== SIGNED_ROLE);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(o.rolePrompt).not.toContain(CRITERION);
  });

  it("反向对照（unsigned）：`data` 只走 add_node、没从 HTTP 签岗位书 ⇒ 那一轮只有 NO_CHARTER_LINE", async () => {
    // 与正题同一条链、同一个读者，差别只有「有没有从 HTTP 写入口给它签过一份岗位书」。
    // 这一发和正题的 not.toContain(NO_CHARTER_LINE) 共用同一个常量，互为对照。
    const h = hub("http-unsigned");
    const org = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: baseGraph(),
          change: {
            kind: "add_node",
            node: {
              role_id: UNSIGNED_ROLE,
              can_manage: false,
              reports_to: "director",
              model_family: "kimi",
            },
          },
          change_summary: "加一个数据角色，但【不】给它签岗位书",
        }),
      }),
    );
    expect(org.status).toBe(200);
    expect(Object.keys(latestGraph(h.q).nodes)).toContain(UNSIGNED_ROLE);
    // 「名字进了图」这件事确实成立 —— 这正是 O8 正文警告的那种假绿的【那一半】。
    expect(
      h.q
        .readConnection()
        .prepare("SELECT COUNT(*) AS c FROM role_charters WHERE role_id = ?")
        .get(UNSIGNED_ROLE),
    ).toEqual({ c: 0 });

    const { delivered } = await runChainToRole(h, UNSIGNED_ROLE);
    const mine = delivered.filter((d) => d.role === UNSIGNED_ROLE);
    expect(mine.length, "引擎没让 data 跑过一轮").toBeGreaterThan(0);
    for (const d of mine) {
      // 岗位书那一格是空的：不是「标准少一条」，是人事系统里查无此人。
      expect(d.rolePrompt).toContain(NO_CHARTER_LINE);
      expect(d.rolePrompt).not.toContain("不合格的情形");
      expect(d.rolePrompt).not.toContain(CRITERION);
    }
  });
});
