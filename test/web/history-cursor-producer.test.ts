/**
 * 会话历史翻页的游标必须有生产者（0077）。
 *
 * 为什么要有这个文件：契约 `listMessagesQuerySchema` 声明了 `before_seq`
 * （「往旧翻」的游标，packages/contracts/src/conversation.ts），服务端实现了它、
 * 服务端测试覆盖它、docstring 甚至点名了前端该怎么用它（「前端上拉历史是
 * prepend」），但渲染侧 0077 之前只发 `?limit=200` 且每次都整体覆盖数组 ——
 * 这个契约参数一个生产者都没有。后果是【静默的】：超过一页的会话在屏幕上永远
 * 只显示最新那一页，既不报错也没有「还有更早」的迹象，看起来就像历史只有这么多。
 *
 * 这个文件守的是【有没有真发这个参数】，不是【翻页翻得对不对】——
 * 后者（prepend 顺序、到底收起按钮、会不会跳段）在
 * test/e2e/group-workbench.spec.ts 的真浏览器闭环里。
 *
 * ⚠ 形状沿用同目录的源扫描守卫（group.js 顶层就 boot()、零 export，
 * vitest 导不进来），判别力自证放在最后一发。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listMessagesQuerySchema } from "../../packages/contracts/src/conversation.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const groupSrc = readFileSync(
  join(REPO, "packages/web/public/group.js"),
  "utf8",
);

/** 取 request( 的第一个参数（到顶层逗号或右括号为止）。 */
function firstArg(src: string, openAt: number): string {
  let depth = 0;
  let inTemplate = false;
  for (let i = openAt; i < src.length; i += 1) {
    const ch = src[i];
    if (inTemplate) {
      if (ch === "\\") i += 1;
      else if (ch === "`") inTemplate = false;
      continue;
    }
    if (ch === "`") inTemplate = true;
    else if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openAt + 1, i);
    } else if (ch === "," && depth === 1) return src.slice(openAt + 1, i);
  }
  throw new Error("request( 没有闭合，取材失败");
}

/**
 * 取渲染侧真发的每一发「会话历史」请求的查询串。
 *
 * 取材口径是【request( 第一个参数里的 URL 模板，按 + 拼接后整体看】，不是
 * 「整个文件里出现过 before_seq 这个字符串」——注释、文档散文、以及读它却从不
 * 发它的代码都不能算「有人发了这个参数」。拼接这一维不能省：翻页那一发的 URL
 * 是两段模板拼出来的，只取第一段会永远看不见游标（首版就栽在这里）。
 * 模板里的 `${}` 归一成 `?`，让参数的【值】不参与匹配、参数【名】参与。
 */
function historyQueryStrings(src: string): string[] {
  const queries: string[] = [];
  for (const match of src.matchAll(/\brequest\(/gmu)) {
    const arg = firstArg(src, (match.index as number) + "request(".length - 1);
    const templates = [...arg.matchAll(/`(?:[^`\\]|\\[\s\S])*`/gmu)];
    if (templates.length === 0) continue;
    const url = templates.map((t) => t[0] as string).join("");
    if (!url.includes("/messages")) continue;
    const q = url.indexOf("?");
    queries.push(
      q < 0
        ? ""
        : url
            .slice(q + 1, url.lastIndexOf("`"))
            .replace(/\$\{(?:[^{}]|\{[^{}]*\})*\}/gu, "?"),
    );
  }
  if (queries.length === 0) throw new Error("找不到会话历史请求，取材失败");
  return queries;
}

/** 查询串里出现了哪几个契约参数名。 */
function queryParamNames(query: string): string[] {
  return query
    .split("&")
    .map((pair) => pair.split("=")[0] as string)
    .filter((name) => name.length > 0);
}

/**
 * 取「把 state.messages 整条换成一个新数组」的赋值行（含右值，便于报错时认得出是谁）。
 *
 * 排除以 `fresh.concat` 开头的那一条：那是翻页的增量 prepend，不是整体覆盖 ——
 * 判定必须建立在右值上，光看左值会把增量也算成绕开重算。
 */
function wholeArrayAssignments(src: string): string[] {
  return [...src.matchAll(/^[ \t]*state\.messages\s*=[^\n]*/gmu)]
    .map((m) => (m[0] as string).trim())
    .filter((line) => !line.startsWith("state.messages = fresh.concat"));
}

/**
 * 取一个顶层函数声明的函数体（含首尾花括号）。
 *
 * 扫描认字符串、模板串（含 `${}` 嵌套）、行注释与块注释 —— 不认注释里的花括号
 * 是这一族取材最容易踩的坑。取不到闭合时抛，不悄悄返回半截（半截的判据是恒绿装饰）。
 */
function functionBody(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`找不到 ${header}，取材失败`);
  const open = src.indexOf("{", at + header.length);
  if (open < 0) throw new Error(`${header} 没有函数体，取材失败`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) break;
    } else if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
    } else if (ch === '"' || ch === "'") {
      i = skipQuoted(src, i, ch);
    } else if (ch === "`") {
      i = skipTemplate(src, i);
    } else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`${header} 的函数体没闭合，取材失败`);
}

/** 跳过单/双引号串，返回收尾引号的下标。 */
function skipQuoted(src: string, start: number, quote: string): number {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === "\\") i += 1;
    else if (src[i] === quote) return i;
  }
  throw new Error("引号串没闭合，取材失败");
}

/** 跳过模板串（含 `${}` 里嵌的串），返回收尾反引号的下标。 */
function skipTemplate(src: string, start: number): number {
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "\\") i += 1;
    else if (ch === "`") return i;
    else if (ch === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2; // 跳过 `${`，从插值内容起算
      while (i < src.length && depth > 0) {
        const inner = src[i];
        if (inner === "\\") i += 1;
        else if (inner === '"' || inner === "'") i = skipQuoted(src, i, inner);
        else if (inner === "`") i = skipTemplate(src, i);
        else if (inner === "{") depth += 1;
        else if (inner === "}") depth -= 1;
        i += 1;
      }
      i -= 1;
    }
  }
  throw new Error("模板串没闭合，取材失败");
}

/**
 * 取 applyHistoryWindow 的函数体 —— 「整体覆盖那一格」的唯一入口。
 *
 * 判据建在函数体上而不是散文上：这一族要问的是【这一格现在还有没有保留段与
 * 窗口归属】，注释里怎么写不算。
 */
function historyWindowBody(src: string): string {
  return functionBody(src, "function applyHistoryWindow(");
}

/** 取 applyHistoryWindow 的每一处【调用】的第一个实参（定义那一条不算）。 */
function windowCallFirstArgs(src: string): string[] {
  const args: string[] = [];
  for (const match of src.matchAll(/\bapplyHistoryWindow\(/gmu)) {
    const start = match.index as number;
    // 定义那一处（function applyHistoryWindow(id, page)）不是调用，跳过。
    if (
      src.slice(Math.max(0, start - "function ".length), start) === "function "
    )
      continue;
    const at = start + "applyHistoryWindow".length;
    args.push(firstArg(src, at).trim());
  }
  if (args.length === 0)
    throw new Error("找不到 applyHistoryWindow 调用，取材失败");
  return args;
}

/**
 * 变异锚点。⚠ 用拼接而不是普通字符串字面量写：这里要逐字节对上 group.js 里那两处
 * 模板发射形状，而普通字符串里的 `${` 会被 biome 判成「写错的模板串」
 * （noTemplateCurlyInString，同 test/web/admin-style-scope.test.ts 那条豁免的成因）。
 * 拆开写不损失什么 —— 锚点本来就是拿来 replace 的字符串。
 */
const DOLLAR = "$";
/** 翻页那一发查询串里的游标段（参数名 + 等号）。 */
const CURSOR_PARAM = "&before_seq=";
const PAGED_QUERY =
  "`?limit=" +
  DOLLAR +
  "{MESSAGES_PAGE_LIMIT}" +
  CURSOR_PARAM +
  DOLLAR +
  "{before}`";
const LIMIT_ONLY_QUERY = "`?limit=" + DOLLAR + "{MESSAGES_PAGE_LIMIT}`";

describe("会话历史的 before_seq 游标有生产者", () => {
  it("渲染侧发的会话历史查询里真有 before_seq（契约参数不许零生产者）", () => {
    // 能出现在这条查询串上的参数名取自 schema 自己，不另抄一份名单。
    const contractParams = Object.keys(
      listMessagesQuerySchema.shape,
    ) as string[];
    expect(contractParams).toContain("before_seq");
    const sent = new Set(
      historyQueryStrings(groupSrc).flatMap(queryParamNames),
    );
    // 反向哨兵：发出去的名字必须都在契约里。拼错一个字母 = 服务端按未知参数
    // 忽略它（query 是 strict 但对未知键的拒绝发生在整体校验之后），界面还会
    // 以为翻了页。
    expect([...sent].filter((name) => !contractParams.includes(name))).toEqual(
      [],
    );
    expect(sent.has("before_seq")).toBe(true);
  });

  it("带游标的那一发读的是游标本身，不是写死的数（写死 = 每次翻同一段）", () => {
    const withCursor = historyQueryStrings(groupSrc).filter((q) =>
      queryParamNames(q).includes("before_seq"),
    );
    expect(withCursor.length).toBeGreaterThan(0);
    for (const q of withCursor) {
      const pair = q
        .split("&")
        .find((p) => (p.split("=")[0] as string) === "before_seq") as string;
      // `=?` 里的 ? 是归一化后的 `${...}`：必须是插值，不能是字面量。
      expect(pair.endsWith("=?")).toBe(true);
    }
  });

  it("整体覆盖消息数组的每一处都重算游标（两处各写一份迟早漂）", () => {
    // state.messages = 的赋值点分两类：applyHistoryWindow 里那一行是【定义】，
    // loadOlderMessages 里那一行是【增量 prepend】（右边以 fresh.concat 开头，
    // 它自己紧跟着重算游标）。其余任何一处 = 第三处整体覆盖，绕开了重算 ⇒
    // 数组换了、游标还指着一条已不在数组里的消息。
    const bare = wholeArrayAssignments(groupSrc);
    expect(bare).toEqual(["state.messages = list;"]);
    // 两处读请求都汇到同一个入口，且入口按【会话 id】认窗口：传数组进去等于
    // 绕过窗口归属（换会话时把上一群翻出来的那段和「到底」结论带过去）。
    const firstArgs = windowCallFirstArgs(groupSrc);
    expect(firstArgs).toHaveLength(2);
    for (const arg of firstArgs) {
      expect(arg).not.toMatch(/messages\s*\|?\|?\s*\[\]/u);
      expect(arg.length).toBeGreaterThan(0);
    }
  });

  it("背景重读不许吞掉已翻出来的那段（覆盖式重读 = 按钮复活 + 历史凭空少一截）", () => {
    // 这一族的病是【静默】的：背景刷新（SSE 事件、发送后补拉、输入框聚焦补拉）读的是
    // 最新一页，直接整体覆盖会把用户刚翻出来的旧段吞回去，游标退回最新页、已收起的
    // 「查看更早」原地复活 —— 三件事都不报错。判据建在入口函数体上，不建在散文上。
    const body = historyWindowBody(groupSrc);
    // ① 保留段来自当前数组（不是每次从空数组起）。
    expect(
      /retainOlderThan\(\s*state\.messages\s*,\s*page\s*\)/u.test(body),
    ).toBe(true);
    // ② 窗口按会话归属：只有同一会话的重读才保留。
    expect(/state\.messagesWindowId\s*===\s*id/u.test(body)).toBe(true);
    // ③ 翻过页时「还有更早」维持原值 —— 最新那一页满不满 limit 证明不了
    //    已翻到的那段之外还有东西。
    expect(
      /messagesHasMore\s*=\s*[\s\S]*?retained\.length > 0[\s\S]*\?[\s\S]*state\.messagesHasMore/u.test(
        body,
      ),
    ).toBe(true);
    // ④ 游标取自【合并后】的整个窗口，而不是新来的那一页（取页 = 游标退回，
    //    下一发 before_seq 会把已加载那段再要一遍）。
    expect(/historyCursor\(list\)/u.test(body)).toBe(true);
    expect(/historyCursor\(page\)/u.test(body)).toBe(false);
    // ⑤ 翻页那一发自己仍按页长重算（到底要收起按钮）。
    expect(
      /state\.messagesHasMore = historyHasMore\(page\.length, MESSAGES_PAGE_LIMIT\);/u.test(
        functionBody(groupSrc, "async function loadOlderMessages("),
      ),
    ).toBe(true);
  });

  it("提取器本身有判别力（否则本节是恒绿装饰）", () => {
    // 负向一：把翻页那一发退回 0077 之前的形状（只有 limit）⇒ 游标必须报「没人发」。
    const withoutCursor = groupSrc.replace(PAGED_QUERY, LIMIT_ONLY_QUERY);
    // 变异必须真抹掉字节 —— 字节没变就是假变异，量不到任何判据。
    expect(withoutCursor).not.toBe(groupSrc);
    expect(
      new Set(historyQueryStrings(withoutCursor).flatMap(queryParamNames)).has(
        "before_seq",
      ),
    ).toBe(false);
    // 负向二：把游标名拼错一个字母 ⇒ 反向哨兵必须点名它。
    const misspelled = groupSrc.replace(
      CURSOR_PARAM,
      "&before_seqq=" + DOLLAR + "{before}",
    );
    expect(misspelled).not.toBe(groupSrc);
    const typoSent = new Set(
      historyQueryStrings(misspelled).flatMap(queryParamNames),
    );
    expect(typoSent.has("before_seq")).toBe(false);
    expect([...typoSent].filter((n) => n.startsWith("before"))).toEqual([
      "before_seqq",
    ]);
    // 负向三：把首屏那一发改回直接赋值（绕开重算入口）⇒ 覆盖清单必须报出两处，
    // 入口调用必须少一处（取材口径认的是调用，不是散文里提了几次这个名字）。
    const bypassAnchor =
      "applyHistoryWindow(\n              state.selectedConversation,\n              result.messages || [],\n            );";
    const bypassed = groupSrc.replace(
      bypassAnchor,
      "state.messages = result.messages || [];",
    );
    expect(bypassed).not.toBe(groupSrc);
    expect(wholeArrayAssignments(bypassed).sort()).toEqual([
      "state.messages = list;",
      "state.messages = result.messages || [];",
    ]);
    expect(windowCallFirstArgs(bypassed)).toHaveLength(1);
    // 负向四：把入口整体退回 0077 早先那版「无条件整体覆盖」（没有保留段、没有窗口
    // 归属、hasMore 一律按最新页长重算）⇒ 上一节的判据必须逐条报缺口 ——
    // 证明这一节量的就是这三格，而不是碰巧在函数体里找到几个词。
    const clobbering = groupSrc.replace(
      historyWindowBody(groupSrc),
      [
        "{",
        "  const list = page;",
        "  state.messages = list;",
        "  state.messagesCursor = historyCursor(page);",
        "  state.messagesHasMore = historyHasMore(page.length, MESSAGES_PAGE_LIMIT);",
        "}",
      ].join("\n"),
    );
    expect(clobbering).not.toBe(groupSrc);
    const clobBody = historyWindowBody(clobbering);
    expect(/retainOlderThan\(/u.test(clobBody)).toBe(false);
    expect(/messagesWindowId/u.test(clobBody)).toBe(false);
    expect(/retained\.length > 0/u.test(clobBody)).toBe(false);
    expect(/historyCursor\(list\)/u.test(clobBody)).toBe(false);
    expect(/historyCursor\(page\)/u.test(clobBody)).toBe(true);
    // 反向：窗口属主换成别的会话也不许保留（把 === 改成 !== 是同一格的另一种写坏）。
    const wrongOwner = groupSrc.replace(
      "state.messagesWindowId === id",
      "state.messagesWindowId !== id",
    );
    expect(wrongOwner).not.toBe(groupSrc);
    expect(
      /state\.messagesWindowId\s*===\s*id/u.test(historyWindowBody(wrongOwner)),
    ).toBe(false);
    // 正向：原文件里 /messages 共四发（首屏两处 + 翻页 + 发送 POST），
    // 其中带查询串的三发 —— 证明上面几次「取不到」不是取材恒空或只看第一段。
    expect(historyQueryStrings(groupSrc)).toHaveLength(4);
    expect(historyQueryStrings(groupSrc).filter((q) => q !== "")).toHaveLength(
      3,
    );
    // 取材失败的形状也要成立：拿不到对象时是抛，不是悄悄返回空数组。
    expect(() => historyQueryStrings("const x = 1;")).toThrow(/取材失败/u);
  });
});
