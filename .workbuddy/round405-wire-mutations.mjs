// 0085 变异机：逐根剪掉「拆分弹窗带上限」的接线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round403 的形状）：
//  · 每根线用 replace 真抹掉字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// 剪线对象两处：渲染 group.js、服务端 packages/hub/src/backlog/service.ts。
// 只剪一侧另一侧会代打（渲染带上去但服务端不写 / 服务端写但渲染不带），所以每发自己点名文件。
//
// M1…M8 = 本轮接线的每一根线各一发，expect 写「预期红在哪条线」，判据须与该根动作有因果。
// C1 = 控制组（拆分弹窗的说明文案）：它【应当】活下来 —— 判据只认请求与控件不认提示语。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const SERVICE = "packages/hub/src/backlog/service.ts";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "拆分带上限的活";

const e2e = () => ({
  cmd: "npx",
  // shell: true 是必需的：Windows 上 npx 是 npx.cmd，不经 shell 会 ENOENT 且只落在 res.error，
  // 长得和「判据本身坏了」一模一样（round400 抄漏这一格撞过）。
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

// 子项 1 的期限那一格（预填父项期限 + 留空说明）。
const CHILD1_FIELD =
  '        field(\n          "子项 1 期限",\n' +
  '          input("child1_due", dateInputValue(item.due_at), "datetime-local"),\n' +
  '          "留空 = 该子项无期限；预填的是父项当前的期限。",\n        ),\n';
// 子项 2 的期限那一格（无说明文案）：整格摘掉 = 线 0 的第二枚计数先红。
const CHILD2_FIELD =
  '        field(\n          "子项 2 期限",\n' +
  '          input("child2_due", dateInputValue(item.due_at), "datetime-local"),\n        ),\n';
// due_at 上送那一发（留空整枚不发）。抹掉 = 控件与预填全在、绿在「弹窗长对了」上，
// 但请求体不再带期限 —— 这正是「判据只看 DOM 不看请求」会漏掉的那一格。
const SEND_DUE =
  "          // 契约的 children[].due_at 是 positive 可选：留空整枚不发，服务端落 null。\n" +
  "          ...(child.due ? { due_at: new Date(child.due).getTime() } : {}),\n";
// dateInputValue 的 null 挡。⚠ 锚点必须连着函数头：`if (value === null || value === undefined)
// return "";` 这一行在 payloadText（同文件 3236 行）里有一模一样的第二份，单抄那行命中 2 次。
const NULL_GUARD =
  "const dateInputValue = (value) => {\n" +
  "  // null/undefined 必须挡在 new Date 之前：new Date(null) 是纪元 0 时刻（不是 Invalid），\n" +
  '  // 放行下去会得到 "1970-01-01"——无期限的待办打开「延期」会预填 1970，点保存就把期限写成了纪元。\n' +
  '  if (value === null || value === undefined) return "";\n';
// 卡片上那条期限的 <time>（线 5 的落点）。⚠ 三行一起抹：只抹前两行会留下孤零零的 `: null,`，
// 那是语法错 —— 红会红在「模块解析不了、列表压根不出现」的超时上，因果就错了。
const CARD_TIME =
  '            item.due_at\n' +
  '              ? h("time", { class: "mono", text: fmtDate(item.due_at) })\n' +
  "              : null,\n";
// 服务端把 children[].due_at 落库的那一枚参数（线 2 唯一的目击者：渲染带得再对，
// 这一格改成 null 就等于「界面写了但库里没有」）。
const SERVICE_DUE = "        child.due_at ?? null,";
// 拆分收尾摸父项 updated_at 那一发（splitBacklog 里唯一一处）。M10 在它后面追加一句
// 「把父项期限清掉」= 把「父项保留」读成「期限交给子项」那一种实现选择 —— 子项三发全对，
// 只有父项那条变 null。契约明写「父项保留」（backlog.ts:81 文件头注），这不是等价改写。
const SERVICE_TOUCH = "    run(db, TOUCH_SQL, [o.nowMs, parent.id]);";

const MUTATIONS = [
  {
    id: "M1-期限格压根不做（子项 1）",
    file: GROUP,
    from: CHILD1_FIELD,
    to: "",
    expect: "线 0（期限格子在弹窗里）计数 0",
  },
  {
    id: "M2-预填不取父项期限（空串）",
    file: GROUP,
    from: 'input("child1_due", dateInputValue(item.due_at), "datetime-local")',
    to: 'input("child1_due", "", "datetime-local")',
    expect: "线 0（预填回读 == 父项那一刻的期限）",
  },
  {
    id: "M3-上送那一发整条摘掉",
    file: GROUP,
    from: SEND_DUE,
    to: "",
    expect: "线 1（请求体 children 各带 due_at）；控件仍在 ⇒ 只看 DOM 的判据会漏",
  },
  {
    id: "M4-两枚共用第一枚的值",
    file: GROUP,
    from:
      '          { title: data.get("child2"), due: data.get("child2_due") },',
    to: '          { title: data.get("child2"), due: data.get("child1_due") },',
    expect:
      "线 4（清空第二枚 ⇒ 那一枚不该仍带父项期限）；第一发两枚都没动 ⇒ 线 0/1/2/3 全绿，只有清空那一发抓得住",
  },
  {
    id: "M5-第二枚期限格不做",
    file: GROUP,
    from: CHILD2_FIELD,
    to: "",
    expect: "线 0（第二枚也在）+ 线 1（children 各带一枚）",
  },
  {
    id: "M6-null 挡缺失（无期限预填成 1970）",
    file: GROUP,
    from: NULL_GUARD,
    to: "const dateInputValue = (value) => {\n",
    expect:
      "线 6（无期限的父项：期限格是空的）；延期弹窗同一条路径，也是它唯一的目击者",
  },
  {
    id: "M7-卡片上不渲染期限",
    file: GROUP,
    from: CARD_TIME,
    to: "            null\n",
    expect: "线 5（拆出的子项各挂上 <time>，父项那条也还在）",
  },
  {
    id: "M8-服务端收了 due_at 却不落库",
    file: SERVICE,
    from: SERVICE_DUE,
    to: "        null,",
    expect: "线 2（两枚真落库）；这是线 2 唯一的目击者",
  },
  {
    id: "M9-留空被父项期限悄悄塞回",
    file: GROUP,
    from: SEND_DUE,
    to:
      "          // 契约的 children[].due_at 是 positive 可选：留空整枚不发，服务端落 null。\n" +
      "          due_at: item.due_at,\n",
    expect:
      "线 4（清空第二枚 ⇒ 那一枚不该仍带父项期限）；前两枚都带期限 ⇒ 线 0/1/2 全绿，只有线 4 抓得住",
  },
  {
    id: "M10-拆完把父项期限清掉",
    file: SERVICE,
    from: SERVICE_TOUCH,
    to:
      "    run(db, TOUCH_SQL, [o.nowMs, parent.id]);\n" +
      '    run(db, "UPDATE backlog_items SET due_at = NULL WHERE id = ?", [parent.id]);',
    expect: "线 3（拆完父项仍带着那条期限）；这是线 3 唯一的目击者",
  },
  {
    id: "C1-控制组：拆分说明文案改掉（应当存活）",
    file: GROUP,
    from: '          "留空 = 该子项无期限；预填的是父项当前的期限。",',
    to: '          "留空表示这一枚不带期限。",',
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
  // 这一条有 7 段线注释（0/1/2/3/4/5/6）：低于这个数是取材坏了，不是「用例简单」。
  if (found.length < 7) {
    throw new Error(`线注释只认到 ${found.length} 条（预期 7），取材失败`);
  }
  const wires = [];
  found.forEach(([at, name], i) => {
    const hi = i + 1 < found.length ? found[i + 1][0] - 1 : endAt;
    wires.push([at, hi, name]);
  });
  // 声明行那一枚要剔掉：list reporter 的 `ok 1 …spec.ts:4314:1 › 标题` 里也带行号，
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

const files = [GROUP, SERVICE];
const original = new Map(
  files.map((f) => [f, { text: readFileSync(f, "utf8"), sha: "" }]),
);
for (const [f, entry] of original) {
  entry.sha = sha(entry.text);
  console.log(`${f} 起始 SHA ${entry.sha.slice(0, 6)}…（完整值不入库）`);
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
  console.log(`${r.verdict.padEnd(22)} ${r.id.padEnd(30)} 实红在：${r.which}`);
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
