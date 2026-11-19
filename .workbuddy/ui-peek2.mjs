// 真实视口截图巡检：遍历七个 hash 路由，每页截图 + 打 #view 前 300 字 + 控制台错误数。
// ⚠ 不能用 networkidle（SSE 长连接永不 idle），用 domcontentloaded + waitForSelector。
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync(".workbuddy/ui-shots", { recursive: true });
const BASE = "http://127.0.0.1:9797";
const routes = ["today", "board", "inbox", "org", "charter", "budget", "replay"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
let consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

for (const r of routes) {
  consoleErrors = [];
  // ?r= 每次变 ⇒ 完整导航（同 URL 只换 hash 时 Playwright 不会 reload，会读到上一页残留）
  await page.goto(`${BASE}/?r=${r}#/${r}`, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector("#view *", { timeout: 8000 });
  } catch {
    console.log(`### #/${r} —— #view 8 秒内没有任何内容`);
  }
  await page.waitForTimeout(1500); // 给懒加载的 api 一轮时间
  const text = await page.evaluate(() => document.getElementById("view")?.innerText ?? "(#view 不存在)");
  await page.screenshot({ path: `.workbuddy/ui-shots/${r}.png`, fullPage: true });
  console.log(`### #/${r}`);
  console.log(text.slice(0, 300).replace(/\n/g, " ⏎ "));
  console.log(`console errors: ${consoleErrors.length}` + (consoleErrors.length ? " → " + consoleErrors.join(" | ") : ""));
  console.log("");
}
await browser.close();
