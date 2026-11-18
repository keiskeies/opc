import { existsSync, readFileSync } from "node:fs";
const PLAN = "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md";
const lines = readFileSync(PLAN, "utf8").split("\n");
// 先把反引号整段取出来，再按空白切成 token —— 前两个版本都是「拿正则直接猜路径」，
// 一个把「命令 + 路径」整段当路径（假 MISS），一个只认出 2 条（漏）。
// 切 token 之后，一条 token 是不是路径，判据只有一条：它含 / 且以已知扩展名结尾。
const SPAN = /`([^`]+)`/g;
const TOKEN_PATH = /^(?:[\w.@-]+\/)+[\w.@-]+\.(?:ts|tsx|mjs|json|sql)$/;
let named = 0;
const miss: Array<{ n: number; p: string; span: string }> = [];
lines.forEach((line, i) => {
  if (!/\*\*Run\*\*|\*\*Playwright E2E\*\*|\*\*E2E\*\*/.test(line)) return;
  for (const s of line.matchAll(SPAN)) {
    for (const tok of s[1]!.split(/\s+/)) {
      if (!TOKEN_PATH.test(tok)) continue;
      named++;
      if (!existsSync(tok)) miss.push({ n: i + 1, p: tok, span: s[1]! });
    }
  }
});
console.log("点名的文件路径 token 数:", named, "| 逐字不存在:", miss.length);
for (const r of miss) console.log("  L" + r.n + "  " + r.p);
