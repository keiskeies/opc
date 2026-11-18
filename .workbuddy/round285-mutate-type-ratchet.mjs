// round285 · 类型棘轮的六发变异（打在【判据自己】身上）
//
// 跑法：npx tsx .workbuddy/round285-mutate-type-ratchet.mjs
//
// 为什么必须打在判据上：本仓量过三次（round274-M3 / round276-G4 / round278-C3）
// 「真仓库那一发对『判据被改成不判』是完全瞎的」。它的期望就是照着今天的读数写的，
// 今天必然绿。所以这六发没有一改生产代码 —— 改的全是 test/arch/test-type-baseline.ts。
//
// 六发各自对应一种【真实的失效方向】，不是随机改符号：
//   M1 容差 10 条        —— 棘轮还在，只是松了；红话仍然会报，只是要涨 11 条才报。
//   M2 新目录不再点名    —— 判据「改成不判」那一族的本体：分支留着，动作摘掉。
//   M3 目录不归一分隔符  —— Windows 上全部塌进 `.`；本仓守卫自己的夹具第一轮就这样红。
//   M4 不匹配的行静默丢  —— 「少报」方向：棘轮上少报是【绿】，所以这一族只能靠变异拿。
//   M5 语料下限算上依赖  —— 哨兵还在跑，但它数的不再是本仓语料，include 改窄照样过。
//   M6 空壳豁免永不报    —— 「豁免不许比现实活得久」那条主张变成散文。
//
// 约束（同前几轮）：锚点必须逐字命中【一次】；跑完逐字节还原并核对。
// 这个文件是 .mjs ⇒ 里面【不许】有 TS 类型断言（esbuild 解析不了）。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "test/arch/test-type-baseline.ts";
const SUITE = "test/arch/test-type-baseline.test.ts";
const REPORT = ".workbuddy/.mut-type.json";
const original = readFileSync(TARGET, "utf8");

/** 锚点必须逐字命中一次；命中 0 次或多次都直接停 —— 空变异比没有变异更坏。 */
function once(src, anchor) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      "锚点命中 " + n + " 次（需要恰好 1 次）：" + anchor.slice(0, 70),
    );
  }
  return src;
}

const MUTANTS = [
  {
    name: "M1 超出判定加 10 条容差（棘轮还在，只是不判小涨）",
    expect: "至少『某目录多一条 ⇒ 红』与『总量降而某目录涨 ⇒ 红』那两发红",
    apply(src) {
      const anchor = 'if (n > allowed) over.push(dir + " " + allowed + "→" + n);';
      once(src, anchor);
      return src.replace(
        anchor,
        'if (n > allowed + 10) over.push(dir + " " + allowed + "→" + n);',
      );
    },
  },
  {
    name: "M2 基线外的新目录不再点名（分支留着，动作摘掉）",
    expect: "『新目录点名』『新目录藏在后面』『配额表被清空』三发红",
    apply(src) {
      const anchor =
        'unregistered.push(dir + "=" + n);\n      continue;';
      once(src, anchor);
      return src.replace(anchor, "continue;");
    },
  },
  {
    name: "M3 dirOf 不归一路径分隔符（Windows 上全塌进 `.`）",
    expect: "凡是用 join() 造合成路径的那几发红",
    apply(src) {
      // 目标行原文是 `const p = file.split("\\").join("/");`（两个反斜杠字符）。
      // 字符串字面量里要写四个才出两个 —— 写两个会变成一个，锚点命中 0 次。
      const anchor = '  const p = file.split("\\\\").join("/");';
      once(src, anchor);
      return src.replace(anchor, "  const p = file;");
    },
  },
  {
    name: "M4 解析不出来的诊断行静默丢弃（少报 = 棘轮上的绿方向）",
    expect: "『解析不出来的行【计数】』那发红（unparsed 期望 1 实得 0）",
    apply(src) {
      const anchor = "if (!/^(?:\\S.*?: )?error TS\\d+:/u.test(line)) continue;";
      once(src, anchor);
      return src.replace(anchor, "if (!DIAG.test(line)) continue;");
    },
  },
  {
    name: "M5 filesChecked 把 node_modules 也算进语料（哨兵数的不再是本仓）",
    expect: "『--listFilesOnly 只数本仓自己的 .ts』那发红（期望 3 实得 5）",
    apply(src) {
      const anchor = 'if (rel.split("/").includes("node_modules")) continue;';
      once(src, anchor);
      return src.replace(
        anchor,
        '// 变异：不排依赖\n    if (false) continue;',
      );
    },
  },
  {
    name: "M6 空壳豁免永远报不出来（『豁免不许比现实活得久』变成散文）",
    expect: "『某目录修到 0 条 ⇒ 报请把豁免删掉』那发红",
    apply(src) {
      const anchor = "return baseline\n    .filter((b) => (counts.get(b.dir) ?? 0) === 0)";
      once(src, anchor);
      return src.replace(
        anchor,
        "return baseline\n    .filter(() => false)",
      );
    },
  },
];

function runSuite() {
  spawnSync(
    "npx",
    ["vitest", "run", SUITE, "--reporter=json", "--outputFile=" + REPORT],
    { shell: true, encoding: "utf8" },
  );
  let j;
  try {
    j = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    return null;
  }
  const failed = [];
  let total = 0;
  for (const t of j.testResults ?? []) {
    for (const a of t.assertionResults ?? []) {
      total += 1;
      if (a.status === "failed") failed.push(a.title);
    }
  }
  return { failed, total };
}

console.log("基准：" + SUITE);
const base = runSuite();
if (base === null) {
  writeFileSync(TARGET, original, "utf8");
  throw new Error("基准读不到报告，停。");
}
console.log("  " + base.total + " 发，红 " + base.failed.length + "（必须是 0）");
if (base.failed.length !== 0) {
  writeFileSync(TARGET, original, "utf8");
  throw new Error("基准不绿，后面的读数不可信 —— 先修基准");
}

for (const mut of MUTANTS) {
  let mutated;
  try {
    mutated = mut.apply(original);
  } catch (e) {
    console.log("\n" + mut.name + "\n  ⇒ 【锚点不符，这一发不算】" + String(e.message));
    continue;
  }
  if (mutated === original) {
    console.log("\n" + mut.name + "\n  ⇒ 【空变异，这一发不算】");
    continue;
  }
  writeFileSync(TARGET, mutated, "utf8");
  const r = runSuite();
  if (r === null) {
    console.log("\n" + mut.name + "\n  ⇒ 【读不到报告，这一发不算】");
    continue;
  }
  console.log("\n" + mut.name + "\n  ⇒ 红 " + r.failed.length + " / " + r.total);
  for (const n of r.failed) console.log("     · " + n);
  if (r.failed.length === 0) {
    console.log("     ⚠ 全绿 ⇒ 这一格【没有分母】，那句主张是假的。期望：" + mut.expect);
  }
}

writeFileSync(TARGET, original, "utf8");
const back = readFileSync(TARGET, "utf8");
console.log(
  "\n已还原 " + TARGET + "：" + (back === original ? "与原文逐字一致" : "【不一致，立刻人工核对】"),
);
