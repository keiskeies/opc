// round379 空白账第三发：顶部那条 184.9px 里，page-header 独占 76.9 + 20。
// 76.9 = 34 + 8 + 34 ⇒ 高度不是标题撑的（标题列只到 139.7），是【右侧按钮换行成两排】撑的。
// 这一发把每一列头部右侧的按钮逐枚量出来，按 offsetTop 分行，判：
//   ① 到底有几排？② 第二排是谁、为什么挤不进去？③ 标题列与按钮列谁先到底？
// 顺带：topbar 64 里最高的子元素只有 43（profile-wrap），看那 21px 是不是纯余量。
// 只读，不点保存、不输入。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const HEADER = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const page = document.querySelector('.main-pane .page');
  const header = page ? page.querySelector(':scope > .page-header') : null;
  if (!header) return { error: 'no page-header', pageClass: page ? page.className : 'no .page' };
  const hr = header.getBoundingClientRect();
  const cols = [...header.children].map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const rows = new Map();
    for (const b of el.children) {
      const br = b.getBoundingClientRect();
      if (br.height === 0) continue;
      const key = Math.round(br.top);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push({
        t: (b.textContent || '').trim().slice(0, 10) || b.tagName.toLowerCase(),
        w: round1(br.width),
        h: round1(br.height),
        cls: (b.className || '').toString().trim().split(/\\s+/)[0],
      });
    }
    return {
      col: (el.className || el.tagName).toString().split(/\\s+/)[0],
      h: round1(r.height),
      w: round1(r.width),
      right: round1(hr.right - r.right),
      wrap: cs.flexWrap,
      dir: cs.flexDirection,
      gap: cs.gap,
      rows: [...rows.entries()].sort((a, z) => a[0] - z[0]).map(([top, bs], i) => ({ row: i + 1, n: bs.length, buttons: bs })),
    };
  });
  const titleCol = header.children[0];
  let titleBottom = null;
  if (titleCol) {
    let cur = titleCol.firstElementChild;
    while (cur) {
      const r = cur.getBoundingClientRect();
      titleBottom = Math.max(titleBottom === null ? r.bottom : titleBottom, r.bottom);
      cur = cur.nextElementSibling;
    }
  }
  return { headerH: round1(hr.height), headerTop: round1(hr.top), mb: getComputedStyle(header).marginBottom, titleBottomRel: titleBottom === null ? null : round1(titleBottom - hr.top), slackBelowTitle: titleBottom === null ? null : round1(hr.bottom - titleBottom), cols };
})();`;

const TOPBAR = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const bar = document.querySelector('.topbar');
  if (!bar) return { error: 'no topbar' };
  const br = bar.getBoundingClientRect();
  const cs = getComputedStyle(bar);
  const kids = [...bar.children].filter((el) => el.getBoundingClientRect().height > 0).map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: (el.className || el.tagName).toString().split(/\\s+/)[0], h: round1(r.height), top: round1(r.top - br.top), bottom: round1(br.bottom - r.bottom) };
  });
  const tallest = Math.max(...kids.map((k) => Math.max(k.top, k.bottom)));
  return { h: round1(br.height), align: cs.alignItems, pad: cs.padding, kids, tallestExtent: round1(tallest), spare: round1(br.height - tallest) };
})();`;

const LISTDEAD = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const list = document.querySelector('.list-pane');
  const body = document.querySelector('#listContent');
  if (!list || !body) return { error: 'no list' };
  const lr = list.getBoundingClientRect();
  const head = list.querySelector(':scope > :not(#listContent)');
  const kids = [...body.children].filter((el) => el.getBoundingClientRect().height > 0);
  const lastBottom = kids.length ? Math.max(...kids.map((el) => el.getBoundingClientRect().bottom)) : (head ? head.getBoundingClientRect().bottom : lr.top);
  const rows = kids.slice(0, 3).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { cls: (el.className || '').toString().split(/\\s+/)[0], h: round1(r.height), pad: cs.padding };
  });
  return {
    listH: round1(lr.height),
    headH: head ? round1(head.getBoundingClientRect().height) : 0,
    headCls: head ? (head.className || head.tagName).toString().split(/\\s+/)[0] : null,
    count: kids.length,
    rows,
    deadBelow: round1(lr.bottom - lastBottom),
    deadPct: Math.round((100 * (lr.bottom - lastBottom)) / lr.height),
  };
})();`;

const out = [];
const b = await chromium.launch();

for (const vp of [
  { w: 1440, h: 900 },
  { w: 1280, h: 720 },
]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
  const p = await ctx.newPage();
  p.on("pageerror", (e) => out.push(`  [pageerror] ${String(e).slice(0, 160)}`));
  const NAV = ["#/messages", "#/contacts", "#/documents", "#/backlog", "#/talent", "#/settings/member", "#/settings/groups", "#/settings/roles", "#/settings/plugins"];
  for (const hash of NAV) {
    await p.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1400);
    out.push(`\n@@@@ ${vp.w}x${vp.h} ${hash}`);
    const tb = await p.evaluate(TOPBAR);
    out.push(`  topbar h=${tb.h} align=${tb.align} pad=${tb.pad} 最高子元素占=${tb.tallestExtent} 纯余量=${tb.spare}  ${tb.kids.map((k) => `${k.cls} h${k.h}@${k.top}`).join(' ')}`);
    const hd = await p.evaluate(HEADER);
    if (hd.error) out.push(`  header: !! ${hd.error} ${hd.pageClass || ''}`);
    else {
      out.push(`  header h=${hd.headerH} mb=${hd.mb} 标题列底=${hd.titleBottomRel} 标题下方空=${hd.slackBelowTitle}`);
      for (const c of hd.cols) {
        out.push(`    列 .${c.col} h=${c.h} w=${c.w} wrap=${c.wrap} gap=${c.gap} 距右${c.right}`);
        for (const r of c.rows) out.push(`      第${r.row}排 n=${r.n}: ${r.buttons.map((x) => `${x.t}(${x.cls} ${x.w}x${x.h})`).join(' ')}`);
      }
    }
    const ld = await p.evaluate(LISTDEAD);
    if (ld.error) out.push(`  list: !! ${ld.error}`);
    else
      out.push(
        `  list h=${ld.listH} 头部 .${ld.headCls}=${ld.headH} 条目=${ld.count} ${ld.rows.map((r) => `.${r.cls}=${r.h}/pad ${r.pad}`).join(' ')} ⇒ 底部死区=${ld.deadBelow}(${ld.deadPct}%)`,
      );
  }
  await ctx.close();
}

await b.close();
const text = out.join('\n');
process.stdout.write(text + '\n');
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/scratch/round379-header-raw.txt", text, "utf8");
const fffd = (text.match(new RegExp(String.fromCharCode(0xfffd), "g")) || []).length;
process.stdout.write(`\nFFFD_COUNT ${fffd}\n`);
