import { chromium } from "playwright";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
await pg.waitForSelector(".conversation-item", { timeout: 15000 });
const o = await pg.evaluate(async () => {
  const api = (await (await fetch("/api/v1/conversations")).json()).conversations;
  const rec = (c) => c.last_message_at || c.created_at;
  const sec = (key, kind) => {
    const dom = [...document.querySelectorAll(`.conversation-section[data-section="${key}"] .conversation-row`)].map((r) => r.dataset.conversationId.slice(0, 8));
    const exp = api.filter((c) => c.kind === kind).sort((a, b) => rec(b) - rec(a)).map((c) => c.conversation_id.slice(0, 8));
    return { key, dom, exp, ok: JSON.stringify(dom) === JSON.stringify(exp) };
  };
  return [sec("group", "group"), sec("private", "private")];
});
console.log(JSON.stringify(o, null, 1));
await b.close();
