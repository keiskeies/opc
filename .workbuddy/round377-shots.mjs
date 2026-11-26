// 验收四件套之「真实浏览器逐视口 × 明暗截图」。
// 覆盖：1440 / 640 / 390 三档 × 明暗两色 × 十一个面（群聊点进真会话、文档点进富文本编辑器、
// admin 取 today/org/replay 三面——replay 是本轮 D 级改动的现场）。
// 只读静态页（:9797），不写任何业务数据。截图落 .workbuddy/round377-shots/。
import { chromium } from "playwright";

const ROUTES = [
  ["messages", true],
  ["contacts", false],
  ["documents", "doc"],
  ["backlog", false],
  ["talent", false],
  ["settings", false],
  ["admin/today", false],
  ["admin/org", false],
  ["admin/replay", false],
];
const VIEWS = [
  [1440, 900],
  [640, 900],
  [390, 780],
];

const b = await chromium.launch();
let n = 0;
for (const theme of ["light", "dark"]) {
  for (const [w, h] of VIEWS) {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
    const p = await ctx.newPage();
    for (const [route, deep] of ROUTES) {
      await p.goto(`http://127.0.0.1:9797/#/${route}`, { waitUntil: "domcontentloaded" });
      await p.waitForTimeout(1600);
      // ≤640 时 .list-pane 是浮层抽屉（group.css:1382，transform:translateX(-110%)），
      // 列表项在视口外，click 会一直重试到超时 —— 先用抽屉按钮把它滑出来。
      const openDrawer = async () => {
        if (w <= 640 && (await p.locator("#mobileListButton").count())) {
          await p.locator("#mobileListButton").click();
          await p.waitForTimeout(600);
        }
      };
      if (deep === true) {
        await openDrawer();
        const first = p.locator(".conversation-item").first();
        if (await first.count()) {
          await first.click({ timeout: 8000 });
          await p.waitForTimeout(1200);
        }
      }
      if (deep === "doc") {
        await openDrawer();
        const leaf = p.locator("#listContent .doc-list-item").first();
        if (await leaf.count()) {
          await leaf.click({ timeout: 8000 });
          await p.waitForTimeout(1400);
        }
      }
      const name = `.workbuddy/round377-shots/${w}-${theme}-${route.replace("/", "-")}.png`;
      await p.screenshot({ path: name, fullPage: false });
      n += 1;
      // 溢出随截图一起记账：截图只能靠人眼看，这一列数字保证「窄档不许横向溢出」可机检。
      const ox = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      console.log(`${name} 横向溢出=${ox}${ox > 0 ? " ⚠" : ""}`);
    }
    await ctx.close();
  }
}
await b.close();
console.log(`\n共 ${n} 张 ⇒ .workbuddy/round377-shots/`);
