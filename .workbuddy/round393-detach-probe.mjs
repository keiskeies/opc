import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(
  `<div id=s style="height:120px;overflow:auto"><div style="height:2000px">x</div></div>`,
);
const reading = await page.evaluate(() => {
  const s = document.getElementById("s");
  s.scrollTop = 500;
  const live = { top: s.scrollTop, sh: s.scrollHeight, ch: s.clientHeight };
  const clone = s.cloneNode(true);
  s.remove();
  const detached = {
    top: clone.scrollTop,
    sh: clone.scrollHeight,
    ch: clone.clientHeight,
  };
  return {
    live,
    detached,
    dcl: document.documentElement.clientHeight,
    bodySh: document.body.scrollHeight,
  };
});
console.log(JSON.stringify(reading, null, 2));
await browser.close();
