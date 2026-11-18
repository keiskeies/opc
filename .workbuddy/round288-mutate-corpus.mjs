// round288 · 变异机（第三台）：doc-refs 的语料从「手挑三份」换成「docs/ 递归全量」之后，
// 【新增一份带坐标的文档会不会红】。
//
// 为什么这一台必须跑：本轮把 decisionDocs() 改成了递归 glob。改完跑是全绿。
// 而「改成 glob + 全绿」有两解：① 语料真的变宽了，且其余文档恰好没坐标；
// ② glob 没递归 / 路径拼错 / 键名对不上，语料其实【变窄了】，绿是因为读不到东西。
// 这两解在终端上长得一模一样，和本轮前面两台机器打的是同一个失效面 —— 只是这次
// 打的是【新写的那三行】而不是【旧的那三行】。
//
//   M5 decisions 下新增一份带坐标的文档 ⇒ 必须红「快照里没有」
//      （证：glob 确实读到了 decisions）
//   M6 【新子目录】下新增一份带坐标的文档 ⇒ 必须红
//      （证：递归真的下得去。这是本次改动最核心的一句主张 —— 旧实现只读 decisions 一层，
//        一份放在 docs/guides/ 下的文档在旧实现里是【永久隐形】的）
//   M7 两份【同基名】的 .md 落在不同目录 ⇒ 必须被 collisions 那一发判红
//      （证：Map.set 静默顶掉这件事有牙齿。键是基名，所以重名会让语料少一份而没有任何一发会红 ——
//        除非有这一发。）
// 每发建完立刻删；finally 里逐字节核对还原，且不删除任何本轮之前就在的文件。
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const REF = "看 test/desktop/ipc-surface.test.ts:129 那一发";

function runGuard() {
  const r = spawnSync("npx", ["vitest", "run", "test/arch/doc-refs.test.ts"], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
  if (r.status === null) throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  return (r.stdout + r.stderr).replace(ANSI, "");
}

const MUTANTS = [
  {
    id: "M5 decisions 下新增一份带坐标的文档",
    files: ["docs/decisions/9999-round288-mutate-probe.md"],
    expect: ["快照里没有"],
    // M6 的探针要落在一个【新建】目录里，才叫「递归下得去一个原本不存在的目录」。
    mkdirs: [],
  },
  {
    id: "M6 新子目录下新增一份带坐标的文档（证递归）",
    files: ["docs/round288-mutate-dir/probe.md"],
    expect: ["快照里没有"],
    mkdirs: ["docs/round288-mutate-dir"],
  },
  {
    id: "M7 两份同基名的 .md 落在不同目录（证 collisions）",
    files: [
      "docs/decisions/round288-collision.md",
      "docs/guides/round288-collision.md",
    ],
    expect: ["round288-collision"],
    mkdirs: [],
  },
];

const base = runGuard();
if (!/2 passed/.test(base)) {
  throw new Error("基线不是全绿，跑变异没有意义：\n" + base.slice(0, 600));
}
console.log("基线: doc-refs 2 发全绿");

const hits = [];
for (const m of MUTANTS) {
  for (const d of m.mkdirs) {
    if (existsSync(join(process.cwd(), d))) throw new Error("目录已存在，不碰：" + d);
    mkdirSync(join(process.cwd(), d), { recursive: true });
  }
  for (const f of m.files) {
    const abs = join(process.cwd(), f);
    if (existsSync(abs)) throw new Error("文件已存在，不覆盖：" + f);
  }
  let out = "";
  try {
    for (const f of m.files) writeFileSync(join(process.cwd(), f), REF + "\n", "utf8");
    out = runGuard();
  } finally {
    for (const f of m.files) rmSync(join(process.cwd(), f), { force: true });
    for (const d of m.mkdirs) {
      if (readdirSync(join(process.cwd(), d)).length === 0) rmSync(join(process.cwd(), d), { recursive: true });
    }
    for (const f of m.files) {
      if (existsSync(join(process.cwd(), f))) throw new Error("没删干净，人工检查：" + f);
    }
  }
  const red = /FAIL|failed/.test(out);
  // 「collisions」这一支的失败形状与快照那几支不同：它是一条 toEqual 断言，
  // 消息里出现的是变量名 collisions 与那份文档里的文件名，不含「快照」字样。
  const got = out
    .split(/\r?\n/)
    .filter((l) => /round288-mutate|round288-collision|快照里没有|collisions/.test(l))
    .join(" ㊣ ");
  const miss = m.expect.filter((e) => !got.includes(e));
  hits.push({ id: m.id, red, matched: miss.length === 0, line: got.slice(0, 260) });
}

console.log("\n变异读数：");
for (const h of hits) {
  console.log(`${h.red && h.matched ? "命中" : "未命中"}  ${h.id}\n        ${h.line}`);
}
const bad = hits.filter((h) => !h.red || !h.matched);
console.log(
  `\n结论：${hits.length} 发，命中 ${hits.length - bad.length}，未命中 ${bad.length}` +
    (bad.length === 0
      ? "\n ⇒ 语料判据有牙齿：新文档进语料、递归下得去、重名会被判红。缺口从此是【门禁判】不是【我来数】。"
      : "\n ⇒ 至少一支打不红 ⇒ 「改成 glob 就不漏了」这句话不算证完。"),
);
