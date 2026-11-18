import { REGISTRY, realFiles } from "../test/arch/claims-registry.js";
console.log("entries=" + REGISTRY.length);
for (const r of REGISTRY) {
  const m = r.check(realFiles);
  if (m !== "") console.log(r.id + " ⇒ " + m.slice(0, 200));
}
console.log("web/src ts+tsx = " + realFiles.countFiles("packages/web/src", [".ts", ".tsx"]));
console.log(
  "hubTest ok = " +
    (() => {
      try {
        return realFiles.hubTest("acceptance/new-role-to-its-own-criteria.test.ts").length;
      } catch (e) {
        return "THROW " + (e instanceof Error ? e.message : String(e));
      }
    })(),
);
