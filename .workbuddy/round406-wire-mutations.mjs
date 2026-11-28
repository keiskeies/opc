// 0086 变异机：逐根剪掉「散会/取消那一刻进详情与纪要」的接线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round405 的形状）：
//  · 每根线用 replace 真抹掉字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// 剪线对象三处，每发自己点名文件（只剪一侧另一侧会代打）：
//  · 渲染 packages/web/public/group.js（结论区那一行 + 时刻格式 + 标签分支）
//  · 纪要正文 packages/hub/src/documents/deposit.ts（散会时刻那一行）
//  · 落库 packages/hub/src/meetings/service.ts（CONCLUDE/CANCEL 喂给 concluded_at 的那一枚参数）
//
// M1…M10 = 本轮接线的每一根线各一发，expect 写「预期红在哪条线」，判据须与该根动作有因果。
// M11 = 控制组（会议文档卡的说明文案）：它【应当】活下来 —— 判据只认真数据不认提示语。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const DEPOSIT = "packages/hub/src/documents/deposit.ts";
const SERVICE = "packages/hub/src/meetings/service.ts";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "散会的时刻：详情只写开场于，散会/取消那刻既不进结论区也不进纪要";

const e2e = () => ({
  cmd: "npx",
  // shell: true 是必需的：Windows 上 npx 是 npx.cmd，不经 shell 会 ENOENT 且只落在 res.error，
  // 长得和「判据本身坏了」一模一样。
  args: [
    "playwright",
    "test",
    E2E,
    "-g",
    TITLE,
    "--reporter=list",
    "--timeout=40000",
  ],
  opts: { shell: true },
});

// 结论区里「散会于/取消于」那一整对 dt/dd。整对摘掉 = 界面上这一刻压根不存在。
const DL_PAIR =
  '          h("dt", { text: concluded ? "散会于" : "取消于" }),\n' +
  "          h(\"dd\", {\n" +
  '            class: "mono",\n' +
  "            text: fmtDateTime(meeting.concluded_at),\n" +
  "          }),\n";
// 标签的 ternary：写成常量「散会于」= 取消的那局也叫散会（CANCEL 与 CONCLUDE 同列这一事实被抹平）。
const LABEL_TERNARY = 'h("dt", { text: concluded ? "散会于" : "取消于" }),';
// 时刻那一格换成 fmtDate（只到日）—— 界面上「有个日期」，但那一刻的精度没了。
const TIME_ROW = "            text: fmtDateTime(meeting.concluded_at),";
// 时刻那一格读错列：拿 opened_at 冒充。页面上照样是一个漂亮的 zh-CN 时刻。
const TIME_SOURCE = "text: fmtDateTime(meeting.concluded_at)";
// 结论区渲染条件。恒真 ⇒ 开着的会也铺一张 dl，散会表单再也出不来。
const DL_COND = '    concluded || cancelled\n      ? h(\n          "dl",';
// 发言正文（纪要判据读的就是这份轮次的内容）。
const TURN_BODY =
  'h("div", { class: "turn-content", text: turn.content })';
// 纪要正文里的散会时刻那一行（连同换行整行摘掉）。
const MINUTES_LINE =
  "    `- 散会时刻：${deadlineText(meeting.concluded_at)}`,\n";
// 纪要那一行读错列：拿截止时间冒充散会时刻。
const MINUTES_SOURCE = "deadlineText(meeting.concluded_at)";
// CONCLUDE_SQL 的参数表里 concluded_at 那一枚（位置即列序，错位 = 两列互相冒充）。
const CONCLUDE_ARGS =
  "        req.deadline_at,\n        o.nowMs,\n        o.meetingId,";
// CANCEL_SQL 的参数表：取消那刻写死一个纪元 —— 列照写，时刻是假的（保持占位符个数不变）。
const CANCEL_ARG = "run(db, CANCEL_SQL, [o.nowMs, o.meetingId])";

const MUTATIONS = [
  {
    id: "M1-结论区压根不做这一刻（dt/dd 整对摘掉）",
    file: GROUP,
    from: DL_PAIR,
    to: "",
    expect: "线 3（散会于这一行在）",
  },
  {
    id: "M2-标签恒写「散会于」（ternary 收成常量）",
    file: GROUP,
    from: LABEL_TERNARY,
    to: 'h("dt", { text: "散会于" }),',
    expect: "线 6（取消那局写的是「取消于」）；散会侧两发全绿 ⇒ 只有取消那一抓得住",
  },
  {
    id: "M2b-标签恒写「取消于」（反方向常量）",
    file: GROUP,
    from: LABEL_TERNARY,
    to: 'h("dt", { text: "取消于" }),',
    expect: "线 3（散会那局写的是「散会于」）",
  },
  {
    id: "M3-时刻退化成 fmtDate（只到日）",
    file: GROUP,
    from: TIME_ROW,
    to: "            text: fmtDate(meeting.concluded_at),",
    expect: "线 4（渲染 == fmtDateTime(concluded_at) 的同一个字符串）",
  },
  {
    id: "M4-时刻读错列（拿 opened_at 冒充）",
    file: GROUP,
    from: TIME_SOURCE,
    to: "text: fmtDateTime(meeting.opened_at)",
    expect: "线 4；开场于本来就渲染，所以「页面上有个时刻」这种判据抓不住",
  },
  {
    id: "M5-结论区渲染条件恒真",
    file: GROUP,
    from: DL_COND,
    to: "    true\n      ? h(\n          \"dl\",",
    expect: "线 0（开着的会：dl 数为 0 且散会表单在）",
  },
  {
    id: "M6-发言正文不渲染",
    file: GROUP,
    from: TURN_BODY,
    to: 'h("div", { class: "turn-content", text: "" })',
    expect: "线 1（发言框计数 1 且内容有字）",
  },
  {
    id: "M7-纪要正文里没有散会时刻",
    file: DEPOSIT,
    from: MINUTES_LINE,
    to: "",
    expect: "线 5（纪要正文含「- 散会时刻：<ISO>」）；渲染侧全绿也抓不住 —— 这就是只剪一侧会漏的那格",
  },
  {
    id: "M8-纪要那一行拿截止时间冒充",
    file: DEPOSIT,
    from: MINUTES_SOURCE,
    to: "deadlineText(meeting.deadline_at)",
    expect: "线 5（ISO 是散会那刻，不是 2026-12-31 那条截止）",
  },
  {
    id: "M9-散会时 concluded_at 与 deadline_at 参数错位",
    file: SERVICE,
    from: CONCLUDE_ARGS,
    to: "        o.nowMs,\n        req.deadline_at,\n        o.meetingId,",
    expect: "线 2（库里那一刻落在提交窗口内）；列写了但写的是别的事实",
  },
  {
    id: "M10-取消那刻写死一个纪元",
    file: SERVICE,
    from: CANCEL_ARG,
    to: "run(db, CANCEL_SQL, [1700000000000, o.meetingId])",
    expect: "线 6（取消那一刻的窗口 + 行内时刻 == fmtLocal(concluded_at)）",
  },
  {
    id: "M11-控制组：会议文档卡说明文案改掉（应当存活）",
    file: GROUP,
    from: 'text: "散会成功后，服务端自动生成包含发言与结论的 Markdown 纪要。",',
    to: 'text: "散会后会自动生成纪要。",',
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
 * 失败行 → 线号：这条用例是一发 test，「哪根线先红」只能按断言所在行归。
 * 线 N 的区间 = 它那句 `// 线 N（…）` 注释所在行到下一条线注释前一行。
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
  // 这一条有 7 段线注释（0…6）：低于这个数是取材坏了，不是「用例简单」。
  if (found.length < 7) {
    throw new Error(`线注释只认到 ${found.length} 条（预期 7），取材失败`);
  }
  const wires = [];
  found.forEach(([at, name], i) => {
    const hi = i + 1 < found.length ? found[i + 1][0] - 1 : endAt;
    wires.push([at, hi, name]);
  });
  // 声明行那一枚要剔掉：list reporter 的 `ok 1 …spec.ts:4541:1 › 标题` 里也带行号，
  // 绿的那一发同样会命中它 —— 留着会把「通过」读成「红在未归类的声明行」。
  return [wires, found.length, declAt + 1];
}

const [WIRES, WIRE_COUNT, DECL_LINE] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释，共 ${WIRES.length} 段。`);

function wireOf(out) {
  const rows = [
    ...new Set(
      [...out.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)]
        .map((m2) => Number(m2[1]))
        .filter((n) => n !== DECL_LINE),
    ),
  ].sort((a, b) => a - b);
  const hit = new Set();
  for (const n of rows) {
    const w = WIRES.find(([lo, hi]) => n >= lo && n <= hi);
    if (w) hit.add(w[2]);
  }
  return hit.size
    ? [...hit].join(" + ")
    : `（未归类，实跑行号 ${rows.join(",") || "无"}）`;
}

const files = [GROUP, DEPOSIT, SERVICE];
const original = new Map(
  files.map((f) => [f, { text: readFileSync(f, "utf8"), sha: "" }]),
);
for (const [f, entry] of original) {
  entry.sha = sha(entry.text);
  console.log(`${f} 起始 SHA ${entry.sha.slice(0, 16)}`);
}

// —— 预热：锚点命中数 + 未变异必须绿
let prewarmBad = 0;
for (const m of MUTATIONS) {
  const hits = count(original.get(m.file).text, m.from);
  if (hits !== 1) {
    console.log(
      `⛔ ${m.id} 在 ${m.file} 里锚点命中 ${hits} 次（必须恰好 1）—— 停机，先核对坐标`,
    );
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
  const entry = original.get(m.file);
  const mutated = entry.text.replace(m.from, m.to);
  if (mutated === entry.text) {
    console.log(`⛔ ${m.id} 替换后字节未变 —— 停`);
    process.exit(3);
  }
  writeFileSync(m.file, mutated);
  let res;
  try {
    res = run(e2e());
  } finally {
    writeFileSync(m.file, entry.text);
  }
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  const restored = sha(readFileSync(m.file, "utf8")) === entry.sha;
  const counted = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u.test(out);
  let verdict;
  if (!restored) verdict = "RESTORE-FAILED";
  else if (!counted) verdict = "INDETERMINATE";
  else if ((res.status ?? -1) === 0)
    verdict = m.control ? "SURVIVED(控制组如预期)" : "SURVIVED";
  else verdict = "KILLED";
  rows.push({
    id: m.id,
    verdict,
    expect: m.expect,
    which: wireOf(out),
    restored,
  });
  console.log(
    `> ${m.id} | ${verdict} | 预期红在：${m.expect} | 实红在：${
      verdict === "KILLED" ? wireOf(out) : "-"
    }`,
  );
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
  console.log(`${r.verdict.padEnd(22)} ${r.id.padEnd(34)} 实红在：${r.which}`);
}
// 每根线要有【只属于它】的目击者：某发全局清扫（比如把整块摘掉）会替没有自己判据的线代打，
// 全红也可能漏掉一根从没被单独剪过的线。所以这里按「实红在」逐线点名。
const killedByWire = new Map();
for (const r of rows) {
  if (r.verdict !== "KILLED") continue;
  for (const [, , name] of WIRES) {
    if (r.which.includes(name)) {
      if (!killedByWire.has(name)) killedByWire.set(name, []);
      killedByWire.get(name).push(r.id);
    }
  }
}
console.log("\n=== 逐线点名（谁替这根线代打） ===");
for (const [, , name] of WIRES) {
  const ids = killedByWire.get(name) ?? [];
  console.log(
    `${ids.length ? "✓" : "✗ 无人剪过"} ${name} ← ${ids.join(" / ") || "无"}`,
  );
}
const realSurvived = rows.filter((r) => r.verdict === "SURVIVED").length;
const unwatched = WIRES.filter(([, , name]) => !killedByWire.has(name)).length;
console.log(
  `\n剪线 ${rows.length} 根（含 1 根控制组）：真线存活 ${realSurvived}，无目击者的线 ${unwatched}`,
);
console.log(
  realSurvived === 0 && unwatched === 0
    ? "✅ 真实接线全部被杀，且每根线各自有目击者"
    : `⚠ 存活 ${realSurvived} 根 / 无人剪过的线 ${unwatched} 根 ⇒ 判据不承重，别提交`,
);
