import { chromium } from "playwright";

const b = await chromium.launch();
const pg = await b.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
await pg.waitForSelector(".conversation-item", { timeout: 15000 });
const data = await pg.evaluate(() => {
  const R = (el) => {
    const r = el.getBoundingClientRect();
    return { t: Math.round(r.top), b: Math.round(r.bottom), h: Math.round(r.height) };
  };
  const rows = [...document.querySelectorAll(".conversation-item")].map((item) => {
    const title = item.querySelector(".conversation-title > span");
    const prev = item.querySelector(".conversation-preview");
    const time = item.querySelector(".conversation-time");
    const unread = item.querySelector(".unread");
    const tail = item.querySelector(".conversation-tail");
    return {
      twoLine: !!prev,
      item: R(item),
      title: R(title),
      prev: prev ? R(prev) : null,
      time: time ? R(time) : null,
      unread: unread ? R(unread) : null,
      tail: tail ? R(tail) : null,
    };
  });
  const labels = [...document.querySelectorAll(".list-section")].map((el) => {
    const cs = getComputedStyle(el);
    const r = document.createRange();
    r.selectNodeContents(el);
    const rects = [...r.getClientRects()];
    return {
      text: el.textContent.slice(0, 12),
      fs: cs.fontSize,
      fw: cs.fontWeight,
      ls: cs.letterSpacing,
      tt: cs.textTransform,
      inkW: Math.round(rects[0] ? rects[0].width : 0),
      glyphs: el.textContent.trim().length,
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
    };
  });
  return { rows, labels };
});
console.log("== labels ==");
console.table(data.labels);
console.log("== rows ==");
console.table(
  data.rows.map((r) => ({
    twoLine: r.twoLine,
    rowT: r.item.t,
    rowH: r.item.h,
    titleT: r.title.t,
    prevB: r.prev ? r.prev.b : "-",
    timeT: r.time ? r.time.t - r.item.t : "-",
    unreadB: r.unread ? r.item.b - r.unread.b : "-",
    tailT: r.tail ? r.tail.t - r.item.t : "-",
    tailB: r.tail ? r.item.b - r.tail.b : "-",
  })),
);
await pg.screenshot({
  path: ".workbuddy/round376-list-1440.png",
  clip: { x: 65, y: 64, width: 320, height: 640 },
});
await b.close();
