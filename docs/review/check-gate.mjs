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

// —— C1 门禁是否被标记通过：只看【主题】，绝不读正文（读正文的量一律不作证据，见 0006 §7 第 48 条）
say(NL + "C1 出口门禁有没有被标记通过（只看提交主题）");
const subjects = (git(["log", "--all", "--format=%s"]) ?? "").split(NL).filter(Boolean);
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
say("  口径说明：这两条只读 %s（主题）。任何【读提交正文】的搜索都会被我自己的复述污染，故一律不作证据。");

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
say(NL + "C4 要你拍的三样东西是否已写进决策文档（标题点名等你）");
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
say("  HEAD = " + (git(["log", "-1", "--format=%h %s"]) ?? "").trim().slice(0, 92));

say(NL + "—— 判不了或不符的项：" + fail.length + (fail.length ? NL + fail.map((x) => "  ★ " + x).join(NL) : " 无"));
say("  未覆盖、须由你亲自跑的：pnpm verify（全量测试+静态检查）、审计日志可读性人工核对。");
say("  这两项我报过结果，但属于【你能复算、我无法替你复算】的那类，故不在此脚本内代跑。");
process.exit(fail.length ? 1 : 0);
