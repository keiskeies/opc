// 核对两件事：
// ① SNAP 里每条 group.js 键的值 == 【当前】物理行（守卫会查的同一件事，这里独立复算一遍）；
// ② 「重钉只搬键名、0 条值被改」的机械版 —— HEAD 每条键按 +6 分档搬到位且值逐字相同，
//    新增键必须逐条点名，多余的意外新增当场报出。
// SNAP 是 biome 排版的 JS 字面量（含 `"` 的行用单引号），手搓正则解析器已证不可靠 ⇒ 直接求值对象体。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = "D:/item/opc";
const open = (t) => {
  const at = t.indexOf("const SNAP: Record<string, string> = {");
  if (at < 0) throw new Error("找不到 SNAP 开头");
  const body = t.slice(at + "const SNAP: Record<string, string> = ".length);
  const end = body.indexOf("\n};");
  if (end < 0) throw new Error("找不到 SNAP 收尾");
  // 只取对象字面量本身，后面的模块代码不参与求值。
  return new Function(`return ${body.slice(0, end + 3)};`)();
};

const cur = readFileSync(`${ROOT}/packages/web/public/group.js`, "utf8").split("\n");
const head = execSync("git show HEAD:packages/web/public/group.js", {
  cwd: ROOT,
  maxBuffer: 1 << 28,
})
  .toString()
  .split("\n");
const at = (arr, n) => (arr[n - 1] ?? "").trim();

for (const n of [3275, 3281, 3287]) {
  console.log(`now:${n}  = ${JSON.stringify(at(cur, n))}`);
  console.log(`HEAD:${n} = ${JSON.stringify(at(head, n))}`);
}
console.log(`HEAD:3275 == now:3281 ? ${at(head, 3275) === at(cur, 3281)}`);
console.log(`HEAD:3281 == now:3287 ? ${at(head, 3281) === at(cur, 3287)}`);

const B = open(readFileSync(`${ROOT}/test/arch/doc-refs.test.ts`, "utf8"));
const A = open(
  execSync("git show HEAD:test/arch/doc-refs.test.ts", { cwd: ROOT, maxBuffer: 1 << 28 }).toString(),
);

let checked = 0;
let bad = 0;
for (const [k, v] of Object.entries(B)) {
  const m = k.match(/>packages\/web\/public\/group\.js:([0-9]+)$/u);
  if (!m) continue;
  checked += 1;
  if (v !== at(cur, Number(m[1]))) {
    bad += 1;
    console.log(`⛔ 值 != 物理行：${k}\n   SNAP=${JSON.stringify(v)}\n   LINE=${JSON.stringify(at(cur, Number(m[1])))}`);
  }
}
console.log(`① group.js 键逐条对当前物理行：校验 ${checked} 条、不符 ${bad} 条`);

const SHIFT_AFTER = 3022; // group.js 本轮唯一 hunk：@@ -3022,0 +3023,6 @@
const shift = (ln) => ln + (ln > SHIFT_AFTER ? 6 : 0);
let moved = 0;
let broken = 0;
for (const [k, v] of Object.entries(A)) {
  const m = k.match(/^(.*>packages\/web\/public\/group\.js:)([0-9]+)$/u);
  if (!m) {
    if (!(k in B)) {
      broken += 1;
      console.log(`⛔ 非 group.js 键消失了：${k}`);
    } else if (B[k] !== v) {
      broken += 1;
      console.log(`⛔ 非 group.js 键的值被改了：${k}`);
    }
    continue;
  }
  const nk = `${m[1]}${shift(Number(m[2]))}`;
  if (!(nk in B)) {
    broken += 1;
    console.log(`⛔ 旧键没搬到预期位置：${k} -> 期望 ${nk}`);
  } else if (B[nk] !== v) {
    broken += 1;
    console.log(`⛔ 搬了但值变了：${k} -> ${nk}`);
  } else moved += 1;
}

const DOC = "0086-meeting-detail-and-minutes-never-recorded-the-moment-it-ended.md";
const EXPECTED_NEW = [
  [DOC, "packages/contracts/src/meeting.ts", 51],
  [DOC, "packages/hub/src/documents/deposit.ts", 105],
  [DOC, "packages/hub/src/documents/deposit.ts", 132],
  [DOC, "packages/hub/src/meetings/service.ts", 136],
  [DOC, "packages/hub/src/meetings/service.ts", 139],
  [DOC, "packages/hub/src/meetings/service.ts", 236],
  [DOC, "packages/web/public/group.js", 80],
  [DOC, "packages/web/public/group.js", 3024],
  [DOC, "packages/web/public/group.js", 3123],
  [DOC, "test/e2e/group-workbench.spec.ts", 4541],
  [DOC, "test/e2e/group-workbench.spec.ts", 4671],
  ["INDEX.md", "packages/contracts/src/meeting.ts", 51],
  ["INDEX.md", "packages/hub/src/documents/deposit.ts", 105],
  ["INDEX.md", "packages/hub/src/documents/deposit.ts", 132],
  ["INDEX.md", "packages/hub/src/meetings/service.ts", 136],
  ["INDEX.md", "packages/web/public/group.js", 3024],
].map(([d, f, n]) => `${d}>${f}:${n}`);

const movedSet = new Set();
for (const k of Object.keys(A)) {
  const m = k.match(/^(.*>packages\/web\/public\/group\.js:)([0-9]+)$/u);
  if (m) movedSet.add(`${m[1]}${shift(Number(m[2]))}`);
}
const unexpected = Object.keys(B).filter((k) => !(k in A) && !movedSet.has(k) && !EXPECTED_NEW.includes(k));
const missingNew = EXPECTED_NEW.filter((k) => !(k in B));
console.log(
  `② 重钉核对：HEAD 键搬到位且值逐字相同 = ${moved} 条、破坏 = ${broken} 条；` +
    `点名新增 = ${EXPECTED_NEW.length} 条（缺失 ${missingNew.length}）、意外新增 = ${unexpected.length} 条`,
);
for (const k of missingNew) console.log(`  ⛔ 该建的键没建：${k}`);
for (const k of unexpected) console.log(`  ⛔ 没点名却出现了：${k}`);
console.log(`键总数：HEAD ${Object.keys(A).length} → 现在 ${Object.keys(B).length}`);
