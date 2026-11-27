/**
 * round387 变异机：证明「命令名可跑」这一族的断言真承重。
 *
 * 每发变异真抹源文件里的字节（不是加注释、不是改大小写），跑对应的测试文件，
 * 要求：① 读数可读（拿到 vitest 的摘要行）② 该红的红。任何一发在【字节没变】
 * 的情况下被标成 expectedRed ⇒ 直接抛（0071 §5 那发假变异的家法）。
 * 收尾在 finally 里逐字节还原并核对 sha256。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sha = (b: string): string => createHash("sha256").update(b, "utf8").digest("hex");

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  /** 跑哪个测试文件。 */
  readonly test: string;
  /** 期望红？true = 必须抓到；false = 控制组，必须仍绿。 */
  readonly expectedRed: boolean;
}

const APP = "packages/web/public/app.js";
const WORK = "packages/hub/src/engine/work.ts";
const DRIVER = "packages/hub/src/engine/driver.ts";
const CLI = "packages/hub/src/cli.ts";
const PRED = "test/arch/cmd-name-runnable.ts";
const CMD_TEST = "test/arch/cmd-name-runnable.test.ts";

const MUTS: Mutation[] = [
  {
    name: "M1 app.js 横幅退回裸 hub work",
    file: APP,
    find: "或手工跑 pnpm hub:engine work。",
    replace: "或手工跑 hub work。",
    test: CMD_TEST,
    expectedRed: true,
  },
  {
    name: "M2 WORK_USAGE 丢掉 pnpm 前缀",
    file: WORK,
    find: '"用法：pnpm hub:engine work --db <path>',
    replace: '"用法：hub:engine work --db <path>',
    test: "packages/hub/test/engine/work.test.ts",
    expectedRed: true,
  },
  {
    name: "M3 describeAdvance 的 stalled 补救退回裸命令名",
    file: DRIVER,
    find: "再推一次 pnpm hub:engine work 即可。",
    replace: "再推一次 hub:engine work 即可。",
    test: "packages/hub/test/engine/driver.test.ts",
    expectedRed: true,
  },
  {
    name: "M4 cli.ts 用法文本退回裸命令名",
    file: CLI,
    find: '"用法：pnpm hub run    --db <path>',
    replace: '"用法：hub run    --db <path>',
    test: CMD_TEST,
    expectedRed: true,
  },
  {
    name: "M5 前缀核对被写成恒真（一律算带 pnpm）",
    file: PRED,
    find: '  return line.slice(Math.max(0, idx - 5), idx) === "pnpm ";',
    replace: "  return true;",
    test: CMD_TEST,
    expectedRed: true,
  },
  {
    name: "M6 WORK_USAGE 首行退回不带 pnpm 的 hub:engine",
    file: WORK,
    find: '"用法：pnpm hub:engine decide --db <path>',
    replace: '"用法：hub:engine decide --db <path>',
    test: "packages/hub/test/engine/work.test.ts",
    expectedRed: true,
  },
  {
    name: "M7 脚本名形态的键名核对被摘掉（pnpm hub:work 也放行）",
    file: PRED,
    find: "              ? precededByPnpm(line, idx) && scriptKeys.has(token)",
    replace: "              ? precededByPnpm(line, idx)",
    test: CMD_TEST,
    expectedRed: true,
  },
  {
    name: "M8 脚本名形态的前缀核对被摘掉（裸 hub:engine 放行）",
    file: PRED,
    find: "              ? precededByPnpm(line, idx) && scriptKeys.has(token)",
    replace: "              ? scriptKeys.has(token)",
    test: CMD_TEST,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只加一行无关注释",
    file: APP,
    find: "  if (!driver.enabled) {",
    replace: "  // 控制组：这一行什么都不改\n  if (!driver.enabled) {",
    test: CMD_TEST,
    expectedRed: false,
  },
];

function strip(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/gu, "");
}

function runTest(file: string): { red: boolean; summary: string; fails: string[] } {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", file, "--reporter=dot"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    code = typeof err.status === "number" ? err.status : 1;
  }
  const clean = strip(out);
  const m = /Tests\s+(.{0,80}?)\n/u.exec(clean);
  if (m === null) {
    throw new Error("读数不可读（没拿到 vitest 摘要行），中止：\n" + clean.slice(-2000));
  }
  const fails = [...clean.matchAll(/FAIL\s+\S+\s+>\s+(.+)/gu)].map((x) =>
    (x[1] as string).trim(),
  );
  return { red: code !== 0, summary: m[1] as string, fails: [...new Set(fails)] };
}

const originals = new Map<string, string>();
let failed = 0;
try {
  for (const m of MUTS) originals.set(m.file, readFileSync(m.file, "utf8"));
  console.log("── 预检（未变异必须绿）──");
  for (const f of new Set([CMD_TEST, "packages/hub/test/engine/work.test.ts", "packages/hub/test/engine/driver.test.ts"])) {
    const r = runTest(f);
    console.log((r.red ? "× 预检就红 " : "✓ ") + f + " :: " + r.summary);
    if (r.red) throw new Error("预检未变异已红，判据无从归因");
  }
  for (const m of MUTS) {
    const original = originals.get(m.file) as string;
    if (!original.includes(m.find)) throw new Error(m.name + "：锚点串找不到，变异没发生");
    writeFileSync(m.file, original.replace(m.find, m.replace), "utf8");
    const mutated = readFileSync(m.file, "utf8");
    if (mutated === original) throw new Error(m.name + "：字节一个字没变 = 假变异");
    let r: { red: boolean; summary: string; fails: string[] };
    try {
      r = runTest(m.test);
    } finally {
      // 每发【各自】还原：上一版只在收尾还原，于是 M5 把判据改成恒放行之后
      // 才跑控制组 —— 控制组那发红的是【上一发的残留】，不是它自己的行为。
      // 一次归因错，比少跑一发贵得多。
      writeFileSync(m.file, original, "utf8");
      if (sha(readFileSync(m.file, "utf8")) !== sha(original)) {
        throw new Error(m.name + "：单发还原后 sha256 不符：" + m.file);
      }
    }
    const caught = r.red === m.expectedRed;
    if (!caught) failed += 1;
    console.log(
      (caught ? "✓ " : "× ") + m.name + " :: 期望" + (m.expectedRed ? "红" : "绿") +
        " 实得" + (r.red ? "红" : "绿") + " :: " + r.summary +
        (r.fails.length > 0 ? " :: 红的是 " + r.fails.slice(0, 3).join(" / ") : ""),
    );
  }
} finally {
  for (const [file, text] of originals) {
    writeFileSync(file, text, "utf8");
    const back = readFileSync(file, "utf8");
    if (sha(back) !== sha(text)) throw new Error("还原后 sha256 不符：" + file);
  }
  console.log("── 还原：全部逐字节一致（sha256 核对过）──");
}
console.log(failed === 0 ? "变异机结论：全部符合预期" : "变异机结论：" + failed + " 发不符");
process.exitCode = failed === 0 ? 0 : 1;
