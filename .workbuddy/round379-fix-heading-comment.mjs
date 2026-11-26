// round379 注释订正：.list-heading 那段里有两处不实的量化主张（「每一路由都占 72.2」是改前值、
// 「落到 16 与 18 两档」是算式不是读数），且 old_string 匹配不上（段内含不可复现字符），
// 所以按行号整段替换。行号：634..642（1-based，含首尾）。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/web/public/group.css";
const START = 634;
const END = 642;

const NEW = [
  "/* 列表栏头部 18/10 → 12/8（round379）：这一格改前每一路由都占 72.2px（18 路实测全等），",
  "   而它只装一个 18px 标题 + 一行 11px 说明；改后 64.2，省下的 8px 直接变成第一条条目的可见性。",
  "   仍保持【上 > 下】：栏头与它下面第一条是同一组，下缘压得紧贴才读得出「这行字管下面这列」。",
  "   横向 17 本轮一位未动，但也别把它读成「与条目文字对齐」的承重格 —— 量过了：以栏头标题",
  "   文字左缘为基准取差值，.member-row 的文字比栏头偏左 1、.doc-list-item 偏右 1，会话列表里",
  "   条目最靠左的文字是头像之后的标题（偏右 41）。即 17 谁也没对齐，那 1px 参差 round379",
  "   之前就存在，本轮没制造它、也没修它。",
  "   17 现在的唯一理由是「它是 8 路共同的现状」：动它，标题相对条目高亮块（左缘 8）重新缩进。",
  "   grep 过 test/ 无任何一发断言读 .list-heading，所以它是【现状】不是【判据】。 */",
];

const lines = readFileSync(FILE, "utf8").split("\n");
const head = lines[START - 2]; // 窗口前一行的注释尾
const rule = lines[END]; // 窗口后第一行 = .list-heading 规则本身
// 自证锚点：替换窗口必须正好包住那条规则的前后行，否则行号已漂，宁可不改。
if (!head.includes(".admin-mount-nav")) {
  throw new Error(`行号已漂：第 ${START - 1} 行不是预期的前一行，实际 = ${head}`);
}
if (!rule.startsWith(".list-heading {")) {
  throw new Error(`行号已漂：第 ${END + 1} 行不是 .list-heading 规则，实际 = ${rule}`);
}
if (!lines[END + 1].startsWith(".list-heading h1")) {
  throw new Error(`行号已漂：第 ${END + 2} 行不是 .list-heading h1，实际 = ${lines[END + 1]}`);
}

const out = [...lines.slice(0, START - 1), ...NEW, ...lines.slice(END)];
writeFileSync(FILE, out.join("\n"), "utf8");
console.log(`REPLACED 行 ${START}..${END} → ${NEW.length} 行`);
const text = readFileSync(FILE, "utf8");
const R = String.fromCharCode(0xfffd);
console.log("FFFD_COUNT " + (text.match(new RegExp(R, "g")) || []).length);
