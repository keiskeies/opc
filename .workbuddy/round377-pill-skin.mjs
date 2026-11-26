// 两套皮肤的状态标签（工作台 .pill / 控制室 .admin-pill）到底差在哪。
// 形状上一轮已经对齐（padding 2px 8px / radius pill / --fs-xs / --fw-strong / line-height 1.5），
// 剩下的分歧只有底色：.pill 用 --neutral，.admin-pill 用 --chip。
// 这一发不推算 —— 把屏上真的标签捞出来，读它自己的 computed 底色与墨色，再顺着祖先链
// 找第一层不透明底（与 color-scale.test.ts 的「落点」同一套口径），算实际对比度。
// 只有量出来的数才能决定：这枚底色差是【该并】还是【该留】。
import { chromium } from "playwright";

const PROBE = (sel) => {
  const lum = (c) => {
    const m = c.match(/(\d+(?:\.\d+)?)/g);
    if (!m) return null;
    const [r, g, b] = [0, 1, 2].map((i) => {
      const v = Number(m[i]) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const x = lum(a);
    const y = lum(b);
    if (x === null || y === null) return null;
    return Number(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)).toFixed(2));
  };
  const opaque = (c) => !/rgba?\([^)]*,\s*0(\.0+)?\)/u.test(c) && c !== "transparent";
  const backdrop = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (opaque(cs.backgroundColor)) return { bg: cs.backgroundColor, at: `${p.tagName.toLowerCase()}.${[...p.classList].join(".")}` };
    }
    return { bg: "rgba(0,0,0,0)", at: "(没有不透明祖先)" };
  };
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const bd = backdrop(el);
    out.push({
      cls: el.className,
      txt: (el.textContent || "").trim().slice(0, 10),
      bg: cs.backgroundColor,
      ink: cs.color,
      pad: cs.padding,
      radius: cs.borderRadius,
      fs: cs.fontSize,
      fw: cs.fontWeight,
      lh: cs.lineHeight,
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      inkOnSelf: ratio(cs.color, cs.backgroundColor),
      selfOnBackdrop: ratio(cs.backgroundColor, bd.bg),
      inkOnBackdrop: ratio(cs.color, bd.bg),
      backdrop: `${bd.bg} @ ${bd.at}`,
    });
  }
  return out;
};

const b = await chromium.launch();
for (const theme of ["light", "dark"]) {
  for (const [label, hash, sel] of [
    ["工作台 .pill", "#/backlog", ".pill"],
    ["工作台 .pill(文档)", "#/documents", ".pill"],
    ["控制室 .admin-pill", "#/admin/today", ".admin-pill"],
  ]) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
    const pg = await ctx.newPage();
    await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1400);
    const rows = await pg.evaluate(PROBE, sel);
    console.log(`\n── ${theme} · ${label} ${hash} · ${rows.length} 枚 ──`);
    for (const r of rows.slice(0, 6)) {
      console.log(
        `  ${r.cls} 「${r.txt}」 ${r.w}x${r.h} pad=${r.pad} fs=${r.fs} fw=${r.fw} lh=${r.lh} r=${r.radius}\n` +
          `     底=${r.bg} 墨=${r.ink} 落点=${r.backdrop}\n` +
          `     墨/底=${r.inkOnSelf} · 底/落点=${r.selfOnBackdrop} · 墨/落点=${r.inkOnBackdrop}`,
      );
    }
    await ctx.close();
  }
}
await b.close();
