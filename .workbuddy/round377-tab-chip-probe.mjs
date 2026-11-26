// 两族页签 + 两族 chip 的实测对照（改之前先量，改之后再量一次同名探针）。
// 只读：不改文件、不写字、只算 getComputedStyle 与盒高。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const box = (p, sel) =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return `${s} :: 无实例`;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return (
      `${s} :: ${(Math.round(r.width * 100) / 100)}x${Math.round(r.height * 100) / 100}` +
      ` pad=${cs.paddingTop}/${cs.paddingRight}/${cs.paddingBottom}/${cs.paddingLeft}` +
      ` min-h=${cs.minHeight} gap=${cs.gap} fw=${cs.fontWeight} fs=${cs.fontSize}` +
      ` bg=${cs.backgroundColor} color=${cs.color}`
    );
  }, sel);

const b = await chromium.launch();
for (const [label, hash] of [
  ["任务面板 (.tabs.task-tabs)", "#/backlog"],
  ["设置 (.tabs)", "#/settings"],
  ["人才市场 (.tabs + .btn)", "#/talent"],
]) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/group.html${hash}`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  console.log(`\n════ ${label} ════`);
  for (const sel of [".tabs", ".tabs .tab", ".tabs .tab.active", ".tabs .btn"]) {
    console.log("  " + (await box(p, sel)));
  }
  await ctx.close();
}

// 群聊页签要先进一个群才有；群列表第一项点进去即可。
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/group.html#/messages`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2500);
  const n = await p.locator(".conversation-item").count();
  for (let i = 0; i < n; i++) {
    await p.locator(".conversation-item").nth(i).click();
    await p.waitForTimeout(1200);
    if ((await p.locator(".group-chat-tab").count()) > 0) break;
  }
  console.log("\n════ 群会话 (.group-chat-tabs) ════");
  for (const sel of [".group-chat-tabs", ".group-chat-tab", ".group-chat-tab.active"]) {
    console.log("  " + (await box(p, sel)));
  }
  await ctx.close();
}

// chip：工作台 .pill 与控制室 .admin-pill 的同一件事（状态小胶囊）刻度对照。
{
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/group.html#/admin/today`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);
  console.log("\n════ chip 对照（控制室页里同时有 .pill 与 .admin-pill 的实例）════");
  for (const sel of [".admin-root .admin-pill", ".pill"]) {
    console.log("  " + (await box(p, sel)));
  }
  console.log(
    "  预算卡读数行: " +
      (await box(p, ".admin-root .admin-figure")) +
      "\n  预算卡标签:  " +
      (await box(p, ".admin-root .admin-stat .admin-lbl")),
  );
  await ctx.close();
}
await b.close();
