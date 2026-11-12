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
  "      [--no-backup] [--bind <IP>] [--ceo <名字>] [--help]",
  "      环境变量 OPC_DB / OPC_BACKUP_DIR / OPC_PORT / OPC_HEARTBEAT_MS 只做【缺省来源】，不覆盖显式参数。",
  // --bind 那一行【没有】对应的 OPC_BIND，而这不是漏写。写清楚，否则下一个补 env
  // 的人是在「修一个不一致」，而他读不到任何一句告诉他这不是不一致（理由见下文的注释）。
  "      ⚠ --bind 【没有】env 缺省源：打开对外暴露必须是这一次命令里一个看得见的参数。",
  "",
  // 泵这一组【单独一段】而不是并进上面那行可选参数里：它要三个必填的同伴。
  // 挤在同一行会让人以为 `--charter-pump` 单打就行（打单了会 USAGE，
  // 但那次挫败本来可以避免 —— 用法文本是照着敲的，不是照着查的）。
  "让常驻 Hub 自己去补章程卡（默认【不开】）：",
  "      --charter-pump --max-budget-usd <美元/轮> --task-limit-cents <美分/任务> --agent-cwd <目录>",
  "      开了之后：停在「等章程」那一格而收件箱里没有卡的任务，每隔一个心跳会由那个角色",
  "      【自己起草一份章程提案】放进 CEO 收件箱。真起子进程、真花钱。",
  "",
  "让常驻 Hub 自己往下推任务（默认【不开】，三个上限参数与上面那一组【共用】）：",
  "      --driver-pump --max-budget-usd <美元/轮> --task-limit-cents <美分/任务> --agent-cwd <目录>",
  "      开了之后：CEO 批完一张卡之后，停在 agent 那一格的任务【自己往下走】，",
  "      不需要有人再敲一次 hub work。走到人席（等章程 / 等裁决 / 等终审）就停下等你点。",
  "      一条任务在同一格【试到上限就不再试】并在终端【说出来】——",
  "      因为「一直在重试」会让停滞巡检以为这一格有人在看着。每一次是第几轮写在审计行",
  "      DriverTurnClaimed / DriverTurnAbandoned 的 payload 里（attempt / max_attempts）；",
  "      用法文本与启动横幅都【不抄那个次数】—— 抄了就是第二个来源，而它漂的时候没人会红）。",
  "",
  "      ⚠ 上面两组同样【没有】env 缺省源，理由与 --bind 同一条而更硬：",
  "        --bind 打开的是对外暴露，这两组打开的是【持续产生 token 账单】的一件事。",
  "",
  "做四件事，按这个顺序：",
  "  1) 抢库文件旁边的写者锁（<db>.lock）。别的进程持着 ⇒ 【拒绝启动】，",
  "     否则两个「唯一写者」会交错写同一个库而不报错（规格 §5.1）",
  "  2) 打开 + 迁移 + 启动时的页面完整性检查（不过 ⇒ 拒绝启动并指路 scripts/restore.md）",
  "  3) 起 HTTP/SSE（默认只绑 127.0.0.1；--bind 换地址要看 http/bind.ts 的判据，",
  "     非回环要求一次性 token 的远程审批通道已接上，否则拒绝启动）",
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
  /**
   * 【要求】绑定的地址，原样透传（不校验、不规整、不猜默认）。
   *
   * 为什么这里【不做校验】而 --port 那边做：校验「这是不是一个合法的非回环 IP」
   * 属安全判据，它住在 http/bind.ts，而那一层还要问一个本层【回答不了】的问题 ——
   * 「远程审批通道接上了吗」。在这一层提前判一次，就会有两份「这算不算 LAN」的判据，
   * 而两份判据之间必然漂移（0026 §9 撤掉 isPendingStatus 时记的就是那一族）。
   * 本层只保证「拿到的是一个非空的值」，那是参数解析的职责。
   */
  readonly bind?: string;
  /**
   * 「谁校验 IM 身份绑定」写进 `im_bindings.verified_by` 的那个名字（0031，`--ceo`）。
   * 不给 ⇒ `POST /bindings/verify` 回 501，读侧与申请照旧。
   *
   * ⚠ 它是【署名来源】，不是鉴权：它不判「这个人能不能校验」，只决定
   * 库里那一格写着谁。完整论证在 HubDeps.bindingVerifier 旁边那份（唯一一处）。
   *
   * 与 `--bind` 同一条立场：**刻意没有 OPC_CEO 这个 env 缺省源**。
   * 「这个人的名字是校验人」是一次要看得见的决定 —— 一个从 shell profile
   * 或 compose 文件里继承来的名字，等于让某次校验带着一个没人决定过的署名落库，
   * 而那一格存在的唯一价值就是「有人认领了这件事」。
   */
  readonly ceo?: string;
  /**
   * 「让常驻 Hub 自己去补章程卡」（0044）。不给 ⇒ 这一整块【不存在】。
   *
   * ⚠ 与 `--bind` 同一条立场，而且理由更硬：**刻意没有 OPC_CHARTER_PUMP**。
   * --bind 打开的是【对外暴露】，这一格打开的是【每隔一个心跳自己起一个子进程花钱】。
   * 一个从 shell profile / compose 文件 / CI 变量里继承来的开关，
   * 等于让这台机器在没有任何人决定的情况下持续产生 token 账单 ——
   * 而账单是【事后才知道的】，那时已经没有「我当时看见过这个参数」那条防线了。
   */
  readonly charterPump?: boolean;
  /**
   * 一轮起草给一个角色的美元硬顶（落到 `--max-budget-usd`）。
   * 与 --charter-pump 一起必填（0041 §8 那条「花钱的东西不给默认值」）。
   */
  readonly maxBudgetUsd?: number;
  /** 任务级预算上限（美分）。同样必填。 */
  readonly taskLimitCents?: number;
  /**
   * agent 的工作目录（§12 沙箱那一维）。同样必填 —— 猜一个目录等于猜它能看见哪些文件，
   * 而「它能不能读到 ~/.ssh」这种事不该由参数解析的默认值决定。
   *
   * ⚠ 本层【只判非空】，与 --bind / --ceo 同一层职责：这个文件是纯函数、不碰 fs。
   * 目录不存在要到真起子进程那一刻才炸 —— 登记的代价写在 assemble.ts 那一处
   * （它在那里补一句启动横幅上的实话）。
   */
  readonly agentCwd?: string;
  /**
   * 「让常驻 Hub 自己去推 agent 那一格」（0048）。不给 ⇒ 这一整块【不存在】。
   *
   * 与 `--charter-pump` 是同一条立场而代价更大：章程泵起的是【一次起草】，
   * 这一格起的是【一条链上的每一轮】—— 一条想法可能连着烧掉好几轮真钱。
   * 所以它【单独一个开关】而不与 --charter-pump 合并：
   * 「补卡」与「推任务」是两件事，合并会让人以为开了一个就开了两个，
   * 而反过来想只开补卡的人必须连带接受一个会持续跑角色的循环。
   * 三个花钱的上限（下面那三格）是【两个泵共用】的：同一台 Hub 上
   * 「一轮给多少美元 / 一条任务给多少美分 / 角色能看见哪些文件」不该有两个答案。
   */
  readonly driverPump?: boolean;
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

/**
 * 一个 >= 0 的数（美元可以有小数，美分与次数不行 —— 调用方各自判整数）。
 *
 * 单独一个函数而不是复用 positiveInt：`--max-budget-usd 0.5` 是这一格【最常见】的写法
 * （一轮起草花不了 1 美元），拿整数判据拒它是拒一个正确用法。
 * 而"接受小数"不等于"接受任何东西"：NaN / 负数 / `1e400`（=Infinity）都在这里挡下，
 * 因为 Infinity 传到底下就是一个【没有上限的上限】，而那条参数存在的全部理由就是上限。
 */
function nonNegativeNumber(raw: string | undefined, name: string): number | { error: string } {
  if (raw === undefined) return { error: name + " 后面要跟一个值" };
  if (!/^\d+(\.\d+)?$/u.test(raw)) {
    return { error: name + " 必须是一个非负十进制数，实到 " + raw };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { error: name + " 必须是有限数（不接受 Infinity / NaN），实到 " + raw };
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
  let bind: string | undefined;
  let ceo: string | undefined;
  let charterPump = false;
  let driverPump = false;
  let maxBudgetUsd: number | undefined;
  let taskLimitCents: number | undefined;
  let agentCwd: string | undefined;

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
      case "--bind": {
        const v = takeValue(argv, i + 1, "--bind");
        if (typeof v === "object") return v;
        i++;
        bind = v;
        break;
      }
      case "--ceo": {
        const v = takeValue(argv, i + 1, "--ceo");
        if (typeof v === "object") return v;
        i++;
        // 只做「非空」这一件判据，与 --bind 同一层职责（见 ServeArgs.bind 那段）。
        // 「这是不是一个真实存在的人」不属这一层，也没有任何一层能回答它 ——
        // 那正是 0030 §9 还挂着的那格「谁有权校验」。
        if (v.trim() === "") return { error: "--ceo 后面要跟一个非空的名字" };
        ceo = v.trim();
        break;
      }
      case "--charter-pump":
        charterPump = true;
        break;
      case "--driver-pump":
        driverPump = true;
        break;
      case "--max-budget-usd": {
        const raw = argv[i + 1];
        if (raw !== undefined && raw.startsWith("--")) {
          return { error: "--max-budget-usd 后面要跟一个值（不是另一个参数）" };
        }
        const v = nonNegativeNumber(raw, "--max-budget-usd");
        if (typeof v === "object") return v;
        i++;
        maxBudgetUsd = v;
        break;
      }
      case "--task-limit-cents": {
        const raw = argv[i + 1];
        if (raw !== undefined && raw.startsWith("--")) {
          return { error: "--task-limit-cents 后面要跟一个值（不是另一个参数）" };
        }
        const v = positiveInt(raw, "--task-limit-cents");
        if (typeof v === "object") return v;
        i++;
        taskLimitCents = v;
        break;
      }
      case "--agent-cwd": {
        const v = takeValue(argv, i + 1, "--agent-cwd");
        if (typeof v === "object") return v;
        i++;
        if (v.trim() === "") {
          return {
            error:
              "--agent-cwd 后面是一个空值。这一格决定【角色能读到哪些文件】，" +
              "空串不是一个目录：给一个路径，或者整个参数不要给（那样泵根本不会开）。",
          };
        }
        agentCwd = v;
        break;
      }
      default:
        return { error: "未知参数 " + String(a) };
    }
  }

  // env 只做缺省来源，不覆盖显式参数（同 maintenance.ts 的口径：
  // 显式给的是一个意思，环境里躺着的是另一个 ⇒ 报错指向环境而真相在命令行）。
  if (dbPath === undefined) dbPath = fromEnv(env, "OPC_DB");
  // --bind 【刻意没有 OPC_BIND】。这一层其他每一项都有 env 缺省源，只有它没有，
  // 而这个【不一致】就是内容本身：http/bind.ts 文件头列的那三种「默认值被改掉」的
  // 途径里，第二条正是「一次 env 里躺着的 OPC_BIND」。
  // 一个安全边界只能由【这一次启动命令里一个看得见的参数】打开；
  // 从环境继承来的暴露不算任何人做过决定（compose 文件、shell profile、CI 变量
  // 都能带着它活过很多次「我没动过那块」的排查）。
  // 所以将来觉得「为了一致性该补个 OPC_BIND」的人：请连 bind.ts 那一段一起推翻。
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
  if (bind !== undefined && bind.trim() === "") {
    return {
      error:
        "--bind 后面是一个空值。要么给一个 IP 字面量（" +
        "本机回环写 127.0.0.1），要么【整个参数不要给】（默认就是回环）。\n" +
        "空串在这里不当成「没填」：那会让一次引号打漏（--bind \"\" --port 8787）" +
        "变成一个【静默用默认值】的启动，而这个人以为自己显式指定过监听地址。",
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

  /**
   * ⭐ 泵开着而三格里少任何一格 ⇒ USAGE。判据的形状与 bind.ts 那条同族：
   * 「打开一件会动外部世界的事」与「它的上限」必须在【同一条命令里】一起被看见。
   *
   * 为什么不在启动后才炸（makeRuntime 那里判）：那时 Hub 已经在监听、
   * 心跳已经在跑、库已经开着，而一个手抖漏了 --task-limit-cents 的运维命令
   * 会让人以为「Hub 起来了而泵没起来」，实际是【泵在跑而没有上限】。
   * 参数层判红是【一分钱都没花】的那一次红。
   *
   * ⚠ 这一道判据现在吃【两个】开关（charterPump / driverPump），而那两个开关
   * 【共用】下面那三个上限参数。合用的理由写在 ServeArgs.driverPump 旁边：
   * 同一台 Hub 上「一轮给多少美元 / 一条任务给多少美分 / 角色能看见哪些文件」
   * 不该有两个答案。所以这里的判据是【任一开关 ⇒ 三格必填】，
   * 而报错文案必须【点名是哪个开关要求的】—— 一句"还缺三个参数"
   * 在命令行上只写了 --driver-pump 的人看起来像答非所问。
   */
  const pumpFlags = [charterPump ? "--charter-pump" : "", driverPump ? "--driver-pump" : ""].filter(
    (s) => s !== "",
  );
  if (pumpFlags.length > 0) {
    const missing: string[] = [];
    if (maxBudgetUsd === undefined) missing.push("--max-budget-usd <美元/轮>");
    if (taskLimitCents === undefined) missing.push("--task-limit-cents <美分/任务>");
    if (agentCwd === undefined) missing.push("--agent-cwd <角色可读文件的目录>");
    if (missing.length > 0) {
      return {
        error:
          pumpFlags.join(" 与 ") + " 还缺 " + missing.join("、") + "。\n" +
          "这两个开关开着 ⇒ 常驻 Hub 每隔一个心跳【自己起 claude 子进程】：\n" +
          "  · --charter-pump 补的是「停在等章程那一格而收件箱里没有卡」的那【一轮起草】\n" +
          "  · --driver-pump   推的是「停在 agent 那一格而没人敲 hub work」的【每一轮】\n" +
          "那是真花钱、真读写文件的一件事。\n" +
          "  · --max-budget-usd 0.5      一轮的美元硬顶（直接落到 --max-budget-usd）\n" +
          "  · --task-limit-cents 500    单条任务的预算上限（美分）\n" +
          "  · --agent-cwd ~/opc/work    角色能看见哪些文件由这一格决定\n" +
          "  三条都是【必填】：不给默认值 = 不替你决定「花多少算多」和「它能读到什么」。",
      };
    }
  }
  /**
   * 反向那一半也判：给了上限而【两个开关都没给】⇒ USAGE。
   *
   * 这一发看着像苛求（"多给参数有什么用"），它防的是一个具体的误以为：
   * 一个人写了 `--agent-cwd ~/opc/work --max-budget-usd 0.5` 而漏了那两个开关，
   * Hub 照常起来、照常监听，而他【以为自己把泵开了】。
   * 那与"从没打算开泵"在症状上一模一样（收件箱一直是空的、任务一步不动），
   * 而唯一的排查方向是去读自己那条命令行 —— 本仓抓过多次的那类「配置写了而没生效」。
   * ⚠ 判据吃的是【两个都没开】而不是【charterPump 关着】：后者会把
   * 只开 --driver-pump 的人当场拒掉，而那一行命令行【完全正确】。
   * 与 --no-backup / --backup-dir 那条同一手法：矛盾或意图不明的组合，
   * 在启动前判红，不靠顺序决定谁赢。
   */
  if (
    pumpFlags.length === 0 &&
    (maxBudgetUsd !== undefined || taskLimitCents !== undefined || agentCwd !== undefined)
  ) {
    return {
      error:
        "给了预算/工作目录而没给 --charter-pump 或 --driver-pump：两个开关都关着的时候那三个参数【一个都不生效】。\n" +
        "  · 想让 Hub 自己补章程卡 ⇒ 补 --charter-pump\n" +
        "  · 想让 Hub 自己推 agent 那一格 ⇒ 补 --driver-pump（0048：CEO 批完之后不再需要有人敲 hub work）\n" +
        "  两者打开的都是「每隔一个心跳自己起子进程花钱」，所以必须显式。\n" +
        "  · 不想开 ⇒ 把这三个参数去掉，别留一份【写了而没生效】的配置在命令行里",
    };
  }

  return {
    dbPath,
    ...(port === undefined ? {} : { port }),
    ...(portFile === undefined ? {} : { portFile }),
    ...(backupDir === undefined ? {} : { backupDir }),
    ...(heartbeatMs === undefined ? {} : { heartbeatMs }),
    ...(bind === undefined ? {} : { bind }),
    ...(ceo === undefined ? {} : { ceo }),
    ...(noBackup ? { noBackup: true } : {}),
    ...(charterPump ? { charterPump: true } : {}),
    ...(driverPump ? { driverPump: true } : {}),
    ...(maxBudgetUsd === undefined ? {} : { maxBudgetUsd }),
    ...(taskLimitCents === undefined ? {} : { taskLimitCents }),
    ...(agentCwd === undefined ? {} : { agentCwd }),
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
