// 用 page.route 桩掉 /api/org、/api/charter/*，验证：
//  ① 组织页拖拽（拖影出现 → 松手弹待提交行 → 取消隐藏）与键盘路径；
//  ② 岗位书页右栏表单渲染（charter=null 空态 + 422 issues 逐条渲染）；
//  ③ 预算页有数据时的表格渲染。全部不落库 —— POST 也被桩掉。
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

mkdirSync(".workbuddy/ui-shots", { recursive: true });
const BASE = "http://127.0.0.1:9797";
const ORG = {
  graph: {
    nodes: {
      ceo: { role_id: "ceo", can_manage: true, model_family: "gpt", reports_to: null },
      cto: { role_id: "cto", can_manage: true, model_family: "gpt", reports_to: "ceo" },
      dev: { role_id: "dev", can_manage: false, model_family: "gpt", reports_to: "cto" },
    },
    edges: [{ from: "cto", to: "dev", review_gate: true }],
  },
  graph_version: 3,
  change_summary: "probe",
  effective_from: Date.now(),
};
const CHARTER_NULL = { role_id: "dev", charter: null };
const CHARTER_HAS = {
  role_id: "cto",
  charter: {
    role_id: "cto", display_name: "技术总监", version: 2, reports_to: "ceo",
    honesty_boundaries: ["不确定时说不确定"],
    acceptance_criteria: [{ condition: "no_source", action: "reject", message: "无来源打回" }],
    forbidden_actions: ["对外发布"], tool_permissions: ["read_repo"],
    model_tier: "management", budget: { daily_usd: 5, per_task_usd: 1 },
    escalation_triggers: ["涉及资金"],
    decision_scope: { autonomous: ["技术选型"], requires_consultation: ["招人"], forbidden: ["改价"] },
    stance: "保守", // 表单没覆盖的字段，应出现在折叠原文里
  },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.route("**/api/org", (r) => r.fulfill({ json: ORG }));
// 后注册的 route 优先：先通配再特判，否则 charter/* 会盖掉 charter/cto
await page.route("**/api/charter/*", (r) => r.fulfill({ json: CHARTER_NULL }));
await page.route("**/api/charter/cto", (r) => r.fulfill({ json: CHARTER_HAS }));
let lastOrgPost = null;
await page.route("**/api/org", (r) => (r.request().method() === "POST" ? (lastOrgPost = r.request().postDataJSON(), r.fulfill({ json: { ok: true, graph_version: 4 } })) : r.fulfill({ json: ORG })));
// 422 桩：第一次 POST charter 回两条 issues
await page.route("**/api/charter/dev", async (r) => {
  if (r.request().method() === "POST") {
    return r.fulfill({ status: 422, json: { error: "invalid", issues: [{ path: "honesty_boundaries", message: "至少要有一条" }, { path: "acceptance_criteria", message: "由 CEO 本人写，不能为空" }] } });
  }
  return r.fulfill({ json: CHARTER_NULL });
});

async function go(hash, wait = 800) { await page.goto(`${BASE}/?p=${hash}${Date.now()}#${hash}`, { waitUntil: "domcontentloaded" }); await page.waitForSelector("#view *"); await page.waitForTimeout(wait); }

// ① 组织页拖拽：dev → ceo
await go("/org");
const devBox = await page.locator('.orgdrag .node[data-role="dev"]').boundingBox();
const ceoBox = await page.locator('.orgdrag .node[data-role="ceo"]').boundingBox();
await page.mouse.move(devBox.x + 30, devBox.y + 15);
await page.mouse.down();
await page.mouse.move(devBox.x + 60, devBox.y + 40, { steps: 5 });
const ghostSeen = await page.locator(".org-ghost").count();
await page.mouse.move(ceoBox.x + 30, ceoBox.y + 15, { steps: 8 });
const dropOk = await page.locator('.orgdrag .node[data-role="ceo"].dropok').count();
await page.mouse.up();
await page.waitForTimeout(200);
const dragRowVisible = await page.locator("[data-dragrow]:not(.hidden)").count();
const dragText = await page.locator("[data-dragtext]").innerText();
await page.screenshot({ path: ".workbuddy/ui-shots/org-drag.png", fullPage: true });
// 填 summary 提交 → 检查 POST body 形状
await page.fill("[data-drag-summary]", "探针：dev 改直报 ceo");
await page.click("[data-drag-commit]");
await page.waitForTimeout(300);
console.log("ORG drag: ghost=" + ghostSeen, "dropok=" + dropOk, "row=" + dragRowVisible, "| text=" + dragText.replace(/\n/g, " "));
console.log("ORG POST body:", JSON.stringify(lastOrgPost));

// 键盘路径：focus cto，Enter 选中，再 focus dev Enter
await go("/org");
await page.locator('.orgdrag .node[data-role="cto"]').press("Enter");
await page.locator('.orgdrag .node[data-role="dev"]').press("Enter");
await page.waitForTimeout(150);
console.log("ORG keyboard row:", await page.locator("[data-dragrow]:not(.hidden)").count(), await page.locator("[data-dragtext]").innerText());
// 拖到自家子孙 = 回弹提示：dev 拖到 cto 的上级链里 —— dev 是叶子，用 cto→dev（cto 的子孙是 dev）
await go("/org");
const ctoB = await page.locator('.orgdrag .node[data-role="cto"]').boundingBox();
const devB = await page.locator('.orgdrag .node[data-role="dev"]').boundingBox();
await page.mouse.move(ctoB.x + 30, ctoB.y + 15);
await page.mouse.down();
await page.mouse.move(ctoB.x + 60, ctoB.y + 30, { steps: 4 });
await page.mouse.move(devB.x + 30, devB.y + 15, { steps: 8 });
const dropBad = await page.locator(".dropbad").count();
await page.mouse.up();
await page.waitForTimeout(150);
console.log("ORG cycle drop: dropbad=" + dropBad, "rowShown=" + (await page.locator("[data-dragrow]:not(.hidden)").count()), "msg=" + (await page.locator("[data-dragmsg]").innerText()));

// ② 岗位书页
await go("/charter", 1200);
await page.screenshot({ path: ".workbuddy/ui-shots/charter-cto.png", fullPage: true });
const ctoForm = await page.locator("#charter-panel").innerText();
console.log("CHARTER cto banner+fields:", ctoForm.slice(0, 220).replace(/\n/g, " ⏎ "));
// 切到 dev（charter=null 空态）
await page.click('[data-role="dev"]');
await page.waitForTimeout(900);
const devPanel = await page.locator("#charter-panel").innerText();
console.log("CHARTER dev null-state:", devPanel.slice(0, 260).replace(/\n/g, " ⏎ "));
await page.screenshot({ path: ".workbuddy/ui-shots/charter-dev-empty.png", fullPage: true });
// 直接点提交（summary 空）→ 本地拦
await page.click("[data-save]");
await page.waitForTimeout(150);
console.log("CHARTER empty submit:", await page.locator("[data-save-result]").innerText());
// 填 honesty + 空 AC → 422 桩 → 逐条字段级渲染
await page.fill('[data-f="honesty_boundaries"]', "不编数据");
await page.fill('[data-f="change_summary"]', "探针提交");
await page.fill('[data-f="daily_usd"]', "1");
await page.fill('[data-f="per_task_usd"]', "0.5");
await page.click("[data-save]");
await page.waitForTimeout(400);
const errSlots = await page.evaluate(() => [...document.querySelectorAll("[data-err]")].filter((e) => e.textContent.trim()).map((e) => e.getAttribute("data-err") + " => " + e.textContent));
console.log("CHARTER 422 slots:", JSON.stringify(errSlots), "| global:", await page.locator("[data-save-result]").innerText());
await page.screenshot({ path: ".workbuddy/ui-shots/charter-dev-422.png", fullPage: true });

// ③ 预算页：桩一个有数据的 GET
await page.unroute("**/api/org");
await page.route("**/api/budget", async (r) => {
  if (r.request().method() === "POST") return r.fulfill({ json: { ok: true } });
  return r.fulfill({ json: { rows: [
    { scope_type: "role", scope_id: "cto", period: "lifetime", limit_cents: 10000, consumed_cents: 12000, hard_stop: true },
    { scope_type: "role", scope_id: "dev", period: "lifetime", limit_cents: 0, consumed_cents: 300, hard_stop: false },
  ], totals: { limit_cents: 10000, consumed_cents: 12300, unset_scopes: 3 } } });
});
await go("/budget", 900);
console.log("BUDGET:", (await page.locator("#view").innerText()).slice(0, 260).replace(/\n/g, " ⏎ "));
// 琥珀不该出现
const amber = await page.evaluate(() => document.querySelectorAll('[class*="amber"], .need, .statbad').length);
console.log("BUDGET amber nodes:", amber);
await page.screenshot({ path: ".workbuddy/ui-shots/budget-mock.png", fullPage: true });

console.log("TOTAL console errors (last page):", errors.length, errors.join(" | "));
await browser.close();
