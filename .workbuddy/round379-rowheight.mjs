// round379 行盒复核：我在 .conversation-item 的注释里写了三件事 ——
// ① 改前行盒 58.33 = 内距 20 + 内容地板 38.33；② 改后放得下 15 条（原 14）；
// ③ 「列表栏的空白不是间距造成的，是看得见的条数不够」。
// ① 的算式里内距 20 是旧的 10+10、改后应是 8+8=16，注释里两个数并排写着，
// 下一个人分不清 58.33 是改前还是改后 —— 而 ledger 里也抄了「行盒 58 = padding 20 + 地板 38」。
// 这里把【改后】的真实行盒、地板、以及一屏真能放几条量出来，注释照实重写。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const ROWS = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const list = document.querySelector('#listContent');
  const pane = document.querySelector('#listPane');
  const items = [...list.querySelectorAll('.conversation-item')];
  if (items.length === 0) return { error: 'no conversation-item' };
  const boxes = items.map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // 内容地板 = 高 − 内距 − 下外边距：真正决定行高的是这一格（两行小字的行盒合计）
    const padBox = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const mb = parseFloat(cs.marginBottom);
    return {
      h: round1(r.height),
      padTop: cs.paddingTop,
      padBottom: cs.paddingBottom,
      mb,
      floor: round1(r.height - padBox - mb),
      firstTextLeft: (() => {
        const t = el.querySelector('.conversation-title, strong, b, h3');
        return t ? round1(t.getBoundingClientRect().left) : null;
      })(),
    };
  });
  const uniq = {};
  for (const bx of boxes) {
    const k = bx.h + "|" + bx.padTop + "|" + bx.padBottom + "|" + bx.mb + "|" + bx.floor;
    uniq[k] = (uniq[k] || 0) + 1;
  }
  const csItem = getComputedStyle(items[0]);
  // 一屏真放几条：列表可视高 ÷ 步进（行盒 + margin-bottom），向下取整
  const step = boxes[0].h + boxes[0].mb;
  const listCh = list.clientHeight;
  return {
    n: items.length,
    distinct: uniq,
    gridCols: csItem.gridTemplateColumns,
    listPaneH: round1(pane.getBoundingClientRect().height),
    listClientH: listCh,
    listScrollH: list.scrollHeight,
    step,
    fitPerScreen: Math.floor(listCh / step),
    // 栏头/工具条吃掉多少列表可见高
    headH: round1((document.querySelector('.list-heading') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
    toolbarH: round1((document.querySelector('.list-toolbar') || { getBoundingClientRect: () => ({ height: 0 }) }).getBoundingClientRect().height),
  };
})();`;

const out = [];
const b = await chromium.launch();
for (const vp of [
  { w: 1440, h: 900 },
  { w: 1440, h: 836 },
  { w: 1280, h: 720 },
]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
  const p = await ctx.newPage();
  for (const hash of ["#/messages", "#/contacts"]) {
    await p.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(1500);
    const r = await p.evaluate(ROWS);
    out.push(`\n@@@@ ${vp.w}x${vp.h} ${hash}`);
    if (r.error) {
      out.push(`  !! ${r.error}`);
      continue;
    }
    out.push(
      `  条目 n=${r.n} 步进=${r.step} 列表可视高=${r.listClientH}(scroll ${r.listScrollH}) ⇒ 一屏放 ${r.fitPerScreen} 条  栏头=${r.headH} 工具条=${r.toolbarH} 栏高=${r.listPaneH}`,
    );
    for (const [k, v] of Object.entries(r.distinct)) {
      const [h, pt, pb, mb, floor] = k.split("|");
      out.push(`    h=${h} pad ${pt}/${pb} mb=${mb} ⇒ 地板=${floor}  ×${v}`);
    }
  }
  await ctx.close();
}

await b.close();
const text = out.join("\n");
process.stdout.write(text + "\n");
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/round379-rowheight.log", text, "utf8");
const R = String.fromCharCode(0xfffd);
process.stdout.write(`\nFFFD_COUNT ${(text.match(new RegExp(R, "g")) || []).length}\n`);
