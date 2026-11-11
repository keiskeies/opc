# 0015　岗位书编辑与预算层级：`role_charters` 跑完迁移是 0 行，而「CEO 改了预算」这件事在代码上原本无处可存

> 本篇是 Task 3.6 的**实现记录**。编号顺接 0014（0002 按计划预约给 Task 4.6，仍空缺）。
> 落点：`packages/hub/src/charter/store.ts`（岗位书版本化读写 + 门控消费口）、
> `packages/hub/src/charter/budget-sync.ts`（USD→美分、限额 UPSERT、三级读回）、
> `packages/hub/test/charter/store.test.ts`（23 例）、
> `packages/hub/test/charter/budget-sync.test.ts`（20 例）。
> 计划那条 commit 写的是 `feat(web): charter editor…`。**本轮没有 web 那一半**，
> 做的是它必须站在上面的那一层；缺口在 §8，需要 CEO 拍的在 §9。

## 1. 一句话，加四条动手前量到的事实

计划 Task 3.6 的 Test 是：『修改 `acceptance_criteria` 后**重跑同类任务，门控行为随之变化**』
与『预算层级（公司 / 角色 / 任务）显示与编辑一致』。

这两句话在今天的代码上**都没有主语**：能改的地方没有，能读的地方也没有。四条实测事实：

| # | 实测 | 决定了什么 |
|---|---|---|
| ① | 跑完全部迁移之后 `SELECT COUNT(*) FROM role_charters` = **0 行**。src 里唯一那条 INSERT 在 `org/commit.ts:107`，而它带 `if (prev === undefined) continue`（没有上一版就跳过）⇒ 0 行会**永远是 0 行**。「保存一版新岗位书」在 src 里没有任何入口，只能从 `resources/charter-templates/*.yaml` 加载 | 「CEO 改了验收标准」这句话落到代码上是**无处可存**。所以 store.ts 的**第一条用例**就是断言这张表迁移后为空 —— 哪天有人加了这个入口，那条会红，逼他同时改写本篇 |
| ② | `charterSchema` 是 `charterInput.transform(...)`：输入 **snake_case**、输出 **camelCase**。把 preset 的 dev 岗位书按 `org/commit.ts` 的写法存进库、再取出来喂给 `charterSchema`：**14 条 issue**，第一条 `role_id: invalid_type` | 「读回来重跑一次校验」这件事**做不到**（会产出一个恒返回 undefined 的读取函数，而调用方把 undefined 读成「这个角色没岗位书」）。取舍见 §2 |
| ③ | `role_charters` **没有** `updated_at`/`created_at`，只有 `effective_from`（`0001_init.sql:144-152`） | 审计时间戳与 `effective_from` 共用同一个 `nowMs`，不假装表里有时间线 |
| ④ | `criteriaFromCharter`（岗位书→门控标准）在 src 里的**生产调用方是 0**；`BudgetTracker` 判超限时**只读 `budgets`、从不看岗位书** | 光把岗位书存起来不满足那条 Test。所以本轮**先把消费口做出来再交付**：`gateCriteriaForRole()` 与「保存即落限额」（§3） |

## 2. 读回不重跑校验：一个我选错了两次才选对的判断

三个候选，前两个我都以为是对的：

1. **重解析**。听起来最安全（「读到的东西一定符合当前 schema」）。实测**一版都读不出来** —— 就是 ② 那 14 条。
2. **写一个 camelCase→snake_case 逆变换再解析**。这样就能重跑了。但 `charterSchema` 的 transform 已经是一份正向映射，再加一份**逆向映射表**，两份必然漂移；漂移之后校验会悄悄放过或拒掉错误的字段集 —— 正是 0006 §7 那族「两份抄本」。要做对得先把 transform 抽成双向可逆（改 `@opc/contracts`），那是独立一轮的活。
3. **不重解析，直接返回**（最终选的）：写入侧强制过同一个 `charterSchema`，读回来只是取回事实。

**这个选法的代价必须一起读**：它意味着**校验只发生在写入那一刻**，于是「schema 后来收紧了」（contracts 加一个必填字段）会让历史版本读回来是 `Charter` 类型而实际缺字段。我挡不住这件事，所以配了 `assertCharterShape()` 作为**显式**读侧自检，并把「什么时候用它」交给调用方 —— 而不是在读取路径里塞一个假装在校验的 parse。

`assertCharterShape` 自己也弱，说清楚：它只查四格**有没有**（`roleId` / `version` / `acceptanceCriteria` / `modelTier`），不查形状。再往下查就是第二条 schema。**它是兜底，不是校验**，别把它读成「读侧有校验」。

## 3.【本轮最重要】岗位书里的预算与 `budgets` 表是两个源，不同步就是巧合

写完之后往下摸数据线，量到的是：

```
$ grep -rn "charter" packages/hub/src/budget/tracker.ts
   ⇒ 零命中。BudgetTracker.limitCents() 只读 budgets 表，从不看岗位书。
$ grep -rn "INSERT INTO budgets" --include='*.ts' packages/hub/src
   ⇒ 只有 tracker.ts 的 declareLimit 一处。
$ grep -rn "declareLimit(" --include='*.ts' packages/hub/src packages/hub/test test | grep -v "src/budget/tracker.ts"
   ⇒ 命中全在 test/。⇒ declareLimit 在【生产】里一次都没被调过。
$ grep -rn "consumed_cents" --include='*.ts' packages/hub/src
   ⇒ 除 tracker 的 `consumed_cents + ?` 之外，只有一处【读】（http/app.ts:1034 读来显示）。
```

> **行号与后效（Task 4.1 重测时补）**：上面那条 grep 报的 438 是当时的行号，现在那条读
> 在 `http/app.ts:1034`（同一行内容：Task 4.1 那轮顶下去 431 行，0031 那轮又顶下去 97 行。
> 同一行内容被顶过两次而无人重读坐标 —— 这正是快照守卫存在的全部理由）。
> 另外上面那四条测的是**本轮动手之前**的仓库，本轮自己就否掉了其中两条：
> `INSERT INTO budgets` 现在除了 tracker 那一处还有 `charter/budget-sync.ts` 的一处，
> `consumed_cents` 的【读】也不止一处（都在 budget-sync 里）。
> 原样留着不删 —— 「当时确实只有一处」是本篇结论成立的前提，改掉它就把
> 「测出来再动手」的痕迹抹成了「事后总结」。

四条合起来：**`budgets` 表在生产里从来没有被写过**，而岗位书里那两格预算（`daily_usd` / `per_task_usd`）从 YAML 加载进来后**从来没有流向过限流**。

也就是说，「CEO 把开发日预算改成 $5」这句话，在代码上要成立**必须**有一条从岗位书到 `budgets` 的通道。没有这条通道的话：屏幕显示 $5（读的是岗位书），执行侧按老数字放行（读的是 `budgets`，而那格可能压根不存在 ⇒ `limitCents()` 直接抛，见其报错原文『缺上限时不默认放行』）。**两个源各存一份、谁生效看谁后写 —— 那就不是配置，是巧合。**

所以 `saveCharterVersion` 现在在**同一个事务里**把 budget 两格落进 `budgets`（`applyBudgetRowsInTx`）。三条相关判断：

- **不另开一条审计。** 岗位书那条审计的 `state_snapshot` 已经带了整份 before/after（含 budget）。再补一条就是同一次变更两条记录，回放里显示成「CEO 做了两件事」。代价如实说：单看 events 看不出「这次岗位书变更顺带改了限流表」，所以把唯一需要主动喊的那一维（`alarm_silenced`，见 §4）放进**同一条**审计的 payload。
- **换算提前到事务外**（`saveCharterVersion` 里 `try { budgetRowsFromCharter(...) }`）。同一个失败如果发生在事务里，调用方拿到的是一个 `throw`；发生在外面，拿到的是与其它校验同一条通道的 `{ok:false, reason}`。**同一个失败有两种形状，是这一族最容易让上层写漏的地方**（它只会 catch 一种）。
- **留了 `applyBudgets?: boolean` 这个开关，而它【今天没有 false 的调用方】。** 我本来要在注释里写「org/commit.ts 那条组织变更路径要传 false」，实测否证了：那条路径自己直接 `INSERT INTO role_charters`（`org/commit.ts:107`），**根本不经过 `saveCharterVersion`**。所以这是一个**推测出来的**可扩展点，不是已验证的需求。注释里已经改成按 §7 那族账读，别按「已支持的场景」读。

## 4. 两个静默失效：`declareLimit` 的 no-op，和「调低预算会把突破警报永久关掉」

这两个都不是我写坏的，是既有语义放到「编辑器保存」这个场景里的后果。第二个我认为比本轮所有代码都值钱。

**(a) `declareLimit` 对已存在的作用域是静默 no-op。** 它的 SQL 是 `ON CONFLICT … DO NOTHING`。实测：declare 1000 → declare 2000 → `limitCents()` 仍是 **1000**。拿它做「保存新预算」，症状是**保存成功、数字没变、零报错**。我没有改 tracker（它自己的语义对启动期调用方是对的，且带 Task 1.6 既有用例），而是另给一个 `DO UPDATE` 版本。

一个必要的细节：`DO UPDATE` **即使写入值与旧值完全相同，`changes` 也是 1**（实测：SQLite 按「有没有匹配到行」计 changes，不按「值有没有变」；连普通 UPDATE 写同值都是 1）。所以「这次保存有没有改动东西」**不能**靠 changes 判 —— 只能先读一次旧值比。测试里有一发**元断言**直接证明 SQLite 给不出这个信息，否则将来有人把那次多余的读「优化」掉，用例不会红。

**(b) 把上限调到已消费量之下，突破警报永久关闭。** 实测三段连读：

| 步骤 | 结果 |
|---|---|
| 消费 1200 / 上限 1000 | `breached=true`，`BudgetPaused` **1 条** |
| `UPDATE limit_cents = 500` | **不发任何事件**（仍 1 条） |
| 之后再消费 100 | `applied=true`、**`breached=false`**、`over=true`，仍 1 条 |

成因是 `tracker.ts:233` 那行 `breached = before <= limit && after > limit`（「跨过才算突破」，注释写明是为了不让收件箱被同一条超限刷满 —— 那是对的需求）。而 `consumed_cents` 在整个 src 里**只有 `+ ?` 一处写入**（实测，见 §3），**没有任何归零/重算路径** ⇒ consumed 单调不减 ⇒ `before <= limit` 一旦为假就**永不为真**。

于是那个作用域的突破警报**永久关闭**，而关掉它的是一次看起来无害的「把预算从 $10 调到 $5」。屏幕上写着「预算已收紧」，`over` 也确实是 true，而**没有任何东西会为它发声**。

我的处置：`syncCharterBudgets` / `saveCharterVersion` 自己算并报 `alarm_silenced`（进审计 payload），另给一条读侧补救 `silentOverBudgets()`。**没有替它补发 `BudgetPaused`**：那个事件要求 `taskId`（`bus.ts:58`，`tracker.ts:238` 传的是消费方的任务），而一次限额变更不属于任何任务 —— 编一个 taskId 就是伪造一条 CEO 点得进去的卡片（同 0014 §3：少一个事件是可以补的缺口，脏了的审计库删不掉）。

**「一次超限该发几条 BudgetPaused」是产品问题**（收件箱刷屏 vs 警报永久哑），归 CEO，见 §9 第二项。

## 5. USD → 美分：2001 个两位小数里 271 个直接乘不是整数

实测：0–20.00 逐个 `usd * 100`，**271 个不是整数**（`0.07 → 7.000000000000001`、`0.29 → 28.999999999999996`）。`assertCents` 会当场拒它们，而报错说「必须是整数美分」—— 一个从 YAML 抄 `daily_usd: 0.07` 的人会以为自己的数字写错了。

**但不做无条件 `Math.round`**：那会把 `0.005` 悄悄抬成 `0.01`，而「悄悄抬」的方向是让 CEO 批的钱比他想的多。判据是「离整数够不够近」：容差 1e-9，够近才算同一个数，否则拒（规格 §6.1 以美分为最小单位）。容差的量级是选出来的，注释里写了别改成 1e-6 或 1e-12 —— 浮点表示误差在这个题面上是 1e-14 量级，而「真的有半分钱」的差距是 5e-1，1e-9 两边都有几个数量级余量。

`charterSchema` **允许** `daily_usd: 0.005`（只要求非负数），所以拦得住它的只有这一层。测试里带一发元断言：先断言「朴素写法在 2001 个里坏 271 个」，再断言本函数 2001 个全部换算精确等于 `i`。

## 6. 规格没给公司级默认值，所以我不编

§21.1 只说「公司级 → 角色级 → 任务级，任一层级达到阈值自动暂停」，没有任何数字。preset 七份岗位书 `daily_usd` 合计 **150**、`per_task_usd` 合计 **49**（实测逐份相加）。

两件事跟着定：

- **不编公司级默认值。** 150 是七份 YAML 的和，不是「公司每天该花多少」。拿它当公司上限等于让 CEO 的 YAML 措辞变成公司预算决策 —— 而 §4.4.3 明写 `company_budget: "ceo"`。所以 `budgetRowsFromCharter` **只出 role 层两行**，公司级/任务级必须由调用方**显式**传值；测试反向断言「结果里出现 company 就是错的」。
- **不断言 `task ⊆ role ⊆ company`。** 它听起来是三级预算的应有之义，而在现成数据上**根本无从判定**（公司级一行都没有）。而且规格没说是「数值嵌套」还是「三道各自独立的阈值」：若是嵌套，某角色 `per_task` 5000¢ 该不该 ≤ 它自己的 `daily` 1500¢？并发四条任务时角色日额会被四条 per_task 一起打穿 —— 那既不是 bug 也不是 feature，规格没说。所以只做**能算的那一半**：`budgetTierSummary()` 报告每一级**声明了没有**，不猜没声明的那一级，也不给「三级关系不成立」这种没有判据的结论。

「显示与编辑一致」那一维交给 `readBudgetTiers()`：它把**没声明**与**声明为 0** 分成两种值（`declared:false + limit:null` vs `declared:true + limit:0`）。合并成 0 会让「这个角色没配预算」显示成「这个角色预算是 0」，而界面上那两种东西该说的话完全相反（前者是「没设限」，后者是「一分钱都不许花」）。入参要调用方给「期望有哪些格」而不是 `SELECT *`：用 `SELECT *` 时从没声明的作用域会**整行不出现**，界面只能渲染成空白，而空白与 0 在屏幕上是同一个东西。

## 7. 我这边做错的三件事

1. **夹具第六次说谎，而且这次谎在两处，其中一处「用例根本不会红」。**
   - `bundle_type` 我凭印象写成 `test_report`，实测 `HANDOFF_BUNDLE_TYPES`（`contracts/evidence.ts:165`）里 `dev_to_test → code_diff`。后果不是「用例红」—— 每一发 `evaluateGate` 都在规格 §8.1 那一维 reject，而**「改了标准 ⇒ 结论翻转」那两条用例仍然全绿**（它们只看 `decision`），**岗位书那一维从未进入判定**。这是这一族最坏的形状：夹具假装具备的性质恰好是用例要证的性质，而**分辨不出来的方式是「全绿」**。
   - `evidence_refs` 我写成 `[0]`（下标），实测是**字符串路径**，当场 `TypeError: r.split is not a function`。这一发是红的，比上一条便宜得多。
2. **`metric:coverage >= 80` 配 `action: reject`。** 0008 §7.3 末段专门写着我在这个题面上错过一次：condition 的语义是【不合格的情形】，`>= 80` + reject 表达的是「覆盖率好就拒」，症状是**全绿而门控从不拦任何东西** —— 本仓点名最难发现的那一形。**我隔了几轮又写了一遍。** 区别只是这次被自己新写的夹具用例当场拦住。记这条不是因为红了，是因为它证明「把教训写进文档」不等于「下一次的我会去读它」。
3. **报错文案路由错，而且第一版断言恰好分辨不出。** camelCase 草案里没有 `role_id`，所以「roleId 不一致」那条**先**命中，把人指向「角色名拼错」这条死路（真问题是十四个键名全错）。我先写的断言是 `toContain("snake_case")` —— 而「不一致」那句里本来就带 snake_case 字样，于是**断言绿而诊断仍然错**。修法是先单独认一次 camelCase 形状，再加一条 `not.toContain("不一致")`。这条的价值在反向对照那半：防的是「有人在错误文案后面追加一句 snake_case 提示」—— 断言立刻转绿而主诊断仍然是错的。

## 8. 没做到（不写成「换种方式做到了」）

- **没有编辑器界面**。计划写的是 `feat(web)`，本轮交付的是它下面那一层。原因还是 0009 §2 那三条通路（装不上 `@xyflow/react` 那一组）。表单页本身不需要 React Flow，但需要 React + 路由 + IPC 那一套，而 `test/desktop/ipc-surface.test.ts` 用 `toEqual` 钉住 IPC 面、本机没有 Electron 可验（0009 §7 已经报过这本账）。
- **没有 HTTP 端点**。加一个端点要同时动 `contracts/api.ts` / `http/app.ts` / `desktop/main/channels.ts` / `preload/api.ts` 四处并被那条 IPC 守卫钉住。所以 `saveCharterVersion` / `syncCharterBudgets` / `readBudgetTiers` 今天的运行时消费者是 **0**（同族缺陷**第六次**：0011 §8 / 0012 §7 / 0013 §7 / 0013 §10.1 / 0014 §3 / 本轮）。发现方式仍然是**写文档时顺数据源往下摸**，不是「想到去查调用方」—— 第六次了，说明那个习惯还是没建立。
  这一族我在 0014 学到的处置沿用了：把缺口本身**钉成断言**（两个测试文件各有一节扫 `src` 目录，断言 `charter/` 之外零调用方），接线那天它会红。
- **`org/commit.ts` 那条 bump 路径不落预算**，也不经过 `saveCharterVersion`（§3）。准确的状态是：它**逐字复制** `prev.config` 再改一个 `reportsTo`（`org/commit.ts:304-310`），所以它写出的形状**取决于上一版存的是什么**，本身不会丢字段；而且**它今天根本不触发** —— 表是 0 行（事实 ①），`if (prev === undefined) continue` 每次都跳过。【撤回】我在此处原写「它写的还是旧 config 形状（缺 `modelTier`）」：那是我没实测就写下的具体断言，实测 org/commit 并不硬编码任何形状，缺 `modelTier` 的是 `test/org/versioning.test.ts` 的**测试夹具**（那是 assertCharterShape 用例举的例子，不是生产会写出的东西）。这条**不在本轮范围内修**，因为改它要同时决定「组织变更要不要改限流」（那是 §9 第三项）。
- **预算的「已消费」永远单调不减**：`daily` 这个 period 名字暗示每天归零，而 src 里**没有归零路径**（实测）。所以「今天的日预算」实际是「自首条消费以来的总额」。这是 `BudgetTracker` 的既有行为、Task 1.6 的验收范围之外，但**它让 §21.3 那句「日消耗 vs 预算」的条形从一开始就是错的**。登记在此，不在本轮改（改归零时机是新的运行期行为）。
- 未跑 `pnpm verify`（本机装不上依赖，沿 0009 §2）。本轮跑的是：
  - 全量 **786 例 / 741 pass / 37 fail**（上一轮基线 743/698/37：用例数 +43，失败数不变）。
    红名单 60 行与 pin 住的基线 `diff` **完全一致** —— **没有既有用例转红**。
    （中途它一度是 739 pass / 39 fail：多出的两条是我注释里三处指向【尚未创建的 0015】的
    前向引用被 `comment-citations` 抓的 —— 那条守卫是对的，本篇创建后自动消解。
    这条时间差写下来是因为它正是「引用先于目标存在」这一族：**先写引用、后补目标**，
    中间那一小段仓库是红的，而红的成因不是逻辑错、是文档没写完。）
  - `tsc -b --force` **34 错**，与基线同数，且不含两个新文件（中途我自己引入过一个 TS2339，`readonly` 累加器类型，已修，非用 `as` 糊）。
  - 文档守卫（doc-refs / doc-coords / doc-ids / comment-citations / decision-index /
    pending-decisions / commit-msg-refs / dependency-boundary / test-inventory 全在 `test/arch/`）
    **与基线红名单逐条相同、零新增**。本轮为消解它们付了两次账：
    ① 三个 `0015 §N` 前向引用（建篇即解）；② 我在 0015 与源码注释里写的**行号引用有一批指错了行**
    （那句 `breached =` 我说成在 tracker 的第 233 行前方两行处、claimSchema 的 code point 区间
    起点说早了一行、budgets 的 DDL 起点也说早了一行）—— 逐条 `sed -n '<行号>p'` 读过原文才改，
    并把 0015 的 `文件:行号` 逐条登记进 doc-refs 的 `SNAP`（快照内容从**被引用文件**抄，
    不从 0015 正文抄 —— 那等于让快照抄文档，守卫当场失效）。
    **这里付了一笔与 0014 §8 同一族的账**：我为了「记下自己写错过哪些行」而在正文里
    写出了那些**错误的**坐标，`doc-refs` 立刻把它们当成【活坐标】来要快照，
    而其中一个错号落在空行上、根本进不了快照。守卫是对的 ——
    **一个错误的坐标不该以坐标形态存在于文档里**。改法是用「第 N 行」这种非坐标写法
    把具体数字留住（诚实要求数字还在，只是不能长得像活引用），
    与 doc-refs 注释里那条「0006 正文刻意写『第 225 行』而不是坐标形态」是同一个技巧。
  - 两次变异实验（脚本先断言源串在文件里，否则 `exit 9`，同 0013 §8）：
    `DO UPDATE → DO NOTHING` 被 3 条用例抓到；删掉 `saveCharterVersion` 里的预算落库那一步被 2 条抓到。**两次变异都到了被测代码**（每次先确认过 `cp` 备份 + 红数变化）。

## 9. 需要 CEO 决策

三项。第一项卡 Phase 3 出口门禁里『改验收标准 → 门控结果变化』能否被判绿。

1. **`acceptance_criteria` 由谁写这件事，本轮有了新变化但没被解决。** 0008 §7 等的是 CEO 签字，七份模板今天仍是 `CEO-PLACEHOLDER-ACCEPTANCE`。本轮新增的事实是：**库内通道现在有了解**（`saveCharterVersion`），所以签完之后不必再等一轮开发 —— 但**它一次都没有被调用过**（§8），且 `gateCriteriaForRole()` 在库里没存过岗位书时**抛错而刻意不退回 YAML 模板**。于是今天的真实状态是：**门控能读库，而库里是空的**。要让它转起来，需要的只是「CEO 把签好的七份标准写进库」这一个动作 —— 但那个动作需要一个入口（HTTP 或 CLI 或一次性脚本），而入口要不要开、开在哪一层，是产品决定。三个候选：**只做一次性 CLI**（最省，够 Phase 3 门禁跑通，代价：以后每次改标准都要命令行，违背 §19.1「无需命令行」）/ **开 HTTP 端点**（要动四处并被 IPC 守卫钉住，见 §8）/ **等 Phase 4 的编辑器**（那 §23.1 Phase 3 这条验收本期判不了）。**我倾向第一个**，理由是本期的瓶颈是「能不能验」而不是「用得爽不爽」，而第二个的成本 0009 §7 已经报过两次。
2. **一次超限该发几条 `BudgetPaused`**（§4b）。今天的实现是「只在跨过那一刻发一条」，代价是**调低上限后警报永久哑**。三个候选：**保持现状 + 界面显示 `silentOverBudgets()`**（我倾向这个，零运行期行为变更，代价是 CEO 得去那个面看一眼）/ **改成「处于超限态的每次消费都发」**（代价：收件箱被同一条超限刷满，那正是原注释要防的）/ **让限额调低本身发一条事件**（要给它一个 `taskId`，而它不属于任何任务 —— 我不愿意编，见 §4b）。
3. **`org/commit.ts` 那条 bump 要不要顺手落预算**（§3 末、§8 第三条）。组织图动的是汇报关系，预算没变，所以它今天既不碰 `budgets` 也不该被默认认为要碰 —— 但「一次组织变更顺带 bump 岗位书」时那句「预算要不要跟岗位书同步」得有个答案（我的通道默认同步、org/commit 那条默认不同步，两条路径不一致本身就是 §3 那个「两个源」的另一张脸）。**不卡当前阶段**（那条路径今天不触发，表是 0 行），卡下一次动 org/commit 的人。

## 10. 复算命令

```bash
# ① 岗位书表迁移后是空的（§1 ①）。期望输出 c = 0
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node --experimental-transform-types -e '
const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");
const {migrate}=await import("./packages/hub/src/db/migrate.js");migrate(d);
console.log("role_charters =",d.prepare("SELECT COUNT(*) c FROM role_charters").get().c);'
# ② 两个源（§3）。第一条应零命中（tracker 不看岗位书），第二条应只有 tracker.ts 一处
grep -c "charter" packages/hub/src/budget/tracker.ts
grep -rn "INSERT INTO budgets" --include='*.ts' packages/hub/src
# ③ USD 浮点陷阱（§5）。期望 271
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node -e '
let n=0;for(let i=0;i<=2000;i++){if(!Number.isInteger((i/100)*100))n++}console.log(n)'
# ④ 本轮两个模块的运行时消费者（§8）。期望 src 侧只剩 charter/ 目录内部
grep -rn "saveCharterVersion\|syncCharterBudgets\|gateCriteriaForRole" --include='*.ts' packages/hub/src | grep -v "src/charter/"
```

①②③④ 都只依赖仓库文件与本机 Node，任何人随时可跑。跑测试本身依赖 `/tmp/opc-harness/`（离线夹具，按 0012 §7 的口径不进仓库也不进 `node_modules`）—— 没有它只能用 `pnpm test`，而 `pnpm verify` 本机跑不了（0009 §2）。所以「我跑过 786 例」这句话的**可复现等级低于上面这四条**，别混着读（0014 §11 同一条口径）。
