# 0077 · 会话历史的服务端早就认游标，界面却一次也没发过它 —— 「只有 200 条」看起来像历史本来就这么长

**日期。** 2026-11-27（round392）。
**落地。** `packages/web/public/group.js`（`MESSAGES_PAGE_LIMIT` / `historyHasMore` /
`historyCursor` / `retainOlderThan` / `applyHistoryWindow` / `loadOlderMessages` /
顶端的「查看更早的消息」/ 消息行补 `data-seq`）；`packages/web/public/group.css` 补
`.history-more`；新守卫 `test/web/history-cursor-producer.test.ts`（游标有没有真被发出去
+ 背景重读不许吞窗口）；新链路用例 `test/e2e/group-workbench.spec.ts` +1（满一页 →
带游标 prepend → 到底收起 → 背景重读后窗口还在）；证据
`.workbuddy/round392-mutation.mts`（变异机 13 红 + 2 控制）。

## 1. 一句话

契约把「往旧翻」的游标声明好了（`packages/contracts/src/conversation.ts:110` 那句
「会话历史翻页：before_seq 游标（往旧翻），limit 有界防全表拖取」），服务端实现了它
（`packages/hub/src/conversations/service.ts:260` 的 `seq_in_conv < ?`），HTTP 层把
`req.query` 整个递进去（`packages/hub/src/http/social.ts:152`），服务端测试还专门钉过
游标语义（`packages/hub/test/conversations/service.test.ts:783` 断 `before_seq:4 limit:2`
拿到 `[2,3]`）。**渲染侧一个字都没发过**：`git show HEAD` 的 `packages/web` 里 grep
`before_seq` 命中 **0**，会话历史一共三发请求，两发写死 `?limit=200`、一发不带查询串。
后果是静默的：超过 200 条的会话在屏幕上永远只有最新那 200 条，既不报错，也没有
「还有更早」的迹象 —— 读起来和「这个会话就聊了这么多」一模一样。

## 2. 为什么静默：断点落在没人负责的那一层

1. **服务端那一侧全是好消息**：游标是 `?` 占位、缺省时走 `(? IS NULL OR ...)` 恒真，
   所以「不传游标」是一条完全合法的请求，返回最新一页；`limit` 有契约上界（1..200），
   于是「传 200」也合法。**没有任何一层会因为「客户端停在第一页」而响。**
2. **界面这一侧的覆盖是整体赋值**：`loadMessages` 拿到一页就 `state.messages = ...`，
   数组换掉、屏幕重画，看起来一切正常。要翻页得有人把「已加载的最旧那条的 seq」记下来
   并发第二发 —— 这个状态在 0077 之前压根不存在，所以连「记错了」都谈不上。

合起来是这一族的通用形状：**一个「服务端可选参数」零生产者时不会有任何一层报错**。
契约、服务、路由、测试四层各自都成立，缺的是第五层（有人真发它），而缺它的症状恰好
与「数据本来就这么点」逐像素相同。

## 3. 病根的形状：判据守的是「历史读得到」，不是「读得到更早的」

同族的 `ui-caller-roster` 守端点被不被碰（`/conversations/:id/messages` 当然有人调），
`test/web` 的源扫描守渲染准则，e2e 里此前只发过一条消息再看它出现 —— 全都只判
「最新那一页到没到」。全仓（0077 落地前）没有任何一发判据出现过第二个
`/messages` 请求，更没有一发读过 `before_seq`。所以这一格不是测坏了，是从未量过。

## 4. 落地：判据、游标、覆盖入口各一格，再加一个按钮

- **判据与游标分开写**（`packages/web/public/group.js:639` 的 `historyHasMore` 与
  `packages/web/public/group.js:653` 的 `historyCursor`）。这不是风格，是沿用
  `packages/web/public/app.js:2924` 的 `replayHasMore` 那一对已定盘的形状：
  判据写错 = 按钮永不出现（或到底了还留着），游标写错 = 每次翻同一段 / 静默跳过一段。
  两者叠在一起，红了归不了因。判据是「这一页返回的条数满不满一整页」，⚠ 不能用
  `state.messages.length` —— 那是累计已加载，翻过一页之后它早就不等于本页条数。
- **`applyHistoryWindow`**（`packages/web/public/group.js:689`）= 重读消息数组的唯一入口，
  数组、游标、「还有更早」三格一起重算，并且**只保留该保留的**。落地时首屏读取有两处
  （`packages/web/public/group.js:2118` 的 `loadMessages`，以及 `runRefreshAll` 里
  「用户正在输入框里」那个替身），首版我只在 `loadMessages` 里补了重算 —— 第二处也是
  整体覆盖，游标会指着一条已不在数组里的消息，下一发 `before_seq` 就从错误位置往旧翻
  （静默跳过一段历史）。守卫 `test/web/history-cursor-producer.test.ts:96` 因此钉
  「整条覆盖赋值只剩那一行定义」，把第二处也逼进同一个入口。
- **同会话重读不许吞掉已翻出的那段**（`packages/web/public/group.js:671` 的
  `retainOlderThan`）。这一格是**实跑撞出来的**，不是设计时想到的：首版
  `applyHistoryWindow` 无条件 `state.messages = list`，变异机预检（未变异必须绿）
  连红两轮，第五根线（§5）红在「到底后按钮已收起」。病因是背景刷新（SSE 事件、发送后
  补拉、输入框聚焦补拉）读的是**最新一页**，它不知道用户已经往旧翻过：整体覆盖把刚翻出来
  那段吞回去，游标退回最新页、`messagesHasMore` 按满页重算回 true —— 屏幕上就是
  「历史凭空少一截 + 已收起的按钮自己复活」，且都不报错。修法是三格各钉一件事：
  ① 保留 `seq_in_conv` 小于本页最旧那条的行；② 窗口按 `conversation_id` 认主
  （换会话才是换一屏，旧会话翻出来的那段与「到底」的结论都不许带过去，否则新会话的按钮
  会凭空收起）；③ 有保留段时 `messagesHasMore` 维持原值 —— 最新那一页满不满 limit
  只能证明它自己下面还有没有东西，证明不了用户已翻到的那段之外还有。游标取**合并后**
  的整个窗口（取新来的那一页 = 游标退回，同一段会被再要一遍）。守卫
  `test/web/history-cursor-producer.test.ts:173` 把判据建在这个函数体上（不是散文上），
  五条各自点名，负向一发改退回「无条件整体覆盖」那一版 ⇒ 五条逐条报缺口。
- **`loadOlderMessages`**（`packages/web/public/group.js:2183`）发第二发，按服务端
  docstring 说的 prepend（`fresh.concat(state.messages)`，不许 reverse、不许整体覆盖），
  游标只许单调变小、空页不清空。**不抢 `renderToken`/`messageRequestToken`**：它既不是
  新快照也不是切会话，抢 token 会让并发在飞的 `loadMessages` 白投一次；本发只靠
  `conversation_id` 自证结果还属于当前会话。按 `message_id` 去重兜住翻页窗口与 SSE
  推送重叠那一瞬。视口锚点取「视口顶到内容底的距离」，prepend 之后按同一差值还原，
  否则每点一次「更早」屏幕就跳走。
- **按钮**（`packages/web/public/group.js:2606`）挂在消息循环之前 = 流的最顶端；
  `messagesHasMore=false` 时这一格根本不画，不留一枚点了空手而回的按钮。
- **`data-seq`**（`packages/web/public/group.js:2659`）：消息行带自己那条的会话内序号。
  这一条同样不是为测试加的装饰 —— 翻页的正确性唯一可判的形态是「首行是最早那条」，
  而文案相同的历史消息（同一句「收到」聊 50 遍）在屏幕上长得一样；序号是服务端事实，
  判据不靠渲染时刻的几何、也不靠文案 uniqueness。

服务端与契约一行没动：游标语义早就有人守（M8 实测能红，见 §6）。

## 5. 判据：一发闭环 e2e + 一道源扫描「有没有真发」守卫

**e2e**「会话历史翻页：满一页后有「查看更早」，点击带游标 prepend 且到底收起」
（`test/e2e/group-workbench.spec.ts:2585`）：建一个**不带成员**的群（`routeGroupMessage`
在没有成员时立刻返回 `cos_missing`，一次 POST 恰好落一行、不叫模型），从页面里连发
201 条 ⇒ seq 是 1..201（建群本身不写消息）。随后**先切到文档页**再播种，避免在飞的
`loadMessages` 把 prepend 结果又覆盖回去（这是首版假红的病因，就是 §4 第三条那格）。断言顺序：

1. 服务端权威读数：`GET ?limit=200` 拿到的就是 200 条、seq 从 2 到 201、且升序
   —— 先把「首屏确实被截断了」钉住，否则后面绿的是「压根没截断」；
2. 屏幕上有 `#load-older`，且 `.message-row` 是 200 行、第 1 条不在屏上
   （下面 2–7 各条都读 `settledChatFrame` 的同一帧快照，判据写在【哪一帧】见本节末⚠）；
3. `waitForResponse` **挂在点击之前**，谓词要求 pathname + `searchParams.has("before_seq")`
   + ok（只比 pathname 会被 SSE 触发的普通 GET 满足）；
4. 发出去的 `before_seq` 严格等于 `"2"`（不是「有个游标」，是**最旧那条的 seq**）；
   响应里恰好 `[1]`；
5. 屏上第一行的 `data-seq` 是 `1`、文案是那条史前消息，行数 200 → 201，`data-seq`
   序列整体升序（prepend 而不是 append）；
6. 到底后 `#load-older` 消失（短页收起）；
7. **到底后逼一次背景整页重读**（点「刷新消息」，走 `runRefreshAll` ⇒ 与 SSE 事件同一条
   `loadMessages` 路径），`waitForResponse` 同样挂在点击之前、谓词要求那一发**不带**
   `before_seq`；重读之后按钮仍不存在、行数仍 201、首行仍是那条史前消息；
8. 外加 `expectNoBrowserErrors`。

第 7 条不是「多加一根线」：它是这一发唯一量到「翻出来的历史还在不在」的时刻。首版判据
只量到点击之后那一次，于是同一缺陷在变异机预检里红了两次而我一度当成 flake ——
「一次通过、下一次 6 秒超时」的差异正是背景刷新落在哪一瞬的竞态（第 9 节记了这次归因）。

**守卫** `test/web/history-cursor-producer.test.ts`（`group.js` 顶层就 `boot()`、零
`export`，vitest 导不进来 ⇒ 沿用源扫描形状）。它守的是【有没有真发这个参数】：
`test/web/history-cursor-producer.test.ts:61` 把每发 `request(` 的第一个参数按 `+`
拼接后的 URL 模板整段取出、`${}` 归一成 `?`，于是参数的**名**参与匹配、**值**不参与。
钉三条：契约参数名（取自 `listMessagesQuerySchema.shape`，不另抄名单）里必须真有
`before_seq` 出现在发出去的参数名里；发出去的名字必须全在契约里（拼错一个字母 =
服务端按未知参数忽略，界面还会以为翻了页）；带游标那一发的值必须是插值（写死一个数 =
每次翻同一段）。再两发判 §4 那个重读入口：一处是「覆盖赋值只剩那一行定义 + 入口的
第一实参必须是会话 id（传数组进去等于绕过窗口归属）」，一处是函数体上那五条保留段判据。
判别力自证放最后一发（抹游标 ⇒ 报「没人发」、拼错 ⇒ 哨兵点名、绕开入口 ⇒ 清单报出
第三处且入口调用少一处、整体覆盖版 ⇒ 五条逐条报缺口、窗口属主改成 `!==` ⇒ 报缺口、
拿不到对象 ⇒ 抛而不是返回空数组）。

⚠ **首版栽在「只取第一段模板」**：翻页那发的 URL 是两段模板拼出来的
`` `/conversations/.../messages` + `?limit=..&before_seq=..` ``，只取第一个反引号段的
提取器永远看不见游标 —— 它会在游标恰好位于第一段时通过，也就是**只有写错时才红**。
改成括号/反引号扫描器（`test/web/history-cursor-producer.test.ts:32`）整段取参数再拼接。

⚠ **判据读错了帧（本轮第二个实跑教训，比第一个更隐蔽）**：上面第 2/5/6/7 条首版写成
一条条 locator 轮询（`toHaveCount` / `toHaveText`），第二轮变异机上 M3/M5/M11 竟报**绿**
—— 而同一发源码手跑必红。根因不在判据太松，在**读的是哪一帧**：`loadMessages` 成功路径
先置 `state.messageLoading=true` 再 `renderChat`，那一帧是骨架（`.skeleton-chat`，
`.message-row` 是 0 行、`#load-older` 也不在）。locator 轮询各自跨帧求值，于是
**【缺席类】判据会被骨架帧凭空喂饱** —— 「按钮消失」这一发在骨架帧里天然成立，
绿的是「正在加载」而非「到底收起」。这不是 flake：缺席要成立，必须【在正文帧里】缺席，
骨架帧的缺席不是证据。修法是把五根线全改成一次求值读全六项的【同一帧原子快照】
`settledChatFrame`（骨架帧一律不算数），且**每根线的等待条件点名它自己在等哪一帧**：
首屏线等到 `rows===200`、翻页线等到 `rows===201` —— 若只写「非骨架 + 有行」，会被点击
之前就存在的旧正文帧喂饱，等于没量到动作之后。第五根线更特殊：正确代码下背景重读前后
屏幕【逐像素相同】（`retainOlderThan` 的存在就是为了这个），内容分辨不出读了哪一帧，
只能靠**帧号自证** —— 探针给每次重画的 `.message-stream` 盖一个单调递增的 `data-frame-mark`，
第五根线先领一次号、再要求读到的是**新号**，否则 M9 的缺陷帧（行数掉回 200）恰恰会被
「等到 201」这类条件跳成超时、反而放过。这条与 round391/0076 的同族教训同形：
**绿了 N 轮的判据可能从没成立过 —— 绿来自量错时刻**；判据的尺子必须与被剪线有因果，
且量的是【该动作之后的那一帧】。三发现在手跑下单发红在该管的字段（M3 红 `button`、
M5 红 `firstSeq`、M11 红第五根线 `button`、M9 红 `rows`），复跑见 §6。


## 6. 变异机

`.workbuddy/round392-mutation.mts`（vitest/playwright 双 runner；锚点唯一性预检 +
未变异三侧预检绿 + 每发自己 `finally` 还原 + 单发 sha256 + 每发完整读数落盘）：

- M1 抹掉翻页 URL 里的游标 ⇒ e2e 红（等不到带 `before_seq` 的那一发）；M6 同一处源码
  变异打守卫 ⇒ 守卫必须报「契约参数零生产者」；
- M2 游标写成字面量 `1` ⇒ e2e 红（发出去的不是 `"2"`）；M6b 打守卫 ⇒ 报「读的不是游标本身」；
- M3 判据丢掉「满一整页」⇒ e2e 红在「到底后按钮收起」；
- M4 首屏不重算游标 ⇒ e2e 红（按钮压根不出现）；M7 同一族退回直接赋值 ⇒ 守卫点名第三处覆盖；
- M5 prepend 改成 append ⇒ e2e 红在首行 `data-seq`；
- M8 服务端 `seq_in_conv < ?` 写成 `<=` ⇒ 红在服务端既有那发 `[2,3]`，证明 §4 末句
  「服务端本来就有人守」不是套话；
- **M9 保留段恒空（`const retained = []`）⇒ e2e 红在第五根线**：史前消息被吞回第一页 +
  按钮复活。这一发就是首版真字节自己撞出来的那个缺陷（§4 第三条），判据是缺陷的复现；
- **M10 窗口归属恒真 ⇒ 守卫报缺口**（不分会话就保留 = 换会话把上一群的「到底」结论带过去）；
- **M11 有保留段时仍按最新页长重算 `messagesHasMore` ⇒ e2e 红在第五根线**（到底的按钮复活）；
- **M12 游标取自 `page` 而不是合并后的 `list` ⇒ 守卫报缺口**；
- C1 只在 `loadOlderMessages` 上方加无关注释 ⇒ 绿；C2 只在守卫说明注释里加一行 ⇒ 绿。

M9/M11 两发的价值不在「又多两发红」，在于它们与预检是同一根线：预检（未变异必须绿）
在首版红了两轮，而这两发变异现在红在同一处 —— 说明判据确实挂在「背景重读后窗口还在」
这件事上，不是挂在别处的巧合。

不放「把判据改宽」那类发（0076 §6 的教训：它红的是守卫自己的锚点自检，
**红错原因的变异比没有变异更贵**）。收尾逐文件逐字节核对还原一致。

## 7. 记下来但没动的

- **背景重读会跳回底部**：窗口内容留住了（§4 第三条），但 `loadMessages` 成功分支里那句
  `stream.scrollTop = stream.scrollHeight` 仍会把视口拉到最新一条 —— 用户翻到旧史时若正好
  来一条新消息，屏幕会跳走。这一格真正的修法是「用户已不在最新位置时抑制跳底」，属滚动
  位置管理一整格（还要定「多近算在底部」的口径），不属本篇。**判据已先在位**：第五根线钉的是
  【数据与按钮】，跳底是视口问题，两者不混在一发里判（混了就归不了因）。
  【0078 已按这个口径落地：0078 单独装了滚动锚点那一族，容差口径、两把尺子的分工与
  「读锚点的时机」都在那里判；本篇的五根内容线一个字没改，只另加了一条实测几何线。】
- **首版把这条当成「有意取舍」写进本节**：原文是「保住用户翻到的窗口就得同时记住用户已经
  不在最新位置并抑制新消息跳底 —— 那是滚动位置管理一整格，不属本篇」。前一半是错的：
  保住窗口不需要滚动位置管理，只需要别把旧行覆盖掉（就是 `retainOlderThan` 那九行）。
  记这一条是因为**它的成因**：把「实测会红」的东西写成「取舍」之前，先问一句
  「这个取舍要花的钱是不是真的比修它贵」—— 这里答案是九行，不是「一整格」。
- **`limit` 界面写死 200（= 契约上界）**，没有「每页条数」的设置项；契约也只有
  `before_seq` / `limit` 两个参数，没有 `total`/`has_more`。所以「一共多少条」屏幕上
  无从显示 —— 要加得先加契约字段，不属工程可自决的一格。
- **模板/成员的删改入口、成员离职界面入口、`GET /api/v1/assets/:id` 的 nosniff/CSP、
  搜索 `task` 面深链、按面过滤界面**：0074/0075/0076 §7 记过，原样保留。

## 8. 实跑读数

- 守卫单跑 `test/web/history-cursor-producer.test.ts` **5 passed**；hub 会话服务端
  `packages/hub/test/conversations/service.test.ts` **23 passed**（未改动，作机器预检第三侧）；
  e2e 单跑（`-g 会话历史翻页`）判据改写后 **1 passed**，同一份最终字节上另有机器的预检一发
  与 Playwright 全量里的一发（共三次绿，读数 `round392-e2e-f1.log` + `round392-mut.log`
  预检行 + `round392-full-e2e.log`）；守卫单跑读数 `round392-guard.log`。
- **单发手跑先于机器整跑**（本轮新纪律，起因是 §5 末那个骨架帧漏检）：M3 红在
  `afterPaging.button`、M5 红在 `afterPaging.firstSeq`（2≠1）、M9 红在
  `afterRefresh.rows`（200≠201）、M11 红在 `afterRefresh.button`（true）——
  四发各红在【自己那根线负责的字段】，读数 `.workbuddy/round392-shot-M3.log` 等四份，
  探针 `.workbuddy/round392-shot.mts`（每发 finally 还原 + sha256 核对）。
- **变异机整跑**（`.workbuddy/round392-mutation.mts` → `round392-mut.log`）：预检未变异三侧绿
  （playwright 1 / 守卫 5 / hub 23）；**13 发该红全红**（M1–M5、M9、M11 走 e2e，M6/M6b/M7/
  M10/M12 走守卫并点名到具体那一条断言，M8 红在服务端既有 `[2,3]` 那发）+ **2 发控制绿**；
  收尾「全部逐字节一致（sha256 核对过）」，`group.js` 终态 sha256 前缀与本轮开工前的
  干净快照逐字节相同（前缀见机器 log 的还原行）。
- **全量**：`vitest run` **203 文件 / 4224 passed / 6 skipped**（0076 基线 202/4219 ⇒
  +1 文件 = 新守卫，其余增量是守卫与预检期间服务端计数的正常浮动）；Playwright 全量
  **62 passed**（0076 是 61 ⇒ +1 = 本篇那一发）。读数 `round392-full-vitest.log` /
  `round392-full-e2e.log`。⚠ **证据落盘一律 `.log` 不许 `.txt`**（house rule 复发实证）：
  verify 的 walk 收 `.workbuddy/**.txt` 而不收 `.log` —— 第一版按 `.txt` 存，verify 自己
  那次 SUCCESS 读数里带着豁免 token 回显，**下一次 verify 读到上一次的 log 判成腐烂**
  （自锁自检同族：量具吃自己的排泄物）。改名后首跑 + 复跑双双 SUCCESS。
- **门**：`test/arch` **38 文件 / 613 passed**（含 doc-refs 与 lint 棘轮）· tsc 两门
  （`tsconfig.test.json --noEmit`、`tsc -b`）exit 0 · biome 对改动的 spec 净新增 0 ·
  `node --check` group.js / app.js 通过 · `verify-open-invariants` **SUCCESS** ·
  `check-gate` **判不了或不符 0** · doc-refs 新登记 0077 活坐标 **18 条**，并把 0074/0075/0076
  被 `group.js` 顶下的 **9 条**统一 **+162** 重钉（值不动、只改键行号）· U+FFFD 台账与 INDEX 各 **0**。
