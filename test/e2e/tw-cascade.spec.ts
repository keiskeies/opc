/**
 * 级律在真浏览器里的那一发：未分层手写规则 vs 分层工具类，谁赢。
 *
 * ── 这个文件为什么会存在 ────────────────────────────────────────
 * 整套 Tailwind 接法「零像素回归」的全部依据是一条级联律：未分层声明恒赢过分层声明，
 * 不看特异度也不看先后。tw-input.css 的文件头把它写成散文，test/web/tailwind-wiring.test.ts
 * 那十几发量的是【入口文本与产物字节】—— 它能保证「工具类确实被放进了 @layer
 * utilities」，也就是这条律的【前提】成立；但 vitest 跑在 node 里，读不到浏览器到底怎么
 * 决胜。前提 + 这条律才等于「现有渲染挤不动」，缺这条律就等于没证。
 *
 * ── 判据形状：一把有四个刻度的尺子 ──────────────────────────────
 * 光判「决斗里拿到手写那条的值」不够：观测窗口若只有两个可分辨的取值，「手写赢」与
 * 「utility 根本没生效」是同一个字符串。所以刻意让四种形状各给一个【互不相同】的读数
 * （实测 text-wrap 这三档互不相同）：
 *   #init    两条都不挂          读 wrap    （属性的 initial 值）
 *   #hand    只挂手写规则        读 nowrap  （手写那条自己活着）
 *   #control 只挂 utility        读 balance （utility 自己活着）
 *   #duel    两条都挂            看谁赢
 * 只有 #duel=nowrap 且 #control=balance，才叫「手写赢下了 utility」。我先前那版只有
 * 决斗 + utility 两发，缺 initial 一档；补上 #hand/#init 后，「这个读数来自哪条规则」
 * 才是唯一解，而不是两条候选共用一个读数。
 *
 * ── 手写那一条【必须比特异度更低】──────────────────────────────
 * 决斗的手写规则是 `div { … }`，特异度 (0,0,1)；工具类是 (0,1,0)。写成 `.duel { … }`
 * 就把它抬到 (0,1,0)，改由「特异度同权 + 文档顺序」决胜，量到的就不是级联律了。只有
 * 「特异度更低、却仍然赢」这一种形状才证明救场的是那条律本身。我先前那版正是 `.duel`，
 * 赢的是特异度 —— 判据看着绿，尺子接错了地方。
 *
 * ── 反向眼睛：剥掉 @layer，赢家必须换人 ────────────────────────
 * 若无论产物长什么样都判「手写赢」，上面那条就是恒绿的装饰。第二发把同一批字节剥掉
 * @layer 包裹再喂给浏览器：此时工具类以 (0,1,0) 正面对决 (0,0,1)，赢家必须换成 balance。
 * 同时用 CSSOM 问浏览器「这条 utility 落在哪个 @layer 里」—— 第一发答 utilities，
 * 第二发答「不在任何层里」。量的是浏览器自己的层模型，不是我自己正则数出来的字符串。
 *
 * ── 为什么前两发把字节内联进文档 ────────────────────────────────
 * file:// 的 <link> 样式表能正常参与级联，但读它的 cssRules 会被同源策略挡（实测抛
 * SecurityError），问不出层归属。内联同源则 cssRules 可读（实测拿得到
 * CSSLayerBlockRule，name = "utilities"），也不必为一条级联律带上 hub、库锁与 240s
 * 超时这些失败面。第三发【另用】真 HTTP + 真 <link>，量的是 vendored 接线形状。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, test } from "@playwright/test";

const REPO = resolve(process.cwd());
const PUB = join(REPO, "packages/web/public");
const read = (f: string): string => readFileSync(join(PUB, f), "utf8");

/** 决斗用的 utility：必须是【产物里真有】的那一枚，否则对照组必假红。 */
const UTILITY = "tw:text-balance";
/** 决斗用属性与三个取值（initial / 手写 / utility），实测互不相同。 */
const PROP = "text-wrap";
const INITIAL = "wrap";
const HAND = "nowrap";
const UTIL = "balance";

/**
 * 页面里跑的探针。为什么是字符串而不是箭头函数：本仓 tsconfig 的 lib 只有 ES2023、
 * 没有 DOM，箭头函数写法会让 document / getComputedStyle 在 tsc 硬门里报「找不到名字」
 * （sheet-editor.spec.ts 现在正为这个红）。返回值统一 JSON.stringify，在外面 parse
 * 并标形状 —— 这是 doc-layout.spec.ts 已经在用的形状。
 *
 * 层归属沿嵌套关系问 CSSOM：CSSLayerBlockRule 的 name 就是浏览器认下的层名。这比我自己
 * 数大括号可靠 —— 判据说的是「浏览器把这条规则算进第几层」，那就问浏览器。
 */
const PROBE = `(() => {
  const val = (id) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('缺少节点：' + id);
    return getComputedStyle(el).getPropertyValue('${PROP}');
  };
  const layerChain = (needle) => {
    const out = [];
    const walk = (list, chain) => {
      for (const rule of list) {
        const next = rule.constructor.name === 'CSSLayerBlockRule'
          ? chain.concat(rule.name)
          : chain;
        if ((rule.selectorText || '').indexOf(needle) >= 0) out.push(next.join('/'));
        if (rule.cssRules) walk(rule.cssRules, next);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, []);
    return out;
  };
  return JSON.stringify({
    duel: val('duel'),
    control: val('control'),
    hand: val('hand'),
    init: val('init'),
    utilityLayers: layerChain('text-balance'),
    handLayers: layerChain('div'),
  });
})()`;

/** 探针返回值的形状 —— 在 node 侧标注；页面侧那段字符串不受 tsc 管。 */
type Probe = {
  duel: string;
  control: string;
  hand: string;
  init: string;
  utilityLayers: string[];
  handLayers: string[];
};

/** 手写那一条：元素选择器，特异度刻意低于工具类。 */
const HAND_RULE = `div { ${PROP}: ${HAND}; }`;

/** 内联样式表字节 + 四个观测元素。 */
const fixture = (css: string): string => `<!doctype html><html lang="zh"><head>
<meta charset="utf-8">
<style>${HAND_RULE}</style>
<style>${css}</style>
</head><body>
<div id="duel" class="${UTILITY}">duel</div>
<p id="control" class="${UTILITY}">control</p>
<div id="hand">hand</div>
<p id="init">init</p>
</body></html>`;

async function probe(
  page: import("@playwright/test").Page,
  html: string,
): Promise<Probe> {
  await page.setContent(html, { waitUntil: "load" });
  const raw = await page.evaluate(PROBE);
  return JSON.parse(raw as string) as Probe;
}

/** 判据的前提：决斗用的这枚 utility 在产物里。 */
function requireUtility(): string {
  const product = read("tw.css");
  // 它不在就该在这里红并说清去跑 pnpm tw:build，而不是让对照组以「样式没生效」的形状
  // 红 —— 那会把病因（产物落后）伪装成一副浏览器渲染错的样子。
  expect(
    product.includes("tw\\:text-balance"),
    `产物里没有 ${UTILITY}，决斗没有对手（跑 pnpm tw:build）`,
  ).toBe(true);
  return product;
}

/** 四把尺子先各就各位：读不到这四个值，后面比什么都只是在比噪声。 */
function assertScale(got: Probe): void {
  expect(got.init, `窗口不干净：不挂规则时读到 ${got.init}`).toBe(INITIAL);
  expect(got.hand, `手写那条自己没生效：读到 ${got.hand}`).toBe(HAND);
  expect(got.control, `utility 自己没生效：读到 ${got.control}`).toBe(UTIL);
}

/**
 * 三个刻度的字面量必须互不相同 —— 这条不是形式主义，是判据成立的前提。
 * 若哪天有人把 HAND 改成 "wrap"（与 initial 同值）或 "balance"（与 utility 同值），
 * 所有断言照样【全绿】：duel 读到 wrap 时，「手写赢」与「两条都没生效」再也分不开，
 * 尺子从三格塌成两格。塌了却不红，是这一族判据最贵的失效形状，所以在这里当场拦。
 */
test("尺子自证：initial / 手写 / utility 三个读数互不相同", () => {
  const scales = [INITIAL, HAND, UTIL];
  expect(new Set(scales).size, "三档刻度重了，决斗没有可分辨的读数").toBe(3);
  // 这三档也必须是 text-wrap 真取得出的值（拼错一档会让上面每一条以「没生效」红，
  // 病因却写成样式问题）。
  expect(["wrap", "nowrap", "balance", "stable"]).toContain(INITIAL);
  expect(["wrap", "nowrap", "balance", "stable"]).toContain(HAND);
  expect(["wrap", "nowrap", "balance", "stable"]).toContain(UTIL);
});

test("级律：特异度更低、更早的未分层手写规则赢下分层 utility", async ({
  page,
}) => {
  const got = await probe(page, fixture(requireUtility()));
  assertScale(got);

  // 层归属问浏览器：工具类在 utilities 层里，手写那条不在任何层里（layerChain 给空串）。
  expect(got.utilityLayers, "工具类的层归属不是 utilities").toEqual([
    "utilities",
  ]);
  expect(got.handLayers, "手写那条不该落在任何 @layer 里").toEqual([""]);

  // 决斗：特异度 (0,0,1) 的未分层声明赢下特异度 (0,1,0) 的分层声明。
  expect(
    got.duel,
    `赢的不是未分层手写规则（拿到 ${got.duel}）⇒ tw-* 能挤走现有渲染`,
  ).toBe(HAND);
});

test("反向：把 utility 剥出所有层，同一场决斗的赢家换人", async ({ page }) => {
  // 决斗判据自己的反向眼睛。剥层后的形状照实测：未分层的产物长
  // `@layer theme,base,components;.tw\:text-balance{…}` —— 语句规则 + 层外选择器。
  const product = requireUtility();
  // 剥之前先确认层【在】：若产物早已不分层，replace 会空转，「剥层后赢家换人」就会对着
  // 一份没动过的字节判出【不换人】⇒ 这一发假红；更糟的是它会把「layer(utilities) 掉了」
  // 这个真事故报成「反向判据坏了」。所以先看一眼再剥，红就红在正确的因上。
  expect(
    product.includes("@layer utilities{"),
    "产物本来就没分层 ⇒ 剥层这一发无从下手（layer(utilities) 掉了）",
  ).toBe(true);
  const unlayered = product
    .replace(/@layer\s+utilities\s*\{/gu, "")
    .replace(/\}\s*$/gu, "");
  expect(
    unlayered.includes("tw\\:text-balance"),
    "剥层把 utility 一起弄没了，这一发就没在决斗",
  ).toBe(true);
  expect(unlayered).not.toContain("@layer utilities{");

  const got = await probe(page, fixture(unlayered));
  assertScale(got);
  // 浏览器现在认为这条规则【不在任何层里】。层归属这一发跟着变，才证明上一发量的是
  // 层语义，而不是我正则里那几个字节。
  expect(got.utilityLayers, "剥层后工具类仍在某个 @layer 里").toEqual([""]);
  expect(
    got.duel,
    `剥掉 @layer 后赢家没换（拿到 ${got.duel}）⇒ 上一发判据量的不是层语义`,
  ).toBe(UTIL);
});

/** 临时端口，跟 rich-editor / doc-layout 同一套探针。 */
async function availablePort(): Promise<number> {
  const net = await import("node:net");
  const p = net.createServer();
  await new Promise<void>((go, fail) => {
    p.once("error", fail);
    p.listen(0, "127.0.0.1", () => go());
  });
  const addr = p.address();
  if (addr === null || typeof addr === "string")
    throw new Error("临时 TCP 探针未分配端口");
  const port = addr.port;
  await new Promise<void>((go) => p.close(() => go()));
  return port;
}

test("真页面接线：dev-server 供出的 tw.css 在 group.html 里真的生效", async ({
  page,
}) => {
  // 前两发内联字节，量级律；这一发量【接线】：产物经 dev-server 以真 <link> 挂进真
  // group.html 之后，规则确实进了级联。少了这一发，「产物字节对」与「页面里类名不起
  // 作用」可以长期并存 —— MIME 认不出 .css、路径指错、link 漏挂，全是这个形状，而
  // 前两发（内联字节）与 tailwind-wiring（读源码文本）都看不见它。
  // 用真 HTTP 而不是 file:// + setContent：后者落在 about:blank 文档，解析得解 file://
  // 相对链接却【不加载】它，等于拿一个不存在的观测窗口判「生效」。
  requireUtility();
  const port = await availablePort();
  const web: ChildProcess = spawn(
    process.execPath,
    ["packages/web/dist/dev-server.js"],
    {
      cwd: REPO,
      env: {
        ...process.env,
        WEB_PORT: String(port),
        // 故意指到一个没监听的端口：这一发不打后端，也就绝不会把请求打到开发中的 hub 上。
        HUB_PORT: String(port + 1),
        ORG_TOKEN: "",
      },
      stdio: "pipe",
    },
  );
  try {
    await expect
      .poll(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/`)).ok;
        } catch {
          return false;
        }
      })
      .toBe(true);
    // commit 而不是 load：不等应用与后端的往返（后端被故意指到空端口，等它只会白等到
    // 240s 超时）。但 commit 时文档可能还没解析出 <body>，所以显式等 body —— head 里的
    // 样式表是渲染阻塞的，解析器能走到 body 就说明它们都已就位，这正是我要的观测窗口。
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
    await page.waitForSelector("body");
    const raw = await page.evaluate(`(() => {
      const p = document.createElement('p');
      p.id = 'probe';
      p.className = '${UTILITY}';
      document.body.append(p);
      const q = document.createElement('p');
      q.id = 'base';
      document.body.append(q);
      const val = (id) => getComputedStyle(document.getElementById(id)).getPropertyValue('${PROP}');
      return JSON.stringify({
        links: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => new URL(l.href).pathname),
        // styleSheets 比 link 少 = 有某张表根本没成为样式表（MIME 不对就是这个形状）。
        sheets: document.styleSheets.length,
        probe: val('probe'),
        base: val('base'),
      });
    })()`);
    const got = JSON.parse(raw as string) as {
      links: string[];
      sheets: number;
      probe: string;
      base: string;
    };
    expect(
      got.links.filter((l) => l === "/tw.css").length,
      `页面里 /tw.css 该恰好挂一次，实际：${got.links.join(" ")}`,
    ).toBe(1);
    expect(
      got.sheets,
      `有样式表没成为样式表（link ${got.links.length} 张、styleSheets ${got.sheets} 张）`,
    ).toBe(got.links.length);
    expect(
      got.links.indexOf("/tw.css"),
      `/tw.css 应挂在手写样式表之后，实际顺序：${got.links.join(" ")}`,
    ).toBeGreaterThan(got.links.indexOf("/group.css"));
    // 尺子：整页样式（group/admin/theme/vendor）都在场时，未挂 utility 的元素仍是
    // initial —— 否则下面那条「拿到 balance」可能只是某张手写表也写了 text-wrap。
    expect(
      got.base,
      `窗口不干净：手写样式里有 ${PROP} 规则（读到 ${got.base}）`,
    ).toBe(INITIAL);
    expect(
      got.probe,
      `页面里 ${UTILITY} 没生效（读到 ${got.probe}）⇒ 产物、MIME、路径或 link 有一处坏了`,
    ).toBe(UTIL);
  } finally {
    web.kill();
    await new Promise<void>((go) => {
      if (web.exitCode !== null) return go();
      web.once("exit", () => go());
    });
  }
});
