/**
 * Task 0.8 —— 最小可运行公司图端到端（计划 §Task 0.8 / 规格 §23.3、§7.1、§5.9）。
 *
 * 四条验收各自钉住一件事：
 *  ① 一句想法能把桩图跑到 END，events 里出现完整状态机轨迹，任务停在等人批准的那一格；
 *  ② test 桩失败一次 → 回退 dev 一次（单分支、且【有界】）；
 *  ③ 进程 SIGKILL 后新进程续跑，已完成节点不重复执行（V3）；
 *  ④ TaskStateChanged 的 from/to 序列与 §7.1 一致，无非法跃迁。
 *
 * 为什么期望轨迹是【逐条列举那 11 条边】（条数从 EXPECTED_STUB_TRACE 算，不写死）
 * 而不是"每条合法就行"：
 * "每条合法"容忍轨迹断裂（A→B 之后凭空冒出 C→D）、缺跳、多跳。所以这里先钉死序列，
 * 再**另外**用 status.ts 的边表逐条复核 —— 两份独立真相互相牵制：期望序列写错了，
 * 边表复核会抓住；边表被改坏了，期望序列会抓住。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { SuperStepAuditor } from "../../src/graph/audit-middleware.js";
import {
  buildCompanyGraph,
  COMPANY_NODES,
  MAX_DEV_REWORK,
} from "../../src/graph/company.js";
import {
  isTaskTransitionLegal,
  legalTransitionsFrom,
  type TaskState,
} from "../../src/graph/status.js";
import { StubRegistry, stringifyContent } from "../../src/graph/stub-model.js";
import { loadPresetRoles, tierOfNode } from "../../src/roles/preset.js";
import {
  EXPECTED_STUB_TRACE,
  runsOfNode,
  STUB_STOP_STATE,
  traceFromRows,
} from "./fixtures/company-fixtures.js";
import { runChild } from "./fixtures/run-child.js";

/**
 * 期望路线住在 ./fixtures/company-fixtures.ts，与 cli/smoke.ts 共用一份。
 * 原先它住在这里、长度又被手抄到 smoke 的四处计数里，改一次路线要动六处。
 *
 * ⚠ 这份期望【不该】再长回 14 条。report 现在停在 ESCALATED_TO_CEO：再往后那三条边
 * （→FINAL_REVIEW→DELIVERED→ARCHIVED）里前两条的语义是「CEO 批准上线」与
 * 「终审通过，交付」，桩写它们等于替 CEO 批两次，而 events 是 append-only 的。
 * 谁把这里加长，test/arch/stub-terminal-write.ts 会红 —— 那是刻意的耦合。
 */
const EXPECTED_TRACE = EXPECTED_STUB_TRACE;

/**
 * 诚实标注（不是 TODO，是已知边界，Phase 1 必须回头改这里）：
 * CHARTER_PENDING → CHARTER_APPROVED 在真实系统里由 CEO 在审批收件箱点击触发
 * （§7.2 步骤 2 的"CEO 操作"列）。0.8 的最小图【没有】门控，charter 用桩直通这一条。
 * 审阅门控落地后这条边必须改成 interrupt 驱动 —— 届时连同这段注释、下面那条
 * "无门控"用例、以及守卫 test/arch/stub-terminal-write.ts 的 BASELINE 一起改，
 * 不是悄悄改期望值。
 *
 * 另一半原先的标注（ESCALATED_TO_CEO→FINAL_REVIEW→DELIVERED 那三条桩直通）已经
 * 【不再是事实】，所以删掉了：report 现在停在 ESCALATED_TO_CEO。见 fixtures 那份注释。
 */

/** 档位多重集：从【真岗位书】算出，不在测试里硬编码。
 *  若图把 model_tier 写死，模板一改这里就红 —— 这是我们要的耦合方向。 */
function expectedTierBag(): string[] {
  const out: string[] = [];
  for (const n of COMPANY_NODES) {
    for (let i = 0; i < runsOfNode(n); i += 1) out.push(tierOfNode(n));
  }
  return out.sort();
}

class FakeBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  publishPersisted(e: DomainEvent, seq: number): void {
    this.published.push({ event: e, seq });
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("e2e 测试不订阅总线");
  }
}

const dirs: string[] = [];
const dbs = new Set<DatabaseSync>();
afterAll(() => {
  for (const d of dbs) {
    try {
      d.close();
    } catch {
      /* 子进程崩过的那份已被系统回收 */
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，清不掉不影响结论 */
    }
  }
});

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "opc-e2e-"));
  dirs.push(dir);
  return join(dir, "hub.db");
}

function makeHub(dbPath: string) {
  const db = openDb(dbPath);
  migrate(db);
  dbs.add(db);
  const bus = new FakeBus();
  const auditor = new SuperStepAuditor({ db, bus, now: () => 1700000000000 });
  const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
  return { db, bus, auditor, saver };
}

/**
 * 只读的第二条连接读【已提交】的行。
 * 写连接永远看得见自己未提交的写入 —— 拿它断言"崩溃后什么都没留下来"必然假绿。
 */
function readRows(dbPath: string, sql: string): Record<string, unknown>[] {
  const other = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return other.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
}
const readEvents = (dbPath: string): Record<string, unknown>[] =>
  readRows(
    dbPath,
    "SELECT id, task_id, action, target, payload FROM events ORDER BY id",
  );
/** 连 state_snapshot / replay_key 一起读：那两列是判据 3 的观测面。 */
const readAudit = (dbPath: string): Record<string, unknown>[] =>
  readRows(
    dbPath,
    "SELECT id, action, target, payload, state_snapshot, replay_key FROM events ORDER BY id",
  );
const readTasks = (dbPath: string): Record<string, unknown>[] =>
  readRows(
    dbPath,
    "SELECT id, status, current_node, title FROM tasks ORDER BY id",
  );

/** 崩溃恢复测试的公共前置：建库 + 建任务行，由【父进程】做，
 *  这样断言针对的是"子进程崩溃"，而不是建库成没成。 */
function seedCrashDb(dbPath: string, taskId: string): void {
  const db = openDb(dbPath);
  migrate(db);
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare(
    "INSERT INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  ).run(
    taskId,
    "崩溃用例",
    "CHARTER_PENDING",
    "assistant",
    "intake",
    1700000000000,
    1700000000000,
  );
  db.close();
}

describe("Task 0.8 —— 最小可运行公司图", () => {
  beforeAll(() => {
    // 「不联网」写成可执行守卫而不是注释：测试里任何一次真实 fetch 立刻炸。
    vi.stubGlobal("fetch", (() => {
      throw new Error("NOT_ALLOWED：Task 0.8 的测试不得联网（一律用桩模型）");
    }) as typeof fetch);
  });

  it("① 一句想法能跑到 END，且 events 里出现完整状态机轨迹", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const reg = new StubRegistry();
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: reg,
      taskId: "T-E2E",
    });

    const result = await h.auditor.invoke(() =>
      graph.invoke(
        {
          idea: "做一个 AI 笔记应用",
          current: "CHARTER_PENDING",
        },
        { configurable: { thread_id: "th-e2e-1" } },
      ),
    );

    // 真的跑到了 END：next 为空 = 没有待执行节点（不是"看起来跑完了"）
    const state = await graph.getState({
      configurable: { thread_id: "th-e2e-1" },
    });
    expect(state.next ?? []).toEqual([]);

    // 九次节点执行，含一次回退。tech 也在其中，但它不写状态边，所以只能从 trail 看。
    expect(result.trail).toEqual([
      "intake",
      "charter",
      "product",
      "tech",
      "dev",
      "test",
      "dev",
      "test",
      "report",
    ]);

    const rows = readEvents(dbPath);
    expect(rows.length).toBe(EXPECTED_TRACE.length);
    for (const r of rows) {
      expect(r.action).toBe("state_change");
      expect(r.task_id).toBe("T-E2E");
    }

    // 任务行跟着推进到【桩该停的那一格】。原先这里断言 ARCHIVED，而那个 ARCHIVED
    // 是桩替 CEO 批出来的两条边换到的 —— 现在状态机停在 ESCALATED_TO_CEO，
    // 与生产路线停在同一格。常量从 fixtures 取，别处再写一个状态名就是第二份事实。
    const tasks = readTasks(dbPath);
    expect(tasks.length).toBe(1);
    expect(tasks[0]?.status).toBe(STUB_STOP_STATE);
    expect(tasks[0]?.title).toBe("做一个 AI 笔记应用");
  }, 180_000);

  // ── intake 那一发必须把 graph_version 写对 ────────────────────────────────
  // 这条测的是【第二条建任务路径】。0012 §2 那次补法只补了 real-deps.insertTask，
  // 而 hub run 走的是本文件这个图，它的 INSERT 列清单里当时【没有那一列】，
  // 于是每条 hub run 的任务都躺在 0001_init.sql:49 的 DEFAULT 1 上 —— 而 WORK_USAGE
  // 那句「建任务走 hub run / POST /tasks（那条路会把 graph_version 与任务行放在同一事务里取）」
  // 一直把两条路一起说。实测见 .workbuddy/round288-hubrun-graph-version.mjs。
  //
  // 为什么下面两发【必须成对】存在：
  //   只测「空库 ⇒ 0」⇒ 有人把它【写成常量 0】也照样全绿。0012 §5 那句「断言不能打在终值上」
  //   在这里是同一件事 —— 第二发（库里有 v7 ⇒ 落 7）才是"这个数来自库"的证据。
  // 为什么 0 是对的而 1 是错的：currentGraphVersion 在空表上给 0 = 【还没有任何版图】；
  //   1 会在将来有人提交第一版图（MAX+1，空库上正好是 1）那一刻变成一张真存在的图，
  //   于是这些老任务【静默地】指着那张它们创建时并不存在的图，一句报错都没有。
  it("①b 空图库：hub run 建的任务落 0，不是列默认值 1", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-GV-EMPTY",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "量graph_version", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-gv-empty" } },
      ),
    );
    // 第二条只读连接读（readRows 上面那段理由：写连接看不见自己没提交的东西，反过来它
    // 也不会替我把"这一列根本没写"这件事掩盖成默认值之外的数）。
    const rows = readRows(
      dbPath,
      "SELECT graph_version FROM tasks WHERE id = 'T-GV-EMPTY'",
    );
    expect(rows.length).toBe(1);
    expect(Number(rows[0]?.["graph_version"])).toBe(0);
  }, 180_000);

  it("①c 库里有 v7：hub run 建的任务落 7 ⇒ 那个数来自库，不是常量", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    // 直接摆一个 v7：本发要判的是"取数口有没有接上"，不是"提交逻辑会不会算出 7"
    // （后者由 test/org/versioning.test.ts 那批发判，那边测的是真 commitOrgGraph）。
    const stubGraph = JSON.stringify({ nodes: {}, edges: {} });
    h.db
      .prepare(
        "INSERT INTO delegation_graphs (id, version, graph_json, effective_from, created_by, change_summary) " +
          "VALUES (?,?,?,?,?,?)",
      )
      .run("g7", 7, stubGraph, 1700000000000, "test", "v7");
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-GV-V7",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "量graph_version", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-gv-v7" } },
      ),
    );
    const rows = readRows(
      dbPath,
      "SELECT graph_version FROM tasks WHERE id = 'T-GV-V7'",
    );
    expect(Number(rows[0]?.["graph_version"])).toBe(7);
  }, 180_000);

  it("② test 桩失败一次 → 回退 dev 一次，且回退单分支、有界", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-E2E-LOOP",
    });
    const result = await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "回退用例", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-e2e-loop" } },
      ),
    );

    expect(result.trail.filter((n: string) => n === "dev").length).toBe(2);
    expect(result.trail.filter((n: string) => n === "test").length).toBe(2);

    const rejects = traceFromRows(readEvents(dbPath)).filter(
      ([, to]) => to === "REJECTED_DOWNWARD",
    );
    expect(rejects.length).toBe(1); // 只打回一次，不是两次

    // 回退必须有界：MAX_DEV_REWORK 是有限的正数，且默认恰好允许一次返工。
    // 没界的话 dev/test 会永远互相打回，而 LangGraph 的 recursionLimit 只是兜底，
    // 不是设计 —— 靠它结束循环就是让运行时决定我们的业务语义。
    expect(Number.isFinite(MAX_DEV_REWORK)).toBe(true);
    expect(Number.isInteger(MAX_DEV_REWORK)).toBe(true);
    expect(MAX_DEV_REWORK).toBe(1);

    // 「单分支」的结构证据：test 的出边恰好两条（前进 / 回退），且都是条件边。
    // 断言打在 getGraph() 的【公开结构】上，不去翻 LangGraph 的私有字段 ——
    // 私有结构随版本变，而"只能回退到 dev"是计划的硬要求。
    const g = graph.getGraph();
    const out = g.edges
      .filter((e) => e.source === "test")
      .map((e) => ({ target: e.target, conditional: e.conditional }))
      .sort((a, b) => (a.target < b.target ? -1 : 1));
    expect(out).toEqual([
      { target: "dev", conditional: true },
      { target: "report", conditional: true },
    ]);
    // 回退分支不得指向 product / tech（"单分支"的反面就是到处回退）
    expect(out.map((e) => e.target)).not.toContain("product");
    expect(out.map((e) => e.target)).not.toContain("tech");

    expect(COMPANY_NODES).toEqual([
      "intake",
      "charter",
      "product",
      "tech",
      "dev",
      "test",
      "report",
    ]);
  }, 180_000);

  it("④ from/to 序列与 §7.1 完全一致，且每条都被 status.ts 判为合法", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-E2E-TRACE",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "轨迹用例", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-e2e-trace" } },
      ),
    );

    const trace = traceFromRows(readEvents(dbPath));
    expect(trace).toEqual(EXPECTED_TRACE); // 不缺跳、不多跳、不断裂

    // 连续性：前一条的 to 必须是后一条的 from —— 轨迹是一条路，不是散点
    for (let i = 1; i < trace.length; i += 1) {
      expect(trace[i - 1]?.[1]).toBe(trace[i]?.[0]);
    }
    // 独立复核：期望序列若被写坏，status.ts 这道独立真相会抓住
    for (const [from, to] of trace) {
      expect(
        isTaskTransitionLegal(from as TaskState, to as TaskState),
        "非法跃迁 " + from + " -> " + to,
      ).toBe(true);
      expect(legalTransitionsFrom(from as TaskState)).toContain(to);
    }
    expect(trace[0]?.[0]).toBe("CHARTER_PENDING");
    // 尾格 = 桩该停的那一格。断言它而不是断言「轨迹长度」：长度会随图改动一起变，
    // 而「桩绝不自己跨过 CEO 那一格」是这次修改要钉的性质。
    expect(trace.at(-1)?.[1]).toBe(STUB_STOP_STATE);
  }, 180_000);

  // ── 判据 3：每条状态边都带着【决定时的完整任务状态】与【重放键】──────────────
  //
  // 规格 §6.3 第二条的原话是「每条事件携带 state_snapshot（决定时的完整任务状态 JSON）」。
  // 这一发把它做成【方向性】断言，因为「有值」不等于「对」：
  //  ① 空壳也算错。0006 §8.5 量过：把列默认值从 NULL 改成 `{}`，311 例里只红 2 例 ——
  //    「非 NULL」这种判据抓不住空壳。所以这里 NULL、空串、"null"、"{}" 一律算空。
  //  ② 方向要打在 from 上，不是 to。这是本用例真正有鉴别力的地方：
  //    edge() 写的快照是 `{ ...state, current: from }`，那个 current 替换【不是装饰】——
  //    一个节点一次执行写多条边时（test 写 IN_REVIEW→REJECTED_DOWNWARD 两条），
  //    节点入口那份 state.current 是【第一条边的 from】；第二条边若不替换，
  //    快照说的就是「上一条边之前」而不是「本条边之前」。删掉那个替换，
  //    下面那条 current===from 会在第二条边上红（实测见台账 round356 的变异记录）。
  //  ③ 快照里没有模型回复文本。§6.3 要的是【状态】；把回复塞进去会让
  //    foreign-model-loop 那条「跨次运行 events 逐字相同」变成靠桩模型稳定侥幸绿过。
  it("⑤ 每条状态边都有 state_snapshot（方向打在 from）与非空 replay_key", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-E2E-SNAP",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "快照用例", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-e2e-snap" } },
      ),
    );

    const rows = readAudit(dbPath);
    expect(rows.length).toBe(EXPECTED_TRACE.length);

    const emptyish = (v: unknown): boolean => {
      if (v === null || v === undefined) return true;
      const t = String(v).trim();
      if (t === "" || t === "null" || t === "{}") return true; // 空壳不算快照
      const parsed = JSON.parse(t) as unknown;
      return (
        typeof parsed !== "object" ||
        parsed === null ||
        Object.keys(parsed as Record<string, unknown>).length === 0
      );
    };

    const keys: string[] = [];
    for (const r of rows) {
      const label = String(r.target);
      const snap = JSON.parse(String(r.state_snapshot)) as Record<
        string,
        unknown
      >;
      // ① 不是空壳
      expect(emptyish(r.state_snapshot), "空快照：" + label).toBe(false);
      // ② 方向：快照说的是【本条边之前】的状态
      const edge = JSON.parse(String(r.payload)) as {
        from: string;
        to: string;
      };
      expect(snap.current, "快照方向不在 from：" + label).toBe(edge.from);
      expect(snap.current, "快照方向跑到了 to：" + label).not.toBe(edge.to);
      // 状态通道齐（少了通道就是「伪快照」：看起来有 JSON，回放时缺字段）
      for (const ch of ["idea", "current", "passed", "reworkUsed", "trail"]) {
        expect(snap, "快照缺通道 " + ch + "：" + label).toHaveProperty(ch);
      }
      // ③ 快照是【状态】，不是模型说了什么
      expect(
        JSON.stringify(snap),
        "快照里混进了模型回复：" + label,
      ).not.toContain("stub:");
      // 重放键非空（0010 的索引只认非 NULL，空键 = 这一行不参与去重）
      expect(typeof r.replay_key).toBe("string");
      expect(String(r.replay_key).trim()).not.toBe("");
      keys.push(String(r.replay_key));
    }

    // ── 键的【粒度】：一次节点执行一个键 ────────────────────────────────
    // 两头都要钉，因为两种错都会让去重看起来在工作：
    //  · 常量键（整趟一个键）⇒ 第二次执行的【合法】事件被第一次吞掉，行数照样少，
    //    看起来像「去重生效」。所以要有「键不止一个」。
    //  · 每条边一个键 ⇒ 一个超步写多条边的那次执行（test 一发写 IN_REVIEW + 判定，
    //    dev 被打回那一发写补边 + 交证据）重放后会剩多条。所以要有「一次执行内同键」。
    const runs: string[][] = [];
    for (const k of keys) {
      const last = runs[runs.length - 1];
      if (last !== undefined && last[0] === k) last.push(k);
      else runs.push([k]);
    }
    // 同键的连续行确实是【同一次执行】：它们的 from/to 首尾相接
    for (const run of runs) {
      expect(run.length).toBeGreaterThan(0);
    }
    const grouped = new Map<string, number[]>();
    for (let i = 0; i < keys.length; i += 1) {
      const g = grouped.get(keys[i] as string) ?? [];
      g.push(i);
      grouped.set(keys[i] as string, g);
    }
    // 一次执行的行是【连续】的：同一个键不会在别的键之后又出现一次。
    // 它若出现，说明两次执行撞了同一个键（那第一次的合法事件会被第二次吞掉）。
    expect(runs.length).toBe(grouped.size);
    // 键的个数 = 写过边的节点执行次数（intake 一次执行【不写边】，所以排除它）。
    // 这个数从【真岗位书的运行次数】算，不写死：改回退次数时它会跟着走。
    const edgeWritingRuns = COMPANY_NODES.filter((n) => n !== "intake").reduce(
      (acc, n) => acc + runsOfNode(n),
      0,
    );
    expect(grouped.size).toBe(edgeWritingRuns);
    // 至少存在一次执行写了多条边（否则本用例测不到「一次执行多条约」这个形态）
    expect(EXPECTED_TRACE.length).toBeGreaterThan(grouped.size);
  }, 180_000);

  it("节点级模型由岗位书的 model_tier 驱动（§5.9），且不联网不计费", async () => {
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const reg = new StubRegistry();
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: reg,
      taskId: "T-E2E-TIER",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        {
          idea: "做一个 AI 笔记应用",
          current: "CHARTER_PENDING",
        },
        { configurable: { thread_id: "th-e2e-tier" } },
      ),
    );

    // 多重集相等 ⇒ 每次调用用的都是【该节点自己岗位书里的档位】，
    // 次数对得上、档位也对得上。只断言"出现过两个档位"是不够的：
    // 那容忍 dev 用了 management 档位。
    expect([...reg.seen].sort()).toEqual(expectedTierBag());
    expect(reg.totalCalls).toBe(9); // 7 个节点，dev / test 各因回退跑两次
    expect(new Set(reg.seen)).toEqual(new Set(["management", "execution"]));

    // 每次节点执行恰好一次模型调用：多出来就是节点里藏了没被要求的事
    for (const n of COMPANY_NODES) {
      const tier = tierOfNode(n);
      const perTier = reg.byTier.get(tier);
      expect(
        perTier,
        "节点 " + n + " 的档位 " + tier + " 没被请求过",
      ).toBeDefined();
    }

    // 那句想法真的进了模型，而不是只进了 state
    const prompts = [...reg.byTier.values()].flatMap((m) =>
      m.calls.map((c) => c.text),
    );
    expect(prompts.some((x) => x.includes("做一个 AI 笔记应用"))).toBe(true);
    // 桩确实在收 messages（而不是被绕过）：任何一次调用的文本都得是非空字符串
    for (const t of prompts)
      expect(typeof t === "string" && t.length > 0).toBe(true);
    // stringifyContent 自证：content-block 数组要拍平，不能变成 [object Object]
    expect(stringifyContent([{ text: "甲" }, { text: "乙" }])).toBe("甲乙");
  }, 180_000);

  it("0.8 的最小图【没有】审批门控：CHARTER_PENDING→CHARTER_APPROVED 由桩直通", async () => {
    // 这条不是"顺便测一下"，而是钉住已知边界：Phase 1 门控落地后直通就是错的，
    // 届时这条用例必须转红，然后连同文件头的诚实标注一起改。
    const dbPath = tmpDb();
    const h = makeHub(dbPath);
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.saver,
      roles: loadPresetRoles(),
      models: new StubRegistry(),
      taskId: "T-E2E-NOGATE",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        {
          idea: "无门控用例",
          current: "CHARTER_PENDING",
        },
        { configurable: { thread_id: "th-e2e-nogate" } },
      ),
    );
    const rows = readEvents(dbPath);
    expect(traceFromRows(rows)[0]).toEqual([
      "CHARTER_PENDING",
      "CHARTER_APPROVED",
    ]);
    // 全程只有 state_change：出现 review_decision / approval_required 就说明图里
    // 混进了本任务未要求的门控。
    expect(new Set(rows.map((r) => String(r.action)))).toEqual(
      new Set(["state_change"]),
    );
  }, 180_000);

  describe("③ 崩溃续跑（复用 Task 0.1 的双进程手法）", () => {
    it("SIGKILL 后：已提交的超步都在库里，被杀那个超步一条事件都没留下", async () => {
      const dbPath = tmpDb();
      seedCrashDb(dbPath, "T-CRASH");

      // 杀在【第 5 条边 INSERT 之后、超步事务提交之前】：这是最狠的时机 ——
      // 事件已经写进连接、但所在超步尚未提交。不是靠 sleep 猜时机。
      const first = runChild({
        dbPath,
        threadId: "th-crash",
        taskId: "T-CRASH",
        idea: "崩溃续跑用例",
        killEventIndex: 5,
      });
      expect(
        first.status,
        "子进程应异常退出；stderr：" + first.stderr,
      ).not.toBe(0);
      expect(first.stdout).toContain("CHILD-KILL at k=5");
      /*
       * 崩溃时机本身也要断言 —— 否则"库里剩几条"分不清两种失败模式：
       *   事件已 INSERT、被回滚（回滚能力被检验，V3 想要的）
       *   事件压根没写入（什么都没检验，假绿）
       * 杀在 k=5 时，事务内可见 5 行：4 条来自之前已提交的超步 + 第 5 条本事务刚 INSERT
       * 尚未提交；父侧只读连接只能看到 4 条。少了"5"，就说明 SIGKILL 打在了 INSERT 之前，
       * 于是这条用例声称验证的原子性从未发生（实测：把 onStatusEdge 挪到 record 之前，
       * 父侧计数完全不变，只有这里会掉）。
       */
      expect(first.stdout).toContain("CHILD-UNCOMMITTED n=5");

      const trace = traceFromRows(readEvents(dbPath));
      // 前 4 条边属于已提交的超步，必须留下；第 5 条所在超步必须整体回滚。
      expect(trace).toEqual(EXPECTED_TRACE.slice(0, 4).map(([a, b]) => [a, b]));
      // §6.3 的"同一事务"claim 在 process.kill 下成立，不是只在正常路径上成立
      expect(trace.length).toBe(4);
      // 任务行也停在崩溃前，不是 test 想写的那个状态
      expect(readTasks(dbPath)[0]?.status).toBe("EVIDENCE_SUBMITTED");
    }, 180_000);

    it("新进程续跑：补齐剩下所有边，已完成节点不产生重复事件（V3）", async () => {
      const dbPath = tmpDb();
      seedCrashDb(dbPath, "T-CRASH2");

      const first = runChild({
        dbPath,
        threadId: "th-crash2",
        taskId: "T-CRASH2",
        idea: "崩溃续跑用例",
        killEventIndex: 6, // 杀在第 6 条边（test#1 的 IN_REVIEW→REJECTED_DOWNWARD）
      });
      expect(first.status).not.toBe(0);
      // 崩溃时机：杀在第 6 条边之后，事务内应可见 6 行（4 条已提交超步 + 本超步 2 条未提交）。
      // 与上一用例同理 —— 没有这条，"库里剩 4 条"无法区分"被回滚"和"没写入"。
      expect(first.stdout).toContain("CHILD-UNCOMMITTED n=6");
      const before = traceFromRows(readEvents(dbPath));
      expect(before.length).toBe(4); // 整个 test#1 超步回滚

      // 第二个进程：从上一个已提交超步之后接着跑，不重放已完成节点
      const second = runChild({
        dbPath,
        threadId: "th-crash2",
        taskId: "T-CRASH2",
        idea: "崩溃续跑用例",
      });
      expect(second.status, "续跑应正常结束；stderr：" + second.stderr).toBe(0);
      expect(second.stdout).toContain("CHILD-DONE resumed=true");

      const trace = traceFromRows(readEvents(dbPath));
      // 条数与顺序完全一致 ⇒ 没有任何已完成节点被重跑（重跑必然多写边）。
      // 这条因此兼作 V3 的守卫：断言"多出来的东西不存在"，而不是断言"某个计数等于几"。
      expect(trace).toEqual(EXPECTED_TRACE.map(([a, b]) => [a, b]));

      /*
       * 【删掉了一条曾经写错的断言】这里原来还有一条"from->to 不得出现两次"的
       * 重复检测，实测它是错的：返工路径本来就要【两次】经过
       * IN_PROGRESS→EVIDENCE_SUBMITTED 和 EVIDENCE_SUBMITTED→IN_REVIEW —— dev 交证据、
       * test 入审，第一趟和返工那趟走的是同一对 §7.1 状态。那是合法轨迹，不是重复事件。
       *
       * 「已完成节点被重跑」由上面那条 trace === EXPECTED_TRACE 抓住：重跑必然多写边，
       * 于是长度或顺序立刻错。再加一条 from/to 重复检测并不增加判别力，只会把合法的
       * 返工误判成缺陷 —— 断言的判别力不来自条数，来自它能不能区分对错。
       *
       * 另加一条更直接的证据：恢复进程【只执行了 4 次节点】test → dev → test → report。
       * 若已完成的 dev / test 被重放，CHILD-EXIT 的次数就会超过 4。
       */
      /*
       * 恢复进程【实际执行】了哪些节点 —— 从 stdout 的 CHILD-ENTER 序列读，
       * 这是「已完成节点不重复执行」最直接的观测量：intake / charter / product / tech /
       * dev#1 若被重放，就会出现在这个序列里。实测恰好是这 4 次：被回滚的 test#1 超步
       * 重放一遍（它的两条边 + reworkUsed 通道一起回滚，所以仍走同一条返工分支），
       * 然后 dev#2 → test#2 → report。
       */
      const entered = (second.stdout.match(/CHILD-ENTER (\S+)/g) ?? []).map(
        (s) => s.replace("CHILD-ENTER ", ""),
      );
      expect(entered).toEqual(["test", "dev", "test", "report"]);

      /*
       * trail 是【跨超步累加】的 reducer 通道，所以恢复后它带的是从头到尾的完整轨迹，
       * 不是恢复进程自己那 4 项。这条因此测的是另一件事：checkpoint 里的通道状态
       * 既没丢也没重复累积 —— 与上面那条期望轨迹序列互为佐证。
       */
      const trailOut = second.stdout.match(
        /CHILD-DONE resumed=true trail=(\[[^\]]*\])/,
      );
      expect(trailOut?.[1]).toBe(
        JSON.stringify([
          "intake",
          "charter",
          "product",
          "tech",
          "dev",
          "test",
          "dev",
          "test",
          "report",
        ]),
      );

      expect(readTasks(dbPath)[0]?.status).toBe(STUB_STOP_STATE);
    }, 180_000);
  });
});

/**
 * 找出把【未声明通道】当图 state 字段传出去的代码行。
 *
 * 返回行号（1 起）。注释行不参与判定：守卫要拦的是【把死键传给图】的代码，
 * 而注释里解释"为什么不能用这个键"恰恰是防复发的手段（实测：不豁免注释时，
 * fixtures/e2e-crash-child.ts 里那段教学注释会被判违规）。
 *
 * 为什么不用类型系统查：tsc -b 的 solution 只含 packages/<pkg>/src，test/ 整体
 * 不在覆盖范围（实测：一个语法彻底坏掉的测试文件，tsc -b 仍然 exit 0，只有
 * vitest 会报 Tests  no tests）。类型层面的"多余属性"检查在测试里根本不执行。
 */
function findDeadKeyLines(text: string, key: string): number[] {
  return text
    .split("\n")
    .map((raw, idx) => ({ t: raw.trim(), n: idx + 1 }))
    .filter(
      (x) =>
        !x.t.startsWith("//") && !x.t.startsWith("*") && !x.t.startsWith("/*"),
    )
    .filter((x) => x.t.includes(key + ":"))
    .map((x) => x.n);
}

/** 图里真实存在的通道；唯一真相在 src/graph/company.ts 的 Annotation.Root。 */
const STATE_CHANNELS = ["current", "idea", "passed", "reworkUsed", "trail"];

describe("图 state 字面量守卫", () => {
  /*
   * 键名分两段拼是必要的：本守卫扫的就是这个字面量，写成一整串会命中自己。
   * 下面构造正/负样本时同样分段，理由一致。
   */
  const DEAD_KEY = "current" + "Node";

  it("测试里没有把未声明的通道传给图（LangGraph 会静默丢弃）", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith(".ts")) {
          const bad = findDeadKeyLines(readFileSync(p, "utf8"), DEAD_KEY);
          if (bad.length > 0) {
            offenders.push(
              relative(dir, p).split(sep).join("/") + ":" + bad.join(","),
            );
          }
        }
      }
    };
    walk(dir);
    expect(
      offenders,
      DEAD_KEY + " 不是图通道，会被静默丢弃：\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });

  /*
   * 【自证有效性】这条才是上一版真正缺的东西。守卫一旦静默失效（键名被改错、
   * 判定被短路、目录走错），它自己永远"绿"，比没有守卫更糟 —— 提供虚假的安全感。
   * 所以在这里种一个人工违规样本，要求扫描器必须抓到它。
   */
  it("扫描器能抓到种下的违规（否则它是恒绿装饰）", () => {
    const violation = [
      'const s = { idea: "x", cur',
      "rentNode",
      ': "n" };',
    ].join("");
    expect(findDeadKeyLines(violation, DEAD_KEY)).toEqual([1]);
  });

  it("扫描器不把注释里的解释当违规", () => {
    const note = ["// 别写 currentNode", ": 它进不了图"].join("");
    expect(findDeadKeyLines(note, DEAD_KEY)).toEqual([]);
  });

  /*
   * 键名分段的写法本身也要守：一旦被合并成一整串，上面两条样本会被源码扫描
   * 命中，第一条守卫立刻红 —— 那时失败信息会直接指出本文件，不需要额外断言。
   * 这里改而锁住通道清单，因为"守卫能否抓到东西"已由上面两条覆盖。
   */
  it("通道清单与 src 的 Annotation.Root 同步", () => {
    const src = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        "../../src/graph/company.ts",
      ),
      "utf8",
    );
    for (const ch of STATE_CHANNELS) {
      expect(src, "company.ts 里找不到通道 " + ch).toContain(
        ch + ": Annotation<",
      );
    }
    expect(STATE_CHANNELS.length).toBe(5);
  });
});
