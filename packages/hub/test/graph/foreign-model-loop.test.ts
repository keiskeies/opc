/**
 * O1-3「真模型的最小回路」。名字照设计文档，判的东西比它那句更实在，差别全在这儿说清。
 *
 * ── 设计文档原话为什么不能照抄成测试 ─────────────────────────────────
 * docs/OPC-OS-功能优化设计.md O1 动作 3：「不联网、只验装配能接受一个真的
 * `BaseChatModel` 形状」。这句作为判据【恒真】，两个理由各自都够它真：
 *  ① `ModelRegistry.get(tier)` 的返回类型【就是】`BaseChatModel`，所以「能不能把一个
 *     BaseChatModel 传进去」由类型系统保证 —— 照那句话写的测试是【读一个定义就永远绿】
 *     的那一种，正是 0007 §4.1 说的「恒绿的判据教人忽略信号」。
 *  ② 它挡不住任何事：本仓唯一的 BaseChatModel 实现是桩自己（src/graph/stub-model.ts），
 *     而任何 `class X extends StubChatModel` 同时满足「是 BaseChatModel」和「是桩」⇒
 *     拿它跑一趟，验的是【桩接受桩】。
 *
 * ── 真会出事的方向，和它为什么测得到 ────────────────────────────────
 * 不是「类型对不对」，是【装配在模型对象上到底还碰了别的什么】。今天碰了 `invoke`
 * 一个方法；明天有人在 askModel 里加一句 `model.bindTools([])` 或 `model.stream(...)`，
 * 换的那一家 provider 恰好没有它 ⇒ 炸点在【节点内部 await 之后】，报错形状是
 * 「某次执行挂了」，不是「装配不匹配」—— 那是最难查的一类，因为复现要一次真调用。
 * 本文件把这件事变成机器判的：用 Proxy 包住【交给装配的那一个对象】，记录装配代码
 * 在它身上读过哪些属性名。LangChain 内部的 `this._generate` 不经过这层代理，
 * 所以记到的确实是【装配的依赖】，不是框架的自用属性。实测恰好一个：`invoke`。
 * 依赖面哪天变宽，这条当场红，且红在【改装配那个人】手上。
 *
 * ── 为什么模型用「外来的」而不是桩 ─────────────────────────────────
 * FakeListChatModel 来自 @langchain/core/utils/testing，【LangChain 自己写的】，
 * 不继承本仓的桩。它把整趟图跑完且路线一字不差 ⇒ 这一发才叫「桩对路线不承重」，
 * 也就是「桩换真」那一跳真正的前置检查点。下面有一条
 * `expect(那个模型).not.toBeInstanceOf(StubChatModel)` 专门钉住「用的确实是外来的」——
 * 没有它，将来有人把模型换回桩，这一发会【继续绿】。
 *
 * ── 顺手实测出来的一件事，比这条测试本身重要 ─────────────────────────
 * 模型回答【今天不进任何地方】：node() 里那句 `await askModel(name, state.idea);`
 * 没有接收方（不写行号：这条注释写完那一刻行号就已经错了一行，本仓今天为这件事
 * 改过三次文档坐标）。实测两次运行、回答内容【没有任何共同子串】，产出的
 * events / tasks / 图状态【逐字节相同】。这条在下面是一条断言，不是一句注释。
 * ⇒ 「把桩换成真模型」今天改变的只有【花费与失败模式】，不改变任何可观察产出。
 * 这是 O1 那节没写的一句话，已回填进设计文档。
 *
 * ⚠ 变异实测过的【存活变异】，别以为这条测试什么都杀得掉：把 askModel 从节点体
 * 之前挪到【之后】，本文件 6 发【全绿】。第一反应是「那这条测试没用」，实测出来
 * 的原因不是这个：挪动之后失败点仍在 product，而 product 那条边【照样回滚】，
 * 落库结果逐字节相同 —— 因为回滚边界是【超步事务】，不是「模型调用排在第几行」。
 * 所以这条测试判的是【回滚边界】，那个变异改的是【同事务内的顺序】，两者不相干。
 * 记在这儿是因为「我的测试杀不掉这个变异」这句话本身值得留档：它说明这条守卫的
 * 射程是边界而不是顺序，谁要它管顺序就得另写一条（而那要先想清楚管它干什么）。
 *
 * ⚠ 没有为此加任何 provider 依赖（`@langchain/anthropic` 等一律不在 node_modules）。
 * 加了就要在 CI 上装，而这条测试的价值一半在【不联网】—— 下面那句
 * `vi.stubGlobal("fetch", …)` 把「不联网」写成了可执行的，不是一句承诺。
 * 另注：生产路线今天【根本不走 BaseChatModel】—— engine/claude.ts 用 runRole 起
 * Claude CLI。所以「图路线接真模型」目前是一条【还没有生产实现的路】，
 * 本文件钉的是它接上时必须满足的形状。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MODEL_TIERS, type ModelTier } from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SqliteWALSaver } from "../../src/checkpoint/saver.js";
import { openDb } from "../../src/db/driver.js";
import { migrate } from "../../src/db/migrate.js";
import type { DomainEvent, EventBus } from "../../src/events/bus.js";
import { SuperStepAuditor } from "../../src/graph/audit-middleware.js";
import {
  buildCompanyGraph,
  COMPANY_NODES,
  type ModelRegistry,
} from "../../src/graph/company.js";
import { StubChatModel } from "../../src/graph/stub-model.js";
import { loadPresetRoles, tierOfNode } from "../../src/roles/preset.js";
import {
  EXPECTED_STUB_TRACE,
  runsOfNode,
  STUB_STOP_STATE,
  traceFromRows,
} from "./fixtures/company-fixtures.js";

/* ═══════════════════════════ 装配 ═══════════════════════════ */

/** 一趟完整执行里节点被执行的次数（dev / test 因回退各两次）。从夹具的
 *  runsOfNode 算，不写死 —— 那个数与「期望路线里 dev 出现两次」同源。 */
const TOTAL_NODE_RUNS = COMPANY_NODES.reduce(
  (n, node) => n + runsOfNode(node),
  0,
);

class FakeBus implements EventBus {
  readonly published: { event: DomainEvent; seq: number }[] = [];
  publishPersisted(e: DomainEvent, seq: number): void {
    this.published.push({ event: e, seq });
  }
  latestSeq(): number {
    return this.published.length;
  }
  subscribe(): never {
    throw new Error("本文件不订阅总线");
  }
}

const dirs: string[] = [];
const dbs = new Set<DatabaseSync>();

afterAll(() => {
  for (const d of dbs) {
    try {
      d.close();
    } catch {
      /* 已经随进程回收 */
    }
  }
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, maxRetries: 40, retryDelay: 50 });
    } catch {
      /* Windows 上 WAL 句柄释放有延迟，清不掉不影响结论 */
    }
  }
});

type Hub = {
  readonly db: DatabaseSync;
  readonly auditor: SuperStepAuditor;
  readonly path: string;
};

function makeHub(): Hub {
  const dir = mkdtempSync(join(tmpdir(), "opc-model-shape-"));
  dirs.push(dir);
  const path = join(dir, "hub.db");
  const db = openDb(path);
  migrate(db);
  dbs.add(db);
  const auditor = new SuperStepAuditor({
    db,
    bus: new FakeBus(),
    now: () => 1700000000000,
  });
  return { db, auditor, path };
}

/**
 * 只读的第二条连接。写连接看得见自己未提交的写入 ⇒ 拿它断言
 * 「失败后没留下半条边」必然假绿（与 e2e-linear 同一条理由，那里已实测过）。
 */
function readCommitted(dbPath: string, sql: string): Record<string, unknown>[] {
  const other = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return other.prepare(sql).all() as Record<string, unknown>[];
  } finally {
    other.close();
  }
}

const EVENTS_SQL = "SELECT id, payload FROM events ORDER BY id";
const TASKS_SQL = "SELECT id, status, current_node FROM tasks ORDER BY id";

/* ═══════════ 被观测的模型注册表：Proxy 记【装配读了什么】═══════════ */

/**
 * 把注册表交出去的那个对象包一层，记录装配在它身上读过的属性名。
 *
 * 只包【注册表返回的那一个对象】，不包注册表本身 —— 要量的是「装配用到模型的
 * 哪些成员」，`get` 是装配自己的方法，算进去会把口径糊掉。
 * 函数值绑回原对象再交出：不绑的话 `invoke` 里的 `this` 是代理，
 * LangChain 内部 `this._generate` 会【再经过一次代理】，那就把框架自用属性
 * 记成了装配依赖 —— 那正是本文件要避免的那类口径错。
 */
function spying(reg: ModelRegistry): {
  registry: ModelRegistry;
  /** 去重排序后的成员名 —— 装配的【依赖面】。 */
  read: () => string[];
  /** 按读取顺序的全部成员名（可重复）—— 用来数【真调了几次】。 */
  reads: string[];
} {
  const reads: string[] = [];
  const key = (k: string | symbol): string =>
    typeof k === "symbol" ? "Symbol(" + (k.description ?? "?") + ")" : k;
  return {
    reads,
    read: () => [...new Set(reads)].sort(),
    registry: {
      get(tier: ModelTier) {
        const model = reg.get(tier);
        return new Proxy(model, {
          get(o, k) {
            reads.push(key(k));
            const v = Reflect.get(o, k) as unknown;
            return typeof v === "function"
              ? (v as (...a: unknown[]) => unknown).bind(o)
              : v;
          },
        }) as BaseChatModel;
      },
    },
  };
}

/**
 * 一次运行到【结束或抛出】为止，返回跑完后【已提交】的一切。
 *
 * `entered` 来自装配自己的 onNodeEnter 钩子，不是猜的：它给出【失败时走到了哪个节点】，
 * 让下面那条 reject 用例能说出「product 被进来了、那条边【一格没写】」这种精确形状，
 * 而不是「少于总数」这种弱断言。
 */
async function runOnce(
  model: BaseChatModel,
  idea: string,
): Promise<{
  readonly error: string;
  readonly trace: [string, string][];
  readonly tasks: Record<string, unknown>[];
  readonly trail: unknown[];
  readonly entered: string[];
}> {
  const h = makeHub();
  const entered: string[] = [];
  const graph = buildCompanyGraph({
    db: h.db,
    recorder: h.auditor.recorder,
    saver: h.auditor.instrumentSaver(new SqliteWALSaver(h.db)),
    roles: loadPresetRoles(),
    models: { get: () => model },
    taskId: "T-SHAPE",
    observe: { onNodeEnter: (n) => entered.push(n) },
  });
  let error = "";
  let trail: unknown[] = [];
  try {
    const r = (await h.auditor.invoke(() =>
      graph.invoke(
        { idea, current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-shape" } },
      ),
    )) as { trail?: unknown[] };
    trail = r.trail ?? [];
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    error,
    trace: traceFromRows(readCommitted(h.path, EVENTS_SQL)),
    tasks: readCommitted(h.path, TASKS_SQL),
    trail,
    entered,
  };
}

/** 每档一个外来模型，好让「档位驱动」仍然是可断言的（不是一发模型包打全场）。 */
function perTierRegistry(replies: (tier: ModelTier) => string[]): {
  registry: ModelRegistry;
  seen: ModelTier[];
  models: Map<ModelTier, BaseChatModel>;
} {
  const seen: ModelTier[] = [];
  const models = new Map<ModelTier, BaseChatModel>();
  return {
    seen,
    models,
    registry: {
      get(tier: ModelTier) {
        seen.push(tier);
        let m = models.get(tier);
        if (m === undefined) {
          m = new FakeListChatModel({ responses: replies(tier) });
          models.set(tier, m);
        }
        return m;
      },
    },
  };
}

/* ═══════════════════════════ 测试 ═══════════════════════════ */

describe("O1-3 —— 装配对一个【外来】BaseChatModel 的依赖面", () => {
  beforeAll(() => {
    // 「不联网」写成可执行守卫：这一发里任何一次真 fetch 立刻炸。
    vi.stubGlobal("fetch", (() => {
      throw new Error("NOT_ALLOWED：O1-3 不得联网");
    }) as typeof fetch);
  });

  it("用的确实是外来的那个模型，不是桩换了个名字", () => {
    const foreign = new FakeListChatModel({ responses: ["x"] });
    // 这条看着像废话，它挡的是【将来有人把上面那行换成桩】：那样一来下面每一发
    // 都会继续绿，而它们验的东西（非桩实现能跑通）已经不成立了。
    expect(foreign).toBeInstanceOf(BaseChatModel);
    expect(foreign).not.toBeInstanceOf(StubChatModel);
    // 装配接口【只】要求 get() 返回 BaseChatModel —— 这里按【契约里的每一档】各取一次。
    // 原先写的是 `get: () => foreign` 再 `expect(reg.get(任意)).toBe(foreign)`：
    // 那种写法对任何入参都成立，等于没断言，而且当时传的还是一个【不存在的档位名】
    // （类型层报 TS2345，运行期无感 —— 而 tsc -b 不覆盖 test/，vitest 只转译，
    // 两边都不会红，是 0007 §1.3 那一族；这条是本次用一份临时 tsconfig 单独查出来的）。
    const reg: ModelRegistry = {
      get: (tier) => new FakeListChatModel({ responses: ["来自 " + tier] }),
    };
    for (const tier of MODEL_TIERS) {
      const m = reg.get(tier);
      expect(m).toBeInstanceOf(BaseChatModel);
      expect(m).not.toBeInstanceOf(StubChatModel);
      // 装配只用到 invoke，那就要求它真的在 —— 档位名单从契约取，
      // 在测试里抄一份名单就会在加档位时悄悄少测一档。
      expect(typeof m.invoke).toBe("function");
    }
  });

  it("装配在模型对象上读过的成员【恰好是 invoke】", async () => {
    const spy = spying({
      get: () => new FakeListChatModel({ responses: ["外来回答"] }),
    });
    const h = makeHub();
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.auditor.instrumentSaver(new SqliteWALSaver(h.db)),
      roles: loadPresetRoles(),
      models: spy.registry,
      taskId: "T-READ",
    });
    await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "依赖面", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-read" } },
      ),
    );
    // 去重后逐项比对，不用 toContain：【多出一个成员】才是这条要抓的事，
    // toContain 对多出来是绿的，而「多出来」正是那条未来故障的形状。
    expect(spy.read()).toEqual(["invoke"]);
    // 依赖面不是【一次都没读】凑出来的空集，也不是【读到却没调用】：
    // 九次节点执行 = 九次读 invoke。少了说明 askModel 换了调用方式，
    // 多了说明有人在节点体外反复取模型。两个方向都该红。
    expect(spy.reads).toEqual(
      Array.from({ length: TOTAL_NODE_RUNS }, () => "invoke"),
    );
  });

  it("一个非桩实现能把整趟图跑完，路线与桩【一字不差】", async () => {
    const { registry, seen, models } = perTierRegistry((t) => [
      "来自 " + t + " 的回答",
    ]);
    const h = makeHub();
    const graph = buildCompanyGraph({
      db: h.db,
      recorder: h.auditor.recorder,
      saver: h.auditor.instrumentSaver(new SqliteWALSaver(h.db)),
      roles: loadPresetRoles(),
      models: registry,
      taskId: "T-ROUTE",
    });
    const r = (await h.auditor.invoke(() =>
      graph.invoke(
        { idea: "一句想法", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-route" } },
      ),
    )) as { trail: unknown[] };

    // 路线：与桩那份期望【同一份常量】。这条是本文件的主体 —— 它说明
    // 把桩换成外来的，§7.1 那条轨迹一格没变。
    expect(traceFromRows(readCommitted(h.path, EVENTS_SQL))).toEqual(
      EXPECTED_STUB_TRACE,
    );
    expect(readCommitted(h.path, TASKS_SQL)[0]?.["status"]).toBe(
      STUB_STOP_STATE,
    );
    expect(r.trail).toEqual([
      "intake",
      "charter",
      "product",
      "tech",
      "dev",
      "test",
      "dev",
      "test",
      "report",
    ]);
    // 档位仍然由岗位书驱动：外来的注册表看到的档位多重集 = 真岗位书算出的那个。
    const bag: string[] = [];
    for (const n of COMPANY_NODES)
      for (let i = 0; i < runsOfNode(n); i += 1) bag.push(tierOfNode(n));
    expect([...seen].sort()).toEqual(bag.sort());
    // 每个档位拿到的确实是【按档位建的那一发】，不是共享一发包打全场。
    expect([...models.keys()].sort()).toEqual([...new Set(bag)].sort());
  });

  it("模型回答【今天不进任何产出】：两次内容无关的运行，落库逐字节相同", async () => {
    // 这条把文件头那句「回答被丢弃」从注释变成断言。它同时也是 O1 的一小块账：
    // 「桩换真」今天改变的只有花费与失败模式。哪天 askModel 的返回值开始被用，
    // 这条会红 —— 那是【应该红】：说明真模型开始影响产出，O1 的论证要重读。
    const a = await runOnce(
      new FakeListChatModel({ responses: ["紫罗兰-甲-乙"] }),
      "同一个想法",
    );
    const b = await runOnce(
      new FakeListChatModel({ responses: ["向日葵-丙-丁"] }),
      "同一个想法",
    );
    expect(a.error).toBe("");
    expect(b.error).toBe("");
    expect(b.trace).toEqual(a.trace);
    expect(b.tasks).toEqual(a.tasks);
    expect(b.trail).toEqual(a.trail);
    // 反向确认这两个回答真的没有共同子串，否则「相同」可以是【回答恰好相同】。
    expect("紫罗兰-甲-乙".includes("向日葵")).toBe(false);
    const anyLeak = (x: typeof a): boolean =>
      JSON.stringify(x.trace).includes("紫罗兰") ||
      JSON.stringify(x.trace).includes("向日葵") ||
      JSON.stringify(x.tasks).includes("紫罗兰") ||
      JSON.stringify(x.tasks).includes("向日葵");
    expect(anyLeak(a)).toBe(false);
    expect(anyLeak(b)).toBe(false);
  });

  it("模型中途 reject：异常上抛，且【不留半条边】—— 桩永远做不到的一件事", async () => {
    // 桩的 _generate 永不 reject，所以这条只有外来的模型能测。
    // 判的是失败【方向】：一次 429 之后，库里停在最后一个完整超步，
    // events 与 tasks.status 仍然互相吻合（§6.3 同事务那条 claim 的反面用例）。
    class RejectsThirdTime extends BaseChatModel {
      n = 0;
      // super({}) 不是可选的：BaseLanguageModel 的构造里要解构 kwargs.callbacks，
      // 不传参直接 TypeError（第一次跑就是这么炸的）。桩那边同款（stub-model.ts:59）。
      constructor() {
        super({});
      }
      _llmType(): string {
        return "rejects-third-time";
      }
      async _generate(
        _m: BaseMessage[],
        _o: this["ParsedCallOptions"],
        _r?: CallbackManagerForLLMRun,
      ): Promise<ChatResult> {
        this.n++;
        if (this.n === 3) throw new Error("429 rate limited");
        const text = "ok-" + this.n;
        return { generations: [{ text, message: new AIMessage(text) }] };
      }
    }
    const model = new RejectsThirdTime();
    const r = await runOnce(model, "会被打断的想法");
    expect(r.error).toContain("429");
    expect(model.n).toBe(3);
    // 失败时【执行走到了 product】，而库里只留到 charter 那一条边。
    // 这一对就是「回滚边界 = 超步」这句话的可执行形式：product 确实进来了、
    // 它的边确实没留下来。intake 本来就不写边，所以「进了 3 个节点、留下 1 条边」
    // 是精确期望，不是「少于总数」那种弱断言 —— 弱断言对【多出一条而状态没跟上】
    // 那种半写形状是绿的，这条对它红。
    expect(r.entered).toEqual(["intake", "charter", "product"]);
    expect(r.trace).toEqual([EXPECTED_STUB_TRACE[0]]);
    // events 与 tasks 必须互相吻合：状态 == 最后一条边的 to，节点 == 写它那一发。
    expect(r.tasks).toEqual([
      {
        id: "T-SHAPE",
        status: EXPECTED_STUB_TRACE[0]?.[1],
        current_node: "charter",
      },
    ]);
  });

  it("content-block 形状的回答不会把装配炸掉（真 provider 返回的就是这个）", async () => {
    // 桩返回纯 string，真 provider 返回 content-block 数组。askModel 里那个
    // `typeof reply.content === "string" ? … : JSON.stringify(…)` 分支【只有后者能命中】，
    // 而桩路线永远走不到它 —— 这条补的就是这一格的覆盖。
    class BlockContentModel extends BaseChatModel {
      constructor() {
        super({});
      }
      _llmType(): string {
        return "block-content";
      }
      async _generate(
        _m: BaseMessage[],
        _o: this["ParsedCallOptions"],
        _r?: CallbackManagerForLLMRun,
      ): Promise<ChatResult> {
        const text = "分块回答";
        return {
          generations: [
            {
              text,
              message: new AIMessage({
                content: [{ type: "text", text }],
              }),
            },
          ],
        };
      }
    }
    const r = await runOnce(new BlockContentModel(), "分块");
    expect(r.error).toBe("");
    expect(r.trace).toEqual(EXPECTED_STUB_TRACE);
    // 消息【确实】是块形状，不是被谁提前拍平了 —— 否则这条测的还是 string 分支。
    const probe = new BlockContentModel();
    const got = await probe.invoke([]);
    expect(Array.isArray(got.content)).toBe(true);
  });
});
