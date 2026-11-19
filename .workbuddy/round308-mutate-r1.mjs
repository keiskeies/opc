/**
 * r1（round308 改版）的【真生产字节】自回滚变异矩阵。
 *
 * 为什么合成夹具那 6 发不够：它们只证明判据【在假输入上】会红，不证明它对
 * 【真 src 的取材】还接得上 —— 名单里的住址写错一个字符（http/budget.ts 改名、
 * 大小写差一格），判据会对真仓库恒绿而没人发现。这一台把变异打在真文件上，
 * 每一发跑完立即回滚并逐字节核对。
 *
 * 纪律（台账里记过两次的坑，别再犯）：
 *  · 纯 JS，【不许】出现 TS 类型语法（.mjs 走纯 JS 解析，`as string` 会当场炸）；
 *  · 单独跑，不与任何测试并发（它改的是真字节）；
 *  · 命中判据只是必要条件之一：每发还声明【该由哪一格抓】，红因而非预期即失败。
 *
 * 跑法：npx tsx .workbuddy/round308-mutate-r1.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REGISTRY, realFiles } from "../test/arch/claims-registry.ts";

const ROOT = join(import.meta.dirname, "..");
const BUDGET = join(ROOT, "packages/hub/src/http/budget.ts");
const TRACKER = join(ROOT, "packages/hub/src/budget/tracker.ts");
const check = REGISTRY.find((r) => r.id === "r1").check;

/** 每发：动哪个文件、从哪段子串换成哪段、该红在哪一句。 */
const MATRIX = [
  { name: "M0 控制组：一字不改", file: BUDGET, from: "VALUES (?, ?, ?, ?, ?, 0, ?) ", to: "VALUES (?, ?, ?, ?, ?, 0, ?) ", want: "" },
  { name: "M1 名单内那处改成字面量 0", file: BUDGET, from: "VALUES (?, ?, ?, ?, ?, 0, ?) ", to: "VALUES (?, ?, ?, ?, ?, 0, 0) ", want: "写成 0" },
  { name: "M2 名单内那处的 upsert 不再改停法", file: BUDGET, from: "DO UPDATE SET limit_cents = excluded.limit_cents, hard_stop = excluded.hard_stop", to: "DO UPDATE SET limit_cents = excluded.limit_cents", want: "名单失效" },
  { name: "M3 名单外多一处绑参写 hard_stop", file: TRACKER, from: 'export const IDEMPOTENT_INSERT_SQL =', to: 'const 探针 = "INSERT INTO budgets (id, scope_type, scope_id, period, limit_cents, consumed_cents, hard_stop) VALUES (?, ?, ?, ?, ?, 0, ?)";\nexport const IDEMPOTENT_INSERT_SQL =', want: "绑定参数" },
  { name: "M4 名单外一处 upsert 改写 hard_stop", file: TRACKER, from: "VALUES (?, ?, ?, ?, ?, 0, 1) ON CONFLICT", to: "VALUES (?, ?, ?, ?, ?, 0, 1) ON CONFLICT(x) DO UPDATE SET hard_stop = excluded.hard_stop --", want: "没登记" },
];

const orig = new Map();
const read = (f) => readFileSync(f, "utf8");
let hit = 0;
const lines = [];
try {
  for (const m of MATRIX) {
    if (!orig.has(m.file)) orig.set(m.file, read(m.file));
    const base = orig.get(m.file);
    if (!base.includes(m.from)) throw new Error(m.name + " 的锚点子串在 " + m.file + " 里找不到 —— 矩阵自己过期了");
    writeFileSync(m.file, base.replace(m.from, m.to));
    let got = "";
    try {
      got = check(realFiles);
    } catch (e) {
      got = "THREW " + String(e);
    }
    writeFileSync(m.file, base);
    const okBytes = read(m.file) === base;
    const okRed = m.want === "" ? got === "" : got.includes(m.want);
    if (okRed && okBytes) hit++;
    lines.push(
      (okRed && okBytes ? "✔ " : "✘ ") + m.name +
        " ⇒ 红因 [" + (got === "" ? "（绿）" : got.slice(0, 70)) + "]" +
        " 期望含 [" + (m.want === "" ? "绿" : m.want) + "]" +
        " 回滚逐字节一致=" + okBytes,
    );
  }
} finally {
  for (const [f, bytes] of orig) writeFileSync(f, bytes);
}
for (const l of lines) console.log(l);
const clean = [...orig.keys()].every((f) => read(f) === orig.get(f));
console.log("\n命中 " + hit + "/" + MATRIX.length + " · 全部文件已回滚=" + clean);
process.exit(hit === MATRIX.length && clean ? 0 : 1);
