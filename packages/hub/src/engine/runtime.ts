/**
 * 装配层：把 dispatch 需要的那一排回调接到真库上。
 *
 * dispatch.ts 刻意不 import 这些 SQL —— 它只吃回调，判定逻辑因此能在临时库上逐条测。
 * 这一层是那些回调唯一的真实现，也就是【装配错一次、线上每次都错】的那一层，
 * 所以下面每一格都写清「读错 / 写错的后果」。
 *
 * ── 为什么读用只读连接而写用 node() ──────────────────────────────────
 * dispatch 的多数回调（loadTask / modelFamily / roleSession / recentSummaries /
 * lastProducer / ceoApproved）是【同步】签名，而异步的 queue.read() / node() 它们
 * 都 await 不了。所以读走 queue.readConnection()（§5.5：读是独立连接，物理只读，
 * 与 http/app.ts、real-deps.ts:667 的 deps.db 同一个来源）；写只有两处
 * （记账、harness_calls），都走 node() 或跑在 dispatch 自己那个事务里。
 *
 * ⚠ 一个必须说清的边界：只读连接在 WAL 下看到的是【最新已提交】，而 dispatch 的
 * 写入在它自己那个 node() 里才提交。所以【同一轮内】先写后读会读到旧值。
 * 本层所有回调都只在【一轮开始前后】各读一次，没有这种「读自己刚写的东西」的用法；
 * 新增回调时必须先确认这一点，写进去却从只读连接读回来 = 恒读不到。
 *
 * ── 为什么会话落在 harness_calls 而不是新表 ──────────────────────────
 * §5.9 要「打回时恢复上下文而不是从零开始」，实现上就是 (task, role) → session_id
 * 要存下来。候选是新开一张 role_sessions，而 harness_calls（0001，§12.7 第 4 层）
 * 本来就有 task_id / agent_role / session_id / cost_cents / created_at，语义正是
 * 「某角色在某任务上跑了一次外部 agent」。新开一张表会造出【两份同一事实】
 * （一次执行同时是一条 harness 调用和一行会话，两者可以不一致 = 那次执行没进
 * §12.7 第 4 层审计）。复用顺带把 integrity.ts 的 harness_call_recorded
 * 从恒 not_observable（0018 §9 实测 src 里零 INSERT）变成【有对象可查】。
 */
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { OrgGraph } from "@opc/contracts";
import {
  usdToCents,
  resolveCeoRoleId,
  type CostHook,
  type DispatchDeps,
  type DispatchTask,
  type TurnOutcome,
} from "./dispatch.js";
import { runRole } from "./claude.js";
import { readGraphByVersion } from "../org/commit.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { HubWriter } from "../db/write-queue.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import type { TaskState } from "../graph/status.js";

type Row = Record<string, unknown>;

/** 读一条任务的最小字段。列名写死而不是 SELECT *：加列不该悄悄改变 loadTask 的形状。 */
export const LOAD_TASK_SQL =
  "SELECT id, title, status, assigned_role, graph_version FROM tasks WHERE id = ?";

/**
 * 该角色在这个任务上【上一次】的会话 id。
 *
 * 条件是 session_id IS NOT NULL 而不是「取最近一行」：失败的那次执行可能压根没拿到
 * session_id（CLI 没起来就是 null）。按后者写会取到 NULL ⇒ 下一轮不 --resume，
 * 于是【一次 CLI 启动失败】会把这个角色永久打回「从零开始」，而它的症状只是「变慢了」，
 * 没人会去查。第二级排序用 id（插入序）而不是只按 created_at：同一毫秒内的两次
 * 执行按时间排不出先后，答案取决于查询计划。
 */
export const LAST_SESSION_SQL =
  "SELECT session_id FROM harness_calls " +
  "WHERE task_id = ? AND agent_role = ? AND session_id IS NOT NULL " +
  "ORDER BY created_at DESC, id DESC LIMIT 1";

/**
 * 一次执行落一行 harness_calls（§12.7 第 4 层）。
 *
 * args_redacted 里【只放不影响隐私的东西】：那一列的名字就是 redacted，而 prompt
 * 由 CEO 输入、可能带业务机密，原文进库等于把 §12.7 的脱敏要求整条跳过。
 * 这一列真正要能回答的是「哪个 harness / 哪个会话 / 花多少 / 成没成」，四样都有列。
 */
export const INSERT_HARNESS_CALL_SQL =
  "INSERT INTO harness_calls (id, task_id, agent_role, harness, harness_version, " +
  "args_redacted, session_id, exit_code, cost_cents, created_at) " +
  "VALUES (?, ?, ?, 'claude-code', ?, ?, ?, ?, ?, ?)";

/** 最近的汇报摘要（新→旧），喂进简报。summary 在 events.payload 里，没有独立列。 */
export const RECENT_SUMMARIES_SQL =
  "SELECT payload FROM events WHERE task_id = ? AND action = 'state_change' " +
  "ORDER BY id DESC LIMIT ?";

/** 找最近一次【提交审阅】的产出方角色（§8.2 第 1 条判独立性的输入）。窗口 20 条足够：一条任务跑不出 20 次提交。 */
export const PRODUCER_SCAN_SQL =
  "SELECT payload FROM events WHERE task_id = ? AND action = 'state_change' " +
  "ORDER BY id DESC LIMIT 20";

/**
 * 「这条想法已经被打回几次」—— §4.2.1 `max_rejections` 的分子。
 *
 * 为什么数 events 而【不】数 tasks.status、也不新开一列：
 * 打回这件事的【事实源】就是那条 `payload.$.to = 'REJECTED_DOWNWARD'` 的状态边
 * （dispatch 那一轮写的，append-only）。数 tasks 行只会得到"现在是不是被打回态"
 * —— 而任务早已被 AUTO_AFTER_EDGE 落到 IN_PROGRESS 重做了，那个数恒为 0。
 * 新开一列 rejection_count 则要过一次迁移，并且造出【两份同一事实】
 * （计数器与那串边可以不一致 = 又一处"账面与审计各说一半"）。
 *
 * ⚠ 数的是 `to`，不是 `action`。一条打回写【两条】边（REJECTED_DOWNWARD 那一跳
 * 加上 AUTO_AFTER_EDGE 自动补的 IN_PROGRESS 那一跳，见 dispatch 的 chain），
 * 而只有第一条的 `to` 是 REJECTED_DOWNWARD —— 所以这个 COUNT 恰好等于打回次数，
 * 不会翻倍。这一点是这条 SQL 全部的正确性所在，被 driver 那条注释说反过一次，
 * 所以由 runtime.test.ts 那条"打回一轮 ⇒ 恰好 +1"的断言守着（不是靠这段注释）。
 *
 * 不用 LIMIT 窗口：窗口会【少数】，而少数直接等于上限晚触发（多烧钱），
 * 与 PRODUCER_SCAN_SQL 那种"找第一条"的用法不同 —— 那里窗口只影响找不找得到。
 */
export const REJECTION_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND action = 'state_change' " +
  "AND json_extract(payload, '$.to') = 'REJECTED_DOWNWARD'";

/** 同一件事是否已被 CEO 批过（同源审阅的放行凭据）。 */
export const CEO_APPROVED_SQL =
  "SELECT 1 AS hit FROM approvals WHERE task_id = ? AND card_key = ? AND status = 'approved' LIMIT 1";

/**
 * 记账三句：声明任务级上限 → 幂等插一笔 budget_events → 扣减。
 *
 * ⚠ 这里【不用】BudgetTracker.consume，尽管它写的就是这两句：那个方法开头要求
 * recorder.inStepTx()（超步事务的责任方是 recorder.run，tracker.ts:174），
 * 而 engine/ 这条路线上【没有超步】—— 事务责任方是 WriteQueue.node()。
 * 硬套的结局是每次记账都抛「必须在超步事务内调用」：一次对的报错配一个错的场景。
 * 于是它的三条不变量在这里逐条照抄：① 金额必须是安全整数且非负（负数 = 凭空加额度）；
 * ② 先确认 budgets 里有行、再烧幂等键（否则插入成功而扣减失败，此后每次重试都被
 *    ON CONFLICT 判成「已记过」，那笔钱永远记不上）；③ source_event = events.id 当幂等键。
 *
 * 没抄的是第 4 条：它跨过上限时发 BudgetPaused。发不了 —— §7.1 只有
 * IN_REVIEW → BUDGET_PAUSED 一条入边，从 IN_PROGRESS / DECOMPOSING 硬停【没有合法落点】，
 * 而为记账现造一条状态边就是把状态机改成规格没有的样子。缺口登记在 0041 §7。
 */
export const ENSERT_TASK_BUDGET_SQL =
  "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +
  "VALUES (?, 'task', ?, 'per_task', ?, 0, 1) ON CONFLICT(scope_type, scope_id, period) DO NOTHING";
export const BUDGET_EVENT_SQL =
  "INSERT INTO budget_events (source_event, scope_type, scope_id, period, amount_cents, task_id, created_at) " +
  "VALUES (?, 'task', ?, 'per_task', ?, ?, ?) ON CONFLICT(source_event) DO NOTHING";
export const ADD_TASK_BUDGET_SQL =
  "UPDATE budgets SET consumed_cents = consumed_cents + ? " +
  "WHERE scope_type = 'task' AND scope_id = ? AND period = 'per_task'";

export interface RuntimeDeps {
  /** 写入方。要的是 HubWriter：写走 node()，读走那个物理只读的连接。 */
  readonly writer: HubWriter;
  readonly bus: EventBus;
  /** 这一轮给角色的美元硬顶，直接落到 --max-budget-usd。不给默认值（见 0041 §8）。 */
  readonly maxBudgetUsd: number;
  /** 任务级预算上限（美分），第一次记账时声明。同样不给默认。 */
  readonly taskLimitCents: number;
  /** agent 的工作目录：它能看到哪些文件由这一格决定（§12 的沙箱那一维）。 */
  readonly cwd: string;
  /** claude 二进制名/路径。测试注入桩 CLI 走这一格（与 claude.ts 的 bin 同一个入口）。 */
  readonly bin?: string;
  readonly ceoRoleId?: string;
  /** 简报里带几条最近汇报。 */
  readonly summaryWindow?: number;
  readonly nowMs?: () => number;
  /** 装进 harness_calls.harness_version 的字符串（CLI 版本）。 */
  readonly harnessVersion?: string;
}

export interface EngineRuntime {
  readonly deps: DispatchDeps;
  /**
   * 把这一轮的执行落到 harness_calls（§12.7 第 4 层）。
   *
   * 【不在 runTurn 里写、也不在 dispatch 的事务里写】，是这个接口形状的原因：
   *  · 不能在 dispatch 那个事务里 —— 会话与账单记录的是【这一次执行发生了】，
   *    它与「这条状态边合不合法」是两件事。捆在一起的话，状态守卫拦下那一轮时
   *    harness_calls 也跟着回滚，于是【真花掉的 token 在执行日志里消失】，
   *    而 §12.7 第 4 层要的正是「每次调用都留痕」。
   *  · 不能在 runTurn 里 —— 那时还没有 events.id 之外的坐标问题，但更麻烦的是
   *    runTurn 的返回类型是 TurnOutcome，dispatch 拿到它就先去判定与写库；
   *    在里面偷偷开一个 node() 会让「谁负责提交」变成两个答案（0005 §11 缺陷 C）。
   * 所以驱动方在 dispatch 返回之后调它一次。漏调的后果写在返回值上（见 recorded）。
   */
  recordTurn(o: {
    readonly taskId: string;
    readonly role: string;
    readonly sessionId: string | null;
    readonly costCents: number;
    readonly ok: boolean;
    readonly nowMs: number;
  }): Promise<{ readonly recorded: boolean; readonly why: string }>;
}

function text(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function payloadOf(row: Row): Row {
  try {
    const p: unknown = JSON.parse(text(row["payload"], "null"));
    return typeof p === "object" && p !== null ? (p as Row) : {};
  } catch {
    // 一行脏 payload 不该让整轮跑不起来：回退成「这句没有」。
    // 方向与 serializePayload 相反是有理由的：那边写脏是【伪造审计】要抛，
    // 这边读脏只影响简报的丰富度，而为一行历史脏数据停掉整家公司是错的取舍。
    return {};
  }
}

/**
 * 建一套真回调 + 一轮执行留痕。返回的 deps 直接喂 makeDispatch。
 *
 * 图【按任务缓存一份】：modelFamily / rolePrompt 这些回调只拿到 roleId，
 * 没有缓存的话它们各自去读图，于是一轮里可能出现「审阅判定用 v7、handoff 判据用 v8」
 * —— 那两个判定吃的是同一条汇报关系，读成两个版本就是自相矛盾。
 */
export function makeRuntime(d: RuntimeDeps): EngineRuntime {
  const now = d.nowMs ?? Date.now;
  const read = (): DatabaseSync => d.writer.readConnection();

  let cacheGraph: OrgGraph | null = null;
  let cacheVersion = -1;
  /**
   * 把这【一轮】要用的图钉在任务那一版上。读不出来 ⇒ null。
   *
   * 缓存的意义不是省一次 SELECT（那很便宜），是让一轮里所有只拿到 roleId 的回调
   * （modelFamily / rolePrompt）读到【同一个版本】。各读各的会出现
   * 「审阅判定按 v7、handoff 判据按 v8」，而这两个判定吃的是同一条汇报关系。
   *
   * 不回退到最新图（§18.4）：读不出来就是这一版没有这张图，让 dispatch 那边
   * 以「版本缺失」拒绝。在这里回退等于绕过它那道拒绝，而绕过的表现是一次正常运行。
   */
  const pinGraph = (graphVersion: number): void => {
    if (cacheVersion === graphVersion) return;
    cacheVersion = graphVersion;
    try {
      cacheGraph = readGraphByVersion(read(), graphVersion);
    } catch {
      cacheGraph = null;
    }
  };

  /**
   * 简报里那句「谁是 CEO」。判不出返回 null 而【不返回一个名字】。
   *
   * 用 cacheGraph（loadTask 刚按任务那一版钉好的那份）而不是自己再读一次图：
   * 本文件缓存的意义就是「一轮里所有只拿到 roleId 的回调读到同一个版本」，
   * 在这里 readGraphByVersion 一次等于给「谁是 CEO」开出第二个版本来源 ——
   * 与 modelFamily 那一格同一条理由。
   */
  const ceoForPrompt = (): string | null => {
    if (cacheGraph === null) return null;
    const r = resolveCeoRoleId(d.ceoRoleId, cacheGraph);
    return r.ok ? r.roleId : null;
  };

  const deps: DispatchDeps = {
    writer: d.writer,


    loadTask: (taskId): DispatchTask | null => {
      const row = read().prepare(LOAD_TASK_SQL).get(taskId) as Row | undefined;
      if (row === undefined) return null;
      const task: DispatchTask = {
        id: text(row["id"]),
        title: text(row["title"]),
        status: text(row["status"]) as TaskState,
        role: text(row["assigned_role"]),
        graphVersion: Number(row["graph_version"]),
      };
      // 图跟着任务钉：跨任务复用同一份缓存会让上一单的汇报关系管到这一单。
      pinGraph(task.graphVersion);
      return task;
    },

    modelFamily: (roleId) => {
      const g = cacheGraph;
      // null（图读不出来）⇒ 空串，而空串会让 reviewGate 走 unknown_model_family 拒放行。
      // 这一格【不能】改成返回一个默认家族名：那等于给一个组织图缺失的任务
      // 发一张「它属于哪个模型家族」的身份证，而审阅独立性整个建立在这一点上。
      if (g === null) return "";
      const n = g.nodes[roleId];
      return n === undefined ? "" : text(n.model_family);
    },

    rolePrompt: (roleId) => {
      // ⚠ 岗位书今天【没有生产来源】：role_charters 是空表，而 packages/hub/resources
      // 那几份模板里带着 CEO-PLACEHOLDER-ACCEPTANCE 占位验收标准（我不能替 CEO 填）。
      // 所以这里只给一句最小身份描述，而不是编一份岗位书 —— 编出来的「你的职责是…」
      // 会让 agent 按一份【没有人在纸上认过】的授权干活，那比信息少更糟。
      // 接上真岗位书的口子就是这一格，缺的东西登记在 0041 §6。
      //
      // CEO 那一格【从图里读】而不再写 `?? "ceo"`（0047）：那句回退是本轮修复的一半 ——
      // 它把「顶层是谁」这件【结构事实】降级成了一个字面量，而组织图的根完全可以叫 boss。
      // 判据本体在 dispatch 的 resolveCeoRoleId（只有一份），这里只是它的一个读者。
      //
      // ⚠ 判不出时【不退回任何名字】，而是把"说不出来"这句话原样写进简报。
      // 这不是给提示词留后门：真正的顶层判定在代码里（topmost 那一支），
      // 提示词里那句「谁是 CEO」只影响 agent 会不会在 summary 里喊错名字，
      // 而 dispatch 那道新门根本不会让"图坏了"的这一轮跑到 runTurn。
      // 走到这里还判不出，只可能是 charter 起草那一族【不经 dispatch】的调用方 ——
      // 那种场合编一个 "ceo" 出去，就是让 agent 对着一个不存在的同事汇报。
      const ceo = ceoForPrompt();
      const ceoLine =
        ceo === null
          ? "CEO 是唯一的决策者（这一版组织图里 hub 认不出汇报根，所以【说不出】它的角色名 —— " +
            "这不改变你的动作：下一跳由 hub 按组织图判，不由你判。）"
          : "CEO（角色 " + ceo + "）是唯一的决策者";
      return (
        "你在一人公司里担任角色 [" + roleId + "]。" + ceoLine + "，" +
        "你的汇报对象由 hub 按组织图决定，不由你决定。"
      );
    },

    roleSession: (taskId, roleId) => {
      const row = read().prepare(LAST_SESSION_SQL).get(taskId, roleId) as Row | undefined;
      if (row === undefined) return null;
      const s = text(row["session_id"]);
      return s === "" ? null : s;
    },

    runTurn: async (i): Promise<TurnOutcome> => {
      const r = await runRole({
        prompt: i.prompt,
        rolePrompt: i.rolePrompt,
        ...(i.resumeSessionId === null || i.resumeSessionId === ""
          ? {}
          : { resumeSessionId: i.resumeSessionId }),
        cwd: d.cwd,
        maxBudgetUsd: d.maxBudgetUsd,
        ...(d.bin === undefined ? {} : { bin: d.bin }),
      });
      return {
        ok: r.ok,
        text: r.text,
        costCents: usdToCents(r.costUsd),
        sessionId: r.sessionId,
        error: r.error,
      };
    },

    recentSummaries: (taskId) => {
      const rows = read()
        .prepare(RECENT_SUMMARIES_SQL)
        .all(taskId, d.summaryWindow ?? 6) as Row[];
      const out: string[] = [];
      for (const r of rows) {
        const s = payloadOf(r)["summary"];
        if (typeof s === "string" && s.trim() !== "") out.push(s.trim());
      }
      return out;
    },

    lastProducer: (taskId) => {
      // 往回找【第一条带 producerRole 的】EVIDENCE_SUBMITTED。为什么不查一个列：
      // producerRole 是 dispatch 写进那一行 payload 的（加一列要过一次迁移，
      // 而除独立性判定外它没有别的读方）。
      const rows = read().prepare(PRODUCER_SCAN_SQL).all(taskId) as Row[];
      for (const r of rows) {
        const p = payloadOf(r);
        if (p["to"] === "EVIDENCE_SUBMITTED" && typeof p["producerRole"] === "string") {
          return p["producerRole"];
        }
      }
      return null;
    },

    rejectionCount: (taskId) => {
      // 见 REJECTION_COUNT_SQL：判据是那条 append-only 的状态边，不是 tasks 那一行。
      const row = read().prepare(REJECTION_COUNT_SQL).get(taskId) as { n: number | bigint } | undefined;
      return row === undefined ? 0 : Number(row.n);
    },

    ceoApproved: (taskId, cardKey) =>
      read().prepare(CEO_APPROVED_SQL).get(taskId, cardKey) !== undefined,

    onCost: ((o: Parameters<CostHook>[0]): void => {
      // 金额校验排在最前，跟 tracker.ts 一样：负数 / 小数 / 超大整数一律不记。
      // 「不记」在这里是安全的方向 —— 少记一笔钱会让账面偏乐观，而写坏一行预算账
      // 会让整轮跟着回滚；两者都比不上「拒绝这一笔」清楚。
      if (!Number.isSafeInteger(o.costCents) || o.costCents < 0) return;
      const db = o.db;
      db.prepare(ENSERT_TASK_BUDGET_SQL).run(
        "task|" + o.taskId + "|per_task",
        o.taskId,
        d.taskLimitCents,
      );
      const ins = db
        .prepare(BUDGET_EVENT_SQL)
        .run(o.seq, o.taskId, o.costCents, o.taskId, o.nowMs) as { changes: number | bigint };
      if (Number(ins.changes) === 0) return; // 幂等命中：这一笔已经记过，绝不重复扣
      db.prepare(ADD_TASK_BUDGET_SQL).run(o.costCents, o.taskId);
    }) satisfies CostHook,

    publish: (e: DomainEvent, seq: number): void => {
      d.bus.publishPersisted(e, seq);
    },
  };

  return {
    deps,
    recordTurn: async (o) => {
      // 一轮跑完【必然】留痕，包括失败的那一轮：失败的执行同样花了钱（claude.ts
      // 里那条同源的实测），而 §12.7 第 4 层问的是「调过没有、花了多少」。
      // exit_code 没有那一格：claude.ts 把退出码折进了 ok，这里据实写 0 / 1。
      if (o.costCents < 0) {
        return { recorded: false, why: "costCents 为负，不写入执行日志" };
      }
      try {
        await d.writer.node(() => {
          // node() 里的连接【必须】现取：WriteQueue 的写连接只在作用域里暴露，
          // 而且只有这一句 INSERT 参与那次提交。
          // 调用方标记带上模块名：抛错时一眼看出是谁开的这次事务。
          const db = requireScopeDb("engine.runtime.recordTurn");
          db.prepare(INSERT_HARNESS_CALL_SQL).run(
            randomUUID(),
            o.taskId,
            o.role,
            d.harnessVersion ?? "unknown",
            JSON.stringify({ resumed: o.sessionId !== null, budget_usd: d.maxBudgetUsd }),
            o.sessionId,
            o.ok ? 0 : 1,
            o.costCents,
            o.nowMs,
          );
        });
      } catch (e) {
        // 【不冒泡】：状态与账都已经提交了，留痕失败不该让整条命令非零退出，
        // 因为那会让驱动方【重试整轮】= 又烧一次 token 去补一行日志。
        // 但也不能静默 —— 缺的是 §12.7 第 4 层那一条，返回一个能断言的结论。
        return {
          recorded: false,
          why: "harness_calls 写入失败：" + (e instanceof Error ? e.message : String(e)),
        };
      }
      return { recorded: true, why: "已留痕" };
    },
  };
}
