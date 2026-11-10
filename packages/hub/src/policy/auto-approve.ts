/**
 * 策略引擎自动审批（计划 Task 3.5，规格 §9.1 第二行「模式自动通过」+ §22.3 第二条标注）。
 *
 * ── 这个文件要解决的不是「审批少一点」，而是「自动的那一次事后能不能被追问」────
 * §9.1 三档里第一档（只读 ⇒ 自动放行）Task 1.5 已做，而它**不留审计**
 * （policyDecide 返回 auto_allow 就结束）。第二档原文是
 * 『过去 10 次类似决策均批准且该决策可逆 → 自动通过并**记录**「基于模式的自动批准」』，
 * 末尾还有一句『在**日报中可见且可追溯**，但不打扰 CEO』。
 * 两句合起来是本次的全部难点：打扰 CEO 那一环被省掉了，于是**审计与日报是唯一追责路径**。
 * 一次没人看过、也没人被告知的批准，如果记录里不带「凭什么」，它和一次越权在事后看不出区别。
 * 所以立场是：自动通过**必须比人工通过留下更多可判定信息**，因为它少了一个知情的人。
 * 每条前置条件的**实际取值**都进 payload，不只进我这份文档。
 *
 * ── 硬规则，各自挡住一种失效 ──────────────────────────────────────────
 *  R1 只读 + 证据包完整 + 门控通过 ⇒ 自动通过（计划 Task 3.5 规则原文）。
 *  R2 可逆 + 同类历史【全部】批准且够次数 ⇒ 自动通过（§9.1 第二行）。
 *  R3 **不可逆永不自动通过**（计划 Test 项原文，与 Task 1.5 的 fail-closed 同源）。
 *  R3 优先于 R1/R2，也优先于「前置条件全满足」：一条被判 irreversible 的动作，
 *  哪怕证据齐、门控过、历史一百次全批，这里照样 require_approval。
 *  理由与 engine.ts 文件头同一条：分类错一次的代价是「付了款、发了版、删了数据」，
 *  多拦一次的代价是「CEO 多点一次按钮」，差几个数量级。
 *  自动通过的门槛**不能**比人工更容易被错分类绕过 —— 而它恰恰是唯一没有
 *  任何人会当场看见那个错分类的场合。
 *
 * ── 条件缺失时【逐项点名】，不是回一句「转人工」───────────────────────
 * 产品理由：CEO 看到一张「需要人工」的卡片而不知道为什么，只能把整包证据重看一遍 ——
 * 那正是 §9 北极星指标（八成审批由规则决定）想省掉的成本，一句模糊的降级会把它
 * **加回来**（本来只缺一格，现在整包重看）。
 * 技术理由：missing 是「自动通过为什么没发生」唯一的机器可读出处，
 * 有了它才谈得上统计「本周有多少次差在证据包上」，那才是「该改岗位书还是改委派规则」的信号。
 *
 * ── 【本轮必须说清的缺口】R2 的历史在今天的库里读不出来 ────────────────
 * §9.1 那一档的输入是「过去 10 次**类似**决策」。类似要可比，可比要有指纹。实测：
 *   · CEO 决策落库的 payload 只有 { approvalId, resume }（http/real-deps.ts 那条
 *     appendAudit），**不带被批准的是什么动作**；
 *   · approvals 行里有 approval_type，所以「同类」的唯一弱口径是 approval_type ——
 *     而 approvals 在 src 里**一次 INSERT 都没有**（0013 §10.1 实测），连这个口径也没数据。
 * ⇒ 所以 R2 的历史由**调用方传入**（SimilarHistory），缺 ⇒ 前置条件不齐 ⇒ 转人工。
 * 本模块**不**「从库里猜一份历史」：猜出来的历史会让一次本该上人的审批自动通过，
 * 那不是分类错，是**证据凭空** —— R3 防的那类病的反面成因。
 * 同时本模块给每次自动批准写 action_fingerprint（sha256 前 16 位），
 * 它是让「同类」将来变得**可计算**的那块地基：新写入的自动批准从此自带可比身份。
 * countSimilarApprovals() 按 approval_type 读 approvals：今天的真库上恒返回 0，
 * **那是正确答案而不是缺陷**（库里确实一张卡片都没有）。
 *
 * ── 【谁调用它】生产调用方目前 0 条，而这是刻意的，不是漏接 ─────────────
 * 0011 §8 / 0012 §7 / 0013 §7 记了三次同一族缺陷（测试全绿而产物没接上），
 * 本篇是第四次，所以先说清为什么不硬接：今天唯一的运行期是 CLI 的桩图
 * （graph/company.ts），它的节点体只写状态边、**不执行任何动作**。
 * 在桩图里调一次 autoApprove，等于给每次 `hub run` 伪造若干条「策略引擎批准了某动作」
 * 的**不可删除**审计行（events 是 append-only，0001 那两个 RAISE 触发器）——
 * 那会把「自动批准可追溯」直接变成「审计里有一批从没发生过的事」。
 * 少一个生产者是可以接上的缺口；脏了的审计库删不掉。
 * 消费侧（回放标注 + 日报聚合）本轮已接上并有真 socket 覆盖：
 * 生产者到位那天标注立刻有数据 —— 反过来（只有生产者没有消费者）才是白写。
 * 这条由 auto-approve.test.ts 最后一节钉住：接线那天断言会红，逼着同时更新 0014。
 *
 * ── 与 applyDecision 复用的三条纪律（同一条判据，不是照抄形状）─────────
 *  ① 条件 UPDATE 先行、审计后写：抢不到（changes === 0）就【一条审计都不写】。
 *  ② 卡片决策与审计【同一事务】（§6.3）：入参是调用方的连接，本模块不自建事务。
 *  ③ actor 用 { system, policy-engine }：伪造 human/agent 身份是审计污染
 *     （auditedInvoke 对 ApprovalRequired 用的是同一条口径）。
 */

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { appendAudit } from "../events/recorder.js";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { type ActionDraft, matchForbidden, policyDecide } from "./engine.js";

/**
 * 自动批准的署名，同时用作 events.actor_id。
 *
 * 为什么不用 "hub"（recorder 的默认 actorId）：那样自动批准与普通系统事件
 * 在 actor 这一维上不可分，而 §22.3 第二条要的正是「这一条是自动批的」能一眼分出。
 */
export const AUTO_APPROVED_BY = "policy-engine";

/** 自动通过的两条规则。枚举而非自由文本：日报要按规则分组统计。 */
export const POLICY_AUTO_RULES = [
  "read_only_evidence_gate",
  "pattern_reversible",
] as const;
export type PolicyAutoRule = (typeof POLICY_AUTO_RULES)[number];

/**
 * §9.1 第二行的「过去 10 次」。写成常量而不是字面量，是为了让「改成 5 次」
 * 在 diff 里是一条【看得见的策略变更】（§4.4.3：放宽归 CEO）。
 */
export const PATTERN_MIN_APPROVALS = 10;

/** 日报单页最多列几条。聚合数（total / by_rule）不受它影响，见 readAutoApprovalReport。 */
export const MAX_REPORT_ITEMS = 200;

/**
 * 「同类」的指纹：角色 + 动作类别 + 动作描述，三段归一后 sha256 前 16 位。
 *
 * 为什么不直接按 kind 分组：kind 是调用方自报的粗类（read_repo / edit_file），
 * 一百个不同仓库的 read_repo 挤在一格里，「过去 10 次都批准」就退化成
 * 「这类动作我们一贯不看」—— 那正是 §9.1 用「类似」两个字要避免的意思。
 * 三段归一（trim + 小写 + 空白折叠）：同一句 detail 的两种空格写法不该被当成
 * 两种动作各攒 5 次历史（那样永远攒不到 10 次，且一声不响）。
 */
export function actionFingerprint(a: ActionDraft): string {
  const norm = (s: string | undefined): string =>
    (s ?? "").trim().toLowerCase().replace(/\s+/gu, " ");
  const joined = [norm(a.role_id), norm(a.kind), norm(a.detail)].join(" ");
  return createHash("sha256").update(joined, "utf8").digest("hex").slice(0, 16);
}

/** 调用方交来的同类历史。字段缺省 = 不知道，与 gates/evaluate.ts「判不了不放行」同立场。 */
export interface SimilarHistory {
  /** 同类且已批准的次数。 */
  readonly approvals?: number;
  /** 同类但被打回 / defer 的次数。> 0 ⇒ 模式断了（§9.1 原文是「均批准」）。 */
  readonly nonApprovals?: number;
}

export interface AutoApproveEvidence {
  /** 证据包完整性对账结论（EvidenceStore.verify 的 ok）。 */
  readonly ok?: boolean;
  /** 比对过的份数。给日报当证据强度用，不参与判定（判定只看 ok）。 */
  readonly checked?: number;
}

export interface AutoApproveGate {
  /** 门控是否通过（evaluateGate 的 decision === "pass"）。 */
  readonly passed?: boolean;
  /** 门控名。进审计，让「哪一闸放的」可追问。 */
  readonly gate?: string;
}

export interface AutoApproveInput {
  readonly action: ActionDraft;
  /** 岗位书黑名单（命中即禁：黑名单优先于自动通过）。 */
  readonly forbidden?: readonly string[];
  readonly evidence?: AutoApproveEvidence;
  readonly gate?: AutoApproveGate;
  readonly history?: SimilarHistory;
  /**
   * 这个动作对应的审批卡片 id（若有）。
   * 有 ⇒ recordAutoApproval 去条件认领那一行；没有 ⇒ 只写审计，
   * 并把 card.present = false 记进 payload（**让缺口出现在数据里而不是只在我文档里**）。
   */
  readonly approvalId?: string;
}

/** 缺哪一格。枚举：日报与统计要能按缺失原因分组（见文件头「逐项点名」）。 */
export const MISSING_REASONS = [
  "evidence_missing",
  "evidence_incomplete",
  "gate_missing",
  "gate_not_passed",
  "history_missing",
  "history_not_unanimous",
  "history_below_threshold",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];

export type BlockedBy =
  | "forbidden"
  | "policy_forbidden"
  | "irreversible"
  | "conditions_unmet";

/** 判定用到的三格事实。三个维度都进 payload，事后不必回头问调用方。 */
export type AutoApproveFacts = {
  readonly evidence: { ok?: boolean; checked?: number };
  readonly gate: { passed?: boolean; gate?: string };
  readonly history: { approvals?: number; nonApprovals?: number };
};

export type AutoApproveOutcome =
  | ({
      decision: "auto_approved";
      readonly rule: PolicyAutoRule;
      readonly tier: "read_only" | "reversible";
      readonly fingerprint: string;
    } & AutoApproveFacts)
  | ({
      decision: "require_approval";
      readonly tier: "read_only" | "reversible" | "irreversible";
      readonly fingerprint: string;
      /**
       * 为什么没自动通过。
       *  - "forbidden"：命中黑名单（engine.ts 的立场：黑名单优先于一切分级）。
       *  - "policy_forbidden"：policyDecide 判 forbidden（策略侧同一条）。
       *  - "irreversible"：R3，不可逆永不自动通过。
       *  - "conditions_unmet"：前置条件缺，逐项列在 missing。
       */
      readonly blocked_by: BlockedBy;
      readonly missing: readonly MissingReason[];
      readonly note: string;
    } & AutoApproveFacts);

const evi = (e?: AutoApproveEvidence): { ok?: boolean; checked?: number } => ({
  ...(e?.ok === undefined ? {} : { ok: e.ok }),
  ...(e?.checked === undefined ? {} : { checked: e.checked }),
});
const gat = (g?: AutoApproveGate): { passed?: boolean; gate?: string } => ({
  ...(g?.passed === undefined ? {} : { passed: g.passed }),
  ...(g?.gate === undefined ? {} : { gate: g.gate }),
});
const his = (h?: SimilarHistory): { approvals?: number; nonApprovals?: number } => ({
  ...(h?.approvals === undefined ? {} : { approvals: h.approvals }),
  ...(h?.nonApprovals === undefined ? {} : { nonApprovals: h.nonApprovals }),
});

/**
 * 判定。纯函数：不查库、不读时钟、不发消息。
 *
 * 顺序本身就是判据，调换会改语义：
 *   黑名单 → policyDecide（forbidden 与分级）→ R3 不可逆短路 → R1 → R2 → 条件未齐
 * R3 排在 R1/R2 之前，因为它是【否决】而不是【条件】：条件不满足是「证据不够」，
 * R3 是「这一类根本不自动批」。把两者混进同一个 missing 数组，日报里
 * 「不可逆被拦下」与「证据没交」就成了同一格，而前者是【设计在工作】。
 */
export function autoApprove(o: AutoApproveInput): AutoApproveOutcome {
  const a = o.action;
  const fingerprint = actionFingerprint(a);
  const facts: AutoApproveFacts = {
    evidence: evi(o.evidence),
    gate: gat(o.gate),
    history: his(o.history),
  };

  const forbiddenHit = matchForbidden(a, o.forbidden ?? []);
  if (forbiddenHit !== undefined) {
    return blocked(
      a,
      fingerprint,
      "forbidden",
      [],
      "命中岗位书黑名单 [" +
        forbiddenHit +
        "]。黑名单优先于自动通过：一条规则不能替角色绕过它自己岗位书里写着的禁令。",
      facts,
    );
  }

  const pd = policyDecide(a, { forbidden: o.forbidden ?? [] });
  if (pd.action === "forbidden") {
    return blocked(a, fingerprint, "policy_forbidden", [], pd.reason, facts);
  }
  const tier = pd.tier;
  if (tier === "irreversible") {
    return blocked(
      a,
      fingerprint,
      "irreversible",
      [],
      "不可逆动作永不自动通过（计划 Task 3.5 Test 项 / 规格 §9.1「必须人工」）。" +
        "本模块不接受任何前置条件组合把它变成自动通过，包括「证据齐 + 门控过 + 历史全批」。",
      facts,
    );
  }

  // R1：只读 + 证据包完整 + 门控通过。
  if (tier === "read_only") {
    const missing: MissingReason[] = [];
    if (o.evidence?.ok === undefined) missing.push("evidence_missing");
    else if (o.evidence.ok !== true) missing.push("evidence_incomplete");
    if (o.gate?.passed === undefined) missing.push("gate_missing");
    else if (o.gate.passed !== true) missing.push("gate_not_passed");
    if (missing.length === 0) {
      return {
        decision: "auto_approved",
        rule: "read_only_evidence_gate",
        tier,
        fingerprint,
        ...facts,
      };
    }
    return blocked(
      a,
      fingerprint,
      "conditions_unmet",
      missing,
      "只读动作，但自动通过的客观前置不齐（缺：" + missing.join(", ") + "）。",
      facts,
    );
  }

  // R2：可逆 + 同类历史全部批准且够次数。§9.1 那一行【不】要求证据与门控，
  // 所以这里不加额外要求 —— 加严是我自己的偏好，而 §4.4.3 把收紧/放宽归 CEO。
  const approvals = o.history?.approvals;
  const nonApprovals = o.history?.nonApprovals;
  const missing: MissingReason[] = [];
  if (approvals === undefined || nonApprovals === undefined) missing.push("history_missing");
  else if (nonApprovals > 0) missing.push("history_not_unanimous");
  else if (approvals < PATTERN_MIN_APPROVALS) missing.push("history_below_threshold");
  if (missing.length === 0) {
    return {
      decision: "auto_approved",
      rule: "pattern_reversible",
      tier,
      fingerprint,
      ...facts,
    };
  }
  return blocked(
    a,
    fingerprint,
    "conditions_unmet",
    missing,
    "可逆动作，但『过去 " +
      PATTERN_MIN_APPROVALS +
      " 次同类决策均批准』这条模式不成立（缺：" +
      missing.join(", ") +
      "）。",
    facts,
  );
}

function blocked(
  a: ActionDraft,
  fingerprint: string,
  blocked_by: BlockedBy,
  missing: readonly MissingReason[],
  note: string,
  facts: AutoApproveFacts,
): AutoApproveOutcome {
  return {
    decision: "require_approval",
    tier: policyDecide(a, { forbidden: [] }).tier,
    fingerprint,
    blocked_by,
    missing,
    note,
    ...facts,
  };
}

// ─────────────────────────── 写入侧 ───────────────────────────

/**
 * 认领那张卡片：形状与 http/real-deps.ts 的 CLAIM_APPROVAL_SQL 一致
 * （同一条 `WHERE ... AND status = 'pending'` 的条件写），但**不 import 那个常量**。
 *
 * 为什么不复用：那条 SQL 的 decided_by 写的是 CEO_ACTOR.actorId（"ceo"）。
 * 自动批准把 "ceo" 写进 decided_by 就是【伪造人的签名】—— 而 decided_by 这一列
 * 在审计里的意思是「谁」，它正是「这条是人批的还是规则批的」的唯一列级出处。
 * 两条 SQL 形状一致这件事由用例保证（都断言 status = 'pending' 这一半），不靠注释。
 */
export const CLAIM_APPROVAL_FOR_AUTO_SQL =
  "UPDATE approvals SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? " +
  "WHERE id = ? AND status = 'pending'";

export interface RecordAutoApprovalInput {
  readonly taskId: string | null;
  readonly outcome: AutoApproveOutcome;
  /** 有卡片才认领；没有也照样写审计，并在 payload 里如实标 card.present = false。 */
  readonly approvalId?: string;
  readonly nowMs: number;
}

export interface RecordedAutoApproval {
  /** events.id = 总线 seq（调用方拿它去 publishPersisted）。 */
  readonly seq: number;
  /** 卡片那一行有没有被本次改动。false 的两种成因见 payload.card 的注释。 */
  readonly card_claimed: boolean;
  readonly payload: Record<string, unknown>;
}

/**
 * 写那一行审计（以及可选的卡片认领）。
 *
 * ⚠ 只接受 decision === "auto_approved"；require_approval 传进来【抛错】。
 * 为什么抛而不是忽略：忽略会让「每次降级都悄悄署了策略引擎的名」成为可能，
 * 那是一条 append-only 的伪证（events 上那两个 RAISE 触发器使它删不掉）。
 * 判据在代码里，不在注释里。
 *
 * 事务归属在调用方：入参是一条连接（超步内就是 requireScopeDb 拿到的那条）。
 * 卡片认领与审计必须同事务 —— §6.3 同一条理由：卡片已批而审计没有，
 * 是回放对不上账时【唯一查不出来】的那种半套状态。
 *
 * 返回 seq 而不是自己 publish：广播时机必须在【提交之后】
 * （recorder.#flush 与 applyDecision 用的是同一个时机；在事务里发会得到
 * 「前端收到卡片已批、此刻库里那行还没 COMMIT」）。
 */
export function recordAutoApproval(
  db: DatabaseSync,
  o: RecordAutoApprovalInput,
): RecordedAutoApproval {
  const out = o.outcome;
  if (out.decision !== "auto_approved") {
    const why =
      out.decision === "require_approval" ? out.blocked_by : "（未知判定）";
    throw new Error(
      "recordAutoApproval 只接受 auto_approved 的判定（实到 " +
        out.decision +
        "，blocked_by=" +
        why +
        "）。降级为人工审批属于人工那一路，不该署策略引擎的名 —— " +
        "署了就在审计里把一次【没有发生的批准】写成了规则批准的既成事实。",
    );
  }

  let cardClaimed = false;
  if (o.approvalId !== undefined) {
    const note =
      "基于模式的自动批准（规则 " + out.rule + "，署名 " + AUTO_APPROVED_BY + "）";
    const sql = CLAIM_APPROVAL_FOR_AUTO_SQL;
    const params: unknown[] = [
      "approved",
      AUTO_APPROVED_BY,
      o.nowMs,
      note,
      o.approvalId,
    ];
    assertSingleStatement(sql);
    assertParamCount(sql, params);
    const info = db.prepare(sql).run(...(params as never[])) as {
      changes: number | bigint;
    };
    // changes === 0 的两种成因都不是错误，但都必须【留痕】而不是静默：
    //   ① 那一行不存在（今天的真库就是这种：src 里没有任何 INSERT INTO approvals）；
    //   ② 已被人工或并发那一路抢先改掉。
    // 静默的后果是「审计说批了，卡片还在 pending」，那是收件箱计数恒不对的直接来源。
    cardClaimed = Number(info.changes) !== 0;
  }

  const payload: Record<string, unknown> = {
    // auto_approved_by 是计划 Test 项点名的字段名（原文「含 auto_approved_by」）。
    // 它落在 payload 而不是新加一列：events 的 DDL 由 0004 的迁移机械取自规格附录 C，
    // 加一列等于改规格附录（0004 §迁移口径），而 payload 是规格留出的扩展位。
    auto_approved_by: AUTO_APPROVED_BY,
    annotation: "基于模式的自动批准",
    rule: out.rule,
    tier: out.tier,
    action_fingerprint: out.fingerprint,
    evidence: out.evidence,
    gate: out.gate,
    history: out.history,
    card: { present: o.approvalId !== undefined, claimed: cardClaimed },
  };

  const seq = appendAudit(
    db,
    {
      taskId: o.taskId,
      // system 而不是 human/agent：没有人做过这个动作，是规则做的。
      // 伪造身份是审计污染（见文件头纪律 ③）。
      actorType: "system",
      actorId: AUTO_APPROVED_BY,
      // action = 'approval'：§22.1 那张枚举表里没有「自动批准」这一档，
      // 而 approval 的语义（对一件事做了同意与否的决定）覆盖它。
      // 区分自动与人工靠 actor_id + payload.auto_approved_by，不靠新开一个 action 值 ——
      // 新开值会让所有按 action='approval' 统计的报表（收件箱计数、日报）当场少一批。
      action: "approval",
      // target 与人工那一路同一个口径（卡片 id），这样「被要求批准」/「被批掉」/
      // 「被自动批掉」三类事件能在 target 上 join 起来（recorder.targetOf 同一条理由）。
      // 没有卡片时退化成动作指纹：宁可 target 粗一点，也不要 null ——
      // target 为 null 的行无法问责（recorder.eventParams 对 actor_id 空串同一条立场）。
      target: o.approvalId ?? "action:" + out.fingerprint,
      payload,
      createdAt: o.nowMs,
    },
    () => o.nowMs,
  );
  return { seq, card_claimed: cardClaimed, payload };
}

// ─────────────────────────── 读取侧 ───────────────────────────

/**
 * 日报：规格 §9.1 末句『在日报中可见且可追溯』里【可追溯】那一半的落点。
 *
 * 【日报本身不是本模块能做的】：整份日报是一个 UI / 推送面，计划里没有任何任务
 * 立它（grep '日报' 在计划里只有 Task 3.5 这一处，在规格里两行）。
 * 所以我做的是【那一格数据】：给定一天，返回当天所有自动批准 + 按规则分组计数。
 * 有了它，将来那个日报页面是一次渲染而不是重新发明口径 —— 而口径（什么算一天、
 * 什么算自动批准）只能有一处，否则「按规则分组的次数」会出现两个答案。
 *
 * 日期边界用【UTC 日】：created_at 存的是毫秒 epoch。用本地时区会让同一份库
 * 在两台机器上给出不同的「今天」，而日报的数字必须只有一个答案。
 * 时区展示是渲染层的事（它知道 CEO 在哪），归属判定不是。
 */
export interface AutoApprovalReportRow {
  readonly seq: number;
  readonly task_id: string | null;
  readonly created_at: number;
  readonly rule: string;
  readonly tier: string;
  readonly action_fingerprint: string;
  readonly approval_id: string | null;
  readonly card_claimed: boolean;
}

export interface AutoApprovalReport {
  /** 该 UTC 日，形如 2026-01-02。 */
  readonly day: string;
  /** 【当天自动批准的总次数】，不受 limit 影响 —— 这一格是「总数」的唯一出处。 */
  readonly total: number;
  readonly by_rule: Record<string, number>;
  /** 其中卡片那一行没被改动的次数（> 0 就值得看：审计说批了而卡片还在 pending）。 */
  readonly card_unclaimed: number;
  readonly items: AutoApprovalReportRow[];
  /** 是否还有后面的行。同 0013 §5-④ 那条：分母由服务端给，不让调用方按自己传的 limit 猜。 */
  readonly has_more: boolean;
}

/**
 * 一条 SQL 同时取明细与 total：靠窗口函数，避免两条查询之间的时间差给出矛盾的两数。
 * （两条查询之间那一次写入，会让「total = 7」配上一份 8 行的明细，或反过来 ——
 * 而日报的总数与明细自相矛盾时，读的人无从判断哪一半是真的。）
 * target 也在选择列里：approval_id 那一格由它反推（见 readAutoApprovalReport 内注释）。
 */
const AUTO_APPROVAL_REPORT_SQL =
  "SELECT id, task_id, target, created_at, payload, " +
  "COUNT(*) OVER () AS total_rows, " +
  "SUM(CASE WHEN json_extract(payload, '$.card.claimed') = 1 THEN 0 ELSE 1 END) OVER () AS unclaimed_rows " +
  "FROM events WHERE action = 'approval' " +
  "AND json_extract(payload, '$.auto_approved_by') IS NOT NULL " +
  "AND date(created_at / 1000, 'unixepoch') = ? " +
  "ORDER BY id ASC LIMIT ? OFFSET ?";

/**
 * 当天有没有 payload 解不开的 events 行。
 *
 * 这一发必须先跑，不能靠「解析时 try/catch」。原因是实测到的一条 SQL 事实：
 * json_extract 对畸形 payload 是【抛错】而不是返回 NULL
 * （`json_extract(payload,'$.x')` on `{not json` ⇒ Error: malformed JSON）。
 * 于是那一发日报查询会被**同一时间窗里一条毫不相干的行**炸掉 ——
 * 比如一条 action='state_change' 的坏行，它根本不会进结果集，
 * 但 WHERE 里的 json_extract 照样对它求值。症状是「日报整页打不开」，
 * 而报错里既没有那条行的 id 也没有它的 action，等于把一次【数据事故】
 * 伪装成一次【功能故障】—— 与 evidence/store.ts 里那条「把安全问题伪装成数据问题」
 * 是同族：症状指向错误的方向，人会去修没坏的那一半。
 * 所以：先点名，再出数。
 */
const MALFORMED_PAYLOAD_PROBE_SQL =
  "SELECT id, action FROM events " +
  "WHERE date(created_at / 1000, 'unixepoch') = ? AND json_valid(payload) = 0 " +
  "ORDER BY id ASC LIMIT ?";

/**
 * 该 UTC 日的自动批准清单。
 *
 * 为什么用 json_extract 而不是 LIKE：LIKE '%"auto_approved_by"%' 会命中
 * 【任何提到这个词的 payload】—— 包括一条写了「auto_approved_by 不可用」的报错审计，
 * 也包括未来某个 payload 里恰好带这几个字的普通事件。实测同一份夹具：
 * LIKE 给 6、json_extract 给 5，多出来那条正是【只是提到了那个字段名】的假样本。
 * 日报要把次数报给 CEO，而假样本的代价与 0013 §2-① 同构：**给出错的行比给不出结果更坏**，
 * 后者只会让人换个条件再查一次。
 * 本机 SQLite 3.51.2 支持 json_extract / json_valid / date(…,'unixepoch')
 * 与窗口函数（0004 文件头那条「上线前须用同样用例重跑」同样适用于这几个函数）。
 *
 * 窗口函数 COUNT(*) OVER () 实测在 LIMIT 之前求值（LIMIT 1 时 total_rows 仍是 5），
 * 所以「当天总数」与「这一页明细」确实同源于一次查询，不会因两次查询之间的写入而互相矛盾。
 */
export function readAutoApprovalReport(
  db: DatabaseSync,
  o: { readonly day: string; readonly limit?: number; readonly offset?: number },
): AutoApprovalReport {
  const limit = Math.min(o.limit ?? MAX_REPORT_ITEMS, MAX_REPORT_ITEMS);
  const offset = o.offset ?? 0;

  const probeSql = MALFORMED_PAYLOAD_PROBE_SQL;
  const probeParams: unknown[] = [o.day, 10];
  assertSingleStatement(probeSql);
  assertParamCount(probeSql, probeParams);
  const bad = db.prepare(probeSql).all(...(probeParams as never[])) as Array<
    Record<string, unknown>
  >;
  if (bad.length > 0) {
    const listed = bad.map((r) => "id=" + String(r["id"]) + "(" + String(r["action"]) + ")").join(", ");
    throw new Error(
      "自动批准日报拒绝出数：' " +
        o.day +
        "' 这一天有 " +
        bad.length +
        (bad.length >= 10 ? "（含）以上" : "") +
        " 条 events 的 payload 不是合法 JSON：" +
        listed +
        "。appendAudit 只会写合法 JSON，所以这些行是【库被外部改过】的痕迹。" +
        "宁可不出数：跳行会让总数与明细自相矛盾，而读的人无从判断哪一半是真的。",
    );
  }

  const sql = AUTO_APPROVAL_REPORT_SQL;
  const params: unknown[] = [o.day, limit, offset];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const rows = db.prepare(sql).all(...(params as never[])) as Array<
    Record<string, unknown>
  >;

  const items: AutoApprovalReportRow[] = [];
  const byRule: Record<string, number> = {};
  let total = 0;
  let unclaimed = 0;
  for (const r of rows) {
    total = Number(r["total_rows"] ?? 0);
    unclaimed = Number(r["unclaimed_rows"] ?? 0);
    const parsed: unknown = JSON.parse(String(r["payload"]));
    // 上面那一发探针已经保证解得开，所以这里解不开只剩一种成因：payload 是合法
    // JSON 而【不是对象】（比如裸字符串或数字）。json_extract 对它返回 NULL，
    // 于是那一行根本不会进结果集 —— 走到这里说明 SQL 与这段代码对形状的假设分叉了，
    // 是一次真事故，抛错并点名。
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        "自动批准日报：events.id=" +
          String(r["id"]) +
          " 的 payload 是合法 JSON 但不是对象。日报无法给它归类，拒绝出数。",
      );
    }
    const p = parsed as Record<string, unknown>;
    const rule = String(p["rule"] ?? "");
    byRule[rule] = (byRule[rule] ?? 0) + 1;
    const card = (p["card"] ?? {}) as Record<string, unknown>;
    items.push({
      seq: Number(r["id"]),
      task_id: (r["task_id"] as string | null) ?? null,
      created_at: Number(r["created_at"]),
      rule,
      tier: String(p["tier"] ?? ""),
      action_fingerprint: String(p["action_fingerprint"] ?? ""),
      approval_id:
        r["target"] !== null && String(r["target"]).startsWith("action:")
          ? null
          : (r["target"] as string | null),
      card_claimed: card["claimed"] === true,
    });
  }
  // 窗口函数在【零行】时不给任何行，于是 total 无从取。0 在这里是查出来的结论
  // （那一发查询确实扫过了那一天），不是缺省值 —— 两者的区别在 has_more 上：
  // 缺省值会让人以为「还有更多」，而事实是「那天一条都没有」。
  return {
    day: o.day,
    total: rows.length === 0 ? 0 : total,
    by_rule: byRule,
    card_unclaimed: rows.length === 0 ? 0 : unclaimed,
    items,
    has_more: offset + items.length < (rows.length === 0 ? 0 : total),
  };
}

/**
 * 按 approval_type 数同类历史 —— R2 要的那个输入的【唯一可计算来源】。
 *
 * 今天它在真库上恒返回 { approvals: 0, nonApprovals: 0 }，因为 src 里没有任何
 * 代码创建 approvals 行（0013 §10.1）。**这是正确答案，不是待修的缺陷**：
 * 库里确实一张卡片都没有。所以调用方拿到 0 之后 autoApprove 会判
 * history_missing / history_below_threshold ⇒ 转人工。方向是 fail-closed 的：
 * 「没有历史」与「历史全是打回」在这里给出同一个结论，而两个都不该自动通过。
 *
 * 【口径的诚实边界】：approval_type 只有五个粗值（charter / strategic /
 * irreversible_action / budget_override / meeting_escalation），
 * 用它当「同类」比 §9.1 那句「类似决策」粗得多 —— 两次 budget_override 批准
 * 会被算成同类，哪怕金额差一百倍。真正按 action_fingerprint 统计需要
 * approvals 表带上动作指纹，那属 0013 §10 等 CEO 的那一项，不由实现层顺手加列。
 */
export function countSimilarApprovals(
  db: DatabaseSync,
  o: { readonly approvalType: string },
): Required<SimilarHistory> {
  const sql =
    "SELECT SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_rows, " +
    "SUM(CASE WHEN status IN ('rejected', 'deferred') THEN 1 ELSE 0 END) AS refused_rows " +
    "FROM approvals WHERE approval_type = ?";
  const params: unknown[] = [o.approvalType];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const r = db.prepare(sql).get(...(params as never[])) as
    | Record<string, unknown>
    | undefined;
  // 空表时 SUM 返回 NULL 而不是 0（与 org/commit.ts 那条 MAX(version) 同一族）。
  // 这里把它落成 0 是对的：那一发查询确实扫过了那张表，0 是【查出来的】。
  return {
    approvals: Number(r?.["approved_rows"] ?? 0),
    nonApprovals: Number(r?.["refused_rows"] ?? 0),
  };
}
