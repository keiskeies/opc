/**
 * 搜索观测：把「这次调用到底搜过没有」变成一个**有出处的数**（【计划】Task 5.7 的观测侧）。
 *
 * ── 为什么单独一个文件 ───────────────────────────────────────────
 * `policy.ts` 里那条强判据（`mandatorySearchObservedBlock`）的入参是一个数字，
 * 而它文件头立着一条：「**没有观测通路**必须是一个显式取值而不是传 0」。
 * 那句话在接线之前是**一句意图** —— 测试自己写 `observedSearches: 2`，
 * 于是它从来没有被迫回答「真跑起来时这个数谁给的、怎么给的」。
 * 本文件就是那个「谁给」。它交出的不是一个 number，是一个**三态**：
 *
 *   counted      —— 数出来了（可能是 0）
 *   not_granted  —— 这次调用**没有**搜索工具可用 ⇒ 0 是一条**可证明**的 0
 *   silent       —— 我们一次工具调用都没看见 ⇒ **无从知道**，而这不是 0
 *
 * `silent` 与 `counted 0` 必须分开，两侧各有一种坏法：
 *   · 把「什么都没说」写成 0 ⇒ **每一次**没报工具调用的执行都会在强制搜索领域里
 *     被判「没搜过」而打回 —— 那是把适配器的沉默变成对 Agent 的指控；
 *   · 把「没搜过」写成 silent ⇒ 就是 `policy.ts` 那句「看不到就当搜过」的攻击面
 *     （把观测关掉即可绕过，一行代码都不用改）。
 *
 * ── 今天这条通路的**真实强度**（别读完上面就当它是审计读侧，0033 §5）────
 * 数据来自 **Gateway 在那次调用里看见的工具调用**（`harness/gateway.ts` 里 `toolSightings`），
 * 不是审计库。三条后果：
 *   ① 它是**易失**的，且刻意不去数审计库。真实理由两条（⚠ 第一版这里写的是
 *     「`replay/query.ts` 已经有一份读口径，两份必然漂」，落盘后核 ⇒ 那份**不存在**：
 *     `replay/query.ts` 读的是事件行与全文检索，不是工具调用计数。改成本地那两条之后
 *     理由变弱而诚实，细节与那次读错记在 0033 §5）：
 *       · Gateway 确实往审计里写行，但从库里反查「这次调用搜了几次」要**新写一份本层专属**
 *         的口径（按 payload 里的 `verdictKey` 反解）—— 漂的预言还在，只是没有现成的第二份；
 *       · 本层入口只拿到一份 `GatewayDeps` 形状的依赖，**没有读库能力**。给它加一条读通道
 *         会把「事后从库里补一个数」变成可能，而判据是在**当时**用的 —— 那比易失更坏。
 *   ② 它只覆盖 Gateway 看得见的通路：一条**既不 ask 也不报**的搜索（内置 WebSearch
 *     直连厂商 API 那一类）在这里是 `silent` ⇒ 结论是**吵**（unresolved / escalate）
 *     而不是放行。方向对，代价真实 —— 0024 §7 第 2 条早就记下这一格，本篇把它接上；
 *   ③ 计数单位是「**一次去重后的工具调用**」，口径与 Gateway 的判定缓存同源：
 *     同一个 `工具 + 参数` 被 ask 一次又被通报一次，是**一次**。
 *     不这样定的话，一次老实的搜索会被数成两次（而「两次」那个数没有任何含义）。
 *
 * ── ⭐ 本模块不判断「谁搜的」，这是有意的 ─────────────────────────
 * `observeSearchCalls` 拿的是【一次调用】的授权名单与工具调用记录，
 * 所以它只能说「**这次调用**搜了几次」。第 1 层最终要问的是「**这份产出的作者**搜过没有」，
 * 那是两个主体，把它们当成一个是本篇最容易被写错的地方（0033 §3 记了写法与判后处置）。
 * 所以本模块只交一个数加一句出处，**归属**由调用方负责。
 * ⚠ 这一段第一版在末尾还写了一句「（`harness/verifier.ts` 里那一发 roleId 核对就是它负责的方式）」，
 * 而**那发核对根本不该存在** —— 它拒掉的是唯一正确的接法，已经删掉了。
 * 留下这句而不是悄悄删：一个指向不存在的仪器的指针，比一句没有出处的立场更难发现。
 */
import { searchGranted } from "./mcp.js";
import { OBSERVATION_UNAVAILABLE } from "./policy.js";

/**
 * 一次工具调用的观测记录（由 Gateway 交出，见 `harness/gateway.ts` 的 `toolSightings`）。
 *
 * ⚠ 它与「审批记录」（`approvals` 那一格，进 harness_call 的 payload）**不是一回事**，
 * 而这两处看起来最像可以共用一份 —— 共用不了的理由具体：
 * `approvals` **只在真的问过人（或因没人可问而拒）时有一项**（gateway.ts 里那段注释写的就是这条），
 * 所以一次不需要审批的 `WebSearch`（read_only，`needsApproval` 放过）**根本不在那格里**。
 * 拿它当观测源，等于「越是不需要审批的工具越数不到」——
 * 而搜索恰好是 read_only 那一类，于是第 1 层会对**所有**正常搜索报 `silent`。
 */
export interface ToolSighting {
  readonly tool: string;
  /**
   * 在哪些位置看见过它。**可以有两个**：`handler` = 它动手前问过我们（Claude 的
   * canUseTool 是这个位置），`event_stream` = 它把动作通报给我们。
   * 两态都留着的理由与 0021 §2 同族：那两个**不是同一件事**
   * （一个是「我们有机会说不」，一个是「它做了而我们看见了」）。
   */
  readonly stages: readonly ("handler" | "event_stream")[];
}

/**
 * 工具名是不是「搜索类」。**口径不自己写**，走 `mcp.ts` 里那一份 `searchGranted`：
 * 那一份有 9 发用例，它的代价（`research` / `market_research` 也命中）已记在它文件头。
 * 这里再写一份 `/search/` 就是两个真相 —— 而这两处一旦漂，表现是
 * 「工具被授予了（那边算搜索）而观测数不到（这边不算）」，
 * 于是强制搜索领域**永远**判不出「搜过」，而且看起来像 Agent 偷懒。
 *
 * ⚠ 代价照单全收：一个叫 `research` 的非搜索工具被调用，这里会数成一次搜索，
 * 方向是**放宽**。要收紧就改 `searchGranted` 那一处并复核命中面，
 * 不要在这里加一条「更准」的匹配而那边不动。
 */
export function isSearchToolName(name: string): boolean {
  return searchGranted([name]);
}

/** 一次调用的搜索观测结论。每一态都带 `why`，因为它会原样进审计与验证结果。 */
export type SearchObservation =
  | { readonly kind: "counted"; readonly searches: number; readonly why: string }
  | { readonly kind: "not_granted"; readonly why: string }
  | { readonly kind: "silent"; readonly why: string };

/**
 * 从「授权了哪些工具 + 看见了哪些工具调用」算出观测结论。
 *
 * 三个判据的顺序有意义：**先问资格**（有没有搜索工具），**再问通路**（看不看得见），
 * **最后才数**。反过来（先数）会得到一个假读数：一个根本没有搜索工具的调用，
 * `sightings` 为空 ⇒ 数出 0 ⇒ 报成「没搜过」，而真相是「不可能搜过」。
 * 两者的修法完全不同 —— 前者是「让 Agent 下次记得搜」，后者是「要么授予工具，
 * 要么把那个领域从这个角色的岗位书里摘掉」。
 *
 * ⚠ 第二个判据的输入是【全部】工具调用而不只是搜索类：
 * 「报了 5 次 Read/Edit 而 0 次搜索」与「一次都没报」是两个读数 ——
 * 前者是 `counted 0`（Agent 确实没搜），后者是 `silent`（我们不知道）。
 * 只看搜索类命中数就把两者合并，等于把适配器的静默算成 Agent 的过错。
 */
export function observeSearchCalls(o: {
  /** 本次调用**实际授权**的工具名单（来自 harness 请求，不是岗位书）。 */
  readonly granted: readonly string[];
  readonly sightings: readonly ToolSighting[];
}): SearchObservation {
  if (!searchGranted(o.granted)) {
    return {
      kind: "not_granted",
      why:
        "本次调用的授权名单 [" + o.granted.join(", ") + "] 里没有任何搜索工具，" +
        "所以『搜过』在这条通路上**结构上不可能**成立（这是一个可证明的 0，不是没看见）。" +
        "修法不是让 Agent『下次记得搜』：要么授予搜索工具，" +
        "要么承认这个角色不该有强制搜索领域。",
    };
  }
  if (o.sightings.length === 0) {
    return {
      kind: "silent",
      why:
        "授权名单里有搜索工具，而 Gateway **一次工具调用都没看见**" +
        "（不是『看见了而没有搜索』，是『一次都没看见』）。" +
        "这两种在数数上完全一样而在含义上相反，所以这里不交 0 —— 交 0 就是把" +
        "适配器的沉默当成对 Agent 的指控。修法在适配器：它必须走 onApproval 回调" +
        "或在事件流里通报 tool_call（§12.7 第四层那七项本来就要它报）。",
    };
  }
  const hits = o.sightings.filter((s) => isSearchToolName(s.tool));
  return {
    kind: "counted",
    searches: hits.length,
    why:
      "Gateway 看见 " + o.sightings.length + " 次工具调用，其中 " + hits.length +
      " 次命中搜索类工具名 [" + hits.map((s) => s.tool).join(", ") + "]。" +
      "名字口径与授予那一侧同源（子串匹配 `search`，见 mcp.ts），" +
      "所以『授予了而数不到』这种漂法不会出现在这一层。",
  };
}

/**
 * 把三态压成 `policy.ts` 那个入参的形状。
 *
 * `not_granted` ⇒ **0**（那是一个可证明的 0，该走「没搜过」那一支并报出真实修法）；
 * `silent` ⇒ `OBSERVATION_UNAVAILABLE`（⇒ 门控那一条判 unresolved ⇒ escalate，
 * 也就是【规格】§13.3 第 1 层在看不见时**吵**而不是放行）。
 * 两支不能合并成「都算看不见」：合并之后，一个没被授予搜索工具的角色
 * 会在强制搜索领域里得到 unresolved，而它真正该得到的是「你根本没有这个工具」。
 */
export function toObservedSearches(
  o: SearchObservation,
): number | typeof OBSERVATION_UNAVAILABLE {
  if (o.kind === "counted") return o.searches;
  if (o.kind === "not_granted") return 0;
  return OBSERVATION_UNAVAILABLE;
}
