/*
 * 一次性测量（round336）：如果真跑一次 `biome check --write`（format + organizeImports），
 * 那些【被 docs 引用的源码行号】会有多少被顶漂？
 *
 * ⚠ 本文件头原来写过「全仓没有任何一条守卫核对这些行号」—— 【那句是假的】，
 * 本轮读 test/arch/doc-refs.test.ts 才推翻：那里有一份 SNAP 内容快照，
 * 逐条比对「文档说在第 N 行的那句话，现在还在不在第 N 行」。
 * 所以「整仓重排」的后果不是我原先以为的【静默制造一批假坐标】，是【当场红一大片】
 * （本轮实测：我只往 app.js 插了 ~170 行，就把 4 条坐标顶漂 ⇒ doc-refs 立刻红，
 * 而且是带着「快照是什么 / 现在是什么」两句原文红的）。
 * 这一发量到的数【仍然有用】，只是用法变了：它量的是【改一次要重锚多少条】，
 * 也就是那次纯排版提交的【人工复核量】—— 73 条不是一个可以 --write 完再
 * 顺手跑个脚本回填的数（doc-refs 文件头明令不许写自动回填器：那等于把守卫
 * 变成它要防止的东西）。⇒ 结论从「危险且无声」改成「可做但一次 73 条手工活，
 * 且必须与重锚同一次提交」，这一格仍归「先 commit 再全仓修」那一档（要问）。
 *
 * ⚠ 取材方式换过一次，理由记在这儿因为它本身就是本轮撞到的坑：
 *   第一版把文件【复制到系统临时目录】再对副本跑 biome ⇒ biome 直接崩
 *   （ignore-0.4.25 "path is expected to be under the root"，因为配置里 vcs.useIgnoreFile
 *   要把路径挂在仓根下）。崩溃时【每个文件都长一样】而我的循环把"没改"当成"不需要改"，
 *   于是那份读数会全绿 —— memory [[empty-output-is-not-a-clean-result]] 又一例。
 *   现在改用 `--stdin-file-path=<真路径>`：字节走管道，工作树一个字节都不动，
 *   也没有【副本不在仓根下】这个问题。反空转：读不到格式化输出就抛，不返回「没变化」。
 *   ⚠ 另有一条同族的坑本轮又撞一次：把副本放进 .workbuddy/ 也不行 ——
 *   仓库里出现第二份【同名】文件（app.js）会让 doc-refs 的解析器报
 *   「同名歧义」而整条守卫红。探针留副本 = 给别的守卫埋雷，量完就删。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { findBiomeBinary } from "../test/arch/lint-baseline.ts";

const ROOT = process.cwd();
const BIOME = findBiomeBinary(ROOT);

// 不用 /g：带 /g 的 match 返回【全部整匹配】而没有捕获组，m[1] 是【第二条匹配】而不是
// 文件名 —— 第一版就这么读出「cited files: 1」，一个看起来像读数的假读数。
const RE = /([a-zA-Z0-9_.-]+\.(?:ts|js|mjs)):(\d+)/;

const listPath = process.env.CITES_FROM;
if (!listPath) {
  console.log("NO_INPUT :: 先跑 census 生成引用清单（CITES_FROM=<清单路径>）。");
  process.exit(9);
}
const byFile = new Map();
for (const l of readFileSync(listPath, "utf8").split(/\r?\n/)) {
  const m = l.match(RE);
  if (!m) continue;
  const set = byFile.get(m[1]) ?? new Set();
  set.add(Number(m[2]));
  byFile.set(m[1], set);
}
console.log("cited files: " + byFile.size);
if (byFile.size < 50) {
  // 语料下限哨兵：本轮实测 85 个文件。掉到一半以下 = 取材坏了，不是「引用变少了」。
  console.log("CORPUS_TOO_SMALL :: 引用文件数异常少 ⇒ 是清单/正则坏了，下面的读数不成立。");
  process.exit(9);
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === "dist" || name === "coverage") continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const byName = new Map();
for (const p of walk(".", [])) {
  const b = p.split(/[\\/]/).pop();
  const l = byName.get(b) ?? [];
  l.push(p);
  byName.set(b, l);
}

/** 走 stdin 拿【格式化后的全文】。空输出 ⇒ 抛（不返回「没变化」）。 */
function formatted(rel, original) {
  const out = execFileSync(
    BIOME,
    ["check", "--write", "--stdin-file-path=" + rel],
    { input: original, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (out.trim() === "") {
    throw new Error("biome --stdin 对 " + rel + " 返回空 —— 判不了，拒绝读成「无需改动」");
  }
  return out;
}

let shifted = 0;
let unchanged = 0;
let unresolved = 0;
let movedCites = 0;
const report = [];
for (const [base, citedLines] of byFile) {
  const cands = byName.get(base) ?? [];
  if (cands.length !== 1) {
    unresolved++;
    continue;
  }
  const real = cands[0];
  const rel = real.split(/[\\/]/).join("/");
  const before = readFileSync(real, "utf8").split(/\r?\n/);
  let after;
  try {
    after = formatted(rel, readFileSync(real, "utf8")).split(/\r?\n/);
  } catch (e) {
    unresolved++;
    report.push("FORMAT_FAIL " + rel + " :: " + (e instanceof Error ? e.message.slice(0, 80) : ""));
    continue;
  }
  const moved = [];
  for (const ln of citedLines) {
    const original = before[ln - 1];
    if (original === undefined) continue;
    if (after[ln - 1] === original) continue;
    const nowAt = after.indexOf(original);
    moved.push(ln + "→" + (nowAt >= 0 ? String(nowAt + 1) : "MISSING"));
  }
  if (moved.length === 0) {
    unchanged++;
  } else {
    shifted++;
    movedCites += moved.length;
    report.push(base + " 行数 " + before.length + "→" + after.length + " 漂: " + moved.join(", "));
  }
}

console.log(
  JSON.stringify(
    { files: byFile.size, shifted, unchanged, unresolved, movedCitations: movedCites },
    null,
    1,
  ),
);
for (const r of report.slice(0, 40)) console.log(r);
