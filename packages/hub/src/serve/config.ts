/**
 * `pnpm hub:serve` 的参数解析（纯函数，不碰 fs、不碰时钟）。
 *
 * ── 为什么单独一个文件 ────────────────────────────────────────────
 * 与 migrate-cli.ts / maintenance.ts 同一个形状：解析是纯的，装配与退出码在别处。
 * 这一层的判据（端口范围、心跳下限、缺参就退而不是猜）全部能在离线夹具里逐条钉住，
 * 而真监听、真定时器、真信号那一半只能由真进程验 —— 两者混在一个文件里时，
 * 能测的那一半会被不能测的那一半拖走（maintenance.ts 文件头记的就是同一件事）。
 *
 * ── 三个必填项各不猜默认值，理由不是同一条 ──────────────────────────
 * --db     不猜。与 cli.ts 纪律 1 同一条：库位置属应用配置，配置系统还没落地。
 * --port   不猜。这条【比 --db 更需要理由】：端口是【两侧】的约定 ——
 *          桌面壳的 signedFetch 要往同一个数字上发（desktop/src/main/channels.ts
 *          现在连端口字段都还没有）。在这里写死 8787，就会有两个数字：
 *          这一个与将来那个写进桌面壳的，而它们【不同时改】时症状是「Hub 在跑而
 *          界面说未运行」，一个谁都会归因错的形状。现在只有一个来源：env 或参数。
 * --backup-dir 不给就是「不自动备份」，但这必须是一句【显式】的话（--no-backup），
 *          理由照抄 maintenance.ts：不给一个「默认不备份」的舒适形状。
 *          备份是灾难恢复；一次静默不备份的代价在出事那天才付，而那天没有第二次机会。
 */

/**
 * 心跳的最小间隔：一分钟。
 *
 * 为什么要有下界而不是「调用方给多少跑多少」：心跳那一轮做的事是 `runPatrol` ——
 * 一条覆盖全表的 SQL（perf-thresholds.test.ts ② 量的就是它）。
 * 允许 `--heartbeat 1ms` 等于允许把写队列按毫秒节奏挤满只读扫描，
 * 而那正是 Task 6.4 那条验收（「心跳调度不得阻塞写队列」）要防的东西。
 * 一个手抖少打三个零的运维命令不该变成一次自我 DoS，而且报错应当出现在
 * 这条参数【被解析出来】的那一刻，不是巡检把机器拖死的那一刻。
 */
export const HEARTBEAT_FLOOR_MS = 60_000;

/**
 * 用法文本。写成【一个字符串】而不是字符串数组：数组要调用方自己 join，
 * 于是两个入口各 join 一次，其中一个忘了 join 时打印的是逗号连接的一整行 ——
 * 一个只在「用法被打出来」那一刻才看得见的错，而那一刻正是人最需要读懂它的时刻。
 */
export const DEFAULT_SERVE_USAGE: string = [
  // 命令名用 `pnpm hub:serve` 而不是 `hub-serve` 或 `hub serve`：前者的写法【抄了就能跑】，
  // 后两个都不能 —— `hub-serve` 不是任何可执行名，`hub serve` 会被 cli.ts 判成
  // 「未知子命令」退出 2（VERBS 只有 run / status / resume）。用法文本的读者是人照着敲的，
  // 一条不存在的命令比少写一行更糟（同 assemble.ts 的 resumeCommand 那段理由）。
  "用法：pnpm hub:serve --db <path> [--port <n> | --port-file <path>] [--backup-dir <dir>] [--heartbeat <ms>]",
  "      [--no-backup] [--help]",
  "      环境变量 OPC_DB / OPC_BACKUP_DIR / OPC_PORT / OPC_HEARTBEAT_MS 只做【缺省来源】，不覆盖显式参数。",
  "",
  "做四件事，按这个顺序：",
  "  1) 抢库文件旁边的写者锁（<db>.lock）。别的进程持着 ⇒ 【拒绝启动】，",
  "     否则两个「唯一写者」会交错写同一个库而不报错（规格 §5.1）",
  "  2) 打开 + 迁移 + 启动时的页面完整性检查（不过 ⇒ 拒绝启动并指路 scripts/restore.md）",
  "  3) 起 HTTP/SSE（只绑 127.0.0.1，见 http/server.ts）",
  "  4) 起心跳：启动后立即一趟巡检，之后每 --heartbeat 一趟；每趟顺便问一次「今天备过没有」",
  "",
  "退出码：0 正常退出 / 1 起不来或运行期出事 / 2 参数不对。",
].join("\n");

export interface ServeArgs {
  readonly dbPath?: string;
  readonly port?: number;
  readonly portFile?: string;
  readonly backupDir?: string;
  readonly heartbeatMs?: number;
  readonly noBackup?: boolean;
  readonly help?: boolean;
  readonly error?: string;
}

/** 端口合法区间。下界排除 0~1023：那是需要特权的端口段，本机单用户没理由占用它。 */
const PORT_MIN = 1024;
const PORT_MAX = 65_535;

function positiveInt(raw: string | undefined, name: string): number | { error: string } {
  if (raw === undefined) return { error: name + " 后面要跟一个值" };
  if (!/^\d+$/u.test(raw)) {
    return { error: name + " 必须是十进制整数，实到 " + raw };
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) {
    return { error: name + " 超出可安全表示的整数范围，实到 " + raw };
  }
  return n;
}

/** env 里「设了」的判据：非 undefined 且不是纯空白。空白不算设置（同 maintenance.ts）。 */
function fromEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

/**
 * 取下一个 token 当值。以 `--` 开头的 token 【不算值】。
 *
 * 这一格不是挑剔，是修一个具体的误诊：`hub-serve --db --port 8787`（少打一个路径）
 * 若按顺序吃，库路径就成了字符串 "--port"，一路走到 openDb，
 * 报错变成「库打不开：--port」—— 一次打字错误伪装成一个文件系统/权限问题，
 * 而修法（补上路径）与报错指向的方向（查磁盘）完全不同。
 * 允许负数不在这条里：本层收的 token 里没有任何一个允许负值。
 */
function takeValue(argv: readonly string[], i: number, name: string): string | { error: string } {
  const v = argv[i];
  if (v === undefined || v.startsWith("--")) {
    return { error: name + " 后面要跟一个值（不是另一个参数）" };
  }
  return v;
}

export function parseServeArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServeArgs {
  let dbPath: string | undefined;
  let port: number | undefined;
  let portFile: string | undefined;
  let backupDir: string | undefined;
  let heartbeatMs: number | undefined;
  let noBackup = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    switch (a) {
      case "--help":
      case "-h":
        return { help: true };
      case "--db": {
        const v = takeValue(argv, i + 1, "--db");
        if (typeof v === "object") return v;
        i++;
        dbPath = v;
        break;
      }
      case "--port": {
        const raw = argv[i + 1];
        if (raw !== undefined && raw.startsWith("--")) {
          return { error: "--port 后面要跟一个值（不是另一个参数）" };
        }
        const v = positiveInt(raw, "--port");
        if (typeof v === "object") return v;
        i++;
        port = v;
        break;
      }
      case "--port-file": {
        const v = takeValue(argv, i + 1, "--port-file");
        if (typeof v === "object") return v;
        i++;
        portFile = v;
        break;
      }
      case "--backup-dir": {
        const v = takeValue(argv, i + 1, "--backup-dir");
        if (typeof v === "object") return v;
        i++;
        backupDir = v;
        break;
      }
      case "--heartbeat": {
        const raw = argv[i + 1];
        if (raw !== undefined && raw.startsWith("--")) {
          return { error: "--heartbeat 后面要跟一个值（不是另一个参数）" };
        }
        const v = positiveInt(raw, "--heartbeat");
        if (typeof v === "object") return v;
        i++;
        heartbeatMs = v;
        break;
      }
      case "--no-backup":
        noBackup = true;
        break;
      default:
        return { error: "未知参数 " + String(a) };
    }
  }

  // env 只做缺省来源，不覆盖显式参数（同 maintenance.ts 的口径：
  // 显式给的是一个意思，环境里躺着的是另一个 ⇒ 报错指向环境而真相在命令行）。
  if (dbPath === undefined) dbPath = fromEnv(env, "OPC_DB");
  if (port === undefined) {
    const raw = fromEnv(env, "OPC_PORT");
    if (raw !== undefined) {
      const v = positiveInt(raw, "OPC_PORT");
      if (typeof v === "object") return v;
      port = v;
    }
  }
  if (backupDir === undefined) backupDir = fromEnv(env, "OPC_BACKUP_DIR");
  if (heartbeatMs === undefined) {
    const raw = fromEnv(env, "OPC_HEARTBEAT_MS");
    if (raw !== undefined) {
      const v = positiveInt(raw, "OPC_HEARTBEAT_MS");
      if (typeof v === "object") return v;
      heartbeatMs = v;
    }
  }

  if (dbPath === undefined || dbPath.trim() === "") {
    return { error: "缺 --db（或环境变量 OPC_DB）：刻意不猜默认库路径" };
  }
  if (port !== undefined && (port < PORT_MIN || port > PORT_MAX)) {
    return {
      error:
        "--port 必须在 " +
        PORT_MIN +
        "–" +
        PORT_MAX +
        " 之间，实到 " +
        port +
        "。刻意不接受 0（「让系统随便给一个」）：随机端口意味着客户端无从知道该连哪儿 —— " +
        "要么给一个固定端口，要么配 --port-file 让 Hub 把分到的端口写进那个文件。",
    };
  }
  if (port === undefined && portFile === undefined) {
    return {
      error:
        "缺 --port（或 OPC_PORT），也没有 --port-file。两者至少要一个：\n" +
        "  · --port 8787        ⇒ 固定端口，桌面壳按同一个数字连（数字由你定，代码不替你定）\n" +
        "  · --port-file <path> ⇒ 系统分配一个空闲端口并把它写进那个文件",
    };
  }
  if (heartbeatMs !== undefined && heartbeatMs < HEARTBEAT_FLOOR_MS) {
    return {
      error:
        "--heartbeat 不能小于 " +
        HEARTBEAT_FLOOR_MS +
        "ms（一分钟），实到 " +
        heartbeatMs +
        "ms。心跳那一轮是一条覆盖全表的只读扫描；把节奏调到毫秒级就是拿它挤自己的写队列，" +
        "而那正是【不得阻塞写队列】这条验收要防的事。",
    };
  }
  if (noBackup && backupDir !== undefined) {
    return {
      error:
        "--no-backup 与 --backup-dir 同时给了：前者说「这个进程永远不自动备份」，" +
        "后者说「备份放这里」。两个都要是矛盾的，而矛盾在这里不能靠顺序决定谁赢 —— " +
        "自动备份少一次是丢掉灾难恢复，多一次没人会抱怨，所以请显式去掉其中一个。",
    };
  }

  return {
    dbPath,
    ...(port === undefined ? {} : { port }),
    ...(portFile === undefined ? {} : { portFile }),
    ...(backupDir === undefined ? {} : { backupDir }),
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    ...(noBackup ? { noBackup: true } : {}),
  };
}

/**
 * 该进程多久备一次份。
 *
 * 规格 §6.5 说的是「每日 VACUUM INTO」，所以这是一个【日历日】判据而不是
 * 「距上次备份 24 小时」的计时器判据：两者在进程重启频繁时给不同答案 ——
 * 一天重启四次 ⇒ 四份备份，而规格要的那份「每天有且只有一份可恢复快照」
 * 会被稀释成四分之一天的。所以判据取「上一次成功备份的日期 ≠ 今天」。
 * 没有历史（第一次跑）⇒ 该备份。
 */
export function shouldBackUp(
  lastBackupAtMs: number | null,
  nowMs: number,
): boolean {
  if (lastBackupAtMs === null) return true;
  const day = (t: number): string => new Date(t).toISOString().slice(0, 10);
  return day(lastBackupAtMs) !== day(nowMs);
}
