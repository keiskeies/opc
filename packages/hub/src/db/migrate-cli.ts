import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "./driver.js";
import { MIGRATIONS_DIR, migrate } from "./migrate.js";

/**
 * pnpm migrate 的入口（计划 Task 0.5 的 Run 行）。
 *
 * 【为什么不提供默认库路径】
 * 库文件位置属于应用配置（Electron 下是 userData 目录，命令行下是环境变量），
 * 而配置系统到 Task 1.x 才出现。在这里编一个默认值，就会留下一个
 * 「谁也没决定过、但代码里写着」的路径 —— 这类隐式默认的归宿从来都是
 * 「在别人的机器上写进了一个想不到的地方」。所以：没给路径就报错，把决定权
 * 留给调用方。这是本任务与计划的一处有意偏差，已写进计划变更记录。
 *
 * 逻辑抽成 runCli()（参数进、退出码出），是为了让「第二次是 no-op」这条验收
 * 能被【真子进程】执行来验证，而不只是在测试里调 migrate() 函数 —— 后者测不到
 * 参数有没有传对、连接关没关、第二次会不会崩在 "table already exists" 上。
 */

export interface CliIo {
  write(text: string): void;
  error(text: string): void;
}

export interface CliResult {
  code: number;
}

const USAGE = [
  "用法：pnpm migrate <path>",
  "      pnpm migrate -- --db <path>",
  "      设置环境变量 OPC_DB 后可直接执行 pnpm migrate",
  "",
  "说明：刻意不提供默认库路径 —— 库文件位置属于应用配置，配置系统尚未落地；",
  "      在此编一个默认值就是留下一个没人决定过的隐式路径。",
].join("\n");

/**
 * 解析命令行参数。
 *
 * 两个字段的类型都写成 T | undefined：本仓库开了 exactOptionalPropertyTypes，
 * 只写 db?: string 就不允许显式返回 { db: undefined } —— 而「解析成功但没有 db」
 * 正是 --help 的语义，必须能表达。
 */
export interface ParsedArgs {
  db?: string | undefined;
  error?: string | undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let db: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    // noUncheckedIndexedAccess：下标读出来是 string | undefined。越界不该发生
    // （循环条件是 i < length），但显式跳过比让它流进 startsWith 更诚实。
    const a: string | undefined = argv[i];
    if (a === undefined) continue;

    if (a === "--help" || a === "-h") return {};
    if (a === "--db") {
      const next: string | undefined = argv[++i];
      if (next === undefined || next === "")
        return { error: "--db 后面缺路径" };
      db = next;
      continue;
    }
    if (a.startsWith("--db=")) {
      db = a.slice("--db=".length);
      if (db === "") return { error: "--db= 后面缺路径" };
      continue;
    }
    if (a.startsWith("-")) return { error: "未知选项：" + a };
    if (db !== undefined)
      return { error: "给了两个库路径：" + db + " 与 " + a };
    db = a;
  }
  if (db === undefined) {
    const env = process.env["OPC_DB"];
    if (env !== undefined && env.trim() !== "") db = env.trim();
  }
  if (db === undefined) return { error: "未指定数据库路径" };
  // 相对路径绝对化：否则同一句命令在不同 cwd 下会迁到两个不同的库文件
  if (!isAbsolute(db)) db = resolve(db);
  return { db };
}

export function runCli(argv: readonly string[], io: CliIo): CliResult {
  const parsed = parseArgs(argv);
  if (parsed.error !== undefined) {
    io.error("错误：" + parsed.error + "\n\n" + USAGE + "\n");
    return { code: 2 };
  }
  const dbPath = parsed.db;
  if (dbPath === undefined) return { code: 0 }; // --help

  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb(dbPath);
  try {
    const res = migrate(db);
    if (res.applied.length > 0) {
      io.write("已应用迁移：" + res.applied.join(", ") + "\n");
    } else {
      // no-op 是每次启动都会走到的分支，输出要能让人确认「不是没跑，是不需要跑」
      io.write(
        "数据库已是最新（" + res.alreadyApplied.length + " 个迁移均已应用）\n",
      );
    }
    io.write("库文件：" + dbPath + "\n迁移目录：" + MIGRATIONS_DIR + "\n");
    return { code: 0 };
  } finally {
    db.close();
  }
}

/** 仅当本文件被直接执行时运行（被 import 时不得有副作用）。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const io: CliIo = {
    write: (text) => {
      process.stdout.write(text);
    },
    error: (text) => {
      process.stderr.write(text);
    },
  };
  process.exitCode = runCli(process.argv.slice(2), io).code;
}
