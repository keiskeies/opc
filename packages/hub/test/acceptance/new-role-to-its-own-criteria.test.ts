/**
 * O8 的验收句逐字走一遍：`POST /org` 加一个角色 → 播种它的岗位书 →
 * `hub:engine` 能把一个任务 handoff 给它 → 它的提示词里出现【它自己的】验收标准。
 *
 * ── 规格原话（docs/OPC-OS-功能优化设计.md 的 O8「验收」段）──────────────
 *  「一条端到端：POST /org 加一个角色 → 播种它的岗位书 → hub:engine 能把一个任务
 *   handoff 给它 → 它的提示词里出现它自己的验收标准。最后那半是【必须判的】，
 *   否则这条测试只证明「名字进了图」，而名字进图这件事今天的 preset 也能给。」
 *
 * ── 本轮量到的第一件事实：第一跳今天【走不通】，而它和空壳是两件事 ──────
 * 设计文档假设「CEO 在界面上加一个角色」这条写路径已经在了，缺的只是角色是空壳。
 * 逐字核过之后：**`POST /org` 提交不了一个新角色**（三条独立证据在 describe ①）。
 * 于是这条验收今天不可能全绿 —— 而它【该】红在第一跳，不是红在第四跳。
 * 那两格一直被人混成一句「O8 没做」，混在一起的代价是：以为补上播种就通了。
 *
 * ── round292 改口：上面那句仍然真，但【只】仍然真 ────────────────────────
 * round279 那三条证据里，③ 当时写着「两个前端零出口」并称它【原样成立】。
 * ⚡ round295 撤回这一句：那句是【假证人】，而且从写下那天起就是假的 ——
 * 控制室 `packages/web/public/app.js` 早在 2026-11-11 就真发 `kind: "reparent"`，
 * 而扫描口径只看了两个 `src` 根的 `.ts`/`.tsx`，看不见它（详见证据③那一发与
 * `FRONTEND_CORPUS` 的注释）。那一发现在翻向成【正向清单】。
 * ②「随一条无关的 add_edge 把一个没声明 model_family 的节点带进库」的旁路，
 * 现在被 `everyNodeDeclaresModelFamily` 拦成 422（提交前判，库里零残留）。
 * ⚠ 别把这一格读成「O8 第一跳通了」或「不能通过请求体加角色了」：
 * 请求体那张图【仍然】能让一个新节点落库，只要它声明了 model_family
 * —— 本文件那发反向 canary 钉的就是这个，否则「422」会被误读成
 * 「实现层替 CEO 关掉了'不改代码就能加角色'」，那不属于实现层的决定权。
 * 这一族在 round292 那天准确的形状是：**旁路还在，但它不再是【无判据】的旁路**。
 *
 * ── round294 再改口：① 那条【不再成立】，而它留下的是一枚假证人 ──────────
 * §7 第 18 格点名的修法（「给契约加一个【带判据的】add_node」）本轮落地了：
 * `orgChangeSchema` 有第三种 kind，节点本身过 `validateNewNode`（重名 / 自环 /
 * 上级不存在 / 上级不收汇报 / 深度 / 森林六条）。于是证据① 那一发【照样绿，而绿的原因换了】——
 * 它原来绿在「契约里没有 add_node」，现在绿在「缺 node 字段 + .strict()」。
 * 这就是本轮最该记下的一格：**一条断言在语义翻转后仍然返回绿，比一条红更贵**，
 * 因为它会让下一个人照着「只能走旁路」去设计。那一发已翻向，原文留在函数里。
 * ⚠ 旁路【没有被关掉】，射程与 round292 那一格完全一样：声明了家族的图片节点
 * 照样进库，多根的旁路图也照样进库（关掉它要的是「图必须等于 before 经 change
 * 得到」那条判据，本轮没做，登记在台账「没做的下一格」）。
 *
 * ── 反空转：为什么第二发比第一发更该读 ─────────────────────────────────
 * §7 第 6 格点过这一族：新角色的【名字若恰好等于某个模板文件名】，那条测试能过，
 * 而它绿在「名字进了图」。这里用两个角色把缝照出来：
 *  · `data` —— 名字进了图，但没给它签岗位书 ⇒ 提示词里是「hub 里【没有你的岗位书】」，
 *    验收标准一格都没有；
 *  · `translator` —— 同一条链、同一个读者，播种之后它自己那条标准进来了。
 * 差别只有「有没有给它签过一份岗位书」。那才是 O8 正文警告的东西。
 *
 * ── 跑法 ──────────────────────────────────────────────────────────────
 *   npx vitest run packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type CharterInput,
  HTTP_UNPROCESSABLE,
  type OrgGraph,
  orgChangeSchema,
  pathToRoot,
  violatesNoSelfReview,
} from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import { NO_CHARTER_LINE } from "../../src/charter/prompt.js";
import { runSeedCli } from "../../src/charter/seed.js";
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
import { EXIT_OK, EXIT_PROBLEM } from "../../src/heartbeat/maintenance.js";
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

const TMP = fixtureTmp("acceptance-new-role-criteria", import.meta.url);
const NOW = 1_700_000_000_000;
const TASK_ID = "t-newrole-1";

/** TMP = `<hub>/.tmp/<名字>-<pid>` ⇒ 退两层是 packages/hub。 */
const HUB = join(TMP, "..", "..");
/** 七份真模板的目录：反空转那两发要【磁盘上的文件名】，不是这里再抄一份名单。 */
const REAL_TEMPLATES = join(HUB, "resources", "charter-templates");
/**
 * 「有界面能加角色吗」要看的取材面。
 *
 * ⚠ 这张表是 round295 从一个【假证人】里挖出来的，别把它读成顺手补的两行配置。
 * 原来这里只有两个 `src` 根，下面那发只判「`add_edge` / `reparent` 零出现」并且【绿】，
 * 而 `packages/web/public/app.js` 从 2026-11-11 起就在真发 `kind: "reparent"`
 * （`git log -S` 追到 2bcbdb0）。漏的原因有【两个各自独立够用】的洞：
 *  ① 根少一个 —— 控制室在 `packages/web/public/`，不在 `packages/web/src/`；
 *  ② 扩展名少一种 —— 那里只有 `.js`，而筛的是 `.ts` / `.tsx`。
 * ⇒ 一条否定式主张（"零出现"）+ 一份看不见反例的取材 = 恒绿。
 * 更该记下的是：r15 那条【非空下限】当时是"现数"出来的（web=4 / desktop=7，
 * 合计 11 > 5，通过）—— **量过，但量的位置不含那件能推翻它的事**。
 * 所以本表把「数量下限」换成下面那发的【成员点名】：一个数过不了关，
 * 必须指名那个真发变更的文件在不在取材里。
 */
const FRONTEND_CORPUS: ReadonlyArray<{
  dir: string;
  exts: readonly string[];
}> = [
  { dir: join(HUB, "..", "web", "src"), exts: [".ts", ".tsx"] },
  { dir: join(HUB, "..", "web", "public"), exts: [".js", ".jsx"] },
  { dir: join(HUB, "..", "desktop", "src"), exts: [".ts", ".tsx"] },
];

/** 真控制室：那个【确实在发】组织变更的文件，成员点名用它。 */
const CONSOLE_JS = join(HUB, "..", "web", "public", "app.js");

type FrontendFile = { readonly path: string; readonly text: string };

/** 按上面那张表取材。表里任一根读不到 ⇒ 抛（不拿"零出现"冒充通过）。 */
function frontendFiles(): FrontendFile[] {
  const out: FrontendFile[] = [];
  for (const root of FRONTEND_CORPUS) {
    if (!existsSync(root.dir)) {
      throw new Error(
        "前端取材根不在了：" +
          root.dir +
          " —— 本发宁可直接抛，" +
          "也不拿【零出现】冒充『界面发不出组织变更』：根没了的时候零出现恒真。",
      );
    }
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!root.exts.some((x) => e.name.endsWith(x))) continue;
        out.push({ path: p, text: readFileSync(p, "utf8") });
      }
    };
    walk(root.dir);
  }
  return out;
}

/**
 * 谁在界面上发哪一种组织变更（正向清单，不是"零出现"）。
 *
 * kind 的【分母来自契约】而不是这里手抄：手抄一份的话，契约加第四种 kind 时
 * 这一发不会红，而界面漏一种没人知道（同 renderer-criteria.test.ts 那条
 * 「分母来自边表本身」的立场）。读不到 options ⇒ 抛，不静默给空集合。
 */
function orgKindsFromContract(): string[] {
  const u = orgChangeSchema as unknown as {
    options?: ReadonlyArray<{ shape?: { kind?: { value?: string } } }>;
  };
  const kinds = (u.options ?? [])
    .map((o) => o.shape?.kind?.value)
    .filter((k): k is string => typeof k === "string" && k.length > 0);
  if (kinds.length === 0) {
    throw new Error(
      "读不出 orgChangeSchema 的 kind 名单（zod 内部形状变了？）—— " +
        "空名单会让【谁都不发任何 kind】恒真，所以这里宁可不判也不判一个空的。",
    );
  }
  return kinds;
}

function emittersOf(files: readonly FrontendFile[], kind: string): string[] {
  const re = new RegExp(`["'\`]${kind}["'\`]`, "u");
  return files.filter((f) => re.test(f.text)).map((f) => f.path);
}

const queues: WriteQueue[] = [];
let fileSeq = 0;

type Row = Record<string, unknown>;

/**
 * 起点组织图：`ceo ← intake ← director`，全带 model_family。
 *
 * 与 idea-to-delivered 那张的差别只有一格：**这里没有 dev**。新角色要【加】出来，
 * 图上本来就有它的话，第一跳就没在判任何东西了。
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

/**
 * 请求体里那张「已经带上新角色」的图。
 *
 * `family` 可传空串：describe ① 那一发要的正是【没人问过它的家族】那种形状。
 */
function graphWith(roleId: string, family = "kimi"): OrgGraph {
  const g = baseGraph();
  return {
    nodes: {
      ...g.nodes,
      [roleId]: {
        role_id: roleId,
        can_manage: false,
        reports_to: "director",
        ...(family === "" ? {} : { model_family: family }),
      },
    },
    edges: [...g.edges, { from: roleId, to: "director", review_gate: true }],
  };
}

/** 一份过 charterSchema、验收标准【已签】的岗位书（不带占位串）。 */
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

function newQ(name: string): { q: WriteQueue; path: string } {
  const path = join(TMP, name + "-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(q.writeConnection());
  return { q, path };
}

/**
 * 写一个只含【一份】模板的目录。
 *
 * 不能用仓里那七份：它们全带 `CEO-PLACEHOLDER-ACCEPTANCE`（seed.ts 的占位串判据整次拒），
 * 而「替 CEO 把标准填上」正是本命令要拦的事（同 seed.test.ts 文件头那条纪律）。
 * ⚠ 文件名必须等于 role_id —— 播种有一条「文件名与 role_id 不一致」的判据。
 */
function templateDir(name: string, roleId: string, criterion: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, roleId + ".yaml"),
    stringifyYaml(charterOf(roleId, criterion)),
    "utf8",
  );
  return dir;
}

function captureIo(): {
  io: { write: (t: string) => void; error: (t: string) => void };
  out(): string;
  err(): string;
} {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: {
      write: (t) => o.push(t),
      error: (t) => e.push(t),
    },
    out: () => o.join(""),
    err: () => e.join(""),
  };
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
 * + 真 commitOrgGraph。这里唯一替身是「这台夹具没在推任务」（driverState）。
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

/* ══════════════ ① 第一跳：契约里有 add_node 了，round294 起它【带判据】 ══════════════ */

describe("① 第一跳（`POST /org` 加一个角色）：kind 有了，判据也有了（round294）", () => {
  it("证据①：契约里有「加节点」这一类变更，而它只收【一个完整节点】的形状", () => {
    // 【撤回】round279 这一发的原文与它当时的断言：
    //   「判别式 union 只认两种 kind；add_node 不是第三种（.strict() 挡着）」
    //   expect(orgChangeSchema.safeParse({kind:"add_node", role_id:"translator"}).success).toBe(false)
    // ⚠ 这一发在 round294 之后【照样是绿的】，而绿的原因换了 —— 它变成了一个假证人。
    //   现在拒它的是「缺 node 字段 + .strict()」，不是「没有这一类变更」。
    //   一个照样绿但绿在别的东西上的断言，比一条红更贵：它会让下一个人以为
    //   契约里还是没有 add_node，从而照着「只能走旁路」去做设计。本轮把它翻向，
    //   原文留在上面（0007 §4.1：撤回应可见，不是删掉）。
    // 正向：一个完整的节点 ⇒ 契约收（判它合法与否是 validateNewNode 的事，见证据④）。
    expect(
      orgChangeSchema.safeParse({
        kind: "add_node",
        node: {
          role_id: "translator",
          can_manage: false,
          reports_to: "director",
          model_family: "kimi",
        },
      }).success,
    ).toBe(true);
    // 反向①：本轮之前那种「扁平写法」（role_id 平铺在 change 上）仍然不收。
    // 这一格现在是【形状】的反向对照，不是【kind 存在性】的反向对照 —— 上面那段
    // 撤回说的就是这个差别；留着它是因为「形状收紧到只有一个 node」本身是一格判据：
    // 平铺会允许 role_id 与 node 里的 id 不一致，而那两个不一致能各自进不同的地方。
    expect(
      orgChangeSchema.safeParse({ kind: "add_node", role_id: "translator" })
        .success,
    ).toBe(false);
    // 反向②：add_node【不带边】。想「加节点顺带把委派边也画了」在这一类里写不出来。
    // 这不是省事，是 §8.2 第 4 条「门控绑在边上」在保存期的口径：一条边带着它的
    // 审阅门控，得单独过一次 L2（validateNewEdge），不能被一个 L1 的操作捎带。
    expect(
      orgChangeSchema.safeParse({
        kind: "add_node",
        node: {
          role_id: "translator",
          can_manage: false,
          reports_to: "director",
        },
        edge: { from: "translator", to: "director", review_gate: true },
      }).success,
    ).toBe(false);
    // 反向③：最像「加角色」的旧变体：在一条 add_edge 上【捎带】一个节点 —— 也过不了 schema。
    expect(
      orgChangeSchema.safeParse({
        kind: "add_edge",
        edge: { from: "translator", to: "director", review_gate: true },
        node: {
          role_id: "translator",
          can_manage: false,
          reports_to: "director",
        },
      }).success,
    ).toBe(false);
    // 反向对照：这两条本身是合法的（否则上面几条绿只是因为 schema 全拒）。
    expect(
      orgChangeSchema.safeParse({
        kind: "reparent",
        child_role: "director",
        new_parent_role: "ceo",
      }).success,
    ).toBe(true);
    expect(
      orgChangeSchema.safeParse({
        kind: "add_edge",
        edge: { from: "translator", to: "director", review_gate: true },
      }).success,
    ).toBe(true);
  });

  it("⭐ 证据②：同一条旁路现在被【节点级判据】拦下 —— 422、零新版本、库里没有那个节点", async () => {
    // 【撤回】round279 这一发的原文与断言：
    //   「把新节点塞在 graph 里随一条无关的 add_edge 提交 ⇒ 200 落库，而没有任何判据问过热节点」
    //   expect(res.status).toBe(200) / expect(Object.keys(after.nodes)).toContain("ghost")
    // 那句在那一天是【真的】，而 r15（test/arch/claims-registry.ts）的 method 末段
    // 把「给提交路径补上新节点的 model_family 校验 ⇒ 那条 200 变 422」登记成了
    // 【预定信号】而不是意外回归 —— 这一发红就是「该同步更新那条主张」的那一发。
    // round292 兑现的正是它，所以这里翻向断言，原文留在上面而不是静默删掉。
    const h = hub("smuggle");
    // 变更本身仍然合法且【与新节点无关】：director → ceo 一条新委派边。
    // 请求体那张图里额外多带一个 ghost 节点，且【不带 model_family】。
    const body = JSON.stringify({
      graph: graphWith("ghost", ""),
      change: {
        kind: "add_edge",
        edge: { from: "director", to: "ceo", review_gate: true },
      },
      change_summary: "加一条委派边，顺带把一个没配模型家族的角色带进组织",
    });
    const res = await handleRequest(
      h.deps,
      h.req({ method: "POST", path: "/org", body }),
    );

    // 它【被拒了】—— 判它的不是那条边（那条边与新节点无关、本身合法），
    // 而是「提交后那张图上每个节点都得声明 model_family」。
    expect(res.status).toBe(HTTP_UNPROCESSABLE);
    expect((res.body as { code?: string }).code).toBe("unknown_model_family");

    // 拒绝必须【什么都没留下】。这一发才是这一族真正要钉的性质：
    // 校验在开事务之前（commitOrgGraph 文件头那条顺序），所以既没有新版本、
    // 也没有半提交，更没有那条审计。
    // ⚠ 这里【不能】用 latestGraph()：它假定表里至少有一行（`.get()` 拿到
    //    undefined 就当场抛），而「一行都没有」正是本发要断言的东西。
    //    第一版就是直接调它，于是测试自己红在 TypeError 上 —— 红因与被测判据无关。
    const graphs = h.q
      .readConnection()
      .prepare("SELECT COUNT(*) AS n FROM delegation_graphs")
      .get() as Row;
    expect(graphs["n"]).toBe(0);
    expect(
      h.q.readConnection().prepare("SELECT COUNT(*) AS n FROM events").get(),
    ).toEqual({ n: 0 });

    // 保存期那条判据仍然会说这个节点不可用（round279 那半句【没有】过期，
    // 它当时证的从来不是「没人能判」，而是「提交路径没调用过它」）：
    const verdict = violatesNoSelfReview(
      "ghost",
      "director",
      graphWith("ghost", ""),
    );
    expect(verdict.ok).toBe(false);
  });

  it("⭐ 证据②的反向 canary：同一个请求体只补上 model_family ⇒ 200（拦的是那一维，不是「加节点」本身）", async () => {
    // 没有这一发，上面那条 422 只证明「现在凡是图里多带节点就拒」，
    // 而那与「补上了缺的那条判据」是两个完全不同的结论 —— 前者等于把 O8 的
    // 目标（不改代码就能加角色）直接判死，而本仓没有那个决定权（属 CEO）。
    // 所以必须有一发【只差 model_family】的请求拿到 200。
    const h = hub("smuggle-declared");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: graphWith("ghost", "kimi"),
          change: {
            kind: "add_edge",
            edge: { from: "director", to: "ceo", review_gate: true },
          },
          change_summary: "同一条委派边，但那个节点声明了模型家族",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(Object.keys(latestGraph(h.q).nodes)).toContain("ghost");
  });

  it("证据④ round294：`add_node` 走正经路【能】加出一个节点，且审计与库一致", async () => {
    // 这一发是本轮的正题：第一跳从此有一条【带判据的】路可走。
    // 它与证据②那条反向 canary 的区别是本轮全部的射程：
    //  · 反向 canary 走的是旁路（请求体图里塞节点 + 一条与它无关的 add_edge），
    //    那条路只被 model_family 那一格问过；
    //  · 这一发走的是 add_node，节点本身被 validateNewNode 逐条问过。
    const h = hub("add-node-ok");
    const res = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          // before 图【不含】translator —— add_node 的 graph 是【变更前】那张图，
          // 变更后那张由 commitOrgGraph 自己算（见 applyChangeToGraph 函数头）。
          graph: baseGraph(),
          change: {
            kind: "add_node",
            node: {
              role_id: "translator",
              can_manage: false,
              reports_to: "director",
              model_family: "kimi",
            },
          },
          change_summary: "加一个翻译角色",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const after = latestGraph(h.q);
    expect(Object.keys(after.nodes)).toContain("translator");
    expect(after.nodes["translator"]).toEqual({
      role_id: "translator",
      can_manage: false,
      reports_to: "director",
      model_family: "kimi",
    });
    // 边【一条没多】：add_node 故意不带边，所以「加完节点顺手画一条委派边」
    // 在这条路上做不到（那是另一次 add_edge，另过一次 L2）。
    expect(after.edges.length).toBe(2);
    // 版本确实前进了，而审计那条读到的 after 与库里这张【是同一个值】。
    // 快照在 events.state_snapshot（不在某个专门的审计表里 —— appendAudit 写的是
    // events，§5.8「events 是事实源」）。before/after 都在那一个 JSON 里。
    // ⚠ 这里【不能】图省事写 `expect(JSON.parse(x)).toEqual(after)` 之外再补一个
    //    自己跟自己相等的断言：那种断言双向恒真，它只证明 JSON 序列化不改变对象。
    // events 的主键列叫 id（0001_init.sql:56），不叫 seq —— appendAudit 返回的那个
    // 值叫 seq，而它是 events.id。第一版我按变量名写了 ORDER BY seq，拿到的是
    // "no such column" 而不是断言失败 —— 红在一个拼错上，与被测判据无关。
    const audit = h.q
      .readConnection()
      .prepare("SELECT state_snapshot FROM events ORDER BY id")
      .all() as Row[];
    expect(audit).toHaveLength(1);
    // `?.` 不是摆设：`noUncheckedIndexedAccess` 下 `audit[0]` 的类型是 `Row | undefined`
    // （测试语料的类型棘轮为此单独红过一发）。缺行时 `String(undefined)` = "undefined"
    // ⇒ JSON.parse 抛 —— 那是【响】而不是静默，且上一发 toHaveLength(1) 已经先红并点名了。
    const snap = JSON.parse(String(audit[0]?.["state_snapshot"])) as {
      before: OrgGraph;
      after: OrgGraph;
    };
    expect(snap.after).toEqual(after);
    expect(snap.before).toEqual(baseGraph());
    // add_node 之后新角色的 reports_to 变了（从「不存在」到 director），所以它落在
    // commitOrgGraph 那句 `changed` 里 —— 但它【没有】上一版岗位书 ⇒ 跳过而不是造一份
    // （0008 §7：验收标准那些字段属 CEO，实现层代笔就是伪证）。这一格钉住它没被造出来。
    expect(
      h.q
        .readConnection()
        .prepare("SELECT COUNT(*) AS n FROM role_charters")
        .get(),
    ).toEqual({ n: 0 });
  });

  it("⭐ 证据④的六条拒绝：每种坏形状 422 + 对的 code + 库里零残留（零新版本、零审计）", async () => {
    // 为什么逐条列 code 而不是只断 422：422 是「有人拒了」，code 才是「谁拒的」。
    // 只断状态码的话，一条「上级不存在」被误判成「重名」照样绿，而前端要按 code
    // 决定回弹还是弹一句「这个角色已经在了」（§18.2 的 D/E 就是这个区分）。
    // `pad` = 这一发【先成功提交】几次 add_node 造出前提形状，再让最后那次被拒。
    // 为什么必须有 pad 而不是往夹具里写节点：一次 add_node 只加【一个】叶子节点，
    // 于是「超深」「上级不能收汇报」这两种形状【不可能】只靠一条非法请求到达 ——
    // 它们的前置层得由真提交垫出来。垫在夹具里 = 判据没在真提交路径上被验过。
    // ⚠ 我第一版就是那么写的：先是"夹具里给一个 l5"，又断言 director 的
    //   can_manage=false —— 而 baseGraph 那个 helper 的 canManage 默认 true。
    //   第二条被下面那三行前提自证当场抓出来（它红的顺序在判据之前，那正是它
    //   存在的理由）。第一条抓不出来：往夹具里塞节点【不会】有任何东西变红，
    //   它换来的绿与"判据在真路径上通过"长得一模一样 —— 所以形状改成了 pad。
    type Pad = readonly (readonly [
      id: string,
      parent: string,
      canManage: boolean,
    ])[];
    const cases: {
      name: string;
      node: { role_id: string } & Record<string, unknown>;
      code: string;
      pad?: Pad;
    }[] = [
      {
        name: "重名",
        node: {
          role_id: "director",
          can_manage: false,
          reports_to: "ceo",
          model_family: "kimi",
        },
        code: "role_exists",
      },
      {
        name: "自环",
        node: {
          role_id: "loop",
          can_manage: false,
          reports_to: "loop",
          model_family: "kimi",
        },
        code: "would_create_cycle",
      },
      {
        name: "上级不存在",
        node: {
          role_id: "orphan",
          can_manage: false,
          reports_to: "nobody",
          model_family: "kimi",
        },
        code: "unknown_role",
      },
      {
        name: "上级不是管理角色",
        pad: [["leaf_mgr_off", "director", false]],
        node: {
          role_id: "under_non_manager",
          can_manage: false,
          reports_to: "leaf_mgr_off",
          model_family: "kimi",
        },
        code: "parent_not_manager",
      },
      {
        // 起点图最深是 director（第 3 层）⇒ 垫三层到第 5 层，再往上挂一个 = 第 6 层
        // = ORG_MAX_DEPTH + 1 ⇒ 拒。（垫链的每一步自己都得合法，否则红的是垫链。
        // 前提见下面那句 pathToRoot —— 差一层【恰好不触发】这条判据。）
        name: "深度超限",
        pad: [
          ["l3", "intake", true],
          ["l4", "l3", true],
          ["l5", "l4", true],
        ],
        node: {
          role_id: "deep",
          can_manage: false,
          reports_to: "l5",
          model_family: "kimi",
        },
        code: "depth_exceeded",
      },
      {
        name: "多出一个根（森林）",
        node: {
          role_id: "second_root",
          can_manage: true,
          reports_to: null,
          model_family: "kimi",
        },
        code: "multiple_roots",
      },
    ];
    // 前提自证：这一族的几条 code 全靠夹具那几格形状，先把它们钉下来。
    // 少了这一段，"上级不是管理角色"会绿在一个【其实不存在】的前提上，
    // 而"深度超限"可能绿在「起点图本来就比我以为的深一层」上 ——
    // 两种绿都不是那条判据在起作用。
    expect(baseGraph().nodes["director"]?.can_manage).toBe(true);
    expect(pathToRoot(baseGraph(), "intake").length).toBe(2);
    expect(pathToRoot(baseGraph(), "director").length).toBe(3);
    for (const c of cases) {
      const h = hub("add-node-reject");
      let graph = baseGraph();
      for (const [id, parent, canManage] of c.pad ?? []) {
        const pad = await handleRequest(
          h.deps,
          h.req({
            method: "POST",
            path: "/org",
            body: JSON.stringify({
              graph,
              change: {
                kind: "add_node",
                node: {
                  role_id: id,
                  can_manage: canManage,
                  reports_to: parent,
                  model_family: "kimi",
                },
              },
              change_summary: "垫一层，为" + c.name + "这条拒绝做前提",
            }),
          }),
        );
        expect(pad.status, "垫链那一步 " + id).toBe(200);
        graph = latestGraph(h.q);
      }
      if (c.code === "depth_exceeded") {
        // 垫完后再钉一次深度：差一层【恰好不触发】深度判据 ⇒ 少这一句就是假绿。
        expect(pathToRoot(graph, "l5").length).toBe(5);
      }
      if (c.code === "parent_not_manager") {
        expect(graph.nodes["leaf_mgr_off"]?.can_manage).toBe(false);
      }
      const res = await handleRequest(
        h.deps,
        h.req({
          method: "POST",
          path: "/org",
          body: JSON.stringify({
            graph,
            change: { kind: "add_node", node: c.node },
            change_summary: c.name,
          }),
        }),
      );
      expect(res.status, c.name).toBe(HTTP_UNPROCESSABLE);
      expect((res.body as { code?: string }).code, c.name).toBe(c.code);
      // 拒绝必须【什么都没留下】：这一族共享的是同一条性质（校验在开事务之前）。
      // 逐条查表，不查一次代表全部。
      // ⚠ 有 pad 的那些发【本来就有】几次成功提交 ⇒ 期望值是【那几次】而不是 0。
      // 写成 0 会让它红在夹具上；写成"至少 pad 次"则正是「被拒那次也留了一行」
      // 会被放过的写法 —— 所以是精确相等。
      const expectRows = (c.pad ?? []).length;
      expect(
        h.q
          .readConnection()
          .prepare("SELECT COUNT(*) AS n FROM delegation_graphs")
          .get(),
        c.name + " 留了新版本",
      ).toEqual({ n: expectRows });
      expect(
        h.q.readConnection().prepare("SELECT COUNT(*) AS n FROM events").get(),
        c.name + " 留了审计（组织审计写在 events，不是单独的表）",
      ).toEqual({ n: expectRows });
      // 且【被拒那一次】没有改动图：有 pad 的那些发，最新那张图必须【逐字等于】
      // 请求里那张 before（一次被拒的提交连一个节点都不该添）。
      // 为什么不用「图上不含那个 role_id」：重名那一发的 role_id 本来就在图上
      //（那正是它被拒的理由），那条断言对它是恒假的，而我会把它写成跳过 ——
      // 一写跳过就等于这一族里最容易被误写的那一发不判了。
      // 「最新图 === 请求图」对【全部六条】都判，且判的是更强的性质。
      // ⚠ 没有 pad 的那些发【不能】调 latestGraph()：它在表里一行都没有时当场
      //    TypeError（`.get()` 拿到 undefined）。上面 count 那两条已经断过「零行」，
      //    这里按同一个条件分支即可。本文件为这个坑写过一次注释，我又踩了一次 ——
      //    那条教训当时只写在【那一发】旁边，没写进 helper 的函数头。
      if (expectRows > 0) {
        expect(latestGraph(h.q)).toEqual(graph);
      }
    }
  });

  it("⭐ 证据④的反向 canary：缺 model_family 的 add_node 仍然 422，但判它的是【继承】那一格", async () => {
    // validateNewNode 故意不判 model_family（同一件事两处口径会漂）。
    // 所以这一格的 code 必须是 unknown_model_family —— 来自 everyNodeDeclaresModelFamily
    // 判【整张 after 图】那一条，不是本轮新写的判据。
    // 如果哪天有人图省事在 validateNewNode 里也判一遍家族，这一发仍然绿，
    // 而 r22 的判据会红：它读的是 validate.ts 里【没有】家族那两条 code。
    const h = hub("add-node-no-family");
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
              role_id: "translator",
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
  });

  it("证据③（round308 翻向）：三种 kind 界面都发得出，发的人只有 app.js", () => {
    // ── 这一发【原来】写的是「两个前端里 add_edge / reparent 零出现」，并且绿 ──
    // 那句是假的，而且不是"过期"：`packages/web/public/app.js` 从 2026-11-11 起
    // 就在真发 `kind: "reparent"`（`git log -S` 追到 2bcbdb0，本轮实测 HEAD 版第 932 行）。
    // 它绿着替那句假话作证了六轮，因为扫描口径看不见 app.js（根少一个 + 扩展名少一种，
    // 见 FRONTEND_CORPUS 的注释）。⇒ 一条否定式主张不能只补取材就留着：
    // 补完取材它就该红在这里。红一次才知道口径修好了，所以本轮把它【翻向】。
    //
    // 形状换成【正向清单】：每种 kind 各自数出发它的文件，名单逐字钉住。
    // 与旧写法的分别不是"能不能加戏"，是【加戏会不会响】——
    // 「零出现」在有人把 add_edge 接上界面时红，而 reparent 那天它【不会】红
    // （它早已红过一次的形状，只是没人看见）；正向名单在任一种 kind 的名单变化时都红。
    const files = frontendFiles();
    const kinds = orgKindsFromContract();
    const emitters = Object.fromEntries(
      kinds.map((k) => [k, emittersOf(files, k)]),
    );
    // 期望值用 CONSOLE_JS（模块级那个定义）而不是抄字符串：`join` 把 `..`
    // 归一掉了，所以它与 walk 走出来的那一个【逐字相同】，换机器也不用改。
    const consolePath = CONSOLE_JS;

    // ① 逐 kind 的名单。改这一行之前先想清楚：让界面上多一种能发的变更，
    //    是产品决定（O8 第一跳那一格），不是测试顺手放宽的事。
    // 【round308 换成了三份名单 —— 那一次产品决定真的发生了】
    // O8 正文与 §5.1 那张表（Task 3.8 → O8「组织可编辑」）要的就是界面上改得动组织，
    // 而 round294 已经给契约补上带判据的 add_node：界面发不出它，缺的是前端那一格，
    // 不是 CEO 的闸门。所以这里不是【放宽】，是【照实】。
    // ⚠ 仍然不叫「O8 第一跳通了」：加进图的角色【没有岗位书】，
    // 它那一格由本文件 ② 段那两发（data / translator）判 —— 名字进图 ≠ 它有验收标准。
    expect(emitters).toEqual({
      reparent: [consolePath],
      add_edge: [consolePath],
      add_node: [consolePath],
    });

    // ② 前提自证：那个"真发变更的文件"【在取材里】。少了这一发，
    //    上面那个 toEqual 会因为【看不见 app.js】而把 reparent 数成空 ——
    //    那是把本轮刚犯过的错原样重新装上，而它照样绿。
    const paths = files.map((f) => f.path);
    expect(paths).toContain(consolePath);
    // 反向：取材里【确实】有一个文件写着 reparent，而不是"名单恰好等于名单"。
    expect(emittersOf(files, "reparent")).toHaveLength(1);

    // ③ 反向 canary：扫描器【读得到 app.js 的字节】。
    //    这一发测的是 emittersOf 而不是产品 —— 拿真文件的一段真字节造一个
    //    【不存在】的 kind，必须数不出东西；换成 reparent 必须数出那一份。
    //    没有它，`emittersOf` 写成 `files.filter(() => false)` 也能让 ① 的
    //    两格空名单绿（本轮登记的那一族：空集合与"没有"同形）。
    const consoleText = readFileSync(consolePath, "utf8");
    const corpus = [{ path: consolePath, text: consoleText }];
    expect(emittersOf(corpus, "reparent")).toEqual([consolePath]);
    expect(emittersOf(corpus, "reparent_not_a_real_kind")).toEqual([]);
    // 引号形状也算：`kind: reparent`（无引号）是标识符不是变更名，不该数成发它。
    expect(
      emittersOf(
        [{ path: consolePath, text: "const reparent = 1;" }],
        "reparent",
      ),
    ).toEqual([]);

    // ④ 「构造了载荷」不等于「发得出去」。本机没有浏览器也没有 Electron（0039），
    //    做不到真在浏览器里点一次，所以这里退到【最接近的那格】：请求那一行还在。
    //    ⚠ 射程：它不证明那次 POST 在浏览器里跑通过 —— 那属 Task 4.7 那一格。
    //    少了这一发，「把 api("POST", "/org") 那一调用注释掉」不改变上面任何一条，
    //    而这一发会响（变异 M2 量的就是这一格）。
    //    读的是上面 ③ 那份 consoleText：同一份字节，两发共用（再 readFileSync
    //    一次会多一个同名 const，而那个 const 重名在 vitest 里是【装载期解析错】——
    //    本轮撞过：整份文件报 Transform failed，而摘要行仍然报「红发 0」）。
    expect(consoleText).toContain('api("POST", "/org"');
  });
});

/* ══════════════ ② 节点已在图上之后：那三跳是真的走得通 ══════════════ */

describe("② 播种 → handoff → 提示词里有它自己的验收标准（前提：节点已在图上）", () => {
  const NEW_ROLE = "translator";
  const CRITERION = "metric:unverified_translation_lines > 0";

  it("正题：org 提交 + 播种之后，派给它的【那一轮】拿到的就是它自己那条标准", async () => {
    const h = hub("main");

    // ── 跳 1（可用形状）：新角色作为图的一部分提交，配一条带门控的委派边 ──
    // 这是 orgChangeSchema 允许的最接近「加一个角色」的写法。它是否等价于加角色，
    // 由上面 describe ① 判 —— 这一发只负责用【生产写路径】做出「节点在图上」这个前提。
    const post = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: graphWith(NEW_ROLE),
          change: {
            kind: "add_edge",
            edge: { from: NEW_ROLE, to: "director", review_gate: true },
          },
          change_summary: "新加一个翻译角色，产出交 director 审",
        }),
      }),
    );
    expect(post.status).toBe(200);
    const version = Number(
      (post.body as Record<string, unknown>)["graph_version"],
    );
    expect(version).toBe(1);

    // ── 跳 2：播种它的岗位书（真 CLI、真库、退 0）──────────────────────
    const io = captureIo();
    const seeded = await runSeedCli(
      ["--db", h.path, "--from", templateDir("signed", NEW_ROLE, CRITERION)],
      io.io,
    );
    expect(seeded.code, io.err()).toBe(EXIT_OK);
    expect(
      Number(
        (
          h.q
            .readConnection()
            .prepare(
              "SELECT COUNT(*) AS c FROM role_charters WHERE role_id = ?",
            )
            .get(NEW_ROLE) as Row
        )["c"],
      ),
    ).toBe(1);

    // ── 跳 3：新任务钉在【提交后】那张图，引擎把活 handoff 给这个非预设角色 ──
    await insertTask(h.q, {
      id: TASK_ID,
      title: "把这份文档译成英文",
      assignedRole: "intake",
      nowMs: NOW,
    });
    const pinned = Number(
      (
        h.q
          .readConnection()
          .prepare("SELECT graph_version FROM tasks WHERE id = ?")
          .get(TASK_ID) as Row
      )["graph_version"],
    );
    // 任务看见的是【加了新角色之后】那张图（§18.4 的版本化提交在这一跳上是真的）。
    expect(pinned).toBe(version);

    const rt = makeRuntime({
      writer: h.q,
      bus: new InMemoryEventBus(),
      maxBudgetUsd: 0.5,
      taskLimitCents: 100_000,
      cwd: TMP,
      evidenceRoot: TMP + "/artifacts",
      ceoRoleId: "ceo",
      nowMs: () => NOW,
    });

    /**
     * 每一轮【引擎真的递给 harness 的那一份身份提示词】。
     * 断言抓在这里而不是我自己去调 rolePrompt —— 那才是「它的提示词里出现」那句话的
     * 载体：走的是 dispatch → runTurn 那条真通道（--append-system-prompt 那一格）。
     */
    const delivered: { role: string; status: string; rolePrompt: string }[] =
      [];
    let say: Record<string, unknown> = { action: "pass", summary: "还没轮到" };
    const dispatch = makeDispatch({
      ...rt.deps,
      runTurn: async (i: RunTurnInput): Promise<TurnOutcome> => {
        delivered.push({ role: i.role, status: "", rolePrompt: i.rolePrompt });
        return {
          ok: true,
          text: "干完了。\n\n<<<OPC_DECISION>>>\n" + JSON.stringify(say),
          costCents: 4,
          sessionId: "sess-1",
          error: null,
        };
      },
    });

    // 章程卡由生产写入方起草、CEO 用生产写路径点掉（同 idea-to-delivered 的理由）。
    const card = await ensureCharterCard(
      h.q,
      { taskId: TASK_ID, nowMs: NOW, maxBudgetUsd: 0.5 },
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
        rolePrompt: (roleId: string) => "你是 " + roleId + "。",
        ceoRoleId: "ceo",
        ...(rt.deps.onCost === undefined ? {} : { onCost: rt.deps.onCost }),
        publish: () => {},
      },
    );
    expect(card.outcome).toBe("drafted");
    const pending = pendingCards(h.q, TASK_ID);
    expect(pending.length).toBe(1);
    const first = pending[0];
    if (first === undefined) throw new Error("上一句刚判过非空");
    const approved = await approveCard(
      h.q,
      {
        taskId: TASK_ID,
        approvalId: first.id,
        button: "approve",
        nowMs: NOW + 1000,
      },
      () => {},
    );
    expect(approved.outcome).toBe("decided");

    const roleAt = (): string =>
      String(
        (
          h.q
            .readConnection()
            .prepare("SELECT assigned_role FROM tasks WHERE id = ?")
            .get(TASK_ID) as Row
        )["assigned_role"],
      );

    // 三推：CHARTER_APPROVED 的 pass → DECOMPOSING 的 handoff → 新角色自己的那一轮。
    say = { action: "pass", summary: "章程已签" };
    const r1 = await dispatch({
      taskId: TASK_ID,
      nowMs: NOW + 2000,
      maxBudgetUsd: 0.5,
    });
    expect(r1.moved, "拆解前一格没动：" + r1.note).toBe(true);
    say = { action: "handoff", to_role: NEW_ROLE, summary: "这段交给翻译" };
    const r2 = await dispatch({
      taskId: TASK_ID,
      nowMs: NOW + 2001,
      maxBudgetUsd: 0.5,
    });
    expect(r2.moved, "handoff 那一格没动：" + r2.note).toBe(true);
    // handoff 的落点就是新角色 —— 一个【不在 NODE_TO_TEMPLATE 里】的名字。
    expect(roleAt()).toBe(NEW_ROLE);
    expect(Object.keys(NODE_TO_TEMPLATE)).not.toContain(NEW_ROLE);

    say = { action: "pass", summary: "译完了" };
    const r3 = await dispatch({
      taskId: TASK_ID,
      nowMs: NOW + 2002,
      maxBudgetUsd: 0.5,
    });
    expect(r3.moved, "新角色那一格没动：" + r3.note).toBe(true);

    // ── 跳 4（正文说「必须判的」那一半）────────────────────────────────
    const mine = delivered.filter((d) => d.role === NEW_ROLE);
    // 先判【有过这一轮】：否则下面那两条 some 会因为「压根没跑到」而假绿/假红分不清。
    expect(
      mine.length,
      "引擎没让新角色跑过一轮，那第四跳无从判起",
    ).toBeGreaterThan(0);
    const withOwnCriterion = mine.find((d) => d.rolePrompt.includes(CRITERION));
    expect(
      withOwnCriterion,
      "新角色那一轮的提示词里没有它自己那条标准",
    ).not.toBeUndefined();
    // 口径也要对：condition 是【不合格的情形】，不是目标（否则标准进来了却被读反）。
    expect(withOwnCriterion?.rolePrompt).toContain("不合格的情形");
    // 而且不是「随便一份岗位书」：那句「没有你的岗位书」必须不在。
    expect(withOwnCriterion?.rolePrompt).not.toContain(NO_CHARTER_LINE);
    // 对照到同一份捕获里：intake 那些轮【没有】这条标准 —— 它不是全局注入的。
    const others = delivered.filter((d) => d.role !== NEW_ROLE);
    expect(others.length).toBeGreaterThan(0);
    for (const o of others) expect(o.rolePrompt).not.toContain(CRITERION);
  });

  it("⭐ 反空转：名字进了图、但没给它签岗位书的那个角色，提示词里一条验收标准都没有", async () => {
    const h = hub("unseeded");
    const post = await handleRequest(
      h.deps,
      h.req({
        method: "POST",
        path: "/org",
        body: JSON.stringify({
          graph: graphWith("data"),
          change: {
            kind: "add_edge",
            edge: { from: "data", to: "director", review_gate: true },
          },
          change_summary: "加一个数据角色，但【不】给它播种",
        }),
      }),
    );
    expect(post.status).toBe(200);

    const rt = makeRuntime({
      writer: h.q,
      bus: new InMemoryEventBus(),
      maxBudgetUsd: 0.5,
      taskLimitCents: 100_000,
      cwd: TMP,
      evidenceRoot: TMP + "/artifacts",
      ceoRoleId: "ceo",
      nowMs: () => NOW,
    });

    const prompt = rt.deps.rolePrompt("data");
    // 「名字进图」这件事确实成立了 —— 这正是设计文档警告的那种假绿的【那一半】。
    expect(prompt).toContain("[data]");
    // 而岗位书那一格是空的：不是「标准少一条」，是人事系统里查无此人。
    expect(prompt).toContain(NO_CHARTER_LINE);
    expect(prompt).not.toContain("不合格的情形");
  });

  it("前提：这两个新名字【确实】不与任何模板文件名/预设节点名相同（反空转成立的前提）", () => {
    // 这一发不是装饰。上面两发的对照全靠「新角色名不在已播种的名字里」。
    // 哪天有人把 translator / data 加进模板目录或 NODE_TO_TEMPLATE，
    // 那条对照就悄悄变成「播过了而没读」，而它照绿 —— 红因登记在这里。
    const stems = readdirSync(REAL_TEMPLATES)
      .filter((f) => /\.ya?ml$/iu.test(f))
      .map((f) => f.replace(/\.ya?ml$/iu, ""));
    expect(stems.length).toBeGreaterThan(0);
    expect(stems).not.toContain("translator");
    expect(stems).not.toContain("data");
    const presetNodes = Object.keys(NODE_TO_TEMPLATE);
    expect(presetNodes).not.toContain("translator");
    expect(presetNodes).not.toContain("data");
  });

  it("播种那一格不是白给的：同一份模板带回占位串 ⇒ 退 1、零行，第四跳随之读不到标准", async () => {
    const h = hub("placeholder");
    // 把标准换回占位串（= CEO 还没签）。仓里那七份真模板今天全是这个形状。
    const io = captureIo();
    const seeded = await runSeedCli(
      [
        "--db",
        h.path,
        "--from",
        templateDir("unsigned", "translator", "CEO-PLACEHOLDER-ACCEPTANCE"),
      ],
      io.io,
    );
    expect(seeded.code).toBe(EXIT_PROBLEM);
    expect(io.err()).toContain("一个角色都没写");
    expect(
      Number(
        (
          h.q
            .readConnection()
            .prepare("SELECT COUNT(*) AS c FROM role_charters")
            .get() as Row
        )["c"],
      ),
    ).toBe(0);

    // 于是第四跳只能给那句「没有岗位书」—— 这一发把「播种」与「读到标准」之间的因果
    // 真的断开了一次：去掉播种，第四跳就退化。
    const rt = makeRuntime({
      writer: h.q,
      bus: new InMemoryEventBus(),
      maxBudgetUsd: 0.5,
      taskLimitCents: 100_000,
      cwd: TMP,
      evidenceRoot: TMP + "/artifacts",
      ceoRoleId: "ceo",
      nowMs: () => NOW,
    });
    expect(rt.deps.rolePrompt("translator")).toContain(NO_CHARTER_LINE);
  });
});
