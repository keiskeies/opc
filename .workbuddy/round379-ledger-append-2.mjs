// round379 台账收尾：把「变异机全停之后」的复量与守卫读数追加进 round379 条目末尾。
// 写法照既有纪律：锚点必须唯一命中，否则整批不落盘；非 ASCII 不过 shell，落盘前数 U+FFFD。
import { readFileSync, writeFileSync } from "node:fs";

const LEDGER = ".workbuddy/AUDIT-LEDGER.txt";
const ANCHOR = "  biome 净新增 0（新类目 3 条已登记，见 round378 条）；compact-scale 单跑 31/31。\n";

const BLOCK = [
  "",
  "【复量与守卫收尾（2026-11-27 凌晨，两台变异机全停之后）】",
  "  · 文档编辑区预算复量：round379-budget-after.log（复用只读探针 round378-budget.mjs，",
  "    9797、视口 1440×900、暗色）。表格画布 h=714.8 占视口高 79.4% / Markdown 编辑面 668.8",
  "    占 74.3% / 富文本 .ql-editor 574.8 占 63.9%；Markdown 四档视口 1440/1100/900/640 的",
  "    横向溢出全为 0。⚠ 「占视口高百分之几」【不立守卫】：它是 #view 高与 .doc-page 内距",
  "    两路输入的商，任何一路动一下它就必须动 —— 钉住它就重蹈 round377 那条。",
  "  · verify-open-invariants 先【红】后绿，红的是我自己刚写的台账散文：新条目里",
  "    「新基线」后面那枚 sha256 前缀被 ③ 判成腐烂提交引用。③ 只看 token 左边 40 字符内",
  "    token 左边 40 字符内有没有「sha256/摘要/对照」声明 —— 块首那句声明管不到第二行",
  "    （round375 那条纪律的第四次复发）。修在【写法】侧不动判据：ledger-append.mjs 与台账",
  "    两处各补一行内 sha256 声明，复扫 SUCCESS（按声明跳过 58→60）。这一红本身是那条",
  "    判据仍在承重的证据。",
  "  · 守卫族 test/arch 全跑 35 文件：550 passed，两发失败都是 sheet-editor 那一摊",
  "    （probe-sheet.spec.ts 不被任何 runner 收 + test/e2e 的 29 个类型错在 TYPE_BASELINE 外，",
  "    见上），本轮的台账写入与 doc-preview / compact-scale 新文件没有新增红；",
  "    lint-baseline 单跑 12/12。",
  "  · biome 归因按【规则名逐条比】不看总计数：app.js 当前对 HEAD 是 -1 条（noUnusedImports",
  "    那发在 round377 落地时就没了），useOptionalChain 5 / noAssignInExpressions 1 逐条同 HEAD；",
  "    本轮新文件带的 format 与 organizeImports 落在 LINT_BASELINE 的 format=161 /",
  "    organizeImports=117 上限内（那张表按类目上限判、不要求追平计数）⇒ 净新增 0 成立。",
  "  · 快照对账：group.css 的 sha256 ceb32a94c97b、group.js 的 sha256 df73e97b03b7、",
  "    markdown.js 的 sha256 9470aa5fb256 与 r3 变异机「收摊」行逐字一致；",
  "    round379-whitespace-audit-after.out 在注释类改动落地之后重跑【逐字节相同】⇒ 前后对账",
  "    仍是同一对可信抓拍，不必重抓（这条不是偷懒：注释改了字节，SHA 与抓拍都得重新对得上）。",
].join("\n");

const text = readFileSync(LEDGER, "utf8");
if (text.includes("\u3010\u590d\u91cf\u4e0e\u5b88\u536b\u6536\u5c3e")) {
  console.log("已追加过 ⇒ 跳过");
  process.exit(0);
}
const hits = text.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.log(`锚点命中 ${hits} 处（要恰好 1）⇒ 不落盘`);
  process.exit(2);
}
const next = text.replace(ANCHOR, ANCHOR + BLOCK + "\n");
const bad = [...next].filter((c) => c === "\uFFFD").length;
if (bad !== 0) {
  console.log(`新文本含 ${bad} 个 U+FFFD ⇒ 不落盘，先按码位修`);
  process.exit(3);
}
writeFileSync(LEDGER, next, "utf8");
console.log(`已追加 ${BLOCK.split("\n").length - 1} 行；台账行数 ${next.split("\n").length}；FFFD ${bad}`);
