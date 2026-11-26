// round379 空白账探针：用户主张「所有页面空白地方太多了」。这句话要能被证伪，
// 就得把每一页的【纵向空白去哪了】逐条拆开，而不是截图肉眼看。
//
// 拆法（全部用 getBoundingClientRect + getComputedStyle，不用 offsetTop）：
// 视口 100vh = topbar 64 + workspace。workspace = rail + list-pane + main-pane。
// 真正「可省的」在 main-pane 之内：
//   mainPane 高 = page padding-top + Σ(块高) + Σ(块间距) + 尾部空白 + padding-bottom
// 所以每一页打：块序列（类名/高/上边距）、块间距合计、尾部空白合计、
// 以及横向的「内容最宽块 vs page 内容宽」（1540 上限在宽屏留的左右白）。
// 列表栏同理：条目高 × 条数 vs list-pane 高 = 下面那一大片黑。
//
// 只读：只点导航与列表条目，不输入、不保存（autosave 会写进共享 dev 库）。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 1280, h: 720 },
];

// 每个路由：hash + 进入后要不要多点几下（把子页/详情页也覆盖进去）。
const ROUTES = [
  { hash: "#/messages", label: "messages-welcome", clicks: [] },
  { hash: "#/contacts", label: "contacts", clicks: ["list0"] },
  { hash: "#/documents", label: "documents-home", clicks: [] },
  { hash: "#/backlog", label: "backlog", clicks: ["list0"] },
  { hash: "#/talent", label: "talent", clicks: [] },
  { hash: "#/settings/member", label: "settings-member", clicks: [] },
  { hash: "#/settings/groups", label: "settings-groups", clicks: [] },
  { hash: "#/settings/roles", label: "settings-roles", clicks: [] },
  { hash: "#/settings/plugins", label: "settings-plugins", clicks: [] },
  { hash: "#/admin", label: "admin", clicks: [] },
];

// 页内块序列的判据尺子。字符串 IIFE：页内闭包拿不到 Node 类型（tsconfig types:["node"]）。
const PAGE_AUDIT = `(() => {
  const round = (n) => Math.round(n);
  const main = document.querySelector('.main-pane');
  const page = main ? main.querySelector('.page') : null;
  if (!main || !page) return { error: 'no .page', mainHtml: (main ? main.className : 'no main') };
  const mcs = getComputedStyle(main);
  const pcs = getComputedStyle(page);
  const mr = main.getBoundingClientRect();
  const pr = page.getBoundingClientRect();
  const kids = [...page.children].map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const cls = (el.className || '').toString().trim().split(/\\s+/).slice(0, 2).join('.');
    return {
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : ''),
      h: +r.height.toFixed(1),
      w: +r.width.toFixed(1),
      mt: cs.marginTop,
      mb: cs.marginBottom,
      hidden: cs.display === 'none' || r.height === 0,
    };
  });
  const visible = kids.filter((k) => !k.hidden);
  // 块间距：相邻可见块之间的净空（下一块顶 − 上一块底）。gap 与 margin 折叠都自动算进去。
  const gaps = [];
  for (let i = 1; i < visible.length; i++) {
    const prev = visible[i - 1];
    gaps.push({ between: prev.sel + ' -> ' + visible[i].sel, mt: visible[i].mt });
  }
  const contentBottom = visible.length ? Math.max(...visible.map((k) => k.h)) : 0;
  // 尾部空白用滚动不变的算法：page 盒底 − 最后一块底 − padding-bottom。
  const lastBottom = visible.length
    ? (() => {
        const last = page.lastElementChild;
        let cur = last;
        let bottom = 0;
        while (cur) {
          const r = cur.getBoundingClientRect();
          bottom = Math.max(bottom, r.bottom);
          cur = cur.nextElementSibling;
        }
        return bottom;
      })()
    : pr.top;
  const padTop = parseFloat(pcs.paddingTop);
  const padBottom = parseFloat(pcs.paddingBottom);
  const padL = parseFloat(pcs.paddingLeft);
  const padR = parseFloat(pcs.paddingRight);
  const pageContentW = pr.width - padL - padR;
  const widest = visible.length ? Math.max(...visible.map((k) => k.w)) : 0;
  const sumBlocks = visible.reduce((a, k) => a + k.h, 0);
  const header = page.querySelector(':scope > .page-header');
  const hcs = header ? getComputedStyle(header) : null;
  const toolbar = page.querySelector('.toolbar');
  return {
    pageClass: page.className,
    main: { h: +mr.height.toFixed(1), w: +mr.width.toFixed(1), scrollH: main.scrollHeight, clientH: main.clientHeight },
    page: { w: +pr.width.toFixed(1), h: +pr.height.toFixed(1), maxW: pcs.maxWidth },
    pad: { t: padTop, r: padR, b: padBottom, l: padL },
    gapProp: pcs.gap,
    display: pcs.display,
    headerH: header ? +header.getBoundingClientRect().height.toFixed(1) : null,
    headerMb: hcs ? hcs.marginBottom : null,
    toolbarMb: toolbar ? getComputedStyle(toolbar).marginBottom : null,
    blocks: kids,
    interGapTotal: +Math.max(0, lastBottom - pr.top - padTop - sumBlocks).toFixed(1),
    tail: +Math.max(0, mr.bottom - lastBottom).toFixed(1),
    tailInsidePage: +Math.max(0, pr.bottom - lastBottom - padBottom).toFixed(1),
    widestBlock: widest,
    pageContentW: +pageContentW.toFixed(1),
    hSlack: +(pageContentW - widest).toFixed(1),
    sumBlocks: +sumBlocks.toFixed(1),
    fillPct: +((100 * sumBlocks) / mr.height).toFixed(1),
  };
})();`;

const LIST_AUDIT = `(() => {
  const list = document.querySelector('.list-pane');
  if (!list) return { error: 'no list-pane' };
  const r = list.getBoundingClientRect();
  const body = document.querySelector('#listContent') || list;
  const kids = [...body.children].filter((el) => el.getBoundingClientRect().height > 0);
  const hs = kids.map((el) => {
    const er = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { sel: el.tagName.toLowerCase() + '.' + (el.className || '').toString().trim().split(/\\s+/)[0], h: +er.height.toFixed(1), mb: cs.marginBottom, mt: cs.marginTop };
  });
  const sum = hs.reduce((a, k) => a + k.h, 0);
  const cs = getComputedStyle(body);
  const lastBottom = kids.length ? Math.max(...kids.map((el) => el.getBoundingClientRect().bottom)) : r.top;
  return {
    list: { h: +r.height.toFixed(1), w: +r.width.toFixed(1) },
    bodyClass: body.className,
    bodyPad: cs.padding,
    bodyGap: cs.gap,
    count: hs.length,
    firstThree: hs.slice(0, 3),
    sumItems: +sum.toFixed(1),
    dead: +Math.max(0, r.bottom - lastBottom).toFixed(1),
    fillPct: +((100 * sum) / r.height).toFixed(1),
    scrollable: body.scrollHeight > body.clientHeight + 1,
  };
})();`;

const CHROME_AUDIT = `(() => {
  const g = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { h: +r.height.toFixed(1), w: +r.width.toFixed(1), pad: cs.padding, hgt: cs.height };
  };
  return {
    topbar: g('.topbar'),
    rail: g('.rail'),
    list: g('.list-pane'),
    main: g('.main-pane'),
    workspace: g('.workspace'),
    navCollapsed: !!document.querySelector('.workspace.nav-collapsed'),
  };
})();`;

function print(label, page) {
  const L = [];
  L.push(`\n### ${label}`);
  if (page.error) {
    L.push(`  !! ${page.error} ${page.mainHtml || ''}`);
    return L.join('\n');
  }
  L.push(
    `  main ${page.main.w}x${page.main.h} scrollH=${page.main.scrollH} | page w=${page.page.w} maxW=${page.page.maxW} h=${page.page.h} | pad t${page.pad.t} l${page.pad.l} b${page.pad.b} | gap=${page.gapProp} display=${page.display}`,
  );
  L.push(
    `  块合计=${page.sumBlocks} 占 main 高 ${page.fillPct}% | 块间距合计=${page.interGapTotal} | 尾部(main底-末块底)=${page.tail} 其中 padding-bottom 外=${page.tailInsidePage}`,
  );
  L.push(
    `  header h=${page.headerH} mb=${page.headerMb} | toolbar mb=${page.toolbarMb} | 横向：最宽块 ${page.widestBlock} / 内容宽 ${page.pageContentW} ⇒ 横向留白 ${page.hSlack}`,
  );
  for (const b of page.blocks) {
    L.push(`    - ${b.hidden ? '[hidden] ' : ''}${b.sel}  h=${b.h} w=${b.w} mt=${b.mt} mb=${b.mb}`);
  }
  return L.join('\n');
}

const out = [];
const b = await chromium.launch();

for (const theme of ["dark", "light"]) {
  for (const vp of VIEWPORTS) {
    const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
    await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => out.push(`  [pageerror] ${String(e).slice(0, 160)}`));
    for (const route of ROUTES) {
      await p.goto(`${BASE}/${route.hash}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(1400);
      const head = `${theme} ${vp.w}x${vp.h} ${route.label}`;
      const chrome = await p.evaluate(CHROME_AUDIT);
      const page = await p.evaluate(PAGE_AUDIT);
      const list = await p.evaluate(LIST_AUDIT);
      out.push(`\n@@ ${head}`);
      out.push(
        `  chrome: topbar h=${chrome.topbar && chrome.topbar.h} rail w=${chrome.rail && chrome.rail.w} list w=${chrome.list && chrome.list.w} main w=${chrome.main && chrome.main.w} collapsed=${chrome.navCollapsed}`,
      );
      out.push(print("page", page));
      if (list.error) out.push(`  list: !! ${list.error}`);
      else
        out.push(
          `  list: w=${list.list.w} h=${list.list.h} pad=${list.bodyPad} gap=${list.bodyGap} 条目=${list.count} 条目高=${list.firstThree.map((x) => x.h).join('/')} 合计=${list.sumItems} 死区=${list.dead} 填=${list.fillPct}% 可滚=${list.scrollable}`,
        );
      // 列表详情：点第一条进详情，再量一次（backlog 详情、通讯录成员、文档编辑器）
      if (route.clicks.includes("list0")) {
        const item = p.locator("#listContent > *").first();
        if ((await item.count()) > 0) {
          await item.click();
          await p.waitForTimeout(1300);
          const page2 = await p.evaluate(PAGE_AUDIT);
          out.push(print("page(after list0 click)", page2));
        }
      }
    }
    await ctx.close();
  }
}

await b.close();
const text = out.join('\n');
process.stdout.write(text + '\n');
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/scratch/round379-whitespace-raw.txt", text, "utf8");
const fffd = (text.match(new RegExp(String.fromCharCode(0xfffd), "g")) || []).length;
process.stdout.write(`\nFFFD_COUNT ${fffd}\n`);
