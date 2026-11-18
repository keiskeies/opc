// round303 一次性：新旧两份真字节跑【同一张表】，把「本轮到底改了哪些行为」打出来。
// 跑法：node node_modules/vitest/vitest.mjs run --config .workbuddy/probe303-vitest.config.mjs
import { describe, expect, it } from "vitest";
import {
  isInsideWorkspace as isInsideNew,
} from "../packages/hub/src/harness/safety.js";
import { isInsideWorkspace as isInsideOld } from "./probe303-old-safety.ts";

const CASES: [string, string][] = [
  ["/repo", "/repo-evil/x.ts"],
  ["/repo", "/repo/x.ts"],
  ["/repo", "/repo"],
  ["/repo/", "/repo/x"],
  ["/repo", "/repo/../etc/passwd"],
  ["/repo", "/repo/a/../b/x.ts"],
  ["/repo", "etc/passwd"],
  // 本轮要堵的那一型（混合形状，Windows 读法下越界）。
  ["/repo/ws", "/repo/ws/x\\..\\..\\secret\\k.txt"],
  ["/repo/ws", "/repo/ws/a\\..\\..\\b.ts"],
  ["/repo/ws", "/repo/ws/deep/dir\\..\\..\\..\\etc\\passwd"],
  ["/repo/ws/", "/repo/ws\\..\\x"],
  // 反向对照：两种读法都在里面 ⇒ 不许误伤。
  ["/repo", "/repo/a/b.ts"],
  ["/repo", "/repo/weird\\name.ts"],
  ["/repo/ws", "/repo/ws/a\\b\\c.ts"],
  ["/repo/ws", "/repo/ws/x\\..\\y"],
  ["/repo/ws", "/repo/ws/only\\backslash"],
  ["/repo/w\\s", "/repo/w\\s/ok.ts"],
  // 我怀疑是「本轮多拦」的那一型 —— 让新旧对出来，别由我宣称。
  ["/repo/ws", "/repo/ws\\a"],
  // 全反斜杠 + 斜杠盘符。
  ["D:\\repo\\ws", "D:\\repo\\ws\\packages\\a\\file.ts"],
  ["D:/repo/ws", "D:/repo/ws/packages/a/file.ts"],
  ["D:/repo/ws", "D:/repo/ws/../secret/k.txt"],
];

describe("probe303 新旧对照", () => {
  it("逐对打印 旧 → 新，并单列【行为变了】的那些", () => {
    const lines: string[] = [];
    const changed: string[] = [];
    for (const [ws, t] of CASES) {
      const o = isInsideOld(ws, t);
      const n = isInsideNew(ws, t);
      const mark = o === n ? "  同" : "★变";
      const row =
        mark +
        "  " +
        (o ? "inside " : "outside") +
        " → " +
        (n ? "inside " : "outside") +
        "   " +
        JSON.stringify(ws) +
        " + " +
        JSON.stringify(t);
      lines.push(row);
      if (o !== n) changed.push(row);
    }
    console.log(
      "\n──────── probe303 新旧对照（★变 = 本轮改了行为）────────\n" +
        lines.join("\n") +
        "\n\n  变了 " +
        changed.length +
        " / " +
        CASES.length +
        "\n──────────────",
    );
    // 这一发【只打印不判定】：判定在 packages/hub/test/harness/safety.test.ts，
    // 这里产出的是「本轮到底改了什么」的事实清单。
    expect(lines.length).toBe(CASES.length);
  });
});
