// 0079 变异机：逐根剪线 → 跑对应测试 → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round370 的形状）：
//  · 每根线用 replace 真抹掉 group.js 里的字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则 SKIP（坐标漂了先重钉）；
//  · 剪线后跑【该线对应的尺子】，红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；不一致就停下人来；
//  · 开工前每把 -g 尺子在【未变异】上空跑一次：必须绿才准开工。
//
// M1/M2/M3/M5 = 缺陷本体（handler 回调自己）；M4/M6 = 行区不清空；M7 = 工具条清空；
// M8 = 被否决的那个修法（整栏重画）—— 它的控件份数是对的，只有焦点/滚动会红，
// 所以它专测「份数判据之外那两根几何线」有没有自己的那次动作。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const E2E = "test/e2e/group-workbench.spec.ts";
const GUARD = "test/web/list-filter-repaint.test.ts";

/** e2e 尺子：真浏览器那一发（整份中栏筛选器用例）。 */
const e2e = (title) => ({
  cmd: "npx",
  args: ["playwright", "test", E2E, "-g", title, "--reporter=list"],
});
/** 源扫描 + vm 尺子：拆法本身。 */
const guard = () => ({
  cmd: "npx",
  args: ["vitest", "run", GUARD],
});

const DOC_Q = [
  "          state.docFilter.q = event.target.value;",
  "          paintDocumentRows(content);",
].join("\n");
const DOC_KIND = [
  "        state.docFilter.kind = event.target.value;",
  "        paintDocumentRows(content);",
].join("\n");
const DOC_GROUP = [
  "        state.docFilter.group = event.target.value;",
  "        paintDocumentRows(content);",
].join("\n");
const TODO_Q = [
  "        state.backlogFilter.q = event.target.value;",
  "        paintBacklogRows(content);",
].join("\n");

const MUTATIONS_ALL = [
  {
    id: "M1-doc-search-self-recursion",
    file: GROUP,
    from: DOC_Q,
    to: "          state.docFilter.q = event.target.value;\n          renderDocumentList(content, toolbar);",
    ...e2e("中栏筛选器"),
    // 缺陷本体第一处：搜索框敲一下就把自己再 append 一遍。
    expect: "线 1-4（控件不翻倍 / 列表不重复 / 焦点 / 空态只一份）",
  },
  {
    id: "M2-doc-kind-self-recursion",
    file: GROUP,
    from: DOC_KIND,
    to: "        state.docFilter.kind = event.target.value;\n        renderDocumentList(content, toolbar);",
    ...e2e("中栏筛选器"),
    expect: "线 6（形态下拉自己那一次动作）",
  },
  {
    id: "M3-doc-group-self-recursion",
    file: GROUP,
    from: DOC_GROUP,
    to: "        state.docFilter.group = event.target.value;\n        renderDocumentList(content, toolbar);",
    ...e2e("中栏筛选器"),
    expect: "线 7（所属群下拉 + 滚动留在原处）",
  },
  {
    id: "M4-doc-rows-never-cleared",
    file: GROUP,
    from: "  content.replaceChildren();\n  if (!filtered.length) {",
    to: "  if (!filtered.length) {",
    ...e2e("中栏筛选器"),
    expect: "线 2/4/5（树与空态的份数）",
  },
  {
    id: "M5-backlog-search-self-recursion",
    file: GROUP,
    from: TODO_Q,
    to: "        state.backlogFilter.q = event.target.value;\n        renderBacklogList(content, toolbar);",
    ...e2e("中栏筛选器"),
    expect: "线 9-11（待办那一头）",
  },
  {
    id: "M6-backlog-rows-never-cleared",
    file: GROUP,
    from: "  content.replaceChildren();\n  for (const item of items)",
    to: "  for (const item of items)",
    ...e2e("中栏筛选器"),
    expect: "线 9/11（待办行数与空态份数）",
  },
  {
    id: "M7-toolbar-never-cleared",
    file: GROUP,
    from: "  content.replaceChildren();\n  toolbar.replaceChildren();",
    to: "  content.replaceChildren();",
    ...e2e("中栏筛选器"),
    expect: "线 8（切栏一趟回来筛选栏仍是一份）",
  },
  {
    id: "M8-doc-search-full-repaint",
    file: GROUP,
    from: DOC_Q,
    to: "          state.docFilter.q = event.target.value;\n          renderList();",
    ...e2e("中栏筛选器"),
    // 被否决的修法：份数全对，只有【焦点】这一格红 ⇒ 证明线 3 不是线 1 的复读。
    expect: "线 3（焦点/取值留在同一枚输入框）",
  },
  {
    id: "M9-split-shape-guard",
    file: GROUP,
    from: "function paintDocumentRows(content) {",
    to: "function paintDocumentRows(content, toolbar) {",
    ...guard(),
    // paint 一旦能拿到工具条，「行区重画不碰控件」这条拆法就名存实亡。
    expect: "源扫描 it「行区重画拿不到工具条」",
  },
  {
    id: "M10-backlog-scroll-reset",
    file: GROUP,
    from: "  content.replaceChildren();\n  for (const item of items)",
    to: "  content.replaceChildren();\n  content.scrollTop = 0;\n  for (const item of items)",
    ...e2e("中栏筛选器"),
    // 线 10 自己的那次动作：继续敲字时行数一条没变，视口却被 paint 抹回顶部。
    // 这一发同时是自证 —— 新的滚动基线改成「等停下来再取」之后，真被抹零仍须红；
    // 若它活了，说明判定等过头把缺陷也一起等掉了。
    expect: "线 10（待办敲完滚动留在原处）",
  },
];
// 排查单发用：ONLY=M8 只跑那一发（预热仍会跑一遍对应尺子）。
const MUTATIONS = process.env.ONLY
  ? MUTATIONS_ALL.filter((m) => m.id.startsWith(`${process.env.ONLY}-`) || m.id === process.env.ONLY)
  : MUTATIONS_ALL;
if (MUTATIONS.length === 0) {
  console.log(`⛔ ONLY=${process.env.ONLY} 一发行都没匹配到，拼错 id 了。`);
  process.exit(4);
}

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const OPTS = { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 };
const run = (m) => spawnSync(m.cmd, m.args, OPTS);

/**
 * 失败行 → 线号：整份 e2e 是一条 test，所以「哪根线先红」只能按断言所在行归。
 *
 * ⚠ 表【从 spec 自己推】，不写死行号：线 N 的区间 = 它那句 `// 线 N（…）` 注释所在行，到下一条
 * 线注释的前一行为止；第一条线注释之前的算「线 0 首屏就是一份」。手写行号表在这一轮被
 * biome 一次格式化（±1）就整体错位过 —— 那种表一改判据就得重钉，而注释本来就是判据的一部分。
 */
function loadWires(specFile) {
  const lines = readFileSync(specFile, "utf8").split("\n");
  // 用例起点：整份 e2e 里只有这一条用例的标题带「中栏筛选器」。它的【声明行】是
  // runner 报错时的落点（page.goto / 建群那一段挂了也算它），不收进任何一根线 ——
  // 否则「环境错」会被读成某根份数判据红了。
  const declAt = lines.findIndex((l) => l.startsWith('test("中栏筛选器'));
  if (declAt < 0) throw new Error("找不到「中栏筛选器」那条用例的声明行，取材失败");
  const found = [];
  lines.forEach((l, i) => {
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
  // 线 0 = 用例体内、第一条线注释之前的那些【断言行】（首屏 trees/search 各一发
  // toHaveCount + 灌数据的状态码）。刻意只认 expect( 那一类行、且只在用例体内认：
  // 早先版本从文件头扫起，区间一路吞到 3324，于是每一次红都额外报一根「线 0」。
  const pre = [];
  for (let i = declAt + 1; i < found[0][0] - 1; i += 1) {
    if (/expect\(/u.test(lines[i])) pre.push(i + 1);
  }
  if (pre.length === 0) throw new Error("首屏那几发断言找不到，取材失败");
  return [[[pre[0], pre[pre.length - 1], "线 0 首屏就是一份"], ...wires], found.length];
}
const [WIRES, WIRE_COUNT] = loadWires(E2E);
console.log(`线表从 spec 现推：${WIRE_COUNT} 条线注释 + 线 0，共 ${WIRES.length} 段。`);
/**
 * 失败行 → 线号。
 *
 * e2e 那一族是一条 test，所以「哪根线先红」只能按断言所在行归（区间表见 loadWires）。
 * 守卫那一族（尺子是 vitest）没有 spec 行号可归 ⇒ 认 vitest 打的失败用例名，
 * 别把它糊成「未归类」—— 那一格报的应当是【哪一发 it 红了】。
 */
function wireOf(out, m) {
  if (m.args.includes(GUARD)) {
    // ANSI 先剥：vitest 给 ×、用例名、耗时分别上色，颜色码混在中间时按整行锚定的正则一条也配不上
    // （本轮第一版就栽在这里，报成「认不出发名」）。
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
  const lines = [...new Set([...out.matchAll(/group-workbench\.spec\.ts:(\d+)/gu)].map((m2) => Number(m2[1])))].sort((a, b) => a - b);
  if (process.env.WIRE_DEBUG) {
    for (const l of out.split("\n")) {
      if (/group-workbench\.spec\.ts:\d+|Error:|^\s*[-+] |^\s*expect\(|Received|Expected/u.test(l)) {
        console.log(`  | ${l.trim().slice(0, 200)}`);
      }
    }
  }
  const hit = new Set();
  for (const n of lines) {
    const w = WIRES.find(([lo, hi]) => n >= lo && n <= hi);
    if (w) hit.add(w[2]);
  }
  return hit.size ? [...hit].join(" + ") : `（未归类，实跑行号 ${lines.join(",")}）`;
}

/**
 * 这一发有没有【真跑过测试】。
 *
 * 预热只证明过一次环境好；后面某一发仍可能撞上「启动即错」（本轮踩过：runner 参数写错
 * 也退非零，那一发什么都没测）。那一发记成 KILLED 就是假证据 ⇒ 认不出测试计数就判
 * INDETERMINATE 并停机，不猜。
 */
const RAN_TESTS = /\d+\s+(?:passed|failed|skipped)|\d+ tests?/u;
function lookedLikeTestRun(out) {
  return RAN_TESTS.test(out);
}

// 预热：未变异必须先绿。-g 里的中文过 argv 可能被烤坏（0 匹配也退非零），
// 以及锚点必须仍在场且唯一 —— 任一不成立都不动源码。
// e2e 那一族八把尺子是同一条 -g，跑一次就够（一次真浏览器 + hub 起停约 20s）。
const warmed = new Set();
for (const m of MUTATIONS) {
  const key = `${m.cmd} ${m.args.join(" ")}`;
  if (!warmed.has(key)) {
    warmed.add(key);
    const r = run(m);
    const out = `${r.stdout}${r.stderr}`;
    if ((r.status ?? -1) !== 0 || /No tests found/iu.test(out)) {
      console.log(
        `⛔ 预热失败：${m.id} 的尺子在未变异上就不绿（0 匹配或环境错），未动任何源码。\n${out.slice(-2000)}`,
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
  if (exit !== 0 && !lookedLikeTestRun(out)) {
    console.log(results.join("\n"));
    console.log(
      `⛔ ${m.id} 这一发退 ${exit} 但输出里没有任何测试计数 —— 多半是 runner 启动即错，什么都没测。已还原 ${restored ? "SHA 一致" : "SHA 不一致！"}，停在这里。`,
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
    // 不中止：把剩下几发也跑完，一次拿到完整证据（每发自己已按 SHA 还原）。
    console.log(`⚠ ${m.id} 剪线后仍绿 —— 测试不承重，先把这一记带回台账。`);
    console.log(out.slice(-2000));
  }
}
console.log(results.join("\n"));
console.log(
  `合计：killed ${results.filter((r) => r.includes("KILLED")).length}/${MUTATIONS.length}，还原一致 ${MUTATIONS.length}/${MUTATIONS.length}`,
);
