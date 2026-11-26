/**
 * Tailwind 接线守卫 —— 一条【预编译 + vendored】管线的静默失效面。
 *
 * ── 为什么这份守卫必须存在 ──────────────────────────────────────
 * tw-input.css 的文件头把好几条性质写成了散文：「不 import base」「两条 import 都带
 * prefix(tw) 与 source(none)」「断点名对齐手写媒体查询」「改了源就要 pnpm tw:build」。
 * 每一条都是【写错不报错、只静默变形】的形状：丢前缀会让圆角与间距静默全没（产物里
 * 出同名自引用，见下）；漏一条 source(none) 自动探测就重新打开；忘了重出产物，类名在
 * 页面上是个不起作用的字符串。这一轮之前，这些承诺一个字都没有代码替它们站着 —— 与本仓
 * 「注释承诺了实现没有的性质」那个反复出现的病灶同形。本文件把它们换成判据。
 * ⚠ 顺手记一笔：文件头原先把「成环」的账记在 @theme inline 头上，实测是【错】的 ——
 *   真凶是丢 prefix(tw)。这种「散文里的因果写反」正是本文件要防的东西，而它连文件头
 *   自己的账都会记错，所以留在这里当反面教材。
 *
 * ── 三个判据面，一把尺子 ────────────────────────────────────────
 *  A 入口形状：只接 theme + utilities 两条、都带 prefix(tw) 与 source(none)、没有
 *     preflight、不用 @theme inline、@theme 右侧引用的令牌在 group.css :root 真存在、
 *     断点与手写 @media 同档。
 *  B 产物：工具类【全在 @layer utilities 里】（这是「未分层手写规则恒赢」那条性质的
 *     全部依据 —— 一旦有 .tw: 选择器落在层外，它就能挤走现有渲染）；没有同名自引用
 *     （丢前缀才会出现的形状，只在编译结果里看得见）；离线自足无外链。
 *  C 同步：源里 class 位置出现的每个 tw:* 都在产物里有规则（忘了 tw:build 就红）；
 *     tw.css 挂在三份手写样式之后；tailwindcss 只在 devDependencies。
 *
 * ── 本文件【不】负责的那一发 ────────────────────────────────────
 * 「未分层声明赢过分层声明」这条级联律本身不在这里量 —— vitest 是 node 环境，读不到
 * 浏览器怎么决胜。那一发在 test/e2e/tw-cascade.spec.ts，真浏览器里给同一个元素同时
 * 挂一条手写规则和一条 tw: utility，量赢家。本文件只保证【产物把工具类放进了层里】，
 * 也就只保证那条律的前提成立。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const read = (p: string): string => readFileSync(join(REPO, p), "utf8");

const input = read("packages/web/styles/tw-input.css");
const tw = read("packages/web/public/tw.css");
const groupCss = read("packages/web/public/group.css");
const html = read("packages/web/public/group.html");
const pkg = JSON.parse(read("package.json")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const stripCssComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, "");

/** 去掉行尾分号与空白，让 `source(none);` 与 `source(none)` 在断言里同形。 */
const norm = (s: string): string => s.trim().replace(/;$/u, "").trim();

/**
 * 提取源文件里【类名位置】的 tw:* token。
 *
 * 只认类名属性引号内的那串，不全文扫 `tw:` —— 本仓的注释里就写着 tw:text-balance
 * 这种字样（说明为什么接它），全文扫会把一句注释当成一次使用，于是产物里没有那条
 * 规则也照样绿。三种发类名的语法都要认，漏一种等于给那种写法开免检：
 *  class="…"       group.html 的标记与 app.js 的模板串
 *  class: "…"      group.js 里 h("p", { class: "…" }) 的对象写法（本仓主力）
 *  className = "…" 赋值（group.js / app.js 共 7 处）
 * 漏掉后两种时，用它们发出去的 utility 永远不被核对 —— 忘了 tw:build 也不红，
 * 而那正是这条判据唯一该拦的事。
 */
const CLASS_ATTR =
  /\bclass(?:Name)?\s*[:=]\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gu;
function classTokens(fileSrc: string): string[] {
  const out = new Set<string>();
  for (const m of fileSrc.matchAll(CLASS_ATTR)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    for (const token of raw.split(/\s+/u)) {
      // 模板插值（${…}）那段不是字面类名，整枚 token 丢掉
      if (token.startsWith("tw:") && !token.includes("${")) out.add(token);
    }
  }
  return [...out];
}

/** 正则捕获组在 noUncheckedIndexedAccess 下是 string | undefined；缺组当空串处理。 */
const g = (m: RegExpExecArray | RegExpMatchArray, i: number): string =>
  m[i] ?? "";

/** 从 tw-input.css 里读出登记的 @source 相对路径，换成仓库根下的绝对读取路径。 */
function declaredSources(): string[] {
  return [...input.matchAll(/@source\s+"([^"]+)"\s*;/gu)].map((m) => {
    const raw = g(m, 1);
    const rel = raw.replace(/^\.\.\//u, "");
    return rel.startsWith("packages/") ? rel : join("packages/web/styles", raw);
  });
}

/** 产物里真正生成了规则的工具类名（把 `tw\:text-balance` 的反斜杠转义还原）。 */
function emittedUtilities(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/\.((?:[\w-]+\\:)+[\w-]+)/gu)) {
    out.add(g(m, 1).replace(/\\/gu, ""));
  }
  return out;
}

/** 产物里 `--x: var(--x)` 这种同名自引用 —— 变量成环的【唯一可见形状】。 */
function productSelfRefs(css: string): string[] {
  return [
    ...stripCssComments(css).matchAll(/(--[\w-]+)\s*:\s*var\((--[\w-]+)\)/gu),
  ]
    .filter((m) => g(m, 1) === g(m, 2))
    .map((m) => g(m, 1));
}

/**
 * 取 @theme 那一段。正则要同时认 `@theme {` 与 `@theme inline {`：写成 indexOf
 * 死字符串时，改成 inline 会让 indexOf 返回 -1、slice(-1) 只剩一个字符 —— 三条
 * 判据一起红，红的却全是「读不到东西」，把真正该报的那一发埋在里面。
 */
const THEME_HEAD = /@theme(?:\s+inline)?\s*\{/u;
function themeBlock(src: string): string {
  const m = THEME_HEAD.exec(src);
  return m === null ? "" : src.slice(m.index);
}

/** 落在 @layer utilities 之外的 `.tw\:` 选择器（同特异度下能挤走现有渲染）。 */
function utilitiesOutsideLayers(css: string): string[] {
  const blocks = [...css.matchAll(/@layer\s+utilities\s*\{/gu)];
  const ranges: Array<[number, number]> = [];
  for (const m of blocks) {
    let d = 0;
    const open = (m.index ?? 0) + m[0].length - 1;
    for (let j = open; j < css.length; j += 1) {
      if (css[j] === "{") d += 1;
      else if (css[j] === "}") {
        d -= 1;
        if (d === 0) {
          ranges.push([open, j]);
          break;
        }
      }
    }
  }
  const outside: string[] = [];
  for (const m of css.matchAll(/\.tw\\:/gu)) {
    const i = m.index ?? 0;
    if (!ranges.some(([a, b]) => i > a && i < b))
      outside.push(css.slice(i, i + 60));
  }
  return outside;
}

/** 入口里的 @import 原文（去掉行尾分号）。两条判据都要读它，所以模块级算一次。 */
const imports = [...input.matchAll(/^\s*@import\s+([^;]+);/gmu)].map((m) =>
  norm(g(m, 1)),
);

describe("Tailwind 接线 · 入口形状", () => {
  it("只接 theme + utilities 两条 import，且都带 prefix(tw) 与 source(none)", () => {
    // 恰好两条：多一条就是把 preflight 或整套 tailwindcss 又接回来了
    expect(imports).toHaveLength(2);
    expect(imports.map((i) => i.split(/\s+/u)[0])).toEqual([
      '"tailwindcss/theme.css"',
      '"tailwindcss/utilities.css"',
    ]);
    for (const imp of imports) {
      // prefix 缺一个 → 生成的类名不带 tw:，与 :root 已有的 --radius-md 那族撞名
      expect(imp, `import 少了 prefix(tw)：${imp}`).toContain("prefix(tw)");
      // source(none) 少挂一条 → 自动探测仍开着，仓库里随手一个 .html 的类名会被编进产物
      expect(imp, `import 少了 source(none)：${imp}`).toContain("source(none)");
    }
    // 没有任何一条 import 把整套（含 preflight）拉回来
    for (const imp of imports) {
      expect(imp).not.toMatch(/"tailwindcss"|"tailwindcss\/index\.css"/u);
    }
    expect(input).not.toContain("tailwindcss/preflight");
  });

  it("两条 import 各自带 layer(...)，且 theme→theme、utilities→utilities", () => {
    // 这条与「产物里工具类全在层内」是同一条性质的【两头】：产物那条量的是已签进来的
    // tw.css，只有【重出之后】才看得见 layer() 被摘掉的后果（实测：摘掉后产物是
    // `@layer theme,base,components;.tw\:text-balance{…}` —— 选择器落在所有层之外，
    // 与手写规则同层竞争，未分层恒赢那条前提当场失效）。但「改了入口忘了 tw:build」
    // 那段窗口里产物还是旧的、层内扫描照绿，所以入口这一头要立刻红。
    const pairs = [
      ['"tailwindcss/theme.css"', "layer(theme)"],
      ['"tailwindcss/utilities.css"', "layer(utilities)"],
    ] as const;
    for (const [file, layer] of pairs) {
      const imp =
        imports.find((i) => i.startsWith(file)) ?? "(这条 import 不存在)";
      // 挂错层也红，但后果要和实测一致：把 utilities 挂进 theme，产物里工具类就物理落进
      // `@layer theme{…}`，入口第一行那句「utilities 排在最后 = 分层里最强」失去意义。
      // ⚠ 它【不会】立刻挤走现有渲染 —— 未分层恒赢任何一层，这条性质跟挂哪层无关。真正
      // 坏掉的是层与层之间的相对次序：将来任何进 base/components 层的规则都能压过工具类。
      expect(imp, `${imp} 少了 ${layer}`).toContain(layer);
    }
  });

  it("故意不用 @theme inline —— 入口里写死这两个字就红", () => {
    // 判据读的是【代码】不是散文：入口自己的注释里就写着「不用 @theme inline」，
    // 不剥注释时这条断言会被一句解释骗红（而那份入口其实是对的）。
    expect(stripCssComments(input)).not.toMatch(/@theme\s+inline\b/u);
  });

  it("产物里没有同名自引用 —— 那是 prefix(tw) 被丢掉时的形状，只在编译结果里看得见", () => {
    // 实测去掉 prefix(tw) 后产物是 `@layer theme{:root,:host{--radius-md: var(--radius-md)
    // …}}`：同名自引用 ⇒ 变量成环，圆角/间距/颜色静默全没。带前缀出的是
    // `--tw-radius-md: var(--radius-md)`，名字不撞。⚠ 量的是【产物】不是入口：入口里
    // `--radius-md: var(--radius-md)` 恰恰是【正确写法】，量入口会把 5 条映射全判成环
    // （假红），而真出事那次（前缀没了、入口文本没变）它反而不红。
    expect(
      productSelfRefs(tw),
      "产物里出现同名自引用 ⇒ 变量成环，多半是某条 import 丢了 prefix(tw)",
    ).toEqual([]);
  });

  it("@theme 右侧引用的每枚令牌在 group.css :root 里都真实存在", () => {
    // 右侧写错一枚 → 那条 utility 生成的是 var(--不存在的名字)，落到浏览器解析成
    // 「未定义」，属性被整条丢掉 —— 类名在、样式没了，也不报错。
    const root = groupCss.slice(
      groupCss.indexOf(":root {"),
      groupCss.indexOf("\n}", groupCss.indexOf(":root {")) + 2,
    );
    const owned = new Set(
      [...stripCssComments(root).matchAll(/(--[\w-]+)\s*:/gu)].map((m) => m[1]),
    );
    const theme = themeBlock(input);
    const used = [
      ...new Set([...theme.matchAll(/var\((--[\w-]+)\)/gu)].map((m) => m[1])),
    ];
    expect(used.length).toBeGreaterThan(10); // 映射表没被掏空
    const missing = used.filter((t) => !owned.has(t));
    expect(missing, `@theme 右侧引用了 group.css 没有的令牌`).toEqual([]);
  });

  it("断点与 group.css 手写 @media 同档，且都清过 Tailwind 自带刻度", () => {
    // 刻度对齐这条是「一把尺子」的全部含义：断点不同档，同一个「中间档」在媒体查询
    // 里是一个宽度、在类名里是另一个宽度，两处写的响应式互相看不见。
    const theme = themeBlock(input);
    const defined = [
      ...new Map(
        [...theme.matchAll(/--breakpoint-([\w-]+):\s*(\d+)px/gu)].map((m) => [
          m[1],
          Number(m[2]),
        ]),
      ),
    ];
    expect(defined.length).toBeGreaterThanOrEqual(3);
    // Tailwind 的 min-width: N 与手写 max-width: N-1 是同一个分界
    const media = [
      ...new Set(
        [
          ...stripCssComments(groupCss).matchAll(
            /@media[^{]*?\((?:max|min)-width:\s*(\d+)px/gu,
          ),
        ].map((m) => Number(m[1])),
      ),
    ];
    expect(media.length).toBeGreaterThanOrEqual(3);
    const edges = new Set<number>();
    for (const n of media) {
      edges.add(n);
      edges.add(n + 1);
    }
    const offScale = defined.filter(([, px]) => !edges.has(px));
    expect(offScale, `这些断点不在手写 @media 的分界上：${offScale}`).toEqual(
      [],
    );
    // 自带刻度必须先清空重铺，否则 tw:md 是本仓 861 而 tw:xl 是 Tailwind 的 1280
    expect(theme).toContain("--breakpoint-*: initial");
  });
});

describe("Tailwind 接线 · 产物", () => {
  it("每条工具类都在 @layer utilities 里 —— 一条都不许落在层外", () => {
    // 这是整套接法的前提：未分层声明恒赢过分层声明，所以现有每条规则压得过 tw-*。
    // 一旦有 .tw: 选择器在层外，它就和手写规则同层竞争，能挤走已有渲染。
    // 判定要真数括号深度：产物里 @media 会嵌套，只按「下一个 @layer」切块会把嵌在
    // 层内的选择器误判成层外（或反之）。
    expect(utilitiesOutsideLayers(tw), "层外还有工具类").toEqual([]);
  });

  it("产物离线自足：tw.css 里没有任何外链", () => {
    // 桌面壳离线起不来是选「预编译 vendored」的原始理由，产物里塞一个 url() 就废了。
    expect(tw).not.toMatch(/url\(/u);
    expect(tw).not.toMatch(/@import/u);
    expect(tw).toContain("tailwindcss");
  });
});

describe("Tailwind 接线 · 源与产物同步", () => {
  it("源里 class 位置的每个 tw:* 都在产物里有规则（忘了 pnpm tw:build 就红）", () => {
    const srcs = declaredSources();
    expect(srcs.length).toBeGreaterThanOrEqual(1);
    const used = new Map<string, string>();
    for (const rel of srcs) {
      for (const token of classTokens(read(rel))) used.set(token, rel);
    }
    expect(used.size).toBeGreaterThanOrEqual(1); // 接线不许是空转：至少真用了一枚
    const emitted = emittedUtilities(tw);
    const missing = [...used].filter(([t]) => !emitted.has(t));
    expect(
      missing,
      `产物落后于源，跑 pnpm tw:build 重出 tw.css：\n${missing
        .map(([t, r]) => `  ${t}（用在 ${r}）`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("登记的 @source 文件都真实存在", () => {
    // @source 指错不报错，只是那份文件的类名不再进产物 —— 又一发静默失效。
    for (const rel of declaredSources()) {
      expect(() => read(rel), `@source 指向的文件读不到：${rel}`).not.toThrow();
    }
  });

  it("group.html 里 tw.css 挂在三份手写样式之后", () => {
    const at = (needle: string): number => html.indexOf(needle);
    for (const own of ["/group.css", "/admin.css", "/theme.css"])
      expect(at("/tw.css"), `tw.css 必须在 ${own} 之后`).toBeGreaterThan(
        at(own),
      );
    // 且整个应用只有这一份 tw.css
    expect(html.match(/\/tw\.css/gu)?.length).toBe(1);
  });

  it("tailwindcss 只在 devDependencies，且有 tw:build", () => {
    // 进 dependencies = 运行时依赖，而运行时根本不读它；桌面壳打包会跟着带上。
    expect(pkg.devDependencies?.tailwindcss).toBeTruthy();
    expect(pkg.dependencies?.tailwindcss).toBeUndefined();
    expect(pkg.scripts?.["tw:build"]).toMatch(
      /tailwindcss\b.*-o\b.*public\/tw\.css/u,
    );
  });
});

describe("Tailwind 接线 · 判据自己的眼睛", () => {
  // 和 color-scale 同一套纪律：判据是「空 = 绿」的形状，先证明它能报非 0。
  it("反向：类名提取器看得见注入的类，且不被注释与模板插值骗到", () => {
    const sample = `
      // 注释里提一句 tw:not-real-comment 不算使用
      h("p", { class: "tw:object-form \${dyn}" });
      html('<div class="tw:attr-form"></div>');
      el.className = "tw:assign-form";
    `;
    // 三种发类名的写法各认到一枚；模板插值那枚整枚丢掉（它不是字面类名），注释那枚不算。
    expect(classTokens(sample).sort()).toEqual([
      "tw:assign-form",
      "tw:attr-form",
      "tw:object-form",
    ]);
  });

  it("反向：同步判据在产物缺规则时会红（不是恒绿的空集合）", () => {
    const faked = `${tw}\n.leak {}.tw\\:ghost-one{display:flex}`;
    const emitted = emittedUtilities(faked);
    expect(emitted.has("tw:ghost-one")).toBe(true); // 产物有 → 判据会放过
    expect(emitted.has("tw:never-built")).toBe(false); // 产物没有 → 判据会拦
  });

  it("反向：层外扫描与自引用扫描都真报得出注入的那一发", () => {
    // 这两发都是「空集合 = 绿」的形状。扫描器若整枚失灵，判据会永远绿下去，
    // 所以这里往真产物后面接一发违规，要求【当场报 1 条】，而不是只验正则读得到东西。
    expect(utilitiesOutsideLayers(tw)).toHaveLength(0); // 真产物：干净
    const leaked = `${tw}\n.tw\\:ghost-out{display:flex}`;
    expect(utilitiesOutsideLayers(leaked)).toHaveLength(1); // 层外一枚 → 报 1
    const nested = `@layer utilities{.tw\\:a{color:red}@media (width>=641px){.tw\\:b{color:blue}}}`;
    expect(utilitiesOutsideLayers(nested)).toHaveLength(0); // 嵌在 @media 里仍算层内
    expect(productSelfRefs(tw)).toHaveLength(0); // 真产物：无环
    expect(
      productSelfRefs(`${tw}\n:root{--radius-md: var(--radius-md)}`),
    ).toEqual(["--radius-md"]);
  });

  it("反向：@theme 与断点两条判据的取值确实来自文件而不是硬编码", () => {
    // 这两发只验「读得到东西」，读成空集会让上面两条恒绿
    const theme = themeBlock(input);
    expect(theme.length).toBeGreaterThan(200);
    expect(input.search(THEME_HEAD)).toBeGreaterThan(0);
    expect(
      [...theme.matchAll(/var\((--[\w-]+)\)/gu)].length,
    ).toBeGreaterThanOrEqual(10);
  });
});
