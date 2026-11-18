// 一次性：把登记表里每一条的【登记行号】按 claim-coords 自己报出的当前命中行改回去。
// 为什么用脚本而不是手改：手改等于用「我记得加了几行」去推坐标，而这条守卫存在的理由
// 正是【不许推】（0057 §最后一条：同一轮里同一个坐标按推断错过两次）。
// 取值规则：改成【离旧行号最近】的那一处命中 —— 锚点句多命中时（主张正文 + O14 表里那一行），
// 旧行号落在哪一侧就说明登记的是哪一处，一律取第一条会把它改成另一处。
// ⚠ 定位必须带 id 一起锚：只按 `line: 137,` 这种短模式替换，会撞上别的条目里
//    恰好相同的数字（第一轮我就这么写的，改之前查了重复值才发现）。
// ⚠ 本文件是 .mjs，跑它要 `npx tsx`，里面不许有 TS 标注。
import { readFileSync, writeFileSync } from "node:fs";
import { coordDrifts } from "../test/arch/claim-coords.ts";
import { REGISTRY } from "../test/arch/claims-registry.ts";

const TARGET = "test/arch/claims-registry.ts";
const readDoc = (doc) => readFileSync(doc, "utf8").split(/\r?\n/);

const drifts = coordDrifts(REGISTRY, readDoc);
const allLines = REGISTRY.map((e) => e.source.line);
const dup = allLines.filter((l, i) => allLines.indexOf(l) !== i);
console.log("登记表里重复的 line 值：" + (dup.length > 0 ? dup.join(",") : "无"));

let src = readFileSync(TARGET, "utf8");
const applied = [];
const skipped = [];
for (const d of drifts) {
  if (d.located.length === 0) {
    skipped.push(d.id + "：全文无命中（锚点句要人工看）");
    continue;
  }
  const near = d.located.reduce((best, l) =>
    Math.abs(l - d.recorded) < Math.abs(best - d.recorded) ? l : best,
  );
  // 从本条 id 起往后找第一处 line: 旧值 ⇒ 不会串到别的条目。
  const idAt = src.indexOf('id: "' + d.id + '"');
  if (idAt === -1) {
    skipped.push(d.id + "：找不到 id");
    continue;
  }
  const re = /line:\s*(\d+)\s*,/;
  const m = re.exec(src.slice(idAt));
  if (m === null) {
    skipped.push(d.id + "：id 之后找不到 line: 数字");
    continue;
  }
  if (Number(m[1]) !== d.recorded) {
    skipped.push(
      d.id + "：id 之后第一条 line 是 " + m[1] + "，登记的是 " + d.recorded,
    );
    continue;
  }
  const at = idAt + m.index;
  src =
    src.slice(0, at) + "line: " + near + "," + src.slice(at + m[0].length);
  // 打印用的是 `recorded` 而不是 `line`：漂移对象上没有 `line` 这个字段，
  // 读它会安安静静打印「undefined → 1662」—— 修对了，但【改前的值】在这份日志里丢了。
  // 这条脚本唯一产出的就是「哪条坐标从几漂到几」，丢了这个等于日志只剩结论。
  applied.push(d.id + " " + d.recorded + " → " + near);
}
writeFileSync(TARGET, src);
console.log(applied.join("\n"));
if (skipped.length > 0) console.log("未改：\n" + skipped.join("\n"));
console.log("改动 " + applied.length + " 条 / 漂移 " + drifts.length + " 条");
