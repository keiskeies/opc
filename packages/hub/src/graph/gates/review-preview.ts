/**
 * 「同族审阅要 CEO 每一次都批」这件事的**读数**（O4 §「顺带一条被高估的东西」那一格）。
 *
 * ── 这一篇存在的理由：那句话今天在界面上【说不出来】 ────────────────────
 * `docs/OPC-OS-功能优化设计.md` O4 段的原话是：`reviewGate` 的独立性判据在今天的机器上
 * 【每次审阅都会命中】—— 一台机器上所有角色共用一个 `model_family`，所以那道门不是
 * 「偶尔要点的例外」，是「每一次都要点一下的常量」，而
 * 「这一点在界面上必须说出来（否则 CEO 会以为自己偶尔需要看一眼，而实际上他需要每次都看）」。
 *
 * ⚠ 但【直接把那句抄进界面】是错的，两处都错：
 *  ① 它在这台机器的【真库】上成立，在【演示图】上不成立 —— `serve/dev-seed.ts` 刻意把
 *     父子家族错开（那文件 :93-94 自己写着「让将来加委派边演示时门控不会一上来就红」），
 *     七种家族铺开 ⇒ 绝大多数配对本来就判得过。界面若写死「每次都要点」，
 *     它在自己正在演示的那张图上就是【假的】。
 *  ② 更要紧的是形状：那是一句【判据的结论】，界面写它就是一份抄件（0042 整篇立的论题，
 *     `app.js` 里也有一条同款自述）。抄件不会红 —— 判据改了、图改了、家族改了，
 *     那句话一个字都不动，而它已经错了。
 * ⇒ 所以这一篇把那句话变成一个【从当下这张图算出来的读数】，界面只念它。
 *
 * ── 为什么【调用】author-reviewer 而不是自己比字符串 ──────────────────
 * `sameFamilyReviewBlock` 是那条判据的其中一份正本（`harness/verifier.ts` 复用的也是它，
 * 那边原话：「判据**复用**门控层那一份，本模块不写第二份『什么算同源』」）。这里再复用一次。
 * 差别一眼可见：若这里写成 `a.model_family === b.model_family`，
 * 「两边都没配家族」会被算成【同族】（两个空串相等），而正本判的是
 * `unknown_model_family` —— 后者是「先把家族配上」，前者是「点一次批准就行」，
 * **给 CEO 的修法完全不同**。所以「复用还是抄」不是审美：
 * `review-preview.test.ts` 有一发专门打在这一格上（内联一份等号 ⇒ 那一发当场红）。
 *
 * ── 分母是什么，以及它【不是】什么 ⚠ 读这段再读下面任何一个数 ──────────
 * 分母 = 图上【不同角色的无序对】（k 个角色 ⇒ k(k-1)/2 对）。它答的是
 * 「按你现在声明的这些家族，如果两个角色之间发生一次审阅，那道门会不会拦」。
 * 它【不答】「实际会发生多少次审阅」：真闸门跑在
 * `dispatch` 的 `task.status === "IN_REVIEW"` 那一遍上，两侧是
 * `lastProducer(taskId)` 与 `task.role` —— 由【运行期的流转】决定，不由委派边决定。
 * （⚠ 这一格在 O4 接线后要说得更准：委派边的 `review_gate` 现在【有】运行期读者了 ——
 * `dispatch` 的判据 3 经 `selfReviewEdgeBlock` → `independentReviewerPath` 读它，
 * 判「产出方有没有一条带门控的出边」。但那一读仍然【不问家族】，家族那一维
 * 才是本读数的分母；两维判的是同一条 §8.2 的两个不同维度，所以「配对数 ≠ 审阅次数」
 * 这个结论一个字不改。其余读者仍是 `db/integrity.ts` 那条巡检与
 * `commit.ts` → `validateNewEdge` 那条保存期判据。）
 * 把「配对数」说成「审阅次数」就是拿结构读数冒充运行期预测 ——
 * 所以字段名一律叫 `pairs_*`，界面上那一句的主语也一律是「配对」。
 *
 * ⚠ 无序对不是偷懒：这条判据对方向【不敏感】（家族相等是对称的），
 * 所以 (a,b) 与 (b,a) 永远同结论，数两遍只会把分母吹大一倍，
 * 让「一半的配对要批」读成「四分之一的配对要批」。
 *
 * ── 三种落点，互斥且【和为分母】 ───────────────────────────────────
 *  · ok              家族不同 ⇒ 判得过，这一次审阅不需要 CEO 出现。
 *  · same_family     家族相同 ⇒ 拦，但【可以批】：CEO 点一次就放行（§5.9）。
 *  · refused         正本给了别的 code（`unknown_model_family`，以及极端情形下
 *                    role_id 全空白触发的 `self_review`）⇒ **点批准没用**，
 *                    得先改图（配家族 / 改 role_id）。这一档不许并进 same_family：
 *                    并了就得到「N 次点击可解决」这个假承诺。
 * `author-reviewer.ts` 里那条 `approval_by_author` 分支这里【到不了】：本函数根本不传
 * approval（问的就是「没人批的时候会不会拦」），所以那个 code 不出现在读数里。
 */
import type { OrgGraph } from "@opc/contracts";
import { sameFamilyReviewBlock } from "./author-reviewer.js";

/** 一条配对的读数。`reason` 是【正本自己的原话】，界面逐字显示、不重写措辞。 */
export interface ReviewPreviewPair {
  readonly producer: string;
  readonly reviewer: string;
  readonly code: string;
  readonly reason: string;
}

/**
 * `GET /org` 上那个计算键的形状。
 *
 * 为什么住在 hub 而不在 contracts 落一张 schema：`GET /org` 今天【整条没有】视图 schema
 * （它直接把 `graph_json` 那张图 + 版本元数据发出去，`http/org.ts` 的函数头写着这件事），
 * 只给新加的这一个子对象补 schema、其余照旧裸发，会得到一条「半条路由有契约」的假象。
 * 这一格的纪律靠【出参构造点唯一 + 本接口】，与 `approvals/query.ts` 的
 * `ListApprovalsResult` 同一档（那边也是 hub 侧具名接口，不在 contracts）。
 */
export interface ReviewIndependencePreview {
  /** 参与配对的【角色数】。0 或 1 ⇒ 分母为 0，下面任何数都不许被读成「没问题」。 */
  readonly roles: number;
  /** 无序对总数 = roles*(roles-1)/2。**这一格是分母，界面上必须露出来。** */
  readonly pairs_total: number;
  readonly pairs_ok: number;
  /** 家族相同 ⇒ 每一次这样的审阅都要 CEO 点一次。 */
  readonly pairs_same_family: number;
  /** 正本直接拒、批准也点不过去的配对数（见文件头第三档）。 */
  readonly pairs_refused: number;
  /**
   * 「每一次都要点」那一格，由【服务端】判，不由界面比数字。
   * = 分母非零 且 全部配对都落在 same_family。
   * ⚠ 全落在 refused 时它是 false —— 那时该说的是「配上家族之前一次都批不了」，
   *   不是「要点很多次」。
   */
  readonly always_needs_approval: boolean;
  /** 存在 refused 配对（修法不是点击）。与上面那一格【互相独立】，可以同真。 */
  readonly any_refused: boolean;
  /** 所有非 ok 的配对，各带正本原话。空数组 = 这张图上没有任何配对被拦（分母仍可能为 0）。 */
  readonly blocked: readonly ReviewPreviewPair[];
}

/**
 * 对整张图算审阅独立性的结构读数。纯函数：不碰库、不碰 HTTP、不碰时间。
 */
export function reviewIndependencePreview(
  graph: OrgGraph,
): ReviewIndependencePreview {
  // 键排序 ⇒ 读数与 Object.keys 的枚举顺序无关。这一格不是为了好看：
  // 不排序的话「同一张图两次 GET 给出同一串」这件事借的是 V8 的字符串键插入序，
  // 而 blocked 那一段是要原样进界面、也可能进审计的列表。
  const keys = Object.keys(graph.nodes).sort();
  const familyOf = (role: string): string =>
    graph.nodes[role]?.model_family ?? "";

  let ok = 0;
  let sameFamily = 0;
  let refused = 0;
  const blocked: ReviewPreviewPair[] = [];

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i] as string;
      const b = keys[j] as string;
      // 不传 approval：问的就是「没有 CEO 批准时，这道门会不会拦」——
      // 那正是「CEO 需不需要出现」的定义。传了就把问题换成「批了之后过不过」，
      // 那永远过，读数会被读成「不存在这一格」。
      const r = sameFamilyReviewBlock(
        { roleId: a, modelFamily: familyOf(a) },
        { roleId: b, modelFamily: familyOf(b) },
      );
      if (r.ok) {
        ok++;
        continue;
      }
      blocked.push({
        producer: a,
        reviewer: b,
        code: r.code,
        reason: r.reason,
      });
      if (r.code === "same_model_family") sameFamily++;
      else refused++;
    }
  }

  // 少于两个角色时【直接给 0】而不是走 `k*(k-1)/2`：`0 * -1 / 2` 是 **-0**，
  // 而 `-0` 过 `Object.is` 不过、`JSON.stringify` 又把它写成 `0` ——
  // 一个只在「界面拿它做严格比较」时才现形的形状。由测试逼出来的，不是先想到的。
  const total = keys.length < 2 ? 0 : (keys.length * (keys.length - 1)) / 2;
  return {
    roles: keys.length,
    pairs_total: total,
    pairs_ok: ok,
    pairs_same_family: sameFamily,
    pairs_refused: refused,
    always_needs_approval: total > 0 && sameFamily === total,
    any_refused: refused > 0,
    blocked,
  };
}
