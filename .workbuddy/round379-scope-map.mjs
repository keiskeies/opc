// 列出 group.css 里每条 .page / .card / .conversation-item 规则所处的 media 语境，
// 供 compact-scale 守卫确定「哪条规则在哪一档生效」。只打印，不改文件。
import { readFileSync } from "node:fs";

const text = readFileSync("packages/web/public/group.css", "utf8");
const lines = text.split("\n");

// 逐行跟踪花括号深度：深度 0 的 @media 头记为「当前档」，进入其块内则记下来。
const mediaStack = [];
let depth = 0;
const WANT = /(^|[,\s])(\.page|\.page-header|\.card|\.conversation-item|\.list-heading)(\s*[,{+:]| \+ )/u;

const hits = [];
for (let i = 0; i < lines.length; i += 1) {
  const raw = lines[i];
  const line = raw.replace(/\/\*[\s\S]*?\*\//gu, "");
  const media = /@media[^{]*/u.exec(line);
  if (media) mediaStack.push({ cond: media[0].trim().replace(/\s*\{$/u, ""), depth });
  for (const ch of line) {
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      while (mediaStack.length && mediaStack[mediaStack.length - 1].depth >= depth) mediaStack.pop();
    }
  }
  if (WANT.test(line) && !raw.trim().startsWith("/*")) {
    hits.push({
      ln: i + 1,
      scope: mediaStack.length ? mediaStack.map((m) => m.cond).join(" && ") : "(base)",
      text: raw.trim().slice(0, 150),
    });
  }
}

for (const h of hits) console.log(String(h.ln).padStart(5) + "  " + h.scope.padEnd(42) + "  " + h.text);
