/**
 * `pnpm dev` 的进程入口（docs/OPC-OS-功能优化设计.md O13 动作 1）。
 *
 * ── 这条命令存在的理由 ────────────────────────────────────────────
 * 在那之前，把界面拉到「能点」需要记住 2 条命令 + 3 个 flag + 一次人肉复制 token，
 * 而 O13 的原文判断是：这样的项目在非作者机器上采用率是 0。
 * 现在是一条命令：迁移 → Hub（进程内 boot）→ 签名代理 dev-server（子进程）→ 打印入口。
 *
 * ── 与 `pnpm hub:serve` 的三处刻意不同，逐条说清 ──────────────────
 * ① 库位置有默认值 `.opc-os/dev.db`。
 *    hub:serve 刻意不猜默认库路径（配置系统未落地，见 config.ts 文件头），这条纪律
 *    对【生产】成立。dev 的库是一次性演示数据，写在项目自己的 `.opc-os/` 下，
 *    而那一格【已经】被 .gitignore 挡着（「运行时产物与凭据」那一条）——
 *    默认值不是隐式路径，是仓库自己声明过的运行时目录。
 * ② 不做【心跳每日】备份（noBackup）。
 *    库是可扔的演示数据；`--no-backup` 在 hub:serve 里是「显式决定」，
 *    在这里是【这条命令的定义】：dev 库进备份目录只会污染真备份的读数。
 *    ⚠ 这一条不覆盖【组织提交前】那一发快照（BootOverrides.orgBackupDir）——
 *    那是 §6.5 对「改组织」单独要求的一份回退点，与每日轮转是两件事；
 *    缺了它拖拽改汇报关系只能拿 501。
 * ③ token 从 `OPC_DEV_TOKEN` 取，缺省当场生成一个。
 *    hub:serve 打印 token 让人复制给 dev-server（ORG_TOKEN）。那条人肉搬运
 *    在一条命令里不该保留：两侧从【同一个来源】拿，复制这一步整个消失。
 *    token 不落盘 —— 与 hub:serve 同一条纪律；进程一停它就没了。
 *
 * ⚠ 这条入口【不打开】任何花钱或对外暴露的东西：charter 泵 / 驱动器 / --bind
 *   都不接。它们「没有 env 缺省源」的立场（config.ts）在这里以「根本不透传」兑现。
 *
 * 结构照 hub-serve.ts 的口径：可判定的一切抽成纯函数（devPaths / webSpawnArgs /
 * runDev），入口块只回答「这次是被直接执行吗」；被 import 时零副作用。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliIo, runCli } from "../db/migrate-cli.js";
import { EXIT_PROBLEM, EXIT_USAGE } from "../heartbeat/maintenance.js";
import { newLocalToken } from "../http/auth.js";
import { isDirectRun } from "../internal/direct-run.js";
import {
  type BootOverrides,
  type BootResult,
  boot,
  type ServeIo,
  waitForShutdown,
} from "./assemble.js";
import type { ServeArgs } from "./config.js";

/** dev 的默认端口对：与 packages/web/src/dev-server.ts 的缺省一致（8787 / 9797）。 */
export const DEV_HUB_PORT = 8787;
export const DEV_WEB_PORT = 9797;

/** web 子进程先退那条支路的退出码：与「收到信号正常停」区分开，脚本能判。 */
export const EXIT_CHILD_GONE = 3;

/** 解析一个端口 env：非法 ⇒ 报错而不是静默回落（打错一个数字换来一次端口漂移最难查）。 */
function portFromEnv(
  raw: string | undefined,
  name: string,
): { readonly port: number } | { readonly error: string } {
  if (raw === undefined || raw.trim() === "") return { port: Number.NaN };
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    return { error: name + " 必须是 1..65535 的整数，拿到的是 " + raw };
  }
  return { port: n };
}

export interface ResolvedDevPaths {
  readonly dbPath: string;
  readonly hubPort: number;
  readonly webPort: number;
  readonly token: string;
  /** token 是这次【生成】的还是 env 给的。横幅要说清，见 runDev。 */
  readonly tokenGenerated: boolean;
  /**
   * 组织提交（拖拽改汇报关系）之前的快照目录。
   *
   * 为什么 dev 也要有一份：没有它 ⇒ `HubDeps.commitOrgChange` 不装配 ⇒
   * POST /org 回 501「本装配未接组织提交」。那条 501 在生产的说法是对的
   * （没配备份目录就不给改组织），但把它留在演示环境里的效果是「拖拽这个功能
   * 看着在、点提交就死」，而这正是 O13 要避免的「看起来能跑」。
   * 目录落在 `.opc-os/` 下 —— 与 dev.db 同一条纪律：仓库自己声明过的运行时目录，
   * 已被 .gitignore 挡着，扔得掉。
   */
  readonly orgBackupDir: string;
}

/**
 * 从 env + 仓库根算出这次 dev 的全部坐标。纯函数：env 注入，不碰 process。
 * 返回 error 而不是抛 —— 与 parseServeArgs 同一口径（用法错误是人话，不是堆栈）。
 */
export function devPaths(
  env: NodeJS.ProcessEnv,
  rootDir: string,
): ResolvedDevPaths | { readonly error: string } {
  const hub = portFromEnv(env["OPC_DEV_HUB_PORT"], "OPC_DEV_HUB_PORT");
  if ("error" in hub) return hub;
  const web = portFromEnv(env["OPC_DEV_WEB_PORT"], "OPC_DEV_WEB_PORT");
  if ("error" in web) return web;
  const dbEnv = env["OPC_DEV_DB"]?.trim();
  // 相对路径绝对化：与 migrate-cli.parseArgs 同一条（同一句命令在两个 cwd 下
  // 不该迁出两个库）。
  const dbPath =
    dbEnv === undefined || dbEnv === ""
      ? join(rootDir, ".opc-os", "dev.db")
      : isAbsolute(dbEnv)
        ? dbEnv
        : resolve(rootDir, dbEnv);
  const tokenEnv = env["OPC_DEV_TOKEN"] ?? "";
  const backupEnv = env["OPC_DEV_BACKUP_DIR"]?.trim();
  return {
    dbPath,
    hubPort: Number.isNaN(hub.port) ? DEV_HUB_PORT : hub.port,
    webPort: Number.isNaN(web.port) ? DEV_WEB_PORT : web.port,
    token: tokenEnv === "" ? newLocalToken() : tokenEnv,
    tokenGenerated: tokenEnv === "",
    orgBackupDir:
      backupEnv === undefined || backupEnv === ""
        ? join(rootDir, ".opc-os", "backups")
        : isAbsolute(backupEnv)
          ? backupEnv
          : resolve(rootDir, backupEnv),
  };
}

export interface WebSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/**
 * 起 web 签名代理的子进程参数。抽出来的理由与 serveBannerOf 同一条：
 * 「拼出来的命令行」是本入口最容易坏的一格（改一个路径字符串不会崩，只会 404）。
 *
 * 为什么用 `process.execPath` + tsx 的 cli 而不是 `pnpm exec tsx`：
 * Windows 上 pnpm/npx 都是 .cmd，不经过 shell 就 spawn 不动（ENOENT 的经典形状），
 * 而 execPath 就是当前这个正跑着本文件的 node —— 与 `pnpm hub:serve` 同一个解释器。
 */
export function webSpawnArgs(
  rootDir: string,
  p: Pick<ResolvedDevPaths, "hubPort" | "webPort" | "token">,
): WebSpawnSpec {
  return {
    command: process.execPath,
    args: [
      join(rootDir, "node_modules", "tsx", "dist", "cli.mjs"),
      join(rootDir, "packages", "web", "src", "dev-server.ts"),
    ],
    env: {
      HUB_PORT: String(p.hubPort),
      WEB_PORT: String(p.webPort),
      ORG_TOKEN: p.token,
    },
  };
}

/**
 * runDev 的依赖注入面。测试把 boot/spawn/migrate 换成假的，判的是【装配顺序】
 * —— 与 assemble.ts 的 BootOverrides 同一条分工：注入点换的是整发调用，不是结论。
 */
export interface DevDeps {
  io: ServeIo;
  bootHub: (
    args: ServeArgs,
    io: ServeIo,
    o: BootOverrides,
  ) => Promise<BootResult>;
  spawnWeb: (spec: WebSpawnSpec) => ChildProcess;
  /** 迁移走 migrate-cli 的 runCli（复用它的输出与退出码，不抄第二份逻辑）。 */
  runMigrate: (argv: readonly string[], io: CliIo) => { code: number };
  /**
   * 备份目录的创建口。默认 mkdirSync(recursive)。
   * 注入它是因为 runDev 在测试里不落盘（同一发 mkdir 在 CI 上会往仓库里写目录）。
   */
  ensureDir?: (dir: string) => void;
  /**
   * 「等到该停了」那一发。默认 waitForShutdown（真信号）。
   * 注入它而不是在测试里给自己发 SIGINT：那发信号会被同进程里其他用例留下的
   * 监听收到（waitForShutdown 注册不注销），与 assemble.ts 抽 serveBannerOf 时
   * 记过的是同一个理由。
   */
  waitStop?: (
    r: Extract<BootResult, { ok: true }>,
    io: ServeIo,
  ) => Promise<number>;
  /**
   * 停止信号的注册口（默认 process.on/removeListener 那一对照）。
   *
   * 为什么单独注这一个动作：runDev 需要【提前】知道「有人在按停止键」，才能不在
   * 子进程随后落地时打那句「端口被占」（见 stoppingEarly）。而测试要判这一格，
   * 按上面的同一条理由不能真给自己发信号 ⇒ 把【注册】交出来，测试用假发射器按。
   * 返回值是注销动作，runDev 在退出前一定调它。
   */
  onStopSignals?: (onStopping: () => void) => () => void;
}

/** DevDeps.onStopSignals 的默认实现：真信号，退出时注销（不注销会一次跑比上次多一颗监听）。 */
function defaultStopSignals(onStopping: () => void): () => void {
  process.on("SIGINT", onStopping);
  process.on("SIGTERM", onStopping);
  return (): void => {
    process.removeListener("SIGINT", onStopping);
    process.removeListener("SIGTERM", onStopping);
  };
}

/**
 * 一次 dev 的完整编排：迁移 → boot Hub → 起 web → 打横幅 → 等信号 → 两侧收尾。
 *
 * 三条装配期判据（都是本仓「静默失效」那一族的形状）：
 * ① 迁移失败 / boot 失败 ⇒ 不起 web、不留半个进程树；
 * ② 无论从哪一支退出，web 子进程【先】杀、Hub shutdown()【后】await —— 反过来的话
 *    代理会在 Hub 落锁退出前把请求打到正在关的进程上，界面看到一串 502
 *    而不是「已停止」；
 * ③ web 子进程自己先退 ⇒ 整个 dev 退 —— 「Hub 在跑而界面没了」正是 O13 要防的
 *    「看起来在跑」的形状。
 */
export async function runDev(
  p: ResolvedDevPaths,
  deps: DevDeps,
  rootDir: string,
): Promise<{ code: number }> {
  const { io } = deps;
  const mig = deps.runMigrate(["--db", p.dbPath], {
    write: (t) => io.log(t.trimEnd()),
    error: (t) => io.warn(t.trimEnd()),
  });
  if (mig.code !== 0) {
    io.warn("迁移失败 ⇒ dev 不启动（退出码 " + mig.code + "）");
    return { code: mig.code };
  }

  // 目录不存在 ⇒ 组织提交那份快照写不出来。mkdir 幂等，且必须【在 boot 之前】：
  // 备份目录是在装配期读一次的（assemble.ts 里 orgBackupDir 那一格），启动后再补
  // 就等于装配时判定「没备份」，501 照旧。
  deps.ensureDir ??
    ((dir) => mkdirSync(dir, { recursive: true }))(p.orgBackupDir);

  const r = await deps.bootHub(
    { dbPath: p.dbPath, port: p.hubPort, noBackup: true },
    io,
    { token: p.token, orgBackupDir: p.orgBackupDir },
  );
  if (!r.ok) {
    io.warn("Hub 启动失败：" + r.message);
    return { code: r.code };
  }

  const web = deps.spawnWeb(webSpawnArgs(rootDir, p));
  // 一条 exit 监听喂两个用途：race 用的「先退就要停」，与收尾用的「等它真没了」。
  // ⚠ stoppingEarly 这一格不是装饰：正常停止那条路也要走 web.kill() ⇒ 同一个 exit
  // 事件，若不打标记就会在【收到 Ctrl-C 正常收尾】时打出「子进程先退出了」。
  // 一句只在异常时才该说的话在正常路径上说了，下一次出事时没人信它 —— 与本仓
  // 「横幅在正常路径说谎」那一族（serveBannerOf 文件头）同形。
  let stoppingEarly = false;
  // 信号一到就把标记立起来，抢在子进程退出之前。
  // 为什么需要这一格：终端里 Ctrl-C 是发给【整个进程组】的 —— web 子进程和我们都收到，
  // 而它往往先落地。没有这个提前的标记，一次再正常不过的 Ctrl-C 会打出
  // 「web 子进程先退出了 ⇒ 常见原因是端口被占」，即【在正常路径上说一句只有异常时才该说的话】
  // （serveBannerOf 文件头记过同族：那种句子的代价是下一次真出事时没人信它）。
  // 只立标记、不做停止动作 —— 真正的停止仍然只由 waitForShutdown 那一处负责（两个停止点
  // 就会有两个「停到哪一步」的答案，正是本仓反复拆掉的那一族）。
  const markStopping = (): void => {
    stoppingEarly = true;
  };
  const stopListening = (deps.onStopSignals ?? defaultStopSignals)(
    markStopping,
  );
  let webGoneResolve: (code: number) => void = () => {};
  const webGone = new Promise<number>((res) => {
    webGoneResolve = res;
  });
  web.once("exit", (code: number | null) => {
    if (!stoppingEarly) {
      io.warn(
        "web 子进程先退出了（退出码 " +
          (code ?? "?") +
          "）⇒ dev 一并停止。\n" +
          "  常见原因是端口被占：" +
          p.webPort +
          " 上已有另一个 dev-server（OPC_DEV_WEB_PORT 可换）。",
      );
      webGoneResolve(EXIT_CHILD_GONE);
    } else {
      // 正常收尾时【谁赢 race 已定】，这里的值只是把 promise 落地，不参与退出码。
      webGoneResolve(0);
    }
  });
  web.on("error", (e: Error) => {
    io.warn("web 子进程出错：" + e.message);
    if (!stoppingEarly) webGoneResolve(EXIT_CHILD_GONE);
  });

  io.log(
    "dev 已就绪：\n" +
      "  · 看板      http://127.0.0.1:" +
      p.webPort +
      "\n" +
      "  · Hub API   http://127.0.0.1:" +
      p.hubPort +
      "（只绑回环）\n" +
      "  · 库        " +
      p.dbPath +
      "（dev 库，不做自动备份）",
  );
  if (p.tokenGenerated) {
    // 与 hub:serve 的 token 横幅同一纪律：不落库不落盘。多这一句是因为两侧代理
    // 已经配好，直接 pnpm dev 的人用不到它 —— 只有绕开代理直连 Hub 才需要。
    io.log("  · 直连 token（本次生成，进程退出即失效）：" + p.token);
  }

  const waitStop = deps.waitStop ?? waitForShutdown;
  const code = await Promise.race([waitStop(r, io), webGone]);
  stopListening();
  stoppingEarly = true;
  if (!web.killed) web.kill();
  await webGone.catch(() => EXIT_CHILD_GONE);
  await r.shutdown();
  return { code };
}

/**
 * 仓库根：本文件在 packages/hub/src/serve/ 下。
 * ⚠ resolve 的【第一个参数是文件】时它先剥掉文件名 ⇒ 向上四层到的是 packages/ 而不是根。
 * 这一格由用例钉着（写错不会崩，只会让 dev 在 packages/ 下建 .opc-os/）。
 */
export function repoRootOf(moduleUrl: string): string {
  return resolve(
    fileURLToPath(new URL(moduleUrl)),
    "..",
    "..",
    "..",
    "..",
    "..",
  );
}

/** tsx/dist/cli.mjs 在不在。缺它 ⇒ 没 pnpm i，给一句人话而不是 spawn ENOENT。 */
function tsxCliPresent(rootDir: string): boolean {
  return existsSync(join(rootDir, "node_modules", "tsx", "dist", "cli.mjs"));
}

/** 被直接执行时跑的那一段。单独成函数是为了入口块里只剩一行 await。 */
async function devMain(): Promise<void> {
  const rootDir = repoRootOf(import.meta.url);
  const io: ServeIo = {
    log: (m) => console.log(m),
    warn: (m) => console.warn(m),
  };
  const p = devPaths(process.env, rootDir);
  if ("error" in p) {
    io.warn(p.error);
    process.exitCode = EXIT_USAGE;
    return;
  }
  if (!tsxCliPresent(rootDir)) {
    io.warn(
      "缺 node_modules/tsx ⇒ 先跑 pnpm i（dev 用 tsx 起 web 侧的签名代理）。",
    );
    process.exitCode = EXIT_USAGE;
    return;
  }
  const { code } = await runDev(
    p,
    {
      io,
      bootHub: boot,
      spawnWeb: (spec) =>
        spawn(spec.command, [...spec.args], {
          cwd: rootDir,
          env: { ...process.env, ...spec.env },
          stdio: "inherit",
        }),
      runMigrate: runCli,
    },
    rootDir,
  );
  process.exitCode = code;
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await devMain().catch((e: unknown) => {
    // runDev 自己不兜意外（兜了就看不见真栈），入口块兜一次并给可判的退出码。
    console.warn(
      "dev 崩了：" + (e instanceof Error ? (e.stack ?? e.message) : String(e)),
    );
    process.exitCode = EXIT_PROBLEM;
  });
}
