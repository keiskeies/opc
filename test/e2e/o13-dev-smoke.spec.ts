/**
 * O13 §E 那条验收的「浏览器那一发」：`pnpm dev` 起的东西，用浏览器真建一个任务。
 *
 * ── 这一发为什么不是重复 ceo-loop.spec.ts ──────────────────────────
 * ceo-loop 起 Hub 走的是【编程口 boot(...)】—— 参数直接写进源码，绕开 devPaths、
 * 绕开迁移调用、绕开 webSpawnArgs、绕开横幅。而设计文档那条验收说的恰恰是
 * 「全新机器上 pnpm i && pnpm dev」这条【人走的命令】：文档 1523 行自己留了口子
 * （「dev-entry.test.ts 钉的是各阶段与失败出口，浏览器那一发今天仍要人眼」），
 * 这一发就是把「要人眼」收掉的那一发。两边各证各的：那边证 CEO 一圈的业务闭环，
 * 这边证那条人用的命令端到端可用。
 *
 * ── 唯一借用的注入：waitStop ───────────────────────────────────────
 * runDev 默认等 SIGINT/SIGTERM；子进程模式下父进程收不到可靠的信号投递
 * （Windows 上 Ctrl-C 是控制台信号，发给进程组，测试框架没有控制台）。
 * 所以父进程监听一条 IPC 消息、把它翻译成 waitStop 落地 —— 那格【本来就是注入点】
 * （DevDeps.waitStop，dev-entry.test.ts 用它钉停止顺序）。
 * spawn 的命令行、迁移、真 boot、web 子进程【全部走 runDev 的真默认装配】：
 * 注入的是「什么时候停」，不是「启什么」。
 *
 * ── 端口为什么随机、库为什么临时 ──────────────────────────────────
 * 开发机上 8787/9797 可能正被另一条 pnpm dev 占着（本机实测发生过）。runDev 的
 * 「web 先退 ⇒ dev 全停」会把那种占用变成一个和测试内容无关的红。随机端口 +
 * mkdtemp 库 = 这一发与别人的 dev 会话互不打扰，也留不下库。
 *
 * ── 断言吃的是哪一步 ─────────────────────────────────────────────
 * ① 打开 today ⇒ 中间栏七页清单渲染出真清单（模块没落地时那里是 listSkeleton，
 *    所以轮询到 h3 出现，不 sleep）；
 * ② 今日页「扔个想法」输入框可见；
 * ③ 点【提交】⇒ 确认条「已收到」—— 这一步走的是浏览器真点击 + 代理真转发
 *    （签名代理 dev-sign 与 Hub 鉴权两侧 token 不同源就 401，确认条永远等不来）；
 * ④ 看板出现这张卡（真读 GET /tasks，不是本地塞行）；
 * ⑤ 今日页重进 ⇒「活跃任务 1」（读数从 0 变 1，证明看板那条不是本地缓存）。
 * 页面若出现 pageerror / 请求失败 ⇒ 当场红（截图那一发只给人看，这一发给 CI 判）。
 *
 * ⚠ 不证的东西：token 两侧【不同源】时界面会不会报错 —— Hub 侧 401 在 dev-server
 * 里落成 JSON 错误体而不是请求失败，浏览器面怎么表现没测，登记见 0070 §别当成。
 */
import { type ChildProcess, fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const ROOT = resolve(process.cwd());

/** 随机可用端口：与 group-workbench.spec.ts 同一发探针（sleep 换端口比等可靠）。 */
async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((res, rej) => {
    probe.once("error", rej);
    probe.listen(0, "127.0.0.1", () => res());
  });
  const a = probe.address();
  if (a === null || typeof a === "string") throw new Error("探针未分到端口");
  const port = a.port;
  await new Promise<void>((res) => probe.close(() => res()));
  return port;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const IDEA = "O13 验收冒烟：pnpm dev 到看板可用这条链";

/**
 * 今日页统计卡读数（页侧探针用字符串 IIFE：types 含 node 时页内闭包全红的老坑）。
 * 数字与标签在两个兄弟 div 里（app.js 的 stat()），innerText 归一化后两者之间
 * 不一定剩一个空格 —— 首版 toContainText("0 活跃任务") 就红在这一格上。
 * 按【标签定位卡片、读同卡片数字】判，不靠拼串。
 */
const ACTIVE_STAT = `(() => {
  for (const c of document.querySelectorAll(".admin-stat")) {
    if ((c.querySelector(".admin-lbl")?.textContent ?? "").trim() === "活跃任务") {
      return (c.querySelector(".admin-num")?.textContent ?? "").trim();
    }
  }
  return "（没有活跃任务这张卡）";
})()`;

let dir = "";
let child: ChildProcess | null = null;
let webPort = 0;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "opc-o13-"));
  webPort = await availablePort();
  const hubPort = await availablePort();
  // 子进程跑真入口（不是复制它的装配）；OPC_DEV_DB 那三个 env 走 devPaths 的真解析
  // —— env 形状与人手敲 pnpm dev 时完全一致。
  // execArgv 用 `--import tsx` 而不是 `tsx cli.mjs 脚本`：后者会【再 spawn 一个孙进程】
  // 跑真正的代码，fork 的 IPC 通道就断在中间那一层（实测：stop 永远收不到，
  // afterAll 只能走 SIGKILL 兜底）。前者本进程直跑，本轮实测 IPC 一发到位。
  child = fork(join(HERE, "o13-dev-child.ts"), [], {
    cwd: ROOT,
    execPath: process.execPath,
    execArgv: ["--import", "tsx"],
    env: {
      ...process.env,
      O13_CHILD: "1",
      OPC_DEV_DB: join(dir, "dev.db"),
      OPC_DEV_HUB_PORT: String(hubPort),
      OPC_DEV_WEB_PORT: String(webPort),
      OPC_DEV_BACKUP_DIR: join(dir, "backups"),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  // 等代理真能答话（与 ceo-loop 同一条理由：端口探针判「没起来」，sleep 只掩 flaky）。
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${webPort}/`);
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* 还没听 */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  if (!ready) throw new Error("pnpm dev 的 web 代理 30s 内没有应答");
});

test.afterAll(async () => {
  // 先走 runDev 的正常停止路径（IPC ⇒ waitStop ⇒ kill web ⇒ hub.shutdown ⇒ 释放库锁），
  // 再等子进程真没了；3s 兜底才 SIGKILL —— 直接 kill 会留 -wal 与库锁。
  child?.send("stop");
  const gone = await Promise.race([
    new Promise<boolean>((res) => child?.once("exit", () => res(true))),
    new Promise<boolean>((res) => setTimeout(() => res(false), 3000)),
  ]);
  if (!gone) child?.kill("SIGKILL");
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("pnpm dev 到看板可用：浏览器建一个任务并在看板读到它", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("requestfailed", (r) =>
    problems.push(
      "requestfailed: " + r.url() + " " + (r.failure()?.errorText ?? ""),
    ),
  );

  // ① 浏览器打开 today
  const resp = await page.goto(`http://127.0.0.1:${webPort}/#/admin/today`, {
    waitUntil: "domcontentloaded",
  });
  expect(resp?.status()).toBe(200);
  // 七页清单在中间列表栏；模块落地前是骨架屏 ⇒ 轮询真清单。
  // 字符串形态：types 含 node 时页内闭包里的 document 不过 tsc（本仓老坑，
  // 页侧探针一律字符串 IIFE，见 ACTIVE_STAT 同一条口径）。
  await page.waitForFunction(
    `document.querySelectorAll("#listPane .doc-list-item h3").length >= 7`,
    undefined,
    { timeout: 20000 },
  );
  const pages = await page
    .locator("#listPane .doc-list-item h3")
    .allInnerTexts();
  expect(pages).toContain("任务看板");

  // ② 「扔个想法」可见，且此刻活跃任务是 0（临时库 ⇒ 空态是新机器口径的一部分）
  await page
    .locator("[data-idea]")
    .waitFor({ state: "visible", timeout: 20000 });
  const activeStat = async (): Promise<string> =>
    (await page.evaluate(ACTIVE_STAT)) as string;
  // 统计随 GET /overview/today 异步落地，先轮询到「有数字」再判值
  await expect
    .poll(activeStat, { timeout: 20000, message: "活跃任务读数没落地" })
    .toBe("0");

  // ③ 浏览器点【提交】。[data-create] 在工作台里有五枚（新建群/文档/会议/两类私聊），
  //    必须限定在 idea 卡内 —— 点到 menuitem 那枚会打开创建菜单，确认条永远不来。
  await page.locator("[data-idea]").fill(IDEA);
  await page.locator(".admin-idea [data-create]").click();
  await expect(page.locator("[data-idea-state]")).toContainText("已收到", {
    timeout: 20000,
  });

  // ④ 看板真读到这张卡（GET /tasks 经代理转发回 Hub）
  await page.goto(`http://127.0.0.1:${webPort}/#/admin/board`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator(".admin-board")
    .waitFor({ state: "visible", timeout: 20000 });
  await expect(page.locator(".admin-board")).toContainText(IDEA, {
    timeout: 20000,
  });
  await expect(page.locator(".admin-board")).toContainText("CHARTER_PENDING");

  // ⑤ 重进今日页 ⇒ 活跃任务从 0 变 1（读数跟着写路径走，不是本地塞行）
  await page.goto(`http://127.0.0.1:${webPort}/#/admin/today`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator(".admin-stats")
    .first()
    .waitFor({ state: "visible", timeout: 20000 });
  await expect
    .poll(activeStat, { timeout: 20000, message: "活跃任务没跟着写路径变 1" })
    .toBe("1");

  expect(problems).toEqual([]);
});
