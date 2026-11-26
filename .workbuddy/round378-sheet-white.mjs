import { chromium } from "playwright";
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
await p.goto("http://127.0.0.1:9797/#/documents", { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1500);
const n = await p.locator("#listContent .doc-list-item").count();
for (let i = 0; i < n; i++) {
  await p.locator("#listContent .doc-list-item").nth(i).click();
  await p.waitForTimeout(1300);
  if (!(await p.locator(".doc-sub").first().textContent()).includes("表格")) continue;
  const m = await p.evaluate(() => {
    const rows = [];
    const push = (sel) => document.querySelectorAll(sel).forEach((el) => {
      const bx = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      rows.push({ c: (el.className || el.tagName).toString().replace(/\s+/g, ".").slice(0, 40), bg: cs.backgroundColor, disp: cs.display, rect: `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}` });
    });
    push(".x-spreadsheet"); push(".x-spreadsheet-toolbar"); push(".x-spreadsheet-toolbar-container");
    push(".x-spreadsheet-toolbar > div"); push(".x-spreadsheet-bottombar"); push(".x-spreadsheet-formula");
    push(".active"); push(".x-spreadsheet-header"); push(".x-spreadsheet-table");
    return rows;
  });
  for (const r of m) console.log(`${r.c.padEnd(42)} ${r.bg.padEnd(22)} ${r.disp.padEnd(10)} ${r.rect}`);
  break;
}
await b.close();
