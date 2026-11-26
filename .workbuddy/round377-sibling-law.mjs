// 同排同高那条「兄弟组合器」法的三发实据 —— 每条组合器各配一发「它必须真的改到盒子」的验证。
// 为什么不能只靠穷举：round377-sibling-audit 比的是【同一父元素下】的控件，而 CSS 里
// 特意有第三条跨一层的组合器（工具条里的子组与外层工具共用同一行但不同级）。
// 那条规则【有没有】生效，穷举看不出来 —— 得按垂直重叠跨层级量，并对每条组合器单独验。
import { chromium } from "playwright";

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();

const OVERLAP = () => {
  const laidOut = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const face = (el) => {
    const cs = getComputedStyle(el);
    return cs.backgroundColor !== "rgba(0, 0, 0, 0)" || parseFloat(cs.borderTopWidth) > 0;
  };
  const CONTROL = /^(BUTTON|INPUT|SELECT|TEXTAREA)$/u;
  const isCtl = (el) => (CONTROL.test(el.tagName) || el.classList.contains("btn")) && face(el);
  const label = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
  const h = (el) => Math.round(el.getBoundingClientRect().height * 100) / 100;
  const ov = (a, b) => {
    const x = a.getBoundingClientRect();
    const y = b.getBoundingClientRect();
    return Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
  };
  const smalls = [...document.querySelectorAll(".btn.small")].filter(laidOut);
  const out = [];
  for (const s of smalls) {
    const partners = [...document.querySelectorAll("body *")].filter(
      (o) => o !== s && laidOut(o) && isCtl(o) && !o.contains(s) && !s.contains(o) && ov(s, o) > 0.5 * Math.min(s.getBoundingClientRect().height, o.getBoundingClientRect().height),
    );
    if (partners.length === 0) continue;
    out.push({
      small: label(s),
      hSmall: h(s),
      txt: (s.textContent || s.getAttribute("aria-label") || "").trim().slice(0, 10),
      sameParent: partners.some((p) => p.parentElement === s.parentElement),
      nested: partners.filter((p) => p.parentElement !== s.parentElement).map((p) => `${label(p)} h=${h(p)}`).slice(0, 3),
      partnerHeights: [...new Set(partners.map(h))].sort((a, c) => a - c),
    });
  }
  return out;
};

const VIEWS_HASH = ["#/backlog", "#/messages", "#/documents", "#/settings", "#/talent", "#/contacts"];
let mixed = 0;
let seen = 0;
for (const hash of VIEWS_HASH) {
  await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1200);
  for (const row of await pg.evaluate(OVERLAP)) {
    seen += 1;
    const bad = row.partnerHeights.some((x) => Math.abs(x - row.hSmall) > 0.5);
    if (bad) {
      mixed += 1;
      console.log(`混高：${row.small} h=${row.hSmall} 「${row.txt}」 同层=${row.sameParent} 邻居档=${row.partnerHeights.join("/")} 跨层邻居=${row.nested.join(" , ")}`);
    }
  }
}
console.log(`\n跨层级量到 ${seen} 枚与别枚控件同排的 .btn.small · 其中混高 ${mixed} 枚`);

// ── 三条组合器各验一发：造一个最小现场，量升档前后的读数 ──────────────
const CASES = [
  {
    name: "① 前向 `默认档 ~ .btn.small`",
    html: `<div class="row"><button class="btn">默认</button><button class="btn small">小的</button></div>`,
  },
  {
    name: "② 后向 `.btn.small:has(~ 默认档)`",
    html: `<div class="row"><button class="btn small">小的</button><button class="btn">默认</button></div>`,
  },
  {
    name: "③ 跨层 `默认档 ~ * .btn.small`（子组与外层工具同级但不同父）",
    html: `<div class="row"><button class="btn">默认</button><span class="grp"><button class="btn small">小的</button></span></div>`,
  },
];
console.log("\n── 三条组合器逐条实测（同一页里换标记，量那颗 .btn.small 的高度）──");
await pg.goto("http://127.0.0.1:9797/group.html#/backlog", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(1200);
for (const c of CASES) {
  const got = await pg.evaluate(async (html) => {
    const box = document.createElement("div");
    box.className = "list-pane";
    box.innerHTML = `<style>.probe-row{display:flex;align-items:center}</style><div class="probe-row">${html.replace(/class="row"/gu, 'class="probe-row"')}</div>`;
    document.querySelector(".list-pane").append(box);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const el = box.querySelector(".btn.small");
    const cs = getComputedStyle(el);
    const out = { h: Math.round(el.getBoundingClientRect().height * 100) / 100, fs: cs.fontSize };
    box.remove();
    return out;
  }, c.html);
  const ok = Math.abs(got.h - 34.14) < 0.6 && got.fs === "13px";
  console.log(`  ${ok ? "✓" : "✗"} ${c.name} ⇒ 那颗 .btn.small 读 ${got.h}px / ${got.fs}（应与默认档同 34.14 / 13px）`);
  if (!ok) mixed += 1;
}
// 反向对照：同一种标记但把默认档那枚摘掉 ⇒ .btn.small 必须【不】升档（29），
// 否则上面三条是恒真（无论有没有邻居都绿）。
const alone = await pg.evaluate(async () => {
  const box = document.createElement("div");
  box.className = "list-pane";
  box.innerHTML = `<div class="probe-row"><button class="btn small">单独的小的</button></div>`;
  document.querySelector(".list-pane").append(box);
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  const el = box.querySelector(".btn.small");
  const out = { h: Math.round(el.getBoundingClientRect().height * 100) / 100, fs: getComputedStyle(el).fontSize };
  box.remove();
  return out;
});
const aloneOk = Math.abs(alone.h - 29.5) < 1 && alone.fs === "12px";
console.log(`  ${aloneOk ? "✓" : "✗"} 反向对照（无邻居）⇒ 读 ${alone.h}px / ${alone.fs}（必须【不】升档，否则前三条恒真）`);
if (!aloneOk) mixed += 1;
await b.close();
console.log(`\n判定：${mixed === 0 ? "同排同高在真页面上成立，且三条组合器各自承重" : `${mixed} 处不成立`}`);
process.exit(mixed === 0 ? 0 : 1);
