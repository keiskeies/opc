/**
 * admin.css 的结构守卫 + 类名双向钉。
 *
 * 守的是 admin.css 头部那两条机器约定：每条选择器以 `.admin-root` 开头、
 * 类名一律 `admin-` 前缀；再加双向对账 —— CSS 有而没人发的类（死样式）与
 * app.js 发了而 CSS 没有的类（静默 no-op），两边都红。
 *
 * 为什么值得单独一份：管理视图现在挂在 group.html 的三栏里，与工作台同处一个
 * document。工作台那边有 `.btn` / `.card` / `.row` / `.grid` 这批通用名，
 * 管理视图以前也用过同一批短名 —— 谁覆盖谁取决于加载顺序。前缀 + 作用域
 * 把这条歧义机械消掉：名字不撞，选择器也进不去对方的子树。
 *
 * 这一轮它真抓到过东西（不是装饰性守卫）：双向半边第一次跑就报出三个 app.js
 * 发了、CSS 却没规则的类名 `.chip` / `.ghost` / `.ev-none`。最实在的是 `.chip` ——
 * 今日页窗口 chip 的选中态写的是 `.admin-act`，而那条规则限定在 `nav a` 下面，
 * chip 上的高亮从来没生效过，全仓也没有一条测试因此变红。三条已落成 admin- 前缀类。
 *
 * 提取器自己的失效形状都有对照发（见各 describe 最后一条）：注释里的类名会
 * 洗白死样式；@media 里的选择器若按花括号粗暴切段，会漏判同时假报。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const ADMIN_CSS = join(REPO, "packages/web/public/admin.css");
const APP_JS = join(REPO, "packages/web/public/app.js");
const GROUP_JS = join(REPO, "packages/web/public/group.js");

const stripCssComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, "");
/** JS 注释：块注释 + 整行 //。行尾 // 不剥（`https://` 会被剪断字符串）。 */
const stripJsComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");

/** 从 openIdx（指向 `{`）配到闭括号，返回闭括号下标。 */
function matchBrace(src: string, openIdx: number): number {
  let d = 1;
  let j = openIdx + 1;
  for (; j < src.length && d > 0; j += 1) {
    if (src[j] === "{") d += 1;
    else if (src[j] === "}") d -= 1;
  }
  return j - 1;
}

/**
 * 只【读】选择器的调用点。它们不是发射方，得先从源码里抹掉 ——
 * 否则「CSS 有规则、代码只 querySelector 从不 add」的死样式会被洗白。
 */
function stripSelectorReads(src: string): string {
  return src
    .replace(/querySelectorAll?\(\s*"[^"]*"\s*\)/gu, "READ()")
    .replace(/\.closest\(\s*"[^"]*"\s*\)/gu, "READ()")
    .replace(/\.matches\(\s*"[^"]*"\s*\)/gu, "READ()");
}

/**
 * 把 CSS 拆成选择器清单。手写游标而不是 matchAll 那段正则：后者会把 @media
 * 体内的选择器在外层扫一遍、递归里再扫一遍（数出两次），所以条件组命中后
 * 直接把它的体重置为已消费。
 */
function cssSelectors(css: string): string[] {
  const text = stripCssComments(css);
  const sels: string[] = [];
  const walk = (t: string): void => {
    let i = 0;
    while (i < t.length) {
      const brace = t.indexOf("{", i);
      if (brace < 0) return;
      const head = t.slice(i, brace).trim().replace(/\s+/gu, " ");
      const close = matchBrace(t, brace);
      if (head.startsWith("@")) walk(t.slice(brace + 1, close));
      else if (head !== "") sels.push(head);
      i = close + 1;
    }
  };
  walk(text);
  return sels;
}

/** 选择器里的类名。 */
function classesIn(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/gu)].map(
    (m) => m[1] ?? "",
  );
}

/**
 * 扫出一个 class 属性的内容。不能用 `class="([^"]*)"` ：模板里
 * `class="admin-meter${over ? " admin-over" : ""}"` 的内层引号会把正则截断，
 * admin-over 这类条件类名整个丢掉 —— 而条件类名恰是这一族里唯一带颜色语义的
 * 那一半（超限红条、琥珀卡）。所以配对手工扫：${} 内部的引号不算属性结束。
 */
function readClassAttr(
  src: string,
  from: number,
): { body: string; end: number } {
  let body = "";
  let i = from;
  while (i < src.length) {
    if (src[i] === "$" && src[i + 1] === "{") {
      const close = matchBrace(src, i + 1);
      body += src.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    if (src[i] === '"') return { body, end: i + 1 };
    body += src[i];
    i += 1;
  }
  return { body, end: src.length };
}

/**
 * app.js 发射的类名，三处来源缺一不可：
 *  1. class 属性 —— 按属性区间扫。不能先把整段 ${} 挖掉：那样会把 class 自己
 *     就嵌在外层插值里的那些（组织页角色按钮、窗口 chip 都在 map 回调的模板里）
 *     连发射点一起挖没，守卫就悄悄漏一批发射点。
 *  2. class 之外的 `"admin-x"` 字面量：classList.add/toggle、className，以及
 *     `const cls = a ? "admin-auto" : "admin-decide"` 这种由变量携带的。
 *  3. 属性内 ${} 两支字符串（条件类名）。
 * 末尾带 - 的碎片（`"admin-" + tone`）不算类名。
 */
function emittedClasses(js: string): Set<string> {
  const src = stripSelectorReads(stripJsComments(js));
  const out = new Set<string>();
  const addTokens = (s: string): void => {
    for (const tok of s.split(/[\s"'`()]+/u)) {
      if (/^[a-z][A-Za-z0-9_-]*$/u.test(tok) && !tok.endsWith("-"))
        out.add(tok);
    }
  };
  for (let i = 0; i < src.length; i += 1) {
    if (!src.startsWith('class="', i)) continue;
    const { body, end } = readClassAttr(src, i + 'class="'.length);
    i = end - 1;
    let statics = "";
    let k = 0;
    while (k < body.length) {
      if (body[k] === "$" && body[k + 1] === "{") {
        const close = matchBrace(body, k + 1);
        for (const lit of body.slice(k + 2, close).matchAll(/"([^"]*)"/gu)) {
          addTokens(lit[1] ?? "");
        }
        statics += " ";
        k = close + 1;
        continue;
      }
      statics += body[k];
      k += 1;
    }
    addTokens(statics);
  }
  for (const m of src.matchAll(
    /"((?:admin-[A-Za-z0-9_-]+)(?: admin-[A-Za-z0-9_-]+)*)"/gu,
  )) {
    addTokens(m[1] ?? "");
  }
  return out;
}

const cssSrc = readFileSync(ADMIN_CSS, "utf8");
const appSrc = readFileSync(APP_JS, "utf8");
const groupSrc = readFileSync(GROUP_JS, "utf8");

describe("admin.css 结构 —— 每条选择器都关在 .admin-root 里", () => {
  const sels = cssSelectors(cssSrc);

  it("⭐ 选择器提取器有读数（否则下面每条都是空集恒真）", () => {
    expect(sels.length).toBeGreaterThan(50);
    const flat = sels.join(" | ");
    // @media 里的两条也要展开出来（不展开就既漏判又假报 @media）。
    expect(flat).toContain(".admin-root .admin-cols");
    expect(flat).toContain(".admin-root .admin-charter-cols");
    expect(sels.some((s) => s.startsWith("@"))).toBe(false);
    // 无重复计数的判据用【独立推导】而不是「某条只出现一次」：
    // 每个 `{` 要么开一个条件组（@media，其体另计），要么开一条规则（出一个选择器头），
    // 所以条数必须恰等于 花括号总数 - 条件组数。同一选择器在 @media 里再现一次
    // 是合法的（.admin-cols 的窄屏那一支），按名字查重反而会假红。
    const braces = (stripCssComments(cssSrc).match(/\{/gu) ?? []).length;
    const groups = (stripCssComments(cssSrc).match(/@[a-z-]+[^{}]*\{/gu) ?? [])
      .length;
    expect(sels).toHaveLength(braces - groups);
  });

  it("⭐ 每条选择器以 .admin-root 开头（少了它就漏进工作台那三栏）", () => {
    const leaks = sels.filter((s) => !s.startsWith(".admin-root"));
    expect(leaks, "漏进工作台的裸选择器：" + JSON.stringify(leaks)).toEqual([]);
  });

  it("⭐ 每个类名带 admin- 前缀（.btn/.card/.row/.grid 这些名字两边都有）", () => {
    const all = new Set<string>();
    for (const s of sels) for (const c of classesIn(s)) all.add(c);
    const bad = [...all].filter((c) => !c.startsWith("admin-"));
    expect(bad, "没有 admin- 前缀的类名：" + JSON.stringify(bad)).toEqual([]);
  });

  it("⭐ 反向对照：提取器抓得住一条真漏出的选择器", () => {
    // 没有这一发，上面两条「全过」只证明提取器什么都没提出来。
    const sample = cssSelectors(
      ".btn { color:red } @media (min-width:1px) { .x { color:red } }",
    );
    expect(sample).toEqual([".btn", ".x"]);
    expect(sample.filter((s) => !s.startsWith(".admin-root"))).toHaveLength(2);
  });

  it("⭐ 注释不算选择器也不算类名（否则注释里提一句就能洗白死样式）", () => {
    const sample = cssSelectors(
      "/* .admin-ghost { color:red } */ .admin-root .admin-a { color:red }",
    );
    expect(sample).toEqual([".admin-root .admin-a"]);
  });
});

describe("类名双向钉 —— CSS 与 app.js 收发的必须是同一批", () => {
  const cssClasses = new Set<string>();
  for (const s of cssSelectors(cssSrc)) {
    for (const c of classesIn(s)) cssClasses.add(c);
  }
  const emitted = emittedClasses(appSrc);

  it("⭐ 提取器认得出各种发射形状（少认一种＝漏判，双向钉当场变瞎）", () => {
    const s = emittedClasses(
      [
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 这枚 fixture 故意用普通字符串装一段带 ${} 的模板发射形状 —— 提取器要认的就是这种原文，改成模板串反而会把插值真算出来。
        'x = `<div class="admin-static admin-tight${a ? " admin-cond" : ""}">`;',
        'el.classList.toggle("admin-toggle");',
        'const cls = a ? "admin-var" : "admin-other";',
        'el.className = "admin-classname";',
      ].join("\n"),
    );
    for (const name of [
      "admin-static",
      "admin-tight",
      "admin-cond",
      "admin-toggle",
      "admin-var",
      "admin-other",
      "admin-classname",
    ]) {
      expect(s, "认不出 " + name).toContain(name);
    }
    // 只读的那处不算发射（死样式洗白那条路）。
    expect(
      emittedClasses('document.querySelectorAll(".admin-read")'),
    ).not.toContain("admin-read");
  });

  it("⭐ app.js 发的每个 admin- 类在 CSS 里都有规则（发了没样式＝静默 no-op）", () => {
    const mine = [...emitted].filter((c) => c.startsWith("admin-"));
    const missing = mine.filter((c) => !cssClasses.has(c));
    expect(
      missing,
      "app.js 发了但 admin.css 没有规则：" + JSON.stringify(missing),
    ).toEqual([]);
  });

  it("⭐ CSS 里的每个类至少有一个发射方（没人发的类＝死样式）", () => {
    // 宿主发的类走白名单：作用域类与顶栏两枚由 group.js 建（旧 index.html 的
    // 独立页已删），不在 app.js 的 class 标记里，但确有发射方。
    const hostEmitted = new Set(["admin-root", "admin-conn", "admin-dot"]);
    const dead = [...cssClasses].filter(
      (c) => !emitted.has(c) && !hostEmitted.has(c),
    );
    expect(
      dead,
      "admin.css 里有规则但没有任何人发：" + JSON.stringify(dead),
    ).toEqual([]);
  });

  it("⭐ 白名单那三枚真的由宿主发出（白名单不许是随手豁免）", () => {
    // 宿主 = group.js：admin-dot / admin-conn 是 h() 的 class 对象字段（独占引号），
    // admin-root 是 adminHost.className = "admin-root admin-mount"（两枚合挂，带 admin-mount）。
    expect(groupSrc).toContain('"admin-root admin-mount"');
    expect(groupSrc).toContain('"admin-conn"');
    expect(groupSrc).toContain('"admin-dot"');
  });

  it("⭐ 反向对照：抽掉一处发射，no-op 半边立刻红（认的是真接线）", () => {
    const noTk = emittedClasses(
      appSrc.replace(/class="admin-tk/gu, 'class="zz'),
    );
    expect(noTk).not.toContain("admin-tk");
    // 另一半边：CSS 里那条规则改名 ⇒ 发射方还在、规则没了。
    const renamed = cssSelectors(
      cssSrc.replace(/\.admin-badge/gu, ".admin-badge-ghost"),
    );
    const cls = new Set<string>();
    for (const s of renamed) for (const c of classesIn(s)) cls.add(c);
    expect(cls.has("admin-badge")).toBe(false);
    expect(cls.has("admin-badge-ghost")).toBe(true);
  });
});
