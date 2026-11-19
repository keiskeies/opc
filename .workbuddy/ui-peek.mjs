// 用真实视口看五页今天长什么样（应用内浏览器是 0x0 视口，看不到自适应布局）。
// 只读验证：不写库、不点批准。
import { chromium } from "@playwright/test";

const BASE = process.env.UI_BASE ?? "http://127.0.0.1:9797";
const ROUTES = ["today", "board", "inbox", "org", "replay"];
const OUT = ".workbuddy/ui-shots";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => consoleErrors.push("PAGEERROR " + String(e).slice(0, 200)));

// ⚠ 不能用 networkidle：这一页挂着 SSE 长连接（/api/events），流永远不 idle，
// goto 会一直等到超时。按「视图容器出现内容」等，不看网络。
for (const r of ROUTES) {
  await page.goto(BASE + "/#/" + r, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#view *", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const info = await page.evaluate(() => ({
    w: window.innerWidth,
    h: window.innerHeight,
    text: (document.getElementById("view")?.innerText ?? "").slice(0, 600),
    nodes: document.querySelectorAll("#view *").length,
    conn: document.getElementById("connText")?.innerText ?? "",
  }));
  console.log(
    "\n══════ " + r + " ══════ viewport " + info.w + "x" + info.h +
      " · #view 节点 " + info.nodes + " · " + info.conn,
  );
  console.log(info.text.replace(/\n{2,}/g, "\n"));
  await page.screenshot({ path: OUT + "/" + r + ".png", fullPage: true });
}
await browser.close();
console.log("\n控制台错误 " + consoleErrors.length + " 条：");
for (const e of consoleErrors.slice(0, 10)) console.log("  · " + e);
