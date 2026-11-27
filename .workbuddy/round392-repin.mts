/**
 * round392 坐标重钉：0074/0075/0076 引用的 group.js 坐标因本轮 +36 行整体位移，
 * 0077 自己的坐标按新字节换号。逐条点名替换，命中数必须 == 预期，否则抛。
 */
import { readFileSync, writeFileSync } from "node:fs";

const D = "docs/decisions/";
const F0074 =
  D +
  "0074-avatar-upload-never-worked-a-dedupe-key-one-dimension-short-and-a-ui-with-no-uploader.md";
const F0075 = D + "0075-template-library-had-a-display-and-no-producer.md";
const F0076 = D + "0076-search-had-seven-faces-and-six-ui-slots.md";
const REFS = "test/arch/doc-refs.test.ts";

/** [文件, 旧串, 新串, 预期命中次数][] */
const JOBS: Array<readonly [string, string, string, number]> = [
  // 0074/0075/0076 的 group.js 坐标 +36（文档散文与 SNAP 键逐字同尺寸平移）
  [F0074, "group.js:6158", "group.js:6194", 1],
  [F0075, "group.js:3834", "group.js:3870", 2],
  [F0075, "group.js:4079", "group.js:4115", 1],
  [F0075, "group.js:8562", "group.js:8598", 1],
  [F0076, "group.js:6350", "group.js:6386", 1],
  [F0076, "group.js:8898", "group.js:8934", 1],
  [F0076, "group.js:8899", "group.js:8935", 1],
  [F0076, "group.js:8949", "group.js:8985", 1],
  [F0076, "group.js:8952", "group.js:8988", 1],
  [REFS, "group.js:6158", "group.js:6194", 1],
  [REFS, "group.js:3834", "group.js:3870", 1],
  [REFS, "group.js:4079", "group.js:4115", 1],
  [REFS, "group.js:8562", "group.js:8598", 1],
  [REFS, "group.js:6350", "group.js:6386", 1],
  [REFS, "group.js:8898", "group.js:8934", 1],
  [REFS, "group.js:8899", "group.js:8935", 1],
  [REFS, "group.js:8949", "group.js:8985", 1],
  [REFS, "group.js:8952", "group.js:8988", 1],
];

const texts = new Map<string, string>();
for (const [file, find, repl, expected] of JOBS) {
  const cur = texts.get(file) ?? readFileSync(file, "utf8");
  const hits = cur.split(find).length - 1;
  if (hits !== expected) {
    throw new Error(
      file + " :: " + find + " 命中 " + hits + " 次，预期 " + expected,
    );
  }
  texts.set(file, cur.split(find).join(repl));
}
for (const [file, text] of texts) {
  writeFileSync(file, text, "utf8");
  console.log("写入 " + file);
}
