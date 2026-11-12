/**
 * 常驻 Hub 进程的装配（规格 §5.1 / §5.3 / §6.5）。
 *
 * ── 这一篇填的是本仓最后一个【主干级】缺口 ─────────────────────────
 * 写之前的四条 grep（当场跑的，不是回忆）：
 *   · `serveHub(` 在 src/ 里【零】非测试调用点，只有 test/http/server.test.ts 用它
 *   · `buildHubDeps(` 同上；它自己文件头那句注释等的就是本文件
 *     （「真入口（Electron 主进程 / `hub serve`）到 Task 2.2/2.9 落地时接这一行」）
 *   · `runMaintenance(` 只有一个自执行入口调它（那个入口【有】npm script
 *     `hub:maintenance`，我第一版在这里写的是「不在任何 script 里」—— 那句话是错的，
 *     当场查 package.json 就能推翻，而我没查。留着一句错话比少写一句更贵：
 *     读到的人要么照它去补一个已经存在的 script，要么更糟 —— 照它去怀疑这一整段
 *     另外三条【对的】记录）。真正缺的不是脚本，是【有人按节奏叫它】：
 *     script 要人手工敲，而 §6.5 的每日备份不该依赖「人记得跑」。
 *   · `patrol.ts:373` 明写「调度（什么时候醒）属于常驻进程」
 *   · `patrol.ts:373` 明写「调度（什么时候醒）属于常驻进程」
 * 合起来：HTTP 层、依赖装配、完整性巡检、备份、停滞检测全都写完了，
 * 而【没有任何东西把它们叫起来】。§5.1 那句「Hub 是唯一常驻进程」此前描述的
 * 是一堆模块，不是一个进程。
 *
 * ── 启动顺序不是风格问题，三条各自对应一种坏法 ───────────────────────
 *  1. 【抢锁最先】。两个 Hub 同时跑的后果是交错写进 append-only 的审计库，
 *     事后【删不掉】（0014 §3「脏了的审计库删不掉」）。所以它必须早于任何一次
 *     数据库写入 —— 而【迁移也是写入】，于是它甚至早于 openDb。
 *  2. 【打开 + 迁移 + 完整性检查在 HTTP 之前】。反过来的话，一个库有问题的实例
 *     会先对外「运行中」几十秒：界面显示绿色、任务点进去 500。那是 §24 风险 8
 *     要防的形状 —— 可用性的假象比明确的停机更难诊断。
 *  3. 【心跳最后】。它依赖前两步的产物，而且第一轮必须在迁移之后：在未迁移的库上
 *     跑 PATROL_SQL 报的是 "no such table: tasks"，一个会把人引去查心跳模块的错。
 *
 * ── 本文件顶层【不 import】 @langchain/*，也【不 import cli.ts】────────
 * 不是洁癖，是可验证性：`cli.ts` 顶层带 langgraph（它是图的那一侧）。
 * 一旦本文件 import cli.ts，「serve 的启动顺序、退出码、清理」这件事在离线机器上
 * 【一行都测不了】（@langchain 装不上，0009 §2）。于是本机的测试跑的是
 * 【同一条装配路径】，只换掉 graphFor。
 *
 * ⚠⭐ 而这条入口【不装真图】，默认给的是一个「用到就响亮报错」的工厂
 *   （unavailableGraphFor，函数旁边整段写了为什么）。
 *   我第一版照 cli.ts 的 withHub 装了一套真图，那一版是【错的】，
 *   错在它会往唯一的常驻进程里装一个已知会炸的形状 —— 细节与判据在
 *   unavailableGraphFor 上面那段，不要读完这段注释就下结论。
 *   图恢复的接通属 0010 挂在 CEO 名下那条（超步事务的持锁范围），
 *   不是「再写一点就接上了」。**Hub 除图恢复之外的一切都是真的。**
 */
import { existsSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import type { HubDeps } from "../http/app.js";
import type { HubServer } from "../http/server.js";
// createBackup（同步版）在这里【不再被 import】：心跳那一段改走 worker（0036）。
// 同步版仍然活着并且有真消费方 —— maintenance.ts 那条 CLI 路径（那里没有别的东西
// 会被它冻住，见 0036 §6 第 1 条）。这一行少一个 import 就是那次改动的形状本身。
import {
  backupNameToMs,
  BackupWorkerThrewError,
  createBackupOffLoop,
  listBackups,
  type BackupOffLoopOutcome,
  type BackupOffLoopRequest,
} from "../db/backup.js";
import type { WriteQueue } from "../db/write-queue.js";
import { newLocalToken } from "../http/auth.js";
// bind.ts 是【纯字符串逻辑】：不 import http、不开 socket、不读库（import 方向定死为
// bind ← server，理由写在它文件头）。所以装配层可以在【顶层】用它，
// 而不必像 http/server.js 那样等到真要监听时才动态 import ——
// 那一次动态 import 是为了不把 node:http 拖进离线测试，这里没有那个约束。
import {
  BindDecision,
  bindFailureIsFatal,
  defaultBindDecision,
  type BindOutcome,
} from "../http/bind.js";
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from "../heartbeat/maintenance.js";
import {
  DEFAULT_STALL_THRESHOLD_MS,
  HEARTBEAT_INTERVAL_MS,
  runPatrol,
} from "../heartbeat/patrol.js";
import type { EventBus } from "../events/bus.js";
import type { HubWriter } from "../db/write-queue.js";
import type { EngineRuntime } from "../engine/runtime.js";
import {
  pumpCharterCards,
  type CharterCardDeps,
  type PumpOptions,
  type PumpRoundResult,
} from "./charter-pump.js";
import {
  DEFAULT_DRIVER_MAX_TURNS,
  DEFAULT_DRIVER_TASK_LIMIT,
  driveTasks,
  worstDriveWaitMs,
  type DriveOptions,
  type DriveRoundResult,
  type DriveTaskFn,
} from "./driver-pump.js";
import type { TaskGraph } from "../http/real-deps.js";
import {
  DEFAULT_SERVE_USAGE,
  HEARTBEAT_FLOOR_MS,
  parseServeArgs,
  shouldBackUp,
  type ServeArgs,
} from "./config.js";
import {
  acquireLock,
  describeLockFailure,
  releaseLock,
  type LockAcquire,
} from "./lock.js";
import {
  createInFlightWatch,
  createTicker,
  REAL_SCHEDULER,
  type Scheduler,
  type StartOutcome,
  type Ticker,
} from "./timer.js";

/**
 * 端口文件里就一个数字加一个换行。有别的格式就该改这里而不是让读侧猜。
 */
function portFileShape(port: number): string {
  return String(port) + "\n";
}

export interface ServeIo {
  /** 面向人的正常输出（含 token 横幅）。 */
  log(message: string): void;
  /** 面向人的告警与错误。运行期的坏消息都走这里，不走 log。 */
  warn(message: string): void;
}

/**
 * 装配注入点。生产用默认值（空对象），测试用它把四件本机做不了的事换掉：
 * 真图（缺 @langchain）、真锁（要两个进程）、真时钟（要等 15 分钟）、真监听（端口竞争）。
 */
export interface BootOverrides {
  /** 抢锁。测试注入一个恒成功的，好把「锁之后的一切」单独测。 */
  readonly acquire?: (dbPath: string) => LockAcquire;
  /**
   * 按任务给图。**不传 = 引擎路线**（CEO 点批准走 engine/approve.ts，一个事务里
   * 认领卡片 + 写状态边 + 两条审计，任务真的往前一格 —— 0043）。
   * 要接真图（Electron 主进程那条路）就传这一项，决策写路径整条换回
   * applyDecision + makeResumeGraph，理由与两种形状的取舍写在
   * real-deps.ts 的 RealHubDepsOptions.graphFor 那一段，不重抄。
   *
   * ⚠ 这一格的原话是「不传就用 unavailableGraphFor() —— 一个用到就响亮报错的工厂」。
   * 那句在 0043 之前是【事实】，而那个事实的内容是"默认装的是一个被 CEO
   * 第一次点批准就会撞上的抛"（撞上的时候卡片已经落库了）。函数本身仍然导出，
   * 但⚠ 它今天【只有测试在调】（grep 实测：src 里零调用方，调用点全在
   * test/serve/assemble.test.ts 与本包的图路线用例里）—— 也就是说"保留它"目前是
   * 保留一条【接法】，不是保留一条【在跑的路】。这与 0016 §4 那种"零生产调用方"
   * 是同一件事，区别只在于这一次是【明说的】。它不再是默认值。
   */
  readonly graphFor?: (taskId: string) => TaskGraph;
  /** 时间源 + 定时器。默认 REAL_SCHEDULER。 */
  readonly scheduler?: Scheduler;
  /** 心跳节奏覆盖。测试用它把「15 分钟后」变成 advance(900_000)。 */
  readonly heartbeatMs?: number;
  readonly now?: () => number;
  /** WriteQueue 构造点。测试注入假的，好钉「失败路径也一定 close 队列」这种形状。 */
  readonly openQueue?: (dbPath: string) => WriteQueue;
  /**
   * serveHub 构造点。测试注入假 server，好钉「启动半途失败时前面的清理真的跑了」。
   *
   * 第三参 bind 是 Task 4.1 加的。它【刻意放在这里而不是某个 override】：
   * 「监听哪个地址」这件事在装配里只该有一个出口，而那个出口就是 serve ——
   * 若 bind 走 o.bindOverride 之类的旁路，就会出现「假 server 收到了端口而没收到地址」，
   * 于是【绑定策略在测试里根本不可见】，而它是本篇唯一在承重的一条判据。
   * 兼容：TS 允许两个形参的函数赋给三个形参的函数类型，所以既有的假 server
   * 一字不改仍然编译过（它们只是【看不到】bind，而看不到 bind 的假 server
   * 本来也不该被用来断言绑定 —— 新加的那条用例自带一个记录第三参的替身）。
   */
  readonly serve?: (deps: HubDeps, port: number, bind: BindDecision) => Promise<HubServer>;
  /**
   * 备份的执行点（0036）。默认 `createBackupOffLoop` —— 生产走的就是默认值，
   * 这一格【不是】给生产留的第二条路，是给测试留的可控窗口。
   *
   * 为什么必须可注入而不是让测试直接用真 worker：要钉的三条性质
   * （「在飞的备份不许开出第二份」「关机时真的等到了落地」「cancelling 之后不再派新活」）
   * 全都需要一个【停在半路】的备份，而真 worker 只给一个约 100ms 的窗口 ——
   * 靠 sleep 撞窗口就是本仓反复拒绝的那种 flaky（timer.ts 文件头同一取舍）。
   * 与 openQueue / serve 两格是同一个理由：注入的是【时机】，不是【结论】。
   *
   * ⚠ 注入的代价要如实说：走注入的用例【不证明】真 worker 能跑通 ——
   * 那一条由 backup.test.ts 里那些走真 worker 的用例负责（含上面那条「主循环仍在推进」）。
   */
  readonly backupVia?: (req: BackupOffLoopRequest) => Promise<BackupOffLoopOutcome>;
  /** 备份 worker 的超时上限覆盖。不传用 BACKUP_WORKER_TIMEOUT_MS。 */
  readonly backupTimeoutMs?: number;
  /**
   * 启动那一发页面完整性检查的超时上限覆盖。不传用 INTEGRITY_WORKER_TIMEOUT_MS。
   *
   * 与 `backupTimeoutMs` 同一条理由：注入的是【时机】而不是【结论】——
   * 0038 要给「instrument 故障 ⇒ 照常启动但【响一声】」那一格配用例，
   * 而那一格需要一个真的 `unavailable` 从 `runIntegrityScan` 里出来。
   * 替代方案是往 boot 再开一个 `integrityVia`（直接塞一份假报告），
   * 但那只会测到【读那个字段的那一行】，测不到 `pageCheckCell` 那条映射真的产出了
   * could_not_run —— 也就是本篇那个缺陷的本体。所以选超时。
   * ⚠ 生产里把它设成 0 的后果要写明白：每次启动都会「检查没跑成 ⇒ 带警告启动」，
   *   也就是把启动闸门整个关掉。它和 `backupTimeoutMs: 0` 是同一类脚枪，
   *   不额外加防线（加了就变成「生产不许超时」，而那在大库上是假的）。
   */
  readonly integrityTimeoutMs?: number;
  readonly token?: string;
  /**
   * 心跳彻底停掉时的处置。生产传一个「结束进程」的动作（见 runServeCli）；
   * 不传就只告警。用注入而不是让 timer 反过来认识 process —— 那会把
   * 「一轮巡检失败」与「进程该不该退」两件事焊死在一个模块里。
   */
  readonly onHeartbeatFatal?: () => void;
  /**
   * 章程泵的执行点（0044）。默认 `pumpCharterCards` —— 生产走默认值。
   *
   * ⚠ 注入点开在【这一整个调用】上，而【不是】开在 `cardDeps` / `runTurn` 那一层。
   * 理由与 o.graphFor 同一条（一个注入点一个职责），而这里更硬：
   * pumpCharterCards 内部的默认那一支会【惰性】建起真 runtime（charter-pump.ts 的
   * engineOf），而建起来就意味着下一次调用是真 spawn 一个 claude 子进程。
   * 所以装配层的用例要么整颗换掉这一发，要么【自己交出假的 cardDeps】——
   * 不能"只注入一半"，否则测试一边说着不花钱，一边把会花钱的那套东西建起来了。
   *
   * 代价照 backupVia 那条口径写清：走注入的用例【不证】真 runtime 起得了子进程，
   * 那一格由 engine/claude.test.ts 与 runtime.test.ts 负责。
   */
  readonly charterPumpVia?: (
    w: HubWriter,
    bus: EventBus,
    o: PumpOptions,
  ) => Promise<PumpRoundResult>;
  /**
   * 起草一轮用的那套回调（透传给 PumpOptions.cardDeps）。
   *
   * 有了上一条 `charterPumpVia`，这一格【为什么还要】：两者注入的不是同一件事。
   * via 换掉的是【整趟泵】（候选 SQL、放弃判定、执行日志全都不跑了），
   * 而装配层要钉的三条 —— 「开了才跑」「一轮只派一份」「关机等到落地」——
   * 恰好全在【泵自己内部】那些东西的【外面】。只注入 via 的装配用例测不到
   * 「候选为空那一轮根本不建 runtime」这一格，因为那颗假 via 让泵整个没跑。
   * 传这一格 ⇒ 走【真 pumpCharterCards】而只把 spawn 那一步换掉。
   *
   * ⚠ 这一格【不】能单独把泵打开：开关永远是 args.charterPump（来自 --charter-pump）。
   * 装配层注入一份假起草而命令行没开泵 ⇒ 什么都不该发生，
   * 那一条有专门用例（否则「注入即生效」会变成第二条绕过显式开关的后门）。
   */
  readonly pumpCardDeps?: () => CharterCardDeps;
  /** 一轮最多补几张 / 一个任务试几次。透传，测试用它把「三次」变成「一次」。 */
  readonly pumpMaxAttempts?: number;
  readonly pumpTaskLimit?: number;
  /**
   * 起草一轮落进 harness_calls 的那一笔（透传给 PumpOptions.recordTurn）。
   *
   * 为什么和 pumpCardDeps 分开给：engineOf（charter-pump.ts）在【注入了假起草而
   * 没注入执行日志】时走的是 noRecorder —— 那一支是【故意】不回退去建真 runtime 的
   * （建起来就意味着下一次调用可能 spawn）。所以装配层的用例想要同时看这两维时，
   * 必须【两格都给】，而不是给了假的 runTurn 就指望执行日志还是真的。
   */
  readonly pumpRecordTurn?: EngineRuntime["recordTurn"];
  /**
   * 驱动器的执行点（0048）。默认 `driveTasks`。与上面 `charterPumpVia` 同一条分工：
   * 这一格换掉的是【整趟】（候选 SQL、认领行、放弃判定全都不跑）。
   *
   * ⚠ 装配层那三条主张（「开了才跑」「一轮只派一份」「关机等到落地」）
   * 全在【泵自己内部】的外面，所以它们只能靠换掉整趟来数 —— 与章程泵同一条理由。
   */
  readonly driverPumpVia?: (w: HubWriter, bus: EventBus, o: DriveOptions) => Promise<DriveRoundResult>;
  /**
   * 推一条任务那一发（透传给 DriveOptions.driveTask）。与上一条的关系同
   * charterPumpVia / pumpCardDeps 那一对：via 换整趟，这一格只换【最里面那一发】，
   * 于是【候选 SQL、认领行、上限判定、放弃那一行】都还在跑。
   *
   * ⚠ 同样【不能】靠这一格把驱动器打开：开关永远是 args.driverPump。
   */
  readonly driveTask?: DriveTaskFn;
  /** 透传，测试用它把「三次」变成「一次」。 */
  readonly driverMaxAttempts?: number;
  readonly driverTaskLimit?: number;
}

export type BootResult =
  | {
      readonly ok: true;
      readonly port: number;
      readonly token: string;
      readonly portFile?: string | undefined;
      /**
       * 实际监听的地址（Task 4.1）。CLI 那句「Hub 已在 X:port 上服务」用它而不是
       * 写死的 127.0.0.1 —— 写死的那一句在 --bind 之后会变成【一句假话】：
       * 服务其实对所有网卡开放，而日志说只绑了回环。
       * 那种日志比没有日志更坏，因为它是运维唯一会读的一行。
       */
      readonly bindHost: string;
      /** loopback / lan。给 CLI 决定那句「只绑回环」该不该说。 */
      readonly exposure: "loopback" | "lan";
      readonly lockPath: string;
      readonly heartbeat: Ticker;
      shutdown(): Promise<void>;
    }
  | {
      readonly ok: false;
      readonly code: number;
      readonly message: string;
      readonly hint?: string | undefined;
    };

/**
 * 装配结果上「远程审批通道在不在」这一维的最小视图。
 *
 * 为什么写成 Pick 而不是直接收 HubDeps：这一发【只】需要那两个注入点的存在性，
 * 收整个 HubDeps 会让它读起来像「它还会看别的」，而下一个加判据的人就会往那里加
 * （加进去的那一维在测试里【不需要真库】就能构造，见 tokens-route 那组）。
 * 窄到只能读这两格，是「判据只有这一维」这句话的类型表达。
 */
export type ApprovalChannelDeps = Pick<
  HubDeps,
  "redeemApprovalToken" | "issueApprovalToken"
>;

/**
 * 监听决策 = 「人要求什么」×「这次装配能不能支撑远程审批」。
 *
 * ── 为什么从 boot 里抽出来（这件事本身值得记）─────────────────────────
 * 抽之前它内联在 boot 里，于是【致命那一支没有活的分母】：
 * buildHubDeps 现在【总是】装那两个注入点 ⇒ remoteApprovalsWired 恒真 ⇒
 * `--bind 0.0.0.0` 在 boot 里【永远放行】，而「通道没接时不许绑非回环」这条
 * 安全主张在 boot 这一层【一次也没被测过】。
 * 那与本仓反复处理的两件事都不同：不是「分支该删」（它不该删），
 * 也不是「判据写错」（它是对的），是【判据的输入被装配焊成了常量，于是判据恒真】。
 * 抽出来之后，「通道没接 + 要暴露 ⇒ 拒」这一发可以用一份【没接通道的 deps】直接构造，
 * 不需要改装配、也不需要假装。
 *
 * ── 为什么 remoteApprovalsWired 是【读 deps】而不是字面量 true ──────────
 * 写 `remoteApprovalsWired: true` 在今天【恰好为真】，而它会一直为真到有人把
 * buildHubDeps 里那两行改成条件装配为止 —— 那一天字面量仍然编译过、仍然「对」，
 * 而它宣布的事实已经不成立，后果是【一个没有任何远程鉴权的地址被绑上】。
 * 传 deps 而不是一个 boolean，买到的是【判式只在这一处】：调用方交出的是那份它真要
 * 拿去 serve 的 deps（Pick 之后仍然造得出只有那两格的假 deps —— 挡的是
 * 「把一个 true 挪一行」，不挡「伪造一次装配」，准确说法与 bind.ts 的 CONSTRUCTION_KEY 同一条），
 * 而「两个注入点【都】在才算接通」这条 AND 由这里算，不由调用方算。
 * ⚠ 这一条 AND 是【偏严的方向】，而偏严是有意的、也值得质疑一次：
 * 远程鉴权真正依赖的只有 redeem（mint 只认回环，它是【发票】那一侧）。
 * 只接 redeem 不接 mint 时（先做读收件箱、后做签票，是很自然的两次提交），
 * 这一版会说「没接通」而拒掉 LAN 绑定 —— 后果是【该能跑的跑不了】（吵），
 * 而不是【不该能跑的跑了】（吞）。取向按 0026 §5「合并比重复贵」同一条：宁可吵。
 * 如果哪天有人把它改成只判 redeem，请连这一段一起推翻，别只改那一行。
 *
 * ⚠ 反过来别把它读成「boot 里那条致命分支从此被端到端测过了」：
 * boot 那一支今天仍然走不到（原因如上），本函数测的是【判据】，
 * boot 测的是【拿到一个致命拒之后退什么码、说什么话】—— 两件事各有各的分母。
 */
export function bindForAssembly(o: {
  readonly requested: string | undefined;
  readonly deps: ApprovalChannelDeps;
}): { readonly outcome: BindOutcome; readonly remoteApprovalsWired: boolean } {
  const remoteApprovalsWired =
    o.deps.redeemApprovalToken !== undefined && o.deps.issueApprovalToken !== undefined;
  return {
    remoteApprovalsWired,
    outcome: BindDecision.resolve({
      ...(o.requested === undefined ? {} : { requested: o.requested }),
      remoteApprovalsWired,
    }),
  };
}

/**
 * 起一个常驻 Hub。【不抛】—— 所有失败都翻成 { ok: false, code }。
 *
 * 为什么不抛：这个函数的调用方是进程入口，而入口最省事的写法永远是
 * `try { await boot() } catch { console.log(e) }` —— 于是「库坏了」会降级成
 * 一行可忽略的噪音 + 一个不确定的退出码。maintenance.ts 文件头为同一件事写过
 * 同一条决定（「让它抛，调用方最省事的写法就是 catch 里 log 一句然后继续启动」），
 * 这里照抄它的口径。
 */
export async function boot(
  args: ServeArgs,
  io: ServeIo,
  o: BootOverrides = {},
): Promise<BootResult> {
  const dbPath = args.dbPath;
  if (dbPath === undefined) {
    // parseServeArgs 已经把这条拦在 EXIT_USAGE 那一层。留这一发是因为 boot 也是
    // 公开 API（Electron 主进程会直接调它，不经过 argv 解析）。
    return { ok: false, code: EXIT_USAGE, message: "缺 dbPath" };
  }

  const acquire =
    o.acquire ?? ((p: string): LockAcquire => acquireLock(p, { who: "hub-serve" }));

  /**
   * 不创建库。照抄 maintenance.ts 那条：openDb 会【建】文件，而空库的完整性检查
   * 全绿 —— 那是最坏的一种「检查通过」：它让一次库丢失看起来像一次健康巡检。
   *
   * ⚠ 这一发【刻意排在抢锁之前】，而我一开始把它放在锁之后 —— 那是个缺陷：
   * 库不存在时先去锁旁边写一个 <db>.lock，等于【为一个不存在的库留下锁文件】，
   * 于是每次打错路径都在那个目录里留一颗垃圾（而它长得像「有个 Hub 曾在这里跑过」）。
   * 「锁最先」那条纪律保护的是【库的写入】；库不存在就没有写入可保护，
   * 先检查不削弱它，反而少一颗孤儿锁。这一格有专门一条用例（锁目录必须保持干净）。
   */
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      code: EXIT_USAGE,
      message:
        "库文件不存在：" +
        dbPath +
        "\n刻意不创建：空库跑什么都绿，而「Hub 起来了、库是空的」这件事" +
        "要到第一个任务写进去才暴露，那时已经分不清是【没建过】还是【丢过】。",
      hint: "先 pnpm migrate --db <path> 建库",
    };
  }

  // acquireLock 会抛（目录不存在、权限不对）。boot 的契约是【不抛】，
  // 所以这里就地翻成一次失败而不是让它冒出去 —— 让它冒出去的话，
  // 入口那层的 `try { await boot() } catch { log }` 会把它变成一行噪音 + 不确定的退出码。
  let lock: LockAcquire;
  try {
    lock = acquire(dbPath);
  } catch (e) {
    // acquireLock 有两种抛法：写之前抛（目录不存在，没留文件）与写之后抛
    // （读别人锁时 EACCES，此时【可能已经有】一个我们的文件）。
    // 所以这里也要还一次 —— 不还就留下一颗「没有 Hub 的锁」，
    // 而那颗锁会把下一次启动挡住，报错指向「另一个 Hub 在跑」，一个不存在的凶手。
    try {
      releaseLock(dbPath);
    } catch {
      /* 还锁也失败说明文件系统整个不可用，那条信息由下面那句报错带出去 */
    }
    return {
      ok: false,
      code: EXIT_PROBLEM,
      message:
        "抢锁这一步就失败了：" +
        (e instanceof Error ? e.message : String(e)) +
        "\n这一刻【还没有】任何东西被写入库。先修文件系统这一侧。",
    };
  }
  if (!lock.ok) {
    return {
      ok: false,
      code: EXIT_PROBLEM,
      message: describeLockFailure(lock),
      hint: "锁没抢到 ⇒ 没有开过库，也没有任何东西被写过",
    };
  }
  if (lock.tookOverFrom !== undefined) {
    // 说出来而不是静默抢：抢错的方向是双开，而这一句是那种事故唯一的现场记录。
    io.warn(
      "接管了一把【陈旧】的锁：pid " +
        lock.tookOverFrom.pid +
        "（" +
        lock.tookOverFrom.who +
        "）已不存在。若它其实还在跑，现在就是两个写者 —— 请确认。",
    );
  }

  // 从这里开始，任何一条失败路径【都必须】把资源还回去。
  // 用一层 try/finally 而不是在每条 return 前手写 releaseLock：手写的清理有 N 条出口
  // 就会漏 N-1 条，而漏掉的那条留下的是一颗【永久锁死这个库】的锁文件 ——
  // 症状是「重启后再也起不来」，且报错会指向另一个 Hub 而不是指向这里漏的那一行。
  //
  // ⚠ 我第一版【只有 catch，没有 finally】，而那是一处真实缺陷：
  // catch 只接住【抛出来】的错，而本函数绝大多数失败是【就地 return】的
  // —— 完整性检查未通过、迁移失败、serve 抛、心跳参数不合法，四条都是 return。
  // 那四条一条都没还锁。测出来的现象：一次页面损坏的库被拒绝启动之后，
  // 第二次启动报的是「另一个 Hub 在跑（pid 是刚才那个已经退出的进程）」，
  // 而那正是这一篇想消灭的「把一次数据事故伪装成另一个凶手」。
  let queue: WriteQueue | null = null;
  let server: HubServer | null = null;
  let heartbeat: Ticker | null = null;
  let succeeded = false;
  /**
   * 在飞的备份（0036 §3）。两个字段各自是一条性质：
   * `inFlight` ⇒ 不许开出第二份；`cancelling` ⇒ 关机已开始后不再【开始】新的。
   *
   * ⚠ 原来这里还有一个 `let cleaned = false`，本篇【把它删掉了】而不是再叠一道门。
   * 理由不是嫌它多余：job 里那句 `if (cleaned) return` 与 `backupWatch.cancelling`
   * 挡的是【同一件事】，而两道门挡同一件事的代价是**每一道单独拆掉都不红** ——
   * 「补回来的守卫」会变成没人验过的守卫（0036 §5 开头那个「写成装饰」的形状）。
   * 备份那一条路径上的状态因此只有 backupWatch 一个来源。
   * 「清理是否已经跑过」这一格改由下面那条 `cleaning` promise 表示（它同时管
   * 「只跑一次」和「第二个调用方也要等到清完」）。
   */
  const backupWatch = createInFlightWatch<void>();
  /**
   * 在飞的章程起草（0044）。与 backupWatch 同一个对象、同一个理由，而【不合成一个】：
   * 两者管的是不同任务的「不许开出第二份 / 关机后不再派新活」，合成一个之后
   * 「备份还在飞」会挡住起草、反之亦然 —— 而这两件事的处置完全不同
   * （备份慢了要看库多大，起草慢了是正常事：一轮本来就是几十秒）。
   *
   * ⚠ 这一格的存在理由是【不 await】，而那正是本篇最容易被"改对"改回去的一处：
   * 一轮起草的上限是 claude.ts:85 那个 SIGKILL（180s），而心跳下界是 60s。
   * 把它 await 在 job 里面 ⇒ 一轮起草跨过心跳节奏 ⇒ ticker 的
   * 「上一轮还没结束，本轮跳过」（timer.ts:335）⇒ 【巡检与停滞检测被一个起草停掉】。
   * 那个形状与本文件 onFatal 那句「停滞检测现在不再运行」是同一种坏，
   * 区别是它不会被计入 consecutiveFailures、也不会退进程 —— 它是【静默的】。
   * 所以起草走【派发】而不是【等待】，与备份同一条路：关机时由 settle 等它落地。
   */
  const pumpWatch = createInFlightWatch<void>();
  /**
   * 在飞的驱动轮（0048）。与 pumpWatch 【分开而不合成一个】，理由与
   * backupWatch / pumpWatch 分开那条同一条而更硬：
   * 一轮章程起草上限 180 秒，而驱动器一次 advance 最多跑 12 格 ——
   * 每格都可能再花到那个 180 秒上限。合成一个 watch 的话，
   * 【一轮起草会把整趟驱动挡住】，而驱动那一趟本来就该在起草排队时照跑
   * （两者挑的是【不同的任务】：起草挑 CHARTER_PENDING，驱动挑 agent 那一族）。
   *
   * 同样【不 await】：await 它会走 timer.ts 那条「上一轮心跳还没结束，本轮跳过」，
   * 于是【一次推任务把停滞检测与每日备份停掉】，而那一支不计失败、不触发 onFatal、
   * 不退进程 —— 完全静默（0044 量的那一发）。派发 + 关机时 settle 是同一条路。
   */
  const driverWatch = createInFlightWatch<void>();
  /**
   * 关机那句「最坏等多久」的两个乘数（0048）。真设置算出来之后被覆盖。
   *
   * 自带一份【与真默认值同源的】初值而不是 `const` 读下面那个 settings：
   * 那个 settings 在 try 的很深处才赋值，而 giveUpInner 可能在它之前被 finally 触发。
   * 今天那条路径读不到它（inFlight 为真意味着驱动轮已经在跑，那时早已赋值），
   * 但"报出去的数字对不对"不该依赖别处一个布尔的控制流。
   * 初值取常量而【不自己写两个数字】：抄数字就是第二个来源。
   */
  let driverWait: { readonly taskLimit: number; readonly maxTurns: number } = {
    taskLimit: DEFAULT_DRIVER_TASK_LIMIT,
    maxTurns: DEFAULT_DRIVER_MAX_TURNS,
  };

  /**
   * 「因为没钱而不再补这张卡」已经对哪条任务【说过一次话】了。
   *
   * 为什么要有这一格：泵每 60 秒跑一轮，而一条超限的想法会【永远】被门挡住 ——
   * 每轮都说一句就是每天 1440 句同样的话。那不是"提醒"，那是【噪音】，
   * 而噪音的实际后果是这个人把终端静音，于是那句"到上限不再试了"（gave_up，
   * 那一格只有三次、只说一次）也一起被静音了。
   * ⇒ 每任务一次，且【跨轮去重】。追加预算之后它会重新进候选（门放开），
   *   下一轮再被挡住时【仍然不重复说】—— 这一格记的是"这个人已经知道这件事了"，
   *   不是"此刻是否仍然超限"。这是刻意的取舍：代价是"追加完又花超"不会再说一次，
   *   换来的是这个信号不会把自己淹掉。登记在 0045 §6。
   */
  const pumpBudgetWarned = new Set<string>();
  /**
   * 驱动器那一侧的同名集合（0048）。
   *
   * ⚠ 我第一版给这一格写的理由是「同一个 taskId 会合法地在两侧各被挡一次」，
   * 那句话【今天不成立】，而它是【没查就写】的：量过之后是
   *   · `grep 'to: "CHARTER_PENDING"' packages/hub/src/` = 0 处（charter-pump.ts 文件头
   *     记的同一条事实，那里用它支撑「计数只可能来自起草轮」），
   *   · 而 CHARTER_PENDING 【不在】DRIVER_ELIGIBLE_STATES 里（它是人类席位，无 agent 出边）。
   * ⇒ 两个泵挑的任务集合【今天是可证明地不交】。所以"共用一个 Set 会漏掉第二句"
   * 是一个【我今天构造不出例子】的论证 —— 那种论证写在注释里的代价不是难看，是下一个人
   * 会照它去"修"一个不存在的 bug（0047 §7 我刚刚为同一件事改过一次文档）。
   *
   * 那为什么还是两个而不是合成一个？理由要落在能量出来的那半边：
   *   ① 今天不交 ⇒ 合成一个【今天观测不到任何差别】（既不多说一句也不少说一句）。
   *      "合起来更简洁"因此不是一个能支持合并的证据 —— 它连红都造不出来。
   *   ② 会打破①的那一天是【有人补上"退回的章程该去哪条边"】那天（0044 §9.1 正等这个），
   *      那条边一存在，同一 taskId 就会在两侧各自该说一句，而共用集合会咽掉第二句。
   *   ③ ②的代价（少一句真话，且少的那句恰好是"这条已花钱的任务又停了"）
   *      与今天合并省下的东西（一个 Set 的声明）不对称。
   * 所以这一格的身份是【今天不承重的保险】—— 与 charter-pump.ts 里那条
   * 「候选为空那道早退是等价变异而今天不承重」同一类，写清楚比让它看起来像判据诚实。
   */
  const driverBudgetWarned = new Set<string>();

  /**
   * 唯一的清理出口。成功时的 shutdown 与失败时的 finally 走【同一段代码】——
   * 分开的两份清理一定会漂移（漂移的形式是「失败路径少了某一步」）。
   *
   * ⭐ 备份挪进 worker 之后，「关机时有一份备份在飞」又成了【真实状态】（0036 §3），
   * 所以「等它落地」这一步【跟着回来了】，而它带回来的是三样东西而不是一个 await：
   *  ① 位置必须在 `queue.close()` 与还锁【之前】。写反的后果不是丢一份备份那么轻 ——
   *    是「备份在一个已经没有锁的库上跑完」，那期间另一个 Hub 可以起开并写同一个库。
   *  ② `beginCancel()` 必须在【任何 await 之前】。它是「不再派新备份」那道门，
   *    而它一旦被推迟到 await 之后，「清理流程自己又派了一件要等的活」就重新成立了
   *    —— 这一发是 0025 §3 第 ④ 条那一族的正主，所以下面三行的顺序整体是判据。
   *  ③ `heartbeat?.stop()` 在 settle 之前：ticker 还在跑的话，等备份的那段时间里
   *    照样能叫起新一轮巡检。
   *
   * ⚠ 为什么这里要【记住那条 promise】而不是只留一个 boolean：
   * 加了 await 之后，`if (cleaned) return` 的语义从「清过了」变成【正在清、你别管】——
   * 第二个调用方会在资源还没还完时就拿到 resolve。改之前 giveUp 里也有 await（server.close），
   * 所以那一格【本来就漏】，只是那时 await 的东西都很短，看不出来。
   * 现在 await 的是一份可能几秒的备份，所以把它补上：同一个清理只跑一次，
   * 而叫它的人【都等到它跑完】。
   */
  let cleaning: Promise<void> | null = null;
  const giveUpInner = async (): Promise<void> => {
    // ⭐ beginCancel 【全在任何 await 之前】，而且是【三个 watch 各一次】：
    // 0025 §3 第 ④ 条那一族管的是"关机已经开始而下面又派了新活"，
    // 而备份 / 章程泵 / 驱动器是【三条会派新活的路】—— 只关其中两条，
    // 剩下那条在 settle 那段时间里仍然能被【最后一轮心跳】叫到
    // （heartbeat.stop() 只挡【新】的一轮，已经在跑的那一轮走到派发那一行时挡不住）。
    // ⚠ 这一处从两条变三条时，注释里那句「两个 watch 各一次」也跟着改了 ——
    //   一句写着"两个"的注释配三行代码，是下一个删掉一行的人的许可证。
    backupWatch.beginCancel();
    pumpWatch.beginCancel();
    driverWatch.beginCancel();
    heartbeat?.stop();
    // 等一份在飞的备份。settle() 永不 reject（rejection 在 watch.start 里面被吞掉，
    // 而那句「备份没得出结论」由派发处自己 catch 之后说 —— 见 job 那里），
    // 所以清理路径不会被一份备份的失败打断。
    await backupWatch.settle();
    /**
     * 等一轮在飞的章程起草【也必须在这一步】，而理由不是"别丢掉这次成果"那么轻：
     * 泵的每一笔写入都走 q.node(...)（写队列），而下面就是 queue.close()。
     * 不等 ⇒ 一次起草会在【队列已关、锁已还】之后去写这个库，
     * 那期间另一个 Hub 可以起开并写同一个库 —— 与上面备份那一条 ① 是【同一个事故】。
     *
     * ⚠ 代价要写明并且体现在那句话里：等的最坏情况是 claude.ts:85 那个 180 秒 SIGKILL。
     * 也就是 Ctrl-C 之后最坏要等三分钟才退。选它而不是"直接关队列"，
     * 是因为后者的失效面是【脏写进 append-only 审计库】（0014 §3：删不掉），
     * 前者的失效面是【人多等一会儿】。两者不对称。
     * 所以这里在【真的在等】的时候说一声，而不是让人对着一句"停止顺序：…"干等三分钟
     * —— 那句横幅承诺过的顺序与实际不符时，读的人会以为进程卡死了并去 kill -9，
     * 而 kill -9 才是真正会留下脏 WAL 的那一步。
     */
    if (pumpWatch.inFlight) {
      io.warn(
        "有一轮章程起草还在飞 ⇒ 等它落地再关队列（最坏 180 秒，那一发自己有 SIGKILL 上限）。\n" +
          "→ 【不要 kill -9】：等它落地只会慢，kill -9 会留下一条没关的连接与一次没写完的事务。",
      );
    }
    await pumpWatch.settle();
    /**
     * 等一趟在飞的驱动轮【也必须在这一步】，而同一条理由（写队列 + 锁）之外
     * 还有一条更硬的：驱动器【先写认领行再花钱】（driver-pump.ts 文件头那条），
     * 所以在【中间】被切断不会留下假记录，但会留下【半条状态链】——
     * 一轮 advance 里那条链是一个事务（dispatch 内部），事务没提交就是【没发生】，
     * 而 append-only 的审计库不能出现"钱花了而链半截"这种无法解释的形状。
     *
     * ⚠ 等的最坏情况【必须说准】，而它不是章程泵那个 180 秒。
     * 我第一版在这里抄的是"最坏 180 秒"—— 那是【抄上一段的话而没算这一趟】，
     * 错了一个数量级：一趟驱动 = 至多 taskLimit 条任务 × 每条至多 maxTurns 格
     * × 每格至多 180 秒。默认 3 × 12 × 180s = 6480 秒 = 【1 小时 48 分】。
     * （⚠ 我第一版在【这两处注释】里都写成"3 小时 12 分"—— 那是【从上一段的话推出来的数】
     * 而不是算出来的，被 driver-pump.test.ts I 组那发红出来才改掉。0048 记这一条。）
     * 一句"最坏三分钟"的承诺会让人老老实实等，而等到第四分钟他会判定进程死锁并 kill -9 ——
     * 那正是这句话本来要防的那一步。所以下面那句把【三个乘数与它们的参数名】都打出来，
     * 让人能自己判断要不要去改配置而不是去改信号。
     * （数字来自 bounds，不写死字面量：有人把 --driver-task-limit 调小，这句话要跟着变。）
     */
    if (driverWatch.inFlight) {
      io.warn(
        "有一趟驱动还在飞 ⇒ 等它落地再关队列。\n" +
          "→ 最坏要等【" +
          worstDriveWaitMs(driverWait) +
          "】：一趟 = 至多 " +
          driverWait.taskLimit +
          " 条任务 × 每条至多 " +
          driverWait.maxTurns +
          " 格 × 每格至多 180 秒（claude 那一发的 SIGKILL 上限）。\n" +
          "→ 【不要 kill -9】：等只是慢；kill -9 会留下没关的连接、没提交的事务，" +
          "而那时钱已经花了而状态边没落库（审计里查不到那一轮，只能从 harness_calls 反推）。\n" +
          "→ 嫌等太久就把每轮推几条 / 每条推几格调小（那两个数就是为这件事存在的）。",
      );
    }
    await driverWatch.settle();
    if (server !== null) {
      try {
        await server.close();
      } catch {
        /* 已经在报错路径上了，不再堆第二层错 */
      }
    }
    if (queue !== null) {
      try {
        await queue.close();
      } catch {
        /* 同上 */
      }
    }
    // 顺序：先关连接、最后删锁。反过来的话，「还锁之后、连接还没关」那一小段里
    // 另一个 Hub 可以起来并立刻撞上这条还没关的连接 —— 它会在自己的迁移那一步
    // 撞到一个属于别人的报错，而那条报错不会提到这里还有个进程正在退出。
    const rel = releaseLock(dbPath);
    if (!rel.removed) io.warn(rel.note);
    if (args.portFile !== undefined) {
      // 端口文件留着会让下一次「连上一个已经不存在的 Hub」——
      // 症状是界面一直转圈而不是「Hub 没起」，所以要清。
      try {
        writeFileSync(args.portFile, "");
      } catch {
        /* 清不掉不改变「本进程已经停了」这个事实 */
      }
    }
  };
  const giveUp = async (): Promise<void> => {
    // 同步地占住这条 promise：`cleaning = giveUpInner()` 里的 giveUpInner
    // 在【第一个 await 之前】是同步跑完的（timer.ts 那条同族的坑），
    // 而这里靠的是「赋值发生在任何人第二次读之前」—— 同步路径上这一句一定先落地。
    if (cleaning === null) cleaning = giveUpInner();
    await cleaning;
  };

  try {
    const { WriteQueue } = await import("../db/write-queue.js");
    const openQueue =
      o.openQueue ?? ((p: string): WriteQueue => new WriteQueue(p));
    try {
      queue = openQueue(dbPath);
    } catch (e) {
      // 开连接【自己会抛】，而这一刻正是最需要说话的时刻（maintenance.ts 同一格：
      // 实测截断的库死在 applyPragmas 上，连 PRAGMA 都没跑到）。
      return {
        ok: false,
        code: EXIT_PROBLEM,
        message:
          "库打不开：" +
          (e instanceof Error ? e.message : String(e)) +
          "\n→ 不是用法错误。恢复步骤见 scripts/restore.md（先停 Hub、先把现网库改名留一份、再从备份恢复）。",
      };
    }

    // 迁移放在锁【之后】：它是写入，必须只有一个写者能做。
    try {
      const { migrate } = await import("../db/migrate.js");
      const m = migrate(queue.writeConnection());
      if (m.applied.length > 0) {
        io.log("迁移：本次新应用 " + m.applied.join(", "));
      }
    } catch (e) {
      return {
        ok: false,
        code: EXIT_PROBLEM,
        message:
          "迁移失败：" +
          (e instanceof Error ? e.message : String(e)) +
          "\n迁移是事务性的，失败那一版没有落库，库里停在最后一个成功的版本。",
      };
    }

    // 启动时的完整性检查。判据是 page_integrity === violated，不是 report.ok，
    // 理由写在 integrity.ts 的 pageIntegrityBroken 上（用 ok 会挡掉一大半正常启动）。
    const { pageIntegrityBroken, runIntegrityScan } = await import(
      "../db/integrity.js"
    );
    const report = await runIntegrityScan({
      dbPath,
      db: queue.readConnection(),
      writer: queue,
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.integrityTimeoutMs === undefined
        ? {}
        : { timeoutMs: o.integrityTimeoutMs }),
    });
    if (pageIntegrityBroken(report)) {
      return {
        ok: false,
        code: EXIT_PROBLEM,
        message:
          "启动时的页面完整性检查未通过 ⇒ 【拒绝启动】，不是「带伤运行」。" +
          "\n  · 原始输出：" +
          report.pageReport +
          "\n带伤运行的后果是把损坏【写深】：新事件会追加到一个已经不自洽的库上，" +
          "于是连「从哪个时刻起不可信」都答不出来。" +
          "\n→ 按 scripts/restore.md 恢复（先停 Hub、先把现网库改名留一份、再从备份恢复），然后重来。",
      };
    }
    /**
     * ⚠ 0038：闸门【不】拦的那一种，必须在这里【响一声】。
     *
     * `pageIntegrityBroken` 的注释一直写着「instrument 故障不算损坏，
     * 而它该做的（响一声、指路）由调用方在别处做」—— 分工写对了，
     * 但「响一声」这一半【全仓没有任何地方做】（复算：src 下读 `report.unavailable`
     * 的非注释代码 0 处）。于是那一格的实际行为是「一声不吭地照常启动」，
     * 而它刚从「拒绝启动 + 指路恢复文档」改过来 ——
     * **两个方向都错，而错在同一个信息缺失上**：读的人不知道这次启动【没有】被
     * 页面检查保护过。0037 那个缺陷（入口在 0037 之前加载不了）在改完之后
     * 就会落到这一格：以前是拒绝启动（吓人但响），后来会变成完全静默。
     *
     * 所以这里 io.warn 而不是 return：库没有被证明坏了，Hub 该起（0037 §1.2）。
     * 但它【不能像什么都没发生】—— 措辞要把「这次启动少了哪一层保护」说出来，
     * 并且指到【修 instrument】而不是指到 restore.md：
     * 把人送去恢复一份健康的库，就是这条改动想消灭的那个动作本身。
     *
     * 用 warn 而不是把 boot 判失败，还有一层：这一格在【每次启动】都可能命中
     * （120 秒超时在大库上不是想象的），把它判失败等于让一次慢扫描变成整机不可用 ——
     * 那正是 pageIntegrityBroken 那段注释拒绝的事。
     */
    if (report.unavailable !== undefined) {
      io.warn(
        "页面完整性检查【没有跑成】（" +
          report.unavailable +
          "）⇒ 本次启动【没有】被页面完整性保护过一道。" +
          "\n  · 原因：" +
          report.pageReport.slice(0, 300) +
          "\nHub 照常起来（库并没有被证明坏了），但【别把它当成「检查通过」】。" +
          "\n→ 要修的是这台机器上的检查通路（worker / 超时 / 依赖），" +
          "不是库。**不要**照 scripts/restore.md 恢复 —— 那会把一份可能完全健康的现网库覆盖掉。",
      );
    }

    const { InMemoryEventBus } = await import("../events/bus.js");
    const { buildHubDeps } = await import("../http/real-deps.js");
    const token = o.token ?? newLocalToken();
    // 一个实例，两处共用（buildHubDeps 与心跳的 runPatrol）。
    // 两个 InMemoryEventBus 的后果是「决策事件写进了 A，而 SSE 订阅挂在 B」：
    // 界面永远显示旧状态，而审计里全都对，HTTP 照旧 200 —— 又一个静默。
    // 我第一版正是 import 了两次 events/bus.js 各 new 一个，所以这一格有专门一条用例。
    const bus = new InMemoryEventBus();
    // ⚠ 这一行在 0043 改了默认值，原文留着：
    //   const graphFor = o.graphFor ?? unavailableGraphFor(dbPath);
    // 那一句把【一个被叫到就抛的工厂】当成了默认值，而它被叫到的时机是
    // 【CEO 点完批准之后】—— 那一刻卡片已经落库成决策了（实测见 0043 §1：
    // 500 + 卡片 approved + 任务 CHARTER_PENDING + 再点一次回 replayed:true）。
    // 也就是说"默认值"这个词在这里的含义是：
    // **装完就跑不通的那一条，是这台机器上唯一会被用到的那一条。**
    // 现在不传图就是不装图（buildHubDeps 缺图 ⇒ 引擎写路径，任务真的往前一格），
    // unavailableGraphFor 仍然导出、仍然给"显式要一条图路线的调用方"用（见它的注释）。
    const deps = buildHubDeps({
      queue,
      bus,
      token,
      ...(o.graphFor === undefined ? {} : { graphFor: o.graphFor }),
      ...(o.now === undefined ? {} : { now: o.now }),
      // 校验 IM 身份绑定的署名来源（0031）。从 --ceo 来，不传 ⇒ 那条路由 501。
      // 这里【再判一次空白】而不只靠 config.ts：boot 是公开 API（下面那条
      // heartbeatMs 同款理由），而一个空白串传给 markVerified 会被
      // invalidText 拒成 422 —— 症状指向「你请求写错了」，
      // 而真相是启动参数是个空值。宁可是那句 501（它说的是「这台 Hub 没配署名」）。
      ...(args.ceo === undefined || args.ceo.trim() === ""
        ? {}
        : { bindingVerifier: args.ceo.trim() }),
      // 组织提交（0040）：只有配了 --backup-dir 才接 commitOrgChange ——
      // §6.5 要求「改组织之前留一份能回到起点的快照」，没备份目录就不给改。
      // 备份的执行点复用同一个 backupVia（BootOverrides 可注入），于是测试对
      // 心跳备份与组织备份注入同一套假备份，两者的编排方向一致。
      ...(args.backupDir === undefined
        ? {}
        : {
            orgDbPath: dbPath,
            orgBackupDir: args.backupDir,
            ...(o.backupVia === undefined
              ? {}
              : { backupBeforeCommit: o.backupVia }),
          }),
    });
    // 没给 --ceo 就把「verify 那条路由是死的」当场说出来，理由与上面那句
    // 「本入口未接图运行时」完全同一条：一个只在人点了按钮才发现的 501，
    // 排查的人会先去查自己有没有权限，而真相是启动命令少了一个参数。
    if (args.ceo === undefined || args.ceo.trim() === "") {
      io.warn(
        "未指定 --ceo <名字> ⇒ POST /bindings/verify 会回 501。\n" +
          "IM 身份绑定的读侧（GET /bindings）与申请（POST /bindings）不受影响。\n" +
          "校验一个身份必须交出「谁验的」，而这个名字只能由启动命令给出（不给默认值）。",
      );
    }
    /**
     * ⚙ 泵开着而某一格【形状不对】⇒ EXIT_USAGE，且判在【HTTP 与心跳之前】。
     * 判据本体在 pumpBoundsOf（纯函数，直接可测），这里只剩「退什么码、说什么话」。
     *
     * ⚠ 「之前」到这里为止是【真的之前】，别把它读成"之前什么都没发生"：
     * 这一刻锁已抢、库已开、迁移已跑（迁移是写入，见文件头那条顺序理由）。
     * 所以这一发的 return 走的必须是【带清理的那条出口】—— 它就是 try 里的一条 return，
     * finally 会把锁还掉、队列关掉。将来若把这一发上提到抢锁之前，
     * 「不碰锁也不碰库」那条断言（assemble.test.ts 缺 dbPath 那一发的同款）才该加上。
     *
     * 为什么不在这里就地判形状而抽成纯函数：与 bindForAssembly 被抽出来是同一条理由
     * （那个函数上面整段写了）—— 内联在 boot 里的判据，它的【致命那一支可能根本没有
     * 活的分母】，于是"这条安全主张被测试过"是一句无法兑现的话。抽出来之后
     * 「泵开着而预算缺失 ⇒ 拒」这一发不需要库、锁、假 server。
     *
     * 为什么判在决策写路径那两句【之前】：形状不对就直接退 2，让人先读到那句
     * 「泵会真起子进程，所以没有上限时不能起」，而不是先读十几行启动横幅。
     */
    const bounds = pumpBoundsOf(args);
    if (bounds.ok !== true && bounds.reason === "invalid") {
      return {
        ok: false,
        code: EXIT_USAGE,
        message:
          "花钱的那两个开关（--charter-pump / --driver-pump）开着而这几格不成立：" +
          bounds.bad.join("、") +
          "\n→ 两个开关都会【真起 claude 子进程】（一个起草章程，一个推角色干活），" +
          "所以没有上限时不能起。" +
          "\n  走命令行时 parseServeArgs 会先拦掉；走到这一发说明 args 是直接构造的" +
          "（Electron 主进程那条路），那就得在那里补齐这三格。",
      };
    }
    /**
     * ⭐ 0048 起这里【不再是一个 pumpOn 而是两个】，而那不是一个审美决定。
     *
     * 原来那一句 `const pumpOn = bounds.ok === true` 把【两个不同的问题】合成一个布尔：
     *   ① 那三格上限有效吗（bounds 回答的）
     *   ② 章程泵开着吗（下面那句启动横幅回答的，而它读的就是 ①）
     * 只有一个开关时 ① 与 ② 恰好等价，所以那次合成看不出问题。
     * 加了 --driver-pump 之后它们【分岔】：只开驱动器的话 ① 真而 ② 假，
     * 而那句横幅会说「章程卡【由泵起草】」—— 一句写在【关着的泵】上的谎话，
     * 且它下面两行还在教人敲 hub work，两句矛盾的话打在同一屏。
     * 所以：charterOn / driverOn 各读【各自的开关】，bounds 只贡献那三个数。
     *
     * 这与 0044 那句「不另设一个 args.charterPump === true」不冲突 ——
     * 那条禁的是【同一个问题】有两个来源；这里是【两个问题】各有一个来源。
     * 合成回去才是把"哪个泵开着"这件事变成两个来源（bounds 与开关）。
     */
    const charterOn = args.charterPump === true && bounds.ok === true;
    const driverOn = args.driverPump === true && bounds.ok === true;
    if (bounds.ok === true) {
      // ⚠ 目录【存在与否】不在那道形状判据里，而这是有意的分界：config.ts 是纯函数、
      // 不碰 fs（它文件头那条），到这一刻才第一次有条件看文件系统。
      // 而这一发【不判致命】，理由要说清：目录不存在时真那一发是 spawn 时的 ENOENT，
      // 被 charter.ts 记成一次【失败的起草轮】（有审计、计入尝试次数），
      // 到上限后泵自己放弃并留一行 CharterDraftAbandoned。
      // 它的失败面是「花掉至多三轮 + 四行审计然后停」，不是无限烧钱 ——
      // 那是一个【会自己收敛的形状】。为它拒启动反而少说话：拒启动只有一句"目录不存在"，
      // 而这条路径会在审计里留下【每一次为什么没成】的原文。
      if (!existsSync(bounds.bounds.cwd)) {
        io.warn(
          "--agent-cwd 指向的目录现在【不存在】：" +
            bounds.bounds.cwd +
            "\n→ 泵照开，不拦。真起子进程那一刻会撞 ENOENT，那会被记成一次【失败的执行轮】" +
            "（审计里有原文），试到上限后泵【自己不再试】并留一行放弃记录" +
            "（章程那侧 CharterDraftAbandoned，驱动那侧 DriverTurnAbandoned）。\n" +
            "→ 不是致命错，但代价是【三轮失败才停】。这个目录该由谁建，是启动脚本的事。",
        );
      }
      if (charterOn) {
        io.warn(
          "章程泵【已开】（--charter-pump）：每隔一个心跳，停在「等章程」而收件箱里没有卡的任务，\n" +
            "会由 assigned_role 那个角色【自己起草一份章程提案】放进 CEO 收件箱。\n" +
            boundsLine(bounds) +
            "\n这是【真起子进程、真花钱】的一件事，而它现在由这台常驻进程自动做。" +
            "泵只【起草】—— 那张卡仍然要 CEO 点，没有任何一条边被自动批掉。",
        );
      }
      if (driverOn) {
        /**
         * 驱动器那句横幅。它与章程泵那句【分开打】而不合并成一句"泵已开"：
         * 两个开关是两条独立的决定，而横幅是这个人唯一能看到「这台机器接下来会
         * 自己花钱」的地方 —— 合并之后只开一个开关的人会读到两个都开了。
         *
         * ⚠ 那句「同一格试到上限就停并说出来」不是宣传话而是【判据的复述】：
         * 上限本身在 driverCandidatesSql，而这一句复述的是它的【数量级承诺】。
         * 所以这里【不写具体次数】—— 写死一个数字就是第二个来源，
         * 它漂的时候（有人把 DEFAULT_DRIVER_MAX_ATTEMPTS 调成 5）没人会红，
         * 而读的人会拿屏幕上的数字去对审计里的 attempt/max_attempts 并判定系统坏了。
         */
        io.warn(
          "驱动器【已开】（--driver-pump）：每隔一个心跳，停在 agent 那一格（拆解 / 干活 / 审阅）的任务\n" +
            "会被 assigned_role 那个角色【自己推一轮】，一路走到需要你的那一格才停。\n" +
            boundsLine(bounds) +
            "\n这是【真起子进程、真花钱】的一件事：一条想法可能连着烧掉好几轮。" +
            "走到人席（等章程 / 等你裁决 / 等终审）它就【停下等你点】—— " +
            "没有任何一条人类边被自动批掉。\n" +
            "→ 同一格试到上限就不再试，并在这个终端【说出来】。那句要响：驱动器每推一轮都在审计里" +
            "留一行，而停滞巡检把「有审计行」读成「这一格有人在看着」—— " +
            "还在试的那几轮里巡检【看不见这一格】，到顶那一刻的当场信号只有这一句。",
        );
      }
    }

    // 启动时就把「这一台 Hub 的决策写路径是哪一条」说出来，而不是等到有人点批准才发现。
    // 判据是【装配上给没给图工厂】—— 那正是 buildHubDeps 的选路输入本身（0043），
    // 所以这一句不可能与事实漂移：它读的就是分岔的那个值。
    if (o.graphFor === undefined) {
      // ⚠ 这一支的【原文】是「本入口未接图运行时：批准会落库而图不会自动往下跑，
      // 每条批准之后需要跑一次 hub resume」。那两句话在 0043 之前【字面上都对】，
      // 而它们合起来盖住了一个具体的坏：hub resume 在 cli.ts 那一侧，
      // cli.ts 顶层 import @langchain/langgraph（本机装不上），
      // 而那一次批准失败的时候【卡片已经落库成决策了】——
      // 报错教的那一步在这台机器上跑不起来，而第二次点会返回 replayed:true。
      // 所以这一支现在说的是【这台机器上真的会发生什么】，不是【哪个模块没装上】。
      io.warn(
        "决策写路径 = 【引擎那一条】：CEO 点批准 ⇒ 认领卡片 + 状态边 + 审计，一个事务，\n" +
          "任务真的往前一格（例如 CHARTER_PENDING → CHARTER_APPROVED）。不需要图运行时。\n" +
          // ⚠ 下面这一句【按 charterOn / driverOn 取措辞】（0048 起是三态，别改回两态）。
          // 原来那句读的是 pumpOn，而 pumpOn 当时等价于「章程泵开着」。
          // 两态版在只开驱动器的情况下会说「CHARTER_APPROVED 之后的每一步都要有人跑」——
          // 那正是驱动器已经不需要的那件事，而它会让人去敲一条【系统已经自己敲过】的命令。
          (charterOn || driverOn
            ? charterOn && driverOn
              ? "这一台 Hub【两个泵都开着】：章程卡由泵起草，之后的每一格由驱动器自己往前推\n" +
                "  —— 你只在三处出现：批章程、裁决升级、终审。不需要有人敲 hub work。\n"
              : charterOn
                ? "章程卡【由泵起草】（上面那段就是它开的），CHARTER_APPROVED 之后的每一步仍要有人跑\n"
                : "章程卡【没人起草】（没开 --charter-pump）：CHARTER_PENDING 那一格仍要有人先跑一次 work，\n" +
                  "  而批完之后【由驱动器自己往下推】（上面那段就是它开的），不需要再逐格敲命令\n"
            : "本入口【不跑角色也不起草章程卡】：CHARTER_APPROVED 之后的每一步都要有人跑\n") +
          "  pnpm hub:engine work --db " +
          dbPath +
          " --task <id> \\\n" +
          "      --max-budget-usd <每轮美元硬顶> --task-limit-cents <任务上限美分>\n" +
          "那【两个参数是必填的】（0041 §8：花钱的上限不给默认值），所以这一行不能整行照抄 —— " +
          "少抄一个拿到的是「缺参数」，而它会让人以为是命令写错了。\n" +
          "⚠ 那条命令要 tsx，本机装不上（0039 量的那半）：装不上就是跑不了，" +
          "这一句提示替你解决不了，它只保证【不说一句照抄会挂的补救命令】。",
      );
    } else {
      // 图路线：调用方【显式】交了图工厂，所以这是选上去的，不是默认撞上的。
      // 警告留着，因为形状没变：applyDecision 只认领卡片，任务靠图恢复。
      io.warn(
        "决策写路径 = 【图那一条】（装配交了图工厂）：批准只认领卡片，" +
          "任务靠图恢复。\n" +
          "图恢复失败的那一次【卡片已经落库成决策】，而第二次点会返回 replayed:true ——\n" +
          "所以这一条路线要求图真的能跑。补救命令：" +
          resumeCommand("<id>", dbPath) +
          "。原因见 " +
          GRAPH_NOT_WIRED + " 那条报错原文。",
      );
    }

    /*
     * ── 监听地址（Task 4.1）──────────────────────────────────────────
     * 判据全在 http/bind.ts，「装配上通道在不在」这一维在 bindForAssembly（上面），
     * 这里只剩三件装配的事：拒了分致命与否、非致命要响一声、告警每次启动都打。
     *
     * ⚠ 致命那一支【此刻在 boot 里没有活的分母】：buildHubDeps 总是装那两个注入点，
     * 所以从这里走到 bindOutcome 时 remoteApprovalsWired 恒真。分支保留而不是删掉，
     * 理由与 app.ts 里 501 那一支同源（契约先行 + 判据本身另有分母），
     * 而它的判据分母在 bindForAssembly 那一组用例里 —— 不在这里。
     */
    const { remoteApprovalsWired, outcome: bindOutcome } = bindForAssembly({
      requested: args.bind,
      deps,
    });
    if (bindOutcome.ok !== true) {
      if (bindFailureIsFatal(bindOutcome)) {
        return {
          ok: false,
          // EXIT_USAGE（2）而不是 EXIT_PROBLEM（1）：这不是「环境坏了」，
          // 是【这一次命令的要求此刻满足不了】，修法在命令行上而不在机器上。
          // 退 1 会让人去查端口、查防火墙、查日志，而真相是他得先把通道接上
          // 或者去掉一个参数 —— 退出码是这条报错里唯一一定被读到的部分。
          code: EXIT_USAGE,
          message: bindOutcome.message,
          hint:
            remoteApprovalsWired
              ? "装配上【有】token 通道而仍被拒：这是 bind.ts 的判据本身出了问题，不是配置问题。"
              : "装配上没有 token 通道。今天 buildHubDeps 会装它，所以真走到这一格" +
                "说明装配被改过 —— 先确认那次改动是否有意。",
        };
      }
      // 非致命（打错成主机名 / 垃圾串）⇒ 退回默认回环，但【必须响一声】。
      // 这里不退成「安静用默认」：那个人以为自己指定过监听地址，
      // 而两句话的差别是他今晚会不会以为远程已经能连（不能）。
      io.warn(
        "忽略 --bind（" +
          bindOutcome.reason +
          "）：\n" +
          bindOutcome.message,
      );
    }
    // 上面那一支不 return，所以这里要自己再取一次默认。
    // 不用「在上面那支里塞一个 decision 变量再往下带」：那会让默认值出现在两个地方，
    // 而这两个地方将来会漂（一处给回环、一处给 ::1 这种事故不值得冒）。
    const bind: BindDecision = bindOutcome.ok
      ? bindOutcome.decision
      : defaultBindDecision();
    // bind.warning 是【只有非默认取值才非 null】的那一句（::1 的栈提示 / LAN 的暴露告警）。
    // 回环默认时它是 null，于是【正常启动不会多打一行】—— 这不是省字：
    // 每次都打的告警会被读的人训练成噪音，而这条告警要防的正是
    // 「没人再看它的那一天」。真正每次都要说的只有一句，在 runServeCli 那行
    // 「Hub 已在 <host>:<port> 上服务」，而它现在打的是 bind.host 而不是写死的 127.0.0.1。
    if (bind.warning !== null) io.warn(bind.warning);

    const serve =
      o.serve ??
      (async (d: HubDeps, p: number, b: BindDecision): Promise<HubServer> => {
        const { serveHub } = await import("../http/server.js");
        return await serveHub(d, { port: p, bind: b });
      });
    // args.port 为 undefined 时传 0 ⇒ 系统分配。这正是 --port-file 那条路。
    const requested = args.port ?? 0;
    try {
      server = await serve(deps, requested, bind);
    } catch (e) {
      return {
        ok: false,
        code: EXIT_PROBLEM,
        message:
          "HTTP 服务起不来：" +
          (e instanceof Error ? e.message : String(e)) +
          (requested === 0
            ? ""
            : "\n端口 " +
              requested +
              " 大概率被占了。换一个，或改用 --port-file 让系统分配。"),
      };
    }
    if (args.portFile !== undefined) {
      writeFileSync(args.portFile, portFileShape(server.port));
    }

    const scheduler = o.scheduler ?? REAL_SCHEDULER;
    const heartbeatMs =
      o.heartbeatMs ?? args.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
    // 这两发校验在 config.ts 里【也有一份】（parseServeArgs）。重复是刻意的：
    // boot 是公开 API，Electron 主进程给的 args 不经过 argv 解析。
    // 「配置层不 import 业务阈值」这条只在 config.ts 成立，所以阈值比较放在这里。
    if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) {
      return {
        ok: false,
        code: EXIT_USAGE,
        message: "心跳间隔必须是正数毫秒，收到 " + heartbeatMs,
      };
    }
    if (heartbeatMs < HEARTBEAT_FLOOR_MS) {
      return {
        ok: false,
        code: EXIT_USAGE,
        message:
          "心跳间隔不能小于 " +
          HEARTBEAT_FLOOR_MS +
          "ms（一分钟），收到 " +
          heartbeatMs +
          "ms。理由见 config.ts 的 HEARTBEAT_FLOOR_MS。",
      };
    }
    if (heartbeatMs > DEFAULT_STALL_THRESHOLD_MS) {
      // 警告而不是错误：心跳比阈值慢时，停滞【仍然会被发现】，只是最坏等一个 tick。
      // 把它做成硬失败会禁掉「一天一醒」这种合法的低功耗配法。
      io.warn(
        "心跳间隔 " +
          heartbeatMs +
          "ms 大于停滞阈值 " +
          DEFAULT_STALL_THRESHOLD_MS +
          "ms ⇒ 停滞仍然会被发现，只是最坏要等一个心跳。不是错误，是粒度变粗。",
      );
    }

    /**
     * 备份的执行点。默认 createBackupOffLoop（生产走这条），可注入的理由见 BootOverrides
     * 那一栏。取到手【在 job 外面】：与 0025 §3 第 ② 条同一条纪律 ——
     * job 里面不许出现【为了拿到一个函数而跨 await】的写法。
     */
    const backupVia =
      o.backupVia ??
      ((req: BackupOffLoopRequest): Promise<BackupOffLoopOutcome> =>
        createBackupOffLoop(req));

    const backupDir = args.backupDir;
    if (backupDir === undefined && args.noBackup !== true) {
      // 这一句必须说。规格 §6.5 把每日备份当默认要求，而这里没配目录 ⇒
      // 实际行为是【不做自动备份】。安静地不做，等于让「没有灾难恢复」
      // 这件事只在出事那天才知道。--no-backup 是显式决定，所以不再重复提醒。
      io.warn(
        "没有配置 --backup-dir ⇒ 本进程【不做自动备份】。" +
          "现在这个库里的一切只存在于这一个文件上（规格 §6.5 要的是每日 VACUUM INTO）。",
      );
    }

    /**
     * 章程泵的执行点与那一轮要用的设置。两者都取在【job 外面】，
     * 与 backupVia 同一条纪律（0025 §3 第 ② 条：job 里不许为了【拿到一个函数】而跨 await）。
     *
     * ⭐ 类型是 `Omit<PumpOptions, "nowMs">` 而【不是】PumpOptions，这一行就是判据本身：
     * 时刻【不属于】启动时算好的那份设置。写成 PumpOptions 的话就得给它填一个值
     * （类型必填），而那个值【每一轮都被覆盖掉】—— 一个"看着有内容而永远不被读"的字段，
     * 下一次重构把它当成缺省值读走的那天，症状是【所有轮的 created_at 都等于启动时刻】：
     * 审计里那些失败轮看起来全部同时发生，"这是第几次"从此读不出来，
     * 而那个数字正是重试上限的判据本身（charter-pump.ts 文件头那条依赖）。
     * 与 0036 §4 那条「备份文件名时刻必须与相位判据同源」同族而形状不同：
     * 那边是【两个来源取值不同】，这边是【一个来源取值太早】。
     * 用类型把时刻排除掉，比写一句注释"记得覆盖"便宜，也不会在重构时失效。
     */
    const pumpVia =
      o.charterPumpVia ??
      ((w: HubWriter, bus2: EventBus, po: PumpOptions): Promise<PumpRoundResult> =>
        pumpCharterCards(w, bus2, po));
    const pumpSettings: Omit<PumpOptions, "nowMs"> | null =
      bounds.ok === true
        ? {
            maxBudgetUsd: bounds.bounds.maxBudgetUsd,
            taskLimitCents: bounds.bounds.taskLimitCents,
            cwd: bounds.bounds.cwd,
            ...(o.pumpCardDeps === undefined ? {} : { cardDeps: o.pumpCardDeps }),
            ...(o.pumpRecordTurn === undefined ? {} : { recordTurn: o.pumpRecordTurn }),
            ...(o.pumpMaxAttempts === undefined ? {} : { maxAttempts: o.pumpMaxAttempts }),
            ...(o.pumpTaskLimit === undefined ? {} : { taskLimit: o.pumpTaskLimit }),
          }
        : null;

    /**
     * 驱动器（0048）的执行点与那一轮的设置，与上面 pumpVia / pumpSettings 同一对形状，
     * 包括那条 `Omit<…, "nowMs">` —— 时刻不属于启动时算好的设置，理由写在上面那段
     * （写成必填就得给一个值，而那个值每轮被覆盖；下一次重构把它当缺省读走的那天，
     * 审计里所有认领行的 created_at 会等于启动时刻，而"这是第几次"正是尝试上限的判据）。
     *
     * ⚠ 三格上限【从同一份 bounds 取】，与章程泵共用。这不是偷懒而是那三格的语义：
     * 「一轮给多少美元 / 一条任务给多少美分 / 角色能看见哪些文件」在一台 Hub 上
     * 只能有一个答案，两个泵各要一份会得到"同一个子进程被两套上限管着"。
     */
    const driverVia =
      o.driverPumpVia ??
      ((w: HubWriter, bus2: EventBus, dopt: DriveOptions): Promise<DriveRoundResult> =>
        driveTasks(w, bus2, dopt));
    const driverSettings: Omit<DriveOptions, "nowMs"> | null =
      driverOn && bounds.ok === true
        ? {
            maxBudgetUsd: bounds.bounds.maxBudgetUsd,
            taskLimitCents: bounds.bounds.taskLimitCents,
            cwd: bounds.bounds.cwd,
            ...(o.driveTask === undefined ? {} : { driveTask: o.driveTask }),
            ...(o.driverMaxAttempts === undefined ? {} : { maxAttempts: o.driverMaxAttempts }),
            ...(o.driverTaskLimit === undefined ? {} : { taskLimit: o.driverTaskLimit }),
            ...(args.ceo === undefined ? {} : { ceoRoleId: args.ceo }),
          }
        : null;
    if (driverSettings !== null) {
      // 关机那句报的数字换成【这一趟真用的那两个】。
      driverWait = {
        taskLimit: driverSettings.taskLimit ?? DEFAULT_DRIVER_TASK_LIMIT,
        maxTurns: driverSettings.maxTurns ?? DEFAULT_DRIVER_MAX_TURNS,
      };
    }

    /**
     * ⭐ 备份那一段的形状（0036 §3，替掉了原来那段「整段同步、一个 await 都不许有」）。
     *
     * 原来那段的前提是「`createBackup` 是同步的 ⇒ 同步的东西没有缝」。
     * 那句话当时是对的，而它换来的代价是一个实测数字：11.5MB 的库把主循环停 91ms
     * （0036 §0）。本篇把备份挪进 worker，于是【前提没了】，而挂在它下面的两样东西
     * —— 「不需要守卫」「不需要 cancelling 状态」—— 不会因前提变了而变红。
     * 所以两样都补回来了，各自配一发能红的用例（0036 §5 的 P-A / P-B / P-C）。
     *
     * 不变的那一条是【范围收窄了】：原来要求「判定 → 落地」整段不跨 await，
     * 现在只能要求【判定 → 派发】那一段不跨 await（派发之后本来就得跨，
     * 因为备份的意义就是不在这儿等它）。「备完之后报一声」跨 await 是安全的
     * （备份已经落地，没有东西可被插进来），这区别写在 0036 §7，
     * 是为了别让下一个人把它当成同一格删掉。
     *
     * ⚠ 判定与派发之间仍然【一个 await 都不许有】：跨一个上去，
     * 「判该备」与「开始备」之间就能插进一次关机（0025 §3 第 ④ 条本体）。
     * 这一条由 assemble.test.ts 那条结构性守卫钉着（它跟着改了区间，不是被删掉）。
     */
    const job = async (): Promise<void> => {
      const q = queue;
      if (q === null) throw new Error("心跳在队列关闭之后仍在跑（不该发生）");
      // 巡检与备份【不互相牵连】：两者都是「心跳顺便做的事」，
      // 一次备份的 IO 失败不该让停滞检测这一轮整个不算。
      const r = await runPatrol(q.readConnection(), q, bus, {
        ...(o.now === undefined ? {} : { now: o.now }),
      });
      if (r.stalled > 0) {
        io.warn("巡检：本轮新增停滞 " + r.stalled + " 个任务");
      }
      /**
       * ── 章程泵（0044）：这一发【必须】在 `if (backupDir === undefined) return` 之前 ──
       * 位置不是排版。放在那句之后，会让【没配 --backup-dir 的那台】（本机唯一在跑的
       * 形状）永远不补卡，而命令行上 --charter-pump 明明白白写着，启动横幅也说了"已开"。
       * 那正是本仓抓过多次的「配置写了而没生效」，而且它的症状与"从没打算开泵"一模一样
       * （收件箱一直是空的）。判据由 assemble.test.ts 那条「没配备份目录而泵照开」判。
       *
       * ⚠ 这一段【没有 await】，而那是本篇最容易被"顺手改对"改坏的一处：
       * 一轮起草的上限是 claude.ts:85 那个 SIGKILL（180s），心跳下界 HEARTBEAT_FLOOR_MS
       * 是 60s。把它 await 在这里 ⇒ 一轮起草跨过心跳节奏 ⇒ ticker 走
       * timer.ts:335 那条「上一轮心跳还没结束，本轮【跳过】」⇒
       * 【停滞检测与每日备份被一次起草停掉】，而且不计入 consecutiveFailures、
       * 不会触发 onFatal、不会退进程 —— 一个完全静默的形状。
       * 所以这里走【派发】，与备份同一条路：pumpWatch 挡并发与关机后的新活，
       * giveUp 里 settle 等它落地（否则一次起草会写进一个已经关掉的队列）。
       */
      if (pumpSettings !== null) {
        const dispatchedPump = pumpWatch.start(async (): Promise<void> => {
          try {
            // 每轮自己的 nowMs —— 见上面 pumpSettings 那段那条（审计时刻不能钉在启动那一刻）。
            const pr = await pumpVia(q, bus, {
              ...pumpSettings,
              nowMs: (o.now ?? scheduler.now)(),
            });
            reportPumpRound(pr, io, pumpBudgetWarned);
          } catch (e) {
            // 与备份那一处同一条理由：watch.start() 为了让 settle() 永不 reject
            // 会【吞掉 rejection】。这里不接住，"泵一整轮抛了"就真的没人说。
            // 注意这与 pumpCharterCards 内部那条「逐张卡不牵连」是两层不同的东西：
            // 里面那层挡的是"一张卡起草不动"，这一层挡的是"候选 SQL 都跑不了"。
            io.warn(
              "章程泵【本轮没有结论】（一整轮抛错，原文如下）——" +
                "这与「某一张卡起草失败」不同，后者由泵自己记进审计：\n" +
                (e instanceof Error ? e.message : String(e)),
            );
          }
        });
        if (!dispatchedPump.started && dispatchedPump.reason === "in_flight") {
          // 只有 in_flight 要说。cancelling 保持安静，理由与备份那一处同一条：
          // 关机路径上已经说过话了，而这一支最多发生一次。
          io.warn(
            "本轮跳过章程起草：上一轮起草还在飞。" +
              "一轮起草的上限是 180 秒而心跳下界是 60 秒，所以这【可能只是慢】；" +
              "但它每轮都出现时，说明泵实际上【补不出几张卡】—— 那要看审计，不是看这里。",
          );
        }
      }
      /**
       * ── 驱动器（0048）：与章程泵同一侧、同一条派发纪律 ──
       *
       * 位置在那句 `if (backupDir === undefined) return` 【之前】，理由与章程泵同一条
       * 而更硬：没配备份目录是【本机唯一在跑的形状】，驱动器挂在那句之后就是
       * 「命令行写了而永远不生效」，症状与"从没打算开"逐字相同（任务一步不动）。
       *
       * ⚠ 这一段【不 await】，而这里比章程泵更不容 await：章程泵一轮的上限是
       * 一次 SIGKILL（180 秒），驱动器一轮的上限是 taskLimit × maxTurns × 180 秒
       * （默认 3 × 12 × 180s ≈ 1 小时 48 分）。await 在这里 ⇒ 一次驱动把
       * 【停滞检测与每日备份停掉近两个小时】，而且心跳 skip 不计 consecutiveFailures、
       * 不触发 onFatal、不退进程 —— 一个完全静默的形状（timer.ts:335）。
       * 所以走派发，giveUp 里 settle 等它落地。
       */
      if (driverSettings !== null) {
        const dispatchedDrive = driverWatch.start(async (): Promise<void> => {
          try {
            // 每轮自己的 nowMs —— 见上面 driverSettings 那段那条（认领行的时刻不能钉在启动那一刻，
            // 而"这是第几次"那个计数读的就是这些行的先后）。
            const dr = await driverVia(q, bus, {
              ...driverSettings,
              nowMs: (o.now ?? scheduler.now)(),
            });
            reportDriveRound(dr, io, driverBudgetWarned);
          } catch (e) {
            // watch.start() 为了让 settle() 永不 reject 会【吞掉 rejection】，这里不接住
            // 就真没人说。与章程泵那一处一样是【两层】：driveTasks 内部挡"一条任务推不动"，
            // 这一层挡"候选 SQL 都跑不了"。后者更坏 —— 它意味着驱动器【一条都没推】
            // 而终端上一片安静，那与"库里没有可推的任务"在屏幕上无法区分。
            io.warn(
              "驱动器【本轮没有结论】（一整轮抛错，原文如下）——" +
                "这与「某一条任务推不动」不同，后者由驱动器自己记进审计：\n" +
                (e instanceof Error ? e.message : String(e)),
            );
          }
        });
        if (!dispatchedDrive.started && dispatchedDrive.reason === "in_flight") {
          io.warn(
            "本轮跳过推任务：上一轮驱动还在飞。" +
              "一轮驱动【设计上就能跑到】" +
              worstDriveWaitMs(driverWait) +
              "（" +
              driverWait.taskLimit +
              " 条 × 每条 " +
              driverWait.maxTurns +
              " 格），所以这【可能只是慢】；" +
              "但它【每轮都】出现时，说明有一格卡在子进程里出不来 —— 那要去看审计，不是看这里。",
          );
        }
      }
      if (backupDir === undefined) return;
      /**
       * ⭐ 这里【原来】还有一句 `if (cleaned) return`（旧写法），本篇把它删了，
       * 而删的理由本身就是本篇的一条结论：
       * 我先是照旧写了一句「关机中就不派新活」，然后去做 P-B 那发变异
       * （删掉这道门，期望「关机之后不再开始备份」那发红）—— 它【没红】。
       * 因为 backupWatch.start() 里面还有【同一道门】，行为一字不差。
       * 也就是说我「补回来的守卫」是一句【拆掉不红】的话，而那正是 0025 §3 第 ③ 条
       * 给「测试全绿的失效」下的定义。
       * ⇒ 门只留一处（在 start 里面，它同时是状态的唯一来源），
       *   而调用方【读被拒的原因】并把该说的那句话说出来。
       *   「cancelling 真的在挡东西」于是变成一条能红的用例（断言的是原因，不是文件数）。
       */
      // ⚠ lastBackupAtMs / shouldBackUp 都是【同步】函数，这里保持同步
      // （0025 §3 第 ② 条：把它写成 async 只是因为签名，就在判定与执行之间开了缝）。
      if (!shouldBackUp(lastBackupAtMs(backupDir), scheduler.now())) return;
      /**
       * ⭐ 传给 worker 的是【时刻】而不是【时钟】，而这一行是本篇最容易写错的一格。
       *
       * 相位判据上面用的是 `scheduler.now()`（测试里是假时钟），而备份文件名里的时刻
       * 必须与它【同源】。不同源会怎样（本篇改完之后 assemble.test.ts 真红过一次）：
       * 注入 2026-03-10 而 worker 用自己的墙钟 2026-11-10 命名 ⇒
       * `shouldBackUp(2026-11-10, 2026-03-10)` 天天判「该备」⇒
       * **每轮心跳重备一份**，把 7 份保留位被同一天挤满，把上周那份真备份挤掉。
       * 所以这里取的是与相位判据同一个时钟源：注入的 now（有则优先）／scheduler.now。
       *
       * 为什么不是 `Date.now()`：生产上这两者与 scheduler.now 是同一个系统时钟，
       * 取值一样；差别只在【注入存在的时候】—— 而那正是测试与回放的那一侧。
       */
      const atMs = (o.now ?? scheduler.now)();
      const dispatched: StartOutcome = backupWatch.start(async (): Promise<void> => {
        try {
          const out = await backupVia({
            dbPath,
            backupDir,
            nowMs: atMs,
            ...(o.backupTimeoutMs === undefined ? {} : { timeoutMs: o.backupTimeoutMs }),
          });
          reportBackupOutcome(out, io);
        } catch (e) {
          // ⚠ 这一发 catch【必须在这里】而不是交给 watch：
          // watch.start() 为了让 settle() 永不 reject 会【吞掉 rejection】（那是它的职责），
          // 于是如果这里不接，「worker 里抛了」这件事就真的静默了 ——
          // 而静默的备份失败正是 Task 6.3 明令禁止的那一条。
          // 包成 { rejected } 而不是就地写一句 warn，是为了让【四种 + reject】这五种
          // 结论的文案住在同一个函数里（reportBackupOutcome），不分散在两个 catch 里各写一半。
          reportBackupOutcome({ rejected: e }, io);
        }
      });
      if (!dispatched.started) {
        // 两个拒因【分开处置】，而且这个分开本身是判据（把两支合成一句 warn，
        // 「关机中被拒」与「上一份还在飞」就分不开了 —— 后者要人看，前者不用）。
        if (dispatched.reason === "in_flight") {
          // 【说出来】而不是静默跳过：静默跳过正是 0025 反复定义的最贵那类失效
          // —— 备份没做成、日志一片干净、下一次出事才知道。
          io.warn(
            "本轮跳过备份：上一份还在飞。同一天里不该出现（每日一份），出现了说明" +
              "备份比心跳间隔还慢 —— 那是库大到该担心的信号。",
          );
        }
        // cancelling ⇒ 保持安静。理由不是「反正没人看」：
        // 关机这件事在 shutdown 那条路径上已经说过话了，而 ticker 已 stop，
        // 这一支最多数码上会发生一次（唯一那发【已经挂在半路】的轮次走到这里）。
        // 在那儿加一句「因为关机所以没备」只会让人以为出了新事，
        // 而真正该问的问题在【下一次启动】：那天到底备过没有（lastBackupAtMs 答）。
      }
    };

    heartbeat = createTicker({
      intervalMs: heartbeatMs,
      job,
      scheduler,
      onError: (m): void => io.warn("心跳：" + m),
      onFatal: (m, n): void => {
        io.warn(
          "心跳已连续失败 " +
            n +
            " 次 ⇒ 本轮之后【不再安排下一轮】。错误原文：" +
            m +
            "\n→ 停滞检测现在【不再运行】，而 HTTP 仍在服务。" +
            "这是一个要人来处理的形状：重启 Hub，或者把错误修掉。",
        );
        o.onHeartbeatFatal?.();
      },
    });

    // 启动时立即一轮，不等第一个 tick。理由不是「让人快点看到结果」：
    // 进程刚起来的头几分钟恰恰最容易留停滞（上一次多半是被 kill -9 掉的），
    // 等 15 分钟才报，等于把【最有信息量的那一轮】错过。
    void heartbeat.tick().catch((e: unknown) => {
      io.warn(
        "启动首轮巡检抛错（心跳仍在跑）：" +
          (e instanceof Error ? e.message : String(e)),
      );
    });

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await giveUp();
    };

    succeeded = true;
    return {
      ok: true,
      port: server.port,
      token,
      bindHost: bind.host,
      exposure: bind.exposure,
      lockPath: lock.path,
      heartbeat,
      ...(args.portFile === undefined ? {} : { portFile: args.portFile }),
      shutdown,
    };
  } catch (e) {
    // 兜底：上面任何一条【没被就地处理】的抛错都到这里。
    // 资源清理由下面那个 finally 统一负责（这里不再手写一遍，两份清理会漂移）。
    return {
      ok: false,
      code: EXIT_PROBLEM,
      message: "启动失败：" + (e instanceof Error ? e.message : String(e)),
    };
  } finally {
    // ⭐ 这一发是本次修的那处缺陷本体：没有它，上面每一条【就地 return】的失败
    // 都不还锁。就地 return 的有四条（库打不开、迁移失败、完整性未过、HTTP 起不来、
    // 心跳参数不合法），比抛出来的那条多得多。
    // 成功时 giveUp 不会被叫（succeeded=true，清理归 shutdown），
    // 而 finally 在 return 之后同步执行，所以判据必须是这个 flag 而不是 try 的返回值。
    if (!succeeded) await giveUp();
  }
}

/**
 * 备份结论的【唯一】出口。
 *
 * ⚠ 四种形状一条都不许漏（0036 §7）：ran:true 里还分 ok / 不 ok，ran:false 里分
 * 三类 worker 失效，外加一条【reject】。为什么 reject 要单独算一种：
 * `createBackupOffLoop` 对「createBackup 自己抛了（keep 非法那一种）」是 reject，
 * 而 `backupWatch.start()` 为了让 settle() 永不 reject 会把 rejection 吞掉
 * （吞掉是【对的】—— 清理路径不该被一份备份的失败打断），
 * 于是【这一层必须接住它】，否则它就真的静默了。
 * 「watch 吞掉 rejection」这件事不是缺陷，但它把「谁负责说这句话」搬到了这里；
 * 读 start() 的实现而没读到这里的人会以为没人说。
 *
 * ⚠ 三档语气各不相同，而且【不该统一】：
 *  · ok ⇒ log（每天一条，是正常事件）
 *  · createBackup 判失败 ⇒ warn（环境没坏，是备份这一步坏了）
 *  · worker 没给出结论 ⇒ warn，但文案必须说清「【没拿到结论】不等于【备份失败】」
 *    —— 那三种失效里有一份备份可能【已经落盘了】（worker 备完之后死在回话之前），
 *    把它报成「备份失败」会让人去手动补一份，而真正该做的是看一眼目录。
 */
function reportBackupOutcome(
  out: BackupOffLoopOutcome | { readonly rejected: unknown },
  io: ServeIo,
): void {
  if ("rejected" in out) {
    const e = out.rejected;
    const warnings = e instanceof BackupWorkerThrewError ? e.warnings : [];
    io.warn(
      "备份【没有得出结论】：worker 里抛错 —— " +
        (e instanceof Error ? e.message : String(e)) +
        "\n→ 这不是「备份失败」，是「不知道有没有成」。先看 " +
        "备份目录里最新那份的时刻，再决定要不要重备。" +
        warnSuffix(warnings),
    );
    return;
  }
  if (!out.ran) {
    io.warn(
      "备份【没有得出结论】（" +
        out.failure +
        "）：" +
        out.message +
        "\n→ 与「备份失败」不同：这里连结论都没拿到，" +
        "目录里可能已经有一份落地的备份。今天这一格按【没备过】算 ⇒ 下一轮心跳会再试一次。" +
        warnSuffix(out.warnings),
    );
    return;
  }
  for (const w of out.warnings) io.warn("备份告警：" + w);
  const b = out.result;
  if (b.ok) {
    io.log(
      "备份完成：" +
        b.path +
        "（" +
        b.bytes +
        " 字节，events " +
        b.eventsInBackup +
        " 行，worker " +
        out.workerMs +
        "ms / 含冷启动 " +
        out.totalMs +
        "ms）",
    );
  } else {
    io.warn("备份失败（" + b.reason + "）：" + b.message);
  }
}

/** worker 里攒下的告警。一条都不许丢：Task 6.3 那条「备份静默失败等于没有备份」的验收。 */
function warnSuffix(warnings: readonly string[]): string {
  return warnings.length === 0
    ? ""
    : "\n→ worker 里还告过 " +
        warnings.length +
        " 条：" +
        warnings.map((w) => w.slice(0, 200)).join(" / ");
}

/** pumpBoundsOf 的结论。三种而不是 boolean + 可选值 —— 见下面那条理由。 */
export type PumpBounds =
  | { readonly ok: true; readonly bounds: Pick<PumpOptions, "maxBudgetUsd" | "taskLimitCents" | "cwd"> }
  /** 开关没开。与下面那一种是【两件事】，合成一种就没法决定该不该退 2。 */
  | { readonly ok: false; readonly reason: "not_pumped" }
  | { readonly ok: false; readonly reason: "invalid"; readonly bad: readonly string[] };

/**
 * 「泵开着 ⇒ 三格上限必须成立」这条判据的本体（纯函数，不碰 fs、不起库）。
 *
 * ── 为什么单独一个导出函数 ───────────────────────────────────────────
 * 与 bindForAssembly 同一条理由（那个函数上面整段写了）：判据内联在 boot 里时，
 * 【致命那一支可能没有活的分母】，于是"这条主张被测试过"无法兑现。
 * 抽出来之后「泵开着而 --max-budget-usd 缺失 ⇒ 拒」这一发是一行断言。
 *
 * ── 为什么这里是【第二道】同样的判据（config.ts 里已经有一份）──────────
 * 因为 boot 是公开 API —— Electron 主进程直接构造 args，不经过 parseServeArgs。
 * 这条重复是本文件既定的立场（heartbeatMs 那两发校验上面就有同一句「重复是刻意的」）。
 * 而这一格重复的代价不对称得最厉害：漏判一支不是报错难看，是
 * `maxBudgetUsd: undefined` 一路传到 makeRuntime，那一轮的 --max-budget-usd
 * 【根本不带这个参数】—— 于是那条"必填的上限"存在的全部意义（一轮有上限）
 * 在【唯一会花钱的那条路径】上消失了，而启动日志里写着"已开"。
 *
 * 两份判据之间会漂吗？会，而且方向是这一份【更严或等价】：本函数只要求
 * 「有限数 / 整数 / 非空目录」，config.ts 额外管 argv 拼写。漂的时候红在
 * test/serve/assemble.test.ts 那组直接喂 args 的用例上，不红在真命令行上 ——
 * 那正是【该红的那一侧】（会绕过 argv 的那条路）。
 *
 * ── 为什么返回三种而不是 boolean + 三个可选字段 ────────────────────────
 * 「没开泵」与「开了而配置坏」在装配层是【两个不同的处置】：前者照常启动、
 * 后者退 2。合成 `Pick<ServeArgs,...> | null` 之后两者都是 null，
 * 调用方就得自己再判一次 args.charterPump —— 那又回到两个来源判同一件事。
 *
 * ⚠ 这里【不】校验目录存在：那是 fs，而本函数要保持纯（同 config.ts 那条分界）。
 * 存在性由 boot 那一句 warn 负责，判致命与否的理由写在那一处。
 */
export function pumpBoundsOf(args: ServeArgs): PumpBounds {
  if (args.charterPump !== true && args.driverPump !== true) return { ok: false, reason: "not_pumped" };
  const bad: string[] = [];
  if (typeof args.maxBudgetUsd !== "number" || !Number.isFinite(args.maxBudgetUsd) || args.maxBudgetUsd < 0) {
    bad.push("--max-budget-usd（一轮的美元硬顶，实到 " + String(args.maxBudgetUsd) + "）");
  }
  if (
    typeof args.taskLimitCents !== "number" ||
    !Number.isInteger(args.taskLimitCents) ||
    args.taskLimitCents < 0
  ) {
    bad.push("--task-limit-cents（单条任务的预算上限，实到 " + String(args.taskLimitCents) + "）");
  }
  if (typeof args.agentCwd !== "string" || args.agentCwd.trim() === "") {
    bad.push("--agent-cwd（角色能读到哪些文件，实到 " + String(args.agentCwd) + "）");
  }
  if (bad.length > 0) return { ok: false, reason: "invalid", bad };
  // 上面三发【每一发都往 bad 里推】，所以走到这里三格必然都在。
  // 这里用感叹号而不是再判一遍 undefined：再判一遍就是【第三个】来源
  // （前两份判据在 config.ts 与本函数开头），而"编译器已经知道而代码不信"的
  // 那种重复会让读的人以为这里还有内容。
  return {
    ok: true,
    bounds: {
      maxBudgetUsd: args.maxBudgetUsd!,
      taskLimitCents: args.taskLimitCents!,
      cwd: args.agentCwd!,
    },
  };
}

/** bounds 里【成立那一支】的形状，给 boundsLine 当参数类型用。 */
type PumpBoundsOk = Extract<PumpBounds, { readonly ok: true }>;

/**
 * 启动横幅上「这三格现在是多少」那一句。
 *
 * ── 为什么是一个函数而不是两条横幅里各写一遍 ─────────────────────────
 * 0048 之前只有一条横幅（章程泵那条），那三个数是就地拼的。加驱动器时第二条
 * 也要说同样三个数（那两个泵【共用】这三格，理由在 config.ts 的 ServeArgs.driverPump），
 * 于是就地拼会得到两处字符串拼装。它漂移的时候没有任何东西会红：
 * 屏幕上两行写着不同的上限，而底下真正生效的是 bounds 里那一份 ——
 * 那与本文件反复拒绝的「注释里抄一份数字」是同一件事，只是这次抄在【人读的那一屏】上。
 *
 * ⚠ 这里【不】列驱动器的按格尝试上限（maxAttempts）与每任务轮数（maxTurns）：
 * 那两格没有 CLI 入口，只能由装配注入（BootOverrides.driverMaxAttempts，测试用的），
 * 而横幅上写一个「这台机器实际用的值」比写一个缺省常量更危险 ——
 * 常量漂了没人红，值漂了会让人觉得审计在骗他。驱动器那条横幅因此只说「试到上限就停并说出来」，
 * 具体次数在审计行的 payload 里（attempt / max_attempts），那儿是【逐条记录】而不是复述。
 */
function boundsLine(bounds: PumpBoundsOk): string {
  const b = bounds.bounds;
  return (
    "  · 一轮美元硬顶 " +
    b.maxBudgetUsd +
    " 美元　· 单条任务预算上限 " +
    b.taskLimitCents +
    " 美分\n" +
    "  · 角色能读到的目录（--agent-cwd）" +
    b.cwd +
    "\n"
  );
}

/**
 * 一趟泵的结论怎么说给人听（与 reportBackupOutcome 同一职责的泵版本）。
 *
 * ── 为什么必须【逐张卡】说而不是只报一个总数 ──────────────────────────
 * 泵是【自动】花钱的那一方。自动花钱的进程只报"本轮处理了 3 条"，
 * 读的人无法回答他真正要回答的问题：【花的钱换回了什么】。
 * 三种结论各有一句：
 *  · drafted   ⇒ 收件箱里多了一张卡（这是这条链唯一的"成功"）
 *  · attempted ⇒ 试了而没成，下一轮还会试（要看得见，否则它等于"什么都没发生"）
 *  · gave_up   ⇒ 【CEO 必须知道而系统不会自己解决】的那一种：一个想法停在那儿，
 *                没人起草，泵也不打算再试了。这一句必须响，不能只在库里。
 *  · skipped   ⇒ 没试，零花费。【不打扰人】—— 它是常态（别人已经建了卡、组织图挡着），
 *                每次启动都打的一句会被训练成噪音，而 gave_up 那句就没人看了。
 *
 * ⚠ 一条都不 return、一条都不抛。这是【报告】不是【判定】：
 * 判定在 pumpCharterCards 里已经做完了，咽掉一条结论的代价是那一格变成静默，
 * 而静默是本仓反复定义的最贵那类失效（0016 §1）。
 */
function reportPumpRound(r: PumpRoundResult, io: ServeIo, budgetWarned: Set<string>): void {
  // ⚠ 这一段【必须在下面那句 cards.length === 0 早退之前】：
  // 一条被门挡住的想法【按定义就不在 cards 里】（它是被候选 SQL 筛掉的，没被看过），
  // 所以"本轮一条卡都没动 ⇒ 什么都不说"那句一旦先跑，被挡住的这批就永远报不出来 ——
  // 而这正是这一格存在的全部理由。（我自己先写错过一次：把 blocked 的循环加在
  // 那个 return 后面，测试当场红，红得恰到好处。）
  for (const b of r.blocked) {
    if (budgetWarned.has(b.taskId)) continue;
    budgetWarned.add(b.taskId);
    io.warn(
      "⭐ 章程泵【没有】为「" +
        b.title +
        "」（" +
        b.taskId +
        "）起草章程提案：这条任务已花 " +
        b.consumedCents +
        " 美分，而 --task-limit-cents 说它最多花这么多。\n" +
        "→ 这【不是】起草失败（那种下一轮还会试），而是【花钱的门关着】，" +
        "而它会一直关到那条任务的额度动过为止。\n" +
        "→ 这句话对每条任务【只说一次】（泵每轮都会遇到它，重复说等于没说）。" +
        "要接着走：追加预算，或把那条想法撤掉。",
    );
  }
  if (r.cards.length === 0) return; // 无事可做那一轮不打扰（大多数轮次是这一支）
  const drafted = r.cards.filter((c) => c.outcome === "drafted");
  const attempted = r.cards.filter((c) => c.outcome === "attempted");
  const gaveUp = r.cards.filter((c) => c.outcome === "gave_up");
  const skipped = r.cards.filter((c) => c.outcome === "skipped").length;
  if (drafted.length > 0) {
    io.log(
      "章程泵：本轮起草出 " +
        drafted.length +
        " 张卡，在 CEO 收件箱里等批。花费 " +
        r.costCents +
        " 美分。",
    );
  }
  for (const c of drafted) io.log("  · " + c.taskId + "：" + c.note);
  for (const c of attempted) {
    io.warn("章程泵：一条任务的起草没成（下一轮还会试）" + c.taskId + "：" + c.note);
  }
  for (const c of gaveUp) {
    io.warn(
      "⭐ 章程泵【不再试】" +
        c.taskId +
        "：" +
        c.note +
        "\n→ 这一格【系统不会自己解决】：那条想法仍停在「等章程」而收件箱里没有它。" +
        "要么人工看一眼，要么把那条想法撤掉。",
    );
  }
  // 执行日志少一行 ⇒ 事后【看不清花了多少】，而不是"这件事没成"。
  // 单独说一句是因为它容易被当成失败：recordTurn 返回 recorded:false 是一种结论，
  // 而这条结论的内容通常是"这套装配没提供写入方"（测试注入），不是库坏了。
  for (const t of r.turns) {
    if (!t.recorded) io.warn("章程泵：这一轮没记进执行日志 " + t.taskId + "：" + t.why);
  }
  if (skipped > 0 && attempted.length === 0 && gaveUp.length === 0 && drafted.length === 0) {
    // 整轮全是 skipped ⇒ 一条都不说会读成"泵没跑"；说一句总数而不逐条列。
    io.log("章程泵：本轮 " + skipped + " 条候选都没起子进程（已有卡 / 状态不对 / 组织图挡着）。");
  }
}

/**
 * 一趟驱动的结论怎么说给人听（reportPumpRound 的驱动器版）。
 *
 * ── 三条判据，各自都不是排版 ──────────────────────────────────────
 * ① blocked 【在早退之前】：与 reportPumpRound 里那条同一条（被花钱的门筛掉的任务
 *    按定义不在 driven 里，"本轮什么都没推 ⇒ 什么都不说"会让它永远报不出来）。
 * ② gave_up 【要响，而且要说成「当场」而不是「唯一」】。driver-pump.ts 文件头那条
 *    相互作用量过两遍，第一遍读错了：认领行确实会把巡检的 `last_real_event_at`
 *    一直拨着（PATROL_SQL 读「任何带 payload.kind 的行」），但那只在【还在试的那几轮】成立；
 *    放弃之后驱动器不再留行，实测巡检约一个阈值（默认 30 分钟）之后会自己报这一格。
 *    所以这一句仍然必须 io.warn，理由换成三条站得住的：它是【当场】的信号（巡检那句晚约
 *    半小时）、它【不依赖心跳还活着】、它说得出【成因】（"驱动器试到上限，而认领行自己
 *    把计时器拨着"），而巡检那句只是"停滞 N 个任务"一个计数。
 *    ⚠ 原来这里写的是「停滞巡检永远不会报这一格」—— 那是读了一遍 SQL 就下的结论，
 *    跑一遍就推翻了。写错的方向不是小事：它会让人以为巡检坏了并去改巡检。
 * ③ human_seat 要说一句总数。这是驱动器存在的意义（CEO 批完之后不需要有人敲命令），
 *    而它成功的样子恰好是"任务不动了"—— 不说这一句，它等于一件没发生的事。
 *
 * skipped 那一支在这里【没有对应物】：driveTasks 的候选 SQL 已经把
 * 「不是 agent 席位」「试到上限」「钱到顶」全筛掉，进候选就必须推。
 *
 * ⚠ 一条都不 return、一条都不抛：判定在 driveTasks 里已经做完，这里只是【报告】。
 */
function reportDriveRound(r: DriveRoundResult, io: ServeIo, budgetWarned: Set<string>): void {
  for (const b of r.blocked) {
    if (budgetWarned.has(b.taskId)) continue;
    budgetWarned.add(b.taskId);
    io.warn(
      "⭐ 驱动器【没有】推「" +
        b.title +
        "」（" +
        b.taskId +
        "）：这条任务已花 " +
        b.consumedCents +
        " 美分，而 --task-limit-cents 说它最多花这么多。\n" +
        "→ 这【不是】推不动（那种下一轮还会试，直到试到上限），而是【花钱的门关着】。" +
        "任务【仍停在原来那一格】而不会自动升到 CEO 面前 —— 0041 §7 量过那一格没有写入方。\n" +
        "→ 这句话对每条任务【只说一次】。要接着走：追加预算，或者人工把那一格挪一格。",
    );
  }
  if (r.driven.length === 0) return; // 无事可做那一轮不打扰（大多数轮次是这一支）
  const driven = r.driven.filter((d) => d.outcome === "driven");
  const threw = r.driven.filter((d) => d.outcome === "threw");
  const gaveUp = r.driven.filter((d) => d.outcome === "gave_up");
  if (driven.length > 0) {
    io.log(
      "驱动器：本轮推了 " +
        driven.length +
        " 条任务，共 " +
        driven.reduce((a, d) => a + d.turns, 0) +
        " 格，花费 " +
        r.costCents +
        " 美分。",
    );
    for (const d of driven) {
      // 停在人席的那些单独数一句：那才是「该 CEO 出现」的信号。
      io.log("  · " + d.taskId + "（" + d.state + "/" + d.role + "）" + d.note);
    }
    const atHuman = driven.filter((d) => d.stopped === "human_seat").length;
    if (atHuman > 0) {
      io.log(
        "→ 其中 " +
          atHuman +
          " 条停在【人类席位】（等章程 / 等你裁决 / 等终审）：那几张卡在你手上等点击，" +
          "驱动器不会替你点。",
      );
    }
  }
  for (const d of threw) {
    io.warn("驱动器：一条任务推不动（下一轮还会试，直到试到上限）" + d.taskId + "：" + d.note);
  }
  for (const d of gaveUp) {
    io.warn(
      "⭐ 驱动器【不再推】" +
        d.taskId +
        "：" +
        d.note +
        "\n→ 这一格现在【没有人推它】：没有 agent 在动，收件箱里也没有因为它而建的卡。\n" +
        "→ 停滞巡检大约一个阈值之后【会】报它，但那是半小时后的一句计数，而这一句是当场说的，" +
        "并且说的是【驱动器自己放弃了】这件事本身。\n" +
        "→ 要么人工看一眼，要么把那条想法撤掉。",
    );
  }
}

/**
 * 最近一次成功备份的时刻（毫秒），没有则 null。
 *
 * 读的是【文件名里的时间戳】而不是 mtime：mtime 会被 cp / rsync / 网盘同步改掉，
 * 而这些工具恰恰是单用户机器上「备份目录被动过」的最常见来源。
 * backup.ts 的保留策略早就为同一件事选了文件名字典序而不是 mtime（见它的
 * backupName 注释），这里必须跟它同一个判据 —— 两处用两个来源，
 * 就会出现「保留策略认为有 7 份而相位判断认为一份都没有」。
 */
export function lastBackupAtMs(backupDir: string): number | null {
  const names = listBackups(backupDir);
  const last = names[names.length - 1];
  if (last === undefined) return null;
  // listBackups 给的是全路径，而 backupNameToMs 收的是名字（它是文件名格式的反函数）。
  return backupNameToMs(basename(last));
}

/**
 * Ctrl-C 那句「停止顺序」（runServeCli 里那一行的来源）。
 *
 * ── 为什么抽成纯函数（与 serveBannerOf 同一条理由）────────────────────
 * 那一行原本内联在 runServeCli 里，而 runServeCli 走到那里之后挂在
 * waitForShutdown 上等信号 —— 测试里要走到那一行只能给自己发一发 SIGINT，
 * 那一发会同时被同进程里其它用例留下的监听收到（waitForShutdown 注册后不注销）。
 * 结果就是这句话的【两个分支在本机一次也没被执行过】，而它的两个分支分别承诺
 * 两种不同的等待时长。抽出来之后两个分支都有分母，不需要真起进程、不需要发信号。
 *
 * ── 0048 起它【必须按开关取措辞】，而这一处值得单独记 ──────────────────
 * 原来那句写死了「等在飞的章程起草」与「最坏等 180 秒」。加了驱动器之后那句话
 * 有两半会坏：① 顺序里少了驱动那一格（真的会等，而屏幕上没说）；
 * ②「最坏 180 秒」在驱动器开着时【偏小一个数量级】。第二半不是文案问题：
 * 这一句存在的唯一理由是「别让人以为进程卡死而去 kill -9」，而一个偏小的等待承诺
 * 恰恰会在超时那一刻促成 kill -9 —— 那句话变成了它自己要防的那件事的引线。
 * 所以驱动开着时这里【不给具体秒数】，只指回上面那条驱动器横幅（那条是从真实配置算的，
 * 两处各算一遍就会有两个答案，而漂移的时候没有任何东西会红）。
 *
 * ⚠ 这里读的是 args 上的【开关】而不是装配层的 driverOn —— 后者还要 bounds 成立，
 * 而 bounds 不成立时进程根本起不来（退 2），走不到这一行。
 */
export function shutdownOrderLine(a: ServeArgs): string {
  return (
    "Ctrl-C 停止。停止顺序：停心跳 → 等备份 → 等在飞的章程起草" +
    (a.driverPump === true ? " / 在飞的驱动轮" : "") +
    " → 关服务 → 关队列 → 还锁。\n" +
    (a.driverPump === true
      ? "  · 泵都没开时这几步【什么都不等】。章程起草在飞最坏等 180 秒；" +
        "驱动轮在飞的最坏等待时间【上面那条驱动器横幅里写着】（它按实际配置算，这里不重算一份）。\n" +
        "  · 【不要 kill -9】：等只是慢，kill -9 会留下没关的连接与没提交的事务。"
      : "  （泵没开时第三步【什么都不等】。开着而真有一轮在起草时最坏等 180 秒，见上面那句提醒。）")
  );
}

/**
 * 默认图工厂：【不装图】，并在被叫到时响亮地失败。
 *
 * 这是本篇最重要的一处决定，我一度写错了它，所以整段写清。
 *
 * ── 第一版写的是「照 cli.ts 的 withHub 装一套真图」，那是错的 ──────────
 * 装的那一套需要 `new SuperStepAuditor({ db: queue.writeConnection() })`，
 * 而 HTTP 侧的写入走 `queue.node()` —— 那是【同一条连接上的两个提交点】。
 * real-deps.ts 文件头量的正是这个形状（P1/P2/P4）：同连接两次事务 ⇒
 * "cannot start a transaction within a transaction"，卡片停在 pending。
 * 也就是说那一版会把一个【已知会炸的形状】装进唯一的常驻进程，
 * 而它在离线机器上一次也跑不了（缺 @langchain），所以【测试也不会红】。
 * 「看起来接上了、跑起来必炸、测试全绿」是本仓定义为最贵的那一类交付。
 *
 * ── 为什么不在这里修它 ─────────────────────────────────────────────
 * 修法要动的是【超步事务的持锁范围】（0003 那条决策），不是本文件。
 * 0010 已经把 P2/P4 带着数字挂给 CEO 了；我在这里改不动它，也不该顺手改
 * （超步事务横跨节点执行是刻意的：节点体里就是模型调用）。
 *
 * ── 所以现在的行为，以及它为什么是可以用的 ──────────────────────────
 * 图恢复不可用，其余一切可用：任务能建、卡片能批、审计能落、看板能读、
 * 心跳与备份照跑。批准之后的行为是 real-deps.ts 早就写明的那条补救路径：
 * 决策【已提交】(200)，图恢复失败沿 promise 冒到 500 + 原文，
 * 人读那句报错再去 `hub resume --task <id>` 续跑。
 * 换句话说这不是「功能坏了」，是「恢复这一步要人喊一声」，而报错会这么教。
 *
 * ⚠ 这一格【有】专门一条用例（assemble.test.ts 的「默认图工厂必须响亮」那组）：
 * 一个静默返回空 TaskGraph 的写法看起来更像「已经接好了」，而它会让
 * 「批准后图没动」在日志里一个字都不出现。
 */
export const GRAPH_NOT_WIRED = "graph_not_wired";

/**
 * 那句「现在能做什么」里的命令。
 *
 * ⚠ 为什么这里要带 `--db`：`hub resume` 的库路径有两个来源 —— `--db`，或环境变量
 * `OPC_DB`（cli.ts 的用法原文就是这么写的）；**两个都没有**时退出码 2，
 * 而且【不去 cwd 建库】（0006 §4，有专门用例钉着「绝不编一个默认库路径」）。
 * 所以 `hub resume --task <id>` 不是【必挂】，是【要看环境】：设了 OPC_DB 才对，
 * 没设就拿到一句「缺 --db」。
 * 而我第一版印的正是那条【要看环境】的写法 —— 一句话的存在理由如果是
 * 「图不会自动跑，人要自己喊一声」，那它就该在【任何】机器上都能被照抄，
 * 而不是只在配了某个环境变量的机器上。人照抄、拿到「缺 --db」，
 * 会把【图没接】这件事误诊成【我命令打错了】—— 本篇 §3 那一族换了个现场而已。
 *
 * 所以：知道库路径就印**能直接跑**的那一条（boot 那一侧知道），
 * 不知道就印 `--db <库路径>` 这个**明显要填的占位**，
 * 而不是印一条看起来完整、实际必挂的命令。
 */
export function resumeCommand(taskId: string, dbPath?: string): string {
  const db = dbPath === undefined || dbPath === "" ? "<库路径>" : dbPath;
  return "hub resume --db " + db + " --task " + taskId;
}

export function graphNotWiredMessage(taskId: string, dbPath?: string): string {
  return (
    "这个 Hub 入口【没有】接上图运行时（" + GRAPH_NOT_WIRED + "），task_id = " + taskId + "。\n" +
    "为什么没接：图与 HTTP 决策两条写路径要落在【同一条】SQLite 连接的【两个】提交点上，" +
    "而同一连接上的两次事务会互斥（实测见 0010 §3 的 P1/P2/P4）。" +
    "修法属超步事务的持锁范围（0003），已挂 0010 等 CEO，不在本入口绕。\n" +
    "现在能做什么：这条任务的【决策已经落库】（卡片是批准的），" +
    "跑 `" + resumeCommand(taskId, dbPath) + "` 就接着往下走。"
  );
}

/**
 * 一个「被叫到就抛」的 TaskGraph 工厂。
 *
 * 抛的时机是【用到图的那一刻】而不是装配时：装配时抛会让 boot 整个失败，
 * 于是「看板打不开」，而真相只是「恢复这一步要人喊」。
 * 一个单用户产品的 Hub 应该继续服务，只在这一个动作上报错并教人怎么继续。
 *
 * `dbPath` 是可选项，只为了一句【能照抄】的补救命令（见 resumeCommand 那段）。
 * 刻意做成可选而不是必填：这个工厂也被测试直接调（assemble.test.ts 那几发不关心库），
 * 必填会让每一发调用方都被迫编一个库路径出来 —— 而编出来的路径会出现在
 * 那句报错里，读的人以为那是真的库。
 */
export function unavailableGraphFor(dbPath?: string): (taskId: string) => TaskGraph {
  return (taskId: string): TaskGraph => {
    const boom = async (): Promise<never> => {
      throw new Error(graphNotWiredMessage(taskId, dbPath));
    };
    return {
      // getState 也走同一条报错：返回一个「看起来是空状态」的对象会让
      // makeResumeGraph 的选路判成「没有中断」，于是它去 invoke(null)，
      // 那在已完成 thread 上【不重放节点】(0006 §1) —— 一个假的成功。
      graph: {
        getState: boom,
        invoke: boom,
      } as unknown as TaskGraph["graph"],
      invoke: boom,
    };
  };
}

/**
 * CLI 入口。信号处理与 token 横幅在这里，不在 boot 里：
 * boot 要能被测试直接调（测试里没有真进程信号），而退出码是【契约】（同 cli.ts 口径）。
 */
export async function runServeCli(
  argv: readonly string[],
  io: ServeIo,
  env: NodeJS.ProcessEnv = process.env,
  o: BootOverrides = {},
): Promise<{ code: number }> {
  const a = parseServeArgs(argv, env);
  if (a.help === true) {
    io.log(DEFAULT_SERVE_USAGE);
    return { code: EXIT_OK };
  }
  if (a.error !== undefined) {
    io.warn(a.error);
    io.warn(DEFAULT_SERVE_USAGE);
    return { code: EXIT_USAGE };
  }

  // 心跳彻底停掉 ⇒ 结束进程。
  // 不退的后果是「Hub 看起来在跑而停滞检测已经死了」，那是本仓反复定义为
  // 最贵的那一类失效（200 + 什么都不动）。
  //
  // 用局部闭包而不是模块级 hook：模块级的话，同一进程里起两个 Hub（测试里真的会）
  // 就互相覆盖，于是「A 的心跳坏了 ⇒ 把 B 停掉」。
  //
  // 还有一个窗口要堵：boot 已经起好 ticker，而 waitForShutdown 还没挂上 stop。
  // 这个窗口里 fatal 的话，requestStop 仍是 null ⇒ 那一发【静默丢掉】，
  // 于是又回到「Hub 在跑而心跳没了」——正是这一发要防的形状。所以另记一个 flag，
  // 由 waitForShutdown 在【挂上的那一刻】补判一次（见下面已 fatal 那个分支）。
  let requestStop: (() => void) | null = null;
  let fatalBeforeStop = false;
  const r = await boot(a, io, {
    ...o,
    onHeartbeatFatal: (): void => {
      if (requestStop === null) {
        fatalBeforeStop = true;
        return;
      }
      requestStop();
    },
  });
  if (!r.ok) {
    io.warn(r.message);
    if (r.hint !== undefined) io.warn("→ " + r.hint);
    return { code: r.code };
  }

  /*
   * 这一行的判据与它的来历在 serveBannerOf（下面）—— 抽出去之前它是内联在这里的，
   * 而内联的那一版是写死的 "Hub 已在 127.0.0.1:" + port。
   */
  io.log(serveBannerOf({ bindHost: r.bindHost, port: r.port, exposure: r.exposure }));
  io.log(
    "本机 token【只打印这一次】，不落库也不落盘（理由见 http/auth.ts 文件头）：\n  " +
      r.token,
  );
  if (r.portFile !== undefined) io.log("端口已写入 " + r.portFile);
  /**
   * 「停止顺序」那一句 —— 0048 起它【必须按开关取措辞】，而这一处值得单独记。
   *
   * 原来那句写死了「等在飞的章程起草」与「最坏等 180 秒」。加了驱动器之后那句话
   * 有两半会坏：① 顺序里少了驱动那一格（真的会等，而屏幕上没说）；
   * ②「最坏 180 秒」在驱动器开着时【偏小一个数量级】。第二半不是文案问题：
   * 这一句存在的唯一理由是「别让人以为进程卡死而去 kill -9」，而一个偏小的等待承诺
   * 恰恰会在超时那一刻促成 kill -9 —— 那句话变成了它自己要防的那件事的引线。
   * 所以驱动开着时这里【不给具体秒数】，只指回上面那条横幅（那条是从真实配置算的，
   * 两处各算一遍就会有两个答案，而漂移的时候没有任何东西会红）。
   */
  io.log(shutdownOrderLine(a));

  const code = await waitForShutdown(r, io, (stop) => {
    requestStop = stop;
    // 补判：窗口里坏掉的那一次。直接调即可 —— stop 闭包里的 resolve 在这一步
    // 已经建好（bind 是在 Promise 执行体末尾调的），不需要再推迟一个宏任务。
    if (fatalBeforeStop) stop();
  });
  return { code };
}

/**
 * 启动横幅那一行「Hub 已在 X:port 上服务（…）」。
 *
 * ── 为什么抽出来 ────────────────────────────────────────────────────
 * 它原本内联在 runServeCli 里，而成功那一支要【先打印、再挂进 waitForShutdown
 * 等一个真信号】才返回。测试里要走到那一行，只能给自己发一发 SIGINT ——
 * 那一发会同时被同进程里【其他用例留下的】信号监听收到
 * （waitForShutdown 注册了不注销），所以那不是「一次可控的注入」而是一次全局动作。
 * 结论不变：这一行在本机【一次也没被执行过】，「只绑回环」那五个字没人见过。
 * 抽成纯函数之后两个分支都有分母，不需要真起进程、不需要发信号。
 * ⚠ 别把这条理由读成「信号那条路测不了」：waitForShutdown 自己的清理语义
 *   仍然只由 boot/shutdown 那几发间接覆盖，那一格的本机覆盖度没有因为本次抽取而变好。
 *
 * ── 这一行曾经是【一句仍然会打印的假话】────────────────────────────
 * Task 4.1 之前它是 `"Hub 已在 127.0.0.1:" + r.port`，写死的。加 --bind 之后
 * 它【照常打印】，而服务其实对所有网卡开放。比崩溃贵得多的正是这种
 * 「功能坏了而输出照常」的形状 —— 尤其当它是唯一被读的那一行时。
 * 现在取值一律来自入参（= 真传给 listen 的那个 host 与那个 exposure），
 * 于是「只绑回环」这四个字【只在真的只绑回环时】才会出现。
 * 下面那条用例的反向对照钉的就是这一句。
 */
export function serveBannerOf(r: {
  readonly bindHost: string;
  readonly port: number;
  readonly exposure: "loopback" | "lan";
}): string {
  return (
    "Hub 已在 " +
    r.bindHost +
    ":" +
    r.port +
    " 上服务" +
    (r.exposure === "loopback"
      ? "（只绑回环，见 http/bind.ts）"
      : "（⚠ exposure=lan：同一网络内任何设备可达，凭据是一次性 token）")
  );
}

/**
 * 等信号，退出前【一定】走 shutdown。
 *
 * 为什么不能靠 Node 默认行为：默认 SIGINT 直接结束进程 ⇒ 锁文件留下 ⇒
 * 下一次启动被一颗自己刚留下的锁挡住（要等探活判陈旧，或 --force-unlock）。
 * 那是「正常关机把人整不会」的经典形状，而且它每次都会发生。
 *
 * 第二次信号【立即退出】，不等清理：清理会等备份，而一次卡死的备份不该让人
 * 对着一个杀不掉的进程。代价（锁可能没还）由下一次启动的陈旧锁判定接住，
 * 那条判定有专门一条用例。
 */
export async function waitForShutdown(
  r: Extract<BootResult, { ok: true }>,
  io: ServeIo,
  /** 把「请开始停止」这个动作交回调用方。runServeCli 用它接心跳停机。 */
  bind?: (stop: () => void) => void,
): Promise<number> {
  return await new Promise<number>((resolve) => {
    let second = false;
    const onSignal = (sig: string): void => {
      if (second) {
        io.warn(
          "第二次收到 " + sig + " ⇒ 立即退出（不等清理；锁将由下一次启动判为陈旧）",
        );
        resolve(EXIT_OK);
        return;
      }
      second = true;
      io.warn("收到 " + sig + "，正在优雅停止…");
      void r
        .shutdown()
        .then(() => resolve(EXIT_OK))
        .catch((e: unknown) => {
          io.warn(
            "停止过程抛错：" + (e instanceof Error ? e.message : String(e)),
          );
          resolve(EXIT_PROBLEM);
        });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    bind?.(() => onSignal("heartbeat_fatal"));
  });
}

/**
 * 入口块用的那一句：把 argv 跑成一次完整的 serve，并把退出码写进 process.exitCode。
 * 与 cli.ts 的 runCliOnStdio 同一条纪律：【只有这一处】写 exitCode。
 */
export async function serveMain(argv: readonly string[]): Promise<void> {
  const io: ServeIo = {
    log: (m): void => {
      process.stdout.write(m + "\n");
    },
    warn: (m): void => {
      process.stderr.write(m + "\n");
    },
  };
  process.exitCode = (await runServeCli(argv, io)).code;
}
