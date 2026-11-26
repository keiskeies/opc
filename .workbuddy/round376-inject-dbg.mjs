import { chromium } from "playwright";
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1440, height: 900 } });
await pg.addInitScript(() => {
  window.__dbg = [];
  const tryIt = () => {
    try {
      const s = document.createElement("style");
      s.textContent = ":root{--list-width:340px}";
      (document.head || document.documentElement).append(s);
      window.__dbg.push(`ok parent=${s.parentElement?.tagName}`);
    } catch (e) { window.__dbg.push(`err ${e.message}`); }
  };
  tryIt();
  document.addEventListener("DOMContentLoaded", tryIt);
});
await pg.goto("http://127.0.0.1:9797/#/messages", { waitUntil: "domcontentloaded" });
await pg.waitForSelector(".conversation-item", { timeout: 15000 });
console.log(await pg.evaluate(() => ({
  dbg: window.__dbg,
  listW: getComputedStyle(document.documentElement).getPropertyValue("--list-width").trim(),
  styles: document.querySelectorAll("style").length,
  links: [...document.querySelectorAll("link[rel=stylesheet]")].map(l => l.getAttribute("href")),
  panel: document.querySelector(".conversation-list") === null ? "no .conversation-list" : "yes",
  panels: [...document.querySelectorAll("aside,nav,section")].slice(0,8).map(e => e.className),
})));
await b.close();
