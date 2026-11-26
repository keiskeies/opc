import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

// 变体：只在页面里注入覆盖样式，逐量取「该改动本该影响的属性」
const VARIANTS = {
  A_baseline: "",
  W_wide340: `:root{--list-width:340px}@media(max-width:1180px){:root{--list-width:305px}}`,
  P_prev12: `.conversation-preview{font-size:var(--fs-sm)}`,
  T_final: [
    `:root{--list-width:340px}`,
    `@media(max-width:1180px){:root{--list-width:305px}}`,
    `.conversation-preview{font-size:var(--fs-sm);line-height:1.35;margin-top:2px}`,
    `.list-section{letter-spacing:normal;text-transform:none}`,
  ].join(""),
  X_prev12only: `.conversation-preview{font-size:var(--fs-sm);line-height:1.35;margin-top:2px}`,
};

// 一条天然会被截断的预览文案（用来量「还能显示几个字」）
const PROBE_TEXT = "双十一大促落地页好，分工：@产品经理";

const b = await chromium.launch();
const rows = [];
const shots = [];
for (const [name, css] of Object.entries(VARIANTS)) {
  for (const w of [900, 1024, 1180, 1280, 1440, 1920]) {
    const pg = await b.newPage({ viewport: { width: w, height: 900 } });
    if (css) {
      await pg.addInitScript((c) => {
        const inject = () => {
          const s = document.createElement("style");
          s.textContent = c;
          (document.head || document.documentElement).append(s);
        };
        if (document.documentElement) inject();
        document.addEventListener("DOMContentLoaded", inject);
      }, css);
    }
    await pg.goto("http://127.0.0.1:9797/#/messages", {
      waitUntil: "domcontentloaded",
    });
    await pg.waitForSelector(".conversation-item", { timeout: 15000 });
    const r = await pg.evaluate((probeText) => {
      const item = document.querySelector(".conversation-item");
      const copy = item.querySelector(".conversation-copy");
      const list = document.querySelector(".list-content");
      // 单字宽度标尺：与预览同字体同字号
      const ruler = document.createElement("span");
      ruler.style.cssText =
        "position:absolute;visibility:hidden;white-space:nowrap";
      ruler.textContent = probeText;
      const prevEl = item.querySelector(".conversation-preview");
      ruler.style.font = getComputedStyle(prevEl).font;
      copy.append(ruler);
      const pxPerChar = ruler.getBoundingClientRect().width / probeText.length;
      ruler.remove();
      const ink = (node) => {
        const r2 = document.createRange();
        r2.selectNodeContents(node);
        const rects = [...r2.getClientRects()];
        return {
          right: rects.length ? Math.round(rects[rects.length - 1].right) : 0,
          bottom: rects.length ? Math.round(rects[rects.length - 1].bottom) : 0,
          top: rects.length ? Math.round(rects[0].top) : 0,
        };
      };
      const titleSpan = item.querySelector(".conversation-title > span");
      const prev = item.querySelector(".conversation-preview");
      const label = document.querySelector(".list-section");
      const labelRuler = document.createElement("span");
      labelRuler.style.cssText =
        "position:absolute;visibility:hidden;white-space:nowrap";
      labelRuler.textContent = label.textContent;
      labelRuler.style.font = getComputedStyle(label).font;
      labelRuler.style.letterSpacing = "0px";
      document.body.append(labelRuler);
      const labelNatural = labelRuler.getBoundingClientRect().width;
      labelRuler.remove();
      const labelRange = document.createRange();
      labelRange.selectNodeContents(label);
      const labelInk = [...labelRange.getClientRects()];
      return {
        listW: Math.round(
          document
            .querySelector(".workspace")
            .getBoundingClientRect()
            .width,
        ),
        panelW: Math.round(
          document.querySelector(".list-pane")?.getBoundingClientRect().width ??
            0,
        ),
        rowH: Math.round(item.getBoundingClientRect().height),
        copyTrack: Math.round(copy.getBoundingClientRect().width),
        prevPx: getComputedStyle(prev).fontSize,
        prevChars: Math.round(prev.clientWidth / pxPerChar),
        gapTitlePrev: Math.round(ink(prev).top - ink(titleSpan).top),
        overflowList: list.scrollWidth - list.clientWidth,
        overflowDoc:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        labelInkW: Math.round(labelInk[0]?.width ?? 0),
        labelNaturalW: Math.round(labelNatural),
      };
    }, PROBE_TEXT);
    rows.push({ variant: name, w, ...r });
    if (w === 1440 || w === 1024) {
      const p = `.workbuddy/round376-c-${name}-${w}.png`;
      await pg.screenshot({
        path: p,
        clip: { x: 65, y: 64, width: 360, height: 560 },
      });
      shots.push(p);
    }
    await pg.close();
  }
}
const cols = [
  "variant",
  "w",
  "panelW",
  "rowH",
  "copyTrack",
  "prevPx",
  "prevChars",
  "gapTitlePrev",
  "overflowList",
  "overflowDoc",
  "labelInkW",
  "labelNaturalW",
];
console.table(rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))));
writeFileSync(
  ".workbuddy/round376-typo-probe.log",
  JSON.stringify({ note: "variant 对比原始读数，供台账复算", rows }, null, 2),
);
await b.close();
