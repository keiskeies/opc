import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// 把所有 <文件>:<行号> 里指向 group.js 的坐标抄出来，按老行号分档统计。
const files = ["docs/INDEX.md", "test/arch/doc-refs.test.ts", "test/arch/doc-coords.ts"].concat(
  readdirSync("docs/decisions").map((f) => join("docs/decisions", f)),
);
const re = /packages\/web\/public\/group\.js:(\d+)/gu;
const buckets = new Map();
const perFile = new Map();
let total = 0;
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(re)) {
    const line = Number(m[1]);
    total += 1;
    const b =
      line <= 3752
        ? "unchanged(<=3752)"
        : line <= 3773
          ? "+3"
          : line <= 3808
            ? "+8"
            : line <= 3814
              ? "+9"
              : line <= 3821
                ? "+10"
                : "+13";
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
    const key = `${f} ${b}`;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
    if (b !== "+13" && b !== "unchanged(<=3752)") {
      console.log(`MID ${f} ${line} ${b}`);
    }
  }
}
console.log("---");
console.log("total", total);
for (const [k, v] of [...buckets].sort()) console.log(k, v);
console.log("--- per file/bucket");
for (const [k, v] of [...perFile].sort()) console.log(k, v);
