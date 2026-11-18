/**
 * 决策文档里的「文件:行号」引用会漂移，而且漂移逃过全部现有检查。
 *
 * 一条 foo.ts:150 写下去，就等于对那一行的内容下了一个隐式断言，却没有任何东西守着它。
 * 2026-11-08 真漂过一次：往 step-tx.test.ts 插入 38 行测试（提交 8f181cc），把 0006 里引用的
 * 两个行号推到了别的语句上。目标行【非空】，所以「越界」和「空行」都抓不到；注释不参与编译，
 * tsc 无感；它不是断言，测试也无感。0006 §7 第 1 条立过「写引用时同时写下核查命令」，可「记得去核实」
 * 正是那条规矩要消灭的东西 —— 所以这里把「目标行的内容」变成显式快照：行号一漂，立刻变红。
 *
 * 取舍一：只认完整形态 foo.ts:123。同一行里的缩写续写（写完 a.test.ts:276 之后接着写 :261）
 * 【不覆盖】。理由不是省事，是它无法可靠地从文本里挣出来：决策文档里的 JSON 样例同样长着 :42
 * 的样子，把它们当引用会造出大量假阳，而假阳一多，守卫就会被人关掉（0007 §4.1 记的正是这个
 * 代价：假红比假绿更贵，因为人会动手关掉它）。缩写引用紧跟在同一句的完整引用后面，漂一起漂、
 * 改一起改，这部分由人工承担。
 *
 * 取舍二：更好的写法本来是把行号换成可 grep 的特征串（0006 里那三处本轮就是这么改的）。本守卫不
 * 负责把谁的写法改掉，它只保证「行号一旦漂移立刻变红」，而不是等下次有人恰好记得去读那一行。
 *
 * SNAP 是快照。它【应当】随被引用文件的真实改动一起更新：那是唯一诚实的更新时机 —— 你在改代码，
 * 顺手看到快照红了，才需要去核对那句引用还成不成立。不要写自动重写快照的脚本：那等于把这条守卫
 * 变成它要防止的东西。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NL: string = String.fromCharCode(10);
const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 不在仓库源码树里的引用：@langchain/core 的构建产物，行号随发版漂移，允许存在但必须在这里报名。
// 不在名单里又找不到文件，就当作【写错了的文件名】报出来 —— 决策文档里写一个不存在的路径，与本
// 守卫要抓的是同一类假事实。
const EXTERNAL: ReadonlySet<string> = new Set(["outputs.d.ts"]);

const FILE_REF: RegExp =
  /([A-Za-z0-9_./-]+[.](?:ts|tsx|mts|cts|js|mjs|cjs|md|sql))[:]([0-9]+)/g;

type Ref = { doc: string; file: string; ln: number };
type Problem = { key: string; why: string };

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name === "node_modules" ||
      e.name === ".git" ||
      e.name === ".tmp" ||
      e.name === "dist"
    ) {
      continue;
    }
    const p: string = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p).split(sep).join("/"));
  }
}

function repoNames(): string[] {
  const out: string[] = [];
  walk(ROOT, out);
  return out.sort();
}

function decisionDocs(): Map<string, string> {
  const m: Map<string, string> = new Map();
  const docs: string[] = [];
  walk(join(ROOT, "docs"), docs);
  const collisions: string[] = [];
  for (const rel of docs
    .filter((p: string): boolean => p.endsWith(".md"))
    .sort()) {
    // 键用【基名】：SNAP 里那 300 多条键的既有形状就是 `<基名>>文件:行号`，改成相对路径会把
    // 全部历史键一次性判成孤儿 —— 那不是修守卫，那是把守卫的证据全清了。
    // 代价是基名必须唯一，所以唯一性当场判（见下）。
    const short: string = rel.split("/").pop() ?? rel;
    if (m.has(short)) collisions.push(short);
    m.set(short, readFileSync(join(ROOT, rel), "utf8"));
  }
  // 语料从「手挑三份」换成「docs/ 递归全量」，理由不是省事，是这一族缺口连着补了三级：
  // decisions/*.md（一直有）→ 主设计文档（round288 实测 5 条引用、其中 2 条当场就是坏的）
  // → INDEX（23 条、此前一条读者都没有）。每一级的动作都是「发现漏了一份 ⇒ 手工加一个键」，
  // 而**手工加的语料表没有任何东西判【漏】这件事** —— 只覆盖一半的守卫，它对没覆盖的那一半
  // 给出的「全绿」是**范围**的绿、不是**结论**的绿，而这两件事在终端上长得一模一样。
  // 现在新增一份带坐标的文档 ⇒ 它的坐标进语料 ⇒ 要么补快照，要么红。缺口的判定从「我来数」
  // 变成「门禁判」。round288 现跑：docs/ 下 73 份 .md，31 份含坐标，未覆盖 0 份。
  // ⚠ 键是基名而目录树里可能重名 ⇒ 重名会让后读的把先读的【静默顶掉】（Map.set 不报错），
  //   那是比重复更难发现的一种失效：语料少一份，而没有任何一发会红。所以它必须当场判。
  //   round288 现跑：73 份 .md 的基名零重复（`find docs -name '*.md' | sed 's|.*/||' | uniq -d`）。
  expect(collisions).toEqual([]);
  return m;
}

function extractRefs(docs: Map<string, string>): Ref[] {
  const refs: Ref[] = [];
  for (const [doc, text] of docs) {
    const lines: string[] = text.split(NL);
    for (const l of lines) {
      FILE_REF.lastIndex = 0;
      let m: RegExpExecArray | null = FILE_REF.exec(l);
      while (m !== null) {
        refs.push({ doc, file: m[1] ?? "", ln: Number(m[2]) });
        m = FILE_REF.exec(l);
      }
    }
  }
  return refs;
}

function keyOf(ref: Ref): string {
  return ref.doc + ">" + ref.file + ":" + ref.ln;
}

// 歧义要报：只写基名而有多个同名文件，说明这条引用没指定清楚是哪一个。
function resolveTarget(file: string, names: string[]): string | undefined {
  const direct: string[] = names.filter(
    (p: string): boolean => p === file || p.endsWith("/" + file),
  );
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const base: string = file.split("/").pop() ?? "";
  const byBase: string[] = names.filter((p: string): boolean =>
    p.endsWith("/" + base),
  );
  return byBase.length === 1 ? byBase[0] : undefined;
}

function verify(
  docs: Map<string, string>,
  names: string[],
  read: (rel: string) => string | undefined,
  snap: Record<string, string>,
): Problem[] {
  const problems: Problem[] = [];
  const seen: Set<string> = new Set();
  for (const ref of extractRefs(docs)) {
    if (ref.file === "" || EXTERNAL.has(ref.file)) continue;
    const key: string = keyOf(ref);
    const rel: string | undefined = resolveTarget(ref.file, names);
    if (rel === undefined) {
      problems.push({ key, why: "仓库里找不到该文件，或同名歧义没指定目录" });
      continue;
    }
    seen.add(key);
    const src: string[] | undefined = read(rel)?.split(NL);
    if (src === undefined) {
      problems.push({ key, why: "读不到目标文件" });
      continue;
    }
    if (ref.ln < 1 || ref.ln > src.length) {
      problems.push({ key, why: "越界：目标文件只有 " + src.length + " 行" });
      continue;
    }
    const text: string = (src[ref.ln - 1] ?? "").trim();
    if (text === "") {
      problems.push({ key, why: "目标行是空行，引用没有内容可指" });
      continue;
    }
    const want: string | undefined = snap[key];
    if (want === undefined)
      problems.push({
        key,
        why: "快照里没有这条引用（新增，或文档里已被改写）",
      });
    else if (want !== text)
      problems.push({
        key,
        why: "目标行内容与快照不符：快照 [" + want + "] 现在是 [" + text + "]",
      });
  }
  for (const key of Object.keys(snap)) {
    if (!seen.has(key))
      problems.push({ key, why: "快照里有，文档里已经没有这条引用" });
  }
  return problems;
}

const SNAP: Record<string, string> = {
  // 0041（引擎入口 work / decide）新写的一条，登记同轮完成（0006 §7-40 那条规矩）。
  // 先在 cards.test.ts 里 `sed -n '448p'` 读原文再抄，不从 0041 正文里复制措辞。
  // 键写【裸名】是实测过的：仓库里叫 cards.test.ts 的只有 packages/hub/test/approvals/ 那一个，
  // 而同一篇 §9 那条 `db/driver.ts` 必须带目录 —— 那正是本篇记的坑（多出一个同名文件）。
  // 这一条是**活坐标**：0041 §4 的论据是「卡片审计那行的 payload 形状跨生产者共用」，
  // 而那个形状的唯一钉子是这一行按【顶层键】读 approval_type ——
  // 有人把它改成嵌一层的读法，快照就该红，逼他重读 §4 那个「共用 kind 掩盖不共用部分」的坑。
  "0041-engine-entry-work-and-decide.md>cards.test.ts:505":
    'expect(payload["approval_type"]).toBe("escalation");',
  // 0025（Task 6.1 常驻 Hub）新写的一条。先在目标文件里 `sed -n '385p'` 读原文再抄，
  // 不凭记忆。写全路径与 0013/0016 那几组保持一致（基名这里其实也能唯一解析）。
  // 这一条是**活坐标**：0025 §0 的论据是「patrol.ts 自己明写了调度不属于它」，
  // 而那句话的价值全在【那一行现在还写着那句话】—— 有人把注释删了或改成「这里应该有调度」，
  // 快照就该红，逼他重读 §0。
  "0025-resident-hub-and-four-silent-bugs-i-wrote.md>packages/hub/src/heartbeat/patrol.ts:385":
    "* ⚠ 这里【故意】不 setInterval。调度（什么时候醒）属于常驻进程，",
  // 0016（Task 3.7）本轮新写的六条。同样是先在目标文件里 `sed -n '<n>p'` 读原文再抄。
  // 六条都写**全路径**，但**不是因为歧义** —— 实测这四个基名（role-memory.ts / real-deps.ts /
  // recorder.ts / audit-interrupt.test.ts）在仓库里各只有 1 个命中，写基名也能解析。
  // 我一开始在这里写的理由是「recorder.ts 有歧义」，那是没查就写的（0016 §6 那一族的当场复发）。
  // 真实理由只是【与 0013 那组的全路径写法保持一致】，而基名形态本身是合法的：
  // 0013 里同一行被引用两次（一次全路径、一次基名），所以那边**两条都要登记**。
  // 0016 那一组的行号在 Task 4.1 这一轮整体下移（role-memory +22、real-deps +123、
  // recorder +10 行）。逐条 sed -n '<n>p' 重读现场确认【引用的还是同一行、内容一字未变】
  // 之后才改的坐标 —— 不是按 diff 行数推算的（推算出来的那个数一旦中间还有别的改动就错，
  // 而本轮 real-deps.ts 恰好就不止一处改动）。这是本守卫第【五】次抓同一件事。
  //
  // ⚠ 这一格与下面两格（:587 / :703）后来又漂过一次，而这一次是【本文件改的那一发自己顶的】：
  // O3 把 is_decision 加成 GROUP BY 维度、又在文件尾加了今日探针，
  // role-memory.ts 上方净增一百多行 ⇒ 691→803 / 506→587 / 622→703。
  // ⚠ 而这三个数【在本篇写下之后又漂了一次】（803→834 / 587→618 / 703→734，增量 +31 三格相同，
  //   加的是文件头那三条实测的【现状】改写）—— 也就是说这段注释本身正在变成
  //   它自己所描述的那种东西：一句关于当前位置的、写给未来的人的谎。
  //   留着它，因为它比"这里有个坐标"多说了【为什么会有第二次】。
  // 上面那句"不是按 diff 行数推算的"因此不是空话 —— 推算会得到 691+112=803 而真是 803，
  // 但另一格 506→587 差 81、622→703 差 81，两处增量【不同】，按文件总增量推算必错一个。
  // 三条都是重新 sed -n 读出来再抄的。
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/memory/role-memory.ts:834":
    'has_review_decisions: decisions.some((r) => r.action === "review_decision"),',
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/http/real-deps.ts:298":
    'action: "approval",',
  // 291 → 298 是 0043 顶走的（real-deps.ts 文件头那条引擎 import + 适配器 +
  // 选路那一段，共 +156/-17）。但这一格真正的变化【不是行号】：
  // 0043 之后默认装配的 CEO 决策写在 engine/approve.ts，real-deps 这条
  // applyDecision 只在【显式交了图工厂】时才被走到。
  // 所以下面两格是【新增】而不是漂移 —— 它们把「同一个 action 值有两条写入路径」
  // 这件事钉在快照上：只留 real-deps 那一格的话，下一个读 0016 §4 的人
  // 会以为默认路线上没有写入方（0042 §7 抓的就是这一族：坐标没坏，指的东西换了）。
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/engine/approve.ts:408":
    "action: KIND_TO_ACTION.ApprovalDecided,",
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/events/recorder.ts:38":
    'ApprovalDecided: "approval",',
  // ── 0043 自己的五格活坐标 ────────────────────────────────────────────
  // 这四格合起来是 0043 §1 那句「报错教的那一步在这台机器上跑不起来」的【全部证据】：
  // cli.ts 顶层 import @langchain（本机装不上）⇒ hub resume 不可达 ⇒ 那次失败的副作用不可撤销。
  // 哪天 langchain 能装了、或者 cli.ts 拆出 langchain-free 的入口（那正是该做的事），
  // 第一格会红 —— 那时要改的不是快照，是 0043 §1 整段的结论。
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>cli.ts:28":
    'import { Command } from "@langchain/langgraph";',
  // HUMAN_EDGES 的类型那一行。0043 §6「只有 approve 有出边」这条现状的落点：
  // 出边这个维度的类型是 Partial<Record<"approve", …>> —— 不是运行时忘了填，是类型上就只有这一个键。
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>dispatch.ts:238":
    'export const HUMAN_EDGES: Readonly<Partial<Record<TaskState, Partial<Record<"approve", HumanEdge>>>>> = {',
  // 0043 §7 那张表的第三行：0016 那一格的【当前】落点。
  // 同一节里 0016 键下还有一格 real-deps.ts:298 —— 那是 applyDecision，
  // 只在【显式交了图工厂】时才被走到。两格一起读才说明
  // 「同一个 action 值今天有两条写入路径」这件事（0016 §4 那句话的结论没变，
  // 但只查一处会得出「默认路线上没有写入方」这个错结论）。
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>engine/approve.ts:408":
    "action: KIND_TO_ACTION.ApprovalDecided,",
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>recorder.ts:38":
    'ApprovalDecided: "approval",',
  // ── 0043 §10 补写那一节时带出的三条（本轮新登记，同 0006 §7-40 那条规矩：同轮登记）──
  // 这三格里【只有第一格是产品的行】，后两格指的是注释本身 —— 那两格守的是
  // 「注释里那句『实测（0043 §10）events 表零行』还在不在」。听起来没价值，
  // 而 0043 §10 的整段结论就是那一行探针实测：注释被删或被改写成"应该是零行"，
  // 结论的证据就没了，而没有任何一条测试会因为注释消失而红。
  // ⚠ recorder.ts 这一格本轮漂过一次（52 → 现在的 52 是对的，而它一度被误写成
  //   "MEMORY_ROWS_SQL 在那儿"）：那句话的**注释**在 recorder.ts:51，**SQL** 在
  //   role-memory.ts:222。同一个事实的两个出处，指错一个就会让人去改错的那个文件。
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>recorder.ts:52":
    'RoleTurnReported: "tool_call",',
  // ⚠ 这两条【必须带目录】：`charter.ts` 与 `charter.test.ts` 在仓库里各有两个命中
  //   （contracts/src 与 hub/src/engine；hub/test/roles 与 hub/test/engine），
  //   裸基名会被 resolveTarget 判成歧义而红 —— 那正是 0043 §5 自己记下的那个坑复发。
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>engine/charter.ts:351":
    "// 那些情况 costCents 恒为 0，探针实测（0043 §10）——",
  "0043-default-value-should-be-the-one-that-runs-and-a-500-that-lied-about-replaying.md>test/engine/charter.test.ts:331":
    "* 那些情况 costCents 恒为 0，实测（0043 §10）events 表【零行】。",
  // ── 0044（章程泵）这一组五格 ──────────────────────────────────────────
  // 前三格是【产品事实的出处】：任务一落地就在 CHARTER_PENDING（第一格，
  // 0044 §0 那条死路的起点）、起草一轮硬超时 180 秒（第二格，0044 §4 那条
  // 「起草比心跳慢三倍」的设计事实的另一半）、跳过那一轮的计数器（第三格，
  // 0044 §4 里我【撤回】了"静默跳过"那个说法，撤回的依据就是这一行 + 它下面那句 onError）。
  // 三格都是活坐标：被删或被改，0044 §0/§4 的结论跟着失效。
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>http/real-deps.ts:538":
    '"INSERT INTO tasks (id, parent_id, title, status, assigned_role, current_node, " +',
  // 坐标本轮从 :88 漂到 :111（同文件头部加了「今天唯一生效的安全边界」那段说明，+23 行）。
  // 这一格【内容没变、只有行号动】，正是快照最该被更新的那一种：内容串照抄不动，
  // 只把 key 换掉 —— 若顺手把内容也换成新行的样子，快照就再也证不了「那句话指的是同一段代码」。
  // ⚠ 第一次登记的是 :106，第二次是 :109，两次都被这条守卫判红：106 那行是裸一句 `}`，
  // 109 那行是 `timedOut = true;`。这不是守卫在闹脾气 —— 是我在同一个文件上边改边数，
  // 每次数完又往头部加了两行。**坐标要等那个文件停手之后再数**（详见 0044 §4 那段）。
  // 也正因为 key 存行号而值存内容，"看着像"的行号一个都混不过去。
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>engine/claude.ts:111":
    "}, i.timeoutMs ?? 180_000);",
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>serve/timer.ts:336":
    "skipped++;",
  // 0044 §9.2 第 1 条那条【证伪】的证据：CLI 那条路早就真跑过子进程，
  // 所以"本机验不了真子进程"那句从一开始就不成立。判的是【那一发用例真的存在】——
  // 它一旦被改名或删掉，那条证伪就失去出处，而文档会替它继续说话。
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>engine/work.test.ts:266":
    'it("CHARTER_PENDING ⇒ 起一轮起草、建出一张 charter 卡、任务【原地不动】、退出 0", async () => {',
  // ⚠ 后两格与前两格【形状不同】，这一点是这一组的内容而不是附带说明：
  // 它们不是"证据的出处"，而是 0044 §6 那条【撤回】里被点名"指错了"的坐标 ——
  // 文档引用它们正是为了说【这一行并不支持我原来那句话】。
  // 那还要不要登记？要。因为那条撤回自己做了一条**可核对的主张**
  // （"today.ts:41 是一句 import 注释"、"sse.ts:48 讲的是 seq 去重"），
  // 而快照正是让这种主张可核对的东西：有人把今天这两行挪走或改写，
  // 撤回那句话里"指错指在何处"的部分就过期，快照红 ⇒ 逼回来重读 §6。
  // 反过来说：如果因为"它们反正不是证据"就不登记，那条撤回就变成一句
  // 【只有作者读过、谁也无法复算】的话 —— 恰是 0016 §1 那族最难查的形状。
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>overview/today.ts:41":
    "// —— 同 `blocked_statuses` 那条「判据随响应发出」的立场。",
  "0044-charter-pump-where-do-cards-come-from-and-what-a-zero-cost-failure-costs.md>http/sse.ts:48":
    "/** 已经发出去的最大 seq。去重的唯一判据 —— 不看内容、不看 kind，只看 seq。 */",
  // 239 → 249：同一次改动带下来的漂移。engine/ 加第 9 个事件 kind RoleTurnReported 时
  // 往 KIND_TO_ACTION / targetOf 各加一条 case（+10 行），把 DEFAULT_ACTOR 顶下去。
  // 0016 §4 整段的论据是「节点执行的事件 actor 落成 system/hub」，那一行是它的出处，
  // 所以它必须跟着漂而不是删掉。
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/events/recorder.ts:249":
    'const DEFAULT_ACTOR = { actorType: "system", actorId: "hub" } as const;',
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/test/graph/audit-interrupt.test.ts:200":
    'expect(r[0]?.actor_type).toBe("system");',
  // 下面两条是 §4 那两个漏洞的**修法现场**。它们必须是活坐标：0016 §4 整段的论据是
  // 「判据写在哪一层粒度上决定了漏不漏」，而判据一旦被人从行级挪回桶级，
  // 那两行的内容必然变 —— 快照红的时候，正是该重读 §4 的时刻。
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/memory/role-memory.ts:618":
    "const strategic =",
  "0016-parallel-branches-role-memory-and-an-assertion-engine-that-saw-nothing.md>packages/hub/src/memory/role-memory.ts:734":
    "const ceoReadingOwn =",
  // 0015（Task 3.6）本轮新写的引用。逐条在被引用文件里 sed -n '<n>p' 读过原文再抄，
  // 不是从 0015 正文里复制措辞 —— 那等于让快照抄文档，守卫当场失效。
  // 其中 `org/commit.ts:109` 在同一篇里出现两次（表格 ①、§3 末），快照按 key 去重，一条即可。
  // 坐标顶漂账：107（原）→ 108（round292，那文件上面插了一条 import）→
  // 109（round294，`applyChangeToGraph` 的函数头加了三行 ⚠）。同一文件第二次顶漂同一格，
  // 值得记一句：一条【靠行号】成立的引用，漂一次是意外，漂两次说明那个文件头部一直在长。
  "0015-charter-editor-and-two-sources-of-budget.md>org/commit.ts:109":
    '"INSERT INTO role_charters (id, role_id, version, config, effective_from, created_by) " +',
  // 0015 §8 第三条引的是「bump 逐字复制上一版 config」那一句。正文写的是 368-374 这个区间，
  // 而提取器只认区间起点（取舍一），所以快照按 368 登记。
  // 顶漂账同上一条：304-310（原）→ 323-329（round292）→ 368-374（round294，
  // 漂得多是因为 `everyNodeDeclaresModelFamily` 那一跳的注释本轮重写过，+28 行）。
  "0015-charter-editor-and-two-sources-of-budget.md>org/commit.ts:368":
    "const config = JSON.parse(prev.config) as Record<string, unknown>;",
  "0015-charter-editor-and-two-sources-of-budget.md>0001_init.sql:144":
    "CREATE TABLE role_charters (",
  "0015-charter-editor-and-two-sources-of-budget.md>http/app.ts:1091":
    'consumed_cents: Number(r["consumed_cents"] ?? 0),',
  // 【round272 坐标 +11】tracker.ts 头部给三条 SQL 的导出加了说明块 ⇒ 下面两条同键一起漂。
  "0015-charter-editor-and-two-sources-of-budget.md>tracker.ts:244":
    "const breached = before <= limit && after > limit;",
  "0015-charter-editor-and-two-sources-of-budget.md>bus.ts:58":
    '| { kind: "BudgetPaused"; taskId: string; spentUsdCents: number }',
  "0015-charter-editor-and-two-sources-of-budget.md>tracker.ts:249":
    "taskId: input.taskId,",
  "0015-charter-editor-and-two-sources-of-budget.md>contracts/evidence.ts:165":
    '"dev_to_test": "code_diff",',
  "0006-cli-resume-and-identity.md>graph/thread.ts:24":
    "export function threadConfig(taskId: string): { configurable: { thread_id: string } } {",
  "0006-cli-resume-and-identity.md>graph/thread.ts:25":
    "return { configurable: { thread_id: taskId } };",
  "0006-cli-resume-and-identity.md>cli.ts:5":
    "* 验收对象是【命令行退出码】，必须能被真子进程执行来验证。计划 V13 实测过 ——",
  // 坐标漂过【两次】（原 :479 → :586 → :621）。第一次是 O1-1 的桩写权限守卫插进
  // cli.ts 上半部；第二次是 O1-2 之后 cmdRun 尾部那段「桩图跑到 END vs 等人批准」
  // 的分叉插在同一文件更靠上的位置。同一个形状：cli.ts 里任何一处上半部的插入都会
  // 把下面整体推下去。
  // 只换 key，内容串照抄【含那两个转义反斜杠】—— 内容里那对 \\n 正是这一行
  // 值得钉的地方（它拼的是"错误 + 用法"两段，写法写错就少一个空行）。
  "0006-cli-resume-and-identity.md>cli.ts:624":
    'io.error("错误：" + p.error + "\\n\\n" + USAGE + "\\n");',
  "0006-cli-resume-and-identity.md>write-queue.test.ts:206":
    'it("失败之后立刻 close()：不得重抛旧失败，且必须真的关掉连接", async () => {',
  // §7-39 里为了举证【真正的消费者一掏空就红】而写下的坐标；登记同轮完成，不留红过夜。
  // 漂过一次：原本是第 225 行，本轮在同文件上方新增一条 it（scoped 子包扫描的回归），
  // 把它顶到第 258 行 —— 行内容一字未变，只有编号动。这正是本守卫的设计用途：
  // 【引用没变错、目标没变错，只是行号动了】也要能被看见，不然「行号引用」这件事
  // 根本没有可靠性可言。0006 正文里那句历史叙述刻意写成「第 225 行」而不是坐标形态，
  // 因为守卫会把手写的每一个 文件:行号 都当成当下的活坐标来要快照。
  "0006-cli-resume-and-identity.md>production-deps.test.ts:274":
    "expect(isRuntimeFixture(BOUNDARY_PROBE)).toBe(true);",
  // 同一轮里第二次被 doc-refs 抓住：正文写了坐标却没登记快照；连着两次 => 【登记快照】
  // 已是写文档的固定动作，见 0006 §7-40。
  // 同样漂过【两次】（原 :489 → :596 → :631），同一个原因、同一个文件。
  // 这一格内容就是裸一句 `try {`，它唯一能证的是【那一行还在、还在原位附近】——
  // weaker 得很，但那是原作者挑的坐标（0007 §那张表逐处读 try/catch），本守卫不负责替谁改写法。
  "0007-test-type-coverage-blindspot.md>cli.ts:634": "try {",
  "0007-test-type-coverage-blindspot.md>db/driver.ts:64": "try {",
  "0007-test-type-coverage-blindspot.md>db/migrate.ts:120": "try {",
  "0007-test-type-coverage-blindspot.md>checkpoint/saver.ts:378": "try {",
  "0007-test-type-coverage-blindspot.md>checkpoint/tx-scope.ts:86": "try {",
  "0007-test-type-coverage-blindspot.md>graph/audit-middleware.ts:167": "try {",
  "0007-test-type-coverage-blindspot.md>db/migrate-cli.ts:120": "try {",
  "0007-test-type-coverage-blindspot.md>internal/direct-run.ts:19": "try {",
  // 235 → 258：Task 3.3 把 Writer / HubWriter 两个类型从 http/real-deps.ts 搬进
  // write-queue.ts（org/commit.ts 要排队写库，而 org/ 不该为了学「怎么排队」去 import
  // 一个 http 模块）。新增那 23 行落在 assertParamCount 之后、tx() 之前，
  // 于是 tx() 与 node() 里那两处 #rejected 各往下挪 23 行 —— 行内容一字未变。
  // 这是本守卫第【四】次抓到同一件事，而且这一次被挪的文件本身没被改坏：
  // 漂移是【搬类型】这种看起来最无害的改动带出来的。
  // 同一行里那个 `:284` 是简写形态（不带文件名），守卫不提取它 —— 所以那句
  // 【只登记一个坐标】是不够的：第二个站点靠人核对。本轮核对过：两处都是
  // `try {` + 紧接的 #rejected，判据不变。
  "0007-test-type-coverage-blindspot.md>db/write-queue.ts:258": "try {",
  // 369 → 375：本轮给 KIND_TO_ACTION / targetOf 各加了一条 case（新事件 kind
  // ApprovalDecided），把它下面那一行 try 顶下去 6 行。守卫又一次抓住同一件事：
  // 【代码没写错、文档也没写错，只是行号动了】。
  // 375 → 385：同一文件、同一原因，第二次。Task 4.1 加第 8 个事件 kind
  // ApprovalTokenRedeemed 时又往 KIND_TO_ACTION / targetOf 各加了一条 case（+10 行）。
  // 同一个坐标被顶两次、理由一模一样，说明【在表尾加 case】是这段代码的日常操作，
  // 而不是偶发事故 —— 这一格以后每次动那张表都要预期它漂。
  // 385 → 395：第三次，同一个原因。engine/ 那条路线加第 9 个事件 kind
  // RoleTurnReported 时又是这两张表各加一条 case（+10 行，见 0041）。
  // 三次同号同因 ⇒ 「加 case 会漂这一段」已经是这段代码的既有性质，
  // 谁的下一份改动没预期到它，就会再把这条守卫撞红一次。
  "0007-test-type-coverage-blindspot.md>events/recorder.ts:395": "try {",
  // 258 → 268：同一次改动带下来的【第二个】站点，同一文件同一原因。
  // 这一条不是 try 而是那句「默认必须【可见】而不是静默」的注释 —— 0007 §那一节
  // 整段的论据就是这句话存在而 onBroadcastError 在 test/ 里零命中，所以它必须跟着漂，
  // 不能为了省事把引用删掉（删引用在本守卫看来与「那句话失效了」是同一种无声）。
  "0007-test-type-coverage-blindspot.md>recorder.ts:268":
    "// 默认必须【可见】而不是静默：投影失败是可用性事故（前端看不到进度），",
  // 键从 `driver.ts:30` 改成 `db/driver.ts:30` —— 【文档正文跟着一起限定】。
  // 起因不是文件被改，是【仓库里多了一个同名文件】：engine/ 那条路线新增的
  // driver.ts（advance 那个循环）让 0007 里那个裸名坐标变成同名歧义，守卫直接拒答。
  // 这正是 0007 自己那句话要指的东西（openDb 的签名），所以修法是把坐标写全，
  // 而不是给守卫加「默认指 db/」的猜测规则 —— 那条规则下一次会指错。记在 0041 §9。
  "0007-test-type-coverage-blindspot.md>db/driver.ts:30":
    "export function openDb(path: string): DatabaseSync {",
  "0007-test-type-coverage-blindspot.md>driver-preflight.test.ts:17":
    'type Db = InstanceType<typeof import("node:sqlite")["DatabaseSync"]>;',
  "0007-test-type-coverage-blindspot.md>migrate.test.ts:16": "type Db = {",
  "0007-test-type-coverage-blindspot.md>schema-0001.test.ts:18": "type Db = {",
  "0007-test-type-coverage-blindspot.md>saver.contract.test.ts:447":
    "it.skip(title, fn);",
  // 0010 里那两条【承重实测】的出处。它们必须是活坐标而不是叙述：
  // 0010 §3 那一条改动的整个论据是「txScope 在 BEGIN 与 COMMIT 之间 await」，
  // 另一条给出的是 5000ms 这个具体数字（P5 那次「等了 5444ms 才报错」的出处）。
  // 任何一处挪动，都意味着 0010 那一段要么写错、要么已经不再成立。
  "0010-approval-write-path-and-lock.md>checkpoint/tx-scope.ts:82":
    "const result = await body();",
  "0010-approval-write-path-and-lock.md>db/pragmas.ts:19":
    "export const BUSY_TIMEOUT_MS = 5000;",
  // 0012 的三条活坐标。第一条是本篇整篇的**前提**：那个 `DEFAULT 1` 就是
  // 「每条任务的 graph_version 都是假的 1」这个论断的出处。它一旦被人改成
  // DEFAULT 0、或补上一个真的 v1 种子行，0012 §1 那段论证当场失效 ——
  // 所以它必须是活坐标，不能写成「初始化迁移里那个默认值」这种 grep 不出的叙述。
  "0012-org-versioned-commit-and-unwritten-graph-version.md>0001_init.sql:49":
    "graph_version INTEGER NOT NULL DEFAULT 1   -- 创建时组织图版本（§18.4）",
  // 后两条是 §7 那次【撤回】的替身：我原先拿「规格不列端点」当「端点名是冻结值」的依据，
  // 实测规格零命中，真正的契约面是下面这张表。登记的用处不只是举证，
  // 而是**下一次加端点时必须有人动这张表**：那张表一动，这段论证就要被重读一遍。
  // 注：`api.ts` 这个基名【有歧义】（另有 packages/desktop/src/preload/api.ts），
  // 所以两条都得写全路径 —— 只写 `api.ts:56` 会被 resolveTarget 判成歧义并报错。
  // 这是本守卫抓的第三类问题：前两类是行号漂移与目标行改写，这一类是【同名文件没指定目录】。
  //
  // 第二条的**行号在本篇写完后动过一次**（56 → 64）：Task 3.4 把 replay 搬进
  // IMPLEMENTED 之后，那张表头上多注释了一段。这正是活坐标该有的反应 ——
  // 快照当场红，逼人重读那段论证，而不是让文档继续指着一句 `/**` 讲 UNIMPLEMENTED。
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:40":
    "export const API_ENDPOINTS = [",
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:99":
    "export const UNIMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [];",
  // 0013 §10.1 那次【撤回】的三块砖。这一组与前面几组的性质不同：前面抓的是
  // 「文档引用的那行代码挪了」，这一组抓的是「文档引用的那条**注释**不再成立」。
  // real-deps.ts:7 那句注释是本篇结论的**反方证据**（它写着「0 命中」，
  // 而我曾据同一份文件写出「approvals 有写入方」）—— 注释一旦被改，
  // §10.1 整段论证要么已过期要么曾经就错，所以它必须是活坐标。
  // 同一条注释在 0013 里被引用两次（§10.1 用全路径、§11 用基名），
  // 守卫按字面提两个 key，所以这里也登记两条 —— 少一条就红，这是设计而非冗余。
  "0013-replay-timeline-search-and-a-test-with-zero-discriminating-power.md>packages/hub/src/http/real-deps.ts:7":
    '*   · `grep -rn "INSERT INTO approvals\\|UPDATE approvals" packages/hub/src` ⇒ 0 命中',
  "0013-replay-timeline-search-and-a-test-with-zero-discriminating-power.md>real-deps.ts:7":
    '*   · `grep -rn "INSERT INTO approvals\\|UPDATE approvals" packages/hub/src` ⇒ 0 命中',
  // 全仓唯一那句「写 approvals」的 SQL：它是 UPDATE 而不是 INSERT，
  // 所以「有写入方」这句话错在这里。行内容改写（比如补一列 auto_approved_by）
  // 会当场让 0013 §10 那张表的第二行变红 —— 而那正是应该重读它的时刻。
  // ⚠「全仓唯一」这半句【已经不再成立，原文留着】：0026 加了 approvals/cards.ts 的
  // INSERT_CARD_SQL，那句 grep 现在是 INSERT 1 处 + UPDATE 3 处（另一条 UPDATE 在
  // policy/auto-approve.ts）。这一格仍然值得当活坐标，但它的意义变了：
  // 原本它证的是「只有 UPDATE 没有 INSERT」，现在它证的是「CEO 那条认领 SQL 的形状还在」。
  "0013-replay-timeline-search-and-a-test-with-zero-discriminating-power.md>real-deps.ts:207":
    '"UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? " +',
  // 「条件写匹配 0 行 ⇒ 安静地什么都不发生」这一条实测的出处。
  // 它是 §10.1 末段那条「Task 3.5 必须带存在性断言」的判据来源。
  "0013-replay-timeline-search-and-a-test-with-zero-discriminating-power.md>real-deps.ts:286":
    "if (Number(info.changes) === 0) return null; // 没抢到：不写审计",
  // 0002 §4 那条「schema 看着开放」论证的唯一落点：platform 那一列的注释枚举了三个平台。
  // 它必须是活坐标 —— 那篇的排除理由里【最硬的一条】依赖「这套形状从第一天起没给个人微信留位」，
  // 而那件事的全部证据就是这一行的注释。注释一改（加第四个平台、或干脆删掉注释），
  // 那条论证就需要重读，而不是继续被引用。
  "0002-no-personal-wechat.md>packages/hub/resources/migrations/0001_init.sql:251":
    "platform TEXT NOT NULL,                    -- 'feishu'|'wecom'|'qq'",
  // 0028 §2 那处【我写错的事实】的全部证据就是这一行 —— 那篇说「表在而读写方 0」，
  // 而「表在」这件事除了这个坐标没有任何别的东西能证。所以它必须是活坐标：
  // 哪天有人删了这张表（我那句错的注释就【变成对的了】，而那意味着 §2 整节的
  // 结论「接上去就行」当场作废），这条引用会先红，逼重读那一篇。
  "0028-channel-abstraction-and-a-table-i-said-did-not-exist.md>resources/migrations/0001_init.sql:249":
    "CREATE TABLE im_bindings (",
  // 同一篇里那句结论被引用了【两次】（§0 那张表用全路径、§2 正文用短名）。
  // 两个键都登记而不是把正文改成不复述 —— 复述是有意为之：那处错的事实就是靠
  // 「反复去 grep 同一张表」才被抓出来的，让读者在两处都能点回原文是目的的一部分。
  "0028-channel-abstraction-and-a-table-i-said-did-not-exist.md>0001_init.sql:249":
    "CREATE TABLE im_bindings (",
  // 0030（IM 身份绑定）这一组八条。同样是先在目标文件里 `sed -n '<n>p'` 读原文再抄，
  // 不凭记忆 —— 而这一轮**真的靠记忆错过一次**：正文先写的是 `app.ts:380`，
  // 而 `const impossible: never = routeHit` 在 379，380 是下面那句 `throw new Error(`。
  // 两行都在同一段错误处理里，读起来「差不多对」，而守卫只认逐字 ——
  // 这就是【抄之前先读】这条动作存在的全部理由（0006 §7-40 同一族）。
  // 另：`contracts/src/api.ts` 那两条**必须带目录** —— 仓库里有【两个】 api.ts
  // （contracts 那份与 desktop/preload 那份），只写基名会被 resolveTarget 判成歧义。
  // 这一发也是当场撞出来的：第一版写裸基名，守卫报的是「找不到该文件，或同名歧义」。
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>0001_init.sql:249":
    "CREATE TABLE im_bindings (",
  // ⚠ round283 这一格【内容没变、只有行号动】：602 → 607，因为 abstraction.ts 头部
  // 那段「通电只到入站那一半」的说明改成了过期标注（+5 行）。按 0044 那一组的口径：
  // 内容串照抄不动，只换 key —— 把内容也换成新行的样子，快照就再也证不了
  // 「0030 §0 那句话指的是同一段代码」。
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>channels/abstraction.ts:607":
    "readonly actorFor?: (actor: ChannelActor) => ChannelActor | null;",
  // §9 那六条是**活坐标**：那一段的整段论据是「哪些接线代价真无人守、哪些有人守」。
  // 下面每一条都在守【那一句判据还在】—— 有人把 `EXPOSED_ENDPOINTS` 从别名改成手抄、
  // 把那个 `never` 赋值删掉、或改掉 `ipc-surface.test.ts:129` 那条包含断言，
  // 0030 §9 那句「真正无人断言的只剩『已实现而未接桌面』这一个方向」就不再成立，
  // 而它是 CEO 拍不拍那一项的**唯一**依据。快照在这里红了就是逼重读 §9。
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>contracts/src/api.ts:40":
    "export const API_ENDPOINTS = [",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>contracts/src/api.ts:73":
    "export const IMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>ipc-surface.ts:171":
    "export const EXPOSED_ENDPOINTS: readonly ApiEndpoint[] = IMPLEMENTED_ENDPOINTS;",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>app.ts:539":
    "const impossible: never = routeHit;",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>ipc-surface.test.ts:129":
    "expect(API_ENDPOINTS).toContain(s.endpoint);",
  "0030-im-binding-identity-and-three-holes-i-did-not-design.md>ipc-surface.ts:179":
    "* 端点 → 一个 IPC 通道名。【未实现的端点返回 null】，理由见 EXPOSED_ENDPOINTS。",
  // 0031（绑定那四条 HTTP 入口）这一组四条。同样是先 `sed -n '<n>p'` 读原文再抄。
  // 三条是**活坐标**，各守一段会被「顺手改掉」的判据：
  //  · `ipc-surface.ts:111` 守的是【三条写路由刻意没有 IPC 通道】这个判断本身 ——
  //    有人补上通道时，那一行必然被改写，而 0031 §3 整节就是那句判断的理由；
  //  · `bindings.ts:132` 守的是【脏行跳过住在 im.ts 不在 HTTP 层重做】的分工方向；
  //  · `bindings.ts:193` 守的是【knownRoles 未注入 ⇒ unknown_role 结构上不可达】，
  //    也就是 0031 §0 末尾那句「角色存在性今天仍然空转」的唯一落点。
  // 第四条（测试文件那一发）守的是 §4 那一次假绿的**现场**：那发断言一旦被人删掉或放宽，
  // 「服务端来源优先」这个判据就没有行为测试了，而那正是本篇最贵的一格。
  "0031-binding-http-entry-and-a-false-green-i-recorded-as-a-test-result.md>ipc-surface.ts:111":
    "* 为什么【只有读】这一条通道，而 `POST /bindings` / `/verify` / `/rebind`",
  "0031-binding-http-entry-and-a-false-green-i-recorded-as-a-test-result.md>http/bindings.ts:132":
    "* ⚠ 脏行【被跳过】而不是 500。这个决定发生在 im.ts 的 listBindings",
  "0031-binding-http-entry-and-a-false-green-i-recorded-as-a-test-result.md>http/bindings.ts:193":
    "// 0030 §8：角色存在性的判据【需要装配方注入 knownRoles】，本模块不猜。",
  "0031-binding-http-entry-and-a-false-green-i-recorded-as-a-test-result.md>bindings-route.test.ts:473":
    'it("⭐ 请求体里塞 verified_by ⇒ 422，且库里那一行【不会因为多带一个键就被署名】", async () => {',
  // 0035 这一条是**活坐标**，而且比上面几条更脆 —— 它指向本篇自己新写的那个文件的文件头
  // 第 4 行（「为什么需要这一处」那一行）。它脆是对的：那一行整篇的起因（0025 §7 那一格留给
  // 「独立一篇」的东西）。有人把它删了或改成「这里已按 pid 分目录」，快照就该红，
  // 逼他重读 0035 §1 那张三行对照表，而不是让文档继续指着一句 `/**` 讲竞态。
  // ⚠ 快照存的是目标行 **`.trim()` 之后**的内容（`verify` 那边就这么比）。我第一版照抄了
  // JSDoc 里那个前导空格，于是红在「一个缩进空格」上，而它读起来像「目标行被人改了」——
  // 一条噪音伪装成一条结论（0033 §0 那一族）。上面 0030 那条 `* 端点 → …` 同样是 trim 过的，
  // 口径一直如此，错的是我抄的时候没读比对口径（0035 §5.1 那条「先读判据再写『照判据数过』」的第三次）。
  "0035-fixture-dirs-per-process-and-a-guard-whose-scope-empties-itself.md>fixture-dir.ts:4":
    "* ── 为什么需要这一处（0025 §7 第 7 条那一格）─────────────────────────",
  // 0037 这一组六条。⚠ 其中两条（assemble.ts:291 / maintenance.ts:479）抄下来是
  // `if (!existsSync(dbPath)) {` —— 一行**在任何仓库里都长得一样**的代码。
  // 我差点因此不登记它们（「这种行变了也没信息量」），但那样做等于把本节的口径改成
  // 「只给有意思的行登记快照」，而那条口径没有判据、只有我的口味。
  // 这里它们真正证的是**位置**：0037 §1.2 的结论是「库路径打错走不到那个闸门，
  // 因为在这两行就退回 EXIT_USAGE 了」—— 那两行一旦被删（把存在性检查挪走），
  // 「走不到」这个结论就失效，快照红得其所。
  // ⚠ 0038 改了几行的行号，这一组五条全部重抄（sed -n '<n>p' 逐条重读）。
  //   · integrity.test.ts:339 → 426（① 组在 339 之后插了两发）
  //   · integrity.ts:179 → 282（pageCheckCell 前移；那一行从 `page.ok ? "ok" : "violated"`
  //     变成新的三目，快照跟着内容走，这正是「0037 §1.2 说 0038 会改这一行」的应验）
  //   · assemble.ts:291 → 305；maintenance.ts:479 → 529（都是前面被插入的内容顶下去的）
  //   · integrity.ts:1135 → 1200（pageIntegrityBroken 的注释加长了）
  //   · 0064 又改 gateEvidenceCheck 的 not_observable 文案（+3 行）：integrity.ts:1216 → 1219
  //     （sed -n '1219p' 重读后再改键 —— 0016 那条「别按 diff 行数推算」的规矩）
  //   round298 又漂一次，且【三个不同的偏移量】：integrity.ts 里 import 之上 +0、
  //   import 与 CHECK_NAMES 之下 +2、新加的那 170 行委派边自检之下 +170（1219→1389）；
  //   测试文件只多了一条 import ⇒ +1。逐条 sed 重读目标行确认【内容一字未动】，
  //   漂移全部来自「上方插了东西」—— 与下面那条 305→316→370→399→460 的账同形。
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>integrity.test.ts:427":
    "expect(viaWorker.unavailable).toBeUndefined();",
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>integrity.ts:293":
    'verdict: page.ok ? "ok" : instrumentBroke ? "could_not_run" : "violated",',
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>integrity.ts:113":
    "export const INTEGRITY_FAILURES = [",
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>integrity.ts:1389":
    '* `verdict === "not_observable"` / `"could_not_run"` 都【不算】损坏：',
  // 305 → 316 → 370 → 399 → 460：每一次漂移都是【同一文件上方被插入内容顶下去】（0043 的引擎 import
  // 与 0044 的泵那两段；399 那一次是 0048 的驱动器那两段；460 这一次是 round281 的
  // BootOverrides.env / imFetchImpl 两格 + BootResult.imWired + boot 里的 IM 装配那一段）。
  // ⚠ 这里我【没有】按 diff 行数推算 ——
  // 0016 那一组已经因为推算被抓过第五次。改坐标前 `sed -n '460p' packages/hub/src/serve/assemble.ts`
  // 读过原文，确认还是那一行 `if (!existsSync(dbPath)) {` 才写。
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>assemble.ts:460":
    "if (!existsSync(dbPath)) {",
  "0037-worker-import-in-threads-and-my-first-fix-was-wrong.md>maintenance.ts:529":
    "if (!existsSync(dbPath)) {",
  // 0038：本篇自己引用了 maintenance.ts:290（它讲「这一行原本就地内联」）。
  // 一行指向「被 0038 改过的那一行」的引用，正是活坐标该被钉住的形状。
  "0038-page-integrity-vocabulary-and-a-machine-to-boot-on.md>maintenance.ts:290":
    '// （`page.verdict === "violated"`）。而 `pageIntegrityBroken` 的注释一直写着',
  // 0039：本篇引用了 harness-invariants.ts:157 —— 那条「requireAssertions 必须为 true」
  // 的守卫。0039 改了 vitest.config.ts 的注释但没动开关，这句引用钉住「那条守卫还在这一行」。
  // 行号从 :156 漂到 :157 是 round277 在它上面加了一行 import（walkFiles 要排运行期夹具）。
  "0039-vitest-installs-and-coverage-attribution-still-does-not.md>harness-invariants.ts:157":
    "if (input.requireAssertions !== REQUIRED_REQUIRE_ASSERTIONS) {",
  // 0042（今日视图 + §16 控制室）这一组八条。同样是先在目标文件里 `sed -n '<n>p'` 读原文再抄。
  // 其中【两条是活坐标，各守一句会被顺手改掉的判断】，其余是「本篇论点挂在那一行上」的锚点：
  //  · `org/graph.ts:65` 守的是 §10 那条「加 tier 是一次契约变更」的前提 —— 那个 `.strict()`
  //    一旦被人摘掉（或 schema 长出 tier），0042 §10 那句「需要契约变更」就不再成立，
  //    而它是 CEO 拍不拍那一格的唯一依据；
  //  · `ipc-surface.ts:171` 守的是 §5 那句「EXPOSED 是别名，名为暴露实为已实现」——
  //    有人把它改成手抄白名单，0042 §5 整节（连同那条把不一致本身钉住的断言）就该重读。
  // 最后一条【带了一层目录】（`http/real-deps.ts`）而不是裸基名：0030 §9 撞过一次同名歧义
  // （contracts 与 desktop/preload 各有一个 api.ts，裸基名会被 resolveTarget 判成歧义），
  // real-deps.ts 今天全仓唯一，但「今天唯一」在 import 图上看不见 —— 补一层目录是零成本的防线。
  // 它指向的正是 0042 §7 末尾说的那颗【已埋的假红】（那句注释只差没跟一对括号）：
  // 将来 `callersOf("insertCard")` 因为一句补了括号的注释而误报时，这条快照会先红并指回这一组注释。
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/web/public/app.js:445":
    "attention === null ? false : attention.includes(tk.status) || overBudget(tk);",
  // 【round272 这一组从两条变一条】：原来 0042 §2 说「两处 INSERT」，键自然两条
  // （runtime.ts:156 + tracker.ts:70；那条 runtime 坐标历史上还漂过 :135→:137→:156，
  // 每次都是它上面加了 import —— 见 0045 那一组同族叙述）。runtime 那份手抄 SQL 本轮删了 ——
  // 引擎路线 import 的就是 tracker 这一条，scope/period 改成绑参
  // ⇒ 主张对象收敛成【一语句两调用点】，而那一行今天只有【一处】写着这句 INSERT。
  // 快照跟着从两条并成一条：留着第二条就得给一个已经不存在的手抄副本编一行号，
  // 那是把守卫变成改历史。
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/hub/src/budget/tracker.ts:81":
    '"INSERT INTO budget_events (source_event, scope_type, scope_id, period, amount_cents, task_id, created_at) " +',
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/contracts/src/org/graph.ts:65":
    "export const orgNodeSchema = z",
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/hub/src/overview/today.ts:111":
    'export const ATTENTION_STATUSES: readonly string[] = ["ESCALATED_TO_CEO", ...BLOCKED_STATUSES];',
  // 0045（任务级预算那道门）新写的两条，登记同轮完成（0006 §7-40 那条规矩），
  // 且都是【活坐标】—— 它们的价值全在"那一行现在还写着那句话"：
  //  ① runtime.ts:132 是 §1 那张表的成因（`ENSERT_TASK_BUDGET_SQL` 的 DO NOTHING
  //     ⇒ budgets.limit_cents 第一次写完再也不改）。有人把它改成 DO UPDATE，
  //     0045 §4「上限那一侧读参数」的那条理由就作废了，快照红逼他回去改 §4 与门本身。
  //  ② today.ts:338 是「门与预算条读同一个累加器」这条取舍的**对面那一侧**：
  //     今日视图求和的正是 budgets.consumed_cents。它若改成读别的列，
  //     §4 那句"读另一列就是再造一个两源分叉"当场失效。
  // ⚠ 上面 ② 与下面那条 key 的行号在 0049 那轮从 263 顶到 293（today.ts 上方加了 29 行，
  //   其中 211 行以后是 driver 那一格）。**而 ① 也被顶过一次**：0049 那轮写下的
  //   「① 的 runtime.ts:109 没动，因为它上面没加东西」在 0050 那轮【作废】——
  //   0050 在 runtime.ts 上方加了 `REJECTION_COUNT_SQL` 那一格，109 → 132。
  //   留着这一句而不是删掉它，是因为它正是这类注释的命运样本：
  //   "它上面没加东西"是一个【关于未来的断言】，而写下它的人不在场。
  //   这里特意留下"原来是 263 / 原来是 109"这两句，是为了让下一次读到红的人知道
  //   **这次移动过**：快照本身只说"现在那一行写着什么"，而"它被顶过几次"是另一件事
  //   （0015 §8 那段同族）。
  // ① 的坐标本轮又从 :132 漂到 :134（runtime.ts 头部加岗位书的两行 import）。
  // 上面那段「它上面没加东西」的注释【第二次】作废，同一句理由再抄一遍没意义，
  // 只记一句：这次是 +2，加的是 import 而不是正文，也就是说
  // 【连"我只是在文件头加了一行 import"都会顶到下面所有坐标】。
  // 【round272 换了文件】：这条原本指 `engine/runtime.ts:153` 的手抄副本
  // `ENSERT_TASK_BUDGET_SQL`（它自己就漂过 :132→:134→:153，两次都是上面加 import）。
  // 那份副本本轮删了 —— 引擎路线 import 的就是 tracker 这一条，所以 DO NOTHING 这件事
  // 现在只有一处可看。快照指过去，内容串照抄不动：0045 §1 那句「第一次写进去就再也不改」
  // 依赖的正是这一行，它换了住址而没换语义。
  "0045-task-budget-gate-and-a-parameter-that-only-existed-on-the-cli.md>packages/hub/src/budget/tracker.ts:77":
    '"INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) " +',
  "0045-task-budget-gate-and-a-parameter-that-only-existed-on-the-cli.md>packages/hub/src/overview/today.ts:338":
    '"SELECT COUNT(*) AS scopes, COALESCE(SUM(consumed_cents), 0) AS consumed, " +',
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/hub/src/charter/budget-sync.ts:449":
    "export function silentOverBudgets(db: DatabaseSync): BudgetTierRow[] {",
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>packages/desktop/src/ipc-surface.ts:171":
    "export const EXPOSED_ENDPOINTS: readonly ApiEndpoint[] = IMPLEMENTED_ENDPOINTS;",
  "0042-today-view-and-putting-the-criteria-on-the-server-side.md>http/real-deps.ts:587":
    "* 放进那一个事务里（与 insertCard 同事务，理由写在 cards.ts createCard 第 ① 条），",
  // ── 0048 §4.2 ───────────────────────────────────────────────────────────
  // dispatch 成功那一支返回的对象里 `seat` 是**写死的 "agent"**。
  // 0048 §4.2 那条「harness_calls.exit_code 分的是『有没有放 agent 进场』而不是
  // 『这一轮成不成』」整段结论就挂在这一格上：如果哪天成功支改成回传真实席位
  // （例如落点是人席时回 "human"），§4.2 那张表的后两行就要重写 ——
  // 快照在这里红，就是逼回来重读那张表，而不是让文档继续指着一个不再写死的值讲"写死"。
  "0048-driver-pump-who-presses-enter-after-the-ceo-approves.md>dispatch.ts:1630":
    'seat: "agent",',
  // ── 0049 §7：夹具翻车现场的【写入方】坐标 ────────────────────────────────
  // 这三条不是"活坐标"（没有判据挂在"那一行还写着这句话"上），它们守的是
  // **本篇 §7 那句"都是真库挡下来的，不是我看出来的"能不能被复算**：
  // 那三条夹具缺陷各自撞的是哪一条约束，只有落到具体那一行才可复查。
  // 尤其第 ③ 条 —— `PRAGMA foreign_keys = ON` 一旦被谁关掉，§7 第三发那个
  // 「先写事件再写任务」的顺序就不再抛错，而那时"外键挡过我"这句话就成了
  // 一句读不出真假的往事（本仓抓过的那族：注释承诺了实现已经不再具备的性质）。
  // ⚠ 0001_init.sql 只有 `packages/hub/resources/migrations/` 下一份（find 实测 1 个），
  //   所以文档里写基名不歧义；而它【不是】.ts，改迁移会换行号 —— 这正是快照在这儿的用场。
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>0001_init.sql:167":
    "id TEXT PRIMARY KEY,",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>0001_init.sql:175":
    "CREATE UNIQUE INDEX idx_budgets_scope ON budgets(scope_type, scope_id, period);",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>pragmas.ts:28":
    'db.exec("PRAGMA foreign_keys = ON;");',
  // ── 0049 §11.2 / §12：调研与探针的【现场坐标】────────────────────────────
  // 这一组守的不是"判据还写着那句话"，而是**那几条结论还能不能被复算**：
  //  §11.2 那三条（`createCard` 零生产调用方 / `insertCard` 有三个真调用方 /
  //    `auto-approve.ts` 那句现在时断言已过期）每一条都指着一个具体那一行，
  //    行号漂了那三条就退化成"某人说过"，而复算的人连从哪一行开始看都不知道。
  //  §12 那两条是"追加预算那颗按钮为什么是空按钮"这条判断的**唯一物证**：
  //    `driver-pump.ts:487` 绑的是 `o.taskLimitCents`（门读参数），
  //    `today.ts:339` 求和的是 `limit_cents`（界面读那一列）。
  //    ⚠ 这两行**必须同时被改**才不会造出"屏幕上没超而门挡着"那种分叉 ——
  //    快照在这里红，就是逼改的人去看另一侧动没动，而不是各自改各自的。
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>seat-card.ts:254":
    "const res = insertCard(db, draft, { nowMs: o.nowMs });",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>engine/charter.ts:449":
    "const card = insertCard(db, cardDraft, { nowMs: o.nowMs });",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>dispatch.ts:1519":
    "const res = insertCard(db, p.draft, { nowMs: o.nowMs });",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>policy/auto-approve.ts:442":
    "//   「① 那一行不存在（今天的真库就是这种：src 里没有任何 INSERT INTO approvals）；」",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>cards.ts:252":
    '"INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +',
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>charter-pump.test.ts:248":
    "function pendingCards(w: World, taskId: string): number {",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>serve/driver-pump.ts:487":
    ".all(...states, maxAttempts, o.taskLimitCents, perRound) as unknown as {",
  "0049-driver-status-on-the-board-and-a-bind-order-bug-that-was-green.md>today.ts:339":
    '"COALESCE(SUM(limit_cents), 0) AS declared FROM budgets WHERE scope_type = ? AND period = ?";',
  // ── 0050 §6：打回那条边，以及它新造出来的那个循环 ──────────────────────
  // 这批里只有两格是【活坐标】（主张的形状就是"那一行现在写着这句话"）：
  //  · runtime.ts:112 —— `REJECTION_COUNT_SQL` 那一行本身，它就是 §4.2.1 那个分子的实现。
  //    漂了要回来重读 0050 §6.5（为什么数 `payload.$.to` 而**不数** `action`：
  //    一次打回写两条 state_change 边，数 action 会恒翻倍 ⇒ 上限提前一倍咬）。
  //  · status.ts:59 —— 合法表里那条**一直存在**的补边。它是"三张表两有一无"里
  //    **有**的那一张；将来有人删了它，0050 §6.1 那句"合法表说有"就作废。
  // 其余是**登记**性质（正文写了坐标就同轮登记，0006 §7-40），不挂判据。
  // ⚠ 这里的键全部是**文档里写的那个形态**（`dispatch.ts:101` 而不是全路径），
  //   因为 verify 用的是 `doc + ">" + ref.file + ":" + ref.ln`，而 ref.file 是
  //   **正则从正文里抓到的那段字符**。写成解析后的全路径会得到"两边各说一半"：
  //   那一批条目**全部**报"快照里没有"，同时每一条**又**报"快照里有而文档里没有"——
  //   我第一次插就是错的这一边，两条错向**互相掩护**（总数看着只多不少）。
  // ⚠ 这里**只有 13 条而正文有 14 处引用**：`INDEX.md:382` 那一条登记过一次又被删掉，
  //   删的原因是它**自我拆台** —— 主张是「本仓有这种形状」（一个关于先例的主张），
  //   而 `INDEX.md` 正是每篇都要往上插条目而**必然漂移**的那个文件：
  //   我插 0050 自己那一条的时候，就把刚登记好的那一行顶走了。
  //   行号对这个主张不是证据，正文里那段**逐字引文**才是（0048 §9 同一条判断）。
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>app.js:528":
    "msg: \"这台 Hub 没开驱动器：想法停在 agent 那一格之后，不会有任何东西去推它。要自动推进请带 --driver-pump 起 Hub，或手工 hub work。\",",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>app.js:675":
    "<span class=\"pill ${statusClass(tk.status)}\">${esc(tk.status)}</span>",
  // 275 → 290 与 1667 → 1904：round281 在 BootOverrides 加了 env / imFetchImpl 两格、
  // 在 BootResult 加了 imWired、在 boot 里加了 IM 装配 + 横幅 + 心跳派发三段，
  // 同一文件下方的行整体下移。⚠ 两个新坐标都是 `sed -n '<N>p'` 读过原文才写的，
  // 没有按 diff 推算（0016 那一组已经因为推算被抓过第五次）。
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>assemble.ts:290":
    "readonly driverMaxAttempts?: number;",
  // 漂过【两次】，同一个原因（round284 给外网 HTTP 补自设截止时，在同文件上方改了
  // 几处「那发 fetch 没有 deadline」的注释，把它一路顶下去）：:1904 → :1911 → :1913。
  // 行内容一字未动 ⇒ 按 0044 的家规只挪 key，快照那句不改。新行号是守卫报的，
  // 不是按 diff 推算的（0057 那条：同一轮里同一个坐标按推断错过两次）。
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>assemble.ts:1913":
    "* ⚠ 这里【不】列驱动器的按格尝试上限（maxAttempts）与每任务轮数（maxTurns）：",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:102":
    "DECOMPOSING: { handoff: { to: \"IN_PROGRESS\", next: \"target\", why: \"拆解完成，活儿交给被点名的角色\" } },",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>dispatch.ts:1385":
    "action: \"state_change\",",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>driver-pump.ts:354":
    "* 这个数字【不是预算】，是最后一道闸 —— advance 文件头写的就是\"防上面两条判据被",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>graph/company.ts:281":
    "if (state.current === \"REJECTED_DOWNWARD\") await write(\"IN_PROGRESS\");",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>heartbeat/patrol.ts:139":
    "export function kindOf(alias: string): string {",
  // :108 → :110 → :112 → :117（每一次都是 runtime.ts 头部加了 import）。
  // 这一格是【活坐标】：0050 §6.5 那个「数 payload.$.to 而不数 action」的分子就是这一行实现的。
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>runtime.ts:117":
    "export const REJECTION_COUNT_SQL =",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>status-machine.test.ts:172":
    "it(\"§7.1 未给出路的三态【当前】是死路 —— 显式钉住这个已知缺口\", () => {",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>status.ts:59":
    "REJECTED_DOWNWARD: [",
  "0050-abandoned-task-never-resumes-and-a-knob-that-does-not-exist.md>today.ts:58":
    "* 不含 `MEETING_REQUIRED`：它同样是死路（出边空数组），但规格里它的名字属于【会议】",
  // 0051（端到端那一发）两条，同轮登记（0006 §7-40）。两条都先在目标文件里
  // `sed -n '<n>p'` 把原文读出来再抄，不从 0051 正文里复制措辞。
  //
  // ⚠ 这里【原来有一条 runtime.ts:108 的快照，本轮删掉了】，删的理由值得留着：
  // 上一版的注释把它判成「活坐标而带一段历史」，那个分类是错的。0051 §2b 那一段
  // 整段是【回顾一次错标】：它说「0050 当时把第 108 行标成了另一个符号，而那个符号
  // 当时在第 132 行」，通篇是过去时，它【没有】主张「今天第 N 行写着什么」。
  // 而快照的语义恰好是后者 —— 于是这条 key 一直在替 0051 主张一件它从未主张过的事，
  // 并且每次 runtime.ts 头部加行，守卫就红一次，而"修绿"的动作是把一个历史数字
  // 改成今天的数字 = 改历史。⇒ 0051 正文里那两个行号已改成汉字形态（不进快照），
  // 口径写在 0050 §6.5 末尾：**断言今天的位置 ⇒ `文件:行号`；陈述当时是什么 ⇒ 「第 N 行」**。
  // 这一行今天的坐标没有丢：0050 §6.5 顶部那个 `runtime.ts:117`（round272 起）是真活坐标，
  // 那条主张（§6.5 的分子由这一行实现）本来就是关于【现在】的。
  // bus.ts:256 也是活坐标：0051 §3 那句「不能 for await 那个订阅」的唯一依据是
  // 【空队列时 next() 挂住而不是返回 done】。有人把它改成空就返回，
  // 那条测试写法就能删掉这层包装 —— 快照该红，逼他重读那一段。
  "0051-end-to-end-one-idea-to-delivered-and-two-false-readings-of-my-own-harness.md>bus.ts:256":
    "return new Promise<IteratorResult<FeedItem>>((resolve) => {",
  // ── 0058（岗位书接进运行时那一批的验证工具）五格，同轮登记（0006 §7-40）──────
  // 五格都是先在目标文件里 `sed -n '<n>p'` 读出**当前原文**再抄，不从 0058 正文复制。
  // 其中【两格的行号在抄的时候发现正文写错了】：我在 0058 的表里写的是 :660 / :570，
  // 而那两处正是本轮我自己往上插注释的位置 —— 注释把我改的那一行顶下去了，
  // 我按"改动前的行号"写进了文档。守卫把这一下判成"内容与快照不符"而不是"引用没事"，
  // 所以**文档里的坐标改成了 663 / 574**（改的是文档，不是快照迁就它）。
  //
  // 【同一个错在本仓连续犯了两次，这一格就是第二次的现场】：store.test.ts 那一格
  // 登记时是 663，0059 那一批（岗位书播种）在同一文件 §④ 上面插了 12 行注释，
  // 又把目标行顶到 675 —— 守卫又抓到了。第一次犯时我写下"改的是文档不是快照"，
  // 可**没有写下"改完这一个文件就立刻重跑本守卫"**，所以同一个位移照样再犯一次。
  // 教训不是"抄的时候小心"（那次已经这么写了并且没用），是：**只要动了被引用的文件，
  // 同一轮内必须跑 doc-refs**，别把它留给"最后一起跑全量"。
  //
  // 前两格（runtime.test.ts）是 §4 那张表的**分母**：0058 §4 整节的论据是
  // 「四发里有一发只有附录杀得死」，而那句话的全部证据就是这一行那条反向对照 +
  // 它上面两条主断言仍然成立。有人把这一行当"重复的附录"删掉，主断言照绿而
  // 杀掉那个变异的没了 ⇒ 快照必须钉住它在。:574 那一格性质不同，只是登记性质
  // （钉住那句 `as never` 强转还在，它是 0058 §7 那条"桩类型刻意收窄"的落点）。
  "0058-a-restore-that-restored-the-mutant-and-three-reverse-assertions-searching-for-strings-that-do-not-exist.md>runtime.test.ts:477":
    'expect(w.rt.deps.rolePrompt("dev")).not.toContain("没有你的岗位书");',
  "0058-a-restore-that-restored-the-mutant-and-three-reverse-assertions-searching-for-strings-that-do-not-exist.md>runtime.test.ts:720":
    'hook({ db: db as never, taskId: "t1", role: "dev", seq, costCents: 4, nowMs: NOW + 2000 });',
  "0058-a-restore-that-restored-the-mutant-and-three-reverse-assertions-searching-for-strings-that-do-not-exist.md>store.test.ts:675":
    'return m ? { f, names: (m[1] ?? "").split(",").map((s) => s.trim().split(" ")[0]).filter(Boolean) } : null;',
  // ⚠ 后两格是【活坐标，且守的是一件本轮【没有】修的东西】：0058 §5/§8 写的是
  // 「全仓另有两份私有 stripComments，与本轮修掉的那一份同样有『行注释里的块注释
  // 起始串会吃掉真代码』这个缺陷」。这两格守的就是**那两份还是那两份** ——
  // 有人把它们改成一次扫描（或干脆换成 import 共用的那份），快照红，逼他回来把
  // 0058 §8 那句"未修"删掉。反过来，若允许"文档继续说没修而代码已经修了"，
  // 那条披露就变成一句读不出真假的往事（本仓抓过的那族：注释承诺了实现已不再具备的性质）。
  "0058-a-restore-that-restored-the-mutant-and-three-reverse-assertions-searching-for-strings-that-do-not-exist.md>bindings/im.test.ts:102":
    "function stripComments(text: string): string {",
  "0058-a-restore-that-restored-the-mutant-and-three-reverse-assertions-searching-for-strings-that-do-not-exist.md>web/renderer-criteria.test.ts:53":
    "function stripComments(src: string): string {",
  // ── 0059（播种命令报成功而角色叫不到）两格，同轮登记（0006 §7-40）──────────
  // 抄法同上面那五格：先在目标文件里读出**当前那一行的原文**再抄，不从 0059 正文复制。
  //
  // 这两格是 0059 §3.1 那条主张的**全部**证据，所以它们必须钉住：
  // 「岗位书按 role_id 存、运行时按组织图节点名查，而这两套 id 今天不相等」这句话
  // 只有两个支点 —— ① `NODE_TO_TEMPLATE` 真的把 intake/charter/report 挂在
  // assistant/assistant/ceo 上，② 建卡初值真的缺省成 "intake"。
  // 有人把 preset.ts 那张表改成语义名（D11 拍板那天）、或者让装配真的传 intakeRole，
  // 0059 §3.1 那张表就当场变成假的 ⇒ 快照必须红，逼他回来改那句主张。
  // 反过来，若快照不钉行，过两年有人读到 0059 §3.1 会以为那是句永恒的结构性事实。
  "0059-a-seed-command-that-reported-success-while-no-role-could-be-called-by.md>roles/preset.ts:27":
    "export const NODE_TO_TEMPLATE: Record<CompanyNode, string> = {",
  "0059-a-seed-command-that-reported-success-while-no-role-could-be-called-by.md>http/real-deps.ts:808":
    'const intakeRole = o.intakeRole ?? "intake";',
  // ── 0065（metrics 落库）一格，同轮登记 ─────────────────────────────────────
  // 抄法照旧：先 `sed -n '107p' packages/contracts/src/evidence.ts` 读原文再抄。
  // 这一格是 0065 §2 整张「加列 vs 删字段」论证的**唯一支点**：删掉 metrics 字段会
  // 连带杀 `metric:` 判据族 —— 那句话的全部前提是【契约今天还有这个字段】。
  // 哪天真要删它（回到 O5 动作 3 的另一个选项），这一行必须先过快照这一关。
  "0065-a-column-for-the-number-that-nothing-computes-yet-and-a-mirror-fixture-that-demonstrated-its-own-demise.md>evidence.ts:107":
    "metrics: z.record(z.string(), z.number().finite()).optional(),",
  // ── 0008 §7.1（round287 的改正）一格，同轮登记 ─────────────────────────────
  // ⚠ 这一格守的东西和上面大多数格【方向相反】：0008 引它不是为了引用那句主张，
  // 而是为了引用一条**被实测证伪的承诺** —— 模板头注释与 Task 0.7 的模板都写着
  // 「没签完 CI 就一直红」，而这一发断言的是【占位串还在】⇒ 什么都不做是全绿，
  // CEO 真签掉一份反而红 2 发（`.workbuddy/round287-mutate-placeholder.mjs`：69 通过 → 2 红）。
  // 所以这一格是 0008 §7.1 那张「承诺 vs 实测」表的**唯一支点**：
  // 哪天有人把这一发改成立反（"占位串不许在场"），那句话的报警器才真的存在，
  // 而 0008 §7.1 的改正段会当场变成假的 —— 快照必须红，逼他回来重写那一段。
  // ⚠ 键【必须带目录】：仓库里叫 charter.test.ts 的有两个（`roles/` 与 `engine/`），
  //   裸基名会被 resolveTarget 判成歧义 —— 与 0043 §5 那两格同一个坑。
  "0008-phase1-gate-semantics.md>roles/charter.test.ts:411":
    'it("模板的 acceptance_criteria 仍是【固定占位串】，等 Task 0.9 由 CEO 逐条替换", () => {',
  // ── 主设计文档 round288 接进扫描范围时带的四格，同轮登记 ────────────────────
  // 抄法照旧：`sed -n '<n>p'` 读目标行原文再抄，不从文档正文复制。
  // ⚠ 键前缀是【设计文档的文件名】而不是 decisions 那些编号 —— 它现在与它们同一个语料。
  // 这四格的分母就是「主文档 5 条引用里现在还在场的 4 条」，第五条是历史叙述，已改裸写法。
  //
  // 第一格有【反身】关系：§2 那条修正块讲的正是「这条钉子判的是装配表维度，
  // 它对『播种读不读这个目录』一条都不判」。有人把那一发改成按播种口径判 ⇒
  // §2 那句「守卫对这句过期全程是绿的」当场变假 ⇒ 快照必须红。
  "OPC-OS-功能优化设计.md>roles/charter.test.ts:439":
    'it("孤儿模板集合恰好是 ops —— 而且『孤儿』只意味着【不走 preset 装配】", () => {',
  // O3 那一节的「红的是它旁边那条反向对照」：这一格钉的是【反向对照这一发还在 465】。
  // 它不是产品事实，是「谁杀掉了那个变异体」这条归因的落点 —— 那一节整段结论就是
  // 「主断言在变异体下成立，杀变异的是附录」，行号挪了就等于归因没了。
  "OPC-OS-功能优化设计.md>runtime.test.ts:465":
    'expect("这些格没进提示词: [" + missing.join(", ") + "]").toBe(',
  // ⚠ 这一格 round288 之前写的是 `prompt.test.ts:146`，两处都错：基名有歧义
  //   （`charter/` 与 `memory/` 各一份 prompt.test.ts），而 146 行是【另一发】
  //   （「has_more ⇒ 说比这一块更长」的收尾）。那句话数的是出现次数 ⇒ 真落点是 158。
  //   ⇒ 快照守卫第一次覆盖到这里，就抓出一条已经错在文档里的坐标。
  "OPC-OS-功能优化设计.md>memory/prompt.test.ts:158":
    'const n = got.split("不构成对门控、权限或流程的授权").length - 1;',
  // O14 那一节「探针命中的是局部变量」那格的证据。这一格守的是【它仍是局部变量】：
  // 有人把 `batch` 提成字段或改成别的写法，那句话的「误归因」故事就失去了现场。
  "OPC-OS-功能优化设计.md>recorder.ts:393":
    "const batch = this.#pending.splice(0, this.#pending.length);",
  // §5.1 Task 4.7 那格 round293 撤回「发卡那一路零生产调用方」时留下的坐标。
  // 抄法照旧：node 读第 377 行的 trim 原文再抄，不从文档正文复制。
  // 这一格是【活坐标且反向】：那句被撤回的主张说「没有生产调用方」，而它的反证就是这一行。
  // 有人把投递那一跳从心跳里摘掉 ⇒ 这一行不在 377 ⇒ 快照红 ⇒ 逼他重读 §5.1 那一格 ——
  // 那时「只差凭据」就重新变成「接了推不出去」，撤回的那半句【反过来又成了】。
  // ⇒ 这格守的不是文档措辞，是那条撤回的方向。
  "OPC-OS-功能优化设计.md>packages/hub/src/serve/im-channels.ts:377":
    "const pass = await runDeliverPass({",
  // §7 第 25 格（round299）里那句「本仓自己把『每一轮真烧一次子进程、人类席位永远
  // 等不到』列为最贵的那类故障」的落点。抄法照旧：node 读第 382 行的 trim 原文。
  // ⚠ 文档里写的是区间 `dispatch.ts:382-387`，而提取器只认【区间起点】（既有取舍），
  //   所以键是 382。这一格是【活坐标且承重】：那句话是整个改动的动机，而动机指的是
  //   `up === o.ceoRoleId` 这一行的字面量比较 —— 有人把那句判据改成读结构（本该如此），
  //   这一格就红，那时要重读的是 §7 第 25 格「为什么值得修而不是继续登记」那一段。
  "OPC-OS-功能优化设计.md>dispatch.ts:382":
    "* 链条是 `topmost` 那一支的判据 `up === o.ceoRoleId`（字面量比较）：根叫 boss 时它恒假，",

  // ── docs/INDEX.md round288 同轮接进扫描范围时带的 20 格 ─────────────────────
  // 这 20 条的值【不是手抄的】：由 .workbuddy/round288-index-snap-gen.mjs 从目标文件读出来
  // 直接打印（守卫比的是 trim 后整行，23 条手抄 = 23 次打错的机会，而打错的快照比没快照更坏 ——
  // 它会把「引用漂了」读成「代码变了」）。判断仍留在坐标里：生成器只回答"这一行现在写了什么"。
  "INDEX.md>0001_init.sql:249":
    "CREATE TABLE im_bindings (",
  "INDEX.md>app.js:675":
    '<span class="pill ${statusClass(tk.status)}">${esc(tk.status)}</span>',
  "INDEX.md>app.ts:441":
    "...(deps.nonces === undefined ? {} : { nonces: deps.nonces }),",
  "INDEX.md>approvals/cards.ts:252":
    '"INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +',
  "INDEX.md>assemble.ts:274":
    "* 全在【泵自己内部】的外面，所以它们只能靠换掉整趟来数 —— 与章程泵同一条理由。",
  "INDEX.md>bindings/im.test.ts:102":
    "function stripComments(text: string): string {",
  "INDEX.md>graph/company.ts:281":
    'if (state.current === "REJECTED_DOWNWARD") await write("IN_PROGRESS");',
  // ⚠ 这一格的值是 `");"` —— 快照几乎不含信息，漂到邻近的另一个 `);` 它也照样绿。
  //   仍然登记，因为 INDEX 那句话指的就是这个收尾括号（`harness-invariants.ts` 里那条
  //   断言的结束），而不是指整块。它是【弱快照】：钉得住【那一发还存在且仍在那个位置附近】，
  //   钉不住语义。弱而不假，与「不登记」不是一回事 —— 记在这里是为了下次读到它的人
  //   不把它当成一条有牙齿的断言。
  "INDEX.md>harness-invariants.ts:156": ");",
  "INDEX.md>harness/gateway.ts:380":
    "const reject = (code: GatewayRejectCode, reason: string): GatewayOutcome => ({",
  "INDEX.md>http/real-deps.ts:808":
    'const intakeRole = o.intakeRole ?? "intake";',
  "INDEX.md>im.ts:164":
    '"INSERT INTO im_bindings (id, platform, external_user_id, ceo_role, verified, created_at) " +',
  "INDEX.md>ipc-surface.test.ts:129":
    "expect(API_ENDPOINTS).toContain(s.endpoint);",
  "INDEX.md>roles/preset.ts:27":
    "export const NODE_TO_TEMPLATE: Record<CompanyNode, string> = {",
  "INDEX.md>runtime.test.ts:465":
    'expect("这些格没进提示词: [" + missing.join(", ") + "]").toBe(',
  "INDEX.md>runtime.ts:109":
    "* 加上 AUTO_AFTER_EDGE 自动补的 IN_PROGRESS 那一跳，见 dispatch 的 chain），",
  "INDEX.md>serve/driver-pump.ts:487":
    ".all(...states, maxAttempts, o.taskLimitCents, perRound) as unknown as {",
  "INDEX.md>status.ts:59": "REJECTED_DOWNWARD: [",
  "INDEX.md>today.ts:263":
    "* 之间夹一次写入会得到一份自相矛盾的摘要条」的立场，只是这里跨了端点）。",
  "INDEX.md>tokens.ts:208":
    '"INSERT INTO im_tokens (token, approval_id, expires_at, used) VALUES (?, ?, ?, ?)";',
  "INDEX.md>web/renderer-criteria.test.ts:53":
    "function stripComments(src: string): string {",
};

describe("决策文档里的「文件:行号」引用不漂移", () => {
  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    const names: string[] = ["pkg/a.test.ts", "pkg/b.test.ts"];
    const store: Map<string, string> = new Map([
      ["pkg/a.test.ts", "alpha" + NL + "beta"],
      ["pkg/b.test.ts", "gamma"],
    ]);
    const read = (rel: string): string | undefined => store.get(rel);
    const docs: Map<string, string> = new Map([
      [
        "0999-x.md",
        "看 a.test.ts:1 与 a.test.ts:2 与 zzz.ts:9 与 b.test.ts:3" + NL,
      ],
    ]);
    // 故意只给一条快照、且文本写错：三类问题必须各被抓到。
    const problems: Problem[] = verify(docs, names, read, {
      "0999-x.md>a.test.ts:1": "WRONG",
    });
    const why = (k: string): string | undefined =>
      problems.find((p: Problem): boolean => p.key === k)?.why;
    expect(why("0999-x.md>a.test.ts:1")).toContain("与快照不符");
    expect(why("0999-x.md>a.test.ts:2")).toContain("快照里没有");
    expect(why("0999-x.md>zzz.ts:9")).toContain("找不到");
    expect(why("0999-x.md>b.test.ts:3")).toContain("越界");
    // 快照多余一条（文档里的引用被删了）也要报，否则「删掉引用」是无声的。
    expect(why("0999-x.md>a.test.ts:7")).toBeUndefined();
    expect(
      verify(docs, names, read, { "ghost.md>c.ts:1": "alpha" }),
    ).toHaveLength(5);
    // 全对时必须零问题，否则本守卫是恒红。
    const okDocs: Map<string, string> = new Map([
      ["0999-x.md", "看 a.test.ts:2" + NL],
    ]);
    expect(
      verify(okDocs, names, read, { "0999-x.md>a.test.ts:2": "beta" }),
    ).toEqual([]);
  });

  it("全部完整形态引用与快照一致", () => {
    const docs: Map<string, string> = decisionDocs();
    const names: string[] = repoNames();
    const read = (rel: string): string | undefined => {
      try {
        return readFileSync(join(ROOT, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    expect(
      verify(docs, names, read, SNAP)
        .map((p) => p.key + " " + p.why)
        .join(" | "),
    ).toEqual("");
    // 引用条数下界：解析被误写成恒真时，提取会变 0，这条会先红。
    expect(Object.keys(SNAP).length).toBeGreaterThanOrEqual(15);
  });
});
