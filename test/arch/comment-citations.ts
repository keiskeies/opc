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
 * 三条收窄，都是为了不造出一个会被关掉的守卫（0007 §4.1 记过这个代价）：
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
 * 判据不在这里复制一份：形状走 doc-coords.js 的 SEC_RE 与 ITEM_RE，存在性走
 * secExists 与 World，取材走同一套 decisionRows 与 world。复制的那份会漂移，
 * 0006 §7 第 55、56 条记的就是这个形状。
 */

import ts from "typescript";
import type { World } from "./doc-coords.js";
import { ITEM_RE, SEC_RE, secExists } from "./doc-coords.js";

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

/** 同子句内（到下一个 。；！？ 为止）是否把这条引用否定重述了。 */
export function negatedRestatement(
  tail: string,
  targetDoc: string,
  num: string,
): boolean {
  const cut = Math.max(
    tail.indexOf("。"),
    tail.indexOf("；"),
    tail.indexOf("！"),
    tail.indexOf("？"),
  );
  const clause = tail.slice(0, cut < 0 ? tail.length : cut);
  return (
    /(没有|不存在|并无|并非)/.test(clause) &&
    clause.includes(targetDoc) &&
    clause.includes(SEC + num)
  );
}

export function extractCitations(file: string, text: string): Citation[] {
  const out: Citation[] = [];
  for (const c of commentLines(text)) {
    for (const m of c.text.matchAll(SEC_RE)) {
      const target: string | undefined = m[1];
      const num: string | undefined = m[2];
      if (target === undefined || num === undefined) {
        continue;
      }
      const at: number = m.index ?? 0;
      out.push({
        file,
        line: c.line,
        targetDoc: target,
        num,
        kind: "sec",
        negated: negatedRestatement(
          c.text.slice(at + m[0].length),
          target,
          num,
        ),
      });
    }
    for (const m of c.text.matchAll(ITEM_RE)) {
      const target: string | undefined = m[1];
      const nums: string | undefined = m[2];
      if (target === undefined || nums === undefined) {
        continue;
      }
      const at: number = m.index ?? 0;
      for (const tok of nums.split(/[、,， \t]+/).filter(Boolean)) {
        out.push({
          file,
          line: c.line,
          targetDoc: target,
          num: tok,
          kind: "item",
          negated: negatedRestatement(
            c.text.slice(at + m[0].length),
            target,
            tok,
          ),
        });
      }
    }
  }
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
