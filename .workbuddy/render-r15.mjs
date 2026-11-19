import { REGISTRY } from "../test/arch/claims-registry.ts";
const r = REGISTRY.find((x) => x.id === "r15");
if (!r) throw new Error("no r15");
const row = "| **" + r.id + "** " + r.claim + " | " + r.method + " | " + r.checkedAt + " |";
console.log("LEN=" + row.length);
console.log("TAIL=" + row.slice(-320));
