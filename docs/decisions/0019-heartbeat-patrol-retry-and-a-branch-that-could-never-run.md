# 0019　心跳巡检与重试落地，以及「零生产调用方」这一格怎么补

上一轮（0018）交出完整性检查与备份两个模块，本轮去接它们说【零调用方】那一格。
顺带把计划 Task 6.1 的两半（重试、停滞检测）做出来 —— 那两半此前一行代码都没有。

这份文档只写四样：量到的事实、我改了的偏离、我自己写错的地方、没做到什么。

## 1. 先给实测

本机 `node:sqlite`（SQLite 3.51.2 / Node v24.14.0），复算命令在 §7。

1. **一份迁移过而【空】的库，完整性检查报 `ok=true`。** 实测七条检查里
   `page_integrity` 是 ok，其余六条全是 `not_observable`，`events=0`，整份报告 `ok=true`。
   这条决定了巡检入口【绝不能创建库】：`openDb` 会建文件，
   于是「库文件路径打错一个字母」会产出一份【全绿】的巡检报告。
   入口因此先 `existsSync` 再动，且理由写进报错文案。

2. **只 `openDb` 而不迁移的库，报的是 `could_not_run` 而不是 `violated`。**
   实测：`state_machine_agrees_with_events` 抛 "no such table" ⇒ `could_not_run`，
   其余 `not_observable`。0018 §4 那张表里 `could_not_run` 的分工在这一库里第二次被观察到，
   而且这一次它给的答案是对的：库没坏（页面 ok），是尺子放不下。

3. **中段覆写 512 字节之后，`PRAGMA integrity_check` 仍然报 "ok"。**
   写的字节落在 freelist / 未使用区，btree 结构完好。
   这条否掉了备份测试的第一版夹具 —— 那份夹具【什么都没 corrupt】，
   而它看起来是在测损坏处理，断言还会全绿。

4. **把中段【整页】（page size 从文件头第 16 字节读，本机 4096）覆写掉，
   连接开得了而检查报 `violated`。** 拿到的是
   `*** in database main *** Tree 9 page 9: btreeInitPage() returns error code 11`。
   这才是「库能打开而检查说坏了」那个态，也是 §5 那条决定唯一能被测出来的形状。
   与 0018 §1 第 11 条合起来读，损坏库有【两种不同的失效】，要分开测：
   截断 ⇒ 连开都开不了；整页坏 ⇒ 开得了而检查报 violated。

5. **`openDb` 自己会抛。** 截断到 50% 的库在 `applyPragmas` 那一步就抛
   "database disk image is malformed" —— 连 `PRAGMA integrity_check` 都没跑到。
   这条直接改掉巡检入口：见 §4。

6. **`json_extract(payload,'$.kind')` 在内存 sqlite 上可用**，
   而载荷缺 `kind` 时返回 NULL，`NULL <> 'x'` 是 NULL 而不是 true ⇒ 那种脏行
   【不】算真实事件。两种写法（显式 `IS NOT NULL` 与靠三值逻辑）实测结果相同（都取到 200），
   所以 §3 里那条 SQL 加显式判据【不是为了改行为】。

7. **完整性扫描自己会往 `events` 里加一行。** append-only 探针撞触发器之后
   必须由应用层补一条安全审计（0018 §1 第 7 条：触发器里的写会被 `RAISE(ABORT)` 回滚），
   于是「跑过一次检查」这件事本身让 events 从 1 行变 2 行，
   备份拿到的必然是【检查之后】的状态。备份条数因此不能断言成夹具里写的那个数。

8. **`DELETE FROM events` 被自家触发器挡下**（"events table is append-only"），
   而且这一次是在【测试夹具】里挡下的。0018 §6 第 6 条记过同一条坑，本轮原地重犯。

## 2. 加了一个模块，它只回答一个问题

`packages/hub/src/heartbeat/patrol.ts` 判的是「哪些任务【悄悄停了】」，
定义是四条同时成立：还在干活的状态里、超过阈值没有真实事件、没有人在等它、
而且这一轮还没报过。默认阈值取【两个】心跳间隔（规格 §7.3 的 15 分钟 ×2），
理由不是保守：一个间隔意味着「调度抖一下 + 一个慢 LLM 调用」就能让 CEO 收到一张卡，
而这种卡片出现三次之后，巡检真正想报的东西就没人看了。

三条不做什么，每条都有出处，且每条都有测试钉住：

- **不改 `tasks.status`。** 规格 §7.1 里 `BLOCKED` 只有【一条】入边（`IN_REVIEW→BLOCKED`），
  所以「检测到停滞就置 BLOCKED」对停在 `IN_PROGRESS` 的任务是【非法跃迁】，
  而跃迁写进 append-only 的 events 就永远在那儿。
- **不往 `approvals` 插卡片行。** 规格 §7.3 要的是【信息性】异常卡，
  而 `approvals.approval_type` 五个取值没有一个表达信息性；那张表装的是
  「能被 `POST /approvals/:id` 回答」的决策卡，而它的 id 来自 LangGraph 的 interrupt。
  异常卡没有 interrupt，回答它没有语义。多插一行反而会造出一张【永远批不掉】的卡。
  写 `HeartbeatStalled` 事件就够了 —— 计划 §6 那张四卡片表说的就是卡片由事件投影。
- **不是独立调度器。** 规格 §7.3 最后一条明确「而非独立外部调度器」。
  恢复（把任务推回图里）要真图执行，那一半要 `@langchain/*`。

停滞时钟的两个方向都必须对，否则会写出「第一天好用、第三天开始说谎」的代码：

| 若… | 后果 |
| --- | --- |
| 把 `HeartbeatStalled` 算进「最后动作」 | 报给 CEO 的停滞时长每巡检一次归零，一张停了三天的卡永远显示「已停滞 15 分钟」 |
| 完全不记它 | 每轮都为同一个任务再写一条事件，收件箱被同一个任务刷屏 |

所以：时钟只认真实事件；「这轮报过没有」= 最后一次心跳事件是否【不早于停滞起点】。

## 3. 与规格 / 计划字面的偏离

- **「挂着未决审批卡片」是【永久】免检，不是「阈值内免检」。**
  规格 §7.3 把「审阅者未响应」列为追问成因之一，看着像该由心跳催。
  但催它不是心跳的职责：`approvals` 表自带 `timeout_at` / `timeout_behavior` 两列，
  那才是「卡片挂了多久、超时之后怎么办」的机制。心跳管「悄悄停了」，超时管「问出去没人答」。
  做成阈值内免检（超阈值就报）看着更严，实际是拿 30 分钟的节奏催人类审批。
  **代价照记**：一张被【忘掉】的卡片不会由本模块报出来。今天这个代价是零，
  因为 `approvals` 在生产里【一次 INSERT 都没有】（0013 §10.1 实测），
  而 `timeout_at` 那两列同样没有任何读方 —— 两条通道都还没接通。接线那天要重看这一格。
- **「有没有人在等这张卡」由【事件配对】得出，不查 `approvals.status`。**
  配对靠 `target`：`recorder.ts` 的 `targetOf` 把 `ApprovalRequired` 与 `ApprovalDecided`
  都映射到 interruptId，注释里写明「必须能在 target 上 join 得起来」。
  不查 `approvals.status = 'pending'` 的理由是实测的：那张表在生产里零 INSERT，
  查它的巡检在真库上【恒为 false】，于是「等 CEO 的任务不被催」这条保护一条都不生效，
  而它在测试里也测不到 —— 测试得自己造卡片行，于是测试绿而生产不生效。
- **`TERMINAL_STATES` 含 `DELIVERED`。** 规格 §7.1 里它只有 `DELIVERED→ARCHIVED` 一条出边，
  而 `ARCHIVED` 是归档不是工作。把它当活跃任务的结果是：
  每一个交付完而未归档的任务在两天后都长出一张异常卡。
- **计划根 scripts 表那行 `backup: tsx packages/hub/src/db/backup.ts` 落不到 backup.ts 上。**
  `backup.ts`【没有 CLI 入口】，那是刻意的：它的一条门禁是「除 node:* 与自身外零 import」，
  测试扫的是它的可执行 import（`backup.test.ts` ⑤）。给它加个入口去 `openDb` / `WriteQueue`，
  那条门禁当场作废。可执行面因此落在 `heartbeat/maintenance.ts`，
  `backup.ts` 保持纯函数库。新增脚本 `hub:maintenance`。
- **计划 Task 6.1 的 Test「注入网络错误 / harness 崩溃 / LLM 超时三类故障」只做到等价类那一层。**
  真注入要真图执行（`@langchain/*` 装不上，0009 §2）。交出来的是
  三个可重试分类 + 一个 `sleep`/`now` 全注入的执行器 `withRetry`，
  以及【分类】本身 —— 见 §4 第二条。
- **Task 6.1 的「用巡检测试守孤儿活跃任务」这一条【做到了】**，
  而且是真库跑：`patrol.test.ts` ② 用真迁移库、真事件、真写队列，
  四格任务（该报 / 终态 / 刚动过 / 等人）同时存在时只有该报的那格被报。

## 4. 三处「不这么做就会静默」的修补

1. **`openDb` 抛 ⇒ 入口必须说人话。** 巡检入口存在的全部意义，
   是在库坏掉那一刻告诉使用者「先停 Hub、先把现网库改名留一份、然后按 scripts/restore.md 走」。
   不捕 `new WriteQueue(dbPath)` 的抛错，那一刻交出来的是裸 SQLite 报错 + 堆栈 + 非零退码，
   而那句话说不出来。退码用 1（库坏了）而不是 2（命令写错）——
   运维脚本按退码分支，2 会让人去检查命令行而不是去恢复数据。

2. **重试的分类比「重试三次」重要。** 「失败就重试三次」是错的默认值，
   本仓有三类失败重试只造成损失：预算硬停（再跑只是多烧钱，规格 §7.4 要的是暂停 + 卡片）、
   越权（第 N 次仍然越权，且每次都留一条审计）、非法状态跃迁（我们自己的边表在报错）。
   混在一起重试的后果是 events 里出现四份同类失败，
   而回放把这段读成「agent 反复尝试」—— 一个从未发生的意图被写进了 append-only 的历史。
   `unknown` 也归到【不可重试】，与 `policy/engine.ts` 的 fail-closed 同一个立场。

3. **`withRetry` 不向调用方抛，而是返回 `ok:false` + `lastError` + `attempts`。**
   重试执行器把异常重新抛出去，等于把三次失败压成一条 rejection，
   而调用方最省事的写法是 `.catch(() => log(e))` —— 那一支就是 Task 6.1 要防的静默停滞本身。

4. **备份前先看页面检查，不过就不备份。** 保留策略只留最近 7 份，
   一份已知损坏的备份写进去就成了【最新】那份并挤掉一份好备份，
   而 `restoreDrill` 之后验的正是最新那份可用。
   不备份的代价是「今天少一份备份」，备份的代价是「少一份好备份 + 一份看起来好的坏备份」，
   后者不可逆。判据只看 `page_integrity`，不看整份报告的 `ok`：
   「没有门控决定可核」(`not_observable`) 跟「文件坏了」是两件事，后者绝不该拦备份。
   **这一条不替 0018 §8 拍板**：那一节问的是「多久跑一次」，
   这里定的只是「既然要跑，先查还是先拷」。

## 5. 我自己写错的地方

1. **`judgeTask` 里 `awaitingApproval` 那一支写在时长判定【之后】，于是永不生效。**
   放后面之后，它只在「沉默未过阈值」时才可能命中，而那种情形上一行就已经返回
   `recent` / `never_started` 了。整条分支是死的，而测试第一版还全绿 ——
   因为我同时把那条测试写成了「挂卡 + 一小时前」，恰好落进 `recent`。
   是「反向对照必须成对」这条纪律抓出来的：补上「同样一小时前、`awaitingApproval: false`
   ⇒ 必须 stalled」这一发之后，两支的差别才第一次被观察到。
2. **去重基准用了 `lastRealEventAtMs`，于是【从没跑过】的任务永远去不了重。**
   那种任务 `lastRealEventAtMs` 是 null，条件里的 `!== null` 直接短路，
   结果每轮巡检都为它写一条新事件。基准必须是停滞起点（null 时是 `created_at`）。
3. **`never_started` 这一格我观察不到它。** 六个探针配两个时刻（1 小时 / 100 小时），
   而阈值是 30 分钟 —— 两个时刻【都在】阈值外，所以 `recent` 与 `never_started`
   根本没被产出。一条「集合 == 枚举」的断言因此少测两格。
   补的时候我顺手把逐格点名也加上了：只比集合的话，
   「`stalled` 这一格其实是被 `never_started` 那次调用凑出来的」看不出来。
4. **测试订阅总线【晚于】publish。** 总线只在 publish 那一刻投递给当时的订阅者，
   事后 `subscribe()` 不带游标就是「只收未来」，那条 `await` 永远挂着 ——
   整个文件挂在 240 秒超时上，看不出原因。
5. **`@langchain` 与 `setInterval` 的门禁扫了【注释】。** `patrol.ts` 的头注释里
   就写着「那一半要 `@langchain/*`」和「故意不 setInterval」，
   于是两条「不该出现」的断言当场红，而代码是干净的。
   这是 0018 §6 第 4 条【原地重犯】。修完之后我把反向对照也钉上了：
   断言「注释里确实有这个词」，这样「剥注释」这一步本身不再可能悄悄失效。
6. **`expect(r.recorded).toEqual([{ taskId: "T1", seq: 1 }])` 这种写法我一开始写的是
   `expect.any(Number)`，而它嵌在 `toEqual` 的对象里。** 本仓离线夹具的 `matchValue`
   支持嵌套不对称匹配器，所以它其实能过 —— 但同一批里另一条用
   `readFileSync` 的写法在测试文件顶层写了 `require("node:fs")`，
   而这是 ESM。趁跑之前换成了真 import。
7. **夹具用 `DELETE FROM events` 把任务摆老**，被自家 append-only 触发器拒下（§1 第 8 条）。
8. **CLI 那两条用例拿 `T0`（2026-11-12）当停滞基准，而 CLI 没有注入时钟。**
   T0 相对真实【现在】是未来，`silentFor` 被 `Math.max(0, …)` 夹成 0，判 `recent`，
   于是「停滞存在 ⇒ 退 1」恒红。修法是让夹具的停滞基准可注入，
   CLI 那两条改用真实此刻往前推的时刻 —— 而不是给 CLI 再包一层假时钟，
   那会让退出码测试测的是一个假时钟。
9. **`--no-backup` 被判成失败（退 1）。** 第一版把「跳过备份」一律算问题，
   于是那次「只想看一眼」的跑法每次都红。显式跳过是【人的决定】，
   而一个恒真的告警等于没有告警 —— 与 §2 里告警疲劳同一条理由。
10. **`MaintenanceInput` 一开始有 `db` 与 `read` 两个连接字段。** 两处消费者都只读，
    给两个字段就是允许有人一处传写连接一处传读连接，
    于是「检查跑在写连接上」（会卡写队列）这种形状可以静默发生。合成一个字段。
11. **一段走不到的代码，我给它编了个成因。** `withRetry` 末尾那个「不可达分支」
    第一版写的理由是「判据与上界不一致时会走到这里」—— 那是一句
    无法被测试触达也无法被证伪的安慰话。改成写明【按构造不可达】、
    并把两个数打进消息里。

## 6. 没做到（不写成「换种方式做到了」）

- **常驻进程 / 真调度器还不存在。** `maintenance.ts` 是「叫一次跑一次」的入口，
  模块里【没有 setInterval】（有测试钉住）。规格 §7.3 的「每 15 分钟一轮」
  需要一个活着的 Hub 进程，而那需要 `serveHub` 有生产调用方（今天零，0018 §5）。
  今天能跑的形态是外部定时器（cron / launchd）按 15 分钟拉一次 `pnpm hub:maintenance`；
  这不违反规格 §7.3 那句「而非独立外部调度器」吗？—— 违反了一半：
  调度是外部的，但【状态判定与追问结论】仍在 Hub 内、仍读同一份库，
  没有把任务状态搬到外部去。这一条留给 0018 §8 一起拍。
- **`withRetry` 零生产调用方。** 接线点是 LangGraph 节点外面那一层，要 `@langchain/*`。
  `patrol.ts` 与 `maintenance.ts` 已经有调用方（CLI + 测试），retry 没有。
- **心跳不恢复任务。** 规格 §7.3 说追问结果可以是「自动恢复」，
  那一半要把任务推回图里跑，同样堵在图运行时上。
- **`HeartbeatStalled` 的卡片投影没做。** 事件写进去了，桌面端把事件投影成
  「信息性卡片」那一层是 Task 2.x/3.x 的界面活，本模块不冒充做了。
- **等人类审批超时（`timeout_at`）至今没有任何读方**（§3 第一条的代价来源）。
- **`approvals` 仍零 INSERT**（0013 §10.1），所以「等人」那一格今天的真库形态是
  「永远没有 pending 卡片」，靠的是【状态枚举】而不是卡片行。

## 7. 复算命令

```bash
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/heartbeat/patrol.test.ts"      # §2 六格判定 + §3 那三条不做
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/heartbeat/retry.test.ts"       # §4 第 2、3 条
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/heartbeat/maintenance.test.ts" # §1 第 1、3、4、7 条 + §4 第 1、4 条
```

对应关系：§1 第 1、2 条在 maintenance ③ 那条 `not_observable 不拦备份`；
§1 第 3、4 条在同一条里的 `corruptWholePages`（512 字节那版已被证伪，见正文）；
§1 第 5 条在 `库根本开不了` 那条；§1 第 7 条在 `健康库：备份文件落地` 那条
（断言写成 `>= 1` 且等于 `eventsInBackup`，而不是夹具里的 1）。

测试跑法与本机依赖边界见 docs/INDEX.md 与 0009 §2；
`pnpm verify` 在本机仍不可运行（缺 `@langchain/*` 等），上面这些是离线夹具路径。
