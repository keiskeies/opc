# 0080 · 待办栏的「按群筛」在服务端早就认、界面上压根没有 —— 两群混成一锅，只能靠标题猜

**日期。** 2026-11-28（round396）。
**落地。** `packages/web/public/group.js`：`state.backlogFilter` 从裸字符串升格为与 `docFilter`
同形的 `{ q, group }`（`packages/web/public/group.js:609`），`renderBacklogList` 在搜索框之后
追加一枚「所属群」下拉（`packages/web/public/group.js:1675`），`paintBacklogRows` 的谓词改成
两维 AND（`packages/web/public/group.js:1701`）；服务端零改动 —— `group_id` 本来就认。守卫
`test/web/list-filter-repaint.test.ts` 的待办 vm 一发扩成群+词双维（含节点同一性），paint
计数一发由「一个待办 handler」改钉「两个」；新链路用例 `test/e2e/group-workbench.spec.ts` +1
（8 根线：下拉存在且只有一份 / 关键词与群 AND / 换群不换掉正在用的搜索框 / 清词后群维度单独
生效 / 换回全部 / 只筛群不筛字 / 控件不累加 / 切栏回来仍一份）；证据
`.workbuddy/round396-wire-mutations.mjs`（变异机 7 发全红、逐发按 sha256 自还原）。

## 1. 一句话

待办栏列的是**全部群**的条目，界面上却只有一枚关键词框 —— `git show HEAD:packages/web/public/group.js`
里 `state.backlogFilter` 是一个裸字符串（`:607`），`paintBacklogRows` 的谓词只比 `item.title`。
服务端那一头早就把门开着：契约 `packages/contracts/src/backlog.ts:115` 的列表查询里
`group_id` 是 optional，HTTP `packages/hub/src/http/work.ts:113` 把 `req.query` 整个递进
`listBacklog`，SQL `packages/hub/src/backlog/service.ts:90` 是 `(? IS NULL OR group_id = ?)`。
也就是说「这个群的待办有哪几条」在服务端是一发合法请求就能答的问题，在界面上没有任何落点 ——
用户想知道甲群的待办，只能往关键词里敲群名赌标题撞词。这正是 0079 §7 最后一条白纸黑字记下的
那个功能缺口：「真要补的是待办的『按群筛』，那是功能缺口不是本轮形状」。

## 2. 为什么静默：断点两侧的每一层都「合法」

和 0077 的游标、0079 的清空同一族病：**不传 `group_id` 走 `(? IS NULL OR group_id = ?)` 恒真
= 完全合法的「拿全部」**。服务端不响（参数可选是契约），界面不响（它只画自己拿到的那一锅），
e2e 不响（既有的待办用例都在全量态断言内容，从没写过第二群），守卫不响（`state.backlogFilter`
是字符串还是对象，源扫描守卫从来不看这一格）。四层的「没反应」叠起来，缺口的表现和「这些待办
本来就都是这个群的」逐像素相同 —— 只有真建出两个群、往各自灌条目，混排才现形。

红探针就是照这个建的（`.workbuddy/round396-red-probe.log`）：两个 UI 群 + 16 条甲群待办 +
4 条乙群待办，`#listToolbar select[aria-label="所属群"]` 的实测读数是
**`14 × locator resolved to 0 elements`** —— 挂 14 次等满超时，不是脚手架坏了，是那一枚
下拉压根不存在。

## 3. 修法：新维度只进 paint 的谓词，两发 handler 各写各的格

0079 定盘的拆法在这里直接兑现了红利：控件在 `renderBacklogList` 建一次、行区在
`paintBacklogRows` 重画，所以「加一维筛选」= state 加一格 + 控件加一枚 + 谓词加一个合取项，
三处互不越界。两发 handler（搜索框 `oninput`、下拉 `onchange`）各自只写自己那一格 state、
都只叫 `paintBacklogRows(content)`；AND 语义住在谓词里（`packages/web/public/group.js:1700`），
不住在任何 handler 里 —— 谁也不许顺手清对方。这一格有专门的变异：N3 把下拉 `onchange` 改成
同时 `state.backlogFilter.q = ""`（用户选个群，刚敲的关键词凭空蒸发），实测红在线 1。

`selected:` 写在 option 上（`packages/web/public/group.js:1687`）而不是构建后赋 `select.value`：
下拉的选项表跟着 `state.groups` 走，切栏重建时当前选中值要能原样长回来 —— 这和 0079 §4 里
文档栏「所属群」下拉是同一个写法，两栏同形本身就是守卫钉的形状（vm 那发的每次快照都读
`selects`）。

## 4. 刻意留在内存筛，不发 group_id —— 与 0079 §7 分页同案

界面仍是 `request("/backlog?limit=200")`（`packages/web/public/group.js:951`）整份拉回、
`paintBacklogRows` 内存里 AND。把 `group_id` 拼进请求串在这条链路上是**一行字的事**，本轮故意
不做：文档栏的 `kind`/`group` 两维同样是内存筛，只把待办一侧切到服务端筛会让两栏对 limit
边界的语义分叉（待办 200 条之后的条目会「筛着筛着凭空消失」，文档栏则永远全量可见）。limit
该不该切服务端游标是 0079 §7「界面整份拉回再在内存里筛」那条整格挂账的决策（需要服务端回
total/cursor），两栏一起
动才是完整的一步 —— 届时的落地是「谓词换成请求串 + 空态文案换措辞」，本用例 8 根线一行都不用
改（它们断言的是用户可见语义，不摸 state 结构）。

## 5. 变异：7 发各剪一根，红的各是各的线

`.workbuddy/round396-wire-mutations.mjs`，沿用 0079 的自回滚机壳（锚点恰好命中 1 次、未变异
预热必须绿、逐发 finally 按 sha256 还原、退非零但输出无测试计数判 INDETERMINATE 停机）。
线表不写死行号，从 spec 的 `// 线 N（…）` 注释现推区间。

| 剪线 | 预期红 |
| --- | --- |
| N1 删群谓词两个合取项 | 线 1（选乙群该 0 条） |
| N2 群 handler 回调 `renderBacklogList` | 线 6（控件不累加） |
| N3 群 handler 顺手清 `q` | 线 1（AND 被改成覆盖） |
| N4 群 handler 改叫 `renderList()`（被否决的修法） | 线 2（焦点/取值留在同一枚框） |
| N5 把 `"所属群"` 改名 | 线 0（下拉存在） |
| N6 删构建末尾的 paint | 首屏断言（首帧就该有行） |
| N7 给 `paintBacklogRows` 塞 `toolbar` 形参 | 守卫 it「行区重画拿不到工具条」 |

## 6. 记下来但没动的

- `group_id` 走服务端 + limit 游标：见 §4，与 0079 §7 那条 limit 挂账同案，另案。
- 服务端列表参数 `state`（待办状态）契约里有、SQL 里有，界面仍没人发 —— 待办栏加「状态」下拉
  是同一形状的下一格；本轮没做是因为「按群筛」是 0079 白纸黑字挂的账，状态筛选还没有挂账。
  挂账现已挂上，但挂的不是工程账：`scheduled` / `doing` / `done` 全仓没有任何生产者，状态集合、
  合法跳转、由谁触发都是产品口径 —— 见 CEO-决策简报-2026-11-22 的 B11 那一格（那条下拉的前置）。
- 群改名后下拉里旧名会留到下次切栏（选项表挂在 `renderList` 的栏重建上，paint 不重建控件是
  0079 的定盘）；群增删本来就走切栏/刷新，改名是同一格。
- 本轮过程账两条（判据自身）：其一，线注释就是区间表的刻度 —— 首版把「线 2（焦点）」注释写在
  选乙群动作**之前**，N1 的 0 行断言被划进线 2，「群谓词被删」误报成焦点线红；注释必须写在
  该线动作与断言**之后**，spec 里已留警示。其二，round396 机壳从 round395 克隆时 ANSI 剥离
  正则丢了 `\u001b`（写成裸 `/[.../` 会被解析成字符类），vitest 的彩色 `×` 行一条也配不上，
  N7 报成「认不出发名」—— round395 台账里记过的同一个坑，克隆时照样踩，正则已按 round395
  逐字节对齐并加注释。

## 7. 实跑读数

- 红探针：`14 × locator resolved to 0 elements`（`test/e2e/group-workbench.spec.ts:3502`，
  修前）→ 落地后同发 **1 passed (2.9s)**；0079 那条链路用例回归 **1 passed (4.4s)**。
- 守卫 `test/web/list-filter-repaint.test.ts`：**8 passed**（首版对着新代码 **3 failed**：
  paint 计数 `expected 3 to be 2`、vm 行读数 `rows:3 ≠ 2`、判别力锚 `expected +0 to be 1`
  —— 三红都红在断言还停在旧形状，逐条随新形状重钉后转绿）。
- 变异机 7 发（`.workbuddy/round396-mutations2.log`）：**7/7 KILLED、还原一致 7/7**，
  红线归因与预期逐发对上（N1→线 1、N2→线 6、N3→线 1、N4→线 2、N5→线 0、N6→首屏段、
  N7→守卫 it「行区重画拿不到工具条：paint 的签名里只有 content」）。线 1 被 N1/N3 两发共用
  不是复读：N1 剪的是谓词（该收 0 条却收到全量），N3 剪的是 handler（AND 变覆盖、关键词被
  抹）—— 同一格判据的两个独立死法。0079 那台机子随锚点改写复跑：`.workbuddy/round395-mutations2.log`
  **10/10 KILLED、还原一致 10/10**（state 升格顶到的锚只有一处 —— M5 的 `TODO_Q` 从
  `state.backlogFilter = ` 升到 `state.backlogFilter.q = `；M4/M6/M10 钉的是
  `content.replaceChildren()` 那一格，不认 state。未变异预热先把每把尺子跑绿才动源码）。
- 门禁：`npx tsc -b` 与 `npx tsc -p tsconfig.test.json --noEmit` 两门 exit 0；biome 对 4 个改动源文件
  净新增 0（唯 4 条 `noTemplateCurlyInString` 全在 `test/arch/doc-refs.test.ts` 的 SNAP 键字符串里，
  与 HEAD 侧逐条同规则同名，非本轮引入）；`docs/review/check-gate.mjs` exit 0（C7 入口 0 处、
  判不了或不符 0）；SNAP 重复自检 314 键 / 去重 314 / 重复 0；改动文件 U+FFFD 全 0，且新查一门
  **裸 ESC 控制字节全 0**（INDEX 条目初版把「正则里要写的转义前缀」直接写成了真 ESC 字节 ——
  传输层吃反斜杠的第三次落地，见下）。
- 全量：`npx vitest run` **205 文件全绿 / 4241 passed | 6 skipped (4247)**、`npx playwright test`
  **65 passed (1.6m)**（0079 时 64 发 + 本轮 1 发），两门 exit 0。⚠ 途中一度 1 红：
  `test/arch/doc-coords.test.ts`「坐标引用与仓库提交对得上」报 `0079 l.184 → 83697c`+`4 仓库里没有这个提交`
  —— 这一红**不是本轮写出来的**，`git stash` 回 HEAD 复跑同样红（l.182/184 两条同因）：0079 §8 上一轮
  写台账时把 exempt-pierce 探针的假哈希**连写**进了散文，而那轮末次 doc-coords 跑在写入【之前】，
  红的状态就这么进了 HEAD。`hashProblems` 对「恰好 7 位且含 a-f」的 token 零豁免 ⇒ 修法按 0056 §6b
  既有先例把假哈希拆开写（`` `83697c`+`4` ``，本篇两处），真提交 `83697c3` 的引用原样保留，
  并在 §8 末尾留了一条「别顺手改回连写」。修后全量重跑即上面的全绿数。
- `docs/review/verify-open-invariants.mjs`（全量跑完之后才起，避开 exempt-pierce 的改写窗口）：
  **exit 0**，腐烂=0、豁免表 17 条条条承重、桶分项和 725 == token 725。
- ⚠ 反斜杠在工具传输里会被吃掉 ⇒ 台账与 INDEX 里**别把转义前缀写进代码格**：第一反应写
  `` `\u001b` ``，落到磁盘是真控制字节（`JSON.stringify` 打印两种形状一模一样，肉眼与日志都分不出，
  只能按码位量）。本轮改写为不含反斜杠的措辞（「要写反斜杠 u001b」），判定用
  `split(String.fromCharCode(27)).length - 1` 这种不依赖字面量的数法。

## 8. §6 那条状态挂账的去向：CEO 简报 B11（挂账本身也要过门禁）

§6 说的「状态筛选还没有挂账」现已挂上：CEO-决策简报新增 B11 那一格（状态集合、
合法跳转、由谁触发是产品口径，工程不代拍），并给它配了三样承重物，防止这条挂账
变成一句会被读散的散文：

- **简报正文 + 总览表行**：简报正文 11 处完整形态引用全部进 SNAP，加本节自己复述的
  那一条，快照总数 314 → 325（dup 审计 325 / 去重 325 / 重复 0）；其中 4 条钉的是
  「零生产者」的物证（两处 INSERT 字面量 backlog、两处
  UPDATE 字面量 cancelled）—— 谁接上 `scheduled`/`doing`/`done` 的写入方，快照必红，
  逼他回 B11 更新口径。
- **claims-registry 的 B8 行号锚**：总览表加一行把 B8 标题从 134 行顶到 135 行，
  `test/arch/claims-registry.ts` 里的登记行号同步 134 → 135。
- **0080 §6 的回指**：挂账处写明「见 CEO 简报 B11」，那条状态下拉的前置有了编号。

实跑读数（挂账落地那次）：

- 变异机 `.workbuddy/round397-b11-mutation.mjs` 三发全部「变异⇒红、还原⇒逐字节
  SHA 一致且复绿」：M1 抹掉 PATCH 三选一守卫的快照键 ⇒ doc-refs 红；M2 把枚举键的
  快照值改一个字节 ⇒ doc-refs 红；M3 把 B8 锚行号退回 134 ⇒ claim-coords 红
  （`expected [ Array(1) ] to deeply equal []`）。
- ⚠ M3 第一发【绿了】——不是变异没抹字节，是它打在 `claims-registry.test.ts` 上，
  而判 `source.line` 的门禁是 `test/arch/claim-coords.ts:73`（那座「此前只是一次性
  脚本」的门禁化）；判据尺子拿错，绿就是测了个寂寞。改指 claim-coords 后红。
- 守卫：doc-refs / doc-coords / decision-index / doc-ids / comment-citations 五文件
  36 passed；claim-coords、claims-registry（174）全绿；check-gate exit 0（入口轮次
  相对指称 0）；SNAP 键 325 / 去重 325 / 重复 0；tsc 两门 exit 0；biome 净新增 0
  （新增 SNAP 块触发一条 noUselessEscapeInString + format，已按 biome 自己的
  --write 形状落地，非基线豁免）。
- 全量单测 205 文件 / 4241 passed | 6 skipped（4247，与挂账前基线一致 —— 改动只在
  文档与登记元数据，无生产代码）；verify exit 0：腐烂 0、豁免表 17 条条条承重、
  桶分项和 726 == token 726、提交引用 498 条全可解析（verify 只在单测收尾后跑）。
- 字节检查：简报 / 0080 / doc-refs / claims-registry 四文件 U+FFFD 0、裸 ESC 0。
