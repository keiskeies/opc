/**
 * 章程提案卡片：§7.2 步骤 1 的那个「CEO 收件箱里的第一条」。
 *
 * ── 为什么必须有它 ────────────────────────────────────────────────────
 * 任务落地即 CHARTER_PENDING（real-deps.ts 的 INSERT_TASK_SQL 写死），而那一格是
 * 【人类席位】：dispatch 见到它连 token 都不烧，直接回「等人不等 agent」。
 * 三条出路只在 HUMAN_EDGES 里，全部要一次批准；而批准要有一张卡。
 * 全仓【没有任何代码】建 approval_type='charter' 的卡（grep 的命中只有枚举本身、
 * role-memory 的分类表、和 LangGraph 那条直通桩节点）。也就是说：
 * 下发一个想法 → 任务建出来 → 永久停在 CHARTER_PENDING，收件箱里【一张卡都没有】。
 * 一人公司最核心的那一次交互（CEO 读一份提案、点一次批准）今天不存在。
 *
 * ── 这与「人类席位不放 agent 进场」矛盾吗 ─────────────────────────────
 * 不矛盾，而且这正是本模块【不走 dispatch】的原因。dispatch 那句拒绝的语义是
 * 「这一格的状态跃迁只有人能签」，它说对了，也确实做到了：本模块【不写任何状态边】，
 * CHARTER_PENDING → CHARTER_APPROVED 仍然只有 approveCard 那一条路。
 * 本模块做的是另一件事：【让 agent 起草一份给人签的东西】。起草不是跃迁。
 * 反过来说，把起草塞进 dispatch 会让那条 fail-closed 的席位判据出现一个例外分支，
 * 而「例外」正是那类判据腐烂的方式（见 dispatch.ts 里 seatOf 那段）。
 *
 * ── 卡片里【不能】有什么 ──────────────────────────────────────────────
 * 岗位书模板里带着 CEO-PLACEHOLDER-ACCEPTANCE（验收标准的占位），那是 CEO 手上、
 * 由她写在纸上的东西。我不能替她填：填了之后卡片会显示「验收标准：X」，
 * 而 X 是我编的 —— 她批的是一份【没有人在纸上认过】的章程。
 * 所以 agent 交上来的那几栏【原样】进卡片，缺的就是缺（卡片里明写「未填」），
 * 而卡片本身是【提案】不是【生效的章程】这一点写在 summary 里。
 *
 * ── 一事务四件事（照 dispatch 的写路径）──────────────────────────────
 *  ① 起草那一轮的留痕（RoleTurnReported，payload 带提案原文，供 evidence 指针解引用）
 *  ② 卡片那一行（approval_type='charter'，cardKey 去重）
 *  ③ 卡片那条审计（ApprovalRequired）
 *  ④ 记账（幂等键 = ① 那条的 events.id）
 * 四件同事务 ⇒ 「卡片建了而钱没记」「审计里有批准请求而收件箱没有卡」都不可表达。
 * 广播在提交之后，逐条（少一条就是一个 SSE seq 空洞，0010 §4）。
 */
import type { OrgGraph } from "@opc/contracts";
import type { HubWriter } from "../db/write-queue.js";
import { requireScopeDb } from "../checkpoint/tx-scope.js";
import { appendAudit, KIND_TO_ACTION } from "../events/recorder.js";
import type { DomainEvent } from "../events/bus.js";
import { readGraphByVersion } from "../org/commit.js";
import {
  approvalRequiredEvent,
  insertCard,
  type ApprovalRequiredEvent,
  type NewCardDraft,
} from "../approvals/cards.js";
import type { CostHook } from "./dispatch.js";
import { LEDGER_SQL } from "./dispatch.js";
import { parseDecision, type RoleDecision } from "./claude.js";

/** 起草章程的那个角色。与 tasks.assigned_role 的建卡初值同源（real-deps 的 intakeRole）。 */
export const CHARTER_DRAFT_ROLE = "intake";

/**
 * 卡片去重键。
 *
 * 一个任务【至多一张待批的章程卡】—— 这是 (task_id, card_key) 那条 partial unique
 * index 的直接用法，不需要新增迁移，也不需要「先查后建」（后者在并发下会建出两张，
 * 而 append-only 的审计里会留下两次「这里需要批准」，见 cards.ts 文件头）。
 */
export const CHARTER_CARD_KEY = "charter:proposal";

/** 卡片按钮，与 contracts 的 APPROVAL_BUTTONS 同值（顺序也一致）。 */
const CARD_BUTTONS: readonly ["approve", "reject_with_comment", "defer_deep_review"] = [
  "approve",
  "reject_with_comment",
  "defer_deep_review",
];

/**
 * 让角色起草章程时说的话。
 *
 * 与 buildTurnPrompt 分开的理由不是格式：那一发的契约是「你是一轮干活的员工，
 * 末尾交出下一步的决定」，而这一发的契约是「你起草一份【给 CEO 签】的提案，
 * 你自己不决定任何东西」。混用的话，模型会按干活的口吻交一个 handoff，
 * 而 handoff 在这条路上没有任何意义（本模块根本不读它的下一跳）。
 */
export function buildCharterDraftPrompt(o: {
  readonly title: string;
  readonly role: string;
  readonly ceoRoleId: string;
}): string {
  return [
    "你是 " + o.role + "，正在为 " + o.ceoRoleId + "（公司的 CEO）起草一份【章程提案】。",
    "",
    "CEO 的想法：" + o.title,
    "",
    "请产出一份提案，包含这五栏，逐栏用一行「栏名：内容」的格式写：",
    "业务目标：",
    "可量化验收标准：（三条，每条都可判真假，不要写「效果好」这种判不了的）",
    "预算上限：（美元）",
    "时间约束：",
    "建议参与的角色：",
    "",
    "规则：",
    "· 这是【提案】，不是决定。" + o.ceoRoleId + " 才是决策者，她可以改任何一栏。",
    "· 不知道的就写「未定」，不要编。尤其不要替 " + o.ceoRoleId + " 写验收标准 —— 那是要她认的。",
    "· 不要宣布任务状态变了，也不要批准任何东西。你只负责起草。",
  ].join("\n");
}

/** 提案的机器可读部分（从角色那一轮的结构化决策里取）。 */
export interface CharterDraft {
  /** 一句话摘要，进卡片第一行。 */
  readonly summary: string;
  /** 角色那一轮的完整自由文本，进审计 payload，evidence 指针指向它。 */
  readonly text: string;
}

/**
 * 从一轮输出里取出提案。
 *
 * 只认 parseDecision 那一份结构化决策里的 summary —— 不为提案另立一套标记格式：
 * 两套标记 = 两种「模型跑偏」的失效方式，而这一发不需要更多的失效方式。
 * 取不到 ⇒ null，调用方【不建卡】（建一张内容空白的卡会让 CEO 以为系统坏了，
 * 而真正该看到的是「这一轮没交出提案」）。
 */
export function parseCharterDraft(text: string): CharterDraft | null {
  const d: RoleDecision | null = parseDecision(text);
  if (d === null) return null;
  const s = d.summary.trim();
  if (s === "") return null;
  return { summary: s, text };
}

/** 把提案原文折进卡片第二行那句 impact_scope（契约只收字符串，不收结构体）。 */
function impactScopeOf(text: string): string {
  // 卡片契约的 parameters.impact_scope 是 z.string().min(1)，没有长度上限，
  // 但它是【界面第一屏】要显示的那一行：截断并留省略号（同 app.ts 的 titleOf 那条口径），
  // 全文在 evidence 指针指向的那条审计里 —— 点开就在，不需要把整段塞进第一行。
  const flat = text.replace(/\s+/gu, " ").trim();
  const cut = flat.length > 600 ? flat.slice(0, 600) + "…（全文见证据）" : flat;
  return "这份章程一旦签署就生效：它决定这件事的目标、验收口径、预算与参与角色。提案原文：" + cut;
}
export interface CharterDraftOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly costCents: number;
  /**
   * 这一轮的会话 id。本模块【不读它】（起草是一次性的，不 --resume 也不续），
   * 留在签名里是为了与 DispatchDeps.runTurn 同构 —— 装配方可以把同一个回调喂两边，
   * 换掉实现时不会因为少一格而编译不过。
   */
  readonly sessionId: string | null;
  readonly error: string | null;
}

export interface CharterOptions {
  readonly taskId: string;
  readonly nowMs: number;
  readonly maxBudgetUsd: number;
  /** 起草人的角色。默认 CHARTER_DRAFT_ROLE；任务上写着别的就按别的（见下面的解析）。 */
  readonly role?: string;
}

export interface CharterResult {
  readonly outcome:
    /** 卡片建出来了。 */
    | "drafted"
    /** 任务不在库里。 */
    | "task_missing"
    /** 任务不在 CHARTER_PENDING —— 这一发只管章程那一格。 */
    | "not_charter_pending"
    /** 已经有待批的章程卡了。没再烧一次 token。 */
    | "already_pending"
    /** 组织图读不出来 / 起草角色不在图上。 */
    | "org_blocked"
    /** 角色跑了一轮但没交出可用的提案（或执行失败）。钱照记，卡不建。 */
    | "no_draft";
  readonly note: string;
  readonly costCents: number;
  readonly card: ApprovalRequiredEvent | null;
  readonly published: readonly { readonly event: DomainEvent; readonly seq: number }[];
}

const LOAD_CHARTER_TASK_SQL =
  "SELECT id, title, status, assigned_role, graph_version FROM tasks WHERE id = ?";

/** 这张卡为什么还没被批掉 / 为什么建不出来 —— 收件箱与 CLI 都读这一句。 */
export function charterCardDraft(o: {
  readonly taskId: string;
  readonly summary: string;
  /**
   * 提案【原文】。这一格收原文而不是再来一个 summary 是有原因的：卡片第二行
   * （impact_scope）是 CEO 在收件箱里【不点开就能看见】的那一行，而契约只收字符串。
   * 传摘要会让那张卡的第一屏等于它自己的第一行 —— 两行说同一句话，等于省掉了证据，
   * 而 §8.2 第 2 条要的是「点开之前就能判断要不要点开」。
   */
  readonly draftText: string;
  readonly evidenceRef: string;
  readonly ceoRoleId: string;
}): NewCardDraft {
  return {
    taskId: o.taskId,
    // "charter" 而不是 "strategic"：APPROVAL_TYPES 里两类都存在，而 §7.2 步骤 1 那份
    // 提案的类别就是章程（role-memory 的战略档分类靠这一列，选错会把它记成另一类记忆）。
    approvalType: "charter",
    cardKey: CHARTER_CARD_KEY,
    // 「提案」两个字在第一行：CEO 扫收件箱时要在点之前就知道这一次签的是【一份还没生效的东西】。
    summary: "章程提案待你签署：" + o.summary,
    parameters: {
      impact_scope: impactScopeOf(o.draftText),
      // 章程是授权本身：签下去之后角色按它干活。标 irreversible=true 是让收件箱
      // 把它排在「要真读一遍」那一档，而不是当一次日常放行。
      irreversible: true,
      recommendation:
        "读完下面那段提案原文再签。五栏里有「未定」就说明它【不该现在签】—— " +
        "退回并写明哪一栏要补，比签一个带洞的章程便宜。",
      // 契约里这一格是 literal(true)：漏标不是风格问题，是让 CEO 把推荐读成结论。
      recommendation_is_not_decision: true,
      // escalate 而不是 auto_approve：自动批准一份章程等于绕过 §8.2 第 4 条，
      // 而章程是【授权本身】—— 它不能由被它授权的那套系统自己批。
      timeout_behavior: "escalate",
    },
    evidence_refs: [o.evidenceRef],
    buttons: [...CARD_BUTTONS],
  };
}

/**
 * 起草并建卡。
 *
 * @param runTurn 起一次角色。由调用方给（与 DispatchDeps.runTurn 同一个签名），
 *   这样本模块【不 import claude.ts 的子进程那一层】，测试可以喂一段写好的文本，
 *   而「真起子进程」那条路径在 runtime.test.ts / claude.test.ts 里已经各自钉住了。
 */
export async function ensureCharterCard(
  w: HubWriter,
  o: CharterOptions,
  deps: {
    readonly runTurn: (i: {
      readonly role: string;
      readonly rolePrompt: string;
      readonly prompt: string;
      readonly resumeSessionId: string | null;
      readonly maxBudgetUsd: number;
    }) => Promise<CharterDraftOutcome>;
    readonly rolePrompt: (roleId: string) => string;
    readonly ceoRoleId?: string;
    readonly onCost?: CostHook;
    /** 必填（与 dispatch / applyDecision 同源的理由：写完不广播 = 在活连接上挖 seq 空洞）。 */
    readonly publish: (e: DomainEvent, seq: number) => void;
  },
): Promise<CharterResult> {
  const ceo = deps.ceoRoleId ?? "ceo";
  const nothing: CharterResult = {
    outcome: "no_draft",
    note: "",
    costCents: 0,
    card: null,
    published: [],
  };

  // ── 前置检查（读，不开事务）────────────────────────────────────────
  const head = w.readConnection().prepare(LOAD_CHARTER_TASK_SQL).get(o.taskId) as
    | Record<string, unknown>
    | undefined;
  if (head === undefined) {
    return { ...nothing, outcome: "task_missing", note: "任务不在库里，什么都没做。" };
  }
  const status = String(head["status"] ?? "");
  if (status !== "CHARTER_PENDING") {
    return {
      ...nothing,
      outcome: "not_charter_pending",
      note: "任务现在在 " + status + "，章程那一格已经过去了（这一发只管 CHARTER_PENDING）。",
    };
  }
  const role = o.role ?? (String(head["assigned_role"] ?? "") === "" ? CHARTER_DRAFT_ROLE : String(head["assigned_role"]));

  // 图这一关【照 dispatch 的规矩】：任务用创建时那一版（§18.4），起草角色必须在图上。
  // 不在图上就跑不了 —— 一个「组织里查无此人」的角色照样能烧钱起草一份章程，
  // 那不是「灵活」，那是没有边界。CEO 的解法是在组织图里加上这个角色，不是这里放行。
  let graph: OrgGraph | null = null;
  try {
    graph = readGraphByVersion(w.readConnection(), Number(head["graph_version"]));
  } catch (e) {
    return {
      ...nothing,
      outcome: "org_blocked",
      note: "组织图版本 " + String(head["graph_version"]) + " 读不出来：" + (e instanceof Error ? e.message : String(e)),
    };
  }
  if (graph.nodes[role] === undefined) {
    return {
      ...nothing,
      outcome: "org_blocked",
      note:
        "起草角色 [" + role + "] 不在组织图 v" + String(head["graph_version"]) + " 上，所以没法让它起草章程。" +
        "解法是在组织图里加上这个角色（它得是这家公司的一员），不是让这里绕过组织图。",
    };
  }

  const title = String(head["title"] ?? "");

  // ── 去重【排在起子进程之前】：已经有一张待批的章程卡就不烧这一次 token ──
  // 这里的「先查」与 cards.ts 里「不先查后插」不冲突，两件事：
  //  ① 那边防的是【建出两张卡】，靠唯一索引兜，那个仍在（下面的 insertCard 照样会撞键）；
  //  ② 这里防的是【为一张已经存在的卡再烧一次 token】—— 那是纯浪费，而唯一索引管不着
  //    （它只让第二次建卡失败，管不了我在它之前已经花了钱）。
  const pend = w
    .readConnection()
    .prepare("SELECT id FROM approvals WHERE task_id = ? AND card_key = ? AND status = 'pending' LIMIT 1")
    .get(o.taskId, CHARTER_CARD_KEY) as Record<string, unknown> | undefined;
  if (pend !== undefined) {
    return {
      ...nothing,
      outcome: "already_pending",
      note:
        "这件事已经有一张待批的章程卡（id = " + String(pend["id"]) + "），没有再烧一次 token。" +
        "下一步是去收件箱点它，不是再起草一遍。",
    };
  }

  // ── 起草（真花 token，在事务【外】）─────────────────────────────────
  const res = await deps.runTurn({
    role,
    rolePrompt: deps.rolePrompt(role),
    prompt: buildCharterDraftPrompt({ title, role, ceoRoleId: ceo }),
    resumeSessionId: null,
    maxBudgetUsd: o.maxBudgetUsd,
  });

  const draft = res.ok ? parseCharterDraft(res.text) : null;
  /**
   * 记这一笔账。两处分支（有提案 / 没提案）各调【至多一次】，所以抽成闭包。
   *
   * 【两条腿都要走】：deps.onCost 写的是 budgets / budget_events（带 source_event
   * 幂等键），而 tasks.consumed_cents 是【另一列】—— dispatch 里它由 WRITE_EDGE_SQL /
   * LEDGER_SQL 那两条 UPDATE 带上去，本模块不写状态边，所以那一列【必须自己加】。
   * 少加的后果不是崩：GET /tasks 读的是 tasks.consumed_cents（http/app.ts 的
   * TASK_COLUMNS），于是看板显示这条任务「没花过钱」，而 budgets 里确实扣了 ——
   * 同一个数在两张表上给出两个答案，而这正是我写这条测试时【它当场抓出来】的缺陷
   * （我第一版只调了 onCost，那条断言就红了）。
   */
  const bill = (db: Parameters<typeof appendAudit>[0], seq: number): void => {
    if (res.costCents <= 0) return;
    deps.onCost?.({ db, taskId: o.taskId, role, seq, costCents: res.costCents, nowMs: o.nowMs });
    db.prepare(LEDGER_SQL).run(...([res.costCents, o.nowMs, o.taskId] as never[]));
  };
  if (draft === null) {
    // ── 这一轮失败了：【留痕】与【结账】是两件事，0043 之前它们被写成了同一件 ──
    // 旧形状的写法是 `if (cost > 0) { 开事务 → 写审计 → 记账 }`：那句「失败了也要结账」
    // 是对的（这一轮真花了钱，claude.ts / dispatch 同一条理由，而「卡没建 ⇒ 当什么都没发生」
    // 会让账面比实际乐观），但它把【审计那一行】也一起关进了那个 if 里。
    // 于是「花了钱」这一个判据同时管着两件事：
    //   · 该不该记账 —— 该。没花钱就该记 0，什么都不该加。
    //   · 该不该留痕 —— 【不该跟着钱走】。这一轮发生过、失败了，这件事与花没花钱无关。
    // 具体漏掉的是【零花费的失败】：claude CLI 起不来 / spawn ENOENT / 权限不对
    // 那些情况 costCents 恒为 0，探针实测（0043 §10）——
    //   outcome='no_draft' 而 events 表【零行】，tasks.consumed_cents 也是 0。
    // 也就是「intake 试过了、失败了、什么都没留下」。
    // 这在 CLI 那一侧只是不便（cmdWork 会把那句人话打到 stderr，人看得见）；
    // 而它一旦成为常驻泵的重试判据，就是**没有痕迹的无限重启子进程**：
    // 每次心跳一次 no_draft、零行审计 ⇒ 没有任何东西能数出"这是第几次"，
    // 也就没有任何东西能决定"别再试了"。所以修 pump 之前先修这一格。
    // 修法是把两件事拆开：审计无条件写，记账仍然由 bill() 自己判 costCents（它一直这么判）。
    const cost = res.costCents;
    const failPublished: { event: DomainEvent; seq: number }[] = [];
    await w.node(() => {
      const db = requireScopeDb("engine.charter.failturn");
      const evt: DomainEvent = {
        kind: "RoleTurnReported",
        taskId: o.taskId,
        role,
        state: "CHARTER_PENDING",
        // 那句话原来写的是「没交出提案，钱照记：…」—— 零花费时「钱照记」是假的，
        // 而这一行现在两种情况都要用，所以换成一句两都可说的话，钱由下面单独带。
        note:
          "章程起草那一轮没交出可用的提案：" +
          String(res.error ?? "输出里没有可用的结构化提案") +
          (cost > 0 ? "（这一轮花了 " + cost + " 美分，已入账）" : "（这一轮没花钱）"),
        costCents: cost,
      };
      const seq = appendAudit(
        db,
        {
          taskId: o.taskId,
          actorType: "agent",
          actorId: role,
          action: KIND_TO_ACTION.RoleTurnReported,
          target: role,
          payload: { ...evt },
        },
        () => o.nowMs,
      );
      // 判据只有【花了钱】这一条，不含「装配给了记账钩子」：onCost 少装是装配缺陷，
      // 它不该连带让 tasks.consumed_cents 也不加 —— 那会把一个可见的缺配置
      // 变成一个【不可见的少记账】。cost 为 0 时 bill 自己 return。
      bill(db, seq);
      failPublished.push({ event: evt, seq });
      return null;
    });
    // 同样在提交之后才广播（回滚了就没这一行）。
    for (const p of failPublished) deps.publish(p.event, p.seq);
    return {
      outcome: "no_draft",
      note:
        "章程起草那一轮没交出可用的提案（" + String(res.error ?? "输出里没有 <<<OPC_DECISION>>> 那一段") + "）。" +
        "没有建卡 —— 建一张内容空白的卡会让收件箱里出现一件【点开却没有内容】的事。" +
        (cost > 0 ? " 这一轮花的 " + cost + " 美分已入账。" : " 这一轮没花钱，但审计里留了这一行。"),
      costCents: cost,
      card: null,
      published: [],
    };
  }

  // ── 落库：留痕 + 卡片 + 卡片审计 + 记账，一个事务 ────────────────────
  const wrote = await w.node(() => {
    const db = requireScopeDb("engine.charter.write");
    const turnEvt: DomainEvent = {
      kind: "RoleTurnReported",
      taskId: o.taskId,
      role,
      state: "CHARTER_PENDING",
      note: "起草了一份章程提案：" + draft.summary,
      costCents: res.costCents,
    };
    // 提案【原文】落在 state_snapshot 而不是 payload：payload 是【事件的形状】
    // （前端投影按它读，多一个键等于改契约），而原文是这条事实的附件
    // （同 applyDecision 把 note 放 state_snapshot 那条理由）。
    const turnSeq = appendAudit(
      db,
      {
        taskId: o.taskId,
        actorType: "agent",
        actorId: role,
        action: KIND_TO_ACTION.RoleTurnReported,
        target: role,
        payload: { ...turnEvt },
        stateSnapshot: { draft: draft.text },
      },
      () => o.nowMs,
    );
    const published: { event: DomainEvent; seq: number }[] = [{ event: turnEvt, seq: turnSeq }];

    // 证据指针指向【刚才那条审计】的 id：提案原文就在那一行的 state_snapshot 里。
    // 为什么不用文件名/URL：这一发【没有】写任何文件，编一个路径等于给出一张点不开的证据
    // （§8.2 第 2 条要的是「通过必须附可验证证据」，指针打不开就是假证据）。
    const evidenceRef = "events:" + turnSeq + "#state_snapshot.draft";
    const cardDraft = charterCardDraft({
      taskId: o.taskId,
      summary: draft.summary,
      draftText: draft.text,
      evidenceRef,
      ceoRoleId: ceo,
    });
    const card = insertCard(db, cardDraft, { nowMs: o.nowMs });
    if (!card.created) {
      // 撞了去重键 ⇒ 并发里另一发已经建好了。本轮的留痕与账【照写】（token 真花了、
      // 起草真发生了），只是不再发一条 ApprovalRequired —— 发了会让收件箱角标 +2
      // 而实际只有一张卡（dispatch 里同源的那条注释）。
      bill(db, turnSeq);
      return { created: false as const, published };
    }
    const cardEvt = approvalRequiredEvent(o.taskId, card.approvalId, cardDraft, cardDraft.approvalType);
    const cardSeq = appendAudit(
      db,
      {
        taskId: o.taskId,
        // system/hub：卡片是【系统提出的一次请求】，不是任何人的决定（createCard 同条理由）。
        actorType: "system",
        actorId: "hub",
        action: KIND_TO_ACTION.ApprovalRequired,
        target: card.approvalId,
        // evt.payload 而不是 {...evt.payload}，两件事分开说：
        //  · 【形状】要的是内层那份 {kind, approval_type, summary, evidence_refs} —— 与
        //    createCard（http/巡检建卡走的那条）落同一份形状，那份被 cards.test.ts:438
        //    钉在顶层。dispatch 里从前写的 {...evt} 已被纠正，完整理由写在 dispatch.ts
        //    那一处（同一类事实有两种形状 = 按 approval_type 数待批事项的读法漏掉一类）。
        //  · 【不展开】是因为 DomainEvent 里 ApprovalRequired.payload 声明成 unknown
        //    （bus.ts），而展开 unknown 是编译错 TS2698。展开也本来不必要：这份对象
        //    从构造到落库只读，appendAudit 拿到它就 JSON.stringify。
        payload: cardEvt.payload,
      },
      () => o.nowMs,
    );
    published.push({ event: cardEvt, seq: cardSeq });
    // 幂等键取【本轮那条留痕】的 id（不是卡片那条）：撞去重键的那一支没有卡片行，
    // 两支用同一个键才不用在两个分支里各记一次（dispatch 把这一发放在 if/else 之外同理）。
    bill(db, turnSeq);
    return { created: true as const, published, cardEvt };
  });

  // 提交之后才广播（回滚的那些行根本没存在过 —— §5.8）。
  for (const p of wrote.published) deps.publish(p.event, p.seq);

  if (!wrote.created) {
    return {
      outcome: "already_pending",
      note: "并发里已经有人建好了那张章程卡，本轮的起草与账都落了，没有重复发批准请求。",
      costCents: res.costCents,
      card: null,
      published: wrote.published,
    };
  }
  return {
    outcome: "drafted",
    note:
      "章程提案已进 CEO 收件箱（" + draft.summary + "）。下一步是那次点击，不是再跑一次起草。",
    costCents: res.costCents,
    card: wrote.cardEvt,
    published: wrote.published,
  };
}
