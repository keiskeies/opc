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

/**
 * round301：round293-mutate-gate-exemption.mjs 的 readSummary 补两格 + 读数自证。
 *
 * ⚠ 那个文件原来的剥色正则写成 /<ESC>\[[0-9;]*m/（源码里放了一个【字面 0x1b 字节】）。
 *   本轮整段替换它时若手打那一行，ESC 会在编辑器的字符串里悄悄丢掉 ⇒ 正是 round292
 *   中过、round293 自己在注释里写过的那个洞（「看起来像被测对象的错」）。
 *   所以这里改用 round294/295 的写法：ESC 写成可见的 String.fromCharCode(27)，
 *   正则用 new RegExp 拼 —— 下一只手「顺手清理不可见字节」也清不掉它。
 */
const ESC = String.fromCharCode(27);

/**
 * 剥 ANSI 后读汇总；读不到就抛。
 *
 * round301 补的两格（round293 原注释讲的「剥色正则以偏概全」那条，现在由
 * 下面那句「剥完还剩 ESC 就抛」当场验，不再只靠注释提醒）：
 *  ① Tests 行【一个数字都没有】的那一型。真 vitest 在「整份文件装载失败、
 *     一个用例都没跑到」时把它打成 `      Tests  no tests` —— 没有 failed 也没有
 *     passed。旧写法把「读不到 failed」当 0 ⇒ M0 控制组（应绿）在【一个用例都没跑】
 *     的前提下判【命中】。判「无数字」而不是判「等于 0」：真绿屏是
 *     「failed 缺失 + N passed」，有数字 ⇒ 不误伤真绿（自证甲钉这条不对称）。
 *  ② 文件级红而用例级 0 红 ⇒ 装载/采集期失败。本机原来【连 Test Files 行都不读】，
 *     所以「死一份、其余照跑」会读成用例级全绿 ⇒ 控制组判命中、变异发判未命中
 *     （exit 1 是红，但红话说的是假原因）。与 round298「文件红了而读不到 FAIL 文件名
 *     ⇒ 抛」同族；本机没有用例名归因，文件级/用例级不自洽是唯一抓得住它的判据。
 */
function readSummary(out) {
  const plain = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (plain.includes(ESC)) {
    throw new Error("剥 ANSI 没生效（剥完还剩 ESC 字节）⇒ 汇总行会读不到。");
  }
  const line = plain.split("\n").find((l) => /^\s*Tests\s/.test(l));
  if (line === undefined) {
    throw new Error("读不到 vitest 汇总行 ⇒ 拒绝把这一发当绿。尾部：\n" + plain.slice(-1000));
  }
  const seg = line.replace(/^\s*Tests\s+/, "");
  if (!/\d/u.test(seg)) {
    throw new Error(
      "Tests 摘要行里【一个数字都没有】（实得：" + seg.trim() + "）—— 这一型是「一个用例" +
        "都没跑到」，不是「全部通过」。不能当 0。尾部：\n" + plain.slice(-800),
    );
  }
  const failed = /(\d+) failed/.exec(line);
  const passed = /(\d+) passed/.exec(line);
  const red = failed === null ? 0 : Number(failed[1]);
  const fileLine = plain.split("\n").find((l) => /^\s*Test Files\s/.test(l));
  if (fileLine === undefined) {
    throw new Error(
      "读不到 Test Files 汇总行 ⇒ 拒绝读成任何一种结果。尾部：\n" + plain.slice(-600),
    );
  }
  const failedFiles = /(\d+) failed/.exec(fileLine);
  const redFiles = failedFiles === null ? 0 : Number(failedFiles[1]);
  if (redFiles > 0 && red === 0) {
    throw new Error(
      "Test Files 红了 " + redFiles + " 份而用例级【一条红都没有】⇒ 装载/采集期失败，" +
        "不是判据红，两种读数都不许采信。尾部：\n" + plain.slice(-800),
    );
  }
  return {
    red,
    green: passed === null ? 0 : Number(passed[1]),
    redFiles,
  };
}

/**
 * 读数自证（round301 补）：四段【真屏逐行抄写】，判的是这台读得对不对。
 * 字节抄自 .workbuddy/probe301-{green,red,loadfail}-raw.txt（本轮真跑抓的，
 * 色码是真的 ESC）。分母数出来（cases.length），不写死。
 */
function selfCheckParser() {
  const w = (s) => s.split("ESC").join(ESC);
  const cases = [
    [
      "甲 真绿屏读成绿",
      w(
        " Test Files ESC[22m ESC[1mESC[32m1 passedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[32m11 passedESC[39mESC[22m ESC[90m (11)ESC[39m\n",
      ),
      (s) => (s.red === 0 && s.green === 11 ? "" : "red=" + s.red + " green=" + s.green),
    ],
    [
      "乙 真红屏读成红",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/plan-gate-paths.test.ts > s > c\n" +
          " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[31m2 failedESC[39mESC[22m | 9 passed ESC[90m (11)ESC[39m\n",
      ),
      (s) =>
        s.red === 2 && s.redFiles === 1
          ? ""
          : "red=" + s.red + " redFiles=" + s.redFiles,
    ],
    [
      "丙 装载失败（no tests）必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/plan-gate-paths.test.ts ESC[2m[ x ]ESC[22m\n" +
          " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
          "      Tests ESC[22m ESC[2mno testsESC[22m\n",
      ),
      null,
    ],
    [
      "丁 死一份其余照跑必须抛",
      w(
        "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/plan-gate-paths.test.ts ESC[2m[ x ]ESC[22m\n" +
          " Test Files ESC[22m ESC[1mESC[31m1 failed | 1 passedESC[39mESC[22m ESC[90m (2)ESC[39m\n" +
          "      Tests ESC[22m ESC[1mESC[32m22 passedESC[39mESC[22m ESC[90m (22)ESC[39m\n",
      ),
      null,
    ],
  ];
  const problems = [];
  for (const [name, text, judge] of cases) {
    try {
      const s = readSummary(text);
      if (judge === null) {
        problems.push(name + "：【没抛】—— 读成 red=" + s.red + " redFiles=" + s.redFiles);
        continue;
      }
      const bad = judge(s);
      if (bad !== "") problems.push(name + "：读错（" + bad + "）");
    } catch (e) {
      if (judge === null) continue;
      problems.push(
        name + "：真屏【抛了】⇒ M0 永远红：" + String(e.message).slice(0, 80),
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      "这台机器自己的读数不可信，【一发都没跑】（" + cases.length + " 格里红 " +
        problems.length + " 格）：\n  " + problems.join("\n  "),
    );
  }
  console.log(
    "  读数自证  " + cases.length + " 格全过（真绿/真红读对，装载失败两型都抛）",
  );
}
selfCheckParser();

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
