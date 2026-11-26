// round358: 装 (U+88C5) was lost to the Edit path in work.ts line 165.
import { readFileSync, writeFileSync } from "node:fs";

const BAD = String.fromCharCode(0xfffd);
const f = process.argv[2];
const s = readFileSync(f, "utf8");
const ZHU = String.fromCharCode(0x4f4f); // 住
const CENG = String.fromCharCode(0x5c42); // 层
const re = new RegExp(ZHU + BAD + "+" + CENG, "g");
const hits = (s.match(re) ?? []).length;
const out = s.replace(re, ZHU + String.fromCharCode(0x88c5) + CENG);
if (hits > 0) writeFileSync(f, out, "utf8");
const left = (readFileSync(f, "utf8").match(new RegExp(BAD, "g")) ?? []).length;
console.log("hits=" + String(hits), "remaining_fffd=" + String(left));
