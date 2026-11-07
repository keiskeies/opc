/**
 * 决策文档里【指向别处的坐标】必须指向真实存在的东西：节号、§7 的条目号、提交短哈希。
 *
 * 为什么要有这个文件：一条 §8.2 引用写下去，就等于断言【那一节存在】，而注释不参与编译、
 * 正文不是断言，tsc 与测试对它一律无感。这一族在本仓真出过事：0006 §4.1 记了一次编造的
 * 跨篇引用；0006 §7 第 18 条记了一次【声称已上报但那一节不存在】；2026-11-08 本轮又抓到一条
 * 0005 §125 —— 作者想把行号写成节号，而 0005 没有 §125（那句承诺实际在 §8，l.125 ∈ §8 已由
 * 本节机械核过）。同一天还抓到本守卫的前一版注释里两个错编号（把规矩记成 §7 第 25 条、
 * 把出处记成 0007 §4.2），说明【靠人记得去核实】这件事已经连续失败过多次，只能交给守卫。
 *
 * 取舍一：只认两种形状 —— §N / §N.M / §N.M.K，以及【000X §7 第 N 条】（N 可并列）。
 * 【第 N 条】不加 §7 前缀的一律不认：实测那种写法绝大多数指的是别的东西（Phase 0 出口标准
 * 第 2 条、biome.json 数组的第 2 条、甚至【第 5 条边】这种量词加名词）。把它们当引用会造出
 * 大量假阳，而假阳一多守卫就会被人关掉（0007 §4.1 记的正是这个代价）。
 *
 * 取舍二：本文内的 §引用，合法域是【本篇 ∪ 设计文档 ∪ 开发计划】。本仓正文确实会跨到设计
 * 文档去引需求节（实测 3 处），不收进来就是假阳。代价是【写错到设计文档里真实存在的节号】
 * 抓不到 —— 那种错只能靠人读，守卫不负责。
 *
 * 取舍三：git 不可用时报【判据失效】而不是跳过。0006 §7 第 22 条：判据坏掉和判据给出【没问题】
 * 必须能区分开，否则【我没测到】就伪装成【测过了】。
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NL: string = String.fromCharCode(10);
const SEC: string = String.fromCharCode(167);
const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECISIONS: string = join(ROOT, "docs", "decisions");
const SPEC: string = join(ROOT, "docs", "OPC-OS-设计文档.md");
const PLAN: string = join(
  ROOT,
  "docs",
  "superpowers",
  "plans",
  "2026-11-06-opc-os-development-plan.md",
);

type HeadingSets = { top: Set<number>; sub: Set<string> };

/**
 * 从标题行取节号。带点号的行【先】处理，绝不能再折进整数集 —— 上一版的判据把 ## 23.1 读成
 * 一级 §23，于是【一级共 23 节】这个数其实是 118 个二级的整数部分折叠出来的巧合。
 */
function headingSets(lines: string[]): HeadingSets {
  const top: Set<number> = new Set<number>();
  const sub: Set<string> = new Set<string>();
  for (const raw of lines) {
    const l: string = raw.trimEnd();
    const mSub: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+[.][0-9]+(?:[.][0-9]+)*)[ \t]/.exec(l);
    if (mSub) {
      sub.add(mSub[1]);
      continue;
    }
    const mTop: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+)[.](?![0-9])/.exec(l);
    if (mTop) top.add(Number(mTop[1]));
  }
  return { top, sub };
}

function secExists(sets: HeadingSets, num: string): boolean {
  return num.includes(".") ? sets.sub.has(num) : sets.top.has(Number(num));
}

/** 决策文档自己的 §7 清单：只数【## 7.】到下一个一级标题之间的 N. **粗体** 行。 */
function itemNumbers(lines: string[]): Set<number> {
  const got: Set<number> = new Set<number>();
  let in7: boolean = false;
  for (const raw of lines) {
    const l: string = raw.trimEnd();
    const mTop: RegExpExecArray | null =
      /^#{1,4}[ \t]+([0-9]+)[.](?![0-9])/.exec(l);
    if (mTop) {
      in7 = Number(mTop[1]) === 7;
      continue;
    }
    if (/^#{1,4}[ \t]/.test(l)) continue;
    if (!in7) continue;
    const mi: RegExpExecArray | null = /^([0-9]+)[.][ \t][*][*]/.exec(l);
    if (mi) got.add(Number(mi[1]));
  }
  return got;
}

type Ref = {
  doc: string;
  line: number;
  targetDoc: string;
  num: string;
  kind: "sec" | "item";
};
type Problem = { ref: string; why: string };

const SEC_RE = new RegExp(
  "(?:(000[1-9])\\s*)?" + SEC + "\\s*(\\d+(?:\\.\\d+)*)(?![\\s]*第)",
  "g",
);
const ITEM_RE = new RegExp(
  "(000[1-9])\\s*" + SEC + "\\s*7\\s*第\\s*([\\d、,，\\s]+)条",
  "g",
);

function extractRefs(doc: string, lines: string[]): Ref[] {
  const out: Ref[] = [];
  lines.forEach((l: string, i: number) => {
    for (const m of l.matchAll(SEC_RE)) {
      out.push({
        doc,
        line: i + 1,
        targetDoc: m[1] ?? doc,
        num: m[2],
        kind: "sec",
      });
    }
    for (const m of l.matchAll(ITEM_RE)) {
      for (const tok of m[2].split(/[、,， \t]+/).filter(Boolean)) {
        out.push({ doc, line: i + 1, targetDoc: m[1], num: tok, kind: "item" });
      }
    }
  });
  return out;
}

type World = {
  byDoc: Map<string, { sets: HeadingSets; items: Set<number> }>;
  spec: HeadingSets;
  plan: HeadingSets;
  hashes: Set<string>;
  lines: Map<string, string[]>;
};

function verify(refs: Ref[], w: World, retracted: string[]): Problem[] {
  const problems: Problem[] = [];
  for (const r of refs) {
    const shown: string =
      r.doc +
      " l." +
      r.line +
      " → " +
      (r.kind === "sec"
        ? r.targetDoc + " " + SEC + r.num
        : r.targetDoc + " §7 第 " + r.num + " 条");
    // 【撤回】行里的引用不报：0007 §4.1 要求已提交进决策文档的错误事实标【撤回】保留原文，
    // 不能静默删。守卫若把被撤回的引用当缺陷报，就会逼人手删撤回记录 —— 而【静默删掉错误事实】
    // 正是本守卫要防止的事。这条豁免可以被滥用，所以它必须【可数】：真数据 it 断言它的条数，
    // 数字一变就得重新去读那些撤回段，不许默默放过新增。
    const srcLine: string | undefined = (w.lines.get(r.doc) ?? [])[r.line - 1];
    // 判据是【整行以该标记开头】，不是【这一行含该标记】：实测四行含该标记又含坐标，只有 1 行真是撤回记录，
    // 另外 3 行只是【提到了这个词】（其中一行就是本守卫的说明文字本身）。按【含】判会把讨论豁免的那行
    // 也变成豁免区 —— 不需要任何人主动滥用，写一段解释豁免的文字就会悄悄扩大豁免范围。
    if (srcLine?.trimStart().startsWith("【撤回】") === true) {
      retracted.push(shown);
      continue;
    }
    if (r.kind === "item") {
      const t = w.byDoc.get(r.targetDoc);
      if (!t) {
        problems.push({ ref: shown, why: "目标决策文档不存在（写错篇号？）" });
        continue;
      }
      if (!t.items.has(Number(r.num)))
        problems.push({
          ref: shown,
          why: "那一篇的 §7 没有第 " + r.num + " 条",
        });
      continue;
    }
    if (r.targetDoc === r.doc) {
      const own = w.byDoc.get(r.doc);
      if (own && secExists(own.sets, r.num)) continue;
      if (secExists(w.spec, r.num) || secExists(w.plan, r.num)) continue;
      problems.push({
        ref: shown,
        why: "本篇没有这一节，设计文档与计划里也没有",
      });
      continue;
    }
    const t = w.byDoc.get(r.targetDoc);
    if (!t) {
      problems.push({ ref: shown, why: "目标决策文档不存在（写错篇号？）" });
      continue;
    }
    if (!secExists(t.sets, r.num))
      problems.push({ ref: shown, why: "那一节在目标篇里不存在" });
  }
  return problems;
}

/** 只数【恰好 7 位】的坐标 token，不管好坏：把【扫到了多少】与【其中多少坏】分开计数。 */
function hashTokenCount(lines: string[]): number {
  let n: number = 0;
  for (const l of lines)
    n += [...l.matchAll(/(?<![0-9a-f])[0-9a-f]{7}(?![0-9a-f])/g)].length;
  return n;
}

function hashProblems(
  doc: string,
  lines: string[],
  hashes: Set<string>,
): Problem[] {
  const problems: Problem[] = [];
  lines.forEach((l: string, i: number) => {
    for (const m of l.matchAll(/(?<![0-9a-f])[0-9a-f]{7}(?![0-9a-f])/g)) {
      // 不含 a-f 的七位纯数字按【普通数字】放过：实测本仓 55 个提交的 7 位短哈希里没有一个是全数字，
      // 决策文档里现存的 22 处引用也全是含字母的 ⇒ 这条过滤不漏真引用，却能挡住【共 1234567 行】这种假阳。
      if (!/[a-f]/.test(m[0])) continue;
      if (!hashes.has(m[0]))
        problems.push({
          ref: doc + " l." + (i + 1) + " → " + m[0],
          why: "仓库里没有这个提交（短哈希写错或已被改写）",
        });
    }
  });
  return problems;
}

type Row = { doc: string; lines: string[] };

function decisionRows(): Row[] {
  return readdirSync(DECISIONS)
    .filter((f: string) => f.endsWith(".md"))
    .sort()
    .map((f: string) => ({
      doc: f.slice(0, 4),
      lines: readFileSync(join(DECISIONS, f), "utf8").split(NL),
    }));
}

function readSets(path: string): HeadingSets {
  return headingSets(readFileSync(path, "utf8").split(NL));
}

function repoShortHashes(): Set<string> {
  const out: string = execFileSync("git", ["rev-list", "--all"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const full: string[] = out
    .split(NL)
    .filter((l: string) => /^[0-9a-f]{40}$/.test(l.trim()))
    .map((l: string) => l.trim());
  if (full.length < 5)
    throw new Error(
      "判据失效：git rev-list 只拿到 " +
        full.length +
        " 个提交，不是【没有坏引用】",
    );
  return new Set<string>(full.map((h: string) => h.slice(0, 7)));
}

function world(rows: Row[], hashes: Set<string>): World {
  const byDoc: Map<string, { sets: HeadingSets; items: Set<number> }> =
    new Map();
  for (const r of rows)
    byDoc.set(r.doc, {
      sets: headingSets(r.lines),
      items: itemNumbers(r.lines),
    });
  const lines: Map<string, string[]> = new Map<string, string[]>();
  for (const r of rows) lines.set(r.doc, r.lines);
  return { byDoc, spec: readSets(SPEC), plan: readSets(PLAN), hashes, lines };
}

describe("决策文档里的坐标（节号 / §7 条目号 / 短哈希）指向真实存在的东西", () => {
  it("判据本身有判别力（否则本节是恒绿装饰）", () => {
    // 反向样例必须【真能失败】：只给二级标题时一级集必须为空，否则 ## 23.1 会被折成 §23。
    const onlySub: HeadingSets = headingSets([
      "## 23.1 阶段划分",
      "### 4.1.1 决策空间",
    ]);
    expect(onlySub.top.size).toBe(0);
    expect(secExists(onlySub, "23.1")).toBe(true);
    expect(secExists(onlySub, "23")).toBe(false);
    const mixed: HeadingSets = headingSets([
      "# 1. 定位",
      "## 1.1 子",
      "## 7. 失误",
      "### 4.2.1 孙",
    ]);
    expect(secExists(mixed, "7")).toBe(true);
    expect(secExists(mixed, "4.2.1")).toBe(true);
    expect(secExists(mixed, "1.9")).toBe(false);
    // §7 条目：只数 ## 7. 到下一个一级标题之间的粗体清单行
    const items: Set<number> = itemNumbers([
      "## 7. 失误",
      "1. **甲**",
      "2. **乙**",
      "## 8. 完",
      "3. **不该算**",
    ]);
    expect([...items].sort((a, b) => a - b)).toEqual([1, 2]);
    // 提取与判定：目标篇、本篇、以及不存在三种情形各来一条
    const rows: Row[] = [
      { doc: "0006", lines: ["## 7. 失误", "1. **甲**"] },
      {
        doc: "0007",
        lines: ["## 4. 甲", "### 4.1 乙", "## 7. 失误", "5. **丙**"],
      },
    ];
    // canaryLines 既是被扫描的正文，也是 World.lines：行号必须对得上，否则撤回豁免测不到。
    const canaryLines: string[] = [
      SEC + "4.1 存在",
      SEC + "4.9 不存在",
      "0006 " + SEC + "4.9 篇在但节不在（跨篇分支）",
      "0006 " + SEC + "7 第 1 条 存在",
      "0006 " + SEC + "7 第 99 条 不存在",
      "0008 " + SEC + "1 目标篇根本不存在",
      SEC + "9 本篇没有，但设计文档有",
      "【撤回】本节初稿曾写 0008 " + SEC + "5.2 云云",
    ];
    const w: World = {
      byDoc: world(rows, new Set<string>()).byDoc,
      spec: headingSets(["# 9. 设计节"]),
      plan: headingSets([]),
      hashes: new Set<string>(["abc1234"]),
      lines: new Map<string, string[]>([["0007", canaryLines]]),
    };
    const refs: Ref[] = extractRefs("0007", canaryLines);
    const retracted: string[] = [];
    const found: string[] = verify(refs, w, retracted).map(
      (p: Problem) => p.why,
    );
    // 8 = 六个 §引用 + 两个 §7 条目 token（§7 第 N 条 只由 ITEM_RE 计一次，不双计）
    expect(refs.length).toBe(8);
    expect(found.length).toBe(4);
    // 撤回豁免必须真的咬住一条，否则它是装饰
    expect(retracted.length).toBe(1);
    expect(retracted[0].endsWith("0008 " + SEC + "5.2")).toBe(true);
    expect(
      found.some((s: string) => s.includes("那一节在目标篇里不存在")),
    ).toBe(true);
    expect(found.some((s: string) => s.includes("§7 没有第 99 条"))).toBe(true);
    expect(found.some((s: string) => s.includes("目标决策文档不存在"))).toBe(
      true,
    );
    // 短哈希一条样例覆盖四个边界：合法的哈希不报；坏哈希报；7 位纯数字是普通数字不报；
    // 8 位以上不是【恰好 7 位】也不报（实测文档里那种 32 位 interrupt id 就是靠这条不受伤）。
    const hp: Problem[] = hashProblems(
      "0006",
      ["提交 abc1234 与 deadbee 与 1234567 与 a1b2c3d4"],
      w.hashes,
    );
    expect(hp.length).toBe(1);
    expect(hp[0].ref.endsWith("deadbee")).toBe(true);
  });

  it("全部坐标引用与设计文档、计划、仓库提交对得上", () => {
    const rows: Row[] = decisionRows();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const w: World = world(rows, repoShortHashes());
    // 装配自检：权威集必须非空，否则【没数到东西】会伪装成【全对】（§7 第 21、22 条）
    expect(w.spec.top.size).toBeGreaterThanOrEqual(20);
    expect(secExists(w.spec, "23.1")).toBe(true);
    const own0006 = w.byDoc.get("0006");
    expect(own0006).toBeDefined();
    expect(own0006?.items.size ?? -1).toBeGreaterThanOrEqual(28);
    expect([...w.hashes].length).toBeGreaterThanOrEqual(50);
    const refs: Ref[] = [];
    const hashProbs: Problem[] = [];
    const retracted: string[] = [];
    for (const r of rows) {
      refs.push(...extractRefs(r.doc, r.lines));
      hashProbs.push(...hashProblems(r.doc, r.lines, w.hashes));
    }
    // 引用总数必须落在一个可解释的量级：真少到接近 0，说明提取器坏了而不是文档变干净了
    expect(refs.length).toBeGreaterThanOrEqual(100);
    // 覆盖计数：真扫到了坐标才允许说【没有坏引用】—— 否则【提取器坏了】会伪装成【文档很干净】。
    // 注意坏引用数本来就是 0（本轮的全部真缺陷都已修掉），它【不该】被断言大于 0。
    let tokens: number = 0;
    for (const r of rows) tokens += hashTokenCount(r.lines);
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(verify(refs, w, retracted)).toEqual([]);
    expect(hashProbs).toEqual([]);
    // 豁免条数钉死：实测 2 条，都在 0006 那一行以【撤回】开头的记录里（正是被撤回的错误引用本身，
    // 按 0007 §4.1 必须保留原文）。用【精确等号】是故意的 —— 数字一变，就是有人新增了撤回段，
    // 必须去读一遍那些段落再改这个数字，不许默默放过。注释里说【要断言】而断言没落地，
    // 本身就是 0007 §4.1 要消灭的东西：上一版就在这里漏了断言。
    expect(retracted.length).toBe(2);
  });
});
