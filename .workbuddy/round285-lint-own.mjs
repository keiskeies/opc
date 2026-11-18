// round285 · 我这几份新文件到底给 lint 基线加了几条、加在哪一类。
// 跑法：npx tsx .workbuddy/round285-lint-own.mjs
import { runBiomeJson } from "../test/arch/lint-baseline.ts";
import { spawnSync } from "node:child_process";

const run = runBiomeJson(process.cwd());

// ⚠ 这里原本是一份【手抄的文件名单】（round285 那轮新建的几份）。round288 撞穿它：
// 那一轮我改的是 `test/arch/doc-refs.test.ts`，而它不在名单里 ⇒ 「我:」这一栏
// 对真正动手的那份文件【一条都不报】，打出来的「我只有 1 条」是上一轮的我。
// ⇒ 手抄名单和它要描述的「我这轮碰了什么」之间没有约束，隔一轮就变成假读数。
// 改成从 git 现算（已改 + 未跟踪），名单不再需要人维护。
const git = (args) => {
  const r = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  if (r.status !== 0) {
    throw new Error("git " + args.join(" ") + " 失败，名单算不出来就是瞎报");
  }
  return r.stdout
    .split(/\r?\n/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
};
// ⚠ 口径要说准：这里是【未入库】，不是【本轮改的】。工作区今天有几十份未提交文件，
//   它们全都会进这个集合。这不是「本轮的我」，是「这一片没提交的工作区」——
//   名字就叫「未入库」，不冒充成更窄的东西（round286/287 同一条规矩：说不出多大就不起个
//   听起来更小的名字）。
const mine = new Set(
  [
    ...git(["diff", "--name-only", "HEAD"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ].filter((p) => /\.(ts|tsx)$/.test(p)),
);
console.log("未入库的 .ts/.tsx =", mine.size, "份（口径：git 已改 + 未跟踪，不是本轮改动）");
const per = new Map();
for (const d of run.diagnostics) {
  if (d.severity !== "error") continue;
  const p = String(d.location.path).split("\\").join("/");
  if (!mine.has(p)) continue;
  const k = p + " :: " + d.category;
  per.set(k, (per.get(k) ?? 0) + 1);
}
console.log("全仓 error =", run.summary.errors, " filesChecked =", run.filesChecked);
const cats = new Map();
for (const d of run.diagnostics) {
  if (d.severity !== "error") continue;
  const p = String(d.location.path).split("\\").join("/");
  const name = p.slice(p.lastIndexOf("/") + 1);
  if (name.includes("____opc_boundary_probe")) continue;
  cats.set(d.category, (cats.get(d.category) ?? 0) + 1);
}
console.log("按类目（已排运行期探针）：");
for (const [k, v] of [...cats.entries()].sort()) console.log(" ", v, k);
console.log("未入库文件里的（format 一发 = 一整个文件，不是一行）：");
for (const [k, v] of [...per.entries()].sort()) console.log("  未入库:", v, k);
if (per.size === 0) console.log("  未入库的 .ts 一条 error 都没有");
