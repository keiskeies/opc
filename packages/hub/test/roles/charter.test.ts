/**
 * Task 0.7 验收：岗位书是【结构化】契约，不是自由文本（规格 §3.2）。
 *
 * 为什么值得这么严：§3.2 指出早期岗位书写得像简历，「产出华丽但不合规」。把行业验收
 * 标准焊死在 schema 里，是这套系统能替 CEO 过滤审阅负担的前提（§23.2）。
 *
 * honesty_boundaries 与 version 在规格附录 B.1 的样例里【没有】，但计划 Task 0.7 明确
 * 要求「缺 honesty_boundaries / version 时必须拒绝加载」—— 意图是把 §14.4 红线二
 * （必须声明诚实边界）延伸到角色层。附录 B 是配置示例、不是 schema 全集，故以计划为准。
 * 本段注释存在的意义：防止将来有人「照着附录 B.1 把这两个字段删掉」。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CHARTER_PLACEHOLDER_ACCEPTANCE } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  charterFieldPaths,
  loadCharterFile,
  loadCharterText,
  mergeForbiddenForRun,
} from "../../src/roles/loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "..", "..", "resources", "charter-templates");
const SEVEN = ["ceo", "assistant", "product", "tech", "dev", "test", "ops"];

/*
 * 本文件【故意】按包名 import @opc/contracts，而不是相对路径 import 它的源码。
 * 实测过：contracts/package.json 当时既无 main 也无 exports，而此前全仓无人 import 它，
 * 所以「按包名到底能不能解析」从没红过。相对路径 import 会绕过 package exports，
 * 等于把这个洞永久藏起来。构建由 test/global-setup/build-contracts.ts 负责 ——
 * 【不能】在本文件里 beforeAll 构建：顶层 import 比钩子先解析，实测失败时 0 个测试会跑。
 */
/** 合法骨架：字段名与规格附录 B.1 / B.3 一一对应。 */
const BASE: Record<string, unknown> = {
  role_id: "test_engineer",
  display_name: "测试工程师",
  version: 1,
  reports_to: "tech_director",
  honesty_boundaries: ["不判定自己写过的代码为通过"],
  acceptance_criteria: [
    {
      condition: "coverage < 0.90",
      action: "reject",
      message: "覆盖率不足90%，不得标记通过",
    },
  ],
  forbidden_actions: [
    "approve_own_work",
    "modify_source_code",
    "merge_to_main",
  ],
  tool_permissions: ["read_repo", "run_tests", "create_review_report"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  escalation_triggers: ["review_conflict_rounds >= 3"],
  decision_scope: {
    autonomous: ["测试用例设计"],
    requires_consultation: ["跨模块集成测试范围变更 → consult: tech_director"],
    forbidden: ["修改源代码", "自行放行P0缺陷", "合并到主干"],
  },
  judgment_mode: {
    type: "bounded_judgment",
    strict_rules: ["coverage < 0.90 → reject"],
    bounded_judgment: ["P2缺陷是否可接受上线（需附风险评估）"],
    full_discretion: [],
  },
};

const DROP = "__DROP__";

/** 生成 YAML：overrides 里值为 DROP 的键【删除】而不是置 null —— 「缺失」和「为 null」是两件事 */
function yamlWith(overrides: Record<string, unknown>): string {
  const merged: Record<string, unknown> = { ...BASE };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === DROP) delete merged[k];
    else merged[k] = v;
  }
  return stringify(merged);
}

/** 抓异常：断言异常里的字段路径比 toThrow(/字符串/) 更精确 */
function grab(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("期望抛错，但函数正常返回了");
}

describe("charter zod schema（Task 0.7）", () => {
  it("合法岗位书解析通过，且关键字段解析成预期值", () => {
    const c = loadCharterText(yamlWith({}), "inline");
    expect(c.roleId).toBe("test_engineer");
    expect(c.modelTier).toBe("execution");
    expect(c.acceptanceCriteria).toHaveLength(1);
    expect(c.decisionScope.forbidden).toContain("修改源代码");
  });

  it("缺 honesty_boundaries → 拒绝加载，并给出【字段路径】而非整坨原文", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ honesty_boundaries: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("honesty_boundaries");
  });

  it("缺 version → 拒绝加载并给出字段路径", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ version: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("version");
  });

  it("缺 acceptance_criteria → 拒绝加载并给出字段路径", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ acceptance_criteria: DROP }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria");
  });

  it("version 为 null 与【缺失】都要拒，且路径都指向 version", () => {
    const missing = charterFieldPaths(
      grab(() => loadCharterText(yamlWith({ version: DROP }), "x.yaml")),
    );
    expect(missing).toContain("version");
    const nul = charterFieldPaths(
      grab(() => loadCharterText(yamlWith({ version: null }), "x.yaml")),
    );
    expect(nul).toContain("version");
  });

  it("嵌套字段缺失要给出【完整路径】，不能只说根字段错了", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          acceptance_criteria: [
            { condition: "coverage < 0.90", message: "缺 action 字段" },
          ],
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria[0].action");
  });

  /*
   * ↓ 三条断言是变异测试逼出来的：第一轮变异里「honesty_boundaries 允许空数组」
   * 「version 放宽为任意 number」「acceptance_criteria 允许空」三个变异【全部存活】，
   * 因为我只测了 key 缺失，没测 key 在但值为空。而手写 YAML 时 acceptance_criteria: []
   * 比整段删掉更常见 —— 缺这一层，「焊死验收标准」这件事在最常用的错法上是没保护的。
   */
  it("honesty_boundaries 为空数组 → 拒绝加载（min(1)）：自认毫无局限的角色不可信", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ honesty_boundaries: [] }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("honesty_boundaries");
  });

  it("acceptance_criteria 为空数组 → 拒绝加载：没有验收标准的岗位书就是自由文本", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ acceptance_criteria: [] }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria");
  });

  it("version 必须为正整数：0 / 负数 / 小数都拒（§3.2 靠它定位任务运行时的岗位书版本）", () => {
    for (const bad of [0, -1, 1.5]) {
      const e = grab(() =>
        loadCharterText(yamlWith({ version: bad }), "x.yaml"),
      );
      expect(charterFieldPaths(e), "version=" + bad).toContain("version");
    }
  });

  it("forbidden 传空数组必须抛错：语义歧义（清空 还是 不追加？）不许靠猜", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: [] })).toThrow(
      /语义歧义/,
    );
  });

  it("forbidden 里的空白条目必须抛错：拦不住行为却会在审计里显示成一条空条目", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: ["   "] })).toThrow(
      /空白/,
    );
  });

  it("拼错字段名必须被拒（strict）：岗位书会被 CEO 手改，打错的约束等于没有约束", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ model_tier_typo: "management" }), "x.yaml"),
    );
    expect(charterFieldPaths(e).length).toBeGreaterThan(0);
  });

  it("model_tier 只接受规格枚举（§5.9 的映射表由它驱动）", () => {
    const e = grab(() =>
      loadCharterText(yamlWith({ model_tier: "cheap" }), "x.yaml"),
    );
    expect(charterFieldPaths(e)).toContain("model_tier");
  });

  it("judgment_mode.type 只接受 strict_rules | bounded_judgment | full_discretion（§4）", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          judgment_mode: {
            type: "whatever",
            strict_rules: [],
            bounded_judgment: [],
            full_discretion: [],
          },
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("judgment_mode.type");
  });

  it("escalate 类验收标准必须带 target —— 否则「升级」不知道升给谁，会静默丢掉", () => {
    const e = grab(() =>
      loadCharterText(
        yamlWith({
          acceptance_criteria: [
            {
              condition: "p0_defect_count > 0",
              action: "escalate",
              message: "P0必须升级",
            },
          ],
        }),
        "x.yaml",
      ),
    );
    expect(charterFieldPaths(e)).toContain("acceptance_criteria[0].target");
  });
});

describe("7 个预设模板（Task 0.7 交付物）", () => {
  it("每个模板都能被 schema 接受；role_id 必须等于文件名", () => {
    for (const name of SEVEN) {
      const c = loadCharterFile(join(TEMPLATES, name + ".yaml"));
      expect(c.roleId, name + ".yaml 的 role_id 必须等于文件名").toBe(name);
    }
  });

  it("模板的 acceptance_criteria 仍是【固定占位串】，等 Task 0.9 由 CEO 逐条替换", () => {
    for (const name of SEVEN) {
      const c = loadCharterFile(join(TEMPLATES, name + ".yaml"));
      const texts = c.acceptanceCriteria.map(
        (a) => a.condition + "|" + a.message,
      );
      expect(
        texts.some((s) => s.includes(CHARTER_PLACEHOLDER_ACCEPTANCE)),
        name,
      ).toBe(true);
    }
  });
});

describe("权限单调性（规格 §20.2 / §4）", () => {
  it("运行时参数【不得】删除 forbidden 条目", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    const e = grab(() =>
      mergeForbiddenForRun(c, { removeForbidden: ["修改源代码"] }),
    );
    expect(String(e)).toContain("修改源代码");
  });

  it("运行时参数【不得】用空数组清空 forbidden", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    expect(() => mergeForbiddenForRun(c, { forbidden: [] })).toThrow();
  });

  it("运行时只能【收紧】：追加生效，原有条目一条都不能少", () => {
    const c = loadCharterText(yamlWith({}), "x.yaml");
    const eff = mergeForbiddenForRun(c, { forbidden: ["额外禁止项"] });
    expect(eff).toContain("修改源代码");
    expect(eff).toContain("额外禁止项");
  });
});
