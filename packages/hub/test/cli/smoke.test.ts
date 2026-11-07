/**
 * Task 0.10 —— Hub CLI 冒烟（计划 §Task 0.10）。
 *
 * 为什么用【真子进程】而不是 import runCli 直接调：CLI 的验收对象是命令行退出码。
 * 计划 V13 实测过 —— lint 规则降成 warn 后 biome 照样打印违规但退出码 0，
 * "日志里看着报错了"不等于门禁生效。凡退出码即契约，判据就得是真进程的 exit code。
 *
 * 四条验收各自钉住的事：
 *   A 一句想法能建库、跑完桩图、退出码 0，且【超步事务真的滚动】；
 *   B 重复 run 同一 --task 被【拒绝】而不是"跑了但没事"（0006 §3 的幂等契约）；
 *   C resume 在已完成的 thread 上不重放节点（0006 §1 实测：events 增量 0）；
 *   D 库路径只能显式给（--db 或 OPC_DB），绝不退化成 cwd。
 *
 * 【不测"不重复计费"】：Phase 0 一律用桩模型（计划 §10.4 第 7 条），桩不计费，
 * 那句验收在桩上恒真 —— 拿它当断言只会得到一条永远绿的测试。理由见 0006 §3。
 *
 * 变异测试结论（12 个变异全部被杀，见提交消息）。其中三个最初【存活】，都因为
 * 本文件当时缺断言，已按下文补上，而不是把断言放宽：
 *   · M4 少一层 instrumentSaver —— 补 A 组的超步事务计数；
 *   · M8 OPC_DB 空白也算设置 —— 补 D 组的纯空白用例；
 *   · M9 读命令不检查库文件是否存在 —— status 与 resume 各一条。
 * M6 上一轮是【侥幸】被杀的（污染 payload 非法 JSON 导致 CLI 崩在 JSON.parse，
 * 红在崩溃不在断言）；换成合法 JSON 它就活了，于是补了"每对 from→to 必须是合法
 * 跃迁"这条语义判据。M7 上一轮被我误判成等价变异（见该条测试的注释）；本轮拆成 M7a/M7b/M7c 三个变异后全部被杀。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isTaskTransitionLegal } from "../../src/graph/status.js";

/** 子进程 cwd 必须是 packages/hub：@langchain/core 只在该包的 deps 里（pnpm 严格布局）。 */
const HUB_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_SCRIPT = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const req = createRequire(import.meta.url);

interface Run {
  readonly code: number | null;
  readonly out: string;
  readonly err: string;
}

interface HubOpts {
  readonly env?: Record<string, string | undefined>;
}

function hub(args: readonly string[], opts: HubOpts = {}): Run {
  const r = spawnSync(
    process.execPath,
    [req.resolve("tsx/cli"), CLI_SCRIPT, ...args],
    {
      cwd: HUB_ROOT,
      encoding: "utf8",
      timeout: 170_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      // 【不能整体替换 env】：剥掉 PATH 之后 npx 装的 tsx 起不来，表现是"每条测试
      // 都退出 1"，而真实原因在 spawn 层，测试消息里完全看不到。只增不删。
      env: { ...process.env, ...opts.env },
    },
  );
  // 【实测，不是想当然】子进程 stdout/stderr 里的 ESC(0x1b) 计数为 0
  // （`hub --help` 与一次完整 hub run 各测一次），所以这里【不】剥 ANSI 色码。
  // 上一版照搬了 Task 0.8 e2e 里的 strip()，但那条命令的输出确实带色、这条不带 ——
  // 复制过来的就是一层永远不会命中的抽象，而且 biome 的
  // noControlCharactersInRegex 恰好把它指了出来：lint 报的"可疑"有时是真多余。
  return {
    // 实测（Task 0.8）：自杀式 SIGKILL 在 Windows 上表现为 status=1、signal=null，
    // 所以退出码断言一律写【具体数字】，不写 toBeTruthy / toBeLessThan 这类模糊式。
    code: r.status,
    out: r.stdout ?? "",
    err: r.stderr ?? "",
  };
}

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "opc-cli-"));
  dirs.push(dir);
  return join(dir, "hub.db");
}

afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，清不掉不影响结论 */
    }
  }
});

/**
 * 只读的第二条连接。
 * 写连接永远看得见自己未提交的写入 —— 拿它数行会假绿（Task 0.8 实测过：事务内可见
 * 5 行 / 只读连接见 4 行）。CLI 每次跑完都会 close 自己的连接，所以这里能打开。
 */
function readAll(dbPath: string, sql: string): Record<string, unknown>[] {
  const ro = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return ro.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    ro.close();
  }
}

const countEvents = (dbPath: string): number =>
  Number(
    (readAll(dbPath, "SELECT count(*) AS n FROM events")[0] as { n: number }).n,
  );

/** 从 hub status 的 stdout 里抠出轨迹的 from/to 对（不依赖具体缩进）。 */
function trajectory(out: string): [string, string][] {
  return out
    .split("\n")
    .map((l) => /^(\S+)\s*->\s*(\S+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1] as string, m[2] as string]);
}

/** 从 stdout 抠出"超步事务：N 个"。抠不到就返回 NaN，让断言红得明白。 */
function supersteps(r: Run): number {
  const m = /超步事务：(\d+)\s*个/.exec(r.out);
  return m?.[1] === undefined ? Number.NaN : Number(m[1]);
}

describe("Task 0.10 —— Hub CLI", () => {
  describe("参数契约（退出码即契约，V13）", () => {
    it("--help 退出 0，且三条子命令都在用法里", () => {
      const r = hub(["--help"]);
      expect(r.code).toBe(0);
      for (const verb of ["run", "status", "resume"]) {
        expect(r.out).toContain(verb);
      }
    });

    it("没有 --db 时报错退出 2，绝不编一个默认库路径", () => {
      // 与 pnpm migrate 同一条纪律（src/db/migrate-cli.ts 头部）：库位置属于应用配置，
      // 在这里编默认值就是留下一个"谁也没决定过、但代码里写着"的路径。
      const r = hub(["run", "--task", "T-1", "--idea", "x"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("数据库");
    });

    it("未知子命令退出 2，而不是被当成裸参数吃掉", () => {
      const r = hub([
        "runn",
        "--db",
        tmpDbPath(),
        "--task",
        "T-1",
        "--idea",
        "x",
      ]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("runn");
    });

    it("缺 --idea 或缺 --task 都退出 2 并指名缺哪个", () => {
      const noIdea = hub(["run", "--db", tmpDbPath(), "--task", "T-1"]);
      expect(noIdea.code).toBe(2);
      expect(noIdea.err).toContain("--idea");

      const noTask = hub(["run", "--db", tmpDbPath(), "--idea", "想法"]);
      expect(noTask.code).toBe(2);
      expect(noTask.err).toContain("--task");
    });

    /**
     * --thread 必须被【拒绝并指路】，绝不能被静默忽略。
     *
     * 两层判据分别拦两种不同的错（0006 §4.2 决定：只暴露 --task，thread_id 由它推导）：
     *
     * ① 实质危害 —— 静默忽略才是真事故。那样命令会照常跑完（退出 0、库建出来），
     *    使用者以为自己把审计和会话分开了，实际两边都是 task_id；此后 status 查甲
     *    任务的审计、resume 续乙会话的进度，两边都"看着合理"。所以除了退出码，还要
     *    断言【没有把库建出来】—— 这条不依赖任何文案，是硬判据。
     *
     * ② 决策不被抹掉 —— 拒绝的那一行必须自己给出替代方案。
     *
     * 【为什么这里允许断言消息内容】（上一轮我拿 V13 当理由拒绝断言，是错的）：
     * V13 说的是"别拿日志文本判断【门禁有没有生效】"—— 门禁看退出码，所以退出码断言
     * 一律用具体数字。它不是要求把用户可见的指引降格成不可断言的自由文本。"显式拒绝并
     * 说明原因"正是 0006 §4.2 的实现本体：一条决策若不允许在消息层面断言，就等于没有
     * 任何测试保护。
     *
     * 【判据为什么落在首行】不是随便挑一句措辞来咬：USAGE 里有"没有 --thread：
     * thread_id 由 --task 推导（docs/decisions/0006 §4）"这样一行，而 parse 出错时
     * CLI 会连着 USAGE 一起打印（cli.ts 的错误分支）—— 我第一版那三条 toContain
     * （--thread / --task / 0006）全被 USAGE 段兜住了，变异 M7 因此在 18 条测试下
     * 存活。首行是错误本体、USAGE 是空行之后的第二段，所以"首行同时出现 --thread 与
     * --task"表达的是【拒绝行自带替代方案】这个结构性质：把文案改写得更顺不会让它红，
     * 只有把专门拒绝降级成"未知选项：--thread"这种通用兜底（兜底首行不会提 --task）
     * 才会红。这正是我要的判别力。
     */
    it("拒绝 --thread：退出 2、不建库、且拒绝行自己给出 --task", () => {
      const dbPath = tmpDbPath();
      const r = hub([
        "run",
        "--db",
        dbPath,
        "--task",
        "T-1",
        "--idea",
        "x",
        "--thread",
        "别的会话",
      ]);

      // ① 拒绝执行，且不留下库文件（openDb + migrate 会建库，所以这条能拦静默忽略）
      expect(r.code).toBe(2);
      expect(existsSync(dbPath)).toBe(false);

      // ② 错误本体那一行必须同时指名 --thread 与替代方案 --task
      const head = r.err.split("\n")[0] ?? "";
      expect(head).toContain("--thread");
      expect(head).toContain("--task");
    });

    it("--thread=值 这种写法同样被拒绝并指路", () => {
      // --x=v 形式在 CLI 里到处支持（--db=、--task=、--idea=），使用者对 --thread=
      // 的期待只会更强。漏掉 startsWith("--thread=") 的话它会落进通用兜底。
      const dbPath = tmpDbPath();
      const r = hub([
        "run",
        "--db",
        dbPath,
        "--task",
        "T-1",
        "--idea",
        "x",
        "--thread=Z",
      ]);
      expect(r.code).toBe(2);
      expect(existsSync(dbPath)).toBe(false);
      const head = r.err.split("\n")[0] ?? "";
      expect(head).toContain("--thread");
      expect(head).toContain("--task");
    });
  });

  describe("D —— 库路径只能显式给，绝不退化成 cwd", () => {
    it("OPC_DB 生效：不带 --db 也能跑通，库落在指定路径", () => {
      const dbPath = tmpDbPath();
      const r = hub(["run", "--task", "T-ENV", "--idea", "想法"], {
        env: { OPC_DB: dbPath },
      });
      expect(r.code).toBe(0);
      expect(existsSync(dbPath)).toBe(true);
    });

    it("OPC_DB 是纯空白时不算设置了它：退出 2，不去 cwd 建库", () => {
      // 用"纯空白"而不是空串：Node 在 Windows 上对空串环境变量的处理与 POSIX 不一致，
      // 空串可能被直接丢掉 —— 那样这条测试什么也没测，还会假装通过。
      // 少了 trim() 那一步的话，"   " 会被当成合法路径、经 resolve() 落到 cwd 附近，
      // 得到的是 openDb 的 TypeError（退出 1），而不是"未指定库路径"（退出 2）。
      // 这正是变异 M8 的杀伤点。
      const r = hub(["run", "--task", "T-BLANK", "--idea", "想法"], {
        env: { OPC_DB: "   " },
      });
      expect(r.code).toBe(2);
      expect(r.err).toContain("未指定");
    });
  });

  describe("A —— 一句想法跑到 END", () => {
    it("在临时目录建库、跑完桩图、退出码 0", () => {
      const dbPath = tmpDbPath();
      expect(existsSync(dbPath)).toBe(false);

      const r = hub([
        "run",
        "--db",
        dbPath,
        "--task",
        "T-RUN",
        "--idea",
        "做一个 AI 笔记应用",
      ]);
      expect(r.code).toBe(0);
      // CLI 自己跑了迁移：库此前不存在还能退出 0，就意味着表建出来了
      // （否则 intake 的 INSERT 会炸在 no such table: tasks）。
      expect(existsSync(dbPath)).toBe(true);

      // 完整 14 条 §7.1 状态边
      expect(countEvents(dbPath)).toBe(14);
      const task = readAll(
        dbPath,
        "SELECT id, status, title, assigned_role FROM tasks",
      );
      expect(task).toHaveLength(1);
      expect(task[0]?.["status"]).toBe("ARCHIVED");
      // title 记想法原文（0006 §5）：审计日志要能看出这一趟做的是什么
      expect(task[0]?.["title"]).toBe("做一个 AI 笔记应用");
    });

    it("超步事务真的滚动，不是一个事务包整趟", () => {
      // 这条是变异 M4 逼出来的：CLI 是【新的装配点】，装配漏掉
      // auditor.instrumentSaver(...) 那一层时 —— 图跑完、14 条事件一行不少、退出码 0，
      // 只有"崩溃只回滚半个超步"这个保证当场消失（docs/decisions/0005 §16 第 1 类陷阱）。
      // 用下限而不是精确值：图加一个节点不该让这里红，但"塌成 1 个事务"必须红。
      const r = hub([
        "run",
        "--db",
        tmpDbPath(),
        "--task",
        "T-TX",
        "--idea",
        "想法",
      ]);
      expect(r.code).toBe(0);
      const n = supersteps(r);
      expect(Number.isNaN(n)).toBe(false);
      // 9 次节点执行 → 9 个超步；1 = 塌成一个事务 = 装配错。
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(12);
    });

    it("每次运行都声明用的是桩模型：不联网、不计费", () => {
      const r = hub([
        "run",
        "--db",
        tmpDbPath(),
        "--task",
        "T-STUB",
        "--idea",
        "想法",
      ]);
      expect(r.code).toBe(0);
      // 桩模型搬进 src/ 之后这是唯一护栏（0006 §5）：让日志能自证"这一趟没用真模型"。
      expect(r.out).toContain("桩");
    });
  });

  describe("B —— 重复 run 同一 task 被拒绝（0006 §3）", () => {
    it("第二次退出 2，且没有把已完成的任务再推一遍", () => {
      const dbPath = tmpDbPath();
      const first = hub([
        "run",
        "--db",
        dbPath,
        "--task",
        "T-DUP",
        "--idea",
        "同一想法",
      ]);
      expect(first.code).toBe(0);
      expect(countEvents(dbPath)).toBe(14);

      const second = hub([
        "run",
        "--db",
        dbPath,
        "--task",
        "T-DUP",
        "--idea",
        "同一想法",
      ]);
      // 拒绝执行，而不是"跑了但没事"。
      expect(second.code).toBe(2);
      expect(second.err).toContain("已存在");
      // 守卫必须【先查库】：图内 intake 的 INSERT OR IGNORE 对重复 id 一声不响，
      // 拿它当幂等机制的话，第二次 run 会把整条状态机再走一遍 → 14 条变 28 条。
      expect(countEvents(dbPath)).toBe(14);
      expect(second.out).not.toContain("END");
    });

    it("不同 task 互不影响", () => {
      const dbPath = tmpDbPath();
      expect(
        hub(["run", "--db", dbPath, "--task", "T-A", "--idea", "甲"]).code,
      ).toBe(0);
      expect(
        hub(["run", "--db", dbPath, "--task", "T-B", "--idea", "乙"]).code,
      ).toBe(0);
      expect(countEvents(dbPath)).toBe(28);
      expect(
        readAll(dbPath, "SELECT id FROM tasks ORDER BY id").map((r) => r["id"]),
      ).toEqual(["T-A", "T-B"]);
    });
  });

  describe("C —— resume 不重放已完成节点（0006 §1 实测）", () => {
    it("已完成的 thread 上 resume：退出 0，events 行数一条不多", () => {
      const dbPath = tmpDbPath();
      expect(
        hub(["run", "--db", dbPath, "--task", "T-RES", "--idea", "想法"]).code,
      ).toBe(0);
      const before = countEvents(dbPath);

      const r = hub(["resume", "--db", dbPath, "--task", "T-RES"]);
      expect(r.code).toBe(0);
      // 实测：已完成 thread 上 invoke(null) 只推进一个空超步，events 与节点执行都不增。
      // 这条变红 = 有人把 resume 接成了重放。
      expect(countEvents(dbPath)).toBe(before);
      // 且必须走 invoke(null) 而不是 Command(resume) —— 后者在无中断时当场抛
      // "Received empty Command input"（0006 §1），退出码就会是 1 而不是 0。
      expect(r.out).toContain("没有待恢复的中断");
    });

    it("对不存在的 task 做 resume / status 都退出 2 并指名 task", () => {
      const dbPath = tmpDbPath();
      // 先把库建出来（否则报的是 no such table，会把"任务不存在"这条契约藏起来）
      expect(
        hub(["run", "--db", dbPath, "--task", "T-EXISTS", "--idea", "x"]).code,
      ).toBe(0);

      const missingResume = hub(["resume", "--db", dbPath, "--task", "T-NOPE"]);
      expect(missingResume.code).toBe(2);
      expect(missingResume.err).toContain("T-NOPE");

      const missingStatus = hub(["status", "--db", dbPath, "--task", "T-NOPE"]);
      expect(missingStatus.code).toBe(2);
      expect(missingStatus.err).toContain("T-NOPE");
    });

    /**
     * 库文件不存在时，【两个读命令】都不能留下文件。
     *
     * 为什么 resume 与 status 要分开各测一次：requireExistingDb 在两条路径上各调用
     * 一次，删掉任意一处都只影响一个子命令。只测 resume 时，变异 M9（删掉 status 那
     * 一处）能活过整轮测试 —— 这是本轮变异测试实际抓到的缺口，不是假设。
     *
     * 断言 existsSync === false 才是这条测试的重点：退出码 2 在"库被建出来之后照样
     * 会说任务不存在"的路径上同样成立，只有"没留下文件"能区分【挡住了】与【先建库
     * 再报错】。后者更糟：拼错一次 --db 就多一个带全套表的空库，此后 existsSync(路径)
     * 恒真，下一次 hub run 打在同一个错路径上还会当成已有库继续用。
     */
    for (const verb of ["resume", "status"] as const) {
      it("库文件不存在时 " + verb + " 退出 2，且不创建任何文件", () => {
        const dbPath = join(
          mkdtempSync(join(tmpdir(), "opc-cli-fresh-")),
          "nope.db",
        );
        const r = hub([verb, "--db", dbPath, "--task", "T-FRESH"]);
        expect(r.code).toBe(2);
        expect(r.err).toContain("T-FRESH");
        expect(existsSync(dbPath)).toBe(false);
      });
    }
  });

  describe("hub status —— 审计日志的人工可读出口", () => {
    it("打印任务状态与完整状态机轨迹", () => {
      const dbPath = tmpDbPath();
      expect(
        hub(["run", "--db", dbPath, "--task", "T-STAT", "--idea", "想法"]).code,
      ).toBe(0);

      const r = hub(["status", "--db", dbPath, "--task", "T-STAT"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("T-STAT");
      // Phase 0 出口门禁要"人工核对审计日志可读性"（计划 Task 0.11），status 就是那个人工入口。
      expect(r.out).toContain("CHARTER_PENDING");
      expect(r.out).toContain("ARCHIVED");
      // 14 条跃迁：轨迹必须只含状态边。把 action 写死成 "TaskStateChanged" 会查出 0 行
      // （events.action 存的是 §22.1 的 state_change），不筛 action 则会混进别的事件类型
      // —— 变异 M5、M6 各杀一条，就是这两个方向。
      expect(trajectory(r.out)).toHaveLength(14);
    });

    it("轨迹只含状态跃迁：混进来的别类事件被 action 过滤掉", () => {
      // 这条是变异 M6 逼出来的，而 M6 上一轮【侥幸】被杀过一次：当时污染事件的 payload
      // 写成非法 JSON，cmdStatus 在 JSON.parse 处崩掉、退出码变 1，测试才红 —— 红在崩溃
      // 上，不是红在断言上。payload 换成合法 JSON 之后 M6 就活了：不筛 action 时那行被
      // 渲染成 "? -> ?"，行数与形状都和真跃迁一样。
      //
      // 所以判据必须落在【语义】上，而不是行数上：轨迹里的每一对 from→to 都必须是 §7.1
      // 的合法跃迁。isTaskTransitionLegal 对不认识的状态名【抛错】而不是返回 false
      // （src/graph/status.ts），所以污染行会让这里当场炸出"未知状态 ?"，
      // 而不是悄悄少一行。
      const dbPath = tmpDbPath();
      expect(
        hub(["run", "--db", dbPath, "--task", "T-POLLUTE", "--idea", "想法"])
          .code,
      ).toBe(0);

      // events.action 是无约束 TEXT（0001_init.sql:60），库里本来就可能有别类事件 ——
      // 这里插一条 action 正确格式、但不是状态跃迁的行：ReviewDecided 落在 review_decision。
      const wr = new DatabaseSync(dbPath);
      try {
        wr.prepare(
          "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, state_snapshot, created_at) " +
            "VALUES (?, 'agent', 'cto', 'review_decision', 'x', ?, NULL, ?)",
        ).run(
          "T-POLLUTE",
          JSON.stringify({ verdict: "approved" }),
          1_700_000_000_000,
        );
      } finally {
        wr.close();
      }
      expect(countEvents(dbPath)).toBe(15);

      const r = hub(["status", "--db", dbPath, "--task", "T-POLLUTE"]);
      expect(r.code).toBe(0);
      const pairs = trajectory(r.out);
      expect(pairs).toHaveLength(14);
      // 语义判据：每一对都是合法跃迁。少过滤会在这里抛"未知状态 ?"。
      for (const [from, to] of pairs) {
        expect(
          isTaskTransitionLegal(from as never, to as never),
          from + " -> " + to,
        ).toBe(true);
      }
      // 且轨迹是完整链的头尾
      expect(pairs[0]?.[0]).toBe("CHARTER_PENDING");
      expect(pairs[13]?.[1]).toBe("ARCHIVED");
    });
  });
});
