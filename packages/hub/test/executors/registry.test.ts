/**
 * 执行器注册表（T6）：装配表的形状判据。
 *
 * 这里【不】碰库 —— registry 是纯内存表，DB 语义全在 run.test.ts。
 * 四条判据各钉文件头一段立场：
 *  · 空表 get null（未注册 = 不可用，路由器的唯一读取谓词）；
 *  · 重复 kind 构造【抛】（覆盖语义会让先注册那份静默变死代码）；
 *  · registerDisabled 后 get null 且 disabled 含它（同形但可归因）；
 *  · list() 只含启用项且按注册序（禁用即从序里抹掉）。
 */
import type { ExecutorKind } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { ExecutorRegistry } from "../../src/executors/registry.js";
import type { Executor } from "../../src/executors/types.js";

/** 注册表只看 kind，run 永不真跑 —— 抛错的桩，误调用必响。 */
function stub(kind: ExecutorKind): Executor {
  return {
    kind,
    run: async () => {
      throw new Error("registry.test 的桩不该被 run");
    },
  };
}

describe("ExecutorRegistry", () => {
  it("空表：任何 kind 都 get null，list 为空", () => {
    const reg = new ExecutorRegistry([]);
    expect(reg.get("pure-model")).toBeNull();
    expect(reg.get("claude-cli")).toBeNull();
    expect(reg.list()).toEqual([]);
  });

  it("重复 kind：构造抛（覆盖语义 = 装配手误的静默收容，拒绝）", () => {
    expect(
      () => new ExecutorRegistry([stub("pure-model"), stub("pure-model")]),
    ).toThrow(/pure-model/);
    // 不同 kind 互不干扰：重复判据按 kind 而非按实例。
    expect(
      () => new ExecutorRegistry([stub("pure-model"), stub("human")]),
    ).not.toThrow();
  });

  it("registerDisabled：get 转 null，disabled 可指认，list 不含禁用", () => {
    const reg = new ExecutorRegistry([stub("pure-model"), stub("human")]);
    expect(reg.get("pure-model")).not.toBeNull();
    reg.registerDisabled("pure-model");
    // 同形：路由器只看到 null；归因看 disabled。
    expect(reg.get("pure-model")).toBeNull();
    expect(reg.disabled.has("pure-model")).toBe(true);
    // 未禁用的不受牵连。
    expect(reg.get("human")).not.toBeNull();
    expect(reg.disabled.has("human")).toBe(false);
    // list = 已启用 kinds 按注册序：禁用项已从序里抹掉。
    expect(reg.list()).toEqual(["human"]);
  });

  it("禁用未注册的 kind 也记账（禁用集记意图，与装配表不互为前提；幂等）", () => {
    const reg = new ExecutorRegistry([stub("human")]);
    reg.registerDisabled("claude-cli");
    reg.registerDisabled("claude-cli");
    expect(reg.get("claude-cli")).toBeNull();
    // disabled 里能分清「故意裁掉」与「装配漏装」：claude-cli ∈ disabled ⇒ 裁剪；
    // codex-cli ∉ disabled 且 get null ⇒ 真漏装。
    expect(reg.disabled.has("claude-cli")).toBe(true);
    expect(reg.get("codex-cli")).toBeNull();
    expect(reg.disabled.has("codex-cli")).toBe(false);
    expect(reg.list()).toEqual(["human"]);
  });
});
