// round301 取证 v3：全仓 10 台变异机的「装载失败那一屏读成什么」普查。
//
// 三个背景事实（都是本轮量出来的，不是从台账抄的）：
//  ① 台账 round295 说「round292/293/294 那三台的 readSummary 是【同一形状】」，
//     此后 round296/298/299/300 每一轮都把这条【原样重登】。v1/v2 探针证明它错：
//     三台在装载失败屏上给出三种不同的读数，危害方向也不同（详见 raw）。
//  ② 真 vitest 在「整份文件装载失败」时，Tests 行是 `no tests`（【没有】failed 数字），
//     红只出现在 Test Files 行。⇒ 只读 Tests 行的机器会拿到 0 红发。
//  ③ 但危害【落在哪一发上」不取决于解析器，取决于 hit 判式：
//     「该红」的发拿到 0 红 ⇒ 判未命中 ⇒ 机器自己叫停（看得见）；
//     「该绿」的发拿到 0 红 ⇒ 判命中 ⇒ 静默假绿（看不见）。
//     所以普查必须【逐台判 hit】，不能只看读数 —— v1 就是栽在这儿。
//
// 判式来源：每台机器的 hit 表达式【从它自己的源码里 grep 出来印在本探针输出里】，
// 再据此人工归类（脚本不假装能自动解析任意判式；它只把两件事摆在一起：
// 读数 + 该机器读的那一个字段）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:/item/opc";
const TMP = join(ROOT, ".workbuddy", "tmp301-extract");

const MACHINES = [
  ".workbuddy/round292-mutate-org-node-criterion.mjs",
  ".workbuddy/round293-mutate-census.mjs",
  ".workbuddy/round293-mutate-gate-exemption.mjs",
  ".workbuddy/round294-mutate-add-node.mjs",
  ".workbuddy/round295-mutate-frontend-egress.mjs",
  ".workbuddy/round296-mutate-path-normalization.mjs",
  ".workbuddy/round298-mutate-edge-gate.mjs",
  ".workbuddy/round299-mutate-node-key-gate.mjs",
  ".workbuddy/round300-mutate-upward-escape.mjs",
];

const screens = [
  ["全绿", ".workbuddy/probe301-green-raw.txt"],
  ["一发红", ".workbuddy/probe301-red-raw.txt"],
  ["装载失败", ".workbuddy/probe301-loadfail-raw.txt"],
].map(([label, rel]) => [label, readFileSync(join(ROOT, rel), "utf8")]);

/** 红味字段名：各台命名不同，逐个列出来（没列到的字段不参与归类）。 */
const RED_KEYS = ["failed", "red", "failedTests", "failedFiles", "redFiles"];

async function load(rel, id) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const at = src.indexOf("function readSummary");
  const end = src.indexOf("\n}", at);
  if (at === -1 || end === -1) throw new Error("切不到 readSummary：" + rel);
  // readSummary 的自由变量：ESC 常量与 strip 助手，各自从源码里一起切出来。
  // 为什么不能省：round298/299 的 readSummary 调 strip()，切不到就【抛在探针自己身上】,
  // 而那看起来像「这台机器安全」—— 探针自己造一个假的【安全】读数，与被审计的
  // 洞同族（读数是绿的方向时没人会去复核）。所以这里不但要切，还要在下面
  // 【逐台打印切到的 prelude 字节数】，让「没切到」这件事在输出里可见。
  const preludeOf = (needle, takeFn) => {
    const i = src.indexOf(needle);
    if (i === -1) return "";
    // 一行 const 取到行尾；函数体取到下一个顶格 `}`。
    // ⚠ 这里曾错过一次：对 ESC 那一行也用「找 \n}」，于是把它之后几十行
    //   （含 readFileSync(SRC) 这类真会执行的语句）整段切进临时模块 ——
    //   探针在导入时就炸。炸出来是运气好：另一种可能是切到的语句【安静地跑掉】。
    const e = takeFn ? src.indexOf("\n}", i) : src.indexOf("\n", i);
    return src.slice(i, (e === -1 ? src.indexOf("\n", i) : e + (takeFn ? 2 : 0))) + "\n";
  };
  const prelude =
    preludeOf("const ESC = String.fromCharCode(27);", false) +
    preludeOf("function strip(", true);
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, id + ".mjs");
  writeFileSync(file, prelude + "export " + src.slice(at, end + 2) + "\n", "utf8");
  return {
    fn: (await import(pathToFileURL(file).href)).readSummary,
    src,
    preludeBytes: prelude.length,
  };
}

const rows = [];
try {
  for (const rel of MACHINES) {
    const id = rel
      .replace(/^\.workbuddy\//u, "")
      .replace("-mutate-", ".")
      .replace(".mjs", "");
    const { fn, src, preludeBytes } = await load(rel, id.split(".").join(""));
    const hitLines = src
      .split(/\r?\n/u)
      .map((l, i) => [i + 1, l.trim()])
      .filter(([, l]) => /^\s*(let |const )?hit\b/u.test(l) || /= expectRed \?/u.test(l))
      .map(([n, l]) => `L${n} ${l}`)
      .slice(0, 3);
    // 这台机器的自证里有没有「装载失败」这一屏（真输出里有 `no tests`）。
    const hasLoadFailFixture = /\bno tests\b/u.test(src);

    const readings = [];
    for (const [label, out] of screens) {
      try {
        const r = fn(out, label === "全绿" ? false : undefined);
        const flat = {};
        for (const k of Object.keys(r)) {
          const v = r[k];
          if (v instanceof Set) flat[k] = v.size;
          else if (v && typeof v === "object") {
            for (const k2 of Object.keys(v)) flat[`${k}.${k2}`] = v[k2];
          } else flat[k] = v;
        }
        readings.push([label, flat]);
      } catch (err) {
        readings.push([label, { 抛: String(err.message).split("\n")[0].slice(0, 60) }]);
      }
    }
    const lf = readings[2][1];
    const redSeen = RED_KEYS.filter((k) => Number(lf[k] ?? 0) > 0);
    const redZero = RED_KEYS.filter((k) => k in lf).filter((k) => lf[k] === 0);
    rows.push({
      id,
      hit: hitLines,
      fixture: hasLoadFailFixture,
      lf,
      redSeen,
      redZero,
      threw: "抛" in lf,
    });
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log("══════ 装载失败屏：逐台读数 / 红味字段 / 自证是否有该屏夹具\n");
for (const r of rows) {
  const state = r.threw
    ? "【当场抛】"
    : r.redSeen.length > 0 && r.redZero.length === 0
      ? "所有红味字段都非 0 ⇒ 无论读哪个字段都看得见"
      : r.redSeen.length === 0
        ? "【所有红味字段都是 0 ⇒ 读哪个字段都是绿】"
        : "字段不一致（红味里有非 0 也有 0）⇒ 危害方向取决于 hit 读哪一个";
  console.log(`── ${r.id}`);
  console.log(`   读数        ${JSON.stringify(r.lf)}`);
  console.log(`   归类        ${state}`);
  console.log(`   自证含该屏  ${r.fixture ? "有" : "没有"}`);
  for (const l of r.hit) console.log(`   hit         ${l}`);
}
const n = (f) => rows.filter(f).length;
console.log(
  `\n分母：机器 ${rows.length} 台；当场抛 ${n((r) => r.threw)}；` +
    `字段全 0（读哪个都绿）${n((r) => !r.threw && r.redSeen.length === 0)}；` +
    `字段不一致（取决于 hit）${n((r) => !r.threw && r.redSeen.length > 0 && r.redZero.length > 0)}；` +
    `自证含装载失败夹具 ${n((r) => r.fixture)} / ${rows.length}`,
);
