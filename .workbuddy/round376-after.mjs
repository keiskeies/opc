import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const b = await chromium.launch();
const rows = [];
for (const w of [390, 641, 861, 900, 1024, 1180, 1280, 1440, 1920]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } });
  await pg.goto("http://127.0.0.1:9797/#/messages", {
    waitUntil: "domcontentloaded",
  });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  const r = await pg.evaluate(() => {
    const list = document.querySelector(".list-content");
    const items = [...document.querySelectorAll(".conversation-item")];
    const item = items[0];
    const copy = item.querySelector(".conversation-copy");
    const prev = item.querySelector(".conversation-preview");
    const cs = getComputedStyle(prev);
    const ruler = document.createElement("span");
    ruler.textContent = "双十一大促落地页好，分工：@产品经理";
    ruler.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${cs.font}`;
    copy.append(ruler);
    const pxPerChar = ruler.getBoundingClientRect().width / ruler.textContent.length;
    ruler.remove();
    const clipped = (el) => el.scrollWidth > el.clientWidth;
    return {
      token: getComputedStyle(document.documentElement)
        .getPropertyValue("--list-width")
        .trim(),
      paneW: Math.round(
        document.querySelector(".list-pane").getBoundingClientRect().width,
      ),
      rowH: Math.round(item.getBoundingClientRect().height),
      copyTrack: Math.round(copy.getBoundingClientRect().width),
      prevPx: cs.fontSize,
      cap: Math.floor(prev.clientWidth / pxPerChar),
      prevClip: items.filter((i) => clipped(i.querySelector(".conversation-preview") ?? document.createElement("i"))).length,
      titleClip: items.filter((i) =>
        clipped(i.querySelector(".conversation-title > span")),
      ).length,
      n: items.length,
      oList: list.scrollWidth - list.clientWidth,
      oDoc:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    };
  });
  rows.push({ w, ...r });
  await pg.close();
}
console.table(rows);

// 主题 × 关键宽度：只量「有没有把行挤坏」
const themeRows = [];
for (const theme of ["light", "dark"]) {
  for (const w of [1024, 1440]) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 } });
    await pg.goto("http://127.0.0.1:9797/#/messages", {
      waitUntil: "domcontentloaded",
    });
    await pg.waitForSelector(".conversation-item", { timeout: 15000 });
    await pg.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await pg.waitForTimeout(250);
    themeRows.push({
      theme,
      w,
      ...(await pg.evaluate(() => {
        const list = document.querySelector(".list-content");
        const items = [...document.querySelectorAll(".conversation-item")];
        return {
          rowH: Math.round(items[0].getBoundingClientRect().height),
          oList: list.scrollWidth - list.clientWidth,
          oDoc:
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
          overflowY: Math.round(list.scrollHeight - list.clientHeight) >= 0,
        };
      })),
    });
    await pg.close();
  }
}
console.table(themeRows);
writeFileSync(
  ".workbuddy/round376-after.log",
  JSON.stringify(
    {
      note: "改后各宽度原始读数（真 CSS，非注入）",
      widths: rows,
      themes: themeRows,
    },
    null,
    2,
  ),
);
await b.close();
