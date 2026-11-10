/**
 * 搜索的传输边界（计划 Task 5.7 的第二个文件 `src/search/mcp.ts`）。
 *
 * ── ⚠ 这个文件**不是** MCP 客户端，也不假装是 ───────────────────────
 * 计划要的是 `@modelcontextprotocol/sdk` 1.32.2 的 MCP Client + 一个搜索 MCP Server
 * （Node 包）。那两个东西今天**装不上**（0009 §2：DNS 通、TCP 443 超时、
 * store 与锁文件零命中，三条通路复算过），所以：
 *
 *   - 本文件只交出**判定侧真正需要的那一个方法**（`search`）与**授予判据**；
 *   - 不写一个假的 MCP 客户端去「看起来接上了」，也不在 node_modules 里放桩
 *     （那是把一次临时验证伪装成真门禁，仓里已经写过这条）。
 *
 * 于是本文件今天的价值只有一条：**把『搜索由谁提供』这件事收在一个位置**，
 * 让 `policy.ts` 那套判据不必知道它是 MCP、内置 WebSearch 还是别的。
 * 真接 SDK 时改动应当只有「多一个 implements SearchTransport 的类」。
 */

/** 一条搜索结果。**url 是必填的**，这不是风格要求。 */
export interface SearchHit {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  /** 谁给的这条结果（MCP server 名 / 内置工具名），进审计。 */
  readonly provider: string;
  readonly retrievedAtMs: number;
}

/**
 * 传输接口：只有一个方法。
 *
 * `url` 在 `SearchHit` 上是**必填**而不是可选，理由是 `policy.ts` 里那条
 * 「观测到搜索而包里没 URL ⇒ 拒」判的正是这个形状：如果传输层可以交回一条
 * 没有来源的结果，那条判据就只能指望 Agent 自己补链接 ——
 * 而它要防的就是 Agent 不补。让**缺来源**在这一层就编译不过，比在门控里判更省。
 */
export interface SearchTransport {
  readonly id: string;
  search(q: {
    readonly query: string;
    readonly maxResults: number;
  }): Promise<readonly SearchHit[]>;
}

/**
 * 授予判据：这个角色**能不能**用搜索工具（【规格】§13.3 挂载方式末段
 * 「由岗位书决定是否授予该权限」）。
 *
 * 与 `policy.ts` 的关系值得说清，因为它看起来像重复（那里也有一个 prohibited）：
 *   - 这里判的是**授予**（工具集里有没有这个工具）—— 装配期一次；
 *   - `prohibitedBlock` 判的是**一次调用该不该执行** —— 运行期每次。
 * 两道都在不是冗余：授予是 tool_permissions 白名单（第一层，harness 原生），
 * 运行期那一判靠的是我们有权不让它继续（0021 §6 那条 enforced）。
 * 只有前者会被绕过（岗位书里写着不许而请求里塞进来），只有后者会漏（工具一直挂着）。
 */
export function searchGranted(toolPermissions: readonly string[]): boolean {
  // 口径：**子串**匹配 `search`（不区分大小写）。
  // 为什么不精确匹配某个工具名：各家叫法不同（实测 `WebSearch` / `websearch` /
  // `mcp__search__web` 三种形状都要能命中，精确名单会让「换个名字」成为绕过授予的通路，
  // 而这一条判据的失效方向必须是收紧）。
  // 代价实测过：`research` 与 `market_research` **也会**命中（我一度以为是 `resumes`，
  // 一跑才知道不是 —— 又一次「按印象补事实」）。也就是说一个名叫 research 的
  // 非搜索工具会被授予搜索权限。**这是一个放宽的方向**，所以写在这里而不是埋在代码里：
  // 要收紧就换成显式名单，别把正则改成「看起来更准」而没人复核命中面。
  return toolPermissions.some((t) => /search/i.test(t));
}

/**
 * 把搜索结果落成 claim 的依据（计划 Test 项第二句「搜索结果进入证据包并带来源 URL」）。
 *
 * 为什么由代码生成而不是让 Agent 自己写：让 Agent 写链接，链接就是它抄的；
 * 由传输层落，链接与它**实际拿到的东西**同源。
 * （这不解决「抄了没读」—— 那一维判不了，写在 0024 §7。）
 */
export function hitsToRefs(hits: readonly SearchHit[]): string[] {
  return hits.map((h) => h.url);
}
