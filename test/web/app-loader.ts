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
  "evidenceLine",
  "budgetHtml",
  "stat",
  "eventRow",
  "filterReplayEntries",
  "checkpointBlock",
  "hierarchyColumns",
  "groupByDepth",
  "statusClass",
  "driverNotice",
  "driverLine",
  "batchRequestBody",
  // round336：重渲染后的焦点落点。它是【纯的】—— 名单由调用方从 DOM 现读再传进来，
  // 函数自己不碰 document（碰 DOM 的那三个 anchorList / focusedAnchor / focusByAnchor
  // 【故意不列在这里】：替身元素没有 closest/isConnected，把它们捞出来只会得到
  // 一条"替身不像真 DOM"的红，而不是产品逻辑的红）。
  "focusTargetId",
  // 参数快照那一格（§9.2 第二行）。两个都是纯的：行函数只吃 parameters，
  // HTML 函数在它之上拼字符串 + esc，都不碰 fetch / DOM。取数那一层
  // （loadSnapshot / snapshotCache）【故意不列】：它整段是 fetch + isConnected。
  "paramSnapshotLines",
  "paramSnapshotHtml",
  // 审阅独立性那一格（O4）。纯的：只吃一个对象、拼字符串 + esc，不碰 fetch / DOM。
  // 取数那一层（renderOrg 里那一次 GET）【故意不列】：整段是 api() + DOM。
  "reviewIndependenceBand",
  // 一条委派边的 chip（round339）。纯的：吃一条边、拼字符串 + esc。
  "edgeChip",
  // round340：导航链接一枚（aria-current 只在当前视图那一枚上）与 Ctrl+Enter 判定。
  // 两个都是纯的：navLink 只吃视图对象与当前名拼串；isCtrlEnter 只读事件字段。
  "navLink",
  "isCtrlEnter",
  // round340：回放时间线那三处欠账的展示半（决策 0052，§16.7/§22.3）。全部纯的：
  //  replayHasMore —— 分页判据（这一页条数 vs 服务端 effective_limit）；
  //  replayNextOffset —— 翻页游标累加（offset + 本页实际条数，不吃过滤后那个数）；
  //  eventNoteText / eventOpinionHtml —— 事件行那条意见/理由原文的提取与 HTML 壳
  //    （review_decision 读 payload.note，approval 读 state_snapshot.note，沿库里的
  //    真生产者追出来的字段落点，见 app.js 函数头那段注释）；
  //  replayReportsToHtml —— 头卡汇报关系说明（读 graph.reports_to，纯拼字符串 + esc）。
  // 取数那一层（loadReplay 的 fetch、游标归零那几条监听）【故意不列】：碰 DOM/fetch。
  "replayHasMore",
  "replayNextOffset",
  "eventNoteText",
  "eventOpinionHtml",
  // round341：事件行 target（对什么做了什么）的纯文本格式半 + 回放头卡
  // checkpoints_unavailable 的降级提示。两个都是纯的（吃值拼字符串 + esc），
  // 不碰 fetch / DOM。eventRow 里内联的那处 target 渲染也走 eventTargetText。
  "eventTargetText",
  "checkpointDegradedNote",
  // round346：事件行「策略引擎自动批准」的标注（服务端发 {by,rule,annotation} 对象，
  // 早先前端拿 === true 比 ⇒ 对象恒不等于 true，标注从未上屏）。纯的：吃事件对象、
  // 拼字符串 + esc，不碰 fetch / DOM。eventRow 里那处标注与详情行都走 autoApprovedOf。
  "autoApprovedOf",
  // round346：回放时间线「中间缺行」的聚合提示（服务端 replay/query.ts 的 complete:
  // false ⇒ 界面应当渲染成看得见的缺口）。纯的：吃布尔、非缺口返回空串。
  "incompleteNote",
  // round341：§16.5 顶部策略摘要条那句（吃 t.decisions + navPending 拼字符串）。
  // 纯的：不碰 fetch / DOM。round341 补读了 human_decided_in_window。
  "strategyLine",
  "replayReportsToHtml",
  // 组织页查看/编辑模式（round340）：三个都是纯的 —— 默认模式（进页必是查看）、
  // 模式翻成「能不能拖」的布尔、模式翻成一行 HTML 文案，都不碰 fetch / DOM。
  // 取数那一层（renderOrg 里那一次 GET）与绑定层（bindOrgDrag）【故意不列】。
  "orgDefaultMode",
  "orgDragEnabled",
  "orgModeBand",
  // round342：审批卡已决明细（decided_at/by/note，contracts/api.ts:500-503）。
  // 纯的：只吃 approval 对象、拼字符串 + esc（时间走 fmtDate），不碰 fetch / DOM。
  "decidedMetaHtml",
  // round342：policy_shadow.note 的渲染半（query.ts:271 的「规则依据」真据）。
  // 纯的：只吃 note、拼字符串 + esc，不碰 fetch / DOM。
  "policyNoteHtml",
  // round342：policyShadowLine 本体也捞出来 —— 它是 function 声明纯函数
  // （吃 approval 对象拼字符串 + esc），且旧断言基线在别处，这里直接测接线。
  "policyShadowLine",
  // round342：evidence_refs 明细半（路径/sha256 逐条 `<code>` 展示）。
  // 纯的：只吃 refs、拼字符串 + esc，不碰 fetch / DOM。
  "evidenceRefsHtml",
  // round345：GET /today 的 memory 三数（0060 §8 补上的界面半 —— 原话「进响应而
  // desktop 侧还没渲染它们」）。纯的：吃 memory 对象拼字符串 + esc，不碰 fetch / DOM。
  // 取数那一层（getToday 里的 fetch）【故意不列】。
  "memoryBandHtml",
  // round350：五个【顶层纯函数】此前不在 EXPORTS —— 那意味着 app-pure.test.ts 里
  // 没有任何一条 it 直接测它们（只在消费它们的成员内部被间接执行到，改坏输出不会
  // 红）。五个都是纯的：只吃入参拼串 / 数组 join，不碰 fetch / DOM：
  //  fmtDate —— 毫秒 → 本地时间串（坏 ms / 0 / null ⇒ "—"）；5 处消费（抽屉详情、
  //   审批「读数于」「超时点」、已决明细、组织图「生效」）；
  //  fmtAgo —— 相对时间「N 秒/分钟/小时/天前」；2 处消费（任务卡「多久前」、
  //   审批「等了 X」）；
  //  windowLabel —— 窗口毫秒 → 「N 天/小时」标签（不写死 24，见 app.js:478 注释）；
  //   2 处消费（摘要条 + 预算条）；
  //  joinLines —— 数组 → 换行文本（非数组 ⇒ ""，这是它区别于裸 .join() 的判据）；
  //   9 处消费（岗位书多行 textarea）；
  //  linkText —— 投影连接状态 → 中文徽标（live/stale/down/connecting，未知 ⇒
  //   undefined 由调用方 esc 兜住）；2 处消费（今日页/看板顶部徽标）。
  "fmtDate",
  "fmtAgo",
  "windowLabel",
  "joinLines",
  "linkText",
  // round351：12 个【顶层纯函数】同样不在 EXPORTS —— 上一轮（round350）补的那五个
  // 只是顶层纯函数全集的一角。这次用【枚举 app.js 顶层函数 vs EXPORTS 白名单】的
  // 机械比对把全集补齐：esc / money / banner / notesHtml / ideaBox / decideRow /
  // batchPicked / rejectHtml / linesOf / enumSel / replayTimeline / safe。
  // 全部是纯的（只吃入参拼串 / 数组变换 / 格式化，不碰 fetch / DOM / 全局可变态），
  // 均为「有消费但无直接断言」形状：esc 144 次调用、banner 37、money 11、linesOf 11
  // 却没有任何 it 直接测它们 —— 改坏输出全绿（round347「48 覆盖」对它们同样成立）。
  "esc",
  "money",
  "banner",
  "notesHtml",
  "ideaBox",
  "decideRow",
  "batchPicked",
  "rejectHtml",
  "linesOf",
  "enumSel",
  "replayTimeline",
  "safe",
  // round352：今日页窗口选择（服务端 ?window_ms= 的前端接线半，见 app.js:505）。
  // 两个都是纯的：todayWindows 无参返回窗口清单（首项 24h 不带参数，另两项 7/30 天）；
  // windowMsOfHash 从 hash 的 ?window= 解析出毫秒（7d/7天/7 三种写法，非法 ⇒ undefined）。
  // 不碰 fetch / DOM；取数那一层（getToday 的 /today?window_ms=N）【故意不列】。
  "todayWindows",
  "windowMsOfHash",
  // round352：getToday 的缓存命中判据（function 声明，见 app.js:…）。纯的：
  // force ⇒ 恒 miss；无窗口只命中默认缓存；有窗口只命中 windowMs 完全相同的
  // 那一份（7 天与 30 天互不命中）。fetch 那一层（getToday 本体）【故意不列】。
  "todayCacheHit",
] as const;

export type AppExports = Record<
  (typeof EXPORTS)[number],
  (...a: never[]) => unknown
>;

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
    throw new Error(
      "app.js 里还有没剥掉的 import ⇒ 装载器的替身不可信，这条测试现在是假的",
    );
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
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
        body: null,
      }),
    EventSource: function ES(this: Record<string, unknown>) {
      this.addEventListener = noop;
      this.close = noop;
    },
    console,
    AbortController,
    URL,
    // round352：windowMsOfHash 用 URLSearchParams 解析 hash 的 ?window=。
    // 浏览器原生 API；vm context 是隔离的，不显式注入它就不存在（URL 同款）。
    // 语义替身 = Node 自己的实现，不是自定义 —— 自定义解析器才是第二个源。
    URLSearchParams,
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
  const withExports =
    body + "\n;globalThis.__ex = {" + EXPORTS.join(",") + "};";
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
