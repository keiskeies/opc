/**
 * round387 探针：看板上那句「或手工 hub work」教的那条命令，在终端上敲得到吗？
 *
 * 跑法：npx tsx .workbuddy/round387-hub-work-route.mts
 *
 * 只读：不建库、不写库、不起子进程干活（一律 --help 或缺参，走到参数那一层就停）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseWorkArgs } from "../packages/hub/src/engine/work.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

function run(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  return {
    code: r.status,
    out: [String(r.stdout ?? ""), String(r.stderr ?? "")]
      .join("")
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.includes("ExperimentalWarning"))
      .slice(0, 3)
      .join(" ⏎ "),
  };
}

const tsx = "node_modules/tsx/dist/cli.mjs";
const cli = "packages/hub/src/cli.ts";
const engine = "packages/hub/src/engine/hub-work.ts";

console.log("① 屏幕上教的那一条：hub work（cli.ts 那一头）");
console.log("   ", JSON.stringify(run([tsx, cli, "work"])));

console.log("② 真名那一条：pnpm hub:engine work（缺参 ⇒ 它会说出缺哪些）");
console.log("   ", JSON.stringify(run([tsx, engine, "work"])));

console.log("③ 同一条命令 --help ⇒ 退出码");
console.log("   ", JSON.stringify(run([tsx, engine, "work", "--help"])));

console.log("④ 必填名单由解析器自己说（屏幕上要照抄的那几个参数）");
const p = parseWorkArgs([]);
console.log("   ", p.ok ? "解析器居然接受了空参数" : p.error);

console.log("⑤ 根 package.json 里真有的入口名");
const pkg = JSON.parse(readFileSync(ROOT + "package.json", "utf8")) as {
  scripts: Record<string, string>;
};
for (const k of ["hub", "hub:engine", "hub:serve", "work", "hub:work"]) {
  console.log(`    scripts[${JSON.stringify(k)}] = ${String(pkg.scripts[k])}`);
}

console.log("⑥ 参数照抄之后走到的是【真下一步】而不是又一次参数错");
console.log(
  "   ",
  JSON.stringify(
    run([
      tsx,
      engine,
      "work",
      "--db",
      ".workbuddy/scratch/does-not-exist.db",
      "--task",
      "t1",
      "--max-budget-usd",
      "1",
      "--task-limit-cents",
      "100",
    ]),
  ),
);

console.log("⑦ 屏幕上【没写】的那三个参数是不是真可选（少写一个会怎样）");
for (const extra of [
  ["--max-turns", "3"],
  ["--evidence-root", ".workbuddy/scratch"],
  ["--bin", "claude"],
]) {
  const q = parseWorkArgs([
    "--db",
    "x.db",
    "--task",
    "t1",
    "--max-budget-usd",
    "1",
    "--task-limit-cents",
    "100",
    ...extra,
  ]);
  console.log(`    ${extra.join(" ")} ⇒ ${q.ok ? "接受（可选）" : "拒：" + q.error}`);
}
