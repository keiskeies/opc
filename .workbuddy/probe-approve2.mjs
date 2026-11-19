// 探针 2：批准【琥珀卡（escalation）】那一发到底返回了什么。
// 上一轮点验里 POST /approvals 是 200，但重进收件箱后待批仍是 2、.card.need 还在 ——
// 200 与「卡片被决定掉了」不是一回事，得看响应体。
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(BASE + "/#/inbox", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".card", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(900);

const cards = await page.evaluate(() =>
  [...document.querySelectorAll("#view .card")].map((c) => ({
    need: c.classList.contains("need"),
    flag: c.classList.contains("flag"),
    head: (c.querySelector("strong")?.textContent ?? "").slice(0, 30),
    type: (c.querySelector(".meta")?.textContent ?? "").slice(0, 28),
    hasDecide: !!c.querySelector("[data-decide]"),
  })),
);
console.log("卡片清单：");
for (const c of cards) console.log("  " + JSON.stringify(c));

const need = page.locator(".card.need [data-decide]").first();
if (!(await need.count())) {
  console.log("没有琥珀卡可批");
  await browser.close();
  process.exit(0);
}
const id = await need.getAttribute("data-decide");
await page.selectOption(`[data-act="${id}"]`, "approve");
const respPromise = page.waitForResponse((r) => r.url().includes("/approvals/") && r.request().method() === "POST", { timeout: 8000 });
await need.click();
const r = await respPromise;
console.log("目标卡 " + id);
console.log("请求体 " + (await r.request().postData()));
console.log("HTTP " + r.status() + " 响应体 " + JSON.stringify(await r.json().catch(() => "非 JSON")).slice(0, 400));

await page.goto(BASE + "/#/inbox", { waitUntil: "domcontentloaded" });
await page.waitForSelector(".card", { timeout: 8000 }).catch(() => {});
await page.waitForTimeout(900);
const after = await page.locator("#view").innerText();
console.log("重进后：" + ((after.match(/待批 \d+/) ?? ["没读到"])[0]) + " · .card.need " + (await page.locator(".card.need").count()) + " 张");
await browser.close();
