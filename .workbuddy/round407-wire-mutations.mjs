// 0087 变异机：逐根剪掉「挂载变更 ⇒ members.updated_at 前进，并一路读到界面」的接线
// → 跑对应尺子（服务端那 5 发单测 / 那一条 e2e）→ 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round406 的形状）：
//  · 每根线用 replace 真抹掉字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机；
//  · 剪线后跑尺子，红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；
//  · 开工前先在【未变异】上跑两把尺子：必须都绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// M1…M9 + M18…M20 = 服务端那一侧的剪线（尺子：单测）；M10…M16 + M21 = 客户端那一侧
// 每根线各一发（尺子：e2e）；M17 = 控制组（未选成员时的空态说明文案），它【应当】活下来。
//
// 本轮三处尺子修正：
//  · spawn 一律带 NO_COLOR=1 —— vitest 默认给 reporter 上 ANSI，文件名与行号之间会插
//    转义序列，`service\.test\.ts:(\d+)` 一发不中，五发单测的 KILLED 全部记成「无人目击」
//    （第一轮就是这么报出「10 根线无人剪过」的）。
//  · 单测侧除了行号还抠 `FAIL` 标题行 —— `❯ file:N:C` 指向 vitest 自己挑的那一格，
//    一行只报一枚，同 it 里后续断言不落行；按标题点名才数得全每发的目击者。
//  · e2e 的 state 有【两条】拉新路径：存档回调里的 loadCore，和 SSE `MemberUpdated`
//    ⇒ snapshotRefresh ⇒ refreshAll。用例已把 `/api/events` 回成空流掐断第二条
//    （见 spec 用例头注释），并补了线 3b 与线 4 的 DOM 读者 —— 否则 M15/M16/M21
//    这三根客户端的线永远由 SSE 代打、永远没有自己的目击者。
//  · 服务端那三根「线 3 / 线 5 / 线 6 各自依赖的接线」（M1 技能侧加钟、M2 执行器侧加钟、
//    M9 判定恒真）第一轮只跑单测尺子 ⇒ 逐线点名时这三段 e2e 线报「无人剪过」：单测替
//    它们代打，e2e 自己那把尺子从没在剪过的字节上跑过。这三发改成 both（两把尺子各跑
//    一发），e2e 侧的实红由 playwright 停在的第一段线点名。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVICE = "packages/hub/src/members/service.ts";
const GROUP = "packages/web/public/group.js";
const UNIT = "packages/hub/test/members/service.test.ts";
const E2E = "test/e2e/group-workbench.spec.ts";
const E2E_TITLE = "成员档案的时刻：换技能与换执行器算不算档案变了";
const UNIT_TITLE = "挂载替换与 updated_at";

/** shell: true 是必需的：Windows 上 npx 是 npx.cmd，不经 shell 会 ENOENT。 */
const runSpec = (args) => ({
  cmd: "npx",
  args,
  opts: { shell: true, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" } },
});
const unitRun = () => runSpec(["vitest", "run", UNIT, "-t", UNIT_TITLE]);
const e2eRun = () =>
  runSpec([
    "playwright",
    "test",
    E2E,
    "-g",
    E2E_TITLE,
    "--reporter=list",
    "--timeout=40000",
  ]);

// —— 服务端锚点
const SKILL_BRANCH =
  "    let after = mustView(db, o.memberId);\n" +
  "    if (skillsKey(before.skills) !== skillsKey(after.skills)) {\n" +
  "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n" +
  "      after = mustView(db, o.memberId);\n";
const EXEC_BRANCH =
  "    let after = mustView(db, o.memberId);\n" +
  "    if (executorsKey(before.executors) !== executorsKey(after.executors)) {\n" +
  "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n" +
  "      after = mustView(db, o.memberId);\n";
// 只留下「不重读视图」的那一版（返回体与审计快照会读到加钟前的旧值）。
const SKILL_BRANCH_NORELOAD =
  "    const after = mustView(db, o.memberId);\n" +
  "    if (skillsKey(before.skills) !== skillsKey(after.skills)) {\n" +
  "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n";
const EXEC_BRANCH_NORELOAD =
  "    const after = mustView(db, o.memberId);\n" +
  "    if (executorsKey(before.executors) !== executorsKey(after.executors)) {\n" +
  "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n";
const BUMP_BODY = "  db.prepare(BUMP_MEMBER_SQL).run(...(params as never[]));";
const PARAMS = "  const params: unknown[] = [nowMs, memberId];";
const SQL_LINE =
  'const BUMP_MEMBER_SQL = "UPDATE members SET updated_at = ? WHERE member_id = ?";';
// 恒真判定：每次挂载写都算「变了」（台账会多记，钟每次都动）。
const SKILL_COND =
  "if (skillsKey(before.skills) !== skillsKey(after.skills)) {";
const EXEC_COND =
  "if (executorsKey(before.executors) !== executorsKey(after.executors)) {";

// —— 客户端锚点
const DT_HIRE = '      h("dt", { text: "入职于" }),\n';
const DT_UPDATE = '      h("dt", { text: "最近更新" }),\n';
const DD_UPDATE = '      h("dd", { text: fmtDateTime(member.updated_at) }),';
const FMT_LINE =
  '  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";';
const CORE_SKILL =
  "      { method: \"POST\", body: { skills } },\n    );\n    await loadCore();\n";
const CORE_EXEC =
  "      { method: \"POST\", body: { executors: executorsList } },\n    );\n    await loadCore();\n";

const MUTATIONS = [
  {
    id: "M1-技能分支压根不加钟",
    file: SERVICE,
    side: "both",
    from: SKILL_BRANCH,
    to: "    const after = mustView(db, o.memberId);\n    if (skillsKey(before.skills) !== skillsKey(after.skills)) {\n",
    expect: "单测：换技能那一发（视图 + 裸列 + 返回体三处读数）；e2e：停在线 3「前进」那一发",
  },
  {
    id: "M2-执行器分支压根不加钟",
    file: SERVICE,
    side: "both",
    from: EXEC_BRANCH,
    to: "    const after = mustView(db, o.memberId);\n    if (executorsKey(before.executors) !== executorsKey(after.executors)) {\n",
    expect: "单测：换执行器那一发 + 只改 enabled 那一发；e2e：停在线 6「前进」那一发",
  },
  {
    id: "M3-技能侧加完钟不重读视图",
    file: SERVICE,
    side: "unit",
    from: SKILL_BRANCH,
    to: SKILL_BRANCH_NORELOAD,
    expect: "换技能那一发的「返回体 updated_at」（库里照写，返回的是旧值）",
  },
  {
    id: "M4-执行器侧加完钟不重读视图",
    file: SERVICE,
    side: "unit",
    from: EXEC_BRANCH,
    to: EXEC_BRANCH_NORELOAD,
    expect: "换执行器那一发的「返回体 updated_at」；技能侧全绿也抓不住执行器这一支",
  },
  {
    id: "M5-加钟原语被调但语句不执行",
    file: SERVICE,
    side: "unit",
    from: BUMP_BODY,
    to: "  // 变异机剪掉：语句不执行",
    expect: "两发放钟的发（调用点还在，等于什么都没写）",
  },
  {
    id: "M6-加钟语句写成不动任何钟",
    file: SERVICE,
    side: "unit",
    from: SQL_LINE,
    to: 'const BUMP_MEMBER_SQL = "UPDATE members SET name = name WHERE member_id = ?";',
    expect: "两发放钟的发（SQL 合法、列没被碰；参数个数不变所以断言拦不住）",
  },
  {
    id: "M7-加钟写错列（把 hired_at 当 updated_at）",
    file: SERVICE,
    side: "unit",
    from: SQL_LINE,
    to: 'const BUMP_MEMBER_SQL = "UPDATE members SET hired_at = ? WHERE member_id = ?";',
    expect: "updated_at 等值断言 + 返回体 + 每发 hired_at 不许动的那一句",
  },
  {
    id: "M8-加钟参数错位（member_id 当时刻写进列）",
    file: SERVICE,
    side: "unit",
    from: PARAMS,
    to: "  const params: unknown[] = [memberId, nowMs];",
    expect: "第一发被拒（TEXT 灌进 INTEGER 撞 NOT NULL）⇒ 单测红；无 catch ⇒ 事务外泄成异常",
  },
  {
    id: "M9-技能侧同值写也算变更（判定恒真）",
    file: SERVICE,
    side: "both",
    // ⚠ 恒真只换括号里的表达式，`if (` 与 `) {` 的骨架一根手指都不碰：
    // 第一版把 `if (cond) {` 整段换成 `true`，花括号失配 ⇒ 文件解析失败，
    // vitest 报「Test Files 1 failed」却没有任何一行断言坐标 —— counted 谓词
    // 认到计数就判了 KILLED，实红在「（未归类 无）」。那是语法错杀死的变异，
    // 什么判据也没承重（round384「runner 启动即错那次跑什么都没测」的同族）。
    from: SKILL_COND,
    to: "if (true) {",
    expect:
      "单测：U2 同值写第二次也加钟 ⇒ 台账计数与 updated_at 两处红（U1 照绿）；e2e：停在线 5「钟不许动」那一发",
  },
  {
    id: "M10-入职于那一格不渲染",
    file: GROUP,
    side: "e2e",
    from: DT_HIRE,
    to: "",
    expect: "线 1（dt 列表逐项相等）+ 线 2/3b/7/8 那几格读数",
  },
  {
    id: "M11-最近更新那一格不渲染",
    file: GROUP,
    side: "e2e",
    from: DT_UPDATE,
    to: "",
    expect: "线 1 + 线 2/3b/7/8（最近更新那一格读数）",
  },
  {
    id: "M12-最近更新读的是入职钟",
    file: GROUP,
    side: "e2e",
    from: DD_UPDATE,
    to: '      h("dd", { text: fmtDateTime(member.hired_at) }),',
    expect: "线 3b 起（前进之后两格必须分得开；线 1-3 仍全绿）",
  },
  {
    id: "M13-时刻退化成 fmtDate（只到日）",
    file: GROUP,
    side: "e2e",
    from: `      h("dd", { text: fmtDateTime(member.hired_at) }),\n${DT_UPDATE}${DD_UPDATE}`,
    to: '      h("dd", { text: fmtDate(member.hired_at) }),\n' +
      DT_UPDATE +
      '      h("dd", { text: fmtDate(member.updated_at) }),',
    expect: "线 2（判据是 fmtDateTime 的同一个字符串，不是「页面上有个日期」）",
  },
  {
    id: "M14-两格共用一个时刻格式化器（改成只到日）",
    file: GROUP,
    side: "e2e",
    from: FMT_LINE,
    to: '  value ? new Date(value).toLocaleDateString("zh-CN") : "—";',
    expect: "线 2 起所有时刻读数；同时证明尺子读的是那把尺而不是别的",
  },
  {
    id: "M15-技能保存后不重新拉状态",
    file: GROUP,
    side: "e2e",
    from: CORE_SKILL,
    to: '      { method: "POST", body: { skills } },\n    );\n',
    expect: "线 3b（SSE 已掐断，详情从旧 state 渲染出入职那刻的旧钟）",
  },
  {
    id: "M16-执行器保存后不重新拉状态",
    file: GROUP,
    side: "e2e",
    from: CORE_EXEC,
    to: '      { method: "POST", body: { executors: executorsList } },\n    );\n',
    expect: "线 8（不 reload 直接开详情）；技能那一支全绿抓不住这里",
  },
  {
    id: "M17-控制组：空态说明文案改掉（应当存活）",
    file: GROUP,
    side: "e2e",
    from: '                "从左侧组织树或群组选择成员，查看岗位、技能、执行器与所属项目。",',
    to: '                "从左侧选择成员。",',
    expect: "无（范围声明：判据不认提示语）",
    control: true,
  },
  {
    id: "M18-重复技能守卫被摘（U3 的目击者）",
    file: SERVICE,
    side: "unit",
    from:
      "    const dup = dupSkillId(o.skills);\n" +
      "    if (dup !== null) {\n" +
      "      return err(\n" +
      '        "duplicate_skill_id",\n' +
      '        "技能 skill_id=[" +\n' +
      "          dup +\n" +
      '          "] 重复：重复项在挂载表里会互相覆盖，等于没挂。",\n' +
      "      );\n" +
      "    }\n" +
      "    const before = mustView(db, o.memberId);\n",
    to: "    const before = mustView(db, o.memberId);\n",
    expect:
      "U3：重复项穿过守卫走到整插 ⇒ (member_id, skill_id) 主键撞库当场抛 ⇒ 那发直接炸红",
  },
  {
    id: "M19-空执行器链守卫被摘（U3 的第二目击者）",
    file: SERVICE,
    side: "unit",
    from:
      "    if (o.executors.length === 0) {\n" +
      "      return err(\n" +
      '        "empty_executor_chain",\n' +
      '        "执行器链不能清空：零执行器的成员什么都干不了（D4）。要停用他请归档成员。",\n' +
      "      );\n" +
      "    }\n",
    to: "",
    expect:
      "U3 的 empty.ok（整删零插后链真的空了、钟照加、返回 ok:true）；技能侧四发不受牵连",
  },
  {
    id: "M20-技能侧加钟写的是错时刻（nowMs+1）",
    file: SERVICE,
    side: "unit",
    from:
      "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs);\n" +
      "      after = mustView(db, o.memberId);\n" +
      '      appendHireEvent(db, o.memberId, "skills_changed"',
    to:
      "      bumpMemberUpdatedAt(db, o.memberId, o.nowMs + 1);\n" +
      "      after = mustView(db, o.memberId);\n" +
      '      appendHireEvent(db, o.memberId, "skills_changed"',
    expect:
      "U1 的三处读数都钉 NOW+1 这一枚具体钟 ⇒ 写 NOW+2 当场红；U2 的钟同样读到 NOW+2；执行器那一支字节未动",
  },
  {
    id: "M21-删除技能后不重新拉状态",
    file: GROUP,
    side: "e2e",
    from:
      "      `/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`,\n" +
      '      { method: "DELETE" },\n' +
      "    );\n" +
      "    await loadCore();\n",
    to:
      "      `/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`,\n" +
      '      { method: "DELETE" },\n' +
      "    );\n",
    expect:
      "线 4 的 DOM 半发（卡片从旧 state 重绘 ⇒ 摘掉那行还挂着，计数停在 3）",
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

// —— 线表：单测按 it() 标题行分段，e2e 按 `// 线 N（…）` 注释分段。
function loadUnitWires() {
  const lines = readFileSync(UNIT, "utf8").split("\n");
  const start = lines.findIndex((l) =>
    l.startsWith('describe("挂载替换与 updated_at'),
  );
  if (start < 0) throw new Error("找不到那个 describe，取材失败");
  let end = -1;
  for (let i = start; i < lines.length; i += 1) {
    if (lines[i] === "});") {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("找不到 describe 的收尾，取材失败");
  const found = [];
  for (let i = start; i < end; i += 1) {
    const m = /^ *it\("(.+?)",/u.exec(lines[i]);
    if (m) found.push([i + 1, m[1]]);
  }
  if (found.length !== 5) {
    throw new Error(`单测用例只认到 ${found.length} 发（预期 5），取材失败`);
  }
  return found.map(([at, name], i) => [
    at,
    i + 1 < found.length ? found[i + 1][0] - 1 : end,
    name,
  ]);
}

function loadE2eWires() {
  const lines = readFileSync(E2E, "utf8").split("\n");
  const declAt = lines.findIndex((l) => l.startsWith(`test("${E2E_TITLE}`));
  if (declAt < 0) throw new Error("找不到那条 e2e 的声明行，取材失败");
  let endAt = -1;
  for (let i = declAt; i < lines.length; i += 1) {
    if (lines[i] === "});") {
      endAt = i;
      break;
    }
  }
  if (endAt < 0) throw new Error("找不到那条 e2e 的收尾，取材失败");
  const found = [];
  for (let i = declAt; i < endAt; i += 1) {
    const m = /^ *\/\/ 线 (\d+[a-z]?)（(.+?)）/u.exec(lines[i]);
    if (m) found.push([i + 1, `线 ${m[1]} ${m[2]}`]);
  }
  if (found.length !== 9) {
    throw new Error(`e2e 线注释认到 ${found.length} 段（预期 9，含线 3b）—— 取材失败`);
  }
  return [
    found.map(([at, name], i) => [
      at,
      i + 1 < found.length ? found[i + 1][0] - 1 : endAt,
      name,
    ]),
    declAt + 1,
  ];
}

const UNIT_WIRES = loadUnitWires();
const [E2E_WIRES, E2E_DECL] = loadE2eWires();
console.log(
  `线表现推：单测 ${UNIT_WIRES.length} 发、e2e ${E2E_WIRES.length} 段线注释。`,
);

function wireOf(out, side) {
  if (side === "unit") {
    const rows = [
      ...new Set(
        [...out.matchAll(/service\.test\.ts:(\d+)/gu)].map((m) => Number(m[1])),
      ),
    ].sort((a, b) => a - b);
    const hit = new Set();
    for (const n of rows) {
      const w = UNIT_WIRES.find(([lo, hi]) => n >= lo && n <= hi);
      if (w) hit.add(w[2]);
    }
    // `FAIL file > describe > it 标题` 与 list reporter 的 `× it 标题` 都按标题点名：
    // 一个 it 里挂了多发射，`❯ file:N:C` 只报 vitest 挑的那一格，其余的发不落行。
    for (const m of out.matchAll(
      /(?:FAIL .*service\.test\.ts > [^\n>]* > |× )([^\n]+?)\s*(?:\d+m?s)?\s*$/gmu,
    )) {
      const title = m[1].trim();
      const w = UNIT_WIRES.find(([, , name]) => name === title);
      if (w) hit.add(w[2]);
    }
    return hit.size ? [...hit].join(" + ") : `（未归类 ${rows.join(",") || "无"}）`;
  }
  const rows = [
    ...new Set(
      [...out.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)]
        .map((m) => Number(m[1]))
        .filter((n) => n !== E2E_DECL),
    ),
  ].sort((a, b) => a - b);
  const hit = new Set();
  for (const n of rows) {
    const w = E2E_WIRES.find(([lo, hi]) => n >= lo && n <= hi);
    if (w) hit.add(w[2]);
  }
  return hit.size ? [...hit].join(" + ") : `（未归类 ${rows.join(",") || "无"}）`;
}

// —— 线 7（整页重载后界面读的是最新那一枚）是【守卫线】：声明它存在但没有可剪的专属线。
// 它读的是「首次加载把 state 拉新」这条 app 初始化路径 —— 剪掉 loadCore 的第一次调用
// 会让整页不渲染（线 1 先红，playwright 停在 线 1），永远轮不到 线 7 当第一目击者。
// 所以点名时它走 declared：不参与「无人剪过」计数，也不许冒领别人的击杀。
const GUARD_LINES = ["线 7 整页重载后界面读的是最新那一枚"];

const files = [SERVICE, GROUP];
const original = new Map(
  files.map((f) => [f, { text: readFileSync(f, "utf8"), sha: "" }]),
);
for (const [f, entry] of original) {
  entry.sha = sha(entry.text);
  console.log(`${f} 起始 SHA ${entry.sha}`);
}

// —— 预热：锚点命中数 + 两把尺子在未变异上必须绿
let prewarmBad = 0;
for (const m of MUTATIONS) {
  const hits = count(original.get(m.file).text, m.from);
  if (hits !== 1) {
    console.log(`⛔ ${m.id} 在 ${m.file} 里锚点命中 ${hits} 次（必须恰好 1）—— 停机`);
    prewarmBad++;
  }
  if (m.from === m.to) {
    console.log(`⛔ ${m.id} 的 from 与 to 一字不差 ⇒ 假变异，停机`);
    prewarmBad++;
  }
}
if (prewarmBad > 0) process.exit(3);
console.log(`预热：${MUTATIONS.length} 根锚点全部恰好命中 1 次`);

for (const [name, spec] of [
  ["单测", unitRun()],
  ["e2e", e2eRun()],
]) {
  const pre = run(spec);
  const out = `${pre.stdout ?? ""}${pre.stderr ?? ""}`;
  if ((pre.status ?? -1) !== 0 || /No tests found/iu.test(out)) {
    console.log(`⛔ 未变异的${name}那一发没绿 —— 停（判据本身先坏）`);
    console.log(out.slice(-3000));
    process.exit(3);
  }
  console.log(`预热：未变异${name}绿，开工`);
}

const rows = [];
for (const m of MUTATIONS) {
  const entry = original.get(m.file);
  const mutated = entry.text.replace(m.from, m.to);
  if (mutated === entry.text) {
    console.log(`⛔ ${m.id} 替换后字节未变 —— 停`);
    process.exit(3);
  }
  writeFileSync(m.file, mutated);
  // side:"both" ⇒ 同一份变异字节上两把尺子各跑一发（先单测后 e2e）：服务端那根线
  // 在 e2e 上也有自己的读者（线 3/5/6），只跑单测就是「单测替 e2e 代打」。
  const sides =
    m.side === "both"
      ? ["unit", "e2e"]
      : [m.side];
  let res;
  let out = "";
  let restored = true;
  const parts = [];
  try {
    for (const s of sides) {
      res = run(s === "unit" ? unitRun() : e2eRun());
      out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
      const counted = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u.test(out);
      let verdict;
      if ((res.status ?? -1) === 0) {
        verdict = m.control ? "SURVIVED(控制组如预期)" : "SURVIVED";
      } else if (!counted) verdict = "INDETERMINATE";
      else verdict = "KILLED";
      parts.push({
        side: s,
        verdict,
        which: verdict === "KILLED" ? wireOf(out, s) : "-",
      });
    }
  } finally {
    writeFileSync(m.file, entry.text);
  }
  restored = sha(readFileSync(m.file, "utf8")) === entry.sha;
  const counted = parts.every((p) => p.verdict !== "INDETERMINATE");
  let verdict;
  if (!restored) verdict = "RESTORE-FAILED";
  else if (!counted) verdict = "INDETERMINATE";
  else if (parts.some((p) => p.verdict === "KILLED")) verdict = "KILLED";
  else verdict = m.control ? "SURVIVED(控制组如预期)" : "SURVIVED";
  const which = parts
    .filter((p) => p.verdict === "KILLED")
    .map((p) => `${p.side}：${p.which}`)
    .join(" + ") || "-";
  rows.push({ id: m.id, verdict, expect: m.expect, which });
  console.log(
    `> ${m.id} | ${verdict} | 预期红在：${m.expect} | 实红在：${
      verdict === "KILLED" ? which : "-"
    }`,
  );
  // KILLED 但红点归类不到任何一根线 ⇒ 多半是「文件压根没跑起来」（语法错、
  // 启动崩），那种红不承重任何判据，不能计入击杀 —— 停机人工看原文。
  if (verdict === "KILLED" && parts.some((p) => p.which.startsWith("（未归类"))) {
    console.log("⛔ KILLED 但实红归类不到任何一根线 —— 停机（先怀疑变异把文件改崩）");
    console.log(out.slice(-3000));
    process.exit(6);
  }
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
// 每根线要有【只属于它】的目击者：全局清扫会替没有自己判据的线代打，
// 全红也可能漏掉一根从没被单独剪过的线。所以这里按「实红在」逐线点名。
const ALL = [...UNIT_WIRES, ...E2E_WIRES];
const killedByWire = new Map();
for (const r of rows) {
  if (r.verdict !== "KILLED") continue;
  for (const [, , name] of ALL) {
    if (r.which.includes(name)) {
      if (!killedByWire.has(name)) killedByWire.set(name, []);
      killedByWire.get(name).push(r.id);
    }
  }
}
console.log("\n=== 逐线点名（谁替这根线代打） ===");
for (const [, , name] of ALL) {
  const ids = killedByWire.get(name) ?? [];
  if (GUARD_LINES.includes(name)) {
    console.log(`◆ 守卫线（声明无可剪专属线）${name} ← ${ids.join(" / ") || "无专属击杀，见机头注释"}`);
    continue;
  }
  console.log(
    `${ids.length ? "✓" : "✗ 无人剪过"} ${name} ← ${ids.join(" / ") || "无"}`,
  );
}
const realSurvived = rows.filter((r) => r.verdict === "SURVIVED").length;
const unwatched = ALL.filter(
  ([, , name]) => !killedByWire.has(name) && !GUARD_LINES.includes(name),
).length;
console.log(
  `\n剪线 ${rows.length} 根（含 1 根控制组）：真线存活 ${realSurvived}，无目击者的线 ${unwatched}`,
);
console.log(
  realSurvived === 0 && unwatched === 0
    ? "✅ 真实接线全部被杀，且每根线各自有目击者"
    : `⚠ 存活 ${realSurvived} 根 / 无人剪过的线 ${unwatched} 根 ⇒ 判据不承重，别提交`,
);
