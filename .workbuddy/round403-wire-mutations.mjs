// 0084 变异机：逐根剪掉「搜索按面筛」的接线 → 跑那一条 e2e → 立刻按 SHA 还原（自回滚）。
//
// 规矩（沿用 round402 的形状）：
//  · 每根线用 replace 真抹掉字节，不许只改注释；
//  · 锚点必须恰好命中 1 次，否则预热阶段就停机；
//  · 剪线后跑尺子（那一条 e2e），红 = KILLED，绿 = SURVIVED（测试不承重）；
//  · 无论红绿都先还原，再核对 SHA 与剪线前一致；
//  · 开工前先在【未变异】上跑一次：必须绿才准开工；
//  · 退非零但输出里没有任何测试计数 ⇒ 那一发什么都没测，判 INDETERMINATE 并停机。
//
// 与 round402 多出来的一件事：剪线对象不止 group.js。本轮的判据跨三个文件（渲染 group.js、
// 结构 group.html、服务端 service.ts），只剪一侧的话另一侧会替它代打 —— 所以每发自己点名文件。
//
// M1…M12 = 本轮接线的每一根线各一发，expect 写「预期红在哪条线」，判据须与该根动作有因果。
// C1 = 控制组（加载中文案）：它【应当】活下来 —— 判据只认请求与结构不认提示语，
// 用来让「判据恒红」当场露出来。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GROUP = "packages/web/public/group.js";
const HTML = "packages/web/public/group.html";
const SERVICE = "packages/hub/src/search/service.ts";
const E2E = "test/e2e/group-workbench.spec.ts";
const TITLE = "全局搜索筛选条";

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

// 建格的门槛：条件为真才 replaceChildren（不建 = 筛选条压根不出现；恒真 = 每勾一次重建整排）。
const CHIP_BUILD = "  if (box.childElementCount !== faces.length)";
// 空查询收起整块那一发（closeMenus 里也有一句同名赋值，靠下一行的 return 定唯一）。
const EMPTY_QUERY_HIDE =
  '    $("#searchPanel").hidden = true;\n    return;';
// 芯片由 faceLabels 的键生成 ⇒ 键漂移 = 少一枚。锚点必须带 `const faceLabels = {` 起头：
// `backlog: "待办",` 在别处（导航标签表）还有一份一模一样的，单抄那一行会命中 2 次。
// ⚠ to 要连着那行的逗号与换行一起抹：只抹 `backlog: "待办"` 会留下孤零零的 `,`，
// 那是语法错 —— 红会红在「模块解析不了、建群弹窗永远不出现」的超时上，因果就错了。
const FACE_LABELS =
  'const faceLabels = {\n  group: "群",\n  task: "任务",\n  member: "成员",\n' +
  '  message: "消息",\n  document: "文档",\n  meeting: "会议",\n  backlog: "待办",\n';
const FACE_LABELS_NO_BACKLOG = FACE_LABELS.replace('  backlog: "待办",\n', "");
// 结构那一发：给外壳挂 role="listbox"（芯片于是人人都带一个 listbox 祖先）。
// ⚠ 刻意不选「把 #searchFaces 整块搬进 #searchResults」：那一发红不到线 1 —— globalSearch 里
// renderSearchFaces() 之后紧跟 resultBox.replaceChildren()，搬进去的芯片会被这次重建一起抹掉，
// 线 0 的计数先红。两种坏法都被拦，但拦下它的是线 0，别把这条记成线 1 的目击者。
const HTML_PANEL_OPEN =
  '      <div id="searchPanel" class="search-panel popover" hidden>';
const HTML_PANEL_OPEN_AS_LISTBOX =
  '      <div id="searchPanel" class="search-panel popover" role="listbox" hidden>';

const MUTATIONS = [
  {
    id: "M1-筛选条压根不建格",
    file: GROUP,
    from: CHIP_BUILD,
    to: "  if (box.childElementCount === faces.length)",
    expect: "线 0（七枚芯片各一次）计数 0",
  },
  {
    id: "M2-faceLabels 少一面（待办）",
    file: GROUP,
    from: FACE_LABELS,
    to: FACE_LABELS_NO_BACKLOG,
    expect: "线 0（第七枚是「待办」）；芯片由 faceLabels 生成 ⇒ 键漂移当场少一枚",
  },
  {
    id: "M3-芯片挂进 role=listbox 那一层（js 侧）",
    file: GROUP,
    from: '  const box = $("#searchFaces");',
    to: '  const box = $("#searchResults");',
    expect: "线 0 之后立刻撞线 1（#searchFaces 里没有芯片 ⇒ 线 0 计数先红）",
  },
  {
    id: "M4-勾选永远不上 faces",
    file: GROUP,
    from:
      "  const picked = all.filter((face) => state.searchFaces.has(face));\n" +
      "  return picked.length === 0 || picked.length === all.length ? [] : picked;",
    to: "  return [];",
    expect: "线 2（勾剩两面 ⇒ 请求带 faces=message,backlog）",
  },
  {
    id: "M5-全集也照发 faces（把七面抄第二份）",
    file: GROUP,
    from:
      "  const picked = all.filter((face) => state.searchFaces.has(face));\n" +
      "  return picked.length === 0 || picked.length === all.length ? [] : picked;",
    to: "  return all.filter((face) => state.searchFaces.has(face));",
    expect: "线 0（未筛时请求不该带 faces）；全集 = 服务端缺省，多发一份抄本",
  },
  {
    id: "M6-全不勾就停在一片灰上",
    file: GROUP,
    from:
      "  if (state.searchFaces.size === 0)\n" +
      "    state.searchFaces = new Set(Object.keys(faceLabels));\n",
    to: "",
    expect: "线 5（点掉最后一枚 = 全要，七枚回到按下）；这是该动作唯一的目击者",
  },
  {
    id: "M7-空查询只收结果列表不收筛选条",
    file: GROUP,
    from: EMPTY_QUERY_HIDE,
    to: '    $("#searchResults").hidden = true;\n    return;',
    expect: "线 6（空查询把整块收起来）",
  },
  {
    id: "M8-勾选后不重跑搜索",
    file: GROUP,
    from:
      "  renderSearchFaces();\n" +
      '  globalSearch($("#globalSearch").value);\n',
    to: "  renderSearchFaces();\n",
    expect: "线 2（芯片亮了但没发请求）",
  },
  {
    id: "M9-每次勾选整排重建（焦点被抹）",
    file: GROUP,
    from: CHIP_BUILD,
    to: "  if (true)",
    expect: "线 2（刚点中的那枚仍持有焦点）",
  },
  {
    id: "M10-结构：外壳也挂 role=listbox",
    file: HTML,
    from: HTML_PANEL_OPEN,
    to: HTML_PANEL_OPEN_AS_LISTBOX,
    expect: "线 1（芯片不许有 listbox 祖先）；这是线 1 唯一的目击者",
  },
  {
    id: "M11-勾选只减不加（勾不回来）",
    file: GROUP,
    from:
      "  if (state.searchFaces.has(face)) state.searchFaces.delete(face);\n" +
      "  else state.searchFaces.add(face);",
    to: "  state.searchFaces.delete(face);",
    expect: "线 4（把「群」勾回来 ⇒ 又看得见那一面）；这是线 4 唯一的目击者",
  },
  {
    id: "M12-服务端收了 faces 却不按面取数",
    file: SERVICE,
    from: "  const selected = new Set(query.faces ?? SEARCH_FACES);",
    to: "  const selected = new Set(SEARCH_FACES);",
    expect: "线 3（勾掉群 ⇒ 列表里真没有群那一面）；这是线 3 唯一的目击者",
  },
  {
    id: "C1-控制组：加载中文案改掉（应当存活）",
    file: GROUP,
    from: 'resultBox.replaceChildren(loadingState("正在全平台搜索…"));',
    to: 'resultBox.replaceChildren(loadingState("正在搜遍七面…"));',
    expect: "无（范围声明：判据不认加载文案）",
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
  // 声明行那一枚要剔掉：list reporter 的 `ok 1 …spec.ts:4189:1 › 标题` 里也带行号，
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

const files = [GROUP, HTML, SERVICE];
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
  console.log(
    `${r.verdict.padEnd(22)} ${r.id.padEnd(32)} 实红在：${r.which}`,
  );
}
// 每根线要有【只属于它】的目击者：某发全局清扫（比如把整块摘掉）会替没有自己判据的线代打，
// 12/12 全红也可能漏掉一根从没被单独剪过的线。所以这里按「实红在」逐线点名。
const killedByWire = new Map();
for (const r of rows) {
  if (r.verdict !== "KILLED") continue;
  for (const [lo, hi, name] of WIRES) {
    if (r.which.includes(name)) {
      if (!killedByWire.has(name)) killedByWire.set(name, []);
      killedByWire.get(name).push(r.id);
    }
  }
}
console.log("\n=== 逐线点名（谁替这根线代打） ===");
for (const [, , name] of WIRES) {
  const ids = killedByWire.get(name) ?? [];
  console.log(`${ids.length ? "✓" : "✗ 无人剪过"} ${name} ← ${ids.join(" / ") || "无"}`);
}
const realSurvived = rows.filter((r) => r.verdict === "SURVIVED").length;
const unwatched = WIRES.filter(([, , name]) => !killedByWire.has(name)).length;
console.log(`\n剪线 ${rows.length} 根（含 1 根控制组）：真线存活 ${realSurvived}，无目击者的线 ${unwatched}`);
console.log(
  realSurvived === 0 && unwatched === 0
    ? "✅ 真实接线全部被杀，且每根线各自有目击者"
    : `⚠ 存活 ${realSurvived} 根 / 无人剪过的线 ${unwatched} 根 ⇒ 判据不承重，别提交`,
);
