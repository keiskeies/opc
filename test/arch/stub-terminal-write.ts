/**
 * O1 验收守卫的【纯判据】：桩图把任务推到了哪一格，那一格是不是人坐的。
 *
 * ── 这条守卫要回答的唯一问题 ────────────────────────────────────
 * 设计文档 docs/OPC-OS-功能优化设计.md §O1 的验收原文是：
 *   「扫 hub/src，若存在一条会写 tasks.status = 'ARCHIVED' 且其路径上没有人类席位
 *     判定的边，报 FAIL」
 * ⚠ **这句话作为判据不成立**，洞与 O1-1 那条「库里已有 tasks 行 ⇒ 拒绝」同一族
 * （判错了对象）：按【字面量】找 ARCHIVED，把 `write("ARCHIVED")` 改成
 * `write(STATES.ARCHIVED)` 或 `write(TERMINAL)` 它就【绿了】，而行为一字未变。
 * 现在判的是【结构】：桩图产出的每一条边，落点那格是 agent 坐的还是人坐的。
 *
 * ── 三条判据 ──────────────────────────────────────────────────
 *  ① 桩图**真的会写出**哪些状态：company.ts 每个节点体内、代码区里的每一个状态
 *     字面量都算一次写点（理由见 collectWrites 的注释：在那张图里这不是近似，
 *     是同义）。注释里那句「不再直写 ARCHIVED」不算 —— 走 ./ts-lex.ts 的代码区。
 *  ② 落点的席位【从表里推】，本文件一个状态名都不抄：`HUMAN_EDGES` 全部 approve
 *     的 `to` 汇成「只有人能走进去的那批格子」。改那张表 ⇒ 本判据口径跟着变。
 *     为什么取【落点】而不是【起点】：要防的是「替人做了一次决定」，而一次决定在
 *     审计流里的痕迹就是那条【进入人类格子】的边 —— ESCALATED_TO_CEO→FINAL_REVIEW
 *     写的确实是「CEO 批准上线」（dispatch.ts 那句 why 的原文）。按起点算的话
 *     FINAL_REVIEW 不算人类格子，桩就能自己走进去、只停在下一格，而 events 里
 *     已经躺了一条假的 CEO 批准，且【那行是 append-only 的】。
 *  ③ 每条写点要么在【基线】里（逐条被特征串约束），要么红。基线双向核对。
 *
 * ── 为什么还要那半边宽扫描（findUnguardedStatusWriters）──────────
 * ①–③ 只管桩图。生产路线（dispatch / approve / real-deps）也写 tasks.status，
 * 那边判的是【本模块代码区里有没有引用席位权威】（seatOf / humanEdge /
 * HUMAN_EDGES，三个都是 dispatch.ts 真导出的符号）。这是【模块粒度】近似，
 * 不是路径粒度：同文件里一半有人类门一半没有，会被判成有门。近似误差方向已经
 * 量过（见测试），且它今天命中集合里【只有桩图】—— 也就是说这条现在的作用是把
 * 「桩没有门」这件事钉住，顺带在生产模块新增一个无门写入方时当场红。
 *
 * ── 刻意不做的一件事： lexical 的跃迁合法性核对 ──────────────────
 * 本来想加「抽出来的每条边必须是 §7.1 合法跃迁」。实测【判错】：dev 节点体是
 * `if (…) await write("IN_PROGRESS"); await write("EVIDENCE_SUBMITTED")`，
 * 分支在词法上看不出来，抽出的是超序列，会凭空得出一条 IN_PROGRESS→IN_PROGRESS
 * 自环（而自环在本仓是明确非法的）。那条检查会以【错误的原因】红。
 * 跃迁合法性已经有两处真的在执行期判：company.ts:144 的 assertTaskTransition
 * （每条边写完前炸），以及 smoke/e2e-linear 里那两条「轨迹每对 from→to 必须合法」
 * （跑真图拿真轨迹）。这里再抄一份只会多一个会判错的口径。
 *
 * ── 实测过的【漏报】余量：把状态名藏进常量 ─────────────────────
 * 变异实测：把 `write("ESCALATED_TO_CEO")` 改成 `write(TERMINAL_STATE)`（常量值
 * = "ARCHIVED"），本文件的席位判据【看不见】—— 词法提取只认字面量，这一点与设计
 * 文档原方案（扫 "ARCHIVED" 字面量）是【同一个洞】，我没有假装绕过了它。
 * 那条变异被杀是因为另一发：写点条数从 11 掉到 10，测试里那条钉死序列的断言红。
 * 也就是说这一层的强度来自【条数 + 顺序被钉死】，不来自席位判据本身。
 * 真要堵住这一层得做常量求值或调用图，那是另一个量级；这里的取舍是：
 * 承认余量 + 把余量写成一条测试（下面测试文件里那条「11 条不多不少」就是它）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AGENT_EDGES,
  HUMAN_EDGES,
} from "../../packages/hub/src/engine/dispatch.js";
import { COMPANY_NODES } from "../../packages/hub/src/graph/company.js";
import {
  legalTransitionsFrom,
  TASK_STATES,
  type TaskState,
} from "../../packages/hub/src/graph/status.js";
import { collectModules, type Module, repoRoot } from "./dead-modules.js";
import { lexTs } from "./ts-lex.js";

/* ═══════════════ 权威（全部从 src 推导，本文件不抄状态名单）═══════════════ */

/**
 * 「只有人类决策能走进去」的那批格子 = HUMAN_EDGES 全部 approve 的落点。
 * 今天实测 = {CHARTER_APPROVED, FINAL_REVIEW, DELIVERED}。
 */
export function humanSeatTargets(): ReadonlySet<TaskState> {
  const out = new Set<TaskState>();
  for (const perStatus of Object.values(HUMAN_EDGES)) {
    if (perStatus === undefined) continue;
    for (const edge of Object.values(perStatus)) {
      if (edge !== undefined) out.add(edge.to);
    }
  }
  return out;
}

/** agent 能开口的格子。测试用它证明两张表【互补而非重叠】。 */
export function agentSeatStates(): ReadonlySet<TaskState> {
  return new Set(Object.keys(AGENT_EDGES) as TaskState[]);
}

/** §7.1 认的那些状态。取自 TASK_STATES（它自己从 EDGES 的键派生）。 */
export function allTaskStates(): ReadonlySet<TaskState> {
  return new Set(TASK_STATES);
}

/* ═════════════════════════ 节点体取材 ═════════════════════════ */

/** 一个节点体：装配里的名字 + 它按出现顺序写出的那些状态 + 源码起止。 */
export type NodeBody = {
  readonly node: string;
  readonly writes: TaskState[];
  readonly start: number;
  readonly end: number;
};

/**
 * 桩图里【每条边都逐条写】的那个函数叫 edge(from,to)，节点体里调的是它的偏应用
 * 包装 write(to)（company.ts:177 的 node() 工厂给的）。本判据认这个词。
 * 名字变了 ⇒ collectWrites 抽出空表 ⇒ 测试里那条「取材非空 + 覆盖全文件」先红。
 */
const NODE_FACTORY = "node";

/**
 * 从 company.ts 源码提出每个节点体的写点。
 *
 * 节点体的范围 = 从它的 `node("<名>"` 起手点到下一个起手点（最后一个到文件尾）。
 * 为什么不用花括号配对：那要真解析器，而本仓的家规是不把 typescript 拉进判据依赖
 * （./dead-modules.ts 文件头）。
 *
 * ── 这套切分会在哪种形状上错，错了会怎样 ──────────────────────
 * 只有【节点体内又嵌套一个 node( 调用】时才会切早（例如把 handler 抽出来时写成
 * `node("dev", wrap(node("inner", …)))`）。后果是把后半个体的字面量算给一个
 * 冒名节点 —— 少报。所以配了 assemblyCoverageProblems 那条结构前提：
 * addNode 的名字集合与就地 node( 的名字集合一旦错位，当场红。
 * （原先这里还挂着第二条前提「每个状态字面量都要落在某个体内」，实测【恒真】
 * 已删，理由记在 assemblyCoverageProblems 的文件头 —— 那一条比没有更坏。）
 *
 * ⚠ 抽出来的是任意一次真执行的【超序列】，且保序：dev 节点体的分支
 * `if (…) await write("IN_PROGRESS")` 可能被跳过，于是真实序列是抽出序列的
 * 子序列。这个方向对判据是安全的 —— 「第一个进入人类格子的写点」在超序列里
 * 只会【更早或同时】出现，所以最坏是【多报一条】，不会漏报。
 */
export function collectWrites(
  src: string,
  states: ReadonlySet<TaskState>,
): NodeBody[] {
  const marks = nodeCallSites(src);
  const literals: { at: number; state: TaskState }[] = [];
  lexTs(src, {
    onString: (kind, body, open) => {
      if (kind === '"' && states.has(body as TaskState)) {
        literals.push({ at: open, state: body as TaskState });
      }
    },
  });
  const out: NodeBody[] = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k]?.at ?? 0;
    const end =
      k + 1 < marks.length ? (marks[k + 1]?.at ?? src.length) : src.length;
    out.push({
      node: marks[k]?.node ?? "",
      writes: literals
        .filter((l) => l.at >= start && l.at < end)
        .map((l) => l.state),
      start,
      end,
    });
  }
  return out;
}

/**
 * `node("<名>", …)` 的调用点。
 *
 * 筛掉 company.ts:177 那个【函数定义】`function node(`：调用点的词尾之后紧跟
 * `(` 再紧跟一个字符串字面量（`.addNode("report", node("report", async …))`），
 * 定义那一发词尾之后是 `(` 但再往后是形参名不是引号 —— 所以判据是
 * 「词尾起第一个非空白是 ( ，且 ( 之后第一个非空白是 "」。
 */
function nodeCallSites(src: string): { node: string; at: number }[] {
  const sites: { node: string; at: number }[] = [];
  lexTs(src, {
    onWord: (word, end) => {
      if (word !== NODE_FACTORY) return;
      const openParen = skipSpace(src, end, 1);
      if (src[openParen] !== "(") return;
      const quote = skipSpace(src, openParen + 1, 1);
      if (src[quote] !== '"') return;
      const close = src.indexOf('"', quote + 1);
      if (close < 0) return;
      sites.push({
        node: src.slice(quote + 1, close),
        at: wordStart(src, end),
      });
    },
  });
  return sites;
}

/** 沿 dir 方向跳过空白后的下标（越界返回边界）。 */
function skipSpace(src: string, from: number, dir: 1 | -1): number {
  let k = from;
  while (k >= 0 && k < src.length && /\s/u.test(src[k] as string)) k += dir;
  return k;
}

/** 词的起始下标（lexTs 的 onWord 只给了词尾）。 */
function wordStart(src: string, wordEnd: number): number {
  let k = wordEnd;
  while (k > 0 && /[\w$]/u.test(src[k - 1] as string)) k--;
  return k;
}

/**
 * 结构前提：每个装配节点恰好一个体。返回不符的说明（空 = 成立）。
 * 装配加了节点而这里没认出来，一定是这条先红，而不是静默少扫一段。
 */
export function nodeCoverageProblems(bodies: readonly NodeBody[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const b of bodies) seen.set(b.node, (seen.get(b.node) ?? 0) + 1);
  for (const n of COMPANY_NODES) {
    const c = seen.get(n) ?? 0;
    if (c !== 1)
      problems.push("装配节点 " + n + " 在源码里出现 " + c + " 次（应为 1）");
    seen.delete(n);
  }
  for (const [n, c] of seen)
    problems.push(
      "源码里有名为 " +
        n +
        " 的 node( 调用 " +
        c +
        " 次，而它不在 COMPANY_NODES",
    );
  return problems;
}

/**
 * 结构前提：装配里每一个 `.addNode("<名>", …)` 都有一个【就地】的 `node("<名>", …)`。
 *
 * ── 这条替代了原先那条「每个状态字面量都要落在某个节点体里」──────────
 * 那条【实测是恒真的】，实测方法：在 company.ts 尾部追加 `const stray = "DELIVERED"`，
 * 未归属计数照样是 0 —— 因为节点体的切分是「从这个 node( 到下一个 node(」，
 * 最后一发一路吃到文件尾，所以【结构上不可能】有字面量落在所有体之外。
 * 一条永不成立的判据比没有判据更坏：它让人以为这一层有人看着。删掉它，理由留在这儿。
 *
 * ── 那切分切早了怎么办 ────────────────────────────────────────
 * 后果是【把后面的字面量算给前一个节点】，方向是多报/错报归属，不是漏报，
 * 而主判据「有任何写点落进人类格子就红」对多报是安全的。真正的【漏报】形状是
 * 另一个：`.addNode("report", handlerDefinedElsewhere)` —— 写点住在别的文件/别的
 * 函数里，nodeBodies 完全看不见它，于是那条边凭空从判据里消失。上面那条配对
 * 抓的正是这一发：addNode 的名字集合与 node( 的名字集合一旦错位，当场红。
 */
export function assemblyCoverageProblems(
  src: string,
  bodies: readonly NodeBody[],
): string[] {
  const problems: string[] = [];
  const assembled = addNodeNames(src);
  const inline = new Set(bodies.map((b) => b.node));
  for (const n of assembled)
    if (!inline.has(n))
      problems.push(
        '.addNode("' +
          n +
          '", …) 没有就地的 node("' +
          n +
          '", …) —— 它的写点住在本判据看不见的地方',
      );
  for (const n of inline)
    if (!assembled.includes(n))
      problems.push('有就地的 node("' + n + '", …) 而装配里 addNode 没有它');
  return problems;
}

/** 装配里 `.addNode("<名>", …)` 的那些名字（可重复：同名加两次也如实列出）。 */
export function addNodeNames(src: string): string[] {
  const out: string[] = [];
  lexTs(src, {
    onWord: (word, end) => {
      if (word !== "addNode") return;
      const p = skipSpace(src, end, 1);
      if (src[p] !== "(") return;
      const q = skipSpace(src, p + 1, 1);
      if (src[q] !== '"') return;
      const close = src.indexOf('"', q + 1);
      if (close > q) out.push(src.slice(q + 1, close));
    },
  });
  return out;
}

/* ═════════════════════════ 判定 ═════════════════════════ */

/** 一条写点：哪个节点写的、写到哪格。 */
export type WriteSite = {
  readonly via: string;
  readonly to: TaskState;
};

/** 桩图全部写点，按装配顺序。 */
export function stubWrites(bodies: readonly NodeBody[]): WriteSite[] {
  const out: WriteSite[] = [];
  for (const b of bodies)
    for (const to of b.writes) out.push({ via: b.node, to });
  return out;
}

/** 其中「替人走了一步」的那些：落点是人坐的格子。 */
export function bypasses(
  writes: readonly WriteSite[],
  humanTos: ReadonlySet<TaskState> = humanSeatTargets(),
): WriteSite[] {
  return writes.filter((w) => humanTos.has(w.to));
}

/**
 * 基线：已登记、已标注的桩越权。每条带【特征串】，资格 = 出现在那个节点体的
 * 【源码片段】里、且在全仓其余 src 模块中一次都不出现（同 dead-modules 的家规）。
 * 特征串没了 ⇒ 豁免当场失效 ⇒ 红。光秃秃的名单 = 第二个「进桶即放过」。
 */
export type BaselineEntry = {
  readonly via: string;
  readonly to: TaskState;
  readonly mark: string;
  readonly why: string;
};

/**
 * 今天成立的那一条。
 *
 * charter 节点由桩直通 CHARTER_APPROVED，而那一格是 CEO 的席位（HUMAN_EDGES 第一条）。
 * 它【已在源码里诚实标注】（company.ts:218–225「0.8 的最小图没有审批门控」+「门控
 * 落地后这条边必须由 interrupt 驱动，届时 e2e-linear 那条无门控用例会转红，跟着一起
 * 改，不是悄悄改期望值」），且设计文档把它记在 §2 那张对照表的「审批门：无」那一行，
 * 与 report 那一条并列为【两件事】。O1 动作 2 只点名了 report，charter 的门控是
 * O4/O5 那条线（真建卡、真等点击）的活 —— 这里把它登记着而不是顺手也一起改，
 * 是因为一起改会把整个 Phase 0 演示（14 条边的 e2e-linear、崩溃恢复）一次拆掉，
 * 那不是 O1 要的范围。
 */
export const BASELINE: readonly BaselineEntry[] = [
  {
    via: "charter",
    to: "CHARTER_APPROVED",
    mark: "没有审批门控",
    why: "O4/O5 的门控未落地；源码 218–225 行已标注，改动时这条豁免当场失效",
  },
];

/** 基线核对结果。两个方向分开报，因为修法完全不同。 */
export type BaselineCheck = {
  /** 不在基线里的越权写点 ⇒ 这条守卫的主判据。 */
  readonly unexpected: WriteSite[];
  /** 基线里已经不再成立的条目 ⇒ 「修好了，回去改文档」。 */
  readonly stale: BaselineEntry[];
  /** 特征串在它自己的节点体源码里找不到了 ⇒ 豁免的凭据已失效。 */
  readonly invalidMarks: BaselineEntry[];
};

export function checkBaseline(
  writes: readonly WriteSite[],
  mods: readonly Module[],
  source: string,
  baseline: readonly BaselineEntry[] = BASELINE,
): BaselineCheck {
  const byKey = new Map<string, WriteSite[]>();
  for (const w of bypasses(writes)) {
    const k = w.via + "→" + w.to;
    const list = byKey.get(k) ?? [];
    list.push(w);
    byKey.set(k, list);
  }
  // 特征串资格只算一次：三条判据（红项 / 过期项 / 失效凭据）必须问同一个答案，
  // 各自现算的话，一份基线条目可能在一支里算「有效」另一支里算「无效」。
  const markOk = new Map(
    baseline.map((e) => [e, markIsValid(e, source, mods)]),
  );
  const invalidMarks = baseline.filter((e) => markOk.get(e) !== true);
  const valid = new Set(
    baseline
      .filter((e) => markOk.get(e) === true)
      .map((e) => e.via + "→" + e.to),
  );
  const unexpected: WriteSite[] = [];
  for (const [k, list] of byKey) if (!valid.has(k)) unexpected.push(...list);
  const stale = baseline.filter(
    (e) => markOk.get(e) === true && !byKey.has(e.via + "→" + e.to),
  );
  return {
    unexpected: unexpected.sort((a, b) =>
      a.via + a.to < b.via + b.to ? -1 : 1,
    ),
    stale,
    invalidMarks,
  };
}

/**
 * 特征串资格：出现在【桩图那一个文件】里，且在全仓【其余】src 模块里一次都不出现。
 * 后半句才是让「豁免指向的确实是这个东西」成立的那一半。
 *
 * ⚠ 为什么不像 dead-modules 那样限在【该节点体的片段】里 —— 实测那条更严的口径
 * 【结构上会判错】：节点体的范围是「从这个 `node(` 到下一个 `node(`」，所以相邻两体
 * 【首尾相接】，而每个节点的诚实标注写在它自己的【上方】doc 注释里 —— 那段注释
 * 物理上落在【上一个】节点的片段里。拿片段找特征串，charter 那条注会算在 intake 头上，
 * 于是「豁免的凭据还在」这件事检查的是一个错位的位置。这正是本仓那一族：
 * 判据看起来更严，实际判错了对象。
 *
 * 退到【整文件】之后还剩什么强度：① `via`（哪个节点写的）来自解析，不来自特征串，
 * 所以豁免认不了假节点名；② 特征串必须还在 company.ts 里，把它删了或改措辞 ⇒
 * 当场红；③ 全仓唯一，别处写一句同样的话不能替它背书。
 */
function markIsValid(
  e: BaselineEntry,
  source: string,
  mods: readonly Module[],
): boolean {
  if (!source.includes(e.mark)) return false;
  return !mods.some((m) => m.rel !== COMPANY_REL && m.text.includes(e.mark));
}

const COMPANY_REL = "graph/company.ts";

/* ═══════════════ 宽扫描：写 tasks.status 而模块内无席位权威 ═══════════════ */

/** 代码区里的全部双引号串（注释里的 SQL 不算 —— 实测错过：org/commit.ts）。 */
export function codeStrings(src: string): string[] {
  const out: string[] = [];
  lexTs(src, {
    onString: (kind, body) => {
      if (kind === '"') out.push(body);
    },
  });
  return out;
}

/**
 * 席位权威的名字。三个【必须】是 dispatch.js 真导出的 —— 测试里逐条对
 * Object.hasOwn 钉着。写成黑名单会腐烂的形状是「名字改了这边不知道」。
 */
export const SEAT_AUTHORITY_NAMES = [
  "seatOf",
  "humanEdge",
  "HUMAN_EDGES",
] as const;

/** 席位权威住在哪个模块（说明符按【结尾】匹配，相对路径深度不该影响判定）。 */
const AUTHORITY_MODULE = "dispatch.js";

/**
 * 本模块是否【有席位门可依赖】：从 dispatch.js 具名 import 了那三个符号之一，
 * 或者它自己就是【定义】它们的那个模块。
 *
 * ⚠ 为什么不是「代码区里出现过那个名字就算」—— 那是我这版第一稿的写法，弱点是
 * 一个 `const seatOf = 1` 就能让一个无门模块判成有门。改成认【import 语句】之后
 * 那个洞没了：局部同名变量不构成 import。代价是 `import * as d from "./dispatch.js"`
 * 再 `d.seatOf(s)` 这种写法判不出来 —— 全仓实测零处这么写（grep `from "./dispatch.js"`
 * 只有具名那几发），真出现的话这条判成无门 ⇒ 【多报一条】，方向是红，不是静默。
 *
 * 仍然承认的余量：这是【模块粒度】。同文件里一半路径有人类门、一半没有，
 * 判据看不出来。那条余量记在测试里，没有藏。
 */
export function usesSeatAuthority(src: string): boolean {
  if (definesSeatAuthority(src)) return true;
  return importsSeatAuthority(src);
}

/** 定义了席位权威（dispatch.ts 自己）。认 `export const|function <名>`。 */
export function definesSeatAuthority(src: string): boolean {
  const re = new RegExp(
    "\\bexport\\s+(?:async\\s+)?(?:const|function)\\s+(?:" +
      SEAT_AUTHORITY_NAMES.join("|") +
      ")\\b",
    "u",
  );
  return codeRegions(src).some((s) => re.test(s));
}

/** 从 …\/dispatch.js 具名 import 了席位权威之一。 */
export function importsSeatAuthority(src: string): boolean {
  const names = new Set<string>(SEAT_AUTHORITY_NAMES);
  let found = false;
  for (const stmt of importStatements(src)) {
    const m = /\bfrom\s*"([^"]*)"/u.exec(stmt);
    if (m?.[1] === undefined || !m[1].endsWith(AUTHORITY_MODULE)) continue;
    const braces = /\{([^}]*)\}/u.exec(stmt);
    if (braces?.[1] === undefined) continue;
    for (const part of braces[1].split(",")) {
      // `import { seatOf as s }` 取的是【导出名】那一侧
      const name = part
        .trim()
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name !== undefined && names.has(name)) found = true;
    }
  }
  return found;
}

/**
 * 顶层 import 语句。从词法扫描的【代码区】里切：每段代码区按行给，
 * 一句 import 在同一行或连续几行内（本仓 biome 会把长的 import 拆成多行），
 * 所以按【from 分号】切而不是按行切。
 */
function importStatements(src: string): string[] {
  const out: string[] = [];
  const code = codeRegions(src).join("\n");
  const re = /\bimport\b[^;]*?;/gu;
  for (const m of code.matchAll(re)) out.push(m[0]);
  // 末尾没有分号的写法（本仓 biome 一律加分号，这条是兜底而不是猜测）
  const tail = /\bimport\b[^;]*$/u.exec(code);
  if (tail !== null) out.push(tail[0]);
  return out;
}

/** 代码区（注释被排除后剩下的片段），按出现顺序。 */
function codeRegions(src: string): string[] {
  return codeRegionsViaMarks(src);
}

/**
 * 代码区 = 全文件减去【注释覆盖的字符区间】。
 * lexTs 的 onComment 给的是正文而非下标，所以这里自己扫一遍区间：形状与 ts-lex
 * 一致（`//` 到行尾、`/* … *\/` 到收尾），差别只是这里要的是【区间】。
 * 两份扫描器会不会漂移？会 —— 但漂移的方向是【注释少挖了】⇒ 注释里的 import
 * 被当成 import ⇒ 多判成有门 ⇒ 少报。少报的方向不对，所以配了一条测试：
 * 「import 写在注释里 ⇒ 不算有门」。
 */
function codeRegionsViaMarks(src: string): string[] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      spans.push([start, i]);
      continue;
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      spans.push([i, end < 0 ? src.length : end + 2]);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    // 字符串字面量整段跳：里面的 // 不是注释（SQL 里的 `--` 不是，URL 里的 // 才是）
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < src.length) {
        const d = src[i] as string;
        if (d === "\\") {
          i += 2;
          continue;
        }
        if (d === quote) {
          i++;
          break;
        }
        if (d === "\n" && quote !== "`") break;
        i++;
      }
      continue;
    }
    i++;
  }
  const out: string[] = [];
  let pos = 0;
  for (const [a, b] of spans) {
    if (a > pos) out.push(src.slice(pos, a));
    pos = Math.max(pos, b);
  }
  if (pos < src.length) out.push(src.slice(pos));
  return out;
}

/** 会把 tasks.status 写进库的模块。 */
export function statusWriterModules(mods: readonly Module[]): string[] {
  return mods
    .filter((m) =>
      codeStrings(m.text).some((s) =>
        /UPDATE\s+tasks\s+SET\s+status\b/u.test(s),
      ),
    )
    .map((m) => m.rel)
    .sort();
}

/** 写了 tasks.status 而模块内查不到席位权威的模块。逐条需要被解释。 */
export function findUnguardedStatusWriters(mods: readonly Module[]): string[] {
  const writing = new Set(statusWriterModules(mods));
  return mods
    .filter((m) => writing.has(m.rel) && !usesSeatAuthority(m.text))
    .map((m) => m.rel)
    .sort();
}

/** 宽扫描的基线。同 BASELINE 的家规：逐条被特征串约束。 */
export const WRITER_BASELINE: readonly {
  readonly rel: string;
  readonly mark: string;
}[] = [{ rel: COMPANY_REL, mark: "没有审批门控" }];

/* ═════════════════════════ 取材（IO）═════════════════════════ */

/** 桩图源码。单独成函数：测试里要用合成的树跑阳性对照。 */
export function companySource(rootDir: string = repoRoot()): string {
  return readFileSync(
    join(rootDir, "packages", "hub", "src", "graph", "company.ts"),
    "utf8",
  );
}

/** 全量跑一遍，测试与手工复核共用一份。 */
export function analyse(rootDir: string = repoRoot()): {
  readonly bodies: NodeBody[];
  readonly writes: WriteSite[];
  readonly baseline: BaselineCheck;
  readonly coverage: string[];
  /** 装配配对前提：addNode 的名字集合 与 就地 node( 的名字集合 的错位说明。 */
  readonly assembly: string[];
  readonly unguarded: string[];
  /** 宽扫描命中的全部模块（未减基线），测试要拿它证明基线真的减掉了东西。 */
  readonly writerAll: string[];
  readonly writerBaselineStale: string[];
  readonly edgeCount: number;
  readonly humanTos: readonly TaskState[];
  readonly source: string;
} {
  const source = companySource(rootDir);
  const states = allTaskStates();
  const bodies = collectWrites(source, states);
  const writes = stubWrites(bodies);
  const mods = collectModules(rootDir);
  const unguarded = findUnguardedStatusWriters(mods);
  // 宽扫描的基线同样双向：不在基线里的 ⇒ 红；基线里已经不再成立的 ⇒ 红（回去改文档）。
  // 特征串对着【那个模块自己的源码】查，不对着 company.ts —— 基线里第二条加在别的
  // 模块上时，去桩图文件里找它的标注会得到一个错误的「已过期」。
  const byRel = new Map(mods.map((m) => [m.rel, m.text]));
  const wRel = new Set(WRITER_BASELINE.map((e) => e.rel));
  const writerStale = WRITER_BASELINE.filter(
    (e) =>
      !unguarded.includes(e.rel) || !(byRel.get(e.rel) ?? "").includes(e.mark),
  ).map((e) => e.rel);
  return {
    bodies,
    writes,
    baseline: checkBaseline(writes, mods, source),
    coverage: nodeCoverageProblems(bodies),
    assembly: assemblyCoverageProblems(source, bodies),
    unguarded: unguarded.filter((r) => !wRel.has(r)),
    writerAll: unguarded,
    writerBaselineStale: writerStale,
    edgeCount: writes.length,
    humanTos: [...humanSeatTargets()].sort(),
    source,
  };
}

/** 供测试与手工复核打印用。 */
export function describeWrites(writes: readonly WriteSite[]): string {
  return writes.map((w) => w.via + "→" + w.to).join(", ");
}

/** 跃迁合法性（测试用它证明「桩图产出的边都在 §7.1 里」这件事由别人管）。 */
export function isLegalEdge(from: TaskState, to: TaskState): boolean {
  return legalTransitionsFrom(from).includes(to);
}
