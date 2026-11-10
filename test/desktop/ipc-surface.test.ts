/**
 * Task 2.2 的 Test 项（计划原文）：
 *   test/desktop/ipc-surface.test.ts 断言 preload 暴露的方法集合【等于】白名单
 *   —— 多一个少一个都失败，防止未来随手加一个 dbQuery。
 *
 * ── 这条断言最容易写成的样子是【恒绿】的，本文件的篇幅大多花在防它 ──────
 * 若 preload 的那个对象是从白名单【算】出来的（Object.fromEntries(WHITELIST.map(…))），
 * 两边永远相等，而「随手加一个 dbQuery」在代码上就表现为【往白名单加一行】——
 * 加完两侧一起变，测试一字不变地通过。计划点名要防的动作，
 * 恰好是这个断言唯一测不到的动作。
 *
 * 所以需要三件事，缺一不可，本文件三条都有：
 *  ① 相等断言本身（两侧取自两个不同的源：运行时对象 vs 契约表）；
 *  ② 一条【canary】：手动注入一个 dbQuery，期望它【被抓住】——
 *     这证明 ① 真的会红，而不是一条只会绿的装饰；
 *  ③ 一条【结构】断言：preload 的源文件【不得 import 白名单模块】——
 *     这防的是「将来有人觉得两份重复难看，顺手改成从白名单生成」，
 *     那一刻 ① 悄悄变成恒绿，而【没有任何测试会变红】，除了这一条。
 *
 * electron / electron-vite 本机装不上，所以本文件测的是【边界本身】：
 * 方法表、参数闸门、源码里不得出现的能力。那三样都跟 electron 的 API 无关，
 * 而 electron 那层胶水（contextBridge.exposeInMainWorld 一行）薄到允许不测。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { API_ENDPOINTS, IMPLEMENTED_ENDPOINTS } from "@opc/contracts";
import {
  BANNED_IN_RENDERER_FACING,
  CHANNEL_SPECS,
  checkArgs,
  channelFor,
  EXPOSED_ENDPOINTS,
  specOf,
} from "../../packages/desktop/src/ipc-surface.js";
import {
  type MainDeps,
  dispatch,
  toPushPayload,
} from "../../packages/desktop/src/main/channels.js";
import {
  createExposedApi,
  EVENT_CHANNEL,
  type RendererBridge,
} from "../../packages/desktop/src/preload/api.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const PRELOAD_SRC = join(REPO, "packages/desktop/src/preload/api.ts");
const MAIN_SRC = join(REPO, "packages/desktop/src/main/channels.ts");

/** 记录每一次 invoke 的假 ipcRenderer，兼作「渲染进程实际能触达什么」的证据。 */
function fakeIpc(): { calls: { channel: string; args: unknown[] }[]; bridge: RendererBridge } {
  const calls: { channel: string; args: unknown[] }[] = [];
  return {
    calls,
    bridge: {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
        return { ok: true };
      },
      on: () => {
        throw new Error("on 不该被 invoke 路径用到");
      },
      removeListener: () => {},
    },
  };
}

describe("IPC 暴露面 = 白名单", () => {
  it("暴露的方法集合【恰好等于】白名单里的 invoke 通道（多一个少一个都失败）", () => {
    const api = createExposedApi(fakeIpc().bridge);
    const exposed = Object.keys(api)
      .filter((k) => typeof (api as Record<string, unknown>)[k] === "function")
      .filter((k) => k !== "onHubEvent") // 推送订阅不是 invoke 通道，单独一条测
      .sort();
    const expected = CHANNEL_SPECS.filter((s) => s.kind === "invoke")
      .map((s) => INVOKE_METHODS[s.channel])
      .sort();
    expect(exposed).toEqual(expected);
  });

  it("canary：注入一个 dbQuery，上面那条【必须】变红", () => {
    // 这一条是整个文件的存在理由。没有它，上面那条相等断言与「恒绿的写法」
    // 在绿屏上【看不出区别】—— 而本仓对假绿的态度是一贯的（0006 §7 那一族）。
    const api = createExposedApi(fakeIpc().bridge) as Record<string, unknown>;
    const withBackdoor = { ...api, dbQuery: (sql: string) => sql };
    const exposed = Object.keys(withBackdoor)
      .filter((k) => typeof withBackdoor[k] === "function")
      .filter((k) => k !== "onHubEvent")
      .sort();
    const expected = CHANNEL_SPECS.filter((s) => s.kind === "invoke")
      .map((s) => INVOKE_METHODS[s.channel])
      .sort();
    expect(exposed).not.toEqual(expected);
    expect(exposed).toContain("dbQuery");
  });

  it("结构守卫：preload 源文件【不得 import 白名单模块】", () => {
    // 见文件头 ③。这条防的是未来那次「两份重复太难看，改成从白名单生成」的重构 ——
    // 那次重构会让第一条断言【悄悄变成恒绿】，而它是本文件唯一的红绿信号。
    const src = readFileSync(PRELOAD_SRC, "utf8");
    expect(src).not.toMatch(/from\s+["'][^"']*ipc-surface(\.js)?["']/u);
    // 反向也钉：白名单那一侧也不得 import preload（否则又并回一处）。
    const surfaceSrc = readFileSync(
      join(REPO, "packages/desktop/src/ipc-surface.ts"),
      "utf8",
    );
    expect(surfaceSrc).not.toMatch(/from\s+["'][^"']*preload\/api(\.js)?["']/u);
  });

  it("方法名→通道的映射表覆盖全部 invoke 通道（这张表自身不许漏项）", () => {
    // INVOKE_METHODS 是本测试文件【自己】的手写表 —— 也就是说它自己也是一处漂移点：
    // 漏一个方法名会让第一条断言把【真实存在的方法】判成多余而变红（能发现），
    // 但把名字【写错】会让两边同时不含那个名字而【假绿】。所以这里单独对账一次。
    const invokeChannels = CHANNEL_SPECS.filter((s) => s.kind === "invoke").map((s) => s.channel);
    expect(new Set(Object.keys(INVOKE_METHODS))).toEqual(new Set(invokeChannels));
    const api = createExposedApi(fakeIpc().bridge) as Record<string, unknown>;
    for (const name of Object.values(INVOKE_METHODS)) {
      expect(typeof api[name]).toBe("function");
    }
  });
});

describe("通道与端点对齐", () => {
  it("每个暴露的端点都在契约清单里，且【只暴露已实现的】", () => {
    for (const s of CHANNEL_SPECS) {
      expect(API_ENDPOINTS).toContain(s.endpoint);
      expect(IMPLEMENTED_ENDPOINTS).toContain(s.endpoint);
    }
    // 未实现的端点【不进白名单】（理由见 ipc-surface.ts 的 EXPOSED_ENDPOINTS 注释）。
    expect(EXPOSED_ENDPOINTS).toEqual(IMPLEMENTED_ENDPOINTS);
    expect(channelFor("GET /replay/:taskId")).toBeNull();
  });

  it("通道名不重复，且【恰好一个】推送通道", () => {
    const channels = CHANNEL_SPECS.map((s) => s.channel);
    expect(new Set(channels).size).toBe(channels.length);
    expect(CHANNEL_SPECS.filter((s) => s.kind === "push").length).toBe(1);
    // 事件是【推送】而不是 invoke。写成 invoke 的那次 invoke 永远不 resolve
    // （SSE 响应不结束），渲染进程是一个恒挂的 Promise，界面表现为「连上了，什么都不动」。
    expect(specOf(EVENT_CHANNEL)).toBeNull();
    expect(specOf("hub:createTask")?.kind).toBe("invoke");
    expect(specOf("nope")).toBeNull();
  });

  it("每个 invoke 方法真的打到【它自己那条】通道（不是全都打到第一条）", async () => {
    // 这类「包装函数体复制粘贴忘了改通道名」的错，在只断言方法名的测试里【全绿】。
    const f = fakeIpc();
    const api = createExposedApi(f.bridge);
    await api.createTask({ idea: "x" });
    await api.listTasks();
    await api.getTask({ taskId: "t-1" });
    await api.decideApproval({ approvalId: "a-1", resume: "approve" });
    expect(f.calls.map((c) => c.channel)).toEqual([
      "hub:createTask",
      "hub:listTasks",
      "hub:getTask",
      "hub:decideApproval",
    ]);
  });

  it("preload【不吞错误】：Hub 的reject 原样冒到渲染进程", async () => {
    // 在 preload 里 try/catch 吞掉错误，症状是 UI「点了没反应」而 Hub 日志里
    // 躺着一条清楚的 422 —— 错误在半路被吃掉，比多写一行 catch 贵得多。
    const api = createExposedApi({
      invoke: async () => {
        throw new Error("422 idea 非法");
      },
      on: () => {},
      removeListener: () => {},
    });
    await expect(api.createTask({ idea: "" })).rejects.toThrow("422 idea 非法");
  });

  it("onHubEvent 返回的退订函数【真的摘掉】了监听器", () => {
    const removed: string[] = [];
    let added = 0;
    const api = createExposedApi({
      invoke: async () => ({}),
      on: () => {
        added += 1;
      },
      removeListener: () => {
        removed.push("hub:event");
      },
    });
    const off = api.onHubEvent(() => {});
    expect(added).toBe(1);
    off();
    expect(removed).toEqual(["hub:event"]);
    // React 组件重挂十次而不退订，会留下十个活着的监听器；而 Task 2.3 的幂等投影
    // 会把重复帧按 seq 吃掉 ⇒ 功能上【看不出来】，只在内存上长。
    // 所以「有退订函数」这件事必须由一条断言钉住，而不是靠 API 形状看着像。
  });
});

describe("参数闸门", () => {
  const idea = specOf("hub:createTask")!;
  const task = specOf("hub:getTask")!;
  const decide = specOf("hub:decideApproval")!;
  const none = specOf("hub:listTasks")!;

  it("合法参数通过", () => {
    expect(checkArgs(idea, { idea: "做个接单系统" })).toBeNull();
    expect(checkArgs(task, { taskId: "task-1" })).toBeNull();
    expect(checkArgs(decide, { approvalId: "a-1", resume: "approve" })).toBeNull();
    expect(checkArgs(none, undefined)).toBeNull();
  });

  it("未登记的键【当场拒】，而不是挑我要的字段", () => {
    // 「白名单式提取」（只取 idea，别的一律不看）看着无害，实际是让
    // { idea, sql: "drop table" } 静静穿过主进程；哪天下游把多余字段并进 body 它就活了。
    // 当场拒，故障落在【引入它的那次改动】上。
    expect(checkArgs(idea, { idea: "x", sql: "drop table" })).toMatch(/多出/u);
    expect(checkArgs(task, { taskId: "t-1", extra: 1 })).toMatch(/多出/u);
  });

  it("无参通道【不接受】参数，不是默默丢掉", () => {
    expect(checkArgs(none, { anything: 1 })).toMatch(/不接受参数/u);
  });

  it("id 形状非法 ⇒ 拒（它会被拼进 URL 路径）", () => {
    for (const bad of ["", "../etc/passwd", "a/b", "a?x=1", "a b", "#frag", "x".repeat(65)]) {
      expect(checkArgs(task, { taskId: bad })).toMatch(/形状非法/u);
    }
  });

  it("resume 取值非法 ⇒ 拒；三个合法取值都过", () => {
    expect(checkArgs(decide, { approvalId: "a-1", resume: "approve_all" })).toMatch(/resume/u);
    for (const r of ["approve", "reject_with_comment", "defer_deep_review"] as const) {
      expect(checkArgs(decide, { approvalId: "a-1", resume: r, note: "n" })).toBeNull();
    }
  });

  it("idea 的空/超长判据与 contracts 【同源】，不在这里重写数值", () => {
    expect(checkArgs(idea, { idea: "   " })).toMatch(/不得为空/u);
    expect(checkArgs(idea, { idea: "x".repeat(4001) })).toMatch(/超过 4000/u);
    // 「4000」这个数字必须是从 contracts 引进来的，不是这里手抄的：
    // 两处各写一遍，改一处就得到「IPC 放过、HTTP 拒」——
    // 渲染进程收到一个它【已经校验过】的东西报的 422，最误导人那种。
    const src = readFileSync(join(REPO, "packages/desktop/src/ipc-surface.ts"), "utf8");
    expect(src).toMatch(/MAX_IDEA = MAX_IDEA_CHARS/u);
    expect(src).toMatch(/RESUME = new Set<string>\(RESUME_VALUES\)/u);
  });

  it("报错文案【不回显】收到的值原文（值可能攻击者可控，会进主进程日志）", () => {
    const secret = "SECRET-PAYLOAD-DO-NOT-LOG";
    const why = checkArgs(idea, { idea: "ok", [secret]: 1 });
    expect(why).not.toContain(secret);
    expect(why).toMatch(/键/u); // 但要说清「多了几个键」，否则不可定位
  });
});

describe("渲染进程侧的硬边界（§5.6.1）", () => {
  /**
   * 扫描器。八行，写在测试文件里 —— 但【名单与理由】住在 ipc-surface.ts，
   * 因为「要放行某一项」应当是一次对源文件的、可 review 的改动，
   * 而不是测试文件里悄悄删掉一行。
   *
   * 返回命中的 needle 列表（而不是布尔），这样下面既能断言「真源码 0 命中」，
   * 也能逐条断言「造一次违规就恰好命中它」—— 后者是这条守卫唯一的【有效性】证据。
   */
  function scan(src: string): string[] {
    return BANNED_IN_RENDERER_FACING.filter((b) => src.includes(b.needle)).map((b) => b.needle);
  }

  it("preload 与主进程分发层【零命中】", () => {
    // 两个文件都扫：preload 是渲染进程唯一能碰的代码，而主进程这一层
    // 按设计只是【一个签名代理】，它同样不该拿到库或磁盘。
    // 把 main 一起扫，是为了让「将来有人觉得在主进程读一下库更省事」
    // 这件事【当场变红】，而不是等到有人问「桌面端怎么绕过 HTTP 面了」。
    for (const [file, marker] of [
      [PRELOAD_SRC, "createExposedApi"],
      [MAIN_SRC, "export async function dispatch"],
    ] as const) {
      const src = readFileSync(file, "utf8");
      // src 为空串时对任何 not.toContain 都成立，且 scan 也返回 [] ——
      // 那是本类守卫最典型的假绿（读错路径 / 文件被移走都会是这个形状）。
      // 所以先钉「确实读到了东西、且读的是对的文件」。
      expect(src.length, file).toBeGreaterThan(500);
      expect(src, file).toContain(marker);
      expect(scan(src), file).toEqual([]);
    }
  });

  it("canary：每项 needle 都【真的拦得住】一次真实违规", () => {
    // 只验 needle「长得像样」（长度、无空格）是不够的：那几条断言对一个
    // 拼错了、永远匹配不到任何东西的 needle 同样成立，而那样的守卫【恒绿】。
    // 真问题只有一个 ——「有人真写了这行越界代码，守卫会不会红」。
    // 所以逐条造一次违规、喂进【同一个】 scan，并要求【恰好命中它自己那一条】
    // （恰好一条，而不是「至少一条」：命中两条说明名单里有重叠项，
    //  将来删一项会悄悄让另一项替它绿着）。
    expect(BANNED_IN_RENDERER_FACING.length).toBeGreaterThan(0);
    for (const b of BANNED_IN_RENDERER_FACING) {
      const hits = scan(`import { x } from "${b.needle}";`);
      expect(hits, `needle 未能拦住 import：${b.needle}`).toEqual([b.needle]);
      // why 必须自带完整理由。写「同上」的那一项，正是将来要加豁免的人
      // 唯一能看见的上下文，而上一条大概率已经被删了。
      expect(b.why.length, `why 不足以支撑一次豁免判断：${b.needle}`).toBeGreaterThan(12);
      expect(b.why).not.toMatch(/^同上/u);
    }
  });

  it("反向 canary：扫描通路【确实会红】，不是恒返回空", () => {
    // 上一条逐条验 needle；这条验 scan 本身（万一 filter 写成了永远 false，
    // 上一条也会跟着全绿 —— 因为它们共用它）。两条一起才把「守卫本身坏了」堵住。
    for (const b of BANNED_IN_RENDERER_FACING) {
      expect(scan(`import { x } from "${b.needle}";`), b.needle).toEqual([b.needle]);
    }
    expect(scan("export const nothing = 1;")).toEqual([]);
  });
});

/**
 * 通道 → 暴露方法名。【测试文件自己】的手写表，与两侧都独立。
 * 它自己也构成一处漂移点，所以由上面那条「覆盖全部 invoke 通道」专门对账。
 */
const INVOKE_METHODS: Record<string, string> = {
  "hub:createTask": "createTask",
  "hub:listTasks": "listTasks",
  "hub:getTask": "getTask",
  "hub:decideApproval": "decideApproval",
};

/* ───────────────── 主进程侧分发（Task 2.2 的 src/main 半边） ───────────────── */

describe("主进程分发", () => {
  const fetchReturning = (
    status: number,
    body: unknown,
  ): { calls: { path: string; method: string; body?: string }[]; signedFetch: MainDeps["signedFetch"] } => {
    const calls: { path: string; method: string; body?: string }[] = [];
    return {
      calls,
      signedFetch: async (path, init) => {
        calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
        return { status, bodyText: typeof body === "string" ? body : JSON.stringify(body) };
      },
    };
  };

  it("四个 invoke 通道映射到【正确的端点与方法】", async () => {
    const f = fetchReturning(200, { id: "t-1" });
    const deps: MainDeps = { signedFetch: f.signedFetch };
    await dispatch(deps, "hub:createTask", { idea: "x" });
    await dispatch(deps, "hub:listTasks", undefined);
    await dispatch(deps, "hub:getTask", { taskId: "t-9" });
    await dispatch(deps, "hub:decideApproval", { approvalId: "a-9", resume: "approve" });
    expect(f.calls.map((c) => c.method + " " + c.path)).toEqual([
      "POST /tasks",
      "GET /tasks",
      "GET /tasks/t-9",
      "POST /approvals/a-9",
    ]);
  });

  it("闸门在【分发之前】：非法参数根本不产生 HTTP 请求", async () => {
    // 顺序反了的话，一条形状非法的参数会先打到 Hub 再被拒 ——
    // 那不只是浪费一次往返，而是让「渲染进程能以合法签名发任意请求」这件事
    // 变成可能，因为签名发生在发请求之前。
    const f = fetchReturning(200, {});
    const res = await dispatch({ signedFetch: f.signedFetch }, "hub:getTask", { taskId: "../x" });
    expect(res.ok).toBe(false);
    expect(f.calls.length).toBe(0);
  });

  it("未知通道 ⇒ 拒，不转发（window 上能拼任意通道名）", async () => {
    const f = fetchReturning(200, {});
    const res = await dispatch({ signedFetch: f.signedFetch }, "hub:anything", {});
    expect(res.ok).toBe(false);
    expect(f.calls.length).toBe(0);
    // 推送通道也不能被 invoke（那一次 invoke 永远不 resolve）。
    const push = await dispatch({ signedFetch: f.signedFetch }, "hub:event", {});
    expect(push.ok).toBe(false);
  });

  it("Hub 的 4xx【原样带上 status 与原因】，不塌成一句「请求失败」", async () => {
    const f = fetchReturning(422, { error: "idea 非法", issues: [{ path: "idea" }] });
    const res = await dispatch({ signedFetch: f.signedFetch }, "hub:createTask", { idea: "x" });
    expect(res.ok).toBe(false);
    if (res.ok === true) throw new Error("不该通过");
    expect(res.error.status).toBe(422);
    expect(res.error.message).toBe("idea 非法");
    // code 是 hub_error 而不是 bad_args：判据住在 Hub（reject 必须带 note 那条），
    // 在 IPC 侧【重抄一遍】会漂移，而漂移的方向是「IPC 放过去了、HTTP 拒」——
    // 渲染进程收到的报错来自一个它已经校验过的东西，最误导人那种。
    expect(res.error.code).toBe("hub_error");
  });

  it("Hub 连不上 ⇒ unreachable，而不是 500（UI 该显示重连提示而非「请重试」）", async () => {
    const res = await dispatch(
      {
        signedFetch: async () => {
          throw new Error("ECONNREFUSED");
        },
      },
      "hub:listTasks",
      undefined,
    );
    expect(res.ok).toBe(false);
    if (res.ok === true) throw new Error("不该通过");
    expect(res.error.code).toBe("unreachable");
    expect(res.error.message).toContain("ECONNREFUSED");
  });

  it("note 缺席时【不带这个键】进 body（带了 undefined 读起来像「写了空备注」）", async () => {
    const f = fetchReturning(200, {});
    await dispatch({ signedFetch: f.signedFetch }, "hub:decideApproval", {
      approvalId: "a-1",
      resume: "reject_with_comment",
      note: "缺压测",
    });
    await dispatch({ signedFetch: f.signedFetch }, "hub:createTask", { idea: "x" });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ resume: "reject_with_comment", note: "缺压测" });
    expect(JSON.parse(f.calls[1]!.body!)).toEqual({ idea: "x" });
    expect(f.calls[1]!.body).not.toMatch(/undefined/u);
  });

  it("推送载荷：有 id 才带 seq（快照帧没有 id，编一个等于伪造游标）", () => {
    expect(toPushPayload({ event: "TaskStateChanged", id: "7", data: "{}" })).toEqual({
      seq: 7,
      event: "TaskStateChanged",
      data: "{}",
    });
    const snapshot = toPushPayload({ event: "snapshot", data: "{}" });
    expect("seq" in snapshot).toBe(false);
  });

  it("主进程【不解析事件 data】：schema 的唯一消费者是 contracts（§5.11）", () => {
    // 主进程一旦解 data，就成了事件 schema 的第二个消费者，加字段时必有一处漏。
    const odd = toPushPayload({ event: "BudgetPaused", id: "3", data: "不是 JSON 也没关系" });
    expect(odd.data).toBe("不是 JSON 也没关系");
  });
});
