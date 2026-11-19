import { readFileSync, writeFileSync } from "node:fs";

const FIX = {
  r3: 1315, r4: 1035, r5: 722, r7: 1193, r8: 877, r10: 1781,
  r11: 1872, r12: 1903, r13: 1967, r14: 2023, r15: 2064, r16: 1443,
  r17: 1406, r18: 1379, r19: 1990, r20: 1549, r21: 2304, r22: 2428,
  r23: 2545, r24: 2618,
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
console.log("re-pointed " + n + " coords");
