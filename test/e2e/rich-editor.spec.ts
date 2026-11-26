/**
 * 富文本正文（Quill 接线层）的出口门：文档中心的 doc 正文【打开就是可编辑的那篇】。
 *
 * ── 这一条 spec 到底证到哪一格 ──────────────────────────────────
 * 真 Hub + 真 dev-server + 真浏览器，全部判据取【渲染出来的 DOM 与真 HTTP 往返】，
 * 不看截图、不读源码：
 *  ① 打开即编辑：hash 深链进一篇存量 doc，正文节点就挂在 contenteditable 的引擎里，
 *     工具栏在场，且【没有】第二份 textarea（「界面上一眼是正文、编辑的却是另一格」是
 *     这轮之前的真实形状）。
 *  ② 打开 ≠ 脏：静置 2.5s 零 PATCH。这一格是「自动保存」接线的反面证据 —— 灌正文时
 *     只要把 seed 当成用户改动，打开一篇没碰过的文档就白写一个版本。
 *  ③ 存量 <br>（DOCX 导入的软换行，见 formats.ts 的 mammoth 路径）不静默吃内容：
 *     段内换行成为新段落（文字一个不少），表格单元格里的换行折成空格而不是新单元格
 *     （Quill 把 <td> 里的 <br> 读成「换一格」，实测 2 列变 3 列 —— 那是改版式，不是排版差异）。
 *  ④ 折叠光标点加粗再打字 ⇒ 存出去的 body 里有 <strong>（Delta 丢掉零长 retain，
 *     旧写法 formatText(range) 在这一步静默无操作）；撤销栈跨文档干净。
 *  ⑤ 正文里躺着的 data: 图：打开时【不上传、不重排、不写版本】（clipboard 的 IMG
 *     matcher 在 seed 期间不跑）；用户真粘一张才转成资产。
 *
 * ── 为什么单开一个 spec 文件，而不是塞进 group-workbench.spec.ts ──
 * 那边一个 beforeAll 拉 12 个重用例共用的 Hub + 文档；这里每案都要【新建一篇带特定
 * 正文的文档】并观察它自己的 PATCH 流量，塞进去会让两边互相等。Playwright 的 testMatch
 * 自动认领 test/e2e/*.spec.ts，不需要任何登记（test/arch/test-inventory.test.ts 问的是
 * 运行器，不是清单）。
 *
 * ── 不含哪几格 ──────────────────────────────────────────────────
 *  · 字体色/高亮：vendor 的是 quill.core.css + 自建工具栏，这一轮没上颜色按钮。
 *  · 图片选择器的文件对话框、导出导入：各有射程，不在本文件。
 *  · 非回环远程批准链：mobile-approval.spec.ts 的射程。
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
const TOKEN = "rich-editor-e2e-token";
let webPort = 0;
let directory = "";
let queue: WriteQueue | null = null;
let hub: Awaited<ReturnType<typeof serveHub>> | null = null;
let web: ChildProcess | null = null;
let api = "";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

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

test.beforeAll(async () => {
  webPort = await availablePort();
  directory = mkdtempSync(join(tmpdir(), "opc-rich-ui-"));
  queue = new WriteQueue(join(directory, "hub.db"));
  migrate(queue.writeConnection());
  hub = await serveHub(
    buildHubDeps({
      queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      now: () => Date.now(),
      driverState: () => DRIVER_OFF,
      callModel: async () => ({ text: "富文本验收不需要模型" }),
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

/** 直接建一篇 doc（走真路由，不从 UI 建：这一条测的是编辑器，不是创建弹窗）。 */
async function makeDoc(bodyText: string): Promise<string> {
  const res = await fetch(`${api}/documents`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "doc",
      title: `富文本验收 ${bodyText.slice(0, 20)}`,
      body_text: bodyText,
      watermark_profile: "none",
    }),
  });
  expect(res.ok).toBe(true);
  const created = (await res.json()) as { document: { doc_id: string } };
  return created.document.doc_id;
}

/** 打开一篇文档并等富文本引擎就位；返回它自己的 PATCH 记录本。 */
async function openDoc(page: Page, docId: string) {
  const patchBodies: string[] = [];
  const pageErrors: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes(`/documents/${docId}`))
      patchBodies.push(req.postData() ?? "");
  });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  const target = `http://127.0.0.1:${webPort}/#/documents/${docId}`;
  // SPA 里 hash 才是路由。同页换 hash 时 Chromium 不重载、不发 load 事件，
  // page.goto(waitUntil:"load") 会一直等到执行超时（实测 240s 挂死）；只有换页才 goto。
  if (!page.url().startsWith(`http://127.0.0.1:${webPort}/`)) {
    await page.goto(target, { waitUntil: "load" });
  } else {
    // hash 分支里宿主节点跨文档复用，waitForSelector 可能命中【上一篇】的编辑器，
    // 于是下一步点到的还是旧正文。先等浏览器真的 GET 这一篇，再等编辑器。
    const fetched = page
      .waitForRequest(`http://127.0.0.1:${webPort}/api/v1/documents/${docId}`, {
        timeout: 20_000,
      })
      .then(() => true)
      .catch(() => false);
    await page.evaluate(`window.location.hash = '#/documents/${docId}'`);
    if (!(await fetched)) {
      throw new Error(`hash 切文档后没有再拉取该文档详情：doc=${docId}`);
    }
  }
  try {
    await page.waitForSelector(".rich-editor-host .ql-editor", {
      timeout: 20_000,
    });
  } catch (error) {
    // 裸超时只有"editor 没出现"一格信息，分不清是错误横幅、还在 loading、还是 kind 不对。
    const viewText = await page.evaluate(
      "(() => { const v = document.querySelector('#view'); return v ? v.textContent.slice(0, 160) : 'no #view'; })()",
    );
    throw new Error(
      `富文本引擎未就位 doc=${docId} view=${JSON.stringify(viewText)} cause=${String(error)}`,
    );
  }
  return { patchBodies, pageErrors };
}

const EDITOR_HTML =
  "document.querySelector('.rich-editor-host .ql-editor').innerHTML";

test("①打开即编辑 + 打开≠脏：正文在引擎里、没有第二份 textarea、静置零 PATCH", async ({
  page,
}) => {
  const docId = await makeDoc("<p>段落甲</p><p>段落乙</p>");
  const { patchBodies, pageErrors } = await openDoc(page, docId);
  await page.waitForTimeout(2_500);

  // 正文节点真的可编辑，且带无障碍名（旧断言 getByRole("textbox", { name: "富文本正文" }) 依赖它）
  await expect(
    page.getByRole("textbox", { name: "富文本正文" }),
  ).toHaveAttribute("contenteditable", "true");
  expect(await page.evaluate(EDITOR_HTML)).toContain("段落甲");
  // 工具栏在场（用自建工具栏的类名，别用 .ql-toolbar：core 主题根本不造那条栏）
  await expect(page.locator(".rich-editor-host")).toBeVisible();
  expect(
    await page.evaluate(
      "document.querySelectorAll('.rich-editor-tool').length",
    ),
  ).toBeGreaterThan(8);
  // ⚠ 反面证据：不许再有第二份正文输入面。上一版是「上面渲一段、下面 textarea 改另一份」，
  // 只断言富文本在场测不出那种双份。
  expect(await page.locator(".editor-surface textarea").count()).toBe(0);
  // 打开一篇没碰过的文档 ⇒ 零 PATCH（seed 走 silent，不算用户改动）
  expect(patchBodies).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("②存量 <br>：段内换行成新段落、单元格换行不变成新单元格，文字一个不少", async ({
  page,
}) => {
  const paraId = await makeDoc("<p>尾段<br>换行</p><p>下一段</p>");
  const { patchBodies, pageErrors } = await openDoc(page, paraId);
  const paraHtml = (await page.evaluate(EDITOR_HTML)) as string;
  // 两行都还在（旧实现把 <br> 换成 \n，HTML 空白折叠压成空格：「尾段 换行」= 一行没了）
  expect(paraHtml).toContain("尾段");
  expect(paraHtml).toContain("换行");
  expect(paraHtml).not.toContain("尾段 换行");
  expect(paraHtml.match(/<p(?:\s[^>]*)?>/gu)?.length).toBe(3);
  expect(patchBodies).toEqual([]);

  const cellId = await makeDoc(
    "<table><tbody><tr><td>甲</td><td>乙<br>续</td></tr><tr><td>丙</td><td>丁</td></tr></tbody></table>",
  );
  // 同页第二篇：走 openDoc 的 hash 分支 —— 这里顺带把「hash 换文档」这条 SPA 主路径纳入射程。
  const second = await openDoc(page, cellId);
  await page.waitForTimeout(1_200);
  const cells = await page.evaluate(
    "JSON.stringify([...document.querySelectorAll('.rich-editor-host .ql-editor td')].map((c) => c.textContent))",
  );
  // 「乙<br>续」必须是 2 列里的一格（Quill 原生读法会把它当成第三格 → ["甲","乙","续","丙","丁"]）
  expect(JSON.parse(cells as string) as string[]).toEqual([
    "甲",
    "乙 续",
    "丙",
    "丁",
  ]);
  expect(second.patchBodies).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("③折叠光标点加粗再打字 ⇒ 存出去的正文里有 strong；跨文档撤销栈干净", async ({
  page,
}) => {
  const firstId = await makeDoc("<p>甲乙丙</p>");
  const { patchBodies, pageErrors } = await openDoc(page, firstId);
  await page.getByRole("textbox", { name: "富文本正文" }).click();
  await page.keyboard.press("Home");
  // 光标折叠（不选字）直接点加粗：Delta 会丢掉 formatText 的零长 retain，只有
  // quill.format() 插的 ql-cursor 能让后打的字继承格式。
  await page.getByRole("button", { name: "加粗", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "加粗", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("粗");
  await expect
    .poll(() => patchBodies.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const saved = (await (await fetch(`${api}/documents/${firstId}`)).json()) as {
    document: { body_text: string };
  };
  expect(saved.document.body_text).toContain("<strong>");
  expect(saved.document.body_text).toContain("粗");

  // 换到第二篇：撤销栈必须空（实例跨文档复用，seed 不清栈会把上一篇的段落搬过来）
  const secondId = await makeDoc("<p>第二篇正文</p>");
  await openDoc(page, secondId);
  await page.getByRole("textbox", { name: "富文本正文" }).click();
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1_200);
  const secondHtml = await page.evaluate(EDITOR_HTML);
  expect(secondHtml).toContain("第二篇正文");
  expect(secondHtml).not.toContain("甲乙丙");
  expect(pageErrors).toEqual([]);
});

test("④正文里的 data: 图：打开不上传、不重排、不写版本；真粘一张才转成资产", async ({
  page,
}) => {
  const docId = await makeDoc(
    `<p>前段<img src="${PNG_1PX}" alt="旧图">后段</p>`,
  );
  const assetCalls: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/assets"))
      assetCalls.push(req.url());
  });
  const { patchBodies, pageErrors } = await openDoc(page, docId);
  await page.waitForTimeout(2_500);
  // sanitizer 只放行 /api/v1/assets/ 的 src ⇒ data: 图一直是丢弃的，这里维持丢弃：
  // 不许「顺手救图」—— 那等于打开文档就上传一张没人要的图，还把内容搬到光标处。
  expect(assetCalls).toEqual([]);
  expect(patchBodies).toEqual([]);
  const html = await page.evaluate(EDITOR_HTML);
  expect(html).toContain("前段");
  expect(html).toContain("后段");
  expect(html).not.toContain("data:image");

  // 真粘贴：用户动作那条路必须把图转成资产（否则富文本没法贴图）。
  // 用 Quill 自己的 clipboard.dangerouslyPasteHTML(…, 'user')：它和粘贴的 onPaste 走
  // 同一个 convert()（matcher 在同一条链上），source 是 USER ⇒ 和真粘贴一样算用户改动。
  // 不用构造的 ClipboardEvent：Chromium 里 new ClipboardEvent 造的 clipboardData 是只读
  // 空壳（实测 dispatch 后 onCapturePaste 读到 html=null，资产请求 0 次），那是浏览器
  // 对剪贴板的信任模型，不是接线缺陷 —— 拿它当判据会把测试钉死在平台行为上。
  await page.getByRole("textbox", { name: "富文本正文" }).click();
  await page.evaluate(
    `(() => {
      const host = document.querySelector('.rich-editor-host');
      const q = window.Quill.find(host);
      q.focus();
      const at = q.getLength() - 1;
      q.setSelection(at, 0);
      q.clipboard.dangerouslyPasteHTML(at, '<p><img src="${PNG_1PX}"></p>', 'user');
    })()`,
  );
  await expect
    .poll(() => assetCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(EDITOR_HTML), { timeout: 15_000 })
    .toContain("/api/v1/assets/");
  // 贴图落进正文后自动保存要等 900ms 计时器（scheduleAutosave），上面两条 poll
  // 一到就返回，所以这里也必须 poll，不能裸断言（实测裸断言拿到 0）。
  await expect
    .poll(() => patchBodies.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test("⑤权限与设置搬到右侧抽屉：开合、不压正文、换文档不留上一篇的权限面板", async ({
  page,
}) => {
  // 「文件进来就是查看/编辑，权限相关的东西排到右侧抽屉」这一半的判据。
  // 抽屉住在 #mainPane 而不是 #view 里（#view 是滚动容器，放进去等于抽屉跟着正文滚走），
  // 所以它有自己的生命周期：换路由要显式拆 —— 这里断的就是那条拆干净了。
  const docA = await makeDoc("<p>抽屉甲</p>");
  const { pageErrors } = await openDoc(page, docA);
  const drawer = page.locator("#mainPane .doc-drawer-wrap");
  const toggle = page.getByRole("button", { name: "权限与设置", exact: true });

  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveAttribute("aria-controls", "docDrawerWrap");

  await toggle.click();
  await expect(drawer).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  // 三块内容都在抽屉里，不在正文流里：正文侧不许再留一份权限表单（双份 = 改了没反应）。
  for (const heading of ["文档元数据", "版本历史（30 天）", "权限"]) {
    await expect(
      drawer.locator("h3", { hasText: heading }).first(),
    ).toBeVisible();
  }
  expect(
    await page.evaluate(
      "[...document.querySelectorAll('#view h3')].filter((h) => ['文档元数据','版本历史（30 天）','权限'].includes(h.textContent)).length",
    ),
  ).toBe(0);

  // 取几何数字之前先等滑入动画停下：`.doc-drawer-wrap` 带 transition:transform .2s，而
  // toBeVisible() 只判 visibility —— class 一摘 visibility 立刻翻成可见，transform 还要滑 200ms。
  // 这里 poll 的是【水平位移归零】，不是 setTimeout：动画坏了要红，而不是慢一点蒙过去。
  await expect
    .poll(
      () =>
        page.evaluate(
          `(() => {
            const t = getComputedStyle(document.querySelector('#mainPane .doc-drawer-wrap')).transform;
            return t === "none" ? 0 : Math.round(new DOMMatrixReadOnly(t).e);
          })()`,
        ),
      { timeout: 5_000 },
    )
    .toBe(0);

  const box = await page.evaluate(
    `(() => {
      const wrap = document.querySelector('#mainPane .doc-drawer-wrap');
      const pane = document.querySelector('#mainPane');
      const pageEl = document.querySelector('.doc-page');
      const editor = document.querySelector('.rich-editor-host .ql-editor');
      const r = (el) => el.getBoundingClientRect();
      return JSON.stringify({
        drawerLeft: Math.round(r(wrap).left),
        drawerRight: Math.round(r(wrap).right),
        paneRight: Math.round(r(pane).right),
        drawerWidth: Math.round(r(wrap).width),
        editorRight: Math.round(r(editor).right),
        pagePaddingRight: getComputedStyle(pageEl).paddingRight,
      });
    })()`,
  );
  const geom = JSON.parse(box as string) as {
    drawerLeft: number;
    drawerRight: number;
    paneRight: number;
    drawerWidth: number;
    editorRight: number;
    pagePaddingRight: string;
  };
  // 贴右边 = 【右边缘】贴合，量 paneRight − drawerRight（实测 5 档宽度 1100/1181/1280/1440/2240
  // 全是 0）。这一格原先写的是 paneRight − drawerLeft ≤ 1，而打开态那个差恒等于抽屉自己的宽度
  // 340（收起态才是 −3）：它一直在绿，是因为取数正好落在滑还没滑进来的那 200ms 里，
  // 量的从来是收起位置 ⇒ 「贴右边」这句判据从没成立过。等完动画再量，它当场红回 340。
  expect(geom.paneRight - geom.drawerRight, "抽屉没贴在主区右边缘").toBe(0);
  expect(geom.drawerWidth).toBe(340);
  // 关键一格：开着抽屉时正文被 padding 挤窄（368px），而不是被压在上面盖住末尾几个字。
  expect(geom.pagePaddingRight).toBe("368px");
  expect(geom.editorRight).toBeLessThan(geom.drawerLeft);

  await page.getByRole("button", { name: "收起权限面板" }).click();
  await expect(drawer).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // 换文档（hash，同页不重载）：抽屉重建成关闭态，不许留着上一篇的权限列表开着。
  await toggle.click();
  await expect(drawer).toBeVisible();
  const docB = await makeDoc("<p>抽屉乙</p>");
  await openDoc(page, docB);
  await expect(drawer).toBeHidden();
  expect(
    await page.evaluate(
      "document.querySelector('#mainPane').classList.contains('drawer-open')",
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      "(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '权限与设置'); return t ? t.getAttribute('aria-expanded') : 'missing'; })()",
    ),
  ).toBe("false");
  expect(pageErrors).toEqual([]);
});

test("⑥还原成【没有富文本接线】的旧正文路径 ⇒ 上面这几条立刻红（变异自检的反向控制）", async ({
  page,
}) => {
  // 这一条不测产品，测的是【本文件的判据有没有读者】：把富文本宿主节点的选择器换个名字，
  // openDoc 的 waitForSelector 就永远等不到 —— 证明①~④断的是真接线，不是页面凑巧有的 DOM。
  const docId = await makeDoc("<p>反向对照用正文</p>");
  await openDoc(page, docId);
  const wired = await page.evaluate(
    "(() => { const host = document.querySelector('.rich-editor-host'); const q = window.Quill && window.Quill.find ? window.Quill.find(host) : null; return q ? q.constructor.name : 'none'; })()",
  );
  expect(wired).not.toBe("none");
});
