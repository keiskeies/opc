// 0086 反向尺子：契约请求 schema 的字段名，在两个入口页里【零字面出现】⇒ UI 必然发不出。
// 这是必要条件（不是充分条件）：零出现一定没发；出现≠真发（那要回到逐调用点比对）。
// 与 0085 作废的那版区别：这里只报「零出现」，不做「出现但没发」的启发式猜测 —— 后者是噪声源。
import { readFileSync, readdirSync } from "node:fs";

const CONTRACTS = "D:/item/opc/packages/contracts/src";
const UI = ["packages/web/public/group.js", "packages/web/public/app.js"].map(
  (f) => readFileSync(`D:/item/opc/${f}`, "utf8"),
);
const uiHay = UI.join("\n");

/** 括号配平取一个 z.object({...}) 的体，返回顶层字段名。 */
function objectBody(text, open) {
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
    else if (c === "{" || c === "(" || c === "[") depth += 1;
    else if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return "";
}

function fieldNames(body) {
  const out = [];
  let q = null;
  let depth = 0;
  let seg = "";
  const push = () => {
    const t = seg.trim();
    seg = "";
    if (depth > 0 || !t) return;
    const m = /^([A-Za-z_][\w]*)\s*:/u.exec(t);
    if (m) out.push(m[1]);
  };
  for (const c of body) {
    if (q) {
      seg += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      seg += c;
      continue;
    }
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      seg += c;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      seg += c;
      continue;
    }
    if (c === "\n" && depth === 0) {
      push();
      continue;
    }
    seg += c;
  }
  push();
  return out;
}

const rows = [];
for (const f of readdirSync(CONTRACTS).filter((n) => n.endsWith(".ts"))) {
  const text = readFileSync(`${CONTRACTS}/${f}`, "utf8");
  const re = /export const (\w*(?:Request|Input|Body|Patch|Payload)\w*Schema)\s*=\s*z\s*\n?\s*\.object\(\{/gu;
  let m = re.exec(text);
  while (m) {
    const open = text.indexOf("{", m.index + m[0].length - 1);
    const body = objectBody(text, open);
    for (const k of fieldNames(body)) {
      const hits = uiHay.split(k).length - 1;
      if (hits === 0) rows.push(`${f} :: ${m[1]} :: ${k}`);
    }
    m = re.exec(text);
  }
}
console.log(`请求 schema 字段中【UI 侧零字面出现】的候选：${rows.length} 条`);
for (const r of rows) console.log(`  ${r}`);
