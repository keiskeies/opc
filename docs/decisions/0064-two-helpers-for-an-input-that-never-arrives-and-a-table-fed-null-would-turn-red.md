# 0064　O4 的收尾：一条【为到不了的输入造审计】的支路删掉了；一张【喂 NULL 就会恒红】的表定格为预留

## 1. 一句话

O4 剩的三个动作本轮全部处置完，而三个的落点都不一样：**动作 3 删除**
（`forbiddenRemovalAttempt` / `unauthorizedAttemptPayload` 删掉，连同 6 发测试）——
因为那条审计要回答「谁的请求里有 removeForbidden」，而**全仓没有任何生产构造点会带这个字段**；
**动作 2 登记为前提不成立**（`independentReviewerPath` 保留为纯判据，不新增 dispatch 消费点）——
因为无门控委派边在**保存期**就被 `validateNewEdge` 拒了，dispatch 运行期读不到那种边，
"记一条 unresolved" 没有可触发它的事实；**动作 4 接受预留**（integrity 文案从"在等写入方"
改成"预留非缺陷"）——因为 review_gates 的行要求 `evidence_bundle_id` 指向**存在的**证据包，
而证据包在生产的写入方是 O5 那一格，先接 INSERT 只会把 `not_observable` 换成**恒 violated**。

三个动作一个删、一个标注、一个改文案，代码净行数是负的。这不是"没做"——
是【配置层判据要么接上、要么删掉，不允许第三态】这一格的目标在实测下的完成形态：
接上的前提是有一个等待被判的输入，而实测这三个格子的输入都不存在。

## 2. 动作 3：删。依据是一张调用点表，不是一次直觉

O4 动作 3 原话给了两个选项：「要么把黑名单删除尝试也接到这里（dispatch 的
`unauthorized_attempt` 写路径），要么把这两个函数删掉。」接线这条路我量过之后走的不是"不想接"，
是**没有东西可接**：

| 事实 | 实测 |
| --- | --- |
| `forbiddenRemovalAttempt` / `unauthorizedAttemptPayload` 的 src 生产调用点 | **0 / 0**（0062 §2 的阳性对照探针量过；本轮 grep 复核） |
| 这两个函数的职责 | 只服务于「运行时请求删黑名单」这个输入的【审计措辞】——loader 抛错管拒绝，它们管「具体想删哪几条」 |
| 那个输入的生产构造点 | **0**：`CharterRunOverrides.removeForbidden` 全仓（src）只有 loader 的定义一处命中；没有任何调用方构造它 |
| 真正的删除闸门 | `mergeForbiddenForRun`：`removeForbidden` 非空 ⇒ 直接抛（措辞指 §20.2 / §4），有测试钉着 |

把两个函数"接线"意味着什么：先要在某条生产路径上**造出**一个能带 `removeForbidden` 的请求，
再在 loader 抛错之前把差集写成审计行。**那是为了喂两个函数而新造一条越权输入面**——
黑名单删除的防护本身（抛错）早在 loader 里，删掉这两个函数后防护一格没少。
留着的代价倒是具体的：两个零调用方函数 + 6 发只测它们自己的测试，
让「黑名单删除有完整审计」这件事在代码里**读起来成立**。

删的范围：`author-reviewer.ts` 两个导出 + `UnauthorizedAttemptPayload` 接口 +
随之失去读者的 `Charter` import；`author-reviewer.test.ts` 的整个越权 describe（6 发）+
失去用途的 `grab` 夹具与 `Charter` import。**28 发 → 22 发，全绿；`tsc -b` exit 0。**
`mergeForbiddenForRun` 自己的测试（charter.test.ts 的 removeForbidden / `forbidden: []` /
只增不减三组）一发没动——防护的测试还在防护本身上，不在包装上。

顺带更正了一处被这次删除变假的文档：`docs/guides/how-to-write-a-charter.md` 的字段表写着
`decision_scope.forbidden` 有**两个**读者。删掉之后只剩 `mergeForbiddenForRun` 一个，
那句话在删除落地的同一批里就该变——它是 0063 那一族（现在时的句子会被代码变假）的
现行案例，只不过这次变假的触发者是【我自己动手的删除】而不是【长出来的生产者】。

## 3. 动作 2：前提是「运行期会遇到无门控边」，而运行期遇不到

O4 动作 2 原话：「`independentReviewerPath` 那一跳的语义先在 `dispatch` 的 handoff 上判：
委派边若没有审阅门，允许，但记一条 unresolved，而不是静默放行。」

这句话里有一个没被验过的存在假设：**dispatch 的 handoff 会踩到一条【存在但没门控】的委派边**。
本轮量的三件事把它拆掉了：

1. **无门控边进不了图**（保存期）。`contracts/org/validate.ts` 的 `validateNewEdge` 第一条
   业务判据就是 `missing_review_gate`——`review_gate: false` 的委派边拒绝保存
   （§8.2 第 4 条「门控绑在边上」在保存期的载体）。这条判据在**生产活路径**上：
   `POST /org` → `commitOrgGraph` → `revalidate` → `validateNewEdge`（0040 把入口接活了）。
2. **dispatch 根本不读边**。`grep -n "\.edges" engine/dispatch.ts` ⇒ **0 命中**（本轮实测）。
   dispatch 用的组织信息全在 `graph.nodes` 的 `reports_to` 上（`handoffGate` 的
   `getDescendants`、`upstreamOf`），OrgGraph 的委派边数组对它是一段【读了但没人看】的数据。
3. **运行期真正判审阅独立的是 `reviewGate`**（O4 现状表的第 1 行，一直在活路径上）：
   同族 / 同角色 / 家族缺失都在 planEdge 之前拦，拦下建卡等人。它判的是**这一次审阅的双方**，
   比"这条边带不带门控旗标"更实质——旗标是图上的元数据，`reviewGate` 判的是坐在两端的是谁。

所以"记一条 unresolved"没有输入：**要么图没建**（`delegation_graphs` 生产 0 行是 0012 §1
量过的现役事实，`bindings/im.ts` 里还挂着"拿它判会恒拒"的教训），**要么图建了而无门控边
存不进来**。真要"接上"，唯一接法是在 dispatch 里对 `graph.edges` 重建一份门控判据——
那是同一条逻辑的**第三份实现**（保存期 contracts 一份、运行期 reviewGate 一份），
两份判据必然漂移这件事本仓记过最多次（0006 §7 第 55、56 条原话）。

`independentReviewerPath` / `selfReviewEdgeBlock` / `gateConfigBlock` 因此**保留**：
它们是保存期判据的纯函数对偶（hub 侧 DelegationEdge 形状，带 22 发测试里的判据 3 那一组），
删掉它们不会让任何一条真实防线少一分——但留着它们，O4 验收句里"删调用点 ⇒ 红"这一格
对它们**仍然没有对象**（见 §5）。

## 4. 动作 4：先想喂 INSERT，量到的是「喂进去就恒红」

动作 4 给的两个选项里，「补 INSERT 方」排在前面，我也先按它走了一遍，然后在
`gateEvidenceCheck` 的判据前停住了。那张表与那条自检是一体的：

- `review_gates.evidence_bundle_id` 允许 NULL（DDL），但 `gateEvidenceCheck` 对
  **有行而引用为空 / 指向不存在的 bundle** 判 `violated`（integrity.test.ts 里
  `UPDATE … SET evidence_bundle_id = NULL ⇒ violated` 那一发钉着，这是它该有的样子——
  §22.4「每个门控决定都有证据包引用」的机械形态就是这个 join）。
- dispatch 的审阅判定（`ReviewDecided`）**没有证据可挂**：引擎路线的交接只带一句
  summary（O5 的实测：`evidence/store.ts` 对外零 import，`EvidenceStore` 没有生产者）。
- ⇒ 给 dispatch 补一条 `INSERT INTO review_gates`，每一行都是 `evidence_bundle_id = NULL`，
  `gateEvidenceCheck` 从 `not_observable`（空，没有东西可查）变成**每一轮审阅都 violated**。
  这不是接上判据，是把一个诚实的"无从校验"换成一个每次都响的假警报——
  0056 在治的"恒红让 verify 不可能通过"正是这个病，而 0063 给这句话旁边写的是同族教训。

所以选第二个选项，并且**只改措辞、不改读数**：`gateEvidenceCheck` 的 not_observable
detail 从「那张表在等它的写入方（0063 §5 / O4 动作 2 与 4）」改成
「【预留，非缺陷】（0064 / O4 动作 4）：它的行要求 evidence_bundle_id 指向存在的证据包，
而生产里还没有东西往证据包里装内容（O5）……那张表在等证据那一格接上」。
verdict / checked / ok 与 violated 两支一字没动；那两条真库用例（插带证据的行 ⇒ ok、
抽掉引用 ⇒ violated）照绿——表被接上那天的行为已经先测好了。

一个当场被守卫抓住的手滑：新文案我第一版写了「证据包在生产没有生产者」——
`ZERO_CLAIM_RE` 的「没有生产者」句式把它扫成了一句**新的零写入方声明**，
zero-producer 当场报 unregistered。这不是误报：那句话确实是一个现在时的零主张，
而它没有登记。正解不是登记它（证据包的写入方状态归 O5 管，不归这张表），
是把句子改成不带判据句式的说法（「还没有东西往证据包里装内容」）。
**守卫在我改它的那一句里抓住了我新造的假账**，这是 0063 那个守卫第一次以这种方式工作——
它本来是为"生产者长出来"设计的，结果先拦了"措辞漂移进句式"。

## 5. O4 验收句的终态，说准它现在指什么

验收原话：「把上表第 3、4 行的每一个函数调用点删掉 ⇒ 各自必须有一发红。
今天删掉它们 0 发红。」（0062 §7 注明过这句是未复测的旧读数。）

本轮之后这句话的射程变了，得说准：

- **动作 3 的两个函数**：已经从"删调用点 0 红"变成"函数不存在"。验收句对它们
  永久失效——不是达成了，是**对象被消灭了**。这是 O4 原话里"要么删掉"那一支的正常终态。
- **仍在场的**（`gateConfigBlock` / `selfReviewEdgeBlock` / `independentReviewerPath` /
  `evaluateGate` / `sameFamilyReviewBlock`）：src 生产调用点仍是 0（`sameFamilyReviewBlock` /
  `evaluateGate` 的唯一调用方 `harness/verifier.ts` 仍在死模块基线）。对它们，
  「删调用点 ⇒ 红」这句话**结构上不可能达成**——没有调用点可删。
  本轮没有为它们新增任何 dispatch 消费（§3 的三份漂移论证），也没有删它们
  （它们是保存期判据的有测试对偶，删了只损失判据文档价值，不减少防线）。
- 真正能机械兑现的那半句「测试全绿而调用点是删掉的 ⇒ 只有变异能抓」仍然悬着，
  且从本轮起它只对 verifier 簇成立——那一簇归 O14/死模块清算，不归 O4。

## 6. 留在原地没做的

1. **O5 才是 review_gates 的正解**：证据包生产者接上之后，dispatch 的审阅判定才有
   `evidence_bundle_id` 可挂，那张表的 INSERT 方与 `gateEvidenceCheck` 的 ok 支路才会一起活。
   本轮把它定格为预留，是为了让**下一轮做 O5 的人**不用先拆一个恒红。
2. **`removeForbidden` 的输入面**如果哪天真要开（远程请求改黑名单），那时要写的不是
   这两个被删的函数的复活，而是：入口鉴权（那是 §4「Agent 不能给自己加工具权限」的方向）+
   loader 抛错 + 审计行的**一次成型设计**。删掉的测试不是删掉的规格。
3. **`gateConfigBlock` / `selfReviewEdgeBlock` 等 verifier 簇函数的去留**：与 O4 无关的
   死模块清算（dead-modules 基线那一格），本轮没动。
4. **动作 2 的"允许但记 unresolved"如果 CEO 仍想要**：它需要的是**运行期对 graph.edges
   的独立审计扫描**（比如 integrity 自检加一条「图上存在无门控委派边」），而不是 dispatch
   每轮判——保存期判据挡的是新边，存量脏图（手工修库造出来的，validate.ts 文件头明写
   这种图存在）由自检扫更合适。这是一条没做的候选，本轮没做，因为它属于自检清单扩容，
   不属于"接上判据"。
