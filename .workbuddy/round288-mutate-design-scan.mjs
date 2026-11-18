// round288 变异机：doc-refs 新扫主设计文档这一半【有没有牙齿】。
//
// 为什么必须跑它：本轮把设计文档接进 decisionDocs()，跑完全绿。
// 而「接进来 + 全绿」有两解：① 引用确实都对；② 我接的那一行根本没生效
// （比如 map 键没对上、正则没命中、异常被吞）。这两解在终端上长得一模一样。
// 本仓为这一族撞过不止一次 —— 判据坏起来的形状不像判据坏了。
//
// 三发变异各打一个不同的失效面：
//   M1 坐标漂一行        ⇒ 证明 verify() 真的在读主文档的那些引用
//   M2 文件改成不存在的  ⇒ 证明「找不到」这一支也覆盖到主文档（不只是「不符」）
//   M3 引用整条删掉      ⇒ 证明「快照里有而文档没有」也覆盖（否则删引用是无声的）
// 每发跑完立刻逐字节回滚；回滚不干净就抛，不把改动留在树上。
//
// ⚠ M1 的预期串【第一版写错了】，而错得有价值：我原本写「与快照不符」，实测打出的是
//   一对 —— `:157 快照里没有这条引用` + `:158 快照里有，文档里已经没有`。
//   原因是**键里就含行号**（keyOf = doc>file:line），所以漂一行不是「同一格内容变了」
//   而是「一格消失、另一格冒出来」。⇒ 「与快照不符」这一支只有【内容改了而行号没改】
//   才会走到，而改文档里的行号永远走不到它。读法：
//   **漂行号与改内容在快照里是两个不同的失效面，别指望一发变异覆盖两个。**
// ⚠ 第二版错在【读输出】：`out.match(/OPC-OS-…/)` 命中的是 `AssertionError: expected '…t…'`
//   那一行，而 vitest 把它截断成 `prompt.test.t…` ⇒ 三发变异【全打了红】却被打成「未命中」。
//   匹配对象换成整段输出（真消息在 `+ Received` 那一行里，没截断）。
//   ⇒ 与 round286 的 ①② 同一族：探针有输出、输出也对，错在我读它的那一层。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DOC = "docs/OPC-OS-功能优化设计.md";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const orig = readFileSync(DOC, "utf8");

const MUTANTS = [
  {
    id: "M1 坐标漂一行（活的引用改错行号）",
    from: "（`memory/prompt.test.ts:158`，写目录是因为仓库里有两个",
    to: "（`memory/prompt.test.ts:157`，写目录是因为仓库里有两个",
    expect: ["快照里没有这条引用", "快照里有，文档里已经没有"],
  },
  {
    id: "M2 文件改成不存在的（走「找不到」那一支）",
    from: "`recorder.ts:393`",
    to: "`recorder-nope.ts:393`",
    expect: ["找不到"],
  },
  {
    id: "M3 整条引用删掉（快照该变孤儿）",
    from: "`roles/charter.test.ts:439` 那一发",
    to: "`roles/charter.test.ts` 那一发",
    expect: ["快照里有，文档里已经没有"],
  },
];

function runGuard() {
  const r = spawnSync("npx", ["vitest", "run", "test/arch/doc-refs.test.ts"], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
  // 本仓 round286 撞过的坑：Windows 上进程没起来时 status 是 null，
  // 而脚本会照常打印「没红」——那正是本轮要证的反面。宁可炸，不要安静地交「无」。
  if (r.status === null) {
    throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  }
  return (r.stdout + r.stderr).replace(ANSI, "");
}

const base = runGuard();
if (!/2 passed/.test(base)) {
  throw new Error("基线不是全绿，变异跑它没有意义。前 400 字：\n" + base.slice(0, 400));
}
console.log("基线: doc-refs 2 发全绿");

const hits = [];
for (const m of MUTANTS) {
  if (!orig.includes(m.from)) {
    throw new Error(`变异 ${m.id} 的锚文本不在原文里 —— 变异机自己坏了：${m.from}`);
  }
  writeFileSync(DOC, orig.replace(m.from, m.to), "utf8");
  let out = "";
  try {
    out = runGuard();
  } finally {
    writeFileSync(DOC, orig, "utf8");
    if (readFileSync(DOC, "utf8") !== orig) {
      throw new Error("回滚后与原文不一致 —— 立刻人工检查 " + DOC);
    }
  }
  const red = /FAIL|failed/.test(out);
  // 读【`+ Received` 那一行】而不是 AssertionError 那一句：后者被 vitest 截断成
  // `prompt.test.t…`，拿它做匹配会把三发红打成「未命中」（文件头第二版那条）。
  const got = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+ ") && l.includes("OPC-OS-"))
    .join(" ㊣ ");
  const miss = m.expect.filter((e) => !got.includes(e));
  hits.push({
    id: m.id,
    red,
    matched: miss.length === 0,
    line: (got === "" ? "(Received 行里没有主文档的坐标)" : got).slice(0, 190),
  });
}

console.log("\n变异读数：");
for (const h of hits) {
  console.log(
    `${h.red && h.matched ? "命中" : "未命中"}  ${h.id}\n        ${h.line}`,
  );
}
const bad = hits.filter((h) => !h.red || !h.matched);
console.log(
  `\n结论：${hits.length} 发变异，命中 ${hits.length - bad.length}，未命中 ${bad.length}` +
    (bad.length === 0
      ? " ⇒ 主文档这一半的扫描【有牙齿】：漂行、找不到、删引用三支都能红。"
      : " ⇒ 至少一支打不红，本轮那句「接进来了」不算证完。"),
);
console.log("还原：与原文逐字一致");
