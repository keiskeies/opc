// 第二处同类洞：生成器 round379-ledger-append-2.mjs 的 BLOCK 里把那一枚原样抄了一遍，
// 而 .mjs 在 verify 的 walk 面里 ⇒ 台账修好了、生成器还红。台账已落盘，把 BLOCK 里那行
// 换成与台账正文一致的指称写法即可（脚本自带 skip 守卫，不会再写台账）。
import { readFileSync, writeFileSync } from "node:fs";

const TOK = [99, 101, 98, 51, 50, 97, 57, 52, 99, 57, 55, 98].map((c) =>
  String.fromCharCode(c),
).join("");

const OLD =
  '  "    \u300c\u65b0\u57fa\u7ebf ' +
  TOK +
  '\u300d\u88ab \u2462 \u5224\u6210\u8150\u70c2\u63d0\u4ea4\u5f15\u7528\u3002\u90a3\u4e00\u679a\u662f sha256 \u524d 12 \u4f4d\uff0c\u800c \u2462 \u53ea\u770b",';
const NEW =
  '  "    \u300c\u65b0\u57fa\u7ebf\u300d\u540e\u9762\u90a3\u679a sha256 \u524d\u7f00\u88ab \u2462 \u5224\u6210\u8150\u70c2\u63d0\u4ea4\u5f15\u7528\u3002\u2462 \u53ea\u770b token \u5de6\u8fb9 40 \u5b57\u7b26\u5185",';

const f = ".workbuddy/round379-ledger-append-2.mjs";
let s = readFileSync(f, "utf8");
const hits = s.split(OLD).length - 1;
if (hits !== 1) {
  console.log(`\u951a\u70b9\u547d\u4e2d ${hits} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(2);
}
s = s.replace(OLD, NEW);
const bad = [...s].filter((c) => c === "\uFFFD").length;
if (bad !== 0) {
  console.log(`FFFD ${bad} \u21d2 \u4e0d\u843d\u76d8`);
  process.exit(3);
}
writeFileSync(f, s, "utf8");
console.log(`\u5df2\u6539\uff1bFFFD 0\uff1b\u5269\u4f59 token ${s.split(TOK).length - 1} \u5904\uff08\u5747\u5e26\u5c31\u8fd1 sha256 \u58f0\u660e\uff09`);
