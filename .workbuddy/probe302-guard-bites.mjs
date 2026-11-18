// round302 一次性验证：常跑守卫 test/arch/mutation-parser-screen.test.ts 里
// round302 新加的那两支持不承重？—— 把 round294 的【格③】真抹掉，守卫必须转红。
// 抹的是真字节，每型跑完立刻回滚并逐字节核对（跑这台时不许并发别的写入者）。
//
// 两型各抹一次，因为它们试探的是守卫里【不同的那一支】：
//   甲 整段删掉 ⇒ 试探「不变量③ 逐台判计数型必须抛」+「切片里找不到格③ 锚点」两支
//   乙 只把匹配判式改坏（方括号那型再也匹配不上）⇒ 试探【行为】那一支：
//      锚点还在、语句还在，只是恒不成立 —— 这才是「日后有人改坏它」的真实形状。
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REL = ".workbuddy/round294-mutate-add-node.mjs";
const path = join(ROOT, REL);
const orig = readFileSync(path, "utf8");

const SEG_START =
  "  const deadFiles = [];\n" +
  '  for (const deadLine of clean.split("\\n")) {\n' +
  "    const deadHit = /^\\s*FAIL\\s+(\\S+)\\s+\\[\\s*(\\S+)\\s*\\]\\s*$/u.exec(deadLine);\n" +
  "    if (deadHit !== null && deadHit[1] === deadHit[2]) deadFiles.push(deadHit[1]);\n" +
  "  }\n" +
  "  if (deadFiles.length > 0) {\n";
const MATCH = "if (deadHit !== null && deadHit[1] === deadHit[2])";

/** 锚点必须【恰好一次】，否则不许抹。 */
function once(text, anchor, name) {
  const at = text.indexOf(anchor);
  if (at === -1) throw new Error("锚点找不到（" + name + "）⇒ 那台改了写法，本验证要跟着改");
  if (text.indexOf(anchor, at + 1) !== -1) throw new Error("锚点命中两次（" + name + "）");
  return at;
}

/** 甲：整段（含那个 throw）删掉。 */
const deleteWhole = () => {
  const start = once(orig, SEG_START, "整段");
  const redLine = once(orig, "只有这一格认得它", "那一格的红话");
  const end = orig.indexOf("\n  }\n", redLine);
  if (end === -1) throw new Error("找不到那一格的收尾");
  const out = orig.slice(0, start) + orig.slice(end + 5);
  if (out.includes("deadFiles")) throw new Error("没抹干净");
  return out;
};

/** 乙：只让匹配恒不成立（语句与锚点都留着）。 */
const breakMatcher = () => {
  once(orig, MATCH, "匹配判式");
  const out = orig.replace(MATCH, "if (deadHit !== null && false)");
  if (!out.includes("if (deadFiles.length > 0) {")) throw new Error("锚点被顺手抹了");
  return out;
};

const strip = (s) => s.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"), "");

const variants = [
  ["甲 整段删掉格③", deleteWhole],
  ["乙 只改坏匹配判式", breakMatcher],
];

let allRed = true;
for (const [name, make] of variants) {
  const punched = make();
  try {
    writeFileSync(path, punched, "utf8");
    const r = spawnSync(
      process.execPath,
      [
        join(ROOT, "node_modules", "vitest", "vitest.mjs"),
        "run",
        "test/arch/mutation-parser-screen.test.ts",
      ],
      { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
    );
    const red = r.status !== 0;
    allRed = allRed && red;
    console.log(
      "\n════ " + name + " ⇒ 守卫退出码 " + r.status + " ⇒ " +
        (red ? "【转红】（这就是要的）" : "【仍然全绿】⇒ 那一支是装饰"),
    );
    const picked = strip(String(r.stdout) + String(r.stderr))
      .split("\n")
      .filter((l) => /戊|格③|AssertionError|Tests +\d+ failed/u.test(l))
      .map((l) => l.trim())
      .filter((l) => l !== "")
      .slice(0, 8);
    console.log(picked.join("\n"));
  } finally {
    writeFileSync(path, orig, "utf8");
    const back = readFileSync(path, "utf8") === orig;
    console.log("   回滚后字节一致 = " + back);
    if (!back) allRed = false;
  }
}
console.log("\n两型都让守卫转红 = " + allRed);
process.exitCode = allRed ? 0 : 1;
