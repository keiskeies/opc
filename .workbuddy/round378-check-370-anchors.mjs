// 改前预检：把 round370-fill-mutations.mjs 的每一发 from 锚点与 expect 命中数先查一遍。
// 为什么值得单开一发：那台机器是【边跑边查】，第 N 发才发现 FROM 不命中时前 N-1 发的时间已烧掉；
// 而且这一轮 group.css 被重排过（gap 归 var(--space-*)、markdown 那条覆盖搬进 .editor-panes），
// 老锚点必然有overdue 的。只读，不改任何字节。
import { readFileSync } from "node:fs";

const ROOT = "D:/item/opc/";
const FILES = {
  CSS: readFileSync(ROOT + "packages/web/public/group.css", "utf8"),
  JS: readFileSync(ROOT + "packages/web/public/group.js", "utf8"),
};
const SPECS = {
  LAYOUT: "test/e2e/doc-layout.spec.ts",
  WORKBENCH: "test/e2e/group-workbench.spec.ts",
  RICH: "test/e2e/rich-editor.spec.ts",
};
const specText = {};
for (const [k, p] of Object.entries(SPECS))
  specText[k] = readFileSync(ROOT + p, "utf8");

const script = readFileSync(
  ROOT + ".workbuddy/scratch/round370-fill-mutations.mjs",
  "utf8",
);
const Q = String.fromCharCode(96);
const D = String.fromCharCode(34);
const S = String.fromCharCode(39);
const lit = new RegExp(
  `from:\\s*(?:${D}((?:[^${D}\\\\]|\\\\.)*)${D}|${S}((?:[^${S}\\\\]|\\\\.)*)${S}|${Q}([\\s\\S]*?)${Q})`,
  "gu",
);
// 转义必须按【字符义】解：上一版一律把 `\X` 打成 `X`，于是锚点结尾的 `\n` 变成了字母 n，
// C1/C2/C3/C4/A1/A2 六发全被报成「FROM 过期」—— 那是【检查器的错】，锚点其实活得好好的
// （真文件里 .workspace.list-collapsed{--list-width:0px} 在 group.css:614）。
// 预检器自己错一次，代价是别人去改一批没坏的锚点，比漏报严重。
const unesc = (raw, quote) =>
  quote === Q
    ? raw
    : raw.replace(new RegExp(`\\\\(.)`, "gu"), (_all, ch) =>
        ch === "n"
          ? "\n"
          : ch === "t"
            ? "\t"
            : ch === "r"
              ? "\r"
              : ch,
      );

const ids = [...script.matchAll(/id: "([^"]+)"/g)].map((m) => m[1]);
const froms = [...script.matchAll(lit)].map((m) =>
  m[1] !== undefined
    ? unesc(m[1], D)
    : m[2] !== undefined
      ? unesc(m[2], S)
      : m[3],
);
const files = [...script.matchAll(/file: ([A-Z_]+)/g)].map((m) => m[1]);
const specs = [...script.matchAll(/spec: ([A-Z_]+)/g)].map((m) => m[1]);
const expects = [...script.matchAll(/expect: "([^"]+)"/g)].map((m) => m[1]);
console.log(
  `解析对齐：id ${ids.length} / from ${froms.length} / file ${files.length} / spec ${specs.length} / expect ${expects.length}`,
);
if (ids.length !== froms.length || ids.length !== expects.length) {
  console.log("解析没对齐 ⇒ 本预检的结论无效");
  process.exit(2);
}

const flat = (s) => s.replace(/\s+/gu, " ");
let dead = 0;
for (const [i, id] of ids.entries()) {
  const text = FILES[files[i]] ?? "";
  const hits = text.split(froms[i]).length - 1;
  const grep = expects[i];
  const titleHits = (specText[specs[i]] ?? "").split(grep).length - 1;
  const flag = hits === 1 ? "" : "  ⇐ FROM 过期";
  if (hits !== 1) dead += 1;
  const warn2 = titleHits === 1 ? "" : `  ⇐ expect 命中 ${titleHits} 条`;
  if (titleHits !== 1) dead += 1;
  console.log(
    `${id.padEnd(30)} from=${hits} expect(${specs[i]})=${titleHits}${flag}${warn2}`,
  );
  if (hits !== 1)
    console.log(`     FROM: ${flat(froms[i]).slice(0, 120)}`);
}
console.log(`过期发数：${dead}`);
process.exit(dead === 0 ? 0 : 1);
