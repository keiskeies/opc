/**
 * Hub 决策与建任务的**真实写入路径**（计划 Task 2.1 的落地半边 + Task 2.6 的 Hub 侧一半）。
 *
 * ── 这个文件存在的理由：HTTP 层此前是一层【壳】──────────────────────────
 * app.ts 把副作用收在两个注入点上（recordDecision / createTask），注释写的是
 * 「生产用真 recorder」。把仓库翻一遍的实测结果（三条都是当场 grep 的，不是回忆）：
 *   · `grep -rn "INSERT INTO approvals\|UPDATE approvals" packages/hub/src` ⇒ 0 命中
 *     ⚠ 这条 grep 在 0026 之后【不再为 0】（approvals/cards.ts 补了创建路径），
 *     原文按口径留着。它当时量到的是「UPDATE 也没有、INSERT 也没有」里的那一半：
 *     UPDATE 后来由本文件与 policy/auto-approve.ts 补上，INSERT 由 cards.ts 补上，
 *     而【零生产者】这件事单独记（该文件与 phase3.test.ts 的 blocker 6）。
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

import {
  APPROVAL_STATUS_PENDING,
  CEO_ROLE_ID,
  type OrgActor,
  type ResumeValue,
} from "@opc/contracts";
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
import {
  commitOrgGraph,
  currentGraphVersion,
  readLatestGraph,
  RUNNING_TASKS_SQL,
} from "../org/commit.js";
import {
  issueToken,
  newApprovalToken,
  precheckIssue,
  redeemToken,
  type TokenIssueReject,
  type TokenRejectReason,
} from "./tokens.js";
import type { HubDeps } from "./app.js";
import {
  createBackupOffLoop,
  type BackupOffLoopOutcome,
  type BackupOffLoopRequest,
} from "../db/backup.js";

/** CEO 这一侧的动作在审计里的身份。 */
export const CEO_ACTOR = { actorType: "human", actorId: "ceo" } as const;

/**
 * 组织提交的 actor（0040）。commitOrgGraph 收的 `actor` 是 contracts 的 OrgActor
 * （{type, id}），与上面 CEO_ACTOR（审计行里那个 {actorType, actorId}）【不是同一个型】。
 * 组织变更只认 CEO 提交（[spec] §4.2.3 组织权集中给 CEO，validateOrgChange 已把
 * 「actor 不是 human/ceo」判过）—— 这里写死 compile-time，因为 POST /org 的
 * 请求体里【没有】actor 键，能到此地的只可能是本机回环（`--backup-dir` 那条装配
 * 决定它接没接），而本机持有者是这台机器的运营者。别把它做成可注入/可请求覆盖的：
 * 那等于把「谁改了组织」交给调用方自报。
 */
export const ORG_COMMIT_ACTOR: OrgActor = { type: "human", id: CEO_ROLE_ID };

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
 * `WHERE status = ?`（绑 `APPROVAL_STATUS_PENDING`）是幂等承重那一步。为什么不先 SELECT 再 UPDATE：
 * 两次读之间可以有一次并发写入（同一张卡片在两个窗口各点一次），
 * 那时「查出来是 pending」与「写下去」之间不是原子的，
 * 而 events 是 append-only —— 第二条决策事件写下去就删不掉，
 * 回放会重建出「这个审批批过两次」。把判定压进 WHERE 之后，并发那一支的
 * info.changes 是 0，我们在【写下事件之前】就知道没抢到，于是根本没有第二次审计可写。
 * 这是 §8.2 第 4 条同一条思路：能绕过的那条路不要留在那里，
 * 而不是写注释提醒别人别绕。
 *
 * ⚠ 这一格的 `pending` 从前是 SQL 文本里的**字面量**，0026 §9 留的问题就是它该不该改成绑参，
 * 今天改了。改的动机不是好看：`contracts` 里那句「SQL 文本里没法引用 TS 常量」当时是**事实**，
 * 而它只对「把常量拼进字符串」那一种做法成立 —— 绑参是另一条路，走通之后
 * 「建卡初值 / 列表过滤 / 认领条件」三处**在编译期同源**，于是一条靠扫源码维持的断言
 * 失去了分母，已删（0026 §9 明写「那条扫描在 SQL 改成绑参的那天必须删掉」）。
 *
 * ⚠ **但绑参换来一个新的失效方式，必须一起记**：字面量年代 `WHERE id = ? AND status = 'pending'`
 * 只有**一个**占位符，形状上不可能填错方向；现在有两个，
 * 把 `approvalId` 与 `PENDING_LITERAL` 的顺序写反 ⇒ SQL 变成 `id = 'pending' AND status = <那个 id>`
 * ⇒ **匹配 0 行** ⇒ `changes === 0` ⇒ 函数返回「没抢到」，**不抛错、不写审计、HTTP 报 404**。
 * 也就是说这种错的形态是「这张卡永远批不掉」，而不是「参数错了」。
 * `assertParamCount` 挡不住它（个数是对的）。真正挡得住的只有**正向那一发**：
 * `real-deps.test.ts` 那条「第一次 applyDecision 必须返回 true」——
 * 顺序写反它当场红。**所以那条断言不许被改成只测幂等那一半。**
 *
 * `decided_by` 存的是【谁】而不是【决定了什么】：status 已经回答了后者
 * （schema 注释：decided_by TEXT）。把 resume 值抄进 decided_by 是把两列当一列用，
 * 以后要支持多审批人就没地方放了。
 */
export const CLAIM_APPROVAL_SQL =
  "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? " +
  "WHERE id = ? AND status = ?";

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
    // 顺序【必须】与 SQL 里占位符的出现次序一致：SET 的四列 ⇒ WHERE id ⇒ WHERE status。
    // 最后那一个绑的是 contracts 的 APPROVAL_STATUS_PENDING —— 这一格从前是 SQL 里的
    // 字面量 'pending'，改绑参之后「建卡初值 / 列表默认过滤 / 认领条件」三处编译期同源。
    // ⚠ 这里把最后两项写反【不会】被 assertParamCount 抓到（个数是对的），
    // 症状是「这张卡永远批不掉」而不是「参数错了」；挡住它的是
    // real-deps.test.ts 那条【第一次决策返回 true】的正向用例，不许删。
    const params: unknown[] = [
      status,
      CEO_ACTOR.actorId,
      o.nowMs,
      note,
      o.approvalId,
      APPROVAL_STATUS_PENDING,
    ];
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

/**
 * 签一张一次性审批 token 的【装配包装】（Task 4.1）。
 *
 * 与 redeem 那一层对称，但【只有一件事】是这里新增的：签发也要写库（INSERT im_tokens），
 * 所以它同样必须走单写者队列，理由与 redeemApprovalTokenVia 第一条完全相同。
 *
 * ── 这张票签给谁：调用方 ──────────────────────────────────────────
 * 只有 HTTP 层会调它（POST /approvals/:id/token），而那条路由【只认回环对端 + HMAC】
 * —— 也就是「坐在这台机器前的 CEO 要一张能发给手机的票」。
 * 将来图里升级那一刻直接建卡+签票时，应当直接调 tokens.ts 的 issueToken
 * 放进那一个事务里（与 insertCard 同事务，理由写在 cards.ts createCard 第 ① 条），
 * 而【不要】调这一层 —— 这层自己开节点，嵌套进一个已开着的事务里会撞上
 * write-queue 那条「不得嵌套」的守卫（0010 §2）。
 *
 * ── 为什么票与卡【不在同一个事务】里签 ────────────────────────────
 * 走 HTTP 这条路时卡片早就存在了（不然预检就拒了），所以这里没有「半个卡片」的窗口。
 * 反过来，签票失败（比如卡片不存在）不会伤到卡片本身。
 * 这条分离在图那条链接上之后要重新审一次：那时同事务才是对的。
 * ⚠ 但【预检 + INSERT】这两步【确实】在同一个 node() 里（见函数体旁边那段）。
 *   「卡片与票不必同事务」讲的是【创建时机】，不是「整个函数不用原子性」——
 *   这两句混着读会得出一个错的结论，所以写在一处。
 *
 * ── 返回原文【一次】，且只经这一条路 ─────────────────────────────
 * 库里只有哈希（tokens.ts 文件头），所以这一刻是【唯一】能拿到原文的时候。
 * 它不进事件、不进日志、不进任何持久列 —— 只进这一次 HTTP 响应体。
 * 「忘了这张票」的修法是【再签一张】，不是找回旧的（issueToken 可重复调用）。
 */
export async function mintApprovalTokenVia(
  w: Writer,
  o: { readonly approvalId: string; readonly nowMs: number },
): Promise<
  | { readonly ok: true; readonly token: string; readonly expiresAt: number; readonly taskId: string }
  | { readonly ok: false; readonly reason: TokenIssueReject }
> {
  // 预检与 INSERT 在【同一个 node()】里 —— 不是两次 await。
  // 分成两次会得到一个真窗口：预检时卡片还是 pending，两次之间被桌面端批掉，
  // 于是签出一张【指向已决策卡片】的票。它的症状不在签发时刻，
  // 而在手机上一次「点了没反应」（redeem 走 approval_not_pending），
  // 排查的人会去查手机与网络，而根因在几十秒前那次签发。
  return await w.node(() => {
    const db = requireScopeDb("mintApprovalToken");
    const pre = precheckIssue(db, o.approvalId);
    if (pre.ok !== true) return pre;
    const raw = newApprovalToken();
    // expiresAt 直接取 issueToken 的返回值，不在这里重算一遍 nowMs + TTL。
    // 重算是能写的（式子就一项），而它会把「TTL 默认值」变成两处各自持有的事实：
    // 哪天改 DEFAULT_TOKEN_TTL_MS 只改一处，响应里那个数就与库里那一行不符，
    // 症状是「手机上显示还剩 9 分钟而服务端已经拒了」。
    // 让 issueToken 说话，这条不符就【写不出来】—— 比写一条测试挡着它更便宜。
    // ⚠ 「比测试便宜」这句是【准确的】，而我一开始在下面写的是一条【证不到这件事】的
    //   断言（对账 r.expiresAt 与库里那一行）—— 两个式子都算 NOW + 同一个常量时它恒成立。
    //   真正的守卫是一条结构判据：本文件【不许出现】 DEFAULT_TOKEN_TTL_MS
    //   （real-deps.test.ts 里那条，含两条反向对照）。别把那条读成「行为已被验证」。
    const { expiresAt } = issueToken(db, {
      rawToken: raw,
      approvalId: o.approvalId,
      nowMs: o.nowMs,
    });
    return { ok: true, token: raw, expiresAt, taskId: pre.taskId };
  });
}

/**
 * 一次性审批 token 的【装配包装】（Task 4.1）。
 *
 * ── 为什么这里只是一层包装 ──────────────────────────────────────────
 * 判据全部在 http/tokens.ts（一次/一张/过期/不可逆）。这一层只干两件装配的事：
 *  ① 【走单写者队列】。redeem 是【写】（UPDATE im_tokens + 一行 events），
 *     而 app.ts 手上那个 deps.db 是【只读连接】（下面 buildHubDeps 给的是
 *     queue.readConnection()）。在 app.ts 里直接 db.prepare(...).run() 会绕开队列 ——
 *     那正是 0010 §2 实测过的 P1/P2 那一族（同连接重入 / 与超步事务互踩）。
 *  ② 【广播烧票那一行】。这一件比第一件更容易被省掉，而省掉的代价是本仓量过的：
 *     redeemToken 写了一行 events，而 events.id 就是 seq。写了不 publish
 *     ⇒ 活着的 SSE 订阅撞见一个 seq 空洞 ⇒ 投影层把 link 标成 stale 去重拉快照
 *     ⇒ 【每一次远程批准都把连接标脏一次】（0010 §4，与上面 applyDecision
 *     那个 publish 必填参数同一条理由）。所以 publish 在这里同样是【必填】，
 *     不给默认值：「选择不广播」与「忘了广播」在代码上必须长得不一样。
 *
 * ── 为什么 redeem 与 decide 是两个事务，而不是合成一个 ────────────────
 * tokens.ts 文件头那格写的是【顺序】的选择（先烧票、后决策），这里补上它在这一层的形状：
 * 合成一个事务要给它开一个通用 hook，而一个通用 hook 能做的事比它换来的原子性多得多。
 * 今天崩在中间的后果是「票烧了而卡片还是 pending」，
 * CEO 看到的是手机上那句「链接失效，请在桌面端重新点一次」—— 吵，而不是吞。
 *
 * ⚠ 【approvalId 由谁定】这件事在这一层是【不做二次判断】的：
 * redeemToken 已经把票上那张卡与 URL 上那张卡比过了（不传 expectedApprovalId 时
 * 用票上那张）。这里返回的 taskId 直接来自那一行 JOIN，不再自己查一次 approvals ——
 * 再查一次就是【第二份「这张卡存不存在」的判据】，而两份判据之间的时间差
 * 会让「票有效而卡刚被批掉」在两条路上得到不同答案（一个 401、一个 404，
 * 都是对的，而同时存在就是分歧）。
 */
export async function redeemApprovalTokenVia(
  w: Writer,
  o: { readonly token: string; readonly approvalId: string; readonly nowMs: number },
  publish: (e: DomainEvent, seq: number) => void,
): Promise<
  { readonly ok: true; readonly taskId: string } | { readonly ok: false; readonly reason: TokenRejectReason }
> {
  const r = await w.node(() =>
    redeemToken(requireScopeDb("redeemApprovalToken"), {
      rawToken: o.token,
      nowMs: o.nowMs,
      expectedApprovalId: o.approvalId,
    }),
  );
  if (r.ok !== true) return { ok: false, reason: r.reason };
  // 提交之后才 publish（与 applyDecision、recorder.#flush 同一个时机）：
  // 事务回滚而事件已广播 = 前端收到一条库里【不存在】的事件，且永不自我纠正。
  publish(r.event, r.seq);
  return { ok: true, taskId: r.taskId };
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
  /**
   * 「谁校验 IM 身份绑定」写进 verified_by 的那个名字（0031）。
   * 不给 ⇒ POST /bindings/verify 回 501。为什么这里【不设默认值】，
   * 整段论证在 HubDeps.bindingVerifier 旁边，那份是唯一一处，不重抄。
   */
  readonly bindingVerifier?: string;
  /**
   * 组织提交的装配（0040）。缺这一组 ⇒ buildHubDeps 不装 commitOrgChange ⇒
   * POST /org 回 501。
   *
   * dbPath + backupDir 是【备份的传达】：§6.5 要求「改组织之前留下一份能回到
   * 起点的快照」，而备份的实体（VACUUM INTO 到哪、保留几份）由这两格决定。
   * 只有 dbPath/backupDir 都给齐了，装配才认为这台 Hub 为改组织准备好了恢复。
   * ⚠ 与 assemble 的 boot `--backup-dir` 相隔一个装配参数：今天这两处都由
   * serve/assemble.ts 传同一个值，见那边 —— 它们各自独立成立，别改一处忘另一处。
   *
   * backupBeforeCommit 是备份的执行点，默认真 createBackupOffLoop（异步 worker）。
   * 可注入同 BootOverrides.backupVia —— 测试想钉「备份在提交前真的发生了、且失败
   * 就拒绝提交」时，给它一个记录调用的替身。生产走默认。
   */
  readonly orgBackupDir?: string;
  readonly orgDbPath?: string;
  readonly backupBeforeCommit?: (
    req: BackupOffLoopRequest,
  ) => Promise<BackupOffLoopOutcome>;
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
    redeemApprovalToken: async ({ token, approvalId }) =>
      redeemApprovalTokenVia(o.queue, { token, approvalId, nowMs: now() }, publish),
    issueApprovalToken: async ({ approvalId, nowMs }) => mintApprovalTokenVia(o.queue, { approvalId, nowMs }),
    // 绑定那三条写路由走【同一个队列】（0031）。给它而不是给 deps.db 那条只读连接：
    // 上面每条写路径写明的同一条理由（P1 同连接重入），没有第二条更弱的写通道。
    bindingWriter: o.queue,
    ...(o.bindingVerifier === undefined ? {} : { bindingVerifier: o.bindingVerifier }),
    // 组织提交（0040）。只有当装配给了 dbPath + backupDir 才装 —— 那就是
    // 「这台 Hub 为改组织准备了恢复」（文件头 + HubDeps.commitOrgChange 那两段）。
    ...(o.orgBackupDir === undefined || o.orgDbPath === undefined
      ? {}
      : {
          commitOrgChange: makeCommitOrgChange({
            queue: o.queue,
            dbPath: o.orgDbPath,
            backupDir: o.orgBackupDir,
            backup: o.backupBeforeCommit ?? createBackupOffLoop,
            nowMs: () => now(),
          }),
        }),
    // 组织图的读路径（GET /org，0040 的配套读侧）。读不改表、不需要备份，
    // 所以【无条件装】（同 deps.db 那只看读连接：读路径不该被写装配卡住）。
    // 走 o.queue.readConnection() —— 与 deps.db 同源，但贴合「组织的读不归 bindings
    // 那条集群读」的归属（org/commit.ts 文件头「HTTP 是组织功能的一个入口」）。
    readOrgGraph: (() => {
      const db = o.queue.readConnection();
      return () => {
        const latest = readLatestGraph(db);
        if (latest === null) return { versions: 0 };
        return {
          versions: latest.version, // 最新版本号即「提交过的层数」（版本从 1 起连续）。
          version: latest.version,
          graph: latest.graph,
          graphId: latest.graphId,
          effectiveFromMs: latest.effectiveFromMs,
          // exactOptionalPropertyTypes：changeSummary 可能为 null，不能给 undefined，
          // 用条件展开把「没有 summary」表达成缺键（和 graphId/effectiveFromMs 同族）。
          ...(latest.changeSummary === null
            ? {}
            : { changeSummary: latest.changeSummary }),
        };
      };
    })(),
    resumeGraph,
  };
}

/**
 * 组织提交的装配（0040）。
 *
 * 顺序（顺序就是 §6.5 的判据）：
 *   ① 变更【之前】先备份（VACUUM INTO 快照）—— 提交成功则这次改图有恢复点；
 *   ② 备份失败 ⇒ 拒绝提交，不给新版本号（reason 「backup_failed」+ 原文）。
 *   ③ 备份成功 ⇒ commitOrgGraph（内部自己读写 transactions + 审计）。
 *
 * running tasks 在【事务外】查 —— commitOrgGraph 收 runningTasks 是纯函数原则
 * （validateOrgChange 要用它判「有运行中任务时该不该要确认」），它要求调用方
 * 先查好传进去。查的动作不能放进 w.node() 的事务里（那是读，且会影响「拒绝也
 * 不写东西」的语义 —— commitOrgGraph 的校验在开事务前）。所以这里在
 * commitOrgGraph 之前的只读连接上查。⚠ 读连接可能不包含「最后一次写入」？
 * —— running tasks 只要「大致当前」：它是决定「要不要 needsConfirmation」用的，
 * 差一条正在 superstep 中间的任务，最坏是多一次或少一次确认提示，不是权限/审计错。
 * 而备份跑在【改图之前】，天然领先提交 —— 它看到的 running tasks 与提交时之差，
 * 只会是「刚好要 DELIVERED」这种收敛方向。
 */
export function makeCommitOrgChange(o: {
  readonly queue: HubWriter;
  readonly dbPath: string;
  readonly backupDir: string;
  readonly backup: (req: BackupOffLoopRequest) => Promise<BackupOffLoopOutcome>;
  readonly nowMs: () => number;
}): NonNullable<HubDeps["commitOrgChange"]> {
  return async ({ graph, change, changeSummary }) => {
    // ① 变更前备份。失败 ⇒ 拒绝提交（§6.5：改组织前必须能回到起点）。
    const bk = await o.backup({ dbPath: o.dbPath, backupDir: o.backupDir });
    if (!bk.ran) {
      // worker 整体没跑（接错线），理由在 ran:false 那一支的 message。
      return {
        ok: false,
        reason:
          "改组织前的备份没做成，拒绝提交（§6.5：改组织之前要留一份能回到起点的快照）。" +
          "原因：" + bk.message,
        code: "backup_failed",
      };
    }
    if (!bk.result.ok) {
      // 备份跑了但 createBackup 判它失败，理由在 result（BackupFailed）的 message。
      return {
        ok: false,
        reason:
          "改组织前的备份没做成，拒绝提交（§6.5：改组织之前要留一份能回到起点的快照）。" +
          "原因：" + bk.result.message,
        code: "backup_failed",
      };
    }
    // 备份成功，继续。③ 查 running tasks（事务外，见函数上方那段）。
    assertSingleStatement(RUNNING_TASKS_SQL);
    const rows = o.queue.readConnection().prepare(RUNNING_TASKS_SQL).all();
    const runningTasks = rows.map((r) => String(r.id));
    // ② 提交。
    return commitOrgGraph(o.queue, {
      graph,
      change,
      actor: ORG_COMMIT_ACTOR,
      runningTasks,
      nowMs: o.nowMs(),
      changeSummary,
    });
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
