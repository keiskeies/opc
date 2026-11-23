import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { HireMemberRequest, Persona } from "@opc/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { type DomainEvent, InMemoryEventBus } from "../../src/events/bus.js";
import type { ModelCaller } from "../../src/executors/pure-model.js";
import {
  type HubDeps,
  type HubRequest,
  handleRequest,
} from "../../src/http/app.js";
import { signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps } from "../../src/http/real-deps.js";
import { hireMember } from "../../src/members/service.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("domain-http", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const TOKEN = "domain-route-token";
const queues: WriteQueue[] = [];
let fileSeq = 0;

const PERSONA: Persona = {
  style: "read first",
  values: ["evidence"],
  honesty: "test before claiming",
};

function hireRequest(
  name: string,
  seatGroupIds: string[] = [],
  roleId = "dev",
): HireMemberRequest {
  return {
    name,
    role_id: roleId,
    model_tier: "execution",
    persona: PERSONA,
    tone: "direct",
    skills: [],
    executors: [
      {
        seq: 1,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ],
    seat_group_ids: seatGroupIds,
  };
}

async function world(
  options: { readonly callModel?: ModelCaller } = {},
): Promise<{ deps: HubDeps; db: DatabaseSync }> {
  const q = new WriteQueue(
    join(TMP, `domain-http-${process.pid}-${++fileSeq}.db`),
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  for (const [id, role] of [
    ["m-a", "dev"],
    ["m-b", "qa"],
  ] as const) {
    const result = await hireMember(q, {
      req: hireRequest(`Member ${id}`, [], role),
      nowMs: NOW,
      newId: () => id,
    });
    if (!result.ok) throw new Error(result.reason);
  }
  const deps = buildHubDeps({
    queue: q,
    bus: new InMemoryEventBus(),
    token: TOKEN,
    now: () => NOW,
    driverState: () => DRIVER_OFF,
    ...(options.callModel === undefined
      ? {}
      : { callModel: options.callModel }),
  });
  return { deps, db };
}

function request(
  _deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = signedHeaders(TOKEN, {
    method,
    target: path,
    body: body === undefined ? "" : JSON.stringify(body),
    now: NOW,
  }),
): HubRequest {
  const text = body === undefined ? "" : JSON.stringify(body);
  const question = path.indexOf("?");
  const pathname = question < 0 ? path : path.slice(0, question);
  const query: Record<string, string> = {};
  if (question >= 0) {
    for (const [key, value] of new URLSearchParams(path.slice(question + 1))) {
      query[key] = value;
    }
  }
  return {
    method,
    path: pathname,
    target: path,
    query,
    headers,
    body: text,
    peer: LOOPBACK_HOST,
  };
}

async function call(
  deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
) {
  return handleRequest(deps, request(deps, method, path, body));
}

async function openBossPrivate(
  deps: HubDeps,
  memberId = "m-a",
): Promise<string> {
  const opened = await call(
    deps,
    "POST",
    "/api/v1/conversations/private/open-private",
    { member_a: "boss", member_b: memberId },
  );
  expect(opened.status).toBe(201);
  return data<{ conversation: { conversation_id: string } }>(opened.body)
    .conversation.conversation_id;
}

function data<T>(body: unknown): T {
  return body as T;
}

interface PersistedBody {
  readonly ok: true;
  readonly auditSeq: number;
  readonly broadcast_error?: string;
}

interface CharterBody {
  readonly ok: true;
  readonly doc_id: string;
  readonly changed: boolean;
  readonly audit_seq?: number;
  readonly broadcast_error?: string;
}

interface GreetingBody {
  readonly group_id: string;
  readonly conversation_id?: string;
  readonly message_id?: string;
  readonly broadcast_error?: string;
  readonly error?: string;
}

interface HireBody extends PersistedBody {
  readonly member: { member_id: string };
  readonly greetings: GreetingBody[];
}

async function expectPersistedEvent(
  deps: HubDeps,
  write: PersistedBody,
  expected: DomainEvent,
): Promise<void> {
  expect(write).not.toHaveProperty("broadcast_error");
  expect(deps.bus.latestSeq()).toBeGreaterThanOrEqual(write.auditSeq);
  const subscription = deps.bus.subscribe(write.auditSeq - 1);
  try {
    const item = await subscription[Symbol.asyncIterator]().next();
    expect(item.done).toBe(false);
    expect(item.value).toMatchObject({ ...expected, seq: write.auditSeq });
  } finally {
    subscription.close();
  }
  expect(
    deps.db.prepare("SELECT id FROM events WHERE id = ?").get(write.auditSeq),
  ).toEqual({ id: write.auditSeq });
}

function eventCount(deps: HubDeps): number {
  const row = deps.db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
    count: number;
  };
  return row.count;
}

function expectDocumentAccessAudit(
  deps: HubDeps,
  docId: string,
  groupId: string | null,
  op: "opened" | "exported",
  auditSeq: number,
): void {
  const row = deps.db
    .prepare("SELECT * FROM events WHERE id = ?")
    .get(auditSeq) as Record<string, unknown> | undefined;
  expect(row).toMatchObject({
    id: auditSeq,
    task_id: null,
    actor_type: "human",
    actor_id: "ceo",
    action: "state_change",
    target: docId,
  });
  expect(JSON.parse(String(row?.payload))).toEqual({
    kind: "document_accessed",
    op,
    doc_id: docId,
    group_id: groupId,
  });
}

async function expectDocumentAccessEvent(
  deps: HubDeps,
  docId: string,
  groupId: string | null,
  op: "opened" | "exported",
  auditSeq: number,
): Promise<void> {
  expectDocumentAccessAudit(deps, docId, groupId, op, auditSeq);
  const subscription = deps.bus.subscribe(auditSeq - 1);
  try {
    const item = await subscription[Symbol.asyncIterator]().next();
    expect(item.done).toBe(false);
    expect(item.value).toEqual({
      kind: "DocumentAccessed",
      docId,
      op,
      seq: auditSeq,
    });
  } finally {
    subscription.close();
  }
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      // Already closed.
    }
  }
  let cleared = false;
  for (let attempt = 0; attempt < 40 && !cleared; attempt += 1) {
    try {
      rmSync(TMP, { recursive: true, force: true });
      cleared = true;
    } catch (error) {
      if (attempt === 39) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
});

describe("domain HTTP integration", () => {
  it("creates a group, opens a private thread, sends messages, and runs a meeting to conclusion", async () => {
    const { deps } = await world();
    const group = await call(deps, "POST", "/api/v1/groups", {
      title: "Launch",
      goal: "Ship",
      member_ids: ["m-a", "m-b"],
    });
    expect(group.status).toBe(201);
    const groupView = data<{
      group: { group_id: string };
      conversation_id: string;
    }>(group.body);
    const groupId = groupView.group.group_id;
    const groupConversationId = groupView.conversation_id;
    expect((await call(deps, "GET", "/api/v1/groups")).status).toBe(200);
    const groupMessage = await call(
      deps,
      "POST",
      `/api/v1/conversations/${groupConversationId}/messages`,
      { body: "fix bug in payments" },
    );
    expect(groupMessage.status).toBe(200);
    expect(
      data<{
        dispatch: {
          ok: boolean;
          taskId: string;
          plan: { targetMemberId: string };
        };
      }>(groupMessage.body).dispatch,
    ).toMatchObject({ ok: true, plan: { targetMemberId: "m-a" } });
    const dispatched = data<{ dispatch: { taskId: string } }>(
      groupMessage.body,
    ).dispatch;
    expect(
      deps.db
        .prepare("SELECT status, assigned_role FROM tasks WHERE id = ?")
        .get(dispatched.taskId),
    ).toEqual({ status: "IN_PROGRESS", assigned_role: "dev" });

    const opened = await call(
      deps,
      "POST",
      `/api/v1/conversations/${groupId}/open-private`,
      {
        member_a: "m-a",
        member_b: "m-b",
      },
    );
    expect(opened.status).toBe(201);
    const conversationId = data<{ conversation: { conversation_id: string } }>(
      opened.body,
    ).conversation.conversation_id;
    const sent = await call(
      deps,
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      {
        body: "hello @老板",
      },
    );
    expect(sent.status).toBe(200);
    expect(
      data<{ message: { mentions: string[] } }>(sent.body).message.mentions,
    ).toEqual(["@boss"]);
    const messages = await call(
      deps,
      "GET",
      `/api/v1/conversations/${conversationId}/messages`,
    );
    expect(data<{ messages: unknown[] }>(messages.body).messages).toHaveLength(
      1,
    );

    const meeting = await call(deps, "POST", "/api/v1/meetings", {
      group_id: groupId,
      topic: "Launch decision",
      moderator_member_id: "m-a",
      speaking_order: ["m-a", "m-b"],
    });
    expect(meeting.status).toBe(201);
    const meetingId = data<{ meeting: { meeting_id: string } }>(meeting.body)
      .meeting.meeting_id;
    expect(
      (
        await call(deps, "POST", `/api/v1/meetings/${meetingId}/turns`, {
          speaker_member_id: "m-a",
          content: "Ship it",
        })
      ).status,
    ).toBe(200);
    const concluded = await call(
      deps,
      "POST",
      `/api/v1/meetings/${meetingId}/conclude`,
      {
        decision: "Ship",
        owner_member_id: "m-b",
        deadline_at: NOW + 1000,
      },
    );
    expect(concluded.status).toBe(200);
    expect(
      data<{ summary: { ok: boolean; docId?: string } }>(concluded.body)
        .summary,
    ).toMatchObject({ ok: true });
    expect(
      data<{ meeting: { status: string } }>(
        (await call(deps, "GET", `/api/v1/meetings/${meetingId}`)).body,
      ).meeting.status,
    ).toBe("concluded");
  });

  it("dispatches a boss-private instruction and polls the member reply and result document", async () => {
    const callModel = vi.fn(async () => ({
      text:
        "私聊验收已完成。\n\n<<<OPC_DECISION>>>\n" +
        JSON.stringify({ action: "pass", summary: "私聊验收完成" }),
    }));
    const { deps, db } = await world({ callModel });
    const conversationId = await openBossPrivate(deps);
    const sent = await call(
      deps,
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: "请完成老板私聊自动执行验收" },
    );
    expect(sent.status).toBe(200);
    const body = data<{
      message: { message_id: string; author_kind: string };
      dispatch: { ok: true; taskId: string; execution_started: boolean };
      dispatch_error?: string;
    }>(sent.body);
    expect(body.dispatch).toMatchObject({ ok: true, execution_started: true });
    expect(body).not.toHaveProperty("dispatch_error");
    const taskId = body.dispatch.taskId;
    expect(callModel).toHaveBeenCalledTimes(1);
    expect(
      db
        .prepare("SELECT status, assigned_role FROM tasks WHERE id = ?")
        .get(taskId),
    ).toEqual({ status: "IN_PROGRESS", assigned_role: "dev" });
    const assignment = db
      .prepare("SELECT target, payload FROM events WHERE replay_key = ?")
      .get("private:" + body.message.message_id) as
      | { target: string; payload: string }
      | undefined;
    expect(assignment?.target).toBe(taskId);
    expect(JSON.parse(assignment?.payload ?? "{}")).toMatchObject({
      kind: "private_dispatch",
      task_id: taskId,
      group_id: null,
    });

    await vi.waitFor(() => {
      expect(
        db
          .prepare(
            "SELECT sender_member_id, body FROM messages" +
              " WHERE conversation_id = ? AND body LIKE '执行完成：%'",
          )
          .get(conversationId),
      ).toMatchObject({ sender_member_id: "m-a" });
      expect(
        db
          .prepare(
            "SELECT group_id, task_id FROM documents" +
              " WHERE task_id = ? AND title LIKE '执行结果：%'",
          )
          .get(taskId),
      ).toEqual({ group_id: null, task_id: taskId });
    });
  });

  it("keeps boss-private sending successful without an executor and reports execution_started false", async () => {
    const { deps, db } = await world();
    const { executorRunner: _runner, ...withoutExecutor } = deps;
    const conversationId = await openBossPrivate(withoutExecutor);
    const sent = await call(
      withoutExecutor,
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: "任务可派发，但本装配没有执行器" },
    );
    expect(sent.status).toBe(200);
    const body = data<{
      message: { author_kind: string };
      dispatch: {
        ok: true;
        taskId: string;
        execution_started: boolean;
        execution_error: string;
      };
    }>(sent.body);
    expect(body.message.author_kind).toBe("boss");
    expect(body.dispatch).toMatchObject({
      ok: true,
      execution_started: false,
      execution_error: expect.stringContaining("未提供执行器"),
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM documents WHERE task_id = ?")
        .get(body.dispatch.taskId),
    ).toEqual({ count: 0 });
  });

  it("attaches dispatch_error instead of failing an already-sent boss-private message", async () => {
    const { deps, db } = await world();
    const conversationId = await openBossPrivate(deps);
    const archived = await call(deps, "PATCH", "/api/v1/members/m-a", {
      status: "archived",
    });
    expect(archived.status).toBe(200);
    const sent = await call(
      deps,
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: "成员离任后的私聊消息仍应发送成功" },
    );
    expect(sent.status).toBe(200);
    const body = data<{
      ok: true;
      message: { author_kind: string; body: string };
      dispatch_error: string;
    }>(sent.body);
    expect(body.message).toMatchObject({
      author_kind: "boss",
      body: "成员离任后的私聊消息仍应发送成功",
    });
    expect(body.dispatch_error).toContain("消息已发送，但私聊派发失败");
    expect(body.dispatch_error).toContain("m-a");
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 0,
    });
  });

  it("never calls the executor for a member-member private conversation", async () => {
    const { deps, db } = await world();
    const runner = deps.executorRunner;
    if (runner === undefined) throw new Error("测试装配缺少 executorRunner");
    const execute = vi.fn(runner);
    const withExecutor = { ...deps, executorRunner: execute };
    const opened = await call(
      withExecutor,
      "POST",
      "/api/v1/conversations/private/open-private",
      { member_a: "m-a", member_b: "m-b" },
    );
    expect(opened.status).toBe(201);
    const conversationId = data<{ conversation: { conversation_id: string } }>(
      opened.body,
    ).conversation.conversation_id;
    const sent = await call(
      withExecutor,
      "POST",
      `/api/v1/conversations/${conversationId}/messages`,
      { body: "成员间私聊不自动执行" },
    );
    expect(sent.status).toBe(200);
    expect(data<Record<string, unknown>>(sent.body)).not.toHaveProperty(
      "dispatch",
    );
    expect(data<Record<string, unknown>>(sent.body)).not.toHaveProperty(
      "dispatch_error",
    );
    expect(execute).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 0,
    });
  });

  it("runs backlog operations, document versioning/export, templates, and global search", async () => {
    const { deps } = await world();
    const backlog = await call(deps, "POST", "/api/v1/backlog", {
      title: "研究市场",
      detail: "look at competitors",
      priority: 0,
    });
    expect(backlog.status).toBe(201);
    const itemId = data<{ item: { id: string } }>(backlog.body).item.id;
    expect(
      (await call(deps, "PATCH", `/api/v1/backlog/${itemId}`, { priority: -5 }))
        .status,
    ).toBe(200);
    const split = await call(deps, "POST", `/api/v1/backlog/${itemId}/split`, {
      children: [{ title: "A" }, { title: "B" }],
    });
    expect(split.status).toBe(200);
    expect(data<{ children: unknown[] }>(split.body).children).toHaveLength(2);

    const document = await call(deps, "POST", "/api/v1/documents", {
      kind: "markdown",
      title: "双十一计划",
      body_text: "第一版",
    });
    expect(document.status).toBe(201);
    const docId = data<{ document: { doc_id: string } }>(document.body).document
      .doc_id;
    expect(
      (
        await call(
          deps,
          "POST",
          `/api/v1/documents/${docId}/versions/1/restore`,
          {},
        )
      ).status,
    ).toBe(200);
    const exported = await call(
      deps,
      "GET",
      `/api/v1/documents/${docId}/export?format=md`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(exported.body as Uint8Array).toString("utf8")).toContain(
      "第一版",
    );

    expect(
      (
        await call(deps, "POST", "/api/v1/templates", {
          name: "Custom",
          kind: "markdown",
          body_text: "# Custom",
        })
      ).status,
    ).toBe(201);
    const uploaded = await call(deps, "POST", "/api/v1/assets", {
      purpose: "import-source",
      mime: "text/markdown",
      data_base64: Buffer.from("# 导入正文", "utf8").toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    const assetId = data<{ asset: { asset_id: string } }>(uploaded.body).asset
      .asset_id;
    const imported = await call(deps, "POST", "/api/v1/documents/import", {
      asset_id: assetId,
      title: "导入文档",
    });
    expect(imported.status).toBe(201);
    expect(
      data<{ document: { origin: string; body_text: string } }>(imported.body)
        .document,
    ).toMatchObject({ origin: "imported", body_text: "# 导入正文" });
    const search = await call(
      deps,
      "GET",
      "/api/v1/search?q=" + encodeURIComponent("双十一"),
    );
    expect(search.status).toBe(200);
    expect(
      data<{ hits: { face: string }[] }>(search.body).hits.some(
        (hit) => hit.face === "document",
      ),
    ).toBe(true);
  });

  it("audits and broadcasts document opens and binary exports with matching seq", async () => {
    const { deps } = await world();
    const group = await call(deps, "POST", "/api/v1/groups", {
      title: "Document access group",
      goal: "Audit reads",
      member_ids: [],
    });
    expect(group.status).toBe(201);
    const groupId = data<{ group: { group_id: string } }>(group.body).group
      .group_id;
    const created = await call(deps, "POST", "/api/v1/documents", {
      kind: "doc",
      title: "访问审计",
      body_text: "第一版",
      group_id: groupId,
    });
    expect(created.status).toBe(201);
    const docId = data<{ document: { doc_id: string } }>(created.body).document
      .doc_id;

    const beforeOpen = eventCount(deps);
    const opened = await call(deps, "GET", `/api/v1/documents/${docId}`);
    expect(opened.status).toBe(200);
    const openedBody = data<{
      audit_seq: number;
      broadcast_error?: string;
    }>(opened.body);
    expect(openedBody).not.toHaveProperty("broadcast_error");
    expect(eventCount(deps)).toBe(beforeOpen + 1);
    await expectDocumentAccessEvent(
      deps,
      docId,
      groupId,
      "opened",
      openedBody.audit_seq,
    );

    const beforeExport = eventCount(deps);
    const exported = await call(
      deps,
      "GET",
      `/api/v1/documents/${docId}/export?format=docx`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toBeInstanceOf(Uint8Array);
    const bytes = Buffer.from(exported.body as Uint8Array);
    expect(bytes.subarray(0, 2).toString("ascii")).toBe("PK");
    expect(exported.headers?.["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(eventCount(deps)).toBe(beforeExport + 1);
    await expectDocumentAccessEvent(
      deps,
      docId,
      groupId,
      "exported",
      deps.bus.latestSeq(),
    );
  });

  it("keeps document reads and exports available without a writer or fake audit", async () => {
    const { deps } = await world();
    const created = await call(deps, "POST", "/api/v1/documents", {
      kind: "markdown",
      title: "只读装配",
      body_text: "第一版",
    });
    expect(created.status).toBe(201);
    const docId = data<{ document: { doc_id: string } }>(created.body).document
      .doc_id;
    const { domainWriter: _writer, ...withoutWriter } = deps;
    const before = eventCount(deps);
    const latestSeq = deps.bus.latestSeq();

    const opened = await call(
      withoutWriter,
      "GET",
      `/api/v1/documents/${docId}`,
    );
    expect(opened.status).toBe(200);
    expect(data<Record<string, unknown>>(opened.body)).not.toHaveProperty(
      "audit_seq",
    );
    const exported = await call(
      withoutWriter,
      "GET",
      `/api/v1/documents/${docId}/export?format=md`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(exported.body as Uint8Array)).toEqual(
      Buffer.from("第一版", "utf8"),
    );
    expect(eventCount(deps)).toBe(before);
    expect(deps.bus.latestSeq()).toBe(latestSeq);
  });

  it("keeps committed document access audits and download bytes when broadcast fails", async () => {
    const { deps } = await world();
    const created = await call(deps, "POST", "/api/v1/documents", {
      kind: "markdown",
      title: "广播失败",
      body_text: "第一版",
    });
    expect(created.status).toBe(201);
    const docId = data<{ document: { doc_id: string } }>(created.body).document
      .doc_id;
    const before = eventCount(deps);
    const latestSeq = deps.bus.latestSeq();
    vi.spyOn(deps.bus, "publishPersisted").mockImplementation(() => {
      throw new Error("document access SSE unavailable");
    });

    const opened = await call(deps, "GET", `/api/v1/documents/${docId}`);
    expect(opened.status).toBe(200);
    const openedBody = data<{
      audit_seq: number;
      broadcast_error?: string;
    }>(opened.body);
    expect(openedBody.broadcast_error).toBe("document access SSE unavailable");
    expect(eventCount(deps)).toBe(before + 1);
    expectDocumentAccessAudit(
      deps,
      docId,
      null,
      "opened",
      openedBody.audit_seq,
    );
    expect(deps.bus.latestSeq()).toBe(latestSeq);

    const exported = await call(
      deps,
      "GET",
      `/api/v1/documents/${docId}/export?format=md`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(exported.body as Uint8Array)).toEqual(
      Buffer.from("第一版", "utf8"),
    );
    expect(eventCount(deps)).toBe(before + 2);
    const exportAudit = deps.db
      .prepare("SELECT id FROM events ORDER BY id DESC LIMIT 1")
      .get() as { id: number };
    expectDocumentAccessAudit(deps, docId, null, "exported", exportAudit.id);
  });

  it("keeps auth before routing and returns 501/422 instead of fake success", async () => {
    const { deps } = await world();
    expect(
      (
        await handleRequest(
          deps,
          request(deps, "GET", "/api/v1/groups", undefined, {}),
        )
      ).status,
    ).toBe(401);
    const { domainWriter: _writer, ...withoutWriter } = deps;
    expect(
      (
        await call(withoutWriter, "POST", "/api/v1/backlog", {
          title: "No writer",
        })
      ).status,
    ).toBe(501);
    const malformed = await handleRequest(deps, {
      ...request(deps, "POST", "/api/v1/backlog"),
      body: "{broken",
      headers: signedHeaders(TOKEN, {
        method: "POST",
        target: "/api/v1/backlog",
        body: "{broken",
        now: NOW,
      }),
    });
    expect(malformed.status).toBe(422);
    expect((await call(deps, "GET", "/api/v1/not-declared")).status).toBe(404);
  });

  it("broadcasts group lifecycle and seat changes with their audit seq", async () => {
    const { deps } = await world();
    const created = await call(deps, "POST", "/api/v1/groups", {
      title: "Broadcast group",
      goal: "Close the SSE gap",
      member_ids: [],
    });
    expect(created.status).toBe(201);
    const createdBody = data<PersistedBody & { group: { group_id: string } }>(
      created.body,
    );
    const groupId = createdBody.group.group_id;
    await expectPersistedEvent(deps, createdBody, {
      kind: "GroupUpdated",
      groupId,
      op: "created",
    });

    const renamed = await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
      title: "Renamed group",
    });
    expect(renamed.status).toBe(200);
    const renamedBody = data<PersistedBody>(renamed.body);
    await expectPersistedEvent(deps, renamedBody, {
      kind: "GroupUpdated",
      groupId,
      op: "updated",
    });

    const added = await call(
      deps,
      "POST",
      `/api/v1/groups/${groupId}/members`,
      { member_id: "m-a" },
    );
    expect(added.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(added.body), {
      kind: "GroupUpdated",
      groupId,
      op: "updated",
    });

    const removed = await call(
      deps,
      "DELETE",
      `/api/v1/groups/${groupId}/members/m-a`,
    );
    expect(removed.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(removed.body), {
      kind: "GroupUpdated",
      groupId,
      op: "updated",
    });

    const archived = await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
      status: "archived",
    });
    expect(archived.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(archived.body), {
      kind: "GroupUpdated",
      groupId,
      op: "dissolved",
    });
  });

  it("versions the auto charter through rename, goal and seat changes", async () => {
    const { deps, db } = await world();
    const created = await call(deps, "POST", "/api/v1/groups", {
      title: "Charter origin",
      goal: "Initial goal",
      member_ids: ["m-a"],
    });
    expect(created.status).toBe(201);
    const createdBody = data<
      PersistedBody & {
        group: { group_id: string };
        document: { ok: true; doc_id: string };
      }
    >(created.body);
    const groupId = createdBody.group.group_id;
    const docId = createdBody.document.doc_id;
    expect(createdBody.document.ok).toBe(true);
    const initial = await call(deps, "GET", `/api/v1/documents/${docId}`);
    expect(initial.status).toBe(200);
    const initialDocument = data<{
      document: {
        origin: string;
        kind: string;
        title: string;
        body_text: string;
      };
    }>(initial.body).document;
    expect(initialDocument).toMatchObject({
      origin: "auto",
      kind: "markdown",
      title: "立项：Charter origin",
    });
    expect(initialDocument.body_text).toContain(groupId);
    expect(initialDocument.body_text).toContain("Initial goal");
    expect(initialDocument.body_text).toContain("状态：active");
    expect(initialDocument.body_text).toContain(
      `创建时间：${new Date(NOW).toISOString()}`,
    );
    expect(initialDocument.body_text).toContain("member_id：m-a");
    expect(initialDocument.body_text).toContain("name：Member m-a");
    expect(initialDocument.body_text).toContain("role_id：dev");
    expect(initialDocument.body_text).toContain("seat：member");
    expect(initialDocument.body_text).toContain("边界说明");

    async function expectCharterVersion(
      response: Awaited<ReturnType<typeof call>>,
      seq: number,
    ): Promise<string> {
      expect(response.status).toBe(200);
      const document = data<{ document: CharterBody }>(response.body).document;
      expect(document).toMatchObject({
        ok: true,
        doc_id: docId,
        changed: true,
      });
      expect(document.audit_seq).toBeTypeOf("number");
      await expectPersistedEvent(
        deps,
        { ok: true, auditSeq: document.audit_seq ?? 0 },
        { kind: "DocumentChanged", docId, op: "saved" },
      );
      const version = db
        .prepare(
          "SELECT seq, body_text FROM document_versions WHERE doc_id = ? AND seq = ?",
        )
        .get(docId, seq) as { seq: number; body_text: string };
      expect(version.seq).toBe(seq);
      return version.body_text;
    }

    const renamed = await expectCharterVersion(
      await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
        title: "Charter renamed",
      }),
      2,
    );
    expect(renamed).toContain("# 立项：Charter renamed");
    const goal = await expectCharterVersion(
      await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
        goal: "Latest goal",
      }),
      3,
    );
    expect(goal).toContain("Latest goal");
    const added = await expectCharterVersion(
      await call(deps, "POST", `/api/v1/groups/${groupId}/members`, {
        member_id: "m-b",
      }),
      4,
    );
    expect(added).toContain("member_id：m-b");
    expect(added).toContain("name：Member m-b");
    expect(added).toContain("role_id：qa");
    const removed = await expectCharterVersion(
      await call(deps, "DELETE", `/api/v1/groups/${groupId}/members/m-b`),
      5,
    );
    expect(removed).not.toContain("member_id：m-b");
    expect(removed).toContain("Latest goal");

    const latestSeq = deps.bus.latestSeq();
    const unchanged = await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
      goal: "Latest goal",
    });
    expect(unchanged.status).toBe(200);
    expect(data<{ document: CharterBody }>(unchanged.body).document).toEqual({
      ok: true,
      doc_id: docId,
      changed: false,
    });
    expect(deps.bus.latestSeq()).toBe(latestSeq + 1);
    const versions = await call(
      deps,
      "GET",
      `/api/v1/documents/${docId}/versions`,
    );
    expect(
      data<{ versions: { seq: number }[] }>(versions.body).versions.map(
        (version) => version.seq,
      ),
    ).toEqual([5, 4, 3, 2, 1]);
  });

  it("reports a missing charter without rolling back group or seat writes", async () => {
    const { deps, db } = await world();
    const created = await call(deps, "POST", "/api/v1/groups", {
      title: "Missing charter",
      goal: "Before",
      member_ids: [],
    });
    const createdBody = data<{
      group: { group_id: string };
      document: { doc_id: string };
    }>(created.body);
    const groupId = createdBody.group.group_id;
    db.prepare("UPDATE documents SET deleted_at = ? WHERE doc_id = ?").run(
      NOW,
      createdBody.document.doc_id,
    );
    const missing = {
      ok: false,
      code: "charter_document_missing",
    };
    const patched = await call(deps, "PATCH", `/api/v1/groups/${groupId}`, {
      goal: "Committed goal",
    });
    expect(patched.status).toBe(200);
    expect(data<{ document: unknown }>(patched.body).document).toMatchObject(
      missing,
    );
    const added = await call(
      deps,
      "POST",
      `/api/v1/groups/${groupId}/members`,
      { member_id: "m-b" },
    );
    expect(added.status).toBe(200);
    expect(data<{ document: unknown }>(added.body).document).toMatchObject(
      missing,
    );
    const removed = await call(
      deps,
      "DELETE",
      `/api/v1/groups/${groupId}/members/m-b`,
    );
    expect(removed.status).toBe(200);
    expect(data<{ document: unknown }>(removed.body).document).toMatchObject(
      missing,
    );
    expect(
      db.prepare("SELECT goal FROM groups WHERE group_id = ?").get(groupId),
    ).toEqual({ goal: "Committed goal" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM group_members WHERE group_id = ? AND member_id = 'm-b'",
        )
        .get(groupId),
    ).toEqual({ count: 0 });
  });

  it("keeps charter saves committed when their document broadcast fails", async () => {
    const { deps, db } = await world();
    const created = await call(deps, "POST", "/api/v1/groups", {
      title: "Charter broadcast",
      goal: "Before",
      member_ids: [],
    });
    const createdBody = data<{
      group: { group_id: string };
      document: { doc_id: string };
    }>(created.body);
    vi.spyOn(deps.bus, "publishPersisted").mockImplementation(() => {
      throw new Error("document SSE unavailable");
    });
    const response = await call(
      deps,
      "PATCH",
      `/api/v1/groups/${createdBody.group.group_id}`,
      { goal: "After" },
    );
    expect(response.status).toBe(200);
    const body = data<PersistedBody & { document: CharterBody }>(response.body);
    expect(body).toMatchObject({
      ok: true,
      broadcast_error: "document SSE unavailable",
      document: {
        ok: true,
        doc_id: createdBody.document.doc_id,
        changed: true,
        broadcast_error: "document SSE unavailable",
      },
    });
    expect(body.document).not.toHaveProperty("broadcastError");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM document_versions WHERE doc_id = ?",
        )
        .get(createdBody.document.doc_id),
    ).toEqual({ count: 2 });
  });

  it("greets every deduplicated seat group as the hired member after the committed hire", async () => {
    const { deps, db } = await world();
    const groups: {
      readonly title: string;
      readonly group_id: string;
      readonly conversation_id: string;
    }[] = [];
    for (const title of ["报到群甲", "报到群乙"]) {
      const created = await call(deps, "POST", "/api/v1/groups", {
        title,
        goal: "验证招聘后的报到副作用",
        member_ids: [],
      });
      expect(created.status).toBe(201);
      const body = data<{
        group: { group_id: string };
        conversation_id: string;
      }>(created.body);
      groups.push({
        title,
        group_id: body.group.group_id,
        conversation_id: body.conversation_id,
      });
    }
    groups.sort((a, b) => a.group_id.localeCompare(b.group_id));
    const [first, second] = groups;
    if (first === undefined || second === undefined) {
      throw new Error("两个测试群必须创建成功");
    }
    db.prepare("DELETE FROM conversations WHERE conversation_id = ?").run(
      second.conversation_id,
    );
    const beforeSeq = deps.bus.latestSeq();
    const subscription = deps.bus.subscribe(beforeSeq);
    const hired = await call(
      deps,
      "POST",
      "/api/v1/members",
      hireRequest("报到新人", [
        second.group_id,
        first.group_id,
        second.group_id,
      ]),
    );
    expect(hired.status).toBe(201);
    const body = data<HireBody>(hired.body);
    const memberId = body.member.member_id;
    expect(body).not.toHaveProperty("broadcast_error");
    expect(
      JSON.parse(
        String(
          db
            .prepare("SELECT payload FROM events WHERE id = ?")
            .get(body.auditSeq)?.payload,
        ),
      ),
    ).toMatchObject({
      kind: "member_hired",
      member_id: memberId,
      seat_group_ids: [first.group_id, second.group_id],
    });
    expect(body.greetings).toEqual([
      {
        group_id: first.group_id,
        conversation_id: first.conversation_id,
        message_id: expect.any(String),
      },
      {
        group_id: second.group_id,
        conversation_id: expect.any(String),
        message_id: expect.any(String),
      },
    ]);
    expect(body.greetings[1]?.conversation_id).not.toBe(second.conversation_id);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversations WHERE kind = 'group' AND group_id = ?",
        )
        .get(second.group_id),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM group_members WHERE member_id = ?",
        )
        .get(memberId),
    ).toEqual({ count: 2 });

    const iterator = subscription[Symbol.asyncIterator]();
    try {
      const hireEvent = await iterator.next();
      expect(hireEvent.done).toBe(false);
      expect(hireEvent.value).toEqual({
        kind: "MemberHired",
        memberId,
        groupId: first.group_id,
        roleId: "dev",
        seq: body.auditSeq,
      });
      for (const [index, greeting] of body.greetings.entries()) {
        const group = groups[index];
        if (
          greeting.message_id === undefined ||
          greeting.conversation_id === undefined ||
          group === undefined
        ) {
          throw new Error("成功报到必须带群、会话与消息标识");
        }
        const broadcast = await iterator.next();
        expect(broadcast.done).toBe(false);
        expect(broadcast.value).toEqual({
          kind: "MessageReceived",
          messageId: greeting.message_id,
          conversationId: greeting.conversation_id,
          groupId: greeting.group_id,
          msgKind: "message",
          seq: body.auditSeq + index + 1,
        });
        expect(
          db
            .prepare(
              "SELECT sender_member_id, author_kind, body FROM messages" +
                " WHERE conversation_id = ?",
            )
            .get(greeting.conversation_id),
        ).toEqual({
          sender_member_id: memberId,
          author_kind: "member",
          body:
            `大家好，我是报到新人，已加入${group.title}，` +
            "岗位是开发工程师。我会以直接的方式沟通，请多关照。",
        });
        expect(
          db
            .prepare(
              "SELECT actor_type, actor_id, action, payload FROM events WHERE id = ?",
            )
            .get(body.auditSeq + index + 1),
        ).toMatchObject({
          actor_type: "agent",
          actor_id: memberId,
          action: "meeting",
          payload: expect.any(String),
        });
        expect(
          JSON.parse(
            String(
              db
                .prepare("SELECT payload FROM events WHERE id = ?")
                .get(body.auditSeq + index + 1)?.payload,
            ),
          ),
        ).toMatchObject({
          kind: "message_posted",
          message_id: greeting.message_id,
          conversation_id: greeting.conversation_id,
          group_id: greeting.group_id,
          author_kind: "member",
        });
      }
    } finally {
      subscription.close();
    }
  });

  it("keeps the hire and first greeting successful when the second group greeting fails", async () => {
    const { deps, db } = await world();
    const groups: {
      readonly title: string;
      readonly group_id: string;
      readonly conversation_id: string;
    }[] = [];
    for (const title of ["失败隔离群甲", "失败隔离群乙"]) {
      const created = await call(deps, "POST", "/api/v1/groups", {
        title,
        goal: "验证单群报到失败不阻断招聘",
        member_ids: [],
      });
      expect(created.status).toBe(201);
      const body = data<{
        group: { group_id: string };
        conversation_id: string;
      }>(created.body);
      groups.push({
        title,
        group_id: body.group.group_id,
        conversation_id: body.conversation_id,
      });
    }
    groups.sort((a, b) => a.group_id.localeCompare(b.group_id));
    const [first, second] = groups;
    if (first === undefined || second === undefined) {
      throw new Error("两个测试群必须创建成功");
    }
    db.exec(
      "CREATE TRIGGER block_second_greeting BEFORE INSERT ON messages" +
        ` WHEN NEW.conversation_id = '${second.conversation_id}'` +
        " BEGIN SELECT RAISE(ABORT, 'second greeting unavailable'); END;",
    );
    const beforeEvents = eventCount(deps);
    const hired = await call(
      deps,
      "POST",
      "/api/v1/members",
      hireRequest("降级仍入职", [second.group_id, first.group_id]),
    );
    expect(hired.status).toBe(201);
    const body = data<HireBody>(hired.body);
    expect(body.ok).toBe(true);
    expect(body.greetings).toEqual([
      {
        group_id: first.group_id,
        conversation_id: first.conversation_id,
        message_id: expect.any(String),
      },
      {
        group_id: second.group_id,
        conversation_id: second.conversation_id,
        error: "second greeting unavailable",
      },
    ]);
    expect(
      db
        .prepare("SELECT status FROM members WHERE member_id = ?")
        .get(body.member.member_id),
    ).toEqual({ status: "active" });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM group_members WHERE member_id = ?",
        )
        .get(body.member.member_id),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(first.conversation_id),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(second.conversation_id),
    ).toEqual({ count: 0 });
    expect(eventCount(deps)).toBe(beforeEvents + 2);
    await expectPersistedEvent(deps, body, {
      kind: "MemberHired",
      memberId: body.member.member_id,
      groupId: first.group_id,
      roleId: "dev",
    });
  });

  it("broadcasts hires with a first seat group or null, then member mutations by facet", async () => {
    const { deps, db } = await world();
    const group = await call(deps, "POST", "/api/v1/groups", {
      title: "Hiring group",
      member_ids: [],
    });
    expect(group.status).toBe(201);
    const groupId = data<{ group: { group_id: string } }>(group.body).group
      .group_id;

    const seated = await call(
      deps,
      "POST",
      "/api/v1/members",
      hireRequest("Seated hire", [groupId]),
    );
    expect(seated.status).toBe(201);
    const seatedBody = data<HireBody>(seated.body);
    expect(seatedBody.greetings).toEqual([
      {
        group_id: groupId,
        conversation_id: data<{ conversation_id: string }>(group.body)
          .conversation_id,
        message_id: expect.any(String),
      },
    ]);
    await expectPersistedEvent(deps, seatedBody, {
      kind: "MemberHired",
      memberId: seatedBody.member.member_id,
      groupId,
      roleId: "dev",
    });

    const unseated = await call(
      deps,
      "POST",
      "/api/v1/members",
      hireRequest("Unseated hire"),
    );
    expect(unseated.status).toBe(201);
    const unseatedBody = data<HireBody>(unseated.body);
    const memberId = unseatedBody.member.member_id;
    expect(unseatedBody.greetings).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({
      count: 1,
    });
    await expectPersistedEvent(deps, unseatedBody, {
      kind: "MemberHired",
      memberId,
      groupId: null,
      roleId: "dev",
    });

    const profile = await call(deps, "PATCH", `/api/v1/members/${memberId}`, {
      tone: "warm",
    });
    expect(profile.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(profile.body), {
      kind: "MemberUpdated",
      memberId,
      op: "profile",
    });

    const status = await call(deps, "PATCH", `/api/v1/members/${memberId}`, {
      status: "archived",
    });
    expect(status.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(status.body), {
      kind: "MemberUpdated",
      memberId,
      op: "status",
    });

    const deleted = await call(deps, "DELETE", "/api/v1/members/m-b");
    expect(deleted.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(deleted.body), {
      kind: "MemberUpdated",
      memberId: "m-b",
      op: "status",
    });

    const skills = await call(deps, "POST", "/api/v1/members/m-a/skills", {
      skills: [{ skill_id: "typescript", name: "TypeScript" }],
    });
    expect(skills.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(skills.body), {
      kind: "MemberUpdated",
      memberId: "m-a",
      op: "skills",
    });

    const skillRemoved = await call(
      deps,
      "DELETE",
      "/api/v1/members/m-a/skills/typescript",
    );
    expect(skillRemoved.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(skillRemoved.body), {
      kind: "MemberUpdated",
      memberId: "m-a",
      op: "skills",
    });

    const executors = await call(
      deps,
      "POST",
      "/api/v1/members/m-a/executors",
      {
        executors: [
          {
            seq: 1,
            kind: "pure-model",
            config: { kind: "pure-model" },
            enabled: true,
          },
          {
            seq: 2,
            kind: "human",
            config: { kind: "human" },
            enabled: true,
          },
        ],
      },
    );
    expect(executors.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(executors.body), {
      kind: "MemberUpdated",
      memberId: "m-a",
      op: "executors",
    });

    const executorRemoved = await call(
      deps,
      "DELETE",
      "/api/v1/members/m-a/executors/2",
    );
    expect(executorRemoved.status).toBe(200);
    await expectPersistedEvent(
      deps,
      data<PersistedBody>(executorRemoved.body),
      { kind: "MemberUpdated", memberId: "m-a", op: "executors" },
    );

    const avatar = await call(deps, "POST", "/api/v1/members/m-a/avatar", {
      avatar_seed: "broadcast-avatar",
    });
    expect(avatar.status).toBe(200);
    await expectPersistedEvent(deps, data<PersistedBody>(avatar.body), {
      kind: "MemberUpdated",
      memberId: "m-a",
      op: "profile",
    });
    expect(
      db
        .prepare("SELECT avatar_seed FROM members WHERE member_id = 'm-a'")
        .get(),
    ).toEqual({ avatar_seed: "broadcast-avatar" });
  });

  it("keeps a committed group write successful when the bus throws", async () => {
    const { deps, db } = await world();
    vi.spyOn(deps.bus, "publishPersisted").mockImplementation(() => {
      throw new Error("SSE broadcast unavailable");
    });
    const response = await call(deps, "POST", "/api/v1/groups", {
      title: "Committed despite broadcast failure",
      member_ids: [],
    });
    expect(response.status).toBe(201);
    const body = data<
      PersistedBody & {
        group: { group_id: string };
        document: { ok: boolean };
      }
    >(response.body);
    expect(body).toMatchObject({
      ok: true,
      broadcast_error: "SSE broadcast unavailable",
      document: { ok: true },
    });
    expect(body).not.toHaveProperty("broadcastError");
    expect(
      db
        .prepare("SELECT title FROM groups WHERE group_id = ?")
        .get(body.group.group_id),
    ).toEqual({ title: "Committed despite broadcast failure" });
    expect(
      db.prepare("SELECT id FROM events WHERE id = ?").get(body.auditSeq),
    ).toEqual({ id: body.auditSeq });
  });
});
