// ② 那发补正：append-4 里我凭记忆写的锚点（「台账与变异机日志里的收摊 sha256 逐字一致…」）
// 压根不在台账里，唯一性检查当场拦下 ⇒ 未落盘。这次锚点取文件真实那一行的前缀，先数命中再写。
import { readFileSync, writeFileSync } from "node:fs";

const LEDGER = ".workbuddy/AUDIT-LEDGER.txt";
const ANCHOR = "  \u00b7 \u5feb\u7167\u5bf9\u8d26\uff1agroup.css";

const BLOCK =
  "  \u00b7 \u7d27\u51d1\u5316\u5206\u91cf\u524d\u540e\u5bf9\u8d26\uff08round379-whitespace-audit-before.out / -after.out\uff0c60 \u9762\u677f \u00d7 \u660e\u6697\u4e24\u76ae\uff09\uff1a\n" +
  "    topbar h 64\u219252\uff0860 \u9762\u677f\u5168\u90e8\uff0c\u65e0\u4e00\u4f8b\u5916\uff09\u00b7 .page padding 24/28/50 \u2192 16/20/32 \u00b7 \u5757\u5408\u8ba1\u5e73\u5747\u6536 11.7px \u00b7\n" +
  "    \u5757\u95f4\u8ddd\u5408\u8ba1\u5e73\u5747\u6536 8.8px\u3002\u3010\u53cd\u5411\u8bfb\u6570\u3011\u540c\u4e00\u6279\u9762\u677f\u7684\u300c\u5916\u56f4\u6b7b\u533a\u300d\u5e73\u5747\u53cd\u800c\u53d8\u5927 57.4px\uff1a\n" +
  "    \u5185\u5bb9\u4e0d\u6ee1\u4e00\u5c4f\u65f6\uff0c\u9876\u680f\u8ba9\u51fa\u7684\u9ad8\u5ea6\u4e0e\u5185\u8ddd/\u5757\u9ad8\u7701\u4e0b\u7684\u9ad8\u5ea6\u4e00\u5f8b\u6c89\u5230\u5c3e\u90e8\uff08\u4e24\u76f8\u51b2\uff0c\u5c3e\u90e8\u53d6\u5176\u5dee\uff09\u3002\n" +
  "    \u8fd9\u662f round375 \u90a3\u6761\u7684\u53cd\u5411\u5f62\u72b6\uff1a\u300c\u8be5\u52a8\u7684\u90a3\u4e2a\u91cf\u300d\u662f\u5206\u91cf\uff08\u9876\u680f/\u5185\u8ddd/\u5757\u9ad8/\u7f1d\uff09\uff0c\u4e0d\u662f\u4f59\u91cf\u2014\u2014\n" +
  "    \u62ff\u4f59\u91cf\u5224\u7d27\u51d1\u5316\u4f1a\u628a\u4e00\u8f6e\u771f\u751f\u6548\u7684\u6539\u52a8\u8bfb\u6210\u56de\u9000\u3002\u5185\u5bb9\u8d85\u4e00\u5c4f\u7684\u9762\u677f\u5c3e\u90e8\u624d\u4f1a\u771f\u7684\u53d8\u5c0f\u3002\n";

let text = readFileSync(LEDGER, "utf8");
if (text.includes("\u7d27\u51d1\u5316\u5206\u91cf\u524d\u540e\u5bf9\u8d26")) {
  console.log("\u5df2\u5b58\u5728 \u21d2 \u8df3\u8fc7");
  process.exit(0);
}
const hits = text.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.log(`\u951a\u70b9\u547d\u4e2d ${hits} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(2);
}
text = text.replace(ANCHOR, BLOCK + ANCHOR);
const bad = [...text].filter((c) => c === "\uFFFD").length;
if (bad !== 0) {
  console.log(`FFFD ${bad} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(3);
}
writeFileSync(LEDGER, text, "utf8");
console.log(`\u5df2\u5199\uff1b\u53f0\u8d26\u884c\u6570 ${text.split("\n").length}\uff1bFFFD ${bad}`);
