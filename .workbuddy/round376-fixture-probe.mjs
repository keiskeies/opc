import { chromium } from "playwright";
const conversations = [
  { conversation_id: "aa-oldest", kind: "group", title: "最早的一群", unread_count: 0, boss_attention_count: 0, last_message_at: 1795000100000, last_message_preview: "第一条消息" },
  { conversation_id: "bb-created-fallback", kind: "group", title: "还没有消息的群", unread_count: 0, boss_attention_count: 0, last_message_at: null, created_at: 1795000900000, last_message_preview: "" },
  { conversation_id: "mm-middle", kind: "group", title: "中间的一群", unread_count: 0, boss_attention_count: 0, last_message_at: 1795000800000, last_message_preview: "第二条消息" },
  { conversation_id: "zz-newest", kind: "group", title: "最新的一群", unread_count: 0, boss_attention_count: 0, last_message_at: 1795001000000, last_message_preview: "第三条消息" },
];
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
pg.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300)));
pg.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text().slice(0, 200)); });
await pg.route("**/api/v1/conversations", (r) => r.request().method() === "GET" ? r.fulfill({ json: { conversations } }) : r.continue());
await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(2500);
const dom = await pg.evaluate(() => ({
  sections: [...document.querySelectorAll(".conversation-section")].map((s) => ({ k: s.dataset.section, n: s.querySelectorAll(".conversation-item").length })),
  titles: [...document.querySelectorAll(".conversation-title")].map((t) => t.textContent.trim()),
  connection: document.querySelector(".connection")?.textContent?.trim(),
}));
console.log(JSON.stringify(dom, null, 1));
await b.close();
