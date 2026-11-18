// probe303: direction measurement for normalizeAbs / isInsideWorkspace / workspaceContainmentBlock.
// Runs the REAL functions from packages/hub/src/harness/safety.ts — nothing re-implemented.
import { describe, expect, it } from "vitest";
import {
  isInsideWorkspace,
  workspaceContainmentBlock,
} from "../packages/hub/src/harness/safety.js";

const rows: Array<[string, string, string]> = [
  ["ws-win tgt-win innocent", "D:\\repo\\ws", "D:\\repo\\ws\\packages\\a\\file.ts"],
  ["ws-win tgt-win .. escape", "D:\\repo\\ws", "D:\\repo\\ws\\..\\secret\\k.txt"],
  ["ws-slash tgt-slash .. escape", "D:/repo/ws", "D:/repo/ws/../secret/k.txt"],
  ["posix innocent", "/repo/ws", "/repo/ws/x"],
  ["posix .. escape", "/repo/ws", "/repo/ws/../secret/k.txt"],
  ["mixed: win ws, slash-.. tgt", "D:\\repo\\ws", "D:\\repo\\ws/../secret/k.txt"],
  ["FAIL-OPEN probe: slash ws + backslash dots in tgt", "D:/repo/ws", "D:/repo/ws/x\\..\\..\\secret\\k.txt"],
  ["FAIL-OPEN probe 2: win ws, slash boundary + backslash dots", "D:/repo/ws", "D:/repo/ws/a\\..\\..\\..\\secret\\k.txt"],
  ["GATEWAY-LEGAL ws /repo/ws, backslash .. escape", "/repo/ws", "/repo/ws/x\\..\\..\\secret\\k.txt"],
  ["GATEWAY-LEGAL ws /repo/ws, pure backslash path", "/repo/ws", "/repo/ws\\..\\secret\\k.txt"],
];

describe("probe303 direction of normalizeAbs", () => {
  it("prints real return values for every row", () => {
    const table: string[] = [];
    for (const [label, ws, tgt] of rows) {
      const inside = isInsideWorkspace(ws, tgt);
      const verdict = workspaceContainmentBlock(ws, tgt);
      table.push(
        JSON.stringify({
          label,
          ws,
          tgt,
          isInsideWorkspace: inside,
          verdict,
        }),
      );
    }
    // console output is enough; expect() here only satisfies requireAssertions if enabled.
    process.stdout.write("\nPROBE303\n" + table.join("\n") + "\nEND\n");
    expect(table.length).toBe(rows.length);
  });
});
