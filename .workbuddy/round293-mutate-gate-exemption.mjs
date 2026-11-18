#!/usr/bin/env node
/**
 * round293 · 打在【豁免账】上的变异矩阵 —— 证 plan-gate-paths.test.ts 那两条新钉的
 * 断言（条数恰好 1 / 豁免的是哪一格）不是恒绿的装饰。
 *
 * 为什么需要它：那两条是我本轮【收紧】的（原来是「>0 且 ≤2」，改成「恰好 1」+ 点名）。
 * 收紧后的判据如果写法有误（比如把 ex.length 读成 ex[0] 的某个成员），
 * 它照样绿，而我会以为「账被钉住了」。同 round290 那条 M4 的教训：
 * 变异必须打在【真会让判据变瞎的那一格】上，不是打在一个响亮失败的地方。
 *
 * 两处靶子：
 *   · 计划正文（docs/superpowers/plans/…）—— 豁免标记【就在】它的验收行续行里；
 *   · 守卫自己的判据（test/arch/plan-gate-paths.ts）—— 那条 filter。
 * 全部自回滚 + 逐字节核对（抹的是真字节，不是靠正则读一遍）。
 *
 * ⚠ 纪律：这条矩阵【单独跑】，不与任何测试并发（它改的是真字节，round292 (b) 那条）。
 * 跑法：node .workbuddy/round293-mutate-gate-exemption.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLAN = join(
  ROOT,
  "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md",
);
const GUARD = join(ROOT, "test/arch/plan-gate-paths.ts");
const SUITE = ["test/arch/plan-gate-paths.test.ts"];

const TAG = "<!-- gate-path-not-built -->";
const MOBILE = "test/e2e/mobile-approval.spec.ts";
const CEO = "test/e2e/ceo-loop.spec.ts";

/** edits 里每一项都是【同一份文件】上的一次替换（from 必须恰好命中 1 次）。 */
const plan = [
  {
    id: "M0",
    file: PLAN,
    name: "控制组：一字不改",
    expectRed: false,
    why: "绿是后面每一发红的前提",
    edits: [],
  },
  {
    id: "M1",
    file: PLAN,
    name: "把豁免标记从 mobile 那一格挪到 ceo-loop 那一格（路径存在）",
    expectRed: true,
    why: "身份钉 + 死豁免钉都该响：标记贴在一行所有路径都存在的位置上",
    edits: [
      { file: PLAN, from: "「卡片推到手机上」。" + TAG, to: "「卡片推到手机上」。" },
      { file: PLAN, from: "名字是 gate-path-not-built）随之摘掉。", to: "名字是 gate-path-not-built）随之摘掉。" + TAG },
    ],
  },
  {
    id: "M2",
    file: PLAN,
    name: "静默删掉最后那条豁免（不建文件）",
    expectRed: true,
    why: "条数恰好 1 该红在 0 ⇒ 「豁免被人悄悄摘了」这一族有响",
    edits: [{ file: PLAN, from: "。" + TAG + "】", to: "】" }],
  },
  {
    id: "M3",
    file: GUARD,
    name: "豁免计数改成【恒真 filter】（收所有验收行）",
    expectRed: true,
    why: "exemptedBlocks 不再问标记在不在 ⇒ 条数读数与标记脱钩，恰好 1 该红",
    edits: [
      {
        file: GUARD,
        from: '.filter((b) => b.text.includes(NOT_BUILT_TAG))',
        to: ".filter(() => true)",
      },
    ],
  },
  {
    id: "M4",
    file: PLAN,
    name: "只改豁免那一格的散文措辞（标记与路径一字未动）",
    expectRed: false,
    why: "【该绿】：判据不该对无关文案敏感 —— 绿的这一发画的是判据的边界",
    edits: [
      {
        file: PLAN,
        from: "手工验证现在能做的是「手机上回批」",
        to: "手工验证此刻能做的是「手机上回批」",
      },
    ],
  },
];

function count(hay, needle) {
  return hay.split(needle).length - 1;
}

/** 进场前把所有锚点验一遍：任一失配就一发不发。 */
function preflight() {
  const bad = [];
  for (const mut of plan) {
    for (const e of mut.edits) {
      if (e.from === e.to) bad.push(mut.id + " 是真空操作（from === to）");
      const src = readFileSync(e.file, "utf8");
      const n = count(src, e.from);
      if (n !== 1) {
        bad.push(
          mut.id + " 的锚点命中 " + n + " 次（要求恰好 1）：" + e.from.slice(0, 48),
        );
      }
    }
  }
  if (bad.length > 0) throw new Error("锚点校验失败，一发不发：\n  " + bad.join("\n  "));
}

function readSummary(out) {
  // ⚠ 本轮第二条「工具自己错」的坑，且它伪装成【被测对象的错】：
  //   第一版这里写的是 /\[[0-9;]*m/g —— 少了 ESC。它把 "[2m" 剥掉了，却把 0x1b 留在行首，
  //   于是 /^\s*Tests\s/ 对着一行「ESC + 汇总」判不中 ⇒ 报「读不到汇总行」，
  //   看起来像 vitest 没跑，实际是我的剥色正则没剥干净（vitest 给汇总行上了色）。
  //   ⇒ 凡是「用正则读别人的输出」的脚本，先拿【一次真输出】验这个正则，再谈变异结果。
  const plain = out.replace(/\u001b\[[0-9;]*m/g, "");
  const line = plain.split("\n").find((l) => /^\s*Tests\s/.test(l));
  if (line === undefined) {
    throw new Error("读不到 vitest 汇总行 ⇒ 拒绝把这一发当绿。尾部：\n" + plain.slice(-1000));
  }
  const failed = /(\d+) failed/.exec(line);
  const passed = /(\d+) passed/.exec(line);
  return {
    red: failed === null ? 0 : Number(failed[1]),
    green: passed === null ? 0 : Number(passed[1]),
  };
}

function runSuite(mutLabel) {
  try {
    return readSummary(
      execFileSync("npx", ["vitest", "run", ...SUITE], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: true,
      }),
    );
  } catch (err) {
    // ⚠ 这一格本轮踩过一次：无脑把 err.stdout 交给 readSummary，于是【vitest 根本没起来】
    //   和【起来了但读不到汇总行】长成同一个错，真诊断（起动失败的原因）被吞掉了。
    //   ⇒ 先问「输出里有没有汇总行」：有才交给 readSummary，没有就报起动失败并带尾部。
    //   同 round293-mutate-census.mjs 那一格。
    const out = String(err.stdout ?? "") + String(err.stderr ?? "");
    if (/Tests\s/.test(out)) return readSummary(out);
    throw new Error(mutLabel + " vitest 起跑失败：\n" + out.slice(-1500));
  }
}

preflight();
const originals = new Map([
  [PLAN, readFileSync(PLAN, "utf8")],
  [GUARD, readFileSync(GUARD, "utf8")],
]);
const results = [];
try {
  for (const mut of plan) {
    for (const [f, text] of originals) writeFileSync(f, text, "utf8");
    for (const e of mut.edits) {
      const src = readFileSync(e.file, "utf8");
      writeFileSync(e.file, src.replace(e.from, e.to), "utf8");
    }
    const r = runSuite(mut.id + " " + mut.name + "：");
    const hit = mut.expectRed ? r.red > 0 : r.red === 0;
    results.push({ ...mut, ...r, hit });
  }
} finally {
  for (const [f, text] of originals) {
    writeFileSync(f, text, "utf8");
    if (readFileSync(f, "utf8") !== text) {
      throw new Error("回滚后字节对不上：" + f + " —— 立刻去 git 核对");
    }
  }
}

console.log("\n══════════ round293 豁免账变异矩阵 ══════════");
let missed = 0;
for (const r of results) {
  if (!r.hit) missed += 1;
  console.log(
    (r.hit ? "✓" : "✗") +
      " " +
      r.id +
      " " +
      r.name +
      "  [应" +
      (r.expectRed ? "红" : "绿") +
      "] 红发=" +
      r.red +
      " 绿发=" +
      r.green +
      " | " +
      r.why,
  );
}
console.log("命中 " + (results.length - missed) + " / " + results.length);
if (missed > 0) process.exitCode = 1;
