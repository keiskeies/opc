import { chromium } from "playwright";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 3 });
await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
await pg.waitForSelector(".conversation-item", { timeout: 15000 });
const probe = await pg.evaluate(() => {
  const mk = (w, fam) => {
    const s = document.createElement("span");
    s.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font-size:13px;font-weight:${w};font-family:${fam}`;
    s.textContent = "双十一大促落地页 ABC 09:03";
    document.body.append(s);
    const r = s.getBoundingClientRect().width;
    s.remove();
    return Math.round(r * 100) / 100;
  };
  const yahei = '"Microsoft YaHei", sans-serif';
  const sego = '"Segoe UI", sans-serif';
  return {
    facesLoaded: document.fonts.size,
    inter: document.fonts.check('13px Inter'),
    weights_yahei: { d400: mk(400, yahei), d500: mk(500, yahei), d650: mk(650, yahei), d700: mk(700, yahei) },
    weights_segoe: { d400: mk(400, sego), d500: mk(500, sego), d650: mk(650, sego), d700: mk(700, sego) },
    sectionLabel: (() => { const s = document.querySelector(".list-section"); const c = getComputedStyle(s); return { fs: c.fontSize, fw: c.fontWeight, ls: c.letterSpacing, tt: c.textTransform, w: Math.round(s.getBoundingClientRect().width) }; })(),
    labelGlyphBoxes: [...document.querySelectorAll(".list-section")].map((s) => {
      const r = s.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(s);
      const rects = [...range.getClientRects()].map((x) => Math.round(x.width));
      return { text: s.textContent.trim(), inkWidths: rects, box: Math.round(r.width) };
    }),
  };
});
console.log(JSON.stringify(probe, null, 1));
await pg.locator(".conversation-row").nth(0).screenshot({ path: ".workbuddy/round376-row0.png" });
await pg.locator(".list-section").first().screenshot({ path: ".workbuddy/round376-label.png" });
await b.close();
