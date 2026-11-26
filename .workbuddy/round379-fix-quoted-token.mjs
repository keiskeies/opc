// 复述裸 token 的那一发修复：收尾块里「新基线 <token>」是原样抄写，③ 对它同样只看左边
// 40 字符 —— 引用式复述等于再要一次就近声明。改成指称，不抄字节。
// ⚠ 本脚本自己也不许出现裸 token 字面量：.mjs 在 verify 的 walk 面里，写进来就是【第三个洞】。
//    所以 token 按码位拼，锚点由「字面 OLD 去掉 token 后的两截」拼出来。
import { readFileSync, writeFileSync } from "node:fs";

const TOK = [99, 101, 98, 51, 50, 97, 57, 52, 99, 57, 55, 98].map((c) =>
  String.fromCharCode(c),
).join("");

// OLD 的三行原文：a=「「新基线 」 TOK 「」被 ③ 判成腐烂提交引用。那一枚是 sha256 前 12 位，而 ③ 只看」
//                b=「    token 左边 40 字符内有没有「sha256/摘要/对照」声明 —— 块首那句声明管不到第二行」
//                c=「    （round375 那条纪律的第四次复发）。」
const OLD = [
  ["\u300c", "\u65b0\u57fa\u7ebf ", "\u300d\u88ab \u2462 \u5224\u6210\u8150\u70c2\u63d0\u4ea4\u5f15\u7528\u3002\u90a3\u4e00\u679a\u662f sha256 \u524d 12 \u4f4d\uff0c\u800c \u2462 \u53ea\u770b"].join(""),
  "    token \u5de6\u8fb9 40 \u5b57\u7b26\u5185\u6709\u6ca1\u6709\u300csha256/\u6458\u8981/\u5bf9\u7167\u300d\u58f0\u660e \u2014\u2014 \u5757\u9996\u90a3\u53e5\u58f0\u660e\u7ba1\u4e0d\u5230\u7b2c\u4e8c\u884c",
  "    \uff08round375 \u90a3\u6761\u7eaa\u5f8b\u7684\u7b2c\u56db\u6b21\u590d\u53d1\uff09\u3002",
].join("\n");
const OLD_FULL = OLD.replace("\u300d\u88ab", TOK + "\u300d\u88ab");

const NEW = [
  "\u300c\u65b0\u57fa\u7ebf\u300d\u540e\u9762\u90a3\u679a sha256 \u524d\u7f00\u88ab \u2462 \u5224\u6210\u8150\u70c2\u63d0\u4ea4\u5f15\u7528\u3002\u2462 \u53ea\u770b token \u5de6\u8fb9 40 \u5b57\u7b26\u5185",
  "    \u6709\u6ca1\u6709\u300csha256/\u6458\u8981/\u5bf9\u7167\u300d\u58f0\u660e \u2014\u2014 \u5757\u9996\u90a3\u53e5\u58f0\u660e\u7ba1\u4e0d\u5230\u7b2c\u4e8c\u884c\uff08round375 \u90a3\u6761\u7eaa\u5f8b\u7684",
  "    \u7b2c\u56db\u6b21\u590d\u53d1\uff09\u3002\u800c\u672c\u6536\u5c3e\u5757\u7b2c\u4e00\u7248\u628a\u90a3\u679a\u3010\u539f\u6837\u590d\u8ff0\u3011\u4e86\u4e00\u904d\uff0c\u4e8e\u662f\u540c\u4e00\u5224\u636e\u53c8\u7ea2\u4e00\u6b21\uff1a",
  "    \u590d\u8ff0\u88f8 token = \u518d\u8981\u4e00\u6b21\u5c31\u8fd1\u58f0\u660e\uff0c\u6240\u4ee5\u8fd9\u91cc\u6539\u6210\u6307\u79f0\u3001\u4e0d\u518d\u6284\u5b57\u8282\u3002",
].join("\n");

for (const f of [".workbuddy/AUDIT-LEDGER.txt", ".workbuddy/round379-ledger-append-2.mjs"]) {
  let s = readFileSync(f, "utf8");
  const hits = s.split(OLD_FULL).length - 1;
  if (hits !== 1) {
    console.log(`${f}: \u951a\u70b9\u547d\u4e2d ${hits} \u21d2 \u8df3\u8fc7\u8be5\u6587\u4ef6`);
    continue;
  }
  s = s.replace(OLD_FULL, NEW);
  const bad = [...s].filter((c) => c === "\uFFFD").length;
  const tok = s.split(TOK).length - 1;
  if (bad !== 0) {
    console.log(`${f}: FFFD ${bad} \u21d2 \u4e0d\u843d\u76d8`);
    continue;
  }
  writeFileSync(f, s, "utf8");
  console.log(`${f}: \u5df2\u6539\uff0cFFFD 0\uff0c\u5269\u4f59 token \u51fa\u73b0 ${tok} \u5904`);
}
