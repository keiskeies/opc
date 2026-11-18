// round288 · 变异机（第四台）：hub run 那条建任务路径上，graph_version 这两发【有没有牙齿】。
//
// 为什么必须两台之外再跑一台：修完之后 e2e-linear 从 11 发变 13 发全绿。
// 而「新增两发 + 全绿」有两解：① 它们真的在判那一列；② 断言写松了（读到 undefined
// 也当 0、taskId 打错导致 rows 为空而我 expect 了个 undefined…）。
//
// 两发变异打的【不是同一件事】，这是本台机器存在的理由：
//   V1 把那一列整个从 INSERT 里去掉（= 退回本轮修之前的样子）
//      ⇒ 预期：①b 红（落 1 而不是 0）+ ①c 红（落 1 而不是 7）
//   V2 把 currentGraphVersion(db) 换成常量 0（= 一个"看起来修好了"的错修法）
//      ⇒ 预期：①b【绿】而 ①c【红】
//   V2 这一发是重点：如果只有 ①b，那么写死 0 的人会得到一份全绿的仓库。
//   ①c 的价值【只在 V2 这种错法上】才显出来 —— 它判的不是"值对不对"，是"这个数从哪来"。
// 每发跑完立刻逐字节回滚；回滚不干净就抛。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "packages/hub/src/graph/company.ts";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const original = readFileSync(FILE, "utf8");

const TESTS = [
  "packages/hub/test/graph/e2e-linear.test.ts",
];

const MUTANTS = [
  {
    id: "V1 那一列整个删掉（= 修之前的样子）",
    // ⚠ 必须【两处一起改】才叫"修之前的样子"。只删 SQL 里那一列而留着第 8 个实参，
    //   node:sqlite 会因参数个数不匹配当场抛 ⇒ 那一发确实红，但红因是「SQL 写错了」，
    //   不是「躺在 DEFAULT 1 上」。那是一发假证（与本轮「红因是路径分隔符而非零调用方」同族）。
    edits: [
      {
        from:
          '  "INSERT OR IGNORE INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at,graph_version) " +\n' +
          '  "VALUES (?,?,?,?,?,?,?,?)";',
        to:
          '  "INSERT OR IGNORE INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at) " +\n' +
          '  "VALUES (?,?,?,?,?,?,?)";',
      },
      {
        from: "          t0,\n          currentGraphVersion(db),\n",
        to: "          t0,\n",
      },
    ],
    expectEmpty: "红",
    expectV7: "红",
  },
  {
    id: "V2 取数换成常量 0（= 看着像修好的错修法）",
    edits: [{ from: "          currentGraphVersion(db),", to: "          0, // 变异：写死" }],
    expectEmpty: "绿",
    expectV7: "红",
  },
];

function runTests() {
  const r = spawnSync("npx", ["vitest", "run", ...TESTS], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900000,
  });
  if (r.status === null) throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  return (r.stdout + r.stderr).replace(ANSI, "");
}

/** 从输出里读那两发各自红了没有（用 vitest 的 × 行，不用汇总数字猜）。 */
function verdict(out, name) {
  const re = new RegExp("[×✓✗√].{0,80}" + name, "u");
  const line = out.split(/\r?\n/).find((l) => re.test(l)) ?? "";
  if (line === "") return "找不到那一发的读数行";
  return line.includes("×") ? "红" : "绿";
}

const base = runTests();
if (!/13 passed/.test(base)) {
  throw new Error("基线不是 13 发全绿，跑变异没有意义：\n" + base.slice(-800));
}
console.log("基线: e2e-linear 13 发全绿（含新增的 ①b / ①c）");

const rows = [];
for (const m of MUTANTS) {
  for (const e of m.edits) {
    if (!original.includes(e.from)) {
      throw new Error("变异 " + m.id + " 的锚文本不在 " + FILE + " 里 —— 变异机自己坏了：\n" + e.from);
    }
  }
  let out = "";
  try {
    let mutated = original;
    for (const e of m.edits) mutated = mutated.replace(e.from, e.to);
    if (mutated === original) throw new Error("变异没落地：" + m.id);
    writeFileSync(FILE, mutated, "utf8");
    out = runTests();
  } finally {
    writeFileSync(FILE, original, "utf8");
    if (readFileSync(FILE, "utf8") !== original) {
      throw new Error("回滚后与原文不一致，立刻人工检查 " + FILE);
    }
  }
  const empty = verdict(out, "空图库：hub run 建的任务落 0");
  const v7 = verdict(out, "库里有 v7：hub run 建的任务落 7");
  rows.push({
    id: m.id,
    got: "①b " + empty + " / ①c " + v7,
    want: "①b " + m.expectEmpty + " / ①c " + m.expectV7,
    ok: empty === m.expectEmpty && v7 === m.expectV7,
    // 编译期就红（比如参数个数不匹配）也是红，但红因不是我要的那一件事 ⇒ 单独认出来。
    compile: /ERR_MODULE_NOT_FOUND|Expected [0-9]+ arguments|SyntaxError/u.test(out)
      ? "（注意：这一发里有编译/运行期异常，红因可能不是断言）"
      : "",
  });
}

console.log("\n变异读数：");
for (const r of rows) {
  console.log(
    (r.ok ? "命中  " : "未命中") + "  " + r.id + "\n        预期 " + r.want + "\n        实得 " + r.got + r.compile,
  );
}
const bad = rows.filter((r) => !r.ok);
console.log(
  "\n结论：" + rows.length + " 发变异，命中 " + (rows.length - bad.length) + "，未命中 " + bad.length,
);
console.log(
  "  ⇒ V2 是关键：它证明 ①c 不是凑数的一发。只有 ①b 的话，把那一列【写死成 0】就能全绿。",
);
console.log("还原：与原文逐字一致");
