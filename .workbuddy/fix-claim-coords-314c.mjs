import { readFileSync, writeFileSync } from "node:fs";

// round314 两次散文插入（O6 两处 round314 复核注）后守卫报告的实际命中位置。
const FIX = {
  r3: 1311, r4: 1031, r7: 1189, r10: 1777, r11: 1868, r12: 1899,
  r13: 1963, r14: 2019, r15: 2060, r16: 1439, r17: 1402, r18: 1375,
  r19: 1986, r20: 1545, r21: 2300, r22: 2424, r23: 2541, r24: 2614,
};

const rel = "test/arch/claims-registry.ts";
const src = readFileSync(rel, "utf8");
let out = src;
let n = 0;
for (const [id, line] of Object.entries(FIX)) {
  const at = out.indexOf(`id: "${id}",`);
  if (at < 0) { console.error("NO-ANCHOR " + id); process.exitCode = 1; continue; }
  const from = out.indexOf("line: ", at);
  if (from < 0) { console.error("NO-LINE " + id); process.exitCode = 1; continue; }
  const end = out.indexOf(",", from);
  if (end < 0) { console.error("NO-END " + id); process.exitCode = 1; continue; }
  out = out.slice(0, from) + "line: " + line + out.slice(end);
  n++;
}
writeFileSync(rel, out, "utf8");
console.log("re-pointed " + n + " coords in " + rel);
