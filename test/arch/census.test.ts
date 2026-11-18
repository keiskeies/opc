/**
 * census.ts 的守卫（O14 动作 3，round293）。
 *
 * ── 这一族【最坏的空转形状】是现成的，而且本仓量过 ──────────────────
 * 一条数模块的脚本坏起来不报「扫描失败」，只报「数出来的东西多/少了」。
 * dead-modules.ts 文件头记着它自己犯过的那一发：往已带 .ts 的 token 后又拼一次 .ts
 * ⇒ 闭包空转 ⇒ 83 个模块里 77 个被判死模块，而输出形状与「一切正常」逐字一样。
 * 所以本文件最重要的不是那几条合成用例，是【取材非空 + 反向对照】那一发：
 * 真仓库里一个明知有调用方的模块必须【不在】零 importer 名单里。
 * 解析器一旦退化成零条边，全仓都成孤儿，那一发当场红 —— 而不是给出一条更大的数。
 */
import { describe, expect, it } from "vitest";
import { census, censusOf, underEntries } from "./census.js";
import type { Module } from "./dead-modules.js";

const mod = (rel: string, text: string): Module => ({ rel, text });

describe("① 合成语料：入口排除这件事真的在起作用", () => {
  const mods = [
    mod("a.ts", 'import { b } from "./b.js";\nline2\n'),
    mod("b.ts", "export const b = 1;\n"),
    mod("solo.ts", "export const solo = 1;\n"),
  ];

  it("b 有 a 引它 ⇒ 不在零 importer 里；solo 与 a 没人引 ⇒ 在", () => {
    const c = censusOf(mods, new Set<string>());
    const rels = c.zeroImporter.map((r) => r.rel);
    expect(rels).toContain("solo.ts");
    expect(rels).not.toContain("b.ts");
    // a.ts 引别人但【没人引它】⇒ 它在这条口径里就是零 importer。
    // （第一版我把它断成「不在」—— 那读的是"它没被 import 别人"，
    //   而这条守卫数的方向是"谁 import 它"。方向搞反的断言会永远绿在错的地方。）
    expect(rels).toContain("a.ts");
  });

  it("⭐ 反向对照：标成入口才从「非入口」那一栏消失 —— 没标就在", () => {
    const asEntry = underEntries(censusOf(mods, new Set<string>(["solo.ts"])));
    expect(asEntry.rows.map((r) => r.rel)).not.toContain("solo.ts");
    // 同一份语料、同一个 solo.ts，只是【不叫它入口】⇒ 它必须回来。
    // 少了这一发，「排除入口」可以写成 filter(() => false) 而全绿。
    const notEntry = underEntries(censusOf(mods, new Set<string>()));
    expect(notEntry.rows.map((r) => r.rel)).toContain("solo.ts");
  });

  it("排除只作用于【零 importer 的那一栏】，不改模块数与总行数", () => {
    const a = censusOf(mods, new Set<string>());
    const b = censusOf(mods, new Set<string>(["solo.ts"]));
    expect(b.moduleCount).toBe(a.moduleCount);
    expect(b.srcLines).toBe(a.srcLines);
    expect(b.zeroImporter.length).toBe(a.zeroImporter.length);
  });

  it('行数口径钉死：split("\\n") 会把末尾换行算成一行 ⇒ 比 wc -l 多 1', () => {
    // ⚠ 第一版我断的是「三行文本 ⇒ 3，wc 给 2」，那是【错的算术】：
    //   "a\nb\nc\n".split("\n") = ["a","b","c",""] ⇒ 4，而 wc -l 数换行符 = 3。
    //   两边【不是同一个数】，我原先连错的方向都没算对。
    //   实测对照：harness/verifier.ts 这里 725，wc -l 给 724。
    //   ⇒ 抄别人报的行数之前先对齐口径，别假设「行数」只有一个定义。
    expect("a\nb\nc\n".split("\n").length).toBe(4);
    expect("a\nb\nc".split("\n").length).toBe(3);
    const c = censusOf([mod("x.ts", "a\nb\nc\n")], new Set<string>());
    expect(c.zeroImporter[0]?.lines).toBe(4);
  });
});

describe("② 真仓库：读数可信，且不是在空转", () => {
  const c = census();

  it("取材非空：这是一次真扫描，不是空数组", () => {
    expect(c.moduleCount).toBeGreaterThan(50);
    expect(c.srcLines).toBeGreaterThan(10_000);
  });

  it("⭐ 明知有调用方的模块【不在】零 importer 里 —— 解析器退化成立刻红", () => {
    // db/write-queue.ts 被 serve/* 与 engine/* 一堆文件 import。
    // 解析器若退化成零条边（dead-modules 文件头那一发的形状），它会进名单，
    // 而且【名单会膨胀到 85】而不是缩小 —— 所以这里判的是成员，不是数量。
    const rels = new Set(c.zeroImporter.map((r) => r.rel));
    expect(rels.has("db/write-queue.ts")).toBe(false);
    expect(rels.has("org/commit.ts")).toBe(false);
  });

  it("反向：本篇正文点名的那个零调用方模块，仍在名单里", () => {
    // harness/verifier.ts 是 O14 一整段的存在理由（有测试、零生产调用方）。
    // 它若从名单里消失，说明【要么它真被接上了 ⇒ 那条主张该改】，
    // 【要么取材/解析坏了 ⇒ 这条守卫在撒谎】。两种都值得红。
    expect(c.zeroImporter.some((r) => r.rel === "harness/verifier.ts")).toBe(
      true,
    );
  });

  it("「非入口」是「全量」的子集，且两条的差恰好是入口那几个", () => {
    const all = c.zeroImporter;
    const sub = underEntries(c);
    expect(sub.count).toBeLessThan(all.length);
    expect(sub.count).toBe(all.filter((r) => !r.isEntry).length);
    for (const r of sub.rows) expect(r.isEntry).toBe(false);
    expect(sub.lines).toBe(sub.rows.reduce((a, r) => a + r.lines, 0));
  });

  it("scripts 入口一个都没被判成零 importer 之外的东西（口径自洽）", () => {
    // 入口文件天然零 importer ⇒ 它们【应该】出现在全量那一栏里。
    // 若某天全量栏里一个入口都没有，说明 entryPoints 的取材变了（改 package.json 的形状），
    // 那 §1.1 那条「排除入口」的口径就没人执行了 —— 那种红值得看见。
    const entries = c.zeroImporter.filter((r) => r.isEntry);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("解析器自报零条悬空说明符（非 0 ⇒ 上面这批数建立在坏图上）", () => {
    expect(c.unresolved).toBe(0);
  });

  it("⭐ 悬空说明符【会】被自报出来 —— 上面那条 0 不是写死的", () => {
    // 少了这一发，unresolved 可以恒返回 0，而上一条【照样绿】。
    // 那一格要防的形状是：解析器少认一种写法 ⇒ 一条真边静悄悄消失 ⇒
    // 某模块被判成零 importer ⇒ 文档里多一条假死模块。
    // 今天这仓里没有悬空说明符，所以「0」本身分不出「真没有」与「没在数」。
    const bad = censusOf(
      [mod("a.ts", 'import { nope } from "./nope.js";\n')],
      new Set<string>(),
    );
    expect(bad.unresolved).toBe(1);
    // 反向对照：同一份语料把说明符指到真实存在的模块 ⇒ 0。
    const good = censusOf(
      [
        mod("a.ts", 'import { b } from "./b.js";\n'),
        mod("b.ts", "export const b = 1;\n"),
      ],
      new Set<string>(),
    );
    expect(good.unresolved).toBe(0);
  });

  it("测试文件那一栏非空，且根 test/ 桶与磁盘一致", () => {
    expect(c.testFiles["packages"] ?? 0).toBeGreaterThan(50);
    expect(c.testFiles["test"] ?? 0).toBeGreaterThan(20);
  });
});
