// round277：安全边界守卫的变异证据（自恢复）。
//
// 五发，各打一条这一轮新立的判据。跑法是每发单独 apply → 跑
//   npx vitest run test/arch/role-spawn-boundary.test.ts packages/hub/test/engine/claude.test.ts
// → 记下哪几发红 → revert。
//
//  B1 真的把 plan 换成 bypassPermissions
//     ⇒ 预期：守卫红【且】claude.test.ts 那两发行为探针红。
//       这一发是本轮最重要的一条：它证明「唯一生效的安全边界」这句话现在有【两层】
//       看着（静态判据 + 真起子进程的行为探针），不是只有一层。
//  B2 把「唯一生效的安全边界」那句诚实标注改掉
//     ⇒ 预期：只有守卫的第三格红，claude.test.ts 全绿。
//       这一发证明第三格不是重复：边界没动、行为测试看不见，只有「读的人被误导」红。
//  B3 新增一个【字面上叫 spawn】的起进程位置
//     ⇒ 预期：只有第一格红，且红话点名是谁。方向与 B1/B2 相反 ——
//       它防的是「新开一个不受判据管的口子」，而新开口子时那三格可以全都是绿的。
//  B4 把守卫的相邻判据换成「文件里有 plan 就算」
//     ⇒ 预期：真仓库那一发【全绿】，只有合成夹具 B2 那一发红。
//       本仓第四次记同一课：真仓库的断言对「判据被改成不判」是瞎的。
//  B5 新增一个【字面不叫 spawn】的起进程位置（import { spawn as run }）
//     ⇒ 预期：【全绿】。这一发【不是】用来证明守卫有效，是用来把那条【已知余量】
//       钉成一个读数：判据认的是 `spawn(` 这个词，改名就看不见。
//       写在这里是因为「承认余量」这句话如果只活在注释里，下一轮就会有人以为已经堵住了。
//
// 用法：node .workbuddy/round277-boundary-mutate.mjs apply B1|B2|B3|B4|B5
//       node .workbuddy/round277-boundary-mutate.mjs revert
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const SRC = "packages/hub/src/engine/claude.ts";
const GUARD = "test/arch/role-spawn-boundary.ts";
const NEW1 = "packages/hub/src/engine/b3-probe.ts";
const NEW2 = "packages/hub/src/engine/b5-probe.ts";

/**
 * 每一条是 [文件, 原文, 换成][]。原文为 null ⇒ 【新建】这个文件，revert 时删掉它。
 * 锚点必须【恰好出现一次】，否则拒绝施加。
 */
const MUTS = {
  B1: [[SRC, '"--permission-mode",\n    "plan",', '"--permission-mode",\n    "bypassPermissions",']],
  B2: [[SRC, "唯一生效的安全边界", "唯一的安全边界"]],
  B3: [
    [
      NEW1,
      null,
      "// B3：一个【新开的】起子进程位置，不经过 engine/claude.ts 那条边界。\n" +
        'import { spawn } from "node:child_process";\n' +
        'const p = spawn(process.execPath, ["-e", "0"]);\n' +
        "p.kill();\n",
    ],
  ],
  B4: [[GUARD, 'return k >= 0 && s[k + 1] === "plan";', 'return k >= 0 && s.includes("plan");']],
  B5: [
    [
      NEW2,
      null,
      "// B5：同样开了一个口子，但【字面不叫 spawn】⇒ 判据看不见（已知余量）。\n" +
        'import { spawn as run } from "node:child_process";\n' +
        'const p = run(process.execPath, ["-e", "0"]);\n' +
        "p.kill();\n",
    ],
  ],
};

const origin = (key) => ".workbuddy/round277-boundary-orig-" + key + ".txt";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const edits = MUTS[key];
  if (edits === undefined) throw new Error("B1…B5，实到 " + key);
  const before = new Map();
  for (const [file, from, to] of edits) {
    if (from === null) {
      let exists = true;
      try {
        readFileSync(file, "utf8");
      } catch {
        exists = false;
      }
      if (exists) throw new Error(key + " 要新建的 " + file + " 已经在了，拒绝覆盖");
      before.set(file, to);
      continue;
    }
    const src = before.get(file) ?? readFileSync(file, "utf8");
    const n = src.split(from).length - 1;
    if (n !== 1)
      throw new Error(key + " 锚点在 " + file + " 出现 " + n + " 次，不是恰好一次，拒绝施加");
    before.set(file, src.replace(from, to));
  }
  writeFileSync(
    origin(key),
    JSON.stringify(
      edits.map(([file, from]) => [
        file,
        from === null ? null : readFileSync(file, "utf8"),
      ]),
    ),
  );
  for (const [file, text] of before) writeFileSync(file, text);
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    for (const [file, text] of JSON.parse(orig)) {
      if (text === null) {
        rmSync(file, { force: true });
        try {
          readFileSync(file, "utf8");
          throw new Error(key + " 声称删掉的 " + file + " 还在");
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        continue;
      }
      writeFileSync(file, text);
      if (readFileSync(file, "utf8") !== text) {
        throw new Error(key + " 还原后逐字节核对失败：" + file);
      }
    }
    any = true;
    console.log("已还原 " + key + " 并逐文件核对一致");
    // 核对通过才删原件：还原失败时原件必须留着，否则这一发就永久烙在文件里了。
    rmSync(origin(key), { force: true });
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply B1…B5 | revert");
}
