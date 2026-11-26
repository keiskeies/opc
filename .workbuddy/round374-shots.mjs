// 逐视口 × 明暗 的渲染验收（round374 收尾用）。
//
// 与 .tmp/shots.mjs 的差别只有一处，但那一处决定这份读数是真是假：
// 本仓的暗色【不是】prefers-color-scheme，而是 theme.js 给 <html> 落的 data-theme；
// 只有「localStorage 里没有用户显式选择」时它才跟随系统。所以上一版靠
// newContext({ colorScheme }) 判「× 明暗」是有��提的 —— 前提若断了（比如某处把
// opc:theme 写进了 localStorage，或 theme.js 改了默认），暗色那 21 张其实拍的是浅色，
// 而报告照样 42 shots / 0 problems。
// 这一版每张都读回【生效的那一档】：documentElement.dataset.theme + 计算后的 --bg，
// 两样任一不对就在报告里单列。判据尺子必须与被量的那次渲染有因果。
import { chromium } from "playwright";

const ORIGIN = process.env.ORIGIN ?? "http://127.0.0.1:9797";
const OUT = process.env.OUT ?? ".tmp/shots/after-374";
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 900 },
  { name: "1440", width: 1440, height: 900 },
];
const ROUTES = [
  "messages",
  "contacts",
  "documents",
  "backlog",
  "talent",
  "settings",
  "admin/today",
];
/** 浅色真值与暗色真值（group.css :root / [data-theme="dark"] 的 --bg），用来证明确实翻了面。 */
const EXPECT_BG = { light: null, dark: null };

const browser = await chromium.launch();
const report = [];
for (const vp of VIEWPORTS) {
  for (const dark of [false, true]) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      colorScheme: dark ? "dark" : "light",
    });
    // 清掉可能残留的显式选择：本仓「用户点过按钮」优先于系统偏好，留着它暗色就不来。
    await ctx.addInitScript(() => {
      try {
        localStorage.removeItem("opc:theme");
      } catch {
        /* 隐私模式：无所谓，读不到存储时 theme.js 本来就走系统偏好 */
      }
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
    for (const route of ROUTES) {
      await page.goto(`${ORIGIN}/#/${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1600);
      const want = dark ? "dark" : "light";
      const tag = `${vp.name}-${want}-${route.replace("/", "-")}`;
      const box = await page.evaluate(() => {
        const de = document.documentElement;
        let widest = null;
        let widestW = de.clientWidth;
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width > widestW && r.width > 0) {
            widestW = Math.round(r.width);
            widest =
              el.tagName.toLowerCase() +
              (el.className && typeof el.className === "string"
                ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
                : "");
          }
        }
        const cs = getComputedStyle(de);
        return {
          scrollW: de.scrollWidth,
          innerW: de.innerWidth,
          widest,
          widestW,
          theme: de.dataset.theme ?? "(未设=浅色)",
          bg: cs.getPropertyValue("--bg").trim(),
          ink: cs.getPropertyValue("--ink").trim(),
          // 本轮接的 Tailwind 产物在页面里到底进了级联没有（只读，不注入类名）
          twLinked: [...document.querySelectorAll("link[rel=stylesheet]")]
            .map((l) => new URL(l.href).pathname)
            .includes("/tw.css"),
        };
      });
      const overflow = box.scrollW > box.innerW + 1;
      // 主题翻面判据：要暗则 data-theme 必须是 dark；要浅则【不许】是 dark。
      const themeOk = dark ? box.theme === "dark" : box.theme !== "dark";
      if (EXPECT_BG[want] === null) EXPECT_BG[want] = box.bg;
      report.push({
        tag,
        overflow,
        themeOk,
        want,
        theme: box.theme,
        bg: box.bg,
        ink: box.ink,
        twLinked: box.twLinked,
        scrollW: box.scrollW,
        innerW: box.innerW,
        widest: overflow ? `${box.widest} @${box.widestW}px` : "",
        errors: errors.slice(0, 2),
      });
      await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: false });
      errors.length = 0;
    }
    await ctx.close();
  }
}
await browser.close();

const bad = report.filter((r) => r.overflow || r.errors.length || !r.themeOk);
console.log(
  `=== ${report.length} shots，问题 ${bad.length}；--bg 浅=${EXPECT_BG.light} 暗=${EXPECT_BG.dark} ===`,
);
console.log(
  `主题：暗色拍到位 ${report.filter((r) => r.want === "dark" && r.themeOk).length}/21；` +
    `tw.css 挂载 ${report.filter((r) => r.twLinked).length}/${report.length}`,
);
for (const r of bad) {
  console.log(
    `${r.tag}: theme=${r.theme}(要 ${r.want}) bg=${r.bg} ink=${r.ink} ` +
      `scrollW=${r.scrollW}>innerW=${r.innerW} widest=${r.widest} err=${r.errors.join(" | ")}`,
  );
}
// 明暗两套 --bg 若相同，说明整个「× 明暗」白跑（这一句对着读数的性质判，不对着我的意图判）。
if (EXPECT_BG.light === EXPECT_BG.dark) {
  console.log("!! 明暗两套 --bg 相同 ⇒ 主题从未翻面，本报告的「× 明暗」不成立");
}
