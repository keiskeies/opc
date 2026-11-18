/**
 * round303 变异机：`safety.ts` 的工作区包含判据那三格，哪一格真的在挡什么。
 *
 * ⚠ 这台【写真生产字节】（packages/hub/src/harness/safety.ts），逐发跑完立刻按原文
 *   回写并逐字节核对 —— 与 round292~294 同一纪律：【单独跑，不许并发】。
 *   另起一发的原因不是口味：这条判据是【安全判据】，「测试绿」不足以说明它在做事，
 *   必须把判据改坏后【看着指定的那几发红】才知道它挡的是那一发。
 *
 * ── 五发（每发判【红的落点】而不只是「有没有红」）────────────────────
 *  M0 控制组：不改字节 ⇒ 该文件【全绿】。后面每一发的地基。
 *  M1 退回旧口径（只看 POSIX 读法：`insideUnder(false) && insideUnder(true)` ⇒
 *     `insideUnder(false)`）⇒ 必须红在【混合形状逃逸】那一族：
 *     「混合形状…」与「本轮改了行为的那几对」。
 *     ⇒ 这一发是本轮那条主张的【反向 canary】：主张是「旧口径放行逃逸」，
 *       打回旧口径而测试不红 ⇒ 新加的那几发是装饰。
 *  M2 交集改并集（`&&` ⇒ `||`）⇒ 必须红在【代价那一发】
 *     （「交集口径的【代价】实测为零」里那一对 /repo/ws + /repo/ws\a）。
 *     ⇒ 钉的是「两种读法都算」而不是「至少一种算」：并集在真逃逸上【照样拦得住】
 *       （两侧都说在外面才没有分歧），只有【有分歧的那一对】能分辨 ⇒ 又是一发
 *       「重叠型拦不住、分歧型才拦得住」（round301 丙/丁 那一族的反面）。
 *  M3 Windows 读法把段用 `\` 拼回去（join("/") ⇒ 按读法选连接符）⇒ 必须红在
 *     【斜杠盘符那一发】（`D:/repo/ws` + 仓内真路径）。
 *     ⚠ 我在源码注释里写过「靠 `D:\repo\ws` + 同一路径那一发拦住了」——那是【没验过的
 *     出处】。这一发量出来到底是哪一发拦住它，量完把注释改成量到的那句。
 *  M4 把「两侧都归一」改成「只归一 target」⇒ 根一侧不再折 `..` ⇒
 *     必须红在【工作区自己带 .. 那一发】，且【旧 ".." 那一发保持绿】。
 *     ⇒ 钉住「根也要归一」这一半有测试兜着。它本来【没有】：旧那发根全是已归一的
 *       "/repo"，这一发打上照样绿 ⇒ 我先登记的落点是假变异，量之前先补了测试。
 *
 * 读红绿：用 vitest 自己的退出码 + 那份 reporter 的【测试名】，不 grep 输出里的数字
 * （round301 §⑦③ 那条口径：grep `\b1 failed\b` 会把别人的红读成自己的）。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const REL = "packages/hub/src/harness/safety.ts";
const path = join(ROOT, REL);
const TEST = "packages/hub/test/harness/safety.test.ts";

/** 每次变异后【必须变红】的测试名子串（判落点，不判「有没有红」）。 */
const MUTATIONS = [
  {
    label: "M1 退回旧口径（只看 POSIX 读法）",
    from: "  return insideUnder(false) && insideUnder(true);",
    to: "  return insideUnder(false); // 变异：Windows 读法不再参与判定",
    expectRed: ["混合形状", "本轮改了行为的那几对"],
    expectGreen: ["反向：两种读法", "代价"],
  },
  {
    label: "M2 交集改并集（`&&` ⇒ `||`）",
    from: "  return insideUnder(false) && insideUnder(true);",
    to: "  return insideUnder(false) || insideUnder(true); // 变异：并集",
    // 落点【本轮被量纠正过一次】。我原来写的是「红在代价那一发，且混合形状那族该绿」，
    // 理由是我以为「并集在真逃逸上照样拦得住」。量出来【正好反了】，而且反得很干净：
    //   并集 ⊇ POSIX 那一侧 ⇒ 并集是【旧口径的超集】⇒ 旧口径放行的每一发它都放行。
    // 所以改并集不是「换个口径」，是【把本轮修的那个洞原样退回去】+ 再多放一批
    // （两侧都是反斜杠那一发：POSIX 说在外、Windows 说在内 ⇒ 并集说在内）。
    // ⇒ 能分辨 ∩ 与 ∪ 的不是某个特殊配对，而是【所有两读分歧的对】，一共四发；
    //   它同时是「反向对照那一发仍然绿」的另一半证明（并集只会更松，不会误伤）。
    expectRed: ["代价", "混合形状", "本轮改了行为的那几对", "两侧都是反斜杠形状"],
    expectGreen: ["反向：两种读法", ".. 归一之后再比"],
  },
  {
    label: "M3 Windows 读法把段用反斜杠拼回去",
    from: "  return (abs ? \"/\" : \"\") + parts.join(\"/\");",
    to: "  return (abs ? \"/\" : \"\") + parts.join(bothSeparators ? \"\\\\\" : \"/\");",
    // 落点【本轮量过】（我先在源码注释里写过「靠 `D:\repo\ws` + 同一路径那一发拦住」，
    // 那是没验过的出处，已按实测改掉）。实测是一发【宽爆】：Windows 那一读把段拼成
    // `\` 后，`p.startsWith(root + "/")` 对【任何】路径都不成立 ⇒ 该读法恒说「在外面」
    // ⇒ 交集恒假 ⇒ 所有「断言在里面」的用例一起红（/repo-evil、.. 归一、反向、盘符…）。
    // ⚠ 因此这一发【不能】用来主张「某发是唯一的拦截者」，它能主张的是另一件事：
    //   恒拒的实现【只有】「反向：两种读法都算在里面」那一族拦得住 —— 逃逸那三发
    //   在恒拒下【全绿】（它们本来就断 false）。这正是那几发反向对照存在的全部理由。
    expectRed: ["反向：两种读法", "两侧都是反斜杠形状"],
    expectGreen: ["混合形状", "本轮改了行为的那几对"],
  },
  {
    label: "M4 只归一 target，不归一 workspace",
    from: "    const root: string = normalizeAbs(workspace, bothSeparators);",
    to: "    const root: string = workspace; // 变异：根一侧不归一",
    // 落点【本轮改过一次】，改的理由比结论重要：我先写的是「红在既有的 .. 那一发」，
    // 那是一发【假变异】（round295 那一族）—— 旧那发用的根全是 "/repo"，本身已归一，
    // 根一侧不归一时它【照样绿】⇒ 打了等于没打。所以先补了
    // 「工作区【自己】带 .. / . / 尾斜杠」那一发，并把旧那发写进 expectGreen：
    // 它该绿，而它绿正是「原来这一半根本没被测到」的机器证明。
    expectRed: ["工作区【自己】带"],
    expectGreen: ["混合形状", ".. 归一之后再比"],
  },
];

const orig = readFileSync(path, "utf8");

/** 从 vitest 输出里取【失败的测试名】列表（剥 ANSI 后按 ×/FAIL 行找）。 */
function failedTests(out) {
  const plain = out.replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu"), "");
  const names = new Set();
  for (const line of plain.split("\n")) {
    const m = /(?:×|✗)\s+(.+?)(?:\s+\d+ms)?\s*$/u.exec(line.trim());
    if (m !== null && m[1] !== undefined) names.add(m[1].trim());
  }
  return [...names];
}

function runTests() {
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "node_modules", "vitest", "vitest.mjs"), "run", TEST],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return {
    green: r.status === 0,
    names: failedTests(String(r.stdout) + String(r.stderr)),
    out: String(r.stdout) + String(r.stderr),
  };
}

const results = [];
let fatal = "";
try {
  // M0 控制组
  const m0 = runTests();
  results.push([m0.green, "M0 一字不改 ⇒ 该文件全绿", m0.green ? "全绿" : "意外红：" + m0.names.join("、").slice(0, 400)]);

  for (const mut of MUTATIONS) {
    const n = orig.split(mut.from).length - 1;
    if (n !== 1) {
      fatal = "锚点在 " + REL + " 命中 " + n + " 次（要恰好 1）：" + mut.from.slice(0, 50);
      break;
    }
    writeFileSync(path, orig.replace(mut.from, mut.to), "utf8");
    let got;
    try {
      got = runTests();
    } finally {
      writeFileSync(path, orig, "utf8");
      const back = readFileSync(path, "utf8") === orig;
      if (!back) {
        fatal = "回滚后字节不一致，必须手工修：" + REL;
        break;
      }
    }
    const hit = (needle) => got.names.some((x) => x.includes(needle));
    const problems = [];
    if (got.green) problems.push("【全绿】⇒ 这一格不承重（或者锚点没抹到）");
    for (const w of mut.expectRed) if (!hit(w)) problems.push("该红的没红：" + w);
    for (const w of mut.expectGreen) if (hit(w)) problems.push("不该红的红了：" + w);
    results.push([
      problems.length === 0,
      mut.label,
      problems.length === 0
        ? "红的落点正是：" + got.names.join("、").slice(0, 700)
        : problems.join("；") + " ｜实红：" + got.names.join("、").slice(0, 700),
    ]);
  }
} catch (err) {
  fatal = String(err instanceof Error ? err.message : err);
} finally {
  writeFileSync(path, orig, "utf8");
}

if (fatal !== "") {
  console.error("【整台机器停摆，不出命中数】" + fatal);
  process.exitCode = 1;
} else {
  let ok = 0;
  console.log("══════════ round303 工作区包含判据变异矩阵（写真字节，逐发自回滚）══════════");
  for (const [hit, label, msg] of results) {
    ok += hit ? 1 : 0;
    console.log((hit ? "✓ " : "✗ ") + label + "\n      | " + msg);
  }
  const want = MUTATIONS.length + 1;
  console.log("命中 " + ok + " / " + results.length + "（分母 = " + MUTATIONS.length + " 发变异 + 1 发控制组）");
  process.exitCode = ok === results.length && results.length === want ? 0 : 1;
}
