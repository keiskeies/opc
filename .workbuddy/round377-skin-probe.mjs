// 表格编辑器外壳换皮验收：暗色下外壳是否真翻深、纸面与格内编辑器是否仍是深墨压白纸。
// 只读探针：不改任何文件，只在浏览器里点。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const b = await chromium.launch();

async function openSheet(theme) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const p = await ctx.newPage();
  await p.goto(`${BASE}/group.html#/documents`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2200);
  const n = await p.locator(".doc-list-item").count();
  for (let i = 0; i < n; i++) {
    await p.locator(".doc-list-item").nth(i).click();
    await p.waitForTimeout(1500);
    if ((await p.locator(".x-spreadsheet").count()) > 0) return { ctx, p };
  }
  await ctx.close();
  throw new Error("文档列表里没有 kind=sheet 的文档");
}

const cs = (p, sel, props) =>
  p.evaluate(
    ([s, ps]) => {
      const el = document.querySelector(s);
      if (!el) return `${s} :: 无实例`;
      const c = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      return `${s} :: ${ps.map((k) => `${k}=${c[k]}`).join(" ")} | ${Math.round(box.width)}x${Math.round(box.height)}`;
    },
    [sel, props],
  );

for (const theme of ["light", "dark"]) {
  console.log(`\n════════ ${theme} ════════`);
  const { ctx, p } = await openSheet(theme);

  console.log("── 外壳 ──");
  for (const [sel, props] of [
    [".x-spreadsheet", ["backgroundColor", "color"]],
    [".x-spreadsheet-toolbar", ["backgroundColor", "borderBottomColor"]],
    [".x-spreadsheet-bottombar", ["backgroundColor", "borderTopColor"]],
    [".x-spreadsheet-menu > li", ["backgroundColor", "color", "borderRightColor"]],
    [".x-spreadsheet-menu > li.active", ["backgroundColor", "color"]],
    [".x-spreadsheet-scrollbar.vertical", ["backgroundColor"]],
    [".x-spreadsheet-scrollbar.vertical > div", ["backgroundColor"]],
    [".x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn", ["backgroundColor"]],
    [".x-spreadsheet-icon .x-spreadsheet-icon-img", ["filter", "opacity"]],
  ]) {
    console.log("  " + (await cs(p, sel, props)));
  }

  // 图标实际压到的底色（工具栏那一枚按钮的可见底）
  console.log(
    "  图标blend = " +
      (await p.evaluate(() => {
        const img = document.querySelector(
          ".x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn .x-spreadsheet-icon-img",
        );
        if (!img) return "无";
        const cs2 = getComputedStyle(img);
        let el = img;
        let bg = "rgba(0, 0, 0, 0)";
        while (el) {
          const v = getComputedStyle(el).backgroundColor;
          if (v !== "rgba(0, 0, 0, 0)") {
            bg = v;
            break;
          }
          el = el.parentElement;
        }
        return `opacity=${cs2.opacity} filter=${cs2.filter} 底=${bg}`;
      })),
  );

  console.log("── 格内编辑器（真点真打字）──");
  const canvas = await p.locator(".sheet-canvas canvas").first().boundingBox();
  if (!canvas) throw new Error("画布没画出来");
  await p.mouse.click(canvas.x + 120, canvas.y + 90);
  await p.waitForTimeout(300);
  await p.keyboard.type("暗色编辑器");
  await p.waitForTimeout(400);
  console.log(
    "  " +
      (await cs(p, ".x-spreadsheet-editor .x-spreadsheet-editor-area textarea", [
        "backgroundColor",
        "color",
        "minHeight",
        "height",
        "width",
        "resize",
        "fontFamily",
      ])),
  );
  await p.screenshot({ path: `.tmp/sheet-${theme}-editing.png` });
  await p.keyboard.press("Escape");

  console.log("── 右键菜单 / 工具栏下拉 ──");
  await p.mouse.click(canvas.x + 120, canvas.y + 90, { button: "right" });
  await p.waitForTimeout(500);
  for (const [sel, props] of [
    [".x-spreadsheet-contextmenu", ["backgroundColor"]],
    [".x-spreadsheet-contextmenu .x-spreadsheet-item", ["backgroundColor", "color"]],
    [".x-spreadsheet-contextmenu .x-spreadsheet-item.divider", ["borderBottomColor"]],
  ]) {
    console.log("  " + (await cs(p, sel, props)));
  }
  const items = await p.evaluate(() =>
    [...document.querySelectorAll(".x-spreadsheet-contextmenu .x-spreadsheet-item")]
      .map((e) => (e.textContent || "").trim())
      .filter(Boolean)
      .join(" | "),
  );
  console.log("  菜单项:", items || "（空）");
  await p.screenshot({ path: `.tmp/sheet-${theme}-ctx.png` });
  await p.keyboard.press("Escape");


  console.log("── 数据验证弹窗（库自己的 modal + form-input + button，append 在 body 上）──");
  await p.mouse.click(canvas.x + 120, canvas.y + 90, { button: "right" });
  await p.waitForTimeout(500);
  const verify = p.locator(".x-spreadsheet-contextmenu .x-spreadsheet-item", { hasText: /数据验证/ }).first();
  if ((await verify.count()) > 0) {
    await verify.click();
    await p.waitForTimeout(800);
    console.log(
      "  出现:",
      await p.evaluate(() =>
        ["x-spreadsheet-modal", "x-spreadsheet-dimmer", "x-spreadsheet-form-input", "x-spreadsheet-button"]
          .map((c) => `${c}=${document.querySelectorAll("." + c).length}`)
          .join(" "),
      ),
    );
    for (const [sel, props] of [
      [".x-spreadsheet-modal", ["backgroundColor", "color", "borderTopColor"]],
      [".x-spreadsheet-modal-header", ["backgroundColor", "borderBottomColor"]],
      [".x-spreadsheet-dimmer", ["backgroundColor"]],
      [".x-spreadsheet-form-input input", ["backgroundColor", "color", "borderTopColor", "height", "minHeight"]],
      [".x-spreadsheet-form-input", ["color"]],
      [".x-spreadsheet-form-select", ["backgroundColor", "color", "borderTopColor", "height", "minHeight"]],
      [".x-spreadsheet-form-field .tip", ["color"]],
      [".x-spreadsheet-button", ["backgroundColor", "color"]],
      [".x-spreadsheet-button.primary", ["backgroundColor", "color"]],
      [".x-spreadsheet-toast", ["backgroundColor", "color"]],
    ]) {
      console.log("  " + (await cs(p, sel, props)));
    }
    console.log(
      "  输入框 tag/type:",
      await p.evaluate(() => {
        const i = document.querySelector(".x-spreadsheet-form-input input");
        return i ? `${i.tagName}[type=${i.getAttribute("type")}]` : "无";
      }),
    );
    await p.screenshot({ path: `.tmp/sheet-${theme}-modal.png` });
  } else {
    console.log("  没找到数据验证项");
  }

  await p.screenshot({ path: `.tmp/sheet-${theme}-full.png` });
  await ctx.close();
}

await b.close();
