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
import { fixtureTmp } from "../fixtures/fixture-dir.js";
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
const TMP = fixtureTmp("acceptance3", import.meta.url);

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

/**
 * src 里【代码行】命中 re 的文件。
 *
 * 为什么要跳过注释行而不是直接 includes：本仓的源码注释里【抄了 grep 命令原文】
 * （real-deps.ts 文件头那三条实测 grep 就是证据本身，按 0007 §4.1 那种「错话也留着」
 * 的口径更不能删）。于是「src 里有没有 INSERT INTO approvals」这一判据
 * 用裸 includes 会命中那条【注释】，把【零生产者】判成【有生产者】——
 * 一个假的生产者，而它正是这条断言要防的东西。
 *
 * 只跳「整行是注释」的行（trimmed 以 // 或 * 或 /* 开头）。刻意不做完整的词法分析：
 * 残留的漏法是【代码行尾】的注释里写着那个词，那种会算成生产者 ——
 * 方向是【误报】（多算一个生产者 → 断言红 → 有人来看一眼），
 * 而漏报（少算 → 把真生产者判成零）才是这条断言不能承受的。
 */
function srcFilesMatching(re: RegExp): string[] {
  return tsFiles(SRC).filter((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .some((l) => {
        const t = l.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
        return re.test(l);
      }),
  );
}

describe("④ 两条验收各自【不可测的那一半】（登记，不写成已通过）", () => {
  it("① 的『重跑同类任务』今天仍无路可跑：调用链多了一环，而那一环也没人调", () => {
    /*
     * 「改标准 ⇒ 重跑 ⇒ 结论变化」这句话有三个动词，本文件只证得了中间那两个
     * （读标准、判结论）。第三个【跑】需要一个调用方。
     *
     * ⚠ 这条断言**曾经**是 `toEqual([])`，而它在 Task 5.4 变红了 —— 那是它设计出来
     * 要做的事（下面那段注释写的就是「有人消掉一条缺口，callersOf 那两发就会红」）。
     * 变红之后不能直接改成新值收工，得先问一句：**缺口真的消了吗**？
     * 实测没有：`harness/verifier.ts` 开始调 evaluateGate，而 `verifyFix` 自己
     * 在生产里零调用方。所以缺口**上移了一环**而不是被填上：
     *   以前是「门控对，但没人对门的时机调它」；
     *   现在是「有一个正确的调用方，但没人调它」。
     * 结论强度因此**没有变化**：① 现在成立的仍然是「门控会按新标准变」，
     * 不是「任务重跑时会变」。改断言的同时把这一格写清楚，
     * 否则「多了一环」会被读成「前进了一步」，而这一环在接线之前不产生任何行为。
     */
    expect(callersOf("evaluateGate", "graph/gates/evaluate.ts")).toEqual([
      SRC + "/harness/verifier.ts",
    ]);
    // 上面那条**只有在配上下面这条时**才不是一句好消息：
    expect(callersOf("verifyFix", "harness/verifier.ts")).toEqual([]);
    /*
     * 反向对照（判据本身必须有分辨力）：同一个扫描器扫一个【真有调用方】的函数，
     * 必须捞到那一个文件。少了这一发，「tsFiles 返回空」「路径拼错」「includes 写错」
     * 都会让上面两条恒绿 —— 而这正是本仓记了三次的「恒绿装饰」。
     * 选 searchEvents 而不是别的：它的调用点在 replay/query.ts，与被扫的模块无关，
     * 于是这一发同时证明了「扫描器能捞到东西」和「evaluateGate 那条只有一个是真的少」。
     */
    expect(callersOf("searchEvents", "replay/search.ts")).toEqual([
      SRC + "/replay/query.ts",
    ]);
    // 而且这个扫描器数的确实是【调用】而不是【提及】：evaluateGate 这个词在 src 里
    // 出现多处，其中大部分是注释或类型注解。
    // 用 includes("evaluateGate(") 而不是 includes("evaluateGate") 就是为了这一格差别，
    // 下面这一发把「词确实存在」钉住 —— 否则「整个 src 里根本没有这个词」也会让
    // 第一条断言绿（改成 toEqual 之后它会以另一种方式红），而那是一个**完全不同**的原因
    // （模块被删了 vs 没人调）。
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
     * 当成「Phase 3 做完了」。实际状态是右边那六条，一条没消。
     * 把它写进测试文件而不是只写进决策文档，是因为只有这里它会在有人改动时被看到。
     * 它同时是一个**会过期的断言**：有人消掉一条缺口，callersOf 那两发就会红，
     * 逼他同时改这份清单 —— 而不是让「门禁没通过」这句话悄悄变成一条假的实话。
     */
    const blockers = [
      "① 的第三个动词仍然没有实现：verifier.ts 开始调 evaluateGate（Task 5.4），但 verifyFix 自己零调用方 —— 缺口上移一环，没被填上（上一条当场判的）",
      "② 的『日报』只有数据面：readAutoApprovalReport 零调用方（上一条当场判的）",
      "② 的自动批准在生产运行期零生产者（0014 §3；本文件②段那些 recordAutoApproval 全由测试自己调）",
      "pnpm verify 未跑：本机装不上依赖（0009 §2）",
      "③ 段那条 escalate 接缝没人接（本文件③段钉的就是它没接）",
      // 这一条被改写过【三次】，三次都改的是同一个词：「生产者」。留痕如下（每次改写
      // 都是被一次真实改动顶出来的，不是作者改口径 —— 这正是它写成断言而不是文档的原因）。
      //
      // 【第一版｜Task 6.1】「卡片零 INSERT」。
      // 【第二版｜0026】补了 src/approvals/cards.ts + 迁移 0004 ⇒ INSERT 有了。
      //   当时分清三件事（第一版只分清了两件）：
      //     · 批准的【写路径】：real-deps.ts 一条 UPDATE（认领 + 落决定）。早就有。
      //     · 卡片的【创建路径】：有了。
      //     · 卡片的【生产者】：还是没有 ⇒ 缺口从「没有创建路径」上移成
      //       「有创建路径、没人叫它」，与 ① 那条「verifier 开始调 evaluateGate
      //       而 verifyFix 零调用方」是**同一个形状**。
      //   我第二版一度写成「创建路径有了 ⇒ 缺口消掉」，那是错的，而且错在最像对的地方：
      //   grep INSERT 确实从 0 变 1 了。真正卡住 Task 2.6 验收（「收件箱计数与实际
      //   待审批数一致」）的从来不是 INSERT 语句在不在，而是**有没有人真建出一张卡**。
      // 【第三版｜0041（提交 42c8eea，`hub:engine` 那条链落地那次）】生产者【有了】
      //   —— 而这件事是【绿着发生的】：
      //   engine/charter.ts 与 engine/dispatch.ts 经【下层】insertCard 真建卡，
      //   绕过了带 queue + 入参校验的 createCard ⇒ `callersOf("createCard")`
      //   【仍然数到零】。判据没坏，它指的事实换了，而换的方向恰好让绿的那边继续绿。
      //   所以这一版的改动不只是改文案：判据本身换成了 `callersOf("insertCard")`
      //   （下面那条，有分母），旧的 createCard 那一发【留着但明写它不再判第 6 条】。
      //   现在的缺口是【生产者只在错的那一侧】—— 见下面那条字符串。
      //
      // 另外那半（0025 §8.2 的 approval_type 缺格）今天**消掉了**：0026 按 CEO
      // 授权选了「加一个通用 escalation 值 + reason 放 payload」，
      // 六类升级原因现在都写得进一张卡（cards.test.ts ③ 那发逐类验过）。
      // 【第四版｜0044（章程泵，本轮）】间接路【通了】，而这件事又是【绿着发生的】：
      //   serve/charter-pump.ts 调 ensureCharterCard，由 assemble.ts 在 --charter-pump
      //   打开时按心跳驱动。上面那两份 INSERT / UPDATE 全等名单【都没红】—— 泵经
      //   ensureCharterCard → insertCard 建卡，INSERT 语句仍然只在 cards.ts 一处。
      //   所以本轮补的是那两条【有分母】的调用方名单（ensureCharterCard / pumpCharterCards），
      //   口径与判据一起改，见下面那两份 docblock。
      //   ⚠ 缺口【没有】被这次改动消掉，只是换了形状：原来缺「链路」，现在缺
      //   「有人把这个花钱的开关打开」。默认不开是刻意的（0041 §8 那条立场），
      //   而它意味着第 6 条在默认配置下的结论与第一版那天【一样】：收件箱是空的。
      //   另两格也没消：`pnpm hub:engine` 本机仍然跑不起来（tsx + langgraph 都装不上），
      //   而泵这一侧的真子进程路径本机同样【没验过】（0044 §9.2 第 1 条）。
      "② 的卡片生产者【有了，两条路，而默认哪条都不走】：src/engine 两条路径经 insertCard 真建卡（上面那条有分母的名单当场判的），serve/ 那一条由【章程泵】经 ensureCharterCard 建（0044，也是当场判的）。但它开关是 --charter-pump，默认【不开】—— 那一格打开的是「每隔一个心跳自己起子进程花钱」，所以必须显式拧。于是默认配置下 CEO 看到的收件箱【仍然是空的】，与第一版那天同结论；另外那半【本机验不了】照旧：hub:engine 要 tsx + @langchain/langgraph 两样都装不上（0039），泵那条真子进程路径同样没跑过（0044 §9.2 第 1 条）。",
    ] as const;
    expect(blockers).toHaveLength(6);
    // 各条的**性质不同**：第 1、2、6 条本文件当场判了（可复算、会随改动变红），
    // 其余引的是别处的实测与环境事实。这条区分要钉住 ——
    // 否则这六条看起来像同一类「作者自述」，而其中三条其实是判据。
    //
    // ⚠ 原来这两发是 `toHaveLength(0)`，Task 5.4 让第一发红了一次（verifier.ts 成了
    // evaluateGate 的调用方）。改法是**换成那条链的真实形状**而不是删掉：
    // 「门控有人调」这句话本身不推进 ① —— 只有当**链的末端**也有人调时才算。
    // 所以这里配对判：门控的调用方是 verifier，而 verifier 的调用方是空。
    expect(callersOf("evaluateGate", "graph/gates/evaluate.ts")).toEqual([
      SRC + "/harness/verifier.ts",
    ]);
    expect(callersOf("verifyFix", "harness/verifier.ts")).toHaveLength(0);
    expect(callersOf("readAutoApprovalReport", "policy/auto-approve.ts")).toHaveLength(0);
    /*
     * 第 6 条 blocker 原来只是作者自述（「卡片仍零 INSERT」）。自述会过期而**过期时不响**，
     * 所以这里把它也变成判据。0026 落地时它**真的红了一次**（红的就是下面第一发），
     * 那不是「改动做错了」，是它设计出来要做的事：逼改动的人重写这份清单。
     *
     * ⚠ 但**判据的形状要跟着缺口一起改**。第一版红完之后我差点把它改成
     * `toEqual([SRC + "/approvals/cards.ts"])` 了事 —— 那就把「有创建路径」
     * 与「有生产者」两件事又并回一个判据，正是上面那段说要分开的东西。
     * 所以现在是两发配对：INSERT 那一发只证「创建路径存在」，
     * 而 callersOf("createCard") 才证第 6 条说的**零生产者**。
     * 反向对照同段已有形状：同一个扫描器必须能捞到【真的那两条 UPDATE approvals】，
     * 否则「捞不到」可能只是「扫描器坏了 / 注释过滤把代码也滤掉了」。
     */
    expect(srcFilesMatching(/INSERT\s+INTO\s+approvals/iu)).toEqual([
      SRC + "/approvals/cards.ts",
    ]);
    /*
     * ⚠ 下面这一发【今天仍然绿，而它已经不再判第 6 条了】—— 这一句必须写在断言旁边，
     * 因为「绿的」与「还在判某件事」是两件事，而本文件存在的全部理由就是不混淆它们。
     *
     * 0041（提交 42c8eea，`hub:engine` 那条链）落地后，真建卡的两条路径是
     * `engine/charter.ts` 与 `engine/dispatch.ts`，而它们调的是【下层】的 `insertCard`，
     * 不是上层那层包装 `createCard`。于是 `callersOf("createCard")` 数到的【还是零】，
     * 而第 6 条说的「零生产者】【已经不是真的了】。这就是 0016 §1 那族的形状：
     * 判据没坏，是它指的事实换了 —— 而且换的方向恰好让绿的一边继续绿，
     * 所以没有任何东西会响。
     *
     * 为什么这里【绕的是包装、不是校验】（我一开始把这条写成「绕过了入参校验」，
     * 那是错的，而且错的方向和上面那条一模一样：听着像对、没人会去查）：
     *   · 入参校验【在下层】—— zod 的 draft parse 与 APPROVAL_TYPES 那一关
     *     都在 insertCard 里面（cards.ts 内可见），两条 engine 路径【照过】；
     *   · 上层多出来的是【事务装配】：`w.node(...)` 拿写锁 + requireScopeDb +
     *     组 ApprovalRequired 事件 + appendAudit。而超步内部事务已经开着，
     *     再调 w.node 就是嵌套取锁 —— cards.ts 那段注释本来就写着
     *     「超步内部的调用方不要用它，应当直接 insertCard + appendAudit」。
     * 所以那是一条【按设计】的分层，不是绕过。留着这一发只因为它还判另一件事：
     * 「上层那层包装今天在 src 里零调用方」—— 那是【另一条】待查的账
     * （serve / 巡检 / CLI 都该用它而今天没人用），它【不许】被读成「卡片零生产者」。
     * 有分母的那一发在下面。
     */
    expect(callersOf("createCard", "approvals/cards.ts")).toEqual([]);
    /**
     * 第 6 条【现在】的真判据：谁在 src 里真建卡 = 谁调 insertCard（cards.ts 自己除外）。
     *
     * ⚠ 它【不是】一条「红过所以可信」的判据 —— 这条断言是 0041 之后【补的】，
     * 落地那天它并不存在，所以从没被那次改动顶红过。今天真红过一次的是【下面那条
     * UPDATE 名单】（`hub work / hub decide` 加了 approve.ts 这个第三个写方），
     * 而那发红的正是它设计要做的事：逼改动的人回来重写上面那份清单
     * —— 只是那次改动【没有】回来重写，这份账挂到本轮才还。
     * 这一发的可信度来自另一处：它的分母是【当场数出来的】两个文件（不是空名单），
     * 所以「扫描器坏了 / 路径拼错 / 注释滤掉代码」那一族瞎法在这条上会当场显形，
     * 而在上一条（零调用方）那条上不会 —— 两条摆在一起才有分辨力。
     *
     * ⚠ 但它【不滤注释】：callersOf 是裸 includes，而上面那条 INSERT 名单用的
     * srcFilesMatching【滤】整行注释。差别不是疏忽，是【方向】——
     * 这条只会【多算】（误报 → 红 → 有人来看一眼），
     * 那条【少算】才是不能承受的（把真生产者判成零）。实测过这一格：往 real-deps.ts
     * 追加一行【纯注释】的 `// insertCard( …` ⇒ 这一发红，报的正是实到三项。
     * 代价如实说是【假红】，而它【已经埋了一颗】：real-deps.ts:488 那句注释
     * 写着「与 insertCard 同事务」，只差【没跟一对括号】才没命中；
     * 谁哪天在那句里补上括号，就会在这里撞一次不需要撞的红。
     */
    expect(callersOf("insertCard", "approvals/cards.ts")).toEqual([
      SRC + "/engine/charter.ts",
      SRC + "/engine/dispatch.ts",
    ]);
    /**
     * 「建卡这条路通不通到 CEO 真会打开的那个界面」—— 这一格的口径被 0044 改写过，
     * 而【没有任何一条断言为那次改写变红】。这正是本文件记了三次的「判据没坏、
     * 它指的事实换了」那一族，所以这一版把口径本身钉成一条【有分母】的断言。
     *
     * 【旧口径｜0041 那版】「serve/ 与 http/ 里一行都不建卡，连间接路也不通」。
     *   当时那两半都成立：INSERT 名单里没有它们，而 `grep -rn "engine/" …/http/ …/serve/`
     *   零命中 ⇒ 「http 调 engine、engine 再建卡」这条间接路不存在。
     * 【新口径｜0044（章程泵）】间接路【通了，但开在一个人必须显式拧开的开关后面】：
     *   serve/charter-pump.ts import engine/charter.js 并调 ensureCharterCard，
     *   而它由 serve/assemble.ts 在 --charter-pump 打开时按心跳节奏驱动。
     *   默认（不写那个参数）⇒ 这一整块【不存在】，行为与旧口径一模一样。
     *
     * 为什么钉【调用方名单】而不是钉那条 grep：grep "engine/" 命中的是 import 语句，
     * 而"有一句 import"与"这条链真能走到建卡"是两件事（real-deps.ts 顶层那句
     * `import { approveCard }` 早就在那儿了，它不建卡）。ensureCharterCard 是
     * engine/ 里唯一建章程卡的入口，它的调用方名单【就是】那条间接路本身。
     * 而且这一发【有分母】（两个文件），所以「扫描器坏了 / 路径拼错 / 注释滤掉代码」
     * 那一族瞎法会当场显形 —— 上面那两条零名单做不到这件事，这也是它们
     * 当年配一发 searchEvents 正向对照的同一条理由。
     *
     * ⚠ 它【不】证明「CEO 现在看得见卡」。它只证明这条链在源码里连得上；
     * 开关关着、真花钱、以及本机起不起得来子进程，三件事都在断言之外
     * （0044 §9.2 记的就是这几格）。把这条读成第 6 条消掉了，是本格最容易被读错的方式。
     */
    expect(callersOf("ensureCharterCard", "engine/charter.ts")).toEqual([
      SRC + "/engine/work.ts",
      SRC + "/serve/charter-pump.ts",
    ]);
    /**
     * 上面那条名单里的第二格【有没有活调用方】—— 只判这一件，别读多。
     *
     * 这一发【不】证明「泵真被心跳驱动」，而那句是我写完才验的，验出来是反的：
     * 实测把 assemble.ts 里那一整块派发【删掉】（只留 default 那支 lambda）后，
     * 这一发【照样绿】、上面那发【也照样绿】。前者因为 `pumpCharterCards(` 这个字样
     * 还活在 `pumpVia = o.charterPumpVia ?? ((w, bus2, po) => pumpCharterCards(...))`
     * 里；后者因为 charter-pump.ts 里那句 `ensureCharterCard(` 在不在，跟
     * 【有没有人去驱动 charter-pump】是两件事，派发删掉它照样在。
     * 同一次变异真正变红的是 packages/hub/test/serve/assemble-pump.test.ts（当场 1 发红）。
     *
     * 对得上上面那份名单口径的是反向那一发：往 http/real-deps.ts 加一句
     * `ensureCharterCard()` ⇒ 上面那发【红】（多一项，名单变长）。
     * 所以三份断言各管一维，谁也别替谁背书：
     *   上面那份【有分母的建卡入口名单】挡「又多一条建卡路径」；
     *   本发挡「泵文件成了孤儿」；
     *   「泵真挂在心跳上」那一维的钉子在 assemble-pump.test.ts，不在这里。
     * 这里如果写成「证明泵由心跳驱动」，就是一句【被自己的变异实验证伪过而没改】的注释，
     * 而那种注释比没有注释更贵（0016 §1 那一族换了个载体：断言没坏，注释吹过了）。
     */
    expect(callersOf("pumpCharterCards", "serve/charter-pump.ts")).toEqual([
      SRC + "/serve/assemble.ts",
    ]);
    /**
     * 「http/ 直接建卡」这一半【今天仍然成立】，而且成立的方式值得说清：
     * real-deps.ts 顶层确实 import 了 engine/（approveCard），而它【不建卡】——
     * 它只认领已有的卡。所以「http 里有一行 import engine/」与「http 里建卡」
     * 是两个独立的命题，前者真、后者假，而上面那份 INSERT 全等名单钉的是后者。
     *
     * 下面这份 UPDATE 名单从【两条】变成【三条】就是 0041 那次改动顶红的东西本身
     * （第三条 = engine/approve.ts 的 CLAIM_CARD_SQL，`hub decide` 认领卡片那条）。
     * 三条各自的可达性【不一样】，这一格别读成"三个等价的批准写入口"：
     *   · http/real-deps.ts —— CEO 真用的那一条（serve 起的路由）；
     *   · policy/auto-approve.ts —— 自动批准，今天【零生产调用方】（本文件第 3 条）；
     *   · engine/approve.ts —— 只有 `pnpm hub:engine` 到得了，本机跑不起来。
     * 所以「批准的写路径有三条」这句听起来比实际宽：真正常在跑的【只有一条】。
     * 那份 SQL 文本【两份并存】（这边与 real-deps 的 CLAIM_APPROVAL_SQL）是刻意的，
     * 漂移代价写在 engine/approve.ts 文件头，由 approve.test.ts 那条逐字比对守着。
     */
    expect(srcFilesMatching(/UPDATE\s+approvals\b/iu)).toEqual([
      SRC + "/engine/approve.ts",
      SRC + "/http/real-deps.ts",
      SRC + "/policy/auto-approve.ts",
    ]);
  });
});
