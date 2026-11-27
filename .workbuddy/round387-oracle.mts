/**
 * round387 探针 ③：判据能不能拿【真解析器】当 oracle（而不是手抄一份命令名单）。
 *
 * 跑法：npx tsx .workbuddy/round387-oracle.mts
 * 要回答的两问：
 *  ① test/web 能不能 import 引擎入口（hub-work.ts 的 import 图碰不碰 langgraph）；
 *  ② 把横幅里出现的 token 喂给真解析器，能不能机械区分「有这个子命令」与「没有」。
 */
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: Record<string, string>;
};
console.log("① scripts 里有 hub / hub:engine / hub:work：", [
  "hub",
  "hub:engine",
  "hub:work",
].map((k) => `${k}=${String(k in pkg.scripts)}`));

const { runEngineCli } = await import("../packages/hub/src/engine/hub-work.js");

async function ask(argv: string[]): Promise<string> {
  let err = "";
  let out = "";
  const r = await runEngineCli(argv, {
    write: (t) => {
      out += t;
    },
    error: (t) => {
      err += t;
    },
  });
  // 「没有 [x] 这个子命令」= 这个 verb 压根不存在；「数据库文件不存在」= verb 存在、往下走了
  const kind = err.includes("没有 [")
    ? "不存在该子命令"
    : err.includes("数据库文件不存在")
      ? "verb 存在（走到库那一层才停）"
      : err.includes("缺参数")
        ? "verb 存在（缺必填）"
        : `别的：${(err || out).slice(0, 40)}`;
  return `${kind} (exit ${String(r.code)})`;
}

console.log("② 喂真解析器（一律指向不存在的库 ⇒ 不建库、不起子进程、不花钱）：");
for (const tok of ["work", "decide", "push", "run"]) {
  const s = await ask([tok, "--db", ".workbuddy/scratch/nope.db"]);
  console.log(`    hub:engine ${tok} ⇒ ${s}`);
}
const help = await runEngineCli(["--help"], { write: () => {}, error: () => {} });
console.log("    hub:engine --help ⇒ exit", help.code);
const workHelp = await runEngineCli(["work", "--help"], {
  write: () => {},
  error: () => {},
});
console.log("    hub:engine work --help ⇒ exit", workHelp.code);
