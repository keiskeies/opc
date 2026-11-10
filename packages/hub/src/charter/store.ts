/**
 * 岗位书的库内读写（计划 Task 3.6「岗位书编辑器」那一半的**后端**）。
 *
 * 计划把它写成 `feat(web): charter editor and budget tier configuration`，
 * 但编辑器（React Flow 之外的表单页）要装 `@xyflow/react` 那一组依赖，
 * 而本机装不上任何东西（0009 §2 三条通路实测）。这里做的是**它必须站在上面的那一层**：
 * 「改了的岗位书存到哪、下一版怎么算、改完能不能真的被门控读到」。
 * 界面换不掉这一层，而这一层今天**根本不存在**（实测见 §下面那段「为什么不是封装」）。
 *
 * ── 为什么不是「给已有函数套一层壳」──────────────────────────────────────
 * 动手前量到的四条事实，每条都决定了这里必须新增什么：
 *  ① `role_charters` 在 src 里只有 org/commit.ts 一处 INSERT，而那条 INSERT
 *     带 `if (prev === undefined) continue;` —— 没有上一版就跳过。
 *     实测：跑完全部迁移之后 `SELECT COUNT(*) FROM role_charters` = **0**。
 *     ⇒ 「保存一版新岗位书」在 src 里**没有任何入口**，只能从 YAML 文件加载
 *     （roles/preset.ts，CLI 启动时读 `resources/charter-templates/*.yaml`）。
 *     也就是说「CEO 改了验收标准」这句话，今天落到代码上是**无处可存**。
 *  ② 存进去的 config 是 camelCase（charterSchema 的 transform 输出），
 *     而 `charterSchema` 的输入是 snake_case（`.strict()`）—— 实测把 preset 的
 *     dev 岗位书按 commit.ts 的写法存进库、再取出来喂给 charterSchema：
 *     **14 条 issue**，第一条是 `role_id: invalid_type`。
 *     ⇒ 「读回来校验」不能直接做。本模块的读回**不重解析**，理由见 readCharterConfig。
 *  ③ `role_charters` **没有 updated_at 列**，`created_at` 也没有；只有
 *     `effective_from`（0001_init.sql:144-152）。而审计那条路径上我要留时间戳。
 *     ⇒ 审计的 created_at 与 effective_from 用同一个 nowMs，见 saveCharterVersion。
 *  ④ 门控（graph/gates/evaluate.ts）是纯函数，criteria 由调用方注入；
 *     src 里 `criteriaFromCharter` 的**生产调用方是 0**。
 *     ⇒ 光把岗位书存起来不满足 Task 3.6 的 Test。所以本模块交付
 *     `criteriaForRoleAtVersion()`：把「库里这一版岗位书」接成「门控的那份输入」。
 *     同一条「产物没有消费者」的病已经记了五次（0011 §8 / 0012 §7 / 0013 §7 /
 *     0013 §10.1 / 0014 §3），这次**先把消费口做出来再交付**。
 *
 * ── 三条判据 ────────────────────────────────────────────────────────────
 *  A. **只有 CEO 能改岗位书**（规格 §4.4.3 原话：「Agent…不能修改自己的岗位书」，
 *     且 spec 第 347-348 行 `company_budget: "ceo"` / `role_budget: "ceo"`）。
 *     写侧强制 actor 是 `human` + `ceo`，不给「先写进去、让调用方自己约束」的口子：
 *     agent 与人在同一个 Hub 进程里，把判据交给调用方等于没交。
 *  B. **写之前必须过校验**。存进去一份跑不过 charterSchema 的 config，
 *     下一次读到它的人会当场拿到一个 `Charter` 类型而里面缺字段 ——
 *     类型系统已经骗了他，运行时会在使用点炸，而那离写入点隔了几层、隔了几天。
 *  C. **改一次出一版，绝不就地 UPDATE**。`UNIQUE(role_id, version)` 是现成的键；
 *     就地改会让「这条任务当时按哪一版验收」永久消失，而 §18.4 阶段 3 与
 *     §22.3 第 4 条要的就是这件事。
 */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  charterSchema,
  type Charter,
  type CharterInput,
} from "@opc/contracts";
import { assertParamCount, assertSingleStatement, type Writer } from "../db/write-queue.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit } from "../events/recorder.js";
import {
  criteriaFromCharter,
  type GateCriterion,
} from "../graph/gates/evaluate.js";
import {
  applyBudgetRowsInTx,
  budgetRowId,
  budgetRowsFromCharter,
} from "./budget-sync.js";

/** 与 org/commit.ts 的 ORG_ACTOR 同一个署名（同一条口径：人在改配置，不是 agent）。 */
export const CHARTER_ACTOR = { actorType: "human", actorId: "ceo" } as const;

/** 审计 payload.kind。与 org_graph_changed 并列，都是配置类变更。 */
export const CHARTER_AUDIT_KIND = "charter_version_added";

/**
 * ⚠ 输入是 **snake_case 的 CharterInput**，不是 camelCase 的 Charter。
 *
 * 这个形状差别不是风格：`charterSchema` 是 `charterInput.transform(...)`，
 * 所以 `.parse(camelCaseCharter)` 会**当场失败**（实测 14 条 issue，
 * 第一条 `role_id: invalid_type`）。写错的人不会拿到一条「请用 snake_case」的提示，
 * 而会拿到 14 条 `invalid_type`，然后大概率去改 schema。所以这里收
 * CharterInput 并在类型面上就拒掉 Charter。
 */
export interface SaveCharterInput {
  readonly roleId: string;
  /** charterSchema 的【输入】形状（snake_case）。 */
  readonly config: CharterInput;
  readonly nowMs: number;
  /** 一句话变更说明，进审计 payload。空串会被拒（它是要被人在回放里读的东西）。 */
  readonly changeSummary: string;
  /**
   * 是否把 budget 两格同时落进 `budgets` 表。**默认 true**。
   *
   * 默认 true 的理由：编辑器保存岗位书时，预算那一栏改了就是要生效
   * （否则屏幕上显示新数字、执行侧按老数字放行，见文件头 D）。
   *
   * 留这个开关的理由要**如实**说：它【今天没有 false 的调用方】。
   * 我本来想写「org/commit.ts 那条组织变更路径要传 false」，实测否证了 ——
   * 那条路径自己直接 INSERT role_charters（org/commit.ts 的 bumpCharter），
   * **根本不经过本函数**，所以它既不受这个开关影响、也不落预算
   * （那是一条已经存在的缺口，登记在 0015 §4，不由这个开关负责）。
   * 保留它的唯一依据是：「存一版岗位书」与「让这一版的数字开始限流」
   * 逻辑上是两件事（后者会立刻影响正在跑的任务），有人可能需要只存不生效。
   * 这是一格**推测出来的**可扩展点，不是已验证的需求 —— 按 0013/0014 那族
   * 「产物没有消费者」的账读，别按「已支持的场景」读。
   */
  readonly applyBudgets?: boolean;
}

export type SaveCharterResult =
  | {
      ok: true;
      readonly charterId: string;
      readonly version: number;
      /** 那条审计的 events.id。 */
      readonly auditSeq: number;
    }
  | { ok: false; readonly reason: string };

export const LATEST_CHARTER_ROW_SQL =
  "SELECT id, version, config FROM role_charters WHERE role_id = ? ORDER BY version DESC LIMIT 1";

export const CHARTER_ROW_AT_VERSION_SQL =
  "SELECT id, version, config FROM role_charters WHERE role_id = ? AND version = ?";

export const INSERT_CHARTER_VERSION_SQL =
  "INSERT INTO role_charters (id, role_id, version, config, effective_from, created_by) " +
  "VALUES (?, ?, ?, ?, ?, ?)";

/** 这个角色的最高版号；从没写过 ⇒ 0（0 = 「还没有第一版」，不是「第 1 版」）。 */
export function latestCharterVersion(db: DatabaseSync, roleId: string): number {
  const sql = LATEST_CHARTER_ROW_SQL;
  const params = [roleId];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { version: number | bigint }
    | undefined;
  return row === undefined ? 0 : Number(row.version);
}

/**
 * 校验岗位书草案。返回归一后的 Charter（camelCase），失败给出**具体**原因。
 *
 * 为什么不复用 roles/loader.ts 的 loadCharterText：那个函数吃的是 YAML **文本**，
 * 而编辑器提交的是结构化对象。走它要么先把对象 dump 回 YAML（多一次序列化，
 * 且 YAML 里 tab/缩进的报错会指到一个并不存在的「文本位置」），
 * 要么绕过它的 schema —— 后者不可接受，所以直接过同一个 charterSchema，
 * 校验规则仍然只有一处定义（@opc/contracts），没有第二份判据。
 */
export function validateCharterDraft(
  roleId: string,
  config: CharterInput,
): { ok: true; charter: Charter } | { ok: false; reason: string } {
  // config.role_id 与 roleId 不一致时**拒**，而不是以其中一个为准。
  // 采「以入参 roleId 为准」的话，编辑器可以把 A 角色的岗位书写到 B 角色名下，
  // 而库里那一行的 role_id 才是检索用的那个键 —— 一次静默的身份错配。
  // 采「以 config.role_id 为准」则更坏：调用方以为改的是 A，实际动了 B。
  if (config.role_id !== roleId) {
    // 先单独认一次「整份是 camelCase」这个形状，再报不一致。
    // 顺序很重要：直接把不一致那条抛出去，最常见的那类错误（编辑器把读回来的
    // Charter 原样提交，而 Charter 是 camelCase）会收到一句【roleId 不一致】——
    // 人会去查「我传的角色名是不是打错了」，而真正的问题是十四个键名全错了。
    // 这不是第二条校验规则（没有新增判据），只是给同一条判据换一句更准的话。
    const looksCamel =
      (config as unknown as Record<string, unknown>)["role_id"] === undefined &&
      (config as unknown as Record<string, unknown>)["roleId"] !== undefined;
    if (looksCamel) {
      return {
        ok: false,
        reason:
          "收到的草案是 **camelCase**（有 roleId、没有 role_id）。charterSchema 的【输入】是 " +
          "snake_case（role_id / acceptance_criteria / model_tier…），camelCase 是它 transform " +
          "之后的输出形状 —— 也就是【库里读出来的那一版】的形状。" +
          "把读回来的那份直接改一改就提交，会在这里被拒；正确做法是把键名换回 snake_case 再提交。",
      };
    }
    return {
      ok: false,
      reason:
        "roleId 不一致：入参 [" +
        roleId +
        "] 而 config.role_id 是 [" +
        String(config.role_id) +
        "]。刻意不取其中之一为准 —— 那会让一次编辑改到【另一个角色】的岗位书。",
    };
  }
  const parsed = charterSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues as readonly { path: readonly (string | number | symbol)[]; code: string }[];
    const paths = issues.map((i) => i.path.join(".") + "(" + i.code + ")");
    return {
      ok: false,
      reason:
        "岗位书未过校验（" +
        issues.length +
        " 条）。前若干条：\n  - " +
        paths.slice(0, 8).join("\n  - ") +
        "\n注意 charterSchema 的输入是 snake_case（role_id / acceptance_criteria…），" +
        "输出才是 camelCase。一大片 invalid_type 通常就是这个形状写错了。",
    };
  }
  return { ok: true, charter: parsed.data };
}

/**
 * 存一个新版本 + 落一条审计，同一事务。
 *
 * 四条判据（A/B/C 见文件头，第四条是并发）：
 *  ① actor 硬编码 CHARTER_ACTOR，不接受调用方传入。§4.4.3 那条禁令的
 *     执行点必须在写入这一层，否则「agent 不能改自己岗位书」是一句注释。
 *  ② 先校验后写。校验不过 ⇒ 一条审计都不写（与 applyDecision「抢不到就不写审计」
 *     同一条立场：不为一次没发生的变更留 append-only 记录）。
 *  ③ version = 当前最高 + 1，走 UNIQUE(role_id, version) 挡并发。
 *     这里【不】先 SELECT 再 INSERT 就以为安全：两次 saveCharterVersion 交错时
 *     会算出同一个号，靠的是那条 UNIQUE 约束抛错。WriteQueue 已经把事务串成链
 *     （0010 §2 那条实测），正常路径撞不上，但约束是第二道，不是可省的。
 *  ④ 审计 task_id = null：岗位书变更不属于任何一条任务（与 org_graph_changed 同）。
 */
export async function saveCharterVersion(
  w: Writer,
  o: SaveCharterInput,
): Promise<SaveCharterResult> {
  const bad = validateCharterDraft(o.roleId, o.config);
  if (!bad.ok) return { ok: false, reason: bad.reason };
  if (o.changeSummary.trim() === "") {
    return {
      ok: false,
      reason:
        "changeSummary 不能是空串：它是回放与日报里【唯一**人可读**的那句「为什么改」】。" +
        "省掉它，下一次看到这一版的人会自己去猜，而猜的人不在现场。",
    };
  }
  // 归一后的 Charter 再序列化一次：库里只该存**一种**形状（camelCase，
  // 与 org/commit.ts 的 bump 写法一致）。存原始 snake_case 会让同一个字段在两张
  // 来源不同的行里有两种键名，而读回来的人无从分辨那一版是谁写的。
  const configJson = JSON.stringify(bad.charter);

  // 预算两格【在写入之前】换算一次。理由不是提前报错好看，而是：
  // 换算发生在事务里 ⇒ 半分钱那类值会让整笔保存回滚，调用方拿到一个 throw；
  // 而发生在这里 ⇒ 拿到的是与其它校验同一条通道的 { ok:false, reason }。
  // 同一个失败有两种形状，是这一族最容易让上层写漏的地方（它只会 catch 一种）。
  let budgetRows: ReturnType<typeof budgetRowsFromCharter> = [];
  if (o.applyBudgets !== false) {
    try {
      budgetRows = budgetRowsFromCharter(bad.charter);
    } catch (e) {
      return {
        ok: false,
        reason:
          "岗位书本身合法，但它的 budget 两格换算不成整数美分：" +
          (e instanceof Error ? e.message : String(e)),
      };
    }
  }

  const wrote = await w.node(() => {
    const db = requireScopeDb("saveCharterVersion");
    const next = latestCharterVersion(db, o.roleId) + 1;
    const id = randomUUID();
    const params: unknown[] = [id, o.roleId, next, configJson, o.nowMs, CHARTER_ACTOR.actorId];
    assertSingleStatement(INSERT_CHARTER_VERSION_SQL);
    assertParamCount(INSERT_CHARTER_VERSION_SQL, params);
    db.prepare(INSERT_CHARTER_VERSION_SQL).run(...(params as never[]));

    // 岗位书的 budget 两格【同时】落进 budgets 表。这一步是这条通道的全部要点：
    // 判超限时 BudgetTracker 只读 budgets、从不看岗位书（实测），所以「CEO 把
    // 日预算改成 $5」若只写岗位书，执行侧会**继续按老数字放行**，而屏幕上写着 $5。
    // 两个源各存一份、谁生效看谁后写 —— 那就不是配置，是巧合。
    // 详细取舍（为什么不另开一条审计）写在 budget-sync.ts 的 applyBudgetRowsInTx 头上。
    const applied = budgetRows.length > 0 ? applyBudgetRowsInTx(db, budgetRows) : [];
    const silenced = applied.filter((r) => r.alarmSilenced);

    const prev = next - 1;
    const seq = appendAudit(
      db,
      {
        taskId: null,
        actorType: CHARTER_ACTOR.actorType,
        actorId: CHARTER_ACTOR.actorId,
        // action = state_change：AUDIT_ACTIONS 是 §22.1 那个 10 值枚举，
        // 里面没有「配置变更」，而加第 11 个值属改规格（同 0010 §4、org/commit.ts 的判定）。
        // 区分靠 payload.kind。
        action: "state_change",
        // target 指【这一版岗位书本身】而不是角色：日报与回放要能定位「是哪一版」，
        // 而角色 id 对「哪一版」没有信息量（同 org/commit 用版本号而不是图 UUID 那条理由）。
        target: o.roleId + "@v" + next,
        payload: {
          kind: CHARTER_AUDIT_KIND,
          role_id: o.roleId,
          version: next,
          previous_version: prev > 0 ? prev : null,
          change_summary: o.changeSummary,
          // 预算落库的结果挂在这条审计上（而不是另开一条）：
          // 「这次岗位书变更顺带把限流也改了」必须与岗位书变更【同生同死】，
          // 拆成两条就会出现「岗位书那条落了下而这条没落」。
          limits_applied:
            o.applyBudgets === false
              ? null
              : applied.map((r) => ({
                  scope: r.scope,
                  scope_id: r.scopeId,
                  period: r.period,
                  limit_cents: r.limitCents,
                  changed: r.changed,
                })),
          // 唯一需要在收件箱主动喊出来的一维：调低上限会让那一格的突破警报【永久哑】
          // （budget-sync.ts 文件头 ②，实测三条连读）。不写出来的话，CEO 看到的
          // 是「预算已收紧、一切正常」。
          // 键名与 budget-sync 那条审计【刻意同名】(alarm_silenced)：
          // 收件箱/日报要筛的是「有没有哑掉的格」这一维，不该因为写它的人不同而换名。
          alarm_silenced: silenced.map((r) => budgetRowId(r.scope, r.scopeId, r.period)),
        },
        // 前后快照。before 是从库里读的那一版原文（可能为 null = 这是第一版），
        // after 是这次写入的。放 state_snapshot 而不是 payload：与 org/commit 同一口径
        // —— payload 是「这次变更是什么」，快照是「变更前后各是什么」，生命周期不同。
        stateSnapshot: {
          before:
            prev > 0
              ? (readCharterConfigRaw(db, o.roleId, prev) ?? null)
              : null,
          after: JSON.parse(configJson) as unknown,
        },
        createdAt: o.nowMs,
      },
      () => o.nowMs,
    );
    return { id, version: next, seq };
  });

  if (wrote === undefined || wrote === null) {
    return {
      ok: false,
      reason: "事务没有返回结果（WriteQueue 那一层给出空）—— 未写入，未审计。",
    };
  }
  return { ok: true, charterId: wrote.id, version: wrote.version, auditSeq: wrote.seq };
}

/** 取某一版的 config **原文**（不解，给审计快照用）。那一版不存在 ⇒ undefined。 */
function readCharterConfigRaw(
  db: DatabaseSync,
  roleId: string,
  version: number,
): unknown | undefined {
  const sql = CHARTER_ROW_AT_VERSION_SQL;
  const params = [roleId, version];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { config: string }
    | undefined;
  if (row === undefined) return undefined;
  try {
    return JSON.parse(row.config) as unknown;
  } catch {
    // 快照读不出来不影响写入（写的是另一件事），但必须在这里留话：
    // 静默把 before 变成 null 会让审计里出现「从空变更成这一版」的假事实。
    return { degraded: true, raw: row.config, reason: "上一版的 config 不是合法 JSON" };
  }
}

/**
 * 读回某一版并转成 `Charter`。不存在 ⇒ undefined。
 *
 * 这里【不重跑 charterSchema.parse】，是本轮最值得写下来的一处判断。
 * 三个候选：
 *  - **重解析**：读到的东西一定符合当前 schema。听起来最安全，实测却是
 *    **一版都读不出来**（camelCase 过不了 snake_case 的输入，14 条 issue）。
 *    也就是说它会产出一个「永远 undefined」的读取函数，
 *    而调用方拿到 undefined 会读成「这个角色没有岗位书」—— 那是比报错更坏的假事实。
 *  - **写一个 camelCase→snake_case 的逆变换再解析**：多出一份**映射表**，
 *    而 charterSchema 的 transform 已经有了一份正向映射。两份映射必然漂移，
 *    漂移之后校验会悄悄放过/拒掉错误的字段集。这正是 0006 §7 那族「两份抄本」。
 *    要做对得先把 transform 抽成双向可逆的 schema 层（改 @opc/contracts），
 *    那是独立一轮的活，不该塞在这里。
 *  - **不重解析，直接返回**（本模块选的）：写入侧已经强制过同一个 charterSchema，
 *    库里的东西必然是它放行的那份；读回来只是取回事实。
 *
 * 这个选法的**代价必须一起读**：它意味着**「校验」只发生在写入那一刻**，
 * 于是「schema 后来收紧了」（contracts 加一个必填字段）会让历史版本
 * 读回来是 Charter 类型而实际缺字段。我没有能力在这一层挡住它，
 * 所以配了 `assertCharterShape()`（下面）作为**显式**的读侧自检，
 * 并把这件事交给调用方决定何时用 —— 而不是在读取里偷偷塞一个恒真的假校验。
 */
export function readCharterConfig(
  db: DatabaseSync,
  roleId: string,
  version: number,
): Charter | undefined {
  const sql = CHARTER_ROW_AT_VERSION_SQL;
  const params = [roleId, version];
  assertSingleStatement(sql);
  assertParamCount(sql, params);
  const row = db.prepare(sql).get(...(params as never[])) as
    | { config: string }
    | undefined;
  if (row === undefined) return undefined;
  // 解不开要抛，不能返回 undefined：undefined 在本函数的契约里是「那一版不存在」，
  // 而「存在但读坏了」是另一件事，两者让调用方做出【相反】的反应
  //（前者是「这个角色还没配」，后者是「数据坏了，去查库」）。
  try {
    return JSON.parse(row.config) as Charter;
  } catch (e) {
    throw new Error(
      "role_charters 里 " +
        roleId +
        "@v" +
        version +
        " 的 config 不是合法 JSON，无法作为岗位书读出：" +
        (e instanceof Error ? e.message : String(e)) +
        "。这与「那一版不存在」是两件事，所以不返回 undefined。",
    );
  }
}

/** 最新一版。一个角色都没有 ⇒ undefined。 */
export function readLatestCharter(db: DatabaseSync, roleId: string): Charter | undefined {
  const v = latestCharterVersion(db, roleId);
  if (v === 0) return undefined;
  return readCharterConfig(db, roleId, v);
}

/**
 * 读侧自检：把读回来的对象当 Charter 用时**至少**要有的那几格。
 * 缺任何一格就抛，并点名是哪一格。
 *
 * 存在理由见 readCharterConfig 那段末尾：本模块的校验只在写入时发生，
 * 所以读侧需要一个**显式**的兜底，而不是一个假装在校验的 parse。
 * 只查「有没有」不查「形状对不对」—— 再往下查就是第二条 schema，
 * 而那正是我刚才拒绝引入的第二份抄本。
 */
export function assertCharterShape(roleId: string, c: unknown): Charter {
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    throw new Error("岗位书 " + roleId + " 不是对象，实到 " + typeof c + "。");
  }
  const o = c as Record<string, unknown>;
  const missing: string[] = [];
  for (const k of ["roleId", "version", "acceptanceCriteria", "modelTier"] as const) {
    if (o[k] === undefined || o[k] === null) missing.push(k);
  }
  if (!Array.isArray(o["acceptanceCriteria"])) missing.push("acceptanceCriteria(必须是数组)");
  if (missing.length > 0) {
    throw new Error(
      "岗位书 " +
        roleId +
        " 缺必需格 [" +
        missing.join(", ") +
        "]。多半是写入之后 schema 收紧过（写入时校验过的是当时那一版规则）。" +
        "修法是给那一版补一次**迁移期重校验**，不是在这里放宽判据。",
    );
  }
  return c as Charter;
}

/**
 * **门控消费口**：取「角色在某一时点该用的那份验收标准」。
 *
 * 这是本模块存在的理由（文件头 ④）。`criteriaFromCharter` 早就有了，
 * 但它要一份 `Charter`，而 src 里没人能把库里的一版变成 Charter 交进去 ——
 * 于是 Task 3.6 那条 Test「改 acceptance_criteria 后重跑同类任务，门控行为随之变化」
 * 在代码上**无处可测**：改的地方没有，读的地方也没有。
 *
 * `version` 的语义要说准，它有两个合理答案而它们会给出不同的结果：
 *  - **不传** ⇒ 取该角色**当前**最新版。这是「重跑同类任务」那一半要的语义
 *    （改了标准，下一次跑要按新标准判）。
 *  - **传** ⇒ 取那一版。这是**回放**要的语义（那条任务当时按哪一版判的）。
 * 两者混用会得出假结论：拿最新版去回放旧任务，会把「当时标准太松」读成
 * 「当时有人放水」。所以我给两个入口而不是一个带可选参数的函数
 * （见 gateCriteriaForRole / gateCriteriaForRoleAtVersion）。
 */
export function gateCriteriaForRole(
  db: DatabaseSync,
  roleId: string,
): GateCriterion[] {
  const c = readLatestCharter(db, roleId);
  if (c === undefined) {
    throw new Error(
      "角色 [" +
        roleId +
        "] 在 role_charters 里【没有任何版本】，取不到验收标准。" +
        "这不是「该角色没有标准」而是「库里没存过它的岗位书」——" +
        "实测跑完全部迁移之后这张表是空的（0 行，见 0015 §1），所以今天走到这里" +
        "只可能是没调过 saveCharterVersion。刻意不退回 resources/charter-templates/*.yaml：" +
        "那会让「改过库里标准而门控没变」看起来像改动没生效，" +
        "真相是读的是文件而不是库，而两个源永远可能不一致。",
    );
  }
  return criteriaFromCharter(assertCharterShape(roleId, c));
}

/** 回放语义：那一版岗位书的标准。那一版不存在 ⇒ 抛（不退回最新版，同 0012 判据）。 */
export function gateCriteriaForRoleAtVersion(
  db: DatabaseSync,
  roleId: string,
  version: number,
): GateCriterion[] {
  const c = readCharterConfig(db, roleId, version);
  if (c === undefined) {
    throw new Error(
      "角色 [" +
        roleId +
        "] 没有第 " +
        version +
        " 版岗位书。刻意不退回最新版：那会让一次回放显示【当时并不存在】的验收标准，" +
        "与 0012 / 0013 里「不兜底成当前图」是同一条判据。",
    );
  }
  return criteriaFromCharter(assertCharterShape(roleId, c));
}
