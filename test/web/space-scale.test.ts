/**
 * 间距刻度守卫 —— 三份 CSS 里每一枚 gap 要么走 var(--space-*)，要么待在带理由的
 * 豁免名单里，且豁免值必须【小于最小那一档】。没有第三种状态。
 *
 * ── 为什么值得单独一份 ──────────────────────────────────────────
 * round377 把 92 枚散档 gap（5/6/7/9/10/11/13/14/15/17/18/20）折进刻度之后，
 * 全仓没有任何东西拦得住下一枚 `gap: 9px` 重新长回来 —— 颜色有色阶守卫，
 * 类名有 admin-style-scope，字号在 --fs-* 上也有零散断言，唯独间距是「改完这一轮
 * 就没人再量」的那一维。而散档的症状不是坏，是【分不出层次】：卡片内 10 卡片间 12
 * 这种差 2px 的组合，肉眼读成一坨，尺子又挑不出谁的错。
 *
 * ── 尺子取自本仓自己写下的那条折档规则 ─────────────────────────
 * group.css :root 的间距注释写死了两件事：① 取最近一档，正好落在正中时取较小那档
 * （为了卡片内部永远严格小于卡片之间）；② 2px/3px 是亚档微调，留在裸数字不进刻度。
 * 所以本文件的判据是：豁免值必须 < var(--space-1)=4px。这条不是随手挑的数 ——
 * 一旦有人把 9px 加进豁免名单，他就同时在主张「内部间距可以等于乃至大于外部」，
 * 那正是折档规则要防的那件事。所以这里的硬门是「小于最小档」，而不是「在白名单里」。
 *
 * ── 名单是双向的 ────────────────────────────────────────────────
 * 漏一条 ⇒ 红（裸档长回来了）；多一条 ⇒ 也红（豁免已经过期，它还挂着就会骗下一个
 * 人以为这里还有裸值）。理由和 admin-style-scope.test.ts 对类名的双向钉法一致。
 *
 * ── 提取器自己也会失效 ─────────────────────────────────────────
 * 洗注释 + 回溯选择器 + 按空格切多值，三个动作任何一个坏得太彻底都会把守卫变成
 * 常绿。所以每条都配一发合成样本反向对照：先证明它【能】在假 CSS 上抓到东西，
 * 再信它在真文件上报的 0。照色阶守卫同一套路子。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PUB = join(REPO, "packages/web/public");

const CSS_FILES = ["group.css", "admin.css", "theme.css"] as const;

/** 刻度本体：期望值写在这里，而不是从 CSS 里读出来再自我确认。 */
const SCALE = [4, 8, 12, 16, 20, 24, 32] as const;
const SCALE_TOKENS = SCALE.map((_, i) => `var(--space-${i + 1})`);
/** 两个具名别名：语义化的档位入口，值必须仍然指回刻度。 */
const ALIASES = ["var(--gap-control)", "var(--gap-tool-cluster)"];

/**
 * 豁免名单：住在 CSS 里的裸值，逐条给理由。
 * 全部 < 4px = 亚档微调（折档规则第 ② 条），不是「忘了改」。
 */
const EXEMPT: ReadonlyArray<{
  file: string;
  selector: string;
  value: string;
  why: string;
}> = [
  {
    file: "group.css",
    selector: ".conversation-row",
    value: "2px",
    why: "行与右侧置顶列之间只是「贴过去」，不是分栏；4px 会把置顶列推离标题右缘",
  },
  {
    file: "group.css",
    selector: ".list-skeleton",
    value: "2px",
    why: "骨架行距要贴住真身 .conversation-row 的 2px + margin-bottom 2px，凑成同一个行距",
  },
  {
    file: "group.css",
    selector: ".message-tools",
    value: "2px",
    why: "图标工具密集条：4 枚图标按钮挤在一条 hover 才出现的工具条里，4px 会把它们拆成两组",
  },
  {
    file: "group.css",
    selector: ".task-actions",
    value: "2px",
    why: "同上，且这组按钮会回绕；4px 时一屏少放一枚，回绕位置跟着变",
  },
  {
    file: "group.css",
    selector: ".rich-editor-toolbar",
    value: "3px",
    why: "工具条在 ≤860 那一档收窄后正好排满，4px 会把最后一枚挤到第二行",
  },
];

const stripCssComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//gu, "");

type GapDecl = { file: string; selector: string; value: string };

/** 取一条声明往回最近的那个块的选择器（跨过 @media 的嵌套块）。 */
function selectorFor(src: string, declIdx: number): string {
  const open = src.lastIndexOf("{", declIdx);
  if (open < 0) return "(文件开头没有块)";
  const guard = Math.max(
    src.lastIndexOf("}", open),
    src.lastIndexOf("{", open - 1),
  );
  return src
    .slice(guard + 1, open)
    .replace(/\s+/gu, " ")
    .trim();
}

/** 收集 gap / row-gap / column-gap 声明（注释已洗，值原样保留）。 */
function collectGaps(file: string, raw: string): GapDecl[] {
  const src = stripCssComments(raw);
  const out: GapDecl[] = [];
  const re = /(?:^|[;{}\s])((?:row-|column-)?gap):\s*([^;}]+)/gu;
  for (const m of src.matchAll(re)) {
    const value = (m[2] ?? "").replace(/\s+/gu, " ").trim();
    out.push({
      file,
      selector: selectorFor(src, (m.index ?? 0) + (m[1] ?? "").length),
      value,
    });
  }
  return out;
}

/** 一边的值合不合规：刻度、别名，或「亚档裸值」由豁免名单单独管，这里只认 token。 */
const isTokenSide = (side: string): boolean =>
  SCALE_TOKENS.includes(side) || ALIASES.includes(side);

/** 把 gap 的多值（`gap: A B`）拆成两半 —— 只查第一半会漏掉纵向那一刀。 */
const sides = (value: string): string[] => value.trim().split(/\s+/u);

/** 在 :root 里读自定义属性：属性名 → 第一次出现的值。 */
function readRootTokens(
  raw: string,
  rootSelector: string,
): Map<string, string> {
  const src = stripCssComments(raw);
  const i = src.indexOf(rootSelector);
  if (i < 0) throw new Error(`找不到 ${rootSelector}`);
  const end = src.indexOf("}", i);
  const out = new Map<string, string>();
  for (const m of src.slice(i, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/gu)) {
    if (!out.has(m[1] as string)) out.set(m[1] as string, (m[2] ?? "").trim());
  }
  return out;
}

const ALL = CSS_FILES.flatMap((f) =>
  collectGaps(f, readFileSync(join(PUB, f), "utf8")),
);

describe("间距刻度：gap 只走 --space-*，裸值须是亚档且在名单里", () => {
  it("刻度本体是 4/8/12/16/20/24/32，严格递增", () => {
    const tokens = readRootTokens(
      readFileSync(join(PUB, "group.css"), "utf8"),
      ":root",
    );
    const got = SCALE.map((_, i) => tokens.get(`--space-${i + 1}`));
    expect(got).toEqual(SCALE.map((px) => `${px}px`));
    const nums = got.map((v) => Number.parseInt(String(v), 10));
    for (let i = 1; i < nums.length; i += 1) {
      expect(nums[i] as number).toBeGreaterThan(nums[i - 1] as number);
    }
  });

  it("两枚具名别名的值仍指回刻度，不是自己存了一份裸值", () => {
    const tokens = readRootTokens(
      readFileSync(join(PUB, "group.css"), "utf8"),
      ":root",
    );
    for (const alias of ["--gap-control", "--gap-tool-cluster"]) {
      const v = tokens.get(alias) ?? "";
      expect(v, `${alias} 的定义`).toMatch(/^var\(--space-\d\)$/u);
    }
  });

  it("每一枚 gap 的每一边都是刻度 token（或已在豁免名单里的亚档裸值）", () => {
    const offenders: string[] = [];
    for (const d of ALL) {
      if (
        EXEMPT.some(
          (e) =>
            e.file === d.file &&
            e.selector === d.selector &&
            e.value === d.value,
        )
      ) {
        continue;
      }
      const bad = sides(d.value).filter((s) => !isTokenSide(s));
      if (bad.length > 0)
        offenders.push(
          `${d.file} · ${d.selector} · gap:${d.value} ⇒ ${bad.join(" / ")}`,
        );
    }
    expect(
      offenders,
      "这些 gap 没走刻度，也不在豁免名单里：\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("豁免名单双向：名单里每一条仍然活着，且全部小于最小那一档", () => {
    const dead = EXEMPT.filter(
      (e) =>
        !ALL.some(
          (d) =>
            d.file === e.file &&
            d.selector === e.selector &&
            d.value === e.value,
        ),
    );
    expect(
      dead.map((d) => `${d.file} ${d.selector} gap:${d.value}`),
      "豁免名单已过期，删掉这些",
    ).toEqual([]);
    const tooBig = EXEMPT.filter(
      (e) => Number.parseInt(e.value, 10) >= SCALE[0],
    );
    expect(
      tooBig.map((e) => `${e.selector} gap:${e.value}`),
      "豁免只给亚档（< 4px）；到档了就折进 var(--space-*)",
    ).toEqual([]);
  });

  it("本仓确实用上了刻度（否则前面几条会因为『压根没有 gap』而假绿）", () => {
    const tokenized = ALL.filter((d) => sides(d.value).every(isTokenSide));
    expect(tokenized.length, "走刻度的 gap 条数").toBeGreaterThan(80);
  });

  // ── 提取器反向对照：先证明判据能抓到东西，再信它在真文件上报的 0 ──
  it("反向对照：合成样本里的裸值、第二半裸值、注释伪装都要被抓到", () => {
    const fake = [
      "/* gap: 99px 藏在注释里，不该算 */",
      ".a { gap: 9px; }",
      ".b { gap: var(--space-2) 9px; }",
      ".c { row-gap: 14px; }",
      "@media (max-width: 860px) { .d { gap: 3px; } }",
      ".e { gap: var(--space-1) var(--space-2); }",
    ].join("\n");
    const got = collectGaps("fake.css", fake);
    expect(got.map((d) => `${d.selector}|${d.value}`)).toEqual([
      ".a|9px",
      ".b|var(--space-2) 9px",
      ".c|14px",
      ".d|3px",
      ".e|var(--space-1) var(--space-2)",
    ]);
    const flagged = got
      .filter((d) => !sides(d.value).every(isTokenSide))
      .map((d) => d.selector);
    expect(flagged).toEqual([".a", ".b", ".c", ".d"]);
    // 嵌套块的选择器要认得出 .d（回溯时越过 @media 的那个 {），否则豁免名单会按选择器对不上号。
    expect(got[3]?.selector).toBe(".d");
  });
});
