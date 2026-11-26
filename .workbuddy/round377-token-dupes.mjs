import { readFileSync } from "node:fs";
const blockOf = (file, sel) => {
  const src = readFileSync(file, "utf8");
  const i = src.indexOf(sel);
  if (i < 0) throw new Error(`找不到块 ${sel}`);
  const open = src.indexOf("{", i);
  let d = 0;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === "{") d += 1;
    else if (src[j] === "}" && (d -= 1) === 0) return src.slice(open, j);
  }
  throw new Error("花括号没配平");
};
const toks = (s) => {
  const out = [];
  for (const x of s.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/gu)) out.push([x[1].slice(2), x[2].toLowerCase()]);
  return out;
};
const SCOPES = {
  "group-light": ["packages/web/public/group.css", ":root {"],
  "group-dark": ["packages/web/public/group.css", 'html[data-theme="dark"] {'],
  "admin-light": ["packages/web/public/admin.css", ".admin-root {"],
  "admin-dark": ["packages/web/public/theme.css", 'html[data-theme="dark"] .admin-root {'],
};
for (const [name, [f, sel]] of Object.entries(SCOPES)) {
  const list = toks(blockOf(f, sel));
  const byVal = new Map();
  for (const [k, v] of list) {
    if (!byVal.has(v)) byVal.set(v, []);
    byVal.get(v).push(k);
  }
  const dupes = [...byVal.entries()].filter(([, ks]) => ks.length > 1);
  console.log(`\n${name}：${list.length} 枚 hex token · 逐字节同值的组 ${dupes.length} 组`);
  for (const [v, ks] of dupes) console.log(`  ${v} ⇒ ${ks.join(" = ")}`);
}
