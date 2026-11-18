// round305 · lint 棘轮 format 161→? 的归因：逐文件比对 HEAD 与工作区的 biome 诊断。
// 跑法：node .workbuddy/round305-lint-attr.mjs
// ⚠ 口径照抄 test/arch/lint-baseline.ts：只数 severity=error，逐类目计数，
//    format / organizeImports 是【一份文件一条】，所以逐文件集合才是可比的单位。
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

function biomeJson(args, workdir) {
  const r = spawnSync(
    "npx",
    ["biome", "check", "--max-diagnostics=9000", "--reporter=json", ...args],
    { cwd: workdir ?? cwd, encoding: "utf8", shell: true, maxBuffer: 1 << 28 },
  );
  const out = r.stdout ?? "";
  const start = out.indexOf("{");
  if (start < 0) throw new Error("biome 没给出 JSON：" + out.slice(0, 300) + (r.stderr ?? "").slice(0, 300));
  return JSON.parse(out.slice(start));
}

/** 逐 (文件, 类目) 计数。路径归一成 posix 相对路径。 */
function tally(json) {
  const byCat = new Map();
  const files = new Map();
  for (const d of json.diagnostics ?? []) {
    if (d.severity !== "error") continue;
    const p = String(d.location?.path ?? "").split("\\").join("/");
    const name = p.slice(p.lastIndexOf("/") + 1);
    // 与守卫同源：运行期夹具探针不算。
    if (name.startsWith("__probe") || name.startsWith("_boundary_probe")) continue;
    byCat.set(d.category, (byCat.get(d.category) ?? 0) + 1);
    const key = p + "#" + d.category;
    files.set(key, (files.get(key) ?? 0) + 1);
  }
  return { byCat, files };
}

const work = tally(biomeJson(["."]));
console.log("工作区逐类目：", [...work.byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));

// HEAD：把 HEAD 的一份树 checkout 到临时目录再量（不动工作区）。
const SNAP = join(cwd, ".workbuddy", "round305-head-snapshot");
rmSync(SNAP, { recursive: true, force: true });
mkdirSync(SNAP, { recursive: true });
const co = spawnSync("git", ["-c", "core.quotePath=false", "archive", "HEAD"], {
  cwd, encoding: "buffer", maxBuffer: 1 << 28, shell: false,
});
if (co.status !== 0) throw new Error("git archive 失败");
writeFileSync(join(SNAP, "_archive.tar"), co.stdout);
const ex = spawnSync("tar", ["-xf", "_archive.tar"], { cwd: SNAP, encoding: "utf8", shell: false });
if (ex.status !== 0) throw new Error("tar 解包失败：" + ex.stderr);
rmSync(join(SNAP, "_archive.tar"), { force: true });
// biome 要配置文件；git archive 把 tracked 的 biome.json / .gitignore 一起带过来了，
// 所以在快照目录里直接跑 `.` 就复现了同一份口径（不需要 --config-path）。
const head = tally(biomeJson(["."], SNAP));
console.log("HEAD 逐类目：  ", [...head.byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8));

for (const cat of ["format", "assist/source/organizeImports"]) {
  const onlyWork = [...work.files.keys()].filter((k) => k.endsWith("#" + cat) && !head.files.has(k));
  const onlyHead = [...head.files.keys()].filter((k) => k.endsWith("#" + cat) && !work.files.has(k));
  console.log("\n[" + cat + "] 只在工作区脏（新增的）:");
  for (const k of onlyWork) console.log("  + " + k.slice(0, k.lastIndexOf("#")));
  console.log("[" + cat + "] 只在 HEAD 脏（本轮修好的）:");
  for (const k of onlyHead) console.log("  - " + k.slice(0, k.lastIndexOf("#")));
}
rmSync(SNAP, { recursive: true, force: true });
