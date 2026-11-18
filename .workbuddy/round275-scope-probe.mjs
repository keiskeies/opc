import { readCorpus, referencedTaskIds, TASK_REF_RE } from "../test/arch/plan-refs.ts";
const c = readCorpus(".").files;
const bucket = (pred) => {
  const sub = new Map([...c].filter(([n]) => pred(n)));
  const refs = referencedTaskIds(sub);
  return [sub.size, [...refs.values()].reduce((a, b) => a + b, 0)];
};
const md = (n) => n.endsWith(".md");
console.log("全部 md 文件数/引用数      ", bucket(md));
console.log("docs/decisions 下 md       ", bucket((n) => n.startsWith("docs/decisions/") && md(n)));
console.log("docs 下但不在 decisions    ", bucket((n) => md(n) && !n.startsWith("docs/decisions/")));
console.log("decisions 里不同编号数      ", referencedTaskIds(new Map([...c].filter(([n]) => n.startsWith("docs/decisions/") && md(n)))).size);
void TASK_REF_RE;
