import { chromium } from "playwright";
const VARIANTS = {
  A_baseline: "",
  B_tight: `.conversation-title{line-height:1.3} .conversation-preview{margin-top:2px;line-height:1.3} .conversation-item{padding-top:9px;padding-bottom:9px}`,
  C_prev12: `.conversation-preview{font-size:12px}`,
  D_wide340: `:root{--list-width:340px}@media(max-width:1180px){:root{--list-width:306px}}`,
  E_wide340tight: `:root{--list-width:340px}@media(max-width:1180px){:root{--list-width:306px}} .conversation-title{line-height:1.3} .conversation-preview{margin-top:2px;line-height:1.3}`,
  F_twoline: `.conversation-preview{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}`,
};
const b = await chromium.launch();
const rows = [];
for (const [name, css] of Object.entries(VARIANTS)) {
  for (const w of [1024, 1440]) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 }, deviceScaleFactor: 2 });
    await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
    await pg.waitForSelector(".conversation-item", { timeout: 15000 });
    if (css) await pg.addStyleTag({ content: css });
    await pg.waitForTimeout(120);
    const m = await pg.evaluate(() => {
      const item = document.querySelector(".conversation-row .conversation-item");
      const copy = item.querySelector(".conversation-copy");
      const prev = item.querySelector(".conversation-preview");
      const title = item.querySelector(".conversation-title > span");
      const unit = document.createElement("span");
      unit.style.cssText = `font:${getComputedStyle(prev).font};white-space:nowrap;position:absolute;visibility:hidden`;
      unit.textContent = "一二三四五六七八九十";
      copy.append(unit);
      const per11 = unit.getBoundingClientRect().width / 10;
      unit.remove();
      const overflowX = document.documentElement.scrollWidth > window.innerWidth;
      return {
        rowH: Math.round(item.getBoundingClientRect().height),
        copy: Math.round(copy.clientWidth),
        prevChars: Math.floor(prev.clientWidth / per11),
        prevEndsEllipsis: prev.scrollWidth > prev.clientWidth,
        titleFits: title.scrollWidth <= title.clientWidth,
        overflowX,
      };
    });
    rows.push({ v: name, w, ...m });
    await pg.locator(".list-pane").first().screenshot({ path: `.workbuddy/round376-v-${name}-${w}.png` });
    await pg.close();
  }
}
console.table(rows);
await b.close();
