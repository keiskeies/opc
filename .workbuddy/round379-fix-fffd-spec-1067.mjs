// 修 test/e2e/group-workbench.spec.ts 那一枚坏字：「这一格[现]在」—— 一个汉字的三个
// UTF-8 字节坏掉后解码器给出【两枚】U+FFFD，所以计数是 2 而不是 1（别照着 1 写死判据）。
// 走码点复原，不重新手打中文 —— 手打再走一次传输可能又坏（memory 记录过三次）。
import { readFileSync, writeFileSync } from "node:fs";

const P = "D:/item/opc/test/e2e/group-workbench.spec.ts";
const CH = String.fromCharCode(0xfffd);
const text = readFileSync(P, "utf8");
const n = [...text].filter((c) => c === CH).length;
if (n === 0) {
  console.log("SKIP 无 FFFD");
  process.exit(0);
}
const XIAN = String.fromCharCode(0x73b0);
const bad = "这一格" + CH + CH + "在";
const good = "这一格" + XIAN + "在";
const hits = text.split(bad).length - 1;
if (hits !== 1) {
  console.log(
    `FAIL FFFD ${n} 枚，但锚点「这一格${CH}${CH}在」命中 ${hits} 处（要 1 处）⇒ 形状与预期不符，停手`,
  );
  process.exit(2);
}
writeFileSync(P, text.replace(bad, good), "utf8");
const after = readFileSync(P, "utf8");
const left = [...after].filter((c) => c === CH).length;
const bs = [...after].filter((c) => c === String.fromCharCode(8)).length;
console.log(`已修 ⇒ FFFD ${left} BS ${bs}`);
process.exit(left === 0 ? 0 : 1);
