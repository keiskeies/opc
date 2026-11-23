// Insert `evidenceRoot: TMP + "/artifacts",` after every `cwd: TMP,` line in a test file.
// Mechanical: required RuntimeDeps/PumpOptions/DriveOptions field, temp root only.
import { readFileSync, writeFileSync } from "node:fs";
const files = process.argv.slice(2);
const INS = 'evidenceRoot: TMP + "/artifacts",';
let total = 0;
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const lines = src.split("\n");
  const out = [];
  let n = 0;
  for (const line of lines) {
    out.push(line);
    const m = /^(\s*)cwd: TMP,$/u.exec(line);
    if (m !== null) {
      out.push(m[1] + INS);
      n += 1;
    }
  }
  writeFileSync(f, out.join("\n"), "utf8");
  total += n;
  console.log(f, "inserted=" + String(n));
}
console.log("TOTAL", String(total));
