// 收尾块补一行：变异机全停、注释类改动落地之后，两套全量在【当前字节】上复现同一读数。
import { readFileSync, writeFileSync } from "node:fs";

const LEDGER = ".workbuddy/AUDIT-LEDGER.txt";
const ANCHOR =
  "    \uff08probe-sheet.spec.ts \u4e0d\u88ab\u4efb\u4f55 runner \u6536 + test/e2e \u7684 29 \u4e2a\u7c7b\u578b\u9519\u5728 TYPE_BASELINE \u5916\uff0c\n" +
  "    \u89c1\u4e0a\uff09\uff0c\u672c\u8f6e\u7684\u53f0\u8d26\u5199\u5165\u4e0e doc-preview / compact-scale \u65b0\u6587\u4ef6\u6ca1\u6709\u65b0\u589e\u7ea2\uff1b\n" +
  "    lint-baseline \u5355\u8dd1 12/12\u3002\n";

const ADD =
  "  \u00b7 \u5168\u91cf\u5728\u5f53\u524d\u5b57\u8282\u4e0a\u590d\u73b0\uff08\u4e24\u53f0\u53d8\u5f02\u673a\u5168\u505c\u4e4b\u540e\u91cd\u8dd1\uff0c\u65e5\u5fd7 sha \u4e0e\u300c\u6536\u644a\u300d\u884c\u5bf9\u5f97\u4e0a\uff09\uff1a\n" +
  "    vitest 2 failed | 4111 passed | 6 skipped\uff084119\uff0cround379-vitest-full-2.log\uff09\u3001\n" +
  "    Playwright 56 passed\uff08round379-e2e-full-3.log\uff09\u2014\u2014\u4e0e round379-vitest-full.log / -e2e-full-2.log\n" +
  "    \u9010\u6570\u76f8\u540c\u3002\u4e4b\u6240\u4ee5\u91cd\u8dd1\uff1a\u65e7\u90a3\u4e24\u4efd\u6293\u5728\u6ce8\u91ca\u7c7b\u6539\u52a8\u4e4b\u524d\uff0c\u800c\u5b83\u4eec\u6b63\u597d\u843d\u5728\u53d8\u5f02\u673a\u7a97\u53e3\u4e4b\u95f4\n" +
  "    \uff08vitest \u5168\u91cf 00:27:59\u201300:29:39\uff0c\u524d\u6709 t4\u3001\u540e\u6709 pane r2\uff0c\u4e24\u5934\u90fd\u4e0d\u91cd\u53e0\uff0c\u5df2\u6838\uff09\u3002\n";

const text = readFileSync(LEDGER, "utf8");
if (text.includes("\u5168\u91cf\u5728\u5f53\u524d\u5b57\u8282\u4e0a\u590d\u73b0")) {
  console.log("\u5df2\u5b58\u5728 \u21d2 \u8df3\u8fc7");
  process.exit(0);
}
const hits = text.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.log(`\u951a\u70b9\u547d\u4e2d ${hits} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(2);
}
const next = text.replace(ANCHOR, ANCHOR + ADD);
const bad = [...next].filter((c) => c === "\uFFFD").length;
if (bad !== 0) {
  console.log(`FFFD ${bad} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(3);
}
writeFileSync(LEDGER, next, "utf8");
console.log(`\u5df2\u8865 6 \u884c\uff1b\u53f0\u8d26\u884c\u6570 ${next.split("\n").length}\uff1bFFFD ${bad}`);
