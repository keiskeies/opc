# 0085 · 拆分弹窗认得了优先级，却把父项的期限原地丢掉（顺手逮到 `new Date(null)` 的纪元 0）

## 1. 一句话

契约的 `split` 早就收了 `children[].due_at`（`packages/contracts/src/backlog.ts:93`），服务端也真把它写进子项行（`packages/hub/src/backlog/service.ts:599`）——而拆分弹窗只发 title / detail / priority 三键：一条带期限的待办拆完，子项全部无期限，父项的期限就此蒸发。补两枚 `datetime-local` 的同时，在同一条取值路径上逮到一个潜伏更久的坑：`new Date(null)` 是**纪元 0 时刻**而不是 Invalid，`dateInputValue` 少了 null 挡，任何无期限的待办打开「延期」都预填 `1970-01-01T08:00`，点保存就把期限写成了纪元。

## 2. 复算：这一格是怎么被指出来的

前一轮（0084 §9）把「查询参数面」扫成 15/15 全有调用方后宣告耗尽，这轮换了两根轴：

1. **请求体面**：扫 `packages/contracts` 里 `*Create|Update|Request*Schema` 的字段、`hub` 认得、渲染侧不发 ⇒ 第一版报 **0**。⚠ 先怀疑尺子：正控制一跑，非贪婪 `\}` + 1200 字上限的 schema 取材只见到 43 schema / 126 字段（真值 95 / 463）——0 是「没量到」不是「没有」。改括号配平逐层取键后候选 135 个，但字段名启发式噪声太大（连刚接线的 `search.faces` 都误报成未发，模板拼接的 `${}` 路径提取又吞了 HTML），**字段轴作废**。
2. **端点轴**：拿 `API_ENDPOINTS`（95 条）对两个入口页（`app.js` 的 `api(method, path)` 拼 `/api`，`group.js` 的 `request(path)` 拼 `/api/v1`）做归一匹配 ⇒ 15 条「前端两端都不请求」。逐条对 `test/arch/ui-caller-roster.ts` 的 `NO_UI_CALLER_ROSTER`（0069 立的守卫，27 发全绿）：bindings 三条、approvals/token、training、talent 详情、dispatch 三条全部**已在册**（【覆盖】【排期】【判断】各类，本轮不动）；`assets/:id` 是 `<img src>` 假阳（`packages/web/public/group.js:4421` 拼 URL）、backlog 五条写操作是 `backlogMutation` 包装假阳（`packages/web/public/group.js:4060` 把 method 转手交给 `request`）、`DELETE /members/:id` 是 method 在第二参数里的提取假阳。**参数轴 + 端点轴双扫之后，真正的净新增缺口只剩这一个**：`children[].due_at`。

选它的理由和 0080-0084 同一形状：契约有、服务端真消费、UI 缺、无 CEO 决策依赖。拆分弹窗已经在继承 `priority`，唯独漏掉 `due_at` ——同弹窗的不对称自己就是证据。

## 3. 一个把两扇门一起打开的坑：`new Date(null)` 是合法的

`dateInputValue(item.due_at)` 要预填父项期限，而 `due_at` 可以是 `null`。`new Date(null)` 不抛、不 Invalid——它是 `1970-01-01T00:00:00Z`，`Number.isNaN` 拦不住，于是：

- 「延期」弹窗（`packages/web/public/group.js:4137`，本轮之前就在用这条路径）对无期限的待办预填 `1970-01-01T08:00`（东八区），人看不见「无期限」只看见一个 1970，顺手点保存就写进一条纪元期限；
- 拆分弹窗若照抄这条路径会把同一个坑复制成两枚。

修法在源头：`packages/web/public/group.js:85` 在 `new Date` 之前挡掉 `null`/`undefined`，两扇门一起好。⚠ 锚点教训：`if (value === null || value === undefined) return "";` 这一行在 `payloadText`（`packages/web/public/group.js:3242`）里有一模一样的第二份——变异机锚点必须连着函数头才唯一（预热阶段命中 2 次当场停机那种）。

## 4. 落地

渲染侧三件事（服务端零改动）：

- 拆分弹窗给两枚子项各加一格 `datetime-local`（`packages/web/public/group.js:4205` / `:4205`），预填 `dateInputValue(item.due_at)`；
- 上送时留空**整枚不发**（`packages/web/public/group.js:4225`）：契约 `children[].due_at` 是 `positive().optional()`，`null` 过不了 schema，省略才是「无期限」的正确线格式；
- `dateInputValue` 的 null 挡（上一节）。

没有新增 CSS（复用 `field()` + `input()` 现有形状），所以 space-scale / compact-scale 无新格。

## 5. 判据：七根线，判据都落在「这一发自己」上

一发 e2e（`test/e2e/group-workbench.spec.ts:4314`），种一条带期限的父项走真 HTTP：

| 线 | 判据 | 读数来源 |
| --- | --- | --- |
| 0 | 两枚期限格在弹窗里，且预填回读 == 父项那一刻的期限 | DOM + `inputValue()` 解析回 epoch |
| 1 | 拆分那一发的请求体 `children` 各带 `due_at==due` | `page.on("request")` 收 POST body |
| 2 | 两枚真落库 | 拆完 `GET /backlog?limit=200` 读回 |
| 3 | 拆完父项仍带着那条期限 | 同上读回父项 |
| 4 | 清空第二枚再拆 ⇒ 那一枚 `due_at` **不发**（不是被预填塞回） | 第二发的请求体 |
| 5 | 拆出的子项卡片各挂 `<time>`，父项也还在 | DOM |
| 6 | 无期限的父项 ⇒ 拆分与延期两扇门的期限格都是**空的** | DOM `toHaveValue("")` |

两个刻意的口径：**线 0 比 epoch 不比字符串**——`datetime-local` 是本地时间，拿 `toISOString()` 比字符串等于把本机时区写进判据；种子取齐整分钟，因为控件分辨率就是分钟，差的那一截是尺子的分辨率不是缺陷。**线 4 是这根接线的负半**——只判「带上去」的接线，「留空不发」就可以用 `due_at: item.due_at` 假实现骗过（M9 证明确实骗不过线 4，但前提是先有这发）。

## 6. 变异机：10 根真线 + 1 控制组，逐线点名 7/7

`.workbuddy/round405-wire-mutations.mjs`，剪线跨两个文件（渲染 group.js、服务端 `packages/hub/src/backlog/service.ts`——只剪一侧另一侧会代打）：

- M1 期限格不做 / M2 预填不取父项 / M5 第二枚不做 ⇒ 线 0；
- M3 上送整条摘掉 ⇒ 线 1（控件仍在、绿在 DOM 上——这一发证明判据不是只看 DOM）;
- M8 服务端 `child.due_at ?? null` 改 `null` ⇒ 线 2（界面全对、库里没有）；
- M10 拆完追加一句 `UPDATE ... due_at = NULL`（「期限交给子项」那一种实现选择，契约 `packages/contracts/src/backlog.ts:81` 明写父项保留）⇒ 线 3；
- M4 两枚共用第一枚的值 / M9 留空被父项塞回 ⇒ 线 4（前两发全绿，只有清空那一发抓得住）；
- M7 卡片 `<time>` 摘掉 ⇒ 线 5（三行一起抹，只抹前两行留孤儿 `: null,` 是语法错，因果会错）；
- M6 null 挡缺失 ⇒ 线 6；
- C1 控制组（弹窗提示语）如预期 SURVIVED。

**读数**：预热 11 根锚点各命中 1 次 + 未变异 1 passed；**10/10 KILLED、0 存活**；逐线点名 7/7 各有目击者；两文件收尾 SHA `dc23cb…` / `4469a7…` 与开工逐字节一致。

## 7. 红探针与坐标

- **红探针在最终测试字节上复取**：只把 `group.js` 退回 `git show HEAD:` 字节（`sha256` 前缀 `dc23cb133536fab5` 还原验证），新用例当场 `Received: 0`、`14 × locator resolved to 0 elements`、**1 failed**；换回后 1 passed。本轮服务端零改动，所以红探针只需要退回渲染侧一个文件——比 0084 的三文件版少一个坐标系。
- **重钉**：group.js 本轮 +19 行（+3 在 82 前、+16 在 4193 后），分档表 5 档从 `git diff -U0` 逐项抄。门 0「HEAD 9718 行按分档映射后仅 2 行不符 = 本轮真改写的 4199/4200 两行」，门 1「整面 82 个不同行号单趟搬运后仍 82 个、无碰撞」，搬 **196 处**（面 96 文件）。⚠ `wc -l` 报 9734、映射循环报 9718（split("\n") 把尾换行算成第 9718 空行）——两个数各对各的坐标系，台账分开写。
- **spec 坐标零受累**：本轮只在文件中部插了一发 test（+167 行），census 证实文档引用的 spec 坐标没有一条 >4310，`>spec.ts` 键全部不动。

## 8. 记下来但没动的

- 「无期限」在延期弹窗里仍有第二个入口（「明确清除期限」勾选框与留空等价）——两入口语义一致，没有判据冲突，要不要合并成一个控件是产品口径。
- 拆分弹窗的子项仍只有 title/detail/priority/due 四键（契约 children 就这四键），`detail` 恒发空串：服务端 `.default("")` 认，界面上要不要给子项详情一格属排期。
- 本轮的两轴扫描脚本没立成守卫：字段轴被证噪声太大（§2 第 1 条），端点轴 `ui-caller-roster` 已覆盖且更强——重复立一根弱尺子只会稀释门禁。

## 9. 实跑读数

以下读数对应的字节 = 最终提交字节（文档与 SNAP 定稿后，守卫与全量都在其上重跑过）：

- 红探针对 HEAD 版 group.js：`14 × 0 elements` / `1 failed`，还原 SHA 逐字节一致后 1 passed；
- 变异机：预热 11/11 锚点 + 未变异绿；**10/10 KILLED** + 控制组如预期活 + 逐线点名 **7/7**；收尾 SHA 两侧一致；
- 重钉：门 0 / 门 1 如上，196 处 / 96 文件；SNAP **446 键 / 0 重复**（净 +17 = 本篇 11 条 + 索引入口行 6 条，全部由脚本按目标行 `.trim()` 原文生成、不手抄；子项第二枚那一格在正文里写的是「4199 那格的同行续写」，`FILE_REF` 抠不出路径 ⇒ 不建键，建了就是「快照里有、文档里没有」的孤儿红。重钉只搬键名，0 条值被改）；
- 全量 vitest **205 files / 4241 passed | 6 skipped**（103.75s，本轮无新增 vitest 用例）；全量 e2e **70 passed**（69 → 70，1.2m）；
- `tsc -b` + `tsc -p tsconfig.test.json --noEmit` 双双 exit 0；`pnpm lint` **exit 0 / 0 error**；
- biome warnings **103** = 基线 102 **+1**，且这一发**归因得清楚**：新增的唯一一条是 `noTemplateCurlyInString`，落点 `test/arch/doc-refs.test.ts` 里本篇新入册的那枚 SNAP 键值 —— 值按家法必须逐字抄目标行，而那行源码本身就含 `${`（同文件 HEAD 版同类 13 条 ⇒ 现 14 条，产品侧规则计数逐条与基线一致：noNonNullAssertion 50 / noUnusedVariables 12 / useOptionalChain 12 / noUnusedImports 8 / noExplicitAny 3 / noUnusedFunctionParameters 3 / useMathMinMax 1）。**这是守卫自身的修辞警告，不是净新增的产品警告**；把它「修掉」等于篡改快照值，所以登记在这里而不是改判据或改值；
- 台账 U+FFFD **0**（写入中文后 `grep -c $'\uFFFD'` 复核）。
