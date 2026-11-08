# 0005　超步边界只有 `Saver.put`；审计的 seq 只能来自 `events.id`；interrupt 不走异常

- 状态：已采纳
- 日期：2026-11-07
- 关联：规格 §5.8、§6.3、§22.1；计划 Task 0.6；决策 0001（D6-a 自研 Saver）、0003（事务作用域）
- 落地：提交 b4c8e20（`src/events/bus.ts` 254 行 / 12 例、`src/events/recorder.ts` 364 行 / 32 例）、
  提交 c2f324f（`src/graph/audit-middleware.ts` 275 行 / 20 例，另改 `src/checkpoint/tx-scope.ts` 新增
  `scopeFrame`）。全量 177 passed | 6 skipped（14 个测试文件）。

> 本文是这一层「为什么这样实现」的唯一出处。探针脚本留在 `.tmp/`（gitignored，**不入库**），
> 所以它们测出来的数字一律抄进本文；代码注释里**不再**指向 `.tmp/` 的路径 —— 那种引用在
> 别人机器上永远是死链。

## 1. `Saver.put` 是唯一的超步边界

计划硬规定 1 要「每个节点执行时 Checkpoint 与 `INSERT INTO events` 在同一事务里」，落地就必须
回答一句：**从哪一刻起算一个新超步**。四个候选，实测只活下一个。

| 候选 | 实测结论 |
| --- | --- |
| `Saver.put()` | 严格发生在该超步所有节点**之前**；平行扇出时 3 个节点只给 **4 次 put**（同超步的节点共享一次 put）|
| `putWrites()` | 在节点**之后**才来 —— 顺序实测为 `put → 该超步全部节点 → putWrites`，拿它切事务会切在节点中间 |
| `stream(updates)` 的 chunk | 与超步无一一对应（一次超步可能给多个 chunk，也可能合并）；且 producer 与 consumer 之间**没有背压**：consumer 睡 250 ms，后面节点的 INSERT 照样落库 |
| 节点函数自己包一层 | 平行分支并发进入，事务归属变成多个答案；且单节点事务正好是 0003 §3.2 反对的粒度 |

所以织入点选 `put`。实现用 `Object.defineProperty` 就地替换 `saver.put`，**不是**子类也不是 Proxy：
调用方拿到的仍是同一个对象，LangGraph 内部若已持有引用，也不会拿到未织入的那份 —— 这是
「忘记织入」这类事故的天然解法。替换体里 `saver.put.bind(saver)` 的 `bind` 不可省（变异 B10
去掉它，4 条测试立刻红：`this.serde` 丢了）。

## 2. 一个事务 = 一个超步，不是一个 invoke

0003 §3.2 已定，这里只补实现侧的必要性：一次 invoke 可能跑几分钟（人在环审批就挂在那）。
invoke 级事务有两个后果，都不报错：

1. 写锁（`BEGIN IMMEDIATE` + `busy_timeout = 5000`）按住整张图的时长，期间任何别的写入等 5 秒
   然后抛 `SQLITE_BUSY` —— 表现是「UI 偶发写不进去」。
2. 崩溃时丢掉**全部**进度，V11 的续跑退化成重跑全图。

滚动方式：`put` 里先调 `recorder.onStepStart()` —— 提交上一个超步、再开新事务；invoke 收尾提交
最后一个。`onStepStart()` 有一条快路径 `writtenInTx === 0 && pending.length === 0 → return`，
它让连续多个**没有写库**的超步（心跳很常见）不产生空事务往返。

这条快路径差点测不出来。我最初写的断言是 `committedSteps === 取值时点 + 1`，而取值时点本身
随变异一起变：删掉快路径后 `roundtrips.n` 从 1 变 2、`committedSteps` 从 2 变 3，断言
`3 === 2 + 1` **照样通过**。标题写着「连续两次 put」但根本没第二次 put。重写为绝对数字 + 正反
对照（同一个协调器，差别只在中不中途 `record`）：无写入三次 put ⇒ `committedSteps === 1`；
中途写一次 ⇒ `=== 2`。这才真正证伪得了一个空事务往返。

## 3. ALS 作用域帧 ≠ 事务帧，故 `tx-scope.ts` 新增 `scopeFrame`

`txScope()` 把「开事务」和「建 ALS 帧」捆在一起。超步协调必须把两者拆开：帧按 **invoke** 存续，
事务按**超步**滚动。捆在一起的后果是实打实的：`saver.put` / `putWrites` 每次都要
`requireScopeDb()`，若帧跟事务同生共死，两次 COMMIT 之间就会出现「saver 需要连接但没有帧」的
空窗，当场抛「必须在 `txScope()` 内调用」—— 这是本任务第一次实现的红。

但**反方向**的冗余要砍掉：我一开始在 `invoke()` 外面套了一层 `tx.frame(() => recorder.run(fn))`，
理由是「两次超步之间 saver 需要帧」。变异测试直接证伪了这个理由 —— `recorder.run()` 自己会调
`tx.scope(fn)`，那个帧包住整个 `fn`，**包括**超步之间的窗口；外层再建一个同值帧恒被覆盖。
变异体「`frame()` 不建帧」存活 ⇒ 该层恒冗余 ⇒ **删除**，理由作废。

留下的 `scopeFrame` 有一条必须写死的约束：它**只能**用 `tx-scope` 模块自己的那个 ALS。
`DbStepTx` 曾自持一个 `AsyncLocalStorage`，两份 ALS 各看各的 —— 表现是「明明在事务里，saver
却说不在 `txScope()` 内」。这条**是**可测的：变异 B07（`scope()` 退化成直接调 `fn`）由集成测试
「`auditedInvoke` 不经 `invoke()` 也能写审计」单独杀死。

## 4. `inTx()` 与 `db()` 是两个谓词，合并会静默跳过 COMMIT

`StepTx` 接口暴露两个看起来像重复的东西：

- `inTx()`：数据库里**有没有活动事务**；
- `db()`：代码位置**在不在作用域里**（不在就抛）。

合并成一个（用「作用域里有没有连接」回答两者）的后果：`run()` 的收尾 COMMIT 跑在 `scope()`
**之外** —— 那一时刻作用域已退出但事务仍活动，判据返回 false ⇒ **COMMIT 被静默跳过**：事件写进
了事务、事务没提交、连接关掉、全程不报错，重启后什么都没发生。这条故事写在 `inTx()` 的注释里，
而测试里的 `FakeTx.db()` 故意抛一条**不含「事务」二字**的消息（`SCOPE-MISS：…`）：否则删掉任一条
守卫，都可能被另一条守卫的消息意外匹配掉。

## 5. 两条守卫的报错文案必须词法互斥

`record()` 前置两条守卫，文案是**测试的一部分**而不是给人看的客气话：

| 守卫 | 文案关键词 | 何时触发 |
| --- | --- | --- |
| 没有事务 | `autocommit` | 完全在超步之外写 events |
| 有事务但没作用域 | `丢失了事务作用域` | `run()` 收尾阶段、`scope()` 之外 |

两条若共享关键词（都写「事务」），断言 `/事务/` 就无法区分是哪条守卫救的场：删掉其中**任一条**，
测试都还绿。所以 `/autocommit/` 与 `/丢失了事务作用域/` 互斥，两条各有一条专属断言。

## 6. `seq` 只能来自 `events.id`；总线不许自己计数

计划签名是 `publish(e)`。实现改成 `publishPersisted(e, seq)`，调用顺序固定为「先 `INSERT`、拿到
`events.id`、再广播」。总线自计数会有两套游标：广播用的计数器与 REST 快照用的 `events.id`。规格 §5.8
的恢复策略是 **REST 快照 + 从游标续订**（不是事件重放），两套游标一错位，续订就**永远**错位且
永不自我纠正。`publishPersisted` 因此拒绝非正整数与倒退/重复的 seq。

## 7. `degraded` 标在最旧那条未标记的条目上

慢消费者丢最旧（规格 §5.8），环形容量 `DEFAULT_RING_CAPACITY = 512`。降级标记的位置容易写错成
「最新一条」，那是错的：续订时那条最旧的可能已被环形覆盖，前端**拿不到任何降级信号**，会以为
画面是全的、继续显示残缺状态 —— 正是要防的静默失效。实现用
`findIndex(x => x.degraded === undefined)` 把标记落在最旧未标记处；`degraded` 类型是
`?: true`（不是 `boolean`），避免消费端误判。收到 `degraded` 的正确反应只有一个：去拉 REST 快照。

`EventSubscription` 比计划签名多两个成员，都是必需的：

- `close()`：SSE 写失败即视为订阅者已死（规格 §5.8），必须从广播名单摘除；
- `dropped()`：丢事件的计数。定义写死在注释里（「实收 9、10 ⇒ `dropped() = 7`」），测试里的数字
  才有出处，而不是凑出来的。

`subscribers?(): number` 是队列被真正回收的**唯一**可见证据 —— 只断言订阅者自己不丢事件，看不出
连接泄漏。

## 8. 广播只在 COMMIT 完成之后，且是两处独立站点

`#flush()` 只在 `await commit()` 返回后被调用。提前半行就会把 seq 指向尚未提交、甚至会被回滚的行，
而订阅端游标已前进、永不自我纠正。两个调用点**必须**是两个独立变异体：`onStepStart()` 里的
（6 空格缩进）与 `#commitCurrentStep()` 里的（4 空格缩进）—— 一处改对另一处漏掉是常见错法。
对应的断言不能只看调用之后的状态，必须在 `tx.commit` **两侧**都取样：探针跨提交点快照得到
`[0, 0, 1, 1]`，一次证明「提交前 0」、一次证明「提交后 1」。只写在调用之后的断言对**顺序**
毫无鉴别力。

`#flush()` 内部逐条 try/catch 交给 `#onBroadcastError`，**永不**向上抛：一个坏订阅者不能把已经
提交成功的事务变成失败。

## 9. 入口校验：append-only 触发器让脏数据变成永久事实

0004 记录了触发器挡住 `UPDATE`/`DELETE`。推论是**写入侧必须严格**，因为没有第二次机会：

- **`action` 必须是 §22.1 的 10 值枚举**：脏枚举值永远留在库里，审计回放会把它当真的。
- **`actor_id` 非空**，且「空」包含**纯空白**。这一条是真实缺陷，不是假想：守卫原本只写
  `actorId === ""`，于是 `actor_id` 为三个空格能写出一行**看起来有值**的匿名事件 —— 比空串更难
  发现，而触发器挡住了事后清理。改成 `trim() === ""` 之后，专门补一个变异体 M05b（守卫在但
  不 `trim`）来证明新断言确实有鉴别力。
- `payload` 序列化三条规则：`undefined`/`null` 落字符串 `null`（列 NOT NULL 且下游一律
  `JSON.parse`）、裸文本抛（双重编码同样是脏数据）、循环引用抛（写不进去是事故，静默写空对象
  是伪证）。

## 10. interrupt 经**返回值**送达，不走异常（V2）

实测（探针 `probe-interrupt-shape`）：调 `interrupt()` 之后 `graph.invoke` **正常 resolve**
（`threw = false`），返回对象多一个 `__interrupt__`。它是**普通 Array**，元素**恰好两个键**：

```json
[{"id":"71f40f2363f22cad8ee77c462e0ef2fe","value":{"reason":"请批准","amount":42}}]
```

所以 `auditedInvoke` **不 catch**：普通异常必须原样冒泡（catch 会把「节点炸了」误判成中断，也会
吃掉唯一的故障线索）。中断存在时发 `ApprovalRequired`，`target = interruptId`、
`payload.payload = 中断值`。

**故意先写一版 try/catch 实现**，测试必须失败 —— 计划要求如此，也确实红了 4 条，其中一条是
`AssertionError: expected +0 to be 1`：`invoke` 根本没抛，catch 里那段发审批的代码一次都没执行。
这就是 V2 的实证。

形状偏离一律**抛错**而不是当作「没有中断」：`__interrupt__` 不是数组、元素不是对象、`id` 不是
非空字符串，全都 throw。理由是一句话：静默返回空数组的表现是**审批永远不来**，且没有任何报错。
`id` 为空也要抛 —— 审批要靠它 resume，空 id 的审批行是废行。

## 11. 【撤回】`events` 不需要去重列 —— 原结论基于一个没测 interrupt 的探针（V3）

> **本条原来的结论是错的，结论作废，但错误本身比结论更值得记。** 原文写「`invoke(null)` 续跑
> 不重跑节点 ⇒ 幂等性由框架免费提供 ⇒ 不需要 `(task_id, dedup_key)` 之类的列」，并据此定 schema。
> 错在探针方法：那条探针的图**里没有 `interrupt()`** —— 而 Phase 0 的核心场景（审批）恰恰就是
> interrupt。测了一个不相关的形状，就把结论推广到 schema，这是本轮最贵的一次错误。

### 11.1 实测矩阵（LangGraph JS 1.7.1 + `SqliteWALSaver` + `SuperStepAuditor`）

| 场景 | 节点执行次数 | `events` 已提交行数 |
| --- | --- | --- |
| 无 `interrupt` 的节点 + `invoke(null)` | 不变（1 → 1） | 不变 |
| 含 `interrupt` 的节点 + `Command({resume})` | **重跑**（1 → 2） | — |
| 含 `interrupt` 的节点 + `invoke(null)` | **重跑**（1 → 2） | **重复**（1 → 2） |
| 中断后误传 input（V11） | 全重跑（plain 1→2、节点 1→2） | 重复 |
| `record` 在 `interrupt()` **之前** + resume | — | **1 → 2，payload 逐字相同** |
| `record` 在 `interrupt()` **之后** + resume | — | **0 → 1，不重复** |

LangGraph 的 interrupt 是靠**重放节点直到 `interrupt()` 那一行**实现的。于是：

- **缺陷 A（已固化成回归测试）**：节点在中断**之前**写的 `TaskStateChanged`，恢复时被重放写第二遍，
  两条 payload 逐字相同（实测 id=1、id=2）。而 §9 的 append-only 触发器使「事后删掉多余那条」
  不可能 —— 审计里凭空多出一次「进入待审批」，且完全无法事后清理。计划 Task 0.6 验收第 4 项
  「崩溃恢复（V3）不产生重复 `TaskStateChanged`」**实测不通过**。
- **缺陷 B**：`ApprovalRequired` 由 `auditedInvoke` 在 invoke 返回后发出。同一个中断被再次检测到时
  会再发一条，实测三次 invoke 后库里 **3 条 `action=approval`，`target` 逐字相同**
  （`interrupt:<32位hex>` —— 中断 id 在 checkpoint 里稳定，所以重复项可按 `target` 辨认）。
  崩溃重启 N 次，CEO 就看到 N 条一模一样的审批。
- **缺陷 C（接口不可组合）——已修，见 §11.3**：`auditedInvoke` 内部调 `recorder.run`，`SuperStepAuditor.invoke` 也调
  `recorder.run`，嵌套即撞 `AuditRecorder.run` 的嵌套守卫（「一次图执行只能有一个事务责任方」）。
  而真实图执行**同时需要**两者：saver 要 auditor 建的事务作用域，中断审计要 `auditedInvoke`。
  实测两条路都不通 —— 嵌套撞守卫，不嵌套则 `SqliteWALSaver.put` 报「必须在 txScope() 内调用」。
  三套测试各自全绿，**却组装不出一个可用的整体**；`audit-interrupt.test.ts` 用 `FakeTx` 绕开了真实
  嵌套，所以没人发现。**教训**：只测零件不测装配，绿灯不代表机器能开。


### 11.3 缺陷 C 的修法（当场修掉，因为修法唯一、不改 schema）

`auditedInvoke` 先问 `recorder.inStepTx()`：外层已有活动超步事务就**复用当前事务**写审批，
否则（独立使用）才自己 `run` 开一个。为什么这个修法是唯一正确的：

- 缺陷 C 的本质不是「嵌套守卫太严」，而是**同一次图执行出现了两个事务责任方**。守卫是对的，
  该改的是「内层不该自己开事务」。把守卫放宽（比如允许嵌套、内层只记账）会把 §4 那个
  「COMMIT 被静默跳过」的坑重新打开。
- 复用当前超步事务还**顺带修正了语义**：审批事件于是与该超步的 checkpoint 同事务原子提交
  （规格 §6.3），而不是散在另一个事务里。回归测试直接断言 `committedSteps === 1`。
- 两条路径写入的内容抽成同一个 `writeApprovals()`，避免复制粘贴后各自漂移。

`inStepTx()` 是 `AuditRecorder` 新增的公开谓词（回答**数据库状态**，与 `#tx.inTx()` 同一谓词，
不是「代码位置」—— §4 那两个谓词不可合并）。为什么必须由 recorder 暴露而不是让调用方自己
判断：调用方无从知道外层有没有开事务，猜错就是运行时抛错。

变异测试（4 个变异，全部由 `interrupt-resume` 组合例 + `step-tx` 独立路径例杀死）：

| 变异 | 位置 | 结果 |
| --- | --- | --- |
| 复用分支条件恒假 `if (false)` | `auditedInvoke` | **KILLED** —— 真实图执行撞嵌套守卫 |
| 复用分支条件恒真 `if (true)` | `auditedInvoke` | **KILLED** —— 独立使用路径没有事务 |
| `inStepTx()` 恒真 | `recorder` | **KILLED** |
| `inStepTx()` 恒假 | `recorder` | **KILLED** |

缺陷 A、B 仍然**未修**：它们要动语义或 schema（见下表），且「同一中断该发几条审批」是产品
决策，不是实现层能单方面定的，已登记为 §11.4 的待 CEO 决策项。
### 11.2 为什么写到这里而不是当场修

缺陷 A、B 的修法要动**语义或 schema**，三个方向各有代价，不是实现层能单方面定的：

| 方向 | 代价 |
| --- | --- |
| 给 `events` 加幂等键（`INSERT OR IGNORE`） | 改 Task 0.5 已定稿的迁移 SQL；且「谁该去重」要说清 —— 状态机真跳转两次就该是两条，去重键选错会把真实事件吞掉 |
| 约定节点不许在 `interrupt()` 之前写审计 | 不改 schema，但把正确性寄托在编码纪律上，编译期和测试期都不设防（§9 的反面） |
| 中断前只写 checkpoint、审批事件统一延到 invoke 返回后发 | 目前就是这个形态，它能躲开缺陷 A，但躲不开缺陷 B；要靠 `target` 做唯一索引才收得住 |

回归测试 `packages/hub/test/graph/interrupt-resume.test.ts`（3 例）断言的是**当前真实行为**并逐条
注明「这不是期望行为，是缺陷的回归锁」：去重机制一旦落地，测试立刻变红，逼后来的人读这条，
而不是留一条永远绿着的「测了个寂寞」。其中「`record` 在 `interrupt()` 之后不重复」那条是对照，
用来验证将来的修复**不过宽** —— 修复若把合法的第二条事件也吞了，那条对照会红。

### 11.4 待 CEO 决策（缺陷 A、B）

编号 **D10**：一次「进入待审批」在审计里该有几条记录、一次审批请求在 UI 上该出现几条。

| 选项 | 做法 | 代价 |
| --- | --- | --- |
| A | `events` 加幂等键，写入改 `INSERT OR IGNORE` | 改 Task 0.5 已定稿的迁移 SQL；去重键选错会把**真实的**重复状态跃迁吞掉（状态机合法地 A→B→A→B 就是四条） |
| B | 编码约定：节点不得在 `interrupt()` 之前写审计 | 零 schema 改动，但正确性寄托在纪律上，编译期与测试期都不设防 —— 与 §9 的立场相反 |
| C | 审批维持「invoke 返回后统一发」，另按 `target` 建唯一索引去重 | 不改迁移 SQL，只加一个索引；能收住缺陷 B（重复审批），但**收不住缺陷 A**（节点内的 `TaskStateChanged` 仍会重放写两遍） |

**建议 C 叠加对 A 的专项处理**：审批走 `target` 唯一索引；节点内状态事件的去重键则要用
**业务语义键**（如 `(task_id, action, from, to, 超步序号)`）而不是 payload 文本，才能既吞掉重放
又保住合法的重复跃迁。此项**不阻塞** Task 0.8 / 0.10 / 0.11（桩图无 interrupt、无崩溃恢复），
但 Task 0.8 的「`process.kill` 后重启续跑，轨迹正确」一条会**如实测出重复**，届时不许为了让测试
变绿而放宽断言 —— 那正是本条要防的事。

**本轮实测过本节那句『崩溃重启 N 次你会看到 N 条一模一样的审批』—— 在那之前我从没实测过它，**
只在入口把它写给了你。证据级别是 0006 第 10.4 节定义的 **L3**（我这次实测看到，且当下没有测试直接
断言它），探针跑完即删、未入库，所以你复现不了，只能照本节末那段自己重建 —— 这也是我把探针的输出
原样贴在这里、而不是只报结论的原因。

口径（必须写清，因为『一模一样』有好几种判法）：同一个 thread_id 连续 invoke 四次，第一次给初始
输入，后三次给 invoke(null)，即计划 V3 的崩溃续跑姿势；只数 events 里 action 等于 approval 的行；
『一模一样』按 payload 逐字相同判 —— 沿用 `interrupt-resume.test.ts` 里已经确立的判据（payload 不同
就是两个真实事件，不该去重），不按整行字节判。探针只有一个节点一条中断，且把 record 放在 interrupt
之后，为的是只测审批重复（缺陷 B），不掺节点内状态事件的重放（缺陷 A）；**A 本轮没有重测**，上面
关于 A 的说法仍是上一轮的实测。

实测输出（原样，未编辑）：

```text
k=1 (initial) approval rows = 1
k=2 (invoke(null)) approval rows = 2
k=3 (invoke(null)) approval rows = 3
k=4 (invoke(null)) approval rows = 4

counts after each invoke = [1,2,3,4]
monotone +1 each time = true
rows = 4   distinct payload = 1
distinct target = 1
distinct created_at = 1
full payload of row 1 = {"kind":"ApprovalRequired","taskId":"T-DUP","interruptId":"64e089380c436daff50997e56d8d15b4","payload":{"reason":"请批准"}}
row1 === rowLast byte-equal = true
target === payload.interruptId = true
all rows share that target = true
```

**结论：N 取到 4 时确实是 4 条，每次 invoke 恰好多一条，四条 payload 逐字相同。那句描述为真。**

三件从上面的表格里看不出来、但对拍板有用的事：

1. **四条的 target 相同，且等于 payload 里的 interruptId**（不是我把输出截断后肉眼猜的 —— 截断处的
   字节我看不见，所以这次把相等性写成了显式判断再跑）。这正面支撑了 **C 的前提**：C 说按 target 建
   唯一索引能收住审批重复，成立的前提就是同一个中断的 target 恒定。本轮这个形状下成立。
2. **探针里 created_at 也相同，但那是我的桩造成的，不是产品性质** —— 探针把时钟固定成一个常量。
   真实时钟下四条的 created_at 必然不同。推论有二：判『重复』只能按 payload 判，按整行判会漏；
   而 C 用 target 建唯一索引去重，去重的正是【内容相同、只有时间不同】的那几条，所以 C 不会误伤
   真实世界里时间不同、内容也不不同的两次审批。
3. **我只证到 N=4 的单调递增，没有外推到任意 N**，而且探针是单节点单中断，**没说清真实多节点图里
   连崩 N 次的形状**。若你按 C 拍板，这两条边界连同『C 收不住 A』这一点，就是验收要补的。

重建探针的最小 harness（用真实的 auditor 与真实的 saver，不复制被测代码，否则测的就不是产品路径）：

```typescript
// 放 .tmp/ 下重建；.tmp 已 gitignore，跑完自己删
import { DatabaseSync } from "node:sqlite";
import { Annotation, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { SqliteWALSaver } from "../packages/hub/src/checkpoint/saver.js";
import { CHECKPOINT_TABLES } from "../packages/hub/src/checkpoint/schema.js";
import { SuperStepAuditor, auditedInvoke } from "../packages/hub/src/graph/audit-middleware.js";

const EVENTS_DDL = "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, "
  + "actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, target TEXT, "
  + "payload TEXT NOT NULL, state_snapshot TEXT, created_at INTEGER NOT NULL)";

class FakeBus {
  publishPersisted(_e: unknown, _seq: number): void {}
  latestSeq(): number { return 0; }
  subscribe(): never { throw new Error("不该订阅"); }
}

// 时钟固定成常量：这是上面第 2 条的来源，别当成产品观察
const auditor = new SuperStepAuditor({ db, bus: new FakeBus() as never, now: () => 1700000000000 });
const saver = auditor.instrumentSaver(new SqliteWALSaver(db));
const graph = new StateGraph(State)
  .addNode("approval", async () => {
    interrupt({ reason: "请批准" }); // record 放它之后：只测审批重复，不掺状态事件重放
    await auditor.recorder.record({
      kind: "TaskStateChanged", taskId: "T-DUP", from: "running", to: "need_approval",
    });
    return { trail: ["resumed"] };
  })
  .addEdge(START, "approval")
  .addEdge("approval", END)
  .compile({ checkpointer: saver });

const cfg = { configurable: { thread_id: "dup-1" } };
const approvals = (): Record<string, unknown>[] =>
  db.prepare("SELECT id, target, payload, created_at FROM events"
    + " WHERE action = 'approval' ORDER BY id").all() as Record<string, unknown>[];

for (let k = 1; k <= 4; k++) {
  const input = k === 1 ? { trail: [] } : null; // 后三次 = 崩溃续跑姿势
  await auditor.invoke(() =>
    auditedInvoke({
      invoke: () => graph.invoke(input, cfg),
      recorder: auditor.recorder,
      taskId: "T-DUP",
    }),
  );
  console.log(k, approvals().length);
}
```

## 12. LangGraph JS **没有** middleware 概念 —— 文件名的妥协

计划写的是 `audit-middleware.ts`。LangGraph JS 1.7.1 里**不存在**中间件：只有
`GraphCallbackHandler` 这个标记类，没有生命周期钩子、拿不到节点名，撑不起「每个节点执行时」这
个语义。所以本文件是**显式包装器**（`auditedInvoke` + `instrumentSaver`），名字沿用计划是为了和
计划、以及未来 grep 得到的一致性对齐。**读到「middleware」不要以为框架里有对应物。**
框架升级若真引入中间件，这个文件应当改写而不是长期并存两套入口。

## 13. 计划的两处笔误 / 与实现的偏离（以本文与代码为准）

| 位置 | 问题 | 处置 |
| --- | --- | --- |
| 计划 296-297 行 | `EventBus` 接口闭合的 `}` **重复一次**，签名块无法编译 | 代码按一份实现；计划文本单独修 |
| 计划 291 行 | `publish(e): void` 会让 seq 来源变成总线自计数 | 改为 `publishPersisted(e, seq)`（§6 的理由）|
| 计划 293 行 | `subscribe()` 返回裸 `AsyncIterable` | 加 `close()` / `dropped()` / `subscribers?()`（§7 的理由）|
| 计划 315 行 | Task 0.8 的 Files 列了 `src/graph/nodes/*.ts` | **实现未拆分**：每个节点体只有 3–6 行（读 `current` → 写状态边 → 返回本超步通道），拆开会把一次 §7.1 跃迁的三段事实分到两个文件里，改边表时更容易只改一处。全部节点集中在 `company.ts`。**这是我们的取舍，不是计划的许可** —— 若 Phase 1 节点体长出实际逻辑，届时再拆，拆的理由是"变长了"而不是"计划这么写" |

## 14. 变异测试记录

方法学沿用 0003/0004：锚点每次重跑前**重新从源码 dump**（biome `--write` 会重新折行）；语法错误
杀死的变异体**不计**；锚点没命中既不算杀也不算活；存活的变异体必须**证明**冗余，否则按「缺断言
或有真缺陷」处理。

| 阶段 | 变异体 | 结果 |
| --- | --- | --- |
| `bus.ts` + `recorder.ts`（b4c8e20）| 23 | **23 杀**，无语法假杀 |
| `audit-middleware.ts` 中断半边（c2f324f）| 13 | **13 杀**（A01-A12 含 A06b）|
| `audit-middleware.ts` 协调器半边（c2f324f）| 11 | 8 杀、**3 存活**（逐个处置见下）|

### 14.1 中断半边的两条存活（提交前已处置）

- **A06** 删掉「元素不是对象」守卫后全绿 ⇒ 真缺断言。补一条覆盖 `null` / 字符串 / 数字 /
  `undefined` 四种元素的测试，外加一条「`__interrupt__` 显式为 `null`/`undefined` ⇒ 视为没有中断」
  （区分「没中断」与「中断形状坏了」，这两件事的处理必须不同）。重跑 A02 / A06b / A12 全杀。
- **M05** 删掉空 `actor_id` 守卫后全绿 ⇒ 真缺断言，并牵出 §9 那个**纯空白的真缺陷**。

### 14.2 协调器半边的三条存活 —— 两条导致代码变少

| 存活体 | 归因 | 处置 |
| --- | --- | --- |
| B08 `frame()` 不建帧 | 外层帧恒被 `recorder.run` 内的同值帧覆盖 ⇒ 该层**恒冗余**，也证伪了我写进注释的理由 | **删除** `frame()`，`invoke` 直接 `recorder.run(fn)`；注释改成经检验的版本 |
| B11 删 `begin()` 重入守卫 | 正常编排下 `begin` 之前必先 `commit`（`onStepStart` 保证），重入不可经公开路径触发；且 SQLite 原生会报 `cannot start a transaction within a transaction`，那句话本身就指向根因 | **删除**守卫（自定义它只是把同一件事说两遍）|
| B06 `db()` 改回常驻连接 | 本类只持**一条**连接，`scopeFrame(this.#db, ...)` 装的就是它 ⇒ 恒等替换，故无鉴别力可言 | 实现保留（仍走 `requireScopeDb`，语义是「取作用域里那条」）；**另加契约断言**：saver 与 recorder 在另一个连接上的可见性必须**同步翻转**，防将来「每次 begin 新建连接」时规格 §6.3 **静默**失效 |

三条存活里有两条让代码**变少**（`frame()` 与一条守卫）。这是变异测试常被忽略的收益：它不只补断言，
也删掉**看起来必要、实则不可达或恒冗余**的代码 —— 这类代码的害处是让人以为那个风险真的被守住了。

## 15. 本轮自己造成的失误（记下来免得重犯）

1. **`invoke` 外层多套一层 ALS 帧**，并为它编了一条听得出道理的理由（「超步之间 saver 需要帧」）。
   变异测试把它证伪了。**教训**：解释性注释不是证据；能被删掉而测试不变的「必要性」都是幻觉。
2. **`runOutside()` 的实现就是 `return fn()`** —— 它既不建作用域也不开事务，测试测的是「什么
   都不做」，还逼出一个 `void db;` 遮丑补丁。删掉方法，测试直接面对真相。**教训**：出现 `void x;`
   是为了让类型检查闭嘴时，先怀疑那个 API 该不该存在。
3. **两条自产弱断言**：「连续两次 put」测试其实没有第二次 put（§2）；`inTx`/`db` 守卫消息文案相近
   会让断言失去鉴别力（§5）。
4. **`scopeFrame` 插入位置错位**，把 `txScope` 的 fail-fast 文档注释挂到了 `scopeFrame` 头上 ——
   而后者恰恰**不** fail-fast（这正是它存在的理由）。**教训**：用「在某锚点前插入」改代码，改完要
   重读上下文，注释错位是最容易漏的一类损坏，它不报错、只误导后来的读者。
5. **代码注释引用了 `.tmp/` 下的探针路径** —— `.tmp/` 是 gitignored，那条引用永不入库，在别人
   机器上是死链。改为引用本决策文档，实测数字抄进文档（见开头那条说明）。
6. **把 `grep` 无匹配与 `vitest <不存在的目录>` 的 `exit 1` 误当测试失败**两次。**教训**：读 exit
   code 之前先读输出正文（前者是「没找到」，后者是「No test files found」）。

7. **测了一个不相关的形状，就把结论推广到 schema**（见 §11）：断言「`events` 不需要去重列」的探针
   图里**根本没有 `interrupt()`** —— 而 Phase 0 的核心恰恰是审批。**教训**：推广结论前先问「我的
   样本覆盖了结论涉及的那个形状吗」。这条错得最贵，因为它决定 schema 而且写进了决策文档。
8. **用带 `WHERE` 的查询去证明「不存在」**，而那个 `WHERE` 因为参数绑错位置（写成
   `db.prepare(sql, [v])`，node:sqlite 的绑定要在 `.all(...)` 上）根本没生效 —— 一次查询写错，让我
   先报「审批一条都没落库」，随后又差点反过来断言「审批不会重发」。**教训**：证明「不存在」之前，
   先去掉所有过滤条件数一遍总数；一条本身可能有问题的查询，配不上「不存在」这个结论。
9. **两次探针误用（参数绑错位、把 `target` 塞进 `DomainEvent` 而不是 `record` 的第二个参数 `extra`）
   却两次都先指控实现有缺陷**。**教训**：先怀疑探针，再怀疑被测代码 —— 尤其当「缺陷」恰好是
   「我预期它该长成的样子没长成」时，很可能只是我调错了。区分办法是：把返回值、无过滤的行数、
   以及写连接与只读连接两个视角一起打出来（§11.1 的矩阵就是这么得到的）。

## 16. 两处【静默】装配陷阱：选项名写错、外层 `invoke` 缺失（Task 0.8 实测）

把超步事务织到一张新图上有**两个**动作必须同时成立。漏掉任一个，图都照样跑完、事件都照样
写出来，而且没有任何一处会提示你装配错了：

| 装配 | 症状 | 是否静默 |
| --- | --- | --- |
| `graph.compile({ checkpointer: saver })` | `saver.put` 永不被调用 ⇒ `onStepStart()` 从未触发 ⇒ 超步边界完全不滚动，整趟图压进一个事务 | **静默**。LangGraph 不校验 compile 的选项名，`{ saver }` 只是"多了一个没人读的键" |
| 调用方 `await auditor.invoke(() => graph.invoke(input, cfg))` | 第一个节点里第一次 `record()` 就抛 `record() 丢失了事务作用域` | **不静默**：显式崩溃。它兜住的正是前一条被漏掉后可能出现的空窗 —— `onStepStart()` 开的事务只活在自己的 scope 帧里，节点执行时那帧已退出 |

实测对照（4 节点 / 7 边的探针，两种装配各跑一次）：

| 装配 | `committedSteps` 终值 | 备注 |
| --- | --- | --- |
| `{ checkpointer }` + 外层 `invoke` | `5 = nodes + 1` | 最后一次 `put` 是终点检查点，不携带节点，故计数比节点数多 1 |
| `{ saver }`（错名） | `1` | `put` 从未触发；探针里 3 节点 4 边也报 `committedSteps=1` |

**为什么这是决策而非实现细节**：它决定验收 ③（V3 崩溃恢复）到底有没有被验证。选项名写错时，
"跑到 END""状态机轨迹""档位驱动"这几条用例全都绿，只有崩溃用例失去意义 —— 它声称检验的
"超步原子回滚"从未存在过。任何把 `SuperStepAuditor` 接到新图上的人都会重新撞上这两处。

### 16.1 超步提交的可见性时机

多边超步 = 一个事务，而**上一个超步的事件要到下一个超步的 `put` 才提交**。由此：

- 只读连接数到的 `events` 行数，永远是"截至上一个已提交超步"的数；
- 杀在超步 S 内部第 K 条边之后 ⇒ 库里只剩 S **之前**那些超步的边；
- `UPDATE tasks` 与该超步的事件同事务 ⇒ `tasks.status` 一起回滚，与 events 停在同一个边界（实测从不错位）。

实测（最小公司图，杀在 test 的第 1 次执行那个超步）：事务内可见 5 行 / 只读连接见 4 行 /
`tasks.status` 停在 `EVIDENCE_SUBMITTED`；`current` 与 `reworkUsed` 通道同步回滚 ⇒ 续跑重放该超步时
走的是**同一条**返工分支，边序列才恰好补齐成 14 条而不多出一条。这就是规格 §6.3"checkpoint 与
events 同事务"第一次被端到端兑现的地方。

### 14.3 M6：唯一存活的那条 —— 缺陷在断言里，不在代码里

`observe.onStatusEdge` 必须在该条状态边的 `record()` INSERT **之后**触发，它是崩溃时机定位器。
变异体把这一行挪到 INSERT 之前，11 条断言**全部照绿**：kill 时机跟着前移，"第 5 条边压根没写"
同样满足"只读连接里没有新行"。

⇒ 测试无法区分「已写入但被回滚」与「从未写入」，而它声称验证的正是回滚能力。

修法是把时机本身变成观测量：子进程在 SIGKILL 之前用**同一条连接**（事务还挂着，所以看得见
未提交的行）数一次 `events`，父侧断言这个数 ——

| 用例 | 子进程事务内可见 | 父侧只读连接可见 |
| --- | --- | --- |
| 杀在 k=5 | `CHILD-UNCOMMITTED n=5` | 4 |
| 杀在 k=6 | `CHILD-UNCOMMITTED n=6` | 4 |

重跑 M6 ⇒ KILLED。Task 0.8 最终 **11/11 KILLED**，其中 **M4 = `{checkpointer}` → `{saver}`** 被杀死，
说明崩溃用例确实咬住了超步事务边界（否则 §16 那条静默陷阱会让 V3 假绿）。

同处还删掉一条我自己写错的断言：曾写「`from->to` 不得出现两次」做重复事件检测，实测它把
**合法返工**判成缺陷 —— 返工路径本来要两次经过 `IN_PROGRESS→EVIDENCE_SUBMITTED` 与
`EVIDENCE_SUBMITTED→IN_REVIEW`。"已完成节点被重跑"已由"轨迹恰为 14 条且顺序一致"覆盖，
再加一条不增加判别力。**教训**：断言的判别力不来自条数，来自它能否区分对错。

## 17. 失误清单（Task 0.8 轮）

1. **凭记忆写路径与锚点，同一轮犯了三次**：① 注释里引用了一份不存在的决策文档（写成
   `0005-superstep-transaction.md`，真实文件是 `0005-event-bus-and-audit.md`）；② 读实施计划时用
   `docs/OPC-OS-实施计划.md`（真实路径 `docs/superpowers/plans/2026-11-06-opc-os-development-plan.md`）；
   ③ 改注释时按记忆写锚点文本，连续两次"锚点未命中"，而文件里的原文和我记的不一样。死链与错锚
   都不报错，只在别人去查、或我去改的那一刻暴露。**教训**：路径、文件名、锚点一律先读出来再用；
   写引用之后要机器核存在性（本轮做法：遍历源码里的 `docs/decisions/...` 引用与磁盘比对，见 §17 末）。
2. **fixtures 里 `../../src/...` 少写一层**（应为 `../../../src/`）。`tsc -b` 的 solution **不覆盖
   `test/` 目录**，所以这类错误一路活到 vitest 运行时。**教训**：`typecheck` 绿灯不等于测试文件被
   类型检查过。
3. **只改类型声明、没改产生值的代码**：把 `LoadedRoles` 声明成 `Record<CompanyNode, Charter>`，
   而 `loadRoles()` 仍只塞 `{ modelTier }`，于是 `roleId` 在运行时是 `undefined`，一路传到 SQLite
   参数绑定才炸（`cannot be bound to SQLite parameter 4`）。**教训**：`as` 断言换不来的保证就
   不存在；改类型必须同时改产生该值的地方。
4. **把"钩子计了数"当成"钩子证明了写入"**：`onStatusEdge` 自增一个计数器只能证明代码走到了，
   不能证明 INSERT 发生过 —— M6 因此存活（见 §14.3）。
5. **重复检测断言写错**，把合法返工当缺陷（见 §14.3 末）。
6. **`buildCompanyGraph` 需要的 `db` 句柄，两处调用方都忘了传**，七个用例同时红成同一个
   `undefined.prepare`。**教训**：一次红一片通常只有一个根因，先读第一条的栈，别急着改七处。
7. **探测脚本自身有 bug 就先下了结论**：拿 `.js`（NodeNext 的 import 写法）去磁盘上找文件，而
   仓库里全是 `.ts`，于是 11 条 import 全报"找不到"。**教训**：探针说"全都不对"时先怀疑探针。

