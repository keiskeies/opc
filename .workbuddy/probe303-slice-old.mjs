// round303 一次性：把【旧字节】与【新字节】放在同一张表上对比 —— 旧实现不靠我抄，
// 用 `git show HEAD:` 切出来生成到 .workbuddy/probe303-old-safety.ts（那才是旧字节）。
// 然后 probe303-compare.probe.ts 同时 import 新旧两份，逐对打印「旧读数 → 新读数」。
//
// 为什么要有这台：本轮我把「交集口径的代价」写成了「文件名里带 \ 一律被拒」，探针证否；
// 接着我把 `/repo/ws\a` 写成「本轮多拦的那一型」——那也可能是假的【出处】：旧口径
// 也许本来就拒它。判据改了哪些行为，必须由新旧两份真字节对出来，不能由我推。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
// 参数是【定长数组】、无任何插值：别用 shell 字符串版（execSync 会把整条交给 shell）。
const src = execFileSync(
  "git",
  ["show", "HEAD:packages/hub/src/harness/safety.ts"],
  { cwd: ROOT, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);

const at = src.indexOf("export function isInsideWorkspace");
if (at === -1) throw new Error("切不到旧的 isInsideWorkspace ⇒ HEAD 变了，本探针要跟着改");
const end = src.indexOf("\n}", src.indexOf("function normalizeAbs", at));
if (end === -1) throw new Error("切不到旧的 normalizeAbs 收尾");
const oldText = src.slice(at, end + 2);
if (!oldText.includes('p.split("/")')) {
  throw new Error(
    "切出来的旧实现【不是】只按 / 拆的那一版 ⇒ HEAD 已经变了，本轮的「旧口径」主张要重查：\n" +
      oldText.slice(0, 200),
  );
}
writeFileSync(
  join(ROOT, ".workbuddy", "probe303-old-safety.ts"),
  "/** 由 probe303-slice-old.mjs 从 `git show HEAD:` 切出来的【旧字节】，别手改。 */\n" +
    oldText +
    "\n",
  "utf8",
);
console.log("旧实现已切出：" + oldText.split("\n").length + " 行，含 split(\"/\") 那一行 ✓");
