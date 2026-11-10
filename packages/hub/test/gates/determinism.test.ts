/**
 * Task 1.2 验收：门控判定内核是【确定性纯函数】（规格 §8.2 第 5 条、§24 风险 5）。
 *
 * 为什么这个文件值得单独存在，而不是把断言塞进功能测试里：
 * 「确定性」是本设计的【承重墙】—— §8.2 第 4 条说门控「绑定在边上、不可绕过」，
 * 而一个会因措辞、时钟、随机数而给出不同结论的判定谈不上「不可绕过」：作者换一种
 * 写法再试一次就能过，绕过就不是结构性的了。所以这里的断言全部针对【不变性】
 * 而非单次结果：同输入必须永远同输出。
 *
 * 关于 condition 的语义方向（本文件最容易整体写反的地方，单独说一次）：
 * 岗位书里 condition 写的是【不合格的情形】（"coverage < 0.90 → reject"），
 * 所以判据成立 = violated。本文件的夹具因此统一写成「阈值朝下、实际值朝上」的形状
 * （"metric:coverage <= 80" 配 coverage = 91 ⇒ 不违反 ⇒ pass）。
 * 若把方向读反，症状是【全绿但门控从不拦任何东西】—— 那是最难发现的失效，
 * 所以「方向」本身也有一条断言（见「condition 的语义方向」那一条）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceBundle } from "@opc/contracts";
import { describe, expect, it } from "vitest";
import {
  criteriaFromCharter,
  DEFAULT_MAX_REVIEW_ROUNDS,
  evaluateGate,
  type GateCriterion,
  type GateInput,
  METRIC_CONDITION,
  metricCriteriaEvaluator,
} from "../../src/graph/gates/evaluate.js";

const BUNDLE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function bundle(over: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    bundle_id: BUNDLE_ID,
    task_id: "T-1",
    bundle_type: "code_diff",
    produced_by_role: "dev",
    produced_by_model_family: "claude",
    artifacts: [
      { path: "T-1/code_diff/x.diff", sha256: "a".repeat(64), bytes: 10 },
    ],
    claims: [
      { text: "改动覆盖了登录路径", evidence_refs: ["T-1/code_diff/x.diff"] },
    ],
    honesty_boundaries: [],
    metrics: { coverage: 91, p0_defect_count: 0 },
    ...over,
  };
}

function criterion(over: Partial<GateCriterion> = {}): GateCriterion {
  return {
    // 默认这条【不违反】：coverage 91 不满足「coverage <= 80」这个不合格情形
    condition: "metric:coverage <= 80",
    action: "reject",
    message: "覆盖率不足 80，不得放行",
    ...over,
  };
}

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    gate: "dev_to_test",
    producer: { roleId: "dev", modelFamily: "claude" },
    bundle: bundle(),
    criteria: [criterion()],
    integrityOk: true,
    ...over,
  };
}

/* ------------------------ 静态一面的取材 ------------------------ */

const SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
  "graph",
  "gates",
  "evaluate.ts",
);

/**
 * 去掉注释，只留代码。
 *
 * 【为什么必须去注释】第一版直接扫原文，结果被 evaluate.ts 自己的文件头判红 ——
 * 那段注释里写着「本文件里不允许出现 Date.now()」。守卫把【禁令】当成【违规】，
 * 是一条会逼人删掉好注释的测试：那比没有守卫更糟。所以先剥注释。
 *
 * 剥法用状态机而不是正则一行流：块注释里可以出现 //，行注释里可以出现 /*，
 * 一行流正则两种都会切错。已知局限两条，都是【漏判方向】而不是假阳方向：
 *  一、模板字符串里出现的 /* 会被当成块注释起点（本模块没有模板字符串）；
 *  二、正则字面量里出现的 //（如未转义的 https://）会被当成行注释起点
 *     （本模块的 METRIC_CONDITION 没有这一形；evidence.ts 那条写了 \/ 转义）。
 * 两条都记在这里而不是悄悄留着 —— 《已知漏判》不是接受理由（见仓库门禁的同名口径），
 * 真要扩就先给下面那条「剥注释本身是对的」补用例。
 */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  type State = "code" | "line" | "block" | "string" | "template" | "regexish";
  let st: State = "code";
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (st === "code") {
      if (c === "/" && n === "/") {
        st = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && n === "*") {
        st = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        st = "string";
      }
      if (c === "`") st = "template";
      out += c;
      i += 1;
      continue;
    }
    if (st === "line") {
      if (c === "\n") {
        st = "code";
        out += c;
      } else out += " ";
      i += 1;
      continue;
    }
    if (st === "block") {
      if (c === "*" && n === "/") {
        st = "code";
        out += "  ";
        i += 2;
        continue;
      }
      // 换行要留住：行号对齐靠它
      out += c === "\n" ? c : " ";
      i += 1;
      continue;
    }
    if (st === "string") {
      out += c;
      if (c === "\\") {
        out += (n ?? "") as string;
        i += 2;
        continue;
      }
      if (c === '"' || c === "\n") st = "code";
      i += 1;
      continue;
    }
    // template：只认反引号收尾（见上面的局限说明）
    out += c;
    if (c === "`") st = "code";
    i += 1;
  }
  return out;
}

const CODE = stripComments(readFileSync(SRC, "utf8"));

describe("确定性（§24 风险 5）", () => {
  it("同一输入调用 100 次，序列化后逐字节相同（三种判定分支各一遍）", () => {
    const cases: GateInput[] = [
      input(),
      input({ criteria: [] }), // reject 分支
      input({ roundNo: DEFAULT_MAX_REVIEW_ROUNDS }), // escalate 分支
    ];
    for (const c of cases) {
      const first = JSON.stringify(evaluateGate(c));
      for (let i = 0; i < 100; i++) {
        // 序列化后比而不是 toEqual：toEqual 容忍键序差异，而「审计里写下去的那行
        // JSON 永远一样」要求的是键序也稳定。
        expect(JSON.stringify(evaluateGate(c))).toBe(first);
      }
    }
  });

  it("输入对象不被就地修改（就地改会让第二个门控读到第一个的残留）", () => {
    const b = bundle();
    const bJson = JSON.stringify(b);
    const criteria = [criterion()];
    const cJson = JSON.stringify(criteria);
    evaluateGate(input({ bundle: b, criteria }));
    expect(JSON.stringify(b)).toBe(bJson);
    expect(JSON.stringify(criteria)).toBe(cJson);
  });

  it("每次返回新实例（共享实例会让调用方的就地改写污染下一次判定）", () => {
    const c = input();
    const a = evaluateGate(c);
    const d = evaluateGate(c);
    expect(a).not.toBe(d);
    expect(a).toEqual(d);
  });

  it("代码里不含时钟 / 随机 / I/O / async（补 100 次循环的不足）", () => {
    // 为什么要有这条：上面的重复调用只能证伪【依赖时钟或随机数】的实现 ——
    // 100 次落在同一毫秒内时，读 Date.now() 的实现照样「逐字节相同」。
    // 那是那套断言的真实边界，所以必须补一条静态判据。
    for (const banned of [
      "Date.now",
      "new Date",
      "Math.random",
      "performance.now",
      "setTimeout",
      "fetch(",
      "require(",
    ]) {
      expect(CODE.includes(banned), "禁项 " + banned).toBe(false);
    }
    // 无 async / await：无 I/O 就无需异步，而 await 引入调度点，调度点引入
    // 顺序不确定性（evaluate.ts 文件头写明了这条硬规定）。
    expect(/\basync\b/u.test(CODE), "禁项 async").toBe(false);
    expect(/\bawait\b/u.test(CODE), "禁项 await").toBe(false);
    for (const spec of [
      "node:fs",
      "node:net",
      "node:http",
      "node:sqlite",
      "node:child_process",
    ]) {
      expect(CODE.includes(spec), "禁 import " + spec).toBe(false);
    }
  });

  it("剥注释这件事本身是对的（守卫自己也要有人查）", () => {
    // 这一条是【人工构造的反例】：禁令文本必须被剥掉，代码文本必须留下。
    // 少了这一条，stripComments 写坏（比如把整篇剥成空串）时，上面那条静态守卫
    // 会因为「什么都扫不到」而【永远通过】—— 那是假绿最舒服的形态。
    const sample = [
      '// Date.now() 不许出现',
      "/* Math.random() 也不许 */",
      "const ok = 1;",
      "fetch(x);",
    ].join("\n");
    const stripped = stripComments(sample);
    expect(stripped.includes("Date.now")).toBe(false);
    expect(stripped.includes("Math.random")).toBe(false);
    // 代码侧必须原样留下，否则上面的守卫是空转
    expect(stripped.includes("fetch(x)")).toBe(true);
    expect(stripped.includes("const ok = 1")).toBe(true);
    // 行号对齐：换行不能丢
    expect(stripped.split("\n").length).toBe(sample.split("\n").length);
    // 并且 evaluate.ts 的原文里【确实】有这些禁令文本 —— 否则「剥注释有效」这句话
    // 在本仓无从证伪（空对空）。
    const raw = readFileSync(SRC, "utf8");
    expect(raw.includes("Date.now")).toBe(true);
    expect(CODE.includes("Date.now")).toBe(false);
  });
});

describe("空标准必须 reject（计划点名的最危险静默失效）", () => {
  it("criteria 为空 → reject，而不是 pass 也不是 escalate", () => {
    const v = evaluateGate(input({ criteria: [] }));
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("没有任何验收标准");
      // 报错要给出修法，否则开发者看到的是一条死路而不是一条待办
      expect(v.required_fixes.join("")).toContain("acceptance_criteria");
    }
  });

  it("不放行的理由是【配置缺陷】语义：不占用 CEO 的注意力", () => {
    // escalate 会让 CEO 每周重看同一个缺陷；reject 会逼上游把标准补上。
    // 这条钉的是选型，防止将来有人「顺手改成 escalate 更稳妥」。
    expect(evaluateGate(input({ criteria: [] })).decision).not.toBe("escalate");
  });

  it("标准非空但全是判不了的自然语言 → escalate，不是 pass", () => {
    // 【本文件第一版期望 pass】，理由写的是「静默 pass 才是问题，要让调用方看见」。
    // 但【看见】和【拦住】是两件事：返回 unresolved 而 decision 仍是 pass，
    // 调用方只要不读那个字段（而它没有任何强制力）就等于什么都没发生。
    // 更硬的证据是模块之间本来就自相矛盾：routing/escalation.ts 早把「有标准没判定」
    // 定成 insufficient_evidence 升级触发条件，而门控自己放行 —— 先跑的是门控，
    // 于是升级侧那条触发条件永远走不到。现在两侧同向。
    const v = evaluateGate(
      input({ criteria: [criterion({ condition: "代码写得好" })] }),
    );
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.length).toBe(1);
    // 报错必须给出【出路】，否则 CEO 只会反复看到同一张看不懂原因的卡片
    if (v.decision === "escalate") {
      expect(v.reason).toContain("metric:");
    }
  });

  it("【最省事的假绿方式】是不写 metrics，而不是伪造覆盖率", () => {
    // 这条是本轮改动真正的来由。改之前：岗位书写了「覆盖率不够就 reject」，
    // 而证据包【一条 metrics 都不带】⇒ 标准走 unresolved ⇒ 门控 pass。
    // 也就是说 agent 什么都不用伪造，只要【不提覆盖率】就必然过闸。
    //
    // ⚠ condition 写的是【不合格的情形】（文件头那条方向口径），所以这里写的是
    // 「coverage < 80 ⇒ reject」。写成 ">= 80" 表达的是【覆盖率好就拒】——
    // 我第一版就是这么写错的，症状恰好是本文件点名最难发现的那一形：全绿而门控
    // 从不拦任何东西（它只拦低覆盖率之外的全部提交）。
    const noMetrics = bundle();
    delete noMetrics.metrics;
    const v = evaluateGate(
      input({
        bundle: noMetrics,
        criteria: [
          criterion({
            condition: "metric:coverage < 80",
            action: "reject",
            message: "覆盖率不足 80，不得放行",
          }),
        ],
      }),
    );
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join("")).toContain("coverage");
    // 而老实带上不达标数字的包，判的是 reject（不是 escalate）——
    // 两条路径必须分开：一个是「不合格」，一个是「没法判」。
    const honest = evaluateGate(
      input({
        bundle: bundle({ metrics: { coverage: 61 } }),
        criteria: [
          criterion({ condition: "metric:coverage < 80", message: "覆盖率不足" }),
        ],
      }),
    );
    expect(honest.decision).toBe("reject");
    expect(honest.unresolved).toEqual([]);
    // 达标的包才是真 pass：unresolved 为空是有条件的，不是恒空
    const good = evaluateGate(
      input({
        bundle: bundle({ metrics: { coverage: 91 } }),
        criteria: [
          criterion({ condition: "metric:coverage < 80", message: "覆盖率不足" }),
        ],
      }),
    );
    expect(good.decision).toBe("pass");
  });
});

describe("求值顺序：先结构完整性，再业务标准", () => {
  it("完整性未对账（undefined）→ 记入 unresolved 且不 pass", () => {
    // 与上一条同一个原则：「没核对过」不等于「核对通过」。恒当 ok 是一种假绿，
    // 而它比假绿更糟的地方在于【默认值】就是它 —— 调用方漏传一个参数就拿到了通过。
    const v = evaluateGate(input({ integrityOk: undefined }));
    expect(v.unresolved.join("")).toContain("未对账");
    expect(v.decision).not.toBe("pass");
  });

  it("完整性对账失败 → 即使所有业务标准都满足也不 pass", () => {
    // 这条防的是「覆盖率达标，但那份报告文件根本不在磁盘上」的通过。
    const v = evaluateGate(input({ integrityOk: false }));
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("完整性");
    }
  });

  it("主张引用了包内不存在的制品 → reject 并指出下标", () => {
    const v = evaluateGate(
      input({
        bundle: bundle({
          claims: [{ text: "凭经验判断没问题", evidence_refs: ["ghost.md"] }],
        }),
      }),
    );
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons.join("")).toContain("0");
    }
  });

  it("审阅者与产出者同角色 → escalate（这一维优先于业务标准）", () => {
    const v = evaluateGate(
      input({ reviewer: { roleId: "dev", modelFamily: "gpt" } }),
    );
    expect(v.decision).toBe("escalate");
    if (v.decision === "escalate") {
      expect(v.reason).toContain("同一角色");
    }
  });

  it("同角色审阅的 escalate 优先于完整性 reject（先说最该找人看的那条）", () => {
    const v = evaluateGate(
      input({
        integrityOk: false,
        reviewer: { roleId: "dev", modelFamily: "claude" },
      }),
    );
    expect(v.decision).toBe("escalate");
  });
});

describe("轮次上限（§8.3 第一条）", () => {
  it("达到默认上限即 escalate，不要求调用方每次传上限", () => {
    expect(DEFAULT_MAX_REVIEW_ROUNDS).toBe(3);
    expect(
      evaluateGate(input({ roundNo: DEFAULT_MAX_REVIEW_ROUNDS })).decision,
    ).toBe("escalate");
  });

  it("差一轮时不 escalate（上限是【达到即升】，不是【超过才升】）", () => {
    expect(
      evaluateGate(input({ roundNo: DEFAULT_MAX_REVIEW_ROUNDS - 1 })).decision,
    ).toBe("pass");
  });

  it("显式上限覆盖默认值", () => {
    expect(evaluateGate(input({ roundNo: 2, maxRounds: 2 })).decision).toBe(
      "escalate",
    );
  });

  it("轮次未提供 → 不因轮次升级（缺字段不当成条件成立）", () => {
    expect(evaluateGate(input()).decision).toBe("pass");
  });
});

describe("metric: 条件的机械判定", () => {
  it("六种比较符都判得动", () => {
    const cases: [string, number, "violated" | "satisfied"][] = [
      ["metric:coverage >= 80", 91, "violated"],
      ["metric:coverage >= 95", 91, "satisfied"],
      ["metric:coverage <= 95", 91, "violated"],
      ["metric:coverage <= 80", 91, "satisfied"],
      ["metric:coverage > 95", 91, "satisfied"],
      ["metric:coverage < 95", 91, "violated"],
      ["metric:p0_defect_count == 0", 0, "violated"],
      ["metric:p0_defect_count != 0", 0, "satisfied"],
    ];
    for (const [cond, p0, want] of cases) {
      const out = metricCriteriaEvaluator(
        criterion({ condition: cond }),
        bundle({ metrics: { coverage: 91, p0_defect_count: p0 } }),
      );
      expect(out.status, cond).toBe(want);
    }
  });

  it("condition 的语义方向：成立 = 该条标准【被违反】", () => {
    // 把方向读反的症状是「全绿但门控从不拦东西」，所以方向单独钉一条。
    expect(
      metricCriteriaEvaluator(
        criterion({ condition: "metric:coverage >= 80" }),
        bundle({ metrics: { coverage: 99 } }),
      ).status,
    ).toBe("violated");
    expect(
      metricCriteriaEvaluator(
        criterion({ condition: "metric:coverage >= 80" }),
        bundle({ metrics: { coverage: 10 } }),
      ).status,
    ).toBe("satisfied");
  });

  it("证据包没声明该指标 → unresolved，不臆断通过", () => {
    const out = metricCriteriaEvaluator(
      criterion({ condition: "metric:coverage >= 80" }),
      bundle({ metrics: {} }),
    );
    expect(out.status).toBe("unresolved");
  });

  it("连 metrics 字段都没有 → unresolved", () => {
    const b: EvidenceBundle = { ...bundle() };
    delete b.metrics;
    expect(metricCriteriaEvaluator(criterion(), b).status).toBe("unresolved");
  });

  it("NaN / Infinity → unresolved（与任何数比较都 false，会造出假通过）", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = metricCriteriaEvaluator(
        criterion({ condition: "metric:coverage >= 80" }),
        bundle({ metrics: { coverage: v } }),
      );
      expect(out.status, String(v)).toBe("unresolved");
    }
  });

  it("非 metric: 形状的自由文本一律 unresolved（不解析自然语言，也不交给 LLM）", () => {
    for (const cond of [
      "coverage < 0.90",
      "代码写得好",
      "metric: coverage >= 80 and p0 == 0",
      "",
    ]) {
      expect(
        metricCriteriaEvaluator(criterion({ condition: cond }), bundle())
          .status,
        cond,
      ).toBe("unresolved");
    }
  });

  it("正则本身不收畸形形状（指标名带空格、缺右操作数、非法比较符）", () => {
    for (const cond of [
      "metric:co verage >= 80",
      "metric:coverage >= ",
      "metric:coverage =~ 80",
      "metric: >= 80",
    ]) {
      expect(METRIC_CONDITION.test(cond), cond).toBe(false);
    }
    expect(METRIC_CONDITION.test("metric:p0_defect-count <= 0")).toBe(true);
  });
});

describe("业务标准的三种去向", () => {
  it("violated + action=reject → reject，并把 condition 转成 required_fixes", () => {
    const v = evaluateGate(
      input({
        criteria: [
          criterion({
            condition: "metric:coverage >= 50",
            message: "覆盖率不合格",
          }),
        ],
      }),
    );
    expect(v.decision).toBe("reject");
    if (v.decision === "reject") {
      expect(v.reasons).toEqual(["覆盖率不合格"]);
      expect(v.required_fixes).toEqual(["metric:coverage >= 50"]);
    }
  });

  it("violated + action=escalate → escalate，并带上升级目标", () => {
    const v = evaluateGate(
      input({
        criteria: [
          criterion({
            condition: "metric:coverage >= 50",
            action: "escalate",
            target: "tech_director",
            message: "覆盖率不达标，需总监判断",
          }),
        ],
      }),
    );
    expect(v.decision).toBe("escalate");
    if (v.decision === "escalate") {
      expect(v.reason).toContain("tech_director");
    }
  });

  it("escalate 优先于 reject（同批里两条都违反时）", () => {
    // 顺序即语义：escalate 意味着「这件事需要人看」。若先返回 reject，
    // 人永远不会被叫来，§8.2 第 3 条的第三种决定就丢了。
    const v = evaluateGate(
      input({
        criteria: [
          criterion({
            condition: "metric:coverage >= 50",
            action: "reject",
            message: "覆盖率不足",
          }),
          criterion({
            condition: "metric:coverage >= 90",
            action: "escalate",
            message: "极低覆盖率，需人工",
          }),
        ],
      }),
    );
    expect(v.decision).toBe("escalate");
  });

  it("unresolved 在【每一种】判定里都带出来（不能只在 pass 时带）", () => {
    const mixed = [
      criterion({ condition: "自由文本判不了" }),
      criterion({ condition: "metric:coverage >= 50", message: "覆盖率不足" }),
    ];
    const rejected = evaluateGate(input({ criteria: mixed }));
    expect(rejected.decision).toBe("reject");
    expect(rejected.unresolved.length).toBe(1);

    // 中间这一支原本是 pass：它现在不存在了 —— 「有标准没判成」本身就是 escalate。
    // 保留这一支是为了让【三种判定的出口各有一条】这件事可 grep：pass 的出口
    // 在下面「全部判成且都不违反」那条里。
    const unjudgeable = evaluateGate(
      input({ criteria: [criterion({ condition: "自由文本判不了" })] }),
    );
    expect(unjudgeable.decision).toBe("escalate");
    expect(unjudgeable.unresolved.length).toBe(1);

    const escalated = evaluateGate(
      input({
        criteria: [
          criterion({ condition: "自由文本判不了" }),
          criterion({
            condition: "metric:coverage >= 50",
            action: "escalate",
            message: "需人工",
          }),
        ],
      }),
    );
    expect(escalated.decision).toBe("escalate");
    expect(escalated.unresolved.length).toBe(1);
  });

  it("注入的判据覆盖内置判据（Phase 5 接测试执行器时换实现，内核零改动）", () => {
    const v = evaluateGate(
      input({
        criteria: [criterion({ condition: "任意 DSL：跑一次 e2e" })],
        criteriaEvaluator: () => ({ status: "satisfied" }),
      }),
    );
    expect(v.decision).toBe("pass");
    expect(v.unresolved).toEqual([]);
  });

  it("注入判据返回 unresolved 时同样不默认放行", () => {
    // 测试名里的「不默认放行」现在才真的成立：改之前这条断的是 pass，
    // 名字与断言各说一套 —— 名字是【意图】，断言是【事实】，两者不一致时
    // 读测试的人会信名字，于是这个洞在测试文件里也是看不见的。
    const v = evaluateGate(
      input({
        criteria: [criterion()],
        criteriaEvaluator: () => ({ status: "unresolved", why: "缺执行器" }),
      }),
    );
    expect(v.decision).toBe("escalate");
    expect(v.unresolved.join("")).toContain("缺执行器");
  });
});

describe("岗位书 → 门控标准（适配层不复制判据）", () => {
  it("四条字段一一映射，target 缺省时【不带】这个键", () => {
    // exactOptionalPropertyTypes: true 下 target: undefined 与 缺键 是两件事；
    // 带一个值为 undefined 的键会流进 JSON 与审计，读起来像「升级目标是空串」。
    const criteria = criteriaFromCharter({
      acceptanceCriteria: [
        {
          condition: "coverage < 0.90",
          action: "reject",
          message: "覆盖率不足90%",
        },
        {
          condition: "metric:p0_defect_count != 0",
          action: "escalate",
          target: "tech_director",
          message: "有 P0 缺陷",
        },
      ],
    } as unknown as Parameters<typeof criteriaFromCharter>[0]);
    expect(criteria).toHaveLength(2);
    expect(Object.hasOwn(criteria[0] as object, "target")).toBe(false);
    expect(criteria[1]).toEqual({
      condition: "metric:p0_defect_count != 0",
      action: "escalate",
      target: "tech_director",
      message: "有 P0 缺陷",
    });
  });
});
