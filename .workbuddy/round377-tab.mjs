// 页签刻度归 token 的变异自证 + 改前/改后同一份探针。
//
// 两个方向都要证据，缺一不可：
//  1) 承重：把 token 规则倒回改前的裸数字（gap 5px / padding 8px 13px），读数必须动。
//     不动 = 这条规则白写（按落地纪律先怀疑判据）。
//  2) 意图：改前后差值就是这次真正改了什么的说明 —— 这里应当【只有两枚数】变：
//     相邻间距 5→4、左右留白 13→12。若盒高或别处也跟着动，说明 token 选档选错了。
// 每发跑完立即从内存原文恢复，恢复后再量一次确认回到改前值；末尾断言逐字节复原。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const CSS = resolve("packages/web/public/group.css");
const ORIGIN = readFileSync(CSS, "utf8");

const NEW_TABS = ".tabs { display: flex; gap: var(--space-1); border-bottom: 1px solid var(--line); margin-bottom: 18px; }";
const OLD_TABS = ".tabs { display: flex; gap: 5px; border-bottom: 1px solid var(--line); margin-bottom: 18px; }";
const NEW_TAB = ".tab { padding: var(--space-2) var(--space-3); border: 0;";
const OLD_TAB = ".tab { padding: 8px 13px; border: 0;";

const b = await chromium.launch();

async function shot(label) {
  const rows = [];
  for (const [view, hash] of [
    ["任务面板 .tabs", "#/backlog"],
    ["设置 .tabs", "#/settings"],
  ]) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:9797/group.html${hash}`, { waitUntil: "domcontentloaded" });
    await p.waitForTimeout(2500);
    rows.push(
      await p.evaluate(
        ([v, tabsSel, tabSel]) => {
          const tabs = document.querySelector(tabsSel);
          const tab = document.querySelector(tabSel);
          if (!tabs || !tab) return `${v} :: 无页签实例`;
          const cs = getComputedStyle(tabs);
          const ts = getComputedStyle(tab);
          const r = tab.getBoundingClientRect();
          return (
            `${v} :: 条宽 ${Math.round(tabs.getBoundingClientRect().width)} · ` +
            `gap=${cs.gap} · 单枚 ${Math.round(r.width * 100) / 100}x${Math.round(r.height * 100) / 100} · ` +
            `padding=${ts.paddingTop} ${ts.paddingRight} ${ts.paddingBottom} ${ts.paddingLeft}`
          );
        },
        [view, ".tabs", ".tabs .tab"],
      ),
    );
    await ctx.close();
  }
  // 群聊那族不受本次改动影响，一起量是为了钉住「另一族没被顶到」。
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:9797/group.html#/messages", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const n = await p.locator(".conversation-item").count();
  for (let i = 0; i < n; i++) {
    await p.locator(".conversation-item").nth(i).click();
    await p.waitForTimeout(1200);
    if ((await p.locator(".group-chat-tab").count()) > 0) break;
  }
  rows.push(
    await p.evaluate(() => {
      const tabs = document.querySelector(".group-chat-tabs");
      const tab = document.querySelector(".group-chat-tab");
      if (!tabs || !tab) return "群会话 .group-chat-tabs :: 无实例";
      const cs = getComputedStyle(tabs);
      const ts = getComputedStyle(tab);
      const r = tab.getBoundingClientRect();
      return (
        `群会话 .group-chat-tabs :: 条宽 ${Math.round(tabs.getBoundingClientRect().width)} · ` +
        `gap=${cs.gap} · 单枚 ${Math.round(r.width * 100) / 100}x${Math.round(r.height * 100) / 100} · ` +
        `padding=${ts.paddingTop} ${ts.paddingRight} ${ts.paddingBottom} ${ts.paddingLeft}`
      );
    }),
  );
  await ctx.close();
  console.log(`── ${label} ──`);
  for (const r of rows) console.log("  " + r);
  return rows;
}

// ⚠ 一发变异可以【同时】改多处，但必须一次写盘：早先版本每调一次 patch() 就从内存原文
// 重算再写，于是第二次调用把第一次的改动冲掉了 —— 结果「倒回裸数字」这一发只改了 padding，
// gap 那半压根没落盘，读数【当然】不变。这正是「抹了读数不变 ⇒ 先怀疑判据」那一类：
// 不承重的不是规则，是量它的这只手。所以这里改成：内存里留一份底稿 + 一组编辑 ⇒ 一次写盘。
function patchAll(edits) {
  let out = ORIGIN;
  for (const [find, to] of edits) {
    const hits = out.split(find).length - 1;
    if (hits !== 1) throw new Error(`锚点出现 ${hits} 次（要恰好 1 次）：${find.slice(0, 50)}`);
    out = out.replace(find, to);
  }
  if (out === ORIGIN) throw new Error("这发变异没改动任何字节");
  writeFileSync(CSS, out, "utf8");
}
const restore = () => writeFileSync(CSS, ORIGIN, "utf8");

const after = await shot("改后（token：gap var(--space-1) / padding var(--space-2) var(--space-3)）");
patchAll([
  [NEW_TABS, OLD_TABS],
  [NEW_TAB, OLD_TAB],
]);
const before = await shot("改前（倒回裸数字：gap 5px / padding 8px 13px）");
restore();
const back = await shot("复原复测（应与【改后】逐字一致）");

await b.close();

const changed = before.filter((r, i) => r !== after[i]);
console.log(`\n承重：倒回裸数字后有 ${changed.length}/${after.length} 条读数不同${changed.length ? "：" : " ⇒ 这条规则不承重，需说明"}`);
for (const c of changed) console.log("  " + c);
console.log("复原复测与改后逐条一致:", JSON.stringify(back) === JSON.stringify(after) ? "是" : "否");
console.log("文件已逐字节复原:", readFileSync(CSS, "utf8") === ORIGIN ? "是" : "否");
