/**
 * preload 暴露给渲染进程的那个对象（计划 Task 2.2）。
 *
 * 【这个文件不 import 本包其它模块，也不 import electron。】两件事都是故意的：
 *  ① 不 import ipc-surface.ts：那等于「暴露面从白名单算出来」，
 *     而那样的话计划要的那条相等断言【恒绿】—— 往白名单里加一个 dbQuery，
 *     两边一起变，测试一字不变地通过。计划点名防的正是那个动作。
 *     所以下面这一串方法是【手写的字面量】，与白名单两份、各处一方，
 *     由 test/desktop/ipc-surface.test.ts 负责让它们对得上。
 *  ② 不 import electron：那个包本机装不上，而这个文件里【唯一真正值得测的东西】
 *     就是这张方法表。把它跟 electron 绑在一起，测不到它的代价是
 *     「一条恒绿的守卫」，而那条守卫守的是渲染进程能不能拿到数据库。
 *     ipcRenderer 因此作为【参数注入】进来 —— 顺带让「渲染进程能调什么」
 *     这件事在这份文件里是可读的，不必去猜某个封装后面藏了哪些通道。
 *
 * 与 ipc-surface.ts 的分工：那边是【契约与校验】（主进程读），
 * 这边是【暴露面】（渲染进程读）。两者的对账是一份测试，不是一段代码 ——
 * 对账写成代码就会退化成 ① 那个恒绿的形状。
 */

/** 注入进来的 ipcRenderer 形状（只声明用得上的三个方法，不去够 electron 的类型）。 */
export interface RendererBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (payload: unknown) => void): void;
  removeListener(channel: string, listener: (payload: unknown) => void): void;
}

/**
 * 事件推送的载荷。主进程把 SSE 帧转成它再 send。
 * seq 一路带给渲染进程，断线重连时【原样带回来】—— 那是 Task 2.3 幂等投影的前提。
 */
export interface HubEventPayload {
  readonly seq?: number;
  readonly event: string;
  readonly data: string;
}

/**
 * 暴露的方法表。【逐个手写】，见文件头 ①。
 *
 * 每个方法都是【一层薄包装 + 一个通道名字面量】，理由：
 *  - 不做参数转换、不做默认值、不 catch 错误。渲染进程那边看到的报错
 *    应当与 Hub 发出来的是【同一个】；在 preload 里包一层 try/catch 吞掉错误，
 *    症状是 UI 上「点了没反应」，而 Hub 日志里躺着一条清清楚楚的 422 ——
 *    这种「错误在半路被吃掉」的排查成本，比多写一行 catch 贵得多。
 *  - 不缓存、不去重、不合并请求。任何一层「聪明」都会让渲染进程的状态
 *    与 Hub 的状态多出一个时间差，而 Task 2.3 的验收标准是
 *    「渲染进程内不存在任何业务状态机」。
 */
export function createExposedApi(ipc: RendererBridge) {
  return {
    createTask: (input: { idea: string; parent_id?: string }): Promise<unknown> =>
      ipc.invoke("hub:createTask", input),

    listTasks: (): Promise<unknown> => ipc.invoke("hub:listTasks"),

    getTask: (input: { taskId: string }): Promise<unknown> =>
      ipc.invoke("hub:getTask", input),

    /**
     * 收件箱列表。入参【可整体不传】= 读侧默认那一档（待批）。
     * 不在这里填默认值：默认口径住在 hub/approvals/query.ts，
     * 在这里写一个 `status ?? "pending"` 就等于把那条口径抄了第二份，
     * 以后读侧改了默认值，这里会安静地继续发旧的那一档。
     */
    listApprovals: (input?: { status?: string; limit?: number }): Promise<unknown> =>
      ipc.invoke("hub:listApprovals", input),

    decideApproval: (input: {
      approvalId: string;
      resume: "approve" | "reject_with_comment" | "defer_deep_review";
      note?: string;
    }): Promise<unknown> => ipc.invoke("hub:decideApproval", input),

    /**
     * IM 身份绑定那张列表（0031）。【无参】—— 与 hub:listTasks 同一条形状。
     *
     * 为什么没有对应的「校验 / 改绑」两个方法，而 Hub 那边三条写路由都活着：
     * 理由整段在 desktop/ipc-surface.ts 的 hub:listBindings 那条注释里，
     * 一句话版是「渲染进程里没有任何东西能证明操作者知道自己在校验谁」。
     * 这里刻意【不留一个 TODO 或注释掉的按钮函数】—— 留了就会有人照着解开注释，
     * 而那一次解开不需要回答上面那一句。
     */
    listBindings: (): Promise<unknown> => ipc.invoke("hub:listBindings"),

    /**
     * 组织图看板（0040 读侧）。【无参】—— 与服务端「当前生效那一份」对齐，
     * 不在这里发明一个 ?version= 的入参（那是回放读，不在看板这一格）。
     *
     * 为什么没有对应「提交组织变更」的方法，而 Hub 那条 POST /org 路由活着：
     * 理由整段在 desktop/ipc-surface.ts 的 hub:getOrg 注释里（同 hub:listBindings
     * 那一条的 ①②③）—— 一句话版是「渲染进程里没有任何东西能让一次组织变更
     * 安全地等同于人 + CLI」。这里刻意【不】留一个注释掉的 commitOrg —— 留了
     * 就会有人照着解开注释，而那一次解开不需要回答上面那一句。
     */
    getOrg: (): Promise<unknown> => ipc.invoke("hub:getOrg"),

    /**
     * 订阅 Hub 事件。返回一个【退订函数】。
     *
     * 返回值不是 Promise：这不是一个请求，是一个监听。
     * 退订函数是【必须】的而不是「 nicer-to-have」：注册在 preload 上的监听器
     * 由主进程侧的 WebContents 持有引用，渲染进程里 React 组件重挂十次
     * 就会留下十个监听器，而且【它们都还活着】—— 症状是每个事件被处理十次，
     * 而 Task 2.3 的幂等投影会把重复帧按 seq 吃掉，于是这个 bug
     * 在功能上【看不出来】，只在内存上长。没有退订函数的 API 形状，
     * 是在邀请调用方泄漏。
     */
    onHubEvent: (listener: (payload: HubEventPayload) => void): (() => void) => {
      const wrapped = (payload: unknown): void => {
        listener(payload as HubEventPayload);
      };
      ipc.on("hub:event", wrapped);
      return () => {
        ipc.removeListener("hub:event", wrapped);
      };
    },

    /**
     * 告诉主进程「监听已经挂好了，可以开事件流」。
     *
     * ⚠ 调用方的义务【写在这一句里】：必须在 onHubEvent() 【之后】调。
     * 握手保证的是【主进程侧】不早于这一次 invoke 开流，它管不了
     * 渲染进程自己先 invoke 后挂监听 —— 那个次序在这里没有测试撑着，
     * 只能靠调用点（未来的投影入口）先 onHubEvent 再 notifyEventsReady。
     *
     * 为什么它【不在】暴露面 = invoke 白名单那条相等断言里：白名单对账的是
     * 「渲染进程能主动打到哪些 Hub 端点」，而这一发【从不出进程】——
     * 它落在主进程自己的 handler 上（main/wire.ts 注册），不映射任何端点。
     * 与 onHubEvent 同族：一个纯出、一个纯入，都不是 Hub 调用。
     * 它仍走 ipc.invoke 而不是 fire-and-forget：拿得到一个 Promise，
     * 装配出错（handler 没注册）时渲染进程能看到 reject，而不是静默地
     * 永远等不到事件 —— "能调而没人应答"要红在调用点上，不许绿着烂。
     */
    notifyEventsReady: (): Promise<unknown> => ipc.invoke(EVENTS_READY_CHANNEL),
  };
}

export type ExposedApi = ReturnType<typeof createExposedApi>;

/**
 * 暴露到 window 上的键名。单独抽出来是因为 preload 里那句
 * contextBridge.exposeInMainWorld 只允许【一个】键，而渲染进程那边
 * window.opc 的形状要和这里对得上（Task 2.3 的 useHubEvents 读它）。
 */
export const EXPOSED_GLOBAL_KEY = "opc";

/**
 * 事件推送用的通道名。【不在】白名单里，这是刻意的：
 * 白名单管的是「渲染进程能【主动】发起什么」，而这是【主进程推给它】的。
 * 把推送通道混进白名单会让那条相等断言变成「渲染进程能调 hub:event」——
 * 一个它根本不该有、也调不通的方向（invoke 一个只用于 send 的通道）。
 * 所以它单独在这里，并由测试【单独】钉住「只有一个推送通道」。
 */
export const EVENT_CHANNEL = "hub:event";

/**
 * 「监听挂好了，可以开流」那一次 invoke 的通道名（0052 §7 第 3 条的落地）。
 *
 * 与 EVENT_CHANNEL 同处一侧、同一个理由：它【不在】hub 端点白名单里。
 * 白名单管「渲染进程能主动让主进程去打哪个 Hub 端点」，而这一发
 * 落在主进程自己的 handler 上（main/wire.ts 注册、收到才 start() 开流），
 * 从不出进程。它和 hub:subscribeEvents 不冲突而是互补：
 * 后者是 CHANNEL_SPECS 里那条 push 通道的【契约条目】（对账用），
 * 前者是【触发开流的信号】—— 开流时机的闸门由 handle 注册制保证，
 * 不再依赖"胶水在 load 完后手动调 start()"那句注释约定。
 * 名字在这里【手写】而不是从主进程 import：本文件头 ② 的规矩是不 import
 * 本包其它模块，而 main/wire.ts 反过来 import 这个常量 —— 一个方向，一份真相。
 */
export const EVENTS_READY_CHANNEL = "hub:eventsReady";
