// 形状分不开的 chip 到底挂在哪个容器下 —— ancestor 链 + 该容器自己的背景。
// 结论决定修法：如果它们所在的那段列表本来就缺 .admin-card 底，那是【布局漏了卡片】，
// 不该动 --chip 色值（改色会连带击穿 color-scale 的 green/blue-ink/gray 行）。
import { chromium } from "playwright";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "light"));
const pg = await ctx.newPage();
await pg.goto("http://127.0.0.1:9797/group.html#/admin/replay", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(1500);

const chains = await pg.evaluate(() => {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(".admin-pill, .admin-tag")) {
    const cs = getComputedStyle(el);
    if (cs.backgroundColor !== "rgb(243, 245, 248)") continue;
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      parts.push(
        `${(n.className || n.tagName.toLowerCase()).toString().slice(0, 44)} [bg=${getComputedStyle(n).backgroundColor}]`,
      );
    }
    const key = parts.join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ txt: (el.textContent ?? "").trim().slice(0, 12), parts });
  }
  return out;
});

console.log(`形状分不开的 chip 分组：${chains.length} 种祖先链\n`);
for (const g of chains) {
  console.log(`【「${g.txt}」】`);
  for (const p of g.parts) console.log(`      ${p}`);
  console.log("");
}
await b.close();
