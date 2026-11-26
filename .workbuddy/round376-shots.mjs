import { chromium } from "playwright";
const b = await chromium.launch();
for (const [name, route] of [
  ["chat", "#/messages"],
  ["docs", "#/documents"],
]) {
  for (const w of [1024, 1440]) {
    const pg = await b.newPage({
      viewport: { width: w, height: 900 },
      deviceScaleFactor: 2,
    });
    await pg.goto(`http://127.0.0.1:9797/${route}`, {
      waitUntil: "domcontentloaded",
    });
    await pg.waitForSelector(".list-pane .list-content > *", { timeout: 15000 });
    await pg.waitForTimeout(400);
    const info = await pg.evaluate(() => {
      const list = document.querySelector(".list-content");
      return {
        oList: list.scrollWidth - list.clientWidth,
        w: Math.round(
          document.querySelector(".list-pane").getBoundingClientRect().width,
        ),
      };
    });
    console.log(name, w, JSON.stringify(info));
    await pg.screenshot({
      path: `.workbuddy/round376-after-${name}-${w}.png`,
      clip: { x: 0, y: 64, width: Math.min(w, 420), height: 700 },
    });
    await pg.close();
  }
}
await b.close();
