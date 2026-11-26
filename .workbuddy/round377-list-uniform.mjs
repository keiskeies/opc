// 同列表内参差穷举：凡是「同一父元素下 ≥3 个同基准类名的重复项」，比对它们的关键档位
// （高度 / 字号 / 圆角 / 横向内距 / 字重 / gap），报出同一列表里读出不一致的那些。
// 为什么按【基准类名】切：列表的定义不是标签而是形状 —— .task-card ×6、.doc-tree summary ×N
// 这种。按【完整 class 集】切会把 .card 与 .card.done 分成两组，于是「一枚跟其余不一样」
// 这个症状恰好被自己的分组条件排除（上一版判据就败在这里，全仓报 0 组）。
// 为什么不能肉眼抽查：同列表参差是「一枚跟其余不一样」，抽查很容易连续挑到一样的那几枚。
//
// 判据口径：
//  · 「列表」= 同一父元素下 ≥3 个【标签 + 首个类】相同的可见兄弟；
//  · 档位是离散刻度 ⇒ 字号/圆角/内距/字重/gap 零容差，差一档就是差一档；
//  · 唯独高度留 0.6px：同一档位会因内容行数差出亚像素（那是内容不是档位），
//    卡片类真走样时由字号/圆角/内距那几维兜住。
import { chromium } from "playwright";

const PROBE = () => {
  const laidOut = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const base = (el) => `${el.tagName.toLowerCase()}.${el.classList[0] ?? "(无类)"}`;
  const label = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
  const h = (el) => Math.round(el.getBoundingClientRect().height * 10) / 10;
  const out = [];
  for (const parent of document.querySelectorAll("body *")) {
    if (!laidOut(parent)) continue;
    const kids = [...parent.children].filter(laidOut);
    if (kids.length < 3) continue;
    const byKey = new Map();
    for (const k of kids) {
      const kk = base(k);
      if (!byKey.has(kk)) byKey.set(kk, []);
      byKey.get(kk).push(k);
    }
    for (const [kk, group] of byKey) {
      if (group.length < 3) continue;
      const cs = group.map((g) => getComputedStyle(g));
      const dims = {
        h: [...new Set(group.map(h))].sort((a, c) => a - c),
        fs: [...new Set(cs.map((c) => c.fontSize))],
        radius: [...new Set(cs.map((c) => c.borderTopLeftRadius))],
        padX: [...new Set(cs.map((c) => `${c.paddingLeft}/${c.paddingRight}`))],
        fw: [...new Set(cs.map((c) => c.fontWeight))],
        gap: [...new Set(cs.map((c) => c.gap))],
      };
      const uneven = Object.entries(dims).filter(([k, v]) => {
        if (v.length <= 1) return false;
        return k === "h" ? Math.max(...v) - Math.min(...v) > 0.6 : true;
      });
      if (uneven.length === 0) continue;
      out.push({
        parent: label(parent),
        item: kk,
        n: group.length,
        variants: [...new Set(group.map(label))],
        detail: uneven.map(([k, v]) => `${k}=${v.join("|")}`).join("  "),
        heights: dims.h,
      });
    }
  }
  return out;
};

const VIEWS = [1440, 1024, 390];
const HASHES = ["#/backlog", "#/messages", "#/documents", "#/settings", "#/talent", "#/contacts", "#/admin/today"];
const b = await chromium.launch();

// ── 判据自证（合成页）───────────────────────────────────────────
// 一页假 DOM 钉住判据：该报的三组（字号差一档 / 圆角差一档 / 横向内距差一档）
// + 不该报的两组（只有 2 枚不够 3 / 只差 0.3px 高度的亚像素差）。
// 报不出来 = 判据坏了；全报 = 判据过松 —— 两者的「0 种」都不能当结论。
{
  const pg = await (await b.newContext()).newPage();
  await pg.setContent(`<style>
    .li{height:20px;width:60px;padding-inline:8px;border-radius:4px;font-size:13px;font-weight:400}
    .fs15{font-size:15px}.r8{border-radius:8px}.px16{padding-inline:16px}.sub{height:20.3px}
  </style>
  <div class="a"><div class="li"></div><div class="li"></div><div class="li fs15"></div></div>
  <div class="b"><div class="li"></div><div class="li"></div><div class="li r8"></div></div>
  <div class="c"><div class="li"></div><div class="li"></div><div class="li px16"></div></div>
  <div class="d"><div class="li"></div><div class="li fs15"></div></div>
  <div class="e"><div class="li"></div><div class="li sub"></div><div class="li sub"></div></div>`);
  const got = (await pg.evaluate(PROBE)).map((r) => `${r.parent}|${r.item}`);
  const want = ["div.a|div.li", "div.b|div.li", "div.c|div.li"];
  const missing = want.filter((w) => !got.includes(w));
  if (missing.length > 0) {
    throw new Error(`判据坏了：合成页该报的没报 ${JSON.stringify(missing)}，实报 ${JSON.stringify(got)}`);
  }
  const extra = got.filter((g) => !want.includes(g));
  if (extra.length > 0) {
    throw new Error(`判据过松：2 枚一组 / 只差 0.3px 高度的组被误判成档位参差 ${JSON.stringify(extra)}`);
  }
  await pg.close();
  console.log("判据自证：合成页五组只报出【字号差档 / 圆角差档 / 内距差档】三组；2 枚一组与 0.3px 亚像素差不报 ✓\n");
}

const groups = new Map();
let scenes = 0;
let lists = 0;
for (const theme of ["light", "dark"]) {
  for (const w of VIEWS) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
    const pg = await ctx.newPage();
    for (const hash of HASHES) {
      await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
      await pg.waitForTimeout(1100);
      // 文档页的树要先展开，否则重复项只露最外一层。
      for (let i = 0; i < 4; i += 1) {
        const t = pg.locator("details:not([open]) > summary").first();
        if ((await t.count()) === 0) break;
        await t.click();
        await pg.waitForTimeout(400);
      }
      scenes += 1;
      for (const r of await pg.evaluate(PROBE)) {
        const fp = `${r.parent}|${r.item}|${r.detail}`;
        if (!groups.has(fp)) groups.set(fp, { ...r, fp, n: 0, scenes: new Set() });
        const g = groups.get(fp);
        g.n += 1;
        g.scenes.add(`${theme}@${w}${hash}`);
      }
      // 分母：本轮实际比了多少个「列表」。没有分母的「0 种参差」说明不了任何事。
      lists += await pg.evaluate(() => {
        let n = 0;
        for (const parent of document.querySelectorAll("body *")) {
          const cs = getComputedStyle(parent);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const kids = [...parent.children].filter((k) => {
            const s = getComputedStyle(k);
            const r = k.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 1 && r.height > 1;
          });
          const seen = new Map();
          for (const k of kids) {
            const kk = `${k.tagName}.${k.classList[0] ?? ""}`;
            seen.set(kk, (seen.get(kk) ?? 0) + 1);
          }
          for (const c of seen.values()) if (c >= 3) n += 1;
        }
        return n;
      });
    }
    await ctx.close();
  }
}
await b.close();

const list = [...groups.values()];
console.log(
  `采样 ${scenes} 屏 · 比了「同父 ≥3 个同基准类名重复项」的列表 ${lists} 组 · ` +
    `其中档位参差：${list.length} 种\n`,
);
if (scenes < 40) throw new Error(`只采到 ${scenes} 屏，覆盖面不够，这份「0 种」不算结论`);
if (lists < 100) throw new Error(`只比了 ${lists} 组列表，分母太小，这份「${list.length} 种」不算结论`);
for (const g of list.sort((a, c) => c.n - a.n)) {
  console.log(`【${g.n} 次 · ${g.scenes.size} 场景】${g.parent} 里的 ${g.item}（${g.n} 枚）`);
  console.log(`  参差档位：${g.detail}`);
  console.log(`  变体名：${g.variants.join("  ")}`);
  console.log(`  首次：${[...g.scenes][0]}`);
}
