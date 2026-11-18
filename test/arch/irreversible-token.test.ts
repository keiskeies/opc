/**
 * 「不可逆 ⇒ 一次性令牌」守卫的测试（判据在 irreversible-token.ts）。
 *
 * 取材口径照 claims-registry：真仓库一侧扫 packages/hub/src 全部非 poc、
 * 非 .test.ts 的 .ts —— 与判据吃的是同一个 Map，变异一侧喂合成 Map。
 * 验收句（§O11）：绕过 token 校验直接调 approveCard ⇒ 必须红 —— 那是合成一发
 * 「[evil.ts] await approveCard(...)」，不往真 src 造文件。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listHubSrc } from "./claims-registry.js";
import {
  APPROVE_CARD_CALLERS,
  APPROVE_PATHS,
  checkIrreversibleToken,
  REJECT_BUILD_MARKER,
  type SrcCorpus,
} from "./irreversible-token.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(ROOT, "packages", "hub", "src");

/**
 * 真仓库语料：直接复用 claims-registry 的 listHubSrc，于是【与 allSrc 同一口径】这句
 * 由构造成立。本文件此前自己写了一份 walk，于是 allSrc 补上「排除运行期夹具」之后
 * 这里落后一格 —— 探针活着的时候语料比 allSrc 多一个文件，而那种差只在并发时看得见。
 */
function realSrc(): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of listHubSrc(ROOT)) {
    // 只宽容「消失了」（ENOENT/ENOTDIR）：短命夹具在列清单与读文件之间被删掉
    //（同 test-inventory.ts 的 survivesStat 家规）。权限类错误照抛 —— 吞掉等于把
    // 真存在的文件静默抹出语料，那正是本守卫自己要防的「语料悄悄少了一个」。
    try {
      out.set(rel, readFileSync(join(SRC, rel), "utf8"));
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }
  return out;
}

const corpus = (over: Record<string, string> = {}): SrcCorpus => {
  const m = realSrc();
  for (const [k, v] of Object.entries(over)) m.set(k, v);
  return m;
};

describe("不可逆⇒一次性令牌：真仓库今天自洽", () => {
  it("判据对今天的 hub/src 返回空", () => {
    expect(checkIrreversibleToken(corpus())).toBe("");
  });

  it("取材没坏：名单四条与两条调用方都读到特征串", () => {
    const srcs = corpus();
    for (const e of [...APPROVE_PATHS, ...APPROVE_CARD_CALLERS]) {
      expect(srcs.has(e.file), e.file + " 不在语料里").toBe(true);
    }
    expect(srcs.get("approvals/cards.ts")).toContain(REJECT_BUILD_MARKER);
  });

  it("写「卡片被决定」的文件今天恰好是名单那四个（口径非空的证明）", () => {
    const writers: string[] = [];
    for (const [name, text] of corpus()) {
      if (/UPDATE\s+approvals\s+SET\s+status/isu.test(text)) writers.push(name);
    }
    expect(writers.sort()).toEqual(
      APPROVE_PATHS.map((e) => e.file).sort(),
    );
  });
});

describe("不可逆⇒一次性令牌：变异判别力（合成输入）", () => {
  it("验收句：新增文件绕过凭据直接 await approveCard ⇒ 红", () => {
    expect(
      checkIrreversibleToken(
        corpus({
          "engine/evil.ts":
            "export async function x(w) { return await approveCard(w, o, publish); }",
        }),
      ),
    ).toContain("engine/evil.ts");
  });

  it("新增文件偷偷写 UPDATE approvals SET status ⇒ 红", () => {
    expect(
      checkIrreversibleToken(
        corpus({
          "policy/shortcut.ts":
            'db.prepare("UPDATE approvals SET status = ? WHERE id = ?").run("approved", id);',
        }),
      ),
    ).toContain("policy/shortcut.ts");
  });

  it("名单条目过期（特征串被删）⇒ 红", () => {
    const r = checkIrreversibleToken(
      corpus({ "policy/auto-approve.ts": "export const gone = 1;" }),
    );
    expect(r).toContain("policy/auto-approve.ts");
    expect(r).toContain("过期");
  });

  it("建卡拒建判据消失 ⇒ 红（timeout 的 auto_approve 支失去兜底）", () => {
    const cards = realSrc().get("approvals/cards.ts") as string;
    expect(
      checkIrreversibleToken(
        corpus({ "approvals/cards.ts": cards.replaceAll(REJECT_BUILD_MARKER, "已移除") }),
      ),
    ).toContain(REJECT_BUILD_MARKER);
  });

  it("登记条目 why 为空 ⇒ 红（名单不是豁免表）", () => {
    expect(
      APPROVE_PATHS.every((e) => e.why.trim() !== "") &&
        APPROVE_CARD_CALLERS.every((e) => e.why.trim() !== ""),
    ).toBe(true);
  });
});
