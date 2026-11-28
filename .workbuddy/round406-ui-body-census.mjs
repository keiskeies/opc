// 0086 找缺口：逐调用点的「UI 发了哪些 body 键」清单（不是全仓字段名匹配 —— 那条轴在 0085 已作废）。
// 只做一件事：把渲染侧每个带 body 的请求点摊成
//   方法 | 路径模板 | body 顶层键（含 children[] 内层键）
// 交给人事后与契约 schema 对表。括号配平取对象字面量，别用非贪婪 `\}`（0085 的教训：恒 0 是没量到）。
import { readFileSync } from "node:fs";

const files = ["packages/web/public/group.js", "packages/web/public/app.js"];

/** 从 open 位置起取配平的 {...} 文本。 */
function braceAt(text, open) {
  let depth = 0;
  let q = null;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === "\\") i += 1;
      else if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** 只取顶层键名（含 `...` 展开标记），并单独收 children/map 里的内层键。 */
function topKeys(objText) {
  const keys = [];
  let depth = 0;
  let q = null;
  let line = "";
  const push = (seg, d) => {
    if (d !== 1) return;
    const spread = /^\.\.\.\s*(?!\{)/u.test(seg.trim());
    const m = /^([A-Za-z_$][\w$]*)\s*:/u.exec(seg.trim());
    const bare = /^[A-Za-z_$][\w$]*$/u.test(seg.trim());
    if (spread) keys.push("...spread");
    else if (m) keys.push(m[1]);
    else if (bare) keys.push(`${seg.trim()}(shorthand)`);
  };
  for (const c of objText) {
    if (q) {
      line += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      line += c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") {
      depth += 1;
      if (depth === 1) line = "";
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      if (depth === 1) push(line, 1);
      depth -= 1;
      line = "";
      continue;
    }
    if (c === "," && depth === 1) {
      push(line, 1);
      line = "";
      continue;
    }
    line += c;
  }
  return keys;
}

/** 嵌套一层的键（children: [{ a, b }] 里的 a/b）。 */
function childKeys(objText) {
  const out = [];
  const re = /(children|items|entries|lines|steps)\s*:\s*\[/gu;
  let m = re.exec(objText);
  while (m) {
    const open = objText.indexOf("{", m.index);
    if (open < 0) break;
    const body = braceAt(objText, open);
    if (body) {
      const ks = [];
      for (const seg of body.replace(/^\{|\}$/gu, "").split(",")) {
        const k = /^([A-Za-z_$][\w$]*)\s*:/u.exec(seg.trim());
        const spread = /^\.\.\./u.test(seg.trim());
        if (spread) ks.push("...");
        else if (k) ks.push(k[1]);
      }
      out.push(`${m[1]}[]{${ks.join(",")}}`);
    }
    m = re.exec(objText);
  }
  return out;
}

let total = 0;
for (const f of files) {
  const text = readFileSync(`D:/item/opc/${f}`, "utf8");
  const lines = text.split("\n");
  console.log(`\n######## ${f}`);
  for (let i = 0; i < lines.length; i += 1) {
    // 只看「这一发带 body」的请求点：body: 出现在同一段调用里。
    if (!/\bbody\s*:/u.test(lines[i])) continue;
    const ctx = lines.slice(i, i + 40).join("\n");
    const open = ctx.indexOf("{", ctx.indexOf("body") + 4);
    if (open < 0) continue;
    const obj = braceAt(ctx, open);
    if (!obj) continue;
    const pathM = /[`"']([^`"']*\$\{[^`'"]*[`'"][^`'"]*)[`'"]/u.exec(
      lines.slice(Math.max(0, i - 12), i + 1).join("\n"),
    ) || /[`"'](\/[A-Za-z0-9_/-]*)[`"']/u.exec(
      lines.slice(Math.max(0, i - 12), i + 1).join("\n"),
    );
    const methM = /method\s*[:=]\s*[`"']?([A-Za-z]+)/u.exec(ctx);
    const ks = [...new Set(topKeys(obj))];
    if (ks.length === 0 && childKeys(obj).length === 0) continue;
    total += 1;
    console.log(
      `:${i + 1} | ${methM ? methM[1].toUpperCase() : "?"} ${pathM ? pathM[1] : "?"}\n    keys: ${ks.join(", ")}${childKeys(obj).length ? `\n    nested: ${childKeys(obj).join(" ")}` : ""}`,
    );
  }
}
console.log(`\n带 body 的请求点合计 ${total} 个`);
