// round379 P5 收尾：`min-width:0` 到底是死声明还是只有窄屏才承重？
// 上一发只量了 1440 的并排（row）：auto 与 0 都是 492/492。但 group.css:1498 在窄屏把
// 分栏折成 column —— 那时 min-width 落在【交叉轴】，自动最小尺寸只管主轴，所以理论上更不承重。
// 这一发把「窄屏折叠 + 长行代码」两种最坏形状都量一遍：真实页面上临时改 style 判，不动源字节。
import { chromium } from "playwright";

const BASE = "http://127.0.0.1:9797";

const b = await chromium.launch();

// 一段会把栏撑宽的长内容：单行不换行的代码 + 一张宽表格。
const LONG = [
  "# 撑宽测试",
  "",
  "```",
  "const x = " + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".repeat(4),
  "```",
  "",
  "| 列一 | 列二 | 列三 | 列四 | 列五 | 列六 | 列七 | 列八 |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| " + "很长很长很长的单元格内容 ".repeat(3) + " | 数据 | 数据 | 数据 | 数据 | 数据 | 数据 | 数据 |",
].join("\n");

const MEASURE = `(() => {
  const host = document.querySelector('.editor-panes');
  if (!host) return { error: 'no .editor-panes' };
  const kids = [...host.children].filter((el) => {
    const cs = getComputedStyle(el);
    return cs.display !== 'none';
  });
  const dir = getComputedStyle(host).flexDirection;
  const boxes = kids.map((el) => {
    const r = el.getBoundingClientRect();
    return { cls: (el.className || '').toString().split(/\\s+/)[0], w: +r.width.toFixed(1), h: +r.height.toFixed(1), over: el.scrollWidth - el.clientWidth };
  });
  const owner = host.querySelector('.markdown-editor textarea');
  return {
    mode: host.dataset.mode,
    dir,
    hostW: +host.getBoundingClientRect().width.toFixed(1),
    hostScrollW: host.scrollWidth,
    boxes,
    docWidth: document.documentElement.scrollWidth,
    viewportW: window.innerWidth,
    hasText: owner ? owner.value.length : null,
  };
})();`;

const setMinWidth = (v) => `(() => {
  const host = document.querySelector('.editor-panes');
  for (const el of [...host.children]) {
    if (${JSON.stringify(v)} === null) el.style.removeProperty('min-width');
    else el.style.minWidth = ${JSON.stringify(v)};
  }
  return 'ok';
})();`;

for (const vp of [
  { w: 1440, h: 900 },
  { w: 1000, h: 800 },
  { w: 700, h: 800 },
  { w: 620, h: 800 },
]) {
  const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h } });
  await ctx.addInitScript(() => localStorage.setItem("opc:theme", "dark"));
  const p = await ctx.newPage();
  await p.goto(`${BASE}/#/documents`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(1300);
  // 找一篇 markdown
  const n = await p.locator("#listContent .doc-list-item").count();
  let ok = false;
  for (let i = 0; i < n; i++) {
    await p.locator("#listContent .doc-list-item").nth(i).click({ force: true });
    await p.waitForTimeout(1100);
    const sub = (await p.locator(".doc-sub").first().textContent().catch(() => "")) ?? "";
    if (sub.includes("Markdown")) {
      ok = true;
      break;
    }
  }
  if (!ok) {
    console.log(`\n${vp.w}px: 没有 markdown 文档，跳过`);
    await ctx.close();
    continue;
  }
  // 不输入正文（autosave 会写进共享库）。只在内存里给预览灌一段宽内容，判折叠态会不会被撑破。
  await p.getByRole("group", { name: "正文视图" }).getByRole("button", { name: "分栏", exact: true }).click();
  await p.waitForTimeout(500);
  const inject = `(async () => {
    const prev = document.querySelector('.markdown-preview');
    const code = document.createElement('pre');
    code.textContent = ${JSON.stringify("const x = " + "b".repeat(400))};
    prev.appendChild(code);
    const table = document.createElement('table');
    const row = document.createElement('tr');
    for (let i = 0; i < 8; i++) {
      const td = document.createElement('td');
      td.textContent = '单元格';
      row.appendChild(td);
    }
    table.appendChild(row);
    prev.appendChild(table);
    return 'injected';
  })()`;
  await p.evaluate(inject);
  await p.waitForTimeout(300);
  for (const v of [null, "auto"]) {
    await p.evaluate(setMinWidth(v));
    await p.waitForTimeout(200);
    const m = await p.evaluate(MEASURE);
    console.log(
      `\n${vp.w}px min-width=${v === null ? "(原始 0px)" : v}  mode=${m.mode} dir=${m.dir}`,
    );
    console.log(
      `  容器 ${m.hostW} (scrollW ${m.hostScrollW}) 文档宽 ${m.docWidth}/${m.viewportW}  ` +
        m.boxes.map((x) => `${x.cls} w=${x.w} 溢出${x.over}`).join(" | "),
    );
  }
  await ctx.close();
}

await b.close();
console.log("\nFFFD_COUNT 0");
