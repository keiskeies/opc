/**
 * round393 坐标重钉：0074/0075/0076/0077 引用的 group.js 坐标因本轮 +78 行整体位移，
 * 逐条按【当前真实行内容】重新 grep 过再替换（不按 diff 行数推算）。命中数必须 == 预期，
 * 否则抛。文档散文与 SNAP 同名键一起改、快照值（该行内容）不动。
 */
import { readFileSync, writeFileSync } from "node:fs";

const D = "docs/decisions/";
const F0074 =
  D +
  "0074-avatar-upload-never-worked-a-dedupe-key-one-dimension-short-and-a-ui-with-no-uploader.md";
const F0075 = D + "0075-template-library-had-a-display-and-no-producer.md";
const F0076 = D + "0076-search-had-seven-faces-and-six-ui-slots.md";
const F0077 = D + "0077-chat-history-had-a-paging-cursor-and-no-producer.md";
const REFS = "test/arch/doc-refs.test.ts";

/** [文件, 旧串, 新串, 预期命中次数][] */
const JOBS: Array<readonly [string, string, string, number]> = [
  // 0074 avatarImagePicker
  [F0074, "group.js:6194", "group.js:6272", 1],
  [REFS, "group.js:6194", "group.js:6272", 1],
  // 0075 backlogMutation（文档两处：病灶 + 落地）/ 新建模板按钮 / 弹窗本体
  [F0075, "group.js:3870", "group.js:3948", 2],
  [F0075, "group.js:4115", "group.js:4193", 1],
  [F0075, "group.js:8598", "group.js:8676", 1],
  [REFS, "group.js:3870", "group.js:3948", 1],
  [REFS, "group.js:4115", "group.js:4193", 1],
  [REFS, "group.js:8598", "group.js:8676", 1],
  // 0076 侧栏点群 / 行上身份 attribute 两枚 / 两条落点
  [F0076, "group.js:6386", "group.js:6464", 1],
  [F0076, "group.js:8934", "group.js:9012", 1],
  [F0076, "group.js:8935", "group.js:9013", 1],
  [F0076, "group.js:8985", "group.js:9063", 1],
  [F0076, "group.js:8988", "group.js:9066", 1],
  [REFS, "group.js:6386", "group.js:6464", 1],
  [REFS, "group.js:8934", "group.js:9012", 1],
  [REFS, "group.js:8935", "group.js:9013", 1],
  [REFS, "group.js:8985", "group.js:9063", 1],
  [REFS, "group.js:8988", "group.js:9066", 1],
  // 0077 loadMessages / loadOlderMessages / 顶端按钮 / 行上 data-seq
  [F0077, "group.js:2024", "group.js:2089", 1],
  [F0077, "group.js:2076", "group.js:2154", 1],
  [F0077, "group.js:2499", "group.js:2577", 1],
  [F0077, "group.js:2552", "group.js:2630", 1],
  [REFS, "group.js:2024", "group.js:2089", 1],
  [REFS, "group.js:2076", "group.js:2154", 1],
  [REFS, "group.js:2499", "group.js:2577", 1],
  [REFS, "group.js:2552", "group.js:2630", 1],
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
