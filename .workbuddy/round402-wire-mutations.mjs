// 0083 变异机：逐根剪线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round401 的形状）：
//  · 每根线用 replace 真抹掉 group.js 里的字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// M1…M8 = 本轮接线的每一根线各一发，expect 写「预期红在哪条线」，判据须与该根动作有因果。
// C1 = 控制组（日期那格的说明文字）：它【应当】活下来 —— 判据只认取值不认提示语，
// 用来让「判据恒红」当场露出来。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "登记调研归到哪天";

const e2e = () => ({
  cmd: "npx",
  // shell: true 是必需的：Windows 上 npx 是 npx.cmd，不经 shell 会 ENOENT 且只落在 res.error，
  // 长得和「判据本身坏了」一模一样（round400 抄漏这一格撞过）。
  args: ["playwright", "test", E2E, "-g", TITLE, "--reporter=list", "--timeout=40000"],
  opts: { shell: true },
});

const DAY_FIELD = [
 "          field(",
 '            "日期",',
 '            input("day", initialDay, "date", { "aria-label": "调研日期" }),',
 '            "留空则由服务端记在今天。",',
 "          ),",
].join("\n");

const MUTATIONS = [
  {
    id: "M1-弹窗里那枚日期整格摘掉",
    from: DAY_FIELD,
    to: "",
    expect: "线 1（那一格存在且默认等于所看那一天）计数 0",
  },
  {
    id: "M2-默认值不跟随屏上那一天",
    from: "  const initialDay = state.researchDay;",
    to: '  const initialDay = "";',
    expect: "线 1（打开弹窗时该填着昨天）",
  },
  {
    id: "M3-填了日期也不上请求体",
    from: "          ...(day ? { day } : {}),\n",
    to: "",
    expect: "线 2（POST 请求体里的 day == 表单那一格）",
  },
  {
    id: "M4-空值也照发 day（空串进 body）",
    from: "          ...(day ? { day } : {}),",
    to: "          day,",
    expect: "线 5（留空 ⇒ 请求体压根不该有 day）；空串会被契约的 DAY_RE 判 422，弹窗不关",
  },
  {
    id: "M5-留空时替用户发明天",
    from: '      const day = String(data.get("day") || "").trim();',
    to: '      const day = String(data.get("day") || "").trim() || localDayValue(0);',
    expect: "线 5（留空不发 day）；线 6 是它的下游",
  },
  {
    id: "M6-查重文案写死今日",
    from: "            ? `${dayLabel} 调研已存在，已刷新关联状态`",
    to: '            ? "今日调研已存在，已刷新关联状态"',
    expect: "线 4（查重文案说那一天、且不再出现「今日调研已存在」）",
  },
  {
    id: "M7-文案跟着服务端今天而不是表单那一天",
    from: "      const dayLabel = day || localDayValue(0);",
    to: "      const dayLabel = localDayValue(0);",
    expect: "线 4（表单填昨天 ⇒ 文案说昨天）",
  },
  {
    id: "M8-弹窗里塞两枚日期框",
    from: DAY_FIELD,
    to: `${DAY_FIELD}\n${DAY_FIELD}`,
    expect: "线 1（那一格只该有一枚）",
  },
  {
    id: "M9-登记完把视角踢回今天",
    from: "      await refreshAll();\n      await loadTeamPanel(\"research\");",
    to: "      state.researchDay = \"\";\n      await refreshAll();\n      await loadTeamPanel(\"research\");",
    expect: "线 3（卡落在昨天 ⇒ 停在昨天那一屏就该看见它）；这是线 3 唯一的目击者",
  },
  {
    id: "C1-控制组：说明文字改掉（应当存活）",
    from: '            "留空则由服务端记在今天。",',
    to: '            "可以改到别的日子。",',
    expect: "无（范围声明：判据不认 help 文案）",
    control: true,
  },
];

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const count = (hay, needle) => hay.split(needle).length - 1;

function run(spec) {
  return spawnSync(spec.cmd, spec.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...spec.opts,
  });
}

/**
 * 失败行 → 线号：这条用例是一发 test，「哪根线先红」只能按断言所在行归。
 * 区间表从 spec 自己推：线 N 的区间 = 它那句 `// 线 N（…）` 注释所在行到下一条线注释前一行。
 */
function loadWires(specFile) {
  const lines = readFileSync(specFile, "utf8").split("\n");
  const declAt = lines.findIndex((l) => l.startsWith(`test("${TITLE}`));
  if (declAt < 0) throw new Error("找不到那条用例的声明行，取材失败");
  let endAt = -1;
  for (let i = declAt; i < lines.length; i += 1) {
    if (lines[i] === "});") {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error("找不到那条用例的收尾，取材失败");
  const found = [];
  for (let i = declAt; i < endAt; i += 1) {
    const m = /^ *\/\/ 线 (\d+[a-z]?)（(.+?)）/u.exec(lines[i]);
    if (m) found.push([i + 1, `线 ${m[1]} ${m[2]}`]);
  }
  // 这一条有 6 段线注释（1/2/3/4/5/6）：低于这个数是取材坏了，不是「用例简单」。
  if (found.length < 6) {
    throw new Error(`线注释只认到 ${found.length} 条（预期 6），取材失败`);
  }
  const wires = [];
  found.forEach(([at, name], i) => {
    const hi = i + 1 < found.length ? found[i + 1][0] - 1 : endAt;
    wires.push([at, hi, name]);
  });
  return [wires, found.length];
}

const [WIRES, WIRE_COUNT] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释，共 ${WIRES.length} 段。`);

function wireOf(out) {
  const rows = [
    ...new Set(
      [...out.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)].map((m2) =>
        Number(m2[1]),
      ),
    ),
  ].sort((a, b) => a - b);
  const hit = new Set();
  for (const n of rows) {
    const w = WIRES.find(([lo, hi]) => n >= lo && n <= hi);
    if (w) hit.add(w[2]);
  }
  return hit.size ? [...hit].join(" + ") : `（未归类，实跑行号 ${rows.join(",")}）`;
}

const original = readFileSync(GROUP, "utf8");
const originalSha = sha(original);
console.log(`group.js 起始 SHA ${originalSha.slice(0, 6)}…（完整值不入库）`);

// —— 预热：锚点命中数 + 未变异必须绿
let prewarmBad = 0;
for (const m of MUTATIONS) {
  const hits = count(original, m.from);
  if (hits !== 1) {
    console.log(`⛔ ${m.id} 锚点命中 ${hits} 次（必须恰好 1）—— 停机，先核对坐标`);
    prewarmBad++;
  }
  if (m.from === m.to) {
    console.log(`⛔ ${m.id} 的 from 与 to 一字不差 ⇒ 假变异，停机`);
    prewarmBad++;
  }
}
if (prewarmBad > 0) process.exit(3);
console.log(`预热：${MUTATIONS.length} 根锚点全部恰好命中 1 次`);

const pre = run(e2e());
const preOut = `${pre.stdout ?? ""}${pre.stderr ?? ""}`;
if ((pre.status ?? -1) !== 0 || /No tests found/iu.test(preOut)) {
  console.log("⛔ 未变异那一发没绿 —— 停（判据本身先坏）");
  console.log(preOut.slice(-3000));
  process.exit(3);
}
console.log("预热：未变异 1 passed，开工");

const rows = [];
for (const m of MUTATIONS) {
  const mutated = original.replace(m.from, m.to);
  if (mutated === original) {
    console.log(`⛔ ${m.id} 替换后字节未变 —— 停`);
    process.exit(3);
  }
  writeFileSync(GROUP, mutated);
  let res;
  try {
    res = run(e2e());
  } finally {
    writeFileSync(GROUP, original);
  }
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const restored = sha(readFileSync(GROUP, "utf8")) === originalSha;
  const counted = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u.test(out);
  let verdict;
  if (!restored) verdict = "RESTORE-FAILED";
  else if (!counted) verdict = "INDETERMINATE";
  else if ((res.status ?? -1) === 0) verdict = m.control ? "SURVIVED(控制组如预期)" : "SURVIVED";
  else verdict = "KILLED";
  rows.push({ id: m.id, verdict, expect: m.expect, which: wireOf(out), restored });
  console.log(`> ${m.id} | ${verdict} | 预期红在：${m.expect} | 实红在：${verdict === "KILLED" ? wireOf(out) : "-"}`);
  if (verdict === "RESTORE-FAILED") {
    console.log("⛔ 还原后 SHA 不一致 —— 立即停机，人工核对文件");
    process.exit(4);
  }
  if (verdict === "INDETERMINATE") {
    console.log("⛔ 那一发没有任何测试计数 —— 停机");
    console.log(out.slice(-2000));
    process.exit(5);
  }
}
console.log("\n=== 归因表 ===");
for (const r of rows) {
  console.log(`${r.verdict.padEnd(22)} ${r.id.padEnd(30)} 实红在：${r.which}`);
}
const realSurvived = rows.filter((r) => r.verdict === "SURVIVED").length;
console.log(`\n剪线 ${rows.length} 根（含 1 根控制组）：真线存活 ${realSurvived}`);
console.log(realSurvived === 0 ? "✅ 真实接线全部被杀" : `⚠ 有 ${realSurvived} 根真线活下来 ⇒ 判据不承重，别提交`);
