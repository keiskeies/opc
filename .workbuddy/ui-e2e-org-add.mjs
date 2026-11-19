// 端到端点验：组织页那两张【新增】表单（新增角色 add_node / 加委派边 add_edge）。
// 判成败一律用接口响应码，不读 [data-new-result] / [data-edge-result] ——
// submitOrgChange 成功回调里 500ms 后整页重渲染，那两个节点随之销毁
// （与批准卡、岗位书同一个坑，见 ui-e2e-walk.mjs 的注释）。
// 选择器全部来自 app.js 现读的 DOM 形状（984-1007 / 1229-1266 行）。
import { chromium } from "@playwright/test";

const BASE = "http://127.0.0.1:9797";
// role_id 每次跑都要新：契约里没有删除节点那一档（所以界面也没画删除按钮），
// 同一个 id 第二次提交必然 role_exists。dev 库是一次性演示数据，也可以删库重种，
// 但把 id 带上时间戳更省事 —— 它同时让这一发能连跑两次验「重名该被拒」那条不干扰本轮。
const NEW_ROLE = "e2e_data_" + Date.now().toString(36).slice(-5);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errs = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errs.push("PAGEERROR " + String(e).slice(0, 160)));
const results = [];
const ok = (name, cond, extra = "") => {
  results.push(cond);
  console.log((cond ? "✔ " : "✘ ") + name + (extra ? " —— " + extra : ""));
};
const shot = (n) => page.screenshot({ path: `.workbuddy/ui-shots/org-${n}.png`, fullPage: true });
async function go(r) {
  await page.goto(BASE + "/#/" + r, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#view *", { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(900);
}
const viewText = () => page.locator("#view").innerText();
const vOf = (t) => (t.match(/graph_version (\d+)/) ?? [])[1] ?? "?";
// 两张表单都在【折叠的 <details>】里 —— 不展开就是 display:none，
// fill 会一直「element is not visible」超时（第一版就这么栽的）。
// 每次重新进页都要再展开一次：renderOrg 整页重渲染，details 回到折叠态。
async function openForm(kind) {
  // 用【属性 open】而不是 getAttribute：布尔属性存在时 getAttribute 返回 ""，
  // 而 !"" 为真 ⇒ 会把已经展开的 details 又点回折叠。
  const d = page.locator(`details:has([data-add-${kind}])`);
  if (!(await d.evaluate((n) => n.open))) await d.locator("summary").click();
}
// 监听必须【先挂上】再点：响应先落地就永远等不到（批准卡那一发撞过）。
const orgResp = () =>
  page.waitForResponse((r) => r.url().endsWith("/api/org") && r.request().method() === "POST", { timeout: 9000 });

await go("org");
const v0 = vOf(await viewText());
ok("组织页渲染并读出 graph_version", v0 !== "?", "v" + v0);
await shot("00-before");

// ① add_node：role_id 同时是节点本体与图里的键，家族留空 = 整个不给那个键
await openForm("node");
await page.locator("[data-new-role]").fill(NEW_ROLE);
await page.selectOption("[data-new-parent]", "product_lead");
await page.fill("[data-new-family]", "e2e_family");
await page.fill("[data-new-summary]", "e2e：加一个演示角色");
const r1p = orgResp();
await page.locator("[data-add-node]").click();
const r1 = await r1p;
const b1 = await r1.json().catch(() => ({}));
ok("新增角色提交成功（POST /org add_node）", r1.status() === 200, `HTTP ${r1.status()} v${b1?.graph_version ?? "?"} ` + JSON.stringify(b1?.code ?? b1?.issues ?? b1?.error ?? "").slice(0, 90));
const v1 = String(b1?.graph_version ?? "?");

// ② 新角色真的进了图：重渲染后 DOM 里有那个节点，且版本号真的涨了
await go("org");
const t1 = await viewText();
const v1now = vOf(t1);
ok("新角色出现在组织图里", (await page.locator(`[data-role="${NEW_ROLE}"]`).count()) > 0, `[data-role=${NEW_ROLE}] 命中 ${await page.locator(`[data-role="${NEW_ROLE}"]`).count()} 个`);
ok("add_node 涨了 graph_version", v1now !== v0 && v1now !== "?" && v1now === v1, `v${v0} → v${v1now}（响应报的 v${v1}）`);
await shot("01-added-node");

// ③ add_edge 的【负向】：不勾审阅门控 ⇒ 服务端必须拒（L2 判据，不是前端拦）
//    这一发存在的理由：它证明「判据全在服务端」那句注释是真的 ——
//    前端把 review_gate:false 原样交出去，服务端自己拒。
await openForm("edge");
// 端点必须【显式选】：两个 select 都没标 selected ⇒ 默认都落在第 0 项 ⇒ from===to，
// 前端那句「自己审自己」会提前 return，【一次请求都不发】，
// 而 waitForResponse 会一直等到超时（第一版就是这样，读数看着像服务端没拒）。
await page.selectOption("[data-edge-from]", "product_lead");
await page.selectOption("[data-edge-to]", "qa_engineer");
await page.locator("[data-edge-gate]").uncheck();
await page.fill("[data-edge-summary]", "e2e：故意不勾门控，该被拒");
const r2p = orgResp();
await page.locator("[data-add-edge]").click();
const r2 = await r2p;
const b2 = await r2.json().catch(() => ({}));
ok("无门控的 add_edge 被服务端拒（422）", r2.status() === 422, `HTTP ${r2.status()} code=${b2?.code ?? "?"} ` + JSON.stringify(b2?.issues ?? "").slice(0, 90));
await go("org");
ok("被拒的变更零残留（版本号没涨）", vOf(await viewText()) === v1now, "仍 v" + vOf(await viewText()));

// ④ add_edge 的【正向】：from = 刚加进来的那个角色 ⇒ 顺带证明
//    「图喂回表单」这一环是通的（select 的 options 来自渲染出来的 nodes）
await openForm("edge"); // 上面那次 go("org") 重渲染，details 又收回去了
// options 是 `<option>${k}</option>` 渲染的 —— 【没有 value 属性】，
// 所以 CSS 的 [value="x"] 永远匹不到（Playwright 的 selectOption 走的是
// option.value【属性】，它会退回 text，所以能选中；两种口径不一样）。
const optionValues = (sel) =>
  page.locator(sel).evaluate((n) => [...n.options].map((o) => o.value));
const opts = await optionValues("[data-edge-from]");
ok("新角色进了委派边的可选端点", opts.includes(NEW_ROLE), "端点 " + opts.length + " 个，含新角色=" + opts.includes(NEW_ROLE));
await page.selectOption("[data-edge-from]", NEW_ROLE);
// 审阅端只能选 ceo —— 这不是随手挑的，是被判据唯一放行的形状：
// ① dev 种子的委派边是【0 条】（dev-seed.ts:347 `edges: []`，实测界面显示「0 条」）；
// ② validateNewEdge 那条 escalation_unreachable 判的是 canReach(target, "ceo")，
//    而 canReach 走的是【委派边】不是 reports_to（graph.ts:402 建的邻接表只吃 org.edges）；
// ③ graph.ts 那段剪环论证说了：新边 source→target 不可能帮 target 到达任何地方，
//    所以【没有任何一对 from/to 能靠这一发把路径接通】—— 0 条边的图里
//    只有 target === "ceo"（canReach 的 from===to 那一句）过得了这一判。
// ⇒ 界面那张表单在【刚播种的组织】上只能往 ceo 挂边；要能挂出别的审阅关系，
//   得先有边或让种子带边。这是本轮量到的产品缺口，记在台账里，不改判据。
await page.selectOption("[data-edge-to]", "ceo");
await page.locator("[data-edge-gate]").check();
await page.fill("[data-edge-summary]", "e2e：加一条演示委派边");
const r3p = orgResp();
await page.locator("[data-add-edge]").click();
const r3 = await r3p;
const b3 = await r3.json().catch(() => ({}));
ok("加委派边提交成功（POST /org add_edge）", r3.status() === 200, `HTTP ${r3.status()} v${b3?.graph_version ?? "?"} ` + JSON.stringify(b3?.code ?? b3?.issues ?? b3?.error ?? "").slice(0, 90));
await go("org");
const v2 = vOf(await viewText());
ok("add_edge 涨了 graph_version", v2 !== v1now && v2 !== "?", `v${v1now} → v${v2}`);
await shot("02-added-edge");

console.log("\n控制台错误 " + errs.length + " 条");
for (const e of errs.slice(0, 8)) console.log("  · " + e);
await browser.close();
const failed = results.filter((x) => !x).length;
console.log("\n判定 " + (results.length - failed) + "/" + results.length + " 通过");
process.exit(failed > 0 ? 1 : 0);
