/**
 * 探针（只读，不改盘）：量 ui-caller-roster 的 method 维失明面。
 *
 * 名单的命中口径 hitsUi 只比路径，HTTP 方法整个不看。于是「同一条路径上任意一条方法
 * 被渲染侧调过」会把这条路径上【零调用方】的其他方法盖住 —— POST /templates 在 0075
 * 之前就是这么隐身的。这里量的是「路径维判为已接线、但方法维在渲染侧找不到证据」的条目。
 *
 * ⚠ 探针自己的尺子必须至少和名单一样宽，否则报出来的数混进了「探针自己瞎」那部分。
 * 三次改版各修掉一类自己的瞎点（读数 31 → 10 → 2，前两版的数都是**探针的**病不是名单的）：
 *  ① 反引号插值：名单把 `${encodeURIComponent(id)}` 归一成 `{}`，这里先把每个 `${…}`
 *     压成一个占位字符再匹配。**必须非贪婪** —— `\$\{[^`]*\}` 会从第一个 `${` 吃到该
 *     模板字面量最后一个 `}`，于是 `/documents/${id}/versions/${seq}/restore` 只剩**一个**
 *     占位、归一路径要两段 ⇒ 明明接了线的端点被报成没证据。
 *  ② 方法与路径的相对位置三种都要认：`request(path, {method:"POST"})`（方法在后）、
 *     `api("POST", path)`（在前）、`backlogMutation(path, "POST", body)`（**转发函数的
 *     位置参** —— 源码里压根不出现 `method:` 这个标签，前两种尺子量不到，backlog 五条
 *     就是这么被误报的）。
 *  ③ 路径段可以来自拼接：`"/charter/" + encodeURIComponent(role)` 里 `{}` 那一段在源码里
 *     是**空**的，允许它为空才不冤枉岗位书那一发真 POST（这正是名单自己认的拼接形状）。
 *
 * 用法：node --experimental-strip-types .workbuddy/round390-method-blind-probe.mts
 * 残差仍要逐条开源码手校 —— 探针只能缩小怀疑面，不能替手校。
 */
import { readFileSync } from "node:fs";
import {
  extractPathPatterns,
  hitsUi,
  normalizePath,
  stripComments,
} from "../test/arch/ui-caller-roster.ts";

const PH = "\u0001";

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
const flat = raw.replace(/\$\{[^`]*?\}/gu, PH);

const esc = (s: string): string =>
  s.replace(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/** `{}` 段允许：插值占位 / 同引号内的字面段 / 空（拼接给出，后面紧跟 `"` 与 `+`）。 */
function pathRegex(key: string): string {
  const seg = PH + "|" + '[^/"\'`' + PH + "]+" + '|(?=" *\\+)';
  return key
    .split("/")
    .map((s: string): string => (s === "{}" ? "(?:" + seg + ")" : esc(s)))
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
  const quoted = `(?:["'\`])${p}(?:["'\`]|\\$${PH})`;
  const after = new RegExp(`${quoted}[^;]{0,160}method:\\s*"${method}"`, "u");
  const before = new RegExp(`\\(\\s*"${method}"\\s*,\\s*(?:["'\`])${p}`, "u");
  const positional = new RegExp(`${quoted}\\s*,\\s*"${method}"`, "u");
  if (!after.test(flat) && !before.test(flat) && !positional.test(flat)) {
    methodCold.push(ep);
  }
}
console.log("契约条目（解析得出）:", eps.length);
console.log(
  "路径维判为已接线、但方法维在渲染侧找不到证据的条目:",
  methodCold.length,
);
for (const e of methodCold) console.log("  " + e);
