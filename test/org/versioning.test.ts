/**
 * 组织变更的版本化提交（计划 Task 3.3，规格 §18.4 阶段 2）。
 *
 * ── 跑在【真迁移出来的库】+ 真 WriteQueue 上，理由同 real-deps.test.ts ──
 * 本文件要钉的三条性质全部住在「库 + 事务」这一层：
 *  · 半提交（部分表写了、部分没写）只有真事务能证；
 *  · delegation_graphs.version 的 UNIQUE 约束、role_charters 的 UNIQUE(role_id,version)
 *    只有真 schema 才有 —— 手搓一个 Map 假装表，版本号冲突这件事就永远不会红；
 *  · events 的 append-only 触发器同理。
 *
 * ── 三条 Test 是计划点名的，逐条对位（缺一条就是没交付）────────────────
 *   ①「保存失败 ⇒ 版本号不变、无半提交行」      → describe ② 那三条
 *   ②「运行中任务在组织变更后仍用旧版图」        → describe ③
 *   ③「新任务用新版图」                          → describe ④
 *
 * ── 本文件证不到什么，先说在这里 ──────────────────────────────────────
 * 「运行中任务仍用旧版图」我证的是【库里那一行的 graph_version 没被改动】，
 * 而【不是】「那条任务的图真的还按旧版跑」。后半句要真起 LangGraph 恢复一条任务，
 * 缺 @langchain/*（0009 §2），本机一次也没执行过。
 * 准确说法：V3 的恢复语义在这里可验证的部分是【版本坐标不被覆盖】，
 * 那正好是 §18.4 阶段 3 里 Hub 负责的那一半；LangGraph 读它怎么用，不在此处。
 */
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CEO_ROLE_ID,
  type OrgActor,
  type OrgChange,
  type OrgGraph,
} from "@opc/contracts";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { insertTask } from "../../packages/hub/src/http/real-deps.js";
import { fixtureTmp } from "../../packages/hub/test/fixtures/fixture-dir.js";
import {
  applyChangeToGraph,
  commitOrgGraph,
  MAX_GRAPH_VERSION_SQL,
  readGraphByVersion,
  RUNNING_TASKS_SQL,
} from "../../packages/hub/src/org/commit.js";

const TMP = fixtureTmp("org-commit", import.meta.url);

type Row = Record<string, unknown>;
type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
};

const NOW = 1_700_000_000_000;
const CEO: OrgActor = { type: "human", id: CEO_ROLE_ID };
const queues: { close: () => Promise<void> }[] = [];
let fileSeq = 0;

/** 一张能提交的最小合法图（四角色，全带 model_family —— 见 0011 §5 那条夹具教训）。 */
function graph(): OrgGraph {
  return {
    nodes: {
      ceo: { role_id: CEO_ROLE_ID, can_manage: true, reports_to: null, model_family: "o3" },
      tech: { role_id: "tech", can_manage: true, reports_to: CEO_ROLE_ID, model_family: "claude" },
      dev: { role_id: "dev", can_manage: false, reports_to: "tech", model_family: "gpt" },
      test: { role_id: "test", can_manage: false, reports_to: "tech", model_family: "gemini" },
    },
    edges: [
      { from: "dev", to: "test", review_gate: true },
      { from: "test", to: CEO_ROLE_ID, review_gate: true },
      { from: "tech", to: CEO_ROLE_ID, review_gate: true },
    ],
  };
}

const REPARENT: OrgChange = {
  kind: "reparent",
  child_role: "dev",
  new_parent_role: CEO_ROLE_ID,
};

async function newDb(): Promise<{ db: Db; w: any; path: string }> {
  const { WriteQueue } = await import("../../packages/hub/src/db/write-queue.js");
  const path = join(TMP, "c-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as any;
  queues.push(q);
  const db = q.writeConnection() as Db;
  migrate(db as never);
  return { db, w: q, path };
}

/** 落一条任务。graph_version 走列默认值，好让「有没有被 stamp」是可分辨的。 */
function task(db: Db, id: string, status = "IN_PROGRESS", graphVersion?: number): void {
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, " +
      "updated_at" +
      (graphVersion === undefined ? "" : ", graph_version") +
      ") VALUES (?, ?, ?, 'dev', 'dev', ?, ?" +
      (graphVersion === undefined ? ")" : ", ?)") +
      "",
  ).run(
    ...(graphVersion === undefined
      ? [id, "t-" + id, status, NOW, NOW]
      : ([id, "t-" + id, status, NOW, NOW, graphVersion] as unknown[])),
  );
}

/** 落一版岗位书。config 用真 charter 的 camelCase 形状（提交路径改的是 reportsTo）。 */
function charter(db: Db, roleId: string, version: number, reportsTo: string | null): void {
  db.prepare(
    "INSERT INTO role_charters (id, role_id, version, config, effective_from, created_by) " +
      "VALUES (?, ?, ?, ?, ?, 'ceo')",
  ).run(
    "rc-" + roleId + "-" + version,
    roleId,
    version,
    JSON.stringify({
      roleId,
      displayName: roleId,
      version,
      reportsTo,
      acceptanceCriteria: [{ condition: "c", action: "reject", message: "m" }],
    }),
    NOW,
  );
}

const count = (db: Db, t: string): number =>
  Number((db.prepare("SELECT count(*) AS n FROM " + t).get() as Row)["n"]);
const versionAt = (db: Db): number =>
  Number((db.prepare(MAX_GRAPH_VERSION_SQL).get() as Row)["v"]);

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
});
afterAll(() => {
  for (const q of queues) void q.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("① 提交本身：版本、快照、审计", () => {
  it("第一次提交 ⇒ 版本 1（不是 2）；空表的 MAX 是 0 而不是 1", async () => {
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "dev 改汇报到 CEO",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 空表返回 1 会让第一条 v2 指向一段不存在的 v1 历史（commit.ts 的注释）。
    expect(r.graphVersion).toBe(1);
    expect(versionAt(db)).toBe(1);
  });

  it("连续两次提交 ⇒ 版本递增，graph_json 是【变更后】的图", async () => {
    const { db, w } = await newDb();
    const g = graph();
    const a = await commitOrgGraph(w, {
      graph: g,
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "第一次",
    });
    const after1 = applyChangeToGraph(g, REPARENT);
    const b = await commitOrgGraph(w, {
      graph: after1,
      change: { kind: "add_edge", edge: { from: "test", to: "tech", review_gate: true } },
      actor: CEO,
      runningTasks: [],
      nowMs: NOW + 1,
      changeSummary: "第二次",
    });
    if (!a.ok || !b.ok) throw new Error("两次都应提交成功");
    expect([a.graphVersion, b.graphVersion]).toEqual([1, 2]);

    const saved = readGraphByVersion(db, 2);
    expect(saved.nodes["dev"]?.reports_to).toBe(CEO_ROLE_ID); // 第一次的效果还在
    expect(saved.edges.length).toBe(4); // 第二次的边也在
    // v1 仍然读得出来 —— 版本化是【追加】而不是就地改（§18.4 那句「版本切换」）。
    expect(readGraphByVersion(db, 1).nodes["dev"]?.reports_to).toBe(CEO_ROLE_ID);
    expect(readGraphByVersion(db, 1).edges.length).toBe(3);
  });

  it("审计一条：action=state_change、task_id 为 NULL、快照含 before/after", async () => {
    const { db, w } = await newDb();
    const g = graph();
    const r = await commitOrgGraph(w, {
      graph: g,
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "dev 改汇报到 CEO",
    });
    if (!r.ok) throw new Error("应提交成功");
    const e = db.prepare("SELECT * FROM events WHERE id = ?").get(r.auditSeq) as Row;
    expect(e["action"]).toBe("state_change");
    expect(e["actor_type"]).toBe("human");
    expect(e["actor_id"]).toBe(CEO_ROLE_ID);
    // task_id 为 NULL：组织级审计不属于任何任务。cli.ts 那两处回放查询带
    // WHERE task_id = ?，所以这类行不会混进单任务时间线（见 commit.ts）。
    expect(e["task_id"]).toBeNull();
    // target 是版本号而不是 UUID：回放问的是「第几版改的」。
    expect(e["target"]).toBe("1");
    const snap = JSON.parse(String(e["state_snapshot"])) as {
      before: OrgGraph;
      after: OrgGraph;
    };
    expect(snap.before.nodes["dev"]?.reports_to).toBe("tech");
    expect(snap.after.nodes["dev"]?.reports_to).toBe(CEO_ROLE_ID);
    const payload = JSON.parse(String(e["payload"])) as Record<string, unknown>;
    expect(payload["kind"]).toBe("org_graph_changed");
    expect(payload["graph_version"]).toBe(1);
  });

  it("审计里的 after 快照【就是落库的那张图】（不是前端传来的那份）", async () => {
    // 这条防的是「审计说组织成了 A 而库里是 B」—— 快照由 commitOrgGraph 自己算，
    // 但如果不钉住，下一个人可以让它直接序列化调用方传的东西，两者一漂就查无对证。
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    if (!r.ok) throw new Error("应提交成功");
    const e = db.prepare("SELECT state_snapshot FROM events WHERE id = ?").get(r.auditSeq) as Row;
    const snap = JSON.parse(String(e["state_snapshot"])) as { after: OrgGraph };
    expect(JSON.stringify(snap.after)).toBe(
      JSON.stringify(readGraphByVersion(db, r.graphVersion)),
    );
  });

  it("非 CEO 发起 ⇒ 拒，且【三张表一行都没动】", async () => {
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: { type: "human", id: "tech" },
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    expect(r.ok).toBe(false);
    expect(versionAt(db)).toBe(0);
    expect(count(db, "delegation_graphs")).toBe(0);
    expect(count(db, "events")).toBe(0);
  });

  it("非法变更（成环）⇒ 拒，同样零写入 —— 校验在开事务【之前】", async () => {
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      // tech 的下级含 dev，把 tech 挂到 dev 之下成环。
      change: { kind: "reparent", child_role: "tech", new_parent_role: "dev" },
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("would_create_cycle");
    expect(count(db, "delegation_graphs")).toBe(0);
    expect(count(db, "events")).toBe(0);
  });

  it("三种 change kind 都真的过校验（漏一个 kind = 那种变更不校验）", async () => {
    const { db, w } = await newDb();
    // add_edge：无门控 ⇒ 该拒（L2 判据，不是 L3）。
    const e = await commitOrgGraph(w, {
      graph: graph(),
      change: { kind: "add_edge", edge: { from: "dev", to: "test", review_gate: false } },
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.code).toBe("missing_review_gate");
    // agent 顶着 ceo 的 id ⇒ L3 拒（这一维与 kind 无关，两种 kind 各测一次）。
    const agent: OrgActor = { type: "agent", id: CEO_ROLE_ID };
    for (const change of [
      REPARENT,
      { kind: "add_edge", edge: { from: "dev", to: "ceo", review_gate: true } } as OrgChange,
    ]) {
      const r = await commitOrgGraph(w, {
        graph: graph(),
        change,
        actor: agent,
        runningTasks: [],
        nowMs: NOW,
        changeSummary: "x",
      });
      expect(r.ok).toBe(false);
    }
    expect(count(db, "delegation_graphs")).toBe(0);
  });
});

describe("② 计划 Test ①：保存失败 ⇒ 版本号不变、无半提交行", () => {
  /**
   * 在 role_charters 上装一只【必然失败】的触发器，用来制造一次
   * 「delegation_graphs 已经插入成功之后」才爆的事务内失败。
   *
   * 为什么用触发器而不是造数据冲突：我第一版写的是「预插一条 dev 的 v2 岗位书，
   * 让 commit 的 INSERT 撞 UNIQUE(role_id, version)」，跑出来是【promise 没 reject】。
   * 那不是断言太弱，是我的前提不成立 —— commit 走 LATEST_CHARTER_SQL 读到 v1、
   * 写的是 v2，可我要撞的正是 v2 那一行……预置的那条【被读到而不是被撞上】。
   * 换句话说那条用例永远不会失败，而它以「期望抛错」的形式出现，
   * 于是红了以后会被读成「回滚坏了」。写在这里是因为这个错法很有代表性：
   * **夹具想制造失败，得先确认那条失败在真实代码路径上可达。**
   *
   * 触发器则与生产故障同形：SQLite 在语句执行期 RAISE(ABORT)，
   * 前面的语句已在这个事务里写过。真实世界里这一发是磁盘满、是 FK 违例、
   * 是 events 上那只 append-only 触发器被误撞 —— 形状都是「事务中途一条语句炸」。
   */
  const BOOM = "org_commit_boom";
  function armFailure(db: Db): void {
    db.exec(
      "CREATE TRIGGER " + BOOM + " BEFORE INSERT ON role_charters " +
        "BEGIN SELECT RAISE(ABORT, 'fixture 故意让岗位书写入失败'); END",
    );
  }
  function disarmFailure(db: Db): void {
    db.exec("DROP TRIGGER " + BOOM);
  }

  it("中途失败 ⇒ 版本不涨、图行与审计行【一起】消失", async () => {
    const { db, w } = await newDb();
    charter(db, "dev", 1, "tech"); // 有上一版 ⇒ 提交路径真的会去写岗位书（才会撞上触发器）
    armFailure(db);
    const before = snapshot(db);
    await expect(
      commitOrgGraph(w, {
        graph: graph(),
        change: REPARENT,
        actor: CEO,
        runningTasks: [],
        nowMs: NOW,
        changeSummary: "会失败的一次",
      }),
    ).rejects.toThrow(/故意让岗位书写入失败/);

    // 整份快照逐一比对，而不是只挑一行看：
    // 「无半提交」这句话的内容就是【没有任何一行留下】，抽查一行等于没测。
    expect(snapshot(db)).toEqual(before);
    // 版本号单独再断一次，因为它是这份快照里最贵的一格：
    // 涨了而图行没有 ⇒ 下次提交算出的号跳过一段，
    // 而期间建的任务会盖上那个【永远不存在】的版本，直到恢复时才炸。
    expect(versionAt(db)).toBe(0);
  });

  it("回滚后【下一次提交】仍能正常写入（队列没被上一次失败带坏）", async () => {
    const { db, w } = await newDb();
    charter(db, "dev", 1, "tech");
    armFailure(db);
    await expect(
      commitOrgGraph(w, {
        graph: graph(),
        change: REPARENT,
        actor: CEO,
        runningTasks: [],
        nowMs: NOW,
        changeSummary: "失败",
      }),
    ).rejects.toThrow();
    disarmFailure(db);
    const ok = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW + 1,
      changeSummary: "重试",
    });
    expect(ok.ok).toBe(true);
    expect(versionAt(db)).toBe(1);
  });

  it("审计那一发失败 ⇒ 图行也一起消失（审计与图行【同一个事务】）", async () => {
    // 上一条让【岗位书】失败，这一条让【审计】失败。两条都要，
    // 因为 §18.4 ③ 那句「同一事务写两张表 + 一条审计」是三件事：
    // 只测岗位书，实现可以「图行 + 审计一个事务，岗位书另一个事务」而全绿；
    // 只测审计，反过来一样。审计那一发尤其要紧 —— events 是事实源（§5.8），
    // 「组织变了而审计里没有那一行」比失败本身更糟：回放会以为组织从没动过。
    const { db, w } = await newDb();
    charter(db, "dev", 1, "tech");
    db.exec(
      "CREATE TRIGGER events_boom BEFORE INSERT ON events " +
        "BEGIN SELECT RAISE(ABORT, 'fixture 故意让审计写入失败'); END",
    );
    await expect(
      commitOrgGraph(w, {
        graph: graph(),
        change: REPARENT,
        actor: CEO,
        runningTasks: [],
        nowMs: NOW,
        changeSummary: "审计写不进去",
      }),
    ).rejects.toThrow(/故意让审计写入失败/);
    expect(count(db, "delegation_graphs")).toBe(0);
    expect(versionAt(db)).toBe(0);
  });

  it("失败的那次【不占版本号】：重试拿到的是 1 而不是 2", async () => {
    // 上一条断的是「能重试成功」，这一条断的是「重试拿到几号」。
    // 分开写是因为它们会分别坏：MAX(version) 若在事务外算、
    // 或失败时先 INSERT 了一行占位，第一次失败就会把 1 号吃掉，
    // 于是重试写出 2 号 —— 库里 v1 缺位，而 change_summary 会说这是「重试」，
    // 回放里看不出少了一版。
    const { db, w } = await newDb();
    charter(db, "dev", 1, "tech");
    armFailure(db);
    await expect(
      commitOrgGraph(w, {
        graph: graph(),
        change: REPARENT,
        actor: CEO,
        runningTasks: [],
        nowMs: NOW,
        changeSummary: "失败",
      }),
    ).rejects.toThrow();
    disarmFailure(db);
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW + 1,
      changeSummary: "重试",
    });
    if (!r.ok) throw new Error("重试应成功");
    expect(r.graphVersion).toBe(1);
    expect(readGraphByVersion(db, 1).nodes["dev"]?.reports_to).toBe(CEO_ROLE_ID);
  });

  /** 四张相关表的行数 + 当前版本，一次取全。 */
  function snapshot(db: Db): Record<string, number> {
    return {
      graphs: count(db, "delegation_graphs"),
      charters: count(db, "role_charters"),
      events: count(db, "events"),
      tasks: count(db, "tasks"),
      version: versionAt(db),
    };
  }
});

describe("③ 计划 Test ②：运行中任务在组织变更后仍用旧版图", () => {
  it("提交组织变更【不碰任何在跑任务的 graph_version】", async () => {
    const { db, w } = await newDb();
    task(db, "run-1", "IN_PROGRESS", 1);
    task(db, "run-2", "IN_REVIEW", 1);
    // 先提交一版，让「当前版本」变成 1。变更后新任务该拿到 1，而在跑的必须还是 1（我们没动）。
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: ["run-1", "run-2"],
      nowMs: NOW,
      changeSummary: "x",
    });
    expect(r.ok).toBe(true);
    const rows = db
      .prepare("SELECT id, graph_version FROM tasks ORDER BY id")
      .all() as Row[];
    expect(rows.map((x) => [x["id"], Number(x["graph_version"])])).toEqual([
      ["run-1", 1],
      ["run-2", 1],
    ]);
    // 断言的准确边界见文件头：这里证的是【版本坐标不被覆盖】，
    // 不是「那条任务的图真的按旧版跑」（那要真起 LangGraph 恢复，本机跑不了）。
  });

  it("运行中任务清单【只认 DELIVERED/ARCHIVED 为结束】", async () => {
    const { db } = await newDb();
    task(db, "a", "IN_PROGRESS");
    task(db, "b", "DELIVERED");
    task(db, "c", "ARCHIVED");
    task(db, "d", "CHARTER_PENDING");
    task(db, "e", "BLOCKED");
    const ids = (db.prepare(RUNNING_TASKS_SQL).all() as Row[]).map((r) => String(r["id"]));
    expect(ids).toEqual(["a", "d", "e"]);
    // BLOCKED / BUDGET_PAUSED 这类【暂停】必须算运行中：暂停的任务恢复时会按
    // 创建时版本继续，把它当结束会让「变更只对新任务生效」这句话漏掉它。
  });

  it("有运行中任务 ⇒ 提交【成功】但带 needsConfirmation（不是拒绝）", async () => {
    const { db, w } = await newDb();
    task(db, "run-1", "IN_PROGRESS", 1);
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: ["run-1"],
      nowMs: NOW,
      changeSummary: "x",
    });
    if (!r.ok) throw new Error("有运行中任务不是拒绝理由（§18.3 给的是 needsConfirmation）");
    expect(r.needsConfirmation).toContain("1");
    expect(versionAt(db)).toBe(1); // 确实提交了
    // 确认话术要进审计可见的范围：payload 里有 running_task_count。
    const e = db.prepare("SELECT payload FROM events WHERE id = ?").get(r.auditSeq) as Row;
    expect(JSON.parse(String(e["payload"]))["running_task_count"]).toBe(1);
  });
});

describe("④ 计划 Test ③：新任务用新版图 + 版本缺失不静默兜底", () => {
  /** 走【真建任务路径】而不是本文件的 task() 夹具：这一节要证的正是那条路径会盖版本。 */
  async function newTask(w: any, id: string): Promise<void> {
    await insertTask(w, { id, title: "新任务 " + id, assignedRole: "intake", nowMs: NOW });
  }
  const versionOf = (db: Db, id: string): number =>
    Number((db.prepare("SELECT graph_version FROM tasks WHERE id = ?").get(id) as Row)["graph_version"]);

  it("一张图都没提交过时，新任务盖的是 0 而不是列默认值 1", async () => {
    // 这一条是本文件最该存在的一条，因为它测的是【本轮补上的那个洞】。
    // 补之前：`grep -rn "graph_version" packages/hub/src` 除注释外 0 命中，
    // 每条任务都躺在 0001_init.sql:49 那个 DEFAULT 1 上，而 delegation_graphs 里
    // 1 号版本一行都没有 —— 「旧任务按创建时版本恢复」的前提根本不成立。
    // 单看这条会以为「0 也是随手写死的」，所以下一条把它钉成【跟着最新走】。
    const { db, w } = await newDb();
    await newTask(w, "new-0");
    expect(versionOf(db, "new-0")).toBe(0);
  });

  it("新任务盖的是【当时最新】那一版，而不是恒 1、也不是事后刷成最新", async () => {
    const { db, w } = await newDb();
    await newTask(w, "new-0"); // v0：还没有任何版图
    const g = graph();
    const r1 = await commitOrgGraph(w, {
      graph: g,
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "v1",
    });
    await newTask(w, "new-1");
    if (!r1.ok) throw new Error("应提交成功");
    expect(versionOf(db, "new-1")).toBe(r1.graphVersion);

    const r2 = await commitOrgGraph(w, {
      graph: applyChangeToGraph(g, REPARENT),
      change: { kind: "add_edge", edge: { from: "test", to: "tech", review_gate: true } },
      actor: CEO,
      runningTasks: [],
      nowMs: NOW + 1,
      changeSummary: "v2",
    });
    await newTask(w, "new-2");
    if (!r2.ok) throw new Error("应提交成功");
    expect(versionOf(db, "new-2")).toBe(2);
    // 三条任务各留各的版本。这条断言防的是「建任务时不写、查询时统一取最新」
    // 那种写法 —— 它能让本文件上面三条全绿，而运行中任务的版本坐标全是假的。
    expect([versionOf(db, "new-0"), versionOf(db, "new-1"), versionOf(db, "new-2")]).toEqual([
      0, 1, 2,
    ]);
  });

  it("【同一张图】上先后建的两条任务版本相同（版本取自库而不是取自请求参数）", async () => {
    // 反向用例：如果实现把 graph_version 做成了 createTask 的入参，
    // 那它就由调用方说了算 —— 前端传 1 就是 1，版本化当场失效而没有任何报错。
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "v1",
    });
    if (!r.ok) throw new Error("应提交成功");
    await newTask(w, "a");
    await newTask(w, "b");
    expect([versionOf(db, "a"), versionOf(db, "b")]).toEqual([1, 1]);
  });

  it("建任务【一次写入】就带上版本：不允许再发第二次 UPDATE", async () => {
    // 这一条区分的是【写法】而不是【终值】，所以它不能被上面那几条代替。
    // 「先 INSERT（吃 DEFAULT 1）再 UPDATE 成最新版」这种写法，
    // 在单线程测试里最终结果与现在的实现【逐字节相同】—— 上面每一条断言都会绿。
    // 差别只在中间那段窗口：崩在两次写之间，库里就永久留下一行 graph_version = 1
    // 而 delegation_graphs 里 v1 一行都没有的任务（这正是本轮补掉的那个洞的形状）。
    // 所以断言得打在【会不会发第二次写】上：这里禁掉 tasks 上的 UPDATE，
    // 一次写入的写法照样成功，两段写法当场被触发器拦下来。
    const { db, w } = await newDb();
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "v1",
    });
    if (!r.ok) throw new Error("应提交成功");
    db.exec(
      "CREATE TRIGGER no_second_write BEFORE UPDATE ON tasks " +
        "BEGIN SELECT RAISE(ABORT, '建任务不该发第二次写'); END",
    );
    await newTask(w, "one-shot");
    expect(versionOf(db, "one-shot")).toBe(1);
  });

  it("旧任务读自己那一版 ⇒ 读到的是【当时】的图，不是最新图", async () => {
    const { db, w } = await newDb();
    const g = graph();
    const r1 = await commitOrgGraph(w, {
      graph: g,
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "v1",
    });
    const r2 = await commitOrgGraph(w, {
      graph: applyChangeToGraph(g, REPARENT),
      change: { kind: "add_edge", edge: { from: "test", to: "tech", review_gate: true } },
      actor: CEO,
      runningTasks: [],
      nowMs: NOW + 1,
      changeSummary: "v2",
    });
    if (!r1.ok || !r2.ok) throw new Error("应都提交成功");
    const v1 = readGraphByVersion(db, 1);
    const v2 = readGraphByVersion(db, 2);
    expect(v1.edges.length).toBe(3);
    expect(v2.edges.length).toBe(4);
  });

  it("版本不存在 ⇒ 【抛错】而不是退回最新版", async () => {
    // 兜底成最新图 = 让旧任务在新汇报关系下继续跑（§18.4 阶段 3 要防的正是这个），
    // 而它会以「一次正常的运行」的面目出现，事后无从发现。
    const { db } = await newDb();
    expect(() => readGraphByVersion(db, 99)).toThrow(/版本 99/);
  });

  it("只给【汇报关系真的变了】的角色写新岗位书版本", async () => {
    // 规格 §18.4 说「role_charters（version + 1）」。全部 +1 会造出一堆
    // 内容与上一版相同、版本号不同的行，让「v6→v7 改了什么」得到「什么都没改」。
    const { db, w } = await newDb();
    charter(db, "dev", 1, "tech");
    charter(db, "test", 1, "tech");
    charter(db, "tech", 1, CEO_ROLE_ID);
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT, // 只有 dev 的 reports_to 变了
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    if (!r.ok) throw new Error("应提交成功");
    expect(r.charterBumpedRoles).toEqual(["dev"]);
    const rows = db
      .prepare("SELECT role_id, version FROM role_charters ORDER BY role_id, version")
      .all() as Row[];
    expect(rows.map((x) => x["role_id"] + ":" + x["version"])).toEqual([
      "dev:1",
      "dev:2",
      "tech:1",
      "test:1",
    ]);
    // 新那一行的 config 里 reportsTo 必须真的变了。写错键名（reports_to）不会报错，
    // 只会得到一份「汇报关系变了而 config 没变」的行 —— 那就是伪证。
    const v2 = db.prepare("SELECT config FROM role_charters WHERE role_id='dev' AND version=2")
      .get() as Row;
    expect(JSON.parse(String(v2["config"]))["reportsTo"]).toBe(CEO_ROLE_ID);
    expect(JSON.parse(String(v2["config"]))["acceptanceCriteria"]).toEqual([
      { condition: "c", action: "reject", message: "m" },
    ]); // 其余字段从上一版继承，没被丢
  });

  it("图里有个角色【没有】岗位书 ⇒ 跳过它，不编一份出来", async () => {
    // 编一份得虚构 acceptance_criteria 等必填字段，而那些字段的语义属 CEO
    //（0008 §7 立的正是这件事不由实现层代笔）。跳过是少写，编造是伪证。
    const { db, w } = await newDb();
    charter(db, "tech", 1, CEO_ROLE_ID); // 故意不建 dev 的
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "x",
    });
    if (!r.ok) throw new Error("应提交成功");
    expect(r.charterBumpedRoles).toEqual([]);
    expect(count(db, "role_charters")).toBe(1); // 只有预置那条 tech v1
    expect(versionAt(db)).toBe(1); // 图版本照常涨：跳过岗位书不影响图提交
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   ⑤ 组织变更**不发事件**，于是它消费掉的那个 events.id 成为一个 seq 空洞。
   这一节横跨两个包，理由与边界如下。

   为什么会有空洞：commitOrgGraph 的入参是 `w: Writer`（= Pick<WriteQueue,"node">），
   它**结构上拿不到总线**，所以那一行审计写完，没有人 publish。
   下一次有人 publish 时用的 seq 是新的 events.id ⇒ 对活跃订阅者就是跳号。

   为什么这一节要同时 import hub 与 web：这条性质的**成因住在 hub、后果住在 web**。
   两侧各自看都是对的 —— hub 侧「审计落库了」，web 侧「applyItem 的 default 分支
   会推进 cursor」—— 而**没有任何一个包的测试看得见另一侧**。
   这正是 0010 §2 记过的那个形状（appendAudit 消费了 events.id 而一字节未广播，
   投影层把 seq 空洞读成链路降级），那次是修 hub 侧，这次要先确认**后果是什么**：
   如果是「静默吸收」，那是缺陷；如果是「标 stale 去重拉快照」，那是**正确行为**
   （组织图的形状本来就不在任务投影里，唯一正确的反应就是去拿全量）。
   这条判据不能靠读代码下结论，所以实测。
   ───────────────────────────────────────────────────────────────────────── */
describe("⑤ 组织变更留下的 seq 空洞：必须被【检出】而不是被静默吸收", () => {
  it("空洞之后的第一条事件 ⇒ 投影标 stale 并要求重拉快照", async () => {
    const { applyEvent, emptyProjection, applySnapshot } = await import(
      "../../packages/web/src/hub/projection.js"
    );
    const { db, w } = await newDb();
    // 第 1 号事件：一次正常的任务状态变更，正常 publish（seq = 1）。
    const r = await commitOrgGraph(w, {
      graph: graph(),
      change: REPARENT,
      actor: CEO,
      runningTasks: [],
      nowMs: NOW,
      changeSummary: "这次不广播",
    });
    if (!r.ok) throw new Error("应提交成功");
    // 组织那一行占掉的 id 就是 1（库里第一条事件）。
    expect(r.auditSeq).toBe(1);

    let p = applySnapshot(emptyProjection(), { tasks: [], asOfMs: NOW, asOfSeq: 0 });
    p = applyEvent(p, {
      seq: 1,
      kind: "TaskStateChanged",
      taskId: "t-1",
      from: "IN_PROGRESS",
      to: "IN_REVIEW",
    } as never).projection;
    expect(p.cursor).toBe(1);

    // 之后的事件 id = 2。因为 1 号被组织变更吃掉且没广播，订阅者的游标停在 1，
    // 收到 seq=1 的那条其实是它【本不该收到】的（组织那一行才是 1 号）——
    // 上面那一笔喂的是「org 之外的一条事件」，真实场景里订阅者收到的是 2 号。
    // 于是这里按真实形状重放：游标 0，第一条到达的是 seq=2。
    let q = applySnapshot(emptyProjection(), { tasks: [], asOfMs: NOW, asOfSeq: 0 });
    const out = applyEvent(q, {
      seq: 2,
      kind: "TaskStateChanged",
      taskId: "t-1",
      from: "IN_PROGRESS",
      to: "IN_REVIEW",
    } as never);
    // 三件事按重要性排序：
    //  ① 检出（action=gap、link=stale）⇒ 会被修，代价是多一次快照；
    //  ② 没检出而照常应用 ⇒ 缺陷：组织变更后界面【看起来正常】而缺了一段历史；
    //  ③ 检出但把事件丢了 ⇒ 也只是多一次快照，与 ① 同类。
    expect(out.projection.link).toBe("stale");
    expect(out.action).toBe("gap");
    // cursor 不前进：这是「同一个洞只计一次」那条规则的前提。
    expect(out.projection.cursor).toBe(0);
  });

  it("未知 kind 本身【不会】被拒也不会被当成洞（空洞只由 seq 判定）", async () => {
    // 分开测是因为这两条判据容易混：feedItemSchema 的 kind 是 z.string().min(1)
    // 而 .passthrough()，applyItem 的 default 分支只推进 cursor。
    // 所以「组织变更不广播」这件事**不会**表现为「前端解不开某一帧」，
    // 只会表现为 seq 跳号 —— 修法也因此只能是「多发一种事件」或「接受多一次快照」，
    // 而不是「让前端学会认这个 kind」。
    const { applyEvent, emptyProjection, applySnapshot } = await import(
      "../../packages/web/src/hub/projection.js"
    );
    const base = applySnapshot(emptyProjection(), { tasks: [], asOfMs: NOW, asOfSeq: 0 });
    const out = applyEvent(base, { seq: 1, kind: "OrgGraphChanged", taskId: "x" } as never);
    expect(out.action).toBe("applied");
    expect(out.projection.cursor).toBe(1);
    expect(out.projection.link).not.toBe("stale");
  });
});
