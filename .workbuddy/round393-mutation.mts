/**
 * round393 变异机：证明「背景重读不再把视口跳回底部（0078）」这一族的断言真承重。
 *
 * 形状沿用 round392：锚点必须恰好出现一次；未变异各侧先绿；每发自己 finally 还原
 * 并核 sha256；读数不可读即中止；字节没变却被标成 expectedRed ⇒ 直接抛。
 *
 * ⚠ 每发只抹【一根线】，且判据与这根线有因果：
 *   E1 抹掉背景重读读锚点 ⇒ 每次重读跳回底部（守卫同时报「不分会话就取锚点」）；
 *   E2 抹掉整格重画读锚点 ⇒ 点「回复」把视口送回顶部；
 *   E3 pinned 恒 false ⇒ 贴着底部的人不再跟着新消息走（只有【来新消息】那一发抓得到：
 *      内容没变时 anchor.top == 最大滚动量，写在原地就等于贴底，别的那几发全绿）；
 *   E4 pinned 恒 true ⇒ 翻上去读旧史的人被拽回底部；
 *   E5 去掉未贴底那一支的上界夹持 ⇒ 超界读数（只有守卫的单位执行抓得到，e2e 无这一形状）；
 *   E6 去掉骨架帧那一格 ⇒ 在骨架上量出「贴底」（同上，守卫先红）；
 *   E7 容差归零 ⇒ 整数取底下贴底判定漂掉（同上，守卫先红）；
 *   E8 抹掉往旧翻的视口恢复 ⇒ 点「更早」屏幕跳到流头（0077 那发的第 3.5 根线）；
 *   E9 两把尺子「统一」成留住 scrollTop ⇒ 同一处红（prepend 往上方加内容，scrollTop
 *      不是同一屏像素）；
 *   E10 抹掉发送那一发的无条件跳底 ⇒ 用户自己发的消息看不见（发送前先退回半途，
 *      否则两对锚点都会把他送到底，那一行就成了不承重的装饰）；
 *   E11 背景重读退回「有流就跳底」⇒ e2e 第一根线红 + 守卫点名第三处跳底；
 *   E12 抹掉整格重画的恢复 ⇒ 点「回复」红 + 守卫报窗口归属门缺失；
 *   E13 把整格重画的锚点读到 replaceChildren 之后 ⇒ 摘下来的节点量不到几何（实测
 *      scrollHeight/clientHeight 一律 0，见 0078 §4），写回 0 ⇒ 线3 红 + 守卫报时机。
 * 不放「把判据改宽」那类发（同 round391/392 的教训：红错原因的变异比没有变异更贵）。
 * 守卫自身的判别力在 test/web/chat-scroll-anchor.test.ts 最后一发里正负两组自证。
 *
 * ⚠ E3/E10 是本轮实跑真撞出来的两条【测试形状】缺陷，不是补写的装饰：
 *   第一版的「贴底跟随」只做了「滚到底 → 刷新 → 仍贴底」，E3 直接存活（内容没变时
 *   anchor.top 就是最大滚动量）；第一版的发送判据在【已贴底】的视口上跑，E10 直接
 *   存活（renderMain/loadMessages 两对锚点都会把贴底的人送到底）。⇒ 各补一次自己的
 *   动作（贴着底部时来新消息 / 从半途发送）后，两发都红在该管的那条线上。
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
const GUARD = "test/web/chat-scroll-anchor.test.ts";
const GUARD0077 = "test/web/history-cursor-producer.test.ts";
const SCROLL = "会话滚动位置";
const PAGING = "会话历史翻页";

const NL = "\n";
/** 背景重读（loadMessages）读锚点那一格。 */
const LOAD_INIT =
  "  const scrollAnchor =" +
  NL +
  "    state.messagesWindowId === id" +
  NL +
  "      ? chatScrollAnchor($(\".message-stream\"))" +
  NL +
  "      : null;";
/** 背景重读用锚点那一格。 */
const LOAD_USE =
  "        if (scrollAnchor === null) stream.scrollTop = stream.scrollHeight;" +
  NL +
  "        else applyChatScrollAnchor(stream, scrollAnchor);";
/** 整格重画（renderMain）读锚点那一格（含紧随其后的拆）。 */
const MAIN_CAPTURE =
  "  const chatAnchor = chatScrollAnchor($(\".message-stream\"));" +
  NL +
  "  view.replaceChildren();";
/** 整格重画的恢复那一格。 */
const MAIN_RESTORE =
  "  if (state.messagesWindowId === state.selectedConversation)" +
  NL +
  "    applyChatScrollAnchor($(\".message-stream\", view), chatAnchor);";
/** chatScrollAnchor 的产出那一格。 */
const ANCHOR_RETURN = "  return { pinned, top: stream.scrollTop };";
/** 未贴底那一支的上界夹持。 */
const CLAMP =
  "    : Math.max(" +
  NL +
  "        0," +
  NL +
  "        Math.min(anchor.top, stream.scrollHeight - stream.clientHeight)," +
  NL +
  "      );";
/** 骨架帧那一格。 */
const SKELETON =
  "  if (!stream || stream.querySelectorAll(\".message-row\").length === 0)" +
  NL +
  "    return null;";
/** 往旧翻的锚点读数（距底）。 */
const OLDER_OFFSET =
  "  const anchorOffset = streamBefore" +
  NL +
  "    ? streamBefore.scrollHeight - streamBefore.scrollTop" +
  NL +
  "    : 0;";
/** 往旧翻的视口恢复那一行。 */
const OLDER_RESTORE =
  "      if (stream) stream.scrollTop = stream.scrollHeight - anchorOffset;";
/** 发送那一发的无条件跳底（含上一行取流）。 */
const SEND_JUMP =
  "    const stream = $(\".message-stream\");" +
  NL +
  "    if (stream) stream.scrollTop = stream.scrollHeight;";

const MUTS: Mutation[] = [
  {
    name: "E1 背景重读不读锚点 ⇒ 每次重读跳回底部",
    file: GROUPJS,
    find: LOAD_INIT,
    replace: "  const scrollAnchor = null;",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E1b 同上 ⇒ 守卫报「读锚点没过窗口归属门」",
    file: GROUPJS,
    find: LOAD_INIT,
    replace: "  const scrollAnchor = null;",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E2 整格重画不读锚点 ⇒ 点「回复」视口送回顶部",
    file: GROUPJS,
    find: MAIN_CAPTURE,
    replace: "  const chatAnchor = null;" + NL + "  view.replaceChildren();",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E3 pinned 恒 false ⇒ 贴着底部的人不再跟着新消息走",
    file: GROUPJS,
    find: ANCHOR_RETURN,
    replace: "  return { pinned: false, top: stream.scrollTop };",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E3b pinned 恒 false ⇒ 守卫的贴底判定红",
    file: GROUPJS,
    find: ANCHOR_RETURN,
    replace: "  return { pinned: false, top: stream.scrollTop };",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E4 pinned 恒 true ⇒ 翻上去读旧史的人被拽回底部",
    file: GROUPJS,
    find: ANCHOR_RETURN,
    replace: "  return { pinned: true, top: stream.scrollTop };",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E5 去掉上界夹持 ⇒ 守卫的单位执行读出超界值",
    file: GROUPJS,
    find: CLAMP,
    replace: "    : anchor.top;",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E6 去掉骨架帧那一格 ⇒ 守卫在骨架上量出假「贴底」",
    file: GROUPJS,
    find: SKELETON,
    replace: "  if (!stream) return null;",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E7 贴底容差归零 ⇒ 守卫的整数取底下贴底判定漂掉",
    file: GROUPJS,
    find: "const CHAT_BOTTOM_STICK_PX = 80;",
    replace: "const CHAT_BOTTOM_STICK_PX = 0;",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E8 抹掉往旧翻的视口恢复 ⇒ 点「更早」屏幕跳到流头",
    file: GROUPJS,
    find: OLDER_RESTORE,
    replace: "",
    runner: "playwright",
    test: PAGING,
    expectedRed: true,
  },
  {
    name: "E9 往旧翻改用 scrollTop（两把尺子被「统一」）⇒ 同样跳到流头",
    file: GROUPJS,
    find: OLDER_OFFSET,
    replace:
      "  const anchorOffset = streamBefore ? streamBefore.scrollTop : 0;",
    runner: "playwright",
    test: PAGING,
    expectedRed: true,
  },
  {
    name: "E10 抹掉发送那一发的跳底 ⇒ 从半途发消息后停在半途",
    file: GROUPJS,
    find: SEND_JUMP,
    replace: "",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E10b 同上 ⇒ 守卫的跳底归属名单少一个人",
    file: GROUPJS,
    find: SEND_JUMP,
    replace: "",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E11 背景重读退回「有流就跳底」⇒ e2e 第一根线红",
    file: GROUPJS,
    find: LOAD_USE,
    replace: "        stream.scrollTop = stream.scrollHeight;",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E11b 同上 ⇒ 守卫点名这一发不再挂在「没有锚点」上",
    file: GROUPJS,
    find: LOAD_USE,
    replace: "        stream.scrollTop = stream.scrollHeight;",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E12 抹掉整格重画的恢复 ⇒ 点「回复」红 + 守卫报窗口归属门缺失",
    file: GROUPJS,
    find: MAIN_RESTORE,
    replace: "",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E12b 同上 ⇒ 守卫报窗口归属门缺失",
    file: GROUPJS,
    find: MAIN_RESTORE,
    replace: "",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "E13 整格重画的锚点读到拆之后（摘下来的节点量不到几何）⇒ 线3 红",
    file: GROUPJS,
    find: MAIN_CAPTURE,
    replace:
      "  view.replaceChildren();" +
      NL +
      "  const chatAnchor = chatScrollAnchor($(\".message-stream\"));",
    runner: "playwright",
    test: SCROLL,
    expectedRed: true,
  },
  {
    name: "E13b 同上 ⇒ 守卫报「读锚点必须早于拆」",
    file: GROUPJS,
    find: MAIN_CAPTURE,
    replace:
      "  view.replaceChildren();" +
      NL +
      "  const chatAnchor = chatScrollAnchor($(\".message-stream\"));",
    runner: "vitest",
    test: GUARD,
    expectedRed: true,
  },
  {
    name: "C1 控制组：只在 renderMain 上方加一行无关注释",
    file: GROUPJS,
    find: "function renderMain() {",
    replace: "// 控制组：这一行什么都不改" + NL + "function renderMain() {",
    runner: "playwright",
    test: SCROLL,
    expectedRed: false,
  },
  {
    name: "C2 控制组：只在守卫的说明注释里加一行",
    file: GUARD,
    find: 'describe("消息流滚动锚点：谁许跳底、什么时候读锚点", () => {',
    replace:
      "// 控制组：这一行什么都不改" +
      NL +
      'describe("消息流滚动锚点：谁许跳底、什么时候读锚点", () => {',
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

function exec(args: string[]): { out: string; code: number } {
  try {
    return {
      out: execFileSync(process.execPath, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 300_000,
      }),
      code: 0,
    };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return {
      out: (err.stdout ?? "") + (err.stderr ?? ""),
      code: typeof err.status === "number" ? err.status : 1,
    };
  }
}

function runVitest(target: string): Reading {
  const { out, code } = exec([
    "node_modules/vitest/vitest.mjs",
    "run",
    target,
    "--reporter=dot",
  ]);
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
  const { out, code } = exec([
    "node_modules/playwright/cli.js",
    "test",
    "test/e2e/group-workbench.spec.ts",
    "--timeout=25000",
    "-g",
    title,
  ]);
  const clean = strip(out);
  // 每发的完整读数留在固定的一个文件里（覆盖式）：预检报红时先读它，别凭猜。
  writeFileSync(".workbuddy/round393-mut-last-playwright.log", clean, "utf8");
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
    [{ runner: "playwright", test: SCROLL } as Mutation, "playwright " + SCROLL],
    [{ runner: "playwright", test: PAGING } as Mutation, "playwright " + PAGING],
    [{ runner: "vitest", test: GUARD } as Mutation, "vitest " + GUARD],
    [
      { runner: "vitest", test: GUARD0077 } as Mutation,
      "vitest " + GUARD0077,
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
