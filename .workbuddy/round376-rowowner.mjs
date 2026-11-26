// 行盒 58 到底是谁撑的：把 item / pin / row 三者的高度与计算样式一起打出来。
import { chromium } from "playwright";
const b = await chromium.launch();
for (const [name, css] of Object.entries({
  baseline: "",
  strutKilled: ".conversation-item{line-height:0}",
  strutKilledPlus: ".conversation-item{line-height:0}.conversation-row{align-items:start}",
})) {
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.route("**/api/v1/conversations", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    await r.fulfill({ json: { conversations: [
      { conversation_id: "q-a", kind: "group", title: "标题", unread_count: 0, boss_attention_count: 0,
        last_message_at: 1795000200000, last_message_preview: "汉".repeat(14) },
    ] } });
  });
  if (css) await pg.addInitScript((c) => {
    const inj = () => { const s = document.createElement("style"); s.textContent = c;
      (document.head || document.documentElement).append(s); };
    if (document.documentElement) inj();
    document.addEventListener("DOMContentLoaded", inj);
  }, css);
  await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
  await pg.waitForSelector(".conversation-item", { timeout: 15000 });
  console.log(name, await pg.evaluate(`(() => {
    const row = document.querySelector('.conversation-row');
    const item = row.querySelector('.conversation-item');
    const pin = row.querySelector('.conversation-pin');
    const tail = item.querySelector('.conversation-tail');
    const ics = getComputedStyle(item);
    return JSON.stringify({
      row: row.getBoundingClientRect().height,
      item: item.getBoundingClientRect().height,
      pin: pin.getBoundingClientRect().height,
      tail: tail.getBoundingClientRect().height,
      itemLh: ics.lineHeight, itemAl: ics.alignSelf,
      rowAl: getComputedStyle(row).alignItems,
      rowTr: getComputedStyle(row).gridTemplateRows,
    });
  })()`));
  await pg.close();
}
await b.close();
