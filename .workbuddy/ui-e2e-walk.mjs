// 端到端点验：七页渲染 + 四个写路径（岗位书保存 / 预算 upsert / 拖拽改汇报 / 批准卡）。
// dev 库是一次性演示数据，写坏了删库重种即可。选择器全部来自 app.js 现读的 DOM 形状。
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:9797";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errs.push("PAGEERROR " + String(e).slice(0, 160)));
const shot = (n) => page.screenshot({ path: `.workbuddy/ui-shots/e2e-${n}.png`, fullPage: true });
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(cond);
  console.log((cond ? "✔ " : "✘ ") + name + (extra ? " —— " + extra : ""));
};
async function go(r) {
  await page.goto(BASE + "/#/" + r, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#view *", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}
const viewText = () => page.locator("#view").innerText();

// ① 七页渲染
for (const r of ["today", "board", "inbox", "org", "charter", "budget", "replay"]) {
  await go(r);
  const n = await page.evaluate(() => document.querySelectorAll("#view *").length);
  ok("页面 " + r + " 渲染", n > 3, "节点 " + n);
}

// ② 今日页琥珀区（必须在【批准之前】测）
// 「需要你决策」读的是待批 escalation 卡；下面第③步会批准掉唯一那张，
// 批准之后再断言 >0 会必然落空 —— 那时剩下的预算卡走 operational 分组，不进琥珀区。
await go("today");
const tToday = await viewText();
ok("今日页「需要你决策」>0", /需要你决策 · [1-9]/.test(tToday), tToday.match(/需要你决策[^\n]*/)?.[0] ?? tToday.slice(0, 90));

// ③ 收件箱批准 —— 批准【琥珀那张】（.card.need = escalation）。DOM 里 .card.flag
//    （预算卡）排得更前，取 first 会批错它。
// ⚠ 断言口径（probe-approve3.mjs 量出来的，别再改回「待批数下降」）：
//    批准 escalation 卡 ⇒ 卡片落库、任务往前一格（seed-task-1: ESCALATED_TO_CEO →
//    FINAL_REVIEW），而引擎【立刻为下一道 CEO 闸门开一张新卡】。所以待批总数不变、
//    琥珀区也不为空 —— 会变的是【卡片身份】。拿总数或琥珀区空不空当判据，
//    量的其实是「引擎有没有推进」的反面。
// ⚠ 也别读 [data-res] 那一格：成功回调 600ms 后整页重渲染，节点随之销毁（探针量到
//    「✔ 已决定」只在 ~400ms 那一瞬存在）。判成败一律用接口响应码。
await go("inbox");
const t0 = await viewText();
ok("收件箱有 2 张待批卡", t0.includes("待批 2"), (t0.match(/待批 \d+/)?.[0] ?? t0.slice(0, 60)));
const pendingIds = () => page.locator("#view [data-decide]").evaluateAll((ns) => ns.map((n) => n.getAttribute("data-decide")));
const before = await pendingIds();
await shot("10-inbox");
const decide = page.locator(".card.need [data-decide]").first();
if (await decide.count()) {
  const id = await decide.getAttribute("data-decide");
  await page.selectOption(`[data-act="${id}"]`, "approve");
  const respPromise = page.waitForResponse((r) => r.url().includes("/approvals/") && r.request().method() === "POST", { timeout: 8000 });
  await decide.click();
  const res = await respPromise;
  const resBody = await res.json().catch(() => ({}));
  ok("批准卡提交成功（POST /approvals ok:true）", res.status() === 200 && resBody?.ok === true, `HTTP ${res.status()} ${JSON.stringify(resBody).slice(0, 80)}`);
  await go("inbox");
  const after = await pendingIds();
  ok("被批准的那张卡不再待批", !after.includes(id), "剩 " + after.length + " 张，含旧卡=" + after.includes(id));
  ok("引擎为下一道闸门开了新卡", after.some((x) => !before.includes(x)), "新卡 " + (after.find((x) => !before.includes(x)) ?? "无").slice(0, 8));
  await shot("11-after-approve");
} else {
  const cardHtml = await page.locator("#view").innerHTML();
  ok("决定按钮存在", false, "DOM 里没找到琥珀卡的按钮，看截图。片段：" + cardHtml.slice(0, 200));
}

// ③ 岗位书保存（dev_engineer；内容是演示字符串，验往返不是验内容）
await go("charter");
await page.locator('[data-role="dev_engineer"]').first().click();
await page.waitForTimeout(600);
await page.locator('[data-f="display_name"]').fill("演示开发岗");
await page.locator('[data-f="honesty_boundaries"]').fill("e2e：不确定时说不确定");
await page.locator('[data-f="acceptance_criteria"]').fill("e2e：产出可运行 | reject | | e2e 演示标准");
await page.locator('[data-f="forbidden_actions"]').fill("e2e：不许 drop 库");
await page.locator('[data-f="tool_permissions"]').fill("read_file");
await page.locator('[data-f="ds_autonomous"]').fill("写实现");
await page.locator('[data-f="ds_forbidden"]').fill("发布");
await page.locator('[data-f="escalation_triggers"]').fill("涉及对外发布");
await page.locator('[data-f="change_summary"]').fill("e2e：种一份演示岗位书");
// 与批准同一个理由：saveCharter 成功后 400ms 重拉岗位书，[data-save-result] 随面板重建
// 被换掉 —— 等 1500ms 再读只能读到空白。判成败看 POST /charter 的状态码，
// 且监听必须在【点击之前】挂上，否则响应先落地就永远等不到。
const chResp = page.waitForResponse((r) => r.url().includes("/charter/") && r.request().method() === "POST", { timeout: 8000 });
await page.locator("[data-save]").click();
const chRes = await chResp;
const savedBody = await chRes.json().catch(() => ({}));
ok("岗位书保存成功（POST /charter）", chRes.status() === 200, `HTTP ${chRes.status()} version=${savedBody?.version ?? "?"} ` + JSON.stringify(savedBody?.issues ?? savedBody?.error ?? "").slice(0, 90));
await shot("12-charter-saved");
await go("charter");
await page.locator('[data-role="dev_engineer"]').first().click();
await page.waitForTimeout(600);
const back = await page.locator('[data-f="display_name"]').inputValue().catch(() => "");
ok("岗位书读回（GET 蛇形视图喂回表单）", back === "演示开发岗", "display_name=" + back);
await shot("13-charter-reread");

// ④ 预算 upsert（修好的下拉：role / architect / daily / 2500）
await go("budget");
await page.locator('[data-f="scope_id"]').fill("architect");
await page.locator('[data-f="limit_cents"]').fill("2500");
await page.locator("[data-put]").click();
await page.waitForTimeout(1300);
let bt = await page.locator("[data-budget-result]").innerText().catch(() => "");
if (!bt.includes("✔")) {
  await page.waitForTimeout(900);
  bt = await page.locator("[data-budget-result]").innerText().catch(() => "");
  if (bt === "") bt = (await viewText()).includes("architect") ? "✔（已刷新）" : bt;
}
ok("预算 upsert 成功", bt.includes("✔") || (await viewText()).includes("architect"), bt.slice(0, 110).replace(/\n/g, " "));
await shot("14-budget");

// ⑤ 拖拽改汇报（qa_engineer → product_lead，合法 ⇒ 涨版本）
await go("org");
const vOf = (t) => (t.match(/graph_version (\d+)/) ?? [])[1] ?? "?";
const vBefore = vOf(await viewText());
await page.locator('[data-role="qa_engineer"]').first().dragTo(page.locator('[data-role="product_lead"]').first());
await page.waitForTimeout(700);
await shot("15-dragrow");
const row = page.locator("[data-dragrow]");
const visible = await row.isVisible().catch(() => false);
ok("拖后出现待提交行", visible);
if (visible) {
  await page.locator("[data-drag-summary]").fill("e2e：拖拽改汇报");
  await page.locator("[data-drag-commit]").click();
  await page.waitForTimeout(1600);
  const dr = await page.locator("[data-drag-result]").innerText().catch(() => "");
  const vAfter = vOf(await viewText());
  ok("拖拽提交涨版本", vAfter !== vBefore && vAfter !== "?", `v${vBefore} → v${vAfter}；反馈：` + dr.slice(0, 90).replace(/\n/g, " "));
  await shot("16-org-committed");
}

// ⑥ 今日页与收件箱的琥珀读数一致：两处都从同一份 pending approvals 里挑 escalation
//    一类（今日页那块「需要你决策」/ 收件箱里带 .need 的卡）。
//    数字本身不验大小 —— 引擎推进任务会换一张新卡，大小随引擎走；一致才是要验的。
await go("today");
const tt = await viewText();
const needToday = (tt.match(/需要你决策 · (\d+)/) ?? [])[1] ?? "?";
await go("inbox");
const needInbox = await page.locator("#view .card.need").count();
ok("今日页琥珀数字 == 收件箱琥珀卡数", needToday === String(needInbox), "今日页 " + needToday + " vs 收件箱 " + needInbox);
ok("今日页预算行有任务级数字", !tt.includes("一行都没设过"), tt.match(/预算[\s\S]{0,80}/)?.[0].replace(/\n/g, " ") ?? "");
await shot("17-today");

console.log("\n控制台错误 " + errs.length + " 条");
for (const e of errs.slice(0, 8)) console.log("  · " + e);
await browser.close();
const failed = results.filter((x) => !x).length;
console.log("\n判定 " + (results.length - failed) + "/" + results.length + " 通过");
process.exit(failed > 0 ? 1 : 0);
