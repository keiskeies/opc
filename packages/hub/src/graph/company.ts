/**
 * 最小可运行公司图（Task 0.8，规格 §23.3 最小图 + §7.1 状态机 + §5.9 模型档位）。
 *
 * 图：intake → charter → product → tech → dev → test → report，
 * test 未通过回到 dev（单分支回退，有界）。
 *
 * 为什么节点全在这一个文件里、不拆 src/graph/nodes/*.ts：每个节点体只有 3–6 行
 * （读 current → 写状态边 → 返回本超步通道）。拆开会把一次跃迁的三段事实分到两个
 * 文件里，改 §7.1 的边时更容易只改一处。计划第 315 行【确实】把 src/graph/nodes/*.ts 列进了
 * Files —— 这里是不拆，不是计划允许不拆。该偏离已登记在
 * docs/decisions/0005-event-bus-and-audit.md §13，一处真相，不在两处各写一遍理由。
 *
 * ⚠ 装配两处【静默】陷阱（实测，见 docs/decisions/0005-event-bus-and-audit.md §16）：
 *  1) compile 的选项名必须是 checkpointer。写成 { saver } 时 LangGraph 直接忽略它，
 *     saver.put 永不触发 ⇒ 超步边界完全不滚动，整趟图压进一个事务。图和事件都照常
 *     产出，测试 ①②④ 全绿，只有崩溃恢复（V3）当场失去意义 —— 而且没有任何报错。
 *  2) 调用方必须用 auditor.invoke() 包住 graph.invoke()。onStepStart() 开的事务只在
 *     它自己的 scope 帧内有效，节点执行时那帧已退出；缺外层帧时第一次 record() 就抛
 *     「record() 丢失了事务作用域」。
 */
import type { DatabaseSync } from "node:sqlite";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { ModelTier } from "@opc/contracts";
import type { AuditRecorder } from "../events/recorder.js";
import { assertTaskTransition, type TaskState } from "./status.js";

export const COMPANY_NODES = [
  "intake",
  "charter",
  "product",
  "tech",
  "dev",
  "test",
  "report",
] as const satisfies readonly string[];
export type CompanyNode = (typeof COMPANY_NODES)[number];

/**
 * 允许的最大返工次数。必须是有限常数：没有界的话 dev/test 会永远互相打回，
 * 而 LangGraph 的 recursionLimit 只是兜底 —— 让运行时决定业务语义就是缺陷。
 * 1 = 计划验收 ②「test 桩失败一次 → 回退 dev 一次」。
 */
export const MAX_DEV_REWORK = 1;

/** 节点用到的岗位书切面。只要 modelTier / roleId：图不该依赖整份 Charter，
 *  否则 Charter 每加一个字段都会波及图。 */
export interface NodeCharter {
  readonly modelTier: ModelTier;
  readonly roleId: string;
}

/** 按档位取模型 —— 必须是【工厂/注册表】而非单个共享实例：§24 风险 1 要求评审方
 *  与产出方的模型家族不同，Phase 1 落地时若只有"一个模型"就得重画图。 */
export interface ModelRegistry {
  get(tier: ModelTier): BaseChatModel;
}

export interface CompanyHooks {
  /** 节点进入前。崩溃子进程用它定位「第 N 次节点执行」。 */
  onNodeEnter?(node: CompanyNode): void;
  /** 节点返回前（本超步的边已全部 record，尚未提交）。 */
  onNodeExit?(node: CompanyNode): void;
  /**
   * 一条状态边写完（recorder 已 INSERT，超步事务【尚未提交】）后立刻回调。
   *
   * 这不是遥测，是崩溃时机定位器：Task 0.8 验收 ③ 要把 SIGKILL 精确打在
   * 「第 K 条边 INSERT 之后、超步提交之前」，那才是能真正检验 §6.3 同事务 claim
   * 的时机。靠 setTimeout 猜位置做不到这件事。
   */
  onStatusEdge?(from: TaskState, to: TaskState): void;
}

export interface CompanyGraphOptions {
  readonly db: DatabaseSync;
  readonly recorder: AuditRecorder;
  readonly saver: BaseCheckpointSaver;
  readonly roles: Record<CompanyNode, NodeCharter>;
  readonly models: ModelRegistry;
  readonly taskId: string;
  readonly observe?: CompanyHooks;
}

/** 状态通道。⚠ 条件边能读的通道【必须在这里声明】：未声明的通道会被静默丢弃、
 *  条件函数拿到 undefined（实测过一次 GraphRecursionError 就是这么来的）。 */
const CompanyState = Annotation.Root({
  /** 一句想法（§23.3 的输入） */
  idea: Annotation<string>({ reducer: (_a, b) => b ?? "", default: () => "" }),
  /** §7.1 状态机的当前状态；节点每写一条边就推进一格 */
  current: Annotation<TaskState>({
    reducer: (_a, b) => b ?? "CHARTER_PENDING",
    default: () => "CHARTER_PENDING",
  }),
  /** test 节点本轮的判定。条件边只能读【本超步写出的】通道，
   *  读"我准备自减的计数器"会读到更新前的值（实测踩过）。 */
  passed: Annotation<boolean>({
    reducer: (_a, b) => b ?? true,
    default: () => true,
  }),
  /** 已用掉的返工次数 —— 回退有界的依据 */
  reworkUsed: Annotation<number>({
    reducer: (_a, b) => b ?? 0,
    default: () => 0,
  }),
  /** 节点执行轨迹，验收 ①② 的主要观测量 */
  trail: Annotation<CompanyNode[]>({
    reducer: (a, b) => [...(a ?? []), ...(b ?? [])],
    default: () => [],
  }),
});

type CompanyStateType = typeof CompanyState.State;
type CompanyUpdate = Partial<CompanyStateType>;

const INSERT_TASK_SQL =
  "INSERT OR IGNORE INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at) VALUES (?,?,?,?,?,?,?)";
const UPDATE_TASK_SQL =
  "UPDATE tasks SET status=?, current_node=?, updated_at=? WHERE id=?";

/**
 * 建图。
 *
 * 边与状态跃迁【同一处写】：每个节点读 current、写若干条 TaskStateChanged、把 current
 * 推进到最后一条边的 to。这样 §7.1 的每条边都必然留下审计行 —— 不存在"图走了但没记"
 * 的空隙（规格 §5.8：events 表是事实源）。
 */
export function buildCompanyGraph(o: CompanyGraphOptions) {
  const { db, recorder, saver, roles, models, taskId } = o;
  const observe = o.observe ?? {};

  /**
   * 写一条 §7.1 状态边：断言合法 → recorder.record → 同事务推进 tasks 行 → 回调。
   *
   * tasks 更新【必须】用同一个 db 连接：超步事务就是这条连接上的 BEGIN，
   * 换连接就跳出了事务（实测：崩溃后 events 与 tasks.status 一起回滚，两者停在
   * 同一个超步之前）。
   */
  async function edge(
    node: CompanyNode,
    from: TaskState,
    to: TaskState,
  ): Promise<TaskState> {
    // 实现侧守卫：非法跃迁当场炸，而不是把脏轨迹写进审计日志等验收 ④ 去发现
    assertTaskTransition(from, to);
    await recorder.record({
      kind: "TaskStateChanged",
      taskId,
      from,
      to,
    });
    db.prepare(UPDATE_TASK_SQL).run(to, node, Date.now(), taskId);
    observe.onStatusEdge?.(from, to);
    return to;
  }

  /**
   * 经 @langchain/core 的 message API 调用【该节点岗位书档位】的模型（§5.9）。
   * 桩模型在此处完全等价，所以测试不联网、不计费，但仍走真实调用链 ——
   * 「档位驱动」必须打到真实模型接口上才有被验证的意义。
   */
  async function askModel(node: CompanyNode, idea: string): Promise<string> {
    const charter = roles[node];
    const model = models.get(charter.modelTier);
    const reply = await model.invoke([
      new HumanMessage(
        "[opc-os] 角色 " + charter.roleId + " 节点 " + node + "\n想法：" + idea,
      ),
    ]);
    return typeof reply.content === "string"
      ? reply.content
      : JSON.stringify(reply.content);
  }

  /** 节点工厂：进入/退出回调 + 一次模型调用 + 节点自己那段 §7.1 跃迁。 */
  function node(
    name: CompanyNode,
    body: (
      state: CompanyStateType,
      write: (to: TaskState) => Promise<TaskState>,
    ) => Promise<CompanyUpdate>,
  ) {
    return async (state: CompanyStateType): Promise<CompanyUpdate> => {
      observe.onNodeEnter?.(name);
      await askModel(name, state.idea);
      let current = state.current;
      const patch = await body(state, async (to) => {
        current = await edge(name, current, to);
        return current;
      });
      observe.onNodeExit?.(name);
      return { ...patch, current, trail: [name] };
    };
  }

  const graph = new StateGraph(CompanyState)
    /**
     * intake：登记任务，不写状态边 —— CHARTER_PENDING 是任务的【初始】状态，
     * 不是一次跃迁的结果。第一条边由 charter 节点写。
     */
    .addNode(
      "intake",
      node("intake", async (state) => {
        const t0 = Date.now();
        db.prepare(INSERT_TASK_SQL).run(
          taskId,
          state.idea,
          "CHARTER_PENDING",
          roles.intake.roleId,
          "intake",
          t0,
          t0,
        );
        return {};
      }),
    )
    /**
     * charter：章程提案 → 获批。
     *
     * 【诚实标注】0.8 的最小图【没有审批门控】，这里由桩直通 CHARTER_APPROVED。
     * §7.2 步骤 2 的真实路径是 interrupt → CEO 在收件箱点击 → Command(resume)。
     * 门控落地后这条边必须由 interrupt 驱动，届时 e2e-linear 里那条"无门控"用例
     * 会转红，跟着一起改，不是悄悄改期望值。
     */
    .addNode(
      "charter",
      node("charter", async (_state, write) => {
        await write("CHARTER_APPROVED");
        return {};
      }),
    )
    .addNode(
      "product",
      node("product", async (_state, write) => {
        await write("DECOMPOSING");
        return {};
      }),
    )
    .addNode(
      "tech",
      node("tech", async (_state, write) => {
        await write("IN_PROGRESS");
        return {};
      }),
    )
    /**
     * dev：交证据。若本轮是因被打回而进入，先补 REJECTED_DOWNWARD→IN_PROGRESS
     * （§7.2 补边）再交 —— 一次节点执行写多条边，正是"一个超步多条边"的形态。
     */
    .addNode(
      "dev",
      node("dev", async (state, write) => {
        if (state.current === "REJECTED_DOWNWARD") await write("IN_PROGRESS");
        await write("EVIDENCE_SUBMITTED");
        return {};
      }),
    )
    /**
     * test：入审 → 判定。桩规则：还能返工就判不通过（失败一次即返工一次），
     * 返工用尽即判通过 —— 于是回退【有界】，且续跑重放时走同一条分支
     * （reworkUsed 通道与那条边同一超步，崩溃时一起回滚）。
     */
    .addNode(
      "test",
      node("test", async (state, write) => {
        const rework = state.reworkUsed < MAX_DEV_REWORK;
        await write("IN_REVIEW");
        await write(rework ? "REJECTED_DOWNWARD" : "APPROVED_UPWARD");
        return {
          passed: !rework,
          reworkUsed: rework ? state.reworkUsed + 1 : state.reworkUsed,
        };
      }),
    )
    /**
     * report：上报 → 终审 → 交付 → 归档，四条边一次超步。
     *
     * 同 charter：真实系统的 ESCALATED_TO_CEO→FINAL_REVIEW→DELIVERED 由 CEO 在
     * 审批收件箱操作触发（§7.2 步骤 8），0.8 无门控，桩直通。
     */
    .addNode(
      "report",
      node("report", async (_state, write) => {
        await write("ESCALATED_TO_CEO");
        await write("FINAL_REVIEW");
        await write("DELIVERED");
        await write("ARCHIVED");
        return {};
      }),
    )
    .addEdge(START, "intake")
    .addEdge("intake", "charter")
    .addEdge("charter", "product")
    .addEdge("product", "tech")
    .addEdge("tech", "dev")
    .addEdge("dev", "test")
    /**
     * 单分支回退：test 的出边【只有】两条 —— 前进 report / 退回 dev。
     * 回退不指向 product / tech（"单分支"的反面就是到处回退）。
     * 条件读 passed（本超步写出的通道），不读计数器。
     */
    .addConditionalEdges("test", (state) => (state.passed ? "report" : "dev"), {
      dev: "dev",
      report: "report",
    })
    .addEdge("report", END);

  // ⚠ 选项名是 checkpointer（不是 saver）—— 见文件头陷阱 1
  return graph.compile({ checkpointer: saver });
}
