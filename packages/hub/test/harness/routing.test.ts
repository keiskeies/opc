/**
 * Task 5.3 的路由测试（【规格】§12.4 双轴 + §12.5 分段流程）。
 *
 * ── 计划点名的那条 Test 是这组的骨架 ────────────────────────────────
 * 「缺陷修复走『只读分析 → 复现验证 → 修复 → 测试独立验证 → 上报』五段，
 *   **只读段出现写操作即失败**」。
 * 后半句才是这一层唯一真正在判的东西，所以这里花了最多用例在它上面，
 * 而且刻意包含**没有一条用例是靠 `sandbox: "read-only"` 那格通过的** ——
 * 档位是交给 harness 执行的（safety.ts 文件末「挡不住什么」第 3 条），
 * 一个只看档位的实现等于没判。
 *
 * ── 这个文件里最值钱的三组用例，都是防我自己犯过的那类错 ────────────
 * ① 「风险轴只收紧不放松」那组：防的是「风险低 ⇒ 少跑一段」（削【规格】§12.5 的步骤）。
 * ② 「grantedSandbox 与 stage.sandbox 不是同一个来源」那组：0021 §1 那两处自比
 *    在路由层的复发形态 —— 如果路由自己查表得出上限、又查同一张表得出请求档位，
 *    gateway 那条「不得提级」就在路由来的请求上结构性地永不触发。
 * ③ prevention 那组：把 `prevention` 从「审计里的一格」当成「路由的硬约束输入」用之后，
 *    「要求」与「实际」必须不分叉（0021 §6 预告的就是这一步）。
 */
import type { HarnessCapabilities, RiskTier, SandboxTier } from "@opc/contracts";
import { SANDBOX_TIERS } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import {
  branchIsOnMain,
  branchViolation,
  readOnlyTools,
  requestPolicyFor,
  type RouteCandidate,
  type RouteInput,
  type RoutePlan,
  type RouteStage,
  routeTask,
  stagesFor,
  stageWriteViolation,
} from "../../src/harness/routing.js";
import { preventionFor } from "../../src/harness/safety.js";

const APPROVING: HarnessCapabilities = {
  budgetHardCap: true,
  toolApproval: true,
  resume: true,
  structuredOutput: true,
};
/** Kimi 那一类：没有审批回调 ⇒ prevention 只能是 observed_only。 */
const AFK: HarnessCapabilities = {
  budgetHardCap: false,
  toolApproval: false,
  resume: true,
  structuredOutput: false,
};

const CODEX: RouteCandidate = { id: "codex", capabilities: APPROVING };
const CLAUDE: RouteCandidate = { id: "claude-code", capabilities: APPROVING };
const AFK_ONLY: RouteCandidate = { id: "qoder", capabilities: AFK };

function input(over: Partial<RouteInput> = {}): RouteInput {
  return {
    taskId: "task-1",
    roleId: "dev",
    category: "bugfix",
    risk: "reversible",
    workspace: "/repo",
    // 岗位书侧给 workspace-write：这是**被比侧**，必须能从外部注入（见那两条 ⭐ 用例）。
    charterCeiling: "workspace-write",
    charterForbiddenFlags: ["--dangerously-skip-permissions", "--no-sandbox", "--yolo"],
    allowedTools: ["Read", "Edit", "Write", "Bash(git:*)"],
    candidates: [CODEX, CLAUDE],
    ...over,
  };
}

function planned(over: Partial<RouteInput> = {}): RoutePlan {
  const r = routeTask(input(over));
  if (!r.ok) throw new Error("路由本应成功，实到 " + r.code + "：" + r.reason);
  return r.plan;
}

function stage(plan: RoutePlan, id: string): RouteStage {
  const s = plan.stages.find((x) => x.id === id);
  if (s === undefined) throw new Error("计划里没有段 [" + id + "]，实到 " + plan.stages.map((x) => x.id).join(","));
  return s;
}

describe("【规格】§12.4 双轴：类别轴", () => {
  it("缺陷修复是计划点名那五段，且**顺序**对", () => {
    const plan = planned();
    expect(plan.stages.map((s) => s.id)).toEqual([
      "analyze",
      "reproduce",
      "implement",
      "verify",
      "report",
    ]);
    // 顺序不是排版问题：复现段必须在修复段**之前**，那是【规格】§12.5 第 3 步
    // 「无法复现 → 打回根因报告」这句话唯一的实现位置。顺序反了它就永远不发生。
    expect(plan.stages.findIndex((s) => s.id === "reproduce")).toBeLessThan(
      plan.stages.findIndex((s) => s.id === "implement"),
    );
  });

  it("分析段是 read-only + readOnly，修复段是 workspace-write", () => {
    const plan = planned();
    expect(stage(plan, "analyze").sandbox).toBe("read-only");
    expect(stage(plan, "analyze").readOnly).toBe(true);
    expect(stage(plan, "implement").sandbox).toBe("workspace-write");
    expect(stage(plan, "implement").readOnly).toBe(false);
  });

  it("『diff 必须经测试门控』与『独立构造复现用例』是**步骤**而不是注释", () => {
    const plan = planned();
    expect(stage(plan, "verify").executor).toBe("independent");
    expect(stage(plan, "reproduce").executor).toBe("independent");
    // 而作者的段必须是 author —— 只断言 independent 那几条的话，
    // 「所有段都标 independent」这个错法照样全绿（反向对照必须成对）。
    expect(stage(plan, "analyze").executor).toBe("author");
    expect(stage(plan, "implement").executor).toBe("author");
  });

  it("重构那一行要求独立分支；其余类别不要求", () => {
    const r = planned({ category: "refactor" });
    expect(stage(r, "implement").independentBranch).toBe(true);
    expect(stage(planned({ category: "feature" }), "implement").independentBranch).toBe(false);
  });

  it("每一段都带着『为什么这么配』（配置页不能只给一个档位值）", () => {
    for (const cat of ["feature", "bugfix", "refactor", "experimental"] as const) {
      for (const s of stagesFor(cat)) {
        expect(s.why.length, cat + "/" + s.id + " 缺 why").toBeGreaterThan(10);
      }
    }
  });
});

describe("【规格】§12.5 段闸门：只读段出现写操作即失败（计划点名的那条）", () => {
  const analyze = stage(planned(), "analyze");

  it("只读段里一次 Edit 即失败", () => {
    const v = stageWriteViolation(analyze, { tool: "Edit", args: { path: "/repo/a.ts" } });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("write_in_read_only_stage");
  });

  it("⭐ 只读段里的 Bash 也判得住：`rm -rf` 违规、`git status` 放行", () => {
    // 这一条同时钉住两个方向。第二半**不能省**：如果只断言「rm -rf 被拒」，
    // 那么把整条判据改成「只读段一律拒」也全绿，而那样【规格】§12.5 第 1 步
    // 「预检：git status」就做不出来了（0021 §3 记的就是这种「全拒 ⇒ 下次放松」）。
    expect(
      stageWriteViolation(analyze, { tool: "Bash", args: { command: "rm -rf build" } }).ok,
    ).toBe(false);
    expect(
      stageWriteViolation(analyze, { tool: "Bash", args: { command: "git status" } }).ok,
    ).toBe(true);
    expect(
      stageWriteViolation(analyze, { tool: "Bash", args: { command: "git diff HEAD" } }).ok,
    ).toBe(true);
  });

  it("⭐ 认不出的工具名在只读段里算违规（宁可打断分析，不要偷偷改文件）", () => {
    const v = stageWriteViolation(analyze, { tool: "SomeVendorTool", args: { x: 1 } });
    expect(v.ok).toBe(false);
  });

  it("这一条与档位无关：sandbox 写错成 workspace-write 也照样判得住", () => {
    // 「档位那一格对不对」与「这一段有没有被守住」是两件事。
    // 前者交给 harness 执行（本层看不见），后者是外层那一份（【规格】§12.7 表头说的「叠加」）。
    const loosened: RouteStage = { ...analyze, sandbox: "workspace-write" };
    expect(stageWriteViolation(loosened, { tool: "Edit", args: { path: "/repo/a.ts" } }).ok).toBe(false);
  });

  it("非只读段不因这条被判（不是一条『写一律拒』的判据）", () => {
    const impl = stage(planned(), "implement");
    expect(stageWriteViolation(impl, { tool: "Write", args: { path: "/repo/a.ts" } }).ok).toBe(true);
  });

  it("⚠ 与审批**同一个判据**（不是第二张表）", () => {
    // 上面那条「SomeVendorTool 算违规」与 safety 的 needsApproval 是同一个函数出来的。
    // 这里钉的是**同一个输入在两处给出同一个答案**：
    // Edit 在审批侧「不用问人」（可逆）而在只读段「违规」—— 那不是不一致，
    // 而是同一档位在两个问题下的两种答案（要不要问人 / 这一段允不允许）。
    // 这一条用例真正防的是「有人在 routing 里再写一张写工具表」。
    const e = stageWriteViolation(analyze, { tool: "Edit", args: { path: "/repo/a.ts" } });
    const w = stageWriteViolation(analyze, { tool: "Write", args: { path: "/repo/a.ts" } });
    const r = stageWriteViolation(analyze, { tool: "Read", args: { path: "/repo/a.ts" } });
    expect([e.ok, w.ok, r.ok]).toEqual([false, false, true]);
  });

  it("独立段被作者发起 ⇒ 拒（§8.2 第 1 条在**发起前**那一次拦截）", () => {
    const verify = stage(planned(), "verify");
    const v = stageWriteViolation(verify, {
      tool: "Bash",
      args: { command: "pnpm test" },
      executor: "author",
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe("independent_stage_by_author");
    // 反向对照：同一段由独立角色发起 ⇒ 放行。
    expect(
      stageWriteViolation(verify, { tool: "Bash", args: { command: "pnpm test" }, executor: "independent" }).ok,
    ).toBe(true);
  });
});

describe("主干闸门（【规格】§12.4 重构那一行）", () => {
  const impl = stage(planned({ category: "refactor" }), "implement");

  it("main / master 被拒；feat/* 放行", () => {
    expect(branchViolation(impl, "main").ok).toBe(false);
    expect(branchViolation(impl, "MASTER").ok).toBe(false);
    expect(branchViolation(impl, "feat/x").ok).toBe(true);
  });

  it("非重构类的段不受这条约束", () => {
    expect(branchViolation(stage(planned(), "implement"), "main").ok).toBe(true);
  });

  it("只认 main / master —— 这条**已知宽松**被钉住，别被误当 bug 收紧", () => {
    // 收紧它需要先核验「哪些名字算主干」，而我离线状态一家都核验不了
    // （0021 §9 第 13 条：按「一般会有」补事实）。
    expect(branchIsOnMain("release/1.2")).toBe(false);
    expect(branchIsOnMain("trunk")).toBe(false);
    expect(branchIsOnMain("  main  ")).toBe(true);
  });
});

describe("风险轴（第二轴）：只收紧，永远不放松", () => {
  it("风险档 = irreversible ⇒ 非只读段的审批策略被抬到 on-request", () => {
    const plan = planned({ risk: "irreversible" });
    expect(stage(plan, "implement").approvalPolicy).toBe("on-request");
    expect(stage(plan, "verify").approvalPolicy).toBe("on-request");
  });

  it("⭐ 只读段【不被】抬（否则审批队列里会出现「可以读这个文件吗」）", () => {
    const plan = planned({ risk: "irreversible" });
    expect(stage(plan, "analyze").approvalPolicy).toBe("never");
    expect(stage(plan, "report").approvalPolicy).toBe("never");
  });

  it("⭐ 风险档再低也**不删段、不降档**（放松不是这一层的权限）", () => {
    // 这一条是这一组的核心。它的存在理由：把 risk 做成一个能放松的轴，
    // 等价于让被约束者声明「这次风险低」就能跳过【规格】§12.5 的某一段。
    const low = planned({ risk: "read_only" });
    const high = planned({ risk: "irreversible" });
    expect(low.stages.map((s) => s.id)).toEqual(high.stages.map((s) => s.id));
    // 低风险的段档位 == 默认的段档位（没有任何一格因为「风险低」而被放宽）。
    expect(low.stages.map((s) => s.sandbox)).toEqual(stagesFor("bugfix").map((s) => s.sandbox));
    expect(low.stages.map((s) => s.readOnly)).toEqual(stagesFor("bugfix").map((s) => s.readOnly));
    expect(low.stages.map((s) => s.executor)).toEqual(stagesFor("bugfix").map((s) => s.executor));
    // 而高风险只会**更严**：逐段比较，不允许任何一段变松。
    // （第一版这一段写的是 `expect(cond ? "same" : "tightened").not.toBe("loosened")` ——
    // 那个表达式两个分支都不等于 "loosened"，对任何代码都真，是 0013/0016 记过两次的
    // 「零判别力断言」。改成直接比两个真实取值。）
    for (let i = 0; i < low.stages.length; i += 1) {
      const a = low.stages[i] as RouteStage;
      const b = high.stages[i] as RouteStage;
      expect(b.sandbox, "段 [" + a.id + "] 的档位不该随风险变").toBe(a.sandbox);
      expect(b.readOnly, "段 [" + a.id + "] 的只读性不该随风险变").toBe(a.readOnly);
      expect(b.executor, "段 [" + a.id + "] 的发起方不该随风险变").toBe(a.executor);
      // 唯一的允许方向：never ⇒ on-request。反过来就是放松。
      if (a.approvalPolicy === "on-request") {
        expect(b.approvalPolicy, "段 [" + a.id + "] 在高风险下被放松了").toBe("on-request");
      }
    }
  });

  it("类别轴与风险轴**互相独立**：四类 × 三档都能出计划", () => {
    // 双轴不是装饰：它得是笛卡尔积。这一条同时是 routeTask 的一条不抛错回归。
    const cats = ["feature", "bugfix", "refactor", "experimental"] as const;
    const risks: RiskTier[] = ["read_only", "reversible", "irreversible"];
    for (const category of cats) {
      for (const risk of risks) {
        const r = routeTask(
          input({
            category,
            risk,
            allowExperimental: true,
            // 重构那一类需要 workspace-write，上限必须给够，否则这一条测的是别的拒绝。
            charterCeiling: "danger",
          }),
        );
        expect(r.ok, category + " × " + risk + " 应该出计划：" + (r.ok ? "" : r.reason)).toBe(true);
      }
    }
  });
});

describe("prevention 作为路由的硬约束输入（0021 §6 预告的那一步）", () => {
  it("⭐ 风险不可逆 + 一家不会问我们的执行器 ⇒ 拒，而不是挑一个聊胜于无的", () => {
    const r = routeTask(input({ risk: "irreversible", candidates: [AFK_ONLY] }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("prevention_gap");
      // 报错必须点出**是哪几家**，否则当事人只能一家一家试。
      expect(r.reason).toContain("qoder");
    }
  });

  it("低风险时【不】要求否决权（否则 §12.4 第四行『自动批准』那一行永远路由不出去）", () => {
    const r = routeTask(input({ risk: "reversible", candidates: [AFK_ONLY] }));
    expect(r.ok).toBe(true);
  });

  it("有合格候选时跳过不合格的那一家，而不是整体失败", () => {
    const r = routeTask(input({ risk: "irreversible", candidates: [AFK_ONLY, CODEX] }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.harnessId).toBe("codex");
  });

  it("⭐ prevention 的判据与审计那一格**同一份实现**（不是路由里另写一份）", () => {
    // 两处各写一份 ternary 的后果写在 safety.ts 的 preventionFor 注释里：
    // 「审计里写着 enforced 而路由当初按 observed_only 判」。
    // 这一条把那个「同一份」钉住：路由产出的那一格必须等于直接调 preventionFor 的值。
    const plan = planned({ risk: "irreversible" });
    expect(plan.prevention).toBe(preventionFor(APPROVING, "on-request"));
    expect(plan.prevention).toBe("enforced");
    expect(planned({ risk: "reversible", candidates: [AFK_ONLY] }).prevention).toBe("observed_only");
  });

  it("⭐ 成功计划里『要求的』与『实际拿到的』必然一致", () => {
    // 这条不变量今天**由构造保证**（prevention_gap 那条拒绝在前）。写成用例不是为了
    // 证明现在的代码，是为了钉住**哪一种改法会破坏它**：把候选过滤里那个
    // `!needEnforced ||` 去掉、或把 prevention_gap 改成警告继续跑，这一条立刻红。
    for (const risk of ["read_only", "reversible", "irreversible"] as RiskTier[]) {
      for (const cands of [[CODEX], [AFK_ONLY], [AFK_ONLY, CODEX], [CODEX, AFK_ONLY]]) {
        const r = routeTask(input({ risk, candidates: cands }));
        if (!r.ok) continue;
        expect(
          r.plan.prevention,
          risk + " × " + cands.map((c) => c.id).join("+") + "：要求与实际分叉",
        ).toBe(r.plan.preventionRequired);
      }
    }
  });
});

describe("授权上限：路由不做静默降档，也不自造被比侧（0021 §1 那一族）", () => {
  it("⭐ 岗位书上限低于任务需要 ⇒ 拒，且点名是哪一段", () => {
    const r = routeTask(input({ charterCeiling: "read-only" }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("charter_tier_below_stage");
      // 静默降到上限会得到「跑完了而什么都没改」，所以这里必须拒；
      // 而拒了不说哪一段，当事人只能对着五段猜。
      // ⚠ 这一条一开始是我写错而不是代码写错：我断言点名 [implement]，
      // 而实到 [reproduce] —— 五段里**第一个**需要 workspace-write 的正是复现段
      // （它要写用例文件）。代码报的是第一个越界的段，那是对的口径；
      // 我的断言按「修复段才需要写」想，那是【规格】§12.5 那段流程读漏了第 3 步。
      expect(r.reason).toContain("reproduce");
      expect(r.reason).toContain("workspace-write");
      expect(r.reason).toContain("read-only");
    }
  });

  it("⭐ 同一个任务在两个不同上限下结论必须翻转", () => {
    // 这一对是 0021 §1 那条纪律在路由层的复述：**只喂一个上限值的用例对这类 bug 判别力为零**。
    // 如果哪天有人把上限改成「从 stage 自己反推」（那就是自比），只有这一对能抓到。
    expect(routeTask(input({ charterCeiling: "read-only" })).ok).toBe(false);
    expect(routeTask(input({ charterCeiling: "workspace-write" })).ok).toBe(true);
    expect(routeTask(input({ charterCeiling: "danger" })).ok).toBe(true);
  });

  it("上限是一个没听过的档位 ⇒ 不替它挑一个，仍按最低处理（该由 gateway 报 unknown）", () => {
    // 本层**不**重复判 unknown（那会在两处漂移成「路由放行而 gateway 拒」的随机故障），
    // 但也不能因为 indexOf 给了 -1 就把任何段都放行。
    const r = routeTask(input({ charterCeiling: "workspace" as SandboxTier }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("charter_tier_below_stage");
  });

  it("plan 把上限原样交出，gateway 那侧才有被比侧", () => {
    const plan = planned({ charterCeiling: "danger" });
    expect(plan.charterCeiling).toBe("danger");
    expect(SANDBOX_TIERS).toContain(plan.charterCeiling);
  });
});

describe("拒绝码必须各说各事", () => {
  it("没有候选 ⇒ no_candidate（而不是编一个跑不起来的计划）", () => {
    const r = routeTask(input({ candidates: [] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_candidate");
  });

  it("空工作区 ⇒ no_workspace", () => {
    const r = routeTask(input({ workspace: "   " }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("no_workspace");
  });

  it("⭐ experimental ⇒ experimental_not_enabled，且**优先于** no_candidate/prevention_gap", () => {
    // 顺序用例：kimi 今天没有适配器，所以它同时命中「找不到合格候选」。
    // 若先报后者，当事人会去接一家根本没打算接的执行器。
    const r = routeTask(input({ category: "experimental", candidates: [CODEX] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("experimental_not_enabled");
  });

  it("显式 allowExperimental 才放行（那一句的含义是「我知道它今天跑不起来」）", () => {
    expect(routeTask(input({ category: "experimental", allowExperimental: true })).ok).toBe(true);
  });
});

describe("段 → 请求的策略部分（这份计划得真的能被 gateway 执行）", () => {
  const plan = planned();

  it("forbiddenFlags 一定被带上（漏传会让第 4 层的『命中』那一支静默失效）", () => {
    const p = requestPolicyFor(plan, stage(plan, "implement"));
    expect(p.forbiddenFlags).toEqual(plan.charterForbiddenFlags);
    expect(p.forbiddenFlags.length).toBeGreaterThan(0);
  });

  it("只读段的白名单再收一次：名字里带动词的剔掉", () => {
    const p = requestPolicyFor(plan, stage(plan, "analyze"));
    expect(p.allowedTools).toContain("Read");
    expect(p.allowedTools).not.toContain("Edit");
    expect(p.allowedTools).not.toContain("Write");
    // 反向对照：非只读段用完整名单。
    expect(requestPolicyFor(plan, stage(plan, "implement")).allowedTools).toContain("Edit");
  });

  it("Bash(git:*) 在只读段里**保留**（预检那句『git status』要用）", () => {
    expect(readOnlyTools(["Read", "Edit", "Bash(git:*)"])).toContain("Bash(git:*)");
  });

  it("失效方向是少留而不是误留：带写动词的形状全被剔", () => {
    expect(readOnlyTools(["apply_patch", "git-push", "create_branch", "Read"])).toEqual(["Read"]);
  });

  it("档位与审批策略逐段透传", () => {
    const a = requestPolicyFor(plan, stage(plan, "analyze"));
    expect(a.sandbox).toBe("read-only");
    expect(a.workspace).toBe("/repo");
  });
});
