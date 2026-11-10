/**
 * Hub CLI（Task 0.10）：`hub run --idea "..." / hub status / hub resume`。
 *
 * 逻辑全抽成 runCli（参数进、退出码出、io 注入），理由与 db/migrate-cli.ts 同一条：
 * 验收对象是【命令行退出码】，必须能被真子进程执行来验证。计划 V13 实测过 ——
 * lint 规则降成 warn 后 biome 照样打印违规但退出码 0；"日志里看着报错了"不等于
 * 门禁生效。
 *
 * 【三条设计纪律】各自都有出处，不要就地改：
 *  1. 不提供默认库路径。库文件位置属于应用配置（Electron 下是 userData 目录），
 *     配置系统到 Phase 1 才出现；在这里编一个默认值就是留下"谁也没决定过、但代码里
 *     写着"的路径。同 migrate-cli.ts 的有意偏差。
 *  2. 只暴露 --task，不暴露 --thread：thread_id 由 task_id 推导（0006 §4）。两个自由
 *     字符串迟早被传进一对不匹配的值，于是 status 查甲任务的审计、resume 续乙会话的
 *     进度，两边还都"看着合理"。传 --thread 时显式报错，不静默忽略。
 *  3. resume 的输入【先读 checkpoint 再选】，不 try/catch 兜异常（计划 §10.4 第 4 条的
 *     同一条纪律）。实测（0006 §1）：已完成的 thread 上 invoke(null) 不重放节点；
 *     无中断时 Command({resume:null}) 直接抛 "Received empty Command input"。两种输入的
 *     错误模式是【静默的不同】—— 选错一种要么重复烧钱，要么当场崩。
 *
 * ⚠ 装配顺序照抄 test/graph/e2e-linear.test.ts 的 makeHub：saver 必须过
 *   auditor.instrumentSaver(...) 一层。少了那一层超步事务不滚动
 *   （docs/decisions/0005-event-bus-and-audit.md §16 的第 1 类静默陷阱：图跑完、
 *    事件写全、退出码 0，只有崩溃恢复当场失去意义）。
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "@langchain/langgraph";
import { SqliteWALSaver } from "./checkpoint/saver.js";
import { openDb } from "./db/driver.js";
import { migrate } from "./db/migrate.js";
import { InMemoryEventBus } from "./events/bus.js";
import { KIND_TO_ACTION } from "./events/recorder.js";
import { SuperStepAuditor } from "./graph/audit-middleware.js";
import { buildCompanyGraph, type CompanyNode } from "./graph/company.js";
import { StubRegistry } from "./graph/stub-model.js";
import { chooseResumeInput, hasPendingInterrupt, threadConfig } from "./graph/thread.js";
import { isDirectRun } from "./internal/direct-run.js";
import { loadPresetRoles } from "./roles/preset.js";

export interface CliIo {
  write(text: string): void;
  error(text: string): void;
}

export interface CliResult {
  code: number;
}

type Verb = "run" | "status" | "resume";

const VERBS: readonly Verb[] = ["run", "status", "resume"];

const USAGE = [
  "用法：hub run    --db <path> --task <id> --idea <一句话想法>",
  "      hub status --db <path> --task <id>",
  "      hub resume --db <path> --task <id>",
  "      设置环境变量 OPC_DB 后可省略 --db",
  "",
  "说明：",
  "  · 不提供默认库路径 —— 库位置属于应用配置，配置系统尚未落地。",
  "  · 没有 --thread：thread_id 由 --task 推导（docs/decisions/0006 §4）。",
  "  · Phase 0 一律用桩模型：不联网、不计费。",
].join("\n");

/**
 * 解析结果。可选字段一律写成 T | undefined：本仓库开了 exactOptionalPropertyTypes，
 * 只写 db?: string 就不允许显式返回 { db: undefined } —— 而"解析成功但没给 db"正是
 * --help 与错误分支都要表达的语义。与 migrate-cli.ts 同一个写法，同一个理由。
 */
export interface ParsedCli {
  verb?: Verb | undefined;
  db?: string | undefined;
  task?: string | undefined;
  idea?: string | undefined;
  help?: boolean | undefined;
  error?: string | undefined;
}

export function parseCli(argv: readonly string[]): ParsedCli {
  const first = argv[0];
  if (first === undefined) return { error: "缺少子命令\n\n" + USAGE };
  if (first === "--help" || first === "-h") return { help: true };

  if (first.startsWith("-")) {
    return { error: "缺少子命令，收到：" + first + "\n\n" + USAGE };
  }
  if (!(VERBS as readonly string[]).includes(first)) {
    // 必须显式拒绝：否则 "runn" 会被后续解析当成裸参数静默吃掉，用户拿到的是
    // "缺 --idea"，离真实原因十万八千里。
    return {
      error: "未知子命令：" + first + "（可用：" + VERBS.join(" / ") + "）",
    };
  }
  const verb = first as Verb;

  let db: string | undefined;
  let task: string | undefined;
  let idea: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a: string | undefined = argv[i];
    if (a === undefined) continue;

    if (a === "--help" || a === "-h") return { help: true };

    if (a === "--thread" || a.startsWith("--thread=")) {
      // 显式拒绝而不是忽略（0006 §4.2）。消息里带上原因，否则使用者只会反复试。
      return {
        error:
          "不支持 --thread：thread_id 由 --task 推导（见 docs/decisions/0006 §4）。\n" +
          "两个 id 各自漂移会让 status 查甲任务的审计、resume 续乙会话的进度，" +
          "两边都还「看着合理」。",
      };
    }

    if (a === "--db" || a === "--task" || a === "--idea") {
      const key = a.slice(2) as "db" | "task" | "idea";
      const next: string | undefined = argv[++i];
      if (next === undefined || next === "") return { error: a + " 后面缺值" };
      const dup = key === "db" ? db : key === "task" ? task : idea;
      if (dup !== undefined)
        return { error: "给了两个 " + a + "：" + dup + " 与 " + next };
      if (key === "db") db = next;
      else if (key === "task") task = next;
      else idea = next;
      continue;
    }

    if (
      a.startsWith("--db=") ||
      a.startsWith("--task=") ||
      a.startsWith("--idea=")
    ) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq) as "db" | "task" | "idea";
      const val = a.slice(eq + 1);
      if (val === "") return { error: a.slice(0, eq) + "= 后面缺值" };
      if (key === "db") {
        if (db !== undefined)
          return { error: "给了两个 --db：" + db + " 与 " + val };
        db = val;
      } else if (key === "task") {
        if (task !== undefined)
          return { error: "给了两个 --task：" + task + " 与 " + val };
        task = val;
      } else {
        if (idea !== undefined) return { error: "给了两个 --idea" };
        idea = val;
      }
      continue;
    }

    if (a.startsWith("-")) return { error: "未知选项：" + a };
    return { error: "多余的裸参数：" + a + "（run 的想法请用 --idea 传）" };
  }

  if (db === undefined) {
    const env = process.env["OPC_DB"];
    // 空串 / 纯空白都不算设置了 OPC_DB：否则 "OPC_DB=" 会得到一个 openDb 抛
    // TypeError 的失败，而不是"没指定库路径"这条清晰契约。
    if (env !== undefined && env.trim() !== "") db = env.trim();
  }
  if (db === undefined) {
    return { error: "未指定数据库路径（--db <path>，或设置环境变量 OPC_DB）" };
  }
  // 相对路径绝对化：否则同一条命令在不同 cwd 下会指向两个不同的库文件。
  if (!isAbsolute(db)) db = resolve(db);

  if (task === undefined)
    return { error: "子命令 " + verb + " 需要 --task <id>" };
  if (verb === "run" && idea === undefined) {
    return { error: "子命令 run 需要 --idea <一句话想法>" };
  }

  return { verb, db, task, idea };
}

interface TaskRow {
  id: string;
  status: string;
  title: string;
  assigned_role: string;
  current_node: string;
}

/**
 * 只读命令（status / resume）的前置：库文件必须已经存在，否则退出 2。
 *
 * 为什么必须挡在 openDb 之前：openDb 会【创建】文件，withHub 又会跑迁移 —— 于是
 * 一次拼错的 --db 路径留下一个带全套表的空库。比"多一个文件"更糟的是，此后
 * existsSync(路径) 恒真，"这个库到底存不存在"再也没有好答案；下一次 hub run 打在
 * 同一个错路径上还会当成已有库继续用。
 *
 * 边界说清：这里判断的是【文件存在】，不是"这是一个 OPC 库" —— 空文件会一路走到
 * "任务不存在"。那是可以接受的：文件确实是调用方指名要打开的那个，CLI 不猜意图。
 */
function requireExistingDb(
  dbPath: string,
  taskId: string,
  io: CliIo,
): CliResult | null {
  if (existsSync(dbPath)) return null;
  io.error(
    "错误：数据库文件不存在 —— " +
      dbPath +
      "\n" +
      "（task_id = " +
      taskId +
      "；新任务请用 hub run 建库）\n",
  );
  return { code: 2 };
}

/** 共享装配：openDb → migrate → bus → auditor → instrumentSaver(saver) → graph。 */
async function withHub<T>(
  dbPath: string,
  taskId: string,
  body: (ctx: {
    db: ReturnType<typeof openDb>;
    auditor: SuperStepAuditor;
    graph: ReturnType<typeof buildCompanyGraph>;
    models: StubRegistry;
  }) => Promise<T>,
): Promise<T> {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    // CLI 自己跑迁移：hub run 的验收是"能在临时目录里把库建出来"。要求使用者先
    // 手动 pnpm migrate 的话，第一条命令就得到一个没人期待的失败（no such table）。
    migrate(db);

    const bus = new InMemoryEventBus();
    const auditor = new SuperStepAuditor({ db, bus });
    const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
    // StubRegistry 是显式的：Phase 0 没有真实 provider，任何"接上真模型"的改动
    // 都必须先改掉这一行 —— 这比留一个 ModelRegistry 参数让调用方猜要诚实。
    const models = new StubRegistry();
    const graph = buildCompanyGraph({
      db,
      recorder: auditor.recorder,
      saver,
      roles: loadPresetRoles(),
      models,
      // thread_id = task_id（0006 §4）；图内部靠 taskId 写 tasks 行与审计。
      taskId,
    });
    return await body({ db, auditor, graph, models });
  } finally {
    db.close();
  }
}

/**
 * thread_id 与 task_id 同值，所以不给第二个自由字符串的入口（0006 §4）。
 *
 * 实现【不在这里】，在 graph/thread.ts。这不是搬家癖：HTTP 侧写决策落库时也要
 * 同一个坐标，而它【不能】import 本文件 —— 本文件顶层 import 了
 * `@langchain/langgraph` 与整张图，那会让「把一条 CEO 决策写进库」在缺那几个包时
 * 连 import 都做不到（实测：本机装不上，见 0009 §2）。
 * 留这个别名是为了让上面那 6 个调用点一字不改；改的是它只有一处实现这件事。
 */
const config = threadConfig;

function findTask(
  db: ReturnType<typeof openDb>,
  taskId: string,
): TaskRow | undefined {
  return db
    .prepare(
      "SELECT id, status, title, assigned_role, current_node FROM tasks WHERE id = ?",
    )
    .get(taskId) as TaskRow | undefined;
}

async function cmdRun(
  dbPath: string,
  taskId: string,
  idea: string,
  io: CliIo,
): Promise<CliResult> {
  return withHub(dbPath, taskId, async ({ db, auditor, graph, models }) => {
    // 幂等守卫【先查库】，不能靠图里 intake 的 INSERT OR IGNORE：那条语句是为崩溃
    // 续跑准备的（tasks 行已存在时必须忽略），拿它当幂等机制的话，重复 run 会把
    // 整条状态机再走一遍，而它一声不响（0006 §3）。
    if (findTask(db, taskId) !== undefined) {
      io.error(
        "错误：任务已存在，拒绝重复执行 —— task_id = " +
          taskId +
          "\n已完成的任务请换一个 --task；未完成的会话用 hub resume 续跑。\n",
      );
      return { code: 2 };
    }

    io.write("Hub run（Phase 0）\n");
    io.write(
      "  任务：" + taskId + "（thread_id 同值，docs/decisions/0006 §4）\n",
    );
    io.write("  模型：桩（Phase 0，不计费不联网）\n");
    io.write("  库文件：" + dbPath + "\n");

    await auditor.invoke(() =>
      graph.invoke({ idea, current: "CHARTER_PENDING" }, config(taskId)),
    );

    const state = await graph.getState(config(taskId));
    const next = (state as { next?: string[] }).next ?? [];
    const trail = ((state.values as { trail?: CompanyNode[] }).trail ??
      []) as CompanyNode[];
    io.write(
      "  节点执行：" +
        trail.length +
        " 次；模型调用 " +
        models.totalCalls +
        " 次\n",
    );
    // 超步事务数是【审计可观测性】，不是为测试加的装饰：一个超步 = 一次原子提交
    // （docs/decisions/0005 §2），所以"跑完 14 条状态边只提交了 1 个事务"必然意味着
    // 装配漏了 auditor.instrumentSaver(...) 那一层 —— 那时崩溃恢复当场失去意义，
    // 而 events 一行不少、退出码照样是 0（0005 §16 的第 1 类静默陷阱）。
    io.write(
      "  超步事务：" + auditor.committedSteps + " 个（每个 = 一次原子提交）\n",
    );

    if (next.length > 0) {
      // 没跑到 END 又不是崩溃 —— 只能是被中断或图有环。Phase 0 的图没有 interrupt，
      // 所以这里必然是异常，退出码不能是 0：否则"跑完了"这件事变成使用者的猜测。
      io.error("  ⚠ 未跑到 END，待执行节点：" + next.join(", ") + "\n");
      return { code: 1 };
    }
    // 状态从库里读，不写死 "ARCHIVED"：图一改，硬编码就开始说谎。
    const row = findTask(db, taskId);
    io.write(
      "  结果：已跑到 END，状态 = " +
        (row?.status ?? "（tasks 行缺失）") +
        "\n",
    );
    return { code: 0 };
  });
}

async function cmdStatus(
  dbPath: string,
  taskId: string,
  io: CliIo,
): Promise<CliResult> {
  const missing = requireExistingDb(dbPath, taskId, io);
  if (missing !== null) return missing;
  return withHub(dbPath, taskId, async ({ db, graph }) => {
    const task = findTask(db, taskId);
    if (task === undefined) {
      io.error("错误：任务不存在 —— task_id = " + taskId + "\n");
      return { code: 2 };
    }

    io.write("任务 " + task.id + "\n");
    io.write(
      "  状态：" +
        task.status +
        "   当前节点：" +
        task.current_node +
        "   角色：" +
        task.assigned_role +
        "\n",
    );
    io.write("  标题：" + task.title + "\n");

    const state = await graph.getState(config(taskId));
    const next = (state as { next?: string[] }).next ?? [];
    io.write(
      "  图进度：" +
        (next.length === 0 ? "已到 END" : "待执行 " + next.join(", ")) +
        "\n",
    );

    // 轨迹读 payload（事件本体），不读 target（派生摘要）—— 与 Task 0.8 同一条理由。
    // action 的值【从 KIND_TO_ACTION 取】：events.action 存的是 §22.1 的小写枚举
    // （state_change），不是事件类名 TaskStateChanged。写死字符串的话这里会静默查出 0 行。
    const rows = db
      .prepare(
        "SELECT payload FROM events WHERE task_id = ? AND action = ? ORDER BY id",
      )
      .all(taskId, KIND_TO_ACTION.TaskStateChanged) as { payload: string }[];

    io.write("\n状态机轨迹（" + rows.length + " 条）：\n");
    for (const r of rows) {
      const e = JSON.parse(String(r.payload)) as { from?: string; to?: string };
      io.write("  " + (e.from ?? "?") + " -> " + (e.to ?? "?") + "\n");
    }
    return { code: 0 };
  });
}

async function cmdResume(
  dbPath: string,
  taskId: string,
  io: CliIo,
): Promise<CliResult> {
  const missing = requireExistingDb(dbPath, taskId, io);
  if (missing !== null) return missing;
  return withHub(dbPath, taskId, async ({ db, auditor, graph }) => {
    if (findTask(db, taskId) === undefined) {
      io.error("错误：任务不存在 —— task_id = " + taskId + "\n");
      return { code: 2 };
    }

    const before = await graph.getState(config(taskId));
    const bag = before as { interrupts?: unknown[] };
    const interrupts = bag.interrupts ?? [];
    const next = (before as { next?: string[] }).next ?? [];

    // 先读 checkpoint 再决定输入。实测（0006 §1）：无中断时 Command({resume:null})
    // 抛 "Received empty Command input"；而已完成 thread 上 invoke(null) 只推进一个
    // 空超步 —— events 与节点执行都不增。选错一种的两种后果都不可爱，所以不猜。
    // 两个判据本身都在 graph/thread.ts / http/real-deps.ts 可达的那一层：HTTP 侧批准
    // 卡片之后走的是【同一对函数】，不是抄一份。抄一份的漂移方式是
    // 「CLI 能恢复、点批准不恢复」，而两边各自都看着有理由。
    const choice = chooseResumeInput(hasPendingInterrupt(before));
    const input: Command | null = choice === "command" ? new Command({ resume: null }) : null;

    io.write(
      choice === "command"
        ? "  检测到 " + interrupts.length + " 个中断，用 Command(resume) 恢复\n"
        : "  没有待恢复的中断（next = " +
            (next.length === 0 ? "[]，图已到 END" : next.join(", ")) +
            "）\n",
    );

    const count = (): number =>
      (
        db
          .prepare("SELECT count(*) AS n FROM events WHERE task_id = ?")
          .get(taskId) as { n: number }
      ).n;
    const before0 = count();

    // LangGraph 的 invoke 签名不收 null（运行时收，实测跑通），所以必须强转。
    // 这里不用 as never 掩盖：写成 unknown 再转，是为了让"我们知道类型不匹配"这件事
    // 留在代码里，而不是伪装成一个普通调用。
    await auditor.invoke(() =>
      graph.invoke(input as unknown as never, config(taskId)),
    );

    const after0 = count();
    io.write(
      "  审计行数：" +
        before0 +
        " → " +
        after0 +
        (after0 === before0
          ? "（没有重放任何节点）"
          : "（新增 " + (after0 - before0) + " 条）") +
        "\n",
    );

    const after = await graph.getState(config(taskId));
    const stillNext = (after as { next?: string[] }).next ?? [];
    io.write(
      "  图进度：" +
        (stillNext.length === 0
          ? "已到 END"
          : "待执行 " + stillNext.join(", ")) +
        "\n",
    );
    return { code: 0 };
  });
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<CliResult> {
  const p = parseCli(argv);
  if (p.help === true) {
    io.write(USAGE + "\n");
    return { code: 0 };
  }
  if (p.error !== undefined) {
    io.error("错误：" + p.error + "\n\n" + USAGE + "\n");
    return { code: 2 };
  }
  const { verb, db, task, idea } = p;
  if (verb === undefined || db === undefined || task === undefined) {
    // 不可达：parseCli 在 error === undefined 时必然给齐这三项。留着是因为
    // 类型上它们可选，而不是因为相信这里会发生 —— 兜底分支不给真实路径开口子。
    io.error("错误：参数解析结果不完整（内部异常）\n\n" + USAGE + "\n");
    return { code: 2 };
  }
  try {
    if (verb === "run") return await cmdRun(db, task, idea ?? "", io);
    if (verb === "status") return await cmdStatus(db, task, io);
    return await cmdResume(db, task, io);
  } catch (e) {
    // 不吞栈细节：CLI 的失败如果是"库里少一张表""文件被别的进程占住"，只打一句
    // 话会让人反复重跑同一条必然失败的命令。
    io.error("执行失败：" + String((e as Error)?.message ?? e) + "\n");
    return { code: 1 };
  }
}

/**
 * 用真 stdio 跑一条命令，并把退出码写进 process.exitCode。
 *
 * 为什么导出而不是各入口各写一份：这句里有个极易写错、错了又不报任何东西的地方 ——
 * 【括号不能省】。await 是一元运算符，优先级低于属性访问：
 *   await runCli(...).code  →  await (Promise.code)  →  undefined  →  退出码 0
 * 于是每一条退出码断言都假绿（V13 关心的恰恰是退出码）。变异测试 M3 就是专门验证这一
 * 点的，实测能杀掉 6 条测试 —— 但它杀的是【本文件】这一处。写第二份就等于再赌一次，
 * 而这次的赌注没人看着：main.ts 不是测试入口。io 装配同理。
 *
 * 所以：整个仓库只留这一处括号写法和这一处 io 装配，入口块只负责"要不要跑"。
 */
export async function runCliOnStdio(argv: readonly string[]): Promise<void> {
  const io: CliIo = {
    write: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(text);
    },
  };
  process.exitCode = (await runCli(argv, io)).code;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await runCliOnStdio(process.argv.slice(2));
}
