/**
 * round390 变异机：证明「模板生产（POST /templates 的界面生产者）」这一族的断言真承重。
 *
 * 每发变异真抹源文件里的字节，跑对应测试范围（vitest 或 playwright），要求：
 * ① 读数可读（vitest 的 Tests 摘要行 / playwright 的 passed|failed 行）
 * ② 该红的红、控制组仍绿。任何一发在【字节没变】的情况下被标成 expectedRed
 * ⇒ 直接抛。每发【各自】在 finally 里逐字节还原并核对 sha256。
 * 锚点必须恰好出现一次：0 次 = 变异没发生，多次 = 替换落点不明，都抛。
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
  /** 期望红？true = 必须抓到；false = 控制组，必须仍绿。 */
  readonly expectedRed: boolean;
}

const GROUPJS = "packages/web/public/group.js";
const DSVC = "packages/hub/src/documents/service.ts";
const DTEST = "packages/hub/test/documents/service.test.ts";
const E2E = "模板生产";

const NL = "\n";
const BODY =
  '          name: data.get("name"),' +
  NL +
  '          kind: data.get("kind"),' +
  NL +
  '          body_text: data.get("body_text"),';

const MUTS: Mutation[] = [
  {
    name: "M1 摘掉「新建模板」按钮（生产者又只剩 GET 那一半）",
    file: GROUPJS,
    find: '          button("新建模板", () => templateCreateModal(), "small"),',
    replace: "",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M2 提交体丢掉 body_text（建出来的模板永远空白）",
    file: GROUPJS,
    find: BODY,
    replace:
      '          name: data.get("name"),' + NL + '          kind: data.get("kind"),',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M3 kind 写死 markdown（形态下拉不再承重）",
    file: GROUPJS,
    find: BODY,
    replace:
      '          name: data.get("name"),' +
      NL +
      '          kind: "markdown",' +
      NL +
      '          body_text: data.get("body_text"),',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M4 建完不重取列表（新模板只活在 toast 里）",
    file: GROUPJS,
    find:
      "      await loadAuxiliary();" +
      NL +
      "      renderMain();" +
      NL +
      '      toast("模板已创建");',
    replace: '      toast("模板已创建");',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M5 请求方法写坏成 GET（打的是另一条路由）",
    file: GROUPJS,
    find:
      '      await request("/templates", {' + NL + '        method: "POST",',
    replace:
      '      await request("/templates", {' + NL + '        method: "GET",',
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M6 模板落库 builtin 写成 1（自建模板混进内置禁删档）",
    file: DSVC,
    find: '  " VALUES (?, ?, ?, ?, 0)";',
    replace: '  " VALUES (?, ?, ?, ?, 1)";',
    runner: "vitest",
    test: DTEST,
    expectedRed: true,
  },
  {
    name: "M7 建文档时不再展开模板正文（模板库读得出、用不上）",
    file: DSVC,
    find: "      body = templateView(templateRow).body_text;",
    replace: "      // 变异：故意不展开模板正文",
    runner: "vitest",
    test: DTEST,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只在模板弹窗上头加一行无关注释",
    file: GROUPJS,
    find: "function templateCreateModal() {",
    replace:
      "// 控制组：这一行什么都不改" + NL + "function templateCreateModal() {",
    runner: "playwright",
    test: E2E,
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
    throw new Error("读数不可读（没拿到 vitest 摘要行），中止：\n" + clean.slice(-2000));
  }
  const fails = [...clean.matchAll(/FAIL\s+\S+\s+>\s+(.+)/gu)].map((x) =>
    (x[1] as string).trim(),
  );
  return { red: code !== 0, summary: m[1] as string, fails: [...new Set(fails)] };
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
  const m =
    /\n\s*(\d+)\s+(?:passed|failed)[^\n]*\n?/u.exec(clean) ??
    /(passed|failed)[^\n]*/u.exec(clean);
  const summaryLine =
    [...clean.matchAll(/^[^\n]*\d+\s+(?:passed|failed|did not run)[^\n]*$/gmu)].pop() ??
    null;
  if (summaryLine === null && m === null) {
    throw new Error("读数不可读（没拿到 playwright 摘要行），中止：\n" + clean.slice(-2000));
  }
  const fails = [...clean.matchAll(/^\s*(?:\d+\s+)>?\s*[^\n]*›\s*([^\n]+)$/gmu)].map(
    (x) => (x[1] as string).trim(),
  );
  return {
    red: code !== 0,
    summary: (summaryLine?.[0] ?? (m?.[0] as string)).trim(),
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
    [{ runner: "vitest", test: DTEST } as Mutation, "vitest " + DTEST],
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
    if (mutated === original) throw new Error(m.name + "：字节一个字没变 = 假变异");
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
console.log(
  failed === 0 ? "变异机结论：全部符合预期" : "变异机结论：" + failed + " 发不符",
);
process.exitCode = failed === 0 ? 0 : 1;
