# 0004　迁移 SQL 机械取自附录 C；写队列偏离 C.2 四处；SQLite 对少绑参数【不设防】

- 状态：已采纳
- 日期：2026-11-07
- 关联：规格 §5.5、附录 C、附录 C.2；计划 Task 0.5；决策 0001、0003
- 落地：提交 7bd8f0e（14 文件，+2504）—— `packages/hub/resources/migrations/0001_init.sql`、
  `src/db/{pragmas,migrate,migrate-cli,write-queue}.ts`、`scripts/extract-appendix-c.mjs` 及
  `test/db/` 五个测试文件。测试 113 passed | 6 skipped。

## 1. schema 由脚本机械提取，不手抄

附录 C 有 17 张表、三千多字符。手抄的差异【没有任何报错形式】，它的表现是「本地正常、
别人机器上 no such column」。所以 `scripts/extract-appendix-c.mjs` 从规格文档逐字抽取 SQL
块，头部偏离说明单独放在 `scripts/0001_init.header.sql.txt`。脚本自带闸门：第一个
`## C.` 之前必须恰好 1 个 sql 代码围栏；被丢弃的 PRAGMA 段必须恰好 **5 行**（4 条 PRAGMA 语句
—— 第 5 行是它们上面那行 `== 全局 PRAGMA ==` 小标题，所以下文说「删 4 条」而闸门数 5 行，

成品：**0 条 PRAGMA**，17 条 CREATE TABLE + 1 条 CREATE VIRTUAL TABLE（FTS5）、
5 条 CREATE TRIGGER、8 条 CREATE INDEX。

核对数字时注意 **DDL 条数不等于库里对象数**（实测，sqlite_master 计数）：

| 口径 | DDL 条数 | 库里对象数 | 差额来源 |
| --- | --- | --- | --- |
| 表 | 17 + 1 虚表 | **24** 个 type=table | FTS5 虚表自动附带 5 张影子表：`_*_config` / `_content` / `_data` / `_docsize` / `_idx` |
| 索引 | 8 条 CREATE INDEX | **26** 个 type=index | 其中 **18** 个 sql IS NULL，即 PRIMARY KEY / UNIQUE 约束自动生成的 `sqlite_autoindex_*` |
| 触发器 | 5 | 5 | 一致 |

那 18 个自动索引不是冗余，是主键与唯一约束的实现载体。想按库里索引数验收 schema 的人
一定会在这里对不上数，所以提前记下来。

## 2. 相对附录 C 的偏离

### 2.1 SQL 偏离（2 处）

1. **删掉开头的 4 条 PRAGMA**。journal_mode / busy_timeout / synchronous / foreign_keys
   是【每次连接】要施加的设置，权威源是 `src/db/pragmas.ts` 与 `driver.openDb()`。放进
   一次性迁移脚本会制造错觉：除 journal_mode 外都是连接级设置，写进迁移只对「执行迁移
   那条连接」生效。另实测：事务内改 WAL 会抛
   `cannot change into wal mode from within a transaction`，而迁移必须整体包事务（否则
   失败留下半套表），两者不共存。
2. **`trust_scores.role_id` 去掉 `REFERENCES role_charters(role_id)`**。附录 C 原文是
   `role_id TEXT PRIMARY KEY REFERENCES role_charters(role_id)`，但 `role_charters` 是
   【版本化】表，唯一键只有 `(id)` 与 `(role_id, version)`（实测 PRAGMA index_list）。
   SQLite 要求被引用列构成列集合**完全一致**的唯一索引，不支持前缀匹配 —— 于是建表
   【静默成功】，直到任何写入或 `PRAGMA foreign_key_check` 才炸：

       foreign key mismatch - trust_scores referencing role_charters

   计划 Task 0.5 要求 foreign_key_check 无输出，此处不改就永远红。代价：`role_id` 的引用
   完整性不再由数据库保证，改由应用层维持（Task 1.4 岗位书 CRUD 时补断言）。
   `test/db/schema-0001.test.ts` 用**反向用例**守住：其余 9 个外键必须仍然有效。

**不加 `IF NOT EXISTS`**：幂等由 `schema_migrations` 版本表保证。刻意让重复执行报
`table already exists` —— 版本表说没应用过而库里却有表，说明 schema 与版本记录已经分叉
（有人手动建过表，或版本表被删）。这种时候【必须炸】，静默跳过等于把分叉留在库里。

### 2.2 WriteQueue 偏离 C.2 参考实现（4 处）

1. **不自己 `new DatabaseSync`，改用 `driver.openDb()`**。否则「那 4 条 PRAGMA」就有了
   第二个权威源，两处不一致的表现是「这台机器 synchronous=NORMAL、那台 FULL」或
   「主连接外键 ON、旁路连接 OFF」—— 后者【不报错】，只是约束没了。
2. **不用 `JSON.stringify` 打包 stmts**（规格 C.2 那么写）。实测该做法破坏参数类型：
   `Uint8Array` → `{"0":0,"1":255,…}` → `run()` 报 `Unknown named parameter 0`；
   `BigInt` → 直接抛 `Do not know how to serialize a BigInt`；`Date` → 退化成 ISO 字符串。
   checkpoint saver 写的正是 BLOB。照抄会做出「测试全绿、生产写不进 checkpoint」。
3. **失败不污染队列**（尾要去毒，见 §3）。
4. **自己校验占位符与参数个数**（见 §4）。C.2 不做这件事，因为它连 stmts 都是 JSON
   字符串、根本没机会看参数。

## 3. 尾去毒：唯一可见后果在 `close()`，不在下一次写

`#tail` 写成 `run.then(SETTLED, SETTLED)` 还是 `run`，对**后续写**完全等价 —— 因为
`#enqueue` 是 `this.#tail.then(job, job)`，两个分支都走 `job`。所以「失败之后下一条写
仍成功」这条测试【抓不到】尾中毒，实测如此（W1 曾因此只拿到 △）。

唯一 externally visible 的后果在 `close()` 里的 `await this.#tail`：一条早已处理过的失败
会重新抛出，于是跳过 `#closed = true` 与两个 `db.close()` —— WAL 永不 checkpoint、两个
句柄不关，Windows 上库文件被永久占用。

> 由此得出一条测试写法：**尾去毒的测试必须在失败之后【立刻】`close()`**。中间只要再
> 成功写一次，尾巴就被洗干净了，断言全部空转。这正是 W1 最初抓不到的原因。

## 4. `node:sqlite` 对「少绑参数」零保护（实测）

| 场景 | 实测行为 |
| --- | --- |
| 2 个占位符只绑 1 个参数，列可空 | **静默写 NULL**，无任何警告：`{"a":"只有这一个","b":null}` |
| 2 个占位符绑 0 个参数 | 两列都写 NULL |
| 少绑且列 NOT NULL | `NOT NULL constraint failed: q.b`，errcode **1299** |
| 多绑 | `column index out of range`，errcode **25** |
| `?1, ?1` | 只消耗【一个】位置参数 |
| `prepare("stmt1; stmt2")` | **静默只执行第一条**，第二条被丢弃 |

结论两条，都是硬的：

- **少绑没有 SQLite 层保护**。NULL 是最坏结果：不报错、不崩溃，只是数据错了，而且往往
  要等到几个月后某次读取才暴露。所以写队列必须自己数占位符（`assertParamCount`）。
- **多条语句必须自己拦**（`assertSingleStatement`）。`prepare` 静默丢第二条意味着
  「tx 里塞两条语句的字符串」会安静地少写一半。

`?NNN` 编号占位符我们【放弃】校验，交给 SQLite：`?1,?2` 只给 1 个参数时我们不拦，
由 SQLite 报 `column index out of range`。理由是编号可以重复、可以跳号，自己猜语义
只会误拦真实合法的 SQL。误拦比漏拦严重得多。

## 5. `::` 不是 SQLite 的类型转换

实测 `?::text` 报 `unrecognized token: ":"` —— 那是 **PostgreSQL** 方言。`scanPlaceholders`
里那个跳过第二个冒号的分支，唯一职责是**防止 `a::b` 把 `otherStyle` 置真**：一旦
`otherStyle` 为真，`assertParamCount` 会整条返回，少绑保护被【静默关掉】。
由变异 S5（关掉该分支）证明这条断言可被证伪。

## 6. 骨架 skeleton：字面量替换成【空格】

数占位符前要把字符串字面量与注释剥掉。剥掉的字面量替换成**一个空格**而不是空串，
是为了保住相邻 token 不会被粘连出新语义。变异 S1（替换成 `?`）会让字面量里的问号被
计入，断言立刻变红。

反向也要守：`--` 出现在字符串字面量里不得开启注释，`/*` 同理；同时真的行注释与块注释
必须被剥掉（否则注释里的问号又会被计数）。变异 S2 / S3 分别关掉两处处理，各由一条
断言杀死。**只测一个方向的断言等于没测** —— 我最初就只写了「字面量里的 `--` 不算
注释」这一半，于是「删掉注释处理」的变异活了下来。

## 7. DDL 绝不走 `WriteQueue.tx()`

`CREATE TRIGGER … BEGIN INSERT …; END` 的触发器体**内部含分号**。`assertSingleStatement`
无法区分「一条带体的语句」和「两条语句」，会拒绝它。所以 `0001_init.sql` 里的 5 个
触发器只能走 `migrate()` 的 `db.exec(sql)`。

而 `db.exec(sql)` 必须**整文件一次调用**，绝不可按分号切句 —— 切句会把 CREATE TRIGGER
劈成两半，报 `incomplete input`。这条由变异 M4 守着（见 §11）。

## 8. 计划里两处与实测不符（以实测为准）

- 计划 Task 0.5 写「UPDATE / DELETE 均抛 `immutable`」。实测消息是
  `events table is append-only`，**不含 immutable 一词**，errcode **1811**
  （`SQLError.code` 为 `SQLITE_CONSTRAINT_TRIGGER`）。测试断言实测值 + errcode，
  不照抄计划措辞。
- 规格附录 C 的 trigram 结论是在 SQLite 3.53.4 上测的；本机 `node:sqlite` 内嵌 **3.51.2**。
  已在 3.51.2 上重测并留活文档：`MATCH 覆盖率` 命中 ≥1，`MATCH 件通` 命中 0 而
  `LIKE %件通%` 命中 1（证明 trigram 没退化成 LIKE）。

## 9. `pnpm migrate` 刻意没有默认库路径

必须显式给 `--db <路径>` 或设 `OPC_DB`，否则退出码非 0 并打印用法。默认路径的失效模式
是「在错误的库上跑迁移」—— 迁移不可逆，且错库通常不会立刻报错，它只是安静地给空库
建了一套表。

## 10. 测试基建：清理失败绝不伪装成测试失败

`afterAll` 里原先包着 `try { await q.close() } catch {}`。它把「连接根本没关掉」
伪装成 Windows 上 `rmSync` 的 `EPERM` —— 于是**一个断言全绿的套件被标记为失败**，
真正的缺陷被噪声埋掉。现在 `afterAll` 直接 `await q.close()`（close 幂等，正常路径
不会失败），真失败就如实报在 `close()` 上。

Windows 上句柄释放落后于 `close()` 返回，所以删临时库用**有界重试**：40 次 × 50 ms，
等待用 `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)`（同步睡眠，
不依赖事件循环）。

## 11. 变异测试记录（19 项，逐个证明断言可被证伪）

口径沿用决策 0001：**因语法错误而失败的变异不算杀死**；锚点没匹配上的既不算杀死
也不算存活；只靠运行时异常/超时杀死的标 △，不得记作断言的功劳。

| 变异 | 结果 | 说明 |
| --- | --- | --- |
| W1 尾不去毒（`#tail = run`） | ✓ 1.4s | 「失败之后立刻 close()」那条：close 重抛旧失败 |
| W2 单语句检查关掉 | ✓ | tx 里塞两条语句字符串必须抛 |
| W3 参数个数校验永远通过 | ✓ | 少绑必须抛（§4：node:sqlite 自己不报） |
| W4 读连接改用可写连接 | ✓ | 物理只读断言：`attempt to write a readonly database` |
| W5 嵌套守卫去掉 | ✓ 3.4s | 见 §11.1 |
| M1 迁移文件名不校验 | ✓ | `0001-init.sql`（连字符）必须被拒 |
| M2 journal_mode 守卫去掉 | ✓ | SQL 里出现 `PRAGMA journal_mode` 必须抛且指向 pragmas.ts |
| M3 `BEGIN IMMEDIATE` 换成 `SELECT 1` | ✓ 7 failed | 没有写锁，回滚/串行类断言成片变红 |
| M4 `db.exec(sql)` 改成按分号切句 | △ 异常杀死 | 6 failed：触发器体被劈开 → `incomplete input`，异常冒到测试层、无断言参与（§11.2） |
| S1 字面量替换成 `?` | ✓ | 见 §6 |
| S2 行注释处理关掉 | ✓ | `SELECT 1 -- 备注里有个 ?` 绑空参数不得抛 |
| S3 块注释处理关掉 | ✓ | 同上，`/* … ? */` |
| S4 尾分号剥离失效 | ✓ | 单条尾分号必须放行 |
| S5 `::` 分支关掉 | ✓ | 见 §5 |
| S6 编号占位符也去校验 | ✓ | 见 §4 末段 |
| P2 `BUSY_TIMEOUT_MS = 0` | ✓ | 见 §11.3 |
| P1 构造选项 `enableForeignKeyConstraints: false` | 存活（预期） | 显式 `PRAGMA foreign_keys = ON` 仍生效 —— 冗余双保险 |
| P3 构造选项 FK 与 timeout 同时关 | 存活（预期） | `applyPragmas()` 里那两条 PRAGMA 仍生效 |
| R1 `openReadonlyDb` 不调 `applyPragmas()` | 存活（预期） | 内联构造选项已把同样的四项设成同样的值 |

### 11.1 W5 曾靠超时杀死，这是没用的战报

嵌套 `node()` 的用例最初 `await` 内层 promise。一旦去掉 `if (currentScope())` 守卫，
内层排到外层之后、外层又在等内层 —— **真死锁**，整文件被挂住约 31 秒，失败消息里
没有任何有用信息。改成用 `outcomeOf()` 观察内层（与 2000 ms 的 `setTimeout(...).unref()`
竞赛），「嵌套没被拒绝」就成了一条可读的断言失败（`inner:TIMEOUT`）。现在 3.4 秒内
断言级杀死。

### 11.2 M4 的 △ 是分类器的锅，但标 △ 仍然正确

M4 抛的是被包装过的 Error（`迁移 0001_init 失败并已回滚…：incomplete input`），从
`migrate()` 抛出，vitest 记成测试层异常而非 `AssertionError`。分类器不认识这个形态，
先报成「KILLED-? △」。**根因是分类器正则写错**：`s` 被外层字符串吞成字面量 `s`
（无效转义静默降级），所以 `×` 标记行永远匹配不上。修好后正确归类为 KILLED-THROW △。

标 △ 依然正确：确实没有断言参与，是异常挡住了缺陷。它证明的是**故障进不了主干**，
不是**某条断言有效**。

### 11.3 三条存活：必须证明「冗余」不是「没测到」

P1 / P3 / R1 全部存活，符合预期 —— 连接级设置在构造选项与显式 PRAGMA 两处各设一遍，
拆掉任一处另一处仍生效。但「符合预期」是**说辞**，不是证据。于是各加一条**复合变异**，
同时拆掉两处：

| 复合变异 | 结果 | 失败消息 |
| --- | --- | --- |
| X1 写连接两处全拆（构造 false/0 + 两条 PRAGMA 都不设） | ✓ 断言杀死 | `expected +0 to be 1` |
| X2 只读连接两处全拆（内联 false/0 + 不调 `applyPragmas()`） | ✓ 断言杀死 | `读连接的 busy_timeout 默认是 0: expected 0 to be 5000` |

两处一起塌的时候断言会响，说明「双保险」是**真的在保险**，而不是测试没测到。
顺带把 `busy_timeout` 单独钉住：`node:sqlite` 默认值是 **0**（决策记录 V15），撞上
EXCLUSIVE 锁时读会【立刻】抛 `SQLITE_BUSY` 而不是等 5 秒 —— 这种失败只在压力下出现，
最难复现。

## 12. 本轮自己造成的两处失误（记下来免得重犯）

1. **删掉过一条测试而全绿**。一次按行号 splice 的编辑越界，把「嵌套 `node()` 必须拒绝」
   整条用例删掉了，测试数从 24 掉到 22 而我没察觉。是 biome 的一条
   `noUnusedVariables`（`outcomeOf` 变成未使用）把它暴露出来的。**每次按行号编辑之后
   必须核对 `it` 计数**，不能只跑一遍看绿。
2. **为了「查看」一个脚本而 import 它**。想读 MUTS 表，写成了 `await import("...mutate.mjs")
   ` —— import 会**真的执行**变异器。它恰好在语法错误上崩了，源码才没被动过（事后逐条
   核对 11 个锚点确认未被变异）。要看一个有副作用的脚本，用正则解析它，不要 import。

另外记一条通用教训：**在字符串里写正则**（`\s` 少一层转义）会静默降级成字面量匹配，
既不报错也不警告，只是永远匹配不上。§11.2 的误判就是这么来的。
