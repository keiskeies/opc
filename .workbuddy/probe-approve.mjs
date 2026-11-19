// 探针：批准卡那一发的 [data-res] 文案随时间的变化，以及重进收件箱后的真实待批数。
// 目的：分清「保存/批准真的失败」与「成功回调后界面重渲染，断言读的是被换掉的空节点」。
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", (e) => console.log("PAGEERROR " + String(e).slice(0, 200)));
const resp = [];
page.on("response", (r) => {
  if (r.url().includes("/approvals/")) resp.push(r.request().method() + " " + r.status());
});

async function go(r) {
  await page.goto(BASE + "/#/" + r, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#view *", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}

await go("inbox");
const decide = page.locator("[data-decide]").first();
const id = await decide.getAttribute("data-decide");
console.log("目标卡 " + id);
await page.selectOption(`[data-act="${id}"]`, "approve");
await decide.click();
for (const ms of [150, 400, 800, 1500, 2500]) {
  await page.waitForTimeout(ms === 150 ? 150 : ms - 0);
  const t = await page
    .locator(`[data-res="${id}"]`)
    .innerText()
    .catch((e) => "<元素不在了>");
  const cnt = ((await page.locator("#view").innerText()).match(/待批 \d+/) ?? ["?"])[0];
  console.log(`+${ms}ms res="${t.replace(/\n/g, " ")}" | ${cnt}`);
}
console.log("approvals 响应 " + resp.join(", "));
await go("inbox"); // 全新一次读取（绕开本页的重渲染时序）
const fresh = await page.locator("#view").innerText();
console.log("重进收件箱：" + ((fresh.match(/待批 \d+/) ?? ["没读到"])[0]) + " / 卡片数 " + (await page.locator("[data-decide]").count()));
await browser.close();
