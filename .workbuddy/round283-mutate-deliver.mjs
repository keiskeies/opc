// round283 变异：投递这一趟的每条判据到底拦得住什么。
// 跑法：npx tsx .workbuddy/round283-mutate-deliver.mjs
// ⚠ 这个文件里【不许】出现 TS 类型断言（esbuild 解析不了 .mjs 里的 `as`）。
// 每一发变异都必须是【运行时合法】的改动：vitest 只转译不查类型，
// 所以「编译炸了」不是一种读数，它只是没跑 —— 那种情况本脚本明说「读数不算」。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TARGET = "packages/hub/src/channels/deliver.ts";
const TEST = "packages/hub/test/channels/deliver.test.ts";
const REPORT = ".workbuddy/.mut-deliver.json";

const MUTATIONS = [
  {
    id: "M1",
    name: "顺序翻向：先发再插（正是文件头明说「不选」的那一条）",
    from: `    let claimed: boolean;
    try {
      claimed = await claimDelivery(
        o.w,
        approvalId,
        channel.id,
        o.nowMs,
        channel.supportsActionReturn,
      );
    } catch (e) {`,
    to: `    const pre = await deliverCard(channel, snap);
    let claimed: boolean;
    try {
      claimed = pre.kind !== "sent" || (await claimDelivery(
        o.w,
        approvalId,
        channel.id,
        o.nowMs,
        channel.supportsActionReturn,
      ));
    } catch (e) {`,
  },
  {
    id: "M2",
    name: "外键违例不再接住（一张被删的卡带走整轮）",
    from: `      if (!why.includes("FOREIGN KEY constraint failed")) throw e;`,
    to: `      if (why.length >= 0) throw e;`,
  },
  {
    id: "M3",
    name: "摘掉 OR IGNORE（「这一对送过」改由异常表达）",
    from: `  "INSERT OR IGNORE INTO card_deliveries " +`,
    to: `  "INSERT INTO card_deliveries " +`,
  },
  {
    id: "M4",
    name: "没注册的通道 id 不再抛，读成「本轮没有要发的卡」",
    from: `    throw new Error(
      "runDeliverPass：通道 " +
        o.channelId +
        " 不在注册表里（注册了 " +
        o.channels.map((c) => c.id).join(" / ") +
        "）⇒ 本轮【没有】投任何卡。",
    );`,
    to: `    return { delivered: 0, alreadySent: 0, skippedNotPending: 0, failed: [] };`,
  },
  {
    id: "M5",
    name: "发送失败就抹掉台账行（把「看得见的漏投」改回「看不见」）",
    from: `    // 发失败了：台账那一行【留着】。见文件头「看得见的一次漏投」。
    failed.push({ approvalId, channelId: channel.id, why: r.why });`,
    to: `    await clearDeliveriesFor(o.w, approvalId);
    failed.push({ approvalId, channelId: channel.id, why: r.why });`,
  },
  {
    id: "M6",
    name: "不可逆卡干脆不推（把「只读」错读成「不发」）",
    from: `    const r = await deliverCard(channel, snap);`,
    to: `    const r = (snap.parametersJson ?? "").includes('"irreversible":true')
      ? { kind: "sent" as const }
      : await deliverCard(channel, snap);`,
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
      "\n" + m.id + " 锚点命中 " + hits + " 次 ⇒ 【未跑】：锚点必须唯一，否则改动范围不明。",
    );
    continue;
  }
  writeFileSync(TARGET, original.replace(m.from, m.to), "utf8");
  run();
  const res = readReport();
  if (!res) {
    console.log("\n" + m.id + " " + m.name + "\n  ⇒ 读不到报告（转译就炸了）：这一发【不算】。");
    continue;
  }
  console.log("\n" + m.id + " " + m.name + "\n  ⇒ 红 " + res.failed.length + " / " + res.total);
  for (const f of res.failed) console.log("     · " + f);
  if (res.failed.length === 0) console.log("     ⚠ 全绿 ⇒ 这条判据【没有分母】，测试是假的。");
}
writeFileSync(TARGET, original, "utf8");
console.log(
  "\n已还原 " +
    TARGET +
    "：" +
    (readFileSync(TARGET, "utf8") === original ? "与原文逐字一致" : "【不一致，手工检查】"),
);
