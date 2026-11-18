// round286 · 「按调用点」到底能不能判：先把【真·网络出口】和【调注入实现】分开数。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const SRC = "packages/hub/src";
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".ts")) out.push(p.split("\\").join("/"));
  }
  return out;
};
// 全局 fetch( = 前面不是 . # 或标识符字符（`this.#fetch(` 与 `#fetch(` 都不算网络出口）
const GLOBAL = /(?<![.#\w$])fetch\(/;
let sites = 0;
for (const p of walk(SRC)) {
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("//")) {
      const cut = line.slice(0, Math.max(0, line.search(GLOBAL)));
      if (cut.includes("//")) return;
    }
    if (GLOBAL.test(line)) {
      sites += 1;
      console.log("egress " + p + ":" + (i + 1) + "  " + line.trim().slice(0, 70));
    }
  });
}
console.log("hub/src 里真·网络出口处数 =", sites);
