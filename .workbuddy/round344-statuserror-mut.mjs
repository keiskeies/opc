/**
 * round344 0046 §6-2 http 侧变异矩阵：DecisionStatusError 接线是死的还是活的。
 *
 * 被测文件: packages/hub/src/http/real-deps.ts（decideWithEngineEdge 抛码）
 * 跑测文件: packages/hub/test/http/decision-engine-route.test.ts
 *
 * M1 把 stale_card 分支改成抛普通 Error（丢 409）⇒ 过期卡那发必须红。
 * M2 把 note_required/waiver_note_required 改成抛 Error（丢 422）⇒
 *    第二道网那发（dep 直连 rejects）不断 statusHint，纯抛出仍绿？
 *    不行 —— 那发只 toThrow(/--note/)，普通 Error 也通过，M2 可能【没被杀死】。
 *    所以 M2 丢 422 后 HTTP 层 catch 不认得（name 不对）⇒ 500。
 *    但第二道网那发走 dep 直连，不过 HTTP ⇒ 仍绿 ⇒ 变异漏网。
 *    正确杀 M2 的用例是「HTTP 直连打回没理由 ⇒ 422」？不 —— 那被 superRefine
 *    前置网挡了，到不了写路径。所以 422 这条真正确认的是【CLI/桌面直连】，
 *    而那侧没有 HTTP 状态码断言（只有 toThrow）。
 *    ⇒ 为了让 M2 有主，把断言升级：expect(...).rejects.toMatchObject({ name:"DecisionStatusError", statusHint:422 })
 *    并用 toThrow(/--note/) 保留原文。这两条必须同时成立。
 * M3 把 lost stale 409 + note 422 两段全删（回到 round344 前）⇒ 两发都红。
 * M0 控制组全绿。M9 还原复跑全绿。每个变异真改字节、跑完逐字节还原。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const SRC = "packages/hub/src/http/real-deps.ts";
const TEST = "packages/hub/test/http/decision-engine-route.test.ts";
const FILE = join(ROOT, SRC);

const RUN_BIN = process.platform === "win32" ? "npx.cmd" : "npx";
const RUN_CMD = "vitest run packages/hub/test/http/decision-engine-route.test.ts --no-color";

function run() {
  return execFileSync(RUN_BIN, [RUN_CMD], { cwd: ROOT, encoding: "utf8", shell: true });
}

function read() {
  return readFileSync(FILE, "utf8");
}

const MUTATIONS = [
  {
    label: "M1 stale_card 丢 statusHint 409（改抛普通 Error）",
    patch: (s) => {
      const from =
        '  if (r.outcome === "stale_card") {\n    throw new DecisionStatusError(409, r.note);\n  }\n  throw new Error(r.note);';
      const to =
        '  if (r.outcome === "stale_card") {\n    throw new Error(r.note);\n  }\n  throw new Error(r.note);';
      if (s.includes(from)) return s.replace(from, to);
      throw new Error("M1 anchor not found");
    },
  },
  {
    label: "M2 note/waiver 丢 statusHint 422（改抛普通 Error）",
    patch: (s) => {
      const from =
        '  if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n    throw new DecisionStatusError(422, r.note);\n  }';
      const to =
        '  if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n    throw new Error(r.note);\n  }';
      if (s.includes(from)) return s.replace(from, to);
      throw new Error("M2 anchor not found");
    },
  },
  {
    label: "M3 两段接线全删（回到 round344 前：只抛 plain Error）",
    patch: (s) => {
      const from =
        '  // 0046 §6-2：这三条是【调用方请求不成立】，HTTP 侧该回 422 / 409 而不是 500。\n  // 用 DecisionStatusError 把状态码带上去，app.ts 的 catch 认它、回对码；\n  // 直连调用方（CLI / 桌面 IPC）不认它不是 Error，照样只读到 message。\n  if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n    throw new DecisionStatusError(422, r.note);\n  }\n  if (r.outcome === "stale_card") {\n    throw new DecisionStatusError(409, r.note);\n  }\n  throw new Error(r.note);';
      const to = "  throw new Error(r.note);";
      if (s.includes(from)) return s.replace(from, to);
      throw new Error("M3 anchor not found");
    },
  },
];

let ok = 0;
const original = read();

// M0 控制组
try {
  const out = run();
  if (out.includes("Tests ") && out.includes(" passed")) ok += 1;
  console.log("✓ M0 一字不改 ⇒ decision-engine-route 全绿");
} catch (e) {
  console.log("✗ M0 控制组失败（基线就不绿？）: " + String(e));
  process.exit(1);
}

for (const mut of MUTATIONS) {
  const before = read();
  let next;
  try {
    next = mut.patch(before);
  } catch (e) {
    console.log("✗ " + mut.label + " 锚点没打到: " + String(e));
    writeFileSync(FILE, original, "utf8");
    continue;
  }
  if (next === before) {
    console.log("✗ " + mut.label + " 变异没改字节（no-op）");
    writeFileSync(FILE, original, "utf8");
    continue;
  }
  writeFileSync(FILE, next, "utf8");
  let out = "";
  try {
    out = run();
  } catch (e) {
    out = String(e);
  }
  const isHit = out.includes("Tests ") && out.includes("failed");
  writeFileSync(FILE, before, "utf8");
  const reverted = read() === original;
  if (isHit && reverted) ok += 1;
  console.log(
    (isHit && reverted ? "✓ " : "✗ ") +
      mut.label +
      (isHit ? "（红）" : "（没红！变异漏网）") +
      (reverted ? " reverted:true" : " reverted:FALSE"),
  );
}

// M9 还原复核
try {
  const out = run();
  if (out.includes("Tests ") && out.includes(" passed")) ok += 1;
  console.log("✓ M9 还原后复跑全绿");
} catch (e) {
  console.log("✗ M9 还原后复跑失败: " + String(e));
}

console.log("\n命中 " + ok + " / " + (MUTATIONS.length + 2));
process.exit(ok === MUTATIONS.length + 2 ? 0 : 1);
