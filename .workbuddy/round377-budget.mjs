// 会话列表「预览放得下几个汉字」的边界探针 —— 三档栏宽一次量齐。
// 用途：e2e 里那两条字数门（宽档 / 窄档）与 group.css:--list-width 注释里的
// 「轨道 → 字数」表，数字只能从这份输出取，不许凭印象写。
// round377 把 .conversation-item 的两道 gap 从 10/9 折到 var(--space-2)(8) 后重跑过一次，
// 见 .workbuddy/round377-list-budget.log。
import { chromium } from "playwright";

// 视口宽度 → 该视口下真正生效的 --list-width 档（340 / 305 / 245）。
const VIEWS = [
  ["宽档 340", 1440],
  ["窄档 305", 1100],
  ["极窄 245", 800],
];

const b = await chromium.launch();
for (const [label, w] of VIEWS) {
  const ctx = await b.newContext({ viewport: { width: w, height: 900 } });
  const pg = await ctx.newPage();
  await pg.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        conversations: Array.from({ length: 24 }, (_, i) => ({
          conversation_id: `q-${i}`,
          kind: "group",
          title: "标题",
          unread_count: 0,
          boss_attention_count: 0,
          last_message_at: 1_795_000_000_000 + (24 - i) * 1000,
          last_message_preview: "汉".repeat(i + 1),
        })),
      },
    });
  });
  await pg.goto("http://127.0.0.1:9797/group.html#/messages", { waitUntil: "domcontentloaded" });
  await pg.waitForSelector(".conversation-item", { timeout: 20000 });
  await pg.waitForTimeout(600);
  const out = await pg.evaluate(() => {
    const pane = Math.round(document.querySelector(".list-pane").getBoundingClientRect().width);
    const rows = [...document.querySelectorAll(".conversation-item")].map((it) => {
      const p = it.querySelector(".conversation-preview");
      const cs = getComputedStyle(p);
      return {
        chars: p.textContent.length,
        track: p.clientWidth,
        scroll: p.scrollWidth,
        truncated: p.scrollWidth > p.clientWidth + 0.5,
        fs: cs.fontSize,
      };
    });
    const rowH = Math.round(document.querySelector(".conversation-item").getBoundingClientRect().height * 100) / 100;
    return { pane, rows, rowH, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
  });
  const fits = out.rows.filter((r) => !r.truncated).length;
  console.log(
    `\n${label} · pane=${out.pane} · 行高=${out.rowH} · 横向溢出=${out.overflow} · ` +
      `字号=${out.rows[0].fs} · 轨道=${out.rows[0].track}px ⇒ 放得下 ${fits} 字，${fits + 1} 字起截断`,
  );
  const edge = out.rows.find((r) => r.chars === fits + 1);
  console.log(`  边界：${fits} 字 scroll=${out.rows[fits - 1].scroll} ≤ track=${out.rows[fits - 1].track} · ${fits + 1} 字 scroll=${edge.scroll} > track=${edge.track}（余量 ${out.rows[fits - 1].track - out.rows[fits - 1].scroll}px / ${edge.track - edge.scroll}px）`);
  if (w === 1100) {
    // 反向对照：把栏宽倒回 round376 之前的 275，量「抬栏宽」那一发到底承重不承重。
    // 窄档 e2e 文档串里「退回 275 时轨道只剩 Npx」那句话的数字只能从这里取。
    await pg.addStyleTag({ content: ":root { --list-width: 275px !important; }" });
    await pg.waitForTimeout(400);
    const back = await pg.evaluate(() => {
      const rows = [...document.querySelectorAll(".conversation-item")].map((it) => {
        const p = it.querySelector(".conversation-preview");
        return { chars: p.textContent.length, track: p.clientWidth, truncated: p.scrollWidth > p.clientWidth + 0.5 };
      });
      return { pane: Math.round(document.querySelector(".list-pane").getBoundingClientRect().width), track: rows[0].track, fits: rows.filter((r) => !r.truncated).length };
    });
    console.log(`  倒回 275：pane=${back.pane} 轨道=${back.track}px ⇒ 只放得下 ${back.fits} 字（窄档那条 e2e 若拿 12 字去判会红在这里）`);
  }
  await ctx.close();
}
await b.close();
