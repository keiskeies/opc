# 0076 · 全局搜索有七面的数据、六面的界面 —— 「点了没反应」长得和「搜到了」一模一样

**日期。** 2026-11-27（round391）。
**落地。** `packages/web/public/group.js`（`faceLabels` 补 `group` 键、`openSearchHit`
补 `group` 分支、搜索结果行补 `data-face` / `data-id`）；新守卫
`test/web/search-face-parity.test.ts`（面名单 ↔ 渲染侧奇偶）；新链路用例
`test/e2e/group-workbench.spec.ts` +1（群命中：徽标 → 落点）；证据
`.workbuddy/round391-mutation.mts`（变异机 10 发）。

## 1. 一句话

契约里搜索有七面（`packages/contracts/src/search.ts:11`），服务端七面各自有 SQL、
各自有承重断言（`packages/hub/test/search/service.test.ts:45` 一发把七面全点齐）。
渲染侧只有六面：`faceLabels` 少 `group` 这一格、`openSearchHit` 少 `group` 这条分支。
于是搜「双十一」时服务端把那个群真发回来了，界面上那行**没有徽标**（空白），
点下去**什么都不发生**（下拉关掉、屏幕原地不动）—— 而这两件事在屏幕上都不报错，
读起来和「这条命中本来就没内容」完全一样。设计文档验收第 8 条要的是
「全局搜索『双十一』→ 命中群/消息/文档/任务四类」（`docs/design-2026-11-23-群角色上层-实施计划.md:261`），
四类里**群**那一类一直只在服务端成立。

## 2. 为什么静默：两处失效各有一个「不报错」的机制

1. **徽标那一格**：`h()` 对属性值是 `undefined` 的处理是整条跳过（`packages/web/public/group.js:28`），
   所以 `text: faceLabels[hit.face]` 取不到键时不是抛、也不是写 "undefined"，
   而是**压根不写这个属性** —— 徽标变成空白。
2. **落点那一格**：`openSearchHit` 是一串彼此独立的 `if`（不是 `if/else`，也没有 default 支），
   面名不在任何一条里时函数正常走完、`try` 正常返回、`catch` 不触发 ——
   没有 toast，没有 console。

两者合起来的后果是这一族的**通用形状**：一个只增不改的枚举（加面）在数据侧一路畅通，
到界面侧缺格时**不会有任何一层报错**。缺的不是「记得写」，是「少写时有人拦」。

## 3. 病根的形状：判据守的是「渲染侧有搜索这件事」，不是「每一面都有落点」

`test/arch/ui-caller-roster.ts` 那一族守的是【端点被不被碰】—— `/search` 有人调、
所以绿，它不问**七面各自有没有落点**。`test/web` 里此前的源扫描守卫（renderer-criteria
一族）守的是各条 CSS/渲染准则，也不问面名单。全仓 grep `globalSearch` 与 `/search`
在 `test/e2e`、`test/web` 下**零命中**（0076 落地前）—— 搜索这一族在自动化里从来没有过
任何一发判据。所以这不是「判据写错」而是**判据不在场**：它失明不是因为口径缺维
（0075 那种），是因为压根没量。

## 4. 落地：补两格 + 一行身份属性，落点沿用既有肌肉

- **徽标**：`packages/web/public/group.js:124` 补 `group: "群"`，键序与 `SEARCH_FACES`
  逐一对齐（守卫把顺序也钉住：同一时刻的命中按面归组时，键序就是阅读顺序）。
- **落点**：`packages/web/public/group.js:9063` 直接调 `selectGroup(hit.id)`。
  第一版我写的是自己找会话（`state.conversations.find(...)`）+ 找不到再落群详情 ——
  那是把 `selectGroup` 内部已经有的那一步（`packages/web/public/group.js:6464`）
  抄了一遍：既有函数本来就会「找群会话并进去，没有会话才落群详情」。抄一遍得到的是
  同一段逻辑有两个答案（侧栏点群和搜索点群各走一份），所以改成复用。
- **身份属性**：`packages/web/public/group.js:9012` 与 `packages/web/public/group.js:9013`
  给每行加 `data-face` / `data-id`。这一条不是为测试加的装饰，是 e2e 第一次真点搜索行时
  当场暴露的：群的章程文档标题 == 群名（建群时服务端一并建章程），所以按标题文本挑行会
  挑到**文档那一面**的那一行 —— 首跑就是红在徽标读出「文档」。同一时刻屏幕上可以同时
  存在「同名的群」和「同名的文档」，行自己必须说得出【我是哪一面、哪一条】。

服务端一行没动：七面 SQL 与七面 Set 断言早就在场（M5 实测能红，见 §6）。

## 5. 判据：一发闭环 e2e + 一道源扫描奇偶守卫

**e2e**「全局搜索群命中：徽标是「群」且点击真落到该群会话」
（`test/e2e/group-workbench.spec.ts:2518`）：真建群 → 切走（停在消息页时刚建的群
本来就是选中会话，剪掉分支也会因为已在原地而假绿）→ `#globalSearch` 输入群名 →
先断言服务端响应里真有 `face:"group" && id==新建群` 那一发（否则后面绿的是「压根没群命中」）
→ 按 `data-face="group" data-id=<群 id>` 挑行、断言徽标 `群` → 点击 →
断言 hash 变成 `#/messages/<那条群会话>` 且群会话面板画出来。会话 id 从
`GET /conversations` 现读，用例先断言它非空：前提不成立时红在前提，不冒充「分支缺失」。

**守卫** `test/web/search-face-parity.test.ts`（`group.js` 顶层就 `boot()`、
零 `export`，vitest 导不进来 ⇒ 沿用 renderer-criteria 的源扫描形状）。两个提取器
（`test/web/search-face-parity.test.ts:45` 取 `faceLabels` 键、
`test/web/search-face-parity.test.ts:55` 取 `hit.face === "x"` 的面名）做括号配对取材，
钉三条：键集 == `SEARCH_FACES`（含顺序）、面集合 == `SEARCH_FACES`（反向也不许多出面外面名）、
以及**提取器自己有判别力**（抹掉真字节后两个提取器都报缺口 + 原文件各取到七项 +
取不到对象时是抛不是悄悄返回空数组）。最后那条是家法：源扫描守卫不自证判别力就是恒绿装饰。

它守的是【奇偶】：新加一面而渲染侧不动 ⇒ 当场红。它不守文案对不对、落点跳得准不准
（那两半在 e2e 那一发里）。

## 6. 变异机 8 红 + 2 控制绿

`.workbuddy/round391-mutation.mts`（vitest/playwright 双 runner；锚点唯一性预检 +
未变异三侧预检绿 + 每发自己 `finally` 还原 + 单发 sha256）：

- M1 摘 `group` 标签键 ⇒ 红（徽标）；M9 同一发打奇偶守卫 ⇒ 红（报缺口）；
- M2 摘 `group` 分支 ⇒ 红（落点）；M10 同一发打奇偶守卫 ⇒ 红（报缺口）；
- M3 分支退回丢 id 的旧写法（`location.href = "/"`，即 `task` 那一面今天的形状）⇒ 红；
- M4 `data-face` 写死成 `document`（面这一维不参与挑行）⇒ 红 —— 证的正是 §4 那次首跑事故；
- M11 往 `SEARCH_FACES` 加一面而渲染侧不动 ⇒ 奇偶守卫三条全红（新面不会静默漏格）；
- M5 服务端群面 `OR` 写 `AND` ⇒ 红，红在服务端那条七面 Set 断言，证明 §4 末句「服务端
  本来就有人守」不是套话；
- C1 只在 `openSearchHit` 上方加无关注释 ⇒ 绿；C2 只在守卫说明注释里加一行 ⇒ 绿。

**删掉的三发**（原 M6–M8「把判据改宽」）：判据改宽在未变异源码上必然仍绿，叠上真缺口时
它红的是【守卫自己的锚点自检】而不是那条被改宽的断言 —— 红错原因的变异比没有变异更贵，
它会让下一个人以为那条线有人守。守卫的判别力改由 §5 那条自证发负责，不在这里叠发。

收尾逐文件逐字节核对还原一致。

## 7. 记下来但没动的

- **`task` 那一面的落点仍然是 `location.href = "/"`**（`packages/web/public/group.js:9066`）：
  命中里有 task id，落点丢掉它跳到首页。真正的任务看板在控制室（`app.js` 的 `renderBoard`
  + `openDrawer`，hash 协议 `#/admin/board`、抽屉靠 `?id=` 的是回放页而不是看板页），
  要让搜索命中的任务落进看板，需要给看板页加一枚「按 id 直接开抽屉」的 query 语义 +
  group.js 侧一条不二次编码的 hash 通路 —— 那是控制室的地址协议变更，不属本篇一发。
  奇偶守卫只钉「有没有分支」，所以 M3 那种「有分支但丢 id」的形态守卫不报，是 e2e 报的。
- **模板/成员的删改入口、成员离职界面入口、`GET /api/v1/assets/:id` 的 nosniff/CSP**：
  0074/0075 §7 记过，原样保留。
- **搜索没有「按面过滤」的界面**：契约 `faces` 参数（最多 7 个）服务端支持、界面永远传全部。
  要不要在界面上给一排出入口属产品拍板。

## 8. 实跑读数

- 新 e2e 单跑绿；变异机 **8 发该红全红 + 2 控制组绿**（预检未变异三侧绿：playwright
  1 passed、hub 搜索测试 3 passed、奇偶守卫 3 passed），收尾「还原：全部逐字节一致（sha256 核对过）」。
- 新守卫单跑 **3 passed**。`tsc -p tsconfig.test.json --noEmit` exit 0；
  biome 对本篇三处改动文件（`group.js` / 新守卫 / e2e）**0 诊断**（格式由 `--write` 收的）。
- **全量**：`vitest run` **202 文件 / 4219 passed / 6 skipped**（201 文件基线 + 本篇 1 个
  新守卫文件；断言数 +3 = 守卫三条）；Playwright 全量 **61 passed**（60 → 61）。
- `group.js` `node --check` 通过 · U+FFFD 台账与 INDEX 各 **0**。
- ⚠ 实跑读数见文末「实跑校正」一节 —— 上面那组「全量」数字是写台账时的**预估**，未跑先写。

## 9. 实跑校正（数字以本节为准）

- **§8 里「`tsc -p tsconfig.test.json --noEmit` exit 0」这一条当时是假的**：那条命令挂着管道尾巴
  （`... 2>&1 | tail -5` 之后读 `$?`），拿到的是 `tail` 的退出码，`tail` 永远是 0 —— 同一分钟日志里
  躺着一条真错：本篇新写的 hash 断言用了页内闭包 `page.evaluate(() => location.hash)`，在
  `types:[node]` 下 `location` 未定义（TS2304）。这是家法里「页侧探针一律字符串形态」的第三次撞，
  而且是我自己刚在台账里写过这条家法之后又撞的。改成字符串形态（本仓 rich-editor 那支 e2e 早已用
  同一个形状写 hash）后 tsc 两门 exit 0。
- **全量自己独立抓到了同一条错**：`test-type-baseline` 报「出现了基线外的测试目录（test/e2e=1）」——
  它的口径是「e2e 目录的类型错必须先点名」，红的是我这条新错而不是要把 e2e 登记进基线（**登记=放行
  新种类**，与 0073 的 lint format 同族判断：修代码，不动基线）。改完该发 **26 passed**。
- **手工探针留下的守卫改动**：为验证「EXEMPT 键失效会不会红」手动改过 `docs/review/` 那个开放项
  校验脚本，变异机自己会还原、**手动改的不会**；提交前逐条认 `git status` 才拦下来，已还原。
  ⇒ 认账顺序是「先看 M 名单里有没有【不该动的守卫】」，而不是看行数。
- 变异机在**最终字节**上重跑（判据里的 hash 探针换了形态，早先那组读数量的是旧测试文件）：
  预检未变异三侧绿（playwright 1 passed / hub 搜索 3 passed / 奇偶守卫 3 passed）；
  **8 发该红全红**（M1 摘 label 键、M2 摘分支、M3 退回 `location.href="/"`、M4 `data-face` 写死、
  M9/M10 同两处源码变异打守卫、M11 往 `SEARCH_FACES` 加一面 ⇒ 守卫三条全红、M5 服务端 `OR`→`AND`
  红在七面 Set 那一发）+ **2 发控制组绿**；收尾「全部逐字节一致（sha256 核对过）」。
- **全量实跑**（修完 §9 头两条之后重跑）：`vitest run` **202 文件 / 4219 passed / 6 skipped**
  （0075 基线 201 文件 / 4216 passed ⇒ +1 文件 = 新守卫、+3 = 守卫三条）；Playwright 全量
  **61 passed**（0075 是 60 ⇒ +1 = 本篇那一发）。`test/arch` 全量 **38 文件 / 613 passed** ·
  `verify-open-invariants` **SUCCESS**（提交引用全部可解析）· `check-gate` **判不了或不符 0** ·
  `node --check group.js` / `app.js` 通过 · U+FFFD 台账与 INDEX 各 **0**。
