// round290 · 变异机：新加的第 31 道门禁（comment-test-readers）到底有没有牙齿。
//
// 为什么必须跑这一台：守卫自己那份 .test.ts 里，合成夹具那 8 发证明的是【纯函数】有牙齿，
// 真仓库那 4 发今天全绿。而「全绿」有两解：① 生产注释确实都指着存在的文件；
// ② 取材坏了（walk 没进去 / 正则不匹配 / TS API 换了），绿是因为什么都没读到。
// 这两解在终端上长得一模一样 —— 和本仓每一台变异机打的是同一个失效面。
//
//   M1 生产注释点名一个不存在的测试文件        ⇒ 必须红，且红话带 file:line
//   M2 再把那个文件真的建出来（同 M1 的注释不动）⇒ 必须绿
//      （证：判据是【存在性】，不是「出现新名字就红」。少了 M2，M1 那种红可以由
//        一条「注释里提到任何测试名都红」的废判据凑出来 —— 它也会"命中" M1。）
//   M3 同一句改成【撤回】开头                    ⇒ 主断言仍绿，但 retracted 那一发必须红
//      （证：豁免是【可数的账】。贴了标记就完全免检 = 谁都能悄悄扩豁免）
//   M4 把语料目录改成一个不存在的名字            ⇒ 必须红在「一个源文件都没扫到」
//      （证：反假绿哨兵有牙齿。取材坏掉时报的是红，不是「0 条缺陷」）
//
// 读法纪律（本轮前面踩过）：判定用【完整输出】里的子串，不截断；
// 每发都同时要求「红/绿的方向对」AND「预期那句话在」，缺一个算未命中而不是命中。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const GUARD = "test/arch/comment-test-readers.test.ts";
const SRC = join("packages", "hub", "src", "__round290_probe.ts");
const GHOST = "round290Ghost.test.ts";
const GHOST_TEST = join(".tmp", GHOST);
const SRC_BODY =
  "// 这一发是 round290 的变异探针，跑完即删。\n" +
  "// 字段变了红的是 " +
  GHOST +
  "\nexport const x = 1;\n";

function runGuard() {
  const r = spawnSync("npx", ["vitest", "run", GUARD], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
  if (r.status === null) throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  return (r.stdout + r.stderr).replace(ANSI, "");
}

const RED = "Failed Tests";
const ok = (out, wantRed, phrases) => {
  const isRed = out.includes(RED);
  const hit = phrases.every((p) => out.includes(p));
  return wantRed ? isRed && hit : !isRed && hit;
};

const cleanups = [];
function addFile(rel, body) {
  const abs = join(process.cwd(), rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  cleanups.push(() => rmSync(abs, { force: true }));
}

let results = [];
try {
  const baseline = runGuard();
  if (baseline.includes(RED)) {
    throw new Error("基线不绿，变异读数无从解释：\n" + baseline.slice(-1500));
  }
  console.log("基线：守卫全绿\n");

  // M1
  addFile(SRC, SRC_BODY);
  const m1 = runGuard();
  results.push(["M1 注释点名不存在的测试文件", ok(m1, true, [GHOST, "点名了不存在的"]), m1]);

  // M2 —— 只把那个文件建出来，注释一个字不动
  addFile(GHOST_TEST, "export const nothing = 1;\n");
  const m2 = runGuard();
  results.push(["M2 把那个文件真的建出来", ok(m2, false, ["comment-test-readers.test.ts (12 tests)"]), m2]);

  // 撤掉 M2 的文件，只留 M1 的注释，再验一次仍然红（防 M2 的绿是缓存假象）
  rmSync(join(process.cwd(), GHOST_TEST), { force: true });
  const m2b = runGuard();
  results.push(["M2 的反面：删掉文件又红", ok(m2b, true, [GHOST]), m2b]);
} finally {
  for (const f of cleanups) f();
}

// M3 —— 注释行改成【撤回】开头
try {
  const m3body = SRC_BODY.replace("// 字段变了", "// 【撤回】字段变了");
  addFile(SRC, m3body);
  const m3 = runGuard();
  results.push([
    "M3 同一句改成【撤回】开头",
    ok(m3, true, ["retracted 的条数是账", GHOST]),
    m3,
  ]);
} finally {
  for (const f of cleanups) f();
  cleanups.length = 0;
  if (existsSync(join(process.cwd(), SRC))) rmSync(join(process.cwd(), SRC), { force: true });
}

// M4 —— 把【取名字的正则】改坏（这才是"取材静默坏掉"的形状）
//
// ⚠ 这一发的第一版不是这个，而是把语料目录名改成不存在的路径 —— 那发【未命中】，
//   原因值得记：外层 readdirSync 直接 ENOENT 抛出来，整个测试文件 0 发收集，
//   根本没有走到哨兵。也就是说「目录改名」不是静默失效，是响亮失效，
//   它证明不了我要证的那件事。真正的静默失效长这样：文件照常扫到（corpusSize>0），
//   但正则匹配不到任何东西 ⇒ refs 为空 ⇒ 如果没有那条哨兵，输出就是一句干净的
//   「一条都不缺」。所以变异要打在【正则】上，不是打在【目录】上。
const implRel = "test/arch/comment-test-readers.ts";
const implOrig = readFileSync(join(process.cwd(), implRel), "utf8");
// ⚠ 这两个串【必须写成 \\.】：JS 里 "\." 就是 "."（\. 不是合法转义，反斜杠被吞），
//   而源文件里那两个点是带反斜杠的字面量。第一版写成 "\." ⇒ includes 判不到 ⇒
//   机器直接抛「锚点不在实现里」。这是好事：锚点错 = 当场炸，而不是安安静静什么也没改
//   然后报「未命中」—— 一台改不动源码的变异机，它打印的"命中/未命中"都没有意义。
const IMPL_NEEDLE = String.raw`\.test\.tsx?`;
const IMPL_MUTANT = String.raw`\.test\.mts`;
try {
  if (!implOrig.includes(IMPL_NEEDLE)) {
    throw new Error("锚点不在实现里，M4 无从下手：" + IMPL_NEEDLE);
  }
  writeFileSync(
    join(process.cwd(), implRel),
    implOrig.replace(IMPL_NEEDLE, IMPL_MUTANT),
  );
  const m4 = runGuard();
  results.push([
    "M4 正则改坏：语料有文件但一条引用都取不出",
    ok(m4, true, ["注释里一个测试文件名都没取到"]),
    m4,
  ]);
  // 反向对照：正则坏了这件事本身得能被【真数据那两发数字下界】抓住，
  // 光有哨兵红不够 —— 哨兵只在 refs 恰好为 0 时响，正则【部分】坏掉时它不响。
  const m4b = ok(m4, true, ["语料与取材都真的在跑"]);
  console.log("旁证	M4 同时被「语料与取材都真的在跑」那发抓住：" + (m4b ? "是" : "否（下界没兜住，看一眼）"));
} finally {
  writeFileSync(join(process.cwd(), implRel), implOrig);
  const backImpl = readFileSync(join(process.cwd(), implRel), "utf8");
  console.log("还原：实现与原文" + (backImpl === implOrig ? "逐字一致" : "【不一致！立刻人工检查】"));
  if (existsSync(join(process.cwd(), SRC))) rmSync(join(process.cwd(), SRC), { force: true });
}

let hit = 0;
const miss = [];
for (const [id, good, out] of results) {
  if (good) {
    hit += 1;
    console.log("命中\t" + id);
  } else {
    miss.push(id);
    console.log("未命中\t" + id + "\n---- 完整输出尾部 ----\n" + out.slice(-2500));
  }
}
console.log(`\n结论：${results.length} 发变异，命中 ${hit}，未命中 ${miss.length}`);
if (miss.length > 0) process.exit(1);
