// 变异自证：把暗色换皮那几条规则真抹掉字节，看读数是否跟着退。
// 抹了读数不变 = 那条规则不承重（按落地纪律：先怀疑判据，不是先庆祝）。
// 每发变异跑完立即从内存里的原文恢复，恢复后再量一次确认回到改前值。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";

const CSS = resolve("packages/web/public/group.css");
const ORIGIN = readFileSync(CSS, "utf8");

const MUTANTS = [
  {
    name: "editor-pin: 整条纸墨规则连选择器删掉",
    find: ".x-spreadsheet-editor .x-spreadsheet-editor-area textarea { background: var(--sheet-paper); color: var(--sheet-ink); min-height: 0; resize: none; }\n",
    to: "",
    theme: "dark",
    key: "editor",
  },
  {
    name: "editor-min-height: 只抹 min-height: 0",
    find: "var(--sheet-ink); min-height: 0; resize: none; }",
    to: "var(--sheet-ink); resize: none; }",
    theme: "dark",
    key: "editor",
  },
  {
    name: "toolbar-band: 抹掉工具栏/底栏横带底色",
    find: ".x-spreadsheet-toolbar, .x-spreadsheet-bottombar { background: var(--surface-soft); }",
    to: "",
    theme: "dark",
    key: "toolbar",
  },
  {
    name: "scroll-thumb: 抹掉滚动条拇指两条",
    find: ".x-spreadsheet-scrollbar.horizontal > div, .x-spreadsheet-scrollbar.vertical > div { background: var(--scroll); }",
    to: "",
    theme: "dark",
    key: "thumb",
  },
  {
    name: "icon-invert: 抹掉暗色图标反相",
    find: 'html[data-theme="dark"] .x-spreadsheet-icon .x-spreadsheet-icon-img { filter: invert(1); opacity: .62; }',
    to: "",
    theme: "dark",
    key: "icon",
  },
  {
    name: "tab-paper: 抹掉选中页签的纸底钉（预期存活：库原值也是白，这发钉的是暗色语义）",
    find: ".x-spreadsheet-menu > li.active { background-color: var(--sheet-paper); color: var(--sheet-ink); }",
    to: "",
    theme: "dark",
    key: "tab",
  },
  {
    name: "dark-paper-flipped: 把暗色 --sheet-paper 误翻成深色",
    find: "  --sheet-paper: #ffffff;\n  --sheet-ink: #0a0a0a;\n}",
    to: "  --sheet-paper: #1c2029;\n  --sheet-ink: #0a0a0a;\n}",
    theme: "dark",
    key: "editor",
  },
];

const MEASURE = () => {
  const g = (sel, ...props) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((k) => [k, cs[k]]));
  };
  return {
    theme: document.documentElement.dataset.theme,
    editor: g(
      ".x-spreadsheet-editor .x-spreadsheet-editor-area textarea",
      "backgroundColor",
      "color",
      "minHeight",
    ),
    toolbar: g(".x-spreadsheet-toolbar", "backgroundColor"),
    thumb: g(".x-spreadsheet-scrollbar.vertical > div", "backgroundColor"),
    icon: g(".x-spreadsheet-toolbar .x-spreadsheet-toolbar-btn .x-spreadsheet-icon-img", "filter", "opacity"),
    tab: g(".x-spreadsheet-menu > li.active", "backgroundColor", "color"),
  };
};

async function measure(theme) {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => localStorage.setItem("opc:theme", t), theme);
  const p = await ctx.newPage();
  await p.goto("http://127.0.0.1:9797/group.html#/documents", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2200);
  const n = await p.locator(".doc-list-item").count();
  let found = false;
  for (let i = 0; i < n && !found; i++) {
    await p.locator(".doc-list-item").nth(i).click();
    await p.waitForTimeout(1500);
    found = (await p.locator(".x-spreadsheet").count()) > 0;
  }
  if (!found) {
    await b.close();
    throw new Error("没有表格文档");
  }
  const out = await p.evaluate(MEASURE);
  await b.close();
  return out;
}

function patch(find, to) {
  const hits = ORIGIN.split(find).length - 1;
  if (hits !== 1) throw new Error(`锚点出现 ${hits} 次（要恰好 1 次）：${find.slice(0, 60)}`);
  writeFileSync(CSS, ORIGIN.replace(find, to), "utf8");
}
const restore = () => writeFileSync(CSS, ORIGIN, "utf8");
const stillThere = (needle) => {
  try {
    return execFileSync("grep", ["-c", "-F", needle, CSS], { encoding: "utf8" }).trim();
  } catch {
    return "0";
  }
};

const base = {};
for (const t of ["light", "dark"]) base[t] = await measure(t);
console.log("基线 dark :", JSON.stringify(base.dark));
console.log("基线 light:", JSON.stringify(base.light));

for (const m of MUTANTS) {
  patch(m.find, m.to);
  const gone = m.to === "" ? `抹后 grep=${stillThere(m.find)}` : "改写";
  const now = await measure(m.theme);
  restore();
  const back = await measure(m.theme);
  const before = base[m.theme][m.key];
  const moved = JSON.stringify(before) !== JSON.stringify(now[m.key]);
  const restored = JSON.stringify(back[m.key]) === JSON.stringify(before);
  console.log(
    `\n${m.name}\n  ${gone} · 读数 ${JSON.stringify(now[m.key])} · 基线 ${JSON.stringify(before)}` +
      `\n  ${moved ? "读数变了" : "读数没变（不承重，需说明或删规则）"} · 复原=${restored ? "是" : "否"}`,
  );
}
console.log("\n文件已逐字节复原:", readFileSync(CSS, "utf8") === ORIGIN ? "是" : "否");

// 反向一整发：把整个 vendored 覆盖块删掉，量【浅色】。浅色下所有读数应当一个都不变 ——
// 这才是「浅色零回归」的正面证据（不是「我没看浅色截图」）。
{
  const start = ORIGIN.indexOf("/* ── vendored 表格（x-data-spreadsheet）的外壳换皮");
  const endMarker = "纸外的值全部归 token —— 这条边界两端各有实据，不是一句「以后再说」。 */\n";
  const end = ORIGIN.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error("找不到 vendored 覆盖块的边界，这一发没法做");
  const block = ORIGIN.slice(start, end + endMarker.length);
  writeFileSync(CSS, ORIGIN.replace(block, ""), "utf8");
  console.log(`\n整块删除（${block.split("\n").length} 行）· 抹后 grep=${stillThere(".x-spreadsheet-toolbar, .x-spreadsheet-bottombar { background: var(--surface-soft); }")}`);
  const dark = await measure("dark");
  const light = await measure("light");
  restore();
  const diffs = [];
  for (const k of Object.keys(base.light)) {
    if (JSON.stringify(base.light[k]) !== JSON.stringify(light[k])) {
      diffs.push(`  浅色 ${k}: 有块 ${JSON.stringify(base.light[k])} → 无块 ${JSON.stringify(light[k])}`);
    }
  }
  console.log(diffs.length ? `浅色回归 ${diffs.length} 处：\n${diffs.join("\n")}` : "浅色：删掉整块后所有读数一字未变 ⇒ 这一整段只影响暗色");
  const moved = Object.keys(base.dark).filter((k) => JSON.stringify(base.dark[k]) !== JSON.stringify(dark[k]));
  console.log(`暗色：删块后有 ${moved.length}/${Object.keys(base.dark).length} 项读数变化（${moved.join(", ")}）`);
  console.log("文件已逐字节复原:", readFileSync(CSS, "utf8") === ORIGIN ? "是" : "否");
}

