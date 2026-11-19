// 只【打印】r1 那一行该怎么写，不写文件：把渲染表贴回 docs 正文仍是一处一人手工的动作。
import { readFileSync } from "node:fs";
import { join } from "node:path";
const { REGISTRY, renderMarkdown } = await import("../test/arch/claims-registry.ts");
const line = renderMarkdown(REGISTRY.filter((r) => r.id === "r1"));
console.log(line);
