// 一次性对账脚本：claims-registry 的 source.line 与设计文档当前行号是否还对得上。
import { readFileSync } from "node:fs";
const reg = readFileSync("test/arch/claims-registry.ts", "utf8");
const doc = readFileSync("docs/OPC-OS-功能优化设计.md", "utf8").split(/\r?\n/);
// ⚠ 第三个「漏一条长得像全都对了」：id 正则原先写的是 (r\d) —— 一位数。
//   登记到 r10 那天，这一发【静默跳过 r10】，输出与「十条全对」逐字一样。
//   修法不是只把 \d 改成 \d+，还要补下面那条【条数自证】：探针自己数出几条，
//   必须等于 registry 里的 id 个数，否则【少打印】这件事本身就会红。
//   前两版各自踩过「反引号读不到」与「单引号跳过一条」，三次是同一个病的三种形状。
const re =
  /id: "(r\d+)"[\s\S]*?line: (\d+),\s*\n\s*sentence:\s*\n?\s*("(?:[^"\\]|\\.)*"|`[^`]*`|'(?:[^'\\]|\\.)*')/g;
const declared = [...reg.matchAll(/id:\s*"(r\d+)"/g)].map((x) => x[1]);
const printed = new Set();
let m;
while ((m = re.exec(reg)) !== null) {
  const id = m[1];
  printed.add(id);
  const line = Number(m[2]);
  let sent;
  try {
    // 单引号那条【不是合法 JSON】：转成双引号包裹再解析。
    // 探针第二版踩过一次：正则原先只认双引号与反引号，于是 r6（单引号）整条被跳过，
    // 而它的 id 与【下一条】的 line/sentence 拼在一起打印 ⇒ 打印出来的「r6 old=979」
    // 其实是 r7 的坐标，r6 真正的 97 那一行【从未被核对过】却显示成 OK。
    // 「漏了一条」在这里长得和「全都对了」一样，与它检查的那类句子是同一个病。
    sent = JSON.parse(m[3].startsWith("'") ? '"' + m[3].slice(1, -1) + '"' : m[3]);
  } catch {
    sent = m[3].slice(1, -1);
  }
  const first = String(sent).split("\n")[0].slice(0, 30);
  // ⚠ 探针自己踩过一次坑，读数比被它检查的句子更容易过期：
  //   registry 里的 sentence 是【不带反引号】手写的，而文档原文带 `code` 反引号
  //   ⇒ 精确子串匹配恒 0 命中，于是 r2/r3/r4/r5/r6 每次打印成「now@」（空白）。
  //   空白在这里【不是】「坐标丢了」的信号，而是「探针读不到」—— 而这两件事
  //   在输出上长得一模一样，正是本仓反复登记的那一族（否定式读数先怀疑问的位置）。
  //   所以两边各去掉反引号再比；剩下的空白才是真的没找到。
  const bare = (s) => s.replace(/`|\*\*/gu, "");
  const needle = bare(first);
  const hits = doc
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => bare(l).includes(needle))
    .map(([n]) => n);
  const atRecorded = bare(doc[line - 1] ?? "").includes(needle);
  console.log(
    id,
    atRecorded ? "OK" : "STALE",
    "old=" + line,
    "now@" + hits.join(","),
    "[" + first + "]",
  );
}

// 条数自证：打印的集合必须【正好】等于 registry 里声明的 id 集合。
const missing = declared.filter((id) => !printed.has(id));
const extra = [...printed].filter((id) => !declared.includes(id));
console.log(
  "\n声明 " + declared.length + " 条 / 打印 " + printed.size + " 条 ⇒ " +
    (missing.length === 0 && extra.length === 0
      ? "自洽（没有条目被静默跳过）"
      : "不自洽！漏打印 [" + missing.join(",") + "] 多余 [" + extra.join(",") + "]"),
);
if (missing.length > 0 || extra.length > 0) process.exitCode = 1;
