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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAppJs, type AppExports } from "./app-loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = resolve(HERE, "..", "..", "packages/web/public/app.js");

let fns: AppExports;
beforeAll(() => {
  const loaded = loadAppJs(APP_JS);
  fns = loaded.fns;
  // 顶层抛不抛【不判】—— 装载器文件头那条。这里只把它说出来，让人看见跑到哪。
  // 把它判成失败会导致下一个人去把 app.js 的入口改成懒执行，那是测试形状改产品。
  if (loaded.topError !== null) {
    console.log("（app.js 顶层停在：" + loaded.topError.message.slice(0, 80) + "）");
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
  const f = (x: Record<string, unknown>) => (fns.meterPct as (y: unknown) => string)(b(x));

  it("常规情形：分子累计已花、分母已声明上限合计", () => {
    expect(f({ consumed_total_cents: 5000, declared_task_limits_cents: 20000, declared_scopes: 1 })).toBe("25%");
  });

  it("⭐ 一行预算都没设过 ⇒ 0%，而不是半根条", () => {
    // 这是这一发存在的理由：分母为 0 时如果按除法会得到 NaN/Infinity，
    // 而 NaN 走到 style="width:NaN%" 是【浏览器静默忽略】——
    // 屏幕上会出现一根【满长】的条（CSS 默认宽度），读起来是"预算花光了"。
    expect(f({ consumed_total_cents: 9999, declared_task_limits_cents: 0, declared_scopes: 0 })).toBe("0%");
    expect(f({ consumed_total_cents: 0, declared_scopes: 0 })).toBe("0%");
  });

  it("⭐ 超限钳到 100%（条画不出去，「超了」由文字与红色说）", () => {
    const got = f({ consumed_total_cents: 30000, declared_task_limits_cents: 10000, declared_scopes: 2 });
    expect(got).toBe("100%");
    expect(got).not.toContain("300");
  });

  it("反向对照：分母有值而消费为 0 ⇒ 真的是 0%，不是 undefined%", () => {
    expect(f({ consumed_total_cents: 0, declared_task_limits_cents: 10000, declared_scopes: 1 })).toBe("0%");
  });

  it("输出永远形如 <整数>% —— 没有 NaN / Infinity / 小数能漏进 style", () => {
    const cases = [
      {},
      { declared_scopes: 1, declared_task_limits_cents: 3, consumed_total_cents: 1 },
      { declared_scopes: 1, declared_task_limits_cents: -5, consumed_total_cents: 100 },
      { declared_scopes: -1, declared_task_limits_cents: 100, consumed_total_cents: 100 },
      { declared_scopes: 1, declared_task_limits_cents: 7, consumed_total_cents: 999999 },
    ];
    for (const c of cases) {
      const got = f(c);
      expect(/^\d+%$/u.test(got), JSON.stringify(c) + " ⇒ " + got).toBe(true);
      expect(got).not.toContain("NaN");
    }
  });
});

describe("overBudget —— 触及预算是【算术】，不是状态判定", () => {
  const f = (x: Record<string, unknown>) => (fns.overBudget as (y: unknown) => boolean)({ budget_cents: null, consumed_cents: 0, ...x });

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
    const got = (fns.blockedTitle as (x: unknown) => string)({ blocked_statuses: ["BUDGET_PAUSED", "BLOCKED"] });
    expect(got).toContain("BUDGET_PAUSED");
    expect(got).toContain("BLOCKED");
  });

  it("⭐ 清单缺失时不显示空括号（老服务端 / 字段没发）", () => {
    for (const t of [{}, { blocked_statuses: [] }, { blocked_statuses: null }]) {
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
    (fns.taskCard as (a: unknown, b: boolean, c: boolean) => string)(tk, isAttention, isDecision);

  it("⭐ 阻塞（列成员）不琥珀：规格四处明写预算暂停非琥珀", () => {
    const got = card(true, false);
    expect(got).toContain("tk flag");
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
    const got = (fns.taskCard as (a: unknown, b: boolean, c: boolean) => string)(evil, false, false);
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
    (fns.approvalCard as (a: unknown, n: number, c: boolean, d: boolean) => string)(x, 2, true, isDecision);

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
    expect(card(a({ approval_type: "budget_override" }), false)).toContain("data-act");
  });
});

describe("budgetHtml —— 那根条与那句近似声明", () => {
  const html = (over: Record<string, unknown>) =>
    (fns.budgetHtml as (x: unknown) => string)({ budget: b(over), window_ms: 86_400_000, as_of_ms: 1 });

  it("⭐ 超限时条变红，并且【同屏】写明它不是规格 §7.4 那根「日」条", () => {
    const got = html({ consumed_total_cents: 30000, declared_task_limits_cents: 10000, declared_scopes: 1 });
    expect(got).toContain("budgetover");
    expect(got).toContain("meter over");
    expect(got).toContain("累计");
  });

  it("没超限 ⇒ 不加过红类（否则红恒在，等于没有红）", () => {
    const got = html({ consumed_total_cents: 100, declared_task_limits_cents: 10000, declared_scopes: 1 });
    expect(got).not.toContain("budgetover");
  });

  it("⭐ 警报已哑那一格用灰、不用琥珀也不用红", () => {
    const got = html({ silent_over_scopes: 2, declared_scopes: 1, declared_task_limits_cents: 100 });
    expect(got).toContain("警报已哑");
    expect(got).toContain("s-gray");
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
    expect(f("DELIVERED")).toBe("s-green");
    expect(f("ARCHIVED")).toBe("s-gray");
    expect(f("REJECTED_DOWNWARD")).toBe("s-red");
    expect(f("IN_REVIEW")).toBe("s-blue");
  });

  it("⭐ 任何输入都不许产出琥珀 —— 连 BUDGET_PAUSED / ESCALATED_TO_CEO 也不行", () => {
    // 这一发守的是"配色函数不许变成判据"那条线：
    // 哪天有人觉得"升级态顺手涂个琥珀挺自然"，这里红。
    for (const s of ["ESCALATED_TO_CEO", "BUDGET_PAUSED", "BLOCKED", "MEETING_REQUIRED", "", "deliver"]) {
      expect(f(s), s).not.toContain("amber");
    }
  });
});

describe("hierarchyColumns / groupByDepth —— 列由 reports_to 派生（不许有任务凭空消失）", () => {
  type Nodes = Record<string, { reports_to?: string | null }>;
  const cols = (n: Nodes) => (fns.hierarchyColumns as (x: unknown) => unknown[])(n);
  const group = (tasks: unknown[], c: unknown) => (fns.groupByDepth as (t: unknown[], x: unknown) => Array<{ items: unknown[] }>)(tasks, c);

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
      for (const name of ["助理", "执行", "运营"]) expect(String(c.label)).not.toContain(name);
    }
  });

  it("⭐ 环不许把进程卡死，也不许让卡片凭空消失", () => {
    const cyc: Nodes = { a: { reports_to: "b" }, b: { reports_to: "a" } };
    const got = cols(cyc);
    expect(got.length).toBeGreaterThan(0);
    const t = [{ assigned_role: "a", updated_at: 1 }, { assigned_role: "b", updated_at: 1 }];
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
  const ON = { enabled: true, pumping: true, task_limit_cents: 500, stopped: [] };

  it("⭐ 开着、在推、没人被丢下 ⇒ 不打扰（这是唯一该沉默的一档）", () => {
    expect(notice(ON)).toBeNull();
  });

  it("⭐ 没开驱动器 ⇒ 说话，而不是画一张空名单", () => {
    const n = notice({ enabled: false, pumping: false, task_limit_cents: null, stopped: [] });
    expect(n).not.toBeNull();
    expect(n?.level).toBe("warn");
    // 这一发的实质：库里【没有】被放弃的任务时（stopped 为空）也必须有话。
    // 少了它，"这台 Hub 从不推东西"与"一切正常"在屏幕上同形 —— 那正是 0048 要消灭的形状。
    expect(n?.msg).toContain("--driver-pump");
  });

  it("⭐ 心跳停了 ⇒ 比【没开】更响一档，且不伪装成没开", () => {
    const n = notice({ enabled: true, pumping: false, task_limit_cents: 500, stopped: [] });
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
        { task_id: "a", cause: "at_limit", attempts: 3, max_attempts: 3, since_ms: 1 },
        { task_id: "b", cause: "no_budget", attempts: null, max_attempts: null, since_ms: 1 },
        { task_id: "c", cause: "no_budget", attempts: null, max_attempts: null, since_ms: 1 },
      ],
    });
    expect(n?.msg).toContain("3 条");
    expect(n?.msg).toContain("1 条试到上限");
    expect(n?.msg).toContain("2 条被花钱的门挡住");
  });

  it("⭐ stopped 不是数组（服务端形状坏了）⇒ 说「未知」而【不是】「一切正常」", () => {
    const n = notice({ enabled: true, pumping: true, task_limit_cents: 500, stopped: null });
    // 今天读侧恒发数组，所以这一档不可达。它在这里是因为整个函数的立场是
    // 「每一种没有都要说出它是哪一种」，而 `?? []` 会把"响应坏了"读成"没有异常"。
    expect(n).not.toBeNull();
    expect(n?.msg).toContain("未知");
  });
});

describe("driverLine —— 卡片上那一行只排字符，不重判", () => {
  const NOW = 1_700_000_000_000;
  const line = (id: string, d: unknown): string =>
    (fns.driverLine as (a: string, b: unknown, c: number) => string)(id, d, NOW);
  const MIN = 60_000;

  const drv = (stopped: unknown[]) => ({ enabled: true, pumping: true, task_limit_cents: 500, stopped });
  const limit = { task_id: "t1", cause: "at_limit", attempts: 3, max_attempts: 3, since_ms: NOW - 10 * MIN };
  const budget = { task_id: "t2", cause: "no_budget", attempts: null, max_attempts: null, since_ms: NOW - 30 * MIN };

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
    for (const fake of ["追加预算", "提高预算", "提高上限", "加预算", "放开预算", "点此"]) {
      expect(b, fake).not.toContain(fake);
    }
    // 必须说清这一步【不在屏幕上】，并且给出此刻真有效的那一步的名字。
    expect(b).toContain("重启");
    expect(b).toContain("--task-limit-cents");
    // 两个"上限"必须可分辨：这一行的数来自命令行，不是 budgets 那一列。
    expect(b).toContain("命令行");
  });

  it("⭐ 数字缺失时不拼出 undefined/3 那种东西", () => {
    const got = line(
      "t3",
      drv([{ task_id: "t3", cause: "at_limit", attempts: null, max_attempts: null, since_ms: NOW - MIN }]),
    );
    expect(got).not.toContain("undefined");
    expect(got).not.toContain("null");
    expect(got).toContain("试到上限");
  });

  it("时刻缺失 ⇒ 一个破折号而不是 0 秒前 / NaN", () => {
    const got = line("t4", drv([{ task_id: "t4", cause: "no_budget", since_ms: 0 }]));
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
    const card = (fns.taskCard as (a: unknown, b: boolean, c: boolean, d?: string) => string)(
      { id: "t5", title: "x", status: "IN_PROGRESS", assigned_role: "dev", updated_at: NOW, consumed_cents: 0, budget_cents: null },
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
