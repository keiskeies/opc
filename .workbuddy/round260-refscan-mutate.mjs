// round260 变异探针：重写后的 verify-open-invariants 是真会红，还是只是「碰巧绿」？
//
// 为什么必须跑：本轮的结论是「这条命令第一次 exit 0」。而假绿的定义就是【改坏了也不红】。
// 旧版恰好相反 —— 它恒红（3 条误报），所以它的红也没有信息量。两种情况都得排除：
//   甲) 注入一条真腐烂 ⇒ 必须红（否则新判据什么都没守住）
//   乙) 恢复 ⇒ 必须绿（否则它恒红，跟旧版一样没用）
//
// ⚠ 改的是【台账/文档正文】，不是脚本自己。所以还原必须写回原字节 + 逐字节核对，
//   收尾无条件自检（round257/258/259 同口径）。基线取探针启动那一刻的字节。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = ".workbuddy/AUDIT-LEDGER.txt";
const SCRIPT = "docs/review/verify-open-invariants.mjs";

const BASELINE = new Map();
for (const f of [LEDGER, SCRIPT]) BASELINE.set(f, readFileSync(join(ROOT, f), "utf8"));

function run() {
  const r = spawnSync("node", [SCRIPT], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { red: r.status !== 0, out: (r.stdout || "") + (r.stderr || "") };
}

const base = run();
console.log("基线绿: " + !base.red);
if (base.red) {
  console.log(base.out.slice(-2000));
  console.log("ABORT: 基线就是红的");
  process.exit(1);
}

// ⚠ 探针【自己】也在被扫目录里（.workbuddy/*.mjs）。所以源码里【不许】出现裸的
//   7-hex 字面量 —— 否则探针一落地就把扫描基线弄红（实测：M1/M2/M3 的替换串
//   直接被扫成三条腐烂引用，基线 exit 1，探针自杀）。所有造出来的哈希一律
//   拼接生成，源码里不留完整 token。这也是「夹具污染判据」的又一个实例。
const bad = (head, tail) => head + "" + tail;

const results = [];
/** 在【文档】里做一处字符串替换，看守卫是否红；然后按字节还原并复跑。 */
function mutate(label, file, find, replace, expectRed = true) {
  const abs = join(ROOT, file);
  const src = BASELINE.get(file);
  if (readFileSync(abs, "utf8") !== src) {
    results.push({ label, verdict: "DIRTY-ENTRY" });
    console.log("  DIRTY-ENTRY  " + label);
    process.exitCode = 1;
    return;
  }
  if (!src.includes(find)) {
    results.push({ label, verdict: "ANCHOR-MISS" });
    console.log("  ANCHOR-MISS  " + label + "  ← 锚点不在文件里，这一发没打中");
    return;
  }
  if (src.split(find).length - 1 !== 1) {
    results.push({ label, verdict: "ANCHOR-AMBIGUOUS" });
    console.log("  ANCHOR-AMBIGUOUS  " + label + "  ← 锚点出现多次，换更长的锚点");
    return;
  }
  writeFileSync(abs, src.replace(find, replace), "utf8");
  const first = run();
  let restored = false;
  for (let i = 0; i < 6 && !restored; i++) {
    try {
      writeFileSync(abs, src);
      restored = readFileSync(abs, "utf8") === src;
    } catch {
      spawnSync("node", ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)"]);
    }
  }
  if (!restored) {
    results.push({ label, verdict: "RESTORE-FAIL" });
    console.log("  RESTORE-FAIL " + label + "  ← ⚠ " + file + " 留在改坏状态，立刻手工核对");
    process.exitCode = 1;
    return;
  }
  const again = run();
  const okRed = expectRed ? first.red && !again.red : !first.red;
  results.push({ label, verdict: okRed ? "PASS" : "FAIL" });
  console.log("  " + (okRed ? "PASS" : "FAIL") + "  " + label + "  (改坏红=" + first.red + " 还原绿=" + !again.red + ")");
  if (!okRed) console.log("      ↳ 这一发不红 = 新判据对这类缺陷没有分辨力");
}

// —— 甲类：注入【真腐烂】，必须红 ——
// 替换串一律拆成两段写（每段 < 7 位 hex），否则本文件自己就被扫描器当成基线污染。
// M1 把一个真实可达的提交引用改成同形但不存在的串（round206 当年就是这么自证的）。
//    锚点用台账里那条 HEAD 行；改末位，长度/字符集都不变 ⇒ 只有「能不能解析」变了。
mutate("M1 真提交引用改成不存在的同形串", LEDGER, "L. round256 终验（be07d9a）", "L. round256 终验（" + "be07d9" + "b）");
// M2 造一个【新的、不在豁免表里】的腐烂引用（证明豁免表不是万能放行口）。
mutate("M2 插入一个全新腐烂哈希", LEDGER, "O. round259（0055）", "O. round259（" + "dead" + "c0de" + "）");
// M3 把 40 位的真 blob 引用改一位 —— 长度规则不该救它，必须红。
mutate("M3 40位 blob 引用改末位", LEDGER, "真实 HEAD blob 3b7d385e", "真实 HEAD blob " + "3b7d3" + "85f");

// —— 乙类：不该红的别红（否则它会变成另一个恒红信号）——
// M4 追加一行【纯散文】（没有 hex）⇒ 不该影响判据。
mutate("M4 追加无 hash 的散文不应触发", LEDGER, "O. round259（0055）", "O. round259（0055）追加一行散文说明", false);
// M5 采集面下限：把 token 数打掉（注释掉 walk 的扩展名匹配）⇒ 下限那条必须红。
//    这条改的是【脚本自己】，验的是「索引塌了会不会假绿」。
mutate("M5 walk 采集面塌掉 ⇒ 下限必须红", SCRIPT, `else if (/\\.(txt|md|mjs)$/.test(e)) acc.push(full);`, `else if (/\\.never$/.test(e)) acc.push(full);`);

// —— 丙类：本轮【新加的放行口】必须有探针，否则「新判据更严」只是我自己说的话 ——
//
// ⚠⚠ 这一类【不能】用「把某个哈希写进替换串」的写法。实测踩过三次（本轮）：
//     探针源码里的【裸 7+hex 字面量】本身就在被扫目录里 ⇒ 探针一落地就把基线弄红/弄脏。
//     第一版的 M8 就是这么造出一条真腐烂报出来的（红因是探针自己，不是判据）；
//     连我【写这条警告的注释本身】都因为举了个真例子而把基线弄红一次 —— 红因是注释。
//     所以丙类改成【运行时从文件里取真前缀、就地改末位】，源码里【一个 hex 字面量都不留】，
//     连举例也不行（要举例就把它拆开写）。
const MATRIX = ".workbuddy/round255-append-digest-matrix-evidence.txt";

/** 在【无摘要措辞】的那一行里，把运行时取到的真摘要前缀改末位 ⇒ 熵放行口必须仍红。
 *  为什么这一发非做不可：①c 甲档放过的依据是【概率】（位数够长 ⇒ 改坏后撞不中索引），
 *  而本轮之前没有任何证据说明「改坏一位」真的会掉出索引。若它仍然绿，
 *  最坏的解释是熵判据把腐烂也放了 —— 那正是本轮要写进文档的那个假绿。 */
function mutateTailDigest(label, file, lineAnchor) {
  const abs = join(ROOT, file);
  const src = BASELINE.get(file) ?? readFileSync(abs, "utf8");
  if (!BASELINE.has(file)) BASELINE.set(file, src);
  if (readFileSync(abs, "utf8") !== src) {
    results.push({ label, verdict: "DIRTY-ENTRY" });
    console.log("  DIRTY-ENTRY  " + label);
    process.exitCode = 1;
    return;
  }
  const lines = src.split(/\r?\n/);
  const hits = lines
    .map((l, i) => [i, l])
    .filter(([, l]) => l.includes(lineAnchor));
  if (hits.length !== 1) {
    results.push({ label, verdict: "ANCHOR-AMBIGUOUS" });
    console.log("  ANCHOR-AMBIGUOUS  " + label + "  命中 " + hits.length + " 行");
    return;
  }
  const [li, line] = hits[0];
  // 运行时取真前缀（>=16 位，确保落在甲档门槛之上），不在源码里留字面量
  const m = line.match(/\b[0-9a-f]{16,}\b/);
  if (!m) {
    results.push({ label, verdict: "ANCHOR-MISS" });
    console.log("  ANCHOR-MISS  " + label + "  那一行没有长 hex 前缀可改");
    return;
  }
  const good = m[0];
  const badHash = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  if (lines.some((l, i) => i !== li && l.includes(good))) {
    results.push({ label, verdict: "ANCHOR-AMBIGUOUS" });
    console.log("  ANCHOR-AMBIGUOUS  " + label + "  该前缀在别处也出现，改了不唯一");
    return;
  }
  lines[li] = line.replace(good, badHash);
  writeFileSync(abs, lines.join("\n"), "utf8");
  const first = run();
  let restored = false;
  for (let i = 0; i < 6 && !restored; i++) {
    try {
      writeFileSync(abs, src);
      restored = readFileSync(abs, "utf8") === src;
    } catch {
      spawnSync("node", ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)"]);
    }
  }
  if (!restored) {
    results.push({ label, verdict: "RESTORE-FAIL" });
    console.log("  RESTORE-FAIL " + label + "  ← ⚠ " + file + " 留在改坏状态");
    process.exitCode = 1;
    return;
  }
  const again = run();
  const pass = first.red && !again.red;
  results.push({ label, verdict: pass ? "PASS" : "FAIL" });
  console.log("  " + (pass ? "PASS" : "FAIL") + "  " + label + "  (改坏红=" + first.red + " 还原绿=" + !again.red + ")");
  if (!pass) console.log("      ↳ 熵放行口把【改坏一位的真摘要前缀】放过了 = 假绿");
}

// 矩阵表那一行是 `roundNN 还原后 | <16位前缀> | 路径 | MATCH` 的表形，
// 【行内没有】sha256/摘要/注入 等字样（只有上面的表头才有）⇒ ③ 不会先放过它，
// 这一发测的确实是 ①c 甲档而不是 ③。（第一版 M7/M8 就错在选了带「注入前」的行，
//  ③ 先跳过 ⇒ 探针测不到它声称的那条判据，会给出假的 FAIL。）
mutateTailDigest("M6 真摘要前缀改末位 ⇒ 熵放行口必须仍红", MATRIX, "round242 还原后");

/* M7：①d 那条判据【自己】的探针 ——「离一个真提交只差一位 ⇒ 算腐烂」。
 * 与前六发手法不同：它测的是【注入的形状】而不是文档里的既有引用，
 * 所以做法是【新建一个临时 .txt 进被扫目录 → 跑 → 删】，不改任何真文件
 * ⇒ 没有还原负担，也不进上面那个逐字节自检的名单（它压根没碰那些文件）。
 * 三发对应本轮实测到的三条【静默假绿】（都曾在跳过桶里被放过、且不点名）：
 *   甲 字母形 7 位改末位 —— 原先同一行只要出现「对照」就被 ③ 放过；
 *   乙 数字形 7 位改末位 —— 原先走到 ④c 被「纯数字」放过；
 *   丙 真提交 id 后面多打一位 —— 原先被 ② 的「位数 > 对象 id」无条件放过。
 * ⚠ 真提交 id 全部由 git 现取 ⇒ 源码里一个 hex 字面量都不留（见上面那条纪律）。
 * ⚠ 验收不止「红」：必须【点名被注入的那一串】、且红因里给出它撞中的真提交，
 *   否则又是一发「红了但红因与注入无关」的假探针（0053 那一族）。 */
const TMP = join(ROOT, ".workbuddy", "zz-probe-nearmiss.txt");
const gitOut = (a) =>
  spawnSync("git", a, { cwd: ROOT, encoding: "utf8" }).stdout.trim();
const flipLast = (s) => s.slice(0, -1) + (s.endsWith("0") ? "1" : "0");
const SHORTS = gitOut(["log", "--all", "--format=%h"]).split(/\r?\n/).filter(Boolean);
// 一个纯数字的 7 位前缀 + 一个含字母的，各自改末位 ⇒ 两种形状各一发
const NUM7 = SHORTS.find((h) => /^[0-9]{7}$/.test(h));
const HEX7 = SHORTS.find((h) => /^[0-9a-f]{7}$/.test(h) && /[a-f]/.test(h));
const HEAD40 = gitOut(["rev-parse", "HEAD"]);
function injectNearMiss(label, line, tok) {
  let first;
  try {
    writeFileSync(TMP, line + "\n", "utf8");
    first = run();
  } finally {
    try {
      unlinkSync(TMP);
    } catch {}
  }
  const again = run();
  const named = first.out.includes(tok);
  const saysWhy = /离真提交 [0-9a-f]{7,40}/.test(first.out);
  const pass = first.red && named && saysWhy && !again.red;
  results.push({ label, verdict: pass ? "PASS" : "FAIL" });
  console.log(
    "  " + (pass ? "PASS" : "FAIL") + "  " + label +
      "  (改坏红=" + first.red + " 点名=" + named + " 给出真提交=" + saysWhy + " 还原绿=" + !again.red + ")",
  );
  if (!pass)
    console.log(
      "      ↳ 期望：红 + 点名被注入串 + 红因给出撞中的真提交 + 删掉后回绿；实得见上",
    );
}
injectNearMiss(
  "M7-甲 字母形提交引用改末位 ⇒ 必须红（措辞救不了）",
  "基线提交对照表：" + flipLast(HEX7) + "（终验）恢复绿",
  flipLast(HEX7),
);
injectNearMiss(
  "M7-乙 数字形提交引用改末位 ⇒ 必须红（纯数字桶不许静默放过）",
  "基线提交 " + flipLast(NUM7) + " 之后归档",
  flipLast(NUM7),
);
injectNearMiss(
  "M7-丙 真提交 id 后面多打一位 ⇒ 必须红（长度规则不许放掉）",
  "还原校验 " + HEAD40 + "0 已比对",
  HEAD40 + "0",
);

console.log("\n--- 汇总 ---");
for (const r of results) console.log(r.verdict.padEnd(18), r.label);
const passed = results.filter((r) => r.verdict === "PASS").length;
console.log("PASS " + passed + " / " + results.length);

let dirty = 0;
for (const [f, src] of BASELINE) {
  if (readFileSync(join(ROOT, f), "utf8") !== src) {
    dirty++;
    console.log("\n!!! 收尾自检失败：" + f + " 与基线不一致 !!!");
  }
}
if (dirty) process.exitCode = 1;
else console.log("\n收尾自检：" + [...BASELINE.keys()].join(" / ") + " 与探针启动时逐字节一致");
