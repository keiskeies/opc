/**
 * 搜索观测（`src/search/observe.ts`）—— 【计划】Task 5.7 第 1 层的观测侧。
 *
 * ── 这一组用例的骨架只有一句话：三态不能被压成两态 ─────────────────
 * `counted 0` / `not_granted` / `silent` 三个值，最省事的写法是压成一个数字。
 * 压掉之后第 1 层仍然每天都在「判」，而它对适配器的沉默与 agent 的偷懒给出**同一句话**。
 * 所以每一发都要求**两个不同输入产生两个不同结论**（只喂一种形状的用例对这类 bug
 * 判别力为零 —— 0021 §1 那条口径在这里同样适用）。
 *
 * ── 反向对照放在最后一条 describe 而不是散在各处 ────────────────────
 * 「命中 0 次」这一类断言如果整个文件里没有任何一处命中过，那就等于
 * 判据根本没在跑（0013 §8 那一发「对目标缺陷分辨能力为零的用例」）。
 * 所以本文件既有「数得出 2」也有「数得出 0」，两条缺一条都算这一组没测到东西。
 */
import { describe, expect, it } from "vitest";
import {
  isSearchToolName,
  observeSearchCalls,
  toObservedSearches,
  type ToolSighting,
} from "../../src/search/observe.js";
import { searchGranted } from "../../src/search/mcp.js";
import { OBSERVATION_UNAVAILABLE } from "../../src/search/policy.js";

const SEARCH: ToolSighting = { tool: "WebSearch", stages: ["event_stream"] };
const READ: ToolSighting = { tool: "Read", stages: ["event_stream"] };
const GRANTED = ["Read", "WebSearch"];

describe("① 三态各自成立，且两两可分辨", () => {
  it("授权了搜索而一条工具调用都没报 ⇒ silent，而【不是】0", () => {
    const o = observeSearchCalls({ granted: GRANTED, sightings: [] });
    expect(o.kind).toBe("silent");
    // 这一发是整组里最贵的一格：silent 必须**不能**被读成 0。
    expect(toObservedSearches(o)).toBe(OBSERVATION_UNAVAILABLE);
    expect(toObservedSearches(o)).not.toBe(0);
  });

  it("报了别的工具而没报搜索 ⇒ counted 0（这是『确实没搜』，与上面那条相反）", () => {
    const o = observeSearchCalls({ granted: GRANTED, sightings: [READ] });
    expect(o.kind).toBe("counted");
    if (o.kind !== "counted") return;
    expect(o.searches).toBe(0);
    expect(toObservedSearches(o)).toBe(0);
  });

  it("报了搜索 ⇒ counted，数目就是命中数", () => {
    const o = observeSearchCalls({ granted: GRANTED, sightings: [READ, SEARCH, SEARCH] });
    expect(o.kind === "counted" && o.searches).toBe(2);
    expect(toObservedSearches(o)).toBe(2);
  });

  it("没授权搜索 ⇒ not_granted，而且【即使报了搜索工具也算没授权】", () => {
    // 反直觉的一格：sightings 里有 WebSearch 而 granted 里没有。
    // 那是适配器越权（Gateway 那边会另外记一次 unauthorized_attempt），
    // 而观测层这边说的是『这次调用不该有搜索』—— 两个结论不冲突，各答各的问题。
    const o = observeSearchCalls({ granted: ["Read"], sightings: [SEARCH] });
    expect(o.kind).toBe("not_granted");
    // 三态里只有 counted 会翻成数字，另外两态的修法完全不同，所以各自钉死。
    expect(toObservedSearches(o)).toBe(0);
  });

  it("⭐ 三态两两不同：同一份 sightings 换个 granted 就换态", () => {
    const a = observeSearchCalls({ granted: GRANTED, sightings: [READ] });
    const b = observeSearchCalls({ granted: ["Read"], sightings: [READ] });
    const c = observeSearchCalls({ granted: GRANTED, sightings: [] });
    expect([a.kind, b.kind, c.kind].sort()).toEqual(["counted", "not_granted", "silent"]);
    // 三态必须落到【两个不同的入参维度】上：granted 管资格、sightings 管通路。
    // 若两态由同一个入参决定，第四种组合（无资格 + 无通路）会被随便归到某一态里。
  });

  it("每一态都带得出处（why 非空），因为它要进审计", () => {
    for (const o of [
      observeSearchCalls({ granted: GRANTED, sightings: [] }),
      observeSearchCalls({ granted: GRANTED, sightings: [READ] }),
      observeSearchCalls({ granted: ["Read"], sightings: [] }),
    ]) {
      expect(o.why.trim().length, o.kind).toBeGreaterThan(20);
    }
  });
});

describe("② 名字口径与授予同源（两处各写一份就会漂）", () => {
  it("命中面与 searchGranted 逐一致：三种形状都算", () => {
    for (const name of ["WebSearch", "websearch", "mcp__search__web", "web_search"]) {
      expect(isSearchToolName(name), name).toBe(true);
      expect(isSearchToolName(name), name).toBe(searchGranted([name]));
    }
    for (const name of ["Read", "Edit", "Bash"]) {
      expect(isSearchToolName(name), name).toBe(false);
    }
  });

  it("已知的误命中也照单全收（它记在 mcp.ts 文件头，这里钉住别偷偷变准）", () => {
    // `research` 命中是一个**放宽**方向的已知代价。真要收紧，改的是 searchGranted 那一处
    // 并同时复核命中面；如果哪天有人只把这里改「准」，这一发红 —— 那正是他要一起改的信号。
    expect(isSearchToolName("research")).toBe(true);
    expect(isSearchToolName("market_research")).toBe(true);
  });
});

describe("③ 反向对照：这套仪器在已知有答案的输入上给得出答案", () => {
  it("阳性对照：silent 那一支的判据不是『sightings 恒空』", () => {
    // 若上面那发「silent」绿的成因是「取材写错了、永远拿到空数组」，
    // 那这里也应当给出 silent —— 所以它必须给 counted。
    expect(observeSearchCalls({ granted: GRANTED, sightings: [READ] }).kind).toBe("counted");
  });

  it("阳性对照：not_granted 那一支的判据不是『granted 恒不含搜索』", () => {
    expect(observeSearchCalls({ granted: GRANTED, sightings: [READ] }).kind).not.toBe("not_granted");
  });

  it("toObservedSearches 不会把 silent 折成 0（这是本模块唯一一条安全边界）", () => {
    const silent = observeSearchCalls({ granted: GRANTED, sightings: [] });
    const none = observeSearchCalls({ granted: GRANTED, sightings: [READ] });
    expect(toObservedSearches(silent)).not.toBe(toObservedSearches(none));
    // 而且两支各走各的门控分支：unresolved（判不了 ⇒ 吵）vs violated（没搜 ⇒ 打回）。
    // 这一句只是把两态的**后果不同**写在测试里，真正的分支在 policy.test.ts 那边钉。
  });
});
