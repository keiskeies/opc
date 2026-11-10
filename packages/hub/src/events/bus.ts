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
  | { kind: "MeetingSummaryReady"; taskId: string; meetingId: string }
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
  | { kind: "ApprovalTokenRedeemed"; taskId: string; interruptId: string };

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
