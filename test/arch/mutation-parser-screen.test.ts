/**
 * 变异机的「读 vitest 汇总」这一族，全场普查（round301）。
 *
 * ── 这一族守的是什么 ────────────────────────────────────────────
 * 一台变异机全部的结论，都来自它把 vitest 那屏输出读成了什么。所以它的可信度
 * 不在「矩阵命中 N/N」，而在【读数的形状对不对】—— 台账里那句话：
 * 「一个把红读成绿的解析器比没有解析器更坏」（round292 记的，此后五轮反复重登）。
 *
 * 本轮把它从「每台各自记得要写一段自证」升级成【全场普查】：把每一台自己的
 * readSummary 逐字节切出来，喂【真 vitest 屏】。
 *
 * ── 判的是三条【跨型不变量】，不是「都必须抛」──────────────────────
 *   甲 全绿屏          ⇒ 红味字段全 0（读成红 = 判据恒红，M0 永远红）
 *   乙 一发用例红      ⇒ 至少一个红味字段 > 0（读成绿 = 整张矩阵假绿）
 *   丙丁戊己 装载/采集失败屏 ⇒ 【不允许读成「和全绿一样」】：要么抛，要么它自己那格红味非 0
 *   （丙丁戊己 四型各钉【一格】，扩型理由与分工见 LOAD_FAIL_SCREENS 那段注释）
 *
 * ⚠ 本文件第一版把丙/丁写成「九台【一律】必须抛」，跑出来 6 发红。那不是机器的错，
 *   是我把【一型的补救办法】当成了【全场的判据】。实测（本轮，逐台切字节喂屏）：
 *   语料里其实有【两种架构】，对同一屏给出两种都成立的处置——
 *     · 计数型（round292 / 293 census / 293 gate-exemption / 294，共 4 台）：
 *       只数两行摘要、【没有】用例名归因 ⇒ 唯一的门是「抛」（Tests 行无数字 /
 *       文件级红而用例级 0 红）。
 *     · 并红型（round295 / 296 / 298 / 299 / 300，共 5 台）：把文件级红【并进】
 *       自己那句 `failed = failedTests + failedFiles` ⇒ 丙/丁读成红 ⇒ 它自己的
 *       M0 控制组（应绿）当场转红 ⇒ 整张矩阵 exit 1。round295 文件头记的就是这一格。
 *   ⇒ 共同不变量只能是「不许读成绿」，不能是「必须抛」。判据【泛化到哪一层】
 *     决定了它会不会把下一台的正当改法读成故障。
 *
 * ⚠ 为什么并红型那两格读的是【它自己那个字段】而不是「任一红味字段」：
 *   本轮实测，把 296 的 `failed: failedTests + failedFiles` 抹成 `failed: failedTests`
 *   之后，`failedFiles` 仍在返回对象里 ⇒ 「取所有红味字段的最大值」依旧 > 0 ⇒
 *   用并集口径【看不出这台坏了】。而它的判式只读 `got.failed`。
 *   ⇒ 「凡在探针里用『非 0』当存在性证据的判式，先问它读的是哪一个字段」——
 *     这条是本轮从【我自己的这个判式】上量出来的，不是从被审对象上。
 *
 * ⚠ 为什么判「抛」也算合格：装载失败时两种读数都不可信 —— 读成绿是「什么都没跑
 *   却说通过了」，读成红是「红话说的是假原因」。并红型读成红之所以可接受，是因为
 *   那一红落在【它自己的控制组】上（M0 应绿却红 ⇒ 人会去看现场），而不是落在
 *   「哪条判据不承重」这句话上。
 *
 * ⚠ 最后一发的变异打在【切片】上，不打生产字节：本文件是常跑守卫，而 .workbuddy
 *   那几台是【跑它时不许并发】的自回滚机器（台账纪律）。打切片同样是真抹字节，
 *   且抹的正是本文件要吃的那段代码 —— 本文件审的就是「切出来的 readSummary」，
 *   整台机器的版本由 round301-mutate-parser-guards.mjs 单独跑。
 */

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { repoRoot } from "./claims-registry.js";

const ESC = String.fromCharCode(27);

/** 真屏的颜色包装：把 `[[2m` 这种写法还原成真 ESC 字节。 */
const colorize = (s: string): string => s.split("[[").join(ESC + "[");

/** 剥 ANSI：与被审的那些机器同一判据（剥完还剩 ESC 就是色码写法没覆盖到）。 */
const plain = (s: string): string => {
  const c = s.replace(new RegExp(ESC + "\\[[0-9;]*m", "gu"), "");
  if (c.includes(ESC))
    throw new Error("夹具里的色码剥不干净 ⇒ 这份屏的字节是假的");
  return c;
};

/**
 * 四份屏。甲/乙/丙的字节是从【真跑抓的输出】里逐行抄的
 * （`.workbuddy/probe301-{green,red,loadfail}-raw.txt`，本轮生成，色码是真的），
 * 只是去掉了与读数无关的进度行 —— 每台机器的判式都只找 `Test Files` / `Tests` /
 * `FAIL` 这三类行，留着它们就够。丁那一型由【空测试文件】那一屏的形状派生
 * （`1 failed | 1 passed` + `25 passed`，实测复现见 round301 台账）。
 */
const SCREENS = {
  /** 真全绿。 */
  甲:
    colorize(
      "[[2m Test Files [[22m [[1m[[32m1 passed[[39m[[22m [[90m (1)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[32m25 passed[[39m[[22m [[90m (25)[[39m\n",
    ),
  /** 一发用例红（FAIL 行有用例名）。 */
  乙:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/x.test.ts[[2m > [[22msuite[[2m > [[22m那一发\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed[[39m[[22m [[90m (1)[[39m\n",
    ) + colorize("[[2m      Tests [[22m [[1m[[31m1 failed[[39m[[22m (2)\n"),
  /** 整份装载失败：`Tests` 行是 `no tests`，【一个数字都没有】。 */
  丙:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/x.test.ts[[2m [ test/arch/x.test.ts ][[22m\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed[[39m[[22m [[90m (1)[[39m\n",
    ) + colorize("[[2m      Tests [[22m [[2mno tests[[22m\n"),
  /** 死一份、其余照跑：`Tests` 行【有数字】，只有文件级看得见。 */
  丁:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/y.test.ts[[2m [ test/arch/y.test.ts ][[22m\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed | 1 passed[[39m[[22m [[90m (2)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[32m25 passed[[39m[[22m [[90m (25)[[39m\n",
    ),
  /**
   * 装载失败【加】另一发真红（真屏 probe302-mixed-raw.txt）：
   * Tests 行有数字、用例级也有红 ⇒ 计数型的旧两格【全静默】，只有格③ 认得。
   */
  戊:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/probe302dead.test.ts[[2m [ test/arch/probe302dead.test.ts ][[22m\n" +
        "[[41m[[1m FAIL [[22m[[49m test/arch/probe302red.test.ts[[2m > [[22mprobe302 真红[[2m > [[22m这一发故意红\n" +
        "[[2m Test Files [[22m [[1m[[31m2 failed[[39m[[22m[[2m | [[22m[[1m[[32m1 passed[[39m[[22m[[90m (3)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[31m1 failed[[39m[[22m[[2m | [[22m[[1m[[32m5 passed[[39m[[22m[[90m (6)[[39m\n",
    ),
  /** hook 炸 + 其余全绿（probe302-hookgreen-raw.txt）：没有方括号 ⇒ 只有格② 认得。 */
  己:
    colorize(
      "[[41m[[1m FAIL [[22m[[49m test/arch/probe302hook.test.ts[[2m > [[22mprobe302 hook 炸\n" +
        "[[2m Test Files [[22m [[1m[[31m1 failed[[39m[[22m[[2m | [[22m[[1m[[32m1 passed[[39m[[22m[[90m (2)[[39m\n",
    ) +
    colorize(
      "[[2m      Tests [[22m [[1m[[32m4 passed[[39m[[22m[[2m | [[22m[[33m1 skipped[[39m[[90m (5)[[39m\n",
    ),
} as const;

type ScreenName = keyof typeof SCREENS;

/**
 * 装载/采集失败那一族，四型（不变量③ 的输入）。
 *
 * ⚡ round302 从两型扩到四型。原来只有 丙/丁，而计数型那四台【只有两格】：
 *   丙 被两格同时拦住、丁 只被「文件级红而用例级 0 红」那一格拦住。本轮给它们补了
 *   第三格（方括号那型 FAIL 行）之后，丁【两格都拦得住】⇒「摘掉某一格还剩几格」
 *   这件事在 丙丁 两型上量不出来 ⇒ 必须补两型各自【只有一格认得】的屏：
 *     · 戊 = 装载失败【加】另一发真红 ⇒ 只有格③ 认得（Tests 行有数字、用例级也有红）
 *       这一型正是 round301 §⑦① 登记的那格残留，现在是【被钉住的】。
 *     · 己 = hook 炸 + 其余全绿 ⇒ 只有格② 认得（FAIL 行是 `> <suite>`，没方括号）
 *       没有己，摘掉格② 时丁照样被格③ 拦住 ⇒ 格② 看起来像装饰（假未命中）。
 *   字节取自真屏 `.workbuddy/probe302-{mixed,hookgreen}-raw.txt`。
 * ⚠ 登记的残留：hook 炸【加】另一发红（probe302-hook-raw.txt）四台计数型三格都不响 ——
 *   那种屏上「打到判据的红」与「别处炸的红」在字节上分不开，要分只能靠用例名归因
 *   （并红型那几台有）。
 */
const LOAD_FAIL_SCREENS: readonly ScreenName[] = ["丙", "丁", "戊", "己"];

/** 只有【文件名】没有用例名的那两型（夹具形状自证用）。 */
const BRACKET_SCREENS: readonly ScreenName[] = ["丙", "丁"];

/** 各台红味字段名不同（failed / red / failedTests / failedFiles / redFiles / files.failed）。 */
const RED_KEYS = [
  "failed",
  "red",
  "failedTests",
  "failedFiles",
  "redFiles",
  "files.failed",
  "tests.failed",
] as const;

type Reading = Record<string, number>;

const num = (flat: Reading, key: string): number => flat[key] ?? 0;

const redOf = (flat: Reading): number =>
  RED_KEYS.reduce((acc, k) => Math.max(acc, num(flat, k)), 0);

const TMP_ROOT = mkdtempSync(join(tmpdir(), "opc-parser-screen-"));
afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** 语料：`.workbuddy/round*-mutate-*.mjs` 里【自己实现 readSummary】的那些。 */
function machineCorpus(): string[] {
  const dir = join(repoRoot(), ".workbuddy");
  return readdirSync(dir)
    .filter((n) => /^round\d+-mutate-.*\.mjs$/u.test(n))
    .filter((n) =>
      readFileSync(join(dir, n), "utf8").includes("function readSummary"),
    )
    .sort();
}

/** 一行 const 取到行尾；函数取到下一个顶格 `}`。 */
function sliceRange(src: string, start: number, toBrace: boolean): string {
  const e = toBrace ? src.indexOf("\n}", start) : src.indexOf("\n", start);
  return src.slice(
    start,
    e === -1 ? src.indexOf("\n", start) : e + (toBrace ? 2 : 0),
  );
}

/**
 * 架构由【字节】分类，不由文件名清单：
 *  - 计数型：源码里有 `if (!/\d/u.test(seg)) {`（round301 补的那格）。
 *  - 并红型：源码里有 `failed: failedTests + failedFiles`（把自己的红并上文件级）。
 * 两者都不认得 ⇒ 当场红，不许「认不出就跳过」（那正是要防的那一族）。
 */
const ARCH_ANCHORS = {
  计数型: "if (!/\\d/u.test(seg)) {",
  并红型: "failed: failedTests + failedFiles",
} as const;

type Architecture = keyof typeof ARCH_ANCHORS;

function classify(slice: string, rel: string): Architecture {
  const owned = (Object.keys(ARCH_ANCHORS) as Architecture[]).filter((a) =>
    slice.includes(ARCH_ANCHORS[a]),
  );
  if (owned.length === 1) return owned[0] as Architecture;
  throw new Error(
    rel +
      " 的架构分不出来（认出 " +
      owned.length +
      " 种锚点，要恰好 1 种）⇒ 这台换了写法，" +
      "本守卫的锚点要跟着改。别把这一台从语料里排掉来让它过。",
  );
}

let seq = 0;

/** 把一段源码写成临时模块并导入；导入失败【直接冒到测试失败】，不许被当成「判式抛了」。 */
async function importParser(
  body: string,
  tag: string,
): Promise<(out: string) => Reading> {
  seq += 1;
  const file = join(
    TMP_ROOT,
    "m" + seq + "-" + tag.replace(/[^a-z0-9]/gu, "") + ".mjs",
  );
  writeFileSync(file, body, "utf8");
  const mod = (await import(pathToFileURL(file).href)) as {
    readSummary?: (out: string, wantFail?: boolean) => Reading;
  };
  if (mod.readSummary === undefined)
    throw new Error("切出来的模块里没有 readSummary：" + tag);
  return (out: string): Reading => mod.readSummary?.(out) ?? {};
}

/**
 * 把一台机器的 readSummary 连同它的自由变量切出来。
 *
 * ⚠ 取「行尾」还是「顶格 `}`」不能一刀切：对 `const ESC = …` 那一行也去找 `\n}`
 *   会把之后几十行（含真会执行的 readFileSync(SRC)）整段切进来 —— 临时模块在导入时
 *   就炸。另一种可能更坏：切到的语句【安静地跑掉】。
 */
async function loadMachine(rel: string): Promise<{
  readonly slice: string;
  readonly parse: (out: string) => Reading;
  readonly architecture: Architecture;
}> {
  const src = readFileSync(join(repoRoot(), ".workbuddy", rel), "utf8");
  const at = src.indexOf("function readSummary");
  if (at === -1) throw new Error("切不到 readSummary：" + rel);
  const escAt = src.indexOf("const ESC = String.fromCharCode(27);");
  const stripAt = src.indexOf("function strip(");
  const prelude =
    (escAt === -1 ? "" : sliceRange(src, escAt, false) + "\n") +
    (stripAt === -1 ? "" : sliceRange(src, stripAt, true) + "\n");
  const body = prelude + "export " + sliceRange(src, at, true) + "\n";
  const architecture = classify(body, rel);
  return { slice: body, parse: await importParser(body, rel), architecture };
}

/** 一次读数的处置：抛 / 读数。 */
type Handling =
  | { readonly threw: true; readonly flat: Reading }
  | { readonly threw: false; readonly flat: Reading };

function handle(parse: (out: string) => Reading, screen: ScreenName): Handling {
  try {
    return { threw: false, flat: flatten(parse(SCREENS[screen])) };
  } catch {
    return { threw: true, flat: {} };
  }
}

/** 把读数摊平成 {字段名: 数字}。 */
function flatten(r: unknown): Reading {
  const o = r as Record<string, unknown>;
  const out: Reading = {};
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v instanceof Set) out[k] = v.size;
    else if (v !== null && typeof v === "object") {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (typeof v2 === "number") out[`${k}.${k2}`] = v2;
      }
    } else if (typeof v === "number") out[k] = v;
  }
  return out;
}

/** 抹字节：锚点在该切片里必须【恰好出现一次】，否则不许抹。 */
function punch(slice: string, from: string, to: string, rel: string): string {
  const n = slice.split(from).length - 1;
  if (n !== 1) {
    throw new Error(
      rel +
        " 的切片里锚点命中 " +
        n +
        " 次（要恰好 1 次）：" +
        from +
        " ⇒ 这台换了写法，本自证的锚点要跟着改（别删掉这一发来让它过）",
    );
  }
  const after = slice.replace(from, to);
  if (after === slice) throw new Error("空变：to === from");
  return after;
}

describe("变异机的 readSummary：全场喂真 vitest 屏（round301）", () => {
  const corpus = machineCorpus();

  it("语料非空且台数不低于本轮数出来的那个数 —— 语料空了这条会恒绿", () => {
    // 反假绿哨兵：本文件的结论是【逐台】的，所以「一台都没扫到」必须当场红。
    // 分母来源：本轮 readdirSync 数出 25 台 mutate 机，其中 9 台自己实现 readSummary
    // （4 台计数型 + 5 台并红型，分类见上面的 ARCH_ANCHORS）。
    // ⚠ 第 25 台是 round302-mutate-cell3.mjs：它被文件名正则【扫进目录】但没有自己的
    //   readSummary（它靠【切片】借别人的），所以不进语料 ⇒ 它没有「自己的读数」可普查。
    expect(
      corpus.length,
      "切出的台数：" + corpus.join(", "),
    ).toBeGreaterThanOrEqual(9);
  });

  it("四份屏【各自】形状自证：判式不是恒拒也不是恒受", () => {
    // 前提自证【两条方向相反】：甲必须读得出「全绿」，乙必须读得出「有红」。
    // 少了这一发，把判式写成「什么都抛」也过 —— 那是 round300 记的那一族。
    expect(SCREENS["甲"]).toContain("25 passed");
    expect(SCREENS["甲"]).not.toContain("failed");
    expect(SCREENS["丙"]).toContain("no tests");
    expect(SCREENS["丁"]).not.toContain("no tests");
    // 丁与丙【只差 Tests 行那一处】：两型不是两份随便写的字符串。
    expect(SCREENS["丁"]).toContain("1 failed | 1 passed");
    // 乙 与 丙/丁【真的差在归因上】：前者的 FAIL 行长出用例名，后两者只有文件名。
    // ⚠ 判的是【剥完色码】的文本：色码夹在 `>` 与用例名之间，直接在原字节上
    //   找 "> 那一发" 找不到（本文件第一版就这么错过一次，红在自己身上）。
    const stripped = (s: ScreenName): string => plain(SCREENS[s]);
    const failLine = (s: ScreenName): string =>
      stripped(s)
        .split("\n")
        .find((l) => l.includes("FAIL")) ?? "";
    expect(
      failLine("乙"),
      "乙 的 FAIL 行没有用例名 ⇒ 它就不是一发【用例】红",
    ).toMatch(/>[^>]*那一发\s*$/u);
    for (const name of BRACKET_SCREENS) {
      expect(
        failLine(name),
        name + " 的 FAIL 行长出了用例名 ⇒ 装载失败不是这个形状",
      ).not.toContain(">");
    }
    expect(stripped("丙")).toMatch(/Tests\s+no tests/u);

    /* round302 补：戊/己 的【分界线】本身也得自证。
       这一族全部的价值在于「两型各自只有一格认得」，而那件事取决于两处字节形状：
         · 装载失败的专属特征 = `FAIL <文件> [ <同一个文件> ]`（方括号里重复同一路径）
         · 用例/hook 失败【没有】那个方括号
       戊 必须【两者都有】（一份装载失败 + 另一发用例红），己 必须【只有后者】。
       少了这一发，把 己 也写成带方括号的屏 ⇒ 摘掉格② 时它照样被格③ 拦住 ⇒
       下面那一发「抹格② ⇒ 己失守」永远红，而红因是我的夹具（round300 那一族）。 */
    const bracketLines = (s: ScreenName): string[] =>
      stripped(s)
        .split("\n")
        .filter((l) => /^\s*FAIL\s+(\S+)\s+\[\s*(\S+)\s*\]\s*$/u.test(l));
    expect(
      bracketLines("丙").length + bracketLines("丁").length,
      "丙/丁 少了方括号那型 FAIL 行 ⇒ 计数型新加的格③ 就没有输入了",
    ).toBe(2);
    // 戊：既有方括号（装载失败那一份），又有长出用例名的一发（另一发真红）。
    expect(bracketLines("戊").length).toBe(1);
    expect(
      stripped("戊"),
      "戊 里没有长出用例名的 FAIL 行 ⇒ 它就不是「装载失败 + 另一发红」",
      // ⚠ 用例名前面还夹着【另一段 suite】（`> suite > 用例名`）⇒ 这里不能写 `[^>]*`，
      //   那一支过不了第二个 `>`（本文件第一版就是这么红的，红在夹具自证自己身上）。
    ).toMatch(/FAIL\s+\S+\s>.*这一发故意红\s*$/mu);
    // Tests 行有数字 ⇒ 格① 不响；用例级也有红 ⇒ 格② 不响。两格不响的前提钉住。
    expect(stripped("戊")).toMatch(/Tests\s+1 failed/u);
    // 己：一发都没红（4 passed | 1 skipped）⇒ 只有格② 认得它；且【不许】有方括号。
    expect(bracketLines("己").length).toBe(0);
    expect(stripped("己")).not.toMatch(/Tests\s+\d+ failed/u);
    expect(stripped("己")).toMatch(/1 skipped/u);
  });

  it("语料【每一台】都归得进某一型 —— 认不出就红，不许跳过", () => {
    // 这一发把「分类」本身变成主张：分母数出来，两型各至少一台。
    const counts = new Map<Architecture, string[]>();
    for (const rel of corpus) {
      const src = readFileSync(join(repoRoot(), ".workbuddy", rel), "utf8");
      const at = src.indexOf("function readSummary");
      const body = src.slice(at, src.indexOf("\n}", at) + 2);
      const a = classify(body, rel);
      const list = counts.get(a) ?? [];
      list.push(rel);
      counts.set(a, list);
    }
    for (const a of Object.keys(ARCH_ANCHORS) as Architecture[]) {
      expect(
        (counts.get(a) ?? []).length,
        a +
          " 型一台都没认出 ⇒ 架构判式漂了（现有分类：" +
          JSON.stringify([...counts.keys()]) +
          "）",
      ).toBeGreaterThan(0);
    }
  });

  for (const rel of corpus) {
    it(`${rel}：甲读绿 / 乙读红 / 丙丁不许读成全绿`, async () => {
      // 装载【在】量读数之前完成：导入失败会冒成测试失败，而不是被下面的
      // try 当成「判式抛了」—— 一个把「没跑成」读成「跑出来是红」的机器，
      // 与它正在审的那个洞同族（round301 探针上真中过这一发）。
      const m = await loadMachine(rel);
      const flat = (name: ScreenName): Reading =>
        flatten(m.parse(SCREENS[name]));

      const jia = flat("甲");
      expect(
        redOf(jia),
        "甲（真全绿屏）被读成了红：" + JSON.stringify(jia),
      ).toBe(0);

      const yi = flat("乙");
      expect(
        redOf(yi),
        "乙（一发用例红的真屏）被读成了绿：" +
          JSON.stringify(yi) +
          " ⇒ 这台会把红读成绿",
      ).toBeGreaterThan(0);

      for (const name of LOAD_FAIL_SCREENS) {
        const got = handle(m.parse, name);
        expect(
          got.threw || redOf(got.flat) > 0,
          `${name}（装载失败屏）被读成了一次【和全绿一样】的读数：` +
            JSON.stringify(got.flat) +
            " ⇒ 控制组会在【一个用例都没跑】的前提下判命中",
        ).toBe(true);

        if (m.architecture === "计数型") {
          // 它没有用例名归因 ⇒ 「抛」是它唯一的那道门。
          expect(
            got.threw,
            `${m.architecture} 的 ${name} 没抛：` +
              JSON.stringify(got.flat) +
              " ⇒ 计数型只有『抛』这一道门，它关了 ⇒ 见 round301-mutate-parser-guards.mjs",
          ).toBe(true);
        } else {
          // 它靠【自己那句 failed】把文件级红并进来 ⇒ 读的那一格必须是红。
          // 这里刻意读 m 自己的字段而不是红味并集（见文件头那条 ⚠）。
          expect(
            got.threw || num(got.flat, "failed") > 0,
            `${name} 里并红型自己的 failed 读成了 ` +
              num(got.flat, "failed") +
              "（完整读数 " +
              JSON.stringify(got.flat) +
              "）⇒ 它的 M0 控制组会在装载失败屏上判【命中】",
          ).toBe(true);
        }
      }
    });
  }

  it("⭐ 变异自证：把切片里那一格真抹掉 ⇒ 本文件的判式必须转红", async () => {
    // 没有这一发，上面那 N 发可能只是「今天的字节恰好都过」——判式恒绿没人知道。
    // 两型【各抹一发】，因为它们的承重格不是同一格。
    const problems: string[] = [];

    /* ── 并红型：抹掉 `failed: failedTests + failedFiles` ─────────────
       ⇒ 装载失败屏上它自己的 failed 变 0，而 failedFiles 还在 ⇒
         红味【并集】仍 > 0 ⇒ 只判并集会漏掉这一发（本轮量出来的）。 */
    const bRel = corpus.find((n) => n.includes("round296")) ?? corpus[0];
    if (bRel === undefined) throw new Error("语料空了");
    const bOrig = readFileSync(join(repoRoot(), ".workbuddy", bRel), "utf8");
    const b = await loadMachine(bRel);
    const bPunched = punch(
      b.slice,
      ARCH_ANCHORS["并红型"],
      "failed: failedTests",
      bRel,
    );
    const bParse = await importParser(bPunched, bRel + "-punched");
    /* 戊 单独判：那一屏【本来就有一发真用例红】（probe302-mixed 真屏），抹掉并红后
       它自己的 failed 仍 > 0 —— 那不是「没坏」，那是【真的红】。本轮探针量过九台，
       戊 上并红型抹前 failed=3（= 1 发用例红 + 2 份文件红）、抹后 = 1 ⇒
       判「抹后必须 0」会把这一发写成【永远红】的假判式（round300 那一族：口径跟着
       字节走，不能跟着上一轮的记忆走）。 */
    const wuBefore = handle(b.parse, "戊");
    for (const name of LOAD_FAIL_SCREENS) {
      const after = handle(bParse, name);
      if (after.threw) {
        problems.push(name + "：抹掉并红后【仍然抛】⇒ 那一格不是承重的");
      } else if (name === "戊") {
        if (num(after.flat, "failed") === 0) {
          problems.push(
            "戊：抹掉并红后 failed 成了 0 ⇒ 那一屏的真用例红也没了，锚点抹过头",
          );
        } else if (num(after.flat, "failed") >= num(wuBefore.flat, "failed")) {
          problems.push(
            "戊：抹掉并红后 failed 没下降（" +
              num(wuBefore.flat, "failed") +
              " → " +
              num(after.flat, "failed") +
              "）⇒ 文件级红还在被计入",
          );
        } else if (
          num(after.flat, "failed") !== num(after.flat, "failedTests")
        ) {
          problems.push(
            "戊：抹后 failed=" +
              num(after.flat, "failed") +
              " 而 failedTests=" +
              num(after.flat, "failedTests") +
              " ⇒ 抹得不干净",
          );
        }
      } else if (num(after.flat, "failed") > 0) {
        problems.push(
          name + "：抹掉并红后 failed 仍 = " + num(after.flat, "failed"),
        );
      } else if (redOf(after.flat) === 0) {
        problems.push(
          name + "：红味并集也读成 0 ⇒ 本文件那条不变量③ 抓不到这一发了",
        );
      }
      // failedFiles 还挂在返回对象里 ⇒ 并集口径看不出这台坏了（本文件为何读专属字段）。
      else if (num(after.flat, "failedFiles") === 0) {
        problems.push(name + "：failedFiles 也成 0 了 ⇒ 锚点抹到了别处");
      }
    }

    /* ── 计数型 A：抹掉「文件级红而用例级 0 红」那一格（格②）───────────
       ⚡ round302 改了红的【落点】。原来判的是「丁 不再抛」，而本轮补了格③ 之后
       丁 那一屏【两格都拦得住】⇒ 抹掉格② 时丁仍抛 ⇒ 那一发【永远红】，红因是我
       自己的判式过期（round300 那一族：登记的口径跟不上机器字节）。
       现在红的正当落点是【己】（hook 炸 + 其余全绿，没有方括号 ⇒ 格③ 不响），
       而 戊 仍须抛（格③ 没动）⇒ 这一发同时钉住「己 是格② 独立承重的那一型」。 */
    const cell2 = [
      "failedFiles > 0 && failed === 0",
      "redFiles > 0 && red === 0",
      "files.failed > 0 && tests.failed === 0",
    ];
    const aRel = corpus.find((n) => n.includes("round294")) ?? corpus[0];
    if (aRel === undefined) throw new Error("语料空了");
    const a = await loadMachine(aRel);
    const anchor = cell2.find((a2) => a.slice.includes(a2));
    if (anchor === undefined) {
      throw new Error(
        aRel +
          " 的切片里找不到「文件级 vs 用例级」那一格 ⇒ 这台换了写法，" +
          "本自证的锚点要跟着改（别删这一发来让它过）",
      );
    }
    const aPunched = punch(
      a.slice,
      "if (" + anchor + ") {",
      "if (false) {",
      aRel,
    );
    const aParse = await importParser(aPunched, aRel + "-punched");
    const ji = handle(aParse, "己");
    if (ji.threw)
      problems.push(
        "己：抹掉格② 后【仍然抛】⇒ 拦它的是别的格，锚点没打在承重处（" +
          JSON.stringify(ji.flat) +
          "）",
      );
    for (const name of ["丙", "戊"] as const) {
      if (!handle(aParse, name).threw) {
        problems.push(
          name +
            "：抹掉格② 之后【连该拦它的格也不拦了】⇒ 那一格不该被这一发影响",
        );
      }
    }

    /* ── 计数型 B：抹掉【格③】（方括号那型 FAIL 行）───────────────────
       红的正当落点是【戊】（装载失败 + 另一发真红）；丙 由格①、己 由格② 各自拦住
       ⇒ 三格各自只被一型钉住。没有这一发，日后有人删掉格③ 时本文件【仍然全绿】——
       round302 那台矩阵（round302-mutate-cell3.mjs）会红，但它是【手跑】的机器，
       不是常跑守卫；本文件才是每次 arch 全跑都过的那一道。 */
    const CELL3 = "if (deadFiles.length > 0) {";
    if (a.slice.includes(CELL3)) {
      const a3Punched = punch(a.slice, CELL3, "if (false) {", aRel);
      const a3Parse = await importParser(a3Punched, aRel + "-punched3");
      const wu = handle(a3Parse, "戊");
      if (wu.threw)
        problems.push(
          "戊：抹掉格③ 后【仍然抛】⇒ 那一格不是那一型唯一的门（" +
            JSON.stringify(wu.flat) +
            "）",
        );
      for (const name of ["丙", "己"] as const) {
        if (!handle(a3Parse, name).threw) {
          problems.push(
            name +
              "：抹掉格③ 之后不抛了 ⇒ 它其实是被格③ 拦住的，" +
              "「三格各自承重」这句话是假的",
          );
        }
      }
    } else {
      problems.push(
        aRel +
          " 的切片里没有格③ ⇒ 那台计数型把格③ 撤了或改写了；要么补回来，" +
          "要么把这里的锚点跟着改（别把这一支删掉来让它过）",
      );
    }

    // 本文件【只读切片】，一个字都不该写进 .workbuddy —— 那几台是自回滚机器，
    // 跑它们的时候不许并发（台账纪律）。这里钉住「没写」。
    expect(
      readFileSync(join(repoRoot(), ".workbuddy", aRel), "utf8"),
      "本守卫把生产字节写坏了：" + aRel,
    ).not.toBe(aPunched);
    expect(
      readFileSync(join(repoRoot(), ".workbuddy", bRel), "utf8"),
      "写坏了：" + bRel,
    ).toBe(bOrig);

    expect(problems, "变异自证未命中：\n  " + problems.join("\n  ")).toEqual(
      [],
    );
  });
});
