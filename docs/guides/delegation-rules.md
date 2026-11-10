# 委派与组织图的规则（哪些是代码拦的，哪些只是约定）

- **读者**：改 `packages/contracts/src/org/`、`packages/hub/src/graph/gates/author-reviewer.ts`，
  或在配置页上拖动组织图的人。
- **这篇的定位**：规格 §18.3 给了三层校验的**清单**，而清单不告诉你三件事 ——
  哪几条真在代码里、哪几条规格示例是**错的**、以及哪几条今天还没有运行时的手。
  这三件事各导致过一次真实的实现错误，都记在下面并标了出处。
- **一句话口径先给出来**：**保存期判的是「这张图将来会不会导致越权」，运行期判的是
  「这一次审阅够不够独立」。两份判据重叠但不重合，故意不合并**（理由见 §4）。

## 1. 两种关系，别混

| 关系 | 存在哪 | 语义 | 基数 |
|---|---|---|---|
| **汇报**（`reports_to`） | 组织图节点上的一个标量（岗位书里也有同名字段） | 谁是谁的上级；升级路径沿它走 | 一个角色只有一个直接上级 |
| **委派**（edge `from → to`） | 组织图的 `edges` | `from` 产出，`to` 审阅 | 多对多，**允许成环** |

为什么汇报关系用标量而不用边表（`packages/contracts/src/org/graph.ts`）：用边表就得自己写
「同一 child 不得有两条 parent」的校验；用标量，那条不变量由类型给。
反面更值得知道：把 `reports_to` 拼成 `report_to` 而 schema 不 strict，
会得到一张**没有汇报关系的图，而三层校验全绿**（没有树 ⇒ 没有环、没有超深，
可达性判定只会看到一个孤立节点集）。所以 `orgGraphSchema` 的 `.strict()` 不是洁癖。

**委派环是合法的。** `dev → dev2 → dev3 → dev` 这种同行评审环被明确放行
（§8.2 允许同行互审）。但**自环不行**，而且规格示例漏了这一格：
示例那句 `getDescendants(child).includes(newParent)` 里 `getDescendants` 不含自身，
于是「把自己挂到自己下面」按示例判是**放行**的。代码把自环判据放在环判据**之前**
（`validateReparenting`，`packages/contracts/src/org/validate.ts`）。
同一份示例的第二处真错在 §3 的深度那条。

## 2. 三层校验与拒绝码全表

入口在 `packages/contracts/src/org/validate.ts`。三个函数各管一层，**顺序不能换**：
先判「这张图本身是不是张正常的图」，再判这一条改动，最后判发起者与影响面。

| 函数 | 管什么 |
|---|---|
| `rejectMalformed(org)` | 图本身不合规（`reports_to` 成环、悬空引用）。**任何一条判据都假设图是正常的**，所以它必须先跑 |
| `validateReparenting(child, newParent, org)` | 改汇报关系 |
| `validateNewEdge(source, target, org, reviewGate)` | 加一条委派边 |
| `violatesNoSelfReview(source, target, org)` | 「作者不给自己打分」这一维，被上面两个复用 |
| `wouldExceedMaxDepth(org, source, target)` | 加边后的委派链深度 |
| `validateOrgChange(change, actor, runningTasks)` | 谁发起的、有没有任务在跑 |

拒绝码（`RejectCode`）与它真实挡住的东西：

| code | 什么时候出 | 为什么是这一码而不是更直观的那个 |
|---|---|---|
| `not_ceo` | `actor.type !== "human" \|\| actor.id !== "ceo"` | **两个条件都要、是「或」**。只判 id，则一个 `role_id: ceo` 的 agent 就能改组织 —— 而 §4.2.3 把资源分配权集中给的是**人**那个 CEO，不是那个字符串。这不是假想：图里 `report` 节点用的就是 `ceo` 这个 role_id |
| `unknown_role` | 子角色 / 上级 / 委派边任一端不在图里 | 委派边指向不存在的节点是本仓最容易的配错方式（见 §5） |
| `would_create_cycle` | 挂到自己下面，或挂到自己下级之下 | 自环单独判，见 §1 |
| `parent_not_manager` | 新上级 `can_manage` 为假 | §18.3 判据 2 |
| `ceo_is_root` | 改 CEO 的汇报关系 | §18.3 判据 4：根不可动 |
| `depth_exceeded` | 超过 `ORG_MAX_DEPTH`（5） | 两处判据、两个公式，**不一样**，见 §3 |
| `missing_review_gate` | 新委派边没配审阅门控 | 「门控绑在边上、不可绕过」（§8.2 第 4 条）的载体就是这个布尔 |
| `self_review` | 委派边 `source === target` | 图结构硬约束，**不接受运行时豁免** |
| `unknown_model_family` | 任一端 `model_family` 缺失或空白 | **方向是拦而不是跳过**：否则「不声明家族」就成了绕过同家族拦截的暗道。这一码也用在「节点已不在图里、被单独重判」的场合 —— 那时它比 `unknown_role` 更诚实 |
| `same_model_family` | 两端同家族 | 「两个不同 agent」只是表象，同家族判断高度相关。批准凭据在 `review_gates` 表里而**不在图里**，所以这个纯函数一律拒，由保存路径带凭据重判 |
| `escalation_unreachable` | 加边后 `target` 走不到 CEO | 产出必须能一路被看见。**这一条只能在保存时自己判**：计划 V12 实测 LangGraph 对条件边声明 `ends` 却总返回 `END` 也照样编译通过 |
| `report_cycle_present` / `dangling_report` | 由 `rejectMalformed` 出 | 见 §3 末段：成环的图会让深度判据**放行**，所以它必须先被拒掉 |

⚠ `validateOrgChange` 在「有任务在跑」时返回的是 **`ok: true` + `needsConfirmation`**，不是拒绝。
那句「变更仅对新任务生效」是给 CEO 的预期管理文案，**它由 §18.4 的版本化提交保证，不由这个函数保证** ——
函数文件头明写着这条边界。读代码时别把它当成已生效的保证。

## 3. 深度：上限 5，而「深度」有两个互不相同的算法

`ORG_MAX_DEPTH = 5`（`packages/contracts/src/org/graph.ts`）。**根 = 1**
（`depthOf(org, "ceo") === 1`），于是「CEO + 4 层」正好用满。
这个约定必须写在代码里：规格没说 CEO 算 1 还是 0，而这条判据差一层就是差一整层组织。

两个场景算的不是同一个东西：

**改汇报关系**（`validateReparenting`）：`depthOf(newParent) + heightBelow(child) > 5` ⇒ 拒。
必须加上被挂那一支自己的**高度**。规格示例那句 `getDepth(newParent, org) + 1 > MAX_DEPTH`
只算了被挂节点自己，漏了它**带着的下级**：把一支三层深的子树挂到第四层下面，
示例那句给出 `4+1=5` 通过，实际最深处到了 7。这是我认为示例的一处真错（推导与用例见 0011）。

**加委派边**（`wouldExceedMaxDepth`）：`(走到 source 的最长链) + 1 + (从 target 出发的最长链) > 5` ⇒ 拒。

这里有一段值得单独抄出来的教训，因为它是「判据在合法输入上恒真」这一类错的典型：
**「最长路径」在有环的图上是无限的，而委派环合法（§1）。**
第一版按「步数预算耗尽就封顶」实现，于是任何合法的同行评审环都让 `longestChainTo` 返回 6
（`test → dev → test → …` 反复走满 6 步）。实测：在一张**只有一条 `dev⇄test` 环**的正常组织图上，
**任何**新增边都被判「超过 5 层上限」。这不是误报某条边，是这条判据在一批合法图上恒真 ——
症状是「CEO 加不了任何委派边」，而报错指向「层级超限」这个与真相无关的方向。
根因：把「路径不能无限长」实现成了「步数不能无限花」，前者约束**节点**、后者约束**步数**，
有环时两者不等价。改成**简单路径**（`onPath` 集合，不重复经过节点）后环不重复计数。

复杂度的账：最长简单路径一般 NP-hard，这里靠「上限只有 5」收住
（某条简单路径长度一到 LIMIT 就停止展开，再长也必然超限），上界 `O(N·5^L)` ——
几十个节点的组织图是微秒，换来的是含合法环不误拒。

**成环的图为什么必须先拒**（`rejectMalformed`）：环会让 `heightBelow` 因为 visited 保护而返回一个
**偏小**的高度，于是深度判据**放行**。所以「坏图不得放行」这条红是 `rejectMalformed` 挣来的，
不是深度函数挣来的。这句话的作用范围写明了：如果有人把 `rejectMalformed` 挪走或改成告警，
深度函数就从「防御」变成「唯一的闸门」，而它拦不住放行方向。

## 4. 运行期那一跳：审阅者必须是谁

保存期判过了图，运行期还要判**这一次**审阅。判据只有一句话
（`packages/hub/src/graph/gates/author-reviewer.ts`，函数 `independentReviewerPath`）：

> 存在一条边 `from === author` 且 `gate === true` 且 `to !== author` ⇒ 这个作者有独立审阅者。

三条各有来历：

- **只看一跳，而且这是刻意的。** 第一版是 BFS，而它的 frontier 推进是空的（`next` 从未 push），
  于是「声称多跳、实际只看一跳」。修它有两种改法：把 `next` 补上（放宽语义），或把循环删掉
  （承认语义就是一跳）。选了后者 —— 留着那个循环，哪怕行为相同，也是在代码里挂一个
  「这里会走多跳」的暗示，而下一个人会信它。**看到一段看起来更严格的代码，先确认它是不是想更严格。**
- **`gate !== true` 的边不算审阅。** 「有人在我下游」不等于「有人审我」。
- **`to === author` 不算，哪怕带门控。** 带门控的自审仍是自审（§8.2 第 1 条讲的是独立性，不是位置）。

返回的路径形状固定是 `[author, reviewer]` 两元素，因为配置页要显示「谁审」。

**为什么这份判据不与 §2 的 `violatesNoSelfReview` 合并**：那边判「这条边**将来**会不会导致自审」，
而 org 里除了 `model_family` 没有任何运行时信息（批准凭据在 `review_gates` 表里，不在图里）；
这边判「**这一次**审阅的双方 + 一张批准凭据」。合并要么让运行时那份读不到批准，
要么让保存时这份假装读不到。重叠部分只有「同一角色即拒」那一句，硬共享会让两个模块互相 import 出环。
**这条重复是权衡后选择的**，登记在 0011 等一次审视 —— 也就是说它是个已知债务，不是没想到。

### ⚠ 两条边类型同名不同形，字段名不一样

- `packages/contracts/src/org/` 那套：字段是 **`review_gate`**（`delegationEdgeSchema`，`.strict()`）。
- `packages/hub/src/graph/gates/author-reviewer.ts` 那套：字段是 **`gate?`**（可空）。

两套**有意不合并**（hub 那套不带审阅门控载荷，它判的是运行时的一跳）。
后果：**把一整套 edges 直接喂给另一个函数会因为 strict 而报未知键，或者更糟 ——
`gate` 读成 `undefined`，于是所有边都不算审阅，`no_independent_reviewer_path` 全线炸**。
这是本仓最容易制造「所有角色都没有独立审阅者」这个假事故的方式。跨层传边必须显式映射字段名。

## 5. 角色标识：`role_id` 必须等于文件名，而短名/语义名还没拍板

- `charter.test.ts` 断言每个模板 `roleId === 文件名`。不一致会让委派图的节点找不到角色，
  而且「改一处忘一处」是最常见的配错方式。
- **但用哪套名字还没定**（计划 §10.2 D11）：模板现用短名（`dev` / `test` / `tech` / `assistant` / `product` / `ops` / `ceo`），
  规格附录 B 用语义名（`test_engineer` / `tech_director`）。
  **定案前不要改任何一份**：只改模板而不同步改委派图，委派边就指向不存在的节点（`unknown_role`）；
  只改委派图则模板加载后节点名对不上，症状相同、方向相反，更难查。
- **形状上没有任何约束**：`role_id` 在 schema 里只是 `z.string().min(1)`（我一度以为它有
  `^[a-z0-9_-]+$` 这样的正则 —— 那是没有的，全仓 `grep 'a-z0-9'` 只命中扩展名清洗、
  `METRIC_CONDITION` 和迁移文件名三处）。所以 `Dev` 与 `dev` 在 schema 层是两个合法值，
  而委派边只能指向其中一个字面量 —— 大小写不一致**不会被任何一层拦下**，症状是
  `unknown_role`（保存期）或「这个角色没有独立审阅者」（运行期），两处都不指向真正的原因。
  唯一的钉是 `charter.test.ts` 那条「等于文件名」，而它只覆盖那 7 个模板。


## 6. 今天还没长手的地方（别以为图对了事情就发生了）

列全，因为「图校验通过」很容易被读成「委派与审阅已经生效」：

1. **三层校验本身接得上，但那条通道零生产调用方。** `org/commit.ts` 的 `applyChange`
   确实按 §2 的顺序调 `validateReparenting` / `validateNewEdge` / `validateOrgChange`，
   而**`commitOrgGraph` 在 `packages/*/src` 里没有任何调用方**（http 只从那个文件 import 了一个
   `currentGraphVersion` 用来读，没有任何路由或 CLI 命令能提交一次组织图变更）。
   连带地组织图编辑器（Task 3.2 的 React Flow）也还没实现 —— 所以现在改组织图只能直接写库，
   而**直接写库会绕过这三层校验的全部**。这是本文件最实用的一条：判据写得很全，
   而唯一能触发它们的那条路今天没有入口。
2. **门控零生产调用方**（`evaluateGate` 与 `gateCriteriaForRole` 都只有自己的单测在调），
   委派边上的 `review_gate: true` 今天**不会拦下任何一次交接**。它是配置面的事实，不是运行时的事实。
   详见 `how-to-write-a-charter.md` §6 第 1 条。
3. **运行期那两个审阅判据也还没接上。** `sameFamilyReviewBlock` / `selfReviewEdgeBlock` 被
   `gateConfigBlock` 汇总（注释写着「配置页要一次把三个问题都显示出来」），
   而**`gateConfigBlock` 自己也零生产调用方** —— 配置页就是它预期的那张脸，而它还不存在。
   所以「同家族审阅会被拦」今天同样是关于代码的陈述。
4. **`decision_scope.requiresConsultation` 零运行时读者。** 升级路由 `packages/hub/src/graph/routing/escalation.ts`
   有一个入参叫 `outsideDecisionScope`（注释写着「本次动作是否落在 requiresConsultation / forbidden 里」），
   但**没有任何代码去算它** —— 它是一个等着被接的插口（`grep -rn outsideDecisionScope packages/*/src`
   只有两处命中：那个字段声明，和读它的那一行 `if`）。今天写 `跨模块接口变更 → consult: tech`
   不会有任何东西去查这句话。
5. **`escalation_triggers`（岗位书里那份）零读者。** 那份列表在 `packages/*/src` 里除了 transform
   那一行再无命中。「升级会沿汇报链往上」这件事如果要发生，得由图与升级路由给 ——
   所以改升级行为要改那两处，不要改这份列表。⚠ 这一条我**没有**同时验证「升级目标一定沿 `reports_to`
   解析」：`escalation.ts` 里没有 `reports_to` 字样，我没找到它解析目标的那段代码，
   所以这句话的正确强度是「没找到沿汇报链解析的实现」，不是「升级不走汇报链」。
6. **`tasks.graph_version` 一度全是假的 1，那一格已经补上了**（0012 记的是发现过程）。
   现在 `INSERT_TASK_SQL` 把这一列作为 INSERT 的一列写进去，并且与 `currentGraphVersion()` 的取数
   共用 `node()` 回调里那条连接、那个事务 —— **不能**改成「插入后再发一条 UPDATE」：
   那会留一段「任务行已存在而版本还是 1」的窗口，而且两次 `node()` 是两个事务，
   中间允许别人提交一版，于是建出「在 v7 生效之后建、却盖着 v6」的任务而一句报错都没有。
   读某一条任务的图时，先确认它不是那种窗口留下的一行。

## 7. 想改这些判据之前

- **纯函数就别塞 I/O。** 三个校验函数都是纯的；`RunningTasksInput` 之所以是「一个 id 数组」而不是
  「一个查询函数」，就是因为查函数会把 I/O 塞回纯函数。要数量就在调用方查 SQL（hub 的 commit 路径）。
- **`reviewGate` 是入参而不是从 org 里查。** 规格 §18.3 的签名写的是 `hasReviewGate(source, target, org)`，
  但 §18.2 的流程是 `onConnect → validateNewEdge → 通过后弹出边配置面板`：门控配置在校验**之后**才填。
  按字面实现，第一条新边**必然**被「必须配置审阅门控」拒掉（它还不存在于 org 里），这个功能写不出来。
  所以缺省 `false`（保守：没说带门控就是不带）。**这是规格示例与规格正文互相矛盾、按正文实现的一处**，
  改它之前先读那段注释。
- **报错要能指到具体那一条。** 深度那条会打出「X 之前有几层、边本身 1 层、Y 之后还有几层」；
  `unresolvableClaimIndexes`（证据侧）返回的是**没对上的下标数组**而不是布尔。
  只说「有引用无效」「层级超限」的报错等于让下一个人自己重算一遍 —— 而他重算时会先怀疑图。
- **改任何一条判据，先做一次变异**：把判据放宽一档，看有没有测试因此变红。
  红 = 这条判据被钉住了；不红 = 你现在是在没有护栏的情况下重写一条安全判据，
  那就必须同时补上断言（本仓「没有测试锁住 X」这类话只能由变异实验证明，不能由「我搜过了」证明）。
