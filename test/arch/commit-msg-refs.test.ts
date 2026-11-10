/**
 * 见 commit-msg-refs.ts 的开头。本文件只做两件事：先证明判据有判别力（canary），
 * 再拿真实历史跑一遍。canary 在前，跑红就整节作废（0006 §7 第 23 条）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  check,
  docIds,
  type Entry,
  EXEMPT,
  existingIds,
  loadEntries,
  reservedIds,
} from "./commit-msg-refs.js";

const NL: string = String.fromCharCode(10);
const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECISIONS: string = join(ROOT, "docs", "decisions");
const INDEX_FILE: string = join(ROOT, "docs", "INDEX.md");

describe("提交消息里的决策文档编号", () => {
  it("canary: 判据对人工种下的两种违规都有反应（否则本节是恒绿装饰）", () => {
    const fake: Entry[] = [
      {
        hash: "aaaa1110000000000000",
        subject: "docs(0006): 声称改了 0006",
        body: "",
        files: ["docs/decisions/0007-x.md"],
      },
      {
        hash: "bbbb2220000000000000",
        subject: "fix(hub): 修一处",
        body: "见 0999 那篇",
        files: ["packages/hub/src/x.ts"],
      },
      {
        hash: "cccc3330000000000000",
        subject: "docs(0006): 合法对照",
        body: "顺带引用 0001",
        files: ["docs/decisions/0006-cli-resume-and-identity.md"],
      },
    ];
    const got = check(
      fake,
      new Set(["0001", "0006"]),
      new Set<string>(),
      new Set<string>(),
    );
    expect(got.map((p) => p.hash + ": " + p.why)).toEqual([
      "aaaa111: scope 撒谎: 标题写了 docs(0006) 却没碰那篇文档",
      "bbbb222: 死引用: 提到不存在的 0999",
    ]);
  });

  it("canary: 引用号的边界与顺序（少了词首边界或放宽尾字符类就会变红）", () => {
    /* 三种形态都不算一次【引用】：路径里的号、后面粘着数字、前面粘着单词字母。 */
    expect(docIds("docs/decisions/0004-x.md 里那个号不算引用")).toEqual([]);
    expect(docIds("09991 不是四位数编号")).toEqual([]);
    expect(docIds("task-0123 也不是")).toEqual([]);
    /* 排序保证报出的问题顺序稳定，否则两次运行的 diff 会乱跳 */
    expect(docIds("见 0007 与 0002 两个号")).toEqual(["0002", "0007"]);
    /* 词首边界：mydocs(0006) 不是 docs scope。若被当成 scope，这条没碰 0006 的提交
       就会被误报，守卫假红 —— 0007 §4.1 记过：假红比假绿更贵，因为人会关掉它。 */
    const fake: Entry[] = [
      {
        hash: "dddd4440000000000000",
        subject: "refactor(store): mydocs(0006) 只是文件名",
        body: "",
        files: ["packages/hub/src/store.ts"],
      },
    ];
    expect(
      check(fake, new Set(["0006"]), new Set<string>(), new Set<string>()),
    ).toEqual([]);
  });

  it("canary: 预约号从 INDEX 机械读出（逐提交登记豁免必然假红）", () => {
    /* 正对照照抄 INDEX 的真实形态：同一行里同时有编号和【预约】二字才成立。 */
    const sample = [
      "> 编号不连续：**0002 从未创建** —— 历史里既没有该文件。",
      "> 但它**不是废弃号**：计划把 `docs/decisions/0002-no-personal-wechat.md` 预约给了 Task 4.6",
    ].join(NL);
    expect(reservedIds(sample)).toEqual(["0002"]);
    /* 少了关键词就不算预约：否则任何引用块里的路径都会变成豁免 */
    expect(reservedIds(sample.replace("预约", "提到"))).toEqual([]);
    /* 正文行（非引用块）里的同一句不算声明 */
    expect(reservedIds(sample.replaceAll(">", "x"))).toEqual([]);
    /* 预约号放过合法陈述，但不顺手放过别的错号 */
    const fake: Entry[] = [
      {
        hash: "eeee5550000000000000",
        subject: "docs(index): 记 0002 从未创建",
        body: "顺带一提 0999",
        files: ["docs/INDEX.md"],
      },
    ];
    expect(
      check(fake, new Set(["0001"]), new Set(["0002"]), new Set<string>()),
    ).toEqual([{ hash: "eeee555", why: "死引用: 提到不存在的 0999" }]);
  });

  it("真实历史: 标题 scope 与实际改动一致，且不引用不存在的编号", () => {
    const entries = loadEntries(ROOT);
    /* 前提断言（0006 §7 第 32 条）：先确认工具真读到了东西，否则 0 == 0 会假绿 */
    expect(entries.length).toBeGreaterThanOrEqual(60);
    const scoped = entries.filter((e) =>
      /\bdocs\((0[0-9]{3})\)/.test(e.subject),
    ).length;
    expect(scoped).toBeGreaterThanOrEqual(1);
    const existing = new Set(existingIds(DECISIONS));
    expect(existing.size).toBeGreaterThanOrEqual(6);
    const reserved = new Set(reservedIds(readFileSync(INDEX_FILE, "utf8")));
    /* 前提断言：预约集合非空。INDEX 措辞一改它就空掉，届时老提交会假红，必须先知道 */
    expect(reserved.size).toBeGreaterThanOrEqual(1);
    expect(reserved.has("0002")).toBe(true);
    // 提交号 + 原因拼串：断数组时红了只看到 Array(1)，不知道是哪条提交。
    expect(
      check(entries, existing, reserved, EXEMPT)
        .map((p) => p.hash.slice(0, 7) + " " + p.why)
        .join(" | "),
    ).toEqual("");
  });
});
