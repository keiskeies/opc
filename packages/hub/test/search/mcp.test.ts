/**
 * `search/mcp.ts` 的用例。这一组很短，但它钉的是一条**放宽方向**的判据，
 * 而放宽方向的判据最容易被后人「顺手改准」而没人复核命中面。
 */
import { describe, expect, it } from "vitest";
import { hitsToRefs, searchGranted, type SearchHit } from "../../src/search/mcp.js";

describe("搜索工具的授予（子串口径，含它的误授予面）", () => {
  it("三种真实叫法都命中（精确名单会漏后两种）", () => {
    for (const name of ["WebSearch", "websearch", "mcp__search__web"]) {
      expect(searchGranted([name])).toBe(true);
    }
  });

  it("⭐ 误授予的那两个名字**钉住**：research / market_research", () => {
    // 这一条不是「希望它是 true」，是「它今天确实是 true，而这是代价」。
    // 钉住的理由：注释里写着代价而代码里没有对照的话，
    // 下一个人把正则改准时不会知道自己在改变什么（他会看到全绿）。
    expect(searchGranted(["research"])).toBe(true);
    expect(searchGranted(["market_research"])).toBe(true);
  });

  it("不相关的工具不授予（反向对照，否则『恒 true』也全绿）", () => {
    expect(searchGranted(["Read", "Bash", "write_file"])).toBe(false);
    expect(searchGranted([])).toBe(false);
    // 我曾以为 resumes 会误命中 —— 实测不会，那就把它钉成 false，
    // 免得下一轮又有人「按印象」把它当误授予写进注释（我自己刚错过一次）。
    expect(searchGranted(["resumes"])).toBe(false);
  });
});

describe("搜索结果 → claim 依据", () => {
  it("落的是**传输层给的那条 url**，不是标题或摘要", () => {
    const hits: SearchHit[] = [
      {
        title: "CVE-2026-0001",
        url: "https://advisory.example/1",
        snippet: "…",
        provider: "mcp:search",
        retrievedAtMs: 1,
      },
    ];
    expect(hitsToRefs(hits)).toEqual(["https://advisory.example/1"]);
  });
});
