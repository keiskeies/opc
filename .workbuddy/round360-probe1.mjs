import { readFileSync, writeFileSync } from "node:fs";

const p = ".workbuddy/round360-r25-tests.txt";
const L = readFileSync(p, "utf8").split("\n");
const i = L.findIndex((l) => l.includes("COALESCE\\(\\(SELECT b\\.limit_cents"));
if (i < 0) throw new Error("ABORT 找不到那行正则");
// 那一段源码替换成一条【JS 字符串字面量】，其值只有一个字节 `?` ⇒ 分母退回裸绑参。
// 写成 '"?"'：外层单引号是测试文件的字面量，内层那对双引号是被替换进源码的引号。
L[i + 1] = '      \'"?"\',';
const s = L.join("\n");
if ((s.match(/\uFFFD/g) || []).length > 0) throw new Error("ABORT FFFD");
writeFileSync(p, s);
console.log("replacement line:", JSON.stringify(L[i + 1]));

// 自证：三条变异打在真生产字节上的读数
const pump = readFileSync("packages/hub/src/serve/charter-pump.ts", "utf8");
const strip = (x) =>
  x
    .split("\n")
    .map((l) => {
      const k = l.indexOf("//");
      return k === -1 ? l : l.slice(0, k);
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
const sliceOf = (x) => {
  const code = strip(x);
  const a = code.indexOf("export function underTaskBudgetSql");
  const b = code.indexOf("export const CHARTER_CANDIDATES_SQL", a + 1);
  return code.slice(a, b);
};
const re = new RegExp(
  [
    '"COALESCE\\(\\(SELECT b\\.limit_cents FROM budgets b " \\+\\s*\\n\\s*"WHERE b\\.scope_type = ',
    "'task' AND b\\.scope_id = \" \\+\\s*\\n\\s*t \\+\\s*\\n\\s*\"\\.id AND b\\.period = ",
    "'per_task'\\), \\?\\)\"",
  ].join(""),
  "u",
);
const repl = '"' + "?" + '"';
const m1 = pump.replace(re, repl);
console.log("re hits:", (pump.match(re) || []).length, "| changed:", m1 !== pump);
const a = m1.indexOf("export function underTaskBudgetSql");
console.log(
  "M1 slice 片段:",
  JSON.stringify(m1.slice(a, a + 400).split("\n").slice(2, 8).join(" | ")),
);
console.log(
  "M1 E1 gone:",
  !sliceOf(m1).includes("COALESCE((SELECT b.limit_cents FROM budgets b "),
  "| E2 stays:",
  sliceOf(m1).includes(", 0) < "),
  "| binds",
  (sliceOf(m1).match(/\?/gu) || []).length,
);
