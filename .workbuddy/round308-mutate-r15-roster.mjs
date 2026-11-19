/**
 * round308 · 打在 r15 判据第五格（名单对账）上的自回滚变异矩阵。
 *
 * 为什么单独一台，而不是只靠 claims-registry.test.ts 里那三发合成变异：
 * 那三发打在【合成语料】上，证的是「判据读得到自己写的那几个锚」；
 * 这一台打在【那发验收测试的真字节】上，证的是「真文件改动能被读到」——
 * 两者不同：真文件里的缩进 / 注释 / 排版与合成语料不一样，
 * 而本仓吃过的那一族恰好都是「合成绿、真文件读不到」（r22 的 M8、r24 的 (a) 那一格）。
 *
 * 用法：npx tsx .workbuddy/round308-mutate-r15-roster.mjs
 * 每发：备份 → 抹字节 → 跑那一发测试 → 逐字节还原 → 核对还原。
 * ⚠ 单独跑，别和别的测试并发（它会临时改工作树）。
 *
 * ⚠ 读数的【分辨率】—— 第一版只读文件名，跑出来 M1–M4【都只点名同一发】，
 * 当时把它写成「一次磁盘变异同时动了十几发，答不出是哪一格」。改成逐条读【用例名】
 * 重跑之后那个结论【只对了一半】，登记实测（第二版证据）：
 *   M1（add_edge 放宽成空）⇒ 红的用例里有【之七本体】+ 控制组 ✅ 点得到那一格
 *   M2（reparent 换路径）  ⇒ 之七 + 之七·乙 + 控制组 ✅ 同理
 *   M3（止锚改名）         ⇒ 控制组 + 之七 + 之七·乙（锚的文案里也写着「名单」，
 *                            所以那两发的 toContain("名单") 也满足 —— 这是【文案重叠】，
 *                            不是判据串扰；之八本体反而不红，因为它自己把那串字节又抹了一遍）
 *   M4（清空名单 + 切片外留诱饵注释）⇒ 【只有控制组红】
 * ⇒ 所以「磁盘变异会传进判据」由控制组证明（它一字不改地读真文件，真文件一动它就红），
 * 「具体那一格」M1/M2 点得到、M3/M4 点不到。M4 点不到的原因是【变异自己把自己中和了】：
 * 之七 用 `.replace(第一个 "add_edge: [consolePath],")`，而 M4 留下的诱饵注释恰好是文件里
 * 第一个匹配 —— 那一发于是改到了诱饵、名单那格【对它而言】又变回原样 ⇒ 它拿到预期红、自己绿了。
 * 这不算判据的洞（判据对 M4 的真名单确实红了，红的是控制组那一发），但它说明
 * 【打在真字节上的矩阵】和【打在合成语料上的矩阵】各有一种自我中和的方式：
 * 前者是「诱饵抢在锚点前面把 replace 用掉」，后者是「注释写进切片」。
 * 要这台具备完整分辨率，得让 mustRed 逐条点【该红的那一发】而不是【红集合非空】——
 * round300 那台已经立了这个口径，本轮未做，登记在此（下一轮补）。
 *
 * ⚠ 另外这条矩阵顺手量出一个【判据的顺序】缺陷，已在 claims-registry.ts 里改掉：
 * 第五格最初写在「三个根非空」那道兜底【之前】。M1 第一版跑出来「三根全 0」那发红在
 * 【名单不匹配】上而不是【读数不可信】上 —— 取材都没了却先报名单，把「读不到」当成了
 * 「读到了不匹配」，而两者的修法相反（一个修取材、一个修主张）。⇒ 移到兜底之后。
 * 这个缺陷是【只有跑出来才看得见】的那种：判据逐格单看都对，串起来的顺序才是主张的一部分。
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = join(
  ROOT,
  "packages",
  "hub",
  "test",
  "acceptance",
  "new-role-to-its-own-criteria.test.ts",
);
const ORIGINAL = readFileSync(TARGET, "utf8");

/** 每发：id / 说明 / 该不该红 / 怎么抹。 */
const SPECS = [
  {
    id: "M0",
    mustRed: false,
    note: "控制组：行尾加一句空注释 ⇒ 该绿（防判据恒红）",
    apply: (t) => t.replace("    const consolePath = CONSOLE_JS;", "    const consolePath = CONSOLE_JS; // control\n"),
  },
  {
    id: "M1",
    mustRed: true,
    note: "add_edge 那一格放宽成空名单 ⇒ 该红",
    apply: (t) => t.replace("add_edge: [consolePath],", "add_edge: [],"),
  },
  {
    id: "M2",
    mustRed: true,
    note: "reparent 那一格换成【另一个路径常量】⇒ 该红（名单还在但不再指名 app.js）",
    apply: (t) => t.replace("reparent: [consolePath],", "reparent: [\"some/other/file.js\"],"),
  },
  {
    id: "M3",
    mustRed: true,
    note: "止锚那行改名 ⇒ 该红在「名单边界读不到」（sliceFrom 缺锚返回 null，不退回全文）",
    apply: (t) => t.replaceAll("// ② 前提自证", "// ② PREMISE RENAMED"),
  },
  {
    id: "M4",
    mustRed: true,
    note: "把真名单清空、同一行上方留一句【带同样字节】的注释 ⇒ 该红（钉住切片作用面，不判全文）",
    apply: (t) =>
      t
        .replace("add_edge: [consolePath],", "add_edge: [],")
        .replace(
          "    expect(emitters).toEqual({",
          '    /* 诱饵：add_edge: [consolePath], */\n    expect(emitters).toEqual({',
        ),
  },
];

function runOne(spec) {
  const mutated = spec.apply(ORIGINAL);
  if (mutated === ORIGINAL) {
    return { id: spec.id, verdict: "空变异（字节没动）", red: null, detail: "" };
  }
  writeFileSync(TARGET, mutated);
  const r = spawnSync(
    "npx",
    ["vitest", "run", "test/arch/claims-registry.test.ts", "-t", "r15"],
    { cwd: ROOT, encoding: "utf8", shell: true },
  );
  const out = (r.stdout || "") + (r.stderr || "");
  // 判定口径：只看 vitest 的退出码。红因从 FAIL 行里读，别拿「输出里出现过红字」当读数。
  const red = r.status !== 0;
  // 逐条读【用例名】（round300 那台立的口径）：只读文件名的分辨率是一份几十发的文件，
  // 里面任何一发红都算命中，而它可能红在别处 —— 那一格就没被测过。
  const names = out
    .split("\n")
    .filter((l) => l.includes("FAIL") && l.includes("claims-registry"))
    .map((l) => {
      const parts = l.replace(/\u001b\[[0-9;]*m/g, "").split(" > ");
      return parts.length > 1 ? parts[parts.length - 1].trim() : l.trim();
    });
  return { id: spec.id, verdict: red ? "红" : "绿", red, detail: names.join(" ｜ ") };
}

const rows = [];
for (const spec of SPECS) {
  const res = runOne(spec);
  writeFileSync(TARGET, ORIGINAL); // 无条件还原，红也还原
  const restored = readFileSync(TARGET, "utf8") === ORIGINAL;
  const hit = res.red === spec.mustRed;
  rows.push({ id: spec.id, note: spec.note, ...res, hit, restored });
  console.log(
    `${hit ? "✔" : "✘"} ${spec.id} ${spec.mustRed ? "该红" : "该绿"} → ${res.verdict}` +
      `｜还原逐字节一致=${restored}｜${spec.note}`,
  );
  if (res.detail) console.log(`    FAIL: ${res.detail}`);
}
const hits = rows.filter((x) => x.hit).length;
const restoredAll = rows.every((x) => x.restored);
console.log(
  `\n命中 ${hits}/${rows.length}｜全部还原=${restoredAll}｜` +
    `当前文件与开头读到的是否逐字一致=${readFileSync(TARGET, "utf8") === ORIGINAL}`,
);
process.exit(hits === rows.length && restoredAll ? 0 : 1);
