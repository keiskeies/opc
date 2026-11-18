/**
 * round300 的「坏读数」复算探针 —— 同一份合成语料，喂给【两棵树】各一次。
 *
 * 为什么不是只跑当前版本：本轮登记的核心主张是「落判据【之前】那台棘轮会把
 * 291 条仓外错读成【空字符串 = 合格】」。这句话如果只写在注释里，它就和
 * §8 那一节骂过的「写了口径 ≠ 给了方法」是同一种东西。所以这里现取
 * 【落判据之前】那一版的字节（按内容认那一版，见 findPreFixCommit）、落到
 * 临时目录、动态 import 起来，拿【同一份】合成语料分别喂给旧实现与当前实现，
 * 两个读数并排打印。
 *
 * 语料的形状（三格，各自对应本轮登记的一条主张）：
 *  ① `../<上限表里的目录>/xN.ts` 灌满每一格的配额 —— 【洞本体】。
 *     旧实现把 `../` 前缀抹掉 ⇒ 归成地道仓内目录 ⇒ 逐格【恰好踩在配额上】⇒ 绿；
 *     新实现保留原文 ⇒ 每一格都成了「基线外的目录」⇒ 红并点名。
 *  ② 同一批路径去掉 `../`（真仓内写法）—— 【单变量对照】：证明 ① 那个红/绿
 *     是「在不在仓内」造成的，而不是「认不认识 `../`」这种字符串口味。
 *  ③ 每一格前面挂一个 `E:/other/repo/` —— 【登记说错方向的那一格】：
 *     绝对式在【旧实现】上就已经是红的（带盘符的目录名进配额表），
 *     所以 round296 那条射程「它红在『新目录』上」只对这一型成立。
 *
 * 跑法：`npx tsx .workbuddy/probe300-fold.ts`（只读，不碰仓内字节）。
 * 只读语料、不读数据库、不跑 tsc —— 三个消费者都是纯函数。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  countTypeErrorsByDir,
  diffTypeBaseline,
  parseListFiles,
  parseTscOutput,
  TYPE_BASELINE,
} from "../test/arch/test-type-baseline.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 三个消费者各读一次，压成一行读数（两个版本共用，保证【口径】不出入）。 */
function readings(
  mod: typeof import("../test/arch/test-type-baseline.js"),
  root: string,
  lines: string[],
): string {
  const parsed = mod.parseTscOutput(lines.join("\n"), root);
  const diff = mod.diffTypeBaseline(
    mod.countTypeErrorsByDir(parsed.errors),
  );
  // ⚠ 语料那一列【必须喂纯路径】：--listFilesOnly 的形状是一行一个路径，
  //   把带 `(行,列): error TS…` 后缀的整行喂给 parseListFiles 会因 `!endsWith(".ts")`
  //   全部跳过 ⇒ 恒 0，而恒 0 会被读成「这些都不算本仓语料」—— 本轮在测试里
  //   先踩过一次同一个坑，探针不能带着它写下来的假读数当证据。
  const plain = lines.map((l) => l.replace(/\(\d+,\d+\): error TS\d+:.*$/u, ""));
  return (
    "错误 " + parsed.errors.length + " 条 / 未解析 " + parsed.unparsed +
    " / 语料 " + mod.parseListFiles(plain.join("\n"), root) + " 个 / " +
    (diff === "" ? "【绿：diffTypeBaseline 返回空字符串】" : "红：" + diff.slice(0, 90) + "…")
  );
}

/** 造语料：每一格配额都灌满，形状由 prefix 决定。 */
function corpus(prefix: (dir: string) => string): string[] {
  const out: string[] = [];
  for (const b of TYPE_BASELINE) {
    for (let i = 0; i < b.atMost; i++) {
      out.push(`${prefix(b.dir)}/x${i}.ts(1,1): error TS2322: Type 'a' is not assignable.`);
    }
  }
  return out;
}

/**
 * 找【落判据之前】那一版守卫所在的提交 —— 按内容认，不按 `HEAD^` 认。
 *
 * 为什么不能写死 `HEAD^` 或某个短号：这一发的意义是「坏读数【现在还能复现】」，
 * 而 HEAD 每提交一次就挪一格。写死短号的话本轮一提交，这份探针就从【证据】
 * 降级成【一段跑不通的历史】。按内容认（那份文件里【没有】 escapesUpward
 * 这个符号的最新提交）就自描述、且经得起 rebase。
 *
 * ⚠ 找不到要【抛】，不许退回当前实现：拿修好的那份去比修好的那份，
 *   ① 那一格会变成两边都红，而那个读数长得和【洞已修】一模一样 ——
 *   一份会把自己的失效模式伪装成自己成功的探针，比没有探针更坏。
 */
function findPreFixCommit(): { sha: string; depth: number } {
  const shas = execFileSync(
    "git",
    ["log", "--format=%H", "--", "test/arch/test-type-baseline.ts"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  )
    .split(/\r?\n/u)
    .filter((s) => s !== "");
  for (const [i, sha] of shas.entries()) {
    const text = execFileSync("git", ["show", sha + ":test/arch/test-type-baseline.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (!text.includes("escapesUpward")) return { sha, depth: i };
  }
  throw new Error(
    "历史里找不到【没有 escapesUpward】的那一版守卫 ⇒ 洞的坏读数无法复现。" +
      "此时【不能】退回当前实现去比：两边都会红，而那个读数长得像「洞已修好」。",
  );
}

/* 那份旧实现落到临时目录再 import —— 不碰工作树，也不靠我记得旧实现长什么样。 */
const dir = mkdtempSync(join(tmpdir(), "opc-round300-"));
try {
  const oldPath = join(dir, "old.ts");
  const found = findPreFixCommit();
  console.log(
    "对照的旧实现 = " + found.sha.slice(0, 7) +
      "（该文件历史上往回数第 " + (found.depth + 1) + " 版，" +
      "判据：那份字节里【没有】 escapesUpward）",
  );
  writeFileSync(
    oldPath,
    execFileSync("git", ["show", found.sha + ":test/arch/test-type-baseline.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }),
    "utf8",
  );
  // ⚠ 必须走 pathToFileURL：本机 tmpdir 在 C: 而仓在 D:，直接把绝对路径喂给
  //   import() 会撞 ERR_UNSUPPORTED_ESM_URL_SCHEME（它把 `C:` 当协议名读了）。
  //   顺带这一发就是本轮那条主张的现场演示：跨盘的【真】仓外路径，
  //   归一函数拿 ROOT=D:/item/opc 去量它，本来就该判它「不在仓内」。
  const old = (await import(pathToFileURL(oldPath).href)) as typeof import("../test/arch/test-type-baseline.js");
  const now = { countTypeErrorsByDir, diffTypeBaseline, parseListFiles, parseTscOutput, TYPE_BASELINE };

  // 分母数出来：两版各自的上限表总数与表行数（不写死 291 / 22 —— 表会变）。
  const cap = (m: typeof now) => m.TYPE_BASELINE.reduce((n, b) => n + b.atMost, 0);
  console.log(
    "配额合计 旧 =", cap(old), "当前 =", cap(now),
    "；上限表行数 旧 =", old.TYPE_BASELINE.length, "当前 =", now.TYPE_BASELINE.length,
  );

  const cases: Array<[string, (d: string) => string, string]> = [
    ["① 往上跳（洞本体）", (d) => "../" + d, "旧该【绿】（这就是登记没说的那半格）/ 新该【红】"],
    ["② 同位置写回仓内（单变量对照）", (d) => d, "两棵树都该【绿】（配额恰好踩满，没超）"],
    ["③ 仓外绝对式（登记说错方向那一型）", (d) => "E:/other/repo/" + d, "两棵树都该【红】—— 所以那句射程只对这一型成立"],
  ];
  for (const [name, prefix, note] of cases) {
    const lines = corpus(prefix);
    console.log("\n" + name + "（" + lines.length + " 条）\n  " + note);
    console.log("  落判据之前 ⇒ " + readings(old, ROOT, lines));
    console.log("  当前实现   ⇒ " + readings(now, ROOT, lines));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
