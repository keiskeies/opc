/**
 * 表格文档 = vendor/xspreadsheet 画布（round371 换库）。
 *
 * ── 这一支守什么 ────────────────────────────────────────────────
 * 用户诉求：表格打开就是一张完整的表（像 Excel/WPS），铺满正文区，直接能改。
 * 判据全部走【真实鼠标 + 真实请求】，不读源码、不比像素：
 *  S1 铺满：画布拿到宿主剩余高度（>600）且宽度跟着视口走；网格真画出数据
 *     （fillText 采样里有正文里的字 —— 画布渲染，DOM 里没有单元格文本，
 *      不 spy 画布就等于没判据）。
 *  S2 编辑回写：真点格子、真打字、真 Enter，900ms 后 hub 收到 PATCH，
 *     正文形状仍是 {sheets:[{name,rows}]}（hub 的 xlsx 导出只认这个形状），
 *     且字节数远小于 64KB 请求上限（rows 必须稀疏，不能把 100×26 稠密写回）。
 *  S3 公式平价：SUM 之外，COUNT / ROUND 是旧自研引擎有、库没有的，靠 vendor
 *     补丁二补上（补丁没打上 → 画布出现 #ERROR!）。
 *  S4 补丁一承重：未知函数名【不许把整张网格画空】。上游在 canvas 绘制循环里
 *     直接取未知名对应的 render，一个字母打错就整片不画；补上守卫后显示 #ERROR!
 *     且其余格子照画。
 *  S5 只读是权限边界：mode:'read' 只挡键盘改格，页签双击改名、右键删表、底栏「+」
 *     都不看它。所以断言的不是「看起来不能改」，而是真点之后【数据没变、也没发 PATCH】。
 *
 * ── 为什么用 route 改写 my_tier ──────────────────────────────────
 * 这套 harness 里 hub 始终以 BOSS 身份出视图（documents/service.ts:407 owner 短路），
 * 拿不到 reader。前端只认 detail.document.my_tier（group.js:4532），所以用 page.route
 * 把 GET 详情里那一个字段改成 reader —— 改的是【服务端投影出的权限】，不是前端逻辑，
 * 换库前后端代码一行不动。
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
const TOKEN = "sheet-editor-e2e-token";

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

async function hubGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${api}${path}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function docIdOf(body: Record<string, unknown>): string {
  const doc = body["document"] as { doc_id?: string } | undefined;
  const id = doc?.doc_id ?? "";
  expect(id).toBeTruthy();
  return id;
}

/** 建一篇表格文档，返回 doc_id。rows 直接给 hub 认识的形状。 */
async function seedSheet(
  title: string,
  sheets: Array<{ name: string; rows: unknown[][] }>,
): Promise<string> {
  const created = await hubFetch("/documents", {
    kind: "sheet",
    title,
    body_text: JSON.stringify({ sheets }),
    watermark_profile: "none",
  });
  return docIdOf(created);
}

/**
 * 画布上画了哪些字、画在哪。库把正文全画进 canvas，DOM 里一个单元格文本都没有，
 * 所以「数据到底渲染出来没有」只能从 fillText 这一层取证。
 * 坐标也是承重的：网格自己会画行号 1..N 和列名 A..Z，不带坐标的话
 * 「COUNT 算出 2」这种断言会被行号「2」白送过去（实测就是这样假绿了一轮）。
 * 所以判定一律配「画在某一列那一行附近」的位置条件。
 */
async function installDrawSpy(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __draws: Array<{ t: string; x: number; y: number }>;
    };
    w.__draws = [];
    const proto = CanvasRenderingContext2D.prototype;
    const original = proto.fillText;
    proto.fillText = function patched(
      this: CanvasRenderingContext2D,
      text: string,
      x: number,
      y: number,
      ...rest: number[]
    ): void {
      w.__draws.push({ t: String(text), x: Number(x), y: Number(y) });
      original.apply(
        this,
        [text, x, y, ...rest] as Parameters<typeof original>,
      );
    };
  });
}

type Draw = { t: string; x: number; y: number };

async function draws(page: Page): Promise<Draw[]> {
  return page.evaluate(
    "window.__draws ? window.__draws.slice() : (function(){throw new Error('画布 spy 没装上')})()",
  );
}

async function resetDraws(page: Page): Promise<void> {
  await page.evaluate("window.__draws.length = 0");
}

/**
 * 某一格的内容读数。内容格 (row r, col c) 的文字锚点在 x=5+100c、y=12+25r
 * （e2e 探针实测：col1→x=105、col2→205、col3→305，都在 y=37 那条）。相邻格锚点
 * 恰好差 100px，所以窗口给到 95px 宽能把本格文字锚进、把邻格锚掉——否则 C 列那个
 * "2" 会漏进 B 列的采样里，SUM 判 "10" 就被白送。取最后一次重绘的读数。
 */
function cellValue(painted: Draw[], row: number, col: number): string {
  const x0 = 5 + 100 * col;
  const y0 = 12 + 25 * row;
  const inCell = painted.filter(
    (d) =>
      d.x >= x0 &&
      d.x < x0 + 95 &&
      d.y >= y0 - 3 &&
      d.y < y0 + 22,
  );
  return inCell.length ? inCell[inCell.length - 1].t : "";
}

/** 打开文档并等画布真出现（库在 loadData 之后才挂 canvas）。 */
async function openSheet(page: Page, docId: string): Promise<void> {
  await page.goto(
    `http://127.0.0.1:${webPort}/#/documents/${docId}`,
    { waitUntil: "load" },
  );
  await expect(page.locator(".sheet-canvas canvas")).toBeVisible();
}

/**
 * 真实鼠标点进某一格。坐标按库自己的默认量纲算：行首索引列 60px、列表头 25px、
 * 单元格 100×25（vendor/xspreadsheet.js 的 col:{width:100} / row:{height:25} /
 * indexWidth:60），再取格心。落点用【回写的正文】验过，不靠猜。
 */
async function clickCell(page: Page, row: number, column: number) {
  const box = await page.locator(".sheet-canvas canvas").boundingBox();
  if (!box) throw new Error("画布没有盒子");
  await page.mouse.click(
    box.x + 60 + 100 * column + 50,
    box.y + 25 + 25 * row + 12,
  );
}

/**
 * 往当前格打字。delay 是承重的，不是保险：库在【第一个字符】的 keydown 里才打开编辑器，
 * 而编辑器的 textarea 是 setTimeout(0) 才 focus（vendor editor.js 的 ue()）。
 * Playwright 默认零间隔连发，第二键赶在 focus 之前落到画布上就被吞 —— 实测
 * type("Z9") 只剩 "9"，type("Z9",{delay:60}) 才是 "Z9"。真人手速碰不到这条，
 * 所以这不是产品缺陷，是判据必须按真人节奏来。
 */
async function typeCell(page: Page, row: number, column: number, text: string) {
  await clickCell(page, row, column);
  await page.keyboard.type(text, { delay: 60 });
  await page.keyboard.press("Enter");
}

test.beforeAll(async () => {
  webPort = await availablePort();
  directory = mkdtempSync(join(tmpdir(), "opc-sheet-ui-"));
  queue = new WriteQueue(join(directory, "hub.db"));
  migrate(queue.writeConnection());
  hub = await serveHub(
    buildHubDeps({
      queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      now: () => Date.now(),
      driverState: () => DRIVER_OFF,
      callModel: async () => ({ text: "表格验收不需要模型" }),
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

test.describe("表格文档：打开就是一张完整的表", () => {
  test.use({ viewport: { width: 2240, height: 1232 } });

  test("S1 画布铺满正文区，且真把数据画出来", async ({ page }) => {
    const docId = await seedSheet("表格验收铺满", [
      { name: "Sheet1", rows: [["甲", "乙", "丙"], ["1", "2", "3"]] },
    ]);
    await installDrawSpy(page);
    await openSheet(page, docId);
    const m = await page.evaluate(`(() => {
      const canvas = document.querySelector('.sheet-canvas canvas');
      const host = document.querySelector('.sheet-canvas');
      const editor = document.querySelector('.sheet-editor');
      const surface = document.querySelector('.editor-surface');
      const box = (el) => {
        const b = el.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height) };
      };
      return {
        canvas: box(canvas),
        host: box(host),
        editor: box(editor),
        surface: box(surface),
        toolbar: !!document.querySelector('.sheet-canvas .x-spreadsheet-toolbar'),
        tabs: [...document.querySelectorAll('.sheet-canvas .x-spreadsheet-bottombar .x-spreadsheet-menu > li')].map((li) => li.textContent.trim()),
      };
    })()`);
    // 铺满：画布高度必须咬得住宿主，宿主咬得住正文区。旧版那条 550px 横条
    // 就是断在「卡片满了、画布只敢 550」这一环。
    expect(
      m.canvas.h,
      `画布只有 ${m.canvas.h} 高 ⇒ 又退回定高横条`,
    ).toBeGreaterThan(600);
    expect(m.canvas.w, "画布没跟着视口宽走").toBeGreaterThan(1600);
    expect(
      m.host.h,
      `宿主 ${m.host.h} 没接住画布 ${m.canvas.h}`,
    ).toBeGreaterThanOrEqual(m.canvas.h);
    expect(
      m.editor.h,
      `.sheet-editor ${m.editor.h} 没接住宿主 ${m.host.h}`,
    ).toBeGreaterThanOrEqual(m.host.h);
    // 工具栏在（编辑态）+ 页签在底部：这是「一张完整的表」的两条骨架。
    expect(m.toolbar, "编辑态没有工具栏 ⇒ 换库没生效").toBe(true);
    expect(m.tabs).toContain("Sheet1");
    // 数据真画出来了：正文里的「甲」「丙」必须出现在 fillText 采样里。
    const painted = await draws(page);
    expect(painted.map((d) => d.t), "画布里找不到正文的「甲」").toContain("甲");
    expect(painted.map((d) => d.t), "画布里找不到正文的「丙」").toContain("丙");
  });

  test("S2 打字改一格 → 自动保存回 hub，正文形状与体积都守得住", async ({
    page,
  }) => {
    const docId = await seedSheet("表格验收回写", [
      { name: "Sheet1", rows: [["编号", "数量"], ["A00123", "7"]] },
    ]);
    await openSheet(page, docId);
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(`/documents/${docId}`))
        patches.push(req.postData() ?? "");
    });
    // 改第 1 行第 0 列（原「编号」）与第 1 行第 1 列（原「数量」）。
    await typeCell(page, 1, 0, "A00456");
    await typeCell(page, 1, 1, "12.5");
    await expect
      .poll(() => patches.length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    // autosave 900ms 合并，两下打字可能只发一次 PATCH；读到稳再取正文。
    await page.waitForTimeout(1500);
    const stored = await hubGet(`/documents/${docId}`);
    const body = (stored["document"] as { body_text?: string }).body_text ?? "";
    const parsed = JSON.parse(body) as {
      sheets: Array<{ name: string; rows: unknown[][] }>;
    };
    expect(
      Array.isArray(parsed.sheets),
      "正文不是 {sheets:[...]} ⇒ hub 的 xlsx 导出会拒",
    ).toBe(true);
    expect(parsed.sheets[0].name).toBe("Sheet1");
    // 前导零是信息，不能被「数字还原」吃掉（A00456 不是 456）。
    expect(
      parsed.sheets[0].rows[1][0],
      "编号被当成数字，前导零丢了",
    ).toBe("A00456");
    expect(parsed.sheets[0].rows[1][1]).toBe(12.5);
    // 体积：rows 必须稀疏。稠密写回 100 行 × 26 列会直接撞 hub 的 64KB 请求上限。
    expect(
      body.length,
      `正文 ${body.length} 字节 ⇒ 稀疏化没生效，稠密写回会撞 64KB 上限`,
    ).toBeLessThan(4096);
    expect(
      parsed.sheets[0].rows.length,
      "行数被画布的 100 行默认撑大",
    ).toBeLessThanOrEqual(3);
  });

  test("S3 SUM 之外，COUNT / ROUND 也算得出数（vendor 补丁二）", async ({
    page,
  }) => {
    const docId = await seedSheet("表格验收公式", [
      { name: "Sheet1", rows: [["数", "合计", "计数", "保留一位"]] },
    ]);
    await installDrawSpy(page);
    await openSheet(page, docId);
    const cells: Array<[number, string]> = [
      [1, "3"],
      [2, "7"],
      [3, "x"],
    ];
    for (const [row, text] of cells) {
      await typeCell(page, row, 0, text);
    }
    await resetDraws(page);
    const formulas = [
      [1, 1, "=SUM(A2:A4)"],
      [1, 2, "=COUNT(A2:A4)"],
      [1, 3, "=ROUND(2.345,1)"],
    ] as const;
    // typeCell 带 delay:60 —— 多字符公式首键「=」没有它就会被吞（库首键 keydown
    // 才开编辑器、textarea 靠 setTimeout(0) 才 focus），丢了「=」整串就成了纯文本。
    for (const [row, column, formula] of formulas) {
      await typeCell(page, row, column, formula);
    }
    // 每按一下 Enter 都重绘整片网格，所以判定直接吃这次键入留下的采样，不再补动作。
    await page.waitForTimeout(500);
    const painted = await draws(page);
    // 逐格取数（cellValue 把本格锚进、邻格锚掉）：SUM 跳过文本格 x ⇒ 10；
    // COUNT 只数有限数值 3、7 ⇒ 2；ROUND(2.345,1) ⇒ 2.3。旧写法 toContain("2")
    // 会被行号列的字面 "2" 白送，改成按格断言才守得住。
    expect(
      cellValue(painted, 1, 1),
      "SUM 没算出 10（遇文本格 x 应跳过，不是拼出 NaN）",
    ).toBe("10");
    expect(
      cellValue(painted, 1, 2),
      "COUNT 没算出 2 ⇒ 补丁二没打上",
    ).toBe("2");
    expect(
      cellValue(painted, 1, 3),
      "ROUND 没算出 2.3 ⇒ 补丁二没打上",
    ).toBe("2.3");
    expect(
      painted.map((d) => d.t),
      "画布出现 #ERROR! ⇒ 公式表坏了",
    ).not.toContain("#ERROR!");
  });

  test("S4 未知函数名只坏那一格，不许把整张网格画空（vendor 补丁一）", async ({
    page,
  }) => {
    const docId = await seedSheet("表格验收坏公式", [
      { name: "Sheet1", rows: [["甲", "乙", "丙"], ["1", "2", "3"]] },
    ]);
    await installDrawSpy(page);
    // 监听必须在动作之前挂：这一发要证的正是「异常有没有抛到页面级」，
    // 动作之后再注册等于只看清了后半段。
    const errors: string[] = [];
    page.on("pageerror", (e) =>
      errors.push(String(e.stack ?? e).split("\n").slice(0, 6).join(" | ")),
    );
    await openSheet(page, docId);
    await resetDraws(page);
    // typeCell 带 delay:60：公式首键「=」没有它会被吞，整串就成了纯文本，
    // 既不会走未知函数守卫、也不出 #ERROR! —— 判据就废了。
    await typeCell(page, 0, 0, "=MEAN(1,2)");
    await page.waitForTimeout(500);
    const painted = await draws(page);
    // 上游在这里是 e[v].render(...)：未知名 ⇒ 整条绘制循环抛 ⇒ 一格都不剩。
    // 补上守卫后：坏公式那一格落 #ERROR!，其余数据格照画，异常不进页面级。
    expect(
      cellValue(painted, 0, 0),
      "坏公式那一格没落 #ERROR! ⇒ 补丁一没打上",
    ).toBe("#ERROR!");
    expect(
      [
        cellValue(painted, 0, 1),
        cellValue(painted, 0, 2),
        cellValue(painted, 1, 2),
      ].filter((v) => v !== ""),
      "坏公式把其余数据格（乙/丙/3）一起带走了",
    ).toHaveLength(3);
    expect(
      errors,
      `绘制循环把异常抛到了页面级：${errors[0] ?? ""}`,
    ).toHaveLength(0);
  });
});

test.describe("表格文档：只读那一档是真边界", () => {
  test.use({ viewport: { width: 2240, height: 1232 } });

  /** 把服务端投影的 my_tier 改成 reader（见文件头「为什么用 route」）。 */
  async function asReader(page: Page, docId: string) {
    await page.route(`**/api/v1/documents/${docId}`, async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const res = await route.fetch();
      let body: Record<string, unknown>;
      try {
        body = await res.json();
      } catch {
        return route.fulfill({ response: res });
      }
      const doc = body["document"] as Record<string, unknown> | undefined;
      if (doc) doc["my_tier"] = "reader";
      return route.fulfill({ response: res, body: JSON.stringify(body) });
    });
  }

  test("S5 只读：工具栏/增删入口不在，真点下去数据也没变", async ({ page }) => {
    const docId = await seedSheet("表格验收只读", [
      { name: "Sheet1", rows: [["甲", "乙"], ["1", "2"]] },
    ]);
    await installDrawSpy(page);
    await asReader(page, docId);
    await openSheet(page, docId);
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(`/documents/${docId}`))
        patches.push(req.postData() ?? "");
    });
    const shape = await page.evaluate(`(() => {
      const host = document.querySelector('.sheet-canvas');
      const toolbar = host.querySelector('.x-spreadsheet-toolbar');
      const addLi = host.querySelector('.x-spreadsheet-bottombar .x-spreadsheet-menu > li');
      const resizer = host.querySelector('.x-spreadsheet-resizer');
      return {
        editorClass: document.querySelector('.sheet-editor').className,
        toolbarDisplay: toolbar ? getComputedStyle(toolbar).display : 'absent',
        addLiDisplay: addLi ? getComputedStyle(addLi).display : 'absent',
        resizerPointerEvents: resizer ? getComputedStyle(resizer).pointerEvents : 'absent',
        saveDisabled: document.querySelector('#saveDocument').disabled,
      };
    })()`);
    expect(shape.editorClass).toContain("sheet-readonly");
    expect(shape.toolbarDisplay, "只读还挂着工具栏").toBe("none");
    expect(shape.addLiDisplay, "只读还能新建工作表").toBe("none");
    expect(shape.resizerPointerEvents, "只读能拖行高列宽").toBe("none");
    expect(shape.saveDisabled, "只读可保存").toBe(true);

    // 三条库不看 mode 的写路径，真点一遍。
    const tab = page.locator(
      ".sheet-canvas .x-spreadsheet-bottombar .x-spreadsheet-menu > li",
    ).nth(1);
    await tab.dblclick();
    await page.keyboard.type("改名了");
    await page.keyboard.press("Enter");
    await tab.click({ button: "right" });
    const menuItems = await page.evaluate(
      `[...document.querySelectorAll('.sheet-canvas .x-spreadsheet-contextmenu .x-spreadsheet-item')].filter((el) => el.offsetParent !== null).length`,
    );
    const tabTexts = await page.evaluate(
      `[...document.querySelectorAll('.sheet-canvas .x-spreadsheet-bottombar .x-spreadsheet-menu > li')].map((li) => li.textContent.trim())`,
    );
    // 底栏 li[0] 是隐藏的「+」新建钮（display:none，见 shape.addLiDisplay），li[1] 才是真页签。
    // 判「改名被挡」要看行为：改名的字没落进任何页签、真页签（我们双击的那个）仍是 Sheet1。
    expect(
      tabTexts,
      "只读把页签名改成了「改名了」",
    ).not.toContain("改名了");
    expect(tabTexts[1], "只读改了页签名").toBe("Sheet1");
    // 键盘改格（mode:'read' 挡的那条）也真点一次，确保不是只测了补刀。
    await clickCell(page, 0, 0);
    await page.keyboard.type("Z");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);

    expect(menuItems, "只读还能开右键菜单 ⇒ 捕获阶段的拦截没生效").toBe(0);
    expect(patches, `只读发出了 ${patches.length} 次保存`).toHaveLength(0);
    const stored = await hubGet(`/documents/${docId}`);
    const body = (stored["document"] as { body_text?: string }).body_text ?? "";
    expect(
      body,
      "只读用户把数据改回去了",
    ).toContain(JSON.stringify([["甲", "乙"], ["1", "2"]]));
    const painted = await draws(page);
    // painted 是 {t,x,y}[]，toContain 得先映射到文字（对对象数组直接 toContain("甲")
    // 永远 false —— 元素是对象不是字符串）。只读挡下键盘改格后，正文仍应是甲/乙。
    const tokens = painted.map((d) => d.t);
    expect(tokens, "画布上的正文被改掉了").toContain("甲");
    expect(tokens, "键盘改格没被挡住").not.toContain("Z甲");
  });
});
