import { danglingTaskRefs, readCorpus, referencedTaskIds } from "../test/arch/plan-refs.ts";
const c = readCorpus(process.cwd());
const refs = referencedTaskIds(c.files);
const uncited = [...c.planIds].filter((k) => !refs.has(k));
console.log("标题数", c.planIds.size, "| 引用总次数", [...refs.values()].reduce((a, b) => a + b, 0), "| 不同编号", refs.size);
console.log("悬空", JSON.stringify(danglingTaskRefs(c.files, c.planIds)));
console.log("零引用标题数", uncited.length, "→", uncited.join(","));
console.log("md", [...c.files.keys()].filter((k) => k.endsWith(".md")).length, "| ts", [...c.files.keys()].filter((k) => k.endsWith(".ts")).length);
