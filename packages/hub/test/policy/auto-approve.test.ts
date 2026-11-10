/**
 * Task 3.5 验收：自动审批必须可追溯，且不可逆永不自动通过（规格 §9.1 / §22.3，计划 Test 项）。
 *
 * ── 这个文件的中心不是「规则算得对」，而是【事后追问得到答案】──────────
 * 规格 §9.1 末句把「不打扰 CEO」和「日报中可见且可追溯」写在同一行。
 * 前者省掉的是【事前那一次人工看一眼】，省不掉的是【事后有人想知道凭什么】。
 * 所以本文件一半的力气花在【落库那一行的内容】上，而不是判定结果上：
 * 判定错了当天就能发现，payload 缺字段是三个月后才发现（而且永远发现不了，
 * 因为没人能追问一条没写下来的理由）。
 *
 * ── 三条判据，各自对应一种「看起来全绿」的失效 ──────────────────────
 *  A. **不可逆那一档要有对抗用例**：只测「不可逆 ⇒ 拦」是弱断言，因为它可能
 *     只是走到了「条件不齐」那一条。必须测【证据齐 + 门控过 + 历史全批】的不可逆
 *     仍然被拦 —— 那才是 R3 与「条件不齐」可分的唯一形状。
 *  B. **降级要逐项点名**：断言的是 missing 的【精确集合】而不是 length > 0。
 *     一句「需要人工」与一句「缺证据包与门控」在 length 上可以都是 2，
 *     而只有后者能让 CEO 少重看一遍整包证据。
 *  C. **审计那一行要按字段断**，不按「有没有多一行」断。计划 Test 项原文是
 *     「自动通过必须写审计事件且**含 auto_approved_by**」—— 那个「含」是判据本身，
 *     不是附带效果。行数断言挡不住「写了一行但署的是人工的名」。
 *
 * ── 本文件【测不到】的，先说在这里 ────────────────────────────────
 * 自动批准的运行期生产者。今天没有任何生产代码调用 autoApprove（理由写在
 * auto-approve.ts 文件头：桩图的节点不执行动作，硬接等于伪造不可删除的审计行）。
 * 所以本文件测的是判定、落库、聚合三段**零件**，不是「一次真任务里规则批了 X 项」。
 * 最后一节把那件事钉成断言，接线那天它会红。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actionFingerprint,
  AUTO_APPROVED_BY,
  type AutoApproveInput,
  type AutoApproveOutcome,
  autoApprove,
  CLAIM_APPROVAL_FOR_AUTO_SQL,
  countSimilarApprovals,
  MAX_REPORT_ITEMS,
  MISSING_REASONS,
  PATTERN_MIN_APPROVALS,
  recordAutoApproval,
  readAutoApprovalReport,
} from "../../src/policy/auto-approve.js";
import { type ActionDraft, matchForbidden, policyDecide } from "../../src/policy/engine.js";
import { migrate } from "../../src/db/migrate.js";
import { openDb } from "../../src/db/driver.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = join(HUB, ".tmp", "auto-approve");
/**
 * 被测包的生产源码树。⑧ 那一节扫的是它，不是 test/ —— 扫错目录会让「零调用方」
 * 变成恒真断言（test/ 里当然没有 INSERT INTO approvals 之外的生产写路径）。
 * HUB 是 packages/hub/test（与 real-deps.test.ts 同一个口径），所以要再上一层。
 */
const SRC = join(HUB, "..", "src");

/** 静态扫源码树用。写成顶层函数而不是每个用例里各抄一份 walk：抄的那份会各自漂移。 */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}

type Row = Record<string, unknown>;
type Db = ReturnType<typeof openDb>;

const NOW = Date.UTC(2026, 0, 2, 5); // 2026-01-02
const DAY = "2026-01-02";
const opened: Db[] = [];
let fileSeq = 0;

/**
 * 真迁移出来的库。
 *
 * 不用手搓 schema 的两条理由：approvals 的 DEFAULT 'pending' 与 events 的
 * append-only 触发器只有真 schema 才有，而这两样正是本文件的判据所在
 * （卡片认领靠 pending，「审计写下去就删不掉」是 R3 必须存在于代码里的根本原因）。
 */
function newDb(): Db {
  const db = openDb(join(TMP, "a-" + process.pid + "-" + ++fileSeq + ".db"));
  migrate(db as unknown as Parameters<typeof migrate>[0]);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('task-1', '自动审批夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(NOW, NOW);
  opened.push(db);
  return db;
}

function approval(db: Db, id: string, type = "strategic", status?: string): void {
  if (status === undefined) {
    db.prepare(
      "INSERT INTO approvals (id, task_id, approval_type, summary, parameters) " +
        "VALUES (?, 'task-1', ?, '一句话摘要', '{}')",
    ).run(id, type);
    return;
  }
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
      "VALUES (?, 'task-1', ?, '一句话摘要', '{}', ?)",
  ).run(id, type, status);
}

const act = (over: Partial<ActionDraft> = {}): ActionDraft => ({
  kind: "read_repo",
  detail: "read src/a.ts",
  ...over,
});

/** R1 全齐的输入。命名成一个函数：多处「只差一格」的用例都从它出发改一格。 */
const r1Ready = (over: Partial<AutoApproveInput> = {}): AutoApproveInput => ({
  action: act(),
  evidence: { ok: true, checked: 3 },
  gate: { passed: true, gate: "dev_to_test" },
  ...over,
});

const decisionOf = (o: AutoApproveInput): AutoApproveOutcome["decision"] =>
  autoApprove(o).decision;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterAll(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("① R1：只读 + 证据包完整 + 门控通过", () => {
  it("三格齐 ⇒ auto_approved，规则是 read_only_evidence_gate", () => {
    const r = autoApprove(r1Ready());
    expect(r.decision).toBe("auto_approved");
    if (r.decision === "auto_approved") {
      expect(r.rule).toBe("read_only_evidence_gate");
      expect(r.tier).toBe("read_only");
    }
  });

  it("证据包 ok=false ⇒ 拦，且点名 evidence_incomplete", () => {
    const r = autoApprove(r1Ready({ evidence: { ok: false } }));
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(r.blocked_by).toBe("conditions_unmet");
      // 精确集合而不是 length：「需要人工」与「缺证据包」给 CEO 的成本差一整包证据。
      expect(new Set(r.missing)).toEqual(new Set(["evidence_incomplete"]));
      expect(r.note).toContain("evidence_incomplete");
    }
  });

  it("门控 passed=false ⇒ 拦，且点名 gate_not_passed", () => {
    const r = autoApprove(r1Ready({ gate: { passed: false, gate: "dev_to_test" } }));
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(new Set(r.missing)).toEqual(new Set(["gate_not_passed"]));
    }
  });

  it("证据与门控【都没给】⇒ 两个原因都列出来，不是只报第一个", () => {
    const r = autoApprove({ action: act() });
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(new Set(r.missing)).toEqual(new Set(["evidence_missing", "gate_missing"]));
    }
  });

  it("反向对照：三格齐时 missing 是空 —— 否则上面三条可能是恒真", () => {
    const r = autoApprove(r1Ready());
    if (r.decision !== "auto_approved") throw new Error("前置不成立");
    // 「auto_approved 的判定里没有 missing 这个字段」也要成立：判别式而非可选字段。
    expect(Object.hasOwn(r, "missing")).toBe(false);
  });

  it("evidence.checked 不参与判定（它只是证据强度，不是闸门）", () => {
    expect(decisionOf(r1Ready({ evidence: { ok: true, checked: 0 } }))).toBe(
      "auto_approved",
    );
  });
});

describe("② R2：可逆 + 过去 N 次同类决策均批准", () => {
  const rev = (over: Partial<AutoApproveInput> = {}): AutoApproveInput => ({
    action: act({ kind: "edit_file", detail: "编辑 src/a.ts" }),
    ...over,
  });

  it("恰好 PATTERN_MIN_APPROVALS 次全批 ⇒ auto_approved", () => {
    const r = autoApprove(
      rev({
        history: {
          approvals: PATTERN_MIN_APPROVALS,
          nonApprovals: 0,
        },
      }),
    );
    expect(r.decision).toBe("auto_approved");
    if (r.decision === "auto_approved") expect(r.rule).toBe("pattern_reversible");
  });

  it("差一次 ⇒ 拦，且点名 history_below_threshold（不是 history_missing）", () => {
    const r = autoApprove(
      rev({ history: { approvals: PATTERN_MIN_APPROVALS - 1, nonApprovals: 0 } }),
    );
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(new Set(r.missing)).toEqual(new Set(["history_below_threshold"]));
    }
  });

  it("有一次打回 ⇒ 模式断了，即使批准次数远超阈值（§9.1 原文是【均】批准）", () => {
    const r = autoApprove(
      rev({ history: { approvals: 500, nonApprovals: 1 } }),
    );
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(new Set(r.missing)).toEqual(new Set(["history_not_unanimous"]));
    }
  });

  it("历史【完全没给】⇒ 拦且点名 history_missing，绝不默认放行", () => {
    expect(decisionOf(rev())).toBe("require_approval");
    const r = autoApprove(rev());
    if (r.decision === "require_approval") {
      expect(new Set(r.missing)).toEqual(new Set(["history_missing"]));
    }
    // 只给 approvals 不给 nonApprovals 也算不知道：知道一半不等于知道。
    const half = autoApprove(rev({ history: { approvals: 50 } }));
    if (half.decision === "require_approval") {
      expect(new Set(half.missing)).toEqual(new Set(["history_missing"]));
    }
  });

  it("R2 【不】额外要求证据包与门控（§9.1 那一行没写这两格）", () => {
    // 加严是实现层的偏好，而 §4.4.3 把收紧/放宽归 CEO。这条钉住边界。
    expect(
      decisionOf(
        rev({ history: { approvals: PATTERN_MIN_APPROVALS, nonApprovals: 0 } }),
      ),
    ).toBe("auto_approved");
  });
});

describe("③ R3：不可逆永不自动通过", () => {
  /** 对抗夹具：R1 与 R2 的前置【全给满】。 */
  const everything = (detail: string): AutoApproveInput => ({
    action: act({ kind: "production_deploy", detail }),
    evidence: { ok: true, checked: 10 },
    gate: { passed: true, gate: "test_upward" },
    history: { approvals: 999, nonApprovals: 0 },
  });

  it("证据齐 + 门控过 + 历史 999 次全批 ⇒ 仍然 require_approval", () => {
    for (const detail of ["git push origin main", "发布 v1.2 到生产", "付款 3000 美元"]) {
      const r = autoApprove(everything(detail));
      expect(r.decision, detail).toBe("require_approval");
      if (r.decision === "require_approval") {
        // 不是 conditions_unmet：条件其实全齐。拦下它的是 R3 这条【否决】。
        expect(r.blocked_by, detail).toBe("irreversible");
        expect(r.missing, detail).toEqual([]);
        expect(r.tier, detail).toBe("irreversible");
        expect(r.note, detail).toContain("永不自动通过");
      }
    }
  });

  it("未知动作也拦得住（engine 的 fail-closed 在这一层同样是不可逆）", () => {
    const r = autoApprove({
      action: act({ kind: "brand_new_kind", detail: "一种我们没见过的手法" }),
      evidence: { ok: true },
      gate: { passed: true },
      history: { approvals: 999, nonApprovals: 0 },
    });
    if (r.decision === "require_approval") {
      expect(r.blocked_by).toBe("irreversible");
    } else {
      throw new Error("未知动作被自动通过了 —— fail-closed 破了");
    }
  });

  it("反向对照：把同一条动作换成可逆，前置全给满就应当自动通过", () => {
    // 少了这一半，上面两条可能只是「everything() 里哪一格都没生效」的恒真断言。
    const r = autoApprove({
      action: act({ kind: "edit_file", detail: "编辑 src/a.ts" }),
      evidence: { ok: true, checked: 10 },
      gate: { passed: true, gate: "test_upward" },
      history: { approvals: 999, nonApprovals: 0 },
    });
    expect(r.decision).toBe("auto_approved");
  });
});

describe("④ 黑名单优先于自动通过", () => {
  it("只读动作 + 三格齐，但命中黑名单 ⇒ forbidden 分支且不带 missing", () => {
    // detail 写成「读取 secrets 目录」而不是「读取 src/secrets.ts」：
    // matchForbidden 是【子串】双向包含，条目「读取 secrets」含不住后者
    // （中间隔了 " src/"）。第一版我写的就是 src/secrets.ts，那条用例其实
    // 什么都没测（黑名单没命中，走的是 R1 正常放行）—— 同一个夹具病第五次。
    const r = autoApprove({
      ...r1Ready({ action: act({ kind: "read_repo", detail: "读取 secrets 目录" }) }),
      forbidden: ["读取 secrets"],
    });
    expect(r.decision).toBe("require_approval");
    if (r.decision === "require_approval") {
      expect(r.blocked_by).toBe("forbidden");
      expect(r.missing).toEqual([]);
      expect(r.note).toContain("黑名单");
    }
  });

  it("反向对照：把黑名单清空，同一条动作应当自动通过（否则上一条可能是恒真）", () => {
    expect(
      decisionOf(
        r1Ready({ action: act({ kind: "read_repo", detail: "读取 secrets 目录" }) }),
      ),
    ).toBe("auto_approved");
  });

  it("黑名单优先于【模式】那一档：可逆 + 历史全批照样拦", () => {
    const r = autoApprove({
      action: act({ kind: "edit_file", detail: "编辑 src/a.ts", role_id: "dev" }),
      forbidden: ["dev 改 src"],
      history: { approvals: 999, nonApprovals: 0 },
    });
    if (r.decision === "require_approval") {
      expect(r.blocked_by).toBe("forbidden");
    } else {
      throw new Error("规则绕过黑名单：自动通过的权限比角色岗位书还大");
    }
  });
});

describe("⑤ 落库那一行：计划 Test 项『含 auto_approved_by』的逐字段验收", () => {
  const eventsOf = (db: Db): Row[] =>
    db.prepare("SELECT * FROM events ORDER BY id").all() as Row[];

  it("自动通过写一行审计，actor = system/policy-engine，payload 含 auto_approved_by", () => {
    const db = newDb();
    approval(db, "ap-1");
    const rec = recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "ap-1",
      nowMs: NOW,
    });
    const rows = eventsOf(db);
    expect(rows).toHaveLength(1);
    const e = rows[0] as Row;
    expect(e["actor_type"]).toBe("system");
    expect(e["actor_id"]).toBe(AUTO_APPROVED_BY);
    expect(e["action"]).toBe("approval");
    expect(e["target"]).toBe("ap-1");
    const p = JSON.parse(String(e["payload"])) as Record<string, unknown>;
    expect(p["auto_approved_by"]).toBe(AUTO_APPROVED_BY);
    // 判定用的三格事实【全部】进 payload。理由见文件头：自动批准少了一个知情的人，
    // 事后唯一能追问的就是这一行；只写「规则批了」等于让人回头去问调用方。
    expect(p["evidence"]).toEqual({ ok: true, checked: 3 });
    expect(p["gate"]).toEqual({ passed: true, gate: "dev_to_test" });
    expect(p["rule"]).toBe("read_only_evidence_gate");
    expect(String(p["action_fingerprint"])).toHaveLength(16);
    expect(rec.card_claimed).toBe(true);
    // seq 必须是 events.id（游标口径，同 0005 那条「seq 只能来自 events.id」）。
    expect(rec.seq).toBe(Number(e["id"]));
  });

  it("卡片真的被认领：status=approved 而 decided_by 不是 ceo", () => {
    const db = newDb();
    approval(db, "ap-2");
    recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "ap-2",
      nowMs: NOW,
    });
    const a = db
      .prepare("SELECT * FROM approvals WHERE id = 'ap-2'")
      .get() as Row;
    expect(a["status"]).toBe("approved");
    // decided_by 写的是策略引擎而不是 "ceo"：那一列的意思是【谁】，
    // 把自动批准写成人的名字就是【伪造签名】，而它是人机之分的唯一列级出处。
    expect(a["decided_by"]).toBe(AUTO_APPROVED_BY);
    expect(String(a["decision_note"])).toContain("自动批准");
  });

  it("没有卡片也写审计，并把 card.present=false 记进 payload（缺口进数据不进注释）", () => {
    const db = newDb();
    const rec = recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      nowMs: NOW,
    });
    expect(rec.card_claimed).toBe(false);
    expect(rec.payload["card"]).toEqual({ present: false, claimed: false });
    // target 退化成动作指纹而不是 null：null 的行无法问责（recorder 对空 actor 同立场）。
    expect(String(rec.payload["card"]["present"])).toBe("false");
    const e = eventsOf(db)[0] as Row;
    expect(String(e["target"]).startsWith("action:")).toBe(true);
  });

  it("卡片不存在时【不抛错】但如实记 card.claimed=false（今天的真库就是这种形状）", () => {
    const db = newDb();
    const rec = recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "ghost-card",
      nowMs: NOW,
    });
    expect(rec.card_claimed).toBe(false);
    expect(eventsOf(db)).toHaveLength(1);
  });

  it("卡片已被人工批掉 ⇒ 不覆盖、不写第二次，claimed=false", () => {
    const db = newDb();
    approval(db, "ap-3", "strategic", "approved");
    const rec = recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "ap-3",
      nowMs: NOW,
    });
    expect(rec.card_claimed).toBe(false);
    const a = db.prepare("SELECT * FROM approvals WHERE id = 'ap-3'").get() as Row;
    // decided_by 仍是原来那个人：条件写带 status='pending'，抢不到就一行都不动。
    expect(String(a["decided_by"])).not.toBe(AUTO_APPROVED_BY);
  });

  it("认领那条 SQL 的 WHERE 里有 status='pending'（幂等承重那一半，钉在常量上）", () => {
    expect(CLAIM_APPROVAL_FOR_AUTO_SQL).toContain("AND status = 'pending'");
    // 反向对照：光有 WHERE id=? 也能「跑通」，但并发第二次会把审计再写一遍。
    expect(CLAIM_APPROVAL_FOR_AUTO_SQL).toContain("WHERE id = ?");
  });

  it("降级判定传进来 ⇒ 【抛错】，不写任何审计（署错名是伪证）", () => {
    const db = newDb();
    const downgraded = autoApprove({ action: act() });
    expect(downgraded.decision).toBe("require_approval");
    expect(() =>
      recordAutoApproval(db, {
        taskId: "task-1",
        outcome: downgraded,
        nowMs: NOW,
      }),
    ).toThrow(/auto_approved/);
    expect(eventsOf(db)).toHaveLength(0);
  });

  it("自动通过写不进任何【不可逆】判定（recordAutoApproval 收到的 tier 恒非 irreversible）", () => {
    const db = newDb();
    expect(() =>
      recordAutoApproval(db, {
        taskId: "task-1",
        outcome: autoApprove({
          action: act({ kind: "production_deploy", detail: "发布到生产" }),
          evidence: { ok: true },
          gate: { passed: true },
          history: { approvals: 999, nonApprovals: 0 },
        }),
        nowMs: NOW,
      }),
    ).toThrow();
    expect(eventsOf(db)).toHaveLength(0);
  });
});

describe("⑥ 日报聚合（§9.1 末句『可见且可追溯』的数据那一半）", () => {
  it("当天的自动批准全部出现，总数与按规则计数对得上", () => {
    const db = newDb();
    for (const [id, input] of [
      ["d1", r1Ready()],
      [
        "d2",
        {
          action: act({ kind: "edit_file", detail: "编辑 src/b.ts" }),
          history: { approvals: PATTERN_MIN_APPROVALS, nonApprovals: 0 },
        } as AutoApproveInput,
      ],
      ["d3", r1Ready()],
    ] as const) {
      recordAutoApproval(db, {
        taskId: "task-1",
        outcome: autoApprove(input),
        approvalId: id,
        nowMs: NOW,
      });
    }
    const rep = readAutoApprovalReport(db, { day: DAY });
    expect(rep.total).toBe(3);
    expect(rep.items).toHaveLength(3);
    expect(rep.by_rule).toEqual({
      read_only_evidence_gate: 2,
      pattern_reversible: 1,
    });
    expect(rep.has_more).toBe(false);
  });

  it("非自动批准的 approval 行【不进】日报（LIKE 那种写法会把它们混进来）", () => {
    const db = newDb();
    recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "w-1",
      nowMs: NOW,
    });
    // 两条干扰：① 一次人工批准；② 一条【提到了 auto_approved_by 这个词】的报错审计。
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','human','ceo','approval','h-1','{\"resume\":\"approve\"}',?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','system','hub','approval','x-1',?,?)",
    ).run(JSON.stringify({ error: "auto_approved_by 这一列不可用" }), NOW);
    const rep = readAutoApprovalReport(db, { day: DAY });
    expect(rep.total).toBe(1);
    // 这条是对【判据本身】的元断言：上面那两条干扰如果换成 LIKE 写法就会进结果集
    // （实测 LIKE 给 3、json_extract 给 1）。没有这一格，选择条件写错也照样全绿。
    expect(db.prepare("SELECT COUNT(*) AS c FROM events WHERE payload LIKE '%auto_approved_by%'").get())
      .toMatchObject({ c: 2 });
  });

  it("别的日子不进这一页；total 不受 limit 影响", () => {
    const db = newDb();
    recordAutoApproval(db, { taskId: "task-1", outcome: autoApprove(r1Ready()), approvalId: "e1", nowMs: NOW });
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','system','policy-engine','approval','e2',?,?)",
    ).run(
      JSON.stringify({ auto_approved_by: AUTO_APPROVED_BY, rule: "read_only_evidence_gate", card: { present: true, claimed: true } }),
      NOW + 86_400_000,
    );
    expect(readAutoApprovalReport(db, { day: DAY }).total).toBe(1);
    expect(readAutoApprovalReport(db, { day: "2026-01-03" }).total).toBe(1);
    const paged = readAutoApprovalReport(db, { day: DAY, limit: 1 });
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(1);
    expect(paged.has_more).toBe(false);
  });

  it("limit 小于当天总数 ⇒ has_more=true，而 total 仍是全天的数", () => {
    const db = newDb();
    for (let i = 0; i < 5; i++) {
      recordAutoApproval(db, {
        taskId: "task-1",
        outcome: autoApprove(r1Ready({ action: act({ detail: "read src/" + i + ".ts" }) })),
        approvalId: "p" + i,
        nowMs: NOW,
      });
    }
    const p = readAutoApprovalReport(db, { day: DAY, limit: 2 });
    expect(p.items).toHaveLength(2);
    // 窗口函数在 LIMIT 之前求值（实测 LIMIT 1 时 total_rows 仍是 5）。
    // 这一格钉的是【那条 SQL 真的如此】：写成两条查询时两次之间的写入会让这里红。
    expect(p.total).toBe(5);
    expect(p.has_more).toBe(true);
  });

  it("card_unclaimed 把「审计说批了而卡片还在 pending」那几次数出来", () => {
    const db = newDb();
    recordAutoApproval(db, { taskId: "task-1", outcome: autoApprove(r1Ready()), approvalId: "ghost", nowMs: NOW });
    recordAutoApproval(db, { taskId: "task-1", outcome: autoApprove(r1Ready()), approvalId: "real", nowMs: NOW });
    approval(db, "real2");
    const rep = readAutoApprovalReport(db, { day: DAY });
    expect(rep.total).toBe(2);
    expect(rep.card_unclaimed).toBe(2); // ghost 不存在；real 也没预先插过
  });

  it("当天一条都没有 ⇒ total=0 而不是缺省值，has_more=false", () => {
    const db = newDb();
    const rep = readAutoApprovalReport(db, { day: DAY });
    expect(rep.total).toBe(0);
    expect(rep.items).toEqual([]);
    expect(rep.has_more).toBe(false);
  });

  it("当天有【毫不相干的】畸形 payload ⇒ 拒绝出数并点名那一行（不让整页故障无出处）", () => {
    const db = newDb();
    recordAutoApproval(db, { taskId: "task-1", outcome: autoApprove(r1Ready()), approvalId: "g-1", nowMs: NOW });
    // 一条 action='state_change' 的坏行：它根本不会进日报结果集，
    // 但 SQL 里 WHERE 上的 json_extract 照样会对它求值并抛 malformed JSON。
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','system','hub','state_change','a->b','{not json',?)",
    ).run(NOW);
    let msg = "";
    try {
      readAutoApprovalReport(db, { day: DAY });
    } catch (e) {
      msg = String(e);
    }
    expect(msg).toContain("不是合法 JSON");
    expect(msg).toContain("state_change"); // 点名的必须是【那条坏行】，不是日报自己
  });

  it("limit 被夹到 MAX_REPORT_ITEMS（日报不能成为一次无界全表读）", () => {
    const db = newDb();
    const rep = readAutoApprovalReport(db, { day: DAY, limit: MAX_REPORT_ITEMS * 5 });
    expect(rep.items.length).toBeLessThanOrEqual(MAX_REPORT_ITEMS);
  });
});

describe("⑦ countSimilarApprovals：R2 的唯一可计算来源", () => {
  it("按 approval_type 分别数 approved 与 rejected/deferred", () => {
    const db = newDb();
    approval(db, "s1", "budget_override", "approved");
    approval(db, "s2", "budget_override", "approved");
    approval(db, "s3", "budget_override", "rejected");
    approval(db, "s4", "budget_override", "deferred");
    approval(db, "s5", "strategic", "approved");
    approval(db, "s6", "budget_override"); // pending：两边都不算
    expect(countSimilarApprovals(db, { approvalType: "budget_override" })).toEqual({
      approvals: 2,
      nonApprovals: 2,
    });
    expect(countSimilarApprovals(db, { approvalType: "strategic" })).toEqual({
      approvals: 1,
      nonApprovals: 0,
    });
  });

  it("空表 ⇒ 两个 0（查出来的 0，不是缺省值）", () => {
    const db = newDb();
    expect(countSimilarApprovals(db, { approvalType: "budget_override" })).toEqual({
      approvals: 0,
      nonApprovals: 0,
    });
  });

  it("0 次历史喂进 autoApprove ⇒ 必然转人工（方向是 fail-closed）", () => {
    const db = newDb();
    const h = countSimilarApprovals(db, { approvalType: "budget_override" });
    const r = autoApprove({
      action: act({ kind: "edit_file", detail: "编辑 src/a.ts" }),
      history: h,
    });
    expect(r.decision).toBe("require_approval");
  });
});

describe("⑧ 接线状态（接线那天这条会红，逼着同时更新 0014）", () => {
  it("src 里没有任何代码创建 approvals 行 ⇒ 卡片认领那一路在真库里走不到", () => {
    // 0013 §10.1 的实测结论，钉成断言：Task 3.5 的「自动通过一张卡片」今天
    // 只能对【测试自己插进去的行】生效。全绿不等于接上了。
    const files = tsFiles(SRC);
    const writers = files.filter((f) =>
      /["']INSERT INTO approvals[ (]/u.test(readFileSync(f, "utf8")),
    );
    expect(writers.map((f) => f.replace(SRC + "/", ""))).toEqual([]);
  });

  it("policy 模块的自动批准在生产 src 里【还没有调用方】（已知缺口，不是实现遗漏）", async () => {
    const files = tsFiles(SRC);
    const callers = files.filter(
      (f) =>
        !f.endsWith("policy/auto-approve.ts") &&
        /autoApprove\(|recordAutoApproval\(/u.test(readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => f.replace(SRC + "/", ""))).toEqual([]);
  });

  it("消费侧【已经】接上：回放视图会带上这条标注（生产者到位那天立刻有数据）", () => {
    // 只有生产者没有消费者是白写，只有消费者没有生产者是可接。
    // 这一格钉住后一半是真的：标注代码在 replay/query.ts 里，不是在我的文档里。
    //
    // 判据取 payload 的【字段名】与界面措辞，不取 AUTO_APPROVED_BY 这个【值】。
    // 我第一版写的正是 toContain(AUTO_APPROVED_BY)，它红过一轮 —— 红是对的，
    // 那次红真的把 query.ts 的标注代码逼出来了。但它有个更阴的问题：
    // 即使按现在这样正确接上，它也【永远不会转绿】。因为读侧刻意不写这个值
    // （query.ts 判的是 payload.auto_approved_by 这个键，署名换不改读侧），
    // 全文 "policy-engine" 命中 0 是【正确实现的形状】而不是缺口。
    // 一条【怎么修都红】的断言比一条恒绿的更贵：它的唯一出路是被人删掉。
    // 键才是两侧的契约（写侧与读侧各自独立写下同一个字符串），键改了才该红。
    //
    // 这条仍然弱：grep 分不出【代码里有】与【注释里有】，而 query.ts 的注释里
    // 恰好也写着「基于模式的自动批准」。真正有分辨力的是 ⑨ 那两节 ——
    // 它们从真库走一遍 buildReplayView，并带一条人工批准的反向对照。
    const src = readFileSync(join(SRC, "replay", "query.ts"), "utf8");
    expect(src).toContain("auto_approved_by");
    expect(src).toContain("基于模式的自动批准");
  });
});

describe("⑨ §22.3 第二条的回放标注（消费侧）", () => {
  it("自动批准那一条带上标注；同任务的人工批准不带", async () => {
    const { buildReplayView } = await import("../../src/replay/query.js");
    const db = newDb();
    approval(db, "ann-1");
    recordAutoApproval(db, {
      taskId: "task-1",
      outcome: autoApprove(r1Ready()),
      approvalId: "ann-1",
      nowMs: NOW,
    });
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','human','ceo','approval','ann-2','{\"resume\":\"approve\"}',?)",
    ).run(NOW + 1);

    const view = buildReplayView(db as never, { taskId: "task-1" });
    if (view === null) throw new Error("任务应当存在");
    const auto = view.entries.find((e) => e.target === "ann-1");
    const human = view.entries.find((e) => e.target === "ann-2");
    expect(auto?.auto_approved).toEqual({
      by: AUTO_APPROVED_BY,
      rule: "read_only_evidence_gate",
      annotation: "基于模式的自动批准",
    });
    // 反向对照：同一张任务里的人工批准【不能】被标上。少了这一半，
    // 「所有 approval 行都被标成自动批准」这种实现也能让上面那条绿。
    expect(human).toBeDefined();
    expect(Object.hasOwn(human as object, "auto_approved")).toBe(false);
  });

  it("payload 解不开的自动批准行【不标注】（不给读不出来的行下一个肯定结论）", async () => {
    const { buildReplayView } = await import("../../src/replay/query.js");
    const db = newDb();
    // 绕过 appendAudit 直写一条非法 JSON，但 action 与 actor 都长得像自动批准。
    db.prepare(
      "INSERT INTO events (task_id, actor_type, actor_id, action, target, payload, created_at) " +
        "VALUES ('task-1','system','policy-engine','approval','bad-1','{not json',?)",
    ).run(NOW);
    const view = buildReplayView(db as never, { taskId: "task-1" });
    const e = view?.entries.find((x) => x.target === "bad-1");
    expect(e?.degraded).toBe(true);
    expect(Object.hasOwn(e as object, "auto_approved")).toBe(false);
  });
});

describe("⑩ blocked_by 的四个值【实际】到得了几个（dead branch 登记）", () => {
  it("policy_forbidden 结构上不可达：黑名单被上游那一发先拦，两个 blocked_by 是同一件事的两个名字", () => {
    /*
     * autoApprove 的顺序是「matchForbidden → policyDecide」。而 policyDecide 内部
     * 判 forbidden 用的正是【同一个 matchForbidden、同一组入参】（engine.ts:204）。
     * 所以第一发返回 undefined 之后，第二发不可能判 forbidden ⇒
     * `blocked_by: "policy_forbidden"` 那一支【永远走不到】。
     *
     * 这一条与 0013 记的「FTS 0 命中 ⇒ 降级 LIKE 永远不可达」同族，而这里更糟一点：
     * 那个不可达分支不影响输出，这一个不可达分支【是一个对外承诺的输出值】——
     * BlockedBy 把它列进枚举、注释里写着「策略侧同一条」，谁按它做统计就会永远得 0，
     * 并把 0 读成「这周没有动作被策略拦下」。真相是被拦下的都记成了 "forbidden"。
     *
     * 处置：**保留分支**（它是「万一有人把上游那发删了」的兜底，删掉反而把安全性
     * 绑在调用顺序上），但把「两个名字其实是同一件事」钉成断言：
     * 只要 policyDecide 判 forbidden，autoApprove 必须报 "forbidden"。
     * 这条断言的判别力在于它同时看了两侧 —— 单看 autoApprove 或单看 policyDecide
     * 都看不出这两个来源是同一个函数。
     */
    const matrix = [
      { a: act({ detail: "读取 secrets 目录" }), forbidden: ["读取 secrets"] },
      { a: act({ kind: "publish", detail: "发布" }), forbidden: ["对外发布需 CEO 批准"] },
      { a: act({ role_id: "dev", detail: "自行合并到主干" }), forbidden: ["自行合并到主干"] },
      { a: act({ detail: "付款 500 元" }), forbidden: ["付款"] },
    ];
    for (const c of matrix) {
      const pd = policyDecide(c.a, { forbidden: c.forbidden });
      expect(pd.action, JSON.stringify(c)).toBe("forbidden");
      const out = autoApprove({ action: c.a, forbidden: c.forbidden });
      expect(out.decision, JSON.stringify(c)).toBe("require_approval");
      if (out.decision !== "require_approval") continue;
      expect(out.blocked_by, JSON.stringify(c)).toBe("forbidden");
    }
    /*
     * 反向对照【不用 matrix.length > 0】—— 那种断言恒真，是我会写出来的那一类假对照
     * （0013 §8 的教训：反向对照必须经过被测代码）。这里真的把同一批动作在
     * 【黑名单为空】时再判一遍：它们必须都不报 forbidden。
     * 少了这一半，「夹具本身就被判 forbidden」这种实现也能让上面那个循环全绿，
     * 而那条循环就在宣称「是黑名单造成了拦住」。
     */
    for (const c of matrix) {
      const out = autoApprove({ action: c.a, forbidden: [] });
      if (out.decision === "require_approval") {
        expect(out.blocked_by, JSON.stringify(c.a)).not.toBe("forbidden");
      }
      expect(matchForbidden(c.a, []), JSON.stringify(c.a)).toBeUndefined();
    }
  });
});
