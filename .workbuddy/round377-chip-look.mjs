// 看一眼 admin replay 页浅色下的芯片：--chip 与 --bg 同值 #f3f5f8，
// 实测 17 枚 .admin-pill + 17 枚 .admin-tag 直接坐在页背景上（自底/所在面 = 1.00）。
// 动色值之前先确认屏幕上读出来是什么：是「芯片隐形成一行裸文字」，还是本来就在纸面块里。
import { chromium } from "playwright";

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 1000 } });
await pg.goto("http://127.0.0.1:9797/group.html#/admin/replay", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(2000);
const info = await pg.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    let n = el.parentElement;
    const chain = [];
    while (n) {
      const cs = getComputedStyle(n);
      chain.push(`${[...n.classList].join(".") || n.tagName.toLowerCase()}[${cs.backgroundColor}]`);
      n = n.parentElement;
    }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { text: (el.textContent || "").trim().slice(0, 20), bg: cs.backgroundColor, color: cs.color, border: cs.borderTopWidth, box: `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`, chain: chain.slice(0, 4).join(" ← ") };
  };
  return {
    pillOnBg: pick(".admin-pill"),
    tag: pick(".admin-tag"),
    card: (() => {
      const el = document.querySelector(".admin-card");
      return el ? { bg: getComputedStyle(el).backgroundColor, y: Math.round(el.getBoundingClientRect().y) } : null;
    })(),
  };
});
console.log(JSON.stringify(info, null, 1));
await pg.screenshot({ path: ".workbuddy/round377-admin-replay-light.png", fullPage: false });
// 再截一枚芯片本体的局部放大，肉眼判「读不读得出来」
const box = await pg.evaluate(() => {
  const els = [...document.querySelectorAll(".admin-pill, .admin-tag")].filter((e) => e.getBoundingClientRect().width > 1);
  if (els.length === 0) return null;
  const r = els[0].getBoundingClientRect();
  return { x: Math.max(0, r.x - 30), y: Math.max(0, r.y - 24), width: Math.min(520, r.width + 60), height: 64 };
});
if (box) await pg.screenshot({ path: ".workbuddy/round377-admin-chip-zoom.png", clip: box });
await b.close();
console.log("截图：.workbuddy/round377-admin-replay-light.png / round377-admin-chip-zoom.png");
