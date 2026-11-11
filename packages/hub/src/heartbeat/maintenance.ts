/**
 * 一次巡检维护（把 integrity / backup / drill / patrol 四块接上线的地方）。
 *
 * ── 为什么需要这个文件 ─────────────────────────────────────────────
 * 规格 §24 风险 8 与 §6.5 要的是「启动时执行 PRAGMA integrity_check，失败则提示从
 * 备份恢复」+「每日 VACUUM INTO 备份」。这三块模块（integrity.ts / backup.ts /
 * heartbeat/patrol.ts）此前【零生产调用方】：除测试外无人 import，
 * 也就是那条规格一行都没落地。本文件就是那一层接线。
 *
 * ⚠ 同一句话对 `backup.ts` 里的 `restoreDrill` 也成立过一次，而它在接上第一版之后
 * 【仍然成立】：那版接的是 `createBackup`，演练函数照旧零调用方。
 * 「文件接上了」与「这块能力接上了」不是一回事 —— 复算与代价见 0032 §0/§1。
 *
 * 为什么它是独立入口而不是塞进 cli.ts 的 hub run：
 *  cli.ts 顶层 import @langchain/langgraph（真图运行时，本机装不上，0009 §2），
 *  所以挂在那儿的东西本机一行都跑不了、也测不了。而完整性检查、备份、停滞巡检
 *  【一件都不需要图】—— 它们只需要一个库路径。分开成入口，
 *  于是「灾难恢复在位」这件事在本机就是可执行、可测的，而不是等依赖到位的许诺。
 *  形状照抄 db/migrate-cli.ts：参数解析纯函数 + runCli(io) + 退出码。
 *
 * ── 本文件唯一的实质决定：源库坏了就【不做】备份 ────────────────────
 * 顺序是 integrity → (仅当页面检查过关) backup+drill → patrol，理由是保留策略会放大事故：
 * pruneBackups 只留最近 7 份。一次已知损坏的备份写进去就成了【最新】那份，
 * 于是它把第七好的那份挤掉 —— 而 restoreDrill 之后验的是「最新那份可用」，
 * 那份恰恰是坏的。不备份的代价是「今天少一份备份」，备份的代价是
 * 「少一份好备份 + 一份看起来好的坏备份」。后者不可逆（被 prune 删掉的那份找不回）。
 *
 * 这一条【不替 CEO 拍 0018 §8】：那一节问的是「多久跑一次」，
 * 这里定的只是「既然要跑，先查还是先拷」+「拷完要不要真恢复一次」。
 */

import { existsSync, rmSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Writer } from "../db/write-queue.js";
import type { EventBus } from "../events/bus.js";
import {
  restoreDrill,
  type BackupResult,
  type DrillResult,
} from "../db/backup.js";
import {
  pageIntegrityBroken,
  runIntegrityScan,
  type IntegrityReport,
} from "../db/integrity.js";
import {
  runPatrol,
  type PatrolRunResult,
} from "./patrol.js";
import { isDirectRun } from "../internal/direct-run.js";

/** 退出码。0 = 一切正常；1 = 查出问题；2 = 用法/环境不对。与 migrate-cli.ts 同一套口径。 */
export const EXIT_OK = 0;
export const EXIT_PROBLEM = 1;
export const EXIT_USAGE = 2;

export interface MaintenanceArgs {
  readonly dbPath?: string | undefined;
  readonly backupDir?: string | undefined;
  readonly skipBackup?: boolean | undefined;
  readonly skipPatrol?: boolean | undefined;
  readonly help?: boolean | undefined;
  readonly error?: string | undefined;
}

export const MAINTENANCE_USAGE = [
  "用法：hub-maintenance --db <path> [--backup-dir <dir>] [--no-backup] [--no-patrol]",
  "      设置环境变量 OPC_DB / OPC_BACKUP_DIR 后可省略对应参数",
  "",
  "做四件事，按这个顺序：",
  "  1) 完整性检查（页面检查走 worker，不冻主线程）",
  "  2) VACUUM INTO 备份 + 保留最近 7 份 —— 【页面检查不过就跳过】，",
  "     否则一次损坏会挤掉一份好备份",
  "  3) 恢复演练 —— 把刚那份备份真恢复到 <备份目录>/drill-target.db，",
  "     验 integrity_check + 事件行数，然后删掉那份目标（失败则留着当现场）。",
  "     ⚠ --db 指的文件名不能正好叫 drill-target.db：那样演练目标会算成库本身，",
  "     真跑下去是先删现网库再覆盖它。这一格现在会被拦下来并退 1（0032 §2）。",
  "     （目录相同不要紧 —— 名字不同就不是同一个文件。）",
  "  4) 停滞巡检（孤儿活跃任务 → HeartbeatStalled 事件）",
  "",
  "退出码：0 全部正常 / 1 查出问题或任一环节失败（含演练失败）/ 2 用法不对。",
].join("\n");

/**
 * 解析。逻辑与退出码分开（同 migrate-cli.ts）：验收对象是退出码，
 * 而退出码必须由真子进程执行来验证 —— 「日志里看着报错了」不等于门禁生效（计划 V13）。
 */
export function parseMaintenanceArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): MaintenanceArgs {
  let dbPath: string | undefined;
  let backupDir: string | undefined;
  let skipBackup = false;
  let skipPatrol = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    const next = (): string | undefined => argv[++i];
    switch (a) {
      case "--help":
      case "-h":
        help = true;
        break;
      case "--db":
        dbPath = next();
        if (dbPath === undefined) return { error: "--db 后面要跟路径" };
        break;
      case "--backup-dir":
        backupDir = next();
        if (backupDir === undefined) return { error: "--backup-dir 后面要跟目录" };
        break;
      case "--no-backup":
        skipBackup = true;
        break;
      case "--no-patrol":
        skipPatrol = true;
        break;
      default:
        if (a.startsWith("--db=")) dbPath = a.slice(5);
        else if (a.startsWith("--backup-dir=")) backupDir = a.slice(13);
        else return { error: "未知参数 " + String(a) };
    }
  }

  if (help) return { help: true };
  // env 只做【缺省来源】，不覆盖显式参数。空白值不算设置了它（同 cli.ts 的 OPC_DB 口径）：
  // OPC_DB="  " 若被当成有效值，会在 cwd 旁边建出一个说不清路径的库。
  const envDb = env["OPC_DB"];
  if (dbPath === undefined && envDb !== undefined && envDb.trim() !== "") {
    dbPath = envDb;
  }
  const envBackup = env["OPC_BACKUP_DIR"];
  if (backupDir === undefined && envBackup !== undefined && envBackup.trim() !== "") {
    backupDir = envBackup;
  }

  if (dbPath === undefined || dbPath.trim() === "") {
    return { error: "缺 --db（或环境变量 OPC_DB）：刻意不猜默认库路径" };
  }
  if (skipBackup === false && backupDir === undefined) {
    return {
      error:
        "缺 --backup-dir（或环境变量 OPC_BACKUP_DIR）。要么给目录，要么显式写 " +
        "--no-backup 表示这次确实只检查不备份 —— 不给一个「默认不备份」的舒适形状。",
    };
  }
  return {
    dbPath: isAbsolute(dbPath) ? dbPath : resolve(dbPath),
    ...(backupDir === undefined ? {} : { backupDir: isAbsolute(backupDir) ? backupDir : resolve(backupDir) }),
    ...(skipBackup ? { skipBackup: true } : {}),
    ...(skipPatrol ? { skipPatrol: true } : {}),
  };
}

export type MaintenanceInput = {
  readonly dbPath: string;
  /**
   * 一条【只读】连接，完整性检查的自洽规则与停滞巡检都用它。
   * 一个字段而不是两个：两处都只读，给两个字段就是允许有人一处传写连接一处传读连接，
   * 于是「检查跑在写连接上」这种会卡写队列的形状可以静默发生。
   */
  readonly db: DatabaseSync;
  readonly writer: Writer;
  readonly bus: EventBus;
  readonly backupDir?: string | undefined;
  readonly skipBackup?: boolean;
  readonly skipPatrol?: boolean;
  /**
   * 完整性检查的超时上限覆盖。不传用 INTEGRITY_WORKER_TIMEOUT_MS。
   *
   * 与 assemble.ts 的 `integrityTimeoutMs` 同一条理由：注入的是【时机】不是【结论】。
   * 0038 那一格（检查没跑成 ⇒ 照备份 + 响一声 + 报告里【不】喊恢复）需要一个真的
   * `unavailable` 从 runIntegrityScan 出来；换成「测试塞一份假报告进来」就只剩
   * 「本函数读了那个字段」这一行被覆盖，而本篇的缺陷在【映射】那一步。
   * 没有同时开 CLI 旗：`--no-backup` / `--no-patrol` 是给运维的判断，
   * 而「把检查超时设成 0」在运维上等于「关掉启动闸门」，不该做成一个顺手能敲的命令。
   */
  readonly integrityTimeoutMs?: number;
  readonly now?: () => number;
  readonly onWarning: (message: string) => void;
};

export type MaintenanceResult = {
  /**
   * 四块全绿才 true（完整性 / 备份 / 演练 / 巡检）。任何一块【没跑成】也算 false —— 见 skipped 那一支。
   *
   * ⚠ 演练是 0032 加进来的第四块，而它**并进 ok 而不是另开一个旗标**，理由与
   * 0025 §8 那条「灾难恢复在位」的口径一致：备份成功 + 完整性过 + 演练可用，
   * **三条一起才算灾难恢复在位**。让 ok 只判前三条，会得到一个「门禁绿而恢复是假的」
   * 的形状 —— 那正是本文件接这三块时防的东西，只是换了个主体。
   */
  readonly ok: boolean;
  readonly integrity: IntegrityReport;
  readonly backup?: BackupResult | undefined;
  /** 备份被跳过的原因。有它才分得开「备份成功」与「根本没备份」。 */
  readonly backupSkipped?: string | undefined;
  /**
   * 本轮的恢复演练（备份 → 恢复到临时目标 → 验完整性）。没备份 ⇒ 没演练 ⇒ 缺这一格。
   *
   * ⚠ 「练了而练败」【不在别的字段里，就在这一格的 restore 里】—— 它有完整的失败原因，
   * 所以不需要再开一个「失败原因」字段。这一格缺席只有一种含义：这一轮没有可演练的备份。
   */
  readonly drill?: DrillResult | undefined;
  /**
   * 演练没跑成的原因，只在「没备份 ⇒ 所以没演练」时有值。
   *
   * 内容与 backupSkipped 同源，而【仍然单开一格】：不是为了换个说法，是为了 report()
   * 能无条件打印「演练：……」那一行而不用去反推备份那边的状态。一个只在成功时出现的
   * 输出行，与一个「没跑」也报出来的行，对运维是两种东西 ——
   * 前者看不出「今天压根没练」（同 patrol.ts 那条「看不见的失效」口径）。
   */
  readonly drillSkipped?: string | undefined;
  readonly patrol?: PatrolRunResult | undefined;
  readonly patrolSkipped?: string | undefined;
};

/** 演练产物在备份目录里的名字。⚠ 不许改成匹配备份名形状，理由在用它的那一处。 */
export const DRILL_TARGET_NAME = "drill-target.db";

/**
 * 删掉演练目标（含 sidecar）。
 *
 * 为什么单独一个函数而不是就地 rmSync：这一段有【必须成对】的三件事 ——
 * 主文件、-wal、-shm。0018 §1 第 3 条实测的就是「留着一个不属于这个库的 -wal，
 * 下一次恢复会静默采纳它」，所以删主文件而漏删 sidecar 比不删更糟：
 * 它把「上次演练的库」和「这次的 -wal」拼成一个**通过完整性检查而内容不是任何一份备份**的东西。
 * 那正是文件头第 3 条写的那类失效，而这里最容易犯的形式就是「只删 .db」。
 */
export function removeDrillTarget(path: string): void {
  for (const p of [path, path + "-wal", path + "-shm"]) {
    if (existsSync(p)) rmSync(p);
  }
}

/**
 * 跑一轮。四块都跑，各自把结论带回来 —— 【不抛】。
 *
 * 为什么不抛：这个入口是「启动时顺手跑一次」的东西。让它抛，
 * 调用方最省事的写法就是 try/catch 里 log 一句然后继续启动 Hub，
 * 于是「库坏了」在日志里降级成一行可忽略的噪音 —— 正是 §24 风险 8 要防的那件事。
 * 结论用返回值带出去，退出码由 runCli 那一层负责。
 *
 * ⚠ 「不抛」在这里有一处**必须靠 catch 兑现**，而不是靠「我保证不写 throw」：
 * restoreDrill 的同路径守卫是【抛 TypeError】的（它防的是接错线，见 backup.ts 那段），
 * 而它落在本函数的调用路径上。所以这一条契约是**接住它**接出来的 ——
 * 只捕 TypeError 那一类，其余上抛（一并吞掉会把真故障洗成一条备份告警）。
 * 换句话说下面那段注释不是「本函数不会抛」的**声明**，它是一次**实现**；
 * 有人删掉那个 catch，这句话立刻变成假话（maintenance.test.ts 有一发专打它）。
 */
export async function runMaintenance(
  o: MaintenanceInput,
): Promise<MaintenanceResult> {
  const integrity = await runIntegrityScan({
    dbPath: o.dbPath,
    db: o.db,
    writer: o.writer,
    ...(o.now === undefined ? {} : { now: o.now }),
    ...(o.integrityTimeoutMs === undefined
      ? {}
      : { timeoutMs: o.integrityTimeoutMs }),
  });

  // 三种「没备份」在退出码上必须分开（这一格是本轮写第二版时才补上的）：
  //   · 调用方显式 --no-backup  ⇒ 人的决定，不是问题 ⇒ 不拉低 ok
  //   · 页面检查不过 / 备份失败 ⇒ 真问题 ⇒ 拉低 ok
  // 第一版把两者都算失败，于是 `--no-backup` 那次「只想看一眼」的跑法每次都退 1，
  // 而它没错。一个恒真的告警等于没有告警 —— 同 patrol.ts 里告警疲劳那条理由。
  let backup: BackupResult | undefined;
  let backupSkipped: string | undefined;
  let backupProblem = false;
  /**
   * 本轮的恢复演练结论。【只有真的备份过才有这一格】——
   * 三个跳过分支（显式 --no-backup / 没有目录 / 页面检查不过）都拿不出备份，
   * 也就没有可演练的东西，此时它是 undefined 而不是「失败的演练」。
   * 把「没演练」与「演练失败」合成一个值，读的人会以为有过一次失败的演练。
   */
  let drill: DrillResult | undefined;
  let drillSkipped: string | undefined;
  let drillProblem = false;

  // 页面检查不过 ⇒ 不备份。理由见文件头那条「唯一的实质决定」。
  // 判据只看 page_integrity，不看整份报告的 ok（理由写在 pageIntegrityBroken 上：
  // not_observable 与 could_not_run 都不算损坏，用 ok 会把一大半正常巡检拦在门外）。
  //
  // ⚠ 0038：这一行原本是把 `pageIntegrityBroken` 的判据【就地再抄一遍】
  // （`page.verdict === "violated"`）。而 `pageIntegrityBroken` 的注释一直写着
  // 「它两行内联在 heartbeat/maintenance.ts 里……提出来」—— **抄一份不等于搬走一份**：
  // 0038 改 verdict 语义时，如果只改 integrity.ts，这里会安静地得到
  // 「instrument 故障 ⇒ 拦备份」而 Hub 那边得到「instrument 故障 ⇒ 照常启动」，
  // 两侧各自都自洽、各自都绿。那正是这段注释当初要防的事，而它防的方式（提出来）
  // 只完成了一半。现在这里调那个函数。
  const pageBroken = pageIntegrityBroken(integrity);
  /**
   * ⭐ 0038：`unavailable` 有值 = 「这次【没跑成】页面检查」，与「跑出来说坏了」是两件事。
   *
   * 这里选【照常备份】+ 响一声，而【不】像 pageBroken 那样跳过备份。三条理由：
   *  1. 少一份备份是【真损失】。保留策略只留最近 7 份，跳过一次就把可用备份往前推一天；
   *     而「没备份」和「备了一份坏的」对使用者的差别是：前者只是没保护，后者会挤掉好备份。
   *  2. 这条路已经有另一道闸：`createBackup` 对自己产出的那份文件跑 `integrity_check`，
   *     不过就 `rmSync` 并在【清理旧备份之前】早退（backup.ts 那一段）。
   *     实测：page 级损坏的源库连 `VACUUM INTO` 都过不去（当场抛
   *     "database disk image is malformed"）⇒ 「源坏了而产物全绿」这一格我造不出来。
   *     所以拦住这里的必要性比 pageBroken 那一支低一个档次。
   *  3. 「没跑成」最可能的原因是这台机器的 worker / 超时，而不是库 ——
   *     为一个仪器的毛病停掉数据保护，是给错的药。
   *
   * 但【必须响】：这一格以前一声不吭（src 下读 `report.unavailable` 的非注释代码 0 处），
   * 而它输出的那一行「完整性：通过」在 0038 之后仍然会打印成「未通过」（ok 被拉下了），
   * 光看那一行会以为「检查跑成了并报的问题」—— 那仍然是错的诊断方向。
   * 所以这里点名【检查没跑成】并指路修环境，且明说**别照 restore.md 走**。
   */
  if (integrity.unavailable !== undefined) {
    o.onWarning(
      "页面完整性检查【没有跑成】（" +
        integrity.unavailable +
        "）⇒ 本轮的「备份前源库是否健康」这一道【没有】被检查过。" +
        "\n  · 备份照做（产物自己还要过一道 integrity_check），但请修这台机器上的检查通路。" +
        "\n  · 【不要】照 scripts/restore.md 恢复：库并没有被证明坏了，" +
        "恢复会把一份可能完全健康的现网库覆盖掉。",
    );
  }
  if (o.skipBackup === true) {
    backupSkipped = "调用方显式 --no-backup";
    drillSkipped = backupSkipped;
  } else if (o.backupDir === undefined) {
    backupSkipped = "没有备份目录";
    drillSkipped = backupSkipped;
    backupProblem = true;
  } else if (pageBroken) {
    backupSkipped =
      "页面检查未通过 ⇒ 跳过备份。原因：保留策略只留最近 7 份，" +
      "一份已知损坏的备份会成为【最新】那份并挤掉一份好备份，" +
      "而 restoreDrill 之后验的正是最新那份可用。";
    drillSkipped = "页面检查未通过 ⇒ 没有备份，也就没有可演练的东西";
    backupProblem = true;
    o.onWarning(
      "备份被跳过：源库页面检查未通过。先按 scripts/restore.md 恢复，再让备份回来。",
    );
  } else {
    // ⚠ 这里是 restoreDrill 而不是 createBackup —— 也就是说【每一轮备份都顺带演练一次恢复】。
    // 0018 §8 我原先倾向的那一档（B：每天一次，与备份同批，并把 restoreDrill 的结论
    // 并进同一条巡检）到这里就是它。为什么值得多花那一点 IO：
    //  - 计划把恢复演练写成 Test 而不是文档，理由那句话在本仓只有一种兑现方式：
    //    【真跑】。「备份成功」证明能拷出去，「恢复成功」才证明拷回来还能用 ——
    //    而 backup.test.ts 那三发演练用例跑的是测试夹具，不是这个入口。
    //    接线之前，`restoreDrill` 在 src 里是【零生产调用方】（复算见 0032 §0），
    //    于是那条规格一行都没落地，正是本文件当初接 integrity/backup/patrol 三块时
    //    防的同一格（同 0013 §7 那一发「22 条用例、零生产调用方」）。
    //  - 一份从没验证过能恢复的备份，在真正出事的那一天，它的地位与「没有备份」只差一次
    //    人工尝试；而那次尝试发生在最不能失败的时刻。
    //  代价【重新量过】，而这次读到的与更早记在这里的那一对数字**不一样**（0032 §1）：
    //  20.4MB / 5 万事件的库，三轮分别 备份 350/352/357ms、恢复 504/507/509ms
    //  ⇒ 一轮多约 **1.43 倍**，不是我先前记在这里的那个「约 75%」。
    //  ⚠ 那对旧数字（102ms / 76ms）来自另一个夹具：13.7MB、payload 更短。
    //  差别不来自机器漂移，来自**夹具大小**：恢复那一侧多做的是
    //  「开只读连接 + integrity_check + 数事件行」，库小的时候这点活还没盖过备份本身，
    //  于是我当时得出「演练比备份还快、便宜得可以忽略」。
    //  ⇒ 所以这里留的是【量法 + 夹具形状】而不是一个百分比：
    //  百分比会随夹具与机器漂，而「库越大、恢复相对越慢」这个方向两次测量都成立，
    //  值得带走的正是那个方向（一条用来支撑决定的读数要连复算方式一起写，否则它会退化成权威数字）。
    //  ⚠ **它内部自己调 createBackup，所以这里【只有一份备份落地】** ——
    //  别在它外面再包一次 createBackup：那会把每轮变成两份，
    //  而 KEEP_BACKUPS=7 的语义会从「留 7 天」悄悄变成「留 3.5 天」。
    //  演练目标放在备份目录里、名字是 drill-target.db —— 它【不匹配】备份文件名的形状
    //  （`opc-…Z.db`），所以 pruneBackups / listBackups / lastBackupAtMs 都看不见它。
    //  这一条不是洁癖：如果它叫 opc-….db，一次演练就会产出一份「备份」，
    //  7 份保留位被演练挤掉，而演练那份与真备份【完全同权】—— 那是 0018 §1 第 3 条
    //  （一份看起来正常而含义不是那件事的文件）的又一个形状。有测试钉住名字形状。
    const drillTarget = join(o.backupDir, DRILL_TARGET_NAME);
    /**
     * 两种结局用【类型】分开，而不是给 `d` 加一个可选字段：
     * 可选字段会让下面读它的那段需要一个 `!`，而 `!` 正是「我没真判这一支」的写法 ——
     * 这一块防的就是「看起来跑了而其实没跑」，判据自己不该带这种缝。
     */
    type DrillOutcome = { readonly done: true; readonly drill: DrillResult } | { readonly done: false };
    let outcome: DrillOutcome;
    try {
      outcome = {
        done: true,
        drill: restoreDrill({
          dbPath: o.dbPath,
          backupDir: o.backupDir,
          drillTargetPath: drillTarget,
          onWarning: o.onWarning,
          ...(o.now === undefined ? {} : { now: o.now }),
        }),
      };
    } catch (e) {
      // ⚠ runMaintenance 的【不抛】契约到这里有一个真缺口，而它是接线 restoreDrill 时新开的：
      // 那个「演练目标不能就是源库」的守卫【抛 TypeError】（0032 §2），而它能在运行期发生
      // （触发条件见下面那句告警 —— 不是「目录指错」，是【库文件名正好叫演练目标那个名字】）。
      // 这里必须接住，理由与文件头那条一模一样：抛出去，调用方最省事的写法是
      // log 一句然后继续启动 Hub，于是「恢复目标写回现网库」变成一行可忽略的噪音。
      // 所以：接住 TypeError、报成人能照做的一句、拉低 ok。
      // ⚠ 【只】接 TypeError —— 其余异常照常上抛：一并吞掉会把真故障（磁盘满、权限）
      // 洗成一条「备份没跑成」，那是拿「不抛」这条契约去掩盖别的问题
      // （同 patrol.ts 只捕自己那一类失败、backup.ts 只捕 openSnapshotReadonlyDb 的写法）。
      if (!(e instanceof TypeError)) throw e;
      backupProblem = true;
      drillProblem = true;
      drillSkipped = "演练目标与源库是同一个文件 ⇒ 备份与恢复【整块没跑】：" + e.message;
      // ⚠ 报错要说的是【真正触发的条件】，而它【不是】「--backup-dir 指错了」。
      // 演练目标叫 drill-target.db，所以「目录指到库所在目录」并【不会】触发这一支 ——
      // 真正的触发条件是【库文件名本身就叫 drill-target.db】（名字相同 + 目录相同）。
      // 我第一版写的是「--backup-dir 指到了库所在的目录」，那是一句【听起来合理而不对症的报错】：
      // 读到它的人会去改 --backup-dir，而改了也没用，因为出问题的是 --db。
      // ⇒ 措辞改成先给等式（谁 = 谁），再点出唯一能凑出这个等式的来路。
      o.onWarning(
        "备份与演练整块没跑：演练目标算出来就是【库本身】（" + drillTarget + " = " + o.dbPath + "）。" +
          "→ 触发条件是【--db 指的那个文件名正好叫 " + DRILL_TARGET_NAME + "】，" +
          "最可能的来路是上一次演练失败留下的那个目标文件被当成了现网库（它躺在备份目录里，" +
          "名字像个库）。把 --db 指回真正的库。这里刻意不继续跑：真跑下去会先删掉它、" +
          "再用备份覆盖它、连带删掉它的 -wal，而那个函数原本会报「演练成功」。",
      );
      outcome = { done: false };
    }
    if (outcome.done) {
      const d = outcome.drill;
      backup = d.backup;
      drill = d;
      if (!d.backup.ok) {
        backupSkipped = "备份失败：" + d.backup.reason;
        drillSkipped = "备份这一步就失败了，没有可恢复的文件";
        backupProblem = true;
        o.onWarning("备份失败（" + d.backup.reason + "）：" + d.backup.message);
      } else if (!d.restore.ok) {
        // ⚠ 这一支与上面那一支【必须分开】，而且这一支更响：
        // 上面是「今天少一份备份」，这里是「备份目录里那份最新的【打不开 / 对不上账】」——
        // 前者明天就补上了，后者意味着【已有的那 7 份可能全都不可用】而看起来一切正常。
        // 报错里必须带上「备份已经落地」这一句，否则运维看到 ok=false 会去找备份失败的原因，
        // 而备份目录里明明躺着一份新的。
        backupProblem = true;
        drillProblem = true;
        o.onWarning(
          "备份已经落地（" + d.backup.path + "）而【恢复演练失败】：" + d.restore.message +
            " ⇒ 这份备份不能算灾难恢复，演练目标留在原地供排查：" + drillTarget,
        );
      } else {
        // 演练成功 ⇒ 把那份目标删掉。留着它的代价是【备份目录体积翻倍】
        // （它是一份完整的库拷贝），而它带来的唯一好处是「事后能再看一眼」——
        // 那一眼已经由上面的 integrity_check + events 行数比对给掉了。
        // 失败那一支反过来【留着】：出事时那个文件是唯一的现场。
        removeDrillTarget(drillTarget);
      }
    }
  }

  let patrol: PatrolRunResult | undefined;
  let patrolSkipped: string | undefined;
  let patrolProblem = false;
  if (o.skipPatrol === true) {
    patrolSkipped = "调用方显式 --no-patrol";
  } else {
    const p = await runPatrol(o.db, o.writer, o.bus, o.now === undefined ? {} : { now: o.now });
    patrol = p;
    if (p.stalled > 0) {
      patrolProblem = true;
      o.onWarning("发现 " + p.stalled + " 个停滞任务，已写 HeartbeatStalled。");
    }
    const failed = p.recorded.filter((r) => r.seq === null);
    if (failed.length > 0) {
      // 这一条必须单独报：Task 6.1 的验收是「不允许既无事件也无卡片」，
      // 而「检测到停滞却写不进去」正是那一格的失败态 —— 报出来之后
      // 下一轮巡检会【再报一次】（去重看的是心跳事件有没有写成功），
      // 所以这一格不会自愈，只会一直吵。这是对的。
      patrolProblem = true;
      o.onWarning(
        "有 " + failed.length + " 条停滞【写不进】审计：" +
          (failed[0]?.error ?? "原因未知"),
      );
    }
  }

  // 四块（完整性 / 备份 / 演练 / 巡检）全绿才 ok。drillProblem 目前只由
  // 「同路径」那一支置起来，而那一支同时置 backupProblem ——
  // 也就是它【今天】在 ok 上是冗余的。仍然写进来，理由与 0025 §8 那条一样：
  // 一条今天恒假的判据写在表达式里，与「恢复那块得算进 ok」这句话写在注释里，
  // 证据强度不同档；将来任何一支【只】让演练失败而不让备份失败的新形状
  // （例：备份目标盘满了而恢复读的是旧的一份）会在改那一支时自动生效。
  const ok = integrity.ok && !backupProblem && !drillProblem && !patrolProblem;
  return {
    ok,
    integrity,
    ...(backup === undefined ? {} : { backup }),
    ...(backupSkipped === undefined ? {} : { backupSkipped }),
    ...(drill === undefined ? {} : { drill }),
    ...(drillSkipped === undefined ? {} : { drillSkipped }),
    ...(patrol === undefined ? {} : { patrol }),
    ...(patrolSkipped === undefined ? {} : { patrolSkipped }),
  };
}

export interface CliIo {
  write(text: string): void;
  error(text: string): void;
}

export interface CliResult {
  readonly code: number;
}

/**
 * 装配 + 退出码。WriteQueue 在这里开，因为【退出码】要求真进程边界，
 * 而判定（runMaintenance）留给测试直接调 —— 两件事分开，
 * 于是「判定对不对」能在离线夹具里测，「进程边界对不对」由真子进程测（同 migrate-cli.ts）。
 */
export async function runMaintenanceCli(
  argv: readonly string[],
  io: CliIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const a = parseMaintenanceArgs(argv, env);
  if (a.help === true) {
    io.write(MAINTENANCE_USAGE);
    return { code: EXIT_OK };
  }
  if (a.error !== undefined) {
    io.error(a.error);
    io.error(MAINTENANCE_USAGE);
    return { code: EXIT_USAGE };
  }
  const dbPath = a.dbPath ?? "";
  // 不创建库。openDb 会建文件，而空库的完整性检查【全绿】——
  // 那是最坏的一种「检查通过」：它让一次库丢失看起来像一次健康巡检。
  if (!existsSync(dbPath)) {
    io.error("库文件不存在：" + dbPath + "（刻意不创建 —— 空库检查出来全绿，那是假绿）");
    return { code: EXIT_USAGE };
  }
  const { WriteQueue } = await import("../db/write-queue.js");
  const { InMemoryEventBus } = await import("../events/bus.js");

  // 【开连接这一步自己会抛】，而这一格的读者正处在最坏的时刻：库坏了。
  // 实测一份截断到 50% 的库，openDb 在 applyPragmas 上就抛
  // "database disk image is malformed" —— 连 PRAGMA 都还没跑到。
  // 不捕的话，这个入口在【唯一需要它说话的时候】交出去的是一段裸 SQLite 报错 +
  // 一段堆栈 + 非零退出码，而它本来要说的那句「先停 Hub、先改名留一份、
  // 然后按 scripts/restore.md 走」恰好是出事的人最需要看到的一句。
  // 退出码用 EXIT_PROBLEM（1）而不是 EXIT_USAGE（2）：命令没写错，是库的问题。
  let q: InstanceType<typeof WriteQueue>;
  try {
    q = new WriteQueue(dbPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    io.error("库打不开：" + msg);
    io.error("→ 这不是用法错误。库文件本身读不出来，恢复步骤见 scripts/restore.md" + "（先停 Hub，先把现网库改名留一份，再从备份恢复）。");
    return { code: EXIT_PROBLEM };
  }
  try {
    const r = await runMaintenance({
      dbPath,
      db: q.readConnection(),
      writer: q,
      bus: new InMemoryEventBus(),
      ...(a.backupDir === undefined ? {} : { backupDir: a.backupDir }),
      ...(a.skipBackup === true ? { skipBackup: true } : {}),
      ...(a.skipPatrol === true ? { skipPatrol: true } : {}),
      onWarning: (m) => io.error("告警：" + m),
    });
    report(r, io);
    return { code: r.ok ? EXIT_OK : EXIT_PROBLEM };
  } finally {
    await q.close();
  }
}

/**
 * 人可读的一段输出。机器读者读退出码与 events，不读这里的措辞。
 *
 * ⚠ 导出它**只为了**让测试能直接喂一份 runMaintenance 的真结果进来。
 * 走 CLI 测不到 0038 改的那两句指路文案：CLI 没有「把检查超时设成 0」那个旗
 * （刻意不加，见 MaintenanceInput.integrityTimeoutMs 上那段），
 * 于是 CLI 那条通路永远拿不到 unavailable。
 * 它本身是纯函数（只读入参 + 往 io 写），所以直接喂真结果比造一份假报告强，
 * 也比在 CLI 上开一个「关掉启动闸门」的旗强。
 */
export function report(r: MaintenanceResult, io: CliIo): void {
  const lines: string[] = [];
  lines.push("完整性：" + (r.integrity.ok ? "通过" : "未通过") + "（" + r.integrity.ms + "ms，" + r.integrity.via + "）");
  for (const c of r.integrity.checks) {
    if (c.verdict === "ok") continue;
    lines.push("  · " + c.name + " = " + c.verdict + "：" + c.detail.slice(0, 200));
  }
  if (r.backup !== undefined && r.backup.ok) {
    lines.push("备份：" + r.backup.path + "（" + r.backup.eventsInBackup + " 条事件，" + r.backup.bytes + " 字节）");
    if (r.backup.pruned.length > 0) lines.push("  · 清理旧备份 " + r.backup.pruned.length + " 份");
  } else if (r.backupSkipped !== undefined) {
    lines.push("备份：跳过 —— " + r.backupSkipped);
  }
  // ⚠ 演练这一行【无条件】出现（跑过 / 没跑成都有一行），不像「有结果才打印」那样写。
  // 一个只在成功时出现的输出行，与一行「没练」也报出来的行，对读日志的人是两种东西：
  // 前者看不出「今天压根没演练」，而那一格恰恰是本文件要防的那类【看不见的失效】。
  if (r.drill !== undefined) {
    if (r.drill.restore.ok) {
      lines.push(
        "恢复演练：通过 —— 恢复到临时目标、integrity_check 与事件行数都对得上（" +
          r.drill.restore.events + " 条事件）",
      );
    } else {
      lines.push("恢复演练：【失败】—— " + r.drill.restore.message);
    }
  } else if (r.drillSkipped !== undefined) {
    lines.push("恢复演练：没跑 —— " + r.drillSkipped);
  }
  if (r.patrol !== undefined) {
    lines.push("巡检：" + r.patrol.judgements.length + " 个任务，停滞 " + r.patrol.stalled + " 个");
  } else if (r.patrolSkipped !== undefined) {
    lines.push("巡检：跳过 —— " + r.patrolSkipped);
  }
  if (!r.integrity.ok) {
    lines.push("");
    // ⚠ 0038：这一句原本对【所有】!ok 都喊「库可能已损坏 → 照 restore.md 恢复」，
    // 而 !ok 里混着两种相反的东西（见 runMaintenance 那段）：
    //  · unavailable 有值 = 检查【没跑成】，库可能完全健康 —— 这一句会把人送去覆盖自己的库;
    //  · 检查跑成了而报了问题 = 才是真要去恢复的那种。
    // 「→ 库可能已损坏」对着一次 worker 超时喊，就是本篇要消灭的那个动作。
    if (r.integrity.unavailable !== undefined) {
      lines.push(
        "→ 完整性检查【没跑成】（" +
          r.integrity.unavailable +
          "），不代表库坏了。要修的是这台机器上的检查通路。" +
          "\n  【不要】照 scripts/restore.md 恢复 —— 那会覆盖一份可能完全健康的现网库。",
      );
    } else {
      lines.push("→ 库可能已损坏。恢复步骤见 scripts/restore.md（先停 Hub，先改名留一份现网库）。");
    }
  }
  io.write(lines.join("\n"));
}

/**
 * 仅当本文件被直接执行时跑（被 import 时不得有副作用 —— 否则测试里 import 这个模块
 * 就会开连接、写备份）。用的是 internal/direct-run.ts 那一份实现而不是本地再写一遍：
 * 这个谓词失效的方式是【静默】的（入口块不执行、进程什么都不干、退出码 0）。
 *
 * ⚠ 与计划根 scripts 表的一处偏离：那一行写的是
 *   backup: tsx packages/hub/src/db/backup.ts
 * 而 backup.ts【没有 CLI 入口】，那是刻意的 —— 它的一条门禁就是
 * 「除 node:* 与自身外零 import」，测试扫的是它的可执行 import（backup.test.ts ⑤）。
 * 给它加个入口去 openDb / WriteQueue，那条门禁当场作废。
 * 所以可执行面落在本文件：backup.ts 保持纯函数库，这里当那个「有人调用」的进程。
 */
if (isDirectRun(import.meta.url, process.argv[1])) {
  const io: CliIo = {
    write: (text) => {
      process.stdout.write(text + "\n");
    },
    error: (text) => {
      process.stderr.write(text + "\n");
    },
  };
  process.exitCode = (await runMaintenanceCli(process.argv.slice(2), io)).code;
}
