import { chromium } from "playwright";
const b = await chromium.launch();
const p = await b.newPage();
await p.setContent("<h1 id=x>ok</h1>");
const t = await p.locator("#x").textContent();
console.log("LAUNCH_OK version=" + b.version() + " text=" + t);
await b.close();
