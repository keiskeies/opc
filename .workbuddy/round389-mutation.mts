/**
 * round389 变异机：证明「头像去重键 + 上传接线」这一族的断言真承重。
 *
 * 每发变异真抹源文件里的字节，跑对应测试范围（vitest 或 playwright），要求：
 * ① 读数可读（vitest 的 Tests 摘要行 / playwright 的 passed|failed 行）
 * ② 该红的红、控制组仍绿。任何一发在【字节没变】的情况下被标成 expectedRed
 * ⇒ 直接抛。每发【各自】在 finally 里逐字节还原并核对 sha256。
 * 锚点必须恰好出现一次：出现 0 次 = 变异没发生，出现多次 = 替换落点不明，都抛。
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const sha = (b: string): string =>
  createHash("sha256").update(b, "utf8").digest("hex");

type Runner = "vitest" | "playwright";

interface Mutation {
  readonly name: string;
  readonly file: string;
  readonly find: string;
  readonly replace: string;
  readonly runner: Runner;
  /** vitest：测试文件/目录；playwright：-g 标题片段。 */
  readonly test: string;
  /** 期望红？true = 必须抓到；false = 控制组，必须仍绿。 */
  readonly expectedRed: boolean;
}

const SVC = "packages/hub/src/assets/service.ts";
const MIG = "packages/hub/resources/migrations/0029_assets_dedupe_per_purpose.sql";
const MIGTEST = "packages/hub/test/db/migrate.test.ts";
const MSVC = "packages/hub/src/members/service.ts";
const GROUPJS = "packages/web/public/group.js";
const CHAIN = "packages/hub/test/assets/avatar-chain.test.ts";
const DBDIR = "packages/hub/test/db";
const MSVC_TEST = "packages/hub/test/members/service.test.ts";
const E2E_SETTINGS = "头像上传：选图即传";
const E2E_HIRE = "招聘用工照";

const NL = "\n";
const SETTINGS_WIRE =
  '"aria-label": "头像资产 ID",' + NL + "        })," + NL + "        avatarImagePicker(),";
const HIRE_WIRE =
  'input("avatar_asset_id", "", "text", { hidden: true }),' +
  NL +
  "          avatarImagePicker(),";
const GUARD =
  "  if (assetId && seed) {" +
  NL +
  '    toast("头像资产与生成种子只能二选一：再选一次图片，或清空种子。", true);' +
  NL +
  "    return;" +
  NL +
  "  }" +
  NL;

const MUTS: Mutation[] = [
  {
    name: "M1 去重键退回只按 sha（少 purpose 维）",
    file: SVC,
    find: "WHERE sha256 = ? AND purpose = ?",
    replace: "WHERE sha256 = ?",
    runner: "vitest",
    test: CHAIN,
    expectedRed: true,
  },
  {
    name: "M2 查重侧写死 attachment（头像拿回附件行）",
    file: SVC,
    find: "const existing = findMetadata(db, sha256, options.purpose);",
    replace: 'const existing = findMetadata(db, sha256, "attachment");',
    runner: "vitest",
    test: CHAIN,
    expectedRed: true,
  },
  {
    name: "M3 复读侧写死 attachment（写完读不回自己行）",
    file: SVC,
    find: "const saved = findMetadata(db, sha256, options.purpose);",
    replace: 'const saved = findMetadata(db, sha256, "attachment");',
    runner: "vitest",
    test: CHAIN,
    expectedRed: true,
  },
  {
    name: "M4 0029 索引去掉 UNIQUE（库层不再兜底）",
    file: MIG,
    find: "CREATE UNIQUE INDEX idx_assets_sha_purpose ON assets(sha256, purpose);",
    replace: "CREATE INDEX idx_assets_sha_purpose ON assets(sha256, purpose);",
    runner: "vitest",
    test: DBDIR,
    expectedRed: true,
  },
  {
    name: "M5 0029 不 DROP 旧全表索引（跨用途必炸）",
    file: MIG,
    find: "DROP INDEX IF EXISTS idx_assets_sha;",
    replace: "-- DROP INDEX IF EXISTS idx_assets_sha;",
    runner: "vitest",
    test: CHAIN,
    expectedRed: true,
  },
  {
    name: "M6 硬编码版本清单里的 0029 写成对不上名",
    file: MIGTEST,
    find: '    "0029_assets_dedupe_per_purpose",',
    replace: '    "0029_assets_dedupe_per_purpose_x",',
    runner: "vitest",
    test: MIGTEST,
    expectedRed: true,
  },
  {
    name: "M7 头像门放行附件字节（渲染事故门摘掉）",
    file: MSVC,
    find: "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'avatar'",
    replace: "SELECT 1 AS ok FROM assets WHERE asset_id = ? AND purpose = 'attachment'",
    runner: "vitest",
    test: MSVC_TEST,
    expectedRed: true,
  },
  {
    name: "M8 上传器 purpose 改成 attachment",
    file: GROUPJS,
    find: 'uploadAssetBase64(file, "avatar")',
    replace: 'uploadAssetBase64(file, "attachment")',
    runner: "playwright",
    test: E2E_SETTINGS,
    expectedRed: true,
  },
  {
    name: "M9 设置页不挂上传按钮",
    file: GROUPJS,
    find: SETTINGS_WIRE,
    replace: SETTINGS_WIRE.replace(NL + "        avatarImagePicker(),", ""),
    runner: "playwright",
    test: E2E_SETTINGS,
    expectedRed: true,
  },
  {
    name: "M10 招聘表单不挂上传按钮",
    file: GROUPJS,
    find: HIRE_WIRE,
    replace: HIRE_WIRE.replace(NL + "          avatarImagePicker(),", ""),
    runner: "playwright",
    test: E2E_HIRE,
    expectedRed: true,
  },
  {
    name: "M11 摘掉资产/种子二选一守卫",
    file: GROUPJS,
    find: GUARD,
    replace: "",
    runner: "playwright",
    test: E2E_SETTINGS,
    expectedRed: true,
  },
  {
    name: "M12 保存永远走种子（资产槽成死字段）",
    file: GROUPJS,
    find: "body: assetId ? { avatar_asset_id: assetId } : { avatar_seed: seed },",
    replace: "body: { avatar_seed: seed },",
    runner: "playwright",
    test: E2E_SETTINGS,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只加一行无关注释",
    file: GROUPJS,
    find: "async function uploadAssetBase64(file, purpose) {",
    replace:
      "// 控制组：这一行什么都不改" + NL + "async function uploadAssetBase64(file, purpose) {",
    runner: "playwright",
    test: E2E_HIRE,
    expectedRed: false,
  },
];

function strip(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/gu, "");
}

function runVitest(
  target: string,
): { red: boolean; summary: string; fails: string[] } {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", target, "--reporter=dot"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 420_000 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    code = typeof err.status === "number" ? err.status : 1;
  }
  const clean = strip(out);
  const m = /Tests\s+(.{0,80}?)\n/u.exec(clean);
  if (m === null) {
    throw new Error(
      "读数不可读（没拿到 vitest 摘要行），中止：\n" + clean.slice(-3000),
    );
  }
  const fails = [...clean.matchAll(/FAIL\s+\S+\s+>\s+(.+)/gu)].map((x) =>
    (x[1] as string).trim(),
  );
  return {
    red: code !== 0,
    summary: m[1] as string,
    fails: [...new Set(fails)],
  };
}

function runPlaywright(
  title: string,
): { red: boolean; summary: string; fails: string[] } {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      [
        "node_modules/playwright/cli.js",
        "test",
        "test/e2e/group-workbench.spec.ts",
        "--timeout=25000",
        "-g",
        title,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 420_000 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    code = typeof err.status === "number" ? err.status : 1;
  }
  const clean = strip(out);
  const m =
    /\n\s*(\d+ (?:passed|failed|flaky|interrupted)[^\n]*)/u.exec(clean) ??
    /(\d+ (?:passed|failed)[^\n]*)/u.exec(clean);
  if (m === null) {
    throw new Error(
      "读数不可读（没拿到 playwright 摘要行），中止：\n" + clean.slice(-3000),
    );
  }
  const fails = [...clean.matchAll(/✘?\s*\d+\s*›\s+(.+)/gu)].map((x) =>
    (x[1] as string).trim(),
  );
  return { red: code !== 0, summary: m[1] as string, fails: [...new Set(fails)] };
}

function runTarget(m: Mutation): {
  red: boolean;
  summary: string;
  fails: string[];
} {
  return m.runner === "vitest" ? runVitest(m.test) : runPlaywright(m.test);
}

const originals = new Map<string, string>();
let failed = 0;
try {
  for (const m of MUTS) originals.set(m.file, readFileSync(m.file, "utf8"));
  // 锚点唯一性预检：0 次 = 变异没发生，多次 = 替换落点不明，都在跑之前抛。
  for (const m of MUTS) {
    const text = originals.get(m.file) as string;
    let count = 0;
    let idx = 0;
    while ((idx = text.indexOf(m.find, idx)) !== -1) {
      count += 1;
      idx += 1;
    }
    if (count !== 1) {
      throw new Error(
        m.name + "：锚点出现 " + count + " 次（必须恰好 1 次）：" + m.file,
      );
    }
  }
  console.log("── 预检（未变异必须绿）──");
  for (const m of MUTS) {
    if (m.expectedRed) continue;
    const r = runTarget(m);
    console.log(
      (r.red ? "× 预检就红 " : "✓ ") + m.test + " :: " + r.summary,
    );
    if (r.red) throw new Error("预检未变异已红，判据无从归因：" + m.test);
  }
  const redTargets = new Set<Mutation["test"]>();
  for (const m of MUTS) {
    if (!m.expectedRed) continue;
    if (redTargets.has(m.test)) continue;
    redTargets.add(m.test);
    const r = runTarget(m);
    console.log(
      (r.red ? "× 预检就红 " : "✓ ") + m.test + " :: " + r.summary,
    );
    if (r.red) {
      throw new Error(
        "预检未变异已红，判据无从归因：" + m.test + " :: " + r.fails.join(" / "),
      );
    }
  }
  for (const m of MUTS) {
    const original = originals.get(m.file) as string;
    writeFileSync(m.file, original.replace(m.find, m.replace), "utf8");
    const mutated = readFileSync(m.file, "utf8");
    if (mutated === original) {
      throw new Error(m.name + "：字节一个字没变 = 假变异");
    }
    let r: { red: boolean; summary: string; fails: string[] };
    try {
      r = runTarget(m);
    } finally {
      // 每发【各自】还原：只在收尾还原的话，下一发跑的是上一发的残留变异。
      writeFileSync(m.file, original, "utf8");
      if (sha(readFileSync(m.file, "utf8")) !== sha(original)) {
        throw new Error(m.name + "：单发还原后 sha256 不符：" + m.file);
      }
    }
    const caught = r.red === m.expectedRed;
    if (!caught) failed += 1;
    console.log(
      (caught ? "✓ " : "× ") +
        m.name +
        " :: 期望" +
        (m.expectedRed ? "红" : "绿") +
        " 实得" +
        (r.red ? "红" : "绿") +
        " :: " +
        r.summary +
        (r.fails.length > 0 ? " :: 红的是 " + r.fails.slice(0, 3).join(" / ") : ""),
    );
  }
} finally {
  for (const [file, text] of originals) {
    writeFileSync(file, text, "utf8");
    const back = readFileSync(file, "utf8");
    if (sha(back) !== sha(text)) {
      throw new Error("还原后 sha256 不符：" + file);
    }
  }
  console.log("── 还原：全部逐字节一致（sha256 核对过）──");
}
console.log(
  failed === 0
    ? "变异机结论：全部符合预期"
    : "变异机结论：" + failed + " 发不符",
);
process.exitCode = failed === 0 ? 0 : 1;
