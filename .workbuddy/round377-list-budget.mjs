// 会话行【预览轨道】宽度的改前/改后对照 —— round377 把 .conversation-item 的 gap
// 从 10 折到 var(--space-2)(8) 之后，轨道必然变宽，于是 round376 立的那两条字数门
// （宽档 14 字放得下 / 17 字仍截断；窄档 11 / 14）的窗口会右移。
//
// 这一发回答两个问题：
//  1) 窗口右移到哪里（逐字探边界）；
//  2) 新的 e2e 数字应当写多少（取「上限 − 1 / 上限 + 2」，两侧各留两字以上）。
// 同一条页面上用 CSSOM 现挂一条覆盖规则模拟「改前」，不动文件（避免与并发的量测互踩）。
import { chromium } from "playwright";

const b = await chromium.launch();

async function track(page) {
  return page.evaluate(() => {
    const item = document.querySelector('.conversation-section[data-section="group"] .conversation-item');
    if (!item) return null;
    const preview = item.querySelector(".conversation-preview") || item.querySelector(".list-content p");
    if (!preview) return null;
    return {
      track: Math.round(preview.clientWidth * 100) / 100,
      gap: getComputedStyle(item).gap,
      pane: Math.round(document.querySelector(".list-pane").getBoundingClientRect().width),
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
    };
  });
}

async function boundary(page) {
  // 逐字探：往轨道里塞「汉」×N，找第一个 scrollWidth > clientWidth 的 N。
  return page.evaluate(() => {
    const item = document.querySelector('.conversation-section[data-section="group"] .conversation-item');
    const el = item && (item.querySelector(".conversation-preview") || item.querySelector(".list-content p"));
    if (!el) return null;
    const keep = el.textContent;
    let last = 0;
    for (let n = 1; n <= 40; n++) {
      el.textContent = "汉".repeat(n);
      if (el.scrollWidth > el.clientWidth + 0.5) {
        last = n;
        break;
      }
    }
    el.textContent = keep;
    return last === 0 ? ">40" : `放得下 ${last - 1} 字，${last} 字起截断`;
  });
}

for (const [label, w] of [
  ["宽档 1440（--list-width 340）", 1440],
  ["窄档 1100（≤1180 → 305）", 1100],
]) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        conversations: Array.from({ length: 3 }, (_, i) => ({
          conversation_id: `q-${i}`,
          kind: "group",
          title: "标题",
          unread_count: 0,
          boss_attention_count: 0,
          last_message_at: 1_795_000_000_000 + (3 - i) * 1000,
          last_message_preview: "请确认预算分配方案后再继续推进下一阶段工作",
        })),
      },
    });
  });
  await page.goto("http://127.0.0.1:9797/group.html#/messages", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".conversation-item", { timeout: 20000 });
  await page.waitForTimeout(800);
  console.log(`\n════ ${label} ════`);
  const now = await track(page);
  console.log(`  改后  gap=${now.gap} 轨道=${now.track}px 栏宽=${now.pane} 溢出=${now.scrollW - now.clientW}px  ${await boundary(page)}`);
  // 模拟改前：把这次收档的那两条 gap 倒回裸数字（只在这一张页面上，走 CSSOM）。
  await page.addStyleTag({
    content: ".conversation-item { gap: 10px !important; }",
  });
  await page.waitForTimeout(300);
  const old = await track(page);
  console.log(`  改前  gap=${old.gap} 轨道=${old.track}px 栏宽=${old.pane} 溢出=${old.scrollW - old.clientW}px  ${await boundary(page)}`);
  console.log(`  ⇒ 轨道差 = ${(now.track - old.track).toFixed(2)}px`);
  await ctx.close();
}
await b.close();
