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
