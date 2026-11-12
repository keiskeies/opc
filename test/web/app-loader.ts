/**
 * 把 `packages/web/public/app.js` 的**纯函数**在 node 里真跑起来的装载器。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 * app.js 是浏览器 ES 模块，顶部就 `document.getElementById("view")`，
 * 在 node 里 `import` 它当场抛。本轮之前，渲块那 900 行的**执行证据是零**：
 * `test/web/renderer-criteria.test.ts` 只能扫源码，证明的是"判据没落在渲块里"，
 * **不是**"那些函数算得对"（0042 §11 第一条就是这个口径）。
 *
 * ── 做法与它的边界 ──────────────────────────────────────────────
 * ① 剥掉文件头那两行 `import`（projection.ts 与 contracts —— 两者各自已有测试文件，
 *    这里给同名替身）。剥完**必须验证没剩 import**，否则"替身没生效"会静默通过。
 * ② 整段丢进 `node:vm` 当**经典脚本**跑，DOM 用替身元素喂掉。
 * ③ 只取**纯函数**（输入 → HTML 字符串 / 数 / 数组）。凡是碰 fetch、碰 DOM 的
 *    渲染入口（renderToday / renderBoard…）**不在射程内** —— 那需要真 DOM，
 *    本机没有（Electron / 打包器装不上，0039）。
 *
 * ⚠ 三条必须知道的坑（都是本轮实测撞出来的）：
 *  · **顶层会抛**：app.js 底部有 `nav()` / `load()` 这类真调用。抛了**没关系** ——
 *    函数声明在脚本开始执行前就提升到 context 上了，所以照样能调。
 *    装载器把顶层异常交回调用方（`topError`），**故意不当成功、也不当失败**。
 *  · **`setTimeout` 必须是空操作**：app.js 那条 SSE 重连循环保的是真定时器的话，
 *    它会一直续订，node 事件循环永不退出（实测把测试进程挂死过一次）。
 *  · **`const` 箭头函数不挂 globalThis**：vm 里经典脚本的顶层 `const`/`let`
 *    落在脚本词法作用域（只有 `function` 声明挂得上）。所以装载器补一行
 *    `globalThis.__ex = {...}` 把它们捞出来 —— 这是**宿主的机制**，
 *    不是 app.js 的形状问题，别把它读成"那些函数是全局的"。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

/** 想从 app.js 里取出来的名字。加一个就得同时确认它【是纯函数】。 */
const EXPORTS = [
  "meterPct",
  "overBudget",
  "blockedTitle",
  "taskCard",
  "approvalCard",
  "budgetHtml",
  "stat",
  "eventRow",
  "hierarchyColumns",
  "groupByDepth",
  "statusClass",
  "driverNotice",
  "driverLine",
] as const;

export type AppExports = Record<(typeof EXPORTS)[number], (...a: never[]) => unknown>;

export type LoadedApp = {
  /** 取出来的纯函数。 */
  readonly fns: AppExports;
  /** 顶层执行到哪一步抛的（**不是**测试失败信号，见文件头）。 */
  readonly topError: Error | null;
  /** 被访问过的替身元素（调试用）。 */
  readonly els: Map<string, unknown>;
};

export function loadAppJs(appJsPath: string): LoadedApp {
  const src = readFileSync(appJsPath, "utf8");
  // 只剥**顶层** import 语句（本文件里它们都在最前面，形如 import {...} from "...";）。
  const body = src.replace(/^\s*import[\s\S]*?from\s+"[^"]*";\s*$/gmu, "");
  if (/^\s*import\s/mu.test(body)) {
    throw new Error("app.js 里还有没剥掉的 import ⇒ 装载器的替身不可信，这条测试现在是假的");
  }
  const els = new Map<string, unknown>();
  const el = (id: string): Record<string, unknown> => {
    if (!els.has(id)) {
      els.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        value: "",
        style: {},
        dataset: {},
        addEventListener: () => {},
        querySelectorAll: () => [],
        querySelector: () => null,
        scrollIntoView: () => {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {} },
      });
    }
    return els.get(id) as Record<string, unknown>;
  };
  const noop = () => {};
  const ctx: Record<string, unknown> = {
    document: {
      getElementById: el,
      createElement: (tag: string) => el("created-" + tag + "-" + els.size),
      addEventListener: noop,
      body: el("body"),
    },
    window: { addEventListener: noop, location: { hash: "#/today" } },
    location: { hash: "#/today" },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: async () => ({}), body: null }),
    EventSource: function ES(this: Record<string, unknown>) {
      this.addEventListener = noop;
      this.close = noop;
    },
    console,
    AbortController,
    URL,
    Intl,
    setTimeout: () => 0,
    clearTimeout: noop,
    setInterval: () => 0,
    clearInterval: noop,
    // 那两行 import 的替身。真实实现各自有测试：
    //   projection.ts ⇒ test/web/hub-projection.test.ts
    //   contracts     ⇒ test/contracts/*
    emptyProjection: () => ({
      cursor: 0,
      tasks: new Map(),
      inbox: { pendingTotal: null, trusted: true },
      link: "up",
    }),
    applyFrame: (p: unknown) => p,
    applySnapshot: (p: unknown) => p,
    decodeSseFrame: () => null,
    reconnectDelayMs: () => 1000,
    shouldGiveUp: () => false,
  };
  ctx["globalThis"] = ctx;
  vm.createContext(ctx);
  const withExports = body + "\n;globalThis.__ex = {" + EXPORTS.join(",") + "};";
  let topError: Error | null = null;
  try {
    vm.runInContext(withExports, ctx, { filename: "app.js" });
  } catch (e) {
    topError = e instanceof Error ? e : new Error(String(e));
  }
  const ex = ctx["__ex"] as Partial<AppExports> | undefined;
  const missing = EXPORTS.filter((n) => typeof ex?.[n] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `app.js 里取不到这些函数 ${JSON.stringify(missing)}（顶层抛在这里：` +
        `${topError?.message ?? "无"}）⇒ 要么函数被改名/删了，要么装载器的剥 import 把它带走了`,
    );
  }
  return { fns: ex as AppExports, topError, els };
}
