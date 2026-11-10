/**
 * Task 0.8 验收：TaskStateChanged 的 from/to 必须与规格 §7.1 状态机【完全一致】，
 * 无非法跃迁。
 *
 * 为什么边集要在测试里逐条标出处：如果实现先定义「合法跃迁」、测试再照实现写断言，
 * 测试就成了实现的复述 —— 任何人往实现里塞一条非法边，测试会跟着一起改。
 *
 * 【规格的洞】§7.1 的缩进图机械解析只得 14 条边，其中 APPROVED_UPWARD /
 * ESCALATED_TO_CEO 没有出边 —— 照字面实现，任务一旦进入这两个状态就【永远无法交付】。
 * §7.2 那张「从想法到上线」的完整流转示例明确走过了这两步，所以下面按 §7.2 补边，
 * 并逐条注明出处。补边不是我在扩展语义，是不补就跑不通文档自己的示例。
 *
 * 反过来，§7.1 没给出路、§7.2 也没示例的三态（MEETING_REQUIRED / BUDGET_PAUSED /
 * BLOCKED）这里【保持为死路并显式断言】。不替规格编语义：编出来的恢复边会让
 * 「非法跃迁」检查松掉 —— 什么都能跃迁就等于什么都不检查。将来这些任务（辩论会子图 /
 * 预算硬停 / §7.3 心跳恢复）落地时必须改这张表，届时本文件相应断言会红，逼人来对账。
 */
import { describe, expect, it } from "vitest";
import {
  assertTaskTransition,
  isTaskTransitionLegal,
  legalTransitionsFrom,
  TASK_STATES,
  type TaskState,
} from "../../src/graph/status.js";

describe("§7.1 状态枚举", () => {
  it("15 个状态，名字逐字来自规格", () => {
    expect([...TASK_STATES].sort()).toEqual(
      [
        "APPROVED_UPWARD",
        "ARCHIVED",
        "BLOCKED",
        "BUDGET_PAUSED",
        "CHARTER_APPROVED",
        "CHARTER_PENDING",
        "DECOMPOSING",
        "DELIVERED",
        "ESCALATED_TO_CEO",
        "EVIDENCE_SUBMITTED",
        "FINAL_REVIEW",
        "IN_PROGRESS",
        "IN_REVIEW",
        "MEETING_REQUIRED",
        "REJECTED_DOWNWARD",
      ].sort(),
    );
    // 用【集合相等】而不是逐条 toContain：contain 只抓「少了」，抓不到「多定义了
    // 一个规格里没有的状态」。多定义的状态会悄悄进入审计历史，回放时无人认得。
    expect(TASK_STATES.length).toBe(15);
  });
});

describe("§7.1 主链（缩进图直译，5 条逐级）", () => {
  it("CHARTER_PENDING 起到 EVIDENCE_SUBMITTED → IN_REVIEW 逐级合法", () => {
    const chain: [TaskState, TaskState][] = [
      ["CHARTER_PENDING", "CHARTER_APPROVED"], // §7.1 第 766→767 行
      ["CHARTER_APPROVED", "DECOMPOSING"], //    §7.1 767→768
      ["DECOMPOSING", "IN_PROGRESS"], //         §7.1 768→769
      ["IN_PROGRESS", "EVIDENCE_SUBMITTED"], //  §7.1 769→770
      ["EVIDENCE_SUBMITTED", "IN_REVIEW"], //    §7.1 770→771
    ];
    for (const [from, to] of chain) {
      expect(isTaskTransitionLegal(from, to), from + " → " + to).toBe(true);
    }
  });

  it("IN_REVIEW 的六个出口，一条不多一条不少", () => {
    // §7.1 772-777 行逐条列出：APPROVED_UPWARD / REJECTED_DOWNWARD / MEETING_REQUIRED /
    // ESCALATED_TO_CEO / BUDGET_PAUSED / BLOCKED。数量本身是断言对象：多一个出口，
    // 「门控能拦住的跃迁」就少一种。
    expect([...legalTransitionsFrom("IN_REVIEW")].sort()).toEqual(
      [
        "APPROVED_UPWARD",
        "BLOCKED",
        "BUDGET_PAUSED",
        "ESCALATED_TO_CEO",
        "MEETING_REQUIRED",
        "REJECTED_DOWNWARD",
      ].sort(),
    );
  });

  it("交付链：CHARTER_PENDING 与 FINAL_REVIEW 两条入口都能到 ARCHIVED", () => {
    // §7.1 778 行的缩进把 FINAL_REVIEW 挂在 CHARTER_PENDING 同层级：顶层任务跳过
    // 执行链直接终审，这是规格给的通道，不是漏洞。
    expect(isTaskTransitionLegal("CHARTER_PENDING", "FINAL_REVIEW")).toBe(true);
    expect(isTaskTransitionLegal("FINAL_REVIEW", "DELIVERED")).toBe(true);
    expect(isTaskTransitionLegal("DELIVERED", "ARCHIVED")).toBe(true);
  });
});

describe("补边：§7.1 缺出边会成死路，按 §7.2 流转示例补齐", () => {
  it("APPROVED_UPWARD → IN_PROGRESS（§7.1 772 行括注「进入下一层级，重复 IN_PROGRESS → APPROVED_UPWARD」）", () => {
    expect(isTaskTransitionLegal("APPROVED_UPWARD", "IN_PROGRESS")).toBe(true);
  });

  it("APPROVED_UPWARD → ESCALATED_TO_CEO（§7.2 步骤 7→8）", () => {
    // 用例 7「测试审阅 → APPROVED_UPWARD（有条件通过）」紧接用例 8「→ ESCALATED_TO_CEO
    // （是否接受 P2 缺陷上线超出技术层权限）」。§7.1 的图里没有这条边。
    expect(isTaskTransitionLegal("APPROVED_UPWARD", "ESCALATED_TO_CEO")).toBe(
      true,
    );
  });

  it("ESCALATED_TO_CEO → FINAL_REVIEW（§7.2 步骤 8→9：CEO 批准上线后进入交付）", () => {
    // 没有这条边，CEO 批完任务就卡在 ESCALATED_TO_CEO —— 审批有了、交付不了。
    expect(isTaskTransitionLegal("ESCALATED_TO_CEO", "FINAL_REVIEW")).toBe(
      true,
    );
  });

  it("REJECTED_DOWNWARD → IN_PROGRESS（§7.2 打回路径说明：「任务沿边回退到上游重新处理」）", () => {
    // 打回之后必须能重做，否则一次打回 = 任务作废。
    expect(isTaskTransitionLegal("REJECTED_DOWNWARD", "IN_PROGRESS")).toBe(
      true,
    );
  });

  it("整条 §7.2 示例轨迹逐步校验，每一步都合法", () => {
    // §7.2 表格（785-796 行）里出现的状态顺序。这条断言的作用：把「文档自己的示例」
    // 变成可执行回归 —— 将来谁改小这张边表，最先炸的是文档示例，而不是某段业务代码。
    const walkthrough: TaskState[] = [
      "CHARTER_PENDING",
      "CHARTER_APPROVED",
      "DECOMPOSING",
      "IN_PROGRESS",
      "EVIDENCE_SUBMITTED",
      "IN_REVIEW",
      "APPROVED_UPWARD",
      "IN_PROGRESS", // 进入下一层级，重复 IN_PROGRESS → APPROVED_UPWARD
      "EVIDENCE_SUBMITTED",
      "IN_REVIEW",
      "APPROVED_UPWARD",
      "ESCALATED_TO_CEO",
      "FINAL_REVIEW",
      "DELIVERED",
      "ARCHIVED",
    ];
    for (let i = 0; i + 1 < walkthrough.length; i++) {
      const from = walkthrough[i] as TaskState;
      const to = walkthrough[i + 1] as TaskState;
      expect(
        isTaskTransitionLegal(from, to),
        "§7.2 第 " + (i + 1) + " 步 " + from + " → " + to,
      ).toBe(true);
    }
  });
});

describe("非法跃迁（校验的存在意义全在这一段）", () => {
  it("终态没有出边：ARCHIVED 之后什么都不能发生", () => {
    expect([...legalTransitionsFrom("ARCHIVED")]).toEqual([]);
  });

  it("自环一律非法：重复同一个状态不是跃迁，是重复写入", () => {
    // 缺陷 A 让中断恢复会重复写事件；自环放开就等于把那种重复合法化。
    for (const s of TASK_STATES) {
      expect(isTaskTransitionLegal(s, s), s + " 自环").toBe(false);
    }
  });

  it("跨级跃迁非法：CHARTER_PENDING 不能直达 DELIVERED", () => {
    // 「任务其实做完了、只是没记中间状态」在审计里会显示成一段【合法的历史】，
    // 而回放无法重建过程 —— 所以跨级必须拒，不是记条 warning。
    expect(isTaskTransitionLegal("CHARTER_PENDING", "DELIVERED")).toBe(false);
    expect(isTaskTransitionLegal("IN_PROGRESS", "ARCHIVED")).toBe(false);
    expect(isTaskTransitionLegal("IN_REVIEW", "DELIVERED")).toBe(false);
    expect(isTaskTransitionLegal("DECOMPOSING", "IN_REVIEW")).toBe(false);
  });

  it("§7.1 未给出路的三态【当前】是死路 —— 显式钉住这个已知缺口", () => {
    // 这三条断言【不是】设计意图，是「规格没写恢复边」这一事实的快照。
    // 辩论会子图 / 预算硬停 / 心跳恢复各自落地时必须来改这张表，届时这里变红。
    expect([...legalTransitionsFrom("MEETING_REQUIRED")]).toEqual([]);
    expect([...legalTransitionsFrom("BLOCKED")]).toEqual([]);
  });

  it("预算暂停态：升级边已补（Task 1.6 落地触发的对账），恢复边【仍未补】", () => {
    // 本用例是上面那条「已知缺口快照」被自己装的那条绊线弄红的结果 ——
    // 原话是「预算硬停落地时必须改这张表，届时本文件相应断言会红，逼人来对账」。
    // Task 1.6 让 §7.4 硬停真的能触发了，于是红了一次，对账结论记在 status.ts 的边上：
    // §8.3 第二条 + §7.4 的收件箱按钮 ⇒ 升级边有原文依据，补。
    expect(isTaskTransitionLegal("BUDGET_PAUSED", "ESCALATED_TO_CEO")).toBe(true);
    // §7.4「决策后 agent 从 Checkpoint 恢复」没点名恢复到哪个状态，所以恢复边仍缺席。
    // 这一半缺口继续显式钉住：CEO 点「追加预算」之后落哪个状态，是一条待拍板项。
    expect([...legalTransitionsFrom("BUDGET_PAUSED")]).toEqual([
      "ESCALATED_TO_CEO",
    ]);
  });

  it("未知状态名直接抛错，不与「非法跃迁」混为一谈", () => {
    // 修法完全不同：非法跃迁是编排错了，未知名字是枚举拼错或有人塞了私有状态。
    expect(() =>
      isTaskTransitionLegal("CHARTER_PENDING", "DONE_NOT_EXIST" as TaskState),
    ).toThrow(/DONE_NOT_EXIST/);
    expect(() =>
      isTaskTransitionLegal("NOPE" as TaskState, "IN_PROGRESS"),
    ).toThrow(/NOPE/);
  });
});

describe("assertTaskTransition：写入前的闸门", () => {
  it("合法跃迁返回 to，便于链式", () => {
    expect(assertTaskTransition("CHARTER_PENDING", "CHARTER_APPROVED")).toBe(
      "CHARTER_APPROVED",
    );
  });

  it("非法跃迁的报错同时含两端与【该状态的合法出口】", () => {
    // 只说「非法跃迁」没法修：编排者真正要的是「那到底能写什么」。
    const e = (() => {
      try {
        assertTaskTransition("CHARTER_PENDING", "DELIVERED");
        return undefined;
      } catch (err) {
        return err as Error;
      }
    })();
    expect(e).toBeInstanceOf(Error);
    const msg = String(e?.message);
    expect(msg).toContain("CHARTER_PENDING");
    expect(msg).toContain("DELIVERED");
    expect(msg).toContain("CHARTER_APPROVED"); // 该状态的合法出口
    expect(msg).toContain("FINAL_REVIEW"); // 另一个合法出口
  });
});
