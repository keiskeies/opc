/**
 * CoS 分发规划：老板授权升级 > 本群/全局规则 > 注入式 LLM 兜底。
 * 只读候选、技能、执行器与规则，不写事件或审计；fallback 由调用方注入。
 */
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";

export type DispatchCandidate = {
  readonly memberId: string;
  readonly name: string;
  readonly roleId: string;
  readonly roleCategory: string;
  readonly seat: "cos" | "member";
  readonly skills: readonly { readonly id: string; readonly name: string }[];
  readonly enabledExecutors: number;
};

export type DispatchRule = {
  readonly ruleId: string;
  readonly groupId: string | null;
  readonly keyword: string;
  readonly targetRoleId: string;
  readonly priority: number;
};

export type DispatchPlan = {
  readonly source: "escalate" | "rule" | "llm" | "none";
  readonly needsBoss: boolean;
  readonly targetMemberId: string | null;
  readonly targetRoleId: string | null;
  readonly ruleId: string | null;
  readonly reason: string;
};

export type DispatchInput = {
  readonly groupId: string;
  readonly text: string;
};

type DbLike = Pick<DatabaseSync, "prepare">;
type Fallback = (
  input: DispatchInput & { readonly candidates: readonly DispatchCandidate[] },
) => Promise<{ readonly memberId: string; readonly reason: string }>;

const GLOBAL_RULES_SQL =
  "SELECT rule_id, group_id, keyword, target_role_id, priority" +
  " FROM cos_dispatch_rules WHERE enabled = 1 AND group_id IS NULL" +
  " ORDER BY priority DESC, rule_id ASC";
const GROUP_RULES_SQL =
  "SELECT rule_id, group_id, keyword, target_role_id, priority" +
  " FROM cos_dispatch_rules WHERE enabled = 1 AND (group_id = ? OR group_id IS NULL)" +
  " ORDER BY priority DESC, (group_id IS NULL) ASC, rule_id ASC";
const CANDIDATES_SQL =
  "SELECT gm.member_id, m.name, gm.role_id, r.category, gm.seat," +
  " (SELECT COUNT(*) FROM member_executors me" +
  "  WHERE me.member_id = gm.member_id AND me.enabled = 1) AS enabled_executors" +
  " FROM group_members gm" +
  " JOIN members m ON m.member_id = gm.member_id" +
  " JOIN roles r ON r.role_id = gm.role_id" +
  " WHERE gm.group_id = ? AND m.status = 'active'" +
  " ORDER BY gm.member_id ASC";
const SKILLS_SQL =
  "SELECT ms.member_id, ms.skill_id, ms.name FROM member_skills ms" +
  " JOIN group_members gm ON gm.group_id = ? AND gm.member_id = ms.member_id" +
  " JOIN members m ON m.member_id = ms.member_id AND m.status = 'active'" +
  " ORDER BY ms.member_id ASC, ms.skill_id ASC";

/** 授权词只覆盖老板保留的钱、边界、战略三类，不因普通“预算”二字升级。 */
const AUTHORIZATION_CATEGORIES: readonly {
  readonly label: string;
  readonly terms: readonly string[];
}[] = [
  {
    label: "资金",
    terms: ["money", "budget", "spend", "采购", "花钱", "超预算"],
  },
  {
    label: "边界",
    terms: ["boundary", "改边界", "扩大范围", "缩小范围", "换技术栈"],
  },
  { label: "战略", terms: ["strategy", "战略", "发展方向"] },
];

function authorizationCategory(text: string): string | null {
  const lowered = text.toLowerCase();
  for (const category of AUTHORIZATION_CATEGORIES) {
    if (category.terms.some((term) => lowered.includes(term.toLowerCase()))) {
      return category.label;
    }
  }
  return null;
}

/** @老板→CoS 的升级判据：命中保留授权类目就要老板拍板。 */
export function needsBossDecision(text: string): boolean {
  return authorizationCategory(text) !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rowError(label: string, detail: string): Error {
  return new Error("dispatch/co：" + label + " 行形状坏 —— " + detail);
}

function readString(
  row: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    throw rowError(label, key + " 必须是非空字符串");
  }
  return value;
}

function readNullableString(
  row: Record<string, unknown>,
  key: string,
  label: string,
): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw rowError(label, key + " 必须是 null 或非空字符串");
  }
  return value;
}

function readInteger(
  row: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw rowError(label, key + " 必须是安全整数");
  }
  return value;
}

function queryRows(
  db: DbLike,
  sql: string,
  params: readonly SQLInputValue[],
): readonly unknown[] {
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const rows: readonly unknown[] = db.prepare(sql).all(...params);
  return rows;
}

function rowToRule(raw: unknown): DispatchRule {
  if (!isRecord(raw)) throw rowError("规则", "不是对象");
  const ruleId = readString(raw, "rule_id", "规则");
  return {
    ruleId,
    groupId: readNullableString(raw, "group_id", "规则 [" + ruleId + "]"),
    keyword: readString(raw, "keyword", "规则 [" + ruleId + "]"),
    targetRoleId: readString(raw, "target_role_id", "规则 [" + ruleId + "]"),
    priority: readInteger(raw, "priority", "规则 [" + ruleId + "]"),
  };
}

/** 不传 groupId 时只列全局启用规则；传入时包含本群规则，同优先级本群优先。 */
export function listDispatchRules(
  db: DbLike,
  groupId?: string,
): readonly DispatchRule[] {
  const sql = groupId === undefined ? GLOBAL_RULES_SQL : GROUP_RULES_SQL;
  const params: readonly SQLInputValue[] =
    groupId === undefined ? [] : [groupId];
  return queryRows(db, sql, params).map(rowToRule);
}

function rowToCandidate(raw: unknown): Omit<DispatchCandidate, "skills"> {
  if (!isRecord(raw)) throw rowError("候选", "不是对象");
  const memberId = readString(raw, "member_id", "候选");
  const seat = readString(raw, "seat", "候选 [" + memberId + "]");
  if (seat !== "cos" && seat !== "member") {
    throw rowError("候选 [" + memberId + "]", "seat 必须是 cos 或 member");
  }
  const enabledExecutors = readInteger(
    raw,
    "enabled_executors",
    "候选 [" + memberId + "]",
  );
  if (enabledExecutors < 0) {
    throw rowError("候选 [" + memberId + "]", "enabled_executors 不能为负");
  }
  return {
    memberId,
    name: readString(raw, "name", "候选 [" + memberId + "]"),
    roleId: readString(raw, "role_id", "候选 [" + memberId + "]"),
    roleCategory: readString(raw, "category", "候选 [" + memberId + "]"),
    seat,
    enabledExecutors,
  };
}

function loadCandidates(
  db: DbLike,
  groupId: string,
): readonly DispatchCandidate[] {
  const params: readonly SQLInputValue[] = [groupId];
  const skillsByMember = new Map<
    string,
    { readonly id: string; readonly name: string }[]
  >();
  for (const raw of queryRows(db, SKILLS_SQL, params)) {
    if (!isRecord(raw)) throw rowError("成员技能", "不是对象");
    const memberId = readString(raw, "member_id", "成员技能");
    const label = "成员技能 [" + memberId + "]";
    const skill = {
      id: readString(raw, "skill_id", label),
      name: readString(raw, "name", label),
    };
    const skills = skillsByMember.get(memberId);
    if (skills === undefined) skillsByMember.set(memberId, [skill]);
    else skills.push(skill);
  }
  return queryRows(db, CANDIDATES_SQL, params).map((raw) => {
    const candidate = rowToCandidate(raw);
    return {
      ...candidate,
      skills: skillsByMember.get(candidate.memberId) ?? [],
    };
  });
}

/** 优先级降序、本群优先、rule_id 升序；比较不依赖数据库或区域设置。 */
function compareRules(a: DispatchRule, b: DispatchRule): number {
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  const aGlobal = a.groupId === null;
  const bGlobal = b.groupId === null;
  if (aGlobal !== bGlobal) return aGlobal ? 1 : -1;
  if (a.ruleId === b.ruleId) return 0;
  return a.ruleId < b.ruleId ? -1 : 1;
}

function matchingRule(
  rules: readonly DispatchRule[],
  text: string,
): DispatchRule | null {
  const lowered = text.toLowerCase();
  let best: DispatchRule | null = null;
  for (const rule of rules) {
    if (!lowered.includes(rule.keyword.toLowerCase())) continue;
    if (best === null || compareRules(rule, best) < 0) best = rule;
  }
  return best;
}

/** 字面量提及计数：不做正则或通配符解释，同一技能的名字与 id 分别计数。 */
function literalMentionCount(text: string, term: string): number {
  if (term.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(term, from);
    if (at < 0) break;
    count += 1;
    from = at + term.length;
  }
  return count;
}

function skillMentionCount(
  candidate: DispatchCandidate,
  loweredText: string,
): number {
  let count = 0;
  for (const skill of candidate.skills) {
    count += literalMentionCount(loweredText, skill.name.toLowerCase());
    count += literalMentionCount(loweredText, skill.id.toLowerCase());
  }
  return count;
}

function compareCandidates(
  a: DispatchCandidate,
  b: DispatchCandidate,
  loweredText: string,
): number {
  const aMentions = skillMentionCount(a, loweredText);
  const bMentions = skillMentionCount(b, loweredText);
  if (aMentions !== bMentions) return aMentions > bMentions ? -1 : 1;
  if (a.enabledExecutors !== b.enabledExecutors) {
    return a.enabledExecutors > b.enabledExecutors ? -1 : 1;
  }
  if (a.memberId === b.memberId) return 0;
  return a.memberId < b.memberId ? -1 : 1;
}

function noPlan(
  reason: string,
  rule: DispatchRule | null = null,
): DispatchPlan {
  return {
    source: "none",
    needsBoss: false,
    targetMemberId: null,
    // 保留命中规则的坐标，便于解释“为何停住”；没有成员时绝不伪造落点。
    targetRoleId: rule?.targetRoleId ?? null,
    ruleId: rule?.ruleId ?? null,
    reason,
  };
}

function rulePlan(
  rule: DispatchRule,
  candidate: DispatchCandidate,
): DispatchPlan {
  return {
    source: "rule",
    needsBoss: false,
    targetMemberId: candidate.memberId,
    targetRoleId: rule.targetRoleId,
    ruleId: rule.ruleId,
    reason:
      "命中规则 [" +
      rule.ruleId +
      "]（关键词 [" +
      rule.keyword +
      "]），派给在职在席的 [" +
      candidate.name +
      "]（" +
      candidate.memberId +
      "，岗位 [" +
      rule.targetRoleId +
      "]）。",
  };
}

/** 同步规则规划；没有规则命中时明确返回 none，不偷偷调用模型。 */
export function planDispatch(db: DbLike, input: DispatchInput): DispatchPlan {
  const category = authorizationCategory(input.text);
  if (category !== null) {
    return {
      source: "escalate",
      needsBoss: true,
      targetMemberId: null,
      targetRoleId: null,
      ruleId: null,
      reason:
        "命中[" +
        category +
        "]授权类目：该决定超出成员职权，需要老板授权；CoS 升级给老板，不自动派发。",
    };
  }

  const candidates = loadCandidates(db, input.groupId);
  const rule = matchingRule(listDispatchRules(db, input.groupId), input.text);
  if (candidates.length === 0) {
    return noPlan(
      "群 [" +
        input.groupId +
        "] 没有活跃在席成员（no active seated member），无法派发。",
      rule,
    );
  }
  if (rule === null) {
    return noPlan("没有启用的本群或全局规则命中，未调用 LLM 兜底，未派发。");
  }

  const roleCandidates = candidates.filter(
    (candidate) => candidate.roleId === rule.targetRoleId,
  );
  if (roleCandidates.length === 0) {
    return noPlan(
      "规则 [" +
        rule.ruleId +
        "] 命中岗位 [" +
        rule.targetRoleId +
        "]，但本群没有该岗位的活跃在席成员，未派发。",
      rule,
    );
  }
  const loweredText = input.text.toLowerCase();
  let best = roleCandidates[0];
  for (const candidate of roleCandidates.slice(1)) {
    if (
      best === undefined ||
      compareCandidates(candidate, best, loweredText) < 0
    ) {
      best = candidate;
    }
  }
  if (best === undefined) {
    throw new Error(
      "dispatch/co：规则候选非空却没有最佳成员 —— 内部不变量被破坏。",
    );
  }
  return rulePlan(rule, best);
}

function validFallbackResult(
  value: unknown,
): { readonly memberId: string; readonly reason: string } | null {
  if (!isRecord(value)) return null;
  const memberId = value["memberId"];
  const reason = value["reason"];
  if (typeof memberId !== "string" || typeof reason !== "string") return null;
  return { memberId, reason };
}

/** 仅在无规则命中时调用 fallback；模型点不到在席候选一律拒收。 */
export async function planDispatchWithFallback(
  db: DbLike,
  input: DispatchInput,
  fallback: Fallback,
): Promise<DispatchPlan> {
  const category = authorizationCategory(input.text);
  if (category !== null) {
    return planDispatch(db, input);
  }

  const candidates = loadCandidates(db, input.groupId);
  const rule = matchingRule(listDispatchRules(db, input.groupId), input.text);
  if (candidates.length === 0) {
    return noPlan(
      "群 [" +
        input.groupId +
        "] 没有活跃在席成员（no active seated member），无法执行规则或 LLM 派发。",
      rule,
    );
  }
  if (rule !== null) {
    const roleCandidates = candidates.filter(
      (candidate) => candidate.roleId === rule.targetRoleId,
    );
    if (roleCandidates.length === 0) {
      return noPlan(
        "规则 [" +
          rule.ruleId +
          "] 命中岗位 [" +
          rule.targetRoleId +
          "]，但本群没有该岗位的活跃在席成员，未派发。",
        rule,
      );
    }
    const loweredText = input.text.toLowerCase();
    let best = roleCandidates[0];
    for (const candidate of roleCandidates.slice(1)) {
      if (
        best === undefined ||
        compareCandidates(candidate, best, loweredText) < 0
      ) {
        best = candidate;
      }
    }
    if (best === undefined) {
      throw new Error(
        "dispatch/co：规则候选非空却没有最佳成员 —— 内部不变量被破坏。",
      );
    }
    return rulePlan(rule, best);
  }

  const picked = validFallbackResult(
    await fallback({ groupId: input.groupId, text: input.text, candidates }),
  );
  if (picked === null) {
    return noPlan(
      "LLM 兜底返回的形状不合法（memberId/reason 必须是字符串），未派发。",
    );
  }
  const candidate = candidates.find(
    (item) => item.memberId === picked.memberId,
  );
  if (candidate === undefined) {
    return noPlan(
      "LLM 兜底返回的成员 [" +
        picked.memberId +
        "] 不在活跃在席候选内，拒绝派发。",
    );
  }
  return {
    source: "llm",
    needsBoss: false,
    targetMemberId: candidate.memberId,
    targetRoleId: candidate.roleId,
    ruleId: null,
    reason: picked.reason,
  };
}
