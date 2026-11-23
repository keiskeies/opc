/**
 * 证据包的【生产者】—— 引擎每做出一轮交接时，为它落一份真的包（§8.1 / §O5）。
 *
 * ── 这个文件存在的唯一理由 ────────────────────────────────────────────
 * §O5 那一格量的是：`evaluateGate` 的 `integrityOk` 在【生产路径上】可以取 `undefined`。
 * 全仓曾有包的生产者（`harness/verifier.ts`），而它【零生产调用方】，
 * 于是引擎里每一次审阅都是「拿着一个不存在的包去问门控要不要放行」。
 * 这里补的就是那个生产者：字节落文件系统（§5.10：制品不进 SQLite），
 * 路径与 sha256 由 `EvidenceStore.verify()` 与磁盘上那份【对账】，得出一个【布尔】
 * 交给门控；包与门控决定的那两行账由调用方在【同一个事务里】写（见下面第 ③ 条）。
 *
 * ── 三条口径是这一格的全部难点，逐条钉在这里 ──────────────────────────
 *  ① `integrityOk` 只能是算出来的，不能是传进来的。
 *     本模块【不 import evaluateGate】：它不知道门控有哪些判据，门控也不知道字节
 *     从哪来。反过来若 `undefined` 是合法取值，§O5 那条断言（「生产路径上仍可取
 *     undefined ⇒ 红」）就没有东西可红 —— 所以 produceTurnArtifact 的返回类型里
 *     `integrityOk` 是【必填布尔】，没有可选那一支。
 *  ② 包里的【主张】只有角色自己说过的那一句。
 *     绝不写「测试通过」「覆盖率 82%」「缺陷为零」。证据包骗人比没有证据包更贵：
 *     没有包时审计知道这里没证据，有包时审计会【引用那句话】。所以 metrics 整格
 *     留空（岗位书里 `metric:` 标准会因此 unresolved → escalate，而不是被假的 0 蒙过），
 *     诚实边界如实写「没有独立核验过任何东西」。
 *  ③ 【字节在事务外，账在事务内】—— 这一条决定了本模块为什么是两个函数而不是一个。
 *     fs 不受 SQLite 事务管，所以「produce 一个函数里顺手把行也插了」那种写法会把
 *     事务边界藏起来：调用方要么在事务里调它（那 register 拿到的是事务连接），
 *     要么在事务外调（那 §6.3 要求的原子性当场失效而【不会报错】）。
 *     拆成两步之后类型上就要求调用方【两条路径各调一次】，藏不住。
 *     两遍之间事务回滚的后果是【磁盘上多一个孤儿制品】，不是假账：制品是内容寻址的，
 *     而库里没行就没人引用它。反过来（库里有行而磁盘没字节）才是假账，而那个方向
 *     由「字节先落、账后写」这个顺序挡掉。
 *
 * ── 与 `harness/verifier.ts` 那份的分工 ──────────────────────────────
 * 那份是「一条测试修复流水线的自检包」（带 self_check、带真实测试结果）。
 * 这份是「一轮角色交接的包」（不带 self_check，因为它没有自检可声明）。
 * 两者共用同一个 `EvidenceStore`，因此路径、哈希、verify 的口径只有一份。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { EvidenceBundle } from "@opc/contracts";
import { ENGINE_REVIEW_GATE, requiredBundleType } from "@opc/contracts";
import { assertParamCount, assertSingleStatement } from "../db/write-queue.js";
import { EvidenceStore, type VerifyFailure } from "./store.js";

/** 制品正文的文件后缀。写死一个，别让每次交接自己挑（那会让同一次交接有两个合法路径）。 */
const ARTIFACT_EXT = "md";

/**
 * 一轮交接的制品正文。纯函数：同样的输入 ⇒ 同样的字节 ⇒ 同样的 sha256。
 *
 * 刻意写成「人读得懂的一段交代」而不是 JSON：这份制品是给人（CEO）在收件箱里
 * 点开看的，而它的 sha256 进 `evidence_bundles`。JSON 会让人以为那里面是
 * 结构化事实（覆盖率、用例数），而这里【只有角色自报的一句话】。
 */
export function turnArtifactText(o: {
  readonly taskId: string;
  readonly producerRole: string;
  readonly reviewerRole: string;
  readonly summary: string;
  readonly note?: string;
}): string {
  const note = (o.note ?? "").trim();
  return (
    "一次交接的证据包（§8.1 引擎方向 " +
    ENGINE_REVIEW_GATE +
    "）\n" +
    "task: " +
    o.taskId +
    "\n" +
    "产出方: " +
    o.producerRole +
    "\n" +
    "审阅方: " +
    o.reviewerRole +
    "\n" +
    "\n" +
    "—— 产出方在这一轮写下的结论（原话，未改写）——\n" +
    o.summary +
    "\n" +
    "\n—— 产出方补充的说明 ——\n" +
    (note === "" ? "（无）" : note) +
    "\n"
  );
}

/**
 * 把「已经落在 root 内的那个制品」与本轮身份拼成一个符合契约的证据包。
 *
 * 纯函数，`bundleId` 由调用方注入：UUID 是不可注入的不确定性，留在纯构造函数之外，
 * §O5 那条断言才能写成确定形状（生产走 produceTurnArtifact，它自己 mint）。
 */
export function buildTurnBundle(o: {
  readonly taskId: string;
  readonly bundleId: string;
  readonly producerRole: string;
  readonly producerModelFamily: string;
  readonly artifact: {
    readonly declared: string;
    readonly sha256: string;
    readonly bytes: number;
  };
}): EvidenceBundle {
  return {
    bundle_id: o.bundleId,
    task_id: o.taskId,
    // 方向 → 包类型走契约那张表，不在这里写死字面量：登记表改了而这里没改，
    // 门控会 reject「包类型不对」，而那条报错会把人往证据方向带而不是往登记表带。
    bundle_type: requiredBundleType(ENGINE_REVIEW_GATE),
    produced_by_role: o.producerRole,
    produced_by_model_family: o.producerModelFamily,
    artifacts: [
      {
        path: o.artifact.declared,
        sha256: o.artifact.sha256,
        bytes: o.artifact.bytes,
      },
    ],
    claims: [
      {
        text:
          "产出方 [" +
          o.producerRole +
          "] 在这一轮写下的结论（原文见制品；本包不核验其真假）",
        evidence_refs: [o.artifact.declared],
      },
    ],
    honesty_boundaries: [
      "包内没有任何独立核验：只有产出方自报的一句话，没有测试结果、没有覆盖率、没有第三方比对。",
      "sha256 只证明这份交代与提交时说的那份是同一份，不证明它说的事实存在（§8.2 第 2 条的完整性一侧）。",
    ],
    // 整格【不设】：本轮没有任何机械指标。写成 0 会让 `metric: coverage >= 80`
    // 这类标准被【假的 0】判成 violated，看着像"测了、不够"，真相是压根没测。
  };
}

/** produceTurnArtifact 的结论。`integrityOk` 恒为布尔 —— 没有 undefined 那一支。 */
export interface TurnEvidence {
  readonly bundle: EvidenceBundle;
  /** 对账结论（`EvidenceStore.verify()` 的 ok）。§O5 要的就是这一格必须是布尔。 */
  readonly integrityOk: boolean;
  /** 对账没对上 / 没能执行时的白话原因。进 `review_gates.conditions` 与卡片摘要。 */
  readonly integrityReasons: readonly string[];
  /** 因为【对账本身执行了】而只是有外链没核对：不影响 ok，但要说出来。 */
  readonly skippedExternal: number;
}

export interface ProduceTurnInput {
  readonly taskId: string;
  readonly producerRole: string;
  readonly producerModelFamily: string;
  readonly reviewerRole: string;
  readonly summary: string;
  readonly note?: string;
  /** 制品根目录。生产传 artifactsRoot()，测试传临时目录 —— 刻意不读 env（store.ts 同条纪律）。 */
  readonly root: string;
  /** 注入身份用（测试要确定形状）。生产留空 = randomUUID。 */
  readonly mint?: () => string;
  readonly now?: () => number;
}

/**
 * 落本轮交接的字节并对账（【不写库】，见文件头第 ③ 条）。
 *
 * 落盘失败【抛】而不是降级成 `integrityOk=false`：后者会被写成一条
 * 「审过了，证据有问题」的审阅决定，那是把【基础设施没落盘】伪造成【证据有问题】。
 * 唯一的降级是 verify() 自己抛的那一支 —— 那一刻字节刚由本模块写进 root 内、
 * 路径是 `relativize()` 算出来的，真抛出来说明 root 被换过；此处判 false 是
 * 【保守方向】（没能证明完整 ⇒ 不放行），不构成伪证，伪证是反过来的那个方向。
 */
export function produceTurnArtifact(o: ProduceTurnInput): TurnEvidence {
  const family = o.producerModelFamily.trim();
  if (family === "") {
    // 契约要求 produced_by_model_family 非空（§24 风险 1 的同源判定在【家族】粒度上判）。
    // 这里绝不填 "unknown" 之类占位：填了，审阅方家族也是占位时两者【相等】，
    // 于是同源判定在两个假值上判成「同源」—— 用编出来的字符串做一次独立性判定。
    throw new Error(
      "本轮产出方 [" +
        o.producerRole +
        "] 没有声明 model_family，无法生成证据包。" +
        "缺这一格时同源审阅判定本身就无从做（§5.9），不该由证据生产者补一个假家族。",
    );
  }
  const bundleId = (o.mint ?? randomUUID)();
  // exec 传一个【会抛】的空实现：这条路径上一句 SQL 都不该发出去。
  // 为什么不省掉这个参数：EvidenceStore 的 exec 是必填的，而「这里不写库」这件事
  // 需要一个能挡住后来人的形状 —— 有人顺手在这条路径上加一句 INSERT，
  // 就会拿到一个 autocommit 的写（§6.3 当场失效）。让它炸在这里。
  // now 走【条件展开】而不是 `now: o.now`：本仓开着 exactOptionalPropertyTypes，
  // 显式一个 undefined 与压根不写这一格是两个类型（store 内部 `o.now ?? Date.now`
  // 两条都当「没注入时刻」处理，但类型上只认后者）。
  const store = new EvidenceStore({
    root: o.root,
    ...(o.now === undefined ? {} : { now: o.now }),
    exec: () => {
      throw new Error(
        "produceTurnArtifact 不发 SQL：包的那行账由调用方在事务里写（registerTurnEvidence）。" +
          "见本文件头第 ③ 条「字节在事务外，账在事务内」。",
      );
    },
  });
  const bundleType = requiredBundleType(ENGINE_REVIEW_GATE);
  const written = store.writeArtifact(
    { task_id: o.taskId, bundle_type: bundleType, bundle_id: bundleId },
    ARTIFACT_EXT,
    turnArtifactText({
      taskId: o.taskId,
      producerRole: o.producerRole,
      reviewerRole: o.reviewerRole,
      summary: o.summary,
      ...(o.note === undefined ? {} : { note: o.note }),
    }),
  );
  const bundle = buildTurnBundle({
    taskId: o.taskId,
    bundleId,
    producerRole: o.producerRole,
    producerModelFamily: family,
    artifact: {
      declared: written.declared,
      sha256: written.sha256,
      bytes: written.bytes,
    },
  });
  let integrityOk: boolean;
  const integrityReasons: string[] = [];
  let skippedExternal = 0;
  try {
    const report = store.verify(bundle);
    integrityOk = report.ok;
    for (const f of report.failures)
      integrityReasons.push(verifyFailureText(f));
    if (report.checked === 0 && report.failures.length === 0) {
      integrityReasons.push("一个制品都没能比对（空包不算「完整性已验证」）");
    }
    skippedExternal = report.skipped;
  } catch (error) {
    integrityOk = false;
    integrityReasons.push(
      "完整性对账没能执行：" +
        String(error instanceof Error ? error.message : error),
    );
  }
  return { bundle, integrityOk, integrityReasons, skippedExternal };
}

/** verify 的三种 cause → 一句能进 conditions 的白话。 */
function verifyFailureText(f: VerifyFailure): string {
  if (f.cause === "missing") return "声明的制品在磁盘上找不到：" + f.path;
  if (f.cause === "size_mismatch") {
    return (
      "声明 " +
      String(f.declared) +
      " 字节、磁盘上 " +
      String(f.actual) +
      " 字节：" +
      f.path
    );
  }
  return "磁盘上那份的 sha256 与声明不符（内容被改过？）：" + f.path;
}

/**
 * 把包登记进 `evidence_bundles`。【必须在事务内】调用，连接就是那条事务的。
 *
 * 单独一个函数而不是塞进 produce：见文件头第 ③ 条。
 */
export function registerTurnEvidence(
  db: DatabaseSync,
  bundle: EvidenceBundle,
  nowMs?: number,
): void {
  // nowMs 同样走条件展开（与 produceTurnArtifact 那一处同一条 exactOptionalPropertyTypes）。
  const store = new EvidenceStore({
    root: "",
    ...(nowMs === undefined ? {} : { now: () => nowMs }),
    exec: (sql, params) => {
      // store 的 exec 只承诺 params 是 unknown[]（它不知道底下是什么驱动），
      // 而 .run 要 node:sqlite 的参数类型 ⇒ 这一发收窄是边界翻译，不是掩盖。
      db.prepare(sql).run(...(params as readonly SQLInputValue[]));
    },
  });
  store.register(bundle);
}

/**
 * 门控决定那一行。列清单与 migrations/0001_init.sql:110 那十一个是【一对】：
 * 加列必须同时改这里，否则新列静默收 NULL（evidence/store.ts 的 INSERT_BUNDLE_SQL
 * 同一条纪律，0065 记的就是「列清单与迁移对不上而没人知道」那一格）。
 */
export const INSERT_GATE_SQL =
  "INSERT INTO review_gates (id, task_id, gate_type, reviewer_role, reviewer_model_family, " +
  "evidence_bundle_id, decision, decision_reason, conditions, round_no, decided_at) " +
  "VALUES (?,?,?,?,?,?,?,?,?,?,?)";

/** 一条要落账的门控决定。 */
export interface GateDecisionRecord {
  /** 本轮那个包的身份 —— 也是这一行主键的来源（见 writeGateDecision 的注释）。 */
  readonly bundleId: string;
  readonly taskId: string;
  /** 契约登记的方向名（ENGINE_REVIEW_GATE）。不是 `in_review:dev->lead` 那种事件身份。 */
  readonly gateType: string;
  readonly reviewerRole: string;
  readonly reviewerModelFamily: string;
  readonly decision: "approved" | "rejected" | "escalated";
  readonly reason: string;
  /** 机器可读的判据明细（完整性结论 + 没能判定的那些条），回放与巡检都读它。 */
  readonly conditions: readonly string[];
  readonly roundNo: number;
}

/**
 * 写那一行门控决定，返回受影响行数（调用方须判 `=== 1`，与状态边同一条纪律）。
 *
 * `decision` 那一列在 0001 里的注释词表是 `'approved'|'rejected'|'conditional'|'escalated'`，
 * 而门控内核的判别式是 `pass|reject|escalate`。映射【写在这里】而不调用方传字符串：
 * 两侧各一份词表就会有人传 `"pass"` 进来，而 SQLite 这一列【没有 CHECK 约束】
 * （0001 那行只是注释），它会安静收下，然后所有按 'approved' 统计的查询少一条。
 *
 * `id` 用 `"gates/" + bundleId` 而不是裸 bundleId：这张表的主键语义是【一次决定】，
 * 而一条决定恰好带一个包。裸同值会把「这条 gate 的 id 就是它的包」变成隐式约定，
 * 改天一次决定对两个包时没人会想起来改主键形状；前缀也让人复制粘贴时分得清在问哪张表。
 */
export function writeGateDecision(
  db: DatabaseSync,
  o: GateDecisionRecord,
  nowMs: number,
): number {
  assertSingleStatement(INSERT_GATE_SQL);
  const family = o.reviewerModelFamily.trim();
  // SQLInputValue[] 与 unknown[] 的联合：assertParamCount 只数 params.length，
  // 而 .run(...) 要的是 node:sqlite 自己的参数类型（org/commit.ts:143 实测撞过同一条）。
  const params: SQLInputValue[] = [
    "gates/" + o.bundleId,
    o.taskId,
    o.gateType,
    o.reviewerRole,
    family === "" ? null : family,
    o.bundleId,
    o.decision,
    o.reason,
    JSON.stringify([...o.conditions]),
    o.roundNo,
    nowMs,
  ];
  assertParamCount(INSERT_GATE_SQL, params);
  const res = db.prepare(INSERT_GATE_SQL).run(...params);
  return Number(res.changes);
}

/** 给卡片与 decision_reason 用的短哈希（sha256 前 12 位：够指认，不至于刷屏）。 */
export function shortHash(sha256: string): string {
  return sha256.slice(0, 12);
}

/** `conditions` 里那条完整性结论的固定前缀（测试与巡检都按它取）。 */
export const INTEGRITY_CONDITION_PREFIX = "integrity=";

/** 完整性结论 → 机器可读那一格。三态而不是布尔：`未对账` 与 `没对上` 修法不同。 */
export function integrityCondition(ok: boolean): string {
  return INTEGRITY_CONDITION_PREFIX + (ok ? "ok" : "failed");
}
