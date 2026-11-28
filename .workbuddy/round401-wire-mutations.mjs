// 0082 变异机：逐根剪线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round370/round395/round400 的形状）：
//  · 每根线用 replace 真抹掉 group.js 里的字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机（坐标漂了先重钉）；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；不一致就停下人来；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// M1…M7 = 本轮接线的每一根线各一发。每根的「预期红在哪条线」写进 expect，判据必须能与该根动作
// 形成因果（round375 的教训：尺子与被剪线没有因果，绿是量错时刻量出来的）。
// C1 = 控制组（muted 那句里的说明文字「清空日期回到今天」）：它【应当】活下来 —— 判据只认
// 「汇总 <那一天> 的调研卡」这段，不认提示语；这一格是范围声明，用来让「判据恒红」当场露出来。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "每日调研按日翻";

const e2e = () => ({
  cmd: "npx",
  // shell: true 是必需的，不是风格：Windows 上 npx 是 npx.cmd，spawnSync 不经 shell 直接 ENOENT，
  // 而 ENOENT 只落在 res.error（不在 stdout/stderr）⇒ 预热会拿到「退出码非零 + 输出全空」，
  // 长得和「判据本身坏了」一模一样。round400 那份就带着 shell: true，抄漏了这一格。
  args: ["playwright", "test", E2E, "-g", TITLE, "--reporter=list", "--timeout=40000"],
  opts: { shell: true },
});

const INPUT_BLOCK = [
  '      input("research_day", state.researchDay, "date", {',
  '        "aria-label": "调研日期",',
  "        onchange: (event) => {",
  "          state.researchDay = event.target.value;",
  '          void loadTeamPanel("research");',
  "        },",
  "      }),",
].join("\n");

const DAY_BRANCH = [
  "    } else if (state.researchDay) {",
  '      path = `/research/today?${new URLSearchParams({',
  "        day: state.researchDay,",
  "      })}`;",
].join("\n");

const MUTATIONS = [
  {
    id: "M1-日期框整枚摘掉",
    from: INPUT_BLOCK,
    to: "",
    expect: "线 0（那一格存在）计数 0",
  },
  {
    id: "M2-选了日期也不带 day",
    from: DAY_BRANCH,
    to: "    } else if (false) {",
    expect: "线 2（切日期真发一条带 day=昨天 的 GET）",
  },
  {
    id: "M3-发请求但 day 传空",
    from: "        day: state.researchDay,",
    to: "        day: \"\",",
    expect: "线 2（day 的值必须等于所填那一天；空值被 .strict() 的正则判 422）",
  },
  {
    id: "M4-空态文案写死今天",
    from: "          `${dayText} 还没有调研`,",
    to: '          "今天还没有调研",',
    expect: "线 4（前天空态说那一天、且不再出现「今天还没有调研」）",
  },
  {
    id: "M5-日期框不回填读数",
    from: '      input("research_day", state.researchDay, "date", {',
    to: '      input("research_day", "", "date", {',
    expect: "线 5（重画后框里仍是所填那一天）",
  },
  {
    id: "M6-onchange 只改状态不重读",
    from: '          state.researchDay = event.target.value;\n          void loadTeamPanel("research");',
    to: "          state.researchDay = event.target.value;",
    expect: "线 2（既等不到带 day 的响应，列表也不会换成昨天那批）",
  },
  {
    id: "M7-默认那档不走本地日界",
    from: "  const dayText = state.researchDay || localDayValue(0);",
    to: '  const dayText = state.researchDay || "";',
    expect: "线 0b（没填日期时汇总句写的是今天这个具体日子）",
  },
  {
    id: "M8-每次重画再塞一枚日期框",
    from: '      input("research_day", state.researchDay, "date", {\n        "aria-label": "调研日期",',
    to:
      '      input("research_day", state.researchDay, "date", {\n        "aria-label": "调研日期",\n        value: state.researchDay,\n      }),\n      input("research_day", state.researchDay, "date", {\n        "aria-label": "调研日期",',
    expect: "线 0/5b（工具条只该有一枚日期框）",
  },
  {
    id: "M9-清空也照发 day（空串进查询）",
    from: "    } else if (state.researchDay) {",
    to: "    } else if (state.researchDay !== null) {",
    expect: "线 1 起就该红（初屏 researchDay 是空串 ⇒ 带 day= 的 GET 被 .strict() 判 422），线 3 是同一格的下游",
  },
  {
    id: "C1-控制组：提示语改掉（应当存活）",
    from: '汇总 ${dayText} 的调研卡，直接打开来源、调研文档与服务端自动创建的待办草稿。清空日期回到今天。',
    to: "汇总 ${dayText} 的调研卡。",
    expect: "无（范围声明：判据不认提示语）",
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
 * 失败行 → 线号：整份 e2e 里这条用例是一发 test，所以「哪根线先红」只能按断言所在行归。
 * 区间表【从 spec 自己推】（round400 的形状）：线 N 的区间 = 它那句 `// 线 N（…）` 注释所在行
 * 到下一条线注释前一行；只扫这条用例自己那一段，否则别的用例的线注释会混进来。
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
  // 本轮这一条有 8 段线注释（0 / 0b / 1 / 2 / 3 / 4 / 5 / 5b）：低于这个数就是取材本身坏了，
  // 而不是「用例简单」—— 判据注释被改掉时，归因表会静默退化成「未归类」。
  if (found.length < 8) {
    throw new Error(`线注释只认到 ${found.length} 条（预期 8），取材失败`);
  }
  const wires = [];
  found.forEach(([at, name], i) => {
    const hi = i + 1 < found.length ? found[i + 1][0] - 1 : endAt;
    wires.push([at, hi, name]);
  });
  const pre = [];
  for (let i = declAt + 1; i < found[0][0] - 1; i += 1) {
    if (/expect\(/u.test(lines[i])) pre.push(i + 1);
  }
  if (pre.length === 0) throw new Error("灌数据那几发断言找不到，取材失败");
  return [[[pre[0], pre[pre.length - 1], "线 灌两张卡各自 2xx"], ...wires], found.length];
}

const [WIRES, WIRE_COUNT] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释 + 灌数据段，共 ${WIRES.length} 段。`);

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
console.log(`group.js 起始 SHA ${originalSha}`);

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
let survived = 0;
for (const r of rows) {
  if (r.verdict === "SURVIVED") survived++;
  console.log(`${r.verdict.padEnd(22)} ${r.id.padEnd(28)} 实红在：${r.which}`);
}
const realSurvived = rows.filter((r) => r.verdict === "SURVIVED").length;
console.log(`\n剪线 ${rows.length} 根（含 1 根控制组）：真线存活 ${realSurvived}`);
console.log(realSurvived === 0 ? "✅ 真实接线全部被杀" : `⚠ 有 ${realSurvived} 根真线活下来 ⇒ 判据不承重，别提交`);
