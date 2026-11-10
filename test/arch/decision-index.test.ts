/**
 * 决策索引与 decisions/ 目录的一致性守卫。
 *
 * 为什么不能只靠人记得更新：docs/INDEX.md 自己写着「改实现前先读对应条目」，是「为什么
 * 这样实现」的唯一出处。2026-11-07 真漏过一次 —— 0007 已经创建并提交三轮，INDEX 还停在
 * 0006，那份关于静默丢弃与恒绿守卫的记录对所有人不可见。这类遗漏平时零症状，只在「按索引
 * 找东西」时暴露，所以必须机械化，而不是靠下次记得。
 *
 * 双向都查：文件存在但索引没列（漏更新）、索引列了但文件不存在（写了不存在的号，例如把
 * 计划预约给 Task 4.6 的 0002 当成已有条目）。
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffIds, fileIds, listedIds, readIndex } from "./index-diff.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DECISIONS = join(ROOT, "docs", "decisions");

describe("决策索引与 decisions/ 目录一致", () => {
  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    // 人工构造两类不一致，必须被抓到。这是本节唯一的自证有效性证据：
    // 只断言「现在两边一样」，其失效方式与恒真不可区分。
    expect(diffIds(["0001", "0007"], ["0001"])).toEqual({
      missing: ["0007"],
      extra: [],
    });
    expect(diffIds(["0001"], ["0001", "9999"])).toEqual({
      missing: [],
      extra: ["9999"],
    });
    expect(diffIds([], [])).toEqual({ missing: [], extra: [] });

    // 列表解析只认行首的 - **NNNN**：正文提到的号、引文里的加粗号、位数不对的号、
    // 没闭合的号都不算 —— 后两类上一版注释没提，因为它自己的样例就没含这两种。
    const lines = [
      "- **0001** 甲",
      "提到 0002 但没有条目",
      "> **0003** 是引文不是列表项",
      "- **001** 位数不足",
      "- **000a** 不是纯数字",
      "- **0000* 少一个闭合星号：字段没闭合就不算列出",
      "- **00123** 字段过长：闭合星号落在别处，也不算",
    ];
    expect(listedIds(lines.join(String.fromCharCode(10)))).toEqual(["0001"]);
  });

  it("decisions/ 的每个编号都在 INDEX 列出，且 INDEX 不列不存在的号", () => {
    const actual = fileIds(DECISIONS);
    const listed = [...new Set(listedIds(readIndex(ROOT)))].sort();
    // 下限断言防的是「目录存在但异常为空」（有人把 decisions/ 改名并建个空目录）。
    // 它【不是】防路径写错的防线 —— 实测：路径写错时 readdirSync / readFileSync 直接抛
    // ENOENT，测试立刻红（三个方向都验过，见 0006 §7 第 16 条）。我最初给这条断言写的
    // 理由正是「防路径写错导致 0 == 0 假绿」，那个理由没验过而且是错的。
    expect(existsSync(DECISIONS)).toBe(true);
    expect(actual.length).toBeGreaterThanOrEqual(6);
    expect(listed.length).toBeGreaterThanOrEqual(6);
    expect(diffIds(actual, listed)).toEqual({ missing: [], extra: [] });
  });
});
