// 间距归刻度前后的【几何差分】：把每枚元素的盒子记下来，改完再记一次，逐条比。
//
// 为什么要有这一份：把 7/9/10 这类半档折到相邻整档，判据不能是「看起来差不多」。
// 差分只回答一个问题 —— 【变化的那一枚，是不是这次要动的那一枚】。
// 名单外的位移 = 顺手改坏了别处，逐条回滚那一条，别整体庆祝。
//
// 用法：node round377-geom-diff.mjs before.json  →  改样式  →  node round377-geom-diff.mjs after.json
//      node round377-geom-diff-diff.mjs before.json after.json
import { writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";
const OUT = process.argv[2] || ".workbuddy/round377-geom-before.json";

const VIEWS = [
  ["backlog", "#/backlog"],
  ["settings", "#/settings"],
  ["talent", "#/talent"],
  ["documents", "#/documents"],
  ["contacts", "#/contacts"],
  ["admin-today", "#/admin/today"],
  ["admin-org", "#/admin/org"],
];

async function geometry(page) {
  return page.evaluate(() => {
    const out = {};
    const seen = new Map();
    for (const el of document.querySelectorAll("body *")) {
      if (!el.className || typeof el.className !== "string") continue;
      const key = `${el.tagName.toLowerCase()}.${el.className.trim().split(/\s+/u).join(".")}`;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      // 同名多实例的加序号：卡片列表里第 3 枚变了要能看出是哪一枚。
      const id = n === 1 ? key : `${key}[${n}]`;
      out[id] = [
        Math.round(r.width * 100) / 100,
        Math.round(r.height * 100) / 100,
        Math.round(r.top * 100) / 100,
        cs.gap,
      ];
    }
    return out;
  });
}

const b = await chromium.launch();
const data = {};
for (const theme of ["light", "dark"]) {
  for (const [w, h] of [
    [1440, 900],
    [390, 780],
  ]) {
    for (const [name, hash] of VIEWS) {
      const ctx = await b.newContext({ viewport: { width: w, height: h } });
      await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
      const p = await ctx.newPage();
      await p.goto(`${BASE}/group.html${hash}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(2600);
      data[`${theme}@${w}|${name}`] = await geometry(p);
      await ctx.close();
    }
  }
  // 群会话单独一条（要先选群）。
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/group.html#/messages`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2600);
  const n = await p.locator(".conversation-item").count();
  for (let i = 0; i < n; i++) {
    await p.locator(".conversation-item").nth(i).click();
    await p.waitForTimeout(1300);
    if ((await p.locator(".group-chat-tab").count()) > 0) break;
  }
  await p.waitForTimeout(800);
  data[`${theme}@1440|group-chat`] = await geometry(p);
  // 任务流/文档区两页签也各量一次（.group-task-card / .group-document-card 的宿主）。
  for (const label of ["任务流", "文档区"]) {
    await p.getByRole("tab", { name: label, exact: true }).click();
    await p.waitForTimeout(1500);
    data[`${theme}@1440|group-chat-${label}`] = await geometry(p);
  }
  await ctx.close();
}
await b.close();

writeFileSync(OUT, JSON.stringify(data, null, 1), "utf8");
const nodes = Object.values(data).reduce((a, d) => a + Object.keys(d).length, 0);
console.log(`写入 ${OUT}：${Object.keys(data).length} 个场景，共 ${nodes} 次节点采样`);
