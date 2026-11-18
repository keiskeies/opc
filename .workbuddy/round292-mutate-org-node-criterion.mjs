/**
 * round292 · O8 动作 1：「提交时逐节点判 model_family」这条守卫有没有牙齿。
 *
 * 跑法：node .workbuddy/round292-mutate-org-node-criterion.mjs
 *
 * 打的是【生产代码】，不是测试。每一发抹掉一处真实实现，跑那三份测试，逐字节还原。
 *
 * ── 为什么有一发【该绿】 ────────────────────────────────────────────────
 * M2（改判 before 而不是 after）是【变异等价】的：applyChangeToGraph 对
 * reparent 只改 reports_to、对 add_edge 只加一条边，【两种 kind 都不碰任何
 * model_family】⇒ 判 before 与判 after 在这条判据上恒同解。
 * 于是没有任何测试该为它红。把它列进来并标 expectRed:false，是为了把这件事
 * 记成【量过的结论】而不是我的断言：这条守卫的「判 after」这个写法
 * 【不是】它可靠的原因，可靠的原因是它判【整张图】（M6 那一发才是它的证人）。
 * 反过来，如果哪天 applyChangeToGraph 开始改 model_family，M2 会【变成红】——
 * 那时它就不等价了，而这条记录会提醒下一个人重新看这一格。
 *
 * ⚠ 三条从 round291 带来的纪律（那份脚本当场把自己的文件写坏过一次）：
 *  ① 还原写【进场时读到的字节】，不用 replace 反推 —— 有些 `to` 是 `orig` 的子串；
 *  ② 还原在 finally 里，且在【校验之前】—— 否则 throw 会把变异永久留在文件里；
 *  ③ 所有锚点在第一发跑【之前】全部验一遍（plan()）—— round291 的 M2 锚点
 *     是格式化前的旧形状，那一发【从来没跑过】而没人发现。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** 变异打的测试：判据本体 + 提交路径 + 那条端到端。 */
const TEST_FILES = [
  "test/org/validate.test.ts",
  "test/org/versioning.test.ts",
  "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts",
];

const COMMIT = "packages/hub/src/org/commit.ts";
const VALIDATE = "packages/contracts/src/org/validate.ts";

const results = [];
/** @type {{rel:string,from:string,to:string,label:string,expectRed:boolean,note:string}[]} */
const MUTATIONS = [];

function mutate(rel, from, to, label, expectRed, note) {
  MUTATIONS.push({ rel, from, to, label, expectRed, note });
}

/* ── M1：把判据从提交路径上摘掉（判据还在，但没人调）────────────────── */
mutate(
  COMMIT,
  "  if (!families.ok) return { ok: false, reason: families.reason, code: families.code };",
  "  if (false && !families.ok) return { ok: false, reason: families.reason, code: families.code };",
  "M1 提交路径不再采纳这条判据",
  true,
  "旁路该重新变回 200；端到端那一发与 commit 层那两发都该红",
);

/* ── M2：改判 before（o.graph）而不是 after ────────────────────────────
 * ⚡ round301 改口（原判「变异等价，该绿」已过期）：round292 立这台时
 * applyChangeToGraph 不碰 model_family，before/after 恒同解 ⇒ 该绿。
 * round294 给契约加了带继承的 add_node 之后，新节点【只在 after 里】——
 * 判 before 就看不见它缺 model_family ⇒ 422 变 200，红在
 * 「证据④的反向 canary」那一发（本轮实测复现，非推断）。
 * 这台矩阵自己抓住了自己一条过期的「该绿」——round295 那条泛用主张
 * （「矩阵里的预期也是主张，只有跑出来的红绿分布能打它」）在本机复发并被证实。
 * 现在这一发是【判 before 的旁路】的点名门，比原来那句废话值钱。 */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  "  const families = everyNodeDeclaresModelFamily(o.graph);",
  "M2 判 before 而不是 after（round301 改口：add_node 后不再等价 ⇒ 该红）",
  true,
  "新节点只在 after 里 ⇒ 判 before 看不见它缺 model_family；红的正当位置是证据④反向 canary",
);

/* ── M3：只看 undefined，丢掉 trim ─────────────────────────────────────
 * 这是「yaml 里 model_family: 后面留空」那一格：读进来是空串/空格，不是 undefined。 */
mutate(
  VALIDATE,
  '    if (fam === undefined || fam.trim() === "") {',
  "    if (fam === undefined) {",
  "M3 空串/纯空格不再算缺（只判 undefined）",
  true,
  "该红在 test/org/validate.test.ts 那发「空串与纯空格同判」",
);

/* ── M4：拒绝理由里不点名角色 ─────────────────────────────────────────
 * 判据仍拦，但 CEO 拿到一句「有节点没配家族」而不知道该改哪一个。
 * 这一发红的是【可用性】那一格，不是安全那一格 —— 分开写是因为它们会被分开修。 */
mutate(
  VALIDATE,
  "        `角色 [${id}] 未声明 model_family，这次组织变更不予提交。` +",
  '        "某个角色未声明 model_family，这次组织变更不予提交。" +',
  "M4 理由里不点名是哪个角色",
  true,
  "该红在 test/org/validate.test.ts 那发「reason 里点名角色」",
);

/* ── M5：退回「只判这次变更涉及的节点」＝ 三层判据原来的射程 ───────────
 * 这一发要把守卫改回它补的那三层各自的样子：只看这次改动碰到的节点。
 * 它挡不住 ghost（ghost 不在那条边上），所以端到端与 validate 的反向 canary 该红。 */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  `  const families = (() => {
    const ids =
      o.change.kind === "add_edge"
        ? [o.change.edge.from, o.change.edge.to]
        : [o.change.child_role, o.change.new_parent_role];
    for (const i of ids) {
      const f = after.nodes[i]?.model_family ?? "";
      if (f.trim() === "") {
        return { ok: false, reason: "边端点缺家族", code: "unknown_model_family" };
      }
    }
    return { ok: true };
  })();`,
  "M5 只判这次变更涉及的节点（退回三层的射程）",
  true,
  "ghost 不在那条边上 ⇒ 旁路复活；反向 canary 该红",
);

/* ── M6：「只判新增节点」那个恒真版本 —— 本轮我确实先写过它 ────────────
 * 这是全组最有牙齿的一发。它看起来【比正确版本更精准】（「只判这次新加的嘛，
 * 合理」），而它对旁路【恒为空】：applyChangeToGraph 两种 kind 都把 before.nodes
 * 原样展开，所以偷偷塞进来的节点在 before 里【也在】⇒ 差集为空 ⇒ 双向恒真。
 * 如果这一发【绿】，说明本组测试抓不住「把守卫精准化到什么都不判」这种改法，
 * 而那是本仓最贵的一族缺陷（一条看起来更合理的恒真断言）。 */
mutate(
  COMMIT,
  "  const families = everyNodeDeclaresModelFamily(after);",
  "  const families = everyNodeDeclaresModelFamily({\n    nodes: Object.fromEntries(\n      Object.entries(after.nodes).filter(([id]) => !(id in o.graph.nodes)),\n    ),\n    edges: [],\n  });",
  "M6 「只判新增节点」—— 看着更精准的那一版恒真",
  true,
  "旁路节点在 before 里也在 ⇒ 差集为空 ⇒ 拦不到；本组必须抓住这种改法",
);

/* ── 锚点先全部验一遍，再跑第一发 ───────────────────────────────────── */
function plan() {
  const originals = new Map();
  const bad = [];
  for (const m of MUTATIONS) {
    const text = originals.get(m.rel) ?? readFileSync(join(ROOT, m.rel), "utf8");
    originals.set(m.rel, text);
    const hits = text.split(m.from).length - 1;
    if (hits !== 1) bad.push(m.rel + " :: [" + m.label + "] 锚点命中 " + hits + " 次（要恰好 1 次）");
    if (m.to === m.from) bad.push(m.rel + " :: [" + m.label + "] to 与 from 相同 = 空变异");
  }
  if (bad.length > 0) {
    console.error("锚点校验失败，【一发都没跑】：\n  " + bad.join("\n  "));
    process.exit(1);
  }
  return originals;
}

/**
 * 从 vitest 的输出里读「红了几发 / 红了几份文件」。
 *
 * ⚠ 两个坑，都是实测撞到的（第一版两个都中了，于是 M1~M6 全部读成「红发=0」，
 *    而 expectRed 那几发因此【判成未命中】—— 一个把红读成绿的解析器，
 *    比没有解析器更坏：它会安静地让整张变异矩阵失去意义）：
 *  ① vitest 在标签与数字之间夹了 ANSI：真实字节是
 *    "\u001b[2m      Tests \u001b[22m \u001b[1m\u001b[32m43 passed\u001b[39m"，
 *    所以【必须先剥 ANSI】再 match。
 *  ② 全绿时它【不打印 failed 那一段】（只有 "43 passed (43)"）。
 *    所以「读不到 failed」有两种含义：真的全绿，或者格式变了。
 *    两者必须分开 —— 格式变了要【当场抛】，不能当 0。判据是那一行摘要本身在不在。
 */
function readSummary(out, wantFail) {
  const clean = out.replace(/\u001b\[[0-9;]*m/g, "");
  const grab = (label) => {
    const m = clean.match(new RegExp("^\\s*" + label + "\\s+(.+)$", "m"));
    if (m === null) {
      throw new Error(
        "读不到 vitest 的「" + label + "」摘要行 —— 输出格式变了或被别的输出污染了。" +
          "【不能】当 0 处理：那会把红读成绿，整张矩阵会假绿。摘要尾部：\n" +
          clean.slice(-600),
      );
    }
    const seg = m[1];
    const failed = Number((seg.match(/(\d+) failed/) ?? [0, "0"])[1]);
    const passed = Number((seg.match(/(\d+) passed/) ?? [0, "0"])[1]);
    // round301 补：Tests 行【两个数都没有】的那一型。
    // 真 vitest 在「整份文件装载失败、一个用例都没跑到」时把 Tests 行打成
    // `      Tests  no tests` —— 没有 failed 也没有 passed。本机第一版把这种
    // 「读不到数字」当成 0，于是 M0 控制组（应绿）拿到 红发=0 ⇒ 判【命中】，
    // 而它那句前提「绿是后面每一发红的前提」是在【什么都没跑】上成立的。
    // 三发文件的语料里死一份、另两发照跑 ⇒ 变异照红 ⇒ 整张矩阵可以 exit 0。
    // 判「两个数都缺」而不是判「等于 0」：全绿那一屏是「0 failed 缺失 + N passed」，
    // 有 passed 在 ⇒ 不误伤真绿（这条不对称写在下面的自证里，被钉住了）。
    if (!/\d/u.test(seg)) {
      throw new Error(
        "「" + label + "」摘要行里【一个数字都没有】（实得：" + seg.trim() + "）—— " +
          "这一型是「一个用例都没跑到」（装载失败 / 采集失败），不是「全部通过」。" +
          "【不能】当 0：控制组会在什么都没跑的前提下自证通过。摘要尾部：\n" +
          clean.slice(-600),
      );
    }
    return { failed, passed };
  };
  const files = grab("Test Files");
  const tests = grab("Tests");
  // round301 补：文件级红而用例级全绿 ⇒ 归因失真，不许读成任何一种结果。
  // 与 round298 那台「文件红了但读不到 FAIL 文件名 ⇒ 抛」同族而更宽：本机没有
  // 用例名归因（它只数数），所以这一格是唯一能挡住「装载失败被读成控制组绿」的门。
  // 危害方向：只有【死一份、其余照跑】时最危险 —— 那时 tests 有数字，上一格不响。
  // ⚠ 登记的残留：若同一屏里【另有真红的用例】（tests.failed > 0），这一格不响，
  //   装载失败会被并进那一发正常的红里读成「命中」—— 本机没有用例名归因，
  //   分不清「打到判据的那发红」与「另一份文件炸了」。要堵得先给它加 FAIL 行归因
  //   （round296 起那几台的做法），那是另起一轮的账。
  if (files.failed > 0 && tests.failed === 0) {
    throw new Error(
      "Test Files 红了 " + files.failed + " 份而用例级【一条红都没有】⇒ 这些文件的红" +
        "是【装载/采集期】失败（或 hook 失败），不是判据红。此时" +
        "「红发=0」既不能说变异没打到，也不能说控制组是绿的。摘要尾部：\n" +
        clean.slice(-600),
    );
  }
  /* round302 补（格③）：这一格【不依赖别处有没有红】⇒ 它补的正是 round301 登记的
     那格残留。格② 只在「用例级 0 红」时响，而真实的一次装载失败常常【和另一发的
     真红同屏】（变异打坏 src ⇒ 判据那一发红，同时夹具那份装载不起来）：那时格①②
     都不响，装载失败被【并进那一发正常的红】里读成「命中」。
     四份真屏实测（.workbuddy/probe302-{mixed,hook,hookgreen,shapes}-raw.txt）：
       语法坏 / import 找不到 ⇒ `FAIL  <文件> [ <同一个文件> ]`  ← 变异真会造出的两型
       一个用例红            ⇒ `FAIL  <文件> > suite > 用例名`
       beforeAll 里抛        ⇒ `FAIL  <文件> > suite`（用例级会长出 skipped）
     ⇒ 「方括号里把同一条路径重复一遍」是装载失败的【专属】特征，实测误报面为空。 */
  const deadFiles = [];
  for (const deadLine of clean.split("\n")) {
    const deadHit = /^\s*FAIL\s+(\S+)\s+\[\s*(\S+)\s*\]\s*$/u.exec(deadLine);
    if (deadHit !== null && deadHit[1] === deadHit[2]) deadFiles.push(deadHit[1]);
  }
  if (deadFiles.length > 0) {
    throw new Error(
      "读到装载失败那型的 FAIL 行（" + deadFiles.join("、") + "）⇒ 整份文件没跑起来，" +
        "这一发的读数不可信。格①② 在这种屏上【不响】（Tests 行有数字、用例级也有红），" +
        "只有这一格认得它。尾部：\n" + clean.slice(-800),
    );
  }
  if (wantFail !== undefined && (tests.failed > 0) !== wantFail) {
    // 控制组专门用来证明上面这套解析【真的能分辨红与绿】。
    throw new Error(
      "控制组形状不对：期望" + (wantFail ? "红" : "绿") + "，实际 红发=" + tests.failed,
    );
  }
  return { files, tests };
}

/**
 * 这台机器自己的读数自证（round301 补，round295 起每台新机器都有的那一格）。
 *
 * 三段【真屏逐行抄写】（不是编的字节）：全绿 / 一发用例红 / 整份装载失败。
 * 后两段的字节来自 `.workbuddy/probe301-green-raw.txt` 与
 * `probe301-loadfail-raw.txt`（本轮真跑抓的，色码是真的 ESC）。
 * 判的是【这台读得对不对】，不打判据；分母数出来，不写死。
 */
function selfCheckParser() {
  const esc = String.fromCharCode(27);
  const wrap = (s) => s.split("ESC").join(esc);
  const green = wrap(
    " Test Files ESC[22m ESC[1mESC[32m1 passedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
      "      Tests ESC[22m ESC[1mESC[32m25 passedESC[39mESC[22m ESC[90m (25)ESC[39m\n",
  );
  const oneRed = wrap(
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/org/validate.test.ts > s > c\n" +
      " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
      "      Tests ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (2)ESC[39m\n",
  );
  // 装载失败那一屏的真形状：Test Files 有 failed，Tests 行是 `no tests`。
  const loadFail = wrap(
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/org/validate.test.ts ESC[2m[ test/org/validate.test.ts ]ESC[22m\n" +
      " Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22m ESC[90m (1)ESC[39m\n" +
      "      Tests ESC[22m ESC[2mno testsESC[22m\n",
  );
  // 最危险的那一型：死一份、另两份照跑 ⇒ Tests 行有数字，上一发拦不住。
  const partialLoadFail = wrap(
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/org/versioning.test.ts ESC[2m [ test/org/versioning.test.ts ]ESC[22m\n" +
      " Test Files ESC[22m ESC[1mESC[31m1 failed | 2 passedESC[39mESC[22m ESC[90m (3)ESC[39m\n" +
      "      Tests ESC[22m ESC[1mESC[32m84 passedESC[39mESC[22m ESC[90m (84)ESC[39m\n",
  );
  /* round302 补两型，各钉【一格】—— 加了格③ 之后，丁那一屏两格都拦得住，
     所以「摘掉某格还剩几格」这件事必须有【各自唯一】的屏才能量出来：
       戊 = 装载失败【加】另一发真红（probe302-mixed-raw.txt）⇒ 只有格③ 认得：
            Tests 行有数字（①不响）而用例级【也有】红（②不响）⇒ 旧三格全静默，
            这正是 round301 登记的那格残留。
       己 = hook 炸 + 其余全绿（probe302-hookgreen-raw.txt）⇒ 只有格② 认得：
            FAIL 行是 `FAIL <文件> > <suite>`（没有方括号 ⇒ ③不响）、Tests 行有数字、
            而用例级 0 红 ⇒ ②响。没有己，摘掉② 时丁照样被③ 拦住 ⇒ ② 看起来像装饰。
     ⚠ 登记的残留：hook 炸【加】另一发红（probe302-hook-raw.txt）三格都不响 ——
       那种屏上「打到判据的红」与「别处炸的红」在字节上分不开，要分只能靠用例名。 */
  const deadWithRed = wrap(
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302dead.test.tsESC[2m [ test/arch/probe302dead.test.ts ]ESC[22m\n" +
      "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302red.test.tsESC[2m > ESC[22mprobe302 真红ESC[2m > ESC[22m这一发故意红\n" +
      "ESC[2m Test Files ESC[22m ESC[1mESC[31m2 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (3)ESC[39m\n" +
      "ESC[2m      Tests ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m5 passedESC[39mESC[22mESC[90m (6)ESC[39m\n",
  );
  const hookGreen = wrap(
    "ESC[41mESC[1m FAIL ESC[22mESC[49m test/arch/probe302hook.test.tsESC[2m > ESC[22mprobe302 hook 炸\n" +
      "ESC[2m Test Files ESC[22m ESC[1mESC[31m1 failedESC[39mESC[22mESC[2m | ESC[22mESC[1mESC[32m1 passedESC[39mESC[22mESC[90m (2)ESC[39m\n" +
      "ESC[2m      Tests ESC[22m ESC[1mESC[32m4 passedESC[39mESC[22mESC[2m | ESC[22mESC[33m1 skippedESC[39mESC[90m (5)ESC[39m\n",
  );
  const problems = [];
  let checks = 0;
  const mustThrow = (name, text) => {
    try {
      const s = readSummary(text, false);
      problems.push(
        "自证" + name + "：【没抛】—— 读成了 红发=" + s.tests.failed +
          " 红文件=" + s.files.failed + "，控制组会在什么都没跑上判命中",
      );
    } catch {
      // 这正是要求的形状。
    }
    checks += 1;
  };
  /** 与 mustThrow 同，但还要【红话出自哪一格】——见下面戊/己那段注释。 */
  const mustThrowNamed = (name, text, needle) => {
    try {
      const s = readSummary(text, false);
      problems.push(
        "自证" + name + "：【没抛】—— 读成了 红发=" + s.tests.failed +
          " 红文件=" + s.files.failed,
      );
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      if (!msg.includes(needle)) {
        problems.push(
          "自证" + name + "：抛是抛了，但红话【不是那一格】（要找「" + needle +
            "」，实得「" + msg.split("\n")[0].slice(0, 70) + "」）⇒ 红因来自别人 = 假变异",
        );
      }
    }
    checks += 1;
  };
  try {
    const s = readSummary(green, false);
    if (s.tests.failed !== 0 || s.files.failed !== 0) {
      problems.push("自证甲：真绿屏读成了红");
    }
  } catch (e) {
    problems.push("自证甲：真绿屏【抛了】⇒ 判据把绿读死，M0 永远红：" + String(e.message).slice(0, 90));
  }
  checks += 1;
  try {
    const s = readSummary(oneRed);
    if (s.tests.failed !== 1) {
      problems.push("自证乙：一发用例红读成 红发=" + s.tests.failed);
    }
  } catch (e) {
    problems.push("自证乙：真红屏抛了：" + String(e.message).slice(0, 90));
  }
  checks += 1;
  mustThrow("丙", loadFail);
  mustThrow("丁", partialLoadFail);
  /* 戊/己【判红话出自哪一格】而不是只判「抛了」：戊 在 292 上就算摘掉格③ 也会抛
     （wantFail=false 那条控制组判式会接手），己 摘掉格② 也会抛（格③ 之外还有别的门）
     ⇒ 只判「抛了」就是 round295 M4 那一族【红因来自别人】的假变异。
     判据用两格红话里各自唯一的句子（格③ 那句由四台共用同一段字节，见台账 round302 ②）。 */
  mustThrowNamed("戊（装载失败+另一发红）", deadWithRed, "装载失败那型的 FAIL 行");
  mustThrowNamed("己（hook 炸+其余绿）", hookGreen, "用例级【一条红都没有】");
  if (problems.length > 0) {
    throw new Error(
      "这台机器自己的读数不可信，【一发都没跑】（" + checks + " 格里红 " + problems.length + " 格）：\n  " +
        problems.join("\n  "),
    );
  }
  console.log(
    "  读数自证  " + checks + " 格全过（真绿/真红读对，四种装载/采集失败屏都抛，" +
      "其中 戊 只有格③ 认得、己 只有格② 认得）",
  );
}
selfCheckParser();

function run(label, expectRed, note) {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", ...TEST_FILES],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  // 控制组（label 以 M0 开头）额外自证解析器能分辨红绿。
  const { files, tests } = readSummary(out, label.startsWith("M0") ? false : undefined);
  const hit = expectRed ? tests.failed > 0 : tests.failed === 0;
  results.push([
    hit,
    label,
    expectRed ? "应红" : "应绿",
    "红发=" + tests.failed + " 绿发=" + tests.passed + " 红文件=" + files.failed,
    "",
    note,
  ]);
  console.log(
    (hit ? "  命中    " : "  未命中  ") +
      label +
      "  [" +
      (expectRed ? "应红" : "应绿") +
      "]  红发=" +
      tests.failed +
      " 红文件=" +
      files.failed,
  );
}

function execute(m, originals) {
  const p = join(ROOT, m.rel);
  const orig = originals.get(m.rel);
  writeFileSync(p, orig.replace(m.from, m.to));
  let restored = false;
  try {
    run(m.label, m.expectRed, m.note);
  } finally {
    writeFileSync(p, orig);
    restored = readFileSync(p, "utf8") === orig;
  }
  if (!restored) throw new Error("还原后字节不一致，必须手工修：" + m.rel);
}

const originals = plan();

run("M0 控制组：一字不改", false, "绿是后面每一发红的前提；同时自证这台上的计数读得出红与绿");
for (const m of MUTATIONS) execute(m, originals);

console.log("\n══════════ round292 变异矩阵 ══════════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state + " | " + note + " | " + err);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
