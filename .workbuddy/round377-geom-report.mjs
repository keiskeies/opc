// 比对两份几何快照（round377-geom-diff.mjs 产出），只回答两件事：
//  1) 动的这一枚，它的 class 是不是【这次真的改过 gap 的那条规则】选中的？
//  2) 动的幅度是不是【就是那一档差值】（<=4px 且方向与折档一致）？
//
// 名单不手写 —— 手写名单会把「我以为改了」当成「真的改了」。这里在运行时从 CSS 里
// 现捞：把 group.css / admin.css 里 gap 声明用到 var(--space-*) 的规则全扫出来，
// 得到「这次动过的选择器 + 它的新旧档位」。名单外的位移一律当回归。
//
// 用法：node round377-geom-report.mjs before.json after.json
import { readFileSync } from "node:fs";

const [beforeFile, afterFile] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error("用法：node 本脚本 <before.json> <after.json>");
const before = JSON.parse(readFileSync(beforeFile, "utf8"));
const after = JSON.parse(readFileSync(afterFile, "utf8"));

const TOKEN = { "var(--space-1)": 4, "var(--space-2)": 8, "var(--space-3)": 12, "var(--space-4)": 16, "var(--space-5)": 20, "var(--space-6)": 24, "var(--space-7)": 32 };

/** 从 CSS 现捞：选择器 → 该规则里 gap 用到的档位（token 与仍留着裸数字的都收）。 */
function migratedSelectors(...files) {
  const map = new Map();
  for (const f of files) {
    const css = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
      const decls = m[2] || "";
      const gapDecl = /(?:^|[;\s])(?:row-|column-)?gap:\s*([^;}]+)/u.exec(decls);
      if (!gapDecl) continue;
      const toks = [...gapDecl[1].matchAll(/var\(--space-\d\)|\d+px/gu)].map((t) => t[0]);
      for (const raw of (m[1] || "").split(",")) {
        const sel = raw.trim().replace(/\s+/gu, " ");
        if (!sel || sel.startsWith("@")) continue;
        // 只取选择器最后一段的类名 —— 盒子的 gap 由它自己那条规则决定。
        const cls = [...sel.matchAll(/\.([A-Za-z][\w-]*)/gu)].map((c) => c[1]);
        const key = cls.length > 0 ? cls[cls.length - 1] : sel;
        if (!map.has(key)) map.set(key, new Set());
        for (const t of toks) map.get(key).add(t);
      }
    }
  }
  return map;
}

const MIGRATED = migratedSelectors(
  "packages/web/public/group.css",
  "packages/web/public/admin.css",
);

/** 这个 class 是不是被这次改动选中的规则覆盖到（含祖先容器改变导致的位移）。 */
function touched(key) {
  const cls = key.replace(/^[^.]+\./u, "").replace(/\[\d+\]$/u, "").split(".");
  return cls.filter((c) => MIGRATED.has(c));
}

const rows = [];
for (const scene of Object.keys(after)) {
  const b = before[scene] || {};
  const a = after[scene];
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    const x = b[key];
    const y = a[key];
    if (!x || !y) {
      rows.push({ scene, key, note: `节点${x ? "消失" : "新增"}`, big: 999 });
      continue;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) {
      rows.push({
        scene,
        key,
        note: `${x[0]}x${x[1]} top=${x[2]} gap=${x[3]}  →  ${y[0]}x${y[1]} top=${y[2]} gap=${y[3]}`,
        big: Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2])),
        // 它【自己那条 gap】变了没有。名单外 + gap 没变 = 上游容器折档把它挤动了（连带）；
        // 名单外 + gap 变了 = 有一张没进名单的规则动了间距，这才算越界。
        ownGapMoved: x[3] !== y[3],
      });
    }
  }
}

const hit = rows.filter((r) => touched(r.key).length > 0);
const miss = rows.filter((r) => touched(r.key).length === 0);
const added = rows.filter((r) => r.big === 999);
const missOwn = miss.filter((r) => r.ownGapMoved);
const missFlow = miss.filter((r) => !r.ownGapMoved && r.big !== 999);
const hitFlow = hit.filter((r) => !r.ownGapMoved);

console.log(`场景 ${Object.keys(after).length} 个 · 采样内差异 ${rows.length} 条`);
console.log(`CSS 里现捞到 ${MIGRATED.size} 个带 gap 的选择器（名单运行时从 CSS 捞，不手写）`);

console.log(`\n── ① 命中名单、且自己这条 gap 真的变了：${hit.length - hitFlow.length} 条 ──`);
const hitOwn = hit.filter((r) => r.ownGapMoved);
const maxOwn = hitOwn.reduce((a, r) => Math.max(a, r.big), 0);
for (const r of hitOwn.slice(0, 40)) {
  console.log(`  Δ${r.big.toFixed(2)}px ${r.scene} · ${r.key}（命中类 ${touched(r.key).join(",")}）\n    ${r.note}`);
}
if (hitOwn.length > 40) console.log(`  …另 ${hitOwn.length - 40} 条同类`);
console.log(`  这一组最大位移 = ${maxOwn.toFixed(2)}px（折档单档最多差 4px，尺寸/位移超它是下游连带）`);

console.log(`\n── ② 命中名单、但自己 gap 没变（被上游挤动）：${hitFlow.length} 条 ──`);
console.log(`  最大位移 = ${hitFlow.reduce((a, r) => Math.max(a, r.big), 0).toFixed(2)}px · 属预期连带（rail 里 6 枚 nav-item 各挡 2px 就是这样叠到 12px 的）`);

console.log(`\n── ③ 名单外、自己 gap 也没变（纯连带）：${missFlow.length} 条 ──`);
console.log(`  最大位移 = ${missFlow.reduce((a, r) => Math.max(a, r.big), 0).toFixed(2)}px · 这些盒子没声明 gap（gap=normal），只是祖先折档后被挤了`);

console.log(`\n── ④ 名单外、自己 gap 却变了：${missOwn.length} 条 ⇒ 只有这一组算越界 ──`);
for (const r of missOwn.slice(0, 40)) {
  console.log(`  Δ${r.big.toFixed(2)}px ${r.scene} · ${r.key}\n    ${r.note}`);
}
if (missOwn.length > 40) console.log(`  …另 ${missOwn.length - 40} 条`);

console.log(`\n── ⑤ 节点新增/消失：${added.length} 条 ──`);
for (const r of added.slice(0, 20)) console.log(`  ${r.scene} · ${r.key} · ${r.note}`);
if (added.length > 20) console.log(`  …另 ${added.length - 20} 条`);

const verdict = missOwn.length === 0 && added.length === 0;
console.log(`\n判定：${verdict ? "越界 0 条 ⇒ 动的间距全部落在本次折档的规则里，其余全是连带位移" : "有越界，需逐条归因后再放行"}`);
if (rows.length === 0) console.log("⚠ 一条差异都没有 ⇒ 这次改动没落到渲染上，先怀疑判据（缓存/没重启静态服务）。");
