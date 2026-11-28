# 0086 · 会议散了，却没人记下它是几点散的（详情只写开场于，纪要正文连这一项都缺）

## 1. 一句话

契约的 `meetingViewSchema` 一直带着 `concluded_at`（`packages/contracts/src/meeting.ts:51`），服务端在散会与取消两条路径上都真把它写进库（`packages/hub/src/meetings/service.ts:136` / `packages/hub/src/meetings/service.ts:139`），视图也照映射（`packages/hub/src/meetings/service.ts:236`）——而会议详情页只渲染 `opened_at`（`packages/web/public/group.js:3123` 那句「主持：… · 开场于 …」），结论区里决定、负责人、截止三样齐全，唯独「什么时候散的」不在；纪要正文更硬：`meetingSummaryMarkdown` 自己的注释写着「会议事实一项不缺」（`packages/hub/src/documents/deposit.ts:105`），列出来的事实里也没有它。补的正是这一项：详情加一行时刻（`packages/web/public/group.js:3024`），纪要加一行（`packages/hub/src/documents/deposit.ts:132`）。

## 2. 复算：这一格是怎么被指出来的

前两轮把「查询参数轴」扫成 15/15 耗尽、把「请求体字段轴」证噪声太大作废（0085 §2）、端点轴 15 条也逐条对完 `NO_UI_CALLER_ROSTER`。这轮换**响应侧轴**（round340 验证过的那根）：契约里 `*ViewSchema` / `*Response` 的字段，在两个入口页里**零字面出现** ⇒ 服务端算了、界面从不读。脚本 `.workbuddy/round406-response-zero-read.mjs`。

⚠ 这根尺子第一版就废过一次：按括号深度自己数缩进取字段，实测把嵌套对象里的字段整层丢掉，而「丢一层」在输出上只表现为候选变少、不报错——正是 0085 那条「恒 0 是没量到」的同族。改成取**恰好缩进 4 空格**的 `name:`（这批契约文件的顶层字段就是这个排版），并在末尾强制报**正控制**：响应 schema **30 个 / 字段 226 个**，候选 **16 条**。这条口径本身也被本轮兑现了一次：接线落地后同一条命令的候选从 16 降到 **15**，少的正是 `meeting.ts :: meetingViewSchema :: concluded_at`——一根尺子如果对自己改的东西毫无反应，它量到的就不是这件事。

16 条候选的人工 triage（**必要条件成立不等于该做**，逐条给去处）：

| 候选 | 判定 |
| --- | --- |
| `meeting.ts :: meetingViewSchema :: concluded_at` | ✅ 本轮做掉：同对象同区块的不对称 + 纪要注释自证 |
| `imBindingViewSchema` 的 `external_user_id` / `verified` / `verified_at` / `verified_by` | ❌ 四条同属 IM 绑定视图，而该页四条端点全在 `test/arch/ui-caller-roster.ts` 的在册名单里（【判断】/【排期】），字段跟着页面走 |
| `dispatchRuleViewSchema` 的 `rule_id` / `target_role_id` / `target_role_name` | ❌ 分发规则配置页整页【排期】（同一份名单点名三条端点），字段级候选不另立案 |
| `gates.ts :: approvalCardDraftSchema :: buttons` | ❌ 远程审批卡的字段，落点与「签票入口」同一格（在册【排期】） |
| `meetingTurnViewSchema :: turn_id` / `researchCardViewSchema :: card_id` / `dispatchRuleViewSchema :: rule_id` | ❌ 内部主键，界面按序号与标题寻址，渲染它没有读者 |
| `plugin.ts :: pluginToolViewSchema :: input_schema_json` | ❌ 工具入参 JSON Schema，渲染前提是「插件工具详情」这一页，今天没有它 |
| `assetViewSchema :: size_bytes` / `groupMemberViewSchema :: joined_at` / `memberViewSchema :: hired_at` / `pluginViewSchema :: installed_at` | ⏳ 四枚真候选：都是「一行元数据」，没有功能缺口、也没有哪句注释或契约像本轮那样自证「本来就该有」⇒ 留在候选池，下轮按「同区块已渲染的字段里有没有它这一类」再判 |

选 `concluded_at` 的理由和 0080-0084 同一形状：契约有、服务端真消费、UI 缺、无 CEO 决策依赖。而它额外带一件自证：结论区那块 `dl` 已经排了决定/负责人/截止三项，`concluded_at` 与它们同层同类型；纪要正文那句「会议事实一项不缺」是一句**可以被判据打脸的主张**——这是全仓最便宜的一类缺口。

## 3. 一列两笔写入：取消那一刻也写在 `concluded_at`

`CONCLUDE_SQL` 与 `CANCEL_SQL` 写的是同一列（`packages/hub/src/meetings/service.ts:136`、`packages/hub/src/meetings/service.ts:139`），语义却两样。所以渲染侧标签必须分两支（`concluded ? "散会于" : "取消于"`，`packages/web/public/group.js:3024`）：写成常量「散会于」在数据上不算错、在界面上是撒谎——一场被取消的会看起来像开完了。M2 就是这一发，它只在线 6 红。

时刻的格式化复用 `fmtDateTime`（`packages/web/public/group.js:80`）：它本身对假值返回「—」，而这一格只在 `concluded || cancelled` 分支里渲染（服务端两笔 UPDATE 必然写入该列），所以**没有**再加一层 null 挡。第一版写了挡，随后按 YAGNI 删掉并复跑确认判据不受影响——判据能区分「挡与不挡」的分支根本到不了，留着就是死码。

## 4. 落地

两件事，无新 SQL、无新契约字段、无新 CSS：

- 渲染：结论区的 `dl` 末尾追加一对 `dt`/`dd`（标签分两支 + `fmtDateTime(meeting.concluded_at)`）；
- 纪要：`meetingSummaryMarkdown` 的结论段追加 `- 散会时刻：…`（`packages/hub/src/documents/deposit.ts:132`），复用同文件的 `deadlineText`——它对 null 写「未记录」、对数值写 ISO，正是这一项要的口径。

## 5. 判据：七根线，每根判自己那一次动作

一发 e2e（`test/e2e/group-workbench.spec.ts:4541`），全程真 UI：弹窗开会（主持人必须是坐过席的成员 ⇒ 建群时勾上产品经理）→ 提交一轮发言 → 填结论三件套散会 → hash 深链回详情 → 再开一局走取消弹窗。

| 线 | 判据 | 读数来源 |
| --- | --- | --- |
| 0 | 开着的会：详情有「开场于」、有发言框与散会表单，`.detail-list` 数量为 **0** ⇒ 这一刻还不存在 | DOM |
| 1 | 真 UI 发一轮发言 ⇒ `.turn-content` 计数 1 **且正文就是打进去那句** | DOM + 请求响应 ok |
| 2 | 散会那一刻：库里的 `concluded_at` 落在提交前后夹出的窗口内 | `fetch /meetings/:id` |
| 3 | 「散会于」这一行进结论区（计数 1） | DOM |
| 4 | 行内时刻 == `fmtDateTime(concluded_at)` 的同一个字符串 | DOM 与库读数比对 |
| 5 | 纪要正文含 `- 散会时刻：<ISO>` | `fetch /documents/:id` 的 `body_text` |
| 6 | 取消那局标签是「取消于」（且「散会于」0 枚）+ 行内时刻 == 服务端写入的那一枚 | DOM + 库读数 |

三处刻意的口径：

- **线 4 用与渲染同一把尺**（`zh-CN`、24 小时制的 `toLocaleString`）：判据若是「页面上有个日期」，`fmtDate`（只到日）和写死当天都能骗过去；比字符串就等于比时区，而比 epoch 需要再引一层时区换算，不如两侧同尺。
- **尺子自己也要自证**：`fmtDateTime` 只到秒，而 `opened_at` 与 `concluded_at` 在同一次点击流里可以挤进同一秒 ⇒ 那一刻「读对列」与「读错列」渲染出**同一个字符串**，判据成了看运气。两处补上：`settlePastSecond()` 把两刻拉开 1.1 秒以上（等的是被测对象的分辨率，不是随手 sleep），并加一句 `expect(fmtLocal(concludedAt)).not.toBe(fmtLocal(openedAt))`——它把「这把尺此刻分得开」钉成断言，将来机器变快导致两刻又贴回同一秒时，它先红，而不是让线 4 静默退化成永真。
- **线 0 判 `.detail-list` 计数 0**，不是判「没有散会于」：前者能抓住「渲染条件写错成恒真」，后者不能（M5）。

## 6. 变异机：11 根真线 + 1 控制组，逐线点名 7/7

`.workbuddy/round406-wire-mutations.mjs`，剪线跨**三个**文件——渲染 `group.js`、纪要 `packages/hub/src/documents/deposit.ts`、落库 `packages/hub/src/meetings/service.ts`。只剪一侧另一侧会代打：纪要那一行摘掉（M7）时渲染侧全绿，反过来把渲染那一格换成读 `opened_at`（M4）时纪要照写不误。

- M1 `dt`/`dd` 整对摘掉 / M2b 标签恒写「取消于」⇒ 线 3；
- M2 标签恒写「散会于」/ M10 取消那刻写死一枚纪元 ⇒ 线 6；
- M3 时刻退化成 `fmtDate` / M4 时刻读错列 ⇒ 线 4；
- M5 结论区渲染条件恒真 ⇒ 线 0；M6 发言正文不渲染 ⇒ 线 1；
- M7 纪要正文没有散会时刻 / M8 纪要那一行拿截止时间冒充 ⇒ 线 5；
- M9 散会 UPDATE 的 `concluded_at` 与 `deadline_at` **参数错位** ⇒ 线 2（列照写、写的是别的事实：状态与决策全对，只有那一刻是假的）；
- M11 控制组（会议文档卡那句「散会成功后，服务端自动生成…」的说明文案）如预期 SURVIVED。

**M4 第一发是存活的**，而它不是「判据够不着」，是判据在那一刻**分不开**：本机跑得快，开场与散会落在同一秒，`fmtDateTime` 到秒，两列渲染出同一串。补法见 §5 第二条——先让尺子分得开，再要求相等。补完后 M4 红在线 4。**11/11 KILLED、0 存活，逐线点名 7/7 各有目击者**（线 3、4、5、6 各两发，线 0、1、2 各一发），三文件收尾 SHA 与开工逐字节一致。

## 7. 红探针与坐标

- **红探针在最终测试字节上复取**：把 `group.js` 与 `deposit.ts` 一起退回 `git show HEAD:` 字节，新用例当场红在 `test/e2e/group-workbench.spec.ts:4671` 那句「散会于」计数断言（`unexpected value "0"`）、**1 failed**；还原（sha256 前缀 `177db25d4bf1983b` 与 sha256 前缀 `1a80f00bbe2bfee8`，与剪线前逐字节一致）后 1 passed。本轮第一版红探针取的是改动前的测试字节，随后判据本身又加固了三次（线 0 的 `dl` 计数、线 1 的正文、线 4/6 的尺子自证），所以按家法**在最终测试字节上重取一次**。
  ⚠ 这一节里那几个 sha256 前缀各要一枚「紧邻前文声明」：prose 哈希判据只看 token **左边 40 字符**，块首写一次 `sha256` 管不到第二枚 ⇒ 每枚 token 前都各写一次，否则它们会被当成解析不了的提交引用而报红（`docs/review/verify-open-invariants.mjs` 现场逮过一次）。
- **重钉**：`group.js` 本轮 `wc -l` 9734 → **9740**（`git diff -U0` 只有一个 hunk：`@@ -3022,0 +3023,6 @@`，纯追加、无替换行）。门 0「HEAD 9735 行按分档映射后 0 行不符 = 本轮真改写的那 0 行」，门 1「整面 88 个不同行号单趟搬运后仍 88 个、无碰撞」，搬 **129 处**（面 97 文件），只搬键名、0 条值被改。⚠ 两个行数各对各的坐标系（`wc -l` 9734 vs 映射循环 split 出 9735）照 0085 §7 分开写，不合并成一个数。
- **`deposit.ts` 零受累**：它在 131 行后 +1，但 census 证实 docs 与 SNAP 里**一条 `deposit.ts` 坐标都没有** ⇒ 面内无搬运（这条 census 是搬完守卫重跑前的前置，不是事后说明）。
- **spec 坐标零受累**：新用例追加在文件末尾（`test/e2e/group-workbench.spec.ts:4541` 起），它之前的行一行未动 ⇒ 既有 `>spec.ts` 键全部不动。

## 8. 记下来但没动的

- 会期时长（`concluded_at − opened_at`）没有渲染：它是一枚派生值，不是「服务端算了界面不读」，且要不要显示属信息密度口径。
- 详情里「开场于」写在标题下面那句流水文案里，与结论区的「散会于」分处两块。归并成一张 `dl` 更整齐，但那会挪动既有文案、牵连别的判据，本轮只做加法。
- 纪要正文的字段顺序按「结论段既有顺序」追加在末位；若要让散会时刻紧跟「截止时间」，那是排版口径，与判据无关。
- §2 表尾那四枚真候选（`assetViewSchema.size_bytes` / `groupMemberViewSchema.joined_at` / `memberViewSchema.hired_at` / `pluginViewSchema.installed_at`）留在候选池。响应侧扫描脚本仍未立成守卫：它判的是必要条件（出现≠真渲染），每轮都要人工 triage，立进门禁只会把「判定」冻成「噪声」。

## 9. 实跑读数

以下读数对应的字节 = 最终提交字节（文档与 SNAP 定稿后，守卫与全量都在其上重跑过）：

- 红探针对 HEAD 版两文件：`1 failed`（断在「散会于」计数），还原 SHA 逐字节一致后 1 passed；
- 变异机：预热 12/12 锚点各命中 1 次 + 未变异绿；**11/11 KILLED** + 控制组如预期活 + 逐线点名 **7/7**；三文件收尾 SHA 两侧一致；
- 重钉：门 0 / 门 1 如上，**129 处 / 97 文件**；SNAP **462 键 / 0 重复**（净 +16 = 台账 11 条 + 索引入口行 5 条，全部由 `.workbuddy/round406-snap-append.mjs` 按目标行 `.trim()` 原文生成、不手抄；重钉只搬键名，0 条值被改）。台账里写成 `:139` 的同行续写 `FILE_REF` 抠不出路径 ⇒ 不建键（建了就是「快照里有、文档里没有」的孤儿红）；
- 全量 vitest **205 files / 4241 passed | 6 skipped**（本轮无新增 vitest 用例，新判据全在 e2e）；全量 e2e **71 passed**（70 → 71，1.2m）；
- `tsc -b` + `tsc -p tsconfig.test.json --noEmit` 双双 exit 0；`pnpm lint` **exit 0 / 0 error**、warnings **106** = 基线 103 **+3** 且逐条归因清楚：三条全是 `noTemplateCurlyInString`，落点全在守卫自己的新 SNAP 键值（`test/arch/doc-refs.test.ts` 该文件同类 14 → 17 = `packages/hub/src/documents/deposit.ts:132` 台账与索引各入册一次 + `packages/web/public/group.js:3123` 一次），那两行源码本身含 `${`；产品侧规则计数与基线逐条一致（noNonNullAssertion 50 / noUnusedVariables 12 / useOptionalChain 12 / noUnusedImports 8 / noExplicitAny 3 / noUnusedFunctionParameters 3 / useMathMinMax 1）。**这是守卫自身的修辞警告，不是净新增的产品警告**，「修掉」它等于篡改快照值，所以登记在此；
- `docs/review/check-gate.mjs`「判不了或不符的项：**0**」、`node docs/review/verify-open-invariants.mjs` **SUCCESS**（prose 哈希引用全部可解析或有逐条理由）；
- 台账、INDEX、spec、doc-refs 四文件 U+FFFD **0**。

⚠ 两条这一轮踩到的量法坑，写在这里因为它们都会伪装成「读数」：

1. **HEAD 侧 lint 对照不能放仓库外**。我先把 `git show HEAD:test/arch/doc-refs.test.ts` 落到 `/tmp` 再 `biome check`，得到「HEAD 侧该规则 0 条」——假的：该路径不在 biome `files.includes` 白名单内，命令压根没检查它。与 0085 记的 `.tmp` 那次同族。改用 `--reporter=summary` 让 biome 自己按文件报归属，才拿到「该文件 14 → 17」这个真读数。
2. **往 INDEX 追加入口行是一次全文替换**。本轮的编辑把 0085 那一整行吞掉了（锚点取的是 0085 行开头、替换文本里没写回它），而入口行是单行几千字，肉眼看 diff 很容易只看见新行。抓住它的是 `grep -c "拆分待办那张弹窗"` 得 **0** 这一发独立计数，不是 diff。补回后端点与 HEAD 原文逐字节一致（除本轮该搬的 6 行重钉）。
