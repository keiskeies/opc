# 0041　引擎路线的入口：一个「下发想法」到今天拿不到结果的过程（work / decide）

- **状态**：按授权代拍（同 0040 的口径）。这一篇定的是**产品编排**：一人公司那条主流程
  （下发想法 → 角色起草 → CEO 签署 → 任务动起来）从今天起长什么样、命令叫什么、
  哪些上限必须人给。**§5 / §7 / §10 三节是等 CEO 的项**，已登记在 `docs/INDEX.md`「等待 CEO 决策」。
- **关联**：0009（Phase 2 无框架，本篇是它在「执行」这一维的延续）、0010（seq 空洞那条论证，
  本篇每个写路径都照它）、0013/0014/0020/0031/0032/0033/0040（「零生产调用方」那一族，本篇是下一格）、
  0007（恒绿守卫与坐标漂移，本篇撞了四条，见 §9）。
- **一句话结论**：⭐ **本篇补的不是功能，是「有人能用」** —— dispatch / charter / approve 三个模块
  早已各自测绿，而**没有任何运行时路径走到它们**；现在有了 `hub work` 与 `hub decide` 两条命令，
  以及一条从 CLI 一路跑到 `CHARTER_APPROVED` 的真链条（`engine/work.test.ts` 那一发断的就是两次命令之后的库状态）。

---

## 0. 这一篇在补什么：三个绿模块和一条不通的路

Task 3.x 那一阵写完的东西：

| 模块 | 状态 | 缺的东西 |
| --- | --- | --- |
| `engine/dispatch.ts` | 判定写完、1011 行、测绿 | **零生产调用方** |
| `engine/driver.ts`（advance 那个循环） | 写完、测绿 | 同上 |
| `engine/approve.ts`（人席写路径） | 本篇新写 | —— |
| `engine/charter.ts`（章程卡生产者） | 本篇新写 | —— |
| `engine/hub-work.ts`（入口） | 本篇新写 | —— |

`HUMAN_EDGES` 那张表把三条人类出边算好了、`humanEdge()` 能查出来，而 `grep` 出来的命中只有
表本身、那句人席提示、和一条「落点合法」的表扫描 —— **没有人调它**。
`approval_type='charter'` 这个取值在枚举里、在 role-memory 的分类表里、在 LangGraph 那条直通桩节点里，
**没有任何代码建这种卡**。

于是「下发一个想法」在今天的真实表现是：任务建出来（状态写死 `CHARTER_PENDING`）→
dispatch 连 token 都不烧、直接回「等人不等 agent」→ 打开收件箱 → **一张卡都没有** → 永久停住。
一人公司最核心的那一次交互（CEO 读一份提案、点一次批准）**今天不存在**。

本仓这一族已经关了快二十篇（0040 §0 数过），这一格轮到「执行与批准」。判据同 0040：
不是「写了新功能」，是**把已经写完的东西接上一个真入口**，并且把入口会出错的地方钉住。

## 1. 第一个拍板：入口叫 `hub work` / `hub decide`，且不并进 cli.ts

命令名两个：`work`（推进，可能跑若干轮）、`decide`（人席那一次点击）。
入口文件 `packages/hub/src/engine/hub-work.ts`，root script `pnpm hub:engine`。

**不并进 `cli.ts`**，是同一个理由第四次出现（`graph/thread.ts`、`http/real-deps.ts`、
`serve/assemble.ts`、`serve/hub-serve.ts`）：`cli.ts` 顶层 import `@langchain/langgraph` 与整张公司图，
本机装不上（0009 §2 实测），挂上去之后 work/decide 的参数报错与退出码在离线机器上**一行都测不了**。

这一条比前三次更硬，因为引擎路线存在的意义恰恰是**它不依赖那张图**（§2）。
把它的入口挂在依赖那张图的文件上，等于在最外面那一层推翻「不用 langchain」，
而推翻的表现是启动即 module not found —— 报的是**依赖问题**，不是「这条路线不存在」，
读错误的人会被指去查 pnpm store。

同理 `work.ts` 自己声明一份 `WorkIo` / `WorkResult`，不从 `cli.ts` `import type`：
`import type` 编译期就抹掉、本来无害，但它留着一个只能靠人记得的不变量 —— 那一行只要被
从 type import 改成值 import（IDE 的「inline 一个类型」就会这么干），整条引擎路线立刻跟着
`@langchain/langgraph` 一起挂。两个字段的结构类型，复制一份比留一个隐式依赖便宜。

**退出码三条，分界线是【使用者的下一步动作不同】**，不是「成功/失败」两分：
`0` 推进过了（**含停在人席** —— 那不是失败，是轮到 CEO；把它算成非零，脚本会重跑一整轮去烧 token）·
`2` 参数/前置错了（库不存在、任务不存在、没有待批卡片）· `1` 跑的过程中炸了。

## 2. 第二个拍板：一个角色 = 一次 `claude -p`，流程不在图里

CEO 的原话是「别用 langchain，每个 agent 都是灵活的，不是写死的流程，就像公司里每个职位的员工」。
落到实现上是**一条分工线**（`engine/dispatch.ts` 文件头）：

- **agent 决定内容 + 下一跳**：做什么、结论是什么、交给哪个角色（`<<<OPC_DECISION>>>` 那段结构化决策）；
- **hub 决定这一步能不能过**：状态机跃迁、组织边界、审阅独立性、预算、审批。

不照【规格】§5.4 把流转写进图（7 节点 / 8 条线性边）的理由：**员工的下一步由这一轮的产出决定，
那是运行期的事实，编译期的边表达不了**。也不让 agent 说了算：那等于让被约束者否决门控，
而且 events 是 append-only，一次越权跃迁写下去就永远在审计里。

这条线换来一件硬东西：CEO 那三个席位**没有 agent 出边**，所以「一个被 prompt 注入的角色
输出 `pass` 把自己交付掉」在结构上不可能 —— 不是提示词不许，是**那条边不存在**。

## 3. 第三个拍板：起草走独立一条路，不进 dispatch

`CHARTER_PENDING` 那一格是**人类席位**，dispatch 在那里的拒绝是正确的（那一格的状态跃迁只有人能签）。
补法有两种，我选第二种：

1. 给 dispatch 开一个例外：在这一格允许 agent 跑一轮 —— 会让 `seatOf` 那条 fail-closed 的席位判据
   出现一个例外分支，而「例外」正是那类判据腐烂的方式；
2. **起草不走 dispatch、单独一个 `ensureCharterCard`**，它**不写任何状态边**。

选 2。它跟「人类席位不放 agent 进场」不矛盾：**起草不是跃迁**。
`CHARTER_PENDING → CHARTER_APPROVED` 仍然只有 `approveCard` 那一条路，
而 `work.test.ts` 与 `charter.test.ts` 在**每一条**用例上都断言状态仍是 `CHARTER_PENDING`
（否则等于 agent 自己批准了自己的章程，【规格】§8.2 第 4 条当场失效）。

顺序也不能反：`cmdWork` 在这一格**先起草再谈推进**。反过来的话 CEO 拿到的是
「跑一次 work → 一句『等人』→ 打开收件箱 → 空的」。

## 4. 第四个拍板（本篇真正的方法论产出）：钱有两条腿，少一条就是一张乐观的账

`ensureCharterCard` 初版**只调 `deps.onCost`**，测试当场红。原因：

- `onCost` 写的是 `budgets` + `budget_events`（幂等键 `source_event` = 一个 `events.id`）；
- `tasks.consumed_cents` 是**另一列**，dispatch 里它由 `WRITE_EDGE_SQL` / `LEDGER_SQL` 那两条 UPDATE 带上去，
  而本模块不写状态边，所以**必须自己跑 `LEDGER_SQL`**。

少加的后果不是崩：`GET /tasks` 读的是 `tasks.consumed_cents`（`http/app.ts` 的 `TASK_COLUMNS`），
于是看板显示这条任务**「没花过钱」**，而 `budgets` 里确实扣了 —— 同一个数在两张表上给出两个答案。

由此定一条**给后续 engine 模块的规则**：*任何花了钱而不写状态边的写路径，自己跑 `LEDGER_SQL`。*
并且记账的门控只看**「花了钱」**（`cost > 0`），不含「装配给了记账钩子」——
`onCost` 少装是装配缺陷，它不该连带让 `consumed_cents` 也不加；那会把一个**可见的缺配置**
变成一个**不可见的少记账**。

同一族的另一发：卡片审计那行的 payload 形状。`createCard`（http / 巡检建卡走的那条）落
`evt.payload`（`{kind, approval_type, summary, evidence_refs}` 在**顶层**，被 `cards.test.ts:438` 钉住），
而 `dispatch.ts` 从前写 `{...evt}`（字段嵌一层）。**共用的 `kind` 掩盖了不共用的部分** ——
role-memory 那个 `payload.kind` 判别式一直看起来是对的，而按 `approval_type` 数待批事项的读法
会漏掉引擎建的那一类。两处一起纠正，并由 `charter.test.ts` 那条**跨生产者**用例钉住
（两边各建一张真卡、逐键比键集合 —— 抄一份期望值的话，两边一起改错它照样绿）。

## 5. 同源审阅那张卡今天每次都触发（等 CEO）

`dispatch.ts` 的审阅独立性判据要求产出方与审阅方**不在同一模型家族**；今天组织图里所有角色
都跑同一个家族，所以**每一道审阅都会先落到「同源可以批吗」这张卡上**。

这是刻意的：宁可 CEO 多点一次「同源可以」，也不让「两个不同 agent」的表象冒充独立性。
**但它今天是常态而不是例外** —— 【规格】§8.2 第 4 条的效果是「每个审阅都过人手」，
而【规格】§7.2 那条「一人公司，CEO 只看关键几件事」的体验**没达成**。

撤除条件（任一条成立即可谈）：组织图里出现两个不同 `model_family` 的角色，
或 CEO 明确接受「独立性今天不作为放行条件」。这是产品决定，不是实现层能定的。

## 6. 岗位书没有生产来源（缺口，不代拍）

`runtime.ts` 的 `rolePrompt` 今天只给一句最小身份描述。原因不是懒：

- `role_charters` 是**空表**；
- `packages/hub/resources` 那几份模板里带着 `CEO-PLACEHOLDER-ACCEPTANCE` —— 那是 CEO 手上、
  由她写在纸上的**验收标准**。**我不能替她填**：填了之后卡片会显示「验收标准：X」，
  而 X 是我编的，她批的是一份**没有人在纸上认过**的章程。

所以角色现在按一句身份描述干活，而 【规格】§8.2 第 1 条与 `guides/how-to-write-a-charter.md` §3
那四个反例所要求的「可机械判定的验收标准」**今天无数据来源**。
接上真岗位书的口子就是 `rolePrompt` 那一格，缺的是内容不是代码。

## 7. 预算护栏跨限时【没有合法的停法】（等 CEO）

`BudgetTracker.consume` 跨过上限时发 `BudgetPaused`。engine 这条路线上发不了：

1. 那个方法开头要求 `recorder.inStepTx()`（超步事务的责任方是 `recorder.run`），而引擎路线上**没有超步**；
2.【规格】§7.1 只有 `IN_REVIEW → BUDGET_PAUSED` 一条入边 —— 从 `IN_PROGRESS` / `DECOMPOSING`
   硬停**没有合法落点**。为记账现造一条状态边，就是把状态机改成规格没有的样子。

今天的行为是：`--max-budget-usd` 每轮硬顶照传给 CLI（单轮花不出去），`--task-limit-cents`
声明进 `budgets.hard_stop`，但**跨限时不会暂停任务**，也不建卡。
也就是说**任务级上限今天是一句声明，不是一道闸**。

三个候选（都要改状态机或加卡类型，所以不在实现层定）：
① 给【规格】§7.1 加一条 `IN_PROGRESS → BUDGET_PAUSED` 边；② 跨限时建 `budget_override` 卡而不动状态；
③ 接受现状并把「上限是声明」写进 `--help`。我倾向 ②（不动状态机、CEO 看得见），但 ①
更接近【规格】§7.1 的原意。

## 8. 两个上限不给默认值

`--max-budget-usd`（每轮美元硬顶）与 `--task-limit-cents`（任务级上限）**必填**，
缺任何一个都在开库之前红，并点名缺的是哪一个。

理由：给默认值 = 没配也能跑，而**跑起来才知道花多少没顶**。【规格】§6.1 禁浮点金额，
所以 `--task-limit-cents` 还必须是整数美分（`12.5` 会被 SQLite 收进 INTEGER 列，
那是这一族里最省笔墨也最难查的缺陷）。

同一族的三个细节都写在 `parseWorkArgs` 旁边并各有用例：
`Number("") === 0` 会让「写了 flag 忘了填值」报成「必须是正数，实到 0」，把人指向一个自己没写错的数字；
**下一个 token 长得像 flag 时不算值**（否则 `--max-budget-usd --task-limit-cents 500` 会把后者吃掉，
真正写错的那一发在报错里完全看不见）；未知参数红而不忽略（`--max-turn 3` 拼错一个字母，
放行等于她的上限根本没生效，而她会以为是 3）。

## 9. 本篇撞到的四条坐标漂移（守卫又抓对了）

`doc-refs` 第【六】次抓同一件事，而且这一次**四条全是本篇带下来的**：

- `events/recorder.ts` 第 385 行 → 第 395 行：第 9 个事件 kind `RoleTurnReported` 往 `KIND_TO_ACTION` / `targetOf`
  各加一条 case（+10 行）。**同一个坐标被顶三次、理由一模一样** —— 那是那张表的日常操作，
  下一份改动仍要预期它漂；
- `recorder.ts` 第 258 行 → 第 268 行：同一次改动带下来的第二个站点（那句「默认必须【可见】而不是静默」的注释，
  0007 那一节的论据出处）；
- `0016 > recorder.ts` 第 239 行 → 第 249 行：`DEFAULT_ACTOR`，同因；
- **`0007 > db/driver.ts` 第 30 行【同名歧义】** —— 这条形状是新的：**文件没被改，是多了一个同名文件**
  （本篇新增的 `engine/driver.ts` 那个 advance 循环）。修法是把文档正文与快照的坐标
  一起加上 `db/` 限定，**不是**给守卫加「裸名默认指 db/」的猜测规则 ——
  那条规则下一次会指错。

（上面前三条刻意写成「第 N 行 → 第 M 行」而不是 `文件:行号`：守卫会把手写的每一个坐标形态
都当成【当下的活引用】来要快照，而这三处讲的是【已经漂完的历史】，不是此刻指向的东西。）

## 10. 一处我读错库的地方（记下来，因为它形状特殊）

`work.test.ts` 我第一版按 `payload.kind` 筛「决策那条审计」，于是数出 **0 条** ——
而库里有一条好好的决策。真因：**「建了一张卡」与「点了这张卡」在库里共用 `action='approval'`**
（§22.1 那个枚举不开第 11 个值），而决策那条的 payload 是 `{approvalId, resume}`，**没有 kind**。

`bus.ts` 里那句「它在库里的身份靠 `payload.kind`」说的是 `ApprovalTokenRedeemed` 那一条
**写进事件形状里**的 kind，不是所有共用 `'approval'` 的行都带 kind ——
`applyDecision`（http 那条路）落的 payload 同样不带 kind。

所以这不是引擎路线少写了一格，是：**库里今天没有「这条 `approval` 是请求还是决策」这个事实的
机器可读列**。能区分两者的只有 `actor`（`system/hub` vs `human/ceo`）与 `target`（卡片 id）。
**任何按 `payload.kind` 分辨请求/决策的读法会静默数到 0** —— 这一条对未来的读侧（回放、
报表、收件箱角标）是活的坑，本篇把它写在测试注释与这里，而不是留给下一个人重新踩。

## 11. 判据

1. `hub work` 停在人席 ⇒ **退出码 0**（脚本不得为此重跑一轮真 token）；
2. `hub work` 在 `CHARTER_PENDING` 只起草、**不推进状态**（`work.test.ts` + `charter.test.ts` 每一条用例都断）；
3. 已有一张待批章程卡 ⇒ **`runTurn` 一次都不被调**（唯一索引只挡第二张卡，挡不住第二次烧钱）；
4. 一次批准 = 认领卡片 + 状态边 + 两条审计，**同一事务**（「卡片已批而任务没动」在库里不可表达）；
5. 重复点击 / 卡片属于另一条任务 / 打回没给理由 ⇒ **零写入、零广播**，且 `note_required` 判在**开事务之前**；
6. 那条任务有多张待批卡时 `decide` **不替 CEO 猜**，把 id 列出来让她指；
7. 消费了 seq 的每一行都在提交之后逐条广播（少一条就是活连接上的一个洞，0010 §4）；
8. `hub decide` **不起 runtime**（一次决策烧 0 个 token，不该让审批依赖「CLI 找得到」）。

## 12. 别当成做到了

- **只有 `approve` 真能推进任务。** `reject_with_comment` / `defer_deep_review` 把卡片记掉而
  **任务原地不动**：【规格】§7.1 没给它们出边，落到哪个状态**规格没定**（real-deps.ts §4.1 早就把这条
  挂在等待区）。输出里明写这件事，不含糊过去。缺的是规格，不是这里的取舍。
- **`approveCard` 不校验卡片与组织图版本**（`orgVersionUnchecked: true`，写在返回值上而不是不提）：
  「卡是 v3 建的、任务此刻在 v4」时批准照走。影响面比组织图门控小（人席出边不看组织图），
  但它是 §18.4 的一个已知未覆盖点。
- **桌面端与 Web 没接这条链。** 本篇交付的是 CLI 那条路；§16 那个控制室（今日视图 /
  六个层级列 / 独立审批收件箱 / 回放）仍是另一件事。
- **`hub work` 不建任务。** 建任务走 `hub run` / `POST /tasks`（那条路把 `graph_version` 与 INSERT
  放在同一事务里取，§18.4）；这里再写一份 INSERT 就是第二条可能不一致的路径。
- **`MEETING_REQUIRED` / `BLOCKED` 仍是死路**（【规格】§7.1 没给它们出边），而【规格】§7.4 那个「终止任务」
  按钮**在全仓任何一张边表里都落不了地** —— 15 个状态里没有终止态，不是没写，是**没有合法的目的地**。
- **Checkpoint / 证据包 / 自动批准 / 策略引擎 / 会议子图 / 心跳：未接。**
  证据包那一格最重：交接只带一句 summary，于是 【规格】§8.2 第 2 条「通过必须附可验证证据」
  现在**无处可满足**（章程那一格例外，它有 `events:<id>#state_snapshot.draft` 这种解得开的指针）。
- **`pnpm verify` 今天仍然跑不起来**（离线缺依赖，0039 量的那半：vitest 能装能跑，
  biome 平台二进制与 tsx 仍是空壳）。本篇列的绿是 node:test 给的，**不是门禁绿**。

## 13. 实跑（node v24.14.0，离线）

```
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/engine/*.test.ts"
→ tests 153 / pass 153 / fail 0        （新增 work.test.ts 31 发 + approve 21 发 + charter 16 发）

tsc --noEmit -p packages/hub/tsconfig.json  → 34 条，全部是 §0 那条既有基线
  （@langchain/* 与 yaml 模块缺失 + graph/* 隐式 any），engine/ 零错误
```
