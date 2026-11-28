# 0087 · 成员档案有两枚钟：一枚代码从没写过，一枚界面从没读过（注释还替它作了证）

## 1. 一句话

契约的 `memberViewSchema` 一直带着两枚时刻（`packages/contracts/src/member.ts:205` 的 `hired_at`、`packages/contracts/src/member.ts:206` 的 `updated_at`）。`updated_at` 并非没人写——改档案走 `UPDATE_MEMBER_SQL`，末尾就挂着 `updated_at = ?`（`packages/hub/src/members/service.ts:253`）；可 0081 给成员设置面板装上技能/执行器挂载编辑器之后（挂载是档案的一部分），那条路径从头到尾没碰过这枚钟——0081 台账通篇 `updated_at` 出现 **0 次**。于是 HEAD 的行为是：改名字「最近更新」会前进，换技能不会。另一枚更干脆：详情 `memberDetail`（`packages/web/public/group.js:6604`）渲染了角色、模型、人设、音色，唯独两枚时刻一个字都不读。本轮补两侧：服务端在挂载真的变了时把钟推上去（加钟语句 `packages/hub/src/members/service.ts:257`、原语 `packages/hub/src/members/service.ts:491`、技能判定 `packages/hub/src/members/service.ts:865`、执行器判定 `packages/hub/src/members/service.ts:936`），详情补「入职于 / 最近更新」两行（`packages/web/public/group.js:6653`、`packages/web/public/group.js:6655`）。

## 2. 复算：这一格是怎么被指出来的

还是响应侧轴（`.workbuddy/round406-response-zero-read.mjs`，0086 §2 立的那根）：契约 `*ViewSchema` 字段在两个入口页里**零字面出现** ⇒ 服务端算了、界面从不读。正控制本轮复算仍是 **30 个 schema / 226 个字段**；候选从 0086 收尾时的 **15** 降到落地后的 **14**，少的正是 `member.ts :: memberViewSchema :: hired_at`——0086 §2 表尾四枚真候选之一，这轮把它做掉了，尺子对自己改的东西有反应。

⚠ 这根尺子的两个已知脾性，本轮又各兑现一次，写清楚免得下轮当新坑踩：

1. **零出现是必要条件，出现不是充分条件**。`updated_at` 压根不在候选名单里——它在 HEAD 的 group.js 里字面出现 7 次，可那 7 处全读的是文档与待办的 `updated_at`，成员详情一处没读。字面出现替它「作伪证」，成员这格靠的不是扫描器，是 §3 那句注释与 §1 那条不对称。扫描器负责撒网，判定永远是人工的。
2. 剩余 14 条的人工 triage：`imBindingViewSchema` 四条与 `dispatchRuleViewSchema` 三条仍随其所在【排期】页面走（名册在册，0086 §2 已逐条对过）；`turn_id` / `card_id` / `buttons` / `input_schema_json` 是内部主键与无落点字段；真候选剩 **3 枚**：`assetViewSchema :: size_bytes`、`groupMemberViewSchema :: joined_at`、`pluginViewSchema :: installed_at`——与 `hired_at` 同形（一行元数据），下轮按「同区块已渲染字段里有没有它这一类」再判。

## 3. 那行注释在替一件没发生的事作证

HEAD 的 `setMemberSkills` 文档注释写着：「挂载替换不影响 members 行的 updated_at？**影响**：updated_at 语义是『这个成员的档案最后一次变』」——而整个函数没有任何一条语句写这一列。这不是「还没想到要做」，是**注释主张了代码没做的事**：拿一段自洽的注释当已完成，比空白更贵。全仓与它对照的正是 §1 的 `UPDATE_MEMBER_SQL`：改档案真写钟，改挂载不写——同一个「档案」，两套口径。

加钟的判定复用 0081 已经立住的「同值写不记台账」：台账（`appendHireEvent`）只在最终形状变了时记一条，钟走**同一个判定**（0067 §5b：「随写而变」的字段要有正向断言承重）。形状比较是 `skillsKey`（`packages/hub/src/members/service.ts:542`）与 `executorsKey`（`packages/hub/src/members/service.ts:550`）——排序后的规范串，整删整插本身不算变更，只有最终集合/顺序/enabled 变了才算（U5 专钉这一点）。

顺序上有三处刻意的：**守卫在前**（`assertSingleStatement` / `assertParamCount` 在任何写之前）、**加钟在重读视图之前**（`let after = mustView(...)` 在加钟后重取一次，台账与审计的 `after` 读到的必须是加钟后的那一枚）、**时刻用外面传进来的 `nowMs`**（钟与台账、审计同源，不在函数中段各取一次 `Date.now()`）。

## 4. 落地

- 服务端 +20 行：加钟原语（语句 + 守卫 + 单条 UPDATE，只推 `updated_at`，档案数据列一个字节不动——数据列由整删整插自己写）；技能与执行器两条分支各接一处形态判定。无新契约字段、无新迁移、无新 CSS。
- 渲染 +4 行：`memberDetail` 的 `dl` 末尾追加「入职于 / 最近更新」两对 `dt`/`dd`，复用 `fmtDateTime`（`packages/web/public/group.js:80`）。两列都是 NOT NULL（`packages/hub/resources/migrations/0013_members.sql:30`），不另设 null 挡。

## 5. 判据：五发单测 + 一条九段线，每根判自己那一次动作

单测（`packages/hub/test/members/service.test.ts`）：

| 发 | 判据 |
| --- | --- |
| U1（`packages/hub/test/members/service.test.ts:675`） | 换技能 ⇒ `updated_at` 前进到**本次 nowMs**——视图、裸列、返回体三处读数都钉这一枚；`hired_at` 纹丝不动 |
| U2（`packages/hub/test/members/service.test.ts:691`） | 同一份技能列表再存一次 ⇒ 档案没变 ⇒ 钟也不许动 |
| U3（`packages/hub/test/members/service.test.ts:721`） | 被守卫拒掉的挂载（重复技能 / 空执行器链）⇒ 钟不前进、也不留下半次写 |
| U4（`packages/hub/test/members/service.test.ts:753`） | 执行器与技能同形：换一档前进、原样再存不动 |
| U5（`packages/hub/test/members/service.test.ts:786`） | 旧形态反证：整删整插本身不算变更——只改 enabled 才算 |

e2e 一发（`test/e2e/group-workbench.spec.ts:4746`），全程真 UI、九个分段各判各的动作：

| 线 | 判据 | 位置 |
| --- | --- | --- |
| 1 | 「入职于 / 最近更新」两行进结论区（`dt` 列表逐项相等） | `test/e2e/group-workbench.spec.ts:4888` |
| 2 | 行内时刻 == `fmtDateTime(服务端那一枚 epoch)` 的同一个字符串 | `test/e2e/group-workbench.spec.ts:4897` |
| 3 | 真 UI 换技能 ⇒ 返回体 `updated_at` 前进 | `test/e2e/group-workbench.spec.ts:4902` |
| 3b | 保存后**不整页重载**，详情自己也带上新钟 | `test/e2e/group-workbench.spec.ts:4928` |
| 4 | 摘一行技能也算变更：响应体 + 卡片 `.skill-row` 计数 3→2 各半发 | `test/e2e/group-workbench.spec.ts:4935`、DOM 半发 `test/e2e/group-workbench.spec.ts:4962` |
| 5 | 同一份档案再存一次 ⇒ 不算变更 ⇒ 钟不许动（与 U2 同一把尺） | `test/e2e/group-workbench.spec.ts:4964` |
| 6 | 执行器那一支同形：前进 + 原样再存不动 | `test/e2e/group-workbench.spec.ts:4978` |
| 7 | 整页重载后界面读的是最新那一枚 | `test/e2e/group-workbench.spec.ts:5005`（守卫线，见 §6） |
| 8 | 执行器保存回调自己那一次重载 | `test/e2e/group-workbench.spec.ts:5013` |

两处口径先于判据本身：

- **SSE 掐断**（`test/e2e/group-workbench.spec.ts:4756`）：服务端每次挂载变更都发 `MemberUpdated`，客户端收到就 `refreshAll()`——一条与保存回调并行的拉新路径。不掐，线 3b/8 的「不重载」判据会假绿，线 8 永远没有自己的目击者。回一发**立刻结束的空流**而不是 abort：链接语义保持成立，只是没有事件。
- **尺子自证**（`test/e2e/group-workbench.spec.ts:4880` 的 `settlePastSecond`，1100ms）：`fmtDateTime` 只到秒，本机跑得快时「入职」与「换技能」可以落进同一秒，那一刻读对列与读错列渲染出**同一个字符串**。等过被测对象的分辨率，再用 `expect(fmt(a)).not.toBe(fmt(b))` 把「这把尺此刻分得开」钉成断言——机器再快一档时它先红，而不是让线 2/3b 静默退化成永真。

## 6. 变异机：20 根真线 + 1 控制组，逐线点名各有目击者

`.workbuddy/round407-wire-mutations.mjs`，剪线跨两文件（服务端 `packages/hub/src/members/service.ts`、渲染 `packages/web/public/group.js`），锚点各命中 1 次、真抹字节、sha256 自还原。

- **服务端侧的剪线跑两把尺**（M1/M2/M9 在**同一份变异字节**上先后过单测与 e2e）：单测报「哪些单测红」，e2e 停在它撞到的**第一根线**——playwright 遇红即停的行为天然替最早被违反的线作证。于是 M1（技能分支压根不加钟）同时点名 U1/U2 与**线 3**、M9（判定恒真、同值写也加钟）点名 U2 与**线 5**、M2（执行器分支不加钟）点名 U4/U5 与**线 6**。上一轮没有这层设计时，机头逐线点名报「线 3/5/6 无人剪过」——不是判据够不着，是变异机的**汇报口径**够不着：单测尺子红了 e2e 的线，归因表却不认识。
- 渲染侧：M10/M11 摘两格 ⇒ 线 1；M12 把「最近更新」读成入职钟 ⇒ 线 3b；M13/M14 时刻退化成只到日 ⇒ 线 2；M15/M16/M21 分别摘掉技能保存、执行器保存、删除技能三处回调里的重载 ⇒ 线 3b、线 8、线 4 的 DOM 半发。
- 守卫侧：M18/M19 摘掉重复技能、空执行器链两道守卫 ⇒ U3（主键 `packages/hub/resources/migrations/0013_members.sql:54` 撞库当场抛）。
- 时刻侧：M20 技能分支写成 `nowMs+1` ⇒ U1 的三处读数都钉具体钟，当场红。
- M17 控制组（空态说明文案改掉）如预期 SURVIVED。
- **线 7 是声明的守卫线**：它唯一的接线是应用启动时那次全局初始拉取——剪掉它必然先把线 1 一起剪死，专属变异体在结构上不存在。机头注释点名声明，逐线点名以 ◆ 列出、不计入「无目击者的线」。
- 新增一台硬门：**KILLED 但归因「未归类」⇒ 当场停机**——语法被剪坏的变异体也会「红」，那种红没有判定价值，混进 20/20 就是自欺。

结果：**20/20 KILLED**、控制组如预期活、13 根线各有目击者（含双尺代打）、两文件收尾 SHA 与开工逐字节一致。

## 7. 红探针与坐标

- **红探针在最终测试字节上复取**：把 `service.ts` 与 `group.js` 一起退回 `git show HEAD:` 字节——单测 exit=1、失败 **4** 发（U1/U2/U4/U5；U3 的两道守卫 HEAD 就有，不红是预期）；e2e exit=1、红在 `test/e2e/group-workbench.spec.ts:4888`（线 1 的 `dt` 计数）。还原按 sha256 前缀 `6cb6b25ba20b81e6`（service.ts）与 sha256 前缀 `defaaaca8718fc51`（group.js）与剪线前逐字节一致。⚠ 第一发探针把「红行」报成了测试声明行那一处坐标——e2e 失败输出里声明行与断言行同时出现，取首个坐标就取了声明行；坐标要取**断言**那一行。
- **重钉**（`.workbuddy/round407-repin.mjs`，门 0 整文件映射自证 / 门 0.5 改写行点名交人 / 门 1 键集合等势）：
  - `service.ts`：`wc -l` 1053 → **1073**（+24 −4，净 +20）。HEAD 侧整面 **6 处 / 2 个不同行号**（265→268、897→915），无碰撞；被改写的四行（HEAD 813/814/848/917）在坐标面**零落点**，门 0.5 空手放行——这是它该有的样子，不是它没工作。
  - `group.js`：`wc -l` 9740 → **9744**（纯追加）。HEAD 侧整面 **228 处 / 91 个不同行号**，其中 **66 处 / 50 个**落在 6652 之后需要搬（6837+4 起、至 9343+4），无碰撞。⚠ 草稿把手写管道里的计数当成了 105 个不同——`sed 's/.*://'` 在无行号后缀的行上会把整条路径当输出，面就虚增；复算改用 `git grep -ohE` 两侧各数一遍才拿到 91。**计数当输入用之前，先复算计数本身**（「恒 0 是没量到」的镜像：虚增也是没量到）。
  - spec 新用例追加在文件末尾 ⇒ 既有 `spec.ts` 键零受累。
- **SNAP**：新 **36 键**（台账 33 + INDEX 入口行 3），合计 **498 键 / 0 重复**，全部由 `.workbuddy/round407-snap-append.mjs` 按目标行 `.trim()` 原文生成、不手抄；台账里引用 0067 只写章节号、HEAD 旧注释只写「旧 813 行」，都不带路径——复述裸坐标等于凭空造引用。⚠ 台账初稿把键数写成 42/504（按「应该有哪几枚」心算的），落盘后机械数是 36/498：差的是我打算引用却最终没写成坐标形态的那几处。**计数以落盘后的机械复算为准，不以草稿的预期为准。**

## 8. 记下来但没动的

- 时长派生值（入职至今多久 / 距上次更新几天）没有渲染：它是算出来的，不是「服务端算了界面不读」，要不要显示属信息密度口径。
- M20（写错一枚具体的钟）没有在执行器侧重复一发：两侧字节同形，U4 的读数断言已经为那一侧站过岗，再来一发只是给变异机凑数。
- 响应侧扫描仍不立门禁：它判的是必要条件，每轮都要人工 triage；立进门禁只会把「判定」冻成「噪声」。
- §2 剩余三枚真候选（`size_bytes` / `joined_at` / `installed_at`）留在候选池。

## 9. 实跑读数

以下读数对应的字节 = 最终提交字节（文档与 SNAP 定稿后，守卫与全量都在其上重跑过）：

- 红探针对 HEAD 版两文件：单测 4 failed、e2e 红在线 1 的 `dt` 计数断言，还原 SHA 逐字节一致；
- 变异机：预热全绿；**20/20 KILLED** + 控制组如预期活 + 逐线点名 13/13（含 1 根声明守卫线）；两文件收尾 SHA 两侧一致；
- 重钉：门 0 / 门 0.5 / 门 1 如上，共搬 **72 处**（service.ts 6 + group.js 66）；SNAP **504 键 / 0 重复**；
- 全量 vitest **205 files / 4246 passed | 6 skipped**（本轮净 +5 发单测）；全量 e2e **72 passed**（71 → 72）；
- `tsc -b` + `tsc -p tsconfig.test.json --noEmit` 双双 exit 0；`pnpm lint` **exit 0 / 0 error**、warnings **106**——与基线**持平、0 增量**（机械核对：本轮 36 枚新 SNAP 键值没有一枚含 `${`，所以 0086 那种「守卫自身键值触发 `noTemplateCurlyInString`」的增量这轮压根不存在；写台账时我先按上一轮形状预期了「+3」，机械数是 +0，**照抄上轮预期与心算同罪**）；
- `docs/review/check-gate.mjs`「判不了或不符的项：**0**」、`node docs/review/verify-open-invariants.mjs` **SUCCESS**；
- 台账、INDEX、spec、doc-refs 四文件 U+FFFD **0**。
