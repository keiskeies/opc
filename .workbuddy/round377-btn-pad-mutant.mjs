// round377 窄档按钮内距判据的变异自证。
// 每条变异必须【真抹字节】、跑完逐字节复原，而且事先证明未改动时判据是绿的
// （否则「变异后红」可能只是这条测试压根跑不起来）。
// 两条各打一头断言，缺一头都说明判据只考了半件事：
//  ① 把整排退回只压 primary ⇒ 「同排同档」必须红；
//  ② 整条媒体规则删掉 ⇒ 「窄档必须严格小于桌面」必须红。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CSS = "packages/web/public/group.css";
const TEST = "test/e2e/group-workbench.spec.ts";
// -g 的参数按【正则】解释：标题里的圆括号不转义就变成捕获组，实际匹配的是
// 「窄档≤640 …」这条不存在的标题 ⇒ 0 条被选中，playwright 以非零退出，
// 于是「未改动就红」。第一版就败在这里，看着像判据坏了，其实是选择器没选上。
const TITLE = "窄档\\(≤640\\) 一排按钮的横向内距同档且确实比桌面窄";
const RULE = "  .btn { padding: 6px 9px; }";

const original = readFileSync(CSS, "utf8");
if (original.split(RULE).length !== 2) {
  throw new Error(`锚点不唯一（出现 ${original.split(RULE).length - 1} 次），变异会打到别处`);
}

function runOne() {
  // 只看退出码会把「一条都没选中」当成红。所以把 stdout 也拿住，先确认恰好跑了 1 条。
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", TEST, "-g", TITLE], {
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    code = 1;
  }
  if (!/\b1 (?:passed|failed)\b/u.test(out)) {
    throw new Error(`判据没被选中运行（-g 没匹配上任何测试），输出尾部：${out.slice(-400)}`);
  }
  return code === 0 ? "green" : "red";
}

function withCss(text, fn) {
  writeFileSync(CSS, text, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(CSS, original, "utf8");
  }
}

const cases = [
  ["① 退回只压 .btn.primary", original.replace(RULE, "  .btn.primary { padding: 6px 9px; }"), "red"],
  ["② 整条媒体规则删掉", original.replace(`${RULE}\n`, ""), "red"],
];

if (runOne() !== "green") {
  writeFileSync(CSS, original, "utf8");
  throw new Error("未改动时这条判据就不绿（或跑不起来），判据本身是坏的，变异结论无效");
}
console.log("自检：未改动时判据 green ✓\n");

let pass = 0;
for (const [name, mutated, want] of cases) {
  if (mutated === original) throw new Error(`${name} 没改动任何字节，这一发是假的`);
  const got = withCss(mutated, runOne);
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}：期望 ${want}，实读 ${got}`);
  if (readFileSync(CSS, "utf8") !== original) throw new Error(`${name} 之后 CSS 没复原`);
}
console.log(`\n文件已逐字节复原：${readFileSync(CSS, "utf8") === original ? "是" : "否"}`);
console.log(`${pass}/${cases.length} 条变异被当场抓住`);
if (pass !== cases.length) process.exitCode = 1;
