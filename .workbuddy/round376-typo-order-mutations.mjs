// 变异自证（round376 · 会话列表「顺序乱 + 排版乱」两条 landing）。
// 逐条真抹字节 -> 只跑 group-workbench 那一份 spec -> 必须红在【预期的那一条断言】上
// -> 逐字节还原 -> 校验和必须等于动手前。存活（仍绿）= 那条断言是装饰。
//
// 归因比「用例名」窄一档：排版判据挤在同一条用例里，只比用例名分不出死的是哪根线。
// list reporter 的失败详情带 code frame（`>  1085 | expect(...)`），所以每发变异额外认领
// 一段【死掉的 expect 源码】子串；用例名 + 断言行两把尺子都对上，才算打在了该打的那根线上。
//
// 断言顺序是有讲究的（见 spec 文件头）：声明级（字号/字距）排在几何级之前，否则字号一退回
// 11px，17 字也能塞进 189px 的轨道，几何那几条会先以「窗口消失」这种间接症状红，归因白绕。
// M1 与 M9 因此都认领 T1 那句，而不是窗口消失。
//
// 三发栏宽变异各守一根线：M4=宽档 340、M8=窄档 media 里的 305、M7=窗口自证的反向。
// 两发【预期存活】是正对照，不是凑数：
//   P1 只摘掉 margin-top 存活 => 行盒被 .kind-icon{height:38px} 这块地板兜着，
//      margin-top 不是几何承重点（别把它写成「收紧行盒的那一刀」）；
//   P2 宽档放宽到 350 存活 => T3 是方向性的，不是「数值一动就红」的脆断言。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "D:/item/opc";
const F = {
  css: "packages/web/public/group.css",
  js: "packages/web/public/group.js",
};
const SPEC = "test/e2e/group-workbench.spec.ts";
// 用例名里是全角破折号与箭头，锚点只取不含它们的稳定片段。
const WIDE = "宽档(340)";
const NARROW = "窄档(≤1180";
const ORDER = "会话列表段内按最近时刻倒序";
const FITS = "个汉字被截断了"; // T3a 失败文案
const WINDOW = "窗口消失"; // T3b 失败文案 = T5（inline 化）的探针
const ROWBOX = "超出预算"; // T4
const FS = "expect(type.preview).toBe(type.sm)"; // T1
const LABEL = 'expect(type.labelSpacing).toBe("normal")'; // T2
const ORDER_FRAME = '.conversation-item")).toHaveText([';

const digest = (p) =>
  createHash("md5").update(readFileSync(`${ROOT}/${p}`)).digest("hex").slice(0, 8);
const base = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, readFileSync(`${ROOT}/${p}`, "utf8")]),
);
const baseHash = Object.fromEntries(
  Object.entries(F).map(([k, p]) => [k, digest(p)]),
);

const PREV = "font-size: var(--fs-sm); line-height: 1.35;";
const widthEdit = (px) => ["css", "--list-width: 340px;", `--list-width: ${px}px;`];

/** [名称, edits[[文件键, 原文, 替换后]], 预期红的用例名片段, 预期死掉的 expect 片段] */
const MUTATIONS = [
  [
    "M1 预览字号退回 11px（字号阶梯塌回一级）",
    [["css", PREV, "font-size: 11px; line-height: 1.35;"]],
    [WIDE],
    [FS],
  ],
  [
    "M2 摘掉 line-height:1.35（预览行高退回继承 body 的 1.55）",
    [["css", PREV, "font-size: var(--fs-sm);"]],
    [WIDE],
    [ROWBOX],
  ],
  [
    "M3 段标签恢复 letter-spacing + uppercase",
    [
      [
        "css",
        ".list-section { padding: 14px 9px 6px;",
        ".list-section { letter-spacing: .08em; text-transform: uppercase; padding: 14px 9px 6px;",
      ],
    ],
    [WIDE],
    [LABEL],
  ],
  [
    "M4 宽档栏宽退回 306（轨道 155px，14 字放不下）",
    [widthEdit(306)],
    [WIDE],
    [FITS],
  ],
  [
    "M5 摘掉 created_at 兜底（缺最新消息的那条 recency 落 0）",
    [
      [
        "js",
        "const value = conversation.last_message_at || conversation.created_at;",
        "const value = conversation.last_message_at;",
      ],
    ],
    [ORDER],
    [ORDER_FRAME],
  ],
  [
    "M6 时刻改走 Date.parse（契约是 epoch 数字，恒 NaN）",
    [
      [
        "js",
        '  return typeof value === "number" && Number.isFinite(value) ? value : 0;',
        "  return Date.parse(String(value)) || 0;",
      ],
    ],
    [ORDER],
    [ORDER_FRAME],
  ],
  [
    "M7 宽档放宽到 360（窗口自证失效：17 字也不截断）",
    [widthEdit(360)],
    [WIDE],
    [WINDOW],
  ],
  [
    "M8 窄档 media 里的 305 退回 275（轨道只剩 124px）",
    [["css", ":root { --list-width: 305px; }", ":root { --list-width: 275px; }"]],
    [NARROW],
    [FITS],
  ],
  [
    "M9 摘掉 display:block（预览退回 inline 盒，截断三条全不生效）",
    [
      [
        "css",
        ".conversation-preview { display: block; color: var(--muted);",
        ".conversation-preview { color: var(--muted);",
      ],
    ],
    [WIDE],
    [WINDOW],
  ],
  [
    "P1 预期存活：只摘掉 margin-top:2px（被 38px 头像地板吸收，行盒仍 58）",
    [["css", "white-space: nowrap; margin-top: 2px; }", "white-space: nowrap; }"]],
    ["__预期存活__"],
  ],
  [
    "P2 预期存活：宽档放宽到 350（14 字仍放得下、17 字仍截断）",
    [widthEdit(350)],
    ["__预期存活__"],
  ],
];

function run() {
  const r = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", SPEC, "--reporter=list"],
    { cwd: ROOT, encoding: "utf8", timeout: 900000 },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const red = [...out.matchAll(/^\s*x\s+\d+\s+.*?›\s*(.+)$/gmu)].map((m) =>
    (m[1] ?? "").trim(),
  );
  // code frame 里 `> NNN | ...` 那行就是当场死掉的那条断言。
  const frames = [...out.matchAll(/^\s*>\s*\d+\s*\|\s*(.+)$/gmu)].map((m) =>
    (m[1] ?? "").trim(),
  );
  return { red, frames, out };
}

function restore() {
  for (const [k, p] of Object.entries(F)) {
    writeFileSync(`${ROOT}/${p}`, base[k], "utf8");
    if (digest(p) !== baseHash[k]) throw new Error(`还原后校验和变了：${p}`);
  }
}

let survived = 0;
for (const [name, edits, expected, needles] of MUTATIONS) {
  for (const [key, from, to] of edits) {
    const p = `${ROOT}/${F[key]}`;
    const s = readFileSync(p, "utf8");
    const n = s.split(from).length - 1;
    if (n !== 1)
      throw new Error(`锚点在 ${key} 命中 ${n} 次（要 1 次）：${from.slice(0, 60)}`);
    writeFileSync(p, s.replace(from, to), "utf8");
  }
  const { red, frames, out } = run();
  const expectSurvive = expected[0] === "__预期存活__";
  const ok = expectSurvive
    ? red.length === 0
    : expected.every((frag) => red.some((t) => t.includes(frag))) &&
      needles.every((needle) => frames.some((f) => f.includes(needle)));
  if (!ok) survived += 1;
  console.log(
    `${ok ? "PASS" : "FAIL"} [${expectSurvive ? "预期存活" : "应红"}] ${name}\n` +
      `      红：${red.join(" / ") || "（无）"}\n` +
      `      死在：${frames.join(" + ") || "（取不到 code frame）"}\n` +
      `      认领：${(needles ?? []).join(" + ") || "-"}`,
  );
  if (!ok) console.log(out.slice(-2500));
  try {
    restore();
  } catch (e) {
    console.log(`      !! ${e.message}\n${out.slice(-1500)}`);
    process.exit(1);
  }
}
const { red: after } = run();
console.log(
  `\n还原后基线：${after.length === 0 ? "全绿" : `仍红 -> ${after.join(" / ")}`}`,
);
console.log(`共 ${MUTATIONS.length} 发，未达预期 ${survived} 发`);
console.log(
  `reverted:${JSON.stringify(
    Object.fromEntries(
      Object.entries(F).map(([k, p]) => [k, digest(p) === baseHash[k]]),
    ),
  )}`,
);
