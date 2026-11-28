// round401：给 SNAP 补齐「文档里有引用、快照里没这条键」的条目（本轮新增 0082 台账 + INDEX 入口行）。
// 三条约束：
//  ① 只【追加】新键，绝不改已有键与其值（改值 = 给旧主张换新标签）；
//  ② 值取自当前文件那一行的 trim()，与守卫同一口径（守卫读 src[ln-1].trim()）；
//  ③ 追加前先确认这一行非空且键不重复 —— 空行目标守卫会单独报「引用没有内容可指」，
//     那种引用是文档写错了，不能靠补快照把它糊过去。
// 默认 dry-run，`--apply` 才写。
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const SNAP_PATH = "test/arch/doc-refs.test.ts";
const FILE_REF =
  /([A-Za-z0-9_./-]+[.](?:ts|tsx|mts|cts|js|mjs|cjs|md|sql))[:]([0-9]+)/g;
const EXTERNAL = new Set(["outputs.d.ts"]);

const docs = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = `${d}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) docs.push(p);
  }
})("docs");

const snapText = readFileSync(SNAP_PATH, "utf8");
/**
 * 数 SNAP 里已有的键：用【引号扫描器】而不是正则。
 *
 * 为什么不是正则：键与值可能同行（`"键": "值",`）也可能分行，值里还常含 `"`（biome 会把那种
 * 值排成单引号）。第一版用 `^"[^"]+":` 配 `^"[^">]+>[^:]+:\d+":` 两种写法各数出 359 条，
 * 却互差 14 条 —— 两条正则在同一段文本上贪心到了不同的引号对上。这件事正是 0082 §8 门 2
 * 判的东西：键集合认不全 ⇒ 以为「文档有、快照无」⇒ 凭空补出一批同名键 ⇒ 顶掉旧主张。
 * 所以这里按【第一个未闭合的引号对】取键，再要求紧跟 `:`，逐行确定性判定。
 */
const existing = new Set();
for (const line of snapText.split("\n")) {
  const start = line.search(/"/u);
  if (start < 0 || !/^\s*"/u.test(line)) continue;
  let end = -1;
  for (let i = start + 1; i < line.length; i += 1) {
    if (line[i] === "\\") i += 1;
    else if (line[i] === '"') {
      end = i;
      break;
    }
  }
  if (end < 0) continue;
  if (line.slice(end + 1).search(/^\s*:/u) !== 0) continue;
  const key = line.slice(start + 1, end).replace(/\\"/g, '"');
  if (existing.has(key)) {
    console.log(`⛔ SNAP 里已经有同名键 ${key} —— 先修快照，别追加`);
    process.exit(3);
  }
  existing.add(key);
}

const fileCache = new Map();
const read = (rel) => {
  if (!fileCache.has(rel)) fileCache.set(rel, readFileSync(rel, "utf8").split("\n"));
  return fileCache.get(rel);
};

// 目标解析必须与守卫【同一把尺子】（doc-refs.test.ts 的 resolveTarget）：文档里大量引用只写基名
// （`today.ts:266`），守卫是在全仓文件名里按「以 /基名 结尾」唯一命中来定位的。我第一版直接
// readFileSync(基名) ⇒ 几十个「目标文件读不到」全是假报，那种假报会让人以为文档坐标坏了。
const names = [];
(function walkRepo(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", ".tmp", "dist"].includes(e.name)) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walkRepo(p);
    else names.push(p.split("\\").join("/"));
  }
})(".");
function resolveTarget(file) {
  const direct = names.filter((p) => p === file || p.endsWith("/" + file));
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const base = file.split("/").pop() ?? "";
  const byBase = names.filter((p) => p.endsWith("/" + base));
  return byBase.length === 1 ? byBase[0] : undefined;
}

const additions = [];
const bad = [];
for (const rel of docs.sort()) {
  const base = rel.split("/").pop();
  for (const line of readFileSync(rel, "utf8").split("\n")) {
    FILE_REF.lastIndex = 0;
    let m = FILE_REF.exec(line);
    while (m) {
      const file = m[1];
      const ln = Number(m[2]);
      if (EXTERNAL.has(file)) {
        m = FILE_REF.exec(line);
        continue;
      }
      const key = `${base}>${file}:${ln}`;
      if (existing.has(key)) {
        m = FILE_REF.exec(line);
        continue;
      }
      const target = resolveTarget(file);
      if (target === undefined) {
        // 找不到或同名歧义 ⇒ 是【文档写错了】，补快照等于把假坐标糊成绿。报出去，别动。
        bad.push(`${key} 仓库里找不到该文件，或同名歧义没指定目录`);
        m = FILE_REF.exec(line);
        continue;
      }
      const src = read(target);
      if (ln < 1 || ln > src.length) {
        bad.push(`${key} 越界：${target} 只有 ${src.length} 行`);
        m = FILE_REF.exec(line);
        continue;
      }
      const text = (src[ln - 1] ?? "").trim();
      if (text === "") bad.push(`${key} 目标行是空行（文档坐标写错了，别补快照）`);
      else if (!additions.some((a) => a.key === key)) additions.push({ key, text });
      m = FILE_REF.exec(line);
    }
  }
}
if (bad.length > 0) {
  console.log("⛔ 先修文档坐标，别补快照：");
  for (const b of bad) console.log("  " + b);
  process.exit(3);
}
console.log(`待补 ${additions.length} 条（现有 ${existing.size} 条键不动）`);
for (const a of additions) console.log(`  + ${a.key} = ${a.text.slice(0, 60)}`);
if (!APPLY) {
  console.log("dry-run 结束（未落盘）。加 --apply 才写。");
  process.exit(0);
}
// biome 的排版口径（照既有 358 条键逐字节对齐）：值里含 `"` ⇒ 用单引号包裹且内部【不转义】，
// 否则用双引号并转义 `\` 与 `"`。选错排版的后果见 0082 §8 门 2：键扫描只认一种排版就认不全
// 键集合 ⇒ 搬运缺档 ⇒ 自撞出重复键。守卫拿到的是解析后的字符串，所以两种写法都必须还原出
// 与源文件 trim() 一字不差的值。
const fmt = (v) => {
  if (v.includes('"') && !v.includes("'")) return `'${v}'`;
  const esc = v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${esc}"`;
};
const block = additions
  .map((a) => `  "${a.key}":\n    ${fmt(a.text)},`)
  .join("\n");
const at = snapText.lastIndexOf("\n};");
writeFileSync(
  SNAP_PATH,
  `${snapText.slice(0, at)}\n${block}${snapText.slice(at)}`,
);
console.log(`落盘：追加 ${additions.length} 条到 ${SNAP_PATH}`);
