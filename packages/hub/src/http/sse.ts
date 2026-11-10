/**
 * SSE 的取流与续订（计划 Task 2.1 的 GET /events 语义，规格 §5.8 / Task 2.3 的幂等前提）。
 *
 * 这一层【不碰 HTTP】：它只回答一个问题 —— 「给定一个游标，该按什么顺序发哪些帧」。
 * 传输层（Hono 的 SSE 响应）只是把这个 async iterable 逐帧 write 出去。
 * 分成两层不是为了整洁：断线重连的正确性是【顺序与去重】问题，与套接字怎么写无关，
 * 前者可以被普通单测穷尽，而后者本机的依赖装不上 —— 薄到只剩 write 的一层
 * 不值得用「测不到」换「看起来全」。
 *
 * ── 承重的那条不变量 ────────────────────────────────────────────────────
 * 计划 Task 2.3 的原话是：「断线后先 GET /tasks 拉快照，再用 subscribe(fromSeq) 从游标
 * 续订 —— 游标就是 events.id，因此『快照 + 续订』天然幂等，不会因重放产生重复投影」。
 *
 * 【「天然」两个字是错的，或者说它悄悄依赖一个没有写出来的前提】：
 * 游标必须在读快照【之前】取。两种顺序的差别只在快照读取的那一小段时间里落库的事件：
 *   游标先取（C = 快照前的 latestSeq）：(C, 快照] 这段既在快照里、又会被重投递
 *     ⇒ 重复，而重复正是幂等要吃的 ⇒ 【不丢】。
 *   快照先读、游标后取（C = 快照后的 latestSeq）：(快照时的 seq, C] 这段
 *     【既不在快照里、也不会被投递】⇒ 【丢事件】，而且是一次静默的丢。
 * 症状是「看板偶尔少一次状态变化，刷一次就好」—— 最难查那一类，因为它依赖时序。
 *
 * 所以这里把「先取游标」做成【结构上无法跳过】的一步：拿游标唯一的方式是调
 * beginSnapshot()，而它返回的对象上才有 commit/frames。想跳过就得绕过这个 API，
 * 而绕过时类型会缺。这是 §8.2 第 4 条同一种思路：能绕过的那条路不要留在那里。
 */

import type { EventBus, FeedItem } from "../events/bus.js";
import { encodeSseFrame, type SseFrame } from "@opc/contracts";

/** 快照的形状：一个拉当前状态的函数 + 它对应的资源名（进日志与 degraded 提示）。 */
export interface SnapshotSource<T> {
  readonly name: string;
  read(): Promise<T>;
}

/**
 * 一次「快照 + 续订」的取流计划。
 *
 * 用法只有一条通路（这是刻意的，见文件头）：
 *   const plan = await ResumeStream.begin(bus, snapshot)   // ① 先取游标，再读快照
 *   for await (const frame of plan.frames()) { … }         // ② 按游标续订并去重
 */
export class ResumeStream<T> {
  readonly #bus: EventBus;
  readonly #cursor: number;
  readonly #snapshot: SnapshotSource<T>;
  readonly #snapshotBody: T;
  /** 已经发出去的最大 seq。去重的唯一判据 —— 不看内容、不看 kind，只看 seq。 */
  #highest = 0;

  private constructor(
    bus: EventBus,
    cursor: number,
    snapshot: SnapshotSource<T>,
    snapshotBody: T,
  ) {
    this.#bus = bus;
    this.#cursor = cursor;
    this.#snapshot = snapshot;
    this.#snapshotBody = snapshotBody;
  }


  /**
   * 取游标 → 读快照。**顺序在实现里写死**：#cursor 在 await read() 【之前】定格。
   *
   * 为什么暴露成 begin() 而不是让调用方自己传 fromSeq：调用方自己传的话，
   * 他手上只有「快照之后读到的 latestSeq」这一个值可用（快照前那个值他没理由留着），
   * 而那正是上面那条丢事件的路径。把取游标收进来，就没有「顺手传了个后来的值」这种错。
   */
  static async begin<U>(
    bus: EventBus,
    snapshot: SnapshotSource<U>,
  ): Promise<ResumeStream<U>> {
    if (
      snapshot.name.trim() === "" ||
      typeof snapshot.read !== "function"
    ) {
      throw new Error("SnapshotSource 需要非空 name 与 read()。");
    }
    const cursor = bus.latestSeq(); // ← 必须在 await 之前
    const body = await snapshot.read();
    return new ResumeStream<U>(bus, cursor, snapshot, body);
  }

  /**
   * 客户端带着【自己的游标】回来续订（断线重连 / ?cursor= / Last-Event-ID）。
   *
   * 与 begin() 是两条不同的路，不是 begin 的一个可选参数 —— 这点值得说清：
   *  - begin()：客户端【没有】游标（首次连接）。游标只能由服务端在读快照【前】取，
   *    取晚了就丢事件，见文件头。这条路上客户端无权提供游标。
   *  - resume(fromSeq)：客户端【有】游标，它就是「我最后成功处理到 events.id = N」。
   *    这里【不能】改用 latestSeq：那样等于把客户端说「我缺 58..90」的那段抹掉，
   *    静默只发 91 之后的 —— 计划 Task 2.1 的 Test 项「断线重连后按游标续订
   *    不丢事件」写的就是这一条，而它的失效形态恰好是「看起来连上了、也在推流」。
   *
   * #highest 从 fromSeq 起算而不是 0：客户端已经处理过的条目不该再发一遍。
   * 环形缓冲若已经吐掉了 (fromSeq, latest] 的中间段，总线会打上 degraded，
   * 前端的正确反应是回去拉快照（§5.8），而不是以为收到的是全的。
   */
  static async resume<U>(
    bus: EventBus,
    snapshot: SnapshotSource<U>,
    fromSeq: number,
  ): Promise<ResumeStream<U>> {
    if (!Number.isSafeInteger(fromSeq) || fromSeq < 0) {
      // 报错而不是夹紧到 0：负数/小数游标意味着客户端的游标管理已经错了
      // （或有人在手拼 URL），夹紧会让这个错误【看起来成功】。
      throw new Error(
        "续订游标必须是非负整数（= 客户端最后成功处理的 events.id），实到 " +
          String(fromSeq),
      );
    }
    if (snapshot.name.trim() === "" || typeof snapshot.read !== "function") {
      throw new Error("SnapshotSource 需要非空 name 与 read()。");
    }
    const body = await snapshot.read();
    const s = new ResumeStream<U>(bus, fromSeq, snapshot, body);
    s.#highest = fromSeq;
    return s;
  }

  /** 本次使用的游标（要回给客户端做 Last-Event-ID 的初值）。 */
  get cursor(): number {
    return this.#cursor;
  }

  get snapshotBody(): T {
    return this.#snapshotBody;
  }

  /** 已发出的最大 seq；客户端的游标应当一路跟着它走。 */
  get highestSeq(): number {
    return this.#highest;
  }

  /**
   * 逐帧产出：先一帧快照，再按游标续订。
   *
   * limit 是给测试与「只取已有的一批」用的；不传就是长连接语义（一路等下去）。
   * 快照帧【不带 id】—— 它不对应任何 events.id，给它编一个 id 等于伪造游标：
   * 客户端下次带这个假 id 来续订，就会从错误的位置续。
   */
  async *frames(limit?: number): AsyncGenerator<SseFrame> {
    yield {
      event: "snapshot",
      data: JSON.stringify({
        source: this.#snapshot.name,
        /**
         * 快照覆盖到的位置。客户端据此知道「我手上的状态新到什么程度」。
         *
         * 取【游标】而不是取读快照那一刻的 latestSeq —— 这是刻意向下 claim：
         * 快照实际覆盖的位置 >= 游标（它在游标之后才被读），所以报游标只会
         * 让客户端以为快照比实际旧一点，于是多收几条、靠 seq 去重吃掉（无害）；
         * 反过来报晚了的位置会让客户端以为某些变化已在快照里而不再应用 —— 那是丢。
         */
        as_of_seq: this.#cursor,
        body: this.#snapshotBody,
      }),
    };
    const sub = this.#bus.subscribe(this.#cursor);
    try {
      let sent = 0;
      for await (const item of sub) {
        const frame = this.#next(item);
        if (frame === null) continue; // 已被快照覆盖过 ⇒ 去重丢掉
        yield frame;
        sent += 1;
        if (limit !== undefined && sent >= limit) return;
      }
    } finally {
      // 必须在 finally 里 close：§5.8 明确要回收，而 for-await 的 break / throw
      // 都不会走到函数末尾。漏 close 泄漏的是【连接 + 一条有界队列】，
      // 且 bus.subscribers() 会一路涨（那是本仓认定的唯一回收证据）。
      sub.close();
    }
  }

  /**
   * 一帧该不该发。返回 null = 丢。
   *
   * 判据只有 seq 单调这一条，【不看内容】。看内容就要定义「什么算同一条事件」，
   * 而事件载荷里没有任何字段能担当这个身份（同一条 TaskStateChanged 可能合法地
   * 出现两次：A→B 被打回后又 A→B）。seq 是 events.id，是全库唯一的身份。
   */
  #next(item: FeedItem): SseFrame | null {
    if (item.seq <= this.#highest) return null;
    this.#highest = item.seq;
    return {
      event: item.kind,
      id: String(item.seq),
      data: JSON.stringify(item),
    };
  }
}

/**
 * 断线重连的退避上限（Task 2.3 的「不发疯重连」）。
 *
 * 纯函数、无状态：调用方自己记第几次。指数退避 + 上限，
 * 上限是这条函数存在的意义 —— 没有上限的指数退避会让 Hub 挂了一小时后
 * 重连间隔变成几十分钟，而恢复后 CEO 要点开看板却还要等那一坨；
 * 没有下限（每次都固定 1s）则 Hub 起不来时前端每 1s 撞一次，日志被刷满。
 */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 15_000;

export function reconnectDelayMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 0) {
    throw new Error("attempt 是非负整数（第 0 次重连传 0），实到 " + String(attempt));
  }
  // 2**attempt 在 attempt 很大时会溢出成 Infinity，下面与上限取 min 之前先夹一次指数，
  // 免得「上限」这件事要靠 Infinity 参与运算才成立（能算对，但读不出意图）。
  const exp = Math.min(attempt, 16);
  return Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_MAX_MS);
}

/**
 * 什么时候该放弃重连、把界面切成「去拉快照」。
 *
 * 为什么要有这一条而不是无限重连：§5.8 的纪律是「事件只做增量，全量状态由 REST 补齐」。
 * 无限重连的前端会在 Hub 崩溃期间一直显示【崩溃前】的状态，而且显示得像实时。
 * 那比一个明确的「连接断开」更坏 —— CEO 会基于一个过期看板做审批决定。
 */
export const GIVE_UP_AFTER_ATTEMPTS = 8;

export function shouldGiveUp(attempt: number): boolean {
  return attempt >= GIVE_UP_AFTER_ATTEMPTS;
}

/** 一帧 SSE 的线格式（复用 contracts 里那份编码器，服务端与前端不各写一份）。 */
export function writeFrame(frame: SseFrame): string {
  return encodeSseFrame(frame);
}
