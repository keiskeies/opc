// 0080 变异机：待办「按群筛」逐根剪线 → 跑对应测试 → 立刻按 SHA 还原（自回滚）。
//
// 规矩沿用 round395：真抹字节；锚点恰好命中 1 次否则 SKIP；未变异预热必须绿；
// 每发无论红绿都还原并核 SHA；退非零但输出里没有测试计数 ⇒ INDETERMINATE 停机不猜。
//
// 尺子是 test("待办按群筛…") 一条 test + 0079 那份守卫（paint 形参一发归守卫）。
// 线号从 spec 的 `// 线 N（…）` 注释现推，不写死行号（round395 的教训：手写行号表
// 被格式化挪一行就整体错位）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const E2E = "test/e2e/group-workbench.spec.ts";
const GUARD = "test/web/list-filter-repaint.test.ts";

const e2e = (title) => ({
  cmd: "npx",
  args: ["playwright", "test", E2E, "-g", title, "--reporter=list"],
});
const guard = () => ({ cmd: "npx", args: ["vitest", "run", GUARD] });

// 群下拉的 onchange（含 paint 那一行，两行一起才是「这一维完整的一次动作」）。
const TODO_GROUP = [
  "          state.backlogFilter.group = event.target.value;",
  "          paintBacklogRows(content);",
].join("\n");
// paint 里群那一维的谓词两行。
const GROUP_CLAUSE = [
  "      (!state.backlogFilter.group ||",
  "        item.group_id === state.backlogFilter.group) &&",
].join("\n");

const MUTATIONS_ALL = [
  {
    id: "N1-group-clause-deleted",
    file: GROUP,
    from: GROUP_CLAUSE,
    to: "",
    ...e2e("待办按群筛"),
    // 缺陷本体（0080 之前的世界）：选群不参与筛选。
    expect: "线 1（选乙群该收到 0 条）",
  },
  {
    id: "N2-group-handler-self-recursion",
    file: GROUP,
    from: TODO_GROUP,
    to: "          state.backlogFilter.group = event.target.value;\n          renderBacklogList(content, toolbar);",
    ...e2e("待办按群筛"),
    // 0079 病根在下拉这一维的复发位：每换一次群多一套控件。
    expect: "线 6（换群动过之后控件仍各一枚）",
  },
  {
    id: "N3-group-change-wipes-keyword",
    file: GROUP,
    from: TODO_GROUP,
    to: "          state.backlogFilter.group = event.target.value;\n          state.backlogFilter.q = \"\";\n          paintBacklogRows(content);",
    ...e2e("待办按群筛"),
    // AND 变互相覆盖：换群把关键词格清空，7 条变 16 条。
    expect: "线 1（关键词与群 AND）",
  },
  {
    id: "N4-group-handler-full-repaint",
    file: GROUP,
    from: TODO_GROUP,
    to: "          state.backlogFilter.group = event.target.value;\n          renderList();",
    ...e2e("待办按群筛"),
    // 被否决的修法在下拉维的对应物：份数全对，只有节点同一性这一格红。
    expect: "线 2（换群不换掉正在用的搜索框）",
  },
  {
    id: "N5-aria-label-renamed",
    file: GROUP,
    from: '        "aria-label": "所属群",\n        onchange:',
    to: '        "aria-label": "待办群组",\n        onchange:',
    ...e2e("待办按群筛"),
    // 契约名被改：探针与用户都按「所属群」找这枚下拉，名字即界面契约。
    expect: "线 0（待办工具条有且只有一枚「所属群」下拉）",
  },
  {
    id: "N6-build-tail-paint-dropped",
    file: GROUP,
    from: "  );\n  paintBacklogRows(content);\n}",
    to: "  );\n}",
    ...e2e("待办按群筛"),
    // builder 构建末尾不画行 ⇒ 首屏就是空列表。
    expect: "线 0 之前的首屏断言（筛群待办15 在场）",
  },
  {
    id: "N7-paint-gets-toolbar",
    file: GROUP,
    from: "function paintBacklogRows(content) {",
    to: "function paintBacklogRows(content, toolbar) {",
    ...guard(),
    // 拆法守卫在待办侧的对应物（0079 的 M9 管文档侧）。
    expect: "守卫 it「行区重画拿不到工具条」",
  },
];
const MUTATIONS = process.env.ONLY
  ? MUTATIONS_ALL.filter(
      (m) => m.id.startsWith(`${process.env.ONLY}-`) || m.id === process.env.ONLY,
    )
  : MUTATIONS_ALL;
if (MUTATIONS.length === 0) {
  console.log(`⛔ ONLY=${process.env.ONLY} 一发行都没匹配到，拼错 id 了。`);
  process.exit(4);
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const OPTS = { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 };
const run = (m) => spawnSync(m.cmd, m.args, OPTS);

/** 线表从 spec 现推（区间 = 本线注释行到下一线注释前一行为止），同 round395。 */
function loadWires(specFile) {
  const lines = readFileSync(specFile, "utf8").split("\n");
  const declAt = lines.findIndex((l) => l.startsWith('test("待办按群筛'));
  if (declAt < 0) throw new Error("找不到「待办按群筛」那条用例的声明行，取材失败");
  const found = [];
  lines.forEach((l, i) => {
    if (i < declAt) return;
    const m = /^ *\/\/ 线 (\d+)（(.+?)）/u.exec(l);
    if (m) found.push([i + 1, `线 ${m[1]} ${m[2]}`]);
  });
  if (found.length < 8) {
    throw new Error(`线注释只认到 ${found.length} 条，取材失败（判据注释被改了吗？）`);
  }
  const wires = [];
  found.forEach(([at, name], i) => {
    const hi = i + 1 < found.length ? found[i + 1][0] - 1 : lines.length;
    wires.push([at, hi, name]);
  });
  const pre = [];
  for (let i = declAt + 1; i < found[0][0] - 1; i += 1) {
    if (/expect\(|toHaveCount\(/u.test(lines[i])) pre.push(i + 1);
  }
  if (pre.length === 0) throw new Error("首屏那几发断言找不到，取材失败");
  return [[[pre[0], pre[pre.length - 1], "线 0 之前的首屏断言"], ...wires], found.length];
}
const [WIRES, WIRE_COUNT] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释 + 首屏段，共 ${WIRES.length} 段。`);

function wireOf(out, m) {
  if (m.args.includes(GUARD)) {
// ANSI 先剥：vitest 给 ×、用例名、耗时分别上色；ESC 用转义写法的 ，直接写裸字节的 ESC 不会进来；
    // 整行锚定的发名正则一条也配不上（round395 的中文第一版就晕在这里）。
    const plain = out.replace(/\[[0-9;]*m/gu, "");
    const its = [
      ...new Set(
        [...plain.matchAll(/×\s*(.+?)\s+\d+ms\s*$/gmu)].map((x) =>
          String(x[1]).trim(),
        ),
      ),
    ];
    return its.length ? `守卫「${its.join(" + ")}」` : "（守卫红了但认不出发名）";
  }
  const lines = [
    ...new Set(
      [...out.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)].map((m2) =>
        Number(m2[1]),
      ),
    ),
  ].sort((a, b) => a - b);
  if (process.env.WIRE_DEBUG) {
    for (const l of out.split("\n")) {
      if (
        /group-workbench\.spec\.ts:\d+|Error:|Received|Expected|unexpected value/u.test(
          l,
        )
      )
        console.log(`  | ${l.trim().slice(0, 200)}`);
    }
  }
  const hit = new Set();
  for (const n of lines) {
    const w = WIRES.find(([lo, hi]) => n >= lo && n <= hi);
    if (w) hit.add(w[2]);
  }
  return hit.size ? [...hit].join(" + ") : `（未归类，实跑行号 ${lines.join(",")}）`;
}

const RAN_TESTS = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u;

// 预热：尺子在未变异上必须绿 + 锚点唯一，否则不动源码。
const warmed = new Set();
for (const m of MUTATIONS) {
  const key = `${m.cmd} ${m.args.join(" ")}`;
  if (!warmed.has(key)) {
    warmed.add(key);
    const r = run(m);
    const out = `${r.stdout}${r.stderr}`;
    if ((r.status ?? -1) !== 0 || /No tests found/iu.test(out)) {
      console.log(
        `⛔ 预热失败：${m.id} 的尺子在未变异上就不绿。\n${out.slice(-2000)}`,
      );
      process.exit(3);
    }
  }
  const src = readFileSync(m.file, "utf8");
  if (!src.includes(m.from) || src.split(m.from).length !== 2) {
    console.log(
      `⛔ 预热失败：${m.id} 的锚点命中 ${src.split(m.from).length - 1} 次（需要恰好 1 次），未动任何源码。`,
    );
    process.exit(3);
  }
}

const results = [];
for (const m of MUTATIONS) {
  const orig = readFileSync(m.file, "utf8");
  const before = sha(orig);
  writeFileSync(m.file, orig.replace(m.from, m.to), "utf8");
  const r = run(m);
  const exit = r.status ?? -1;
  writeFileSync(m.file, orig, "utf8");
  const after = sha(readFileSync(m.file, "utf8"));
  const restored = after === before;
  const out = `${r.stdout}${r.stderr}`;
  if (exit !== 0 && !RAN_TESTS.test(out)) {
    console.log(results.join("\n"));
    console.log(
      `⛔ ${m.id} 这一发退 ${exit} 但输出里没有任何测试计数 —— 多半是 runner 启动即错。已还原 ${restored ? "SHA 一致" : "SHA 不一致！"}，停在这里。`,
    );
    console.log(out.slice(-2000));
    process.exit(5);
  }
  const summary =
    exit === 0
      ? "SURVIVED（exit 0 ⇒ 测试不承重）"
      : `KILLED（exit ${exit}，红在：${wireOf(out, m)}）`;
  results.push(
    `${m.id}: ${summary} / 还原 ${restored ? "SHA 一致" : "SHA 不一致！"} / 预期红的是：${m.expect}`,
  );
  if (!restored) {
    console.log(results.join("\n"));
    console.log(`⛔ 还原失败，停在这里人工核对：${m.file}`);
    process.exit(2);
  }
  if (exit === 0) {
    console.log(`⚠ ${m.id} 剪线后仍绿 —— 测试不承重，先把这一记带回台账。`);
    console.log(out.slice(-2000));
  }
}
console.log(results.join("\n"));
console.log(
  `合计：killed ${results.filter((r) => r.includes("KILLED")).length}/${MUTATIONS.length}，还原一致 ${MUTATIONS.length}/${MUTATIONS.length}`,
);
