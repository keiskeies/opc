/**
 * 源码注释里的跨篇引用必须指向真实存在的东西 —— 见 comment-citations.ts 的文件头。
 *
 * 本节刻意把【坏引用】只放进字符串字面量，不放进注释：本守卫同样在扫这个文件，
 * 写进注释就是自己造一条真错。这也顺带证明了 AST 口径的有效性 ——
 * 字符串里那些假引用一条都没被当成引用。
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCitations,
  commentLines,
  extractCitations,
} from "./comment-citations.js";
import type { Row, World } from "./doc-coords.js";
import {
  decisionRows,
  headingSets,
  makeWorld,
  repoShortHashes,
  world,
} from "./doc-coords.js";
import { walkFiles } from "./harness-invariants.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const NL: string = String.fromCharCode(10);

/** 造一个只有两篇文档的世界：0003 有 §6 / §6.1 与 §7 的第 1、2 条；0005 只有 §8。 */
function fakeWorld(rows: readonly Row[]): World {
  return makeWorld(
    rows,
    headingSets(["## 1. 设计文档第一节"]),
    headingSets(["## 1. 计划第一节"]),
    new Set<string>(["abc1234"]),
  );
}

const DOC0003: Row = {
  doc: "0003",
  lines: [
    "## 6. 实现约束",
    "",
    "1. 无作用域时的行为必须显式决定",
    "2. 默认抛错更安全",
    "",
    "### 6.1 小节是存在的",
    "",
    "## 7. 后续事项",
    "",
    "1. **第一条**",
    "2. **第二条**",
  ],
};

const DOC0005: Row = { doc: "0005", lines: ["## 8. 判据"] };

function cites(code: string, file = "x/y.ts") {
  return extractCitations(file, code);
}

describe("源码注释里的跨篇引用指向真实存在的东西", () => {
  it("只从注释里取，不从字符串字面量里取", () => {
    const code = [
      "// 注释里的 0003 §6.1 是真引用",
      'const fixture = "0003 §77 是数据不是引用";',
      'const other = "0003 §7 第 99 条";',
    ].join(NL);
    const got = cites(code);
    expect(got.length).toBe(1);
    expect(got[0]?.num).toBe("6.1");
    expect(got[0]?.negated).toBe(false);
  });

  it("注释行号指向原文件的真实行，不是片段内的序号", () => {
    const code = [
      "const a = 1;",
      "const b = 2;",
      "/**",
      " * 见 0003 §6.1。",
      " */",
      "const c = 3;",
      "// 又是 0003 §6.1。",
    ].join(NL);
    const got = cites(code);
    expect(got.map((c) => c.line)).toEqual([4, 7]);
  });

  it("裸形 §N.M 不算跨篇引用：篇号限定才是判据", () => {
    const code = ["// 规格 §6.3 说了这个，另有 §99 与 §7 第 42 条。"].join(NL);
    expect(cites(code).length).toBe(0);
  });

  it("节号存在就放行，不存在就报", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const ok = cites(["// 见 0003 §6 与 0003 §6.1。"].join(NL));
    expect(ok.length).toBe(2);
    expect(checkCitations(ok, w)).toEqual([]);
    const bad = cites(["// 见 0003 §6.2。"].join(NL));
    const probs = checkCitations(bad, w);
    expect(probs.length).toBe(1);
    expect(probs[0]?.why).toContain("不存在");
  });

  it("§7 条目号按目标篇的清单判存在", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const ok = cites(["// 0003 §7 第 1、2 条都算。"].join(NL));
    expect(ok.length).toBe(2);
    expect(checkCitations(ok, w)).toEqual([]);
    const bad = cites(["// 0003 §7 第 3 条不存在。"].join(NL));
    expect(bad.length).toBe(1);
    expect(bad[0]?.kind).toBe("item");
    expect(checkCitations(bad, w).length).toBe(1);
  });

  it("目标篇号根本不存在时报错，而不是静默放行", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const got = cites(["// 见 0008 §3。"].join(NL));
    expect(got.length).toBe(1);
    const probs = checkCitations(got, w);
    expect(probs.length).toBe(1);
    expect(probs[0]?.why).toContain("目标决策文档不存在");
  });

  it("否定重述：目标确实不存在时放行", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const got = cites(["// 0005 §125 是假的 —— 0005 没有 §125。"].join(NL));
    expect(got.length).toBe(1);
    expect(got[0]?.negated).toBe(true);
    expect(checkCitations(got, w)).toEqual([]);
  });

  it("否定重述：目标后来真的存在了，那句话过期，必须变红", () => {
    const grown = fakeWorld([
      DOC0003,
      { doc: "0005", lines: ["## 125. 新增的一节"] },
    ]);
    const got = cites(["// 0005 §125 是假的 —— 0005 没有 §125。"].join(NL));
    expect(got[0]?.negated).toBe(true);
    const probs = checkCitations(got, grown);
    expect(probs.length).toBe(1);
    expect(probs[0]?.why).toContain("已过期");
  });

  it("否定的是别篇的同名节号时，本篇这条仍按普通引用判", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const got = cites(["// 见 0003 §77；另外 0005 没有 §77。"].join(NL));
    expect(got.length).toBe(1);
    // 子句里的否定词修饰的是另一篇，不许替本篇那条不存在的节号开脱。
    expect(got[0]?.negated).toBe(false);
    expect(checkCitations(got, w).length).toBe(1);
  });

  it("一条限定引用都没抓到就是仪器坏了", () => {
    const w = fakeWorld([DOC0003, DOC0005]);
    const probs = checkCitations([], w);
    expect(probs.length).toBe(1);
    expect(probs[0]?.why).toContain("空转");
  });

  it("commentLines 对空文件返回空，不至于抛", () => {
    expect(commentLines("")).toEqual([]);
    expect(cites("const a = 1;").length).toBe(0);
  });

  it("真实仓库：注释里的限定引用全部指向存在的东西", () => {
    const scopes: Array<[string, (name: string) => boolean]> = [
      [join(ROOT, "packages"), (n: string) => /\.[cm]?[jt]sx?$/.test(n)],
      [join(ROOT, "test"), (n: string) => /\.[cm]?[jt]sx?$/.test(n)],
      [join(ROOT, "docs", "review"), (n: string) => /\.[cm]?js$/.test(n)],
    ];
    const files: string[] = ["vitest.config.ts"];
    for (const [dir, re] of scopes) {
      if (!existsSync(dir)) {
        throw new Error(
          "判据失效：扫描范围 " + dir + " 不存在，不是【没有坏引用】",
        );
      }
      for (const p of walkFiles(dir, re)) {
        files.push(relative(ROOT, join(dir, p)).replace(/\\/g, "/"));
      }
    }
    const all = files.flatMap((rel: string) => {
      let text = "";
      try {
        text = readFileSync(join(ROOT, rel), "utf8");
      } catch {
        return [];
      }
      return extractCitations(rel, text);
    });
    // 下限而非精确数：扫描通路整个坏掉时这里先红，而不是下面那条【0 问题】假绿。
    expect(all.length).toBeGreaterThanOrEqual(40);
    expect(all.filter((c) => c.negated).length).toBeGreaterThanOrEqual(1);
    expect(
      checkCitations(all, world(decisionRows(), repoShortHashes())),
    ).toEqual([]);
  });
});
