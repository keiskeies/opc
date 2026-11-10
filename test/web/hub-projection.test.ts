/**
 * Task 2.3 的 Test 项与验收（计划原文）：
 *   Test：喂入乱序 / 重复事件 → 最终状态与有序输入一致（幂等）；
 *         连接中断 → UI 显示降级标记且不发疯重连（退避上限）。
 *   验收：渲染进程内【不存在任何业务状态机】（状态跃迁只能由 Hub 事件驱动，§5.8）。
 *
 * ── 计划那句「乱序输入最终一致」，按字面做不出来，本文件说清能做到的是哪一半 ──
 * 「乱序」有两个完全不同的成因，幂等只治其中一个：
 *   A. 【重复投递】同一批事件到了两次（重连时游标偏旧）。⇒ 可幂等吃掉，最终一致。
 *   B. 【顺序错乱且旧的先到】seq 3 到了而 seq 2 还没到。⇒ 前端手上【没有 seq 2】，
 *      也没有任何办法从 3 反推出 2 的内容；把它夹紧到 cursor 之后应用，
 *      中间那一拍就永久丢了，界面显示的是【一个没发生过的组合状态】。
 * 所以本实现的态度是：A 吃掉，B 标 stale 去拉快照 —— 【不假装能收敛】。
 * 因此下面那条「与有序输入一致」的断言只覆盖 A；B 由另一条单独钉，
 * 钉的是【它必须产生 stale】而不是【它必须收敛】。
 * 把 B 也写成「最终一致」的用例，就得靠把事件排序缓存起来实现，
 * 那需要一个缓冲窗口和一套「等多久算超时」的规矩 —— 那是状态机，撞的是验收那条。
 *
 * 不 import React / @ag-ui/client（本机装不上，且被验的性质与渲染框架无关）。
 * 见 projection.ts 文件头那条分工。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GIVE_UP_AFTER_ATTEMPTS,
  reconnectDelayMs,
  type TaskView,
  shouldGiveUp,
} from "@opc/contracts";
import {
  applyEvent,
  applyFrame,
  applySnapshot,
  emptyProjection,
  noteDisconnected,
  type Projection,
} from "../../packages/web/src/hub/projection.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PROJECTION_SRC = join(REPO, "packages/web/src/hub/projection.ts");

function task(id: string, status = "IN_PROGRESS", over: Partial<TaskView> = {}): TaskView {
  return {
    id,
    title: "t-" + id,
    status,
    assigned_role: "dev",
    current_node: "implement",
    parent_id: null,
    budget_cents: null,
    consumed_cents: 0,
    created_at: 1,
    updated_at: 1,
    ...over,
  };
}

const changed = (seq: number, taskId: string, from: string, to: string): unknown => ({
  seq,
  kind: "TaskStateChanged",
  taskId,
  from,
  to,
});

function snapshot(asOfSeq: number, tasks: readonly TaskView[]): Projection {
  return applySnapshot(emptyProjection(), { tasks, asOfMs: 1, asOfSeq });
}

describe("重复投递（乱序成因 A）⇒ 幂等", () => {
  it("同一批事件喂两遍，最终状态与喂一遍【逐字段相同】", () => {
    const base = snapshot(3, [task("a", "IN_PROGRESS"), task("b", "IN_REVIEW")]);
    const once = [changed(4, "a", "IN_PROGRESS", "IN_REVIEW"), changed(5, "a", "IN_REVIEW", "FINAL_REVIEW")];
    let p1 = base;
    for (const e of once) p1 = applyEvent(p1, e).projection;
    let p2 = base;
    for (const e of once) p2 = applyEvent(p2, e).projection;
    for (const e of once) p2 = applyEvent(p2, e).projection; // 第二遍，全部是重复
    expect(p2.tasks.get("a")?.status).toBe(p1.tasks.get("a")?.status);
    expect(p2.cursor).toBe(p1.cursor);
    // 整表比较，不只是那一个字段：只比「被改的那个字段」的话，
    // 重复投递把别的行改掉/删掉也照样绿。
    expect([...p2.tasks.entries()]).toEqual([...p1.tasks.entries()]);
    expect(p2.tasks.size).toBe(2);
  });

  it("重复帧不改 link、不清 tasks、也不动 cursor", () => {
    const p = snapshot(5, [task("a")]);
    const r = applyEvent(p, changed(3, "a", "IN_PROGRESS", "IN_REVIEW"));
    expect(r.action).toBe("duplicate");
    expect(r.projection).toBe(p); // 同一个对象引用：没有新东西就不该产生新状态
  });

  it("快照【整体替换】：Hub 已不再返回的行不会留着", () => {
    const p = snapshot(1, [task("a"), task("b")]);
    const q = applySnapshot(p, { tasks: [task("a")], asOfMs: 1, asOfSeq: 2 });
    expect([...q.tasks.keys()]).toEqual(["a"]);
    // 「保留已有行、只更新回来的那些」看着更快，但会留下 Hub 已经不再返回的行，
    // 而那种行【没有任何信号】能告诉你它多余。
  });

  it("快照 asOfSeq 比当前 cursor 【更旧】时 cursor 不倒退", () => {
    // 两次 await 交错就能发生（请求先发后至），本机也一样。
    // cursor 倒退会让旧事件被当成新的重新应用一遍 —— 而它发生在【快照】这条路上
    // 比发生在事件流上更难查，因为快照看起来总是权威的。
    const p = snapshot(10, [task("a")]);
    const q = applySnapshot(p, { tasks: [task("a")], asOfMs: 1, asOfSeq: 4 });
    expect(q.cursor).toBe(10);
    expect(q.asOfSeq).toBe(10);
  });
});

describe("真丢事件（乱序成因 B）⇒ 承认不完整，而不是假装收敛", () => {
  it("seq 跳号 ⇒ link=stale 且【不应用】那条事件", () => {
    const p = snapshot(1, [task("a")]);
    const r = applyEvent(p, changed(5, "a", "IN_PROGRESS", "FINAL_REVIEW"));
    expect(r.action).toBe("gap");
    expect(r.projection.link).toBe("stale");
    // 【没有】被应用：跳到 FINAL_REVIEW 而中间的 IN_REVIEW 从未出现，
    // 那是一个 Hub 从不产生的组合状态。宁可显示旧状态 + 明确降级。
    expect(r.projection.tasks.get("a")?.status).toBe("IN_PROGRESS");
    expect(r.projection.cursor).toBe(1);
    expect(r.projection.resnapshotCount).toBe(1);
  });

  it("补一拍【不算收敛】：seq 3 应用后仍缺 4，link 必须还是 stale", () => {
    let p = snapshot(2, [task("a")]);
    // 先真的进入 stale（注意要【接着用返回的投影】，丢掉它就测不到目标状态了）。
    p = applyEvent(p, changed(5, "a", "x", "y")).projection;
    expect(p.link).toBe("stale");
    p = applyEvent(p, changed(3, "a", "IN_PROGRESS", "IN_REVIEW")).projection;
    // cursor 从 2 走到 3，看起来「接上了」，但 seq=4 永远不会再来。
    // 若这里把 link 打回 live，界面就显示着一个【缺了一拍】的状态而【没有任何标记】——
    // 比一直 stale 坏得多，因为 stale 至少会触发重拉。
    // 一条事件能证明的只有「连接活着」（那是 attempt 归零），
    // 能证明「缺的补上了」的只有一份完整快照。
    expect(p.cursor).toBe(3);
    expect(p.tasks.get("a")?.status).toBe("IN_REVIEW");
    expect(p.link).toBe("stale");
    // 真正的收敛长这样：
    p = applySnapshot(p, { tasks: [task("a", "IN_REVIEW")], asOfMs: 1, asOfSeq: 5 });
    expect(p.link).toBe("live");
    expect(p.resnapshotCount).toBe(0);
    expect(p.cursor).toBe(5);
  });

  it("同一个洞被晚到的帧反复撞见，计数【只加一次】", () => {
    // 计数要说的是「这一轮出洞几次」，不是「晚到的帧有几条」——
    // 后者会随时间单调涨，看不出任何东西。
    let p = snapshot(1, [task("a")]);
    p = applyEvent(p, changed(5, "a", "x", "y")).projection;
    p = applyEvent(p, changed(6, "a", "x", "y")).projection;
    p = applyEvent(p, changed(7, "a", "x", "y")).projection;
    expect(p.resnapshotCount).toBe(1);
    expect(p.link).toBe("stale");
  });

  it("「没见过这个任务」那条路也【不重复计数】（它与跳号共用同一个 markGap）", () => {
    // 上面那条走的是【跳号】分支；这一条走的是【连续但任务不存在】分支。
    // 两条路曾各自写一份 stale 标记，而后者漏了「已在 stale 就不再加计数」那一半。
    // 分开的两条用例才钉得住「三处标 stale 只有一个入口」这件事。
    let p = snapshot(1, [task("a")]);
    p = applyEvent(p, changed(2, "new-1", "CHARTER_PENDING", "IN_PROGRESS")).projection;
    expect(p.link).toBe("stale");
    expect(p.resnapshotCount).toBe(1);
    p = applyEvent(p, changed(3, "new-2", "CHARTER_PENDING", "IN_PROGRESS")).projection;
    p = applyEvent(p, changed(4, "new-3", "CHARTER_PENDING", "IN_PROGRESS")).projection;
    expect(p.link).toBe("stale");
    expect(p.resnapshotCount).toBe(1);
    expect(p.tasks.size).toBe(1); // 一个都没凭空造出来
  });

  it("degraded 帧 ⇒ 同时【应用它】并【要求重拉快照】", () => {
    // 总线的做法是把 degraded 标在现存【最早那条】上。两件事都要做：
    // 只应用不重拉 = 明知少了东西还继续显示；只重拉不应用 = 白扔一条合法事件。
    const p = snapshot(4, [task("a")]);
    const r = applyEvent(p, { ...changed(5, "a", "IN_PROGRESS", "IN_REVIEW"), degraded: true });
    expect(r.projection.tasks.get("a")?.status).toBe("IN_REVIEW");
    expect(r.projection.link).toBe("stale");
    expect(r.projection.resnapshotCount).toBe(1);
  });

  it("解不开的事件帧 ⇒ 【抛错】，而不是静默跳过", () => {
    // 契约漂移（Hub 改了字段名而前端没跟）不过 schema 的话，症状是
    // 「看板静止不动，但没有任何报错」—— 那长得像「就是没有新事件」，最难查的一类。
    expect(() => applyEvent(snapshot(1, [task("a")]), { seq: 2, kind: "TaskStateChanged" })).toThrow();
    expect(() => applyEvent(snapshot(1, [task("a")]), { seq: -1, kind: "x", taskId: "a" })).toThrow();
    expect(() => applyEvent(snapshot(1, [task("a")]), null)).toThrow();
  });

  it("没见过的新任务 ⇒ 标 stale，【不凭空造一行】", () => {
    const p = snapshot(1, [task("a")]);
    const r = applyEvent(p, changed(2, "brand-new", "CHARTER_PENDING", "IN_PROGRESS"));
    expect(r.projection.tasks.has("brand-new")).toBe(false);
    expect(r.projection.link).toBe("stale");
    // 造出来的行只有 id 与 status，其余字段要么缺要么得瞎填；
    // 一个字段不全的行在看板上比少一行更糟。
  });
});

describe("断线（计划：显示降级标记且不发疯重连）", () => {
  it("退避有下限也有上限，且到次数就放弃", () => {
    expect(reconnectDelayMs(0)).toBe(500);
    expect(reconnectDelayMs(99)).toBe(15_000);
    expect(reconnectDelayMs(99)).not.toBe(Number.POSITIVE_INFINITY);
    expect(shouldGiveUp(GIVE_UP_AFTER_ATTEMPTS - 1)).toBe(false);
    expect(shouldGiveUp(GIVE_UP_AFTER_ATTEMPTS)).toBe(true);
  });

  it("放弃后 link=down，且【不再是 live/stale】", () => {
    // 这一条守的是「Hub 挂了一小时，看板还显示崩溃前的状态、且看起来像实时」。
    // 那比一个明确的断开更坏：CEO 会基于过期看板做审批决定。
    const p = noteDisconnected(snapshot(3, [task("a")]), GIVE_UP_AFTER_ATTEMPTS);
    expect(p.link).toBe("down");
    expect(shouldGiveUp(p.attempt)).toBe(true);
  });

  it("成功收到任何一条数据，attempt 归零", () => {
    const down = noteDisconnected(snapshot(3, [task("a")]), 6);
    expect(down.attempt).toBe(6);
    const back = applyEvent(down, changed(4, "a", "IN_PROGRESS", "IN_REVIEW")).projection;
    expect(back.attempt).toBe(0);
    expect(back.link).toBe("live");
  });

  it("重复帧既不收敛 stale，也不改变任何状态", () => {
    // 用一次【真的跳号】进入 stale，而不是靠某个「手动标 stale」的旁路函数：
    // 旁路函数测出来的 stale 不代表投影自己会进入那个状态。
    const stale = applyEvent(snapshot(1, [task("a")]), changed(5, "a", "x", "y")).projection;
    expect(stale.link).toBe("stale");
    expect(stale.resnapshotCount).toBe(1);
    // seq 必须【不大于 cursor】才叫重复。这里 cursor 仍是 1（跳号那条不推进游标），
    // 所以用 seq=1；最初我写的 seq=2 其实是【连续】的，测的完全是另一回事。
    const r = applyEvent(stale, changed(1, "a", "x", "y"));
    expect(r.action).toBe("duplicate");
    expect(r.projection).toBe(stale);
    // 一条重复帧不能证明缺的那段补齐了 —— 只有【快照成功】才行（applySnapshot 里）。
    expect(r.projection.link).toBe("stale");
  });
});

describe("快照帧的线格式接得上", () => {
  it("snapshot 帧 ⇒ 整体替换并用 as_of_seq 当游标", () => {
    const p = applyFrame(emptyProjection(), {
      event: "snapshot",
      data: JSON.stringify({ source: "tasks", as_of_seq: 7, body: { tasks: [task("a")], asOfMs: 9 } }),
    });
    expect(p.projection.cursor).toBe(7);
    expect(p.projection.asOfSeq).toBe(7);
    expect(p.projection.tasks.size).toBe(1);
  });

  it("事件帧带 id ⇒ 按 data 里的 seq 走（不看 id）", () => {
    // id 与 data.seq 同源（都是 events.id），但【以 data 为准】：
    // id 是传输层的帧标识，data 才是业务载荷；两者不一致时以业务载荷为准，
    // 而这种情况本身就是 Hub 侧的 bug —— 由 hub 那侧的测试守，不在这里兜。
    const p = snapshot(1, [task("a")]);
    const r = applyFrame(p, {
      event: "TaskStateChanged",
      id: "2",
      data: JSON.stringify(changed(2, "a", "IN_PROGRESS", "IN_REVIEW")),
    });
    expect(r.projection.cursor).toBe(2);
    expect(r.projection.tasks.get("a")?.status).toBe("IN_REVIEW");
  });
});

describe("验收：渲染进程内不存在任何业务状态机", () => {
  /**
   * 源码层面的守卫。为什么不能只靠「别 import 状态机」：
   * 破法大多是【间接的】—— 为了「让界面更顺」自己补一拍中间态，
   * 或为了「少一次闪烁」把某个状态提前显示。那都是把跃迁规则抄了一份到前端，
   * 而 Hub 改了边表之后，前端会显示一个 Hub【从不产生】的状态。
   * 抄规则这件事在 import 图上【看不见】，所以只能扫源码。
   */
  const src = readFileSync(PROJECTION_SRC, "utf8");

  it("不 import 状态机 / hub 的任何东西（§5.6.1 边界）", () => {
    expect(src).not.toMatch(/from\s+["'][^"']*@opc\/hub/u);
    expect(src).not.toMatch(/from\s+["'][^"']*packages\/hub/u);
    expect(src).not.toMatch(/status\.js|graph\//u);
    // 确实读到了内容（空串对上述三条全部成立 —— 本类守卫最典型的假绿）。
    expect(src.length).toBeGreaterThan(1000);
    expect(src).toContain("applyEvent");
  });

  it("源码里【不出现任何具体状态名】", () => {
    // 抄边表的最省写法就是把状态名罗列出来做 if/switch。
    // 这条断言让「顺手加一个 if (to === 'DELIVERED')」当场变红。
    const NAMES = [
      "CHARTER_PENDING",
      "IN_PROGRESS",
      "IN_REVIEW",
      "CHARTER_APPROVED",
      "DECOMPOSING",
      "EVIDENCE_SUBMITTED",
      "APPROVED_UPWARD",
      "REJECTED_DOWNWARD",
      "MEETING_REQUIRED",
      "ESCALATED_TO_CEO",
      "BUDGET_PAUSED",
      "BLOCKED",
      "FINAL_REVIEW",
      "DELIVERED",
      "ARCHIVED",
    ];
    // 注释里出现【不算】违规（文档要讲清为什么不能这么写），所以先剥掉注释。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const hits = NAMES.filter((n) => code.includes(n));
    expect(hits).toEqual([]);
  });

  it("反向 canary：上面那条【真的会红】", () => {
    // 剥注释 + includes 的组合有一个安静的失效方式：正则写成贪婪匹配把整份代码
    // 剥成空串，于是 hits 恒为 []。所以拿一段【真的违规】的代码喂同一个判据。
    const violating = `
      /* IN_PROGRESS 出现在注释里，不该被算 */
      if (to === "DELIVERED") return p;
    `;
    const code = violating.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).toContain("DELIVERED");
    expect(code).not.toContain("IN_PROGRESS");
  });

  it("对 status 只做【逐字替换】，不看 from、不校验合法性", () => {
    // from 字段【被忽略】是刻意的：校验 from 与当前状态是否一致 = 前端在推断，
    // 而一旦 Hub 允许 A→B 与 C→B 两种入边，前端的校验就会误报。
    const p = snapshot(1, [task("a", "IN_PROGRESS")]);
    const r = applyEvent(p, changed(2, "a", "一个当前状态根本不是的值", "IN_REVIEW"));
    expect(r.projection.tasks.get("a")?.status).toBe("IN_REVIEW");
    // 其余字段【不被顺手更新】：事件载荷里没有它们，填了就是猜。
    expect(r.projection.tasks.get("a")?.consumed_cents).toBe(0);
    expect(r.projection.tasks.get("a")?.title).toBe("t-a");
  });

  it("非状态类事件【不改 tasks】：待批/预算旗标不折成 status", () => {
    const p = snapshot(1, [task("a", "IN_PROGRESS")]);
    const r = applyEvent(p, { seq: 2, kind: "ApprovalRequired", taskId: "a", interruptId: "i-1", payload: {} });
    expect(r.action).toBe("applied");
    expect(r.projection.cursor).toBe(2);
    expect(r.projection.tasks.get("a")?.status).toBe("IN_PROGRESS");
    // 把「有待批卡片」写成 status = "ESCALATED_TO_CEO" 就是前端自己造跃迁，
    // 而 Hub 那侧这条边可能根本不存在。显示由渲染层订阅原始事件流去做。
  });

  it("Hub 新加一个不认识的 kind ⇒ 【不炸、不误判为洞】，只推 cursor", () => {
    // 这一条为 ApprovalDecided 而加（规格 §5.8 那张表里没有，理由见 0010 §4）。
    // 要的性质的【方向】是【加 kind 不会打挂前端】：contracts 的 feedItemSchema 是
    // passthrough + kind 只要求非空串，投影层 switch 有 default 分支。
    // 所以老客户端（浏览器缓存里那份渲染包）收到新事件时是【照常显示】而不是白屏。
    //
    // 断言里最要紧的是 action 不是 "gap"：如果 default 分支写成了标 stale，
    // 那么 Hub 每加一种事件，所有前端就【永久降级 + 反复拉快照】——
    // 那比不认识这个 kind 严重得多，而它只需要一行错误就能发生。
    const p = snapshot(1, [task("a", "IN_PROGRESS")]);
    const r = applyEvent(p, {
      seq: 2,
      kind: "ApprovalDecided",
      taskId: "a",
      interruptId: "i-1",
      decision: "approved",
    });
    expect(r.action).toBe("applied");
    expect(r.projection.cursor).toBe(2);
    expect(r.projection.link).toBe("live");
    expect(r.projection.resnapshotCount).toBe(0);
    // 也不改 tasks：批准不是状态跃迁（status 由 Hub 的图写，见 0010 §4）。
    expect(r.projection.tasks.get("a")?.status).toBe("IN_PROGRESS");
  });
});
