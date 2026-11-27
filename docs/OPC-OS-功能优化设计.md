# 项目功能优化设计 —— 按「事情到底有没有发生」组织

> 取材时刻：2026-11-15 的工作区。本篇所有形状都是**当场量的**，不是从旧文档抄的；
> 抄来的那几条（三处）在 §1.3 单独列出来，因为它们已经过期。
> 写作纪律：不引行号 —— 行号会漂，本仓 `doc-refs` 只把**决策文档**里的行号锁进内容快照，
> 本篇不在那个射程里，所以一律用符号名与文件名定位。

## 0. 这篇是什么，以及它不是什么

**是**：一份「从今天的代码走到规格承诺的样子」的优化设计。每一条都带三样东西 ——
现状（可复算的形状）、目标行为、以及**一条能造出红的验收判据**。

**不是**：进度报告，也不是里程碑。它不回答「做到百分之几」，因为那个问题在本仓
没有意义：一个有调用方的 30% 和一个有测试没调用方的 70%，在用户那边的读数都是 0。

**读法**：只有一句话需要记住 ——
**有实现 + 有测试 + 零调用方，在用户那边的读数是 0，不是「快好了」。**
本仓最好的代码大多属于这一类。下面所有优化项都是这一句话的推论。

关于这句话的强度，本篇自己也要被它判一次：下面凡「零调用方」的说法，
**按本仓的口径（见 `guides/how-to-write-a-charter.md` §7 第 3 条），地位只是「我没找到调用方」，
不是「证明没有调用方」。** §8 把这条差异写清楚，并给出机器证明的那几个例外。

## 1. 读数：先给口径，再给数

### 1.1 三条机器可复核的数

| 数 | 值 | 怎么复算 |
| --- | --- | --- |
| `packages/hub/src` 模块数 | **83** | `npx tsx test/arch/census.ts` 的第 ① 行 |
| 其中 **src 内零静态 importer**（排除入口） | **11** | 同一条命令的第 ④ 栏（⚠ 不是 ③，见下） |
| 这 11 个模块合计 | **5052 行 / 全 src 35216 行** | ④ 栏的「行数」/ 第 ② 行 |
| 全仓测试文件 | **108**（`packages/hub/test` 78 + 根 `test` 30） | 第 ⑤ 行 |

复算脚本的形状（不写进仓库，避免多一个会过期的成员）：解析每个非测试 `.ts` 的
`import ... from "..."`，**把说明符解析成真实路径**（相对说明符相对 importer 所在目录解析），
再数每个模块被多少个别的模块 import。
⚡ **round293 改口：那句「不写进仓库」已经作废 —— 脚本现在就在
`test/arch/census.ts`，`npx tsx` 直接跑。** 上面那段描述保留原样，因为它是
**那一次测量的口径记录**；作废的只是「不写进仓库」这半句。
**它当初的取舍是错的**，理由写在下面那块 ⚡ 里。


⚠ 这个口径我**第一次写错了**：早先按「说明符里出现 `serve/timer` 这类子串」匹配，
而同目录 import 写成 `from "./timer.js"`，说明符里根本没有目录名 —— 于是数出 33 个死模块
（13569 行），其中 `serve/timer`、`serve/config`、`http/sse` 那一整批是**假阳性**，
它们全都有活着的调用方。**别信任何一版普查的第一个数**，这条已在本仓别处成立过一次。

⚠ **这张表现在有机器版了**：`test/arch/dead-modules.ts` 用**从入口不可达**判，
结果是 **20** 个（含 `harness/` 整目录与 `graph/gates/*` 那些「只被不可达模块用」的下游），
不是这里的 11。**11 与 20 的差就是 §1.2 第 2 条说的那一族** —— 两个数都对，
口径不同。以守卫为准，以这张表为线索。

⚡ **round293：这四条数第一次有了可执行的复算命令，而四条【全部】对不上。**
复算：`npx tsx test/arch/census.ts`（**别抄下面这行**，它记的是那一次的读数）。

> 上面那张表的「怎么复算」原先是一段**描述**（「复算脚本的形状（不写进仓库）」），
> 而本篇两处自称这件事已经做了 —— §8 末「所以每个数都配了复算方法而不是配一个豁免」、
> O14 动作 3「§1 那张表里的数全部标了『口径 + 复算方法』」。
> **那是把「写了口径」当成「给了方法」。** 后果：这四条数在 round293 之前
> 从来没有被任何人复算过一次。第一次真跑，`92 / 40871 / 135`，
> 表上是 `83 / 35216 / 108` —— 三条各差一截，且**没有任何东西因此变红**，
> 这正是 §1.3 那三行、也就是 O14 整篇要治的形状。
>
> **第四条最坏，因为它「看着没变」。** 表上那条 11 写的口径是「零静态 importer
> （**排除入口**）」，而排除入口今天给的是 **7**（`harness/verifier`、`evidence/store`、
> `heartbeat/retry`、`graph/branches`、`events/batch`、`main`、`index`）。
> 全量零 importer 今天恰好也是 11 —— **同一个数、另一批成员**（里面混着 `cli.ts`
> 那些从 scripts 起的入口，它们天然零 importer 而**不是**死代码）。
> ⇒ 一个数「没变」不等于它还是那件事；**表上那条口径要读脚本的 ④ 那一栏，不是 ③。**
>
> 三条口径的坑，本轮各犯了一次，写在 `test/arch/census.ts` 的文件头与
> `census.test.ts` 里：① 按说明符**子串**匹配会把同目录 import 整批漏掉
> （§1.1 上面那条 33 的来源；本轮我又用 `grep 'store\.js'` 犯了一次，匹到的是
> **别的** store）⇒ 脚本复用 `dead-modules.ts` 的同一个解析器，不另起一份；
> ② `split("\n")` 计的行数比 `wc -l` **多 1**（`harness/verifier` 这里 725、`wc` 给 724）
> —— 我第一版连这个差值的**方向**都算反了；③ 两个 `.worker.ts` 今天唯一的静态边是
> `db/backup.ts` 里那句 `type … = import("./backup.worker.js")`（**纯类型**，
> 运行时靠 `new Worker`）⇒ 它们**不在**脚本的零 importer 名单里，
> 而 §1.2 那张表把它们算在 11 个之内。两边都对，差的就是这条类型边。
>
> **表上的旧数按原样留着**（§1.2 第 3 条那条家规：那张表是**那一次脚本跑出来的读数**，
> 改数就等于伪造那次测量）。**要用的数以脚本现跑为准。**
> 脚本本身**只测量、不判定**（恒 exit 0，除非解析器自报悬空说明符才抛）——
> 一条恒红的复算命令等于一条恒不可能通过的断言，而人会学会跳过它。
> 「数变了要有人知道」这件事已有归属：`dead-modules` 判它的基线，`claim-coords` 判主张坐标。


### 1.2 零 importer 的那 11 个（按行数降序）

| 模块 | 行 | 它本来要干什么 | 它依赖的东西在不在 |
| --- | --- | --- | --- |
| `channels/abstraction` | 1001 | IM 卡片投递 + 回信落库 | 在，缺真适配器与 `act` 落库点 |
| `harness/verifier` | 705 | 「作者不能给自己打分」的独立复核 | 在（自己就是调用方） |
| `memory/role-memory` | 693 | 角色级记忆（过去决定 + 理由） | 在 |
| `policy/auto-approve` | 691 | 规则自动决定审批 | 在 |
| `charter/store` | 508 | 岗位书版本化读写（`role_charters` 的后端） | 在 |
| `evidence/store` | 402 | 证据包登记与完整性校验 | 在 |
| `heartbeat/retry` | 299 | 失败分类与重试 | 在 |
| `graph/branches` | 292 | 并行拆解 + 汇聚合并语义 | 在（框架无关） |
| `db/backup.worker` / `db/integrity.worker` | 193 / 173 | 备份与页校验的 worker 入口 | **在，靠 `new Worker` 动态起** |
| `events/batch` | 95 | 审计批量写 | 在，但**它自己也是零 importer**（我原先误判成「被 `events/recorder` 用」，见 §7 第 7 条） |

**这张表自己就有两个坑，先说清，否则读它会被误导：**

1. **两个 `.worker` 是假阳性。** `db/backup.ts` 与 `db/integrity.ts` 用
   `new Worker(wrappedWorkerUrl(WORKER_URL), ...)` 起它们，`node:worker_threads` 的入口
   在静态 import 图里**不可见**。它们不是死代码 —— 恰好相反，它们干的是最硬的那部分活。
   ⇒ 结论：**「零 importer」这句话必须过一遍动态入口**（`new Worker`、`import()`、
   `spawn` 的脚本路径），本篇给的 11 已经过完这一遍，过完还剩 9 个真的。
2. **`harness/gateway`、`harness/safety`、`harness/routing` 不在这张表里，因为它们互相 import。**
   gateway ← verifier，safety ← gateway 与 routing。**整个 `harness/` 目录对外零 import**，
   而目录内部的边把每一个成员都伪装成「有人用」。
   ⇒ 结论：**数 importer 必须按「目录对外的边」数，不能按文件对文件的边数。**
   这条修正是本篇对 §1.1 那个脚本的第二次改口径。

   ⚡ **第三个坑是【这张表会过期】，而它没有机器判据**（死模块哨兵判的是它自己的基线，不是这张表）。
   `channels/abstraction` 那一行在写这篇时对，round281 起**不再成立**：`channels/feishu.ts` 与
   `serve/im-channels.ts` 都 import 它，它已经不在「零 importer」名单里了（dead-modules 基线里
   那两条如约变红并已摘除）。上面那句「缺真适配器与 `act` 落库点」两半都已兑现，而**发卡
   （`deliverCard`）仍然零生产调用方** ⇒ 那一行今天若重写，缺的是「投递台账」那张表，不是适配器。旧行按口径留着，不改数字：这张表是【那一次脚本跑出来的读数】，改数就等于伪造那次测量。⚡ round283：那张表真的建了（`0009_card_delivery_ledger.sql`），动作 4 落地，读 O12 那一段与 r17 —— 上面那句"仍然零生产调用方"随之日后翻向，别把它当现状读。⚡ round305：`heartbeat/retry` 这一行同样翻向了 —— `engine/turn-retry.ts` import 了 `withRetry`，而它由 `engine/runtime.ts` 的 `runTurn` 每轮调一次，所以它【已不在】对外零 import 名单里（dead-modules 基线那一条如约变红并摘除，基线下界随之 14→13）。⚠ 但【模块可达不等于重试放过行】：那条判据今天一次都不放行（本机可复现的 `started:false` 全是确定性的 ENOENT，被瞬时 errno 白名单挡掉），台账 round305 §② 记着这件事与「白名单五个名字一个真样本都没有」。别拿这一行的翻向去宣布重试在真机上自愈过。 ⚡ round312：`harness/gateway` 与 `harness/safety` 这两行也翻向了 —— `engine/runtime.ts` 的 `runTurn` 经 `harness/gateway-runner.ts` 每轮调 `callHarness`（O6 动作 2），上面第 2 条那句【整个目录对外零 import】从今天起为假：目录对外有了真边。但这一条坑的教训【原样有效】：`routing` 与 `verifier` 仍互相 import 且对外零边，还躺在死模块基线里；而「对外有边」说的是 gateway/safety 这【两个】模块，不是整目录（dead-modules 基线那两条如约变红并摘除，基线下界 13→8 —— 同轮还摘了 search/ 三条，那是 gateway 一条 type-only import 带出来的传递可达，见该文件注释）。

真正要接的簇，按这个口径是这样（对外零 import 的目录/模块）：

```
harness/ 整目录（gateway + safety + routing + verifier，约 3300 行）
policy/auto-approve          691
memory/role-memory           693
charter/store                508
evidence/store               402
heartbeat/retry              299
graph/branches               292
graph/gates/author-reviewer  与 graph/gates/evaluate —— 只被 harness/ 用，继承它的不连通
search/{mcp,observe,policy}  —— 只被 harness/ 用，同上
```

### 1.3 三处「文档说的已经过期」——调研最大的噪声源

| 文档与注释现在写着 | 今天实测 | 证据 |
| --- | --- | --- |
| 0009 §2「本机装不上 `@langchain/*`」，以及 `hub-work.ts` / `branches.ts` / `serve/config.ts` 文件头「离线机器上测不了」 | **已可安装且已装**：`@langchain/langgraph` 1.7.1、`@langchain/core` 1.3.5、`@langchain/langgraph-checkpoint` 1.2.2，全部在 `packages/hub/node_modules/@langchain`；registry 的 TCP 443 当场连上 | `node -e "import('@langchain/langgraph')"` 在根目录成功；`test/graph/e2e-linear.test.ts` 现在 **11 条全过** |
| `branches.ts` 文件头「`graph/company.ts` 现在带着 15 个 TS2307」 | `tsc -b` **退出码 0，TS2307 为 0 处** | `npx tsc -b` 全量重跑 |
| `approvals/cards.ts` 文件头与 `heartbeat/patrol.ts`：`grep -rn "INSERT INTO approvals"` 在所有 src 目录下 0 命中 | `insertCard` 已有三条生产路径：`engine/charter.ts`、`engine/dispatch.ts`、`engine/seat-card.ts` | 反向 import 核对（`approvals/cards.js` 的生产 importer） |

**这三条的形状是同一种**：那句话在写下的那天是真的，之后环境或代码变了，
而**没有任何东西因为这句话过期而变红**。所以优化项 O14 不是「多写文档」，
是「给文档里的断言装保质期」——那是唯一一个能让这批账自己浮出来的修法。

`@langchain` 那条的代价最直接：它今天还在给「引擎路线」当存在理由（0041 的转向理由是
「离线机器上图路线连模块都起不来」）。理由已经消失，路线本身还留着。
**这既不是「赶紧合并」的指令，也不是「当初做错了」的判决** —— 引擎路线后来长出了
组织边界与审阅独立性这些图表达不了的东西（`engine/dispatch.ts` 文件头那条论证今天仍然成立：
下一步由那一次执行跑出来的产出决定，编译期的边表达不了）。它真正的代价是**别的**：见 O1 与 O8。

### 1.4 顺带一条读数纪律（写给读这篇的人，也写给下一篇的我）

`node -e "import('@langchain/core')"` 在**仓库根目录**失败，在 `packages/hub` 里成功 ——
pnpm 把包装在 workspace 包下面，不在根 `node_modules`。
本篇差点据此写下第二条假结论（「core 还是装不上」）。
**凡是「装不上 / 找不到 / 不存在」这类否定式读数，先问一句：我是在哪个目录下问的？**
这条与本仓 0007 §4.1 那条纪律是同一个方向：造不出红的判据，和判错了的读数，长得一模一样。

## 2. 三条轴，所有优化项都挂在上面

调研读到的几十个具体事实，最后都能收到三句话上。这三句不是文风总结，
它们各自对应**代码里一个能指认的位置**。

**轴一 · 接线，不是重写。**
需要新写的代码很少，需要新连的边很多，而且两端通常都在仓库里躺着。
最省的一发是 O1（把 `cli.ts` 里硬编码的那个 `StubRegistry` 换成真模型，
而真模型的调用点 `engine/runtime.ts` 当场就在手边），
最贵的一发是 O6（把 `harness/` 那 3300 行接进真正的执行路径）。

**轴二 · 「配置对了」不等于「事情发生了」。**
规格把大量控制点放在 YAML / 契约 / 表列上，而运行期没人读它们：

| 控制点 | 有值 | 有读者 |
| --- | --- | --- |
| `acceptance_criteria`（岗位书验收标准） | 有（模板里是 `CEO-PLACEHOLDER-ACCEPTANCE` 占位串） | `evaluateGate` 有，而 `evaluateGate` 唯一调用方在无入口簇里 |
| `forbidden_actions` / `decision_scope` / `honesty_boundaries` | 有（契约 `.strict()` 校验通过） | ~~**无**：`engine/` 目录里对这些字段名的引用为 0~~ 【round272 复测：结论错，证据那句到今天仍然对】`grep` 遍 `engine/` 确实 0 引用（今天也 0，只有 `outside_decision_scope` 那个枚举字符串字面量，它不读字段）。错的是从「engine/ 里没有」跳到「没有读者」：读者在 `charter/prompt.ts`（`c.forbiddenActions` / `c.decisionScope` / `c.honestyBoundaries` 逐字段渲染），而渲染结果就是 `engine/claude.ts` 的 `--append-system-prompt` ⇒ **有读者，但读者是提示词，不是执行器**——它影响模型写什么，不拦模型已经写下的东西。这两件事的差距才是这一格真正该说的话，而原句用「无」把它抹平了。主张改登记见 O14 表 r9（含一条能红的判据）。**⚠ 同一族错 O2 落地块第 2 条早写过一次**（「引用是 0」是真的，但读者在 `charter/prompt.ts` 的 camelCase 字段访问里，一个数不能替一次实验）—— 那条只改了 O2 那一节，§2 这张表没跟着改，于是同一个错在一份文档里活了两个住址 |
| `escalation_triggers` | 有 | ~~**无**（见 `guides/delegation-rules.md` §6）~~ 【round272 复测：同上一行，同一个错】`charter/prompt.ts` 的 `c.escalationTriggers.map(triggerText)` 就是读者 ⇒ 有读者（提示词），无执行器。见 O14 表 r9 |
| `budgets.hard_stop` | **恒为 1**：~~全仓三条 `INSERT INTO budgets` 都写字面量 `1`~~【round272 复测】带 hard_stop 的 INSERT 全 src 只剩【一条 DO NOTHING 语句 + `charter/budget-sync.ts` 的 DO UPDATE】—— 引擎路线 `onCost` 那份手抄副本已删（改成 import tracker 那条、scope/period 走绑参）。**「写字面量 1」这件事没变**，变的只是副本数；主张改登记见 O14 表 r1 | ~~无~~ 【2026-11-19 改口：有读者了】`serve/charter-pump.ts` 的 `underTaskBudgetSql` 现在读它 —— `hard_stop = 0` 的那一格超预算**不禁 spawn**。~~而 `serve/charter-pump.ts` **故意不看它**：看它就会得到一条「造不出红的判据」~~ 那句【当时对】，它过期不是因为想法变了，是因为**这一格多了一个写入口**：`PUT /budget` 能把那列写成 0（见 r1），于是「看了就是造一条恒真的东西」这个前提没了。**五条 SQL 共用【同一个函数】**（`charter-pump` 的候选与 blocked、`driver-pump` 的候选与 blocked、`overview/driver-status` 的 stopped）而不是五份抄件；能红的那一发在 `packages/hub/test/budget/hard-stop-gate.test.ts`，含一条【摘掉外层括号就红】的优先级判据——那一条是全仓唯一看得见这件事的 |
| `approvals.timeout_at` / `timeout_behavior` | 有（默认 8 小时） | ~~只被 `GET /approvals` 读出去**展示**；到期**什么都不发生**~~ 【round265 过期】执行者已有（`approvals/timeout.ts` 的 `runTimeoutPass`，见 O10 落地块）【round268 接线】心跳每一跳调它，到期卡真的动 ⇒ 这一行**整行过期**：现在【有值也有读者】。主张改登记见 O14 表 r2 |

`hard_stop` 那一格是这一族最干净的样本：一个名字叫「硬停」的布尔列，
**没有任何代码能把它写成 0**，于是任何基于它的判据恒真，
而写它的人（正确地）选择不去看它 —— 因为看了就是造一条永远绿的东西。
**「加了列」与「有了开关」之间隔着一次写入方 + 一次读取方 + 一条能红的判据。**

**轴三 · 两条路线，而那条已经付过账的迁移没有收尾。**
今天同一个仓库里有两条编排路线：

| | 图路线 | 引擎路线 |
| --- | --- | --- |
| 入口 | `pnpm hub run/status/resume`（`cli.ts`） | `pnpm hub:engine`（`engine/hub-work.ts`）、`pnpm hub:serve`（`serve/hub-serve.ts`） |
| 状态怎么动 | 编译好的 `StateGraph`，7 节点一条线 | `AGENT_EDGES` / `HUMAN_EDGES` / `AUTO_AFTER_EDGE` 三张表的查表 |
| 模型 | `StubRegistry`，返回 `"stub:" + tier` 的确定性桩 | 真 `claude -p` 子进程 |
| 审批门 | **半个**：`charter` 节点直通 `CHARTER_APPROVED`；`report` 停在 `ESCALATED_TO_CEO`（见下方第 2 点） | 真建卡、真等点击 |
| 心跳 | 无 | 15 分钟一跳（`HEARTBEAT_INTERVAL_MS`），巡检 + 章程泵 + 驱动器 + 每日备份 |
| 边界表 | 15 状态全在 `graph/status.ts` | 同一张表，但**只用到 5 个状态 / 6 条 agent 边** |

两条路线各自有真实价值，本篇**不建议合并**（合并的代价远大于收益，见 §6）。
但迁移没收尾留下三笔具体的账，每笔都能指认：

1. **桩路线仍然写库。** `cli.ts` 的 `run` 用 `--db` 打开的正是 hub 生产用的那套表，
   节点体 `edge()` 直接写 `tasks` 行，`report` 把任务推到 `ARCHIVED`。
   ⇒ 任何一次演示、任何一次误跑 `pnpm hub run`，都会在生产库里留下**一条从 `ARCHIVED`
   没有任何出边的任务**（`graph/status.ts` 的边表里 `ARCHIVED: []`，和 `MEETING_REQUIRED: []`、
   `BLOCKED: []` 一起是本仓仅有的三个死胡同状态）。

   ⚠ **本条已落地（O1-1 + O1-2），上面那句「仍然写库」不再成立。**
   现在 `hub run` / `hub resume` 只许写**桩自己认领的库**（库头上带
   `PRAGMA user_version = 9_000_001`），判据是**归属**而不是「库里有没有行」——
   原方案那个判据在「一条全新的真库被误指给桩」这一发上是绿的，而那恰恰是最值钱的一发。
   实现与实测见 §O1 动作 1 与 `packages/hub/test/cli/stub-write-guard.test.ts`。

2. **桩路线把「有审批」这件事演示成了真的。** 它一路直通，而界面上看不出这一条任务
   没经过任何门。**这条比第 1 点严重**：一个演示环境比生产环境**更绿**，正是
   0007 §4.1 记的那种「会把人训练成忽略信号」的形状。

   ⚠ **本条已【部分】落地（O1-2）：`report` 不再直通，改成停在 `ESCALATED_TO_CEO`。**
   原来那四条边里 `ESCALATED_TO_CEO→FINAL_REVIEW` 与 `FINAL_REVIEW→DELIVERED` 的语义
   是「CEO 批准上线」与「终审通过，交付」（`HUMAN_EDGES` 里那两句 `why` 的原文），
   桩写它们 = **替 CEO 批两次**，而这两条会进 append-only 的 `events` 表 ——
   审计日志里从此躺着两条没发生过的决定。现在桩与生产停在**同一格**。
   **剩下的那一半没动**：`charter` 节点仍然直通 `CHARTER_APPROVED`，
   那条要等真门控（O4/O5），已登记在 `test/arch/stub-terminal-write.ts` 的 `BASELINE` 里。
3. **`roles/preset.ts` 的 `NODE_TO_TEMPLATE` 把「公司」硬编码成那 7 个图节点**
   （intake/charter → assistant、product → product、tech → tech、dev → dev、test → test、
   report → ceo）。而 `packages/hub/resources/charter-templates/` 里躺着第七个文件
   **`ops.yaml`，没有任何代码路径装载它** —— 规格 §3.1 的组织图有运营总监与四个运营 agent，
   它们在代码里的全部存在形式，是一个永远读不到的 YAML 文件。
   【round288 修正，原文保留】**「永远读不到」这一句已经不成立**，而且是 O2-2 那天起就不成立的，
   只是这一节没跟着改：`charter/seed.ts` 的 `templateFiles()` 按**目录 glob** 读 `*.yaml`，
   `ops.yaml` 在其中（判据 A 让它整次拒绝、零写入，但那是「读了并拒了」，不是「读不到」）。
   ⇒ 现在的准确说法是：**它有一份没签的岗位书，而装配表里没有它的位置**。
   这一格与 §2 那一格（O2 动作 4 的修正块）本来就是同一件事的两处抄本，而它们不同步了。
   ⚠ 【round314 复核】这句「它们不同步了」已过期：两处抄本今天同口径 ——
   §O2 动作 4 修正块（验收第 5 条）写「它读起来是『有一份没签的运营岗位书』」，
   与本格的「有一份没签的岗位书，而装配表里没有它的位置」是同一件事的两种写法；
   钉住【事实】的守卫是 `roles/charter.test.ts:613`（孤儿集合 `== ["ops"]` +
   播种命令目录 glob 读得到它）。同步的凭据在守卫，不在散文。
   ⚠ 「不同步了【多久】」我**说不出**：`seed.ts` 与本文档今天都还是未跟踪文件
   （`git status` 实测两格都是 `??`），没有提交历史可查 ⇒ 只能说「播种落地之后这一格没跟着改」，
   不能说漂了几轮（round286 台账记的「归因不可考」同一个规矩：查不出来的时间量就不写）。
   唯一相关的钉子是 `roles/charter.test.ts:613` 那一发（孤儿集合 `== ["ops"]`），
   它判的是**装配表**维度的孤儿，所以它对这一句过期【全程是绿的】：
   守卫抓不到散文里的过期现状，这件事本轮又多一个实例。
   ⇒ 这条同时说明：**改组织 = 改这个常量 + 改图 + 重编译**。而 `POST /org`
   已经能改组织图并**强制变更前备份**，那条路是真的；
   改完之后 `dispatch` 会去 `role_charters` 查新角色的岗位书，而那张表恒空。
   **组织能改，改出来的角色是空壳。** 这是 O2 与 O8 的交汇点。

## 3. 一条主线

把这 14 项压成一句可执行的话：

> **让一个真的员工，带着真的岗位书，在真的门后面，花真的钱，做真的事，
> 并且一年以后这句话还读得出真假。**

前五句分别是 O1–O3（真的员工 + 真的岗位书）、O4–O6（真的门）、O7（真的钱）、
O8（真的组织）、O9–O12（真的、而且 CEO 一个人扛得住）；最后一句是 O13–O14。

## 4. 优化项

优先级按「解锁面 × 距离」排，不按「重要性」。两个同样重要的项，
**距离短的那个先做，因为它会解锁后面的**。每项的「验收」都写成
**一条今天会红、做完会绿的判据** —— 这条要求来自本仓的家规：
一条不可能红的判据等于一条假绿（0007 §4.1）。

---

### A 层 · 让产出真的发生

#### O1 把那条已经付过账的迁移收尾：图路线要么接真模型，要么改成只读 🔴

**现状。** `cli.ts` 硬编码 `StubRegistry`（`graph/stub-model.ts` 返回 `"stub:" + tier`）。
真实模型调用的那一格在 `engine/runtime.ts` 里，`runRole` 已经在被 `dispatch` 用。
迁移的理由（装不上依赖）已经不存在（§1.3），迁移没做完的后果见 §2 轴三那三条。

**目标。** 桩路线不再有机会写生产库，且不再能被读成「有审批的流程」。

**动作。**（按这个顺序，第一条最便宜）
1. `cli.ts` 打开库之后、跑图之前，加一道**只读守卫**：若该库已经有 `tasks` 行
   且没有任何标记说「这是一个演示库」，就拒绝运行并退出非 0。
   比「加一个 `--allow-stub` 开关」好，因为开关会被顺手加上，而拒绝是当场可见的。

   ⚠ **第 1 条已落地，但判据换了 —— 上面那句原话不成立。**
   「库里已有 `tasks` 行 ⇒ 拒绝」判的是【这个库现在有没有内容】，
   而要防的是【这个库是谁的】。**一条全新的真库被误指给桩时 `count(tasks) === 0`
   ⇒ 原方案放行 ⇒ 桩把它当演示库收养**，守卫在最有价值的那一发上是绿的。
   现在的判据是**归属**：库头上带 `PRAGMA user_version = 9_000_001`（`STUB_DB_MARKER`）
   的才是桩可以自己写的库，标记在 `cmdRun` **新建那一刻**打上。
   为什么占 `user_version`：它是 SQLite 唯一**读不需要写权限**的自定义槽位
   （守卫要在 `openDb` 之前用只读连接判，`openDb` 会**创建**文件，一旦创建成功
   "这库先前存不存在"就没有答案了），且**不需要迁移**。本仓此前全仓零处用它。
   `hub resume` 同样挡（它也会写）；`hub status` **不挡**（只读命令不该要写权限，
   那种守卫会被人整个关掉）。测试在 `packages/hub/test/cli/stub-write-guard.test.ts`，
   8 发，其中「⭐ 一条**全新的**真库也被拒」那发钉的就是上面这个差别 ——
   **删掉它，其余 7 发照样绿，而守卫就退回那个有洞的版本。**
2. `graph/company.ts` 的 `report` 节点：把直写 `ARCHIVED` 改成
   **落到 `FINAL_REVIEW` 并停住**（那一格在 `HUMAN_EDGES` 里已有合法入边，不用造新边）。
   这一条同时治第 2 条后果：**桩路线也会停在等人批的地方**，演示就不再比生产更绿。
   ⚠ 它会红一批现有图测试（`e2e-linear` 那 11 条里有断言终点是 `ARCHIVED` 的）——
   **那些红是这次修改想要的那批红**，不是回归；改断言之前先确认自己是在跟着规格走。

   ⚠ **第 2 条已落地，但落点比上面低一格 —— 上面那句「落到 `FINAL_REVIEW`」不成立。**
   要落到 `FINAL_REVIEW` 就必须写 `ESCALATED_TO_CEO→FINAL_REVIEW` 那一条边，
   而那条边在 `HUMAN_EDGES` 里的 `why` 原文是**「CEO 批准上线（§7.2 步骤 8→9）」**。
   也就是说那个落点仍然**替 CEO 走了一步**，而那一步会在 append-only 的 `events`
   表里留下一条决定 —— 停一格并没有省下最贵的那件事。
   现在的落点 `ESCALATED_TO_CEO` **不是挑的，是从席位表推的**：它是 `AGENT_EDGES`
   两条边的落点（`IN_REVIEW.blocked` 与 `APPROVED_UPWARD` 那条补边），所以「升上去」
   本来就是 agent 能做的动作；而 `FINAL_REVIEW` 是 `HUMAN_EDGES` 的落点，
   只有点一次批准才进得去。守卫把「人类格子」定义成 **`HUMAN_EDGES` 的落点集合**，
   取落点不取起点，理由就是这个差别。
   实测的红也印证了换判据的必要性：改动前守卫红在两发上 —— `report→FINAL_REVIEW`
   与 `report→DELIVERED`，**而不是红在设计文档点名的 `ARCHIVED` 那一发**
   （`ARCHIVED` 根本不在人类落点集合里，它由 `DELIVERED` 自动可达）。
   那批发红的图测试确实是想要的红：`e2e-linear` 3 发 + `cli/smoke` 5 发，
   全部是「路线长度 / 终点状态」一类，改法是把期望路线搬进
   `test/graph/fixtures/company-fixtures.ts` 由两处共用（原先这条路线的长度
   手抄在【六处】，漏改任何一处都是一条看着像回归的红）。

3. 依赖已装 ⇒ 在 `test/graph/` 加一发**真模型的最小回路**测试：
   不联网、只验「装配能接受一个真的 `BaseChatModel` 形状」。
   这条是给「桩换真」留的落地检查点，不验模型输出。

   ✅ **已落地（`packages/hub/test/graph/foreign-model-loop.test.ts`，6 发），但判据换了
   —— 上面那句原话作为判据【恒真】，两个理由各自都够它真：**
   1. `ModelRegistry.get(tier)` 的返回类型【就是】`BaseChatModel`，所以「能不能把一个
      `BaseChatModel` 传进去」由类型系统保证 —— 照原话写出来的测试是【读一个定义就
      永远绿】的那一种（0007 §4.1）。
   2. 更糟的是它挡不住任何事：本仓唯一的 `BaseChatModel` 实现是桩自己
      （`graph/stub-model.ts`），任何 `class X extends StubChatModel` 同时满足
      「是 BaseChatModel」和「是桩」⇒ 拿它跑一趟，验的是【桩接受桩】。

   现在判的是【实测出来的依赖面】：用 Proxy 包住交给装配的那个模型对象，记录装配代码
   在它身上读过哪些属性名。**实测恰好一个：`invoke`。** 把它钉成逐项相等的断言
   （不用 `toContain` —— 要多出一个成员才是那条未来故障的形状，而 `toContain` 对
   多出来是绿的）。哪天有人在 `askModel` 里加一句 `model.bindTools(...)`，
   这条当场红，且红在【改装配那个人】手上而不是三个月后接 provider 的人手上。
   变异实测：在 `askModel` 里插入一次 `model.bindTools([])` ⇒ **6 发里 3 发红**，
   其中两发的报错原文就是 `model.bindTools is not a function`，正是预测的那个形状。
   模型用 `FakeListChatModel`（`@langchain/core/utils/testing`，**LangChain 自己写的**，
   不继承本仓的桩），另有一条 `not.toBeInstanceOf(StubChatModel)` 钉住「用的确实是外来的」
   —— 没有它，将来有人把模型换回桩，这一发会【继续绿】。

   **顺手实测出来的一件事，比这条测试本身重要：模型的回答【今天不进任何产出】。**
   `node()` 里那句 `await askModel(name, state.idea);` 没有接收方。实测两次运行、
   回答内容【没有任何共同子串】，产出的 `events` / `tasks` / 图状态【逐字节相同】。
   ⇒ **「把桩换成真模型」今天改变的只有【花费与失败模式】，不改变任何可观察产出。**
   这一格上面那条断言管着（哪天开始被用会红，那是【应该红】）。
   另两发覆盖桩永远做不到的两件事：`_generate` 中途 reject（429）⇒ 异常上抛且
   回滚到【最后一个完整超步】，`entered` 停在 product 而库里只留到第一条边；
   以及 content-block 形状的回答 —— `askModel` 里那个 `typeof reply.content === "string"`
   的 else 分支【只有非桩实现能命中】，桩路线永远走不到它。

   ⚠ **一条【存活变异】，别以为这条测试什么都杀得掉**：把 `askModel` 从节点体之前挪到
   之后，6 发【全绿】。实测原因不是测试没用 —— 挪动后落库结果逐字节相同，因为
   回滚边界是【超步事务】而不是「模型调用排在第几行」。**这条守卫的射程是边界不是顺序。**
   另注：没为此加任何 provider 依赖（`@langchain/anthropic` 等一律不在 `node_modules`），
   且生产路线今天【根本不走 `BaseChatModel`】—— `engine/claude.ts` 用 `runRole` 起 CLI。
   所以「图路线接真模型」目前是一条【还没有生产实现的路】，这条测试钉的是它接上时
   必须满足的形状。

**验收。** 一条新守卫：扫 `hub/src`，**若存在一条会写 `tasks.status = 'ARCHIVED'`
且其路径上没有人类席位判定的边，报 FAIL**。今天它红（红在 `graph/company.ts`），
动作 2 做完它绿。**这条判据必须是红的现在** —— 如果它今天就是绿的，
说明我判错了它的形状，那就要先改判据，别改代码。

   ⚠ **验收已落地（`test/arch/stub-terminal-write.ts` + 30 发测试），但判据换了 ——
   上面那句原话作为判据不成立，而且它点的状态是错的。**
   实测三处：
   1. **盯字面量 = 可被绕过。** 把 `write("ARCHIVED")` 改成 `write(TERMINAL_STATE)`
      （常量值就是 `"ARCHIVED"`），这条判据**一声不响**。变异实测过。
   2. **盯 `ARCHIVED` 盯不到真正越权那两条。** 真正替 CEO 批的是
      `→FINAL_REVIEW` 与 `→DELIVERED` 那两条边；`ARCHIVED` 不在人类落点集合里。
      按原话实现，守卫会在**桩替 CEO 批了两次**的情况下报「无 ARCHIVED 写入 ⇒ 绿」。
   3. **「路径上没有人类席位判定」在词法层做不到路径粒度。** 现在判的是
      【本模块有没有从 `dispatch.js` 具名 import 席位权威】，是模块粒度。
      这条余量写在测试里，没有藏；第一稿认「代码区里出现过那个名字」，
      于是一个 `const seatOf = 1` 就能让无门模块判成有门，已收紧成认 import。

   现在的判据是三条合起来：① 桩图**真的会写出**哪些状态（词法提取节点体里的
   `write("…")`，注释不算）；② 落点的席位**从 `HUMAN_EDGES` 推**，本文件一个状态名
   都不抄；③ 不在基线里的落点 ⇒ 红，基线双向核对且逐条被特征串约束
   （今天基线只有一条：`charter→CHARTER_APPROVED`，凭据是 company.ts 里那句
   「没有审批门控」的诚实标注）。
   **它确实是先红后绿的**：改动前 `baseline.unexpected` = `report→FINAL_REVIEW,
   report→DELIVERED`，改动后为空。变异实测 6 发（还原旧 report 节点 ⇒ 4 发红；
   常量藏状态名 ⇒ 2 发红，靠的是【条数被钉死】那一发而不是席位判据 ——
   这条余量也记在判据文件头）。

**别当成做到了。** 「langgraph 现在能用了」不等于「图路线可用了」。
它能编译、能跑桩、能过 11 条测试，而它的节点体**一行工具调用都不做**。

#### O2 岗位书接进运行时：从「两份来源、哪份生效看谁后写」变成一份 🔴

**现状。** 三份事实并存，一份生效：

```
packages/hub/resources/charter-templates/*.yaml   ← 真内容，带 CEO-PLACEHOLDER-ACCEPTANCE
                ↓ 被 roles/preset.ts 装载
        只喂给 cli.ts 的桩图（取 modelTier / roleId 两个切面）

role_charters 表                                  ← 规格说该由它决定
                ↓ 唯一的生产写入方是 org/commit.ts 的 bumpCharter
        ⚠ 【round314 复核】「唯一」已过期：播种路（charter/seed.ts）也是生产写入方。
        而它开头就是 `if (prev === undefined) continue;`  ⇒ 新角色直接跳过
                ↓
charter/store.ts 的 saveCharterVersion            ← 真正的写入方，零调用方
⚠ 【round314 复核】这一格的「零调用方」已过期：`charter/seed.ts`（O2 动作 2 落地，
`pnpm hub:charter seed`）是它的第一个生产调用方 —— seed.ts 文件头自述这条翻向。
本图描述的是本篇写就时的现状；播种路落地后写入口存在，缺的换成「没有人签七个模板」
（见下 landing block 第 3 条）。

engine/runtime.ts 的 rolePrompt                    ← 真的提示词，只有两句话
⚠ 【round314 复核】「只有两句话」已过期：O2 动作 1（rolePrompt 接 charter/store）
+ O3 动作 1（memoryPromptSections）落地后，提示词含岗位书渲染块与记忆块；
「只有两句话」是本篇写就时（两者都缺）的现状。
```

真的 agent 每一轮拿到的全部内容是：**「你在一人公司里担任角色 [X]，你的汇报对象由 hub
按组织图决定，不由你决定」**。验收标准、禁止动作、决策范围、诚实边界、预算，**一条都没进提示词**。

**目标。** 一个角色「该做什么、不许做什么、怎么算做完了」在仓库里**只有一个来源**，
并且那一份**当场进提示词、当场进门控**。

**动作。**
1. `rolePrompt` 接 `charter/store.ts` 的读取口。这一步不需要新代码 —— 读取口已经写好，
   缺的是那一次 import。
2. `role_charters` 的**播种**：给 `bumpCharter` 那个 `continue` 补一条真路径，
   或者加一条**显式的**迁移命令 `hub charter seed --from resources/charter-templates`
   （推荐后者：播种是运营动作，不该藏在组织提交里悄悄发生）。
3. **占位串不能进生产。** 现在那 7 份模板全带 `CEO-PLACEHOLDER-ACCEPTANCE`。
   ⇒ 播种时若验收标准含这个占位串，**当场拒绝并退出非 0**，而不是带着它跑起来。
   这条是 `guides/how-to-write-a-charter.md` §3 那四个反例里第四个的机械化。
4. `ops.yaml` 要么进装载表，要么删掉。**留着它最坏** —— 它读起来像「运营角色已经存在」。
   【后续修正，原文保留】这一条是**假两难**，而且它的前提半假：
   ① `NODE_TO_TEMPLATE` 的键是**图阶段**（intake/charter/…/report），不是员工 ——
   「进装载表」那个选项根本不存在一个不撒谎的位置；② O2-2 之后「没有任何代码路径装载它」
   已经不成立（播种命令按目录 glob 读它）。**决定：留下**，并把「它今天算什么」变成算出来的
   （`roles/charter.test.ts` 一发守卫判孤儿集合 `== ["ops"]`，加模板不装配就红）。理由三条写在
   那一发的注释里，其中一条是反直觉的：**删掉它才是「空壳」的加强版** —— `org/commit.ts`
   对没有岗位书的角色是 `continue` 而不是编一份，删了这个文件，CEO 真加运营角色时
   连一份可读的模板都没有。

**验收。** 两半，缺一条都算没做到：
- (a) 一条**变异**测试：把 `rolePrompt` 里读岗位书那一句注释掉，必须至少有一发红。
  今天这个变异**全绿**（我量过：`engine/` 里对这些字段名的引用是 0）。
- (b) 播种命令对含占位串的模板**退非 0**，并且这条有测试。

   ⚠ **【0058 时的状态，动作 2 / 3 那两句已被下面的落地块推翻】**
   **动作 1 已落地（`engine/runtime.ts` 的 `rolePrompt`，见 0058），验收 (a) 已达成
   而正文那句「今天这个变异全绿」【不再成立】；验收 (b) 与动作 2 / 3 / 4 【一条没动】。**
   1. **(a) 的读数换了**：注入 `const charter = undefined as ReturnType<typeof readLatestCharter>`
      （**替换调用结果**，不删变量 —— 删变量测的是"编译器在工作"，0045 §9 的 G1′），
      全量 `4 failed | 2461 passed | 6 skipped` ⇒ 至少一发红，达成。
      但四发里**有一发的红不来自它自己的主断言**：「库里一个版本都没有 ⇒ 明说没有岗位书」
      那一发的主断言在变异体下**成立**（一个"永远产出没有岗位书"的变异体，使"你没有岗位书"
      这句话为真），红的是它旁边那条**反向对照** `runtime.test.ts:599`（round305 按语义重指；round312 同一轮内被顶漂两次 —— `seedCharter` 上提、随后 `biome check --write` 整份重排。原写 `:465` 从写下起就没对得上任何一次提交，口径与归因记在 `doc-refs.test.ts` 对应那一格）。
      ⇒ 写反向对照是有价格的：它把一条本来会恒绿的断言变成一条**只有附录才杀得死**的断言。
      这条价格必须付，但**要知道是谁杀的** —— 否则下一次有人把"重复的"附录精简掉，
      主断言仍绿而杀掉变异的没了（0058 §4 那张死因表）。
   2. **上面那句「我量过：`engine/` 里对这些字段名的引用是 0」现在是真的，而它当时
      被当成了"变异会全绿"的依据 —— 那不是同一件事。** 0058 §3 那三行反向断言用的
      needle 是 snake_case **键名**，camelCase 的读者对象里根本没有那些串 ⇒ 「它没出现在
      提示词里」恒成立。一个数不能替一次实验：口径写"引用是 0"，红的判据是"字段进了
      提示词"，两者之间隔着一次渲染。
      ⚠ 【round273 补一句，因为这条修正当时【只写在了这一节】】同一个错在本文
      §2 轴二那张表里又活了很久：那两行写着 `forbidden_actions` / `decision_scope` /
      `honesty_boundaries` / `escalation_triggers`「**无**读者」，而证据同样是
      「`engine/` 里引用为 0」。⇒ **一条修正只落在发现它的那一节，同一个错就能在
      同一份文档里活两个住址。** 现在两向都有指针：§2 那一行指回本条，本条指回 §2；
      判据是 O14 表 r9（`test/arch/claims-registry.ts`，两半：字段还在被渲染 + 渲染还在被调用）。
   3. **动作 1 交付的是"有岗位书时它进提示词"，而当时没有任何生产路径会往 `role_charters`
      写岗位书**（`bumpCharter` 那句 `if (prev === undefined) continue;` 还在，
      `saveCharterVersion` 当时零生产调用方）⇒ 生产上每一轮走的仍然是 `NO_CHARTER_LINE`
      那一支。**这一句是本节最重要的一行**：(a) 达成说的是"接好了、且有人拔会红"，
      **不是**"角色拿到了岗位书"。
      【后续修正，原文保留】**"没有任何生产路径"这一句已被动作 2 推翻一半**：
      `charter/seed.ts` 现在经 `saveCharterVersion` 写这张表。而**结论强度没变** ——
      播种对 shipped 模板恒拒（七份 0 份签过字），实测跑它 ⇒ 退出 1 且**零写入**，
      那张表**【2026-11-19 限定】只经迁移+播种的库恒 0 行；本机 dev.db 实测 1 行（UI 走查经 POST /charter 写入，见 round311 台账），每一轮仍然走 `NO_CHARTER_LINE`**。
      缺的一环从「没有写入口」变成「没有人签七个文件」：**执行方从代码换成了人**（限定同：签模板只是播种路的条件）。
      钉这一格的是 `store.test.ts` ④（期望值已从 `[]` 改成 `["charter/seed.ts"]`，
      改之前先按 `phase3.test.ts` 的 verifyFix 规矩问过"缺口真的消了吗"，答否）。
   4. **门控那一半比正文假设的更远**：本节的「目标」写的是"那一份**当场进提示词、当场进门控**"，
      而读岗位书当门控标准的入口 `gateCriteriaForRole` 在 `packages/hub/src` 里
      **零调用方**（只有 `test/acceptance/phase3.test.ts` 在调）。生产里唯一那发
      `evaluateGate` 在 `harness/verifier.ts`，它的 `criteria` 由**调用方传入**，
      不来自库。⇒ 动作 1 只接了**提示词**那半，门控那半**从来没接**，正文没写这一点。
      【round288 复核：`src` 里【零生产调用方】这句【仍成立】（现数：非 test、非注释的调用点 0，
      定义在 `charter/store.ts` 那一处除外）；括号里那半句【窄了】—— 调它的测试文件是【两个】
      不是【一个】，`test/charter/store.test.ts` 也在调（phase3 七处 + store 四处）。
      「零生产调用方」不变，所以这一格的结论不动；改的是【谁在测它】这个可复算的事实。
      复算：`node .workbuddy/round288-callers.mjs`（别抄上面那两个数）。
      ⚠ 同一发探针第一版把两处【注释里的提及】数成了调用点，差点据此登记一条
      「门禁已经接上了」的假进展 —— 与 round286 那条「`this.#fetch(` 被算成网络出口」
      同一个坑，这是【第三次】撞：按字面量子串数的探针必须先问「这个子串还会出现在哪」。】
   5. 【本条已被后续推翻，原文保留】**动作 2 / 3 / 4 原样未动**：没有 `hub charter seed`，占位串
      `CEO-PLACEHOLDER-ACCEPTANCE` 那 7 份模板原样在，`ops.yaml` 仍在原地读起来像
      "运营角色已经存在"。⇒ **验收 (b) 未达成**，且它现在**仍然无从达成** —— (b) 判的是
      播种命令的行为，而那条命令不存在（一条不存在的命令不会退非 0）。

   ⚠ **动作 2 与动作 3 已落地（`packages/hub/src/charter/seed.ts`，`pnpm hub:charter seed`），
   验收 (b) 已达成；动作 4（`ops.yaml`）【没动】。** 见 0059。逐条对齐正文：
   1. **命令名与正文差一层**：正文写 `hub charter seed`，落的是 `pnpm hub:charter seed`
      （`charter` 占了脚本名那个位置，不是 verb）。偏离的理由写在 seed.ts 文件头：
      `cli.ts` 那三个 verb 全过 `refuseStubOnForeignDb`，而那条守卫的前提是
      「桩只许写桩自己的库」，播种**就是要往真库里写** —— 语义相反，硬挂会逼它开一个
      「这次不是桩」的口子。照正文敲 `pnpm hub:charter charter seed` 的人落在
      「没有 [charter] 这个子命令」（seed.test.ts ② 钉了这一发的**指路正确性**）。
   2. **(b) 的测试有两发，缺一不可**：合成夹具（判据有判别力）+ **仓里那七份真模板**
      （今天的实际读数）。只有前一发的话，测的是"我造的夹具能被拦住"，而 CEO 跑的那条
      读的是真模板。并且**另有一发独立钉"前提还在"**（七份确实带占位串）—— 否则模板
      哪天签完，"stderr 里出现 N 次" 会变成 `0 == 0` 而那一发**静默地不再判任何东西**。
   3. **正文动作 3 那句「播种时…当场拒绝」现在有三条并列的拒**，不只占位串：
      库里最新一版与模板**逐字不同**也拒（不覆盖人的编辑 —— 播种只能给出一句模板化的
      `changeSummary`，而它是回放里唯一人可读的那句"为什么改"）；文件名 ≠ `role_id` 也拒
      （`validateCharterDraft` 那条"不一致就拒"在这里**恒真**、挡不住：播种传给它的
      roleId 与 config.role_id 出自同一份文件）。**任一角色不合格 ⇒ 一个都不写**，
      半套岗位书比没有岗位书难查。
   4. **一条正文没提的副作用**：播种走 `saveCharterVersion` 的默认 `applyBudgets: true`
      ⇒ 模板里的 budget 两格**同时**开始限流（实测 2 份岗位书 ⇒ 4 行 `budgets`）。
      这是刻意的（另开开关会造出 store.ts 文件头 D 段治的那个形状：屏幕显示新数字、
      执行侧按老数字放行），但它必须看得见，所以第一次写入前在屏幕上打一行，
      并指向审计的 `limits_applied` / `alarm_silenced`。
   5. **验收 (b) 达成 ≠ O2 的目标达成。** 表还是 0 行（上面第 3 条）。
      动作 4 也已处理，但**不按正文那两个选项**（见上面动作 4 的修正块）：`ops.yaml`
      **留下**，而「读起来像运营角色已经存在」这半句现在**不成立** —— 判据 A 让它进不了
      库，所以它读起来是「有一份没签的运营岗位书」，而那句是真的。
    6. **CEO 签完字、播种成功之后，O2 的目标仍然差一环，而这一环正文没写。**
       `role_charters` 按 **role_id**（= 模板文件名）存，而运行时那个读者 `rolePrompt(roleId)`
       收的 roleId 是 `tasks.assigned_role`，它还要先过门 0 的 `graph.nodes[task.role]`
       （`engine/dispatch.ts` 门 0 那一句）⇒ **「表里有这一行」与「有人读得到这一行」
       隔着两张表**。而这两套 id 今天就不相等：`roles/preset.ts` 那张
       `NODE_TO_TEMPLATE` 把节点 `intake`/`charter`/`report` 挂在模板
       `assistant`/`assistant`/`ceo` 上，另四个（product/tech/dev/test）同名。
       更直接的一条：`tasks.assigned_role` 的建卡初值是 `intakeRole`，缺省 `"intake"`
       （公开装配 `serve/assemble.ts` 不传它），而 `intake.yaml` 不存在
       ⇒ **七份全签完播进去，第一个要干活的角色仍然读 `NO_CHARTER_LINE`**。
       这一环的修法**取决于计划 §10.2 D11（role_id 用文件名短名还是附录 B 的语义名）拍板**，
       拍板前改任何一方都是实现层替 CEO 做组织决定 ⇒ 这一批只让播种命令**把这道缝说出来**
       （成功之后打一行"哪些角色在最新组织图上没有"，警告不拦，理由见 0059 §3.2）。
       ⚠ 顺带说明 **O8 那条端到端验收要怎么写才不空转**：`POST /org` 新加的角色若
       **名字恰好等于某个模板文件名**，那条测试能过；用了另一套命名，它会绿在
       「名字进了图」而岗位书那一格仍然空着 —— 正是 O8 正文自己警告的那件事。

**不做会怎样。** §23.2 里我自己标的最大风险（「如何写可机械判定的验收标准」）
在这一格没接之前**无从谈起** —— 写得再好也不进任何一次判定。

#### O3 记忆与先例：投影已经有了，没人读它 🟠

**现状。** `memory/role-memory.ts` 有 693 行，架构判断是对的（**不新建表**，
记忆是 `events` 的投影，投影可从事实源重算），隔离判据甚至是**编译期**的
（`CrossRoleScope = Exclude<MemoryScope, "strategic">` ⇒
「把 CEO 战略记忆授权给 dev」这句话在类型上写不出来，这比运行期白名单硬）。
它对外零 import。而且它自己的文件头记着一条更基本的事实：
`review_decision` 这个 action **写入方是 0**，`review_gates` 表同样零写入方，
所以「历史审阅决定与理由」这个字面对象**一条数据都没有**；
唯一真的有数据的角色决定是 CEO 那一条。

**目标。** 「这个角色过去怎么判的」进提示词；并且「这一格是空的」在**数据里**可见，
不靠读代码的人自己 grep。

**动作。**
1. `rolePrompt`（和 O2 同一格）拼上 `renderMemoryBlock` 的输出。
2. **先修 actor**：图/引擎写的事件 actor 是 `system`/`hub`，不是执行它的角色
   （判定现场知道 `roleId`，落库那一刻消失了 —— 本仓 0013 §10 那个形状的变体）。
   不先修 actor，按 `actor_id` 查记忆**恒空**，而这个空看起来像「这个新员工还没做过事」。
3. `memoryCoverage` 进 `GET /today`，让空在界面上是一格明确的「无数据」而不是 0。

**验收。** 变异：把 `renderMemoryBlock` 的返回值写死成空串 ⇒ 必须红。
今天这个变异**全绿**。另加一条断言：**actor 为 `system` 的角色决定行必须为 0**，
今天它红，动作 2 做完它绿。

   ⚠ **动作 1 / 2 / 3 都已落地，而三条的判据或落点跟上面写的不一样 —— 上面那句
   「今天这个变异全绿」与「今天它红」两句【都不成立】，且第二句永远不可能成立。**
   逐条对着上面重读：

1. **动作 1 已落地**（`packages/hub/src/memory/prompt.ts` 的 `memoryPromptSections`
   由 `engine/runtime.ts` 的 `rolePrompt` 拼进提示词）。验收第 1 条的读数因此换了：
   把 `renderMemoryBlock` 的返回值写死成空块 ⇒ 全量 **13 发红**，红在
   `engine/runtime.test.ts`、`memory/prompt.test.ts`、`memory/role-memory.test.ts` 三个文件。
   所以正文那句「今天这个变异全绿」是**本篇写下时的状态**，现在它是红的。
   ⚠ 我原本在这条下面写的是「`prompt.test.ts` 那几发有一半靠**反向对照**才红」，
   那句是**推理出来的**、没测，而实测把它推翻了：那一发红的是**主断言本身**。
   真机制值得记下来，因为它是「模块之间互相兜底」的一个例子 ——
   `renderMemoryBlock` 恒返回空块时，`memoryPromptSections` 并不跟着返回空串，
   它走进自己那条**「有候选行而一条都没进块」**的分支（`prompt.ts` 的 ③ 号路径），
   于是那句话变成「你在这个 hub 里做过 1 次可参考的决定，但这一块【一条都没给出】」，
   而用例的主断言找的是块里的内容（'历史决定' / '战略 2' / '比这一块更长'）⇒ 报的是
   `expected '…一条都没给出…' to contain '历史决定'`。
   ⇒ 杀掉这个变异体的是**渲染块与话术块之间那道"话必须跟着数据走"的契约**，
   不是任何一条专门为此写的反向对照。五个失败点里最后一个形状不同：
   `expected 0 to be greater than or equal to 2` 数的是那句「不构成对门控、权限或流程的授权」
   在渲染结果里**出现几次**（`memory/prompt.test.ts:158`，写目录是因为仓库里有两个
   `prompt.test.ts`，另一个在 `charter/` 下而它那一发数的是别的串）。正常情况下是两次：一次在
   `renderMemoryBlock` 的块头里，一次在 `prompt.ts` 那条「⚠ 上面这一块【不完整】」的尾巴上。
   变异体下两次**一起**消失 —— 块头随空块没了，而那句尾巴只在"块非空"那条路径上发，
   这一发走进的是「有候选行而一条都没进块」那一支，它只返回自己那一句 ⇒ 0。⚠ 我原本把这一条写成"数的是块长度"，那是**又一次没测就写下归因**，
   被本节自己那条规矩抓回来（去看那条断言本身，而不是猜它数什么）。

2. **动作 2 的前提半过时 —— 而且过时的那一半正好是它要防的那一件。**
   「图/引擎写的事件 actor 是 `system`/`hub`」今天只对**图中间件**成立
   （`graph/audit-middleware.ts` 不传 actor ⇒ 落 `recorder.ts` 的 `DEFAULT_ACTOR`），
   而它写的 action 是 `state_change`，那个值**根本不在** `MEMORY_ROWS_SQL` 的
   `IN ('approval','review_decision')` 里 ⇒ 它对记忆这一格一个数都不影响。
   引擎那一轮做成的审阅判定署的是 **`agent` + 审阅者本人的角色名**
   （`engine/dispatch.ts` 的 `ReviewDecided` 那条 `appendAudit`）。
   ⇒ 「不先修 actor，按 `actor_id` 查记忆**恒空**」这句话在 `review_decision`
   这一档【从来没有成立过】；上面正文把它写成动作 1 与 3 的前置条件，
   而它其实是**已经做掉的那一步**（0016 §1 第 1 条那个"写入方是 0"被它推翻）。

3. **验收第 2 条的判据是错的，不是"还没做到"。** 「actor 为 `system` 的角色决定行
   必须为 0，今天它红」—— 在一个正常运行的一人公司上这条**永远达不到**，
   因为 `action='approval'` 底下混着两种东西：`ApprovalRequired`（**请求**，
   「有件事等着人批」）与 `ApprovalDecided`（**决定**）。四处请求生产者把它们
   署成 `system`/`hub` 是**对的署名**（没有人做这个动作，是流程停下来了），
   而旧的 `memoryCoverage.unattributed` 按 `actor_type` 数，于是把请求数成了
   「有个决定没署角色的名」。后果不是数字偏一点，是**方向**：一条永远达不到的
   验收会被后来人读成「O3 这一项没做完」，而它其实是判据写错了。
   现在的判据是共享表 `NON_DECISION_EVENT_KINDS`，`classifyMemoryRow`（读侧分类）
   与 `MEMORY_COVERAGE_SQL`（判据 SQL）**从同一张表构造**，而 `is_decision` 是
   GROUP BY 的**维度**不是组内折叠（折叠会让正确性挂到"同一组里恰好不会混"这个
   生产者巧合上）。换完判据之后：
   **这一格的今天读数是 0** —— 不是"动作 2 做完它绿"，是它从来没红过，红的是判据。
   唯一能让它变非 0 的生产者是 `policy/auto-approve.ts` 署的 `system/policy-engine`，
   而那个模块在 src 里**零生产调用方**（0014 §3）。⇒ 读数 0 说的是
   【这条链路今天没接】，不是【没人代做决定】。
   ⚠ 这条改动同时让**仓库里原有的那一发**变红，而那一发是**错的**：它叫
   「图那种 actor 是 hub 而角色知道的事件会被报成 unattributed」，而它断言的
   `unattributed === 1` 是**后面那条 approval**给的，且它是**请求**；它名义上那条
   图事件（`state_change`）在这里一个数都不影响。已重写为四条断言
   （`role-memory.test.ts` ③ 节：`state_change` 不进 coverage / 请求不充数 /
   一条 system 署名的**真决定**计入 / 换成角色署名的反向对照），
   第三条与第四条在"把 `unattributed` 写成恒 0"的实现下会红。

4. **动作 3 已落地，但接进 `GET /today` 的不是 `memoryCoverage`。** 上面那句
   「`memoryCoverage` 进 `GET /today`」字面做得到，实测之后按另一条落点做：
   那一发要逐行 `json_extract`（判据读的是 `payload.kind`，用不上任何索引）。
   本机实测（50 万行 events、行均 ~600 字节）：**全表 coverage 680 ms**；
   只数未署名决定 186 ms，**新加 `(action, actor_type)` 索引之后仍然 180 ms**
   —— 这一行承重：它证明瓶颈是"每行解析一遍 JSON"而不是"缺索引"；
   而不碰 JSON 的 `COUNT`/`SUM` 扫描 **3.6 ms**，存在性 `LIMIT 1` **0.03 ms**。
   `events` 是 append-only、**没有归档路径** ⇒ 带 JSON 的那一发随行数**无界**变慢，
   而这一页是 CEO 每天必开的。⇒ 落地的是 `readMemoryTodayProbe`
   （`role-memory.ts`，三格一次查询：`scope_rows` / `gate_rows` /
   `gate_unattributed_rows`），报的是**行数**而不是**决定数**，字段命名按这条改。
   它能不碰 JSON 的理由只有一条，而那条被钉成断言：映到 `review_decision` 的
   事件 kind 与 `NON_DECISION_EVENT_KINDS` **交集为空**
   （`role-memory.test.ts` ⑦ 节从 `KIND_TO_ACTION` 与那张表当场算这个交集，
   不手写 `"ReviewDecided"` —— 手写等于把同一句话抄第二遍）。
   精确的未署名决定数**仍然只在** `memoryCoverage`，那是门禁与诊断跑的那一面。

5. **上面「现状」那段里三句话已过期，原文保留：** ① 「它对外零 import」——
   现在有（`engine/runtime.ts` 两处）；② 「`review_decision` 写入方是 0」——
   见上面第 2 条；③ 「唯一真的有数据的角色决定是 CEO 那一条」——
   `review_decision` 那一档今天有引擎写的**角色署名**判定，CEO 那条不再是唯一。
   行号那一栏我不写了 —— 写下「693 → 962」的时候它当天就又变了（现在是 993），
   而这正是 0060 §7 记的那件事：一个关于当前位置的数，在写下它的同一批里过期。
   要说的话只有一句：**增长几乎全在注释与那张共享表，不在判据数量上**。

**验收实测（下面每一个数都是一次真跑，脚本在 `.tmp/o3/mut-mem.mjs` 与两次手搓变异）：**

| 变异 | 结果 | 是谁杀的 |
| --- | --- | --- |
| `renderMemoryBlock` 恒返回空块（**验收第 1 条原话那一发**） | 红 | 全量 13 发，机制见上面第 1 条 |
| `unattributed` 写成恒 0 | 红 | ③ 节那一发 + ⑦ 第一发 |
| `is_decision` 从 GROUP BY 维度折成组内 `MIN` | 红 | ③ 节，报 `expected +0 to be 1` —— 正是注释里预言的那个失败方向（整组被报成非决定） |
| 探针 SQL 三条各改一格（scope 只数 approval / gate 不看 `actor_type` / gate 放宽成整个 scope） | 红 ×3 | ⑦ 第一发 + 今日视图那几发 |
| 探针零行不兜 0（让 `null` 透传） | 红 | 今日视图空库那一发 |
| `today.ts` 三条 notes 分支各断一支 | 红 ×3 | 今日视图 ⑥ 节各发的反向对照 |
| notes 里的 `scope_rows` 数字写死 | 红 | ⑥ 节"另有 3 条" |
| `dispatch.ts` 那句换成硬写 `action: "review_decision"` | 红 | ⑦ 最后那一发 |

合计 **12 发全杀**，没有一个变异体活下来 —— 而"全杀"这句话本身要带范围：
它只覆盖上面这张表列出的形状。**没有闸门**的那一半也说清楚：
`KIND_TO_ACTION` 若新增一个映到 `review_decision` 的事件 kind，⑦ 节**不会**红
（它对这一档的命题仍然为真），变的是那一档的语义本身 —— 那种变更靠
`recorder.ts` 上「加 kind 时回看这里」那条注释，机器不挡。
另有一条**认字面**的局限写在 ⑦ 节注释里：扫 src 那一发认
`action: "review_decision"` 这个字面，拼变量或换引号就扫不到。

---

### B 层 · 让防线真的生效

#### O4 核心防线现在不在执行路径上 🔴

**现状。** 「作者不能给自己打分」这条本设计的核心防线，代码存在于**四处**，
强度不一样，而**只有第 1 条在活路径上**：

| 位置 | 判据 | 在活路径上吗 |
| --- | --- | --- |
| `engine/dispatch.ts` 的 `reviewGate` | 同角色拒、`model_family` 空拒（fail-closed）、同家族无 CEO 批准拒 | **在**：它拦下 `planEdge` ⇒ 不写边，并建一张 `card_key = "same-family-review:…"` 的卡 |
| `engine/dispatch.ts` 的席位表 | CEO 三个席位**没有 agent 出边**，那一轮根本不开工 | **在**，而且这是最硬的一条：不是提示词不许，是那条边不存在 |
| `graph/gates/author-reviewer.ts` | `gateConfigBlock` / `selfReviewEdgeBlock` / `independentReviewerPath`（`forbiddenRemovalAttempt` / `unauthorizedAttemptPayload` 已于 0064 删除） | **这一格 round338 分成两半**：模块【已被走得到】—— `http/org.ts` 的 `GET /org` 经 `graph/gates/review-preview.ts` import 它（链：serve/dev-entry → assemble → http/app → http/org → review-preview → 它），所以「只被 verifier 用」那半句过期了。但走得到的只有 `sameFamilyReviewBlock` 一个函数，而且是【读数】不是【拦】：它只把「这一对会不会被拦」算给界面念，不拦任何东西。本行左边那一列点名的三个函数【仍然不在任何活路径上】：`gateConfigBlock` src 内 0 个调用点（连文件内都没有），`selfReviewEdgeBlock` 与 `independentReviewerPath` 各 1 个调用点且都在彼此内部 ⇒ 这一子簇整体仍然没人调（`harness/verifier.ts` 对外零 import 那半句仍真）。 |
| `graph/gates/evaluate.ts` | 同角色 ⇒ `escalate` | **判据不在活路径上**，但这一格的形状与上面那行同一种，别读成「这个模块死了」：模块【走得到】（`charter/store.ts` import 它的 `criteriaFromCharter` ⇒ 编译期 import 边把本模块带进可达集；⚠ 但【边被走到】是另一件事：`criteriaFromCharter` 的两个调用方 `gateCriteriaForRole` / `...AtVersion` 今天【零生产调用方】，而 store.ts 每轮真跑的是 `readLatestCharter` / `assertCharterShape` 那两个函数，不是这条），而本行判据那一条（`evaluateGate` 里 `input.reviewer.roleId === input.producer.roleId` ⇒ `decision: "escalate"` 那一支）在 src 里【只有一个调用方】= `harness/verifier.ts` 里那句 `const verdict: GateVerdict = evaluateGate({`（写特征串而不是行号，按 doc-refs 文件头取舍二：行号会漂而特征串可 grep），而 verifier 仍死（在基线、对外零 import）。⇒ 模块可达 ≠ 判据在跑，这条两粒度分工由 `test/arch/dead-modules.ts` 基线那段注释与 `phase3.test.ts` 那两条 `callersOf` 分别守（同一课在 `charter/store.ts` 的 `gateCriteriaForRole` 上又教了一遍：那条函数今天也是零生产调用方）。 |

⚠⚡ **round334 复测：第 3 行「只被 `harness/verifier.ts` 用」是句假话 —— 那三个名字在
`verifier.ts` 的【全部 git 历史】里一次也没出现过（`git log --all -S` 三个名字 × 该文件 = 0 命中，
阳性对照 `sameFamilyReviewBlock` 同法命中 1 发 ⇒ 搜索形状有效）。今天的准确形状：
`sameFamilyReviewBlock` 唯一的跨文件调用方是 verifier；`gateConfigBlock` **全仓零调用方**；
`selfReviewEdgeBlock` / `independentReviewerPath` 的唯一调用方是 `gateConfigBlock`（它自己没人调）。
「不在活路径上」的结论不变，但错的方向是**高估了覆盖面**：原句让这三个听着有一个运行期消费者，
实际上一个都没有。**行号表能骗人的第二种方式不是数错，是口径没写**——0062 §2 那张表把
`selfReviewEdgeBlock` / `independentReviewerPath` 记成 0 调用点，量的其实是【跨文件】口径，
它们在同文件被 `gateConfigBlock` 调的两处（组合点，`0e2f2c9` 就在）没被数进去；表没错，
没写尺子才是错。同一条复算机器：`.workbuddy/round334-o4-callsites.probe.mts`。

⇒ 结构上真的拦住了两件事（同族审阅必须先点一次卡片；被注入的角色无法自我交付），
但配置层的审阅规则（哪条委派边算审阅、哪些删除动作是越权）**今天一条都不生效**。

**顺带一条被高估的东西**：`reviewGate` 的独立性判据在今天的机器上**每次审阅都会命中**
—— 一台机器上所有角色共用一个 `model_family`。所以那条门不是「偶尔要点的例外」，
是**每一次都要点一下的常量**。这一点在界面上必须说出来（否则 CEO 会以为自己偶尔需要
看一眼，而实际上他需要每次都看），而且它直接决定 O9 的自动批准规则**必须**
把「同族审阅」当成一个独立的、可被规则放行的类别来设计，不能当异常。

**目标。** 配置层判据要么接上，要么删掉；不允许第三态。

**动作。**
1. `sameFamilyReviewBlock` 已经能算「同族 + CEO 是否真批过」。把它挪进 `dispatch`
   的活路径（它现在是纯函数，不用改形状）。
2. `independentReviewerPath` 那一跳的语义（**只看一跳，不做可达性**）
   先在 `dispatch` 的 handoff 上判：委派边若没有审阅门，允许，但**记一条 unresolved**，
   而不是静默放行。
3. `forbiddenRemovalAttempt` / `unauthorizedAttemptPayload` 那两个函数的唯一职责
   就是写那条 `unauthorized_attempt` 审计行；`dispatch` 今天已经为**另一种**情形
   （非法 handoff）写了这个行。⇒ **已选「删除」（0064）**：那两个函数 + 6 发相关测试
   已经删掉。选删除的依据是 `removeForbidden` 没有生产构造点——黑名单删除尝试
   到不了 dispatch，那条 `unauthorized_attempt` 审计无处可接；真正的删除闸门
   `mergeForbiddenForRun`（loader）仍然把 `removeForbidden` 抛错拦下，防护没少。
4. `review_gates` 表仍然**零 INSERT**（`db/integrity.ts` 里有一条自检明说这件事）。
   ⇒ 它现在是「规格要求的一张表 + 一个空的它」。补一条 INSERT 方（在 O4-2 的
   unresolved 落库时写它），或者接受它是预留并在 `integrity.ts` 那句自检里
   加上「预留，非缺陷」——**别留成一条永久警告**，那就是 0056 那篇在治的病。

**验收。** 逐条变异：把上表第 3、4 行的每一个函数调用点删掉 ⇒ 各自必须有一发红。
今天删掉它们 **0 发红**。**「测试全绿而调用点是删掉的」这一族，只有变异能抓，
**⚠ 落点：四个动作一个都没动，而这一格先落地了一件【开工前普查撞到的】别的账。**
上表第 1 行那个 `card_key` 怎么去重，读代码时顺手查了一下，量出来是一条**活的、自动烧钱的死路**：
0004 文件头把那条唯一索引要兑现的性质写成「同一个决定只有最多一张**待批**卡」，而索引
（`WHERE card_key IS NOT NULL`）**不看 status** —— 性质里有「待批」这一维，DDL 里没有。
于是 CEO 按【退回】之后：键被那一行 `rejected` 烧掉、下一轮拦门仍然为真而建卡返回
`skipped:"duplicate"`、收件箱里再没有可点的东西，而 `IN_REVIEW` 在
`DRIVER_ELIGIBLE_STATES` 里 ⇒ 驱动器每个心跳自动重跑那一格、每轮起真子进程，
审计里那句 note 还无条件写着「（已建卡）」。**「CEO 说了不」在实现里等于「这个问题永远
不再被问」**。详见 0061；修法是 `0006_approval_dedup_pending_only.sql` 把索引收窄成
`AND status = 'pending'`（恢复 0004 自己的原话），另加五发回归与三处我自己写下的假注释更正。

对 O4 本身的影响要说准，别读成「门控那一格已经修好了」：

| 项 | 状态 |
| --- | --- |
| 动作 1 挪 `sameFamilyReviewBlock` | **按字面不可行，已在写侧落地等价控制（0062）。** 实测
  `sameFamilyReviewBlock` / `evaluateGate` 这七个具名函数里 **5 个在 `src` 的调用点是 0**（另两个各自的唯一调用方全在
  `test/arch/dead-modules.ts` 基线里）⇒ 「挪进 dispatch、不用改形状」的前提不成立。能落的只有把
  **判据本身**收紧：`CEO_APPROVED_SQL` 原本只验 `status='approved'`，既不验批准人是不是 CEO、
  也不验有没有留下理由，而 `policy/auto-approve.ts` 写的 `decided_by` 是 `"policy-engine"` ⇒
  策略引擎写的一行今天**能**满足这道活门。已在**写侧**收紧（0061 §8 第 4 条，因为搬到读侧会让
  一张没写理由的批准**烧掉键**，正是 0061 修掉的形状）：① 身份维 —— `CEO_APPROVED_SQL` 加
  `AND decided_by = 'ceo'`（两个 decide 窗口本来就写 `'ceo'`，策略引擎那条 `'policy-engine'`
  是唯一异类 ⇒ 零误伤）；② 理由维 —— 豁免卡批准必须带理由，`approveCard` 对
  `same-family-review:` 前缀且空理由返回 `waiver_note_required`（否则在 `requiresNote` 只要求
  reject 的前提下一圈圈烧键）。两维各一发变异确认（round262-o4-mutate-identity.mjs /
  round262-o4-mutate-waiver-note.mjs），删掉即 1 红。原话的 `sameFamilyReviewBlock`↔`reviewGate`
  合并按上面那个实测的前提不再适用；动作 1 的**验收句（删调用点 ⇒ 一发红）对那 5 个函数
  仍然 0 红可删，未动** —— 那是另一件事，别把它当 0061/0062 的证据读。 ⚡ **round334 现场：这半句与同表下方【验收】行的「round271 复测：达成」是同一发 ffae248 一起落库的** —— 一张表的两行对同一句话读成「0 红可删」/「每处 ≥1 红」，矛盾从落库那一分钟就在全仓同时存在；round271 改口只改了验收行，没扫【共享同一读数的其他格】，这正是 O14 整篇要治的形状在本篇自家身上的复发。复跑（`.workbuddy/round334-mutate-o4.mjs`，判卷换全 hub 套件）：那五处调用点删除各 4 / 2 / 2 / 1 / 11 红 ⇒ 「0 红可删」对当下代码不成立；**「那是另一件事」的区分（闸门收紧 ≠ 调用点接线）仍然成立**，翻掉的只是那个 0。
| 动作 2 `independentReviewerPath` | **保留为纯判据，标注覆盖关系（0064）。** 这一格在写 O4 时
  假设「运行时 dispatch 会遇到无门控委派边，需要记 unresolved」。实测：无门控边在保存期就被
  `contracts/org/validate.ts` 的 `validateNewEdge`（`missing_review_gate`）拒掉，且同族/自审/
  升级断裂（`violatesNoSelfReview` / `escalation_unreachable`）也在同一条保存路径判完 ⇒
  dispatch 运行期读到的 OrgGraph 里【没有无门控边可判】；而 `delegation_graphs` 生产里甚至
  可能 0 行（im.ts 有记），跑哪来都没有东西可消费。运行期真正的审阅独立门控是 dispatch 自己的
  `reviewGate`（表上行 1），它已经把保存期承诺的门控执行成「同族 ⇒ 建卡等 CEO」。所以
  `independentReviewerPath` 留着当保存期判据的运行时对偶、有测试钉住，不新增 dispatch 消费点——
  硬接一个「读 graph.edges 判门控」的 dispatch 判据 = 同一条逻辑的第三份实现，必然与保存期那份漂移。
| 动作 3 黑名单删除尝试 | **已删（0064）。** `forbiddenRemovalAttempt` / `unauthorizedAttemptPayload`
  及 6 发相关测试已删除（author-reviewer.test.ts 28→22 发，全绿）。依据：`removeForbidden`
  无生产构造点，黑名单删除尝试到不了 dispatch，那条 `unauthorized_attempt` 审计无处可接；
  删除闸门 `mergeForbiddenForRun` 仍拦着。
| 动作 4 `review_gates` 零 INSERT | **接受「预留非缺陷」（0064）。** 补 INSERT 方需要
  `evidence_bundle_id` 指向存在的 `evidence_bundles`（`gateEvidenceCheck` 判 NULL ⇒ violated），
  而生产没有证据生产者（O5 那格：交接只带一句 summary）。在 O5 之前喂生产者只会把空的
  not_observable 换成恒 violated 的红灯；所以把 integrity 自检文案从「在等它的写入方」改成
  「预留非缺陷」正向表述，zero-producer 的登记保持 `zero`（那仍是事实）。
| 验收（删掉第 3、4 行调用点 ⇒ 各自一发红） | ~~**未达成，且这一句没有重新量过。**~~ **round271 复测：达成，且每处不止一发。** 0061 那五个变异（M1/M2/M3sql/M3ts/M4）全部打在**审批去重键与泵那道筛**上，没有一个打在
  `author-reviewer.ts` / `evaluate.ts` 的调用点上；0062 那两个变异（round262-o4-mutate-identity.mjs /
  round262-o4-mutate-waiver-note.mjs）打的也是**身份/理由闸门**，同样不是删调用点 ⇒ 上面那句
  「今天删掉它们 0 发红」是本篇写下的**旧读数**，~~我没有复测它，也没给它加任何一发测试。~~
  **round271 复测了**（`.workbuddy/round271-o4-acceptance-mutate.mjs`，五发自恢复变异，
  每一发都过 `tsc -b`——形状是带返回类型标注的 IIFE 交回 canned 值，刻意让语法与类型
  都合法，钉的就是本篇那句「tsc 只看见函数还在被同目录引用」）：
  ① verifier 的 `sameFamilyReviewBlock` 调用点 ⇒ **4 红**（同族拒/家族未声明拒/批准人非 ceo 拒/
  码表覆盖）；② `selfReviewEdgeBlock` 里的 `independentReviewerPath` 调用点 ⇒ **2 红**；
  ③ `gateConfigBlock` 里的 `sameFamilyReviewBlock` ⇒ **2 红**；④ 同函数里的
  `selfReviewEdgeBlock` ⇒ **1 红**；⑤ verifier 的 `evaluateGate` ⇒ **9 红**。
  旧读数「0 发红」对**当下代码**不再成立——0064 把动作 3 删干净、把 `independentReviewerPath`
  定成「有测试钉住的保存期对偶」之后，这批调用点每一个都至少有一发红。
  ⚠ 这一发达成的是**验收的判据**，不是 O4 的目标本身：这些调用点全在死模块基线里
  （verifier / author-reviewer），「测试绿着而调用点是删掉的」这一族今天有变异可抓，
  但「防线在活路径上跑」仍未兑现（那等的是 O6 接线与真员工）。
  **别把它当成 0061/0062 任何一篇的证据读**——那两个变异组打的仍是闸门与去重键。
  ⚡ **round334 第三次复测**（`.workbuddy/round334-mutate-o4.mjs`，同五锚点逐字复用，
  判卷换成【全 hub 套件】102 文件 / 2366 发全绿基线，每发施加变异后先过 `tsc -b`）：
  M1=4 红 / M2=2 红 / M3=2 红 / M4=1 红 / **M5=11 红（2 文件）**，五发 tsc 全部看不见，
  控制组与回滚后基线各复跑一次自证 ⇒ 「达成」在今天成立，且 M5 比 round271 多红的那两发在
  `phase3.test.ts`（门禁诚实口径 + ①重跑无路可跑）。**判卷面的差异这轮才看得见**：
  round271 台账明写判卷 = verifier.test + author-reviewer.test 共 61 发（当时挑文件跑），
  而 phase3.test.ts 在 round271 当天【已经存在】（77c2f81，11-15）且那两发也已在 ——
  9→11 的差是【挑文件 vs 全 hub】的尺子差，不是代码变了形状。一条验收句的「达成」二字
  必须带判卷面，否则换一把尺子读出来的数会被当成代码漂了。

顺带一条与动作 1 直接相关的读数（0061 §5）：索引收窄之后 `countSimilarApprovals`
**变好**了 —— 它按 status 分桶聚合「同类审批被拒过几次」，而旧索引把一个键上的行数压成
0/1，那一格被索引上限挤成恒 0 或恒 1。O9 的自动批准规则要用这一格的时候，注意它的
读数口径在 0006 前后**不是同一个**。

证据：`.workbuddy/round261-dedup-mutate.mjs` + 0061 §8；动作 1 那两维另见
`.workbuddy/round262-o4-mutate-identity.mjs` / `.workbuddy/round262-o4-mutate-waiver-note.mjs` + 0062。

`grep` 和 `tsc` 都抓不住**（`tsc` 只看见函数还在被同目录引用）。

#### O5 证据包：门控要的输入，全仓没有生产者 🔴

**现状。** `evidence/store.ts` 的 `verify` 是对的，而且严格得恰当：
`ok = failures.length === 0 && checked > 0` ⇒ **一份只含外部链接的证据包 `ok` 是 `false`**
（这是设计，不是 bug）。路径穿越单独分类、空 bundle 合成一条 `missing`、
`sha256` 必须匹配 64 位小写十六进制（不是 `length(64)` —— 那样 `verify` 会永远失败）。
而：`EvidenceStore` 对外零 import；`engine/dispatch.ts` 文件头明写交接**只带一句 summary**，
所以 §8.2 第 2 条「通过必须附可验证证据」现在**无处可满足**。
门控那一侧的写法是对的（`integrityOk` 为 `undefined` 时进 `unresolved` 而不是放行），
但**没有任何生产代码算这个布尔**。
⚡ **round358 翻向（门 4 接线）**：上面那句「没有任何生产代码算这个布尔」**已过期** ——
`evidence/turn-bundle.ts` 的 `produceTurnArtifact` 在生产路径上算 `integrityOk`（恒布尔，
无 `undefined` 那一支），`registerTurnEvidence` 把包登记进 `evidence_bundles`，
`writeGateDecision` 落 `review_gates`；`engine/dispatch.ts` 的门 4 在建事件之前
调它并传 `evaluateGate`。而 `evidence/store.ts` 至此【模块可达】（链：
`hub:engine` CLI → `engine/hub-work.ts` → `engine/work.ts` → `store.ts` 的
`artifactsRoot`；dead-modules 基线条目 round358 摘除）。
⚠ 但 O5 的【最小证据形状】那半没有全做到：`verify()` 对磁盘上那颗产物核验的内容可信
（§8.2 第 2 条的「内容可信」那一半）仍靠岗位书标准撑，而 role_charters 今天 0 行 ⇒
每一轮审阅都会在门 4 被拦成一张卡。那是 CEO 拍的「全量拦」（0 标准不放行），
不是这一格漏了 —— 见 dispatch.ts 文件头 round358 那一段。

**目标。** 交接带证据；门控拿到一个真的布尔；`integrityOk === undefined` 这一支
在生产里不可达（而不是像今天这样：它是唯一一条不会误伤的路径）。

**动作。**
1. 先定**最小证据形状**：不要一上来做 artifact 目录扫描。
   最小可用 = 一次交接带 1–3 个「文件 + sha256」，文件落在任务专属目录。
2. `dispatch` 的 `pass` 分支在建事件之前算 `integrityOk` 并传给门控。
3. 契约 `evidence_bundles` 与库的对应：契约有 `metrics` 而库里没列 ——
   这条 `guides/how-to-write-a-charter.md` §6 记过。要么加列，要么从契约删掉；
   **别让它继续当一个「看起来能判实际没人填」的字段**，那正是 charter §3 反例 2。
4. `GET /approvals` 的卡片上，把「这一条卡片背后**没有任何证据包**」显示出来 ——
   `approvals` 表**没有指向证据包的列**，`channels/abstraction.ts` 已经承认
   `evidenceRefs` 可空「**原因是缺陷不是设计**」。这条要连着 `approvals` 的 schema 改。

**验收。** 一条门控单测：**若 `integrityOk` 在生产路径上仍可取 `undefined`，红**。
具体形状：起一次真的 `dispatch`（用测试桩模型，不需要网），断言门控收到的输入里
`integrityOk` 是布尔。今天它红。**并且**必须同时补一条反向：把 `verify` 判不成的
东西送进去 ⇒ 门控必须拒 —— 防止「接上了但算出来恒真」，那比不接更坏。

   ⚠ **动作 3 已落地（0065，迁移 0007 + `register()` 序列化）；动作 1 / 2 登记为
   前提不成立（0065 §3）；~~动作 4 未动~~ **动作 4 已落地**（迁移 0008 + 契约/读写/UI
   一条链，round270 补账时核实；那句「未动」是落地轮没记台账留下的过期主张，
   正是 O14 要抓的「这句话过期时没有任何东西变红」的现行样本——抓它的不是守卫，
   是新一轮普查）。验收那句【今天不能写】，理由同 O6 那格（0056）。**
   1. **动作 2 假设「pass 分支上有一次门控调用」—— 实测 `grep -c evaluateGate
      engine/dispatch.ts` ⇒ 0。** 门控在 src 的唯一调用方是死模块基线里的
      `harness/verifier.ts`（0062 量过，本轮复核未变）。dispatch 单侧先算 `integrityOk`
      是【为到不了的输入造数据】—— O4 动作 2 刚论证过的同族错误，不能犯第二次。
      `integrityOk` 要等的是【门控接进执行路径】那一格（正是 O4 验收句指的）。
   2. **动作 1（最小证据形状）不单独先行**：形状只有配着消费方才不空转，而消费方
      （门控上线路）与生产者（dispatch 带包）必须一起设计 —— 先落形状等于再造一个第三态
      （这次是【有形状没消费】）。
   3. **动作 3 落地时选「加列」不选「删字段」**：删 `metrics` 会连带杀 `metric:` 判据族
      （唯一可机械判定的验收标准形状）。修的是【数存在哪】，不是【数谁来算】——
      src 生产该值的代码仍 0 处，`register()` 也仍只有测试调用方（这一列是存放处不是生产者）。
      镜像夹具那一发的红因值得记：手抄列清单与 src 副本漂移，红话读起来像【落库错了】——
      一次混两种故障，所以修法是让夹具直接执行 store 自己那条 SQL（镜像减为零份）。
   4. ~~**动作 4（卡片显示无证据包 + approvals 指向证据包的列）仍未动**，它是 O5 里
      下一格可独立落地的。~~ **已落地，且落地轮欠两样账（round270 补齐）**：
      迁移 0008 给 approvals 加了 `evidence_refs` 列；建卡写侧（`cards.ts` 空数组落
      NULL、非空落 JSON）、读侧（`query.ts` 的 `evidenceRefsOf` 三层防御：坏 JSON /
      非数组 / 混非字符串 ⇒ null 不 500）、契约（`approvalViewSchema.evidence_refs`
      可空数组）、UI（`app.js` 的 `evidenceLine`：null/[] 明说「无证据包」，非空报条数）
      四条都在，cards.test ⑥ + query.test 各钉住服务端那一半。欠的是：
      ①台账没记（round265 自首过），②变异证据一发没有，UI 那一半连执行证据都是零
      —— 而这一格的全部价值恰在屏幕上那句话，「无证据包」不显示，缺证据的卡就和
      带证据的卡一样可批。round270 补：`app-pure.test.ts` 的 evidenceLine 三发 +
      `.workbuddy/round270-o5-backfill-mutate.mjs` 三发变异（读侧死字段 / 写侧断链 /
      UI 沉默）各打各的红、全部自还原核对。
      ⚠ **别读成整格闭环**：这一列补的是【存在哪里】，生产者（dispatch 交接带包）
      仍是动作 1/2 的活；`channels/abstraction.ts` 的 `ChannelCardSnapshot.evidenceRefs`
      注释同步更正为「列有了（0008），缺的是生产者与【卡片→哪份包】的语义」。
   5. 验收句的现在可读形态（不是原话）：`bundle.test.ts` 的「十一字段落库」与
      「metrics 三态 NULL / "{}" / 有值不折叠」两发，加变异实测（退回裸 `JSON.stringify`
      ⇒ 2 红）。原话那句要等 dispatch 带包那天才有主语，那一天归门控上线路（O4 验收句）。

#### O6 `harness/` 那 3300 行：现在真的员工在安全层外面 🔴

**现状。** ~~`engine/claude.ts` 起子进程时传的是 `env: process.env`，
参数只有 `--output-format json`、`--permission-mode plan`（加上可选 `--resume`）。
这是**真员工今天实际经过的唯一一层**：四层预防（`harness/safety.ts`）、
路由（`harness/routing.ts`）、预算门（`harness/gateway.ts` 的 `checkBudget` / `settle`）、
独立复核（`harness/verifier.ts`）——**`harness/` 整目录对外零 import**。
今天的实际状态是：**靠 `--permission-mode plan` 这一发兜住写文件**，
而那是 CLI 的一个参数，不是本仓实现的四层防线。~~
⚡ **round312 翻向（O6 动作 2 接线落地）**：`engine/runtime.ts` 的 `runTurn` 现在每轮经
`harness/gateway-runner.ts` → `harness/gateway.ts` 的 `callHarness` →
`adapters/claude.ts` → `engine/claude.ts` —— 原话里翻掉的是「唯一一层」与「整目录对外零 import」。
起进程前真的被问的是三层判据（forbidden_flags / 沙箱档位 / workspace 绝对性，
`harness/safety.ts` 的输出）＋能力声明核对，事后落一行 `harness_call` 审计。
仍然成立的部分：写文件【还是】靠 `--permission-mode plan` 兜（工具层恒空：plan 模式下
没有工具调用）；路由与复核（`harness/routing.ts`、`harness/verifier.ts`）零生产调用方；
预算门（`checkBudget` / `settle`）仍是无人调用的类型槽 —— 钱照旧由 `onCost` 记，
这是刻意留的装配边界（谁记账要先定，归 O7），不是漏格。

**目标。** 真员工的每一次工具调用经过 `gateway`；`safety` 的预防表要么生效要么删。

**动作。**
1. **先诚实标注**：在 `engine/claude.ts` 文件头把「今天唯一生效的安全边界是
   `--permission-mode plan`」写清楚（现在那句话散在参数注释里，
   而 `harness/` 那边的文档读起来像四层都在跑）。**这条今天就能做，且不做的话
   后面每一条都会被误读成已兑现。**
2. `gateway.ts` 已经把预算侧写成两个注入函数（`checkBudget` / `settle`），
   因为它知道 `BudgetTracker.consume` 要求 `recorder.inStepTx()`。⇒ 接线点明确：
   `runtime.ts` 的 `onCost` 旁边。~~把 `onCost` 里那三条手抄 SQL 换成走 gateway（顺带解 O7-1）。~~
   【round272 复测：字面这句的前提不成立，动作本体仍未做；真实存在的那半个洞已另行堵上】
   「换成走 gateway」要的是一条【调用路径】，而 `checkBudget` / `settle` 只是两个
   【类型槽】—— `gateway.ts` 里没有一行预算 SQL，`callHarness` 今天零生产调用方。
   ⚠ 【round314 复核】「`callHarness` 今天零生产调用方」已过期：round312 接线后
   `runTurn` 每轮经 `harness/gateway-runner.ts` 调它（真员工每一轮都过 gateway）。
   这一句是 round272 写下的当时现状，round312 翻向块（见下）没有单独点名这半句。
   判断不受影响——`checkBudget` / `settle` 仍是类型槽（round312 落地块第 4 条原样：装配方留空，钱照旧由 onCost 记）。
   ⇒ 落的是那句话底下真实的那件事：那三条 SQL 和 `budget/tracker.ts` 的两条是
   【同一件事两份手抄】，现在收敛成 tracker 一份、两条路线 import 同一份（见下面落地块）。
   「顺带解 O7-1」另外还有一处前提错，登记在 O7 动作 2 那一段。
3. `safety.ts` 的四层预防接在**工具调用**上，不是接在 CLI 参数上 —— 而今天的
   `plan` 模式下没有工具调用。⇒ **顺序依赖**：O6-3 必须排在「真员工真的动手」之前，
   不能排在之后。这是本篇认为**风险最高的一条顺序**：
   先给写权限、后接安全层，中间那段时间里，仓库里有 3300 行看起来像防线的死代码。
4. `routing.ts` 的 `forbidden_flags` 不可覆盖（§4.1.3）在 `plan` 模式下同样无的放矢，
   可以和 3 一起做。

**验收。** 一条**依赖边界**测试（本仓已有 `dependency-boundary` 先例）：
`engine/` 必须 import `harness/gateway`，缺则红。今天它红。
另加：`harness/` 若再次变成对外零 import，红 —— **把「不许再断」写成一条守卫**，
而不是写在这次 PR 描述里。

   ⚠ **动作 1（诚实标注）已落地，验收第 2 条已落地，验收第 1 条【判据换了 ——
   上面那句原话作为判据不能写】。**
   1. **「今天它红」的那一条不写。** 按 0056 的结论，一条恒不可能通过的验收命令
      = 一条恒红断言，而恒红的东西会被当成环境噪音关掉，比不写更坏
      （0007 §4.1 记的就是这个代价）。它要的其实是**接线那天**才成立的断言，
      那一天由下面的方向 B 负责喊，不靠一条今天就在红的守卫预告。
   2. **动作 1 落地时撞到的是【横幅写对了也等于没写】。** 横幅措辞必须被
      `test/arch/dead-modules.ts` 的 `claimSites` 看见，而它的口径是
      【模块名与否定词**同一行**】。第一版把四个模块名写在一行、
      「对外零 import」落在下一行 ⇒ `claimSites` 一处都没扫到（复算：注入探针逐模块
      打印命中，四个模块全为 0）。那段话看起来兑现了本条，兑现的那一格是零。
      现在四个 `harness/*.ts` 各带一行横幅（`gateway`/`safety`/`routing`/`verifier`
      的 line 2），`engine/claude.ts` 的诚实标注也同行写完模块名。
      守卫是 `dead-modules.test.ts` 的「横幅的机器可见性」：**逐文件**判，
      命中还必须在文件头 15 行内。变异实测：把 `routing.ts` 那半句换个行 ⇒ 红且
      红话点名（`expected '横幅隐形：harness/routing.ts' to be '横幅隐形：'`）；
      把 `claimSites` 改成忽略换行 ⇒ 2 发红；改成恒返回空 ⇒ 4 发红。
   3. **「不许再断」判的是四状态链，不是链尾。** 只在基线那条**已被删掉**之后，
      方向 A 才抓得到「再次变死」；条目还在时「死 + 在基线」正是守卫眼中的预期状态
      ⇒ 绿。所以保证来自「方向 B 一直红，直到你把那条删掉」。
      `dead-modules.test.ts` 那条 canary 把五状态拼成**一条**断言：
      ①断了+在基线(今天)=绿 ②接上+在基线=方向 B 红 ③接上+删了基线=绿
      ④再断+删了基线=方向 A 红 ⑤再断+基线还在=**不判**（这是这套机制的**边界**：
      它保证「接过之后再断会红」，不保证「从来没接上会红」—— 后者是 O6 的动作本体）。
      合成一条是**为了删不掉**：分开写的时候，③那一行整行删掉测试照样绿（变异实测
      存活），进了拼串表之后删任何一行都让串变短 ⇒ 红。
   4. ~~**动作 2 / 3 / 4 没动**~~【round272 改口】动作 3 / 4 没动；动作 2 的
      **接线**没动，但它底下那个洞（两份手抄 SQL）单独堵了 —— 见下面的落地块。
      这一句原来整句是绿的，它的问题不是写错，是**粒度**：「动作 2 没动」和
      「动作 2 里那份重复 SQL 没动」在验收上完全不是一件事，而原句把它们合成一格，
      于是堵住一半之后这一格没法表达。~~`harness/` 四个模块今天仍在基线里
      （canary 里那条进度读数判的就是这一格，四格全绿）。O6-2 的接线点仍是
      `engine/runtime.ts` 的 `onCost` 旁边；O6-3 那条硬顺序约束（必须在真员工拿到
      写权限**之前**）没变。~~
      【round312 再改口】接线【做了】—— 见下面的 round312 落地块：基线里剩
      `routing` / `verifier` 两格（canary 那条进度读数现在是两格状态① + 两格已离开），
      接线点也不再是「`onCost` 旁边」而是【每一轮 runTurn 之前】；
      O6-3 的硬顺序约束【原样有效】，只是它现在指着 `harness/routing.ts`——
      safety 那一半已经接上，「先接安全层」不再是还没做的事。

   ⚠ **round312 落地块：O6 动作 2 的【接线本体】落地了。**
   1. **接的形状。** `engine/runtime.ts` 的 `runTurn` 不再直调 `runRole`，改走
      `harness/gateway-runner.ts` 的 `runViaGateway` → `callHarness` →
      `ClaudeCliAdapter` → `runRole`。岗位书里的 `harness_defaults` 逐轮翻成
      `HarnessRequest`（沙箱档位 / allowed_tools / forbidden_flags / approval_policy），
      没有岗位书的角色拿显式的 read-only + 空表（「这个角色没有章程」是文档过的
      合法状态，不是「章程功能没装配」——后者才触发装配期抛错）。
      workspace 用装配级 `cwd`，绝对性判据新立 `isAbsoluteWorkspacePath`
      （Windows 的 `D:x` 是盘符相对路径，必须拒——round303 那族「同一字符串两种读法」）。
   2. **审计的异步落法。** `deps.audit` 是同步回调而写库要等事务：每一发尝试先攒进
      缓冲区，`runTurn` 在【自己的】`writer.node()` 里补写非重试那些行——
      不搭 `dispatch` 那笔事务（回滚会把留痕一起抹掉），可重试的尝试【永不 flush】
      （「一次没发生过的调用」必须留在重试的透明性里）。落库失败 console.warn 不上抛，
      与 `recordTurn` 同一条不冒泡立场。
   3. **验收第 1 条现在写得出正文了**（0057 说「等接线那天由方向 B 负责喊」，那天到了）：
      方向 B 那条红如约出现、点了 6 处主张坐标，基线格与横幅【同一轮】摘除；
      dead-modules 基线下界 13→8（另外 3 条是 gateway 一条 type-only import 把
      `search/observe` → `mcp`/`policy` 带出的传递可达——本表口径是编译期 import 边）。
      canary 的进度读数按家规改口成「两格状态① + 两格已离开」，控制组从 gateway
      换成 routing（对一个已不在基线的格子做「拿掉」是空操作，控制会失效）。
   4. **没落的两件（刻意）**：`settle` / `checkBudget` 仍留空——同一笔钱两条腿记账
      比没人记更糟，spawn 前的预算闸已经在 pump 的 `underTaskBudgetSql` 里；
      工具白名单层今天恒空（plan 模式无工具调用），由契约钉着等 SDK 适配器。
      动作 3/4（routing / verifier）仍没动——O6-3 的排期语义没变：它们要在
      「真员工拿到写权限」【之前】接，而写权限还没放开。

   ⚠ **round272 落地块：动作 2 的【那半件事】落地了，接线的本体没有。**
   1. **落的是什么。** `engine/runtime.ts` 的 `onCost` 里那三条 SQL 与
      `budget/tracker.ts` 的两条是同一件事的两份手抄（差别只是 `scope_type` /
      `period` 内联成字面量 `'task'` / `'per_task'`）。现在三条 SQL 由 tracker
      `export`、引擎路线 import，内联换成【绑参】⇒ 两份**逐字节相同**是
      结构保证，不再靠「记得同步改两处」的约定。绑参顺序写在 tracker 的块注释里。
   2. **为什么收敛不写「同一件事」而写「同一份」。** 前一种说法要靠人来维持，
      而维持它的那个人不在场（本篇 §6.4 那一族）。收敛之后「改一处不带着另一处」
      这句话在源码里**没有对象** —— 只有一条语句两个调用点。
   3. **机器判据**（`claims-registry.test.ts` 新增那一发）：引擎路线的源码里
      出现 `INSERT INTO budgets` / `INSERT INTO budget_events` /
      `consumed_cents = consumed_cents + ?` 任何一条字面量 ⇒ 红；同时必须
      import 到三条语句名。它的**边界**要说清：把 SQL 挪到第三个模块也红 ——
      那不是误报，是「单源该放哪」这个决定必须由人重画基线，守卫只拒绝沉默。
   4. **变异实测**（`.workbuddy/round272-o62-sql-single-source-mutate.mjs`，三发全部
      自回滚、字节比对）：
      · M1 把字面量 `INSERT INTO budgets …` 抄回 `onCost` ⇒ 守卫 2 发红，
        而 `engine/runtime` 的**执行测试 26 发全绿**。这一发是本块的全部理由：
        「改一处不带另一处」这类洞**跑测试看不见**，只有字节级守卫看得见。
      · M2 删掉扣减那一句的调用 ⇒ 守卫 1 + 执行 2 发红（这一类执行测试看得见，
        因为它改变了行为）。
      · M3 把 `scope` 绑参从 `"task"` 写成 `"role"` ⇒ 字节守卫**绿**、执行 2 发红。
        所以这次收敛解的是「两份 SQL」，**不解**「绑参写错」—— 那句话别读成前者管住了后者。
   5. **没落的两件，各自的原因**：
      · **没接 gateway**：`checkBudget` / `settle` 是类型槽，`callHarness` 零生产调用方
        ⇒ 接过去等于把一条活的记账路线接进一段死代码，症状是「测试全绿而生产没变」。
        `harness/gateway.ts` 顶部那条横幅因此只划掉了「两份 SQL」那一句，
        「今天一行都不执行」原样留着。
        ⚠ 【round314 复核】这半句的「callHarness 零生产调用方」已过期（round312
        接线后每轮被调），「checkBudget / settle 是类型槽」仍成立 —— 判断的依据
        是装配方留空，不是 callHarness 死着；「今天一行都不执行」那句横幅已在
        round312 翻向时自删（gateway.ts 文件头现在写「真员工每一轮都经过这里」）。
      · **没发 `BudgetPaused`**：归 O7-1（CEO 拍板），且状态机那一格没动；
        另外本轮量到「发了就能被 `today.ts` 读到」这句也是错的，登记在 O7 动作 2。
   6. **顺带被这次改动顶到的坐标**：`tracker.ts` 的 `breached` 那行、`budget-sync.ts`
      的 `silentOverBudgets`、`runtime.ts` 的 `REJECTION_COUNT_SQL` 都往下漂了，
      `doc-refs` 的快照键与 `0015`/`0042`/`0045`/`0050` 里的坐标同轮改完；
      `budget-sync.ts` 顶部那句「`consumed_cents` 的写入方有几处」改了**第三次**
      （现在是「语句一条、调用点两处」），那一处把「数一数就知道」为什么危险写在了现场。

---

### C 层 · 让钱和岗位真的管得住

#### O7 预算：有记账、有一道预 spawn 的门，没有「停」 🔴

**现状。** 三件事同时成立：
- `BudgetTracker`（全仓唯一算 `breached`、唯一发 `BudgetPaused` 的东西）**没有 `new` 点**；
- `tasks.status = 'BUDGET_PAUSED'` **没有任何写入方**（`dispatch.ts` 的边表、
  `today.ts` 的阻塞清单、`driver-pump.ts` 的可选状态都在**读**这个状态，没人写它）
  ⇒ 驱动器那一支是空转的，`serve/driver-pump.ts` 文件头自己承认；
- 真正生效的是 `underTaskBudgetSql`：**预 spawn 的候选过滤** —— 超预算的想法
  不再是候选，出现在 `blocked[]` 里，不暂停任何东西。

⚠ 一个容易顺手做错的细节：`budgets.limit_cents` 是**第一次写入时冻结的**
（~~`ENSERT_TASK_BUDGET_SQL`~~【round272 名字没了】那条 `ENSERT_BUDGET_SQL` 是
`ON CONFLICT DO NOTHING`），所以那个门读的是
**命令行参数**当上限、读 `budgets` 当已花。这条已经写在 `charter-pump.ts` 的注释里，
任何「改成读表里的 limit」的改动都会**静默改变语义**：老任务的上限会变成它第一天那个数。

**目标。** 越界之后有一件**可观察的事**发生：任务停在一个明确状态，卡片真的送达，
`GET /today` 那一格不是恒 0。

**动作。**
1. **先解状态机，别硬停。** `graph/status.ts` 只给 `BUDGET_PAUSED` 一条**入边**
   （`IN_REVIEW → BUDGET_PAUSED`），所以从 `IN_PROGRESS` / `DECOMPOSING` 硬停
   **没有合法落点**（`engine/runtime.ts` 注释里就是这么登记的，缺口在 0041 §7）。
   ⇒ 这一步**要 CEO 拍板**：要么加合法入边（改状态机 = 改规格），
   要么把「硬停」重新定义成「不再 spawn 新轮次 + 把等待这件事写成一张卡」而状态不动。
   **本篇推荐后者**：它不改状态机，且「不 spawn」正是今天已经真实生效的那个门。
2. `BudgetPaused` 这个事件先**真的发出来**（今天零发布点）。~~事件不需要状态机配合，
   可以独立于第 1 步做完，且做完就能被 `today.ts` 读到 ⇒ 阻塞那一格当场不再是恒 0。~~
   ⚠ 【round272 复测：后半句的前提不成立，别按这句话排工期】`GET /today` 的
   `blocked` 计数走的是 `overview/today.ts` 的 `BLOCKED_SQL`，它是
   `SELECT COUNT(*) FROM tasks WHERE status IN (...)` —— 读的是【任务状态】，
   不是事件表。⇒ **只发事件而不写状态，那一格一个数都不会动**。
   「事件不需要状态机配合」这半句仍然对（发事件这件事本身合法），
   错的是它后面那个「⇒ 读到」：验收 (1) 会绿，验收 (2) 恒 0 照旧。
   ⇒ 这一条的可观察性【完全依赖第 1 步】，不是独立的。它从「可以独立做完」
   降级成「做完也看不见」；真要单独做，价值只在审计流水里多一行，
   而那不构成 CEO 看得见的「有一件事发生」。
3. `hard_stop` 那一列：要么给它一条能写 0 的路（那才是「开关」），
   要么**删掉这一列**。当前形状（恒 1 + 没人读 + 读它就能造出恒真判据）是三种里最坏的。
   ⚡ **2026-11-19：第一支落地了**（写入口在 round272 之前就有 `PUT /budget`，本轮补的是**读方**）：
   `underTaskBudgetSql` 现在读它 ⇒ `hard_stop = 0` 的那一格超预算不禁 spawn，五条 SQL 同源共用它。
   ⚠ 这一发**没有**解动作 1，也**不要**读成「O7 有停了」：动作 1 要的是「任务停在一个明确状态、
   `GET /today` 那一格不再是恒 0」，那需要状态机（CEO 拍板）；本轮做的恰好是它的反面语义 ——
   这一列说的是「**不许**停」，今天它真的能说不停了。验收那三条仍全红（一条 `BudgetPaused`
   都没发过，见动作 2）。能红的判据在 `packages/hub/test/budget/hard-stop-gate.test.ts` 十发，
   外加 `.workbuddy/round309-mutate-hard-stop.mjs` 六发变异（命中 6/6、逐字节回滚）；
   其中 M4 那一发**全绿**，量出来的是 `COALESCE(hard_stop, 1)` 那个兜底值今天不是承重的
   （没有预算行时两条路径都落到 `0 < 上限`）—— 那一格是登记的射程余量，不是判据。

**验收。** 一条端到端：把某任务上限设成低于一次真实开销 ⇒ 断言
(1) 出现一条 `BudgetPaused` 事件、(2) `GET /today` 的 `blocked` 计数 +1、
(3) 该任务**此后不再被 spawn**。今天三条全红。
**第 3 条是这条优化的本体**，前两条只是让它可见 —— 别在第 1、2 条绿了就签收。

#### O8 一张组织图，不是一个常量加一张表 🟠

**现状。** 见 §2 轴三第 3 条。补一条：`org/commit.ts` 的变更提交是**真的**
（`POST /org`，HMAC + 仅回环，变更前强制 `VACUUM INTO` 快照），
`bindings/im.ts` 的角色绑定也是真的（`verified = 1` 才解得出，重绑同一条语句里清 verify）。
**组织侧的写路径全在，缺的是「新角色有名有姓有料」那一段** —— 也就是 O2。
【round279 改口：**这句话只对「已有节点」成立。**`revalidate` 只按 `reparent | add_edge`
两个 kind 分派，落库的却是请求体那张图 ⇒ **一个新节点从没被任何判据过手**（能随一条无关的
`add_edge` 拿 200 进库，连 `model_family` 缺着也照进）。所以缺的是**两段**：契约里加一个带判据的
`add_node`（本节完全没登记这一格），与 O2 那段空壳。证据与本仓实测见下面「验收」段的 round279 注。】

**目标。** CEO 在界面上加一个角色，那个角色**当天就能被派活**，不需要改代码重编译。

**动作。**
1. 把 `NODE_TO_TEMPLATE` 从「代码常量」降成「默认数据」：装载顺序改为
   先读组织图 + 岗位书，`preset` 只在库为空时兜底。
2. `ops.yaml` 进装载表（或删）。
3. `role_charters` 播种（O2-2）是这件事的**前置**：没有它，加出来的角色是空壳。
4. `roles/loader.ts` 的 `mergeForbiddenForRun`（合并「禁止动作」）零调用方 ——
   新角色能声明禁止动作而没人合并 ⇒ 接在 O6 的安全层上，不单独接。

**验收。** 一条端到端：`POST /org` 加一个角色 → 播种它的岗位书 →
`hub:engine` 能把一个任务 handoff 给它 → 它的提示词里**出现它自己的验收标准**。
最后那半是**必须判的**，否则这条测试只证明「名字进了图」，
而名字进图这件事今天的 `preset` 也能给。

> 【round279 实测：这一条已经写出来了 —— `packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts`
> （7 发，全绿；变异 `npx tsx` 不需要，跑 `node .workbuddy/round279-o8-acceptance-mutate.mjs`，
> 六发变异 M1–M6 各打中预测那一发、跑完逐字节回滚）。**它红着说不通的一件事，正是本节没写的**：
> **第一跳今天结构上不存在 —— `POST /org` 提交不了一个新角色**，而本节把「写路径已经有了」
> 当成了前提。三条独立证据（一~三发各钉一条，都是真装配 + 真 HMAC + 真备份）：
> ① `orgChangeSchema` 是 `reparent | add_edge` 的判别式 union，`.strict()` 挡着第三种形状，
> 连「一条 `add_edge` 捎带一个 `node`」都过不了 schema；
> ② `commitOrgGraph` 落库的是**请求体里那张图**，而 `revalidate` 只按那两个 kind 分派
> ⇒ 「图里多带一个新节点」随一条**与新节点无关**的合法 `add_edge` 提交能拿 **200**，
> 全程没有一条判据过手那个节点（本轮实测：它连 `model_family` 都没有也进了库）。
> **这不叫「加了一个角色」，这叫一条缺判据的旁路** —— 旁路进来的角色会在运行时卡在
> `unknown_model_family`，而 §18.3 三关对它一条都没跑；
> ③ `packages/web/src` 与 `packages/desktop/src` 里 `add_edge` / `reparent` **零出现**
> ⇒ 没有任何界面发得出组织变更，「CEO 在界面上加一个角色」今天连请求都没有出口。
> ⇒ 所以这一族的修法不是「把播种接上」，而是**先给契约加一个 `add_node` 变更类型并为它立判据**
> （那属改契约，本节原先把它轻描成「组织侧的写路径全在」—— 那句**只对已有节点的两类变更成立**）。
> 后三跳是真走得通并已判过的：播种（真 CLI、真库、退 0）→ 新任务钉在提交后那版图上、
> 引擎把活 handoff 给一个**不在 `NODE_TO_TEMPLATE` 里**的角色 → 那一轮经 `dispatch → runTurn`
> 递出去的身份提示词里有**它自己那条**标准（断言抓在 harness 收到的那一份上，不是我自己调 `rolePrompt`）。
> 反空转按 §7 第 6 格的警告做成**两个角色的对照**：`data` 名字进了图但没播种 ⇒ 提示词里是
> 「hub 里【没有你的岗位书】」、一条标准都没有；`translator` 同一条链播过 ⇒ 标准进来了。
> 另有一发**前提自证**钉住「这两个名字不与任何模板文件名 / 预设节点名相同」——
> 名字一旦撞车，那条对照会悄悄变成假绿，红因登记在这一发里。】
>
> 【round292 改口：上面那一整段里，**② 那一发已经翻向了**，另两条证据原样成立。
> `everyNodeDeclaresModelFamily`（`packages/contracts/src/org/validate.ts`）在
> `commitOrgGraph` 开事务【之前】逐节点判 after 图 ⇒「它连 `model_family` 都没有也进了库」
> 那句【不再真】，现在那条请求是 422、零新版本、库里零残留。
> **本节正文那句「组织侧的写路径全在」仍然只对已有节点成立，而「契约里缺一个带判据的
> `add_node`」这一格【仍然没补】** —— 本轮补的是「旁路必须有判据」，不是「加一个 add_node」。
> 三个容易读错的地方：① 声明了 `model_family` 的新节点随一条无关 `add_edge` **照样进库**
> （那发反向 canary 钉它），所以别读成「不能通过请求体加角色」；
> ② 这条判据判【整张 after 图】而不是「这次新增的节点」—— 后者恒真，理由与变异证人 M6
> 见 §7 第 18 格；③ 它代价是**一张历史上缺家族的图会让此后每一次提交都红**，
> 直到那次提交把家族声明补上（登记在同一格的"挡不住"那一段）。
> 判据本体 6 发在 `test/org/validate.test.ts`，提交侧 3 发在 `test/org/versioning.test.ts` ⑥，
> 变异 `node .workbuddy/round292-mutate-org-node-criterion.mjs` 命中 7/7（含一发【该绿】）。】
>
> 【round295 改口：**上一段那句「另两条证据原样成立」里的 ③ 是假的，而且它不是过期。**
> ① 属「过期」（round294 那天被自己亲手改假），③ 属另一族 —— 它**从写下那天起就没被验过**：
> `packages/web/public/app.js` 从 2026-11-11（`git log -S` 追到 `2bcbdb0`）就在真发
> `kind: "reparent"`，而那发证据的扫描**根**只有 `web/src` + `desktop/src`、**扩展名**只筛
> `.ts`/`.tsx` ⇒ 真控制室**根本不在它的视野里**，于是它连着六轮**绿着**替「零出口」作证。
> ⇒ ③ 现在读作：`{reparent: [packages/web/public/app.js], add_edge: [], add_node: []}`
> —— **界面发得出 `reparent`**，"连请求都没有出口"那句不再真。
> ⚠ 仍然别读成「O8 第一跳通了」：desktop 侧 `channels.ts` 明确不给那条 POST 通道
> （「提交那条 POST /org【没有】通道：self-escaping CEO 写」），浏览器里真点一次在本机无证据（0039）；
> 本轮新增那一发钉的是「`api("POST", "/org"` 那一行还在」，是**最接近那格**而不是浏览器证据。
> 教训与代价见 §7 第 22 格。】
>
> 【2026-11-19 补（round310）：本节**验收**那句今天多了一条**走界面真用的那两个写入口**的证据
> —— `packages/hub/test/acceptance/new-role-via-http-to-its-own-criteria.test.ts`（5 发全绿；
> 变异 `node .workbuddy/round310-mutate-o8-http.mjs` 命中 5/5）。它补的是**分工缝**：
> 仓里那份 O8 验收（`new-role-to-its-own-criteria.test.ts`）逐字走了同一句验收，但第一跳提的是
> `kind: "add_edge"`（新节点随一条无关的边捎带进库，那份文件头自己写着「旁路」）、第二跳是
> CLI 播种器 `runSeedCli` ⇒ 它证的是「播过种 + 节点在图上 ⇒ 标准进提示词」。而
> **`POST /org` 的带判据 `add_node` 与 `POST /charter/:roleId` 这两个界面上 CEO 真点的写入口，
> 此前没有任何一条测试串进同一条 O8 链**。今天串上了（真 WriteQueue / migrate / HMAC /
> `buildHubDeps` / `commitOrgGraph` / `saveCharterVersion` / engine dispatch），
> 反向对照同一条链、只差第二签没签：`translator` 那一轮读到它自己那条哨兵标准，
> `data` 那一轮只有 `NO_CHARTER_LINE`。
> **射程不含**：CLI 播种（另一份文件判）、前端点击（本机无浏览器/Electron，界面那格停在
> 「`app.js` 发得出载荷」）、标准被**门控执行**的形状（属 gates 那族）、非回环 401（`charter-route.test.ts` 判）。
> ⇒ 所以上面 ③ 那句「别读成 O8 第一跳通了」**原样成立**：desktop 侧 `channels.ts` 仍不给那条
> POST 通道，浏览器里真点一次仍无本机证据。这一发推进的是「链在【旁路 + CLI】下通」→
> 「链在【HTTP 两个写入口】下通」，**没有**推进到「界面上点过了」。
> ⚠ 两台读数里如实记下的是**变异机报出来的**，不是推理：① M4 摘掉 `real-deps.ts` 的
> `charterWriter: o.queue` ⇒ 全仓**只有**这份新文件的正题红 ⇒ 那条装配行此前**零读者**；
> ② 同一发下，新文件那发「没接 `charterWriter` ⇒ 501 且库里零行」的装配负对照**照样绿** ——
> 负对照防的是「装配白给成功」，**防不了「装配根本没接」**（已写进那台机器的文件头）。】


---

### D 层 · 让 CEO 真的一个人扛得住

规格 §2.3 的北极星是**「80% 以上审批由规则自动决定」**。今天的读数：**0**，
而且代码里那句注解（`overview/today.ts`）已经说明白了：
**「自动通过 0 项」的含义是策略引擎今天没有生产调用方，不是「没有可逆决策」。**
⇒ 这一层的四项**不是优化，是让那个北极星第一次变成可测量**。

#### O9 自动批准：691 行判据，0 个调用方 🔴

**现状。** `policy/auto-approve.ts` 的规则本身是自洽的，而且是**fail-closed 的**：
黑名单 → `policyDecide` 禁 → **R3 不可逆短路** → R1（只读 + `evidence.ok` + `gate.passed`）
→ R2（可逆 + 历史 0 次拒绝 + 至少 N 次同类批准）→ 否则 `require_approval` 并**点名缺什么**
（`missing[]`）。它甚至有 `CLAIM_APPROVAL_FOR_AUTO_SQL`，把 `decided_by` 写成
`policy-engine` 而不是 `ceo` —— 也就是说「这是机器决定的」在审计里**可区分**。

零调用方。~~而且~~ 【round269 这一句过期】读路径有读者（`approvals/query.ts`
的影子判定，落地块在本节末尾），写路径仍零调用方。R2 的输入 `SimilarHistory` **由调用方提供**，唯一能算它的
`countSimilarApprovals` 读 `approvals.approval_type`，而那张表今天没有可比的历史
⇒ **即便接上，R2 也一定走到 `require_approval`**（这条不是缺陷，是数据还没长出来，
但必须在接之前说清，否则接完看到「还是 0」会以为是接错了）。

**目标。** 规则每天在真的审批上跑一遍，先**只报不批**，攒出读数，再放开阈值。

**动作。**
1. **第一阶段不放开权限**：`autoApprove` 接进审批读路径，算出「规则会怎么判」，
   落审计（`decided_by = "policy-engine"` 那套字段留给第二阶段），
   界面上并排显示「规则判：R1 通过 / 缺 evidence」「人判：批准」。
   **这一步不改任何决定**，改的是能否测量。
2. 攒够样本后再放开 R1（只读 + 证据 + 门控三条都真），**R2 继续只报**。
3. **不可逆那一档永远不进自动批准**（R3 已经短路了，别去动它）。
   这一条要有测试钉住，因为它正是「为了达标而放松」的那个动作的目标位置。

**验收。** 两条，方向相反，缺一不可（本仓的「反向配对」纪律）：
- 「存在一条被自动批准的审批」——今天红；
- 「存在一条**不可逆**审批被自动批准」——今天绿，**并且必须永远绿** ⇒
  它的身份是阴性样本，不是成绩。

**别当成做到了。** 「自动批准上线了」和「自动批准率 80%」是两件事。
后者是北极星，而它取决于**有多少审批落在 R1 的形状里**，
那是产品事实（有多少只读、带证据、门控全绿的决策），不是工程能调出来的数。

⚡ **动作 1（阶段一）与动作 3 已落地（round269）；动作 2（放开 R1）没动 —— 它等的
是读数，不是代码。** 落点：`approvals/query.ts` 的 `policyShadowOf` 给每张卡算一条
**影子判定**，随 `GET /approvals` 的视图带出（`policy_shadow`），控制台在卡片上并排
显示「规则判：…」。边界三件事各有一条判据钉着，全部有变异证据
（`.workbuddy/round269-o9-shadow-mutate.mjs`，三发全杀）：
- **只报不批**：`recordAutoApproval`（改卡片 + 署 policy-engine 的写路径）在 src 里
  仍零调用方 —— r7 主张随之翻窄（「无生产调用方」→「无生产**写者**」，判据从
  dead-modules 基线换成扫 src 找 `recordAutoApproval` 调用；基线两条按方向 B 摘除，
  与 `approvals/timeout.ts` 那一格同一剧本）。验收第 1 条「存在一条被自动批准的审批」
  今天红，且它是**该红**。
- **不可逆那一档不经过估算**：卡片带显式 `irreversible=true` ⇒ 短路在 summary 子串
  估算**之前**直接 `blocked_by="irreversible"`。验收第 2 条「必须永远绿」的凭据是这条
  短路 + 变异 M2（短路失效 ⇒ 红），不是「子串表恰好认得」。其余卡的 tier 由
  summary 走子串表 —— 那是**估算**，界面文案与判据注释都这么写。
- **三格前置如实报缺**：evidence/gate 今天没有每卡出处（正是 O5 的缺口），影子判定
  就把 `evidence_missing`/`gate_missing` 原样报出来 —— 阶段一要攒的读数本来就是
  「差哪一格」。**别把它读成「R1 全仓通不过是我接错了」**。

#### O10 审批超时：值在库里，没有执行者 🔴

**现状。** `DEFAULT_TIMEOUT_HOURS = 8` 写 `timeout_at`，
`TIMEOUT_BEHAVIORS = auto_approve | auto_reject | escalate` 在契约里。
**此前没有任何代码扫 `timeout_at` 并采取行动**（`cards.ts` 文件头、0026 §3
都是这处缺席的记录，`patrol.ts` 那句更正记着「展示 ≠ 执行」）。

> ⚡ **落地块（round265）。** 执行者已补上，见下文；剩动作 1 / 3 未动。

**落地（round265）。** `packages/hub/src/approvals/timeout.ts` 补上执行者，
对外只暴露 `runTimeoutPass(w, readDb, nowMs, publish)` 一个入口：
- `auto_reject` ⇒ status='rejected'；`auto_approve` ⇒ status='approved'。
  两条都是【条件 UPDATE + 一条 system 审计，同一事务】—— actor 是
  `timeout-executor`（system），**绝不署 human**（验收第 3 条），
  与 applyDecision 同一条并发纪律（changes===0 时不写审计）。
- `escalate` ⇒ 原卡保持 pending，**新建一张 escalation 卡**（card_key =
  `timeout-escalate:<原卡id>` 去重），事件是 ApprovalRequired 不是 ApprovalDecided。
- 行为取值非法（旁路数据）⇒ 数进 `skippedInvalid`，不假装什么都没发生。

**动作 2 拒建判据**（O9-3 姐妹判据）：`insertCard` 现在检查
`timeout_behavior === "auto_approve" && irreversible === true` ⇒ 抛错不建卡。

**动作 1（心跳接线）round268 已落地**：`serve/assemble.ts` 的心跳 job 里
`runPatrol` 之后调 `runTimeoutPass`（纯 SQL、无模型调用，await 在那里安全 ——
章程泵那条「别 await 180s 起草」的禁令对它不适用）；它【不】吞错：与 runPatrol
同一处置照抛，下一跳心跳会再撞同一发。dead-modules 基线格如约摘除（那条注释
设计的死法），r2 主张翻向「接线必须在场」（判据：assemble.ts 不含 runTimeoutPass( ⇒ 红）。
行为层另有一发：`assemble.test.ts` 预置到期卡 ⇒ 首轮心跳后 status=rejected、
actor=system、events 一行。两层各配一发变异，红因不同且互为盲区——拔接线 ⇒ r2 红；
nowMs 传 0（接线文本在场而到期不发生）⇒ r2 绿而行为发红（`.workbuddy/round268-o10-wire-mutate.mjs`）。
**动作 3 的会议落点仍未动。** 验收句「端到端：到期状态
真的变 + events 一行 + actor 非 human」由 `test/approvals/timeout.test.ts`
（9 发）+ 三发变异证据钉住（actor→human 红 / 去掉到期判定红 / 拒建反向红，
`.workbuddy/round265-o10-mutate.mjs` 可重跑）。

#### O11 不可逆审批的「一次一签」🟡

**现状。** `http/tokens.ts` 有 `isIrreversibleApproval`，而且是 fail-closed 的
（参数为空 / 形状坏 ⇒ **判成不可逆**，这个方向是对的）；
`tokens.ts` 的拒绝码里有 `already_used`、`approval_mismatch`、`irreversible_denied`
⇒ **一次性令牌的形状已经在了**。缺的是把它接到每一次真决定上，
以及**移动端只能决定**这件事目前没有界面（见 O13）。

**动作。** ① 决定路径统一过 token 校验（现在部分路径直接接受决定）；
② 把「不可逆 ⇒ 必须一次性令牌」写成一条 arch 判据，形状照
`dependency-boundary` 那种「缺 import 就红」。
⚡ 动作 2 已落地（round267）：`test/arch/irreversible-token.ts`（判据）+
`.test.ts`（8 发）。形状与「缺 import 就红」有一处**刻意的偏离**，记在这儿：
被绕开的不是一个 import，是四族各不相同的防线（兑换烧票 / R3 fail-closed /
建卡拒建 / CLI 物理在场），所以判据是**双向名单**——写「卡片被决定」的文件、
`approveCard` 的调用方，两处都必须逐个登记且**每条带非空 why**（这一路的凭据），
特征串消失也红。名单不是豁免表：加条目必须同时论证凭据。
动作 ① 的诚实口径：远程路径【已经】统一（serve 的 decide 只有兑换成功才落库，
不可逆在签发侧 403 根本签不出票）；CLI `hub decide` 不过票，
它登记的凭据是【CEO 坐在终端前 + 仅回环】——把它也改成必过票是产品决定，未做。

**验收。** 变异：绕过 token 校验直接调 `approveCard` ⇒ 必须红。
⚡ 已按句执行：合成一发 `[engine/evil.ts] await approveCard(...)` 判据红
（`irreversible-token.test.ts` 变异段第一条），判据自身四发变异全杀
（`.workbuddy/round267-o11-token-mutate.mjs`）。

#### O12 IM 绑定的最后一公里 🟡

**现状。** 身份那一半**是活的**（`bindings/im.ts` 由 `http/bindings.ts` 挂四条路由，
HMAC + 仅回环；没有 `--ceo` 参数时路由直接 **501** 而不是悄悄接受；
平台白名单 `feishu|wecom|qq` **故意比** `ChannelPlatform` 少一个 `fake`，
让测试频道造不出真身份 —— 这个设计判断是对的）。
频道那一半：`channels/abstraction.ts` 1001 行、~~**对外零 import**~~、
~~**仓库里没有任何一个真的 IM 适配器文件**~~，而 `handleInbound` 的最后一跳是注入的 `deps.act`，
~~**没人提供它**~~ ⇒ 回信进来会返回 `{kind:"failed", why:"装配未提供 act 落库点"}`。
另外 `makeChannelActorResolver`（把 `channelId` → 平台 → 角色的那座桥）零调用方。
⚡ 上面最后那两句在 round280 之后**过期了**（`channels/approval-bridge.ts` 提供 `act`，
resolver 有了第一位读者），原文按口径留着。~~**「没有任何一个真的 IM 适配器文件」照旧成立** ⇒
桥今天从任何生产入口都走不到，见下面动作 1 的落地块。~~
⚡ 这半句在 round281 之后也过期了，而且是整段现状里最后过期的一半：
`packages/hub/src/channels/feishu.ts`（真适配器）+ `packages/hub/src/serve/im-channels.ts`（装配点）
+ `serve/assemble.ts` 的 `boot()` 每轮心跳派发一次 `pollRound()` ⇒ 桥从生产入口**走得到**了。
`dead-modules` 基线里那两条（`channels/abstraction.ts`、`channels/approval-bridge.ts`）
如约变红并已摘除 —— 那两条登记的死法就是这个，红行点名要改的正是上面这几行。
⚠ 上面那句「1001 行」与 §1.2 那张表同一个毛病：**它是那一次量的数**，round282 现量 1018 行。
行数这种东西没有机器判据（doc-refs 守的是【被引用的那一行内容】，不是总数），
所以它的正确修法不是改数字，是**别把行数当主张读** —— 它只用来估计「这一层有多厚」。

**目标。** 手机上点一下，卡片真的被决定。这一条是本仓四原则里的「移动端只做决定」，
**也是这套东西能不能真的「一个人用」的分水岭**。

**动作。**
1. 先接**桥**（`makeChannelActorResolver` → 决定路径），它两端都在仓库里。
   ⚡ 已落地（round280，`packages/hub/src/channels/approval-bridge.ts`）：一次装配交出
   `actorFor` / `loadCard` / `act` 三格。三条判断记在这里，因为它们都不是显然的：
   ① `verified` 那一格**不在桥里判** —— 判据只有 `resolveBinding` 一个入口、
   没有 `includeUnverified` 开关，复制一份就是造第二个事实源（round272 那族同形）；
   ② 审计 `actorId` 写**绑定的那个角色**、`actorType` 仍是 `human`
   —— 换的是【谁】不是【是不是人】，照抄 HTTP 那条路的 `ceo` 才是这里真正会发生的坏写法；
   ③ `act` 落库前**再判一次不可逆**（复用 `isIrreversibleApproval`）。抽象层 `handleOne`
   已经判过一遍，但 `act` 是导出函数、装配方可直调 —— O11 的凭据必须跟着这一路自带，
   不能引用别人路上的一道门（`APPROVE_CARD_CALLERS` 登记的就是这件事）。
   ⚡ 射程已变（round281）：~~桥今天**从任何生产入口走不到** —— 动作 2 没做，全仓没有真 IM 适配器，
   所以 `dead-modules` 基线里那一格是登记过的半成品，动作 2 那天它如约变红。~~
   动作 2 已做，桥在 `boot()` 的心跳里可达，基线那两条已摘。
2. 再写**一个**真适配器。选一个，别写三个 —— 0009 那批依赖里
   `@larksuiteoapi/node-sdk` 的账现在能不能付，先复跑一次安装再定（本篇已证明
   网络这件事的判断过期了，见 §1.3；**不要**沿用「装不上」这个旧结论）。
   ⚡ 已落地（round281，`packages/hub/src/channels/feishu.ts` + `packages/hub/src/serve/im-channels.ts`）。
   四条判断记在这里，因为它们各自都有反面：
   ① **拉而不是推**。Hub 默认只绑回环（0027），飞书的 webhook 回调在这里**物理上进不来**，
   所以适配器只能自己去读（`pollOnce()` 每轮心跳一次）。抽象层那条"接口上没有 `onMessage`"
   本来就排除了第二条入站路径，这一条让它连"想接也接不了"都省了。
   ② **通道起不来 ⇒ Hub 照起**。`Channel.start` 写的是"失败必须抛"，而处置权在编排层：
   手机上批不了 ⇒ 看板、心跳、任务全停，是把一个动作的故障升级成整机的故障
   （同 `unavailableGraphFor` 那条：抛在**这个动作**上，不抛在**进程**上）。
   不抛的另一半是**必须说出来**，每一轮重试一次而同一原因只说一次。
   ③ **入站那一轮走派发，不 await 在心跳 job 里**。写下这条时那发外网 HTTP【没有自设 deadline】
   （⚡ round284 补了，见下面那段；但**这条判断今天仍然成立** —— 一发有上限 ≠ 一轮有上限），
   await 会走 timer.ts 那条"上一轮心跳还没结束，本轮跳过" ⇒ 停滞检测与每日备份被一次
   飞书请求停掉，不计 `consecutiveFailures`、不触发 `onFatal`、不退进程（0044 量过的那个
   静默形状换了凶手）。第四个 `InFlightWatch` + 关机 `settle` 是同一条路。
   ④ **入站只能从 `runtime.pollAll()` 进**。装配层不自己 drain 适配器队列 ——
   那正是 `Channel` 接口头反对的"第二条入站路径"，只不过这次长在编排层。
   ⚠ 没做的两件里，第一件在 round284 补上了：那发 fetch 现在【有】自设截止
   （`FEISHU_FETCH_TIMEOUT_MS` = 10s，`AbortSignal.timeout`，取 token / 读消息 / 发卡
   每一发各挂一个）。三条读法上的坑，都比"接上了"这句话值钱：
   · **一发有上限 ≠ 一轮有上限。** 一轮最多是 1 次取 token + N 页读 + 1 次发卡，
     乘积可以越过心跳下界 60s。这一格【可接受】只因为上面那条 ③：超轮占住 watch
     与后面的轮次，不冻结心跳 —— 谁把派发改回 await，这条豁免立刻失效。
   · **适配器交出信号，但管不住注入实现读不读它。** 装配方交一份忽略 `init.signal` 的
     实现（真接 SDK 那天完全可能），超时就在结构上失效而【没有任何一发会红】。
     默认实现读了，也真测过；注入那半边只有注释拦着 —— 别把这条读成"整条路被管着"。
     ⚠ 但**"没有任何一发会红"这一句只管外部注入那半边**：round286 把它反过来打了一次
     （`.workbuddy/round286-mutate-egress.mjs`：让默认实现自己不再转发 `init.signal`）
     ⇒ `feishu-http.test.ts` 那发⭐「挂住的服务器」**会红**。所以仓里这一条路是有读者的，
     没读者的只有"别人写的那份 `fetchImpl`"那一格 —— 这两半别再一起说成"没人管"。
   · **它不改变"一轮挂多久"的处置**：超时只是让那一轮【一定会结束】，
     失败仍然走原来那三档说话（同一原因只说一次）。
   ⇒ 这一格现在【有】机器判据：r18。剩下那一件仍未做：`knownRoles` **不注入**，
   与 `http/bindings.ts` 同一条口径（0030 §8 那个缺口没补之前，
   给一个"看着像"的集合会悄悄把新增角色判成不存在）。
   ⚠⚡ **round282 补的第二条边界，比上面两件都沉**：上面那句"已落地"当时的**射程被高估了**。
   ① 适配器文件头与 `FEISHU_SHAPE_EVIDENCE` 都写着「字段变了红的是 `feishu.test.ts`」，
   而**那个文件当时不存在** ⇒ 那张形状表没有读者，漂移会一路绿到真发请求那一刻（round282 补了 40 发）；
   ② 更糟的是轮询那一路【当时是空转的】：`messageToEnvelope` 把读到的回传标成 `kind:"text"`，
   运行时第①步把每一条批准判成 `ignored_not_action`，而 `summarize` 对那一档**刻意不说**
   ⇒ 审批人从手机点了批准，Hub 一行日志都不打。所以"回得来"这句在 round281 只对
   长连接那一路成立（那条走 `cardActionToEnvelope`，它标对了 kind），轮询那一路回不来。
   这两条都不是新缺口，是**旧主张的射程写宽了** —— 记在这里而不是只记在 r16，
   因为读 O12 这一节的人未必会去读 O14 那张表。
3. `handleOne` 那条链的顺序**别动**（鉴权在任何库读之前、频道级 `canAct` 在幂等键之前、
   失败路径每条都 `seen.delete(key)`）—— 这段是我在这次调研里读到的**最正确**的一段代码，
   接上就行，改了就危险。
4. **发卡那半边（`deliverCard`）仍然零生产调用方**，而 round281 之后它变成了这条链上
   【唯一】的缺口 —— 手机上现在真的能回批了，于是"回得来而推不过去"是主症状，
   启动横幅已经把它说出来（`imBannerOf` 的最后一档）。
   不在本轮顺手接的理由是它需要先回答一个**没有答案的问题**：一张 pending 卡送到哪条通道、
   **送过没有**。后一半需要一个【跨重启】的投递台账，而库里今天没有那张表
   （本轮没造一张 —— 没有台账就每轮重发，等于每 60 秒给审批人推一张重复卡，
   那比不推更坏，因为它把人训练成忽略这张卡）。
   ⇒ 动作 4 的前置是"投递台账"那一格（含它的迁移与幂等键），不是"多调一次 `send()`"。
   ⚠ 这一格【今天没有机器判据】：`dead-modules` 只看模块级，而 `channels/abstraction.ts`
   已经活了；`deliverCard` 这个函数零调用方今天只由人读的对账条目守着
   （`test/arch/zero-producer.test.ts` 的 `other` 档）。别把那一条读成"有守卫守着 deliverCard"。

   ⚡ **round283：动作 4 落地了，上面那句"仍然零生产调用方"从此是历史。** 三块按顺序：
   ① 迁移 `0009_card_delivery_ledger.sql` 就是那句前置 —— 幂等键是主键
   `(approval_id, channel_id)` 本身，不是"顺便建的一个索引"（先查再插的判据不是判据，
   同 0024 / 0025）；② `channels/deliver.ts` 是那张表的第一个写方，也是 `deliverCard`
   的第一个生产调用方；③ `serve/im-channels.ts` 的 `pollRound()` 每轮心跳在**判完回传之后**
   扫一遍 pending。顺序不是随手排的：反了会把审批人刚在手机上批掉的那张卡在同一轮里再推一次。
   **三条读法上的坑，都比"接上了"这句话值钱：**
   · **顺序是"先抢台账再发"，不是"先发再插"。** 两种都会失败，而可修复性不对称：
     先发再插 ⇒ 发送成功而 INSERT 失败 ⇒ 下一轮**再推一张**（重复卡伤的是人对系统的信任，改不回来）；
     先插再发 ⇒ 有行而没送到 ⇒ 这张卡**永不自动重推**，要人显式 `clearDeliveriesFor`。
     选后者是"宁可要一个看得见的漏推，不要一个看不见的轰炸"。⚠ 这是本轮最该被反驳的决定。
   · **台账读不出"到没到人手里"。** 成功与发送失败在这一张表里【都是同一行】（失败不回滚，
     回滚就等于下一轮再推）。那一格只有日志答，而日志跨不过重启 —— 0009 文件头写的是这个，
     它原来写的是相反的一句（"失败的尝试没有行"），那句是我在定顺序【之前】写的。
   · **外键违例会抛，`INSERT OR IGNORE` 不吞它**（本轮探针实测：主键撞 ⇒ `changes` 0，
     外键违例 ⇒ `FOREIGN KEY constraint failed`）。我第一版在这里写的是"两种都是没落地"，
     那是一句没测的推断。差别有后果：一张在扫描后被删的卡会让 claim 的 promise reject，
     接不住就带走整轮投递。而**唯一能测到它的位置**是 `supportsActionReturn` 那个 getter
     —— 它正好读在"卡已读到、台账还没落笔"那一瞬；第一版测的是"发送期间删卡"，
     那一发读起来像测到了，其实删在下一张卡的【读】之前，`failed` 恒为 0。
   ⇒ 这一格现在【有】机器判据了：r17。上一段那句"只由人读的对账条目守着"随之过期，
   `zero-producer` 那条 `other` 登记随横幅改词一起删（守卫如约红 = 它设计的样子），
   `OTHER_COUNT` 7 → 6：**方向是从"人记得看"迁到"拆掉就红"**。
   · 实测读数：`test/channels/deliver.test.ts` 17 发（真库真迁移），打在 `deliver.ts` 上
     六发变异 M1 顺序翻向 ⇒ 红 10 / M2 摘 FK ⇒ 红 1 / M3 摘 OR IGNORE ⇒ 红 3 / M4 未注册
     通道不抛 ⇒ 红 1 / M5 失败抹行 ⇒ 红 2 / M6 不可逆不推 ⇒ 红 1；装配层另加 4 发
     （`serve/im-channels.test.ts` 现 31 发），打在 `im-channels.ts` 上四发 A1 发卡挪到判决
     之前 ⇒ 红 4 / A2 装配层不调它 ⇒ 红 6 / A3 摘掉"没起来就不推"那道门 ⇒ 红 2 /
     A4 失败那句不再说怎么重推 ⇒ 红 1（两份脚本各自自回滚 + 逐字节核对，
     `round283-mutate-deliver.mjs` 与 `round283-mutate-imch.mjs`）。
   · **仍然没有机器判据的那一格要说出来**：`not_routed`（多于一条通道时干脆不推）今天
     【没有活的分母】—— `assembleImChannels` 里 `channels` 恒为一条，装配选项上没有插
     第二条的口。硬凑只能直接调 `runDeliverPass` 塞两条，那是测【函数】而装配那一支
     管的恰恰是【装配】。⇒ 不凑，登记在这里 + r17 射程 ②，别把它读成"有测试守着"。
     那一天先补的是路由表（库里没有任何一列说「这张卡走哪条通道」）。

**验收。** 端到端：假频道投卡 → 模拟一次带合法签名的回信 → `GET /approvals`
里那条真的变成 `approved`，且审计行 actor 是绑定的那个角色而不是 `system`。
⚡ 已实测（round280，`packages/hub/test/acceptance/im-reply-approves-card.test.ts`，12 发）。
三处读法上的坑值得记：`GET /approvals` **默认只列 pending**，所以「批准之后再看一眼」
走默认那一页读到的是空列表 ⇒ 必须指名 `status=approved`；而验收句那句「不是 `system`」
单独写成断言对【照抄 `ceo`】是绿的（两条生产决策路径写的都是 `ceo`），
所以那里三条一起断（等于绑定角色 ∧ 不是 system ∧ 不是 ceo）+ 一发两绑定换角色。
第三条是变异教出来的：`M2`（把角色读取换成裸 `SELECT ceo_role`）**第一轮是空变异**——
走运行时那发 pending 绑定抓不到它，因为 `actorFor` 自带的那道门挡在 `act` 前面。
⇒ 「未验证绑定不算身份」这一格**必须有一发绕开通道层直调 `act`** 才算被测到，
现在那发在场，M2 红 2 发。

---

### E 层 · 让这一切一年后还读得懂

#### O13 交付形状：1183 行原生 JS 的控制台，和一条没人点的按钮 🟡

**现状。** `packages/web`（1183 行 `app.js` + 158 行 HTML，零依赖）与
`packages/desktop`（1557 行，`package.json` 里**没有任何 electron 依赖**）。
根脚本表**没有 `dev` / `start`**，起 Hub 是 `hub:serve` + 自签开发服务器（`dev-sign.ts`）。
路由面：`create_task` / `list_tasks` / `get_task` / `today` / `list_approvals` / `decide` /
`mint_token` / `events` / `replay` / 四条 binding / 两条 org。
**界面能建任务、能批卡、能改一条汇报关系** —— 这三件事是真的。
缺的具体一格：**§7.4 那个「终止任务」按钮在全仓任何一张边表里都没有合法目的地**
（15 个状态里没有终止态；`dispatch.ts` 文件头明写「不是没写，是没有合法的目的地」）。

**动作。**
1. 加 `pnpm dev`。**这条最不像优化，但它是「别人能不能用」的第一道**：
   一个需要记住 3 个 verb + 2 个 flag 的项目，在非作者机器上的采用率是 0。
   ⚡ 已落地（`packages/hub/src/serve/dev-entry.ts`，Hub + 看板一条命令起）。
2. 终止态：**先拍规格**（加 `TERMINATED` 状态 + 它的入边表），再写按钮。
   顺序反了就会做出一个「点了什么也不发生」的按钮 —— 而那种按钮比没有按钮坏。
   ⚠ 未动：状态机加态是规格决定，留待 CEO 拍板（本篇 2.2 轴一那张边表谁都不许先动）。
3. `desktop` 那 1557 行：要么补依赖变真，要么明确标成「IPC 契约层，非可运行 App」
   并把它从「桌面端」这个说法里摘出来。**第三态（像在做而没在做）是最贵的**。
   ⚡ 已落地（round265，选【标诚实】这条：electron 本机装不上是 wire.ts 文件头
   记过的既有决策，补依赖不在可控范围）。落法是**标注 + 双向守卫**，不是只写注释：
   `packages/desktop/src/index.ts` 文件头挂「IPC 契约层，非可运行 App」标注，
   `test/arch/desktop-honest-label.ts`（判据）+ `.test.ts`（7 发，含反向对照）双向判 ——
   假包被摘标注 ⇒ 红（回到第三态）；补了 electron 依赖或根入口脚本而标注还在 ⇒ 红
   （假谦虚，且逼着变真那天同步改本节）。「变真」口径取两条并集，宁松勿紧。

**验收。** 一条**全新机器**上的冒烟：`pnpm i && pnpm dev` → 浏览器打开 → 建一个任务 →
看到它进收件箱。今天这条**跑不起来**（没有 `dev`）。
⚡ 动作 1 落地后该冒烟的口径改为：`pnpm i && pnpm dev` 到看板可用（`dev-entry.test.ts`
钉的是各阶段与失败出口）。~~浏览器那一发今天仍要人眼~~ —— 那半已收进
`test/e2e/o13-dev-smoke.spec.ts`（Chromium 真点「扔个想法」的提交、看板真读到这张卡、
今日页读数从 0 变 1；8 发变异 8/8，台账 0070）。「全新机器」的 `pnpm i` 那一头仍没复现，
而「进收件箱」那一跳要章程泵、由 `test/e2e/ceo-loop.spec.ts` 钉 —— 两句合起来才是这句话。

#### O14 断言的保质期：把「零调用方」和「过期主张」变成会红的东西 🔴

**现状（本篇认为这是投入产出比最高的一项）。**
这次调研**最费时间的部分不是读代码，是分辨哪些话还成立**。§1.3 那三条过期主张，
每一条都曾是真的、每一条现在都在误导下一步，而**全仓 108 个测试文件没有一条会因为
它们过期而红**。同一形状在本仓已被治过一次（0056 那一篇整篇讲的就是
「一条读起来像证据的判据」），但那一次治的是**哈希坐标**，
**「零调用方 / 装不上 / 没有读者」这一族主张没有守卫。**

而这一族的失败模式是**双向**的，两个方向都在本仓出现过：
- **主张过期说没有，其实有了**（§1.3 那三条）⇒ 浪费下一次调研去找已存在的东西；
- **主张过期说有，其实没了** ⇒ 更坏，因为人会照着一个不存在的防线做决定。
  `packages/hub/src/channels/abstraction.ts` 与 `harness/*` 的注释里那句
  「全仓零命中」若哪天变成有命中，**不会有人知道**。

**目标。** 「X 零调用方」这句话要么机器可判，要么从文档里消失。

**动作（三条，按性价比排）。**
1. **死模块哨兵**（新守卫，`test/arch/dead-modules.test.ts`）：
   维护一张**基线名单**（今天那 9 个 + `harness` 整目录），
   **双向判**：名单外的模块若零 importer ⇒ 红（新写的死代码不再能混进来）；
   名单内的模块若**有了** importer ⇒ 红（逼着那个人同时把主张改掉 —— 这一半是关键，
   它让「接上了」这件事强制回到文档）。
   判据复用 §1.1 那个解析器，**必须**排除 `new Worker` / 动态 `import()` / CLI `spawn`
   的入口，否则 O1 会造出两条假红（本仓 `pending-inventory` 的**双向**判据是现成先例）。
2. **主张登记表**：把文档与注释里所有「零 X」类断言抽成结构化条目
   （主张 + 判它的方法 + 上次核对时刻），入口文档渲染那张表。
   **注意 `docs/review/README.md` 那条家规：入口文档里不写会漂移的数** ——
   所以表里放的是**判据**和**核对时刻**，不放条数。
3. 本篇自己先受这条约束：§1 那张表里的数全部标了「口径 + 复算方法」，
   §8 明说它们的保质期。

**验收。** 两个方向的 canary，缺一条这条守卫就不算立：
- 新建一个零 importer 的模块 ⇒ 红；
- 给 `harness/verifier.ts` 加一个 src 内的 importer ⇒ 红（并且报「去更新那条主张」）。

**⚠ 第 1 条已落地（本篇写下之后），落地时改了三处判据 —— 都以本篇为准。**
`test/arch/dead-modules.ts`（判据）+ `.test.ts`（21 发，两条方向的 canary 都在）。
差异记在这儿，因为**这篇的正文还停在落地前**：
- 判据是**从入口不可达**，不是「零 importer」。§1.2 那两条坑（worker 假阳性、
  `harness/` 互相 import 把彼此伪装成有人用）在判据里分别是
  `dynamicEntryTargets()`（从 `selfWorkerUrl(import.meta.url)` **推**，不写死名单）与
  可达性闭包本身。**结果 20 个**，不是 §1.1 那个 11；两个口径的差就是 §1.2 第 2 条
  说的那一族，测试里有一条专门钉这个差值不为零。
- 入口**从根 `package.json` 的 scripts 推**，不维护名单。
- 基线 20 条，**每条带一个全仓唯一的特征串**（照 `verify-open-invariants.mjs`
  那条「豁免表逐条被数据约束」的家规）⇒ 符号被删掉，那条豁免当场失效。
  其中 `index.ts` / `main.ts` 两条是**有意占位不是缺口**。
- 第 2 条（主张登记表）**已落地**（`test/arch/claims-registry.ts` 数据 + `.test.ts`
  守卫），渲染在文末「O14 主张登记表」一小节 —— 表里只放**判据与核对时刻**，
  不放条数（`docs/review/README.md` 家规：入口文档不写会漂移的数）。
  第 3 条（§1 那张表标口径）**round293 落地**：`test/arch/census.ts`（测量脚本，
  `npx tsx` 跑）+ `census.test.ts`（12 发，含「解析器退化成零条边立刻红」与
  「unresolved 不是写死的」两枚反向 canary）。
  ⚠ 落地时**第一次真复算，§1.1 那四条数全部对不上**（83→92 / 35216→40871 /
  108→135，而「11」看着没变其实是**另一批成员**）—— 读数与三条口径坑记在 §1.1 那块 ⚡。
  这一格原先那句「仍停在正文模板，未单独展开」是**对的**，它缺的不是口径而是
  **一条能跑的命令**；本篇 §8 与这里两处「已经标了复算方法」的说法，
  在 round293 之前都是把「写了口径」当成「给了方法」。
  这句「现在有了」本身也是一条会漂移的主张，所以**round293 落地并登记为 r20**
  （判据核的是脚本在场、仍复用那张图、悬空说明符仍会抛、排除入口那一格还在、
  两枚反向 canary 还在 —— 它**不跑**那个脚本，理由写在判据注释里）。

**不做会怎样。** 下一次调研（无论是我还是别人）会把 §1.3 那三条重新当成事实，
然后基于它们设计优化项 —— 那才是真正贵的地方，因为它**长得像尽职**。

## O14 主张登记表

下面每一条都是「文档或注释里一句『零 X』类断言」的结构化登记：
主张 + 判它的方法 + 上次核对时刻。**判据本身在 `test/arch/` 下跑**，
这张表只渲染方法名与时刻（这正是 `docs/review/README.md` 那条家规：
入口文档里不写会漂移的数 —— 所以表里没有条数列，别按条数列数）。

| 主张 | 判它的方法 | 上次核对时刻 |
| --- | --- | --- |
| **r1** budgets.hard_stop 的【记账路径】写不出 0：记账那几处（tracker 的 DO NOTHING、budget-sync 的 DO UPDATE、dev-seed）hard_stop 全是字面量 1；唯一能写 0 的是 POST /budget 的 upsert（http/budget.ts，绑定参数 = 界面那个「硬停」勾选框），它是登记在 HARD_STOP_BIND_WHITELIST 里的显式软限入口 —— 名单外再多一处绑参写点、或那一处形状变了/没了，判据红。⚡【2026-11-19 补上另一半】那一列今天【有读方】：underTaskBudgetSql 读它，hard_stop = 0 的那一格超预算不禁 spawn（五条 SQL 同源共用那一个函数）。两句合起来才叫开关 —— 写得出一列而没人读是装饰，有人读而写不出是恒真判据。⚠ 射程：它【不判】「读得对」，判的是【那半条字节还在且括号还在】；语义那一格归 packages/hub/test/budget/hard-stop-gate.test.ts 那十发（其中一条【摘掉外层括号就红】，全仓唯一看得见那件事的） | test/arch/claims-registry.test.ts › r1 判据：扫 src 全部 INSERT INTO budgets 的 VALUES（字面量 0 一律红；绑定参数只准名单内那一处，且名单内必须逐字含登记形状；名单外的 upsert 改 hard_stop 也红）；取材非空由同文件真仓库那一发钉住。读侧那一半（hardStopReaderCheck，判【剥掉注释之后】的字节，口径同 r23/r24）：charter-pump.ts 里有 `SELECT b.hard_stop FROM budgets b` ⇒ 没有它红（那一列退回没人读）；收尾那半条 `, 1) = 0)` 逐字在 ⇒ 不在就红（判据方向翻或最外层括号被摘，两种都在这一格响）。外加打在真字节上的变异：写侧四格见 .workbuddy/round309-mutate-hard-stop.mjs（六发、命中 6/6、逐字节回滚；M1b 那一发【只跑旧的三个文件】全绿 = 那三条老测试对 hard_stop 零射程的证据；M4 那一发【全绿】= COALESCE(hard_stop, 1) 的兜底值今天不承重，登记的盲区）。读侧那两格另有合成变异打在【真 charter-pump.ts 文本】上（本文件 r1 读侧那一族，含一发【抹掉代码而只留一句「这里以前读它」的注释】—— 那种形状必须【仍然红】，它是「判剥注释后的字节」与「判原文」两种写法之间唯一的方向证据） | 2026-11-19 |
| **r2** 超时执行者已接进心跳巡检（serve/assemble.ts 的每一跳调 runTimeoutPass，到期卡真的动） | test/arch/claims-registry.test.ts › r2 判据：serve/assemble.ts 必须含 runTimeoutPass( 调用 | 2026-11-17 |
| **r3** `makeChannelActorResolver`（把 channelId → 平台 → 角色的那座桥）的读者在场：channels/approval-bridge.ts 的 actorFor 就是它（round280 之前这条是「零调用方」，判据方向随之翻向「读者必须在场」，同 r2 那次的剧本） | test/arch/claims-registry.test.ts › r3 判据：channels/approval-bridge.ts 在场且调用 makeChannelActorResolver( | 2026-11-17 |
| **r4** BudgetPaused 事件今天零发布点（BudgetTracker 没有 new 点） | test/arch/claims-registry.test.ts › r4 判据：扫 src 里 new BudgetTracker（实例化即发布点） | 2026-11-17 |
| **r5** review_gates 表当年在 src 里零 INSERT（db/integrity.ts 与 role-memory.ts 都这么说过；round358 门 4 接线后 turn-bundle.ts 的 writeGateDecision 成为第一个写入方，该句翻作历史） | test/arch/zero-producer.test.ts › REGISTRY 里的 review_gates zero 条目（双向核对） | 2026-11-17 |
| **r6** src 里没有任何 INSERT INTO approvals（该句是已过期主张的原文，登记为引用） | test/arch/zero-producer.test.ts › REGISTRY 里的 approvals quoted 条目（原文被引用故为 quoted） | 2026-11-17 |
| **r7** policy/auto-approve.ts 无生产【写者】（round269 起读路径有读者：approvals/query.ts 的影子判定调 autoApprove；写者=recordAutoApproval 的调用方仍为零） | test/arch/claims-registry.test.ts › r7 判据：扫 src 除定义文件外对 recordAutoApproval 的调用 ＋ query.test.ts ⑦ 的调用方名单 | 2026-11-17 |
| **r8** harness/ 整目录对外零 import（约 3300 行安全层没有任何 src 内 importer） | test/arch/dead-modules.ts › BASELINE 里 harness/* 四条（双向）；独立判据见死模块哨兵验收 | 2026-11-17 |
| **r9** 岗位书的 acceptanceCriteria / honestyBoundaries / forbiddenActions / decisionScope / judgmentMode / escalationTriggers 有读者：charter/prompt.ts 逐字段渲染，而渲染结果就是 engine/claude.ts 的 --append-system-prompt（读者=提示词，不是执行器） | test/arch/claims-registry.test.ts › r9 判据：charter/prompt.ts 必须逐字段出现 c.<字段> 的属性访问，且 engine/runtime.ts 必须调 renderCharterPrompt( | 2026-11-17 |
| **r10** `pnpm lint`（= verify 的第一段）今天恒红，且红因是既有基线（HEAD 干净树同样红）而非本轮新代码；这一格由一张「只许减不许增」的基线表看着，新增 error 种类当场红 | test/arch/lint-baseline.test.ts › 棘轮判据（合成读数变异）＋真仓库那一发；本条判据只核对那份守卫的档案还在、且还声称管 `pnpm verify`（不重跑 biome，避免两处各测一次互相漂） | 2026-11-17 |
| **r11** 全仓每句指向计划的编号引用都指向计划里真存在的小节；且这条判据的取材必须同时覆盖 docs 的 markdown 与全部 ts —— 只扫代码的那个口径曾漏掉全部 2 处真悬空。⚠ 这里【不抄标题数与引用数】：本轮量到 58 / 1061，而 r10 那一格刚立的规矩是「上限会随修复下调，期望值一定会过期」—— 读数由 plan-refs.test.ts 的分块下限看着，不活在主张里 | test/arch/plan-refs.test.ts › 四发合成变异（P1 哨兵 / P2 前缀匹配 / P3 计划缺失 / P4 静默窄口径）＋真仓库那一半；本条判据不重跑取材，只核对那份守卫还在、且取材里仍有 docs 那一块（口径被悄悄改窄=空壳守卫） | 2026-11-17 |
| **r12** 计划每一条【验收行】点名的工件路径逐字存在（或被一行显式豁免标着）；本轮实测三条 Run 行点名的旧住址【逐字不存在而命令今天全绿】—— 因为 vitest 把参数当子串过滤器而不是当路径。⚠ 同样不抄读数：命中与豁免的数目由 plan-gate-paths.test.ts 钉 | test/arch/plan-gate-paths.test.ts › 五发合成变异 + 三发真仓库；外加打在真文档上的 G1–G4（.workbuddy/round276-gate-path-mutate.mjs，自恢复）；本条判据不重跑 existsSync，只核对那份守卫还在、且还在真的查住址 | 2026-11-17 |
| **r13** `--permission-mode plan` 是今天真的员工身上唯一生效的安全边界，且它由两层独立守卫看着：静态四判据（spawn 点基线 / plan 与 FLAG 的【相邻性】/ 诚实标注在第一行代码之前 / 探针键名单非空）＋一条真起子进程的行为探针【带正向对照】。立它之前的读数：把它改成 bypassPermissions ⇒ 全仓零红。⚠ 三条已知余量写在守卫文件头，不进自动检查：改名 import 的 spawn 扫不出（变异 B5 把它钉成预期绿）、换成 SDK 调用则整条失效、判据只查探针代码在而不重跑探针 | test/arch/role-spawn-boundary.test.ts › 底座一发（好夹具必须【不红】）+ B1–B6 六发合成变异 + 4 发真仓库；外加打在真文件上的五发（.workbuddy/round277-boundary-mutate.mjs，自回滚，含 B5 预期绿）；行为那一发在 packages/hub/test/engine/claude.test.ts，正向对照是它的一半价值；本条判据不重跑子进程，只核对那份守卫还在、相邻判据仍逐格比对、探针键仍逐个核对 | 2026-11-17 |
| **r14** 本登记表自己那些 `source.line` 有人核，且核它在【门禁里】而不只是一个要靠人想起来跑的脚本 —— 立它之前的读数：往 §5 插一段 ⇒ §7 全体下移 35 行 ⇒ r10–r13 四条同时 STALE 而 test/arch 304 发全绿（`renderMarkdown` 不渲染 line ⇒ 那张表「逐字一致」的守卫对坐标是瞎的）。⚠ 已知余量：锚点取主张首行的前 30 个字符，那一格被改写到 30 字以内不同就判漂；同一句话在文档里多处命中时只要求【登记那一格命中】，不判唯一性 | test/arch/claim-coords.test.ts › 真仓库 3 发（逐条坐标 + 取材非空 + 锚点至少一处命中）+ 5 发合成变异；外加打在【真文档】上的三发（.workbuddy/round278-claim-coords-mutate.mjs，自回滚 + 逐字节核对）：C1 往 §5 插一行 = 本轮真发生的形状 / C2 换掉锚点句 / C3 掏空判据（真仓库那一发【不红】）；本条判据不重跑坐标核对，只核对那份守卫在场、那句比较还在、非空那一发没被摘掉 | 2026-11-17 |
| **r15** 【round294 撤回本条的标题】原标题「`POST /org` 提交不了一个新角色 —— 契约里没有带判据的 `add_node`，而落库的是【请求体那张图】」—— 现在【提交得了】了，契约里有 add_node，落库前逐条判过（见 r22）。留下这段话是因为它记的是一件比「主张过期」更贵的事：本条的判据在翻转之后【照样全绿】，而它绿的原因换了 —— 它变成了一个假证人。【round292 改口，那时无效的是后半句】原文接着写「`revalidate` 只按 `reparent` 与 `add_edge` 两种 kind 分派 ⇒ 一个新节点随一条与它【无关】的合法 `add_edge` 提交能拿 200 进库，全程没有判据过手它」—— 那句在 round279 那天是真的，round292 起【不再真】：`everyNodeDeclaresModelFamily` 在开事务前逐节点判 after 图。【round294 再改口，那次无效的是①】它们当时写着「① 契约里确实没有带判据的 add_node（形状没变），③ 两个前端零出口（没变）」—— ① 被本轮自己亲手改假了。【round295 再改口，这次无效的是③，而且它不是「过期」是【假证人】】「两个前端零出口」连着六轮【绿着】，而 `packages/web/public/app.js` 从 2026-11-11（`git log -S` 追到 2bcbdb0）就在真发 `kind: "reparent"` —— 那发证据的扫描根只列了 `web/src` 与 `desktop/src`、扩展名只筛 `.ts`/`.tsx`，真控制室【不在它的视野里】。⇒ 【round308 再改口，这次翻的是名单本身】那句「界面发得出 reparent」下面点的两份空名单已经不空了：`{reparent:[app.js], add_edge:[app.js], add_node:[app.js]}`，发的人仍然只有 `packages/web/public/app.js` 一个（round308 实测三种 kind 各只有一份文件写着带引号的字面量）。⚠ 它仍然【不】等于「O8 第一跳通了」：`POST /org` 那条通道在 desktop 侧被明确拒绝（channels.ts 那句「提交那条 POST /org【没有】通道：self-escaping CEO 写」），浏览器里点一次更没有本机证据（0039）。⚠ 现在准确的形状仍然是【旁路还在，但它不再是无判据的旁路】——声明了 model_family 的新节点随一条无关的 add_edge 照样能进库，那发反向 canary 钉的就是这一格。别把它读成 O8 第一跳通了，也别读成「现在不能通过请求体加角色了」（那是让实现层替 CEO 关掉一条产品目标）。 | packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts › 11 发（① 契约形状【round294 翻向：现在钉的是 add_node 那一支【解析得通】+ 三种捎带形状解析不通】 / ② 旁路现在被拦 + 反向 canary 只差 model_family 就该 200 / ③【round295 翻向、round308 换名单：正向点名每种 kind 由谁发 —— 三种 kind 都只有 web/public/app.js + 引号形状 + 扫描器自身的反向 canary + 『构造了载荷』≠『发得出去』那一发】 / 正题三跳 / 加节点成功那一发 / 六种坏形状逐条 code + 零残留 / 缺家族由继承拦 / 反空转对照 / 前提自证 / 占位串因果）；test/org/validate.test.ts › 「everyNodeDeclaresModelFamily」那 6 发（含反向 canary：非边端点也判）+ 本轮新增「L1 validateNewNode：加一个新节点」那 13 发（含⭐重名抢在自环之前 / ⭐森林 / ⭐与 model_family 不重叠 / ⭐空图那条通过不是「永远通过」），另有 schema 那一节的⭐登记一条【没判的】：键 ≠ role_id —— 它记的是【另一维】（形状层放行），不属 L1 那一节，别按 13 发去找它）；test/org/versioning.test.ts › ⑥ 那 3 发（拒绝零残留 / 与 L1 的顺序 / 反面对照）。round279 那六发变异（.workbuddy/round279-o8-acceptance-mutate.mjs）里 M3 打的是【旧世界】，round292 另跑 .workbuddy/round292-mutate-org-node-criterion.mjs 七发：M0 控制 / M1 摘掉提交路径的采纳（红 2 发 2 文件）/ M2 判 before —— 【该绿，变异等价，当时那句话写的是「两种 kind 都不碰 model_family」，round294 起这句话的前提变了，矩阵里留着它就是为了那天它会翻红】/ M3 丢 trim / M4 理由不点名角色 / M5 退回只判边端点 / M6 「只判新增节点」那个看着更精准的恒真版本 —— 命中 7/7；本轮另跑 .workbuddy/round294-mutate-add-node.mjs（打在 add_node 那一族生产字节上）；round295 跑 .workbuddy/round295-mutate-frontend-egress.mjs 六发【打在 app.js 与 web/src 的真字节上】：M0 控制（行尾空注释，该绿）/ M1 reparent→add_edge（红 1 发 1 文件）/ M2 摘掉那次 api("POST","/org") 调用（红）/ M3 kind 改带尾空格 ⇒ 三种 kind 谁都不落（红，只有它能证「空名单会红」）/ M4 注释里写【带引号的】"add_edge"（红 = 射程边界）/ M5 同一位置写【不带引号】的 add_edge（该绿）—— 命中 6/6，证据 .workbuddy/round295-frontend-egress-mutation-evidence.txt。⚠ M4/M5 那一对是本轮【我自己的预期被推翻】的地方：第一版把边界写成「注释里提到 kind 名就红」，跑出来 0 红 —— 真口径是【两侧带引号才算发这个变更】，那发因此是空变异。矩阵里「该红/该绿」的预期也是主张，它没有自证，只有跑出来的红绿分布能打它。⚠ 本条判据【仍然只核对那五格字节】（验收测试在场 + 反空转那一格 + 前提那一格 + 前端取材表【成员点名】+ 名单那三格【逐字对账】），它【不核对】「契约里没有 add_node」—— 一句否定式主张只要留在判据里，被推翻的那天它不会红，它会继续绿着替那句假话作证。本轮就是那一天的现场。⚠ 第五格是 round308 补的，补的是【同一条坑的另一半】：round295 把主张换成正向清单，却没给那份清单配读者，于是它又绿了六轮才在名单翻向的当天假一次 —— 「把否定式换成正向点名」本身不是修复，点名有人对账才是。round308 的读者三发（之七 放宽成空 / 之七·乙 切片外留诱饵注释 ⇒ 仍红 / 之八 止锚改名 ⇒ 红在边界）外加【顺序】一发（之九：名单坏 + 取材空 ⇒ 红因必须落「不可信」，不许名单抢报）；之九 的供电另打一台（.workbuddy/round308-mutate-r15-order.mjs：把兜底短路成 false ⇒ 之九 翻红且红因=名单抢报，命中 3/3、自回滚逐字节核对）—— 顺序那种缺陷逐格单看全对，只有短路一遍才知道那发是不是恒绿。磁盘侧另有 .workbuddy/round308-mutate-r15-roster.mjs 五发打在【那发验收测试的真字节】上（命中 5/5，证据 .workbuddy/round308-r15-mutation-evidence.txt）；⚠ 那台第一版只读文件名、把「传得进判据」写成了「答不出哪一格」，改成逐条读【用例名】重跑才发现只对了一半：M1/M2 点得到之七本体，M4 只红在控制组上 —— 原因是诱饵抢在 replace 的锚点前面把变异自己中和了。【打在真字节上的矩阵】与【打在合成语料上的】各有一种自我中和的方式，这台要完整分辨率还欠「mustRed 逐条点该红那发」（round300 口径）。【round312 落地】：.workbuddy/round311-mutate-r15-roster-fullres.mjs 已建已跑（机器自证 5/5，打盘 3/5、逐字节回滚；M3/M4 点不到名=点名器读 FAIL 行用例名的可观测面，不是判据失灵 —— 那份机器的文件头与 round312 台账有逐字记录）。「登记未做」不再是今天的形状。「契约里那条路还在、还在真调判据」那一格从此由 r22 负责，口径不同、判据也不同 | 2026-11-19 |
| **r16** 一次带合法签名的 IM 回信【真的】落成一次决策：卡片 approved，且审计行 actor 是绑定的那个角色。⚠ 射程（round282 改过一次）：桥（channels/approval-bridge.ts）从生产入口【走得到】了 —— boot 每轮心跳经 serve/im-channels.ts 装配真飞书适配器并派发一次入站，dead-modules 基线里那两条（abstraction / approval-bridge）如约变红并已摘除；0030 §0 那句「actorFor 是可选钩子且今天没人传」因此过期。但本条主张的是【这条链接通了】，不是【线上有人在用手机批卡】，两样还缺：① 真飞书接口在本机一次也没打通过（要真凭据），本条全部绿都绿在注入的 fetch 上；② ⚠ round283 更正：这里原本还写着「发卡那半边（deliverCard）仍零生产调用方 ⇒ 今天的形状是回得来、推不过去」—— 那句随 O12 动作 4 落地而【过期】，投递台账见 r17。剩下的缺口换了位置：一条通道以上没有路由依据，且投递台账答不了「到没到人手里」。⚠ round282 顺带修掉一条【本篇之前就在的】真 bug：轮询读到的回传曾被标成 kind:text，运行时第①步把每条批准判成闲聊而 summarize 对它刻意不说 ⇒ 手机上点了批准，Hub 一行日志都不打。那条 bug 说明 r16 此前那句「链通了」只对长连接那一路成立，轮询那一路当时是空转的 | packages/hub/test/acceptance/im-reply-approves-card.test.ts › 12 发（主链路 + 状态边同源 + 广播 seq=events.id + 重投只算一次 / 反空转四发：pending 绑定走运行时、未登记通道、直调 act + pending 绑定、决策前重查被撤权 / 装配形状四发：无身份不落库、不可逆卡直调也拒、loadCard 脏参数、两绑定换角色）；packages/hub/test/serve/im-channels.test.ts › 31 发（装配层唯一分母：缺 env ⇒ absent 而 Hub 照起 / 起不来 ⇒ 每轮真的重试且只说一次 / 读失败后【真的】补读 / 端到端把卡批掉 / 判决翻成人话 / 溢出与关机）；packages/hub/test/channels/feishu.test.ts › 40 发（适配器纯函数与形状：kind、入队闸门、时间窗、渲染三种「不知道」、value 上限、凭据不进错误串）；外加打在【生产代码】上的十发变异：round280 那四发打在桥上（.workbuddy/round280-o12-bridge-mutate.mjs，M1 actorId 退回写死 ceo ⇒ 红 4 发 / M2 角色判据换成裸 SELECT ceo_role ⇒ 红 2 发，且【只有】绕开通道层直调 act 那一发抓得到 / M3 摘掉落库前不可逆 ⇒ 红 1 发 / M4 摘掉决策前重查 ⇒ 红 7 发）+ round282 那六发打在适配器与装配点上（.workbuddy/round282-o12-adapter-mutate.mjs，同自回滚 + 逐字节核对）：M1 kind 退回 text ⇒ 红 8 发 / M2 摘掉入队闸门 ⇒ 红 3 发 / M3 水位无条件提交 ⇒ 红 1 发 / M4 水位只推进被收下的那条 ⇒ 红 1 发（⚠ 第一次跑【全绿】：夹具时间戳顺序让两种写法读数相同，判据因此是补对的）/ M5 错误串带上凭据 ⇒ 红 2 发 / M6 notes 不排空 ⇒ 红 4 发。本条判据不重跑那 83 发，只核对：两份验收/装配测试在场、actor 那三条断言一条不少、桥里那两格（重查角色 + 判可逆）还在生产代码里、装配层测试仍提 actorFor、适配器测试仍正面断言轮询信封的 kind | 2026-11-17 |
| **r17** 发卡那一路接上了生产入口，且重复投递由【库里那一行】挡：迁移 0009 的 `card_deliveries` 以 (approval_id, channel_id) 为【主键】（不是唯一索引 + 自增 id），`runDeliverPass` 每张卡先 `INSERT OR IGNORE` 抢台账、抢到才发请求，而 `serve/im-channels.ts` 每一轮心跳在【判决之后】调它一次 ⇒ `deliverCard` 从「有定义、零生产调用方」翻向有读者、有幂等键。⚠ 射程三条：① 台账答不了「到没到人手里」—— 抢台账与发送失败都留下同一行，只有日志答得出那一格而日志跨不过重启；② 多于一条通道时【干脆不推】并把理由说出来，因为库里没有任何一列说「这张卡走哪条通道」，路由表是那一天要先补的东西；③ 顺序翻向（先发再插）是这条链最省事的坏写法，代价是每 60 秒给审批人重推一张重复卡 | packages/hub/test/channels/deliver.test.ts › 17 发（真库 + 真迁移：投出去 / 第二轮一行都不重发 / 两通道各一行 / 非 pending 不推 / 发送失败【仍然】留行 / 未注册通道当场抛 / 扫描后删卡 ⇒ 接住 FK 且台账不留行 / 重启后幂等 / 四档计数互斥 / summarizeDeliver 每档都说话）；packages/hub/test/serve/im-channels.test.ts › 装配那一格 4 发（pending 卡真的 POST 出去并落一行台账 / 第二轮一次都不发而屏幕也不重复那句话 / 判决在前⇒同轮刚批掉的卡不推 / 平台拒收时台账那一行【留着】且那一组说清怎么重推）。⚠ `not_routed` 那一档今天【没有活的分母】：装配选项上没有插第二条通道的口（channels 恒为一条），硬凑只能直接调 runDeliverPass 塞两条 = 测函数而不是测装配。所以那一格今天仍只有「三档都必须说话」这条纪律 + 人的复查，别把它读成「有测试守着」。外加打在【装配层生产代码】上的四发（.workbuddy/round283-mutate-imch.mjs，同自回滚 + 逐字节核对）：A1 deliverRound 挪到 pollAll 之前 ⇒ 红 4 / A2 装配层根本不调它 ⇒ 红 6 / A3 摘掉「这一轮没起来就不推」那道门 ⇒ 红 2 / A4 失败那一句不再说怎么重推 ⇒ 红 1。外加打在【生产代码】上的六发（.workbuddy/round283-mutate-deliver.mjs，自回滚 + 逐字节核对）：M1 顺序翻向先发再插 ⇒ 红 10/17 / M2 摘掉 FK 那一支 ⇒ 红 1 / M3 摘掉 OR IGNORE ⇒ 红 3 / M4 未注册通道返回零计数而不抛 ⇒ 红 1 / M5 发送失败抹掉台账行 ⇒ 红 2 / M6 不可逆卡不推 ⇒ 红 1。本条判据不重跑那 21 发，只核对：迁移里那条外键与那一对主键还在、deliver.ts 里【抢台账在发请求之前】这个先后关系成立、INSERT OR IGNORE 没被摘、FK 那一支还在、装配层仍调 runDeliverPass 且排在 pollAll 之后、投递测试在场且仍实测 FK | 2026-11-17 |
| **r18** 那一发外网 HTTP【一定会结束】：`FeishuChannel` 给每一发（取 token / 读消息 / 发卡）挂一个 `AbortSignal.timeout(fetchTimeoutMs)`，缺省 `FEISHU_FETCH_TIMEOUT_MS` = 10s，而 `FeishuFetchInit.signal` 让注入实现看见【同一个】截止 ⇒ 「一次挂在半路的外网请求把 watch 占到进程退出」那一格翻向「到点就 reject，由原来那三档说出为什么这一轮没读到」。⚠ 射程三条：① 一发有上限 ≠ 一轮有上限 —— 一轮最多 1 次取 token + N 页读 + 1 次发卡，乘积可越过心跳下界 60s，那一格【可接受】只因为入站走派发而不是 await；② 适配器交出信号但【管不住注入实现读不读它】，交一份忽略 `init.signal` 的实现（真接 SDK 那天完全可能）就让这一格在结构上失效而没有任何一发会红（round286 量过它的【反面】：默认实现自己不转发 signal ⇒ 那一格【有】一发会红，所以 ② 只覆盖【外部注入方】，不覆盖仓里这一条路）；③ 畸形值（0 / 负数 / 非有限数）回落到缺省值而【不是】关掉超时 | packages/hub/test/channels/feishu-http.test.ts › 9 发。A 组打在【默认实现】上：一个【接受连接但永不应答】的真本地 socket ⇒ 抛、抛的那句里没有 app_secret、且耗时落在 [100ms, 5s) 这一带（时间下界反空转：「根本没打出去就抛了别的东西」同样满足前两句）；正对照一发证明秒答的服务器一切正常。B 组钉适配器：取 token 与读消息【两发都】带未失效的信号、翻页那三发【各】一个信号（共用一个 = 第二页被第一页的时间杀掉）、注入实现读了信号 ⇒ 到点 reject 而 supportsActionReturn 仍是 false。C 组钉那个数：交 40ms 就到点 / 交 0 与什么都不交都是「信号在而 200ms 内没到点」（两个读数而不是一个布尔，否则「0 = 关掉超时」与「回落到 10s」分不开）/ 负数 NaN Infinity 同样回落。外加打在【生产代码】上的四发（.workbuddy/round284-mutate-timeout.mjs，自回滚 + 逐字节核对）：T1 摘掉取 token 那一发的信号 ⇒ 红 7 / T2 摘掉 #call 那一发的信号 ⇒ 红 3 / T3 一轮共用一个信号 ⇒ 红 1 / T4 把 0 当成关掉超时（畸形值不再回落）⇒ 红 2。外加 round286 打在【真·网络出口】上的一发（.workbuddy/round286-mutate-egress.mjs，自回滚 + 逐字节核对）：E1 让 `defaultFetch` 不再转发 `init.signal` ⇒ 红 1（`feishu-http.test.ts` 那发⭐「挂住的服务器」）—— 这一发是射程 ② 那句【反面】的证据。顺带把「绊线数文件不数调用点」这一格量清了口径：hub/src 里真·网络出口只有一处（`fetch(` 不带接收者），另外两处 `fetch` 是调注入实现 ⇒ 复算见 `.workbuddy/round286-egress.mjs`，别抄这个数。⚠ 那条【通用】绊线的口径：hub/src 里调 `fetch(` 的文件必须自己也构造 `AbortSignal.timeout(` —— 它数的是【文件】不是【调用点】，「同一文件里一发挂了一发没挂」这一格读不出来，那一格由判据点名管住今天这两处。本条判据不重跑上面那些（9 发测试 + 5 发变异），只核对：常量与畸形值判据在场、带截止的调用点不少于两处、契约上有 signal 成员、那份测试在场且仍开真监听并接 init.signal、以及那条通用绊线没有新的 offenders | 2026-11-17 |
| **r19** 测试语料从「整体在类型检查射程外」翻向「有一张【按目录】的上限表看着」：`test/arch/test-type-baseline.ts` 用 `.workbuddy/tsconfig.tests.json` 真跑一次 tsc，把每条错归到它所在目录，逐目录判「不许超过登记数」⇒ §7 第 13 格那句「刻意不接成门禁」不再是今天的形状，而清零是【目标状态】不是入场券。⚠ 射程三条：① 它【不让】`pnpm typecheck` 变绿（那是 r10 那条 lint 基线的账）；② 一个语法错会短路整个 program ⇒ 那一刻这一发测的不是完整语料，而语料下限那条哨兵【管不到】这一族（`--listFilesOnly` 在有语法错时照样列全）；③ 它跑在别的测试正在改的工作树上，同一次全量里偶发「少几条」是绿的方向、测不出来；④ ⚠【round300 改口】round296 在那条射程的尾巴上登记「`parseTscOutput` 那一侧的仓外路径没有单测，它红在『新目录』上」—— 前半句对，后半句【只对了一半】：绝对式（`E:/other/repo/…`）确实红，但 `../` 式【不红】，它被 `toRepoRelative` 剥掉前缀后归成一个地道的仓内目录 ⇒ 那些错【花掉本仓那个目录的配额】，实测把 TYPE_BASELINE 每一格按 `../<该格目录>/…` 灌满能读出 291 条而 `diffTypeBaseline` 返回空字符串 ⇒ 一次「include 指向隔壁仓」的事故会逐字读出本仓的配额表并宣布合格。那一格今天【有判据了】（两发的错误侧 + 语料侧各一条，七发变异）。留着这段改口是因为它记着一条比它自己更值钱的教训：射程里那句「它的失效方向是红」和「不判 X」同样是【某个时刻按当时看到的形状量的读数】，只量了一种形状就写下方向，会把「已经想清楚了」的错觉传给后面所有人。本轮新射程残留：`test/../other/x.ts` 那种【中间】带 `..` 的混合写法不在判据里（不是 tsc 会输出的形状，登记而不补） | test/arch/test-type-baseline.test.ts › 25 发（round300 现数：23 → 25，加的正是下面那条仓外形状两发）。合成那一半是主力（本文件自己也在被检查的语料里 ⇒ 合成目录一律用仓里不存在的 `synthetic/…`，否则守卫把自己判红）：控制组两发（恰好在基线上 / 比基线少 ⇒ 绿）+「全修干净 ⇒ 绿」那一反恒红控制 + 路径三种写法（Windows 反斜杠 / 绝对 / 相对 / 盘符大小写）归一到同一目录 + 仓外路径不计进语料（unix 式【与】windows 式）及其单变量对照（同位置搬进仓内 ⇒ 立刻计数）+ `../` / `./` / 根自身三种前缀各一发 （round296 补：那三种形状注释一直在吹「实测出来的」而【只有绝对路径那一型有测试】，删掉剥 `../` 那一整行 HEAD 版 20 发全绿 —— 实测过，不是推断）+ ⭐ round300 两发：往上跳的仓外路径不许折进仓内目录（三格：配额侧点名 / 单变量搬回仓内 ⇒ 不报 / 语料侧不计，另带【方向相反】的两条前提自证 —— 坏形状确实长得像仓内路径 + 仓内绝对路径【仍然】归一成功，缺第二条则「raw 里有斜杠就排除」这种恒拒写法也过）+ 仓外三种形状在错误侧【计数而不是丢掉】（同一份路径清单同时喂两个消费者，两种口径各判一次）+ 解析器两发（带位置的行、续行不算新的一发；TS18003 那一型【不带位置】必须计入未解析而不是静默丢）+ 目录配额的四发红（多一条 / ⭐ 总量降而某目录涨 / 基线外新目录 / 新目录藏在已有错后面）+ 配额表被清空仍红 + 空壳豁免报名单 + 基线表自证（无重复、无 0 配额、每条目录现在真存在）。真仓库那一半三发：filesChecked 下限 + unparsed=0 + 退出码与读数自洽，另加「test/arch 自己必须 0 条」，和一发【射程 ② 的实测】：临时 project 里一个语法错 + 三个各带类型错的文件 ⇒ 只报 1 条 TS1109、三条 TS2322 一条不出、而 filesChecked 仍是 4（证明那条哨兵管不到这一族）。外加打在【判据自己】上的六发（.workbuddy/round285-mutate-type-ratchet.mjs，自回滚 + 逐字节核对）：M1 超出判定加 10 条容差 ⇒ 红 2 / M2 基线外目录不再点名 ⇒ 红 3 / M3 dirOf 不归一分隔符 ⇒ 红 5 / M4 解析不出的行静默丢 ⇒ 红 1 / M5 语料下限把 node_modules 也算进来 ⇒ 红 2 / M6 空壳豁免永不报 ⇒ 红 1。外加 round296 那台打在【路径归一 + 仓内判定】上的六发（.workbuddy/round296-mutate-path-normalization.mjs，自回滚 + 逐字节核对，与上一台【分开跑】）：M0 控制组该绿 / M1 仓内判定退回旧口径 ⇒ 红在「仓外不计」那发 / M2 调用点换回旧写法（函数还在而没人调）⇒ 同上 / M3 删剥 `../` ⇒ 红在「三种形状」那发 / M4 不剥 `./` ⇒ 同上 / M5 盘符比较改成大小写敏感 ⇒ 红在「三种写法」那发。外加 round300 那台打在【往上跳的仓外路径】上的七发（.workbuddy/round300-mutate-upward-escape.mjs，命中 7/7、机器自证 6/6，与前两台【分开跑】）：M0 加空注释该绿 / M1 判据恒假 ⇒ 红在新那发 / M2 错误侧调用点退回无条件归一 ⇒ 同上（函数在而没人调）/ M3 语料侧调用点退回只判绝对式 ⇒ 同上 / ⭐ M4 把绝对那一半改成读 raw（读起来【更严】的写法，实际把 unix checkout 的仓内绝对路径整个错排掉）⇒ 必须【红在老那发「只数本仓自己的 .ts」而绿在新那发】—— 这一发同时钉两件事：新判据有效，且它不是靠【一律排除】蒙对的 / M5 反向对照：两个判据换个顺序（语义一字未动）⇒ 该绿，M0 测「加注释不算」而它测「重排不算」/ M6 把这一族【改成用丢掉来修】⇒ 同时红在两发上（那是本轮真的考虑过并否掉的写法：丢掉会把「这个 project 吃进了仓外的文件」读成「那些文件没有类型错」）。⚠ 那台比 round295 那台多读一格：FAIL 行里的【用例名】也读，mustRed 逐条点用例名而不是点文件 —— 点文件的分辨率是一份几十发的文件，里面任何一发红都算命中，而它可能红在别处。本条判据不重跑 tsc（那是那份守卫自己的事，重跑一遍只会让两处口径互相漂），只核对：上限比较 `n > allowed` 还在、`unregistered.push` 那一支还在、空壳豁免那一半还在、测试仍指向那个 project、且那两条反假绿哨兵（语料下限 / 未解析=0）还写着 | 2026-11-18 |
| **r20** §1.1 那张表上那四个读数从「配了一段对脚本形状的描述」翻向「有一条能跑的命令」：`test/arch/census.ts` + `npx tsx` 现读，复用 `dead-modules.ts` 的取材与图，只测量不判定（恒 exit 0，除解析器自报悬空说明符时【抛】）⇒ §8 末「每个数都配了复算方法」与 O14 动作 3「全部标了口径 + 复算方法」这两句，在 round293 之前是【把「写了口径」当成「给了方法」】，现在才逐字成立。⚠ 射程四条：① 本轮第一次真复算，四条【全部】对不上（83→92 / 35216→40871 / 108→135，而「11」看着没变其实是【另一批成员】，换成表上那条口径今天给 7）—— 旧数按「改数就等于伪造那次测量」保留原样，新读数只写在 ⚡ 里；② 它不 assert 任何一个数，所以【数变了这里不会红】，数变了归 dead-modules 的基线管；③ 「排除入口」那条口径读第 ④ 栏，读第 ③ 栏会得到另一个数（今天 11 vs 7）；④ 行数口径是 `split("\n")`，以换行结尾的文件比 `wc -l` 【多 1】（实测 725 vs 724） | test/arch/census.test.ts › 12 发。合成那一半：入口排除的【反向对照】（同一份语料、同一个 solo.ts，标成入口才消失、不标就在 —— 少了这一发「排除入口」可写成 filter(() => false) 而全绿）+ 排除只作用于零 importer 那一栏不改模块数与总行数 + 行数口径钉死（split 比 wc 多 1，第一版我连错的方向都没算对）+ ⭐ 悬空说明符【会】自报（unresolved=1）配真仓库那条 0 —— 证明那个 0 是算出来的。真仓库那一半：取材非空下限 + ⭐【成员】判据（db/write-queue.ts 与 org/commit.ts 必须不在零 importer 里：解析器退化成零条边时名单是【膨胀到 85】而非缩小，只判名单规模抓不到）+ 反向（harness/verifier.ts 仍在）+ 子集算术 + 入口自洽 + unresolved=0 + 测试文件分桶非空。外加打在【census.ts 生产字节】上的六发（.workbuddy/round293-mutate-census.mjs，自回滚 + 逐字节核对，单独跑、不与任何测试并发）：M1 不累计反向边 ⇒ 红 2 / M2 isEntry 恒 false ⇒ 红 3 / M3 underEntries 不排入口 ⇒ 红 2 / M4 unresolved 写死 0 ⇒ 红 1 / M5 lineCount 少 1 ⇒ 红 1 / M6 摘掉 sort ⇒ 【该绿】（12 发里没有任何一条判顺序，这一格是登记的射程余量，记下来是因为【绿的一发】才能证出判据的边界）—— 这一组证的是【census.test.ts 不空转】。另加打在本条判据【输入】上的八发（claims-registry.test.ts，合成语料不碰盘）：控制组一字不改 ⇒ 返回空 / 换掉被 import 的【模块名】⇒ 红在恒真判定 / 摘掉悬空说明符那次抛 ⇒ 红 / 摘掉排除入口 ⇒ 红 / 测试整份不见 ⇒ 红 / ⭐ 摘掉成员判据 ⇒ 红 / ⭐ 摘掉「unresolved 会自报」⇒ 红，其中四发各带一条 not.toContain 排除红因串扰。（r20 之二的第一版抹的是 import 列表里【collectModules 那一行】⇒ 实得【绿】：判据读的是文本在场，而函数体里还有 collectModules(root)。换掉被 import 的模块名才是等价变异 —— 那一发若没被看见，就被记成判据通过了。）本条判据不跑那个脚本（重跑一遍只会让两处口径互相漂），只核对：脚本与测试在场、它仍从 ./dead-modules.js 拿图、悬空说明符仍会抛、排除入口那一格还在、且那两枚反向 canary（成员判据 / unresolved 会自报）还在 | 2026-11-17 |
| **r21** 豁免那份账从【上下界】换成【钉死】，于是它是双向的：多开一道「东西没建」的门 ⇒ 红，最后那条豁免被人静默摘光 ⇒ 也红。round293 第二段量到原写法（`>0` 且 `≤2`）只有上界会响 —— 0 满足 `≤2`，而摘光之后那条红的措辞指错地方（说得像「计划里有个路径写错了」，不像「有人动了豁免」）。外加两处本篇自己的过期「今天」被当面拆掉：§10 第 10 格那三句（`test/e2e/` 不存在 / playwright 不在任何 package.json / 全仓 `*.spec.ts` 零条）**三句全假**，§5.1 Task 4.7 那半句「发卡那一路零生产调用方」**假的**（投递那一跳在 r17 就接进心跳了）。⚠ 射程三条：① 那两处过期是【人肉复测】抓出来的，没有任何守卫判「这句话过期了」—— 能钉住的只有那份账，钉不住散文；② 新读数只证「盘上有 1 个 E2E」，`git ls-files "*.spec.ts"` 今天仍是 0 ⇒「有」与「跟踪了」是两条主张；③ Task 2.9 / 4.7 两道门**依然没过**，本轮只改了「为什么没过」的归因 | test/arch/plan-gate-paths.test.ts › 11 发（本轮 10 → 11）。真仓库那一半新增：计数恰好 1 + 每条豁免必须【真的】豁免掉一条不存在的路径（贴在「路径全都在」的位置上=死的豁免，红）+ 活着的那一条必须点名 mobile-approval.spec.ts（身份钉）。⭐ 合成那一半新增反向 canary：同一份判据、合成语料给两条标记 ⇒ 必须数出两条，配一发只给一条 ⇒ 数出 1（证明那个 2 不是「永远数出两条」）——没有它，一个恒返回「一条」的坏计数器（filter 写成 find / map 前多一个 slice(0,1)）在真仓库那一发上照样绿。外加打在【真文档 + 真守卫字节】上的五发（.workbuddy/round293-mutate-gate-exemption.mjs，自回滚 + 逐字节核对，单独跑、不与任何测试并发）：M0 控制组该绿 / M1 把标记挪到路径存在的 ceo-loop 那格 ⇒ 红 2 / M2 静默删掉最后那条 ⇒ 红 2 / M3 filter 换成恒真 ⇒ 红 1 / M4 只改那一格散文 ⇒ 【该绿】（判据对无关文案不敏感）。那台机器自己错过两次，都伪装成被测对象的错：剥 ANSI 写成 /\[[0-9;]*m/g 少了 ESC ⇒ 汇总行前留着 0x1b ⇒ 报「读不到汇总行」；catch 里无条件走汇总解析 ⇒ 「vitest 没起来」与「读不到汇总」同形、真诊断被吞 —— 这一组证的是【plan-gate-paths.test.ts 那 11 发不空转】。另加打在本条判据【输入】上的七发（claims-registry.test.ts，合成语料不碰盘）：控制组一字不改 ⇒ 返回空 / 守卫不见 ⇒ 红 / ⭐ 摘掉 exemptedBlocks 的 filter ⇒ 红（`includes(NOT_BUILT_TAG)` 在守卫里有【两处】，只判片段会绿 —— 同 r20 之二那条教训）/ 测试不见 ⇒ 红 / 把恰好 1 换回 toBeGreaterThan(0) ⇒ 红 / 摘身份钉 ⇒ 红 / ⭐ 摘掉那发数得出 2 的反向 canary ⇒ 红，其中三发各带一条 not.toContain 排除红因串扰。本条判据不重跑 existsSync、也不跑那台机器，只核对：守卫与测试在场、账还在按字节筛、那枚 toBe(1) 的钉还在、身份钉还在、且那发能数出 2 的反向 canary 还在 | 2026-11-17 |
| **r22** 契约里有一条【带判据的】加角色路径，而它判的东西仍然在两处【不重叠】：`orgChangeSchema` 的判别式里有 `add_node` 那一支 ⇒ hub 的 `revalidate` 对它【真的调用】`validateNewNode`（不是只剩一条注释说它走了 L1）⇒ `applyChangeToGraph` 真的把那个节点【按 role_id 当键】写进 after 图的 nodes ⇒ 而 `validateNewNode` 的【代码】里仍然一次也没出现 `model_family` —— 缺家族由 `everyNodeDeclaresModelFamily` 判【整张 after 图】那一处拦，code 同为 `unknown_model_family`（round294 的 O8 §7 第 18 格那一格自己点名的修法）。⚠ 射程四条：① 本条判的是【结构还在 + 分工没漂】，不判「新节点真能进库」也不判「六种坏形状真拿到 422」—— 那两件事由那发验收测试与 test/org 单测负责；② ⚠ 它【不判】「旁路被关掉」：在请求体图里塞一个声明了家族的节点、变更本身挑一条无关的 `add_edge`，今天【照样能进库】。本轮关掉的只是「那条旁路无判据」，关掉旁路本身需要的是「图必须等于 before 经 change 得到」那条判据，它今天不存在（本轮台账「没做的下一格」）；③ 类型层那格（加第四种 kind 而漏分派 ⇒ `tsc` 红）本条只核对那个兜底【还在】，不重跑编译器；④ ⚠【round299 改口】nodes 的【键】与 node.role_id 不一致这一格，本条登记时写的是「今天没有任何判据」—— 那句话今天【过期了】：orgGraphSchema 上挂了一条 superRefine 在判它，翻向后的事实归 r24 管，别在本条下面找它。当时那句话本身是真的（zod 的 record 不比对键与值里那个 id，rejectMalformed 与 validateNewNode 都不拦），留着这段改口是因为它记着本仓的一条家规：射程里那句「不判 X」是【某个时刻的读数】，X 被关掉时主张要跟着改口，否则下一条主张就建立在一句过期陈述上（r22 自己判的「add_node 那条路带判据」与此无关，那格仍由本条的①–③管） | test/arch/claims-registry.test.ts › r22 判据：读三份【权威落点】、一份都不抄 —— kind 名单只在 contracts 的 schema 里（且只取 `orgChangeSchema` 到 `export type OrgChange` 那一段，不拿整份文件搜 `kind: z.literal("add_node")`），分派与落库只在 hub 的 commit 里，家族那格只在 contracts 的 validate 里。⭐ 判【剥掉注释之后】的字节，三格：① 分派【条件】本身必须是 `change.kind === "add_node"` 而不是被短路成 false —— 「那句调用还在文件里」与「那条分派活着」是两件事，这一格是变异机器 M8 逼出来的（生产字节上端到端当场红而判据【那一版】不红）；② 调用/赋值真的在代码里 （那条主张的原话就是「仍在真调判据，而不是只剩一条注释」）；③ `validateNewNode` 的函数体里读不到 `model_family` —— 那个函数头有三段话在解释「为什么【故意】不判」，看原文的话那些注释会替「判了」投一票、这一格当场恒绿。剥注释用的是本文件私有的 `withoutComments`，它有两个洞，都朝【假绿】：字符串里的 `//` 吃掉同一行的真判据（家族格假绿，同样的字节若落在分派那两格则是假红），块注释里含 `//` 则让那个块【没能在此收尾】—— 懒匹配不停在原地而一路吞到下一个真收尾（heightBelow 的 JSDoc），实测连坐吞掉四条 code 的字节、整条判据隐身。⚠ 后一个洞的方向本轮被我写成过【假红】，是量出来才发现猜错的 —— 登记一个洞之前先把方向量出来。另加打在合成语料上的十六发（claims-registry.test.ts，不碰盘）：三份取材之一不见 ⇒ 红 / 判别式那一段读不到 ⇒ 红（与「kind 被摘」分开报，两种红的修法不同）/ 摘掉 add_node 那一支 ⇒ 红 / commit.ts 不见 ⇒ 红 / ⭐ 把调用换成一句同义注释 ⇒ 红（本条唯一为「只剩一条注释」写的形状）/ ⭐⭐ 把分派条件短路成 false 而调用字节留着 ⇒ 红（M8 逼出来的那一格，配一发【变异后调用字节仍在】的前提自证）/ 让 applyChangeToGraph 不加节点 ⇒ 红 / 把类型兜底换成默认放行 ⇒ 红 / ⭐ 往 validateNewNode 的【代码】里加一句判家族 ⇒ 红，而同样的字节【只写进行注释】⇒ 该绿、【只写进干净的块注释】⇒ 该绿（两发反向对照：行注释与块注释走的是两个分支，一个恒真的判据只要一个分支就够；两发的字节都注在【函数体内】并各带一条位置自证 —— 注在函数头之前 sliceFrom 取不到，那一发就恒绿空转）/ ⭐⭐ 另两发把上面那两个洞【登记】下来（绿的形状本身就是证据）：各配一发单变量对照 —— 只把那两个斜杠拿掉、真判据原样留着 ⇒ 那一发必须红，否则『绿』分不出【洞】与【注入没进切片】/ 摘掉对 after 图那一跑 ⇒ 红 / validate.ts 不见 ⇒ 红 / 定义整段改名 ⇒ 红在【取材】。外加打在【真生产字节】上的九发自回滚变异 + 一发读数自证（.workbuddy/round294-mutate-add-node.mjs，逐字节核对、单独跑、不与任何测试并发；⭐ 它比 round292 那台多两件事：逐文件归因，以及一发【这台机器自己的】反向 canary（喂它一段合成的绿摘要与一段合成的红摘要，逼它数出红发数与那两份文件名 —— 「不该红的文件」这句话的全部价值取决于那个文件集合读得出东西，而一个恒空的集合会让它变成废话））。本条判据不重跑端到端请求、不重跑那台机器，口径同 r12/r13/r21 | 2026-11-17 |
| **r23** 「无门控委派边没人核对」那一格从【登记在文档里】翻向【库里有一条跑在整图上的自检】：`integrity.ts` 的 `CHECK_NAMES` 里有 `delegation_edges_gated` 而 `auditCoherenceReport`的 `guarded` 数组里【真的注册了它】⇒ 那条自检仍在扫【全部版本】的图而不是 `MAX(version)`、仍在读边之前过一次 `orgGraphSchema`（读取口今天全是 `JSON.parse(...) as OrgGraph` 强转）、判的是 `review_gate !== true` 而不是「填没填」，且那条 not_observable 文案仍写着「空表 ≠ 没有写入方」。⚠ 射程五条：① 本条判的是【结构还在 + 分工没漂】，它【不打开任何数据库】—— 那条自检在真库里今天报什么，归 integrity.test.ts 那 7 发；② 它【不判】「脏边进不了库」：写侧那两半（HTTP 信请求体带来的整张图 + `revalidate` 只看增量）今天都还在，本轮只加了读侧的兜底，把本条读成「不能再通过请求体塞无门控边了」是误读（round298 台账「没做的下一格」）；③ 老版本【必须】在射程内 —— 任务盖着自己的 graph_version 读图，把扫描退回最新版是一次【静默降级】：报告 ok 而那个老任务照跑脏图；④ 它不判「审阅真的发生过」，那一格归 author-reviewer / events；⑤ `could_not_run` 不在本条射程内，那条文案区分的是「数据读不动」与「尺子放不下去」，混起来会让一次 schema 损坏读成「这条判据没跑」，而后者不拦启动 | test/arch/claims-registry.test.ts › r23 判据：读一份【权威落点】、一格都不抄 —— 名单与函数体都在 `db/integrity.ts`，本文件不抄 CHECK_NAMES 的全表（抄一份就会在真那份加第 9 条之后继续绿着）。五格全写成【正向：那句话的权威字节此刻在代码里】，判的是【剥掉注释之后】那份（`withoutComments`，洞两条见 r22 的 method —— 这一族的注释比代码长，函数头有整段在解释「为什么故意不判」）。⭐ 三格是【反向】的，即「诱人错法一旦落下就红」：只扫 `MAX(version)` ⇒ 红（M2 那一发）/ 把 `!== true` 换成 `== null` ⇒ 红（M1 那一发：false 是【填了】的值）/ 撤掉 `orgGraphSchema.safeParse` 退回信强转 ⇒ 红（M3 那一发）；另外两格守的是【注册】与【文案】：名单里有名字而 `guarded(` 那行被摘 ⇒ 红（恒绿的自检比没有自检更坏：报告里那一格会一直显示 ok），not_observable 文案里那句假句子回归（「src 里没有任何 INSERT INTO…」）⇒ 红 —— ⭐ 与 M5 同一格，但口径不同：M5 测的是【zero-producer 抓得到】，这里测的是【登记表不许它回来】。两处都抓不是重复：那台读的是「这句话与代码现状对不对得上」，这台读的是「这句话有没有被写回来」。另加打在合成语料上的十四发（claims-registry.test.ts，不碰盘）：取材自证一发 + 控制组一字不改 ⇒ 返回空 + 十二发变异：integrity.ts 整份不见 ⇒ 红 / 读不到 CHECK_NAMES 那一段 ⇒ 红在【取材】/ 名单里摘掉那一格 ⇒ 红 / ⭐ 名单留着而 `guarded(` 那行不见 ⇒ 红（与「摘名单」分开报：那两发的修法相反）/ 读不到函数定义 ⇒ 红 / SQL 退回 `MAX(version)` ⇒ 红 / 门控判据退回 `== null` ⇒ 红 / 撤 schema 那道 ⇒ 红 / 空表那格不再单独成栏（`if (edges === 0)` 短路成 false）⇒ 红 / 假句子【写进代码】⇒ 红 / ⭐⭐ 同一句假话【只写进注释】⇒【该绿】（④ 判剥注释后的字节，这一发是那一格唯一的方向证据：判原文会因为一句诚实的反面教材注释而【假红】。它自带两条前提自证 —— 那句【进了字节】且【在函数头之前】，否则「绿」分不出【注释被豁免】与【锚点没注上】）/ 空表文案不再指名写入方 ⇒ 红；除控制组外每发各带一条 not.toContain 排除红因串扰（八格串在一条判据里，只判 toContain 会把「取材坏」与「主张过期」读成同一句话）。外加打在【真生产字节】上的六发自回滚变异（.workbuddy/round298-mutate-edge-gate.mjs，逐字节核对、单独跑、不与任何测试并发；命中 6/6、机器自证 7/7，证据 .workbuddy/round298-edge-gate-mutation-evidence.txt）：M0 控制组该绿 / M1 门控判成「有没有填」⇒ 红 2 / M2 只扫最新版 ⇒ 红 2 / M3 撤 schema 那道 ⇒ 红 2 / M4 空表混进 ok ⇒ 红 2 / ⭐ M5 把假句子写回文案 ⇒ 红在【另一条守卫】（zero-producer.test.ts 点名 integrity.ts 那一行），而⑤b 那发【全绿】—— 那 1 发全绿是本轮量出来的盲区，矩阵按【用例名】把它点名，并在 ⑤b 的注释里明写「那两行 toContain 不是守卫，只是便宜取样」。⚠ 这台比 round296 那台多两件事：每发变异【自己声明该由哪条守卫抓】（spec 逐发给），以及装载失败那两种读法各带一发自证 —— 第一版用 `语法炸掉` 试「装载失败」而它是【合法标识符】⇒ 运行期才炸 ⇒ 那条「读不到用例名就不造名」的分支【从没走通过】，换成 `@@@` 那种真非法字节才量出读数（`Tests no tests` + 文件级 FAIL）⇒ **一个永远不可能进入的分支就是一句装饰**，它要在【造出那种读数】之后才算被验证。本条判据不打开数据库、不重跑那台机器，口径同 r12/r13/r21/r22 | 2026-11-18 |
| **r24** r22 射程④ 那一格（『nodes 的键与 node.role_id 不一致今天没有任何判据』）从【登记】翻向【schema 判】：`orgGraphSchema` 上挂着一条 superRefine，它遍历 `Object.entries(graph.nodes)`、按 `node.role_id === key` 这个方向判、把 issue 的 path 指到 `nodes.<键>.role_id`，且【每个】坏键各报一条。落点在 schema 而不是 validate.ts 有三个理由：rejectMalformed 在三个入口各调一次、判的都是【本次变更之前】那张图，而 add_edge 那条根本不进 validateNewNode（缝在图上就该由图的形状管）；orgGraphSchema 今天已经是两处判据的公共入口（api.ts 的请求体 + integrity.ts 那条 delegation_edges_gated逐版本 safeParse），落在这里 ⇒ 写侧拦新的、读侧自检顺手拿到同一条不变量；validateNewNode 只收到一个 node，拿不到那个键。⚠ 射程六条：① 本条判的是【那条判据的权威字节还在 + 这条路上用的是它】，它不打开数据库、不重跑请求 —— 端到端那一发归 org-route.test.ts；② 它【不判】「老库里没有这种图」：真库 delegation_graphs 今天 0 行（实测，.workbuddy/probe-node-key.ts 可复算），而 0 行既可能是【没有坏图】也可能是【根本没有图】—— 所以【这条收紧不破坏存量】这句话靠的不是那个 0，是【仓内每一处生产节点的代码都按 role_id 取键】那份静态普查；③ 判据方向翻成【不一致才跳过】时它【照样会拒请求】，所以只判状态码的测试发现不了 —— 那一格由本条的比较方向那一发钉住；④ 它不判「键≠role_id 一定会被 schema 抓到」这件事在【不走 schema 的调用】上成立：把一张坏图直接喂给 rejectMalformed 它今天照样放行（validate.test.ts 里那两发【旧注释里那两条也不管】仍在钉这件事）；⑤ 键与值【同时】写错成另一个合法角色（键和 role_id 都写 bob）这条判据看不见 —— 它判的是【同一个节点的两个身份来源不一致】，不是【这个角色该不该存在】；⑥ 它是【收紧】：一张仓外客户端提交的键≠自称的图，今天从 200 变 422。那正是目的，但别把它读成【契约没变】。 | 判据：test/arch/claims-registry.ts 的 nodeKeyIdentityCheck —— 读一份【权威落点】（packages/contracts/src/org/graph.ts 里 orgGraphSchema 那一段，用 sliceFrom 掐到 `export type OrgGraph` 之前）+ 两处【前提】各一格：api.ts 的 `graph: orgGraphSchema`（请求体吃的就是这一份）、hub 的 org/commit.ts 仍指名 INSERT_DELEGATION_GRAPH_SQL（写入口就是那一条）。七格全判【剥掉注释之后】的字节 —— 那段 superRefine 的函数头注释比代码长得多，判原文的话「为什么不落在 validate.ts」那几段话会替「判了」投一票；两处前提同样剥注释，否则一句「这里以前挂的是 orgGraphSchema」的诚实注释会替一条已经断掉的接线投一票。⭐ 反向格三枚：遍历对象从 nodes 换成别的 ⇒ 红 / 比较方向翻 ⇒ 红 / path 不再指到那一个键 ⇒ 红（那一发同时打中 422 正文与自检报告：issuesOf 与 issueSummary 都只读 path）。另有一格判【不许 break/return】—— 只报第一个坏键会让提交的人改一次发一次。外加打在合成语料上的一族变异（claims-registry.test.ts 的 r24 那一族，不碰盘，发数以那个文件当场为准；含两对【只差注释前缀】的对照 —— 之九/之十 钉 schema 那几格、之十二/之十二·乙 钉前提格：同一批字节在注释里该绿、在代码里该红）。外加打在【真生产字节】上的六发自回滚变异（.workbuddy/round299-mutate-node-key-gate.mjs，逐字节核对、单独跑、不与任何测试并发；命中 6/6、机器自证 12/12，证据 .workbuddy/round299-node-key-mutation-evidence.txt）：M0 控制组该绿 / M1 比较方向翻 ⇒ 五发全红 / M2 摘掉遍历 ⇒ 红三发而【两发反向对照按设计全绿】（反向对照只防恒红，防不了无判据 —— 登记的盲区） / M3 遍历错集合 ⇒ 五发全红 / M4 诊断退化 ⇒ 只红甲那一发而【端到端那发全绿】（它读的是 path 拼出来的点号串，正文可用性只有 schema 那一发挡）/ M5 path 退化 ⇒ 甲乙双红。⚠ 这台比 round298 那台多两件【打在自己身上】的自证：(a) 变异打在 contracts 的【src】上而被测的吃【dist】 ⇒ 有一发自证真往 src 塞一个记号、重编、去 dist 里找它、再撤掉验它消失 —— 它验的是这台机器的【供电】，不是判据；缺这一条，「改了 src 而 dist 是旧的」会让 6/6 全绿而那一格从没被测过。⭐ (b) 那台的第一版把「盲区那一栏」的方向写反了（把【出现在 FAIL 行里】当成仍绿），后果是 M0 控制组一份都没红却报「0/4 盲区仍绿」—— 一个恒不可能成立的判据就是一句装饰（round298 ⑥·乙 那条【在本机自己身上】复发），现在有一发自证喂「一发红一发绿」的合成读数逼它两种各数一次。本条判据不打开数据库、不重跑那台机器，口径同 r12/r13/r21/r22/r23 | 2026-11-18 |
| **r25** 预算的门：上限那一侧读【列】、CLI 参数只是回落（CEO 拍板「预算列 = 生效值」，round360）—— 有预算行 ⇒ limit_cents 说话，POST /budget 追加预算真能把门打开；无预算行 ⇒ 参数说话。0045 §7 那三个候选一个都没选，拍的是第四条：门与界面共用同一个分母，(B) 那半「界面改读进程里的参数」随之作废。 | 判据：test/arch/claims-registry.ts 的 budgetColumnGovernsCheck —— 只读一份【权威落点】（packages/hub/src/serve/charter-pump.ts 里 underTaskBudgetSql 那一段，用 sliceFrom 掐到下一条消费 SQL 之前），三格各判【剥掉注释之后】的字节：E1 上限那一坨含 `COALESCE((SELECT b.limit_cents FROM budgets b `；E2 比较尾巴 `, 0) < ` 在场（防整条谓词换形状而 E1 被别处抄过去的同名字节喂绿）；E3 段内恰好 1 个 `?` —— 0 ⇒ 回落槽没了，≥2 ⇒ 五条 SQL 共用的绑参顺序被改（那条契约由 hub 侧拆 `?` 那一发钉着，测试可整份删、这格删不掉）。剥注释与切段都是必需的：那段函数头注释写的正是本条主张自己（旧文案的历史），判原文会被它喂绿；全文另有几十条 SQL 的绑定参数，不切段则 E3 恒成立。外加打在合成语料上的一族变异（claims-registry.test.ts 的 r25 那一族，不碰盘，发数以那个文件当场为准）：控制组该绿 / E1 列没了 ⇒ 红且不许红在别的格上（红因串扰排除）/ 只留一句「这里以前读列」的注释 ⇒ 仍红（同一发带反向对照：只加一句无关注释该绿）/ 比较方向翻成 `>=` ⇒ 红在 E2 而 E1 满足 / `?` 多一条与少一条 ⇒ 两条各红在 E3（只登记一半的话，实现写成 `binds < 1` 或 `> 1` 都能过另一半）/ 函数改名（取材断掉）⇒ 红在「切不出那一段」而不是退回全文继续绿 / 那份文件整份不见 ⇒ 红在「不在了」。生产行为那一半不在这里判：charter-pump、driver-pump、driver-status 各自的「⭐ 门也读【列】」那几发当场开库验放行，另有 .workbuddy 那台自回滚变异机打真字节。本条不重开库、不重跑那台机器，口径同 r12/r13/r21/r22/r24 | 2026-11-23 |
| **r26** HTTP 可达口径的真人席建卡者已接通：executors/human.ts 经 createExecutorRegistry → runExecutions → CoS routeGroupMessage 到达 createCard；dead-modules 不再登记该模块，无模型/CLI 时也能落真人待办。 | test/arch/claims-registry.ts › executorProductionCheck（生产装配含 HumanExecutor、dispatch 接收 execute、social 注入 executorRunner） | 2026-11-23 |
| **r27** 分发规则配置面已接通：GET/POST/PATCH /api/v1/dispatch/rules 三条端点在生产装配里注册，0025 那句「规则本身可停用」第一次有生产写入路径（此前 enabled/priority 除 6 条种子外零写入方）。0030 的桌面口径顺带成立：EXPOSED_ENDPOINTS = IMPLEMENTED_ENDPOINTS 是别名 ⇒ 新端点自动可达。 | 判据：test/arch/claims-registry.ts 的 dispatchRuleConfigSurfaceCheck —— 三格各判一件事，全用【字节在场】而不是行号：E1 http/registrars.ts 含 `registerDispatchRuleRoutes(router);`（注册进了生产装配，不是只写了一个没人调的注册函数）；E2 http/dispatch-rules.ts 里 `router.add(` 恰好 3 处（只注册一半 = 写侧仍是零，而读侧那条照样 200，最容易被当成全通）；E3 dispatch/rules.ts 含那条字面 `INSERT INTO cos_dispatch_rules (rule_id`（写侧的取材落点，漂了就红在「落点已漂」而不是恒绿）；E4 dispatch/co.ts 里 `WHERE enabled = 1` ≥ 2 处 —— 这一格是【下游效果】：配置面写的正是 enabled 这一列，而全仓唯一读它的就是那两处过滤，过滤被抹掉 ⇒ 写进去的停用没人执行 ⇒ 那句「可停用」重新变成做不到的话。外加打在合成语料上的一族变异（claims-registry.test.ts 的 r27 那一族，不碰盘）：控制组该绿 / 摘掉注册 ⇒ 红在 E1 / 三条路由砍成两条 ⇒ 红在 E2 / 抹掉消费侧一处过滤 ⇒ 红在 E4 / 无关行改动 ⇒ 仍绿（判据认那几处接线，不是整表字数）/ 取材文件整份不见 ⇒ 响亮抛不静默绿。生产行为那一半不在这里判：test/dispatch/rules.test.ts（停用真的改变 planDispatch 的赢家）与 test/http/dispatch-rules-route.test.ts（写连接写完只读连接读得到）当场开库验，另有 .workbuddy 那台自回滚变异机打真字节。本条不重开库，口径同 r12/r13/r21/r22/r24/r25 | 2026-11-27 |

---

## 5. 顺序与依赖

不是清单，是**依赖图**。三件事必须先发生，因为它们解锁别的：

```
O14 死模块哨兵 ─────────┐        （它让后面每一项完成时，主张自动被强制更新）
O1-1 桩只读守卫 ────────┤ 立刻做，半天级
O6-1 诚实标注安全边界 ──┘

O2 岗位书注入 ──→ O8 组织可编辑 ──→ O3 记忆
      │
      └───→ O5 证据包 ──→ O4 门控 ──→ O9 自动批准 ──→ O10 超时
                                      ↑
O6-2 gateway 接上 ──→ O7 预算停 ─────┘（R1 需要证据 + 门控 + 预算三样都可信）
```

- **O14 排最前**不是因为它最重要，是因为它让**后面每一项的完成状态不会说谎**。
- **O6-1（诚实标注）今天就能做**，而且不做的话 O4/O5/O7 的进展都会被读成
  「防线已经在了」——那是本篇认为**当前最高危的一处误读**。
- **O2 → O5 → O4 → O9 这条链是北极星的唯一路径**：
  R1 那条自动批准规则要 `evidence.ok` 和 `gate.passed` 两个真布尔，
  而它们分别要 O5 和 O4；门控要判验收标准，而那要 O2。
  **顺序反了（先做自动批准）就只能靠放松判据凑数**，那是 0007 §4.1 那一族最贵的错。
- **O6-3 有一条硬顺序约束**：必须在「真员工拿到写权限」**之前**，不是之后。

### 5.1 那 6 道阶段出口门 ↔ 本篇 14 项（round278 补，台账 debt ②）

§5 上面那张图判的是**做的顺序**，计划那 6 道门判的是**放的顺序**，
而这两套坐标此前【没有一张表连起来】—— 于是出现过一种没人察觉的空转：
一个 O 项自己测着「落地了」，而它所属 Phase 的那道门仍然不可复核（反过来也一样：
门写着要某个工件，而那个工件属于哪一项没人说得出）。这张表就是把这两套坐标对上。

**验收行原文是数出来的**（逐条 `sed` 出那 6 个小节，不是回忆）：

| 门 | 验收行点名的判据（逐字摘） | 落在哪些 O 项 | 今天能否复核 |
| --- | --- | --- | --- |
| Task 0.11 | `pnpm verify` 全绿；`test/` 用例数 ≥ 25；人工核对审计日志可读性 | O1（Checkpoint 恢复 = 图路线的价值）、O2（Task 0.7 岗位书）、O13（Task 0.10 CLI） | ❌ `verify` 恒红在 `lint` |
| Task 1.8 | `pnpm verify`；门控判定分支覆盖率 ≥ 95%；`packages/hub/test/acceptance/phase1-gates.test.ts`（原文「三条」，实测 13 发） | O5（证据包 = 门控的输入）、O4（门控本身）、O2（验收标准的来源） | ❌ 同上；覆盖率阈值另见 debt ⑤ |
| Task 2.9 | Playwright E2E `test/e2e/ceo-loop.spec.ts`：起 Hub + Web，点批准到 DELIVERED，全程无命令行；人工核对键盘审批 ≤ 20 秒 | O13（交付形状就是这一条） | ⚠ **round291 起变成「半可复核」**：工件建了、`pnpm test:e2e` 绿（1 passed / 1.5 s），但**验收句最后一格「更新为 DELIVERED」没有断言** —— 批准只走完人边那一跳，其后全是 agent 边，浏览器里没有任何一处点得动。⇒ 症状从【工件没建】换成【验收句要求一次真花费】，那一格是 CEO 决策不是测试缺陷，见 §7 第 16 格 |
| Task 3.8 | `pnpm verify`；`packages/hub/test/acceptance/phase3.test.ts`：改验收标准 ⇒ 门控结果变化；自动审批可追溯 | O2、O4、O8（组织可编辑）、O9（自动批准可追溯） | ❌ `verify` 恒红；那 13 发**单独跑是绿的** |
| Task 4.7 | E2E `test/e2e/mobile-approval.spec.ts` + 飞书沙箱手工验证记录 | O12（IM 最后一公里）、O13（移动端只做决定）、O11（一次一签） | ⚠ **round353j 改口**：~~❌ 两个工件都没有：spec 没建~~ **spec 已建**（`test/e2e/mobile-approval.spec.ts` 在盘上，`pnpm test:e2e` 3/3 全绿，含可逆卡一次一签 + 不可逆卡 403 双防线两发 = round353j 现跑读数），剩下的钉只剩【第二工件：飞书沙箱手工验证记录】→ CEO 门（真凭据）。⚠ 原句那半「全仓**没有任何一个真的 IM 适配器文件**」在 round281 过期（`channels/feishu.ts` 在），沙箱手工验证**今天仍然做不了**，只是卡的东西换了：真凭据 + 那张投递台账（~~发卡那一路零生产调用方~~ **⚡ round293 撤回这半句**：投递台账在 r17 已接进心跳，`runDeliverPass` 的调用点在 `packages/hub/src/serve/im-channels.ts:377`（本轮 `grep` 现数）⇒ 「接了推不出去」也过期了，**今天只差真凭据这一格 + 那份手工验证记录**）。⇒ 症状从「无从接」变成「接了推不出去」再变成「只差凭据 + 手工记录」 |
| Task 5.8 | E2E 一个真实缺陷修复任务跑通全链路，含 `forbidden_flags` 拦截一次人工尝试 | O6（四层预防 / `forbidden_flags`）、O7（预算门） | ❌ 纯人工，无可核对工件（debt ⑥，机制边界） |

**这张表唯一一条本轮新量到的读数**：表里 4 个 ❌ 的理由**和文档原来写的不一样**。
原话把 Task 2.9 / 4.7 登记成「依赖装不上，属 CEO 决策面」（debt ④），而 §6
「React / Electron / 移动端重写」那一行自己写着**要先复跑安装再判**。本轮复跑了，三层：

- **registry 可达**：`npm view playwright` 与 `npm view @larksuiteoapi/node-sdk` 各返回 `1.65.1` / `1.76.0`；
- **装得上**：`.workbuddy/probe278` 里隔离安装两个包 ⇒ `added 54 packages`、exit 0；
- **跑得起来**：`playwright install chromium` 之后 `chromium.launch()` **真的起了无头浏览器**，
  `locator("#x").textContent()` 读到 `ok`（`LAUNCH_OK version=159.0.8154.6`）。

⇒ **「装不上」是过期的**，那两个 ❌ 的真实理由只剩「工件没建」+「没决定要不要为它加这个依赖」。
（⚡ **round353j 更正这半句**：~~「工件没建」~~ 现只剩【第二工件缺】+【没决定要不要为它加这个依赖】。
`test/e2e/ceo-loop.spec.ts` 与 `mobile-approval.spec.ts` 都在盘上且 `pnpm test:e2e` 3/3 绿（本轮现跑）；
Task 2.9 是【半可复核】（验收最后那格 DELIVERED 无断言=CEO 决策，见 §5.1 与 Task 4.7 格），
Task 4.7 只剩飞书沙箱手工验证记录=真凭据 CEO 门。决策面仍只含产品判断，不含「装不上」。）
决策面因此**变窄了**：它不再包含「装不装得上」这一项，而只剩产品判断。
复算：`cd .workbuddy/probe278 && npm i --ignore-scripts playwright @larksuiteoapi/node-sdk && npx playwright install chromium && node launch.mjs`。

⚠ **这条更正不适用于 Phase 0/1/3 那三道**。它们红在 `lint`，与依赖无关，
而 `lint` 恒红是 debt ① —— ⇒ **那三道门今天仍然一道都复核不了**，本轮只动了
「为什么复核不了」这一格的**归因**。别把这张表读成「依赖问题解决 ⇒ 门近了」。

## 6. 明确不做（以及为什么）

| 不做 | 理由 |
| --- | --- |
| 合并图路线与引擎路线 | 引擎路线的论证今天仍然成立（下一步由那一次执行的产出决定，编译期的边表达不了），而图路线的价值在 checkpoint / interrupt 的语义验证。**合并的成本是重写两条已被测试钉住的东西，收益是没有两份状态表** —— 不划算。**要做的是 §2 轴三那三条具体的账**，不是合并。
   ⚠ 【round314 复核】「要做的是那三条账」这句已过期：三条账已逐笔收讫 ——
   账 1（桩写库）经 O1 动作 1（`stub-write-guard.test.ts` 8 发，判据是归属不是行数）；
   账 2（假审批）经 O1 动作 2（`report` 停在 `ESCALATED_TO_CEO`，charter 直通那半随 O4/O5
   一并收，已在 `test/arch/stub-terminal-write.ts` 的 `BASELINE` 里登记）；
   账 3（`ops.yaml`）经 O2 动作 4 修正块（留下 + 孤儿守卫 `== ["ops"]` 钉住）。
   剩的是拍板（O4/O5 真门控、D11 role_id），不是账。 |
| 现在做并行分支（Phase 3 的扇出扇入） | `graph/branches.ts` 的合并语义已经做完且框架无关（`worstOfReducer` + 6 个排列的可交换性用例）。**真正没做的是数据形状**：`reports_to` 是**标量**（一个角色只有一个直接上级），契约里没有 `parallel_allowed` 这个键 ⇒ `DecompositionInput.parallelAllowed` **没有生产者**。在补出这个键之前接扇出，等于让代码替 CEO 拍一个规格没拍的决定。 |
| 做会议 / 辩论会子图 | `MEETING_REQUIRED` 是**死胡同状态**（`[]`），`MeetingSummaryReady` 事件零发布点，`ESCALATED_TO_CEO` 与 `BLOCKED` 同样是死胡同。⇒ 会议子图会**造出一批进去就出不来的任务**。先补这三个状态的出路（这是改状态机，要拍板），再谈会议。 |
| React / Electron / 移动端重写 | 0009 那六个依赖的账**要先复跑安装再判**（本篇已证明「装不上」这个结论过期了一次）。**在没有复跑之前不据此做任何计划** —— 这正是 O14 要防的那种事。 |
| 给「自动批准率」加一个好看的数 | 见 O9 末尾那句。 |
| 现在加 `TERMINATED` 状态然后接按钮 | 状态机改动是规格改动，要先拍；先加按钮会造出一个点了什么也不发生的控件。 |

## 7. 别当成做到了（本篇自己的账）

本篇的每条读数都可能错。已知的形状有这些：

1. **「零 importer」不等于「零调用方」。** 我第一版按说明符子串匹配，造出 **33 个**
   假死模块；改成真的路径解析后是 11 个；再排掉动态入口（`new Worker`）是 9 个 +
   `harness` 整目录。**下一个读这篇的人若跳过这段，会把 11 当成事实抄走。**
2. **静态 import 图仍然测不到**：`import()` 动态表达式、`spawn` 起的脚本、
   按字符串反射取的模块。我逐个人工过了一遍已知动态入口，
   但**「我过了一遍」本身就是这句话的强度上限** —— 所以 O14 那条守卫才必须
   内置动态入口排除，把它变成机器的事。
3. **两条否定式读数我差点写错**：`@langchain/core` 在根目录 import 失败（在包内成功）、
   `git format=%H`（少了 `--`）曾让一次哈希普查报出 324 条假悬空引用。
   **凡是「找不到 / 不存在」，先怀疑问的位置，再下结论。**
4. **本篇引用了另外两份并行调研的结论**（审批/策略/预算/证据/频道那一簇，
   与编排核心那一簇）。我对其中承重的那几条**逐个复核过**（`verifyFix` 零调用方、
   `insertCard` 已有三条生产路径、`BudgetTracker` 无 `new` 点、
   `hard_stop` 三处 INSERT 全写字面量 `1`、`EvidenceStore` 对外零 import、
   ~~`autoApprove` 零调用方~~、`review_gates` 零 INSERT、`timeout_at` 无执行者），
   ⚠ 【round272 复测其中三条】`hard_stop` 那句的**结论**（恒 1）还对，**读数**过期了：
   带 `hard_stop` 的 INSERT 从「三处」变成「一条语句 + `charter/budget-sync.ts`
   的一处 UPDATE」—— 引擎路线那份手抄副本删了（O6 落地块）。`autoApprove`
   零调用方那条**整条过期**：`approvals/query.ts` 的读路径是它的第一个生产调用方
   （O9 动作 1，影子判定只报不批）。`EvidenceStore` 对外零 import **本轮复核仍成立**
   —— src 里只有注释与类型名提到它，没有一处 import `evidence/store.js`。
   ⚡ **round358 翻向**：这句「没有一处 import `evidence/store.js`」**已过期** ——
   `engine/work.ts:36` 现在 `import { artifactsRoot } from "../evidence/store.js"`，
   链是 `hub:engine` CLI → `engine/hub-work.ts` → `engine/work.ts` → `store.ts`
   （`--evidence-root` 缺省时真调 `artifactsRoot()`），`evidence/store.ts` 从此
   【模块可达】，dead-modules 基线条目 round358 摘除。这正是这段自我警告预言过的
   那一类：**「待复核」的读数没有被机械盯住，直到有守卫把它踢出来**（dead-modules
   方向 B 红行点名）。
   这一条自我警告【被它自己预言中了】：写下它的人说「次要结论按待复核读」，
   而上面两条正是当时没复核的那一类 —— 包括我自己在这一轮里顺手把
   `EvidenceStore` 一起划掉、复核之后发现它还成立。
   但**没有复核全部**。**被引用簇里的次要结论按「待复核」读。**
5. **本篇的优先级是「解锁面 × 距离」，不是「重要程度」。** 如果 CEO 的下一件事是
   在手机上批卡片，那 O12 排第一，§5 那张依赖图只约束 O2/O4/O5/O9 那条链。
6. **我推荐的那两个方案没有替代方案的对比。** O7-1「不改状态机的硬停」与
   O1-2「把 `report` 落到 `FINAL_REVIEW`」都是**改规格的解释**，
   不是纯工程决定 ⇒ **这两条要 CEO 拍**，本篇给的是论证不是结论。

   ⚠ **O1-2 已按「CEO 把设计权交给我」这句话落地，落点比本篇原提议【低一格】。**
   拍板依据是「你来设计，你比我懂，开始干吧」+「后面都继续，不用问我」，
   不是对规格的任何新解读 —— 所以这一条的**风险仍然挂着**：如果 CEO 认为
   「桩演示应当跑到交付」，要改的只有 `report` 节点体那三行，加回
   `EXPECTED_STUB_TRACE` 里那三条边，`test/arch/stub-terminal-write.ts` 会当场红，
   红得很便宜。**这是刻意留下的形状**：一条改错了能一次回退的决定，
   比一个因为怕改错而不做的决定好。
   为什么落点低一格见 §O1 动作 2 那段 —— 一句话：**落到 `FINAL_REVIEW` 需要在
   append-only 的审计表里先留下一条假的「CEO 批准上线」**，那是本篇第 2 条后果
   要防的东西本身，用它去修第 2 条不成立。
   O7-1 还没做，仍按本篇原话「要 CEO 拍」读。
7. **`events/batch` 那一格我原先写错了，错因是【按 basename grep】。**
   我原先写「它被 `events/recorder` 用」，依据是在 `recorder.ts` 里 grep 到了 `batch`。
   实际命中的是 `recorder.ts:568` 的一个**局部变量** `const batch = this.#pending.splice(...)`。
   它今天和 `harness/*` 是同一族：**自己也是零 importer**。
   ⇒ 这条错的形状是**「子串命中当成引用」**，和本篇 §7 第 1 条那条
   「按说明符子串匹配造出 33 个假死模块」是**同一个病，换了宿主**：
   上一发在路径上，这一发在标识符上。**凡是用名字代替解析得到的结论，
   都要先问一句「这个名字有没有可能同时是别的东西」。**
   已改成机器判的正是这一族 —— O14 那条守卫按真实路径解析说明符，不看子串。
8. **O14 落地时又撞到三条**，都在判据里修掉了，记在这儿是因为它们**都不是**
   「写完就绿」能发现的：
   - **注释里的 `import` 被读成真引用。** `db/worker-entry.ts` 的注释拿
     `./worker-loader.js` 当**解析不了的反例**，而那个文件全仓不存在 ⇒
     判据报出一条**并不存在**的悬空引用。修法是先分词再取说明符，注释侧只留证据
     （`buildGraph().commentOnly`，真语料 4 条，全部指向不存在的文件）。
     与本仓 `comment-citations.ts` 文件头第二条同因：**扫全文会把数据当引用**。
   - **「先把字符串内容抹平再跑同一条正则」把真说明符一起抹掉了** ⇒ 边数从 237 掉到
     **0**，报出来的是「多出 77 个死模块」而不是「扫描失败」。**判据坏起来的形状
     不像判据坏了** —— 这一条是本篇 §7 整段最该被引用的一发。
   - **并行探针造成一条随并发出现的红**（`新增死模块 <探针名>`）。本仓另三个扫描型
     守卫早就从 `run-fixtures.ts` 取排除名单，我这条漏了；单跑恒绿、全量跑偶发红，
     正是 0007 §4.1 说的「会被关掉的那种红」。
   - 另外改了一次**活坐标**：0044 §4 那条指 `claude.ts` 的引用（当时落在第 88 行）因为本篇
     batch 0 给 `claude.ts` 头部加了一段说明而漂到第 106 行。快照与文档坐标一起改，
     并在 0044 原地留了「它曾指向 88」那句 —— 悄悄改坐标正是本守卫要防的假事实。
     ⚠ 这一句原本写成【完整形态】的 claude.ts 冒号 88（本文件此处刻意不照抄那个写法——
     照抄就会被守卫当成【当前坐标】而当场判红，这条注释自己就是那条判据的分母），
     而完整形态在守卫眼里说的是【现在】—— 它于是被一条讲历史的句子点亮，
     而 88 行今天是个 `];`。
     0044 §4 自己一直是写裸 `:88` 的（同一个意思，不触发扫描）⇒ 这不是"坐标漂了"，
     是**历史叙述借用了当前坐标的写法**。round288 把它改回裸写法。
   ⇒ **对本篇所有读数的信心要相应下调一档**：判据本身也是代码，
   它坏的时候**不会以报错的形状出现，只会以「数对不上」的形状出现**。
9. **第 8 条那一族又抓到一发，而且这次是【别人家的】扫描器。**
   `packages/hub/test/acceptance/phase3.test.ts` 的 `tsFiles()` 用
   `readdirSync` 拿名字、再逐个 `statSync` —— 而 `dependency-boundary.test.ts`
   会往 `packages/hub/src/` 现场写一个越界 import 探针再删掉。删除落在那两次
   系统调用之间 ⇒ 整发 `ENOENT`。**实测复现率约八分之一全量跑，单跑恒绿。**
   窗口本身是确定的：把删除插进那两步之间，**2000/2000 必现**。
   修法是只对【消失】宽容（`ENOENT` / `ENOTDIR`），权限类错误照抛
   —— 与 `no-native-deps.ts` 同一口径；`readFileSync` 那三个消费点同样处理。
   三条值得记下来的地方：
   - **顶层不宽容。** 顶层也宽容的话，`SRC` 指错会让 `tsFiles` 静默返回空表，
     而那一发里 `callersOf("verifyFix", …)` 期望的正是【空表】——
     那种绿是「什么都没扫到」换来的。判据的容错必须带一条【不容错】的配对。
   - **容错要有不靠撞的测。** 用【悬空符号链接】把窗口做成静态事实：
     `readdirSync` 列得出它、`statSync` 对它抛 `ENOENT`，与真竞态在 syscall 层面
     同形且每次必现（`no-native-deps.ts` 文件头那句「撞不响的那一次不是通过，
     只是没撞」是这条的依据）。
   - **「0 次红」本身不是证据。** 修完之后并发对撞 8 次 0 红，听着像修好了，
     但**没修之前同样的对撞也是 0 红** —— 那两个 0 分不出好坏。换成高强度对撞
     （另起进程按真实内容反复创建/删除该文件名，一轮 15 万次），并补一发【对照】：
     把容错摘掉做成同内容的副本，同样的强度下**红 5 发**，报错就是现实里那条
     `ENOENT: ... packages\hub\src\__boundary_probe.ts`。**「我的修法有效」这句话
     要有【同一强度下老代码会红】那一发撑着，否则它只是「没撞上」。**
   ⇒ 撞这个探针的扫描器现在数得出【四个】：`no-native-deps` / `production-deps` /
   `dead-modules`（三个都从 `run-fixtures.ts` 这个唯一真相取排除名单，
   写入方是 `dependency-boundary`），加上这次的 `phase3`。**`phase3` 是第四个撞上它的，
   却是【第一个没法用那份名单的】** —— 它在 `packages/` 那一侧，而名单在根 `test/` 那一侧，
   本仓没有包内测试 import 根 `test/` 的先例；更硬的理由是【名单只认确切文件名】，
   它挡不住「将来有人新造一个探针」（`run-fixtures.ts` 文件头自己写明的边界），
   而宽容 `ENOENT` 管的是【任何并行删除】。
   **真正的根因是「往真源码目录里写夹具」这个设计**（写进系统临时目录就不落在
   biome 边界规则的路径范围内，所以那条测试必须这么写）—— 只要还往 `src/` 里写，
   下一个扫描器还会再撞一次。

10. **本篇之外还有一份计划文档，而它的出口门前提今天不成立 —— 顺带把「`pnpm verify`
    全绿」这句话第一次变成机器看得见的东西。**
    本轮第一次通读 `docs/` 时量到的：`docs/superpowers/plans/2026-11-06-opc-os-development-plan.md`
    （839 行 / 58 个 `### Task X.Y`）**本篇一字未提**，而本篇 14 项全部挂在它底下当"优化项"，
    它那边却另有 6 道**阶段出口门**（Task 0.11 / 1.8 / 2.9 / 3.8 / 4.7 / 5.8）。逐条实测：

    | 那道门写的 | 今天 |
    | --- | --- |
    | Task 0.11 / 1.8 / 3.8 的 `**Run**` 行：`pnpm verify`（0.11 还额外写「全绿」） | **恒红**，红在第一段 `lint` |
    | Task 1.8 另加：门控判定分支覆盖率 ≥ 95% | 覆盖率阈值四个全填 0（`vitest.config.ts` 里自己写着「0 等于不设限」），另由 `coverage-guard.test.ts` 单独顶着一半 |
    | Task 2.9 / 4.7：**没有** `**Run**` 行，各要一个 Playwright E2E（`test/e2e/ceo-loop.spec.ts` / `test/e2e/mobile-approval.spec.ts`） | ~~`test/e2e/` **目录不存在**；playwright 不在任何一个 `package.json` 里；全仓 `*.spec.ts` **0 个**~~　【round278：这三格【仍然全对】，但当时由它推出去的那句「依赖装不上」**是错的**，复跑见 §5.1 —— 三个 ❌ 里「没装进本仓」是真的，「装不上」不是】　**⚡ round293 复测：这三句今天【全部为假】**，逐条现数 —— ① `test/e2e/` 在（`ls` 得 1 项）；② `playwright` 与 `@playwright/test` 都在根 `package.json` 的 `devDependencies`（各 `^1.65.1`），且 `scripts.test:e2e = "playwright test"`；③ 全仓 `*.spec.ts` 从 0 变 **1**（`test/e2e/ceo-loop.spec.ts`）。⇒ **这句「今天」的有效期是 15 轮**。它不是被谁改错的，是 round291 建工件时【只建了东西、没来改这句】——同 §10 第 3 条那句「计划读的是正文，不读自己的过去」同形：**一句写着「今天」的读数没有作者续约义务**。⚠ 且新读数的口径要说清：那 1 个 spec **在盘上但没入库**（`git ls-files "*.spec.ts"` 仍是 0）⇒ 「仓库里有一个 E2E」和「仓库里跟踪了一个 E2E」是两条主张，本轮之前两条都是假的，现在第一条真、第二条假 |

    ⚠ 三条读数纪律，都是本轮我自己踩的：
    - **「5 道门全部写着 verify 全绿」是假的**，那是我凭记忆写的。实测只有 3 道有 `**Run**`
      行且其中只有 0.11 带「全绿」二字；2.9 / 4.7 根本没有 `**Run**` 行，它们要的是 Playwright。
      写文档前把这句话重新数了一遍才敢落表 —— **上表是数出来的，不是回忆出来的。**
    - `pnpm verify` = `lint && typecheck && test`（根 `package.json`）。今天 typecheck 0、
      test 全绿、**lint 恒红** ⇒ 那三道的 Run 行一条都复核不了。**0055 治的是 `test` 那一段恒红，
      本轮量的是 `lint` 那一段**：同一句「verify 全绿」被两段各自击穿过一次，而两段各修各的，
      没人问过整条链能不能绿。
    - **计划文档的坐标不进 doc-refs 射程**：`test/arch/doc-refs.test.ts` 只扫 `docs/decisions/`，
      所以「58 个 Task 标题 / 上千处 `Task X.Y` 引用」这一族此前从没被核对过。本轮先把它做成
      一条守卫（`test/arch/plan-refs.ts` + `.test.ts`），现数：
      | 口径 | 引用次数 | 悬空 | 零引用标题 |
      | --- | --- | --- | --- |
      | 只有代码（`packages/**` + `test/**` 的 `.ts`） | 513 | 0 | **10**（1.8 / 2.4 / 2.5 / 2.7 / 2.8 / 4.2 / 4.3 / 5.6 / 5.8 / 6.6） |
      | 代码 + `docs` 全部 markdown（**守卫采用**） | 1061 | 0 | 0 |
      ⚠ 我一度拿着上一行那句「10 个标题零引用」写成【全仓】—— **那是口径错**：那 10 个标题
      只是【没人用代码引用它们】，在决策文档里全都被引用着。⇒ **同一条"零 X"主张，
      换口径就从 10 变 0**，这正是 §1.4 那条读数纪律要防的形状，而这次是我自己撞上的。
      守卫因此采用宽口径，并在测试里把【窄口径的 10】也钉住 —— 两个口径都给读数，
      下次谁再写「零引用」就必须先说清是哪一侧。
      **而且这条守卫当场抓到 2 处真悬空**（不是假设）：计划把 Phase 0 第 4 号任务拆成
      0.4a（探针）/ 0.4b（实现），而 `docs/decisions/0001` 两处仍写拆分前的旧编号 ——
      两处按各自所指分别改到 0.4a / 0.4b，并在原地写明「原稿引的是拆分前的编号」。
      ⚠ 另外一条新的形状：**扫全仓文本的判据，它自己的散文也在射程里** ——
      这段注释第一版如实抄下了那个坏掉的编号，于是它自己成了第 3、4 处悬空，
      判据把自己判红（同族先例：0056 §2 规定哈希一律写全长，免被「恰好 7 位」那条误判）。

    **这一格真正落地的东西**：`test/arch/lint-baseline.ts`（判据）+ `.test.ts`（12 发）。
    它**不修 lint**，它把 lint 的现状钉成一张**只许减不许增**的基线表：
    逐 error 类目记上限，超出红并点名「从几到几」；冒出**基线外的新 error 类目**当场红并点名
    类目名（这一半比"变多"更重要 —— 它挡的是「反正 lint 本来就红，加一条没人看得出」）。
    为什么这么做而不直接把 lint 修绿，是一个**判断**不是偷懒：272 条 error 里 162 条 `format`
    + 119 条 `assist/source/organizeImports`，两类**都自动可修**，但那会是一次**一次动 169 份文件**
    的纯排版提交（169 = 现数，`.workbuddy/round285-lint-blast.mjs` 现场量；别写成「200+ 文件」——
    那一句在此前几版里出现，是把**诊断条数**当**文件数**读了，单位错），混进本轮这一大片未提交改动里（`git status --porcelain` 现数）之后，**没有人能从那堆 diff 里读出哪一行是真改动**；
    剩下 11 条 lint error 有 10 条在测试文件里，是 `while ((m = re.exec(s)) !== null)`
    那类**刻意的**惯用法 —— 它们不是坏了，是那条规则对这个用途过严，正确的改法是关规则
    或就地豁免，而不是把惯用法改残。**代价说清楚**：`pnpm verify` 仍然恒红，本轮买的是方向，
    不是绿；把它真修绿仍然是欠着的账，且**必须先于任何一次拿 verify 当出口门的复核**。
    round285 把这一格**要问的那一句**从「修不修」改成了一道可数的选择题
    （`.workbuddy/round285-lint-blast.mjs` 现数）：169 份涉及文件里 **51 份本来就在这轮被改过**
    （排版混进它们的 diff 不新增盲区），**118 份是干净的**（动它们 = 整份重排别人没碰过的行）。
    ⇒ 选项 (a) 先 commit 再全仓 `--write`；选项 (b) 只切那 51 份，一次砍掉 51 条上限且不需要先 commit。
    两个都属"不可逆地重排他人代码"，故**只报不切**。

    三件顺带量到的、比上面那张表更该记的：
    - **「我核对过」这句话在机器那里不存在。** 0057 / 0059 各抄过一句「286 error / 109 warning」，
      并且各自跟着一条 ⚠「这三个数**不写终版**」—— 所以**它们没有撒谎**，这一点得先说。
      问题在下一层：那条免责声明是散文，而本仓自己反复立的口径是
      **「散文里正确的话，机器看不见；它比不写更坏，因为下一个读者会信它」**（0057 同一篇的 ⭐）。
      三次读数我全量了一遍，只有中间那次是有主的：
      | 读数 | 来源 |
      | --- | --- |
      | 286 error / 109 warning | 0057 / 0059 手抄，当时真 |
      | **291 error / 256 文件** | HEAD `61467b5` 干净树实测（临时 worktree） |
      | **292 error / 282 文件** | 本轮工作树实测（`node .workbuddy/round274-lint-baseline.mjs`） |
      ⇒ **286→291 那 5 条漂在本轮之前的提交里，本轮只加 1 条**。新守卫因此不存"当前是多少"，
      只存"最多是多少"—— **上限会随修复下调，期望值一定会过期**，这正是它不抄 292 当期望值的原因。
    - ⚠ **量 HEAD 那一次差点把我自己的判据喂成假的**：临时 worktree 建在 `.workbuddy/` 下时，
      它自带的 `biome.json` 会让**父仓**那次扫描直接以「nested root configuration」配置错误退出，
      而它的 stdout **只有一行配置错，没有任何 findings**。我连着两次 `grep` 那条输出取不到数、
      却把「空」当成了「没找到」——**一次工具失败在这里长得和"读数为 0"一模一样**。
      ⇒ 记两条：worktree 用完必须删（本仓已删，`git worktree list` 只剩主目录）；
      任何"扫描器给的读数"在拿去当证据之前，必须先确认它**真的扫了**（新守卫里那条
      `filesChecked >= 200` 下限就是为这件事立的，出处是 0006 §7 第 41 条「测试面被改窄会整绿通过」）。
    - **探针会污染这条守卫自己**：`dependency-boundary.test.ts` 必须往真实源码目录写一个
      越界 import 的文件，才证明 biome 的边界规则真的会挡。实测它活着时整仓 error **292 → 293**
      （复算：`node .workbuddy/round274-lint-baseline.mjs`，它现场写探针再量差值，不抄这个数）。
      同一条坑此前咬过 `no-native-deps`（知道，按文件名排除）与 `production-deps`（不知道，
      随机红过一次）。这里从 `run-fixtures.ts` 那份唯一真相取名单。⇒ **第 9 条那句话再说一遍：
      只要还往 `src/` 里写夹具，下一个扫描器还会再撞一次**，而本轮就是"下一个"。
    - **变异三发，全部命中预测的那一发**（`.workbuddy/round274-lint-ratchet-mutate.mjs`，自恢复）：
      M1 拔掉探针排除 ⇒ 只有「探针不进基线」红（1/12）；M2 把「只数 error」删掉 ⇒
      「只数 error」+ 真仓库那一发红（2/12）；**M3 把 `n > allowed` 改成 `n > allowed + 1000`
      （棘轮被悄悄拔掉齿、表面还在）⇒ 只有合成变异那一发红，真仓库那一发仍然绿**。
      M3 是这一发里最值的一条：**真仓库那一发对"判据被改成不判"是完全瞎的**，
      它今天必然绿，因为它比的数就是照着今天写的 —— 只有合成读数抓得住。
      「守卫跑过了」和「守卫在判」是两件事，本轮又一次只有后者要到了证据。

11. **上一格那条计划引用守卫，落地后被自己的变异打回过一次**（round275）。
    守卫是 `test/arch/plan-refs.ts` + `.test.ts`（10 发），四发变异见
    `.workbuddy/round275-plan-refs-mutate.mjs`（自恢复）。**两发的实测和预期不一样，
    而那两处不一样比"命中预测"更值钱**：
    - **P1（拔掉「标题集为空 ⇒ 一律红」那句哨兵）第一版只红 2/10。** 漏掉的那一发是
      「计划标题被降级成二级」—— 我在那里断的是 `toHaveLength(1)`，而哨兵被拔掉后
      「引用了一个不存在的编号」也**恰好返回一条**，于是它绿。**红了几条不是判据，
      红话是谁才是**：改成比对返回的那条就是哨兵本身之后，P1 才真的抓到它（3/10）。
      ⇒ 这条通用性比这一发大：**凡是拿"返回几条 / 非空"当判据的地方，都能被一个
      换了的死因顶替**，而同族的 §7 第 10 格刚说过「上限会过期，期望值一定会过期」。
    - **P4（静默版窄口径：计划读进来、其余只扫 `.ts`）第一版 10/10 全绿。**
      这不是假设的口径，是 round274 那版探针**真实用过**的口径 —— 而它漏掉了本轮
      全部的 2 处真悬空（那两处都在 `docs/decisions/`）。当时守卫已经钉了
      「总引用数 ≥ 500」，P4 下仍有 840 条，**撑住了**。⇒ **一个被撑大的总数会替一个
      空掉的分区作证。** 修法不是再加一条判据，是把那个总数拆成分块下限：
      | 取材分块 | 本轮实测 | 守卫下限 |
      | --- | --- | --- |
      | `docs/decisions/` 的 markdown | 65 文件 / 221 引用 / 49 编号 | ≥ 50 文件 且 ≥ 100 引用 |
      | 计划文档自己 | 230 引用 | ≥ 1 |
      | 全部 `.ts` | 610 引用 | ≥ 300 |
      | 合计 | 1061 引用 / 58 编号 | ≥ 500 引用 / ≥ 50 编号 |
      分块现数的命令留在 `.workbuddy/round275-scope-probe.mjs`（这张数就是它打的）。
      改完 P4 红在第 8 发：「`docs/decisions` 的 md 几乎没进语料 ⇒ 口径又窄了」。
    - 另外两发按预测命中：P2（精确匹配换成前缀匹配）红 2/10 且真仓库那几发仍绿 ——
      它打的正是本轮那个真故障的形状（编号拆成 a/b 后旧引用还在，前缀匹配对它全瞎）；
      P3（把计划一起删出语料）比预测更狠，**整个文件在取材阶段就抛，一发测试都没跑**，
      说明「计划找不到」这一族的响法是文件级的，不挂在某一发测试上。
    - ⚠ 同一条自匹配坑**又踩了一次**：`.test.ts` 的合成夹具第一版直写了坏编号，
      而测试文件自己在语料里 ⇒ 判据把自己判红。解法与 §7 第 10 格同源：
      合成字符串一律拼出来（`"Ta" + "sk"`），并加一发**专测本文件对语料的引用数为 0** 的守卫。

12. **计划的 6 道出口门禁，今天【只有一道半】是拿来复核过的 —— 顺带量到一条比 lint 更阴的工具性质**（round276）。
    §7 第 10 格只数到「3 条 Run 行写着 verify」，那一句【数对了但停得太早】：本轮把
    每一条验收行点名的**工件路径**逐字核了一遍（`.workbuddy/round276-run-lines.ts`）：

    | 门禁 | 验收行 | 点名的路径逐字存在？ | 那条命令今天的实际结果 |
    | --- | --- | --- | --- |
    | Task 0.3 决策门 | `**Run**` | ❌ 旧住址（`test/db/…`） | **绿** —— 16 发 |
    | Task 1.8 Phase 1 | `**Run**` | ❌ 旧住址（`test/acceptance/…`） | **绿** —— 13 发 |
    | Task 3.8 Phase 3 | `**Run**` | ❌ 旧住址（同上） | **绿** —— 13 发 |
    | Task 2.9 Phase 2 | `**Playwright E2E**` | ❌ `test/e2e/` **目录不存在** | ~~**跑不了**：playwright 不在任何 `package.json`~~　【round278 改口：**这句话把两件事混成一格**。「不在 `package.json`」= 今天没装进本仓，对；由它推出的「所以跑不了」= **装不上**，**错的** —— 隔离复跑装得上且无头浏览器真起得来（`LAUNCH_OK`，见 §5.1）。⇒ 真实理由是【工件没建】+【没决定要不要加这个依赖】，不是技术阻断】<br>【round291 再改口：**这一整行的三格都是【那一天】的读数，今天三格全变了**。① `test/e2e/` 目录存在；② `ceo-loop.spec.ts` + 根 `playwright.config.ts` 存在，playwright@1.65.1 在根 `devDependencies`；③ 命令今天的结果是 **1 passed**（`pnpm test:e2e`，约 1.5 s）。⚠ 但**别把它读成「这道门过了」**：spec 走完的是到 `CHARTER_APPROVED` 为止，计划要的**最后那句「看板更新为 DELIVERED」没有走通** —— 批准只走完人边那一跳，其后全是 agent 边（只有真 Claude 子进程/驱动器推得动）。那一格见下面 §7 的待决策块。】 |
    | Task 4.7 Phase 4 | `**E2E**` | ❌ 同上 | **跑不了**：同上（round291 复述：`mobile-approval.spec.ts` **今天仍然不存在**，这一格没变。它要一个真飞书沙箱 + 真凭据，本机给不出可复核的形状 ⇒ `plan-gate-paths` 里那条豁免是【活的】） |
    | Task 5.8 Phase 5 | `**E2E**`（无文件路径，纯人工） | — | 人工，无可核对工件 |

    ⭐ **本轮最该记住的一条：一条指向【不存在文件】的验收命令，可以长期绿。**
    `vitest run <路径>` 把参数当**子串过滤器**，不是当路径。实测两条对照：
    - `npx vitest run test/acceptance/phase1-gates.test.ts` ⇒ 该路径 `ls` 都说不存在，
      命令却报 **1 文件 / 13 发通过、exit 0**（`packages/hub/` 下有个同名文件被匹配上了）；
    - `npx vitest run test/definitely/not/here.test.ts` ⇒ `No test files found`、**exit 1**。
    ⇒ 所以这三道门"复核过"的真实含义是「**碰巧**有个同名文件」。仓库将来再多一个同名
    测试，这条命令会**静默地**跑到别的文件上去 —— 而它比一条红的命令危险得多，因为红的至少会被人看一眼。
    这条与 0006 §7「测试面被改窄会整绿通过」同族，但**机制不同**：那一族改的是被测面，
    这一条是**工具把一个拼错的地址解释成了一个存在的地址**。

    **落地的守卫**：`test/arch/plan-gate-paths.ts` + `.test.ts`（10 发）。口径是本轮反复撞的那一格：
    - **只判【验收行】点名的路径**，不判计划正文里的全部路径。现数：计划全文点名 **116** 条
      带扩展名的路径，逐字命中只有 **27**，另有 **65** 条是「文件在、住址从 `src/…` 搬到了
      `packages/hub/src/…`」。**拿那个口径做守卫 = 一条恒红的守卫**（0055/0056/0057 三连治的正是它）。
      ⇒ 计划是**施工前**的文档，它的正文本来就该保留当时的布局；要钉的是【还要拿来当验收用】的行。
    - **豁免是一行显式标记** `<!-- gate-path-not-built -->`，不是散文。且**条数只许减不许增**
      （上限钉在测试里，同 lint 基线那张表的形状）⇒ 豁免是一份可数的账。
      标记贴到「所有路径都存在」的行上也会红（凑数式豁免挡得住）。

    四发变异，**全部命中预测**（`.workbuddy/round276-gate-path-mutate.mjs`，自恢复；
    与 round275 不同，这一轮**打在真文档上** —— 这一发的全部价值就是「文档今天写错了」）：
    G1 把 Task 1.8 的住址改回本轮修之前的旧写法 ⇒ 2 发红（真故障原样回放）；
    G2 删掉 Task 2.9 的豁免标记 ⇒ 1 发红并点名那个 spec；
    G3 把豁免标记多贴一行到住址本来就对的行上 ⇒ 1 发红；
    **G4 把判据里的 `exists(p)` 换成恒真 ⇒ 合成 5 发红，而真仓库那 4 发【全绿】**。
    G4 又一次是本轮最值的一条，和 round274-M3 同一句话：
    **真仓库那一发对「判据被改成不判」是瞎的**，它今天必然绿，因为它的期望就是照着今天写的。

    ⚠ 三条我自己撞的，都是「工具把猜测当成了事实」：
    - **我的正则连错两版。** 第一版把 `pnpm i -D vitest && pnpm test test/poc/resume.test.ts`
      **整段**当成一条路径去 `existsSync`，于是**报了一条假故障**（那条 Run 其实完全正常）；
      第二版只认出 2 条（漏 4 条）。 ⇒ 改成先把反引号片段整段取出、再按空白切 token，
      「是不是路径」只由一条判据决定。守卫的测试里现在钉着这两个形状。
    - **我的豁免说明自己把判据毒了。** 第一次给 Task 0.3 写"原写 xxx"时，我把那个**不存在的旧路径**
      放进了反引号 —— 于是我的注解自己成了语料里的新故障。同 §7 第 10/11 格那条自匹配坑，
      **第三次**撞。⇒ 描述一个坏路径时不许给它反引号。
    - **我写的测试自己没在测它声称的东西。** 那一发想测「验收行前缀被改名 ⇒ 判据取不到任何东西」，
      但我用了 `replace`（只换第一处），夹具里有两条 Run 行 ⇒ 判据照读第二条，返回的是**另一条真故障**，
      而我断的是"空集合 ⇒ 哨兵"。**它红了，我就当成判据生效了** —— 实际红的是不相干的那条。
      ⇒ 测试里凡是"把 X 改掉"的意图，都要先确认改的是【全部】X。

    **顺带修掉的三处过期主张**（决策记录的老规矩：原文保留 + 划掉 + 标出处 + 配复算命令）：
    ① Task 0.3 里「当前仓库内没有 driver-preflight 这个测试」—— 测试存在，16 发全绿；
    ② Task 0.5 里「`pnpm verify` = 10 文件 / 113 passed」—— 带日期所以当年为真，
      但今天这个数已经翻了一个数量级（复算 `npx vitest run` 现场读数，**本篇不抄它** ——
      我上一版在这里抄的两个数，在同一次会话里就漂了一回），
      且**verify 的 lint 段今天恒红**，那个「= 全绿」的等式已不成立；
    ③ 末尾「当前工作区 `D:\item\opc` 下只有 `docs/`，没有代码、没有 git 仓库」——
      这一句到今天**整句反了**。它留着是因为**这一篇就是施工前的规划**，删掉会让后来人
      以为这份计划从一开始就描述了现状。

13. **今天真的员工身上唯一生效的安全边界，此前一条守卫都没有 —— 顺带量到 `tsc -b` 从不检查测试**（round277）。
    变异一句话：把 `engine/claude.ts` 的 `--permission-mode plan` 改成 `bypassPermissions` ⇒
    **全仓零红**。那一格是真 CLI 不可安装时【唯一】能挡住一次写盘的东西，而它被改掉以后
    2678 发测试照过。这不是"少了一发测试"，是**全套守卫对"生产安全边界"这件事没有射程**：
    守卫们量的是接线、取材、口径，没有一条量"那个参数是不是它自己声称的那个"。

    **落两层，各管对面那层管不到的**：
    - 静态四判据 `test/arch/role-spawn-boundary.ts`（11 发）：spawn 点基线名单、plan 与
      FLAG 的**相邻性**（不是"两个串都在文件里"）、诚实标注必须在**第一行代码之前**、探针键名单非空。
    - 行为一发 `claude.test.ts`（+2 发）：真起子进程，验它**一次都没写工作区**。
      配一条**正向对照**：桩拿不到 plan ⇒ 同一条路径**真的写出了文件**。
      ⭐ 没有对照，"文件不在"至少有五种成因（没跑起来 / 路径算错 / 写到了别处 / 断言写反 /
      边界真生效），**这五种在那一发里长得一模一样**。这一发的全部价值在对照那一发上。

    ⭐ **本轮最大的一条不是上面那条，是查它时撞到的工具性质：`tsc -b` 从来不检查测试。**
    根 `tsconfig.json` 只 reference `packages/*`，`packages/hub/tsconfig.json` 只 include `src`
    ⇒ 全部 **157** 个测试文件（`test/` 65 + `packages/*/test/` 92）在类型检查射程外。
    证据不是推理：往 `test/arch/role-spawn-boundary.ts` 塞一条 `const 坏: number = "字符串"` ⇒
    **`tsc -b` exit 0**。本轮实测：全仓 **278** 条类型错在射程外，而**这 278 条里有 3 条是真 bug**
    （`claims-registry` 的 `judge` 联合类型从 round274 起就缺 r10/r11/r12 那三族的名字，
    三处类型错活了三轮，因为没有任何东西经过它们）。本轮把 `test/arch` 那 11 条清到 **0**，
    忠实探针留在 `.workbuddy/tsconfig.tests.json`。

    **round285：这一格接成了门禁，形状是棘轮（登记为 r19）。** 上面那句「刻意不接成门禁」
    到本轮为止是**过期陈述**——它成立的前提是「接成门就是一条恒红门」，而恒红之所以是代价，
    只因为当时的写法把**清零**当成了前提。换成上限表之后，清零是**目标状态**而不是入场券：
    `test/arch/test-type-baseline.ts` 是一张**按目录**的上限表（只许减不许增，往上调要点名），
    0 条读数是绿的，本轮实测各目录的读数也各在其配额内。
    为什么不是一张总数：round275 的 P4 量过「一个被撑大的总数会替一个空掉的分区作证」，
    而这一族连「撑大」都不需要——本轮那发变异是**总数下降 4 条而 `test/org` 涨 1 条**，
    按总数判它绿，按目录判它红。
    三条反假绿哨兵各管一件事，别读成一条：**语料下限**挡 include 被改窄，
    **未解析行数必须为 0** 挡「少报」（少报在棘轮上是绿的方向，这一族只能靠哨兵），
    **退出码与读数自洽**挡「我在读一份根本没跑起来的检查」。
    ⚠ 射程三条：① 它**不让** `pnpm typecheck` 变绿（那是 lint 那一格的账，r10）；
    ② 一个**语法错**会短路整个 program，那时这一发测的不是完整语料——这一条不是散文，
    是量出来的（临时 project 里一个语法错 + 三个各带类型错的文件 ⇒ tsc 只报 1 条 TS1109，
    三条 TS2322 一条不出，而 `--listFilesOnly` 照样列出 4 个文件 ⇒ **语料下限那条哨兵管不到这一族**）；
    ③ 它跑在别的测试正在改的工作树上，同一次全量跑里偶发的「少几条」是绿的方向，测不出来。

    **一条【随机红】的守卫，靠逐个消费者补是补不完的。** 立上面那条守卫的同一轮，我给它写的
    取材函数漏排了那个短命运行期夹具 ⇒ `test/arch/` 跑 5 次红 1 次，而红的是**取材那一发本身**
    （`Failed Suites`），不是任何一条判据。数下来漏接的有 **4 个**，每一个都是"单跑恒绿、全量偶发红"。
    补完 4 个之后立了两条守卫把"第 5 个"变成**确定性**问题，其中一条踩了个值得记的坑：
    - 第一版判据是"文本里出现那个目录路径 ⇒ 必须接排除名单"，用 `text.includes` ⇒
      两个只在**注释里**举了那个路径的文件双双假红；
    - 换成 `lexTs` 只看代码区 ⇒ 又一个文件因为**把一个 src 路径当测试数据字符串**假红；
    - ⇒ 承认「**从文本猜这段代码会不会读那个目录**」做不到精确，改成**声明式清单**：
      唯一的机器判据是"这个文件调用了 `readdirSync`"（这个谓词没有歧义），清单里每条写明要不要排、为什么，
      **新增一个使用者即红**，逼着做一次决定。**一条会假红的守卫比没有守卫更糟**，
      而这里连着三代假红本身就是这条结论的证据（0055/0056/0057 治的同一件事）。

    **刻意留在暗处的（写在守卫文件头，没写进任何自动检查）**：改名 import 的 spawn 静态扫不出来
    （变异 B5 把它钉成了一条**预期绿**，因为报绿才是诚实的读数）、换成 SDK 调用则整条守卫失效、
    判据只查"探针代码在"不重跑探针。**余量只能靠读它的人** —— 这一句本身就是本篇的主题。

14. **本篇自己的坐标从来没有门禁：一条只有手动跑才生效的核对，就是过期陈述的制造机**（round278）。
    登记到 r13 为止，每一条主张都带一个 `source.line` 指回本篇。核对它的只有
    `.workbuddy/round270-check-coords.mjs` —— 一个**要靠人想起来跑**的脚本，`test/arch` 下
    一条测试都不核它。而 `renderMarkdown` 只渲染「主张 / 方法 / 时刻」三格，**不渲染 line**
    ⇒ 登记表那条「表与渲染逐字一致」的守卫**对坐标是瞎的**：坐标整片漂走，304 发照绿。

    本轮自己就撞了一次：§5.1 插进一段 ⇒ §7 全体下移 35 行 ⇒ **r10/r11/r12/r13 四条同时 STALE**。
    如果没有那次手动跑脚本，这四条会带着错的行号继续留在登记表里，而登记表是这篇用来
    「让过期主张变红」的那件东西。**这是 O14 的自指版本**：治病的药本身没被治。

    **落地的守卫**：`test/arch/claim-coords.ts` + `.test.ts`（8 发）。三条判据的形状：
    - **真仓库那一发**：逐条判「登记的行号上，读不读得到它自己的主张」。
    - **取材非空**：`REGISTRY.length ≥ 13` 且每条都有 `line` 与非空锚点句 —— 没有这一发，
      上面那条可以靠「REGISTRY 是空数组」恒绿，而它读起来与「十三条全对」逐字一样。
    - **锚点句至少命中一处**：否则「对得上」是拿"哪儿都没命中"充数。

    ⚠ **刻意 import `REGISTRY` 而不是正则扫它的源码。** 那个脚本自己的文件头记着三代坑：
    反引号读不到 / 单引号整条跳过 / `id` 只认一位数于是 r10 被**静默跳过**而输出与
    「十条全对」逐字一样。**用一条会静默漏读的正则去核对「漏读」，是拿问题本身当工具。**
    对象化之后「漏了一条」= 数组短一格，是结构性的，不再依赖正则写全了没有。
    口径与脚本保持一致：比对前两边各剥行内反引号与粗体 —— 不剥就是恒 0 命中，
    而「读不到」与「坐标丢了」在输出上长得一模一样（那也是脚本踩过并写在自己文件头的坑）。

    三发变异（`.workbuddy/round278-claim-coords-mutate.mjs`，自回滚 + 逐字节核对）：
    C1 **往 §5 插一行** = 本轮真发生的形状 ⇒ 红 1 发；C2 把某条主张的锚点句在文档里改掉
    （住址没错、句子换了）⇒ 红 1 发；**C3 把判据循环体掏空 ⇒ 红 4 合成发而真仓库那一发不红**
    —— 第三次撞上同一句话：**真仓库那一发对「判据被改成不判」是瞎的**。
    ⚠ C1 刻意打在【文档】上而不是打在 registry 上：改一个行号是人手动犯错，
    插一段让整片下移是**日常编辑的副作用**，而后者才是没人会察觉的那一种。

    ⭐ **这条登记成 r14 之后，当场就抓到了一次它自己治的那种故障**：往 O14 那张表插 r14
    那一行 ⇒ §7 全体 +1 ⇒ **五条坐标同时 STALE**，而这一次没任何人跑脚本 ——
    `claim-coords.test.ts` 自己红了，红话逐条写着「现在在哪」（`…1418 行上读不到…现在在 [1419]`）。
    本篇从 O14 起一直在写「立一条守卫，好让【下一次】不再靠人想起来」，
    而这是第一次【下一次就是这一轮】。

    ⚠ 顺带一条**没做成守卫**的：本轮复跑安装证伪了「依赖装不上」（见 §5.1 末段），
    但那条**刻意不立守卫** —— 它依赖网络，而一条会随机红的守卫比没有守卫更糟（本篇 §7
    第 13 格刚为这句话写过一整段）。正解是 §8 保质期表加一行 + 复算命令。**能立守卫的和
    只能记读数的，分界线是确定性能不能拿到**，不是这件事重不重要。

15. **O8 那条端到端验收写出来了，而它红在【本节假设已经有了】那一格**（round279）。
    O8 正文把「组织侧的写路径全在」当前提，只登记了「新角色是空壳」这一段缺。本轮逐字核过：
    **`POST /org` 提交不了一个新角色** —— 三条独立证据（`packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts`
    的一~三发，全跑真装配 `buildHubDeps` + 真 HMAC + 真异步备份 worker + 真 `commitOrgGraph`）：

    | 证据 | 判的到底是什么 | 今天的读数 |
    | --- | --- | --- |
    | ① 契约形状 | `orgChangeSchema` 认哪些 kind | 只有 `reparent` / `add_edge`；`add_node` 与「`add_edge` 捎带一个 `node`」都被 `.strict()` 拒 |
    | ② 提交路径 | 一个新节点进库之前有没有判据过手 | **没有。** 随一条与新节点**无关**的合法 `add_edge` 提交 ⇒ **200**，那个节点连 `model_family` 缺着也进了 `graph_json` |
    | ③ 出口 | 有没有界面发得出组织变更 | `packages/web/src` + `packages/desktop/src` 里 `add_edge` / `reparent` **零出现** |

    ⭐ **② 是本格唯一值得抄进决策清单的一条**：它不是"实现差一点"，是**一条缺判据的旁路**。
    `commitOrgGraph` 落库的是【请求体那张图】，而 `revalidate` 只按那两个 kind 分派 ⇒
    新节点不在任何一关的射程里（§18.3 三关判的是边与汇报关系）。于是"不加代码就能加角色"这件事
    有一个**看起来已经通了**的假实现路径：拿 200 当验收。旁路进来的角色运行时会卡在
    `unknown_model_family`，而保存期那条 `violatesNoSelfReview` 明明会说它不可用 —— **同一张图，
    两个入口，两种答案，而 200 那一侧才是真的那条路**。修法因此不是补播种，是给契约加
    一个**带判据的** `add_node`（属改契约，O8 动作里一格都没有）。

    **后三跳是真走得通的**，且断言抓在生产通道上：播种（真 `runSeedCli`、真库、退 0）→
    新任务钉在**提交后那一版**图上、引擎把活 handoff 给一个**不在 `NODE_TO_TEMPLATE` 里**的角色 →
    **那一轮经 `dispatch → runTurn` 递出去的身份提示词**里有它自己那条标准。第四跳刻意不写成
    「我自己调一次 `rolePrompt`」—— 变异 M4（`rolePrompt(task.role)` 改成写死 `"intake"`）
    把它钉成了**必须红**，那一发确实红 ⇒ 断言吃的是引擎真的递给 harness 的那一份。

    **反空转按 §7 第 6 格那句警告做成两个角色的对照**（不是加一句否定断言）：
    `data` 名字进了图但没播种 ⇒ 提示词里是「hub 里【没有你的岗位书】」、一条标准都没有；
    `translator` 同一条链播过 ⇒ 标准进来了。差别只有「有没有给它签过一份岗位书」。
    ⚠ 外加一发**前提自证**：钉住这两个名字不与任何模板文件名 / `NODE_TO_TEMPLATE` 的键相同
    （名字一旦撞车，那条对照会悄悄变成假绿 —— 变异 M6 当场把它打红，红在**两**发）。

    六发变异（`.workbuddy/round279-o8-acceptance-mutate.mjs`，自回滚 + 逐字节核对）逐条命中预测：
    M1 空壳那句换成空串 ⇒ 红 2（反空转 + 占位串）｜M2 占位串判据 `> 0` 改 `> 1` ⇒ 红 1
    ｜**M3 给提交路径补上新节点的 `model_family` 校验 ⇒ 红 1（那条 200 变 422）**
    ｜M4 身份提示词写死角色 ⇒ 红 1 ｜M5 渲染器不渲染任何一条真标准 ⇒ 红 1 ｜M6 预设名挤进 `translator` ⇒ 红 2。
    **M3 是这一族里唯一"改了生产代码让它变好，于是测试红"的那一发** —— 它证明证据②读的是
    真校验路径：将来谁补上这条判据，这一发会红着提醒他**同步更新那条主张**，而不是留着它继续说 200。

16. **Task 2.9 那道 Playwright 门落地了，而它把「批准即 DELIVERED」这句验收句证成了不成立 ——
    这一格是【待 CEO 决策】，不是【已达成】**（round291）。

    先说落了什么：`test/e2e/ceo-loop.spec.ts` + 根 `playwright.config.ts` 建出来了，
    playwright/@playwright/test@1.65.1 进根 `devDependencies`，根 `package.json` 加了
    `pnpm test:e2e`。`npx playwright test` 实测 **1 passed / 1.5 s**（两次连跑复现，
    跑完 `netstat` 复核过 8899/9899 上没有残留监听 ⇒ 不是被哪个探针进程代打的）。

    ⭐ **但计划那句验收原文的最后一格没有走通**。原文是
    「输入想法 → 看板出现卡片并流转 → 收件箱出现审批 → 点击批准 → **看板更新为 DELIVERED**」。
    spec 逐字做到的是「…点击批准 → 看板更新为 **CHARTER_APPROVED**」。原因不是 spec 偷懒，
    是代码的形状：`packages/hub/src/engine/dispatch.ts` 的 `HUMAN_EDGES` 里，批准这个动作
    本身**完成** CHARTER_PENDING → CHARTER_APPROVED 这一跳；再往下的
    CHARTER_APPROVED → DECOMPOSING → IN_PROGRESS → … → DELIVERED 全在 `AGENT_EDGES`，
    只有真 Claude 子进程或驱动器推得动 —— **浏览器里没有任何一处点得动它**。
    ⇒ 「一个人不碰命令行就能把想法推到 DELIVERED」这句话，在今天的代码里要求**开着那两个泵、
    真起子进程、真花钱**。它不是一个测试缺陷，是产品口径：要么承认门禁必须含一次真花费，
    要么把验收句改成它实际描述的那个人类闭环。**两难都在 CEO 那一侧**，所以登记不实现。

    **口径纪律（本轮为此付的代价）**：spec 里唯一被替换的一步是章程起草那一次 `runTurn`
    （门禁不能花钱，同一台机器重复跑同一条命令不该产生账单），候选 SQL / 组织图门槛 / 建卡 /
    审计行 / 幂等 / 收件箱读 / 批准写**全是真的**；代价照 `assemble.ts` 那条既有口径写明
    「不证真 runtime 起得了子进程」。**牙齿用变异量**：`.workbuddy/round291-mutate-ceo-loop.mjs`
    命中 **6/6** —— 不点批准⇒红、起草角色不在组织图上⇒红（红话是「卡片不是起草出来的」，
    不是"没找到卡"）、两侧 token 不一致⇒红、把最后那条断言掏成恒真⇒**必须绿**（反向 canary）、
    zod 挂载退回硬编码⇒红。

    **顺手抓到一个比门禁本身更值钱的真缺陷**：`packages/web/src/dev-server.ts` 把 zod 挂在
    `join(ROOT, "node_modules/zod")`，而 pnpm 的 isolated linker **从不创建根 `node_modules/zod`** ⇒
    `/vendor/zod/*` 恒 404 ⇒ 浏览器模块图在第一跳就断 ⇒ **整页白屏，而服务端日志一个字不多**
    （404 只进响应不进日志）。它的红形是【超时】不是【404】—— 安静到这个程度的缺陷，
    靠"打开看看"永远查不到。修法是 `createRequire` 从 contracts 包解析 zod 的真实目录，
    解析不到就抛并写明"先 pnpm i"。**教训**：在 pnpm 仓里【照着 node_modules 描一条路径】
    是错的，不只是脆的。

17. **装上一个 runner，会让 biome 在全仓启用它那一族规则，而它撞的是一个私有的同名函数**（round291）。

    装上 `@playwright/test` 之后 `pnpm lint` 冒出 4 发基线外的 error
    （`lint/correctness/usePlaywrightValidDescribeCallback`），位置在
    `test/arch/comment-citations.ts` —— 一个**私有的、没导出的**格式化函数 `describe(citation)`，
    与测试运行器毫无关系。A/B 实测（同一个二进制、同一个版本、同一个文件）：
    根 `package.json` 含该依赖 ⇒ 4 发；摘掉 ⇒ 0 发。⇒ 规则的开关是**依赖声明**，不是文件内容。

    修法选**改名**（→ `describeCitation`），不在 `biome.json` 里关掉那一族：关掉会连
    `test/e2e/*.spec.ts` 里【真的】误用 `test.describe` 也一起放过，而那条规则恰恰是为
    本轮新建的 spec 准备的。**登记这一格的理由**：下一次装任何带 lint 插件的依赖
    （vitest 的、react 的、jest 的），都可能在全仓启用一族新规则并撞在毫不相干的私有函数上 ——
    先想到"是依赖启用的规则"，别去改那个无辜的文件。

18. **round279 把「那条旁路没有判据」写成了一格【永久事实】，而它只是当时的实现状态。**
    同一篇的 r15 主张、O8 的 round279 注、那发验收测试的证据②，三处都写着
    「一个新节点随一条无关的 `add_edge` 提交能拿 200 进库，全程没有判据过手它」。
    round292 兑现了 r15 的 method 里预先登记的那一发（「给提交路径补上新节点的
    `model_family` 校验 ⇒ 那条 200 变 422」），三处同批改口。

    **这一格值得单列的不是修了什么，是我自己先写错的那一版。** 判据第一版写成
    「只判 after 相对 before【新增】的那些节点」—— 听着比"整张图"更精准，
    而它【当场恒真】：`applyChangeToGraph` 对 `reparent` 只改 `reports_to`、
    对 `add_edge` 只 append 一条边，**两种 kind 都不往 `nodes` 里加东西** ⇒
    偷偷塞进来的节点在 before 里【也在】⇒ 差集为空 ⇒ 拦不到旁路，
    也对任何一次正常提交放行。它不会报错，只会安静地什么都不判。
    证人不是我的推理而是变异 **M6**（`.workbuddy/round292-mutate-org-node-criterion.mjs`，
    把生产代码换成那一版"更精准"的写法）⇒ 端到端那发与 commit 层那发【同时红】。
    ⇒ 泛用的那条：**"把守卫的作用面缩小到这次改动涉及的对象"是一次【看起来在收紧】的放松**，
    凡遇到这种写法先问一句「被保护的那个东西，会不会本来就藏在作用面之外」。

    **另一发记下来是因为它【该绿】：M2（判 `before` 而不是 `after`）是变异等价的**
    —— 正是上面那句"`applyChangeToGraph` 不碰任何 `model_family`"让两种写法恒同解。
    所以「判 after」不是这条守卫可靠的原因，可靠的原因是它判**整张图**（M5/M6 才是证人）。
    把它留成矩阵里一发 expectRed:false，是为了让下一个人重新看到这一格时
    有实测可依：哪天 `applyChangeToGraph` 开始改 `model_family`，M2 会翻红，
    那时"判 after"才开始承重。

    ⚠ **这一格没有把 O8 第一跳做完。** ~~契约里仍然没有带判据的 `add_node`（证据①未变），
    两个前端仍然零出口（证据③未变），而声明了 `model_family` 的新节点
    随一条无关的 `add_edge` **照样进得了库** —— 那发反向 canary 钉的就是这一格。
    读成「不能通过请求体加角色了」是误读，那等于让实现层替 CEO 关掉
    「不改代码就能加角色」这条产品目标。现在的准确说法是
    **旁路还在，但它不再是无判据的旁路**。~~

    ⚡ **round294 部分撤回**（原文保留在上面，按 0007 §4.1）。上面那句「契约里仍然没有
    带判据的 `add_node`」到 round294 为止是**假的**：`orgChangeSchema` 现在有第三种 kind，
    节点本身过 `validateNewNode` 五条判据（重名 / 自环 / 上级 / 深度 / 森林）。
    剩下那半句**仍然真**，而且**本轮一字未动**：旁路还在，声明了 `model_family` 的
    图片节点**照样**随一条无关的 `add_edge` 进库 —— 那发反向 canary 今天还在原地绿着。
    ⇒ 这一格的错法值得单列：**一句话里「仍然没做」的那半句和「仍然能做」的那半句，
    有效期可以差好几轮**，而它们写在同一个句子里，于是修掉前者的人常常连带撤掉后者。
    本轮的写法是**逐半句判**：删掉前者、原样重写后者。
    新的一格见下面第 21 格（`add_node` 落地时**我自己**踩到的那三处）。

    ⚡ **round295 再撤回一句**（同一份原文，按 0007 §4.1）：上面划掉的那段里还有一句
    「**两个前端仍然零出口（证据③未变）**」—— 它和①那一半的失效方式**不一样**，
    ①是「过期」（那天真、后来被改动改假），③是**从写下那天起就没真过被验的那格**。
    `packages/web/public/app.js` 从 2026-11-11（`git log -S` 追到 `2bcbdb0`）就在真发
    `kind: "reparent"`，而证据③ 的扫描**根**只列 `packages/web/src` 与 `packages/desktop/src`、
    **扩展名**只筛 `.ts`/`.tsx` ⇒ 真控制室**不在它的视野里**，于是它连着六轮**绿着**替那句假话作证。
    ⇒ 现在准确的说法是**界面发得出 `reparent`**：证据③ 已翻成**正向点名**
    （`{reparent: [app.js], add_edge: [], add_node: []}` + 引号形状 + 扫描器自身的反向 canary
    +「构造了载荷 ≠ 发得出去」那一发）。
    ⚠ 它**不**等于「O8 第一跳通了」：desktop 侧 `channels.ts` 明确拒绝那条 POST 通道，
    浏览器里真点一次在本机**没有证据**（0039）。
    ⇒ 这一格买到的泛用那条：**「量过」不等于「量对位置」**。
    同一条判据里那句「取材非空」的下限当天**也通过**（实测 `web/src`=4 + `desktop/src`=7 ≥ 5），
    一个数过关而它量的位置不含那件能推翻主张的事 —— 比"没测"更难看出来，因为它带着测量的样子。
    现在那道下限换成了**成员点名**（取材表里必须列出 `web/public` 与 `.js`，读不到那段字节就红）。
    六发变异见 `.workbuddy/round295-frontend-egress-mutation-evidence.txt`（命中 6/6，自回滚）。

19. **一条【自称已交付】的口径，只要没人跑过，就等于【没交付】。**（round293）

    O14 动作 3 的原文是「§1 那张表里的数全部标了『口径 + 复算方法』」，§8 末还补了一句
    「所以每个数都配了复算方法而不是配一个豁免」。两处都在**过去时**地声称这件事完成了，
    而 §1.1 自己写着「复算脚本…（**不写进仓库**）」—— 所谓复算方法是**一段描述**。
    ⇒ 本篇最像自省的那一节，犯的是本篇通篇在治的那个错：**一句话在写下的那天像是
    一个交付，之后一直没人跑过，于是它替所有人维持着"这事做了"的印象。**
    第一次真跑 `npx tsx test/arch/census.ts`：83→92、35216→40871、108→135，**四条里三条直接对不上**。

    **最坏的是第四条「看着没变」。** 表上那条 11 的口径是「零 importer 且**排除入口**」，
    今天按这条口径跑出来是 **7**；而全量零 importer 今天**恰好也是 11**，成员却是另一批
    （多出 `cli.ts` 那几个 scripts 入口 —— 它们天然零 importer 而**不是**死代码）。
    ⇒ 泛用那条：**一个数"没变"不证明它还是那件事。** 复算必须连**成员**一起对，
    只比数值会把一次口径漂移读成一次"稳定"。

    **三条口径坑，本轮各犯了一次**（都写进脚本注释与测试，不只在文档里）：
    ① 我又用 `grep 'store\.js'` 找调用方，匹到的全是**别的** store —— §1.1 那条"33 个死模块"
    就是这么来的 ⇒ 脚本复用 `dead-modules.ts` 的同一个解析器，绝不另起第二份；
    ② 我以为 `split("\n")` 与 `wc -l` 等价、还断言"三行文本 ⇒ 3" —— **连差值方向都算反了**
    （`"a\nb\nc\n"` split 给 4，wc 给 3），实测 `harness/verifier` 是 725 vs 724；
    ③ 我一度把「纯类型 import 不算边」做成第二条口径，名单从 11 涨到 18，
    里面塞满 `http/server.ts` 这种**活着且被动态加载**的模块 ——
    因为同一个文件对同一个说明符**同时**有 `import type` 与 `await import` 两条边，
    **按说明符做减法会把真运行时那条一起抹掉**。⇒ 边的性质只能按**每一次出现**判。
    那条口径已删，只留诊断，理由记在 `census.ts` 的字段注释里。

    ⚠ **这一格没有修好任何东西。** §1.1 与 §8 表上的旧数**按原样留着**（§1.2 第 3 条家规：
    那张表是那一次测量的读数，改数＝伪造那次测量）；新增的是**一条能跑的命令**与
    一块"现跑读数"。`census.ts` **只测量、不判定**（恒 exit 0，只有解析器自报悬空说明符才抛）——
    恒红的复算命令等于恒不可能通过的断言，人会学会跳过它。
    它的 12 发里有两枚反向 canary（解析器退化成零条边 ⇒ 红；`unresolved` 写死 0 ⇒ 红），
    因为「真仓库给出 0」这一发**自己分不出**"真没有"与"没在数"。

20. **一句写着「今天」的读数，没有作者续约义务。**（round293 第二段）

    上一格落地后顺手复测本篇自己的「今天」，两处当场是假的：

    ① **§10 第 10 格表里那三句**（`test/e2e/` 目录不存在 / playwright 不在任何
    `package.json` / 全仓 `*.spec.ts` 零条）——**三句全假**。本轮 `ls` 现数：目录在、
    两个包都在根 `devDependencies`（且 `scripts.test:e2e` 就是 `playwright test`）、
    `*.spec.ts` 有一条。这三句是 round276 写的，round291 建工件时**只建了东西、没来改这句**
    ⇒ 一句「今天」的实际有效期是 **15 轮**。
    ② **§5.1 Task 4.7 那半句**「发卡那一路零生产调用方」——**假的**：投递台账在 r17 就接进
    心跳了，调用点在 `packages/hub/src/serve/im-channels.ts` 的投递那一跳（本轮 `grep` 现数）。
    ⇒ 那一格的归因连改三次：「无从接」→「接了推不出去」→ **只差真凭据**。

    ⚠ **机制比读数值钱，而这三句假话的机制和 round290 那条「为不存在的守卫作证」是同一个**：
    `plan-gate-paths` 的判据读的是**计划正文**，不读守卫自己的文件头注释。所以注释里那三句
    「当时没建」过期得**无声无息** —— 证人写在注释里，而**注释没有读者**。
    ⇒ 泛用那条：**注释里的读数不参与任何判定，它就一定会过期**；要它不过期，只能把它
    挪进一条会红的断言。本轮就是把 `plan-gate-paths.ts` 文件头那段过期叙述**当面拆掉**，
    并把账挪进判据。

    **落地的东西**（`test/arch/plan-gate-paths.test.ts`，10 → 11 发）：豁免那份账从
    「上下界」（`>0` 且 `≤2`）**换成钉死**——计数恰好 1 + 活着的那一条必须点名
    `mobile-approval.spec.ts` + 每条豁免必须**真的**豁免掉一条不存在的路径（贴在
    「路径全都在」的位置上算死的豁免，红）。原来那两个界是**单向**的：往上加一条会红，
    **往下被静默摘光反而不红**（0 满足 `≤2`），而摘光之后那条红话长得像「计划里有个路径写错了」，
    不像「有人动了豁免」——这一格只有钉死才分得开。
    ⭐ 配一发**反向 canary**：合成语料给两条标记 ⇒ 必须数出两条。少了它，一个恒返回「一条」的
    坏计数器（`filter` 写成 `find`、或 map 前多一个 `slice(0,1)`）在真仓库那一发上**照样绿**。

    **五发变异全部命中预测**（`.workbuddy/round293-mutate-gate-exemption.mjs`，改的是
    **真文档 + 真守卫字节**，自回滚 + 逐字节核对，单独跑）：M0 控制组该绿 /
    M1 把标记从 mobile 那格挪到 `ceo-loop` 那格（路径存在）⇒ 红 2 / M2 静默删掉最后那条
    ⇒ 红 2 / M3 把 filter 换成恒真 ⇒ 红 1 / **M4 只改那一格的散文措辞 ⇒ 该绿**
    （绿的这一发画的是判据的边界：它对无关文案不敏感）。

    ⚠ **这台机器自己错了两处，而两处都伪装成「被测对象的问题」**：
    ① 剥 ANSI 的正则我写成 `/\[[0-9;]*m/g`——**少了 ESC**。它剥掉了 `[2m` 却把 `0x1b`
    留在行首，于是 `/^\s*Tests\s/` 对着一行真汇总判不中，报「读不到 vitest 汇总行」。
    看着像 vitest 没跑，实际是我的剥色正则没剥干净（**vitest 给汇总行上了色**）。
    ② `catch` 里无条件把 `err.stdout` 交给汇总解析器 ⇒「vitest 根本没起来」和
    「起来了但读不到汇总行」长成同一个错，真诊断被吞。
    ⇒ 泛用那条：**凡是「用正则读别人的输出」的脚本，先拿一次真输出验那个正则，再谈变异结果。**
    同一族的第三次（round283 是 `.mjs` 里写 TS 类型标注）。

    ⚠ **第三条同族的坑，落在判据自己身上**：r21 那条判据第一版核的是
    `includes(NOT_BUILT_TAG)` 这个**片段**，而它在守卫文件里有**两处**（`missingGatePaths`
    里那句 `if (…) continue`，和 `exemptedBlocks` 的 filter）。摘掉 filter 喂给判据 ⇒ **绿**。
    改成核**整条 filter 表达式**才红。**与上一格 r20 之二逐字同形**（那里抹的是 import 列表里
    的 `collectModules,`，而函数体里还有 `collectModules(root)`）—— ⇒ 泛用那条：
    **「文本在场」从来不等于「我要守的那一格还在」；核一个片段，先数它在靶子里出现几次。**
    本轮把这一条同时做成了判据（改窄就红）和一发变异（打了它并实得红）。

    ⚠ **射程**：① 两处过期读数是**本轮人肉复测**抓出来的，没有任何守卫判「这句话过期了」——
    能钉住的只有豁免那份**账**（条数与身份），钉不住散文。② 新读数写的是「盘上有 1 个 E2E」，
    而 `git ls-files "*.spec.ts"` 今天仍是 **0** ⇒ 「仓库里**有**一个 E2E」与
    「仓库里**跟踪了**一个 E2E」是两条主张，本轮之前两条都假，现在第一条真、**第二条仍假**。
    ③ Task 2.9 / 4.7 那两道门**依然没过**：2.9 缺「更新为 DELIVERED」那一跳（CEO 决策面），
    4.7 缺真飞书沙箱 + 真凭据。本轮只把「为什么没过」那一格的归因改对了，
    **别把这张表读成「门近了」**。§5.1 与 §10 那两处已按 0007 §4.1 的规矩用删除线保留原文，
    新坐进 `doc-refs` 的那一枚快照坐标是**反向活坐标**：投递那一跳若被人从心跳里摘掉，
    快照红 ⇒ 逼他重读那一格，而那时「只差凭据」会重新变成假话。

    **round293 第二段落地并登记为 r21**（判据核的是：守卫与测试在场、豁免那份账还在数
    标记而不是数散文、`toBe(1)` 那枚钉还在、且那发能数出 2 的反向 canary 还在 ——
    它**不重跑** `existsSync`，口径同 r12）。

21. **一条断言在语义翻转后仍然返回绿，比一条红更贵。**（round294）

    第 18 格点名的修法本轮落地了：`orgChangeSchema` 加第三种 kind `add_node`（载荷只有
    一个完整节点，**故意不带边** —— 边要单独过一次 L2，§8.2 第 4 条的门控不能被一次 L1
    操作捎带），contracts 侧新增 `validateNewNode` 判六条（重名 / 自环 / 上级不存在 /
    上级不收汇报 / 超深 / 森林），hub 侧 `revalidate` 与 `applyChangeToGraph` 各加一条分派。
    `multiple_roots` 是本轮唯一**新造**的 code：它此前只在运行时长着
    （`engine/dispatch.ts` 的 `resolveCeoRoleId` 遇到森林拒绝跑，而一轮就是钱），
    把它同时挪到保存期，是因为「谁是 CEO」在点保存那一刻就能算出来。
    ⚠ 判据是「加完之后根**多于一个**」，不是「它是根」—— 空图加第一个节点时
    `reports_to=null` 是**唯一**合法写法，写反了就是第一格永远加不进去。

    **最贵的一格不是新写的判据，是被本轮改假的那一发。**
    `packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts` 的证据① 断
    `orgChangeSchema.safeParse({kind:"add_node", role_id:"translator"}).success === false`。
    本轮之后它**照样绿**，而绿的原因从「契约里没有 add_node」换成了「缺 `node` 字段 +
    `.strict()`」。⇒ **一条绿在别的东西上的断言，会让下一个人照着「只能走旁路」去设计。**
    这一族与 round290 那条「为不存在的守卫作证」相邻，但方向相反：那里是守卫没了、断言还在；
    这里是**断言的靶子还在、它要拦的那件事没了**。
    ⇒ 泛用那条：**每改一次语义，就把自己写过的反向断言逐条重问一遍「你现在为什么是绿的」。**
    本轮把那一发**翻向**（正向断完整节点可解析，反向换成形状：扁平写法 / 捎带边 / add_edge 捎带节点），
    原文留在函数注释里而不是删掉。

    **第二格：修好一处，会让另一处的旧理由过期。**
    `everyNodeDeclaresModelFamily` 的函数头把「为什么判整张图而不是判新增节点」建立在
    「`applyChangeToGraph` 两种 kind 都不往 `nodes` 里加东西」上。`add_node` 是第一个真加
    节点的 kind ⇒ 那句前提**过期了**，而**结论仍然对**（判整图买的是「缺家族是绕过同家族
    拦截的通路」，与是不是这次新增的无关）。函数头已改口并把这一格留在那里。
    ⇒ 泛用那条：**读到一条【理由】支撑的判据，改完前提要连结论一起重推** ——
    连结论一起丢掉是砸掉一条真守卫，连理由一起留住是留一条假论证。

    ⚠ **这台机器本轮自己错了四处**：
    ① 我在拒绝矩阵的前提里断言 `director.can_manage === false` —— **假的**，
    `baseGraph()` 那个 helper 的 `canManage` 缺省 `true`。**被我自己刚写的「前提自证」那三行
    当场抓出来**，那是这一族第一次在**写下的同一轮**就买回票价（此前它抓到的是别人几轮前写的）。
    ② `SELECT … FROM events ORDER BY seq` —— 那一列叫 `id`（`appendAudit` 返回的变量叫
    `seq`，它就是 `events.id`），拿到的是 `no such column`，红在一个拼错上。
    ③ 又一次对**空表**调 `latestGraph()` ⇒ `TypeError`。**本文件上面 60 行处已经为这个坑
    写过一条注释，我又踩了一次** —— 因为那条教训写在【那一发】旁边，没写进【那个 helper】
    的函数头。⇒ 泛用那条：**一条"别这样调我"的教训，只有写进被调那一侧才算立住。**
    ④ 拒绝矩阵里"往夹具里塞一个第 5 层节点"那种写法**不会有任何东西变红** ——
    它换来的绿与「判据在真提交路径上通过」长得一模一样。形状改成 `pad`（先真提交几次
    `add_node` 垫出前提层，再让最后那次被拒），并钉「最新图逐字等于请求里那张 before」，
    比「图上不含那个 role_id」更强，且对**重名**那一发不会退化成一句跳过。

    ⚠ **本轮去找了一格，确认它没有判据，本轮没修**：`orgGraphSchema.nodes` 是
    `record(role_id → node)`，而 zod 的 record **不比对键 === 值里的 role_id**。
    所以「键 `a` / 值里 id `b`」这种图三条判据（schema / `rejectMalformed` / `validateNewNode`）
    **全部放行**，而它进库后是一条被覆盖的已有角色 + 一个孤儿节点。
    已钉成一发**期望绿**的登记（`test/org/validate.test.ts` schema 那一节），
    它不拦任何东西，只让「这里没人判」这件事有一条能重跑的证据。
    修法在 zod 那一层，本轮**不做**：它收紧的是既有形状，会让一张已有不一致的库图
    在**读取期**就红 —— 那是另一件事，需要单独一次决策。

    **第三格：变异机器给【判据本身】补了一颗牙，并当场否证了我自己登记的两条预期。**
    `.workbuddy/round294-mutate-add-node.mjs` 十发命中 10/10（证据
    `.workbuddy/round294-add-node-mutation-evidence.txt`）。它比 round292 那台多做一件事：
    逐文件记【谁红、谁不该红】，而不是只数红了几发。三件事因此被量出来而不是被我猜出来：

    ① **M8 逼出了判据缺的那一格。** 它把分派写成 `else if (false && change.kind === "add_node")`
    —— 那句 `validateNewNode(change.node, graph)` 的字节**还留在文件里**，只是永远走不到。
    端到端当场红，而 r22 的判据【那一版】不红：它只查"调用在不在"。
    ⇒ **「调用还在」不等于「那条分派活着」**，与 r20 之二（抹 import 那一行而函数体里还有同名
    调用 ⇒ 得手一个绿）是同一条教训的两个相反方向。判据现在多判一条：分派**条件**本身要真。
    这一格是这台机器本轮最实在的产出 —— 没有它，r22 会是一颗看起来有牙其实没牙的判据。

    ② **我按印象登记的「端到端不该红」被实测否证。** M4（摘掉自环那一判）我写的是
    「端到端没对自环单独断 code ⇒ 它不该红」；实测端到端**也红**，因为那发拒绝矩阵
    **逐条断 code**，自环那一发断的正是 `would_create_cycle`。
    ⇒ 泛用那条：**写归因表之前先读那张矩阵，别按印象登记谁红谁不红。**
    反过来 M5（丢掉空图例外）端到端确实不红 —— 因为矩阵里"多出一个根"那一发照样拿
    `multiple_roots`，而**空图**那一格端到端没有。⇒「第一格永远加不进去」这句话**只有单测在看**。

    ③ **M3b 差点让我登记一条假的"没测"。** 它换掉重名理由里的措辞、预期该绿。我第一版把
    替换串写成完全不含 `reparent` 的一句话 —— 而 `test/org/validate.test.ts` 有一条断言
    `reason` 含 `reparent`（那句「reason 要指路」是我本轮自己写的）。它当时会**红**，
    而我大概率会把它读成"这台机器不干净"，进而把 M3b 整发删掉 ——
    那就等于把「指路关键词有人钉」记成「文案没人钉」。
    ⇒ 真正被量出来的结论是：**这一族里指路关键词有人钉，其余句子没人钉。**
    一句话【我以为没测】与【实测没测】之间，隔一次真跑。

    ⚠ **这台机器也给自己装了一发反向 canary**：喂它一段合成的绿摘要与一段合成的红摘要，
    逼它数出红发数与那**两份文件名**。"不该红的文件"这句话的全部价值取决于那个文件集合
    读得出东西 —— round292 那台把红读成绿过一次（漏剥 ANSI），而那一次红发被读成 0；
    如果归因那个正则恒数出**空集合**，`mustRed` 会红着报错而 `mustGreen` **恒成立**，
    于是本轮新增的那一半能力会安静地变成废话。

    **第四格：我写的两发"反向对照"是空转的，而它们绿的形状与判据真生效一模一样。**
    r22 判的是**剥掉注释之后**的字节，为此起了两发反向对照（同样的字节只写在注释里 ⇒
    该绿）。两发都绿，我据此在注释里写下"两个洞的方向各由一发钉住"。这句是**假的**，
    假在两处、互相掩盖：
    ① **那两发根本没钉洞。** 洞是"剥注释会吃掉真代码"，而"注释里的字节不算代码"是
       剥注释**做对了**的样子 —— 反向对照证的是前者还是后者，方向不同。
    ② ⭐ **更要紧的是它们连靶子都没打到。** 我把字节注在**函数头之前**，而判据取的是
       `validateNewNode` 那一段（从函数头起到下一个 `export function`）⇒
       **注入的字节从来没进过切片**。实测核对：注在函数头之前 ⇒ 那一段里读不到那些字节。
       于是这两发对**任何**实现都返回绿 —— 一只恒绿的假证人，而它长得像"有反向对照"。
    ⇒ 泛用那条：**反向对照必须自带"我确实打到了"的位置自证**；一条注入型用例如果不
       断言注入落点，它的绿与"这个特性根本不存在"不可区分。
    修好的形状：字节改注**函数体内**（`  const roleId = node.role_id;` 那一行之前，
    本轮实测全文件唯一），每发配一条 `indexOf(注入串) > indexOf(函数头)` 的位置自证。
    顺手把那两个洞**登记**下来了（`之九·乙` / `之十·乙`，绿的形状本身就是证据），
    各配一发**单变量对照**：只把那两个斜杠拿掉、真判据原样留着 ⇒ 那一发必须红。
    ⚠ 洞②的方向我原先写成【假红】，量出来是【假绿而且宽得多】：块注释收尾被吃掉后，
    懒匹配不停在原地而一路吞到**下一个真收尾**（`heightBelow` 的 JSDoc），实测连坐吞掉
    `role_exists` / `would_create_cycle` / `multiple_roots` / `depth_exceeded` 四判的字节
    ⇒ 整条判据隐身。**登记一个洞之前先把它的方向量出来** —— 写错方向的登记会让下一个人
    去防一支根本不存在的箭。

    **顺手量到的三处口径不一致**（都不是测试，是我自己写下的分母）：
    `validateNewNode` 判的 code 实际是 **6** 个（`role_exists` / `would_create_cycle` /
    `multiple_roots` / `unknown_role` / `parent_not_manager` / `depth_exceeded`），
    而文档与测试标题写着"五条"（把上级那两判并成了一格）；r15 的 method 把
    "键 ≠ role_id" 那一发算进了 L1 那一节的 12 发里（它是 **13** 发，而那一发属
    schema 那一节，口径不同）；r22 的 method 写"十三发"合成变异，实际 **16** 发
    （五·乙 是 M8 之后补的，两个洞是本轮第四格补的 —— 分母没跟着走）。
    ⇒ 泛用那条：**改一批发作，登记里所有"几发"都是候选过期主张**，它们不会自己变红。



    **round294 落地并登记为 r22**（判据核的是：三种 kind 都还在判别式里、hub 那两处
    分派**仍在真调判据**而不是只剩一条注释、`validateNewNode` 仍不判 `model_family`
    —— 分工不许漂；它**不重跑**任何端到端请求，口径同 r12）。

22. **一个数过关，不证明它量的位置含那件能推翻主张的事。**（round295）

    第 15 格那三条证据里的 ③「两个前端零出口」连着六轮**绿**，登记表里那条还写着
    「③ 仍然真」。今天量出来：`packages/web/public/app.js` 从 2026-11-11 起就在真发
    `kind: "reparent"`（`git log -S` 追到 `2bcbdb0`，那一发至今在生产代码里）。
    那发证据扫的是 `packages/web/src` + `packages/desktop/src` 的 `.ts`/`.tsx` ——
    **根少一个、扩展名少一种**，真控制室不在视野里，于是"零出现"是**读不到**换来的。

    **最贵的是它旁边那条守卫也过了。** 登记 r15 的判据里有一道非空下限
    （三个前端根里 ts/tsx 数 ≥ 5），当天实测 `web/src`=4 + `desktop/src`=7 = 11 ⇒ **通过**。
    它确实量了、确实报了数、确实拦得住"目录整个被删"，而它对"量的面窄了一格"**全聋**。
    ⇒ 泛用那条：**下限类判据只防"没有"，不防"看错地方"**。
    一条主张的取材面要能被核对，得写成**成员点名**（那张表里必须出现 `web/public` 与 `.js`，
    读不到那段字节就红在"取材面不可核对"），而不是一个可以被 11 满足而 0 才红的数。

    **本轮为这一格补的牙齿**（`.workbuddy/round295-mutate-frontend-egress.mjs`，命中 6/6）：
    M0 控制（行尾加空注释，该绿）/ M1 `reparent`→`add_edge` / M2 摘掉那次 `api("POST","/org")`
    调用（载荷照旧构造）/ M3 kind 改成带尾空格的 `reparent ` ⇒ 三种 kind 谁都不落 /
    M4 注释里写**带引号的** `"add_edge"`（射程边界）/ M5 同位置写**不带引号**的 add_edge（该绿）。
    M3 是唯一能证「那两格空名单会红」的一发 —— 没有它，`{add_edge: [], add_node: []}`
    是判据还是恒绿，读代码分不出来（§7 第 6 格那一族的又一实例）。

    **两台机器各自撞出来的洞，都比本轮那个假证人更贵**：
    ① 第一版矩阵（那时只有 M0–M4 五发）**0/5 命中**、五发全读成"红发=0"。真因不是变异：我新写的那发里
    `const consoleText` 与上面重名 ⇒ 整份测试**装载期解析失败**，vitest 的 `Tests` 行照报
    "红发 0"（一个用例都没跑到），只有 `Test Files` 那行写着 1 failed。
    ⇒ 只读 `Tests` 摘要的机器，可以在**一发都没测**的状态下把整张矩阵报成命中。
    本轮那台的 `readSummary` 改成并上 `Test Files`，并加一条"文件红而读不到 FAIL 文件名 ⇒ 抛"
    （加之前先量了真输出：普通一个用例红**也**打 ` FAIL  <文件> > <suite> > <用例名>`，
    所以那条抛不是只对本机装载失败成立）。⚠ **round292/293/294 那三台的 `readSummary` 是同一形状，
    这个洞仍在它们身上** —— 不顺手改：那三台的证据文件已交出去，改了要重跑才敢说"修完仍然 7/7"。
    ② M4 第一版写成"注释里提 add_edge 三个字 ⇒ 该红"，跑出来 0 红 —— 真口径是
    正则**两侧要引号**（`["'`]kind["'`]`），裸词不算发变更 ⇒ 那发是**空变异**，
    而错的**预期**被我登记成了"射程边界"。⇒ **矩阵里"该红/该绿"的预期也是主张，
    它没有自证，只有跑出来的红绿分布能打它**；口径写宽了，下一个人会照着错的口径去改判据。

23. **一条测试可以绿在【另一个洞】上 —— 于是修掉那个洞会把它变红，而那红不是回归。**（round296）
    起因是一次换 checkout：为了核"HEAD 那三个提交在新 checkout 里跑得起来吗"，我把仓库用
    `git worktree` 开到 `%TEMP%` 下跑了一遍 `test/arch`。红的那一发是「路径三种写法归一到同一个
    目录」，`AssertionError: expected 1 to be 4`，红的样子完全像**归一逻辑坏了** —— 而归一逻辑没
    坏，坏的是**夹具假设了自己站在 `D:\item\opc`**。这台机器上它绿过几千次，因为那个假设天天成立。
    顺着"夹具假定仓库在哪"扫了一遍语料（`test/**` 74 份，14 处盘符绝对字面量），量出三格，
    其中第二格才是本轮最贵的：
    `parseListFiles` 的注释一直写着**「不在仓内的绝对路径也排除」**，实现只判了 `rel.startsWith("/")`。
    `toRepoRelative` 落在仓外时**原样退回**：unix 式退回成 `/some/where/x.ts`（有前导斜杠 ⇒ 抓得到），
    windows 式退回成 `E:/other/repo/x.ts`（**没有**前导斜杠 ⇒ 抓不到，直接计进"本仓语料"）。
    本机就是 windows 式 —— 漏的正是这里天天在用的那一型。方向是**绿**：语料数被仓外文件灌水 ⇒
    `include` 真被改窄时那条下限仍够 ⇒ 与 r19 守的"少报在棘轮上是绿的方向"同形。
    实测（合成语料，本机根 vs 别处根）：`D:/…` 那两条在**两种根下都返回 2** —— 也就是说那发夹具
    在别处 checkout **也是绿的**，而绿的原因是**洞**：路径落不进 ROOT、没前导斜杠、照样计数。
    ⇒ 洞①（夹具假定在哪）和洞②（仓外 windows 路径漏计）**互相撑住**：
    只修②不改夹具 = 把一处假绿换成一处假红，而下一个人会把那发红当成回归去 revert。
    两格必须**同轮**修，这一条是本轮唯一值得抄走的纪律。
    第三格顺手量到：`toRepoRelative` 的注释写着"三种形状是**实测**出来的"，实际**只有绝对路径
    那一型有测试** —— 把 `while (p.startsWith("../"))` **整行删掉**，HEAD 版 20 发**全绿**
    （`HEAD_M3_EXIT=0` / `Tests 20 passed (20)`，实测过，不是推断）。
    ⇒ 注释里那句"实测出来的"也是一条主张，它得指得到**具体哪一发**；否则"实测"这两个字
    在守卫代码里的作用和在产品文档里一样贵，而前者更没人核。
    修完的形状：`isStillAbsolute`  unix/windows 两型都排 + 三发新测试（仓外不计 / 单变量对照
    同位置搬进仓内⇒立刻计数 / `../` `./` 根自身三型）⇒ 该守卫 20→23 发，`test/arch` 443 发全绿，
    本机与 `%TEMP%` 那份 worktree **两边各自 32 文件 443 发**。
    牙齿：`.workbuddy/round296-mutate-path-normalization.mjs`，命中 **6/6**、机器自证 **6/6**
    （M1 判据退回旧口径 / M2 只改调用点、函数还在没人调 / M3 删剥 `../` / M4 不剥 `./` /
    M5 盘符比较改成大小写敏感 ⇒ 那是"改坏"而不是"改成不判"，这台两种都抓）。
    这台比 round295 那台多读一格：**FAIL 行里的用例名**也读，`mustRed` 逐条点**用例名**。
    点文件的分辨率是一份 23 发的文件，里面任何一发红都算命中，而它可能红在别处 ——
    那是 round295 那台**今天仍有**的分辨率，本轮这台先走出去一格。

24. **登记一个洞的时候，"它怎么被踩到"也是要复算的主张。**（round298）

    0064 §6 第 4 条登记「无门控委派边没人核对」时，前提写的是**存量脏图**，
    读者于是把它读成「防有人手滑改库」。本轮去把它落成自检时顺手复算那句前提，
    量出来**它是假的**：产品自己就能把一条 `review_gate: false` 的边写进历史。
    两道真实存在的闸门都点头 —— `POST /org` 把请求体里的**整张图**原样交给
    `commitOrgChange`（`http/org.ts`），`orgGraphSchema` 里 `review_gate` 只是
    `z.boolean()`；而保存期那条 `missing_review_gate` 在 `revalidate` 的 `add_edge`
    分支上，**只看本次 change 带来的那条边**，整图里已躺着的边一条没被看过。
    ⇒ 一次 `add_node` 变更配一张带脏边的图，两边都过。
    这不是推理，本轮把它写成了**产品自己的 schema 与判据**跑出来的一发用例
    （`safeParse ⇒ true` + `validateNewNode(...).ok ⇒ true`）——
    **少了这一发，读者只能说"那几张脏图是你手搓的夹具"。**
    ⇒ 泛用那条：**"这个洞怎么被踩到"和"这个洞存在吗"是两条独立主张**，
    前者写小了，后面所有人都按小的那圈补，补完还以为堵严了。

    **落成的形状**：`integrity.ts` 第 **8** 条自检 `delegation_edges_gated`
    （`CHECK_NAMES` 从 7 变 8，数出来的）。三个决定各有理由：
    ① **扫全部版本而不是 `MAX(version)`** —— 老版本是活的，任务盖着自己的
    `graph_version`，`readGraphByVersion` 还**刻意**在版本缺失时抛错不退回最新版，
    所以 v7 干净而 v3 脏的时候，那个老任务仍在跑脏图（专门一发钉住：`violated` 点名 `v3(g3)`）；
    ② **先过 `orgGraphSchema` 再读边** —— 读取口全是 `JSON.parse(...) as OrgGraph` 强转，
    强转把"契约说不"变成"没人知道"，`{nodes:{},edges:{}}` 那种形状今天照样躺在过测试的夹具里；
    ③ **JSON 读不动算 `violated` 不算 `could_not_run`** —— 判据跑成了，"这份数据我读不动"
    是**被检查对象**的结论；`could_not_run` 留给"尺子放不下去"（表没了那类）。

    **它今天是 `not_observable`，而这是对的**：实测 `.opc-os/dev.db` 的
    `delegation_graphs` 行数 **0**、全版本边数合计 **0**。"没有对象"和"对象都合规"
    压成一种，就会把"还没建图"读成"图是干净的"。它也不进 `pageIntegrityBroken`
    （那条只看 `page_integrity`），所以不会因为"没建图"拒绝启动。

    **最有价值的一发变异红在了另一条守卫上。** 矩阵 6 发（命中 6/6、机器自证 7/7、
    还原字节一致），M5 不打判据、打**文案**：把过期假句子写回 `not_observable` 的 detail。
    第一版它**绿** —— 没绕过去，去查了为什么：⑤b 那发用的是 `not.toContain("零 INSERT")`，
    换个措辞就抓不到，而更本质的是**假句与真句可以并存**，`toContain` 类判据抓不住"多了一句假话"。
    手工落上 M5 ⇒ `zero-producer.test.ts` 红并点名 `integrity.ts` 那一行。
    ⇒ 矩阵因此改成**每发变异自己声明该由哪条守卫抓**，⑤b 那两行在注释里明写
    「这两行不是守卫，只是便宜取样」。
    ⇒ 泛用那条：**一条文案级主张由"读文案的那台守卫"负责，别由恰好 `toContain` 它的
    测试冒充负责**；变异打在文案上而它绿，说明抓它的是别人 —— 那就把别人拉进射程。

    **没做的下一格（本轮只加读侧）**：根治是让 `revalidate` 判整图，或让 API 逐边判门控。
    那会**改变一条现役路由的接受集**（今天能过的请求明天 422），属改产品行为，
    登记不作。本轮的自检是它的**兜底**，不是它的替代。

    **round298 落地并登记为 r23**（判据核的是：那条自检还在 `CHECK_NAMES` 里、
    还在 `guarded` 数组里注册着、函数体仍在扫**全部**版本而没退回 `MAX(version)`、
    仍过 `orgGraphSchema`、且那条「空表 ≠ 没有写入方」的文案仍在 —— 分工不许漂；
    它**不跑数据库**，口径同 r12/r22：只核对那些测试所依据的**结构**还在）。

25. **一条登记的洞，它的"没人踩过"和"踩不到"是两件事 —— 而 0 行证明不了其中任何一件。**（round299）

    r22 的射程④ 登记「`nodes` 的**键**与 `node.role_id` 不一致今天没有任何判据」时，
    顺手写了一句「`add_node` 这条路天然产生不出它」。本轮去复算那半句，
    量出来**洞比登记的大**：不必碰库、不必手搓夹具，**一次完全合法的 `POST /org` 就行** ——
    路由把请求体里的**整张图**交给 schema（`http/org.ts` 在 `commitOrgChange` **之前**
    就 `safeParse`），而 `orgGraphSchema` 的 `nodes` 是
    `z.record(z.string().min(1), orgGraphNodeSchema)`：**zod 的 record 从不比较键与值里那个 id**。
    ⇒ 拿一张干净图、加一个键叫 `ghost` 而自称 `role_id: "impostor"` 的节点，配一条
    无关的 `reparent` 变更，**两半身份一起进库**。本轮把它写成了产品自己的 schema
    跑出来的一发用例（修前 `safeParse ⇒ true`）。

    **为什么值得修而不是继续登记**：后果不是"数据不好看"，是**一份身份裂成两半**。
    一批读者按**键**查（`dispatch` 的 gate 0、`handoffGate`、`runtime` 的 `modelFamily`、
    `charter` 的 `org_blocked`，还有 `commit.ts` 拿 `Object.keys` 去写 `role_charters.role_id`），
    另一些读者取**值里的** `role_id`（`subordinateRoles`、`rootsOf`）。
    键=`alice`／值=`bob` 时升级判据那句 `上级 === CEO` **两头各拿一半 ⇒ 永不成立 ⇒
    升级永不触发** —— 而本仓自己把「每一轮真烧一次子进程、人类席位永远等不到」
    列为那里最贵的那类故障（`dispatch.ts:572-468`，round357 复算：382 → 437，六行一字未变）。

    **落点选 schema 而不是 `validate.ts`**，三个理由：`rejectMalformed` 在三个入口各调一次、
    判的都是**本次变更之前**那张图，而 `add_edge` 那条根本不进 `validateNewNode`
    （缝在图上就该由图的形状管）；`orgGraphSchema` **已经是两处判据的公共入口**
    （`api.ts` 的请求体 + r23 那条 `delegation_edges_gated` 逐版本 `safeParse`），
    落在这里 ⇒ 写侧拦新的、读侧自检顺手拿到同一条不变量；`validateNewNode` 只收到一个
    node，**拿不到那个键**。判据是 `superRefine` 逐节点比 `node.role_id === key`、
    `path` 指到 `nodes.<键>.role_id`、**每个坏键各报一条**（不许 `break`：一次 422 要能看完就修完）。

    ⚠ **这是收紧，而它的安全性不是靠那张空表**（本轮最该记住的一格）。
    实测 `.opc-os/dev.db` 的 `delegation_graphs` 是 **0 行**（`.workbuddy/probe-node-key.ts` 可复算：
    行数 0／读不动 0／节点总数 0／键≠role_id 0）。但 **0 行分不清「没有坏图」和「根本没有图」** ——
    它给不出任何存量安全性证据。真正支撑这句判断的是另一份**静态普查**：
    仓内每一处生产节点的代码都按 `role_id` 取键（唯一那处写入方 `applyChangeToGraph`
    的 `nodes[change.node.role_id]`；`reparent` 那一支只覆盖已有键、spread 不动 `role_id`）。
    ⇒ 泛用那条：**"库里现在是空的"永远不能当成"改这里不破坏存量"的证据**，
    空表只证明**此刻没有受害者**，不证明**这条路上没有生产者**。

    **矩阵 6 发（命中 6/6、机器自证 12/12、还原逐字节一致），三发红在了我预期之外**：
    ① M1（比较方向翻成 `!==`）我以为**只**会被反向对照抓到 —— 手推才发现推错了：
    甲乙两发**正向**测试各断言了**报的是哪一个键**（`issue.path` 取到 `a`、正文取
    `nodes.ghost.role_id`），反判据下报的是别的键 ⇒ **两发当场红**。
    ⇒ 断言「被拒」远不如断言「**因为哪一个**被拒」承重。
    ② M3（遍历 `edges`）我把 `T_MANY_KEYS` 登记成盲区 —— 那一发的夹具 `edges` 是**空的** ⇒
    反集合遍历什么都看不到 ⇒ 它自己那句「夹具本该被拒」当场抛 ⇒ 它是**红**的。
    ⇒ **盲区不能凭感觉填，要按那份夹具的字节推一遍**。
    ③ M4（诊断退化）的价值全在 `blind` 栏：端到端那一发读的是 `issuesOf` 把 `path`
    join 成的点号串，而 `path` 没动 ⇒ **照样绿**。⇒ 「HTTP 那一发覆盖得挺全」是误读。

    ⚠ **我自己那台矩阵里有一支反向过滤器 —— 和 round298 ⑥·乙 同一形状。**
    `blind` 那栏要判「这些用例**仍然绿**」，而 `readSummary` 交出的 `tests` 集合里
    只有**红**过的名字，所以"仍然绿"= **不在集合里**。我第一版写成了 `has(t)` ⇒
    控制组报「0/4 盲区仍绿」、整轮 3/6、exit 1。
    修完之后加了一发**自证**：喂它一段合成红读数、再喂一段合成全绿读数，
    逼那个谓词**两个方向都答对** —— 少了这一发，"盲区仍绿"和 round298 那句
    「永远进不去的分支是装饰」是同一个 bug 的第二次上身。
    ⇒ 泛用那条：**凡判"仍然绿/仍然存在"的谓词，先问它的证据集合装的是红还是绿**，
    然后**喂它一份假数据**逼它反着答一次。

    **还有两发反向对照是防"新判据恒红"**：空图该绿、每个键都等于自己 `role_id` 的图该绿，
    HTTP 侧那发把同一个形状的键改成与 `role_id` **相同** ⇒ 200 且备份**发生**（`calls` 从 0 变 1）。
    后者顺带钉住了本轮最有意思的一个副产品：**schema 层 422 连备份都不触发**
    （`safeParse` 在 `commitOrgChange` 之前），而校验器层 422 会先备份再拒 ——
    两种 422 形状不同，`recorder.calls === 0` 是那条**顺序**唯一读得出来的地方。

    **r22 的射程④ 本轮同步改口**（原文那句「今天没有任何判据」现在过期了，翻向后的事实归 r24）。
    留着那段改口是因为它记着一条家规：**射程里那句「不判 X」是某个时刻的读数，
    X 被关掉时主张必须跟着改口**，否则下一条主张就建立在一句过期陈述上。

    **round299 落地并登记为 r24**（判据核的是：那条 `superRefine` 的权威字节还在
    `orgGraphSchema` 那一段里、遍历的仍是 `graph.nodes`、比较方向仍是 `=== key` 才跳过、
    `path` 仍指到那一个键、段内不许 `break`/`return`，外加两处**前提**各一格
    （`api.ts` 的 `graph` 字段仍挂着这份 schema、`org/commit.ts` 仍指名那条 INSERT）。
    七格全判**剥掉注释之后**的字节，两处前提也剥 —— 断线之后最可能出现的一句话
    就是「这里以前用的是 `orgGraphSchema`」）。它**不打开数据库、不重跑请求**，
    端到端那一发归 `org-route.test.ts`，口径同 r12/r22/r23）。

26. **「看起来更安全」的那一版判据，是本轮唯一造出新洞的写法 —— 而认出它的不是新测试，是老测试。**（round300）

    起因是 round296 留在射程段的一格欠账：「`parseTscOutput` 那一侧的仓外路径没有单测，
    **它红在『新目录』上**」。本轮先量再动，量出来**前半句对，后半句只对了一半**：
    绝对式（`E:/other/repo/…`）确实红 —— 带盘符的目录名进配额表 ⇒ 报「基线外的测试目录」，
    难看但看得见。但 `../` 那一式**不红**，而且原因在归一函数自己身上：
    它把 `../` 前缀**整段抹掉**，于是 `../packages/hub/test/engine/x0.ts` 归出来
    是一条**地道的仓内路径** ⇒ 那些错**花掉的是本仓那个目录的配额**。
    实测（落判据之前，`.workbuddy/probe300-fold.ts`）：把上限表每一格按
    `../<该格目录>/xN.ts` 灌满 ⇒ 归出 **291 条**而 `diffTypeBaseline` 返回**空字符串**
    ⇒ 一次「include 指向隔壁仓」的事故会**逐字读出本仓的配额表并宣布合格**；
    同一条形状在语料那一侧给 `filesChecked` 灌水（两条 `../other-repo/*.ts` 数成 2 个
    「本仓文件」）⇒ 「include 被改窄」那条哨兵也会被外来文件替本仓作证。
    ⇒ 泛用那条：**射程里那句「它的失效方向是红」和「不判 X」是同一种东西 ——
    按【当时看到的那一种形状】量出来的读数**。上一轮量了绝对式就写下了方向，
    于是「已经想清楚了」的错觉顺带传给了下一个读它的人。

    **落下的形状：一个定义，两种处置。**「什么叫仓外」合并成一处（绝对式读**归一后**的结果、
    往上跳式读**归一前**的原文 —— 两种形状各自只在某一侧留痕），但两个消费者的处置**相反**：
    语料那一侧**排除**（它数的是「本仓语料有多少」，外来的算进来会让下限替本仓作证）；
    错误那一侧**保留**（它问的是「谁有类型错」，仓外文件有类型错正是要人来看一眼的事）。
    被**否掉**的第三种写法值得留名：把 `../` 那一型**丢掉**（只记一条未解析）看起来最干净，
    而它把「这个 project 吃进了仓外的文件」读成「那些文件没有类型错」⇒ 配额表对着空读数
    自证通过。变异机上留了它的化石（M6：同时红在两发上）。

    ⭐ **最有价值的一发不在新测试里，在老测试里。** 收紧之后最容易写出的是这一版判据：
    「原文里有斜杠就算仓外」—— 它听起来**比正确的写法更严**，而它把 unix checkout 上
    tsc 输出的**仓内**绝对路径（`/d/item/opc/test/x.ts`）一起排掉 ⇒ 语料恒 0。
    变异机打在真字节上跑出来：**新那发【全绿】**，一条也没判到；
    红的是**老的**那一发「`--listFilesOnly` 只数本仓自己的 .ts」，外加真跑那两发跟着塌。
    ⇒ 泛用两条：**一条收紧判据自己看不见自己判宽了，能指认它的往往是被它误伤的旧断言
    ⇒ 所以「加一条收紧」之后该跑的是全量，不是新那发**；
    以及**新判据必须自带一条【方向相反】的前提自证**（这一族的正解是「仓内绝对路径
    【仍然】归一成功」那一发）—— 少了它，恒拒的写法和正确的写法在新测试上给出同一个读数。
    这台机器（`.workbuddy/round300-mutate-upward-escape.mjs`，命中 **7/7**、机器自证 **6/6**）
    另外两发的分工也值得抄：M3 是 round296 那台 M2 的**镜像**（那台证 `isStillAbsolute`
    真被调，这台证新那个判据真被调 —— 「函数在而没人调」这一族的修法永远是**逐个调用点**各一发）；
    M5 是**语义等价的重排**该绿 —— M0 测「加一条注释不算红」，M5 测「换个顺序不算红」，
    一台把等价改写读成红的机器，它给出的 7/7 里有一半是噪声。

    **登记表这一侧**：不加新主张，改 **r19**（round296 那台机器也是记在它 `method` 里的）。
    三格新判据、一发反向（注释里写着那个函数名而函数体空了 ⇒ 仍然红 ——
    这条锚点整份文件出现三次，所以「切函数体再剥注释」不是风格而是必需），
    外加射程第 ④ 条**改口**（改口而不是删掉，理由同 r22 那条家规）。
    方法列那句「23 发」也现数改成了 25 —— 分母数出来不靠记。
    **没做的下一格**：`test/../other/x.ts` 那种【中间】带 `..` 的混合写法不在判据里
    （它不是 tsc 会输出的形状，登记而不补）。

    **round300 落地并登记进 r19**（判据核的是：那条前缀比较的权威字节还在 `escapesUpward`
    的**函数体**里、`parseTscOutput` 仍在**调**它、`parseListFiles` 仍在调合并后的那一个定义 ——
    三格全判**先切函数体、再剥注释**之后的字节，因为这一族的注释比代码长，
    三个函数头上各有一整段在讲 `../`）。它**不重跑 tsc**，口径同 r12/r19/r22/r23。

## 8. 本篇数字的口径与保质期

| 数 | 口径 | 什么时候会变成错的 |
| --- | --- | --- |
| 83 / 11 / 5052 行 | `packages/hub/src` 下非测试非 `poc` 的 `.ts`，静态 import 解析到真实路径，排除 7 个入口与 2 个 worker | 新增入口、改成 barrel、或改用动态 import。**⚡ round293 已实测翻掉：现跑是 92 / 7 / 1860，复算 `npx tsx test/arch/census.ts`** |
| 108 个测试文件 | `find . -name "*.test.ts"`，排除 `node_modules` | 加测试就变（**这条不影响任何结论**，列它是为了「测得多」不是证据这件事留个锚）。⚡ 现跑 135，复算见同一条命令的 ⑤ |
| 「`tsc -b` 退出码 0，TS2307 为 0」 | 当场全量重跑 | 下一次装/卸依赖 |
| 「langgraph 1.7.1 已装」 | `node_modules/@langchain/*/package.json` 读 version + 根目录 `import()` 成功 | 换机器 |
| 「registry TCP 443 连通」 | **一次** `net.connect` | 网络状况一变就失效 ⇒ **不要据此承诺任何依赖都能装上**，要装的那个包单独复跑安装 |
| 「playwright 1.65.1 / lark-sdk 1.76.0 装得上，chromium 起得来」 | `.workbuddy/probe278` 隔离 `npm i --ignore-scripts` + `playwright install chromium` + 真 `launch()` 断言 | **换机器 / 换网络 / registry 变更**都会失效；且它只证【装得上、起得来】，**不证**本仓那个 spec 存在 —— 那条到现在也没有 |
| `harness/` 约 3300 行 | 四文件行数相加 | 加代码 |

**本篇不写进任何计数守卫的收集范围**：它不在 `docs/decisions/`，
所以 `doc-coords` 的短哈希核对与 `doc-ids` 的编号核对**不覆盖它**（这两个守卫的范围
都是 `docs/decisions/`，非决策文档走 `comment-citations` 的引用与哈希那一条）。
⇒ **这篇自己就是 O14 说的那种「没人核对的主张」**，这一点在写下的时候就知道，
所以每个数都配了复算方法而不是配一个豁免。

> 【round293 改口：上面那句**当时不成立，现在才成立**。】
> 「配了复算方法」在 round293 之前的实际内容是**一段对脚本形状的描述**，
> 而 §1.1 还明写着「不写进仓库」—— ⇒ **没有一个数配有能跑的命令**，
> 而这四条数也**从未被复算过**。第一次真跑（`npx tsx test/arch/census.ts`）
> 四条全部对不上。所以那句话是**把「写了口径」当成「给了方法」**，
> 而它出现在一篇专治「过期陈述」的文档的**最后一节**里 —— 这个位置值得记住：
> **一篇文章最像元讨论、最像在自省的那一段，同样没人复核过。**
> 原文按老规矩留着不删，出处与现跑读数见 §1.1 那块 ⚡。

**最后一句**：这篇文档最有用的一格不是那 14 项，是 §1.3 那三行。
一个项目最贵的东西不是没做的功能，是**关于自己现状的过期陈述** ——
因为它会让人朝着已经存在的东西再实现一遍，
或者跳过一件已经塌掉的前提。
