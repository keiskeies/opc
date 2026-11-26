import { readFileSync } from "node:fs";

const root = "D:/item/opc/packages/hub/resources/migrations/";
let fail = 0;

for (const f of ["0013_members.sql", "0020_talent_market.sql"]) {
  const t = readFileSync(root + f, "utf8");
  const bad = (t.match(/�/g) ?? []).length;
  console.log(f + " U+FFFD=" + bad);
  if (bad > 0) fail++;
}

const sql = readFileSync(root + "0020_talent_market.sql", "utf8");
const payloads = [...sql.matchAll(/'(\{"name".*?\})'/gs)].map((m) => m[1]);
console.log("seed payloads found: " + payloads.length);
if (payloads.length !== 4) fail++;
for (const p of payloads) {
  let o;
  try {
    o = JSON.parse(p);
  } catch (e) {
    console.log("JSON FAIL: " + e.message);
    fail++;
    continue;
  }
  for (const ex of o.executors) {
    if (ex.config?.kind !== ex.kind) {
      console.log("KIND MISMATCH in " + o.name + ": seq=" + ex.seq);
      fail++;
    }
  }
  console.log("ok: " + o.name + " executors=" + o.executors.length);
}

const ddl = readFileSync(root + "0013_members.sql", "utf8");
if (!/avatar_seed\s+TEXT NOT NULL DEFAULT ''/.test(ddl)) {
  console.log("avatar_seed column missing");
  fail++;
} else console.log("avatar_seed column present");

console.log(fail === 0 ? "ALL CHECKS PASS" : "FAIL count=" + fail);
process.exit(fail === 0 ? 0 : 1);
