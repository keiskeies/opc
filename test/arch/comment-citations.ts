/**
 * 源码注释里的【跨篇坐标引用】必须指向真实存在的东西。
 *
 * 为什么要有这个文件：0006 §7 第 60 条量出现存的引用守卫只遍历 docs/decisions，
 * 不碰任何 .ts。往 test/arch 新加一个文件、里面写一个不存在的小节号或条目号，
 * 整套守卫一声不吭 —— 也就是说【守卫自己写在源码注释里的引用】无人核对。
 * 本轮把范围从 docs 扩到 packages 与 test 的注释，当场抓到两条真错：
 * recorder.ts 与 saver.contract.test.ts 都往 0003 §6 下面挂了一个小数点小编号，
 * 而那一节是五条有序列表、压根没有小数点编号；0003 自己引那里写的是【§6 第 2 项】。
 *
 * 下面的每一条收窄，都是为了不造出一个会被关掉的守卫（0007 §4.1 记过这个代价）：
 * 一、只看注释，且用 AST 而不是扫全文。saver.contract.test.ts 的 fixture 里
 * 存着一串【看着像引用】的编号数据，doc-refs.test.ts 里存着 it.skip 调用的
 * 字面量 —— 扫全文会把数据当引用。这与 0006 §7 第 60 条是同一个理由。
 * 二、只认【带篇号限定】的形状：000X §N.M 与 000X §7 第 N 条。裸形 §N.M 在注释
 * 里成百上千，几乎全指设计文档或别处，收进来全是假阳。
 * 三、注释里若把一条引用【否定重述】—— 同一子句后面出现 没有/不存在/并无/并非，
 * 且重述了同一个篇号与节号 —— 那就反过来判：目标必须确实不存在。
 * doc-coords.test.ts 文件头记的就是【0005 §125 —— 0005 没有 §125】，那是句真话；
 * 谁哪天给 0005 补上 §125，这句话过期，本守卫当场变红，而不是放它过去。
 *
 * 四、markdown 行来源与注释行来源共用同一份形状判据，因此同样只认【相邻限定】形状。实测两种写法
 * 落在范围外，方向是漏判而不是假阳：篇号与节号之间隔一个【的】的领属形，以及反引号包住 decisions
 * 路径再接节号的写法（计划里成片）。放宽 SEC_RE 会同时改掉决策文档守卫的口径 —— 两边共用一份，
 * 所以本轮不放，只把这两种形状钉成用例，改动时会被发现。
 *
 * 判据不在这里复制一份：形状走 doc-coords.js 的 SEC_RE 与 ITEM_RE，存在性走
 * secExists 与 World，取材走同一套 decisionRows、markdownRows 与 world。复制的那份会漂移，
 * 0006 §7 第 55、56 条记的就是这个形状。
 *
 * 未闭合口径一条：markdown 行来源不判【形状歧义】（同一节号在本篇与设计文档里都有时报谁），
 * 决策文档那条路判。入口文档不是任何一篇的本篇，这条判据在那里无从定义。
 */

import ts from "typescript";
import type { Row, World } from "./doc-coords.js";
import { ITEM_RE, isRetracted, SEC_RE, secExists } from "./doc-coords.js";

const SEC: string = String.fromCharCode(167);
const NL: string = String.fromCharCode(10);

export type Citation = {
  file: string;
  line: number;
  targetDoc: string;
  num: string;
  kind: "sec" | "item";
  negated: boolean;
};

export type CitProblem = { why: string };

/**
 * 取注释片段，按行拆开，每行带原文件行号。
 * 用 AST 的 trivia 而不是自己找注释边界 —— 后者会把字符串里的斜杠星组合当作边界。
 */
export function commentLines(
  text: string,
): Array<{ line: number; text: string }> {
  const sf = ts.createSourceFile("c.ts", text, ts.ScriptTarget.Latest, true);
  const spans = new Map<number, number>();
  const add = (a: readonly ts.CommentRange[] | undefined): void => {
    if (a === undefined) {
      return;
    }

    for (const c of a) {
      spans.set(c.pos, c.end);
    }
  };
  const walk = (n: ts.Node): void => {
    add(ts.getLeadingCommentRanges(text, n.getFullStart()));
    add(ts.getTrailingCommentRanges(text, n.getEnd()));
    n.forEachChild(walk);
  };
  walk(sf);
  const out: Array<{ line: number; text: string }> = [];
  for (const [pos, end] of spans) {
    const startLine = text.slice(0, pos).split(NL).length;
    const parts = text.slice(pos + 2, end).split(NL);
    for (let k = 0; k < parts.length; k++) {
      const t = String(parts[k])
        .replace(/^\s*[*]?\s?/, "")
        .trim();
      if (t.length > 0) {
        out.push({ line: startLine + k, text: t });
      }
    }
  }
  return out;
}

/**
 * 同子句内（到下一个 。；！？ 为止）是否把这条引用否定重述了。
 *
 * ⚠ 这里有过一个【判据自身】的假阳，形状与它在找的东西一模一样 ——
 * 一句话被读成了另一句话的意思。原来的切法是
 * `Math.max(tail.indexOf("。"), tail.indexOf("；"), …)`，
 * 而 Math.max 取的是【最后一个】终止符，不是【第一个】——
 * 与本函数文件头那句「到下一个 。；！？ 为止」**正好相反**。
 * 后果在【一行一条】的 docs/INDEX.md 上必然出现：那种行有 4000+ 字符，
 * 于是「子句」= 从引用一路到行尾附近，任何一处无关的否定词都会被算到这条引用头上。
 * 实测现场：`0025 §3` 之后第 436 个字符有一句「只有 `catch` 没有 `finally`」，
 * 于是守卫报「0025 §3 这句说不存在，可它现在存在了 —— 描述已过期」，
 * 而那一句讲的是 `boot` 的 try，与 0025 §3 是否存在毫无关系。
 *
 * 改法是回到【第一个】终止符。本仓文档上的影响当场量过：
 * 命中从 2 条变 0 条，**少的两条都是假阳**（另一条是 INDEX 里 `0021 §9`
 * 撞上同一段里另一句「不存在的降级路」），**一条真判定都没丢**。
 *
 * 收紧会不会漏报？会漏的那种写法是「引用与否定词之间跨了一句句号」，
 * 而那种句子本身已经不是一个断言（人在两句话里说两件事），
 * 守卫本来就没有权利把它读成一个「说不存在」的断言 ——
 * 那正是本函数存在的理由（区分「他说这里没有」与「他说别处没有」）要求的方向。
 */
export function negatedRestatement(
  tail: string,
  targetDoc: string,
  num: string,
): boolean {
  const stops = [
    tail.indexOf("。"),
    tail.indexOf("；"),
    tail.indexOf("！"),
    tail.indexOf("？"),
  ].filter((i: number) => i >= 0);
  const cut = stops.length > 0 ? Math.min(...stops) : -1;
  const clause = tail.slice(0, cut < 0 ? tail.length : cut);
  return (
    /(没有|不存在|并无|并非)/.test(clause) &&
    clause.includes(targetDoc) &&
    clause.includes(SEC + num)
  );
}

/**
 * 单行里的【带篇号限定】引用。篇号组是必需组，所以裸形小节号与裸形条目号根本不进来 ——
 * 入口文档里裸形 §N.M 是省略写法（见 §9.5 其实指另一篇），收进来必假阳。
 * 抽成单行函数是为了两个行来源共用同一份判据：一个是下面的 AST 注释，一个是 markdown 正文行。
 */
export function refsFromLine(
  file: string,
  line: number,
  text: string,
): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(SEC_RE)) {
    const target: string | undefined = m[1];
    const num: string | undefined = m[2];
    if (target === undefined || num === undefined) {
      continue;
    }
    const at: number = m.index ?? 0;
    out.push({
      file,
      line,
      targetDoc: target,
      num,
      kind: "sec",
      negated: negatedRestatement(text.slice(at + m[0].length), target, num),
    });
  }
  for (const m of text.matchAll(ITEM_RE)) {
    const target: string | undefined = m[1];
    const nums: string | undefined = m[2];
    if (target === undefined || nums === undefined) {
      continue;
    }
    const at: number = m.index ?? 0;
    for (const tok of nums.split(/[、,， \t]+/).filter(Boolean)) {
      out.push({
        file,
        line,
        targetDoc: target,
        num: tok,
        kind: "item",
        negated: negatedRestatement(text.slice(at + m[0].length), target, tok),
      });
    }
  }
  return out;
}

export function extractCitations(file: string, text: string): Citation[] {
  const out: Citation[] = [];
  for (const c of commentLines(text)) {
    for (const r of refsFromLine(file, c.line, c.text)) {
      out.push(r);
    }
  }
  return out;
}

/**
 * 第二个行来源：markdown 正文。决策文档之外的每一篇（入口 README、索引、评审说明、
 * 溯源、规格、计划）里写下的跨篇坐标，此前没有任何机器核对过 —— 实测 24 处限定引用
 * 全靠人眼。判据不另起一份：形状、存在性、否定重述全走上面那条唯一路径。
 */
export function citationsFromMarkdown(
  rows: readonly Row[],
  retracted: string[],
): Citation[] {
  const out: Citation[] = [];
  rows.forEach((r: Row) => {
    r.lines.forEach((l: string, i: number) => {
      for (const c of refsFromLine(r.doc, i + 1, l)) {
        // 豁免与决策文档同一份判据；被豁免的引用【可数】，不静默吞掉。
        if (isRetracted(l)) {
          retracted.push(describe(c));
          continue;
        }
        out.push(c);
      }
    });
  });
  return out;
}

function describe(c: Citation): string {
  return (
    c.file +
    ":" +
    c.line +
    " → " +
    c.targetDoc +
    (c.kind === "item" ? " §7 第 " + c.num + " 条" : " " + SEC + c.num)
  );
}

export function checkCitations(
  cites: readonly Citation[],
  w: World,
): CitProblem[] {
  if (cites.length === 0) {
    return [{ why: "一条限定引用都没抓到，注释扫描在空转" }];
  }
  const problems: CitProblem[] = [];
  for (const c of cites) {
    const t = w.byDoc.get(c.targetDoc);
    const exists =
      t !== undefined &&
      (c.kind === "item"
        ? t.items.has(Number(c.num))
        : secExists(t.sets, c.num));
    if (c.negated) {
      if (exists) {
        problems.push({
          why: describe(c) + " 这句说不存在，可它现在存在了 —— 描述已过期",
        });
      }
      continue;
    }
    if (t === undefined) {
      problems.push({ why: describe(c) + " 目标决策文档不存在（写错篇号？）" });
      continue;
    }
    if (!exists) {
      problems.push({
        why:
          describe(c) +
          " 在目标篇里不存在（引用写错，或那一节【那一条】已被改名或删掉）",
      });
    }
  }
  return problems;
}
