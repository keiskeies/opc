// 变异自证（round374 · tw:text-balance 的三发落点断言）。
// 逐条真抹字节 → 只跑 group-workbench 那一份 spec → 必须红在【预期的那一条用例】上
// → 逐字节还原 → md5 必须等于动手前。存活（仍绿）= 那条落点断言是装饰。
// 还原目标是【工作区原始字节】，不是 git HEAD（HEAD 是假基线）。
//
// 三发各打一处 landing，且【不动产物 tw.css】：留着规则只抹类名，测的才是
// 「这个元素到底挂没挂这枚 utility」。若连产物一起抹，红会因为「样式表里根本没这条
// 规则」，那与「类名没接上」是两种病因，归因就糊了。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const F = {
  group: "packages/web/public/group.js",
};
const digest = (p) =>
  createHash("md5").update(readFileSync(p)).digest("hex").slice(0, 8);
const base = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);
const baseHash = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, digest(p)]),
);

const SPEC = "test/e2e/group-workbench.spec.ts";

/** [名称, edits[[文件键, 原文, 替换后]], 该红的用例名片段] */
const MUTATIONS = [
  [
    "L1 空态标题摘掉 utility（emptyState 那一处，覆盖 ~15 个空态）",
    [
      [
        "group",
        'h("h3", { class: "tw:text-balance", text: title }),',
        'h("h3", { text: title }),',
      ],
    ],
    ["群会话视图"],
    ".state h3",
  ],
  [
    "L2 文档卡标题摘掉 utility",
    [
      [
        "group",
        'class: "group-document-title tw:text-balance",',
        'class: "group-document-title",',
      ],
    ],
    ["群会话视图"],
    ".group-document-title",
  ],
  [
    "L3 待办卡标题摘掉 utility",
    [
      [
        "group",
        'class: "group-task-title tw:text-balance",',
        'class: "group-task-title",',
      ],
    ],
    ["群会话视图"],
    ".group-task-title",
  ],
  [
    "L4 已知不挡：只改【空白/换行】不改语义（class 串等价重排）—— 预期存活",
    [
      [
        "group",
        'class: "group-task-title tw:text-balance",',
        'class: "tw:text-balance group-task-title",',
      ],
    ],
    ["__预期存活__"],
  ],
];

function run() {
  const r = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", SPEC, "--reporter=list"],
    { cwd: "D:/item/opc", encoding: "utf8", timeout: 900000 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const red = [...out.matchAll(/^\s*x\s+\d+\s+.*?›\s*(.+)$/gmu)].map((m) =>
    (m[1] ?? "").trim(),
  );
  // list reporter 把失败详情打在用例行之后。三发变异红在【同一条用例】上（三条断言都在
  // 「群会话视图」那一发里），只比用例名分不出是哪条断言死的 —— 那是归因不够窄。
  // 所以额外把 expect 的 locator 字符串取回来当第二把尺子。
  const needles = [...out.matchAll(/locator\(([^)]*text-balance[^)]*)\)/gmu)].map((m) =>
    (m[1] ?? "").trim(),
  );
  return { red, needles, out };
}

function restore() {
  for (const [k, p] of Object.entries(F)) writeFileSync(p, base[k], "utf8");
  for (const [k, p] of Object.entries(F)) {
    if (digest(p) !== baseHash[k]) throw new Error(`还原后校验和变了：${p}`);
  }
}

let survived = 0;
for (const [name, edits, expected, needleFor] of MUTATIONS) {
  for (const [key, from, to] of edits) {
    const p = F[key];
    const s = readFileSync(p, "utf8");
    const n = s.split(from).length - 1;
    if (n !== 1)
      throw new Error(`锚点在 ${key} 命中 ${n} 次（要 1 次）：${from.slice(0, 50)}`);
    writeFileSync(p, s.replace(from, to), "utf8");
  }
  const { red, needles, out } = run();
  const expectSurvive = expected[0] === "__预期存活__";
  const ok = expectSurvive
    ? red.length === 0
    : expected.every((frag) => red.some((t) => t.includes(frag))) &&
      // 第二把尺子：这条变异抹的是哪一处 landing，红的 expect 就必须指着那一处的选择器。
      needles.some((n) => n.includes(needleFor));
  if (!ok) survived += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} [${expectSurvive ? "预期存活" : "应红"}] ${name}\n` +
      `      红：${red.join(" / ") || "（无）"}
` +
      `      死在 expect：${needles.join(" + ") || "（取不到 locator）"}`,
  );
  try {
    restore();
  } catch (e) {
    console.log(`      !! ${e.message}\n${out.slice(-1500)}`);
    process.exit(1);
  }
}
const { red: after } = run();
console.log(
  `\n还原后基线：${after.length === 0 ? "全绿" : `仍红 → ${after.join(" / ")}`}`,
);
console.log(`共 ${MUTATIONS.length} 发，未达预期 ${survived} 发`);
