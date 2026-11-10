/**
 * Task 3.8 验收：Phase 3 出口门禁（规格 §23.1 那一行的两条）。
 *
 * 原文两条：
 *  ① 修改岗位书验收标准后**重跑同类任务**，门控行为按新标准变化；
 *  ② 自动通过的决策在日报**可见且可追溯**。
 *
 * ── 与 packages/hub/test/charter/store.test.ts ③ 节的分工（不写重复劳动）──────
 * 那一节已经证过「改 acceptance_criteria ⇒ evaluateGate 的 decision 翻转」，
 * 但它的产出包是**手搓的字面量**、`integrityOk` 是**手写的 true**（那一节四处
 * `integrityOk: true` 传的都是字面量）。这在单元测试的尺度上没问题（它判的是
 * 「criteria 从哪来」
 * 这一维，而且它文件头自己就写明了这一点），放到**验收**尺度上就漏了：
 * `integrityOk: true` 是一个调用方给的值。phase1 那一轮已经为这个形状付过账 ——
 * `packages/hub/test/acceptance/phase1-gates.test.ts` 里有一条「文件被改过一个字节
 * ⇒ reject」用的就是真 `store.verify(...).ok`。所以本文件的 ① 段换成：
 *  **真 WriteQueue + 真迁移 + 真岗位书 + 真制品落盘 + 完整性由 EvidenceStore 判**。
 * 少任何一件，「门控行为按新标准变化」这句话都可能是在一份**根本不合法的产出**上成立的
 * （phase1 §夹具注释原话：「夹具假装具备的性质恰好是用例要证的性质」）。
 *
 * ── ② 段证的是【两个模块合起来】才成立的那件事 ─────────────────────────
 * 日报侧（policy/auto-approve.ts 的 readAutoApprovalReport）与检索侧
 * （replay/search.ts 的 searchEvents）各自都有自己的测试文件（前者在其 ⑥/⑧ 节、
 * 后者在 test/replay/search.test.ts），各自全绿。而「可追溯」的含义是：
 * **同一条自动批准，既能被日报数到，也能被人搜出来**。
 * 这两半之间有 events_fts 触发器、trigram 分词、payload 形状三处接缝，任何一处断了，
 * 两侧的单测**都不会红**。这正是本文件存在的理由（同 phase1 文件头记的那次事故：
 * 门控与 escalation 两边各自都「对」，拼起来两条验收同时失效而无单测变红）。
 *
 * ── 本文件【不判】的，写在 ④ 段并钉成断言，而不是藏在注释里 ─────────────
 * ① 的「重跑同类任务」这一半今天**判不了**：`evaluateGate` 在 src 里零调用方
 * （实测，④ 段把它写成断言）。② 的「在日报可见」同理 —— 日报的**数据面**有
 * （readAutoApprovalReport），**日报本身**没有（计划 58 个任务里没有立它，
 * auto-approve.ts 文件头那段 grep 记录就是这件事的出处）。
 * 所以这个文件报的是「两条各自可测的那一半通过、不可测的那一半登记」，
 * 而不是「Phase 3 门禁通过」。后者还需要 `pnpm verify` 全绿（本机跑不了，0009 §2）。
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharterInput, EvidenceBundle } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  gateCriteriaForRole,
  gateCriteriaForRoleAtVersion,
  saveCharterVersion,
} from "../../src/charter/store.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import { migrate } from "../../src/db/migrate.js";
import { evaluateGate } from "../../src/graph/gates/evaluate.js";
import {
  canEscalateFrom,
  decideEscalation,
} from "../../src/graph/routing/escalation.js";
import { EvidenceStore } from "../../src/evidence/store.js";
import {
  AUTO_APPROVED_BY,
  autoApprove,
  recordAutoApproval,
  readAutoApprovalReport,
  type AutoApproveInput,
} from "../../src/policy/auto-approve.js";
import { searchEvents } from "../../src/replay/search.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HUB = join(HERE, "..", "..");
const SRC = join(HUB, "src");
const TMP = join(HUB, ".tmp", "acceptance3");

/** 固定在 2026-01-02（UTC）。日报的「哪一天」用 UTC 日划界（auto-approve.ts 文件头）。 */
const NOW = Date.UTC(2026, 0, 2, 5);
const DAY = "2026-01-02";

type Row = Record<string, unknown>;
type AnyDb = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Row[];
    get: (...a: unknown[]) => Row | undefined;
    run: (...a: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
  close: () => void;
};

const queues: WriteQueue[] = [];
const plain: AnyDb[] = [];
let fileSeq = 0;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  // Windows：不 close 就 rm 会 EBUSY（phase1 同一处理）。
  for (const q of queues) {
    try {
      q.close();
    } catch {
      /* 已关 */
    }
  }
  for (const db of plain) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/* ═══════════════════ ① 改验收标准 ⇒ 门控结论变化（真链路） ═══════════════════ */

/**
 * 一份能过 charterSchema 的最小草案。
 *
 * 与 store.test.ts 那个同名夹具的**唯一实质区别**是刻意的：condition 仍然是
 * 「明显是假数据的条件串」（不得替 CEO 填验收标准，见 0008 §7 —— 七份模板里现在还写着
 * `CEO-PLACEHOLDER-ACCEPTANCE`，拿它们当夹具等于替他填），但这里的产物要过
 * **真 EvidenceStore 的对账**，所以制品与 metrics 不再手写（见 realBundle）。
 */
const draft = (over: Partial<CharterInput> = {}): CharterInput => ({
  role_id: "dev",
  display_name: "开发",
  version: 1,
  honesty_boundaries: ["不谎报测试结果"],
  // ⚠ condition 写的是【不合格的情形】，配 reject 读作「成立即拒」（0008 §7.3 末段）。
  // 0015 §7 记着在这格上错过的那次：`metric:coverage >= 80` + reject 表达的是
  // 「覆盖率好就拒」，全绿而门控从不拦任何东西。这里写 < 80。
  acceptance_criteria: [
    { condition: "metric:coverage < 80", action: "reject", message: "覆盖率不足 80" },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: { type: "strict_rules", strict_rules: [], bounded_judgment: [], full_discretion: [] },
  escalation_triggers: [],
  ...over,
});

let bundleSeq = 0;
/** 每个包一个独立 UUID：同 bundle_id 不同内容会被 writeArtifact 抛掉（那是身份污染）。 */
const nextBundleId = (): string => {
  const h = (++bundleSeq).toString(16).padStart(32, "0");
  return (
    h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) +
    "-8" + h.slice(17, 20) + "-" + h.slice(20, 32)
  );
};

/**
 * 真制品 + 真对账的产出包。
 *
 * 三件事缺一不可，每件各挡一种假绿：
 *  - `store.writeArtifact` 真落盘 ⇒ 挡「artifact.path 是个随便写的字符串」。那种夹具
 *    verify 会给 missing，而**手写 integrityOk: true** 会把它盖掉 —— 正是本段要消灭的形状；
 *  - `sha256` / `bytes` 取自写入结果 ⇒ 挡「哈希写 64 个 a」这种恒不匹配的夹具
 *    （它会永远 reject，于是「改标准 ⇒ 结论翻转」只在**永远 reject** 的实现下也成立）；
 *  - `evidence_refs` 指回**同一个** declared 路径 ⇒ 挡 0015 §7 那个 `evidence_refs: [0]`
 *    的形状（ref 必须是字符串路径，见 store.test.ts:115 那条实测记录）。
 */
function realBundle(
  store: EvidenceStore,
  metrics: Record<string, number>,
): { bundle: EvidenceBundle; integrity: boolean } {
  const id = nextBundleId();
  const w = store.writeArtifact(
    { task_id: "T-1", bundle_type: "code_diff", bundle_id: id },
    "diff",
    "coverage " + String(metrics["coverage"] ?? -1) + "\n",
  );
  const bundle = {
    bundle_id: id,
    task_id: "T-1",
    bundle_type: "code_diff",
    produced_by_role: "dev",
    produced_by_model_family: "claude",
    artifacts: [{ path: w.declared, sha256: w.sha256, bytes: w.bytes }],
    claims: [{ text: "覆盖率达标", evidence_refs: [w.declared] }],
    honesty_boundaries: [],
    metrics,
  } as unknown as EvidenceBundle;
  return { bundle, integrity: store.verify(bundle).ok };
}

const gateFor = (
  bundle: EvidenceBundle,
  integrityOk: boolean,
  criteria: ReturnType<typeof gateCriteriaForRole>,
) =>
  evaluateGate({
    gate: "dev_to_test",
    producer: { roleId: "dev", modelFamily: "claude" },
    // 审阅方必须是**另一个**角色：evaluateGate 第 3 步对「审阅者 = 产出者」直接 escalate
    // （§8.2 作者不给自己打分）。写错这一格，下面所有 pass/reject 都会变成 escalate，
    // 而 escalate ≠ pass ⇒ 全红，反而不会误判成绿。写对它是为了让**标准**成为唯一变量。
    reviewer: { roleId: "test", modelFamily: "gpt" },
    bundle,
    integrityOk,
    criteria,
  });

async function newCharterRun(): Promise<{ q: WriteQueue; db: AnyDb; store: EvidenceStore }> {
  const { openDb } = await import("../../src/db/driver.js");
  const path = join(TMP, "ch-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path) as WriteQueue;
  queues.push(q);
  const db = (q as unknown as { writeConnection: () => AnyDb }).writeConnection();
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1', 'Phase 3 验收用的任务', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(NOW, NOW);
  const store = new EvidenceStore({
    root: join(TMP, "artifacts-" + fileSeq),
    exec: (sql, params) => {
      db.prepare(sql).run(...(params as readonly unknown[]));
    },
    now: () => NOW,
  });
  return { q, db, store };
}

describe("① 改岗位书验收标准 ⇒ 门控结论变化（规格 §23.1 Phase 3 第一条）", () => {
  it("同一份【完整性真通过】的产出：阈值 80 时 pass，CEO 抬到 95 之后 reject", async () => {
    const { q, db, store } = await newCharterRun();

    const v1 = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft(),
      nowMs: NOW,
      changeSummary: "第一版：覆盖率阈值 80",
    });
    expect(v1.ok).toBe(true);

    const run = await realBundle(store, { coverage: 90 });
    // 这一发是整段的**地基**：完整性必须由 EvidenceStore 真判出 true。
    // 手写 integrityOk: true 的话，下面两次 evaluateGate 都在一份「其实对不上账」的产出上跑，
    // pass/reject 的差别仍然只来自 criteria —— 用例照绿，而「真产出的门控行为」这件事
    // 从未被验证。传的是 run.integrity（一个算出来的值）而不是 true，这一发才有内容。
    expect(run.integrity).toBe(true);

    const before = gateFor(run.bundle, run.integrity, gateCriteriaForRole(db as never, "dev"));
    expect(before.decision).toBe("pass");
    // pass 那一支的 unresolved 必须是空数组：非空的 pass 在本仓的口径里不存在
    // （evaluateGate 末尾「有标准没判成 ⇒ escalate」那一段）。少了这一发，
    // 「靠 unresolved 放行」的坏实现也能让上一条绿 —— 而那正是被修掉的那个洞。
    if (before.decision === "pass") expect(before.unresolved).toEqual([]);

    // CEO 抬阈值到 95 —— **产出一个字节都没动**（同一个 bundle 对象、同一个 integrity 值）。
    const v2 = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({
        acceptance_criteria: [
          { condition: "metric:coverage < 95", action: "reject", message: "覆盖率不足 95" },
        ],
      }),
      nowMs: NOW + 1,
      changeSummary: "把覆盖率抬到 95",
    });
    expect(v2.ok).toBe(true);

    const after = gateFor(run.bundle, run.integrity, gateCriteriaForRole(db as never, "dev"));
    expect(after.decision).toBe("reject");
    if (after.decision === "reject") {
      // 拒的理由必须是**那条新标准**，不是别的。
      // ⚠ 只断言 decision 是空的：`reject` 有五种成因（空标准 / 包类型不对 /
      // 主张引用不到制品 / 完整性 / 业务标准），只判结论的那条在**任何** reject 前都绿。
      expect(after.reasons).toEqual(["覆盖率不足 95"]);
      expect(after.required_fixes).toEqual(["metric:coverage < 95"]);
    }

    /*
     * 反向对照，两发，各挡一种「怎么坏都不红」：
     *  ① 同一份**新**标准 + 达标的产出 ⇒ 必须又 pass。
     *     少了它，「改完标准就永远 reject」的实现也能让上面两条绿。
     *  ② 旧版本岗位书（回放语义）⇒ 仍然 pass。
     *     少了它，「就地 UPDATE 掉那一版」的实现也能让整段绿 —— 而那种实现下
     *     「当时按哪版验收」永久消失。store.test.ts ② 节钉的是**存储层不覆盖旧行**，
     *     这一发钉的是**门控读得到旧版的标准**：两件事、两处都可能坏。
     *     用的是仓里那个 gateCriteriaForRoleAtVersion 而不是自己 parse ——
     *     自己 parse 会把「那个函数坏了」这一整类失效变成测不到的东西。
     */
    const passAgain = gateFor(
      (await realBundle(store, { coverage: 99 })).bundle,
      true,
      gateCriteriaForRole(db as never, "dev"),
    );
    expect(passAgain.decision).toBe("pass");

    const v1Again = await realBundle(store, { coverage: 90 });
    const replayV1 = gateFor(
      v1Again.bundle,
      v1Again.integrity,
      gateCriteriaForRoleAtVersion(db as never, "dev", 1),
    );
    expect(replayV1.decision).toBe("pass");

    // 「读得到旧版」这件事本身也要有反向对照：旧版与最新版**内容确实不同**，
    // 否则上面那一发 pass 在「两个函数返回同一个数组」的坏实现前也绿。
    const latest = gateCriteriaForRole(db as never, "dev");
    const old = gateCriteriaForRoleAtVersion(db as never, "dev", 1);
    expect(old.map((c) => c.condition)).toEqual(["metric:coverage < 80"]);
    expect(latest.map((c) => c.condition)).toEqual(["metric:coverage < 95"]);
  });

  it("变化【不只】来自库，也来自产出：两个方向都判过，排除法才成立", async () => {
    /*
     * store.test.ts ③ 节末尾有一条同名的排除法用例，它用的是**手搓 criteria**。
     * 这一发的不同在于它同时动了**两个**源并各判一次：
     *   · 只换 criteria、产出不动 ⇒ 结论变（上一发已证）；
     *   · 只换产出、criteria 不动 ⇒ 结论也变（这一发补的那一维）。
     * 第二支是**必要的排除**：如果门控其实是按「metrics 缺了就 escalate」在动，
     * 那么第一支那个 pass→reject 的变化根本与岗位书无关，整段 ① 就在证另一件事。
     * 实测形状：同一 criteria（< 95）下 90 ⇒ reject、99 ⇒ pass。
     * 也就是**换产出确实会换结论** —— 所以「换 criteria 换结论」不是唯一可能的解释，
     * 而这个排除法只有在**两个方向都判过**之后才成立。
     */
    const { q, db, store } = await newCharterRun();
    await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({
        acceptance_criteria: [
          { condition: "metric:coverage < 95", action: "reject", message: "不足 95" },
        ],
      }),
      nowMs: NOW,
      changeSummary: "只有 95 这一版",
    });
    const criteria = gateCriteriaForRole(db as never, "dev");
    expect(gateFor((await realBundle(store, { coverage: 90 })).bundle, true, criteria).decision).toBe("reject");
    expect(gateFor((await realBundle(store, { coverage: 99 })).bundle, true, criteria).decision).toBe("pass");
    // 第三种形状：证据包里**根本没有这个指标** ⇒ escalate 而不是 pass（evaluateGate 文件末段
    // 那句「最省事的假绿方式不是伪造覆盖率数字，而是【不提覆盖率】」）。
    // 这一发放在 ① 段里的理由：它是「改标准 ⇒ 结论变化」这条命题的**边界**，
    // 少了它，「标准判不判得成都 pass」的实现能让整段 ① 绿。
    const noMetric = gateFor((await realBundle(store, {})).bundle, true, criteria);
    expect(noMetric.decision).toBe("escalate");
    if (noMetric.decision === "escalate") {
      // 而且 escalate 的理由必须点名【是哪条标准判不出】，不能只说「证据不足」。
      expect(noMetric.unresolved.join("")).toContain("metric:coverage < 95");
    }
  });

  it("产出被改过一个字节 ⇒ reject 发生在标准之前（顺序也是验收的一部分）", async () => {
    /*
     * 为什么这条属于 Phase 3 而不只是 phase1 的重复：phase1 那条用的是手写 criteria，
     * 这一条用的是**从库里读出来的** criteria。差别是真实的失效面 ——
     * 若 `integrityOk` 这一维在某次接线上被漏传（变 undefined），门控会把它记进
     * unresolved 而不是 reject，而 CEO 改标准的效应仍然「看得见」。
     * 篡改被放行 + 标准生效 = 一个看起来在工作而实际可绕过的门控。
     */
    const { q, db, store } = await newCharterRun();
    await saveCharterVersion(q, {
      roleId: "dev",
      config: draft(),
      nowMs: NOW,
      changeSummary: "第一版",
    });
    const id = nextBundleId();
    const w = store.writeArtifact(
      { task_id: "T-1", bundle_type: "code_diff", bundle_id: id },
      "diff",
      "coverage 91\n",
    );
    const bundle = {
      bundle_id: id,
      task_id: "T-1",
      bundle_type: "code_diff",
      produced_by_role: "dev",
      produced_by_model_family: "claude",
      artifacts: [{ path: w.declared, sha256: w.sha256, bytes: w.bytes }],
      claims: [{ text: "达标", evidence_refs: [w.declared] }],
      honesty_boundaries: [],
      metrics: { coverage: 91 },
    } as unknown as EvidenceBundle;
    const criteria = gateCriteriaForRole(db as never, "dev");
    // 先按原样过 —— 证明下面的 reject 是【篡改】造成的，不是夹具本来就不合格。
    expect(store.verify(bundle).ok).toBe(true);
    expect(gateFor(bundle, store.verify(bundle).ok, criteria).decision).toBe("pass");

    writeFileSync(join(store.root, w.declared), "coverage 99\n", "utf8"); // 内容变了，声明没变
    expect(store.verify(bundle).ok).toBe(false);
    const tampered = gateFor(bundle, store.verify(bundle).ok, criteria);
    expect(tampered.decision).toBe("reject");
    if (tampered.decision === "reject") {
      // 理由必须是【完整性】而不是覆盖率 —— 篡改后那份内容是达标的。
      // 少了这两发，「因为别的原因 reject」也能让上一条绿。
      expect(tampered.reasons.join("")).toContain("完整性");
      expect(tampered.reasons.join("")).not.toContain("覆盖率");
    }
  });
});

/* ═════════════ ② 自动批准可见且可追溯（规格 §23.1 Phase 3 第二条） ═════════════ */

async function newPolicyRun(): Promise<{ db: AnyDb }> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(join(TMP, "pol-" + process.pid + "-" + ++fileSeq + ".db")) as unknown as AnyDb;
  plain.push(db);
  migrate(db as never);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('T-1', '自动批准夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(NOW, NOW);
  return { db };
}

/** 一张真卡片。status 用列默认值（pending），与 policy 那份夹具同形。 */
function seedCard(db: AnyDb, id: string): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters) " +
      "VALUES (?, 'T-1', 'strategic', '一句话摘要', '{}')",
  ).run(id);
}

/** R1 全齐的输入（只读 + 证据完整 + 门控过）。与 policy 那一份夹具同一形状。 */
const r1 = (over: Partial<AutoApproveInput> = {}): AutoApproveInput => ({
  action: { kind: "read_repo", detail: "read src/a.ts" },
  evidence: { ok: true, checked: 3 },
  gate: { passed: true, gate: "dev_to_test" },
  ...over,
});

describe("② 自动通过的决策：日报数得到 + 回放搜得出（§23.1 Phase 3 第二条）", () => {
  it("同一条自动批准：日报里有一格，且按中文关键词能在回放里搜到", async () => {
    /*
     * 这一发是本文件的**核心**，因为它跨了两个各自全绿的模块：
     *  写侧 recordAutoApproval（payload 里带中文 annotation「基于模式的自动批准」）
     *  → events 表 → events_fts 触发器（0001_init.sql:84，trigram，只索引 payload）
     *  → 读侧 searchEvents（三档：FTS / LIKE / 精确）
     * 任何一处断了（触发器没建、分词器不是 trigram、annotation 字段被改名），
     * policy 与 replay 两边的单测**都不会红**，而「可追溯」这句话当场失效。
     */
    const { db } = await newPolicyRun();
    seedCard(db, "ap-1");
    const rec = recordAutoApproval(db as never, {
      taskId: "T-1",
      outcome: autoApprove(r1()),
      approvalId: "ap-1",
      nowMs: NOW,
    });
    expect(rec.card_claimed).toBe(true);

    // 日报那一半（「可见」）。
    const rep = readAutoApprovalReport(db as never, { day: DAY });
    expect(rep.total).toBe(1);
    expect(rep.items).toHaveLength(1);
    expect(rep.items[0]?.seq).toBe(rec.seq);
    expect(rep.items[0]?.approval_id).toBe("ap-1");
    expect(rep.by_rule["read_only_evidence_gate"]).toBe(1);
    // 卡片真的被批掉了（不是「审计说批了而卡片还 pending」）。
    // card_unclaimed > 0 是收件箱计数恒不对的直接来源（auto-approve.ts 注释原话）。
    expect(rep.card_unclaimed).toBe(0);

    // 回放那一半（「可追溯」）：中文关键词，命中的是**日报那一条 payload**。
    // 选 3 字以上是有原因的 —— trigram 窗口要 3 个字，短于 3 直接跳过 FTS 那一档，
    // 于是「搜不到」会是分词窗口的问题而不是链路的问题（search.test.ts ① 节同一条）。
    const hits = searchEvents(db as never, { keyword: "基于模式的自动批准" });
    expect(hits.map((h) => h.id)).toContain(rec.seq);
    // via 必须是 fts。它是「这条命中来自 payload 的 trigram 索引」的唯一机器可读证据 ——
    // like 那一档会连 JSON 键名一起匹配（search.ts 里 SearchHit.via 那段实测），
    // 所以 via=like 的命中**不能**算作「annotation 这个词搜得到」。
    expect(hits[0]?.via).toBe("fts");

    // 反向对照：一个**不该**命中的关键词必须搜不到这一行。
    // 少了这一发，「searchEvents 永远返回全部行」的实现也能让上面两条绿
    // （0013 §8 那条纪律：反向对照必须经过被测代码）。
    const miss = searchEvents(db as never, { keyword: "从未出现过的中文关键词串" });
    expect(miss.map((h) => h.id)).not.toContain(rec.seq);
  });

  it("人工批准【不】进日报（口径只有一条：payload 里有 auto_approved_by）", async () => {
    /*
     * 「八成审批由规则决定」（§9 北极星）这个指标的分母由日报给。
     * 若人工批准混进来，那个比例会**虚高**，而它是要拿去判断「CEO 是不是真的被打扰得少了」的数。
     * 这一发与上一发配对：只断言「自动的进来了」挡不住「什么都进来」。
     */
    const { db } = await newPolicyRun();
    // 直接 INSERT 而不是走 real-deps 的 applyDecision：那是 http 层的一条完整路径，
    // 有自己的测试（http/server.test.ts）。这里要的只是「一行 action=approval 的人工事件」
    // 这个**形状**，用最小写法；形状由谁负责判，写在下面那条断言的口径里。
    db.prepare(
      "INSERT INTO events (actor_type, actor_id, action, target, task_id, payload, created_at) " +
        "VALUES ('human', 'ceo', 'approval', 'ap-9', 'T-1', '{\"approvalId\":\"ap-9\",\"resume\":\"approve\"}', ?)",
    ).run(NOW);
    const rep = readAutoApprovalReport(db as never, { day: DAY });
    expect(rep.total).toBe(0);
    expect(rep.items).toHaveLength(0);
    // 反向对照：同一张库补一条自动批准，总数必须变 1。
    // 少了它，「readAutoApprovalReport 恒返回 0」的实现也能让上一条绿。
    seedCard(db, "ap-10");
    recordAutoApproval(db as never, {
      taskId: "T-1",
      outcome: autoApprove(r1()),
      approvalId: "ap-10",
      nowMs: NOW,
    });
    const rep2 = readAutoApprovalReport(db as never, { day: DAY });
    expect(rep2.total).toBe(1);
    // 那两条里必须只剩自动的那一条（这一发排除的是「口径写成 action='approval'」的实现：
    // 那样 total 会是 2 而不是 1，明细也会多一行）。
    expect(rep2.items).toHaveLength(1);
    expect(rep2.items[0]?.approval_id).toBe("ap-10");
  });

  it("署名是策略引擎而不是人，且那一条删不掉（R3 + append-only）", async () => {
    const { db } = await newPolicyRun();
    seedCard(db, "ap-1");
    const rec = recordAutoApproval(db as never, {
      taskId: "T-1",
      outcome: autoApprove(r1()),
      approvalId: "ap-1",
      nowMs: NOW,
    });
    const rows = db.prepare("SELECT actor_type, actor_id, action FROM events").all();
    expect(rows).toHaveLength(1);
    // actor_type = system 而不是 human/agent：没有人做过这个动作，是规则做的。
    expect(rows[0]?.["actor_type"]).toBe("system");
    expect(rows[0]?.["actor_id"]).toBe(AUTO_APPROVED_BY);
    expect(rows[0]?.["action"]).toBe("approval");
    // 卡片那一列 decided_by 也不能是 ceo（它是「这条是人批的还是规则批的」的
    // 唯一列级出处）。这一发与 policy 那份的 ⑤ 节看着重复，但那份测的是
    // 「自动批准写对了」，这一份测的是「跨到日报口径之后仍然对得上」——
    // 而「可追溯」最怕的正是**两处各对一半**：payload 署了引擎而列上署了 ceo，
    // 于是日报数得到、审批页却显示成 CEO 批的。
    const card = db.prepare("SELECT status, decided_by FROM approvals WHERE id = 'ap-1'").get();
    expect(card?.["status"]).toBe("approved");
    expect(card?.["decided_by"]).toBe(AUTO_APPROVED_BY);
    // 「可追溯」的下界不是「现在查得到」，是「事后谁也抹不掉」。
    // schema-0001.test.ts 在 DDL 层测过那两个触发器本身（拿合成行测），
    // 这一发测的是【这一条具体的自动批准记录】在真写入之后仍然抹不掉。
    expect(() => db.prepare("DELETE FROM events WHERE id = ?").run(rec.seq)).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()?.["n"]).toBe(1);
    /*
     * 反向对照：同一个连接上删一张**不是** append-only 的表必须成功。
     * 少了它，「这个连接上任何写语句都报错」也能让上面那条绿 ——
     * 那测的就不是 append-only 而是「库是只读的」，两者是完全不同的性质
     * （后者会让整个 Hub 跑不起来，而且是响的、不会被当成通过）。
     */
    expect(() => db.prepare("DELETE FROM approvals WHERE id = 'ap-1'").run()).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS n FROM approvals").get()?.["n"]).toBe(0);
  });
});

/* ═══════════ ③【本轮最重要】门控说 escalate，升级路由说不用升 —— 两半没接上 ═══════════ */

describe("③ 岗位书里的 escalate 标准到不了升级路由（本轮实测出来的缝）", () => {
  it("evaluateGate 判 escalate 而 unresolved 为空 ⇒ decideEscalation 判不升", async () => {
    /*
     * CEO 在岗位书里写一条 `action: "escalate"` 的标准（charter 的验收动作枚举允许），
     * 意思是「这条不达标时别直接拒，交给 CEO 判」。实测这一发的两侧：
     *   evaluateGate       → { decision: "escalate", reason: "…需 CEO 判（升级目标 ceo）",
     *                          unresolved: [] }      ← 注意是**空**
     *   decideEscalation({…, unresolvedCriteriaCount: 0}) → { escalate: false }
     *
     * 也就是说【门控的 escalate 结论不在升级路由的输入里】。EscalationState 那十格
     * 没有任何一格能表达「门控刚说要看一下」：reasons() 只看 reviewRoundNo / riskTier /
     * 预算两格 / outsideDecisionScope / unresolvedCriteriaCount / confidence，
     * 而 **state 那一格根本不参与判定**（只进卡片摘要）—— 所以「传个 IN_REVIEW 进去就会升」
     * 是我一开始以为的那条通道，实测它不存在。**我以为的接缝是装饰**，这一点值得记。
     * unresolved 那一维是【按客观标准判不出】，而 escalate 是【判出了、且要求人判】——
     * 两件事，共用不了一个数。
     *
     * 这与 phase1 文件头记的那次事故是**同一族的镜像**：那次是「门控 pass + 升级条件用
     * unresolved」导致两条验收同时失效；这次是「门控 escalate + 升级条件只看 unresolved」
     * 导致一条 CEO 亲手写的 escalate 标准被静默降级。
     *
     * ⚠ 本文件**不**把它报成生产 bug：`evaluateGate` 今天零调用方（④ 段实测并钉成断言），
     * 所以没有任何一条真链路正在丢这个 escalate。它报的是**接线那天一定会踩的坑**，
     * 而踩到的方式是「全绿」。修法两条，都不是本轮该单的：
     *   α 编排层自己分叉：`gate.decision === "escalate"` 直接升，不看 unresolved；
     *   β 给 EscalationState 加一格（gateDecision），让路由成为唯一决策点。
     * 我倾向 β：α 把「要不要升」变成两处判据，而 0016 §5 那条「严格度序只有一处定义」
     * 讲的正是两处判据的代价。但它属于接线设计，等真图接起来时定，登记在 0017 §需要 CEO。
     */
    const { q, db, store } = await newCharterRun();
    const saved = await saveCharterVersion(q, {
      roleId: "dev",
      config: draft({
        acceptance_criteria: [
          {
            condition: "metric:coverage < 80",
            action: "escalate",
            target: "ceo",
            message: "覆盖率不足，需 CEO 判",
          },
        ],
      }),
      nowMs: NOW,
      changeSummary: "第一条用 escalate 而不是 reject",
    });
    expect(saved.ok).toBe(true);

    const run = await realBundle(store, { coverage: 50 });
    const v = gateFor(run.bundle, run.integrity, gateCriteriaForRole(db as never, "dev"));
    // 门控这一侧：判成 escalate，理由带着 CEO 写的那句话与升级目标。
    expect(v.decision).toBe("escalate");
    if (v.decision !== "escalate") return;
    expect(v.reason).toContain("需 CEO 判");
    expect(v.reason).toContain("ceo");
    // **空 unresolved** 是本发要钉住的关键一格 —— 它不是 1。
    expect(v.unresolved).toEqual([]);

    // 升级路由那一侧：拿门控能给的那个唯一的数去喂，判「不用升」。
    const e = decideEscalation({
      taskId: "T-1",
      state: "IN_REVIEW",
      unresolvedCriteriaCount: v.unresolved.length,
    });
    expect(e.escalate).toBe(false);

    /*
     * 反向对照，两发，**都必须存在**，否则上面那条 `escalate === false`
     * 在「decideEscalation 恒返回不升」的坏实现前也绿（本仓记了三次的恒绿形状）：
     *  ① unresolved 喂成 1 ⇒ 升，理由 insufficient_evidence。
     *     ⇒ 说明问题不在路由「坏」，而在【门控那个结论没有通道传过来】。
     *  ② IN_REVIEW 确实是一个「能升级」的状态（canEscalateFrom）。
     *     少了这一发，整段 ③ 可能只是在证「这个状态本来就不能升级」——
     *     那是一条完全不同的结论，而且它会让人去改状态机而不是改接缝。
     */
    const e2 = decideEscalation({ taskId: "T-1", state: "IN_REVIEW", unresolvedCriteriaCount: 1 });
    expect(e2.escalate).toBe(true);
    if (e2.escalate) {
      expect(e2.reason).toBe("insufficient_evidence");
      // 卡片摘要里带着那个数：升级卡片必须可决策，而不是只说「证据不足」。
      expect(e2.card.summary).toContain("1 条");
    }
    expect(canEscalateFrom("IN_REVIEW")).toBe(true);
  });
});

/* ═══════════ ④ 门禁【判不了】的部分：钉成断言而不是写在注释里 ═══════════ */

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out.sort();
}

/** src 里除 ownFiles（各自定义处）之外、正文出现 `name(` 的文件。 */
function callersOf(name: string, ...ownFiles: string[]): string[] {
  return tsFiles(SRC).filter(
    (f) => !ownFiles.some((o) => f.endsWith(o)) && readFileSync(f, "utf8").includes(name + "("),
  );
}

describe("④ 两条验收各自【不可测的那一半】（登记，不写成已通过）", () => {
  it("① 的『重跑同类任务』今天无路可跑：evaluateGate 在 src 里零调用方", () => {
    /*
     * 「改标准 ⇒ 重跑 ⇒ 结论变化」这句话有三个动词，本文件只证得了中间那两个
     * （读标准、判结论）。第三个【跑】需要一个调用方，而实测没有。
     * ⇒ ① 现在成立的是「门控**会**按新标准变」，不是「任务重跑时**会**变」。
     *   差别不是文字游戏：前者只要 evaluateGate 正确，后者还要有人在对的时机调它。
     * 与 0016 §7 第三条同一族（同族第八次），发现方式照旧是写文档时顺数据源往下摸。
     */
    expect(callersOf("evaluateGate", "graph/gates/evaluate.ts")).toEqual([]);
    /*
     * 反向对照（判据本身必须有分辨力）：同一个扫描器扫一个【真有调用方】的函数，
     * 必须捞到那一个文件。少了这一发，「tsFiles 返回空」「路径拼错」「includes 写错」
     * 都会让上面那条恒绿 —— 而这正是本仓记了三次的「恒绿装饰」。
     * 选 searchEvents 而不是别的：它的调用点在 replay/query.ts，与被扫的模块无关，
     * 于是这一发同时证明了「扫描器能捞到东西」和「evaluateGate 那条空是真的空」。
     */
    expect(callersOf("searchEvents", "replay/search.ts")).toEqual([
      SRC + "/replay/query.ts",
    ]);
    // 而且这个扫描器数的确实是【调用】而不是【提及】：evaluateGate 这个词在 src 里
    // 出现 4 处（实测 grep -rn），其中 3 处是注释或类型注解。
    // 用 includes("evaluateGate(") 而不是 includes("evaluateGate") 就是为了这一格差别，
    // 下面这一发把「词确实存在」钉住 —— 否则「整个 src 里根本没有这个词」也会让
    // 第一条零调用方断言绿，而那是一个**完全不同**的原因（模块被删了 vs 没人调）。
    const mentions = tsFiles(SRC).filter((f) => readFileSync(f, "utf8").includes("evaluateGate"));
    expect(mentions.length).toBeGreaterThan(0);
  });

  it("② 的『在日报可见』只有数据面：readAutoApprovalReport 也零调用方", () => {
    expect(callersOf("readAutoApprovalReport", "policy/auto-approve.ts")).toEqual([]);
    /*
     * 「有没有日报端点」这一维的判据要选对，否则会自欺：
     *  【不能】grep「日报」这个词在 src 里出现没有 —— 它出现了，全在注释里
     *    （auto-approve.ts 文件头那一段 grep 记录本身就是「日报」三个字写的），
     *    那会把「有日报」判成真；
     *  【也不能】只断言 contracts/api.ts 里不含某个名字然后收工 —— 一条恒不命中的正则
     *    与恒绿的判据等价。所以这里配一发**同一个文件里的真端点**做正向对照：
     *    「扫这个文件能捞到端点」与「捞不到日报端点」两条一起，才是一次有内容的排除法。
     */
    const api = readFileSync(join(HUB, "..", "..", "packages", "contracts", "src", "api.ts"), "utf8");
    expect(api).toContain("GET /replay/:taskId");
    expect(api).not.toMatch(/daily[-_]?report|auto[-_]?approval/iu);
    // 第三发：这条「只有数据面」的结论在**岗位书读侧**那一维上也成立 —— 同一个扫描器，
    // 判据共享，坏一起坏。readCharterConfig 是 ① 段那条链的下游读函数，
    // 它零调用方意味着「CEO 改了标准而运行期读不到」这件事比 ① 段写的还宽一格。
    expect(callersOf("readCharterConfig", "charter/store.ts")).toEqual([]);
  });

  it("门禁的诚实口径：本文件跑绿【不等于】Task 3.8 通过", () => {
    /*
     * 这一发不测代码，测的是**我写这个文件时的口径**。
     * 一条标题写着「Phase 3 出口门禁」的文件如果全绿，读的人（和下一次的我）会把它
     * 当成「Phase 3 做完了」。实际状态是右边那五条，一条没消。
     * 把它写进测试文件而不是只写进决策文档，是因为只有这里它会在有人改动时被看到。
     * 它同时是一个**会过期的断言**：有人消掉一条缺口，callersOf 那两发就会红，
     * 逼他同时改这份清单 —— 而不是让「门禁没通过」这句话悄悄变成一条假的实话。
     */
    const blockers = [
      "① 的第三个动词没有实现：evaluateGate 零调用方（上一条当场判的）",
      "② 的『日报』只有数据面：readAutoApprovalReport 零调用方（上一条当场判的）",
      "② 的自动批准在生产运行期零生产者（0014 §3；本文件②段那些 recordAutoApproval 全由测试自己调）",
      "pnpm verify 未跑：本机装不上依赖（0009 §2）",
      "③ 段那条 escalate 接缝没人接（本文件③段钉的就是它没接）",
    ] as const;
    expect(blockers).toHaveLength(5);
    // 前两条与后三条的**性质不同**：前两条本文件当场判了（可复算、会随改动变红），
    // 后三条引的是别处的实测与环境事实。这条区分要钉住 ——
    // 否则这五条看起来像同一类「作者自述」，而其中两条其实是判据。
    expect(callersOf("evaluateGate", "graph/gates/evaluate.ts")).toHaveLength(0);
    expect(callersOf("readAutoApprovalReport", "policy/auto-approve.ts")).toHaveLength(0);
  });
});
