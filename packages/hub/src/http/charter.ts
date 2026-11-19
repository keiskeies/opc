/**
 * 岗位书的 HTTP 入口（浏览器组织配置页的「写岗位书」那一格）。
 *
 * ── 为什么写侧【只认回环】，与 POST /org 同一条判据 ──────────────────────
 * 改岗位书 = 改验收标准 = 改谁能判什么（规格 §4.4.3 把它集中给 CEO），
 * 与改组织同级，是 self-escalating 的 CEO 权限写。所以它只认回环对端 + HMAC，
 * 也不进远程一次性 token 通道（§20.3 只授权「审批」出本机）。
 * 这道门与鉴权层那道【独立成立】（同 org.ts 的论证）：端到端打不到，
 * 测试直接调 handler 时它仍必须挡住，见 charter-route.test.ts。
 *
 * ── actor 不从请求体来 ───────────────────────────────────────────────────
 * saveCharterRequestSchema 没有 actor 键且 .strict()；署名固定 CHARTER_ACTOR
 * （charter/store.ts），多传 actor 是看得见的 422。
 *
 * ── GET 返回蛇形 ─────────────────────────────────────────────────────────
 * 库里存的是 charterSchema transform 之后的驼峰（store.ts 文件头 ②），
 * 而对外契约（前端并行按同一份写）要蛇形 CharterInput。charterToSnake 是
 * transform 的逆映射 —— 第二份映射就有漂移风险，风险由 charter-route.test.ts
 * 的往返用例挡（蛇形输出再过 charterSchema，缺键/多键当场红）。
 */
import {
  type Charter,
  type CharterInput,
  HTTP_NOT_IMPLEMENTED,
  HTTP_UNAUTHORIZED,
  HTTP_UNPROCESSABLE,
  saveCharterRequestSchema,
} from "@opc/contracts";
import { readLatestCharter, saveCharterVersion } from "../charter/store.js";
import type { HubDeps, HubRequest, HubResponse } from "./app.js";
import { isLoopbackAddress } from "./bind.js";

function res(status: number, body: unknown): HubResponse {
  return { status, body };
}

/** 与 bindings.ts / org.ts 同一行为（那边也解释了为什么每文件一份）。 */
function parseJson(text: string): unknown {
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparseable__: true };
  }
}

function issueBody(
  error: string,
  issues: { path: string; message: string }[],
): HubResponse {
  return res(HTTP_UNPROCESSABLE, { error, issues });
}

function issuesOf(e: {
  readonly issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[];
}): { path: string; message: string }[] {
  return e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** 回环门。返回 null = 放行，返回 HubResponse = 原样发出。同 org.ts。 */
export function assertLoopbackCharterRoute(
  req: HubRequest,
): HubResponse | null {
  if (isLoopbackAddress(req.peer)) return null;
  return res(HTTP_UNAUTHORIZED, { error: "unauthorized" });
}

/**
 * 驼峰 Charter → 蛇形 CharterInput 形状（charterSchema.transform 的逆）。
 * 可选格缺席时【不带键】而不是带 null（与 transform 的正向口径对偶）。
 */
export function charterToSnake(c: Charter): Record<string, unknown> {
  return {
    role_id: c.roleId,
    display_name: c.displayName,
    version: c.version,
    reports_to: c.reportsTo,
    honesty_boundaries: c.honestyBoundaries,
    ...(c.cognitiveSkill === undefined
      ? {}
      : { cognitive_skill: c.cognitiveSkill }),
    acceptance_criteria: c.acceptanceCriteria.map((a) => ({
      condition: a.condition,
      action: a.action,
      ...(a.target === undefined ? {} : { target: a.target }),
      message: a.message,
    })),
    forbidden_actions: c.forbiddenActions,
    tool_permissions: c.toolPermissions,
    model_tier: c.modelTier,
    budget: { daily_usd: c.budget.dailyUsd, per_task_usd: c.budget.perTaskUsd },
    ...(c.budgetDiscretion === undefined
      ? {}
      : {
          budget_discretion: {
            daily_usd: c.budgetDiscretion.dailyUsd,
            can_reallocate_within_role:
              c.budgetDiscretion.canReallocateWithinRole,
            cannot_exceed: c.budgetDiscretion.cannotExceed,
          },
        }),
    escalation_triggers: c.escalationTriggers,
    decision_scope: {
      autonomous: c.decisionScope.autonomous,
      requires_consultation: c.decisionScope.requiresConsultation,
      forbidden: c.decisionScope.forbidden,
    },
    judgment_mode: {
      type: c.judgmentMode.type,
      strict_rules: c.judgmentMode.strictRules,
      bounded_judgment: c.judgmentMode.boundedJudgment,
      full_discretion: c.judgmentMode.fullDiscretion,
    },
    ...(c.dissentRights === undefined
      ? {}
      : {
          dissent_rights: {
            can_challenge: c.dissentRights.canChallenge,
            cannot_challenge: c.dissentRights.cannotChallenge,
            escalation_path: c.dissentRights.escalationPath,
          },
        }),
    ...(c.stance === undefined ? {} : { stance: c.stance }),
    ...(c.untrustedInputs === undefined
      ? {}
      : { untrusted_inputs: c.untrustedInputs }),
    ...(c.searchPolicy === undefined
      ? {}
      : {
          search_policy: { tier_1_mandatory: c.searchPolicy.mandatoryDomains },
        }),
    ...(c.harnessDefaults === undefined
      ? {}
      : { harness_defaults: c.harnessDefaults }),
  };
}

/**
 * `GET /charter/:roleId` —— 取该角色最新一版岗位书（蛇形）。
 * 库里没有 ⇒ charter: null 而不是 404 —— 与 GET /org 空图回 v0 同一口径：
 * 「还没有」不是错误。读不改写，走统鉴权（回环 HMAC），这里不再判回环。
 */
export function charterViewRoute(deps: HubDeps, roleId: string): HubResponse {
  const c = readLatestCharter(deps.db, roleId);
  if (c === undefined) return res(200, { role_id: roleId, charter: null });
  return res(200, { role_id: roleId, charter: charterToSnake(c) });
}

/**
 * `POST /charter/:roleId` —— 存一版新岗位书。
 * 流程：回环门 → 装配未接 ⇒ 501 → 请求体过 schema ⇒ 422（带 issues）
 * → URL roleId 与 config.role_id 不一致 ⇒ 422（防一次编辑写到别的角色名下）
 * → saveCharterVersion（内部再校验 + 落预算 + 一条审计，同一事务）。
 */
export async function saveCharterRoute(
  deps: HubDeps,
  roleId: string,
  req: HubRequest,
): Promise<HubResponse> {
  const gate = assertLoopbackCharterRoute(req);
  if (gate !== null) return gate;
  if (deps.charterWriter === undefined) {
    return res(HTTP_NOT_IMPLEMENTED, {
      error:
        "本装配未接岗位书写入（HubDeps.charterWriter）。501 而不是 404：路由在，" +
        "契约里有，是这个装配没把写队列连起来。",
    });
  }
  const body = parseJson(req.body);
  const parsed = saveCharterRequestSchema.safeParse(body);
  if (!parsed.success) {
    return issueBody("岗位书保存请求非法", issuesOf(parsed.error));
  }
  const o = parsed.data;
  // charterSchema 的 transform 输出是驼峰，而 saveCharterVersion 收【蛇形原文】
  // （charter/store.ts:79 —— 它内部还要再过一次上游的 validateCharterDraft）。
  // safeParse 通过就意味着 body.config 已按 CharterInput 校验过，这里原文透传、不喂 transform 输出。
  const rawConfig = (body as { config: CharterInput }).config;
  if (o.config.roleId !== roleId) {
    return issueBody("岗位书保存请求非法", [
      {
        path: "config.role_id",
        message:
          "config.role_id [" +
          o.config.roleId +
          "] 与 URL 里的 roleId [" +
          roleId +
          "] 不一致。刻意不取其中之一为准 —— 那会让一次编辑改到另一个角色的岗位书。",
      },
    ]);
  }
  const r = await saveCharterVersion(deps.charterWriter, {
    roleId,
    config: rawConfig,
    nowMs: deps.now(),
    changeSummary: o.change_summary,
  });
  if (r.ok) {
    return res(200, {
      ok: true,
      version: r.version,
      charter_id: r.charterId,
      audit_seq: r.auditSeq,
    });
  }
  // 上游（store.ts）的拒绝没有 zod issues，只有人读的原因原文 —— 与 POST /org
  // 把 CommitResult.reason 透传成 422 {error} 同一形状。
  return res(HTTP_UNPROCESSABLE, { error: r.reason });
}
