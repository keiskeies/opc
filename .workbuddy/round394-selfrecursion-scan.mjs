// 扫描 group.js：哪些函数的函数体里调用了自己（自递归），以及是否用 toolbar.append
// 而不是 replaceChildren 往共享容器里塞控件。自递归 + append = 每敲一个字符累加一套控件。
import { readFileSync } from "node:fs";

const src = readFileSync("packages/web/public/group.js", "utf8");
const decl = /^(?:async )?function (\w+)\(/gmu;
const rows = [];
let match;
while ((match = decl.exec(src)) !== null) {
  const name = match[1];
  const open = src.indexOf("{", match.index + match[0].length - 1);
  let depth = 0;
  let end = src.length;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const body = src.slice(open, end);
  const self = [...body.matchAll(new RegExp(`\\b${name}\\(`, "gu"))].length;
  const appends = [...body.matchAll(/\btoolbar\.append\(/gu)].length;
  const clears = [...body.matchAll(/\.replaceChildren\(/gu)].length;
  if (self > 0 || appends > 0) {
    rows.push({
      line: src.slice(0, match.index).split("\n").length,
      name,
      selfCalls: self,
      toolbarAppend: appends,
      replaceChildren: clears,
    });
  }
}
console.log(JSON.stringify(rows, null, 2));
