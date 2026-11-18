/**
 * round302 变异机：四台计数型机器新加的【格③】（装载失败那型 FAIL 行）是不是真承重。
 *
 * 被打的对象是【机器自己的字节】（.workbuddy/*.mjs 里的 readSummary），临时模块写在
 * `.workbuddy/tmp302-mut/`、收尾删掉 —— 所以这台【不写任何生产文件】。
 * 这一点与 round292~294 那几台（打真生产 src，逐字节自回滚）最大的不同，写在最前面。
 *
 * ── 为什么另起一台，而不是并 round301-mutate-parser-guards.mjs ──────────
 * 那台的 TARGETS 是【round301 那轮补了两格的四台里的三台】（不含 round294），
 * 且它每一发的预期都是在【只有格①② 的世界里】立的：M3 那条注释写着
 * 「两格全摘 ⇒ 自证该红在丙和丁上」。本轮加了格③ 之后丙丁两屏【三格都能拦】，
 * 那台的 M3 若继续跑，红话会多出格③ 那一句 —— 判式是 includes("丙") && includes("丁")
 * ⇒ 照样命中，不改也不会假红。但把新发的预期混进那张表，会让旧主张【被悄悄改口径】
 * 而没人察觉。所以这里单独一台，并把「round301 那台仍然 21/21」当作本轮的一个前提。
 *
 * ── 五发（每台各五发，四台共二十发）─────────────────────────────────────
 *  M0 控制组：一字不改。三格对四份屏各归各位 ——
 *     戊（装载失败 + 另一发真红）⇒ 格③ 的红话
 *     己（hook 炸 + 其余全绿）   ⇒ 格② 的红话
 *     丙（Tests 行 no tests）    ⇒ 格① 的红话
 *     丁（死一份其余照跑，无 FAIL 行）⇒ 格② 的红话
 *     这一发是后面每一发的地基：戊/己 是本轮【钉格子归属】的两型，M1~M4 的判式
 *     全靠「哪一格的红话」而不是「有没有抛」。
 *  M1 摘格③ ⇒ 戊【不再抛】（Tests 行有数字 ⇒ ①不响；用例级也有红 ⇒ ②不响 ⇒
 *     旧两格全静默），同时 丙/丁【仍各自抛】（①/② 没动）。
 *     ⇒ 这一发证明格③ 是【独立承重】的，且它补的正是 round301 §⑦① 登记的那格残留。
 *     M1′ 同一份字节跑一次机器【自己的】selfCheckParser ⇒ 必须红，且红话里带着戊。
 *  M2 把格③ 整段摘掉（不是改成 if(false)）⇒ 模块仍能装载、行为同 M1、且切出来的
 *     字节里不再出现 deadFiles 这个变量名。
 *     为什么单独立一发（round299 那一族的锚点自证）：本轮插这格的拼接脚本锚的是
 *     「格② 那个 } 之后」，若锚点漂了而判式只判抛不抛，我【看不见锚点漂了】。
 *     这一发钉的就是「那段字节确实长在 readSummary 里」。
 *  M3 原洞复原：格③ 摘掉 + 机器【自己的】自证摘空 ⇒ 现场什么都不响，而戊那一屏
 *     被读成一次正常读数 —— 那正是 round301 之前四台的状态。M1/M1′ 各自只拆一侧
 *     （门没了自证会响；自证没了门还在），都还会响或都不算洞 ⇒ 这两样是一个整体。
 *     ⚠ 这一发的判式【不找格③ 的红话】：门都没了还要求红话带格③ 那句 = 判式自己错
 *     （round301 M3 那一族：预期的红因由别人产生）。
 *  M4 只把匹配判式改坏（加一个恒假合取）⇒ 与 M1 同效。
 *     钉的是【判式】而不是【那个 if 语句在不在】：把 `if (deadFiles.length > 0)`
 *     留着、只让它恒不成立，比整格删掉更接近「日后有人改坏它」的真实形状。
 *
 * ⚠ 三处本轮踩过/想清楚的坑，都写在代码里对应位置：
 *  ① readSummary 一律【不传 wantFail】调用 —— 292 那一台有第二条控制组判式，
 *     传了它就会在摘掉格③ 后照样抛（红话是「控制组形状不对」）⇒ 我会误判格③ 承重。
 *     那是 round295 M4 那一族【红因来自别人】的反面（假未命中）。
 *  ② 丁用【没有 FAIL 行】的屏：本轮真复现「死一份其余照跑」只造得出带方括号的形状
 *     （= 丙），要量「格② 独立拦得住什么」必须用 round301 验过的那份字节 ——
 *     它正是 round301 那台机器里的 PROBE_PARTIAL，本轮沿用同一份。
 *  ③ 装载失败【不许被读成一次读数】：临时模块装不起来 ⇒ 整台机器停摆、不出命中数。
 *     一个把「没跑成」读成「跑出来是红」的机器，与它正在审计的那个洞同族（round301 记的）。
 *
 * 切字节的可信度：与 .workbuddy/probe301-census.mjs / round301-mutate-parser-guards.mjs
 * 同一套切法（ESC + strip + readSummary 三段），那两套本轮都用真 vitest 屏验过。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".workbuddy", "tmp302-mut");

/** 本轮把格③ 插进了【四台】计数型机器（round301 那台只管三台，round294 在它的账外）。 */
const TARGETS = [
  ".workbuddy/round292-mutate-org-node-criterion.mjs",
  ".workbuddy/round293-mutate-census.mjs",
  ".workbuddy/round293-mutate-gate-exemption.mjs",
  ".workbuddy/round294-mutate-add-node.mjs",
];

/** 各台格③ 的两半：装数那一半（匹配判式）与消费那一半（deadFiles 非空 ⇒ 抛）。 */
const CELL3_IF = "if (deadFiles.length > 0) {";
const CELL3_MATCH = "if (deadHit !== null && deadHit[1] === deadHit[2])";
/**
 * M4 的改坏形状：判式里多一个【恒假合取】。
 * ⚠ 第一版写成 `if (false) // 变异` —— 行注释把同一行尾上的 `deadFiles.push(...)`
 *   整段吞了，切出来的模块直接语法错（临时模块装不起来 ⇒ 整台机器停摆、不出命中数）。
 *   改坏判式不该顺手改坏语法：那量到的是「我的探针写坏了」，不是「这一格会坏」。
 */
const CELL3_MATCH_BAD = "if (deadHit !== null && deadHit[1] === deadHit[2] && false)";

/** 各台格② 的锚点（M2 摘格③ 后还要靠它兜住丁，所以这里只登记、不打它）。 */
const CELL2_BY_TARGET = {
  ".workbuddy/round292-mutate-org-node-criterion.mjs": "if (files.failed > 0 && tests.failed === 0) {",
  ".workbuddy/round294-mutate-add-node.mjs": "if (failedFiles > 0 && failed === 0) {",
};
const CELL2_DEFAULT = "if (redFiles > 0 && red === 0) {";

/** 丙/丁 两份屏：round301 那台机器验过的字节，本轮沿用（丁【不含 FAIL 行】，见文件头②）。 */
const PROBE_LOADFAIL = " Test Files  1 failed (1)\n      Tests  no tests\n";
const PROBE_PARTIAL = " Test Files  1 failed | 1 passed (2)\n      Tests  25 passed (25)\n";

/**
 * 戊/己 两份屏在【临时模块里】现拼（不在本机顶层拼）：
 * 顶层那份字节若自己漏了 ESC，readSummary 会先抛「剥 ANSI 没生效」（293-gate 那一格），
 * 于是「没抛」那一发永远红，而红因是我的探针字节 —— 探针自己造的红不算证据。
 * 现拼时顺便断言「ESC 真的在字节里」。两份都取自真屏（.workbuddy/probe302-{mixed,hookgreen}-raw.txt），
 * 与四台机器自证里的戊/己【同一份字节】⇒ 矩阵量的就是现场钉的那两型。
 */
const FIXTURE_MODULE = `
const esc = String.fromCharCode(27);
const wrap = (s) => s.split("ESC").join(esc);
export const PROBE_WU = wrap(
  "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302dead.test.tsESC[2m [ test/arch/probe302dead.test.ts ]ESC[22m\\n" +
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302red.test.tsESC[2m > ESC[22mprobe302 真红ESC[2m > ESC[22m这一发故意红\\n" +
    "ESC[2m Test Files ESC[22m ESC[1mESC[31m2 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (3)ESC[39m\\n" +
    "ESC[2m      Tests ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m5 passedESC[39mESC[22mESC[90m (6)ESC[39m\\n",
);
export const PROBE_JI = wrap(
  "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302hook.test.tsESC[2m > ESC[22mprobe302 hook 炸\\n" +
    "ESC[2m Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (2)ESC[39m\\n" +
    "ESC[2m      Tests ESC[22m ESC[1mESC[32m4 passedESC[39mESC[22mESC[2m | ESC[22mESC[33m1 skippedESC[39mESC[90m (5)ESC[39m\\n",
);
if (!PROBE_WU.includes(esc) || !PROBE_JI.includes(esc)) {
  throw new Error("夹具里的 ESC 没落成字节 ⇒ 这份读数不可信");
}
`;

const preludes = (src) => {
  const one = (needle, takeFn) => {
    const i = src.indexOf(needle);
    if (i === -1) return "";
    const e = takeFn ? src.indexOf("\n}", i) : src.indexOf("\n", i);
    return src.slice(i, (e === -1 ? src.indexOf("\n", i) : e + (takeFn ? 2 : 0))) + "\n";
  };
  /* UNIT / E2E 也得切：round294 的 selfCheckParser 用这两个模块级常量拼它自己的
     夹具，切漏了 ⇒ 自证当场 ReferenceError。本轮真中过一次：那一发的判式是
     「自证必须红且红话带『戊』」，实得「UNIT is not defined」⇒ 判【未命中】。
     方向是对的（红因来自我的切片 ⇒ 宁可假未命中，不能假命中），但它提醒：
     【切片必须包含被切函数用到的自由变量】，否则量的是我的探针，不是机器。 */
  return (
    one("const ESC = String.fromCharCode(27);", false) +
    one("const UNIT = ", false) +
    one("const E2E = ", false) +
    one("function strip(", true)
  );
};

const slice = (src, name) => {
  const at = src.indexOf("function " + name);
  if (at === -1) throw new Error("切不到 " + name);
  const end = src.indexOf("\n}", at);
  if (end === -1) throw new Error("切不到 " + name + " 的收尾");
  return src.slice(at, end + 2);
};

const assemble = (src) =>
  preludes(src) +
  slice(src, "readSummary") +
  "\n" +
  slice(src, "selfCheckParser") +
  "\nexport { readSummary, selfCheckParser };\n" +
  FIXTURE_MODULE;

function assertOnce(text, anchor, where) {
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error(
      "锚点在 " + where + " 命中 " + n + " 次（要求恰好 1）：" + anchor.slice(0, 46),
    );
  }
}

/** 装载失败：与「被测解析器抛」严格分开的类型，见到它整台机器就该停。 */
class LoadFailure extends Error {}

let seq = 0;
/** 装一个临时模块（唯一性靠【文件名】，Windows 上 `import(url + "?v=1")` 直接找不到模块）。 */
async function load(body, tag) {
  mkdirSync(TMP, { recursive: true });
  seq += 1;
  const file = join(TMP, tag + "-" + seq + ".mjs");
  writeFileSync(file, body, "utf8");
  try {
    return await import(pathToFileURL(file).href);
  } catch (err) {
    throw new LoadFailure(
      "临时模块装载失败（" + file + "）⇒ 这台机器的读数全部不可信，停：" +
        String(err instanceof Error ? err.message : err).split("\n")[0],
    );
  }
}

/**
 * 喂一份屏，返回 {threw, msg}。屏名 "WU"/"JI" 从【临时模块自己】取（见 FIXTURE_MODULE 那段）。
 * ⚠ 不传 wantFail（见文件头①）：292 那条控制组判式会把「摘掉格③」的红因换掉。
 */
async function checkScreen(body, screen, tag) {
  const mod = await load(body, tag);
  const text =
    screen === "WU" ? mod.PROBE_WU : screen === "JI" ? mod.PROBE_JI : screen;
  if (typeof text !== "string") {
    throw new LoadFailure("屏取不到（临时模块里没有 PROBE_WU/PROBE_JI）⇒ 读数不可信，停");
  }
  try {
    mod.readSummary(text);
    return { threw: false, msg: "没抛（读成了一次正常读数）" };
  } catch (err) {
    return {
      threw: true,
      msg: String(err instanceof Error ? err.message : err).split("\n").slice(0, 6).join(" / ").slice(0, 400),
    };
  }
}

/** 跑机器【自己的】读数自证：返回 {passed, msg}。装载失败往上抛，不吞。 */
async function checkSelf(body, tag) {
  const mod = await load(body, tag);
  try {
    mod.selfCheckParser();
    return { passed: true, msg: "自证通过" };
  } catch (err) {
    const lines = String(err instanceof Error ? err.message : err).split("\n");
    return { passed: false, msg: lines.slice(0, 8).join(" / ").slice(0, 500) };
  }
}

/** 格③ 整段：从 `const deadFiles` 到那一格的收尾 `}`（M2 用）。 */
function cell3Range(text) {
  const s = text.indexOf("const deadFiles = [];");
  if (s === -1) return null;
  const g = text.indexOf(CELL3_IF, s);
  if (g === -1) return null;
  const end = text.indexOf("\n  }\n", g);
  if (end === -1) return null;
  return { start: s, end: end + 5 };
}

const results = [];
let fatal = "";
try {
  for (const rel of TARGETS) {
    if (fatal !== "") break;
    const src = readFileSync(join(ROOT, rel), "utf8");
    // 标签只留「轮号-名字」：带上 .mjs 会跟着进临时模块文件名（Windows 上没坏但读不清）。
    const short = rel
      .replace(".workbuddy/round", "")
      .replace("-mutate", "")
      .replace(".mjs", "");
    const good = assemble(src);
    assertOnce(good, CELL3_IF, short + " 格③");
    assertOnce(good, CELL3_MATCH, short + " 格③ 匹配判式");
    assertOnce(good, CELL2_BY_TARGET[rel] ?? CELL2_DEFAULT, short + " 格②");
    const push = (hit, label, msg) => results.push([hit, label, msg]);

    // M0 控制组：四份屏各归各格。
    const m0 = {
      戊: await checkScreen(good, "WU", short + "0w"),
      己: await checkScreen(good, "JI", short + "0j"),
      丙: await checkScreen(good, PROBE_LOADFAIL, short + "0b"),
      丁: await checkScreen(good, PROBE_PARTIAL, short + "0d"),
    };
    const m0ok =
      m0["戊"].threw && m0["戊"].msg.includes("装载失败那型的 FAIL 行") &&
      m0["己"].threw && m0["己"].msg.includes("用例级【一条红都没有】") &&
      m0["丙"].threw && m0["丁"].threw;
    push(
      m0ok,
      short + " M0 控制组：戊/己/丙/丁 各由该管的那格拦住",
      "戊「" + m0["戊"].msg.slice(0, 24) + "」/ 己「" + m0["己"].msg.slice(0, 24) +
        "」/ 丙" + (m0["丙"].threw ? "抛" : "【没抛】") + " / 丁" + (m0["丁"].threw ? "抛" : "【没抛】"),
    );

    // M1 摘格③：戊失守，丙/丁 照旧。
    const m1src = good.replace(CELL3_IF, "if (false) { // 变异：格③ 被摘");
    assertOnce(m1src, "变异：格③ 被摘", short + " M1");
    const after1 = await checkScreen(m1src, "WU", short + "1w");
    const after1b = await checkScreen(m1src, PROBE_LOADFAIL, short + "1b");
    const after1d = await checkScreen(m1src, PROBE_PARTIAL, short + "1d");
    push(
      !after1.threw && after1b.threw && after1d.threw,
      short + " M1 摘格③（戊该失守，丙丁仍由①② 拦住 ⇒ ③ 独立承重）",
      "戊改后" + (after1.threw ? "【仍抛】⇒ ③ 不是那型唯一的门" : "不抛了") +
        " / 丙" + (after1b.threw ? "仍抛" : "【没抛】") + " / 丁" + (after1d.threw ? "仍抛" : "【没抛】"),
    );

    // M1′ 同一份字节：机器自己的自证必须【红在戊上】（现场会响，不用等人跑这台）。
    const m1self = await checkSelf(m1src, short + "1s");
    push(
      !m1self.passed && m1self.msg.includes("戊"),
      short + " M1′ 摘格③ 后【机器自证】该红在戊上",
      m1self.passed ? "【自证仍然通过】⇒ 戊那一格没在跑，M1 的命中不可信" : m1self.msg,
    );

    // M2 整段摘掉：行为同 M1，且字节里 deadFiles 这个变量名消失（锚点自证）。
    const rng = cell3Range(good);
    if (rng === null) throw new Error("切不到格③ 整段：" + short);
    const m2src = good.slice(0, rng.start) + good.slice(rng.end);
    const gone = !m2src.includes("deadFiles");
    const after2 = await checkScreen(m2src, "WU", short + "2w");
    push(
      gone && !after2.threw,
      short + " M2 整段摘除（deadFiles 字节消失 + 戊失守 ⇒ 插进去的段真在承重）",
      "deadFiles" + (gone ? "已从切出的字节里消失" : "【还在】⇒ 段没切干净") +
        " / 戊改后" + (after2.threw ? "【仍抛】" : "不抛了"),
    );

    // M3 原洞复原：格③ 摘掉 + 机器自己的自证摘空 ⇒ 【现场什么都不响】，而戊那一屏
    // 被读成一次正常读数 —— 这正是 round301 之前那四台的状态（装载失败被并进另一发
    // 真红里读成「命中」，且没有任何东西会响）。M1/M1′ 各自只拆一侧：门没了自证会响，
    // 自证没了门还在 ⇒ 只有两侧同拆才复现原洞 ⇒ 这两样是一个整体。
    // ⚠ 判式里【不找格③ 的红话】：那种屏上红话被别的门接手，找它等于自证自己的错。
    const m3src = m1src.replace(
      "function selfCheckParser() {",
      "function selfCheckParser() {\n  if (true) return; // 变异：自证被摘空",
    );
    assertOnce(m3src, "自证被摘空", short + " M3");
    const m3self = await checkSelf(m3src, short + "m3");
    const m3screen = await checkScreen(m3src, "WU", short + "m3w");
    push(
      m3self.passed && !m3screen.threw,
      short + " M3 格③ + 自证同摘（= 原洞复原：该静默且不抛）",
      "自证" + (m3self.passed ? "【静默通过】" : "红") + " / 戊那一屏" +
        (m3screen.threw ? "仍抛" : "【读成正常读数】⇒ 装载失败被并进另一发红里判命中"),
    );

    // M4 只把匹配判式改坏：与 M1 同效 ⇒ 钉的是判式，不是「那个 if 在不在」。
    const m4src = good.replace(CELL3_MATCH, CELL3_MATCH_BAD);
    assertOnce(m4src, CELL3_MATCH_BAD, short + " M4");
    const after4 = await checkScreen(m4src, "WU", short + "4w");
    push(
      !after4.threw,
      short + " M4 匹配判式改坏（戊该失守：③ 的红话再也不会有人读出）",
      after4.threw ? "【仍抛】⇒ M1 的命中是靠【那个 if 语句在不在】，不是靠判式" : "不抛了",
    );
  }
} catch (err) {
  if (err instanceof LoadFailure) fatal = err.message;
  else throw err;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round302 格③（装载失败 FAIL 行）变异矩阵 ══════════");
  for (const [hit, label, msg] of results) {
    ok += hit ? 1 : 0;
    console.log((hit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  // 分母是【数出来】的：语料空了 / 少扫一台 / 某台的某一发没跑成，这一行自己就不满足。
  const PER_TARGET = 6; // M0, M1, M1′, M2, M3, M4
  const want = TARGETS.length * PER_TARGET;
  console.log(
    "命中 " + ok + " / " + results.length +
      "（分母 = " + TARGETS.length + " 台 × " + PER_TARGET + " 发 = " + want + "）",
  );
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
