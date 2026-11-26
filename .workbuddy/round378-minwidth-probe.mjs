// round378 分栏 min-width:0 判据形状实测（P5 SURVIVED 的归因）。
// P5 剪的是 .editor-panes > * 的 min-width:0，期望「长文把某栏撑过一半」能被现有判据抓到，
// 结果样本正文下用例照绿。这一发回答两个问题：
//  ① 真页面里，一篇长文档（长代码行 + 宽表）在分栏下两栏各读多少宽 ⇒ 判据有没有可读的差；
//  ② 若读不出差，是 min-width:0 这条声明本身在 flex-basis:50% 下不管事，还是样本内容不够长。
// 只读：不点保存、不 typing，所以共享 dev 实例（9797）安全；页内 style 只改本地渲染。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();

// 自证一发纯 CSS 形状：flex-basis:50% + overflow:auto 时，min-width:auto 会不会让某栏吃掉另一半。
// 与真页面同一条链（flex row / basis 50% / overflow auto），只是不需要后端。
const synth = await p.evaluate(`(() => {
  const host = document.createElement('div');
  host.style.cssText = 'display:flex; width:1000px; position:fixed; left:-2000px; top:0';
  const mk = (content) => {
    const d = document.createElement('div');
    d.style.cssText = 'flex:1 1 50%; overflow:auto; scrollbar-width:none';
    d.textContent = content;
    return d;
  };
  const long = 'x'.repeat(4000);
  const short = '短';
  const measure = (mw) => {
    host.replaceChildren();
    for (const el of [mk(long), mk(short)]) { el.style.minWidth = mw; host.append(el); }
    document.body.append(host);
    const [a, c] = [...host.children].map((x) => Math.round(x.getBoundingClientRect().width));
    host.remove();
    return a + '/' + c;
  };
  return JSON.stringify({ auto: measure('auto'), zero: measure('0px') });
})()`);
console.log("合成形状（容器 1000，长内容栏/短内容栏）：", synth);

// 真页面：找一篇正文最长的 markdown 文档，分栏下量两栏宽 + 各自是否内容溢出。
await p.goto(`${BASE}/#/documents`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
let best = null;
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1200);
  const sub = await p.locator(".doc-sub").first().textContent().catch(() => "");
  if (!(sub ?? "").includes("Markdown")) continue;
  const len = await p.evaluate(
    `(() => { const t = document.querySelector('.markdown-editor'); return t ? t.value.length : 0; })()`,
  );
  if (best === null || len > best.len) best = { i, len };
}
console.log("最长的 markdown 文档：index=" + (best?.i ?? "无") + " 正文长度=" + (best?.len ?? 0));
if (best === null) { await b.close(); process.exit(0); }

await p.locator("#listContent .doc-list-item").nth(best.i).click();
await p.waitForTimeout(1300);
await p.getByRole("group", { name: "正文视图" }).getByRole("button", { name: "分栏", exact: true }).click();
await p.waitForTimeout(500);

const read = async (label) => {
  const raw = await p.evaluate(`(() => {
    const host = document.querySelector('.editor-panes');
    const src = host.querySelector('.markdown-editor');
    const prev = host.querySelector('.markdown-preview');
    const w = (el) => Math.round(el.getBoundingClientRect().width);
    const over = (el) => el.scrollWidth - el.clientWidth;
    return JSON.stringify({
      host: w(host), src: w(src), prev: w(prev),
      srcOver: over(src), prevOver: over(prev),
      srcMin: getComputedStyle(src).minWidth, prevMin: getComputedStyle(prev).minWidth,
    });
  })()`);
  const m = JSON.parse(raw);
  console.log(
    `${label.padEnd(16)} 容器 ${m.host}  源码 ${m.src}  预览 ${m.prev}  差 ${m.prev - m.src}` +
      `  内容溢出 源码=${m.srcOver} 预览=${m.prevOver}  min-width ${m.srcMin}/${m.prevMin}`,
  );
  return m;
};
await read("现状 min-width:0");
await p.evaluate(`(() => {
  let st = document.getElementById('__mw');
  if (!st) { st = document.createElement('style'); st.id = '__mw'; document.head.append(st); }
  st.textContent = '.editor-panes > * { min-width: auto; }';
})()`);
await p.waitForTimeout(300);
await read("剪成 auto");
await p.evaluate("(() => document.getElementById('__mw').remove())()");
await b.close();
