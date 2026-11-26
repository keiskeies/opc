// 变异自证：往真文件 group.css 里塞回裸档 gap，看 space-scale 守卫会不会红。
// 这条守卫有三道可能「坏成常绿」的地方 —— 洗注释洗过头、选择器回溯对不上号、
// 多值只查第一半 —— 每种各做一发。抹完立刻按字节复原，复原后再跑一遍确认回到绿。
// 判读口径：期望「红的发」必须真红；期望「绿」的发不能红（否则名单双向那发是假绿）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const CSS = resolve("packages/web/public/group.css");
const ORIGIN = readFileSync(CSS, "utf8");
const TEST = "test/web/space-scale.test.ts";

const MUTANTS = [
  {
    name: "裸档长回来：.topbar 的 gap 从 var(--space-3) 改回 14px",
    find: ".topbar { height: 64px; display: flex; align-items: center; gap: var(--space-3);",
    to: ".topbar { height: 64px; display: flex; align-items: center; gap: 14px;",
    expect: "red",
  },
  {
    name: "藏在第二半：gap: var(--space-2) 9px（只查第一半的提取器会放过）",
    find: ".profile-wrap { display: flex; align-items: center; gap: var(--space-2); }",
    to: ".profile-wrap { display: flex; align-items: center; gap: var(--space-2) 9px; }",
    expect: "red",
  },
  {
    name: "藏在 @media 嵌套块里：.rich-editor-toolbar 的 3px 改成 13px（豁免值被偷偷抬高）",
    find: ".rich-editor-toolbar { padding: 8px; gap: 3px; }",
    to: ".rich-editor-toolbar { padding: 8px; gap: 13px; }",
    expect: "red",
  },
  {
    name: "注释伪装：在注释里写 gap: 7px（洗注释洗过头会把假值当真值，也会把真值当假值）",
    find: "  --gap-tool-cluster: var(--space-1);",
    to: "  --gap-tool-cluster: var(--space-1);\n  /* 这里只是解释为什么不用 gap: 7px 这种散档。 */",
    expect: "green",
  },
  {
    name: "刻度本体被改成散数：--space-2 从 8px 写成 9px",
    find: "  --space-2: 8px;",
    to: "  --space-2: 9px;",
    expect: "red",
  },
  {
    name: "别名脱离刻度：--gap-control 不再指回 var(--space-*)",
    find: "  --gap-control: var(--space-2);",
    to: "  --gap-control: 7px;",
    expect: "red",
  },
];

/**
 * 跑守卫，返回 green/red。
 * ⚠ 这里不能用 execFileSync("npx", …)：Windows 上 npx 是 .cmd，Node 的 spawn 不套 shell，
 * 直接 ENOENT —— 第一版就是这么「6 发全红」，而全红【不是】守卫抓得准，是压根没跑起来。
 * 「期望红」的那几发在这种坏法下也会报红，所以必须另加一发【期望绿】的对照（注释伪装）：
 * 它一红就说明判据坏了，而不是说明代码有问题。
 * 现在用 process.execPath 直接跑 vitest 的 JS 入口，绕开 .cmd。
 */
const VITEST = resolve("node_modules/vitest/vitest.mjs");
function run() {
  try {
    execFileSync(process.execPath, [VITEST, "run", TEST], { encoding: "utf8", stdio: "pipe" });
    return "green";
  } catch {
    return "red";
  }
}

// 空跑一发自检：连一份没动的代码都跑不绿，就没必要往下谈变异了。
if (run() !== "green") {
  writeFileSync(CSS, ORIGIN, "utf8");
  throw new Error("未改动时守卫就不绿（或跑不起来），这一发的判据本身是坏的");
}
console.log("自检：未改动时守卫 = green\n");

let bad = 0;
for (const m of MUTANTS) {
  const hits = ORIGIN.split(m.find).length - 1;
  if (hits !== 1) throw new Error(`锚点出现 ${hits} 次（要恰好 1 次）：${m.find.slice(0, 50)}`);
  writeFileSync(CSS, ORIGIN.replace(m.find, m.to), "utf8");
  const got = run();
  writeFileSync(CSS, ORIGIN, "utf8");
  const back = run();
  const ok = got === m.expect && back === "green";
  if (!ok) bad += 1;
  console.log(`${ok ? "✓" : "✗"} ${m.name}\n    抹后=${got}（期望 ${m.expect}） · 复原后=${back}`);
}
console.log(`\n文件已逐字节复原: ${readFileSync(CSS, "utf8") === ORIGIN ? "是" : "否"}`);
console.log(`判定: ${bad === 0 ? `${MUTANTS.length}/${MUTANTS.length} 发全部符合预期` : `${bad} 发不符合预期`}`);
process.exit(bad === 0 && readFileSync(CSS, "utf8") === ORIGIN ? 0 : 1);
