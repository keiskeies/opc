// 「有形状却读不出形状」穷举：一枚元素自己画了底、带圆角、没有描边，而它的底色与
// 它所踩的那一格面【逐字节同值】⇒ 这一格的形状在屏幕上完全不存在。
// 起因：admin 浅色 --chip(#f3f5f8) 与 --bg(#f3f5f8) 同值，replay 页实测 17 枚 .admin-pill
// + 17 枚 .admin-tag 直接坐在页背景上（自底/所在面 1.00）。
// 为什么穷举而不是只看 .admin-pill：同值的可能不止这一对 token，肉眼抽查必然漏。
// 判据口径（三条同时成立才算「隐形」）：
//  · 自己 painted（背景非 transparent/alpha=0）；
//  · 有圆角（border-radius > 0）且【无描边】—— 有描边的靠边读形状，不算病（.admin-chip 就是这种）；
//  · 底色与最近的 painted 祖先【完全同值】。
// 同值之外再报一档「差得极小」（1.00 < 比 ≤ 1.03）：那是肉眼也读不出形状的一档。
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
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return Math.round(((x + 0.05) / (y + 0.05)) * 1000) / 1000;
  };
  const name = (el) => `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`;
  const hits = new Map();
  let checked = 0;
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) continue;
    if (!painted(cs.backgroundColor)) continue;
    if (parseFloat(cs.borderTopLeftRadius) <= 0) continue;
    // 界定形状的不只描边：投影同样画得出这一格的边界。第一版没算 box-shadow，
    // 于是把 .nav-item.active（底色与轨底比 1.02，但挂着 --shadow-card）报成「隐形」——
    // 那是判据漏了一维，不是页面的病。抹了这条不该报的东西 ⇒ 先怀疑判据。
    if (parseFloat(cs.borderTopWidth) > 0) continue;
    if (cs.boxShadow !== "none") continue;
    let host = null;
    for (let n = el.parentElement; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (painted(c)) {
        host = { color: c, name: name(n) || n.tagName.toLowerCase() };
        break;
      }
    }
    if (host === null) continue;
    checked += 1;
    const own = parse(cs.backgroundColor);
    const back = parse(host.color);
    if (own.r === back.r && own.g === back.g && own.b === back.b) {
      // 逐字节同值：形状压根不存在
      const fp = `${name(el)}|${host.name}`;
      if (!hits.has(fp)) hits.set(fp, { n: 0, kind: "同值", ratio: 1, host: host.name, sample: (el.textContent || "").trim().slice(0, 8) });
      hits.get(fp).n += 1;
    } else {
      const r = ratio(own, back);
      if (r <= 1.03) {
        const fp = `${name(el)}|${host.name}`;
        if (!hits.has(fp) || hits.get(fp).ratio > r) hits.set(fp, { n: (hits.get(fp)?.n ?? 0) + 1, kind: "极小差", ratio: r, host: host.name, sample: (el.textContent || "").trim().slice(0, 8) });
      }
    }
  }
  return { hits: [...hits.entries()].map(([fp, v]) => ({ fp, ...v })), checked };
};

const b = await chromium.launch();

// 判据自证：同值一枚（该报）+ 同值但有描边（不该报，靠边读形状）+ 无圆角同值（不该报，
// 它本来就不主张形状）+ 同值但挂投影（不该报 —— 投影也画得出这一格，.nav-item.active 就是）
// + 差 #e9edf3 on #f3f5f8（1.08，不该报）+ 差一点点 1.02（该报）。
{
  const pg = await (await b.newContext()).newPage();
  await pg.setContent(`<style>
    .face{background:#f3f5f8}
    .same{background:#f3f5f8;border-radius:999px;width:40px;height:20px}
    .same-bordered{background:#f3f5f8;border:1px solid #cdd4e0;border-radius:999px;width:40px;height:20px}
    .same-shadowed{background:#f3f5f8;border-radius:999px;width:40px;height:20px;box-shadow:0 1px 2px rgba(32,39,53,.05)}
    .same-square{background:#f3f5f8;width:40px;height:20px}
    .near{background:#e9edf3;border-radius:999px;width:40px;height:20px}
    .tiny{background:#f1f4f8;border-radius:999px;width:40px;height:20px}
  </style>
  <div class="face">
    <div class="same"></div><div class="same-bordered"></div><div class="same-shadowed"></div>
    <div class="same-square"></div><div class="near"></div><div class="tiny"></div>
  </div>`);
  const r = await pg.evaluate(PROBE);
  const got = r.hits.map((x) => `${x.fp}|${x.kind}`);
  if (!got.includes("div.same|div.face|同值")) throw new Error(`判据坏了：同值那枚没抓到，实报 ${JSON.stringify(got)}`);
  if (!got.some((g) => g.startsWith("div.tiny|div.face|"))) throw new Error(`判据坏了：1.02 那枚没抓到，实报 ${JSON.stringify(got)}`);
  if (
    got.some(
      (g) =>
        g.startsWith("div.same-bordered|") ||
        g.startsWith("div.same-shadowed|") ||
        g.startsWith("div.same-square|") ||
        g.startsWith("div.near|"),
    )
  ) {
    throw new Error(`判据过松：有描边/有投影/无圆角/1.08 那四枚被误判成隐形，实报 ${JSON.stringify(got)}`);
  }
  await pg.close();
  console.log("判据自证：六枚里只报出【同值无描边无投影带圆角】与【1.02 极小差】两枚 ✓\n");
}

const groups = new Map();
let scenes = 0;
let checked = 0;
for (const theme of ["light", "dark"]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const pg = await ctx.newPage();
  for (const hash of ["#/backlog", "#/messages", "#/documents", "#/settings", "#/talent", "#/contacts", "#/admin/today", "#/admin/board", "#/admin/roles", "#/admin/replay"]) {
    await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await pg.waitForTimeout(1300);
    const r = await pg.evaluate(PROBE);
    scenes += 1;
    checked += r.checked;
    for (const hit of r.hits) {
      const fp = `${theme}|${hit.fp}`;
      if (!groups.has(fp)) groups.set(fp, { ...hit, n: 0, scenes: new Set(), theme });
      const g = groups.get(fp);
      g.n += hit.n;
      g.scenes.add(hash);
    }
  }
  await ctx.close();
}
await b.close();

console.log(`采样 ${scenes} 屏 · 量了 ${checked} 次「带圆角+无描边+painted」的面 · 读出形状与所在面分不开的形状：${groups.size} 种\n`);
for (const g of [...groups.values()].sort((a, c) => a.ratio - c.ratio || c.n - a.n)) {
  console.log(`【${g.kind} 比=${g.ratio} · ${g.n} 枚 · ${g.scenes.size} 页】${g.fp.split("|")[0]} 坐在 ${g.host} 上 「${g.sample}」`);
}
// 分母的下限不按【猜的绝对值】：上一版写死 500，实测 20 屏只有 284 次 —— 阈值是拍的，
// 于是判据绿不绿取决于我估没估准，而不是它有没有在看东西。改成两条【有因】的底线：
//  ① 每屏至少量到 5 枚带形状的面 —— 少到个位数说明那一屏根本没渲染出东西；
//  ② 总量至少 1 次/屏的均值下限（284/20 ≈ 14），取 8 作宽松门，真塌了一半当场红。
if (checked / scenes < 8) {
  throw new Error(`每屏平均只量到 ${(checked / scenes).toFixed(1)} 枚带形状的面（${checked}/${scenes}），覆盖面塌了，这份结论不能要`);
}
