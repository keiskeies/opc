// round378 分栏等宽 · 归因二发：一发读到 984 的容器里两栏 487.5 / 496.5（flex 都是 1 1 0px）。
// 逐项排除：竖滚圈占宽、border-left、textarea 的 width:100% 与 UA 内在宽、flex-basis 写法。
// 每一发用 style 标签在线覆盖，只改浏览器里的样式，不碰正文不发 PATCH。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();

await p.goto(`${BASE}/#/documents`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
let found = false;
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1300);
  const sub = await p.locator(".doc-sub").first().textContent().catch(() => "");
  if ((sub ?? "").includes("Markdown")) { found = true; break; }
}
if (!found) { console.log("没有 markdown 文档"); await b.close(); process.exit(0); }

await p.getByRole("group", { name: "正文视图" }).getByRole("button", { name: "分栏", exact: true }).click();
await p.waitForTimeout(600);

const CASES = [
  ["现状（不改）", ""],
  ["去掉中缝 border-left", '.editor-panes[data-mode="split"] > .markdown-preview { border-left: 0; }'],
  ["源码面 width:auto", ".editor-panes > .markdown-editor { width: auto; }"],
  ["两栏 padding 归零", ".editor-panes > * { padding-left: 0 !important; padding-right: 0 !important; }"],
  ["两栏 overflow:visible", ".editor-panes > * { overflow: visible; }"],
  ["flex-basis 写 50%", ".editor-panes > * { flex: 1 1 50%; }"],
  ["源码面 display:block→flex 无关：换成 div", ".editor-panes > .markdown-editor { display: none; }"],
];

for (const [label, css] of CASES) {
  const out = await p.evaluate(`(() => {
    let st = document.getElementById('__probe_style');
    if (!st) { st = document.createElement('style'); st.id = '__probe_style'; document.head.append(st); }
    st.textContent = ${JSON.stringify(css)};
    const host = document.querySelector('.editor-panes');
    const src = host.querySelector('.markdown-editor');
    const prev = host.querySelector('.markdown-preview');
    const w = (el) => el.getBoundingClientRect().width;
    const barSpace = (el) => el.offsetWidth - el.clientWidth;
    return JSON.stringify({
      host: +host.getBoundingClientRect().width.toFixed(2),
      src: +w(src).toFixed(2),
      prev: +w(prev).toFixed(2),
      srcBar: barSpace(src),
      prevBar: barSpace(prev),
      srcCss: getComputedStyle(src).flexBasis + ' / ' + getComputedStyle(src).width,
      prevCss: getComputedStyle(prev).flexBasis + ' / ' + getComputedStyle(prev).width,
    });
  })()`);
  const m = JSON.parse(out);
  console.log(
    `${label.padEnd(28)} 容器 ${m.host}  源码 ${m.src}  预览 ${m.prev}  差 ${(m.prev - m.src).toFixed(2)}` +
      `  滚圈占位 src=${m.srcBar} prev=${m.prevBar}  |  basis ${m.srcCss} || ${m.prevCss}`,
  );
}
await p.evaluate("(() => { const st = document.getElementById('__probe_style'); if (st) st.remove(); })()");
await b.close();
