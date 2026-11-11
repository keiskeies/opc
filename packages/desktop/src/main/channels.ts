/**
 * 主进程侧的 IPC 分发（计划 Task 2.2 的 src/main 半边）。
 *
 * 与 http/app.ts 同一个立场：electron 本机装不上，而这一层【真正会出错的部分】
 * 与 electron 无关 —— 参数闸门、端点映射、把 HTTP 状态码翻成渲染进程能懂的东西、
 * 把 SSE 帧翻成推送。electron 那几行（ipcMain.handle / webContents.send）
 * 是等依赖到位再补的胶水，薄到允许不测。
 *
 * fetch 作为参数注入：既让这层可测，也顺带钉住一件事 ——
 * 渲染进程【永远拿不到 fetch 本身】，它只能调这四个方法。
 * 本机 token 在主进程这一侧签名（见 http/auth.ts 的立场），
 * 渲染进程被 XSS 之后手上最多是「以合法身份调这四个操作」，
 * 拿不到密钥，也就换不来任意端点的调用。
 */

import { type ChannelSpec, checkArgs, specOf } from "../ipc-surface.js";
import type { HubEventPayload } from "../preload/api.js";

export interface MainFetchResult {
  readonly status: number;
  readonly bodyText: string;
}

export interface MainDeps {
  /**
   * 已签名的 fetch。签名材料【在主进程这一侧】，渲染进程看不见（见 http/auth.ts）。
   *
   * 这里刻意【只有】这一个函数、没有第二个「未签名的 fetchHub」字段：
   * 第一版两个都写了，而 dispatch 只用 signedFetch —— 一个没有调用方的字段
   * 会诱使下一个人「顺手用那个更轻的」，那条路绕开的正是签名。
   * 不给不存在的路留名字。
   */
  signedFetch(
    path: string,
    init: { method: string; body?: string },
  ): Promise<MainFetchResult>;
}

/** 派发给渲染进程的错误形状。 */
export interface IpcError {
  readonly code: "bad_args" | "hub_error" | "unreachable";
  readonly message: string;
  readonly status?: number;
}

/**
 * 一次 invoke 的分发。返回 { ok: true, data } 或 { ok: false, error }。
 *
 * 【为什么不用 throw】：electron 的 ipcMain.handle 会把抛出的错误序列化成
 * 一个 string，丢掉全部结构（status、code 都没了），渲染进程那边只剩
 * 一句 "Error: …"。于是 UI 想区分「你的输入有问题」与「Hub 挂了」
 * 就只能去 match 报错文案 —— 而文案是会改的。所以这里把结果做成【判别联合】，
 * 结构一路带到渲染进程。
 *
 * 三态里的 unreachable 单独一态：Hub 没起来时渲染进程拿到的是
 * 「本机 Hub 未运行」这种它能【自己处理】的状态（显示一个重连提示），
 * 而不是一个 500 —— 500 在 UI 上通常长成「操作失败，请重试」，
 * 而重试在这里【永远不会成功】，用户会一直点。
 */
export async function dispatch(
  deps: MainDeps,
  channel: string,
  args: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: IpcError }> {
  const spec = specOf(channel);
  if (spec === null) {
    // 未知通道 ⇒ 拒而不是转发。渲染进程（或被注入的脚本）能试的通道集合
    // 必须在这里也封一次：preload 那边只暴露四个方法挡的是【正常调用路径】，
    // 而 ipcRenderer.send 是全局对象上的函数，拿到 window 就能拼任意通道名。
    return {
      ok: false,
      error: { code: "bad_args", message: "未登记的 IPC 通道：" + channel.slice(0, 64) },
    };
  }
  if (spec.kind !== "invoke") {
    return {
      ok: false,
      error: { code: "bad_args", message: spec.channel + " 是推送通道，不能被 invoke" },
    };
  }
  const why = checkArgs(spec, args);
  if (why !== null) return { ok: false, error: { code: "bad_args", message: why } };

  const { path, init } = toHttpRequest(spec, args);
  let res: MainFetchResult;
  try {
    res = await deps.signedFetch(path, init);
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "unreachable",
        message:
          "本机 Hub 未响应：" + (e instanceof Error ? e.message : String(e)).slice(0, 200),
      },
    };
  }
  const data = parseMaybeJson(res.bodyText);
  if (res.status >= 400) {
    return {
      ok: false,
      error: {
        code: "hub_error",
        status: res.status,
        // Hub 的报错体里带着【可操作的】信息（哪个字段不合法、合法取值是什么）。
        // 在这里换成一句「请求失败」是本类转发最常犯的错：UI 只能显示
        // 「操作失败，请重试」，而重试对一次 422 永远无效。
        message: describeHubBody(data) ?? "HTTP " + res.status,
      },
    };
  }
  return { ok: true, data };
}

/**
 * 通道 + 参数 → HTTP 请求。
 *
 * 路径【由这里拼】，id 段先过 checkArgs 的形状闸门（见 ipc-surface.ts）。
 * 拼字符串而不是 new URL(...)：base 恒是本机固定值，而 new URL 对一个
 * 含 "?" 的 id 会安静地把它解析成 query —— 那等于把「校验漏了一个字符」
 * 变成「请求打到另一个端点上」。宁可在这里显式拼接，让形状闸门成为唯一防线。
 *
 * ⚠ 带 query 的通道（hub:listApprovals）【必须返回将要发出去的那一整串】：
 * signedFetch 签的是【原始 target】（含 query、未解码），而服务端也按原始 target
 * 验签（http/auth.ts 的 canonicalString，那是真 socket 上撞出来的教训）。
 * 所以这里拼完的字符串与 encodeURIComponent 后的字节【必须逐字一致】 ——
 * 若哪天有人在这里做「先拼再 normalize / 排序参数」，签名会与发出的串对不上，
 * 症状是【所有带 query 的请求 401】，而 IPC 层看到的只是 hub_error 401。
 */
export function toHttpRequest(
  spec: ChannelSpec,
  args: unknown,
): { path: string; init: { method: string; body?: string } } {
  switch (spec.channel) {
    case "hub:createTask": {
      const o = (args ?? {}) as { idea?: string; parent_id?: string };
      const body: Record<string, unknown> = { idea: o.idea };
      if (o.parent_id !== undefined) body["parent_id"] = o.parent_id;
      return { path: "/tasks", init: { method: "POST", body: JSON.stringify(body) } };
    }
    case "hub:listTasks":
      return { path: "/tasks", init: { method: "GET" } };
    case "hub:getTask": {
      const o = (args ?? {}) as { taskId?: string };
      return { path: "/tasks/" + o.taskId, init: { method: "GET" } };
    }
    case "hub:listApprovals": {
      const o = (args ?? {}) as { status?: string; limit?: number };
      // 【两个键都缺省时不带 "?"】，而不是一发 `/approvals?`。
      // 后者在服务端会解析出一个 status="" 的空值（URLSearchParams 把一个空段
      // 给成 ""），而 "" 不是白名单里的取值 ⇒ 触发读侧的回落分支。
      // 行为上今天等价，但那条分支是【非法取值】的分支 —— 让正常路径去踩它，
      // 等于让「读侧回落对不对」这件事永远测不到（详见 approvals/query.ts ②）。
      const qs: string[] = [];
      if (o.status !== undefined && o.status !== null) {
        qs.push("status=" + encodeURIComponent(o.status));
      }
      if (o.limit !== undefined && o.limit !== null) {
        qs.push("limit=" + encodeURIComponent(String(o.limit)));
      }
      return {
        path: "/approvals" + (qs.length === 0 ? "" : "?" + qs.join("&")),
        init: { method: "GET" },
      };
    }
    case "hub:listBindings":
      // 无 query。三条写路由【没有】通道，理由整段写在 ipc-surface.ts 那条注释里
      // （不是「以后补」），所以这里也没有对应分支 —— 有人加通道时会先在
      // toHttpRequest 这里撞上一次「忘了加分支」的抛，那是刻意的次序。
      return { path: "/bindings", init: { method: "GET" } };
    case "hub:getOrg":
      // 组织图读侧（0040）。无 query（「当前生效那一份」= 服务端默认口径）。
      // 提交那条 POST /org【没有】通道：self-escaping CEO 写，理由整段在
      // ipc-surface.ts 的 hub:getOrg 注释（与 hub:listBindings 的 ①②③ 同判断），
      // 所以这里也只有读分支 —— 有人加写通道时会先在 toHttpRequest 撞抛。
      return { path: "/org", init: { method: "GET" } };
    case "hub:decideApproval": {
      const o = (args ?? {}) as { approvalId?: string; resume?: string; note?: string };
      const body: Record<string, unknown> = { resume: o.resume };
      // note 缺席时【不带这个键】：带一个 undefined 进 JSON 再进审计，
      // 读起来像「他写了空备注」而不是「没备注」（exactOptionalPropertyTypes 同一条理由）。
      if (o.note !== undefined) body["note"] = o.note;
      return {
        path: "/approvals/" + o.approvalId,
        init: { method: "POST", body: JSON.stringify(body) },
      };
    }
    default: {
      // 推送通道不该走到这里（dispatch 已挡）。抛而不是回一个假路径：
      // 假路径会让一次「忘了加分支」变成一次指向错误方向的 hub_error。
      throw new Error("通道 " + spec.channel + " 不是 invoke 通道，无法映射为 HTTP 请求。");
    }
  }
}

/**
 * SSE 帧 → 推给渲染进程的载荷。
 *
 * 只做【透传 + 挑字段】，不解析 data：data 的形状由 Hub 的事件类型决定，
 * 主进程一旦去解析它，就变成事件 schema 的【第二个】消费者，
 * 而那个 schema 的真相在 contracts 里（§5.11 的唯一 schema 来源）。
 * 两个消费者各解一遍 = 事件加字段时必有一处漏。
 */
export function toPushPayload(frame: {
  event: string;
  id?: string;
  data: string;
}): HubEventPayload {
  return {
    ...(frame.id === undefined ? {} : { seq: Number(frame.id) }),
    event: frame.event,
    data: frame.data,
  };
}

function parseMaybeJson(text: string): unknown {
  if (text.trim() === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeHubBody(data: unknown): string | null {
  if (typeof data === "string") return data.slice(0, 500);
  if (data !== null && typeof data === "object") {
    const err = (data as Record<string, unknown>)["error"];
    if (typeof err === "string") return err.slice(0, 500);
  }
  return null;
}
