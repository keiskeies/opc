// round278：证明 claim-coords 抓得住【今天真发生过的那种漂】。
// 今天的真故障不是"有人改错行号"，是"往 §5 插了一段 ⇒ §7 全体下移 35 行 ⇒ r10–r13 静默 STALE"。
// 所以变异必须打在【文档】上（插一行），而不是打在 registry 上（改一个数）——
// 后者是人手动犯错，前者是日常编辑的副作用，而后者才是没人会察觉的那一种。
// 自回滚：改前留字节，改后逐文件核对，跑完必须与改前逐字节相同。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = process.cwd();
const DOC = "docs/OPC-OS-功能优化设计.md";
const TEST = "test/arch/claim-coords.test.ts";
const strip = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"), "");

function run(file) {
  const r = spawnSync("npx", ["vitest", "run", file], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  });
  const out = strip((r.stdout || "") + (r.stderr || ""));
  const m = /Tests\s+(\d+) failed \| (\d+) passed \((\d+)\)/.exec(out);
  const failed = /FAIL\s+.*>\s+(.+)/.exec(out);
  return {
    failed: m ? Number(m[1]) : -1,
    passed: m ? Number(m[2]) : -1,
    firstFail: failed ? failed[1].trim() : "",
  };
}

const DOC_BEFORE = readFileSync(ROOT + "/" + DOC, "utf8");
const TEST_BEFORE = readFileSync(ROOT + "/" + TEST, "utf8");

const MUTS = [
  {
    name: "C1 往 §5 插一行（复现今天：§7 全体下移，登记行号没跟着动）",
    file: DOC,
    apply: (t) => t.replace("## 6. 明确不做（以及为什么）", "（这里插了一行）\n\n## 6. 明确不做（以及为什么）"),
    minRed: 1,
    expect: "claim-coords",
  },
  {
    name: "C2 把某条主张的锚点句在文档里改掉（住址没错、句子换了）",
    file: DOC,
    apply: (t) => t.replace("没有任何代码能把它写成 0", "没有任何代码能把它写成零"),
    minRed: 1,
    expect: "全文无命中",
  },
  {
    name: "C3 掏空判据：coordDrifts 恒返回空",
    file: TEST,
    applyNull: true,
    minRed: 1,
    expect: "claim-coords",
  },
];

function applyC3() {
  // 打在判据文件上：coordDrifts 循环体改成什么都不 push。
  const src = readFileSync(ROOT + "/test/arch/claim-coords.ts", "utf8");
  const from = "    if (located.includes(e.source.line)) continue;";
  if (!src.includes(from)) throw new Error("C3 锚点找不到，判据形状变了");
  writeFileSync(ROOT + "/test/arch/claim-coords.ts", src.replace(from, "    if (located) continue;"));
}

const results = [];
try {
  for (const mut of MUTS) {
    if (mut.applyNull) applyC3();
    else {
      const target = mut.file === DOC ? DOC_BEFORE : TEST_BEFORE;
      const next = mut.apply(target);
      if (next === target) throw new Error(mut.name + "：锚点没命中，变异未生效");
      writeFileSync(ROOT + "/" + mut.file, next);
    }
    const got = run("test/arch/claim-coords.test.ts");
    results.push({ name: mut.name, ...got, ok: got.failed >= mut.minRed });
    // 回滚本发
    if (mut.applyNull) writeFileSync(ROOT + "/test/arch/claim-coords.ts", readFileSync(ROOT + "/test/arch/claim-coords.ts", "utf8").replace("    if (located) continue;", "    if (located.includes(e.source.line)) continue;"));
    else writeFileSync(ROOT + "/" + mut.file, mut.file === DOC ? DOC_BEFORE : TEST_BEFORE);
  }
} finally {
  writeFileSync(ROOT + "/" + DOC, DOC_BEFORE);
  writeFileSync(ROOT + "/" + TEST, TEST_BEFORE);
}

const afterDoc = readFileSync(ROOT + "/" + DOC, "utf8");
const afterTest = readFileSync(ROOT + "/" + TEST, "utf8");
console.log(
  JSON.stringify(
    {
      results,
      reverted: afterDoc === DOC_BEFORE && afterTest === TEST_BEFORE,
    },
    null,
    2,
  ),
);
