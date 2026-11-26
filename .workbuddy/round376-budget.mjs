import { chromium } from "playwright";

// 目的：找出「预览放得下几个汉字」的精确边界，作为 e2e 判据的数字来源。
// 每档宽度都取真 CSS（真改 CSS 文件），用 route mock 控制预览文案长度。
const b = await chromium.launch();
for (const w of [1440, 1180]) {
  const pg = await b.newPage({ viewport: { width: w, height: 900 } });
  await pg.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        conversations: Array.from({ length: 17 }, (_, i) => ({
          conversation_id: `q-${i}`,
          kind: "group",
          title: "标题",
          unread_count: 0,
          boss_attention_count: 0,
          last_message_at: 1_795_000_000_000 + (17 - i) * 1000,
          last_message_preview: "汉".repeat(i + 1),
        })),
      },
    });
  });
  await pg.goto("http://127.0.0.1:9797/#/messages", {
    waitUntil: "domcontentloaded",
  });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  const out = await pg.evaluate(() => {
    const pane = Math.round(
      document.querySelector(".list-pane").getBoundingClientRect().width,
    );
    return {
      pane,
      rows: [...document.querySelectorAll(".conversation-item")].map((it) => {
        const p = it.querySelector(".conversation-preview");
        const cs = getComputedStyle(p);
        return {
          chars: p.textContent.length,
          client: p.clientWidth,
          scroll: p.scrollWidth,
          truncated: p.scrollWidth > p.clientWidth,
          fs: cs.fontSize,
        };
      }),
    };
  });
  console.log(`\n== viewport ${w} pane=${out.pane} ==`);
  console.table(out.rows);
  await pg.close();
}
await b.close();
