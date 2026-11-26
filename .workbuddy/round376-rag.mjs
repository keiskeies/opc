import { chromium } from "playwright";

const b = await chromium.launch();
const rows = [];
for (const w of [1024, 1440]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } });
  await pg.goto("http://127.0.0.1:9797/#/messages", {
    waitUntil: "domcontentloaded",
  });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  const data = await pg.evaluate(() => {
    const out = [];
    for (const item of document.querySelectorAll(".conversation-item")) {
      const copy = item.querySelector(".conversation-copy");
      const title = copy.querySelector(".conversation-title");
      const titleSpan = copy.querySelector(".conversation-title > span");
      const prev = copy.querySelector(".conversation-preview");
      if (!prev) continue;
      // 墨迹右边界：Range 取该节点最后一行的矩形
      const inkRight = (node) => {
        const r = document.createRange();
        r.selectNodeContents(node);
        const rects = [...r.getClientRects()];
        const last = rects[rects.length - 1];
        return last ? Math.round(last.right) : 0;
      };
      out.push({
        id: item.getAttribute("data-conversation-id"),
        copyTrack: Math.round(copy.getBoundingClientRect().width),
        titleFlex: Math.round(title.getBoundingClientRect().width),
        titleInk: Math.round(titleSpan.getBoundingClientRect().width),
        prevTrack: Math.round(prev.getBoundingClientRect().width),
        titleRight: inkRight(titleSpan),
        prevRight: inkRight(prev),
        prevClipped: prev.scrollWidth > prev.clientWidth,
      });
    }
    const base = out[0];
    return {
      rows: out.map((r) => ({
        ...r,
        rag: r.titleRight - r.prevRight,
        dCopy: r.copyTrack - (base?.copyTrack ?? 0),
      })),
    };
  });
  rows.push({ viewport: w, ...data });
  await pg.close();
}
for (const v of rows) {
  console.log(`\n== viewport ${v.viewport} ==`);
  console.table(v.rows);
}
await b.close();
