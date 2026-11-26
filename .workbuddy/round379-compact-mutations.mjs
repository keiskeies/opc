// Round379 全站紧凑化 self-rollback 变异机。
//
// 这一轮与 round378 的根本差别：round378 剪的是【行为线】（监听器、条件分支、挂载点），
// 那一类剪错界面会立刻不对；这一轮改的全是【数值】，剪错的界面【照样能用】，只是空一点。
// 于是「e2e 56 发全绿且一字未改」这句话的含义反过来了 —— 它不是验收通过，它是【没有判据】。
// 所以本机的靶子全部是 test/web/compact-scale.test.ts 里那八条判据：
// 每根线剪完，必须【只有】指向它的那一发变红；若某一发剪完仍全绿，说明本轮写下的那条
// 注释是散文而不是判据（round377/378 反复撞到的同一种病）。
//
// 靶子分两类，都必须有：
//  · 数值放松（12 → 18 这种）：模拟「下一轮有人嫌挤」的真实动作；
//  · 整条抹字节（删掉 margin-bottom / min-height 声明）：模拟最省事的那条回退路
//    ——「不改了，直接把这条删掉」。只在【真抹掉】的意义上算变异，注释掉不算。
//
// 变异基 = 工作树原态 ORIGINAL（不是 git HEAD：HEAD 还是 round378 之前的 e7b56fb）。
// 每发跑完从原 Buffer 还原，收摊复算 SHA 与开局一致 + U+FFFD 计数必须为 0。
// Run: node .workbuddy/round379-compact-mutations.mjs [id 子串]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = "D:/item/opc";
const CSS = "packages/web/public/group.css";
const GUARD = "test/web/compact-scale.test.ts";
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function runGuard(grepTitle) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", GUARD, "-t", grepTitle, "--reporter=dot"],
    { cwd: ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 32 * 1024 * 1024 },
  );
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** 自证 grep 只命中一条用例：命中多条时红了也不知道是谁剪的。 */
function matchCount(grepTitle) {
  const r = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "list", GUARD, "-t", grepTitle],
    { cwd: ROOT, encoding: "utf8", timeout: 120_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return (out.match(/\S+\.test\.ts\s+>\s+\S/gu) || []).length;
}

// expect = 被剪那根线【自己那条】判据的标题子串（每发只命中一条用例）。
// 子串一律避开正则元字符（vitest 的 -t 按正则匹配全名）—— 本仓标题用的是全角括号，安全。
const PROBES = [
  {
    // 线：顶栏高度的唯一来源。把消费者之一重新写成字面 52 —— 数值一模一样，界面一模一样，
    // 唯一的差别是「两边各写一份」这个洞重新开了：下一轮改令牌时 .workspace 不会跟着走。
    id: "C1-topbar-rehardcode",
    from: ".topbar { height: var(--topbar-height);",
    to: ".topbar { height: 52px;",
    expect: "都消费",
  },
  {
    // 线：calc 里不许留字面量。同 C1 的病，长在另一侧。
    id: "C2-workspace-calc-literal",
    from: "height: calc(100vh - var(--topbar-height));",
    to: "height: calc(100vh - 52px);",
    expect: "都消费",
  },
  {
    // 线：令牌值本身。这一发是关键 —— ① 只看【消费者是否同一来源】，值写 52 还是 64 它不问；
    // 把令牌放回 64 后 ①~⑧ 全绿（顶带 ⑧ 读的是 .page 内距 + 页头缝，压根不含顶栏），
    // 顶栏就这么白胖 12px。只有刻度表管得到。
    id: "C3-topbar-token-loosened",
    from: "--topbar-height: 52px;",
    to: "--topbar-height: 64px;",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：base 档页面内距。24 会把 ⑧（合计 16+12 ≤ 28）与 ⑨（单格 ≤ 16）同时点亮 ——
    // 双锁是有意的：这一格十路由全占，⑧ 管它与其他格的合计、⑨ 管它自己。
    id: "C4-page-pad-loosened",
    from: ".page { min-height: 100%; padding: 16px 20px 32px;",
    to: ".page { min-height: 100%; padding: 24px 28px 50px;",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：860 档只能比 base 更紧。18 > 16 属「越窄反而越松」，只在窄屏出现，没人专门去量。
    id: "C5-860-looser-than-base",
    from: "  .page { padding: 14px; }",
    to: "  .page { padding: 18px; }",
    expect: "逐位单调且至少一处严格",
  },
  {
    // 线：640 档的底部。这一发复现本轮守卫【真的抓到过我】的那个缺陷：
    // 我一度写成 padding: 12px 12px 20px，底部比 860 档的 14 还松。
    id: "C6-640-bottom-looser",
    from: "  .page { padding: 12px; }",
    to: "  .page { padding: 12px 12px 20px; }",
    expect: "逐位单调且至少一处严格",
  },
  {
    // 线：卡片内距上限。17 是本轮实测的改前值；内距一旦大于卡间缝，圆角块读起来是散点。
    // ③ 只钉方向（内距 ≥ 外距），16 ≥ 8 完全合规 —— 所以这一发必须归 ⑨。
    id: "C7-card-padding-reverted",
    from: "border-radius: var(--radius-lg); padding: var(--space-3);",
    to: "border-radius: var(--radius-lg); padding: var(--space-4);",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：卡片内距 ≥ 卡片之间。往【紧】的方向剪（4 < 8）—— ⑨ 管不着（收得更紧永远绿），
    // 所以这一发是 ③ 唯一的接线证据。没有它，③ 可以是常绿的死判据。
    id: "C8-card-inner-tighter-than-outer",
    from: "border-radius: var(--radius-lg); padding: var(--space-3);",
    to: "border-radius: var(--radius-lg); padding: var(--space-1);",
    expect: "卡内 ≥ 卡间",
  },
  {
    // 线：相邻卡的缝必须【严格小于】块缝。贴平到 12 之后，「同一组的两张卡」与
    // 「分成两段」读起来是同一件事，分组信息消失。
    id: "C9-card-gap-equals-blockgap",
    from: ".card + .card { margin-top: 8px; }",
    to: ".card + .card { margin-top: 12px; }",
    expect: "五个块缝读者全等",
  },
  {
    // 线：相邻卡那条规则整条被抹掉 —— 「不分组了」比调数值更省事，也更容易顺手做。
    // ⑤ 在「命中 0 条」上必须红，不能当「这条不存在 = 没矛盾」放过。
    id: "C10-card-gap-rule-erased",
    from: ".card + .card { margin-top: 8px; }\n",
    to: "",
    expect: "五个块缝读者全等",
  },
  {
    // 线：块缝五格同值 —— 单独挪走页头那一格。
    id: "C11-pageheader-gap-alone",
    from: "gap: var(--space-5); margin-bottom: 12px; }",
    to: "gap: var(--space-5); margin-bottom: 18px; }",
    expect: "五个块缝读者全等",
  },
  {
    // 线：块缝五格同值 —— 挪页签那一格（另一个读者，证明 ⑤ 不是只盯着页头）。
    id: "C12-tabs-gap-alone",
    from: "border-bottom: 1px solid var(--line); margin-bottom: 12px; }",
    to: "border-bottom: 1px solid var(--line); margin-bottom: 18px; }",
    expect: "五个块缝读者全等",
  },
  {
    // 线：页头缝声明整条被抹。这同时是 ⑧ 最省事的回退路（少一条声明 ⇒ 读不到就少一道闸），
    // 所以「读不到」必须算红而不是算过。
    id: "C13-pageheader-margin-erased",
    from: "gap: var(--space-5); margin-bottom: 12px; }",
    to: "gap: var(--space-5); }",
    expect: "五个块缝读者全等",
  },
  {
    // 线：选中条跟着条目内距 —— 上下不对称（重心偏移，通顶通底各差 1px 看得出来）。
    id: "C14-marker-asymmetric",
    from: ".conversation-item.selected::before { content: \"\"; position: absolute; top: 7px; bottom: 7px;",
    to: ".conversation-item.selected::before { content: \"\"; position: absolute; top: 4px; bottom: 10px;",
    expect: "上下对称，且内缩在",
  },
  {
    // 线：选中条与内距脱钩（内距没动、标记跑到 12）⇒ 内缩 -4，标记通出条目盒子。
    id: "C15-marker-detached",
    from: "position: absolute; top: 7px; bottom: 7px; left: 0; width: 3px;",
    to: "position: absolute; top: 12px; bottom: 12px; left: 0; width: 3px;",
    expect: "上下对称，且内缩在",
  },
  {
    // 线：条目内距改了、标记没跟着改（11 − 7 = 4 恰好还在 0~4 带内 ⇒ ⑥ 抓不到，
    // 归 ⑨）。这一发存在的意义是把 ⑥ 的【射程边界】写清楚：它不是万能的。
    id: "C16-item-padding-reverted",
    from: "align-items: center; width: 100%; padding: 8px 9px;",
    to: "align-items: center; width: 100%; padding: 11px 9px;",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：条目内距改到 12 时内缩 = 12 − 7 = 5 越带 ⇒ ⑥ 该抓到。与 C16 成对，
    // 一发给 ⑨、一发给 ⑥，两根判据各自的接线各证一次。
    id: "C17-item-padding-breaks-marker",
    from: "align-items: center; width: 100%; padding: 8px 9px;",
    to: "align-items: center; width: 100%; padding: 12px 9px;",
    expect: "上下对称，且内缩在",
  },
  {
    // 线：栏头内距。整份 test/ 里【没有任何判据】读 .list-heading —— 本轮把它从 18 收到 12，
    // 若 ⑨ 也不管，这一格就是纯散文。它是「⑨ 值不值得存在」最直接的那一发。
    id: "C18-listheading-reverted",
    from: ".list-heading { display: flex; align-items: center; justify-content: space-between; padding: 12px 17px 8px; }",
    to: ".list-heading { display: flex; align-items: center; justify-content: space-between; padding: 18px 17px 10px; }",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：页标题字号降到 --fs-xl(18)。换回 --fs-2xl(22) 之后间距一格没动，
    // 但页头那一条重新变高 —— 字号也是留白的一部分。
    id: "C19-h2-fontsize-reverted",
    from: ".page-header h2 { margin: 0; font-size: var(--fs-xl);",
    to: ".page-header h2 { margin: 0; font-size: var(--fs-2xl);",
    expect: "十格读数全在各自上限内",
  },
  {
    // 线：空态地板（用户 2026-11-26 拍板「保留空态卡，只收外围」）。压到 150 ⇒ 空态塌成一条。
    id: "C20-state-floor-lowered",
    from: ".state { min-height: 210px;",
    to: ".state { min-height: 150px;",
    expect: "的地板仍在",
  },
  {
    // 线：另一枚地板 —— 判据是两枚都要在，少一枚也算红。
    id: "C21-board-column-floor-lowered",
    from: ".board-column { min-height: 220px;",
    to: ".board-column { min-height: 160px;",
    expect: "的地板仍在",
  },
  {
    // 线：整条 min-height 被抹 = 地板消失，最省事的回退。必须与「压小」同价。
    id: "C22-state-floor-erased",
    from: ".state { min-height: 210px; display: flex;",
    to: ".state { display: flex;",
    expect: "的地板仍在",
  },
];

const only = process.argv[2] || "";
const SELECTED = only ? PROBES.filter((p) => p.id.includes(only)) : PROBES;
if (!SELECTED.length) {
  console.log(`没有 id 含 "${only}" 的探针`);
  process.exit(2);
}

const fffd = (p) => {
  const CH = String.fromCharCode(0xfffd);
  return [...readFileSync(p, "utf8")].filter((c) => c === CH).length;
};
const before = new Map([CSS, GUARD].map((p) => [p, sha(p)]));

// ── 预检 A：全部锚点先查完再跑用例（第 12 发才发现 FROM 不命中 = 前 11 发白烧）
let bad = 0;
for (const probe of SELECTED) {
  const text = readFileSync(CSS, "utf8");
  const hits = text.split(probe.from).length - 1;
  if (hits !== 1) {
    console.log(`${probe.id}: FROM 命中 ${hits} 处（要恰好 1 处）⇒ 脚本过期`);
    bad += 1;
    continue;
  }
  if (text.replace(probe.from, probe.to) === text) {
    console.log(`${probe.id}: 变异是 no-op（字节没变）`);
    bad += 1;
  }
}
if (fffd(CSS) !== 0 || fffd(GUARD) !== 0) {
  console.log(`开局就有 U+FFFD（css ${fffd(CSS)} / guard ${fffd(GUARD)}）⇒ 先修文件再跑`);
  process.exit(2);
}
if (bad > 0) {
  console.log(`预检 A 失败 ${bad} 发 ⇒ 未改动任何字节，停`);
  process.exit(2);
}

// ── 预检 B：未变异必须绿，且每发的 grep 只命中一条用例
const green = new Set();
for (const probe of SELECTED) {
  if (green.has(probe.expect)) continue;
  const hits = matchCount(probe.expect);
  if (hits !== 1) {
    console.log(`${probe.id}: grep "${probe.expect}" 命中 ${hits} 条用例（要恰好 1 条）⇒ 停`);
    process.exit(2);
  }
  const base = runGuard(probe.expect);
  console.log(`预检 ${probe.expect} 未变异 exit ${base.code}`);
  if (base.code !== 0) {
    console.log(`基线就是红 ⇒ 变异后的「红」不可信，先修基线：\n${base.out.slice(-2000)}`);
    process.exit(2);
  }
  green.add(probe.expect);
}

for (const [p, sum] of before) console.log(`开局 ${p} sha ${sum.slice(0, 12)} U+FFFD ${fffd(p)}`);

let killed = 0;
let restoredOk = 0;
for (const probe of SELECTED) {
  const original = readFileSync(CSS, "utf8");
  writeFileSync(CSS, original.replace(probe.from, probe.to), "utf8");
  const run = runGuard(probe.expect);
  const killedThis = run.code !== 0;
  if (killedThis) killed += 1;
  writeFileSync(CSS, original, "utf8");
  const restored = sha(CSS) === before.get(CSS);
  if (restored) restoredOk += 1;
  const control = runGuard(probe.expect);
  console.log(
    `${probe.id}: ${killedThis ? "KILLED" : "SURVIVED"}（exit ${run.code}）` +
      ` / 还原后控制组 exit ${control.code} / SHA ${restored ? "一致" : "不一致"}`,
  );
  if (!killedThis) console.log(run.out.slice(-2500));
  if (killedThis && control.code !== 0)
    console.log(`!! 控制组也红（还原后仍失败），这发的绿不可信：\n${control.out.slice(-1500)}`);
}
for (const [p, sum] of before)
  console.log(`收摊 ${p} sha ${sha(p).slice(0, 12)} 目标 ${sum.slice(0, 12)} U+FFFD ${fffd(p)}`);
console.log(
  `合计：killed ${killed}/${SELECTED.length}，SHA 还原一致 ${restoredOk}/${SELECTED.length}`,
);
process.exit(killed === SELECTED.length && restoredOk === SELECTED.length ? 0 : 1);
