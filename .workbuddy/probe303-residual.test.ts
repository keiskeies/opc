// round303 一次性：验台账 §⑧②③ 那两句是【实测】还是【我的推理】。
// 跑法（从仓库根）：npx vitest run .workbuddy/probe303-residual.test.ts
import { describe, expect, it } from "vitest";
import { isInsideWorkspace } from "../packages/hub/src/harness/safety.js";

describe("probe303 残留读数", () => {
  it("逐条打印：大小写 / 盘符绝对路径的 .. 残留", () => {
    const cases: [string, string][] = [
      ["D:/REPO", "D:/repo/x"],
      ["D:/repo", "D:/REPO/x"],
      ["D:/repo/ws", "D:/repo/ws/../secret/k.txt"],
      ["D:/repo/ws/..", "D:/repo/ws/x"],
      ["D:/repo", "D:/repo/a/../../x"],
    ];
    const rows = cases.map(([ws, t]) =>
      JSON.stringify(ws) + " + " + JSON.stringify(t) + " ⇒ " +
      (isInsideWorkspace(ws, t) ? "inside" : "outside"),
    );
    console.log("\n──────── probe303 残留读数 ────────\n" + rows.join("\n") + "\n──────────");
    expect(rows.length).toBe(cases.length);
  });
});
