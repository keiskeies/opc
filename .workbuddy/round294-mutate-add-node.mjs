/**
 * round294 · 「契约里那条带判据的 add_node」这一族守卫有没有牙齿。
 *
 * 跑法：node .workbuddy/round294-mutate-add-node.mjs
 * 【单独跑】，不与任何测试并发（它会临时改生产字节）。
 *
 * 打的是【生产代码】，测试一个字都不改。每一发抹掉一处真实实现，跑那四份测试，逐字节还原。
 *
 * ── 这一台比 round292 那一台多一件事：逐文件归因 ──────────────────────
 * 那一台只数「红了几发」。这一台还记【哪几份文件红】，因为本轮有三发的价值恰恰在
 * 「谁红、谁【不该】红」：
 *  · M4/M5 只该红在 test/org/validate.test.ts（单测），端到端那一份【不该红】——
 *    那说明「多种坏形状」这一族里，有的格子只有单测在看。这不算缺陷，但它必须被
 *    量出来：不量就会以为那发验收测试覆盖面比它实际的大。
 *  · M8（分派那一支摘掉）只该红在端到端那一份 ⇒ 反过来证「单测不经过 revalidate」，
 *    它与 M4/M5 是同一格的两面。
 *  · M1/M2/M7 还要红在 test/arch/claims-registry.test.ts —— 那才是 r22 那条【判据】
 *    自己的牙齿：生产字节一改，主张链当场不成立。
 *
 * ── 两发【该绿】，各自证一句「注释里说过的话」────────────────────────
 *  · M6 把 `depthOf(parent) + 1` 换成照抄 reparent 那句 `heightBelow`。
 *    validateNewNode 的函数头写着「照抄 heightBelow 今天会得到同一个数」——
 *    那句话今天是【断言】还是【量过的结论】？这一发把它变成后者：绿 = 那句话真等价，
 *    而它同时说明「用 depthOf+1」不是可靠的原因（原因是那条判据在判深度本身）。
 *  · M3b 把重名理由里那句「走 reparent」的指路文案换掉。判据照拦，只是少一句人话 ⇒
 *    【该绿】。留着它是为了钉「本组测的是拦不拦，不是文案」——M3b 与 M3 是一对：
 *    M3 红（摘掉判据），M3b 绿（改文案）。只跑 M3 的话，「红」可能来自任何一处文本改动。
 *
 * ⚠ 四条纪律（前几轮那几台机器各自撞过的坑，逐条带着）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推 —— 有些 `to` 是 `orig` 的子串；
 *  ② 还原在 finally 里，且在【校验之前】—— 否则 throw 会把变异永久留在文件里；
 *  ③ 所有锚点在第一发跑【之前】全部验一遍（plan()）—— round291 的 M2 锚点是格式化前的
 *     旧形状，那一发【从来没跑过】而没人发现；
 *  ④ 读 vitest 输出【必须先剥 ANSI】，且「读不到摘要行」必须【抛】而不是当 0 ——
 *     round292 那台第一版两个都中了，于是 M1~M6 全部读成「红发=0」。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 变异打的测试：单测 + 提交路径 + 端到端 + r22 那条判据自己的那发。 */
const TEST_FILES = [
  "test/org/validate.test.ts",
  "test/org/versioning.test.ts",
  "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts",
  "test/arch/claims-registry.test.ts",
];
const UNIT = "test/org/validate.test.ts";
const E2E = "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts";
const CRIT = "test/arch/claims-registry.test.ts";

const COMMIT = "packages/hub/src/org/commit.ts";
const VALIDATE = "packages/contracts/src/org/validate.ts";

const results = [];
/** @type {{rel:string,from:string,to:string,label:string,expectRed:boolean,mustRed:string[],mustGreen:string[],note:string}[]} */
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, mustRed, mustGreen, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, mustRed, mustGreen, note });
}

/* ── M1：分派那一根线断了（判据还在，没人调）──────────────────────────── */
mutate(
  COMMIT,
  "    one = validateNewNode(change.node, graph);",
  "    one = { ok: true };",
  "M1 revalidate 不再调 validateNewNode（只剩一条注释说它走了 L1）",
  true,
  [E2E, CRIT],
  [UNIT],
  "坏形状该全部放行变 200；r22 的判据也该红（它判的就是【剥掉注释后有没有这个调用】）。" +
    "单测【不该红】：它直接调 validateNewNode，不经过 revalidate",
);

/* ── M2：校验放行而图不变 ───────────────────────────────────────────── */
mutate(
  COMMIT,
  "    nodes[change.node.role_id] = change.node;",
  "    void change.node;",
  "M2 applyChangeToGraph 收下节点而不写进 nodes",
  true,
  [E2E, CRIT],
  [UNIT],
  "比缺校验更坏的一种：审计里的 after 快照与库里那张图分家 ⇒ 端到端与判据都该红；" +
    "单测不经过 applyChangeToGraph ⇒ 不该红",
);

/* ── M3：摘掉重名那一判 ─────────────────────────────────────────────── */
mutate(
  VALIDATE,
  "  if (nodeOf(org, roleId) !== undefined) {",
  "  if (false && nodeOf(org, roleId) !== undefined) {",
  "M3 重名那一判整条短路掉",
  true,
  [UNIT, E2E],
  [],
  "同名提交变成静默覆盖；「重名抢在自环之前」那一发也该红（它靠这两判的【顺序】）",
);

/* ── M3b：只改重名理由里的指路文案 —— 预期【绿】 ────────────────────────
 * 与 M3 成对：M3 摘判据 ⇒ 红，M3b 改文案 ⇒ 绿。只跑 M3 的话，那条红可能来自
 * 任何一次文本改动，就分不清「判据被摘」与「这句话被改写」。
 * ⚠ 锚点与替换串都是【实测过】的：test/org/validate.test.ts:227 断言
 * `reason` 含 "reparent"（那条「reason 要指路」是我本轮自己写的），所以替换串
 * 必须【保留】那个词，否则这一发会变红而红因是文案 —— 我第一版正是这么写的，
 * 于是这台机器差点把「我确实测了文案」记成「我没测文案」。
 * ⇒ 真正被量出来的结论是：这一族的【指路关键词】有人钉，其余句子没人钉。 */
mutate(
  VALIDATE,
  '        "要改它的汇报关系走 reparent，要改别的就直接提交新图。",',
  '        "要动它的汇报关系请走 reparent；要动别的请直接交一张新图。",',
  "M3b 重名理由里的措辞换掉（保留 reparent，该绿）",
  false,
  [],
  [],
  "判据仍拦、code 不变、指路关键词还在 ⇒ 全组该绿。" +
    "红了说明有断言在钉【措辞】而不是【判决】——那要先问那句断言值不值得留",
);

/* ── M4：摘掉自环那一判 ─────────────────────────────────────────────── */
mutate(
  VALIDATE,
  "  if (node.reports_to === roleId) {",
  "  if (false && node.reports_to === roleId) {",
  "M4 自环那一判短路掉",
  true,
  [UNIT, E2E],
  [],
  "自环会退化成一句「上级 [x] 不在图里」而 x 就是他自己。" +
    "⚠ 我原本写的是「端到端不该红，它没对自环单独断 code」—— 【实测否证】：" +
    "那发矩阵逐条断 code，自环那一发断的正是 would_create_cycle ⇒ 端到端也红。" +
    "写矩阵前先读矩阵，别按印象登记谁红谁不红",
);

/* ── M5：森林那一判从「加完多于一个根」改成「是根就拒」──────────────── */
mutate(
  VALIDATE,
  "    if (existingRoots > 0) {",
  "    if (true) {",
  "M5 森林判据改成「它是根就拒」（丢掉空图例外）",
  true,
  [UNIT],
  [E2E],
  "该红在 test/org 那发反向 canary（往空图加第一个节点必须成功）——" +
    "少了那一发，这条判据会被读成「永远拒根」而没人发现。" +
    "端到端【不该红】：它那条矩阵里 多出一个根 那一发照样拿 multiple_roots，" +
    "而【空图】那一格端到端没有 ⇒ 「第一格永远加不进去」这句话只有单测在看",
);

/* ── M6：照抄 reparent 那句 heightBelow —— 预期【绿】，变异等价 ─────────
 * 新节点在 org.nodes 里还没有下级 ⇒ heightBelow(org, 新id) 恒为 1 ⇒ 与 +1 恒同解。
 * 把这条记成【量过的结论】：函数头那句「照抄会得到同一个数」今天成立。
 * 哪天新节点可以带着一支进来（比如 add_subtree），这一发会翻红，
 * 那时"+1"才开始承重。 */
mutate(
  VALIDATE,
  "  const newDepth = depthOf(org, node.reports_to) + 1;",
  "  const newDepth = depthOf(org, node.reports_to) + heightBelow(org, roleId);",
  "M6 深度那一判照抄 reparent 的 heightBelow（变异等价，该绿）",
  false,
  [],
  [],
  "绿 = 函数头那句「照抄同一个数」是真话；红 = 它已经过期，那条注释要改口",
);

/* ── M7：让 validateNewNode 也判 model_family（分工漂向重叠）────────── */
mutate(
  VALIDATE,
  "  const roleId = node.role_id;",
  '  const roleId = node.role_id;\n' +
    '  if (node.model_family === undefined) {\n' +
    '    return reject("unknown_model_family", "新节点必须声明家族");\n' +
    "  }",
  "M7 在 validateNewNode 里也判一遍 model_family（同一件事两处口径）",
  true,
  [UNIT, CRIT],
  [],
  "该红两处：test/org 那发「与 model_family 不重叠」（单测直接看到行为变化）+ " +
    "r22 的判据（它判的就是那段【代码】里不许出现 model_family）。" +
    "端到端那一份【不该红】—— 它的反向 canary 只断 code，而 code 恰好同值 ⇒ " +
    "这正是本轮把这一格交给 r22 而不是交给那发测试的理由",
);

/* ── M8：分派那一支整个摘掉（add_node 落到兜底抛）─────────────────────
 * 与 M4/M5 互为反面：那一族是「单测红、端到端不红」，这一发是「端到端红、单测不红」，
 * 因为 validateNewNode 本身没变，变的是 revalidate 有没有把它接上。
 * 顺带：这一发会让 `tsc` 红（`noUntouchedKind(change)` 的参数位上不再收窄成 never）——
 * 那是【编译期那道兜底】在响，属预期，不是这台机器的故障。 */
mutate(
  COMMIT,
  '  } else if (change.kind === "add_node") {',
  '  } else if (false && change.kind === "add_node") {',
  "M8 revalidate 的分派里把 add_node 那一支短路掉",
  true,
  [E2E, CRIT],
  [UNIT],
  "新节点提交会走到 noUntouchedKind 而抛；单测不该红（它不经 revalidate）⇒ " +
    "这一行就是「端到端与单测各守一半」的证据。" +
    "⭐ 这一发【逼出了判据的一格】：判据那一版只查【调用在不在】，而那份文件里调用字节【还在】" +
    "⇒ 端到端红而 r22 不红。现在它多判一条「分派条件本身要真」，于是 CRIT 也红了 —— " +
    "这台机器给判据本身补了一颗牙齿，这是它本轮最实在的产出",
);

/* ── 锚点先全部验一遍，再跑第一发 ───────────────────────────────────── */
function plan() {
  const originals = new Map();
  const bad = [];
  for (const m of MUTATIONS) {
    const text = originals.get(m.rel) ?? readFileSync(join(ROOT, m.rel), "utf8");
    originals.set(m.rel, text);
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) {
      bad.push(m.rel + " :: [" + m.label + "] 锚点命中 " + hits + " 次（要恰好 1 次）");
    }
    if (m.to === m.from) bad.push(m.rel + " :: [" + m.label + "] to 与 from 相同 = 空变异");
  }
  if (bad.length > 0) {
    console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
    process.exit(1);
  }
  return originals;
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了哪几份文件」。
 * 剥 ANSI 与「读不到摘要就抛」两条纪律的出处写在文件头 ④。
 */
function readSummary(out) {
  // ⚠ 剥 ANSI 用的是 new RegExp + 双反斜杠，不写字面 ESC 字节：
  //   round292 那台第一版写成 /\[[0-9;]*m/（漏了 ESC 本身），汇总行前那个 0x1b 一直在
  //   ⇒ 报「读不到汇总行」，看起来像被测对象的错。源码里放一个不可见字节同样会被下一个人
  //   "顺手清理"掉，所以这里把 ESC 写成可见的转义序列。
  const clean = out.replace(new RegExp("\u001b\[[0-9;]*m", "g"), "");
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到 vitest 的「Tests」摘要行 —— 输出格式变了或被别的输出污染了。" +
        "【不能】当 0 处理：那会把红读成绿，整张矩阵会假绿。摘要尾部：\n" +
        clean.slice(-800),
    );
  }
  const seg = m[1] ?? "";
  // round301 补 · 格①：Tests 行里【一个数字都没有】。真 vitest 在「整份文件装载
  // 失败、一个用例都没跑到」时把 Tests 行打成 `      Tests  no tests`（实测
  // .workbuddy/probe301-loadfail-raw.txt），而旧写法把「读不到 failed」当 0 ⇒
  // 控制组（应绿）在【一个用例都没跑】的前提下判命中。
  // 判「无数字」而不是判「数字为 0」：真绿屏是「failed 缺失 + N passed」，有数字
  // ⇒ 不误伤（自证戊钉这条不对称）。
  if (!/\d/u.test(seg)) {
    throw new Error(
      "「Tests」摘要行里【一个数字都没有】（实得：" + seg.trim() + "）—— 这一型是" +
        "「一个用例都没跑到」（装载/采集失败），不是「全部通过」。【不能】当 0。尾部：\n" +
        clean.slice(-800),
    );
  }
  const failed = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
  const passed = Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]);
  // round301 补 · 格②：Test Files 行红而用例级 0 红。本机有【文件归因】，所以
  // 「死一份、其余照跑」会被读成「files 里多了一份而红发=0」⇒ M0 控制组判
  // 【未命中】、应红的发也判【未命中】—— 它 exit 1（所以不算假绿），但红话说的是
  // 「该红的文件没红」，那是【归因错了的假原因】。装载失败必须当场抛，不能让人
  // 照着假原因去改判据。
  const tf = clean.match(/^\s*Test Files\s+(.+)$/m);
  if (tf === null) {
    throw new Error(
      "读不到「Test Files」摘要行，不许当 0。尾部：\n" + clean.slice(-400),
    );
  }
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && failed === 0) {
    throw new Error(
      "Test Files 红了 " + failedFiles + " 份而用例级【一条红都没有】⇒ 装载/采集期失败，" +
        "不是判据红。此时逐文件归因给的是假原因（红话会怪到判据头上），两种读数都不许采信。" +
        "尾部：\n" + clean.slice(-800),
    );
  }
  // 红了哪几份文件：FAIL 行的第一个字段就是文件路径（相对仓库根、posix 分隔）。
  const files = new Set();
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm !== null && fm[1] !== undefined) files.add(fm[1].split("\\").join("/"));
  }
  return { failed, passed, files };
}

function run(label, expectRed, mustRed, mustGreen, note) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...TEST_FILES],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  const { failed, passed, files } = readSummary(out);
  const red = failed > 0;
  const problems = [];
  if (red !== expectRed) {
    problems.push("红/绿与预期不符（应" + (expectRed ? "红" : "绿") + "，实得红发=" + failed + "）");
  }
  for (const f of mustRed) {
    if (!files.has(f)) problems.push("该红的文件没红：" + f);
  }
  for (const f of mustGreen) {
    if (files.has(f)) problems.push("不该红的文件红了：" + f);
  }
  if (!expectRed && files.size > 0) {
    problems.push("应全绿，但红了 " + files.size + " 份：" + [...files].join(", "));
  }
  const hit = problems.length === 0;
  const state = "红发=" + failed + " 绿发=" + passed + " 红文件=" + (files.size === 0 ? "无" : [...files].join(","));
  results.push([hit, label, expectRed ? "应红" : "应绿", state, problems.join("；"), note]);
  console.log(
    (hit ? "  命中    " : "  未命中  ") + label + "  [" + (expectRed ? "应红" : "应绿") + "]  " + state,
  );
  for (const p of problems) console.log("            ↳ " + p);
}

function execute(m, originals) {
  const p = join(ROOT, m.rel);
  const orig = originals.get(m.rel);
  writeFileSync(p, orig.replace(m.from, m.to));
  let restored = false;
  try {
    run(m.label, m.expectRed, m.mustRed, m.mustGreen, m.note);
  } finally {
    writeFileSync(p, orig);
    restored = readFileSync(p, "utf8") === orig;
  }
  if (!restored) throw new Error("还原后字节不一致，必须手工修：" + m.rel);
}

const originals = plan();

/**
 * 这台机器自己的反向 canary：喂 readSummary 两段【合成的】vitest 输出，
 * 一段绿、一段红（红那段带 FAIL 行），并要求它数出「0 failed」与「>0 failed + 那两份文件」。
 *
 * 为什么需要它：本台的【逐文件归因】是这一台新加的能力，而它的价值全在
 * 「哪些文件红」这个读数上。round292 那台把红读成绿过一次（漏剥 ANSI），
 * 那时 expectRed:true 的几发全部判成未命中 —— 发现得了。但反过来，
 * 如果归因那个正则有毛病、【恒数出 0 份文件】，那 mustRed 的每一发都会红着报错，
 * 而 mustGreen 的每一发【恒成立】—— 一个恒空的集合让"不该红"这句话变成废话。
 * 所以这里当场喂一份"红了两份文件"的合成输出，逼它数出那两份的名字。
 */
function selfCheckParser() {
  const esc = String.fromCharCode(27);
  const green =
    " ✓ test/org/validate.test.ts (57 tests)\n" +
    esc +
    "[2m Test Files esc[22m esc[1mesc[32m4 passed (4)esc[39mesc[22m\n  " +
    esc +
    "[2m      Tests esc[22m esc[1mesc[32m95 passed (95)esc[39mesc[22m\n";
  const red =
    " FAIL  test/org/validate.test.ts > L1 validateNewNode > 重名\n" +
    " FAIL  packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts > 证据④\n" +
    esc +
    "[2m Test Files esc[22m esc[1mesc[31m2 failed | 2 passed (4)esc[39mesc[22m\n  " +
    esc +
    "[2m      Tests esc[22m esc[1mesc[31m3 failed | 92 passed (95)esc[39mesc[22m\n";
  const g = readSummary(green.split("esc").join(esc));
  const r = readSummary(red.split("esc").join(esc));
  const bad = [];
  if (g.failed !== 0 || g.files.size !== 0) bad.push("绿样本读成 红发=" + g.failed + " 红文件=" + g.files.size);
  if (r.failed <= 0) bad.push("红样本读成 0 红发（这台机器会把红读成绿）");
  if (!r.files.has(UNIT)) bad.push("红样本里认不出 " + UNIT);
  if (!r.files.has(E2E)) bad.push("红样本里认不出 " + E2E);
  // round301 补：两型装载失败【必须抛】（与 readSummary 里那两格一一对应）。
  // 为什么分开两发而不是一发：丙（`no tests`）两格都能拦，丁（有数字）只有格②能拦
  // —— 合成一发的话，摘掉格② 时丙照样拦得住 ⇒ 那一格看起来像没被用到（假未命中）。
  const loadFail =
    " FAIL  " + UNIT + " [ " + UNIT + " ]\nError: Transform failed with 1 error:\n" +
    esc + "[2m Test Files esc[22m esc[1mesc[31m1 failed esc[39m esc[90m(1)esc[39m\n  " +
    esc + "[2m      Tests esc[22m esc[2mno testsesc[22m\n";
  const partial =
    " FAIL  " + E2E + " [ " + E2E + " ]\n" +
    esc + "[2m Test Files esc[22m esc[1mesc[31m1 failed | 3 passed esc[39m esc[90m(4)esc[39m\n  " +
    esc + "[2m      Tests esc[22m esc[1mesc[32m242 passed esc[39m esc[90m(242)esc[39m\n";
  for (const [name, text] of [
    ["丙（no tests）", loadFail],
    ["丁（死一份其余照跑）", partial],
  ]) {
    try {
      const s = readSummary(text.split("esc").join(esc));
      bad.push(
        name + "【没抛】—— 读成 红发=" + s.failed + " 红文件=" + s.files.size +
          "，控制组会在什么都没跑上判命中",
      );
    } catch {
      // 这就是要求的形状。
    }
  }
  if (bad.length > 0) {
    throw new Error("这台机器自己的读数不可信，【一发都没跑】：\n  " + bad.join("\n  "));
  }
  console.log("  读数自证  合成绿/合成红各读对（红文件归因认得出那两份路径）");
}
selfCheckParser();

run("M0 控制组：一字不改", false, [], [], "绿是后面每一发红的前提；同时自证这台读得出红与绿");
for (const m of MUTATIONS) execute(m, originals);

console.log("\n══════════ round294 变异矩阵（打在真生产字节上，逐字节自回滚）══════════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state);
  if (err !== "") console.log("    未命中原因：" + err);
  console.log("    " + note);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
