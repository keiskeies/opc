# 0018　离线备份、完整性检查，以及三处「检查自己会抛」的洞

本轮做计划 Task 6.2（完整性检查挪出主线程）与 Task 6.3（`VACUUM INTO` 备份 + 恢复演练）。
两条都在本机做完了能做的部分，也都在本机撞到做不了的部分。这份文档只写三样东西：
量到的事实、我改了的偏离、我自己写错的地方。不复述设计文档，也不替未做的事记账。

## 1. 先给实测，再给结论

下面每一条都是本机 `node:sqlite`（SQLite 3.51.2 / Node v24.14.0）上跑出来的，
复算命令在 §9。它们的价值不在于「知道」，而在于每一条都改掉了实现的一处形状。

1. **`db.backup()` 在 `node:sqlite` 上不存在。** 实测 `typeof db.backup === "undefined"`。
   所以在线备份只有 `VACUUM INTO` 一条路（规格 §25-D6 风险 12 也是这么定的）。
   「顺手改成 `db.backup()`」第一天就抛 TypeError，这条不是风格偏好。

2. **`VACUUM INTO` 目标文件已存在 ⇒ 直接抛** "output file already exists"，不覆盖。
   于是文件名必须自带唯一性。而且实测在【另一个写事务持有 BEGIN IMMEDIATE 期间】
   从一条独立只读连接跑 `VACUUM INTO` 是成功的，拿到的是【已提交】内容 ——
   这条决定了备份不占写队列，也就决定了「备份期间写入不失败」能不能成立。

3. **恢复目标旁边留着【别的库的】`-wal` 会被静默采纳**（本轮最值钱的一条）。
   把 A.db 复制成 B.db，再把 A 的 `-wal` 复制成 `B-wal`，打开 B：
   `journal_mode` 变回 wal、行数 500 变 520、`PRAGMA integrity_check` 仍然报 "ok"。
   也就是说「目标目录里上次恢复留了个 -wal」这种普通事故，会得到一份
   **通过了完整性检查、内容却不是那个备份**的库，而且没有任何一层会报。
   `restoreBackup` 因此必须先清目标旁边的 `-wal` / `-shm` 再复制主文件（顺序不能换）。

4. **`VACUUM INTO` 的产物 `journal_mode` 是 `delete`，不是 wal。** 而 `journal_mode` 是
   【持久】设置，所以 `openReadonlyDb()`（里面那句 `PRAGMA journal_mode = WAL`）在只读连接上
   打开这份产物会当场抛 "attempt to write a readonly database"。
   第一版备份就死在校验产物那一步，报错说的是「只读不能改模式」，看起来与备份无关。
   补了 `openSnapshotReadonlyDb()`（不设 journal_mode），PRAGMA 权威仍单点在 pragmas.ts。

5. **worker 入口必须由自己的扩展名推导。** `new URL("./integrity.worker.js", import.meta.url)`
   在源码态加载失败（只有 `.ts`），`.ts` 在构建产物里失败。所以写成剥掉自己扩展名再拼回去。
   拼的时候【要补回那个点】：写成 `".worker$1"` 得到的是 `integrity.workerts`，
   见 §6 第 5 条 —— 那个洞让所有「走 worker」的测试全都走的是失败分支，而它们全绿。

6. **只读连接测不出 append-only 触发器。** 实测只读连接上的 DELETE 先以
   "attempt to write a readonly database" 失败，根本走不到触发器，报错里没有 "append-only"。
   所以验触发器必须用【可写连接】，而这也正是 `integrity.ts` 的探针【必须走 WriteQueue
   而不是旁路只读连接】的理由：走旁路量到的是「只读被拒」，
   而那与「触发器挡住了」在「抛了个错」这个层面完全同形。

7. **触发器里写的审计会被 `RAISE(ABORT)` 一起回滚。** 所以「撞触发器时顺手记一条审计」
   这条路不成立：探针那条安全审计必须由【捕获异常之后】的应用层写。

8. **SQLite 自带的两把完整性尺子都量不出 external-content FTS 的分叉。**
   往 `events_fts` 里直写一次 `'delete'` 造出分叉之后：
   `PRAGMA integrity_check` 报 "ok"，`INSERT INTO events_fts(events_fts) VALUES('integrity-check')`
   也干净跑完，而那一行【从检索里消失了】。只能自己做：逐行取它【自己】payload 的一段
   trigram 回查索引，问「你还在吗」。用固定关键词搜全表不行 —— 坏掉的索引照样命中别的行。

9. **`events.task_id` 上的外键是真的会被执行。** 插一条 `task_id = 'T-9'`（没有对应 tasks 行）
   的事件 ⇒ "FOREIGN KEY constraint failed"。这条本来不起眼，但它让 §9 里那条
   `-wal` 采纳的用例【从没跑到断言】就死了 —— 夹具写错 task_id，测不到任何东西。
   `opened` 目录里的夹具因此必须复用夹具自己建过的那行 `'T-1'`。

10. **`PRAGMA integrity_check` 在主线程上并不慢得离谱，但足以冻住 Hub。**
    本机实测（同一台机器，三次取稳）：2 万事件 51ms、13.1 万 341ms、20 万 543ms。
    写下来是为了给「必须挪出主线程」一个数量级依据，而不是引一句规格。
    按规格 §6.5 的十万任务量级，这一发会在心跳调度头上停一秒以上。

11. **一份截断的库上，`PRAGMA integrity_check` 是【直接抛】而不是返回诊断文本。**
    只读连接 + 截断到 50% 的文件 ⇒ "database disk image is malformed"（截到 30%、10% 一样）。
    连 `SELECT count(*) FROM events` 也抛。这条改掉三处实现，见 §4。

12. **只拆两条 append-only 触发器之后，`UPDATE events` 会以光秃秃的 "SQL logic error" 失败**
    —— 因为 external-content 的 FTS 同步触发器 `events_fts_au` 还在，它引用的 `old./new.`
    行在这种组合下不可用。于是探针读到的是 `other_error`（抛）而不是 `append_only_broken`。
    要造出真正的「append-only 被人拿掉了」必须【四条一起拆】。

13. **把触发器换成 `RAISE(IGNORE)` 之后，UPDATE 的 `changes` 是 0 且【不报错】。**
    这是探针第四种结论 `probe_reached_no_row` 的现实来路：有人嫌触发器太吵、
    把它改成「先别报」，一个只看「抛没抛」的探针就会报「挡住了」。

## 2. 三条判据的形状，以及为什么不是布尔

- **`PRAGMA integrity_check` 的判据是「恰有一行且该行 == "ok"」，不是「包含 ok」。**
  损坏库返回的是多行诊断文本，里面出现 "ok" 这个子串由损坏内容自己决定。
  判据落在 `src/db/page-check.ts` 一个【零 import 的纯函数】里，worker 与主线程 import 同一份 ——
  两侧各写一份「看起来一样」的判据，漂移方向永远是两边都还在绿（0006 §7 第 55、56 条）。
- **`not_observable` 不是通过。** §22.4 那三条（门控证据引用、harness 消耗记录、状态机对账）
  在本机库里的真实状态是【表为空】：`review_gates` / `harness_calls` 在 src 里零 INSERT
  （0016 §1 第 1 条复算过）。空表不是「查过了没问题」，是「没有东西可查」。
- **`could_not_run` 也不是通过，而且不能并进 `not_observable`。** 见 §4。

## 3. 明知故犯的偏离

- **`integrity.worker.ts` 里手抄了一份 busy_timeout PRAGMA，没 import `applyPragmas`。**
  代价：`pragmas.ts` 的 5000ms 改了，worker 那份不会跟着改。
  理由：`applyPragmas` 会执行 `PRAGMA journal_mode = WAL`，那是持久设置，
  对一份【快照文件】（§1 第 4 条）会当场抛。而完整性检查要能查快照 —— Task 6.3 的验收
  「备份文件可被另一连接打开并通过 integrity_check」正是同一个消费者。
  收回时机：`pragmas.ts` 加一个 `skipJournalMode` 参数时，worker 那份副本应当删掉。
- **探针复用 `checkpoint/tx-scope.ts` 的 `requireScopeDb()`。** 一个 `src/db/` 模块去 import
  `src/checkpoint/` 的符号，方向上像倒置。但它要的就是「我现在在不在事务作用域里」这件事，
  而那件事的唯一权威住在那儿。自己攒一份 ALS 判断会是第二份权威。
- **`backupDir` 是必填参数，不接受 env / HOME 默认。** `backupsRoot()` 存在但只给生产入口。
  备份是【写盘 + 删盘】的模块：测试若靠 env 覆盖路径，忘设 env 的那一次就会去删真实
  `~/.opc-os/backups` 里的文件。忘了传 `backupDir` 应该是编译不过，而不是写错地方。

## 4. 加第四种结论 `could_not_run`，以及三处「检查自己会抛」

§1 第 11 条（损坏库上连 `SELECT` 都抛）在本轮连着咬到我三次，每一次都是同一个形状：
**一个会抛的完整性检查，在出事的时候最容易被当成调用方的 bug。**

1. **主线程页面检查**（`pageViaMainThread`）。没有 try/catch 时，损坏库上
   `runIntegrityScan({onMainThread: true})` 整体 reject，调用方拿到的 rejection
   与「我 SQL 写错了」同形。修：捕获，报 `violated`。
2. **五条自洽规则**（`guarded`）。页面检查已经报完，第一条自洽 SELECT 又抛，
   异常冲出 `runIntegrityScan` —— 于是【一份报告都没有】。修：逐条捕，其余各条照常出结论。
3. **报告里的 events 计数**（`safeCountEvents`）。补完前两处之后仍然 reject，
   因为 `SELECT count(*) FROM events` 自己就抛。修：读不出来记 `null`，不记 0 ——
   0 是【真值】，意思是「空库」，会把一份读不动的库报成一份空库，
   而空库正是最不该被误报的状态（它顺带让好几条检查变成 `not_observable`）。

为什么需要第四种结论，而不是把「查询抛了」折进现有的三种：

| 情形 | 该读成 | 折叠后果 |
| --- | --- | --- |
| 库里没有门控决定可核 | `not_observable` | —— 这是本仓今天的常态，每天都出现在报告里 |
| 有东西可核而查询抛了 | `could_not_run` | 并进上一格 ⇒ 一次真损坏伪装成那条人尽皆知的常态，没人会多看一眼 |
| 某一行不满足规则 | `violated` | 并进这一格 ⇒ 「要修连接/文件」与「要修某一行数据」共用一个结论 |

`could_not_run` 会拉下整份报告的 `ok`。这与 `IntegrityReport.unavailable` 的分工是：
`unavailable` 说的是【判据这套仪器坏了】（worker 起不来 / 超时 / worker 崩了），
`could_not_run` 说的是【仪器好的，但这份库放不下尺子】。
实测能造出来的样本：`DROP TABLE events` 而留着 external-content 的 `events_fts` ——
`PRAGMA integrity_check` 仍然报 "ok"，而每条自洽规则都抛 "no such table: events"。

## 5. 与规格 / 计划字面的偏离

- **备份文件名到毫秒，规格 §6.5 写的是 `opc-{date}.db`。** 只到「日」不够唯一：
  同一段规格还要求「岗位书变更、委派规则图变更前自动触发一次备份」，一天改两次岗位书
  就是两个备份撞同一个名字，而 §1 第 2 条说 `VACUUM INTO` 不覆盖 ⇒ 第二次必失败，
  失败看起来像「备份功能坏了」。形状仍是 `opc-{...}.db`，字典序 == 时间序（保留策略靠这一条，
  不靠 mtime —— mtime 会被 cp / rsync / git checkout 改掉）。
- **计划 Task 6.3 的 Test「从备份恢复后能 hub resume 继续跑未完成任务」只做到前半。**
  后半需要 `@langchain/*`（本机装不上，0009 §2）。交出来的是：恢复出来的文件能按生产方式
  打开、完整性过、行数与备份一致、append-only 触发器与 FTS 真的还在（用可写连接撞出来的，
  不是查 `sqlite_master` 里的名字）。后半在 `backup.test.ts` ⑤ 里钉成一条
  【零调用方断言】：`backup.ts` 不 import `../graph/`、`../checkpoint/`、`@langchain/*`。
  接线那天这一发会红，逼回来改本文件的结论。所以本文件的结论是
  「恢复出来的文件可用」，**不是**「恢复演练端到端通过」。
- **计划 Task 6.4 那条「FTS 重建（`events_fts rebuild`）在只读连接上跑」做不到，本机实测。**
  `INSERT INTO events_fts(events_fts) VALUES('rebuild')` 在只读连接上直接抛
  "attempt to write a readonly database"（同一只读连接上普通 `MATCH` 查询正常，
  所以不是「只读连接不能用」而是 rebuild 本身是写操作 —— 它要重灌 shadow 表）。
  这条不是「换个写法就实现了」：external-content FTS 的索引内容就存在那三张 shadow 表里，
  重建必然是写。计划要它离开写队列的动机（重建不要卡住写入）是对的，
  能兑现那个动机的实现是【另一条写连接】而不是只读连接，
  而 SQLite 单写者前提下「另一条写连接」== 排队。所以按字面做不出来，按动机做没有意义。
  口径落到 `scripts/rebuild-fts.md`：跑在写连接上，顺序是先 rebuild 后复验。
- **Task 6.2 的验收里没有 `/integrity` 路由**（计划 §9 那一节三条 Test 加一条验收，
  没有这一项，规格里也没有这个端点）。本模块【未做】的是规格里写了的接线：
  「启动时执行 `PRAGMA integrity_check`，失败则提示从备份恢复」以及每日备份巡检。
  `runIntegrityScan` 与 `createBackup` 目前在本仓【零生产调用方】—— 除测试外无人 import。
  堵点是 Task 6.1 的常驻进程与调度器不存在（`cli.ts` 只有 run / status / resume 三个动词，
  `serveHub` 零生产调用方），不是判据缺失。见 §7。
- **执行顺序偏离计划 §10.1**：那一节把 6.x 排在 `{4.7, 5.8}` 之后。选现在做的理由是
  6.2/6.3 是本机【唯一两条不依赖网络与 SDK 就能整条做完】的 Phase 6 条目，
  而 4.x/5.x 整片卡在 D9 与外部 SDK 上（见 docs/INDEX.md 的等待清单）。
  这是排程选择，不是判据放宽。
- **「校验失败即删文件」那一支在本机走不到真实的 corrupt 产物。** `VACUUM INTO`
  在本机不会产出「能通过 VACUUM 而通不过 integrity_check」的文件，
  所以那条分支的用例是靠【就地截断产物】造的。它测的是我写的删除与告警逻辑，
  不是 SQLite 会不会产出坏文件。

## 6. 我自己写错的地方

1. **`Date.UTC(2026, 8, 30)` 我当成 8 月 30 日用了。** 月份是 0 基，出来是 9 月 30 日，
   于是一批备份名断言集体红。改成 `Date.parse("2026-08-30T23:59:59.000Z")` 字面量，
   并加了一条 `-08-30` 的断言把这个坑钉住。
2. **跨用例共享的 `warnings` 数组。** 「成功路径不得叫 onWarning」那一类断言从第二条用例起
   必然红，而红的原因与备份毫无关系。这正是 0006 §7 记过的「夹具自带状态让断言测到别的东西」，
   本轮自己踩了一次。改成 `beforeEach` 里重置。
3. **append-only 探针的 SQL 少绑一个参数**，`changes` 是 0，我当场把它读成
   「append-only 没挡住」。真相是 `UPDATE ... WHERE id=?` 绑错 ⇒ 一行都没匹配到 ⇒
   触发器压根没被触发（§1 第 13 条量的是同一个机制的另一端）。
   这条自己骗自己的经历直接产出了 `Rejection` 那个四值联合：`matched_nothing`
   必须是独立的一种，不能和「挡住了」或「坏了」混在一起。
4. **`expect(text.includes("@langchain")).toBe(false)` 被一条注释满足**。
   备份模块的头注释里就写着 `@langchain/*`，于是那条「零框架依赖」的门禁当场红，
   而代码是干净的。改成先剥注释再扫【可执行 import】。一条注释能让门禁通过或失败的守卫
   测的是文笔，不是依赖图。
5. **worker 入口写成 `".worker$1"`（丢了点），得到 `integrity.workerts`。**
   这一条最值得记：worker 起不来是【有兜底分支】的（报 `worker_unavailable`），
   所以这个洞不让任何东西变红 —— 所有声称「走 worker」的用例其实都走的是失败分支，
   而它们全绿。`via` 字段仍然写着 "worker"，因为那是我从消息里读的，
   而那条消息根本来自另一支。锁是 `integrity.test.ts` ⑦ 那条：源码里
   `import.meta.url.replace` 只许出现一次，且必须拼 `".worker.$1"`。
6. **夹具用 `UPDATE events` 撑大规模**，被自家 append-only 触发器拒下。
   在这套 schema 里任何「改一下已有行」的夹具写法都是错的，没有例外。
7. **夹具写的 `state_change` payload 没有 `to` 字段**，于是【每一个健康库】
   都被状态机对账判 `violated`。红得很真实，而坏的是夹具。
8. **投毒用的 `task_id` 写了个不存在的 `'T-9'`**，那一发死在 FOREIGN KEY constraint failed 上 ——
   一个从没跑到断言的夹具，测不到 `-wal` 采纳这件事。
9. **翻倍次数写成 15**（想要 13 万行，实际 4000 × 2^15 = 1.3 亿行），测试跑到天荒地老。
   指数增长要有数量级自觉。
10. **一条恒真的反向对照**：把四个 verdict 字面量塞进 Set 再比长度。枚举少一种它照样绿，
    因为字面量是我自己抄的。改成收集【真实观察到的结论】。
11. **`expect(tickedDuring).toBeGreaterThan(0)` 对同步 API**（备份那处）：
    同步调用期间定时器本来就不该跑，那条断言恒假。同类断言只在 worker 那侧才有鉴别力，
    于是把它移到 `integrity.test.ts` ①。
12. **给「整齐 payload 会让 FTS 检查恒真」加了一道区分度自检**，实测证伪：
    200 行 payload 完全一样的库里删掉索引第 57 行，检查【照样点名 57】——
    命中判定问的是「这一行的 rowid 在不在结果里」，不是「结果非空」。
    那道判据唯一的实际效果是把一份【正常】报告搅成 `not_observable`。已删，
    反向用例留在 `integrity.test.ts` ⑤ 防它长回来。

## 7. 没做到（不写成「换种方式做到了」）

- Task 6.2 验收②的后半：`/integrity` 路由。
- Task 6.3 验收的端到端那半截：真图 `hub resume`（见 §5）。
- Task 6.1（心跳与调度器还不存在）、Task 6.4 的桌面端部分、Task 6.5 那一周试运行。
- FTS 一致性是【抽样】（默认 200 行）。全表逐行是 N 次 MATCH，而规格 §6.5 的量级是十万行。
  抽样的口径写进了 detail：单行漂移可能落在样本外。
- 快照式打开（跳过 `journal_mode`）与只读式打开现在是两个函数。
  谁把它们合成一个，§1 第 4 条那个坑会回来。

## 8. 留给 CEO 的一项决定

`integrity` 检查什么时候跑。三个选项，代价各不同：

- **A 只在启动时跑一次。** 最省，但一次长跑期间发生的位翻转 / 同步盘截断（§1 第 3、11 条）
  不会被任何一层看见，直到下一次重启。
- **B 每天一次，与备份同批。** 恢复演练（`restoreDrill`）本来就要定期跑，两者同批可以
  互相作证：备份成功 + 完整性过 + 演练可用，三条一起才算「灾难恢复在位」。
  代价是每天一次几十到几百毫秒的 worker 扫描（§1 第 9 条），对单用户 Hub 可以忽略。
- **C 每次备份之前跑。** 最保守，等于「先确认源库是好的再拷一份」。
  代价是备份次数 = 检查次数，而岗位书一改就备份的口径下这会相当频繁。

我的倾向是 B，并把 `restoreDrill` 的结论一并写进同一条巡检。但这属于运维口径
（多久算「及时」知道库坏了），不是我能单方面定的判据，所以摆在这儿。

## 9. 复算命令

```bash
# §1 第 1、2 条：db.backup 不存在 / 目标已存在不覆盖 / 写事务期间能快照
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/db/backup.test.ts"

# §1 第 3 条（陈旧 -wal 被采纳）就是 ⑤ 节那条「内容必须等于备份」
# §1 第 6 条（只读连接测不出触发器）在 ② 节：改用可写连接 + INSERT 反向对照

# §1 第 8 条：两把内置尺子都说 ok 而 FTS 已分叉
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH \
  node --experimental-transform-types --import /tmp/opc-harness/register.mjs \
  --test "packages/hub/test/db/integrity.test.ts"   # ⑤ 节 FTS 那条

# §1 第 9 条：integrity_check 的规模-耗时刻度（2 万 / 13 万 / 20 万）
#   ① 节自带 13 万行的规模夹具；另用 /tmp/igtime.mjs 造库并打印三次耗时
# §1 第 11 条：截断库上 PRAGMA 直接抛 —— ② 节「连接开着而文件随后被截断」那条
# §1 第 12、13 条：拆四条触发器 / RAISE(IGNORE) —— ④ 节那两条
# §4：could_not_run —— ⑥ 节三条，前提断言是「PRAGMA integrity_check 仍报 ok」
```

测试跑法与本机依赖边界见 docs/INDEX.md 与 0009 §2；
`pnpm verify` 在本机仍不可运行（缺 `@langchain/*` 等），上面这些是离线夹具路径。
