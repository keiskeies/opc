import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 2000, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:9797/#/documents", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1400);
  const sub = await p.locator(".doc-sub").first().textContent();
  if (sub.includes("Markdown")) {
    const m = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(".doc-page *")) {
        const bx = el.getBoundingClientRect();
        if (bx.width > 4 || bx.height < 8) continue;
        const cs = getComputedStyle(el);
        out.push(`${(el.className || el.tagName).toString().slice(0, 32)} ${Math.round(bx.width)}×${Math.round(bx.height)} @${Math.round(bx.x)},${Math.round(bx.y)} bg=${cs.backgroundColor} bc=${cs.borderLeftColor}/${cs.borderLeftWidth} txt=${(el.textContent ?? "").slice(0, 12)}`);
      }
      return { bars: out.slice(0, 10), active: document.activeElement?.className?.toString().slice(0, 40), activeTag: document.activeElement?.tagName };
    });
    console.log("【Markdown 页】窄条元素：\n  " + (m.bars.join("\n  ") || "无"));
    console.log(`  activeElement=${m.activeTag}.${m.active}`);
  }
  if (sub.includes("表格")) {
    const m = await p.evaluate(() => {
      const cv = document.querySelector(".sheet-canvas canvas");
      const bx = cv.getBoundingClientRect();
      const g = cv.getContext("2d");
      const dpr = cv.width / bx.width;
      const s = [];
      for (const [px, py] of [[40, 40], [300, 40], [560, 40], [600, 75], [700, 75], [860, 75], [40, 150], [400, 150]]) {
        const d = g.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
        s.push(`${px},${py}=rgb(${d[0]},${d[1]},${d[2]})`);
      }
      return { rect: `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}`, s, dpr };
    });
    console.log(`\n【表格 页】grid canvas ${m.rect} dpr=${m.dpr}\n  ` + m.s.join("  "));
  }
}
await b.close();
