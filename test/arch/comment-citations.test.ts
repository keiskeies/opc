/**
 * 源码注释里的跨篇引用必须指向真实存在的东西 —— 见 comment-citations.ts 的文件头。
 *
 * 本节刻意把【坏引用】只放进字符串字面量，不放进注释：本守卫同样在扫这个文件，
 * 写进注释就是自己造一条真错。这也顺带证明了 AST 口径的有效性 ——
 * 字符串里那些假引用一条都没被当成引用。
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkCitations,
  citationsFromMarkdown,
  commentLines,
  extractCitations,
} from "./comment-citations.js";
import type { Row, World } from "./doc-coords.js";
import {
  decisionRows,
  hashProblems,
  headingSets,
  makeWorld,
  markdownRows,
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

// 决策目录之外的 markdown：入口 README、索引、评审说明、溯源、规格、计划。这些文件里的
// 跨篇引用此前没有任何机器核对过（实测 24 处限定引用与 9 个短哈希全靠人眼）。
// 判据与源码注释共用同一份 refsFromLine 与 checkCitations，只有【行来源】不同。
describe("决策目录之外的 markdown 里的跨篇引用", () => {
  const W = fakeWorld([DOC0003, DOC0005]);

  function md(lines: string[], file = "docs/INDEX.md") {
    const retracted: string[] = [];
    return {
      cites: citationsFromMarkdown([{ doc: file, lines }], retracted),
      retracted,
    };
  }

  it("限定形态的小节引用：存在则放行", () => {
    const { cites } = md(["见 0003 §6.1 的约束"]);
    expect(cites.length).toBe(1);
    expect(checkCitations(cites, W)).toEqual([]);
  });

  it("不存在的小节号变红", () => {
    expect(checkCitations(md(["见 0003 §99 的约束"]).cites, W).length).toBe(1);
  });

  it("不存在的条目号变红", () => {
    const { cites } = md(["见 0003 §7 第 9 条"]);
    expect(cites.length).toBe(1);
    expect(checkCitations(cites, W).length).toBe(1);
  });

  it("目标篇不存在变红", () => {
    const p = checkCitations(md(["见 0008 §3"]).cites, W);
    expect(p.length).toBe(1);
    expect(p[0]?.why).toContain("目标决策文档不存在");
  });

  it("裸形小节号不算引用：入口文档的省略写法不该变红", () => {
    // 索引里【见 §9.5】指的是另一篇，本篇没有 §9.5；按自引用判必假阳，
    // 而假阳守卫的结局是被关掉（0007 §4.1 记过这个代价）。
    expect(md(["另有第三项等你回答但不卡门禁，见 §9.5"]).cites).toEqual([]);
    // 下面两种是【已知漏判】，不是本守卫的能力；把它们钉成【不报】，改动形状时才会被发现。
    // 一、领属形：篇号与节号之间隔着一个“的”，SEC_RE 要求相邻，所以不进来（全仓 markdown 实测 1 处）。
    // 二、反引号路径形：计划里 10 处写成 反引号 decisions/0003-….md 反引号 空格 节号，同样不进来。
    // 放宽 SEC_RE 会同时改变决策文档守卫的口径（两边共用一份），那是另一轮的事，本轮不放。
    expect(md(["0006 的 §8.5 与 §10.5"]).cites).toEqual([]);
  });

  it("撤回行豁免：坏号不报，但必须可数", () => {
    const r = md(["【撤回】见 0003 §77 那句是错的，当时没查就写了"]);
    expect(r.cites).toEqual([]);
    expect(r.retracted.length).toBe(1);
    expect(r.retracted[0]).toContain("0003");
  });

  it("否定重述：说 0005 没有某节，就得真的没有", () => {
    const r = md(["实测 0005 §77 —— 0005 没有 §77。"]);
    expect(r.cites.length).toBe(1);
    // 后半句的节号是裸形，本守卫不收；这条引用被判定为否定，正是这句话的真实形状。
    expect(r.cites[0]?.negated).toBe(true);
    expect(checkCitations(r.cites, W)).toEqual([]);
    const grown = fakeWorld([
      DOC0003,
      { doc: "0005", lines: ["## 77. 现在存在了"] },
    ]);
    expect(checkCitations(r.cites, grown).length).toBe(1);
  });

  it("取材器本身有判别力：决策文档绝不能混进范围", () => {
    const rows = markdownRows(ROOT);
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(r.doc.startsWith("docs/decisions/")).toBe(false);
    }
    // git 输出的是仓库相对路径；拿绝对前缀去比会全数漏判 —— 本轮实测混进过 6 行决策文档。
    expect(rows.every((r: Row) => r.lines.length > 0)).toBe(true);
  });

  it("markdown 行的行号必须是文件里的真实行号", () => {
    // 注释路径早有同款用例；markdown 路径此前只数【抓到几条】，行号退一位照样全绿。
    const { cites } = md(["第一行", "第二行", "见 0003 §6"]);
    expect(cites.length).toBe(1);
    expect(cites[0]?.line).toBe(3);
    const r = md(["【撤回】见 0003 §77"]);
    expect(r.retracted.length).toBe(1);
    expect(r.retracted[0]).toContain(":1 ");
  });

  it("取材为空必须抛判据失效，不能读成【没有坏引用】", () => {
    // 只有决策文档的索引：范围谓词若写反，这里会拿到 0 行而静默通过（第 22 条）。
    const only = tempRepo(["docs/decisions/0009-only.md"]);
    const plain = tempRepo([]);
    try {
      expect(() => markdownRows(only)).toThrow(/判据失效/);
      expect(() => markdownRows(plain)).toThrow(/判据失效/);
    } finally {
      rmSync(only, { force: true, recursive: true });
      rmSync(plain, { force: true, recursive: true });
    }
  });

  it("取材顺序确定，报出来的缺陷才可复现", () => {
    const docs = markdownRows(ROOT).map((r: Row) => r.doc);
    expect(docs).toEqual([...docs].sort());
  });

  it("真实入口文档：引用与短哈希全部对得上", () => {
    const rows = markdownRows(ROOT);
    const retracted: string[] = [];
    const cites = citationsFromMarkdown(rows, retracted);
    expect(cites.length).toBeGreaterThanOrEqual(20);
    const w = world(decisionRows(), repoShortHashes());
    expect(checkCitations(cites, w)).toEqual([]);
    let bad = 0;
    for (const r of rows) bad += hashProblems(r.doc, r.lines, w.hashes).length;
    expect(bad).toBe(0);
    // 撤回豁免在真实语料里当前为 0；一旦有人写下撤回行，这个数字逼人回来重读那段。
    expect(retracted.length).toBe(0);
  });
});

// 临时 git 仓：只 add 指定相对路径不 commit，git ls-files 读索引就够。
function tempRepo(files: string[]): string {
  const base = mkdtempSync(join(tmpdir(), "opc-md-"));
  execFileSync("git", ["init", "-q"], { cwd: base });
  for (const f of files) {
    const p = join(base, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "# 标题" + NL);
    execFileSync("git", ["add", "--", f], { cwd: base });
  }
  return base;
}
