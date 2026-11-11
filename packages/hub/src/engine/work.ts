/**
 * `hub work` —— 引擎路线的命令行入口（让 CEO 的想法真的被公司跑起来）。
 *
 * ── 为什么单独一个文件，不并进 cli.ts ────────────────────────────────
 * cli.ts 顶层 import 了 @langchain/langgraph 与整张公司图（run/status/resume 三个
 * 老命令建立在它上面）。并进那里的后果是【引擎路线跟着依赖那些包】，而本机装不上
 * （0009 §2 实测）。这不是绕弯：仓库里已经为同一件事切过一次 ——
 * graph/thread.ts 之所以存在，就是为了让「写一条 CEO 决策」不必 import 图。
 * 判据是同一条：一条能独立跑的路径，不该被另一条路径的依赖拖下水。
 *
 * ── 为什么这是【必须有】的一发，而不是「顺手加个命令」 ───────────────
 * engine/ 那三个模块（dispatch / runtime / driver）写完时【零生产调用方】。
 * 本仓抓这一族抓了二十几篇（0013/0014/0020/0031/0032/0033，最近一次 0040 是组织图
 * 那个「保存按钮」），形状都是：逻辑写完、测试全绿、没有任何运行时路径走到它。
 * 一个没有调用方的调度器不是「还没接上界面」，是【今天谁也用它不了】。
 *
 * ── 这个命令刻意【不】建任务 ────────────────────────────────────────
 * 建任务走 insertTask（http/real-deps.ts，它会把 graph_version 与 INSERT 放在同一
 * 事务里取，§18.4）。这里再写一份 INSERT 就是造第二个建任务的路径，而两条路径对
 * graph_version 的取法可以不一致 —— 那种不一致的表现是「任务在一个不存在的图版本上」，
 * 于是 dispatch 每一轮都以「版本缺失」拒绝，而任务行看着完全正常。
 * 所以要跑一条新任务，先用创建它的那条路（CLI 的 hub run / HTTP / POST /tasks），
 * 再用 hub work 推进。这条边界写在 --help 里而不是只写在这里。
 *
 * ── CLI 的 io / 退出码类型【在这里另立一份】，不从 cli.ts import ────────
 * `import type` 在编译期就被抹掉，运行时不产生 require，本来是无害的。但它留着一个
 * 只能靠人记得的不变量：这一行只要被人从 type import 改成值 import（IDE 的
 * 「inline 一个类型」就会这么干），整条引擎路线立刻跟着 @langchain/langgraph 一起挂，
 * 而挂的方式是「启动即 module not found」—— 引擎路线存在的意义恰恰是它不依赖那个包。
 * 两个字段的结构类型，复制一份比留一个隐式依赖便宜。
 */
import { existsSync } from "node:fs";
import { WriteQueue } from "../db/write-queue.js";
import { migrate } from "../db/migrate.js";
import { InMemoryEventBus } from "../events/bus.js";
import { makeDispatch } from "./dispatch.js";
import { makeRuntime } from "./runtime.js";
import { advance, describeAdvance, type AdvanceResult } from "./driver.js";
import { ensureCharterCard } from "./charter.js";
import {
  approveCard,
  pendingCards,
  requiresNote,
  type CardButton,
} from "./approve.js";

/** 与 cli.ts 的 CliIo 同构（结构类型，两边可互换传递）。 */
export interface WorkIo {
  write(text: string): void;
  error(text: string): void;
}

export interface WorkResult {
  readonly code: number;
}

/** 美元/美分都不给默认值：见 0041 §8。缺一个就报一条说清缺哪个的错，而不是跑起来再说。 */
export interface WorkArgs {
  readonly db: string;
  readonly task: string;
  readonly maxTurns: number;
  readonly maxBudgetUsd: number;
  readonly taskLimitCents: number;
  readonly cwd: string;
  readonly bin?: string;
}

/**
 * 参数解析的结果：要么拿到 args，要么拿到一条给人看的话，【恰有一个】。
 *
 * 用可判别联合而不是 `{args?; error?}`：后者的「两个都填了」与「两个都没填」
 * 都是可表达状态，调用方只能靠 as / 非空断言收场，而 as 掩盖的正是
 * 「解析器哪天返回两个都没填的那一支」—— 那一带上 as 之后表现成
 * cmdWork 收到 undefined 然后在 existsSync 上炸，报出来的是一条看不懂的 stack
 * （cli.ts:438 那条「不用 as never 掩盖」同一条理由）。
 */
export type ParsedArgs<T> = { readonly ok: true; readonly args: T } | { readonly ok: false; readonly error: string };

/**
 * 解析 work 的参数。不复用 cli.ts 的 parseCli：那个函数返回的 ParsedCli 只有
 * db/task/idea 三格，而这一发要的四格（上限、轮数、CLI 路径）语义都不同 ——
 * 硬塞会把「--max-turns 0」这种明显写错的值带到下游去（那边没有校验它的责任）。
 */
export function parseWorkArgs(argv: readonly string[]): ParsedArgs<WorkArgs> {
  let db: string | undefined;
  let task: string | undefined;
  let maxTurns: number | undefined;
  let budget: number | undefined;
  let limit: number | undefined;
  let cwd: string | undefined;
  let bin: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    // 取值失败时给的是 undefined 而不是抛：缺值的 --db 与「压根没写 --db」
    // 是同一个错（下面 missing 那条报得清），没必要两种措辞。
    //
    // 【下一个 token 长得像 flag 时不算值】：`--max-budget-usd --task-limit-cents 500`
    // 里把 "--task-limit-cents" 当成美元数吃下去，后果是后面那个 500 变成裸参数
    // （报「不认识参数 500」），而真正写错的那一发（--max-budget-usd 忘了填值）
    // 在报错里【完全看不见】。人从终端往上翻只会去查那个 500。
    // 已知代价：值本身以 -- 开头时（--note "--x"）会被判成缺值。
    // 那是可选写法（--note=--x 不存在于本解析器；真要传这种值用引号包一个非 -- 开头
    // 的措辞），而换来的是一条不会把人指错的报错。
    const val = (): string | undefined => {
      const next = argv[i + 1];
      if (next === undefined || next === "" || next.startsWith("--")) return undefined;
      i += 1;
      return next;
    };
    if (a === "--db") db = val();
    else if (a === "--task") task = val();
    else if (a === "--max-turns") {
      const raw = val();
      // 空串【不能】交给 Number：Number("") === 0，于是「写了 --max-turns 但忘了填值」
      // 会被报成「必须是正整数，实到 0」，把人去指向一个自己没写错的数字。
      // 留 undefined ⇒ 用默认 12，与压根没写这个参数同义。
      maxTurns = raw === undefined ? undefined : Number(raw);
    } else if (a === "--max-budget-usd") {
      const raw = val();
      // 同理：Number("") === 0 ⇒ 一个忘填值的参数会被读成「美元硬顶 0」，
      // 报出来是「必须是正数，实到 0」。留 undefined ⇒ 走 missing 那条必填提示。
      budget = raw === undefined ? undefined : Number(raw);
    } else if (a === "--task-limit-cents") {
      const raw = val();
      limit = raw === undefined ? undefined : Number(raw);
    } else if (a === "--cwd") cwd = val();
    else if (a === "--bin") bin = val();
    else return { ok: false, error: "work 不认识参数 " + a };
  }
  const missing: string[] = [];
  if (db === undefined || db === "") missing.push("--db");
  if (task === undefined || task === "") missing.push("--task");
  if (budget === undefined) missing.push("--max-budget-usd（每轮美元硬顶，不给默认值）");
  if (limit === undefined) missing.push("--task-limit-cents（任务级预算上限，不给默认值）");
  if (missing.length > 0) return { ok: false, error: "缺参数：" + missing.join(" / ") };
  // 三个数值都要【有限】：NaN（填了单词）与 Infinity（填了 1e999）都得红。
  // --max-turns 与 --task-limit-cents 还要是整数 —— 后者是美分，§6.1 明写禁浮点金额，
  // 而「-task-limit-cents 12.5」被静默变成 12.5 美分存进 INTEGER 列，
  // 是这一族缺陷里最省笔墨也最难查的一种（同 assertCents）。
  if (maxTurns !== undefined && (!Number.isSafeInteger(maxTurns) || maxTurns < 1)) {
    return { ok: false, error: "--max-turns 必须是正整数，实到 " + String(maxTurns) };
  }
  if (!Number.isFinite(budget) || (budget as number) <= 0) {
    return { ok: false, error: "--max-budget-usd 必须是正数，实到 " + String(budget) };
  }
  if (!Number.isSafeInteger(limit)) {
    return { ok: false, error: "--task-limit-cents 必须是整数美分（§6.1 禁浮点金额），实到 " + String(limit) };
  }
  return {
    ok: true,
    args: {
      db: db as string,
      task: task as string,
      maxTurns: maxTurns ?? 12,
      maxBudgetUsd: budget as number,
      taskLimitCents: limit as number,
      cwd: cwd ?? process.cwd(),
      ...(bin === undefined ? {} : { bin }),
    },
  };
}

export const DECIDE_USAGE = [
  "用法：hub decide --db <path> --task <id> [--card <卡片 id>] --button <按钮> [--note <理由>]",
  "",
  "  · --button：approve / reject_with_comment / defer_deep_review（就这三颗，§8.2 第 4 条）。",
  "  · --card 可以省：那条任务只有一张待批卡时按那张办；【有多张则必须指定】——",
  "    替 CEO 猜「她想批哪一张」等于系统替她做了一次决定。",
  "  · --note：reject_with_comment 时【必填】（没有理由的打回到产出方那里就是「被拒了，为什么不知道」）。",
  "  · 只有 approve 真的会把任务往前推一格。另两颗按 §7.1 没有出边：卡片记掉而任务原地不动，",
  "    这一点会明写在输出里而不是含糊过去（缺的是规格，已登记 0041）。",
].join("\n");

/**
 * WORK_USAGE 里嵌 DECIDE_USAGE，所以【DECIDE_USAGE 必须声明在它前面】——
 * 两个都是 const，模块求值时后面那个还在 TDZ 里，写反了是启动即
 * ReferenceError（不是「用法少一段」，是这条命令根本起不来）。
 */
export const WORK_USAGE = [
  "用法：hub work --db <path> --task <id> --max-budget-usd <每轮美元硬顶>",
  "             --task-limit-cents <任务预算上限（美分）> [--max-turns 12] [--cwd <目录>] [--bin claude]",
  "",
  "  · 这一条走【引擎路线】：一个角色 = 一次 claude -p，下一步找谁由它自己说，",
  "    而能不能推进这一步由 hub 判（docs/decisions/0041）。",
  "  · 两个上限【必填】：不给默认值 = 没配也能跑，而跑起来才知道花多少没顶。",
  "  · 本命令不建任务。建任务走 hub run / POST /tasks（那条路会把 graph_version 与",
  "    任务行放在同一事务里取，§18.4）；这里再写一份 INSERT 就是第二条可能不一致的路径。",
  "  · 停在人坐的格子（章程待批 / 升 CEO / 终审）时，下一步是 hub decide（或收件箱里",
  "    的一次点击），不是再敲一次 hub work。",
  "",
  DECIDE_USAGE,
].join("\n");

/** hub decide 的参数。 */
export interface DecideArgs {
  readonly db: string;
  readonly task: string;
  /**
   * 那张卡片。可以不填，但填了【必须对得上】—— 见 parseDecideArgs 与 cmdDecide 里那段。
   * 允许省略的理由是人手打的：CEO 手上一张待批卡是常态，而卡片 id 是一串 uuid。
   */
  readonly card?: string;
  readonly button: CardButton;
  readonly note?: string;
}

/**
 * --button 的合法取值。类型标成 readonly CardButton[]，所以【CardButton 加第四颗而这里
 * 漏改】在编译期就红（数组字面量逐元素受检），而运行时比较用 readonly string[]
 * 那一层（命令行来的是裸 string，没有 __proto__ 保证）。
 */
const BUTTON_VALUES: readonly CardButton[] = ["approve", "reject_with_comment", "defer_deep_review"];
const KNOWN_BUTTONS: readonly string[] = BUTTON_VALUES;

/**
 * 解析 decide 的参数。
 *
 * --button 的取值检查【在这里】做而不是交给 approveCard：那三颗按钮的合法集合由
 * contracts 定义，而 approveCard 入参的类型是 CardButton（编译期的）。命令行传进来的
 * 是字符串，运行期没人管 —— 「--button aproved」拼错一个字母会被当成一次合法决策，
 * 落进 STATUS_BY_BUTTON[undefined] = undefined，然后写着 status=undefined 的卡片行
 * 落进 append-only 的库。这一族（人打的字符串直接进状态列）在这里挡住。
 */
export function parseDecideArgs(argv: readonly string[]): ParsedArgs<DecideArgs> {
  let db: string | undefined;
  let task: string | undefined;
  let card: string | undefined;
  let button: string | undefined;
  let note: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const val = (): string | undefined => {
      const next = argv[++i];
      return next === undefined || next === "" ? undefined : next;
    };
    if (a === "--db") db = val();
    else if (a === "--task") task = val();
    else if (a === "--card") card = val();
    else if (a === "--button") button = val();
    else if (a === "--note") note = val();
    else return { ok: false, error: "decide 不认识参数 " + a };
  }
  const missing: string[] = [];
  if (db === undefined || db === "") missing.push("--db");
  if (task === undefined || task === "") missing.push("--task");
  if (button === undefined) missing.push("--button（" + KNOWN_BUTTONS.join(" / ") + "）");
  if (missing.length > 0) return { ok: false, error: "缺参数：" + missing.join(" / ") };
  // 先收成【要么是三颗之一、要么是 undefined】，再判 undefined：
  // 直接 if(!includes) return 之后 TS 并不会把 button 从 string 收窄成 CardButton，
  // 于是下游还得 cast 一次，而 cast 掩盖的就是「以后加了第四颗按钮忘了改这里」。
  const b: CardButton | undefined = KNOWN_BUTTONS.includes(button as string)
    ? (button as CardButton)
    : undefined;
  if (b === undefined) {
    return { ok: false, error: "--button 只认 " + KNOWN_BUTTONS.join(" / ") + "，实到 " + String(button) };
  }
  // 判在解析层而不只在 approveCard 里，是为了这一句能出现在【参数错误】那一支：
  // 退出码 2（改命令就行）比 1（跑炸了，去看原文）更贴合「你少打了一个 --note」。
  if (requiresNote(b) && (note === undefined || note.trim() === "")) {
    return { ok: false, error: "--button reject_with_comment 必须带 --note <理由>" };
  }
  return {
    ok: true,
    args: {
      db: db as string,
      task: task as string,
      button: b,
      ...(card === undefined ? {} : { card }),
      ...(note === undefined ? {} : { note }),
    },
  };
}

/**
 * 跑一次 decide（CEO 点一次按钮，任务真的往前走一格）。
 *
 * 退出码沿用 cmdWork 那三条：0 = 决策落了（含「卡片记掉了但没有出边」，那一次点击
 * 【确实成立】，重跑只会撞 already_decided）；2 = 参数/前置错了；1 = 写库炸了。
 * 「没有待批卡片」算 2 而不是 1：下一步是去建那张卡（hub work）或换一条任务，
 * 不是排查这个进程。
 */
export async function cmdDecide(a: DecideArgs, io: WorkIo): Promise<WorkResult> {
  if (!existsSync(a.db)) {
    io.error("错误：数据库文件不存在 —— " + a.db + "\n（hub decide 不建库，见 --help）\n");
    return { code: 2 };
  }
  const q = new WriteQueue(a.db);
  try {
    migrate(q.writeConnection());
    const bus = new InMemoryEventBus();
    // 一次决策烧 0 个 token，所以这里【不起 runtime】：makeRuntime 会去装子进程那一层
    // 与 role_charters，为一个 UPDATE 把它拉起来等于让审批依赖「CLI 找得到」。
    const cards = pendingCards(q, a.task);
    if (cards.length === 0) {
      const t = q
        .readConnection()
        .prepare("SELECT status FROM tasks WHERE id = ?")
        .get(a.task) as Record<string, unknown> | undefined;
      io.error(
        "错误：任务 [" + a.task + "] 上【没有待批的卡片】" +
          (t === undefined ? "（这条任务也不在库里）" : "（它现在在 " + String(t["status"] ?? "") + "）") +
          "。\nhub decide 只管【收件箱里已有的那一张】；没有卡就去跑 hub work（它会把要人批的东西建成卡），" +
          "或者确认你指的是不是这条任务。\n",
      );
      return { code: 2 };
    }

    let cardId = a.card;
    if (cardId === undefined) {
      if (cards.length > 1) {
        io.error(
          "错误：那条任务上有 " + cards.length + " 张待批卡片，不能替你猜要办哪一张。\n" +
            "请指定 --card <下面某个 id>：\n" +
            cards.map((c) => "  · " + c.id + "（" + c.approvalType + "）").join("\n") +
            "\n",
        );
        return { code: 2 };
      }
      cardId = (cards[0] as { id: string }).id;
      io.write("  按那条任务上唯一的待批卡片办：" + cardId + "\n");
    }
    // --card 指着一张【不在这条任务上】的卡时，宁可在这里红：
    // approveCard 也会拦（card_belongs_to_other_task），但它拦不到「这张卡根本不存在」
    // 与「这张卡是另一条任务上那张」之间的区别，而这里的列表能直接把该打的那个 id 打出来。
    const hit = cards.find((c) => c.id === cardId);
    if (hit === undefined) {
      io.error(
        "错误：卡片 [" + cardId + "] 不是任务 [" + a.task + "] 上【待批】的卡片。\n" +
          "这条任务此刻待批的是：\n" +
          cards.map((c) => "  · " + c.id + "（" + c.approvalType + "）").join("\n") +
          "\n（已经批过的卡片不能再批一次：决策是 append-only 的，重复点一次就是在历史里说「这个人又决定了一次」。）\n",
      );
      return { code: 2 };
    }

    const r = await approveCard(
      q,
      {
        taskId: a.task,
        approvalId: hit.id,
        button: a.button,
        nowMs: Date.now(),
        ...(a.note === undefined ? {} : { note: a.note }),
      },
      // 同 cmdWork：CLI 没有 SSE 消费者，publish 也照样必填（见那里那段注释）。
      (e, seq) => bus.publishPersisted(e, seq),
    );
    io.write("  " + r.note + "\n");
    if (r.outcome === "decided" && r.edgeExists) {
      io.write("  任务 " + a.task + "：" + r.from + " → " + r.to + "（卡片 " + r.cardStatus + "）\n");
    }
    // note_required 走 2：approveCard 里那一发是「请求本身不成立」，
    // 而 parseDecideArgs 已经挡过一道，走到这里只剩【直连本函数调用】那条路。
    if (r.outcome === "note_required") return { code: 2 };
    return { code: r.outcome === "decided" ? 0 : 2 };
  } finally {
    try {
      await q.close();
    } catch {
      /* 已经关了 */
    }
  }
}


/**
 * 跑一次 work。
 *
 * 退出码三条，各自对应【使用者下一步做什么不同】：
 *  · 0 —— 推进过了（含停在人席：那不是失败，是轮到 CEO）；
 *  · 2 —— 参数/前置错了（库不存在、任务不存在），改命令就行，别重试；
 *  · 1 —— 跑的过程中炸了（库里少表、CLI 起不来之类），要看原文。
 * 把「停在人席」算成非零是最容易犯的一种错：脚本会以为失败了，然后重跑一整轮去烧 token。
 */
export async function cmdWork(a: WorkArgs, io: WorkIo): Promise<WorkResult> {
  if (!existsSync(a.db)) {
    io.error("错误：数据库文件不存在 —— " + a.db + "\n（hub work 不建库，先用 hub run 建任务）\n");
    return { code: 2 };
  }
  const q = new WriteQueue(a.db);
  try {
    migrate(q.writeConnection());
    const bus = new InMemoryEventBus();
    // CLI 这一发没有 SSE 消费者，但总线仍然必须是真的：dispatch 的 publish 是【必填】，
    // 而事件写进 events 表与广播出去是同一件事的两半（events/bus.ts 里
    // ApprovalTokenRedeemed 那一段论证）。传一个空实现会让「写完不广播」这条
    // 失效在 CLI 路线上重新出现，而这正是那一段论证要防的。
    const rt = makeRuntime({
      writer: q,
      bus,
      maxBudgetUsd: a.maxBudgetUsd,
      taskLimitCents: a.taskLimitCents,
      cwd: a.cwd,
      ...(a.bin === undefined ? {} : { bin: a.bin }),
    });
    const task = rt.deps.loadTask(a.task);
    if (task === null) {
      io.error("错误：任务不存在 —— task_id = " + a.task + "\n（hub work 不建任务，见 --help）\n");
      return { code: 2 };
    }
    io.write(
      "推进任务 " + a.task + "：状态 " + task.status + "，负责角色 " + task.role +
        "，组织图 v" + task.graphVersion + "\n",
    );

    // ── CHARTER_PENDING 这一格：先把提案起草出来，再谈推进 ──────────────
    // 顺序【不能反】。dispatch 在这一格会直接回「等人不等 agent」，而人要点的是
    // 一张【还不存在】的卡（全仓除 engine/charter.ts 之外没有 charter 卡的生产者，
    // 见那个文件的文件头）。反过来的话 CEO 拿到的就是：跑一次 work → 一句「等人」
    // → 打开收件箱 → 空的。那不是一人公司，那是一台死机器。
    // 起草【不推进状态】（它只建卡），所以这条不违反「人席不放 agent 进场」。
    if (task.status === "CHARTER_PENDING") {
      const c = await ensureCharterCard(
        q,
        { taskId: a.task, nowMs: Date.now(), maxBudgetUsd: a.maxBudgetUsd },
        {
          runTurn: (i) => rt.deps.runTurn(i),
          rolePrompt: (r) => rt.deps.rolePrompt(r),
          ...(rt.deps.onCost === undefined ? {} : { onCost: rt.deps.onCost }),
          publish: (e, seq) => bus.publishPersisted(e, seq),
        },
      );
      io.write("  章程：" + c.note + (c.costCents > 0 ? "（" + c.costCents + " 美分）" : "") + "\n");
      // 没起草出来就【不进 advance】：状态还是 CHARTER_PENDING，advance 会为它
      // 白跑一趟（dispatch 立刻拒绝），而那次白跑在输出里长得像「试过了没用」。
      if (c.outcome !== "drafted") return { code: c.outcome === "already_pending" ? 0 : 1 };
      // 把那一张卡的 id 与整条命令打出来。只说「去收件箱点一下」在 CLI 上等于没说：
      // 这一发的用户此刻就在终端前，而收件箱是另一个进程（web / 桌面端）。
      // --button 也带上：省掉它的话这一发敲下去拿到的是「缺参数 --button」，
      // 而「照抄系统刚给你的那一行就能用」是这一行存在的唯一理由。
      // 卡片 id 走 interruptId：那是 ApprovalRequired 那条事件里【这张卡的 id】那一格
      // （cards.ts 的 approvalRequiredEvent 把它绑的就是 insertCard 返回的 approvalId）。
      // 名字不一致是事件的既有形状，不是这里能改的（改它等于改 DomainEvent），
      // 但打出来的值必须是对的 —— 否则这一行照抄下去拿到的是「卡片不存在」。
      io.write(
        "  下一步：hub decide --db " + a.db + " --task " + a.task +
          " --card " + (c.card?.interruptId ?? "?") + " --button approve" +
          " —— 那一次点击才是推进这一格的东西。\n",
      );
      return { code: 0 };
    }

    const dispatch = makeDispatch(rt.deps);
    const r: AdvanceResult = await advance(rt, (o) => dispatch(o), {
      taskId: a.task,
      maxBudgetUsd: a.maxBudgetUsd,
      maxTurns: a.maxTurns,
      onTurn: (t) => {
        io.write(
          "  [" + t.turn + "] " + t.res.role + " → " + t.res.status +
            "（" + t.res.costCents + " 美分" + (t.recorded ? "" : "，⚠ 执行日志没写进去：" + t.why) + "）\n",
        );
      },
    });
    io.write("  " + describeAdvance(r, rt.deps.loadTask(a.task)) + "\n");
    return { code: 0 };
  } finally {
    // 关不上也要走完 finally：CLI 是一次性进程，正常靠退出释放；这里显式 close 是
    // 给【被当成库调用的那条路】用的（测试与未来的桌面端都直接 import 这个函数）。
    try {
      await q.close();
    } catch {
      /* 已经关了 */
    }
  }
}
