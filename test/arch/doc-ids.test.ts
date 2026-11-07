// 文档正文提到的决策编号，要么真实存在，要么在 docs/INDEX.md 里被明确预约。
//
// 这一类此前【零覆盖】，是实测出来的：往 0006 注入一条指向不存在编号（0009）的引用，
// doc-coords、doc-refs、decision-index 三条文档守卫全部恒绿。查过全仓：只有
// commit-msg-refs.ts 带决策编号正则，而它只作用于提交消息 —— 文档正文不在任何守卫射程内。
// 提交消息那一类在 0006 §7-37 补上了，文档正文这一类当时漏了。
//
// 判据不新造：提取编号、枚举现有编号、读预约号，三件事全部复用 commit-msg-refs.ts 已导出的
// 函数 —— 它们各自在那边已被 canary 钉住（含【路径里的编号不算引用】这条，很关键：
// 否则 INDEX 里的 0002-no-personal-wechat.md 这个路径会被当成一次引用）。
// 预约号只认 docs/INDEX.md 这一处权威出处，本文件【不带任何豁免表】—— 见 §7-37 修正后的设计。
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { docIds, existingIds, reservedIds } from "./commit-msg-refs.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECISIONS: string = join(ROOT, "docs", "decisions");
const INDEX_FILE: string = join(ROOT, "docs", "INDEX.md");

/** 找出提到【既不存在、也未被预约】编号的 文档>编号 清单。 */
function findMissing(
  docs: Map<string, string>,
  existing: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const [name, text] of docs) {
    // docIds 已内建【路径里的编号不算引用】：INDEX 写 0002-no-personal-wechat.md 不算一次引用。
    for (const id of docIds(text)) {
      if (existing.has(id)) continue;
      if (reserved.has(id)) continue;
      out.push(name + ">" + id);
    }
  }
  return out.sort();
}

/** 被扫描的文档：决策文档全体 + 索引本身（索引里也写编号，一并盯住）。 */
function repoDocs(): Map<string, string> {
  const m: Map<string, string> = new Map();
  for (const f of readdirSync(DECISIONS)
    .filter((x: string): boolean => x.endsWith(".md"))
    .sort()) {
    m.set(f, readFileSync(join(DECISIONS, f), "utf8"));
  }
  m.set("INDEX.md", readFileSync(INDEX_FILE, "utf8"));
  return m;
}

describe("文档正文提到的决策编号不指空号", () => {
  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    // 插入顺序【故意与期望输出相反】：否则判据不排序也能过，排序就成了没被测到的死代码。
    const docs: Map<string, string> = new Map([
      ["b.md", "见 0001 与 0098 两个号都不在允许集里。"],
      ["a.md", "见 0001 这个号存在，见 0099 这个号不存在。"],
    ]);
    const existing: Set<string> = new Set(["0001"]);
    const reserved: Set<string> = new Set(["0002"]);
    // 缺失项必须被点名，且按名字排序 —— 断言精确内容，不写 toBeNotEmpty 那种弱断言。
    expect(findMissing(docs, existing, reserved)).toEqual([
      "a.md>0099",
      "b.md>0098",
    ]);
    // 反向：全部允许时必须为空。它防【判据恒返回非空】让上面那条退化成永真。
    expect(
      findMissing(new Map([["c.md", "提到 0001"]]), existing, reserved),
    ).toEqual([]);
    // 预约号必须放行，否则文档里每一句【0002 被预约】的合法叙述都会假红。
    expect(
      findMissing(
        new Map([["d.md", "0002 已预约给 Task 4.6"]]),
        existing,
        reserved,
      ),
    ).toEqual([]);
  });

  it("真实文档：正文提到的每个编号要么存在、要么被 INDEX 预约", () => {
    const docs: Map<string, string> = repoDocs();
    // 输入规模自检：扫描悄悄退化成空集时上面那条会假绿（本轮回归验证学到的教训）。
    expect(docs.size).toBeGreaterThanOrEqual(7);
    const existing: Set<string> = new Set(existingIds(DECISIONS));
    const reserved: Set<string> = new Set(
      reservedIds(readFileSync(INDEX_FILE, "utf8")),
    );
    // 正对照：豁免通路必须是活的。它坏了读不到 0002，下面会红 —— 不许静默放行。
    expect(reserved.has("0002")).toBe(true);
    expect(existing.has("0007")).toBe(true);
    expect(findMissing(docs, existing, reserved)).toEqual([]);
  });
});
