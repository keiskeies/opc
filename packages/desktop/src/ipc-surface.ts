/**
 * IPC 白名单（计划 Task 2.2 的「硬边界」，规格 §5.6.1）。
 *
 * ── 先说这个文件为什么【不能】长成它看起来最自然的样子 ──────────────
 * 计划的 Test 项是：「preload 暴露的方法集合【等于】白名单，多一个少一个都失败 ——
 * 防止未来随手加一个 dbQuery」。最省事的写法是这样的：
 *
 *   export const WHITELIST = ["createTask", "listTasks", …];
 *   export function buildApi() { return Object.fromEntries(WHITELIST.map(…)); }
 *
 * 这个写法【恒绿】。暴露出来的对象是从白名单【算】出来的，于是它俩永远相等 ——
 * 而「随手加一个 dbQuery」的动作，在代码上就表现为【往白名单里加一行】，
 * 加完两边一起变，测试一字不变地通过。计划点名要防的那个动作，
 * 恰好是这个断言唯一测不到的那个动作。这是同类断言里最常见的假绿形状
 * （同类的还在「断言扫描器扫到了文件」而扫描器其实扫了个空目录）。
 *
 * 所以这里把两侧【刻意断开】：
 *  - 白名单在 contracts 的 API_ENDPOINTS 里（对外契约，前端与 Hub 都读它）；
 *  - 暴露面在 preload/index.ts 里【逐个手写】的方法字面量；
 *  - 本文件只做一件事 —— 声明「哪个通道对应哪个端点、参数长什么样」，
 *    而它【不生成】preload 的那个对象。
 * 于是 test/desktop/ipc-surface.test.ts 的相等断言两边来自两个不同的源，
 * 任一侧单独动就会红。它还配了一条 canary（往 preload 的字面量里注入一个
 * dbQuery 再期望红），用来证明这条断言【不是】恒绿的 —— 一条没有 canary 的
 * 相等断言，与上面那个写法，从绿屏上看不出区别。
 *
 * ── 为什么白名单的【另一端】是 API_ENDPOINTS 而不是另列一份 ──────
 * 因为「渲染进程能调到一个前端契约里没有的端点」与「契约里有但渲染进程调不到」
 * 是两个真实存在过的洞，而它们都源于两份清单各自漂移。指向同一份常量
 * 就把这两个方向都堵住了；代价是渲染进程多欠了一个 @opc/contracts 依赖，
 * 而那个包只有 zod、没有 node:sqlite（§5.6.1 的边界正是靠这个成立）。
 */

import {
  API_ENDPOINTS,
  IMPLEMENTED_ENDPOINTS,
  MAX_IDEA_CHARS,
  RESUME_VALUES,
  type ApiEndpoint,
} from "@opc/contracts";

/**
 * 一个 IPC 通道。
 *
 * invoke 与 subscribe 分成两种，不是分类癖：
 *  - invoke 是【请求-响应】，渲染进程拿到一个 Promise，天然有返回类型；
 *  - GET /events 是 SSE 长连接，主进程要把它转成【主 → 渲染的推送】，
 *    渲染进程那边不是一个函数返回值而是一个回调。
 * 把两者混在一个「channel → endpoint」的表里，实现时就会有一个人
 * 把 events 也写成 ipcRenderer.invoke —— 那一次 invoke 永远不 resolve
 * （SSE 响应不结束），渲染进程那边是一个恒挂的 Promise，
 * 而界面表现为「连上了，什么都不动」。
 */
export type IpcChannel =
  | "hub:createTask"
  | "hub:listTasks"
  | "hub:getTask"
  | "hub:decideApproval"
  | "hub:subscribeEvents";

export interface ChannelSpec {
  readonly channel: IpcChannel;
  readonly endpoint: ApiEndpoint;
  readonly kind: "invoke" | "push";
  /**
   * 参数在【线】上的形状（structured clone 之后的样子）。
   * 校验用它在主进程那一侧把参数过一遍再发 HTTP：渲染进程被 XSS 之后，
   * IPC 通道是攻击者手上唯一的「以本机 token 签名发请求」的能力，
   * 而 token 本身拿不到（见 http/auth.ts 的立场）。所以这一层是【真边界】，
   * 不是形式 —— 校验不能只判「有没有传」。
   */
  readonly args: "idea" | "none" | "taskId" | "decision";
}

/**
 * 通道 → 端点。这份表【只被主进程与本仓的测试读】，preload 不 import 它
 * （import 了就等于把两侧又并回一处，见文件头）。
 */
export const CHANNEL_SPECS: readonly ChannelSpec[] = [
  { channel: "hub:createTask", endpoint: "POST /tasks", kind: "invoke", args: "idea" },
  { channel: "hub:listTasks", endpoint: "GET /tasks", kind: "invoke", args: "none" },
  { channel: "hub:getTask", endpoint: "GET /tasks/:id", kind: "invoke", args: "taskId" },
  {
    channel: "hub:decideApproval",
    endpoint: "POST /approvals/:interruptId",
    kind: "invoke",
    args: "decision",
  },
  { channel: "hub:subscribeEvents", endpoint: "GET /events", kind: "push", args: "none" },
];

/**
 * 未实现的端点【不进白名单】。
 *
 * 这是本文件里唯一一个「少一个」的方向上会被测试判红的地方，所以把理由写清：
 * 暴露一个只会返回 501 的方法，等于让渲染进程去写一段【当前无法被触发】的处理代码
 * —— 那段代码没有测试，因为它在真机上永远不执行，而 Task 3.4 落地那天，
 * 第一个发现它写错的人会以为是自己改坏了 3.4。
 * 反过来等它真实现了再加，代价是「多改一行」，而那一次改动会连带
 * 触发这里的相等断言去催他补上渲染侧的处理 —— 正是断言该有的作用。
 */
export const EXPOSED_ENDPOINTS: readonly ApiEndpoint[] = IMPLEMENTED_ENDPOINTS;

export function specOf(channel: string): ChannelSpec | null {
  for (const s of CHANNEL_SPECS) if (s.channel === channel) return s;
  return null;
}

/**
 * 端点 → 一个 IPC 通道名。【未实现的端点返回 null】，理由见 EXPOSED_ENDPOINTS。
 *
 * 命名不用「方法名 = 端点路径」的机械变换：hub:getTask 比 hub:GET_/tasks/:id
 * 好读，而代价（两份名字要对照）由上面那张表集中承担 ——
 * 一处映射，而不是散在每个调用点。
 */
export function channelFor(endpoint: ApiEndpoint): IpcChannel | null {
  for (const s of CHANNEL_SPECS) if (s.endpoint === endpoint) return s.channel;
  return null;
}

/**
 * 主进程侧的参数闸门。返回 null = 通过；返回字符串 = 拒（内容即报错原因）。
 *
 * 三条贯穿全部通道的规则，每条都对应一种真实故障：
 *  - 【形状以外的键一律不要】。渲染进程传 {idea:"x", sql:"drop table"} 时，
 *    若这里只做「挑我要的字段」（白名单式提取看起来无害），
 *    那条 sql 会静静穿过主进程；哪天有人在下游把多余字段并进 body，
 *    它就活了。当场拒，故障就落在【引入它的那次改动】上。
 *  - 【id 类字段必须像 id】。它们会被拼进 URL 路径，未校验的 id 意味着
 *    渲染进程可以让主进程去请求任意路径（SSRF 的最小形状，只不过目标恒是本机）。
 *  - 【上限与 contracts 同源】。这里不重复写数字，见 idea 那条。
 *
 * 报错文案【不回显键名，也不回显值】，只报数量。
 * 这一条是被测试逼出来的，不是我一开始想到的：最初的写法是
 * `多出 N 个键（${extra.join(",")}）`，理由很正当（要能定位），
 * 而写下的注释却说「不带收到的值原文，因为值可能攻击者可控、会进主进程日志」。
 * 注释只管了【值】，漏了【键名】—— 键名同样是攻击者可控的字符串，
 * 一个 { "<2MB 垃圾>": 1 } 就能把主进程日志撑爆，而日志是渲染进程碰不到的
 * 唯一一条「运维看得见」的通道，把它污染掉等于同时毁掉排查能力。
 * 定位靠【数量 + 通道名】已经够了：调用点在渲染进程，堆栈会指到那一行。
 */
export function checkArgs(spec: ChannelSpec, args: unknown): string | null {
  switch (spec.args) {
    case "none": {
      // 【不接受任何参数】而不是「有参数就丢掉」。丢掉是无声的，
      // 而「渲染进程开始往一个无参通道上塞东西」这件事本身需要被看见。
      if (args === undefined || args === null) return null;
      return `${spec.channel} 不接受参数，实到 ${describe(args)}`;
    }
    case "idea": {
      if (typeof args !== "object" || args === null) {
        return `${spec.channel} 需要一个 { idea } 对象，实到 ${describe(args)}`;
      }
      const o = args as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => k !== "idea" && k !== "parent_id");
      if (extra.length > 0) {
        return `${spec.channel} 只接受 idea / parent_id，多出 ${extra.length} 个未登记键`;
      }
      if (typeof o["idea"] !== "string") {
        return `${spec.channel} 的 idea 必须是字符串`;
      }
      // 上限【不在这里重写一遍数字】：调 contracts 的那一份。
      // 两处各写 4000 的话，改一处会得到「IPC 放过、HTTP 拒」——
      // 渲染进程看到的是一个「我明明校验过了」的 422，最误导人那种。
      if (o["idea"].trim().length === 0) return `${spec.channel} 的 idea 不得为空`;
      if (o["idea"].length > MAX_IDEA) return `${spec.channel} 的 idea 超过 ${MAX_IDEA} 字符`;
      if (o["parent_id"] !== undefined && !ID_RE.test(String(o["parent_id"]))) {
        return `${spec.channel} 的 parent_id 形状非法`;
      }
      return null;
    }
    case "taskId": {
      if (typeof args !== "object" || args === null) {
        return `${spec.channel} 需要一个 { taskId } 对象，实到 ${describe(args)}`;
      }
      const o = args as Record<string, unknown>;
      const extra = Object.keys(o).filter((k) => k !== "taskId");
      if (extra.length > 0) return `${spec.channel} 只接受 taskId，多出 ${extra.length} 个键`;
      if (typeof o["taskId"] !== "string" || !ID_RE.test(o["taskId"])) {
        return `${spec.channel} 的 taskId 形状非法（它会被拼进 URL 路径）`;
      }
      return null;
    }
    case "decision": {
      if (typeof args !== "object" || args === null) {
        return `${spec.channel} 需要一个 { approvalId, resume } 对象，实到 ${describe(args)}`;
      }
      const o = args as Record<string, unknown>;
      const extra = Object.keys(o).filter(
        (k) => k !== "approvalId" && k !== "resume" && k !== "note",
      );
      if (extra.length > 0) return `${spec.channel} 多出 ${extra.length} 个未登记键`;
      if (typeof o["approvalId"] !== "string" || !ID_RE.test(o["approvalId"])) {
        return `${spec.channel} 的 approvalId 形状非法（它会被拼进 URL 路径）`;
      }
      // resume 的取值【不在这里另列一份】：见下面 channelFor/RESUME_VALUES 的用法。
      // 这里判的是「在不在集合里」，具体的三值语义归 contracts，一处真相。
      if (typeof o["resume"] !== "string" || !RESUME.has(o["resume"])) {
        return `${spec.channel} 的 resume 不是登记过的取值`;
      }
      if (o["note"] !== undefined && typeof o["note"] !== "string") {
        return `${spec.channel} 的 note 必须是字符串`;
      }
      // reject_with_comment 必须带非空 note —— 这条规则住在 contracts 的
      // approvalDecisionRequestSchema 里，这里【不重抄一遍判据】：
      // 重抄的话两处会漂移，而漂移的方向是「IPC 放过去了、HTTP 拒」，
      // 渲染进程收到的报错来自一个它已经校验过的东西。
      return null;
    }
  }
}

/**
 * id 的形状。任务 id 与 approval id 都是我们自己用 randomUUID 发的，
 * 所以「像 UUID」这个判据是【紧的】：它不放过任何被拼进 URL 的东西，
 * 又不会误伤任何一个真实 id。收紧比宽松贵一点，但这个字段的下游是 URL 拼接。
 *
 * 注意它【比 UUID_RE 松】（也接受 task-1 这类人写的 id）。这不是疏忽：
 * 这里的职责是「不能破坏 URL」，不是「必须是我们发出去的」。
 * 真要收紧到 UUID，得先把 tasks.id 的取值范围钉死 —— 那属 Task 3.1 的状态机闸门。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

/**
 * 与 contracts 【同源】的两个常量（不是在这里重写一遍数值 ——
 * 见 checkArgs 的 idea 那条注释里说的「改一处会得到 IPC 放过、HTTP 拒」）。
 */
const MAX_IDEA = MAX_IDEA_CHARS;
const RESUME = new Set<string>(RESUME_VALUES);

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array(" + v.length + ")";
  if (typeof v === "object") return "object{" + Object.keys(v).length + " 键}";
  return typeof v + "(" + String(v).length + ")";
}

/**
 * 渲染侧源码里【禁止出现】的能力（§5.6.1 的硬边界）。
 *
 * 这份名单是给 test/desktop/ipc-surface.test.ts 做【源码扫描】用的，
 * 不是运行期检查 —— 运行期检查只能证明「这次运行没用到」，
 * 而「这次运行没用到」不是边界，一次没被走到的分支也是代码。
 *
 * 为什么用「扫源码」而不是「用 electron 的 API 关掉 nodeIntegration」：
 * 两件事都要做，但只有前者可测。nodeIntegration: false 是配置项，
 * 有人为了「调试方便」翻一次，翻完【没有任何测试会变红】；
 * 而磁盘模块出现在 preload 里会让这条守卫当场红。
 *
 * 每一项的 why 必须【自带完整理由】，不写「同上」—— 这一条有测试撑着
 * （why 长度下限）。理由是一个想加豁免的人唯一能看见的上下文，
 * 而上一条大概率已经被删了。
 *
 * ── 名单里【没有】SQLite 相关的项，这是刻意的，别加回来 ──────────────
 * 两个理由，第二个是硬的：
 *  ① 重复。packages/desktop 与 packages/web 里的 SQLite 依赖已被两处现有守卫挡住：
 *     biome.json 的 noRestrictedImports（hub 之外一律 error），
 *     以及 test/arch/dependency-boundary.ts（Task 0.2，连动态 import 一起挡）。
 *     同一件事第三处再判一遍，只多出一份要同步维护、且会与另两处漂移的清单。
 *  ② 而且【写不进去】：把那个驱动包的名字作为【数据】放进本文件，会让
 *     test/arch/no-native-deps.ts 当场红 —— 那条守卫扫的是【全仓生产源码里的字面量】，
 *     它无法区分「我在禁止这个词」与「我在用它」。
 *     三种修法里：把词拆开绕过匹配，是为了让守卫看不见而写，
 *     下一个读这段的人会以为那只是排版；给整份文件加豁免，减的是真防护；
 *     【不写这一项】是唯一不减低任何防护的，因为那条禁令本来就由 ① 的两处生效。
 *     记在这里，是为了下一个想「把 SQLite 补进名单」的人不必再撞一次。
 */
export const BANNED_IN_RENDERER_FACING: readonly {
  readonly needle: string;
  readonly why: string;
}[] = [
  {
    needle: "node:fs",
    why:
      "渲染侧不得读写磁盘（§5.6.1）：制品与库文件都归 Hub 管。" +
      "按【子串】匹配，所以它的 promises 变体一并被这条盖住 —— " +
      "曾把变体单列一项，而那是个装饰性条目：它永远不可能单独命中，" +
      "删掉它一次违规也不会漏。名单里每一项都必须【必要】，" +
      "必要性由 test/desktop/ipc-surface.test.ts 逐条反证。",
  },
  {
    needle: ".opc-os",
    why:
      "数据目录路径本身不该出现在渲染侧（§6.1 的目录约定）：" +
      "出现即意味着有人在渲染侧拼路径读库文件",
  },
  {
    needle: "DatabaseSync",
    why:
      "node:sqlite 的句柄类型名。渲染侧出现它意味着真的拿到了库对象，" +
      "而不只是 import 了模块 —— 这是上面两条覆盖不到的那一段，" +
      "也是本名单【唯一】与数据库有关的项（SQLite 依赖本身见文件头那条）",
  },
];
