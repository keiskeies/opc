# 怎么写一份岗位书（以及怎么写一条**能被判定**的验收标准）

- **读者**：写 `packages/hub/resources/charter-templates/*.yaml` 的人 —— 也就是 CEO 本人（Task 0.9），
  以及任何后来改岗位书的人。
- **这篇解决的是什么**：规格 §23.2 把「7 份岗位书的 `acceptance_criteria` 由谁写」划给 CEO 本人，
  而这件事此前卡住**不是因为措辞难写**，是因为「什么算可机械判定」在仓库里没有可对照的答案：
  判据的正则、指标从哪来、判不了会发生什么，三件事分散在三个文件里。这篇把它们收到一处，
  并且**逐条标出哪些是代码里已实现的、哪些目前还没有实现**（后者比前者重要）。
- **本篇不替你写标准**。代写验收标准是计划明令禁止的（「宁可推迟 Phase 1，不可代写」）；
  本篇给的是**形状**与**反例**，让一条标准写出来之后能自己判断它会不会变成一条不拦任何东西的门。
- 取值脚手架（哪些指标已有出处、数字抄哪里的）在 `docs/decisions/0008-phase1-gate-semantics.md` §7.3，
  不在本篇重复 —— 同一份数字抄在两处必然漂移。

## 1. 先认清哪几条字段真的在运行

岗位书有二十来个字段，但**运行时真正读到的只有少数几类**。把不生效的字段写得再仔细，
也只是让配置页更长。下表逐条在写这篇时 grep 过（复核命令附后）：

| 字段 | 现在有谁在读 | 写错的后果 |
|---|---|---|
| `acceptance_criteria` | 门控 `packages/hub/src/graph/gates/evaluate.ts`（经 `gateCriteriaForRole` 取当前角色最新一版） | **唯一会拦下产出的一条**，也是本篇 §2–§4 的全部内容 |
| `role_id` / `reports_to` | 委派图与组织图校验（`packages/contracts/src/org/`） | 委派边指向不存在的节点 ⇒ `unknown_role` 拒绝保存 |
| `model_tier` | `graph/company.ts` 用它选节点模型；`roles/preset.ts` 从模板取 | 节点跑错档位 |
| `budget` | `charter/budget-sync.ts` 把它同步进 `budgets` 表（`saveCharterVersion` 内的一步），执行侧 `BudgetTracker` **只读 `budgets`、从不读岗位书** | 屏幕上是新数字、判超限还是老数字。所以这条同步是那条通道的全部要点（0015）。⚠ `saveCharterVersion` 本身**今天零生产调用方**，见 §6 第 6 条 |
| `forbidden_actions` / `tool_permissions` | **运行时零读者**。`decision_scope.forbidden` 有两个读者（`roles/loader.ts` 的 `mergeForbiddenForRun`、`gates/author-reviewer.ts` 的 `forbiddenRemovalAttempt`），但**这两个函数自己也零生产调用方** —— 所以准确说法是「判据写好了、等着接」 | 今天写了不生效，但**必须写**：它声明的是意图，权限单调性（规格 §20.2）要求黑名单只能变长，那份合并逻辑读的就是这份声明 |
| `escalation_triggers` | **运行时零读者**：升级路由 `packages/hub/src/routing/escalation.ts` 用的是它自己那组触发条件，不读岗位书 | 写在这里今天等于注释；别指望它触发任何东西 |
| `honesty_boundaries` / `decision_scope.autonomous` / `judgment_mode` / `untrusted_inputs` | **零机器判定点**，而且比我原先想的更空：`honestyBoundaries` / `judgmentMode` / `untrustedInputs` 三个 camelCase 字段在 `packages/*/src` 里除了 transform 那一行**再无任何命中** —— 没有哪个 prompt 拼装处读它们 | 主观约束只能靠这里表达 —— 这是它该待的地方，见 §3 那条「承认只能人判」的修法。但要知道它此刻**连进 prompt 都没做到**，所以它是一句**写给人看的声明**，不是一条约束 |

复核命令（想自己确认，不要信本表）：

```
grep -rn "forbiddenActions\|toolPermissions\|escalationTriggers\|requiresConsultation" packages/*/src
grep -rn "gateCriteriaForRole\|acceptanceCriteria" packages/hub/src
```

**⚠ 「零读者」不等于「可以删」。** 它等于「今天这条约束不产生任何机器行为」。
把一条真正要紧的约束只写进这类字段，是**最像做了工作的没做**：配置页上有、审的时候看得见、
而没有任何一条路径会因为违反它而失败。这条区别对本篇 §4 那四个反例同样成立。

## 2. 一条标准此刻能被机械判定的**唯一**形状

门控对 `condition` 只做一次正则匹配（`packages/hub/src/graph/gates/evaluate.ts`，
常量名 `METRIC_CONDITION`）：

```
metric:<指标名> <比较符> <数值>
比较符 ∈ >= | <= | == | != | > | <
```

正则逐字是 `^metric:\s*([A-Za-z0-9_.-]+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$`。
从它本身能读出四条**必须知道否则一定写错**的细节：

1. **右侧只能是数字。** `metric:coverage >= 80%` 不匹配（多了 `%`），`metric:p95 <= 500ms` 不匹配，
   `metric:coverage >= 80 && metric:bundle_size <= 500000` 不匹配（一条只能一个指标；
   要两个条件就写两条 criterion）。
2. **指标名字符集是 `[A-Za-z0-9_.-]`。** 中文指标名（`metric:覆盖率 < 80`）不匹配。
3. **`metric:` 后面允许空格**（`\s*`），比较符两侧也允许 —— 所以 `metric: coverage < 80` 是合法的。
   这是**唯一**一处「怎么写都行」的地方，别外推。
4. **匹配是全文匹配**（`^…$`）。末尾多一个字、多一句说明，整条标准就从「能判」变成「判不了」。

不是这个形状的 `condition` 全部进 `unresolved`。而 `unresolved` 的后果是 **escalate（升级人工），不是 pass**
—— 这个尾巴是后补的，补之前它一路走到 pass，文件注释却一直写着「判不了的事上人」。
补它的理由写在同文件末尾那段注释里，一句话版本：
**最省事的假绿方式不是伪造覆盖率数字，而是压根不提覆盖率。**

⚠ 这段尾巴的立场与同文件开头的一处旧口径冲突过：升级侧 `routing/escalation.ts` 早就把
「门控没判定的标准条数 > 0」列成 `insufficient_evidence` 触发条件，但两个模块对同一件事给两种结论时
实际生效的是先跑的门控 —— 于是升级侧那条永远不会被走到。**读到旧文档说「判不了 ⇒ 放行」，以代码为准。**

## 3. 反例四则：四种「看起来写了标准而门控不拦任何东西」

这四则是本篇的主要价值所在。它们**都不会让任何测试变红、不会报错、不会有任何警告**，
共同症状是「门控看起来在工作，实际上没在判东西」—— 规格 §8.2 整节要防的正是这个。

### 反例 ①：自由文本标准

```yaml
acceptance_criteria:
  - condition: "代码质量良好，无明显缺陷"
    action: "reject"
    message: "质量不达标"
```

实际行为：不是 `metric:` 形状 ⇒ `unresolved` ⇒ **每一趟都 escalate**。
写这条的人以为它在筛产出，其实它把该角色的每一次交接都推给了 CEO。

> 这一条**没有**看起来那么糟：它吵，而吵是能修的吵。真正的危险是反例 ②③④，它们不吵。

如果这条约束本来就只能人判（「无明显缺陷」确实是），正确处置是**别把它写成门控标准**：
挪到 `honesty_boundaries`（按 §1 那张表，它今天连进 prompt 都还没做到 —— 挪过去是
**把声明放对位置**，不是让它生效）或者干脆写成一项人工审批。
§2 末尾那段返回给 CEO 的修法提示写的就是这个二选一。

### 反例 ②：形状对，但没人往证据包里填那个指标

```yaml
acceptance_criteria:
  - condition: "metric:coverage >= 80"      # 形状完全合法
    action: "reject"
    message: "覆盖率不足 80"
```

`metric:` 那一侧要从**证据包的 `metrics`** 里取值（`packages/contracts/src/evidence.ts`，
字段 `metrics`，可选的 `记录<string, 有限数>`）。缺这个键 ⇒ `unresolved` ⇒ escalate。

**而此刻的真实状态比「要记得填」更糟**，两件事叠在一起：

1. `packages/hub/src` 里没有任何生产代码往 `metrics` 写值 —— 唯一的写入方是测试夹具
   （`packages/hub/test/charter/store.test.ts` 那种手搓 bundle）。
2. **`metrics` 根本没有落库的位置。** `evidence_bundles` 那张表的列是
   `id / task_id / producer_role / bundle_type / artifacts / self_check / created_at`
   （`0001_init.sql`），`0002_phase1_evidence_and_budget.sql` 又补了 `model_family / claims /
   honesty_boundaries` 三列 —— **没有 `metrics` 列**（实测 `grep -n metrics packages/hub/resources/migrations/*.sql`
   零命中）。`EvidenceStore.register()` 的 INSERT 列清单里也没有它。
   也就是说契约允许一个内存对象带着 `metrics` 去过门控，而这个数**从未被写过一次磁盘**，
   因此回放时看不到、审阅时无法二次核对、也不在 §5.10 那套 sha256 对账的覆盖范围内。

所以「标准写对了但指标没人填」不是理论风险，**是今天唯一能走通的路径**；
而即使有人接上了填充，接的方式如果是「手搓一个带 metrics 的对象传给 evaluateGate」，
那比不填更危险：门控看起来在判一个数，而那个数没有任何一处留痕。

由此得到本篇最实用的一条：

> **写一条 `metric:x` 之前，先回答「x 这个数由谁、在哪一步算出来、存在哪里」。**
> 三问里第三问今天的答案是「不存在」—— 所以这条标准今天判不了（要么 escalate 到 CEO 面前，
> 要么在指标补齐后突然开始生效，而那时候没有一个人记得它当初是按什么口径写的）。
>
> 指标词表此前全仓不存在（实测 `docs/` 与 `packages/*/src` 零登记处，见 `docs/INDEX.md` 的 0008 §7 入口条目）。
> 所以第一次有人填 `metrics` 时，要一起立起来的是**两件**：那份词表，以及一个真正存下它的地方
> （加一列，或者把它塞进 `artifacts` 里某个受 sha256 对账的文件）。只加第一个不加第二个，
> 得到的是一条**能判而不留痕**的标准。

### 反例 ③：比较符方向反了（本仓错过两次的那一条）

**`condition` 描述的是【不合格的情形】，不是合格条件。** `action` 是这条情形成立时做什么。
所以配 `reject` 读作「条件成立即拒」：

```yaml
# 对：覆盖率低于 80 就拒
- condition: "metric:coverage < 80"
  action: "reject"

# 错：覆盖率高于 80 就拒 —— 全绿，而门控从不拦任何东西
- condition: "metric:coverage >= 80"
  action: "reject"
```

第二种写法在 schema 层完全合法、在门控层完全静默：指标 85 时条件不成立 ⇒ 无 reasons ⇒ pass。
它已经在本仓出现过两次（`docs/decisions/0015-charter-editor-and-two-sources-of-budget.md` §2
把它记为「反复犯的同一处」，测试夹具里那条注释——「condition 语义反直觉」——立的也是它）。
现在钉住它的是断言而不是记性：`packages/hub/test/gates/determinism.test.ts` 与
`packages/hub/test/charter/store.test.ts` 都拿真实链路跑「改验收标准 ⇒ 门控结论变化」，
方向写反会让那两条用例红。

自检法（比记规则可靠）：**把这条标准念成「当 ______ 时，拒绝」**，空格处填 condition。
念出来是「当覆盖率高于 80 时，拒绝」，那就写反了。

### 反例 ④：把模板里的占位串留着

```yaml
acceptance_criteria:
  - condition: "CEO-PLACEHOLDER-ACCEPTANCE"     # 七份模板现在都还是这个
    action: "reject"
```

后果要说准，因为这里的常见描述是错的：**它不会让 CI 变红。**
`packages/hub/test/roles/charter.test.ts` 那条断言写的是【模板里仍然含占位串】为真，
把占位串换成一条真标准反而会红（`expected true to be false`）。
0006 §7 记着这次实测，也记着为什么没顺手把它改成会红的方向 —— 那会让 CI 常红，
而 CI 该不该常红由 CEO 定，不由实现层定。

七份模板都还带着这个占位串 ⇒ 七份岗位书的 `acceptance_criteria` 全是自由文本 ⇒
**今天没有任何一道门控能判成 pass，也没有一道会 reject：所有交接都会 escalate。**
这条是「谁写标准」这件事的真实代价，不是「CI 一直红所以有人会被催」。

## 4. 正例：一条完整、可判、方向正确的标准长什么样

以 dev 角色为例（**这是形状示例，不是替你定的取值** —— 数字要 CEO 认）：

```yaml
acceptance_criteria:
  # 读作：当覆盖率低于 80 时，拒绝交接。80 这个数抄规格 §8.1 的既有阈值，见 0008 §7.3。
  - condition: "metric:coverage < 80"
    action: "reject"
    message: "单测覆盖率低于 80%，见证据包 metrics.coverage"
  # 一条 criterion 只能一个指标，所以 P0 单独一条。
  - condition: "metric:p0_defects > 0"
    action: "reject"
    message: "存在 P0 缺陷，不得交接"
  # escalate 必须带 target，否则 schema 直接拒绝加载（「升级给空气」）。
  - condition: "metric:test_run_total == 0"
    action: "escalate"
    target: "tech"
    message: "一次测试都没跑过：可能是环境坏了，不该由门控判成合格或不合格"
```

三条各示范一件事：**方向**（`<` 配 reject）、**一条一个指标**、**escalate 必须有 target**
（没有 target 是 schema 级拒绝，编译期就报，不会静默丢掉 —— 这是七条字段里少数几个真拦住的）。

空数组不是「没有标准」而是配置缺陷：`acceptance_criteria: []` 会被 schema 拒（`.min(1)`），
即使绕过 schema，门控对空标准也是 **reject 而不是 escalate**（理由在那个文件里：
「没写标准」不该比「满足标准」更容易过关）。

## 5. 加载与版本：改完之后会发生什么

- **写法**：YAML，snake_case；zod 是 `.strict()`，**未知键一律拒绝**。
  所以 `model_tier_typo:` 这种拼错会直接报错（这是刻意的：被静默忽略的约束等于没写）。
  校验后的对象是 camelCase（映射写在 transform 里，所以字段只有一处定义）。
- **必填**：`version`、`honesty_boundaries`（缺即拒绝加载）。`decision_scope` 三个子键都必须出现，
  可以为空数组但不能省。
- **存放**：运行时的权威位置是 `role_charters` 表，不是仓库里的 YAML。
  仓库那份是 CLI 启动时的预置来源；改 YAML 不会改已入库的角色配置，
  要经配置页/CLI 存新版本才生效（这条容易踩，见 0015）。
- **版本语义（规格 §3.2）**：改动**只对新任务生效**，运行中的任务保持创建时版本。
  所以「改了标准但手上那个任务还是被旧标准判」是预期行为，不是 bug。
  门控取的是 `readLatestCharter(roleId)`，也就是标准本身不跟随任务版本 ——
  这一条值得知道，因为它意味着**放宽标准会立刻作用于所有在跑的任务**。
- **入库的是 camelCase 那份**（transform 的输出），不是 YAML 的 snake_case。
  `assertCharterShape` 查的就是 `roleId` / `version` / `acceptanceCriteria` / `modelTier` 这几个键，
  而 `role_charters` 表只有 `config` 一个 TEXT 列装它 —— 所以**手工往这张表 INSERT 一份 snake_case JSON
  是可能的**（schema 不在这条路上），它会在门控取标准时才炸。
- **组织图提交会带着岗位书一起升版**：`commitOrgGraph` 对每个 `reports_to` 变了的角色
  复制上一版 config、只改 `reportsTo` 再插一行（`packages/hub/src/org/commit.ts`）。
  两个后果：① 上一版里那条 `CEO-PLACEHOLDER-ACCEPTANCE` 会被原样带进新版本，
  「org 改过一次」不等于「标准跟着更新过」；② 没有上一版时它是**跳过而不是造一份**
  （造一份得编出 `acceptance_criteria` 那些必填字段，而那些字段的语义属 CEO）——
  这是实现层不代笔的一处具体执行，别把它当成漏写改成兜底。
  还有一格容易踩：config 是 camelCase，所以那段代码改的键必须是 `reportsTo`；
  写成 `reports_to` **不报错**，只会得到一份「汇报关系变了而 config 没变」的行。

## 6. 已知缺口（写标准时要知道自己在往什么样的门里写）

列在这里是因为**这些缺口会让 §4 那个「正例」今天也判不成**。它们不是本篇能修的，
但把它们留在文档里比留一个「照这篇写就能跑通」的假承诺好：

1. **`evaluateGate` 至今零生产调用方。** 图里没有节点调用它，门控结论目前不会真的拦下任何一次交接。
   所以「门控会拒」在今天的运行里是一句**关于代码的陈述，不是关于系统的陈述**。
2. **没有任何生产代码写 `evidence_bundles.metrics`**（§3 反例 ②）。
3. **`dev_to_test` 这一闸收任何 `bundle_type` 都照收。** 这一条要说准，否则会被读成「类型这一维没在判」——
   它**在判**：`HANDOFF_BUNDLE_TYPES` 这张表就在 `evaluateGate` 里，类型不符直接进 `reasons`（⇒ reject），
   未知方向则记 `unresolved` 而不是抛错（抛错会让整闸跳过）。
   **不对的是「包类型对上了」这件事今天意味着什么**：没有任何代码核对包里的 `metrics` 从哪来、
   `artifacts` 声明的 sha256 是否与磁盘一致（对账由调用方传 `integrityOk`，不传 ⇒ `unresolved`，
   而调用方今天不存在，见 §6 第 1 条）。于是交一个 `bundle_type: test_report` 而内容只有两句话的包，
   类型这一维就过了。
   ⚠ 这一条**不是**「再加一层 bundle_type 校验就能修」：那只会让 agent 改填 `test_report`。
   真正缺的是「指标与制品由 harness 产出、不由 agent 自述」那条对账接上（规格 §14.4 红线二）。
   （上面那句「这张表躺了很久却没有一个生产调用方」是 `evaluateGate` 文件头自己的原话，
   它指的是**整函数**零调用方，不是指那张表没被读。）
4. **`judgeCriteria`（`packages/contracts/src/charter.ts`）是死代码**，零调用方。
   判据只有一份生效，就是 §2 那个 `metricCriteriaEvaluator`。别照着它推行为。
5. **`role_id` 与文件名强制一致，而短名 vs 语义名尚未拍板**（计划 §10.2 D11）。
   模板用短名（`dev` / `test` / `tech`），规格附录 B 用语义名（`test_engineer` / `tech_director`）。
   改任何一份而不同时改委派图，委派边就会指向不存在的节点（`unknown_role`）。
   详见 `delegation-rules.md` §5。
6. **`saveCharterVersion` 零生产调用方。** 也就是说 §5 说的「改完 YAML 要存进 `role_charters` 才生效」
   这件事**今天没有入口**（配置页存版本的那条通路还没接上）。
   现在真正被读到的只有一条：CLI 的 `hub run` / `hub resume` 在装配时调 `loadPresetRoles()`
   直接把 YAML 读成内存里的预设表（`cli.ts` 的 `withHub`），供 `buildCompanyGraph` 选节点模型 ——
   **而它读的是仓库里的 YAML，不是库**。于是今天存在两个源、按用途分裂：
   跑图用的档位来自 YAML，门控（如果它被接上）要读的标准来自 `role_charters`，而那张表实测 0 行。
   连带地，「标准本身不跟随任务版本、放宽标准立刻作用于所有在跑的任务」这句在今天是
   **关于读路径的陈述**（`gateCriteriaForRole` 确实读最新版、且库里没版本时**抛错而不退回 YAML**），
   而不是关于一次真实改版的陈述 —— 因为还没有过一次真实改版。

## 7. 本仓在这一块犯过的错（避免你以为它们已被修掉）

1. **反例 ③ 犯过两次**，两次都是全绿通过，抓法都是「把标准改了看门控结论变不变」而不是读代码。
2. **反例 ④ 的后果写错过一次**：先前多处文档（含七份模板自己的注释）写着「没签完 CI 就一直红，
   不需要人工催办」。实测这条灯从来不亮、签字了才亮 —— 断言方向与注释承诺相反。
   **原句没删**（本仓纪律：错的陈述留着标出处），本篇 §3 反例 ④ 给的是复算后的版本。
   这次的教训不是「写错了」，是**一条护栏的另一半（签字字段）根本不存在，而没人发现它不存在**，
   因为注释读起来像它存在。
3. **「没有测试锁住 X」这类话只能由变异实验证明**（把 X 改掉看会不会红），不能由「我搜过了」证明。
   §1 那张表里所有「零读者」都是 grep 出来的，属于**较弱**的一档：grep 命中不了
   「某个用例之所以能过，是因为某字段没被读」这层因果。凡是本篇说「不生效」的字段，
   真正强的证据是改它而测试不红 —— 本篇没做那批变异，所以那些结论的地位是
   「我没找到读者」，不是「证明没有读者」。
