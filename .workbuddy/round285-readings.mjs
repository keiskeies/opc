// round285 · 台账要的那几个读数，现跑不抄。
// 跑法：npx tsx .workbuddy/round285-readings.mjs
import {
  countTypeErrorsByDir,
  diffTypeBaseline,
  runTypeCheck,
  staleTypeEntries,
  TYPE_BASELINE,
} from "../test/arch/test-type-baseline.ts";

const run = runTypeCheck({
  cwd: process.cwd(),
  tsconfig: ".workbuddy/tsconfig.tests.json",
});
const counts = countTypeErrorsByDir(run.errors);
console.log(
  "filesChecked=" + run.filesChecked +
    " errors=" + run.errors.length +
    " unparsed=" + run.unparsed +
    " exit=" + run.exitCode,
);
console.log("配额表目录数=" + TYPE_BASELINE.length + " 今天有错的目录数=" + counts.size);
console.log("基线总和=" + TYPE_BASELINE.reduce((n, b) => n + b.atMost, 0));
console.log("diff=" + JSON.stringify(diffTypeBaseline(counts)));
console.log("stale=" + JSON.stringify(staleTypeEntries(counts)));
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
for (const [d, n] of top) {
  const cap = TYPE_BASELINE.find((b) => b.dir === d);
  console.log("  " + d + " = " + n + " / " + (cap ? cap.atMost : "未登记"));
}
