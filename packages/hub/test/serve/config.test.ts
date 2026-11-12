/**
 * 常驻 Hub 的参数层与备份相位（serve/config.ts）。
 *
 * ── 这一组的核心不是「解析对不对」，是「不猜默认值」这件事有没有被钉住 ──
 * 三个必填项各对应一种【猜了会怎样】：
 *   --db   猜一个路径 ⇒ 留下一个「谁也没决定过、而代码里写着」的库位置（cli.ts 纪律 1）
 *   --port 猜一个端口 ⇒ 与桌面壳里将来那个数字不同步，症状是「Hub 在跑而界面说未运行」
 *   备份目录 默认不给 ⇒ 一个「默认不备份」的舒适形状，代价在出事那天才付
 * 所以本文件里最值钱的那几条断言判的是【缺参时的报错】，不是取值。
 *
 * ── --port 0 被拒那一发是本文件唯一的「反直觉」处 ────────────────────
 * 「让系统随便给一个」在别处是好东西，在这里不是：随机端口意味着客户端无从知道
 * 该连哪儿。想要这个能力就得配 --port-file —— 那条路是通的，本文件也钉了它。
 * 拒 0 的价值在于它把人推向【有出口的】那条路，而不是让他以为 0 就够了。
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SERVE_USAGE,
  HEARTBEAT_FLOOR_MS,
  parseServeArgs,
  shouldBackUp,
} from "../../src/serve/config.js";

/** 一份「什么都不缺」的环境，逐条用例只覆盖自己那一维。 */
const CLEAN: NodeJS.ProcessEnv = {};
const BASE = ["--db", "/tmp/hub.db", "--port", "8787"];

describe("必填项：缺了就退，不猜", () => {
  it("缺 --db ⇒ 报错里点名 OPC_DB，且不给我一个建议路径", () => {
    const r = parseServeArgs([], CLEAN);
    expect(r.error).toContain("OPC_DB");
    expect(r.dbPath).toBeUndefined();
    // 反向：报错里不能出现一个具体路径。出现即「代码替你决定了一个库位置」，
    // 而那正是 cli.ts 纪律 1 消灭的东西。
    expect(r.error).not.toContain("/.opc-os/");
  });

  it("OPC_DB 是纯空白 ⇒ 算【没设】，不算『设成了一个空白路径』", () => {
    // 这一格是从 cli.ts 的冒烟测试里同一条缺陷搬来的（M8）：
    // 空白当设置 ⇒ openDb("") ⇒ 一个看不懂的 SQLite 报错，而真相是环境变量里有个空格。
    expect(parseServeArgs(["--port", "8787"], { OPC_DB: "   " }).error).toContain("OPC_DB");
  });

  it("既没 --port 也没 --port-file ⇒ 拒，且报错把两条出路都写出来", () => {
    const r = parseServeArgs(["--db", "/tmp/hub.db"], CLEAN);
    expect(r.error).toContain("--port");
    expect(r.error).toContain("--port-file");
  });

  it("⭐ --port 0 被拒：随机端口没有出口，除非配 port-file", () => {
    const r = parseServeArgs(["--db", "/tmp/hub.db", "--port", "0"], CLEAN);
    expect(r.error).toContain("0");
    expect(r.error).toContain("port-file");
    // 反向对照：同一份参数配上 port-file 就是合法的「系统分配」那条路。
    expect(
      parseServeArgs(
        ["--db", "/tmp/hub.db", "--port-file", "/tmp/hub.port"],
        CLEAN,
      ).error,
    ).toBeUndefined();
  });

  it("端口下界排掉特权段（1023 拒、1024 收）", () => {
    expect(parseServeArgs(["--db", "/tmp/h.db", "--port", "1023"], CLEAN).error).toBeDefined();
    expect(parseServeArgs(["--db", "/tmp/h.db", "--port", "1024"], CLEAN).error).toBeUndefined();
    expect(parseServeArgs(["--db", "/tmp/h.db", "--port", "65536"], CLEAN).error).toBeDefined();
  });
});

describe("env 只做缺省来源，不覆盖显式参数", () => {
  it("命令行给了 --db 时，OPC_DB 不参与", () => {
    const r = parseServeArgs(BASE, { OPC_DB: "/tmp/other.db" });
    expect(r.dbPath).toBe("/tmp/hub.db");
  });

  it("命令行没给时才读 env，且四个键都读", () => {
    const r = parseServeArgs([], {
      OPC_DB: "/tmp/e.db",
      OPC_PORT: "9000",
      OPC_BACKUP_DIR: "/tmp/bk",
      OPC_HEARTBEAT_MS: "120000",
    });
    expect(r).toEqual({
      dbPath: "/tmp/e.db",
      port: 9000,
      backupDir: "/tmp/bk",
      heartbeatMs: 120000,
    });
  });

  it("env 里的端口不合法 ⇒ 报错点名 OPC_PORT 而不是 --port", () => {
    // 点错名字会让人去改命令行而真相在 shell profile 里 —— 同一族「报错指向错的一侧」。
    const r = parseServeArgs(["--db", "/tmp/h.db"], { OPC_PORT: "abc" });
    expect(r.error).toContain("OPC_PORT");
  });

  it("非数字 / 超大整数各一个码，都不落成 NaN", () => {
    expect(parseServeArgs(["--db", "/tmp/h.db", "--port", "1e999"], CLEAN).error).toContain("整数");
    const r = parseServeArgs(["--db", "/tmp/h.db", "--heartbeat", "1e999"], CLEAN);
    expect(r.error).toBeDefined();
    if (r.heartbeatMs !== undefined) throw new Error("非法值不该有取值");
  });
});

describe("心跳下界", () => {
  it("小于下界 ⇒ 拒，且理由说的是【写队列】不是『太频繁』", () => {
    const r = parseServeArgs([...BASE, "--heartbeat", String(HEARTBEAT_FLOOR_MS - 1)], CLEAN);
    expect(r.error).toContain(String(HEARTBEAT_FLOOR_MS));
    expect(r.error).toContain("写队列");
  });

  it("恰好等于下界 ⇒ 收（边界值不能两边都拒）", () => {
    expect(
      parseServeArgs([...BASE, "--heartbeat", String(HEARTBEAT_FLOOR_MS)], CLEAN).error,
    ).toBeUndefined();
  });

  it("⭐ 下界存在的意义：没有它，`--heartbeat 1` 就是一次自我 DoS", () => {
    // 反向对照把「这一发确实是被下界拦的」钉住：把常量拿掉，参数就该通过。
    expect(parseServeArgs([...BASE, "--heartbeat", "1"], CLEAN).error).toBeDefined();
    expect(HEARTBEAT_FLOOR_MS).toBeGreaterThan(1);
  });
});

describe("备份的两种『不给』必须分得开", () => {
  it("--no-backup 与 --backup-dir 同时给 ⇒ 矛盾，拒", () => {
    const r = parseServeArgs([...BASE, "--no-backup", "--backup-dir", "/tmp/bk"], CLEAN);
    expect(r.error).toContain("矛盾");
  });

  it("--no-backup 单独给 ⇒ 通过（那是人的显式决定）", () => {
    const r = parseServeArgs([...BASE, "--no-backup"], CLEAN);
    expect(r.error).toBeUndefined();
    expect(r.noBackup).toBe(true);
    expect(r.backupDir).toBeUndefined();
  });

  it("⭐ 两个都不给 ⇒ 【通过】—— 不备份由 serve 那侧响亮地警告，不在这里静默放行也不在这里拒", () => {
    // 为什么不在这里拒：维护流程（maintenance）允许 --no-backup，
    // 而 serve 允许「先跑起来、我待会儿配备份」。这一层的职责是「参数矛盾不放过」，
    // 「没配备份」不是矛盾，是一句必须被【说出来】的话（断言在 assemble.test.ts）。
    const r = parseServeArgs(BASE, CLEAN);
    expect(r.error).toBeUndefined();
    expect(r.backupDir).toBeUndefined();
    expect(r.noBackup).toBeUndefined();
  });
});

describe("用法与解析的其它格", () => {
  it("--help / -h 短路，不再看后面的参数", () => {
    expect(parseServeArgs(["--help"], CLEAN).help).toBe(true);
    expect(parseServeArgs(["-h", "--db"], CLEAN).help).toBe(true);
  });

  it("未知参数 ⇒ 报错里带上那个参数原文", () => {
    expect(parseServeArgs([...BASE, "--pot"], CLEAN).error).toContain("--pot");
  });

  it("参数吃掉后一个 token ⇒ 报『后面要跟…』而不是把下一个当值", () => {
    // 「--db --port 8787」如果按顺序吃，会把 "--port" 当库路径，
    // 于是报错变成「库打不开：--port」，一次打字错误伪装成一个文件系统问题。
    expect(parseServeArgs(["--db"], CLEAN).error).toContain("后面要跟");
    expect(parseServeArgs(["--db", "--port", "8787"], CLEAN).error).toContain("后面要跟");
    expect(parseServeArgs(["--port"], CLEAN).error).toContain("后面要跟");
    // 三个开关的补齐文案各指自己的名字，不能共用一句「参数缺值」——
    // 人对着 --help 找的是「我哪一个少写了值」。
    expect(parseServeArgs(["--backup-dir"], CLEAN).error).toContain("--backup-dir");
    expect(parseServeArgs(["--port-file"], CLEAN).error).toContain("--port-file");
  });

  it("用法文本是一个字符串而不是数组（数组会被某个入口打印成逗号连接的一整行）", () => {
    expect(typeof DEFAULT_SERVE_USAGE).toBe("string");
    expect(DEFAULT_SERVE_USAGE).toContain("--port-file");
    // 退出码口径必须在用法里：这是人出事时读的第一处，也是唯一一处。
    expect(DEFAULT_SERVE_USAGE).toContain("退出码");
  });
});

describe("--bind：解析层只管形状，安全判据在 http/bind.ts", () => {
  it("--bind 是一个【可选】项：不传时结果里根本没有这个键", () => {
    const r = parseServeArgs(BASE, CLEAN);
    expect(r.error).toBeUndefined();
    // 断言「键不存在」而不是「值是 undefined」：后者两种写法都能过，
    // 而下游 assemble.ts 用的是 `args.bind === undefined ? {} : {requested: args.bind}`，
    // 那个三元判的是【有没有填】。空串在这里必须已经变成错误（下面那一发），
    // 所以到 assemble 手上的只可能是「没有」或「一个非空串」。
    expect(Object.prototype.hasOwnProperty.call(r, "bind")).toBe(false);
  });

  it("⭐ OPC_BIND 不存在：把 --bind 换成一个 env 缺省源会被这一发抓到", () => {
    // 这一发测的是【没有】一个功能，而「没有」很难断言 —— 直接扫用法文本与解析结果：
    //  · 用法文本里出现 OPC_BIND ⇒ 有人在文档里加了它，那解析层多半也加了；
    //  · 设了 OPC_BIND 而解析结果里冒出 bind ⇒ 解析层真的读了它。
    // 这一格存在的理由不是洁癖：serve/config.ts 里【其他每一项】都有 env 缺省源，
    // 「为了一致性补一个 OPC_BIND」读起来像修 bug，而它的实际效果是让
    // 【一次安全暴露】可以躺在 shell profile 里，每次启动都生效而命令行上看不见
    // （bind.ts 文件头列的三种「默认值被改掉」的路径之一）。
    expect(DEFAULT_SERVE_USAGE).not.toContain("OPC_BIND");
    const r = parseServeArgs(BASE, { OPC_BIND: "0.0.0.0" });
    expect(r.error).toBeUndefined();
    expect((r as { bind?: string }).bind).toBeUndefined();
    // 反向对照：同一份参数走命令行时【确实】能被读到 —— 证明上面那个 undefined
    // 不是「整个 --bind 没接上」造成的。
    expect(parseServeArgs([...BASE, "--bind", "0.0.0.0"], CLEAN).bind).toBe("0.0.0.0");
  });

  it("IP 字面量原样透传：这一层【不】判它安不安全", () => {
    // 0.0.0.0 在这里通过是【对的】，不是漏判。判「非回环要有远程审批通道」需要
    // 知道装配结果，而这一层只有 argv。把两层的判据混在一起会得到
    // 「解析层拒了一个装配层打算放行的值」，那种分歧的报错最误导人。
    const r = parseServeArgs([...BASE, "--bind", "0.0.0.0"], CLEAN);
    expect(r.error).toBeUndefined();
    expect(r.bind).toBe("0.0.0.0");
    // 主机名同样原样交下去（bind.ts 会拒它，并给出那句「不接受 localhost」的解释）。
    expect(parseServeArgs([...BASE, "--bind", "localhost"], CLEAN).bind).toBe("localhost");
  });

  it("⭐ --bind 后面是空串 ⇒ 拒，且不当成「没填」", () => {
    // --bind "" --port 8787 多半是引号打漏。当成「没填」的后果是：一个人以为
    // 自己在测局域网路径，而进程悄悄绑回了回环 —— 他接下来排查的是手机与防火墙。
    const r = parseServeArgs([...BASE, "--bind", ""], CLEAN);
    expect(r.error).toContain("--bind");
    expect((r as { bind?: string }).bind).toBeUndefined();
    // 纯空白同理（与上面 OPC_DB 那一条同一条判据）。
    expect(parseServeArgs([...BASE, "--bind", "   "], CLEAN).error).toContain("--bind");
  });

  it("--bind 吃掉后一个 token ⇒ 报『后面要跟』，而不是把 --port 当值", () => {
    // 与 --db/--port 同一条缺陷：吃掉下一个开关会让报错指向完全无关的方向。
    expect(parseServeArgs([...BASE, "--bind"], CLEAN).error).toContain("后面要跟");
    expect(parseServeArgs([...BASE, "--bind", "--no-backup"], CLEAN).error).toContain("后面要跟");
  });

  it("用法文本里看得到 --bind（安全相关的可选项在 --help 里不可见 = 没人知道有）", () => {
    expect(DEFAULT_SERVE_USAGE).toContain("--bind");
  });
});

describe("备份相位：日历日，不是 24 小时计时器", () => {
  const DAY = 86_400_000;

  it("没有历史 ⇒ 该备份", () => {
    expect(shouldBackUp(null, 0)).toBe(true);
  });

  it("同一天内多次问 ⇒ 都不备，哪怕相隔 23 小时", () => {
    // 这一发钉的是「判据是日历日而不是间隔」。两个时刻取在同一个 UTC 日内
    // 相距 23 小时（00:30 → 23:30）：按「距上次 24 小时」的计时器判据这里也会说不备，
    // 所以真正把两条判据分开的是下面那条【跨零点一秒就备】。
    const early = Date.parse("2026-03-10T00:30:00Z");
    expect(shouldBackUp(early, early + 3_600_000)).toBe(false);
    expect(shouldBackUp(early, early + 23 * 3_600_000)).toBe(false);
  });

  it("跨过 UTC 零点 ⇒ 该备份，即使只过了一秒", () => {
    const justBefore = Date.parse("2026-03-10T23:59:59Z");
    expect(shouldBackUp(justBefore, justBefore + 1_000)).toBe(true);
  });

  it("⭐ 一天重启四次 ⇒ 只有一份备份（这正是【不】用计时器的理由）", () => {
    // 用「距上次备份 24 小时」的计时器判据，四次重启 = 四份，
    // 而 7 份保留位会被同一天挤满，把上周那份真正有用的挤掉。
    const d0 = Date.parse("2026-03-10T01:00:00Z");
    let count = 0;
    for (let i = 0; i < 4; i++) {
      const now = d0 + i * 3_600_000;
      const last = count === 0 ? null : d0;
      if (shouldBackUp(last, now)) count++;
    }
    expect(count).toBe(1);
    // 反向对照：换到第二天，同样四次里只该多一份 —— 这一发证明上面那个 1
    // 不是「恒返回 false」造成的。
    let count2 = 0;
    let last: number | null = null;
    for (let i = 0; i < 4; i++) {
      const now = d0 + DAY + i * 3_600_000;
      if (shouldBackUp(last, now)) {
        count2++;
        last = now;
      }
    }
    expect(count2).toBe(1);
  });

  it("未来时刻（时钟回拨后）⇒ 不炸、也不无脑重备", () => {
    // 时钟回拨是笔记本合盖一夜后的常态。这一发的价值只在「不抛」，
    // 结论方向（备或不备）都不是安全关键的，所以不断言结论，只断言不抛。
    expect(() => shouldBackUp(Date.parse("2026-03-11T00:00:00Z"), Date.parse("2026-03-09T00:00:00Z"))).not.toThrow();
  });
});

/**
 * ── 章程泵这一组参数（0044）──────────────────────────────────────────
 * 判据的形状与 --bind 那一组是【同一条】：打开一件会动外部世界的事，
 * 必须是这一次命令里一个看得见的参数，而且它的【上限】要一起被看见。
 * 差别只在代价：--bind 打开的是对外暴露，这一组打开的是持续产生 token 账单。
 */
const PUMP = ["--charter-pump", "--max-budget-usd", "0.5", "--task-limit-cents", "500", "--agent-cwd", "/tmp/work"];

describe("--charter-pump：默认不开，开了就要三件同伴", () => {
  it("默认【不开】：结果里根本没有 charterPump 这个键", () => {
    const r = parseServeArgs(BASE, CLEAN);
    expect(r.error).toBeUndefined();
    // 断「键不存在」而不是「值为 undefined」，理由与 --bind 那一发同一条：
    // 下游 assemble 判的是【有没有填】。
    expect(Object.prototype.hasOwnProperty.call(r, "charterPump")).toBe(false);
  });

  it("四个一起给 ⇒ 解析出来", () => {
    const r = parseServeArgs([...BASE, ...PUMP], CLEAN);
    expect(r.error).toBeUndefined();
    expect(r.charterPump).toBe(true);
    expect(r.maxBudgetUsd).toBe(0.5);
    expect(r.taskLimitCents).toBe(500);
    expect(r.agentCwd).toBe("/tmp/work");
  });

  it("⭐ 只给开关而少任一件同伴 ⇒ USAGE，且报错点名【缺的那一件】", () => {
    // 为什么不能等到 makeRuntime 才炸：那时 Hub 已在监听、心跳已在跑、库已开着，
    // 一个人会以为「Hub 起来了而泵没起来」，实际可能是【泵在跑而没有上限】。
    // 参数层这一发是【一分钱都没花】的那一次红。
    for (const drop of ["--max-budget-usd", "--task-limit-cents", "--agent-cwd"]) {
      const i = PUMP.indexOf(drop);
      const argv = [...BASE, ...PUMP.slice(0, i), ...PUMP.slice(i + 2)];
      const r = parseServeArgs(argv, CLEAN);
      expect(r.error).toContain(drop);
      expect(r.charterPump).toBeUndefined();
    }
  });

  it("⭐ 反向：给了预算而【没给开关】也判 USAGE（写了而没生效的配置最害人）", () => {
    // 这一发看着苛求。它防的是一个人写了 --agent-cwd 与预算而漏了 --charter-pump，
    // Hub 照常起来，而他【以为自己把泵开了】—— 症状与"从没打算开"完全一样
    // （收件箱一直是空的），唯一排查方向是去读自己那条命令行。
    const r = parseServeArgs([...BASE, "--max-budget-usd", "0.5"], CLEAN);
    expect(r.error).toContain("--charter-pump");
    expect(r.error).toContain("不生效");
    expect((r as { maxBudgetUsd?: number }).maxBudgetUsd).toBeUndefined();
  });

  it("⭐ 没有 OPC_CHARTER_PUMP / OPC_MAX_BUDGET_USD 这类 env 缺省源", () => {
    // 与 OPC_BIND 那一条同一手法：断言【没有】一个功能。
    // 这一格比 --bind 更该钉：账单是【事后才知道的】，
    // 到那时「我当时看见过这个参数」那条防线已经不在了。
    expect(DEFAULT_SERVE_USAGE).not.toContain("OPC_CHARTER_PUMP");
    expect(DEFAULT_SERVE_USAGE).not.toContain("OPC_MAX_BUDGET");
    const r = parseServeArgs(BASE, {
      OPC_CHARTER_PUMP: "1",
      OPC_MAX_BUDGET_USD: "99",
      OPC_AGENT_CWD: "/tmp/leaked",
    });
    expect(r.error).toBeUndefined();
    expect(r.charterPump).toBeUndefined();
    expect(r.agentCwd).toBeUndefined();
    // 反向对照：同一组值走命令行时【确实】能被读到 ——
    // 证明上面那两个 undefined 不是「整个泵没接上」造成的。
    expect(parseServeArgs([...BASE, ...PUMP], CLEAN).charterPump).toBe(true);
  });

  it("--max-budget-usd 收小数（0.5 是最常见的写法，整数判据会拒一个正确用法）", () => {
    expect(parseServeArgs([...BASE, ...PUMP], CLEAN).maxBudgetUsd).toBe(0.5);
    // 整数也收（写成 2 而不是 2.0 的人占多数）
    const r = parseServeArgs(
      [...BASE, "--charter-pump", "--max-budget-usd", "2", "--task-limit-cents", "500", "--agent-cwd", "/tmp/w"],
      CLEAN,
    );
    expect(r.error).toBeUndefined();
    expect(r.maxBudgetUsd).toBe(2);
  });

  it("⭐ 上限的【形状】判据：Infinity / NaN / 负数都拒 —— Infinity 是「没有上限的上限」", () => {
    for (const bad of ["abc", "-1", "1e400", "0.5.5", ""]) {
      const r = parseServeArgs(
        [
          ...BASE,
          "--charter-pump",
          "--max-budget-usd",
          bad,
          "--task-limit-cents",
          "500",
          "--agent-cwd",
          "/tmp/w",
        ],
        CLEAN,
      );
      expect(r.error).toContain("--max-budget-usd");
    }
  });

  it("--agent-cwd 空串 ⇒ 拒，并说明这一格决定的是【角色能读到哪些文件】", () => {
    const r = parseServeArgs(
      [...BASE, "--charter-pump", "--max-budget-usd", "0.5", "--task-limit-cents", "500", "--agent-cwd", ""],
      CLEAN,
    );
    expect(r.error).toContain("--agent-cwd");
    expect(r.error).toContain("文件");
  });

  it("用法文本里这一组是【单独一段】，且写明了它打开的是花钱的一件事", () => {
    expect(DEFAULT_SERVE_USAGE).toContain("--charter-pump");
    expect(DEFAULT_SERVE_USAGE).toContain("花钱");
  });
});

/**
 * ── 驱动器这一组参数（0048）──────────────────────────────────────────
 *
 * 三个上限参数【共用】而开关是两个，所以这一组判据的重心不在"参数解析"
 * （上面那组已经逐格判过形状了），而在【两个开关之间的四种组合】：
 * 判据吃的是「任一开关 ⇒ 三格必填」与「两个都没给 ⇒ 三格不许出现」。
 * 那两处任何一处写窄了（`if (charterPump)` 而不是 `if (pumpFlags.length > 0)`），
 * 只写 --driver-pump 的人就会被一条【他自己没写过的】报错挡住，
 * 或者反过来：写了三个上限而两个开关都没给，Hub 照常起来而他以为自己开了。
 */
const DPUMP = ["--driver-pump", "--max-budget-usd", "0.5", "--task-limit-cents", "500", "--agent-cwd", "/tmp/work"];

describe("--driver-pump：默认不开，开了就要同样那三件同伴", () => {
  it("默认【不开】：结果里根本没有 driverPump 这个键", () => {
    const r = parseServeArgs(BASE, CLEAN);
    expect(r.error).toBeUndefined();
    // 断「键不存在」而不是「值为 undefined」：下游 assemble 判的是【有没有填】
    // （driverPump 那一格是 `?: boolean`，而 driverOn 读的是 args.driverPump === true）。
    expect(Object.prototype.hasOwnProperty.call(r, "driverPump")).toBe(false);
  });

  it("四个一起给 ⇒ 解析出来，而 charterPump 【不】被连带打开", async () => {
    const r = parseServeArgs([...BASE, ...DPUMP], CLEAN);
    expect(r.error).toBeUndefined();
    expect(r.driverPump).toBe(true);
    expect(r.maxBudgetUsd).toBe(0.5);
    expect(r.taskLimitCents).toBe(500);
    expect(r.agentCwd).toBe("/tmp/work");
    // ⭐ 两个开关【各开各的】。连带打开的话，只开驱动器的人会同时得到一条
    // 他没要过的、真起子进程去起草章程的路径 —— 那是两条独立的花钱决定被
    // 一个参数打开，而 --charter-pump 那条"必须显式"的立场就没了。
    expect(Object.prototype.hasOwnProperty.call(r, "charterPump")).toBe(false);
  });

  it("⭐ 只给 --driver-pump 而少任一件同伴 ⇒ USAGE，且报错点名【缺的那一件】与【是哪个开关】", () => {
    for (const drop of ["--max-budget-usd", "--task-limit-cents", "--agent-cwd"]) {
      const i = DPUMP.indexOf(drop);
      const argv = [...BASE, ...DPUMP.slice(0, i), ...DPUMP.slice(i + 2)];
      const r = parseServeArgs(argv, CLEAN);
      expect(r.error).toContain(drop);
      // 报错必须说【是 --driver-pump 要求的】。一句"还缺三个参数"对只写了
      // --driver-pump 的人来说像答非所问 —— 他不知道自己什么时候惹到了章程泵。
      expect(r.error).toContain("--driver-pump");
      expect(r.driverPump).toBeUndefined();
    }
  });

  it("⭐ 两个开关【同时】给而缺同伴 ⇒ 报错把两个开关都点出来", () => {
    // 只点一个的坏法：一个人按两个都开去理解那句报错，去补了一个"没要求他补"的开关，
    // 而真正缺的那一格还在缺。两个都写出来，他才知道这条命令行上有两条要求。
    const r = parseServeArgs(
      [...BASE, "--charter-pump", "--driver-pump", "--max-budget-usd", "0.5", "--agent-cwd", "/tmp/w"],
      CLEAN,
    );
    expect(r.error).toContain("--charter-pump");
    expect(r.error).toContain("--driver-pump");
    expect(r.error).toContain("--task-limit-cents");
  });

  it("⭐ 只给三个上限而【两个开关都没给】⇒ USAGE，且两个开关都在建议里", () => {
    // 判据吃的是【两个都没开】而不是【charterPump 关着】：后者会把
    // 只开 --driver-pump 的人当场拒掉，而那一行命令行【完全正确】。
    // 这一发就是钉那一步：先证明"只开驱动"这一行是能过的。
    expect(parseServeArgs([...BASE, ...DPUMP], CLEAN).error).toBeUndefined();
    const r = parseServeArgs([...BASE, "--max-budget-usd", "0.5", "--agent-cwd", "/tmp/w"], CLEAN);
    expect(r.error).toContain("--driver-pump");
    expect(r.error).toContain("--charter-pump");
    expect(r.error).toContain("不生效");
    expect((r as { maxBudgetUsd?: number }).maxBudgetUsd).toBeUndefined();
  });

  it("⭐ 只给【其中一个】开关时，反向那一半【不许】把另一条开关当成缺的东西", () => {
    // 反向判据一旦写成"三格给了就必须两个开关都在"，只开驱动器的人会被要求
    // 去补 --charter-pump —— 一句要求他打开【另一件花钱的事】的报错。
    const r = parseServeArgs([...BASE, ...DPUMP], CLEAN);
    expect(r.error).toBeUndefined();
    const c = parseServeArgs([...BASE, "--charter-pump", ...DPUMP.slice(1)], CLEAN);
    expect(c.error).toBeUndefined();
  });

  it("⭐ 没有 OPC_DRIVER_PUMP / OPC_* 这类 env 缺省源", () => {
    // 与 --bind / --charter-pump 同一手法：断言【没有】一个功能。
    // 这一格比 --bind 更该钉：账单是事后才知道的，到那时"我当时看见过这个参数"
    // 那条防线已经不在了。而驱动器比章程泵更贵（一趟推若干格而不是一轮起草）。
    expect(DEFAULT_SERVE_USAGE).not.toContain("OPC_DRIVER");
    const r = parseServeArgs(BASE, { OPC_DRIVER_PUMP: "1", OPC_MAX_BUDGET_USD: "99", OPC_TASK_LIMIT_CENTS: "1" });
    expect(r.error).toBeUndefined();
    expect(r.driverPump).toBeUndefined();
    // 反向对照：同一组值走命令行时【确实】能被读到 ——
    // 证明上面那个 undefined 不是「整个开关没接上」造成的。
    expect(parseServeArgs([...BASE, ...DPUMP], CLEAN).driverPump).toBe(true);
  });

  it("用法文本里这一组也是【单独一段】，且【不抄】按格尝试次数", () => {
    expect(DEFAULT_SERVE_USAGE).toContain("--driver-pump");
    // ⭐ 不写具体次数（3）：那三格上限没有 CLI 入口，只能由装配注入，
    // 用法文本里写一个缺省常量 = 第二个来源，它漂的时候没有任何东西会红，
    // 而读的人会拿屏幕上的数字去对审计里的 attempt/max_attempts 并判定系统坏了。
    // 这一发钉的是【那句自我承诺】：文案说"不抄"，所以它自己必须真的没抄。
    expect(DEFAULT_SERVE_USAGE).toContain("不抄那个次数");
    const driverBlock = DEFAULT_SERVE_USAGE.split("\n")
      .filter((l) => l.includes("驱动") || l.includes("driver") || l.includes("同一格"))
      .join("\n");
    expect(driverBlock).not.toMatch(/试\s*[0-9]+\s*次/);
    // 而它得指一个【真的存在】的地方，而不是指回一条不含那个数的横幅
    // （我第一版写的是"看 serve 启动横幅" —— 那条横幅【故意】不含次数，
    //   那是一句把人支去查一样不存在的东西的话。0048 记这一条。）
    expect(DEFAULT_SERVE_USAGE).toContain("DriverTurnClaimed");
    expect(DEFAULT_SERVE_USAGE).toContain("max_attempts");
  });
});

