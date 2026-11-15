// round258 变异探针：证明 no-native-deps 遍历容错的每条新断言都有判别力。
//
// 为什么必须跑：本轮新增的断言全在测「目录在遍历途中消失」。而那次竞态实测
// 8 次高压并行 + 5 次整轮跑一次都没复现 —— 撞不响的绿灯不能当作「有判别力」。
// 唯一的办法是把被测代码改坏，看它是不是真的会红。
//
// 每一发的做法：改坏一处 → 跑该测试文件 → 断言它【红】→ 字节级还原 → 断言还原后【绿】。
// 任何一发「改坏了却还是绿」，就说明对应那条断言恒真，本轮工作即告失败。
//
// 用法：node .workbuddy/round258-racefix-mutate.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const TARGETS = ["test/arch/no-native-deps.test.ts", "test/arch/no-native-deps.ts"];

// 基线是【探针启动那一刻的字节】，不是 HEAD —— 本轮改的就是这两个文件，它们相对
// HEAD 本来就有改动。所以「还原」与收尾自检都照这个基线比。
const BASELINE = new Map(TARGETS.map((t) => [t, readFileSync(join(ROOT, t), "utf8")]));

const TEST_FILE = "test/arch/no-native-deps.test.ts";

function run() {
  const r = spawnSync("npx", ["vitest", "run", TEST_FILE], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { red: r.status !== 0, out: (r.stdout || "") + (r.stderr || "") };
}

const results = [];
function mutate(label, file, find, replace) {
  const abs = join(ROOT, file);
  const before = BASELINE.get(file);
  // 上一发没还原干净的话，这一发的「改坏 → 还原」不成立，立即停手。
  if (readFileSync(abs, "utf8") !== before) {
    results.push({ label, verdict: "DIRTY-ENTRY" });
    console.log("  DIRTY-ENTRY  " + label + "  ← 进场时 " + file + " 已不是基线");
    process.exitCode = 1;
    return;
  }
  if (!before.includes(find)) {
    results.push({ label, verdict: "ANCHOR-MISS" });
    console.log("  ANCHOR-MISS  " + label + "  ← 锚点串不在文件里，这一发没打中");
    return;
  }
  writeFileSync(abs, before.replace(find, replace));
  const first = run();
  // 还原用「写回原字节 + 逐字节核对」而不是删文件：round185 量过 Windows 上句柄未
  // 释放会让写/删 EPERM，而这里中途抛出去的代价是【改坏的源码留在树上】。
  let restored = false;
  for (let i = 0; i < 6 && !restored; i++) {
    try {
      writeFileSync(abs, before);
      restored = readFileSync(abs, "utf8") === before;
    } catch {
      spawnSync("node", [
        "-e",
        "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000)",
      ]);
    }
  }
  if (!restored) {
    results.push({ label, verdict: "RESTORE-FAIL" });
    console.log("  RESTORE-FAIL " + label + "  ← 树被留在改坏的状态，手工修 " + file);
    process.exitCode = 1;
    return;
  }
  const again = run();
  const ok = first.red && !again.red;
  results.push({ label, verdict: ok ? "PASS" : "FAIL" });
  console.log(
    "  " +
      (ok ? "PASS" : "FAIL") +
      "  " +
      label +
      "  (改坏红=" +
      first.red +
      " 还原绿=" +
      !again.red +
      ")",
  );
  if (!ok && !first.red) console.log("      ↳ 改坏后仍绿：\n" + first.out.slice(-1200));
}

// 基线必须先是绿的，否则「改坏了变红」不能归因于这一发变异。
const base = run();
console.log("baseline green: " + !base.red);
if (base.red) {
  console.log(base.out.slice(-3000));
  console.log("ABORT: 基线就是红的，先修基线");
  process.exit(1);
}

const PRED =
  "export function readdirSurvives(readdir: () => unknown[]): boolean {\n" +
  "  try {\n" +
  "    readdir();\n" +
  "    return true;\n" +
  "  } catch (e) {\n" +
  "    const code = (e as { code?: string }).code;\n" +
  '    if (code === "ENOENT" || code === "ENOTDIR") {\n' +
  "      return false;\n" +
  "    }\n" +
  "    throw e;\n" +
  "  }\n" +
  "}";

// 1) 判据恒真：读不动也当读得动 → ENOENT/ENOTDIR 那两条必须红
mutate(
  "判据恒返回 true（吞掉一切）",
  "test/arch/no-native-deps.ts",
  PRED,
  "export function readdirSurvives(readdir: () => unknown[]): boolean {\n  readdir();\n  return true;\n}",
);

// 2) 判据恒假：什么都不扫 → 所有正对照必须红
mutate(
  "判据恒返回 false（什么都不扫）",
  "test/arch/no-native-deps.ts",
  PRED,
  "export function readdirSurvives(_readdir: () => unknown[]): boolean {\n  return false;\n}",
);

// 3) 宽容过头：权限类错误也吞 —— survivesStat 注释点名的「真的假绿」方向
mutate(
  "判据连权限错误一起吞",
  "test/arch/no-native-deps.ts",
  '    if (code === "ENOENT" || code === "ENOTDIR") {\n      return false;\n    }\n    throw e;',
  "    void code;\n    return false;",
);

// 4) 接线接反：null 判断写反 → 真目录返回空、缺失目录去 readdir → 两条都红
mutate(
  "walk 的 null 判断写反",
  TEST_FILE,
  "  if (entries === null) return out;",
  "  if (entries !== null) return out;",
);

// 5) 假清单替身：readdirOrNull 不调注入进来的 readdir，直接给空数组 →
//    真磁盘那发与合成那发都必须红
mutate(
  "readdirOrNull 不调 readdir，直接返回空",
  TEST_FILE,
  "      entries = readdir(dir);\n      return entries;",
  "      return [];",
);

// 6) 【原缺陷复现】readdirOrNull 退回不带保护的样子。本轮唯一一发复现 0053 §7
//    原始失效模式的变异：它证明新加的合成那发真的抓得到那次 ENOENT。
mutate(
  "readdirOrNull 退回无保护（原缺陷复现）",
  TEST_FILE,
  "  let entries: DirEntryLike[] = [];\n  if (\n    !readdirSurvives(() => {\n      entries = readdir(dir);\n      return entries;\n    })\n  )\n    return null;\n  return entries;",
  "  return readdir(dir);",
);

// 7) 注入被绕开：walk 内部改用真 readdirSync，忽略调用方传的假清单 →
//    合成那发必须红（否则「可注入」只是装饰，测试传进来的东西根本没被用）。
mutate(
  "walk 忽略注入、硬用真 readdirSync",
  TEST_FILE,
  "  const entries = readdirOrNull(dir, readdir);",
  "  const entries = readdirOrNull(dir, realReaddir);",
);

// 8) 递归处丢注入：子层拿不到调用方的假清单 → 合成那发必须红
mutate(
  "递归处丢掉注入的 readdir",
  TEST_FILE,
  "      walk(full, readdir, out);",
  "      walk(full, realReaddir, out);",
);

console.log("\n--- 汇总 ---");
for (const r of results) console.log(r.verdict.padEnd(13), r.label);
const passed = results.filter((r) => r.verdict === "PASS").length;
console.log("PASS " + passed + " / " + results.length);

// 收尾自检：不管中间出过什么，离开前树上的被测文件必须与基线字节一致。
const dirty = TARGETS.filter((t) => readFileSync(join(ROOT, t), "utf8") !== BASELINE.get(t));
if (dirty.length > 0) {
  console.log("\n!!! 收尾自检失败：以下文件与基线不一致，必须手工还原 !!!\n" + dirty.join("\n"));
  process.exitCode = 1;
} else {
  console.log("收尾自检：被测文件与探针启动时字节一致");
}
