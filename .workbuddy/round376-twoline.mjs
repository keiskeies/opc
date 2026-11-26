import { chromium } from "playwright";

const TWOLINE = `
.conversation-preview{white-space:normal;overflow-wrap:anywhere}
.conversation-title > span{white-space:normal;overflow-wrap:anywhere}
.tw\\:text-balance{text-wrap:balance}
`;

const b = await chromium.launch();
for (const [name, css] of [
  ["nowrap-current", ""],
  ["twoline-balance", TWOLINE + ".conversation-preview{text-wrap:balance}"],
  ["twoline-plain", TWOLINE],
]) {
  for (const w of [1180, 1440]) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 } });
    if (css)
      await pg.addInitScript((c) => {
        const inject = () => {
          const s = document.createElement("style");
          s.textContent = c;
          (document.head || document.documentElement).append(s);
        };
        if (document.documentElement) inject();
        document.addEventListener("DOMContentLoaded", inject);
      }, css);
    await pg.goto("http://127.0.0.1:9797/#/messages", {
      waitUntil: "domcontentloaded",
    });
    await pg.waitForSelector(".conversation-item", { timeout: 15000 });
    const out = await pg.evaluate(() => {
      const items = [...document.querySelectorAll(".conversation-item")];
      const rows = items.map((item) => {
        const prev = item.querySelector(".conversation-preview");
        const r = document.createRange();
        r.selectNodeContents(prev);
        const rects = [...r.getClientRects()].filter((x) => x.width > 0);
        const widths = rects.map((x) => Math.round(x.width));
        const title = item.querySelector(".conversation-title > span");
        const tr = document.createRange();
        tr.selectNodeContents(title);
        const trects = [...tr.getClientRects()].filter((x) => x.width > 0);
        return {
          rowH: Math.round(item.getBoundingClientRect().height),
          prevLines: rects.length,
          ink: widths.join("/"),
          rag: widths.length > 1 ? widths[0] - widths[widths.length - 1] : 0,
          titleLines: trects.length,
          tw: getComputedStyle(prev).textWrapMode ?? getComputedStyle(prev).textWrap,
        };
      });
      const list = document.querySelector(".list-content");
      return {
        rows,
        oList: list.scrollWidth - list.clientWidth,
        oDoc:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      };
    });
    console.log(`\n== ${name} @ ${w} == oList=${out.oList} oDoc=${out.oDoc}`);
    console.table(out.rows);
    await pg.close();
  }
}
await b.close();
