import { REGISTRY } from "../test/arch/claims-registry.ts";
const withLine = REGISTRY.filter((r) => r.source.doc.endsWith(".md") && r.source.line > 2500);
console.log("source.line > 2500 的条目：", withLine.map((r) => r.id + ":" + r.source.line).join(", ") || "无");
const max = Math.max(...REGISTRY.map((r) => r.source.line));
console.log("登记坐标最大行号：", max, "（插入点 = 2532）");
