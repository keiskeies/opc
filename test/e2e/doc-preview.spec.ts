/**
 * markdown 正文的三种视图（源码 / 预览 / 分栏）与「视图换完，编辑与保存还得在」。
 *
 * ── 这个文件为什么会存在 ────────────────────────────────────────
 * 用户的原话是「文档区域太小了…而且 markdown 需要有预览以及分两栏的左边编辑右边预览」。
 * 前半格（高度归谁）由 doc-layout.spec.ts 的 W6 守着，后半格（分栏本身）在这里。
 * 分栏这件事最容易出的事故不是「切不过去」，而是切完之后【某条看不见的线断了】：
 *  · 正文宿主 .editor-surface 同时是草稿读写的锚点（queueDraft 读它的 data-draftBody、
 *    restoreDraft 在它里面找 textarea）⇒ 分栏容器一旦顶替它，草稿整条静默失效；
 *  · 赋值 textarea.value 不触发 input ⇒ 恢复草稿后右栏还写着旧正文，一屏说两件矛盾的事；
 *  · 新增的页签条与草稿条是两条新的横向 chrome ⇒ 它们每多 1px 都是从正文里借的。
 * 这些形状在改之前都不存在，所以各自需要一根自己的判据（家规：每根线要有自己的那次动作，
 * 别指望相邻那条绿用例顺带覆盖）。
 *
 * ── 判据形状 ────────────────────────────────────────────────────
 * 全部真点击 + 真 DOM 读数（getBoundingClientRect / getComputedStyle / querySelector），
 * 不看截图、不读源码。
 * 隐藏那一面用 computed display 判，不用 boundingBox()：后者对 display:none 给 null，
 * 但对 visibility:hidden / opacity:0 仍给矩形 —— 当初选 display:none 分派就是因为
 * 「隐藏的栏不该占位也不该可命中」，判据必须能分辨这两族，否则换回 visibility 照样绿。
 * 每发都带窗口自证：宽度读 0、节点数为 0 时直接说明「观测窗口不在位」，不让循环空跑报绿。
 * 会改正文的用例各自新建一篇文档：同一篇被前一条写过版本，后一条读到的「云端正文」
 * 就不是 beforeAll 里那份样本了（假绿与假红都从这里来）。
 *
 * ── 不含哪几格 ──────────────────────────────────────────────────
 *  · markdown 语法与转义/XSS：test/web/markdown.test.ts（纯函数，在 node 里真跑）。
 *  · 富文本与表格编辑器本身：rich-editor.spec.ts / sheet-editor.spec.ts。
 *  · 铺满的高度账与页头高度：doc-layout.spec.ts 的 W6。
 * 配套剪线探针：.workbuddy/round378-pane-mutations.mjs。
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
const TOKEN = "doc-preview-e2e-token";
const NL = String.fromCharCode(10);

let webPort = 0;
let directory = "";
let queue: WriteQueue | null = null;
let hub: Awaited<ReturnType<typeof serveHub>> | null = null;
let web: ChildProcess | null = null;
let api = "";

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

async function createDoc(kind: string, title: string, bodyText: string) {
  const res = await fetch(`${api}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      title,
      body_text: bodyText,
      watermark_profile: "none",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/documents -> ${res.status} ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { document?: { doc_id?: string } };
  const id = body.document?.doc_id ?? "";
  expect(id, `建文档没拿到 doc_id：${text.slice(0, 200)}`).toBeTruthy();
  return id;
}

/** 每发自己的样本正文：标题 / 粗体 / 列表 / 表格四族，够判「有没有真渲染」。 */
const SAMPLE = [
  "# 双十一落地页",
  "",
  "目标是 **转化率** 翻倍。",
  "",
  "- 首页入口",
  "- 会场页",
  "",
  "| 指标 | 目标 |",
  "|:-----|-----:|",
  "| uv   | 100w |",
].join(NL);

test.beforeAll(async () => {
  webPort = await availablePort();
  directory = mkdtempSync(join(tmpdir(), "opc-doc-preview-"));
  queue = new WriteQueue(join(directory, "hub.db"));
  migrate(queue.writeConnection());
  hub = await serveHub(
    buildHubDeps({
      queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      now: () => Date.now(),
      driverState: () => DRIVER_OFF,
      callModel: async () => ({ text: "分栏验收不需要模型" }),
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

const editorOf = (page: Page) => page.getByLabel("Markdown 正文");
const paneHost = (page: Page) => page.locator(".editor-panes");
const previewOf = (page: Page) => page.locator(".markdown-preview");
const modeTab = (page: Page, name: string) =>
  page
    .getByRole("group", { name: "正文视图" })
    .getByRole("button", { name, exact: true });

/** 建一篇样本文档并打开它（会写正文的用例各用各的，互不污染版本历史）。 */
async function openFreshDoc(page: Page, title: string, body = SAMPLE) {
  const docId = await createDoc("markdown", title, body);
  await page.goto(`http://127.0.0.1:${webPort}/#/documents/${docId}`, {
    waitUntil: "load",
  });
  // 等标题而不是等 .editor-panes：同文档内换 hash 不会重载，上一篇的 paneHost 还挂在
  // 树上 ⇒ 只等「有分栏容器」会在旧文档上通过，随后读到的形态是上一篇的。
  await expect(page.getByLabel("文档标题")).toHaveValue(title);
  await expect(paneHost(page)).toBeAttached();
  return docId;
}

/** 某一面此刻是否参与布局（display:none ⇒ 不参与；visibility:hidden ⇒ 仍参与，这正是区别）。 */
async function displayOf(page: Page, sel: string) {
  const raw = await page.evaluate(`(() => {
    const el = document.querySelector('${sel}');
    if (!el) throw new Error('缺少节点：${sel}');
    const cs = getComputedStyle(el);
    return JSON.stringify({ display: cs.display, visibility: cs.visibility });
  })()`);
  return JSON.parse(raw as string) as { display: string; visibility: string };
}

/** 一次性读回两栏矩形与 data-mode（一次往返，避免三次测量之间布局又动）。 */
async function paneGeometry(page: Page) {
  const raw = await page.evaluate(`(() => {
    const host = document.querySelector('.editor-panes');
    if (!host) throw new Error('没有 .editor-panes ⇒ 分栏容器没渲染');
    const src = host.querySelector('.markdown-editor');
    const prev = host.querySelector('.markdown-preview');
    if (!src || !prev) throw new Error('分栏容器里少了源码面或预览面');
    const box = (el) => {
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.x), w: Math.round(b.width), h: Math.round(b.height) };
    };
    const card = document.querySelector('.doc-page > .editor-card');
    const bar = document.querySelector('.doc-mode-bar');
    return JSON.stringify({
      mode: host.dataset.mode ?? '',
      src: box(src),
      prev: box(prev),
      hostW: Math.round(host.getBoundingClientRect().width),
      cardH: card ? Math.round(card.getBoundingClientRect().height) : 0,
      srcTag: src.tagName.toLowerCase(),
      srcDisplay: getComputedStyle(src).display,
      prevDisplay: getComputedStyle(prev).display,
      previewNodes: prev.querySelectorAll('h1, ul, li, table, th, strong').length,
      barOneRow: bar
        ? (() => {
            const cs = getComputedStyle(bar);
            const kids = [...bar.children].map((c) => c.getBoundingClientRect().height);
            const border =
              parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
            const chrome = Math.round(
              parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border,
            );
            return {
              extra:
                Math.round(bar.getBoundingClientRect().height) -
                (Math.round(Math.max(...kids)) + chrome),
              activeTabs: bar.querySelectorAll('.doc-mode-tab.active').length,
              pressed: [...bar.querySelectorAll('.doc-mode-tab')].filter(
                (t) => t.getAttribute('aria-pressed') === 'true',
              ).length,
            };
          })()
        : null,
    });
  })()`);
  return JSON.parse(raw as string) as {
    mode: string;
    src: { x: number; w: number; h: number };
    prev: { x: number; w: number; h: number };
    hostW: number;
    cardH: number;
    srcTag: string;
    srcDisplay: string;
    prevDisplay: string;
    previewNodes: number;
    barOneRow: { extra: number; activeTabs: number; pressed: number } | null;
  };
}

test.describe("markdown 三态视图", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("打开停在源码态：编辑面在场，预览面已画好且不参与布局", async ({ page }) => {
    await openFreshDoc(page, "分栏验收·默认态");
    const m = await paneGeometry(page);
    expect(m.mode, `默认形态是 "${m.mode}" ⇒ 「打开即编辑」这条没了`).toBe("source");
    expect(m.srcTag, "源码面不是 textarea ⇒ 编辑入口换了东西").toBe("textarea");
    await expect(editorOf(page)).toBeVisible();
    expect(m.prevDisplay, `预览面在源码态的 display 是 ${m.prevDisplay}`).toBe("none");
    // 但节点首屏就画好了（不等用户点开预览才画，否则切过去会闪一下空框）。
    expect(
      m.previewNodes,
      `隐藏状态下预览面只渲染出 ${m.previewNodes} 个节点 ⇒ 首屏没画`,
    ).toBeGreaterThan(3);
    // 页签条是一行、且只有一枚处于选中态（三枚全 active = setMode 只加了没减）。
    expect(m.barOneRow, "找不到 .doc-mode-bar ⇒ 形态页签没渲染").not.toBeNull();
    const bar = m.barOneRow as { extra: number; activeTabs: number; pressed: number };
    expect(bar.extra, `页签条比「一行内容 + 内距」高 ${bar.extra}px ⇒ 它回绕成了两行`).toBeLessThanOrEqual(2);
    expect(bar.activeTabs, `页签条里 ${bar.activeTabs} 枚 active`).toBe(1);
    expect(bar.pressed, `aria-pressed=true 的页签有 ${bar.pressed} 枚 ⇒ 三态没一起翻`).toBe(1);
  });

  test("预览态渲染出真节点，源码面退场；aria-pressed 跟着走", async ({ page }) => {
    await openFreshDoc(page, "分栏验收·预览态");
    await modeTab(page, "预览").click();
    await expect(paneHost(page)).toHaveAttribute("data-mode", "preview");
    const prev = previewOf(page);
    await expect(prev.locator("h1")).toHaveText("双十一落地页");
    await expect(prev.locator("strong")).toHaveText("转化率");
    await expect(prev.locator("li")).toHaveCount(2);
    await expect(prev.locator("table th")).toHaveCount(2);
    const srcState = await displayOf(page, ".markdown-editor");
    expect(
      srcState.display,
      `预览态下源码面 display=${srcState.display}（visibility=${srcState.visibility}）⇒ 它还在参与布局`,
    ).toBe("none");
    // 反向那一半：正文文本不许只是「源码原样」——预览必须真的换了壳。
    await expect(prev).not.toContainText("**转化率**");
    await expect(modeTab(page, "预览")).toHaveAttribute("aria-pressed", "true");
    await expect(modeTab(page, "源码")).toHaveAttribute("aria-pressed", "false");
  });

  test("分栏时两栏等宽、等高，宽度合起来就是正文宽", async ({ page }) => {
    await openFreshDoc(page, "分栏验收·分栏");
    await modeTab(page, "分栏").click();
    await expect(paneHost(page)).toHaveAttribute("data-mode", "split");
    const m = await paneGeometry(page);
    // 窗口自证：两栏各自要有实际宽高，否则「等宽」量的是 0 == 0。
    expect(m.src.w, "源码面宽 0 ⇒ 分栏没排出版面").toBeGreaterThan(0);
    expect(m.prev.w, "预览面宽 0 ⇒ 分栏没排出版面").toBeGreaterThan(0);
    expect(Math.abs(m.src.w - m.prev.w), `两栏不等宽：${m.src.w} vs ${m.prev.w}`).toBeLessThanOrEqual(1);
    // 两栏是【分】正文的宽，不是各自 100%（flex-basis 没归 0 时长的内容会把某一栏撑走）。
    expect(
      m.src.w + m.prev.w,
      `两栏宽之和 ${m.src.w + m.prev.w} ≠ 容器 ${m.hostW} ⇒ flex-basis 没归 0`,
    ).toBeGreaterThanOrEqual(m.hostW - 2);
    expect(m.src.w + m.prev.w).toBeLessThanOrEqual(m.hostW + 2);
    // 左在右左：分栏的定义就是「左边编辑右边预览」。
    expect(m.prev.x, "预览面不在源码面右侧 ⇒ 两栏顺序倒了").toBeGreaterThan(m.src.x);
    // 纵向都吃满容器（长文时预览自己滚，而不是把容器撑高一截）。
    expect(m.src.h, `源码面只有 ${m.src.h} 高`).toBeGreaterThan(300);
    expect(Math.abs(m.src.h - m.prev.h), "两栏高度不一致 ⇒ 交叉轴被某栏内容拉长").toBeLessThanOrEqual(1);
  });

  test("边打字边重渲染，且保存链路照旧 PATCH", async ({ page }) => {
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/documents/"))
        patches.push(req.postData() ?? "");
    });
    const docId = await openFreshDoc(page, "分栏验收·打字");
    await modeTab(page, "分栏").click();
    const marker = "本轮新增的小节";
    await editorOf(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`## ${marker}${NL}${NL}这一段是打字打进去的。`, { delay: 5 });
    // 预览读的是【当前】textarea：标题这一族最能见真伪。
    await expect(previewOf(page).locator("h2")).toHaveText(marker);
    // 自动保存那一跳（900ms 定时器）仍发得出去：分栏容器套进正文宿主之后，
    // readContent() 找 textarea 的那条路没断才算这格过。
    await expect
      .poll(
        () => patches.filter((p) => p.includes(marker)).length,
        { message: "打字后没发出带新正文的 PATCH ⇒ 分栏把保存链路剪断了" },
      )
      .toBeGreaterThan(0);
    expect(docId).toBeTruthy();
  });

  test("形态按文档记：不串到另一篇，切回来还在原处", async ({ page }) => {
    const first = await openFreshDoc(page, "分栏验收·偏好A");
    await modeTab(page, "分栏").click();
    await expect(paneHost(page)).toHaveAttribute("data-mode", "split");
    await openFreshDoc(page, "分栏验收·偏好B");
    expect(
      (await paneGeometry(page)).mode,
      "第二篇继承了第一篇的形态 ⇒ 形态记成了全局值而不是按文档",
    ).toBe("source");
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${first}`, {
      waitUntil: "load",
    });
    // 同上：先确认渲染的是第一篇（标题回来），再读它的形态。
    await expect(page.getByLabel("文档标题")).toHaveValue("分栏验收·偏好A");
    await expect(paneHost(page), "切回来形态丢了").toHaveAttribute("data-mode", "split");
  });

  test("新增的两条 chrome 只按内容高，正文仍拿编辑卡的八成以上", async ({ page }) => {
    await openFreshDoc(page, "分栏验收·高度账");
    const m = await paneGeometry(page);
    expect(m.cardH, "编辑卡高度读 0 ⇒ 页面没排版，占比判据无效").toBeGreaterThan(300);
    expect(
      m.src.h,
      `源码面只占编辑卡 ${m.src.h}/${m.cardH} ⇒ 页签条/状态条又开始吃正文高度了`,
    ).toBeGreaterThan(Math.round(m.cardH * 0.8));
    // 反向那一半：页签条不许为了「好看」把自己拉成一条横幅（内容高 + 内距之内才算合格）。
    const bar = m.barOneRow as { extra: number };
    expect(bar.extra, `页签条比内容高多占 ${bar.extra}px`).toBeLessThanOrEqual(2);
  });
});

test.describe("草稿与分栏要合得上", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /**
   * 建文档 → 预置一份本地草稿 → 打开（addInitScript 保证在应用读 localStorage 之前落盘）。
   * kind/cloud 要能换：思维导图那一发要的是「大纲形状」的云端正文，样本文档塞 markdown
   * 会让两边的树节点混在一起，读不出「哪一棵被重画了」。
   */
  async function openWithDraft(
    page: Page,
    title: string,
    draft: { title?: string; body: string },
    opts: { kind?: string; cloud?: string } = {},
  ) {
    const docId = await createDoc(
      opts.kind ?? "markdown",
      title,
      opts.cloud ?? SAMPLE,
    );
    await page.addInitScript(
      ([id, payload]) => {
        localStorage.setItem(`opc:doc-draft:${id}`, payload);
      },
      [docId, JSON.stringify({ title: draft.title ?? title, body_text: draft.body, saved_at: 1 })] as [string, string],
    );
    await page.goto(`http://127.0.0.1:${webPort}/#/documents/${docId}`, {
      waitUntil: "load",
    });
    await expect(page.getByLabel("文档标题")).toHaveValue(title);
    await expect(paneHost(page)).toBeAttached();
    return docId;
  }

  test("草稿提示是一条带：按钮可见、只有一行高、能关掉且关掉不带走编辑区", async ({ page }) => {
    await openWithDraft(page, "分栏验收·草稿条", { body: "# 草稿里的标题" });
    const bar = page.locator("#docDraftBar");
    await expect(bar).toBeVisible();
    // 「一条带」用几何判：条高 == 最高子项 + 上下内距 + 描边。回绕成两行时子项最高值不变、
    // 条高却多出一行 ⇒ 这把尺子专门盯「横幅一行 + 按钮行两行」那个旧形状。
    const raw = await page.evaluate(`(() => {
      const bar = document.querySelector('#docDraftBar');
      if (!bar) throw new Error('没有 #docDraftBar');
      const cs = getComputedStyle(bar);
      const kids = [...bar.children].map((c) => c.getBoundingClientRect().height);
      const border = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const chrome = Math.round(parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + border);
      const actions = bar.querySelector('.actions');
      return JSON.stringify({
        extra: Math.round(bar.getBoundingClientRect().height) - (Math.round(Math.max(...kids)) + chrome),
        actionsH: actions ? Math.round(actions.getBoundingClientRect().height) : 0,
        actionsRight: actions
          ? Math.round(actions.getBoundingClientRect().right)
          : 0,
        barRight: Math.round(bar.getBoundingClientRect().right),
      });
    })()`);
    const g = JSON.parse(raw as string) as {
      extra: number;
      actionsH: number;
      actionsRight: number;
      barRight: number;
    };
    expect(g.actionsH, "草稿条里的按钮组高度为 0 ⇒ 恢复/丢弃看不见").toBeGreaterThan(0);
    expect(
      g.barRight - g.actionsRight,
      "按钮组没贴到条的右沿 ⇒ 它不在同一行（旧的两行形状）",
    ).toBeLessThanOrEqual(20);
    expect(
      g.extra,
      `草稿条比「一行内容 + 内距」还高 ${g.extra}px ⇒ 它回绕成了两行`,
    ).toBeLessThanOrEqual(2);
    await page.getByRole("button", { name: "关闭草稿提示" }).click();
    await expect(bar).toHaveCount(0);
    // 关掉提示不许把编辑区一起关掉（旧形状里横幅与按钮行是同一次渲出的兄弟节点）。
    await expect(editorOf(page)).toBeVisible();
  });

  test("恢复草稿会重画当前视图，而不是只灌 textarea", async ({ page }) => {
    const draftBody = ["# 草稿正文", "", "- 草稿项一", "- 草稿项二"].join(NL);
    await openWithDraft(page, "分栏验收·恢复草稿", { body: draftBody });
    // 停在分栏：恢复后左栏（源码）与右栏（预览）必须同时说新正文。
    await modeTab(page, "分栏").click();
    await page.getByRole("button", { name: "恢复本地草稿" }).click();
    await expect(editorOf(page)).toHaveValue(draftBody);
    const prev = previewOf(page);
    await expect(prev.locator("h1")).toHaveText("草稿正文");
    await expect(prev.locator("li")).toHaveCount(2);
    // 反向那一半：预览里不许留着云端旧正文的标题（赋值不触发 input，漏了 repaintPanes 就是这个形状）。
    await expect(prev.locator("h1")).not.toHaveText("双十一落地页");
  });

  test("思维导图恢复草稿后那棵树跟着重画（只靠 repaintPanes 这一条线）", async ({
    page,
  }) => {
    // 这一发证的是思维导图那一支：round378 之前 restoreDraft 里另有一条
    // if (kind === "mindmap") dispatchEvent("input")，与 repaintPanes 做的是同一件事
    // （outline 的 input 监听就是 drawTree）⇒ 那一次重画跑两遍、markdown 跑一遍。
    // 现在只剩 repaintPanes 一条，所以它必须自己撑起这一格：剪掉 paint 回调，这一发红。
    const cloudOutline = ["云端根", "  云端旧支"].join(NL);
    const draftOutline = ["草稿根", "  草稿支", "    草稿孙"].join(NL);
    await openWithDraft(page, "分栏验收·思维导图草稿", { body: draftOutline }, {
      kind: "mindmap",
      cloud: cloudOutline,
    });
    // 停在【预览】：断的是用户此刻看得见的那一棵树，而不是隐藏栏里恰好也有的那份。
    await modeTab(page, "预览").click();
    const labels = () =>
      page.evaluate(`(() => {
        const preview = document.querySelector('.mindmap-preview');
        if (!preview) throw new Error('没有 .mindmap-preview ⇒ 思维导图预览宿主没渲染');
        return JSON.stringify([...preview.querySelectorAll('.tree-label')].map((s) => s.textContent));
      })()`);
    await expect
      .poll(async () => JSON.parse((await labels()) as string) as string[])
      .toContain("云端旧支");
    await page.getByRole("button", { name: "恢复本地草稿" }).click();
    await expect(page.getByLabel("思维导图大纲")).toHaveValue(draftOutline);
    // 重画之后：树里是草稿的三个节点，云端那两个一个都不留。
    await expect
      .poll(async () => JSON.parse((await labels()) as string) as string[])
      .toEqual(["草稿根", "草稿支", "草稿孙"]);
    const after = JSON.parse((await labels()) as string) as string[];
    expect(after).not.toContain("云端旧支");
  });

  test("草稿锚点没被分栏剪断：data-draftBody 与 localStorage 都拿到当前正文", async ({
    page,
  }) => {
    const docId = await openFreshDoc(page, "分栏验收·草稿锚点");
    const marker = "草稿锚点验证";
    await editorOf(page).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type(`## ${marker}`, { delay: 5 });
    // queueDraft 读的是 .editor-surface 的 data-draftBody ⇒ 分栏容器必须套在它【里面】。
    await expect
      .poll(
        async () =>
          page.evaluate(
            `(() => {
              const surf = document.querySelector('.editor-surface');
              if (!surf) return 'no-surface';
              const panes = document.querySelector('.editor-panes');
              const nested = !!panes && surf.contains(panes);
              const stored = localStorage.getItem('opc:doc-draft:${docId}') ?? '';
              return JSON.stringify({ nested, dataset: surf.dataset.draftBody ?? '', stored });
            })()`,
          ),
        { message: "读不到当前正文 ⇒ 草稿存取锚点被挪走了" },
      )
      .toContain(marker);
    const shape = await page.evaluate(
      `(() => {
        const surf = document.querySelector('.editor-surface');
        const panes = document.querySelector('.editor-panes');
        return JSON.stringify({
          nested: !!panes && !!surf && surf.contains(panes),
          draftAnchor: !!(surf && surf.dataset.draftBody),
        });
      })()`,
    );
    const s = JSON.parse(shape as string) as { nested: boolean; draftAnchor: boolean };
    expect(s.nested, "分栏容器不在 .editor-surface 里面 ⇒ 它顶替了正文宿主").toBe(true);
    expect(s.draftAnchor, ".editor-surface 上没有 data-draftBody ⇒ 草稿锚点没了").toBe(true);
  });
});
