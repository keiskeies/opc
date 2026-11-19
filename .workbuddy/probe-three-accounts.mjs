import { REGISTRY } from "../test/arch/claims-registry.ts";
const doc = "docs/OPC-OS-功能优化设计.md";
const near237 = REGISTRY.filter(
  (e) => e.source.doc === doc && e.source.line >= 215 && e.source.line <= 250,
);
const near1639 = REGISTRY.filter(
  (e) => e.source.doc === doc && e.source.line >= 1600 && e.source.line <= 1670,
);
const snip = (s) => {
  s = String(s);
  return s.length > 60 ? s.slice(0, 57) + "..." : s;
};
console.log("near237", JSON.stringify(near237.map((e) => ({ id: e.id, line: e.source.line, s: snip(e.source.sentence) })), null, 1));
console.log("near1639", JSON.stringify(near1639.map((e) => ({ id: e.id, line: e.source.line, s: snip(e.source.sentence) })), null, 1));
