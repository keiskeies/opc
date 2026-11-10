/**
 * 待决登记的 canary + 真仓库断言。
 *
 * 分工同 0006 §7-41：判据是纯模块，本文件喂合成输入，最后一条才读真仓库。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPending,
  findPendingSections,
  MIN_PENDING_SECTIONS,
  type PendingSection,
  parseRegistry,
  REGISTRY_SECTION,
  type RegistryEntry,
} from "./pending-decisions.js";

const SEC8 = { docId: "0006", section: "8", heading: "8. 需要 CEO 选一个字母" };
const SEC62 = { docId: "0006", section: "6.2", heading: "6.2 需要 CEO 认账" };
const SEC114 = { docId: "0005", section: "11.4", heading: "11.4 待 CEO 决策" };
const OK: PendingSection[] = [SEC8, SEC62, SEC114];
const LISTED: RegistryEntry[] = [
  { docId: "0006", section: "8" },
  { docId: "0006", section: "6.2" },
  { docId: "0005", section: "11.4" },
];

const reasons = (
  found: readonly PendingSection[],
  listed: readonly RegistryEntry[],
): string[] =>
  checkPending(found, listed)
    .map((p) => p.why)
    .sort();

describe("待决登记守卫的判据本体", () => {
  it("完好输入必须没有问题（反向：恒返回非空会在这里红）", () => {
    expect(reasons(OK, LISTED)).toEqual([]);
  });

  it("文档里新增了待决小节、入口没登记，必须报（本轮真实发生的腐烂）", () => {
    const got = reasons(OK, [
      { docId: "0006", section: "6.2" },
      { docId: "0005", section: "11.4" },
    ]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("没登记在入口处");
    expect(got[0]).toContain("0006 > 8");
  });

  it("入口登记了文档里不存在的节，必须报（腐烂：那一节被改写或删了）", () => {
    const got = reasons([SEC62, SEC114], LISTED);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("对应文档里没有这一节的标题");
  });

  it("节号写错也算【文档里不存在】，不能因为篇号对得上就放过", () => {
    const got = reasons(OK, [
      { docId: "0006", section: "7" },
      { docId: "0006", section: "6.2" },
      { docId: "0005", section: "11.4" },
    ]);
    expect(got.length).toBe(2);
    expect(got.join(" ")).toContain("0006 > 7");
    expect(got.join(" ")).toContain("0006 > 8");
  });

  it("两个集合同时为空是扫描失败，不是没问题（反向：恒返回空会在这里红）", () => {
    const got = reasons([], []);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("扫描通路");
  });

  it("只有登记表为空、文档确实有待决小节，必须逐条报而不是报一条总话", () => {
    const got = reasons(OK, []);
    expect(got.length).toBe(3);
  });

  it("登记表的顺序不影响判定（比对按 key，不按位置）", () => {
    expect(reasons(OK, [...LISTED].reverse())).toEqual([]);
  });

  it("同一节重复登记不得掩盖其它漏报", () => {
    const got = reasons(OK, [...LISTED, { docId: "0006", section: "8" }]);
    expect(got).toEqual([]);
  });
});

describe("扫描器与解析器", () => {
  it("findPendingSections 只认标题行里的 CEO，正文里的 CEO 不算", () => {
    const doc = [
      "## 5. 留给 CEO 的一项决定",
      "正文里也提到 CEO 说了别的事。",
      "### 11.4 待 CEO 决策（缺陷 A、B）",
      "### 6.2 与计划措辞的偏离（需要 CEO 认账）",
      "### 9. 这节标题不含那个词",
    ].join("\n");
    const got = findPendingSections("0006", doc)
      .map((s) => s.section)
      .sort();
    expect(got).toEqual(["11.4", "5", "6.2"]);
  });

  it("标题含【决策】但不含 CEO，一律不算待决（判据不许为了让谁通过而放宽）", () => {
    /* 实测：这三条是本篇自己的决策正文，收了就是误报；曾经因为放宽判据被收进来过。 */
    const doc = [
      "## 1. 决策",
      "## 5. 决策方式说明",
      "## 6. 本决策遗留的待办（进入 Task 0.3 时必须完成）",
      "### 5.1 决策依据先校正一处",
    ].join("\n");
    expect(findPendingSections("0001", doc)).toEqual([]);
  });

  it("两种节号写法都要认：带尾点和不带尾点（上一版漏扫带尾点那种）", () => {
    const withDot = findPendingSections("x", "## 5. 留给 CEO 的一项决定");
    const noDot = findPendingSections("x", "### 11.4 待 CEO 决策（缺陷 A、B）");
    expect(withDot.map((s) => s.section)).toEqual(["5"]);
    expect(noDot.map((s) => s.section)).toEqual(["11.4"]);
  });
  it("二级到四级标题都要认（各篇用的层级不一致）", () => {
    const got = ["## 5. 给 CEO", "### 6.2 给 CEO", "#### 7.1 给 CEO"].map(
      (l) => findPendingSections("x", l).length,
    );
    expect(got).toEqual([1, 1, 1]);
  });

  it("parseRegistry 只吃登记表小节里的条目，越过小节边界就算错", () => {
    const md = [
      "## 别的小节",
      "- **0001 §3** 这行在别的区里，不该被算进登记表",
      "## " + REGISTRY_SECTION + "（改实现前先看这里）",
      "- **0006 §8** 卡住 Phase 0 门禁",
      "- **0007 §5** 类型检查",
      "",
      "## 下一个小节",
      "- **0005 §99** 越过边界了，不该被算进去",
    ].join("\n");
    const got = parseRegistry(md, REGISTRY_SECTION).map(
      (e) => e.docId + " §" + e.section,
    );
    expect(got).toEqual(["0006 §8", "0007 §5"]);
  });

  it("小节标题必须是二级：三级标题或正文里的同名句子都不算登记表起点", () => {
    /* 实测过的刀：把 parseRegistry 里的【行首是 ## 】拆掉，只剩【这行包含小节名】，
       下面这个输入就会从正文那句【等待 CEO 决策】开始吃条目，把别的区里的号当成登记。
       原用例只有【越过小节边界】那一半，从没钉过【起点必须是二级标题】。 */
    const md = [
      "## 其它",
      "这里只是提到一下等待 CEO 决策，不是标题",
      "- **0008 §9** 在别的区，不该被算进来",
      "### 等待 CEO 决策",
      "- **0009 §9** 三级标题也不算",
      "",
      "## " + REGISTRY_SECTION + "（改实现前先看这里）",
      "- **0006 §8** 这才是登记表",
    ].join(String.fromCharCode(10));
    expect(parseRegistry(md, REGISTRY_SECTION).map((e) => e.docId)).toEqual([
      "0006",
    ]);
  });

  it("登记表小节不存在时返回空数组，由 checkPending 报漏报", () => {
    expect(
      parseRegistry(
        "## 决策记录\n- **0006 §8** 没有登记表小节",
        REGISTRY_SECTION,
      ),
    ).toEqual([]);
  });

  it("形状不对的行不进登记表（少星号、少节号都不算）", () => {
    const md = [
      "## " + REGISTRY_SECTION,
      "- **0006 8** 少节号",
      "- 0006 §8 少粗体",
      "  - **0006 §9** 缩进了也不算",
      "- **0006 §10** 唯一合法的一行",
    ].join("\n");
    expect(parseRegistry(md, REGISTRY_SECTION).length).toBe(1);
  });
});

describe("真仓库：入口与决策文档必须对得上", () => {
  const ROOT = join(process.cwd());
  const DECISIONS = join(ROOT, "docs", "decisions");
  const INDEX = join(ROOT, "docs", "INDEX.md");

  it("真仓库的待决小节与登记表双向一致（正向：守卫在真数据上不空转）", () => {
    const files = readdirSync(DECISIONS)
      .filter((f) => f.endsWith(".md"))
      .sort();
    const found: PendingSection[] = [];
    for (const f of files) {
      const docId = f.slice(0, 4);
      for (const s of findPendingSections(
        docId,
        readFileSync(join(DECISIONS, f), "utf8"),
      )) {
        found.push(s);
      }
    }
    const listed = parseRegistry(readFileSync(INDEX, "utf8"), REGISTRY_SECTION);
    expect(
      checkPending(found, listed)
        .map((p) => p.why)
        .join(" | "),
    ).toEqual("");
  });

  it("真仓库扫到的待决小节不得低于下限（防扫描通路坏掉，也防批量删标题字样消音）", () => {
    const files = readdirSync(DECISIONS).filter((f) => f.endsWith(".md"));
    let n = 0;
    for (const f of files) {
      n += findPendingSections(
        f.slice(0, 4),
        readFileSync(join(DECISIONS, f), "utf8"),
      ).length;
    }
    expect(n).toBeGreaterThanOrEqual(MIN_PENDING_SECTIONS);
  });

  it("入口文件必须真的有那个登记表小节（否则 parseRegistry 恒空、上一条例外全瞎）", () => {
    const md = readFileSync(INDEX, "utf8");
    expect(md.includes("## " + REGISTRY_SECTION)).toBe(true);
    expect(parseRegistry(md, REGISTRY_SECTION).length).toBeGreaterThanOrEqual(
      MIN_PENDING_SECTIONS,
    );
  });
});
