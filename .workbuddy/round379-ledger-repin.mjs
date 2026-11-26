// 台账过期坐标的【原地加批注】（round379 四件套之④）。
// 为什么不改原文：台账是逐轮证据，round368 写下的 64px/1484 在它自己那一轮是真的。
// 所以旧主张一个字不动，紧随其块插一条【坐标重钉 · round379】，把新坐标与新理由落在原地。
// 每条插入的锚点必须全文件恰好命中 1 次，否则宁可不写（插错位比不插更糟——下一个人会信它）。
// 用法：node .workbuddy/round379-ledger-repin.mjs
import { readFileSync, writeFileSync } from "node:fs";

const LEDGER = "D:/item/opc/.workbuddy/AUDIT-LEDGER.txt";
const src = readFileSync(LEDGER, "utf8");

const ANNOTATIONS = [
  {
    id: "9198 workspace 64px",
    anchor:
      "    没有一栏是「视口高 + 自己滚」，滚的变成整个文档（documentElement 900 → 1472）。\n",
    add:
      "    【坐标重钉 · round379】那行 height 现在是 calc(100vh - var(--topbar-height))" +
      "（group.css:581），\n" +
      "      --topbar-height 已从 64 收到 52（:235）；640 窄档另有一条刻意的 57px 配对" +
      "（.topbar:1528 与\n" +
      "      .workspace:1543 同档同值），「顶栏只有一处来源」由 test/web/compact-scale.test.ts ① 承重。\n",
  },
  {
    id: "9304 W4 正文宿主 ≤1484",
    anchor:
      "  教训一句话：为了让判据绿而放宽的东西，判据本身要能把「放宽的那一步」剪红，\n" +
      "  否则它不叫判据，叫永久豁免。\n",
    add:
      "  【坐标重钉 · round379】上面 W4 三断里的第三断「正文宿主 ≤ 1484（= 1540 − 2×28 内边距）」\n" +
      "    已不存在：round370 铺满翻向后 W4 改成「文档页宽 == 主区宽」" +
      "（doc-layout.spec.ts:587–589），\n" +
      "    1540 上限只剩反向那一发在其余路由上守（maxW == \"1540px\" 且 ≤1540，:714–716）。\n" +
      "    别照这段旧文去 spec 里找 1484。\n",
  },
  {
    id: "10170/10172 kind-icon 坐标与 58 地板账",
    anchor:
      "  写 line-height:0 之后标题塌成 0、copy 只剩 18.19，行盒仍读 58" +
      "（round376-rowbox.log / round376-rowowner.log）。\n",
    add:
      "  【坐标重钉 · round379】.kind-icon 现在在 group.css:718（写这段时在 :560）；" +
      "该行的 padding 已收到\n" +
      "    8px 9px ⇒ 原语「padding 20 + 地板 38 = 行盒 58」现为「16 + 38 = 54」（地板 38 未动）。" +
      "round379\n" +
      "    之后 T4 拆成两根：T4b 整行 <60 只兜地板总量，T4a 用 prevH ≤ fontSize×1.45 直接量预览盒\n" +
      "    （spec 文件头有归因；证据 round379-rowbox-after.log + round379-t4-mutations.log Q1–Q3）。\n",
  },
  {
    id: "10213 T4 阈值 58.33 账",
    anchor:
      "  T4 阈值取 60 不取 58：58.33 离 38px 地板只差 0.33px，" +
      "贴 60 边取整会因亚像素抖动随机红（round376-rowbox.log）。\n",
    add:
      "  【round379 更新】此处的 58.33 是当时 padding 20 的账；padding 收到 16 后同式读 54.33，\n" +
      "    阈值 60 原样保留作地板余量档。摘 line-height 在整行只差 0.19px" +
      "（54.33→54.14，见\n" +
      "    round379-rowbox-after.log），那一根已移交 T4a 量预览盒本身" +
      "（Q1–Q3 KILLED、Q4 预期存活，\n" +
      "    round379-t4-mutations.log）。\n",
  },
];

let out = src;
let bad = 0;
for (const a of ANNOTATIONS) {
  const hits = out.split(a.anchor).length - 1;
  if (hits !== 1) {
    console.log(`${a.id}: 锚点命中 ${hits} ⇒ 放弃整批写入`);
    bad += 1;
    continue;
  }
  if (out.includes(a.add)) {
    console.log(`${a.id}: 批注已在位 ⇒ 跳过（幂等）`);
    continue;
  }
  out = out.replace(a.anchor, a.anchor + a.add);
  console.log(`${a.id}: 已插入`);
}
if (bad > 0) process.exit(1);

const fffd = out.split("\uFFFD").length - 1;
console.log(`FFFD_COUNT ${fffd}`);
if (fffd !== 0) {
  console.log("含 U+FFFD ⇒ 不落盘");
  process.exit(1);
}
writeFileSync(LEDGER, out, "utf8");
console.log("写入完成");
