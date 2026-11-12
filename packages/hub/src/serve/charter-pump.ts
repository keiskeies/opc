/**
 * 常驻 Hub 的章程泵：把「有任务停在 CHARTER_PENDING 而收件箱里没有卡」这一格补上。
 *
 * ── 为什么需要它（0043 §6 第一条没接的东西）──────────────────────────
 * 任务一落地就是 CHARTER_PENDING（real-deps 的 INSERT_TASK_SQL 写死），而那一格是
 * 【人类席位】：dispatch 连 token 都不烧。CEO 要点的是【一张卡】，而全仓只有
 * engine/charter.ts 建这种卡，而它只有 `hub work` 一个调用方，而那条路要 tsx
 * + 一个装不上的依赖（0039）。
 * 于是今天的真实表现是：`POST /tasks` 下发一个想法 ⇒ 任务建出来 ⇒ 收件箱【空的】
 * ⇒ 永久停住。0043 接上的是「卡被点之后会发生什么」，这一篇接「卡从哪来」。
 *
 * ── 为什么泵住在 serve/ 而不是 engine/ ───────────────────────────────
 * 「什么时候再试一次」是【常驻进程的节奏】，不是【引擎的能力】。engine/ 那一侧
 * 已经知道怎么起草一张卡（ensureCharterCard），而反过来放会让 engine/ 认识 Scheduler
 * —— 它今天能在 CLI 里单发跑完靠的就是它不认识任何东西。
 * 同 patrol.ts 那句「故意不 setInterval，tick 由调用方驱动」：本文件也叫一次动一次。
 *
 * ── 重试上限住在【审计】里，不住在新列里 ────────────────────────────
 * 一个会花钱的重试循环必须有界。有界要数得出「这是第几次」，两种数法：
 *   ① tasks 上加一列 charter_attempts —— 要一条新迁移，而且那一列与 events 是
 *      【同一个事实的两个来源】（events 里本来就有那一轮），
 *      也就是 0041 §2「同一个数在两张表上给出两个答案」的新实例。
 *   ② 数 events 里这一格试过的次数 —— 现成的，且【已经有索引】。
 * 选 ②。它成立的前提是「CHARTER_PENDING 上的 RoleTurnReported 只可能是章程起草轮」。
 * 这一条是查过的而不是推测：`grep -c 'to: "CHARTER_PENDING"' engine/dispatch.ts` = 0，
 * 也就是说没有任何一条合法边能把任务送回这一格，所以停在这一格的任务身上
 * 那些轮次全部来自这里（⚠ 这条判据断掉时【不会有人发现】，
 * 所以 test/engine/dispatch.test.ts 里有一发表扫描专门盯着它）。
 *
 * ── 零花费的失败也算一次尝试（本文件能存在的前提）────────────────────
 * 本机最可能的失败恰恰是【零花费】那一支：claude 装不上 / spawn ENOENT ⇒ costCents=0。
 * charter.ts 旧形状把那一种失败写成【events 零行】（0043 §10 实测），
 * 于是「第几次」永远数出 0 ⇒ 上限永不生效 ⇒ 每个心跳重新起一次子进程，无限、静默。
 * 那一条已修（失败轮无条件留痕）。依赖写在这里是因为它坏了的时候本文件不会红
 * —— 它只会变成一个花不出钱也停不下来的循环。
 *
 * ── 花钱的东西不给默认值，也不默认开 ────────────────────────────────
 * 同 0041 §8（--max-budget-usd / --task-limit-cents 必填）与 --bind 那条立场
 * （打开一件会动外部世界的事，必须是这次命令里一个看得见的参数）。
 * 所以 `--charter-pump` 不写 ⇒ 这一整块不存在，`hub:serve` 今天照样一分钱不花。
 *
 * ── 本文件【没有】补上的一格（读代码的人最容易以为它补了）─────────────
 * CEO 用 reject_with_comment 退回一份章程之后：任务仍停在 CHARTER_PENDING，
 * 而那张卡所在的 card_key 上【永远不能再有第二行】（0004 那条唯一索引不看 status），
 * 所以泵不可能重新起草第二份；而 [规格] §7.1 那边也【没有】reject 的出边
 * （0043 §6：HUMAN_EDGES 里只有 approve）。
 * 一条退回的意见从此【没有去处】。正确的解法是【card_key 带轮次 + 补一条回到起草的边】
 * 两件事一起做，不是这里能顺手补的一格 —— 详见 CHARTER_CANDIDATES_SQL 那段。
 * 这条缺口有一条断言钉着现状（charter-pump.test.ts B 组「卡被退回也一样不起子进程」），
 * 补它的那天那一发会红，逼改的人看见自己在改什么。
 */
import type { DomainEvent, EventBus } from "../events/bus.js";
import type { HubWriter } from "../db/write-queue.js";
import { appendAudit } from "../events/recorder.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import {
  CHARTER_CARD_KEY,
  CHARTER_DRAFT_ROLE,
  ensureCharterCard,
  type CharterDraftOutcome,
} from "../engine/charter.js";
import { makeRuntime, type EngineRuntime } from "../engine/runtime.js";
import type { CostHook } from "../engine/dispatch.js";
import { kindOf } from "../heartbeat/patrol.js";

/**
 * 一个任务在【这一格】上试了几次章程起草。
 *
 * kind 那个表达式用的是 patrol.ts 的 kindOf —— 【不是顺手复用，是必须复用】：
 * 0003 那条 idx_events_task_kind_created 是【表达式索引】，它匹配的是字面写法，
 * 两侧一漂索引就【静默失效】（不报错、不变红，只是每轮多一次 events 全表扫）。
 * patrol.test.ts:746 那条已经在拿 kindOf 与 DDL 逐字比对了；我在这里另抄一份
 * 就是造出第二个抄本（0006 §7 那族），而抄本漂了不会有第三条用例发现。
 *
 * ⚠ 别名刻意写成 `p.`（而不是裸 `payload`）：kindOf 收别名前缀，
 * 而表达式索引认的是【解析后的列引用】—— 加不加前缀都能匹配，
 * 但这一条与下面候选里那两处必须写法一致，读的人才能一眼看出是同一个表达式。
 * 索引真被用上这一件事由 test/serve/charter-pump.test.ts 里那发
 * EXPLAIN QUERY PLAN 判（注释会漂，计划不会）。
 */
export const CHARTER_ATTEMPTS_SQL =
  "SELECT COUNT(*) AS n FROM events p " +
  "WHERE p.task_id = ? " +
  "AND " +
  kindOf("p") +
  " = 'RoleTurnReported'";

/**
 * 候选任务：停在章程那一格、【从来没有过】章程卡、且还没试到上限。
 *
 * 三个条件各挡一种浪费：
 *  · status —— 别的格子有 dispatch 那条路，不归这个泵管。
 *  · NOT EXISTS 章程卡 —— ⚠ 判据是【这张卡存不存在】，不是【这张卡是不是待批】。
 *    这一条是本文件最容易被"改严"改坏的一处，理由在 DDL 上：
 *      CREATE UNIQUE INDEX idx_approvals_card_identity ON approvals(task_id, card_key)
 *        WHERE card_key IS NOT NULL            -- 0004，【不带 status 条件】
 *    也就是说一个任务在同一个 card_key 上【一辈子只能有一行】，批掉、退回、defer
 *    都不放行第二行。于是「卡已决定而任务仍在 CHARTER_PENDING」这种状态下：
 *      · 按 status='pending' 筛 ⇒ 它进候选 ⇒ ensureCharterCard 那道前置检查
 *        （也只查 pending）放行 ⇒ 【起子进程、烧一轮 token】⇒ insertCard 撞唯一索引
 *        ⇒ already_pending。烧掉的钱换回一句"已经有了"。
 *      · 按【任何状态】筛 ⇒ 根本不进候选，一分钱不烧。
 *    两种写法在【第一次建卡之前】行为完全相同，只在退回/批准之后分岔 ——
 *    而那正是唯一会花钱的那一段。判据必须与 DDL 的约束【同一个形状】。
 *    （由此带出的一条产品缺口 —— 退回的意见没有去处 —— 写在文件头那节，
 *      不在这里重说一遍：同一个理由写在两处，改的时候只会改到一处。）
 *  · attempts < 上限 —— 见文件头那条「有界」。
 *    ⚠ 这一条【不能指望下面那个「判放弃」循环里的同一道判断替代】：那道判断跑在
 *    ensureCharterCard 【之后】，只能阻止"下一轮"，而本条阻止的是
 *    【本轮那一次真金白银的 spawn】。删掉它的表现是"上限多花一次钱才生效"，
 *    所以有一发用例专门数 spawn 次数（charter-pump.test.ts A 组最后一发）。
 *
 * ORDER BY created_at, id：最老的想法先补，且这一行是【确定的】——
 * 不确定排序 + 一个 limit 会出现「这轮没轮到它、下轮也没轮到它」那种饿死。
 */
export const CHARTER_CANDIDATES_SQL =
  "SELECT t.id AS id, t.title AS title, t.created_at AS created_at, " +
  "(SELECT COUNT(*) FROM events p WHERE p.task_id = t.id " +
  " AND " +
  kindOf("p") +
  " = 'RoleTurnReported') AS attempts " +
  "FROM tasks t " +
  "WHERE t.status = 'CHARTER_PENDING' " +
  "AND NOT EXISTS (" +
  "  SELECT 1 FROM approvals a WHERE a.task_id = t.id AND a.card_key = ?" +
  ") " +
  "AND attempts < ? " +
  "ORDER BY t.created_at ASC, t.id ASC " +
  "LIMIT ?";

/** 一轮最多补几张卡。它是【上限的上限】，方向是省，所以给得起默认值。 */
export const DEFAULT_PUMP_TASK_LIMIT = 3;

/** 一个任务在这格上允许试几次。三次拿不出一份提案，多半不是重试能解决的事。 */
export const DEFAULT_CHARTER_MAX_ATTEMPTS = 3;

/** 放弃那一行的 actor。与 patrol 的 STALL_ACTOR / charter store 的 CHARTER_ACTOR 同一形状。 */
export const PUMP_ACTOR = { actorType: "system", actorId: "charter_pump" } as const;

/**
 * 放弃那一行的 payload.kind。
 *
 * 【新开一个 payload.kind】而不是复用 RoleTurnReported：后者语义是「某个角色跑了一轮」，
 * 而这一行说的是「泵决定不再试了」—— 泵不是角色，也没跑任何一轮。
 * 复用会让上面那条计数判据把「放弃」也数成一次尝试，于是上限自己数自己，
 * 而那种错的方向恰好是【更早放弃】，最难往回查。
 *
 * ⚠ 这里【不新增 DomainEvent 的 kind】，所以它【不广播】—— 三条理由：
 *  ① DomainEvent 那个判别联合（bus.ts）与 EventKind 是同一个东西，加一个 kind
 *    要么改 contracts（跨包改动，且 web 的投影要接），要么在这里 cast 一个联合外的值。
 *  ② 后者走不通 —— ⚠ 而我原来给它写的理由【是假的】，留在这里而不是删掉（0044 §6）：
 *    我原写「today.ts:41 把解不出 kind 的行判为脏数据，前端解不出来会标 stale，
 *    等于制造一个脏流」。三处坐标里两处指错（41 行是一句 import 注释、sse.ts:48 讲的是 seq 去重），
 *    而更根本的是【结论方向反了】，读了一遍真实通路才知道：
 *      · contracts/api.ts 的 feedItemSchema 里 kind 是 z.string().min(1)，schema 是 .passthrough()
 *        ⇒ 一个联合外的 kind 【通得过】校验，不会被拒、不会标 stale；
 *      · web 那侧（projection.ts 的 switch）未命中落 default 那一支，注释明写
 *        「其余事件类型【不改 tasks】，只推进 cursor」；
 *      · 那个 switch 外面就是它文件头立的「宁可抛也不静默跳过」那条立场 ——
 *        那条立场管的是【schema 解不过】，而我这个 kind 恰好【解得过】，
 *        于是它从"会被响亮拒绝"掉进"被立场保护不到的那条缝"。
 *    ⇒ 真后果不是脏流，是【一条被客户端静默丢弃的帧】：库里有、SSE 发了、界面什么都不变。
 *    那比脏流更糟：脏流会报错，这一种从头到尾没有任何一处不响，
 *    正好是本项目一路在消灭的那种"无人知晓的洞"（projection.ts 文件头原话）。
 *    所以"发出去了"与"有人收到了"是两件事 —— 把通知做在一条注定被丢弃的帧上，
 *    等于我自己造一个新的静默格，而这一格存在的理由正是"别再静默"。
 *  ③ 更要紧的是【没有对应的状态跃迁】：见下面 PUMP_GAVE_UP_TARGET 那段。
 * 这条信息的受众是【运维】（「泵不再试了，得人工看一眼」），不是界面。
 * 库里有、CLI 读得出来、状态面上本轮也返回了 —— 这三样够了。
 * 真要上界面，正解是 contracts 加 kind + 投影接那一支 + 一条断言，三件一起做，不是在这里 cast 一下。
 */
export const CHARTER_GAVE_UP_KIND = "CharterDraftAbandoned";

/**
 * 放弃那一行的 target。
 *
 * 照 charter/store.ts 与 org/commit.ts 那两处【纯审计行】的先例：target 指向
 * 【这件事本身】而不是某个能点开的对象（岗位书那条用 `roleId@vN`，组织图那条用版本号）。
 *
 * ⚠ 我初版写的是 "CHARTER_PENDING" 并顺手 publish 了一条
 * TaskStateChanged{from:"CHARTER_PENDING", to:"CHARTER_PENDING"}。那是错的，
 * 而且错得隐蔽：web 的投影（packages/web/src/hub/projection.ts）按事件【应用跃迁】，
 * 一条自指的跃迁是【一次真的状态变更】被凭空造出来 ——
 * 而 events 是 append-only（0014 §3），这条假跃迁删不掉。
 * 「泵放弃了」不是一次任务状态变更：任务哪儿也没去，仍停在 CHARTER_PENDING。
 */
export const PUMP_GAVE_UP_TARGET = "charter:pump";

/**
 * 起草一轮要用的那三格回调。
 *
 * 单独抽出来是因为【默认值要现造真 runtime，测试要的是一份不花子进程的】，
 * 而这两件事必须在同一个注入点上分岔。它是【惰性】的：候选为空那一轮
 * 一次都不该被调 —— 默认那一支会建起真 runtime，而它一旦建起来，
 * 被调用的那一次 runTurn 就是【真 spawn 一个 claude 子进程、真花钱】。
 */
export interface CharterCardDeps {
  readonly runTurn: (i: {
    readonly role: string;
    readonly rolePrompt: string;
    readonly prompt: string;
    readonly resumeSessionId: string | null;
    readonly maxBudgetUsd: number;
  }) => Promise<CharterDraftOutcome>;
  readonly rolePrompt: (roleId: string) => string;
  readonly onCost?: CostHook;
  readonly ceoRoleId?: string;
}

export interface PumpOptions {
  readonly nowMs: number;
  /**
   * 现造起草用的那一套回调。默认走真 runtime（makeRuntime）。
   * 测试注入一份不 spawn 的 —— 这一发要测的是【泵的节奏】，
   * 而「能不能起子进程」在 claude.test.ts / runtime.test.ts 里各自钉住了。
   */
  readonly cardDeps?: () => CharterCardDeps;
  /**
   * 一轮起草落进 harness_calls 的那一笔（§12.7 第 4 层）。默认走真 runtime 的 recordTurn。
   *
   * ⚠ 这一格在【整个仓】今天是【每调一次少一次】的状态：CLI 那条 `hub work`
   * 调 ensureCharterCard 时【没有】调 recordTurn（engine/work.ts:413 读一眼就知道），
   * 也就是说「章程起草那一轮花了多少」今天【不进执行日志】，而 §12.7 第 4 层
   * 写的是「每次调用都留痕」。泵【补上】这一格（见 recordTurns 那段那句理由），
   * 并把 CLI 那一格登记成本篇的未接项 —— 因为泵补上之后，
   * 「同一个模块两条调用方一条留痕一条不留」会变成一个新的两源分叉。
   */
  readonly recordTurn?: EngineRuntime["recordTurn"];
  /** 一轮给一个角色的美元硬顶。必填：不给默认值（0041 §8）。 */
  readonly maxBudgetUsd: number;
  /** 任务级预算上限（美分）。同样必填。 */
  readonly taskLimitCents: number;
  /** agent 的工作目录（§12 沙箱那一维）。必填 —— 猜一个目录等于猜它能看见哪些文件。 */
  readonly cwd: string;
  /** claude 二进制名/路径。测试注入桩 CLI 走这一格。 */
  readonly bin?: string;
  readonly maxAttempts?: number;
  readonly taskLimit?: number;
  readonly ceoRoleId?: string;
}

/** 一张卡的结果。 */
export type PumpCardOutcome =
  /** 卡建出来了。 */
  | "drafted"
  /** 试了而没成（下一轮还会试，除非到了上限）。 */
  | "attempted"
  /** 这一轮把某个任务判成【放弃】（到了上限）并留了一行。 */
  | "gave_up"
  /** 没试：任务缺失 / 状态不对 / 组织图挡着 / 已有卡。零花费，也不计尝试。 */
  | "skipped";

export type PumpRoundResult = {
  /** 本轮逐张卡的结论。空数组 = 本轮无事可做。 */
  readonly cards: readonly {
    readonly taskId: string;
    readonly outcome: PumpCardOutcome;
    readonly note: string;
  }[];
  /** 本轮起草花的钱（美分）。也是「这一轮到底有没有真在花钱」的读数。 */
  readonly costCents: number;
  /**
   * 本轮【因为到达上限而判放弃】的任务。
   * 单独给出来是因为这是唯一一件【CEO 必须知道而系统不会自己解决】的事：
   * 一个想法停在那儿、没人起草、泵也不打算再试了。
   */
  readonly abandoned: readonly string[];
  /**
   * 执行日志那一笔的结果（每条任务一格）。
   * `recorded: false` 不是失败而是一种【结论】，所以原样带出来而不是咽掉。
   */
  readonly turns: readonly { readonly taskId: string; readonly recorded: boolean; readonly why: string }[];
};

const nothingRound: PumpRoundResult = { cards: [], costCents: 0, abandoned: [], turns: [] };

/**
 * 一趟泵。心跳每轮叫一次；测试也直接叫这一发。
 *
 * 顺序与失败面：
 *  · 一趟【只现造一套 cardDeps】（一份 CLI 版本探测、一份任务图缓存）。
 *  · 逐张卡【各自不牵连】：一张起草失败不该让同轮另外两张不补
 *    —— 与心跳里「巡检与备份不互相牵连」同一条理由。
 *  · 任何一张抛了都记成 attempted 而【不整轮抛】：抛到 ticker 那一层会变成
 *    「心跳失败计数 +1」，而连番失败之后停掉的是【整条心跳】（含巡检与备份）。
 *    一张卡起草不动，不该让停滞检测从此不再运行。
 */
export async function pumpCharterCards(
  w: HubWriter,
  bus: EventBus,
  o: PumpOptions,
): Promise<PumpRoundResult> {
  const maxAttempts = o.maxAttempts ?? DEFAULT_CHARTER_MAX_ATTEMPTS;
  const perRound = o.taskLimit ?? DEFAULT_PUMP_TASK_LIMIT;
  // 这两条抛在【任何读写之前】：maxAttempts=0 会让候选 SQL 恒空，
  // 表现是"泵在跑而永远无事可做"，而那不是配置错的样子。
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("章程泵的最大尝试次数必须是 >= 1 的整数，收到 " + String(o.maxAttempts));
  }
  if (!Number.isInteger(perRound) || perRound < 1) {
    throw new Error("章程泵一轮最多补几张必须是 >= 1 的整数，收到 " + String(o.taskLimit));
  }

  type Candidate = { id: string; title: string; attempts: number };
  const candidates = w
    .readConnection()
    .prepare(CHARTER_CANDIDATES_SQL)
    .all(CHARTER_CARD_KEY, maxAttempts, perRound) as unknown as Candidate[];
  if (candidates.length === 0) return nothingRound;

  // 候选非空【之后】才现造：engineOf 默认那一支一旦真的建起 runtime，
  // 就意味着这一趟随时可能 spawn，而候选为空那一支（绝大多数轮次）根本不该走到这里。
  const eng = engineOf(o, w, bus);
  const deps = eng.deps();
  // 局部累加器写成【可变】的，返回类型才是 PumpRoundResult 里那两份 readonly：
  // 用 PumpRoundResult["cards"] 当局部类型会把 push 一起禁掉（readonly 数组），
  // 而这个函数确实要一条条往上加。
  const cards: {
    readonly taskId: string;
    readonly outcome: PumpCardOutcome;
    readonly note: string;
  }[] = [];
  const abandoned: string[] = [];
  const turns: { readonly taskId: string; readonly recorded: boolean; readonly why: string }[] = [];
  let costCents = 0;

  for (const c of candidates) {
    let outcome: PumpCardOutcome = "attempted";
    let note = "";
    let turn: { role: string; sessionId: string | null; costCents: number; ok: boolean } | null = null;
    try {
      const r = await ensureCharterCard(
        w,
        { taskId: c.id, nowMs: o.nowMs, maxBudgetUsd: o.maxBudgetUsd },
        { ...deps, publish: (e: DomainEvent, seq: number) => bus.publishPersisted(e, seq) },
      );
      costCents += r.costCents;
      outcome =
        r.outcome === "drafted"
          ? "drafted"
          : r.outcome === "no_draft"
            ? "attempted"
            : "skipped";
      note = r.note;
      // 只有【确定真的跑了一轮】的两种结果才要记执行日志。
      // ⚠ already_pending 【不算】—— 它有两支而返回值分不开：
      //   · 前置那道检查发现已有卡 ⇒ 一次子进程都没起；
      //   · 并发里别人抢先建了卡 ⇒ 真起了、真花了钱。
      // 记了的代价是【在执行日志里造出一笔没发生过的调用】，不记的代价是
      // 【少一行】—— 而后者那笔钱仍然在 budget_events 与 events 里（charter.ts 那两支
      // 都调了 bill），所以少的只是执行日志那一维。方向选【不造假】。
      // 逐值列出而不是 default：将来 CharterResult 多一个 outcome 时，
      // default 会静默把它归到"没跑一轮"，而那种归类错了不会有人发现。
      if (r.outcome === "drafted" || r.outcome === "no_draft") {
        turn = {
          role: roleOf(w, c.id),
          // ⚠ sessionId 【恒为 null】，这是 CharterResult 的形状决定的：它不带 sessionId
          // （CharterDraftOutcome 有，但 ensureCharterCard 不往返回值里传）。
          // 本处【不为此改那个返回值形状】—— 它已接两条调用方，而这一格的信息量是
          // 「起草那一轮用的是哪个会话」，起草是一次性的（resumeSessionId 传 null），
          // 所以 null 说的是真话，只是不够细。登记在未接项里。
          sessionId: null,
          costCents: r.costCents,
          ok: r.outcome !== "no_draft",
        };
      }
    } catch (e) {
      // 见函数头：整轮不抛。原文进这一发的 note，由 io 那一层说出来。
      outcome = "attempted";
      note = "起草那一发直接抛了：" + (e instanceof Error ? e.message : String(e));
    }
    cards.push({ taskId: c.id, outcome, note });
    if (turn !== null) {
      const res = await recordTurnSafe(eng.recordTurn(), {
        taskId: c.id,
        role: turn.role,
        sessionId: turn.sessionId,
        costCents: turn.costCents,
        ok: turn.ok,
        nowMs: o.nowMs,
      });
      turns.push({ taskId: c.id, recorded: res.recorded, why: res.why });
    }
  }

  // ── 判放弃：本轮【没补出卡】而它已经到了上限 ──────────────────────────
  // 为什么是【本轮之后】再数一遍：候选 SQL 里的 attempts 是【本轮之前】的数字，
  // 本轮这一发可能刚好用完最后一次；下一轮它就不再是候选（SQL 滤掉），
  // 所以这是它【最后一次能被看见】—— 不在这里留一行，它就从"每轮都在报的故障"
  // 变成"谁都不知道的沉默"，而这两种状态之间没有任何东西会响（0016 §1 那一族）。
  for (const c of candidates) {
    // 判据与候选 SQL 里那道 NOT EXISTS 【同一个形状】（任何状态，不看 pending）：
    // 只要这张卡存在，这一格就【已经有东西在回答了】，"不再试了"这件事就不成立。
    const hasCard = w
      .readConnection()
      .prepare("SELECT 1 AS x FROM approvals WHERE task_id = ? AND card_key = ? LIMIT 1")
      .get(c.id, CHARTER_CARD_KEY) as { x: number } | undefined;
    if (hasCard !== undefined) continue;
    const after = Number(
      (w.readConnection().prepare(CHARTER_ATTEMPTS_SQL).get(c.id) as { n: number } | undefined)?.n ?? 0,
    );
    if (after < maxAttempts) continue;
    await writeGaveUp(w, c.id, after, maxAttempts, o.nowMs);
    abandoned.push(c.id);
    cards.push({
      taskId: c.id,
      outcome: "gave_up",
      note: "试到第 " + after + " 次仍没有可批的章程卡，泵不再试（详见那条 " + CHARTER_GAVE_UP_KIND + " 审计）。",
    });
  }

  return { cards, costCents, abandoned, turns };
}

/**
 * 「不再试了」那一行。
 *
 * 纯审计行，形状照 charter/store.ts:272 与 org/commit.ts:323 那两处：
 * 不广播、不新增 DomainEvent kind、action 复用 'state_change'
 * （AUDIT_ACTIONS 是 §22.1 那十值枚举，加第 11 个值属改规格，同那两处的判定），
 * 区分只靠 payload.kind。
 *
 * ⚠ 'state_change' 这个 action 值与真跃迁【共用】，这一点是有意的取舍而不是疏漏：
 * 按 action 统计"状态变更"的读法会多数到这一行。挡住它的不是这里的措辞而是
 * payload.kind —— 所以凡按 action='state_change' 数跃迁的读法都该看
 * overview/today.ts 那一类【按 payload.kind 二次判别】的写法，
 * 与 ApprovalTokenRedeemed / RoleTurnReported 共用既有 action 值是同一族。
 * 顺带一条依赖：MEMORY_ROWS_SQL 只捞 ('approval','review_decision')，
 * 所以这一行【不会】进任何角色的 few-shot（它是运维事实，不是决定）。
 */
async function writeGaveUp(
  w: HubWriter,
  taskId: string,
  attempts: number,
  maxAttempts: number,
  nowMs: number,
): Promise<void> {
  await w.node(() => {
    const db = requireScopeDb("serve.charter-pump.gave-up");
    appendAudit(
      db,
      {
        taskId,
        actorType: PUMP_ACTOR.actorType,
        actorId: PUMP_ACTOR.actorId,
        action: "state_change",
        target: PUMP_GAVE_UP_TARGET,
        payload: {
          kind: CHARTER_GAVE_UP_KIND,
          task_id: taskId,
          attempts,
          max_attempts: maxAttempts,
          note:
            "章程起草在这条任务上试到上限（" +
            attempts +
            " / " +
            maxAttempts +
            "）仍然没有一张可批的卡，泵不再试。" +
            "它仍停在 CHARTER_PENDING，收件箱里没有它 —— 要往下走得人工看这一格。",
        },
        createdAt: nowMs,
      },
      () => nowMs,
    );
    return null;
  });
}

/**
 * 起草角色的名字，从 tasks.assigned_role 取（与 charter.ts 那一处同一个来源）。
 *
 * ⚠ 空值【回退到 CHARTER_DRAFT_ROLE】而不是回退到空串 —— 这一格容易被写成 `?? ""`
 * 而它是个【记录造假】的形状：charter.ts:270 那一支在 assigned_role 为空时
 * 用的是 CHARTER_DRAFT_ROLE，也就是说【真跑的那一轮是 intake 跑的】，
 * 而 harness_calls.role 记成空串就是「执行日志说这一轮没有角色」。
 * 一个空 role 不会报错，只会在事后按角色统计花费时归进一个不存在的桶。
 *
 * 之所以在这里读而不是让 ensureCharterCard 把它带回来：harness_calls.role 是必填列，
 * 而 CharterResult 的形状里没有角色 —— 那个返回值已接两条调用方，
 * 为「记录更细」去改它，代价落在两条不需要它的路径上。
 */
function roleOf(w: HubWriter, taskId: string): string {
  const r = w
    .readConnection()
    .prepare("SELECT assigned_role FROM tasks WHERE id = ?")
    .get(taskId) as { assigned_role: string | null } | undefined;
  return r?.assigned_role === null || r?.assigned_role === undefined || r.assigned_role === ""
    ? CHARTER_DRAFT_ROLE
    : r.assigned_role;
}

/**
 * recordTurn 包一层不抛。
 *
 * 它自己已经返回 {recorded, why}，但那只是【它预期内的失败】；
 * 真抛出来的那一支（库锁、约束）不该把整轮泵带走 —— 执行日志少一行，
 * 与「这一轮起草本身失败」是两件事，前者的代价是【事后看不清】，
 * 后者是【这件事没成】。为前者停掉后者的重试是错的取舍。
 */
async function recordTurnSafe(
  fn: EngineRuntime["recordTurn"],
  i: { taskId: string; role: string; sessionId: string | null; costCents: number; ok: boolean; nowMs: number },
): Promise<{ recorded: boolean; why: string }> {
  try {
    return await fn(i);
  } catch (e) {
    return { recorded: false, why: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 起草那一轮用的回调 + 执行日志的写入方，两者【出自同一套 runtime】。
 *
 * 注入点是一个工厂而不是 runTurn / rolePrompt / onCost 三格分开可选，
 * 是因为三格里【只注入一部分】会造出半真的装配：
 * 比如注入了 runTurn 而 rolePrompt 走真 runtime —— 那会为了拿一句岗位书
 * 而把真 runtime 建起来，而它建起来就意味着下一次调用可能 spawn。
 *
 * 出自同一套 runtime 还有一条实质理由：recordTurn 与 runTurn 在 runtime.ts 的
 * 文件头是被【故意分开】的（会话与账单记录的是「这一次执行发生了」，
 * 与「这条状态边合不合法」是两件事）。分开注入等于允许
 * 「起草走 A 套、执行日志记 B 套」，而那正是它分开的原因被抹掉的方式。
 */
function engineOf(
  o: PumpOptions,
  w: HubWriter,
  bus: EventBus,
): { readonly deps: () => CharterCardDeps; readonly recordTurn: () => EngineRuntime["recordTurn"] } {
  if (o.cardDeps !== undefined) {
    const d = o.cardDeps;
    return {
      deps: () => d(),
      // 注入了假起草而没注入执行日志 ⇒ 【没有执行日志可写】。
      // 这一支【不】回退去建真 runtime：那等于"为了让测试不花钱而注入了一份假的，
      // 结果测试还是把真 runtime 建起来了"，注入点就白给了一半。
      recordTurn: () => o.recordTurn ?? noRecorder,
    };
  }
  let rt: EngineRuntime | null = null;
  const runtime = (): EngineRuntime => {
    if (rt === null) {
      rt = makeRuntime({
        writer: w,
        bus,
        maxBudgetUsd: o.maxBudgetUsd,
        taskLimitCents: o.taskLimitCents,
        cwd: o.cwd,
        ...(o.bin === undefined ? {} : { bin: o.bin }),
        ...(o.ceoRoleId === undefined ? {} : { ceoRoleId: o.ceoRoleId }),
        nowMs: () => o.nowMs,
      });
    }
    return rt;
  };
  return {
    deps: () => {
      const d = runtime().deps;
      return {
        runTurn: d.runTurn,
        rolePrompt: d.rolePrompt,
        ...(d.onCost === undefined ? {} : { onCost: d.onCost }),
        ...(o.ceoRoleId === undefined ? {} : { ceoRoleId: o.ceoRoleId }),
      };
    },
    recordTurn: () => runtime().recordTurn,
  };
}

/**
 * 「没有执行日志可写」那一支。
 *
 * 写成【函数】而不是一个常量对象：EngineRuntime["recordTurn"] 的返回类型是
 * Promise<{recorded, why}>（runtime.ts:152 把它声明成 async 是有原因的 ——
 * 真那一支要开一次写），常量对象喂不进那个形状。
 * 顺手也是一个更对的形状：调用方 await 它，两种来源在调用点上是同一件事。
 */
const noRecorder: EngineRuntime["recordTurn"] = async () => ({
  recorded: false,
  why: "这套装配没有提供执行日志的写入方（注入了假起草而没注入 recordTurn）",
});

