// 量 .conversation-item 的行盒分解：baseline vs 摘掉 margin-top vs 摘掉 line-height。
// 目的：搞清 expect(copyH + pad).toBe(rowH) 为什么在 P1 里红了（四舍五入还是真不相等）。
import { chromium } from "playwright";

const VARIANTS = {
  strutKilled: '.conversation-item{line-height:0}',
  strutKilledNoMT: '.conversation-item{line-height:0}.conversation-preview{margin-top:0}',
  baseline: "",
  noMarginTop: ".conversation-preview{margin-top:0}",
  noLineHeight: ".conversation-preview{line-height:normal}",
  // 「删掉声明」的实际效果是退回继承值 1.55（body 上写的），不是 normal —— 两者差 2.6px。
  inheritBody: ".conversation-preview{line-height:1.55}",
  fs11: ".conversation-preview{font-size:11px;line-height:normal}",
};

const b = await chromium.launch();
for (const [name, css] of Object.entries(VARIANTS)) {
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        conversations: [
          {
            conversation_id: "q-a",
            kind: "group",
            title: "放得下的一行",
            unread_count: 0,
            boss_attention_count: 0,
            last_message_at: 1_795_000_200_000,
            last_message_preview: "汉".repeat(14),
          },
          {
            conversation_id: "q-b",
            kind: "group",
            title: "放不下的一行",
            unread_count: 0,
            boss_attention_count: 0,
            last_message_at: 1_795_000_200_000,
            last_message_preview: "汉".repeat(17),
          },
        ],
      },
    });
  });
  if (css) {
    await pg.addInitScript((c) => {
      const inject = () => {
        const s = document.createElement("style");
        s.textContent = c;
        (document.head || document.documentElement).append(s);
      };
      if (document.documentElement) inject();
      document.addEventListener("DOMContentLoaded", inject);
    }, css);
  }
  await pg.goto("http://127.0.0.1:9797/#/messages", {
    waitUntil: "domcontentloaded",
  });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  const rows = await pg.evaluate(`(() => {
    const out = [];
    for (const item of document.querySelectorAll('.conversation-item')) {
      const copy = item.querySelector('.conversation-copy');
      const title = item.querySelector('.conversation-title');
      const prev = item.querySelector('.conversation-preview');
      const cs = getComputedStyle(item);
      const ps = getComputedStyle(prev);
      out.push({
        id: item.dataset.conversationId,
        row: item.getBoundingClientRect().height,
        pad: parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom),
        copy: copy.getBoundingClientRect().height,
        copyCh: copy.clientHeight,
        title: title.getBoundingClientRect().height,
        prev: prev.getBoundingClientRect().height,
        prevFs: ps.fontSize,
        prevLh: ps.lineHeight,
        mt: ps.marginTop,
        fits: prev.scrollWidth <= prev.clientWidth,
        track: prev.clientWidth,
        scroll: prev.scrollWidth,
      });
    }
    return JSON.stringify(out);
  })()`);
  for (const r of JSON.parse(rows)) {
    console.log(
      `${name.padEnd(13)} ${String(r.id).padEnd(6)} row=${r.row} pad=${r.pad} ` +
        `copy=${r.copy}/ch${r.copyCh} title=${r.title} prev=${r.prev} ` +
        `fs=${r.prevFs} lh=${r.prevLh} mt=${r.mt} fits=${r.fits} ${r.track}/${r.scroll}`,
    );
  }
  await pg.close();
}
await b.close();
