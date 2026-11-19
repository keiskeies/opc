// 探针 3：批准 escalation 卡之后，剩下的琥珀卡是【同一张没落库】还是【任务推进后新开的下一道闸门】。
// 这两种情况的结论完全相反（真 bug vs 断言写错），只能靠卡片身份分辨：
// 同一 id ⇒ 没落库；不同 id 且 created_at 更晚 ⇒ 引擎推进任务后又开了一张新卡（设计如此）。
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

async function inbox() {
  await page.goto(BASE + "/#/inbox", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".card", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
  return page.evaluate(() =>
    [...document.querySelectorAll("#view .card")]
      .filter((c) => c.querySelector("[data-decide]"))
      .map((c) => ({
        id: c.querySelector("[data-decide]").getAttribute("data-decide"),
        need: c.classList.contains("need"),
        head: (c.querySelector("strong")?.textContent ?? "").slice(0, 26),
        meta: (c.querySelector(".meta")?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
      })),
  );
}

await page.goto(BASE + "/#/today", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#view *").catch(() => {});
const before = await inbox();
console.log("批准前 " + before.length + " 张：");
for (const c of before) console.log("  " + JSON.stringify(c));

const need = page.locator(".card.need [data-decide]").first();
const id = await need.getAttribute("data-decide");
await page.selectOption(`[data-act="${id}"]`, "approve");
const rp = page.waitForResponse((r) => r.url().includes("/approvals/") && r.request().method() === "POST", { timeout: 8000 });
await need.click();
console.log("批准 " + id + " → HTTP " + (await rp).status());

// 分三个时刻读，看新卡是不是异步出现的（泵/引擎推进）
for (const waitMs of [400, 3000, 6000]) {
  await page.waitForTimeout(waitMs);
  const now = await inbox();
  console.log(`\n批准后累计等 ${waitMs}ms ⇒ ${now.length} 张待批：`);
  for (const c of now) console.log("  " + JSON.stringify(c) + (c.id === id ? "   ← 与被批准的是同一张" : ""));
}

const tasks = await page.evaluate(async () => {
  const r = await fetch("/api/tasks");
  const j = await r.json();
  return (j.tasks ?? []).map((t) => t.id + " " + t.status);
});
console.log("\n任务状态：" + tasks.join(" | "));
await browser.close();
