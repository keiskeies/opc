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
