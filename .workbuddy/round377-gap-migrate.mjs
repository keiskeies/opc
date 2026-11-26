// E 级：把散装 gap 折到 --space-* 刻度上（一次性迁移脚本，跑完即归档）。
//
// 取档规则（写在 group.css 间距刻度注释里，这里只是执行它）：
//   取最近的一档；正好落在两档正中（6/10/14/18）时【取较小的那档】。
//   为什么向下：卡片【内部】的间距（10/14 这两档用得最多）折上去会 >= 卡片【之间】
//   的间距（12/16），内间距压过外间距，分组关系就倒了。向下则永远保持「内 < 外」。
//   2px / 3px 留在裸数字：那是亚档微调，不进刻度。
//   两值写法（gap: 5px 8px）这里不碰 —— 行/列分开定档要逐条判断，交给手工改。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TIER = {
  5: "1", 6: "1", 7: "2", 8: "2", 9: "2", 10: "2",
  11: "3", 12: "3", 13: "3", 14: "3", 15: "4", 16: "4",
  17: "4", 18: "4", 20: "5",
};

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("用法：node 本脚本 <css 文件>…");

for (const f of files) {
  const path = resolve(f);
  const lines = readFileSync(path, "utf8").split("\n");
  const notes = [];
  const out = lines.map((line, i) => {
    // 只动真的声明行：这一轮的 gap 注释全部单独成行、不带花括号。
    if (!line.includes("{")) return line;
    const next = line.replace(/(^|[\s;])(gap:\s*)(\d+)px(?=\s*[;}])/gu, (_m, pre, head, v) => {
      const tier = TIER[Number(v)];
      if (!tier) return _m;
      notes.push(`  ${i + 1}: gap ${v}px → var(--space-${tier})`);
      return `${pre}${head}var(--space-${tier})`;
    });
    return next;
  });
  writeFileSync(path, out.join("\n"), "utf8");
  console.log(`${path}: 命中 ${notes.length} 处`);
  console.log(notes.join("\n"));
}
