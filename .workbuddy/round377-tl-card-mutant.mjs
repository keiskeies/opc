// round377 「回放时间线套卡片」判据的变异自证（ceo-loop.spec.ts 第 ⑥ 步）。
// 两条各打一头断言，缺一头都说明判据只考了半件事：
//  ① 抹掉时间线外那层 .admin-card ⇒ chip 落回页背景 ⇒ 「不许坐在页背景上」必须红；
//  ② 给 .admin-tl 自己垫一层【异于页背景】的面 ⇒ 「必须坐在 admin-card 上」必须红
//     （这一发专防「只断不等于页背景」的松判据：那时长出别的面也能糊过去）。
// 每条变异必须真抹字节、跑完逐字节复原，且事先证明未改动时判据是绿的。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const APP = "packages/web/public/app.js";
const CSS = "packages/web/public/admin.css";
const TEST = "test/e2e/ceo-loop.spec.ts";
const TITLE = "CEO 一圈";

const WRAP =
  '        ? `<div class="admin-card"><div class="admin-tl">${entries.map(eventRow).join("")}</div></div>`\n';
const NOWRAP =
  '        ? `<div class="admin-tl">${entries.map(eventRow).join("")}</div>`\n';
const TL_RULE =
  ".admin-root .admin-tl { border-left:1px solid var(--line); padding-left:16px; margin-left:6px; }";
const TL_RULE_PADDED =
  ".admin-root .admin-tl { border-left:1px solid var(--line); padding-left:16px; margin-left:6px; background:#eef3ea; }";

const app0 = readFileSync(APP, "utf8");
const css0 = readFileSync(CSS, "utf8");
for (const [name, hay, needle] of [
  ["WRAP", app0, WRAP],
  ["TL_RULE", css0, TL_RULE],
]) {
  if (hay.split(needle).length !== 2) {
    throw new Error(`锚点 ${name} 不唯一（出现 ${hay.split(needle).length - 1} 次），变异会打到别处`);
  }
}

function runOne() {
  // 只看退出码会把「一条都没选中」当成红。把 stdout 也拿住，先确认恰好跑了 1 条。
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

/** 一次变异可以同时动两个文件；finally 里两个都逐字节复原。 */
function withMutation(mut, fn) {
  if (mut.app !== undefined) writeFileSync(APP, mut.app, "utf8");
  if (mut.css !== undefined) writeFileSync(CSS, mut.css, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(APP, app0, "utf8");
    writeFileSync(CSS, css0, "utf8");
  }
}

const cases = [
  ["① 抹掉时间线外那层 .admin-card", { app: app0.replace(WRAP, NOWRAP) }, "red"],
  ["② 给 .admin-tl 垫一层异色面（卡还在，底不再是卡）", { css: css0.replace(TL_RULE, TL_RULE_PADDED) }, "red"],
];

if (runOne() !== "green") {
  writeFileSync(APP, app0, "utf8");
  writeFileSync(CSS, css0, "utf8");
  throw new Error("未改动时这条判据就不绿（或跑不起来），判据本身是坏的，变异结论无效");
}
console.log("自检：未改动时判据 green ✓\n");

let pass = 0;
for (const [name, mut, want] of cases) {
  if (mut.app === app0 && mut.css === css0) throw new Error(`${name} 没改动任何字节，这一发是假的`);
  const got = withMutation(mut, runOne);
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}：期望 ${want}，实读 ${got}`);
  if (readFileSync(APP, "utf8") !== app0) throw new Error(`${name} 之后 app.js 没复原`);
  if (readFileSync(CSS, "utf8") !== css0) throw new Error(`${name} 之后 admin.css 没复原`);
}
console.log(`\n文件已逐字节复原：app=${readFileSync(APP, "utf8") === app0 ? "是" : "否"} css=${readFileSync(CSS, "utf8") === css0 ? "是" : "否"}`);
console.log(`${pass}/${cases.length} 条变异被当场抓住`);
if (pass !== cases.length) process.exitCode = 1;
