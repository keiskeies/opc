# OPC-OS 开发计划：把设计文档拆成可执行任务

**日期**：2026-11-06　**规格来源**：`docs/OPC-OS-设计文档.md`（当前设计的唯一权威表述）
**总周期**：22 周日历时间（7 个 Phase，按每周 25–30 小时有效开发估算）　**任务数**：58

## 语言（Language）

**TypeScript 单一语言**，Node 24 LTS（主版本锁死）。不引入 Rust、Python 或任何第二语言；确有需要的能力用 **MCP 边车**隔离在进程边界之外（规格 §5.11）。运行时依赖**零原生模块**（依据 `docs/decisions/0001-sqlite-driver.md`：D6 已定案选 `node:sqlite`）。

## 影响评审块（Impact Review Block）

| 变更面 | 影响 | 依据 |
|---|---|---|
| 编排内核 | LangGraph.js 1.7.1 的条件边、并行汇聚、interrupt/resume、跨进程恢复、子图嵌套**已实测通过**，不是假设 | `evidence/phase0-poc/POC-OUTPUT.txt`（V1–V4） |
| 持久化 | 单文件 SQLite + WAL + 单写者；驱动定为 `node:sqlite`，Windows 开发机**不需要 MSVC Build Tools** | `decisions/0001-sqlite-driver.md` §2、§3 |
| 审计完整性 | 手工路径与**框架调用路径均已证实**（Task 0.4a 判定：原方案成立，无需降级）。事务粒度定为**每超步一个事务**，非每次 invoke —— 整图一个事务会废掉崩溃恢复并长期持库级写锁 | `decisions/0003`、`decisions/0001` §2.2 |
| 前端 | 一套 React 组件、桌面与浏览器两个入口；渲染进程无业务状态机，状态跃迁只能由 Hub 事件驱动 | 计划 §5、规格 §5.7、§5.8 |
| 移动端 | 本地不落库、不缓存证据包正文；批准走与桌面完全相同的鉴权与审计路径（无第二条更弱通道） | 计划 §7 |
| 安全 | harness 调用四层防护 + `forbidden_flags` 硬拦截；权限**只能收窄不能放宽** | 计划 §8、规格 §12.7、§20.2 |
| 未覆盖 | **Skills 集成层（规格 §14）本期不排任务**，理由见 §11 末尾；`docs/decisions/` 只新增不删除 | 计划 §11 |

## 产出与边界条件（Outputs and Boundary Conditions）

- **产出**：可运行的 OPC-OS —— Hub 常驻进程 + 桌面/Web 双入口 + 移动端审批 + 飞书 Channel + Harness Gateway 三家适配器；每 Phase 有自动化出口门禁与 `pnpm verify` 全绿。
- **边界（明确不做）**：不做多端数据同步；不引入独立数据库服务 / 消息中间件 / 对象存储 / 外部 KMS；不做组织级知识库；Phase 3 前不做并行分支与动态边；不做 Skills 远端下载执行；不做个人微信接入（`docs/decisions/0002`，Phase 4 产出）。
- **边界（人的约束）**：Task 0.9 与 Task 1.7 的阻塞点是 **CEO 的判断**，不是代码 —— 这两项未过宁可推迟 Phase 1，不得由开发者代写验收标准（规格 §23.2）。

## 概览 / 目标（Overview & Objective）

把规格文档的 22 周阶段划分（§23.1）展开为 **58 个可独立验证的任务**，每个任务遵循 **TDD 节奏**：先写失败测试 → 跑到通过 → 提交 → 对照该任务「验收」逐条核对。目标是让**一位产品经理型 CEO** 能在图形界面里运营一家一人公司，全程不接触命令行（规格 §23.1 Phase 2 出口标准）。

## 架构（Architecture）

单仓多包 + 单一写者：**Hub 是唯一常驻进程与唯一 SQLite 写入者**（编排 + 运行时 + Harness Gateway + MCP + Channel + 事件广播）；桌面 / Web / 移动 / 飞书都只是 Hub 的视图，经 HTTP + SSE（或 IPC 白名单）访问，**永不直连数据库**。包目录与依赖边界见 §2。

## 技术栈（Technology Stack）

`@langchain/langgraph` 1.7.1 + `@langchain/langgraph-checkpoint` 1.2.2（自研 Saver）· Node 24 内置 `node:sqlite` · Hono 4 · Electron 45 + electron-vite · React + `@ag-ui/client` + `@xyflow/react` 12 + `@dnd-kit` 6 + `@dagrejs/dagre` 3 · Capacitor 8 · `@larksuiteoapi/node-sdk` 1.76.0 · `@anthropic-ai/claude-agent-sdk` / `@openai/codex-sdk` / `@qoder-ai/qoder-agent-sdk` · zod 4 · vitest + Playwright + biome。版本以规格 §5.11 与本计划 §1 实测结果为准。

> **For agentic workers**：执行本计划时使用 superpowers 的 **Writing Plans** 产出的这份计划配合 `executing-plans`（单人顺序执行）或 `subagent-driven-development`（逐任务派发子代理）。每个任务都是可独立验证的最小单元，节奏固定为：**先写失败测试 → 跑到通过 → 提交 → 对照该任务「验收」逐条核对**。验收未过不得进入下一个任务；不要在没测试的情况下写实现。

**规格引用**：
@docs/OPC-OS-设计文档.md
@docs/superpowers/evidence/phase0-poc/POC-OUTPUT.txt

---

## 0. 开工前必须知道的三件事

**0.1 本计划不重新论证技术选型。** 语言栈（TypeScript 单一语言）、持久化（单文件 SQLite）、编排内核（LangGraph.js）在规格 §5 已定，本计划只负责把它变成可执行动作。任何「回头换栈」的想法都必须走规格 §25 的决策流程，不得在实现中自行改变。

**0.2 Phase 0 前 3 天是证伪性验证，不是排期保守。** LangGraph.js 的能力面（规格 §24 风险 11）与 SQLite 驱动选型（§5.6、§25-D6）决定后面 18 周的代码形状。这两项已于 2026-11-06 用真实依赖跑通（见 §1），所以 Task 0.1 的工作是**把那次验证固化成仓库里的测试**，而不是重新赌一次。

**0.3 最大的风险不在技术，在岗位书的验收标准。** 规格 §23.2：Phase 0/1 需要 CEO 投入**设计精力**而非编码精力 —— 必须由 CEO 亲自为每个角色定义「什么叫做完了」。因此本计划在 Phase 0/1 各安排一个 **CEO 参与型任务**（Task 0.9、Task 1.7），其阻塞点是人的决策，不是代码。

---

## 1. 已验证事实（2026-11-06 实测，非文档推断）

下列结论由真实依赖跑出，脚本与原始输出归档在 `docs/superpowers/evidence/phase0-poc/`。**计划中的 API 写法以本节为准，不以记忆为准。**

| # | 事实 | 对实现的约束 |
|---|---|---|
| V1 | `@langchain/langgraph@1.7.1` 的条件边、并行边、汇聚节点（`addEdge([a, b], c)`）实测可用（**但顺序不可依赖，见 V10**） | 委派规则图可直接表达，无需自建 DSL |
| V2 | **`interrupt()` 不抛异常**：`invoke()` 正常返回，暂停信息在返回值 `__interrupt__` 数组里；`getState(cfg).next` 给出待执行节点 | 审批拦截**不能**用 try/catch 写，必须检查 `__interrupt__`（Task 0.6） |
| V3 | 进程 A 退出（模拟崩溃）后，进程 B 用同一 DB 重建 saver 与图，`next`、`values` 完整恢复，resume 后**已完成节点未重复执行** | 「不重复计费」成立；重启续跑可直接实现（Task 0.6） |
| V4 | 子图（编译后的图在节点内部 `invoke`）可嵌套，子图内部并行 + 汇聚正常，父子状态不串 | §10.2 辩论会、§13 调研子图都可作为节点内子图实现 |
| V5 | `SqliteSaver` 构造函数签名是 `constructor(db)`，参数必须是 better-sqlite3 的 Database 实例；**传路径字符串会在 `setup()` 抛 `this.db.pragma is not a function`**；路径必须走 `SqliteSaver.fromConnString(path)` | 最容易踩的坑，Task 0.5 以测试写死 |
| V6 | `BaseCheckpointSaver` 的抽象方法共 **5 个**：`getTuple` / `list` / `put` / `putWrites` / `deleteThread`；基类 `put(config, checkpoint, metadata, newVersions)` 是 4 参数，而官方 `SqliteSaver.put` 只声明 3 参数 | 自研 Saver 以**基类**签名为准（Task 0.4b）；`deleteThread` 极易漏 |
| V7 | `node:sqlite`（Node 24 内置）：WAL 生效；**checkpoint + writes + events 三表同一事务提交成功**；append-only 触发器拦下 UPDATE；失败后整体回滚、无半提交行；`db.function()` 可用；BLOB 往返为 `Uint8Array` | §25-D6-a 可行（Task 0.3 判据） |
| V8 | `node:sqlite` **不提供 `db.backup()`**（`typeof` 为 undefined） | 备份只能用 `VACUUM INTO`，代码中不得调用 `db.backup()`（Task 6.3） |
| V9 | 吞吐：事务内 2000 行 ≈ 1 ms；逐条自动提交在测试库中同样快，但那是无 fsync 压力场景；规格 §6.5 的磁盘实测为约 2 ms/行 | 事件写入一律走写队列 + 批量事务（Task 0.5），禁止节点内逐条 `INSERT` |
| V10 | **Pregel 超步调度让 trail 顺序对 fan-in 没有鉴别力**：把 `addEdge([gateA, gateB], merge)` 改成 `addEdge("gateA", merge)` 后，即使 gateB 慢 300 ms，trail 顺序**完全不变**（同一超步的兄弟节点整批收尾后才进下一超步） | **门控不能靠「边顺序」保证等齐**。可观测证据是**汇聚节点读到的 state 值**（实测里是子图的 `judge:2`）。直接约束 Task 1.2 的入参校验与 Task 0.8 的断言写法 |
| V11 | **重复 `invoke` 不是「什么都不做」，而是整图重放**：producer / 两个门控 / merge / 子图**全部第二次执行**，图却依然停在 `approval`，审批并未推进 | 「恢复」必须走 `new Command({ resume })`；重复 `invoke` = **重复烧钱 + 状态错乱**。Task 0.6 / 0.8 必须各带一条反例守卫（已实现在 `test/poc/resume.test.ts`） |
| V12 | 框架编译期会抛 `UnreachableNodeError`（节点**完全不可达**时）；但**动态跳转绕过审批能编译通过** —— 条件边声明 `ends: ["approval", "__end__"]` 却总返回 `END`，编译无误，只有运行时断言（`next === ["approval"]`）抓得到 | 规格 §18.3「升级路径可达 CEO」**框架帮不上忙**，必须在保存组织图时自建校验（Task 3.1），并保留一条「审批不可绕过」的行为测试 |
| V13 | **lint 规则降为 `warn` 后退出码仍是 0**：biome 照样打印违规（`Found 2 warnings`）但 `biome check` 返回 0，CI 就此变绿 —— 变异测试实测（把 `noRestrictedImports` 改 `warn`，拦截类断言 2 条变红，原因 `expected +0 not to be +0`） | **门禁类断言必须断言退出码，不能只看输出里有没有违规字样**。`noRestrictedImports` 必须是 `error` 级；同理任何「CI 挡住」的验收，判据是退出码而非日志文本。直接约束 Task 0.11 / 1.8 等出口门禁的写法 |
| V14 | **`PRAGMA busy_timeout` 的返回列名是 `timeout`，不是 `busy_timeout`**（journal_mode / foreign_keys / synchronous 才与名字同名；实测） | 读 PRAGMA 一律**取第一列**，别按名字取 key：取错得 `undefined`，`Number(undefined)` = `NaN`，失败现象看着像实现坏了其实是断言写错。约束 Task 0.5 的 `openDb` 自检与任何 PRAGMA 断言 |
| V15 | **`node:sqlite` 的默认值与 `sqlite3` CLI 相反**：裸构造 `foreign_keys = 1`（CLI 默认 OFF），`busy_timeout = 0`（完全不等待）；且 `exec()` 里的 `PRAGMA foreign_keys = ON` 会**覆盖**构造函数选项的 `false`（均实测） | **不得依赖驱动默认值**：`openDb()` 必须同时显式设构造选项与 PRAGMA（双层兜底，`driver.ts` 已如此并写明理由）。`busy_timeout` 不设则并发下直接 `SQLITE_BUSY` —— Task 0.5 建库与 Task 0.6 写队列都受影响 |
| V16 | **外层事务持写锁期间，另一条连接写入不会排队而是 `SQLITE_BUSY`**（变异 M7：让 Saver 自带连接、仿官方 SqliteSaver 写法 → 抛 `database is locked`；写锁是库级而非 thread 级）| ① 任何绕过 `txScope()` 自开连接写库的代码都会被数据库拒绝，架构上的「单写者」由此获得机制保证；② 反之**任何忘记提交的路径会把整个库写死**到 busy 超时 —— `tx()` 必须是回调式、不给调用方留漏提交的机会。见 `decisions/0003` §3.1 |
| V17 | **基类 `putWrites` 的文档注释要求 `getTuple` / `list` 返回的 `pendingWrites` 按 `writesSortKey`（`task_path, task_id, idx`）排序**，且明确警告：乱序会让顺序敏感的 reducer 在重放时重建出**不同的值**（读 `@langchain/langgraph-checkpoint@1.2.2` 的 `base.d.ts` 所得；计划原稿的契约清单漏了这条）| Task 0.4b 的契约测试必须新增「`pendingWrites` 顺序」用例，并对 `MemorySaver` 与本实现双向对拍；这不是性能问题，是正确性问题 |
| V18 | **checkpoint 表结构在规格里从未被定义**：附录 C 的 18 条 `CREATE TABLE` 里没有 `checkpoints` / `writes`，§C.1 只说「自建**同名**表结构以保持可迁移性」却不给出 DDL；全计划也没有任何任务定义它 | DDL 以官方 `@langchain/langgraph-checkpoint-sqlite` 为准（见 V19），由 `src/checkpoint/schema.ts` 导出常量，Saver 构造时执行 `IF NOT EXISTS`，**Task 0.5 的迁移引用同一份常量** —— 两处各写一遍必然漂移 |
| V19 | **官方 DDL 的两个易漏点**（读 `dist/index.cjs` 所得）：① `type` 列存的是 `serde.dumpsTyped()` 返回的**类型标签**，读回时必须 `loadsTyped(type, bytes)` 才能还原自定义类型 —— 只存 BLOB 不存 type 的实现在遇到非 JSON 载荷时会静默降级；② `writes` 主键是 `(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)`，而 V17 要求按 `(task_path, task_id, idx)` 排序，**主键顺序 ≠ 排序顺序**，必须另建索引 | 表名列名列序一律照抄官方（列名见 schema.ts）；`type` 与 `checkpoint` / `value` 成对存取；为 `task_path` 排序建索引 |
| V20 | **`MemorySaver.put` 只声明三个形参**（`config, checkpoint, metadata`，忽略 `newVersions`），且基类 `put` 是四参数 —— 官方参考实现自己就不读第四个参数 | 契约测试**不得**断言 `newVersions` 被持久化（`MemorySaver` 不存它，双向对拍时这条永远对不上）；自研实现收下第四个参数即可，`channel_versions` 本就在 `checkpoint` 载荷里 |
| V21 | **零原生模块这条 D6 判据目前只有测试在守，没有构建期强制**：官方 `@langchain/langgraph-checkpoint-sqlite` 仍是根 devDependency，`packages/hub/src/poc/*.mjs` 与 Phase 0 证据脚本 import 它（门禁 #2 的可复现证据），因而它的传递依赖 `better-sqlite3@12.11.1` 已被编译出 `build/Release/better_sqlite3.node`（实测 1,919,488 字节，仅存在于 `.pnpm` 深处，顶层 `node_modules/better-sqlite3` 不存在，`require.resolve` 失败） | 根 `package.json` 的 `pnpm.onlyBuiltDependencies` **不能**按原计划「0.4b 落地即移除」——移除会让门禁 #2 的 8 条测试当场失败；改由 `test/arch/no-native-deps.test.ts` 扫 `packages/**` 生产源码（PoC 目录显式豁免并写明理由），把「生产代码零原生」变成可执行断言 |
| V22 | **`putWrites` 的冲突语义按通道分裂，且两家实现一致**（实测 `MemorySaver` + 读官方 SQL）：普通通道是 `INSERT OR IGNORE`（**先写胜出**），特殊通道（`__error__`/`__scheduled__`/`__interrupt__`/`__resume__`，`idx` 为负）是 `INSERT OR REPLACE`（**后写覆盖**）；官方用 `writes.every(([channel]) => channel in WRITES_IDX_MAP)` 二选一 | 写反不会报错，只会在重放时静默重建出不同的状态——最难查的那类 bug。`allSpecial` 必须按整批 writes 判断，不是逐条；契约测试两条用例分别守住这两个方向（变异测试 A1/A2 已验证二者可独立翻转） |
| V23 | **`node:sqlite` 对「少绑参数」零保护**：2 个占位符只绑 1 个 → 可空列**静默写 NULL**（无警告）；多绑才报 `column index out of range`(errcode 25)；少绑遇 NOT NULL 报 `NOT NULL constraint failed`(1299)。另：`prepare("stmt1; stmt2")` **静默只执行第一条** | 写队列必须自己数占位符、自己拦多语句；`prepare` 绝不可当「批量执行」用（`decisions/0004` §4、§7） |
| V24 | **`?::text` 不是 SQLite 语法**（实测 `unrecognized token: ":"`，那是 PostgreSQL 方言）。`a::b` 的冒号若被当成命名参数前缀置起 `otherStyle`，会**静默关掉整条少绑校验** | 占位符扫描必须显式识别并跳过 `::`；变异 S5 证明该断言可被证伪（`decisions/0004` §5） |
| V25 | **写队列尾去毒对「下一次写」不可见**：`#tail` 中毒与否后续写都正常（`#tail.then(job, job)` 两分支皆走 job）；唯一 externally visible 的后果是 `close()` 里 `await this.#tail` 重抛早已处理的失败 → 跳过 `db.close()`，WAL 不 checkpoint、Windows 上库文件被永久占用 | 去毒断言必须**失败后立刻 `close()`**；中间只要成功写一次就洗白尾巴（W1 最初因此抓不到，`decisions/0004` §3） |

**仍未验证（保留为风险）**：`node:sqlite` 属实验性内置模块，API 可能变动；**Electron 内嵌 Node 是否暴露 `node:sqlite` 未经验证** —— 故架构规定 `node:sqlite` 只允许出现在 `packages/hub/**`（规格 §5.6.1），由 Task 0.2 在编译期强制。另：`AsyncLocalStorage` 传递同一连接已在 **Node 原生调度**下验证（跨 `await` / `setTimeout` / `Promise.all`），**但未经 LangGraph 内部调度验证** —— 这是 Task 0.4a 的存在理由。

---
## 2. 工程骨架（所有 Phase 共用，在 Task 0.2 一次建好）

单仓多包（pnpm workspace）。**包边界即语言栈纪律的执行边界**：`node:sqlite` 与 `better-sqlite3` 只允许出现在 `packages/hub`。

```
opc-os/
  package.json  pnpm-workspace.yaml  biome.json  tsconfig.base.json
  packages/
    hub/            Node 24 常驻守护进程（唯一可依赖 SQLite 与 node:sqlite 的包）
      src/db/         连接、PRAGMA、写队列、迁移、append-only 触发器
      src/checkpoint/ Saver（D6 判定后二选一实现）
      src/graph/      LangGraph 图装配、节点、边、门控
      src/events/     事件写入与广播器
      src/http/       Hono + SSE + WS（Web / 移动 / 飞书回调）
      src/roles/      岗位书 schema 与加载
      src/harness/    Harness Gateway（Phase 5 起）
      src/channels/   IM 适配（Phase 4 起）
      resources/migrations/  编号 SQL 迁移
    contracts/      zod schema + 类型（Hub 与前端共用，零运行时依赖）
    desktop/        Electron 45 壳（electron-vite），禁止直接依赖 SQLite
    web/            浏览器前端（复用同一套 React 组件）
    mobile/         Capacitor 壳（Phase 4）
  test/            跨包集成测试、确定性门控测试、回放一致性测试
```

**目录归属由两条机制强制**（Task 0.2）：`packages/*/tsconfig.json` 只声明本包可引用的依赖；biome 的
`noRestrictedImports` 禁止 `node:sqlite` 与 `better-sqlite3`。注意方向是**默认禁止、`packages/hub` 用
`overrides` 单点放行**，而不是逐个点名 desktop / web / mobile 去禁止 —— 后者会在新增包（如 Task 4.x 的
移动端壳）时因忘记点名而静默失守，前者即使忘记配置也是安全的一侧（fail-closed）。

**根 package.json scripts（固定命名，后续任务直接引用）**：

```json
{
  dev:        electron-vite dev（起 UI，连本地 Hub）
  hub:dev:    tsx watch packages/hub/src/main.ts
  test:       vitest run
  test:watch: vitest
  lint:       biome check .
  typecheck:  tsc -b            ← 不要加 --noEmit，见下方注记
  migrate:    tsx packages/hub/src/db/migrate.ts
  backup:     tsx packages/hub/src/db/backup.ts
  verify:     pnpm lint && pnpm typecheck && pnpm test
}
```

> **`typecheck` 不能写成 `tsc -b --noEmit`（实测）**：项目用了 `composite: true`（跨包引用所必需），
> 而 `tsc -b` 会把 `--noEmit` 传播给被引用的项目，composite 项目一旦禁用 emit 就报 
> `TS6310: Referenced project ... may not disable emit` —— 无论各包 tsconfig 怎么写 `noEmit` 都躲不开。
> 因此 `typecheck` 就是 `tsc -b`，各包 `outDir` 指向包内 `dist/`（已 `.gitignore`，且被 biome 经 
> `vcs.useIgnoreFile` 排除，不会污染 lint）；Electron 的真实产物在 `out/`，与这个 `dist/` 无关。
> 曾试过把 `outDir` 统一指到仓库根的 `.tsbuild/`，结果四个包抢同一个 `tsconfig.tsbuildinfo`，
> 报 `TS6377` —— 跨包共享输出根时 `tsBuildInfoFile` 会撞名，别这么干。

> **lint 门禁必须是 error 级**：实测把 `noRestrictedImports` 降成 `warn` 后，biome 仍打印违规但
> **退出码为 0**，CI 就此变绿（见 V13）。所以「有没有真的挡住」不能靠肉眼看输出，必须断言退出码。

约定：每个任务结尾的 **Commit** 用 `git commit -m "<type>(<scope>): <summary>"`；提交前必须 `pnpm verify` 全绿。**开工第一个动作是 `git init`**（当前工作区无仓库，见 §7 执行注意事项）。

---

## 3. Phase 0：编排内核与数据模型（4 周，Task 0.1 – 0.11）

**本阶段目标**：一条线性图（想法 → 章程 → 产品拆解 → 技术拆解 → 开发 → 测试 → 上报）端到端跑通，进程被杀后能从 Checkpoint 续跑，每个节点输入输出都在审计日志里。

### Task 0.1　仓库初始化 + PoC 固化（0.5 天）
- **Files**：`git init`、`.gitignore`（含 `*.db`、`*.db-wal`、`*.db-shm`、`node_modules`、`dist`）、`README.md`、根 `package.json`（**此处只装 `vitest`，其余工具链在 Task 0.2 补齐**）、`packages/hub/src/poc/graph.mjs`、`test/poc/resume.test.ts`
- **Test**：把 `evidence/phase0-poc/poc-graph.mjs` 与 `poc1/poc2.mjs` 搬进仓库，改写成一个 vitest 用例：**测试内 `spawn` 两个真实子进程**（进程 1 跑到 interrupt 退出，进程 2 从同一 DB 恢复并 resume），断言 `trail` 与 `next` 与实测输出一致。
- **Run**：`pnpm i -D vitest && pnpm test test/poc/resume.test.ts` → 期望 1 passed（**这一步同时证明 CI 能跑跨进程恢复测试**）
- **验收**：门禁 #1/#2/#4/#5 四项各有一个会失败的测试守着；故意把 `resume` 改成重复 `invoke` 时测试必须失败。
- **Commit**：`chore(repo): init workspace and pin phase0 poc as tests`

### Task 0.2　工具链、目录骨架与依赖边界（1 天）
- **Files**：`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`biome.json`、`vitest.config.ts`、各 `packages/*/package.json` 与 `tsconfig.json`
- **Steps**：`pnpm i -D typescript @biomejs/biome tsx`（vitest 已在 Task 0.1 装好），并在根 `package.json` 落 §2 的全部 scripts → 建骨架 → 配 `noRestrictedImports`（`desktop`/`web`/`mobile` 禁 `node:sqlite`、`better-sqlite3`）
- **Test**：`test/arch/dependency-boundary.test.ts`：在 `packages/desktop/src/__probe.ts` 里 `import "node:sqlite"`，断言 `pnpm lint` **失败**；删除该文件后 `pnpm lint` 通过。
- **Run**：`pnpm verify`（此时应只有一个测试文件且通过）
- **验收**：越界 import 会被 CI 挡住（规格 §5.6.1 的编译期强制落地）。
- **Commit**：`chore(repo): toolchain, workspace layout and dependency boundaries`

### Task 0.3　SQLite 驱动定案（§25-D6 决策门，0.5 天）　—— 决策已作出，剩固化
- **状态**：**D6-a 已定案（2026-11-06）**，决策记录见 `docs/decisions/0001-sqlite-driver.md`。依据为归档探针 `docs/superpowers/evidence/phase0-poc/`（`d6a.mjs`、`als-and-bind-limits.mjs`、`POC-OUTPUT.txt`、`LIMITS.txt`）。**禁止重新调研或重复决策。**
- **本任务剩余的实际工作（三件，都是把探针变成仓库资产）**：
  1. 建 `packages/hub/test/db/driver-preflight.test.ts`，把决策文档 §2.1 / §2.2 的断言固化进仓库 —— **当前仓库内没有这个测试，只有临时探针**；
  2. `src/db/driver.ts` 暴露 `openDb(path): DatabaseSync`（统一 PRAGMA）与 `BATCH_ROWS = 1000` 常量，注释指向决策文档 §2.2（绑定参数上限实测 ≥ 8192，但未穷尽）；
  3. 测试必须针对**目标运行时**执行：若运行时无 `node:sqlite`，**必须显式失败**并提示「改判 D6-b」，**不得 skip**（skip 会让驱动不可用在 CI 里静默通过）。
- **Run**：`pnpm test test/db/driver-preflight.test.ts`
- **验收**：测试存在且通过；`driver.ts` 有分片常量；决策文档 §6 的三个待办全部勾选。
- **Commit**：`test(db): pin D6 preflight assertions into the repo`

### Task 0.4a　框架路径同事务探针（**阻塞 0.4b 的设计门**，1 天）
> **当前状态（2026-11-06）**：已完成，判定为**原方案**，规格 §6.3 无需降级。实测依据、变异测试记录与两条会改变实现的副作用见 `decisions/0003-checkpoint-transaction-scope.md`；后续执行者不必重跑本探针。

**为什么单独成任务**：规格 §6.3 要求 Checkpoint 与 `events` 同一事务提交。探针已证明**手工**把三张表写进同一事务可行（V7），也证明 `AsyncLocalStorage` 能在 Node 原生调度下跨 `await` / `setTimeout` / `Promise.all` 传递同一连接（见决策文档 §2.2）。**但没有证明 LangGraph 的内部调度不会打断 ALS 上下文** —— 而 `put()` / `putWrites()` 是框架在我们代码之外调用的，我们拿不到它的事务边界。这是规格 §24 风险 6 的真实缺口，不能靠假设跨过。

- **Files**：`packages/hub/test/checkpoint/tx-scope-probe.test.ts`、`docs/decisions/0003-checkpoint-transaction-scope.md`
- **方案（要验证的假设）**：用 `AsyncLocalStorage` 建立事务上下文 `txScope()`；节点执行体在 scope 内 `BEGIN IMMEDIATE`；Saver 的 `put` / `putWrites` 与审计写入都从 scope 取**同一个连接**执行；节点结束统一 `COMMIT`。
- **探针断言（一次真实图执行）**：
  1. `checkpoints` / `writes` / `events` 三表的行由**同一连接**写入（用连接实例身份或 `db.openedObjects` 计数验证）；
  2. `COMMIT` 之前，另一个只读连接**读不到任何一行**（真原子，不是快速提交）；
  3. 节点内抛错 → 三表**全部无残留**（对账查询返回 0）；
  4. 并行节点（Task 0.8 的单分支回退 + Task 3.7 的并行分支各一例）下，两个事务互不串用连接。
- **判定与后果**：
  - **通过** → 0.4b 按 `txScope()` 实现，规格 §6.3 原样成立；
  - **失败** → 写 `docs/decisions/0003`，把规格 §6.3 降级为「`events` 以 `checkpoint_id` 外键关联 + Hub 启动时对账」，并在 Task 3.4 增加「有 Checkpoint 无事件 / 有事件无 Checkpoint」的告警查询。**降级是允许的，静默不是** —— 规格 §24 风险 6 的「宁可停，不可丢事件」在两种方案下都必须成立。
- **验收**：探针测试进仓库（不是临时脚本）；决策文档记录走的是原方案还是降级方案。
- **Commit**：`test(checkpoint): framework-path same-transaction probe and decision`

### Task 0.4b　Checkpoint Saver 实现（2–3 天，依赖 0.4a 的结论）
> **当前状态（2026-11-07）**：已完成（提交 `2cf71ff`、`a956d10`）。契约测试同一套用例跑
> `MemorySaver` 与自研 Saver：39 passed | 6 skipped。落地后的验证记录见 `decisions/0003` §7；
> 该任务测出的两条硬事实记为 V21、V22。

- **Files**：`packages/hub/src/checkpoint/saver.ts`、`packages/hub/src/checkpoint/tx-scope.ts`、`packages/hub/src/checkpoint/schema.ts`、`packages/hub/test/checkpoint/saver.contract.test.ts`（注意：计划原稿写的是 `test/checkpoint/`，但 hub 的测试在 `packages/hub/test/` 下才会被 vitest 的 `packages/*/test/**` 收进来 —— 见 Task 0.3 的 include 调整）
- **接口（以 V6 基类签名为准，五个抽象方法一个都不能少；注意 `deleteThread` 极易漏）**：

```ts
import type {
  BaseCheckpointSaver, Checkpoint, CheckpointMetadata, CheckpointTuple,
  PendingWrite, ChannelVersions,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

export declare class SqliteWALSaver implements BaseCheckpointSaver {
  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined>;
  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple>;
  put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata,
      newVersions: ChannelVersions): Promise<RunnableConfig>;
  putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string,
            taskPath?: string): Promise<void>;
  deleteThread(threadId: string): Promise<void>;
}
```

- **实现约束**：`put` 与 `putWrites` **不得自行开事务**，必须使用 `txScope()` 提供的连接（0.4a 通过时）；若 0.4a 判定降级，则它们自带短事务并被 Task 3.4 的对账覆盖。两种情况下都**不得**在 `put` 内部 `BEGIN` 后不提交。
- **序列化**：Checkpoint 载荷按 `Uint8Array` 存 BLOB（V7 已验证往返类型），**并连带存下 `dumpsTyped` 返回的类型标签到 `type` 列**（V19），读回走 `loadsTyped(type, bytes)`。
- **表结构**：`schema.ts` 导出官方同名的 `checkpoints` / `writes` DDL 常量（V18、V19），Saver 构造时 `CREATE TABLE IF NOT EXISTS`；**Task 0.5 的迁移必须引用这份常量而不是另抄一遍**。列序照抄官方，别按自己喜好重排。
- **对拍基线**：`MemorySaver` 是参考实现，但它忽略 `newVersions`（V20），契约测试的断言范围要以此为界。
- **契约测试（同一套用例跑 `MemorySaver` 与自研 Saver，证明可互换）**：
  - `put` 后 `getTuple` 返回同一 `checkpoint_id`，且 `parentConfig` 链正确；
  - `list` 按时间倒序并支持 `before`；
  - `putWrites` 的 `(thread, ckpt, task, idx)` 主键去重生效；
  - `deleteThread` 后 `getTuple` 返回 `undefined`；
  - **同事务原子性**：`put` 成功、`putWrites` 抛错 → 两者都不可见（0.4a 方案的直接回归）。
  - **`pendingWrites` 排序**（V17，基类契约要求）：以乱序 `(task_path, task_id, idx)` 写入多组 writes，`getTuple` 与 `list` 返回时必须已按 `writesSortKey` 排好；顺序敏感 reducer 靠这个顺序重放，乱序会重建出不同的值。与 `MemorySaver` 对拍同一输入的输出顺序。
  - **无 ALS 作用域时的行为**：`put` 在框架外被直接调用（无 `txScope()`）时按 `decisions/0003` §6.2 抛错，而非静默自开短事务 —— 静默自提会让 §6.3 的原子性在最常见路径上失效。
- **Run**：`pnpm test test/checkpoint/`
- **验收**：契约测试对 `MemorySaver` 与自研 Saver **双向通过**；`typecheck` 通过（V6 的 `put` 四参数签名以基类为准，不得照抄官方 SqliteSaver 的三参数）。
- **Commit**：`feat(checkpoint): sqlite checkpoint saver with contract tests`

### Task 0.5　迁移框架 + schema + 写队列（3 天）
> **当前状态（2026-11-07）**：已完成（提交 `7bd8f0e`，14 文件 +2504）。`pnpm verify` = 10 文件 / 
> 113 passed | 6 skipped。19 项变异：**15 项断言级杀死、1 项异常杀死（△，见 `decisions/0004` §11.2）、
> 3 项存活** —— 存活的 P1/P3/R1 是「构造选项 + 显式 PRAGMA」的冗余双保险，已各补一条**复合变异**
> （X1/X2：同时拆掉两处）证明冗余本身在保险，而不是测试没测到。
>
> **本任务两处计划措辞与实测不符，按实测落地**：① append-only 触发器的报错不是 `immutable`，实测是
> `events table is append-only`（errcode **1811**）；② 附录 C 的 trigram 结论测于 SQLite 3.53.4，本机
> `node:sqlite` 内嵌 **3.51.2**，已重测并留活文档。
> schema 的 2 处 SQL 偏离、`WriteQueue` 的 4 处 C.2 偏离、以及「`node:sqlite` 对少绑参数零保护」
> 见 `decisions/0004-migrations-and-write-queue.md`。

- **Files**：`packages/hub/resources/migrations/0001_init.sql`（内容取自规格附录 C，**FTS5 必须带 `tokenize = 'trigram'`**）、`src/db/migrate.ts`、`src/db/write-queue.ts`、`src/db/pragmas.ts`、`test/db/*.test.ts`
- **写队列接口**（对应附录 C.2 的 `WriteQueue`）：

```ts
export interface WriteQueue {
  /** 同一事务内按顺序执行全部语句；任一失败整体回滚并向上抛出 */
  tx(stmts: Array<[sql: string, params: unknown[]]>): Promise<void>;
  /** 只读查询走独立连接，不进队列 */
  read<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
```

- **Test**：
  - `0001_init.sql` 能建全部表且 `PRAGMA foreign_key_check` 无输出；
  - append-only 触发器：UPDATE / DELETE 均抛 `immutable`；
  - `tx` 内第二条语句失败 → 第一条不可见（V7）；
  - 并发 `tx` 调用被串行化：并发 50 次各插一行，最终 50 行且无 `database is locked`；
  - FTS5 中文冒烟：插入含『覆盖率』的 payload，`MATCH '覆盖率'` 命中 ≥1，`MATCH '件通'` 命中 0（**这条测试就是规格 C.3 的活文档**）。
- **Run**：`pnpm migrate && pnpm test test/db/`
- **验收**：删库重建可重放（幂等迁移）；`pnpm migrate` 对已应用迁移是 no-op。
- **Commit**：`feat(db): migrations, append-only triggers and serialized write queue`

### Task 0.6　事件总线与审计写入（2 天）
- **Files**：`src/events/bus.ts`、`src/events/recorder.ts`、`src/graph/audit-middleware.ts`、`test/events/*.test.ts`
- **接口**：

```ts
export type DomainEvent =
  | { kind: "TaskStateChanged"; taskId: string; from: string; to: string }
  | { kind: "ReviewDecided"; taskId: string; gate: string; decision: "pass" | "reject" }
  | { kind: "ApprovalRequired"; taskId: string; interruptId: string; payload: unknown }
  | { kind: "BudgetPaused"; taskId: string; spentUsdCents: number }
  | { kind: "MeetingSummaryReady"; taskId: string; meetingId: string }
  | { kind: "HeartbeatStalled"; taskId: string; node: string };

export interface EventBus {
  publish(e: DomainEvent): void;                    // 非阻塞，入队即返回
  /** seq 单调递增（由 events.id 派生），供 Task 2.1 的 SSE 断线续订使用 */
  subscribe(fromSeq?: number): AsyncIterable<DomainEvent & { seq: number }>;
  latestSeq(): number;
  // 每个订阅者持有独立有界队列；慢消费者丢最旧并标记 degraded（规格 §5.8）
}
}
```

- **两条硬规定**：
  1. 每个节点执行时，**Checkpoint 与 `INSERT INTO events` 必须在同一个 `tx()` 里**（规格 §6.3）；
  2. `interrupt` 按 **V2** 处理 —— 检查返回值 `__interrupt__` 而不是 catch 异常，据此发 `ApprovalRequired`。
- **Test**：
  - 慢消费者不拖慢生产者：某订阅者不消费，生产者写入仍完成，该订阅者收到 `degraded` 标记；
  - 一个节点失败 → 该节点的 events 行数增量为 0（同事务回滚）；
  - `__interrupt__` 被识别并发出 `ApprovalRequired`（**故意写一版 try/catch 实现，此测试必须失败**）；
  - 崩溃恢复（V3）后不产生重复 `TaskStateChanged`。
- **Commit**：`feat(events): domain event bus with transactional audit recording`

### Task 0.7　岗位书 schema 与加载（2 天）
- **Files**：`packages/contracts/src/charter.ts`（zod）、`src/roles/loader.ts`、`resources/charter-templates/*.yaml`（CEO / 助理 / 产品 / 技术 / 开发 / 测试 / 运营）、`test/roles/charter.test.ts`
- **Test**：合法 YAML 解析通过；缺 `honesty_boundaries` / `version` / `acceptance_criteria` 时**必须拒绝加载并给出字段路径**；`decision_scope.forbidden` 中的条目无法被运行时参数覆盖（规格 §20.2 权限单调性）。
- **Commit**：`feat(roles): charter zod schema and preset templates`

### Task 0.8　最小可运行图（3 天）
- **Files**：`src/graph/company.ts`、`src/graph/nodes/*.ts`、`test/graph/e2e-linear.test.ts`
- **图定义**（规格 §23.3，线性 + 单分支）：`intake → charter → product → tech → dev → test → report`，`test` 未通过时回到 `dev`（单分支回退）。
- **节点模型注入**：模型经 `@langchain/core` message API 注入到节点，**节点级配置**由岗位书 `model_tier` 驱动（规格 §5.9）；测试用桩模型（不联网、不计费）。
- **Test（端到端）**：
  - 输入一句想法 → 图跑到 `END`，`events` 表出现完整状态机轨迹；
  - `test` 节点桩失败一次 → 回退 `dev` 一次，轨迹正确；
  - 中途 `process.kill` 后重启续跑（复用 Task 0.1 的双进程模式），已完成节点不重复执行（V3）；
  - 断言 `TaskStateChanged` 的 `from/to` 序列与规格 §7.1 状态机**完全一致**，无非法跃迁。
- **Commit**：`feat(graph): minimal runnable company graph end to end`

### Task 0.9　CEO 验收：岗位书「做完了」定义（阻塞型任务，2 天日历）
- **产出物**：每个预设角色的 `acceptance_criteria` 由 **CEO 本人**签字确认（不是开发者代写）。
- **文件路径**：直接改进 Task 0.7 已建的 `packages/hub/resources/charter-templates/{ceo,assistant,product,tech,dev,test,ops}.yaml` 的 `acceptance_criteria` 段（模板由 Task 0.7 提供骨架与占位示例，此处由 CEO 逐条替换为真实标准）；每个 YAML 顶部加 `signed_by: ceo` 与 `signed_at: <日期>` 两个字段。
- **自动化护栏**：Task 0.7 的 `charter.test.ts` 增加一条 —— 断言 7 个模板全部含 `signed_by: ceo`，且 `acceptance_criteria.must[].check` 不是 Task 0.7 的占位示例文本（用固定占位串比对）。**这条测试会一直红着，直到 CEO 真的签完** —— 用 CI 的红灯代替催办。
- **为什么是任务而不是文档工作**：规格 §23.2 指出这是系统能否替 CEO 过滤审阅负担的前提。开发者不得代笔。
- **验收**：每个角色至少 3 条**可机械判定**的标准（例：『落地页任务：Lighthouse 性能 ≥ 80 且移动端首屏 ≤ 2s』），且 Phase 1 的门控能直接消费这些标准。
- **未完成的后果**：Phase 1 的门控会退化成主观判断，§8 的全部设计失效 —— **此时宁可推迟 Phase 1，不可代写**。
- **Commit**：`feat(charter): ceo-signed acceptance criteria for seven preset roles`（**若 CEO 未签完，本任务不得提交，Phase 1 的 Task 1.1 之前不允许出现这条 commit**）

### Task 0.10　Hub CLI 骨架（1 天）
- **Files**：`src/main.ts`、`src/cli.ts`（`hub run --idea "..."` / `hub status` / `hub resume`）、`test/cli/smoke.test.ts`
- **Test**：`hub run --idea` 在临时目录建库、跑完桩图、退出码 0；重复运行同一 `thread_id` 不重复计费（V3）。
- **Commit**：`feat(hub): cli entry with run, status and resume`

### Task 0.11　Phase 0 出口门禁（0.5 天）
- **Run**：`pnpm verify` 全绿；`test/` 下用例数 ≥ 25；人工核对一次审计日志可读性。
- **出口标准（对应规格 §23.1）**：测试想法跑通完整流程；中途手动打断并从 Checkpoint 恢复；审计日志完整记录每个节点输入输出。
- **Gate**：通过后才能进 Phase 1。
- **Commit**：`chore(phase0): mark phase 0 exit gate passed`

---
## 4. Phase 1：审阅门控与证据包（3 周，Task 1.1 – 1.8）

**目标**：把「作者绝不给自己打分」从一句理念变成**确定性代码 + 不可绕过的硬约束**（规格 §8、§24 风险 1、风险 5）。

### Task 1.1　证据包 schema（1.5 天）
- **Files**：`packages/contracts/src/evidence.ts`、`src/evidence/store.ts`、`test/evidence/*.test.ts`
- **接口**：

```ts
export const EvidenceBundle = z.object({
  bundle_id: z.string().uuid(),
  task_id: z.string(),
  bundle_type: z.enum(["spec", "design", "code_diff", "test_report", "ops_plan", "approval_card"]),
  produced_by_role: z.string(),
  produced_by_model_family: z.string(),   // 门控交叉校验用（Task 1.4）
  artifacts: z.array(z.object({ path: z.string(), sha256: z.string().length(64), bytes: z.number().int() })),
  claims: z.array(z.object({ text: z.string(), evidence_refs: z.array(z.string()).min(1) })),
  honesty_boundaries: z.array(z.string()),
});
```

- **Test**：`claims[].evidence_refs` 为空 → 拒绝；`sha256` 与实际文件内容不符 → `store.verify()` 返回 false；制品文件缺失 → false。
- **验收**：制品落 `~/.opc-os/artifacts/{task_id}/{bundle_type}/{bundle_id}.*`，SQLite 只存路径与哈希（规格 §5.10）。
- **Commit**：`feat(evidence): evidence bundle schema and content-addressed store`

### Task 1.2　门控判定内核：确定性 + 可单测（2 天）
- **Files**：`src/graph/gates/evaluate.ts`、`test/gates/determinism.test.ts`
- **接口**：

```ts
export type GateVerdict =
  | { decision: "pass" }
  | { decision: "reject"; reasons: string[]; required_fixes: string[] }
  | { decision: "escalate"; reason: string };

export function evaluateGate(input: {
  gate: ReviewGate; producer: ProducerInfo; bundle: EvidenceBundle;
  criteria: AcceptanceCriteria;   // 来自岗位书，Task 0.7 产出
}): GateVerdict;
```

- **硬规定（规格 §24 风险 5）**：`evaluateGate` 是**纯函数**，不查 LLM、不读网络、不读时钟。凡需要判断质量的环节，产出的是一个**待验证断言列表**，交给测试执行器（Phase 5）或人工审批（Phase 1 先支持人工）。
- **Test**：
  - **确定性**：同一输入调用 100 次，结果逐字节相同；
  - **覆盖率**：门控判定分支的覆盖率 ≥ 95%（vitest coverage 阈值写进 config）；
  - 断言 `criteria` 为空时**必须 reject**（不得默认通过 —— 这是最危险的静默失效）。
- **Commit**：`feat(gates): deterministic pure gate evaluator`

### Task 1.3　「作者不给自己打分」的硬拦截（1.5 天）
- **Files**：`src/graph/gates/author-reviewer.ts`、`test/gates/author-reviewer.test.ts`
- **Test（这一组测试就是本设计的核心防线）**：
  - `reviewer.role_id === producer.role_id` → **保存门控时即拒绝**（不是运行时才发现）；
  - `reviewer.model_family === producer.model_family` → 需要 `explicit_approval` 才允许（规格 §5.9 第 1 条）；
  - 构造一条『开发自审自过』的边 → `validateNewEdge` 返回 `{ ok: false }`（复用规格 §18.3 的实现）；
  - 试图用运行时参数覆盖 `forbidden` → 抛错，且写入一条 `unauthorized_attempt` 审计事件。
- **Run**：`pnpm test test/gates/`
- **Commit**：`feat(gates): hard block on self-review and same-family review`

### Task 1.4　升级路由（1.5 天）
- **Files**：`src/graph/routing/escalation.ts`、`test/routing/escalation.test.ts`
- **触发条件（规格 §8.3、§9）**：审阅冲突轮次 ≥ 3、不可逆动作、预算阈值、超出 `decision_scope`、置信度不足。
- **接口**：`decideEscalation(state): { escalate: false } | { escalate: true; reason: EscalationReason; card: ApprovalCardDraft }`
- **Test**：每个触发条件各一例；**升级路径必须可达 CEO**（图结构可达性检查，复用规格 §18.3 第 3 条）；升级后原节点不得继续向前流转。
- **Commit**：`feat(routing): escalation triggers and approval card drafting`

### Task 1.5　策略引擎规则骨架（2 天）
- **Files**：`packages/contracts/src/policy.ts`、`src/policy/engine.ts`、`test/policy/classify.test.ts`
- **三级分类（规格 §9.1）**：只读 / 可逆 / 不可逆。本期只做**分类 + 决策记录**，自动审批留到 Task 3.5。
- **接口**：

```ts
export type RiskTier = "read_only" | "reversible" | "irreversible";
export function classifyAction(a: ActionDraft): RiskTier;
export function policyDecide(a: ActionDraft, ctx: PolicyContext):
  { action: "auto_allow"; tier: RiskTier } |
  { action: "require_approval"; tier: RiskTier; reason: string } |
  { action: "forbidden"; tier: RiskTier; reason: string };
```

- **Test**：`rm -rf` / 推送主干 / 对外发布 / 付款 → `irreversible`；改工作区文件 → `reversible`；读仓库 / 跑测试 → `read_only`；**未知动作默认 `irreversible`（fail-closed，不得默认放行）**。
- **Commit**：`feat(policy): three-tier action classification with fail-closed default`

### Task 1.6　预算护栏（1.5 天）
- **Files**：`src/budget/tracker.ts`、`test/budget/*.test.ts`
- **Test**：角色 / 任务 / 日预算三级各自突破 → 发 `BudgetPaused` 并**暂停该节点而非杀任务**（规格 §7.4）；金额一律用整数美分（避免浮点误差，规格 §6.1）；同一预算事件的重复上报**不重复扣减**。
- **Commit**：`feat(budget): tiered budget tracking with pause-on-breach`

### Task 1.7　CEO 验收：门控行为可预期（阻塞型任务，2 天日历）
- **验收脚本（对应规格 §23.1 Phase 1 三条标准，必须是自动化用例）**：
  1. 开发标记完成但不附测试报告 → 门控 reject；
  2. 测试标记通过但覆盖率不足 → reject；
  3. 触发一次预算突破 → `BudgetPaused` + 升级卡片生成。
- **Test 文件**：`test/acceptance/phase1-gates.test.ts`（三条各一个用例，桩模型驱动）。
- **Commit**：`test(acceptance): phase 1 gate behaviors pinned by tests`

### Task 1.8　Phase 1 出口门禁（0.5 天）
- **Run**：`pnpm verify`；门控判定分支覆盖率 ≥ 95%；`test/acceptance/phase1-gates.test.ts` 三条通过。
- **Gate**：通过后进入 Phase 2。
- **Commit**：`chore(phase1): mark phase 1 exit gate passed`

---

## 5. Phase 2：桌面端前端与 Hub 边界（4 周，Task 2.1 – 2.9）

**目标**：CEO 在图形界面里完成「扔想法 → 看流转 → 收件箱审批 → 看板更新」，**全程不碰命令行**（规格 §23.1）。

### Task 2.1　Hub 的 HTTP + SSE 契约（2 天）
- **Files**：`packages/contracts/src/api.ts`、`src/http/app.ts`（Hono）、`src/http/sse.ts`、`test/http/contract.test.ts`
- **端点（最小集）**：`POST /tasks`（扔想法）、`GET /tasks`、`GET /tasks/:id`、`POST /approvals/:interruptId`（body 含 `resume` 值）、`GET /events`（SSE）、`GET /replay/:taskId`（Phase 3 填充）。
- **鉴权（规格 §20.3）**：本地一次性 token + 请求签名；token 由 Hub 启动时打印一次，渲染进程经 IPC 获取，**前端代码里不得出现明文 token 常量**。
- **Test**：SSE 断线重连后按游标续订不丢事件；无 token 请求 401；`POST /approvals/:id` 对不存在的 id 返回 404 且**不产生审计事件**。
- **Commit**：`feat(http): hub REST plus SSE contract with local auth`

### Task 2.2　Electron 壳与 IPC 边界（2 天）
- **Files**：`packages/desktop/electron.vite.config.ts`、`src/main/index.ts`、`src/preload/index.ts`、`src/renderer/**`
- **硬边界**：渲染进程**不直连 SQLite、不读写 `~/.opc-os`**（规格 §5.6.1 的边界在 Task 0.2 已强制），一律经 `preload` 暴露的白名单方法调 Hub。
- **Test**：`test/desktop/ipc-surface.test.ts` 断言 preload 暴露的方法集合**等于白名单**（多一个少一个都失败）——防止未来随手加一个 `dbQuery`。
- **Commit**：`feat(desktop): electron shell with whitelisted ipc surface`

### Task 2.3　AG-UI 事件消费层（2 天）
- **Files**：`packages/web/src/agui/useHubEvents.ts`、`test/web/use-hub-events.test.tsx`
- **实现要点**：SSE → `@ag-ui/client` 事件 → React 状态；**事件是投影不是事实源**（规格 §5.8）：断线后先 `GET /tasks` 拉快照，再用 Task 0.6 的 `subscribe(fromSeq)` 从游标续订 —— 游标就是 `events.id`，因此「快照 + 续订」天然幂等，不会因重放产生重复投影。
- **Test**：喂入乱序 / 重复事件 → 最终状态与有序输入一致（幂等）；连接中断 → UI 显示降级标记且不发疯重连（退避上限）。
- **验收**：渲染进程内**不存在任何业务状态机**（状态跃迁只能由 Hub 事件驱动，规格 §5.8 结尾纪律）。
- **Commit**：`feat(web): ag-ui event projection layer with reconnect snapshot`

### Task 2.4　今日视图（3 天）
- **Files**：`packages/web/src/pages/Today.tsx`、组件 `EventCard` / `MeetingSummaryCard` / `AnomalyCard` / `InfoCard`
- **四种卡片（规格 §16.1）**：`MeetingSummaryReady` / `ApprovalRequired` / `BudgetPaused` / `HeartbeatStalled`。
- **Test（vitest + testing-library）**：给定事件序列快照 → 渲染结果快照一致；**`BudgetPaused` 用非琥珀色样式**（规格 §19 色彩语义，写进测试防回归）；空态（无事发生）不显示虚假的「一切正常」。
- **Commit**：`feat(web): today view with four card types`

### Task 2.5　任务看板（3 天）
- **Files**：`packages/web/src/pages/Board.tsx`、`BoardColumn`、`TaskRow`
- **要求**：六列（`INSIGHT / PLANNING / DEVELOPING / REVIEWING / AWAITING_APPROVAL / DELIVERED`）+ **三层折叠**（任务 → 阶段 → 节点，规格 §19.4）；层级用左边框 + 缩进 + 背景色阶（不用竖线）。
- **Test**：折叠状态持久化；卡片移动只能由事件驱动（禁止前端乐观改状态后不校正）；`AWAITING_APPROVAL` 列出现**脉冲**样式（§19 琥珀语义）。
- **Commit**：`feat(web): task board with six columns and three-level collapse`

### Task 2.6　审批收件箱（3 天）
- **Files**：`packages/web/src/pages/Inbox.tsx`、`ApprovalCardView`、`src/http/approvals.ts`
- **交互（规格 §9.3 三段式 + §19.4）**：一句人话 → 参数快照 → 批准 / 打回 / 改后再批；参数快照用等宽字体 + 左缩进（不画框线）。
- **Test**：批准后 Hub 图恢复执行（用 Task 0.6 的 `__interrupt__` 路径，V2）；打回必须填理由且理由进入审计；**同一 `interrupt_id` 重复提交幂等**（第二次返回首次结果，不二次执行）。
- **验收**：键盘可完成全部审批操作（规格 §19.1 效率承诺）；收件箱计数与实际待审批数一致。
- **Commit**：`feat(web): approval inbox wired to graph resume`

### Task 2.7　组织配置只读视图（2 天）
- **Files**：`packages/web/src/pages/OrgReadOnly.tsx`（只渲染，不含编辑器 —— 编辑器在 Phase 3）
- **Test**：渲染岗位书字段完整；`decision_scope` 三档（autonomous / requires_consultation / forbidden）以可读法文显示，**不得出现原始 JSON**。
- **Commit**：`feat(web): read-only org configuration view`

### Task 2.8　Web 前端同源复用（1 天，随 2.2–2.7 顺带完成）
- **Files**：`packages/web/src/entry.browser.tsx`、`packages/desktop/src/renderer/entry.tsx`
- **要求**：**一套组件两个入口**（规格 §5.7、§25-D8）；浏览器入口只做路由裁剪，不复制组件。
- **Test**：同一快照测试在两个入口下渲染结果一致。
- **Commit**：`feat(web): single component set for desktop and browser entries`

### Task 2.9　Phase 2 出口门禁（2 天）
- **Playwright E2E**：`test/e2e/ceo-loop.spec.ts` —— 起 Hub + Web，端到端执行：输入想法 → 看板出现卡片并流转 → 收件箱出现审批 → 点击批准 → 看板更新为 DELIVERED。**全程无命令行**。
- **人工核对**：用键盘完成一次完整审批，记录耗时（应 ≤ 20 秒，规格 §19.1）。
- **Gate**：通过后进入 Phase 3。
- **Commit**：`test(e2e): ceo loop without command line`

---

## 6. Phase 3：组织编辑、回放与自动审批（3 周，Task 3.1 – 3.8）

### Task 3.1　组织图数据层与三层确定性校验（2 天）
- **Files**：`src/org/graph.ts`、`src/org/validate.ts`、`test/org/validate.test.ts`
- **实现规格 §18.3 的三个纯函数**：`validateReparenting` / `validateNewEdge` / `validateOrgChange`（**同一份代码前后端共用**，放 `packages/contracts`）。
- **Test**：环检测、非管理角色不收汇报、深度 > 5 拒绝、CEO 不可拖、无门控的委派边拒绝、同家族自审边拒绝、升级路径不可达 CEO 拒绝、非 CEO actor 改组织拒绝、有运行中任务时需确认。
- **验收**：这些用例**同时**被前端（拖拽时实时高亮）与 Hub（保存时二次校验）引用 —— 一处改动两侧生效。
- **Commit**：`feat(org): shared three-layer org validation`

### Task 3.2　React Flow 编辑器 + dagre 自动布局（4 天）
- **Files**：`packages/web/src/pages/OrgEditor/**`、`src/org/layout.ts`、`test/org/editor.test.tsx`
- **实现**：`@xyflow/react` 12 + `@dnd-kit/core` 6 + `@dagrejs/dagre` 3；三栏布局（规格 §18.6）；五种拖拽语义（规格 §18.2）。
- **Test**：非法拖拽**回弹并给出原因文本**；`onNodeDragStart` 期间窗口导航 / 文件拖放被禁用（规格 §18.1 的 Electron 注意事项）；自动布局后**节点无重叠**（坐标断言）。
- **验收**：保存前的校验与 Task 3.1 完全同源，前端不得自行放宽。
- **Commit**：`feat(web): drag-and-drop org editor with shared validation`

### Task 3.3　版本化提交：编辑时草稿、提交才生效（2 天）
- **Files**：`src/org/commit.ts`、`packages/contracts/src/org-graph.ts`、`test/org/versioning.test.ts`
- **要求（规格 §18.4）**：草稿只存内存/本地；保存时 Hub 重跑校验 → 同一事务写 `role_charters`（version + 1）与 `delegation_graphs`（新版本）+ 一条前后快照审计事件；**不重建运行中的图**；运行中任务用创建时版本。
- **Test**：保存失败 → 版本号不变、无半提交行；运行中任务在组织变更后**仍用旧版图**（V3 的恢复语义可验证）；新任务用新版图。
- **Commit**：`feat(org): versioned org changes without touching running graphs`

### Task 3.4　回放时间线 + 中文检索（3 天）
- **Files**：`packages/web/src/pages/Replay.tsx`、`src/replay/query.ts`、`src/replay/search.ts`、`test/replay/search.test.ts`
- **实现规格 §22 + 附录 C.3**：回放按 Checkpoint + events 重建时间线；搜索用 **trigram 命中 → LIKE 兜底** 双路。
- **Test**：
  - 『覆盖率』可命中（trigram）；『件通』（2 字）**走 LIKE 仍命中**（V：附录 C.3 实测 trigram 对此返回 0）；
  - 回放**逐节点可展开**并显示输入输出摘要；
  - 一致性：同一任务连续回放两次输出完全相同（规格 §24 风险 6 的校验用例）；
  - **搜索必须在只读连接 + 分页上执行**：断言搜索期间写队列仍可提交（WAL 读不阻塞写）。
- **验收**：5 分钟内可通过回放理解任意已完成任务（规格 §23.1 Phase 6 的前置能力，此处先建）。
- **Commit**：`feat(replay): timeline with trigram-plus-like chinese search`

### Task 3.5　策略引擎自动审批（2 天）
- **Files**：`src/policy/auto-approve.ts`、`test/policy/auto-approve.test.ts`
- **规则**：只读动作 + 证据包完整 + 门控通过 → 自动通过并**记入日报**（规格 §23.1 Phase 3：自动通过的决策可追溯）。
- **Test**：自动通过必须写审计事件且含 `auto_approved_by`；任何一项条件缺失 → 降级为人工审批；**不可逆动作永不自动通过**（与 Task 1.5 的 fail-closed 呼应）。
- **Commit**：`feat(policy): audited auto-approval for read-only actions`

### Task 3.6　岗位书编辑器 + 预算层级配置（2 天）
- **Test**：修改 `acceptance_criteria` 后**重跑同类任务，门控行为随之变化**（规格 §23.1 Phase 3 的验收原话，做成自动化用例）；预算层级（公司 / 角色 / 任务）显示与编辑一致。
- **Commit**：`feat(web): charter editor and budget tier configuration`

### Task 3.7　角色级记忆 + 并行分支与动态边（3 天）
- **Files**：`src/graph/branches.ts`、`src/memory/role-memory.ts`、`test/graph/parallel.test.ts`
- **Test**：产品与运营**并行拆解同一想法**后汇聚正确（V1/V4 已验证框架支持）；记忆按角色隔离，**开发角色读不到 CEO 战略记忆**。
- **验收**：并行分支只在确有绕行需求时启用（规格 §23.2 反过度设计要求 —— 若无可用的绕行场景，允许本期仅保留能力而不接入生产图）。
- **Commit**：`feat(graph): parallel branches and per-role memory isolation`

### Task 3.8　Phase 3 出口门禁（1 天）
- **Run**：`pnpm verify`；`test/acceptance/phase3.test.ts`：改验收标准 → 门控结果变化；自动审批可追溯。
- **Gate**：通过后进入 Phase 4。
- **Commit**：`chore(phase3): mark phase 3 exit gate passed`

---
## 7. Phase 4：移动端与飞书接入（3 周，Task 4.1 – 4.7）

**前置决策**：§25-D9（Hub 跑在哪台机器）。若选「桌面机」，则本阶段所有远程端在桌面机关机后不可用（规格 §24 风险 10）—— **开工前先确认 D9 已定**。

### Task 4.1　Hub 对外服务与网络边界（2 天）
- **Files**：`src/http/bind.ts`、`src/http/tokens.ts`、`test/http/network-boundary.test.ts`
- **要求**：默认只监听 `127.0.0.1`；对外暴露必须显式开启并打印告警；局域网访问走一次性 token + 请求签名（规格 §20.3）。
- **Test**：默认配置下外部网卡访问失败；token 过期 / 重放被拒；**移动端的批准请求与桌面端走同一套鉴权与审计路径**（不得有第二条更弱的通道）。
- **Commit**：`feat(http): loopback-only default with explicit network opt-in`

### Task 4.2　移动端审批组件复用（2 天）
- **Files**：`packages/mobile/src/pages/MobileInbox.tsx`（**复用 Task 2.6 的 `ApprovalCardView`**）、`packages/mobile/capacitor.config.ts`
- **硬约束（§25-D5 选项 A）**：**移动端本地不落库**、不缓存证据包正文（可缓存摘要）；断网时明确显示不可用，不显示假成功。
- **Test**：审批卡片在窄屏（320px）下参数快照不截断关键信息；断网 → 明确错误态；批准后桌面端看板同步（E2E 覆盖）。
- **Commit**：`feat(mobile): approval flow reusing desktop card components`

### Task 4.3　语音 / 文字扔想法（2 天）
- **Test**：语音输入产出一条 `INSIGHT` 任务并在桌面端可见；输入失败不静默丢弃（必须有可见错误 + 可重试）。
- **Commit**：`feat(mobile): voice and text idea intake`

### Task 4.4　飞书 Channel（3 天）
- **Files**：`src/channels/feishu.ts`、`src/channels/abstraction.ts`、`test/channels/feishu.test.ts`
- **实现**：`@larksuiteoapi/node-sdk` 长连接模式（**无需公网 IP / 回调地址**，规格 §11.2）；卡片推送 + 回调；`ActionSpec` 单一实现源同时驱动 Web 与飞书（规格 §11.3）。
- **Test**：卡片回调 → 图恢复执行（V2 路径）；**同一回调重复投递幂等**（飞书会重投）；Hub 离线期间到达的回调在恢复后能被处理或有明确丢失告警，**不得静默吞掉审批**。
- **验收**：手机收到推送 → 看摘要与参数快照 → 批准 → 桌面看板更新（规格 §23.1 Phase 4 出口标准）。
- **Commit**：`feat(channels): feishu long-connection channel with idempotent callbacks`

### Task 4.5　Channel 抽象层（1 天）
- **要求**：飞书实现必须通过抽象层接口测试（换成 fake channel 全部测试仍通过），为企微 / QQ 留口；**但本期不实现企微 / QQ**（反过度设计：抽象层由一实现验证，不做二实现）。
- **Commit**：`refactor(channels): channel abstraction verified by fake channel`

### Task 4.6　个人微信的显式排除（0.5 天，文档任务）
- **产出**：`docs/decisions/0002-no-personal-wechat.md` —— 记录不接入个人微信的理由（无官方 API、`oicq` 类库自 2022 年停更、封号风险由 CEO 承担），避免未来反复重议。
- **Commit**：`docs(decisions): exclude personal wechat integration`

### Task 4.7　Phase 4 出口门禁（1.5 天）
- **E2E**：`test/e2e/mobile-approval.spec.ts` + 飞书沙箱手工验证记录。
- **Gate**：通过后进入 Phase 5。
- **Commit**：`chore(phase4): mark phase 4 exit gate passed`

---

## 8. Phase 5：Harness Gateway 一期（3 周，Task 5.1 – 5.8）

**接入顺序（规格 §23.3）**：先只接 Claude Code 跑通，再补 Codex / Qoder —— 三家 SDK 能力面不对称，一次接三家会把适配层写成最小公分母。

### Task 5.1　Gateway 接口与能力声明（2 天）
- **Files**：`packages/contracts/src/harness.ts`、`src/harness/gateway.ts`、`src/harness/adapters/claude.ts`、`test/harness/gateway.test.ts`
- **接口（对外只暴露三个方法，规格 §12.3 反过度抽象）**：

```ts
export interface HarnessAdapter {
  readonly id: "claude-code" | "codex" | "qoder";
  readonly capabilities: { budgetHardCap: boolean; toolApproval: boolean; resume: boolean; structuredOutput: boolean };
  execute(req: HarnessRequest, onApproval: ApprovalHandler): AsyncIterable<HarnessEvent>;
  resume(sessionId: string, onApproval: ApprovalHandler): AsyncIterable<HarnessEvent>;
  getCost(sessionId: string): Promise<CostReport>;
}
```

- **要求**：`execute` 的**默认实现走官方 SDK**（V：`@anthropic-ai/claude-agent-sdk` 0.3.318），CLI 只在 SDK 未覆盖能力时使用（规格 §12.1）。
- **Test**：用 fake adapter 跑通 Gateway 全部逻辑（**不依赖任何真实 CLI**）；`capabilities` 与实际调用不符时报错而非静默降级。
- **Commit**：`feat(harness): gateway interface and capability-gated dispatch`

### Task 5.2　四层安全防护与 `forbidden_flags`（2 天）
- **Files**：`src/harness/safety.ts`、`test/harness/safety.test.ts`
- **实现规格 §12.7 的四层**：工具白名单 → 沙箱档位 → 高风险调用暂停并推审批 → 绝对禁止项（`forbidden_flags` 硬拦截）。
- **Test（安全测试必须覆盖绕过尝试）**：
  - 请求参数含 `--dangerously-skip-permissions` / `--no-sandbox` → **拒绝执行并审计**；
  - 岗位书 `forbidden` 中的动作 → Gateway 拒绝，且**运行时参数无法覆盖**（规格 §20.2 权限单调性：只能收窄不能放宽）；
  - 高风险工具调用 → 通过 `onApproval` 暂停（**验证这是 SDK 回调点，不是解析 stdout**，规格 §12.1）；
  - 沙箱档位试图从 `read-only` 提到 `workspace-write` → 拒绝。
- **验收**：任何一次 harness 调用都在 `events` 里留下完整记录（harness 名 + 版本 + 脱敏参数 + session_id + 退出码 + diff 哈希 + 消耗，规格 §12.6 第四层）。
- **Commit**：`feat(harness): four-layer safety with hard forbidden flags`

### Task 5.3　程序员 Agent 任务路由（2 天）
- **Files**：`src/harness/routing.ts`、`test/harness/routing.test.ts`
- **实现规格 §12.5 双轴**：任务类别（功能 / 缺陷 / 重构）× 风险档位 → 决定沙箱档位与审批策略。
- **Test**：缺陷修复走「只读分析 → 复现验证 → 修复 → 测试独立验证 → 上报」五段，**只读段出现写操作即失败**（规格 §12.5）。
- **Commit**：`feat(harness): two-axis task routing for dev agents`

### Task 5.4　测试 Agent 独立验证（2 天）
- **Files**：`src/harness/verifier.ts`、`test/harness/verifier.test.ts`
- **核心约束（规格 §12.4）**：**独立工作区、不复用开发 Agent 的会话与结论**；审阅者模型家族与产出者不同（V6 / 规格 §5.9）。
- **Test**：故意让开发 Agent 谎报「测试通过」→ 测试 Agent 在独立工作区跑出失败 → 门控 reject（规格 §23.1 Phase 1 场景的真实版本）；两次调用使用不同 session 且 `model_family` 不同。
- **Commit**：`feat(harness): independent test agent with isolated workspace`

### Task 5.5　Codex 适配器（2 天）
- **要求**：`@openai/codex-sdk` 0.167.0；优先用其**沙箱双轴**表达 §12.7；结构化输出用 `--output-schema`。
- **Test**：与 Claude 适配器共用同一套 Gateway 契约测试（**能力差异通过可选字段表达，不取最小公分母**，规格 §12.3）。
- **Commit**：`feat(harness): codex adapter`

### Task 5.6　Qoder 适配器（2 天）
- **要求**：`@qoder-ai/qoder-agent-sdk` 1.0.59（其本身构建在 `@modelcontextprotocol/sdk` 上）；注意其 `postinstall` 脚本，CI 需固定并缓存（规格 §12.2 注记）。
- **Test**：同一套契约测试；审批转交宿主路径可用。
- **Commit**：`feat(harness): qoder adapter`

### Task 5.7　联网搜索的三层策略（2 天）
- **Files**：`src/search/policy.ts`、`src/search/mcp.ts`、`test/search/policy.test.ts`
- **实现规格 §13.3**：强制搜索 / 建议搜索 / 禁止搜索；MCP Client 用 `@modelcontextprotocol/sdk`，搜索 MCP Server 写成 Node 包。
- **Test**：被标「强制搜索」的领域若证据包无来源引用 → **门控直接打回**（不是警告）；搜索结果进入证据包并带来源 URL；**技术总监的搜索结论不得直接变成架构决策**，必须落成 ADR 证据（规格 §13.2）。
- **Commit**：`feat(search): three-tier conditional search policy via mcp`

### Task 5.8　Phase 5 出口门禁（1.5 天）
- **E2E**：一个真实缺陷修复任务跑通全链路（规格 §23.1 Phase 5 标准），含 `forbidden_flags` 拦截一次人工尝试。
- **Gate**：通过后进入 Phase 6。
- **Commit**：`chore(phase5): mark phase 5 exit gate passed`

---

## 9. Phase 6：硬化与试运行（2 周，Task 6.1 – 6.6）

### Task 6.1　错误处理与重试（2 天）
- **要求**：节点失败 → 重试（指数退避，上限 3 次）→ 仍失败则升级，**绝不静默停滞**（规格 §23.1 Phase 6）。
- **Test**：注入网络错误 / harness 崩溃 / LLM 超时三类故障，任务要么恢复要么产生 `HeartbeatStalled` + 审批卡片；**不允许出现既无事件也无卡片的状态**（用「遍历所有任务，检查是否有孤儿活跃任务」的巡检测试守）。
- **Commit**：`feat(hub): retry policy and stall detection`

### Task 6.2　审计完整性校验（2 天）
- **Files**：`src/db/integrity.ts`、`test/db/integrity.test.ts`
- **Test**：启动时跑 `PRAGMA integrity_check`（V：实测返回 ok）；尝试篡改 events → 触发器拦截并写安全审计；**回放一致性**：同一任务两次回放输出一致（规格 §24 风险 6）。
- **验收**：`integrity_check` **不得在主线程 / UI 进程执行**（规格附录 C.1 的同步 API 冻结风险）→ 用 `worker_threads` 或独立只读连接，测试断言执行期间写队列仍能提交。
- **Commit**：`feat(db): integrity checks off the hot path`

### Task 6.3　备份与恢复（2 天）
- **Files**：`src/db/backup.ts`、`scripts/restore.md`、`test/db/backup.test.ts`
- **实现**：每日 `VACUUM INTO`（**V8：`node:sqlite` 无 `db.backup()`，这是唯一可用路径**）+ 保留策略 + **恢复演练**。
- **Test**：备份文件可被另一连接打开并通过 `integrity_check`；**从备份恢复后能 `hub resume` 继续跑未完成任务**（端到端，含 V3 语义）；备份期间写入不失败。
- **验收**：备份失败必须告警（备份静默失败等于没有备份）。
- **Commit**：`feat(db): vacuum-into backup with tested restore drill`

### Task 6.4　性能与资源占用（2 天）
- **要求**：心跳调度不得阻塞写队列；FTS 重建（`events_fts rebuild`）在只读连接上跑；事件写入必须走批量事务（V9）。
- **Test（基准测试，设阈值断言）**：
  - 2000 条事件批量事务写入 < 50 ms；
  - 心跳 tick 处理 P95 < 100 ms；
  - 回放搜索 P95 < 500 ms（10 万事件量级，合成数据）；
  - 回放搜索期间写队列提交不被阻塞。
- **Commit**：perf: benchmark thresholds for events, heartbeat and replay search

### Task 6.5　一周试运行（5 天日历）
- **要求**：真实任务连续跑一周；每日巡检异常停滞、预算突破、备份成功。
- **出口标准（规格 §23.1 Phase 6）**：连续一周无任务因未处理异常静默停滞；所有预算突破被处理；能在 5 分钟内通过回放理解任意已完成任务。
- **产出**：`docs/ops/pilot-week-report.md`。
- **Commit**：`chore(ops): pilot week report`

### Task 6.6　文档与收尾（1 天）
- **Files**：`docs/guides/how-to-write-a-charter.md`（岗位书写法）、`docs/guides/delegation-rules.md`、`docs/decisions/` 索引
- **要求**：岗位书写法指南必须含「如何写可机械判定的验收标准」的正反例（这是 §23.2 指出的最大风险）。
- **Commit**：`docs(guides): charter writing and delegation rule guides`

---

## 10. 执行顺序、依赖与决策门

### 10.1 任务依赖（关键路径）

```
0.1 → 0.2 → 0.3(已定案·固化测试) → 0.4a(同事务探针·设计门) → 0.4b → 0.5 → 0.6 → 0.8 → 0.10 → 0.11
                         └→ 0.7 → 0.9(CEO) ──┘
0.11 → 1.1 → 1.2 → 1.3 → 1.4 → 1.8
              └→ 1.5 → 1.6 → 1.7(CEO) → 1.8
1.8 → 2.1 → 2.2 → 2.3 → {2.4, 2.5, 2.6} → 2.7 → 2.8 → 2.9
2.9 → 3.1 → 3.2 → 3.3 → {3.4, 3.5, 3.6} → 3.7 → 3.8
3.8 → 4.1 → 4.2 → {4.3, 4.4} → 4.5 → 4.6 → 4.7        （4.x 与 5.x 可并行）
3.8 → 5.1 → 5.2 → {5.3, 5.4} → {5.5, 5.6} → 5.7 → 5.8
{4.7, 5.8} → 6.1 → {6.2, 6.3, 6.4} → 6.5 → 6.6
```

**可并行的两处**（若只有一人开发则串行，周期即 22 周）：Phase 4 与 Phase 5；Phase 3 内 3.4 / 3.5 / 3.6 三组。

### 10.2 三道决策门（未过不得继续）

| 门 | 位置 | 决策内容 | 未决的后果 |
|---|---|---|---|
| ~~D6~~ **已定案** | Task 0.3 | 已选 **D6-a**（`node:sqlite` + 自研 Saver），见 `docs/decisions/0001-sqlite-driver.md` | 剩余工作是把探针固化成仓库测试；改判仍可行但立即引入 node-gyp 与 MSVC |
| **D7** | Task 0.1 / 0.8 之后 | 编排框架是否需要换成 Mastra 或自研 | 只在 §5.4 五项 PoC 门禁**失败**时触发；本计划已实测四项通过，故默认不换 |
| **D9** | Phase 4 开工前 | Hub 跑在桌面机还是常驻主机 | 决定 Phase 4 全部远程端在桌面关机后是否可用（规格 §24 风险 10） |

### 10.3 两处 CEO 阻塞（提前排入日历）
- **Task 0.9**：所有预设角色的「做完了」定义 —— 这是 Phase 1 的输入，晚了会让 Phase 1 空转。**它由 CI 红灯守住**（Task 0.7 的签字断言测试会一直失败到 CEO 签完），因此不需要人工盯；但也不能为了让 CI 变绿而代写 —— 那样只是把红灯变成了假绿。
- **Task 1.7**：门控行为验收 —— 需要 CEO 真实判断「这套拦截是不是我想要的」。

### 10.4 执行注意事项
1. **git 仓库已在 Task 0.1 建好**（`main` 分支，`user.name/email` 用 `--local` 配置 —— 本机 `$HOME` 未设置，`git config --global` 会报 `fatal: $HOME not set`）。若在新机器上重跑，第一件事仍是 `git init -b main` 加两条 `--local` 配置，外加 `core.autocrlf=false` 与 `core.longpaths=true`。
2. **Node 主版本必须锁死**（Node 24 LTS）。`node:sqlite` 属实验性模块（V8、规格 §24 风险 12），随意升 Node 可能改 API。
3. **`node:sqlite` 只允许出现在 `packages/hub`**（V5/V6 边界 + 规格 §5.6.1），由 Task 0.2 的 lint 与分目录 tsconfig 强制，不靠人自觉。
4. **`interrupt` 检查 `__interrupt__`，不要 try/catch**（V2）—— 这条写错会让审批链路整体失效且不报错。
5. **`SqliteSaver` 用 `fromConnString(path)`，不要传路径给构造函数**（V5）。
6. **禁止在节点内逐条写事件**（V9）：一律 `WriteQueue.tx()` 批量事务，且**每批 ≤ 1000 行**（`BATCH_ROWS`，依据决策文档 §2.2 的绑定参数实测：≥ 8192 个参数仍成功，但未穷尽，不可当作无限）。
7. **测试全部使用桩模型**，不联网不计费；Phase 5 才引入真实 harness，且 E2E 之外仍用 fake adapter。
8. **FTS5 建表必须带 `tokenize = 'trigram'`**（规格附录 C.3），Task 0.5 的中文冒烟测试就是它的活文档。
9. **备份不得调用 `db.backup()`**（V8：该 API 不存在），只用 `VACUUM INTO`。
10. 规格 §25 的 **D1–D5、D8 仍需 CEO 拍板**，但不阻塞本计划的 Phase 0–3；D6 / D9 阻塞，见 §10.2。

### 10.5 反过度设计清单（明确不做）
- 不做多端数据同步（规格 §5.7）；移动端本地不落库。
- 不做 harness 无关的统一抽象层（三家能力不对称，只暴露三个方法）。
- 不引入独立数据库服务、消息中间件、对象存储、外部 KMS（规格 §5.8、§5.10、§20.4）。
- 不引入第二种语言（Rust / Python）；未来需要时用 **MCP 边车**隔离在进程边界外（规格 §5.11）。
- 不在本期做组织级知识库（规格 §24 风险 2：Phase 6 之后的演进方向）。
- Phase 3 之前不做并行分支与动态边（规格 §23.2：先线性跑通，按真实绕行需求再加）。
- 不做 Skills 的远端下载执行（规格 §14.3）。

---

## 11. 自检：计划与规格对照

| 规格章节 | 覆盖任务 |
|---|---|
| §5 技术架构（语言栈 / 进程模型 / 驱动 / 事件总线 / 模型分层 / 制品） | 0.2、0.3、0.4a、0.4b、0.5、0.6、5.7 |
| §6 数据模型与 SQLite | 0.4a、0.4b、0.5、6.2、6.3 |
| §7 状态机 / 预算 / 心跳 | 0.8、1.6、6.1 |
| §8 审阅门控与证据包 | 1.1、1.2、1.3、3.6 |
| §9 审批与策略引擎 | 1.4、1.5、2.6、3.5、4.2、4.4 |
| §10 会议机制 | 0.6（事件）、2.4（卡片）、3.7（子图并行） |
| §11 IM 接入 | 4.1、4.4、4.5、4.6 |
| §12 Harness Gateway 与安全 | 5.1、5.2、5.3、5.4、5.5、5.6 |
| §13 搜索与调研 | 5.7 |
| §14 Skills 集成 | 本期未排任务，理由见本节末尾说明 |
| §15 运营子组织 | 0.8（图结构）、3.7（并行拆解） |
| §16 / §19 前端与风格 | 2.3、2.4、2.5、2.6、2.7、2.8 |
| §17 移动端 | 4.2、4.3 |
| §18 组织图拖拽 | 3.1、3.2、3.3 |
| §20 安全与权限 | 0.7、1.3、2.1、4.1、5.2 |
| §21 成本治理 | 1.6、3.6、5.2（消耗入账） |
| §22 审计与回放 | 0.5、0.6、3.4、6.2 |
| §23 阶段划分 | 本计划 §3–§9 的阶段与周期一一对应 |
| §24 风险 | 见 §13 |
| §25 决策项 | D6 → 0.3；D7 → 10.2；D9 → 4.1 前；其余见 10.4 第 10 条 |
| 附录 B 岗位书 | 0.7、0.9、3.6 |
| 附录 C 建表 / 驱动实测 / 中文检索 | 0.3、0.4a、0.4b、0.5、3.4、6.3 |
| 附录 D 术语 | 计划内术语与规格一致，未新造概念 |

**唯一未在计划中安排任务的能力：Skills 集成层（规格 §14）。** 理由：§14.3 的实现依赖真实 skill 资产与角色蒸馏效果评估，属于**产品效果问题而非工程问题**；过早实现会得到一个没有内容的加载器。建议作为 Phase 6 之后的独立小阶段（估算 1 周：SKILL.md 解析 + zod 校验 + 注入点 + `skill_mounts` 表已随 Task 0.5 建好）。

---

## 12. 风险与对策（本计划新增，规格 §24 之外的排期风险）

| 风险 | 影响 | 对策 |
|---|---|---|
| Task 0.9（CEO 定义验收标准）拖延 | Phase 1 空转 | 提前排日历；允许 Phase 1 的 Task 1.1–1.6 先行（不依赖 CEO 内容） |
| PoC 四项通过但 Phase 0 后期发现新的框架能力缺口（~~含 Task 0.4a 的同事务探针失败~~ —— 该项已于 Task 0.4a 实测排除，见 `decisions/0003`；其余缺口仍需警惕） | 编排返工 | Task 0.8 之后再设一次 D7 复查点（10.2）；届时返工面限于 `src/graph/` |
| 自研 Saver（D6-a）实现受阻 | Phase 0 延期 | 契约测试（Task 0.4b）设计为对 `MemorySaver` 与自研 Saver 双向通过，可**当天切换 D6-b**，不阻塞后续任务 |
| Electron ABI / 原生模块拖慢 CI | 每次升版都要 rebuild | 两道独立守卫：`test/arch/dependency-boundary.test.ts`（Task 0.2）按 package 划界，`desktop`/`web` 永不接触 SQLite；`test/arch/no-native-deps.test.ts`（Task 0.4b 增补）在 hub 内部再切一刀——hub 生产代码只许 `node:sqlite`，出现 `better-sqlite3` 即红。见 V21 |
| 门控测试覆盖率不足导致静默失效 | 核心防线失效 | Task 1.2 把覆盖率阈值写进 vitest config（≥ 95%），CI 强制 |
| 一周试运行暴露大量真实缺陷 | Phase 6 超期 | Task 6.5 明确为 5 天日历且允许滚动；试运行的目的就是把问题暴露在这里 |

---

## 13. 完成之后往哪走（Where to Go When Done）

Phase 6 出口门禁通过后，系统进入**自持运营**状态，工程侧的下一步不再由本计划驱动：

1. **Skills 集成层**（规格 §14，约 1 周）—— 本计划唯一未排任务的能力，理由见 §11 末尾。`skill_mounts` 表已随 Task 0.5 建好，实现时不需要迁移。
2. **组织级知识库**（规格 §24 风险 2）—— Phase 6 之后的演进方向；过早建会得到一个没人维护的仓库。
3. **更多 Channel**（企微 / QQ）—— Task 4.5 的抽象层已用 fake channel 验证，接入只是新增一个实现，不再改架构。
4. **Postgres 迁移路径**（规格 §5.10）—— 只有当单文件 SQLite 成为实际瓶颈时才做；届时按 §5.10 的双写切换步骤，不在本计划内预先实现。
5. **多 CEO / 团队协作**（规格明确排除）—— 本设计是「一人公司」，不做权限树与多人并发编辑。若真要转向团队产品，那是**另立规格**，不是在本计划上追加。

### 执行方式二选一（Execution Handoff）

| 方式 | 适合 | 怎么做 |
|---|---|---|
| **A. 子代理逐任务驱动**（推荐） | 任务边界清晰、想让每个任务独立可验证、主线上下文保持干净 | 用 `subagent-driven-development`：按 §10.1 依赖顺序逐个派发任务，每完成一个任务回收「测试输出 + 验收核对结果」再派下一个 |
| B. 分块顺序执行 | 想在当前会话里连续推进、便于随时插手改方向 | 用 `executing-plans`：从 Task 0.1 起顺序执行，每完成一个 Phase 的出口门禁停下复核 |

两种方式都从 **Task 0.1（`git init` + 把 PoC 固化成仓库测试）** 开始 —— 当前工作区 `D:\item\opc` 下只有 `docs/`，没有代码、没有 git 仓库。
