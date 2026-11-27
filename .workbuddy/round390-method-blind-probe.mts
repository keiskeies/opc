/**
 * 探针（只读，不改盘）：量 ui-caller-roster 的 method 维失明面。
 *
 * 名单的命中口径 hitsUi 只比路径，HTTP 方法整个不看。于是「同一条路径上任意一条方法
 * 被渲染侧调过」会把这条路径上【零调用方】的其他方法盖住 —— POST /templates 在 0075
 * 之前就是这么隐身的。这里量的是「路径维判为已接线、但方法维在渲染侧找不到证据」的条目。
 *
 * ⚠ 探针自己的尺子必须至少和名单一样宽，否则报出来的数混进了「探针自己瞎」那部分：
 * 名单把反引号模板当字面量（extractPathPatterns 认反引号），这里就先把 `${…}` 压成
 * 通配段再匹配；method 在 path 前（api("PATCH", path)）与在后（request(path, {method})）
 * 两种写法都认。
 */
import { readFileSync } from "node:fs";
import {
  extractPathPatterns,
  hitsUi,
  normalizePath,
  stripComments,
} from "../test/arch/ui-caller-roster.ts";

const src = readFileSync("packages/contracts/src/api.ts", "utf8");
const start = src.indexOf("export const IMPLEMENTED_ENDPOINTS");
const body = src.slice(start, src.indexOf("];", start));
const eps = [...body.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) [^"]+)"/gu)].map(
  (m) => m[1] as string,
);
const files = ["packages/web/public/group.js", "packages/web/public/app.js"];
const raw = files
  .map((f: string): string => stripComments(readFileSync(f, "utf8")))
  .join("\n");
const pats = extractPathPatterns(raw);
/** 插值段压成一个字符，匹配时按「一段」对待（与名单把 ${…} 换成 {} 同一口径）。 */
const flat = raw.replace(/\$\{[^`]*\}/gu, "\u0001");

const esc = (s: string): string =>
  s.replace(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/** 归一路径 → 匹配 UI 里那条路径的片段：`/` 照旧，名单的 `{}` 段允许是插值占位或字面段。 */
function pathRegex(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      seg === "{}" ? "(?:\u0001|[^/\"'`\u0001]+)" : esc(seg),
    )
    .join("/");
}

const methodCold: string[] = [];
for (const ep of eps) {
  const method = ep.split(/\s+/u)[0] as string;
  const path = (ep.split(/\s+/u)[1] as string) ?? "";
  if (path === "" || method === "GET") continue;
  const key = normalizePath(path);
  if (!hitsUi(key, pats)) continue; // 路径维已经抓到，不是这一维的功劳
  const p = pathRegex(key);
  const quoted = `(?:["'\`])${p}(?:["'\`]|\\$\u0001)`;
  const after = new RegExp(
    `${quoted}[^;]{0,160}method:\\s*"${method}"`,
    "u",
  );
  const before = new RegExp(
    `\\(\\s*"${method}"\\s*,\\s*(?:["'\`])${p}`,
    "u",
  );
  if (!after.test(flat) && !before.test(flat)) methodCold.push(ep);
}
console.log("契约条目（解析得出）:", eps.length);
console.log(
  "路径维判为已接线、但方法维在渲染侧找不到证据的条目:",
  methodCold.length,
);
for (const e of methodCold) console.log("  " + e);
