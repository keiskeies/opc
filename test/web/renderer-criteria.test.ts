/**
 * 渲块侧的两条纪律（§16 呈现层）。
 *
 * 为什么这个文件是【扫源码】而不是【跑函数】：
 * `packages/web/public/app.js` 是浏览器 ES 模块，顶部就 `document.getElementById("view")`，
 * 在 node 里 import 它会当场抛（没有 DOM），而为了可测去把那一行包进 init() 里 ——
 * 是把一个已经跑通的入口改形成"能被测试导入"，那是测试的形状在反过来改产品。
 * 所以这一文件守的是【源码级】不变量：不是"函数算得对"，是"这段代码里没有出现判据"。
 *
 * ⚠ 这诚实的范围要说清：源码扫描【证明不了】app.js 算得对，只证明它没有自己下判据。
 * app.js 那部分逻辑今天没有任何执行证据（0042 §11 第一条：Electron / 打包器装不上，
 * 没有浏览器里跑过一次的证据）。这一发补的是【抄件】那一半，不是【正确性】那一半。
 *
 * ── 守的两条 ────────────────────────────────────────────────────
 * ① 判据不落在渲块里（§1 那条立场的【唯一】守卫）：
 *    任务状态名、审批类型名不许作为字面量出现在 app.js 的【代码】里 ——
 *    它们必须从 /today 响应里读。
 *    这一条以前【一条断言都没有】：0042 §1 整节讲的「判据随响应发出」，
 *    在 hub 侧有变异测试，在 web 侧全靠 app.js 里那句注释 + 人的自觉。
 *    而"抄件的漂移没有任何测试能看见"正是那一节自己写的论点 —— 论点本身没被测。
 * ② 琥珀色的落点名单（§19.2「全局仅用于需要 CEO 决策」）：
 *    CSS 里 `var(--amber)` 出现在哪些选择器里，逐字钉住。
 *    这一条是被本轮的一次真实违反逼出来的：我第一版让「需要我注意」那一列
 *    全体成员标琥珀，于是预算暂停的卡也琥珀了，而 §7.4 明写它非琥珀。
 *    颜色这种事 code review 看不见（它只在屏幕上存在），而屏幕上今天没有浏览器。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APPROVAL_TYPES } from "../../packages/hub/src/approvals/cards.js";
import { TASK_STATES } from "../../packages/hub/src/graph/status.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const APP_JS = join(REPO, "packages/web/public/app.js");
const INDEX_HTML = join(REPO, "packages/web/public/index.html");

const appSrc = readFileSync(APP_JS, "utf8");
const htmlSrc = readFileSync(INDEX_HTML, "utf8");

/**
 * 剥掉注释。这一刀决定这个文件是守卫还是装饰：
 * app.js 里【大量】出现 "BUDGET_PAUSED"「非琥珀色」这些词 —— 全在注释里，
 * 而且正是那些注释在解释为什么不许写它们。不剥注释 ⇒ 恒红 ⇒ 下一个人第一件事
 * 是给它加豁免，那条守卫就死了。
 *
 * ⚠ 只做整行 `//` 与 `/* *\/` 块两种（本仓的写法）。字符串里出现 `//` 的情况
 * 在本文件里只有一处（`http://` 之类），而它不在被扫的那些字面量里 ——
 * 真要出现误剥，症状是"某条本该出现的判据没被扫到"（漏报方向），
 * 所以下面另有一发【正向对照】专门测这个剥离函数有没有把代码一起吃掉。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//u.test(l))
    .join("\n");
}

const appCode = stripComments(appSrc);

/** 把 CSS 的块注释剥掉，并顺手把 html 里的 <!-- --> 也剥掉。 */
function stripCssComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/<!--[\s\S]*?-->/gu, "");
}

/**
 * 按【花括号配平】取一个函数自己的函数体，不是"从函数名往后数 N 个字符"。
 *
 * ⚠ 为什么要有这么个东西（origin：④ 那一节）：第一版照抄上面 driverLine 那一条的写法
 * （`slice(at, at + 900)`），实跑【两红】—— 参数快照那两个函数【很短】，
 * 900 字符早就越过右花括号进到下一个 approvalCard 里去了，而那里合法地带着
 * `style="margin-top:8px"`。于是 `not.toContain("style=")` 报的是一条【不存在】的违规。
 * driverLine 那一条数 1600 是够的（它本身长），但"够不够"取决于被扫函数的长度 ——
 * 一个会随隔壁函数变长而变红的守卫，下一个人第一件事是把阈值调大，
 * 那条守卫就死了。所以改成配平取体。
 *
 * ⚠ 它在【模块作用域】而不是某个 describe 里面：④、⑤、⑥ 三节都用它。放在 ④ 里面
 * 而别人再抄一份，就得到两份会漂的取体器 —— 而漂了的那一份的症状恰好是本文件
 * 整篇在防的那一种：扫不到东西，于是"通过"。
 * ⚠ 这一行原来写的是「④ 与 ⑦ 两节」—— 那个 ⑦【从来没有存在过】：HEAD 里这篇只有
 * ①②【两个小节】（文内另有一处 ⑤ 是指向 driver-status.ts 那张清单的第 5 条，
 * 不是本篇的小节），到 round339 之前工作区已经把它加成 ①…⑤ 五节，⑥ 是本轮加的。
 * 编号写在注释里而没有任何守卫核它，与 0062 §6 那条「编号不许指空号」是同一族，
 * 只不过这次指的是【本文件自己的小节号】。round339 按【实际调用点】改成 ④⑤⑥
 * （复算机器：`grep -n 'fnBody(' test/web/renderer-criteria.test.ts` 去掉定义那一行）。
 */
function fnBody(name: string): string {
  const at = appCode.indexOf("function " + name);
  // 少了这一发，后面每一条在一个【已经不存在的函数】上恒绿：indexOf 找不到返回 -1，
  // slice(-1) 只剩最后一个字符，扫不到 ⇒ "通过"。driverLine 那一条同一手法。
  expect(
    at,
    `app.js 里找不到 function ${name} ⇒ 这一发起码要先红在这里`,
  ).toBeGreaterThan(-1);
  const open = appCode.indexOf("{", at);
  expect(open, `function ${name} 后面找不到 {`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = open; i < appCode.length; i++) {
    const ch = appCode[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return appCode.slice(at, i + 1);
    }
  }
  throw new Error(`function ${name} 的花括号没配平`);
}

describe("① 渲块里不许出现判据字面量（§1「判据随响应发出」的唯一守卫）", () => {
  it("⭐ 正向对照：剥注释【没有】把代码一起剥掉（否则本节是恒绿装饰）", () => {
    // 这一发是整节的前提。测法：拿 app.js 里【确定在代码里】的三样东西
    // —— 一个字段名、一个函数名、一个 HTML class —— 都必须在剥完的文本里还在。
    // 少了这一发，"剥注释"写成 `return ""` 也能让本节四条全绿，
    // 而那正是 0016 §1 那一族（比较型断言失去分辨力时不会自己报）。
    expect(appCode).toContain("attention_statuses");
    expect(appCode).toContain("function taskCard");
    expect(appCode).toContain('class="tk');
    // 反向：注释确实被剥了（这一句用注释里独有的措辞，代码里没有）。
    expect(appCode).not.toContain("运营事件，不是战略决策");
  });

  it("⭐ 任务状态名一个都不许作为字符串字面量出现在代码里", () => {
    // 分母来自边表本身（TASK_STATES），不是这里手抄的清单 ——
    // 同 today.test.ts 那条「BLOCKED 覆盖 edge 表死路」的立场：抄一份清单的话，
    // 新增状态时这里不会红，而界面会漏。
    const hits = TASK_STATES.filter((s) =>
      new RegExp(`["'\`]${s}["'\`]`, "u").test(appCode),
    );
    expect(
      hits,
      `app.js 里出现了任务状态字面量 ${JSON.stringify(hits)} ⇒ 那是一份判据抄件。` +
        "正确做法是让 hub 随 /today 把清单发出来（blocked_statuses / attention_statuses / ceo_decision_statuses）。",
    ).toEqual([]);
  });

  it("⭐ 审批类型名一个都不许作为字符串字面量出现在代码里", () => {
    // 这一条本轮刚立竿见影：判"要不要琥珀"需要知道"哪个类型算运营事件"，
    // 最省事的写法就是 `a.approval_type === "budget_override"` —— 那正是抄件。
    // 实际实现走 operational_approval_types（服务端发的名单）。
    const hits = APPROVAL_TYPES.filter((t) =>
      new RegExp(`["'\`]${t}["'\`]`, "u").test(appCode),
    );
    expect(
      hits,
      `app.js 里出现了审批类型字面量 ${JSON.stringify(hits)} ⇒ 抄件。读 operational_approval_types。`,
    ).toEqual([]);
  });

  it("判据字段【真的被读】了：全都得在代码里出现", () => {
    // 上面两条是「不许出现」，这一条是「必须出现」—— 两个方向都要，
    // 否则"把三个字段全删了"也能让前两条绿（判据没抄件，因为判据根本没用）。
    // `driver` 是 0048 §7 那一站加进来的：hub 侧发了一整块驱动器全景，
    // 而"发了没人读"在这块上比在别处更糟 —— 它存在的唯一理由就是让
    // 「没有告警读起来像一切正常」在屏幕上少一种发生方式（driver-status.ts 文件头）。
    for (const f of [
      "blocked_statuses",
      "attention_statuses",
      "ceo_decision_statuses",
      "operational_approval_types",
    ]) {
      expect(appCode, f).toContain(f);
    }
    // ⚠ driver 这一格【不能】用同一个 toContain：那四个词在 app.js 里只作为
    // 响应字段名出现，而 "driver" 同时也出现在我起的函数名里（driverNotice /
    // driverLine）—— 于是「把 t.driver 的读取全删掉、只留下那两个函数」
    // 照样能让 toContain("driver") 绿，而那一改正是这一发要拦的【发了没人读】。
    // 所以扫的是【属性访问那个形状】。
    expect(appCode, "t.driver").toMatch(/\b\w+\.driver\b/u);
  });

  it("⭐ 界面不许自己判「到顶了没有」：attempts 只许被【显示】而不许被【比较】", () => {
    // 这一格的判据是「这一格里有没有一行放弃记录，且它落在本次进入这一格之后」，
    // 而响应里额外带了 attempts / max_attempts 两个数（driver-status.ts 第 ⑤ 条：
    // 那两个数是【驱动器当时写下的】，用来显示"第 3/3 次"）。
    // 最省事的抄件写法就是在界面里写 `attempts >= max_attempts` ——
    // 那是把"到顶"这件事重新判一遍，而它已经在库里判过了（配置改过一次，
    // 两边就会给出相反的答案：屏幕说"还在试"而驱动器已经放弃了）。
    // 扫法取的是【比较运算】而不是"出现这两个词"：driverLine 必须读它们才能拼那句
    // "第 3/3 次"，禁的是拿去比大小。
    const at = appCode.indexOf("function driverLine");
    // 少了这一发，下面那两条正则在一个【已经不存在的函数】上是恒绿的：
    // indexOf 找不到返回 -1，slice(-1) 只剩最后一个字符，扫不到比较 ⇒ "通过"。
    // 装载器那边（app-loader.ts 的 EXPORTS）也会因为它取不到而红，
    // 但那是另一个文件的红 —— 本文件不许依赖别的文件来证明自己扫到了东西。
    expect(
      at,
      "app.js 里找不到 function driverLine ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at);
    const seg = body.slice(0, 1600);
    const cmp = [
      ...seg.matchAll(/attempts\s*(?:>=|>|<|<=|===|!==)\s*[\w.]*attempts?/gu),
      ...seg.matchAll(/max_attempts\s*(?:>=|>|<|<=|===|!==)/gu),
    ].map((m) => String(m[0]));
    expect(
      cmp,
      `driverLine 里出现了 attempts 与 max_attempts 的比较 ${JSON.stringify(cmp)} ⇒ 那是把「试到上限」判了两遍。` +
        "正确做法是读响应里那个 cause 字段（at_limit / no_budget），它由 GET /today 给出。",
    ).toEqual([]);
    // 分母（正向对照）：这一发【确实】在扫得到东西的范围内 —— 造一个真的比较塞进同一段文本。
    const fake = 'if (row.attempts >= row.max_attempts) paint("amber");';
    expect([
      ...fake.matchAll(/attempts\s*(?:>=|>|<|<=|===|!==)\s*[\w.]*attempts?/gu),
    ]).toHaveLength(1);
  });

  it("⭐ 界面不许出现【驱动器写的那种审计行形状】（kind 名 / target 拼法）", () => {
    // 「谁放弃了这一格」在库里是一行 events，判据靠 target = "状态:角色" 与
    // payload.kind = 'DriverTurnAbandoned' 去认（driver-pump.ts 那两个常量）。
    // 那两个东西一旦出现在渲块里，就意味着渲块在【直接读库的形状】而不是读响应 ——
    // 而 §5.6.1 那条边界（渲染进程只经签名代理拿视图，不碰库形状）禁的正是这个。
    for (const shape of [
      "DriverTurnAbandoned",
      "DriverTurnClaimed",
      "driverCellTarget",
    ]) {
      expect(appCode, shape).not.toContain(shape);
    }
  });

  it("statusClass() 里只有【小写片段】，没有整名 —— 它是呈现映射不是判据", () => {
    // app.js 文件头自己声明了「statusClass 按状态名子串上色，那是呈现映射」，
    // 这一发把那句声明钉住：那批片段必须是小写碎片，
    // 否则哪天有人把 "ESCALATED_TO_CEO" 整名塞进 if 里，它就变成判据了
    //（而上面那条只会报"出现状态名"，报不到"这个函数越权"这一层）。
    const body = appCode.slice(appCode.indexOf("function statusClass"));
    const frags = [
      ...body.slice(0, 900).matchAll(/x\.includes\("([^"]+)"\)/gu),
    ].map((m) => String(m[1]));
    expect(frags.length).toBeGreaterThan(3);
    for (const f of frags) {
      expect(f, f).toBe(f.toLowerCase());
      expect(TASK_STATES).not.toContain(f.toUpperCase());
    }
  });

  it("⭐ 记忆三键【真的被读】：memoryBandHtml 里以属性访问形状读取（0060 §8 界面半）", () => {
    // 0060 §8：「它们进响应（GET /today 的 memory 那一格，键名集合被钉住），
    // 而 desktop 侧还没渲染它们。」这一发守的是【发了没人读】那一半：
    // 三键各自必须以 `.键名` 形状出现 —— 裸词不够（那可能只是注释里提到了），
    // 去重基准声明 `m.scope_rows` 之类的读取才是消费。
    const at = appCode.indexOf("function memoryBandHtml");
    expect(
      at,
      "app.js 里找不到 function memoryBandHtml ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at, at + 2000);
    for (const k of ["scope_rows", "gate_rows", "gate_unattributed_rows"]) {
      expect(body, `memory 键 ${k} 没被读 ⇒ 三数进响应而界面看不见`).toMatch(
        new RegExp(`\\.${k}\\b`, "u"),
      );
    }
    // 正向对照：真实命中才算；换一个同形对象会失配（尺子有分辨力）。
    expect(/\.scope_rows\b/u.test("const x = m.scope_rows;")).toBe(true);
  });

  it("⭐ memory band 【真的接在 renderToday 里】：memoryBandHtml(t.memory) 那一枚调用在（0060 §8 接线半）", () => {
    // 上面那条守的是「三键被读」，这条守的是【读了之后有人把它摆上屏】：
    // memoryBandHtml 纯函数活着、测试绿，都不证明 renderToday 里叫了它。
    // 真接线长这样：`${memoryBandHtml(t.memory)}` 夹在 budgetHtml / notesHtml
    // 之间（renderToday 右栏）。译掉一字符接线就断，这条必须当场红。
    const at = appCode.indexOf("function renderToday");
    expect(
      at,
      "app.js 里找不到 function renderToday ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at, at + 3000);
    expect(
      body,
      "renderToday 里没有 memoryBandHtml(t.memory) ⇒ 三数被读了却没人摆上屏",
    ).toContain("memoryBandHtml(t.memory)");
    expect(
      body.indexOf("budgetHtml(t)") >= 0 &&
        body.indexOf("memoryBandHtml(t.memory)") >
          body.indexOf("budgetHtml(t)"),
      "接线位置不对：memoryBandHtml 应在 budgetHtml 之后（右栏右半边）",
    ).toBe(true);
  });

  it("⭐ 今日页窗口【真的接进 renderToday】：windowMsOfHash(location.hash) 那枚调用在（round352 接线半）", () => {
    // 纯函数 windowMsOfHash / todayCacheHit 各自有 app-pure 的直测，而这一发守的
    // 是【读了之后真有人把窗口传给 getToday】：把 hash 解析撤成写死 undefined
    // （M5 的变异体），窗口选择器还在渲染、纯函数测试也全绿 —— 只有这里会红。
    // 真接线长这样：`const winMs = windowMsOfHash(location.hash);` 在 renderToday
    // 顶部，随后 `getToday(true, winMs)`。译掉一字符接线就断，这条必须当场红。
    const at = appCode.indexOf("function renderToday");
    expect(
      at,
      "app.js 里找不到 function renderToday ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at, at + 1200);
    expect(
      body,
      "renderToday 里没有 windowMsOfHash(location.hash) ⇒ 窗口永不生效（恒 24h）",
    ).toContain("windowMsOfHash(location.hash)");
    expect(
      body.indexOf("getToday(true, winMs)") > -1,
      "窗口解析出来后必须传进 getToday —— 断开就回到永远默认 24h",
    ).toBe(true);
  });

  it("⭐ 窗口参数【真的拼进请求】：getToday 里的 `?window_ms=\u0024{windowMs}` 在代码里（round352 接线半）", () => {
    // 守的是 M4：把 q 的拼串改成恒空串（或挪进注释）后，hash 解析得再对，
    // 打出去的请求也永远是无窗口的 /today（服务端恒定 24h，且无任何报错）。
    // 剥注释后的 appCode 断言 ⇒ "写进注释了" 同样是红。锚定在函数体上，
    // 别让同名字面量出现在别处（比如报错文案）也算数。
    // （标题/断言里的 \$ 是字面美元符 —— 这条串要匹配源码里的模板串原文，
    //  写成真模板串会把 windowMs 当变量插值掉。）
    const body = fnBody("getToday");
    expect(
      body,
      "getToday 里没有 `?window_ms=` 模板串 ⇒ 窗口只在 hash 里自嗨，请求永远是裸 /today",
    ).toContain("`?window_ms=\u0024{windowMs}`");
    expect(
      body.indexOf("async") > -1 || body.indexOf("await api") > -1,
      "取体器没取对：fnBody('getToday') 拿到的不像 getToday 本体",
    ).toBe(true);
  });

  it("⭐ auto_approved 标注【真的按对象读】：eventRow 里不再是 === true（round346）", () => {
    // 服务端（replay/query.ts autoApprovedSection）发 {by,rule,annotation} 对象，
    // 早先前端写 `e.auto_approved === true` ⇒ 对象恒不等于 true ⇒ 标注从未上屏。
    // 这一发直接钉「那个恒假写法不在场」—— 改回布尔比较，这条就红。
    const at = appCode.indexOf("function eventRow");
    expect(
      at,
      "app.js 里找不到 function eventRow ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at, at + 1500);
    expect(body, "eventRow 里不该再有 === true 那格恒假比较").not.toContain(
      "auto_approved === true",
    );
    expect(body).toContain("autoApprovedOf(e)");
  });

  it("⭐ incompleteNote【真的接在回放头卡】：loadReplay 里那枚调用在（round346）", () => {
    // 服务端（replay/query.ts:147-149）说 complete=false「界面应当把它渲染成一段
    // 看得见的缺口」。纯函数活着、测试绿，都不证明画回放主体的入口叫了它 ——
    // 这一发钉接线：回放主体渲染在 loadReplay 的 body.innerHTML 里（renderReplay
    // 只是登页那一跳，首次渲染也走 loadReplay）。
    const at = appCode.indexOf("function loadReplay");
    expect(
      at,
      "app.js 里找不到 function loadReplay ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = appCode.slice(at, at + 4000);
    expect(
      body,
      "loadReplay 里没有 incompleteNote(data.complete) ⇒ 缺口提示没人摆上屏",
    ).toContain("incompleteNote(data.complete)");
    expect(body).toContain(
      "checkpointDegradedNote(data.checkpoints_unavailable",
    );
  });
});

describe("② 琥珀色落点名单（§19.2「全局仅用于需要 CEO 决策」）", () => {
  /** 找出 CSS 里每一处用到 var(--amber) 的选择器。 */
  function amberSelectors(css: string): string[] {
    const out: string[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/gu;
    let m = re.exec(css);
    while (m !== null) {
      const sel = String(m[1]).replace(/\s+/gu, " ").trim();
      if (String(m[2]).includes("var(--amber)")) out.push(sel);
      m = re.exec(css);
    }
    return out;
  }

  it("⭐ 正向对照：选择器提取函数本身有分辨力", () => {
    const got = amberSelectors(
      ":root { --x: 1px; } .a { color:var(--amber); } .b { color:var(--blue); }",
    );
    expect(got).toEqual([".a"]);
    // 反向：把 var 换成裸色值也必须能识别成"这一条不含 var(--amber)"（不能因为
    // 提取失败而把一条本该出现的规则静默丢掉 ⇒ 漏报）。
    expect(amberSelectors(".z { color: #E8A33D; }")).toEqual([]);
  });

  it("var(--amber) 只出现在名单里那几个选择器上（多一处就红，并指名是哪一处）", () => {
    const css = htmlSrc.slice(
      htmlSrc.indexOf("<style>"),
      htmlSrc.indexOf("</style>"),
    );
    const got = amberSelectors(stripCssComments(css)).sort();
    // 这份名单是【琥珀语义】的机器可读版本。往里加一项 = 让琥珀多表示一种意思，
    // 而 §19.2 那条「琥珀出现处就是需要你动手的地方」是一次一否的承诺：
    // 每多一个合法落点，"扫一眼就知道在哪动手"就弱一分。所以要加得有意识。
    expect(got).toEqual(
      [
        "nav a .badge", // 收件箱角标：待批张数 = 等你按按钮的张数
        ".pill.s-amber", // 「这一件现在等你动手」那一档 pill
        ".need", // 今日页 / 收件箱的待批卡（琥珀左边框，§16.3 逐字要求的形态）
        ".need .sect",
        ".statbad .num", // 今日页那个「待你决策」的数字
        ".tk.decision", // 看板上 status ∈ ceo_decision_statuses 的那张卡
      ].sort(),
    );
    // :root 那一行是【定义】（`--amber: #E8A33D`），不是【使用】—— 上面那条
    // 正则找的是 `var(--amber)`，所以定义处天然不在名单里。这一发单独钉它存在，
    // 否则"把 --amber 定义删了"会让上面那条空名单断言以错误的方式通过。
    expect(stripCssComments(css)).toContain("--amber: #E8A33D");
  });

  it("⚠ 反向名单：这几处【不许】是琥珀（本轮真实违反过的那三处）", () => {
    const css = stripCssComments(
      htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")),
    );
    // 每条都是「选择器 → 不许出现的属性值」。写成数据而不是三条 expect，
    // 是因为报错要能指回规格那一句。
    const banned: Array<[string, string]> = [
      [
        ".tk.flag",
        "成员身份不是「等你动手」（§16.4 那一列含预算暂停，规格明写非琥珀）",
      ],
      [".card.flag", "运营事件卡片（§7.4 原话：非琥珀色的预算暂停卡片）"],
      [".banner.warn", "取不到数据不是等谁决策"],
      [".ev.decide::before", "回放里的人工决定是【已经拍过板】的记录"],
      [
        ".pill.s-gray",
        "警报已哑那一格：它本身就是「警报没了」，配警报色自相矛盾",
      ],
    ];
    for (const [sel, why] of banned) {
      const re = new RegExp(
        `${sel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^{}]*)\\}`,
        "u",
      );
      const m = re.exec(css);
      expect(
        m,
        `名单里的选择器 ${sel} 在 CSS 里找不到了 ⇒ 这条守卫本身该重读`,
      ).not.toBeNull();
      expect(String(m?.[1]), `${sel} 不许用琥珀：${why}`).not.toContain(
        "var(--amber)",
      );
    }
  });

  it("红色的落点逐处钉住（§19.2 那张色表里【没有】「异常色」这一档）", () => {
    const css = stripCssComments(
      htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")),
    );
    const users = [...css.matchAll(/([^{}\s][^{}]*)\{([^{}]*)\}/gu)]
      .filter((m) => String(m[2]).includes("var(--err)"))
      .map((m) => String(m[1]).replace(/\s+/gu, " ").trim())
      .sort();
    // ⚠ 我第一版把这一条写成「红色只有一处合法落点（§7.4 那根预算条）」，
    // 实跑【三红】—— 那句话是假的：`.dot.off` / `.err` / `.banner.err` 早就在用红，
    // 表达的是【硬失败】（连不上、请求 4xx/5xx），那是另一件事，也不该被我说服成灰色。
    // 规格色表没列"异常色"不等于不许有失败色 —— 色表管的是"CEO 决策强调色"这类
    // 语义色，而"这一页没 load 出来"是系统故障，不是业务状态。
    // 所以这一钉的真正内容不是"红只有一处"，而是【红只有这两类】：
    //   硬失败指示（连不上 / 错误横幅）+ §7.4 明写的预算条。
    // 往里加第三种"看起来不太好就涂红"的用法，就是把 §19.1 要的「一眼扫到该动手的那处」
    // 换成「一整屏都在喊」。
    expect(users).toEqual(
      [".banner.err", ".budgetover .meter.over i", ".dot.off", ".err"].sort(),
    );
  });
});

describe("③ 焦点可见（Task 2.6「键盘可完成全部审批操作」的前提）", () => {
  const css = () =>
    stripCssComments(
      htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")),
    );

  it("⭐ CSS 里不许出现 outline:none / outline:0（键盘走到哪一格必须看得出来）", () => {
    const got = [...css().matchAll(/outline\s*:\s*(?:none|0)\b/giu)].map((m) =>
      String(m[0]),
    );
    // 这一条是被一处【真实存在过的】写法逼出来的：input/textarea 那行原本带
    // `outline:none`，屏幕上"看着挺干净"，代价是键盘用户不知道自己在哪一格 ——
    // 于是那句验收只剩"控件 tabindex 都在"，没有"人看得见自己在按哪个"。
    // 颜色与焦点这种事 code review 看不见（它只在屏幕上存在），而本仓【没有浏览器】
    // 能跑一次（0042 §11 第一条），所以只能钉在源码层。
    expect(
      got,
      `CSS 里把焦点环关掉了 ${JSON.stringify(got)} ⇒ 键盘操作变成摸黑`,
    ).toEqual([]);
    // ⚠ 正向对照：上面那条正则真的认得出违例（写成恒不匹配也能"绿"）。
    expect([
      ...":a{outline:none}.b{outline: 0}.c{outline-offset:2px}".matchAll(
        /outline\s*:\s*(?:none|0)\b/giu,
      ),
    ]).toHaveLength(2);
  });

  it("⭐ 存在一条 :focus-visible 规则，且它不用琥珀", () => {
    const m = /(^|[^\w-]):focus-visible\s*\{([^{}]*)\}/u.exec(css());
    expect(
      m,
      "CSS 里找不到 :focus-visible 规则 ⇒ 焦点环整条没了",
    ).not.toBeNull();
    const body = String(m?.[2]);
    // 琥珀在这里是【禁】的：焦点环随按键满屏跑，用琥珀等于让「这里需要你决策」
    // 每按一次 Tab 撒一次谎，而 §19.2 那一格的全部价值就在"琥珀只说一件事"。
    expect(body).not.toContain("var(--amber)");
    // 反向对照：琥珀塞进同一条规则时必须被抓到。
    expect(
      /:focus-visible\s*\{[^{}]*var\(--amber\)/u.test(
        ":focus-visible{color:var(--amber)}",
      ),
    ).toBe(true);
  });

  it("任务卡在源码层就是可聚焦的（键盘进不了详情 = 键盘完不成审批）", () => {
    // 这里扫的是【绑定那一处】而不是 taskCard 的返回串（后者由 app-pure.test.ts
    // 真跑函数覆盖）：两处的失败方式不同 —— 标记在而没绑键 = Tab 能停、按下去没反应，
    // 比原来更坏，因为它【看着像】支持了。
    expect(appCode).toMatch(
      /data-task[\s\S]{0,400}addEventListener\(\s*"keydown"/u,
    );
    // 正向对照：模板被拆掉键盘绑定时上面那条必须红。
    expect(
      /data-task[\s\S]{0,400}addEventListener\(\s*"keydown"/u.test(
        '<div data-task="a"></div>',
      ),
    ).toBe(false);
  });
});

/* ───────── ④ 参数快照那一格（§9.2 第二行 + 计划 Task 2.6 那半句） ─────────
 * app-pure.test.ts 那两节真跑了 paramSnapshotLines / paramSnapshotHtml，所以
 * 「行算得对」「过了 esc」已经有执行证据。这一节只补它们【看不见】的两半：
 *  ① CSS 在 index.html 里，纯函数测不到它有没有把那一格又画回一个框；
 *  ② 「金额这一格用的是全页唯一那份格式化」这件事，函数跑对了也证明不了
 *     （自己写一遍 (c/100).toFixed(2) 当场也能算出 $12.50 —— 漂的那一次才要命，
 *      而漂了以后屏幕上两个数不一样，任务预算列与审批卡各说一套）。
 */
describe("④ 参数快照：等宽 + 左缩进 + 不画框线，金额只有一份格式化", () => {
  const css = () =>
    stripCssComments(
      htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")),
    );

  it("⭐ 正向对照：配平取体真的只取到本函数（越界会被抓到）", () => {
    // 这一发是这一节的前提，driverLine 那一节的正向对照同一立场：提取函数本身
    // 失去分辨力时，下面三条全部静默通过。
    const body = fnBody("paramSnapshotHtml");
    expect(body.trimStart().startsWith("function paramSnapshotHtml")).toBe(
      true,
    );
    expect(body.trimEnd().endsWith("}")).toBe(true);
    // 越界的证据：下一个函数 paramSnapshotLines 的函数名【不许】出现在这里面。
    expect(body).not.toContain("function paramSnapshotLines");
    expect(body.length).toBeLessThan(1200);
    // 反向：如果按"往后数 900 字符"取，就会把隔壁的 style= 捞进来（我第一次就踩了这个）。
    const naive = appCode.slice(
      appCode.indexOf("function paramSnapshotHtml"),
      appCode.indexOf("function paramSnapshotHtml") + 900,
    );
    expect(naive).not.toBe(body);
  });

  it("⭐ .snap 只有左缩进，没有边框 / 背景 / 圆角（那一条明写「不画框线」）", () => {
    const m = /\.snap\s*\{([^{}]*)\}/u.exec(css());
    expect(
      m,
      "CSS 里找不到 .snap 规则 ⇒ 参数快照那一格没有样式了",
    ).not.toBeNull();
    const body = String(m?.[1]);
    expect(body).toContain("padding-left");
    for (const box of ["border", "background", "outline", "box-shadow"]) {
      expect(
        body,
        `.snap 不许有 ${box}：那一格靠缩进与色阶表达层级（§19.4 同族）`,
      ).not.toContain(box);
    }
    // ⚠ 正向对照：上面那四条真的认得出违例 —— 恒不匹配的写法（把 not.toContain
    // 写成扫不到东西的正则）在这一格上长得和通过一模一样。
    expect(
      /border/.test(".snap { padding-left:18px; border:1px solid red }"),
    ).toBe(true);
  });

  it("⭐ 那一格【不是】<pre>，也不在函数里内联 style（pre 自带底 + 圆角 = 画了个框）", () => {
    const body = fnBody("paramSnapshotHtml");
    expect(body).toContain("snap");
    expect(body).not.toContain("<pre");
    expect(body).not.toContain("style=");
  });

  it("⭐ 金额那一格调的是 money()，而不是自己再算一遍除法", () => {
    const body = fnBody("paramSnapshotLines");
    expect(body).toMatch(/\bmoney\(/u);
    // 抄件的形状是「/ 100」或「* 0.01」再加 toFixed。三条都扫：只扫一条的话，
    // `(c/100).toFixed(2)` 与 `(c * 0.01).toFixed(2)` 里会漏掉后一种写法。
    for (const shape of [
      /\s\/\s*100\b/gu,
      /\*\s*0\.01\b/gu,
      /toFixed\s*\(\s*2\s*\)/gu,
    ]) {
      expect(
        [...body.matchAll(shape)].map((m) => String(m[0])),
        String(shape),
      ).toEqual([]);
    }
    // 正向对照：抄件塞进同一段文本时必须被抓到。
    expect(
      /\s\/\s*100\b/gu.test('rows.push(["金额", "$" + (c / 100).toFixed(2)])'),
    ).toBe(true);
    expect(
      /toFixed\s*\(\s*2\s*\)/gu.test(
        'rows.push(["金额", "$" + (c / 100).toFixed(2)])',
      ),
    ).toBe(true);
  });
});

/* ═════════ ⑤ 审阅独立性那一格：渲块【只念数】（O4 / 0042） ═════════
 * 那一格说的是「审阅要不要你出现」，而它的判据在 hub 的 author-reviewer 里。
 * 界面一旦自己比 model_family，就得到第二份「什么算同源」：判据改了（比如将来
 * 加"同家族但不同训练代"那一维），这边一个字都不会动，也不会红 —— 而它已经在
 * 对一个 CEO 说「每次都要批」或者「不用管」。这一节守的就是它【没有】那份判据。
 *
 * ⚠ 与 app-pure.test.ts 那一组的分工：那边真跑函数、证「数念对了」；
 * 这一节扫源码、证「渲块里没有第二份判据」。缺任何一半都会留一个洞：
 * 函数算得对 ≠ 它没有顺手自己算一遍；反之源码里没有判据也证不了话术正确。
 */
describe("⑤ reviewIndependenceBand 里没有第二份同族判据", () => {
  it("⭐ 正向对照：取到的确实是那一格，而且【剥注释后仍然有内容】", () => {
    // 少了这一发，下面四条可以在一个【已经改名的函数】上恒绿。
    // 本文件那条 fnBody 找不到函数会先红（它自己带断言），但"函数在、里面被掏空"
    // 这一种只有这一发看得见。
    const body = fnBody("reviewIndependenceBand");
    expect(body.trimStart().startsWith("function reviewIndependenceBand")).toBe(
      true,
    );
    expect(body).toContain("pairs_total");
    expect(body.length).toBeGreaterThan(200);
    // 越界证据：隔壁函数的名字不许在里面（取体跑出去了）。
    expect(body).not.toContain("function paramSnapshotHtml");
  });

  it("⭐ 不【读】model_family：出现属性读取即第二份判据（提及字段名不算）", () => {
    const body = fnBody("reviewIndependenceBand");
    // ⚠ 尺子的边界在这里，别放宽也别收紧：
    //  · 【禁】的是把两侧的家族【取出来再比】—— `.model_family` 属性读取、
    //    familyOf 那类辅助、或任何 `x === y` 作用在家族上。那是第二份判据。
    //  · 【不禁】在文案里【提到这个字段名】：refused 那一档要给 CEO 修法
    //    （「先把 model_family 配上」），那是【去哪儿改】，不是【怎么判】。
    //    第一版我写的是 `not.toContain("model_family")`，红在那句修法上 ——
    //    过宽的尺子会把对的话删掉，这里就是把唯一的可操作修法删掉。
    expect(body).not.toMatch(/\.model_family\b/u);
    expect(body).not.toMatch(/\bfamilyOf\b|\bfamA\b|\bfamB\b/u);
    expect(body).not.toContain("sameFamilyReviewBlock");
    // 判据要成立必须有两侧可读；这里只有 `p.` 一个入参，读不到第二个对象。
    expect(body).not.toMatch(/\bsameFamily\b/u); // 自己算出来的同族计数
    // 正向对照：真抄件塞进同一段文本必须被抓到。
    const copy = "if (a.model_family === b.model_family) need = true";
    expect(/\.model_family\b/u.test(copy)).toBe(true);
    // 反向对照：修法那句措辞【不算】违例（保证尺子没宽到删掉修法）。
    expect(/\.model_family\b/u.test("先把 model_family 配上")).toBe(false);
  });

  it("⭐ 六个数全部【从入参读】：body 里出现的每一个读数键都挂在 p. 上", () => {
    const body = fnBody("reviewIndependenceBand");
    for (const k of [
      "roles",
      "pairs_total",
      "pairs_ok",
      "pairs_same_family",
      "pairs_refused",
      "always_needs_approval",
      "any_refused",
      "blocked",
    ]) {
      expect(body, `读数键 ${k} 没被读 ⇒ 那一格可能被硬编码了`).toContain(k);
    }
    // 形状反证：读数键【不许多次】以裸字面量出现在赋值右侧（硬编码常数的形状）。
    // 只扫 pairs_total：它是分母，写死一个数就整格作废。
    const hardcoded = [...body.matchAll(/pairs_total\s*=\s*\d+/gu)].map((m) =>
      String(m[0]),
    );
    expect(hardcoded, "pairs_total 被写成常数").toEqual([]);
    expect(
      /pairs_total\s*=\s*\d+/u.test("const total = 6; // pairs_total = 6"),
    ).toBe(true);
  });

  it("⭐ 那一格不发琥珀，也不发 .err（§19.2 琥珀只留给「此刻要你决策」）", () => {
    const body = fnBody("reviewIndependenceBand");
    // banner 的两个警示类名不许出现在这一格里；warn 是唯一被允许的（蓝）。
    expect(body).not.toContain('"err"');
    expect(body).not.toContain("'err'");
    // 琥珀那一档在渲块里的挂钩是 `.need` 类（approvalCard 用 `class="card need"`）。
    // ⚠ 扫的是【类名字面量】而不是裸词 "need"：入参键 always_needs_approval 里
    //   含 "need" 四个字母，扫裸词会【假红】—— 第一版就是这么红的。
    expect(body).not.toContain('class="card need');
    expect(body).not.toContain(" need");
    // 正向对照：warn 那条【在】，所以上面那几条 not 不是空扫。
    expect(body).toContain('"warn"');
    // 反向对照：把琥珀类塞进同一段文本必须被抓到。
    expect(/ need/.test('<div class="card need" data-approval-id="a1">')).toBe(
      true,
    );
  });

  it("⭐ 不许把【配对数】说成【审阅次数】（结构读数不是预测）", () => {
    const body = fnBody("reviewIndependenceBand");
    // ⚠ 判据的形状是这一条，不是「不许出现次审阅这四个字」—— 后者会【禁掉 O4
    //   自己要的那句话】（「每一次审阅都要你出现」是一句【全称】陈述，不是把
    //   pairs_* 换算成次数）。第一版我写的就是那条过宽的，实跑红在我自己那句
    //   正确的文案上：错的尺子会把对的话删掉。
    // 真正禁的是「某个 pairs_* 被乘 / 换算成一个次数」这一族形状。
    for (const shape of [
      /pairs_\w+\s*[*/]/gu, // 读数参与乘除 ⇒ 在换算成别的量
      /\d+\s*次审阅/gu, // 字面次数
      /审阅次数/gu,
      /预计|将会发生|将来会/gu, // 预测措辞
    ]) {
      expect(
        [...body.matchAll(shape)].map((m) => String(m[0])),
        String(shape),
      ).toEqual([]);
    }
    // 主语确实落在「配对」上（上面那一行 head 里就有）。
    expect(body).toContain("配对");
    // 正向对照：换算形状塞进同一段文本必须被抓到。
    expect(/pairs_\w+\s*[*/]/u.test("const n = p.pairs_same_family * 2")).toBe(
      true,
    );
    expect(/\d+\s*次审阅/gu.test("一共 12 次审阅")).toBe(true);
    // 反向对照：O4 要的那句【全称】措辞不算违例（这一发保证尺子没宽到删掉对的话）。
    expect(/pairs_\w+\s*[*/]/u.test("每次审阅都要你显式批一遍")).toBe(false);
    expect(/\d+\s*次审阅/gu.test("每次审阅都要你显式批一遍")).toBe(false);
  });
});

/* ═════════ ⑥ 委派边那一格：门控可见，且那句【关于判据的话】不许漂 ═════════ */

/**
 * 服务端那条判据的正本。round339 把它拉进射程的理由：界面上现在写着
 * 「missing_review_gate 是第一个能失败的判据」—— 那一句是服务端行为的一份
 * 【散文抄件】。抄件要么不写，写了就得有机器对着正本核，否则它漂的那天
 * 屏幕上是一句自信的话、一条守卫都不会红（本轮改掉的正是这么一句）。
 */
const VALIDATE_TS = join(REPO, "packages/contracts/src/org/validate.ts");
const validateSrc = readFileSync(VALIDATE_TS, "utf8");

describe("⑥ edgeChip 与那条边上的门控：可见性 + 散文抄件对着正本核", () => {
  it("⭐ 正向对照：取体器在这一格有分辨力（找不到函数会先红在这里）", () => {
    const body = fnBody("edgeChip");
    expect(body).toContain("review_gate");
    // 越界会被抓到：体里不该有下一个函数的签名。
    expect(body).not.toContain("function reviewIndependenceBand");
    expect(body).not.toContain("async function renderOrg");
  });

  it("⭐ 那一格【真的读】review_gate —— 而且读的是属性，不是自己写一个同名字段", () => {
    const body = fnBody("edgeChip");
    expect(body).toMatch(/\?\.\s*review_gate\b|\.\s*review_gate\b/u);
    // ⚠⚡ 这一发的全部难度在【尺子形状】，不在断言本身：
    // `expect(appCode).toContain("review_gate")` 是一条【恒绿装饰】—— 那个词在
    // app.js 里早就有了，出现在【写入方】那一侧（add_edge 交上去的对象字面量
    // `review_gate: …checked`）。把 chip 里的读取整行删掉，toContain 照样绿，
    // 而删掉读取正是这一发要拦的「发了没人读」。所以扫的是【点号 + 属性名】。
    const writeOnly =
      '<input type="checkbox" data-edge-gate checked /> review_gate: c';
    expect(/\.\s*review_gate\b/u.test(writeOnly)).toBe(false);
    expect(writeOnly).toContain("review_gate"); // ← 同一个样本在旧尺子下是"通过"的
  });

  it("⭐ 三态不许并成两态：读不到 ≠ 没门控（源码层钉住那三个词）", () => {
    const body = fnBody("edgeChip");
    for (const w of ["已门控", "无门控", "门控未知"])
      expect(body, w).toContain(w);
    // 三态各只出现一次 ⇒ 没有"默认当成 false"那种悄悄合并。
    expect(body.split("门控未知").length - 1).toBe(1);
  });

  it("⭐ 这一格不开新的颜色档（§19.2 那张色表里没有「门控关着」）", () => {
    const body = fnBody("edgeChip");
    for (const cls of ["need", "banner", "statbad", "var(--amber)"])
      expect(body, cls).not.toContain(cls);
    // 阳性对照：approvalCard 在真该琥珀时【确实】吐 need —— 否则上面四条
    // 只是在念「app.js 不写这几个词」，而 need 明明写在 app.js 里。
    expect(appCode).toContain("need");
    // .edge 那条规则全仓只有一条 ⇒ chip 上多出来的只能是【字】，不可能是色。
    const css = htmlSrc.slice(
      htmlSrc.indexOf("<style>"),
      htmlSrc.indexOf("</style>"),
    );
    const edgeRules = [...css.matchAll(/[^{}\n]*\.edge[^{}\n]*\{/gu)].map((m) =>
      m[0].trim(),
    );
    expect(edgeRules).toEqual([".edge {"]);
  });

  it("⭐ 那条假承诺不许回来：「不勾也会被那三判断掉」是错的", () => {
    // round339 之前这里写的是「服务端仍会按升级可达 / 自审 / 同家族那几判拒它」。
    // 实测：validateNewEdge 的 !reviewGate 那一格在 :383，另三条在 :389 / :394 / :402
    // ⇒ 不勾时那三条【一行都没执行】。
    for (const shape of [/仍会按/gu, /那几判拒它/gu]) {
      expect(
        [...appCode.matchAll(shape)].map((m) => String(m[0])),
        String(shape),
      ).toEqual([]);
    }
    // 阳性对照：尺子对【被禁的原句】抓得到（HEAD 那一版里就有这句话，取它当样本），
    // 否则「扫不到」可能只是尺子坏了 —— 本文件为这件事记过不止一次。
    const theOldLie = "服务端仍会按升级可达 / 自审 / 同家族那几判拒它";
    expect(/仍会按/u.test(theOldLie)).toBe(true);
    expect(/那几判拒它/u.test(theOldLie)).toBe(true);
    // 反向对照：本轮写进去的那句【真话】里也有「判」，没被这一刀削掉。
    expect(appCode).toContain("根本没被求值");
  });

  it("⭐ 界面那句「missing_review_gate 是第一个能失败的判据」对着正本核", () => {
    // 这一发是【跨语言】的：左边是界面散文，右边是 contracts 的判据顺序。
    // 有人把 validateNewEdge 里那几格换个顺序，红的应该是这一发，而不是
    // 「屏幕上少了一个人看得见的原因」。
    const at = validateSrc.indexOf("export function validateNewEdge");
    expect(
      at,
      "contracts 里找不到 validateNewEdge ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(-1);
    const body = validateSrc.slice(at, at + 3000);
    // 锚点一律用【调用形状】而不是光一个函数名：正本 :393 那行注释里就写着
    // `canReach(target, "ceo")`，用裸 `canReach(` 会先撞上那句散文 —— 量到的
    // 是注释的位置。它恰好也排在门控后面，所以断言【照样绿】，而绿的原因是错的
    // （本仓记过的那一类：数对了、挂法错）。
    const gate = body.indexOf('"missing_review_gate"');
    const self = body.indexOf("const self = violatesNoSelfReview(");
    const reach = body.indexOf("if (!canReach(");
    const deep = body.indexOf("const deep = wouldExceedMaxDepth(");
    for (const [who, i] of [
      ["missing_review_gate", gate],
      ["violatesNoSelfReview", self],
      ["canReach", reach],
      ["wouldExceedMaxDepth", deep],
    ] as const) {
      expect(
        i,
        `validateNewEdge 体里找不到 ${who} 的【调用那一行】`,
      ).toBeGreaterThan(-1);
    }
    expect(gate).toBeLessThan(self);
    expect(gate).toBeLessThan(reach);
    expect(gate).toBeLessThan(deep);
    // 界面上那句话与上面四个数【同向】：只有 unknown_role 排在门控前面。
    const role = body.indexOf('"unknown_role"');
    expect(role).toBeGreaterThan(-1);
    expect(role).toBeLessThan(gate);
    expect(appCode).toContain("角色不在图里");
    // 阳性对照【从真正文造】，不从我手抄的字面量造 —— 我第一版在这里写的是
    // `expect("unknown_role x missing_review_gate y …".indexOf(…) < ….indexOf(…))`，
    // 那是【恒真】：串是我自己排的，它成立与正本长什么样无关（同一族假对照
    // 本文件刚记过一次：`expect("<img src=x>").not.toContain("&lt;")`）。
    // 第二版把那一格搬到 canReach 之前，【也是假的】：搬完它仍然在最前，
    // 上面那三条 toBeLessThan 照样"通过" ⇒ 这一发什么都没对照。
    // 正解：把门控那一格搬到【最后一格之后】，同一把尺子必须给出相反读数。
    // 锚点找不到就先红在这里，而不是留下一个永远不会红的对照。
    const gStart = body.indexOf("if (!reviewGate)");
    const gEnd = body.indexOf("const self =");
    expect(
      gStart,
      "找不到 if (!reviewGate) ⇒ 这一发的对照失效",
    ).toBeGreaterThan(-1);
    expect(gEnd, "找不到 const self = ⇒ 这一发的对照失效").toBeGreaterThan(
      gStart,
    );
    const gateBlock = body.slice(gStart, gEnd);
    const without = body.slice(0, gStart) + body.slice(gEnd);
    const deepLineEnd = without.indexOf(
      "\n",
      without.indexOf("wouldExceedMaxDepth("),
    );
    expect(
      deepLineEnd,
      "找不到 wouldExceedMaxDepth 那一行 ⇒ 对照失效",
    ).toBeGreaterThan(-1);
    const moved =
      without.slice(0, deepLineEnd) +
      "\n" +
      gateBlock +
      without.slice(deepLineEnd);
    // 搬完之后：门控那一格排在 wouldExceedMaxDepth 之后 ⇒ 上面那句 `gate < deep` 翻面。
    // 这一发钉的是【尺子有双向读数】，不是钉住正本的顺序（正本由上面那三条钉）。
    expect(moved.indexOf('"missing_review_gate"')).toBeGreaterThan(
      moved.indexOf("wouldExceedMaxDepth("),
    );
  });

  it("⭐ 界面【自己那句关于顺序的话】也得钉住 —— 只钉服务端等于没钉", () => {
    // 这一发是被【变异矩阵】逼出来的：M8 把界面上那句「它是第一个能失败的判据」
    // 改成「它在自审之后」之后，上面那一整发【全绿】—— 因为它量的是正本，
    // 正本没动。而本轮写进界面的正是一份【关于正本的说法】：说法漂了、正本没漂，
    // 屏幕上的话就是假的，一条守卫都不会红。那正是本轮要消灭的形状，
    // 我差一点在修它的同一发里再造一条。
    const claim = appCode.indexOf("missing_review_gate");
    expect(claim, "界面上已经没有 missing_review_gate 了？").toBeGreaterThan(
      -1,
    );
    const said = appCode.slice(claim, claim + 200);
    expect(said).toContain("第一个");
    // 而且界面说的是【只有角色那一格在它前面】—— 这一句与正本同向（正本 :380 的
    // unknown_role 确实在 :383 的门控之前）。反过来若有人把界面写成
    // 「自审排在门控前面」，被这一发抓到的是那三个字。
    expect(said).toContain("角色不在图里");
    // 阳性对照：把界面那句话换成 M8 那一种说法，尺子立刻不给「第一个」。
    const m8 = "服务端以 missing_review_gate 拒这一发 —— 它在自审之后";
    expect(
      m8.slice(
        m8.indexOf("missing_review_gate"),
        m8.indexOf("missing_review_gate") + 200,
      ),
    ).not.toContain("第一个");
    // 反向对照：正本那句话【现在】就在这 200 字窗口里 —— 窗口宽度不是照着
    // 当前措辞刚好裁的（裁太窄会让下一句真话因为排版换行而掉出窗口，
    // 那类"尺子贴着样本长"的坑本文件 §④ 记过）。
    expect(said).toContain("根本没被求值");
  });

  it("⭐ 422 那两支的口径别写反：判据拒【一条】，schema 拒【一批】", () => {
    // 本轮同时改掉的一句是「422 时界面回弹并逐条说原因」（renderOrg 文件头），
    // 而 reparent 走的那一支只带一个 reason（http/org.ts 翻成 {error, code}）。
    //
    // ⚠ 尺子形状是被【变异矩阵】改的：第一版禁的是两条窄短语（`422…逐条说原因`、
    // `拒了逐条说原因`），M6 只把动词换个说法（「回弹并逐条说原因」）就全绿 ——
    // 那等于禁的是【我抄过的两种措辞】而不是那件错事。
    // 正解是禁【那个错短语本身】：「逐条说原因」在剥注释后的 app.js 里 HEAD 有 1 处
    // （就是那句假的），本轮之后是 0 处；而裸「逐条」仍合法 —— 实测剩下两处真话
    // （本轮那句「逐条列的是请求体没过 schema 那种」+ 岗位书的「建议逐条过目」），
    // 所以一刀切「不许出现逐条」会把真话削掉（本文件 §⑤ 为同一件事记过两回）。
    // 扫 appCode 而不是 appSrc：那句假话在模板字符串里（是代码），而我自己的
    // 警告注释「别说成『逐条说原因』」必须【允许】出现 —— 它是在教下一个人别再写。
    expect(appCode, "「逐条说原因」这个搭配又回来了").not.toContain(
      "逐条说原因",
    );
    // 阳性对照：这三条都不许是恒真。
    // (1) 尺子【看得见那句假话住在哪儿】—— 它在模板字符串里，而本文件的尺子先剥注释。
    //     所以拿一个同形状的夹具（块注释 + `<p>` 模板串里那句）过一遍【正把尺子】：
    //     剥完必须还在 ⇒ 证明剥注释没把模板串一起吃掉。
    //     ⚠ 这一发【故意不拿 git HEAD 当样本】：那种阳性对照在本次改动 commit 之后
    //     会立刻变红（HEAD 里就没有那句了），是一条【定时炸弹】而不是守卫。
    //     要"对历史负责"的对照应该去读正本（下面的 http/org.ts 两支），不是读 git 状态。
    const fixture = [
      "/* 注释里出现 逐条说原因 是为了教训下一个人 */",
      'const s = `<p class="meta">服务端拒了，逐条说原因</p>`;',
    ].join("\n");
    expect(stripComments(fixture)).toContain("逐条说原因");
    // (2) 反向对照：剥注释这道工序确实【会】吃掉注释 —— 上面那条因此不是"什么都不剥"。
    expect(stripComments("/* 逐条说原因 */")).not.toContain("逐条说原因");
    // (3) 「逐条」这个词本身仍然合法 —— 两处真话都在场。
    expect(appCode).toContain("逐条列的是请求体没过 schema");
    expect(appSrc).toContain("逐条过目");
    expect(appCode).toContain("edgeChip"); // 剥完仍然有代码 ⇒ 本节不是空扫描
    // 两支的响应形状也在正本里：一支持 issues 数组，一支持单条 error/code。
    const orgRoute = readFileSync(
      join(REPO, "packages/hub/src/http/org.ts"),
      "utf8",
    );
    expect(orgRoute).toMatch(/\{[\s\S]{0,40}error,\s*issues\s*\}/u);
    expect(orgRoute).toMatch(
      /\{[\s\S]{0,40}error:\s*r\.reason,\s*code:\s*r\.code\s*\}/u,
    );
  });
});
