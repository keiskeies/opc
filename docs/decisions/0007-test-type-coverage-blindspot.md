# 0007　`test/` 不在类型检查覆盖内：静默丢弃的键、恒绿的守卫，以及守卫生效性的自证

- 状态：已接受
- 关联：0006 §6.4（跨文件契约靠注释维持）、0006 §7 第 6 / 9 / 10 条
- 范围：本仓所有测试目录。结论与 Phase 0 的三条出口标准判定互不影响。

## 1. 三条实测，先给数据

### 1.1 LangGraph 对未声明的 state 通道是【静默丢弃】

最小图探针（只声明 `idea` / `current` 两个通道，`invoke` 时额外塞 `currentNode` 与 `bogusKey`）：

```
节点看到的键 = current,idea
state.currentNode = undefined
invoke 未抛错
返回键 = current,idea
返回里的 currentNode = undefined
返回里的 bogusKey = undefined
```

既不报错、不透传、也不进返回值。于是「多写一个 state 键」在运行期【零信号】。

### 1.2 因此，测试里的 6 处 `currentNode: "intake"` 从未生效

`packages/hub/test/graph/e2e-linear.test.ts` 有 5 处、`fixtures/e2e-crash-child.ts` 有 1 处，
把一个并不存在的通道当图 state 字段传进去。判别实验：把 6 处全部删掉，
`e2e-linear.test.ts` 仍然 `Tests 7 passed (7)` —— 它们对断言没有任何贡献，是死输入。

这个名字尤其误导：`tasks` 表确实有 `current_node` 列（`hub status` 就靠它显示「当前节点」），
读测试的人很容易以为图里也有同名通道、进而以为节点知道自己在哪个节点。真实情况是
`src/graph/company.ts` 里根本没有这个词（`git grep` 命中 0 行），`current_node` 是节点自己
用 `UPDATE tasks SET current_node=?` 写进去的。

### 1.3 `tsc -b` 看不见 `test/`，实测 32 个类型错误一直躺着（删死键前是 37）

临时建一份覆盖 `packages/<pkg>/test/**` 的配置跑 `tsc -p`（探针跑完即删，未入仓）：

```
错误条数 = 37
按错误码 = TS2345:13  TS2322:9  TS2532:7  TS2353:5  TS2835:2  TS2556:1
```

【计数更正与归因】上面这份输出是本轮删掉 6 处死输入【之前】抓的，当时 37 个；删完之后
同一个探针是 32 个，少掉的 5 个正好等于 `TS2353`（对象多写了不存在的属性）的全部条数。
也就是说：那 6 处死键里有 5 处在类型层面本来就是非法字段，只是没有任何工具看得见。
于是 §5 里「纳入类型检查到底值不值」不再是推测 —— 它被一次删除动作反向验证过：
删对了字段，工具就该在写下的那一刻拦住。

按文件分布（当前 32 个）：

```
 11  packages/hub/test/db/migrate.test.ts
 10  packages/hub/test/db/schema-0001.test.ts
  7  packages/hub/test/db/write-queue.test.ts
  2  packages/hub/test/checkpoint/saver.contract.test.ts
  1  packages/hub/test/graph/fixtures/e2e-crash-child.ts
  1  test/arch/no-native-deps.test.ts
```

并且【不是本轮引入的】：把那两个相关文件回退到 `87a8ae6`（Task 0.10 的实现提交，早于
本轮）再跑同一个探针，`n=32`、`crash=1`、`native=1` 三个数字一字不差。归因必须回退到
具体历史提交再比对 —— 只看「现在有错」就把账认到自己头上，同样是没验就下结论。

而 `pnpm verify` 一直是全绿的。原因在拓扑：根 `tsconfig.json` 是 solution，只有
`references`（四个包），每个包的 `include` 只有 `src/**`，没有任何工程把 `test/` 纳入。
所以这不是配置疏漏的偶发问题，而是当前拓扑下 `test/` 整体不参与类型检查。

这条解释了本会话里我已经踩了四次的同一个坑：`tsc -b` exit 0 但测试文件是坏的
（三次 `import` 路径凭记忆写错、一次 JSDoc 里的 glob 提前闭合注释块）。
它们都不会被 `verify` 拦下，只有 `biome check` 与 `vitest` 看得见。

## 2. 边界：类型检查【也】抓不到 Phase 0 那条审计缺口

必须把两件事分开，否则会用错工具：

- `currentNode` 这类【多余键】是类型问题：若 `test/` 参与检查，`TS2353`（多余属性）会当场报。
  实测分布里确实有 `TS2353:5`。
- `events.state_snapshot` 全库 0/14 是【需求缺口】，不是类型错误：`recorder.ts` 的
  `stateSnapshot` 本来就是可选参数，不传完全合法，类型系统对「该传没传」一无所知。
  只有断言能抓，而计划里没有任何一条任务的验收标准提到它（见 Phase 0 出口门禁汇报）。

所以「把 `test/` 纳入 `tsc`」值得做，但它不会替你回答「需求实现全不全」。

## 3. 本轮已落地（刻意不扩大范围）

已做：删掉 6 处死输入；在 `fixtures/e2e-crash-child.ts` 的 `input` 上方留下防复发的说明；
在 `e2e-linear.test.ts` 增加 4 条守卫断言（251 → 含 4 条新断言，全量 `pnpm verify` 全绿）。

未做（留给 §5 决策）：把 `test/` 纳入类型检查 —— 那要先清 32 个既有类型错误（跨
  `db/`、`checkpoint/` 等测试）再谈；属于独立工程，不该夹在出口门禁里顺手改。

## 4. 本节真正的结论：守卫必须【自证有效性】

第一版守卫长这样：一条扫描 + 一条「检查守卫自己有没有把键名写成整串字面量」的元断言。
元断言听起来很稳妥，实测它【不提供任何保护】：

| 变异 | 结果 |
| --- | --- |
| M1 把扫描用的键名值改错（`current` + `Zed`） | `Tests 11 passed` 全绿 |
| M2 键名值错，同时把真违规塞回调用点 | `Tests 11 passed` 全绿 |
| M3 把键名写成整串字面量（值不变） | `Tests 11 passed` 全绿 |

M1/M2 说明扫描静默失效时，扫描断言自己永远「绿」；M3 说明我原先给元断言写的理由
（「写成整串会命中自己，所以会红」）是错的 —— 命中需要「键名 + 冒号」的形状，
声明行是 `键名 = "…";`，扫不到自己。一次都没被证伪的推理，就是我以为成立而其实没验的推理。

重写后的形状：把扫描逻辑提成纯函数 `findDeadKeyLines(text, key)`，然后【种一个真违规】要求
它必须被抓到，再【种一句注释】要求它不被误判。重跑的变异电池 5 条全部被杀：

| 变异 | 被谁杀 |
| --- | --- |
| G-A 死键塞回真实调用点 | 扫描断言 |
| G-D 键名值改错（上一版静默失效的场景） | 「扫描器能抓到种下的违规」 |
| G-G 扫描器短路返回空数组 | 「扫描器能抓到种下的违规」 |
| G-E 把注释豁免改成永不匹配（等价变异） | 扫描断言 + 「扫描器不把注释当违规」两条同时红 |
| G-F 通道清单少一项 | 「通道清单与 src 的 Annotation.Root 同步」 |

补注 G-E 的方法学：先前我把它写成「删掉那段 filter」，跑出来是 `Tests no tests` ——
语法被破坏，按规矩既不算杀死也不算存活（0006 §7 第 3 条）。换成语法合法的等价变异
（三个豁免前缀改成永不匹配的字符串）之后才拿到有效结论。

规矩（适用本仓一切检测类测试）：

> 一个负责「发现 X」的守卫，必须内建一个人工构造的 X 并要求它被发现。
> 只断言「现在没查到东西」的守卫，其失效方式与「恒真」不可区分。

`production-deps.test.ts` 里的 `expect(seen.size).toBeGreaterThan(3)`（0006 §6.1 第 2 条）
就是这个规矩的雏形，本节把它一般化。

## 5. 留给 CEO 的一项决定

要不要把 `test/` 纳入 `tsc`，并让它进 `pnpm verify`。给全成本，不替你决定：

- 收益：`currentNode` 这一整类死输入在写下的那一刻就红；`import` 路径写错也不再需要靠
  `vitest` 的 `Tests no tests` 事后暴露。
- 成本：先清 32 个既有错误（数字与依据见 §1.3 的【计数更正】）。真实根因写在下面的
  【撤回】块里，其修法与「新增一份工程配置」是两件独立的事，不要混成一个任务。
  其余分布：`TS2532:7`（缺类型收窄）、`TS2322:9`、`TS2835:2`（相对导入缺 `.js`
  扩展名）、`TS2556:1`。数小时量级。

> 【撤回】本节初稿对 `TS2345` 的根因写过一句猜测：「`Db` 类型不匹配，多半是 `openDb`
> 返回类型与 `DatabaseSync` 的别名/包装不一致」。**这句未经任何验证，而且是错的**：
> `driver.ts:30` 的签名就是 `openDb(path: string): DatabaseSync`，既没有别名也没有包装层。
> 实测真因是测试侧自己手写了三份互不相同的 `type Db` 桩 ——
> `driver-preflight.test.ts:17` 用 `InstanceType<typeof import(...)[DatabaseSync]>`，
> 而 `migrate.test.ts:17` 与 `schema-0001.test.ts:19` 各写了一份结构体桩，于是传给要
> 真 `DatabaseSync` 的函数时报 missing the following properties: aggregate,
> loadExtension, enableLoadExtension 等。修法是把三份桩收敛成一处（或直接删掉、用真实
> 类型），与新增工程配置无关。
> 留【撤回】而不是静默改掉，是因为本节已随 `d686087` 之后的提交入档；静默删会让下一次
> 复盘看不见「一句没验的猜测是怎么混进决策文档的」。这正是 0006 §7 第 10 条说的毛病，
> 而它是在写下那条规矩的同一轮里发生的。
- 风险：`noEmit` 的工程一旦进 `composite` solution，`references` 图要重排，构建可能
  被拖慢；且 `test/` 引用的构建产物路径（迁移 SQL 等）需要在类型层声明。

我的建议：值得做，但作为独立任务排在 Phase 1 开头，而不是塞进出口门禁。

## 6. 把同一把尺子用到既有断言上（出口标准第 2 条）

§4 的规矩不该只约束新写的守卫。出口门禁第 2 条「中途打断并从 Checkpoint 恢复」我判为绿，
依据一直是 `test/poc/resume.test.ts` 的门禁 #2；但那份信心来自【我读了代码觉得它成立】，
按本节 §4 的标准，那正是「未经证伪的推理」。补做的变异实验：

| 变异（改的是恢复子进程 `poc-resume.mjs`） | 结果 |
| --- | --- |
| R-1 `resumedNext` 硬编码空数组 | 红：`expected [] to deeply equal [ 'approval' ]` |
| R-2 `resumedTrail` 硬编码空数组 | 红：`expected [] to deeply equal [ 'producer', … ]` |
| R-3 用不存在的 `thread_id` 读 state | 红（同 R-1 的形状） |
| R-4 恢复时不带 `resume`，直接空输入 invoke | 红：轨迹少了审批之后的推进 |

R-2 是这组里唯一真正要紧的一条：`resumedTrail` 取自 `before.values.trail`，也就是
**checkpoint 里存的值**，而不是新进程重跑出来的东西。所以它存在一个理论上的假绿形状 ——
万一新进程什么都没恢复出来、而 `phase1.trail` 恰好也是空，就会「空 === 空」恒绿。
实测否掉了这个形状：`phase1.trail` 有 5 个元素，把它换成空数组立刻红。

同一个文件里还有一条形状更可疑的断言：反例守卫断言【坏行为确实发生】
（重复 `invoke` 会重放已完成节点，用 `toBeGreaterThan(1)` 期望重放）。
它是「恢复必须走 `Command`」这条结论的唯一证据。也补了变异：

| 变异（改 `poc-double-invoke.mjs`） | 结果 |
| --- | --- |
| D-1 把错误用法换成【正确】的 `Command resume` | 红：`expected 0 to be greater than 1` |
| D-2 压根不再 invoke，只读 state | 红：同上 |

D-1 的红必须由断言产生而不是缺 import 报 `ReferenceError` —— 已核对子进程第 3 行确实
`import { Command }`，所以它是「用法正确 ⇒ 重放消失」的有效证据。

结论：6 个变异全部被杀，出口标准第 2 条的绿【成立】，且现在是证据而不是判断。
本节记录的是方法而不是结论 —— 一条断言「看起来很强」和「确实很强」之间，差的就是一次变异。

## 7. 本节不含的东西

审计日志缺少节点输入输出 / `state_snapshot` 的缺口【不在本节】，它是出口标准第 3 条，
单独写在 Phase 0 门禁汇报里待裁决。两者只是「测试没抓到」这件事的两个不同侧面，
不要用本节结论去暗示那条缺口可以靠类型检查解决 —— 见 §2。
