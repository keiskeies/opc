import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["test", "packages/hub/test", "packages/desktop/test", "packages/web/test", "docs/review", "scripts"];
function ts(dir) {
  let o = [];
  let e;
  try {
    e = readdirSync(dir);
  } catch {
    return o;
  }
  for (const n of e) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) o = o.concat(ts(p));
    else if (/\.(ts|mjs|js)$/.test(n)) o.push(p);
  }
  return o;
}
const BS = String.fromCharCode(92);
const pats = [
  ["endsWith-slash", /\.endsWith\(\s*["'`][^"'`]*\/[^"'`]*["'`]\s*\)/],
  ["includes-slash", /\.includes\(\s*["'`][^"'`]*\/[^"'`]*["'`]\s*\)/],
  ["replace-slash", /\.replace\(\s*[A-Za-z_$][\w$.]*\s*\+\s*["']\/["']/],
  ["concat-slash", /(SRC|ROOT|HUB|DIR|BASE|TMP)\s*\+\s*["']\/[a-zA-Z]/],
  ["split-slash", /\.split\(\s*["']\/["']\s*\)/],
  ["url-pathname", /\.pathname\b/],
];
const hits = new Map();
for (const r of roots)
  for (const f of ts(r)) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
      for (const [k, re] of pats) {
        if (re.test(l)) {
          const key = f.split(BS).join("/");
          if (!hits.has(key)) hits.set(key, []);
          hits.get(key).push(k + ":" + (i + 1));
        }
      }
    });
  }
let n = 0;
for (const [f, v] of [...hits].sort((a, b) => b[1].length - a[1].length)) {
  n += v.length;
  console.log(String(v.length).padStart(3), f, v.slice(0, 14).join(" "));
}
console.log("files:", hits.size, "hits:", n);
