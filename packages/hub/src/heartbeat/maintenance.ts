/**
 * 一次巡检维护（把 integrity / backup / patrol 三块接上线的地方）。
 *
 * ── 为什么需要这个文件 ─────────────────────────────────────────────
 * 规格 §24 风险 8 与 §6.5 要的是「启动时执行 PRAGMA integrity_check，失败则提示从
 * 备份恢复」+「每日 VACUUM INTO 备份」。这三块模块（integrity.ts / backup.ts /
 * heartbeat/patrol.ts）此前【零生产调用方】：除测试外无人 import，
 * 也就是那条规格一行都没落地。本文件就是那一层接线。
 *
 * 为什么它是独立入口而不是塞进 cli.ts 的 hub run：
 *  cli.ts 顶层 import @langchain/langgraph（真图运行时，本机装不上，0009 §2），
 *  所以挂在那儿的东西本机一行都跑不了、也测不了。而完整性检查、备份、停滞巡检
 *  【一件都不需要图】—— 它们只需要一个库路径。分开成入口，
 *  于是「灾难恢复在位」这件事在本机就是可执行、可测的，而不是等依赖到位的许诺。
 *  形状照抄 db/migrate-cli.ts：参数解析纯函数 + runCli(io) + 退出码。
 *
 * ── 本文件唯一的实质决定：源库坏了就【不做】备份 ────────────────────
 * 顺序是 integrity → (仅当页面检查过关) backup → patrol，理由是保留策略会放大事故：
 * pruneBackups 只留最近 7 份。一次已知损坏的备份写进去就成了【最新】那份，
 * 于是它把第七好的那份挤掉 —— 而 restoreDrill 之后验的是「最新那份可用」，
 * 那份恰恰是坏的。不备份的代价是「今天少一份备份」，备份的代价是
 * 「少一份好备份 + 一份看起来好的坏备份」。后者不可逆（被 prune 删掉的那份找不回）。
 *
 * 这一条【不替 CEO 拍 0018 §8】：那一节问的是「多久跑一次」，
 * 这里定的只是「既然要跑，先查还是先拷」。
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Writer } from "../db/write-queue.js";
import type { EventBus } from "../events/bus.js";
import {
  createBackup,
  type BackupResult,
} from "../db/backup.js";
import {
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
  "做三件事，按这个顺序：",
  "  1) 完整性检查（页面检查走 worker，不冻主线程）",
  "  2) VACUUM INTO 备份 + 保留最近 7 份 —— 【页面检查不过就跳过】，",
  "     否则一次损坏会挤掉一份好备份",
  "  3) 停滞巡检（孤儿活跃任务 → HeartbeatStalled 事件）",
  "",
  "退出码：0 全部正常 / 1 查出问题或任一环节失败 / 2 用法不对。",
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
  readonly now?: () => number;
  readonly onWarning: (message: string) => void;
};

export type MaintenanceResult = {
  /** 三块全绿才 true。任何一块【没跑成】也算 false —— 见 skipped 那一支。 */
  readonly ok: boolean;
  readonly integrity: IntegrityReport;
  readonly backup?: BackupResult | undefined;
  /** 备份被跳过的原因。有它才分得开「备份成功」与「根本没备份」。 */
  readonly backupSkipped?: string | undefined;
  readonly patrol?: PatrolRunResult | undefined;
  readonly patrolSkipped?: string | undefined;
};

/**
 * 跑一轮。三块都跑，各自把结论带回来 —— 【不抛】。
 *
 * 为什么不抛：这个入口是「启动时顺手跑一次」的东西。让它抛，
 * 调用方最省事的写法就是 try/catch 里 log 一句然后继续启动 Hub，
 * 于是「库坏了」在日志里降级成一行可忽略的噪音 —— 正是 §24 风险 8 要防的那件事。
 * 结论用返回值带出去，退出码由 runCli 那一层负责。
 */
export async function runMaintenance(
  o: MaintenanceInput,
): Promise<MaintenanceResult> {
  const integrity = await runIntegrityScan({
    dbPath: o.dbPath,
    db: o.db,
    writer: o.writer,
    ...(o.now === undefined ? {} : { now: o.now }),
  });

  // 三种「没备份」在退出码上必须分开（这一格是本轮写第二版时才补上的）：
  //   · 调用方显式 --no-backup  ⇒ 人的决定，不是问题 ⇒ 不拉低 ok
  //   · 页面检查不过 / 备份失败 ⇒ 真问题 ⇒ 拉低 ok
  // 第一版把两者都算失败，于是 `--no-backup` 那次「只想看一眼」的跑法每次都退 1，
  // 而它没错。一个恒真的告警等于没有告警 —— 同 patrol.ts 里告警疲劳那条理由。
  let backup: BackupResult | undefined;
  let backupSkipped: string | undefined;
  let backupProblem = false;

  // 页面检查不过 ⇒ 不备份。理由见文件头那条「唯一的实质决定」。
  // 判据只看 page_integrity，不看整份报告的 ok：整份报告里 not_observable
  // 也拉不下 ok，但「没有门控决定可核」跟「文件坏了」是两件事，
  // 后者绝不该拦备份。
  const page = integrity.checks.find((c) => c.name === "page_integrity");
  const pageBroken = page !== undefined && page.verdict === "violated";
  if (o.skipBackup === true) {
    backupSkipped = "调用方显式 --no-backup";
  } else if (o.backupDir === undefined) {
    backupSkipped = "没有备份目录";
    backupProblem = true;
  } else if (pageBroken) {
    backupSkipped =
      "页面检查未通过 ⇒ 跳过备份。原因：保留策略只留最近 7 份，" +
      "一份已知损坏的备份会成为【最新】那份并挤掉一份好备份，" +
      "而 restoreDrill 之后验的正是最新那份可用。";
    backupProblem = true;
    o.onWarning(
      "备份被跳过：源库页面检查未通过。先按 scripts/restore.md 恢复，再让备份回来。",
    );
  } else {
    const b = createBackup({
      dbPath: o.dbPath,
      backupDir: o.backupDir,
      onWarning: o.onWarning,
      ...(o.now === undefined ? {} : { now: o.now }),
    });
    backup = b;
    if (!b.ok) {
      backupSkipped = "备份失败：" + b.reason;
      backupProblem = true;
      o.onWarning("备份失败（" + b.reason + "）：" + b.message);
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

  const ok = integrity.ok && !backupProblem && !patrolProblem;
  return {
    ok,
    integrity,
    ...(backup === undefined ? {} : { backup }),
    ...(backupSkipped === undefined ? {} : { backupSkipped }),
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

/** 人可读的一段输出。机器读者读退出码与 events，不读这里的措辞。 */
function report(r: MaintenanceResult, io: CliIo): void {
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
  if (r.patrol !== undefined) {
    lines.push("巡检：" + r.patrol.judgements.length + " 个任务，停滞 " + r.patrol.stalled + " 个");
  } else if (r.patrolSkipped !== undefined) {
    lines.push("巡检：跳过 —— " + r.patrolSkipped);
  }
  if (!r.integrity.ok) {
    lines.push("");
    lines.push("→ 库可能已损坏。恢复步骤见 scripts/restore.md（先停 Hub，先改名留一份现网库）。");
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
