// 同排同高穷举：把每一行里的控件分组，报出高度不齐的那几组。
// 为什么不能用肉眼抽查：并排的两颗按钮，一颗 34 一颗 29，抽查十次可能次次挑到同档的。
//
// ⚠ 判据第一版是坏的，坏法值得记下来：它按「控件的 top 相同」分组，而 align-items:center
// 的一行里【高度不同 ⇒ top 必然不同】—— 于是「高度不齐」这一发被自己的分组条件排除在外，
// 全仓报 0 条。这正是「抹了读数不变 ⇒ 先怀疑判据」那一发。现在的分组用【垂直区间重叠】：
// 两枚控件的垂直区间互相咬合过半，就算同一排（居中排列时不同高度照样咬合，回绕时两行不咬合）。
//
// 判据口径（与既有纪律一致）：
//  · 「行」= computed display 是 flex(row) 或只有一行轨道的 grid；
//  · 只比【控件】：button / input / select / textarea / a / .btn / .pill；
//  · 比 getBoundingClientRect().height（含 border），同排差 > 0.5px 算不齐；
//  · opacity:0 的（hover 才出现的工具条）照样参与 —— 它占着那一排的位置，收起来时
//    仍然要跟邻居等高；这类组单独标「含 hover 态」。
import { chromium } from "playwright";

const PROBE = () => {
  const h = (el) => Math.round(el.getBoundingClientRect().height * 100) / 100;
  const label = (el) => {
    const cls = [...el.classList].join(".");
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`;
  };
  const CONTROL = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/u;
  /**
   * 「控件」= 有【脸】的那一枚：描边或非透明底，或者显式挂着 .btn/.pill。
   * 为什么要这一条：a.brand 没有底也没有边（它是一条带图标的导航链接，39 高来自文字行盒），
   * .conversation-item 常态背景 transparent（它是【整行当一个按钮】的容器，58.33 来自两行文字）。
   * 把它们算进控件，就会报出「brand 39 vs 按钮 34」「整行 58.33 vs 行内置顶键 28」这种
   * 类名对错的两类 —— 判据抓的不是「并排的两颗按钮不一样高」那个症状。
   * 真正要比的是【同一层里各有一张脸】的那几枚。
   */
  const hasFace = (el) => {
    const cs = getComputedStyle(el);
    const painted = cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
    const bordered = parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderBottomWidth) > 0;
    return painted || bordered;
  };
  const isControl = (el) =>
    (CONTROL.test(el.tagName) || el.classList.contains("btn") || el.classList.contains("pill")) && hasFace(el);
  const laidOut = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const rowLike = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === "flex" || cs.display === "inline-flex") {
      return cs.flexDirection === "row" || cs.flexDirection === "row-reverse";
    }
    if (cs.display === "grid") {
      return cs.gridTemplateRows.split(" ").filter((s) => s.length > 0 && s !== "none").length <= 1;
    }
    return false;
  };
  /** 垂直区间咬合过半 ⇒ 同一排。 */
  const sameLine = (a, b) => {
    const x = a.getBoundingClientRect();
    const y = b.getBoundingClientRect();
    const ov = Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top);
    return ov > 0.5 * Math.min(x.height, y.height);
  };
  const out = [];
  let scanned = 0;
  for (const parent of document.querySelectorAll("body *")) {
    if (!laidOut(parent) || !rowLike(parent)) continue;
    const kids = [...parent.children].filter((k) => laidOut(k) && isControl(k));
    if (kids.length < 2) continue;
    scanned += 1;
    // 按咬合关系聚类成「排」（回绕的容器会得到多排）。
    const lines = [];
    for (const k of kids) {
      const line = lines.find((ls) => sameLine(ls[0], k));
      if (line) line.push(k);
      else lines.push([k]);
    }
    for (const line of lines) {
      if (line.length < 2) continue;
      const hs = line.map(h);
      const spread = Math.round((Math.max(...hs) - Math.min(...hs)) * 100) / 100;
      if (spread <= 0.5) continue;
      out.push({
        parent: label(parent),
        parentW: Math.round(parent.getBoundingClientRect().width),
        align: getComputedStyle(parent).alignItems,
        wrap: getComputedStyle(parent).flexWrap,
        hiddenState: line.some((k) => Number(getComputedStyle(k).opacity) === 0),
        row: line.map((k) => ({
          el: label(k),
          h: h(k),
          txt: (k.textContent || k.getAttribute("aria-label") || "").trim().slice(0, 10),
        })),
        spread,
      });
    }
  }
  return { rows: out, scanned };
};

const VIEWS = [1440, 1180, 1024, 860, 390];
const VIEWS_HASH = ["#/backlog", "#/messages", "#/documents", "#/settings", "#/talent", "#/contacts", "#/admin/today"];

const b = await chromium.launch();

// ── 判据自证（合成页）───────────────────────────────────────────
// 上一版按 top 分组，居中排列下「高度不齐 ⇒ top 必不同 ⇒ 永远不同排」，全仓报 0。
// 这一发用一页假 DOM 钉住修好的分组：等高一对（不该报）+ 29/34 一对（该报）+
// 回绕成两行的 29/34 各一行（不该报 —— 不同排不该互相比较）。
{
  const pg = await (await b.newContext()).newPage();
  await pg.setContent(`<style>
    .row{display:flex;align-items:center;gap:4px}
    .wrap{display:flex;align-items:center;flex-wrap:wrap;width:120px}
    button{border:0;background:#dddddd}
    .h34{height:34px;width:50px}.h29{height:29px;width:50px}
    .bare{background:transparent}
  </style>
  <div class="row"><button class="h34"></button><button class="h34"></button></div>
  <div class="row"><button class="h34"></button><button class="h29"></button></div>
  <div class="wrap"><button class="h34"></button><button class="h34"></button><button class="h29"></button><button class="h29"></button></div>
  <div class="row"><button class="h34 bare"></button><button class="h29"></button></div>`);
  const { rows } = await pg.evaluate(PROBE);
  const got = rows.map((r) => `${r.parent}|${r.row.map((x) => x.h).sort((a, c) => a - c).join(",")}`);
  const want = "div.row|29,34";
  if (!got.includes(want)) throw new Error(`判据坏了：合成页里 29/34 并排那组没抓到，实报 ${JSON.stringify(got)}`);
  if (got.length !== 1) throw new Error(`判据过松：应只报居中混高那一组，实报 ${JSON.stringify(got)}（等高组/回绕两行/无脸的那组被误判成同排）`);
  console.log(`判据自证：合成页四组（等高 / 居中混高 / 回绕两行 / 一枚无脸）里只报出【${want}】 ✓\n`);
}

const groups = new Map();
function add(scene, rows) {
  for (const r of rows) {
    // 形状指纹：父类名 + 本排各控件高度的多重集（与文案无关，同一形状只报一次）。
    const fp = `${r.parent}|${r.row.map((x) => x.h).sort((a, c) => a - c).join(",")}`;
    if (!groups.has(fp)) groups.set(fp, { fp, scene, sample: r, scenes: new Set(), n: 0 });
    const g = groups.get(fp);
    g.scenes.add(scene);
    g.n += 1;
  }
}

let sampled = 0;
let scanned = 0;
for (const theme of ["light", "dark"]) {
  for (const w of VIEWS) {
    const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
    await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
    const pg = await ctx.newPage();
    for (const hash of VIEWS_HASH) {
      await pg.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
      await pg.waitForTimeout(1000);
      const probe = await pg.evaluate(PROBE);
      sampled += 1;
      scanned += probe.scanned;
      // 正向对照（真页面版）：拿真 DOM 里那一排本来等高的两颗脸（.connection 与主题键，
      // 都 34），把其中一颗临时压到 29 —— 判据【必须】当场报出 topbar 那一排。
      // 它抓的就是本轮症状本身；报不出来说明「有脸」或「咬合分组」其中一条判据坏了。
      if (hash === "#/backlog") {
        // 正向对照（真页面版）：抓屏上【确实并排的两颗 .btn】（.actions 里那一对，各 34.14），
        // 把右边那颗压矮，判据必须当场报出这一排。这抓的正是本轮症状本身
        // （「同行同高」被破坏），报不出来 = 「有脸」或「咬合分组」其中一条判据坏了。
        // ⚠ 只写 height 是无效变异：.btn 上有 min-height:var(--control-h) 和 padding 6/6 压着它。
        // 第一版对照就败在这里 —— 报「判据坏了」而实际是【对照没生效】。所以先把盒子真的
        // 压下去并读回来验一遍，再拿它去问判据。
        await pg.addStyleTag({
          content: ".actions > .btn.primary { height:20px !important; min-height:0 !important; padding-block:0 !important; }",
        });
        await pg.waitForTimeout(200);
        const after = await pg.evaluate(() => {
          const el = document.querySelector(".actions > .btn.primary");
          return el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : null;
        });
        if (after === null || after > 30) {
          throw new Error(`对照没生效：那颗 .btn.primary 压完读 ${after}px（min-height/padding 没抹掉），不能用它来考判据`);
        }
        const ctl = (await pg.evaluate(PROBE)).rows
          .filter((r) => r.parent.includes("actions"))
          .map((r) => r.row.map((x) => x.h).join(","));
        if (!ctl.some((h) => h.includes(String(after)))) {
          throw new Error(`判据坏了：那颗 .btn.primary 实测已是 ${after}px，.actions 那一排却没报，实报 ${JSON.stringify(ctl)}`);
        }
        await pg.evaluate(() => {
          [...document.querySelectorAll("style")].find((s) => s.textContent.includes(".btn.primary"))?.remove();
        });
        await pg.waitForTimeout(200);
      }
      add(`${theme}@${w}${hash}`, probe.rows);
    }
    await ctx.close();
  }
}

// 群聊那一屏要真点进去才有消息工具条/任务流。
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const pg = await ctx.newPage();
  await pg.goto("http://127.0.0.1:9797/group.html#/messages", { waitUntil: "domcontentloaded" });
  await pg.waitForTimeout(1500);
  const n = await pg.locator(".conversation-item").count();
  for (let i = 0; i < Math.min(n, 3); i += 1) {
    await pg.locator(".conversation-item").nth(i).click();
    await pg.waitForTimeout(1200);
    for (const tab of ["消息", "任务流", "文档区"]) {
      const t = pg.locator(".group-chat-tab", { hasText: tab }).first();
      if ((await t.count()) > 0) {
        await t.click();
        await pg.waitForTimeout(700);
      }
    }
    const chat = await pg.evaluate(PROBE);
    add("chat@1440", chat.rows);
    scanned += chat.scanned;
    sampled += 1;
  }
  await ctx.close();
}
await b.close();

const list = [...groups.values()].sort((a, c) => c.sample.spread - a.sample.spread);
console.log(
  `采样 ${sampled} 屏 · 扫到【同一层 ≥2 枚有脸控件】的排 ${scanned} 组 · ` +
    `其中高度不齐：${list.length} 种形状 · 合计 ${list.reduce((s, g) => s + g.n, 0)} 处出现\n`,
);
if (scanned === 0) throw new Error("扫到 0 组 ⇒ 「有脸」那条收得太紧，不能拿「0 种不齐」当结论");
for (const g of list) {
  const s = g.sample;
  console.log(
    `【Δ${s.spread}px · ${g.n} 处 · ${g.scenes.size} 个场景 · align=${s.align} wrap=${s.wrap}${s.hiddenState ? " · 含 hover 态" : ""}】${s.parent}`,
  );
  console.log(`  控件：${s.row.map((x) => `${x.el} h=${x.h}${x.txt ? ` 「${x.txt}」` : ""}`).join("  ·  ")}`);
  console.log(`  首次出现在：${g.scene}`);
}
