// round377 「.doc-page 间隔 = 声明的 gap」判据的变异自证（doc-layout.spec.ts :435 那一发）。
// 背景：E 级把 gap:14px 折进 --space-3(12) 后，老断言 toBe(14) 红了 —— 它钉的是一时取值。
// 修法不是把 14 改写成 12（换个数字继续钉死），判据换成「实测间隔 == 声明 gap」+
// 「声明 gap 必须 >0」（同文件 .doc-drawer-body 那一发已用的口径）。两条变异各打一头：
//  ① 往 .doc-head 塞回 margin-bottom:6px ⇒ 实测间隔 = gap+6 ≠ 声明 12 ⇒ 必须红
//     （这一发证的是「margin 叠上来」这个真症状还在判据射程里 —— 改判据没把它放走）；
//  ② 抹掉 .doc-page 的 gap ⇒ 声明读 0、实测也读 0 ⇒ 若没有「声明 >0」那发自证，
//     for 环里 0==0 恒真 ⇒ 必须红（证尺子自证那一发不是装饰）。
// 每条变异必须真抹字节、跑完逐字节复原，且事先证明未改动时判据是绿的。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CSS = "packages/web/public/group.css";
const TEST = "test/e2e/doc-layout.spec.ts";
const TITLE = "间隔只由 gap 决定";

const HEAD_RULE = ".doc-page > .doc-head { margin-bottom: 0; flex: 0 0 auto; }";
const HEAD_RULE_MUT =
  ".doc-page > .doc-head { margin-bottom: 6px; flex: 0 0 auto; }";
const DOC_PAGE =
  ".doc-page { display: flex; flex-direction: column; gap: var(--space-3); max-width: none; padding: 12px 16px 14px; }";
const DOC_PAGE_NOGAP =
  ".doc-page { display: flex; flex-direction: column; max-width: none; padding: 12px 16px 14px; }";

const css0 = readFileSync(CSS, "utf8");
for (const [name, needle] of [
  ["HEAD_RULE", HEAD_RULE],
  ["DOC_PAGE", DOC_PAGE],
]) {
  if (css0.split(needle).length !== 2) {
    throw new Error(
      `锚点 ${name} 不唯一（出现 ${css0.split(needle).length - 1} 次），变异会打到别处`,
    );
  }
}

function runOne() {
  // 只看退出码会把「一条都没选中」当成红。把 stdout 也拿住，先确认恰好跑了 1 条。
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/@playwright/test/cli.js", "test", TEST, "-g", TITLE],
      { encoding: "utf8", stdio: "pipe" },
    );
  } catch (err) {
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    code = 1;
  }
  if (!/\b1 (?:passed|failed)\b/u.test(out)) {
    throw new Error(
      `判据没被选中运行（-g 没匹配上任何测试），输出尾部：${out.slice(-400)}`,
    );
  }
  return code === 0 ? "green" : "red";
}

function withMutation(mut, fn) {
  writeFileSync(CSS, mut, "utf8");
  try {
    return fn();
  } finally {
    writeFileSync(CSS, css0, "utf8");
  }
}

const cases = [
  ["① .doc-head 塞回 margin-bottom:6px（gap 之外又叠 margin）", css0.replace(HEAD_RULE, HEAD_RULE_MUT), "red"],
  ["② 抹掉 .doc-page 的 gap（声明读 0 ⇒ 尺子自证必须拦）", css0.replace(DOC_PAGE, DOC_PAGE_NOGAP), "red"],
];

if (runOne() !== "green") {
  writeFileSync(CSS, css0, "utf8");
  throw new Error("未改动时这条判据就不绿（或跑不起来），判据本身是坏的，变异结论无效");
}
console.log("自检：未改动时判据 green ✓\n");

let pass = 0;
for (const [name, mut, want] of cases) {
  if (mut === css0) throw new Error(`${name} 没改动任何字节，这一发是假的`);
  const got = withMutation(mut, runOne);
  const ok = got === want;
  if (ok) pass += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}：期望 ${want}，实读 ${got}`);
  if (readFileSync(CSS, "utf8") !== css0) throw new Error(`${name} 之后 group.css 没复原`);
}
console.log(`\n文件已逐字节复原：css=${readFileSync(CSS, "utf8") === css0 ? "是" : "否"}`);
console.log(`${pass}/${cases.length} 条变异被当场抓住`);
if (pass !== cases.length) process.exitCode = 1;
