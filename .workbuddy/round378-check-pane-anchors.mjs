// 变异机锚点的离线预检（不启动任何 runner）：把 round378-pane-mutations.mjs 里每条
// from / to / expect 在对应源文件与 spec 上数一遍命中。
// 为什么按行扫而不是整段正则：`from` 里有 String.raw 模板与转义双引号两种写法，
// 一条大正则要么被反斜杠咬住、要么把 shell 的参数吃掉（本仓被这一族绊过三次）。
// ⚠ 这里的两条匹配一律用【正则字面量】：上一版图省事写成 String.raw 模板，
//   两个反引号漏掉一个 ⇒ 整个文件解析不了，而它自己正是用来发现「锚点过期」的东西。
// 用法：node .workbuddy/round378-check-pane-anchors.mjs
import { readFileSync } from "node:fs";

const ROOT = "D:/item/opc/";
const BT = String.fromCharCode(96);
const RAW_PREFIX = "String.raw" + BT;
const FILES = {
  CSS: "packages/web/public/group.css",
  JS: "packages/web/public/group.js",
  MD: "packages/web/public/markdown.js",
};
const SPECS = {
  PREVIEW_SPEC: "test/e2e/doc-preview.spec.ts",
  MD_TEST: "test/web/markdown.test.ts",
};

/** 单引号 JS 字面量 → 实际字符串（JSON 不认单引号串，所以自己剥）。 */
function unquoteSingle(s) {
  const ESC = String.fromCharCode(1);
  return s
    .slice(1, -1)
    .split("\\\\")
    .join(ESC)
    .split("\\'")
    .join("'")
    .split("\\n")
    .join("\n")
    .split("\\t")
    .join("\t")
    .split(ESC)
    .join("\\");
}

/** 把一行右值解成实际值：双引号串走 JSON 解析，两种模板串剥定界符，标识符原样返回。 */
function valueOf(rhs) {
  const s = rhs.trim();
  if (s.startsWith(RAW_PREFIX)) return s.slice(RAW_PREFIX.length, -1);
  if (s.startsWith(BT)) return s.slice(1, -1);
  if (s.startsWith('"')) return JSON.parse(s);
  if (s.startsWith("'")) return unquoteSingle(s);
  return s;
}

const ID_RE = /^\s+id: "([^"]+)",$/u;
const FIELD_RE = /^\s+(file|spec|from|to|expect): (.+?),$/u;
// from/to 的值可以另起一行写（P1/P2 那种两行选择器的锚点就是这么写的），
// 第一版只认同行值 ⇒ 那两发被报成「缺字段」，是【检查器的错】不是脚本的错。
const FIELD_OPEN_RE = /^\s+(file|spec|from|to|expect):$/u;

const lines = readFileSync(
  ROOT + ".workbuddy/round378-pane-mutations.mjs",
  "utf8",
).split(/\r?\n/u);

const probes = [];
let cur = null;
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const id = ID_RE.exec(line);
  if (id) {
    if (cur) probes.push(cur);
    cur = { id: id[1] };
    continue;
  }
  if (!cur) continue;
  const f = FIELD_RE.exec(line);
  if (f) {
    cur[f[1]] = valueOf(f[2]);
    continue;
  }
  const open = FIELD_OPEN_RE.exec(line);
  if (open) {
    const next = (lines[i + 1] ?? "").trim().replace(/,$/u, "");
    cur[open[1]] = valueOf(next);
  }
}
if (cur) probes.push(cur);

let bad = 0;
console.log(`探针 ${probes.length} 发`);
for (const p of probes) {
  const missing = ["file", "spec", "from", "to", "expect"].filter(
    (k) => p[k] === undefined,
  );
  if (missing.length) {
    console.log(`${p.id}: 缺字段 ${missing.join(",")} ⇒ 脚本过期`);
    bad += 1;
    continue;
  }
  const src = readFileSync(ROOT + FILES[p.file], "utf8");
  const spec = readFileSync(ROOT + SPECS[p.spec], "utf8");
  const hits = src.split(p.from).length - 1;
  const noop = src.replace(p.from, p.to) === src;
  const titles = spec.split(p.expect).length - 1;
  const flags = [];
  if (hits !== 1) flags.push(`FROM 命中 ${hits}`);
  if (noop) flags.push("no-op");
  if (titles !== 1) flags.push(`标题命中 ${titles}`);
  if (flags.length) bad += 1;
  console.log(
    `${p.id}: from ${hits} to→noop ${noop ? "Y" : "N"} 标题 ${titles}` +
      (flags.length ? `  << ${flags.join(" / ")}` : ""),
  );
}
console.log(bad === 0 ? "全部锚点可用" : `不合格 ${bad} 发`);
process.exit(bad === 0 ? 0 : 1);
