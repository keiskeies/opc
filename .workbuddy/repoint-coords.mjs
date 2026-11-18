/**
 * 按【id】重指向 claims-registry.ts 里的 source.line —— 不是按旧值。
 *
 * 为什么不用「旧值 → 新值」的表（round293 第一版就是这么写的）：
 * 那种写法有【链式污染】—— 上一条的新值可能正好等于下一条的旧值（本轮实测：
 * r6 的新值 143 恰好是 r2 的旧值）。逐条 replace 时文件里会同时存在两处同一个数，
 * 于是要么多改一格、要么撞上「不唯一」而抛，而输出的样子完全正常。
 * 第一版靠「每个旧值恰好命中一次 + 回读全表比对」把这条路堵住了，能用，但它是
 * 【事后核对】。这里改成【结构上不可能】：先按 `id: "rN"` 找到那条登记，
 * 只替换它自己那一格 line —— 两条登记同值也互不干扰，不需要任何全局唯一性假设。
 *
 * 新值不是猜的：来自 claim-coords 红话自己交出的「现在在 [...]」。
 * 红话里同一行出现两个数时（同一句话在文档里被引用了两次），
 * 取【主张本体】那一格 —— 也就是较小的那个，另一个是正文里的引用。
 * 这一条由调用方在参数里自己判，脚本不猜：给它什么就写什么，但逐条核对命中一次。
 *
 * 跑法：npx tsx .workbuddy/repoint-coords.mjs r10=1671 r19=1880 …
 * 写完立即回读：每条新值必须落在它自己那条登记里，且全表其余格一字未动。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "test", "arch", "claims-registry.ts");

const pairs = process.argv.slice(2).map((a) => {
  const m = /^(r\d+)=(\d+)$/u.exec(a);
  if (!m) throw new Error(`参数要写成 rN=新行号，收到的是「${a}」`);
  return { id: m[1] ?? "", line: Number(m[2]) };
});
if (pairs.length === 0) throw new Error("用法：repoint-coords.mjs rN=新行号 …");
if (new Set(pairs.map((p) => p.id)).size !== pairs.length) {
  throw new Error("同一个 id 给了两次新值 —— 停");
}

const before = readFileSync(FILE, "utf8");
let out = before;
// 每条登记的形状：id: "rN", … line: NNN, …（line 在 source 块里，id 之后、下一条 id 之前）
for (const { id, line } of pairs) {
  const idAt = out.indexOf(`id: "${id}",`);
  if (idAt < 0) throw new Error(`登记表里没有 ${id} —— 停，不落盘`);
  const nextId = out.indexOf("\n      id: ", idAt + 1);
  const end = nextId < 0 ? out.length : nextId;
  const block = out.slice(idAt, end);
  const hits = [...block.matchAll(/^( +)line: (\d+),$/gmu)];
  if (hits.length !== 1) {
    throw new Error(
      `${id} 那条登记里找到 ${hits.length} 个 line 字段，不是 1 个 —— 停，不落盘`,
    );
  }
  const hit = hits[0];
  if (hit === undefined) throw new Error(`${id} 解析不出 line 字段`);
  const pad = hit[1] ?? "";
  const old = Number(hit[2]);
  const head = out.slice(0, idAt + (hit?.index ?? 0));
  const tail = out.slice(idAt + (hit?.index ?? 0) + hit[0].length);
  out = head + pad + "line: " + line + "," + tail;
  console.log(`${id}  ${old} → ${line}`);
}

// 回读【内存结果】：每条新值确实落在自己那条登记里，且【除这些格外】其余字节一字未动。
// ⚠ 这个文件是【纯 JS】：`.mjs` 走的是 node 的 JS 解析（tsx 只转译 .ts），
//    在这里写 `: string` 不是风格问题，是直接 SyntaxError。同 round283 那条教训。
const verify = (text) => {
  for (const { id, line } of pairs) {
    const idAt = text.indexOf(`id: "${id}",`);
    const nextId = text.indexOf("\n      id: ", idAt + 1);
    const block = text.slice(idAt, nextId < 0 ? text.length : nextId);
    const got = /line: (\d+),/u.exec(block)?.[1];
    if (got !== String(line)) {
      throw new Error(`${id} 回读得到 ${got}，期望 ${line} —— 写入没生效`);
    }
  }
};
const strip = (s) =>
  s.replace(/^( +)line: \d+,$/gmu, "$1line: @,");
if (strip(before) !== strip(out)) {
  throw new Error(
    "除了这些 line 字段，文件里还有别的字节变了 —— 替换越界了，别留这一版",
  );
}
verify(out);
writeFileSync(FILE, out, "utf8");
// 再对【盘上】核一遍：上面那次 verify 读的是内存串，落盘可能被人并行改过或写失败。
verify(readFileSync(FILE, "utf8"));
console.log(`回读逐条一致（内存 + 盘上），且其余字节未动（${pairs.length} 条）`);
