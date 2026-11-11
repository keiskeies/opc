/**
 * worker 线程里的**说明符解析**（0037）。
 *
 * ── 这个文件存在的唯一理由 ──────────────────────────────────────────
 * `integrity.worker.ts` 自 Task 6.2 起、`backup.worker.ts` 自 0036 起，
 * 入口里都有一行 `import { x } from "./兄弟.js"`。**这一行在 worker 线程里解析不了**：
 *  - `node --experimental-transform-types` 只剥类型，**不改写说明符**；
 *  - `tsx`（`pnpm hub:serve` 走的那条）把 loader 放进了 execArgv，worker 线程**确实**
 *    带着它（这一点我原先判断错了，见 0037 §1），但它的 loader 在**线程里不做**
 *    `.js → .ts` 映射。
 * 两种跑法下症状都是「入口加载起来了，然后死在第一行兄弟 import」。
 *
 * ── 为什么这个缺陷能活过 1712 发用例 ────────────────────────────────
 * 本仓跑测试是 `node --experimental-transform-types --import <钩子>`，
 * 而那条 `--import` **在 process.execArgv 里**，worker 线程默认继承 execArgv
 * ⇒ 钩子在 worker 里也生效 ⇒ 仓里每一条「走 worker」的用例都在一个
 * **比产品环境更宽容**的环境里跑。它不是「用例写错了」，是**跑用例的那条命令**
 * 比跑产品的那条命令多给了一层能力。
 * ⇒ 所以本文件的重心不在断言写法，在**跑法**：③ 那一节起子进程，
 *   子进程的 execArgv 里**不许有 `--import`**（它自己会打出来，③ 第二条就断这个），
 *   于是线程那一侧的解析能力**只能**来自生产代码那一层入口包装（`wrappedWorkerUrl`）。
 *   在仓库常规那条命令下，这一节等于白跑 —— 它照样绿，而绿得不证明任何事。
 *
 * ⚠ 本文件第一版的判据挂在一个【错误的修法】上（把钩子递进 new Worker 的 execArgv），
 *    而那 21 发当时【全绿】。抓到那个错误的是本仓既有的 backup.test.ts ⑦。
 *    教训写在 worker-entry.ts 文件头，本文件 ① 第一条就是它的锁。
 *
 * ⚠ ③ 依赖 `node --experimental-transform-types` 能直接跑 `.ts` 入口。
 *    若这台机器 / 这个 Node 版本做不到，③ 会红在【子进程读不到 src】而不是
 *    【线程解析不了】—— 那两种红的形状不同（子进程连 BACKUP 那行都打不出来），
 *    别把它们读成同一个结论。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import {
  WORKER_RESOLVE_HOOK_URL,
  wrappedWorkerUrl,
} from "../../src/db/worker-entry.js";

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHILD = join(HUB, "test", "db", "fixtures", "worker-hook-child.mjs");
const TMP = fixtureTmp("worker-hook", import.meta.url);

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** `--import` 后面那面旗。③ 断子进程的 execArgv 里【不许有它】。 */
const INSTALLER_FLAG = "--import";

describe("① 交给 new Worker 的那第一个参数：入口外面那一层包装", () => {
  /*
   * ⚠ 这一节测的东西换过一次：第一版断的是「父线程把钩子塞进 new Worker({execArgv})」，
   * 那一版【是错的】，而且是被本仓既有用例抓出来的（backup.test.ts ⑦ 红 6 发 + 整文件挂死），
   * 不是被本文件抓出来的 —— 本文件那 21 发当时全绿。原因见 worker-entry.ts 文件头：
   * 显式传 execArgv 会触发一道【不传就没有的】校验，`node --test` 那条命令下父线程
   * 带着 28 条旗，其中若干对 worker 非法 ⇒ new Worker 当场抛，而抛出来的东西被
   * 两侧的 worker_unavailable 兜底分支咽掉。**所以这一节现在第一条就钉「不许碰 execArgv」**，
   * 防的是有人（包括未来的我）觉得「递 execArgv 更直接」而把它改回去。
   */
  const entry = new URL("file:///hub/src/db/integrity.worker.ts");
  const wrapper = wrappedWorkerUrl(entry);

  it("包装是 URL 对象，不是字符串", () => {
    /*
     * 实测踩过：`new Worker("data:text/javascript,…")` 抛 ERR_WORKER_PATH
     * （「must be an absolute path or a relative path starting with './' or '../'」），
     * 而字符串那份【读起来完全正常】。返回类型是 URL 在 tsc 层就挡住了，
     * 这一发挡的是「有人改成返回 string 并顺手改了类型」。
     */
    expect(wrapper).toBeInstanceOf(URL);
    expect(wrapper.protocol).toBe("data:");
  });

  it("包装里 register 的正是生产那份钩子，且 await import 的是传进来的那个入口", () => {
    const src = decodeURIComponent(wrapper.pathname);
    expect(src).toContain("register(" + JSON.stringify(WORKER_RESOLVE_HOOK_URL) + ")");
    expect(src).toContain("await import(" + JSON.stringify(entry.href) + ")");
    // 反向对照：换一个入口进来，包装里那个 URL 必须跟着变。
    // 没有这一发，`toContain` 可以靠「永远写死 integrity」蒙绿。
    const other = wrappedWorkerUrl(new URL("file:///hub/src/db/backup.worker.ts"));
    const otherSrc = decodeURIComponent(other.pathname);
    expect(otherSrc).toContain("backup.worker.ts");
    expect(otherSrc).not.toContain("integrity.worker.ts");
  });

  it("⭐ 两条调用点【都不许】给 new Worker 传 execArgv", () => {
    /*
     * 这一发是本节存在的理由，它防的就是我本篇犯的那个错。
     * 判据是【文本】的而不是行为的：行为层要复现它，得在 execArgv 里塞进一条
     * 对 worker 非法的旗，而那是【跑法】的属性（`--test` 下才有），
     * 写进行为断言就等于把本文件绑死在「必须用 node --test 跑」上。
     * ⚠ 走 readCode（剥注释）：本文件与 worker-entry.ts 的注释里全是「execArgv」这个词，
     *   0036 §2.1 那一格今天又撞第三次。
     */
    for (const file of ["src/db/integrity.ts", "src/db/backup.ts"]) {
      const text = readCode(join(HUB, file));
      const at = text.indexOf("new Worker(");
      expect(at, file + " 里找不到 new Worker(").toBeGreaterThan(-1);
      const call = text.slice(at, at + 400);
      expect(call, file + " 又给 new Worker 传 execArgv 了（0037：那条路会撞校验）").not.toContain(
        "execArgv",
      );
      expect(call).toContain("wrappedWorkerUrl(WORKER_URL)");
    }
  });

  it("⭐ 两个 worker 入口【自己】都不读 import.meta.url", () => {
    /*
     * 为什么这条必须存在：包装那一层让【入口这一个模块】的 import.meta.url 变成
     * `data:text/javascript,…` 而不是 `…/integrity.worker.ts`。
     * 拿不到文件路径【不抛、不红】—— 它就是一个值不对的字符串，
     * 而用它拼出来的东西（日志里的路径、推导出的兄弟文件）会安静地指向别处。
     * ⇒ 这是本篇修法【唯一】带进去的行为代价，所以它得有一条锁，而不是一句注释。
     *
     * ⚠ 射程是【入口文件本身】，不是【入口的模块图】。
     *   `backup.ts` 里有一处 import.meta.url（它自己的 WORKER_URL），那一处【不受影响】：
     *   每个模块的 import.meta 是【那个模块自己的】URL，包装只改它直接加载的那一个模块。
     *   而 backup.ts 那个 WORKER_URL 在 worker 里根本没人用（只有主线程 new Worker 用）。
     *   所以判据只能按【文件】划，不能按「入口能碰到的所有文件」划 ——
     *   后者会把一条不受影响的正常用法判红，那是 0033 §3 那条「更严的核对拒掉唯一正确的接法」。
     */
    const entries = listTs(join(HUB, "src")).filter((p) => p.endsWith(".worker.ts"));
    // 装配自检：扫不到入口 = 「零个入口」= 这条判据什么都看不见而照样绿
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const offenders = entries.filter((p) => readCode(p).includes("import.meta.url"));
    expect(
      offenders.map((p) => relative(HUB, p).replace(/\\/gu, "/")),
      "worker 入口里读了 import.meta.url —— 那里它【不是】文件路径而是包装那层 data: URL",
    ).toEqual([]);
  });

  it("全仓只有这两处 new Worker，且【没有任何地方】把钩子递进 execArgv", () => {
    const hits: string[] = [];
    const execArgvHits: string[] = [];
    for (const p of listTs(join(HUB, "src"))) {
      const code = readCode(p);
      const rel = relative(HUB, p).replace(/\\/gu, "/");
      if (code.includes("new Worker(")) hits.push(rel);
      if (code.includes("execArgv")) execArgvHits.push(rel);
    }
    // 装配自检：扫不到文件 = 「零处 new Worker」= 判据坏了伪装成不变量成立
    expect(listTs(join(HUB, "src")).length).toBeGreaterThanOrEqual(20);
    expect(hits.sort()).toEqual(["src/db/backup.ts", "src/db/integrity.ts"]);
    // 本篇改完之后，src 下【不该再有任何一处】提 execArgv（注释除外，所以走 readCode）。
    expect(execArgvHits, "还有一处在动 execArgv：" + execArgvHits.join(", ")).toEqual([]);
  });
});

describe("② 钩子本体：哪些说明符该改道（直接跑生产那份）", () => {
  /*
   * 这一节测的是【生产那份钩子】本身：WORKER_RESOLVE_HOOK_URL 是数据 URL，可以 import。
   * 为什么不照抄一份钩子来测：那测的是抄件，实现改了抄件不改就照样绿
   * （0036 §2.1「判据的特征照着旧代码写，而旧代码正是被搬走的东西」同一族）。
   */
  const dir = join(TMP, "pred");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "sibling.ts"), "export const S = 1;\n");

  type Hook = (
    specifier: string,
    context: { parentURL?: string },
    next: (s: string, c: unknown) => Promise<{ url: string }>,
  ) => Promise<{ url: string }>;

  let hook: Hook | null = null;
  async function getHook(): Promise<Hook> {
    if (hook === null) {
      const mod = (await import(WORKER_RESOLVE_HOOK_URL)) as { resolve: Hook };
      hook = mod.resolve;
    }
    return hook;
  }

  /** 喂一条说明符，回「有没有被改道」与结果 URL。 */
  async function callHook(
    specifier: string,
    parentUrl: string | undefined,
  ): Promise<{ url: string; mapped: boolean }> {
    const resolveHook = await getHook();
    let fell = false;
    const got = await resolveHook(specifier, { parentURL: parentUrl }, async (s) => {
      fell = true;
      return { url: "fell-through:" + s };
    });
    return { url: got.url, mapped: !fell };
  }

  it("装得起来（data: URL 真的能被 import，而不是只能被 --import）", async () => {
    const resolveHook = await getHook();
    expect(typeof resolveHook).toBe("function");
  });

  it("同目录真有 .ts 时改道过去", async () => {
    const parent = new URL("file://" + join(dir, "entry.ts")).href;
    const got = await callHook("./sibling.js", parent);
    expect(got.mapped).toBe(true);
    expect(got.url).toBe(new URL("file://" + join(dir, "sibling.ts")).href);
  });

  it("构建产物那一态【一条都不改道】（同目录只有 .js ⇒ 钩子透明）", async () => {
    /*
     * 这一发是「本篇那条钩子不影响 dist」的凭据。钩子要是改成无条件把 .js 换成 .ts，
     * 源码态照样绿（源码态本来就是 .ts 在那儿），而 dist 那一态会【找不到文件】，
     * 症状又是「worker 起不来」—— 两侧都有兜底分支，【不红】。
     *
     * ⚠ 为什么用【临时目录里造出来的 dist 形状】而不是真读 `dist/db/`：
     *   dist 被 gitignore（`vitest.config.ts` 的 globalSetup 就是为这件事存在的），
     *   所以「先读真 dist」等于给本仓添一条【没跑 tsc 就红】的用例 ——
     *   那是一条因环境而红的用例，而它防的东西与形状无关。
     *   这里造的是它的**判据相关形状**：同目录有一个真的 `.js` 而没有 `.ts`。
     * ⚠ 但「真 dist 那一态跑得通」这件事**不是本发证的**，它是一次手工读数：
     *   纯 `node`（execArgv 为空、无任何 loader）跑 `dist/db/` 里的生产入口，
     *   读到 BACKUP ran=true ok=true / PAGE ok via=worker（0037 §1 那张表）。
     *   那条读数【不能由仓库里的命令复算】，与 0036 §8.0 那三行同一处置。
     */
    writeFileSync(join(dir, "page-check.js"), "export const P = 1;\n");
    const parent = new URL("file://" + join(dir, "integrity.worker.js")).href;
    expect(existsSync(join(dir, "page-check.js"))).toBe(true);
    expect(existsSync(join(dir, "page-check.ts")), "这一发要的就是【没有 .ts 同级】那个形状").toBe(false);
    const got = await callHook("./page-check.js", parent);
    expect(got.mapped, "dist 那一态必须整个落回 next").toBe(false);
    expect(got.url).toBe("fell-through:./page-check.js");
  });

  it("五种不该动的情形：内置 / 已是 .ts / 无 parentURL / 父线程非 file: / 兄弟 .ts 不存在", async () => {
    const cases: readonly [string, string | undefined, string][] = [
      ["node:sqlite", "file://" + join(dir, "a.ts"), "内置模块"],
      ["./sibling.ts", "file://" + join(dir, "a.ts"), "已经是 .ts"],
      ["./sibling.js", undefined, "父线程没有 parentURL（入口那一跳）"],
      ["./sibling.js", "data:text/javascript,x", "父线程不是 file:"],
      ["./missing-sibling.js", "file://" + join(dir, "a.ts"), "同目录没有那个 .ts"],
    ];
    for (const [spec, parent, why] of cases) {
      const got = await callHook(spec, parent);
      expect(got.mapped, why).toBe(false);
    }
  });

  it("⭐ src 下【没有】同名 .js / .mjs 与 .ts 的配对", () => {
    /*
     * 钩子在同名配对出现时【优先 .ts】。src 下今天没有配对，所以那一维今天不成立；
     * 这一发不是给那个优先级背书，是**不许它出现**：一旦配对存在，
     * 「源码态读到的」与「产物态读到的」就是两个文件 —— 而本篇修的正是一类
     * 「两态指向不同东西」的洞（0036 §2 那条「不去猜扩展名」是同一条纪律）。
     * ⚠ poc 那四个 .mjs 不在此列（它们没有同名 .ts，且 poc 目录被 no-native-deps
     *   显式豁免；这里靠的是「配对」这个判据本身把它们排除，不是靠再列一份豁免名单）。
     */
    const pairs: string[] = [];
    for (const p of listTs(join(HUB, "src"))) {
      if (existsSync(p.replace(/\.ts$/u, ".js")) || existsSync(p.replace(/\.ts$/u, ".mjs"))) {
        pairs.push(relative(HUB, p).replace(/\\/gu, "/"));
      }
    }
    expect(pairs).toEqual([]);
  });

  it("反向对照：src 下真的有 ts 文件被扫到（否则上一条恒绿）", () => {
    // `toEqual([])` 在「扫到零个文件」时也是绿的 —— 那正是 0036 §2 记过的那个形状
    // （一条声称管全仓的断言，配一条什么都看不见的实现）。
    expect(listTs(join(HUB, "src")).length).toBeGreaterThanOrEqual(20);
  });
});

describe("③ ⭐ 真子进程：线程那一侧的解析能力只能来自生产代码", () => {
  /*
   * 见文件头。这一节是本篇唯一一条【不因 test runner 宽容而假绿】的用例，
   * 所以它先断【跑法本身没被污染】—— 有人给 spawn 加 --import
   * 就等于把整节退回「测 runner」，而那正是缺陷藏了这么久的机制。
   */
  let out = "";
  let err = "";
  let status: number | null = null;
  let ran = false;

  function run(): void {
    if (ran) return;
    ran = true;
    const env: Record<string, string | undefined> = { ...process.env };
    // ⚠ **必须摘掉 NODE_OPTIONS**。它是 execArgv 之外的【第二条】把钩子塞进 worker 的路：
    // 实测 `NODE_OPTIONS="--import <钩子>"` 之下，即使生产代码什么都不递，
    // worker 也照样起得来 ⇒ ③ 那两发【假绿】，而 execArgv 那一发【看不见它】
    // （NODE_OPTIONS 不进 execArgv）。这一格是本篇自己量出来的：
    // 我先用 NODE_OPTIONS 做过一次「父线程有钩子而生产代码没递」的对照，
    // 那次读数是全绿，差点据此判「生产代码那句 execArgv 无用」。
    // ⚠ 只在子进程里 `delete process.env.NODE_OPTIONS` 是【不够】的：
    //    Node 在启动时就把那份配置读进去了，运行时删挡不住 worker 继承（实测）。
    //    能摘的地方只有 spawn 这一层。
    delete env.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--experimental-transform-types", CHILD], {
      cwd: HUB,
      encoding: "utf8",
      timeout: 170_000,
      maxBuffer: 32 * 1024 * 1024,
      // 【不能整体替换 env】：剥 PATH 会让子进程起不来而原因在 spawn 层，
      // 测试消息里完全看不到（packages/hub/test/cli/smoke.test.ts 记过同一格）。
      // 所以是【只摘 NODE_OPTIONS 这一项】，不是重建一份 env。
      env,
    });
    status = r.status;
    out = r.stdout ?? "";
    err = r.stderr ?? "";
  }

  function line(prefix: string): string {
    run();
    return out.split("\n").find((l) => l.startsWith(prefix)) ?? "";
  }

  it("子进程跑通了", () => {
    run();
    expect(status, "子进程 stderr：\n" + err.slice(-2000) + "\nstdout：\n" + out).toBe(0);
  });

  it("⭐ 子进程的 execArgv 里【没有 --import】", () => {
    const argv = JSON.parse(line("EXECARGV ").slice("EXECARGV ".length)) as string[];
    expect(argv).not.toContain("--import");
    expect(argv).toContain("--experimental-transform-types");
  });

  it("⭐ 跑法没被 NODE_OPTIONS 污染（execArgv 之外的第二条通路）", () => {
    // 上面那一发只看得见 execArgv，而 NODE_OPTIONS 是【第二条】把钩子送进 worker 的路，
    // 它【不进 execArgv】⇒ 只断 execArgv 的判据在被污染的环境里会假绿。
    // 处置是【在 spawn 那一层摘掉它】（见 run()），于是这一节在任何环境下都算数；
    // 这一发断的是【摘这件事真落地了】：子进程报回来的必须是 null。
    expect(line("NODEOPTS ")).toBe("NODEOPTS null");
    // ⚠ 发起方带着 NODE_OPTIONS 时这一节【不红】—— 那不是放水：污染已经在 spawn 处
    //   被摘掉了，判据的有效性不再依赖环境干净。把它判红会让别人为了跑测试
    //   去改自己的 shell（0033 §3 那条「更严的核对拒掉唯一正确的接法」同一族：
    //   严错方向的环境判据只会逼人绕开门禁）。
  });

  it("反向对照：NODE_OPTIONS 那条读数【读得到东西】（否则上一条恒绿）", () => {
    // `NODEOPTS null` 在两种世界里都成立：① 摘干净了；② 这条读数通路根本是坏的
    // （子进程没打出来 / 前缀写错 / 那行被 stdout 缓冲吞了）。② 会让上一条退化成
    // 「找不到那一行 ⇒ 不等于 NODEOPTS null ⇒ 红」…… 而红是对的方向，
    // 所以真正的风险不是恒绿，是【红了却报「环境污染」而其实是通路坏了】——
    // 一句不对症的报错（0032 §0 那条）。这一发把它分开：带一个【无害的】值出去，
    // 必须原样读回来。用 --max-old-space-size 而不用 --import：
    // 后者会真的改变 worker 的解析能力，那就不再是「通路」的对照而是另一发实验。
    const sentinel = "--max-old-space-size=64";
    const env: Record<string, string | undefined> = { ...process.env, NODE_OPTIONS: sentinel };
    const r = spawnSync(process.execPath, ["--experimental-transform-types", CHILD], {
      cwd: HUB,
      encoding: "utf8",
      timeout: 170_000,
      maxBuffer: 32 * 1024 * 1024,
      env,
    });
    const got = (r.stdout ?? "")
      .split("\n")
      .find((l) => l.startsWith("NODEOPTS "));
    expect(got, "子进程没把 NODE_OPTIONS 报回来：\n" + (r.stderr ?? "").slice(-500)).toBe(
      "NODEOPTS " + JSON.stringify(sentinel),
    );
  });

  it("生产入口的备份在【线程】里真跑成了", () => {
    expect(line("BACKUP ")).toBe("BACKUP ran=true ok=true");
  });

  it("页面检查走 worker 且判 ok（⇒ 启动闸门不会因为「检查没跑成」拒绝启动）", () => {
    // 「拒绝启动=false」是本篇的落点：serve 的闸门读 page_integrity 那一格的 verdict，
    // 而 worker 死在第一行兄弟 import 时那一格是 violated（0037 §1 实测）。
    const l = line("PAGE ");
    expect(l).toContain("PAGE ok");
    expect(l).toContain("拒绝启动=false");
    expect(l).toContain("via=worker");
  });

  it("CANARY：不递那条钩子 ⇒【仍然】坏在兄弟模块解析不了", () => {
    // 它必须【坏】。哪天它绿了，说明 Node 自己开始在线程里做 .js → .ts 映射，
    // 那该动的是【删掉生产代码里那条钩子】而不是把这条放宽（0036 §7 同一条纪律）。
    const l = line("CANARY ");
    expect(l).toContain("THREW");
    expect(l).toContain("Cannot find module");
    expect(l).toContain("backup.js");
  });
});

/** src 下全部 .ts（跳过产物与依赖）。口径与 integrity.test.ts ⑦ 那份一致。 */
function listTs(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist" || e.name === ".tmp") continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 读源码并【剥掉注释】—— 0036 §2.1：给源码形状写守卫时，注释是判据的输入之一。 */
function readCode(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}
