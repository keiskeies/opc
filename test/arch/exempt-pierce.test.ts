/**
 * round346：EXEMPT 穿透变异探针（0056 §8 明记的「没修」项）。
 *
 * 背景：docs/review/verify-open-invariants.mjs 的 EXEMPT 表每一条「豁免」都必须
 * 真实在 ④ 桶承重。旧断言只数「这条 key 在语料里出现过几次」（exemptSeen），
 * be07d9+b 那条注入值在旧断言下完全合格（它确实在语料里出现）却把 M1 弄瞎。
 * round346 在脚本里把「每条豁免必须被④用掉」（exemptHit）从提示升成断言（静态）。
 * 本文件是【动态穿透】那一半：逐条把某 key 从 EXEMPT 换成一个非 hex 无效值
 * （zzzzzzz，不会被 /\b[0-9a-fA-F]{7,}\b/ 采到，所以不污染语料），spawn 原脚本，
 * 断言【红且点名该 key】⇒ 证明这一条豁免今天真的在放行什么；然后逐字节回滚。
 *
 * ⚠ 为什么放 test/arch 而不是 .workbuddy：verify 脚本扫 .workbuddy/ 与 docs/，
 *   把 key 原文（真 hex）留在被扫目录 = 探针自己污染语料（round346 实测踩过：
 *   探针注释里的 7 位 hex 把脚本扫红）。test/ 不在扫描面，干净。
 * ⚠ 变异是真字节：readFile → replace → writeFile → spawn → 断言 → 逐字节还原。
 *
 * 跑法：npx vitest run test/arch/exempt-pierce.test.ts
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const TARGET = join(ROOT, "docs", "review", "verify-open-invariants.mjs");

const ORIGINAL = readFileSync(TARGET, "utf8");

function runScript(): { green: boolean; out: string } {
  const r = spawnSync(process.execPath, [TARGET], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = String(r.stdout) + String(r.stderr);
  return { green: r.status === 0, out };
}

/** 从 EXEMPT 表里抓 key。两种写法都要认：
 *   单行 `["83697c4", "reason…"],` 与多行 `[\n  "7109a8c",\n  "reason…"]`。
 *   ⇒ 匹配 `[` 后跟 `"key",`，不看行尾（单行行尾是 `]`）。 */
const KEY_ANCHOR = /\[\s*"([0-9a-fA-F]{7,40})",/gmu;
const keys = [
  ...new Set(
    [...ORIGINAL.matchAll(KEY_ANCHOR)].map((m) =>
      (m[1] as string).toLowerCase(),
    ),
  ),
].filter((k) => k !== "1877e8e"); // HASHLIST 钉住的检查器哈希，不是 EXEMPT

const INVALID = "zzzzzzz"; // 非 hex，采不到 ⇒ 换了=把豁免拿掉，但不污染语料

function rollback() {
  writeFileSync(TARGET, ORIGINAL, "utf8");
  expect(readFileSync(TARGET, "utf8"), "回滚后字节必须与原文一致").toBe(
    ORIGINAL,
  );
}

describe("verify-open-invariants EXEMPT 穿透（round346）", () => {
  it("基线：脚本未变异时可复算绿", () => {
    const r = runScript();
    expect(r.green, r.out.slice(-1400)).toBe(true);
  });

  it("EXEMPT 表 16 条 key 全部提取到且锚点唯一", () => {
    expect(keys.length).toBe(16);
    for (const k of keys) {
      const n = ORIGINAL.split(`"${k}"`).length - 1;
      expect(n, `${k} 的引号锚点应唯一命中`).toBe(1);
    }
  });

  for (const key of keys) {
    it(`穿透 ${key}：从 EXEMPT 拿掉 ⇒ 脚本红且点名该 key（然后逐字节还原）`, () => {
      const before = readFileSync(TARGET, "utf8");
      const next = before.replace(`"${key}"`, `"${INVALID}"`);
      expect(next, "变异必须真的改变字节").not.toBe(before);
      writeFileSync(TARGET, next, "utf8");
      let got: { green: boolean; out: string };
      try {
        got = runScript();
      } finally {
        rollback(); // 任何情况都还原；若断言失败仍保证文件干净
      }
      expect(
        got.green,
        "删掉一条真·承重豁免后脚本必须红（证明确实在放行）",
      ).toBe(false);
      expect(got.out).toContain(key); // 点名 = 不是别的桶在红
      // 且失败因确实是这条豁免：豁免桶或 "腐烂" 出现在输出
      expect(got.out).toMatch(/(豁免|腐烂|⑤)/u);
    });
  }

  it("全还原后复跑 ⇒ 脚本恢复绿", () => {
    expect(readFileSync(TARGET, "utf8"), "16 条逐字节还原后应干净").toBe(
      ORIGINAL,
    );
    const r = runScript();
    expect(r.green, r.out.slice(-1400)).toBe(true);
  });
});
