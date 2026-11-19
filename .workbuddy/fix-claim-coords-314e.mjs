import { readFileSync, writeFileSync } from "node:fs";

const FIX = {
  r3: 1319, r4: 1039, r5: 726, r7: 1197, r8: 881, r10: 1785,
  r11: 1876, r12: 1907, r13: 1971, r14: 2027, r15: 2068, r16: 1447,
  r17: 1410, r18: 1383, r19: 1994, r20: 1553, r21: 2308, r22: 2432,
  r23: 2549, r24: 2622,
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
