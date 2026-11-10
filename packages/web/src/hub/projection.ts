/**
 * Hub 事件 → 前端状态的投影（计划 Task 2.3，规格 §5.8）。
 *
 * 【不 import React，也不 import @ag-ui/client】—— 两个包本机都装不上，
 * 而这一层真正要验的性质（乱序/重复输入的幂等、降级标记、不发疯重连、
 * 渲染进程内不存在业务状态机）【没有一条】与渲染框架有关。
 * useHubEvents 只是把这个 store 接到 useState/subscribe 上，那几行
 * 等依赖到位再补，薄到允许不测。反过来若为了「照计划文件名」而写一份
 * 跑不了的 hooks，测不到的就是全部有风险的那一半。
 *
 * ── 承重的那条纪律（§5.8 原文：事件是投影不是事实源）──────────────────
 * 前端手上的真相只有两次 REST 快照，事件流只是【两次快照之间的增量】。
 * 所以这里对每条事件只有三种反应，没有第四种：
 *   seq == cursor + 1  ⇒ 应用它，cursor 前进；
 *   seq <= cursor      ⇒ 【重复】，丢掉。已经在或已经超过那个位置，重放它是噪音；
 *   seq >  cursor + 1  ⇒ 中间【有个洞】⇒ 标 stale，去拉快照。
 *
 * 第三种是这一层存在的理由，也是计划那句「快照 + 续订天然幂等」最容易糊过去的地方：
 * 幂等【只覆盖重复】，不覆盖【丢失】。重复可以丢，丢失不能装看不见 ——
 * 一个被静默跳过的 seq 意味着前端少了一次状态变化，而它自己【无从知道少了什么】。
 * 所以这里不是「夹紧 cursor」也不是「按内容去重」，而是【承认手上的东西不完整、
 * 回去重新拿一份完整的】。这是 §5.8 那条纪律的操作性含义。
 *
 * ── 为什么这里【没有】任何状态跃迁判断 ────────────────────────────────
 * 计划的验收是「渲染进程内不存在任何业务状态机」。字面上好写（别 import 状态机就行），
 * 但真正的破法是【间接的】：前端为了「让界面更顺」自己补一拍中间态，
 * 或为了「少一次闪烁」把某个状态提前显示 —— 那都是把跃迁规则复制了一份到前端，
 * 而 Hub 那侧改了边表之后，前端会显示一个【Hub 从不产生】的状态。
 * 所以这里对 status 字段只做一件事：【逐字替换】。不校验、不推断、不合并、不排序。
 * 由 test/web/hub-projection.test.ts 从源码层面钉住这件事（见那里的守卫）。
 */

import { type FeedItemView, feedItemSchema, type TaskView } from "@opc/contracts";

/** 一次 GET /tasks 的快照。as_of_seq 是 Hub 报的「这份状态覆盖到 events.id = ?」。 */
export interface TaskSnapshot {
  readonly tasks: readonly TaskView[];
  readonly asOfMs: number;
  readonly asOfSeq: number;
}

export type Link = "connecting" | "live" | "stale" | "down";

export interface Projection {
  /** taskId → 任务。整体替换语义见 applySnapshot。 */
  readonly tasks: ReadonlyMap<string, TaskView>;
  /** 已应用的最高 seq。续订时【原样带回】。 */
  readonly cursor: number;
  /** 手上的状态【完整且新鲜】到什么程度：一次成功快照覆盖到的 seq。 */
  readonly asOfSeq: number;
  /**
   * 链路状态。四个值，其中两个是「需要人去处理」的：
   *  - stale：知道少了东西 ⇒ 该去拉快照；
   *  - down：连不上且【放弃重连了】⇒ 界面必须显式说明，
   *    而不是继续显示最后一次拿到的状态装作实时（见 shouldGiveUp 的理由）。
   */
  readonly link: Link;
  /** 第几次重连。成功收到任何数据就归零。 */
  readonly attempt: number;
  /** 待拉快照的次数（观测点：一次会话里如果 >1，说明事件流在反复出洞）。 */
  readonly resnapshotCount: number;
}

export function emptyProjection(): Projection {
  return {
    tasks: new Map(),
    cursor: 0,
    asOfSeq: 0,
    link: "connecting",
    attempt: 0,
    resnapshotCount: 0,
  };
}

/**
 * 快照【整体替换】，不做增量合并。
 *
 * 这一条看着像可以优化（「保留已有行、只更新回来的那些」更快），但那个优化会留下
 * 【Hub 已经删掉/归档而前端还挂着】的行，而那些行【没有任何信号】能告诉你它多余。
 * 增量合并的正确前提是「我知道删除事件长什么样」，而本仓的事件集合里没有删除事件
 * （tasks 不硬删，但状态会变成 ARCHIVED 而看板通常不显示它 —— 那是渲染侧的过滤，
 *  过滤条件写在渲染侧，就不属于「投影」，属于业务规则，见文件头那条纪律）。
 *
 * cursor 取 max(cursor, asOfSeq)：快照可能带着一个【比当前 cursor 更旧】的 asOfSeq
 * （请求先发后至，本机也会因为两次 await 的交错发生）。
 * 让 cursor 倒退会让旧事件被当成新的重新应用一遍 —— 那正是这条投影要防的事，
 * 而它一旦发生在【快照】这条路上，比发生在事件流上更难查，
 * 因为快照看起来总是「权威」的。
 */
export function applySnapshot(p: Projection, snap: TaskSnapshot): Projection {
  const next = new Map<string, TaskView>();
  for (const t of snap.tasks) next.set(t.id, t);
  return {
    ...p,
    tasks: next,
    asOfSeq: Math.max(p.asOfSeq, snap.asOfSeq),
    cursor: Math.max(p.cursor, snap.asOfSeq),
    link: "live",
    attempt: 0,
    // 清零：一次【成功的】快照就是「洞补上了」的唯一证据，
    // 于是 resnapshotCount 的含义是【本轮】连续出洞几次，而不是整场会话的累计。
    // 「连续」才是有指示性的那个数（≥2 说明事件流有系统性问题），
    // 累计值只会随在线时间单调涨，看不出任何东西。
    // 曾经这里写成 p.resnapshotCount 不动，而 markGap 的注释已经在讲清零 ——
    // 注释描述了实现没有的性质，是本仓反复出现的那种失效形状。
    resnapshotCount: 0,
  };
}

/** 一次事件应用的结果：新状态 + 该不该去拉快照（供调用方接线，不让它去猜 link）。 */
export type Applied = {
  readonly projection: Projection;
  readonly action: "applied" | "duplicate" | "gap";
};

/**
 * 应用一条事件。三态见文件头。
 *
 * 载荷【过 contracts 的 feedItemSchema】而不是直接信任线上来的对象。
 * 这不是防攻击（对端是本机 Hub），而是防【契约漂移】：Hub 改了字段名而前端没跟，
 * 不过 schema 的话症状是「看板静止不动，但没有任何报错」——
 * 那是本仓最难查的一类，因为它长得像「就是没有新事件」。
 * 过 schema 之后它变成一次显式失败。
 */
export function applyEvent(p: Projection, raw: unknown): Applied {
  const parsed = feedItemSchema.safeParse(raw);
  if (!parsed.success) {
    // 抛而不是忽略：见上面那段。忽略一条解不开的帧 = 亲手制造一个洞而不标 stale。
    throw new Error(
      "事件帧不符合 contracts 的 feedItemSchema，拒绝投影：" +
        parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ") +
        "。宁可让界面停在上一帧并报一次错，也不要静默跳过 —— " +
        "跳过就是一个【无人知晓的洞】。",
    );
  }
  const item = parsed.data as FeedItemView;

  if (item.seq <= p.cursor) {
    // 重复。不改 link、不动 tasks、也不重置 attempt —— 它是一次【成功的】通信，
    // 说明链路活着，但没有任何新东西。
    return { projection: p, action: "duplicate" };
  }
  if (item.seq > p.cursor + 1) {
    return {
      projection: markGap(p),
      action: "gap",
    };
  }
  const applied = applyItem(p, item);
  if ((item as { degraded?: true }).degraded === true) {
    // degraded 是总线推来的「你缺了一段」的信号（§5.8：增量缺了就回去拿全量）。
    // 判据住在【这里】而不是 applyFrame：degraded 是 FeedItem 的字段
    // （contracts 的 feedItemSchema 里就有它），而 applyEvent 收的正是 FeedItem。
    // 放在 applyFrame 会漏掉一切不走 SSE 帧的调用方（重放、测试、桌面端的推送路径），
    // 而漏了的形态是「degraded 到了，界面照常显示，什么都不说」。
    // 两条动作都要：这条事件本身是【合法的】，要【应用】；缺的那段要补。
    // 走的是与跳号【同一个】 markGap，同一条「别重复计数」的规则只写一处 ——
    // 之前这里另写了一份 link === "stale" 的判断，两份规则会漂移。
    return { projection: markGap(applied), action: "gap" };
  }
  return { projection: applied, action: "applied" };
}

/**
 * 标成 stale 并要求重拉快照。跳号与 degraded 两条路共用它。
 *
 * 已在 stale 就不再计数：cursor 在不连续的那条路上【不前进】，
 * 所以同一个洞会被随后每一条晚到的帧【重新发现一次】；逐次累加会让这个观测点
 * 变成「晚到的帧数」，而它要回答的是「这一轮里流出洞几次」—— 只有后者有指示性。
 * 清零发生在【快照成功】之后（applySnapshot），那才是「洞补上了」的唯一证据。
 */
function markGap(p: Projection): Projection {
  const already = p.link === "stale";
  return {
    ...p,
    link: "stale",
    // attempt 归零：能收到这条（哪怕是跳号的）就说明【连接是活的】，该停止退避。
    // 缺的是【数据】不是【连接】，用重连解决它是南辕北辙。
    attempt: 0,
    resnapshotCount: already ? p.resnapshotCount : p.resnapshotCount + 1,
  };
}

/**
 * 真正把一条事件并进投影。
 *
 * 注意这里【只】在 seq 连续时才被调用，且对 status 只逐字替换。
 * BudgetPaused 与 ApprovalRequired 各自带一个需要上浮给 UI 的信息
 * （预算暂停、有待批卡片），它们被记成【独立的旗标】而不是去改 task.status ——
 * 改 task.status 就是「前端自己推断状态」，那正是被禁止的那件事：
 * Hub 说 IN_PROGRESS 就是 IN_PROGRESS，哪怕它同时暂停了预算。
 * 两者的组合由渲染层去显示，而显示规则属 UI 不属投影。
 */
function applyItem(p: Projection, item: FeedItemView): Projection {
  // link 只在【本来就 live】时保持 live。
  // 这一行最初写的是无条件 link: "live"，于是一条【补上洞右侧】的连续事件
  // 会把 stale 抹掉 —— 而洞还在：cursor=1 时撞到 seq=5 标了 stale，
  // 随后 seq=2 到了、被正常应用、link 变回 live，可 seq 3、4【永远不会再来】。
  // 界面于是显示着一个【缺了两拍】的状态，而且【不再有任何降级标记】：
  // 这比一直显示 stale 坏得多，因为 stale 至少会触发重拉快照。
  // 能证明「缺的那段补上了」的只有一件事：一次完整的快照（applySnapshot）。
  // 一条事件能证明的只有「连接活着」，那对应的是 attempt 归零，不是 link 转绿。
  const next: Projection = {
    ...p,
    cursor: item.seq,
    link: p.link === "stale" ? "stale" : "live",
    attempt: 0,
  };
  const body = item as unknown as Record<string, unknown>;

  switch (item.kind) {
    case "TaskStateChanged": {
      const to = body["to"];
      const existing = p.tasks.get(item.taskId);
      if (existing === undefined || typeof to !== "string") {
        // 没有这条任务 ⇒ 我们【没见过】它（快照之后新建的）。
        // 【不凭空造一行】：造出来的行只有 id 与 status，其余字段要么缺要么得瞎填，
        // 而一个字段不全的行在看板上比少一行更糟（它会渲染成空白或报错）。
        // 标 stale 去拉快照，让权威源把那行完整的给我们。
        // 走【同一个】 markGap：这里原先另写了一份 { link: "stale", count + 1 }，
        // 少了 markGap 里「已在 stale 就不再加计数」那一半 ——
        // 于是同一轮里第三次撞见新任务会把计数推到 3，
        // 那个观测点就不再说它声称说的话了。三处标 stale 必须只有一个入口。
        return markGap(next);
      }
      const tasks = new Map(p.tasks);
      // 【只替换 status】，其余字段保持快照里那份。
      // 理由：事件的载荷里只有 from/to，若顺手把别的字段也「更新」一遍，
      // 就只能去【猜】那些字段的值，而猜 = 前端在生成数据。
      // 其余字段的更新走快照那条路（下一次 resnapshot 会带最新的 consumed_cents 等）。
      tasks.set(item.taskId, { ...existing, status: to });
      return { ...next, tasks };
    }
    default: {
      // 其余事件类型【不改 tasks】，只推进 cursor。
      // 它们各自的显示需求（待批卡片、预算暂停横幅）由渲染层订阅原始事件流去做，
      // 不在这里折进任务表 —— 折进来就是业务推断的第一步。
      return next;
    }
  }
}

/** 连接断开（一次重连失败）。attempt 递增由调用方驱动退避计算。 */
export function noteDisconnected(p: Projection, attempt: number): Projection {
  return { ...p, link: "down", attempt };
}

/**
 * 收到总线推来的 degraded 标记 ⇒ 立刻要去拉快照。
 *
 * §5.8：「事件只做增量，全量状态由 REST 补齐」。degraded 就是「增量缺了一段」的信号，
 * 它的正确反应【只有】重拉快照 —— 重试当前连接、忽略它、或者按已有信息猜缺失的部分，
 * 三个都是错的，而第三个最像能工作（多数时候猜对，偶尔显示一个过期状态）。
 */
export function applyFrame(p: Projection, frame: { event: string; id?: string; data: string }): Applied {
  if (frame.event === "snapshot") {
    const body = JSON.parse(frame.data) as {
      as_of_seq: number;
      body: { tasks?: readonly TaskView[]; asOfMs?: number };
    };
    return {
      projection: applySnapshot(p, {
        tasks: body.body.tasks ?? [],
        asOfMs: body.body.asOfMs ?? 0,
        asOfSeq: body.as_of_seq,
      }),
      action: "applied",
    };
  }
  const item = JSON.parse(frame.data) as unknown;
  // degraded 的处理【不在这里】：它是 FeedItem 的字段，判据住在 applyEvent，
  // 否则所有不走 SSE 帧的调用方（重放、桌面端推送、测试）都会漏掉它。
  return applyEvent(p, item);
}
