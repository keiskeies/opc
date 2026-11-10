#!/usr/bin/env node
/**
 * 这台机器上【哪些依赖真的能用】—— 一条当场可复算的读数，不是一个清单。
 *
 * 为什么要有这个脚本（0031）：本仓有十几个任务挂着「缺依赖所以做不了」。
 * 那句话我此前一直是**抄来的**，抄的时候还顺手把「`.pnpm` 里有那个目录名」
 * 读成「装上了」—— 而那个读法在**两个相反的方向上都会错**：
 *
 *   · 空壳：`node_modules/.pnpm/tsx@4.23.15/` 这个目录**在**，里面 0 KB。
 *     按目录名判 ⇒ 判成「装了」⇒ 我会去写一个跑不起来的适配器，
 *     并在「为什么测试全绿」上再花半天。
 *   · hoist：`node_modules/zod` 是一个 8 MB 的**真目录**（pnpm 提到顶层了），
 *     而 `.pnpm/zod@4.6.7/` 是 0 KB 空壳。按 `.pnpm` 判 ⇒ 判成「没装」
 *     ⇒ 我会说「zod 不可用」，而它此刻正被 `packages/contracts` 用着。
 *
 * 所以唯一的口径是【从消费方那个位置解析得到】（createRequire + 真实 specifier）。
 * 这也正是运行时真正会问的那个问题：Node 不在乎 store 长什么样，
 * 它只在乎 `import("tsx/cli")` 从 `packages/hub/src/` 出发找不找得到。
 *
 * 只读，不装，不联网，不改任何东西。跑法：
 *   PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node packages/hub/scripts/deps-resolvable.mjs
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 探测点：从 hub 的源码目录出发。
 * 为什么是那里而不是仓库根：pnpm 的解析是**按包**的，
 * 从根目录能解析到不代表 `packages/hub` 能（它的 `node_modules` 是另一个作用域）。
 * 而本仓真正要跑这些依赖的代码全在 hub 里。
 *
 * 路径由本文件自己的位置算出（同 bench-recompute.mjs），**不写绝对路径** ——
 * 写死 `/Users/…` 的脚本换一台机器就探测的是「一个不存在的目录」，
 * 而那种情况下每一条依赖都会报【解析不到】：读数看起来是「依赖全缺」，
 * 真相是「探针站错了地方」，正好是本文件要防的那一类误读。
 */
const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONSUMER = join(HUB, "src", "__probe__.ts");

/**
 * specifier → 它挡着哪个任务。
 * specifier 用**真实 import 形状**（`tsx/cli` 而不是 `tsx`）：
 * 一个包可能主入口能解析而子路径不行（exports 字段挡掉），
 * 而那正是「装了但用不了」那一类的形状。
 */
const PROBES = [
  ["@langchain/core/messages", "Task 6.1 重试接进图节点 / 6.2、6.3 端到端那半"],
  ["@langchain/langgraph", "同上（StateGraph 与图执行）"],
  ["tsx/cli", "全量测试里那 60 条基线红（子进程跑 TS 的那几套）"],
  ["vitest", "pnpm verify"],
  ["@biomejs/biome", "pnpm lint ⇒ 所有新文件的格式未经校验"],
  ["react", "Task 4.2 / 4.3 移动端、Replay.tsx"],
  ["@capacitor/core", "Task 4.2 移动端打包"],
  ["@xyflow/react", "Task 3.2 组织图编辑器"],
  ["@larksuiteoapi/node-sdk", "Task 4.4 飞书通道 ⇒ 也是 bindings/im 的生产者"],
  ["@modelcontextprotocol/sdk/client/index.js", "Task 5.7 三层搜索"],
  ["@openai/codex-sdk", "Task 5.5 Codex 适配器"],
  ["@qoder-ai/qoder-agent-sdk", "Task 5.6 Qoder 适配器"],
  // 正对照：这两个【必须】解析得到，否则整份读数是「什么都没探到」而不是「全都缺」。
  ["zod", "正对照（contracts 的 schema 全用它）"],
  ["typescript", "正对照（tsc 与 test/arch 的 AST 守卫用它）"],
];

const req = createRequire(CONSUMER);

const rows = PROBES.map(([spec, blocks]) => {
  try {
    req.resolve(spec);
    return { spec, blocks, ok: true };
  } catch {
    return { spec, blocks, ok: false };
  }
});

const usable = rows.filter((r) => r.ok);
const missing = rows.filter((r) => !r.ok);

console.log("── 能解析（真能用）──");
for (const r of usable) console.log("  " + r.spec.padEnd(44) + r.blocks);
console.log("\n── 解析不到（这些任务今天在这台机器上做不了，也不是没试）──");
for (const r of missing) console.log("  " + r.spec.padEnd(44) + r.blocks);

// 恒绿的形状要当场能看出来：如果一条都没解析到，那不是「依赖很缺」，是探针坏了。
if (usable.length === 0) {
  console.log(
    "\n★ 一条都没解析到 ⇒ 这个脚本自己坏了（正对照 zod / typescript 也失败），" +
      "上面那份【解析不到】清单一律不可采信。",
  );
  process.exitCode = 2;
}
