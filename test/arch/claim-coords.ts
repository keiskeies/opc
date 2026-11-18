/**
 * 主张登记表里 `source.line` 的核对 —— 它此前**只是一次性脚本**，没人跑就不会红。
 *
 * ── 为什么这一格值得单独立一条守卫 ────────────────────────────────
 * `claims-registry.ts` 把「上次核对时刻」渲染进 O14 那张表，但 `renderMarkdown`
 * **不渲染 line**。⇒ 登记表层那条「表与渲染逐字一致」的守卫对坐标**是瞎的**：
 * 坐标可以整片漂走而 304 发全绿。round278 当天它就漂了 4 条（§5 插了一段 ⇒ r10–r13 全体 +35），
 * 抓住它的只有 `.workbuddy/round270-check-coords.mjs` —— 一个**要靠人想起来跑**的脚本。
 * 而本篇 O14 的整篇论点是「过期陈述的代价在于它看起来像现状」：
 * 一条**只有手动跑才生效**的核对，正是「过期陈述」的制造机。所以搬进 vitest。
 *
 * ── 为什么不重跑那个脚本，而是 import REGISTRY ────────────────────
 * 那个脚本用一条正则从 registry 的**源码文本**里抠 id / line / sentence，而它自己
 * 就在文件头记着三代坑：反引号读不到、单引号整条跳过、id 只认一位数于是 r10 被
 * **静默跳过**而输出与「十条全对」逐字一样。**用一条会静默漏读的正则去核对「漏读」，
 * 是拿问题本身当工具。** import 之后每一条都是对象，漏一条 = 数组短一格，是结构性的。
 *
 * ⚠ 口径与原脚本保持一致：比之前两边各剥掉 `code` 反引号与 **粗体**。
 *   不剥的话 registry 里手写的（不带反引号的）主张在带反引号的原文里恒 0 命中，
 *   于是「读不到」与「坐标丢了」在输出上长得一模一样 —— 那是原脚本踩过并写在它文件头的坑。
 */
import type { RegistryEntry } from "./claims-registry.js";

export const DESIGN_DOC = "docs/OPC-OS-功能优化设计.md";

/** 剥掉行内反引号与粗体标记：主张在文档里带样式、在 registry 里不带。 */
export function bare(s: string): string {
  return s.replace(/`|\*\*/gu, "");
}

/**
 * 锚点句在文档里的**全部**命中行（1 起）。
 *
 * 只取主张的第一行、且只取 30 个字符 —— 与脚本同口径。这不是偷懒：
 * 整句匹配会因为文档里一次换行重排就 0 命中，而「重排」恰恰是要容忍的那种改动。
 *
 * ⚠ 锚点为空 ⇒ 返回 []（而不是「全都算命中」）。空串 `includes` 恒真，
 *   那样一条空主张会把「坐标存在且对」判成对任何行都成立 —— 正是这条守卫要防的形状。
 */
export function locateAnchor(
  docLines: readonly string[],
  sentence: string,
): number[] {
  const needle = bare(String(sentence).split("\n")[0] ?? "").slice(0, 30);
  if (needle === "") return [];
  const out: number[] = [];
  for (let i = 0; i < docLines.length; i += 1) {
    if (bare(docLines[i] ?? "").includes(needle)) out.push(i + 1);
  }
  return out;
}

export interface CoordDrift {
  readonly id: string;
  readonly recorded: number;
  readonly located: readonly number[];
}

/**
 * 逐条判：登记的行号上，锚点句还在不在。
 *
 * 命中多处**不算**漂（同一句话在文档里出现两次是事实，不是缺陷），
 * 只要登记的那一格在命中集合里就算对。反过来，登记行没命中 ⇒ 漂，
 * 并把当前命中行一并交出去 —— 红话里没有「现在在哪」的话，修的人还得自己再数一遍。
 */
export function coordDrifts(
  entries: readonly RegistryEntry[],
  readDoc: (doc: string) => readonly string[],
): CoordDrift[] {
  const out: CoordDrift[] = [];
  for (const e of entries) {
    const located = locateAnchor(readDoc(e.source.doc), e.source.sentence);
    if (located.includes(e.source.line)) continue;
    out.push({ id: e.id, recorded: e.source.line, located });
  }
  return out;
}

/** 红话：一条一行，带上「现在在哪」。 */
export function formatDrifts(drifts: readonly CoordDrift[]): string[] {
  return drifts.map(
    (d) =>
      `${d.id} 的坐标 ${d.recorded} 行上读不到它自己的主张 —— 现在在 [${
        d.located.join(",") || "全文无命中"
      }]`,
  );
}
