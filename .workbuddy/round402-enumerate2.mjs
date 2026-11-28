import { execFileSync } from "node:child_process";
// 全仓已跟踪文件里凡是写了 group.js:行号 的地方都列出来，按需要位移的档统计。
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => /\.(md|txt|mjs|ts)$/u.test(f))
  .filter((f) => !f.startsWith("node_modules/"));
const re = /packages\/web\/public\/group\.js:(\d+)/gu;
const perFile = new Map();
for (const f of files) {
  let text;
  try {
    text = execFileSync("git", ["show", `HEAD:${f}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch {
    continue;
  }
  for (const m of text.matchAll(re)) {
    const line = Number(m[1]);
    const b = line <= 3752 ? "unchanged" : line >= 3822 ? "+13" : `MID-${line}`;
    const key = `${f} ${b}`;
    perFile.set(key, (perFile.get(key) ?? 0) + 1);
  }
}
for (const [k, v] of [...perFile].sort()) console.log(k, v);
