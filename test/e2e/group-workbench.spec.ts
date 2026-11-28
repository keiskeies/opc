import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import {
  connect,
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer,
} from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { migrate } from "../../packages/hub/src/db/migrate.js";
import { WriteQueue } from "../../packages/hub/src/db/write-queue.js";
import { InMemoryEventBus } from "../../packages/hub/src/events/bus.js";
import { buildHubDeps } from "../../packages/hub/src/http/real-deps.js";
import {
  type HubServer,
  serveHub,
} from "../../packages/hub/src/http/server.js";
import { hireMember } from "../../packages/hub/src/members/service.js";
import { DRIVER_OFF } from "../../packages/hub/test/fixtures/driver-state.js";

const ROOT = resolve(process.cwd());
const TOKEN = "group-ui-e2e-token";
let webPort = 0;
// Windows IPv4 临时端口可能被并行 E2E 占满。透明 TCP 中继让浏览器走 IPv6 回环，
// 代理上游绑定另一回环地址；HTTP、业务 API 与 SSE 仍是真实请求，不改产品或响应。
const WEB_AGENT_PRELOAD = `data:text/javascript,${encodeURIComponent(`
  import http from "node:http";
  import net from "node:net";
  class IsolatedLoopbackAgent extends http.Agent {
    createConnection(options) {
      const socket = net.createConnection({
        ...options,
        ...(options.host === "127.0.0.1" ? { localAddress: "127.0.0.2" } : {}),
      });
      return socket;
    }
  }
  http.globalAgent = new IsolatedLoopbackAgent({
    keepAlive: true,
    maxSockets: 16,
  });
`)}`;
const MARKET_MEMBER_ID = "market-pm-ui";
const MARKET_MEMBER_NAME = "人才市场验收产品经理";
const INITIAL_PERSONA = "先给结论，再列用户价值";
const REFRESHED_PERSONA = "先给结论，再列可验证里程碑";
const PRIVATE_EXECUTION_REPLY = "老板私聊自动化回复";
/** 1×1 透明 PNG —— 头像上传验收用的真字节，走的是真 multipart 之外的 base64 通道。 */
const AVATAR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
/** 每个用例一份字节：内容寻址去重会让后跑的用例复用先跑用例留下的行。 */
const HIRE_AVATAR_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNQSlsFAAHgATONopnaAAAAAElFTkSuQmCC";
let directory = "";
let queue: WriteQueue | null = null;
let hub: HubServer | null = null;
let web: ChildProcess | null = null;
let webRelay: TcpServer | null = null;
let webOrigin = "";
const relaySockets = new Set<Socket>();

async function availablePort() {
  const probe = createTcpServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once("error", rejectListen);
    probe.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    throw new Error("临时 TCP 探针未分配端口");
  }
  const port = address.port;
  await new Promise<void>((resolveClose) => probe.close(() => resolveClose()));
  return port;
}

test.beforeAll(async () => {
  webPort = await availablePort();
  directory = mkdtempSync(join(tmpdir(), "opc-group-ui-"));
  queue = new WriteQueue(join(directory, "hub.db"));
  const db = queue.writeConnection();
  migrate(db);
  const hired = await hireMember(queue, {
    req: {
      name: "产品经理",
      role_id: "product_director",
      model_tier: "execution",
      persona: {
        style: "结论先行",
        values: ["用户价值"],
        honesty: "不确定就说明",
      },
      skills: [],
      executors: [
        {
          seq: 1,
          kind: "pure-model",
          config: { kind: "pure-model" },
          enabled: true,
        },
      ],
      tone: "direct",
      seat_group_ids: [],
    },
    nowMs: Date.now(),
    newId: () => "pm-ui",
  });
  expect(hired.ok).toBe(true);
  const marketHired = await hireMember(queue, {
    req: {
      name: MARKET_MEMBER_NAME,
      role_id: "product_director",
      model_tier: "execution",
      persona: {
        style: INITIAL_PERSONA,
        values: ["用户价值"],
        honesty: "不确定就说明",
      },
      skills: [],
      executors: [
        {
          seq: 1,
          kind: "pure-model",
          config: { kind: "pure-model" },
          enabled: true,
        },
      ],
      tone: "direct",
      seat_group_ids: [],
    },
    nowMs: Date.now(),
    newId: () => MARKET_MEMBER_ID,
  });
  expect(marketHired.ok).toBe(true);
  const deps = buildHubDeps({
    queue,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => Date.now(),
    driverState: () => DRIVER_OFF,
    callModel: async () => ({
      text:
        `${PRIVATE_EXECUTION_REPLY}。\n\n<<<OPC_DECISION>>>\n` +
        JSON.stringify({
          action: "pass",
          summary: "老板私聊指令已执行",
        }),
    }),
  });
  hub = await serveHub(deps, { port: 0 });
  web = spawn(
    process.execPath,
    ["--import", WEB_AGENT_PRELOAD, "packages/web/dist/dev-server.js"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ORG_TOKEN: TOKEN,
        HUB_PORT: String(hub.port),
        WEB_PORT: String(webPort),
      },
      stdio: "pipe",
    },
  );
  await expect
    .poll(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${webPort}/`);
        return response.ok;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const admin = await fetch(`http://127.0.0.1:${webPort}/admin`);
  expect(admin.status).toBe(404);

  webRelay = createTcpServer((client) => {
    const upstream = connect({
      port: webPort,
      host: "127.0.0.1",
      localAddress: "127.0.0.2",
    });
    relaySockets.add(client);
    relaySockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.on("close", () => {
      relaySockets.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      relaySockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    if (webRelay === null) return rejectListen(new Error("TCP relay 未创建"));
    webRelay.once("error", rejectListen);
    webRelay.listen(0, "::1", () => {
      const address = webRelay?.address();
      if (
        address === null ||
        address === undefined ||
        typeof address === "string"
      )
        return rejectListen(new Error("TCP relay 未分配端口"));
      webOrigin = `http://[::1]:${address.port}`;
      resolveListen();
    });
  });
});

test.afterAll(async () => {
  for (const socket of relaySockets) socket.destroy();
  if (webRelay !== null)
    await new Promise<void>((resolveClose) =>
      webRelay?.close(() => resolveClose()),
    );
  if (web !== null) {
    web.kill();
    await new Promise<void>((resolveExit) => {
      if (web === null || web.exitCode !== null) return resolveExit();
      web.once("exit", () => resolveExit());
    });
  }
  if (hub !== null) await hub.close();
  if (queue !== null) await queue.close();
  if (directory !== "") rmSync(directory, { recursive: true, force: true });
});

test("任务面板：真实 UI 创建站会与 manual 调研并打开生成文档", verifyTaskPanel);

interface GroupCreateResponse {
  group: { group_id: string };
  document: { ok: boolean; doc_id: string };
}

async function createGroupThroughUi(
  page: Page,
  title: string,
  goal: string,
  withProductManager = false,
): Promise<GroupCreateResponse> {
  await page.locator("#createButton").click();
  await page.locator('[data-create="group"]').click();
  const dialog = page.getByRole("dialog", { name: "新建群" });
  await dialog.locator('input[name="title"]').fill(title);
  await dialog.locator('textarea[name="goal"]').fill(goal);
  if (withProductManager)
    await dialog
      .getByRole("checkbox", { name: "产品经理 · 产品总监", exact: true })
      .check();
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/groups",
  );
  await dialog.getByRole("button", { name: "创建群", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const created = (await response.json()) as GroupCreateResponse;
  expect(created.document.ok).toBe(true);
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  await expect(page.locator("#toastRegion")).toContainText("群已创建");
  return created;
}

test("群会话视图：真实建群章程、CoS 派发后的待办与跨群隔离", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);

  await page.goto(`${webOrigin}/`);
  await expect(page).toHaveTitle(/群角色工作台/u);
  await expect(
    page.getByRole("navigation", { name: "应用导航" }),
  ).toBeVisible();
  await expect(page.locator("#listPane")).toBeVisible();
  await expect(page.locator("#mainPane")).toBeVisible();
  expectNoBrowserErrors(browserErrors);

  const first = await createGroupThroughUi(
    page,
    "双十一大促",
    "按时上线",
    true,
  );
  await page
    .locator(".conversation-item")
    .filter({ hasText: "双十一大促" })
    .click();
  await expect(page.locator('textarea[name="body"]')).toBeVisible();
  await expect(page.locator('textarea[name="body"]')).toBeEnabled();
  const tabs = page.getByRole("tablist", { name: "群会话视图" });
  await expect(tabs.getByRole("tab")).toHaveCount(3);
  await expect(
    tabs.getByRole("tab", { name: "消息", exact: true }),
  ).toHaveAttribute("aria-selected", "true");

  await tabs.getByRole("tab", { name: "消息", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    tabs.getByRole("tab", { name: "任务流", exact: true }),
  ).toBeFocused();
  await expect(
    tabs.getByRole("tab", { name: "任务流", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toContainText("本群还没有待办");
  // 落点实测（round374 · tw:text-balance）：空态标题走 emptyState()，一处改动覆盖 ~15 个
  // 空态。这里不判「源码里加了类名」而判【真浏览器算出来的那一条声明】—— 类名拼错、h()
  // 覆盖 class、这条渲染路径根本没走到，三种都会让「改了 8 处」与「页面上一处没生效」
  // 同时成立。第二发是窗口干净度：未挂 utility 的同级说明文字必须仍是 initial，
  // 否则「读到 balance」可能来自某张手写表而不是这枚 utility。
  await expect(page.locator(".state h3.tw\\:text-balance")).toHaveCSS(
    "text-wrap",
    "balance",
  );
  await expect(page.locator(".state p:not(.tw\\:text-balance)")).toHaveCSS(
    "text-wrap",
    "wrap",
  );
  await tabs
    .getByRole("tab", { name: "任务流", exact: true })
    .press("ArrowRight");
  const documentsTab = tabs.getByRole("tab", { name: "文档区", exact: true });
  await expect(documentsTab).toBeFocused();
  await expect(documentsTab).toHaveAttribute("aria-selected", "true");

  const charter = page.locator(`[data-document-id="${first.document.doc_id}"]`);
  await expect(charter).toContainText("立项：双十一大促");
  // 落点实测：文档卡标题（.group-document-title）在这一条真渲染路径上必须算出 balance。
  // 同一个 locator 已经证明这张卡在场上，所以这一发红只可能是「类名没接对」这一种因。
  await expect(
    charter.locator(".group-document-title.tw\\:text-balance"),
  ).toHaveCSS("text-wrap", "balance");
  await expect(charter).toContainText("自动生成");
  await charter.click();
  await expect(page).toHaveURL(
    new RegExp(`#/documents/${first.document.doc_id}$`, "u"),
  );
  await expect(page.getByLabel("文档标题")).toHaveValue("立项：双十一大促");
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toHaveValue(/按时上线/u);

  await page.locator('[data-nav="messages"]').click();
  await page
    .locator(".conversation-item")
    .filter({ hasText: "双十一大促" })
    .click();
  await page.locator('textarea[name="body"]').fill("立项：双十一");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".message-stream")).toContainText("这件事由你跟进");
  await expect(page.locator(".message-stream")).toContainText("任务 task-");

  // 当前后端的 CoS 派发写治理 tasks，不写 backlog_items；用既有待办写入链路
  // 建立可持久化条目，再验证群任务流读取最新 state.backlog，不伪造派发结果。
  await page.locator('[data-nav="backlog"]').click();
  await page.getByRole("button", { name: "新建待办", exact: true }).click();
  const backlogDialog = page.getByRole("dialog", { name: "新建待办" });
  await backlogDialog.locator('input[name="title"]').fill("大促落地页验收");
  await backlogDialog
    .locator('select[name="group_id"]')
    .selectOption(first.group.group_id);
  const backlogResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/backlog",
  );
  await backlogDialog
    .getByRole("button", { name: "创建", exact: true })
    .click();
  const backlogResponse = await backlogResponsePromise;
  expect(backlogResponse.ok()).toBe(true);
  await expect(backlogDialog).toBeHidden();
  await expect(page.locator("#listContent")).toContainText("大促落地页验收");

  await page.locator('[data-nav="messages"]').click();
  await page
    .locator(".conversation-item")
    .filter({ hasText: "双十一大促" })
    .click();
  await tabs.getByRole("tab", { name: "任务流", exact: true }).click();
  const task = page.getByRole("button", { name: "打开待办：大促落地页验收" });
  await expect(task).toBeVisible();
  await expect(
    page.locator('.group-task-group[data-status="backlog"]'),
  ).toContainText("大促落地页验收");
  // 落点实测：待办卡标题。这一发刻意放在【刚创建完待办】之后 —— 前一条 toContainText
  // 只证明文字进了 DOM，这一条证明那枚 utility 在真浏览器里算得出 balance。
  await expect(
    page.locator(
      '.group-task-group[data-status="backlog"] .group-task-title.tw\\:text-balance',
    ),
  ).toHaveCSS("text-wrap", "balance");
  await task.click();
  await expect(page).toHaveURL(/#\/backlog\/[^/]+$/u);
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "大促落地页验收",
      exact: true,
    }),
  ).toBeVisible();

  await page.locator('[data-nav="messages"]').click();
  const second = await createGroupThroughUi(page, "双十二复盘", "沉淀经验");
  await page
    .locator(".conversation-item")
    .filter({ hasText: "双十二复盘" })
    .click();
  await expect(
    tabs.getByRole("tab", { name: "消息", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await tabs.getByRole("tab", { name: "文档区", exact: true }).click();
  await expect(
    page.locator(`[data-document-id="${second.document.doc_id}"]`),
  ).toContainText("立项：双十二复盘");
  await expect(page.locator("#group-chat-panel")).not.toContainText(
    "立项：双十一大促",
  );
  await page.getByRole("button", { name: "新建群文档", exact: true }).click();
  const documentDialog = page.getByRole("dialog", { name: "新建文档" });
  await expect(documentDialog.locator('select[name="group_id"]')).toHaveValue(
    second.group.group_id,
  );
  await documentDialog
    .getByRole("button", { name: "取消", exact: true })
    .click();

  await tabs.getByRole("tab", { name: "任务流", exact: true }).click();
  await expect(page.getByRole("tabpanel")).toContainText("本群还没有待办");
  await expect(page.locator("#group-chat-panel")).not.toContainText(
    "大促落地页验收",
  );
  await page
    .locator(".conversation-item")
    .filter({ hasText: "双十一大促" })
    .click();
  await tabs.getByRole("tab", { name: "任务流", exact: true }).click();
  await expect(task).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ["任务流", "文档区"]) {
    await tabs.getByRole("tab", { name, exact: true }).click();
    expect(
      await page.evaluate(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
  }

  await page.locator("#createButton").click();
  await page.locator('[data-create="member-private"]').click();
  const privateDialog = page.getByRole("dialog", {
    name: "私聊成员（成员间）",
  });
  await privateDialog.locator('select[name="member_a"]').selectOption("pm-ui");
  await privateDialog
    .locator('select[name="member_b"]')
    .selectOption(MARKET_MEMBER_ID);
  const privateResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/api/v1/conversations/private/open-private",
  );
  await privateDialog
    .getByRole("button", { name: "打开成员间私聊", exact: true })
    .click();
  const privateResponse = await privateResponsePromise;
  expect(privateResponse.ok()).toBe(true);
  await expect(privateDialog).toBeHidden();
  await expect(page.locator('textarea[name="body"]')).toBeVisible();
  await expect(page.getByRole("tablist", { name: "群会话视图" })).toHaveCount(
    0,
  );
  expectNoBrowserErrors(browserErrors);
});

test("招聘落座：真实入职后在群会话出现成员署名报到", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  const groupTitle = "招聘报到群";
  const memberName = "招聘报到验收员";
  await page.goto(`${webOrigin}/`);
  const created = await createGroupThroughUi(
    page,
    groupTitle,
    "验证招聘落座后的自动报到",
  );

  // 建群后的 SSE 快照刷新会重绘招聘表单；重新加载后再走真实招聘流程，
  // 避免把异步投影刷新误判成招聘请求未发出。
  await page.reload();
  await page.locator('[data-nav="talent"]').click();
  await page.getByRole("button", { name: "开始招聘", exact: true }).click();
  const submit = page.getByRole("button", {
    name: "完成招聘并入职",
    exact: true,
  });
  const form = page.locator("form").filter({ has: submit });
  await form.locator('input[name="name"]').fill(memberName);
  await form.locator('select[name="role_id"]').selectOption("dev");
  await form.locator('select[name="tone"]').selectOption("direct");
  await form.locator('input[name="avatar_seed"]').fill("hire-greeting-e2e");
  await form.locator('input[name="persona_style"]').fill("先读上下文再发言");
  await form.locator('input[name="persona_honesty"]').fill("不确定就说明");
  await form.locator('input[name="skill_id"]').fill("greeting-check");
  await form.locator('input[name="skill_name"]').fill("报到链路验收");
  await form.getByRole("checkbox", { name: groupTitle, exact: true }).check();
  const hireResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/members",
  );
  await submit.click();
  const hireResponse = await hireResponsePromise;
  expect(hireResponse.ok()).toBe(true);
  const hired = (await hireResponse.json()) as {
    ok: boolean;
    member: { member_id: string };
    greetings: {
      group_id: string;
      conversation_id: string;
      message_id: string;
      error?: string;
    }[];
  };
  expect(hired.ok).toBe(true);
  expect(hired.greetings).toEqual([
    {
      group_id: created.group.group_id,
      conversation_id: expect.any(String),
      message_id: expect.any(String),
    },
  ]);
  await expect(page.locator("#toastRegion")).toContainText("成员已招聘并入职");

  await page.locator('[data-nav="messages"]').click();
  await page
    .locator(".conversation-item")
    .filter({ hasText: groupTitle })
    .click();
  const greeting = page
    .locator(".message-row.member")
    .filter({ hasText: memberName });
  await expect(greeting).toHaveCount(1);
  await expect(greeting).toContainText(`大家好，我是${memberName}`);
  await expect(greeting).toContainText("岗位是开发工程师");
  await expect(greeting).toContainText("我会以直接的方式沟通");
  expectNoBrowserErrors(browserErrors);
});

// 招聘表单里那枚图片选择器是另一根线（与成员设置页那两处不是同一格 DOM）：
// 上传必须把 asset_id 交给【本次招聘】的请求体，否则招进来的成员头像仍是生成的。
test("招聘用工照：选图上传后入职请求带的是 avatar_asset_id 而不是种子", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="talent"]').click();
  await page.getByRole("button", { name: "开始招聘", exact: true }).click();
  const submit = page.getByRole("button", {
    name: "完成招聘并入职",
    exact: true,
  });
  const form = page.locator("form").filter({ has: submit });
  const memberName = "用工照入职验收员";
  await form.locator('input[name="name"]').fill(memberName);
  await form.locator('select[name="role_id"]').selectOption("dev");
  await form.locator('select[name="tone"]').selectOption("direct");
  await form.locator('input[name="persona_style"]').fill("先给证据");
  await form.locator('input[name="persona_honesty"]').fill("不确定就说明");
  await form.locator('input[name="skill_id"]').fill("avatar-check");
  await form.locator('input[name="skill_name"]').fill("头像链路验收");

  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/assets",
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await form
    .getByRole("button", { name: "上传图片作为头像", exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "hire-avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(HIRE_AVATAR_PNG_BASE64, "base64"),
  });
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBe(true);
  expect(uploadResponse.request().postDataJSON()).toMatchObject({
    purpose: "avatar",
  });
  const assetId = (
    (await uploadResponse.json()) as {
      asset: { asset_id: string };
    }
  ).asset.asset_id;
  await expect(form.locator('input[name="avatar_asset_id"]')).toHaveValue(
    assetId,
  );

  const hirePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/members",
  );
  await submit.click();
  const hireResponse = await hirePromise;
  expect(hireResponse.ok()).toBe(true);
  expect(hireResponse.request().postDataJSON()).toMatchObject({
    name: memberName,
    avatar_asset_id: assetId,
  });
  const hired = (await hireResponse.json()) as {
    member: { member_id: string; avatar_asset_id: string | null };
  };
  expect(hired.member.avatar_asset_id).toBe(assetId);

  const stored = await page.evaluate(async (id) => {
    const res = await fetch("/api/v1/members");
    const body = (await res.json()) as {
      members: { member_id: string; avatar_asset_id: string | null }[];
    };
    return (
      body.members.find((m) => m.member_id === id)?.avatar_asset_id ?? null
    );
  }, hired.member.member_id);
  expect(stored).toBe(assetId);

  expectNoBrowserErrors(browserErrors);
});

test("老板成员私聊：通讯录直开、老板发消息与文档关联成员复用同一会话", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  await createGroupThroughUi(
    page,
    "老板私聊验收",
    "验证默认老板成员私聊",
    true,
  );
  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="contacts"]').click();
  const contact = page
    .locator('#listContent [data-group-row=""]')
    .filter({ hasText: "老板私聊验收" })
    .locator(".member-row")
    .filter({ hasText: "产品经理" });
  await expect(contact).toBeVisible();
  await contact.click();
  const memberAvatar = page.locator(".detail-hero .avatar img");
  await expect(memberAvatar).toBeVisible();
  const memberAvatarSrc = await memberAvatar.getAttribute("src");
  expect(memberAvatarSrc).toBeTruthy();

  const openResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/api/v1/conversations/private/open-private",
  );
  await page.getByRole("button", { name: "与老板私聊", exact: true }).click();
  const openResponse = await openResponsePromise;
  expect(openResponse.ok()).toBe(true);
  expect(openResponse.request().postDataJSON()).toEqual({
    member_a: "boss",
    member_b: "pm-ui",
  });
  const opened = (await openResponse.json()) as {
    created: boolean;
    conversation: {
      conversation_id: string;
      kind: string;
      member_a: string;
      member_b: string;
    };
  };
  expect(opened.created).toBe(true);
  expect(opened.conversation.kind).toBe("private");
  expect([opened.conversation.member_a, opened.conversation.member_b]).toEqual(
    expect.arrayContaining(["boss", "pm-ui"]),
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "产品经理", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".chat-header")).toContainText(
    "老板 · 私聊成员（老板）",
  );
  await expect(page.locator(".chat-header .avatar img")).toHaveAttribute(
    "src",
    memberAvatarSrc || "",
  );

  const message = "老板私聊验收消息";
  await page.locator('textarea[name="body"]').fill(message);
  const privateMessageResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${opened.conversation.conversation_id}/messages`,
  );
  await page.getByRole("button", { name: "发送", exact: true }).click();
  const privateMessageResponse = await privateMessageResponsePromise;
  expect(privateMessageResponse.ok()).toBe(true);
  const privateMessageBody = (await privateMessageResponse.json()) as {
    dispatch: { ok: true; taskId: string; execution_started: boolean };
  };
  expect(privateMessageBody.dispatch).toMatchObject({
    ok: true,
    execution_started: true,
  });
  const privateTaskId = privateMessageBody.dispatch.taskId;
  await expect(page.locator(".message-stream")).toContainText(message);
  await expect(page.locator(".message-stream")).toContainText(
    `执行完成：${PRIVATE_EXECUTION_REPLY}`,
  );
  const conversationRow = page.locator(
    `.conversation-row[data-conversation-id="${opened.conversation.conversation_id}"]`,
  );
  await expect(conversationRow).toContainText(PRIVATE_EXECUTION_REPLY);
  await expect(conversationRow.locator(".unread")).toHaveCount(0);

  await page.locator('[data-nav="documents"]').click();
  const executionDocument = page
    .locator("#listContent .doc-list-item")
    .filter({ hasText: `执行结果：${privateTaskId}` });
  await expect(executionDocument).toBeVisible();
  await executionDocument.click();
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toHaveValue(new RegExp(privateTaskId, "u"));
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toHaveValue(new RegExp(PRIVATE_EXECUTION_REPLY, "u"));
  await page.locator('[data-nav="documents"]').click();
  await page
    .locator("#listContent .doc-list-item")
    .filter({ hasText: "立项：老板私聊验收" })
    .click();
  // 关联区块在 round370 从正文流搬进了右侧抽屉：抽屉默认收起（visibility:hidden），
  // 收起态里 toContainText 靠 DOM 文本也会过 —— 那测的是「写进了 DOM」而不是「用户能看到」。
  // 所以这里显式打开抽屉，并先断可见，再断内容。
  await page.getByRole("button", { name: "权限与设置", exact: true }).click();
  const associations = page
    .locator("#mainPane .doc-drawer-wrap")
    .getByRole("region", { name: "文档关联" });
  await expect(associations).toBeVisible();
  await expect(associations).toContainText("老板私聊验收");
  await expect(associations).toContainText("产品经理");
  await expect(associations).toContainText("暂无关联任务");
  await expect(associations).toContainText("暂无关联会议");
  const reopenResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        "/api/v1/conversations/private/open-private",
  );
  await associations
    .getByRole("button", { name: "与老板私聊：产品经理", exact: true })
    .click();
  const reopenResponse = await reopenResponsePromise;
  expect(reopenResponse.ok()).toBe(true);
  expect(reopenResponse.request().postDataJSON()).toEqual({
    member_a: "boss",
    member_b: "pm-ui",
  });
  const reopened = (await reopenResponse.json()) as {
    created: boolean;
    conversation: { conversation_id: string };
  };
  expect(reopened.created).toBe(false);
  expect(reopened.conversation.conversation_id).toBe(
    opened.conversation.conversation_id,
  );
  await expect(page.locator(".message-stream")).toContainText(message);
  expectNoBrowserErrors(browserErrors);
});

interface ConversationFixture {
  conversation_id: string;
  kind: "group" | "private";
  title: string;
  unread_count: number;
  boss_attention_count?: number;
  /**
   * ⚠ 形状必须与契约一致：packages/contracts/src/conversation.ts 把这两个时刻钉成
   * `z.number().int()`（epoch 毫秒），不是 ISO 串。夹具此前写 ISO 串，而 ISO 恰好是
   * `Date.parse` 唯一吃得进去的形状 ⇒ 「按最近时刻排序」在夹具里永远成立、在真库里
   * 永远失效（Date.parse 喂数字恒 NaN，整条排序静默退化成按 id 排）。
   * 谁把这里改回字符串，下面那条「段内按最近时刻倒序」用例当场红。
   */
  last_message_at: number | null;
  last_message_preview: string;
  /** 时刻缺失时的兜底，同契约的 nullable 分支：null 时刻必须落回这一列。 */
  created_at?: number;
}

const DEFAULT_CONVERSATIONS: ConversationFixture[] = [
  {
    conversation_id: "attention-group",
    kind: "group",
    title: "急需拍板",
    unread_count: 8,
    boss_attention_count: 3,
    last_message_at: Date.parse("2026-11-25T09:00:00.000Z"),
    last_message_preview: "请确认预算",
  },
  {
    conversation_id: "pinned-private-new",
    kind: "private",
    title: "私聊置顶新",
    unread_count: 4,
    boss_attention_count: 0,
    last_message_at: Date.parse("2026-11-25T08:00:00.000Z"),
    last_message_preview: "最新私聊",
  },
  {
    conversation_id: "pinned-private-old",
    kind: "private",
    title: "私聊置顶旧",
    unread_count: 0,
    last_message_at: Date.parse("2026-11-25T07:00:00.000Z"),
    last_message_preview: "较早私聊",
  },
  {
    conversation_id: "ordinary-group",
    kind: "group",
    title: "普通未读群",
    unread_count: 6,
    last_message_at: Date.parse("2026-11-25T06:00:00.000Z"),
    last_message_preview: "只有未读，不需要拍板",
  },
  {
    conversation_id: "ordinary-private",
    kind: "private",
    title: "普通已读私聊",
    unread_count: 0,
    boss_attention_count: 0,
    last_message_at: Date.parse("2026-11-25T05:00:00.000Z"),
    last_message_preview: "普通消息",
  },
];

/**
 * 用 conversations 覆盖默认夹具，而不是在每个用例里重抄一遍 route：夹具形状本身
 * 是判据的一部分（见 ConversationFixture 的 ⚠），所以只允许这一处组装响应。
 */
async function mockConversationList(
  page: Page,
  conversations: ConversationFixture[] = DEFAULT_CONVERSATIONS,
) {
  await page.route("**/api/v1/conversations", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: { conversations } });
  });
}

test("会话列表：拍板按 boss_attention_count 分组，置顶去重且持久化", async ({
  page,
}) => {
  await mockConversationList(page);
  await page.addInitScript(() => {
    if (localStorage.getItem("opc:pinned-conversations") === null) {
      localStorage.setItem(
        "opc:pinned-conversations",
        JSON.stringify([
          "attention-group",
          "pinned-private-new",
          "pinned-private-old",
        ]),
      );
    }
  });
  await page.goto(`${webOrigin}/`);

  const attention = page.locator(
    '.conversation-section[data-section="attention"]',
  );
  const pinned = page.locator('.conversation-section[data-section="pinned"]');
  await expect(attention.locator(".conversation-item")).toHaveCount(1);
  await expect(attention).toContainText("急需拍板");
  await expect(attention.locator(".boss-count")).toHaveText("3");
  await expect(attention).not.toContainText("普通未读群");
  await expect(pinned.locator(".conversation-item")).toHaveCount(2);
  await expect(pinned.locator(".conversation-item").first()).toContainText(
    "私聊置顶新",
  );
  await expect(pinned).not.toContainText("急需拍板");
  await expect(
    page.locator('.conversation-section[data-section="group"]'),
  ).toContainText("普通未读群");
  await expect(
    page.locator('.conversation-section[data-section="group"]'),
  ).not.toContainText("急需拍板");
  await expect(page.locator("#listContent .conversation-item")).toHaveCount(5);

  const recentPrivate = page.locator(
    '[data-conversation-id="pinned-private-new"]',
  );
  await recentPrivate.getByRole("button", { name: "取消置顶" }).click();
  await expect(pinned.locator(".conversation-item")).toHaveCount(1);
  await expect(
    page.locator('.conversation-section[data-section="private"]'),
  ).toContainText("私聊置顶新");
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("opc:pinned-conversations") || "[]"),
    ),
  ).not.toContain("pinned-private-new");

  const ordinaryGroup = page.locator('[data-conversation-id="ordinary-group"]');
  await ordinaryGroup
    .getByRole("button", { name: "置顶", exact: true })
    .click();
  await expect(pinned).toContainText("普通未读群");
  await expect(
    page.locator('.conversation-section[data-section="group"]'),
  ).toHaveCount(0);
  await page.reload();
  await expect(pinned).toContainText("普通未读群");
  await expect(
    page.locator('.conversation-section[data-section="private"]'),
  ).toContainText("私聊置顶新");
  await expect(
    page.locator('.conversation-section[data-section="group"]'),
  ).toHaveCount(0);
});

/**
 * 会话列表段内排序（round376）。
 *
 * ── 这一发为什么单独存在，而不并进上面那条分组用例 ──────────────
 * 上面那条只数「每段几行 + 谁在哪段」，一段内两三行时**任何稳定顺序都过**：
 * 排序整条失效（比较器恒返回 0 ⇒ 退化成 id 升序）时它照样绿。本仓的真库就是这么
 * 静默坏的：契约把 last_message_at 钉成 epoch 毫秒，而 Date.parse 只吃字符串，
 * 喂数字恒 NaN ⇒ 每条 recency 落 0。夹具写 ISO 串时，那个 bug 在测试里【不存在】。
 *
 * ── 判据的两处刻意形状 ─────────────────────────────────────────
 * ① id 取 zz/mm/aa 前缀，让「id 升序」正好等于「时间倒序的反面」：排序一失效，
 *    顺序整个倒过来，而不是恰好撞上同一串。
 * ② 夹一条 last_message_at 为 null、只有 created_at 的，插在中间：
 *    兜底链（|| created_at）摘掉 ⇒ 它 recency 落 0 掉到最后；时刻读成字符串 ⇒
 *    四条全落 0 ⇒ id 升序。两种失效都被同一条顺序断言抓到。
 */
test("会话列表段内按最近时刻倒序：epoch 毫秒可读，缺最新消息时落回 created_at", async ({
  page,
}) => {
  await mockConversationList(page, [
    {
      conversation_id: "aa-oldest",
      kind: "group",
      title: "最早的一群",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: 1_795_000_100_000,
      last_message_preview: "第一条消息",
    },
    {
      conversation_id: "bb-created-fallback",
      kind: "group",
      title: "还没有消息的群",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: null,
      created_at: 1_795_000_900_000,
      last_message_preview: "",
    },
    {
      conversation_id: "mm-middle",
      kind: "group",
      title: "中间的一群",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: 1_795_000_800_000,
      last_message_preview: "第二条消息",
    },
    {
      conversation_id: "zz-newest",
      kind: "group",
      title: "最新的一群",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: 1_795_001_000_000,
      last_message_preview: "第三条消息",
    },
  ]);
  await page.goto(`${webOrigin}/`);

  const group = page.locator('.conversation-section[data-section="group"]');
  await expect(group.locator(".conversation-item")).toHaveCount(4);
  await expect(group.locator(".conversation-item")).toHaveText([
    /最新的一群/,
    /还没有消息的群/,
    /中间的一群/,
    /最早的一群/,
  ]);
});

/** 排版门共用的两行夹具：同一时刻（不让段内排序搅乱下标）+ 一短一长两条预览。 */
function typoFixtures(
  shortChars: number,
  longChars: number,
): ConversationFixture[] {
  return [
    {
      conversation_id: "type-fits",
      kind: "group",
      title: "放得下的一行",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: 1_795_000_200_000,
      last_message_preview: "汉".repeat(shortChars),
    },
    {
      conversation_id: "type-truncates",
      kind: "group",
      title: "放不下的一行",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: 1_795_000_200_000,
      last_message_preview: "汉".repeat(longChars),
    },
  ];
}

interface RowGeometry {
  id: string;
  rowH: number;
  prevH: number;
  prevFs: number;
  lines: number;
  fits: boolean;
  track: number;
  scroll: number;
  overflowX: number;
}

/**
 * 逐行取运行时几何，不读 CSS 声明值。范围锁在群段里 —— 会议行用的是同一套
 * .conversation-item 类名，全局查会把它们一起捞进来。
 * ⚠ lines 不能直接取 Range.getClientRects() 的条数：text-overflow:ellipsis 会在省略号处
 * 把这一行切成两个 fragment（同 top），实测 17 字那行返回 2 条。按 top 去重后量的才是
 * 「几个行高」。
 */
async function measureRows(page: Page): Promise<RowGeometry[]> {
  const raw = await page.evaluate(`(() => {
    const out = [];
    const scope = document.querySelector('.conversation-section[data-section="group"]');
    const list = document.querySelector('.list-content');
    for (const item of scope.querySelectorAll('.conversation-item')) {
      const prev = item.querySelector('.conversation-preview');
      const r = document.createRange();
      r.selectNodeContents(prev);
      out.push({
        id: item.dataset.conversationId,
        rowH: Math.round(item.getBoundingClientRect().height),
        prevH: prev.getBoundingClientRect().height,
        prevFs: parseFloat(getComputedStyle(prev).fontSize),
        lines: [
          ...new Set(
            [...r.getClientRects()]
              .filter((x) => x.width > 0)
              .map((x) => Math.round(x.top)),
          ),
        ].length,
        fits: prev.scrollWidth <= prev.clientWidth,
        track: Math.round(prev.clientWidth),
        scroll: Math.round(prev.scrollWidth),
        overflowX: Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          list.scrollWidth - list.clientWidth,
        ),
      });
    }
    return JSON.stringify(out);
  })()`);
  return JSON.parse(raw as string) as RowGeometry[];
}

/** 预览/标题/时间的字号阶梯 + 段标签的字距声明值。 */
async function measureTypeScale(page: Page) {
  const raw = await page.evaluate(`(() => {
    const item = document.querySelector('.conversation-item');
    const px = (v) => Math.round(parseFloat(v));
    const tok = (n) => px(getComputedStyle(document.documentElement).getPropertyValue(n));
    const of = (sel) => px(getComputedStyle(item.querySelector(sel)).fontSize);
    const label = getComputedStyle(document.querySelector('.list-section'));
    return JSON.stringify({
      title: of('.conversation-title'),
      preview: of('.conversation-preview'),
      time: of('.conversation-time'),
      sm: tok('--fs-sm'),
      labelSpacing: label.letterSpacing,
      labelTransform: label.textTransform,
    });
  })()`);
  return JSON.parse(raw as string) as {
    title: number;
    preview: number;
    time: number;
    sm: number;
    labelSpacing: string;
    labelTransform: string;
  };
}

/**
 * 会话列表的排版门（round376）：字号阶梯、段标签字距、一行的宽度预算、行高预算。
 *
 * ── 四条判据各钉哪根线 ────────────────────────────────────────
 *  T1 预览字号取 --fs-sm，且严格夹在「时间(--fs-xs)」与「标题(--fs-md)」之间：
 *     原先预览写死 11px、和时间同字号同灰度，正文与元信息之间缺一级，两层读成一坨。
 *  T2 段标签不吃 letter-spacing / text-transform：这里的标签全是中文，uppercase 是恒等
 *     变换，而 .08em 在 11px 上逐字加 0.88px（实测把两字标签从 22px 撑到 24px）。
 *  T3 一行的宽度预算（行为判据，不量像素宽）：同一条轨道里某一数字放得下、+3 字放不下。
 *     改窄 --list-width 会红、再放宽不会 —— 判据直接就是症状本身（预览被切成半句话），
 *     所以加宽 padding、加宽 tail 列、加大字号都抓得住。
 *     第二行是【窗口自证】：它必须仍然截断，否则第一行的绿只是因为预览不再截断了。
 *  T4 拆成两条（T4b 整行预算 + T4a 行高跟着字号走）。原判据「rowH < 60 杀行高」的形状
 *     在 round379 被本轮改动解除武装，行高那一格另立了判据，两边账分开写。
 *     T4b round379 之后实测 54.33，分解：上下 padding 16 + copy 38.33
 *     （标题行 20.14 + margin-top 2 + 预览行 16.19）。改前是 58.33 = padding 20 + 同一份 copy；
 *     本轮把 .conversation-item 的纵向内距 10 → 8，省下的 4px 全在内距上，copy 一格没动。
 *     ⚠ 地板仍是 .kind-icon{height:38px}：16+38=54 一直在兜着这一行，copy 只比它多出 0.33px，
 *     所以摘掉 margin-top 行盒仍是 54（P1 那发就是这么存活的 —— margin-top 被地板吸收了，
 *     几何判据管不到它）。地板的存在由复跑档 .workbuddy/round379-rowbox-after.log 的
 *     strutKilled 档撑：给 .conversation-item 写 line-height:0 之后标题行塌成 0、
 *     copy 只剩 18.19，行盒仍读 54（改前的同一档读 58，见 round376-rowbox.log）。
 *     T4a 预览那一行的行高跟着字号走。
 *     判据是相对量：预览盒高 ≤ 字号 × 1.45。声明 line-height:1.35 在 --fs-sm=12px 上实测
 *     16.19px（阈值 17.4）⇒ 绿；摘掉那条声明它退回继承值 body 的 1.55 ⇒ 18.59 ⇒ 红。
 *     为什么不再拿整行 rowH 当这把尺子：本轮把纵向内距 10 → 8 之后，同一发变异在整行上
 *     只走到 56.73（= pad 16 + copy 40.73），而阈值是 60 —— 判据还在跑，但已经不吃这根线了
 *     （改前那一份读的是 60.73，那才是 60 这一档的来由）。这是 memory 里「地板吸收」那一族
 *     的第二次复发：整行 = 地板与 copy 的较大者 + padding，任何一处挪动都会让另一处的变异
 *     量不出来 ⇒ 尺子要贴着【被那根线直接撑高的那一层】。分解复跑见
 *     .workbuddy/round379-rowbox-after.log 的 inheritBody 档（row=56.73 / prev=18.59；
 *     改前同档 row=60.73，见 .workbuddy/round376-rowbox.log）。这一格自己的变异证据：
 *     .workbuddy/round379-t4-mutations.log —— Q1 全摘声明 / Q2 放松到 1.5 / Q3 窄档同线，
 *     三发全 KILLED，而 Q4（内距 8 → 10）按【期望 SURVIVED】登记：见下面那条代价。
 *     阈值仍是 60 而【没有】跟着内距一起收到 56：60 不是量出来的刻度，是「离地板 54 留
 *     亚像素余量」那一档；而「内距被放回去」这一格已经有 test/web/compact-scale.test.ts
 *     的刻度表⑨ 单向钉着（8 → 11 当场红），再在这里抄一份字面 56 属于同一条主张立两处判据
 *     —— 下一轮真收档时得同时改两个数，那正是 round377 记过的反模式。
 *     ⚠ 代价一起写明白：60 这一格现在【抓不住】两件事 —— 内距放回 20（改前读数 58.33 < 60）
 *     和预览行高退回 1.55（56.73 < 60）。那两格各有其主（刻度表⑨ / 上面那条行高判据），
 *     这一格只管「整行不许比地板 + 余量更胖」。登记在此，免得下一个人把绿当成覆盖面。
 *     ⚠ 别把「删声明」与 line-height:normal 混为一谈：normal 在 12px 上读 16（整行 54.14），
 *     删声明退回继承值 1.55（整行 56.73），差 2.6px。改后的行盒与条数读数见
 *     .workbuddy/round379-rowheight.log。
 *  T5 预览必须是块盒且真的在截断：display:block 摘掉后 <span> 退回 inline，
 *     overflow / text-overflow / white-space 三条对 inline 盒一条都不生效（CSS 2.1
 *     §11.1.1）。实测（.workbuddy/round376-headrow.log，1440 塞 41 字）：inline 时
 *     行盒 60.28、clientWidth 量出 0、.list-content 横向溢出 +171px —— 症状就是那条
 *     常年挂在中栏底下的横向滚动条。这一发不另立断言：inline 时 clientWidth 恒 0
 *     ⇒「放得下」那行恒真、「放不下」那条不截断 ⇒ T3b 的窗口自证当场红。
 *     所以 T3b 排在 T3a 之前，让这一发红在承重的那句上。
 *
 * ── 为什么量「放得下几个字」而不是量轨道宽 ──────────────────────
 * 轨道宽 191px 这种断言只钉住一个数，钉不住它为什么是那个数；而且它和真正的症状
 * （预览被切成半句话）之间隔着一层。换成「N 字必须完整、N+3 字必须省略号」之后，
 * 判据直接是症状本身：把 --list-width 改窄、把 padding 加宽、把字号改大、
 * 给 tail 列加宽 —— 任何吃掉这一轨宽度的改法都会让第一行红。
 * 数字来源：--fs-sm=12px 的汉字是等宽全角（1 字 = 1 字号），所以字数上限 = 轨道宽 ÷ 12。
 * 实测边界（.workbuddy/round377-budget.log，24 档逐字探，三档栏宽一次量齐）：
 *   --list-width 340 → 轨道 191px → 放得下 15 字，16 字起截断
 *   --list-width 305 → 轨道 156px → 放得下 13 字，14 字起截断
 *   --list-width 245 → 轨道  96px → 放得下  8 字， 9 字起截断
 * 每档各取「上限 − 1 / 上限 + 2」，两侧都留两字以上余量，不贴边。
 * ⚠ 这几枚轨道数不是常数：轨道 = 栏宽 − 行内固定开销，而行内开销里含 gap 与 padding，
 * 所以折一次间距档它们就集体挪几像素。上一版记的是 189/154（窄档上限 12），round377
 * 把这一行的 gap 归到 var(--space-2) 后变成 191/156，窄档上限跟着从 12 抬到 13 ——
 * 宽档上限没动（15），所以宽档那条 14/17 原样保留；改的是窄档那条。
 * 以后动这一行的任何间距，先重跑 round377-budget 那份探针再改下面的数字。
 * 视口必须钉死：默认 1280×720 会落进 ≤1180 那一档（305px），拿 340 档的数字去判会红。
 */
test.describe("会话列表排版：字号阶梯 / 标签字距 / 行宽与行高预算", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("T1–T4 宽档(340)：预览取 --fs-sm、段标签不加字距、14 字放得下且 17 字仍截断", async ({
    page,
  }) => {
    await mockConversationList(page, typoFixtures(14, 17));
    await page.goto(`${webOrigin}/`);

    const group = page.locator('.conversation-section[data-section="group"]');
    await expect(group.locator(".conversation-item")).toHaveCount(2);

    const [fits, truncates] = (await measureRows(page)) as [
      RowGeometry,
      RowGeometry,
    ];
    expect(fits.id).toBe("type-fits");

    // 声明级判据排在几何判据之前：字号一旦退回 11px，连 17 字都能在 191px 的轨道里放
    // 下（17×11=187），几何那几条会先以「窗口消失」这种间接症状红，归因白绕一层。
    const type = await measureTypeScale(page);
    // T1：预览落在那一档上，而不是和时间同字号。
    expect(type.preview).toBe(type.sm);
    expect(type.time).toBeLessThan(type.preview);
    expect(type.preview).toBeLessThan(type.title);
    // T2：中文段标签既不大写化也不加字距。
    expect(type.labelSpacing).toBe("normal");
    expect(type.labelTransform).toBe("none");

    // T3b 在前：同一条轨道必须仍然截断更长的 —— 它同时是 T5 的探针（预览一旦退回
    // inline 盒就压根不截断）。放在 T3a 之前，是为了让「inline 化」这一发变异红在
    // 真正承重的那句上，而不是先被 T3a 的恒真挡住。
    expect(truncates.fits, "窗口消失：17 个汉字也不截断了").toBe(false);
    // T3a：14 字整行放得下（改窄栏宽 / 加宽 padding / 加宽 tail 都会让这里红）。
    expect(
      fits.fits,
      `14 个汉字被截断了：轨道 ${fits.track}px < 内容 ${fits.scroll}px`,
    ).toBe(true);
    expect(truncates.track).toBe(fits.track);
    // T3c：截断用的是省略号而不是换行。
    expect(fits.lines).toBe(1);
    expect(truncates.lines).toBe(1);

    // T4：预览那一行的行高跟着自己的字号走（不是整行的地板账，理由见文件头）。
    // 1.45 = 声明值 1.35 与「退回继承 body 1.55」之间取的中档，两侧都留一档以上余量。
    expect(
      fits.prevH,
      `预览行高脱离字号：${fits.prevH.toFixed(2)}px > ${fits.prevFs} × 1.45`,
    ).toBeLessThanOrEqual(fits.prevFs * 1.45);
    // T4b：整行守住 38px 地板之上的余量（这一格管不到内距与行高，分工见文件头）。
    expect(fits.rowH, `行盒 ${fits.rowH}px 超出预算`).toBeLessThan(60);
    // 抬栏宽那一档的验收条件：不许顶出横向滚动。
    expect(
      fits.overflowX,
      `出现横向溢出 ${fits.overflowX}px`,
    ).toBeLessThanOrEqual(0);
  });
});

/**
 * 窄档（≤1180 的 --list-width: 305px）单独一条：视口不同 ⇒ 预算不同。
 * 这条守的是那条 media 里的 305 —— 它从 275 抬上来才有 13 字；倒回 275 时轨道只剩
 * 126px，只放得下 10 字，下面那条 12 字当场红（这发是实测量出来的：见
 * .workbuddy/round377-budget.log 里「倒回 275」那行，不是按 275−149 推算的）。
 * 上限从上一版的 12 抬到 13：这一行的 gap 折档之后轨道多了 2px，所以「放得下」取 12、
 * 「仍截断」取 15。原因见本文件上面的「量字数」段。
 * 860 档（245px，8 字）故意不进断言：那一档窄到只能放 8 字，再从别处挤宽度就会顶出
 * 横向滚动，所以它的预算只留在 round377-budget.log，不当守卫。
 */
test("会话列表排版：窄档(≤1180 → 305px) 12 字放得下且 15 字仍截断", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1100, height: 900 });
  await mockConversationList(page, typoFixtures(12, 15));
  await page.goto(`${webOrigin}/`);

  const group = page.locator('.conversation-section[data-section="group"]');
  await expect(group.locator(".conversation-item")).toHaveCount(2);

  const [fits, truncates] = (await measureRows(page)) as [
    RowGeometry,
    RowGeometry,
  ];
  expect(fits.id).toBe("type-fits");
  expect(truncates.fits, "窗口消失：15 个汉字也不截断了").toBe(false);
  expect(
    fits.fits,
    `12 个汉字被截断了：轨道 ${fits.track}px < 内容 ${fits.scroll}px`,
  ).toBe(true);
  expect(truncates.track).toBe(fits.track);
  expect(fits.lines).toBe(1);
  // T4 同宽档那一发：行高贴着字号，整行只守地板余量。
  expect(
    fits.prevH,
    `预览行高脱离字号：${fits.prevH.toFixed(2)}px > ${fits.prevFs} × 1.45`,
  ).toBeLessThanOrEqual(fits.prevFs * 1.45);
  expect(fits.rowH, `行盒 ${fits.rowH}px 超出预算`).toBeLessThan(60);
  expect(
    fits.overflowX,
    `出现横向溢出 ${fits.overflowX}px`,
  ).toBeLessThanOrEqual(0);
});

test("顶栏个人状态：默认在线、切换持久化且移动端可操作", async ({ page }) => {
  await page.goto(`${webOrigin}/`);
  const status = page.getByLabel("个人状态（仅本机）");
  await expect(status).toHaveValue("online");
  await expect(page.locator("#profileStatusText")).toContainText("在线 · 本机");
  await expect(page.locator("#profileStatusDot")).toHaveClass(/online/u);

  await status.selectOption("focus");
  await expect(page.locator("#profileStatusText")).toContainText("专注 · 本机");
  await expect(page.locator("#profileStatusDot")).toHaveClass(/focus/u);
  await page.reload();
  await expect(status).toHaveValue("focus");
  await status.selectOption("busy");
  await expect(page.locator("#profileStatusText")).toContainText("忙碌 · 本机");
  await expect(page.locator("#profileStatusDot")).toHaveClass(/busy/u);
  expect(
    await page.evaluate(() => localStorage.getItem("opc:personal-status")),
  ).toBe('"busy"');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(status).toBeVisible();
  await expect(status).toHaveValue("busy");
  expect(
    await page.evaluate(
      "document.documentElement.scrollWidth <= window.innerWidth",
    ),
  ).toBe(true);
});

/**
 * 窄档（≤640）一排按钮的横向内距必须同档。
 *
 * 症状（round377 同列表穷举在 390/640 两档实测报出）：@media(max-width:640px) 里原先只写
 * `.btn.primary { padding: 6px 9px }`，于是 .actions 那一排读出「主按钮 9px ‖ 同排普通
 * 按钮 13px」—— 三处全中：待办（刷新/新建待办）、消息（发起会议/新建文档/私聊成员）、
 * 文档（导入/新建文档）。同一排两档内距，跟同排同高是同一类病，只是量的不是高度。
 *
 * 判据直接是症状本身，两条各管一头：
 *  ① 同排同档 —— 每排 ≥2 枚 .btn 的 padding-inline 只许读出一个值。
 *     变异：把规则退回 `.btn.primary {…}` ⇒ 该排读出 {13px, 9px}，当场红。
 *  ② 窄档真的比桌面窄 —— 同一页在 390 读到的那档必须【严格小于】1440 读到的 13px。
 *     变异：整条媒体规则删掉 ⇒ 两档全读 13px，②红（只有①会放过「大家都用宽档」这种退回）。
 * 反向对照（不该红的）：.chat-header .btn 的 7px 与 .btn.small 的 3px/9px 权重都高于这里的
 * (0,1,0)，各自保留 —— 所以本条只比【同一排内部】是否同值，不比跨排。
 * 文字截断与横向溢出这两头顺带钉住：压内距的动机是省地方，挤掉了字就得不偿失
 * （scrollWidth > clientWidth 的那一类截断、以及文档级横向溢出，390 档都实测为 0）。
 */
/** 页面侧探针：字符串形态 + JSON 出参，node 侧 lib 里没有 DOM 全局（见上 test 内注释）。 */
const PAD_PROBE = `(() => {
  const rows = [];
  for (const row of document.querySelectorAll(".actions")) {
    const btns = [...row.querySelectorAll(":scope > .btn")].filter(
      (b) => b.getBoundingClientRect().width > 1,
    );
    if (btns.length < 2) continue;
    rows.push({
      pads: [...new Set(btns.map((b) => {
        const cs = getComputedStyle(b);
        return cs.paddingLeft + "/" + cs.paddingRight;
      }))].sort(),
      clipped: btns
        .filter((b) => b.scrollWidth > b.clientWidth + 1)
        .map((b) => (b.textContent ?? "").trim().slice(0, 6)),
    });
  }
  return JSON.stringify({ rows, overflowX: document.documentElement.scrollWidth - window.innerWidth });
})()`;

test("窄档(≤640) 一排按钮的横向内距同档且确实比桌面窄", async ({ page }) => {
  // 探针是【字符串】不是闭包：.workbuddy/tsconfig.tests.json 的 types 只有 node，
  // 闭包里每一处 document/window 都会红在类型棘轮上（tw-cascade.spec.ts:273 同口径）。
  const readRows = async () =>
    JSON.parse((await page.evaluate(PAD_PROBE)) as string) as {
      rows: Array<{ pads: string[]; clipped: string[] }>;
      overflowX: number;
    };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webOrigin}/#/backlog`);
  await expect(page.locator(".actions > .btn").first()).toBeVisible();
  const narrow = await readRows();
  expect(
    narrow.rows.length,
    "390 档没量到 ≥2 枚 .btn 并排的那一排，判据没在考任何东西",
  ).toBeGreaterThan(0);
  for (const row of narrow.rows) {
    expect(
      row.pads,
      `同一排按钮读出两档横向内距：${row.pads.join(" vs ")}`,
    ).toHaveLength(1);
    expect(
      row.clipped,
      `压完内距把文字挤截断了：${row.clipped.join("、")}`,
    ).toHaveLength(0);
  }
  expect(
    narrow.overflowX,
    `390 档出现横向溢出 ${narrow.overflowX}px`,
  ).toBeLessThanOrEqual(0);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.reload();
  // reload 后不等一下就量，会得到空的排：widePad 取 Math.max 空数组 = -Infinity，
  // 下面那条「窄档必须严格小于桌面」就恒真 —— 判据悄悄不考任何东西。所以先等这排出来，
  // 再显式要求量到。
  await expect(page.locator(".actions > .btn").first()).toBeVisible();
  const wide = await readRows();
  expect(
    wide.rows.length,
    "1440 档没量到 ≥2 枚 .btn 并排的那一排，比较基准不存在",
  ).toBeGreaterThan(0);
  // parseFloat 读到 "/" 就停 ⇒ "9px/9px" 直接读出 9，不用再 split 下标（noUncheckedIndexedAccess）。
  const widePad = Math.max(
    ...wide.rows.flatMap((r) => r.pads.map((p) => Number.parseFloat(p))),
  );
  const narrowPad = Math.max(
    ...narrow.rows.flatMap((r) => r.pads.map((p) => Number.parseFloat(p))),
  );
  expect(
    narrowPad,
    `窄档没真收：390 读到 ${narrowPad}px，与桌面 ${widePad}px 同档（整条媒体规则被删了？）`,
  ).toBeLessThan(widePad);
});

test("左侧导航：键盘排序持久化并保持 data-nav 点击行为", async ({ page }) => {
  await page.goto(`${webOrigin}/`);
  await expect(page.locator("#navReorderHint")).toBeVisible();
  const messages = page.locator('[data-nav="messages"]');
  await messages.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(page.locator(".rail-top .nav-item").first()).toHaveAttribute(
    "data-nav",
    "contacts",
  );
  expect(
    await page.evaluate(() => localStorage.getItem("opc:nav-order")),
  ).toContain('"contacts"');
  await page.reload();
  await expect(page.locator(".rail-top .nav-item").first()).toHaveAttribute(
    "data-nav",
    "contacts",
  );
  await page.locator('[data-nav="documents"]').click();
  await expect(page).toHaveURL(/#\/documents$/u);
  await expect(page.locator('[data-nav="documents"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("管理视图：侧栏入口把控制室挂在右侧内容区，页名单走中间列表栏", async ({
  page,
}) => {
  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="admin"]').click();
  // 侧栏那颗按钮进去时 hash 就带页名（adminPage 初值 today）：地址永远说得出
  // 自己在哪一页，复制这条地址给别人不会落到另一页。
  await expect(page).toHaveURL(/#\/admin\/today$/u);
  await expect(page.locator('[data-nav="admin"]')).toHaveAttribute(
    "aria-current",
    "page",
  );
  // 「不弹独立页」在这一发之后有了新的机械含义：内容区里不许再有 iframe。
  // 原来这条断言查的是 iframe 的 src/title；现在查的是【它必须不存在】——
  // 谁把嵌法退回 iframe，这里当场红。
  await expect(page.locator("#view iframe")).toHaveCount(0);
  await expect(page.locator("#view > .admin-root.admin-mount")).toHaveCount(1);
  // 中间列表栏 = 控制室那七页，与消息/文档同一个形状。名单只从 /app.js 的
  // ADMIN_PAGES 拿，所以这一条同时钉住「动态 import 真落地了」：没落地时这里
  // 停在「正在载入控制室…」，七行永远数不齐。
  const pages = page.locator("#listContent .doc-list-item");
  await expect(pages).toHaveCount(7);
  await expect(pages.first()).toContainText("今日");
  await expect(pages.nth(1)).toContainText("任务看板");
  // 七页没有「新建」这回事，中栏右上那颗按钮在这一格无事可做。
  await expect(page.locator("#listAction")).toBeHidden();
  // 中栏不再让位给内容区：三栏齐着，控制室画在第三栏里。
  await expect(page.locator("#listPane")).toBeVisible();
  await expect(page.locator("#mainPane")).toBeVisible();
  // 内容区真渲染了这一页（不是停在「载入中…」）：那句段落标题来自 renderToday
  // 本体，取数失败时那里会换成横幅 ⇒ 这一条把「挂上了但没画」也钉住。
  await expect(page.locator(".admin-mount-view")).toContainText("需要你决策");
  // 选中态跟着屏幕走：hash 带的是 today ⇒ 今日页那一行就是当前页。
  await expect(pages.first()).toHaveAttribute("aria-current", "page");
  // 模块自己写的那份页头导航【必须看不见】—— 看得见就是屏幕上有两份可点的菜单。
  // 藏住它的线是两枚一对：group.js 造节点时自带的 hidden 属性 + group.css 里
  // [hidden]{display:none !important} 那一条（!important 稳压 admin.css 的
  // .admin-root nav{display:flex}）。round370 剪线变异证明曾经那条
  // .admin-mount .admin-mount-nav{display:none} 从未承重（剪掉照样绿），已拆；
  // 下面那枚属性断言才是这条 toBeHidden 的真承重 —— 摘掉 hidden:true，
  // 这一发当场红，而不是等「看起来还是藏着的」那条假规则陪跑。
  const mountNav = page.locator(".admin-mount .admin-mount-nav");
  await expect(mountNav).toHaveJSProperty("hidden", true);
  await expect(mountNav).toBeHidden();
  // 点中间栏「任务看板」= 换页：hash 带上页名、选中态移动、内容区换到看板。
  await pages.nth(1).click();
  await expect(page).toHaveURL(/#\/admin\/board$/u);
  await expect(pages.nth(1)).toHaveAttribute("aria-current", "page");
  await expect(pages.first()).not.toHaveAttribute("aria-current");
  await expect(
    page.locator('.admin-mount-view button[data-f="all"]'),
  ).toHaveCount(1);
  // 换菜单要能换回来：控制室整格拆走（那条 SSE 与 hub 订阅随 unmountAdmin 一起
  // 释放），列表栏换回消息自己的名单（不是管理视图那七页）。
  await page.locator('[data-nav="messages"]').click();
  await expect(page.locator("#view > .admin-root.admin-mount")).toHaveCount(0);
  await expect(page.locator("#listPane")).toBeVisible();
  await expect(page.locator("#listTitle")).toHaveText("消息");
  await expect(page.locator("#listContent .doc-list-item")).toHaveCount(0);
  await expect(page.locator(".admin-mount-view")).toHaveCount(0);
});

test("管理视图：#/admin/<页名> 直达保住页名，旧 /admin 已撤（404）", async ({
  page,
}) => {
  // 直达深链：boot() 要把 hash 第三段当页名交进 setRoute，否则那句 replaceState
  // 会把它削成 #/admin —— URL 写着看板、屏幕却是今日页。
  await page.goto(`${webOrigin}/#/admin/board`);
  await expect(page).toHaveURL(/#\/admin\/board$/u);
  const pages = page.locator("#listContent .doc-list-item");
  await expect(pages).toHaveCount(7);
  await expect(pages.nth(1)).toHaveAttribute("aria-current", "page");
  // 点侧栏的同名入口不许把页名冲掉（它已经在这一格了，重进应保持当前页）。
  await page.locator('[data-nav="admin"]').click();
  await expect(page).toHaveURL(/#\/admin\/board$/u);
  await expect(pages.nth(1)).toHaveAttribute("aria-current", "page");
  await pages.first().click();
  await expect(page).toHaveURL(/#\/admin\/today$/u);
  await expect(page.locator(".admin-mount-view")).toContainText("需要你决策");
  // 独立页 /admin 已删（2026-11-25 决策）：这条 URL 落到 404，不再重定向也不再有
  // 独立文档。管理视图的唯一入口就是工作台 #/admin/<页名>。
  const standalone = await page.request.get(`${webOrigin}/admin`);
  expect(standalone.status()).toBe(404);
});

test("管理视图：今日页窗口 chip 过一遍宿主，query 不被二次编码进页名", async ({
  page,
}) => {
  // 这一发钉的是【宿主与治理页的接缝】，不是窗口功能本身（那半在 app-pure 的
  // windowMsOfHash / todayWindows 直测里）。chip 写的是 #/admin/today?window=7d
  // —— query 住在 hash 第三段里；group.js 的 hashchange 若把它当普通 id 走
  // setRoute，那一段会被 encodeURIComponent 成 today%3Fwindow%3D7d。
  // 两个判据合起来才抓得住：URL 没 %3F（编码没发生）+ 选中态仍是今日页
  // （控制室解析出的页名没变成不存在的字符串）。
  await page.goto(`${webOrigin}/#/admin/today`);
  const pages = page.locator("#listContent .doc-list-item");
  await expect(pages).toHaveCount(7);
  await expect(page.locator(".admin-mount-view")).toContainText("需要你决策");
  await page.locator('.admin-mount-view a[data-win-ms="604800000"]').click();
  await expect(page).toHaveURL(/#\/admin\/today\?window=7d$/u);
  expect(new URL(page.url()).hash).not.toContain("%3F");
  await expect(pages.first()).toHaveAttribute("aria-current", "page");
  // chip 的选中态跟着窗口读数走：7 天那一枚拿到 admin-chip-active、24 小时那枚没有
  // —— 这一发证明控制室真【接到】了这一发（不是宿主自己把地址写了又自己解析）。
  const active = page.locator(".admin-mount-view a.admin-chip-active");
  await expect(active).toHaveCount(1);
  await expect(active).toContainText("7 天");
  // 窗口换过去之后页还在：看板那枚过滤器不许出现在今日页（证明不是换页换坏的）。
  await expect(
    page.locator('.admin-mount-view button[data-f="all"]'),
  ).toHaveCount(0);
});

async function createDocumentThroughUi(
  page: Page,
  title: string,
  kind: string,
  groupId: string | null,
  bodyText: string,
): Promise<string> {
  await page.locator("#createButton").click();
  await page.locator('[data-create="document"]').click();
  const dialog = page.getByRole("dialog", { name: "新建文档" });
  await dialog.locator('input[name="title"]').fill(title);
  await dialog.locator('select[name="kind"]').selectOption(kind);
  if (groupId)
    await dialog.locator('select[name="group_id"]').selectOption(groupId);
  await dialog.locator('textarea[name="body_text"]').fill(bodyText);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/documents",
  );
  await dialog.getByRole("button", { name: "创建并打开", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const created = (await response.json()) as {
    document: { doc_id: string };
  };
  await expect(dialog).toBeHidden({ timeout: 15_000 });
  return created.document.doc_id;
}

/** 树上按【群标签 + 形态标签】定位一个形态分支。 */
function treeKind(page: Page, groupLabel: string, kindLabel: string) {
  return page
    .locator("#listContent .doc-tree-group")
    .filter({
      has: page.locator(
        `:scope > summary .doc-tree-label:text-is("${groupLabel}")`,
      ),
    })
    .locator(":scope > .doc-tree-kind")
    .filter({
      has: page.locator(
        `:scope > summary > .doc-tree-label:text-is("${kindLabel}")`,
      ),
    });
}

function collapsedKeys(page: Page) {
  return page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("opc:doc-tree-collapsed") || "[]",
      ) as string[],
  );
}

test("文档树：群→形态→文档三级、折叠态跨重渲染与跨刷新保持、选中项祖先强制展开", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  const alpha = await createGroupThroughUi(
    page,
    "树形导航验收群",
    "验证文档树层级",
  );
  const alphaId = alpha.group.group_id;

  // 形态标签取自界面自己的下拉项，不在测试里重打一遍中文（改了 labels 不会假红）
  await page.locator("#createButton").click();
  await page.locator('[data-create="document"]').click();
  const kindLabels = await page
    .getByRole("dialog", { name: "新建文档" })
    .locator('select[name="kind"] option')
    .allTextContents();
  await page
    .getByRole("dialog", { name: "新建文档" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  const labelOf = (kind: string): string =>
    kindLabels[["doc", "sheet", "markdown", "mindmap"].indexOf(kind)] ?? "";
  expect(labelOf("sheet")).toBeTruthy();
  expect(labelOf("mindmap")).toBeTruthy();

  const sheetDoc = await createDocumentThroughUi(
    page,
    "树形导航验收表格",
    "sheet",
    alphaId,
    // 表格正文的存储契约是 JSON（parseSheet，group.js:4886 起），不是 CSV
    '[["名称","数量"],["验收项",1]]',
  );
  await page.locator('[data-nav="documents"]').click();
  const mindmapDoc = await createDocumentThroughUi(
    page,
    "树形导航验收导图",
    "mindmap",
    null,
    "根节点",
  );
  await page.locator('[data-nav="documents"]').click();

  const tree = page.locator("#listContent .doc-tree");
  await expect(tree).toBeVisible();

  // ① 三级结构 + 树外零游离（漏这条的话，「半棵树在树里、半棵在外面」是全绿）
  expect(
    await page.evaluate(
      "[...document.querySelectorAll('#listContent .doc-list-item')].filter((item) => !item.closest('.doc-tree')).length",
    ),
  ).toBe(0);
  const alphaBranch = tree.locator(":scope > .doc-tree-group").filter({
    has: page.locator(
      ':scope > summary .doc-tree-label:text-is("树形导航验收群")',
    ),
  });
  await expect(alphaBranch).toHaveCount(1);
  // 建群自带一篇立项文档，所以这个群分支下至少两个形态
  expect(
    await alphaBranch.locator(":scope > .doc-tree-kind").count(),
  ).toBeGreaterThanOrEqual(2);
  const sheetBranch = treeKind(page, "树形导航验收群", labelOf("sheet"));
  await expect(sheetBranch).toHaveCount(1);
  await expect(
    sheetBranch.locator(":scope > .doc-tree-leaf .doc-list-item"),
  ).toHaveCount(1);
  await expect(
    sheetBranch.locator(":scope > .doc-tree-leaf .doc-list-item").first(),
  ).toContainText("树形导航验收表格");
  // 形态分支的图标必须指向精灵里真有的 symbol。不能只量 svg 尺寸：<svg> 有 CSS 尺寸，
  // 就算 <use href="#i-sheet"> 指向不存在的 symbol 也照样是个 15px 的空盒子（实测漏判过），
  // 所以判据是【引用解析得到元素】本身。
  const unresolvedGlyphs = await page.evaluate(`[
    ...document.querySelectorAll("#listContent .doc-tree summary use"),
  ]
    .map((use) => use.getAttribute("href") || "(empty)")
    .filter((ref) => !ref.startsWith("#") || !document.querySelector(ref))`);
  expect(unresolvedGlyphs).toEqual([]);
  await expect(
    sheetBranch.locator(":scope > summary .doc-tree-count"),
  ).toHaveText("1");

  // ② 形态 pill 不再和所在分支标题重复自己
  const leafPills = await sheetBranch
    .locator(":scope > .doc-tree-leaf .doc-list-item .pill")
    .allTextContents();
  expect(leafPills).not.toContain(labelOf("sheet"));

  // ③ 点开叶子 → 正文打开，路由落到这篇文档的 id 上
  await sheetBranch
    .locator(":scope > .doc-tree-leaf .doc-list-item")
    .first()
    .click();
  await expect(page.getByLabel("文档标题")).toHaveValue("树形导航验收表格");
  await expect(page).toHaveURL(new RegExp(`#/documents/${sheetDoc}$`, "u"));
  await page.locator('[data-nav="documents"]').click();
  await expect(sheetBranch).toBeVisible();

  // ④ 折叠：localStorage 存真群键，且【没有】共享的 "undefined" 槽位（上一版 STORAGE_KEYS 少一个键就是这症状）
  await alphaBranch.locator(":scope > summary").click();
  await expect(sheetBranch).not.toBeVisible();
  await expect
    .poll(async () => (await collapsedKeys(page)).includes(`g:${alphaId}`))
    .toBe(true);
  expect(await collapsedKeys(page)).not.toContain("undefined");
  // 兄弟分支不受牵连
  await expect(
    treeKind(page, "未分组", labelOf("mindmap")).locator(
      ":scope > .doc-tree-leaf .doc-list-item",
    ),
  ).toHaveCount(1);

  // ⑤ 折叠态跨刷新保持 + 展开后槽位真的被减掉（只加不减的话用户永远解不开）
  await page.reload();
  await expect(tree).toBeVisible();
  await expect(sheetBranch).not.toBeVisible();
  await alphaBranch.locator(":scope > summary").click();
  await expect(sheetBranch).toBeVisible();
  await expect
    .poll(async () => (await collapsedKeys(page)).includes(`g:${alphaId}`))
    .toBe(false);

  // ⑥ 选中项祖先【强制】展开，压过折叠记录：先把导图所在分支折掉（用户手势），
  //    再把【另一个】群也折上，然后直接带 hash 深链进这篇从没点过的文档 ——
  //    点叶子选中的是已展开分支，测不出这条判据；两个群一起折才分得出「只放行选中项那条祖先链」。
  const mindBranch = treeKind(page, "未分组", labelOf("mindmap"));
  const mindGroup = tree.locator(":scope > .doc-tree-group").filter({
    has: page.locator(':scope > summary .doc-tree-label:text-is("未分组")'),
  });
  await mindGroup.locator(":scope > summary").click();
  await expect(mindBranch).not.toBeVisible();
  await alphaBranch.locator(":scope > summary").click();
  await expect(sheetBranch).not.toBeVisible();
  await page.goto(`${webOrigin}/#/documents/${mindmapDoc}`);
  await expect(page.getByLabel("文档标题")).toHaveValue("树形导航验收导图");
  await page.locator('[data-nav="documents"]').click();
  await expect(mindBranch).toBeVisible();
  await expect(
    mindBranch.locator(":scope > .doc-tree-leaf .doc-list-item.selected"),
  ).toHaveCount(1);
  // 同一屏上【没有】选中项的群仍然折叠 —— 只放行选中项那条祖先链。
  // 断言 open 而不是数叶子：details 收起时子树仍在 DOM 里，数个数会恒为真。
  expect(
    await page.evaluate(`[
      ...document.querySelectorAll("#listContent .doc-tree-group > summary .doc-tree-label"),
    ]
      .find((el) => el.textContent === "树形导航验收群")
      ?.closest("details")?.open ?? null`),
  ).toBe(false);

  expectNoBrowserErrors(browserErrors);
});

interface PublishedTalent {
  item_id: string;
  source: string;
  name: string;
  payload: {
    name: string;
    persona: { style: string; honesty: string };
  };
}

interface PublishResponse {
  ok: boolean;
  auditSeq: number;
  item: PublishedTalent;
}

function marketCard(page: Page, name: string) {
  return page.locator(".talent-grid .talent-card").filter({
    has: page.getByRole("heading", { level: 3, name, exact: true }),
  });
}

interface BrowserErrors {
  pageErrors: string[];
  consoleErrors: string[];
  failedResponses: string[];
  failedRequests: string[];
}

function watchBrowserErrors(page: Page): BrowserErrors {
  const errors: BrowserErrors = {
    pageErrors: [],
    consoleErrors: [],
    failedResponses: [],
    failedRequests: [],
  };
  page.on("pageerror", (error) => errors.pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400)
      errors.failedResponses.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    // 页面关闭或重订阅时取消长期 SSE 是正常回收，不是页面脚本错误。
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    errors.failedRequests.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    );
  });
  return errors;
}

function expectNoBrowserErrors(errors: BrowserErrors) {
  expect(errors.pageErrors, "page script errors").toEqual([]);
  expect(
    errors.consoleErrors,
    `browser console errors: ${[...errors.failedResponses, ...errors.failedRequests].join(" | ")}`,
  ).toEqual([]);
  expect(errors.failedResponses, "failed HTTP responses").toEqual([]);
  expect(errors.failedRequests, "failed browser requests").toEqual([]);
}

async function publishMemberThroughUi(
  page: Page,
  memberId: string,
): Promise<PublishResponse> {
  const pathname = `/api/v1/talent/${encodeURIComponent(memberId)}/publish`;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === pathname,
  );
  await page.getByRole("button", { name: "发布在职成员", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "发布在职成员" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("选择成员").selectOption(memberId);
  await dialog.getByRole("button", { name: "发布到市场", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as PublishResponse;
  expect(body.ok).toBe(true);
  expect(Number.isInteger(body.auditSeq)).toBe(true);
  await expect(dialog).toBeHidden();
  return body;
}

test("人才市场：真实发布、重复发布刷新快照、下架后成员仍保留", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  // 蓝图契约不含 avatar_asset_id，装饰头像会请求 assets/undefined；仅隔离该图片请求，
  // 发布、重复发布与下架仍全部走真实 UI 和真实业务 API。
  await page.route("**/api/v1/assets/undefined", (route) =>
    route.fulfill({
      status: 204,
    }),
  );

  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="talent"]').click();
  const publishButton = page.getByRole("button", {
    name: "发布在职成员",
    exact: true,
  });
  await expect(publishButton).toBeVisible();
  await expect(
    page.getByRole("heading", { level: 2, name: "人才市场", exact: true }),
  ).toBeVisible();

  const first = await publishMemberThroughUi(page, MARKET_MEMBER_ID);
  const itemId = `pub:${MARKET_MEMBER_ID}`;
  expect(first.item).toMatchObject({
    item_id: itemId,
    source: "published",
    name: MARKET_MEMBER_NAME,
    payload: {
      name: MARKET_MEMBER_NAME,
      persona: { style: INITIAL_PERSONA, honesty: "不确定就说明" },
    },
  });
  const firstCard = marketCard(page, MARKET_MEMBER_NAME);
  await expect(firstCard).toHaveCount(1);
  await expect(firstCard.locator(".pill")).toContainText([
    "published",
    "执行档",
  ]);
  await expect(firstCard).toContainText(INITIAL_PERSONA);
  await expect(page.locator("#view .detail-hero h2")).toHaveText(
    MARKET_MEMBER_NAME,
  );
  await expect(page.locator("#view")).toContainText(INITIAL_PERSONA);

  await page
    .getByRole("navigation", { name: "应用导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const memberRow = page
    .locator("#listContent .member-row")
    .filter({ hasText: MARKET_MEMBER_NAME });
  await expect(memberRow).toHaveCount(1);
  await memberRow.click();
  await expect(page.locator("#view")).toContainText(MARKET_MEMBER_ID);
  await page.getByLabel("风格 / 口头禅").fill(REFRESHED_PERSONA);
  await page.getByRole("button", { name: "保存成员档案", exact: true }).click();
  await expect(page.locator("#toastRegion")).toContainText("成员档案已保存");
  await expect(page.getByLabel("风格 / 口头禅")).toHaveValue(REFRESHED_PERSONA);

  await page.locator('[data-nav="talent"]').click();
  await expect(publishButton).toBeVisible();
  // 挂牌是快照而不是活引用：成员档案改了，旧货架内容要等再次发布才刷新。
  await expect(firstCard).toContainText(INITIAL_PERSONA);
  await expect(firstCard).not.toContainText(REFRESHED_PERSONA);
  const second = await publishMemberThroughUi(page, MARKET_MEMBER_ID);
  expect(second.auditSeq).toBeGreaterThan(first.auditSeq);
  expect(second.item).toMatchObject({
    item_id: itemId,
    source: "published",
    name: MARKET_MEMBER_NAME,
    payload: {
      name: MARKET_MEMBER_NAME,
      persona: { style: REFRESHED_PERSONA, honesty: "不确定就说明" },
    },
  });
  const refreshedCard = marketCard(page, MARKET_MEMBER_NAME);
  await expect(refreshedCard).toHaveCount(1);
  await expect(refreshedCard.locator(".pill")).toContainText([
    "published",
    "执行档",
  ]);
  await expect(refreshedCard).toContainText(REFRESHED_PERSONA);
  await expect(refreshedCard).not.toContainText(INITIAL_PERSONA);
  await expect(page.locator("#view")).toContainText(REFRESHED_PERSONA);

  await refreshedCard.click();
  await expect(page.locator("#view .detail-hero h2")).toHaveText(
    MARKET_MEMBER_NAME,
  );
  await page.getByRole("button", { name: "下架蓝图", exact: true }).click();
  const unlistDialog = page.getByRole("dialog", { name: "下架人才蓝图" });
  await expect(unlistDialog).toContainText("已按此蓝图招聘的成员不会受影响");
  await expect(
    unlistDialog.getByRole("button", { name: "确认下架", exact: true }),
  ).toBeVisible();
  await unlistDialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(unlistDialog).toBeHidden();

  const unlistPath = `/api/v1/talent/${encodeURIComponent(itemId)}/unlist`;
  const unlistResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === unlistPath,
  );
  await page.getByRole("button", { name: "下架蓝图", exact: true }).click();
  await unlistDialog
    .getByRole("button", { name: "确认下架", exact: true })
    .click();
  const unlistResponse = await unlistResponsePromise;
  expect(unlistResponse.ok()).toBe(true);
  await expect(unlistDialog).toBeHidden();
  await expect(page.locator("#toastRegion")).toContainText("人才蓝图已下架");
  await expect(refreshedCard).toHaveCount(0);
  await expect(page.locator("#listContent")).not.toContainText(
    MARKET_MEMBER_NAME,
  );

  await page
    .getByRole("navigation", { name: "应用导航" })
    .getByRole("button", { name: "设置", exact: true })
    .click();
  const survivingMember = page
    .locator("#listContent .member-row")
    .filter({ hasText: MARKET_MEMBER_NAME });
  await expect(survivingMember).toHaveCount(1);
  await survivingMember.click();
  await expect(page.locator("#view .detail-hero h2")).toHaveText(
    MARKET_MEMBER_NAME,
  );
  await expect(page.locator("#view")).toContainText(MARKET_MEMBER_ID);
  await expect(page.getByLabel("风格 / 口头禅")).toHaveValue(REFRESHED_PERSONA);
  expectNoBrowserErrors(browserErrors);
});

async function verifyTaskPanel({ page }: { page: Page }) {
  const browserErrors = watchBrowserErrors(page);
  const standupSummary = "真实 UI 站会：发布范围已确认";
  const standupConclusion = "今日完成验收，未发现阻塞";
  const researchTitle = "真实 UI 每日调研：协作流程";
  const researchSummary = "manual 调研确认任务关联与文档沉淀闭环可用";

  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="backlog"]').click();
  await expect(
    page.getByRole("heading", { level: 2, name: "任务面板", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "团队节奏", exact: true }).click();
  await expect(
    page.locator("#taskPanel").getByRole("heading", {
      level: 3,
      name: "团队节奏",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增节奏", exact: true })
    .click();
  const rhythmDialog = page.getByRole("dialog", { name: "新增团队节奏" });
  await rhythmDialog.locator('select[name="kind"]').selectOption("standup");
  await rhythmDialog.locator('textarea[name="summary"]').fill(standupSummary);
  await rhythmDialog
    .locator('textarea[name="conclusion"]')
    .fill(standupConclusion);
  await rhythmDialog
    .getByRole("button", { name: "记录节奏", exact: true })
    .click();
  await expect(rhythmDialog).toBeHidden();

  const standupCard = page
    .locator(".entry-card.rhythm-card")
    .filter({ hasText: standupSummary });
  await expect(standupCard).toHaveCount(1);
  await expect(
    standupCard.getByRole("heading", { name: "每日站会", exact: true }),
  ).toBeVisible();
  await expect(standupCard).toContainText(standupConclusion);
  await standupCard
    .getByRole("button", { name: "打开摘要文档", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/documents\/[^/]+$/u);
  await expect(page.getByLabel("文档标题")).toHaveValue(/每日站会摘要/u);
  const standupDocumentBody = page.getByRole("textbox", {
    name: "Markdown 正文",
  });
  await expect(standupDocumentBody).toHaveValue(
    new RegExp(standupSummary, "u"),
  );
  await expect(standupDocumentBody).toHaveValue(
    new RegExp(standupConclusion, "u"),
  );
  // 同 533 那条：关联已进抽屉，先开抽屉再断，避免只验「DOM 里有」。
  await page.getByRole("button", { name: "权限与设置", exact: true }).click();
  const standupAssociations = page
    .locator("#mainPane .doc-drawer-wrap")
    .getByRole("region", { name: "文档关联" });
  await expect(standupAssociations).toBeVisible();
  await expect(standupAssociations).toContainText("暂无关联任务");
  await expect(standupAssociations).toContainText("暂无关联会议");

  await page.locator('[data-nav="backlog"]').click();
  await page.getByRole("tab", { name: "每日调研", exact: true }).click();
  await expect(
    page.locator("#taskPanel").getByRole("heading", {
      level: 3,
      name: "每日调研",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增调研", exact: true })
    .click();
  const researchDialog = page.getByRole("dialog", { name: "新增每日调研" });
  await expect(researchDialog.locator('input[name="source"]')).toHaveValue(
    "manual",
  );
  await researchDialog.locator('input[name="title"]').fill(researchTitle);
  await researchDialog
    .locator('textarea[name="summary"]')
    .fill(researchSummary);
  await researchDialog
    .getByRole("button", { name: "登记调研", exact: true })
    .click();
  await expect(researchDialog).toBeHidden();

  const researchCard = page
    .locator(".entry-card.research-card")
    .filter({ hasText: researchTitle });
  await expect(researchCard).toHaveCount(1);
  await expect(researchCard.getByText("manual", { exact: true })).toBeVisible();
  await expect(researchCard).toContainText(researchSummary);
  await expect(
    researchCard.getByText("已关联待办", { exact: true }),
  ).toBeVisible();
  await expect(
    researchCard.getByRole("button", { name: "打开调研文档", exact: true }),
  ).toBeVisible();
  await researchCard
    .getByRole("button", { name: "查看任务", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { level: 2, name: `调研建议：${researchTitle}` }),
  ).toBeVisible();
  await expect(page.locator(".detail-list")).toContainText("ID");
  await page.getByRole("button", { name: "返回任务面板", exact: true }).click();
  await researchCard
    .getByRole("button", { name: "打开调研文档", exact: true })
    .click();
  await expect(page).toHaveURL(/#\/documents\/[^/]+$/u);
  await expect(page.getByLabel("文档标题")).toHaveValue(
    `调研建议：${researchTitle}`,
  );
  await expect(
    page.getByRole("textbox", { name: "Markdown 正文" }),
  ).toHaveValue(new RegExp(researchSummary, "u"));
  expectNoBrowserErrors(browserErrors);
}

/**
 * 黄金路径（golden path）—— 本仓【唯一】一条跨模块主路径回归门。
 *
 * 一句话立场：这条测的不是任何一个功能，测的是【它们之间的那几根线】。
 * 其余每条 e2e 都是逐功能的（任务面板、派发、招聘、私聊、树、抽屉…各测一格），
 * 那种形状证明每块砖是好的，不证明墙是垒着的：把「新建文档」和「富文本宿主」之间、
 * 或「自动保存」和「PATCH 路由」之间的接线剪断，那些用例一条都不会红。
 * （故意不写「其余 N 条」：那个数字每加一条用例就得改一次，写死就是在埋会烂掉的坐标。）
 *
 * 判据全部取【服务端读回的值 == 用户在浏览器里敲进去的值】，不钉中间步骤的内部 DOM：
 * 钉 DOM 结构的话每次改版式都要来改这条，而它必须只有【一条】且几乎不许红，
 * 否则第三个月就没人管它了（第二条 golden path 的边际价值远低于成本，不加）。
 *
 * 每根线都要有【独立的】判据，别让两根线共用一次动作：第一轮 G1（剪树叶子 → openDocument）
 * 活了下来，因为新建弹窗自己就会把文档打开，树那次点击其实没有承重。
 * 现在的写法是先在树上点开建群自带的章程，再点回来，剪掉树那根线就断在第 ①④ 步。
 * 配套剪线探针：.workbuddy/scratch/round367-golden-wire-mutations.mjs（G1~G4）。
 *
 * 明确不在这一条里（都有别家射程，别往这里加）：派发执行、导入导出、版本还原、
 * 图片资产、权限的读侧强制、移动端。
 */
test("黄金路径：建群 → 树里点开 → 富文本真打字 → 自动保存落到服务端 → 抽屉授权落到服务端", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);

  // ① 建群自带一篇立项章程，先【从树上点开它】。这一下必须是真判据：
  //    「新建文档」按钮自带「创建并打开」，所以整条流程若只在新建的那篇上测编辑器，
  //    树叶子 → openDocument 这根线剪掉也没人红（round367 剪线变异 G1 第一轮就是这么放过的）。
  //    章程是 kind=markdown，宿主是 Markdown 正文那个 textarea，不是 Quill（Quill 只挂 kind=doc）。
  const alpha = await createGroupThroughUi(
    page,
    "黄金路径验收群",
    "验证从建群一路到改正文与授权",
  );
  const groupId = alpha.group.group_id;
  const charterId = alpha.document.doc_id;
  /** 等某一篇文档自己的详情 GET：宿主节点跨文档复用，只等元素出现会命中上一篇的正文。 */
  const detailGet = (id: string) =>
    page.waitForRequest(
      (request) =>
        request.method() === "GET" &&
        new URL(request.url()).pathname === `/api/v1/documents/${id}`,
      { timeout: 20_000 },
    );
  await page.locator('[data-nav="documents"]').click();
  const groupBranch = page.locator("#listContent .doc-tree-group").filter({
    has: page.locator(
      ':scope > summary .doc-tree-label:text-is("黄金路径验收群")',
    ),
  });
  await expect(groupBranch).toHaveCount(1);
  const charterLeaf = groupBranch
    .locator(".doc-list-item")
    .filter({ hasText: "立项：" });
  await expect(charterLeaf).toHaveCount(1);
  const richBody = page.getByRole("textbox", { name: "富文本正文" });
  const charterBody = page.getByRole("textbox", { name: "Markdown 正文" });
  // 先挂等待再点：详情 GET 就在点击那一下发出去，反过来写会错过已经跑完的请求。
  const charterOpened = detailGet(charterId);
  await charterLeaf.click();
  await charterOpened;
  await expect(charterBody).toHaveValue(/# 立项：黄金路径验收群/u);

  // ② 真新建一篇富文本正文（走创建弹窗，不从 API 建：这条要覆盖的就是「人怎么开始写」）
  const docId = await createDocumentThroughUi(
    page,
    "黄金路径正文",
    "doc",
    groupId,
    "首段：由创建弹窗写入",
  );

  // ③ 创建自带打开 ⇒ 正文宿主直接是可编辑的富文本引擎（「文件进来就是查看/编辑」那一格）。
  await expect(richBody).toHaveAttribute("contenteditable", "true");
  await expect(richBody).toContainText("首段：由创建弹窗写入");

  // ④ 回树上点章程 ⇒ 正文换成章程；再点回新建那篇 ⇒ 正文换回来。
  //    这两下就是【左栏树 ↔ 正文宿主】那根线本身：中间步骤的 DOM 一律不钉，
  //    只认「宿主里现在承载的是哪一篇」。选中项变化会牵动祖先强制展开，
  //    那套折叠规则归文档树那条用例细测，这里只当它必然通。
  const charterBack = detailGet(charterId);
  await charterLeaf.click();
  await charterBack;
  await expect(charterBody).toHaveValue(/## 成员清单/u);
  await expect(richBody).toHaveCount(0);
  const docLeaf = page
    .locator("#listContent .doc-tree .doc-list-item")
    .filter({ hasText: "黄金路径正文" })
    .first();
  const docBack = detailGet(docId);
  await docLeaf.click();
  await docBack;
  const body = page.getByRole("textbox", { name: "富文本正文" });
  await expect(body).toHaveAttribute("contenteditable", "true");
  await expect(body).toContainText("首段：由创建弹窗写入");

  // ⑤ 真打字 ⇒ 900ms 自动保存 ⇒ 服务端读回的正文 == 敲进去的内容。
  //    ⚠ 判据在【服务端的回答】里，不在「已自动保存」那行状态字里：状态字是前端自己写的，
  //    它亮了而 PATCH 打错端点/打错 doc_id 的情况，前端看不出来。
  await body.click();
  await page.keyboard.press("Control+End");
  const TYPED = "第二段：在富文本引擎里真敲进去的";
  await page.keyboard.type(TYPED);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/v1/documents/${docId}`,
    // 自动保存是 900ms 定时器，正常几百毫秒就回来了。给 20s 而不是默认的 240s：
    // 接线被剪掉时（剪线变异、端点改名）要立刻报「这个请求根本没发」，别让人等满 4 分钟。
    { timeout: 20_000 },
  );
  const echoed = await saved;
  expect(echoed.ok()).toBe(true);
  const readBack = (await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/documents/${id}`);
    return JSON.stringify(await res.json());
  }, docId)) as string;
  expect(readBack).toContain(TYPED);
  expect(readBack).toContain("首段：由创建弹窗写入");

  // ⑥ 右侧抽屉里授权 ⇒ 权限真的落到服务端（抽屉的开合与几何归 rich-editor.spec.ts ⑤，
  //    这里只接那一根线：表单 submit → POST → 库里那条权限）
  await page.getByRole("button", { name: "权限与设置", exact: true }).click();
  const drawer = page.locator("#mainPane .doc-drawer-wrap");
  await expect(drawer).toBeVisible();
  // grantee 用刚建出来的那个群（服务端 validateGrantee 要求被授权对象真实存在，
  // 合成 id 会被 member_not_found 挡下——那条拒绝路径有服务端测试管，别在这里测）：
  // 这条测的是【这条线通不通】，不是被授权方真能不能看见（读侧强制归 documents 的服务端测试）。
  const grantee = `group:${groupId}`;
  await drawer.locator('input[name="grantee"]').fill(grantee);
  await drawer.locator('select[name="tier"]').selectOption("editor");
  const permissionSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/documents/${docId}/permissions`,
    { timeout: 20_000 },
  );
  // 必须真点【保存权限】：授权走的是 form 的 submit，填完字段不发请求，
  // 只 fill 不 submit 的话 waitForResponse 会一路干等到超时。
  await drawer.getByRole("button", { name: "保存权限" }).click();
  const permissionEcho = await permissionSaved;
  expect(permissionEcho.ok()).toBe(true);
  const permissions = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/documents/${id}/permissions`);
    const data = await res.json();
    return JSON.stringify(data);
  }, docId);
  expect(permissions).toContain(grantee);
  expect(permissions).toContain("editor");

  expectNoBrowserErrors(browserErrors);
});

// 模板库在 0075 之前只有读的一面：界面 GET /templates、也真拿模板正文建新文档，
// 但 POST /templates（唯一能产出模板的路由）零调用方 —— 「从模板开始」永远只有
// 迁移种的那四张内置模板。所以这发证的是【生产】这一侧：界面上有入口、点了真发
// POST、服务端落的是 builtin=0 的新行、跨刷新还在、而且这张新模板马上能被
// 「从模板开始」消费（建出的文档正文 == 模板正文，正文展开发生在服务端）。
test("模板生产：新建模板真发 POST /templates，跨刷新还在且能被用来建文档", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="documents"]').click();
  const tplName = "交付复盘模板";
  const tplBody = "## 里程碑\n- 待填";
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/templates",
    // 按钮被摘掉/端点写错时立刻报「这个请求根本没发」，别干等默认 4 分钟。
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "新建模板", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新建模板" });
  await dialog.locator('input[name="name"]').fill(tplName);
  // 故意选非默认的「富文本」：默认就是 markdown 的话，kind 被写死成 markdown
  // 的变异在这条用例上是活的 —— 每根线要有自己的那次动作。
  await dialog.locator('select[name="kind"]').selectOption("doc");
  await dialog.locator('textarea[name="body_text"]').fill(tplBody);
  await dialog.getByRole("button", { name: "创建模板", exact: true }).click();
  const createdResponse = await created;
  expect(createdResponse.ok()).toBe(true);
  expect(createdResponse.request().postDataJSON()).toMatchObject({
    name: tplName,
    kind: "doc",
    body_text: tplBody,
  });
  const createdBody = (await createdResponse.json()) as {
    template: { template_id: string; builtin: boolean };
  };
  expect(createdBody.template.builtin).toBe(false);

  // 不刷新就该出现在「从模板开始」：证 onSubmit 里那次 loadAuxiliary+renderMain
  // 真的把新行灌回了界面状态，而不是只活在 toast 里。
  const tplChip = page
    .locator("#view .card")
    .filter({ has: page.locator("h3", { hasText: "从模板开始" }) })
    .getByRole("button", { name: tplName, exact: true });
  await expect(tplChip).toBeVisible();

  // 跨刷新还在：只有本地状态（没落库）的话这一条会红。
  await page.reload();
  await page.locator('[data-nav="documents"]').click();
  await expect(tplChip).toBeVisible();

  // 闭环：这张自建模板马上能被消费 —— 点开它、填标题、创建，
  // 文档正文必须是模板正文（服务端按 template_id 展开，不是 UI 自己拼的）。
  await tplChip.click();
  const docDialog = page.getByRole("dialog", { name: `从“${tplName}”起稿` });
  await docDialog.locator('input[name="title"]').fill("复盘·用自建模板");
  const docCreated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/documents",
    { timeout: 20_000 },
  );
  await docDialog
    .getByRole("button", { name: "创建并打开", exact: true })
    .click();
  const docResponse = await docCreated;
  expect(docResponse.ok()).toBe(true);
  const docBody = (await docResponse.json()) as {
    document: { doc_id: string };
  };
  const fetched = await page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/documents/${id}`);
    return (await res.json()) as { document: { body_text: string } };
  }, docBody.document.doc_id);
  expect(fetched.document.body_text).toBe(tplBody);

  expectNoBrowserErrors(browserErrors);
});

// 头像那根线在 0074 之前压根不存在：界面让人手填一个 asset_id，而没有任何地方
// 产出 purpose='avatar' 的资产。所以这发要证的是【上传】这一侧 —— 选图真发出
// purpose=avatar 的 POST /assets、返回的 asset_id 真落到隐藏域、保存真落到
// /members/:id/avatar，最后跨刷新还在（只有本地状态的话这一条会红）。
test("头像上传：选图即传 avatar 资产，保存后头像指向该资产且跨刷新仍在", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator("[data-member-row]")
    .filter({ has: page.locator("strong", { hasText: /^产品经理$/ }) })
    .click();
  const saveAvatar = page.getByRole("button", {
    name: "更新头像",
    exact: true,
  });
  const avatarForm = page.locator("form").filter({ has: saveAvatar });
  await expect(avatarForm).toBeVisible();

  const uploaded = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/assets",
  );
  const chooserPromise = page.waitForEvent("filechooser");
  await avatarForm
    .getByRole("button", { name: "上传图片作为头像", exact: true })
    .click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(AVATAR_PNG_BASE64, "base64"),
  });
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBe(true);
  expect(uploadResponse.request().postDataJSON()).toMatchObject({
    purpose: "avatar",
    mime: "image/png",
  });
  const uploadedBody = (await uploadResponse.json()) as {
    created: boolean;
    asset: { asset_id: string; purpose: string };
  };
  expect(uploadedBody.created).toBe(true);
  expect(uploadedBody.asset.purpose).toBe("avatar");
  const assetId = uploadedBody.asset.asset_id;

  // 上传只登记，绑定仍是保存按钮那一次：隐藏域落 id，种子被清空（否则二选一必拒）。
  await expect(avatarForm.locator('input[name="avatar_asset_id"]')).toHaveValue(
    assetId,
  );
  await expect(avatarForm.locator('input[name="avatar_seed"]')).toHaveValue("");
  await expect(page.locator("#toastRegion")).toContainText("头像图片已上传");

  const bound = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/members/pm-ui/avatar",
  );
  await avatarForm
    .getByRole("button", { name: "更新头像", exact: true })
    .click();
  const boundResponse = await bound;
  expect(boundResponse.ok()).toBe(true);
  expect(boundResponse.request().postDataJSON()).toEqual({
    avatar_asset_id: assetId,
  });
  await expect(page.locator("#toastRegion")).toContainText("头像已更新");

  // 跨刷新仍指向那枚资产：读的是服务端 members 行，不是本页的内存态。
  await page.reload();
  const stored = await page.evaluate(async () => {
    const res = await fetch("/api/v1/members");
    const body = (await res.json()) as {
      members: { member_id: string; avatar_asset_id: string | null }[];
    };
    const member = body.members.find((m) => m.member_id === "pm-ui");
    return member?.avatar_asset_id ?? null;
  });
  expect(stored).toBe(assetId);

  // 头像位真的画出这枚资产（URL 由 avatarUrl 按 avatar_asset_id 拼）。
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page
    .locator("[data-member-row]")
    .filter({ has: page.locator("strong", { hasText: /^产品经理$/ }) })
    .click();
  const rebuiltForm = page.locator("form").filter({ has: saveAvatar });
  await expect(rebuiltForm.locator(".avatar img")).toHaveAttribute(
    "src",
    `/api/v1/assets/${assetId}`,
  );

  // 二选一那道守卫的承重格：重传同一张图（同用途 ⇒ 拿回同一行，不新增），再手填
  // 一个种子，此时保存必须【当场拦下且一个请求都不发】—— 否则后写的种子会把刚绑
  // 好的图片头像顶掉，而界面上两次操作都显示成功。
  const secondUpload = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/assets",
  );
  const secondChooser = page.waitForEvent("filechooser");
  await rebuiltForm
    .getByRole("button", { name: "上传图片作为头像", exact: true })
    .click();
  const secondFile = await secondChooser;
  await secondFile.setFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: Buffer.from(AVATAR_PNG_BASE64, "base64"),
  });
  const secondResponse = await secondUpload;
  const secondBody = (await secondResponse.json()) as {
    created: boolean;
    asset: { asset_id: string };
  };
  expect(secondBody.created).toBe(false);
  expect(secondBody.asset.asset_id).toBe(assetId);

  await rebuiltForm.locator('input[name="avatar_seed"]').fill("late-seed");
  let avatarWrites = 0;
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      new URL(req.url()).pathname === "/api/v1/members/pm-ui/avatar"
    )
      avatarWrites += 1;
  });
  await saveAvatar.click();
  await expect(page.locator("#toastRegion")).toContainText("只能二选一");
  expect(avatarWrites).toBe(0);

  // 拦下之后服务端仍是那次图片绑定：头像资产没被种子顶掉。
  const afterGuard = await page.evaluate(async () => {
    const res = await fetch("/api/v1/members");
    const body = (await res.json()) as {
      members: {
        member_id: string;
        avatar_asset_id: string | null;
        avatar_seed: string;
      }[];
    };
    const member = body.members.find((m) => m.member_id === "pm-ui");
    return {
      asset: member?.avatar_asset_id ?? null,
      seed: member?.avatar_seed ?? null,
    };
  });
  expect(afterGuard).toEqual({ asset: assetId, seed: "" });

  expectNoBrowserErrors(browserErrors);
});

// 全局搜索在 0076 之前有六面的落点、七面的数据：服务端 GROUP_SQL 一直真发群命中，
// 渲染侧却既没有 group 这一格标签（h() 对 undefined 是静默跳过属性 ⇒ 空白徽标），
// 也没有 group 这条分支（点下去下拉关掉、屏幕原地不动）。所以这发证两面：
// 徽标读得出「群」，点下去真落到那个群的会话（不是停在原地）。
test("全局搜索群命中：徽标是「群」且点击真落到该群会话", async ({ page }) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  const groupTitle = "搜索落点验收群";
  const created = await createGroupThroughUi(
    page,
    groupTitle,
    "验证搜索命中群",
  );
  const groupId = created.group.group_id;

  // 换一个群命中不在眼前的页面再搜：这样「点击后换了屏」才是这一发观察得到的事。
  // 停在消息页时刚建的群本来就是选中会话，剪掉分支也可能因为已在原地而假绿。
  await page.locator('[data-nav="documents"]').click();
  await expect(page).toHaveURL(/#\/documents/u);

  const conversationId = await page.evaluate(async (id) => {
    const res = await fetch("/api/v1/conversations");
    const body = (await res.json()) as {
      conversations: { conversation_id: string; group_id: string | null }[];
    };
    return (
      body.conversations.find((entry) => entry.group_id === id)
        ?.conversation_id ?? ""
    );
  }, groupId);
  // 前提不成立就别往下走：没有群会话时落点会是群详情而不是会话，那条 URL 断言
  // 红的就不是「分支缺失」而是这个用例自己的前提。
  expect(conversationId).not.toBe("");

  const searched = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/v1/search" && response.ok(),
    { timeout: 20_000 },
  );
  await page.locator("#globalSearch").fill(groupTitle);
  const hits = (await (await searched).json()) as {
    hits: { face: string; id: string }[];
  };
  // 服务端这一面真有数据（否则下面徽标/点击绿的是「压根没有群命中」）。
  expect(
    hits.hits.some((hit) => hit.face === "group" && hit.id === groupId),
  ).toBe(true);

  const row = page.locator(
    `.search-result[data-face="group"][data-id="${groupId}"]`,
  );
  await expect(row).toBeVisible();
  // 徽标那一格：faceLabels 少 group 键时 h() 静默不写这个属性，这里是空字符串。
  await expect(row.locator(".search-face")).toHaveText("群");

  await row.click();
  // 分支的落点：会话 id 进 hash（setRoute 写的那一枚）+ 群会话面板真画出来。
  await expect
    .poll(() => page.evaluate(`window.location.hash`))
    .toBe(`#/messages/${encodeURIComponent(conversationId)}`);
  await expect(page.locator("#group-chat-panel")).toHaveCount(1);

  expectNoBrowserErrors(browserErrors);
});

// 契约声明了 before_seq（「往旧翻」游标），服务端实现并测过它，docstring 甚至
// 点名「前端上拉历史是 prepend」——而 0077 之前的渲染侧只发 ?limit=200 并整体
// 覆盖数组：超过一页的历史【静默】不可达（不报错，看起来就像历史只有这么多）。
// 这一发闭环四根线：①首页封顶时「查看更早」出现而更早的消息确实不可见；
// ②点它真带 before_seq=最旧已加载 seq；③服务端页升序 prepend 到流头
// （消息自己报 seq，顺序判据不靠渲染时刻）；④短页 = 到底，按钮收起。
test("会话历史翻页：满一页后有「查看更早」，点击带游标 prepend 且到底收起", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  // 不带成员建群：POST 消息的 CoS 派发在 cos_missing 处立即返回，
  // 201 发种子各写一条，不触发模型调用。
  const created = await createGroupThroughUi(
    page,
    "历史翻页验收群",
    "验证超过一页的会话历史可达",
  );
  const groupId = created.group.group_id;

  // 先换到文档页再灌种子：每一发 POST 都会发 SSE 事件，停在消息页时每个事件
  // 都触发一次整页历史重取（loadMessages 覆盖数组）——既慢，又会在点「更早」
  // 附近留一发可能吞掉 prepend 的迟到快照。换页后刷新只重画文档列表。
  await page.locator('[data-nav="documents"]').click();
  await expect(page).toHaveURL(/#\/documents/u);

  const conversationId = await page.evaluate(async (id) => {
    const res = await fetch("/api/v1/conversations");
    const body = (await res.json()) as {
      conversations: { conversation_id: string; group_id: string | null }[];
    };
    return (
      body.conversations.find((entry) => entry.group_id === id)
        ?.conversation_id ?? ""
    );
  }, groupId);
  // 前提不成立红在前提本身：没有群会话就没有可翻的历史，下面的红会冒充「分支缺失」。
  expect(conversationId).not.toBe("");

  const TOTAL = 201; // 契约页界 200 + 1：最早那条恰好落在首屏窗口之外。
  const seeded = await page.evaluate(
    async ({ cid, count }: { cid: string; count: number }) => {
      let written = 0;
      for (let i = 0; i < count; i += 1) {
        const res = await fetch(
          `/api/v1/conversations/${encodeURIComponent(cid)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: `史前消息 ${String(i).padStart(3, "0")}`,
            }),
          },
        );
        if (!res.ok) throw new Error(`种子第 ${String(i)} 条写入失败`);
        written += 1;
      }
      return written;
    },
    { cid: conversationId, count: TOTAL },
  );
  expect(seeded).toBe(TOTAL);

  // goto 整页重载 ⇒ 走一次完整的 boot + loadMessages（首页 = 最新 200 条，
  // seq 2..201），并且这仍是消息页：SSE 重取只会覆盖成最新 200 条，而那正是
  // 翻页前应有的样子 —— 已翻出的那一页从这一刻作废是设计内的行为。
  await page.goto(
    `${webOrigin}/#/messages/${encodeURIComponent(conversationId)}`,
  );
  await expect(page.locator("#load-older")).toBeVisible();

  // 服务端权威读数：整序升序、被 limit 截断（seq 1 在响应里缺席）——否则下面
  // 「按钮出现 + 第一条不可见」绿的是「压根没有超出页界的历史」。
  const pageOne = await page.evaluate(async (cid) => {
    const res = await fetch(
      `/api/v1/conversations/${encodeURIComponent(cid)}/messages?limit=200`,
    );
    const body = (await res.json()) as {
      messages: { seq_in_conv: number; body: string }[];
    };
    return body.messages.map((m) => m.seq_in_conv);
  }, conversationId);
  expect(pageOne).toHaveLength(200);
  const seqs = [...pageOne].sort((a, b) => a - b);
  expect(seqs[0]).toBe(2); // seq 1 被 limit 挡在首屏之外（服务端截断属实）
  expect(seqs[199]).toBe(201);
  // 服务端契约：返回升序（prepend 的前提；前端再 reverse 就会翻错）。
  expect(pageOne).toEqual(seqs);

  // 第一根线：首屏正文帧 = 200 行 + 按钮在位 + 更早那条【在屏幕上不存在】。
  // 这一发和下一发的「点击后有它」合起来才排除「一直都在、按钮是装饰」。
  // ⚠ 判据读的是 settledChatFrame（正文帧快照），不是一条条 locator 轮询 ——
  // 后者跨渲染帧，会把 loadMessages 的骨架帧（0 行、无按钮）当成结论。
  const firstPage = await settledChatFrame(page, { rows: 200 });
  expect(firstPage.rows).toBe(200);
  expect(firstPage.button).toBe(true);
  expect(firstPage.prehistoric).toBe(0);

  // wait 挂在动作之前（家法）：点完再挂，响应可能已在两次 await 之间落地。
  // 谓词点名 before_seq —— 会话的 GET /messages 不止一发（SSE 触发的重取也算），
  // 只认 pathname 会让首屏那一发把 wait 提前喂饱。
  // 先把屏幕放到流的最顶端，让基线与点击时刻【同一处】：#load-older 就长在流的头
  // 上，Playwright 点它会自己滚上去，拿打开时那一发（贴在最新消息）当基线，量的
  // 就不是那对锚点动的这一段。
  await setChatScroll(page, 0);
  const beforePaging = await settledChatFrame(page, { rows: 200 });
  expect(beforePaging.top).toBe(0);
  const pagedPromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  await page.locator("#load-older").click();
  const paged = await pagedPromise;
  // 第二根线：查询真带游标，且游标 == 最旧已加载的 seq（=2）。「服务端返回 1 条」
  // 这条判据把游标和 SQL 的严格小于缝死：游标写成 1 ⇒ 返回 0 条，当场红。
  const sentUrl = new URL(paged.url());
  expect(sentUrl.searchParams.get("before_seq")).toBe("2");
  const older = (await paged.json()) as {
    messages: { seq_in_conv: number }[];
  };
  expect(older.messages.map((m) => m.seq_in_conv)).toEqual([1]);

  // 第三根线 + 第四根线：那条消息落到流【头】，且短页（1 < 200）= 到底 ⇒ 按钮收起。
  // 判据读的是消息自己报的 data-seq（服务端事实），不是渲染时刻的几何。
  //
  // ⚠ 两根线读【同一帧的不同字段】不是偷懒：loadOlderMessages 在同一个 try 里 prepend
  // 并重算 messagesHasMore、finally 才重画，所以「头上是 seq 1」与「按钮已收起」天然
  // 落在同一帧。两根线仍各自红在不同字段（M5 prepend 改 append 红在 firstSeq/ascending，
  // M3 判据丢掉「满一整页」红在 button —— 那一格恒真，按钮永不缺席）。
  //
  // ⚠ button 必须是【正文帧里】的缺席：骨架帧同样没有按钮，缺席判据在它上面恒真
  // （round392 变异机在 M3/M5/M11 上报绿的漏检点就在这个形状上）。
  const afterPaging = await settledChatFrame(page, { rows: 201 });
  expect(afterPaging.rows).toBe(201);
  expect(afterPaging.firstSeq).toBe(1);
  expect(afterPaging.firstText).toBe("史前消息 000");
  expect(afterPaging.ascending).toBe(true);
  expect(afterPaging.button).toBe(false);

  // 第 3.5 根线（往旧翻那一头的滚动锚点）：prepend 在【上方】加了一段内容，
  // 视口必须停在原来正看着的那条消息上 —— 也就是往下走「恰好新加那一段」的高度。
  // 尺子用实测：scrollTop == 新内容高 − 旧内容高（锚点写的是 scrollHeight − 旧 scrollTop，
  // 而基线 scrollTop=0），不写死行高（行高会变，这个恒等式不会）。
  // 剪掉 loadOlderMessages 的恢复 ⇒ 新节点 scrollTop 停在 0（屏幕跳到流头）；
  // 把两把尺子「统一」成 chatScrollAnchor（留住 scrollTop）⇒ 同样写回 0：两种写法
  // 都在这一发红，而上面那五条内容判据对这两者全都无感（首行的 data-seq 与锚点无关）。
  expect(afterPaging.top).toBeGreaterThan(0);
  expect(afterPaging.top).toBe(afterPaging.sh - beforePaging.sh);

  // 第五根线：到底之后逼一次【背景整页重读】（刷新按钮走 runRefreshAll，与 SSE
  // 事件触发的是同一条 loadMessages 路径）。它读的是最新一页，若直接整体覆盖数组，
  // 刚翻出来的「史前消息 000」会被吞回去、游标退回 2、「查看更早」原地复活 ——
  // 而这三件事都不报错。首版没有这一发：同一形状在变异机预检里连红两轮，
  // 红的就是这条被静默吞掉的历史（当时判据只量到「点击之后」那一次）。
  //
  // ⚠ 正确代码下重读前后的屏幕【逐像素相同】（保留段的存在就是为了这个），所以
  // 「读了哪一帧」不能靠内容分辨，只能靠帧号：先领一次号，再要求读到的正文帧
  // 是【新号】—— 否则这一发量的是重读之前的旧帧，等于什么都没量。
  const beforeRefresh = await settledChatFrame(page, { rows: 201 });
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      !new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "刷新消息" }).click();
  await refreshed;
  const afterRefresh = await settledChatFrame(page, {
    afterRenderId: beforeRefresh.renderId,
  });
  expect(afterRefresh.renderId).not.toBe(beforeRefresh.renderId);
  expect(afterRefresh.rows).toBe(201);
  expect(afterRefresh.firstSeq).toBe(1);
  expect(afterRefresh.firstText).toBe("史前消息 000");
  expect(afterRefresh.button).toBe(false);

  expectNoBrowserErrors(browserErrors);
});

test("会话滚动位置：翻上去读旧史时背景重读留在原地，用户自己的动作照旧跳底", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  const created = await createGroupThroughUi(
    page,
    "滚动锚点验收群",
    "验证背景重读不把视口跳回底部",
  );
  const groupId = created.group.group_id;

  // 与 0077 同一手：先在文档页灌种子。每条 POST 都发 SSE 事件，停在消息页时
  // 每个事件都触发一发重读 —— 那会把「谁改了滚动位置」变成归不了因的一团。
  await page.locator('[data-nav="documents"]').click();
  await expect(page).toHaveURL(/#\/documents/u);
  const conversationId = await page.evaluate(async (id) => {
    const res = await fetch("/api/v1/conversations");
    const body = (await res.json()) as {
      conversations: { conversation_id: string; group_id: string | null }[];
    };
    return (
      body.conversations.find((entry) => entry.group_id === id)
        ?.conversation_id ?? ""
    );
  }, groupId);
  expect(conversationId).not.toBe("");

  // 60 条：够把消息流撑出【两屏以上】的溢出（判据要能在上下两头分辨位置），
  // 又不到页界 200（本发测的是「重读不改视口」，不掺翻页的保留段）。
  const SEED = 60;
  const seeded = await page.evaluate(
    async ({ cid, count }: { cid: string; count: number }) => {
      let written = 0;
      for (let i = 0; i < count; i += 1) {
        const res = await fetch(
          `/api/v1/conversations/${encodeURIComponent(cid)}/messages`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              body: `锚点消息 ${String(i).padStart(2, "0")}`,
            }),
          },
        );
        if (!res.ok) throw new Error(`种子第 ${String(i)} 条写入失败`);
        written += 1;
      }
      return written;
    },
    { cid: conversationId, count: SEED },
  );
  expect(seeded).toBe(SEED);

  await page.goto(
    `${webOrigin}/#/messages/${encodeURIComponent(conversationId)}`,
  );
  const opened = await settledChatFrame(page, { rows: SEED });
  // 尺子的前提：这一屏真能滚（sh>ch），且打开时落在最新消息上。
  // 前提红在前提自己 —— 若消息流压根不滚（overflow 不是 auto），后面每一发
  // 「位置不动」都是 scrollTop 恒为 0 的假绿。
  expect(opened.sh).toBeGreaterThan(opened.ch);
  expect(opened.dist).toBe(0);

  // 往上翻到溢出段的一半（不写死像素：行高与视口会变，但「一半」恒在贴底带之外）。
  const halfway = (await page.evaluate(CHAT_HALF_SCROLL_PROBE)) as number;
  expect(halfway).toBeGreaterThan(0);
  await setChatScroll(page, halfway);
  const upHere = await settledChatFrame(page, { rows: SEED });
  // 浏览器没把 scrollTop 夹回去（= 这一屏确实在 600 那个量级之上还能滚）。
  expect(upHere.top).toBe(halfway);
  // ⚠ 80 = group.js 的 CHAT_BOTTOM_STICK_PX：这一发必须在贴底带【之外】，
  // 否则「留在原地」与「跟随底部」在这里根本分不开。
  expect(upHere.dist).toBeGreaterThan(80);

  // 第一根线（背景重读那一头）：刷新按钮走 loadMessages，与 SSE 事件同一条路径。
  // 判据 = 读到的是【新帧】且 scrollTop 逐像素不动、距底距离也不动。
  const beforeRefresh = upHere;
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      !new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  await page.getByRole("button", { name: "刷新消息" }).click();
  await refreshed;
  const afterRefresh = await settledChatFrame(page, {
    afterRenderId: beforeRefresh.renderId,
    rows: SEED,
  });
  // 帧号必须换：不换 = 量的是重读之前的旧帧，「位置没动」等于什么都没量。
  expect(afterRefresh.renderId).not.toBe(beforeRefresh.renderId);
  expect(afterRefresh.top).toBe(beforeRefresh.top);
  expect(afterRefresh.dist).toBe(beforeRefresh.dist);

  // 第二根线（下方长了东西）：别人发了一条 → 背景重读把它读进来。新增落在【下方】，
  // 所以视口仍该停在原地，而不是被拽去看那条新消息。
  const arrived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      !new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  const posted = await page.evaluate(async (cid) => {
    const res = await fetch(
      `/api/v1/conversations/${encodeURIComponent(cid)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "别人刚发的插话" }),
      },
    );
    return res.ok;
  }, conversationId);
  expect(posted).toBe(true);
  await arrived;
  // SSE 那一发（若先到）与手动刷新任一都行：只要读到【比上一发更新的正文帧】，
  // 且行数真的多了一条（= 新增落在下方这件事成立了）。
  await page.getByRole("button", { name: "刷新消息" }).click();
  const withNew = await settledChatFrame(page, {
    afterRenderId: afterRefresh.renderId,
    rows: SEED + 1,
  });
  expect(withNew.top).toBe(afterRefresh.top);
  expect(withNew.firstText).toBe(afterRefresh.firstText);
  expect(withNew.dist).toBeGreaterThan(80);

  // 第三根线（用户自己的动作 = 重画）：点「回复」引起一次整格重画，内容没变，
  // 视口也不该动。这一发是 renderMain 那对锚点唯一的动作 —— 摘下来的节点量不到
  // 几何（scrollHeight/clientHeight 一律 0），所以锚点只能读在拆之前。
  // ⚠ 挑一枚【已在视口正中】的回复按钮：Playwright 点击前会 scrollIntoViewIfNeeded，
  // 拿视口外的按钮就会自己把 scrollTop 改了，红了分不清是缺陷还是自动滚动。
  const replyIndex = (await page.evaluate(CHAT_REPLY_ROW_PROBE)) as number;
  expect(replyIndex).toBeGreaterThanOrEqual(0);
  const replied = await settledChatFrame(page, { rows: SEED + 1 });
  await page
    .locator(".message-row")
    .nth(replyIndex)
    .getByRole("button", { name: "回复" })
    .click();
  await expect(page.locator(".reply-bar")).toBeVisible();
  const afterReply = await settledChatFrame(page, {
    afterRenderId: replied.renderId,
    rows: SEED + 1,
  });
  expect(afterReply.renderId).not.toBe(replied.renderId);
  expect(afterReply.top).toBe(replied.top);

  // 第四根线：取消回复（按钮在 composer 里，不在消息流内 ⇒ 无自动滚动干扰）
  // 又是一次 renderMain，位置照旧不动。
  const cancelled = await settledChatFrame(page, { rows: SEED + 1 });
  await page.getByRole("button", { name: "取消回复" }).click();
  await expect(page.locator(".reply-bar")).toHaveCount(0);
  const afterCancel = await settledChatFrame(page, {
    afterRenderId: cancelled.renderId,
    rows: SEED + 1,
  });
  expect(afterCancel.top).toBe(cancelled.top);

  // 第四根半（正向的另一半）：贴在底部的人【要】跟着新消息走 —— 只判「翻上去不动」
  // 会把修法写成「永不跳底」，那一半在这里红。滚到底 → 背景重读 → 仍贴底。
  await scrollChatToBottom(page);
  const atBottom = await settledChatFrame(page, { rows: SEED + 1 });
  expect(atBottom.dist).toBe(0);
  await page.getByRole("button", { name: "刷新消息" }).click();
  const afterBottomRefresh = await settledChatFrame(page, {
    afterRenderId: atBottom.renderId,
    rows: SEED + 1,
  });
  expect(afterBottomRefresh.renderId).not.toBe(atBottom.renderId);
  expect(afterBottomRefresh.dist).toBe(0);

  // 第四根¾（贴底那一支自己的动作）：贴着底部时【来了新消息】，必须跟着走。
  // 少了这一发，「贴底判定」这一格是抓不到的 —— pinned 恒写成 false 时，重读写回的
  // 是 anchor.top = 当时的最大滚动量，内容没变就等于贴底（上一发照旧绿）；只有内容
  // 长高才露馅：停在旧底 = 离底差一整条消息。判据用 dist===0（正确代码下恒等），
  // 不写行高阈值。
  const pinnedArrived = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      !new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  const postedAgain = await page.evaluate(async (cid) => {
    const res = await fetch(
      `/api/v1/conversations/${encodeURIComponent(cid)}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: "贴着底部时来的那条" }),
      },
    );
    return res.ok;
  }, conversationId);
  expect(postedAgain).toBe(true);
  await pinnedArrived;
  await page.getByRole("button", { name: "刷新消息" }).click();
  const followed = await settledChatFrame(page, {
    afterRenderId: afterBottomRefresh.renderId,
    rows: SEED + 2,
  });
  expect(followed.dist).toBe(0);
  expect(followed.firstText).toBe(afterBottomRefresh.firstText);

  // 第五根线（反向）：发送那一发【必须】跳到底 —— 用户自己的动作。
  // ⚠ 先退回半途再发：上面刚贴过底，而贴底的人【不加那一行也会】被锚点送到底
  // （renderMain 与 loadMessages 都读到 pinned=true）—— 那一行就成了不承重的装饰。
  // 从半途发才分得开：没有发送那一跳，两对锚点都会把他留在半途 ⇒ 红。
  await setChatScroll(page, halfway);
  const beforeSend = await settledChatFrame(page, { rows: SEED + 2 });
  expect(beforeSend.top).toBe(halfway);
  expect(beforeSend.dist).toBeGreaterThan(80);
  const sending = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname ===
        `/api/v1/conversations/${conversationId}/messages` &&
      !new URL(response.url()).searchParams.has("before_seq") &&
      response.ok(),
    { timeout: 20_000 },
  );
  await page.locator('textarea[name="body"]').fill("我自己发的最新一条");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await sending;
  const afterSend = await settledChatFrame(page, {
    afterRenderId: beforeSend.renderId,
    rows: SEED + 3,
  });
  expect(afterSend.renderId).not.toBe(beforeSend.renderId);
  expect(afterSend.top).toBeGreaterThan(beforeSend.top);
  // 贴底读数 = 正看着自己刚发的那条（不是「离底还有一屏」）。
  expect(afterSend.dist).toBe(0);

  expectNoBrowserErrors(browserErrors);
});

interface ChatFrame {
  readonly renderId: string;
  readonly skeleton: boolean;
  readonly rows: number;
  readonly firstSeq: number | null;
  readonly firstText: string;
  readonly ascending: boolean;
  readonly button: boolean;
  readonly prehistoric: number;
  readonly top: number;
  readonly sh: number;
  readonly ch: number;
  readonly dist: number;
}

/**
 * 页侧探针（字符串形式：types:[node] 下页内闭包拿不到外层标识符）。
 *
 * renderId 是这一帧宿主节点的标记：renderChat 每次 view.replaceChildren() 重建
 * .message-stream，给节点打标等于给「这一帧」领了号 —— 调用方由此能证明读到的帧
 * 晚于它做动作的那一次，而不是页面刚切过来时的旧帧。
 *
 * 滚动几何（top/sh/ch/dist）与帧号【同一次求值】读出：分开两次读，中间就可能插进
 * 一发重画，量到的是「上一帧的位置 + 这一帧的内容」。dist = scrollHeight - scrollTop
 * - clientHeight，即「距底」，0 = 正看着最新消息。
 */
const CHAT_FRAME_PROBE = `
(() => {
  const stream = document.querySelector(".message-stream");
  if (stream && !stream.dataset.frameMark) {
    const w = window;
    w.__frameSeq = (w.__frameSeq ?? 0) + 1;
    stream.dataset.frameMark = String(w.__frameSeq);
  }
  const rows = Array.from(document.querySelectorAll(".message-row"));
  const bubbles = rows.map((row) => row.querySelector(".bubble"));
  const seqs = rows.map((row) => Number(row.getAttribute("data-seq")));
  const firstBubble = bubbles.length > 0 ? bubbles[0] : null;
  return {
    renderId: stream === null ? "" : (stream.dataset.frameMark ?? ""),
    skeleton: document.querySelector(".skeleton-chat") !== null,
    rows: rows.length,
    firstSeq: rows.length === 0 ? null : Number(rows[0].getAttribute("data-seq")),
    firstText: firstBubble === null ? "" : (firstBubble.textContent ?? ""),
    ascending: seqs.every((seq, i) => i === 0 || seqs[i - 1] <= seq),
    button: document.querySelector("#load-older") !== null,
    prehistoric: bubbles.filter((b) => (b?.textContent ?? "") === "史前消息 000").length,
    top: stream === null ? -1 : stream.scrollTop,
    sh: stream === null ? -1 : stream.scrollHeight,
    ch: stream === null ? -1 : stream.clientHeight,
    dist:
      stream === null
        ? -1
        : stream.scrollHeight - stream.scrollTop - stream.clientHeight,
  };
})()
`;

/**
 * 页侧几何操作（全部字符串形式：types:[node] 下页内闭包拿不到外层标识符，
 * 写成箭头函数会整片报 TS2584，round377 记过这一手）。
 */
const CHAT_HALF_SCROLL_PROBE = `
(() => {
  const stream = document.querySelector(".message-stream");
  if (stream === null) return -1;
  return Math.floor((stream.scrollHeight - stream.clientHeight) / 2);
})()
`;

/**
 * 把消息流滚到给定像素。
 *
 * ⚠ 像素是拼进串里的【数字】，不是页内闭包、也不走 evaluate 的 arg ——
 * types:[node] 下页内箭头函数会整片报 TS2584（round377 记过这一手），而字符串
 * pageFunction 配 arg 的求值形状不是本仓验过的路子。数字拼串对判据无损：
 * 量的是「滚完之后停在哪」，怎么滚进来的这一发不需要承重。
 */
async function setChatScroll(page: Page, px: number): Promise<void> {
  await page.evaluate(
    `(() => { const s = document.querySelector(".message-stream"); if (s) s.scrollTop = ${String(
      px,
    )}; return s === null ? -1 : s.scrollTop; })()`,
  );
}

async function scrollChatToBottom(page: Page): Promise<void> {
  await page.evaluate(CHAT_TO_BOTTOM_PROBE);
}

/** 滚到底 = 用户正看着最新消息（贴底）。 */
const CHAT_TO_BOTTOM_PROBE = `
(() => {
  const stream = document.querySelector(".message-stream");
  if (stream) stream.scrollTop = stream.scrollHeight;
  return stream === null ? -1 : stream.scrollTop;
})()
`;

/**
 * 找一枚【整行都在视口内】的消息行下标。
 *
 * ⚠ Playwright 点击前会 scrollIntoViewIfNeeded —— 拿视口外的按钮就会自己改掉
 * scrollTop，红了分不清是缺陷还是自动滚动，所以这一发必须由页侧先把行选好。
 */
const CHAT_REPLY_ROW_PROBE = `
(() => {
  const stream = document.querySelector(".message-stream");
  if (stream === null) return -1;
  const box = stream.getBoundingClientRect();
  const rows = Array.from(document.querySelectorAll(".message-row"));
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i].getBoundingClientRect();
    if (r.top > box.top + 60 && r.bottom < box.bottom - 60) return i;
  }
  return -1;
})()
`;

/**
 * 读【一帧正文】的快照：等掉加载骨架、等掉标记之前的旧帧，一次求值读全六项。
 *
 * ⚠ 为什么不能用逐条 locator 断言：它们各自轮询、各自跨帧，而 loadMessages 的
 * 骨架帧里 .message-row 是 0 行、#load-older 也不在 —— 【缺席类】判据会在这一帧
 * 被凭空喂饱（绿的是「正在加载」，不是「到底收起」）。round392 变异机在 M3/M5/M11
 * 上报绿正是这个漏检点：同一变异手跑必红、在机器上却撞上骨架帧。缺席要成立，
 * 必须【在正文帧里】缺席；骨架帧的缺席不是证据。
 *
 * 条件必须【点名这一发在等的帧】（行数 / 帧号），不能只写「有行」：
 * 「有行 + 非骨架」会被点击之前就存在的旧帧喂饱，红了归不了因、绿了也是假绿。
 * 不设 rows 条件时（第五根线）靠 afterRenderId 保证读到的是重读【之后】的新帧 ——
 * 保留逻辑正确时重读前后屏幕相同，行数不能当条件，M9 的缺陷帧（行数掉回 200）
 * 恰恰是要报的东西，条件里排除它反而会把该红的那一帧跳成超时。
 */
async function settledChatFrame(
  page: Page,
  want: { afterRenderId?: string; rows?: number } = {},
): Promise<ChatFrame> {
  let last = (await page.evaluate(CHAT_FRAME_PROBE)) as unknown as ChatFrame;
  await expect
    .poll(
      async () => {
        last = (await page.evaluate(CHAT_FRAME_PROBE)) as unknown as ChatFrame;
        return (
          last.skeleton === false &&
          (want.rows === undefined || last.rows === want.rows) &&
          (want.afterRenderId === undefined ||
            last.renderId !== want.afterRenderId)
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return last;
}

/** 中栏一次求值读全的快照（筛选栏 + 列表 + 焦点 + 滚动），见 LIST_STATE_PROBE。 */
interface ListState {
  readonly searches: number;
  readonly selects: number;
  readonly trees: number;
  readonly leaves: number;
  readonly rows: number;
  readonly emptyStates: number;
  readonly scrollTop: number;
  readonly scrollable: boolean;
  readonly focusInToolbar: boolean;
  readonly focusTag: string;
  readonly focusMark: string;
  readonly searchText: string;
}

/**
 * 中栏读数：一次 evaluate 拿全，避免逐条 locator 各自轮询跨帧。
 *
 * ⚠ 页内探针一律写成字符串 IIFE：tsconfig 给页侧没有 node 类型，箭头函数串会被
 * 当成【函数值】原样返回（读到 undefined 而不是读数）。
 */
const LIST_STATE_PROBE = `(() => {
  const toolbar = document.querySelector("#listToolbar");
  const content = document.querySelector("#listContent");
  const search = document.querySelector("#listToolbar input[type=search]");
  const active = document.activeElement;
  return {
    searches: toolbar.querySelectorAll("input[type=search]").length,
    selects: toolbar.querySelectorAll("select").length,
    trees: content.querySelectorAll(".doc-tree").length,
    leaves: content.querySelectorAll(".doc-tree .doc-list-item").length,
    rows: content.querySelectorAll("#listContent > .doc-list-item").length,
    emptyStates: content.querySelectorAll(".state").length,
    scrollTop: content.scrollTop,
    scrollable: content.scrollHeight > content.clientHeight + 40,
    focusInToolbar: toolbar.contains(active) && active !== toolbar,
    focusTag: active ? active.tagName : "",
    focusMark: active ? String(active.dataset.filterProbe || "") : "",
    searchText: search ? String(search.value) : "",
  };
})()`;

async function listState(page: Page): Promise<ListState> {
  return (await page.evaluate(LIST_STATE_PROBE)) as unknown as ListState;
}

/**
 * 逐字符真敲（不是 fill）：这一发测的就是「多敲一下会发生什么」。
 *
 * ⚠ 一律 .first()：未修时筛选栏会长出一排同款控件，locator 撞上多个元素会先抛
 * strict mode violation —— 红是红了，但读数是「locator 有歧义」而不是「控件长了几个」。
 * 计数全部走 LIST_STATE_PROBE 的 querySelectorAll，所以这里 .first() 不会放松判据。
 */
async function typeIntoSearch(page: Page, text: string): Promise<void> {
  await page.locator("#listToolbar input[type=search]").first().focus();
  await page.keyboard.type(text, { delay: 60 });
}

/**
 * 给【当前这一枚】搜索框打一个数据标记，之后用它认「焦点还在不在同一枚节点上」。
 *
 * focusTag === "INPUT" 与 focusInToolbar 都认不出节点被换过：整栏重画后焦点落在一枚
 * 崭新的 input 上，标签一样、也还在工具条里，两根读数全绿；用户那一头却是「第二个
 * 字符发给了刚从 DOM 里摘掉的旧节点」——字凭空少一个。节点同一性才是这一格的尺子。
 */
function markSearchNode(): string {
  return `(() => {
    const el = document.querySelector("#listToolbar input[type=search]");
    el.setAttribute("data-filter-probe", "same");
    return 1;
  })()`;
}

/**
 * 真滚中栏列表（悬停 + 滚轮），别用 scrollTop = N。
 *
 * 滚轮走的是用户拖动那一条路：内容不够长时浏览器【不滚】，滚动是合成器线程上的异步事，
 * 所以要 poll 到 scrollTop 真的动起来才继续 —— 滚不动会带着这条消息红给我看。
 * scrollTop = N 反过来：写多少读回多少（哪怕内容根本不滚），判据看着绿其实什么都没量。
 *
 * ⚠ 要等的不是「动起来」而是【停下来】：只判 `> 0` 会在滚轮动画半途就把基线取走，而基线
 * 自己还在长。全量里实测抓到过 —— 基线读到 120，动画落定是 240，于是后面那根「敲完滚动
 * 不动」的线恒红（单跑快、动画在第一次 poll 前就落完，所以只在负载下现形）。判据改成
 * 「相邻两读数相同且 > 0」，并且返回那一次读数本身：中途取的值不能当基线。
 */
async function scrollListDown(page: Page): Promise<ListState> {
  await page.locator("#listContent").hover();
  await page.mouse.wheel(0, 120);
  let prev = -1;
  await expect
    .poll(
      async () => {
        const top = (await listState(page)).scrollTop;
        const stable = top > 0 && top === prev;
        prev = top;
        return stable;
      },
      {
        message:
          "中栏列表滚不动，或滚动一直停不下来：滚动那根判据拿不到稳定基线，不许继续",
      },
    )
    .toBe(true);
  return listState(page);
}

test("中栏筛选器：逐字符敲不累加控件、不重复列表，焦点/取值/滚动留在原处", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  await expect(page.locator("#listTitle")).toHaveText("消息");
  const created = await createGroupThroughUi(
    page,
    "筛选器验收群",
    "把中栏筛选器敲坏的那一发",
    false,
  );
  const groupId = created.group.group_id;
  // 文档与待办按【写入链路】灌进来：这一发测的是筛选器，不是创建器。
  //
  // 标题统一带「筛验」这个词：中栏列的是【全部群】的文档/待办，而这台 hub 的库是整份
  // e2e 共用的，别家用例早就往里灌过一堆名字。只有按一个独占词筛，条数才是我说了算的
  // （建群还会自动生成一篇「立项：…」章程文档，也一起被这个词筛掉）。
  // 30 篇 / 24 条是为了让 .list-content 真的能滚：滚动那两根线要有一个可滚的对象，
  // 否则 scrollTop 恒为 0，「跳回顶部」压根不会红。
  const seeded = (await page.evaluate(async (gid) => {
    const results: number[] = [];
    const post = async (path: string, body: unknown) => {
      const res = await fetch(`/api/v1/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      results.push(res.status);
    };
    await post("documents", {
      title: "筛验甲",
      kind: "markdown",
      group_id: gid,
      body_text: "甲正文",
    });
    await post("documents", {
      title: "筛验乙",
      kind: "markdown",
      group_id: gid,
      body_text: "乙正文",
    });
    await post("documents", {
      title: "筛验丙",
      kind: "doc",
      group_id: gid,
      body_text: "丙正文",
    });
    for (let i = 0; i < 27; i += 1)
      await post("documents", {
        title: `筛验档${i}`,
        kind: "markdown",
        group_id: gid,
        body_text: `长列表正文${i}`,
      });
    for (let i = 0; i < 24; i += 1)
      await post("backlog", { title: `筛验待办${i}`, group_id: gid });
    return results;
  }, groupId)) as number[];
  expect(seeded.every((status) => status === 201)).toBe(true);

  // 灌完数据必须【真 reload】一次：goto 一个只是 hash 不同的地址并不会重载文档，
  // 它只触发 hashchange，state.documents 仍是建群那次读回来的旧读数（只有那篇章程），
  // 于是筛选永远命中 0 篇 —— 判据会红，但红的是我的准备没做对，不是产品。
  // reload 让 boot() 带着 #/documents 重跑一遍，读回来的才是用户打开这一栏看到的那一屏。
  await page.goto(`${webOrigin}/#/documents`);
  await page.reload();
  const trees = page.locator("#listContent .doc-tree");
  await expect(trees).toHaveCount(1);
  const search = page.locator("#listToolbar input[type=search]");
  await expect(search).toHaveCount(1);
  const kindSelect = page.locator('#listToolbar select[aria-label="文档类型"]');
  const groupSelect = page.locator('#listToolbar select[aria-label="所属群"]');

  // 线 1（文档：控件不翻倍）：逐字符敲「筛验」。旧形状下每一下把整份筛选栏
  // 再 append 一遍（搜索框 1→2→3、下拉 2→4→6），所以这一发就是缺陷本体。
  await page.evaluate(markSearchNode());
  await typeIntoSearch(page, "筛验");
  let state = await listState(page);
  expect(state.searches).toBe(1);
  expect(state.selects).toBe(2);
  // 线 3（文档：打字打到一半不许丢焦点/丢字）：焦点还在【打标记那一枚】搜索框里，
  // 框里的值就是敲进去的那两个字。
  //
  // ⚠ 这一组必须排在叶子计数【之前】：整栏重画那一发（把 handler 改回 renderList）
  // 控件份数全对，只有这里会红 —— 而它同时会让第二个字符丢失，读数成「筛」命中 31 篇
  // （多出来那篇是建群自动生成的「立项：筛选器验收群」章程）。谁排前面，M8 就红在谁身上，
  // 焦点这一格就不再有自己那次动作；排在这里，31 那一发红的是线 2，各归各。
  expect(state.focusInToolbar).toBe(true);
  expect(state.focusTag).toBe("INPUT");
  expect(state.focusMark).toBe("same");
  expect(state.searchText).toBe("筛验");
  // 线 2（文档：列表不重复）：命中 30 篇就是 30 篇叶子，不会每敲一下再挂一份树。
  expect(state.trees).toBe(1);
  expect(state.leaves).toBe(30);

  // 线 4（文档：空态只有一份）：接着敲成不匹配的关键词 ⇒ 一份空态，不是每敲一下叠一份。
  await typeIntoSearch(page, "zzz");
  state = await listState(page);
  expect(state.emptyStates).toBe(1);
  await expect(page.locator("#listContent")).toContainText("没有匹配的文档");
  expect(state.leaves).toBe(0);
  expect(state.searches).toBe(1);

  // 线 5（文档：改回能命中的关键词）：换回「筛验」⇒ 30 篇回来，仍然只有一棵树。
  await search.first().fill("筛验");
  state = await listState(page);
  expect(state.leaves).toBe(30);
  expect(state.trees).toBe(1);
  expect(state.emptyStates).toBe(0);

  // 线 6（文档：形态下拉自己那一次动作）：换形态 ⇒ 只剩富文本那一篇的补集，
  // 下拉数量不涨（这一发的落点是 select 的 onchange，与搜索框那两条各自独立）。
  await kindSelect.first().selectOption("doc");
  state = await listState(page);
  expect(state.leaves).toBe(1);
  expect(state.selects).toBe(2);
  await expect(
    page.locator("#listContent .doc-list-item").filter({ hasText: "筛验丙" }),
  ).toHaveCount(1);
  await kindSelect.first().selectOption("");
  await expect(
    page.locator("#listContent .doc-tree .doc-list-item"),
  ).toHaveCount(30);

  // 线 7（文档：换筛选条件时列表滚动位置留在原处）：这条是【防我改坏】的那根，不是缺陷复现 ——
  // 未修时内容只增不清、容器不换，scrollTop 自然不掉；改成整栏重画后一旦把 #listContent
  // 里的孩子全清掉，浏览器会把 scrollTop 夹回 0，换一个下拉就跳回顶部。
  // 这里用「所属群」而不是搜索框：这一发筛掉 0 条，列表长度不变，
  // 「scrollTop 该留在原处」才有唯一答案（内容变短时浏览器自己就会夹上去）。
  const scrolled = await scrollListDown(page);
  expect(scrolled.scrollable).toBe(true);
  await groupSelect.first().selectOption(groupId);
  state = await listState(page);
  expect(state.leaves).toBe(30);
  expect(state.selects).toBe(2);
  expect(state.scrollTop).toBe(scrolled.scrollTop);
  await groupSelect.first().selectOption("");

  // 线 8（切栏一趟回来筛选栏仍是一份）：钉住 renderList 里那句 toolbar.replaceChildren。
  await page.locator('[data-nav="messages"]').click();
  await page.locator('[data-nav="documents"]').click();
  state = await listState(page);
  expect(state.searches).toBe(1);
  expect(state.selects).toBe(2);
  expect(state.trees).toBe(1);

  // 线 9（待办：同形缺陷的第二个落点）：待办只有一枚搜索框，逐字符敲之后仍然只有一枚，
  // 24 条一行不重复；这一发把 renderBacklogList 那处自递归单独钉住。
  await page.locator('[data-nav="backlog"]').click();
  const backlogSearch = page.locator("#listToolbar input[type=search]");
  await expect(backlogSearch).toHaveCount(1);
  await typeIntoSearch(page, "筛验");
  state = await listState(page);
  expect(state.searches).toBe(1);
  expect(state.rows).toBe(24);
  expect(state.emptyStates).toBe(0);
  expect(state.focusInToolbar).toBe(true);
  expect(state.searchText).toBe("筛验");

  // 线 10（待办：滚动位置留在原处）：接着往下敲「待办」——24 条标题都含这两个字，
  // 行数不变，所以滚动位置该留在原处；焦点也必须在原框里才敲得进去（继续敲本身就靠它）。
  const backlogScrolled = await scrollListDown(page);
  expect(backlogScrolled.scrollable).toBe(true);
  await typeIntoSearch(page, "待办");
  state = await listState(page);
  expect(state.rows).toBe(24);
  expect(state.scrollTop).toBe(backlogScrolled.scrollTop);
  expect(state.searches).toBe(1);
  expect(state.searchText).toBe("筛验待办");

  // 线 11（待办：收窄到一条 / 收到不匹配只留一份空态）。
  await backlogSearch.first().fill("筛验待办3");
  state = await listState(page);
  expect(state.rows).toBe(1);
  expect(state.searches).toBe(1);
  await backlogSearch.first().fill("筛验不存在的关键字");
  state = await listState(page);
  expect(state.emptyStates).toBe(1);
  expect(state.rows).toBe(0);
  await expect(page.locator("#listContent")).toContainText("没有匹配的待办");

  expectNoBrowserErrors(browserErrors);
});

test("待办按群筛：下拉筛的是这个群的待办，且不与搜索框互相打架", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  // 两个群各灌一批待办：按群筛这一发的判据是「乙群那几条从甲群的屏上消失」，
  // 单群数据永远证不了这件事（全部/本群两种读数的行数一样）。
  await page.goto(`${webOrigin}/`);
  const alpha = await createGroupThroughUi(
    page,
    "筛群甲群",
    "待办按群筛的验收群 A",
    false,
  );
  const beta = await createGroupThroughUi(
    page,
    "筛群乙群",
    "待办按群筛的验收群 B",
    false,
  );
  const seeded = (await page.evaluate(
    async ({ aid, bid }: { aid: string; bid: string }) => {
      const statuses: number[] = [];
      const post = async (title: string, gid: string) => {
        const res = await fetch("/api/v1/backlog", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title, group_id: gid }),
        });
        statuses.push(res.status);
      };
      for (let i = 0; i < 16; i += 1) await post(`筛群待办${i}`, aid);
      for (let i = 0; i < 4; i += 1) await post(`筛群乙办${i}`, bid);
      return statuses;
    },
    { aid: alpha.group.group_id, bid: beta.group.group_id },
  )) as number[];
  expect(seeded.every((status) => status === 201)).toBe(true);
  // 真 reload：同 0079 —— goto 只触发 hashchange，不重读 backlog 的话筛的是旧读数。
  await page.goto(`${webOrigin}/#/backlog`);
  await page.reload();
  const rows = page.locator("#listContent > .doc-list-item");
  await expect(rows.filter({ hasText: "筛群待办15" })).toHaveCount(1);
  const todoGroupSelect = page.locator(
    '#listToolbar select[aria-label="所属群"]',
  );
  const todoSearch = page.locator("#listToolbar input[type=search]");

  // 线 0（控件存在且只有一份）：待办工具条有且只有一枚「所属群」下拉。
  // 未修时这一发就红：待办栏只有搜索框，下拉数为 0 —— 「按群筛」压根不存在。
  await expect(todoGroupSelect).toHaveCount(1);
  await expect(todoSearch).toHaveCount(1);
  let state = await listState(page);
  expect(state.selects).toBe(1);

  // 线 1（关键词与群 AND）：先关键词收到 7 条（待办1 / 10…15），再选甲群 ⇒ 还是这 7 条；
  // 选乙群 ⇒ 0 条 + 一份空态。两维必须同时生效，谁也不许覆盖谁。
  await page.evaluate(markSearchNode());
  await todoSearch.first().fill("筛群待办1");
  await expect(rows.filter({ hasText: "筛群待办1" })).toHaveCount(7);
  await todoGroupSelect.first().selectOption(alpha.group.group_id);
  state = await listState(page);
  expect(state.rows).toBe(7);
  expect(state.emptyStates).toBe(0);
  await todoGroupSelect.first().selectOption(beta.group.group_id);
  state = await listState(page);
  expect(state.rows).toBe(0);
  expect(state.emptyStates).toBe(1);
  await expect(page.locator("#listContent")).toContainText("没有匹配的待办");
  // 线 2（节点同一性 + 取值）：换群不该换掉正在用的搜索框（同 0079 的尺子：
  // focusTag/focusInToolbar 认不出「换了一枚崭新同款 input」，只有标记能认）。
  // ⚠ 这一注释必须在乙群那几发断言【之后】：选乙群是线 1 的动作，它的 0 行断言
  // 划进线 2 会把「群谓词被删」误报成焦点线红（round396 N1 第一版就错归到这里）。
  state = await listState(page);
  expect(state.focusMark).toBe("same");
  expect(state.searchText).toBe("筛群待办1");
  // 线 3（清关键词 ⇒ 群维度单独生效）：乙群此刻该是它那 4 条，甲群 0 条。
  await todoSearch.first().fill("");
  await expect(rows.filter({ hasText: "筛群乙办" })).toHaveCount(4);
  await expect(rows.filter({ hasText: "筛群待办" })).toHaveCount(0);
  // 线 4（换回全部）：两群都在，16 + 4。
  await todoGroupSelect.first().selectOption("");
  await expect(rows.filter({ hasText: "筛群待办" })).toHaveCount(16);
  await expect(rows.filter({ hasText: "筛群乙办" })).toHaveCount(4);
  // 线 5（只筛群不筛字）：选甲群 ⇒ 16 条，乙群消失。
  await todoGroupSelect.first().selectOption(alpha.group.group_id);
  await expect(rows.filter({ hasText: "筛群待办" })).toHaveCount(16);
  await expect(rows.filter({ hasText: "筛群乙办" })).toHaveCount(0);
  // 线 6（控件不累加）：上面换了 4 次群、动了 2 次搜索框，控件仍各一枚、行区不重复
  // （0079 病根的回归位：下拉若把 renderBacklogList 叫回来，这里 selects 会涨）。
  state = await listState(page);
  expect(state.selects).toBe(1);
  expect(state.searches).toBe(1);
  expect(state.rows).toBe(16);
  expect(state.trees).toBe(0);
  // 线 7（切栏回来仍是一份）：钉 toolbar.replaceChildren 对这一栏同样生效。
  await page.locator('[data-nav="messages"]').click();
  await page.locator('[data-nav="backlog"]').click();
  state = await listState(page);
  expect(state.selects).toBe(1);
  expect(state.searches).toBe(1);

  expectNoBrowserErrors(browserErrors);
});

// 0081 红探针 —— 成员入职之后，他挂的技能与执行器链在界面里就冻结了。
// 招聘弹窗里每行都带 iconButton("close","删除技能") 与「添加技能」，而成员设置面板
// （skillsEditor / executorsEditor）只有固定行集 + 一枚「保存…列表」：既不能加一行，
// 也不能摘一行。服务端两条 DELETE 路由（people.ts 的 skills/:skillId、executors/:seq）
// 连同 404 口径都实现齐了，渲染侧调用方是 0 —— test/arch/ui-caller-roster.ts 把这两格
// 登在【覆盖】名下，理由是「摘技能这件事在界面里已经能做」。对已入职的成员，那句是假的。
// 本用例自己招一个人（同 0080 灌待办那样走真 HTTP），免得把种子写进别人也在断言的成员档案；
// 它在按钮缺位处必红，落地后逐发变绿，每根线各自对应一次真动作。
const CHURN_MEMBER_NAME = "增删验收成员";

test("成员设置面板增删技能与执行器：路由早就有，界面到得了吗", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/`);
  // 一次招聘就把两维的种子灌满：skills 空数组 / 只剩一格执行器的档案量不出
  // 「有东西可摘」与「还能再加」这两维。
  const hired = await page.evaluate(async (name) => {
    const res = await fetch("/api/v1/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        role_id: "product_director",
        model_tier: "execution",
        persona: {
          style: "先给结论",
          values: ["可验证"],
          honesty: "不确定就说明",
        },
        skills: [
          { skill_id: "seed-skill-a", name: "播种技能甲" },
          { skill_id: "seed-skill-b", name: "播种技能乙" },
        ],
        executors: [
          {
            seq: 1,
            kind: "pure-model",
            config: { kind: "pure-model" },
            enabled: true,
          },
          {
            seq: 2,
            kind: "pure-model",
            config: { kind: "pure-model" },
            enabled: true,
          },
        ],
        tone: "direct",
        seat_group_ids: [],
      }),
    });
    const body = (await res.json()) as {
      member?: { member_id: string };
      error?: string;
    };
    return { status: res.status, memberId: body.member?.member_id ?? "" };
  }, CHURN_MEMBER_NAME);
  expect(hired.status).toBe(201);
  expect(hired.memberId).not.toBe("");
  // 真 reload（同 0080 那条）：state.members 是页面起来时读的那一份，
  // 上面那发 fetch 招的人不在里面，不重载量到的永远是旧档案。
  await page.reload();

  await page.locator('.nav-item[data-nav="settings"]').click();
  const memberRow = page
    .locator("#listContent [data-member-row]")
    .filter({ has: page.locator("strong", { hasText: CHURN_MEMBER_NAME }) });
  await expect(memberRow).toHaveCount(1);
  await memberRow.click();
  // 行区每次 renderMain 都重建，locator 是现解析的：下面 reload / 保存之后不必换名字。
  const skillsCard = page
    .locator("#view section.card")
    .filter({ hasText: "技能配置" });
  const executorsCard = page
    .locator("#view section.card")
    .filter({ hasText: "执行器配置" });
  await expect(skillsCard.locator(".skill-row")).toHaveCount(2);
  await expect(executorsCard.locator(".executor-row")).toHaveCount(2);

  // 线 0（技能这一栏有「添加技能」）：未修时这一发红 —— 卡片里 0 枚。
  await expect(
    skillsCard.getByRole("button", { name: "添加技能", exact: true }),
  ).toHaveCount(1);
  // 线 1（摘一行真的少一行）：每行一枚「删除这一件技能」，点它 ⇒ 发
  // DELETE /members/{id}/skills/seed-skill-a，行与落库都只剩乙。
  const skillDelete = skillsCard.getByRole("button", {
    name: "删除这一件技能",
    exact: true,
  });
  await expect(skillDelete).toHaveCount(2);
  const removedSkill = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/api/v1/members/${hired.memberId}/skills/seed-skill-a`,
  );
  await skillDelete.first().click();
  expect((await removedSkill).ok()).toBe(true);
  await expect(skillsCard.locator(".skill-row")).toHaveCount(1);
  await expect(skillsCard.locator('[name="skill_id"]').nth(0)).toHaveValue(
    "seed-skill-b",
  );
  await expect(page.locator("#toastRegion")).toContainText("技能已删除");
  // 线 2（加一行真的多一行，且此刻【不发】请求）：新行还没填，提交时机仍归
  // 「保存技能列表」那一次 —— 加行若顺手落库，这里读到的就有那一条。
  expect(await readMemberSkills(page, hired.memberId)).toEqual([
    "seed-skill-b",
  ]);
  await skillsCard
    .getByRole("button", { name: "添加技能", exact: true })
    .click();
  await expect(skillsCard.locator(".skill-row")).toHaveCount(2);
  expect(await readMemberSkills(page, hired.memberId)).toEqual([
    "seed-skill-b",
  ]);
  // 线 2b（页面里那一行的删除钮）：新加那一行自己也有一枚「删除这一件技能」，点它只撤掉
  // 这一行 —— 它还没落库，既不该少库里那条，也不该发 DELETE（发了就 404 skill_not_found）。
  // 「不该发」这一半由下面那组计数自己钉：整条用例末尾那道全局 console 清扫确实会抓到
  // 404，但那是【全用例共用】的兜底，不是这根线自己的动作 —— 兜底红在末尾，归因就落到
  // 别处去了（实测：撤掉这组计数后 M3 红在末尾清扫而不是这里）。
  // 计数按【任意 DELETE】匹配，不按「打到这个成员的那条」做前缀：把 onClick 改成
  // removeSkill("", "ghost") 那一发变异，路径是 /members//skills/ghost（成员号是空串）。
  const pageRowDeletes: string[] = [];
  const countPageRowDelete = (req: {
    method: () => string;
    url: () => string;
  }) => {
    if (req.method() === "DELETE") pageRowDeletes.push(req.url());
  };
  page.on("request", countPageRowDelete);
  await skillsCard
    .getByRole("button", { name: "删除这一件技能", exact: true })
    .nth(1)
    .click();
  page.off("request", countPageRowDelete);
  await expect(skillsCard.locator(".skill-row")).toHaveCount(1);
  expect(pageRowDeletes, "页面里那一行不该打服务端").toEqual([]);
  expect(await readMemberSkills(page, hired.memberId)).toEqual([
    "seed-skill-b",
  ]);
  await skillsCard
    .getByRole("button", { name: "添加技能", exact: true })
    .click();
  await skillsCard.locator('[name="skill_id"]').nth(1).fill("ui-added-skill");
  await skillsCard.locator('[name="skill_name"]').nth(1).fill("界面新增技能");
  await skillsCard.locator('[name="skill_note"]').nth(1).fill("界面填的备注");
  const savedSkills = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/members/${hired.memberId}/skills`,
  );
  await skillsCard
    .getByRole("button", { name: "保存技能列表", exact: true })
    .click();
  expect((await savedSkills).ok()).toBe(true);
  await expect(page.locator("#toastRegion")).toContainText("技能已保存");
  // 读的是服务端那两行（列表接口 ORDER BY skill_id），不是本页内存态。
  expect(await readMemberSkills(page, hired.memberId)).toEqual([
    "seed-skill-b",
    "ui-added-skill",
  ]);
  // 线 2c（新行的三格各自落库）：name 与 note 由这一行自己带 —— updateSkills 里
  // note 走的是「空串就不写这个键」，删掉那一格时这里读到的是 undefined。
  const storedSkills = await readMemberSkillRows(page, hired.memberId);
  const storedAdded = storedSkills.find((s) => s.skill_id === "ui-added-skill");
  expect(storedAdded?.name).toBe("界面新增技能");
  expect(storedAdded?.note).toBe("界面填的备注");
  expect(storedSkills.find((s) => s.skill_id === "seed-skill-b")?.name).toBe(
    "播种技能乙",
  );
  // 线 3（加完不保存就刷新 ⇒ 那一行不该偷偷落库）。
  await skillsCard
    .getByRole("button", { name: "添加技能", exact: true })
    .click();
  await page.reload();
  await page.locator('.nav-item[data-nav="settings"]').click();
  await memberRow.click();
  await expect(skillsCard.locator(".skill-row")).toHaveCount(2);
  expect(await readMemberSkills(page, hired.memberId)).toEqual([
    "seed-skill-b",
    "ui-added-skill",
  ]);
  // 线 4（执行器加行）：有「添加执行器」，新行带 kind 下拉与配套的 config 骨架，
  // 而且它同样不顺手落库。
  const addExecutor = executorsCard.getByRole("button", {
    name: "添加执行器",
    exact: true,
  });
  await expect(addExecutor).toHaveCount(1);
  await expect(
    executorsCard.getByRole("button", {
      name: "删除这一档执行器",
      exact: true,
    }),
  ).toHaveCount(2);
  await addExecutor.click();
  await expect(executorsCard.locator(".executor-row")).toHaveCount(3);
  await expect(executorsCard.locator('[name="executor_kind"]')).toHaveCount(3);
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(0),
  ).toHaveValue("1");
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(1),
  ).toHaveValue("2");
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(2),
  ).toHaveValue("3");
  expect(await readMemberExecutorSeqs(page, hired.memberId)).toEqual([1, 2]);
  // 线 4b（换 kind 连带重写那份 config）：判别联合要求 config.kind 与外层 kind 同值
  // （contracts/src/member.ts 的 superRefine），所以「换个类型但 config 还是旧骨架」提交必 422。
  // 这一发量的是新加那一行自己的下拉：切到 builtin-plugin ⇒ 骨架里出现 plugin_id/tool_name，
  // 切回 pure-model ⇒ 那两格又消失（骨架由 kind 生成，不是往上叠字段）。
  const newKind = executorsCard.locator('[name="executor_kind"]').nth(2);
  const newConfig = executorsCard.locator('[name="executor_config"]').nth(2);
  await expect(newConfig).toHaveValue(/"kind":\s*"pure-model"/u);
  await newKind.selectOption("builtin-plugin");
  await expect(newConfig).toHaveValue(/"kind":\s*"builtin-plugin"/u);
  await expect(newConfig).toHaveValue(/plugin_id/u);
  await expect(newConfig).toHaveValue(/tool_name/u);
  await expect(newConfig).toHaveAttribute("placeholder", /plugin_id/u);
  await newKind.selectOption("pure-model");
  await expect(newConfig).toHaveValue(
    JSON.stringify({ kind: "pure-model" }, null, 2),
  );
  await expect(newConfig).toHaveAttribute("placeholder", /pure-model/u);
  // 线 4c（执行器页面里那一行的删除钮，且撤的不是最后一行）：再加第二行 ⇒ 1/2/3/4，
  // 撤掉 nth(2)（页面里那一行的 seq=3）⇒ 1/2/4。留缝合法（服务端只禁重复），界面不替用户重排。
  await addExecutor.click();
  await expect(executorsCard.locator(".executor-row")).toHaveCount(4);
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(3),
  ).toHaveValue("4");
  await executorsCard
    .getByRole("button", { name: "删除这一档执行器", exact: true })
    .nth(2)
    .click();
  await expect(executorsCard.locator(".executor-row")).toHaveCount(3);
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(2),
  ).toHaveValue("4");
  expect(await readMemberExecutorSeqs(page, hired.memberId)).toEqual([1, 2]);
  // 线 4d（再一行的序号从行里【现算】，不是数行数）：现有 1/2/4 ⇒ 下一档是 5。
  // 写成 rows.length + 1 会得 4 —— 与已有那档撞号，提交必 422（seq 重复）。
  await addExecutor.click();
  await expect(executorsCard.locator(".executor-row")).toHaveCount(4);
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(3),
  ).toHaveValue("5");
  // 线 4e（新行换成 CLI 那一档 + 取消勾选「启用」）：kind 与 config 由这一行自己带，
  // enabled 那一格也有自己的动作 —— 界面不读它的话这里落库会是 true。
  const cliKind = executorsCard.locator('[name="executor_kind"]').nth(3);
  await cliKind.selectOption("claude-cli");
  await expect(
    executorsCard.locator('[name="executor_config"]').nth(3),
  ).toHaveValue(JSON.stringify({ kind: "claude-cli" }, null, 2));
  await executorsCard.locator('[name="executor_enabled"]').nth(3).uncheck();
  // 线 5（加的那一行保存后落在库里）：那一档的 kind 与 config 由新行自己带。
  const savedExecutors = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/v1/members/${hired.memberId}/executors`,
  );
  await executorsCard
    .getByRole("button", { name: "保存执行器列表", exact: true })
    .click();
  expect((await savedExecutors).ok()).toBe(true);
  await expect(page.locator("#toastRegion")).toContainText("执行器已保存");
  expect(await readMemberExecutorSeqs(page, hired.memberId)).toEqual([
    1, 2, 4, 5,
  ]);
  const storedExecutors = await readMemberExecutors(page, hired.memberId);
  expect(storedExecutors.map((e) => e.kind)).toEqual([
    "pure-model",
    "pure-model",
    "pure-model",
    "claude-cli",
  ]);
  expect(storedExecutors.map((e) => e.enabled)).toEqual([
    true,
    true,
    true,
    false,
  ]);
  // 线 6（删中间那一档）：DELETE 掉 seq=2 ⇒ 库里只剩 1 / 4 / 5（留缝合法）。
  // ⚠ 序号【不】由界面重排：seq 是手填的优先级，服务端只禁重复、允许留缝，
  // 界面替用户重排等于把手填那一格拿掉（那是另一件事，本轮不做）。
  const removedExecutor = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname ===
        `/api/v1/members/${hired.memberId}/executors/2`,
  );
  await executorsCard
    .getByRole("button", { name: "删除这一档执行器", exact: true })
    .nth(1)
    .click();
  expect((await removedExecutor).ok()).toBe(true);
  await expect(page.locator("#toastRegion")).toContainText("执行器已删除");
  expect(await readMemberExecutorSeqs(page, hired.memberId)).toEqual([1, 4, 5]);
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(0),
  ).toHaveValue("1");
  await expect(
    executorsCard.locator('[name="executor_seq"]').nth(1),
  ).toHaveValue("4");
  // 线 7（只剩一档时删不掉）：把 4 与 5 依次摘掉 ⇒ 只剩 1 档，此时按钮数为 0 ——
  // 服务端 empty_executor_chain 那条口径在界面上有对应形状，不必等它报错。
  // 两次删除各等自己的那条 DELETE 响应（一次动作一条线，别拿上一次的响应冒充）。
  for (const seq of [4, 5]) {
    const gone = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        new URL(response.url()).pathname ===
          `/api/v1/members/${hired.memberId}/executors/${seq}`,
    );
    await executorsCard
      .getByRole("button", { name: "删除这一档执行器", exact: true })
      .nth(1)
      .click();
    expect((await gone).ok()).toBe(true);
  }
  await expect(executorsCard.locator(".executor-row")).toHaveCount(1);
  expect(await readMemberExecutorSeqs(page, hired.memberId)).toEqual([1]);
  await expect(
    executorsCard.getByRole("button", {
      name: "删除这一档执行器",
      exact: true,
    }),
  ).toHaveCount(0);
  // 线 8（技能全摘光 ⇒ 空态文案 + 零行，但「保存」仍在）：契约允许空技能列表，
  // 界面不该在空档上崩掉。
  await expect(
    skillsCard.getByRole("button", { name: "删除这一件技能", exact: true }),
  ).toHaveCount(2);
  await skillsCard
    .getByRole("button", { name: "删除这一件技能", exact: true })
    .first()
    .click();
  await skillsCard
    .getByRole("button", { name: "删除这一件技能", exact: true })
    .first()
    .click();
  await expect(skillsCard.locator(".skill-row")).toHaveCount(0);
  expect(await readMemberSkills(page, hired.memberId)).toEqual([]);
  await expect(
    skillsCard.getByRole("button", { name: "保存技能列表", exact: true }),
  ).toHaveCount(1);
  // 线 9（控件不累加）：上面加过五行、摘过五行、还 reload 过一次，
  // 两栏各自的那枚按钮仍只有一套（0079 病根的回归位）。
  await expect(
    skillsCard.getByRole("button", { name: "添加技能", exact: true }),
  ).toHaveCount(1);
  await expect(
    executorsCard.getByRole("button", { name: "添加执行器", exact: true }),
  ).toHaveCount(1);
  await expect(
    executorsCard.getByRole("button", {
      name: "保存执行器列表",
      exact: true,
    }),
  ).toHaveCount(1);

  expectNoBrowserErrors(browserErrors);
});

// 0082 红探针 —— 调研面板把自己钉死在服务端时钟的「今天」上。
// 契约 GET /api/v1/research/today 的查询里有 day（packages/contracts/src/rhythm.ts 的
// listResearchQuerySchema，`.strict()`，唯一参数就是它），SQL 是 `WHERE day = ?`，缺省才落回
// localDay(now)。也就是说「看某一天的调研」服务端一发合法请求就能答，渲染侧却是写死的
// `path = "/research/today"`（group.js loadTeamPanel 的 research 分支）—— 一个查询参数都不发，
// 整个 group.js 里连一枚 type=date 的输入都没有。后果不是「少个筛选器」：调研卡按 (day, url)
// 唯一、每天一批，过了零点昨天那批就在界面上没有任何入口能再看到（列表、搜索、文档面都不读
// research_cards）。本用例昨天与今天各灌一张卡 —— 单灌今天，「只看今天」与「看全部」的读数
// 逐像素相同，永远证不了这件事（同 0080 要灌两个群才证得了「按群筛」）。
// 范围：只补「读」（GET 带 day）。POST 的 day 当时刻意没接 —— 「把一条调研归到过去某一天」
// 是产品口径，且那条路径的既有文案（「今日调研已存在」）也跟着今日语义写死；已记进 0082
// 「记下来但没动的」，由 0083 接上（用例见下一条）。

/** 服务端 localDay 同式的本地日界文本（负数 = 往前翻）。 */
function localDayText(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

test("每日调研按日翻：面板钉在今天，昨天的卡在界面上永远看不到", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  const today = localDayText(0);
  const yesterday = localDayText(-1);
  const dayBefore = localDayText(-2);
  const todayTitle = "按日调研今天这张";
  const yesterdayTitle = "按日调研昨天这张";

  await page.goto(`${webOrigin}/`);
  // 两张卡各自归到某一天：day 是契约参数，直接走真 HTTP 灌，不经界面（界面还没有那一格）。
  const seeded = (await page.evaluate(
    async (args: {
      dayA: string;
      dayB: string;
      titleA: string;
      titleB: string;
    }) => {
      const statuses: number[] = [];
      const post = async (day: string, title: string) => {
        const res = await fetch("/api/v1/research/today", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            day,
            source: "manual",
            title,
            summary: `${title}的摘要`,
          }),
        });
        statuses.push(res.status);
      };
      await post(args.dayA, args.titleA);
      await post(args.dayB, args.titleB);
      return statuses;
    },
    {
      dayA: today,
      dayB: yesterday,
      titleA: todayTitle,
      titleB: yesterdayTitle,
    },
  )) as number[];
  expect(seeded.every((status) => status >= 200 && status < 300)).toBe(true);

  await page.locator('[data-nav="backlog"]').click();
  await page.getByRole("tab", { name: "每日调研", exact: true }).click();
  const panel = page.locator("#taskPanel");
  await expect(
    panel.getByRole("heading", { level: 3, name: "每日调研", exact: true }),
  ).toBeVisible();
  const cards = panel.locator(".entry-card.research-card");

  // 线 0（那一格存在且只有一份）：面板工具条有一枚「调研日期」，取值是空 = 今天由服务端定。
  // 未修时这一发就红：整个 group.js 没有一枚 type=date 的输入，计数是 0。
  const dayBox = panel.locator('input[type="date"][aria-label="调研日期"]');
  await expect(dayBox).toHaveCount(1);
  await expect(dayBox).toHaveValue("");
  // 线 0b（默认那天由谁定）：没填日期时，屏上那句汇总写的是【今天】这个具体日子。
  // 这一发是 localDayValue 唯一的目击者：下面几条走的都是 state.researchDay（用户填的那一天），
  // 剪掉 localDayValue 的其它变异全都还能靠用户填的值蒙过去 —— 默认这一档必须自己站住。
  await expect(panel.locator("section.team-panel > p.muted")).toContainText(
    `汇总 ${today} 的调研卡`,
  );

  // 线 1（默认只看今天）：今天那张在，昨天那张不在。
  // ⚠ 这一发未修时【也是绿的】—— 它是分母：没有它，「把两天混在一起显示」那种改法也能让
  // 线 2 变绿。它钉的是「默认那不发 day 的一发仍然是按今天筛」，不是「切日期」这个动作。
  await expect(cards.filter({ hasText: todayTitle })).toHaveCount(1);
  await expect(cards.filter({ hasText: yesterdayTitle })).toHaveCount(0);

  // 线 2（切到昨天 ⇒ 换的是服务端返回的那一批，不是客户端把今天的藏起来）：
  // 填昨天 ⇒ 昨天那张出现、今天那张消失；同一次点击还要【真的】发一条带 day=昨天 的 GET。
  const dayRequest = page
    .waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/v1/research/today" && url.searchParams.has("day")
      );
    })
    .catch(() => null);
  await dayBox.fill(yesterday);
  const asked = await dayRequest;
  expect(asked, "切日期该发一条带 day 的 GET，而不是在本地过滤").not.toBeNull();
  expect(
    new URL((asked as { url(): string }).url()).searchParams.get("day"),
  ).toBe(yesterday);
  await expect(cards.filter({ hasText: yesterdayTitle })).toHaveCount(1);
  await expect(cards.filter({ hasText: todayTitle })).toHaveCount(0);

  // 线 3（清空 ⇒ 回到今天）：清掉日期后今天那张回来、昨天那张走。
  await dayBox.fill("");
  await expect(cards.filter({ hasText: todayTitle })).toHaveCount(1);
  await expect(cards.filter({ hasText: yesterdayTitle })).toHaveCount(0);

  // 线 4（空态文案跟着那一天走）：前天没灌卡 ⇒ 空态说的是【那一天】，不再说「今天还没有」。
  await dayBox.fill(dayBefore);
  await expect(cards).toHaveCount(0);
  await expect(panel.locator(".state")).toContainText(dayBefore);
  await expect(panel.locator(".state")).not.toContainText("今天还没有调研");

  // 线 5（读数与框一致）：整栏重画后框里仍是所填那一天 —— 漏传 value 的话列表是前天、
  // 框是空，用户下一次刷新就不知道自己看的是哪天。
  await expect(dayBox).toHaveValue(dayBefore);
  // 线 5b（重画不累加控件）：切了三次日期、整栏重画三次，工具条仍然只有一枚日期框。
  // 0079 那一族缺口正是「每次重画往 toolbar 里再塞一套」，这一发判的是同一件事。
  await expect(dayBox).toHaveCount(1);

  expectNoBrowserErrors(browserErrors);
});

test("登记调研归到哪天：表单不带 day，昨天翻到的卡只能记到今天", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  const today = localDayText(0);
  const yesterday = localDayText(-1);
  const url = `https://example.com/research-day-${Date.now()}`;

  await page.goto(`${webOrigin}/`);
  await page.locator('[data-nav="backlog"]').click();
  await page.getByRole("tab", { name: "每日调研", exact: true }).click();
  const panel = page.locator("#taskPanel");
  const dayBox = panel.locator('input[type="date"][aria-label="调研日期"]');
  await expect(dayBox).toHaveCount(1);
  // 翻到昨天（0082 已接通的那根线，这里只当入口用）。判据取【汇总句说的是昨天】而不是
  // 「屏上是空态」：同一份 e2e 库是共享的，上面 0082 那条用例刚往昨天灌过一张卡，
  // 空态在整串跑里【必然不成立】—— 单跑这条绿、整串跑红就是撞在这一格上。
  await dayBox.fill(yesterday);
  await expect(panel.locator("section.team-panel > p.muted")).toContainText(
    `汇总 ${yesterday} 的调研卡`,
  );

  // 登记弹窗里的那一枚日期：打开时应跟随屏上正在看的这一天。
  // 未修时线 1 就红在这里 —— 弹窗压根没有 type=date 的输入，计数是 0。
  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增调研", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "新增每日调研" });
  // 线 1（弹窗默认跟随所看的那一天）：看的是昨天，弹窗就该填着昨天。
  // 未修时线 1 就红在这里 —— 弹窗压根没有 type=date 的输入，计数是 0。
  const modalDay = dialog.locator('input[type="date"][aria-label="调研日期"]');
  await expect(modalDay).toHaveCount(1);
  await expect(modalDay).toHaveValue(yesterday);

  // 线 2（填了那一天 ⇒ 真的把 day 发到线上）：判的是【发出去的请求体】，不是卡片 DOM。
  // DOM 上「昨天出现一张卡」也能靠「服务端今天建卡 + 面板不刷新」蒙过去，请求体蒙不了。
  const sent = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/v1/research/today" &&
      req.method() === "POST",
  );
  await dialog.locator('input[name="title"]').fill("归到昨天的调研");
  await dialog.locator('textarea[name="summary"]').fill("这条要归到昨天。");
  await dialog.locator('input[name="url"]').fill(url);
  await dialog.getByRole("button", { name: "登记调研", exact: true }).click();
  await expect(dialog).toBeHidden();
  const body = JSON.parse((await sent).postData() ?? "{}") as Record<
    string,
    unknown
  >;
  expect(
    body.day,
    "表单里填的日期必须上请求体，否则卡永远落在服务端时钟那一天",
  ).toBe(yesterday);

  // 线 3（落点确实是昨天）：仍停在昨天这一屏，刚登记的卡要出现。
  const cards = panel.locator(".entry-card.research-card");
  await expect(cards.filter({ hasText: "归到昨天的调研" })).toHaveCount(1);

  // 线 4（查重文案跟着那一天）：同 (day, url) 再登记一次 ⇒ 服务端 created:false，
  // 文案不能再硬写「今日调研已存在」—— 用户刚说的明明是昨天。
  const dupSent = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/v1/research/today" &&
      req.method() === "POST",
  );
  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增调研", exact: true })
    .click();
  await dialog.locator('input[name="title"]').fill("归到昨天的调研（重复）");
  await dialog.locator('textarea[name="summary"]').fill("换一个标题再试一次。");
  await dialog.locator('input[name="url"]').fill(url);
  await dialog.getByRole("button", { name: "登记调研", exact: true }).click();
  await expect(dialog).toBeHidden();
  const dupBody = JSON.parse((await dupSent).postData() ?? "{}") as Record<
    string,
    unknown
  >;
  expect(dupBody.day, "查重走的是 (那一天, 那个 URL)").toBe(yesterday);
  await expect(page.locator("#toastRegion")).toContainText(yesterday);
  await expect(page.locator("#toastRegion")).not.toContainText(
    "今日调研已存在",
  );

  // 线 5（清空 ⇒ 不发明天，交给服务端时钟）：把弹窗里那一格清掉后请求体【不带 day】。
  // 这一发在未修时【也是绿的】—— 它是分母：没有它，「永远把今天硬写进 day」那种改法
  // 也能让线 2 变绿。它钉的是「留空 = 不上线」，与 0082 的 GET 同一套哨兵纪律。
  const blankSent = page.waitForRequest(
    (req) =>
      new URL(req.url()).pathname === "/api/v1/research/today" &&
      req.method() === "POST",
  );
  await page
    .locator(".page-header")
    .getByRole("button", { name: "新增调研", exact: true })
    .click();
  await dialog.locator('input[type="date"][aria-label="调研日期"]').fill("");
  await dialog.locator('input[name="title"]').fill("不填日期的调研");
  await dialog
    .locator('textarea[name="summary"]')
    .fill("这条归服务端说的今天。");
  await dialog.getByRole("button", { name: "登记调研", exact: true }).click();
  await expect(dialog).toBeHidden();
  const blankBody = JSON.parse((await blankSent).postData() ?? "{}") as Record<
    string,
    unknown
  >;
  expect(blankBody).not.toHaveProperty("day");

  // 线 6（不填 = 今天，由服务端定）：这条落在今天 ⇒ 今天那一屏看得见、昨天那一屏没有它。
  // ⚠ 线 5 的下游，【没有】只有它才能杀的变异：任何「空值也发 day」的坏法都先被线 5 抓住
  // （见归因表 M4/M5 两发全红在线 5）。它钉的是服务端那一档没被本轮改动带坏，不是新接线。
  await dayBox.fill("");
  await expect(cards.filter({ hasText: "不填日期的调研" })).toHaveCount(1);
  await expect(panel.locator("section.team-panel > p.muted")).toContainText(
    `汇总 ${today} 的调研卡`,
  );
  await dayBox.fill(yesterday);
  await expect(cards.filter({ hasText: "不填日期的调研" })).toHaveCount(0);

  expectNoBrowserErrors(browserErrors);
});

/** 读服务端该成员的技能 skill_id 列表（不是本页内存态）：加/删是否真落库以此为准。 */
async function readMemberSkills(
  page: Page,
  memberId: string,
): Promise<string[]> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/members/${id}`);
    const body = (await res.json()) as {
      member?: { skills?: { skill_id: string }[] };
    };
    return body.member?.skills?.map((s) => s.skill_id) ?? [];
  }, memberId);
}

/** 读服务端该成员的技能整行（name / note 是否真由界面那一行带上去）。 */
async function readMemberSkillRows(
  page: Page,
  memberId: string,
): Promise<{ skill_id: string; name: string; note?: string }[]> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/members/${id}`);
    const body = (await res.json()) as {
      member?: { skills?: { skill_id: string; name: string; note?: string }[] };
    };
    return body.member?.skills ?? [];
  }, memberId);
}

/** 读服务端该成员的执行器整行（kind / enabled 由界面哪一格带上去）。 */
async function readMemberExecutors(
  page: Page,
  memberId: string,
): Promise<{ seq: number; kind: string; enabled: boolean }[]> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/members/${id}`);
    const body = (await res.json()) as {
      member?: {
        executors?: { seq: number; kind: string; enabled: boolean }[];
      };
    };
    return body.member?.executors ?? [];
  }, memberId);
}

/** 读服务端该成员的执行器 seq 列表（同上，读的是库里的那几行）。 */
async function readMemberExecutorSeqs(
  page: Page,
  memberId: string,
): Promise<number[]> {
  return page.evaluate(async (id) => {
    const res = await fetch(`/api/v1/members/${id}`);
    const body = (await res.json()) as {
      member?: { executors?: { seq: number }[] };
    };
    return body.member?.executors?.map((e) => e.seq) ?? [];
  }, memberId);
}
