import { readFileSync, writeFileSync } from "node:fs";

// 守卫本轮（round314 两处插入后）报告的实际命中位置。
const FIX = {
  r3: 1303, r4: 1023, r5: 718, r7: 1181, r8: 873, r10: 1769,
  r11: 1860, r12: 1891, r13: 1955, r14: 2011, r15: 2052, r16: 1431,
  r17: 1394, r18: 1367, r19: 1978, r20: 1537, r21: 2292, r22: 2416,
  r23: 2533, r24: 2606,
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
