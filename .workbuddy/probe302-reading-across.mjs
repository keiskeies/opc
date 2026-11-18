// round302 探针：把【九台】的 readSummary 切片喂 戊/己 两型，打印各自的处置。
// 只读不写（切片写到临时目录），跑完自己删。目的：把「并红型在这两型上读成什么」
// 量出来再写进守卫的注释与判式，不靠记忆。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const TMP = mkdtempSync(join(tmpdir(), "opc-probe302x-"));
const ESC = String.fromCharCode(27);
const colorize = (s) => s.split("[[").join(ESC + "[");

const SCREENS = {
  丙:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/x.test.ts[[2m [ test/arch/x.test.ts ][[22m\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed[[39m[[22m [[90m (1)[[39m\n",
    ) + colorize("[[2m      Tests [[22m [[2mno tests[[22m\n"),
  丁:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/y.test.ts[[2m [ test/arch/y.test.ts ][[22m\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed | 1 passed[[39m[[22m [[90m (2)[[39m\n",
    ) + colorize("[[2m      Tests [[22m [[1m[[32m25 passed[[39m[[22m [[90m (25)[[39m\n"),
  戊:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/probe302dead.test.ts[[2m [ test/arch/probe302dead.test.ts ][[22m\n" +
        "[[41m[[1m FAIL [[22m[[49m test/arch/probe302red.test.ts[[2m > [[22mprobe302 真红[[2m > [[22m这一发故意红\n" +
        "[[2m Test Files [[22m [[1m[[31m2 failed[[39m[[22m[[2m | [[22m[[1m[[32m1 passed[[39m[[22m[[90m (3)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[31m1 failed[[39m[[22m[[2m | [[22m[[1m[[32m5 passed[[39m[[22m[[90m (6)[[39m\n",
    ),
  己:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/probe302hook.test.ts[[2m > [[22mprobe302 hook 炸\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed[[39m[[22m[[2m | [[22m[[1m[[32m1 passed[[39m[[22m[[90m (2)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[32m4 passed[[39m[[22m[[2m | [[22m[[33m1 skipped[[39m[[90m (5)[[39m\n",
    ),
};

const dir = join(ROOT, ".workbuddy");
const corpus = readdirSync(dir)
  .filter((n) => /^round\d+-mutate-.*\.mjs$/u.test(n))
  .filter((n) => readFileSync(join(dir, n), "utf8").includes("function readSummary"))
  .sort();

const sliceRange = (src, start, toBrace) => {
  const e = toBrace ? src.indexOf("\n}", start) : src.indexOf("\n", start);
  return src.slice(start, e === -1 ? src.indexOf("\n", start) : e + (toBrace ? 2 : 0));
};

let seq = 0;
const flatten = (r) => {
  const o = r ?? {};
  const out = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v instanceof Set) out[k] = v.size;
    else if (v !== null && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v)) if (typeof v2 === "number") out[k + "." + k2] = v2;
    } else if (typeof v === "number") out[k] = v;
  }
  return out;
};

for (const rel of corpus) {
  const src = readFileSync(join(dir, rel), "utf8");
  const at = src.indexOf("function readSummary");
  const escAt = src.indexOf("const ESC = String.fromCharCode(27);");
  const stripAt = src.indexOf("function strip(");
  const prelude =
    (escAt === -1 ? "" : sliceRange(src, escAt, false) + "\n") +
    (stripAt === -1 ? "" : sliceRange(src, stripAt, true) + "\n");
  const body = prelude + "export " + sliceRange(src, at, true) + "\n";
  const arch = body.includes("if (!/\\d/u.test(seg)) {")
    ? "计数型"
    : body.includes("failed: failedTests + failedFiles")
      ? "并红型"
      : "??";
  seq += 1;
  const file = join(TMP, "p" + seq + ".mjs");
  writeFileSync(file, body, "utf8");
  const mod = await import(pathToFileURL(file).href);
  const line = [];
  for (const name of ["丙", "丁", "戊", "己"]) {
    try {
      const flat = flatten(mod.readSummary(SCREENS[name]));
      line.push(name + " 读数 " + JSON.stringify(flat));
    } catch (e) {
      line.push(name + " 抛「" + String(e.message).split("\n")[0].slice(0, 26) + "」");
    }
  }
  console.log("── " + arch + "  " + rel + "\n     " + line.join("\n     "));
}
rmSync(TMP, { recursive: true, force: true });
