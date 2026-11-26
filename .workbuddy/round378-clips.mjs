import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:9797/#/documents", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
for (const want of ["表格", "富文本"]) {
  for (let i = 0; i < n; i++) {
    await p.locator("#listContent .doc-list-item").nth(i).click();
    await p.waitForTimeout(1300);
    if (!(await p.locator(".doc-sub").first().textContent()).includes(want)) continue;
    const card = p.locator(".editor-card");
    await card.screenshot({ path: `.workbuddy/scratch/r378-${want}-card.png` });
    await p.locator(".doc-head").screenshot({ path: `.workbuddy/scratch/r378-${want}-head.png` });
    console.log(`${want} 已截图`);
    break;
  }
}
await b.close();
