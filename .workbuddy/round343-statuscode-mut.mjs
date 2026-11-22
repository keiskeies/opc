/**
 * round343 0046 §6-2 变异矩阵：statusHint 接入是死的还是活的。
 *
 * M1 把 note_required 分支的 statusHint:422 改成不带（合并进兜底 `{ok:false, why}`）
 *     ⇒ 打回没带理由那发（字段查 statusHint:422）必须红。
 * M2 把 stale_card 分支的 statusHint:409 改成 200（错放宽）⇒ stale 那发必须红。
 * M3 把两处 statusHint 接线整体删掉（回到 round343 前形状）⇒ 两发都红。
 * M0 控制组：一字不改全绿。M9 还原复核全绿。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const SRC = "packages/hub/src/channels/approval-bridge.ts";
const TEST = "packages/hub/test/acceptance/im-reply-approves-card.test.ts";
const FILE = join(ROOT, SRC);

const RUN_BIN = process.platform === "win32" ? "npx.cmd" : "npx";
const RUN_CMD = "vitest run packages/hub/test/acceptance/im-reply-approves-card.test.ts -t statusHint --no-color";

function run() {
  // win32 下 .cmd 必须走 shell
  return execFileSync(RUN_BIN, [RUN_CMD], { cwd: ROOT, encoding: "utf8", shell: true });
}

function read() {
  return readFileSync(FILE, "utf8");
}

const MUTATIONS = [
  {
    label: "M1 note_required 分支丢 statusHint:422（并进兜底）",
    patch: (s) => {
      const from =
        '    if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n      return { ok: false, why: r.note, statusHint: 422 };\n    }';
      const to = "";
      if (!s.includes(from)) throw new Error("M1 anchor not found");
      return s.replace(from, to);
    },
  },
  {
    label: "M2 stale_card 分支 statusHint:409 → 200（错放宽）",
    patch: (s) => {
      const from =
        '    if (r.outcome === "stale_card") {\n      return { ok: false, why: r.note, statusHint: 409 };\n    }';
      const to =
        '    if (r.outcome === "stale_card") {\n      return { ok: false, why: r.note, statusHint: 200 };\n    }';
      if (!s.includes(from)) throw new Error("M2 anchor not found");
      return s.replace(from, to);
    },
  },
  {
    label: "M3 两段 statusHint 接线全删（回到 round343 前）",
    patch: (s) => {
      const one =
        '    if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n      return { ok: false, why: r.note, statusHint: 422 };\n    }\n    if (r.outcome === "stale_card") {\n      return { ok: false, why: r.note, statusHint: 409 };\n    }\n';
      const two =
        '    if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n      return { ok: false, why: r.note, statusHint: 422 };\n    }\n    if (r.outcome === "stale_card") {\n      return { ok: false, why: r.note, statusHint: 409 };\n    }\n';
      // 与 M1 共用一段也行，M3 用「含注释的整块」兜底：删掉两个 if 块及其注释行。
      const withComment =
        '    if (r.outcome === "note_required" || r.outcome === "waiver_note_required") {\n      return { ok: false, why: r.note, statusHint: 422 };\n    }\n    if (r.outcome === "stale_card") {\n      return { ok: false, why: r.note, statusHint: 409 };\n    }\n';
      if (!s.includes(one) && !s.includes(two)) {
        // 注释行挡在中间时按锚定：两段之间隔着注释，直接用正则删两个 if 块。
        const re =
          /    if \(r\.outcome === "note_required" \|\| r\.outcome === "waiver_note_required"\) \{\n      return \{ ok: false, why: r\.note, statusHint: 422 \};\n    \}\n    if \(r\.outcome === "stale_card"\) \{\n      return \{ ok: false, why: r\.note, statusHint: 409 \};\n    \}\n/;
        if (!re.test(s)) throw new Error("M3 regex anchor not found");
        return s.replace(re, "");
      }
      return s.replace(one || two, "");
    },
  },
];

let ok = 0;
const original = read();

// M0 控制组
try {
  const out = run();
  if (out.includes("Tests ") && out.includes(" passed")) ok += 1;
  console.log("✓ M0 一字不改 ⇒ " + TEST + " 全绿");
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
  const reds = (out.match(/failed/g) ?? []).length + (out.match(/✗/g) ?? []).length;
  const isHit = out.includes("failed") && !out.includes("0 failed");
  writeFileSync(FILE, before, "utf8");
  const reverted = read() === original;
  if (isHit && reverted) ok += 1;
  console.log(
    (isHit && reverted ? "✓ " : "✗ ") +
      mut.label +
      (isHit ? "（红：" + reds + "）" : "（没红！）") +
      (reverted ? " reverted:true" : " reverted:FALSE"),
  );
}

// M9 还原复核
try {
  const out = run();
  if (out.includes(" passed")) ok += 1;
  console.log("✓ M9 还原后复跑全绿");
} catch (e) {
  console.log("✗ M9 还原后复跑失败: " + String(e));
}

console.log("\n命中 " + ok + " / " + (MUTATIONS.length + 2));
process.exit(ok === MUTATIONS.length + 2 ? 0 : 1);
