// round288 探针：`mergeForbiddenForRun` / `gateCriteriaForRole` 今天到底有没有生产调用方。
//
// 为什么要单独写一个文件而不是给一条命令：本仓为这一族撞过三次（round286 的
// `split("fetch(")` 把 `this.#fetch(` 算成网络出口 = 数错分母会让人去"修"一处没坏的东西）。
// 「文档里那句 X 零调用方还成不成立」是一个**判据**，判据要能被复算，而且要写清
// 它把什么算作调用、把什么不算。
//
// 口径（三条，逐条都可反驳，所以写出来）：
//   ① 只数【真调用】：`名字(`，且接收者不是 `.`（方法调用另论，这两个函数都是自由函数）。
//   ② 【注释里的提及不算】—— 本轮第一版探针就栽在这：`author-reviewer.ts` 与
//      `engine/runtime.ts` 两个"命中"全是注释，据此会登记一条假债。
//      实现：先按行剔掉 `//` 与 `*` 开头的行，再匹配。
//      ⚠ 这是【行首/行内单层】剔除，不是完整 JS 词法扫描：跨行块注释里的代码、
//        或字符串字面量里出现 `foo(` 仍会被算进去。这两个函数今天不落在这些形状里
//        （下面会把每处命中的原文打出来，让人自己看一眼是不是真调用），
//        但把这份探针借给别的符号之前要先读这一段。
//   ③ 定义处（`export function 名字`）与【测试文件】分开数：
//      「生产调用方」= ① 命中里，既不在 src 的定义行、也不在 test/ 的那些。
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

const SKIP = new Set(["node_modules", ".git", "dist", ".workbuddy"]);
const SYMBOLS = ["mergeForbiddenForRun", "gateCriteriaForRole"];

function walk(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p.split(sep).join("/"));
  }
  return out;
}

const files = walk("packages", []);
// 行首是注释、或整行是块注释的一行 ⇒ 剔掉。
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;

for (const sym of SYMBOLS) {
  const CALL = new RegExp("(?<![.\\w$])" + sym + "\\s*\\(", "u");
  const DEF = new RegExp("function\\s+" + sym + "\\b", "u");
  const prod = [];
  const tests = [];
  const defs = [];
  const comments = [];
  for (const f of files) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      if (DEF.test(l)) defs.push(f + ":" + (i + 1));
      else if (COMMENT_LINE.test(l) && l.includes(sym)) comments.push(f + ":" + (i + 1));
      else if (CALL.test(l)) (f.includes("/test/") ? tests : prod).push({
        at: f + ":" + (i + 1),
        text: l.trim().slice(0, 100),
      });
    });
  }
  console.log("\n" + "═".repeat(70));
  console.log(sym);
  console.log("  定义处：", defs.join("  ") || "（没找到定义）");
  console.log("  生产调用点（非 test、非注释）：", prod.length);
  for (const p of prod) console.log("      " + p.at + "  " + p.text);
  console.log("  测试里的调用点：", tests.length, tests.map((t) => t.at).join("  "));
  console.log(
    "  只在注释里出现的文件：",
    comments.length,
    comments.join("  "),
  );
  console.log(
    "  ⇒ 「" + sym + " 零生产调用方」这句今天" + (prod.length === 0 ? "【成立】" : "【不成立】"),
  );
}
