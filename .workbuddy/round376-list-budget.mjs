import { chromium } from "playwright";
const b = await chromium.launch();
const out = [];
for (const w of [900, 1024, 1180, 1280, 1440, 1600, 1920]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } });
  await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  const r = await pg.evaluate(() => {
    const row = document.querySelector(".conversation-row");
    const item = row.querySelector(".conversation-item");
    const copy = item.querySelector(".conversation-copy");
    const title = copy.querySelector(".conversation-title > span");
    const prev = copy.querySelector(".conversation-preview");
    const t = document.createElement("span");
    t.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap";
    t.textContent = "双十一大促落地页好，分工：@产品经理";
    copy.append(t);
    const px = t.getBoundingClientRect().width / 16;
    t.remove();
    const clipped = (el) => el.scrollWidth > el.clientWidth;
    return {
      listW: getComputedStyle(document.documentElement).getPropertyValue("--list-width").trim(),
      content: document.querySelector(".list-content").clientWidth,
      item: Math.round(item.getBoundingClientRect().width),
      rowH: Math.round(item.getBoundingClientRect().height),
      copy: Math.round(copy.getBoundingClientRect().width),
      chars13: Math.floor(copy.clientWidth / 13),
      chars11: Math.floor(copy.clientWidth / 11),
      titleClipped: clipped(title),
      prevShown: Math.round(prev.clientWidth / px),
    };
  });
  out.push({ w, ...r });
  await pg.close();
}
console.table(out);
await b.close();
