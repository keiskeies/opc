import type { DomainEvent } from "../events/bus.js";
import { AuditRecorder } from "../events/recorder.js";

/**
 * 审计中间件（计划 Task 0.6 硬规定 2：interrupt 按 V2 处理）。
 *
 * 为什么叫「中间件」却没有 LangGraph 的 middleware：LangGraph JS 1.7.1 里
 * 根本没有 middleware 概念（Python 版 0.2+ 才有）。能挂的只有 GraphCallbackHandler，
 * 而它是个空标记类，没有节点级生命周期钩子，也拿不到节点名 —— 做不了审计入口。
 * 所以这里是一个【显式包装器】：由调用方把 graph.invoke 交进来，包装器负责审计。
 * 见 docs/decisions/0005-event-bus-and-audit.md。
 */

/** 一条中断的可用信息。探针实测：LangGraph JS 1.7.1 只给 id 与 value 两个键。 */
export interface InterruptInfo {
  readonly id: string;
  readonly value: unknown;
}

/**
 * 从 invoke 的返回值里取出中断。
 *
 * 为什么是【返回值】而不是 catch：实测见 docs/decisions/0005-event-bus-and-audit.md §10
 * interrupt() 让 graph.invoke 正常 resolve，返回对象里多一个 __interrupt__ 数组，
 * 【不抛异常】。把它当异常处理 = 审计里永远看不到"等待批准"这件事，
 * 而任务已经停在 need_approval 上，前端只能靠轮询猜。
 *
 * 形状校验一律抛错：这层代码假设的是框架私有形状，LangGraph 升级改结构时，
 * 静默返回 [] 会表现为【漏审计】—— 没有任何报错、审批永远不来，最难查的那类。
 */
export function detectInterrupts(result: unknown): InterruptInfo[] {
  if (result === null || typeof result !== "object") return [];
  const bag = result as Record<string, unknown>;
  if (!("__interrupt__" in bag)) return [];
  const raw = bag.__interrupt__;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(
      "__interrupt__ 不是数组（得到 " +
        typeof raw +
        "）。LangGraph JS 1.7.1 实测是数组，形状变了必须立刻知道，" +
        "静默忽略会表现为漏发 ApprovalRequired —— 审批永远不来，且没有任何报错。",
    );
  }
  return raw.map((item, i) => {
    if (item === null || typeof item !== "object") {
      throw new Error("__interrupt__[" + i + "] 不是对象，无法审计。");
    }
    const hit = item as Record<string, unknown>;
    const id = hit.id;
    // 没有 id 就既不能写审计（target 空 → 无法问责）也不能 resume（Command 要 id）。
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(
        "__interrupt__[" + i + "] 缺少可用的 id（得到 " + String(id) + "）。",
      );
    }
    return { id, value: hit.value };
  });
}

/**
 * 给一次 invoke 加中断审计。返回 invoke 的原始返回值，不改语义。
 *
 * 只在【确实有中断】时才开事务写库：没有中断也开一层 begin/commit，
 * 会让每个正常任务白跑一次 WAL 往返，还会在审计库旁边制造空事务噪音。
 *
 * 这里用 recorder.run() 而不是让调用方先开事务：中断审计的原子性边界就是
 * 「这些 ApprovalRequired 要么都写进去、要么都不写」，它不属于任何一个超步
 * （一条中断可能来自图里任意一个超步）。
 */
export async function auditedInvoke<T>(o: {
  invoke: () => Promise<T>;
  recorder: AuditRecorder;
  taskId: string;
}): Promise<T> {
  // 不 catch：普通异常必须原样冒泡（同一个错误对象）。吞掉或重新包装会盖掉
  // 真正的故障线索，而中断根本不走异常路径（见 detectInterrupts 注释）。
  const result = await o.invoke();
  const interrupts = detectInterrupts(result);
  if (interrupts.length === 0) return result;

  // 两条路径，差别只在【谁负责 COMMIT】；写进去的内容完全相同，所以抽成一个函数，
  // 避免复制粘贴后两条路径的语义各自漂移。
  const writeApprovals = async (): Promise<void> => {
    for (const hit of interrupts) {
      // 系统事件：没有人做过这个动作，是图停下来了。actor 用 recorder 的
      // 默认 { system, hub } —— 伪造一个 agent 身份是审计污染。
      await o.recorder.record({
        kind: "ApprovalRequired",
        taskId: o.taskId,
        interruptId: hit.id,
        payload: hit.value,
      } satisfies DomainEvent);
    }
  };

  if (o.recorder.inStepTx()) {
    // 外层（SuperStepAuditor.invoke）已负责事务 —— 复用当前超步事务，绝不再 run 一次：
    // 嵌套会让「谁负责 COMMIT」变成两个答案（守卫会直接抛，见 0005 §11 缺陷 C）。
    // 复用的语义也是对的：审批与该超步的 checkpoint 同事务原子提交（规格 §6.3），
    // 提交与广播仍由外层在收尾时统一做。
    await writeApprovals();
    return result;
  }

  // 独立使用（没有外层图执行事务）：自己开一个事务。原子性边界就是「这些
  // ApprovalRequired 要么都写进去、要么都不写」，它不属于任何一个超步。
  await o.recorder.run(writeApprovals);
  return result;
}

/* ======================= 超步事务协调器 ======================= */

import type { DatabaseSync } from "node:sqlite";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import { requireScopeDb, scopeFrame } from "../checkpoint/tx-scope.js";
import type { EventBus } from "../events/bus.js";
import type { StepTx } from "../events/recorder.js";

/**
 * 用一条 node:sqlite 连接实现 StepTx：一次超步事务的生命周期 + ALS 作用域。
 *
 * 与 txScope() 的区别是【刻意的】：txScope 把「开事务」和「建作用域」捆在一起，
 * 而超步协调必须把两者分开 —— ALS 帧覆盖整次 invoke（saver 全程拿同一条连接，
 * 探针实测），事务却在帧内按超步一次次滚动。捆在一起就只能「一次 invoke 一个
 * 大事务」，那会踩 0003 §3.2 列的两条：写锁按住整张图的时长，以及 V11 重放把
 * 崩溃恢复打成重跑全图。
 */
class DbStepTx implements StepTx {
  readonly #db: DatabaseSync;
  #open = false;
  #commits = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** 已完成的 COMMIT 次数；测试据此断言「没有空事务往返」。 */
  get commits(): number {
    return this.#commits;
  }

  async begin(): Promise<void> {
    // 不自己判「已有事务」：正常编排下 begin 之前必定先 commit（onStepStart 保证），
    // 重入只可能来自状态错乱，而那种情况下 SQLite 会自己报
    // "cannot start a transaction within a transaction" —— 那句话本身就指向根因，
    // 再加一层自定义守卫只是把同一件事说两遍（变异测试也证明它不可经公开路径触发）。
    this.#db.exec("BEGIN IMMEDIATE");
    this.#open = true;
  }

  async commit(): Promise<void> {
    // 不检查 #open：调用方（recorder）已经用 inTx() 判过；这里重复判断只会把
    // 「谁负责判断」搞混，且 COMMIT 在无事务时由 SQLite 报错更诚实。
    this.#db.exec("COMMIT");
    this.#open = false;
    this.#commits += 1;
  }

  async rollback(): Promise<void> {
    try {
      this.#db.exec("ROLLBACK");
    } catch {
      /* 事务可能已被 SQLite 自己中止（SQLITE_FULL 等）：别盖掉原始异常 */
    }
    this.#open = false;
  }

  scope<T>(fn: () => Promise<T>): Promise<T> {
    // 必须走 tx-scope 的 scopeFrame，不能自己攒 ALS：saver 那边 requireScopeDb()
    // 读的是 tx-scope 模块里的那一个 ALS。两套 ALS 会各看各的 —— 表现是「明明在
    // 事务里，saver 却说不在 txScope() 内」（这条【是】可测的：删掉建帧就红）。
    return scopeFrame(this.#db, fn);
  }

  inTx(): boolean {
    // 回答的是【数据库状态】，不是「有没有作用域」—— 见 recorder 里 StepTx 的注释。
    return this.#open;
  }

  db(): DatabaseSync {
    // 与 saver 走同一条取用路径，这是「Checkpoint 与 events 同一事务」的落点（§6.3）。
    return requireScopeDb("SuperStepAuditor");
  }
}

/** 织入点只需要这两个写方法；用结构类型而不是具体类，测试才好塞替身。 */
export interface Savewriter {
  put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig>;
  putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
    taskPath?: string,
  ): Promise<void>;
}

export interface SuperStepAuditorOptions {
  db: DatabaseSync;
  bus: EventBus;
  now?: () => number;
  actor?: { actorType: "agent" | "human" | "system"; actorId: string };
  onBroadcastError?: (e: unknown) => void;
}

/**
 * 把超步事务协调接到 Saver 上（计划 Task 0.6 硬规定 1 的落地）。
 *
 * 为什么拦 Saver.put：实测见 docs/decisions/0005-event-bus-and-audit.md §1 —— put 是【唯一可靠的超步边界】：
 * 严格发生在该超步所有节点执行之前，平行扇出时同超步的多个节点共享一次 put。
 * stream(updates) 的 chunk 不是边界（一次超步可能给多个 chunk、也可能合并），
 * 且 producer 与 consumer 之间【没有背压】：consumer 睡 250ms，后面节点的 INSERT
 * 照样落库。用 chunk 当边界会让事务切在节点中间。
 */
export class SuperStepAuditor {
  readonly #tx: DbStepTx;
  readonly recorder: AuditRecorder;

  constructor(o: SuperStepAuditorOptions) {
    this.#tx = new DbStepTx(o.db);
    this.recorder = new AuditRecorder({
      tx: this.#tx,
      bus: o.bus,
      // 条件展开而不是直接传，理由只有一条、而且是【编译期】的：本仓库开了
      // exactOptionalPropertyTypes，恒传（onBroadcastError: o.onBroadcastError）会被 tsc 拒绝
      // —— 实测 error TS2379。【不要】把这条改成运行期理由：recorder 那边用的是 ??，
      // 实测显式传 undefined 时 ?? 照样落到默认回调（默认仍被调用一次），并不会盖掉默认值。
      // 透传本身是否有测试守着：见 test/graph/step-tx.test.ts 的【忘记透传无人守】那条
      //（变异 MJ / MK 实测：删掉这段条件展开在补断言前全量 256 条全绿）。
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.actor === undefined ? {} : { actor: o.actor }),
      ...(o.onBroadcastError === undefined
        ? {}
        : { onBroadcastError: o.onBroadcastError }),
    });
  }

  /** 已提交的超步事务数（不含进行中的那个）。 */
  get committedSteps(): number {
    return this.#tx.commits;
  }

  /**
   * 包住一次图执行：事务按超步滚动，异常回滚当前超步。
   *
   * 这里【不再】额外套一层 ALS 帧（曾写过 tx.frame(...)，变异测试证明它恒冗余：
   * recorder.run() 自己会 tx.scope(fn)，那个帧包住整个 fn，包括两次超步之间的
   * 窗口 —— 所谓「put 在 scope 之外需要帧」的空窗并不存在。删掉。
   */
  invoke<T>(fn: () => Promise<T>): Promise<T> {
    return this.recorder.run(fn);
  }

  /**
   * 让 saver 的每次 put 先做一次超步边界动作（提交上一超步 + 开新事务）。
   *
   * 用 Proxy 而不是子类：Saver 已经是 SqliteWALSaver，再造一层继承会把「谁持有
   * 连接」这条链多绕一圈；Proxy 只加一个拦截点，其余方法原样透传（记得 bind，
   * 否则 this.serde 会丢）。
   */
  instrumentSaver<S extends Savewriter>(saver: S): S {
    // 就地改：调用方拿到的还是同一个 saver 对象，LangGraph 内部若已持有引用也不会
    // 拿到未织入的那份 —— 这是「忘记织入」这类事故的天然解法。
    const originalPut = saver.put.bind(saver);
    const self = this;
    Object.defineProperty(saver, "put", {
      value: async function put(
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        newVersions: ChannelVersions,
      ): Promise<RunnableConfig> {
        await self.recorder.onStepStart();
        return originalPut(config, checkpoint, metadata, newVersions);
      },
      configurable: true,
      writable: true,
    });
    return saver;
  }
}
