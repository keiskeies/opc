// round379 对齐真相探针：我在 .list-heading 的注释里写下「条目文字左缘 = .list-content 的 8
// + 条目自己的 padding-inline 9 = 17，与栏头的横向 17 齐平」。这句话现在只是【算式】，
// 而同一栏里住着四种条目，各自的左内距不同（conversation-item 9 / member-row 8 /
// doc-list-item 10 / org-group 0 且它内嵌 conversation-item）。只要有一种不是 9，
// 那句注释就是在描述一个不存在的对齐 —— 而它会被下一个人当成【承重格】不敢动。
// 所以这里不推算，直接量每一路由栏头标题的左缘 vs 该栏真实条目的文字左缘。
// 文字左缘取条目内第一行文字的 rect.left（不是条目盒子的 left：盒子 left 不含内距，
// 而「文字对齐」这件事只在文字上成立）。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const ALIGN = `(() => {
  const round1 = (n) => Math.round(n * 10) / 10;
  const list = document.querySelector('.list-pane');
  const head = list ? list.querySelector('.list-heading') : null;
  const body = document.querySelector('#listContent');
  if (!list || !body) return { error: 'no list' };
  const headTitle = head ? head.querySelector('h1, h2, h3, strong') || head.firstElementChild : null;
  const headLeft = headTitle ? round1(headTitle.getBoundingClientRect().left) : null;
  // 第一枚「像条目」的节点：跳过分组标题，取第一个有文字的按钮/行
  const items = [...body.querySelectorAll('button, .conversation-item, .member-row, .doc-list-item, .org-group, .talent-card')]
    .filter((el) => el.getBoundingClientRect().height > 0);
  const seen = new Set();
  const rows = [];
  for (const el of items) {
    const cls = (el.className || '').toString().trim().split(/\\s+/)[0];
    if (seen.has(cls)) continue;
    seen.add(cls);
    // 找这一行里最靠左的【文字节点】的左缘：取第一个有非空 text 的后代
    let textLeft = null;
    const stack = [el];
    while (stack.length) {
      const cur = stack.shift();
      const own = [...cur.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
      if (own) {
        const range = document.createRange();
        range.selectNodeContents(cur);
        const r = range.getBoundingClientRect();
        range.detach && range.detach();
        if (r.width > 0) {
          textLeft = round1(r.left);
          break;
        }
      }
      for (const kid of cur.children) stack.push(kid);
    }
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    rows.push({
      cls,
      boxLeft: round1(r.left),
      textLeft,
      padLeft: cs.paddingLeft,
      // 祖先链上的内距合计（解释差值从哪来）
      chain: (() => {
        const parts = [];
        let cur = el;
        while (cur && cur !== list) {
          const p = getComputedStyle(cur).paddingLeft;
          if (p !== '0px') parts.push((cur.className || cur.tagName).toString().split(/\\s+/)[0] + ':' + p);
          cur = cur.parentElement;
        }
        return parts.join(' + ');
      })(),
    });
  }
  return { headLeft, bodyPadLeft: getComputedStyle(body).paddingLeft, rows };
})();`;

const out = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
const p = await ctx.newPage();

for (const hash of ["#/messages", "#/contacts", "#/documents", "#/backlog", "#/talent", "#/settings/member", "#/settings/roles", "#/admin"]) {
  await p.goto(`${BASE}/${hash}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1400);
  const a = await p.evaluate(ALIGN);
  out.push(`\n@@@@ ${hash}`);
  if (a.error) {
    out.push(`  !! ${a.error}`);
    continue;
  }
  out.push(`  栏头文字左缘=${a.headLeft}  #listContent padding-left=${a.bodyPadLeft}`);
  for (const r of a.rows)
    out.push(
      `  .${r.cls} 盒左=${r.boxLeft} 文字左=${r.textLeft} padLeft=${r.padLeft} ⇒ 差(文字−栏头)=${r.textLeft !== null && a.headLeft !== null ? round(r.textLeft - a.headLeft) : "?"}  链 ${r.chain}`,
    );
}

function round(n) {
  return Math.round(n * 10) / 10;
}

await b.close();
const text = out.join("\n");
process.stdout.write(text + "\n");
const { writeFileSync } = await import("node:fs");
writeFileSync(".workbuddy/scratch/round379-align-raw.txt", text, "utf8");
const R = String.fromCharCode(0xfffd);
process.stdout.write(`\nFFFD_COUNT ${(text.match(new RegExp(R, "g")) || []).length}\n`);
