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
        const response = await fetch(`http://127.0.0.1:${webPort}/group.html`);
        return response.ok;
      } catch {
        return false;
      }
    })
    .toBe(true);
  const admin = await fetch(`http://127.0.0.1:${webPort}/admin`);
  expect(admin.ok).toBe(true);
  expect(await admin.text()).toContain("<title>OPC · 控制室</title>");

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

  await page.goto(`${webOrigin}/group.html`);
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
  await tabs
    .getByRole("tab", { name: "任务流", exact: true })
    .press("ArrowRight");
  const documentsTab = tabs.getByRole("tab", { name: "文档区", exact: true });
  await expect(documentsTab).toBeFocused();
  await expect(documentsTab).toHaveAttribute("aria-selected", "true");

  const charter = page.locator(`[data-document-id="${first.document.doc_id}"]`);
  await expect(charter).toContainText("立项：双十一大促");
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
  await page.goto(`${webOrigin}/group.html`);
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

test("老板成员私聊：通讯录直开、老板发消息与文档关联成员复用同一会话", async ({
  page,
}) => {
  const browserErrors = watchBrowserErrors(page);
  await page.goto(`${webOrigin}/group.html`);
  await createGroupThroughUi(
    page,
    "老板私聊验收",
    "验证默认老板成员私聊",
    true,
  );
  await page.goto(`${webOrigin}/group.html`);
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
  const associations = page.getByRole("region", { name: "文档关联" });
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
  last_message_at: string;
  last_message_preview: string;
}

async function mockConversationList(page: Page) {
  const conversations: ConversationFixture[] = [
    {
      conversation_id: "attention-group",
      kind: "group",
      title: "急需拍板",
      unread_count: 8,
      boss_attention_count: 3,
      last_message_at: "2026-11-25T09:00:00.000Z",
      last_message_preview: "请确认预算",
    },
    {
      conversation_id: "pinned-private-new",
      kind: "private",
      title: "私聊置顶新",
      unread_count: 4,
      boss_attention_count: 0,
      last_message_at: "2026-11-25T08:00:00.000Z",
      last_message_preview: "最新私聊",
    },
    {
      conversation_id: "pinned-private-old",
      kind: "private",
      title: "私聊置顶旧",
      unread_count: 0,
      last_message_at: "2026-11-25T07:00:00.000Z",
      last_message_preview: "较早私聊",
    },
    {
      conversation_id: "ordinary-group",
      kind: "group",
      title: "普通未读群",
      unread_count: 6,
      last_message_at: "2026-11-25T06:00:00.000Z",
      last_message_preview: "只有未读，不需要拍板",
    },
    {
      conversation_id: "ordinary-private",
      kind: "private",
      title: "普通已读私聊",
      unread_count: 0,
      boss_attention_count: 0,
      last_message_at: "2026-11-25T05:00:00.000Z",
      last_message_preview: "普通消息",
    },
  ];
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
  await page.goto(`${webOrigin}/group.html`);

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

test("顶栏个人状态：默认在线、切换持久化且移动端可操作", async ({ page }) => {
  await page.goto(`${webOrigin}/group.html`);
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

test("左侧导航：键盘排序持久化并保持 data-nav 点击行为", async ({ page }) => {
  await page.goto(`${webOrigin}/group.html`);
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

  await page.goto(`${webOrigin}/group.html`);
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

  await page.goto(`${webOrigin}/group.html`);
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
  const standupAssociations = page.getByRole("region", {
    name: "文档关联",
  });
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
