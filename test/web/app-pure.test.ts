/**
 * 渲块那批纯函数的**执行**证据（补 renderer-criteria.test.ts 照不到的那一半）。
 *
 * 分工（两份文件别混）：
 *   renderer-criteria.test.ts —— 扫源码，守「判据没落在渲块里」「琥珀落点合法」。
 *   本文件 —— 真把函数跑起来，守「这些函数算得对」。
 * 只有一份的话，前者的错误口径（0042 §11 我原先写过「渲块不产判定」那种半假话）
 * 不会被任何执行证据顶出来；后者则看不见配色与抄件。
 *
 * ⚠ 装载方式与它的边界写在 app-loader.ts，那里有三条坑（顶层会抛 /
 * setTimeout 必须空操作 / const 不挂 globalThis）。这一文件只测**纯函数**：
 * 输入 → 字符串 / 数 / 数组。renderToday 那种碰 fetch 与真 DOM 的入口不在射程内，
 * 所以**这一发仍然不等于"app.js 在浏览器里跑过"**（0042 §11 第一条不改）。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type AppExports, type LoadedApp, loadAppJs } from "./app-loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(HERE, "..", "..", "packages/web/public/app.js");

let fns: AppExports;
let loaded: LoadedApp;
beforeAll(() => {
  loaded = loadAppJs(APP_JS);
  fns = loaded.fns;
  // 顶层抛不抛【不判】—— 装载器文件头那条。这里只把它说出来，让人看见跑到哪。
  // 把它判成失败会导致下一个人去把 app.js 的入口改成懒执行，那是测试形状改产品。
  if (loaded.topError !== null) {
    console.log(
      "（app.js 顶层停在：" + loaded.topError.message.slice(0, 80) + "）",
    );
  }
});

const b = (over: Record<string, unknown> = {}) => ({
  consumed_in_window_cents: 0,
  consumed_total_cents: 0,
  declared_task_limits_cents: 0,
  declared_scopes: 0,
  silent_over_scopes: 0,
  ...over,
});

describe("meterPct —— 那根条形的宽度（口径唯一，且没有分母时不许有长度）", () => {
  const f = (x: Record<string, unknown>) =>
    (fns.meterPct as (y: unknown) => string)(b(x));

  it("常规情形：分子累计已花、分母已声明上限合计", () => {
    expect(
      f({
        consumed_total_cents: 5000,
        declared_task_limits_cents: 20000,
        declared_scopes: 1,
      }),
    ).toBe("25%");
  });

  it("⭐ 一行预算都没设过 ⇒ 0%，而不是半根条", () => {
    // 这是这一发存在的理由：分母为 0 时如果按除法会得到 NaN/Infinity，
    // 而 NaN 走到 style="width:NaN%" 是【浏览器静默忽略】——
    // 屏幕上会出现一根【满长】的条（CSS 默认宽度），读起来是"预算花光了"。
    expect(
      f({
        consumed_total_cents: 9999,
        declared_task_limits_cents: 0,
        declared_scopes: 0,
      }),
    ).toBe("0%");
    expect(f({ consumed_total_cents: 0, declared_scopes: 0 })).toBe("0%");
  });

  it("⭐ 超限钳到 100%（条画不出去，「超了」由文字与红色说）", () => {
    const got = f({
      consumed_total_cents: 30000,
      declared_task_limits_cents: 10000,
      declared_scopes: 2,
    });
    expect(got).toBe("100%");
    expect(got).not.toContain("300");
  });

  it("反向对照：分母有值而消费为 0 ⇒ 真的是 0%，不是 undefined%", () => {
    expect(
      f({
        consumed_total_cents: 0,
        declared_task_limits_cents: 10000,
        declared_scopes: 1,
      }),
    ).toBe("0%");
  });

  it("输出永远形如 <整数>% —— 没有 NaN / Infinity / 小数能漏进 style", () => {
    const cases = [
      {},
      {
        declared_scopes: 1,
        declared_task_limits_cents: 3,
        consumed_total_cents: 1,
      },
      {
        declared_scopes: 1,
        declared_task_limits_cents: -5,
        consumed_total_cents: 100,
      },
      {
        declared_scopes: -1,
        declared_task_limits_cents: 100,
        consumed_total_cents: 100,
      },
      {
        declared_scopes: 1,
        declared_task_limits_cents: 7,
        consumed_total_cents: 999999,
      },
    ];
    for (const c of cases) {
      const got = f(c);
      expect(/^\d+%$/u.test(got), JSON.stringify(c) + " ⇒ " + got).toBe(true);
      expect(got).not.toContain("NaN");
    }
  });
});

describe("overBudget —— 触及预算是【算术】，不是状态判定", () => {
  const f = (x: Record<string, unknown>) =>
    (fns.overBudget as (y: unknown) => boolean)({
      budget_cents: null,
      consumed_cents: 0,
      ...x,
    });

  it("相等算触及（>=，不是 >）", () => {
    expect(f({ budget_cents: 100, consumed_cents: 100 })).toBe(true);
    expect(f({ budget_cents: 100, consumed_cents: 101 })).toBe(true);
    expect(f({ budget_cents: 100, consumed_cents: 99 })).toBe(false);
  });

  it("⭐ 没设上限【不算】超预算（null / undefined / 缺字段三形）", () => {
    // 反向说：把 null 当 0 的话，每一个"没设预算"的任务都会被判成超支，
    // 「需要我注意」那一列于是永远满 —— 而它的症状跟"真的都超了"一模一样。
    expect(f({ budget_cents: null, consumed_cents: 500 })).toBe(false);
    expect(f({ budget_cents: undefined, consumed_cents: 500 })).toBe(false);
    expect(f({ consumed_cents: 500 })).toBe(false);
  });

  it("0 上限是真判据（不是「没设」）：花了一分就算触及", () => {
    expect(f({ budget_cents: 0, consumed_cents: 1 })).toBe(true);
    expect(f({ budget_cents: 0, consumed_cents: 0 })).toBe(true);
  });
});

describe("blockedTitle —— 判据字段真的被消费（不是发出来没人读）", () => {
  it("有清单时把【哪几个状态】写进 title", () => {
    const got = (fns.blockedTitle as (x: unknown) => string)({
      blocked_statuses: ["BUDGET_PAUSED", "BLOCKED"],
    });
    expect(got).toContain("BUDGET_PAUSED");
    expect(got).toContain("BLOCKED");
  });

  it("⭐ 清单缺失时不显示空括号（老服务端 / 字段没发）", () => {
    for (const t of [
      {},
      { blocked_statuses: [] },
      { blocked_statuses: null },
    ]) {
      const got = (fns.blockedTitle as (x: unknown) => string)(t);
      expect(got).not.toContain("{ }");
      expect(got).not.toContain("{}");
      expect(got.length).toBeGreaterThan(0);
    }
  });
});

describe("taskCard —— 琥珀只给决策态，列成员只给灰", () => {
  const tk = {
    id: "task-12345678-9",
    title: "做登录模块",
    status: "BUDGET_PAUSED",
    assigned_role: "dev",
    updated_at: 1,
    consumed_cents: 100,
    budget_cents: 100,
  };
  const card = (isAttention: boolean, isDecision: boolean) =>
    (fns.taskCard as (a: unknown, b: boolean, c: boolean) => string)(
      tk,
      isAttention,
      isDecision,
    );

  it("⭐ 阻塞（列成员）不琥珀：规格四处明写预算暂停非琥珀", () => {
    const got = card(true, false);
    expect(got).toContain("admin-tk admin-flag");
    expect(got).not.toContain("decision");
  });

  it("升级 CEO ⇒ 琥珀", () => {
    const got = card(true, true);
    expect(got).toContain("decision");
    // 同时是成员时不许两个类都上（两个左边框会互相覆盖，屏幕上看不出来）。
    expect(got).not.toContain("flag");
  });

  it("普通进行中任务：两个类都不许有", () => {
    const got = card(false, false);
    expect(got).not.toContain("decision");
    expect(got).not.toContain("flag");
  });

  it("标题里的 HTML 被转义（任务标题是用户输入）", () => {
    const evil = { ...tk, title: "<img src=x onerror=alert(1)>" };
    const got = (
      fns.taskCard as (a: unknown, b: boolean, c: boolean) => string
    )(evil, false, false);
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });
});

describe("approvalCard —— 待批 ≠ 琥珀（本轮真实违反过的那一条）", () => {
  const a = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    status: "pending",
    approval_type: "escalation",
    summary: "是否接受 P2 缺陷上线",
    task_id: "t1",
    created_at: 1,
    ...over,
  });
  const card = (x: Record<string, unknown>, isDecision = true) =>
    (
      fns.approvalCard as (
        a: unknown,
        n: number,
        c: boolean,
        d: boolean,
      ) => string
    )(x, 2, true, isDecision);

  it("待批 + 决策类型 ⇒ 琥珀", () => {
    const got = card(a(), true);
    expect(got).toContain("need");
    expect(got).toContain("s-amber");
  });

  it("⭐ 待批 + 运营类型 ⇒ 灰，且【不带】琥珀", () => {
    const got = card(a({ approval_type: "budget_override" }), false);
    expect(got).toContain("flag");
    expect(got).not.toContain("need");
    expect(got).not.toContain("s-amber");
    // 而且要把"这是运营事件"说出来（否则灰卡读起来像「坏了/不重要」）。
    expect(got).toContain("运营事件");
  });

  it("已决定的卡：两类都不上（决定做完了，没东西在等）", () => {
    const got = card(a({ status: "approved" }), true);
    expect(got).not.toContain("need");
    expect(got).not.toContain("flag");
    expect(got).not.toContain("s-amber");
  });

  it("⭐ 待批卡必须带三个按钮，运营卡也带 —— 颜色降级不等于按钮消失", () => {
    // 规格 §7.4 给预算暂停那三个按钮（追加预算 / 维持暂停 / 终止任务）本来就是 CEO 按的。
    // 把它涂灰很容易顺手写成"所以不给按钮"，那样这一格就变成只能看。
    expect(card(a(), true)).toContain("data-act");
    expect(card(a({ approval_type: "budget_override" }), false)).toContain(
      "data-act",
    );
  });
});

/* ═════════ O5 动作 4：卡片背面的证据行（补账轮，round264 落地时缺的执行证据）═════════
 * 服务端那一半（落库/读回/视图）在 hub 侧已有 cards.test ⑥ 与 query.test 钉住，
 * 但 UI 这一半【一行执行证据都没有】—— 而这一格的全部价值恰好在屏幕上那句话：
 * 「无证据包」不显示，缺证据的卡就和带证据的卡一样可批（§8.2 第 2 条的静默）。
 */
describe("evidenceLine —— 缺证据要在界面上【说破】，不是沉默", () => {
  const line = (a: Record<string, unknown>) =>
    (fns.evidenceLine as (x: unknown) => string)(a);

  it("⭐ null / undefined / [] ⇒ 「无证据包」加粗可见", () => {
    for (const refs of [null, undefined, []]) {
      const got = line({ evidence_refs: refs });
      expect(got).toContain("无证据包");
      expect(got).toContain("admin-ev-none");
    }
  });

  it("⭐ 非空数组 ⇒ `<details>` 可点开、逐条原文现身（round342 翻向：显原文，非放宽）", () => {
    const got = line({ evidence_refs: ["a.md", "b.md"] });
    expect(got).toContain("<details>");
    expect(got).toContain("证据 2 条");
    expect(got).toContain("<code>a.md</code>");
    expect(got).toContain("<code>b.md</code>");
    // 旧文案「N 条引用」已废：引号里的句号树没了，但「无证据包」不得误现身
    expect(got).not.toContain("条引用</h");
    expect(got).not.toContain("无证据包");
  });

  it("⭐ 逐条过 esc（refs 是库内路径/sha256 文本，不是可信标记）", () => {
    const got = line({ evidence_refs: ["<img src=x>"] });
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });

  it("⭐ 一行都不许凭空造：证据行嵌进卡片时随 evidence_refs 三态切换", () => {
    const card = (over: Record<string, unknown>) =>
      (
        fns.approvalCard as (
          a: unknown,
          n: number,
          c: boolean,
          d: boolean,
        ) => string
      )(
        {
          id: "a1",
          status: "pending",
          approval_type: "escalation",
          summary: "s",
          task_id: "t1",
          created_at: 1,
          ...over,
        },
        2,
        false,
        true,
      );
    expect(card({ evidence_refs: null })).toContain("无证据包");
    // round342 翻向：嵌进卡片时展开明细随 evidence_refs 出现（显原文，非放宽）
    expect(card({ evidence_refs: ["x"] })).toContain("证据 1 条");
    expect(card({ evidence_refs: ["x"] })).toContain("<code>x</code>");
    expect(card({ evidence_refs: ["x"] })).not.toContain("无证据包");
  });
});

/* ═════ round342：evidenceRefsHtml —— evidence_refs 明细半 ═════════
 * 旧「N 条引用」注释自称可点开复核却没有目标；这一格把逐条原文
 * （文件路径/sha256，query.ts:150-170）搁进 `<details>` + `<code>` 展示。
 * 空态由 evidenceLine 先拨去「无证据包」，这里兜底空串。
 */
describe("evidenceRefsHtml —— 证据明细可展开（round342）", () => {
  const f = (r: unknown): string =>
    String((fns.evidenceRefsHtml as (x: unknown) => unknown)(r));

  it("⭐ null / undefined / [] ⇒ 空串（evidenceLine 已把空态说成「无证据包」）", () => {
    for (const r of [null, undefined, []]) {
      expect(f(r), JSON.stringify(r)).toBe("");
    }
  });

  it("⭐ 非空 ⇒ N 条 + 逐条 `<code>` 原文", () => {
    const got = f(["docs/a.md", "sha256:abc", "docs/b.md"]);
    expect(got).toContain("<details>");
    expect(got).toContain("证据 3 条");
    expect(got).toContain("<code>docs/a.md</code>");
    expect(got).toContain("<code>sha256:abc</code>");
    expect(got).toContain("<code>docs/b.md</code>");
    expect(got).toContain("</details>");
  });

  it("⭐ 逐条过 esc（防注入守门）", () => {
    const got = f(["<img src=x onerror=1>", "a&b"]);
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img src=x onerror=1&gt;");
    expect(got).toContain("a&amp;b");
  });
});

describe("budgetHtml —— 那根条与那句近似声明", () => {
  const html = (over: Record<string, unknown>) =>
    (fns.budgetHtml as (x: unknown) => string)({
      budget: b(over),
      window_ms: 86_400_000,
      as_of_ms: 1,
    });

  it("⭐ 超限时条变红，并且【同屏】写明它不是规格 §7.4 那根「日」条", () => {
    const got = html({
      consumed_total_cents: 30000,
      declared_task_limits_cents: 10000,
      declared_scopes: 1,
    });
    expect(got).toContain("budgetover");
    expect(got).toContain("admin-meter admin-over");
    expect(got).toContain("累计");
  });

  it("没超限 ⇒ 不加过红类（否则红恒在，等于没有红）", () => {
    const got = html({
      consumed_total_cents: 100,
      declared_task_limits_cents: 10000,
      declared_scopes: 1,
    });
    expect(got).not.toContain("budgetover");
  });

  it("⭐ 警报已哑那一格用灰、不用琥珀也不用红", () => {
    const got = html({
      silent_over_scopes: 2,
      declared_scopes: 1,
      declared_task_limits_cents: 100,
    });
    expect(got).toContain("警报已哑");
    expect(got).toContain("admin-s-gray");
    expect(got).not.toContain("s-amber");
  });

  it("一行都没设过预算时【说出来】，而不是显示 $0.00 / $0.00 让人以为花光了", () => {
    const got = html({});
    expect(got).toContain("一行都没设过");
  });
});

describe("statusClass —— 呈现映射的边界（它拿不到琥珀的决定权）", () => {
  const f = (s: string) => (fns.statusClass as (x: string) => string)(s);

  it("四档色调各自命中", () => {
    expect(f("DELIVERED")).toBe("admin-s-green");
    expect(f("ARCHIVED")).toBe("admin-s-gray");
    expect(f("REJECTED_DOWNWARD")).toBe("admin-s-red");
    expect(f("IN_REVIEW")).toBe("admin-s-blue");
  });

  it("⭐ 任何输入都不许产出琥珀 —— 连 BUDGET_PAUSED / ESCALATED_TO_CEO 也不行", () => {
    // 这一发守的是"配色函数不许变成判据"那条线：
    // 哪天有人觉得"升级态顺手涂个琥珀挺自然"，这里红。
    for (const s of [
      "ESCALATED_TO_CEO",
      "BUDGET_PAUSED",
      "BLOCKED",
      "MEETING_REQUIRED",
      "",
      "deliver",
    ]) {
      expect(f(s), s).not.toContain("amber");
    }
  });
});

describe("hierarchyColumns / groupByDepth —— 列由 reports_to 派生（不许有任务凭空消失）", () => {
  type Nodes = Record<string, { reports_to?: string | null }>;
  const cols = (n: Nodes) =>
    (fns.hierarchyColumns as (x: unknown) => unknown[])(n);
  const group = (tasks: unknown[], c: unknown) =>
    (
      fns.groupByDepth as (
        t: unknown[],
        x: unknown,
      ) => Array<{ label: string; items: unknown[] }>
    )(tasks, c);

  const nodes: Nodes = {
    ceo: { reports_to: null },
    product: { reports_to: "ceo" },
    dev: { reports_to: "product" },
  };

  it("深度派生正确，列名不套那六个层级名（§16.4 那一行没有数据来源）", () => {
    const got = cols(nodes) as Array<{ label: string }>;
    expect(got.length).toBe(3);
    expect(got[0]?.label).toContain("深度 0");
    for (const c of got) {
      for (const name of ["助理", "执行", "运营"])
        expect(String(c.label)).not.toContain(name);
    }
  });

  it("⭐ 环不许把进程卡死，也不许让卡片凭空消失", () => {
    const cyc: Nodes = { a: { reports_to: "b" }, b: { reports_to: "a" } };
    const got = cols(cyc);
    expect(got.length).toBeGreaterThan(0);
    const t = [
      { assigned_role: "a", updated_at: 1 },
      { assigned_role: "b", updated_at: 1 },
    ];
    const g = group(t, got);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(2);
  });

  it("⭐ 角色不在组织图里的任务进「未挂组织」，各列之和恒等于总数", () => {
    const got = cols(nodes);
    const t = [
      { assigned_role: "dev", updated_at: 3 },
      { assigned_role: "ghost", updated_at: 2 }, // 图里没这个角色
      { assigned_role: "product", updated_at: 1 },
    ];
    const g = group(t, got);
    expect(g.reduce((n, x) => n + x.items.length, 0)).toBe(3);
    expect(g.some((x) => String(x.label).includes("未挂组织"))).toBe(true);
  });

  it("空组织图退化成单列而不是崩（列由数据派生，不是写死六列）", () => {
    const got = cols({}) as Array<{ label: string }>;
    expect(got.length).toBe(1);
  });
});

/* ═════════════ 驱动器那一格（0048 §7）═════════════
 * 这两个函数是【措辞】的实现，而措辞的错在屏幕上才会显形 —— 本机没有浏览器（0039），
 * 所以能做的就是把那几句话在 node 里真拼一遍，钉住：
 *  ① 三种「没有」各说各的话（没开 / 停了 / 字段缺失），而【都不是】沉默；
 *  ② 两档成因指向两个不同的下一步；
 *  ③ 转义只做一次。
 */
describe("driverNotice —— 三种「没有」不许说成同一句，更不许沉默", () => {
  type Notice = { level: string; msg: string } | null;
  const notice = (d: unknown): Notice =>
    (fns.driverNotice as (x: unknown) => Notice)(d);
  const ON = {
    enabled: true,
    pumping: true,
    task_limit_cents: 500,
    stopped: [],
  };

  it("⭐ 开着、在推、没人被丢下 ⇒ 不打扰（这是唯一该沉默的一档）", () => {
    expect(notice(ON)).toBeNull();
  });

  it("⭐ 没开驱动器 ⇒ 说话，而不是画一张空名单", () => {
    const n = notice({
      enabled: false,
      pumping: false,
      task_limit_cents: null,
      stopped: [],
    });
    expect(n).not.toBeNull();
    expect(n?.level).toBe("warn");
    // 这一发的实质：库里【没有】被放弃的任务时（stopped 为空）也必须有话。
    // 少了它，"这台 Hub 从不推东西"与"一切正常"在屏幕上同形 —— 那正是 0048 要消灭的形状。
    expect(n?.msg).toContain("--driver-pump");
  });

  it("⭐ 心跳停了 ⇒ 比【没开】更响一档，且不伪装成没开", () => {
    const n = notice({
      enabled: true,
      pumping: false,
      task_limit_cents: 500,
      stopped: [],
    });
    expect(n?.level).toBe("err"); // 它【本来在推】而此刻停了 = 出事，不是配置选择
    expect(n?.msg).not.toContain("--driver-pump"); // 那句会把人支去改一个已经开了的开关
  });

  it("字段整个缺失（老服务端 / GET /today 失败）⇒ 说「未知」而不是沉默", () => {
    for (const d of [undefined, null, {}, "x", 0]) {
      const n = notice(d);
      expect(n, JSON.stringify(d)).not.toBeNull();
      expect(n?.msg).toContain("未知");
    }
  });

  it("⭐ 只缺 pumping ⇒ 「未知」而【不是】「没开」（缺失不许被读成答案）", () => {
    // 这一发盯的是我第一版的写法 `if (!driver.enabled)`：`{}` 会走到
    // 「这台 Hub 没开驱动器」那一句 —— 一句从【缺失】里推出来的肯定陈述。
    const n = notice({ enabled: true, task_limit_cents: 500, stopped: [] });
    expect(n?.msg).toContain("未知");
    expect(n?.msg).not.toContain("--driver-pump");
  });

  it("两档成因分开计数（合成一句就丢掉了下一步该做什么）", () => {
    const n = notice({
      enabled: true,
      pumping: true,
      task_limit_cents: 500,
      stopped: [
        {
          task_id: "a",
          cause: "at_limit",
          attempts: 3,
          max_attempts: 3,
          since_ms: 1,
        },
        {
          task_id: "b",
          cause: "no_budget",
          attempts: null,
          max_attempts: null,
          since_ms: 1,
        },
        {
          task_id: "c",
          cause: "no_budget",
          attempts: null,
          max_attempts: null,
          since_ms: 1,
        },
      ],
    });
    expect(n?.msg).toContain("3 条");
    expect(n?.msg).toContain("1 条试到上限");
    expect(n?.msg).toContain("2 条被花钱的门挡住");
  });

  it("⭐ stopped 不是数组（服务端形状坏了）⇒ 说「未知」而【不是】「一切正常」", () => {
    const n = notice({
      enabled: true,
      pumping: true,
      task_limit_cents: 500,
      stopped: null,
    });
    // 今天读侧恒发数组，所以这一档不可达。它在这里是因为整个函数的立场是
    // 「每一种没有都要说出它是哪一种」，而 `?? []` 会把"响应坏了"读成"没有异常"。
    expect(n).not.toBeNull();
    expect(n?.msg).toContain("未知");
  });
});

describe("driverLine —— 卡片上那一行只排字符，不重判", () => {
  const NOW = 1_700_000_000_000;
  const line = (id: string, d: unknown): string =>
    (fns.driverLine as (a: string, b: unknown, c: number) => string)(
      id,
      d,
      NOW,
    );
  const MIN = 60_000;

  const drv = (stopped: unknown[]) => ({
    enabled: true,
    pumping: true,
    task_limit_cents: 500,
    stopped,
  });
  const limit = {
    task_id: "t1",
    cause: "at_limit",
    attempts: 3,
    max_attempts: 3,
    since_ms: NOW - 10 * MIN,
  };
  const budget = {
    task_id: "t2",
    cause: "no_budget",
    attempts: null,
    max_attempts: null,
    since_ms: NOW - 30 * MIN,
  };

  it("不在名单里的任务 ⇒ 空串（卡片形状不许变）", () => {
    expect(line("t9", drv([limit]))).toBe("");
    expect(line("t9", undefined)).toBe("");
  });

  it("⭐ 到顶那一档说出【第几次】，钱那一档说出【上限是多少钱】", () => {
    const a = line("t1", drv([limit]));
    expect(a).toContain("3/3");
    expect(a).toContain("10 分钟前");
    const b = line("t2", drv([budget]));
    expect(b).toContain("$5.00"); // 500 美分
    expect(b).toContain("30 分钟前");
    expect(b).not.toContain("/"); // 不许出现"第 x/y 次"那种根本没发生过的计数
  });

  /**
   * ⭐ 钱那一档指着的下一步【必须】是此刻真能做的那一步。
   *
   * 起因是探针（0049 §12）：那道门的【分母】是进程里那个 `--task-limit-cents`
   * （`serve/driver-pump.ts:487` 绑 `o.taskLimitCents`），而不是 `budgets.limit_cents`
   * 那一列 —— 把那一列从 500 改到 5000，门一个字都不响应（候选 0 → 0，
   * 看板照旧报"被钱挡住"）。所以「追加预算」今天在屏幕上【没有对应的动作】：
   * 一颗点下去不会有任何效果的按钮，比没有按钮更坏（0041 §7 那条判据）。
   * 我第一版那句写的是「花到了每条任务的上限」—— 它没说这一步在哪、能不能做，
   * 而看板【上面】那条预算条还写着另一个"上限"（`budgets.limit_cents` 之和），
   * 两个数不同源而屏幕上无从分辨。
   *
   * 这一发钉的是【措辞不许指回那条不存在的路】：改成"追加预算/提高预算"这类
   * 听起来像按钮的说法就会红。等 0045 §7 那一格被拍下来、真有了端点，
   * 这一发会挡住顺手改回去 —— 那时该改的是这一发本身（连同它上面这段理由），
   * 而不是悄悄把措辞换掉。
   */
  it("⭐ 钱那一档不许指回【屏幕上不存在的那一步】", () => {
    const b = line("t2", drv([budget]));
    // 不许出现"像是屏幕上能点"的说法。钉的是这一族而不是某一个词：
    // 只钉"追加预算"的话，换成"提高上限"/"加预算"照样溜过去（同 0013 §10.1 那条判据）。
    for (const fake of [
      "追加预算",
      "提高预算",
      "提高上限",
      "加预算",
      "放开预算",
      "点此",
    ]) {
      expect(b, fake).not.toContain(fake);
    }
    // 必须说清这一步【不在屏幕上】，并且给出此刻真有效的那一步的名字。
    expect(b).toContain("重启");
    expect(b).toContain("--task-limit-cents");
    // 两个"上限"必须可分辨：这一行的数来自命令行，不是 budgets 那一列。
    expect(b).toContain("命令行");
  });

  /**
   * ⭐ 到顶那一档也要说出【下一步】，而且不许指向一个不存在的旋钮。
   *
   * 起因是两件事撞在一起：
   *  ① 钱那一档我刚写过一发「不许指回屏幕上不存在的那一步」（上面那条），
   *     而到顶那一档【一发都没有】—— 它只说「第 3/3 次而它还在原格」，
   *     把选择丢回给读的人。同一屏上两档措辞不对称，而读的人没有理由自己想到。
   *  ② 探针（0050 §3）量到"到顶"这件事**不能靠把次数调大解决**：
   *     `--max-attempts` 这个参数【不存在】（`serve/config.ts` 认的 14 个参数里
   *     只有 `--task-limit-cents` 那一族，`driverMaxAttempts` 只能由装配层注入），
   *     而计数住在 append-only 的 events 里 —— 改不了也删不掉（删 = 篡改审计）。
   *     所以这一档最容易被顺手写成的那句「带更高的 --max-attempts 重启」
   *     恰好是钱那一档刚被我否掉的那颗【空按钮】的翻版。
   * 于是这一档说的是【查原因】而不是【调数字】，并且把"没有能放开的地方"说出来 ——
   * 少了后半句，读的人会继续找一个不存在的旋钮（同 §12.3 那条「命令行」是限定词的理由）。
   */
  it("⭐ 到顶那一档不许把人支去调一个【不存在的旋钮】", () => {
    const a = line("t1", drv([limit]));
    // 这一族说法在这里全是假的（没有 CLI 入口、审计不可改）。钉一族而不是一个词。
    for (const fake of [
      "--max-attempts",
      "提高次数",
      "加大次数",
      "放开次数",
      "重置次数",
      "清空记录",
    ]) {
      expect(a, fake).not.toContain(fake);
    }
    // 必须给出此刻真能做的那一步，并且说清那一档没有旋钮。
    expect(a).toContain("查");
    expect(a).toContain("没有能放开的地方");
    // 也不许把"追加预算"那一族借过来（这一档的原因不是钱，两档的下一步不同）。
    for (const wrong of ["追加预算", "上限（", "--task-limit-cents"]) {
      expect(a, wrong).not.toContain(wrong);
    }
  });

  it("⭐ 数字缺失时不拼出 undefined/3 那种东西", () => {
    const got = line(
      "t3",
      drv([
        {
          task_id: "t3",
          cause: "at_limit",
          attempts: null,
          max_attempts: null,
          since_ms: NOW - MIN,
        },
      ]),
    );
    expect(got).not.toContain("undefined");
    expect(got).not.toContain("null");
    expect(got).toContain("试到上限");
  });

  it("时刻缺失 ⇒ 一个破折号而不是 0 秒前 / NaN", () => {
    const got = line(
      "t4",
      drv([{ task_id: "t4", cause: "no_budget", since_ms: 0 }]),
    );
    expect(got).toContain("—");
    expect(got).not.toMatch(/NaN|undefined/u);
  });

  it("⭐ 响应里混进一个字符串 ⇒ 卡片上不许出现未转义的标签（转义只在插进 HTML 那一次）", () => {
    // 上面那条"不许出现实体"是同义反复（没有可转义的字符时它恒真），换一个能失败的：
    // driverLine 交回的是【纯文本】，转义由 taskCard 那句 esc 做。
    // 今天读侧那两列是 number（driver-status.ts 的 numOrNull 兜着），
    // 但渲块不该【假设】服务端一定兜 —— 假设一破，那一行就是渲染进程里的 HTML 注入点，
    // 而 §5.6.1 那条边界（渲块只经签名代理拿视图）挡的是数据面，挡不了这一行字符串。
    const evil = {
      task_id: "t5",
      cause: "at_limit",
      attempts: "<img src=x onerror=1>",
      max_attempts: 3,
      since_ms: NOW - MIN,
    };
    const rawLine = line("t5", drv([evil]));
    const card = (
      fns.taskCard as (a: unknown, b: boolean, c: boolean, d?: string) => string
    )(
      {
        id: "t5",
        title: "x",
        status: "IN_PROGRESS",
        assigned_role: "dev",
        updated_at: NOW,
        consumed_cents: 0,
        budget_cents: null,
      },
      false,
      false,
      rawLine,
    );
    expect(card).not.toContain("<img");
    expect(card).toContain("&lt;img");
  });

  it("⭐ 界面不许出现琥珀/颜色类名（这一格的严重度由横幅说，卡片只加一行 meta）", () => {
    // §19.2 里琥珀只表示"需要 CEO 决策"。"驱动器不再推这条了"多半要的是
    // 查原因或放预算，不是决策 —— 给它涂琥珀会把琥珀贬值（同 §7.4 预算暂停非琥珀）。
    const a = line("t1", drv([limit, budget]));
    const b = line("t2", drv([limit, budget]));
    for (const s of [a, b]) {
      expect(s).not.toMatch(/amber|decision|flag|statbad/u);
    }
  });

  it("同一份 driver 问两张卡 ⇒ 各拿各的那一行，不串台", () => {
    const both = drv([limit, budget]);
    expect(line("t1", both)).toContain("3/3");
    expect(line("t2", both)).toContain("$5.00");
  });
});

describe("filterReplayEntries —— §16.7 事件类型过滤（纯函数，服务端已带 action）", () => {
  const f = (entries: unknown[], filter: unknown): unknown[] =>
    (fns.filterReplayEntries as (a: unknown, b: unknown) => unknown[])(
      entries,
      filter,
    );
  const actions = (list: unknown[]): unknown[] =>
    list.map((e) => (e as { action: string }).action);
  const ev = (action: string, seq: number): Record<string, unknown> => ({
    action,
    seq,
    actor_id: "ceo",
    created_at: 1,
  });

  // 五种 action 各一发 + 一个不在任何规格组里的 state_change。※ 规格五组只映射十值枚举的子集。
  const SAMPLE = [
    ev("review_decision", 1),
    ev("tool_call", 2),
    ev("budget_consume", 3),
    ev("approval", 4),
    ev("meeting", 5),
    ev("state_change", 6),
  ];

  it("meeting 组只留 meeting（规格「会议」恰好是枚举里唯一一个同名值）", () => {
    expect(actions(f(SAMPLE, "meeting"))).toEqual(["meeting"]);
  });

  it("decide 组只留 review_decision（规格「审阅决定」）", () => {
    expect(actions(f(SAMPLE, "decide"))).toEqual(["review_decision"]);
  });

  it("tool 组只留 tool_call（规格「工具调用」）", () => {
    expect(actions(f(SAMPLE, "tool"))).toEqual(["tool_call"]);
  });

  it("budget 组只留 budget_consume（规格「预算」）", () => {
    expect(actions(f(SAMPLE, "budget"))).toEqual(["budget_consume"]);
  });

  it("approval 组只留 approval（规格「审批」）", () => {
    expect(actions(f(SAMPLE, "approval"))).toEqual(["approval"]);
  });

  it("⭐ 不认识的 filter 名 ⇒ 退回【不过滤】（界面上永远不会出现未知值，但防御不是装饰：filter 名是新 select 的 value，将来手滑多一个值不该让整个时间线变空网）", () => {
    expect(actions(f(SAMPLE, "bogus"))).toEqual(actions(SAMPLE));
  });

  it("⭐ 原数组不被改（过滤是投影，不是原地删）", () => {
    const before = actions(SAMPLE);
    f(SAMPLE, "decide");
    expect(actions(SAMPLE)).toEqual(before);
  });

  it("⭐ 不认识的 action 值保留在【全部】里（服务端未来新增枚举值不该被旧前端悄悄吃掉）", () => {
    const withUnknown = SAMPLE.concat(ev("future_action", 99));
    expect(actions(f(withUnknown, "all"))).toContain("future_action");
    // 未知名过滤也不该把它吞掉：它不属于任何组，但 fallback 到 all。
    expect(actions(f(withUnknown, "decide"))).toEqual(["review_decision"]);
  });
});

describe("checkpointBlock —— §16.7 断点状态快照（round327 后端解码的展示半）", () => {
  const f = (c: Record<string, unknown>): string =>
    String((fns.checkpointBlock as (x: unknown) => unknown)(c));
  const ck = (over: Record<string, unknown> = {}) => ({
    checkpoint_id: "ck-1",
    parent_checkpoint_id: null,
    checkpoint_ns: "",
    type: "json",
    checkpoint_bytes: 120,
    metadata_bytes: 0,
    decoded: true,
    summary: [
      { channel: "messages", valueJson: '[{"text":"hi"}]' },
      { channel: "task", valueJson: '{"id":"t1"}' },
    ],
    ...over,
  });

  it("decoded + summary 非空 ⇒ 每个通道一个 <details>，摘要可见", () => {
    const html = f(ck());
    expect(html).toContain("<details");
    expect(html).toContain("<summary>messages</summary>");
    expect(html).toContain("<summary>task</summary>");
    // valueJson 以纯文本进 <pre>，绝不当 HTML 注入。
    expect(html).toContain("&quot;text&quot;");
    expect(html).toContain("<pre");
  });

  it("⭐ decoded=false ⇒ 明说没解码，不显示假的空摘要", () => {
    const html = f(ck({ decoded: false, summary: null, type: "msgpack" }));
    expect(html).toContain("通道值未解码");
    expect(html).toContain("msgpack");
    expect(html).not.toContain("<details");
  });

  it("⭐ decoded=true 但 summary 为空（通道值解出来了但对象里没有 channel_values）⇒ 同降级", () => {
    const html = f(ck({ decoded: true, summary: null }));
    expect(html).toContain("通道值未解码");
    expect(html).not.toContain("<details");
  });

  it("⭐ checkpoint_id 先转义再进 HTML（checkpoint_id 是白名单键但界面上不该有注入口）", () => {
    const html = f(ck({ checkpoint_id: "<img src=x onerror=alert(1)>" }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("空输入 ⇒ 空串（不制造一个假断点块）", () => {
    expect(f({})).toBe("");
  });
});

/* ═════════ §9.4 批量批准 / 批量打回（round330）═════════
 * 分工口径：「能不能批量」的判据【只在服务端】（POST /approvals/batch 的
 * 422 混类型 / 404 缺 id / reject 缺 note）。这边测的只有【选择集算术】：
 * 谁进请求体（pending ∩ 勾选）与 note 键的有无穷。
 * ⚠ 这里【没有】「类型是否齐一」的用例，因为 app.js 里没有那个预检 ——
 * 拆它的理由写在 app.js 批量那一节的注释里（一句话：一份会拦错东西的客户端
 * 判据比没有更贵，而混类型的答复由服务端的 422 带着 types 列表来说）。
 * 混类型这件事在本文件的分母 = 下面 approvalCard 那两发（不给非 pending 卡
 * 勾选框）+ hub 侧 batch-route.test.ts 那一发 422。
 */
describe("batchRequestBody —— §9.4 批量选择集（判据在服务端，这边只算选择）", () => {
  const ap = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    status: "pending",
    approval_type: "escalation",
    summary: "s",
    ...over,
  });
  const body = (
    cards: unknown[],
    ids: unknown[],
    resume: string,
    note?: string,
  ) =>
    (
      fns.batchRequestBody as (
        a: unknown,
        b: unknown,
        c: string,
        d?: string,
      ) => Record<string, unknown>
    )(cards, ids, resume, note);

  it("⭐ 选中里的非 pending 卡被剔除（勾选框本来就不给它，这里是第二道）", () => {
    const cards = [ap({ id: "keep" }), ap({ id: "gone", status: "approved" })];
    expect(
      body(cards, ["keep", "gone"], "approve", undefined).approval_ids,
    ).toEqual(["keep"]);
  });

  it("note 为空 ⇒ 请求体里根本没有 note 这个键（契约里它是可选键；reject 缺 note 的 422 归服务端说，前端不替它圆场）", () => {
    const cards = [ap()];
    for (const n of [undefined, "", "   "]) {
      const b = body(cards, ["a1"], "reject_with_comment", n);
      expect(Object.hasOwn(b, "note")).toBe(false);
    }
  });

  it("note 有值 ⇒ 带上，且去掉首尾空白", () => {
    const b = body([ap()], ["a1"], "reject_with_comment", "  先补测试再来  ");
    expect(b.note).toBe("先补测试再来");
  });

  it("⭐ 空选择 ⇒ approval_ids: []（中性值；发不发由绑定层裁），null/缺项输入不抛", () => {
    const b = body([], [], "approve", undefined);
    expect(b).toEqual({ approval_ids: [], resume: "approve" });
    expect(
      body(
        undefined as unknown as unknown[],
        undefined as unknown as unknown[],
        "approve",
        undefined,
      ).approval_ids,
    ).toEqual([]);
  });

  it("勾了但不在卡片列表里的 id ⇒ 不凭空造进请求体（选择集是【列表 ∩ 勾选】，不是勾选）", () => {
    expect(
      body([ap()], ["a1", "ghost-id"], "approve", undefined).approval_ids,
    ).toEqual(["a1"]);
  });

  it("⭐ 请求体【不 esc】：出网的是 JSON 载荷，转义会改坏 id 本身", () => {
    // 这一发钉的是「转义只属于 HTML，不属于数据」那条边界。若哪天有人把 esc
    // 顺手加进请求体拼装，一条真实存在的记录会被服务端 404 掉。
    const id = 'a"1<b>';
    expect(body([ap({ id })], [id], "approve", undefined).approval_ids).toEqual(
      [id],
    );
  });
});

describe("approvalCard 的批量勾选框 —— 只有 pending 卡能被勾进批量", () => {
  const card = (over: Record<string, unknown> = {}) =>
    (
      fns.approvalCard as (
        a: unknown,
        n: number,
        c: boolean,
        d: boolean,
      ) => string
    )(
      {
        id: "a1",
        status: "pending",
        approval_type: "escalation",
        summary: "s",
        created_at: 1,
        ...over,
      },
      2,
      false,
      false,
    );

  it("pending ⇒ 有 data-batch-pick 勾选框，且卡片带 data-approval-id", () => {
    const html = card();
    expect(html).toContain("data-batch-pick");
    expect(html).toContain('data-approval-id="a1"');
  });

  it("⭐ 已决定的卡没有勾选框（批量不参与），但 data-approval-id 仍在（它是定位手段，与能否勾选无关）", () => {
    for (const status of ["approved", "rejected", "deferred"]) {
      const html = card({ status });
      expect(html, status).not.toContain("data-batch-pick");
      expect(html, status).toContain('data-approval-id="a1"');
    }
  });

  it("id 进属性一律 esc（卡片 id 是我们发的 UUID，但界面不许留注入口）", () => {
    const html = card({ id: 'x" onfocus="alert(1)' });
    expect(html).not.toContain('id="x" onfocus="alert(1)"');
    expect(html).toContain("&quot;");
  });
});

/* ───────── round336：重渲染后的焦点落点（Task 2.6「键盘可完成全部审批操作」） ─────────
 * 为什么这一发值得单列一节：它测的是【恢复焦点这件事的决策】，不是 DOM。
 * 决策错的方向有两个，都不报错、都只在人手上出现：
 *  ① 抢焦点（prev 为空也硬落一格）⇒ 用户正在地址栏里打字，一帧数据到了，
 *     焦点被拽进列表。屏幕上没有任何一行说这事发生过。
 *  ② 不恢复（prev 没了就退回 body）⇒ 键盘连批时每批一张要重新 Tab 一屏，
 *     那句"≤20 秒"就是这么没的。
 * 两个方向都不是"崩"，所以只靠看代码判不住。
 */
describe("focusTargetId —— 重渲染后焦点该落到哪一格", () => {
  const f = (prev: unknown, prevIds: unknown, nextIds: unknown) =>
    (fns.focusTargetId as (a: unknown, b: unknown, c: unknown) => unknown)(
      prev,
      prevIds,
      nextIds,
    );

  it("⭐ prev 为空 ⇒ null：没有人在这一域里，就不许把焦点抢过来", () => {
    // 这一发拦的是最顺手的那版实现（`nextIds[0]`）。它在测试里永远绿，
    // 因为"当时没人在看"这种前提不会出现在断言里。
    expect(f(null, ["a", "b"], ["a", "b"])).toBeNull();
    expect(f(undefined, ["a", "b"], ["a", "b"])).toBeNull();
    expect(f("", ["a", "b"], ["a", "b"])).toBeNull();
  });

  it("prev 还在新名单里 ⇒ 原地", () => {
    expect(f("b", ["a", "b", "c"], ["a", "b", "c"])).toBe("b");
  });

  it("⭐ prev 被批掉了 ⇒ 顶上来那一张（收件箱连批时焦点不丢）", () => {
    // GET /approvals 是 pending-only（query.ts 那句 WHERE status = ?），
    // 所以批完一张它【真的从名单里消失】，这一支是主路径不是边角。
    expect(f("b", ["a", "b", "c"], ["a", "c"])).toBe("c");
    // 批掉最后一张 ⇒ 落到新的末位，不许 undefined、也不许跳回第一张。
    expect(f("c", ["a", "b", "c"], ["a", "b"])).toBe("b");
  });

  it("⭐ prev 在新旧名单里都查不到 ⇒ null（位置都不知道就不猜）", () => {
    expect(f("zz", ["a", "b"], ["a", "b"])).toBeNull();
  });

  it("名单空 / 形状不对 ⇒ null，不拿 undefined 当「没有下一张」", () => {
    expect(f("a", ["a"], [])).toBeNull();
    expect(f("a", null, ["a"])).toBeNull();
    expect(f("a", ["a"], "不是数组")).toBeNull();
  });

  it("⭐ 正向对照：这一节真的在分辨（写死了也红）", () => {
    // 如果上面那五条其实由一个恒返回定值的实现也能过，这一节就是装饰。
    // 同一组输入下三个不同答案，逐格互不相同。
    const got = [
      f(null, ["a"], ["a"]),
      f("a", ["a", "b"], ["a", "b"]),
      f("a", ["a", "b"], ["b"]),
    ];
    expect(got).toEqual([null, "a", "b"]);
    expect(new Set(got.map(String)).size).toBe(3);
  });
});

describe("卡片上的键盘锚点（纯标记层）", () => {
  const tk = {
    id: "task-1",
    title: "做登录模块",
    status: "REVIEWING",
    assigned_role: "dev",
    updated_at: 1,
    consumed_cents: 1,
    budget_cents: null,
  };
  const ap = (over: Record<string, unknown> = {}) => ({
    id: "a1",
    status: "pending",
    approval_type: "escalation",
    summary: "s",
    created_at: 1,
    ...over,
  });

  it("⭐ 任务卡可聚焦（tabindex=0 + role）：没有它，看板里【只有鼠标】能打开详情", () => {
    const html = (
      fns.taskCard as (a: unknown, b: boolean, c: boolean) => string
    )(tk, false, false);
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('role="button"');
    // aria-label 必须是正面【没有】的那句话，不复读标题（读屏器本来就会念内容）。
    expect(html).toContain('aria-label="打开任务详情"');
  });

  it("⭐ 审批卡带 tabindex=-1：程序化聚焦得有着落，但不进 Tab 序列", () => {
    const html = (
      fns.approvalCard as (
        a: unknown,
        n: number,
        c: boolean,
        d: boolean,
      ) => string
    )(ap(), 2, true, true);
    expect(html).toContain('tabindex="-1"');
    // 反向：不许顺手写成 0 —— 那会把卡根插进 Tab 序列，把人从"决定"按钮上甩开。
    expect(html).not.toContain('tabindex="0"');
  });
});

/* ───────── 参数快照那一格（§9.2 第二行 / §16.5「默认折叠，展开显示参数快照」） ─────────
 * 这一节测的是【一行参数在屏幕上说什么】，而它此前在任何界面上都不存在：
 * GET /approvals 刻意不带 parameters，所以 §9.2 第二行那五项没有落点。
 * `GET /approvals/:id` 落地之后，paramSnapshotLines 是它唯一的落点 ——
 * 落点错了不会崩，只会让 CEO 在一屏缺信息的字上批钱。那种错只在这里判得住。
 */
describe("paramSnapshotLines —— §9.2 第二行的内容", () => {
  type Row = [string, string];
  const f = (p: unknown): Row[] =>
    (fns.paramSnapshotLines as (x: unknown) => Row[])(p);
  const want = (p: unknown, label: string): string => {
    const hit = f(p).find((r) => r[0] === label);
    expect(
      hit,
      `没有「${label}」这一行；实际 ${JSON.stringify(f(p))}`,
    ).toBeDefined();
    return String(hit?.[1]);
  };
  // 契约 approvalCardDraftSchema.parameters 那六键填齐的样子（gates.ts）。
  // 真实数据确实长这样：dispatch.ts / seat-card.ts / escalation.ts 建卡时六个都给。
  const full = {
    amount_cents: 1250,
    impact_scope: "生产库",
    irreversible: true,
    recommendation: "上线",
    recommendation_is_not_decision: true,
    timeout_behavior: "auto_reject",
  };

  it("⭐ 未知键一个都不许悄悄丢掉", () => {
    // 这一节的主张，不是兜底。白名单那一版更短更好看，而它的失效方向是本仓最贵的：
    // 将来往 parameters 里加一格，界面【一个字都不变】，于是「这一格有而界面不认识」
    // 和「这张卡没有那一格」在屏幕上长得一样，而没有任何东西会红。
    // 喂的 escalation 不是编的：它是 parametersFor（cards.ts）在【落库那一步】
    // 并进去的键 —— 契约 .strict() 收不下它，所以它天然不在任何白名单里。
    const rows = f({
      impact_scope: "x",
      escalation: { reason: "跨两个角色", also: ["budget"] },
    });
    const labels = rows.map((r) => r[0]);
    expect(labels).toContain("escalation");
    expect(
      want({ escalation: { reason: "跨两个角色" } }, "escalation"),
    ).toContain("跨两个角色");
    // 反向对照（同一发里）：未知键【确实】和已知键走不同的路 —— 已知键换成了中文标签。
    expect(labels).toContain("影响范围");
    expect(labels).not.toContain("impact_scope");
  });

  it("⭐ 四个「没有」是四种形状，两两不许合并", () => {
    // 这一发是这一节的骨架。合并任何一种，都是把一种故障伪装成一种常态：
    //  ① null（服务端 parametersObjectOf 判「库里那段不是 JSON 对象」）⇒ 说【读不出来】，
    //     那是在指写入方；说成"为空"就等于宣布这张卡本来没参数，没人会去查。
    //  ② 脏形状（数组 / 标量 / 字符串）在服务端已经折成 null 了；界面对【没折干净的】
    //     同一族形状仍然自己判一遍 —— 因为渲染层不该假设上游一定折过。
    //  ③ undefined / 键根本没带 ⇒ 读不出来：列表响应里 parameters 这个键【不存在】，
    //     把"没带"显示成"为空"就是 §9.2 那一行整个消失而屏幕上看不出来。
    //  ④ 空对象 ⇒ 为空：读出来了、里面确实什么都没有。这是唯一一种合法的"什么都没有"。
    expect(f(null)).toEqual([
      ["参数快照", "读不出来（库里那段不是 JSON 对象）"],
    ]);
    for (const bad of [[1, 2], "一段文本", 7, true]) {
      expect(f(bad), String(bad)).toEqual([
        ["参数快照", "读不出来（库里那段不是 JSON 对象）"],
      ]);
    }
    expect(f(undefined)).toEqual([
      ["参数快照", "读不出来（库里那段不是 JSON 对象）"],
    ]);
    expect(f({})).toEqual([["参数快照", "为空（这张卡没带任何参数）"]]);
    // ① 与 ④ 必须不同句 —— 上面三条各自成立的话这条自动成立，单独写出来是因为
    // 它是这一格里最容易被"统一成一句更简洁的提示"改掉的一条。
    expect(f(null)[0]?.[1]).not.toBe(f({})[0]?.[1]);
  });

  it("契约那五项各有落点，且逐项算得对", () => {
    expect(want(full, "金额")).toBe("$12.50");
    expect(want(full, "影响范围")).toBe("生产库");
    expect(want(full, "不可逆性")).toBe("不可逆");
    expect(want(full, "推荐动作")).toBe("上线（推荐，非决定）");
    expect(want(full, "超时行为")).toBe("auto_reject");
    // 五项之外不多出行：标志位被并进「推荐」那一行了。
    expect(f(full)).toHaveLength(5);
  });

  it("⭐ 金额走全页【唯一】那份 money()，且是【三态】—— 坏金额不许读成 $0.00", () => {
    // 三档常规值钉的是【与 money() 口径逐位一致】：这一格不许自己再写一遍除法
    // （第二份抄件漂了的时候，漂的那个数是 CEO 用来批钱的数）。
    expect(want({ amount_cents: 1250 }, "金额")).toBe("$12.50");
    expect(want({ amount_cents: 1 }, "金额")).toBe("$0.01");
    expect(want({ amount_cents: 0 }, "金额")).toBe("$0.00");
    expect(want({ amount_cents: 123456789 }, "金额")).toBe("$1234567.89");
    // 非有限数（脏库 / 旁路插入）⇒ 不许是任何美元形状。这一发的起因是我原本写的
    // `money(c)`：money 里是 Number(c ?? 0)，于是 null / undefined ⇒ "$0.00"、
    // "1250" ⇒ "$12.50" —— 全都"看着正常"。而「金额没带」与「金额是 0」在收件箱里
    // 会被批成两种东西，$0.00 是一笔真实存在、可以被批掉的金额。
    for (const bad of [null, undefined, "1250", {}, NaN]) {
      const got = want({ amount_cents: bad }, "金额");
      expect(got, String(bad)).not.toMatch(/^\$/u);
      expect(got, String(bad)).toContain("读不出来");
    }
    // 0 与「读不出来」必须不同形 —— 上面那组只在「不许是美元」上成立，这一条
    // 才钉住"零仍然是零"（不许为了安全把 0 也归进读不出来那一档）。
    expect(want({ amount_cents: 0 }, "金额")).not.toBe(
      want({ amount_cents: null }, "金额"),
    );
  });

  it("⭐ 不可逆性是【三态】：脏值不许读成「可逆」", () => {
    expect(want({ irreversible: true }, "不可逆性")).toBe("不可逆");
    expect(want({ irreversible: false }, "不可逆性")).toBe("可逆");
    // §9.1 的整条 R3（不可逆永不自动通过）就建在这一格上。写成
    // `v ? "不可逆" : "可逆"` 的话，字符串 "true"、null、0 全被判成"可逆" ——
    // 那是把「读不出来」显示成「这一件没风险」，而屏幕上不会有任何东西说它发生过。
    expect(want({ irreversible: "true" }, "不可逆性")).toContain("读不出来");
    expect(want({ irreversible: null }, "不可逆性")).toContain("读不出来");
    expect(want({ irreversible: 1 }, "不可逆性")).not.toBe("可逆");
  });

  it("⭐「推荐，非决定」那个标注只在标志位为 true 时并进那一行", () => {
    // 标志位是契约里的 literal(true)（gates.ts 那句：漏标不是风格问题，是让 CEO
    // 把推荐读成结论）。这一发钉两件事：
    //  ① true ⇒ 标注在，且标志位【被消费】不再单独成行（否则同一屏出现两次）；
    //  ② 缺省 / false ⇒ 标注【不在】，而标志位作为未知键原样露出来 ——
    //     一个坏掉的标注必须是可见的，不能被静默当成"没有标注"。
    const marked = f({
      recommendation: "上线",
      recommendation_is_not_decision: true,
    });
    expect(marked.map((r) => r[0])).not.toContain(
      "recommendation_is_not_decision",
    );
    expect(
      want(
        { recommendation: "上线", recommendation_is_not_decision: true },
        "推荐动作",
      ),
    ).toContain("推荐，非决定");
    const unmarked = f({ recommendation: "上线" });
    expect(want({ recommendation: "上线" }, "推荐动作")).toBe("上线");
    expect(unmarked.map((r) => r[0])).not.toContain(
      "recommendation_is_not_decision",
    );
    expect(
      want(
        { recommendation: "上线", recommendation_is_not_decision: false },
        "推荐动作",
      ),
    ).not.toContain("推荐，非决定");
    expect(
      f({ recommendation: "上线", recommendation_is_not_decision: false }).map(
        (r) => r[0],
      ),
    ).toContain("recommendation_is_not_decision");
  });

  it("超时行为只【显示】，不显示倒数", () => {
    // 全仓没有超时执行者之外的"还剩多久"权威（approvalViewSchema ② 那段口径），
    // 而一个会走到零的倒计时读起来像系统坏了。所以这里连一个时间字段都不该出现。
    const rows = f({ timeout_behavior: "auto_approve" });
    expect(rows).toEqual([["超时行为", "auto_approve"]]);
  });

  it("只给一部分键时，缺的那几项【不凭空补行】", () => {
    // 补一行「金额：$0.00」是把"没带金额"说成"金额为 0"—— 那是一笔会被批掉的零。
    const rows = f({ impact_scope: "只有一格" });
    expect(rows.map((r) => r[0])).toEqual(["影响范围"]);
  });
});

describe("paramSnapshotHtml —— 那一格的形状（等宽 + 左缩进，不画框线）", () => {
  const h = (p: unknown): string =>
    (fns.paramSnapshotHtml as (x: unknown) => string)(p);

  it("⭐ 每一行带 .mono（§9.2/Task 2.6 那句「等宽字体」），且整个块【不画框线】", () => {
    const got = h({ amount_cents: 1250, impact_scope: "生产库" });
    expect(got).toContain('class="admin-snap"');
    expect(got.split('class="admin-mono"').length - 1).toBe(2); // 两行 ⇒ 两个 .mono
    // 框线由 CSS 类给（.snap 只有 padding-left，写在 index.html 那条注释旁边）；
    // 渲块这边【不许】顺手加 border/style —— 那是 §19.4 那一族（层级靠缩进与色阶，不靠线）。
    expect(got).not.toContain("border");
    expect(got).not.toContain("style=");
    // 也不是 <pre>：pre 带着 background + border-radius，那就是画了一个框。
    expect(got).not.toContain("<pre");
  });

  it("「读不出来 / 为空」那一行用 .snap-none（它是这一格的主角，不是脚注）", () => {
    expect(h(null)).toContain('class="admin-snap-none admin-meta"');
    expect(h({})).toContain('class="admin-snap-none admin-meta"');
    // 反向：正常参数不许落到 snap-none 那个类上（否则正常卡长得像出错了）。
    expect(h({ impact_scope: "x" })).not.toContain("admin-snap-none");
  });

  it("⭐ 标签与值都过 esc：参数是从库里读出来的文本，不是可信标记", () => {
    // impact_scope 在契约里只是 z.string().min(1)（charter.ts 把提案原文折进这一格），
    // 所以它的长度与内容都不受控。这一发用真值形状：带尖括号的提案原文。
    const got = h({ impact_scope: '<img src=x onerror="alert(1)">' });
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
    // 未知键的【键名】也要转义（键名同样来自库里的 JSON）。
    expect(h({ "<b>k</b>": 1 })).not.toContain("<b>k</b>");
  });
});

/* ═════════════ 审阅独立性那一格（O4） ═════════════
 * 这一组测的是【念数那一半】：数从服务端来，界面只负责把它说成一句人话。
 * 判据本身（谁和谁同族）不在这里测 —— 那在 hub 的 review-preview.test.ts，
 * 而「渲块里不许出现那份判据」由 renderer-criteria.test.ts 扫源码守。
 * 两边各守一半：跑对了数 ≠ 渲块里没有第二份判据，反之亦然。
 */
describe("reviewIndependenceBand —— 只念服务端算好的数", () => {
  const h = (p: unknown): string =>
    (fns.reviewIndependenceBand as (x: unknown) => string)(p);
  const prev = (o: Record<string, unknown>) => ({
    roles: 4,
    pairs_total: 6,
    pairs_ok: 6,
    pairs_same_family: 0,
    pairs_refused: 0,
    always_needs_approval: false,
    any_refused: false,
    blocked: [],
    ...o,
  });

  it("⭐ 这一格不发琥珀（§19.2：琥珀只留给「此刻要你决策」，组织看板上的这一条是陈述）", () => {
    // 正向对照：同一份 app.js 里【真的有人】发琥珀 —— approvalCard 那一格用 .need
    // （index.html `.need` = 琥珀左边框）。没有这一发，下面那串 not.toContain
    // 可能只是在念「app.js 里根本没有琥珀这个词」这条与本判据无关的事实。
    const amberCard = (
      fns.approvalCard as (
        a: unknown,
        n: number,
        c: boolean,
        d: boolean,
      ) => string
    )(
      {
        id: "a1",
        status: "pending",
        approval_type: "escalation",
        summary: "s",
        task_id: "t1",
        created_at: 1,
      },
      2,
      true,
      true,
    );
    expect(amberCard).toContain("need");

    for (const p of [
      null,
      prev({}),
      prev({ pairs_total: 0, pairs_ok: 0, roles: 1 }),
      prev({
        pairs_ok: 0,
        pairs_same_family: 6,
        always_needs_approval: true,
        blocked: [
          {
            producer: "a",
            reviewer: "b",
            code: "same_model_family",
            reason: "r",
          },
        ],
      }),
    ]) {
      const got = h(p);
      // .need 是琥珀那一档，.err 是硬失败 —— 两个都不该出现在这一格。
      expect(got).not.toContain('class="admin-banner admin-err"');
      expect(got).not.toContain("need");
      expect(got).not.toContain("flag");
    }
  });

  it("⭐ 读数字【跟着输入变】：两张贴图给出两个不同的数（渲块里没藏常数）", () => {
    const a = h(prev({ roles: 4, pairs_total: 6 }));
    const b = h(
      prev({ roles: 7, pairs_total: 21, pairs_ok: 19, pairs_same_family: 2 }),
    );
    expect(a).toContain("4 个角色 = 6 个角色配对");
    expect(b).toContain("7 个角色 = 21 个角色配对");
    expect(a).not.toContain("21");
    expect(b).toContain("2 个同族");
    expect(a).not.toContain("个同族");
  });

  it("⭐ 读数【缺失】与「算出来分母是 0」是两句话（不许合并）", () => {
    const missing = h(undefined);
    const zero = h(prev({ roles: 1, pairs_total: 0, pairs_ok: 0 }));
    expect(missing).toContain("没返回");
    // 分母 0 那一支说的是「算不出」，不是「这台 Hub 没这一格」。
    expect(zero).toContain("算不出");
    expect(missing).not.toContain("算不出这一格");
    expect(zero).not.toContain("没返回");
    // 而两者都【不许】被读成「一切正常」：不许出现「没问题 / 不需要批」这类结论。
    for (const got of [missing, zero]) {
      expect(got).not.toContain("不需要批");
      expect(got).not.toContain("没问题");
    }
  });

  it("⭐ always_needs_approval=true ⇒ 说的是「每一次」，且给出的修法是换家族而不是习惯它", () => {
    const got = h(
      prev({
        pairs_ok: 0,
        pairs_same_family: 6,
        always_needs_approval: true,
        blocked: [
          {
            producer: "dev",
            reviewer: "test",
            code: "same_model_family",
            reason: "同族",
          },
        ],
      }),
    );
    expect(got).toContain("每次审阅都要你显式批一遍");
    expect(got).toContain("换一家模型");
    // 「偶尔」那一格必须被明确否掉 —— O4 那句原文反对的就是这个读法。
    expect(got).toContain("不是偶尔要点的例外");
  });

  it("⭐ 同族与「判不出家族」两种修法【分别措辞】，不压成一句「会被拦」", () => {
    const same = h(prev({ pairs_ok: 3, pairs_same_family: 3 }));
    const refused = h(
      prev({
        pairs_ok: 3,
        pairs_same_family: 0,
        pairs_refused: 3,
        any_refused: true,
      }),
    );
    const both = h(
      prev({
        pairs_ok: 0,
        pairs_same_family: 3,
        pairs_refused: 3,
        any_refused: true,
      }),
    );
    expect(same).toContain("要你批准");
    expect(same).not.toContain("批准点不过去");
    expect(refused).toContain("批准点不过去");
    expect(refused).toContain("model_family");
    expect(refused).not.toContain("要你批准");
    // 同时存在时两个都在，且两个数各归各的（合并成一档会在这里红）。
    expect(both).toContain("3 个同族");
    expect(both).toContain("3 个判不出家族");
  });

  it("⭐ 全绿那一支不发警告色，也不许出现「同族」字样（否则干净图长得像出事了）", () => {
    const clean = h(prev({}));
    const dirty = h(prev({ pairs_ok: 3, pairs_same_family: 3 }));
    // 正向对照在先：`banner("warn", …)` 真的会产出 `class="admin-banner admin-warn"`，
    // 所以下面那条 not.toContain 是【有刻度】的 —— 若 banner 根本不加类名，
    // 那条否定会恒真（本仓那条「一条不认违例的守卫比没有守卫更坏」）。
    expect(dirty).toContain('class="admin-banner admin-warn"');
    expect(clean).not.toContain("admin-warn");
    expect(clean).toContain('class="admin-banner "');
    expect(clean).toContain("两两不同族");
    expect(clean).not.toContain("要你批准");
  });

  it("被拦的配对逐条列出，原因用【服务端正本原话】逐字带出", () => {
    const reason =
      "审阅者与产出者同属模型家族 [opus]（§5.9 第 1 条 / §24 风险 1）。";
    const got = h(
      prev({
        pairs_ok: 5,
        pairs_same_family: 1,
        blocked: [
          {
            producer: "ceo",
            reviewer: "tech_director",
            code: "same_model_family",
            reason,
          },
        ],
      }),
    );
    expect(got).toContain("ceo ⇄ tech_director");
    expect(got).toContain("same_model_family");
    // 原话：整句在，且没被改写成更短的概括。
    expect(got).toContain("同属模型家族 [opus]");
  });

  it("⭐ 角色名与原因都过 esc（role_id 是库里读的文本，原因也是拼了家族名的字符串）", () => {
    const got = h(
      prev({
        pairs_ok: 0,
        pairs_same_family: 1,
        blocked: [
          {
            producer: '<img src=x onerror="alert(1)">',
            reviewer: "b",
            code: "same_model_family",
            reason: "<script>bad</script>",
          },
        ],
      }),
    );
    expect(got).not.toContain("<img");
    expect(got).not.toContain("<script>");
    expect(got).toContain("&lt;img");
  });

  it("⭐ 主语恒是「配对」：任何数字都不许直接挂着「次审阅」（分母不是预测，见函数头）", () => {
    const cases = [
      prev({}),
      prev({
        pairs_ok: 0,
        pairs_same_family: 6,
        always_needs_approval: true,
        blocked: [],
      }),
      prev({ roles: 0, pairs_total: 0, pairs_ok: 0 }),
      prev({ pairs_ok: 3, pairs_same_family: 3 }),
    ];
    for (const p of cases) {
      const got = h(p);
      expect(got).not.toMatch(/\d+\s*次审阅/u);
      expect(got).not.toContain("审阅次数");
      expect(got).toContain("配对");
    }
  });

  it("⭐ 那条修法是【读 any_refused 这条结论】，不是自己从计数推（两发互相区分）", () => {
    // 矛盾输入是唯一能分辨「读结论」与「自己推」的输入：
    //  数说 3 个 refused，结论说没有 ⇒ 自己推的会印出「批准点不过去」，读结论的不印。
    const derivedWouldSay = h(
      prev({
        pairs_ok: 3,
        pairs_same_family: 0,
        pairs_refused: 3,
        any_refused: false,
      }),
    );
    expect(derivedWouldSay).not.toContain("批准点不过去");
    // 反向：结论说有、数没给（0）⇒ 读结论的仍然要说出来（数不是判据，结论才是）。
    const readsFlag = h(
      prev({
        pairs_ok: 6,
        pairs_same_family: 0,
        pairs_refused: 0,
        any_refused: true,
      }),
    );
    expect(readsFlag).toContain("批准点不过去");
    // 正常那一发两半都有，证明上面两条不是"永远不印 / 永远印"。
    const both = h(
      prev({
        pairs_ok: 3,
        pairs_same_family: 3,
        pairs_refused: 3,
        any_refused: true,
      }),
    );
    expect(both).toContain("批准点不过去");
    expect(both).toContain("要你批准");
  });

  it("blocked 缺失或不是数组 ⇒ 不抛（库里/网络另一端的形状不受本文件控制）", () => {
    for (const p of [
      prev({ blocked: undefined, pairs_same_family: 2, pairs_ok: 4 }),
      prev({ blocked: null, pairs_same_family: 2, pairs_ok: 4 }),
      prev({ blocked: "x", pairs_same_family: 2, pairs_ok: 4 }),
    ]) {
      expect(() => h(p)).not.toThrow();
      expect(h(p)).toContain("2 个同族");
    }
    // 正向对照：这一发真的在测【那道 Array.isArray 闸门】—— 上面喂的那三种
    // `blocked` 替身里，"x" 若真被当成数组用（`.map`）就会炸。这里钉的正是
    // 「它确实不是数组」，所以那一发红的是守卫、不是输入挑得宽容。
    expect(
      typeof (prev({ blocked: "x" }).blocked as { map?: unknown }).map,
    ).toBe("undefined");
  });
});

describe("edgeChip —— 一条委派边的门控状态（round339：那个布尔一直在库里，屏幕以前不读）", () => {
  const h = (e: unknown): string => (fns.edgeChip as (x: unknown) => string)(e);

  it("⭐ 三态各自说得出话：true / false / 读不到，三种是三种输出", () => {
    const on = h({ from: "dev", to: "qa", review_gate: true });
    const off = h({ from: "dev", to: "qa", review_gate: false });
    const absent = h({ from: "dev", to: "qa" });
    expect(on).toContain("已门控");
    expect(off).toContain("无门控");
    expect(absent).toContain("门控未知");
    // 三态互不相同 ⇒ 「不许把三态并成两态」有分辨力，不是三条都在念同一句话。
    expect(on).not.toBe(off);
    expect(off).not.toBe(absent);
    expect(on).not.toBe(absent);
  });

  it("⭐ 「读不到」不许说成「没门控」（两种情况的处置动作相反）", () => {
    // 这是这一格里唯一那条【会伤人】的合并：review_gate 是 schema 必填布尔，
    // 所以 undefined 只可能是「对端不是这台装配」；把它印成「无门控」会让 CEO
    // 去改一条根本不存在的边，而真正该查的是装配本身。
    expect(h({ from: "a", to: "b" })).not.toContain("无门控");
    // 正向对照：同一把尺子在【真 false】上抓得到那三个字，否则上面那条
    // not.toContain 只是在念「本函数从来不写这三个字」这条与判据无关的事实。
    expect(h({ from: "a", to: "b", review_gate: false })).toContain("无门控");
  });

  it("⭐ 端点【照原样】出：两侧角色名都来自入参，且走 esc", () => {
    const got = h({ from: "dev", to: "qa", review_gate: true });
    expect(got).toContain("dev");
    expect(got).toContain("qa");
    const evil = h({
      from: "<img src=x onerror=alert(1)>",
      to: "qa",
      review_gate: true,
    });
    expect(evil).not.toContain("<img");
    expect(evil).toContain("&lt;img");
    // 正向对照走【输入→输出的往返】，不走字面量：拿一个只含特殊字符的 role_id
    // 进去，出来的必须是转义后的形状。把 esc() 摘掉这一发立刻红（输出会是裸 `&`）。
    // ⚠ 我第一版写的是 `expect("<img src=x>").not.toContain("&lt;")` —— 那是【恒真】：
    // 一个字面量里永远不会有实体，它与本函数做没做转义无关（同一类假对照本文件记过）。
    expect(h({ from: "a&b", to: "c", review_gate: true })).toContain("a&amp;b");
  });

  it("⭐ 这一格【不重算判据】：只读那一个布尔，不预测会不会被拒", () => {
    // 门控 false 的时候服务端确实会以 missing_review_gate 拒 —— 但那句话
    // 【不属于这里】：写进来就是第二条判据（0042），而服务端改判据时这边不会红。
    //
    // ⚠ 禁的是【预测/结论那几种说法】，不禁「拒」这一个字：单字那一刀是宽刃，
    // 会把将来一句真话（例如照抄服务端 code 原文）一起削掉 —— 本文件 §⑤ 记过
    // 两次同一件事：一刀「不许出现 model_family 子串」削掉的是唯一那句可执行的修法。
    // 所以这里逐短语禁，并且下面配一条【真输出】的阳性对照。
    for (const e of [
      { from: "a", to: "b", review_gate: false },
      { from: "a", to: "b", review_gate: true },
      { from: "a", to: "b" },
    ]) {
      const got = h(e);
      for (const forbidden of [
        "会被拒",
        "会被拦",
        "不合规",
        "missing_review_gate",
      ]) {
        expect(got, forbidden).not.toContain(forbidden);
      }
    }
    // 阳性对照：「会被拦」这三个字在本文件里【确实有人输出】—— 同页面的
    // reviewIndependenceBand 会把服务端算好的 blocked 配对逐条列出，那一句的原文里有它。
    // 没有这一发，上面那串 not.toContain 可能只是在念「app.js 不写这三个字」。
    // 两者待遇不同的理由不是手滑：那边读的是【服务端算的判断】，这边什么判断都没读。
    const band = (fns.reviewIndependenceBand as (x: unknown) => string)({
      roles: 3,
      pairs_total: 3,
      pairs_ok: 2,
      pairs_same_family: 0,
      pairs_refused: 1,
      always_needs_approval: false,
      any_refused: true,
      blocked: [
        {
          producer: "a",
          reviewer: "b",
          code: "unknown_model_family",
          reason: "r",
        },
      ],
    });
    expect(band).toContain("会被拦");
  });

  it("⭐ 端点缺失是【图坏了】，不在这一格静默降级", () => {
    // 这一发钉的是函数头那句【态度】：只有 review_gate 那一个字段降级成三态，
    // 整条边缺失要抛。为什么值得单独一发：这里若也降级，屏幕会出现一枚
    // 「 → · 门控未知」的 chip —— 那是把「图读不到」画成「图上有一条空边」，
    // 与本轮刚修掉的那条假话同族（把【缺失】说成【一个读数】）。
    expect(() => h(null)).toThrow();
    expect(() => h(undefined)).toThrow();
    // 正向对照：同一条边【只缺门控】时不抛，走三态里那一格 ——
    // 否则上面两条只是"这个函数对任何输入都抛"。
    expect(() => h({ from: "a", to: "b" })).not.toThrow();
    expect(h({ from: "a", to: "b" })).toContain("门控未知");
  });

  it("⭐ 形状：还是一枚 .edge chip（CSS 只有那一条规则，没有变体可挂）", () => {
    // 这一发钉的是【没有新增视觉档位】：§19.2 那张色表里没有「门控关着」那一档，
    // 所以门控状态是 chip 上的一句【话】，不是一种颜色。
    const got = h({ from: "a", to: "b", review_gate: false });
    expect(got).toContain('class="admin-edge admin-mono"');
    expect(got).not.toContain("need");
    expect(got).not.toContain("banner");
    // 正向对照：approvalCard 在【真该琥珀】时确实吐 need（见本节第一条同款对照）。
    const amber = (
      fns.approvalCard as (
        a: unknown,
        n: number,
        c: boolean,
        d: boolean,
      ) => string
    )(
      {
        id: "a1",
        status: "pending",
        approval_type: "escalation",
        summary: "s",
        task_id: "t1",
        created_at: 1,
      },
      2,
      true,
      true,
    );
    expect(amber).toContain("need");
  });
});

/* ───────── round340：导航 aria-current + Ctrl+Enter 判定 ─────────
 * 这两格是纯函数（navLink 拼 HTML 串 / isCtrlEnter 读事件字段），装载器已挂
 * 到 EXPORTS。抽屉里那枚「打开完整回放」链接与 URL 参数读取是 DOM/路由侧，
 * 不在本文件射程内（那边没有浏览器可跑，0042 §11 同口径）。
 */
describe("navLink —— 导航链接一枚（aria-current 只给当前视图）", () => {
  const r = (over: Record<string, unknown> = {}) => ({
    id: "board",
    label: "任务看板",
    ...over,
  });
  const h = (v: unknown, cur: string): string =>
    (fns.navLink as (a: unknown, b: string) => string)(v, cur);

  it('⭐ 当前视图那一枚带 aria-current="page"，且 class 里有 act', () => {
    const got = h(r(), "board");
    expect(got).toContain('aria-current="page"');
    expect(got).toContain('class="admin-act"');
    expect(got).toContain('href="#/admin/board"');
    expect(got).toContain('data-r="board"');
  });

  it("⭐ 非当前视图那一枚【不】带 aria-current（视觉 .act 与语义 aria 同一把尺）", () => {
    const got = h(r(), "today");
    expect(got).not.toContain("aria-current");
    expect(got).not.toContain('class="admin-act"');
    // 双向对照：不是"本函数永远不写 aria-current"，上面一发证明它写得出。
    expect(got).toContain('href="#/admin/board"');
  });

  it("⭐ id 与 label 都照原样进链接（nav 原实现同样不转义：ROUTES 是页面写死的七枚常量，不在用户输入路径上）", () => {
    const got = h({ id: "b&d", label: "<x>预算" }, "b&d");
    expect(got).toContain('href="#/admin/b&d"');
    expect(got).toContain('data-r="b&d"');
    expect(got).toContain("<x>预算");
    expect(got).toContain('aria-current="page"');
  });
});

describe("isCtrlEnter —— Ctrl+Enter 快捷提交的判定", () => {
  const f = (e: unknown): boolean =>
    (fns.isCtrlEnter as (x: unknown) => boolean)(e);
  const ev = (over: Record<string, unknown> = {}) => ({
    ctrlKey: true,
    key: "Enter",
    shiftKey: false,
    ...over,
  });

  it("⭐ Ctrl+Enter 命中：主键 = Enter 且按住 Ctrl（mac 的 meta 同权）", () => {
    expect(f(ev())).toBe(true);
    expect(f(ev({ metaKey: true, ctrlKey: false }))).toBe(true);
  });

  it("⭐ 只有 Enter【不算】快捷键（换行是 textarea 的默认动作）", () => {
    expect(f(ev({ ctrlKey: false }))).toBe(false);
    expect(f({ key: "Enter" })).toBe(false);
  });

  it("⭐ 只按 Ctrl 不算：key 不是 Enter 时不触发提交", () => {
    expect(f(ev({ key: "a" }))).toBe(false);
    // 反向对照：同一个事件对象换成 Enter 就是命中（证明不是"永远 false"）。
    expect(f(ev())).toBe(true);
  });

  it("⭐ Shift+Ctrl+Enter 不算（shift 是插入行的另一条路，不吞）", () => {
    expect(f(ev({ shiftKey: true }))).toBe(false);
  });

  it("⭐ 事件为 null / undefined 不抛（keydown 外侧一律判否）", () => {
    expect(f(null)).toBe(false);
    expect(f(undefined)).toBe(false);
  });
});

/* ───────── round340：组织页查看/编辑模式（§18.6） ─────────
 * 这一节测的是【模式 → 行为】的几片纯决策：
 *  · orgDefaultMode —— 进页的默认模式必须是查看（§18.6：查看模式不可拖拽，
 *    进页不该默认就是编辑态）。把它抽成纯函数，是为了给「默认写死可拖」那一格
 *    一个可变异/可断言的点。
 *  · orgDragEnabled ——「当前模式允不允许拖拽」的纯布尔。DOM 侧（renderOrg 只在
 *    edit 才 bindOrgDrag、bindOrgDrag 里再挡一层、模式条按钮翻转`orgMode`再重渲）
 *    不在本文件射程内 —— 那边没有浏览器可跑（0042 §11）。
 *  · orgModeBand —— 模式条那一行文案：要自证模式，不许两态长成一句话。
 */
describe("orgDefaultMode —— 进页默认是查看模式", () => {
  const f = (): string => String((fns.orgDefaultMode as () => unknown)());

  it("⭐ 默认就是查看 —— §18.6 说查看模式不可拖拽，进页不该默认就能拖", () => {
    expect(f()).toBe("view");
  });
});

describe("orgDragEnabled —— §18.6：只有编辑模式可拖拽", () => {
  const f = (m: unknown): boolean =>
    (fns.orgDragEnabled as (x: unknown) => boolean)(m);

  it("⭐ 默认/查看模式 ⇒ false：看组织图时拖不得", () => {
    expect(f("view")).toBe(false);
    expect(f(undefined)).toBe(false);
    expect(f(null)).toBe(false);
  });

  it("⭐ 编辑模式 ⇒ true：唯一一条能拖的路", () => {
    expect(f("edit")).toBe(true);
  });

  it("⭐ 未知值一律按查看收（宁可锁死也不放开）", () => {
    for (const bad of ["", "EDIT", "editing", 1, true, {}]) {
      expect(f(bad), String(bad)).toBe(false);
    }
    // 反向对照：这格不是"永远 false" —— 真 edit 时的 true 上面已证明。
    expect(f("edit")).not.toBe(f("view"));
  });
});

describe("orgModeBand —— 模式条：两态两句话，按钮跟着模式走", () => {
  const h = (m: unknown): string =>
    (fns.orgModeBand as (x: unknown) => string)(m);

  it("⭐ 查看模式：说「查看模式 · 拖拽关闭」，按钮是「编辑」", () => {
    const got = h("view");
    expect(got).toContain("查看模式");
    expect(got).toContain("拖拽关闭");
    expect(got).toContain(">编辑<");
    expect(got).not.toContain("编辑模式");
  });

  it("⭐ 编辑模式：说「编辑模式 · 拖拽改汇报关系」，按钮是「退出编辑」", () => {
    const got = h("edit");
    expect(got).toContain("编辑模式");
    expect(got).toContain("拖拽改汇报关系");
    expect(got).toContain("提交后生效");
    expect(got).toContain("退出编辑");
    expect(got).not.toContain("查看模式");
  });

  it("⭐ 两态按钮【跟着模式走】，不许长成同一枚（渲染时若有人写死按钮文案，这发红）", () => {
    expect(h("edit")).not.toBe(h("view"));
  });
});

/* ═════════════ 回放时间线三处欠账（round340，决策 0052） ═════════════
 * ① 分页：判据（replayHasMore）与游标（replayNextOffset）分开测 ——
 *    判据写错让「加载更多」永不出现，游标写错让翻页重复同一段，两格不互证。
 * ② 意见原文：eventNoteText 沿【库里的真生产者】追出的字段落点 ——
 *    review_decision 读 payload.note（dispatch 落库那份），approval 读
 *    state_snapshot.note（decision_note 那条路，approve.ts/real-deps.ts 都是
 *    `...(note===null?{}:{stateSnapshot:{note}})`）。任务书里写的
 *    「approval 事件 payload 里有 decision_note」经查在写侧【不成立】——
 *    那一列从未进过 events.payload，故这里按真生产者实现，且下面那发
 *    「两个字段不同族」钉住读错字段的翻版写法。
 * ③ 汇报关系：replayReportsToHtml 纯读 graph.reports_to（query.ts graphSection
 *    给的任务运行时那一版，刻意不退回当前图）。
 */
describe("replayHasMore / replayNextOffset —— 回放分页（0052 欠账 ①）", () => {
  const hasMore = (raw: unknown, eff: unknown): boolean =>
    (fns.replayHasMore as (a: unknown, b: unknown) => boolean)(raw, eff);
  const next = (raw: unknown, cur: unknown): number =>
    Number(
      (fns.replayNextOffset as (a: unknown, b: unknown) => unknown)(raw, cur),
    );

  it("⭐ 一页拉满 ⇒ 可能还有更多（按钮该出现）", () => {
    expect(hasMore(200, 200)).toBe(true);
  });

  it("⭐ 一页不满 ⇒ 到底了（按钮该消失）", () => {
    expect(hasMore(150, 200)).toBe(false);
    expect(hasMore(0, 200)).toBe(false);
  });

  it("⭐ 形状不对按「到底」算（服务端某天没给 effective_limit 不该冒出一个翻页按钮）", () => {
    expect(hasMore(null, undefined)).toBe(false);
    expect(hasMore("200", 200)).toBe(false);
    expect(hasMore(200, null)).toBe(false);
  });

  it("⭐ 游标 = 当前 offset + 本页【实际返回条数】（不是过滤后的数；服务端 offset 语义=从第 N 条起）", () => {
    expect(next(200, 0)).toBe(200);
    expect(next(200, 200)).toBe(400);
    expect(next(150, 200)).toBe(350);
  });

  it("⭐ 游标输入非整数按 0 计（传给请求的永远是整数，null/undefined 不炸）", () => {
    expect(next(null, 0)).toBe(0);
    expect(next(undefined, undefined)).toBe(0);
    expect(next("200", 0)).toBe(0);
    expect(next(200, null)).toBe(200);
  });

  it("⭐ 判别互相让开：判据恒真时游标仍可能 0（同一组输入下两者必有一个红路径）", () => {
    // 正向对照：不是"永远 true"也不是"永远 0"。
    expect(hasMore(100, 200)).toBe(false);
    expect(next(100, 0)).toBe(100);
  });
});

describe("eventNoteText / eventOpinionHtml —— 事件行意见原文（0052 欠账 ②）", () => {
  const text = (e: unknown): string =>
    String((fns.eventNoteText as (x: unknown) => unknown)(e ?? {}));
  const html = (e: unknown): string =>
    String((fns.eventOpinionHtml as (x: unknown) => unknown)(e ?? {}));
  const rd = (over: Record<string, unknown> = {}) => ({
    action: "review_decision",
    actor_id: "ceo",
    payload: { note: " 评审意见原文 " },
    ...over,
  });
  const ap = (over: Record<string, unknown> = {}) => ({
    action: "approval",
    actor_id: "ceo",
    state_snapshot: { note: " 打回理由 " },
    ...over,
  });

  it("⭐ review_decision 有 payload.note ⇒ 原样（trim）显示，且带「意见」标签", () => {
    expect(text(rd())).toBe("评审意见原文");
    expect(html(rd())).toContain("评审意见原文");
    expect(html(rd())).toContain("意见");
  });

  it("⭐ approval 有 state_snapshot.note（decision_note 那条路）⇒ 显示为「理由」", () => {
    expect(text(ap())).toBe("打回理由");
    expect(html(ap())).toContain("打回理由");
    expect(html(ap())).toContain("理由");
  });

  it("⭐ 没有意见 ⇒ 空串，事件行不拼一行假的", () => {
    for (const e of [
      rd({ payload: {} }),
      { action: "review_decision", actor_id: "ceo" },
      ap({ state_snapshot: {} }),
      { action: "approval", actor_id: "ceo" },
      { action: "tool_call", payload: { note: "x" } },
      { action: "review_decision", payload: { note: "" } },
      { action: "review_decision", payload: { note: "   " } },
      null,
      "str",
      7,
      undefined,
    ]) {
      expect(text(e), JSON.stringify(e)).toBe("");
      expect(html(e), JSON.stringify(e)).toBe("");
    }
  });

  it("⭐ 意见过 esc：它是库里读的自由文本，不是可信标记（eventRow 里这句进 innerHTML）", () => {
    const got = html(rd({ payload: { note: "<img src=x onerror=alert(1)>" } }));
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });

  it("⭐ 意见决定哪一款：review_decision 别把 state_snapshot.note 当意见，approval 别把 payload.note 当理由", () => {
    // 两个字段不同族：payload.note 是审阅者的话，state_snapshot.note 是审批者的话。
    // 反着读会把两个人的话对调（同 0006 §7 那份「两份抄本」）。
    const rdWrong = rd({ state_snapshot: { note: "这是审批的话不该出现" } });
    expect(text(rdWrong)).not.toBe("这是审批的话不该出现");
    const apWrong = ap({ payload: { note: "这是审阅的话不该出现" } });
    expect(text(apWrong)).toBe("打回理由");
  });
});

describe("replayReportsToHtml —— 回放头卡汇报关系（0052 欠账 ③，graph.reports_to）", () => {
  const h = (g: unknown, role?: unknown): string =>
    String(
      (fns.replayReportsToHtml as (a: unknown, b: unknown) => unknown)(g, role),
    );

  it("⭐ 角色在图上：dir ↖ 上级", () => {
    const got = h(
      {
        ok: true,
        version: 3,
        reports_to: { dev: "tech", tech: "ceo", ceo: null },
      },
      "dev",
    );
    expect(got).toContain("dev");
    expect(got).toContain("tech");
    expect(got).toContain("↖");
    expect(got).not.toContain("顶层");
  });

  it("⭐ reports_to === null = 顶层（直接向 CEO 汇报），不许说成「不在图上」", () => {
    const got = h({ ok: true, version: 3, reports_to: { ceo: null } }, "ceo");
    expect(got).toContain("顶层");
    expect(got).not.toContain("不在图上");
  });

  it("⭐ 键缺 = 那一版图里没有这个角色（说查不到，不说它是顶层）", () => {
    const got = h({ ok: true, version: 3, reports_to: { ceo: null } }, "ghost");
    expect(got).toContain("ghost");
    expect(got).toContain("不在图上");
    expect(got).not.toContain("顶层");
  });

  it("⭐ graph 是 degraded 块（ok:false）⇒ 明说读不到 + 原因，不编一张假的", () => {
    const got = h({
      ok: false,
      version: 5,
      degraded: true,
      reason: "那一版读不出来",
    });
    expect(got).toContain("读不到");
    expect(got).toContain("那一版读不出来");
  });

  it("⭐ 没有报告 ⇒ 空串（头卡不凭空多一句）", () => {
    expect(h(null)).toBe("");
    expect(h(undefined)).toBe("");
    expect(h({ ok: true, version: 1, reports_to: {} })).toBe("");
  });

  it("⭐ 图里没有那一格报告但任务角色是明确给的 ⇒ 说「当时不在图上」不装没看见", () => {
    // reports_to={} 但界面明确知道这个任务的 assigned_role —— 「不在图上」是只有
    // 这一版能说出的信息（缺键 = 那一版图里没有它），不许靠删字段把它藏起来。
    expect(h({ ok: true, version: 1, reports_to: {} }, "dev")).toContain("dev");
    expect(h({ ok: true, version: 1, reports_to: {} }, "dev")).toContain(
      "不在图上",
    );
  });

  it("⭐ 角色名与上级都过 esc（role_id 是图里的文本），且 decision 缺失不抛", () => {
    const got = h(
      {
        ok: true,
        version: 1,
        reports_to: { "<img src=x>": "<script>b</script>" },
      },
      "<img src=x>",
    );
    expect(got).not.toContain("<img");
    expect(got).not.toContain("<script>");
    expect(got).toContain("&lt;img");
    expect(() =>
      h({ ok: true, version: 1, reports_to: null }, "dev"),
    ).not.toThrow();
  });
});

describe("strategyLine —— §16.5 摘要条补读 human_decided_in_window（round341）", () => {
  const f = (over: Record<string, unknown> = {}) =>
    (fns.strategyLine as (x: unknown) => unknown)({
      window_ms: 86400000,
      decisions: {
        auto_approved_in_window: 3,
        to_human_in_window: 2,
        human_decided_in_window: 0,
        ...over,
      },
    });

  it("⭐ 人已拍板 > 0 ⇒ 句子带该读数（拼在拦截之后、待处理之前）", () => {
    const got = String(f({ human_decided_in_window: 4 }));
    expect(got).toContain("人已拍板 4 项");
    expect(got).toContain("拦截 2 项进入人工审批");
    expect(got).toContain("当前待处理");
    // 顺序：拦截句 → 拍板句 → 待处理句
    expect(got.indexOf("拦截")).toBeLessThan(got.indexOf("人已拍板"));
    expect(got.indexOf("人已拍板")).toBeLessThan(got.indexOf("当前待处理"));
  });

  it("⭐ 人已拍板为 0 ⇒ 句子与现状逐字一致（不出现拍板字样，老测试不动）", () => {
    const got = String(f({ human_decided_in_window: 0 }));
    expect(got).toBe(
      "过去 1 天，策略引擎自动通过 3 项可逆决策，拦截 2 项进入人工审批。当前待处理 0 项。",
    );
  });

  it("⚠ 边界：upstream 缺该字段（老服务端）⇒ 按 0 处理，不漏句不错位", () => {
    const rest = {
      window_ms: 86400000,
      decisions: {
        auto_approved_in_window: 3,
        to_human_in_window: 2,
      },
    };
    const got = String((fns.strategyLine as (x: unknown) => unknown)(rest));
    expect(got).toContain("拦截 2 项进入人工审批");
    expect(got).not.toContain("人已拍板");
    expect(got).toContain("当前待处理");
  });
});

describe("eventTargetText —— 事件行 target（round341，recorder.ts targetOf 的形状）", () => {
  const f = (x: unknown): string =>
    String((fns.eventTargetText as (a: unknown) => unknown)(x));

  it("⭐ 单值字符串：原样返回且过 esc", () => {
    expect(f("task-42")).toBe("task-42");
    expect(f("<img src=x>")).toBe("&lt;img src=x&gt;");
    expect(f("\"&&'")).toBe("&quot;&amp;&amp;&#39;");
  });

  it("⭐ 数组：join（写入方目前只推字符串，这里是防御）", () => {
    expect(f(["ceo", "tech"])).toBe("ceo、tech");
    expect(f(["<a>", "b"])).toBe("&lt;a&gt;、b");
    // 数组里夹空项：过滤掉再 join，不出现「、」开头/结尾
    expect(f(["", null, "x"])).toBe("x");
  });

  it("⭐ 空/缺 ⇒ 空串（null / undefined / 空串 / 只空白），事件行不多占一格", () => {
    for (const x of [null, undefined, "", "   ", [], [null, ""], [""]]) {
      expect(f(x), JSON.stringify(x)).toBe("");
    }
  });
});

describe("checkpointDegradedNote —— checkpoints_unavailable 降级提示（round341）", () => {
  const f = (u: unknown, c?: unknown): string =>
    String(
      (fns.checkpointDegradedNote as (a: unknown, b: unknown) => unknown)(u, c),
    );

  it("⭐ unavailable 为真 ⇒ 给降级提示 + 原因（读回放响应的 checkpoints_unavailable）", () => {
    const got = f("读不到 checkpoints：no such table", 3);
    expect(got).toContain("断点解码失败，仅显示数量");
    expect(got).toContain("读不到 checkpoints：no such table");
    expect(got).toContain("实际断点 3 个");
    expect(got).toContain("admin-banner admin-warn");
  });

  it("⭐ unavailable 为假（undefined / null / 空串）⇒ 空串，断点区不凭空多一条", () => {
    for (const u of [undefined, null, ""]) {
      expect(f(u, 4), JSON.stringify(u)).toBe("");
    }
  });

  it("⭐ 原因过 esc（checkpoints_unavailable 是库内文本，不是可信标记）", () => {
    const got = f("<img src=x>", 1);
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });

  it("⭐ count 非正/非数 ⇒ 只提示不报数（0 个时那句「实际断点」没意义）", () => {
    expect(f("表没了", 0)).toContain("断点解码失败");
    expect(f("表没了", 0)).not.toContain("实际断点");
    expect(f("表没了")).toContain("断点解码失败");
    expect(f("表没了")).not.toContain("实际断点");
  });
});

/* ═════ round342：审批卡已决明细（decision_note / decided_by / decided_at）═════════
 * `GET /approvals/:id` 的 approval 上带着这三格（contracts/api.ts:500-503，
 * pending 时 decided_at 为 null）。展开参数快照时与 parameters 同屏渲染。
 * 三种缺口各说各话：decided_at 缺 ⇒ 整行消失（pending 没有「已决」可念）；
 * decided_by 缺 ⇒ "—"；decision_note 缺 ⇒ 不追加理由。时间走 fmtDate 不钉数字。
 */
describe("decidedMetaHtml —— 审批卡已决明细（round342）", () => {
  const f = (a: unknown): string =>
    String((fns.decidedMetaHtml as (x: unknown) => unknown)(a));

  it("⭐ pending（decided_at 为 null / undefined）⇒ 空串，不念「已决」", () => {
    for (const a of [
      { decided_at: null, decided_by: "ceo", decision_note: "x" },
      { decided_by: "ceo" },
      undefined,
      null,
    ]) {
      expect(f(a), JSON.stringify(a)).toBe("");
    }
  });

  it("⭐ 已决 + 有理由 ⇒ 时间/人/理由同屏（时间断言 contains，不钉死数字）", () => {
    const got = f({
      decided_at: 1720000000000,
      decided_by: "ceo:alice",
      decision_note: "费用超预算三倍，打回",
    });
    expect(got).toContain("已决");
    expect(got).toContain("202");
    expect(got).toContain("ceo:alice");
    expect(got).toContain("费用超预算三倍，打回");
  });

  it("⭐ 已决但理由空缺 ⇒ 只有时间+人，不出现「理由：」占位", () => {
    const got = f({ decided_at: 1720000000000, decided_by: "ceo:alice" });
    expect(got).toContain("已决");
    expect(got).toContain("ceo:alice");
    expect(got).not.toContain("理由");
  });

  it("⭐ 已决但 decided_by 缺 ⇒ 人位写作「—」，不把决定说成没人决定", () => {
    const got = f({ decided_at: 1720000000000, decision_note: "n" });
    expect(got).toContain("—");
    expect(got).toContain("n");
  });

  it("⭐ decision_note 过 esc（理由走库内文本，不是可信标记）", () => {
    const got = f({
      decided_at: 1720000000000,
      decided_by: "ceo",
      decision_note: "<img src=x onerror=1>",
    });
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });
});

/* ═════ round342：policy_shadow.note 的渲染半 ═════════
 * query.ts:271 例「卡片显式标记 irreversible=true：不可逆永不自动通过」——
 * 规则引擎写进库的真据以前只在 blocked_by/missing 之后消失。此格只在
 * require_approval 分支追加；auto_approved 分支原本就带 rule 名，不加。
 */
describe("policyNoteHtml —— policy_shadow.note 显式（round342）", () => {
  const f = (n: unknown): string =>
    String((fns.policyNoteHtml as (x: unknown) => unknown)(n));

  it("⭐ 无 note（undefined / null / 空串）⇒ 空串，shadow 行不多占", () => {
    for (const n of [undefined, null, ""]) {
      expect(f(n), JSON.stringify(n)).toBe("");
    }
  });

  it("⭐ 有 note ⇒ 原文 + 「规则依据：」壳", () => {
    const got = f("卡片显式标记 irreversible=true：不可逆永不自动通过");
    expect(got).toContain("规则依据");
    expect(got).toContain("不可逆永不自动通过");
  });

  it("⭐ note 过 esc（库内文本不是可信标记）", () => {
    const got = f("<img src=x onerror=1>");
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });
});

/* ═════ round342：policyShadowLine 的 note 接线（policyNoteHtml 已单独测）═════════
 * 旧断言（扫源码那一族）不在此文件；这里钉的是接线本身：require_approval 分支
 * note 原文现身，auto_approved 分支【不】出现「规则依据」。
 */
describe("policyShadowLine —— note 接线只在转人工分支（round342）", () => {
  const line = (a: Record<string, unknown>) =>
    String((fns.policyShadowLine as (x: unknown) => unknown)(a));

  it("⭐ 转人工 + note ⇒ 理由原文现身", () => {
    const got = line({
      policy_shadow: {
        decision: "require_approval",
        rule: "irreversible",
        blocked_by: "irreversible",
        missing: [],
        note: "不可逆永不自动通过",
      },
    });
    expect(got).toContain("转人工");
    expect(got).toContain("规则依据");
    expect(got).toContain("不可逆永不自动通过");
  });

  it("⭐ auto_approved 分支【不】加 note", () => {
    const got = line({
      policy_shadow: {
        decision: "auto_approved",
        rule: "low_risk",
        blocked_by: "low_risk",
        missing: [],
        note: "即使有理由也不该念",
      },
    });
    expect(got).toContain("会通过");
    expect(got).not.toContain("规则依据");
  });

  it("⭐ note 缺失 ⇒ 转人工分支照旧，无「规则依据」占位", () => {
    const got = line({
      policy_shadow: {
        decision: "require_approval",
        rule: "irreversible",
        blocked_by: "irreversible",
        missing: [],
      },
    });
    expect(got).toContain("转人工");
    expect(got).not.toContain("规则依据");
  });
});

/**
 * round341 死代码清理（④ data.degraded 三目 / ⑤ 重复 notesHtml）的源码级守门。
 *
 * 这四格守的是 app.js 的【静态字面】：死代码位置在渲染模板里（renderToday /
 * loadReplay 的 innerHTML），纯函数测试够不到；但 renderer-criteria.test.ts
 * 那一族已经是「扫 app.js 源码、断言判据字面」的既有范式。这里照同款：
 *  N1  ReplayView 无 top-level degraded ⇒ app.js 里不许再有
 *      `data.degraded ? banner(` —— 复活就是死代码还魂（round341 清掉的那处）。
 *  N2  renderToday 里那个「自动决策摘要」折叠区不再画第二份 notesHtml ——
 *      同一行意见只能出现一次（口径说明块不重复）。
 *  N3  §16.5 摘要条接上了 human_decided（round341：不接 = 那一格有生产者无消费者）。
 *  N4  事件行接上了 target 渲染（round341：不接 = events.target 有人写没人读）。
 */
describe("app.js 死代码清理守门（round341，renderToday/loadReplay 静态字面）", () => {
  const src = readFileSync(APP_JS, "utf8");

  it("N1 回放响应扁平无 top-level degraded ⇒ 「data.degraded ? banner(」不得还魂", () => {
    expect(src).not.toContain("data.degraded ? banner(");
  });

  it("N2 今日页「自动决策摘要」折叠区里 notesHtml 只出现一次（重复口径块已删）", () => {
    // 收紧坐标：只数「自动决策摘要」details 内部那一段，别把右下角那格的地盘
    // 也算进来。明细：round341 之前左栏 notesHtml(t.notes) 与右栏
    // ${notesHtml(t.notes)} 同屏 = 同一行意见被整块画两遍。
    const abstract = src.slice(
      src.indexOf("<summary>自动决策摘要"),
      src.indexOf('id="feed"'),
    );
    const hits = abstract.split("notesHtml(t.notes)").length - 1;
    expect(hits).toBe(0);
  });

  it("N3 §16.5 摘要条读 human_decided_in_window（round341 接线，缺 = 有生产者无消费者）", () => {
    expect(src).toContain("t.decisions.human_decided_in_window");
  });

  it("N4 事件行接上 eventTargetText(e.target)（round341 接线）", () => {
    expect(src).toContain("eventTargetText(e.target)");
  });
});

/* ═════ round342：接线守门（纯函数各自有执行测试，接线点是 loadSnapshot /
 * policyShadowLine 里那两处调用 —— fetch/DOM 层函数测试照不到，静态字面钉住）═══
 *  N5  loadSnapshot 接上 decidedMetaHtml（round342：不接 = 已决明细有生产者
 *      无消费者，GET /approvals/:id 的 decided_at/by/note 全白拿了）。
 *  N6  loadSnapshot 已决明细要能看到，缓存必须带 approval 而不是塞参数进格子：
 *      灰「100% 值不塞参数」。守的是「缓存从 params 扩成 approval」这一格。
 *  N7  policyShadowLine 转人工分支接上 policyNoteHtml(s.note)（round342：
 *      不接 = policy_shadow.note 有生产者无消费者，query.ts:271 那类真据丢在库里）。
 */
describe("round342 接线守门（loadSnapshot / policyShadowLine 静态字面）", () => {
  const src = readFileSync(APP_JS, "utf8");

  it("N5 参数快照渲染接上 decidedMetaHtml（已决明细随展开出现）", () => {
    expect(src).toContain(
      "paramSnapshotHtml(params) + decidedMetaHtml(data?.approval)",
    );
    expect(src).toContain(
      "paramSnapshotHtml(st?.parameters ?? null) + decidedMetaHtml(st)",
    );
  });

  it("N6 缓存带整份 approval（decided_at/by/note 与 parameters 同一次往返落地）", () => {
    expect(src).toContain("snapshotCache.set(id, data?.approval ?? null)");
  });

  it("N7 policyShadowLine 转人工分支接上 policyNoteHtml(s.note)", () => {
    expect(src).toContain("policyNoteHtml(s.note)");
  });
});

describe("eventRow —— target 渲染（round341，内置 eventTargetText 接线）", () => {
  const row = (e: unknown): string =>
    String((fns.eventRow as (x: unknown) => unknown)(e));

  it("⭐ 有 target ⇒ 「→ {已 esc}」小标签出现在事件行里", () => {
    const got = row({
      action: "approval",
      actor_id: "ceo",
      actor_type: "human",
      target: "card-7",
    });
    expect(got).toContain("→ card-7");
    expect(got).toContain('class="admin-tag admin-mono"');
  });

  it("⭐ target 为空/缺 ⇒ 事件行不占那一格（不出现 → / target）", () => {
    for (const e of [
      { action: "tool_call", actor_id: "hub" },
      { action: "tool_call", actor_id: "hub", target: null },
      { action: "tool_call", actor_id: "hub", target: "" },
    ]) {
      const got = row(e);
      expect(got).not.toContain("→");
      expect(got).not.toContain("card");
    }
  });

  it("⭐ target 过 esc：它是库里的自由文本，不是可信标记", () => {
    const got = row({
      action: "approval",
      actor_id: "ceo",
      target: "<img src=x onerror=alert(1)>",
    });
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img");
  });

  it("⭐ round346：auto_approved 是对象时标注真的上屏，且带 rule/annotation", () => {
    const got = row({
      action: "ApprovalDecided",
      actor_id: "hub",
      actor_type: "system",
      auto_approved: {
        by: "hub",
        rule: "保费豁免",
        annotation: "模式匹配：老客户续保",
      },
    });
    expect(got).toContain("基于模式的自动批准");
    expect(got).toContain("保费豁免");
    expect(got).toContain("老客户续保");
    // 对象 ≠ true —— 这发从「=== true 恒假」变绿，正是本格原来的缺陷。
  });

  it("⭐ round346：auto_approved 缺失/非对象 ⇒ 不出现自动批准标注", () => {
    for (const e of [
      { action: "ApprovalRequired", actor_id: "pop", actor_type: "hub" },
      {
        action: "ApprovalRequired",
        actor_id: "pop",
        actor_type: "hub",
        auto_approved: true,
      },
      {
        action: "ApprovalRequired",
        actor_id: "pop",
        actor_type: "hub",
        auto_approved: "oops",
      },
      {
        action: "ApprovalRequired",
        actor_id: "pop",
        actor_type: "hub",
        auto_approved: [1],
      },
    ]) {
      const got = row(e);
      expect(got).not.toContain("基于模式的自动批准");
    }
  });

  it("⭐ round346：auto_approved 的 rule/annotation 过 esc（库读自由文本）", () => {
    const got = row({
      action: "ApprovalDecided",
      actor_id: "hub",
      actor_type: "system",
      auto_approved: {
        by: "<b>hub</b>",
        rule: "<img src=x onerror=alert(1)>",
        annotation: "<script>bad()</script>",
      },
    });
    expect(got).not.toContain("<img");
    expect(got).not.toContain("<script>");
    expect(got).toContain("&lt;img");
    expect(got).toContain("&lt;script&gt;");
  });
});

describe("memoryBandHtml —— 记忆三数（0060 §8 界面半）", () => {
  const band = (m: unknown): string =>
    String((fns.memoryBandHtml as (x: unknown) => unknown)(m));

  it("⭐ 常规：审阅判定有数据 ⇒ 报条数 + 未署名数，且两个口径不混", () => {
    const got = band({
      scope_rows: 12,
      gate_rows: 5,
      gate_unattributed_rows: 2,
    });
    expect(got).toContain("角色记忆");
    expect(got).toContain("审阅判定 5 条");
    expect(got).toContain("未署名（actor_type=system）2 条");
    // 未署名 > 0 ⇒ 补那行「进不了任何角色的提示词」。
    expect(got).toContain("不会】进任何角色的提示词");
    // 口径区隔：这一格不显示别的口径名词。
    expect(got).not.toContain("O3 验收");
  });

  it("⭐ 三数全 0 ⇒ 一整块不显示（页面上没有『全是 0』的噪音）", () => {
    expect(
      band({ scope_rows: 0, gate_rows: 0, gate_unattributed_rows: 0 }),
    ).toBe("");
    // 老服务端没发 memory 字段 ⇒ 同样静默（退化方向是少一块，不是报错）。
    expect(band(undefined)).toBe("");
  });

  it("⭐ 审阅判定空而其它记忆有数据 ⇒ 说『在等生产者』而不是『角色没做过决定』", () => {
    const got = band({
      scope_rows: 12,
      gate_rows: 0,
      gate_unattributed_rows: 0,
    });
    expect(got).toContain("审阅判定那一档是【空的】");
    expect(got).toContain("库里另有 12 条其它记忆口径的审计");
    expect(got).toContain("在等它的生产者");
    // 措辞本身带着「不是『角色还没做过决定』」—— 不许被改成反话。
    expect(got).toContain("不是「角色还没做过决定」");
  });

  it("⭐ 非数/缺失形状防御：不抛、按 0 读（渲染层不假设上游一定折过）", () => {
    // t.memory 理论上恒为三个数字（today.ts 那层已折），但渲染层不立「上游一定干净」的假设。
    expect(band({})).toBe("");
    expect(band(null)).toBe("");
    expect(band("oops")).toBe("");
  });

  it("⭐ 数是自由文本，进 innerHTML 必须过 esc", () => {
    // 数字本身不会是 <img>，但 scope_rows 那行把数字拼进 HTML —— 防御性 esc 一把。
    const got = band({
      scope_rows: 12,
      gate_rows: 5,
      gate_unattributed_rows: 0,
    });
    expect(got).toContain("5 条");
    // 刻意给一个非标准对象形的字段值，确认不会把对象字面量拼进 HTML。
    expect(
      band({ scope_rows: {}, gate_rows: 5, gate_unattributed_rows: 0 }),
    ).not.toContain("[object");
  });
});

describe("incompleteNote —— 回放时间线中间缺行（round346，replay/query.ts 的 complete）", () => {
  const note = (c: unknown): string =>
    String((fns.incompleteNote as (x: unknown) => unknown)(c));

  it("⭐ complete 是 false ⇒ 给一条聚合提示（看得见的缺口）", () => {
    const got = note(false);
    expect(got).toContain("这条时间线不完整");
    expect(got).toContain("中间");
    expect(got).toContain("不是分页截断");
  });

  it("⭐ complete true / 缺字段 / 非布尔 ⇒ 静默（老服务端没发这一格不算缺口）", () => {
    expect(note(true)).toBe("");
    expect(note(undefined)).toBe("");
    expect(note(null)).toBe("");
    expect(note(0)).toBe("");
    expect(note("false")).toBe("");
  });
});

describe("stat —— 顶部四个大数字格（首页唯一渲染层，round347 补执行证据）", () => {
  // stat 在 EXPORTS 白名单（app-loader.ts:41）里躺了 N 轮，但直到 round347 前
  // app-pure.test.ts 里没有任何一条 it 真把它跑起来 —— 四格大数字（活跃任务 /
  // 完成 / 被阻塞 / 待你决策）的 HTML 拼装是【零执行证据】的纯函数。
  // 判据三件：tone 按需加类、数字与 label 过 esc、title 过 esc（title 属性注入
  // 是 attribute 注入面，跟 innerHTML 注入面要分开防 —— title 里塞 " onmouseover=…
  // 会在真实浏览器里被当属性解析，esc 挡掉引号）。
  const f = (
    label: unknown,
    n: unknown,
    tone: unknown,
    title: unknown,
  ): string =>
    String((fns.stat as (...a: unknown[]) => unknown)(label, n, tone, title));

  it("⭐ 常态：无 tone ⇒ stat 类不带后缀", () => {
    const got = f("活跃任务", 3, "", "没到终点的任务数");
    expect(got).toContain('class="admin-stat"');
    expect(got).toContain('<div class="admin-num admin-mono">3</div>');
    expect(got).toContain('<div class="admin-lbl">活跃任务</div>');
    expect(got).toContain('title="没到终点的任务数"');
    // ⚠ 顺序判据（变异机 M4 抓出来的盲区）：唯一 `toContain` 逐条查不查次序，
    // div 骨架把 num 与 lbl 互换后照样绿。t01 断言「数字在上、标签在下」——
    // stat 的 DOM 顺序就是屏幕上的顺序（大数字在上、说明在下），互换是结构变异。
    // round370：类名带 admin- 前缀后，字形整块换掉。这里【不能】留 "num mono"
    // 那种子串 —— 它在新形状里匹配不到（indexOf 得 -1），而下面那条 ">" -1
    // 次序判据会因两侧同为 -1 而恒真，等于把 M4 那把尺子悄悄卸了。
    expect(got.indexOf("admin-num admin-mono")).toBeGreaterThan(-1);
    expect(got.indexOf("admin-lbl")).toBeGreaterThan(
      got.indexOf("admin-num admin-mono"),
    );
  });

  it("⭐ 琥珀（§19.2 唯一给 stat 用的色调）：tone=statbad ⇒ class 带后缀", () => {
    const got = f("待你决策", 1, "statbad", "审批收件箱里的待批张数");
    expect(got).toContain('class="admin-stat admin-statbad"');
    expect(got).not.toContain('class="admin-stat"');
  });

  it("⭐ tone 是【条件】加后缀，不是【无条件】拼（变异机 M2 抓出的盲区）", () => {
    // M2 把 `tone ? " " + tone : ""` 改成 `" " + tone`（无条件拼）后，t02 原有断言
    //（有 tone 时 class="admin-stat admin-statbad"）照样通过 —— 蒙对了。真正的判据是：
    // 无 tone / tone 是空串时 class 【不得】带任何后缀空格或类名。
    // ⚠ 负向字形是 `class="admin-stat `（stat 后带空格）—— 原版 tone="" 输出
    // `class="admin-stat"`（stat 后直接右引号），那正是合法常态；M2 无条件拼在
    // tone="" 时输出 `class="admin-stat "`（尾空格），才是要抓的形状。
    // round370 前这里是 /class="stat /：admin- 前缀一加，M2 复活也抓不到（恒过）。
    expect(f("活跃任务", 3, "", "t")).not.toMatch(/class="admin-stat /);
    expect(f("活跃任务", 3, undefined, "t")).not.toMatch(/class="admin-stat /);
    expect(f("活跃任务", 3, null, "t")).not.toMatch(/class="admin-stat /);
  });

  it("⭐ 数字进 HTML 过 esc（自由文本不假设上游干净）", () => {
    // 真实消费点数字来自服务端整型，但渲染层不立「上游一定干净」的假设。
    const got = f("活跃任务", "<img src=x onerror=1>", "", "t");
    expect(got).not.toContain("<img");
    expect(got).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("⭐ label 过 esc（标签是本地常量——守的是将来有人把动态文本塞进来）", () => {
    const got = f('"><script>alert(1)</script>', 5, "", "t");
    expect(got).not.toContain("<script>");
    expect(got).not.toContain('"><');
  });

  it("⭐ title 过 esc（attribute 注入面，与 innerHTML 分开防）", () => {
    const got = f("l", 5, "", 'x" onmouseover="alert(1)');
    expect(got).not.toContain('" onmouseover="');
    expect(got).toContain("&quot; onmouseover=&quot;");
  });

  it("⭐ 消费点回归：四格大数字的真实传参形状能被 stat 接住", () => {
    // app.js:295-298 的四处消费点逐字对齐（§16.5 数字格）。
    expect(f("活跃任务", 2, "", "没到终点的任务数")).toContain("活跃任务");
    expect(f("被阻塞", 1, "", "卡在等人处理的状态")).toContain("被阻塞");
    expect(f("待你决策", 2, "statbad", "审批收件箱里的待批张数")).toContain(
      "admin-stat admin-statbad",
    );
  });
});

/* ═════ round350：五个漏网顶层纯函数的独立执行证据 ═════════════════
 * 侦查发现：round347「48 个纯函数全覆盖」的数，漏了 app.js 顶层这一批
 * 不在 EXPORTS 白名单、却也是【纯】的函数 —— fmtDate / fmtAgo /
 * windowLabel / joinLines / linkText。它们只在消费它们的白名单成员内部被
 * 间接执行（taskCard 里调 fmtAgo、strategyLine 里调 windowLabel……），
 * 改坏它们的输出没有任何 it 直接断言（round342 对 fmtDate 是「时间走
 * fmtDate 不钉数字」—— 刻意不锁，于是 fmtDate 改坏全绿）。
 * round350 把它们收进白名单（app-loader.ts）+ 补独立断言。
 * 断言口径与 round342 同族：时间串【钉形状不钉字面】（locale/时区会漂，
 * 精确格式由变异机承重）；joinLines / linkText / windowLabel 可逐字钉。
 */
describe("fmtDate —— 时刻格式化（round350 补执行证据）", () => {
  const f = (ms: unknown): string =>
    String((fns.fmtDate as (...a: unknown[]) => unknown)(ms));

  it("⭐ 坏值（0 / null / undefined / NaN）⇒ 「—」，不许是任何日期形状", () => {
    expect(f(0)).toBe("—");
    expect(f(null)).toBe("—");
    expect(f(undefined)).toBe("—");
    expect(f(NaN)).toBe("—");
    expect(f("")).toBe("—");
  });

  it("⭐ 好值 ⇒ 非「—」且含数字（不钉字面：locale/时区漂移留给变异机）", () => {
    // ⚠ 不在这里断言 f(0)：坏值分支归上一发（变异机 M1 实测：改坏值分支时
    // 这条也会红，两发钉同一处 = 冗余，且让「该绿的没绿清单」变脏）。
    const ok = f(1699999880000);
    expect(ok).not.toBe("—");
    expect(ok).toMatch(/\d/u);
  });
});

describe("fmtAgo —— 相对时间（round350 补执行证据）", () => {
  const f = (ms: unknown, now: unknown): string =>
    String((fns.fmtAgo as (...a: unknown[]) => unknown)(ms, now));

  it("⭐ 缺 now 或缺 ms ⇒ 「—」（没有基准不许编一个相对时间）", () => {
    expect(f(1000, undefined)).toBe("—");
    expect(f(undefined, 2000)).toBe("—");
    expect(f(0, 0)).toBe("—");
  });

  it("⭐ 四档边界逐字钉：秒 / 分钟 / 小时 / 天", () => {
    const now = 1000000000000;
    expect(f(now - 30 * 1000, now)).toBe("30 秒前");
    expect(f(now - 59 * 1000, now)).toBe("59 秒前");
    expect(f(now - 60 * 1000, now)).toBe("1 分钟前");
    expect(f(now - 3599 * 1000, now)).toBe("60 分钟前");
    expect(f(now - 3600 * 1000, now)).toBe("1 小时前");
    expect(f(now - 86399 * 1000, now)).toBe("24 小时前");
    expect(f(now - 86400 * 1000, now)).toBe("1 天前");
  });

  it("⭐ 未来时刻（now - ms 为负）钳到 0，不显示负数秒", () => {
    const now = 1000000000000;
    expect(f(now + 5000, now)).toBe("0 秒前");
  });
});

describe("windowLabel —— 窗口标签（round350 补执行证据）", () => {
  const f = (t: unknown): string =>
    String((fns.windowLabel as (...a: unknown[]) => unknown)(t));

  it("⭐ 默认（无 window_ms）⇒ 24h ⇒ 「1 天」", () => {
    expect(f({})).toBe("1 天");
    expect(f({ window_ms: 86400000 })).toBe("1 天");
  });

  it("⭐ <24h ⇒ 小时；≥24h ⇒ 天（rounding 边界）", () => {
    expect(f({ window_ms: 3600000 })).toBe("1 小时");
    expect(f({ window_ms: 82800000 })).toBe("23 小时");
    expect(f({ window_ms: 90000000 })).toBe("1 天"); // 25h → round(25/24)=1
    expect(f({ window_ms: 7 * 86400000 })).toBe("7 天");
  });
});

describe("joinLines —— 多行文本的契约半（round350 补执行证据）", () => {
  const f = (arr: unknown): string =>
    String((fns.joinLines as (...a: unknown[]) => unknown)(arr));

  it("⭐ 数组 ⇒ 换行 join；空数组 ⇒ 空串", () => {
    expect(f(["a", "b", "c"])).toBe("a\nb\nc");
    expect(f([])).toBe("");
  });

  it("⭐ 非数组（null / undefined / 对象 / 数字）⇒ 空串 —— 这是它区别于裸 .join() 的判据", () => {
    expect(f(null)).toBe("");
    expect(f(undefined)).toBe("");
    expect(f({ 0: "a" })).toBe("");
    expect(f(7)).toBe("");
    expect(f("abc")).toBe("");
  });
});

describe("todayWindows —— 窗口清单（round352 接线半：服务端 ?window_ms= 的前端入口）", () => {
  const f = (): unknown => (fns.todayWindows as (...a: unknown[]) => unknown)();

  it("⭐ 固定三项：24h（不带参）/ 7 天 / 30 天，且首项 ms 是 undefined", () => {
    const w = f() as ReadonlyArray<{ label: string; ms?: number }>;
    expect(w).toHaveLength(3);
    expect(w[0]).toEqual({ label: "24 小时", ms: undefined });
    expect(w[1]).toEqual({ label: "7 天", ms: 7 * 86400000 });
    expect(w[2]).toEqual({ label: "30 天", ms: 30 * 86400000 });
  });
});

describe("windowMsOfHash —— hash ?window= 解析（round352 接线半）", () => {
  const f = (h: unknown): unknown =>
    (fns.windowMsOfHash as (...a: unknown[]) => unknown)(h);

  it("⭐ 三种写法归一：7d / 7天 / 裸 7 ⇒ 7 天毫秒；无参 ⇒ undefined", () => {
    expect(f("#/today?window=7d")).toBe(7 * 86400000);
    expect(f("#/today?window=7天")).toBe(7 * 86400000);
    expect(f("#/today?window=7")).toBe(7 * 86400000);
    expect(f("#/today")).toBe(undefined);
    expect(f("")).toBe(undefined);
  });

  it("⭐ 非法输入 ⇒ undefined（不解析、不抛，走服务端默认 24h）", () => {
    expect(f("#/today?window=abc")).toBe(undefined);
    expect(f("#/today?window=0d")).toBe(undefined);
    expect(f("#/today?window=-7d")).toBe(undefined);
    expect(f("#/today?window=7.5d")).toBe(undefined); // 非整数天数不猜
    expect(f(null)).toBe(undefined);
  });

  it("⭐ 只认 ?window=，其它 query 一并忽略", () => {
    expect(f("#/today?window=30d&w=1")).toBe(30 * 86400000);
    expect(f("#/replay?window=7d")).toBe(7 * 86400000); // 别的页带同 key 不排斥
    expect(f("#/today?win=7")).toBe(undefined); // 键名不对不认
  });
});

describe("todayCacheHit —— getToday 的缓存命中判据（round352）", () => {
  const f = (c: unknown, force: unknown, w: unknown): unknown =>
    (fns.todayCacheHit as (...a: unknown[]) => unknown)(c, force, w);

  it("⭐ force ⇒ 恒 miss（进入今日页每次重拉，偶数驱动）", () => {
    expect(f({ windowMs: undefined, data: {} }, true, undefined)).toBe(false);
    expect(f({ windowMs: 604800000, data: {} }, true, 604800000)).toBe(false);
  });

  it("⭐ 无窗口读默认缓存：有缓存即命中，不看别的", () => {
    expect(f({ windowMs: undefined, data: {} }, false, undefined)).toBe(true);
    expect(f({ game: "x", data: {} }, false, undefined)).toBe(true);
  });

  it("⭐ 有窗口只命中 windowMs 完全相同的那一份（7 天不命中 30 天）", () => {
    const seven = { windowMs: 604800000, data: {} };
    expect(f(seven, false, 604800000)).toBe(true);
    expect(f(seven, false, 2592000000)).toBe(false); // 7 天 ≠ 30 天
    expect(f({ windowMs: undefined, data: {} }, false, 604800000)).toBe(false);
  });

  it("⭐ 缓存为 null ⇒ miss（首拉 / 被换页清过）", () => {
    expect(f(null, false, undefined)).toBe(false);
    expect(f(null, false, 604800000)).toBe(false);
  });
});

describe("linkText —— 投影连接徽标（round350 补执行证据）", () => {
  const f = (p: unknown): unknown =>
    (fns.linkText as (...a: unknown[]) => unknown)(p);

  it("⭐ 四档逐字钉：live / stale / down / connecting", () => {
    expect(f({ link: "live" })).toBe("实时");
    expect(f({ link: "connecting" })).toBe("连接中");
    expect(f({ link: "stale", resnapshotCount: 3 })).toBe(
      "补洞中（连续出洞 3 次）",
    );
    expect(f({ link: "down", attempt: 2 })).toBe("已断开（第 2 次重连）");
  });

  it("⭐ 未知枚举 ⇒ undefined（调用方 esc 兜住 —— 不许悄悄变成任何一句肯定陈述）", () => {
    expect(f({ link: "unknown" })).toBeUndefined();
    expect(f({ link: undefined })).toBeUndefined();
    expect(f(null)).toBeUndefined();
  });
});

describe("esc —— 全页唯一转义层（round351 补执行证据：144 次调用零直接断言）", () => {
  const f = (s: unknown): unknown =>
    (fns.esc as (...a: unknown[]) => unknown)(s);

  it("⭐ 五个特殊字符逐一转义", () => {
    expect(f("&<>\"'")).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("⭐ 普通文本原样", () => {
    expect(f("hello 世界")).toBe("hello 世界");
  });

  it("⭐ 坏值 ⇒ 空串（String(s ?? '') 兜底：null/undefined ⇒ ''，0/false 不丢）", () => {
    expect(f(null)).toBe("");
    expect(f(undefined)).toBe("");
    expect(f(0)).toBe("0");
    expect(f(false)).toBe("false");
  });
});

describe("money —— §19.3 金额等宽（round351 补执行证据：11 次调用零直接断言）", () => {
  const f = (c: unknown): unknown =>
    (fns.money as (...a: unknown[]) => unknown)(c);

  it("⭐ 整数分 → 美元两位小数", () => {
    expect(f(1234)).toBe("$12.34");
    expect(f(5)).toBe("$0.05");
    expect(f(0)).toBe("$0.00");
  });

  it("⭐ 坏值钳到 $0.00（Number(c ?? 0) 口径：null/undefined ⇒ 0）", () => {
    expect(f(null)).toBe("$0.00");
    expect(f(undefined)).toBe("$0.00");
    expect(f(-5)).toBe("$-0.05");
  });
});

describe("banner —— 提示条（round351 补执行证据：37 次调用零直接断言）", () => {
  const f = (type: unknown, msg: unknown): unknown =>
    (fns.banner as (...a: unknown[]) => unknown)(type, msg);

  it("⭐ 有消息 ⇒ class 带 type + 消息被 esc", () => {
    expect(f("warn", "有 <问题>")).toBe(
      '<div class="admin-banner admin-warn">有 &lt;问题&gt;</div>',
    );
  });

  it("⭐ 无消息 ⇒ 空串（不许画一根空条）", () => {
    expect(f("warn", "")).toBe("");
    expect(f("warn", null)).toBe("");
    expect(f("warn", undefined)).toBe("");
  });
});

describe("rejectHtml —— 422 的人话（round351 补执行证据）", () => {
  const f = (status: unknown, data: unknown): unknown =>
    (fns.rejectHtml as (...a: unknown[]) => unknown)(status, data);

  it("⭐ issues 逐条列 path:message", () => {
    const html = f(422, {
      issues: [
        { path: ["a", "b"], message: "缺 <字段>" },
        { path: null, message: "别的" },
      ],
    }) as string;
    expect(html).toContain("· a.b：缺 &lt;字段&gt;");
    expect(html).toContain("· ?：别的");
    expect(html).toContain("服务端拒了 2 条");
  });

  it("⭐ 无 issues 有 reason ⇒ 单条", () => {
    const html = f(422, { reason: "图没动" }) as string;
    expect(html).toContain("服务端拒了（图没动）：图没动");
  });

  it("⭐ 都没有 ⇒ JSON.stringify 兜底且被 esc", () => {
    const html = f(500, { weird: true }) as string;
    expect(html).toContain("{&quot;weird&quot;:true}");
  });
});

describe("ideaBox —— 意见箱模板（round351 补执行证据：无参固定形状）", () => {
  const f = (): unknown => (fns.ideaBox as () => unknown)();

  it("⭐ 无参固定模板：textarea 存在、placeholder 存在", () => {
    const html = f() as string;
    expect(html).toContain("<textarea");
    expect(html).toContain("data-idea");
    expect(html).toContain("placeholder=");
  });
});

describe("decideRow —— 审批决定行模板（round351 补执行证据）", () => {
  const f = (id: unknown): unknown =>
    (fns.decideRow as (...a: unknown[]) => unknown)(id);

  it("⭐ id 被 esc，三个决定动作都在", () => {
    const html = f("t<1>") as string;
    expect(html).toContain('data-act="t&lt;1&gt;"');
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="reject_with_comment"');
    expect(html).toContain('value="defer_deep_review"');
  });
});

describe("enumSel —— 下拉框（round351 补执行证据：岗位书表单同源）", () => {
  const f = (
    attr: unknown,
    values: unknown,
    def: unknown,
    title: unknown,
  ): unknown =>
    (fns.enumSel as (...a: unknown[]) => unknown)(attr, values, def, title);

  it("⭐ data-f 用 attr、selected 给匹配 def 那档", () => {
    const html = f("scope_type", ["a", "b"], "b", "范围") as string;
    expect(html).toContain('data-f="scope_type"');
    expect(html).toContain("<option>a</option>");
    expect(html).toContain("<option selected>b</option>");
    expect(html).toContain('title="范围"');
  });
});

describe("batchPicked —— 批量勾选过滤（round351 补执行证据）", () => {
  const f = (cards: unknown, sel: unknown): unknown =>
    (fns.batchPicked as (...a: unknown[]) => unknown)(cards, sel);

  it("⭐ 只留 pending 且被勾中的卡", () => {
    const cards = [
      { id: "a", status: "pending" },
      { id: "b", status: "pending" },
      { id: "c", status: "approved" },
    ];
    const out = f(cards, ["a"]) as Array<{ id: string }>;
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("⭐ 坏入参 ⇒ 空数组（不抛：Array.isArray 兜底）", () => {
    expect(f(null, null)).toEqual([]);
    expect(f([], ["x"])).toEqual([]);
  });
});

describe("linesOf —— 多行 textarea 取值（round351 补执行证据）", () => {
  const f = (el: unknown): unknown =>
    (fns.linesOf as (...a: unknown[]) => unknown)(el);

  it("⭐ value 拆行、trim、滤空", () => {
    expect(f({ value: "a\n  b  \n\nc" })).toEqual(["a", "b", "c"]);
  });

  it("⭐ 空 ⇒ []", () => {
    expect(f({ value: "" })).toEqual([]);
  });
});

describe("safe —— JSON 容错解析（round351 补执行证据）", () => {
  const f = (s: unknown): unknown =>
    (fns.safe as (...a: unknown[]) => unknown)(s);

  it("⭐ 好串 ⇒ 解析值", () => {
    expect(f('{"a":1}')).toEqual({ a: 1 });
  });

  it("⭐ 坏串 ⇒ null（不抛）", () => {
    expect(f("not json")).toBeNull();
    expect(f("")).toBeNull();
  });
});

describe("notesHtml —— 口径说明（round351 补执行证据）", () => {
  const f = (notes: unknown): unknown =>
    (fns.notesHtml as (...a: unknown[]) => unknown)(notes);

  it("⭐ 有 notes ⇒ details + 条数 + esc 每条", () => {
    const html = f(["有 <x>", "two"]) as string;
    expect(html).toContain("<summary>口径说明 · 2 条</summary>");
    expect(html).toContain("· 有 &lt;x&gt;");
    expect(html).toContain("· two");
  });

  it("⭐ 无 notes ⇒ 空串（不画空 details）", () => {
    expect(f(null)).toBe("");
    expect(f([])).toBe("");
  });
});

describe("replayTimeline —— 回放时间线壳（round351 补执行证据）", () => {
  const f = (entries: unknown): unknown =>
    (fns.replayTimeline as (...a: unknown[]) => unknown)(entries);

  it("⭐ 有事件 ⇒ tl 容器（委托 eventRow 渲染）", () => {
    const html = f([{ action: "approval_created" }]) as string;
    expect(html).toContain('<div class="admin-tl">');
    expect(html).toContain("</div>");
  });

  it("⭐ 空 ⇒ 「还没有事件。」", () => {
    expect(f([])).toBe('<div class="admin-meta">还没有事件。</div>');
  });
});

describe("parseAdminHash —— 两个入口共用的唯一 hash 解析（round370）", () => {
  const f = (h: unknown): { page: string; query: string } =>
    (fns.parseAdminHash as (x: unknown) => { page: string; query: string })(h);

  it("⭐ 独立页与工作台两种前缀认同一个页名（少一支就是两套路由表）", () => {
    expect(f("#/today")).toEqual({ page: "today", query: "" });
    expect(f("#/admin/today")).toEqual({ page: "today", query: "" });
    expect(f("#/admin/board")).toEqual({ page: "board", query: "" });
    expect(f("budget")).toEqual({ page: "budget", query: "" });
  });

  it("⭐ query 从页名里剥出来（window / id 那一半的落点）", () => {
    expect(f("#/today?window=7d")).toEqual({
      page: "today",
      query: "window=7d",
    });
    expect(f("#/admin/replay?id=ev-1")).toEqual({
      page: "replay",
      query: "id=ev-1",
    });
    // 独立页形状也要能拆出 query（原来只有工作台需要，两条分支都得通）。
    expect(f("#/today?window=30d")).toEqual({
      page: "today",
      query: "window=30d",
    });
  });

  it("⭐ 前缀只在开头剥一次，页名里再出现 admin/ 不许被吃掉", () => {
    // 失效形状：把 replace 写成不带 ^ 的全局替换 ⇒ "#/admin/x/admin/y" 少一段。
    expect(f("#/admin/x/admin/y")).toEqual({ page: "x/admin/y", query: "" });
  });

  it("⭐ 空 / null / 只有前缀 ⇒ 空页名（由调用方回到 today，这里不猜）", () => {
    expect(f("")).toEqual({ page: "", query: "" });
    expect(f(null)).toEqual({ page: "", query: "" });
    expect(f("#/admin/")).toEqual({ page: "", query: "" });
    expect(f("#/admin")).toEqual({ page: "", query: "" });
  });

  it("⭐ 页名不认得时【不在这里判】—— 名单归 ROUTES，这里只拆串", () => {
    // 这一发钉的是职责边界：若有人在这里加「不认识就返回 today」，
    // syncAdminFromHash 的 return false（= 这条 hash 不归管理视图）就永远不为真，
    // 工作台切到 #/messages 时会把消息路由误吞成管理视图。
    expect(f("#/messages")).toEqual({ page: "messages", query: "" });
    const pages = (loaded.api.ROUTES as { id: string }[]).map((r) => r.id);
    expect(pages).not.toContain("messages");
  });
});

describe("windowMsOfHash —— 挂载后传的是裸 query（round370）", () => {
  const f = (h: unknown): unknown =>
    (fns.windowMsOfHash as (...a: unknown[]) => unknown)(h);

  it("⭐ 不带 ? 的裸 query 也要认（renderToday 现在传 parseAdminHash 的 query 半）", () => {
    expect(f("window=7d")).toBe(7 * 86400000);
    expect(f("window=30d")).toBe(30 * 86400000);
    // 空 query ⇒ undefined（走服务端默认 24h），不是 0 也不是 NaN。
    expect(f("")).toBe(undefined);
  });

  it("⭐ 两种形状同时通 ⇒ 少一种会当场红，而不是静默恒 24h", () => {
    // 正向对照：带 ? 的整条 hash 仍旧解析（独立页那条路没被换掉）。
    expect(f("#/today?window=7d")).toBe(7 * 86400000);
    // 反向对照：裸 query 里键名不对照样不认（证明不是"退化成宽泛匹配"）。
    expect(f("win=7d")).toBe(undefined);
  });
});

describe("挂载 API —— 工作台 import 得到的是四个真家伙（round370）", () => {
  it("⭐ 文件末尾的 export 块里有这四个名字（少了＝工作台 import 到 undefined）", () => {
    expect(loaded.exportedNames).toContain("mountAdmin");
    expect(loaded.exportedNames.includes("unmountAdmin")).toBe(true);
    expect(loaded.exportedNames.includes("syncAdminFromHash")).toBe(true);
    // 第四个是 `ROUTES as ADMIN_PAGES`：装载器取的是【本地名】，
    // 所以这里查 ROUTES —— 查 ADMIN_PAGES 会红，而那条红是假的。
    expect(loaded.exportedNames.includes("ROUTES")).toBe(true);
    // 第五个是 currentPage：中间列表栏的选中态要跟【真正渲染着】的那一页，
    // 手打的未知页名不算。少了这个 export，宿主拿 undefined、选中态退回 hash
    // 读数 —— 屏幕在今日页、列表却高亮着一行没有的页。
    expect(loaded.exportedNames.includes("currentPage")).toBe(true);
  });

  it("⭐ 运行时形状：三个是函数，ROUTES 是非空数组（挂载点靠它渲染中间栏）", () => {
    expect(typeof loaded.api.mountAdmin).toBe("function");
    expect(typeof loaded.api.unmountAdmin).toBe("function");
    expect(typeof loaded.api.syncAdminFromHash).toBe("function");
    expect(typeof loaded.api.currentPage).toBe("function");
    // 装载器的 location.hash 是 "#/today" ⇒ 初始页必须是 today。这一发把「导出了
    // 一个名字但返回的不是当前页」（比如恒 "today" 的常量替身）也一起钉住。
    expect((loaded.api.currentPage as () => string)()).toBe("today");
    expect(Array.isArray(loaded.api.ROUTES)).toBe(true);
    // 七页都在，且 id 唯一：中间列表栏直接吃这份名单。
    const pages = (loaded.api.ROUTES as { id: string; label: string }[]).map(
      (r) => r.id,
    );
    expect(pages).toEqual([
      "today",
      "board",
      "inbox",
      "org",
      "charter",
      "budget",
      "replay",
    ]);
    expect(new Set(pages).size).toBe(pages.length);
  });
});
