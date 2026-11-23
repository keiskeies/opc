/**
 * 守卫 docs/review/verify-open-invariants.mjs 的 ③ 窗口判据（CLAIMS_TRANSIENT）
 * 不得含 "absent" / "blob"。背景：
 *   verify 154 行注释明说「走【具名豁免】而不是把 "absent"/"blob" 之类词加进
 *   ③ 的窗口判据 —— 宁可表长，不可口子宽」。blob 当年已删；round353l 逐词
 *   探针发现 absent 被漏删（Δ0 死词：删它 transient 44→44，今天零影响），
 *   round353m 补同一刀。本守卫钉住【这两个词再被加回 ③】⇒ 红。
 *
 * 形状：只读 verify 源文件，不 spawn、不绑定仓库此刻绿不绿（见 gate-selfcheck
 *   0007 §4.1 取舍），只在「语义词回到窗口判据」这一条结构不变量上红 ⇒
 *   永不随语料内容误报。
 * 自证带：断言两个语义词【必须真实出现在文件里】（154 行排除声明 / 164 行
 *   EXEMPT 描述里就有）—— 若我把探针串抄错（absnet），这条会先红，防
 *   「恰好抄成一个永远匹配不上的串」的静默恒假。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const VERIFY = join(
  import.meta.dirname,
  "..",
  "..",
  "docs",
  "review",
  "verify-open-invariants.mjs",
);
const SRC = readFileSync(VERIFY, "utf8");

// 码位拼语义词，跟 gate-selfcheck 的 WORD_UNREADABLE 同法（防抄错）。
const WORD_ABSENT = String.fromCharCode(0x61, 0x62, 0x73, 0x65, 0x6e, 0x74); // absent
const WORD_BLOB = String.fromCharCode(0x62, 0x6c, 0x6f, 0x62); // blob

/** 摘出 `const CLAIMS_TRANSIENT = ...;` 整条赋值语句（含注释前的正则字面量）。 */
function transientStatement(): string {
  const m = SRC.match(
    /const CLAIMS_TRANSIENT\s*=[\s\S]*?\/[^/]+\/[dgimsuvy]*\s*;/u,
  );
  expect(
    m,
    "CLAIMS_TRANSIENT 赋值语句必须存在（改错锚点会红，不是静默放羊）",
  ).toBeTruthy();
  return (m as RegExpMatchArray)[0];
}

it("自证带：absent/blob 必须真实出现在文件里（防我把探针串抄错）", () => {
  expect(
    SRC.includes(WORD_ABSENT),
    "absent 应在 154/164 行的排除声明/描述里",
  ).toBe(true);
  expect(SRC.includes(WORD_BLOB), "blob 应在 154 行排除声明里").toBe(true);
});

it("round353m：absent / blob 不得回到 ③ 窗口判据", () => {
  const stmt = transientStatement();
  // 若未来有人把词加回窗口判据（口子变宽），这两条红。注释里出现这
  // 两个词不算：注释在赋值语句之外（round353m 起把注释移到了语句上方）。
  expect(stmt, "③ 窗口判据不得含 absent —— round353m 收的口子").not.toContain(
    WORD_ABSENT,
  );
  expect(stmt, "③ 窗口判据不得含 blob —— 154 行声明的原意").not.toContain(
    WORD_BLOB,
  );
});

it("③ 窗口判据仍是 alternation 形态（防未来改成可绕过形状）", () => {
  const stmt = transientStatement();
  expect(stmt, "判据应为 /(词1|词2|…)/i 形态").toMatch(
    /^const CLAIMS_TRANSIENT\s*=[\s\S]*?\/\([^)]*\|\|?[^)]*\)\/i;/u,
  );
});
