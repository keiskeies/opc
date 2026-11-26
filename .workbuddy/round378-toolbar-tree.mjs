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
  const out = await p.evaluate(() => {
    const tb = document.querySelector(".x-spreadsheet-toolbar");
    const rows = [];
    const walk = (el, d) => {
      const bx = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      rows.push(`${"  ".repeat(d)}${el.tagName.toLowerCase()}.${(el.className || "").toString().replace(/\s+/g, ".")}  bg=${cs.backgroundColor} disp=${cs.display} flex=${cs.flex} w=${Math.round(bx.width)} rect=${Math.round(bx.x)},${Math.round(bx.y)}`);
      if (d < 3) [...el.children].forEach((c) => walk(c, d + 1));
    };
    walk(tb, 0);
    return { html: tb.outerHTML.slice(0, 400), rows };
  });
  console.log(out.rows.join("\n"));
  console.log("\nHTML 头：", out.html);
  break;
}
await b.close();
