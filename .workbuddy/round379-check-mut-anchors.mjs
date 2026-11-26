// 变异机预检 A 的离线版：把 .workbuddy/round379-compact-mutations.mjs 里每条 from 锚点
// 在 group.css 上数一遍命中，另把每条 expect 标题在守卫测试里数一遍命中。
// 目的：不启动 vitest 就能发现锚点过期（尤其注释插在两行之间导致的多行锚点）。
import { readFileSync } from "node:fs";

const CSS = readFileSync("packages/web/public/group.css", "utf8");
const MUT = readFileSync(".workbuddy/round379-compact-mutations.mjs", "utf8");
const GUARD = readFileSync("test/web/compact-scale.test.ts", "utf8");

const ids = [...MUT.matchAll(/^\s+id: "([^"]+)"/gmu)].map((m) => m[1]);
const blocks = [
  ...MUT.matchAll(
    /id: "([^"]+)",\s*\n\s*from: ("(?:[^"\\]|\\.)*"),\s*\n\s*to: ("(?:[^"\\]|\\.)*"),\s*\n\s*expect: ("(?:[^"\\]|\\.)*"),/gmu,
  ),
];
console.log(`id ${ids.length} / 锚点块 ${blocks.length}`);

let bad = 0;
const byTitle = new Map();
for (const block of blocks) {
  const id = block[1];
  const from = JSON.parse(block[2]);
  const to = JSON.parse(block[3]);
  const expect = JSON.parse(block[4]);
  const hits = CSS.split(from).length - 1;
  const noop = CSS.replace(from, to) === CSS;
  const titleHits = GUARD.split(expect).length - 1;
  const prev = byTitle.get(expect) ?? [];
  prev.push(id);
  byTitle.set(expect, prev);
  const flags = [];
  if (hits !== 1) flags.push(`FROM 命中 ${hits}`);
  if (noop) flags.push("no-op");
  if (flags.length) bad += 1;
  console.log(
    `${id}: css_hits ${hits} noop ${noop ? "Y" : "N"} title_hits ${titleHits} ${flags.length ? "<< " + flags.join(" / ") : ""}`,
  );
}
console.log("--- 标题去重（每发只应命中一条用例）---");
for (const [title, list] of byTitle)
  console.log(`"${title}" <- ${list.length} 发：${list.join(",")}`);
console.log(`不合格 ${bad} 发`);
