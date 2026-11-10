/**
 * Hub 决策与建任务的**真实写入路径**（计划 Task 2.1 的落地半边 + Task 2.6 的 Hub 侧一半）。
 *
 * ── 这个文件存在的理由：HTTP 层此前是一层【壳】──────────────────────────
 * app.ts 把副作用收在两个注入点上（recordDecision / createTask），注释写的是
 * 「生产用真 recorder」。把仓库翻一遍的实测结果（三条都是当场 grep 的，不是回忆）：
 *   · `grep -rn "INSERT INTO approvals\|UPDATE approvals" packages/hub/src` ⇒ 0 命中
 *   · 全仓唯一写 approvals 的代码在两个测试文件的【夹具】里
 *     （contract.test.ts / server.test.ts 各自手搓一条 UPDATE）
 *   · `serveHub(` 在 src/ 与 dist/ 之外【没有任何调用点】
 * 也就是说 `POST /approvals/:id` 与 `POST /tasks` 在生产里除了测试夹具什么都不做：
 * 状态码对、审计不重复、游标续订正确，而 approvals 那一行永远停在 pending，
 * 图永远不恢复。这是 Phase 2 出口标准（扔想法 → 收件箱审批 → 看板变 DELIVERED）
 * 真正的缺口，而且它**不被任何测试挡住** —— 最接近的那两条断言数的正是注入点
 * 「有没有被调用」，测试替身一顶就绿。
 *
 * 所以这里补的是那两个注入点的生产实现，外加一个装配入口 buildHubDeps。
 *
 * ── 一处形状偏离：注入点从两个变三个（多一个 resumeGraph）───────────────
 * `deps.recordDecision` 的签名只有 approvalId / taskId / resume / note，
 * 而「批准之后让图接着跑」需要的是【另一件事的输入】：thread_id（= task_id）、
 * 编译好的 graph、auditor 的 invoke。硬塞进 recordDecision 会把
 * 「这条决策落没落库」与「图跑没跑」混进同一个返回值，而这两件事的失败模式
 * 完全不同（见 makeResumeGraph 的注释：一个必须让请求失败，一个不能让库回滚）。
 * 所以拆成第三个注入点，由本模块装配。app.ts 那条「404 不写审计」的可测形态一字未改。
 *
 * ── 本篇能测什么、不能测什么（别把绿的读成全绿）────────────────────────
 * 能在本机离线跑：pending → 终态的**条件 UPDATE**、审计行的 actor/action/target/note、
 * 并发第二次返回 false 且【不写第二条审计】、事务回滚不留半套、createTask 被 FK 拒、
 * 标题截断入库、now 注入。
 * **不能**在本机跑：makeResumeGraph 真的驱动图 —— 它要 `@langchain/*`，装不上（0009 §2）。
 * 这条不是「换个写法能测」的，它缺的就是那三个包。它**未在本机执行过一次**，
 * 与 0009 §4 第 5、6 行同性质（「没做到」，不是「换法做到」）。
 *
 * ── 一次实测推翻了我自己第一版的写入形状（三条，都可复现）───────────────
 * 第一版 applyDecision 收一条 DatabaseSync、自己 txScope(db)。看起来无害，
 * 而 txScope 的实现在 BEGIN 与 COMMIT 之间有一句 `await body()`（tx-scope.ts:82）
 * —— 同步体也会让出一个微任务，于是【同一条连接上的两次并发事务会互相踩】。
 * 三条实测（脚本形状见 0010 §2，本机 node:sqlite，无需框架）：
 *   P1 同一条连接、两个窗口各批一张【不同】的卡片 ⇒ 一支 ok、一支
 *      【cannot start a transaction within a transaction】，events 只落了 1 行。
 *   P2 图的超步事务持有同一条连接（节点体里 await 一次 = 模型调用）时点批准
 *      ⇒ 同样那句报错，卡片停在 pending。
 *   P4 用真 SuperStepAuditor + 织入后的 saver 复验 P2：节点体内
 *      inStepTx() = true，批准照样抛。⇒ 超步事务【确实横跨节点执行】。
 * P1 的修法在本文件里（改走单写者队列，见下面的 TxWriter）。
 * P2/P4 【不是本文件能修的】—— 它要动的是超步事务的持锁范围，属 0003 那条决策，
 * 已带数字挂到 docs/decisions/0010 等 CEO。写在这里是因为读这段的人会以为
 * 「approve 已经能用了」：图空闲时能用，节点在跑时【任何】写入都不行。
 *
 * ── 为什么写库要走队列而不是拿连接（§5.5）─────────────────────────────
 * 一个顺带测出来的事实：`grep -rn "new WriteQueue" packages/hub/src` 之类【源码目录】
 * 的搜索 ⇒ 【0 命中】，只有它自己的测试在用。
 * 规格 §5.5 那台「进程内单写者」在 src 里从来没有生产调用点，只有它自己的测试。
 * 也就是说 §5.5 此前是纸面性质。本文件是第一个走它的写入方。
 *
 * 一个连带的形状决定：本文件**顶层不 import** `@langchain/*`（Command 的构造走函数内的
 * 动态 import），恢复选路那两条判定抽到 graph/thread.ts，由 CLI 与本文件【共用一份】。
 * 理由：thread.ts 是「不带框架也能拿到」的那一层。若这里改为顶层 import 图相关模块
 * （或直接 import cli.ts，它顶层就带 @langchain/langgraph），那么上面那整段【能离线测】
 * 的代码会连 import 都做不到 —— 可验证性由 import 图决定，不由逻辑决定，
 * 所以这件事只能写在 import 那一行上。
 */

import type { ResumeValue } from "@opc/contracts";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import { appendAudit } from "../events/recorder.js";
import {
  assertParamCount,
  assertSingleStatement,
  type HubWriter,
  type WriteQueue,
  type Writer,
} from "../db/write-queue.js";
import {
  chooseResumeInput,
  hasPendingInterrupt,
  threadConfig,
} from "../graph/thread.js";
// 只在 insertTask 里取一版「当前组织图版本」。方向是 http/ → org/：
// HTTP 是组织功能的一个入口，不是组织功能的归属地（同一个理由见 org/commit.ts
// 文件头那条「ORG_ACTOR 不从 http/real-deps.ts 拿」）。
// 这条 import 不顶层带 @langchain/*：org/commit.ts 的 import 闭包只有
// contracts + db + checkpoint + events，所以文件头那条「可验证性由 import 图决定」
// 仍然成立，本文件照旧可以离线测。
import { currentGraphVersion } from "../org/commit.js";
import type { HubDeps } from "./app.js";

/** CEO 这一侧的动作在审计里的身份。 */
export const CEO_ACTOR = { actorType: "human", actorId: "ceo" } as const;

/**
 * 定义已搬到 db/write-queue.ts（理由写在那边：第二个使用方 org/commit.ts 不该
 * 为了拿这个类型而 import 一个 http 模块）。这里【只 re-export】，
 * 于是已有调用方一字不改，而定义仍只有一处。
 */
export type { Writer };

/**
 * resume 值 → approvals.status。
 *
 * 为什么把它做成导出的数据而不是散在各处的 switch：这是【审计读法】与
 * 【按钮标签】之间唯一的桥。渲染进程发 approve，收件箱计数与回放读 approved；
 * 桥散在多处就会出现「点过批准的卡片仍被算进待审批数」——
 * 那是收件箱计数恒不对的直接来源（Task 2.6 的验收项）。
 *
 * 【已核对的事实】写这个文件之前 grep "deferred" 在所有 packages 的 src 下 = 0 命中：
 * schema 注释里列着 pending/approved/rejected/deferred 四个值，生产代码里
 * 一处都不用（因为它此前没有生产实现）。所以这张表是【第一次真正使用】那四格。
 *
 * `defer_deep_review → deferred` 这条是三段里唯一一处【语义由我定】的：
 * 规格 §9.3（实测标题是「超时行为」，三行表 auto_approve / auto_reject / escalate）
 * 讲的是超时，没有讲 defer 落到哪个 status；schema 那四个值就是全部候选，
 * deferred 对应 defer 是读 schema 的直接结论。
 *
 * 另有一处**更大**的没定、也**不由我定**，已挂在 docs/INDEX.md 的等待区
 * （0008 §4.1：CEO 点「追加预算」之后任务落回哪个状态，规格只说「从 Checkpoint
 * 恢复」而没点名状态）。这条缺口与映射本身无关，写在这里是因为读这段的人会问
 * 「那 tasks.status 呢」——见下一段。
 */
export const STATUS_BY_RESUME: Readonly<
  Record<ResumeValue, "approved" | "rejected" | "deferred">
> = {
  approve: "approved",
  reject_with_comment: "rejected",
  defer_deep_review: "deferred",
};

/**
 * 首次决策的【条件】UPDATE。
 *
 * `WHERE status = 'pending'` 是幂等承重那一步。为什么不先 SELECT 再 UPDATE：
 * 两次读之间可以有一次并发写入（同一张卡片在两个窗口各点一次），
 * 那时「查出来是 pending」与「写下去」之间不是原子的，
 * 而 events 是 append-only —— 第二条决策事件写下去就删不掉，
 * 回放会重建出「这个审批批过两次」。把判定压进 WHERE 之后，并发那一支的
 * info.changes 是 0，我们在【写下事件之前】就知道没抢到，于是根本没有第二次审计可写。
 * 这是 §8.2 第 4 条同一条思路：能绕过的那条路不要留在那里，
 * 而不是写注释提醒别人别绕。
 *
 * `decided_by` 存的是【谁】而不是【决定了什么】：status 已经回答了后者
 * （schema 注释：decided_by TEXT）。把 resume 值抄进 decided_by 是把两列当一列用，
 * 以后要支持多审批人就没地方放了。
 */
export const CLAIM_APPROVAL_SQL =
  "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? " +
  "WHERE id = ? AND status = 'pending'";

/**
 * 抢占那张卡片 + 落一条 CEO 决策，返回是否真的写成了。
 *
 * 四条不变量，各自对应一种真实故障：
 *  ① 抢不到（并发 / 已被超时器处理）⇒ 【一条审计都不写】。
 *     顺序因此是【先 UPDATE 后 appendAudit】，不是反过来。反过来的话并发那一支
 *     会留下一条 append-only 的假历史 —— 而 contracts/api.ts 花整个 approvalOutcome
 *     判别式挡的正是这件事，那个判别式只挡住了 handler 层，挡不住写实现自己先写后查。
 *  ② 决策与审计【同一事务】（规格 §6.3）。半套状态（卡片已批、审计没有）
 *     是回放对不上账时唯一查不出来的那种。
 *  ③ note 用 `?? null` 显式落 NULL，不靠少绑参数。少绑在 node:sqlite 上
 *     【不报错、直接写 NULL】（实测，见 write-queue.ts 文件头第 4 条），
 *     结果看着一样，但它是「今天挪动一个 ? 的位置」这类改动唯一能躲过检查的方式。
 *     assertParamCount 兜得住的前提是我把参数写全了。
 *  ④ 写入【必须排队】，即入参是 WriteQueue 而不是一条连接。这一条是被 P1 逼出来的：
 *     第一版这里收 DatabaseSync、自己 txScope，而两个窗口同时点批准就会
 *     【一支成功一支抛 cannot start a transaction within a transaction】
 *     （实测过程见文件头与 0010 §2）。txScope 在 BEGIN 与 COMMIT 之间 await，
 *     同一条连接上的第二个 BEGIN 就落在第一个事务还没结束的时候。
 *     WriteQueue 的 #enqueue 把整笔事务串成一条链，「同连接重入」这件事
 *     因此不可表达 —— 结构上写不出来，比注释里写「别并发调」可靠。
 *
 * 广播在【事务提交之后】发（w.node 返回即已提交），不在事务里发。
 * 在事务里发会出现「前端收到卡片已批、此刻库里那行还没 COMMIT」，
 * 而前端收到就去 GET /tasks，读到的是旧状态 —— 一个每次都可能不发生的错乱。
 * recorder 的 #flush 用的是同一个时机（recorder.ts:370 只在 commit 之后）。
 */
export async function applyDecision(
  w: Writer,
  o: {
    readonly approvalId: string;
    readonly taskId: string;
    readonly resume: ResumeValue;
    readonly note?: string;
    readonly nowMs: number;
  },
  /**
   * 事件广播出口。装配时传真总线。**这个参数是【必填】的**，理由是本篇 §1 第三条：
   * 决策落库而不广播 ⇒ `events.id` 已被消费却没送出去 ⇒ 活着的 SSE 订阅看见一个
   * 【seq 空洞】，而投影层把空洞读成「链路降级」（0010 §4）。也就是说
   * 「忘了广播」的症状不是「少一条更新」，是【每次批准都把连接标脏一次】。
   * 所以这里不给默认值：可选参数会让「装配时忘了传」成为一个 TS 不响、
   * 测试也照样绿、只有前端用户能看见的缺陷 —— 那正是本文件存在的理由所要防的形状。
   * 测试不关心广播时【显式传一个空函数】，「我选择不广播」与「我忘了广播」
   * 在代码上必须长得不一样。
   *
   * 为什么收一个函数而不是让本模块持有 EventBus：applyDecision 的职责是
   * 「这条决策落没落库」，广播是【另一件事】。 recorder 也是这么分的（它收 bus 而不自建）。
   */
  publish: (e: DomainEvent, seq: number) => void,
): Promise<boolean> {
  const status = STATUS_BY_RESUME[o.resume];
  const payload = { approvalId: o.approvalId, resume: o.resume };
  const note = o.note ?? null;

  const wrote = await w.node(() => {
    const db = requireScopeDb("applyDecision");
    const params: unknown[] = [status, CEO_ACTOR.actorId, o.nowMs, note, o.approvalId];
    assertSingleStatement(CLAIM_APPROVAL_SQL);
    assertParamCount(CLAIM_APPROVAL_SQL, params);
    const info = db.prepare(CLAIM_APPROVAL_SQL).run(...(params as never[])) as {
      changes: number | bigint;
    };
    if (Number(info.changes) === 0) return null; // 没抢到：不写审计

    const seq = appendAudit(
      db,
      {
        taskId: o.taskId,
        actorType: CEO_ACTOR.actorType,
        actorId: CEO_ACTOR.actorId,
        // action 取 'approval' 而不是 'review_decision'：后者对应【门控判定】
        // （规格 §5.8 那张事件表：ReviewDecided ← 门控判定），CEO 点按钮是审批决策。
        // api.ts 的 audit 类型把两者都列为候选，这里选定一个并留下理由，
        // 而不是让它随调用点漂移。
        action: "approval",
        // target = 卡片 id：这是「这张卡片被谁在什么时候点掉」的唯一定位手段。
        // 写成 status 值会让同一个人对同一张卡片的多次操作在 target 上无法区分。
        target: o.approvalId,
        payload,
        createdAt: o.nowMs,
        // note 进 state_snapshot 而不是 payload：payload 存【决策本身】（回放要按它
        // 重建卡片状态），note 是决策的【附件】。混进 payload 的话，将来 payload
        // 形状一变（加字段）就要区分「哪些字段属于当时的决策」。
        ...(note === null ? {} : { stateSnapshot: { note } }),
      },
      () => o.nowMs,
    );
    return { seq, status };
  });

  if (wrote === null) return false;
  publish(
    {
      kind: "ApprovalDecided",
      taskId: o.taskId,
      interruptId: o.approvalId,
      decision: wrote.status,
    },
    wrote.seq,
  );
  return true;
}

/** 装配 makeResumeGraph 需要的最小图接口（结构类型，测试好塞替身）。 */
export interface ResumableGraph {
  getState(config: { configurable: { thread_id: string } }): Promise<unknown>;
  invoke(input: unknown, config: { configurable: { thread_id: string } }): Promise<unknown>;
}

/**
 * 一条【任务】对应的图 + 它的事务责任方。
 *
 * 为什么注入的是【工厂】而不是一张编译好的图（这是我第一版写错的地方，值得留下）：
 * `buildCompanyGraph({ taskId })` 把 taskId 烧进了节点体 —— edge() 用它写 tasks 行、
 * 用它写审计的 task_id。所以一张编译好的图【只服务一条任务】。
 * 若这里收一张图、再按请求传 taskId 进去，会出这样的事：
 * 线程坐标按 B 读写 checkpoint（checkpointer 按 thread_id 分键，看着完全正常），
 * 而节点里的 INSERT/UPDATE 与审计的 task_id 全落在 A 上。
 * 症状是「B 的任务一步不动、A 多出一堆不属于它的事件」，两处各自都自洽 ——
 * 本仓认定最贵的那种静默。做成工厂之后，「一条任务一张图」是【类型上】唯一写得出的形状。
 */
export interface TaskGraph {
  readonly graph: ResumableGraph;
  /** 图执行的事务责任方（SuperStepAuditor）。 */
  invoke<T>(fn: () => Promise<T>): Promise<T>;
}

export interface ResumeDeps {
  /** 按任务取图。实现方【必须】每个 taskId 给一张自己的图，理由见 TaskGraph。 */
  graphFor(taskId: string): TaskGraph;
  /** Command 的构造点。默认真 import；测试注入一份，好让这条路径本机可跑。 */
  makeCommand?: (resume: null) => unknown;
}

/**
 * 让【这一条】图接着跑。
 *
 * 选路复用 thread.ts 那一份判定（0006 §1 的实测结论），不重写一遍 ——
 * 「复用」在这里是可 grep 的：CLI 的 cmdResume 与这里调的是同一个 chooseResumeInput。
 *
 * 为什么在 api 层的写事务【之外】调（applyDecision 那次 node() 已经提交之后）：
 * 图里 recorder.record() 要求处在【超步事务】作用域内，那个事务的责任方是
 * auditor.invoke()（= recorder.run）。在 api 层的事务里调图，会让图第一次 record()
 * 撞上「有事务但不是超步事务」，报一句指向 saver 的错 —— 排查方向被指到框架那一侧。
 *
 * 失败方向（本文件最需要被读清的一段）：审计已提交、图没恢复 ⇒
 * 卡片是 approved、图还停在 interrupt 上。
 * 我【没有】把 resume 塞进同一个事务来「消除」这个缺口，三个理由：
 *  ① 那会把模型调用的时长与失败放进 API 层的写事务里。超步事务按超步滚动正是为了
 *     不这么干（0003 §3.2：invoke 级事务会把写锁握几十分钟，而 busy_timeout 只有 5000ms）。
 *  ② 更贵的是它会【重复烧钱】：图里跑完的节点跟着事务一起回滚
 *     （实测 F：LangGraph 侧的 checkpoint 同样回滚），下次从头重跑。
 *     「一次点击失败 ⇒ 已完成的工作全部作废」比「卡片已批、待恢复」贵得多。
 *  ③ 状态码口径不变：决策落库 ⇒ 200；图恢复失败沿 promise 冒到 handleRequest 的
 *     catch ⇒ 500 + 原文。于是 CEO 看到「报错了」而库里卡片确实是批准的，
 *     修法是读那一行报错再去 `hub resume` 续跑，不是重新点一次。
 *
 * ⚠ 「点一次批准 ⇒ 卡片已批 ⇒ 图续跑」这条链【本机未执行过】。
 * 本机能跑到的是：选路判定、getState 的形状判定、以及 makeCommand 注入时
 * 【调用的是哪一支】。真正的 graph.invoke 需要 @langchain/langgraph（装不上）。
 */
export function makeResumeGraph(
  deps: ResumeDeps,
): (taskId: string) => Promise<void> {
  return async (taskId: string): Promise<void> => {
    const { graph, invoke } = deps.graphFor(taskId);
    const cfg = threadConfig(taskId);
    const before = await graph.getState(cfg);
    const choice = chooseResumeInput(hasPendingInterrupt(before));
    let input: unknown = null;
    if (choice === "command") {
      if (deps.makeCommand !== undefined) {
        input = deps.makeCommand(null);
      } else {
        const { Command } = await import("@langchain/langgraph");
        input = new Command({ resume: null });
      }
    }
    await invoke(() => graph.invoke(input, cfg));
  };
}

/**
 * 新任务落库。current_node 写 'intake'、status 写 CHARTER_PENDING，
 * 与图里 intake 节点写的那一行同一个值。
 *
 * status 是任务的【初始】状态而不是某次跃迁的结果（company.ts 的 intake 注释就是这句），
 * 所以它【不配】审计事件：第一条边由 charter 节点写，那条边自带审计。
 *
 * parent_id 不做存在性预检，让 FK 自己拒。两种做法都考虑过，选不预检：
 * 预检要多一份判据、多一处与 schema 漂移的地方，而 SQLite 的原文
 * （FOREIGN KEY constraint failed: tasks.parent_id）带的信息比我的自造文案准。
 * 代价写清楚：引用一个不存在的父任务时是 500 而不是 422（500 的 body 带原文）。
 * 要做成人话，正确位置是 contracts 的 createTaskRequestSchema 一侧的报错映射，
 * 不是在这里加一次 SELECT。
 *
 * ⚠ 【完整想法】目前只活在 HTTP 请求里，落库之后无处可查：tasks.title 是折过首行、
 * 超 200 字符带省略号的（app.ts 的 titleOf，那条截断刻意留了省略号）。
 * 我没顺手加一条审计事件存全文 —— AUDIT_ACTIONS 十个值里没有一个语义是
 * 「登记一条任务」（最接近的 state_change 是状态跃迁，而创建不是一次跃迁），
 * 而 events.action 是 append-only 枚举，写脏一行永远留在库里。
 * 加一个 action 值 = 改规格 §22.1 的枚举，不是实现层能顺手定的事。
 * 这条缺口现在【有测试把它写成断言】（见 real-deps.test.ts 那条「全文查不到」），
 * 免得下一个人以为全文存在某个角落。
 *
 * ── graph_version：这一列【必须】在这里写，而不是事后再 UPDATE ──────────
 * 0001_init.sql:49 那列是 `INTEGER NOT NULL DEFAULT 1`，而本轮之前
 * `grep -rn "graph_version" packages/hub/src` 除注释外【0 命中】——
 * 建库以来没有任何代码写过它，每条任务都躺在默认值 1 上，
 * 而 delegation_graphs 里 1 号版本【一行都不存在】。
 * 于是规格 §18.4 阶段 3 那句「旧任务从 Checkpoint 恢复时加载创建时版本的图定义」
 * 不是没做完，是【前提不成立】：所有任务的「创建时版本」都是同一个假的 1。
 *
 * 为什么写成 INSERT 的一列 + 同事务里取数，而不是插入后再发一条 UPDATE：
 * 拆两条语句会留一段「任务行已存在而版本还是 1」的窗口（崩在中间就永久留下），
 * 更要紧的是「取最新版本」与「写这一行」必须同刻 —— WriteQueue 排的是
 * 【事务之间】的顺序，两次 node() 就是两个事务，中间允许别人提交一版，
 * 于是会建出一行「在 v7 生效之后建、却盖着 v6」的任务，而且一句报错都没有。
 * 那正是 §18.4 建版本化想防的事，所以取数走 org/commit.ts 的 currentGraphVersion，
 * 与 INSERT 共用 node() 回调里这条连接、这个事务。
 */
export const INSERT_TASK_SQL =
  "INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node, " +
  "created_at, updated_at, graph_version) VALUES (?, ?, ?, 'CHARTER_PENDING', ?, 'intake', ?, ?, ?)";

export async function insertTask(
  w: Writer,
  o: {
    readonly id: string;
    readonly title: string;
    readonly parentId?: string;
    readonly assignedRole: string;
    readonly nowMs: number;
  },
): Promise<void> {
  // 同样排队，但理由与 applyDecision 那条【不一样】，所以单独写：
  // 那里排队是为了「两次点击不打架」，这里是【装配上的一致性】——
  // 同一个写入方一半走队列一半不走，走的那半就要去猜没走的那半什么时候提交。
  // 全部走队列之后，「父任务的那次事务先于子任务提交」是队列给的顺序，
  // 不需要谁去记得先建父再建子。
  // 回调保持【全同步】是排队有效的前提 —— node() 里一 await，
  // 事务就横跨微任务，P1 那句报错就会在这里复现。
  // 取版本那一发也在回调【里面】：params 若在回调外算好，「读版本」就发生在
  // 事务之外，上面那段「读到 v6 → 别人提交 v7 → 落成 v6」原样复现。
  await w.node(() => {
    const db = requireScopeDb("insertTask");
    const params: unknown[] = [
      o.id,
      o.parentId ?? null,
      o.title,
      o.assignedRole,
      o.nowMs,
      o.nowMs,
      currentGraphVersion(db),
    ];
    assertSingleStatement(INSERT_TASK_SQL);
    assertParamCount(INSERT_TASK_SQL, params);
    db.prepare(INSERT_TASK_SQL).run(...(params as never[]));
  });
}

/** 同 Writer：定义在 db/write-queue.ts，这里只 re-export。 */
export type { HubWriter };

export interface RealHubDepsOptions {
  /** 单写者队列。写入走 node()，对外读取走 readConnection()。 */
  readonly queue: HubWriter;
  readonly bus: EventBus;
  readonly token: string;
  /** 按任务给一张图。理由见 TaskGraph —— 一张共享图会写错任务而不报错。 */
  readonly graphFor: (taskId: string) => TaskGraph;
  /** 新任务的受理角色。默认节点名，与图里 intake 的 roleId 同一个取值口径。 */
  readonly intakeRole?: string;
  readonly now?: () => number;
  readonly nonces?: HubDeps["nonces"];
  /** Command 构造点，透传给 makeResumeGraph。测试用它让 resume 分支本机可跑。 */
  readonly makeCommand?: ResumeDeps["makeCommand"];
}

/**
 * 装配一份【真的会写库、真的会驱动图、真的会广播】的 HubDeps。
 *
 * 写这个文件之前，HubDeps 只有测试里的手搓字面量这一个来源（两个 http 测试文件
 * 各一份），而 `serveHub` 没有任何非测试调用点。这就是「HTTP 层是壳」的机械证据。
 * 本函数是第一个生产侧来源。它只负责【装配】不负责 listen：
 * 库文件路径、端口、token 打印三件事属应用配置，CLI 至今刻意不提供默认库路径
 * （cli.ts 文件头纪律 1：不给代码编一个「谁也没决定过、但写着」的路径）。
 * 真入口（Electron 主进程 / `hub serve`）到 Task 2.2/2.9 落地时接这一行。
 *
 * 【上面两句的时效，日期 2026-11-11，原文留着不删】「`serveHub` 没有任何非测试调用点」
 * 是当时的 grep 结果，今天已经不成立：`serve/assemble.ts` 是 `buildHubDeps` 与 `serveHub`
 * 的共同调用方（0025 §1）。而「真入口」那句里的两个名字**一个都没落地**，其中一个还写错了：
 * `hub serve` 这个子命令【不存在】（cli.ts 的 VERBS 只有 run / status / resume，
 * 敲它是「未知子命令」退出 2）；今天的真入口是 `pnpm hub:serve`，
 * 它仍然不是 Electron 主进程 —— 0025 §7 第 5 条登记的就是这一格（还没被进程管理器管起来）。
 *
 * ⚠ 装配之后仍有一件事【没被证明】：图恢复那条链（makeResumeGraph 真的驱动图）
 * 与「批准之后看板上的卡片真的变了」在本机【一次也没跑过】。前者缺 @langchain/*，
 * 后者缺 React。别把本模块的绿读成 Task 2.9 那条 E2E 过了。
 */
export function buildHubDeps(o: RealHubDepsOptions): HubDeps {
  const now = o.now ?? Date.now;
  const resumeGraph = makeResumeGraph({
    graphFor: o.graphFor,
    ...(o.makeCommand === undefined ? {} : { makeCommand: o.makeCommand }),
  });
  const intakeRole = o.intakeRole ?? "intake";
  const publish = (e: DomainEvent, seq: number): void =>
    o.bus.publishPersisted(e, seq);
  return {
    // 只读连接。给它而不是写连接：app.ts 里那三条 SELECT 是对外读的活
    // （GET /tasks、GET /tasks/:id、decide 前面那次 status 查询），
    // 走只读连接就【不会】被写队列排住，也不会拿到未提交的数据（§5.5）。
    db: o.queue.readConnection(),
    bus: o.bus,
    token: o.token,
    now,
    ...(o.nonces === undefined ? {} : { nonces: o.nonces }),
    recordDecision: async ({ approvalId, taskId, resume, note }) =>
      applyDecision(
        o.queue,
        {
          approvalId,
          taskId,
          resume,
          ...(note === undefined ? {} : { note }),
          nowMs: now(),
        },
        publish,
      ),
    createTask: async ({ id, title, parentId, nowMs }) =>
      insertTask(o.queue, {
        id,
        title,
        ...(parentId === undefined ? {} : { parentId }),
        assignedRole: intakeRole,
        nowMs,
      }),
    resumeGraph,
  };
}

/**
 * 新任务 id 的生成点【不在这里】，仍是 app.ts 那一次 randomUUID。
 * 我一开始在这里加了一个导出的 newTaskId()，然后删掉了：它没有任何调用方，
 * 而 id 生成多一个入口就多一处「两处各生成、形状将来不同」的漂移点
 * （比如哪天有人把这里改成 crypto.randomUUID().toUpperCase()）。
 * 记这一条是为了下一个想「统一一下 id 生成」的人：先给 app.ts 那处找好唯一入口，
 * 再加工具函数，而不是反过来。
 */
