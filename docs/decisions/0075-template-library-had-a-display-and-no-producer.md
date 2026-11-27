# 0075 · 模板库只有读者没有生产者 —— 而守「零调用方」的那道门压根不看 HTTP 方法

**日期。** 2026-11-27（round390）。
**落地。** `packages/web/public/group.js`（文档中心「从模板开始」卡加「新建模板」按钮 +
新函数 `templateCreateModal()`，接真 `POST /api/v1/templates`）；
新链路用例 `test/e2e/group-workbench.spec.ts` +1（生产者 → 落库 → 跨刷新 → 消费闭环）；
证据 `.workbuddy/round390-mutation.mts`（变异机 8 发）与
`.workbuddy/round390-method-blind-probe.mts`（守卫视野探针，只读）。

## 1. 一句话

`POST /api/v1/templates` 从路由（`packages/hub/src/http/documents.ts:429`）到服务
（`createDocumentTemplate`）到契约（strict schema）到落库（`INSERT_TEMPLATE_SQL`，
`packages/hub/src/documents/service.ts:150` 硬写 builtin=0）**全都建好了，但整个界面没有
一处调它** —— `group.js` 只在两处 GET `/templates` 读列表、渲染成「从模板开始」的芯片。
于是模板库的全部内容 = 迁移 0016 播种的 4 张 builtin 模板；builtin=1 又受
`doc_templates_builtin_no_delete` 触发器禁删 —— **既不能加也不能删，模板库是一个只读陈列柜**。
接口侧一直是通的（`service.test.ts` 有 builtin=false 与逐字展开两条承重断言），缺的
和 0074 头一道断点同形状：【生产者】。

## 2. ⭐ 病根的形状：守卫判「这条路径被碰过」，契约条目却是「方法 + 路径」

仓库里明明有一道专门守这件事的门：`test/arch/ui-caller-roster.ts` 的 ③ ——
「已实现而渲染侧无人调用的端点必须出现在 `NO_UI_CALLER_ROSTER` 名单里，否则红」。
`POST /api/v1/templates` 既没接线、也没进名单，③ 却二十几轮一直绿。原因在命中口径：

`hitsUi`（`test/arch/ui-caller-roster.ts:222`）把端点路径归一后只和 UI 里抽出的路径模式
比字符串，**HTTP 方法整个不参与**。而 group.js 有两条 GET 的 `request("/templates")`
（第 834 与 8337 行）—— 于是路径维判「已接线」，POST 被同路径的 GET 洗白：
③ 不看它（有调用方），④（名单内条目必须仍零命中）也不看它（不在名单内）。

这与 0072 是同族病：**判据守的是「当时的正确陈述」，不是「主张本身」**。③ 的陈述是
「这条路径在渲染侧出现过」，这条陈述为真，于是实现里「这个方法有生产者」那一维被合法地
盖住了 —— 同一条路径上 GET 有人用、POST 没人用，是这类 REST 形状的常态，失明不是意外
而是口径缺维。

## 3. 失明面实测：探针残 10 条，逐条手校后真漏网的只有本篇这一族

先把尺子修得至少和名单一样宽再读数（否则报出来的是探针自己的盲区）：反引号里的
`${…}` 插值压成单字符占位（名单把 `${encodeURIComponent(id)}` 归一成 `{}`，同一口径）、
`request(path, {method})` 与 `api("PATCH", path)` 两种写法都认。读数
（`.workbuddy/round390-method-blind-probe.mts`）：契约 95 条，路径维判已接线而方法维
找不到证据的 **10 条**。逐条开源码核对：

- **9 条是探针瞎**，界面全都真接了线，只是方法不在路径的 160 字符窗口内 ——
  backlog 五条走 `backlogMutation(path, method, body)` 变量转发（方法是形参，源码里
  根本不与该路径同窗）；`POST /charter/:roleId` 走 `api("POST", path)` 且路径含拼接；
  restore / removePermission / 踢成员三条的 `{method}` 与路径隔行超窗。
- **1 条是真零调用**：`DELETE /api/v1/members/:id`（成员离职）—— 全文件无「离职/解雇/
  offboard」字样、无调用点。**但它本来就在名单里**（13 条在册条目之一，登记的口径是
  【判断】而非遗漏）⇒ 零调用方是拍板过的现状，不是漏网。

所以这一维历史上真正放出去的漏网鱼就是 `POST /templates` 这一条 —— 它既不在名单里、
又被同路径 GET 盖住，是**唯一一道两层都盖不住的方向**：「路径碰过、方法没碰过、且没登记」。

## 4. 落地：把生产者补上，接法沿用本页既有肌肉

「从模板开始」卡的 actions 追加第 7 个按钮（`packages/web/public/group.js:3949`），
空态文案同步改成「点「新建模板」建第一张，或先创建空白文档。」（原来那句只指空白文档，
在陈列柜语境下是唯一的门）。新函数 `templateCreateModal()`
（`packages/web/public/group.js:8432`）走 `openModal` 既有形态：名称（必填，≤200）+
文档形态下拉（markdown/文档/表格/思维导图，与 `createDocument` 同一套 `docKinds`）+
模板正文大栏；`onSubmit` 真发 `POST /templates`，成功后 `loadAuxiliary()` 重取
`state.templates` + `renderMain()` 重渲 —— 新模板**立刻**是芯片、立刻能点。失败形状
不用另写：`request` 非 2xx 抛 ApiError，`openModal` 把错误留在弹窗 `#modalError` 上。

服务端**没有加新测试**：builtin=0 与「建文档时服务端逐字展开模板正文」在
`packages/hub/test/documents/service.test.ts` 早就各有承重断言（写 builtin 的
`packages/hub/src/documents/service.ts:150`、展开的 `packages/hub/src/documents/service.ts:803`
各被变异 M6/M7 打红过），为已承重的线再补一发是同义反复。

## 5. 判据：一发闭环 e2e，`kind` 那根线有自己的那次动作

新用例「模板生产：新建模板真发 POST /templates，跨刷新还在且能被用来建文档」
（`test/e2e/group-workbench.spec.ts:2282`）一段走完四件事：

1. **生产者真发**：`waitForResponse` 抓 `POST /api/v1/templates`，断言请求体是
   `{name, kind, body_text}` 三键齐全、响应 `template.builtin === false`；
2. **kind 承重**：弹窗默认 markdown，用例**故意选「文档」**再断言收到 `kind:"doc"` ——
   每根线要有自己的那次动作，跟着默认值断言的话「kind 写死」的变异是活的（M3 实测即红）；
3. **落库 + 跨刷新**：新芯片出现在「从模板开始」卡内 → `page.reload()` 重进文档页仍在
   （证的是服务端行，不是内存态）；
4. **闭环到消费**：点新芯片 → 起稿弹窗 → 建文档 → 直接 fetch 该文档读
   `body_text` 逐字等于模板正文（`POST /documents` 的 template_id 展开在服务端完成）——
   「建的模板能被用来建文档」这句主张第一次有了判据。

## 6. 变异机 8/8

`.workbuddy/round390-mutation.mts`（vitest/playwright 双 runner；锚点唯一性预检 +
预检未变异两侧绿才开跑 + 每发自己 `finally` 还原 + 单发 sha256）：

- M1 摘按钮（生产者又只剩 GET 那一半）⇒ 红；
- M2 提交体丢 `body_text` ⇒ 红；
- M3 `kind` 写死 markdown ⇒ 红（红在 `kind:"doc"` 断言，§5 第 2 条的那次动作）；
- M4 建完不 `loadAuxiliary`+`renderMain`（新模板只活在 toast 里）⇒ 红；
- M5 方法写坏成 GET（打的是另一条路由）⇒ 红；
- M6 builtin 写 1（自建模板混进内置禁删档）⇒ 红，红的是 service 测试面
  「creates from a server-side template…」与 `toHaveLength(5)` 那发；
- M7 建文档不再展开模板正文（模板库读得出、用不上）⇒ 红，同一发；
- C1 控制组（弹窗上方加无关注释）⇒ 绿。

M6/M7 与 M1–M5 分属两个 runner、各打各的既有断言 —— 它们证明的是「§4 说的服务端
早已承重」不是套话：界面没接线之前那两条线也已经有人守，缺的从来只是生产者。
收尾逐文件逐字节核对还原一致。

## 7. 记下来但没动的

- **要不要把 `hitsUi` 升成方法敏感**：升了要把 13 条名单条目全部长出 method 维、
  ④ 的语义重定义，而且实测的漏网收益今天只有 1 条（已被本篇落地吃掉）。收益/改动面
  不成比例，等一句话再动；探针留在 `.workbuddy/round390-method-blind-probe.mts`，
  下次怀疑名单说谎时直接重跑。
- **模板的删改入口**：builtin 禁删是触发器拍板过的现状；自建模板（builtin=0）今天
  也没有改名/删除界面（`DELETE /api/v1/templates/:id` 路由不存在，是契约面就没有的端点，
  不属于「零调用方」而是「未实现」）。要不要给自建模板做管理面属功能拍板。
- **成员离职**（`DELETE /api/v1/members/:id` 的界面入口）：在册【判断】条目，
  做不做、什么形态，属产品决定，不在本篇范围。
- `GET /api/v1/assets/:id` 回填自报 mime、无 nosniff/CSP —— 0074 §7 记过，原样保留。

## 8. 实跑读数

- 新 e2e 单跑绿；变异机 **8/8**（预检未变异两侧绿：playwright 1 passed、service 测试
  9 passed；M1–M7 该红全红、C1 控制组该绿），收尾「还原：全部逐字节一致（sha256 核对过）」。
  M6/M7 各自红的是 service 测试面同一条「creates from a server-side template with version 1,
  audit, and broadcast」（builtin 断言与展开断言同发），读数逐发打在 log。
- **全量**：`vitest run` **201 文件 / 4216 passed / 6 skipped** —— 与 0074 完全持平是**预期**：
  本篇没有新 vitest 用例（§4 的理由），新用例在 Playwright 面。Playwright 全量 **60 passed**
  （59 → 60）。
- `tsc -b` 与 `tsc -p tsconfig.test.json --noEmit` exit 0。
- **守卫**：`test/arch` 全量 **38 文件 / 613 passed** —— doc-refs 新增七条 0075 活坐标后
  2/2 绿（含「扫描器本身有判别力」那发），decision-index 认账 0075，ui-caller-roster ③/④
  未受影响（templates 从没在名单里，接线后仍不该在）。
- ⚠ `doc-refs.test.ts` 里 biome 报四条 `noTemplateCurlyInString` —— **逐条比对不是本篇新增**：
  `git stash` 掉本篇那七行后同一文件仍是 4 条（既有快照值里就带 `${}`）。净新增 **0**，
  所以不登记也不动它们。
- `verify-open-invariants.mjs` SUCCESS（提交引用全部可解析）· `check-gate.mjs`
  判不了或不符的项 **0**（C7 决策入口轮次相对指称 0 处，本篇入口那一行过）·
  U+FFFD 台账与 INDEX 各 **0** · `group.js` `node --check` 通过。
- 探针（只读、不改盘）：契约条目 95，方法维无证据 10，手校后真零调用 1（在册）。
