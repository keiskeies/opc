/**
 * 进程内事件总线（规格 §5.8，Task 0.6）。
 *
 * 为什么不引入 Redis / 消息中间件：所有消费者的终点都是同一个 Hub 进程内的同一个
 * 广播器（§5.8）。这里只解决三件事：seq 单调、慢消费者不拖累生产者、断线后按游标续订。
 *
 * seq 的唯一真相是 events.id（计划接口注释「seq 由 events.id 派生」）。总线自己发号
 * 会和 REST 快照里的游标不可比，断线重连必然漏事件或重放 —— 所以发号只有一条路径：
 * 写库之后把 events.id 交回 publishPersisted()。
 */

export type DomainEvent =
  | { kind: "TaskStateChanged"; taskId: string; from: string; to: string }
  | {
      kind: "ReviewDecided";
      taskId: string;
      gate: string;
      decision: "pass" | "reject";
    }
  | {
      kind: "ApprovalRequired";
      taskId: string;
      interruptId: string;
      payload: unknown;
    }
  /**
   * CEO 按了一次按钮 ⇒ 那张卡片不再是待批。
   *
   * 【这一 kind 是实现时加的，规格 §5.8 那张六行表里没有】，偏离与代价记在
   * docs/decisions/0010（含「为什么不复用 ApprovalRequired」「为什么不靠后续的
   * TaskStateChanged 把界面带回来」两条实测）。这里只写形状层面必须写的：
   *  - decision 的三值与 http/real-deps.ts 的 STATUS_BY_RESUME 值域【同一个词表】。
   *    两套词表（approved / approve / 已批准）迟早要靠一张映射表对齐，而那张表
   *    就是「卡片已批但仍被算进待批数」这类错长出来的地方。
   *  - 只带【事实】，不带【计数】。收件箱那个数字由消费者自己累计
   *    （ApprovalRequired 加一、ApprovalDecided 减一）。把计数塞进事件，
   *    等于让 Hub 替每个消费者各维护一份状态，多一处可以与库不一致的地方。
   *    ⚠ 但【对账的那条 REST 源还不存在】：要核对「事件算出来的数」与「库里
   *    实际有几张 pending」，需要 GET /approvals，而它没做（理由与代价记在 0010 §5）。
   *    所以今天这个计数【无从校验】，只能靠两条事件不丢不重 —— 这是已知缺口，
   *    不是已验证性质。
   *    ── 上面那两句已经【不再成立】，原文按口径留着（0026 §4）──────────
   *    GET /approvals 做了，它对账用的那一格是 pendingTotal（approvals/query.ts：
   *    无条件 COUNT，不受 status / limit 影响）。所以计数从「无从校验」变成「可对账」。
   *    ⚠ 变的是哪一半要说清，别读成「计数现在可信了」：
   *    【有了对账源】与【有人去对】是两件事。消费者（web/hub/projection.ts 的收件箱角标）
   *    读的是 pendingTotal + 水位线之上的增量，而【事件流出洞时它报 unknown
   *    而不是继续显示一个数】—— 「靠不丢不重维持正确」在实现层被换成了
   *    「知道丢了就说不知道」。仍然没验的是【端到端】：真起 Hub、真断一次线、
   *    真比两个数 —— 那要 UI 那一半（Phase 2 的桌面端），今天不存在。
   */
  | {
      kind: "ApprovalDecided";
      taskId: string;
      interruptId: string;
      decision: "approved" | "rejected" | "deferred";
    }
  | { kind: "BudgetPaused"; taskId: string; spentUsdCents: number }
  | { kind: "MeetingSummaryReady"; taskId: string | null; meetingId: string }
  | { kind: "HeartbeatStalled"; taskId: string; node: string }
  /**
   * 一张一次性审批 token 被烧掉（Task 4.1，http/tokens.ts）。
   *
   * 【这一 kind 是被 seq 空洞逼出来的，不是「想让界面看到」】。顺序是这样的：
   * redeemToken 要留痕（im_tokens 只有 used=0/1，没有时间列），所以它写一行 events；
   * 而 events.id 就是 seq（本文件头）。写了那一行而不 publishPersisted，
   * 就等于【消费了一个 seq 而没送出去】—— 那正是 0010 §4 量过的失效形状：
   * 活着的 SSE 订阅撞见一个空洞，投影层把 link 标成 stale 去重拉快照，
   * 于是【每一次远程批准都把连接标脏一次】。所以「留痕」与「广播」是同一件事的两半，
   * 少一半比两半都没有更糟（两半都没有时 seq 至少是连续的）。
   *
   * 为什么不复用 ApprovalDecided：那条的 decision 三值是【有人做了决定】，
   * 而烧票发生在决定之前、且可能永远等不到那个决定（票烧了、图没跑、或者随后 decide() 失败）。
   * 复用会让「有一次远程批准」与「有一次远程批准落了库」在事件里分不开，
   * 而后者正是排查时要问的那一句。
   *
   * ⚠ 它在 events 里的 action 仍是 'approval'（§22.1 那个十值枚举是 append-only 的，
   *   不能为了实现方便加第 11 个值，同 recorder.test.ts 记的那条），
   *   所以【role-memory 必须按 payload.kind 显式跳过它】—— 那条过滤的理由是
   *   「记忆要的是决定，不是一句没结论的『有人问过』」，而烧票比 ApprovalRequired
   *   更不是决定。少那一行过滤的后果不是崩，是【角色的 few-shot 里多一条伪决定】，
   *   静默且长期。见 memory/role-memory.ts 里那段过滤。
   */
  | { kind: "ApprovalTokenRedeemed"; taskId: string; interruptId: string }
  /**
   * 第 9 个 kind（engine/ 的调度器）。它【不是「想让界面看到什么」】，而是被
   * 与 ApprovalTokenRedeemed 【一字不差的同一条 seq 论证】逼出来的：
   *
   * 引擎路线上一轮 agent 执行可能【不产生状态跃迁】—— wait、缺决策段、越权交接被拦、
   * 执行失败。这四支都得留痕（否则「任务为什么停着」在回放里查不到），
   * 而留痕就是写一行 events，而 events.id 就是 seq。
   * 写了不 publish ⇒ 每跑一轮不出边的活，活着的 SSE 订阅就撞一个空洞、
   * 把 link 标成 stale 去重拉快照一次（0010 §4 量的正是这个形状）。
   * 「任务停着不动」的时候界面反而【每分钟自己刷一次全量】，比少一条更新难看得多。
   *
   * 为什么不复用 TaskStateChanged：那条的语义是【状态动了】（from/to 两个必填值），
   * 而这一条成立的唯一条件正是【状态没动】。复用会让 web/projection.ts 的
   * TaskStateChanged 分支收到一条 from === to 的边并把 status 原地写一遍 ——
   * 那是让「没发生」在投影里长得像「发生了一次」。
   *
   * ⚠ action 取 'tool_call'，【不开第 11 个 action 值】（§22.1 的枚举 append-only，
   * 与 ApprovalTokenRedeemed 共用 'approval' 同一条立场）。选 'tool_call' 是因为它是
   * 十个值里唯一语义为「某个 agent 干了一件事而没做决定」的。
   * 顺带一条依赖要说清：memory/role-memory.ts 的 MEMORY_ROWS_SQL 只捞
   * action IN ('approval','review_decision')，所以这一行【不会】进任何角色的 few-shot
   * —— 这是想要的（记忆要的是决定，一句没结论的「我跑了一轮」不是决定）。
   * 那条 SQL 将来若放宽，这一条就得跟着加显式过滤。
   */
  | {
      kind: "RoleTurnReported";
      taskId: string;
      /** 开口的那个角色（= events.actor_id，两处同值而不是各写一份）。 */
      role: string;
      /** 这一轮结束时任务【仍旧】停在这个状态 —— 字段名是 to 是为了与 TaskStateChanged
       *  同一套读法，但它的含义是「没动到哪去」，不是「去了哪」。 */
      state: string;
      /** 为什么没动（人话，进回放）。 */
      note: string;
      /** 这一轮花掉的美分。带它是因为失败轮/等待轮的钱也要能被预算护栏看到，
       *  而 events.id 正是 BudgetTracker 的幂等键（同一条 seq 两用）。 */
      costCents: number;
    }
  /**
   * 第 10–18 个 kind（实施计划 §5：群角色上层的事件族 —— 群/成员/会话/会议/面板/文档/执行器）。
   *
   * 这九个 kind 存在的理由是【同一条】，在这里说清一次，后面八条只回指：
   * 群/成员/会话/会议/文档/执行器这些上层服务靠 appendAudit 写一行 events 留痕，
   * 而 events.id 就是 seq（本文件头）。写了那一行而不 publishPersisted，
   * 就是一个 seq 空洞 —— 活着的 SSE 订阅撞见空洞，投影层把 link 标成 stale
   * 去重拉快照（ApprovalTokenRedeemed 与 RoleTurnReported 记过、0010 §4 量过的
   * 那个失效形状，一字不差地适用）。所以对下面每一个 kind：
   * 【要么广播它，要么别写它】。
   *
   * 每个 kind 映射到哪个 action、载荷带哪些字段、target 落哪个字段，以
   * docs/design-2026-11-23-群角色上层-实施计划.md §5 那张 kind→action 表为
   * 【规范源】（载荷只带粗粒度 id 是 A2/A3 的硬约束），recorder.ts 的
   * KIND_TO_ACTION 与 targetOf 逐行照抄它。
   *
   * ⚠ 这一族【一律不带 taskId 键】—— 连建群、跑执行器这种十有八九挂在某个任务上的
   * 动作也不带。理由分三层：
   *  ① 这一族【没有】共同的任务归属：私聊消息、没有 task 的会议、独立文档、面板项、
   *     群档案操作都不是 task，「顺手带上它」在语义上对半数是伪造的。
   *  ② 缺键这条通道是现成的：recorder.ts 的 taskIdOf() 用 "taskId" in e 判定，
   *     缺省即在可空的 events.task_id 列（0001 迁移）落 SQL NULL —— 库里
   *     「不属于任何任务」的表示本来就是 NULL，而不是某个字符串。
   *  ③ 连带效应：SSE 帧的 taskId 随之可能缺席，contracts 的 feedItemSchema 因此
   *     把 taskId 从必填改成 .optional()。「没有任务」一律落成【键不存在】，绝不允许
   *     塞 "none"/"-" 这类占位串去凑必填：占位串在 web 投影看来就是一个【真实存在的
   *     task id】，它会拿这个并不存在的 task 当真实对象去拉详情、等跃迁 ——
   *     这是 0010 §4 那族「用假值换类型便利」的错形：错误被一个能过类型检查的值
   *     掩护，比缺键当场暴露坏得多。真属于某个任务的场合，生产者走 record() 的
   *     extra.taskId 显式带 —— 带不带的答案住在生产者那一侧，不在事件形状里
   *     预先替所有人拍板。
   */
  /** 群档案变了一个面。op 四值 = 建群 / 档案更新 / 解散 / 换特助（D6 每群必有特助，
   *  换特助改的是群档案而不是任何成员）。群操作不保证属于某个任务（族级注释第 ① 条），
   *  所以不带 taskId 键；「对哪个群」由 target = groupId 回答。 */
  | {
      kind: "GroupUpdated";
      groupId: string;
      op: "created" | "updated" | "dissolved" | "cos_changed";
    }
  /** 招聘一名成员（库里对应 member_hired 审计）。roleId 是档案角色 id；
   *  groupId 冗余带上：招聘页要按群刷新名单，不带就得反查 members 表 —— 事件要能自解释。
   *  招聘允许不落座任何群（seat_group_ids=[]），此时 groupId 是 null；空串是假群 id，禁止占位。 */
  | {
      kind: "MemberHired";
      memberId: string;
      groupId: string | null;
      roleId: string;
    }
  /** 成员档案的某个面变了。op 按【变的是哪个面】分而不是全挤进一个 "updated"：
   *  技能、执行器、档案资料、在离岗状态各是库里的独立审计问题
   *  （member_skills_set / member_executors_set 都是既有审计的专值），并进一个值
   *  就答不出「那次改动到底改了什么」。member_hired 不在这里 —— 它有专 kind，
   *  一条事件两个语义等于回放时再拆一次 if。 */
  | {
      kind: "MemberUpdated";
      memberId: string;
      op: "skills" | "executors" | "profile" | "status";
    }
  /**
   * 会话里来了一条消息。action 落 'meeting' 而不是新开值（§5 表；十值枚举
   * append-only，与 ApprovalTokenRedeemed 等共用既有值是同一条立场）：
   * 会话逐字稿与会议逐字稿是同一族「谁说了什么」，具体哪一种靠载荷的判别位分辨。
   *
   * ⚠ msgKind 是【D16 升级链的入口判别】：mention_boss = 老板被 @ 了、这件事
   * 需要拍板，会话层据此把消息路由进 CoS 升级链；message = 普通发言，正常投递。
   * 它必须是两值判别位而不是 mentions 数组里「碰巧有个 @boss」—— 升级链的触发
   * 条件不能藏在一个要遍历才知道的形状里。键名不叫 kind：那个槽位被联合判别式
   * 占用（一条成员里两个 kind 键是编译错），§5 表里的 payload.kind 在这一族
   * 落在 msgKind 键上 —— 改名只发生在键名，判别语义一字未动。
   *
   * ⚠ role-memory 侧【天然不收这一族】：MEMORY_ROWS_SQL 只捞
   * action IN ('approval','review_decision')，'meeting' 一条都不进 —— 与
   * RoleTurnReported 注释里那条是同一条立场（记忆要的是决定，一句发言不是决定）。
   * 那条 SQL 将来若放宽，这里与 RoleTurnReported 两处都要回头加显式过滤。
   *
   * groupId 可空是【事实】而不是兜底：私聊与老板直聊没有群，落 null 与 events 侧
   * 可空列保持同一口径（族级注释第 ③ 条：不许用占位串凑一个假的群标识）。
   * 只带事实不带计数：未读数由消费者自己累计，与审批卡片同一立场。
   */
  | {
      kind: "MessageReceived";
      messageId: string;
      conversationId: string;
      groupId: string | null;
      msgKind: "message" | "mention_boss";
    }
  /** 会议里发了一轮发言。与 MeetingConcluded、MeetingSummaryReady 都落 meetingId
   *  （target 可 join，见 recorder.ts targetOf 里那段配对注释）。turnSeq 是会议内
   *  轮次，与全局 seq 无关 —— 它是「这个会议的第几行逐字稿」：广播顺序是全局的，
   *  回放排序要用会议内的行号，两个序不能混用一个数。 */
  | { kind: "MeetingTurnPosted"; meetingId: string; turnSeq: number }
  /** 会议散会。与 MeetingTurnPosted 一对：一个记「有人说了」，一个记「说完了」。
   *  散会 ≠ 纪要好了 —— 两者之间存在真实时间差，MeetingSummaryReady 不兼职收尾，
   *  否则「开了会而没有纪要」这种常态就无法表达。summaryDocId 因此可空：
   *  散会那一刻纪要文档多半还不在，null 是事实而不是缺数据。 */
  | { kind: "MeetingConcluded"; meetingId: string; summaryDocId: string | null }
  /** 待办面板的一行变了。op 七值是面板上的人称动词（含调优先级 priority）——
   *  「CEO 刚点了什么」比 BACKLOG_STATES 的状态跃迁更贴近这一行的审计问题；
   *  谁消费谁映射回状态机，投影层不替 T9 预先拍板。 */
  | {
      kind: "BacklogChanged";
      backlogItemId: string;
      op:
        | "create"
        | "cancel"
        | "move"
        | "defer"
        | "priority"
        | "split"
        | "merge";
    }
  /** 文档变了。created/saved/restored/permission_changed/deleted 五值各答一个审计问题；
   *  删除是软删，正文与版本仍保留；还原与权限尤其要单独问责。 */
  | {
      kind: "DocumentChanged";
      docId: string;
      op: "created" | "saved" | "restored" | "permission_changed" | "deleted";
    }
  /** 文档被打开或导出。读取同样要留痕，但不能伪装成文档内容发生变化。 */
  | { kind: "DocumentAccessed"; docId: string; op: "opened" | "exported" }
  /**
   * 一次执行器尝试跑完了（七执行器统一回执，§5）。executorKind 用 contracts 的
   * EXECUTOR_KINDS 词表（两套词表迟早要靠映射表对齐 —— ApprovalDecided.decision
   * 记过的先例）；memberHint 只是给「成员头像旁提示一下」用的提示位，可以为 null
   * （真人执行器、不挂成员的杂活），要问责归属去查审计层，别把它当权威。
   *
   * ⚠ 同一次执行在 events 表里会有【两行】，action 不同、各答各的问题，这不是重复写：
   *  · executors/types.ts auditExecutorRun 写的那行 action='tool_call'
   *    （target "executor:<execution_id>:<seq>"）—— append-only 审计，回答
   *    「系统派发过哪一次尝试、结论如何」；它直接走 appendAudit、不经 KIND_TO_ACTION，
   *    这次不动它；
   *  · 这一行 harness_call 广播（target = executionId）—— 回答前端那句
   *    「跑完了没有、成没成、哪个成员、哪种执行器」。
   *  审计行是问责口径、可以不广播（它不是 recorder 这条路写的事件）；广播行是
   *  投影口径、不做问责依据。若将来有人想把两行并成一行，先回头改 §5 那张表再动
   *  auditExecutorRun，别让「按 target 查这次执行的账」查出两种答案还以为正常。
   */
  | {
      kind: "ExecutorRunFinished";
      executionId: string;
      memberHint: string | null;
      ok: boolean;
      executorKind: string;
    }
  /**
   * 第 19 个 kind（会议取消）。【这一 kind 是 DDL 逼出来的，不是「想让界面看到」】。
   *
   * 0017 的 status 是三值（open / concluded / cancelled），而实施计划 §5 那张表
   * 只给了会议两条：发言（MeetingTurnPosted）与散会（MeetingConcluded）。
   * 「取消」在库里是合法状态，事件族里却没有对应 kind —— 于是会议服务只剩两条路，
   * 两条都不能走：
   *  ① 复用 MeetingConcluded：那条的语义是【开完了】，而 0017 的列级 CHECK 规定
   *    concluded 必须三件套全非空。一场开错头的会（拉错人、议题与在跑的会重复、
   *    老板改主意）没有决定可填 —— 套这条 kind 就等于【为一场没开的会编造决定、
   *    负责人和截止时间】。这是「用假值换类型便利」的 0010 §4 那族错形，
   *    而且假的是最该问责的三个字段。
   *  ② 不广播只写库：cancelled 那行审计写了而不 publishPersisted，就是本文件头
   *    与族级注释量的同一条 seq 空洞 —— 活着的 SSE 订阅撞见空洞，把 link 标 stale
   *    去重拉快照。后果是【每取消一次会议就把前端刷一次全量】，而取消恰恰发生在
   *    「有人正盯着这场会」的时候。要么广播它，要么别写它，而留痕（为什么取消）
   *    本身是审计要的，所以只能广播。
   *
   * reason 带人话短句（RoleTurnReported.note 同款先例）：会议卡片是会话流里的一行，
   * 「这场会没了」而不说为什么，老板的下一句必然是「为什么没了」——
   * 那一次往返本可以在帧里省掉。长度在服务层按契约上限收口，不靠这里自觉。
   */
  | { kind: "MeetingCancelled"; meetingId: string; reason: string }
  /**
   * 第 20 个 kind（开会，不是发言也不是散会）。与 MeetingCancelled 同一道补票：
   * §5 表只给了会议「发言/散会」，而【谁在什么时候为哪个群开了这场会】是审计要答的
   * 问题（meetings 行只有 0001 那列 created_at，没有任何「谁开的」的列 —— 0017 扩的
   * 九列里也没有；审计行是【唯一】能记下
   * 「老板开的」与「节奏生成器自动开的」那个区别的地方）。写了那一行就得广播它，
   * 同族级注释第一条；不复用 MeetingTurnPosted（turnSeq 是第几行逐字稿，
   * 开会时一行都没有，用 0 占就是让【没发生】在投影里长成【发生了一次】）。
   */
  | { kind: "MeetingOpened"; meetingId: string; groupId: string }
  /** 节奏事件已发生：站会/计划会/评审/回顾各回答「团队这一刻 synchronize 了什么」。 */
  | {
      kind: "RhythmEventRecorded";
      eventId: string;
      groupId: string | null;
      rhythmKind: "sprint_planning" | "standup" | "review" | "retro";
    }
  /** 每日调研卡落库；day 用本地日界文本，与 research_cards 的唯一键同源。 */
  | { kind: "ResearchCardCreated"; cardId: string; day: string }
  /** 派发已把来源消息变成执行任务；target 是 task id。私聊没有群，groupId 落 null。 */
  | {
      kind: "DispatchAssigned";
      taskId: string;
      memberId: string;
      groupId: string | null;
    };

export type EventKind = DomainEvent["kind"];

/** 带游标的事件：seq 就是 events.id。 */
export type SeqEvent = DomainEvent & { readonly seq: number };

/**
 * 推给消费者的条目。degraded 只在【该订阅者确实丢过事件】时出现，值恒为 true；
 * 没丢过就根本不带这个键（exactOptionalPropertyTypes），避免每个消费者都写
 * `if (x.degraded === true)` 的噪音。收到 degraded 的正确反应是「去 REST 拉快照」，
 * 不是重试 —— §5.8：事件只做增量，全量状态由 REST 补齐。
 */
export type FeedItem = SeqEvent & { readonly degraded?: true };

/**
 * 一个订阅。比计划的 AsyncIterable 多一个 close()：§5.8 要求「SSE 写失败即视为
 * 消费者断开，回收其队列」。AsyncIterable 本身没有取消语义，指望 GC 更不成立 ——
 * 总线持有订阅引用，不显式 close 就永远回收不掉。
 */
export interface EventSubscription extends AsyncIterable<FeedItem> {
  /** 订阅时的起点游标；undefined 表示「只收未来」。 */
  readonly startSeq: number | undefined;

  /**
   * 本订阅者【本应收到却没收到】的事件数（累积）。
   *
   * 「本应收到」以下限 = startSeq 之后的第一个 seq 界定（无游标则从订阅那一刻起）。
   * 例：容量 2、已发 1..10、以 fromSeq=1 续订 → 环形只剩 9、10，本应收 2..10，
   * 实收 9、10 ⇒ dropped() = 7。定义写死在这里，测试里的数字才有出处。
   *
   * close() 之后不再累加（已退订的事件不算丢）。
   */
  dropped(): number;
  close(): void;
}

export interface EventBus {
  /** 写库之后调用；seq = 该事件在 events 表里的 id。非阻塞，入队即返回。 */
  publishPersisted(e: DomainEvent, seq: number): void;
  subscribe(fromSeq?: number): EventSubscription;
  /** 活跃订阅数（SSE 连接观测点，也是队列回收的证据）。 */
  subscribers?(): number;
  latestSeq(): number;
}

/** 默认环形容量：够覆盖一次前端断网重连，又不至于无界增长。 */
export const DEFAULT_RING_CAPACITY = 512;

type Resolve = (r: IteratorResult<FeedItem>) => void;

class Subscription implements EventSubscription {
  readonly startSeq: number | undefined;
  readonly #cap: number;
  readonly #bus: InMemoryEventBus;
  #queue: FeedItem[] = [];
  #waiters: Resolve[] = [];
  #dropped = 0;
  #closed = false;
  #iter?: AsyncIterator<FeedItem>;

  constructor(bus: InMemoryEventBus, cap: number, fromSeq: number | undefined) {
    this.#bus = bus;
    this.#cap = cap;
    this.startSeq = fromSeq;
  }

  dropped(): number {
    return this.#dropped;
  }

  /**
   * 降级标记打在【队列里现存最早那条】上，不是「下一条」。
   *
   * 差别在断线重连时暴露：慢消费者攒了一堆事件才回来读，若标记跟在丢失时刻的
   * 「下一条」上，它可能已经被挤出队列 —— 于是消费者收到 5、6、7 却【永远不会】
   * 收到 degraded，前端以为画面是全的，继续显示残缺状态。这正是要防的静默失效。
   */
  #flagOldest(): void {
    const idx = this.#queue.findIndex((x) => x.degraded === undefined);
    if (idx < 0) return;
    const hit = this.#queue[idx];
    if (hit === undefined) return;
    this.#queue[idx] = { ...hit, degraded: true } as FeedItem;
  }

  /** 投递一条事件（续订回填与实时广播共用）。 */
  deliver(e: SeqEvent): void {
    if (this.#closed) return;
    const item: FeedItem = { ...e };
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }
    this.#queue.push(item);
    if (this.#queue.length > this.#cap) {
      this.#queue.shift(); // 丢最旧（§5.8）
      this.#dropped += 1;
    }
    if (this.#dropped > 0) this.#flagOldest();
  }

  /** 续订时算出的「环形之外」的缺口，同样要显式记账并标记降级。 */
  noteGap(missing: number): void {
    if (missing <= 0) return;
    this.#dropped += missing;
    this.#flagOldest();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bus.forget(this);
    this.#queue.length = 0;
    // 挂着的 next() 必须放行，否则消费者的 for-await 永远卡在这里
    for (const w of this.#waiters.splice(0))
      w({ value: undefined as never, done: true });
  }

  /**
   * 返回【同一个】迭代器实例。规范要求订阅是 AsyncIterable，而 AsyncIterable 的
   * 惯例是「每次取迭代器都是新的独立流」；这里刻意不遵守：订阅的语义是【一条流】，
   * 两个迭代器抢同一个队列只会让事件被随机瓜分。测试里的 next() 辅助函数也会
   * 因此反复取迭代器而不丢事件。
   */
  [Symbol.asyncIterator](): AsyncIterator<FeedItem> {
    this.#iter ??= {
      next: (): Promise<IteratorResult<FeedItem>> => {
        const head = this.#queue.shift();
        if (head !== undefined)
          return Promise.resolve({ value: head, done: false });
        if (this.#closed)
          return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<FeedItem>>((resolve) => {
          this.#waiters.push(resolve);
        });
      },
      return: (): Promise<IteratorResult<FeedItem>> => {
        this.close();
        return Promise.resolve({ value: undefined as never, done: true });
      },
    };
    return this.#iter;
  }
}

export class InMemoryEventBus implements EventBus {
  readonly #cap: number;
  readonly #subs = new Set<Subscription>();
  readonly #ring: SeqEvent[] = [];
  #seq = 0;

  constructor(capacity: number = DEFAULT_RING_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        "EventBus 环形容量必须是正整数，收到 " + String(capacity),
      );
    }
    this.#cap = capacity;
  }

  /**
   * 只接受【写库之后】的事件，seq 必须是 events.id。
   *
   * 为什么禁止总线自己发号：前端的恢复路径是「REST 拉快照 + 从游标续订」（§5.8），
   * 游标必须是数据库那一侧的 id。总线另起一套序号，两个游标体系不可比，断线重连
   * 必然漏事件或重放，而且表现是「偶尔少一条」，最难查。
   *
   * 为什么严格递增就够、不需要 gap 检测：写入走 WriteQueue 单写者，events.id 由
   * AUTOINCREMENT 在同一个写事务里产生，序号不会跳号；跳号意味着上面这条前提被
   * 破坏了，所以宁可当场炸也不要静默继续。
   */
  publishPersisted(e: DomainEvent, seq: number): void {
    if (!Number.isInteger(seq) || seq <= this.#seq) {
      throw new Error(
        "seq 必须是严格递增的正整数（= events.id）：已有 " +
          this.#seq +
          "，收到 " +
          String(seq),
      );
    }
    this.#seq = seq;
    const e2: SeqEvent = { ...e, seq };
    this.#ring.push(e2);
    if (this.#ring.length > this.#cap) this.#ring.shift();
    // 广播是同步的，但每个订阅者的队列有界 ⇒ 慢消费者不会把发布者拖住（§5.8）
    for (const s of [...this.#subs]) s.deliver(e2);
  }

  subscribe(fromSeq?: number): EventSubscription {
    if (fromSeq !== undefined && (!Number.isInteger(fromSeq) || fromSeq < 0)) {
      throw new Error(
        "fromSeq 必须是非负整数（0 = 从头），收到 " + String(fromSeq),
      );
    }
    const sub = new Subscription(this, this.#cap, fromSeq);
    if (fromSeq !== undefined) {
      const backlog = this.#ring.filter((e) => e.seq > fromSeq);
      for (const e of backlog) sub.deliver(e);
      // 本应收到 (fromSeq, latestSeq]，实得 backlog ⇒ 差额就是环形已经吐掉的
      const owed = Math.max(0, this.#seq - fromSeq);
      sub.noteGap(Math.max(0, owed - backlog.length));
    }
    this.#subs.add(sub);
    return sub;
  }

  latestSeq(): number {
    return this.#seq;
  }

  /**
   * 当前活跃订阅数。生产上这就是 SSE 在线连接数的观测点；测试里它是【回收】的
   * 唯一证据 —— close() 忘了从广播名单摘除，泄漏的是连接与队列（§5.8 明确要求
   * 回收），而 dropped() 那种「它自己不再累加」的断言看不出泄漏。
   */
  subscribers(): number {
    return this.#subs.size;
  }

  /** 供 Subscription.close() 反向摘除；不公开给调用方。 */
  forget(sub: Subscription): void {
    this.#subs.delete(sub);
  }
}
