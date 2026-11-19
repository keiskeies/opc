import { readFileSync, writeFileSync } from "node:fs";
const p = "test/arch/claims-registry.ts";
let src = readFileSync(p, "utf8");
// All 18 stale coords are exactly +40 after a uniform doc shift.
// Key  old -> new  (from the drift report)
const map = {
  1258: 1298, 978: 1018, 1136: 1176, 1718: 1758, 1809: 1849,
  1840: 1880, 1904: 1944, 1960: 2000, 2001: 2041, 1386: 1426,
  1349: 1389, 1322: 1362, 1927: 1967, 1492: 1532, 2241: 2281,
  2365: 2405, 2482: 2522, 2555: 2595,
};
let n = 0;
for (const [o, nu] of Object.entries(map)) {
  const pat = "line: " + o + ",";
  if (!src.includes(pat)) { console.log("MISS", o); continue; }
  src = src.split(pat).join("line: " + nu + ",");
  n++;
}
writeFileSync(p, src);
console.log("re-pointed", n, "coords");
