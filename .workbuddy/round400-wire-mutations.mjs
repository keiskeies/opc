// 0081 变异机：逐根剪线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round370/round395 的形状）：
//  · 每根线用 replace 真抹掉 group.js 里的字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机（坐标漂了先重钉）；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；不一致就停下人来；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// M1…M13 = 本轮接线的每一根线各一发（添加按钮 / 两栏行内删除钮 / 页面行的撤销钮 /
// note 那格 / 换 kind 重写 config / 下一档序号现算 / kind 的来源 / enabled 的来源 /
// 只剩一档不给删 / 两条 DELETE 真发出去）。
// C1/C2 = 控制组（help 文案与注释）：它们【应当】活下来 —— 这两格是范围声明，
// 判据不认文案，写在这里是为了让「判据恒红」这种坏法当场露出来。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "成员设置面板增删技能与执行器";

const e2e = () => ({
  cmd: "npx",
  // --timeout 压到 25s（默认 240s）：M12/M13 那两发把 DELETE 换成 GET 之后，
  // 测试等的是【那条 DELETE 响应】，它永远不会来 ⇒ 不发就一路挂到 test timeout。
  // 未变异那一发实测 4s 跑完，25s 是六倍余量；省下的是每发 4 分钟的干等。
  args: ["playwright", "test", E2E, "-g", TITLE, "--reporter=list", "--timeout=25000"],
});

const IF_APPEND_SKILL =
  '      maxlength: 2000,\n    }),\n  );\n  if (remove)\n    row.append(iconButton("close", remove.label, () => remove.onClick(row)));\n  return row;';
const IF_APPEND_EXEC =
  '    config,\n  );\n  if (remove)\n    row.append(iconButton("close", remove.label, () => remove.onClick(row)));\n  return row;';
const ADD_SKILL_BTN = [
  "    button(",
  '      "添加技能",',
  "      () => {",
  "        skillsEditor.insertBefore(",
  "          skillSettingsRow(",
  "            {},",
  '            { label: "删除这一件技能", onClick: (row) => row.remove() },',
  "          ),",
  '          skillsEditor.querySelector("button[type=submit]"),',
  "        );",
  "      },",
  '      "small",',
  "    ),",
].join("\n");

const MUTATIONS = [
  {
    id: "M1-添加技能按钮摘掉",
    from: ADD_SKILL_BTN,
    to: "",
    expect: "线 0（那一栏有「添加技能」）",
  },
  {
    id: "M2-技能行内删除钮不渲染",
    from: IF_APPEND_SKILL,
    to: '      maxlength: 2000,\n    }),\n  );\n  return row;',
    expect: "线 1（每行一枚「删除这一件技能」）+ 线 2b",
  },
  {
    id: "M3-技能页面行的撤销钮改打服务端",
    from: '            { label: "删除这一件技能", onClick: (row) => row.remove() },',
    to: '            { label: "删除这一件技能", onClick: () => removeSkill("", "ghost") },',
    expect: "线 2b（撤掉还没落库的那一行 ⇒ 只该撤 DOM、不该发请求）",
  },
  {
    id: "M4-技能备注那格不提交",
    from: '      ...(note === "" ? {} : { note }),',
    to: "",
    expect: "线 2c（新行的 name/note 各自落库）",
  },
  {
    id: "M5-执行器行内删除钮不渲染",
    from: IF_APPEND_EXEC,
    to: '    config,\n  );\n  return row;',
    expect: "线 4（每档一枚「删除这一档执行器」）+ 线 4c/7",
  },
  {
    id: "M6-执行器页面行的撤销钮改打服务端",
    from: '            { label: "删除这一档执行器", onClick: (row) => row.remove() },',
    to: '            { label: "删除这一档执行器", onClick: () => removeExecutor("", "99") },',
    expect: "线 4c（撤掉刚加那一档 ⇒ 行数回到 3）",
  },
  {
    id: "M7-下一档序号改成数行数",
    from: "        const nextSeq = Math.max(0, ...rows.map((el) => Number(el.value))) + 1;",
    to: "        const nextSeq = rows.length + 1;",
    expect: "线 4d（1/2/4 之后的下一档是 5，不是与已有那档撞号的 4）",
  },
  {
    id: "M8-换kind不重写config",
    from: '  kind.addEventListener("change", () => {',
    to: '  if (false) kind.addEventListener("change", () => {',
    expect: "线 4b（切 builtin-plugin ⇒ 骨架里出现 plugin_id/tool_name）",
  },
  {
    id: "M9-kind不读下拉写死",
    from: '        kind: $("[name=executor_kind]", row).value,',
    to: '        kind: "pure-model",',
    expect: "线 5（那一档的 kind 由行里的下拉带上去 ⇒ 写死必 422/落库不符）",
  },
  {
    id: "M10-enabled不读勾选",
    from: '        enabled: $("[name=executor_enabled]", row).checked,',
    to: "        enabled: true,",
    expect: "线 5（取消勾选那一档落库是 false）",
  },
  {
    id: "M11-只剩一档也给删除钮",
    from: "        member.executors.length > 1",
    to: "        member.executors.length > 0",
    expect: "线 7（只剩一档时按钮数为 0）",
  },
  {
    id: "M12-技能DELETE不发出去",
    from: '      `/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`,\n      { method: "DELETE" },',
    to: '      `/members/${encodeURIComponent(memberId)}/skills/${encodeURIComponent(skillId)}`,\n      { method: "GET" },',
    expect: "线 1（点它 ⇒ 真发一条 DELETE）",
  },
  {
    id: "M13-执行器DELETE不发出去",
    from: '      `/members/${encodeURIComponent(memberId)}/executors/${encodeURIComponent(seq)}`,\n      { method: "DELETE" },',
    to: '      `/members/${encodeURIComponent(memberId)}/executors/${encodeURIComponent(seq)}`,\n      { method: "GET" },',
    expect: "线 6（删中间那一档 ⇒ 真发一条 DELETE）",
  },
  {
    id: "C1-help文案改写（控制组：应活）",
    from: "保留 JSON 直接编辑。换「类型」会连带重写下面那份 config 骨架",
    to: "保留 JSON 直接编辑。换类型会连带重写下面那份 config 骨架",
    expect: "无人断言 help 文案 ⇒ 这一发【应当】SURVIVED（范围声明）",
    control: true,
  },
  {
    id: "C2-注释改写（控制组：应活）",
    from: "  // 不给删除钮 —— 与其让用户撞那条 422，不如让界面先长成那个形状。",
    to: "  // 不给删除钮 —— 界面先长成服务端那个形状。",
    expect: "无人断言注释 ⇒ 这一发【应当】SURVIVED（范围声明）",
    control: true,
  },
];

const sha = (t) => createHash("sha256").update(t).digest("hex");

function run(m) {
  return spawnSync(m.cmd, m.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: true,
  });
}

/**
 * 失败行 → 线号：整份 e2e 里这条用例是一发 test，所以「哪根线先红」只能按断言所在行归。
 * 区间表【从 spec 自己推】：线 N 的区间 = 它那句 `// 线 N（…）` 注释所在行到下一条线注释前一行。
 * 只扫这条用例自己那一段（从声明行到它自己的 `});`），否则别的用例的线注释会混进来。
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
  if (found.length < 10) {
    throw new Error(`线注释只认到 ${found.length} 条，取材失败（判据注释被改了吗？）`);
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
  if (pre.length === 0) throw new Error("首屏那几发断言找不到，取材失败");
  return [[[pre[0], pre[pre.length - 1], "线 首屏两栏各两行"], ...wires], found.length];
}

const [WIRES, WIRE_COUNT] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释 + 首屏，共 ${WIRES.length} 段。`);

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

const RAN_TESTS = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u;

// 预热：未变异必须先绿 + 每个锚点仍在场且唯一 —— 任一不成立都不动源码。
for (const m of MUTATIONS) {
  const src = readFileSync(GROUP, "utf8");
  const n = src.split(m.from).length - 1;
  if (n !== 1) {
    console.log(`⛔ ${m.id} 的锚点命中 ${n} 次（需要恰好 1 次），未动任何源码。`);
    process.exit(3);
  }
  if (m.from === m.to) {
    console.log(`⛔ ${m.id} 的 from 与 to 一字不差 ⇒ 这是假变异，未动任何源码。`);
    process.exit(3);
  }
}
{
  const r = run(e2e());
  const out = `${r.stdout}${r.stderr}`;
  if ((r.status ?? -1) !== 0 || /No tests found/iu.test(out)) {
    console.log(`⛔ 预热失败：尺子在未变异上就不绿。\n${out.slice(-2500)}`);
    process.exit(3);
  }
  console.log("预热：未变异那一条 e2e 绿。");
}

const results = [];
for (const m of MUTATIONS) {
  const spec = { cmd: "npx", args: e2e().args, ...m };
  const orig = readFileSync(GROUP, "utf8");
  const before = sha(orig);
  writeFileSync(GROUP, orig.replace(m.from, m.to), "utf8");
  const r = run(spec);
  const exit = r.status ?? -1;
  writeFileSync(GROUP, orig, "utf8");
  const restored = sha(readFileSync(GROUP, "utf8")) === before;
  const out = `${r.stdout}${r.stderr}`;
  if (exit !== 0 && !RAN_TESTS.test(out)) {
    console.log(results.join("\n"));
    console.log(
      `⛔ ${m.id} 退 ${exit} 但输出里没有任何测试计数 —— 多半是 runner 启动即错，什么都没测。已还原 ${restored ? "SHA 一致" : "SHA 不一致！"}，停在这里。`,
    );
    console.log(out.slice(-2500));
    process.exit(5);
  }
  const killed = exit !== 0;
  const ok = m.control ? !killed : killed;
  const summary = killed
    ? `KILLED（红在：${wireOf(out)}）`
    : "SURVIVED（exit 0）";
  results.push(
    `${m.id}: ${summary} / 符合预期 ${ok ? "是" : "★否"} / 还原 ${restored ? "SHA 一致" : "SHA 不一致！"} / 该红的是：${m.expect}`,
  );
  if (!restored) {
    console.log(results.join("\n"));
    console.log(`⛔ 还原失败，停在这里人工核对：${GROUP}`);
    process.exit(2);
  }
  if (!ok) {
    console.log(`⚠ ${m.id} 与预期相反（${m.control ? "控制组却红了" : "剪线后仍绿 ⇒ 测试不承重"}），先记下，继续跑完拿完整证据。`);
    console.log(out.slice(-2500));
  }
}
console.log(results.join("\n"));
const unexpected = results.filter((r) => r.includes("★否")).length;
console.log(
  `合计：符合预期 ${results.length - unexpected}/${results.length}（其中控制组 2 发应当活），还原一致 ${results.length}/${results.length}`,
);
process.exit(unexpected === 0 ? 0 : 4);
