/**
 * 审批卡片的**读侧**（src/approvals/query.ts，`GET /approvals` 的那一条查询）。
 *
 * ── 这一文件在证什么 ──────────────────────────────────────────────────
 * 0013 §10.1 之前这张表【没有任何写入方】，所以整个读侧从未在真数据上跑过；
 * cards.ts 补上创建路径之后，读侧第一次有了分母，也就第一次可能错。
 * 断言按【错了会怎样】排序，不是按代码行序：
 *   ① pendingTotal 恒对：它是收件箱角标唯一能对账的数（events/bus.ts 那段注释
 *      点名的就是这条缺失的对账源）。它错了，比这个端点不存在更糟。
 *   ② 默认与回落都落在 pending：拼错的过滤参数不能把收件箱换成全量历史。
 *   ③ 排序不靠方言运气：created_at 是 0004 才补的，存量行 NULL，
 *      「最老的在最上面」不能变成「不知年龄的排最上面」。
 *   ④ 脏 parameters 不能让收件箱 500：那一格是 JSON 文本，读不出原因只是少一个分组标签。
 *   ⑤ 出参形状：不带 parameters 全文与 decision_note（视图字段表见 contracts 的注释）。
 *
 * ── 为什么这里有一发【源码级】断言 ──────────────────────────────────
 * 「卡片待批」这条判据有四个使用者：建卡的初值、列表的默认过滤、排序里那个 CASE、
 * 以及 real-deps.ts 认领时的 `WHERE status = 'pending'`。
 * 前三处已经共享 contracts 的 APPROVAL_STATUS_PENDING（编译期同源），
 * 第四处是 SQL 文本里的字面量，TS 常量【没法】伸进字符串里 ——
 * 那是这一发源码扫描存在的全部理由：它是这四处里唯一一处【不能靠类型】的。
 * 若将来那条 SQL 改成绑参（`AND status = ?` 由调用方喂常量），这一发就该删掉，
 * 而不是留着继续绿（一条失去分母的断言比没有断言更坏，见 0007 §4.1）。
 *
 * ── 夹具目录带 pid + 真库真迁移 ─────────────────────────────────────
 * 同 cards.test.ts 文件头两条理由（0025 §7 末条那次 63-fail 假警报；
 * 排序里那个 NULL-last 的 CASE 只有真 SQLite 能验）。
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { APPROVAL_STATUS_PENDING } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import {
  APPROVAL_COLUMNS,
  APPROVAL_DETAIL_COLUMNS,
  APPROVAL_ORDER,
  approvalDetailViewOf,
  approvalViewOf,
  clampLimit,
  DEFAULT_APPROVAL_LIMIT,
  escalationReasonOf,
  listApprovals,
  MAX_APPROVAL_LIMIT,
  parametersObjectOf,
  readApprovalDetail,
} from "../../src/approvals/query.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = fixtureTmp("approvals-query", import.meta.url);

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const HOUR = 3_600_000;

/** 真代码行：把注释行剔掉再扫，否则注释里那句「WHERE status = 'pending'」也算命中。 */
function codeLines(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter(
      (l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"),
    );
}

const opened: DatabaseSync[] = [];
let seq = 0;

function fresh(): DatabaseSync {
  const path = join(TMP, "q-" + ++seq + ".db");
  const db = openDb(path) as unknown as DatabaseSync;
  opened.push(db);
  migrate(db);
  db.prepare(
    "INSERT INTO tasks (id, title, status, assigned_role, current_node, created_at, updated_at) " +
      "VALUES ('t-1', '读侧夹具', 'IN_PROGRESS', 'dev', 'implement', ?, ?)",
  ).run(T0, T0);
  return db;
}

interface CardOpts {
  readonly status?: string;
  readonly type?: string;
  readonly createdAt?: number | null;
  readonly parameters?: string | null;
  readonly note?: string | null;
  /** 证据引用（0008）。undefined = 不写这一列（NULL）；传字符串数组 JSON。 */
  readonly evidence_refs?: string | null;
  /** 影子判定读的就是这一格；缺省仍是「摘要 <id>」。 */
  readonly summary?: string;
}

/** 直插而不是走 createCard：这一篇要能造出 createCard 【造不出来】的脏行。 */
function card(db: DatabaseSync, id: string, o: CardOpts = {}): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +
      "recommendation, recommendation_source, timeout_behavior, timeout_at, status, " +
      "decided_by, decided_at, decision_note, card_key, created_at, evidence_refs) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "t-1",
    o.type ?? "escalation",
    o.summary ?? "摘要 " + id,
    o.parameters ?? "{}",
    null,
    null,
    "auto_reject",
    T0 + 8 * HOUR,
    o.status ?? "pending",
    null,
    null,
    o.note ?? null,
    null,
    o.createdAt === undefined ? T0 : o.createdAt,
    // undefined（没传这一格）⇒ 不写 evidence_refs ⇒ 落 NULL。
    o.evidence_refs ?? null,
  );
}

afterAll(() => {
  for (const o of opened) {
    try {
      o.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

mkdirSync(TMP, { recursive: true });

describe("① pendingTotal：那个角标唯一能对账的数", () => {
  it("⭐ 被 limit 截断时，pendingTotal 仍是库里的待批总数（不是本页长度）", () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) card(db, "c" + i, { createdAt: T0 + i * HOUR });
    const r = listApprovals(db, { limit: 2 });
    expect(r.approvals).toHaveLength(2);
    expect(r.pendingTotal).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it("⭐ 反向对照：不截断时 truncated=false —— 否则 truncated 这个字段没在报任何东西", () => {
    const db = fresh();
    for (let i = 0; i < 3; i++) card(db, "c" + i, { createdAt: T0 + i * HOUR });
    const r = listApprovals(db, { limit: 3 });
    expect(r.approvals).toHaveLength(3);
    expect(r.truncated).toBe(false);
    expect(r.pendingTotal).toBe(3);
  });

  it("⭐ status=approved 那一页里，pendingTotal 报的还是【待批数】", () => {
    /*
     * 看着别扭，但这正是这个端点存在的理由：角标那个数必须与「当前在看哪一档」无关。
     * 若它跟着 status 走，切一个 tab 角标就变 —— 而那恰是 0013 §10.1 之前
     * 「只能靠自己不丢不重来维持正确」的那个数字的病根。
     */
    const db = fresh();
    card(db, "p1");
    card(db, "a1", { status: "approved", createdAt: T0 });
    card(db, "a2", { status: "approved", createdAt: T0 + HOUR });
    const r = listApprovals(db, { status: "approved" });
    // 已批那一档内部同样是「最老的在最上面」（a1 比 a2 早一小时）。
    expect(r.approvals.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(r.pendingTotal).toBe(1);
  });

  it("空库 ⇒ 0 / [] / false，而不是 undefined", () => {
    const db = fresh();
    const r = listApprovals(db);
    expect(r).toMatchObject({
      approvals: [],
      pendingTotal: 0,
      truncated: false,
    });
  });
});

describe("② 默认与回落：拼错的过滤参数不能把收件箱换成全量历史", () => {
  it("⭐ 不传 status ⇒ 只有 pending：已批的不能占第一屏", () => {
    const db = fresh();
    card(db, "p1");
    card(db, "d1", { status: "deferred" });
    card(db, "a1", { status: "approved" });
    const r = listApprovals(db);
    expect(r.approvals.map((a) => a.id)).toEqual(["p1"]);
    expect(r.statusFilter).toBe("pending");
  });

  it("⭐ 非法 status ⇒ 回落到 pending，且【把实际生效的那一档报出来】", () => {
    /*
     * 回落本身不能静默：界面写着「全部」而只列出待批，那不是「少一个过滤器」，
     * 是给了一个看起来没坏的错过滤（statusFilter 这一格就是为了不能静默而存在）。
     */
    const db = fresh();
    card(db, "p1");
    card(db, "a1", { status: "approved" });
    for (const bad of ["all", "PENDING", "", "pending ", "任意"]) {
      const r = listApprovals(db, { status: bad });
      expect(
        r.approvals.map((a) => a.id),
        "status=" + JSON.stringify(bad),
      ).toEqual(["p1"]);
      expect(r.statusFilter).toBe("pending");
    }
  });

  it("四个合法取值各返回各的那一档（白名单在 contracts，不在这里重写）", () => {
    const db = fresh();
    card(db, "p1");
    card(db, "a1", { status: "approved" });
    card(db, "r1", { status: "rejected" });
    card(db, "f1", { status: "deferred" });
    for (const [s, ids] of [
      ["pending", ["p1"]],
      ["approved", ["a1"]],
      ["rejected", ["r1"]],
      ["deferred", ["f1"]],
    ] as const) {
      expect(
        listApprovals(db, { status: s }).approvals.map((a) => a.id),
      ).toEqual([...ids]);
    }
  });
});

describe("③ 排序：等得最久的在最上面，而 NULL 年龄不能靠方言运气", () => {
  it("⭐ created_at 为 NULL 的存量行落在最后，而不是跳到列表顶上", () => {
    /*
     * 0004 之前建的卡没有创建时刻，而那些恰恰是【最老】的卡。
     * 直接 ORDER BY created_at DESC 在 SQLite 里把 NULL 排在降序末尾 —— 看着对，
     * 实际借的是「NULL 在降序里靠后」这条方言行为；换排序方向或换实现，
     * 「一张不知年龄的卡」就会顶到收件箱第一行，而测试照绿。
     * 所以钉的是那条 SQL 里的 CASE，不是某个引擎的巧合。
     */
    const db = fresh();
    card(db, "old-unknown", { createdAt: null });
    card(db, "newest", { createdAt: T0 + 100 * HOUR });
    card(db, "oldest", { createdAt: T0 });
    expect(listApprovals(db).approvals.map((a) => a.id)).toEqual([
      "oldest",
      "newest",
      "old-unknown",
    ]);
  });

  it("⭐ 排序里没有「待批优先」那一档 —— 因为 WHERE 已把状态钉死，那一档无从区分", () => {
    /*
     * 这一发是【删掉一段代码的凭据】，也是那条删除的提醒器。
     * 第一版 APPROVAL_ORDER 写着 `CASE WHEN status = 'pending' THEN 0 ELSE 1 END`，
     * 而 listApprovals 的 WHERE 是 `status = ?`：一次查询返回的所有行 status 相同，
     * 那一档【永远排不出任何东西】。它当时还配了一条断言（「已批的排在待批之后」），
     * 而那条断言只能靠【绕过默认过滤】才测得到 —— 也就是它在测一条不存在的查询路径。
     * 现在钉的是：
     *   ① 真行为 —— 默认（pending）那一页里【不会】混进已批的，所以「待批在前」
     *      这件事由 WHERE 保证，不需要排序参与（这条断言测的是存在的路径）；
     *   ② ORDER BY 里不含 status 优先级 —— 若有人放宽成多档过滤（pending + deferred
     *      之类），这一发红，而他必须【同时】重新决定排序：那时这一档才第一次有意义。
     */
    const db = fresh();
    card(db, "a-old", { status: "approved", createdAt: T0 });
    card(db, "p-new", { createdAt: T0 + 500 * HOUR });
    const r = listApprovals(db);
    expect(r.approvals.map((a) => a.id)).toEqual(["p-new"]);
    expect(r.statusFilter).toBe("pending");
    expect(APPROVAL_ORDER).not.toMatch(/status/u);
    // 「等得最久」这一档在已批那一档里同样成立（同一份 ORDER BY，换的是 WHERE）。
    expect(
      listApprovals(db, { status: "approved" }).approvals.map((a) => a.id),
    ).toEqual(["a-old"]);
  });
});

describe("④ 脏数据不能让收件箱整体 500", () => {
  it("⭐ escalationReasonOf：合法 / 四种脏形状 / 空串，全都给得出答案", () => {
    expect(
      escalationReasonOf('{"escalation":{"reason":"irreversible_action"}}'),
    ).toBe("irreversible_action");
    for (const bad of [
      null,
      "{不是 JSON",
      "[]",
      '"x"',
      "5",
      "null",
      '{"escalation":null}',
      '{"escalation":[]}',
      '{"escalation":"irreversible_action"}',
      '{"escalation":{"reason":7}}',
      '{"escalation":{}}',
      '{"escalation":{"reason":""}}',
    ]) {
      expect(escalationReasonOf(bad), "输入 " + JSON.stringify(bad)).toBeNull();
    }
  });

  it("⭐ 一行脏 parameters 混在列表里：那一行原因给 null，整页照常返回", () => {
    const db = fresh();
    card(db, "good", {
      parameters: '{"escalation":{"reason":"budget_threshold"}}',
    });
    card(db, "broken", { parameters: "{坏了一半" });
    card(db, "arrayish", { parameters: "[1,2]" });
    const r = listApprovals(db);
    expect(r.approvals).toHaveLength(3);
    const byId = new Map(r.approvals.map((a) => [a.id, a]));
    expect(byId.get("good")?.escalation_reason).toBe("budget_threshold");
    expect(byId.get("broken")?.escalation_reason).toBeNull();
    expect(byId.get("arrayish")?.escalation_reason).toBeNull();
  });

  it("⭐ status 为 NULL 的旁路行读成 unknown，不读成 pending", () => {
    /*
     * 0001 那列写着 DEFAULT 'pending'，而 DEFAULT 只在【没写这一列】的 INSERT 上生效：
     * 一条显式写了 NULL 的旁路插入会留下 status IS NULL 的行。
     * 把它读成 pending 会【凭空多出一次待批】—— 那正是这个端点要消灭的形状，
     * 所以宁可显示一个看着不对的值让人来查（0007 §4.1 同一条立场）。
     */
    const db = fresh();
    db.prepare(
      "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, status) " +
        "VALUES ('n-1', 't-1', 'escalation', '旁路行', '{}', NULL)",
    ).run();
    const row = db
      .prepare("SELECT * FROM approvals WHERE id = 'n-1'")
      .get() as Record<string, unknown>;
    expect(approvalViewOf(row).status).toBe("unknown");
    // 反向对照：这一行【不能】出现在默认（pending）列表里，也不能被算进角标。
    const r = listApprovals(db);
    expect(r.approvals.map((a) => a.id)).toEqual([]);
    expect(r.pendingTotal).toBe(0);
  });

  it("approvalViewOf 缺 created_at / timeout_at 时给 null，不给 NaN", () => {
    const v = approvalViewOf({
      id: "x",
      task_id: null,
      approval_type: "escalation",
      summary: "s",
      status: "pending",
    });
    expect([
      v.created_at,
      v.timeout_at,
      v.task_id,
      v.escalation_reason,
    ]).toEqual([null, null, null, null]);
  });

  it("⭐ evidence_refs 随视图带出：有证据的卡是数组，没给的是 null（O5 动作 4）", () => {
    /*
     * 0008 那列的读侧出口。契约强制非空，所以正常建卡恒有数组；但视图必须能表达
     * 「这张卡没有证据包」（null / []）—— 否则 UI 会把缺证据的旁路/存量卡
     * 伪装成有证据的卡。变异：把 evidenceRefsOf 改成恒返回 [] ⇒ 有证据的卡
     * 数量信息消失，这一发红。
     */
    const db = fresh();
    card(db, "p1", {
      evidence_refs: JSON.stringify(["task:t-1/evidence/prd.md"]),
    });
    card(db, "p2", { evidence_refs: null });
    const rows = listApprovals(db).approvals;
    expect(rows.find((a) => a.id === "p1")?.evidence_refs).toEqual([
      "task:t-1/evidence/prd.md",
    ]);
    expect(rows.find((a) => a.id === "p2")?.evidence_refs).toBeNull();
  });
});

describe("⑤ 出参形状：列表不是「顺手把整行发出去」", () => {
  it("⭐ 不带 parameters 全文，也不带 decision_note", () => {
    const db = fresh();
    card(db, "p1", {
      parameters: JSON.stringify({
        impact_scope: "整个生产库",
        diff: "……几千字……",
      }),
      note: "CEO 的内部备注",
    });
    const raw = JSON.stringify(listApprovals(db));
    expect(raw).not.toContain("整个生产库");
    expect(raw).not.toContain("几千字");
    // decision_note 压根不在 APPROVAL_COLUMNS 里（它是决策附件，不属于列表）。
    expect(raw).not.toContain("decision_note");
    // 而从那一格里提出来的东西必须在：按原因分组是【规格】§8.3 那条北极星的口径。
    card(db, "p2", {
      parameters: '{"escalation":{"reason":"irreversible_action"}}',
    });
    expect(
      listApprovals(db)
        .approvals.map((a) => [a.id, a.escalation_reason])
        .sort(),
    ).toEqual([
      ["p1", null],
      ["p2", "irreversible_action"],
    ]);
  });

  it("⭐ 「待批」那条判据现在【编译期】同源：SQL 里的字面量扫描已被删除", () => {
    /*
     * 这一发从前是【源码扫描】：读 real-deps.ts 的字节，断言里面恰好有一处
     * `status = 'pending'` 且它等于 contracts 的常量。它存在的唯一理由是
     * 「TS 常量没法伸进 SQL 文本」。那句话只对【把常量拼进字符串】成立 ——
     * 绑参是另一条路，走通之后那个理由消失，扫描也就【没有分母】了。
     *
     * 0026 §9 明写：「那条扫描在 SQL 改成绑参的那天必须删掉 ——
     * 一条失去分母的断言比没有断言更坏」。今天就是那天。
     *
     * 但这一发【没有整条删掉】，因为还剩两件事是真需要钉的，而且都不是「值等于什么」：
     *  ① 两条认领 SQL 里【不许出现 status 的字面量】—— 出现就说明有人把绑参改回拼接，
     *     那种改法在编译期不响（字符串而已），只有这一发能报；
     *  ② TS 侧那三处【必须引用 contracts 的常量】而不是各自打一遍 "pending"。
     * 也就是说判据从「字面量的值对不对」换成了「还有没有人在写字面量」——
     * 前者已经由类型保证，后者类型管不了。
     *
     * ⚠ 换判据的同时要如实记下【绑参换来的新失效方式】：一个字面量的时候
     * `WHERE id = ? AND status = 'pending'` 只有一个占位符，形状上不可能填错；
     * 现在有两个，把 approvalId 与 PENDING_LITERAL 顺序写反 ⇒ 匹配 0 行 ⇒
     * changes===0 ⇒ 报「没抢到」，不抛错。挡住它的是 real-deps.test.ts 那条
     * 【第一次决策返回 true】的正向用例（那里也写了这条警告）。
     */
    const claim = readFileSync(
      join(HUB, "src", "http", "real-deps.ts"),
      "utf8",
    );
    const auto = readFileSync(
      join(HUB, "src", "policy", "auto-approve.ts"),
      "utf8",
    );
    for (const [name, src] of [
      ["real-deps.ts", claim],
      ["auto-approve.ts", auto],
    ] as const) {
      const sqlLine = codeLines(src).filter((l) =>
        /WHERE id = \? AND status/.test(l),
      );
      expect(sqlLine.length, name + " 应当有一条认领 SQL").toBe(1);
      // ① 不许回退成字面量拼接。
      expect(
        sqlLine[0],
        name + " 的认领 SQL 回退成了 status 字面量",
      ).not.toMatch(/status\s*=\s*'/u);
      expect(sqlLine[0]).toMatch(/status = \?/u);
      // ② 绑的必须是 contracts 那个常量。
      expect(src, name + " 没有 import APPROVAL_STATUS_PENDING").toMatch(
        /APPROVAL_STATUS_PENDING/u,
      );
      expect(src).not.toMatch(/status\s*=\s*"pending"/u);
    }
    // 反向对照：常量本身仍然是 "pending"。若有人改它而忘了上面两处，
    // 这一行会【先】红，从而指出「扫描已删，但语义还在」—— 而不是让那次改动
    // 变成一个安静的「库里 status 变了而 SQL 也一起变了」的一致性变更。
    expect(APPROVAL_STATUS_PENDING).toBe("pending");
    // 认领条件与建卡初值必须是【同一个引用】，不是「碰巧都是 pending」。
    const cards = readFileSync(
      join(HUB, "src", "approvals", "cards.ts"),
      "utf8",
    );
    const query = readFileSync(
      join(HUB, "src", "approvals", "query.ts"),
      "utf8",
    );
    expect(cards).toMatch(/APPROVAL_STATUS_PENDING/u);
    expect(cards).not.toMatch(/=\s*"pending"/u);
    expect(query).toMatch(/PENDING_LITERAL: string = APPROVAL_STATUS_PENDING/u);
    expect(query).not.toMatch(/status\s*=\s*"pending"/u);
    /*
     * ⚠ 这里【不】再写「注释里的 status = 'pending' 不会被算进来」那种断言。
     * 我第一版写了，而且是【错的】：codeLines 剥的是【行首】是注释标记的行，
     * 一行代码尾随的 `// status = 'pending'` 它剥不掉（实测：断言直接红）。
     * 本仓的 SQL 常量都是整行字符串拼接，注释也各自独占一行，所以那条判据【今天】
     * 不会误判 —— 但「今天不误判」不等于「这条判据能挡住误判」，
     * 把一次巧合写成性质，就是 0013 §10 那一族「零判别力断言」。
     * 真要收紧，得换成【剥掉行尾注释】的实现，那是另一发改法而不是这条断言。
     */
  });
});

describe("⑥ limit 的钳制", () => {
  it("⭐ 上界必须钳：没有上界的 limit 会让一次读列表变成一次全表扫", () => {
    expect(clampLimit(99_999_999)).toBe(MAX_APPROVAL_LIMIT);
    const db = fresh();
    for (let i = 0; i < 4; i++) card(db, "c" + i, { createdAt: T0 + i * HOUR });
    expect(listApprovals(db, { limit: 1e9 }).limit).toBe(MAX_APPROVAL_LIMIT);
  });

  it("undefined / NaN / 0 / 负数 ⇒ 回落默认值，而不是抛", () => {
    for (const bad of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      -5,
    ]) {
      expect(clampLimit(bad), "实到 " + String(bad)).toBe(
        DEFAULT_APPROVAL_LIMIT,
      );
    }
    expect(clampLimit(12.9)).toBe(12);
  });

  it("limit=0 不返回空列表：它回落到默认值（0 更可能是「没传」而不是「要 0 条」）", () => {
    const db = fresh();
    card(db, "p1");
    const r = listApprovals(db, { limit: 0 });
    expect(r.limit).toBe(DEFAULT_APPROVAL_LIMIT);
    expect(r.approvals).toHaveLength(1);
  });
});

/**
 * ⑦ 影子判定（O9 动作 1 阶段一：只报不批）。
 *
 * 三条主张，方向各不相同：
 *  (甲) 读路径真的调到了规则 —— 有读数。缺了它，这一格是永远 null 的死字段。
 *  (乙) 不可逆那张**根本不进** autoApprove：短路成立 ⇒ 阴性样本不建在子串表上。
 *       这是验收第 2 条「不可逆被自动批准 ⇒ 必须永远绿」的落点，它的身份是
 *       **阴性样本不是成绩**（O9 正文原话），所以它绿的凭据是那条短路 + 变异证据，
 *       不是「今天恰好没有不可逆卡被批」。
 *  (丙) 阶段一**不改任何决定**：写路径零调用。这一发是源码级判据（不是行为），
 *       理由与它要防的坏法同形 —— 担心的正是「将来有人顺手在写路径调它」。
 */
describe("⑦ policy_shadow：规则判而不下手", () => {
  it("⭐ 普通待批卡带着读数：R1 的缺格如实报出而不是假装什么都没发生", () => {
    const db = fresh();
    card(db, "p1", { summary: "读取配置并汇报现状", type: "strategic" });
    const v = listApprovals(db).approvals[0];
    const s = v?.policy_shadow;
    if (s === null || s === undefined || s.decision !== "require_approval") {
      throw new Error("期望 require_approval，实到 " + JSON.stringify(s));
    }
    // tier 由 summary 子串估算而来（"读取" ⇒ read_only）—— 读数页要写明它是估算。
    expect(s.tier).toBe("read_only");
    expect(s.blocked_by).toBe("conditions_unmet");
    // 只有 R1 的两格：§9.1 里【历史是 R2 的前置】，只读卡不问历史 ——
    // 断言按 autoApprove 的真实顺序写，不照抄「三格前置」那句话。
    expect([...(s.missing as string[])].sort()).toEqual([
      "evidence_missing",
      "gate_missing",
    ]);
  });

  it("⭐ 显式 irreversible=true 的卡短路在估算之前：blocked_by=irreversible、missing 空", () => {
    const db = fresh();
    // summary 刻意写成一个「只读形状」的句子：如果没短路，它会判成 read_only +
    // conditions_unmet。这一发因此判的是【短路】而不是【子串表认得不可逆】。
    card(db, "ir1", {
      summary: "读取一次生产库的用量",
      type: "irreversible_action",
      parameters: JSON.stringify({
        irreversible: true,
        impact_scope: "生产库",
      }),
    });
    const s = listApprovals(db).approvals[0]?.policy_shadow;
    if (s === null || s === undefined || s.decision !== "require_approval") {
      throw new Error("期望 require_approval，实到 " + JSON.stringify(s));
    }
    expect([s.tier, s.blocked_by, s.missing]).toEqual([
      "irreversible",
      "irreversible",
      [],
    ]);
    expect(s.note).toContain("irreversible=true");
  });

  it("parameters 是坏 JSON ⇒ 影子判定照算（不短路、不 500）：坏值不能吞掉整张卡", () => {
    const db = fresh();
    card(db, "bad1", { parameters: "{不是JSON", summary: "grep 一遍日志" });
    const r = listApprovals(db);
    expect(r.approvals).toHaveLength(1);
    expect(r.approvals[0]?.policy_shadow).not.toBeNull();
  });

  it("⭐ 阶段一的边界：src 里 autoApprove 的调用方【只有读路径】，recordAutoApproval 零调用方", () => {
    // 判据是源码级：担心的坏法是「将来在写路径顺手调它」，而那次改动在行为上
    // 完全可能不红（没有卡 ⇒ 没有可观察差异），只有扫源码报得出。
    const root = join(HUB, "src");
    const callers: string[] = [];
    const recordCallers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (name.endsWith(".ts")) {
          const src = readFileSync(p, "utf8");
          const rel = p.slice(root.length + 1).replaceAll("\\", "/");
          if (rel === "policy/auto-approve.ts") continue;
          if (/autoApprove\s*\(/u.test(src)) callers.push(rel);
          if (/recordAutoApproval\s*\(/u.test(src)) recordCallers.push(rel);
        }
      }
    };
    walk(root);
    expect(callers.sort()).toEqual(["approvals/query.ts"]);
    // 认领卡片 + 署 policy-engine 的那条写路径【今天无人调】：
    // 「存在一条被自动批准的审批」这一发今天必须红（O9 验收第 1 条）。
    expect(recordCallers).toEqual([]);
  });
});

/* ───────── ⑧ 详情读侧：readApprovalDetail / parametersObjectOf ─────────
 * GET /approvals/:id 落地时新加的一节。与 http/approval-detail-route.test.ts 的分工
 * 写在那边文件头：那边测【判据 → 状态码 → 响应体】与「列表不带 / 详情带」两面，
 * 这边测【那一串列名与视图】—— 也就是只有进程内读侧能证的事。
 */
describe("⑧ 详情读侧：那一串列名、点查、以及 null 的三种来路", () => {
  /**
   * 真表有哪些列 —— 由 PRAGMA 现读，【不是】这里手抄一份。
   *
   * 手抄一份会造出本仓最讨厌的那种假绿：将来 0010 加一列而这条断言不知道，
   * 于是「详情少了一列」与「DDL 从来没这列」在测试里长得一样。
   * 现读的代价是多一次 PRAGMA，换来的是【分母来自库本身】
   * （同 query.test.ts ③ 那条「排序只有真 SQLite 能验」的立场）。
   */
  function realColumns(db: DatabaseSync): string[] {
    const rows = db.prepare("PRAGMA table_info(approvals)").all() as Array<{
      name: string;
    }>;
    expect(
      rows.length,
      "PRAGMA 读不到 approvals 的列 ⇒ 这一发起码要先红在这里",
    ).toBeGreaterThan(10);
    return rows.map((r) => r.name);
  }

  const split = (cols: string): string[] =>
    cols
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");

  it("⭐ 详情那串列名：少一列就红，多一个不存在的名字也红", () => {
    /*
     * APPROVAL_DETAIL_COLUMNS 那份注释说「这一串必须与视图逐列对齐，由这一发钉住」。
     * 三条断言各挡一种漂法：
     *  ① 详情 ⊉ 列表 ⇒ 详情比列表还少一列。这一条最值钱的落点是 `parameters`：
     *     它【 nullable 】，所以少了它 schema 照样过 —— 症状是详情页安静地写
     *     「参数快照读不出来」，而这句话在屏幕上是【库里数据坏了】的意思。
     *     一次删列改动会伪造出一条关于生产库的指控。这就是为什么这一条要单独钉。
     *  ② 详情独有的三格必须在（那三格是详情存在的理由，不是附带品）。
     *  ③ 每一个名字必须在真表里存在 ⇒ 挡的是拼错 / DDL 改名，那种改动在
     *     prepare 时抛的是「no such column」，而抛在详情这条路上被翻成 500。
     */
    const db = fresh();
    const real = realColumns(db);
    const detail = split(APPROVAL_DETAIL_COLUMNS);
    const list = split(APPROVAL_COLUMNS);
    for (const c of list) {
      expect(detail, `详情少了列表就有的那一列 ${c}`).toContain(c);
    }
    for (const c of ["decided_by", "decided_at", "decision_note"]) {
      expect(detail, `详情少了它存在的理由那一格 ${c}`).toContain(c);
    }
    for (const c of detail) {
      expect(real, `详情 SELECT 了一个真表里【不存在】的列 ${c}`).toContain(c);
    }
    // 反向对照（分母）：详情确实【没有】把整表发出去 —— 真表里有而详情不选的列
    // 必须非空。空的话说明有人把那一串换成了 `SELECT *`，
    // 而 APPROVAL_COLUMNS 上面那段「不许 SELECT *」的论点就是这么开始失效的。
    const skipped = real.filter((c) => !detail.includes(c));
    expect(skipped.length, "详情把整张表都 SELECT 了？").toBeGreaterThan(0);
    // 重复名列（写重复不会抛，会静默覆盖同名键 ⇒ 视图拿到的值取决于驱动顺序）。
    expect(detail.length).toBe(new Set(detail).size);
  });

  it("⭐ 内部列被塞进 SELECT 也【不会】变成对外契约", () => {
    /*
     * 这一发原本要钉的是我写在 approvalDetailViewOf 上面那句「内部列万一被加进
     * APPROVAL_DETAIL_COLUMNS，会在 parse 当场抛」。**实跑证明那句是错的**：
     * 视图是【逐字段映射】出来的（approvalViewOf 只读它认识的那几格 + 这里补四格），
     * 多出来的行键根本没人读 ⇒ parse【不会】抛，它是被【静默丢掉】。
     * 结果仍然是安全的（不泄漏），但机制与注释写的不是同一件事，
     * 而注释一旦说错机制，下一个人就会以为有闸门。所以这一发钉真实机制：
     * 多加一列 ⇒ 输出里【没有】那一格，且【不抛】。
     * 真正的闸门是上面那条列名对齐 + contracts 那张 .strict()。
     */
    const db = fresh();
    card(db, "i-1", { parameters: "{}" });
    const row = db
      .prepare("SELECT * FROM approvals WHERE id = 'i-1'")
      .get() as Record<string, unknown>;
    // card_key 是真列（0004），而它【不属于】对外视图。
    expect(Object.keys(row)).toContain("card_key");
    const v = approvalDetailViewOf({ ...row, card_key: "内部去重键" });
    expect(JSON.stringify(v)).not.toContain("card_key");
    expect(JSON.stringify(v)).not.toContain("内部去重键");
    expect(Object.keys(v)).not.toContain("card_key");
  });

  it("⭐ 详情【不按 status 过滤】：已决的那一张读得到（「我上周批的是什么来着」）", () => {
    const db = fresh();
    card(db, "x-1", { status: "pending" });
    card(db, "x-2", {
      status: "approved",
      note: null,
    });
    db.prepare(
      "UPDATE approvals SET decided_by = 'ceo', decided_at = ? WHERE id = 'x-2'",
    ).run(T0 + HOUR);
    const p = readApprovalDetail(db, "x-1");
    const a = readApprovalDetail(db, "x-2");
    expect(p?.status).toBe("pending");
    expect(a?.status).toBe("approved");
    expect(a?.decided_by).toBe("ceo");
    expect(a?.decided_at).toBe(T0 + HOUR);
    // 同一张卡在两个界面上的决定权判断必须一致（列表那一档过滤放行时也读得到）。
    expect(
      listApprovals(db, { status: "approved" }).approvals.find(
        (k) => k.id === "x-2",
      )?.status,
    ).toBe(a?.status);
  });

  it("⭐ 详情是列表的【超集】：同名的每一格两边同值", () => {
    // approvalDetailViewOf 那份注释说「列表的口径是详情的子集，由代码结构保证」。
    // 结构保证的事也要有一发测得到：漂了之后的形状是「列表说 unknown、详情说
    // pending」，而决定权正是界面琥珀色唯一的意思。
    const db = fresh();
    card(db, "s-1", {
      parameters: JSON.stringify({
        impact_scope: "生产库",
        irreversible: true,
      }),
      evidence_refs: JSON.stringify(["task:t-1/evidence/prd.md"]),
    });
    const one = listApprovals(db).approvals.find((k) => k.id === "s-1");
    const detail = readApprovalDetail(db, "s-1");
    expect(one).toBeDefined();
    expect(detail).not.toBeNull();
    for (const [k, v] of Object.entries(one ?? {})) {
      expect(detail?.[k as keyof typeof detail], k).toEqual(v);
    }
    // 详情多出来的恰好那四格（少一格上面那条循环报不出来 —— 它只比同名格）。
    expect(
      Object.keys(detail ?? {})
        .filter((k) => !(k in (one ?? {})))
        .sort(),
    ).toEqual(["decided_at", "decided_by", "decision_note", "parameters"]);
  });

  it("⭐ parametersObjectOf：null / 空串 / 标量 / 数组 / 坏 JSON ⇒ 一律 null，而 {} 是 {}", () => {
    // null 在这一格的意思是【读不出一个 JSON 对象】，不是「没有参数」。
    // 界面据此写「参数快照读不出来」那一句 —— 说成"为空"就等于指这张卡本来没参数。
    for (const raw of [
      null,
      undefined,
      "",
      "不是 JSON",
      '"一个标量"',
      "42",
      "true",
      "[1,2,3]",
    ]) {
      expect(parametersObjectOf(raw), JSON.stringify(raw)).toBeNull();
    }
    expect(parametersObjectOf("{}")).toEqual({});
    expect(parametersObjectOf('{"a":1}')).toEqual({ a: 1 });
    // 空对象与 null 必须是两种答案 —— 这一条是上面两组的合取，单独写出来是因为
    // 它是这一格里最容易被「统一返回 {} 更省事」改掉的一条。
    expect(parametersObjectOf("{}")).not.toBe(parametersObjectOf(""));
  });

  it("⭐ 库里那三种脏 parameters 走完整读侧：详情给 null，卡片其余部分照常", () => {
    const db = fresh();
    card(db, "d-1", { parameters: "这不是 JSON" });
    card(db, "d-2", { parameters: "[1,2,3]" });
    card(db, "d-3", { parameters: '"标量"' });
    for (const id of ["d-1", "d-2", "d-3"]) {
      const v = readApprovalDetail(db, id);
      expect(v, id).not.toBeNull();
      expect(v?.parameters, id).toBeNull();
      expect(v?.id, id).toBe(id);
      expect(v?.summary, id).toBe("摘要 " + id);
      // 影子判定与升级原因走的是【同一段脏文本】的另一条解析路径，它们也不许崩。
      expect(v?.policy_shadow, id).not.toBeNull();
    }
  });

  it("⭐ status 为 NULL 的旁路行：详情也读成 unknown，与列表同一口径", () => {
    // approvalViewOf 那段「宁可显示一个看着不对的值」的立场，在详情里必须同一条。
    const db = fresh();
    card(db, "n-9", { status: "pending" });
    db.prepare("UPDATE approvals SET status = NULL WHERE id = 'n-9'").run();
    expect(readApprovalDetail(db, "n-9")?.status).toBe("unknown");
    expect(listApprovals(db).approvals.map((a) => a.id)).toEqual([]);
  });

  it("id 不存在 ⇒ null，不是抛、不是空对象", () => {
    const db = fresh();
    expect(readApprovalDetail(db, "nope")).toBeNull();
    // 空串 id：详情这一路在【路由层】就被判不匹配（app.ts 那条论证），
    // 但读侧自己也不许把空串读成"库里有一张 id 为空的卡"。
    expect(readApprovalDetail(db, "")).toBeNull();
  });
});
