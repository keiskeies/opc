/**
 * round301 变异机：那三台老机器的【装载失败门】是不是真在做事。
 *
 * 被打的对象不是生产字节，是【机器自己的字节】（.workbuddy/*.mjs）——
 * 所以这台【不写任何生产文件】，可以安全地与别的东西并排跑。
 * 这一点与 round292~300 那几台最大的不同，写在最前面。
 *
 * ── 五发（每台各五发，三台共十五发）──────────────────────────────────
 *  M0 控制组：一字不改 ⇒ 自证必须【过】。后面每一发的前提。
 *  M1 摘掉格①（「Tests 行无数字 ⇒ 抛」）⇒ 自证【仍然会过】！
 *     ⚠ 这一发的预期是本轮量出来的，不是猜的：格① 与格② 在【今天能复现的每一型上
 *     重叠】—— `Tests no tests` 总是和 `Test Files 1 failed` 成对出现（实测
 *     probe301-loadfail-raw.txt），摘掉①之后②照样抛 ⇒ 自证把丙那一格照样判成过。
 *     所以 M1 判的不是「自证红」，而是【红话换了人】：直接拿丙喂 readSummary，
 *     改前的错词是①那句「一个数字都没有」，改后必须变成②那句「用例级」。
 *     ⇒ 证明①在真屏上【确实先响】，而它是承重的那道门、②是第二道。
 *     登记的残留：①唯一能独立拦住的形状（`Test Files N passed` + `Tests no tests`）
 *     今天复现不出来 —— 本机第一版就把 M1 写成「摘① ⇒ 自证红」，那是一发
 *     【红因来自别人】的假变异（round295 的 M4 那一族，本轮在我自己的机器上又长回来一次，
 *     靠"先想清楚红由哪一格产生"在落地前抓掉）。
 *  M2 摘掉格② ⇒ 自证必须【红在「丁」那一型上】（死一份、其余照跑）——
 *     那一型 Tests 行【有数字】，① 看不见 ⇒ 这一发证明②是【独立承重】的。
 *  M3 两格全摘 ⇒ 自证【静默通过】—— 那正是「这两格是唯一的门」的证据。
 *  M4 把自证整个摘空 ⇒ 同样静默通过 ⇒ 那两格【只被自证强制】。
 *     M3/M4 是一对：门没了没人知道，自证没了门等于没门。
 *
 * 切字节的可信度：与 .workbuddy/probe301-census.mjs 同一套切法，而那一套本轮
 * 用【四份真 vitest 屏】验过（它给出的读数与手抄实现不同、与真机器一致）。
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(import.meta.dirname, "..");
const TMP = join(ROOT, ".workbuddy", "tmp301-mut");

const TARGETS = [
  ".workbuddy/round292-mutate-org-node-criterion.mjs",
  ".workbuddy/round293-mutate-census.mjs",
  ".workbuddy/round293-mutate-gate-exemption.mjs",
];

/** 两格的锚点（【代码行本身】；每台各自核对过命中数，见 assertOnce）。 */
const CELL1 = { from: "if (!/\\d/u.test(seg)) {", to: "if (false) {" };
const CELL2_BY_TARGET = {
  ".workbuddy/round292-mutate-org-node-criterion.mjs": {
    from: "if (files.failed > 0 && tests.failed === 0) {",
    to: "if (false) {",
  },
};
const CELL2_DEFAULT = { from: "if (redFiles > 0 && red === 0) {", to: "if (false) {" };

/** 丙那一型的字节（真屏抄写）：M1 直接拿它喂 readSummary 比红话换了没有。 */
const PROBE_LOADFAIL =
  " Test Files  1 failed (1)\n      Tests  no tests\n";
/** 丁那一型：死一份、其余照跑 —— 只有格②看得见。 */
const PROBE_PARTIAL =
  " Test Files  1 failed | 1 passed (2)\n      Tests  25 passed (25)\n";

const preludes = (src) => {
  const one = (needle, takeFn) => {
    const i = src.indexOf(needle);
    if (i === -1) return "";
    const e = takeFn ? src.indexOf("\n}", i) : src.indexOf("\n", i);
    return src.slice(i, (e === -1 ? src.indexOf("\n", i) : e + (takeFn ? 2 : 0))) + "\n";
  };
  return (
    one("const ESC = String.fromCharCode(27);", false) + one("function strip(", true)
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
  "\nexport { readSummary, selfCheckParser };\n";

function assertOnce(text, anchor, where) {
  const n = text.split(anchor).length - 1;
  if (n !== 1) {
    throw new Error("锚点在 " + where + " 命中 " + n + " 次（要求恰好 1）：" + anchor.slice(0, 44));
  }
}

let seq = 0;
/**
 * 装一个临时模块。
 * ⚠ 两处踩过坑才写对的：
 *  ① 唯一性靠【文件名】不靠 `?v=` 查询串 —— Windows 上 `import(url + "?v=1")`
 *     直接 Cannot find module（本轮第一版就是这么写的）。
 *  ② 【装载失败必须让整台机器停下来】，不能被当成一次读数。本轮第一版把它读成
 *     「readSummary 抛了」⇒ M1/M2 全被判成命中，输出 18 发里一片假红假绿。
 *     一个把「没跑成」读成「跑出来是红」的机器，与它正在审计的那个洞同族。
 */
async function load(body, tag) {
  mkdirSync(TMP, { recursive: true });
  seq += 1;
  const file = join(TMP, tag + "-" + seq + ".mjs");
  writeFileSync(file, body, "utf8");
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new LoadFailure(
      "临时模块装载失败（" + file + "）⇒ 这台机器的读数全部不可信，停：" +
        String(err instanceof Error ? err.message : err).split("\n")[0],
    );
  }
  return mod;
}

/** 装载失败：与「被测解析器抛」严格分开的类型，见到它整台机器就该停。 */
class LoadFailure extends Error {}

/** 跑一次自证：返回 {passed, msg}。装载失败往上抛，不吞。 */
async function checkSelf(body, tag) {
  const mod = await load(body, tag);
  try {
    mod.selfCheckParser();
    return { passed: true, msg: "自证通过" };
  } catch (err) {
    // ⚠ 截断也害过一次：M3 的判式要 msg 里同时出现「丙」和「丁」，而第一版这里
    //   只留【前 2 行】⇒ 丁永远进不了 msg ⇒ 那一发【永远红】，红因是我的探针截了字。
    //   自证的红话是【每格一行】的列表 ⇒ 取前 6 行才装得下四格。
    const lines = String(err instanceof Error ? err.message : err).split("\n");
    return { passed: false, msg: lines.slice(0, 6).join(" / ").slice(0, 400) };
  }
}

/** 直接喂一份屏：返回 {threw, msg}。装载失败往上抛，不吞。 */
async function checkScreen(body, text, tag) {
  const mod = await load(body, tag);
  try {
    mod.readSummary(text, false);
    return { threw: false, msg: "没抛（读成了一次正常读数）" };
  } catch (err) {
    return {
      threw: true,
      msg: String(err instanceof Error ? err.message : err).split("\n")[0].slice(0, 120),
    };
  }
}

const results = [];
/** 装载失败时置位：整台机器【不出命中数】，因为那一串数没有任何一个可信。 */
let fatal = "";
try {
  for (const rel of TARGETS) {
    if (fatal !== "") break;
    const src = readFileSync(join(ROOT, rel), "utf8");
    const short = rel.replace(".workbuddy/round", "").replace("-mutate", "");
    const cell2 = CELL2_BY_TARGET[rel] ?? CELL2_DEFAULT;
    const good = assemble(src);
    assertOnce(good, CELL1.from, short + " 格①");
    assertOnce(good, cell2.from, short + " 格②");
    const push = (hit, label, msg) => results.push([hit, label, msg]);

    // M0 控制组
    const m0 = await checkSelf(good, short + "m0");
    push(m0.passed, short + " M0 一字不改（该过）", m0.msg);

    // M1 摘格①：判【红话换了人】，不判「自证红」——见文件头 M1 那段。
    const m1src = good.replace(CELL1.from, CELL1.to);
    assertOnce(m1src, CELL1.to, short + " M1");
    const before1 = await checkScreen(good, PROBE_LOADFAIL, short + "b1");
    const after1 = await checkScreen(m1src, PROBE_LOADFAIL, short + "a1");
    const c1word = "一个数字都没有";
    const m1ok =
      before1.threw &&
      before1.msg.includes(c1word) &&
      after1.msg !== before1.msg &&
      !after1.msg.includes(c1word);
    push(
      m1ok,
      short + " M1 摘格①（该换人：①的红话消失，由②接手）",
      "改前「" + before1.msg.slice(0, 26) + "…」→ 改后「" + after1.msg.slice(0, 26) + "…」",
    );

    // M2 摘格②：丁那一型必须失守（Tests 行有数字 ⇒ 格①看不见）。
    // ⚡ round302：这里喂的是 PROBE_PARTIAL（【没有】FAIL 行）⇒ 格③ 看不见它 ⇒
    //   这一发量的仍是「格② 独立拦得住什么」。若换成机器自证里那份丁夹具（本轮
    //   已改成真屏的 `[ 同一路径 ]`）⇒ 格③ 会接手 ⇒ 这一发【永远不命中】。
    const m2src = good.replace(cell2.from, cell2.to);
    assertOnce(m2src, cell2.to, short + " M2");
    const before2 = await checkScreen(good, PROBE_PARTIAL, short + "b2");
    const after2 = await checkScreen(m2src, PROBE_PARTIAL, short + "a2");
    const m2ok = before2.threw && !after2.threw;
    push(
      m2ok,
      short + " M2 摘格②（丁该失守：①③ 都看不见它 ⇒ ②独立承重）",
      "改前" + (before2.threw ? "抛" : "【没抛】") + " / 改后" + (after2.threw ? "仍抛" : "不抛了"),
    );
    // M2 的自证侧：自证必须当场抓住这件事，而不是等人去读矩阵。
    // ⚡ round302 改落点：夹具改成真屏形状后，丙/丁/戊 三型【都有方括号】⇒ 摘掉② 时
    //   它们仍被 ①/③ 拦住 ⇒ 自证唯一会报的是【己】（hook 炸、没有方括号、用例级 0 红）。
    //   ⇒ 「格② 独立承重」这句话现在由 己 钉，不再由 丁 钉（丁 与 丙 一样成了重叠型）。
    const m2self = await checkSelf(m2src, short + "s2");
    push(
      !m2self.passed && m2self.msg.includes("己") && !m2self.msg.includes("丁"),
      short + " M2′ 摘格②后【自证自己】该红在己上（丁 已由格③ 接手）",
      m2self.passed ? "【自证静默】⇒ 摘掉那一格现场没人响" : m2self.msg,
    );

    // M3 两格全摘：自证必须【红】。
    // ⚡ 这一发的预期本轮被自己的机器推翻过一次：第一版写「两格全摘 ⇒ 静默通过」，
    //   实测是【自证红在丙与丁上】。真口径是自证喂的就是那两型屏 ⇒ 门没了它必然抓到。
    //   ⇒ 又一次 round295 那条泛用主张（「矩阵里的预期也是主张，只有跑出来的红绿
    //   分布能打它」），且这次是【我这一轮刚写的机器】上复发。
    // ⚡⚡ round302 又改一次口，这次是【被本轮自己的两个改动同时改掉的】：
    //   ⑴ 补了格③；⑵ 把 丙/丁 夹具里我手写的假方括号 `[ x ]` 换成真屏的
    //   `[ 同一条路径 ]`（真 vitest 就是这么打的，实测三份 raw）。
    //   ⇒ 丙/丁/戊 三型现在【都有方括号】⇒ 都被格③ 接手 ⇒ 两格全摘时自证只报【己】。
    //   判式因此判「红话里有己，且不许有丙丁戊」：后半句同时钉住「格③ 真在替那三型挡」，
    //   而 round302-mutate-cell3.mjs 的 M1 从另一侧钉同一件事（摘③ ⇒ 戊 失守）。
    const m3src = m2src.replace(CELL1.from, CELL1.to);
    const m3 = await checkSelf(m3src, short + "m3");
    const stillThere = ["丙", "丁", "戊"].filter((n) => m3.msg.includes(n));
    push(
      !m3.passed && m3.msg.includes("己") && stillThere.length === 0,
      short + " M3 两格全摘（该【只】红在己上：丙丁戊 已由格③ 接手）",
      m3.passed
        ? "【静默通过】⇒ 自证是假的，它没在喂那几型"
        : m3.msg + (stillThere.length > 0 ? "\n      | ⚠ " + stillThere.join("、") + " 仍在红话里 ⇒ 格③ 没接手" : ""),
    );

    // M4 自证摘空而门还在：静默通过 —— 门还在，所以这不是洞，是 M5 的对照组。
    const m4src = good.replace(
      "function selfCheckParser() {",
      "function selfCheckParser() {\n  if (true) return; // 变异：自证被摘空",
    );
    assertOnce(m4src, "自证被摘空", short + " M4");
    const m4 = await checkSelf(m4src, short + "m4");
    push(
      m4.passed,
      short + " M4 只摘自证（该静默通过；门还在 ⇒ 与 M5 差的那一维就是自证）",
      m4.passed ? "静默通过" : "意外抛：" + m4.msg,
    );

    // M5 洞被【完整复原】：门全摘 + 自证摘空 ⇒ 静默通过。
    // 这一发才是「round295 之前那三台的状态」：装载失败会被读成控制组绿，
    // 而【现场没有任何东西会响】。M3/M4 各自只拆一侧，都还会响或都不算洞；
    // 只有两侧同拆才复现原洞 ⇒ 这三格（两门 + 自证）是一个整体。
    const m5src = m3src.replace(
      "function selfCheckParser() {",
      "function selfCheckParser() {\n  if (true) return; // 变异：自证被摘空",
    );
    const m5screen = await checkScreen(m5src, PROBE_PARTIAL, short + "m5s");
    const m5 = await checkSelf(m5src, short + "m5");
    push(
      m5.passed && !m5screen.threw,
      short + " M5 门全摘 + 自证摘空（= 原洞复原：该静默且不抛）",
      "自证" + (m5.passed ? "静默通过" : "红") + " / 丁那一屏" +
        (m5screen.threw ? "仍抛" : "【不抛】⇒ 装载失败读成控制组绿"),
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
  console.log("══════════ round301 装载失败门变异矩阵 ══════════");
  for (const [hit, label, msg] of results) {
    ok += hit ? 1 : 0;
    console.log((hit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  console.log("命中 " + ok + " / " + results.length);
  process.exitCode = ok === results.length ? 0 : 1;
}
