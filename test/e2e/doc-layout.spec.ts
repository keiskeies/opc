/**
 * 文档中心的排版门：一屏的高度归谁、正文的宽度归谁、段落之间的空白归谁、缩进从哪来。
 *
 * ── 这个文件为什么会存在 ────────────────────────────────────────
 * 症状说过两轮，两轮各拆出不同的根：
 *  · round368「文档中心很乱」：`.workspace` 是 grid 却只写 height，隐式行停在 auto，而 grid
 *    item 的 min-height 起始值是 auto ⇒ 内容超一屏时三栏跟着内容长（实测 #view 836→1408），
 *    滚的变成整个文档（documentElement 900→1472）；`.doc-page` 是 grid + `.page` 的
 *    min-height:100%，矮文档配高视口时 align-content 留 stretch 把余量摊进【行高】
 *    （实测 85/540/372 被拉成 164/619/451，底部本该剩的 237px 归 0）。
 *  · round370「表格打开就是条 550px 的横条，下面全是白」（用户截图）：上面那套把余量留给
 *    底部空白，产品要的是反过来 —— 正文宿主吃掉头部以下的全部高度、宽度按视口铺满。
 *    `.doc-page` 因此从 grid + align-content:start 改成 flex 列，并写 max-width:none；
 *    `.sheet-grid` 摘掉 max-height:550px。**这两条是有意翻掉的历史判据**，不是回归。
 *    round371 起表格换成 vendor/xspreadsheet 画布，量尺子的节点从 `.sheet-grid` 变成
 *    `.sheet-canvas`，判据本身（比 550 高、跟着视口宽走）没变。
 * 每根线各留一发判据：
 *  W1 `.workspace` 的 `grid-template-rows:minmax(0,1fr)`（容器归位，仍在）
 *  W2 `.doc-page` 是 flex 列 + 间隔只由 gap 决定 + 底部无余量（round370 翻向后新语义）
 *  W3 页内间距只认 gap 一处：基础 .doc-head 的 margin-bottom、基础 .card + .card 的
 *     margin-top 都不许叠在 gap 上。叠 card 的地方 round370 从 .doc-page 搬进了抽屉，
 *     那条覆盖跟着搬家（抽屉 gap 12 + margin 12 = 实测 24，就是搬家后新写那发抓回来的）。
 *  W4 反向：`.doc-page` 之外的路由仍守全站 `.page` 的 1540px 上限。文档页自己放开宽度是
 *     拍板过的；放开得过头（其他路由也跟着散）就是这一发要抓的。
 *  W5 大纲预览那棵树的缩进（`.tree-root` 归零：浏览器给 ul 的 40px 与圆点不算层级）
 *  W6 文档页铺满：正文宿主高度 = 视口 − 顶栏 − 头部 − 内边距；表格网格同一条尺子
 *  W7 左栏折叠只作用在【正在编辑文档】那一屏，收起后主区接管那一列，偏好跨刷新保留
 *  W8 关联区块在右侧抽屉里（不在正文流），且只有一份
 *
 * ── 判据形状：只量几何，不读源码、不比像素截图 ──────────────────
 * 全部取 `getBoundingClientRect` / `scrollHeight` / `clientHeight` / `getComputedStyle`
 * 的运行时结果，改类名、换实现都不会假红，把承重那行 CSS 删掉必红。
 * 判据按【内容/视口比例】分屏，比例错了窗口就消失：
 *  · 容器归位（W1）要内容 > 一屏 → 一批文档 + 一篇 120 段长文档，视口 900 高。
 *  · 间隔与余量（W2/W3a）要内容 < 一屏 → 一篇短文档，视口 1400 高。
 *  · 抽屉叠卡（W3b）要抽屉里真叠了不止一张卡 → 判据自己先数卡片张数与声明的 gap。
 *  · 铺满与列宽（W6）要视口明显大于旧的 1540/550 → 取用户那张截图 2240×1232。
 * 每发都带【窗口自证】：观测窗口不在位时（如 W2 的 viewSh > viewCh）直接失败并说明原因，
 * 而不是在「怎么改都量得一样」的窗口里报绿。
 * 反面教训两条：① W2 最初只用「相邻子项间距」判，剪掉 align-content 后 gap 仍 14
 * （stretch 摊行高不摊 gap），探针报 SURVIVED —— 判据看着在、其实没接上那根线；
 * ② W7 最初用 waitForSelector("#view .page") 等路由切换，`.page` 在文档页是 0 高，
 * 默认 state:"visible" 永不满足 ⇒ 挂满 240s。改成等导航项拿到 .active（setRoute 在
 * replaceState 之前就打上）。
 *
 * ── 不含哪几格 ──────────────────────────────────────────────────
 *  · 富文本引擎本身：rich-editor.spec.ts 的射程。
 *  · 树的折叠态/祖先强制展开：group-workbench.spec.ts 的文档树那条。
 *  · 抽屉压不压正文、贴哪条边：rich-editor.spec.ts ⑤。
 * 配套剪线探针两支（各打各的射程，别并成一支）：
 *  · .workbuddy/scratch/round368-layout-mutations.mjs（11 发）—— W1、W3a、W3b（已改打抽屉
 *    那一发）、W5、树叶子 L1/L2、尾号 Q/P、抽屉 D1/D2。round370 翻掉的 W2/W4 两发已从
 *    该脚本删除（from 不复存在，留着只会被当成脚本坏了而不是判据变了）。
 *  · .workbuddy/scratch/round370-fill-mutations.mjs（13 发）—— 铺满 F1~F4、表格 S1/S2、
 *    折叠 C1~C4、关联 A1/A2。
 * 两支 11 + 13 = 24 发全 KILLED、SHA 还原一致，见 .workbuddy/round368-layout-mutations.log、
 * .workbuddy/round370-fill-mutations.log。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { WriteQueue } from "../../packages/hub/src/db/write-queue.js";
import { InMemoryEventBus } from "../../packages/hub/src/events/bus.js";
import { buildHubDeps } from "../../packages/hub/src/http/real-deps.js";
import { serveHub } from "../../packages/hub/src/http/server.js";
import { DRIVER_OFF } from "../../packages/hub/test/fixtures/driver-state.js";

const ROOT = resolve(process.cwd());
const TOKEN = "doc-layout-e2e-token";
/** 顶栏高度【从页面量】而不是抄一份常数：这三栏的高度判据要钉的是
 *  「.workspace == 视口 − 顶栏」这一条【耦合关系】，不是某个具体像素。
 *  抄常数的写法（round379 前是 `const TOPBAR = 64`）有两个洞：
 *  ① 改 .topbar 高度会红一堆与本轮无关的用例，于是下一轮倾向于把常数改回去而不是改判据；
 *  ② 反过来 --topbar-height 与 .workspace 的 calc 各改一半时它照绿 —— 而那正是这条判据
 *    唯一该抓的病（两边各写一份字面 64，谁也没看住谁）。
 *  量出来之后两种都逃不掉：只改 calc 里的常数 ⇒ 量到的顶栏 ≠ calc 用的那个数 ⇒ 红；
 *  直接给 .topbar 另写高度 ⇒ 同一枚红。--topbar-height 单独调 ⇒ 两侧同步挪 ⇒ 绿，
 *  而这一条本来就不该由本文件管（判据是关系，不是数值）。 */
/** 左栏要溢出才看得出「它是自己滚」，所以按 900 高视口算出这个下限（实测每叶 32px）。 */
const SEED_DOC_COUNT = 26;
/** 主区那一侧的样本长度：120 段富文本实测把 #view 的内容撑到 5066px。 */
const LONG_PARAS = 120;
const DUP_GROUP_TITLE = "同名群排版验收";
const UNIQUE_GROUP_TITLE = "唯一名排版验收群";

let webPort = 0;
let directory = "";
let queue: WriteQueue | null = null;
let hub: Awaited<ReturnType<typeof serveHub>> | null = null;
let web: ChildProcess | null = null;
let api = "";
let shortDocId = "";
let longDocId = "";
let mindmapDocId = "";
let sheetDocId = "";
/** 行尾符不用字面量转义：这段样本要的是真换行，取码位比写反斜杠可靠。 */
const NL = String.fromCharCode(10);

async function availablePort(): Promise<number> {
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise<void>((go, fail) => {
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => go());
  });
  const addr = probe.address();
  if (addr === null || typeof addr === "string")
    throw new Error("临时 TCP 探针未分配端口");
  const port = addr.port;
  await new Promise<void>((go) => probe.close(() => go()));
  return port;
}

async function hubFetch(path: string, body: unknown) {
  const res = await fetch(`${api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/** 建文档必返 `{document:{doc_id}}`；这里只取那个 id。 */
function createdDocId(body: Record<string, unknown>): string {
  const doc = body["document"] as { doc_id?: string } | undefined;
  const docId = doc?.doc_id ?? "";
  expect(docId).toBeTruthy();
  return docId;
}

test.beforeAll(async () => {
  webPort = await availablePort();
  directory = mkdtempSync(join(tmpdir(), "opc-doc-layout-"));
  queue = new WriteQueue(join(directory, "hub.db"));
  migrate(queue.writeConnection());
  hub = await serveHub(
    buildHubDeps({
      queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      now: () => Date.now(),
      driverState: () => DRIVER_OFF,
      callModel: async () => ({ text: "排版验收不需要模型" }),
    }),
    { port: 0 },
  );
  web = spawn(process.execPath, ["packages/web/dist/dev-server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ORG_TOKEN: TOKEN,
      HUB_PORT: String(hub.port),
      WEB_PORT: String(webPort),
    },
    stdio: "pipe",
  });
  api = `http://127.0.0.1:${webPort}/api/v1`;
  await expect
    .poll(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${webPort}/`)).ok;
      } catch {
        return false;
      }
    })
    .toBe(true);

  // 两个同名群 + 一个唯一名群。建群会自动沉淀一篇立项章程，所以每个群天然在树上有个分支。
  // 同名不是构造出来的刁钻数据 —— 开发库里「双十一大促落地页」就真有两个 group_id。
  const dupIds: string[] = [];
  for (const title of [DUP_GROUP_TITLE, DUP_GROUP_TITLE, UNIQUE_GROUP_TITLE]) {
    const created = await hubFetch("/groups", {
      title,
      goal: `排版验收：${title}`,
    });
    const group = created["group"] as { group_id?: string } | undefined;
    expect(group?.group_id ?? "").toBeTruthy();
    if (title === DUP_GROUP_TITLE) dupIds.push(String(group?.group_id));
  }
  expect(dupIds[0]).not.toBe(dupIds[1]);
  // 一批未分组文档：把左栏顶出「一屏装不下」，W1 才有观测窗口。
  for (let i = 0; i < SEED_DOC_COUNT; i += 1) {
    await hubFetch("/documents", {
      kind: "markdown",
      title: `排版验收文档 ${String(i).padStart(2, "0")}`,
      body_text: "# 排版验收文档\n\n只占一屏的一小段。",
      watermark_profile: i % 5 === 0 ? "internal" : "none",
    });
  }
  // 主区这一侧的观测样本：120 段富文本长文档。用 kind:"doc" 而不是 markdown，因为
  // markdown 的正文宿主是固定 470px 高的 textarea（实测整页 1099px，比左栏的 1247 还矮），
  // 那种样本里「最高的一栏」始终是左栏 —— 第二发用例就和第一发共用同一根线了。
  // 富文本宿主按内容长（实测 .editor-card 4507px、#view 内容 5066px），主区才是驱动方。
  const long = await hubFetch("/documents", {
    kind: "doc",
    title: "排版验收长文档",
    body_text: Array.from(
      { length: LONG_PARAS },
      (_, i) => `<p>第 ${i} 段正文，够长才撑得起来。</p>`,
    ).join(""),
    watermark_profile: "none",
  });
  longDocId = createdDocId(long);
  // W2/W3 的观测样本：一篇正文极短、关联也极少的文档（内容不足一屏才有余量可摊）。
  const short = await hubFetch("/documents", {
    kind: "markdown",
    title: "排版验收短文档",
    body_text: "# 短\n\n一行。",
    watermark_profile: "none",
  });
  shortDocId = createdDocId(short);
  // 大纲预览那一发的样本：三层缩进各一个节点（outlineTree 按行首空格数分层，
  // 三个节点三层才够同时判「第一层不多吃 40px」和「每层还留着层级线」两头）。
  const mindmap = await hubFetch("/documents", {
    kind: "mindmap",
    title: "排版验收大纲图",
    body_text: ["顶层", "  中层", "    底层"].join(NL),
    watermark_profile: "none",
  });
  mindmapDocId = createdDocId(mindmap);
  // 表格那一发的样本：`{sheets:[{name,rows}]}` 是 hub 侧 formats.ts 认的正文形状，
  // 前端 parseSheetRows 会把每行补齐到至少 3 列 —— 3×3 够渲染出网格，够量它的盒子。
  const sheet = await hubFetch("/documents", {
    kind: "sheet",
    title: "排版验收表格",
    body_text: JSON.stringify({
      sheets: [
        {
          name: "Sheet1",
          rows: [
            ["甲", "乙", "丙"],
            ["1", "2", "3"],
            ["4", "5", "6"],
          ],
        },
      ],
    }),
    watermark_profile: "none",
  });
  sheetDocId = createdDocId(sheet);
});

test.afterAll(async () => {
  if (web !== null) {
    web.kill();
    await new Promise<void>((go) => {
      if (web === null || web.exitCode !== null) return go();
      web.once("exit", () => go());
    });
  }
  if (hub !== null) await hub.close();
  if (queue !== null) await queue.close();
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

interface Boxes {
  innerH: number;
  docScrollH: number;
  /** 顶栏【实测】高：判据拿它当「视口 − 顶栏」的那一半（不抄常数，理由见文件头那段）。 */
  topbarH: number;
  workspace: { h: number; sh: number; ch: number };
  view: { h: number; sh: number; ch: number };
  listPane: { h: number; sh: number; ch: number };
  listContent: { h: number; sh: number; ch: number };
}

/** 「打开即铺满」那一屏的读数：主区、文档页、表头与正文宿主。 */
interface FillGeometry {
  innerH: number;
  /** 顶栏【实测】高：与 Boxes 上那格同理由，判据不抄常数（见文件头）。 */
  topbarH: number;
  view: { t: number; b: number; l: number; r: number; w: number; h: number };
  viewScroll: { sh: number; ch: number };
  page: { t: number; b: number; l: number; r: number; w: number; h: number };
  head: { t: number; b: number; l: number; r: number; w: number; h: number };
  card: { t: number; b: number; l: number; r: number; w: number; h: number };
  cardFlex: string;
  padBottom: number;
  viewOverflowY: string;
  pages: number;
  assocTotal: number;
  assocInDrawer: number;
  innerH_: number;
  innerFlex: string;
  leafH: number;
}

/** 左栏折叠那一屏的读数。 */
interface CollapseGeometry {
  list: { l: number; w: number };
  main: { l: number; w: number };
  toggleExpanded: string;
  toggleW: number;
  toggleH: number;
  collapsedClass: boolean;
  listVisible: string;
}

/** 量三栏容器 + 视口：全部走真实布局结果，不读 CSS 声明值。 */
async function measureBoxes(page: Page): Promise<Boxes> {
  const raw = await page.evaluate(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('缺少节点：' + sel);
      return {
        h: Math.round(el.getBoundingClientRect().height),
        sh: el.scrollHeight,
        ch: el.clientHeight,
      };
    };
    return JSON.stringify({
      innerH: window.innerHeight,
      docScrollH: document.documentElement.scrollHeight,
      topbarH: pick(".topbar").h,
      workspace: pick('.workspace'),
      view: pick('#view'),
      listPane: pick('#listPane'),
      listContent: pick('#listContent'),
    });
  })()`);
  return JSON.parse(raw as string) as Boxes;
}

async function openDocumentsHome(page: Page) {
  await page.goto(`http://127.0.0.1:${webPort}/`, {
    waitUntil: "load",
  });
  await page.locator('[data-nav="documents"]').click();
  await page.waitForSelector("#listContent .doc-tree");
}

test.describe("文档中心：一屏的高度归谁（内容超过一屏）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("左树溢出时自己滚，整页不跟着长高", async ({ page }) => {
    await openDocumentsHome(page);
    const m = await measureBoxes(page);
    // 判据窗口先自证：树确实装不下。装得下时下面几条是恒真的空判据。
    expect(
      m.listContent.sh,
      `左栏没溢出（sh=${m.listContent.sh} ch=${m.listContent.ch}）⇒ 造的数据不够，判据窗口消失`,
    ).toBeGreaterThan(m.listContent.ch);

    // W1：`.workspace` 的隐式行必须是 minmax(0,1fr)，不能留默认的 auto。
    // 实测：行停在 auto 时 grid item 的 min-height:auto 让 #view 与 #listPane 长到 1341px，
    // #listContent 的 ch 从 676 变 1181（= 它自己的内容高）—— 盒子从「装内容」变成「溢出」
    // 的一方，滚的不再是栏内而是整个文档（documentElement 从 900 变 1405）。
    // `.workspace` 自己带 height:calc(100vh - var(--topbar-height))，量它的 rect 永远等于视口减顶栏，那一格写
    // 什么判据都不会红，所以这里量它的三个 item 和 documentElement。
    const ceiling = m.innerH - m.topbarH;
    expect(
      m.docScrollH,
      `整页滚动高 ${m.docScrollH} > 视口 ${m.innerH} ⇒ 滚的是页面而不是栏内`,
    ).toBeLessThanOrEqual(m.innerH);
    expect(
      m.view.ch,
      `#view 客户端高 ${m.view.ch} 超过 ${ceiling} ⇒ 主区不是视口高`,
    ).toBeLessThanOrEqual(ceiling);
    // 等号那一半：主区与左栏就是工作区那一行，既不塌成 0 也不溢出。
    expect(m.view.ch).toBe(m.workspace.ch);
    expect(m.listPane.ch).toBe(m.workspace.ch);
    expect(m.listContent.ch).toBeLessThanOrEqual(ceiling);
    // 溢出留在盒子里：#listContent 仍在自己框内滚（auto 时 ch 追平 sh，这条同样红）。
    expect(m.listContent.ch).toBeLessThan(m.listContent.sh);
  });

  test("正文超过一屏时滚的是主区，不是整页", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${longDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收长文档");
    const m = await measureBoxes(page);
    const ceiling = m.innerH - m.topbarH;
    // 同一个 W1 从主区这一侧看：120 段正文（#view 内容 5066px）在 auto 下把 #view 顶到
    // 1408、整页滚到 1472；minmax(0,1fr) 下 #view 保持 836，多出来的四千多像素由 .view 自己滚。
    // 用富文本而不是 markdown 造这一屏：markdown 宿主是固定高的 textarea，那一屏里最高的
    // 仍是左栏，这条用例就退化成上一发的副本，剪掉 W1 之外的那根线谁都不会红。
    expect(m.view.sh, "正文没超出主区 ⇒ 这一发的观测窗口消失").toBeGreaterThan(
      m.view.ch,
    );
    expect(m.view.ch).toBeLessThanOrEqual(ceiling);
    expect(m.docScrollH).toBeLessThanOrEqual(m.innerH);
  });

  test("树上的叶子一行一条，作者与日期挪进悬停提示", async ({ page }) => {
    await openDocumentsHome(page);
    const raw = await page.evaluate(`JSON.stringify([
      ...document.querySelectorAll("#listContent .doc-tree .doc-list-item"),
    ].map((el) => ({
      h: Math.round(el.getBoundingClientRect().height),
      blocks: el.querySelectorAll("h3, p").length,
      hasTitle: (el.querySelector("h3")?.textContent || "").trim().length > 0,
      tip: el.getAttribute("title") || "",
    })))`);
    const leaves = JSON.parse(raw as string) as {
      h: number;
      blocks: number;
      hasTitle: boolean;
      tip: string;
    }[];
    expect(leaves.length).toBeGreaterThan(SEED_DOC_COUNT);
    // 32px 实测值 + 余量：一旦有人把副行（作者·日期）加回来，行高立刻翻到 59~86，
    // 28 篇就是 2226px 的树 —— 那正是「很乱」里最占地方的一条。
    for (const leaf of leaves) {
      expect(leaf.blocks, `叶子还剩 ${leaf.blocks} 个块：${leaf.tip}`).toBe(1);
      expect(leaf.hasTitle).toBe(true);
      expect(leaf.h, `叶子高 ${leaf.h}px`).toBeLessThanOrEqual(36);
      // 信息没被删掉，只是换了位置：正文页头 .doc-sub 本来就写着这一串。
      expect(leaf.tip, "作者与日期要还能拿到（title）").toContain("·");
    }
  });

  test("重名的两个群各自带 ID 尾号，唯一名不加噪音", async ({ page }) => {
    await openDocumentsHome(page);
    const raw = await page.evaluate(`JSON.stringify([
      ...document.querySelectorAll("#listContent .doc-tree-group"),
    ].map((g) => ({
      label: g.querySelector(":scope > summary .doc-tree-label")?.textContent || "",
      tag: g.querySelector(":scope > summary .doc-tree-tag")?.textContent || "",
    })))`);
    const rows = JSON.parse(raw as string) as { label: string; tag: string }[];
    const dup = rows.filter((r) => r.label === DUP_GROUP_TITLE);
    expect(dup).toHaveLength(2);
    // 两行一模一样的字在树上看起来就是渲染坏了。悬停提示在截图里永远看不见，
    // 所以撞名时尾号必须【画出来】。
    expect(dup[0]?.tag, "第一个同名群没有尾号").toBeTruthy();
    expect(dup[1]?.tag, "第二个同名群没有尾号").toBeTruthy();
    expect(dup[0]?.tag).not.toBe(dup[1]?.tag);
    // 反向那一半：没撞名的群不许带尾号（按 group_id 而不是显示名统计的话，
    // 这格会一起红 —— 尾号会挂在每一个群上，唯一名的树也跟着脏）。
    const unique = rows.filter((r) => r.label === UNIQUE_GROUP_TITLE);
    expect(unique).toHaveLength(1);
    expect(unique[0]?.tag, "唯一名的群不该挂尾号").toBe("");
  });
});

test.describe("文档中心：段落之间的空白归谁（内容不足一屏）", () => {
  test.use({ viewport: { width: 1440, height: 1400 } });

  test("矮文档配高视口时，间隔只由 gap 决定，余量整块交给正文宿主", async ({
    page,
  }) => {
    // 直接走 hash 深链：boot() 会 setRoute + openDocument，比在树里滚到那一行再点稳。
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${shortDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收短文档");
    const raw = await page.evaluate(`(() => {
      const pageEl = document.querySelector(".doc-page");
      if (!pageEl) throw new Error("没有 .doc-page");
      const view = document.querySelector("#view");
      if (!view) throw new Error("没有 #view");
      const kids = [...pageEl.children].map((c) => c.getBoundingClientRect());
      return JSON.stringify({
        display: getComputedStyle(pageEl).display,
        gapDeclared: parseFloat(getComputedStyle(pageEl).rowGap) || 0,
        viewSh: view.scrollHeight,
        viewCh: view.clientHeight,
        gaps: kids.slice(1).map((r, i) => Math.round(r.top - kids[i].bottom)),
        heights: kids.map((r) => Math.round(r.height)),
        slack: Math.round(
          pageEl.getBoundingClientRect().bottom -
            parseFloat(getComputedStyle(pageEl).paddingBottom) -
            kids[kids.length - 1].bottom,
        ),
      });
    })()`);
    const m = JSON.parse(raw as string) as {
      display: string;
      gapDeclared: number;
      viewSh: number;
      viewCh: number;
      gaps: number[];
      heights: number[];
      slack: number;
    };
    // 窗口自证：这一屏确实有剩余空间。没有剩余空间时余量归谁都量得一样，那种绿是假绿。
    expect(
      m.viewSh,
      `正文已超出视口（sh=${m.viewSh} ch=${m.viewCh}）⇒ 观测窗口消失，先缩短样本再谈这格`,
    ).toBeLessThanOrEqual(m.viewCh);
    // W3：gap 之外不许再叠旧的 margin —— 实测声明 gap:14px 却量到 30（.doc-head 的
    // margin-bottom:16）和 26（.card+.card 的 margin-top:12），两处各写一半，
    // 谁看代码都觉得没错。
    // ⚠ 这里不比字面 14：round377 把 .doc-page 的 gap 折进 --space-3（14 不在
    //   4/8/12/16/20/24/32 那一档上），钉死数值判的是一时取值、不是「间隔只由 gap 决定」。
    //   尺子换成同文件 .doc-drawer-body 那一发（:876）已用的口径：先自证 gap 真声明了
    //   （否则下面 for 比的是 0，margin 叠上来照样「等于」），再让实测间隔【等于声明值】。
    expect(
      m.gapDeclared,
      ".doc-page 没声明 gap ⇒ 这一发的尺子不存在，先回去看那行 CSS",
    ).toBeGreaterThan(0);
    for (const gap of m.gaps) expect(gap).toBe(m.gapDeclared);
    // W2（round370 翻向）：`.doc-page` 从 grid + align-content:start 改成了 flex 列。
    // 旧判据是「最后一个块下面剩 ≥60px 余量」，新语义下那句话反了 —— 正文宿主就是
    // 被 flex 拉长去吃余量的那一个，底部余量归 0 才对。这里断的是【间隔没被拉长】：
    // 旧的 stretch 把 237px 摊进【行高】（gap 恒 14 抓不到），而 flex 下若谁写了
    // justify-content:space-between/space-around，间隔就会随视口长 —— 症状一模一样。
    // 所以尺子换成分配本身：间隔恒等 gap，余量全部落在正文宿主的高度里（下一发用例量它）。
    expect(
      m.display,
      `.doc-page 的 display 是 ${m.display}，不再是 flex 列`,
    ).toBe("flex");
    const maxGap = Math.max(...m.gaps);
    const minGap = Math.min(...m.gaps);
    expect(maxGap - minGap, `间隔被摊开了：${JSON.stringify(m.gaps)}`).toBe(0);
    expect(
      m.slack,
      `底部还剩 ${m.slack}px ⇒ 余量没交给正文，宿主又开始贴内容`,
    ).toBeLessThanOrEqual(2);
    // 同一根线最显眼的那一格：表头自己是内容高，不参与摊派（实测 85，被拉时 164）。
    expect(
      m.heights[0],
      `.doc-head 高 ${m.heights[0]}，被拉伸了`,
    ).toBeLessThanOrEqual(120);
  });
});

test.describe("文档中心：正文吃掉整屏（打开即铺满）", () => {
  // 2240×1232 = 用户那张截图。这一屏同时是 W4（列宽归谁）和 W6（高度归谁）的观测窗口：
  // 视口比旧的 1540 列宽一大截，比旧的 550px 表格条高一倍。
  test.use({ viewport: { width: 2240, height: 1232 } });

  test("文档页铺满主区，正文宿主吃掉头部以下的全部高度", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${shortDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收短文档");
    const raw = await page.evaluate(`(() => {
      const r = (el) => {
        const b = el.getBoundingClientRect();
        return { t: Math.round(b.top), b: Math.round(b.bottom), l: Math.round(b.left), r: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('缺少节点：' + sel);
        return el;
      };
      const view = pick('#view');
      const pageEl = pick('.doc-page');
      const card = pick('.editor-card');
      const head = pick('.doc-page > .doc-head');
      // .editor-surface 是外层宿主，kind-* 那个 flex 列才是【内层编辑器】的直接父级；
      // 内层编辑器（textarea / .sheet-editor）自己那一格在下面单独量。
      const inner = pick('.editor-surface.kind-markdown, .editor-surface.kind-sheet');
      const leaf = pick('.markdown-editor, .sheet-editor');
      return JSON.stringify({
        innerH: window.innerHeight,
        topbarH: r(pick(".topbar")).h,
        view: r(view),
        viewScroll: { sh: view.scrollHeight, ch: view.clientHeight },
        page: r(pageEl),
        head: r(head),
        card: r(card),
        cardFlex: getComputedStyle(card).flex,
        padBottom: parseFloat(getComputedStyle(pageEl).paddingBottom),
        viewOverflowY: getComputedStyle(view).overflowY,
        pages: document.querySelectorAll('.doc-page').length,
        assocTotal: document.querySelectorAll('.document-associations').length,
        assocInDrawer: document.querySelectorAll(
          '#mainPane .doc-drawer-wrap .document-associations',
        ).length,
        innerH_: r(inner).h,
        innerFlex: getComputedStyle(inner).flex,
        leafH: r(leaf).h,
      });
    })()`);
    const m = JSON.parse(raw as string) as FillGeometry;
    expect(
      m.view.h,
      `主区高 ${m.view.h} ≠ 视口 − 顶栏 ⇒ W1 那根线（minmax(0,1fr)）先漂了，这一发的窗口没了`,
    ).toBe(m.innerH - m.topbarH);
    // 判据窗口先自证：矮文档确实装不满这一屏 —— 没有余量时「铺满」与「贴内容」量得一样。
    expect(
      m.viewScroll.sh,
      `正文已撑到 ${m.viewScroll.sh} ≥ 主区 ${m.viewScroll.ch} ⇒ 没有余量可让，窗口消失`,
    ).toBeLessThanOrEqual(m.viewScroll.ch);
    // W4：文档页跟主区同宽。旧的 `.page` 1540 上限 + margin:0 auto 在这里量到 1540 且
    // 两侧各留 156 空白；剪法就是删掉 `.doc-page { max-width:none }`（同权重靠文件序压过 .page）。
    expect(
      m.page.w,
      `文档页宽 ${m.page.w} ≠ 主区 ${m.view.w} ⇒ 文档页又被某个上限收走了`,
    ).toBe(m.view.w);
    // 反向那一半（别的路由仍守 1540）在下一发用例，别在这儿顺手放宽。
    // W6：正文宿主顶到主区下内边距那一圈，底部不留可滚的空白。
    // 旧的固定高条（富文本 470 / 表格 550）在这里量到的是「头 + 一条 + 一大片空白」。
    expect(
      Math.abs(m.card.b - (m.view.b - m.padBottom)),
      `正文宿主底边离主区下内边距差 ${Math.abs(m.card.b - (m.view.b - m.padBottom))}px ⇒ 高度没交给正文`,
    ).toBeLessThanOrEqual(2);
    expect(
      m.card.h,
      `正文宿主只高 ${m.card.h} ⇒ 又退回固定高的条了`,
    ).toBeGreaterThan(800);
    // 宿主是被 flex 撑起来的，不是靠内容自己长：flex 归 normal 时它塌回内容高。
    expect(m.cardFlex, `.editor-card 的 flex 是 "${m.cardFlex}"`).toMatch(
      /^1 1 /u,
    );
    // 表头不参与摊派（内容高），否则「铺满」会变成「表头被拉长两倍」。
    expect(m.head.h, `表头高 ${m.head.h} ⇒ 它也吃了余量`).toBeLessThanOrEqual(
      120,
    );
    expect(m.viewOverflowY).toBe("auto");
    // 反面那一半：`.doc-page` 与 `.page` 只差 max-width / padding，同权重靠文件序决胜
    // （.doc-page 必须排在 .page 之后）。若渲染出两页，那一条读的是【另一页】的规则，
    // 上面所有数字都不可信 —— 所以先钉「只有一页」。
    expect(m.pages, `渲染出 ${m.pages} 个 .doc-page`).toBe(1);
    // 关联只有一份，且在抽屉里（round370 用户拍板：权限/设置 + 关联全部进抽屉）。
    // 两处各挂一份 = 改了没反应；一份都不剩 = 那一半需求没落地。两种都用计数钉，
    // 不用「文本还在不在」—— 双份时文本也还在。
    expect(m.assocTotal, `关联区块渲染了 ${m.assocTotal} 份`).toBe(1);
    expect(
      m.assocInDrawer,
      `抽屉里的关联区块是 ${m.assocInDrawer} 份 ⇒ 它没搬进抽屉`,
    ).toBe(1);
    // 内层编辑器跟着外层宿主走：kind-* 那一条 flex 归 normal 时，宿主被 flex 撑到
    // 1000 而内层只有内容高（textarea 实测 470）—— 卡片是满了，字还是只有那么几行，
    // 「打开即铺满」没落地。判据用比例：内层至少吃掉宿主的六成（余量归头部/工具条）。
    expect(
      m.innerFlex,
      `.editor-surface.kind-* 的 flex 是 "${m.innerFlex}"`,
    ).toMatch(/^1 1 /u);
    expect(
      m.leafH,
      `内层编辑器只有 ${m.leafH} 高（外层宿主 ${m.innerH_}）⇒ 铺满停在外层，没进编辑器`,
    ).toBeGreaterThan(Math.round(m.innerH_ * 0.6));
  });

  test("表格文档的画布同样铺满，不再退回那条 550px 的横条", async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${sheetDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收表格");
    const raw = await page.evaluate(`(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error('缺少节点：' + sel);
        const b = el.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), t: Math.round(b.top), b: Math.round(b.bottom) };
      };
      const view = document.querySelector('#view');
      if (!view) throw new Error('没有 #view');
      return JSON.stringify({
        viewW: Math.round(view.getBoundingClientRect().width),
        viewH: Math.round(view.getBoundingClientRect().height),
        canvas: pick('.sheet-canvas'),
        editor: pick('.sheet-editor'),
      });
    })()`);
    const m = JSON.parse(raw as string) as {
      viewW: number;
      viewH: number;
      canvas: { w: number; h: number; t: number; b: number };
      editor: { w: number; h: number; t: number; b: number };
    };
    // 窗口自证：主区比旧上限宽、比旧条高，否则这两条是恒真的空判据。
    expect(
      m.viewW,
      `主区只有 ${m.viewW} ⇒ 宽度那一半没有观测窗口`,
    ).toBeGreaterThan(1600);
    expect(
      m.viewH,
      `主区只有 ${m.viewH} ⇒ 高度那一半没有观测窗口`,
    ).toBeGreaterThan(700);
    // 550 是这一发唯一的旧读数（自研网格一度写 max-height:550px）。
    // 留 50px 余量：既咬得住「把 550 加回来」，也不咬视口高度的小改。
    expect(
      m.canvas.h,
      `表格画布只高 ${m.canvas.h} ⇒ 550 那条上限又回来了`,
    ).toBeGreaterThan(600);
    expect(m.canvas.w, "表格画布没跟着列宽走").toBeGreaterThan(1600);
    expect(
      m.editor.h,
      `.sheet-editor 高 ${m.editor.h} 没接住画布 ⇒ 链路中间断了一环`,
    ).toBeGreaterThanOrEqual(m.canvas.h);
  });

  test("文档页之外其余路由仍守 .page 的 1540px 上限（反向判据）", async ({
    page,
  }) => {
    // W4 从「文档页也守上限」翻成「文档页不守上限」之后，这一发补上被翻掉的那一半：
    // 只许文档路由摊宽，别的页面一旦跟着 max-width:none 一起跑掉，这里红。
    // chat / dashboard 都不是这个应用的路由：冷加载 #/chat 只是停在启动屏，量到的是
    // 首屏那块 .page —— 判据窗口是假的。所以用 routes 里真有的四项 + 真点导航。
    await page.goto(`http://127.0.0.1:${webPort}/`, {
      waitUntil: "load",
    });
    for (const route of ["backlog", "contacts", "talent", "messages"]) {
      await page.locator(`[data-nav="${route}"]`).click();
      // 等的是「路由真的换过去了」：setRoute 先把 .active 贴到导航项、
      // 再 replaceState + renderMain，所以这个断言成立时主区已经重渲完。
      // 不用 waitForSelector("#view .page")：那一格内容空时高 0，而它默认要 visible，
      // 会一路干等到 240s 执行超时（本轮实撞过一次）。节点真缺了下面自己会抛。
      await expect(page.locator(`[data-nav="${route}"]`)).toHaveClass(
        /\bactive\b/u,
      );
      const raw = await page.evaluate(`(() => {
        const el = document.querySelector('#view .page');
        if (!el) throw new Error('该路由没有 #view .page');
        return JSON.stringify({
          w: Math.round(el.getBoundingClientRect().width),
          maxW: getComputedStyle(el).maxWidth,
        });
      })()`);
      const m = JSON.parse(raw as string) as { w: number; maxW: string };
      expect(m.maxW, `${route} 的 max-width 变成 ${m.maxW}`).toBe("1540px");
      expect(m.w, `${route} 的列宽 ${m.w} 突破了 1540`).toBeLessThanOrEqual(
        1540,
      );
    }
  });

  test("左栏折叠只作用在文档编辑屏，收起后主区接管那一列", async ({ page }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${shortDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收短文档");
    const measure = async () => {
      const raw = await page.evaluate(`(() => {
        const pick = (sel) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error('缺少节点：' + sel);
          const b = el.getBoundingClientRect();
          return { l: Math.round(b.left), w: Math.round(b.width) };
        };
        const toggle = document.querySelector('#docListToggle');
        // 把手只长在文档编辑屏上；非文档路由没它也要能量左栏（误伤那一半在别处量）。
        const box = toggle ? toggle.getBoundingClientRect() : null;
        return JSON.stringify({
          list: pick('#listPane'),
          main: pick('#mainPane'),
          toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') || '' : '',
          toggleW: box ? Math.round(box.width) : 0,
          toggleH: box ? Math.round(box.height) : 0,
          collapsedClass: document.querySelector('.workspace').classList.contains('list-collapsed'),
          listVisible: getComputedStyle(document.querySelector('#listPane')).visibility,
        });
      })()`);
      return JSON.parse(raw as string) as CollapseGeometry;
    };
    const before = await measure();
    // 窗口自证：默认态左栏占着一列，折叠才有东西可让。
    expect(
      before.list.w,
      `左栏默认就只有 ${before.list.w}px ⇒ 折叠没有可让的宽度，窗口消失`,
    ).toBeGreaterThan(150);
    expect(before.toggleExpanded, "默认态 toggle 没声明展开").toBe("true");
    expect(before.collapsedClass).toBe(false);

    await page.locator("#docListToggle").click();
    const during = await measure();
    // 那一列是真的没了（--list-width:0），不是靠 visibility 藏起来还占着 306px。
    expect(during.list.w, `折叠后左栏仍占 ${during.list.w}px`).toBe(0);
    expect(
      during.listVisible,
      `折叠后左栏 visibility=${during.listVisible}`,
    ).toBe("hidden");
    expect(during.collapsedClass).toBe(true);
    expect(during.toggleExpanded, "折叠后 aria-expanded 没翻").toBe("false");
    // 展开的把手留在正文这一侧：把手长在收起的栏里 = 折叠之后没人能再点开。
    expect(during.main.l, "折叠后主区没接管那一列").toBeLessThanOrEqual(
      before.list.l,
    );
    expect(during.main.w).toBeGreaterThan(before.main.w + 150);
    expect(during.toggleW).toBeGreaterThan(10);
    expect(during.toggleH).toBeGreaterThan(10);

    // 偏好活过刷新：收起状态是写给用户的，不是写给这一次渲染的。
    // 顺序要紧：展开之后再刷新，写回的就是 false，那一格量的就不是「偏好丢没丢」了。
    await page.reload({ waitUntil: "load" });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收短文档");
    const afterReload = await measure();
    expect(afterReload.collapsedClass, "刷新后折叠偏好丢了").toBe(true);
    expect(afterReload.list.w).toBe(0);

    // 再点一次展开：那一列回来而且重新可见（visibility 常驻 hidden 的话只有这里红）。
    await page.locator("#docListToggle").click();
    const expanded = await measure();
    expect(expanded.list.w, "展开后左栏没回位").toBe(before.list.w);
    expect(
      expanded.listVisible,
      `展开后左栏 visibility=${expanded.listVisible}`,
    ).toBe("visible");
    expect(expanded.collapsedClass).toBe(false);

    // 反向那一半：折叠偏好开着的时候，非文档路由的列表栏不许被一起收起 ——
    // 聊天/通讯录/待办用的是同一个 .workspace，误伤是这一根线最容易造出的事故。
    await page.locator('[data-nav="backlog"]').click();
    await page.waitForSelector("#view .page");
    const other = await measure();
    expect(
      other.collapsedClass,
      "折叠偏好泄漏到了非文档路由 ⇒ 判定条件不再只看 route + 选中项",
    ).toBe(false);
    expect(other.list.w, "非文档路由的左栏被折叠误伤").toBeGreaterThan(150);
  });

  // 关联搬进抽屉之后，「页内间距只认 gap 一处」那根线搬家了：抽屉正文里叠了 4 张 .card
  // （关联 / 元数据 / 版本历史 / 权限），基础 `.card + .card` 的 margin-top:12 与
  // .doc-drawer-body 自己的 gap 叠在一起就是 24 —— round368 在正文里修掉的病，被这次
  // 搬家原样搬进了抽屉。尺子用【声明的 gap】量【实测间隔】，所以它测的是「叠加没叠加」，
  // 不是「等于 14」这个数：将来把 gap 改成别的值，判据跟着走，不会变成要顺手改的常数。
  test("抽屉里那几张贴在一起：间隔只由声明的 gap 决定，旧的 card margin 不再叠加", async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${shortDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收短文档");
    await page.getByRole("button", { name: "权限与设置", exact: true }).click();
    const raw = await page.evaluate(`(() => {
      const body = document.querySelector(".doc-drawer-body");
      if (!body) throw new Error("没有 .doc-drawer-body");
      const cards = [...body.children].filter((c) => c.classList.contains("card"));
      const boxes = cards.map((c) => c.getBoundingClientRect());
      return JSON.stringify({
        n: cards.length,
        gapDeclared: parseFloat(getComputedStyle(body).columnGap) || 0,
        gaps: boxes.slice(1).map((b, i) => Math.round(b.top - boxes[i].bottom)),
        ownMargins: cards.map((c) =>
          Math.round(parseFloat(getComputedStyle(c).marginTop)),
        ),
      });
    })()`);
    const m = JSON.parse(raw as string) as {
      n: number;
      gapDeclared: number;
      gaps: number[];
      ownMargins: number[];
    };
    // 判据窗口先自证：抽屉里真叠了不止一张卡，而且那个 gap 真的声明了。只剩一张卡时
    // 「间隔」这个概念不存在，下面那条 for 一次都不跑 ⇒ 绿得毫无内容。
    expect(
      m.gapDeclared,
      ".doc-drawer-body 没声明 gap ⇒ 这一发的尺子不存在，先回去看那行 CSS",
    ).toBeGreaterThan(0);
    expect(m.n, `抽屉里只有 ${m.n} 张卡片，叠不出间隔`).toBeGreaterThan(1);
    for (const [i, gap] of m.gaps.entries())
      expect(
        gap,
        `第 ${i + 1} 处实测间隔 ${gap}，声明的 gap 只有 ${m.gapDeclared} ⇒ margin 叠上来了（各卡 margin-top：${m.ownMargins.join("/")}）`,
      ).toBe(m.gapDeclared);
    // 反向那一半：不许为了抹平间隔把卡片上边距写成负数，让内容互相压住。
    for (const mt of m.ownMargins)
      expect(
        mt,
        `卡片 margin-top=${mt} 为负 ⇒ 靠重叠抹的间隔`,
      ).toBeGreaterThanOrEqual(0);
  });
});

test.describe("文档中心：大纲预览那棵树的缩进（思维导图）", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("大纲预览那棵树的缩进来自层级线，浏览器的 40px 与项目符号不掺进来", async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${mindmapDocId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue("排版验收大纲图");
    // 先切到「预览」再量：这一发证的是【预览面那棵树】的缩进，而正文默认停在「大纲」
    // （打开即编辑），预览面此时 display:none ⇒ 所有 rect 读 0。0 宽的盒子既证不了缩进
    // 来自层级线，也证不了浏览器那 40px 没回来 —— 量之前先让被量的东西真的排一次版。
    await page
      .getByRole("group", { name: "正文视图" })
      .getByRole("button", { name: "预览", exact: true })
      .click();
    await expect(page.locator(".mindmap-preview")).toBeVisible();
    const raw = await page.evaluate(`(() => {
      const preview = document.querySelector('.mindmap-preview');
      if (!preview) throw new Error('没有 .mindmap-preview ⇒ mindmap 的预览宿主没渲染');
      const root = preview.querySelector('.tree-root');
      if (!root) throw new Error('没有 .tree-root ⇒ outlineTree() 没产出树');
      const cs = getComputedStyle(preview);
      return JSON.stringify({
        nodes: preview.querySelectorAll('.tree-node').length,
        previewW: Math.round(preview.getBoundingClientRect().width),
        contentLeft: Math.round(
          preview.getBoundingClientRect().left + parseFloat(cs.paddingLeft),
        ),
        rootListStyle: getComputedStyle(root).listStyleType,
        liListStyle: getComputedStyle(preview.querySelector('.tree-node')).listStyleType,
        labelLefts: [...preview.querySelectorAll('.tree-label')].map((el) =>
          Math.round(el.getBoundingClientRect().left),
        ),
      });
    })()`);
    const m = JSON.parse(raw as string) as {
      nodes: number;
      previewW: number;
      contentLeft: number;
      rootListStyle: string;
      liListStyle: string;
      labelLefts: number[];
    };
    expect(m.nodes, "三层大纲样本没建出来 ⇒ 这一发的观测窗口消失").toBe(3);
    // 判据窗口自证：0 宽的预览面里所有 left 都相等，下面两条会「绿得毫无内容」。
    expect(
      m.previewW,
      "预览面宽 0 ⇒ 这一发量的是一棵没排版的树，缩进结论无效",
    ).toBeGreaterThan(0);
    // 圆点：层级已经由 .tree-children 的左 border 在画，行首再摆一个点是把同一件事说两遍。
    // list-style 是可继承的，根 ul 上归零一次就覆盖全部 li ⇒ 这两个读数盯的是同一条声明。
    expect(m.rootListStyle, `根 ul 的 list-style 是 ${m.rootListStyle}`).toBe(
      "none",
    );
    expect(m.liListStyle, `li 上还留着 ${m.liListStyle} 标记`).toBe("none");
    // 第一层标签贴预览的内容盒左沿。ul 的 UA 默认 padding-left:40px 一回来这里就多 40px
    // （改前实测 448，内容盒左沿 408）。
    const firstInset = (m.labelLefts[0] as number) - m.contentLeft;
    expect(
      firstInset,
      `第一层比内容盒左沿多出 ${firstInset}px ⇒ 浏览器那 40px 又回来了`,
    ).toBe(0);
    // 反向那一半：不许为了「对齐」把 .tree-children 的缩进一起归零 —— 那 34px 是
    // 20 margin + 13 padding + 1 border，是层级线本身，归掉树就散成一层平铺。
    const steps = m.labelLefts
      .slice(1)
      .map((x, i) => x - (m.labelLefts[i] as number));
    expect(steps.length).toBe(2);
    const firstStep = steps[0] as number;
    for (const step of steps) {
      expect(
        step,
        `每层只缩 ${step}px ⇒ 层级线被抹平了`,
      ).toBeGreaterThanOrEqual(20);
      expect(step, `各层缩进不一致：${JSON.stringify(m.labelLefts)}`).toBe(
        firstStep,
      );
    }
  });
});
