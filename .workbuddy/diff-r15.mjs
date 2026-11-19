import { readFileSync } from "node:fs";
import { REGISTRY } from "../test/arch/claims-registry.ts";
const r = REGISTRY.find((x) => x.id === "r15");
const row = "| **" + r.id + "** " + r.claim + " | " + r.method + " | " + r.checkedAt + " |";
const md = readFileSync("docs/OPC-OS-功能优化设计.md", "utf8");
const at = md.indexOf(row);
console.log("DIFF at index=", at);
if (at < 0) {
  // find the doc row start
  const i = md.indexOf("| **r15**");
  const j = md.indexOf("| 2026-11-19 |", i);
  const docRow = md.slice(i, j + 14);
  console.log("DOC length=", docRow.length, "REG row length=", row.length);
  // first divergence
  let k = 0;
  while (k < docRow.length && k < row.length && docRow[k] === row[k]) k++;
  console.log("first divergence at", k);
  console.log("DOC   ...", JSON.stringify(docRow.slice(Math.max(0,k-60), k+60)));
  console.log("REG   ...", JSON.stringify(row.slice(Math.max(0,k-60), k+60)));
}
