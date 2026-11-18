/**
 * 打在【真生产字节】上的自回滚变异机 —— round299，r22 射程④ 那一格
 * （orgGraphSchema 那条 superRefine：节点键必须等于 node.role_id）。
 *
 * 判据落点 = packages/contracts/src/org/graph.ts 的 superRefine。
 * 要抓它的守卫有【两份】，两份的口径不同，所以矩阵每发都问「该由哪一份抓」：
 *   甲 test/org/validate.test.ts           —— 尺子本身有没有刻度（schema 单测）
 *   乙 packages/hub/test/http/org-route.test.ts —— 那条路上真有人拿它量（端到端 422）
 * 只有乙能证「HTTP 塞不进去了」这句话；只有甲能证「诊断指得出是哪一个键」。
 *
 * ⭐ 这台比 round298 那台多一件【必做】的事：变异打在 contracts 的【src】上，
 * 而测试吃的是【dist】（contracts 的 package exports 指向 dist/index.js）。
 * 所以「矩阵全绿」有一种全新的假法：改了 src 而 dist 没跟上 ⇒ 每发变异都测的是
 * 上一版 ⇒ 6/6 全绿而那一格【从没被测过】。globalSetup 自己就写着这一族
 * （test/global-setup/build-contracts.ts:21「会在 contracts/src 改过而 dist 是旧的
 * 时候，拿旧 schema 去测新代码 —— 全绿但测的是上一版」）。
 * ⇒ 自证里有一发【真验这条管道】：往 src 塞一个唯一记号 → tsc -b → 读 dist 里
 *   那个记号在不在 → 撤掉再验它不在。它测的是这台机器的【供电】，不是判据。
 *
 * 家规：自回滚 + 逐字节核对；单独跑，不与任何测试并发；分母数出来不靠记。
 * 跑法：node .workbuddy/round299-mutate-node-key-gate.mjs
 *      （纯 JS：.mjs 走 tsx 之外的纯解析，不许出现类型标注。）
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_REL = "packages/contracts/src/org/graph.ts";
const SRC = join(ROOT, SRC_REL);
const DIST_REL = "packages/contracts/dist/org/graph.js";
const DIST = join(ROOT, DIST_REL);

const UNIT = "test/org/validate.test.ts";
const HTTP = "packages/hub/test/http/org-route.test.ts";

/* 用例名逐字取自两份测试文件。矩阵按【用例名】点名，不按文件：
   点文件的分辨率是一份几十发的文件，里面任何一发红都算命中，而它可能红在别处。 */
const T_SCHEMA_REJECT =
  "⭐ 键≠node.role_id ⇒ schema 拒（round299 把这条从【登记的洞】翻成【判据】）";
const T_REVERSE_GREEN =
  "反向对照两发：空图与【每个键都等于自己的 role_id】⇒ 该绿（证明新判据不是恒红）";
const T_MANY_KEYS =
  "⭐ 一条图里多个坏键 ⇒ 每个键各报一条 issue（判据是逐节点而不是遇第一个就退）";
const T_HTTP_422 =
  "⭐ 请求体夹带「键≠node.role_id」的节点 ⇒ 422，且不备份、不写行（r22 射程④ 关掉）";
const T_HTTP_200 =
  "⭐ 反向对照：同一个形状把键改成【与 role_id 相同】⇒ 200（上一发不是恒 422）";

const ESC = String.fromCharCode(27);
const src0 = readFileSync(SRC, "utf8");

/* ───────────────────────── 变异表 ───────────────────────── */

const MUTATIONS = [];
/**
 * @param {string} from      锚点（必须【恰好】命中一次）
 * @param {string} to        换成什么
 * @param {string} label     这一发的名字
 * @param {string[]} mustRed 必须转红的【用例名】
 * @param {string[]} blind   预期【仍然绿】的用例名 = 登记的盲区，要数出来
 * @param {string} why       这一发模拟的是哪种"看着像修好了"
 */
function mutate(from, to, label, mustRed, blind, why) {
  MUTATIONS.push({ from, to, label, mustRed, blind, why });
}

// 控制组：一字不改 ⇒ 必须全绿。它管的是"这台机器不会自己造红"。
mutate(
  "if (node.role_id === key) continue;",
  "if (node.role_id === key) continue;",
  "M0 控制组（一字不改）⇒ 该绿",
  [],
  [T_SCHEMA_REJECT, T_REVERSE_GREEN, T_HTTP_422, T_HTTP_200],
  "矩阵自己的底色：控制组红了后面每一发的红都分不清是变异还是环境。",
);

// 判据反了：一致才报。这是最像"修好了"的一种坏法 —— 它照样拒很多请求。
mutate(
  "if (node.role_id === key) continue;",
  "if (node.role_id !== key) continue;",
  "M1 判据反了（键与 role_id 【一致】时才报）",
  [T_SCHEMA_REJECT, T_REVERSE_GREEN, T_MANY_KEYS, T_HTTP_422, T_HTTP_200],
  [],
  "⚠ 落笔前我以为这一发【只】会被那两发反向对照抓到，跑之前手推了一遍才发现推错了：" +
    "甲与乙那两发【正向】测试各断言了【报的是哪一个键】（issue.path 取到 a、" +
    "正文取 nodes.ghost.role_id），反判据下报的是 ceo 与一堆合法键 ⇒ 两发当场红。" +
    "⇒ 断言【被拒】远不如断言【因为哪一个键被拒】来得承重。这一发的价值就是把那句话钉住：" +
    "若那两发退化成只判 success=false / status=422，M1 会从它们身上溜走。",
);

// 不遍历任何节点 = 判据摘掉，但 schema 其余部分照旧（其余测试不受影响）。
// ⚠ 变异必须【类型合法】：contracts 的 src 编译不过 ⇒ globalSetup 直接抛 ⇒
//   vitest 一个用例都不跑 ⇒ 整张矩阵中途崩，而不是那一发红。所以这里带窄化标注。
mutate(
  "for (const [key, node] of Object.entries(graph.nodes)) {",
  "for (const [key, node] of Object.entries({}) as [string, { role_id: string }][]) {",
  "M2 摘掉遍历（判据在而什么都不看）",
  [T_SCHEMA_REJECT, T_MANY_KEYS, T_HTTP_422],
  [T_REVERSE_GREEN, T_HTTP_200],
  "判据的【外壳】留着、眼睛拿掉：函数还在、superRefine 还挂着、issues 恒空。" +
    "⚠ 那两发反向对照在这一发下【全绿】—— 反向对照按设计就抓不到【无判据】，" +
    "它只防恒红。这个盲区是登记的，不是遗漏。",
);

// 遍历错了集合：拿 edges 当 nodes 遍历 ⇒ 有边的合法图被拒。
mutate(
  "for (const [key, node] of Object.entries(graph.nodes)) {",
  "for (const [key, node] of Object.entries(graph.edges) as unknown as " +
    "[string, { role_id: string }][]) {",
  "M3 遍历错集合（拿 edges 当 nodes）",
  [T_SCHEMA_REJECT, T_REVERSE_GREEN, T_MANY_KEYS, T_HTTP_422, T_HTTP_200],
  [],
  "一个 typo 级别的错法：判据【存在】而且很凶，凶到把有边的合法图全拒了" +
    "（边对象没有 role_id ⇒ 每条边都成了【键≠自称】）。" +
    "⚠ 我原本把 T_MANY_KEYS 登记成这一发的盲区，手推之后发现推错了：" +
    "那一发的夹具 edges 是【空的】⇒ 反集合遍历什么都看不到 ⇒ success=true ⇒ " +
    "它自己那句【夹具本该被拒】当场抛 ⇒ 它是【红】的。" +
    "⇒ 【盲区】不能凭感觉填，要按那份夹具的字节推一遍。这一格如果照我第一版登记，" +
    "矩阵会红在一句【机器对判据的预期写错了】上，而不是红在判据上。",
);

// 诊断退化：还拒，但不再说得出是哪个键自称了别的 id。
mutate(
  '"] 上的节点自称 role_id=[" +',
  '"] 与某个节点不一致（细节略：" +',
  "M4 诊断退化（还拒，但说不出是哪个 id）",
  [T_SCHEMA_REJECT],
  [T_HTTP_422, T_MANY_KEYS, T_REVERSE_GREEN, T_HTTP_200],
  "⚠ 这一发的价值全在 blind 那一栏：端到端那一发读的是 issuesOf 把 path " +
    "join 成的点号串（nodes.ghost.role_id），而 path 没动 ⇒ 它在诊断退化时【照样绿】。" +
    "⇒ 「HTTP 那一发覆盖得挺全」是误读：状态码与 path 挡住了，正文可用性只有甲那份挡。",
);

// path 退化：正文还在，path 没了 ⇒ 两份守卫的红因不同。
mutate(
  'path: ["nodes", key, "role_id"],',
  'path: ["nodes"],',
  "M5 path 退化（指不到那一个键）",
  [T_SCHEMA_REJECT, T_MANY_KEYS, T_HTTP_422],
  [T_REVERSE_GREEN, T_HTTP_200],
  "integrity.ts 的 issueSummary 与 org.ts 的 issuesOf 都只读 path —— " +
    "path 塌成一层时，自检报告与 422 正文同时失去【是哪一个键】，" +
    "而图【照样被拒】。所以这是【拒对了但没人能修】那一族。" +
    "⚠ 这一发必须端到端那一发也红，否则「422 的正文可用性」就没人守：" +
    "issuesOf 输出的正是这个 path。",
);

/* ───────────────────────── 读 vitest 读数 ───────────────────────── */

function strip(s) {
  return s.replace(new RegExp(ESC + "\\[[0-9;]*m", "g"), "");
}

/** 拿不到读数就【抛】：把"没测到"读成"绿"是本仓最贵的那一族。 */
function readSummary(out) {
  const clean = strip(out);
  if (/Transform failed|Cannot find module|SyntaxError/u.test(clean)) {
    if (!clean.includes("FAIL")) {
      throw new Error("装载期失败而读不到 FAIL 行。尾部：\n" + clean.slice(-700));
    }
  }
  const m = clean.match(/^\s*Tests\s+(.+)$/m);
  if (m === null) {
    throw new Error(
      "读不到「Tests」摘要行 —— 不许当 0。尾部：\n" + clean.slice(-700),
    );
  }
  const seg = m[1] ?? "";
  const files = new Set();
  const tests = new Set();
  for (const line of clean.split("\n")) {
    const fm = /^\s*FAIL\s+(\S+\.(?:ts|tsx))\b/u.exec(line);
    if (fm === null || fm[1] === undefined) continue;
    files.add(fm[1].split("\\").join("/"));
    const gt = line.indexOf(">");
    if (gt >= 0) {
      const name = line.slice(gt + 1).split(">").pop().trim();
      if (name !== "") tests.add(name);
    }
  }
  const tf = clean.match(/^\s*Test Files\s+(.+)$/m);
  if (tf === null) throw new Error("读不到「Test Files」摘要行。尾部：\n" + clean.slice(-400));
  const failedTests = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
  const failedFiles = Number((tf[1].match(/(\d+) failed/) ?? [0, "0"])[1]);
  if (failedFiles > 0 && files.size === 0) {
    throw new Error("有文件红了但读不到 FAIL 文件名 ⇒ 归因失真。尾部：\n" + clean.slice(-700));
  }
  return {
    failedTests,
    failedFiles,
    failed: failedTests + failedFiles,
    passed: Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]),
    files,
    tests,
  };
}

function run(spec) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", spec],
    { cwd: ROOT, encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return readSummary(String(r.stdout) + String(r.stderr));
}

/* ───────────────────────── 机器自证 ───────────────────────── */

let checks = 0;
const problems = [];
function need(cond, why) {
  checks += 1;
  if (!cond) problems.push(why);
}

/** 甲：读摘要这台机器在有 ANSI 色码时读得出【用例名】。 */
function selfCheckReader() {
  const colored =
    " " + ESC + "[41mFAIL" + ESC + "[39m " + HTTP + " > ③ 请求体 > " + T_HTTP_422 + "\n" +
    "AssertionError: expected 422 to be 200\n" +
    " Test Files " + ESC + "[31m1 failed" + ESC + "[39m (1)\n" +
    "      Tests " + ESC + "[31m1 failed" + ESC + "[39m | 13 passed (14)\n";
  try {
    const s = readSummary(colored);
    need(s.failedTests === 1, "自证甲：用例红读成 " + s.failedTests + "（要 1）");
    need(s.files.has(HTTP), "自证甲：色码里没归因到那份文件");
    need(s.tests.has(T_HTTP_422), "自证甲：用例名没读出来 ⇒ 点名会全成假未命中");
  } catch (e) {
    need(false, "自证甲 抛：" + String(e && e.message ? e.message : e).slice(0, 160));
  }
}

/** 乙：读不到摘要行必须【抛】，不许退化成 0（0 = 绿 = 整张矩阵假绿）。 */
function selfCheckThrowsOnUnreadable() {
  let threw = false;
  try {
    readSummary("something happened, no summary here at all");
  } catch {
    threw = true;
  }
  need(threw, "自证乙：读不到摘要行却【没抛】⇒ 会把没测到读成 0 发红");
}

/**
 * 丙：变异打在 src 而测试吃 dist ⇒ 这条自证验的是【管道】。
 * 记号只进 message 字符串（合法 TS，不改语义），编译后必须出现在 dist 里。
 */
function selfCheckBuildPipeline() {
  const MARK = "ROUND299-PIPELINE-MARKER-7f31";
  const anchor = '"节点键 [" +';
  if (!src0.includes(anchor)) {
    need(false, "自证丙：锚点不在 src ⇒ 这台机器的落点已经漂了");
    checks += 2;
    return;
  }
  const withMark = src0.replace(anchor, '"' + MARK + '" + ' + anchor);
  let distHas = false;
  let distLacks = false;
  try {
    writeFileSync(SRC, withMark);
    execFileSync("npx", ["tsc", "-b", join(ROOT, "packages", "contracts")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    distHas = readFileSync(DIST, "utf8").includes(MARK);
  } catch (e) {
    need(false, "自证丙：带记号编译失败 ⇒ " + String(e && e.message ? e.message : e).slice(0, 200));
  } finally {
    writeFileSync(SRC, src0);
    try {
      execFileSync("npx", ["tsc", "-b", join(ROOT, "packages", "contracts")], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 300_000,
        shell: true,
        maxBuffer: 32 * 1024 * 1024,
      });
      distLacks = !readFileSync(DIST, "utf8").includes(MARK);
    } catch (e) {
      need(false, "自证丙：复原后重编失败 ⇒ " + String(e && e.message ? e.message : e).slice(0, 200));
    }
  }
  // 这两条就是"这台机器有没有供电"：src 的改动能不能走到被测的那份字节。
  need(distHas, "自证丙：改了 src 而 dist 里【没有】记号 ⇒ 测试吃的是旧 dist ⇒ 整张矩阵会是假绿");
  need(distLacks, "自证丙：撤掉记号后 dist 里【还留着】⇒ dist 不是 src 的产物，读数不可信");
}

/** 丁：锚点预检 —— 每个锚点在 src 里恰好命中一次，且 to ≠ from（M0 除外）。 */
function selfCheckAnchors() {
  let ok = true;
  for (const m of MUTATIONS) {
    if (m.from === m.to && m.label.startsWith("M0")) continue;
    const n = src0.split(m.from).length - 1;
    if (n !== 1) {
      problems.push("自证丁：" + m.label + " 的锚点命中 " + n + " 次（要 1）");
      ok = false;
    }
    if (m.from === m.to) {
      problems.push("自证丁：" + m.label + " 的 to === from ⇒ 这是一发空转变异");
      ok = false;
    }
  }
  checks += 1;
  if (!ok) return;
  // 反向对照：故意拿一个【不存在】的锚点走同一段判定，它必须报"命中 0 次"。
  // 少了这一发，"全部锚点命中 1 次"这个读数分不出【锚点真的好】与【这段判定根本没跑】。
  const bogus = src0.split("THIS_ANCHOR_DOES_NOT_EXIST_42").length - 1;
  need(bogus === 0, "自证丁 的反向对照：不存在的锚点没被数成 0");
}

/** 戊：这台点的是【用例名】而不是文件名 —— 喂它一份合成的红，它要数得出名字。 */
function selfCheckNamesNotFiles() {
  const synth =
    " FAIL  " + UNIT + " > schema：形状上的收紧 > " + T_REVERSE_GREEN + "\n" +
    " Test Files 1 failed (1)\n      Tests 1 failed | 58 passed (59)\n";
  const s = readSummary(synth);
  need(s.tests.has(T_REVERSE_GREEN), "自证戊：读不出用例名 ⇒ 反向对照那一栏全是假命中");
  const other =
    " FAIL  " + UNIT + " > 别的 suite > 一条与本机无关的用例\n" +
    " Test Files 1 failed (1)\n      Tests 1 failed | 58 passed (59)\n";
  need(!readSummary(other).tests.has(T_REVERSE_GREEN), "自证戊：别的用例红被当成了这一发红");
}

/**
 * 己：钉住【盲区那一栏的方向】。
 * `tests` 只装【红】的用例名 ⇒ "仍绿" = 不在集合里。这台第一版把方向写反了
 * （`has(t)` 当成仍绿），后果是【每一发的盲区都恒 0】—— 一个永远不可能成立的
 * 判据，正是 round298 ⑥·乙 那条【在本机自己身上】复发的一次。
 * 所以这里直接喂一份"一发红一发绿"的合成读数，逼这个谓词两种各数一次。
 */
function selfCheckBlindDirection() {
  const one =
    " FAIL  " + UNIT + " > schema：形状上的收紧 > " + T_REVERSE_GREEN + "\n" +
    " Test Files 1 failed (1)\n      Tests 1 failed | 58 passed (59)\n";
  const s = readSummary(one);
  const blind = [T_REVERSE_GREEN, T_MANY_KEYS];
  const stillGreen = blind.filter((t) => !s.tests.has(t));
  need(stillGreen.length === 1 && stillGreen[0] === T_MANY_KEYS,
    "自证己：盲区方向又反了（要【没红的】那条算仍绿）");
  const none =
    " Test Files 1 passed (1)\n      Tests 59 passed (59)\n";
  const g = readSummary(none);
  need(blind.filter((t) => !g.tests.has(t)).length === 2,
    "自证己：全绿时盲区应当【两条都算仍绿】（M0 那一发就靠这个读数）");
}

/**
 * 己之二：这台点的【用例名】必须【逐字存在于】那两份测试文件里。
 * 对不上时的症状很难看：mustRed 会【全部】报未命中，看着像"判据不承重"，
 * 其实是有人改了 it() 的措辞。所以这条放在矩阵之前，宁可不开跑。
 * 配一发自证：故意拿一个不存在的名字走同一段判定，它必须报"找不到"——
 * 否则"5 个名字全在"这个读数分不出【名字真的好】与【这段判定恒真】。
 */
function selfCheckNamesExistOnDisk() {
  const real = new Set();
  for (const f of [UNIT, HTTP]) {
    const t = readFileSync(join(ROOT, f), "utf8");
    for (const m of t.matchAll(/it\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      real.add(JSON.parse('"' + m[1] + '"'));
    }
  }
  need(real.size > 10, "自证己之二：从测试文件里一条 it() 都没读出来 ⇒ 取材坏了");
  const declared = [
    T_SCHEMA_REJECT,
    T_REVERSE_GREEN,
    T_MANY_KEYS,
    T_HTTP_422,
    T_HTTP_200,
  ];
  for (const n of declared) {
    need(real.has(n), "自证己之二：这个用例名在测试文件里【找不到】⇒ " + n.slice(0, 40));
  }
  // 反向对照：一个肯定不存在的名字必须被判"找不到"。
  need(!real.has("这一发根本不存在-ZZ"), "自证己之二 的反向对照：判定恒真");
}

/* ───────────────────────── 主循环 ───────────────────────── */

function main() {
  selfCheckReader();
  selfCheckThrowsOnUnreadable();
  selfCheckAnchors();
  selfCheckNamesNotFiles();
  selfCheckBlindDirection();
  selfCheckNamesExistOnDisk();
  selfCheckBuildPipeline();
  if (problems.length > 0) {
    console.error("机器自证失败，矩阵不可信：");
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log("机器自证 " + checks + "/" + checks + " 通过（含 src→dist 管道那两条）");

  let hits = 0;
  const rows = [];
  try {
    for (const m of MUTATIONS) {
      const mutated = src0.replace(m.from, m.to);
      if (mutated === src0 && !m.label.startsWith("M0")) {
        problems.push(m.label + "：替换后字节未变 ⇒ 这一发没测任何东西");
        continue;
      }
      writeFileSync(SRC, mutated);
      const unit = run(UNIT);
      const http = run(HTTP);
      const bySpec = { [UNIT]: unit, [HTTP]: http };

      const missing = m.mustRed.filter(
        (t) => !unit.tests.has(t) && !http.tests.has(t),
      );
      /* ⚠ 方向：`tests` 这个集合是从【FAIL 行】里读出来的，所以它只装得下【红的用例名】。
         ⇒ 「这一发下它仍然绿」= 它【不在】那个集合里。第一版我把 filter 写成了
         `has(t)`（"在集合里 = 仍绿"），于是 M0 控制组【一份都没红】却报
         「0/4 盲区仍绿」—— 一个恒不可能成立的判据就是一句装饰（round298 ⑥·乙 那条，
         这轮它在我自己的机器上复发了）。现在按字节方向写，并另加一发自证钉住它。 */
      const stillGreen = m.blind.filter(
        (t) => !unit.tests.has(t) && !http.tests.has(t),
      );
      const unexpectedlyRed = m.blind.filter(
        (t) => unit.tests.has(t) || http.tests.has(t),
      );
      const totalRed = unit.failed + http.failed;

      let hit;
      if (m.label.startsWith("M0")) {
        hit = totalRed === 0 && missing.length === 0;
      } else {
        hit =
          missing.length === 0 &&
          stillGreen.length === m.blind.length &&
          totalRed > 0;
      }
      if (hit) hits += 1;

      const where = Object.keys(bySpec)
        .filter((k) => bySpec[k].failed > 0)
        .map((k) => k.split("/").pop() + " 红 " + bySpec[k].failed)
        .join(" / ");
      rows.push(
        (hit ? "✓" : "✗") + " " + m.label +
          "\n      该红的用例：" +
          (m.mustRed.length === 0
            ? "（控制组：只判全绿）"
            : m.mustRed.length - missing.length + "/" + m.mustRed.length +
              " 命中" + (missing.length ? "｜【未命中】" + missing.join(" ; ") : "")) +
          "\n      登记的盲区（预期仍绿）：" +
          (m.blind.length === 0
            ? "（无）"
            : stillGreen.length + "/" + m.blind.length + " 确实没红 ⇒ " +
              stillGreen.join(" ; ") +
              (unexpectedlyRed.length
                ? "｜【意外红了】" + unexpectedlyRed.join(" ; ")
                : "")) +
          "\n      红的地方：" + (where === "" ? "（一份都没红）" : where) +
          "\n      这一发模拟：" + m.why,
      );
    }
  } finally {
    writeFileSync(SRC, src0);
    execFileSync("npx", ["tsc", "-b", join(ROOT, "packages", "contracts")], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 300_000,
      shell: true,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  for (const r of rows) console.log(r);
  const restored = readFileSync(SRC, "utf8") === src0;
  console.log(
    "\n命中 " + hits + "/" + MUTATIONS.length +
      " ｜复原逐字节一致 = " + restored,
  );
  if (problems.length > 0) {
    for (const p of problems) console.error("运行期问题： " + p);
    process.exit(1);
  }
  if (!restored || hits !== MUTATIONS.length) process.exit(1);
}

main();
