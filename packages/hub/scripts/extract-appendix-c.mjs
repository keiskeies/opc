// 从规格附录 C 机械提取 0001_init.sql（Task 0.5）。
//
// 运行：node packages/hub/scripts/extract-appendix-c.mjs
//
// 为什么脚本在仓库里：0001_init.sql 的正文必须能被证明「就是附录 C」，而不是
// 「某次手抄的结果」。手抄的差异要肉眼才能发现，而 schema 差异的表现形式是
// 「我机器正常、别人机器报 no such column」。有了本脚本，任何时刻都能重跑并 diff：
// 输出与仓库里的文件不一致，就说明有人绕过脚本手改了迁移，或规格改了而迁移没跟上。
//
// 已知限制：定位靠行号锚点（围栏位置）。规格文档结构若变化，本脚本会抛错而不是
// 悄悄产出半截 SQL —— 抛错是正确的失效方向。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(HUB, "..", "..");
const SPEC = join(REPO, "docs", "OPC-OS-设计文档.md");
const OUT = join(HUB, "resources", "migrations", "0001_init.sql");

const lines = readFileSync(SPEC, "utf8").split("\n");
const open = lines.findIndex((l) => l.startsWith("# 附录 C"));
if (open < 0) throw new Error("找不到「# 附录 C」标题");
// 只取附录 C【正文】里的 sql 围栏，即第一个 `## ` 子标题之前的那一个。
// 附录 C 实际有 2 个 sql 围栏（主建表脚本 + C.2 备份脚本），本脚本只要前者；
// 后者是 VACUUM INTO / integrity_check 这类运行时命令，不是建表语句。
// 这个范围守卫不是装饰：曾按「全文只有 1 个围栏」的假设写检索，结果抓到 2 个，
// 若无守卫就会静默取错片段，把备份命令拼进迁移。
const firstSub = lines
  .map((l, i) => ({ l, i }))
  .filter(({ l, i }) => i > open && /^## C\./.test(l))
  .map(({ i }) => i);
if (firstSub.length === 0) throw new Error("找不到附录 C 的子标题（## C.x）");
const bodyEnd = firstSub[0];
const fence = lines
  .map((l, i) => ({ l, i }))
  .filter(
    ({ l, i }) => i > open && i < bodyEnd && l.trim().startsWith("```sql"),
  )
  .map(({ i }) => i);
if (fence.length !== 1) {
  throw new Error(
    `附录 C 正文（## C. 之前）应有且只有 1 个 sql 围栏，实到 ${fence.length} 个` +
      "（规格结构变了，需重新核对提取范围，别硬改常量）",
  );
}
let end = -1;
for (let i = fence[0] + 1; i < lines.length; i++) {
  if (lines[i].trim() === "```") {
    end = i;
    break;
  }
}
if (end < 0) throw new Error("sql 围栏未闭合");
const body = lines.slice(fence[0] + 1, end);

// 相对附录 C 的两处偏离，见输出文件的头部注释
const DROP_PRAGMA =
  /^PRAGMA (journal_mode|busy_timeout|synchronous|foreign_keys)/;
const DROP_PRAGMA_HEADING = /^-- ={2,} 全局 PRAGMA/;
const BAD_FK = "  role_id TEXT PRIMARY KEY REFERENCES role_charters(role_id),";

const kept = [];
const dropped = [];
const rewritten = [];
for (const line of body) {
  const t = line.trim();
  if (DROP_PRAGMA.test(t) || DROP_PRAGMA_HEADING.test(t)) {
    dropped.push(t);
    continue;
  }
  if (line === BAD_FK) {
    rewritten.push(line);
    kept.push("  role_id TEXT NOT NULL,");
    continue;
  }
  kept.push(line);
}
if (dropped.length !== 5)
  throw new Error(`预期丢弃 5 行 PRAGMA，实到 ${dropped.length}`);
if (rewritten.length !== 1) {
  throw new Error(`预期改写 1 行 trust_scores 外键，实到 ${rewritten.length}`);
}

const HEADER = readFileSync(
  join(HUB, "scripts", "0001_init.header.sql.txt"),
  "utf8",
);
const sql = `${HEADER}\n${kept.join("\n").trimEnd()}\n`;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, sql, "utf8");
const count = (re) => (sql.match(re) || []).length;
console.log(
  `写入 ${OUT.replace(REPO, "")}` +
    ` | 表 ${count(/CREATE TABLE/g)} 触发器 ${count(/CREATE TRIGGER/g)}` +
    ` 虚拟表 ${count(/CREATE VIRTUAL TABLE/g)} 残留 PRAGMA ${count(/^PRAGMA/gm)}`,
);
console.log(
  `tokenize = 'trigram' 存在: ${sql.includes("tokenize = 'trigram'")}`,
);
