/**
 * 提交话的【提交前】自检 —— round297 那一格的正解。
 *
 * commit-msg-refs 读的是 `git log --all`，它是【提交后】守卫：提交前跑多少遍全量，
 * 对「标题写没写错」都全聋（本轮就是这么红在历史里的）。
 * 这一台把它的【纯函数】拿来吃一份合成的 Entry：subject + body + 这次真的会碰的文件。
 * ⇒ 提交前就能知道那条消息落进历史后会不会红。
 *
 * 跑法（必须 tsx，不是 node —— 它 import 的是 .ts 判据；同 round283 那条教训）：
 *   npx tsx .workbuddy/check-commit-msg.mjs <消息文件> <这次要提交的文件…>
 * 例：  npx tsx .workbuddy/check-commit-msg.mjs D:/tmp/msg.txt test/arch/x.ts docs/INDEX.md
 * 只读，不改任何东西；红就退出 1 并说清红在哪。
 *
 * ⚠ 它【不代替】commit-msg-refs：那条读 git log --all，是权威；这一台只是【提前】问一次。
 *   两台共用同一个 check()，所以口径不会漂 —— 复制判据是另一类假绿（两处口径互相漂）。
 *
 * ⚠ 两台有一处【不可消除】的不对称，第一次真跑就撞上了（round297）：
 *   判据 B 的豁免键是「提交短号>编号」，而提交【前】那条短号还不存在 ⇒
 *   这一台遇到死引用时【没有任何合法豁免通道】，历史里已登记的 EXEMPT 也帮不上
 *   （那些键属于别的提交）。⇒ 它报红只有两种出路：改话，或提交后再改判据加豁免。
 *   后者正是本轮 ② 登记过的错（改判据放过自己刚犯的错），所以默认走前者。
 *   改话不一定等于删信息：判据的 DOC_ID 前后有字符类划界，实测
 *     「0099」→ 一次引用；「docs/decisions/0099-x.md」「0099-x」「v0099」→ 不算
 *   （路径形态本来就交给 decision-index 那节管）。所以【写文件名而不是裸编号】
 *   既保住信息又不冒充引用 —— 反过来，写「`0099`」加反引号【照样算】，别以为代码体是豁免。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  check,
  EXEMPT,
  existingIds,
  loadEntries,
  reservedIds,
} from "../test/arch/commit-msg-refs.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

const existing = new Set(existingIds(join(ROOT, "docs", "decisions")));
const reserved = new Set(
  reservedIds(readFileSync(join(ROOT, "docs", "INDEX.md"), "utf8")),
);

/**
 * 机器自己的自证：不打提交，只验【这台会不会红】这件事判得对。
 * 少了它，一台「恒返回不红」的自检能陪我一直错下去 —— 与本轮那条
 * 「提交前的全量对标题全聋」是同一个形状（round296/297 登记过）。
 * 分母【数出来】，不写死。
 */
function selfCheck() {
  const problems = [];
  let checks = 0;
  const run = (subject, files) =>
    check([{ hash: "f".repeat(40), subject, body: "", files }], existing, reserved, EXEMPT);
  // ① 正例：scope 不写号 ⇒ 两条判据都该过。
  const ok = run("fix(arch): 修一个东西", ["test/arch/x.ts"]);
  if (ok.length !== 0) problems.push("自证①：无害的标题被判红（这台会拦下所有提交）");
  checks += 1;
  // ② 本轮那一发的复刻：写 docs(0055) 而文件里没有那篇文档 ⇒ 【该红】。
  const lie = run("docs(0055): 台账加一段", [".workbuddy/AUDIT-LEDGER.txt"]);
  if (lie.length === 0) problems.push("自证②：scope 撒谎没被判出 ⇒ 这台是恒绿的废铁");
  else if (!lie[0].why.includes("scope 撒谎")) {
    problems.push("自证②：红了但不是红在 scope 那一支：" + lie[0].why);
  }
  checks += 1;
  // ③ 同一个号，文件里【有】那篇文档 ⇒ 该绿（证明判的是"碰没碰"，不是"写没写号"）。
  const honest = run("docs(0055): 台账加一段", ["docs/decisions/0055-x.md"]);
  if (honest.length !== 0) {
    problems.push("自证③：真碰了那篇文档还被判红 ⇒ 口径写成了『不许写号』：" + honest[0].why);
  }
  checks += 1;
  // ④ 死引用：一个不存在的号 ⇒ 该红（另一支判据也得有牙齿）。
  //    ⚠ 号是【量出来】的，不是随手写的：判据的 DOC_ID 是 `0[0-9]{3}`，
  //    我第一版写 9999 —— 它【压根不匹配那个正则】，于是那发是空变异，
  //    和 round295 那发「注释里写不带引号的 add_edge ⇒ 该红」同一个错。
  //    实测：docs/decisions 现有 65 个号（最大 0065），预约号 0002/0037/0038
  //    ⇒ 0099 既不存在也没被预约 ⇒ 它才是合法的死引用夹具。
  const dead = run("docs(0099): 提一个不存在的号", ["docs/decisions/0099-x.md"]);
  if (dead.length === 0) problems.push("自证④：死引用没被判出（0099 应既不存在也未预约）");
  else if (!dead[0].why.includes("死引用")) {
    problems.push("自证④：红了但不是红在死引用那一支：" + dead[0].why);
  }
  checks += 1;
  return { problems, checks };
}

const self = selfCheck();
if (self.problems.length > 0) {
  console.error("这台自检自己没通过，【结论不可用】：\n  " + self.problems.join("\n  "));
  process.exit(1);
}

const [msgFile, ...files] = process.argv.slice(2);
if (msgFile === undefined || files.length === 0) {
  console.error("用法：check-commit-msg.mjs <消息文件> <这次要提交的文件…>");
  process.exit(2);
}
const text = readFileSync(msgFile, "utf8");
const lines = text.split("\n");
const subject = (lines[0] ?? "").trim();
const body = lines.slice(1).join("\n").trim();

// 历史臂也带上：万一标题里的号在【过去某发】里是死的，那同样会红。
const history = loadEntries(ROOT);
const problems = check(
  [{ hash: "0".repeat(40), subject, body, files }],
  existing,
  reserved,
  EXEMPT,
);
const historyProblems = history.filter((e) =>
  check([e], existing, reserved, EXEMPT).length > 0,
);

console.log("机器自证 " + self.checks + "/" + self.checks + " 通过（无害标题绿 / scope 撒谎红 / 真碰了那篇绿 / 死引用红）");
console.log("标题：" + subject.slice(0, 72));
console.log("这次会碰：" + files.length + " 个文件");
if (problems.length === 0) {
  console.log("✓ 这一发落进历史后【不红】（两条判据都过）");
} else {
  console.log("✗ 这一发落进历史会红：");
  for (const p of problems) console.log("    · " + p.why);
}
if (historyProblems.length > 0) {
  console.log("⚠ 历史里另有 " + historyProblems.length + " 发红（不是这一发造成的）：");
  for (const e of historyProblems.slice(0, 5)) {
    console.log("    · " + e.hash.slice(0, 7) + " " + e.subject.slice(0, 60));
  }
}
process.exitCode = problems.length === 0 ? 0 : 1;
