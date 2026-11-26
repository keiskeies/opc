// round379 空白账第四发：补前几发漏掉的那半屏 —— 会话/会议/文档编辑/详情面。
// 前三发只走到「导航根 + 列表第一条」，而 #listContent 里消息页的子节点叫
// .conversation-section（不是 .list-item），所以「点进会话」那一段静默没跑。
// 用户说的是【所有页面】，会话与会议正是天天看的那几面，必须补量。
// 判据同第一发：块序列 + 块间距 + 尾部；另加会话面特有的三条：
//   message-stream 的 padding、composer 的高、stream 内气泡之间的实际净空。
// 只读：只点导航/条目/页签，不输入一个字（autosave 会写进共享 dev 库）。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const SHAPE = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const main = document.querySelector('.main-pane');
  const page = main ? main.querySelector('.page') : null;
  const root = page || main;
  if (!root) return { error: 'no root' };
  const rr = root.getBoundingClientRect();
  const rcs = getComputedStyle(root);
  const kids = [...root.children].filter((el) => el.getBoundingClientRect().height > 0);
  const blocks = kids.map((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + '.' + (el.className || '').toString().trim().split(/\\s+/).slice(0, 2).join('.'),
      h: round1(r.height),
      pad: cs.paddingTop + '/' + cs.paddingRight + '/' + cs.paddingBottom + '/' + cs.paddingLeft,
      gap: cs.rowGap,
      minH: cs.minHeight,
      mb: cs.marginBottom,
    };
  });
  const lastBottom = kids.length ? Math.max(...kids.map((el) => el.getBoundingClientRect().bottom)) : rr.top;
  return {
    root: page ? '.page' : '.main-pane',
    rootClass: root.className,
    rootH: round1(rr.height),
    padV: round1(parseFloat(rcs.paddingTop) + parseFloat(rcs.paddingBottom)),
    padH: round1(parseFloat(rcs.paddingLeft) + parseFloat(rcs.paddingRight)),
    blocks,
    sumBlocks: round1(kids.reduce((a, el) => a + el.getBoundingClientRect().height, 0)),
    tail: round1(rr.bottom - lastBottom - parseFloat(rcs.paddingBottom)),
    scrollH: root.scrollHeight,
    clientH: root.clientHeight,
  };
})();`;

const CHAT = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const stream = document.querySelector('.message-stream');
  const composer = document.querySelector('.composer');
  const head = document.querySelector('.chat-head, .pane-head, .detail-head');
  const out = { stream: null, composer: null, head: null };
  if (stream) {
    const cs = getComputedStyle(stream);
    const r = stream.getBoundingClientRect();
    const rows = [...stream.children].filter((el) => el.getBoundingClientRect().height > 0).slice(0, 6).map((el) => {
      const er = el.getBoundingClientRect();
      const ecs = getComputedStyle(el);
      return (el.className || '').toString().split(/\\s+/)[0] + '=' + round1(er.height) + '/mb' + ecs.marginBottom + '/pad' + ecs.paddingTop + ' ' + ecs.paddingBottom;
    });
    const kids = [...stream.children].filter((el) => el.getBoundingClientRect().height > 0);
    let ink = 0;
    for (let i = 0; i < kids.length; i++) ink += kids[i].getBoundingClientRect().height;
    out.stream = {
      h: round1(r.height),
      pad: cs.padding,
      gap: cs.gap,
      n: kids.length,
      sum: round1(ink),
      rows,
    };
  }
  if (composer) {
    const r = composer.getBoundingClientRect();
    const cs = getComputedStyle(composer);
    out.composer = { h: round1(r.height), pad: cs.padding, gap: cs.gap };
  }
  if (head) {
    const r = head.getBoundingClientRect();
    out.head = { cls: (head.className || '').toString().split(/\\s+/)[0], h: round1(r.height), pad: getComputedStyle(head).padding };
  }
  return out;
})();`;

const clickers = [
  { hash: "#/messages", pick: "#listContent .conversation-item", label: "会话（群聊）", tail: CHAT },
  { hash: "#/messages", pick: "#listContent .conversation-section:nth-of-type(2) .conversation-item", label: "会话第二段", tail: CHAT },
  { hash: "#/documents", pick: "#listContent .doc-list-item", label: "文档编辑器", tail: CHAT },
  { hash: "#/backlog", pick: "#listContent .doc-list-item", label: "待办详情", tail: CHAT },
  { hash: "#/contacts", pick: "#listContent .conversation-item", label: "通讯录成员详情", tail: CHAT },
  { hash: "#/talent", pick: "#listContent .doc-list-item", label: "人才详情", tail: CHAT },
];

const out = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();
p.on("pageerror", (e) => out.push(`  [pageerror] ${String(e).slice(0, 160)}`));

for (const c of clickers) {
  await p.goto(`${BASE}/${c.hash}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1400);
  const n = await p.locator(c.pick).count();
  out.push(`\n@@@@ ${c.label}  ${c.hash}  选择器 ${c.pick} 命中 ${n}`);
  if (n === 0) {
    out.push("  (命中 0 ⇒ 这一面的入口选择器又猜错了，需要人工核对)");
    continue;
  }
  await p.locator(c.pick).first().click({ force: true });
  await p.waitForTimeout(1400);
  const shape = await p.evaluate(SHAPE);
  if (shape.error) out.push(`  !! ${shape.error}`);
  else {
    out.push(`  root ${shape.root}.${shape.rootClass} h=${shape.rootH} padV=${shape.padV} padH=${shape.padH} scrollH=${shape.scrollH}/client=${shape.clientH}`);
    out.push(`  块合计=${shape.sumBlocks} 尾部死区=${shape.tail}`);
    for (const bl of shape.blocks) out.push(`    - ${bl.sel} h=${bl.h} pad=${bl.pad} rowGap=${bl.gap} minH=${bl.minH} mb=${bl.mb}`);
  }
  const t = await p.evaluate(c.tail);
  if (t.stream) out.push(`  stream h=${t.stream.h} pad=${t.stream.pad} gap=${t.stream.gap} 气泡=${t.stream.n} Σ=${t.stream.sum} ⇒ ${t.stream.rows.join(' | ')}`);
  if (t.composer) out.push(`  composer h=${t.composer.h} pad=${t.composer.pad} gap=${t.composer.gap}`);
  if (t.head) out.push(`  head .${t.head.cls} h=${t.head.h} pad=${t.head.pad}`);
  if (!t.stream && !t.composer && !t.head) out.push("  (会话三件套一个没命中 ⇒ 不是会话面)");
}

await b.close();
const text = out.join('\n');
process.stdout.write(text + '\n');
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/scratch/round379-detail-raw.txt", text, "utf8");
const fffd = (text.match(new RegExp(String.fromCharCode(0xfffd), "g")) || []).length;
process.stdout.write(`\nFFFD_COUNT ${fffd}\n`);
