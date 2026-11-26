// round379 空白账第二发：把「内容还没开始就花掉的像素」和「块内部吞掉的像素」拆开。
// 第一发量到的是尾部空白（300~700px），但尾部是「内容本来就少」的果，不是可以调的因。
// 真正可调的三处：
//   A 顶部带：topbar 高 + page padding-top + page-header 高 + 其 margin-bottom ⇒ 首屏内容起点
//   B 块内部：card/panel 的 padding、grid gap、min-height 地板（.state=210 就是枚地板）
//   C 列表栏：条目自己的 padding（通讯录 125 vs 人才 66）+ 下面那片死区
// 只读，不输入不保存。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const TOPBAND = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const rows = [];
  const topbar = document.querySelector('.topbar');
  const main = document.querySelector('.main-pane');
  const page = main ? main.querySelector('.page') : null;
  const push = (label, el, extra) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    rows.push(Object.assign({ label, h: round1(r.height), top: round1(r.top), pad: cs.padding, mb: cs.marginBottom, mt: cs.marginTop, minH: cs.minHeight, fs: cs.fontSize, lh: cs.lineHeight }, extra || {}));
  };
  push('topbar', topbar);
  if (topbar) {
    for (const child of topbar.children) {
      const r = child.getBoundingClientRect();
      if (r.height > 0) push('  topbar>' + (child.className || child.tagName).toString().split(/\\s+/)[0], child);
    }
  }
  push('page', page);
  const header = page ? page.querySelector(':scope > .page-header') : null;
  push('page-header', header);
  if (header) {
    push('  h2', header.querySelector('h2'));
    push('  p', header.querySelector('p'));
    for (const b of header.querySelectorAll(':scope > .page-actions, :scope > div, :scope > .btn')) {
      push('  actions', b);
      break;
    }
  }
  const first = page ? [...page.children].find((el) => !el.matches('.page-header') && el.getBoundingClientRect().height > 0) : null;
  if (first) push('first-block:' + first.className.toString().split(/\\s+/)[0], first);
  return { rows, contentTop: first ? round1(first.getBoundingClientRect().top) : null, vh: window.innerHeight };
})();`;

// 页内「吞像素」清单：谁的 padding+gap+min-height 吃得多，以及它的地板有没有真内容撑着。
const INGEST = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const page = document.querySelector('.main-pane .page') || document.querySelector('.main-pane');
  if (!page) return { error: 'no page' };
  const out = [];
  const walk = (el, depth) => {
    if (depth > 4) return;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (r.height < 24) return;
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gapV = cs.display.includes('flex') && cs.flexDirection === 'column' ? parseFloat(cs.rowGap || 0) : parseFloat(cs.rowGap || 0);
    const kids = [...el.children].filter((c) => c.getBoundingClientRect().height > 0);
    const sumKid = kids.reduce((a, c) => a + c.getBoundingClientRect().height, 0);
    const consumed = padV + (kids.length > 1 ? gapV * (kids.length - 1) : 0);
    if ((padV >= 16 || consumed >= 24 || parseFloat(cs.minHeight) >= 80) && r.height >= 40) {
      out.push({
        depth,
        sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + (el.className || '').toString().trim().split(/\\s+/).slice(0, 2).join('.'),
        h: round1(r.height),
        w: round1(r.width),
        padV: round1(padV),
        padH: round1(padH),
        rowGap: cs.rowGap,
        colGap: cs.columnGap,
        minH: cs.minHeight,
        consumed: round1(consumed),
        pctOfOwnHeight: Math.round((100 * consumed) / r.height),
        kids: kids.length,
        sumKid: round1(sumKid),
      });
    }
    for (const kid of kids) walk(kid, depth + 1);
  };
  walk(page, 0);
  return { rows: out.slice(0, 26) };
})();`;

const LISTITEM = `(() => {
  const body = document.querySelector('#listContent');
  if (!body) return { error: 'no #listContent' };
  const round1 = (n) => Math.round(n * 10) / 10;
  const items = [...body.children].filter((el) => el.getBoundingClientRect().height > 0).slice(0, 2);
  return items.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const inner = [...el.children].map((c) => {
      const cr = c.getBoundingClientRect();
      const ccs = getComputedStyle(c);
      return (c.className || c.tagName).toString().split(/\\s+/)[0] + ' h=' + round1(cr.height) + ' pad=' + ccs.padding + ' mb=' + ccs.marginBottom;
    });
    return { sel: (el.className || el.tagName).toString().split(/\\s+/)[0], h: round1(r.height), pad: cs.padding, gap: cs.gap, mb: cs.marginBottom, inner };
  });
})();`;

function printTopband(title, tb) {
  const L = [`\n### ${title}  内容起点 y=${tb.contentTop} / vh=${tb.vh}`];
  for (const r of tb.rows) L.push(`  ${r.label}  h=${r.h} top=${r.top} pad=${r.pad} mt=${r.mt} mb=${r.mb} minH=${r.minH} fs=${r.fs} lh=${r.lh}`);
  return L.join('\n');
}

const out = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
p.on("pageerror", (e) => out.push(`  [pageerror] ${String(e).slice(0, 160)}`));

const NAV = ["#/messages", "#/contacts", "#/documents", "#/backlog", "#/talent", "#/settings/member", "#/settings/groups", "#/settings/roles", "#/settings/plugins", "#/admin"];
for (const hash of NAV) {
  await p.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1400);
  out.push(`\n@@@@ ${hash}`);
  const tb = await p.evaluate(TOPBAND);
  out.push(printTopband(hash, tb));
  const ing = await p.evaluate(INGEST);
  if (ing.error) out.push(`  ingest: !! ${ing.error}`);
  else {
    for (const r of ing.rows)
      out.push(`  [吞] ${'  '.repeat(r.depth)}${r.sel} h=${r.h} w=${r.w} padV=${r.padV} padH=${r.padH} gap=${r.rowGap}/${r.colGap} minH=${r.minH} 吃掉=${r.consumed}(${r.pctOfOwnHeight}%) kids=${r.kids} Σ子=${r.sumKid}`);
  }
  const li = await p.evaluate(LISTITEM);
  if (!Array.isArray(li)) out.push(`  item: !! ${li.error}`);
  else for (const it of li) out.push(`  item .${it.sel} h=${it.h} pad=${it.pad} gap=${it.gap} mb=${it.mb} ⇒ ${it.inner.join(' | ')}`);
}

// 会话视图（欢迎页不是消息页的主形态）：点进第一个群聊
await p.goto(`${BASE}/#/messages`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(1400);
const clicks = [
  { sel: "#listContent .list-item", label: "会话/聊天" },
  { sel: "#listContent .doc-list-item", label: "文档编辑器" },
];
for (const c of clicks) {
  const n = await p.locator(c.sel).count();
  if (n === 0) {
    out.push(`\n@@@@ ${c.label}: 没有 ${c.sel}`);
    continue;
  }
  for (let i = 0; i < Math.min(n, 3); i++) {
    await p.locator(c.sel).nth(i).click({ force: true });
    await p.waitForTimeout(1200);
    const shape = await p.evaluate(`(() => {
      const page = document.querySelector('.main-pane .page');
      const chat = document.querySelector('.main-pane .chat-pane, .main-pane .chat, .main-pane .message-stream');
      return { hasPage: !!page, pageClass: page ? page.className : null, chat: chat ? chat.className : null, blocks: page ? [...page.children].map((el) => el.tagName.toLowerCase() + '.' + (el.className||'').toString().split(/\\s+/)[0] + '=' + Math.round(el.getBoundingClientRect().height)) : null };
    })()`);
    out.push(`\n@@@@ ${c.label} #${i}  ${JSON.stringify(shape)}`);
    const tb = await p.evaluate(TOPBAND);
    out.push(printTopband(`${c.label} #${i}`, tb));
    const ing = await p.evaluate(INGEST);
    if (!ing.error) for (const r of ing.rows) out.push(`  [吞] ${'  '.repeat(r.depth)}${r.sel} h=${r.h} w=${r.w} padV=${r.padV} padH=${r.padH} gap=${r.rowGap}/${r.colGap} minH=${r.minH} 吃掉=${r.consumed}(${r.pctOfOwnHeight}%) kids=${r.kids} Σ子=${r.sumKid}`);
  }
}

await b.close();
const text = out.join('\n');
process.stdout.write(text + '\n');
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/scratch/round379-topband-raw.txt", text, "utf8");
const fffd = (text.match(new RegExp(String.fromCharCode(0xfffd), "g")) || []).length;
process.stdout.write(`\nFFFD_COUNT ${fffd}\n`);
