/**
 * 单发变异手跑：抹一根线 → 跑一发 → finally 还原并核 sha256。
 * 用法：node --experimental-strip-types .workbuddy/round392-shot.mts <M3|M5|M11|M9> [playwright|vitest]
 * 目的：机器整跑前先确认「这一发真的会红在它该红的字段上」。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sha = (b: string) => createHash("sha256").update(b, "utf8").digest("hex");
const NL = "\n";
const GROUPJS = "packages/web/public/group.js";
const GUARD = "test/web/history-cursor-producer.test.ts";
const E2E = "会话历史翻页";

const CURSOR_LINE = "  state.messagesCursor = historyCursor(list);" + NL;
const RETAINED_INIT =
  "  const retained =" +
  NL +
  "    state.messagesWindowId === id ? retainOlderThan(state.messages, page) : [];";
const HAS_MORE_BLOCK =
  "  state.messagesHasMore =" +
  NL +
  "    retained.length > 0" +
  NL +
  "      ? state.messagesHasMore" +
  NL +
  "      : historyHasMore(page.length, MESSAGES_PAGE_LIMIT);";

const SHOTS: Record<string, { file: string; find: string; replace: string }> = {
  M3: {
    file: GROUPJS,
    find: "    pageLen > 0 &&" + NL + "    pageLen >= limit" + NL,
    replace: "    pageLen > 0" + NL,
  },
  M5: {
    file: GROUPJS,
    find: "    state.messages = fresh.concat(state.messages);",
    replace: "    state.messages = state.messages.concat(fresh);",
  },
  M9: { file: GROUPJS, find: RETAINED_INIT, replace: "  const retained = [];" },
  M11: {
    file: GROUPJS,
    find: HAS_MORE_BLOCK,
    replace:
      "  state.messagesHasMore = historyHasMore(page.length, MESSAGES_PAGE_LIMIT);",
  },
  M10: {
    file: GROUPJS,
    find: RETAINED_INIT,
    replace: "  const retained = retainOlderThan(state.messages, page);",
  },
  M12: {
    file: GROUPJS,
    find: CURSOR_LINE,
    replace: "  state.messagesCursor = historyCursor(page);" + NL,
  },
};

const key = process.argv[2] ?? "";
const runner = process.argv[3] ?? "playwright";
const shot = SHOTS[key];
if (!shot) throw new Error(`未知发名：${key}`);
const original = readFileSync(shot.file, "utf8");
const originalSha = sha(original);
const hits = original.split(shot.find).length - 1;
if (hits !== 1) throw new Error(`锚点出现 ${String(hits)} 次（要求恰好 1）`);

try {
  writeFileSync(shot.file, original.replace(shot.find, shot.replace), "utf8");
  console.log(`[${key}] 已抹线，跑 ${runner}`);
  let out = "";
  let code = 0;
  try {
    out =
      runner === "playwright"
        ? execFileSync(
            process.execPath,
            [
              "node_modules/playwright/cli.js",
              "test",
              "test/e2e/group-workbench.spec.ts",
              "--timeout=25000",
              "-g",
              E2E,
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          )
        : execFileSync(
            process.execPath,
            [
              "node_modules/vitest/vitest.mjs",
              "run",
              key === "M12" || key === "M10" ? GUARD : GUARD,
              "--reporter=dot",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    code = e.status ?? 1;
  }
  writeFileSync(`.workbuddy/round392-shot-${key}.txt`, out, "utf8");
  console.log(`[${key}] exit=${String(code)}（1=红，符合预期）`);
  const lines = out.split(/\r?\n/u).filter((l) => l.trim().length > 0);
  console.log(lines.slice(-24).join(NL));
} finally {
  writeFileSync(shot.file, original, "utf8");
  const back = sha(readFileSync(shot.file, "utf8"));
  console.log(
    back === originalSha ? "还原：逐字节一致" : `还原失败：${back} != ${originalSha}`,
  );
  if (back !== originalSha) process.exitCode = 2;
}
