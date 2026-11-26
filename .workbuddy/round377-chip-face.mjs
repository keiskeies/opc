// admin 中性填充（--chip）与页背景（--bg）同值 #f3f5f8 —— 这条要么是无害的巧合，
// 要么是一枚「落在页背景上就消失」的芯片。量它真实压在哪一层，别靠读 CSS 猜。
// 顺带把工作台那一族的 --neutral(#e9edf3) 一起量，给「两套皮肤是否该合一」一个读数。
import { chromium } from "playwright";

const PROBE = () => {
  const lum = (rgb) => {
    const m = rgb.match(/\d+/gu);
    if (!m) return null;
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const c = Number(v) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  };
  const opaque = (c) => !/rgba\(.*,\s*0\)|transparent/u.test(c);
  /** 返回 painted 祖先的【纯颜色】与它的名字 —— 上一版把「颜色 ← .类名」整串喂给 lum()，
   *  正则抓到的是类名里的数字，比值读出 NaN，等于这一维压根没量。 */
  const backdrop = (el) => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (opaque(c)) {
        return { color: c, name: `.${[...n.classList].join(".") || n.tagName.toLowerCase()}` };
      }
    }
    return { color: "", name: "(无 painted 祖先)" };
  };
  const root = getComputedStyle(document.documentElement);
  const adminRoot = document.querySelector(".admin-root");
  const avar = (n) => (adminRoot ? getComputedStyle(adminRoot).getPropertyValue(n).trim() : "(无 admin-root)");
  const seen = new Map();
  for (const sel of [".admin-pill", ".admin-tag", ".admin-edge", ".admin-meter", "pre"]) {
    for (const el of document.querySelectorAll(sel)) {
      const cs = getComputedStyle(el);
      if (el.getBoundingClientRect().width <= 1) continue;
      const ink = cs.color;
      const bg = cs.backgroundColor;
      const key = `${sel}|${bg}|${backdrop(el)}`;
      if (seen.has(key)) {
        seen.get(key).n += 1;
        continue;
      }
      seen.set(key, {
        sel,
        bg,
        ink,
        text: (el.textContent || "").trim().slice(0, 6),
        on: backdrop(el),
        inkOnOwnBg: ratio(ink, bg),
        ownBgOnBackdrop: ratio(bg, backdrop(el).split(" ")[0]),
        pad: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
        fs: cs.fontSize,
        radius: cs.borderTopLeftRadius,
        h: Math.round(el.getBoundingClientRect().height * 10) / 10,
        n: 1,
      });
    }
  }
  return {
    rows: [...seen.values()],
    adminVars: { chip: avar("--chip"), bg: avar("--bg"), card: avar("--card") },
    rootVars: {
      neutral: root.getPropertyValue("--neutral").trim(),
      neutralInk: root.getPropertyValue("--neutral-ink").trim(),
      bg: root.getPropertyValue("--bg").trim(),
    },
  };
};

const b = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const pg = await ctx.newPage();
  console.log(`\n######## theme=${theme} ########`);
  for (const hash of ["#/admin/today", "#/admin/board", "#/admin/roles", "#/admin/replay"]) {
    await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1400);
    const m = await pg.evaluate(PROBE);
    if (m.rows.length === 0) continue;
    console.log(`\n== ${hash} · admin(--chip=${m.adminVars.chip} --bg=${m.adminVars.bg} --card=${m.adminVars.card}) ==`);
    for (const r of m.rows) {
      console.log(
        `  ${r.sel} ×${r.n} 自底 ${r.bg} 墨 ${r.ink}「${r.text}」· 墨/自底 ${r.inkOnOwnBg} · ` +
          `自底/所在面 ${r.ownBgOnBackdrop} · 所在 ${r.on} · ${r.h}px pad=${r.pad} fs=${r.fs} r=${r.radius}`,
      );
    }
  }
  // 工作台那一族的同一角色（中性填充芯片）作对照
  await pg.goto("http://127.0.0.1:9797/group.html#/messages", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1400);
  const g = await pg.evaluate(() => {
    const el = document.querySelector(".speaker-chip");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bg: cs.backgroundColor, ink: cs.color, h: Math.round(el.getBoundingClientRect().height * 10) / 10, pad: cs.padding, fs: cs.fontSize, r: cs.borderTopLeftRadius };
  });
  console.log(`\n  对照：工作台 .speaker-chip ⇒ ${JSON.stringify(g)}`);
  await ctx.close();
}
await b.close();
