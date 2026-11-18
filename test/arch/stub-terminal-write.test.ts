/**
 * O1 验收守卫：桩图绝不替人走那一步。
 *
 * 判据在 ./stub-terminal-write.ts，本文件只负责让它【不可能空跑】。形状照
 * ./dead-modules.test.ts：真库跑一遍主判据 + 合成树跑阳性对照 + 每条口径的边界
 * 各钉一发。判据与测试分开成两个文件同一个理由：biome 的 noExportsInTest 不许从
 * *.test.ts 导出，而我手跑复核时要拿同一份判据（复制一份必漂移）。
 *
 * ── 本文件最怕的三种假绿 ────────────────────────────────────────
 *  ① 提取器抽出空表 ⇒ 「没有越权」自动成立。所以每条主判据前面都先有一条
 *     【取材非空】，且条数钉死（不是 > 0）。
 *  ② 席位口径被改空 ⇒ humanSeatTargets() 返回空集 ⇒ bypasses() 恒空。所以有一条
 *     专门测【那批格子非空且内容与表一致】，另有一条测两张席位表互补不重叠。
 *  ③ 结构前提不成立而没人发现 ⇒ 切分切早、漏扫一段。所以有 nodeCoverageProblems
 *     与 assemblyCoverageProblems 两条独立前提，且各配一发【故意破坏】的阳性对照。
 *     （原先的第二条「每个状态字面量都要落在节点体内」实测恒真，已删 ——
 *     理由与实测方法记在判据文件 assemblyCoverageProblems 的头里。）
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as dispatchNs from "../../packages/hub/src/engine/dispatch.js";
import { HUMAN_EDGES } from "../../packages/hub/src/engine/dispatch.js";
import type { TaskState } from "../../packages/hub/src/graph/status.js";
import { type Module, repoRoot } from "./dead-modules.js";
import {
  agentSeatStates,
  allTaskStates,
  analyse,
  assemblyCoverageProblems,
  BASELINE,
  type BaselineEntry,
  bypasses,
  checkBaseline,
  collectWrites,
  companySource,
  describeWrites,
  findUnguardedStatusWriters,
  humanSeatTargets,
  nodeCoverageProblems,
  SEAT_AUTHORITY_NAMES,
  statusWriterModules,
  stubWrites,
  usesSeatAuthority,
  WRITER_BASELINE,
} from "./stub-terminal-write.js";

const REAL = analyse();

describe("取材：判据不是空跑", () => {
  it("桩图的每个装配节点恰好一个体", () => {
    // 红了不要去改判据，去看 company.ts 的 node( 形状变了没。
    expect(REAL.coverage, REAL.coverage.join(" | ")).toEqual([]);
  });

  it("装配配对前提：addNode 的名字与就地的 node( 名字一一对得上", () => {
    // 这条是【漏报方向】唯一被钉住的地方：`.addNode("report", handlerInAnotherFile)`
    // 这种形状下写点住在判据看不见的地方，那条边会凭空消失而一切照绿。
    expect(REAL.assembly, REAL.assembly.join(" | ")).toEqual([]);
  });

  it("写点序列恰好是桩该产生的那 11 条，不多不少", () => {
    // 钉死条数而不是 > 0：这条同时是「提取器认得 write(...) 这个形状」的证据。
    // 把 company.ts 里的 write 改名，这里先红，于是主判据不会静默变成恒真。
    expect(REAL.edgeCount).toBe(11);
    expect(describeWrites(REAL.writes)).toBe(
      [
        "intake→CHARTER_PENDING",
        "charter→CHARTER_APPROVED",
        "product→DECOMPOSING",
        "tech→IN_PROGRESS",
        "dev→REJECTED_DOWNWARD",
        "dev→IN_PROGRESS",
        "dev→EVIDENCE_SUBMITTED",
        "test→IN_REVIEW",
        "test→REJECTED_DOWNWARD",
        "test→APPROVED_UPWARD",
        "report→ESCALATED_TO_CEO",
      ].join(", "),
    );
  });

  it("抽出来的是任意一次真执行的超序列：分支那一发（dev 的 REJECTED_DOWNWARD）在里面", () => {
    // company.ts 的 dev 体是 `if (state.current === "REJECTED_DOWNWARD") await write(...)`。
    // 词法看不出分支，所以抽出的是超序列。这条钉住【多抽的方向】是被知道的，
    // 不是等到某天有人拿它当真实轨迹去数条数才发现。
    const dev = REAL.bodies.find((b) => b.node === "dev");
    expect(dev?.writes).toEqual([
      "REJECTED_DOWNWARD",
      "IN_PROGRESS",
      "EVIDENCE_SUBMITTED",
    ]);
  });

  it("注释里的状态名【不算】写点 —— 拿真文件里那句反证", () => {
    // company.ts 的 report 节点注释里写着「不再直写 ARCHIVED」等一整段状态名。
    // 扫全文的话那些会被当成写点，条数立刻不对。这条与上一条互为反向。
    const withComments = REAL.writes.filter(
      (w) => w.to === "ARCHIVED" || w.to === "DELIVERED",
    );
    expect(withComments.map((w) => w.to)).toEqual([]);
    expect(REAL.source).toContain("ARCHIVED"); // 注释里确实有，不然这条是空证
  });
});

describe("主判据：桩没有替人走那一步", () => {
  it("桩的全部写点都不落在【人类格子的落点】上", () => {
    expect(REAL.baseline.unexpected.map((w) => w.via + "→" + w.to)).toEqual([]);
  });

  it("基线双向：没有过期条目，也没有失效的特征串", () => {
    expect(REAL.baseline.stale.map((e) => e.via + "→" + e.to)).toEqual([]);
    expect(REAL.baseline.invalidMarks.map((e) => e.via + ":" + e.mark)).toEqual(
      [],
    );
  });

  it("宽扫描：写 tasks.status 而无席位权威的模块 = 基线，且基线双向", () => {
    expect(REAL.unguarded).toEqual([]);
    expect(REAL.writerBaselineStale).toEqual([]);
    // 减基线之前确实命中过东西 ⇒ 基线不是「本来就没东西」的假绿。
    expect(REAL.writerAll.length).toBeGreaterThan(0);
    expect(REAL.writerAll).toContain("graph/company.ts");
  });

  it("⭐ 停下的那一格【不是】人类格子的落点 —— 这条是 report 改动被钉住的地方", () => {
    const stop = REAL.writes.at(-1)?.to;
    expect(stop).toBe("ESCALATED_TO_CEO");
    expect(humanSeatTargets().has(stop as TaskState)).toBe(false);
    // 反向也钉：夹具里那个 STUB_STOP_STATE 若被改成人类格子，
    // e2e-linear 会把「桩越权」当成正确期望来断言。这里先红。
    // 不从 fixtures 取常量：arch 这边引 test 夹具会把测试网绕成一个环。
  });

  it("charter 那条已知越权【仍在基线里】，不是被漏掉", () => {
    const b = BASELINE.find((e) => e.via === "charter");
    expect(b?.to).toBe("CHARTER_APPROVED");
    // 它确实成立（否则 stale 那条早就红了），所以主判据是在【明知有】的情况下放行这一条。
    const still = bypasses(REAL.writes).find((w) => w.via === "charter");
    expect(still?.to).toBe("CHARTER_APPROVED");
  });

  it("设计文档点名的 ARCHIVED 【不是】人类落点 —— 记录为什么换了判据", () => {
    // 原文要盯 ARCHIVED。实测那三条越权边里 ARCHIVED 反而不在席位口径的射程里：
    // DELIVERED 才是人类落点（FINAL_REVIEW.approve 的 to），ARCHIVED 由 DELIVERED
    // 自动可达。盯 ARCHIVED 会放掉真正替 CEO 批的那两条。这条测试就是那句更正的证据。
    expect(humanSeatTargets().has("ARCHIVED")).toBe(false);
    expect(humanSeatTargets().has("DELIVERED")).toBe(true);
    expect(humanSeatTargets().has("FINAL_REVIEW")).toBe(true);
  });
});

describe("席位口径：从表推，不写名单", () => {
  it("人类落点 = HUMAN_EDGES 全部 approve 的 to，内容与表一字不差", () => {
    const fromTable = new Set<TaskState>();
    for (const v of Object.values(HUMAN_EDGES)) {
      for (const e of Object.values(v ?? {}))
        if (e !== undefined) fromTable.add(e.to);
    }
    expect([...humanSeatTargets()].sort()).toEqual([...fromTable].sort());
    expect(humanSeatTargets().size).toBeGreaterThan(0); // 判据 ② 防空集
  });

  it("两张席位表互补不重叠：同一格不能既有 agent 出边又是人坐的格子", () => {
    // 重叠的话「这条边该不该由 hub 自己走」就没有确定答案，这条守卫的口径失去意义。
    // 用两张真表算，不在这里抄状态名。
    const humanStarts = Object.keys(HUMAN_EDGES) as TaskState[];
    const overlap = humanStarts.filter((s) => agentSeatStates().has(s));
    expect(overlap).toEqual([]);
    expect(humanStarts.length).toBe(3);
    // 人坐的格子【起点】与【落点】不是一回事：FINAL_REVIEW 既是人坐的格的落点，
    // 又是另一格人坐的格的起点。守卫取的是落点，理由写在判据文件头。
    expect(humanSeatTargets().has("FINAL_REVIEW")).toBe(true);
  });

  it("状态全集与 src 的边表同源，本模块没有第二份名单", () => {
    expect(allTaskStates().size).toBe(15);
    expect(allTaskStates().has("ARCHIVED")).toBe(true);
  });
});

/* ═════════════════════ 阳性对照：合成树 ═════════════════════ */

/** 最小的一棵假桩图。节点体形状与 company.ts 一致，否则这条对照测的不是真形状。 */
function fakeCompany(writes: string[]): string {
  const bodies = writes
    .map((ws, i) => {
      const calls = ws
        .split(",")
        .filter((s) => s !== "")
        .map((s) => '        await write("' + s + '");')
        .join("\n");
      return (
        '    .addNode(\n      "n' +
        i +
        '",\n      node("n' +
        i +
        '", async (_state, write) => {\n' +
        calls +
        "\n        return {};\n      }),\n    )"
      );
    })
    .join("\n");
  return "export function build() {\n" + bodies + "\n}\n";
}

function fakeMods(extra: Module[] = []): Module[] {
  return [
    { rel: "graph/company.ts", text: "无" },
    { rel: "engine/dispatch.ts", text: "seatOf" },
    ...extra,
  ];
}

describe("阳性对照：坏形状必须报", () => {
  const states = allTaskStates();

  it("桩写进 DELIVERED ⇒ 报（这是本次修掉的那一发）", () => {
    const src = fakeCompany([
      "CHARTER_APPROVED",
      "ESCALATED_TO_CEO,FINAL_REVIEW,DELIVERED",
    ]);
    const w = stubWrites(collectWrites(src, states));
    expect(bypasses(w).map((x) => x.via + "→" + x.to)).toEqual([
      "n0→CHARTER_APPROVED",
      "n1→FINAL_REVIEW",
      "n1→DELIVERED",
    ]);
  });

  it("桩只停在 ESCALATED_TO_CEO ⇒ 不报（负向配对，防空提取自动通过）", () => {
    const src = fakeCompany(["ESCALATED_TO_CEO"]);
    expect(bypasses(stubWrites(collectWrites(src, states)))).toEqual([]);
  });

  it('注释里写 write("DELIVERED") ⇒ 不报（口径的另一半）', () => {
    const src =
      '/** 曾经这里 await write("DELIVERED"); 现在不写了 */\n' +
      fakeCompany(["ESCALATED_TO_CEO"]);
    expect(bypasses(stubWrites(collectWrites(src, states)))).toEqual([]);
  });

  it("单引号与模板串里的状态名 ⇒ 不算写点，也不制造假节点", () => {
    const src =
      "const a = 'DELIVERED';\nconst b = `DELIVERED`;\n" +
      fakeCompany(["ESCALATED_TO_CEO"]);
    const bodies = collectWrites(src, states);
    expect(bypasses(stubWrites(bodies))).toEqual([]);
    expect(bodies.length).toBe(1);
  });

  it("node( 名字不在 COMPANY_NODES ⇒ 结构前提红（不是静默少扫）", () => {
    const src = fakeCompany(["ESCALATED_TO_CEO"]);
    expect(
      nodeCoverageProblems(collectWrites(src, states)).length,
    ).toBeGreaterThan(0);
  });

  it("函数定义 function node( 不被当成节点体起手", () => {
    const src =
      "function node(name: string, fn: unknown) {\n  return fn;\n}\n" +
      fakeCompany(["ESCALATED_TO_CEO"]);
    const bodies = collectWrites(src, states);
    expect(bodies.map((b) => b.node)).toEqual(["n0"]);
  });

  it("⭐ addNode 指向一个不在地的 handler ⇒ 装配配对前提红（漏报方向唯一的守卫）", () => {
    // 这是【漏报】的那一发：`.addNode("report", farAway)` 时写点住在别处，
    // collectWrites 完全看不见它，那条边会凭空从判据里消失而一切照绿。
    const src =
      "const farAway = async (_s: unknown, write: (s: string) => void) => {\n" +
      '        await write("DELIVERED");\n        return {};\n      };\n' +
      '    .addNode(\n      "report",\n      farAway,\n    )\n';
    const bodies = collectWrites(src, states);
    expect(bodies).toEqual([]); // 证实：写点确实【看不见】—— 所以才需要这条前提
    expect(assemblyCoverageProblems(src, bodies).join(" | ")).toContain(
      "report",
    );
    // 反向配对：正常形状 ⇒ 无问题。少这一半，上面那条红可能只是因为解析器全废。
    expect(
      assemblyCoverageProblems(
        fakeCompany(["ESCALATED_TO_CEO"]),
        collectWrites(fakeCompany(["ESCALATED_TO_CEO"]), states),
      ),
    ).toEqual([]);
  });

  it("基线不是通行证：特征串消失 ⇒ 那条豁免当场失效并红", () => {
    const w = [{ via: "charter", to: "CHARTER_APPROVED" as TaskState }];
    const entry: BaselineEntry = {
      via: "charter",
      to: "CHARTER_APPROVED",
      mark: "没有审批门控",
      why: "x",
    };
    const good = checkBaseline(w, fakeMods(), companySource(), [entry]);
    expect(good.unexpected).toEqual([]);
    // 同一条边、同一条基线，只把【源文件】换成没有那句标注的 ⇒ 豁免凭据没了 ⇒ 红
    const bad = checkBaseline(
      w,
      fakeMods(),
      fakeCompany(["CHARTER_APPROVED"]),
      [entry],
    );
    expect(bad.invalidMarks.map((e) => e.via)).toEqual(["charter"]);
    expect(bad.unexpected.map((x) => x.via + "→" + x.to)).toEqual([
      "charter→CHARTER_APPROVED",
    ]);
  });

  it("特征串在全仓别处出现 ⇒ 豁免不认（防『随便找个地方写一句』）", () => {
    const w = [{ via: "charter", to: "CHARTER_APPROVED" as TaskState }];
    const entry: BaselineEntry = {
      via: "charter",
      to: "CHARTER_APPROVED",
      mark: "没有审批门控",
      why: "x",
    };
    const polluted = checkBaseline(
      w,
      fakeMods([{ rel: "x/other.ts", text: "见见见 没有审批门控" }]),
      companySource(),
      [entry],
    );
    expect(polluted.invalidMarks.map((e) => e.via)).toEqual(["charter"]);
  });

  it("边不再产生 ⇒ stale 报出来（『修好了』要回到文档）", () => {
    const stale = REAL.baseline.stale.map((e) => e.via + "→" + e.to);
    expect(stale).toEqual([]); // 今天没有
    // 阳性：给一条不存在的边配一条有效基线
    const entry: BaselineEntry = {
      via: "report",
      to: "ARCHIVED",
      mark: "没有审批门控",
      why: "x",
    };
    const r = checkBaseline(
      bypasses(REAL.writes).slice(0, 1),
      fakeMods(),
      companySource(),
      [entry],
    );
    expect(r.stale.map((e) => e.via + "→" + e.to)).toEqual(["report→ARCHIVED"]);
  });
});

describe("宽扫描的口径边界", () => {
  it("SQL 在注释里 ⇒ 不算写库模块（org/commit.ts 就是这一发）", () => {
    const src =
      "/** 原本我写的是 UPDATE tasks SET status=? 一条独立语句 */\nexport const x = 1;\n";
    expect(statusWriterModules([{ rel: "a.ts", text: src }])).toEqual([]);
  });

  it("SQL 在代码里 ⇒ 算写库模块", () => {
    const sql =
      'const S = "UPDATE tasks SET status=? WHERE id=?";\nexport default S;\n';
    expect(statusWriterModules([{ rel: "a.ts", text: sql }])).toEqual(["a.ts"]);
  });

  it("席位权威：认【从 dispatch.js 的具名 import】，不认【名字出现过】", () => {
    expect(usesSeatAuthority('import { seatOf } from "./dispatch.js";\n')).toBe(
      true,
    );
    expect(
      usesSeatAuthority(
        'import { humanEdge as he } from "../engine/dispatch.js";\n',
      ),
    ).toBe(true);
    expect(usesSeatAuthority('import { readFileSync } from "node:fs";\n')).toBe(
      false,
    );
    // 名字出现在注释里 ⇒ 不算。否则【本文件自己这些注释】就能把所有模块判成有门。
    expect(usesSeatAuthority("/** 复用 seatOf */\nconst x = 1;\n")).toBe(false);
    // import 写在注释里 ⇒ 不算
    expect(
      usesSeatAuthority(
        '// import { seatOf } from "./dispatch.js";\nconst y = 1;\n',
      ),
    ).toBe(false);
    // 只有调用没有 import（编译不过，但口径要说清）⇒ 不算
    expect(usesSeatAuthority("const x = seatOf(s);\n")).toBe(false);
    // ⭐ 局部同名变量 ⇒ 不算。这是【从第一版收紧】的那一发：第一版认「代码区里
    // 出现过这个名字」，于是一个 `const seatOf = 1` 就能让无门模块判成有门。
    expect(usesSeatAuthority("const seatOf = 1;\nexport { seatOf };\n")).toBe(
      false,
    );
  });

  it("dispatch.ts 自己【定义】那三个符号 ⇒ 算有门；名字清单不对着真导出会红", () => {
    const dispatchSrc = readFileSync(
      join(repoRoot(), "packages", "hub", "src", "engine", "dispatch.ts"),
      "utf8",
    );
    expect(usesSeatAuthority(dispatchSrc)).toBe(true);
    // 清单会腐烂的那一半：src 改了名而这边不知道 ⇒ 每个模块都判成【无门】⇒ 狂红
    // （还算能发现）；反向更糟：清单里留着一个谁都不要的旧名而它以别的身份出现在
    // 别处 ⇒ 判成【有门】⇒ 静默放行。所以对着真模块的导出逐个查。
    for (const n of SEAT_AUTHORITY_NAMES) {
      expect(
        Object.hasOwn(dispatchNs, n),
        n + " 已经不是 dispatch.js 的导出了 —— 这个名字清单要跟着改",
      ).toBe(true);
    }
  });

  it("模块粒度是这条判据的【已知余量】：同文件一半有门一半没有，判不出来", () => {
    // 不掩盖弱点。今天命中集合里只有桩图（实测），余量尚未被用到；写在这里是为了
    // 下一个读它的人不用自己重推边界。要收这一层得做调用图，那是另一个量级的判据。
    const sql =
      'const S = "UPDATE tasks SET status=?";\n' +
      'import { seatOf } from "./dispatch.js";\nexport { S, seatOf };\n';
    expect(
      findUnguardedStatusWriters(fakeMods([{ rel: "b.ts", text: sql }])),
    ).toEqual([]);
  });

  it("宽扫描基线逐条被特征串约束", () => {
    expect(WRITER_BASELINE.every((e) => companySource().includes(e.mark))).toBe(
      true,
    );
    expect(WRITER_BASELINE.map((e) => e.rel)).toEqual(["graph/company.ts"]);
  });
});

afterAll(() => {
  /* 本文件不建盘上夹具：判据的输入全是字符串与内存里的 Module，
	   所以没有需要清理的东西。留这个空块是为了下次有人加夹具时看得见约定。 */
});
