/**
 * 跳过清单守卫：只有纯函数，故单独成模块（先例见 index-diff.ts、test-inventory.ts）。
 *
 * 触发这条守卫的真实缺陷（实测）：把一个真 it 改成 it.skip，标题一字未动，
 * 全套仍然【退出码 0】—— passed 少一条、pending 多一条，没有任何东西报警。
 * 刚装的 requireAssertions 也接不住：被 skip 的用例根本不执行，体内写不写断言
 * 都无从谈起。见 0006 §7 第 60 条。
 *
 * 为什么用 AST 而不是搜文本：test/arch/doc-refs.test.ts 里存着一条把
 * it.skip(title, fn) 当【被引用原文】的字符串字面量，搜文本会把那条数据读成
 * 跳过，于是守卫要么误报、要么逼着人加豁免。
 *
 * 判据是【双向】的：名单外的跳过要报，名单内却不再跳过的也要报 ——
 * 只查前者的话，名单会跟着代码一起过期而没人发现（§7 第 57 条同一族）。
 *
 * 名单内文件的放行条件是【活着】的计数，不是【文件里有 afterAll 这四个字】：
 * 实测过一把刀——把带计数的那个 afterAll( 改成 const _unused = (，该文件另有一处
 * 无关的 afterAll 仍在，全量 328 条退出码 0。所以三条缺一不可：顶层 let 数字、
 * 真的自增过、断言挂在 afterAll 的子树里。
 *
 * 射程边界：把 it 改名后再调的包装（如 itSqlite 内部按条件走 it.skip）扫不到，
 * 由上面那条计数要求间接兜住。不假装全覆盖。
 */

import ts from "typescript";

const LFCHAR = String.fromCharCode(10);

/** 允许出现跳过写法的文件；名单内文件必须自带活着的运行计数。 */
export const ALLOW_SKIP_FILES: readonly string[] = [
  "packages/hub/test/checkpoint/saver.contract.test.ts",
];

export type SkipForm = { path: string; line: number; form: string };

/** 不叫 PendingProblem：pending-decisions.ts 已占了这个名字，两者会被同批测试同时 import。 */
export type SkipProblem = { why: string };

/** 挂在这些名字上的 skip/todo/only 写法都要认。 */
const TEST_IDS = new Set<string>([
  "it",
  "test",
  "describe",
  "suite",
  "context",
]);

/**
 * 这三个是【整体即跳过】的裸调用名：xit("标题", fn) 没有点号，落不进属性判据。
 * 第一版把它们混在 TEST_IDS 里，于是成了永远命中不了的死条目——名单看着严，
 * 其实整类写法都没扫。分成两个集合是为了让【属性写法】与【裸调用写法】各自可测。
 */
const SKIP_CALLED_IDS = new Set<string>(["xit", "xtest", "xdescribe"]);

/** 属性名去掉 If 后缀后落在这里的，都意味着【某些用例不会被执行】。 */
const SKIP_PROPS = new Set<string>(["skip", "todo", "only", "skipIf", "runIf"]);

function stripIf(name: string): string {
  if (name.length > 2 && name.lastIndexOf("If") === name.length - 2) {
    return name.slice(0, name.length - 2);
  }
  return name;
}

type Marked = { line: number; label: string };

function collect(
  sf: ts.SourceFile,
  isMarked: (n: ts.CallExpression) => string | null,
): Marked[] {
  const hits: Marked[] = [];
  const lineOf = (pos: number): number =>
    sf.getLineAndCharacterOfPosition(pos).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const label = isMarked(n);
      if (label !== null) {
        hits.push({ line: lineOf(n.getStart()), label: label });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/** 扫出文件里所有【跳过相关】的调用写法，带行号与写法名。 */
export function findSkipForms(path: string, text: string): SkipForm[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const marked = (n: ts.CallExpression): string | null => {
    if (
      ts.isIdentifier(n.expression) &&
      SKIP_CALLED_IDS.has(n.expression.text)
    ) {
      return n.expression.text;
    }
    if (!ts.isPropertyAccessExpression(n.expression)) {
      return null;
    }
    const target = n.expression.expression;
    if (!(ts.isIdentifier(target) && TEST_IDS.has(target.text))) {
      return null;
    }
    const prop = n.expression.name.text;
    if (!SKIP_PROPS.has(stripIf(prop))) {
      return null;
    }
    return target.text + "." + prop;
  };
  return collect(sf, marked).map((m: Marked): SkipForm => {
    return { path: path, line: m.line, form: m.label };
  });
}

export type CounterInfo = {
  name: string;
  incremented: number;
  assertedInAfterAll: boolean;
};

/**
 * 找出文件里的【运行计数】候选：顶层 let X = 数字，并报告它有没有被自增、
 * 有没有出现在某个 afterAll 的调用子树里。
 *
 * 自增两种写法都认（X += 1 与 X++）；前后缀一元在 TS 的 AST 上属性名不同
 * —— 前缀是 operator，后缀才是 operatorToken，写成一样的会在运行期炸。
 */
export function findCounters(text: string): CounterInfo[] {
  const sf = ts.createSourceFile(
    "probe.ts",
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Map<string, CounterInfo>();
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) {
      continue;
    }
    if ((st.declarationList.flags & ts.NodeFlags.Let) === 0) {
      continue;
    }
    for (const d of st.declarationList.declarations) {
      const init = d.initializer;
      if (!ts.isIdentifier(d.name) || init === undefined) {
        continue;
      }
      if (!ts.isNumericLiteral(init)) {
        continue;
      }
      names.set(d.name.text, {
        name: d.name.text,
        incremented: 0,
        assertedInAfterAll: false,
      });
    }
  }
  const seenInAfterAll = new Set<string>();
  const hunt = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      seenInAfterAll.add(n.text);
    }
    ts.forEachChild(n, hunt);
  };
  const walkAfterAll = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === "afterAll"
    ) {
      for (const arg of n.arguments) {
        hunt(arg);
      }
    }
    ts.forEachChild(n, walkAfterAll);
  };
  walkAfterAll(sf);
  const visit = (n: ts.Node): void => {
    const isPlusPlus =
      (ts.isPostfixUnaryExpression(n) &&
        n.operator === ts.SyntaxKind.PlusPlusToken) ||
      (ts.isPrefixUnaryExpression(n) &&
        n.operator === ts.SyntaxKind.PlusPlusToken);
    if (isPlusPlus && ts.isIdentifier(n.operand)) {
      const c = names.get(n.operand.text);
      if (c !== undefined) {
        c.incremented += 1;
      }
    }
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isIdentifier(n.left)
    ) {
      const c = names.get(n.left.text);
      if (c !== undefined) {
        c.incremented += 1;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const c of names.values()) {
    c.assertedInAfterAll = seenInAfterAll.has(c.name);
  }
  return [...names.values()];
}

/** 取某行的原文，用于报错时指出【是谁】；单独导出便于钉住行号没指错。 */
export function lineAt(text: string, line: number): string {
  const parts = text.split(LFCHAR);
  const v = parts[line - 1];
  return v === undefined ? "" : v.trim();
}

/**
 * @param files 调用方读好的【被 vitest 收集的】测试文件；本函数不碰文件系统。
 * @param allowlist 允许跳过的文件名单，默认用模块常量。
 * @returns 问题列表；空列表表示没有【悄悄少跑】的用例。
 */
export function checkSkipCoverage(
  files: readonly { path: string; text: string }[],
  allowlist: readonly string[] = ALLOW_SKIP_FILES,
): SkipProblem[] {
  /* 一个文件都没喂进来时，下面所有循环一条也数不出来，结果会是【没问题】——
     那正是空对空，必须先堵（§7 第 38 条同一族）。 */
  if (files.length === 0) {
    return [{ why: "一个测试文件都没喂进来，跳过扫描在空转" }];
  }
  /* 名单为空 = 判据被掏空。真仓库那个合法跳过会立刻报错，可一旦有人图省事
     清空名单，这里必须响，而不是顺着变成【全过】。 */
  if (allowlist.length === 0) {
    return [{ why: "跳过名单本身是空的，判据已被掏空" }];
  }
  const out: SkipProblem[] = [];
  const found = new Set<string>();
  for (const f of files) {
    const forms = findSkipForms(f.path, f.text);
    if (forms.length === 0) {
      continue;
    }
    found.add(f.path);
    if (!allowlist.includes(f.path)) {
      for (const s of forms) {
        out.push({
          why:
            f.path +
            " 第 " +
            String(s.line) +
            " 行的 " +
            s.form +
            "（原文：" +
            lineAt(f.text, s.line) +
            "）不在跳过名单里 —— 用例不执行而报告会全绿",
        });
      }
      continue;
    }
    const live = findCounters(f.text).filter(
      (c: CounterInfo): boolean => c.incremented > 0 && c.assertedInAfterAll,
    );
    if (live.length === 0) {
      out.push({
        why:
          "名单内的 " +
          f.path +
          " 有跳过写法，却没有【自增过且断言挂在 afterAll 里】的运行计数 —— " +
          "它跳过多少用例无人知道",
      });
    }
  }
  /* 反向：名单里的文件还在语料里、却一条都不跳了，说明名单该删这一项。
     不做【名单项不在语料里】的检查——文件改名后新路径自然落在名单外，由上面
     那条臂报出；再加一条会让每次合成调用都误报。名单项是否仍在真语料里，
     改由真仓库那条用例直接断言。 */
  for (const a of allowlist) {
    if (found.has(a)) {
      continue;
    }
    const present = files.some((f: { path: string }): boolean => f.path === a);
    if (present) {
      out.push({
        why: "跳过名单里的 " + a + " 已经不再跳过任何用例 —— 名单该删这一项了",
      });
    }
  }
  return out;
}
