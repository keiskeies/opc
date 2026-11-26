// round378 改前预算：文档编辑页「编辑区到底拿到多少高度」+ 两个待查视觉缺陷。
// 只读，不写任何业务数据（不点保存、不改正文），截图不落盘。
// 三件事：
//  ① 逐 kind（表格 / Markdown / 富文本）把 .doc-page 直接子元素的高度逐条打出来，
//     并算「真正能写字的那一层拿到视口高的百分之几」—— 这是本轮要改的靶子，也是改后要复量的数；
//  ② 暗色下表格右上角那块白：扫 .sheet-canvas 里背景接近纯白的元素，打 class + 矩形；
//  ③ 富文本页工具条下方与底部那两条蓝线：扫 .editor-card 内 border/outline 取色接近 --primary 的元素。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";
const WANT = ["表格", "Markdown", "富文本"];

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();

async function openOne(kindLabel) {
  await p.goto(`${BASE}/#/documents`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1500);
  const n = await p.locator("#listContent .doc-list-item").count();
  for (let i = 0; i < n; i++) {
    await p.locator("#listContent .doc-list-item").nth(i).click();
    await p.waitForTimeout(1300);
    const sub = await p.locator(".doc-sub").first().textContent().catch(() => "");
    if ((sub ?? "").includes(kindLabel)) return true;
  }
  return false;
}

const budget = async (label) => {
  const m = await p.evaluate(() => {
    const page = document.querySelector(".doc-page");
    if (!page) throw new Error("没有 .doc-page");
    const kids = [...page.children].map((c) => ({
      c: (c.className || c.tagName).toString().trim().replace(/\s+/g, "."),
      h: +c.getBoundingClientRect().height.toFixed(1),
    }));
    const card = page.querySelector(".editor-card");
    const surf = page.querySelector(".editor-surface");
    const inner =
      page.querySelector(".markdown-editor, .sheet-canvas, .rich-editor, .mindmap-outline");
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const stat = page.querySelector(".editor-status");
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      viewH: +document.querySelector("#view").getBoundingClientRect().height.toFixed(1),
      pagePad: cs(page).padding,
      kids,
      gap: cs(page).rowGap,
      cardPad: card ? cs(card).padding : null,
      cardH: card ? +card.getBoundingClientRect().height.toFixed(1) : null,
      surfH: surf ? +surf.getBoundingClientRect().height.toFixed(1) : null,
      innerSel: inner ? inner.className.toString().split(" ")[0] : null,
      innerH: inner ? +inner.getBoundingClientRect().height.toFixed(1) : null,
      statusH: stat ? +stat.getBoundingClientRect().height.toFixed(1) : null,
    };
  });
  const pct = m.innerH !== null ? ((m.innerH / m.vh) * 100).toFixed(1) : "—";
  console.log(`\n【${label}】视口 ${m.vw}×${m.vh}  #view=${m.viewH}  .doc-page pad=${m.pagePad} gap=${m.gap}`);
  for (const k of m.kids) console.log(`   ├ ${k.c.padEnd(34)} h=${k.h}`);
  console.log(
    `   .editor-card h=${m.cardH} pad=${m.cardPad}   .editor-surface h=${m.surfH}   ` +
      `status h=${m.statusH}`,
  );
  console.log(`   ⇒ 真正写字的 .${m.innerSel} h=${m.innerH} 占视口高 ${pct}%`);
  return m;
};

const whiteInSheet = async () => {
  const m = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".sheet-canvas *, .editor-card *")) {
      const cs = getComputedStyle(el);
      const a = /rgba?\(([^)]+)\)/u.exec(cs.backgroundColor);
      if (a === null) continue;
      const [r, g, bb, al] = a[1].split(",").map((x) => Number.parseFloat(x));
      const alpha = al === undefined ? 1 : al;
      if (alpha < 0.5 || r < 235 || g < 235 || bb < 235) continue;
      const bx = el.getBoundingClientRect();
      if (bx.width < 4 || bx.height < 4) continue;
      out.push({
        c: (el.className || el.tagName).toString().trim().replace(/\s+/g, ".").slice(0, 46),
        bg: cs.backgroundColor,
        rect: `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}`,
      });
    }
    return out.slice(0, 12);
  });
  console.log(`  暗色下 .editor-card 内接近纯白的元素 ${m.length} 个：`);
  for (const x of m) console.log(`    ${x.c.padEnd(48)} ${x.bg.padEnd(20)} ${x.rect}`);
};

const blueLines = async () => {
  const m = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".doc-page *")) {
      const cs = getComputedStyle(el);
      const near = (v) => v.includes("rgb(56, 103, 214)") || v.includes("rgb(55, 10");
      const sides = [
        ["top", cs.borderTopWidth, cs.borderTopColor],
        ["bottom", cs.borderBottomWidth, cs.borderBottomColor],
      ];
      for (const [side, w, c] of sides) {
        if (parseFloat(w) < 1 || !near(c)) continue;
        const bx = el.getBoundingClientRect();
        out.push({
          c: (el.className || el.tagName).toString().trim().replace(/\s+/g, ".").slice(0, 40),
          side,
          w,
          col: c,
          rect: `${Math.round(bx.x)},${Math.round(bx.y)} ${Math.round(bx.width)}×${Math.round(bx.height)}`,
        });
      }
      if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0 && near(cs.outlineColor)) {
        out.push({ c: (el.className || el.tagName).toString().slice(0, 40), side: "outline", w: cs.outlineWidth, col: cs.outlineColor, rect: "" });
      }
    }
    return out.slice(0, 12);
  });
  console.log(`  取色接近 --primary 的边框/轮廓 ${m.length} 处：`);
  for (const x of m) console.log(`    ${x.c.padEnd(42)} ${x.side}=${x.w} ${x.col} ${x.rect}`);
};

for (const k of WANT) {
  const ok = await openOne(k);
  if (!ok) {
    console.log(`\n【${k}】没找到这种文档，跳过`);
    continue;
  }
  await budget(k);
  if (k === "表格") await whiteInSheet();
  if (k === "富文本") await blueLines();
}

// 各档视口下编辑区占比（同一篇 Markdown，看窄档塌不塌）
if (await openOne("Markdown")) {
  for (const w of [1440, 1100, 900, 640]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(700);
    const r = await p.evaluate(() => {
      const inner = document.querySelector(".markdown-editor");
      const ox = document.documentElement.scrollWidth - window.innerWidth;
      return {
        h: inner ? +inner.getBoundingClientRect().height.toFixed(0) : null,
        ox,
      };
    });
    console.log(`  Markdown 视口宽 ${w}：编辑面 h=${r.h} 横向溢出=${r.ox}${r.ox > 0 ? " ⚠" : ""}`);
  }
}
await b.close();
