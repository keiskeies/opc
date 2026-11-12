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
import { TASK_STATES } from "../../packages/hub/src/graph/status.js";
import { APPROVAL_TYPES } from "../../packages/hub/src/approvals/cards.js";

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
    const hits = TASK_STATES.filter((s) => new RegExp(`["'\`]${s}["'\`]`, "u").test(appCode));
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
    const hits = APPROVAL_TYPES.filter((t) => new RegExp(`["'\`]${t}["'\`]`, "u").test(appCode));
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
    expect(at, "app.js 里找不到 function driverLine ⇒ 这一发起码要先红在这里").toBeGreaterThan(-1);
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
    for (const shape of ["DriverTurnAbandoned", "DriverTurnClaimed", "driverCellTarget"]) {
      expect(appCode, shape).not.toContain(shape);
    }
  });

  it("statusClass() 里只有【小写片段】，没有整名 —— 它是呈现映射不是判据", () => {
    // app.js 文件头自己声明了「statusClass 按状态名子串上色，那是呈现映射」，
    // 这一发把那句声明钉住：那批片段必须是小写碎片，
    // 否则哪天有人把 "ESCALATED_TO_CEO" 整名塞进 if 里，它就变成判据了
    //（而上面那条只会报"出现状态名"，报不到"这个函数越权"这一层）。
    const body = appCode.slice(appCode.indexOf("function statusClass"));
    const frags = [...body.slice(0, 900).matchAll(/x\.includes\("([^"]+)"\)/gu)].map((m) => String(m[1]));
    expect(frags.length).toBeGreaterThan(3);
    for (const f of frags) {
      expect(f, f).toBe(f.toLowerCase());
      expect(TASK_STATES).not.toContain(f.toUpperCase());
    }
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
    const got = amberSelectors(":root { --x: 1px; } .a { color:var(--amber); } .b { color:var(--blue); }");
    expect(got).toEqual([".a"]);
    // 反向：把 var 换成裸色值也必须能识别成"这一条不含 var(--amber)"（不能因为
    // 提取失败而把一条本该出现的规则静默丢掉 ⇒ 漏报）。
    expect(amberSelectors(".z { color: #E8A33D; }")).toEqual([]);
  });

  it("var(--amber) 只出现在名单里那几个选择器上（多一处就红，并指名是哪一处）", () => {
    const css = htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>"));
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
    const css = stripCssComments(htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")));
    // 每条都是「选择器 → 不许出现的属性值」。写成数据而不是三条 expect，
    // 是因为报错要能指回规格那一句。
    const banned: Array<[string, string]> = [
      [".tk.flag", "成员身份不是「等你动手」（§16.4 那一列含预算暂停，规格明写非琥珀）"],
      [".card.flag", "运营事件卡片（§7.4 原话：非琥珀色的预算暂停卡片）"],
      [".banner.warn", "取不到数据不是等谁决策"],
      [".ev.decide::before", "回放里的人工决定是【已经拍过板】的记录"],
      [".pill.s-gray", "警报已哑那一格：它本身就是「警报没了」，配警报色自相矛盾"],
    ];
    for (const [sel, why] of banned) {
      const re = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^{}]*)\\}`, "u");
      const m = re.exec(css);
      expect(m, `名单里的选择器 ${sel} 在 CSS 里找不到了 ⇒ 这条守卫本身该重读`).not.toBeNull();
      expect(String(m?.[1]), `${sel} 不许用琥珀：${why}`).not.toContain("var(--amber)");
    }
  });

  it("红色的落点逐处钉住（§19.2 那张色表里【没有】「异常色」这一档）", () => {
    const css = stripCssComments(htmlSrc.slice(htmlSrc.indexOf("<style>"), htmlSrc.indexOf("</style>")));
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
    expect(users).toEqual([".banner.err", ".budgetover .meter.over i", ".dot.off", ".err"].sort());
  });
});
