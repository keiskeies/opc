// 单根复核：把 M6/M7 各剪一次，打印 e2e 真正红在哪一条断言上。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const PROBES = [
  {
    id: "M6",
    file: "packages/web/public/group.js",
    from: '        class: "admin-mount-nav",\n        "aria-label": "主导航",\n        hidden: true,',
    to: '        class: "admin-mount-nav",\n        "aria-label": "主导航",',
  },
  {
    id: "M7",
    file: "packages/web/public/group.css",
    from: "[hidden] { display: none !important; }",
    to: "[hidden] { display: none; }",
  },
];
for (const p of PROBES) {
  const orig = readFileSync(p.file, "utf8");
  const before = sha(orig);
  writeFileSync(p.file, orig.replace(p.from, p.to), "utf8");
  const r = spawnSync("npx", ["playwright", "test", "test/e2e/group-workbench.spec.ts", "-g", "侧栏入口", "--reporter=list"], { encoding: "utf8", shell: true, maxBuffer: 64e6 });
  writeFileSync(p.file, orig, "utf8");
  const restored = sha(readFileSync(p.file, "utf8")) === before;
  const out = `${r.stdout}\n${r.stderr}`;
  const hits = out.split(/\r?\n/).filter((l) => /Error|expect\(|toHaveJSProperty|toBeHidden|passed|failed|No tests/u.test(l)).slice(0, 14);
  console.log(`=== ${p.id} exit=${r.status} restored=${restored} ===`);
  console.log(hits.join("\n"));
  if (!restored) { console.log("⛔ 还原失败 " + p.file); process.exit(2); }
}
