// round334: O4 验收句的【第三次】复测 —— 删五个调用点，各应至少一发红。
//
// 要复算的句子（docs/OPC-OS-功能优化设计.md 的 O4 验收行，round271 落的话）：
//   「验收（删掉第 3、4 行调用点 ⇒ 各自一发红）—— round271 复测：达成，且每处不止一发」
//   当时读数：M1=4红 / M2=2红 / M3=2红 / M4=1红 / M5=9红。
// round334 的两个增量（不只是重跑）：
//   a) 每发跑【全 hub 套件】而不是挑文件跑 —— round271 的射程未记录挑了哪些文件，
//      挑文件的读数与全量的读数口径不同；全 hub 实测 21 秒，没有理由不用宽的尺。
//   b) 每发施加变异后先过 `tsc -b`：O4 原文那句「tsc 只看见函数还在被同目录引用」
//      主张的就是【这些删除 tsc 全看不见】。过不了 tsc 的删除根本到不了测试那一层，
//      红就红在编译器上 —— 那验的不是防线是编译器。
// 锚点 = round271-o4-acceptance-mutate.mjs 的 SPECS 逐字（进场前已核：五个锚点在
// 当前字节里各命中恰好一次；且 round271 的五份 orig 存档与当前逐字节相同）。
//
// readSummary 逐字沿用 round332/331 那两台（并红型），不是自己写：
// test/arch/mutation-parser-screen.test.ts 会拿真 vitest 屏喂每台 round*-mutate-*.mjs，
// 归不进两种已知架构就红 —— 守卫要求改机器而不是改守卫。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ESC = String.fromCharCode(27);
const VF = "packages/hub/src/harness/verifier.ts";
const AR = "packages/hub/src/graph/gates/author-reviewer.ts";

/**
 * 从 vitest 输出读「红了几发 / 红了哪些文件 / 红了哪几发用例名」。并红型：
 * 文件级红并进 failed；剥完 ANSI 还剩 ESC 字节直接抛；Tests/Test Files 摘要行
 * 读不到抛；「一个数字都没有」（装载失败型）抛 —— 细节同 round331/332 那两台。
 */
function readSummary(out) {
  const clean = out.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
  if (clean.indexOf(ESC) !== -1) {
    throw new Error("剥 ANSI 没生效（剥完输出里还剩 ESC 字节）—— 摘要行会读不到");
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 【不能】当 0 处理：那会把红读成绿。尾部：\n" + clean.slice(-900),
    );
  }
  const seg = m[1] ?? "";
  const failedTests = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
  const passed = Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]);
  const files = new Set();
  const tests = new Set();
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm === null || fm[1] === undefined) continue;
    files.add(fm[1].split("\\").join("/"));
    const gt = line.indexOf(">");
    if (gt >= 0) {
      const name = line.slice(gt + 1).split(">").pop().trim();
      if (name !== "") tests.add(name);
    }
  }
  const tf = clean.match(/^\s*Test Files\s+(.+)$/m);
  if (tf === null) {
    throw new Error("读不到「Test Files」摘要行 —— 同「Tests」那条纪律。尾部：\n" + clean.slice(-500));
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error("有文件红了但【读不到 FAIL 行的文件名】⇒ 归因失真。尾部：\n" + clean.slice(-900));
  }
  return { failed: failedTests + failedFiles, failedTests, failedFiles, passed, files, tests };
}

function run(cmdArgs, timeoutMs) {
  const r = spawnSync(process.execPath, cmdArgs, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (r.error) throw new Error("spawn 失败: " + String(r.error.message));
  return r;
}
function vitestFullHub() {
  const r = run([join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "packages/hub/test"], 900000);
  return readSummary(String(r.stdout) + String(r.stderr));
}
function tscOk() {
  // tsc 走 npm 的 bin：Windows 上 spawnSync npx 直接 ENOENT（round332 的教训），
  // 所以指 node_modules/typescript/bin/tsc 的真字节。
  const r = run([join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-b"], 600000);
  return { ok: r.status === 0, out: String(r.stdout) + String(r.stderr) };
}

const SPECS = {
  M1: {
    label: "verifier 的 sameFamilyReviewBlock 调用点 ⇒ canned {ok:true}",
    file: VF,
    from: "  const fam = sameFamilyReviewBlock(",
    to:
      "  const fam = ((): ReturnType<typeof sameFamilyReviewBlock> => ({ ok: true }))();\n" +
      "  if (false) sameFamilyReviewBlock(",
    expectFiles: ["packages/hub/test/harness/verifier.test.ts"],
  },
  M2: {
    label: "selfReviewEdgeBlock 里的 independentReviewerPath ⇒ canned reachable",
    file: AR,
    from: "  const r = independentReviewerPath(author, edges);",
    to:
      "  const r = ((): ReturnType<typeof independentReviewerPath> => ({ reachable: true, path: [] }))();\n" +
      "  void independentReviewerPath;",
    expectFiles: ["packages/hub/test/gates/author-reviewer.test.ts"],
  },
  M3: {
    label: "gateConfigBlock 里的 sameFamilyReviewBlock ⇒ canned {ok:true}",
    file: AR,
    from: "  const a = sameFamilyReviewBlock(o.producer, o.reviewer, o.approval);",
    to:
      "  const a = ((): ReturnType<typeof sameFamilyReviewBlock> => ({ ok: true }))();\n" +
      "  void sameFamilyReviewBlock;",
    expectFiles: ["packages/hub/test/gates/author-reviewer.test.ts"],
  },
  M4: {
    label: "gateConfigBlock 里的 selfReviewEdgeBlock ⇒ canned {ok:true}",
    file: AR,
    from: "  const b = selfReviewEdgeBlock(o.producer.roleId, o.edges);",
    to:
      "  const b = ((): ReturnType<typeof selfReviewEdgeBlock> => ({ ok: true }))();\n" +
      "  void selfReviewEdgeBlock;",
    expectFiles: ["packages/hub/test/gates/author-reviewer.test.ts"],
  },
  M5: {
    label: "verifier 的 evaluateGate ⇒ canned pass 判定",
    file: VF,
    from: "  const verdict: GateVerdict = evaluateGate({",
    to:
      "  const verdict: GateVerdict = ((o: Parameters<typeof evaluateGate>[0]) => {\n" +
      "    void o;\n" +
      "    return { decision: \"pass\" as const, unresolved: [] as string[] };\n" +
      "  })({",
    expectFiles: ["packages/hub/test/harness/verifier.test.ts"],
  },
};

// 进场快照：两台文件的当前字节 + 锚点恰好一次（round271 同款纪律，锚点漂了当场拒跑）。
const files = [VF, AR];
const snapshots = new Map(files.map((f) => [f, readFileSync(join(ROOT, f), "utf8")]));
for (const k of Object.keys(SPECS)) {
  const s = SPECS[k];
  const n = snapshots.get(s.file).split(s.from).length - 1;
  if (n !== 1) throw new Error(k + " 锚点命中 " + n + "（需要恰好 1）⇒ 现场与 round271 不同形，拒跑");
}

function restore() {
  for (const [f, orig] of snapshots) {
    writeFileSync(join(ROOT, f), orig);
    if (readFileSync(join(ROOT, f), "utf8") !== orig) throw new Error("还原核对失败: " + f);
  }
}

let fails = 0;
const lines = [];
try {
  // M0 控制：全 hub 基线必须全绿，否则后面每一发的「红」都读不出归因。
  const base = vitestFullHub();
  lines.push("M0 基线（全 hub）: failed=" + base.failed + " passed=" + base.passed);
  if (base.failed !== 0) {
    lines.push("  ⇒ 基线不绿，整轮读数作废（红发 " + base.failed + "，文件: " + [...base.files].join(", ") + "）");
    fails++;
  }
  const t0 = tscOk();
  lines.push("M0 tsc -b: " + (t0.ok ? "ok" : "FAIL\n" + t0.out.slice(0, 500)));
  if (!t0.ok) fails++;

  for (const k of Object.keys(SPECS)) {
    const s = SPECS[k];
    const cur = readFileSync(join(ROOT, s.file), "utf8");
    writeFileSync(join(ROOT, s.file), cur.replace(s.from, s.to));
    let got;
    let ts;
    try {
      ts = tscOk();
      got = vitestFullHub();
    } finally {
      restore();
    }
    const filesHit = [...got.files];
    const expectOk = s.expectFiles.every((f) => got.files.has(f));
    const hit = got.failedTests >= 1 && ts.ok && expectOk;
    if (!hit) fails++;
    lines.push(
      k + " " + s.label + "\n" +
        "    tsc=" + (ts.ok ? "看不见（符合 O4 那句原话）" : "红（违背原话）: " + ts.out.slice(0, 300)) + "\n" +
        "    全 hub: 用例红=" + got.failedTests + " 文件红=" + got.failedFiles + " 通过=" + got.passed +
        " | 期望红文件命中=" + (expectOk ? "是" : "否（实红: " + filesHit.join(", ") + "）") +
        (got.failedTests > 0 ? "\n    红用例: " + [...got.tests].slice(0, 12).join(" / ") : ""),
    );
  }
} finally {
  restore();
  // 回滚后复跑基线自证：逐字节还原之外再给一次「现在 == 进场时的行为」。
  const after = vitestFullHub();
  lines.push("回滚后基线复跑（全 hub）: failed=" + after.failed + " passed=" + after.passed);
  if (after.failed !== 0) {
    lines.push("  ⇒ 回滚后不绿，本轮还原不可信，文件: " + [...after.files].join(", "));
    fails++;
  }
}
console.log(lines.join("\n"));
console.log(fails === 0 ? "\nRESULT: 控制 + 五发全部符合预测（tsc 全看不见 且 每发 ≥1 用例红 且 红在期望文件）" : "\nRESULT: " + fails + " 处不符");
process.exit(fails === 0 ? 0 : 1);
