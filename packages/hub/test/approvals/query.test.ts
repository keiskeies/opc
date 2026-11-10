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
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { APPROVAL_STATUS_PENDING } from "@opc/contracts";
import {
  APPROVAL_ORDER,
  approvalViewOf,
  clampLimit,
  DEFAULT_APPROVAL_LIMIT,
  escalationReasonOf,
  listApprovals,
  MAX_APPROVAL_LIMIT,
} from "../../src/approvals/query.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP = join(HUB, ".tmp", "approvals-query-" + process.pid);

const T0 = Date.parse("2026-05-01T00:00:00.000Z");
const HOUR = 3_600_000;

/** 真代码行：把注释行剔掉再扫，否则注释里那句「WHERE status = 'pending'」也算命中。 */
function codeLines(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
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
}

/** 直插而不是走 createCard：这一篇要能造出 createCard 【造不出来】的脏行。 */
function card(
  db: DatabaseSync,
  id: string,
  o: CardOpts = {},
): void {
  db.prepare(
    "INSERT INTO approvals (id, task_id, approval_type, summary, parameters, " +
      "recommendation, recommendation_source, timeout_behavior, timeout_at, status, " +
      "decided_by, decided_at, decision_note, card_key, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    "t-1",
    o.type ?? "escalation",
    "摘要 " + id,
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
    expect(r).toMatchObject({ approvals: [], pendingTotal: 0, truncated: false });
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
      expect(r.approvals.map((a) => a.id), "status=" + JSON.stringify(bad)).toEqual(["p1"]);
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
      expect(listApprovals(db, { status: s }).approvals.map((a) => a.id)).toEqual([...ids]);
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
    expect(listApprovals(db, { status: "approved" }).approvals.map((a) => a.id)).toEqual([
      "a-old",
    ]);
  });
});

describe("④ 脏数据不能让收件箱整体 500", () => {
  it("⭐ escalationReasonOf：合法 / 四种脏形状 / 空串，全都给得出答案", () => {
    expect(escalationReasonOf('{"escalation":{"reason":"irreversible_action"}}')).toBe(
      "irreversible_action",
    );
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
    card(db, "good", { parameters: '{"escalation":{"reason":"budget_threshold"}}' });
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
    expect([v.created_at, v.timeout_at, v.task_id, v.escalation_reason]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });
});

describe("⑤ 出参形状：列表不是「顺手把整行发出去」", () => {
  it("⭐ 不带 parameters 全文，也不带 decision_note", () => {
    const db = fresh();
    card(db, "p1", {
      parameters: JSON.stringify({ impact_scope: "整个生产库", diff: "……几千字……" }),
      note: "CEO 的内部备注",
    });
    const raw = JSON.stringify(listApprovals(db));
    expect(raw).not.toContain("整个生产库");
    expect(raw).not.toContain("几千字");
    // decision_note 压根不在 APPROVAL_COLUMNS 里（它是决策附件，不属于列表）。
    expect(raw).not.toContain("decision_note");
    // 而从那一格里提出来的东西必须在：按原因分组是【规格】§8.3 那条北极星的口径。
    card(db, "p2", { parameters: '{"escalation":{"reason":"irreversible_action"}}' });
    expect(
      listApprovals(db)
        .approvals.map((a) => [a.id, a.escalation_reason])
        .sort(),
    ).toEqual([
      ["p1", null],
      ["p2", "irreversible_action"],
    ]);
  });

  it("⭐ 「待批」那个字面量四处同源：SQL 里唯一一处【常量伸不进去】的地方由这一发钉住", () => {
    /*
     * real-deps.ts 的 CLAIM_APPROVAL_SQL 里 `AND status = 'pending'` 是字符串字面量，
     * TS 常量没法伸进 SQL 文本（改成绑参会牵动那条 UPDATE 的断言参数个数，
     * 而那正是它幂等的地方 —— 见该文件注释）。所以这一发红 = 有人改了其中一处。
     * 症状不是报错，是「这张卡明明显示待批，点下去说已经批过了」。
     *
     * ⚠ 若将来那条 SQL 改成 `AND status = ?` 并由调用方喂 contracts 的常量，
     *   这一发会【扫不到字面量而红】—— 那时该删掉它，不要改成恒真。
     */
    const literals = codeLines(
      readFileSync(join(HUB, "src", "http", "real-deps.ts"), "utf8"),
    )
      .flatMap((l) => [...l.matchAll(/status\s*=\s*'([^']*)'/gu)])
      .map((m) => m[1]);
    expect(literals, "real-deps.ts 里应当恰有一处 status 字面量").toEqual(["pending"]);
    expect(APPROVAL_STATUS_PENDING).toBe("pending");

    // 建卡初值与列表默认过滤必须与它同一来源（不是「碰巧都是 pending」）。
    const cards = readFileSync(join(HUB, "src", "approvals", "cards.ts"), "utf8");
    const query = readFileSync(join(HUB, "src", "approvals", "query.ts"), "utf8");
    expect(cards).toMatch(/APPROVAL_STATUS_PENDING/u);
    expect(cards).not.toMatch(/=\s*"pending"/u);
    expect(query).toMatch(/PENDING_LITERAL: string = APPROVAL_STATUS_PENDING/u);
    expect(query).not.toMatch(/status\s*=\s*"pending"/u);
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
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      expect(clampLimit(bad), "实到 " + String(bad)).toBe(DEFAULT_APPROVAL_LIMIT);
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
