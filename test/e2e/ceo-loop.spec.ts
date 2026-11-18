/**
 * Task 2.9 的 Phase 2 出口门禁：CEO 一圈走通，全程不碰命令行。
 *
 * 计划 2026-11-06 第 507 行要的原文是：
 *   起 Hub + Web，端到端执行：输入想法 → 看板出现卡片并流转 → 收件箱出现审批
 *   → 点击批准 → 看板更新为 DELIVERED。全程无命令行。
 *
 * ── 这一发今天证到哪一步，逐字说清（先说结论，别让人自己推断）──────────
 * 走通的：输入想法（浏览器点按钮）→ 看板出现卡片 → 卡片【流转】到 CHARTER_APPROVED
 *        → 收件箱出现章程提案卡 → 点击批准 → 看板更新。
 * 没走通的：最后那句「更新为 DELIVERED」。
 *   批完之后任务从 CHARTER_PENDING 走到 CHARTER_APPROVED，那一跳是人边（
 *   engine/dispatch.ts 的 HUMAN_EDGES），批准本身就完成它。再往下的
 *   CHARTER_APPROVED → DECOMPOSING → IN_PROGRESS → … → DELIVERED 全是 agent 边
 *   （AGENT_EDGES），只有真 Claude 子进程或驱动器推得动 —— 浏览器里没有任何一处
 *   点得动它。所以「批准即 DELIVERED」在今天的代码里不成立，不是这条规格的缺陷。
 *   这一格【登记为待决策】而不是糊过去：见 docs/OPC-OS-功能优化设计.md §7 第 16 格。
 *   这一发的牙齿用变异量过：.workbuddy/round291-mutate-ceo-loop.mjs 命中 6/6
 *   （不点批准⇒红、起草角色不在组织图上⇒红、两侧 token 不一致⇒红、
 *    把最后那条断言掏成恒真⇒【必须绿】、zod 挂载退回硬编码⇒红）。
 *
 * ── 唯一被换掉的一步，以及为什么只能换它 ────────────────────────────
 * `pumpCardDeps`：章程起草的那一次 runTurn。真的那一支会 spawn 一个 claude 子进程、
 * 真花钱，而门禁不能花钱（同一台机器上重复跑同一条命令不该产生账单）。
 * 它换的是【最里面那一发】—— 候选 SQL、组织图门槛、建卡、审计行、幂等判定、
 * 收件箱读路径、批准写路径【全部是真的】。代价照 assemble.ts:237 那条口径写清：
 * 这一发【不证】真 runtime 起得了子进程，那一格由 engine/claude.test.ts 与
 * runtime.test.ts 负责。
 *
 * ⚠ 注入点必须【成对】给（assemble.ts:227-236 那条硬警告）：pumpCardDeps 给了而
 *   pumpRecordTurn 不给 ⇒ charter-pump.ts 的 engineOf 走 noRecorder 那一支，
 *   执行日志那一维就没跑。所以下面两格一起给。
 *
 * ── 心跳为什么手动叫 ─────────────────────────────────────────────
 * BootResult.heartbeat 是那颗 Ticker，`tick()` 是它自己给测试的入口
 * （timer.ts:145 那句「手动叫一轮。测试与『启动时立即跑一轮』都走这里」）。
 * 用真调度器等的是一分钟（HEARTBEAT_FLOOR_MS 的下限），而"等一分钟"换来的绿
 * 里混着"计时器活着"这一件与本页无关的事。手动叫 ⇒ 页面里唯一没落地的等待
 * 就是页面自己的加载与断言。boot 自己也会立即叫一轮，所以轮次可能不止一次；
 * 起草幂等由 card_key 的 NOT EXISTS 保证（charter-pump.ts:206），多叫几轮只是零花费跳过。
 *
 * ── 组织图为什么直接写库 ──────────────────────────────────────────
 * 起草角色必须在 delegation_graphs 上，否则 ensureCharterCard 返回 org_blocked
 * 而一分钱不烧（charter.ts:275-293）—— 那会让下面每一条断言绿在"起草根本没跑"上。
 * 用 POST /org 提交行不通：那条路由只在配了 --backup-dir 时才装配
 * （assemble.ts:962，§6.5 要求改组织前先有快照），而给一个一次性演示库配备份
 * 正被 dev-entry.ts:16 那条纪律禁止。直接 INSERT 走的是同一张表、同一个
 * INSERT_DELEGATION_GRAPH_SQL（org/commit.ts:98），不是另造一份形状。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { openDb } from "../../packages/hub/src/db/driver.js";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { DECISION_MARK } from "../../packages/hub/src/engine/claude.js";
import type { EngineRuntime } from "../../packages/hub/src/engine/runtime.js";
import { INSERT_DELEGATION_GRAPH_SQL } from "../../packages/hub/src/org/commit.js";
import {
  type BootResult,
  boot,
} from "../../packages/hub/src/serve/assemble.js";
import type { CharterCardDeps } from "../../packages/hub/src/serve/charter-pump.js";
import { HEARTBEAT_FLOOR_MS } from "../../packages/hub/src/serve/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

/** 端口写死而不是 0：web 子进程要在启动那一刻就知道 Hub 在哪儿。避开 pnpm dev 那一对。 */
const HUB_PORT = Number(process.env["E2E_HUB_PORT"] ?? 8899);
const WEB_PORT = Number(process.env["E2E_WEB_PORT"] ?? 9899);
const NOW = Date.parse("2026-11-17T00:00:00Z");

/** 想法正文。标题就是它的第一行（app.ts:359 titleOf），后面按这个字面断言。 */
const IDEA = "做一个面向独立开发者的 AI 笔记应用，目标月收入 100 万";

/**
 * 一份真库：迁移跑过 + 一张把 intake 挂在 ceo 下面的组织图。
 * 组织图是【前置条件】不是脚手架：缺它则起草根本不跑，而所有断言照样绿。
 */
function makeDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "opc-e2e-"));
  const path = join(dir, "hub.db");
  const db = openDb(path);
  migrate(db);
  db.prepare(INSERT_DELEGATION_GRAPH_SQL).run(
    "g-e2e",
    1,
    JSON.stringify({
      nodes: {
        ceo: {
          role_id: "ceo",
          can_manage: true,
          reports_to: null,
          model_family: "opus",
        },
        intake: {
          role_id: "intake",
          can_manage: true,
          reports_to: "ceo",
          model_family: "sonnet",
        },
      },
      edges: [],
    }),
    NOW,
    "ceo",
    "e2e 用组织图",
  );
  db.close();
  return path;
}

/**
 * 不 spawn 的起草回调（本页唯一被换掉的一步）。
 * 文本必须能被 parseCharterDraft 认出来，否则"起草成功"会变成"跑了而没建出卡"，
 * 而本页要断的正是【卡进了收件箱】。文本形状抄自 assemble-pump.test.ts:170 那一份。
 */
function cardDeps(calls: string[]): () => CharterCardDeps {
  return () => ({
    runTurn: async (i) => {
      calls.push(i.role);
      return {
        ok: true,
        text:
          "业务目标：做一个面向独立开发者的 AI 笔记应用\n" +
          "可量化验收标准：三条\n预算上限：200 美元\n\n" +
          DECISION_MARK +
          "\n" +
          JSON.stringify({
            action: "wait",
            summary: "章程提案已拟好，等 CEO 签署",
          }),
        costCents: 6,
        sessionId: null,
        error: null,
      };
    },
    rolePrompt: (r): string => "你是角色 " + r,
  });
}

/** 执行日志那一格：给一个记数用的假 recorder，别让它回退去建真 runtime。 */
const recorder =
  (seen: number[]): EngineRuntime["recordTurn"] =>
  async (o) => {
    seen.push(o.costCents);
    return { recorded: true, why: "e2e 注入的执行日志" };
  };

let hub: BootResult | null = null;
/**
 * 收尾那一发单独存。
 * 不写 `hub?.shutdown()`：BootResult 是 ok:true / ok:false 的联合，
 * 而 afterAll 跑的时候编译器不知道它是哪一支 ⇒ TS2339。
 * 用 `hub.ok &&` 现场收窄也行，但那一格真正想表达的是"启动成功时留下的那个收尾动作"，
 * 而它恰好就是 boot 成功返回里那一个函数 —— 存下来比在收尾处重演一次判别更直白。
 */
let shutdownHub: (() => Promise<void>) | null = null;
let web: ChildProcess | null = null;
let dbPath = "";
/** 起草回调被叫了几次、各是哪个角色 —— 用来钉"流转真的过了起草那一步"。 */
const draftCalls: string[] = [];
const recordedTurns: number[] = [];

test.beforeAll(async () => {
  dbPath = makeDb();
  hub = await boot(
    {
      dbPath,
      port: HUB_PORT,
      noBackup: true,
      heartbeatMs: HEARTBEAT_FLOOR_MS,
      charterPump: true,
      driverPump: true,
      maxBudgetUsd: 0.5,
      taskLimitCents: 500,
      agentCwd: ROOT,
    },
    {
      log: (m) => console.log("[hub] " + m),
      warn: (m) => console.warn("[hub] " + m),
    },
    {
      token: "e2e-token-not-a-secret",
      pumpCardDeps: cardDeps(draftCalls),
      pumpRecordTurn: recorder(recordedTurns),
    },
  );
  if (!hub.ok) {
    throw new Error("Hub 起不来：" + hub.message + (hub.hint ?? ""));
  }
  shutdownHub = hub.shutdown;
  // 签名代理起子进程：它自己有 listen()，同进程起会和 Hub 抢一件事的边界。
  // 命令行抄 dev-entry.ts 的 webSpawnArgs（execPath + tsx cli，Windows 上 pnpm/npx 不是可 spawn 的文件）。
  const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  web = spawn(
    process.execPath,
    [tsx, join(ROOT, "packages", "web", "src", "dev-server.ts")],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        HUB_PORT: String(HUB_PORT),
        WEB_PORT: String(WEB_PORT),
        ORG_TOKEN: "e2e-token-not-a-secret",
      },
      stdio: "ignore",
    },
  );
  // 等代理真能答话。等一个端口比 sleep 可靠：sleep 在慢机器上是 flaky，
  // 而这里的失败形状（ECONNREFUSED）指向的是"没起来"，不是"没等够"。
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${WEB_PORT}/`);
      if (r.status === 200) break;
    } catch {
      /* 还没听 */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
});

test.afterAll(async () => {
  web?.kill();
  await shutdownHub?.();
  if (dbPath !== "") rmSync(dirname(dbPath), { recursive: true, force: true });
});

const board = (): string => `http://127.0.0.1:${WEB_PORT}/#/board`;

test("CEO 一圈：想法 → 看板卡片 → 流转 → 收件箱批准 → 看板更新，全程只用浏览器", async ({
  page,
}) => {
  test.setTimeout(240_000);

  // ① 输入想法（今日页那个输入框）。
  await page.goto(`http://127.0.0.1:${WEB_PORT}/#/today`);
  await page.locator("[data-idea]").fill(IDEA);
  await page.locator("[data-create]").click();
  await expect(page.locator("[data-idea-state]")).toContainText("已收到");

  // ② 看板出现卡片。重新 goto：看板每次渲染重读 REST，而这里要的是"从服务端读出来的那一行"，
  //    不是页面自己塞的一行（渲块的投影纪律，app.js:363 那条）。
  await page.goto(board());
  const card = page.locator("[data-task]", {
    hasText: "做一个面向独立开发者的 AI 笔记应用",
  });
  await expect(card).toHaveCount(1);
  await expect(card.locator(".pill")).toHaveText("CHARTER_PENDING");

  // ③ 流转：叫一轮心跳，让章程泵起草出卡片。
  if (hub === null || !hub.ok) throw new Error("前一步之后 Hub 没了");
  await hub.heartbeat.tick();
  // ⚠ tick() 落地【不等于】这一轮泵跑完了：心跳 job 里泵是【派发】而不是 await
  // （assemble.ts:1462 那条 —— await 上去会让一次起草把停滞检测与备份挡掉，
  //  且不计入 consecutiveFailures、不退进程，是完全静默的形状）。
  // 所以这两发等的是【页面之外那两个计数器】，用 poll 而不是"tick 完就断"：
  // 后者会红在窗口上，而且红因写的是"注入不成对"这种假话。
  await expect
    .poll(() => draftCalls.length, {
      message: "起草回调一次都没被叫 ⇒ 卡片不是起草出来的",
      timeout: 60_000,
    })
    .toBeGreaterThan(0);
  expect(draftCalls[0]).toBe("intake");
  await expect
    .poll(() => recordedTurns.length, {
      message:
        "执行日志那一格没跑（pumpCardDeps 给了而 pumpRecordTurn 没生效）",
      timeout: 60_000,
    })
    .toBeGreaterThan(0);

  // ④ 收件箱出现审批，并真的【点一次批准】。
  await page.goto(`http://127.0.0.1:${WEB_PORT}/#/inbox`);
  await expect(page.locator("body")).toContainText("章程提案");
  await page.locator("select").first().selectOption("approve");
  await page.locator("[data-decide]").first().click();
  await expect(page.locator("[data-res]").first()).toContainText("已决定");

  // ⑤ 看板更新：批准把人边那一跳走完（CHARTER_PENDING → CHARTER_APPROVED）。
  //    等的是页面自己的 600ms 自重渲染，不是 sleep 撞窗口。
  await page.goto(board());
  const flowed = page.locator("[data-task]", {
    hasText: "做一个面向独立开发者的 AI 笔记应用",
  });
  await expect(flowed.locator(".pill")).toHaveText("CHARTER_APPROVED");
});
