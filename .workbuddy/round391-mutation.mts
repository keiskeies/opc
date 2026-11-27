/**
 * round391 变异机：证明「全局搜索群命中的徽标与落点（0076）」这一族的断言真承重。
 *
 * 形状沿用 round390：锚点必须恰好出现一次；未变异各侧先绿；每发自己 finally 还原
 * 并核 sha256；读数不可读即中止；字节没变却被标成 expectedRed ⇒ 直接抛。
 *
 * ⚠ 每发只抹【一根线】，且判据与这根线有因果：
 *   M1/M9 抹标签行 ⇒ 徽标（e2e）与奇偶守卫各自红；
 *   M2/M10 抹分支 ⇒ 落点（e2e）与奇偶守卫各自红；
 *   M3 换成旧写法（丢 id）⇒ 落点红；M4 面这一维写死 ⇒ 挑行红；
 *   M5 服务端群面 OR→AND ⇒ 服务端七面 Set 断言红。
 * 早先我还排过「把判据改宽」那三发（M6–M8），已删：判据改宽在未变异源码上必然仍绿，
 * 而叠上真缺口时它红的是【守卫自己的锚点自检】不是那条被改宽的断言 —— 红错原因的
 * 变异比没有变异更贵（它会让下一个人以为那条线有人守）。守卫自己的判别力由
 * search-face-parity.test.ts 最后一发的正负两组自证，不靠这里叠发。
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
  /** vitest：测试文件；playwright：-g 标题片段。 */
  readonly test: string;
  readonly expectedRed: boolean;
}

const GROUPJS = "packages/web/public/group.js";
const HUB_SEARCH = "packages/hub/src/search/service.ts";
const HUB_SEARCH_TEST = "packages/hub/test/search/service.test.ts";
const PARITY = "test/web/search-face-parity.test.ts";
const E2E = "全局搜索群命中";

const NL = "\n";
/** openSearchHit 里 group 那一整条分支（逐字节抄自源文件）。 */
const GROUP_BRANCH =
  '    if (hit.face === "group") {' +
  NL +
  "      // 落点沿用侧栏点群的同一个函数：它自己会找群会话并进去，没有会话才落到群详情。" +
  NL +
  "      // 少这一支时点群命中是【静默什么都不发生】—— 下拉关掉了，屏幕还停在原地。" +
  NL +
  "      await selectGroup(hit.id);" +
  NL +
  "    }";
/** 标签名单头两行（group 是七面里的第一个键）。 */
const LABEL_HEAD = `const faceLabels = {${NL}  group: "群",`;

const MUTS: Mutation[] = [
  {
    name: "M1 摘掉 faceLabels 的 group 键 ⇒ 徽标回到空白",
    file: GROUPJS,
    find: LABEL_HEAD,
    replace: "const faceLabels = {",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M2 摘掉 openSearchHit 的 group 分支 ⇒ 点群命中静默无动作",
    file: GROUPJS,
    find: GROUP_BRANCH + NL,
    replace: "",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M3 group 分支退回丢掉 id 的旧写法（跳首页）",
    file: GROUPJS,
    find: "      await selectGroup(hit.id);",
    replace: '      location.href = "/";',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M4 行的 data-face 写死成 document（面这一维不参与挑行）",
    file: GROUPJS,
    find: '              "data-face": hit.face,',
    replace: '              "data-face": "document",',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M9 摘掉 group 标签键 ⇒ 奇偶守卫报缺口",
    file: GROUPJS,
    find: LABEL_HEAD,
    replace: "const faceLabels = {",
    runner: "vitest",
    test: PARITY,
    expectedRed: true,
  },
  {
    name: "M10 摘掉 group 分支 ⇒ 奇偶守卫报缺口",
    file: GROUPJS,
    find: GROUP_BRANCH + NL,
    replace: "",
    runner: "vitest",
    test: PARITY,
    expectedRed: true,
  },
  {
    name: "M11 面名单加一面却不动渲染侧 ⇒ 奇偶守卫必须红（新面不会静默漏格）",
    file: "packages/contracts/src/search.ts",
    find: '  "backlog",',
    replace: '  "backlog",' + NL + '  "approval",',
    runner: "vitest",
    test: PARITY,
    expectedRed: true,
  },
  {
    name: "M5 服务端群面 OR 写成 AND ⇒ 服务端七面断言红",
    file: HUB_SEARCH,
    find: String.raw`  " WHERE title LIKE ? ESCAPE '\\' OR goal LIKE ? ESCAPE '\\'" +`,
    replace: String.raw`  " WHERE title LIKE ? ESCAPE '\\' AND goal LIKE ? ESCAPE '\\'" +`,
    runner: "vitest",
    test: HUB_SEARCH_TEST,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只在 openSearchHit 上头加一行无关注释",
    file: GROUPJS,
    find: "async function openSearchHit(hit) {",
    replace:
      "// 控制组：这一行什么都不改" + NL + "async function openSearchHit(hit) {",
    runner: "playwright",
    test: E2E,
    expectedRed: false,
  },
  {
    name: "C2 控制组：只在守卫的说明注释里加一行",
    file: PARITY,
    find: 'describe("搜索的七面在渲染侧各有一格", () => {',
    replace:
      "// 控制组：这一行什么都不改" +
      NL +
      'describe("搜索的七面在渲染侧各有一格", () => {',
    runner: "vitest",
    test: PARITY,
    expectedRed: false,
  },
];

function strip(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/gu, "");
}

interface Reading {
  readonly red: boolean;
  readonly summary: string;
  readonly fails: string[];
}

function runVitest(target: string): Reading {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", target, "--reporter=dot"],
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
    throw new Error(
      "读数不可读（没拿到 vitest 摘要行），中止：\n" + clean.slice(-2000),
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

function runPlaywright(title: string): Reading {
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
    );
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    out = (err.stdout ?? "") + (err.stderr ?? "");
    code = typeof err.status === "number" ? err.status : 1;
  }
  const clean = strip(out);
  const summaryLine =
    [...clean.matchAll(/^[^\n]*\d+\s+(?:passed|failed|did not run)[^\n]*$/gmu)]
      .pop() ?? null;
  if (summaryLine === null) {
    throw new Error(
      "读数不可读（没拿到 playwright 摘要行），中止：\n" + clean.slice(-2000),
    );
  }
  const fails = [
    ...clean.matchAll(/^\s*(?:\d+\s+)>?\s*[^\n]*›\s*([^\n]+)$/gmu),
  ].map((x) => (x[1] as string).trim());
  return {
    red: code !== 0,
    summary: summaryLine[0].trim(),
    fails: [...new Set(fails)],
  };
}

function run(m: Mutation): Reading {
  return m.runner === "vitest" ? runVitest(m.test) : runPlaywright(m.test);
}

const originals = new Map<string, string>();
let failed = 0;
try {
  for (const m of MUTS) originals.set(m.file, readFileSync(m.file, "utf8"));
  // 锚点唯一性预检：在任何字节被动之前先全部核一遍。
  for (const m of MUTS) {
    const text = originals.get(m.file) as string;
    const hits = text.split(m.find).length - 1;
    if (hits !== 1) {
      throw new Error(m.name + "：锚点出现 " + hits + " 次（要求恰好 1 次）");
    }
  }
  console.log("── 预检（未变异必须绿）──");
  const preflight: ReadonlyArray<readonly [Mutation, string]> = [
    [{ runner: "playwright", test: E2E } as Mutation, "playwright " + E2E],
    [
      { runner: "vitest", test: HUB_SEARCH_TEST } as Mutation,
      "vitest " + HUB_SEARCH_TEST,
    ],
    [{ runner: "vitest", test: PARITY } as Mutation, "vitest " + PARITY],
  ];
  for (const [m, label] of preflight) {
    const r = run(m);
    console.log((r.red ? "× 预检就红 " : "✓ ") + label + " :: " + r.summary);
    if (r.red) throw new Error("预检未变异已红，判据无从归因：" + label);
  }
  for (const m of MUTS) {
    const original = originals.get(m.file) as string;
    writeFileSync(m.file, original.replace(m.find, m.replace), "utf8");
    const mutated = readFileSync(m.file, "utf8");
    if (mutated === original)
      throw new Error(m.name + "：字节一个字没变 = 假变异");
    let r: Reading;
    try {
      r = run(m);
    } finally {
      // 每发【各自】还原：只在收尾还原的话，上一发残留的变异会被下一发归因到自己身上。
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
        (r.fails.length > 0
          ? " :: 红的是 " + r.fails.slice(0, 3).join(" / ")
          : ""),
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
console.log(
  failed === 0
    ? "变异机结论：全部符合预期"
    : "变异机结论：" + failed + " 发不符",
);
process.exitCode = failed === 0 ? 0 : 1;
