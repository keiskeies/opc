// round288：把两条探针的口径对齐（blast 说 51，own 说 50，差 1 必须问清是谁的口径漏了什么）。
import { runBiomeJson } from "../test/arch/lint-baseline.ts";
import { spawnSync } from "node:child_process";

const run = runBiomeJson(process.cwd());
const CATS = new Set(["format", "assist/source/organizeImports"]);
const bad = new Set(
  run.diagnostics
    .filter((d) => d.severity === "error" && CATS.has(d.category))
    .map((d) => String(d.location.path).split("\\").join("/")),
);
const g = (a) => {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...a], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error("git 失败，口径核不了");
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
};
const dirty = new Set([
  ...g(["diff", "--name-only", "HEAD"]),
  ...g(["ls-files", "--others", "--exclude-standard"]),
]);
const inter = [...bad].filter((p) => dirty.has(p));
console.log("bad 文件（全类目里只算 format/organizeImports）:", bad.size);
console.log("∩ 脏 =", inter.length, "（这就是 blast 那个 51）");
const nonTs = inter.filter((p) => !/\.tsx?$/.test(p));
console.log("∩ 脏 里不是 .ts/.tsx 的（= own 探针刻意过滤掉的那批）:", nonTs.length);
for (const p of nonTs) console.log("   ", p);
console.log(
  "⇒ own 的 50 与 blast 的 51 之间那 1 的差，来源" +
    (nonTs.length === 1 ? "已定位（own 只数 .ts/.tsx，blast 不限扩展名）" : "【没定位，别把这两个数当同一个东西】"),
);
