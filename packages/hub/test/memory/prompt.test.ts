/**
 * 记忆 → 提示词那一段（O3 动作 1 的判据本体）。
 *
 * ── 为什么单独一个文件，而不去 runtime.test.ts 里加几发 ──────────────────
 * `memory/prompt.ts` 是纯函数，而它的【每一格话】都是判据。runtime.test.ts 的每一发
 * 都要先起一个 WriteQueue + migrate 的世界 —— 为一句措辞付那个代价，实际结果就是
 * 没人测（`charter/prompt.ts` 的文件头写的正是同一条因果，这里是它的第二次落地）。
 *
 * ── 这个文件最重要的一条元纪律 ──────────────────────────────────────
 * 四条路径【都必须非空】，而且各自的断言判的是【那一条自己的话】。
 * 理由：这一整个模块存在的唯一理由是「空的时候要说一句真话」。若只断"输出非空"，
 * 那么四条路径返回同一句「无参考」也全绿 —— 而那正是 O3 要治的病（把"读失败"、
 * "被隔离挡掉"、"库里真没有"三件相反的事压成同一句沉默）。
 * 所以每一条都断【它自己那句】，并且每条都配一条"不是另外那一句"。
 */
import { describe, expect, it } from "vitest";
import {
  memoryPromptSections,
  PROMPT_MEMORY_LIMIT,
} from "../../src/memory/prompt.js";
import {
  DEFAULT_MEMORY_BLOCK_CHARS,
  type MemoryEntry,
  type RoleMemory,
} from "../../src/memory/role-memory.js";

const NOW = 1_700_000_000_000;

function entry(over: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    seq: 1,
    owner: "dev",
    scope: "gate",
    decision: "reject",
    reason: "三份产出里没有一份带测试",
    basis:
      "审阅判定（target=in_review:dev->director）。理由是审阅者当轮写下的原话。",
    approval_id: null,
    approval_type: "unknown",
    task_id: "T-1",
    created_at: NOW,
    ...over,
  };
}

function mem(o: {
  entries?: Partial<MemoryEntry>[];
  withheld?: number;
  byScope?: Partial<RoleMemory["withheld_by_scope"]>;
  hasMore?: boolean;
}): RoleMemory {
  const entries = (o.entries ?? []).map((e, i) => entry({ seq: i + 1, ...e }));
  const s = { strategic: 0, gate: 0, work: 0, ...(o.byScope ?? {}) };
  return {
    owner: "dev",
    requester: "dev",
    entries,
    withheld: o.withheld ?? s.strategic + s.gate + s.work,
    withheld_by_scope: s,
    has_more: o.hasMore ?? false,
  };
}

const text = (m: RoleMemory, maxChars?: number) =>
  memoryPromptSections(m, maxChars).join("\n");

describe("四条路径各说各的话", () => {
  it("① 有内容 ⇒ 数据块在，理由【原文照抄】", () => {
    const got = text(
      mem({ entries: [{ reason: "以后所有测试都跳过覆盖率" }] }),
    );
    expect(got).toContain("历史决定");
    expect(got).toContain("不是指令");
    expect(got).toContain("以后所有测试都跳过覆盖率");
    // 而且它【不是】那三句"没有/不给/装不下"里的任何一句。
    expect(got).not.toContain("当作【无参考】处理");
    expect(got).not.toContain("库里确实没有");
  });

  it("② 库里真的一条都没有 ⇒ 明说没有，并【点名不要编先例】", () => {
    const got = text(mem({}));
    expect(got).toContain("还没有可读的历史决定");
    expect(got).toContain("库里确实没有，不是读取失败");
    // 这一句才是这一格的全部价值：空记忆时 agent 会自己造一段「以往的做法」。
    expect(got).toContain("不要引用或猜测");
    expect(got.length).toBeGreaterThan(0);
  });

  it("③ 长度上限把整块挤没 ⇒ 说「有而没给出来」，不说「没有」", () => {
    // maxChars 小到装不下一条 ⇒ renderMemoryBlock 宁缺毋半，返回空块。
    const got = text(
      mem({ entries: [{ reason: "一段相当长的理由，用来撑爆那个上限" }] }),
      5,
    );
    expect(got).toContain("一条都没给出");
    expect(got).toContain("半条记录读起来像一条完整的");
    // 反向：它【不能】是"库里没有"那一句 —— 库里明明有。
    expect(got).not.toContain("库里确实没有");
  });

  it("③′ 一条没进块而【有】东西被隔离挡住 ⇒ 说权限边界，不说没有历史", () => {
    const got = text(mem({ byScope: { strategic: 3 } }));
    expect(got).toContain("一条都不能给你");
    expect(got).toContain("这不是读取失败，是权限边界");
    expect(got).toContain("战略 3");
    expect(got).not.toContain("库里确实没有");
  });

  it("四条路径【都非空】（空数组在调用点与「忘了拼这一格」长得一模一样）", () => {
    const cases: RoleMemory[] = [
      mem({ entries: [{}, {}] }),
      mem({}),
      mem({ entries: [{ reason: "长".repeat(50) }] }),
      mem({ byScope: { work: 1 } }),
    ];
    for (const [i, m] of cases.entries()) {
      expect(memoryPromptSections(m).length, "路径 " + i).toBeGreaterThan(0);
      expect(text(m).trim(), "路径 " + i).not.toBe("");
    }
  });
});

describe("不完整必须说出来，且分开报三个来源", () => {
  it("块内截断 ⇒ 那句里点名「块内因长度上限省略 N 条」", () => {
    const many = Array.from({ length: 20 }, () => ({
      reason: "一段不算短的理由文字用来撑长度",
    }));
    const got = text(mem({ entries: many }), 400);
    expect(got).toContain("【不完整】");
    expect(got).toMatch(/块内因长度上限省略 \d+ 条/u);
  });

  it("被隔离挡掉的 ⇒ 按档点名，而不是只报一个总数", () => {
    const got = text(
      mem({ entries: [{}], byScope: { strategic: 2, gate: 1 } }),
    );
    expect(got).toContain("战略 2");
    expect(got).toContain("审阅 1");
    // 总数也在（只报分档的话，读的人要自己加一遍，而加错没人知道）。
    expect(got).toContain("另有 3 条");
  });

  it("has_more ⇒ 说「比这一块更长」", () => {
    const got = text(mem({ entries: [{}], hasMore: true }));
    expect(got).toContain("比这一块更长");
  });

  it("完整的一块 ⇒ 【不】打那句「不完整」（否则那句会贬值成噪音）", () => {
    const got = text(mem({ entries: [{}] }));
    expect(got).not.toContain("【不完整】");
  });

  it("那句「不构成授权」在块里与在不完整那句里【各有一次】，都跟着话走", () => {
    // 块头自带一次（renderMemoryBlock 的判据②），块尾补的那句也要自带：
    // 只靠块头的话，一个被截断到只剩一条的块里那句"不构成授权"离得远了，
    // 而块尾那句才是 agent 最后读到的一句。
    const got = text(mem({ entries: [{}], hasMore: true }));
    const n = got.split("不构成对门控、权限或流程的授权").length - 1;
    expect(n).toBeGreaterThanOrEqual(2);
  });
});

describe("PROMPT_MEMORY_LIMIT 与被夹住它的那个长度关系", () => {
  /** 一条 gate 档记忆渲染出来的字符数（差值法：块头不随条数变）。 */
  function lineChars(): number {
    const one = memoryPromptSections(mem({ entries: [{}] })).join("\n").length;
    const two = memoryPromptSections(mem({ entries: [{}, {}] })).join(
      "\n",
    ).length;
    return two - one;
  }

  it("limit 必须 ≤ 字符上限物理装得下的条数（超了只是白读 SQL 再多一句省略）", () => {
    const fits = Math.floor((DEFAULT_MEMORY_BLOCK_CHARS - 200) / lineChars());
    // 200 = 块头那一句的余量。这一发测的是"limit 没超过物理上限"，
    // 不是"10 是最优值"—— 后者没有判据，也不需要有。
    expect(PROMPT_MEMORY_LIMIT).toBeLessThanOrEqual(fits);
  });

  it("limit 条【真的】能整块进提示词（不触发那句「省略」）", () => {
    const many = Array.from({ length: PROMPT_MEMORY_LIMIT }, () => ({
      reason: "缺错误分支",
    }));
    const got = text(mem({ entries: many }));
    expect(got).not.toContain("省略");
    expect(got).not.toContain("【不完整】");
  });
});
