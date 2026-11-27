import { chromium } from "playwright";

const origin = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on("console", (msg) => logs.push(`CONSOLE:${msg.type()}:${msg.text()}`));
page.on("pageerror", (err) => logs.push(`PAGEERROR:${String(err)}`));
await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const info = await page.evaluate(
  `(() => ({
    hash: location.hash,
    listTitle: (document.querySelector("#listTitle") || {}).textContent,
    toolbarChildren: document.querySelectorAll("#listToolbar > *").length,
    inputs: [...document.querySelectorAll("#listToolbar input")].map((i) => i.id || i.name),
    contentChildren: document.querySelectorAll("#listContent > *").length,
    bodyStart: document.body.textContent.slice(0, 300),
  }))()`,
);
console.log(JSON.stringify(info, null, 2));
console.log(logs.slice(0, 12).join("\n"));
await browser.close();
