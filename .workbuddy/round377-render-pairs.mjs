// 渲染态「前景 × 所在底」全量枚举（admin 七页 × 明暗）。
// 为什么不只信 color-scale.test.ts 的 PAIRS：那张表是【人写】的落点清单，
// 它声称按实测落点写，但没人核对过「屏幕上真实出现的组合」是否都在表里。
// 本轮就撞上一发：admin-light 的 amber 那行只列了 card/bg，可实测
// .admin-pill.admin-s-amber 的 --amber 就压在 --chip 上（4.55，刚好在线）——
// 表里少一格，守卫就不会有人去量那一格。
// 判据口径：
//  · 前景 = 元素自己的 color（文字）；底 = 祖先链上第一个 painted 的背景色；
//  · 只比【有可见文字】的元素（无文字的容器不参与：那一格上没有可读性这件事）；
//  · 阈值取 4.5（正文），但只报【低于 4.5】的，并给出实测值 —— 11 号小字与图标另说。
// 不做的事：不在这里判装饰色/填充色（那是 EXEMPT 名单的活），只判文字。
import { chromium } from "playwright";

const PROBE = () => {
  const parse = (c) => {
    const m = c.match(/[\d.]+/gu);
    if (!m) return null;
    return { r: Number(m[0]), g: Number(m[1]), b: Number(m[2]), a: m[3] === undefined ? 1 : Number(m[3]) };
  };
  const painted = (c) => {
    const p = parse(c);
    return p !== null && p.a > 0.02;
  };
  const lum = (p) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(p.r) + 0.7152 * f(p.g) + 0.0722 * f(p.b);
  };
  const cr = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100;
  };
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
  /**
   * 渐变底：background-color 是 transparent，走祖先会量到身后的卡片。
   * .avatar 就是这一形（白字压在 linear-gradient 上，第一版报成 1.00 的假红）。
   * 判法取【两端点里最不利的那一端】—— 渐变上任何一点都可能压住这枚字，
   * 取最不利是保守口径，不会把真的不合格说成合格。
   */
  const gradEndpoints = (img) => {
    if (!/gradient/u.test(img)) return [];
    const out = [];
    for (const m of img.matchAll(/rgba?\([\d.,\s]+\)/gu)) {
      const p = parse(m[0]);
      if (p !== null && p.a > 0.02) out.push(p);
    }
    return out;
  };
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    // 只量【自己直接持有文字】的那一枚：子元素会自己再算一次，父层重复量会把同一处数两遍。
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? "").trim().length > 0);
    if (!own) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    // 底 = 【自己这一枚的 painted 背景】，透明才往祖先走。少了「先看自己」这一格，
    // .btn.primary（白字压在自己的 primary 底上）会被拿去跟身后的 card 比，
    // 得到 1.00 的假红 —— 第一版判据报的 8 条全是这一形。
    const fg = parse(cs.color);
    if (fg === null || fg.a <= 0.02) continue;
    let host = null;
    for (let n = el; n; n = n.parentElement) {
      const csN = getComputedStyle(n);
      const c = csN.backgroundColor;
      if (painted(c)) {
        host = { color: parse(c), name: name(n) || n.tagName.toLowerCase() };
        break;
      }
      const ends = gradEndpoints(csN.backgroundImage);
      if (ends.length > 0) {
        let worst = ends[0];
        for (const e of ends) if (cr(fg, e) < cr(fg, worst)) worst = e;
        host = { color: worst, name: `${name(n) || n.tagName.toLowerCase()}(grad)` };
        break;
      }
    }
    if (host === null) continue;
    out.push({
      el: name(el),
      host: host.name,
      fg: cs.color,
      bg: `rgb(${host.color.r}, ${host.color.g}, ${host.color.b})`,
      ratio: cr(fg, host.color),
      fs: cs.fontSize,
      txt: (el.textContent ?? "").trim().slice(0, 10),
    });
  }
  return out;
};

const b = await chromium.launch();
const seen = new Map();
let n = 0;
for (const theme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const pg = await ctx.newPage();
  // 页名取自 app.js:80-88 的 ROUTES（唯一权威表），不是按标签猜的 id。
  for (const hash of ["#/admin/today", "#/admin/board", "#/admin/inbox", "#/admin/org", "#/admin/charter", "#/admin/budget", "#/admin/replay"]) {
    await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1300);
    // 页名猜错时 hash 会落到默认页，七次其实量的是同一页 —— 先确认这一屏真的渲染了
    // admin-root，否则分母是假的（「量到 N 种组合」里全是重复页）。
    if ((await pg.locator(".admin-root").count()) === 0) {
      throw new Error(`${hash} 没渲染出 .admin-root ⇒ 页名不对，这一屏没量到东西`);
    }
    const rows = await pg.evaluate(PROBE);
    n += rows.length;
    for (const r of rows) {
      const fp = `${theme}|${r.el}|${r.fg}|${r.bg}`;
      if (!seen.has(fp)) seen.set(fp, { ...r, theme, n: 0, pages: new Set() });
      const g = seen.get(fp);
      g.n += 1;
      g.pages.add(hash);
    }
  }
  await ctx.close();
}
await b.close();

const all = [...seen.values()];
const under = all.filter((g) => g.ratio < 4.5).sort((a, c) => a.ratio - c.ratio);
console.log(`量到 ${n} 个「自己持文字 × painted 底」的组合 · 去重后 ${all.length} 种 · 其中 < 4.5：${under.length} 种\n`);
for (const g of under.slice(0, 45)) {
  console.log(`【${g.ratio} · ${g.theme} · ${g.n} 处/${g.pages.size} 页】${g.el} 「${g.txt}」 ${g.fg} on ${g.bg} fs=${g.fs}`);
}

/**
 * 自检：判据必须【抓得到】已知的坏组合。上一轮把 8 条假红报成缺陷，靠的是它确实会红；
 * 但如果哪天它因为选择器/遍历改动恒绿，「0 种」就成了「什么都没量」的同义词。
 * 这里造一枚 白字压白底（必须被抓）+ 一枚 黑字压白底（必须不被抓）。
 */
{
  const ctx = await (await chromium.launch()).newContext();
  const pg = await ctx.newPage();
  await pg.goto("about:blank");
  await pg.evaluate(() => {
    document.body.replaceChildren();
    const host = document.createElement("div");
    host.style.backgroundColor = "rgb(255, 255, 255)";
    host.style.width = "200px";
    host.style.height = "40px";
    const mk = (id, color, text) => {
      const s = document.createElement("span");
      s.className = id;
      s.style.color = color;
      s.textContent = text;
      host.append(s);
    };
    mk("bad", "rgb(255, 255, 255)", "坏");
    mk("good", "rgb(0, 0, 0)", "好");
    document.body.append(host);
  });
  const fixture = await pg.evaluate(PROBE);
  const bad = fixture.find((r) => r.el === "span.bad");
  const good = fixture.find((r) => r.el === "span.good");
  if (bad === undefined || bad.ratio >= 4.5) {
    throw new Error("自检失败：白字压白底没被抓到 ⇒ 判据坏了，上面的「0 种」不算证据");
  }
  if (good === undefined || good.ratio < 4.5) {
    throw new Error("自检失败：黑字压白底被判不合格 ⇒ 判据口径错");
  }
  console.log(`\n自检：白字压白底抓到（${bad.ratio}）✓ · 黑字压白底放过（${good.ratio}）✓`);
  await ctx.close();
}

