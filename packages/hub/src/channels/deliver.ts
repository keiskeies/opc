/**
 * 卡片投递那一趟（O12 动作 4 的前一半：把 `deliverCard` 接上一个真的调用方）。
 *
 * ── 这个文件存在的理由 ──────────────────────────────────────────────
 * `deliverCard`（`channels/abstraction.ts`）从写下那天起在 src 里零生产调用方。
 * 它没接不是因为难写，是因为接它之前必须回答「这张卡送过没有」，而那个答案今天
 * 在库里不存在 —— 迁移 0009 补的就是那一格。本模块是那张表的**第一个写方**，
 * 也是 `deliverCard` 的**第一个生产调用方**。
 *
 * ── 为什么「送过没有」必须由库里的一行回答，而不是内存里一个 Set ──────
 * 一个进程内的 Set 在重启之后是空的，而 Hub 会重启。空掉的那一刻发生的事是：
 * 每一张还 pending 的卡都被**再推一遍**。对审批人来说这不是「重复一次」，
 * 是「早上那三张卡又来了一遍」—— 而它每 60 秒重演一次的可能性一直都在。
 * 那个后果比不发卡更坏，因为它教育的对象是人：一个人开始忽略这张卡，
 * 这条链上所有判据就都还在跑，而不再有人在读它们。
 * ⇒ 幂等必须跨重启，跨重启的东西只能落在库里。
 *
 * ── 为什么判据是「先插再发」，不是「先发再插」────────────────────────
 * 两种顺序都会失败，而失败的形状完全不同：
 *  · 先发再插：发送成功而那次 INSERT 失败（外键、磁盘满、进程被杀）⇒ 卡到了审批人
 *    手里而库里【没有】这一行 ⇒ 下一轮【再发一张】。这是重复卡的那一条路。
 *  · 先插再发：INSERT 成功而发送失败 ⇒ 库里有一行说「送过」而审批人【没收到】⇒
 *    这张卡永远不再推。这是「静默永不投递」的那一条路。
 * 选的是**后者**，而理由不是「后者损失小」，是两者的**可修复性不对称**：
 * 重复卡伤的是人对系统的信任，改不回来；而「有行而没送到」是一句可以在库里
 * 查出来、并且由**人工**重推的话（`clearDeliveriesFor` 就是那一次显式的重推）。
 * 换句话说：宁可要一个**看得见**的漏投，不要一个**看不见**的轰炸。
 * ⚠ 这一格是本轮最该被反驳的决定。它换来的是「一次网络抖动会让一张卡永远不推」，
 * 这个代价真实存在，写在下面的 `failed` 计数与那条 note 里，别读成已经解决。
 *
 * ── 抢不到那一行 ⇒ 不发 ────────────────────────────────────────────
 * 主键 `(approval_id, channel_id)` 撞了就是「这一对送过」。今天 src 里只有一个写方、
 * 心跳不并发 ⇒ 那条窗口不存在；但判据不靠这个假设成立（同 0024 / 0025 反复的立场：
 * 「先查再插」的判据不是判据，而「只有我一个人跑」也不是判据）。
 *
 * ── 不可逆那一格【不在这里判】──────────────────────────────────────
 * 判据住在 `channelIneligibleReason` 一处（`abstraction.ts` 文件头写死了这件事）。
 * 本模块做的事是【把它原样转达】给 `deliverCard`：不可逆的卡照样推出去，
 * 只是以**只读**形态推 —— 「不发」从来不是选项，不发的那张卡在主界面上是不存在的。
 * 所以这里不 import `isIrreversibleApproval`，一行都不。抄一份就是造第二个事实源。
 *
 * ── 不 import HTTP，也不 import 飞书 ───────────────────────────────
 * 通道以 `Channel` 接口的形态交进来。这个模块因此对「今天是飞书」一无所知，
 * 而它可以在一条 fake 通道上被打红（`test/channels/deliver.test.ts`）。
 */
import type { DatabaseSync } from "node:sqlite";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { assertSingleStatement, type HubWriter } from "../db/write-queue.js";
import { type Channel, deliverCard } from "./abstraction.js";
import { loadCardSnapshot } from "./approval-bridge.js";

/**
 * 一趟投递里每一种结局各几张。
 *
 * 四档**互斥且互补**：`delivered + alreadySent + skippedNotPending + failed.length`
 * 等于本轮扫到的 pending 卡数。枚举完整是刻意的 —— 少一档不报错，
 * 只会让「本轮投了几张」这句话读起来像它说了一件没说的事。
 */
export interface DeliverPassOutcome {
  /** 本轮真的推出去的张数（抢到台账那一行且发送成功）。 */
  readonly delivered: number;
  /** 台账里已有这一对 ⇒ 没再发。这是幂等在工作，不是故障。 */
  readonly alreadySent: number;
  /** 扫出来是 pending，落笔前已经不在了（被别人批掉 / 超时器刚动过它）。不是故障。 */
  readonly skippedNotPending: number;
  /**
   * 本轮【没送出去】且需要人看一眼的每张。
   *
   * ⚠ 这一档里【有两种相反的台账状态】，别读成一种：
   *  · 发送失败 ⇒ 台账行【在】（先抢后插的代价，见文件头那条不对称）⇒ 不会自动再推；
   *  · 抢台账时外键违例（卡在这一趟扫描之后被人删了）⇒ 台账行【不在】，
   *    而那张卡也已经不存在了 ⇒ 没有可推的东西。
   * 两条都放在这里，是因为对调用方它们说的是同一句话：「这张卡这一轮没到审批人手里」。
   * 区别在 `why` 里，读那一句就能分开。
   */
  readonly failed: readonly DeliverFailure[];
}

export interface DeliverFailure {
  readonly approvalId: string;
  readonly channelId: string;
  readonly why: string;
}

/**
 * 扫描用的那一条 SQL：所有 pending 卡。
 *
 * 不带 LIMIT。单用户产品里 pending 卡的量级是「一屏数得过来」，而加了上限就要回答
 * 「被截断的那些怎么办」—— 那一格今天没有正确答案（跳过它们等于静默不投，
 * 从别的开始又等于让某几张卡永远排不上）。今天扫全表是对的量，真到需要上限那天，
 * 需要的是一个**顺序**（按 created_at？按 timeout_at？）而不是一个数字。
 */
export const PENDING_APPROVAL_IDS_SQL =
  "SELECT id FROM approvals WHERE status = 'pending' ORDER BY rowid";

/**
 * 幂等键落在主键上：撞了就【什么都不写】，`changes` 给 0。
 *
 * 用 `INSERT OR IGNORE` 而不是裸 `INSERT`：裸的那一条会让抢不到的那一发**抛错**，
 * 而「这一对送过」是本函数**最常见**的一条路径（每一轮心跳、对每一张已投的卡都会走），
 * 用异常表达一件正常的事会让 `failed` 变成一个混合了「真失败」与「本来就是重复」的数。
 *
 * ⚠ `OR IGNORE` 只吞**约束违例里的那一类**。本轮实测（`node:sqlite`，见
 * `.workbuddy/AUDIT-LEDGER.txt` round283 那一节的探针）：
 *  · 正常插入 ⇒ `changes` 为 1；
 *  · 主键撞 ⇒ `changes` 为 0，不抛 —— 这是 `claimDelivery` 返回 false 的唯一来源；
 *  · **外键违例（卡已不在 `approvals` 里）⇒ 抛 `FOREIGN KEY constraint failed`**，
 *    `OR IGNORE` 不管这一类。
 * 我最初在这里写的是「外键与主键在这条语句上都是『没落地』」—— 那是一句没测的推断，
 * 探针把它推翻了。差别有实际后果：外键违例会让 `claimDelivery` 的 promise **reject**，
 * 所以 `runDeliverPass` 必须接住它，否则一张在扫描之后被删掉的卡会把整轮投递带走
 * （同 `pollAll` 那条「一条坏通道带走全部」，只是方向换成一张坏卡）。
 * 会走到这一格的路只有一条：扫描读出 id 之后、落笔之前，那张卡被人删了。
 */
export const RECORD_DELIVERY_SQL =
  "INSERT OR IGNORE INTO card_deliveries " +
  "(approval_id, channel_id, sent_at, action_return) VALUES (?, ?, ?, ?)";

/** 台账里有没有这一对（读侧那一发用，不参与本轮判定）。 */
export const WAS_DELIVERED_SQL =
  "SELECT 1 FROM card_deliveries WHERE approval_id = ? AND channel_id = ?";

/**
 * 把「送过没有」这句话变成一个可重放的读法。
 *
 * 单独导出是因为**排障**要读它：审批人说「我没收到那张卡」，
 * 第一句要问的是「我们以为我们送过了」。那一问今天有答案，靠的就是这一个函数。
 */
export function wasDelivered(
  read: DatabaseSync,
  approvalId: string,
  channelId: string,
): boolean {
  assertSingleStatement(WAS_DELIVERED_SQL);
  return (
    read.prepare(WAS_DELIVERED_SQL).get(approvalId, channelId) !== undefined
  );
}

/**
 * 显式重推：把这一对的台账行清掉，让下一轮投递把它当新卡再推一次。
 *
 * ⚠ 这个方法**故意**是导出且显式的，不接进任何自动路径。
 * 「清掉台账」= 「假装我们没送过」，而那句话只在一个前提下为真：确实送出去了而没人收到。
 * 自动触发它（比如「N 小时没被批就重推」）会造出的正是本文件整篇在防的那件事 ——
 * 一个人手机上每 N 小时重演一遍同一批卡。真需要那一条时，它需要的是一个
 * **人已读过**的信号，而那个信号今天不在库里（那张表不是这一张）。
 */
export async function clearDeliveriesFor(
  w: HubWriter,
  approvalId: string,
): Promise<void> {
  const sql = "DELETE FROM card_deliveries WHERE approval_id = ?";
  assertSingleStatement(sql);
  await w.node(() => {
    const db = requireScopeDb("clearDeliveriesFor");
    db.prepare(sql).run(approvalId);
  });
}

/** 一趟投递的输入。 */
export interface DeliverPassOptions {
  readonly w: HubWriter;
  readonly channels: readonly Channel[];
  readonly nowMs: number;
  /**
   * 本轮只往【这一条】通道发。
   *
   * 必填，且不允许多条。理由不是「今天只有一条通道」，是**一张卡送哪条通道**这件事
   * 今天没有依据：库里没有任何一列说「这张卡归哪条通道」，而多条通道时「对每条都发」
   * 是一个**造出来的**语义（它会把同一张卡推给同一个人的两个入口）。
   * ⇒ 路由需要一张能表达「谁的卡走哪条路」的表，那是另一件事，不该在这里默认。
   */
  readonly channelId: string;
}

/**
 * 扫一遍 pending，把没送过的卡送上那条通道。
 *
 * 一张卡一次外网调用，**串行**（不 `Promise.all`）：并发发会让失败顺序变得无法解释，
 * 而这里的量级根本不需要并发。任何一张发送失败都不带走其余（同 `pollAll` 那条纪律）。
 */
export async function runDeliverPass(
  o: DeliverPassOptions,
): Promise<DeliverPassOutcome> {
  const channel = o.channels.find((c) => c.id === o.channelId);
  if (channel === undefined) {
    // 装配方把一条没注册过的通道 id 交进来了。抛，而不是返回四个零：
    // 返回零读起来像「本轮没有要发的卡」，而真相是「发卡这件事根本没在跑」。
    throw new Error(
      "runDeliverPass：通道 " +
        o.channelId +
        " 不在注册表里（注册了 " +
        o.channels.map((c) => c.id).join(" / ") +
        "）⇒ 本轮【没有】投任何卡。",
    );
  }
  const read = o.w.readConnection();
  assertSingleStatement(PENDING_APPROVAL_IDS_SQL);
  const ids = (
    read.prepare(PENDING_APPROVAL_IDS_SQL).all() as { id: string | null }[]
  )
    .map((r) => r.id)
    .filter((x): x is string => typeof x === "string");

  const cardOf = loadCardSnapshot(o.w);
  let delivered = 0;
  let alreadySent = 0;
  let skippedNotPending = 0;
  const failed: DeliverFailure[] = [];

  for (const approvalId of ids) {
    const snap = cardOf(approvalId);
    // 读不到或者已经不是 pending（这一轮里被别人批掉了 / 超时器刚动过它）。
    // 那不是故障：那张卡不再需要一条待办推送。
    if (snap === null || snap.status !== "pending") {
      skippedNotPending += 1;
      continue;
    }
    // ⭐ 顺序：先抢台账那一行，抢到了才发。见文件头那条不对称。
    //
    // 这里**不**先 `wasDelivered` 再插。那条「先查再插」看着省一次写，
    // 而它给的是一份会过期的读（查与插之间别人能插进去），且会让 `alreadySent`
    // 有两个来源、于是「这一档为什么 +1」变成要分辨的两件事。
    // 抢插一条语句就把幂等判完（0024 / 0025 反复的那条立场），读的那一发
    // 只留给排障（`wasDelivered`）。
    let claimed: boolean;
    try {
      claimed = await claimDelivery(
        o.w,
        approvalId,
        channel.id,
        o.nowMs,
        channel.supportsActionReturn,
      );
    } catch (e) {
      const why = String(e);
      // 只接住【这一类】。第一次写的是无条件 catch，于是夹具里一个手滑的
      // `ReferenceError: reads is not defined` 被这条 note 盖成了「这张卡大概已被删」——
      // 一条假的解释盖住一个真的故障，而且它读起来像测试自己造出来的那种情形。
      // 磁盘满 / 库被锁 / 代码写错 都必须照原样冒出去（同 `requireScopeDb` 的立场：
      // 宁可当场炸，也不要一条看起来合理的错话）。
      if (!why.includes("FOREIGN KEY constraint failed")) throw e;
      // 走到这里 = 卡在这一趟扫描之后被删了（实测唯一会撞外键的形状）。
      // 记进 failed 而不是让它冒出去 —— 一张被删的卡不该带走其余卡的投递。
      failed.push({
        approvalId,
        channelId: channel.id,
        why: "这张卡大概已在本轮扫描后被删（台账那一行没落地）：" + why,
      });
      continue;
    }
    if (!claimed) {
      alreadySent += 1;
      continue;
    }
    const r = await deliverCard(channel, snap);
    if (r.kind === "sent") {
      delivered += 1;
      continue;
    }
    // 发失败了：台账那一行【留着】。见文件头「看得见的一次漏投」。
    failed.push({ approvalId, channelId: channel.id, why: r.why });
  }
  return { delivered, alreadySent, skippedNotPending, failed };
}

/**
 * 抢一次台账。返回 false = 这一对送过（主键撞）。
 *
 * 会抛：外键违例（卡不在 `approvals` 里）。见 `RECORD_DELIVERY_SQL` 上面那段实测。
 *
 * `action_return` 记的是**这一刻**通道的判定（`deliverCard` 内部读的是同一个 getter，
 * 两者之间隔一次外网调用，值可能翻 —— 那不影响投递，只影响那一句排障的话，
 * 所以不为它加锁）。
 */
async function claimDelivery(
  w: HubWriter,
  approvalId: string,
  channelId: string,
  nowMs: number,
  actionReturn: boolean,
): Promise<boolean> {
  assertSingleStatement(RECORD_DELIVERY_SQL);
  return w.node(() => {
    const db = requireScopeDb("claimDelivery");
    const res = db
      .prepare(RECORD_DELIVERY_SQL)
      .run(approvalId, channelId, nowMs, actionReturn ? 1 : 0);
    return Number(res.changes) > 0;
  });
}
