// 格内编辑器：暗色下「正在敲的那一格」是不是深墨压白纸。
//
// 为什么可以不打字就量：库常驻挂着 .x-spreadsheet-editor-area textarea，未激活时它只是
// 0x0 + 不可见，getComputedStyle 拿到的就是【真实页面 + 真实样式表】解析出来的最终值；
// 而库激活它时只 css('width')/css('height')（bundle 里那个自动扩行函数 ce() 全文只写这两项），
// 从不碰 background/color/min-height。所以「未激活时的计算值」= 「激活后用户看到的值」。
// 真打字的通路（真点真敲真回写）由 test/e2e/sheet-editor.spec.ts 在【临时库】里覆盖，
// 不在这里往开发实例里写探针字。
import { chromium } from "playwright";

const rgb = (s) => s.match(/\d+/g).map(Number);
const lum = ([r, g, bl]) => {
  const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
};
const ratio = (a, b) => {
  const x = lum(rgb(a));
  const y = lum(rgb(b));
  return ((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2);
};

const b = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:9797/group.html#/documents", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2200);
  const n = await p.locator(".doc-list-item").count();
  let found = false;
  for (let i = 0; i < n && !found; i++) {
    await p.locator(".doc-list-item").nth(i).click();
    await p.waitForTimeout(1500);
    found = (await p.locator(".x-spreadsheet").count()) > 0;
  }
  if (!found) throw new Error("没有表格文档");
  const st = await p.evaluate(() => {
    const ta = document.querySelector(".x-spreadsheet-editor .x-spreadsheet-editor-area textarea");
    if (!ta) return null;
    const cs = getComputedStyle(ta);
    // 该元素祖先链上第一个不透明底 —— 编辑器压在 canvas 纸上，DOM 里没有纸这个节点，
    // 所以「它实际压在什么上面」由 .sheet-canvas 的画布内容决定（白纸），这里量的是
    // textarea【自己】算出来的 bg/color：纸墨对不对，看这两枚。
    return {
      bg: cs.backgroundColor,
      color: cs.color,
      minHeight: cs.minHeight,
      padding: cs.padding,
      resize: cs.resize,
      overflowY: cs.overflowY,
      font: cs.fontFamily,
      size: cs.fontSize,
      lineHeight: cs.lineHeight,
    };
  });
  if (!st) throw new Error("编辑器节点不在 DOM 里");
  console.log(`\n════ ${theme} ════`);
  console.log(`  textarea 自身  bg=${st.bg}  color=${st.color}  ⇒ 墨/底 = ${ratio(st.color, st.bg)}（正文档要 4.5）`);
  console.log(`  尺寸交还库:      min-height=${st.minHeight}  resize=${st.resize}  overflow-y=${st.overflowY}`);
  console.log(`  库自己的排版没被顶掉: font=${st.font.slice(0, 24)}… ${st.size} / ${st.lineHeight} / padding=${st.padding}`);
  await ctx.close();
}
await b.close();
