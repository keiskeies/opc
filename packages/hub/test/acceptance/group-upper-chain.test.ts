import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { InMemoryEventBus } from "../../src/events/bus.js";
import {
  type HubDeps,
  type HubRequest,
  type HubResponse,
  handleRequest,
} from "../../src/http/app.js";
import { signedHeaders } from "../../src/http/auth.js";
import { LOOPBACK_HOST } from "../../src/http/bind.js";
import { buildHubDeps } from "../../src/http/real-deps.js";
import { DRIVER_OFF } from "../fixtures/driver-state.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const TMP = fixtureTmp("group-upper-chain", import.meta.url);
mkdirSync(TMP, { recursive: true });
const NOW = Date.UTC(2026, 10, 23);
const TOKEN = "group-upper-acceptance-token";
const queues: WriteQueue[] = [];

function request(
  _deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
): HubRequest {
  const text = body === undefined ? "" : JSON.stringify(body);
  const question = path.indexOf("?");
  const pathname = question < 0 ? path : path.slice(0, question);
  const query: Record<string, string> = {};
  if (question >= 0) {
    for (const [key, value] of new URLSearchParams(path.slice(question + 1)))
      query[key] = value;
  }
  return {
    method,
    path: pathname,
    target: path,
    query,
    headers: signedHeaders(TOKEN, {
      method,
      target: path,
      body: text,
      now: NOW,
    }),
    body: text,
    peer: LOOPBACK_HOST,
  };
}

async function call(
  deps: HubDeps,
  method: string,
  path: string,
  body?: unknown,
): Promise<HubResponse> {
  return handleRequest(deps, request(deps, method, path, body));
}

function data<T>(body: unknown): T {
  return body as T;
}

async function world(): Promise<{ deps: HubDeps; db: DatabaseSync }> {
  const queue = new WriteQueue(
    join(TMP, `chain-${process.pid}-${queues.length}.db`),
  );
  queues.push(queue);
  const db = queue.writeConnection();
  migrate(db);
  return {
    db,
    deps: buildHubDeps({
      queue,
      bus: new InMemoryEventBus(),
      token: TOKEN,
      now: () => NOW,
      driverState: () => DRIVER_OFF,
    }),
  };
}

async function hire(
  deps: HubDeps,
  id: string,
  name: string,
  roleId: string,
  kind: "pure-model" | "human",
): Promise<string> {
  const result = await call(deps, "POST", "/api/v1/members", {
    name,
    role_id: roleId,
    model_tier: "execution",
    persona: {
      style: "结论先行",
      values: ["用户价值"],
      honesty: "不确定就说明",
    },
    skills: [],
    executors: [{ seq: 1, kind, config: { kind }, enabled: true }],
    tone: kind === "human" ? "warm" : "direct",
    seat_group_ids: [],
  });
  expect(result.status, `${id}: ${JSON.stringify(result.body)}`).toBe(201);
  return data<{ member: { member_id: string } }>(result.body).member.member_id;
}

afterAll(async () => {
  for (const queue of queues) {
    try {
      await queue.close();
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

describe("群角色上层验收链", () => {
  it("建群→招聘→CoS 建任务→私聊/会议→面板/文档→七面搜索→SSE  seq 连续", async () => {
    const { deps, db } = await world();
    const pmId = await hire(
      deps,
      "pm-1",
      "产品经理",
      "product_director",
      "pure-model",
    );
    const devId = await hire(deps, "dev-1", "开发工程师", "dev", "pure-model");
    const humanId = await hire(deps, "human-1", "测试同事", "qa", "human");

    const createdGroup = await call(deps, "POST", "/api/v1/groups", {
      title: "双十一大促",
      goal: "按时上线",
      member_ids: [pmId, devId, humanId],
    });
    expect(createdGroup.status, JSON.stringify(createdGroup.body)).toBe(201);
    const group = data<{
      group: { group_id: string };
      conversation_id: string;
      document: { ok: boolean; doc_id: string };
    }>(createdGroup.body);
    const groupId = group.group.group_id;
    const groupConversationId = group.conversation_id;
    expect(group.document.ok).toBe(true);
    expect(
      data<{ document: { origin: string; title: string } }>(
        (await call(deps, "GET", `/api/v1/documents/${group.document.doc_id}`))
          .body,
      ).document,
    ).toMatchObject({ origin: "auto", title: "立项：双十一大促" });
    const groups = await call(deps, "GET", "/api/v1/groups");
    expect(
      data<{ groups: { group_id: string }[] }>(groups.body).groups.some(
        (item) => item.group_id === groupId,
      ),
    ).toBe(true);

    const assigned = await call(
      deps,
      "POST",
      `/api/v1/conversations/${groupConversationId}/messages`,
      { body: "立项：双十一" },
    );
    expect(assigned.status).toBe(200);
    const dispatch = data<{
      dispatch: {
        ok: boolean;
        taskId: string;
        documentId: string;
        plan: { source: string };
      };
    }>(assigned.body).dispatch;
    expect(dispatch).toMatchObject({ ok: true, plan: { source: "rule" } });
    expect(
      data<{ document: { origin: string; task_id: string } }>(
        (await call(deps, "GET", `/api/v1/documents/${dispatch.documentId}`))
          .body,
      ).document,
    ).toMatchObject({ origin: "auto", task_id: dispatch.taskId });
    expect(
      db
        .prepare("SELECT status, assigned_role FROM tasks WHERE id = ?")
        .get(dispatch.taskId),
    ).toEqual({ status: "IN_PROGRESS", assigned_role: "product_director" });
    expect(
      db.prepare("SELECT task_id FROM groups WHERE group_id = ?").get(groupId),
    ).toEqual({ task_id: dispatch.taskId });

    const privateThread = await call(
      deps,
      "POST",
      `/api/v1/conversations/${groupId}/open-private`,
      { member_a: pmId, member_b: devId },
    );
    expect(privateThread.status).toBe(201);
    const conversationId = data<{ conversation: { conversation_id: string } }>(
      privateThread.body,
    ).conversation.conversation_id;
    expect(
      (
        await call(
          deps,
          "POST",
          `/api/v1/conversations/${conversationId}/messages`,
          {
            body: "请给一个上线建议",
          },
        )
      ).status,
    ).toBe(200);
    expect(
      data<{ messages: unknown[] }>(
        (
          await call(
            deps,
            "GET",
            `/api/v1/conversations/${conversationId}/messages`,
          )
        ).body,
      ).messages,
    ).toHaveLength(1);

    const meeting = await call(deps, "POST", "/api/v1/meetings", {
      group_id: groupId,
      task_id: dispatch.taskId,
      topic: "双十一上线评审",
      moderator_member_id: pmId,
      speaking_order: [pmId, devId, humanId],
    });
    expect(meeting.status).toBe(201);
    const meetingId = data<{ meeting: { meeting_id: string } }>(meeting.body)
      .meeting.meeting_id;
    for (const speaker of [pmId, devId, humanId]) {
      expect(
        (
          await call(deps, "POST", `/api/v1/meetings/${meetingId}/turns`, {
            speaker_member_id: speaker,
            content: `${speaker} 的建议`,
          })
        ).status,
      ).toBe(200);
    }
    const concluded = await call(
      deps,
      "POST",
      `/api/v1/meetings/${meetingId}/conclude`,
      {
        decision: "按计划上线",
        owner_member_id: devId,
        deadline_at: NOW + 86_400_000,
      },
    );
    expect(concluded.status).toBe(200);
    const conclusion = data<{
      summary: { ok: boolean; docId: string };
      governance: { action: string };
    }>(concluded.body);
    expect(conclusion.summary.ok).toBe(true);
    expect(conclusion.governance.action).toBe("backlog");
    expect(
      data<{ document: { body_text: string } }>(
        (
          await call(
            deps,
            "GET",
            `/api/v1/documents/${conclusion.summary.docId}`,
          )
        ).body,
      ).document.body_text,
    ).toContain(`${pmId} 的建议`);

    const backlog = await call(deps, "POST", "/api/v1/backlog", {
      title: "双十一待办",
      group_id: groupId,
      detail: "拆分执行",
    });
    expect(backlog.status).toBe(201);
    const backlogId = data<{ item: { id: string } }>(backlog.body).item.id;
    const split = await call(
      deps,
      "POST",
      `/api/v1/backlog/${backlogId}/split`,
      {
        children: [{ title: "页面" }, { title: "压测" }],
      },
    );
    expect(split.status).toBe(200);
    const splitData = data<{
      children: { id: string }[];
      document: { ok: boolean; doc_id: string };
    }>(split.body);
    expect(splitData.document.ok).toBe(true);
    expect(
      data<{ document: { origin: string } }>(
        (
          await call(
            deps,
            "GET",
            `/api/v1/documents/${splitData.document.doc_id}`,
          )
        ).body,
      ).document.origin,
    ).toBe("auto");
    const children = splitData.children;
    expect(
      (
        await call(
          deps,
          "POST",
          `/api/v1/backlog/${children[0]?.id ?? ""}/merge`,
          {
            into_id: children[1]?.id ?? "",
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await call(deps, "PATCH", `/api/v1/backlog/${backlogId}`, {
          due_at: NOW + 172_800_000,
        })
      ).status,
    ).toBe(200);

    const document = await call(deps, "POST", "/api/v1/documents", {
      kind: "markdown",
      title: "双十一计划",
      body_text: "版本一",
      group_id: groupId,
      task_id: dispatch.taskId,
    });
    expect(document.status).toBe(201);
    const docId = data<{ document: { doc_id: string } }>(document.body).document
      .doc_id;
    for (const bodyText of ["版本二", "版本三"]) {
      expect(
        (
          await call(deps, "PATCH", `/api/v1/documents/${docId}`, {
            body_text: bodyText,
          })
        ).status,
      ).toBe(200);
    }
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
    expect(
      data<{ document: { body_text: string } }>(
        (await call(deps, "GET", `/api/v1/documents/${docId}`)).body,
      ).document.body_text,
    ).toBe("版本一");

    const uploaded = await call(deps, "POST", "/api/v1/assets", {
      purpose: "import-source",
      mime: "text/markdown",
      data_base64: Buffer.from("# 双十一导入", "utf8").toString("base64"),
    });
    expect(uploaded.status).toBe(201);
    const assetId = data<{ asset: { asset_id: string } }>(uploaded.body).asset
      .asset_id;
    expect(
      (
        await call(deps, "POST", "/api/v1/documents/import", {
          asset_id: assetId,
          title: "双十一导入文档",
        })
      ).status,
    ).toBe(201);

    const search = await call(
      deps,
      "GET",
      "/api/v1/search?q=" + encodeURIComponent("双十一"),
    );
    expect(search.status).toBe(200);
    const faces = new Set(
      data<{ hits: { face: string }[] }>(search.body).hits.map(
        (hit) => hit.face,
      ),
    );
    for (const face of [
      "group",
      "task",
      "message",
      "document",
      "meeting",
      "backlog",
    ]) {
      expect(faces.has(face), face).toBe(true);
    }

    const latest = deps.bus.latestSeq();
    expect(latest).toBeGreaterThan(0);
    const subscription = deps.bus.subscribe(0);
    const iterator = subscription[Symbol.asyncIterator]();
    try {
      let previous = 0;
      const kinds: string[] = [];
      while (true) {
        const item = await Promise.race([
          iterator.next(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
        ]);
        if (item === null) break;
        expect(item.done).toBe(false);
        if (item.done || item.value === undefined)
          throw new Error("SSE 订阅提前结束。");
        expect(item.value.seq).toBeGreaterThan(previous);
        previous = item.value.seq;
        const persisted = db
          .prepare("SELECT payload FROM events WHERE id = ?")
          .get(item.value.seq) as { payload: string } | undefined;
        expect(persisted).toBeDefined();
        kinds.push(item.value.kind);
      }
      expect(kinds).toContain("DispatchAssigned");
      expect(kinds).toContain("MeetingSummaryReady");
    } finally {
      subscription.close();
    }

    // 旧控制室仍是独立入口，群角色 UI 不覆盖它。
    expect(
      readFileSync(
        join(process.cwd(), "packages/web/public/index.html"),
        "utf8",
      ),
    ).toContain("<html");
  });
});
