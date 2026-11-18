// round301 取证 v2：装载失败那一屏，四台机器【各自】会不会把一发判成「命中」。
//
// 为什么要 v2：v1 的结论行是我自己写的「读数里有任何非 0 就算看得见」，
//   那不是任何一台机器的判式。round300 的教训正是「对错一半的往往是决定危害方向的那半」，
//   所以这里逐台用它们【源码里那一句 hit=…】来判。
//
// 每台切两段自己的字节：顶格的 `const ESC = …`（round295 的 readSummary 用它）
// 与 readSummary 本体；hit 判式抄在下面的 MUT 里，并把抄的出处行号写进注释。
//
// 三份屏：全绿 / 一发红 / 装载失败（Tests 行 "no tests"、Test Files 行 1 failed）。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = "D:/item/opc";
const TMP = join(ROOT, ".workbuddy", "tmp301-extract");

/** 切出机器自己的字节：ESC 常量（若有）+ readSummary 本体。 */
async function extract(rel, id) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const at = src.indexOf("function readSummary");
  if (at === -1) throw new Error("切不到 readSummary：" + rel);
  const end = src.indexOf("\n}", at);
  if (end === -1) throw new Error("切不到 readSummary 的收尾：" + rel);
  const escAt = src.indexOf("const ESC = String.fromCharCode(27);");
  const prelude =
    escAt === -1 ? "" : src.slice(escAt, src.indexOf("\n", escAt)) + "\n";
  mkdirSync(TMP, { recursive: true });
  const file = join(TMP, id + ".mjs");
  writeFileSync(file, prelude + "export " + src.slice(at, end + 2) + "\n", "utf8");
  return (await import(pathToFileURL(file).href)).readSummary;
}

const screens = [
  ["全绿", ".workbuddy/probe301-green-raw.txt"],
  ["一发红", ".workbuddy/probe301-red-raw.txt"],
  ["装载失败", ".workbuddy/probe301-loadfail-raw.txt"],
].map(([label, rel]) => [label, readFileSync(join(ROOT, rel), "utf8")]);

/**
 * 各台的 hit 判式，逐字抄自其源码（出处写在行号里）：
 *  292 L198 `const hit = expectRed ? tests.failed > 0 : tests.failed === 0;`
 *  293 L161 `const hit = mut.expectRed ? r.red > 0 : r.red === 0;`
 *  294 L266-280 `red = failed > 0` + mustRed/mustGreen + 「应全绿但红了 N 份」
 *  295 与 294 同族（本轮作为【修好的那一台】的对照）
 */
const machines = [
  {
    id: "round292",
    rel: ".workbuddy/round292-mutate-org-node-criterion.mjs",
    hit: (r, expectRed) => (expectRed ? r.tests.failed > 0 : r.tests.failed === 0),
    // L197：只有 M0 那发带 wantFail=false，它形状不对会【抛】。
    wantFail: (expectRed) => (expectRed ? undefined : false),
  },
  {
    id: "round293",
    rel: ".workbuddy/round293-mutate-census.mjs",
    hit: (r, expectRed) => (expectRed ? r.red > 0 : r.red === 0),
  },
  {
    id: "round294",
    rel: ".workbuddy/round294-mutate-add-node.mjs",
    hit: (r, expectRed) => {
      const red = r.failed > 0;
      if (red !== expectRed) return false;
      return expectRed || r.files.size === 0;
    },
  },
  {
    id: "round295",
    rel: ".workbuddy/round295-mutate-frontend-egress.mjs",
    hit: (r, expectRed) => {
      const red = r.failed > 0;
      if (red !== expectRed) return false;
      return expectRed || r.files.size === 0;
    },
  },
];

const summary = [];
try {
  for (const m of machines) {
    const fn = await extract(m.rel, m.id);
    console.log(`\n══════ ${m.id}`);
    for (const [label, out] of screens) {
      for (const expectRed of [true, false]) {
        let line;
        try {
          const r = fn(out, m.wantFail ? m.wantFail(expectRed) : undefined);
          const shown = Object.keys(r)
            .map((k) => {
              const v = r[k];
              if (v instanceof Set) return `${k}=${v.size}`;
              if (v && typeof v === "object") return `${k}.failed=${v.failed}`;
              return `${k}=${String(v)}`;
            })
            .join(" ");
          const hit = m.hit(r, expectRed);
          line = `应${expectRed ? "红" : "绿"} ⇒ ${hit ? "【命中】" : "未命中"}  (${shown})`;
          summary.push([m.id, label, expectRed, hit, "读数 " + shown]);
        } catch (err) {
          const msg = String(err.message).split("\n")[0].slice(0, 90);
          line = `应${expectRed ? "红" : "绿"} ⇒ 【抛】${msg}`;
          summary.push([m.id, label, expectRed, "throw", msg]);
        }
        console.log(`  ${label.padEnd(5)} ${line}`);
      }
    }
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log("\n══════ 台账要的那句：装载失败屏上，「该绿」那一侧读成什么");
for (const [id, label, expectRed, hit, note] of summary) {
  if (label !== "装载失败") continue;
  const mark =
    hit === "throw" ? "抛（安全）" : hit ? "【假命中】" : "未命中（安全）";
  console.log(`  ${id.padEnd(9)} 应${expectRed ? "红" : "绿"} ⇒ ${mark}   ${note}`);
}
