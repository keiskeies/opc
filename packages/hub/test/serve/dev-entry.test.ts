/**
 * `pnpm dev` 入口的装配用例（O13 动作 1）。
 *
 * 判的是【装配顺序与收尾】，不是 Hub 本身（boot 自己的语义由 assemble.test.ts 负责）。
 * 三条主张各对应文件头那条判据，而且全部走注入：
 * 不真起进程、不抢端口、不给自己发信号（理由见 DevDeps.waitStop 旁边）。
 *
 * ⚠ 这一族用例的假 spawn 返回的是 EventEmitter，不是真子进程。它证明的是
 * 「runDev 在拿到一个会 exit 的对象时行为正确」，不证明「真 tsx 起得来」——
 * 那一格由下面的端到端探针负责（真起一次 dev-server 子进程，判它 listen 成功）。
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { BootResult, ServeIo } from "../../src/serve/assemble.js";
import type { ServeArgs } from "../../src/serve/config.js";
import {
  DEV_HUB_PORT,
  DEV_WEB_PORT,
  type DevDeps,
  devPaths,
  EXIT_CHILD_GONE,
  type ResolvedDevPaths,
  repoRootOf,
  runDev,
  type WebSpawnSpec,
  webSpawnArgs,
} from "../../src/serve/dev-entry.js";

const ROOT = "D:/repo";

/** 假子进程：kill() 之后【下一个宏任务】补一发 exit —— 真 SIGTERM 就是这样异步落地的。 */
function fakeWeb(): {
  child: ChildProcess;
  fireExit: (code: number | null) => void;
  /** 同步发 exit：用来模拟「信号落地后子进程【抢在 race 续跑之前】就退了」。 */
  fireExitNow: (code: number | null) => void;
  kills: () => number;
} {
  const ee = new EventEmitter();
  let kills = 0;
  const child = {
    killed: false,
    kill: (): boolean => {
      kills += 1;
      (child as { killed: boolean }).killed = true;
      setTimeout(() => ee.emit("exit", null), 0);
      return true;
    },
    once: ee.once.bind(ee),
    on: ee.on.bind(ee),
  } as unknown as ChildProcess;
  return {
    child,
    fireExit: (code): void => {
      // 下一宏任务再发：runDev 在 boot 那一发 await 【之后】才挂 exit 监听，
      // 同步 emit 会发生在监听挂上之前 ⇒ 事件丢掉 ⇒ 用例挂死。
      setTimeout(() => ee.emit("exit", code), 0);
    },
    fireExitNow: (code): void => {
      ee.emit("exit", code);
    },
    kills: (): number => kills,
  };
}

function fakeBootOk(onShutdown?: () => void): BootResult {
  return {
    ok: true,
    port: DEV_HUB_PORT,
    token: "t",
    bindHost: "127.0.0.1",
    exposure: "loopback",
    lockPath: "/tmp/x.lock",
    // 假 boot 造的那台没有 IM 通道，而这一格是【必填】的：可选的话每个新调用点
    // 会安静地漏掉它，而漏掉的后果是「停止顺序」少说一步真的会发生的等待。
    imWired: false,
    heartbeat: null as never,
    shutdown: async () => {
      onShutdown?.();
    },
  };
}

/** 一条跑完的 runDev：返回它记的日志、boot 收到什么、web 起了几次、以及【退出后】的操作句柄。 */
function harness(
  o: {
    boot?: (args: ServeArgs) => Promise<BootResult>;
    web?: ReturnType<typeof fakeWeb>;
    migrateCode?: number;
  } = {},
): {
  logs: string[];
  warns: string[];
  booted: ServeArgs[];
  bootOverrides: Record<string, unknown>[];
  spawned: WebSpawnSpec[];
  migrations: string[][];
  shutdowns: { v: number };
  unregistered: { v: number };
  web: ReturnType<typeof fakeWeb>;
  /**
   * 模拟一次 Ctrl-C：先立「正在停止」的标记，再让停止等待落地 ——
   * 与真信号同序（runDev 先注册标记再进 waitForShutdown，监听按注册序跑）。
   */
  signal: () => void;
  /** 只立标记、不让停止等待落地：用来撞「标记已立而 race 还没续跑」那个窗口。 */
  markStoppingOnly: () => void;
  done: Promise<{ code: number }>;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const io: ServeIo = { log: (m) => logs.push(m), warn: (m) => warns.push(m) };
  const web = o.web ?? fakeWeb();
  const spawned: WebSpawnSpec[] = [];
  const booted: ServeArgs[] = [];
  const bootOverrides: Record<string, unknown>[] = [];
  const migrations: string[][] = [];
  const shutdowns = { v: 0 };
  const unregistered = { v: 0 };
  let emitStop: () => void = () => {};
  let resolveWait: (code: number) => void = () => {};
  const p: ResolvedDevPaths = {
    dbPath: ROOT + "/.opc-os/dev.db",
    hubPort: DEV_HUB_PORT,
    webPort: DEV_WEB_PORT,
    token: "tok-来自-环境变量",
    tokenGenerated: false,
  };
  const deps: DevDeps = {
    io,
    bootHub: (args, _io, ov) => {
      booted.push(args);
      bootOverrides.push(ov as Record<string, unknown>);
      return o.boot
        ? o.boot(args)
        : Promise.resolve(
            fakeBootOk((): void => {
              shutdowns.v += 1;
            }),
          );
    },
    spawnWeb: (spec) => {
      spawned.push(spec);
      return web.child;
    },
    runMigrate: (argv) => {
      migrations.push([...argv]);
      return { code: o.migrateCode ?? 0 };
    },
    // 替掉真信号等待（理由见 DevDeps.waitStop 旁边），落地时机由 signal() 管。
    waitStop: () =>
      new Promise<number>((res) => {
        resolveWait = res;
      }),
    // 假信号发射器：测试按它 = 「有人在终端按 Ctrl-C」，而不动真 process
    //（理由见 DevDeps.onStopSignals 旁边：一发真信号会打到同进程其他用例的监听上）。
    onStopSignals: (onStopping) => {
      emitStop = onStopping;
      return () => {
        unregistered.v += 1;
      };
    },
  };
  const done = runDev(p, deps, ROOT);
  return {
    logs,
    warns,
    booted,
    bootOverrides,
    spawned,
    migrations,
    shutdowns,
    unregistered,
    web,
    signal: (): void => {
      emitStop();
      resolveWait(0);
    },
    markStoppingOnly: (): void => emitStop(),
    done,
  };
}

describe("devPaths：坐标与缺省", () => {
  it("空 env ⇒ 默认库在项目自己的 .opc-os/ 下 + 默认端口对 + 现生成 token", () => {
    const p = devPaths({}, ROOT);
    if ("error" in p) throw new Error(p.error);
    expect(p.dbPath.replaceAll("\\", "/")).toBe(ROOT + "/.opc-os/dev.db");
    expect(p.hubPort).toBe(DEV_HUB_PORT);
    expect(p.webPort).toBe(DEV_WEB_PORT);
    expect(p.tokenGenerated).toBe(true);
    expect(p.token.length).toBeGreaterThanOrEqual(40);
  });

  it("给了 OPC_DEV_TOKEN ⇒ 不再生成（tokenGenerated=false），两侧共用同一个", () => {
    const p = devPaths({ OPC_DEV_TOKEN: "abc" }, ROOT);
    if ("error" in p) throw new Error(p.error);
    expect(p.token).toBe("abc");
    expect(p.tokenGenerated).toBe(false);
  });

  it("相对 OPC_DEV_DB 按仓库根绝对化（两个 cwd 不该迁出两个库）", () => {
    const p = devPaths({ OPC_DEV_DB: "data/x.db" }, ROOT);
    if ("error" in p) throw new Error(p.error);
    expect(p.dbPath.replaceAll("\\", "/")).toBe(ROOT + "/data/x.db");
  });

  it("端口填错 ⇒ 报人话而不是静默回落", () => {
    const bad = devPaths({ OPC_DEV_WEB_PORT: "0" }, ROOT);
    expect("error" in bad && bad.error).toContain("OPC_DEV_WEB_PORT");
    const bad2 = devPaths({ OPC_DEV_HUB_PORT: "99999" }, ROOT);
    expect("error" in bad2 && bad2.error).toContain("OPC_DEV_HUB_PORT");
  });

  it("仓库根从模块 URL 推：数出的是仓库根而不是 hub 包根", () => {
    const r = repoRootOf(
      "file:///D:/item/opc/packages/hub/src/serve/dev-entry.ts",
    )
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
    expect(r.endsWith("/opc")).toBe(true);
  });
});

describe("webSpawnArgs：命令行那一格", () => {
  it("用当前 node 解释器 + tsx 的 cli + web 的 dev-server，token 走 ORG_TOKEN", () => {
    const spec = webSpawnArgs(ROOT, {
      hubPort: 1234,
      webPort: 5678,
      token: "T",
    });
    expect(spec.command).toBe(process.execPath);
    const joined = spec.args.join("|").replaceAll("\\", "/");
    expect(joined).toContain("node_modules/tsx/dist/cli.mjs");
    expect(joined).toContain("packages/web/src/dev-server.ts");
    expect(spec.env).toEqual({
      HUB_PORT: "1234",
      WEB_PORT: "5678",
      ORG_TOKEN: "T",
    });
  });
});

describe("runDev：装配顺序与收尾", () => {
  it("迁移失败 ⇒ 不 boot、不起 web、退出码照抄", async () => {
    const h = harness({ migrateCode: 2 });
    const r = await h.done;
    expect(r.code).toBe(2);
    expect(h.migrations.length).toBe(1);
    expect(h.booted.length).toBe(0);
    expect(h.spawned.length).toBe(0);
    expect(h.warns.join("\n")).toContain("迁移失败");
  });

  it("boot 失败 ⇒ 不起 web（不留半个进程树）", async () => {
    const h = harness({
      boot: async () => ({ ok: false, code: 4, message: "库文件不存在" }),
    });
    const r = await h.done;
    expect(r.code).toBe(4);
    expect(h.spawned.length).toBe(0);
    expect(h.warns.join("\n")).toContain("库文件不存在");
  });

  it("boot 拿到的是 dev 的三件配置：默认库、noBackup、token 走 overrides 而不是 argv", async () => {
    const h = harness();
    h.web.fireExit(0);
    await h.done;
    expect(h.booted[0]).toEqual({
      dbPath: ROOT + "/.opc-os/dev.db",
      port: DEV_HUB_PORT,
      noBackup: true,
    });
    expect(h.bootOverrides[0]?.["token"]).toBe("tok-来自-环境变量");
  });

  it("横幅报两个可点地址；token 是【环境变量给的】时不当场打印", async () => {
    const h = harness();
    h.web.fireExit(0);
    await h.done;
    const all = h.logs.join("\n");
    expect(all).toContain("http://127.0.0.1:" + DEV_WEB_PORT);
    expect(all).toContain("http://127.0.0.1:" + DEV_HUB_PORT);
    expect(all).not.toContain("直连 token");
  });

  it("token 是本次生成的 ⇒ 打出来并写明即失效（绕开代理直连才用得上）", async () => {
    const logs: string[] = [];
    const io: ServeIo = { log: (m) => logs.push(m), warn: () => {} };
    const web = fakeWeb();
    const p: ResolvedDevPaths = {
      dbPath: "/tmp/dev.db",
      hubPort: DEV_HUB_PORT,
      webPort: DEV_WEB_PORT,
      token: "GEN-abc",
      tokenGenerated: true,
    };
    // 横幅在 spawn 之后同步打，而退出由这一发的 exit 事件驱动 —— 下一宏任务发，
    // 保证「先打完横幅再退」的次序与真进程一致。
    setTimeout(() => web.fireExit(0), 0);
    const r = await runDev(
      p,
      {
        io,
        bootHub: async () => fakeBootOk(),
        spawnWeb: () => web.child,
        runMigrate: () => ({ code: 0 }),
        waitStop: () => new Promise<number>(() => {}),
      },
      ROOT,
    );
    expect(r.code).toBe(EXIT_CHILD_GONE);
    expect(logs.join("\n")).toContain("GEN-abc");
  });

  it("web 先退 ⇒ 退出码是 CHILD_GONE，Hub 的 shutdown 照跑（不留库锁）", async () => {
    const h = harness();
    h.web.fireExit(1);
    const r = await h.done;
    expect(r.code).toBe(EXIT_CHILD_GONE);
    expect(h.shutdowns.v).toBe(1);
    expect(h.warns.join("\n")).toContain("先退出");
  });

  it("web 起不来（error 事件）⇒ 同一条停止路径", async () => {
    const ee = new EventEmitter();
    const child = {
      killed: false,
      kill: () => true,
      once: ee.once.bind(ee),
      on: ee.on.bind(ee),
    } as unknown as ChildProcess;
    const logs: string[] = [];
    const warns: string[] = [];
    const r = await runDev(
      {
        dbPath: "/tmp/d.db",
        hubPort: 1,
        webPort: 2,
        token: "t",
        tokenGenerated: false,
      },
      {
        io: { log: (m) => logs.push(m), warn: (m) => warns.push(m) },
        bootHub: async () => fakeBootOk(),
        spawnWeb: () => {
          // 下一个宏任务再报 error：真 spawn 的 ENOENT 就是这样异步来的。
          setTimeout(() => ee.emit("error", new Error("ENOENT tsx")), 0);
          return child;
        },
        runMigrate: () => ({ code: 0 }),
        waitStop: () => new Promise<number>(() => {}),
      },
      ROOT,
    );
    expect(r.code).toBe(EXIT_CHILD_GONE);
    expect(warns.join("\n")).toContain("ENOENT");
  });

  it("收到停止信号那条路：web 被 kill、Hub shutdown、且【不】报「先退出了」", async () => {
    // ⚠ 这一发挂过 180 秒，成因记在这儿：第一版给 harness() 传了一个自定义
    // waitStop 去抓 resolve —— harness 的 opts 里【没有】这个键，它内部自带
    // waitStop/onStopSignals（落地时机归 signal() 管），多余的字面量键被静默丢掉
    //（test/ 整棵不在 tsc 射程里，0007 §5 ⇒ 多余键不报 TS2353）。抓 resolve 的
    // 闭包因此永远不被调用，stop() 打到默认空函数，信号丢了，runDev 不返回。
    // 正道是 h.signal()：先立「正在停止」标记再让停止等待落地，与真 Ctrl-C 同序。
    const h = harness();
    // 仍要等 runDev 走到 onStopSignals/waitStop 那两发（boot 之后才注册）；
    // 早按的话 signal() 的两个默认空函数会把这一发吞掉 —— 又是挂死。
    await new Promise((r) => setTimeout(r, 0));
    h.signal();
    const r = await h.done;
    expect(r.code).toBe(0);
    expect(h.web.kills()).toBe(1);
    expect(h.shutdowns.v).toBe(1);
    // 收尾必须注销信号监听：不注销的话一次 dev 重启多一颗监听（MaxListeners 族）。
    expect(h.unregistered.v).toBe(1);
    // 这一发是本文件最该有的一条：正常收尾也走 web.kill()，
    // 少了 stoppingEarly 那格，下面这条断言就红。
    expect(h.warns.join("\n")).not.toContain("先退出");
  });
});
