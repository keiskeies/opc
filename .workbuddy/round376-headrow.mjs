// HEAD 形状（无 display:block、11px、无 line-height）的行盒 vs 现在：坐实 group.css
// 注释里那句「59 → 58」到底成不成立。
import { chromium } from "playwright";
const HEAD = ".conversation-preview{display:inline;font-size:11px;line-height:normal}";
const b = await chromium.launch();
for (const [name, css] of Object.entries({ now: "", head: HEAD })) {
  const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await pg.route("**/api/v1/conversations", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    await r.fulfill({ json: { conversations: [
      { conversation_id: "a", kind: "group", title: "标题", unread_count: 0, boss_attention_count: 0,
        last_message_at: 1795000200000, last_message_preview: "汉".repeat(41) },
      { conversation_id: "b", kind: "private", title: "私聊", unread_count: 0, boss_attention_count: 0,
        last_message_at: 1795000100000, last_message_preview: "汉".repeat(14) },
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
  console.log(name, await pg.evaluate(`(() => { const out = [...document.querySelectorAll('.conversation-item')].map((it) => {
    const copy = it.querySelector('.conversation-copy');
    const list = document.querySelector('.list-content');
    return { id: it.dataset.conversationId, row: it.getBoundingClientRect().height,
      copy: copy.getBoundingClientRect().height, track: Math.round(it.querySelector('.conversation-preview').clientWidth),
      listOverflow: list.scrollWidth - list.clientWidth };
  }); return JSON.stringify(out); })()`));
  await pg.close();
}
await b.close();
