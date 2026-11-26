// round378 分栏等宽探针：e2e 第③发读到源码面 488 / 预览面 497，差 9px。
// 这一发把两栏的【盒模型逐项】打出来，判那 9px 是谁吃掉的：flex-basis、width、
// min-width、padding、border，以及两栏各自有没有竖滚圈。
// 只读：不点保存、不改正文，只点形态页签（视图状态在内存里，不发 PATCH）。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();

await p.goto(`${BASE}/#/documents`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);

// 找一篇 markdown
const n = await p.locator("#listContent .doc-list-item").count();
let found = false;
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1300);
  const sub = await p.locator(".doc-sub").first().textContent().catch(() => "");
  if ((sub ?? "").includes("Markdown")) {
    found = true;
    break;
  }
}
if (!found) {
  console.log("没有 markdown 文档，退出");
  await b.close();
  process.exit(0);
}

await p.getByRole("group", { name: "正文视图" }).getByRole("button", { name: "分栏", exact: true }).click();
await p.waitForTimeout(600);

const dump = await p.evaluate(`(() => {
  const host = document.querySelector('.editor-panes');
  const src = host.querySelector('.markdown-editor');
  const prev = host.querySelector('.markdown-preview');
  const row = (label, el) => {
    const cs = getComputedStyle(el);
    const bx = el.getBoundingClientRect();
    return {
      label,
      tag: el.tagName.toLowerCase(),
      rect: Math.round(bx.x) + ' w=' + bx.width.toFixed(2) + ' scrollW=' + el.scrollWidth + ' clientW=' + el.clientWidth,
      flex: cs.flex,
      flexBasis: cs.flexBasis,
      flexGrow: cs.flexGrow,
      flexShrink: cs.flexShrink,
      width: cs.width,
      minWidth: cs.minWidth,
      maxWidth: cs.maxWidth,
      padding: cs.paddingLeft + '/' + cs.paddingRight,
      border: cs.borderLeftWidth + '/' + cs.borderRightWidth,
      overflow: cs.overflowX + ' ' + cs.overflowY,
      scrollbarWidth: cs.scrollbarWidth,
      boxSizing: cs.boxSizing,
      display: cs.display,
    };
  };
  const hostCs = getComputedStyle(host);
  const hostBx = host.getBoundingClientRect();
  return JSON.stringify({
    mode: host.dataset.mode,
    host: 'x=' + Math.round(hostBx.x) + ' w=' + hostBx.width.toFixed(2) + ' scrollW=' + host.scrollWidth + ' gap=' + hostCs.columnGap + ' pad=' + hostCs.paddingLeft + '/' + hostCs.paddingRight,
    rows: [row('源码面', src), row('预览面', prev)],
    srcScrollTall: src.scrollHeight + ' vs client ' + src.clientHeight,
    prevScrollTall: prev.scrollHeight + ' vs client ' + prev.clientHeight,
  }, null, 1);
})()`);
console.log("容器：" + JSON.parse(dump).host);
for (const r of JSON.parse(dump).rows) {
  console.log(`\n【${r.label}】<${r.tag}>  ${r.rect}`);
  console.log(`   flex=${r.flex}  basis=${r.flexBasis}  width=${r.width}  min-width=${r.minWidth}  max-width=${r.maxWidth}`);
  console.log(`   padding=${r.padding}  border=${r.border}  box-sizing=${r.boxSizing}  display=${r.display}`);
  console.log(`   overflow=${r.overflow}  scrollbar-width=${r.scrollbarWidth}`);
}
const d = JSON.parse(dump);
console.log(`\n源码面 scrollHeight/client = ${d.srcScrollTall}`);
console.log(`预览面 scrollHeight/client = ${d.prevScrollTall}`);
await b.close();
