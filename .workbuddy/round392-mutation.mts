/**
 * round392 变异机：证明「会话历史 before_seq 翻页（0077）」这一族的断言真承重。
 *
 * 形状沿用 round391：锚点必须恰好出现一次；未变异各侧先绿；每发自己 finally 还原
 * 并核 sha256；读数不可读即中止；字节没变却被标成 expectedRed ⇒ 直接抛。
 *
 * ⚠ 每发只抹【一根线】，且判据与这根线有因果：
 *   M1 抹掉游标参数 ⇒ e2e 等不到带 before_seq 的那一发（谓词要求它存在）；
 *   M2 游标写成字面量 ⇒ 发出去的 URL 不是 "2"（守卫那条「必须插值」也归它管，见 M6b）；
 *   M3 判据丢掉「满一整页」⇒ 翻到底按钮不收起；
 *   M4 首屏不重算游标 ⇒ 按钮压根不出现；
 *   M5 prepend 改 append ⇒ 首行的 data-seq 与文案错；
 *   M6/M6b/M7 同一批抹线交给守卫（源扫描）自己 ⇒ 守卫必须报缺口；
 *   M8 服务端严格小于写成 <= ⇒ 服务端游标断言 [2,3] 红；
 *   M9 背景重读不再保留已翻出的那段 ⇒ e2e 第五根线红（史前消息被吞 + 按钮复活）；
 *   M10 窗口归属恒真 ⇒ 守卫报「不分会话就保留」（换会话会把上一群的「到底」结论带过去）；
 *   M11 保留段存在时仍按最新页长重算 hasMore ⇒ e2e 第五根线红（到底的按钮复活）；
 *   M12 游标取自新来的那一页而不是合并后的窗口 ⇒ 守卫报缺口（游标退回 = 同一段再要一遍）。
 * 不放「把判据改宽」那类发（同 round391 的教训：它红的是守卫自己的锚点自检，
 * 红错原因的变异比没有变异更贵）。守卫自身的判别力在
 * test/web/history-cursor-producer.test.ts 最后一发里正负两组自证。
 *
 * ⚠ M9/M11 就是【本轮实跑真撞到的那个缺陷】：首版 applyHistoryWindow 无条件整体覆盖，
 *   变异机预检（未变异必须绿）连红两轮，红的正是这一发该抓的东西 —— 判据（第五根线）
 *   因此是缺陷的复现，不是补写的装饰。
 *
 * ⚠ 第二轮机器上 M3/M5/M11 报绿（同一发源码手跑必红）—— 根因不在判据太松，在【读错了帧】：
 *   loadMessages 成功路径先置 messageLoading=true 再重画，那一帧 0 行、也没有 #load-older，
 *   于是 locator 轮询式的【缺席判据】会被骨架帧凭空喂饱（绿的是「正在加载」）。
 *   e2e 因此改成读同一帧的原子快照 settledChatFrame（骨架帧一律不算数），
 *   第五根线另加帧号：正确代码下重读前后屏幕【逐像素相同】，只能靠「读到的是新帧」
 *   自证这一发量的是重读之后。⇒ 复跑必须让这三发各自红在该管的字段上。
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
const GUARD = "test/web/history-cursor-producer.test.ts";
const HUB_CONV = "packages/hub/test/conversations/service.test.ts";
const HUB_CONV_SRC = "packages/hub/src/conversations/service.ts";
const E2E = "会话历史翻页";

const NL = "\n";
/** 翻页那一发的查询串（两段模板里的第二段）。 */
const PAGED_QUERY = "`?limit=${MESSAGES_PAGE_LIMIT}&before_seq=${before}`";
/** applyHistoryWindow 里重算游标那一行。 */
const CURSOR_LINE = "  state.messagesCursor = historyCursor(list);" + NL;
/** 首屏那一发的调用点（带上一行注释才唯一 —— 这行调用本身有两处）。 */
const FIRST_PAGE_SITE =
  "    // 首屏 = 最新的一页；窗口里比它更旧的那段由 applyHistoryWindow 保留（见那里）。" +
  NL +
  "    applyHistoryWindow(id, result.messages || []);";
/** 保留段那一格（含窗口归属判断）。 */
const RETAINED_INIT =
  "  const retained =" +
  NL +
  "    state.messagesWindowId === id ? retainOlderThan(state.messages, page) : [];";
/** 「还有更早」那一格（翻过页时维持原值）。 */
const HAS_MORE_BLOCK =
  "  state.messagesHasMore =" +
  NL +
  "    retained.length > 0" +
  NL +
  "      ? state.messagesHasMore" +
  NL +
  "      : historyHasMore(page.length, MESSAGES_PAGE_LIMIT);";

const MUTS: Mutation[] = [
  {
    name: "M1 抹掉翻页 URL 里的游标 ⇒ e2e 等不到带 before_seq 的一发",
    file: GROUPJS,
    find: PAGED_QUERY,
    replace: "`?limit=${MESSAGES_PAGE_LIMIT}`",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M2 游标写成字面量 1 ⇒ 发出去的不是最旧那条的 seq",
    file: GROUPJS,
    find: "&before_seq=${before}",
    replace: "&before_seq=1",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M3 判据丢掉「满一整页」⇒ 到底后按钮不收起",
    file: GROUPJS,
    find: "    pageLen > 0 &&" + NL + "    pageLen >= limit" + NL,
    replace: "    pageLen > 0" + NL,
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M4 首屏不重算游标 ⇒ 按钮压根不出现",
    file: GROUPJS,
    find: CURSOR_LINE,
    replace: "",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M5 prepend 改成 append ⇒ 首行不是更早那段",
    file: GROUPJS,
    find: "    state.messages = fresh.concat(state.messages);",
    replace: "    state.messages = state.messages.concat(fresh);",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M6 抹掉游标参数 ⇒ 守卫必须报「契约参数零生产者」",
    file: GROUPJS,
    find: PAGED_QUERY,
    replace: "`?limit=${MESSAGES_PAGE_LIMIT}`",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "M6b 游标写成字面量 ⇒ 守卫必须报「读的不是游标本身」",
    file: GROUPJS,
    find: "&before_seq=${before}",
    replace: "&before_seq=1",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "M7 首屏退回直接赋值（绕开重算入口）⇒ 守卫必须点名第三处覆盖",
    file: GROUPJS,
    find: FIRST_PAGE_SITE,
    replace:
      "    // 首屏 = 最新的一页；窗口里比它更旧的那段由 applyHistoryWindow 保留（见那里）。" +
      NL +
      "    state.messages = result.messages || [];",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "M9 背景重读不保留已翻出的那段 ⇒ e2e 第五根线红（史前消息被吞 + 按钮复活）",
    file: GROUPJS,
    find: RETAINED_INIT,
    replace: "  const retained = [];",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M10 窗口归属恒真 ⇒ 守卫报「不分会话就保留」",
    file: GROUPJS,
    find: RETAINED_INIT,
    replace:
      "  const retained = retainOlderThan(state.messages, page);",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "M11 翻过页仍按最新页长重算 hasMore ⇒ e2e 第五根线红（到底的按钮复活）",
    file: GROUPJS,
    find: HAS_MORE_BLOCK,
    replace:
      "  state.messagesHasMore = historyHasMore(page.length, MESSAGES_PAGE_LIMIT);",
    runner: "playwright",
    test: E2E,
    expectedRed: true,
  },
  {
    name: "M12 游标取自新来的那一页 ⇒ 守卫报缺口（同一段会被再要一遍）",
    file: GROUPJS,
    find: CURSOR_LINE,
    replace: "  state.messagesCursor = historyCursor(page);" + NL,
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "M8 服务端游标严格小于写成 <= ⇒ 服务端游标断言红",
    file: HUB_CONV_SRC,
    find: "seq_in_conv < ?)",
    replace: "seq_in_conv <= ?)",
    runner: "vitest",
    test: HUB_CONV,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只在 loadOlderMessages 上头加一行无关注释",
    file: GROUPJS,
    find: "async function loadOlderMessages(id) {",
    replace:
      "// 控制组：这一行什么都不改" + NL + "async function loadOlderMessages(id) {",
    runner: "playwright",
    test: E2E,
    expectedRed: false,
  },
  {
    name: "C2 控制组：只在守卫的说明注释里加一行",
    file: GUARD,
    find: 'describe("会话历史的 before_seq 游标有生产者", () => {',
    replace:
      "// 控制组：这一行什么都不改" +
      NL +
      'describe("会话历史的 before_seq 游标有生产者", () => {',
    runner: "vitest",
    test: GUARD,
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
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 300_000 },
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
  // 每发的完整读数留在固定的一个文件里（覆盖式）：预检报红时先读它，别凭猜。
  writeFileSync(".workbuddy/round392-mut-last-playwright.log", clean, "utf8");
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
      { runner: "vitest", test: GUARD } as Mutation,
      "vitest " + GUARD,
    ],
    [
      { runner: "vitest", test: HUB_CONV } as Mutation,
      "vitest " + HUB_CONV,
    ],
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
