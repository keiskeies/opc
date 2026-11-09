// 出口门禁证据自检：一条命令复算我报给你的每一项可复算主张。
// 只读，不写任何文件，不改任何状态。任何一项判不了就退非零 —— 不给【exit 0 却输出 undefined】留活路。
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { relative, sep } from "node:path";

const ROOT = process.cwd();
const NL = String.fromCharCode(10);
const fail = []; // 收集所有【判不了 / 不符】的项，最后统一决定退出码
const say = (s) => console.log(s);

const rel = (p) => {
  const abs = ROOT + "/" + p;
  if (!existsSync(abs)) { fail.push("读不到 " + p); return null; }
  return readFileSync(abs, "utf8").split(NL);
};

const git = (args) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) { fail.push("git " + args.join(" ") + " 退出码 " + r.status); return null; }
  return String(r.stdout);
};

const ok = (cond, label, detail) => {
  say((cond ? "  PASS  " : "  ★FAIL ") + label + (detail ? "   → " + detail : ""));
  if (!cond) fail.push(label);
};
// 主题取《消息内存的第一行》，不取 git 的 %s：%s 给的是首个段落，第二行没留空行时
// 它会把正文拼进主题，「绝不读正文」就成了错话 —— 实测两路径差在六条折叠消息上。
// 记录分隔符用 git 展开的 %x1e；消息文本若含它，下面的数量自检会报错，不静默错切。
const RECORD_SEP = String.fromCharCode(30);

function subjectOf(raw) {
  const first = String(raw).replace(/^\n+/, "").split(NL)[0];
  return first === undefined ? "" : first.trim();
}


// —— C1 门禁是否被标记通过：只看【主题】，绝不读正文；主题由 subjectOf 切第一行得到
say(NL + "C1 出口门禁有没有被标记通过（只看提交主题）");
const rawLog = git(["log", "--all", "--format=%x1e%B"]);
let subjects = [];
if (rawLog !== null) {
  const records = rawLog.split(RECORD_SEP).filter((x) => x.trim() !== "");
  const claimed = Number((git(["rev-list", "--all", "--count"]) ?? "NaN").trim());
  if (records.length !== claimed) {
    fail.push("C1 记录数与 rev-list 数不合（" + records.length + " vs " + claimed + "），主题可能被错切");
    subjects = [];
  } else {
    subjects = records.map(subjectOf);
  }
}
// 正面对照：折叠与未折叠两种消息形状都只取得到第一行；subjectOf 退化成「整段当主题」就会红。
ok(
  subjectOf("docs(t): 主题行\n紧跟的正文行") === "docs(t): 主题行" &&
    subjectOf("docs(t): 主题行\n\n空行后的正文行") === "docs(t): 主题行",
  "阳性对照：主题切取在两种消息形状下都只取第一行",
  "两例各半",
);
say("  扫描到的主题数：" + subjects.length);
ok(subjects.length > 0, "主题样本非空", String(subjects.length));
const gateType = ["chor", "e(phase0)"].join(""); // 拆拼：避免这份文件自身成为被搜索的样本

const t1 = subjects.filter((s) => s.trim().startsWith(gateType)).length;
const words = ["mar", "passed", "ga", "te"].join("|").replace("|ga|te", "|gate");
// —— 阳性对照：搜索串若退化（拆拼写错 / 正则拼错），上面两条会【永远数到 0】＝永远 PASS。
// 这里用第二条独立推导路径（ASCII 码位）各自构造一遍，两路必须互证；不一致即判 FAIL。
// 码位数组不是被搜索的字面串 ⇒ 本文件自身不会污染它要检查的那些口径。
const EXPECT_GATE = String.fromCharCode(
  99, 104, 111, 114, 101, 40, 112, 104, 97, 115, 101, 48, 41,
);
const POS_WORDS = [
  String.fromCharCode(109, 97, 114, 107),
  String.fromCharCode(112, 97, 115, 115, 101, 100),
  String.fromCharCode(103, 97, 116, 101),
];
ok(gateType.length > 0 && gateType === EXPECT_GATE, "阳性对照：门禁类型搜索串两路互证", gateType === EXPECT_GATE ? "一致" : "★不一致：" + gateType);
ok(
  POS_WORDS.every((w) => new RegExp(words).test(w)),
  "阳性对照：三个英文词的正则确实各自命中自己",
  POS_WORDS.filter((w) => !new RegExp(words).test(w)).join(",") || "全部命中",
);
const t2 = subjects.filter((s) => new RegExp(words).test(s)).length;
ok(t1 === 0, "主题以门禁提交类型前缀开头 = 0", String(t1));
ok(t2 === 0, "主题含 mark/passed/gate 任一词 = 0", String(t2));
say("  口径说明：这两条只取每条消息的【第一行】，正文一字不读。任何【读提交正文】的搜索都会被我自己的复述污染，故一律不作证据。");

// —— C2 判据 1 的验收权归谁：直接看设计文档那一列的表头
say(NL + "C2 判据 1 的验收权在谁的列里（看表头原文，不必信我转述）");
const spec = rel("docs/OPC-OS-设计文档.md");
if (spec) {
  // 必须用【三列俱全的表头特征】定位，不能只搜「验收标准」：
// 该词在设计文档里出现 17 次，只搜它第一处命中 l.92 的散文，会给出假 PASS —— 实测踩过。
const hi = spec.findIndex(
  (l) => l.includes("阶段") && l.includes("周期") && l.includes("验收标准"),
);
  ok(hi >= 0, "定位到那张阶段表的表头行", hi >= 0 ? "l." + (hi + 1) : "没找到");
  if (hi >= 0) {
  say("  原文：" + spec[hi].trim());
  ok(spec[hi].includes("CEO 亲自判断"), "那一列的表头自己点名 CEO 亲自判断", spec[hi].includes("CEO 亲自判断") ? "验收权不在实现层" : "★表头没点名 CEO");
}
}

// —— C3 判据 2 的读法分歧：计划与规格的同一项，逐字比对，第一个不同的字打出来
say(NL + "C3 判据 2 那句话：计划写的 vs 规格写的（读法分歧的事实根）");
const plan = rel("docs/superpowers/plans/2026-11-06-opc-os-development-plan.md");
if (plan && spec) {
  const pl = plan.findIndex((l) => l.includes("出口标准（对应规格") && l.includes("Checkpoint"));
  const sl = spec.findIndex((l) => l.includes("中途手动打断并从 Checkpoint 恢复"));
  ok(pl >= 0 && sl >= 0, "两侧都定位到那一行", "计划 l." + (pl + 1) + "  规格 l." + (sl + 1));
  if (pl >= 0 && sl >= 0) {
    const colon = String(plan[pl]).indexOf(String.fromCharCode(0xff1a));
    const left = colon >= 0 ? String(plan[pl]).slice(colon + 1) : "";
    const cells = String(spec[sl]).split("|").map((c) => c.trim());
    const right = cells.length ? cells[cells.length - 2] : "";
    ok(left.length > 0 && right.length > 0, "两侧提取都非空（空=提取失败，不算比对结果）", "计划侧 " + left.length + " 字，规格侧 " + right.length + " 字");
    let diffs = 0;
    const A = left.split(String.fromCharCode(0xff1b));
    const B = right.split(String.fromCharCode(0xff1b));
    say("  计划侧 " + A.length + " 项，规格侧 " + B.length + " 项");
    for (let k = 0; k < Math.max(A.length, B.length); k++) {
      const a = (A[k] ?? "").trim();
      const b = (B[k] ?? "").trim();
      if (a === b) { say("    第 " + (k + 1) + " 项：逐字相同"); continue; }
      diffs += 1;
    let at = 0;
      while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
      say("    第 " + (k + 1) + " 项：不同，首个差异在第 " + (at + 1) + " 字");
      say("      计划：" + a);
      say("      规格：" + b);
    }
    ok(diffs > 0, "至少发现一处逐字差异（0 处 = 分歧消失或提取退化，须重新判定）", "发现 " + diffs + " 处");
    say("  ⇒ 哪一处差异决定判据 2 的验收，由你定；我不替你选。");
    say("  发现差异处数：" + diffs);
  }
}

// —— C4 等你回答的三样东西，确实写在决策文档里（不只在对话里）
  // —— C4 等你拍板的东西是否写在决策文档的小节标题里。域只覆盖 0006 一篇，判定方向是不低于阈值、
  //   不是等于阈值。这两件事原先没写出来，读者把【不低于三条】读成了【正好三样】；其余篇里同样点名等你
  //   的标题由双向核对登记表那条守卫守着，不在本检查的域内。域与方向现在写进下面的标题。
say(NL + "C4 等你拍板的东西是否已写进决策文档的小节标题里（域只有 0006 一篇，方向是不低于阈值）");
const d6 = rel("docs/decisions/0006-cli-resume-and-identity.md");
if (d6) {
  const pend = d6.map((l, n) => ({ l, n })).filter((o) => /^#{2,4}\s+\d+(\.\d+)?\.?\s.*CEO/.test(String(o.l)));
  for (const o of pend) say("  l." + String(o.n + 1).padStart(5) + "  " + String(o.l).replace(/^#+\s*/, "").slice(0, 92));
  ok(pend.length >= 3, "点名等 CEO 的小节 ≥ 3", String(pend.length));
}

// —— C5 工作区与提交计数：让任何后续改动都能被看出来
say(NL + "C5 仓库状态");
const n = git(["rev-list", "--count", "HEAD"]);
ok(n !== null && Number(n) > 0, "提交总数可由 rev-list 复算", String(Number(n)) + " 条");
const dirty = (git(["status", "--porcelain", "--untracked-files=all"]) ?? "").split(NL).filter(Boolean);
say("  未提交改动 " + dirty.length + " 项" + (dirty.length ? "（说明你手上正有改动，下面结论以工作区为准）" : ""));
// HEAD 那行同样不再用 %s：它打印的是「主题」，就得用同一个切取函数，不能两处两个口径。
const headRaw = git(["log", "-1", "--format=%h%x1e%B"]);
let headLine = "(取不到)";
if (headRaw !== null) {
  const parts = headRaw.split(RECORD_SEP);
  headLine = parts[0] + " " + subjectOf(parts[1] === undefined ? "" : parts[1]);
}
say("  HEAD = " + headLine.trim().slice(0, 92));

// —— C6 判据 2 的事实前提：CLI 真正跑的那张图里，到底有没有可打断的点。
//   口径必须从代码推导，不许硬编码文件名：先读 cli.ts 找出它 import 的图构建函数，
//   再定位该函数所在源文件，数其中【非注释行】的 interrupt( 调用。
//   我复算时先数到 2、差点判这条主张错；两处都能解释掉，解释靠的就是这条 import 链。
say(NL + "C6 判据 2 的前提：CLI 可达的那张图里有没有可打断的点（读法之争的事实根）");
const countCalls = (text) => {
  let n = 0;
  let inBlock = false;
  for (const raw of String(text).split(NL)) {
    const t = raw.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      continue;
    }
    if (t.startsWith("/*")) {
      if (!t.includes("*/")) inBlock = true;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("*/")) continue;
    n += (t.match(/\binterrupt\(/g) ?? []).length;
  }
  return n;
};
const cliSrc = rel("packages/hub/src/cli.ts");
if (cliSrc) {
  const joined = cliSrc.join(NL);
  const m = joined.match(/import\s*\{[^}]*\bbuild(\w*Graph)\b[^}]*\}\s*from\s*["']([^"']+)["']/);
  ok(Boolean(m), "从 cli.ts 推导出 CLI 用的图构建函数（推不出即判不了，不算通过）", m ? m[1] + " ← " + m[2] : "★没推导出来");
  if (m) {
    const mod = String(m[2]).replace(/\.js$/, "") + ".ts";
    const graphRel = "packages/hub/src/" + mod.replace(/^\.\//, "");
    const gsrc = rel(graphRel);
    ok(Boolean(gsrc), "定位到图构建函数所在文件", graphRel);
    if (gsrc) {
      const n = countCalls(gsrc.join(NL));
      ok(n === 0, "CLI 那张图里可执行的 interrupt 调用 = 0", String(n) + " 处");
    }
  }
  // 阳性对照：计数函数若坏掉（恒返回 0），上面那条会永远 PASS。
  // 样本【内联合成】而非取自仓库文件 —— 我两次凭记忆挑文件都挑错（一次挑了个不含该调用的文件，
  // 一次把注释行和 it() 标题字符串也算成可执行调用）。内联样本能精确控制期望值，
  // 且三种注释形态各对应计数函数里一个失效分支，坏在哪一分支就报得出来。
  // 样本只放【可执行 1 行 + 注释 3 种形态】，期望精确为 1。
  // （上一版我多放了一行【节点在 interrupt() 之前写的 events】想模拟测试标题里的字符串，
  //  却没写引号 —— 那是货真价实的裸文本，计数函数数到 2 是正确的，错的是我的期望值。）
  const SAMPLE = [
    "  interrupt({ reason: 1 });",
    " * interrupt() 文档注释里提到",
    " // interrupt( 行注释里提到",
    " /* interrupt( 块注释里提到",
    " 这行在块注释内部",
    "  */",
  ].join(NL);
  const sampleCounted = countCalls(SAMPLE);
  ok(sampleCounted === 1, "阳性对照：数出可执行调用并排除三种注释形态", "期望 1，实数 " + sampleCounted);
  // 明文记录一个已知局限，不假装能排除它：字符串字面量里的 interrupt( 也会被计入，
  // 所以本计数【只会虚高、不会漏报】。对本检查是安全方向 —— 它答的是【有没有可打断点】，
  // 宁可多报也不许漏报。真实语料那条断言就是用具体数字钉住这个虚高的。
  say("  已知局限：字符串字面量内的 interrupt 也会计入 ⇒ 此计数只虚高、不漏报（对本检查是安全方向）");
  // 第二道：真实语料里确有可执行调用 ⇒ 计数函数对真文件也数得出来（不只是对内联样本有效）。
  const POSF = "packages/hub/test/graph/interrupt-resume.test.ts";
  const posSrc = rel(POSF);
  if (posSrc) {
    const txt = posSrc.join(NL);
    const rawHits = txt.split(NL).filter((l) => l.includes("interrupt(")).length;
    const counted = countCalls(txt);
    ok(rawHits > 0 && counted > 0, "阳性对照：真实测试语料里也数得出调用", "原文 " + rawHits + " 行，计数 " + counted);
    ok(counted < rawHits, "阳性对照：注释行没被算进可执行计数（字符串仍计入，见上面那条已知局限）", rawHits + " 行原文 → 计数 " + counted);
  }
  // 同一次复算查出的、判读法时该摆在桌面上的事实（不计入失败）：
  // src 树里确有一处可执行 interrupt，但它在 poc 里，不在 tsc 的 include，也无编译范围内文件引用它。
  const pocRel = "packages/hub/src/poc/graph.mjs";
  const pocSrc = rel(pocRel);
  if (pocSrc) {
    say("  已知事实（不计入失败）：" + pocRel + " 确有可执行 interrupt 调用 " + countCalls(pocSrc.join(NL)) + " 处");
    say("  它不在 tsc 的 include（src/**/*.ts）内，且编译范围内无任何文件引用它，故不影响上面那条。");
  }
  // 谓词与主检查共用同一个（README 记的设计：否则判定坏掉时对照也跟着绿）。
  // 这个零命中此前没有任何对照：实测两个变异体都能存活 —— 把 ls-files 的路径写成不存在的目录
  // （枚举悄悄变空）、把谓词正则改成永不命中，主检查都照样 PASS；git 对拼错的路径退出码是 0，
  // 所以【退出码非零就记失败】那道防线管不到它。下面两条对照就是补这两扇：
  // 一条钉住枚举非空，一条钉住同一个谓词在已知含 poc/ 的真实语料上数得出来。
  const refersToPoc = (text) => /poc\//.test(text);
  const compileTs = (git(["ls-files", "packages/hub/src"]) ?? "")
    .split(NL)
    .filter((f) => /\.tsx?$/.test(f));
  const compileRefs = compileTs.filter((f) => {
    const t = rel(f);
    return t !== null && refersToPoc(t.join(NL));
  });
  ok(compileRefs.length === 0, "编译范围内没有任何文件引用 poc（上述已知事实确实不可达）", compileRefs.length ? "★有人引用：" + compileRefs.join(",") : compileTs.length + " 个 .ts/.tsx 里 0 个引用者");
  ok(compileTs.length >= 10, "阳性对照：主检查扫到的文件集非空（枚举路径写错时这条先红）", compileTs.length + " 个 .ts/.tsx");
  const pocPeers = (git(["ls-files", "packages/hub/src/poc"]) ?? "").split(NL).filter((f) => f !== "");
  const peerRefs = pocPeers.filter((f) => {
    const t = rel(f);
    return t !== null && refersToPoc(t.join(NL));
  });
  ok(peerRefs.length > 0, "阳性对照：同一个谓词在已知含 poc/ 的真实文件上数得出来", peerRefs.length + " / " + pocPeers.length + " 个命中");
}

// —— C7 决策入口里不许出现【轮次相对指称】：轮次在仓库里数不出来，指称就落不了地。
//   词表来自实测枚举（不靠记忆）。只有入口是我承诺过的范围；其余文档的存量只报数、不判失败 ——
//   那多数是失误记录的正文，「本轮」在那里是作者的第一人称时间锚点，批量重写等于替 CEO
//   决定改掉他已经读过的决策记录，不是我单方面能做的动作。
say(NL + "C7 决策入口里的轮次相对指称（轮次数不出来 ⇒ 指称落不了地）");
const ROUND_WORDS = [
  "本轮", "上一稿", "这轮", "同轮", "这一轮", "前一轮", "上一轮", "下轮", "本轮次", "此次改动", "这次改动", "本次改动", "后一轮",
];
const hasRoundWord = (line) => {
  for (const w of ROUND_WORDS) if (String(line).includes(w)) return w;
  return null;
};
const ENTRY = "docs/INDEX.md";
const entryLines = rel(ENTRY);
if (entryLines) {
  const hits = [];
  entryLines.forEach((l, n) => {
    const w = hasRoundWord(l);
    if (w) hits.push("l." + (n + 1) + " 含 " + w);
  });
  ok(hits.length === 0, "入口里的轮次相对指称 = 0", hits.length ? hits.join(" ; ") : "0 处");
  // 阳性对照：词表若空、或判定函数坏掉（恒不命中），上面那条会永远 PASS。
  // 关键是【两处都用同一个 hasRoundWord】—— 否则判定坏了对照也抓不到（这本身就是我犯过的形状）。
  const POS = "本轮与上一稿与这一轮与前一轮与同轮";
  const posWord = hasRoundWord(POS);
  ok(Boolean(posWord), "阳性对照：判定函数命中得出来（与上面用的是同一个函数）", posWord ? "命中 " + posWord : "★没命中 ⇒ 判定或词表已坏");
  ok(ROUND_WORDS.length >= 10, "阳性对照：词表非空且规模合理", ROUND_WORDS.length + " 个词");
  const rest = (git(["ls-files", "docs"]) ?? "")
    .split(NL)
    .filter((f) => /\.md$/.test(f) && f !== ENTRY);
  let total = 0;
  const perDoc = [];
  let headings = 0;
  for (const f of rest) {
    const ls = rel(f);
    if (!ls) continue;
    let n = 0;
    ls.forEach((l) => {
      if (hasRoundWord(l)) {
        n += 1;
        if (/^#{2,4}\s/.test(String(l))) headings += 1;
      }
    });
    if (n) {
      total += n;
      perDoc.push(f.replace("docs/", "") + " " + n);
    }
  }
  say("  其余决策文档的存量（只报数，不判失败）：共 " + total + " 行，其中小节标题 " + headings + " 处");
  say("  分布：" + perDoc.join(" ; "));
  say("  为什么不判它失败：那多数是失误记录正文，那里的【本轮】是作者的第一人称时间锚点；");
  say("  批量重写等于替你决定改掉你已经读过的决策记录 —— 那不该我单方面做。要清就得你点头。");
}

say(NL + "—— 判不了或不符的项：" + fail.length + (fail.length ? NL + fail.map((x) => "  ★ " + x).join(NL) : " 无"));
say("  未覆盖、须由你亲自跑的：pnpm verify（全量测试+静态检查）、审计日志可读性人工核对。");
say("  这两项我报过结果，但属于【你能复算、我无法替你复算】的那类，故不在此脚本内代跑。");
process.exit(fail.length ? 1 : 0);
