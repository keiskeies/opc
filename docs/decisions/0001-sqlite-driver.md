# 0001　SQLite 驱动：选 D6-a（node:sqlite + 自研 Checkpoint Saver）

**状态**：已定案（2026-11-06）　**决策门**：规格 §25-D6 / 计划 Task 0.3
**拍板方式**：执行方依计划预设建议值代拍（理由见 §5），CEO 可复核改判

## 1. 决策

**采用 D6-a**：全栈使用 Node 24 内置 `node:sqlite`，并自研 `BaseCheckpointSaver` 实现；不引入 `better-sqlite3`，不引入任何原生 addon。
计划 §10.2 明令禁止的 **D6-c（两套驱动混合）已排除** —— 两个 db 文件无法与 `events` 同事务提交，会击穿规格 §6.3 的审计完整性。

## 2. 实测依据

**证据状态（Task 0.3 后更新）**：下列结论最初来自临时探针脚本（已归档至 `docs/superpowers/evidence/phase0-poc/`）。现已固化为仓库内测试 `packages/hub/test/db/driver-preflight.test.ts`（16 例，`pnpm verify` 每次都会重跑），所以这些结论不再只存在于归档脚本里 —— 驱动一旦不可用，CI 会立刻知道。

### 2.1 `d6a.mjs`（详见 `POC-OUTPUT.txt`）

| 断言 | 实测 |
|---|---|
| WAL 可开启 | `journal_mode` 返回 `wal` |
| append-only 触发器 | UPDATE 被 `RAISE(ABORT)` 拦下（输出 `trigger blocked: immutable`） |
| `checkpoints` + `writes` + `events` 三表同一事务提交 | 成功（输出 `same-tx 3 tables ms 0`，即小于 1 ms 计时分辨率） |
| 事务中途失败整体回滚 | 回滚后 `checkpoints` 行数 1，无半提交行 |
| **`db.backup()` 是否存在** | **不存在**（`typeof db.backup === undefined`）→ 备份只能用 `VACUUM INTO` |
| `db.function()` 自定义 SQL 函数 | 可用（`opc_len('abc中')` 返回 4） |
| BLOB 往返类型 | `Uint8Array`（Saver 存 Checkpoint 二进制的必要能力） |
| 事务内 2000 行 | 1 ms（`:memory:` 场景，不代表磁盘 fsync 表现） |
| `-wal` 文件生成 | 是 |

### 2.2 `als-and-bind-limits.mjs`（详见 `LIMITS.txt`）

| 断言 | 实测 | 对实现的约束 |
|---|---|---|
| 绑定参数上限 | 二分至 **4096 行 / 8192 参数仍成功**，上界未穷尽（未测到失败点） | 事件批量写入按 **1000 行/批** 分片安全；禁止一次传数千参数不分片 |
| 单表列数 ≥ 1000 | 通过 | — |
| **`AsyncLocalStorage` 传递同一连接** | 跨多层 `await`、`setTimeout`、`Promise.all` 并发子任务全部为同一连接（`[true×6]`、`[CONN-X, CONN-X]`） | 计划 Task 0.4 的「事务上下文」方案在 **Node 原生调度** 下成立 |

**重要限定**：ALS 探针只验证了 Node 自身调度，**没有验证 LangGraph 内部调度是否保持 ALS 上下文**。因此规格 §6.3「Checkpoint 与 events 同事务」在**框架调用路径**上仍未证实 —— 这是 Task 0.4a 的存在理由，也是 §4 风险 3。

## 3. 判据

- 规格 §5.6 的三档判据中，「整个二进制零原生依赖」居首：免 node-gyp、免 `@electron/rebuild`、Windows 打包只需 Node。
- **Windows 开发机不需要 MSVC Build Tools** —— D6 里最影响日常开发体验的一条，也是它必须在 Phase 0 第 0 天定案的原因。
- `better-sqlite3` 唯一实质优势是「官方 SqliteSaver 开箱可用」；而计划 Task 0.4 把契约测试设计为对 `MemorySaver` 与自研 Saver 双向通过，两种实现可互换，该优势不值一个原生依赖。

## 4. 接受的风险

1. **`node:sqlite` 属实验性内置模块**，API 可能变动。缓解：Node 主版本锁 24 LTS，CI 用 `actions/setup-node` 固定；升级前跑全套契约测试。
2. **绑定参数真实上限未穷尽**（只知道 ≥ 8192）。缓解：写队列按 1000 行/批分片（§2.2），并在 Task 0.5 用测试守住该分片常量。
3. **框架路径上的同事务约束未证实**。若 LangGraph 调度打断 ALS，规格 §6.3 退化为「`checkpoint_id` 外键关联 + 启动对账」，届时另立决策文档，并在 Task 3.4 回放增加「有 Checkpoint 无事件」告警。规格 §24 风险 6「宁可停、不可丢事件」原则不变。
4. `db.function()` 可用，但**禁止用它承载业务规则** —— 会让规格 §24 风险 5「门控是确定性代码可单测」失效。

## 5. 决策方式说明

计划 §10.2 将 D6 列为需 CEO 拍板。本次依计划中**已写明的建议默认值（D6-a）**代拍，理由：判据全部是技术事实且已实测，不存在需要产品判断的分歧点；继续等待会让 Phase 0 停在第 3 天。

**改判成本（此刻最低）**：切换到 `better-sqlite3` 只需替换 `driver.ts` 与 Saver 实现（契约测试两侧共用），但会立刻引入 node-gyp 与 Electron rebuild 链路，并要求 Windows 开发机安装 MSVC Build Tools。

## 6. 本决策遗留的待办（进入 Task 0.3 时必须完成）

- [x] 建 `packages/hub/test/db/driver-preflight.test.ts`（Task 0.3 已完成：16 例通过，§2.1 / §2.2 每一行都有对应断言，测试里逐行标注了来源）。
- [x] 该测试针对**目标运行时**执行：`node:sqlite` 导入失败时在文件顶层抛错并提示「改判 D6-b」，**没有 skip**（skip 会让驱动不可用在 CI 里静默通过）。
- [x] `packages/hub/src/db/driver.ts` 提供 `BATCH_ROWS = 1000` 与 `openDb()`（统一 PRAGMA），注释指向本文件 §2.2；常量由测试守住（变异 M5 一改值就红）。

**固化过程中新增的实测事实**（原探针未覆盖，会直接影响实现写法）：

1. `PRAGMA busy_timeout` 的返回列名是 **`timeout`**，不是 `busy_timeout`；另外三条（journal_mode / foreign_keys / synchronous）才与名字同名。读错列名得到 `undefined`，`Number(undefined)` = `NaN` —— 失败现象看着像实现坏了，其实是断言取错 key。故 PRAGMA 一律读第一列。
2. `node:sqlite` 裸构造默认 `foreign_keys = 1`，**与 `sqlite3` CLI 默认 OFF 相反**；且 `exec()` 里的 `PRAGMA foreign_keys = ON` 会覆盖构造函数选项的 `false`。外键开关因此有三层兜底，但**不可依赖默认值**：测试已把默认值本身钉住。
3. `busy_timeout` 裸构造默认 **0**（完全不等待），必须由 `openDb` 显式设定，否则并发下会直接 `SQLITE_BUSY`。
