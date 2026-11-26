import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:9797/#/documents", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1400);
  const sub = await p.locator(".doc-sub").first().textContent();
  if (sub.includes("表格")) {
    const m = await p.evaluate(() => {
      const cvs = [...document.querySelectorAll(".x-spreadsheet canvas")].map((c) => {
        const bx = c.getBoundingClientRect();
        return { cls: c.className, rect: `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}` };
      });
      // 在表格区取一片样点，看白色是不是画在 canvas 上
      const cv = document.querySelector(".x-spreadsheet-table canvas");
      const samples = [];
      if (cv) {
        const g = cv.getContext("2d");
        const bx = cv.getBoundingClientRect();
        for (const [px, py] of [[60, 60], [300, 60], [500, 60], [520, 90], [600, 90], [700, 90], [820, 90], [500, 200]]) {
          const dpr = cv.width / bx.width;
          try {
            const d = g.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data;
            samples.push(`${px},${py} => rgb(${d[0]},${d[1]},${d[2]})`);
          } catch (e) { samples.push(`${px},${py} => ${e.message}`); }
        }
      }
      return { cvs, samples, hasCv: !!cv };
    });
    console.log("canvas：", JSON.stringify(m.cvs));
    console.log("网格取样：", m.samples.join("  |  "));
  }
  if (sub.includes("富文本")) {
    await p.screenshot({ path: ".workbuddy/scratch/r378-rich-top.png", clip: { x: 420, y: 64, width: 1020, height: 330 } });
    const lines = await p.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll(".doc-page *")) {
        const cs = getComputedStyle(el);
        for (const [side, w, c] of [["t", cs.borderTopWidth, cs.borderTopColor], ["b", cs.borderBottomWidth, cs.borderBottomColor]]) {
          if (parseFloat(w) < 1) continue;
          const m2 = /rgb\((\d+), (\d+), (\d+)/u.exec(c);
          if (m2 === null) continue;
          const [, r, g, bl] = m2.map(Number);
          if (!(bl > 150 && bl - r > 60 && bl - g > 60)) continue;
          const bx = el.getBoundingClientRect();
          out.push(`${(el.className || el.tagName).toString().slice(0, 36)} ${side}=${w} ${c} @${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}`);
        }
      }
      return out;
    });
    console.log("富文本页偏蓝边框：", lines.length ? "\n  " + lines.join("\n  ") : "0 处");
  }
}
await b.close();
