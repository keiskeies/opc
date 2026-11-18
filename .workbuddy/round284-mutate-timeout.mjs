// round284 · 超时那一格的四发变异（打在【生产代码】上）
//
// 跑法：npx tsx .workbuddy/round284-mutate-timeout.mjs
//
// 为什么这一轮必须有变异：新写的 8 发全绿，而「一发都没红过」的新测试在本仓的
// 历史记录里几乎每一次都是判据没接上（0047 / 0053 / round282 那两条空转）。
// 超时这一格尤其可疑，因为它最容易写成「断言 init 里有一个字段」——那种判据
// 摘掉整条超时也照样绿。
//
// 约束（同前几轮）：锚点必须逐字命中【一次】；跑完逐字节还原并核对。
// 这个文件是 .mjs ⇒ 里面【不许】有 TS 类型断言（esbuild 解析不了）。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "packages/hub/src/channels/feishu.ts";
const SUITE = "packages/hub/test/channels/feishu-http.test.ts";
const REPORT = ".workbuddy/.mut-timeout.json";
const original = readFileSync(TARGET, "utf8");

/** 锚点必须逐字命中一次；命中 0 次或多次都直接停 —— 空变异比没有变异更坏。 */
function once(src, anchor) {
  const n = src.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error("锚点命中 " + n + " 次（需要恰好 1 次）：" + anchor.slice(0, 60));
  }
  return src;
}

const MUTANTS = [
  {
    name: "T1 摘掉「取 token」那一发的信号（一轮的第一发没了截止）",
    apply(src) {
      const anchor =
        "        }),\n        signal: AbortSignal.timeout(this.#fetchTimeoutMs),\n      });";
      once(src, anchor);
      return src.replace(anchor, "        }),\n      });");
    },
  },
  {
    name: "T2 摘掉 #call（读消息 + 发卡）那一发的信号",
    apply(src) {
      const anchor =
        "      ...(body === undefined ? {} : { body: JSON.stringify(body) }),\n      signal: AbortSignal.timeout(this.#fetchTimeoutMs),\n    };";
      once(src, anchor);
      return src.replace(
        anchor,
        "      ...(body === undefined ? {} : { body: JSON.stringify(body) }),\n    };",
      );
    },
  },
  {
    name: "T3 一轮【共用】一个信号（第二页被第一页的时间杀掉）",
    apply(src) {
      let s = once(
        src,
        "  readonly #fetchTimeoutMs: number;",
      ).replace("  readonly #fetchTimeoutMs: number;", "  readonly #fetchTimeoutMs: number;\n  #sharedSignal: AbortSignal | null = null;");
      const mk = "signal: AbortSignal.timeout(this.#fetchTimeoutMs),";
      if (s.split(mk).length - 1 !== 2) throw new Error("需要两处信号构造点");
      s = s.split(mk).join("signal: (this.#sharedSignal ??= AbortSignal.timeout(this.#fetchTimeoutMs)),");
      return s;
    },
  },
  {
    name: "T4 把 0 当成「关掉超时」（畸形值不再回落）",
    apply(src) {
      // ⚠ 这条锚点在第一轮跑之后就漂了：我把三元的条件提出来起了个名叫 `usable`
      //    （为了过 biome 的格式），锚点还指着旧的那半句 ⇒ 命中 0 次，这发【没跑】。
      //    「锚点不符」是这套脚本里唯一会自己喊出来的失效，别把它读成「这发试过了」。
      const anchor = "    const usable = t !== undefined && Number.isFinite(t) && t > 0;";
      once(src, anchor);
      return src.replace(
        anchor,
        "    const usable = t !== undefined && Number.isFinite(t);",
      );
    },
  },
];

function runSuite() {
  spawnSync("npx", ["vitest", "run", SUITE, "--reporter=json", "--outputFile=" + REPORT], {
    shell: true,
    encoding: "utf8",
  });
  let j;
  try {
    j = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {
    return null;
  }
  const failed = [];
  let total = 0;
  for (const t of j.testResults ?? []) {
    for (const a of t.assertionResults ?? []) {
      total += 1;
      if (a.status === "failed") failed.push(a.title);
    }
  }
  return { failed, total };
}

console.log("基准：" + SUITE);
const base = runSuite();
if (base === null) {
  writeFileSync(TARGET, original, "utf8");
  throw new Error("基准读不到报告，停。");
}
console.log("  " + base.total + " 发，红 " + base.failed.length + "（必须是 0）");
if (base.failed.length !== 0) {
  writeFileSync(TARGET, original, "utf8");
  throw new Error("基准不绿，后面的读数不可信 —— 先修基准");
}

for (const mut of MUTANTS) {
  let mutated;
  try {
    mutated = mut.apply(original);
  } catch (e) {
    console.log("\n" + mut.name + "\n  ⇒ 【锚点不符，这一发不算】" + String(e.message));
    continue;
  }
  if (mutated === original) {
    console.log("\n" + mut.name + "\n  ⇒ 【空变异，这一发不算】");
    continue;
  }
  writeFileSync(TARGET, mutated, "utf8");
  const r = runSuite();
  if (r === null) {
    console.log("\n" + mut.name + "\n  ⇒ 【读不到报告，这一发不算】");
    continue;
  }
  console.log("\n" + mut.name + "\n  ⇒ 红 " + r.failed.length + " / " + r.total);
  for (const n of r.failed) console.log("     · " + n);
  if (r.failed.length === 0) {
    console.log("     ⚠ 全绿 ⇒ 这一格【没有分母】，那句主张是假的。");
  }
}

writeFileSync(TARGET, original, "utf8");
const back = readFileSync(TARGET, "utf8");
console.log(
  "\n已还原 " + TARGET + "：" + (back === original ? "与原文逐字一致" : "【不一致，立刻人工核对】"),
);
