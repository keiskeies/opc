import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type {
  ExecutionOutcome,
  ExecutionTarget,
  HireMemberRequest,
  Persona,
} from "@opc/contracts";
import { afterAll, describe, expect, it, vi } from "vitest";
import { openPrivate } from "../../src/conversations/service.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  listDispatchRules,
  needsBossDecision,
  planDispatch,
  planDispatchWithFallback,
} from "../../src/dispatch/co.js";
import {
  routeGroupMessage,
  routePrivateInstruction,
} from "../../src/dispatch/service.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { createGroup } from "../../src/groups/service.js";
import { hireMember, updateMember } from "../../src/members/service.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("dispatch", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const queues: WriteQueue[] = [];
let fileSeq = 0;

class RecordingBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];

  publishPersisted(event: DomainEvent, seq: number): void {
    this.published.push({ event, seq });
  }

  subscribe(): never {
    throw new Error("not used by dispatch tests");
  }

  latestSeq(): number {
    return this.published.at(-1)?.seq ?? 0;
  }
}

const PERSONA: Persona = {
  style: "read first",
  values: ["evidence"],
  honesty: "test before claiming",
};

type Row = Record<string, unknown>;

function successOutcome(
  target: ExecutionTarget,
  text: string,
): ExecutionOutcome {
  const attempt = {
    execution_id: "execution-1",
    task_id: target.task_id,
    member_id: target.member_id,
    seq: 1,
    kind: "pure-model" as const,
    ok: true as const,
    text,
    summary: "执行完成",
    note: "",
  };
  return { ok: true, final: attempt, attempts: [attempt] };
}

async function waitForRow(read: () => Row | undefined): Promise<Row> {
  let found: Row | undefined;
  await vi.waitFor(
    () => {
      found = read();
      if (found === undefined) throw new Error("后台回写尚未出现");
    },
    { timeout: 3000, interval: 20 },
  );
  return found as Row;
}

function resultMessage(db: DatabaseSync, bodyPart: string): Row | undefined {
  return db
    .prepare(
      "SELECT * FROM messages WHERE body LIKE ? ORDER BY created_at DESC, message_id DESC",
    )
    .get("%" + bodyPart + "%") as Row | undefined;
}

function resultDocument(db: DatabaseSync, taskId: string): Row | undefined {
  return db
    .prepare(
      "SELECT * FROM documents WHERE task_id = ? AND title LIKE '执行结果：%'",
    )
    .get(taskId) as Row | undefined;
}

async function hire(
  q: WriteQueue,
  id: string,
  roleId: string,
  skillName?: string,
): Promise<void> {
  const req: HireMemberRequest = {
    name: `Member ${id}`,
    role_id: roleId,
    model_tier: "execution",
    persona: PERSONA,
    tone: "direct",
    skills:
      skillName === undefined
        ? []
        : [{ skill_id: `skill-${id}`, name: skillName }],
    executors: [
      {
        seq: 1,
        kind: "pure-model",
        config: { kind: "pure-model" },
        enabled: true,
      },
    ],
    seat_group_ids: [],
  };
  const result = await hireMember(q, { req, nowMs: NOW, newId: () => id });
  if (!result.ok)
    throw new Error(`hire ${id}: ${result.code} ${result.reason}`);
}

async function world(): Promise<{
  q: WriteQueue;
  db: DatabaseSync;
  groupId: string;
}> {
  const q = new WriteQueue(
    join(TMP, `dispatch-${process.pid}-${++fileSeq}.db`),
  );
  queues.push(q);
  const db = q.writeConnection();
  migrate(db);
  await hire(q, "dev-a", "dev", "Payments");
  await hire(q, "dev-b", "dev", "Testing");
  await hire(q, "qa-1", "qa", "Quality");
  const group = await createGroup(q, {
    req: {
      title: "Launch",
      goal: "Ship",
      member_ids: ["dev-a", "dev-b", "qa-1"],
    },
    nowMs: NOW,
  });
  if (!group.ok) throw new Error(group.reason);
  return { q, db, groupId: group.group.group_id };
}

async function bossPrivate(q: WriteQueue, memberId = "dev-a"): Promise<string> {
  const opened = await openPrivate(q, {
    memberA: "boss",
    memberB: memberId,
    nowMs: NOW,
    newId: () => `private-${memberId}`,
  });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.conversation.conversation_id;
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

describe("CoS escalation predicate", () => {
  it("escalates only the boss-reserved money, boundary, and strategy categories", () => {
    for (const text of [
      "采购新服务",
      "超预算了",
      "change boundary",
      "换技术栈",
      "战略方向",
    ]) {
      expect(needsBossDecision(text), text).toBe(true);
    }
    for (const text of ["修复普通 bug", "测试支付", "预算内完成", "设计页面"]) {
      expect(needsBossDecision(text), text).toBe(false);
    }
  });
});

describe("rule-first dispatch", () => {
  it("ships six global rules and picks the best skilled active candidate", async () => {
    const { db, groupId } = await world();
    expect(listDispatchRules(db)).toHaveLength(6);
    const plan = planDispatch(db, {
      groupId,
      text: "fix bug in payments checkout",
    });
    expect(plan).toMatchObject({
      source: "rule",
      needsBoss: false,
      targetMemberId: "dev-a",
      targetRoleId: "dev",
      ruleId: "cos_rule_bug",
    });
  });

  it("lets a group-specific rule override a global rule and lets boss escalation win", async () => {
    const { db, groupId } = await world();
    db.prepare(
      "INSERT INTO cos_dispatch_rules (rule_id, group_id, keyword, target_role_id, priority," +
        " enabled, created_at, updated_at) VALUES ('local-qa', ?, 'fix', 'qa', 100, 1, ?, ?)",
    ).run(groupId, NOW, NOW);
    expect(planDispatch(db, { groupId, text: "fix bug" })).toMatchObject({
      source: "rule",
      targetMemberId: "qa-1",
      ruleId: "local-qa",
    });
    expect(
      planDispatch(db, { groupId, text: "fix bug and spend money on采购" }),
    ).toMatchObject({
      source: "escalate",
      needsBoss: true,
      targetMemberId: null,
    });
  });

  it("returns none when no role candidate exists and excludes archived members", async () => {
    const { q, db, groupId } = await world();
    await updateMember(q, {
      memberId: "dev-a",
      req: { status: "archived" },
      nowMs: NOW,
    });
    await updateMember(q, {
      memberId: "dev-b",
      req: { status: "archived" },
      nowMs: NOW,
    });
    expect(planDispatch(db, { groupId, text: "fix bug" })).toMatchObject({
      source: "none",
      targetMemberId: null,
      targetRoleId: "dev",
    });
    expect(
      planDispatch(db, { groupId: "missing", text: "fix bug" }),
    ).toMatchObject({
      source: "none",
      targetMemberId: null,
    });
  });
});

describe("group message routing", () => {
  it("creates one execution task per source message and reuses it on replay", async () => {
    const { q, db, groupId } = await world();
    const first = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "fix bug in payments",
      sourceMessageId: "source-1",
      nowMs: NOW,
    });
    expect(first).toMatchObject({ ok: true, plan: { source: "rule" } });
    if (!first.ok || first.taskId === undefined) return;
    const again = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "fix bug in payments",
      sourceMessageId: "source-1",
      nowMs: NOW + 1,
    });
    expect(again).toMatchObject({
      ok: true,
      taskId: first.taskId,
      message: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 1,
    });
  });

  it("turns a rule hit into an auditable CoS assignment message", async () => {
    const { q, db, groupId } = await world();
    const bus = new RecordingBus();
    const result = await routeGroupMessage(q, bus, {
      groupId,
      text: "fix bug in payments",
      nowMs: NOW,
      newId: () => "assignment-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.message === null || !result.message.ok) return;
    expect(result.plan.targetMemberId).toBe("dev-a");
    expect(result.message.message.body).toContain("@dev-a");
    expect(result.message.message.mentions).toEqual(["dev-a"]);
    expect(result.message.message.author_kind).toBe("member");
    const sender = db
      .prepare("SELECT cos_member_id FROM groups WHERE group_id = ?")
      .get(groupId) as { cos_member_id: string };
    expect(result.message.message.sender_member_id).toBe(sender.cos_member_id);
    expect(bus.published.at(-1)?.event).toMatchObject({
      kind: "MessageReceived",
      messageId: "assignment-1",
      msgKind: "message",
    });
  });

  it("routes reserved decisions to a real @boss escalation message", async () => {
    const { q, groupId } = await world();
    const result = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "采购新服务",
      nowMs: NOW,
      newId: () => "escalation-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.message === null || !result.message.ok) return;
    expect(result.plan).toMatchObject({ source: "escalate", needsBoss: true });
    expect(result.message.message.body).toContain("@老板");
    expect(result.message.message.mentions).toEqual(["@boss"]);
    expect(result.message.msgKind).toBe("mention_boss");
  });

  it("stays silent when no rule or fallback exists", async () => {
    const { q, db, groupId } = await world();
    const result = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "write a haiku",
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      plan: { source: "none" },
      message: null,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({
      count: 0,
    });
  });

  it("runs the assigned member in the background and deposits the full result", async () => {
    const { q, db, groupId } = await world();
    await updateMember(q, {
      memberId: "dev-a",
      req: { model_tier: "management" },
      nowMs: NOW,
    });
    const output = "执行正文".repeat(2500);
    let captured: ExecutionTarget | undefined;
    const result = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "fix bug in payments",
      nowMs: NOW,
      workspace: "D:/work/payments",
      newId: () => "assignment-with-execution",
      execute: async (target) => {
        captured = target;
        return successOutcome(target, output);
      },
    });
    expect(result).toMatchObject({
      ok: true,
      execution_started: true,
      plan: { targetMemberId: "dev-a", targetRoleId: "dev" },
    });
    if (!result.ok || result.taskId === undefined) return;
    expect(captured).toEqual({
      task_id: result.taskId,
      member_id: "dev-a",
      role_id: "dev",
      model_tier: "management",
      instruction: "fix bug in payments",
      role_prompt: "",
      workspace: "D:/work/payments",
      max_budget_usd: 0,
      from_seq: 1,
    });
    const message = await waitForRow(() => resultMessage(db, "执行完成："));
    expect(message["sender_member_id"]).toBe("dev-a");
    expect(String(message["body"]).length).toBe(8000);
    const document = await waitForRow(() =>
      resultDocument(db, result.taskId as string),
    );
    expect(document["group_id"]).toBe(groupId);
    expect(document["task_id"]).toBe(result.taskId);
    expect(document["origin"]).toBe("auto");
    expect(String(document["body_text"])).toContain(output);
  });

  it("returns before a deferred executor completes and omits an unset workspace", async () => {
    const { q, db, groupId } = await world();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured: ExecutionTarget | undefined;
    const pending = routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "fix bug in payments",
      nowMs: NOW,
      execute: async (target) => {
        captured = target;
        await gate;
        return successOutcome(target, "deferred done");
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("HTTP 派发等待了执行器完成")),
            500,
          );
        }),
      ]);
      expect(result).toMatchObject({ ok: true, execution_started: true });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
    }
    const result = await pending;
    if (!result.ok || result.taskId === undefined) return;
    const taskId = result.taskId;
    expect(captured).not.toHaveProperty("workspace");
    await waitForRow(() => resultDocument(db, taskId));
  });

  it("turns a runner rejection into a member failure message and document without an unhandled rejection", async () => {
    const { q, db, groupId } = await world();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await routeGroupMessage(q, new RecordingBus(), {
        groupId,
        text: "fix bug in payments",
        nowMs: NOW,
        execute: async () => {
          throw new Error("runner exploded");
        },
      });
      expect(result).toMatchObject({ ok: true, execution_started: true });
      if (!result.ok || result.taskId === undefined) return;
      const taskId = result.taskId;
      const message = await waitForRow(() =>
        resultMessage(db, "runner exploded"),
      );
      expect(message["sender_member_id"]).toBe("dev-a");
      expect(String(message["body"])).toContain("executor_error");
      const document = await waitForRow(() => resultDocument(db, taskId));
      expect(String(document["body_text"])).toContain("executor_error");
      expect(String(document["body_text"])).toContain("runner exploded");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not claim execution when no runner is wired", async () => {
    const { q, db, groupId } = await world();
    const result = await routeGroupMessage(q, new RecordingBus(), {
      groupId,
      text: "fix bug in payments",
      nowMs: NOW,
    });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty("execution_started");
    if (!result.ok || result.taskId === undefined) return;
    expect(resultDocument(db, result.taskId)).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()).toEqual({
      count: 1,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM documents").get()).toEqual(
      {
        count: 1,
      },
    );
  });
});

describe("boss private instruction routing", () => {
  it("assigns once, broadcasts a null group, and writes the member reply and task-only document", async () => {
    const { q, db } = await world();
    const conversationId = await bossPrivate(q);
    await updateMember(q, {
      memberId: "dev-a",
      req: { model_tier: "management" },
      nowMs: NOW,
    });
    const bus = new RecordingBus();
    const execute = vi.fn(async (target: ExecutionTarget) =>
      successOutcome(target, "私聊自动回复正文"),
    );
    const result = await routePrivateInstruction(q, bus, {
      conversationId,
      memberId: "dev-a",
      text: "请完成私聊验收",
      sourceMessageId: "private-source-1",
      nowMs: NOW,
      workspace: "D:/work/private",
      execute,
    });
    expect(result).toMatchObject({
      ok: true,
      replayed: false,
      execution_started: true,
    });
    if (!result.ok) return;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      task_id: result.taskId,
      member_id: "dev-a",
      role_id: "dev",
      model_tier: "management",
      instruction: "请完成私聊验收",
      workspace: "D:/work/private",
    });
    expect(
      db
        .prepare(
          "SELECT parent_id, status, assigned_role FROM tasks WHERE id = ?",
        )
        .get(result.taskId),
    ).toEqual({ parent_id: null, status: "IN_PROGRESS", assigned_role: "dev" });
    const audit = db
      .prepare(
        "SELECT task_id, target, replay_key, payload FROM events WHERE replay_key = ?",
      )
      .get("private:private-source-1") as Row | undefined;
    expect(audit).toMatchObject({
      task_id: result.taskId,
      target: result.taskId,
      replay_key: "private:private-source-1",
    });
    expect(JSON.parse(String(audit?.["payload"]))).toMatchObject({
      kind: "private_dispatch",
      group_id: null,
      conversation_id: conversationId,
    });
    expect(
      bus.published.find(({ event }) => event.kind === "DispatchAssigned")
        ?.event,
    ).toEqual({
      kind: "DispatchAssigned",
      taskId: result.taskId,
      memberId: "dev-a",
      groupId: null,
    });

    const message = await waitForRow(
      () =>
        db
          .prepare(
            "SELECT * FROM messages WHERE conversation_id = ? AND body LIKE ?",
          )
          .get(conversationId, "%执行完成：私聊自动回复正文%") as
          | Row
          | undefined,
    );
    expect(message["sender_member_id"]).toBe("dev-a");
    expect(message["author_kind"]).toBe("member");
    const document = await waitForRow(() => resultDocument(db, result.taskId));
    expect(document["group_id"]).toBeNull();
    expect(document["task_id"]).toBe(result.taskId);
    expect(String(document["body_text"])).toContain("未关联（私聊）");
    expect(String(document["body_text"])).toContain("私聊自动回复正文");

    const replay = await routePrivateInstruction(q, bus, {
      conversationId,
      memberId: "dev-a",
      text: "重复消息不得再执行",
      sourceMessageId: "private-source-1",
      nowMs: NOW + 1,
      execute,
    });
    expect(replay).toMatchObject({
      ok: true,
      taskId: result.taskId,
      replayed: true,
      execution_started: false,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE replay_key = 'private:private-source-1'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      bus.published.filter(({ event }) => event.kind === "DispatchAssigned"),
    ).toHaveLength(1);
  });

  it("turns an executor rejection into a private failure reply and document", async () => {
    const { q, db } = await world();
    const conversationId = await bossPrivate(q);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await routePrivateInstruction(q, new RecordingBus(), {
        conversationId,
        memberId: "dev-a",
        text: "执行器会抛错",
        sourceMessageId: "private-source-failure",
        nowMs: NOW,
        execute: async () => {
          throw new Error("private runner exploded");
        },
      });
      expect(result).toMatchObject({ ok: true, execution_started: true });
      if (!result.ok) return;
      const message = await waitForRow(
        () =>
          db
            .prepare(
              "SELECT * FROM messages WHERE conversation_id = ? AND body LIKE ?",
            )
            .get(conversationId, "%private runner exploded%") as
            | Row
            | undefined,
      );
      expect(message["sender_member_id"]).toBe("dev-a");
      expect(String(message["body"])).toContain("executor_error");
      const document = await waitForRow(() =>
        resultDocument(db, result.taskId),
      );
      expect(document["group_id"]).toBeNull();
      expect(String(document["body_text"])).toContain(
        "private runner exploded",
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("creates the task but explicitly does not claim execution without a runner", async () => {
    const { q, db } = await world();
    const conversationId = await bossPrivate(q);
    const result = await routePrivateInstruction(q, new RecordingBus(), {
      conversationId,
      memberId: "dev-a",
      text: "没有执行器",
      sourceMessageId: "private-source-no-runner",
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      execution_started: false,
      execution_error: expect.stringContaining("未提供执行器"),
    });
    if (!result.ok) return;
    expect(resultDocument(db, result.taskId)).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?",
        )
        .get(conversationId),
    ).toEqual({ count: 0 });
  });

  it("rejects archived members and members outside the boss-private pair", async () => {
    const { q, db } = await world();
    const conversationId = await bossPrivate(q);
    const execute = vi.fn(async (target: ExecutionTarget) =>
      successOutcome(target, "不应执行"),
    );
    await updateMember(q, {
      memberId: "dev-a",
      req: { status: "archived" },
      nowMs: NOW,
    });
    const archived = await routePrivateInstruction(q, new RecordingBus(), {
      conversationId,
      memberId: "dev-a",
      text: "离任成员不能执行",
      sourceMessageId: "private-source-archived",
      nowMs: NOW,
      execute,
    });
    expect(archived).toMatchObject({ ok: false, code: "member_archived" });
    const outsider = await routePrivateInstruction(q, new RecordingBus(), {
      conversationId,
      memberId: "dev-b",
      text: "非对方成员不能执行",
      sourceMessageId: "private-source-outsider",
      nowMs: NOW,
      execute,
    });
    expect(outsider).toMatchObject({
      ok: false,
      code: "member_not_participant",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(db.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({
      count: 0,
    });
  });
});

describe("LLM fallback", () => {
  it("is called only without a rule and accepts only active seated candidates", async () => {
    const { db, groupId } = await world();
    let calls = 0;
    const valid = await planDispatchWithFallback(
      db,
      { groupId, text: "write a haiku" },
      async () => {
        calls += 1;
        return { memberId: "qa-1", reason: "Best fit" };
      },
    );
    expect(calls).toBe(1);
    expect(valid).toMatchObject({
      source: "llm",
      targetMemberId: "qa-1",
      targetRoleId: "qa",
      reason: "Best fit",
    });
    const invalid = await planDispatchWithFallback(
      db,
      { groupId, text: "write a haiku" },
      async () => {
        calls += 1;
        return { memberId: "outsider", reason: "Hallucinated" };
      },
    );
    expect(invalid).toMatchObject({ source: "none", targetMemberId: null });
    const ruled = await planDispatchWithFallback(
      db,
      { groupId, text: "fix bug" },
      async () => {
        calls += 1;
        return { memberId: "qa-1", reason: "Should not run" };
      },
    );
    expect(ruled.source).toBe("rule");
    expect(calls).toBe(2);
  });
});
