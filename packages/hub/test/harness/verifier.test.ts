/**
 * Task 5.4 的独立验证测试（【规格】§12.4 / §12.6 / §23.1 Phase 1）。
 *
 * 计划点名的两条 Test 是这组的骨架：
 *   ① 故意让开发 Agent 谎报「测试通过」⇒ 测试 Agent 在独立工作区跑出失败 ⇒ 门控 reject；
 *   ② 两次调用使用**不同 session 且 model_family 不同**。
 *
 * ── ①的实现方式值得先说清，它决定了这一组用例在测什么 ──────────────
 * 谎报**不需要被识破** —— 作者的文本从未进入 `verifyFix` 的任何入参。
 * 所以这一组里没有一条用例是「把谎报识别出来」，而是
 * 「**谎报在场外**」+「**审阅方自己跑出来的数字决定结论**」。
 * `stripSelfReported` 是兜底（防的是将来有人把作者证据包整个传进来），不是主判据。
 *
 * ── 这个文件里最贵的几条用例，每一条都是我自己写错之后补的 ──────────
 * ① `producer` / `reviewer` 那一维（我把两侧都填成审阅方 ⇒ 每一次审阅都 escalate）；
 * ② `bundle_type` 与 gate 的匹配（test_report 配 dev_to_test ⇒ 每一次都恒拒）；
 * ③ 缺 `integrityOk` 入参（⇒ 一次**干净**运行也永远 escalate）；
 *    ①②③ 是同一族：**恒判定**——门控在动、结论在出、审计在写，而结论与产出无关。
 * ④ `verifier_not_enforced`（第一版**整条判据都不存在**：独立性只判了目录/角色/家族）；
 * ⑤ 派生目录与嵌套判据**互相矛盾**（见「派生目录必须落在作者写范围之外」那一组）——
 *    那一组第一条用例是「一次正常调用应当成功」，而它一开始是红的；
 * ⑥ 一条**永远不通**的断言（见「码表必须有返回点」里的写法注释）。
 *    它和这个文件一路在防的「恒绿断言」一样没用，只是坏在反方向上。
 * ⑦ 一条**恒绿的夹具断言**：`not.toContain("自测通过")`，而夹具里根本没有那句话
 *    （见「请求装配」里那段删除说明）—— 判据引用的东西得先确认真的在输入里。
 */
import type {
  CostReport,
  HarnessAdapter,
  HarnessCapabilities,
  HarnessEvent,
  HarnessRequest,
} from "@opc/contracts";
import { SHA256_RE, evidenceBundleSchema } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import type { AuditRow } from "../../src/events/recorder.js";
import type { GateCriterion } from "../../src/graph/gates/evaluate.js";
import {
  DEFAULT_VERIFY_ROOT,
  independenceBlock,
  independentWorkspace,
  SELF_REPORTED_PATTERNS,
  sessionIndependenceBlock,
  stripSelfReported,
  verifierAuditRow,
  verifierStage,
  VERIFY_REJECT_CODES,
  type VerifyInput,
  verifyFix,
} from "../../src/harness/verifier.js";

/* ═════════════════ fake 适配器与入参装配 ═════════════════ */

const APPROVING: HarnessCapabilities = {
  budgetHardCap: true,
  toolApproval: true,
  resume: true,
  structuredOutput: true,
};

const SHA_A: string = "a".repeat(64);
const COST: CostReport = { spentCents: 50, remainingCents: null, source: "harness" };

function stream(events: HarnessEvent[]): AsyncIterable<HarnessEvent> {
  return (async function* () {
    for (const e of events) yield e;
  })();
}

/**
 * 可控的审阅适配器：会话与模型家族都由测试给，好让「同会话 / 同家族」这两种坏法可造。
 * 这两格**必须由结果给而不是由请求给** —— §5.9 判同源读的是实际用了哪一家，
 * 请求里那格是「想要」，适配器可以不听。
 */
function adapter(
  o: {
    sessionId?: string;
    modelFamily?: string;
    exitCode?: number | null;
    caps?: Partial<HarnessCapabilities>;
    seen?: HarnessRequest[];
  } = {},
): HarnessAdapter {
  const events: HarnessEvent[] = [
    { kind: "session_started", sessionId: o.sessionId ?? "ver-sess-1" },
    { kind: "usage", cost: COST },
    {
      kind: "finished",
      exitCode: o.exitCode ?? 0,
      outcome: {
        harnessId: "codex",
        harnessVersion: "1.2.3",
        modelFamily: o.modelFamily ?? "gpt",
        output: "跑完了，两个用例没过",
        diffHash: null,
      },
    },
  ];
  return {
    id: "codex",
    capabilities: { ...APPROVING, ...(o.caps ?? {}) },
    execute: (rq: HarnessRequest): AsyncIterable<HarnessEvent> => {
      if (o.seen !== undefined) o.seen.push(rq);
      return stream(events);
    },
    resume: (): AsyncIterable<HarnessEvent> => stream(events),
    getCost: async (): Promise<CostReport> => COST,
  };
}

/**
 * ⚠ `condition` 的语义是「**不合格的情形**」（见 evaluate.ts 的 CriterionOutcome：
 * 条件成立 = violated = 违反标准）。所以「覆盖率不得低于 90」要写成
 * `metric:coverage < 90`，**不是** `>= 90`。
 *
 * 我第一版写的是 `>= 90`，于是「覆盖率 95 ⇒ pass」那条用例是红的而「61 ⇒ reject」
 * 是绿的 —— 看起来一切正常，只是方向整个反了：那道门会在覆盖率达标时打回、
 * 在覆盖率不达标时放行。一条**方向反了**的判据比一条没有判据更糟，
 * 因为它带着「已经配过标准」的外观。
 */
const COVERAGE_CRITERION: GateCriterion = {
  condition: "metric:coverage < 90",
  action: "reject",
  message: "覆盖率低于 90 不得标记通过（【规格】§12.6 第 2 条的硬约束）",
};

function deps(over: Partial<VerifyInput> = {}): VerifyInput {
  const sink: AuditRow[] = [];
  return {
    taskId: "task-1",
    author: { roleId: "dev", modelFamily: "claude", sessionId: "dev-sess-1" },
    authorWorkspace: "/repo",
    adapter: adapter(),
    verifierRoleId: "test",
    instruction: "在隔离工作区运行完整测试套件，输出覆盖率与未通过项清单",
    stage: verifierStage(),
    allowedTools: ["Read", "Bash"],
    forbiddenFlags: ["--yolo", "--full-auto"],
    maxBudgetUsd: 1,
    modelFamily: "gpt",
    // 审阅方**自己**跑出来的数字：谎报不参与这里任何东西。
    assemble: () => ({
      artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
      claims: [{ text: "跑完 42 个用例，2 个未通过", evidence_refs: ["cov.json"] }],
      metrics: { coverage: 61 },
    }),
    criteria: [COVERAGE_CRITERION],
    gateway: {
      audit: (row: AuditRow): number => {
        sink.push(row);
        return sink.length;
      },
      grantedSandbox: "workspace-write",
      grantedForbidden: ["--yolo", "--full-auto"],
    },
    ...over,
  };
}

/* ═════════════════ ① 计划点名的那条主链 ═════════════════ */

describe("① 谎报 ⇒ 独立工作区跑出失败 ⇒ 门控 reject", () => {
  it("一次配置正确的调用**能跑通**（这条先绿，后面每一条才有意义）", async () => {
    const r = await verifyFix(deps());
    if (!r.ok) throw new Error("不应被拒：" + r.code + " / " + r.reason);
    expect(r.verdict.decision).toBe("reject");
    expect(r.bundle.metrics?.["coverage"]).toBe(61);
  });

  it("结论**只由审阅方的 metrics 决定**（谎报不在场，不需要被识破）", async () => {
    // VerifyInput 里**没有任何字段**能放作者的自测文本 —— 这才是 §12.6
    // 「测试 Agent 忽略该文本」的实现方式：不是一次字符串匹配，是一个入参形状。
    const low = await verifyFix(deps());
    const high = await verifyFix(
      deps({
        integrityOk: true,
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
          claims: [{ text: "全过", evidence_refs: ["cov.json"] }],
          metrics: { coverage: 95 },
        }),
      }),
    );
    if (!low.ok || !high.ok) throw new Error("不应被拒");
    expect(low.verdict.decision).toBe("reject");
    // 同一条判据的另一侧。缺了它，那道门等于恒拒，而恒拒与恒放行一样没用。
    expect(high.verdict.decision).toBe("pass");
  });

  it("⭐ 完整性没对账 ⇒ 干净运行也**出不了 pass**（每次都升级人工）", async () => {
    // 这是本模块**第三个**「恒判定」缺陷，前两是 producer 填错与 bundle_type 对不上。
    // 形状：evaluateGate 在 unresolved 非空时不 pass（它自己的注释说得对：
    // 「最省事的假绿方式不是伪造覆盖率，而是【不提覆盖率】」），
    // 而我第一版**没有** integrityOk 这个入参 ⇒ 每一格都对的运行也永远 escalate。
    // 这一格只能由调用方给（只有它能读磁盘核 sha256；我自己算就是再编一份证据）。
    const unaudited = await verifyFix(
      deps({
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
          claims: [],
          metrics: { coverage: 95 },
        }),
      }),
    );
    if (!unaudited.ok) throw new Error("不应被拒：" + unaudited.code);
    expect(unaudited.verdict.decision).toBe("escalate");
    expect(unaudited.verdict.unresolved.join(" ")).toContain("完整性未对账");
    // 给了就能 pass —— 证明上面那条 escalate 是**这一格**造成的，不是别处恒拦。
    const audited = await verifyFix(
      deps({
        integrityOk: true,
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
          claims: [],
          metrics: { coverage: 95 },
        }),
      }),
    );
    if (!audited.ok) throw new Error("不应被拒：" + audited.code);
    expect(audited.verdict.decision).toBe("pass");
    expect(audited.verdict.unresolved).toEqual([]);
  });

  it("⭐ 产出的包类型与 gate 要求的包类型**必须对得上**", async () => {
    // 我在这里错过一次：产的是 test_report，而默认 gate 曾写成 dev_to_test（要 code_diff）。
    // 门控于是**每一次**都 reject，理由「包类型不符」——
    // 一次两次会被当成真问题去查代码，一直这样就会被当成「门控在正常工作」。
    const r = await verifyFix(deps());
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(r.bundle.bundle_type).toBe("test_report");
    expect(r.verdict.reasons.join(" ")).not.toContain("证据包类型");
    // 反过来：显式走 dev_to_test 就得**因为类型**被拒（证明这条断言有判别力）。
    const wrong = await verifyFix(deps({ gate: "dev_to_test" }));
    if (!wrong.ok) throw new Error("门控本身仍应给出结论：" + wrong.code);
    expect(wrong.verdict.decision).toBe("reject");
    expect(wrong.verdict.reasons.join(" ")).toContain("证据包类型");
  });

  it("⭐ producer 是作者、reviewer 是审阅方（两侧同源 ⇒ 每次 escalate）", async () => {
    // 第一版两处都填审阅方（「这份 test_report 是审阅方产的」听起来对），
    // 而 evaluateGate 第 3 步判的正是 reviewer.roleId === producer.roleId ⇒
    // **每一次**都 escalate，报错是「作者不给自己打分」。
    // 那是本文件最像成功的失败：门控在动、结论在出、审计在写，而每一次都是同一句话。
    const r = await verifyFix(deps());
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(r.verdict.decision).not.toBe("escalate");
    // 而证据包的身份那一格**仍然**是审阅方（§8.1 的包类型核对读它）。
    expect(r.bundle.produced_by_role).toBe("test");
  });

  it("包过契约校验（我们造的东西得能被下游读回来）", async () => {
    const r = await verifyFix(deps());
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(() => evidenceBundleSchema.parse(r.bundle)).not.toThrow();
  });

  it("完整性对账**不通过** ⇒ reject，本模块不替调用方把这一格抹平", async () => {
    // 三条一侧构成一组对照：undefined ⇒ escalate（没人判）、false ⇒ reject（判过、不符）、
    // true ⇒ pass。少了 false 这一侧，「我们把这一格透过去了」这句话没被证过。
    const r = await verifyFix(
      deps({
        integrityOk: false,
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
          claims: [],
          metrics: { coverage: 95 },
        }),
      }),
    );
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(r.verdict.decision).toBe("reject");
    expect(r.verdict.reasons.join(" ")).toContain("完整性");
  });
});

/* ═════════════════ ② 四维独立性 ═════════════════ */

describe("② 四维独立性（目录 / 会话 / 家族 / 否决权）", () => {
  it("⭐ 两次调用使用不同 session **且**不同 model_family（计划点名）", async () => {
    const seen: HarnessRequest[] = [];
    const r = await verifyFix(deps({ adapter: adapter({ seen }) }));
    if (!r.ok) throw new Error("不应被拒：" + r.code + " / " + r.reason);
    expect(seen).toHaveLength(1);
    expect(r.verifier.sessionId).toBe("ver-sess-1");
    expect(r.verifier.sessionId).not.toBe("dev-sess-1");
    // 家族取的是**结果里实际用的**那一格，不是请求里期望的那个。
    expect(r.verifier.modelFamily).toBe("gpt");
    expect(r.verifier.modelFamily).not.toBe("claude");
    // 第三维：工作区也不同。
    expect(seen[0]?.workspace).not.toBe("/repo");
  });

  it("同会话 ⇒ 拒（换目录不换会话 = 同一个 agent 换个地方重跑）", async () => {
    const r = await verifyFix(deps({ adapter: adapter({ sessionId: "dev-sess-1" }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("same_session");
  });

  it("会话缺失 ⇒ 拒，而不是把『空串与任何值都不相等』当成独立", () => {
    // 两个方向分开判、分开报错（缺的是**哪一侧**会话，修法不同）。
    const noAuthor = sessionIndependenceBlock("", "ver-1");
    expect(noAuthor.ok).toBe(false);
    if (!noAuthor.ok) {
      expect(noAuthor.code).toBe("empty_session");
      expect(noAuthor.reason).toContain("产出方");
    }
    const noVerifier = sessionIndependenceBlock("dev-1", "  ");
    expect(noVerifier.ok).toBe(false);
    if (!noVerifier.ok) expect(noVerifier.reason).toContain("审阅方");
  });

  it("同模型家族 ⇒ 拒（判据**复用**门控层那一份，不写第二份）", async () => {
    const r = await verifyFix(deps({ adapter: adapter({ modelFamily: "claude" }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("same_model_family");
  });

  it("家族未声明 ⇒ 拒（『不填』不能成为绕过同源拦截的通路）", async () => {
    const r = await verifyFix(deps({ author: { roleId: "dev", modelFamily: "", sessionId: "d1" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("unknown_model_family");
  });

  it("同家族 + CEO 显式批准 ⇒ 放行（与门控层同一份凭据形状）", async () => {
    const r = await verifyFix(
      deps({
        adapter: adapter({ modelFamily: "claude" }),
        sameFamilyApproval: { approvedBy: "ceo", reason: "只剩这一家有配额" },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("批准人不是 ceo ⇒ 拒（作者能自己批准自己就等于没这条）", async () => {
    const r = await verifyFix(
      deps({
        adapter: adapter({ modelFamily: "claude" }),
        sameFamilyApproval: { approvedBy: "dev", reason: "我自己批" },
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("approval_by_author");
  });

  it("⭐ 审阅侧没有否决权 ⇒ 拒（第一版**整条判据都不存在**的那一维）", async () => {
    // 独立性讲的是「谁在看」，而「看的那一家会不会被我们问到」看起来是另一个话题 ——
    // 它是同一件事：审阅方的结论要能变成一次拦下，靠的是我们有权不让它继续。
    // 跑在 toolApproval=false 上，那次「审阅」只是一次**观察**（0021 §6 的 observed_only）。
    const r = await verifyFix(deps({ adapter: adapter({ caps: { toolApproval: false } }) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("verifier_not_enforced");
  });

  it("审批策略是 never ⇒ 同样拒（enforced 要**两个条件**同时成立）", async () => {
    const r = await verifyFix(
      deps({ stage: { ...verifierStage(), approvalPolicy: "never" } }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("verifier_not_enforced");
  });
});

/* ═════════════════ 第 1 维：目录 ═════════════════ */

describe("派生目录必须落在作者写范围之外", () => {
  it("⭐ 默认派生的目录**不落在作者工作区里面**（作者写不到审阅方的输入）", async () => {
    // 这条用例一开始是红的，而红的原因值得记：
    // 派生函数当时写的是 `<作者工作区>/.verify/<taskId>`，
    // 而同一文件里的 nested_workspace 判据拒的正是**互为嵌套**的两个目录 ——
    // 两处各自合理，合起来让 verifyFix 拒掉自己发起的**每一次**调用。
    // 修的时候有两个方向（放宽嵌套判据 / 把派生挪出去），选后者是因为**权限**：
    // 作者的 sandbox 是 workspace-write，写范围就是他的工作区；
    // 审阅目录长在里面 ⇒ 作者有权往审阅目录放东西 ⇒ 第一维等于没有。
    const seen: HarnessRequest[] = [];
    const r = await verifyFix(deps({ adapter: adapter({ seen }) }));
    if (!r.ok) throw new Error("不应被拒：" + r.code + " / " + r.reason);
    const ws: string = seen[0]?.workspace ?? "";
    expect(ws).toBe(DEFAULT_VERIFY_ROOT + "/task-1");
    expect(ws.startsWith("/repo")).toBe(false);
  });

  it("⭐ 把审阅根放进作者工作区 ⇒ nested_workspace（判据仍然活着）", async () => {
    const r = await verifyFix(deps({ verifyRoot: "/repo/.verify" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("nested_workspace");
    // 反向嵌套同样拒（作者目录长在审阅目录里面）。
    const back = independenceBlock({
      author: { roleId: "dev", modelFamily: "claude" },
      verifier: { roleId: "test", modelFamily: "gpt" },
      authorWorkspace: "/tmp/opc-verify/repo",
      verifierWorkspace: "/tmp/opc-verify",
      verifierCaps: APPROVING,
      verifierApprovalPolicy: "on-request",
      stage: "pre_call",
    });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.code).toBe("nested_workspace");
  });

  it("同工作区 ⇒ 拒；尾部斜杠不算不同", () => {
    const block = (v: string) =>
      independenceBlock({
        author: { roleId: "dev", modelFamily: "claude" },
        verifier: { roleId: "test", modelFamily: "gpt" },
        authorWorkspace: "/repo",
        verifierWorkspace: v,
        verifierCaps: APPROVING,
        verifierApprovalPolicy: "on-request",
        stage: "pre_call",
      });
    expect(block("/repo").ok).toBe(false);
    expect(block("/repo/").ok).toBe(false);
    expect(block("/tmp/opc-verify/task-1").ok).toBe(true);
  });

  it("同角色 ⇒ 拒（与门控层那次不是重复：那次拦结论，这次拦发起）", () => {
    const v = independenceBlock({
      author: { roleId: "dev", modelFamily: "claude" },
      verifier: { roleId: "dev", modelFamily: "gpt" },
      authorWorkspace: "/repo",
      verifierWorkspace: "/tmp/v",
      verifierCaps: APPROVING,
      verifierApprovalPolicy: "on-request",
      stage: "pre_call",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("same_role");
  });

  it("派生目录带 taskId 且**无随机后缀**：任务之间不串残留，同一任务能被找回", () => {
    expect(independentWorkspace("t1")).toBe("/tmp/opc-verify/t1");
    expect(independentWorkspace("t1", "/srv/v/")).toBe("/srv/v/t1"); // 尾斜杠不产生空段
    expect(independentWorkspace("t1")).not.toBe(independentWorkspace("t2"));
    // ⚠ 这里原来还有一条 `expect(f("t1")).toBe(f("t1"))`，注释写着「确定性是回放的前提」——
    // 同一个调用写两遍，对任何实现都真，是本文件第 ⑥ 条那种恒绿装饰的又一种形状，
    // 而它坏在**带着一条看起来在解释为什么需要它的注释**。
    // 而它坏在**带着一条看起来在解释为什么需要它的注释**。
    // 「无随机后缀」这个性质主要由上面第一条【具体形状】的断言守住：
    // 实现一旦改成 `root + "/" + taskId + "-" + randomUUID()`，那条立刻红。
    // 下面这条 UUID 正则只是把同一件事说得更显眼（**单独看它偏弱**，
    // 因为它只认标准 UUID 形状，短的随机后缀它看不见 —— 别把它当主判据）。
    expect(independentWorkspace("t1")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  it("根必须是绝对路径、taskId 不得为空，缺了**抛错**而不退回相对/随机", () => {
    // 相对路径会让「独立工作区」在两个 cwd 下意味着两个不同的东西；
    // 空 taskId 会退化成随机或空串，两种都在审计里指不回产物。
    expect(() => independentWorkspace("t1", "vroot")).toThrow();
    expect(() => independentWorkspace("t1", "")).toThrow();
    expect(() => independentWorkspace("  ")).toThrow();
  });
});

/* ═════════════════ 不可信输入（§12.6 末段） ═════════════════ */

describe("不可信输入", () => {
  it("自报通过的表述被剔，而客观描述留着", () => {
    const r = stripSelfReported([
      "我已覆盖所有边界条件",
      "跑完 42 个用例，2 个未通过",
      "tests pass",
      "本地跑过了",
    ]);
    expect(r.kept).toEqual(["跑完 42 个用例，2 个未通过"]);
    expect(r.dropped.map((d) => d.text)).toEqual([
      "我已覆盖所有边界条件",
      "tests pass",
      "本地跑过了",
    ]);
    // matched 交回的是**命中了表里哪一条**（漏检时要能看出是表缺还是匹配逻辑坏）。
    expect(r.dropped.map((d) => d.matched)).toEqual(["我已覆盖", "tests pass", "本地跑过"]);
    expect(SELF_REPORTED_PATTERNS.length).toBeGreaterThan(0);
  });

  it("大小写不敏感（`TESTS PASS` 同样被剔）", () => {
    expect(stripSelfReported(["TESTS PASS"]).dropped).toHaveLength(1);
  });

  it("⭐ 调用方把谎报拼进 instruction ⇒ **不拒、只记**（这一层拦不了自由文本）", async () => {
    // 「作者文本不在场」只对**入参形状**成立，对运行期不做保证：instruction 是自由文本。
    // 两条路都试过，都不对：
    //   拒 ⇒ 误伤一句**正当**提到这句话的提示词（下一条用例就是那种写法），
    //        而误伤的代价是调用方绕开这一层自己拼请求 —— 比漏记严重；
    //   静默放过 ⇒ 文件头那句「不在场」变成一句假话。
    // 所以取中间那一格：命中就记进结果，随审计进回放页可见。
    const r = await verifyFix(
      deps({ instruction: "参考开发那边的结论：自测通过，覆盖率应该没问题" }),
    );
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(r.instructionFlags).toEqual(["自测通过"]);
    // 干净指令上它是空的（否则这一格等于恒记，恒记与恒不记一样没有信息量）。
    const clean = await verifyFix(deps());
    if (!clean.ok) throw new Error("不应被拒：" + clean.code);
    expect(clean.instructionFlags).toEqual([]);
  });

  it("一句**正当提到**谎报的提示词不被拒（这就是『不拒』那一侧的代价对照）", async () => {
    const r = await verifyFix(
      deps({ instruction: "不要采信程序员的『自测通过』声明，独立跑测试套件" }),
    );
    expect(r.ok).toBe(true);
    // 仍然记下来了 —— 记不等于判它有罪，只是让人看得见这一格发生过。
    expect(r.instructionFlags).toEqual(["自测通过"]);
  });

  it("⭐ 审计行里带着「剔了哪几句 / 指令里命中了什么」两格", async () => {
    // 只记不拒的那一笔，如果最后没落到审计里，就等于**没记**。
    const sink: AuditRow[] = [];
    const r = await verifyFix(
      deps({
        instruction: "不要采信『自测通过』",
        gateway: {
          audit: (row: AuditRow): number => {
            sink.push(row);
            return sink.length;
          },
          grantedSandbox: "workspace-write",
          grantedForbidden: ["--yolo", "--full-auto"],
        },
      }),
    );
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    const row = verifierAuditRow(r, "task-1");
    const p = row.payload as Record<string, unknown>;
    expect(p["instruction_self_reported_matches"]).toEqual(["自测通过"]);
    expect(p["dropped_self_reported_claims"]).toEqual([]);
    expect(p["gate_decision"]).toBe("reject");
  });

  it("被命中的是**整条 claim**（不是留下文本、删掉依据）", async () => {
    const r = await verifyFix(
      deps({
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: SHA_A, bytes: 10 }],
          claims: [
            { text: "我已覆盖所有边界条件", evidence_refs: ["cov.json"] },
            { text: "覆盖率 61%", evidence_refs: ["cov.json"] },
          ],
          metrics: { coverage: 61 },
        }),
      }),
    );
    if (!r.ok) throw new Error("不应被拒：" + r.code);
    expect(r.bundle.claims.map((c) => c.text)).toEqual(["覆盖率 61%"]);
    expect(r.droppedClaims).toEqual(["我已覆盖所有边界条件"]);
    // 留下来的那条仍带着依据（剔 claim 不是把包掏空）。
    expect(r.bundle.claims[0]?.evidence_refs).toEqual(["cov.json"]);
  });
});

/* ═════════════════ 失败 ≠ 不合格 ═════════════════ */

describe("失败不能被换算成不合格", () => {
  it("审阅调用没跑成 ⇒ verifier_call_failed，**不是** reject", async () => {
    // 审阅没跑成与「审阅判定不合格」是两件事：前者该重试或找人，后者该打回开发者。
    // 把前者写成后者，一次网关故障看起来就像一次开发质量事故，而修的东西完全不同。
    const broken: HarnessAdapter = {
      id: "codex",
      capabilities: APPROVING,
      // 只发 session_started、不发 finished ⇒ gateway 自己会拒。
      execute: () => stream([{ kind: "session_started", sessionId: "s" }]),
      resume: () => stream([]),
      getCost: async () => COST,
    };
    const r = await verifyFix(deps({ adapter: broken }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("verifier_call_failed");
      expect(r.reason).toContain("刻意**不**把它换算成 reject");
    }
  });

  it("assemble 交回形状错的哈希 ⇒ 当场拒（不交给下游报「整包不符」）", async () => {
    const r = await verifyFix(
      deps({
        assemble: () => ({
          artifacts: [{ path: "cov.json", sha256: "not-a-hash", bytes: 1 }],
          claims: [],
        }),
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_artifact");
    // 大写同样不收（同一文件在两处会登记成两个哈希，verify 一真一假）。
    expect(SHA256_RE.test("A".repeat(64))).toBe(false);
  });
});

/* ═════════════════ 码表与请求装配 ═════════════════ */

describe("码表必须有返回点", () => {
  it("⭐ VERIFY_REJECT_CODES 里每一个码都被某条用例触发过", async () => {
    // 「码表里有码而代码永不返回」的码表是**装饰**：按码统计的人会以为那条防线存在，
    // 而它一次也不会触发。曾有四个码是这样（写在 0023 里），删掉之后这一条才成立。
    const seen = new Set<string>();
    const record = async (i: Partial<VerifyInput>): Promise<void> => {
      const r = await verifyFix(deps(i));
      if (!r.ok) seen.add(r.code);
    };
    await record({ verifyRoot: "/repo/.verify" }); // nested_workspace
    await record({ authorWorkspace: "/tmp/opc-verify/task-1" }); // same_workspace
    await record({ verifierRoleId: "dev" }); // same_role
    await record({ adapter: adapter({ sessionId: "dev-sess-1" }) }); // same_session
    await record({ author: { roleId: "dev", modelFamily: "claude", sessionId: "" } }); // empty_session
    await record({ adapter: adapter({ modelFamily: "claude" }) }); // same_model_family
    await record({ author: { roleId: "dev", modelFamily: "", sessionId: "d1" } }); // unknown_model_family
    await record({
      adapter: adapter({ modelFamily: "claude" }),
      sameFamilyApproval: { approvedBy: "dev", reason: "x" },
    }); // approval_by_author
    await record({ adapter: adapter({ caps: { toolApproval: false } }) }); // verifier_not_enforced
    await record({
      assemble: () => ({ artifacts: [{ path: "x", sha256: "z", bytes: 1 }], claims: [] }),
    }); // bad_artifact
    await record({
      adapter: {
        id: "codex",
        capabilities: APPROVING,
        execute: () => stream([{ kind: "session_started", sessionId: "s" }]),
        resume: () => stream([]),
        getCost: async () => COST,
      },
    }); // verifier_call_failed

    const missing: string[] = VERIFY_REJECT_CODES.filter(
      (c: string): boolean => !seen.has(c),
    );
    // ⚠ 写法本身值得留一句：我上一版写的是
    //   expect("没有返回点的码：" + missing.join(", ")).toBe("")
    // 那**永远**是红的（前缀无条件在），是「恒绿断言」的镜像版本 ——
    // 一个从不通的断言与一个从不红的断言一样没用，只是它会把人引去改**代码**
    // 而问题在断言。想要「报错时能看见缺哪些码」，就把消息放在**分支里**：
    if (missing.length > 0) throw new Error("码表里没有返回点的码：" + missing.join(", "));
    // 并且反过来钉一句：这一条**确实**收集到了码（否则 missing 为空只是因为
    // 上面 record 全没跑起来，那也是一个从不会红的假绿）。
    expect(seen.size).toBe(VERIFY_REJECT_CODES.length);
  });
});

describe("请求装配", () => {
  it("审阅请求带齐契约定义的每一个字段（手写全字段漏过两个，只有 tsc 报得出来）", async () => {
    const seen: HarnessRequest[] = [];
    await verifyFix(deps({ adapter: adapter({ seen }) }));
    const req = seen[0] as HarnessRequest;
    // 这里**不能**再 parse 一次：适配器拿到的是 transform **之后**的 camelCase 形状，
    // 而 harnessRequestSchema 吃的是 snake_case 输入 —— 再 parse 必然整包被拒。
    // （我第一版就是这么写的，红得很直白，也是我该在写的时候就想到的。）
    // 真正要钉的性质是「字段一个不少」，那就直接比键集合。
    expect(Object.keys(req).sort()).toEqual(
      [
        "approvalPolicy",
        "allowedTools",
        "forbiddenFlags",
        "instruction",
        "maxBudgetUsd",
        "modelFamily",
        "outputSchema",
        "requestedArgs",
        "resumeSessionId",
        "roleId",
        "sandbox",
        "taskId",
        "workspace",
      ].sort(),
    );
    expect(req.roleId).toBe("test");
    expect(req.approvalPolicy).toBe("on-request");
    expect(req.sandbox).toBe("workspace-write");
    // 禁止项必须带上：漏传会让第 4 层「命中禁止项」那一支静默失效。
    expect(req.forbiddenFlags).toEqual(["--yolo", "--full-auto"]);
    // ⚠ 这里**删掉**了一条我原先写的断言：`expect(JSON.stringify(req)).not.toContain("自测通过")`。
    // 它看着像在证「谎报没进请求」，其实**夹具里根本没有那句话** ——
    // 无论代码怎么写它都绿，是本仓记过三次的「恒绿装饰」的另一种形状：
    // **判据引用的那个东西，得先确认真的在输入里**。
    // 真正有判别力的那两条在上面（instruction 命中 ⇒ instructionFlags 非空 / 干净 ⇒ 空）。
  });

  it("审阅段是 independent + on-request（on-request 不是可选优化）", () => {
    const s = verifierStage();
    expect(s.executor).toBe("independent");
    expect(s.approvalPolicy).toBe("on-request");
    expect(s.readOnly).toBe(false); // 审阅要写用例文件
  });
});
