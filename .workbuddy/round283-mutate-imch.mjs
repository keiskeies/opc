// round283 变异（第二份）：发卡接进心跳之后，【装配那一格】的判据拦得住什么。
// 跑法：npx tsx .workbuddy/round283-mutate-imch.mjs
//
// ── 为什么单独一份，不并进 round283-mutate-deliver.mjs ──────────────────
// 那一份打在 `channels/deliver.ts`（台账语义），这一份打在 `serve/im-channels.ts`
// （装配）。两处的分母是不同的两份测试文件，混在一起的话「红 3 发」这句话
// 就说不清是红在谁身上 —— 而红在谁身上正是这句话唯一的信息量。
//
// ⚠ 这个文件里【不许】出现 TS 类型断言（esbuild 解析不了 .mjs 里的 `as`）。
// 每一发都必须是【运行时合法】的改动：vitest 只转译不查类型，「编译炸了」不是
// 一种读数，它只是没跑 —— 那种情况本脚本明说「这一发不算」。
//
// ── 有一发【故意没写】，理由记在这儿比写了更重要 ────────────────────────
// 「多于一条通道时干脆不推」那一支（`not_routed`）今天【没有活的分母】：
// `assembleImChannels` 里 `const channels: readonly FeishuChannel[] = [channel]`
// 恒为一条，装配选项上没有插第二条的口。硬凑一发只能直接调 `runDeliverPass`
// 塞两条通道 —— 那是测【函数】而不是测【装配】，而装配那一支恰恰是它管的那格。
// ⇒ 不凑。那一格今天的判据是「屏幕上必须说话」这条纪律 + 人的复查，
//   登记在 r17 的射程 ② 与优化设计 O12 动作 4，别把它读成"有测试守着"。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "packages/hub/src/serve/im-channels.ts";
const TEST = "packages/hub/test/serve/im-channels.test.ts";
const REPORT = ".workbuddy/.mut-imch.json";

const MUTATIONS = [
  {
    id: "A1",
    name: "顺序翻向：先扫 pending 再判回传（同轮里刚批掉的卡会被再推一次）",
    from: `      const rounds = await runtime.pollAll();
      pending.push(...summarize(rounds));
      const deliver = await deliverRound();`,
    to: `      const deliver = await deliverRound();
      const rounds = await runtime.pollAll();
      pending.push(...summarize(rounds));`,
  },
  {
    id: "A2",
    name: "装配层忘了接发卡（模拟「函数在、零读者」那个原始形状）",
    from: `      const deliver = await deliverRound();`,
    to: `      const deliver = { kind: "not_routed", why: "" };`,
  },
  {
    id: "A3",
    name: "这一轮没起来的通道也照样推（摘掉 not_started 那道门）",
    // ⚠ 锚点带了下一行：`if (!started.has(c.id)) {` 在 pollRound 的 start 重试那一支
    // 里逐字出现过一次（两处【该】长得一样，它们是同一个「哪条通道活着」的判据），
    // 而只改这一处才是「发卡不看通道死活」那个坏形状。锚点不唯一 ⇒ 改动范围不明 ⇒ 不算。
    from: `    if (!started.has(c.id)) {
      const why =`,
    to: `    if (started.has("永远不会出现的那个 id")) {
      const why =`,
  },
  {
    id: "A4",
    name: "失败那一句不再说「怎么重推」（只报症状，不给处置）",
    from: `        "要重推是人工决定 —— \`clearDeliveriesFor(w, approvalId)\` 清掉台账行，下一轮当新卡再推。\\n" +`,
    to: `        "\\n" +`,
  },
];

function run() {
  return spawnSync(
    "npx",
    ["vitest", "run", TEST, "--reporter=json", "--outputFile=" + REPORT],
    { shell: true, encoding: "utf8" },
  );
}

function readReport() {
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

const original = readFileSync(TARGET, "utf8");
run();
const b = readReport();
if (!b) {
  console.log("基准读不到报告，停。");
  process.exit(1);
}
console.log("基准：" + b.total + " 发，红 " + b.failed.length);
if (b.failed.length !== 0) {
  console.log("⚠ 基准不绿，后面的读数全部不可信 —— 先修基准。");
  process.exit(1);
}

for (const m of MUTATIONS) {
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(
      "\n" +
        m.id +
        " 锚点命中 " +
        hits +
        " 次 ⇒ 【未跑】：锚点必须唯一，否则改动范围不明。",
    );
    continue;
  }
  writeFileSync(TARGET, original.replace(m.from, m.to), "utf8");
  run();
  const res = readReport();
  if (!res) {
    console.log(
      "\n" + m.id + " " + m.name + "\n  ⇒ 读不到报告（转译就炸了）：这一发【不算】。",
    );
    continue;
  }
  console.log(
    "\n" + m.id + " " + m.name + "\n  ⇒ 红 " + res.failed.length + " / " + res.total,
  );
  for (const f of res.failed) console.log("     · " + f);
  if (res.failed.length === 0)
    console.log("     ⚠ 全绿 ⇒ 这一格【没有分母】，那句主张是假的。");
}
writeFileSync(TARGET, original, "utf8");
console.log(
  "\n已还原 " +
    TARGET +
    "：" +
    (readFileSync(TARGET, "utf8") === original
      ? "与原文逐字一致"
      : "【不一致，手工检查】"),
);
