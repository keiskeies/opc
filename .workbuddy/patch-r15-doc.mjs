import { readFileSync, writeFileSync } from "node:fs";
import { REGISTRY } from "../test/arch/claims-registry.ts";
const r = REGISTRY.find((x) => x.id === "r15");
const row = "| **" + r.id + "** " + r.claim + " | " + r.method + " | " + r.checkedAt + " |";
const p = "docs/OPC-OS-功能优化设计.md";
const md = readFileSync(p, "utf8");
const i = md.indexOf("| **r15**");
const j = md.indexOf("| 2026-11-19 |", i);
const old = md.slice(i, j + 14);
if (old === row) { console.log("already equal"); process.exit(0); }
const next = md.slice(0, i) + row + md.slice(j + 14);
writeFileSync(p, next);
console.log("patched: old len", old.length, "-> new len", row.length);
