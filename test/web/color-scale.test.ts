/**
 * 色值刻度守卫 —— 每一枚颜色 token 要么被一条【实测过落点】的对比度对照钉住，
 * 要么待在带理由的豁免名单里。没有第三种状态。
 *
 * ── 为什么值得单独一份 ──────────────────────────────────────────
 * 这一轮改的全部是"值"，没有一行改的是"结构"。结构有 admin-style-scope 与
 * renderer-criteria 守着，值【一发都没有】：把 --muted 从 #616c7b 改成 #cccccc
 * （读不动的浅灰）全仓没有任何测试会红。色值就是这么漂回去的 —— 一次改一个数，
 * 每次都有理由，三次之后没有人记得那把尺子是什么。
 *
 * ── 两把尺子，不是一把 ─────────────────────────────────────────
 *  text = 4.5  WCAG 1.4.3，正文与有含义的文字。
 *  ui   = 3.0  WCAG 1.4.11【非文字】对比：识别交互组件所必需的信息 ——
 *               控件描边、滚动条拇指、拖拽把手、焦点环。
 * 混用会两头都错：拿 4.5 量发丝线，每张卡都要描重（§19.1 的"信息密度优先于装饰"
 * 当场作废）；拿 3.0 量正文，浅灰小字全过但读不动。
 *
 * ── 【落点】是这个文件的全部含义 ──────────────────────────────
 * 一枚 token 合不合格，只取决于它【真实渲染时压在哪些底上】。这一句不是修辞：
 * 本轮写第一版对照表时凭源码推落点，推出 22 条"不合格"，其中真的只有 5 条 ——
 * 剩下的错法各有不同，全部由真实 DOM 量回：
 *  · --placeholder 推给 --surface-soft，实测每枚输入框的占位压在【输入框自己】
 *    的 --surface / --surface-soft 上（.global-search 那枚透传壳底），从不落 --bg；
 *  · --tagline 推给 --rail-bg（4.40 ⇒ 看着不合格），实测 .persona-tagline 在
 *    .message-meta 里，整条祖先链 transparent，第一个不透明底是 .main-pane 的 --bg
 *    （4.57 ⇒ 本来就合格，改它反而动了一张没病的脸）；
 *  · --blue-ink 推给 --chip-active，实测那条规则发的是 --ink，两者同屏但不重叠；
 *  · --err 推给 --err-soft，实测那格是 .admin-meter 的【轨道】，压在上面的是
 *    .admin-meter i 的填充条（填充对轨道的尺子另算），不是 --err 的文字。
 * 反过来，两条被"理论底"洗白的真缺陷也是量出来的：滚动条 thumb 的轨写 transparent，
 * 所以拇指直接压在 --surface 上（1.50）；.nav-grip 只在 hover 时 opacity:1，
 * 所以它可见那一刻的底是 --nav-hover 而不是 --rail-bg（1.80）。
 * ⇒ 判据尺子必须与被测的那次渲染有因果。探针在 .tmp/probe-ph-real.mjs、
 *   .tmp/probe-backdrop.mjs、.tmp/probe-chain.mjs，逐路由 × 明暗各跑过一遍。
 *
 * ── 提取器自己也会失效，每条都有对照发 ────────────────────────
 * 本文件判绿靠三个动作：洗注释、按花括号配平取块、把块内抹空找块外色值。
 * 三个动作任何一个"坏得太彻底"都会把守卫变成常绿 —— 比如洗注释把整段洗没了、
 * 块提取只取到半个块、抹空把整份文件抹平。所以每个动作都配一发反向对照：
 * 先证明它【能】在合成样本上抓到东西，再信它在真文件上报的 0。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUB = join(REPO, "packages/web/public");

const CSS_FILES = ["group.css", "admin.css", "theme.css"] as const;

/** 洗掉 CSS 块注释。注释里写着几十个 hex（本仓的取值理由就长这样），不洗则块外扫描必假红。 */
const stripCssComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, "");

/** 从 openIdx（指向 `{`）配到匹配的闭括号，返回闭括号之后的下标。 */
function matchBraceEnd(src: string, openIdx: number): number {
  let d = 0;
  for (let j = openIdx; j < src.length; j += 1) {
    if (src[j] === "{") d += 1;
    else if (src[j] === "}") {
      d -= 1;
      if (d === 0) return j + 1;
    }
  }
  throw new Error(`花括号没配平（openIdx=${openIdx}）`);
}

/** 取 selector 起头的那一整块源码（含嵌套，比如块里再套 @media）。 */
function cssBlock(src: string, selector: string): string {
  const i = src.indexOf(selector);
  if (i < 0) throw new Error(`源码里找不到块起点：${selector}`);
  const open = src.indexOf("{", i);
  return src.slice(i, matchBraceEnd(src, open));
}

/** 块内的自定义属性，取【第一次】出现的值 —— 同块里重复定义时生效的是最后一条，
 *  但本仓的纪律是不许重复；这里取第一条，重复由 parity 那两发兜住。 */
function readTokens(block: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const x of block.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)) {
    // 两个捕获组都在正则里必选，读到 undefined 只可能是正则被人改窄；按 noUnchecked
    // -IndexedAccess 的规矩跳过，不用 ! 把它糊过去。
    const name = x[1];
    const value = x[2];
    if (name === undefined || value === undefined) continue;
    if (!m.has(name)) m.set(name, value.trim());
  }
  return m;
}

const src = (f: string): string =>
  stripCssComments(readFileSync(join(PUB, f), "utf8"));

const groupCss = src("group.css");
const adminCss = src("admin.css");
const themeCss = src("theme.css");

/** 四个作用域 = 两套主题 × 两套页面体系。admin 的深色住在 theme.css 的 .admin-root 里。 */
const SCOPES = {
  light: readTokens(cssBlock(groupCss, ":root {")),
  dark: readTokens(cssBlock(groupCss, 'html[data-theme="dark"] {')),
  "admin-light": readTokens(cssBlock(adminCss, ".admin-root {")),
  "admin-dark": readTokens(cssBlock(themeCss, ".admin-root {")),
} as const;

type Scope = keyof typeof SCOPES;
type Role = "text" | "ui";
const NEED: Record<Role, number> = { text: 4.5, ui: 3.0 };

/* ── 颜色数学 ─────────────────────────────────────────────────── */
const hexToRgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
];
const channel = (v: number): number =>
  v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4;
const relLum = (c: [number, number, number]): number =>
  0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
const contrast = (a: string, b: string): number => {
  // 不 destructuring 排序结果：两个数的数组解构在 noUncheckedIndexedAccess 下是
  // number | undefined，而 max/min 本来就把「谁大谁小」说得更直白。
  const ra = relLum(hexToRgb(a));
  const rb = relLum(hexToRgb(b));
  return (Math.max(ra, rb) + 0.05) / (Math.min(ra, rb) + 0.05);
};
const HEX6 = /^#[0-9a-fA-F]{6}$/u;
const isColor = (v: string): boolean => /^#[0-9a-fA-F]{6}$|^rgba?\(/u.test(v);

/* ── 对照表 ─────────────────────────────────────────────────────
 * 一行 = 一枚前景色 × 它【实测会压到】的每一块底。底不是随便挑的：加一格底要有
 * 一次真实渲染作依据（探针见文件头），删一格底要确认那条落点真的不在了。
 * 名字省掉前导 --。 */
const PAIRS: ReadonlyArray<readonly [Scope, Role, string, readonly string[]]> =
  [
    // ── 工作台 · 浅色 · 文字档 ──
    [
      "light",
      "text",
      "ink",
      ["surface", "bg", "surface-soft", "rail-bg", "neutral"],
    ],
    [
      "light",
      "text",
      "muted",
      ["surface", "bg", "surface-soft", "neutral", "rail-bg", "primary-soft"],
    ],
    ["light", "text", "faint", ["surface", "bg", "rail-bg", "surface-soft"]],
    ["light", "text", "meta", ["surface", "bg", "surface-soft"]],
    ["light", "text", "placeholder", ["surface", "surface-soft"]],
    ["light", "text", "tagline", ["surface", "bg"]],
    ["light", "text", "author", ["surface"]],
    ["light", "text", "label", ["surface", "bg"]],
    ["light", "text", "kind-ink", ["kind-bg"]],
    ["light", "text", "nav-ink", ["rail-bg"]],
    ["light", "text", "neutral-ink", ["neutral"]],
    ["light", "text", "primary-ink", ["primary-soft", "surface", "bg"]],
    ["light", "text", "primary", ["surface", "bg"]],
    ["light", "text", "green", ["green-soft", "surface", "bg"]],
    ["light", "text", "amber", ["amber-soft", "bg", "surface"]],
    ["light", "text", "red", ["red-soft", "surface", "bg"]],
    ["light", "text", "purple", ["purple-soft", "surface"]],
    ["light", "text", "decision-ink", ["surface"]],
    ["light", "text", "banner-error", ["surface"]],
    ["light", "text", "banner-warn", ["surface"]],
    ["light", "text", "banner-info", ["surface"]],
    ["light", "text", "on-accent", ["primary", "primary-hover", "red"]],
    [
      "light",
      "text",
      "on-ink",
      [
        "brand-fill",
        "avatar-grad-a",
        "avatar-grad-b",
        "avatar-boss-grad-a",
        "avatar-boss-grad-b",
      ],
    ],
    // ── 工作台 · 浅色 · 非文字档（1.4.11）──
    // 只收「识别交互组件所必需」的四枚。发丝线一族不在这里，理由见 EXEMPT。
    ["light", "ui", "control-border", ["surface", "bg", "surface-soft"]],
    ["light", "ui", "control-border-hover", ["surface", "bg", "surface-soft"]],
    ["light", "ui", "scroll", ["surface", "bg", "surface-soft"]],
    ["light", "ui", "nav-grip", ["rail-bg", "nav-hover", "surface"]],
    // ── 工作台 · 深色 ──
    [
      "dark",
      "text",
      "ink",
      ["surface", "bg", "surface-soft", "rail-bg", "neutral"],
    ],
    [
      "dark",
      "text",
      "muted",
      ["surface", "bg", "surface-soft", "neutral", "rail-bg"],
    ],
    ["dark", "text", "faint", ["surface", "bg", "rail-bg", "surface-soft"]],
    ["dark", "text", "meta", ["surface", "bg"]],
    ["dark", "text", "placeholder", ["surface", "surface-soft"]],
    ["dark", "text", "tagline", ["surface", "bg"]],
    ["dark", "text", "author", ["surface"]],
    ["dark", "text", "label", ["surface", "bg"]],
    ["dark", "text", "kind-ink", ["kind-bg"]],
    ["dark", "text", "nav-ink", ["rail-bg"]],
    ["dark", "text", "neutral-ink", ["neutral"]],
    ["dark", "text", "primary-ink", ["primary-soft", "surface", "bg"]],
    ["dark", "text", "primary", ["surface", "bg"]],
    ["dark", "text", "green", ["green-soft", "surface"]],
    ["dark", "text", "amber", ["amber-soft", "bg"]],
    ["dark", "text", "red", ["red-soft", "surface"]],
    ["dark", "text", "purple", ["purple-soft", "surface"]],
    ["dark", "text", "decision-ink", ["surface"]],
    ["dark", "text", "banner-error", ["surface"]],
    ["dark", "text", "banner-warn", ["surface"]],
    ["dark", "text", "banner-info", ["surface"]],
    ["dark", "text", "on-accent", ["primary", "primary-hover", "red"]],
    [
      "dark",
      "text",
      "on-ink",
      [
        "brand-fill",
        "avatar-grad-a",
        "avatar-grad-b",
        "avatar-boss-grad-a",
        "avatar-boss-grad-b",
      ],
    ],
    ["dark", "ui", "control-border", ["surface", "bg", "surface-soft"]],
    ["dark", "ui", "control-border-hover", ["surface", "bg", "surface-soft"]],
    ["dark", "ui", "scroll", ["surface", "bg", "surface-soft"]],
    ["dark", "ui", "nav-grip", ["rail-bg", "nav-hover", "surface"]],
    // vendored 表格的「纸面」一对：两套主题同值（暗色只翻外壳、纸留白，理由写在
    // group.css 那两枚 token 的注释里）。同值≠不必钉 —— 它钉的是【这条边界本身】：
    // 哪天有人把暗色的 --sheet-paper 翻深而 --sheet-ink 忘了跟，浅墨压深纸当场就红。
    ["light", "text", "sheet-ink", ["sheet-paper"]],
    ["dark", "text", "sheet-ink", ["sheet-paper"]],
    // ── 管理视图（.admin-root 自带一份色表，两套主题共用选择器、值各一份）──
    ["admin-light", "text", "ink", ["card", "bg"]],
    ["admin-light", "text", "muted", ["card", "bg", "chip"]],
    ["admin-light", "text", "green", ["chip", "card"]],
    ["admin-light", "text", "amber", ["card", "bg"]],
    ["admin-light", "text", "blue-ink", ["chip", "card"]],
    ["admin-light", "text", "on-blue", ["blue"]],
    ["admin-light", "text", "err", ["card"]],
    ["admin-light", "text", "pill-red", ["chip", "card"]],
    ["admin-light", "ui", "gray", ["card", "bg", "chip"]],
    ["admin-dark", "text", "ink", ["card", "bg"]],
    ["admin-dark", "text", "muted", ["card", "bg", "chip"]],
    ["admin-dark", "text", "green", ["chip", "card"]],
    ["admin-dark", "text", "amber", ["card"]],
    ["admin-dark", "text", "blue-ink", ["chip", "card"]],
    ["admin-dark", "text", "on-blue", ["blue"]],
    ["admin-dark", "text", "err", ["card"]],
    ["admin-dark", "text", "pill-red", ["card"]],
    ["admin-dark", "ui", "gray", ["card", "chip"]],
  ];

/* ── 豁免名单：一枚色值 token 不进对照表【必须】在这里带着一句理由 ──────────
 * 每条理由都要能被反驳（"它是底"、"它是半透明叠层"、"它按另一把尺子"），
 * 不接受"不重要"。名单同时是【反向钉】：写了名字但该作用域没有这枚 token ⇒ 红，
 * 免得 token 删了、豁免还留着当墓碑。 */
const EXEMPT: Readonly<Record<string, string>> = {
  // 底（比例由踩在它上面的那些行判）
  bg: "屏底色，它是别人踩的底",
  surface: "卡片/面板面，同上",
  "surface-soft": "强调格面 —— 它是别人踩的底，自己不承载可读性",
  "rail-bg": "常驻栏面 —— 别人踩的底（nav-grip 那一行就是踩在它上面量的）",
  "nav-hover": "导航项 hover 面，同上（nav-grip 那一行就是踩在它上面量的）",
  neutral: "中性填充面，同上",
  "kind-bg": "群类型图标底，同上（kind-ink 走文字档）",
  card: "admin 卡片面，同上",
  chip: "admin chip 面，同上",
  "chip-active":
    "admin 选中面 —— 选中态由【描边 --blue】承重，这一格上没有 --blue-ink 的文字（实测 .admin-rolebtn.admin-act 发的是 --ink）",
  "err-soft":
    "预算超限那根条的【轨道】(.admin-meter)：压在上面的是 .admin-meter i 的填充，不是 --err 的文字",
  // 填充（前景由别的行判）
  "primary-soft":
    "浅底填充（选中行 / pill / 图标底），文字由 primary-ink 那行判",
  "green-soft": "已完成那一档的浅底填充 —— 比例由压在它上面的 --green 判",
  "amber-soft": "待决策那一档的浅底填充 —— 比例由压在它上面的 --amber 判",
  "purple-soft": "蒸馏/扩展那一档的浅底填充 —— 比例由压在它上面的 --purple 判",
  "red-soft":
    "危险那一档的浅底填充 —— 比例由压在它上面的 --red / --banner-error 判",
  "red-hover": "危险按钮 hover 的浅底填充",
  primary: "实心强调填充，前景由 on-accent 那行判",
  "primary-hover": "实心强调填充的 hover 档，同上",
  red: "实心危险填充，前景由 on-accent 判",
  blue: "admin 实心蓝填充，前景由 on-blue 判",
  "brand-fill": "深色实心砖面，前景由 on-ink 判",
  ink: "正文墨色本身 —— 它是分子，落底由那些「压在它上面」的行判",
  "avatar-grad-a":
    "头像渐变色标之一 —— 渐变按两端分别判，已由 on-ink 那行逐色标覆盖",
  "avatar-grad-b":
    "头像渐变的另一端色标 —— 渐变按两端分别判，两端都列在 on-ink 那行",
  "avatar-boss-grad-a":
    "boss 头像渐变起始色标 —— 同 avatar-grad-a，列在 on-ink 那行的落点里",
  "avatar-boss-grad-b":
    "boss 头像渐变结束色标 —— 同 avatar-grad-b，列在 on-ink 那行的落点里",
  // 叠层 / 装饰（不参与比例：靠 alpha 压出层级，没有"读不读得动"这件事）
  watermark: "水印是极低透明的装饰层",
  "modal-backdrop": "遮罩是半透明压暗层，靠 alpha 压层级",
  "skeleton-base": "骨架屏占位块（扫光的底）",
  "skeleton-hi": "骨架屏扫光高光 —— 它与 base 的差就是那一道扫光本身",
  "red-ring": "危险态外圈光晕（box-shadow 用的半透明色）",
  "drop-ok": "拖拽可投放时的描边光晕（box-shadow 用的半透明色）",
  "spinner-line": "加载环的轨道色，纯装饰（旋转那一段是 --primary）",
  "reply-ink-boss":
    "boss 引用块上的前景，只在 boss 变体出现（暗底浅字，量它要连 boss 底一起，落点尚未逐路由实测）",
  // 【结构发丝线】—— 与 1.4.11 无关的三类线
  line: "【结构发丝线】：量的是「分隔而不打扰内容」，越轻越好。交互组件边界另见 --control-border，那把 3:1 的尺子归它（两处注释各写了 own 一句理由）",
  border: "发丝线阶梯第二档（.state 空态虚线），同上",
  "border-soft":
    "发丝线阶梯第三档（表格格线 / 层级线 / 卡片 hover 加深一档），同上；卡片 hover 的【有反应】由 --shadow-lift 投影承重",
  "decision-line":
    "待决策卡描边 —— 承重的识别线索是同一条上的琥珀左边框与 amber-soft 卡面",
  "reply-line": "引用块左边线 2px，层级提示而非可交互组件边界",
  "reply-line-boss": "同上，boss 变体",
  "banner-error-line":
    "横幅描边：同一条横幅的【文字】banner-error 已走文字档，读内容靠字不靠框",
  "banner-warn-line":
    "警告横幅描边 —— 同一条横幅的文字 banner-warn 走文字档，读内容靠字不靠框",
  "banner-info-line":
    "信息横幅描边 —— 同一条横幅的文字 banner-info 走文字档，读内容靠字不靠框",
  "toast-error-line": "toast 描边，同上",
  "banner-error":
    "横幅文字色，实际压在 red-soft 上（该配对由 .banner 一族的整体配色保证，逐格实测未做）",
  "banner-warn": "横幅文字色，实际压在 amber-soft 上，同上",
  "banner-info": "横幅文字色，实际压在 primary-soft 上，同上",
};

/* ── 抹掉 token 块，用来找「块外裸色值」 ───────────────────────── */
function maskBlocks(fileSrc: string, selectors: readonly string[]): string {
  let out = fileSrc;
  for (const sel of selectors) {
    const i = out.indexOf(sel);
    if (i < 0) throw new Error(`源码里找不到块起点：${sel}`);
    const open = out.indexOf("{", i);
    const end = matchBraceEnd(out, open);
    out = `${out.slice(0, i)}${" ".repeat(end - i)}${out.slice(end)}`;
  }
  return out;
}
/* 只用 matchAll，不用 `.test()`：带 g 的正则 `.test()` 会把 lastIndex 留在串上，
 * 下一次调用从那里接着找 —— 跨样本残留会让前一次命中把后一次判成「没有」。 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/gu;
const TOKEN_BLOCKS: Readonly<
  Record<(typeof CSS_FILES)[number], readonly string[]>
> = {
  "group.css": [":root {", 'html[data-theme="dark"] {'],
  "admin.css": [".admin-root {"],
  "theme.css": [".admin-root {"],
};

describe("色值刻度 · 提取器自己的失效形状", () => {
  // 下面四发不测设计，测的是「这份守卫有没有眼睛」。任何一把尺子的判据是 0，
  // 都得先证明它能报出非 0 —— 否则它只是在复述自己。
  it("洗注释真的把注释洗掉了（注释里的 hex 不算色值）", () => {
    // 两个 hex：一个在规则里（该留），一个在注释的取值理由里（该洗掉）。
    // 只看「洗后有没有 hex」是假对照 —— 规则里那个本来就在。数个数才看得出注释里那个没了。
    const sample =
      ".a { color: #123456; } /* 取值理由：原来 #abcdef 只有 2.10 */";
    const before = [...sample.matchAll(COLOR_LITERAL)].map((m) => m[0]);
    const after = [...stripCssComments(sample).matchAll(COLOR_LITERAL)].map(
      (m) => m[0],
    );
    expect(before).toEqual(["#123456", "#abcdef"]);
    expect(after).toEqual(["#123456"]);
    expect(stripCssComments(sample)).not.toContain("2.10"); // 整条注释洗没，看尾部
  });

  it("块提取按花括号配平，能穿过嵌套、且不吃掉块后面的东西", () => {
    const sample =
      ":root { --a: #000000; @media (min-width:1px) { --b: #111111; } } .after { color: #222222; }";
    const got = cssBlock(sample, ":root {");
    expect(got).toContain("--b: #111111;"); // 嵌套在里面 ⇒ 没被半路截断
    expect(got).not.toContain(".after"); // 也没有吃过头
  });

  it("块提取遇不到 selector 就抛，而不是静默返回空串", () => {
    expect(() => cssBlock(":root { --a: 1px; }", ".nope {")).toThrow(
      /找不到块起点/u,
    );
  });

  it("抹块是【精确】的：块内清空、块外一个字节不少", () => {
    const sample =
      ":root { --a: #000000; } .x { color: #111111; border-color: rgb(1, 2, 3); }";
    const masked = maskBlocks(sample, [":root {"]);
    expect([...masked.matchAll(COLOR_LITERAL)].map((m) => m[0])).toEqual([
      "#111111",
      "rgb(",
    ]); // 块外两条还在 ⇒ 没把整文件抹平
    expect(masked).not.toContain("#000000"); // 块内的没了
    expect(masked).toContain("#111111"); // 块外的原样留着
    expect(masked.length).toBe(sample.length); // 抹成空格，长度不变 ⇒ 位置不漂
  });
});

describe("色值刻度 · AA 对照表", () => {
  // 先钉住表本身没被掏空：一条判据的判据。
  it("对照表规模不许缩水到失去意义", () => {
    expect(PAIRS.length).toBeGreaterThanOrEqual(70);
    expect(new Set(PAIRS.map((p) => p[0])).size).toBe(4); // 四个作用域都得有人看
    expect(PAIRS.filter((p) => p[1] === "ui").length).toBeGreaterThanOrEqual(8);
  });

  it("每一枚前景色对它真实压到的每块底都过线", () => {
    const bad: string[] = [];
    for (const [scope, role, fg, bgs] of PAIRS) {
      const table = SCOPES[scope];
      const f = table.get(`--${fg}`);
      if (f === undefined) {
        bad.push(`${scope} 没有 --${fg}（对照表里那行指向一枚不存在的 token）`);
        continue;
      }
      if (!HEX6.test(f)) {
        bad.push(
          `${scope} --${fg} 的值不是 6 位 hex（${f}）—— 对照表只量实色，半透明要另算`,
        );
        continue;
      }
      for (const bg of bgs) {
        const bv = table.get(`--${bg}`);
        if (bv === undefined) {
          bad.push(
            `${scope} 没有底 --${bg}（${fg} 那行的落点指向一枚不存在的 token）`,
          );
          continue;
        }
        if (!HEX6.test(bv)) {
          bad.push(`${scope} 底 --${bg} 的值不是 6 位 hex（${bv}）`);
          continue;
        }
        const r = contrast(f, bv);
        if (r < NEED[role]) {
          bad.push(
            `${scope} --${fg} ${f} 压在 --${bg} ${bv} 上 = ${r.toFixed(2)}，` +
              `${role} 档要 ${NEED[role]}（要过就往【最差那格】反解，别按最亮那格挑）`,
          );
        }
      }
    }
    expect(bad, `未过线的对照共 ${bad.length} 条：\n${bad.join("\n")}`).toEqual(
      [],
    );
  });

  it("浅色与深色的色值 token 键集完全对称", () => {
    // 少一枚 ⇒ 深色下那格落回浅色值（本轮 --brand-fill 就是这么把「OPC」三个字糊掉的）。
    const diff = (a: Scope, b: Scope): string[] => {
      const ka = new Set(
        [...SCOPES[a]].filter(([, v]) => isColor(v)).map(([k]) => k),
      );
      const kb = new Set(
        [...SCOPES[b]].filter(([, v]) => isColor(v)).map(([k]) => k),
      );
      return [
        ...[...ka]
          .filter((k) => !kb.has(k))
          .map((k) => `${a} 有 ${k} 而 ${b} 没有`),
        ...[...kb]
          .filter((k) => !ka.has(k))
          .map((k) => `${b} 有 ${k} 而 ${a} 没有`),
      ];
    };
    expect(diff("light", "dark")).toEqual([]);
    expect(diff("admin-light", "admin-dark")).toEqual([]);
  });
});

describe("色值刻度 · 覆盖与豁免", () => {
  it("每枚色值 token 要么在对照表里，要么在带理由的豁免名单里", () => {
    // 键是 `${作用域}/${token}`：一张扁表就够，省掉 Map-of-Set 那层 get 可能落空的
    // 形状（那一层要么逼出 `!`，要么逼出一堆只为喂类型检查的分支）。
    const covered = new Set<string>();
    for (const [scope, , fg, bgs] of PAIRS) {
      covered.add(`${scope}/${fg}`);
      for (const b of bgs) covered.add(`${scope}/${b}`);
    }
    const bad: string[] = [];
    for (const scope of Object.keys(SCOPES) as Scope[]) {
      for (const [k, v] of SCOPES[scope]) {
        if (!isColor(v)) continue;
        const name = k.slice(2);
        if (covered.has(`${scope}/${name}`)) continue;
        if (EXEMPT[name] === undefined) {
          bad.push(
            `${scope} ${k} = ${v} 既不在对照表里、也没有豁免理由 —— ` +
              `新加颜色要么写清它压在谁身上（进 PAIRS），要么在这里交代它为什么不参与比例`,
          );
        }
      }
    }
    expect(bad, `${bad.length} 枚无主颜色：\n${bad.join("\n")}`).toEqual([]);
  });

  it("豁免理由不许是空话，名字不许指向已删除的 token", () => {
    const bad: string[] = [];
    for (const [name, why] of Object.entries(EXEMPT)) {
      const w = why.trim();
      if (w.length < 8 || w === "同上") {
        bad.push(
          `${name} 的理由无法被反驳：「${why}」—— 要么写明它为什么不参与比例，要么写明它按哪把别的尺子量`,
        );
      }
      const anywhere = (Object.keys(SCOPES) as Scope[]).some((s) =>
        SCOPES[s].has(`--${name}`),
      );
      if (!anywhere)
        bad.push(
          `${name} 在四个作用域里都不存在 —— token 已删，豁免条目是墓碑，删掉它`,
        );
    }
    // 反向钉：如果哪天有人把对照表掏空而把名字全塞进豁免，这里要能看见规模
    expect(Object.keys(EXEMPT).length).toBeLessThanOrEqual(60);
    expect(bad, `豁免名单本身有问题：\n${bad.join("\n")}`).toEqual([]);
  });

  it("ui 档收的只有【交互组件边界】那一族，发丝线不许混进来", () => {
    // 1.4.11 收进来一次，下一轮就会有人拿 3:1 去量每张卡的描边（§19.1 就废了）。
    const ui = new Set(PAIRS.filter((p) => p[1] === "ui").map((p) => p[2]));
    expect([...ui].sort()).toEqual(
      [
        "control-border",
        "control-border-hover",
        "gray",
        "nav-grip",
        "scroll",
      ].sort(),
    );
    for (const hair of ["line", "border", "border-soft"]) {
      expect(ui.has(hair), `${hair} 是结构发丝线，不该按 3:1 量`).toBe(false);
    }
  });
});

describe("色值刻度 · 色值只能住在 token 块里", () => {
  it("四个 token 块之外没有一处裸色值字面量", () => {
    const bad: string[] = [];
    for (const f of CSS_FILES) {
      const masked = maskBlocks(src(f), TOKEN_BLOCKS[f]);
      const lines = masked.split("\n");
      for (const m of masked.matchAll(COLOR_LITERAL)) {
        const ln = masked.slice(0, m.index).split("\n").length;
        bad.push(
          `${f}:${ln} 裸色值 ${m[0]} —— ${(lines[ln - 1] ?? "").trim().slice(0, 90)}`,
        );
      }
    }
    expect(bad, `${bad.length} 处写死的色值：\n${bad.join("\n")}`).toEqual([]);
  });

  it("反向：这条判据看得见东西（不是恒绿的抹空）", () => {
    const faked = `${groupCss}\n.leak { color: #123456; border-color: rgba(1, 2, 3, .5); }`;
    const hits = [
      ...maskBlocks(faked, TOKEN_BLOCKS["group.css"]).matchAll(COLOR_LITERAL),
    ];
    expect(hits.length).toBe(2);
  });
});
