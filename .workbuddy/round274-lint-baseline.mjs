// round274：把「`pnpm lint` 今天到底什么形状」变成一条能重跑的命令。
//
// 背景：计划 5 个阶段出口门的 Run 行全部写着「pnpm verify 全绿」，而 verify =
// lint && typecheck && test。0057 / 0059 往文档里手抄过「286 error / 109 warning」，
// 今天的实测是 292/109 —— 手抄的数已经漂了而没人发现。本脚本读 biome 的 JSON 读数，
// 按 category × severity 打印，并单独报【运行期夹具探针】贡献了几条（那几条不该进基线：
// dependency-boundary.test.ts 会往 packages/<pkg>/src/ 真写一个越界 import 的文件，
// 它活着的那几百毫秒里任何并行扫描都会看见 —— 同 run-fixtures.ts 记的那族随机红）。
//
// 用法：node .workbuddy/round274-lint-baseline.mjs
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PROBE = "__boundary_probe.ts";

function biomeBinary() {
  const exe = process.platform === "win32" ? "biome.exe" : "biome";
  const pnpmRoot = join(ROOT, "node_modules", ".pnpm");
  const sfx = process.platform === "win32" ? "win32-x64" : "linux-x64";
  if (existsSync(pnpmRoot)) {
    for (const dir of readdirSync(pnpmRoot)) {
      if (!dir.startsWith("@biomejs+cli-" + sfx + "@")) continue;
      const c = join(
        pnpmRoot,
        dir,
        "node_modules",
        "@biomejs",
        "cli-" + sfx,
        exe,
      );
      if (existsSync(c)) return c;
    }
  }
  const flat = join(ROOT, "node_modules", "@biomejs", "cli-" + sfx, exe);
  if (existsSync(flat)) return flat;
  throw new Error("找不到 biome 平台二进制");
}

function check() {
  const r = spawnSync(
    biomeBinary(),
    ["check", ".", "--reporter=json", "--max-diagnostics=100000"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: false },
  );
  if (r.error) throw new Error("biome 调用失败：" + r.error.message);
  const out = String(r.stdout);
  if (!out.trimStart().startsWith("{")) {
    throw new Error("biome 没给出 JSON（退出码 " + r.status + "）：\n" + out.slice(0, 400));
  }
  return JSON.parse(out);
}

const rel = (d) => String(d.location.path).split("\\").join("/");

const run = (label) => {
  const d = check();
  const by = new Map();
  let probe = 0;
  for (const x of d.diagnostics) {
    if (rel(x).includes(PROBE)) {
      probe++;
      continue;
    }
    const k = x.category + "  [" + x.severity + "]";
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const sum = rows.reduce((n, [, c]) => n + c, 0);
  console.log("\n== " + label + " ==");
  console.log(
    "summary: errors=" + d.summary.errors +
      " warnings=" + d.summary.warnings +
      " infos=" + d.summary.infos,
  );
  for (const [k, c] of rows) console.log(String(c).padStart(4) + "  " + k);
  console.log("排除探针后的诊断合计 = " + sum + "（探针贡献 " + probe + " 条）");
  return { d, sum, probe };
};

const clean = run("当前工作树");

// 探针贡献实测：真写一个探针文件进 packages/desktop/src/，再量一次差值。
const probePath = join(ROOT, "packages", "desktop", "src", PROBE);
writeFileSync(
  probePath,
  'import Database from "better-sqlite3";\nexport const b = Database;\n',
);
let withProbe;
try {
  withProbe = run("写入 " + PROBE + " 之后（模拟与 dependency-boundary 并发）");
} finally {
  rmSync(probePath, { force: true });
}
console.log(
  "\n=> 探针差值：errors " + clean.d.summary.errors + " → " + withProbe.d.summary.errors +
    "，诊断 " + clean.d.diagnostics.length + " → " + withProbe.d.diagnostics.length +
    "\n=> 结论（读数说了算）：探针" +
    (withProbe.d.summary.errors === clean.d.summary.errors
      ? "【不】进 biome 基线 —— 守卫不需要按文件名排除它。"
      : "【会】进 biome 基线 —— 守卫必须按 isRuntimeFixture 排除，否则与 dependency-boundary 并发时随机红。"),
);
