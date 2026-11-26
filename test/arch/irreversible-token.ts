/**
 * 「不可逆 ⇒ 一次性令牌」守卫（O11 动作 2，docs/OPC-OS-功能优化设计.md §O11）。
 *
 * ── 守的是什么 ───────────────────────────────────────────────────
 * §11.4 的产品决定：不可逆动作的决定必须带一次一签的凭据。这条决定今天【有实现】
 * 但散在四处：http 签票/兑换（tokens.ts，不可逆直接 403 不可签）、
 * 自动批准的 R3（auto-approve.ts，irreversible 永不自动过，判定 fail-closed）、
 * 建卡拒建（cards.ts，auto_approve ∧ irreversible ⇒ 拒建）、
 * 超时执行者（timeout.ts，靠上一条兜底）。散着的实现等于没实现：
 * 下一张「直接 UPDATE approvals SET status='approved'」的新写法不会碰它们任何一处。
 *
 * ── 形状为什么是「名单 + 特征串」而不是「import 缺失就红」──────────
 * 文档说「形状照 dependency-boundary 那种缺 import 就红」，但那条守的是【必须有】
 * 某 import，这里要守的是【绕开所有凭据的写法不许出现】——被绕开的东西不是一个
 * import（redeemToken 只属于 http 一路），而是四族各不相同的防线。可判的等价形式：
 * ① 写「卡片被决定」的文件必须逐个登记，每条带【这一路的不可逆防线是谁】；
 * ② approveCard 的调用方必须逐个登记（它的验收句原文就是「绕过 token 直接调
 *    approveCard ⇒ 必须红」）；
 * ③ 名单条目过期（特征串消失）也红 —— 单向名单会跟着代码一起烂（§7-57 那一族）。
 *
 * ── 名单不是豁免表 ──────────────────────────────────────────────
 * why 字段非空是判据之一（照 dead-modules 的「豁免表逐条被数据约束」家规）：
 * 加条目必须同时写清这一路凭什么可信，空口登记红在断言上。
 *
 * 判据纯函数化（吃 Map 不吃盘），合成语料能摆出「新增一个偷偷写库的文件」这一发 ——
 * 那就是验收句要求的变异，不必真在 src 造文件再删。
 */

/** src 相对路径 → 文件内容。 */
export type SrcCorpus = ReadonlyMap<string, string>;

/** 「卡片被决定」的写法：对 approvals 写 status 列。 */
export const APPROVE_WRITE_RE = /UPDATE\s+approvals\s+SET\s+status/isu;

/** approveCard 的调用点（definition 前挂 function 关键字，await 版只命中调用）。 */
export const APPROVE_CARD_CALL_RE = /await\s+approveCard\s*\(/u;

/** 一条登记：文件 + 它今天在场才让这条登记成立的事实 + 这一路的不可逆防线。 */
export interface ApprovePathEntry {
  readonly file: string;
  /** 特征串：在本文件出现即「这条登记指的东西还在」；消失 ⇒ 条目过期红。 */
  readonly marker: string;
  /** 这一路的不可逆防线（非空是判据，见文件头「名单不是豁免表」）。 */
  readonly why: string;
}

export const APPROVE_PATHS: readonly ApprovePathEntry[] = [
  {
    file: "engine/approve.ts",
    marker: "CLAIM_CARD_SQL",
    why:
      "人席写路径本身。它自己不查票，可信性来自调用方名单（APPROVE_CARD_CALLERS）：" +
      "只有 real-deps（远程先兑换一次性票 / 本机走 HMAC+仅回环）与 engine/work（CLI，" +
      "CEO 坐在终端前，凭据=物理在场）两处到得了它。",
  },
  {
    file: "http/real-deps.ts",
    marker: "redeemToken",
    why:
      "远程决定必须先兑换一次性令牌（UPDATE im_tokens 的 AND used=? 烧票、" +
      "approval_mismatch 比对票上卡片、不可逆在签发侧就 403 不可签）；" +
      "本机决定走 HMAC + 仅回环绑定。",
  },
  {
    file: "policy/auto-approve.ts",
    marker: "AUTO_APPROVED_BY",
    why:
      "机器批准走 R3：tier=irreversible 永不自动通过，且 tier 判定 fail-closed" +
      "（参数缺失/形状坏 ⇒ 判成不可逆）。今天零生产调用方，条目在它被接线的日子继续有效。",
  },
  {
    file: "approvals/timeout.ts",
    marker: "TIMEOUT_ACTOR",
    why:
      "超时执行者的 auto_approve 支不查票，兜底是建卡拒建判据（本文件判据④）：" +
      "auto_approve ∧ irreversible=true 的卡【建不出来】，所以到得了超时自动放行的卡必然可逆。" +
      "escalate 支建的是新 pending 卡，不是决定。",
  },
] as const;

/** approveCard 的合法调用方。新调用方 = 新的「直接决定」入口，必须先在这里论证。 */
export const APPROVE_CARD_CALLERS: readonly ApprovePathEntry[] = [
  {
    file: "http/real-deps.ts",
    marker: "approveCard",
    why: "serve 路由的 decide 落库点；远程路径在走到这里之前已经烧过一张一次性票。",
  },
  {
    file: "engine/work.ts",
    marker: "approveCard",
    why:
      "`hub decide` CLI 入口：CEO 本机命令行，凭据是物理在场，与 hub:engine 同一条信任域；" +
      "不可逆卡从这里批准仍然只是【人做了决定】，不绕任何面向机器的自动放行。",
  },
  {
    file: "channels/approval-bridge.ts",
    marker: "isIrreversibleApproval",
    why:
      "IM 回信落库点（O12 动作 1 的桥）。凭据两格：① 身份 = 已验证的 im_bindings 绑定，" +
      "决策前重查一次（未验证 / 问不到平台 ⇒ null ⇒ 不落库）；" +
      "② 不可逆 = 落库前用 tokens.ts 的 isIrreversibleApproval 读【此刻库里那一行】再判一遍，" +
      "命中就拒。⚠ 第二格【不是】重复抽象层 handleOne 那一遍：那一遍在调用方身上，" +
      "而 act 是本模块的导出、装配方可直调 —— 这一路的凭据必须自带，不能引用别人路上的一道门。" +
      "今天它【在跑】（round282 更正：原句写「从任何生产入口都走不到（无真 IM 适配器）」，" +
      "而 `serve/im-channels.ts` + 心跳里的 `pollRound()` 让这条路通了）。" +
      "登记的始终是【凭据两格】本身，射程那半句会变 —— 别把它当判据读。",
  },
] as const;

/** 判据④的锚点：建卡拒建判据在 cards.ts 的原文特征串。 */
export const REJECT_BUILD_MARKER = "不能共存";

/**
 * 总判据：返回 "" = 今天自洽；非空 = 人话报警（多条用 | 拼）。
 */
export function checkIrreversibleToken(srcs: SrcCorpus): string {
  const problems: string[] = [];

  // 判据①：名单外不许出现「写卡片决定」的文件。
  const registered = new Set(APPROVE_PATHS.map((e) => e.file));
  for (const [name, text] of srcs) {
    if (APPROVE_WRITE_RE.test(text) && !registered.has(name)) {
      problems.push(
        "[" +
          name +
          "] 直接 UPDATE approvals SET status —— O11：任何写「卡片被决定」的路径" +
          "必须先在 APPROVE_PATHS 登记，并写明这一路的不可逆防线（票/R3/拒建/物理在场），" +
          "不接受空口条目。",
      );
    }
  }
  // 判据①反向：登记条目的特征串还在。
  for (const e of APPROVE_PATHS) {
    if (e.why.trim() === "") {
      problems.push(
        "APPROVE_PATHS 条目 [" + e.file + "] 的 why 为空 —— 名单不是豁免表。",
      );
    }
    const text = srcs.get(e.file);
    if (text === undefined || !text.includes(e.marker)) {
      problems.push(
        "APPROVE_PATHS 条目 [" +
          e.file +
          "] 过期：特征串「" +
          e.marker +
          "」不在该文件里 —— 防线可能已被删掉，去更新登记或把防线补回来。",
      );
    }
  }

  // 判据②：approveCard 的调用方名单（双向）。
  const callers = new Set(APPROVE_CARD_CALLERS.map((e) => e.file));
  for (const [name, text] of srcs) {
    if (APPROVE_CARD_CALL_RE.test(text) && !callers.has(name)) {
      problems.push(
        "[" +
          name +
          "] 调用 approveCard —— §O11 验收句：绕过凭据校验直接调 approveCard" +
          " 必须红。新调用方要先在 APPROVE_CARD_CALLERS 登记这一路的凭据（票/HMAC/物理在场）。",
      );
    }
  }
  for (const e of APPROVE_CARD_CALLERS) {
    // 反向核对用 marker（文件里提到这个名字即可），不用调用正则：
    // real-deps 的调用不带 await（`const r = await approveCard(...)` 是 work.ts 的形状，
    // real-deps 是 `const r = approveCard(...)`），两套形状统一成正则会漏真调用。
    const text = srcs.get(e.file);
    if (text === undefined || !text.includes(e.marker)) {
      problems.push(
        "APPROVE_CARD_CALLERS 条目 [" +
          e.file +
          "] 过期：特征串「" +
          e.marker +
          "」不在该文件里 —— 它已不再调用 approveCard。",
      );
    }
  }

  // 判据④：兜底拒建判据还在（timeout 的 auto_approve 支的可逆性靠它兜）。
  const cards = srcs.get("approvals/cards.ts");
  if (cards === undefined || !cards.includes(REJECT_BUILD_MARKER)) {
    problems.push(
      "approvals/cards.ts 里的建卡拒建判据（特征串「" +
        REJECT_BUILD_MARKER +
        "」）不见了 —— auto_approve ∧ irreversible 的卡又能建出来了，" +
        "timeout.ts 的 auto_approve 支随之失去兜底。",
    );
  }

  return problems.join(" | ");
}
