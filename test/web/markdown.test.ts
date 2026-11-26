/**
 * markdown.js 的渲染与转义契约（文档编辑器 markdown 预览面的唯一防线）。
 *
 * ── 为什么要在 node 里真跑它 ────────────────────────────────────
 * markdown.js 是浏览器 ES 模块，唯一出口 renderMarkdown(text) → HTML 字符串，
 * 纯函数、不碰 DOM。test/web 的环境是 environment:"node"（vitest.config.ts），
 * 没有 document，所以 e2e 之外这一层要自己在 vm 里跑起来：调用方把【用户正文】
 * 直接灌进 innerHTML，转义与 URL 白名单就写在这一个文件里 —— 只有 e2e 覆盖它，
 * 等于「安全契约的证据依赖一个浏览器」。
 *
 * ── 装载方式与它的假绿面 ────────────────────────────────────────
 * vm 的 context 是隔离的：里面没有 require / import / fs，模块想越界只会有一个
 * ReferenceError（⇒ 顶部那条「装载成功」的断言当场红）。它只有一个顶层 export，
 * 装载器把 `export` 一词剥掉再挂到 globalThis；剥完仍扫一遍 import/export，
 * 剩了就直接抛 —— 否则「替身没生效」会静默通过（同 app-loader.ts 的口径）。
 *
 * ⚠ 一条真实事故（本轮实测撞出来的）：正则在 `u` 标志下【未转义的 `]` 是语法错】
 *   （V8 报 "Lone quantifier brackets"），而 `node --check` 与 vm 都在解析期抛。
 *   图片/链接那两条模式最初写 `...](` ⇒ 模块 import 即抛 ⇒ 整个 group.js 起不来，
 *   页面白屏。所以本文件顶部先钉「装载成功」：这一发红的时候，症状就是白屏。
 *
 * ── 不含哪几格 ──────────────────────────────────────────────────
 *  · 分栏/预览的排版与高度：test/e2e/doc-preview.spec.ts 与 doc-layout.spec.ts。
 *  · 不支持的语法（嵌套列表、HTML 内联、脚注、任务列表、标题锚点）：文件头写了
 *    不支持，就不为它们写断言 —— 为「未实现」写一条绿的空断言是假覆盖。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const REPO = resolve(__dirname, "../..");
const MARKDOWN_PATH = resolve(REPO, "packages/web/public/markdown.js");

/** markdown.js → 可调用函数。抛在这里就是「模块自己坏了」，不是某条渲染错了。 */
function loadRenderMarkdown(): (text: string) => string {
  const src = readFileSync(MARKDOWN_PATH, "utf8");
  const exported = src.replace(/^export\s+/mu, "");
  if (/^\s*(?:export|import)\s/mu.test(exported)) {
    throw new Error(
      "markdown.js 里不止一处顶层 import/export ⇒ 装载器只剥得掉第一条，这条测试现在是假的",
    );
  }
  const ctx: Record<string, unknown> = { console };
  ctx["globalThis"] = ctx;
  vm.createContext(ctx);
  // 不往 ctx 里塞 require / process：context 隔离即是「纯函数」的执行证据。
  vm.runInContext(
    `${exported}\n;globalThis.__md = renderMarkdown;`,
    ctx,
    { filename: "markdown.js" },
  );
  const fn = ctx["__md"];
  if (typeof fn !== "function") throw new Error("markdown.js 没有导出 renderMarkdown");
  return fn as (text: string) => string;
}

const md = loadRenderMarkdown();

describe("markdown 渲染器：块级语法", () => {
  it("装载本身是一条断言（u 标志下未转义的 ] 会让模块 import 即抛）", () => {
    expect(typeof md).toBe("function");
    expect(md("")).toBe("");
  });

  it("一到六级标题各归各档，七井号当正文", () => {
    expect(md("# 一")).toBe("<h1>一</h1>");
    expect(md("###### 六")).toBe("<h6>六</h6>");
    // 第七级不是标题：静默降级成段落，而不是渲染出 <h7>（HTML 里没有这个元素）。
    expect(md("####### 七")).toBe("<p>####### 七</p>");
  });

  it("围栏代码整段原样，语言名进 class，内部不做行内解析", () => {
    const out = md("```js\nconst a = 1;\n**不是粗体**\n```");
    expect(out).toContain('<pre><code class="language-js">');
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("<strong>");
    // 无语言围栏不带 class —— 不能凭空造一个空的 language-。
    expect(md("```\nx\n```")).toBe("<pre><code>x</code></pre>");
  });

  it("围栏里的尖括号仍是文字，不是标签", () => {
    expect(md("```\n<script>alert(1)</script>\n```")).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });

  it("无序与有序列表各成一族，一层为限", () => {
    expect(md("- a\n- b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md("* a\n+ b")).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(md("1. 一\n2. 二")).toBe("<ol><li>一</li><li>二</li></ol>");
    expect(md("1) 一")).toBe("<ol><li>一</li></ol>");
  });

  it("连续引用行合成一个 blockquote，段内换行用 br", () => {
    expect(md("> 甲\n> 乙")).toBe("<blockquote>甲<br>乙</blockquote>");
    // 引用面不是转义的豁免区：剥标记之后仍要逐行 esc 才进 inlineMd。
    expect(md("> <script>alert(1)</script>")).toBe(
      "<blockquote>&lt;script&gt;alert(1)&lt;/script&gt;</blockquote>",
    );
  });

  it("分隔线吃 --- ___ ***，不吃只有两个字符的行", () => {
    expect(md("---")).toBe("<hr>");
    expect(md("***")).toBe("<hr>");
    expect(md("--")).toBe("<p>--</p>");
  });

  it("表格要「表头 + 分隔行 + 数据行」三行一起才算，对齐按冒号落位", () => {
    const out = md("| 甲 | 乙 |\n|:---|---:|\n| 1 | 2 |");
    expect(out).toContain("<thead><tr><th align=\"left\">甲</th><th align=\"right\">乙</th></tr></thead>");
    expect(out).toContain('<td align="left">1</td>');
    expect(out).toContain('<td align="right">2</td>');
    // 只有表头与分隔行 ⇒ 不是表格（否则任何含 | 的段落都会被误判）。
    // 缺数据行时三行一起认的那道门不开，两行落回同一段落（段内换行 = br）。
    expect(md("| 甲 |\n| --- |")).toBe("<p>| 甲 |<br>| --- |</p>");
  });

  it("单元格里的转义竖线算内容，不切列", () => {
    const out = md("| a | b |\n| --- | --- |\n| x\\|y | z |");
    expect(out).toContain("<td>x|y</td>");
  });

  it("段落里的行内换行合成 br，整段只有一个 p", () => {
    expect(md("甲\n乙")).toBe("<p>甲<br>乙</p>");
  });

  it("空输入与 null 得到空串，不是 undefined 或 null", () => {
    expect(md("")).toBe("");
    expect(md(null as unknown as string)).toBe("");
    expect(md(undefined as unknown as string)).toBe("");
  });
});

describe("markdown 渲染器：行内语法", () => {
  it("粗、斜、行内码、删除线各自成形", () => {
    expect(md("**粗**")).toBe("<p><strong>粗</strong></p>");
    expect(md("__粗__")).toBe("<p><strong>粗</strong></p>");
    expect(md("*斜*")).toBe("<p><em>斜</em></p>");
    expect(md("~~废~~")).toBe("<p><del>废</del></p>");
    expect(md("`码`")).toBe("<p><code>码</code></p>");
  });

  it("行内码里的星号与尖括号保持字面", () => {
    expect(md("`*not em*`")).toBe("<p><code>*not em*</code></p>");
    expect(md("`<b>`")).toBe("<p><code>&lt;b&gt;</code></p>");
  });

  it("图片先于链接：感叹号不会被甩到方括号外", () => {
    expect(md("![alt](/a.png)")).toContain('<img src="/a.png" alt="alt"');
    // 同一行既有图又有链，两条都要各自成形（顺序反了会把 ! 留在 <a> 里）。
    const out = md("![i](/a.png) 与 [文](/b)");
    expect(out).toContain("<img");
    expect(out).toContain('<a href="/b"');
    expect(out).not.toContain("![");
  });

  it("链接带标题时标题进 title，不带时不造空 title", () => {
    expect(md('[文](/a "说明")')).toContain('title="说明"');
    expect(md("[文](/a)")).not.toContain("title=");
  });

  it("外链一律 rel=noopener noreferrer", () => {
    expect(md("[文](https://example.com/a)")).toContain('rel="noopener noreferrer"');
  });
});

describe("markdown 渲染器：安全契约（调用方直接喂 innerHTML）", () => {
  it("正文里的原始标签整篇转义，只当文字", () => {
    const out = md("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    for (const raw of ['<img src=x onerror="alert(1)">', '<a href="javascript:1">x</a>']) {
      expect(md(raw)).not.toMatch(/<(script|img|a)\b/u);
    }
  });

  it("javascript: 协议落回 # —— 含用控制字符拆开字面量的那两种", () => {
    // 控制字符不在 URL 模式的 [^)\s]+ 黑名单里（\t\n\r\f 才算 \s，\0 与 \u001f 不算），
    // 所以它们【能】进到 safeHref。安全判据因此必须打在控制字符这一支上：
    // 白名单前先把 [\u0000-\u0020\u007f] 剥掉再判协议，否则 java\0script: 就是一枚可执行 href。
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "java\u0000script:alert(1)",
      "java\u001fscript:alert(1)",
      "\u0000javascript:alert(1)",
    ]) {
      const link = md(`[点我](${href})`);
      expect(link, `链接 ${JSON.stringify(href)} 没落回 #`).toContain('href="#"');
      expect(link).not.toMatch(/href="java/iu);
      const img = md(`![i](${href})`);
      expect(img, `图片 ${JSON.stringify(href)} 没落回 #`).toContain('src="#"');
    }
  });

  it("URL 里带空白压根不生成链接（模式不认，不是认了再放行）", () => {
    // java\tscript: 这一族走的是另一条安全路径：[^\s)] 把它挡在模式之外 ⇒ 整段留作文字。
    // 钉它是为了区分两条路：将来谁把 URL 模式放宽成能吃空白，控制字符那一发之外还得靠
    // safeHref，而这一发会当场红 —— 那时放宽的人就知道自己动了什么。
    for (const href of ["java\tscript:alert(1)", " java\tscript:alert(1)"]) {
      const link = md(`[点我](${href})`);
      expect(link, `带空白的 ${JSON.stringify(href)} 竟生成了链接`).not.toContain("<a ");
      expect(link).not.toContain("<img");
    }
    // 换行把一行切成两段：段与段之间拼不出 URL，两半都只是文字。
    expect(md("[点我](java\nscript:alert(1))")).not.toContain("<a ");
  });

  it("data: 与其它非白名单协议一并落回 #", () => {
    for (const href of [
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(md(`[x](${href})`)).toContain('href="#"');
      expect(md(`![x](${href})`)).toContain('src="#"');
    }
  });

  it("白名单放行：http(s) / mailto / 站内相对路径 / 锚点", () => {
    const cases: [string, string][] = [
      ["https://example.com/a", "https://example.com/a"],
      ["http://example.com/a", "http://example.com/a"],
      ["mailto:a@b.example", "mailto:a@b.example"],
      ["/docs/a", "/docs/a"],
      ["./a.png", "./a.png"],
      ["../a.png", "../a.png"],
      ["#sec", "#sec"],
    ];
    for (const [href, want] of cases) {
      expect(md(`[x](${href})`), `放行了该放的：${href}`).toContain(
        `href="${want}"`,
      );
    }
  });

  it("URL 里的引号只会以实体留在 href 里，逃不出属性", () => {
    // 想闭合 href 得先穿过 esc()：转义先于解析 ⇒ 正文里的 " 到 href 时已是 &quot;。
    // 所以这里钉的不是「没有出现 onerror 这几个字」（那串文字合法地留在属性值里），
    // 而是「href 属性没有提前闭合」—— 一个裸引号出现即红。
    const out = md('[x](/a"onerror="alert(1))');
    expect(out).toContain('href="/a&quot;onerror=&quot;alert(1"');
    const href = /href="([^"]*)"/u.exec(out)?.[1] ?? "";
    expect(href.includes('"'), `href 属性值里混进了裸引号：${href}`).toBe(false);
    expect(out.match(/href=/gu)?.length).toBe(1);
  });

  it("转义发生在解析之前：先整篇 esc 再分行（源码形状，改顺序会当场红）", () => {
    const src = readFileSync(MARKDOWN_PATH, "utf8");
    const render = src.slice(src.indexOf("export function renderMarkdown"));
    const escAt = render.indexOf("escMd(lines[i])");
    expect(escAt, "renderMarkdown 里找不到 escMd(lines[i]) ⇒ 转义入口被挪走了").toBeGreaterThan(-1);
    const inlineAt = render.indexOf("inlineMd(");
    expect(
      escAt,
      "行内解析出现在整篇转义之前 ⇒ 未转义的一行进了 inlineMd，白名单成了唯一防线",
    ).toBeLessThan(inlineAt);
  });
});
