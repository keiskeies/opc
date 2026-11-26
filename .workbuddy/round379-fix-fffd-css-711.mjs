// 修 packages/web/public/group.css 第 711 行开头的坏字：「[共] 38.33 刚好贴着地板」。
// 一个汉字的三个 UTF-8 字节坏掉 ⇒ 解码成 3 枚 U+FFFD（枚数不等于字数，别照 1 写判据）。
// 走码点复原，不重打中文。
import { readFileSync, writeFileSync } from "node:fs";

const P = "D:/item/opc/packages/web/public/group.css";
const CH = String.fromCharCode(0xfffd);
const text = readFileSync(P, "utf8");
const n = [...text].filter((c) => c === CH).length;
if (n === 0) {
  console.log("SKIP 无 FFFD");
  process.exit(0);
}
const GONG = String.fromCharCode(0x5171);
const bad = CH + CH + CH + " 38.33 刚";
const good = GONG + " 38.33 刚";
const hits = text.split(bad).length - 1;
if (hits !== 1 || n !== 3) {
  console.log(
    `FAIL FFFD ${n} 枚（期望 3），锚点命中 ${hits}（期望 1）⇒ 形状不符，停手`,
  );
  process.exit(2);
}
writeFileSync(P, text.replace(bad, good), "utf8");
const after = readFileSync(P, "utf8");
const left = [...after].filter((c) => c === CH).length;
console.log(`已修 ⇒ FFFD ${left} 行数 ${after.split("\n").length}`);
process.exit(left === 0 ? 0 : 1);
