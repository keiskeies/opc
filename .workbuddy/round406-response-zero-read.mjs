// 0086 响应侧轴（round340 验证有效的那根）：契约里 *ViewSchema/*Response 的字段，
// 在两个入口页里【零字面出现】⇒ 服务端算了、界面从不读。
// 同样只判必要条件（零出现 = 必然没渲染），出现≠真渲染，候选一律人工 triage。
import { readFileSync, readdirSync } from "node:fs";

const CONTRACTS = "D:/item/opc/packages/contracts/src";
const uiHay = ["packages/web/public/group.js", "packages/web/public/app.js"]
  .map((f) => readFileSync(`D:/item/opc/${f}`, "utf8"))
  .join("\n");

function fieldNames(text, start, stop) {
  // 取 schema 块内【恰好缩进 4 空格】的 `name:` —— 这些文件里顶层字段就是这个排版。
  // 刻意不用括号深度自己解析：上一版按深度取，实测会把嵌套对象里的字段整层丢掉，
  // 而「丢一层」在输出上表现为候选变少、不会报错（0085 那条「恒 0 是没量到」的同族）。
  // 排版一旦变了这条尺子会失效，所以末尾的正控制必须报 schema 数与字段总数。
  const block = text.slice(start, stop);
  return [...block.matchAll(/^ {4}([a-z_][a-z0-9_]*)\s*:/gmu)].map((m) => m[1]);
}

const rows = [];
let schemas = 0;
let fieldTotal = 0;
for (const f of readdirSync(CONTRACTS).filter((n) => n.endsWith(".ts"))) {
  const text = readFileSync(`${CONTRACTS}/${f}`, "utf8");
  const re = /export const (\w*(?:View|Response|Card|Item|Hit|Result)\w*Schema)\s*=\s*z\s*\n?\s*\.object\(\{/gu;
  let m = re.exec(text);
  while (m) {
    schemas += 1;
    const next = text.indexOf("export const", m.index + 5);
    const fields = fieldNames(text, m.index, next > 0 ? next : text.length);
    fieldTotal += new Set(fields).size;
    for (const k of fields) {
      if (uiHay.split(k).length - 1 === 0) rows.push(`${f} :: ${m[1]} :: ${k}`);
    }
    m = re.exec(text);
  }
}
console.log(
  `正控制：响应 schema ${schemas} 个、字段 ${fieldTotal} 个；零字面出现候选 ${rows.length} 条：`,
);
for (const r of rows) console.log(`  ${r}`);
