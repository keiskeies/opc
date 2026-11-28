# 0079 · 中栏筛选器每敲一个字符就多长一套控件 —— 清空那一格只做在调用方，handler 却在回调自己

**日期。** 2026-11-27（round394-395）。
**落地。** `packages/web/public/group.js`：`renderDocumentList` 与 `renderBacklogList` 各拆成
「一次性建控件」+「只重画行区」两半（新增 `paintDocumentRows` / `paintBacklogRows`，各自带
一句 `content.replaceChildren()`），三枚文档 handler 与一枚待办 handler 从回调自己改成只叫
paint；`packages/web/public/group.css` 不动；新守卫 `test/web/list-filter-repaint.test.ts`
（8 发：清空归属名单 + builder 不许叫自己/renderList + 四发 paint 各归各 + paint 拿不到工具条
+ `docFilter.kind` 第二写入点仍重建 + 把两半切进 `node:vm` 套手写 DOM 真敲两下 + 判别力自证）；
新链路用例 `test/e2e/group-workbench.spec.ts` +1（11 根线：控件份数 / 行份数 / 焦点在同一枚
节点 / 空态份数 / 换关键词 / 两枚下拉 / 滚动不动 / 切栏回来仍一份 / 待办同形三发）；证据
`.workbuddy/round395-wire-mutations.mjs`（变异机 10 发全红、逐发按 sha256 自还原）。

## 1. 一句话

`packages/web/public/group.js` 里的清空只有一处主人 —— `renderList` 的
`content.replaceChildren(); toolbar.replaceChildren();`。可 `renderDocumentList` 自己往
`toolbar` 里 append 搜索框和两枚下拉，它的 `oninput`/`onchange` 又叫回 `renderDocumentList`
本身：从 handler 进来的那一趟根本没过 `renderList`，于是**没有任何人清空**。用户敲「筛验」
两个字，实测读数 `searches 1→3`、`selects 2→6`、`trees 1→3`、`leaves 92`（真命中的只有 30 篇，
多出来的 62 枚是前几发用例往同一库里灌的名字撞词 + 每敲一下再挂一份树）。待办那一栏同形，
只是少两枚下拉。`renderList` 里那句 `toolbar.replaceChildren()` 恰好把「切栏一趟」洗得干干净
净 —— 所以这个缺陷在「点走再点回」之后看起来完全正常，只有连续敲才现形。

## 2. 为什么静默：4200 多发的判据没有一个看过 `#listToolbar`

`git show HEAD:test/e2e/group-workbench.spec.ts | grep -c listToolbar` = **0**。全部既有 e2e
断言的是内容（点了什么、出现什么文本、发了什么请求），`test/arch` 断言的是源码字节，
`test/web` 那几族守卫断言的是纯函数返回值。控件份数这一维**一个读者都没有** —— 控件长到 3 套
时，`page.locator('#listToolbar input[type=search]')` 撞上多枚会先抛 strict mode violation，
可既有用例从来没写过这个选择器，连抛都没抛过。

另一半原因和 0078 的「e2e 从没设过 `scrollTop`」一模一样：**用例里没有「连续敲」这个动作**。
既有的输入类用例都走 `fill()`（一次到位，只触发一次 `input`）或者干脆只敲一个字符，而这一发的
症状是「第二次及以后每一次重画都多一套」。所以本轮真正新增的能力不是那两行拆分，是把**控件份数
与节点同一性**变成可以被断言的量（页内 `querySelectorAll(...).length` 一次读全 + 给 input 打
`data-filter-probe` 标记）。

## 3. 病根的形状：拆分点该在「谁负责清空」，不在「谁负责画」

第一反应是「让 handler 去叫 `renderList()`」—— 那才是这条链路上唯一一个会清空的入口。份数确实
全对了，但这一发 M8 实测红在焦点那一格：**工具条每次被整个清空，用户正在敲的那枚 input 当场离开
文档**，`document.activeElement` 落在新生成的空框上，第二个字符凭空丢失。实测读数最骗人：敲完
「筛验」`searches 1`、`selects 2` 全绿，只有叶子数 `31` 而不是 `30` —— 查询退回「筛」之后多命中了
建群自动生成的那篇章程「立项：**筛**选器验收群」（它含「筛」却不含「筛验」）。这一发把「份数对」
和「用户还能不能打字」彻底分成了两格。

真正的拆分点是**清空的主人**：`renderList` 独占 `toolbar` 的清空权，行区的清空权下放给 paint。
于是控件的生命周期挂在「切栏 / 换路由」上，行区的生命周期挂在「筛选条件变了」上，两者不再互相
牵连。守卫里那一发「`paint` 的形参只有 `content`、函数体里不出现 `toolbar`」钉的就是这条边界：
一旦哪天有人给 paint 递进工具条，「行区重画不碰控件」立刻名存实亡。

## 4. 落地：两半拆法 + 一个第二写入点

`packages/web/public/group.js:1428` `renderDocumentList(content, toolbar)` 只 append 控件（一枚
搜索框 + 「文档类型」+「所属群」两枚下拉），收尾叫一发 `paintDocumentRows(content)`；
`packages/web/public/group.js:1490` `paintDocumentRows(content)` 自己 `content.replaceChildren()`
之后只画树或空态。待办侧 `packages/web/public/group.js:1679` /
`packages/web/public/group.js:1718` 同一形状。三枚文档 handler 分别落在搜索框
`packages/web/public/group.js:1438`、类型下拉 `packages/web/public/group.js:1449`、所属群下拉
`packages/web/public/group.js:1467`，待办 `packages/web/public/group.js:1686`
—— 四发全部只叫 paint，一发行都不叫 builder。

`state.docFilter.kind` 还有**第二个写入者**（人才卡那一格，它叫的是完整 `renderList()`）：那条
路径本来就要重建控件（换的是整栏语境），拆完之后仍然正确，但它是「一个状态有两个写入点、其中
一个只重画行区」的形状 ⇒ 守卫专门留一发：扫描 `renderDocumentList` 之外所有 `docFilter.kind`
写入，逐条要求它后面跟着一次 `renderList()`。

## 5. 判据：e2e 真敲 11 根线 + 源扫描/`node:vm` 守拆法

`test/e2e/group-workbench.spec.ts:3268` 这一发按写入链路灌 30 篇文档 + 24 条待办（标题统一带
「筛验」这个独占词 —— 中栏列的是**全部群**的文档，这台 hub 的库整份 e2e 共用，不按独占词筛就
永远算不出确定条数），然后走 11 根线。三处准备动作各是踩过一次才钉下来的：

- **必须真 `reload()`**：`goto("#/documents")` 只触发 `hashchange`，`state.documents` 还是建群那次
  读回来的旧读数（只有那篇章程），筛选永远命中 0 篇 —— 判据会红，但红的是我的准备没做对。
- **一律 `.first()`**：未修时筛选栏会排出一排同款控件，locator 撞多枚先抛 strict mode violation，
  红是红了，读数却是「locator 有歧义」而不是「控件长了几个」。计数全走探针的
  `querySelectorAll(...).length`，所以 `.first()` 不放松判据。
- **滚动用真滚轮 + `expect.poll` 等它停下来**：`scrollTop = N` 写多少读回多少（哪怕内容根本不滚），判据看着
  绿其实什么都没量；滚轮走合成器线程是异步的，要 poll 到位移真起来才继续 —— 而⚠ **等「起来」不够，要等
  「停下」**，基线读在动画半途它自己还在长（全量实测 `240` vs 基线 `120`，见 §6）。守卫滚动的那两发
  （线 7 / 线 10）刻意筛掉 0 条 —— 内容变短时浏览器自己会把 `scrollTop` 夹上去，「该留在原处」
  就没有唯一答案了。

守卫（`test/web/list-filter-repaint.test.ts`）与 e2e 的分工照 0077/0078 的形状：守卫管**拆法本身**
（清空归属、builder 不自调、paint 拿不到工具条、第二写入点重建），e2e 管**拆了之后真的只画一份**。
守卫最后两发把两半函数连同一份手写 DOM 替身切进 `node:vm` 真敲两下 —— 源扫描只证「字在」，证不了
「改完之后行区真的一份、控件真的一份、而且焦点那一枚还是同一个节点对象」（后者直接比节点同一性，
`find(toolbar, input)[0] === search`）。

## 6. 变异机

`.workbuddy/round395-wire-mutations.mjs`，10 发，每发真抹 `group.js` 字节 → 跑该线尺子 → 按 sha256
还原。全部 KILLED、还原一致，且每一发的失败读数各不相同（这是「每根线各有自己那次动作」的物证，
不是靠 `expect` 行号撞上去的）：

| 变异 | 剪的是什么 | 实测红在哪 | 读数 |
| --- | --- | --- | --- |
| M1 | 搜索框 handler 改回回调自己 | 线 1 控件不翻倍 | `searches 1→3` |
| M2 | 「文档类型」下拉 handler 同上 | 线 6 形态下拉 | `selects 2→4` |
| M3 | 「所属群」下拉 handler 同上 | 线 7 换下拉滚动不动 | `selects 2→4` |
| M4 | 抹掉 paint 的行区清空 | 线 2 列表不重复 | `trees 1→3` |
| M5 | 待办搜索 handler 改回回调自己 | 线 9 待办控件/行数 | `searches 1→3` |
| M6 | 抹掉待办 paint 的行区清空 | 线 9 待办控件/行数 | `rows 24→72` |
| M7 | 抹掉 `renderList` 的 `toolbar.replaceChildren()` | 线 8 切栏回来仍一份 | `searches 1→2` |
| M8 | 被否决的那个修法（handler 叫 `renderList`） | 线 3 焦点/同一枚节点 | `focusInToolbar true→false` |
| M9 | 给 `paintDocumentRows` 递进工具条 | 守卫「paint 拿不到工具条」 | 形参 `(content)`→`(content, toolbar)` |
| M10 | 往待办 paint 里塞一句 `content.scrollTop = 0` | 线 10 待办滚动不动 | `scrollTop 120 → 0`（行数仍 24，只有视口被抹） |

四处值得记的，加机器自身的两处：

- **M8 一开始红错了格。** 第一版把焦点那组断言排在叶子计数**之后**，于是 M8 红在读数 `31`
  的线 2 上，焦点那一格没有自己的那次动作。把焦点组挪到计数之前（并在注释里写明为什么这个顺序
  本身是判据），M8 才红在 `focusInToolbar false`，而 `31` 那一发归回线 2。判据顺序在「一发变异同时
  破坏两格」时不是风格问题。
- **`focusTag === "INPUT"` 与 `focusInToolbar` 都认不出节点被换过。** 整栏重画后焦点落在一枚崭新的
  input 上：标签一样、也还在工具条里，两根读数全绿。所以尺子换成节点同一性 —— 敲之前给当前那枚
  input 打 `data-filter-probe`，敲之后读 `document.activeElement` 身上带不带这个标记。
- **同名锚点会把连环替换坑了。** `await selectGroup(hit.id);` 与 `location.href = "/";` 在重钉坐标时
  一个的**新行号**恰好是另一个的**旧行号**（都是 9092）⇒ 逐条 `replace` 串了两跳，两条引用一起指错，
  而且 `SNAP` 是对象字面量，重复键静默折叠后守卫照样绿。改成「一趟扫完、替换产物不再参与匹配」的
  合并正则，外加一发按内容逐条核对 SNAP 键的自证（`键数 29 / 问题 0`），才抓出来。
- **滚动基线读在动画半途 ⇒ 单跑全绿、全量恒红。** 两台尺子（线 7 / 线 10）都先用
  `scrollListDown` 滚一下再拿那一眼当基线，而它只 poll 到 `scrollTop > 0` 就返回 —— 滚轮落在合成器
  线程上，`> 0` 满足的那一刻位移还在长。全量第 46 发实测：基线读到 `120`，动画落定是 `240`，于是
  「敲完滚动不动」那一发红在 `expected 240 to be 120`；同一份字节单跑连绿（机器空、第一次 poll 之前
  动画已经走完）。这类判据没有一根是错的，错的是取基线的**时刻**，所以它的症状是「只在负载下红」——
  最容易被人当成环境抖动绕过去的那一种。判定改成「相邻两次读数相同且 > 0」再取基线（还在动就继续等）。
  ⚠ 修完不能就此收工：等过头会把缺陷一起等掉，所以补了 M10（往 paint 里塞一句 `content.scrollTop = 0`），
  它必须仍红在**线 10** —— 实测 `KILLED（红在：线 10 待办：滚动位置留在原处）`，新基线既稳又还认得出真被抹零。
- **归因表从 spec 现推，不写死行号。** 这台机器要把「哪一根线先红」报出来，第一版是一张手抄的
  `[起, 止, 线名]` 表 —— biome 一次格式化把它整体挪了 1 行，于是每一发都多报一根不相干的线。
  区间锚点改成 spec 自己那些 `// 线 N（…）` 注释（判据本来就是判据的一部分，注释在表就在），
  找不到 8 条注释就直接抛 —— 判据注释被改掉时机器该停，而不是拿旧表继续报。
- **守卫那一族没有 spec 行号可归，别糊成「未归类」。** M9 的尺子是 vitest，第一版报
  `（未归类，实跑行号 ）`：那一格应当报【哪一发 it 红了】。改成认 vitest 的失败用例名，而它给
  `×`、用例名、耗时分别上色，颜色码夹在中间 ⇒ 按整行锚定的正则一条也配不上（第一版就此报
  「认不出发名」），先剥 ANSI 再匹配才拿到「行区重画拿不到工具条：paint 的签名里只有 content」。

## 7. 记下来但没动的

- 其余长栏（会话 / 联系人 / 人才 / 设置）仍由 `renderList` 整栏重画 ⇒ 每次切栏都跳回列表顶部。
  本轮只给「带输入控件的两栏」拆了行区，因为它们才有「正在被敲的节点」这一格。
- 界面读列表是整份拉回再在内存里筛（`packages/web/public/group.js:997`
  `/documents?limit=100`、`packages/web/public/group.js:972` `/backlog?limit=200`），
  服务端 `listDocuments(deps.db, req.query, BOSS)` 认查询参数、界面一个都不发 ⇒ 100 篇之后的文档
  搜不到。这就是 0077 那个游标形状换了个面重复。
- 搜索命中 `task` 面仍旧 `location.href = "/"`
  （`packages/web/public/group.js:9343`），0076 §记下来但没动的 里就挂着，仍未接。
- 全站 grep `X-Content-Type-Options` / `nosniff` 命中 **0** —— 资产读取没有这个响应头。
- `docs/review/check-gate.mjs` 的 C7 存量分布扫的是 `git ls-files docs` ⇒ **未跟踪的新台账压根不进
  那份计数**（本轮实测：本篇有 6 处轮次相对说法，而它没出现在 0079 之前的分布里）。C7 判失败只看
  【入口】那一份，所以门禁结论不受影响；但「存量共 N 行」不是【语料有多大】的答案，而是【已入库
  语料有多大】—— 未提交前拿它当基数复算会差一整篇。改成扫文件系统会牵动那条计数的历史可比性，
  属门禁自身的口径变更，另案。
- 待办那一栏只有一枚搜索框，所以文档侧的下拉两根线（M2/M3）在待办侧没有对应物；真要补的是待办的
  「按群筛」，那是功能缺口不是本轮形状。⭐ 0080 已按这个口径落地（state 升格 `{ q, group }` +
  下拉 + AND 谓词，M2/M3 在待办侧自此有了对应物 N2/N3），本篇 11 根线一个字没改、待办三根
  （线 9-11）仍是关键词那一头的形状。

## 8. 实跑读数

- 修复前红探针（`test/e2e/group-workbench.spec.ts` 单发）：`1 failed`，
  `{"searches":3,"selects":6,"trees":3,"leaves":92,"emptyStates":0,"focusInToolbar":true,
  "focusTag":"INPUT","searchText":"筛验"}`。⚠ 注意 `focusInToolbar` 与 `searchText` 是**绿的** ——
  缺陷本体（自递归追加）并没有换掉正在敲的节点，追加的那一排是**新增**兄弟；丢焦点是**被否决那个
  修法**的症状，不是缺陷的症状。这一点写进 `packages/web/public/group.js:1428` 上面的注释，免得
  后来人以为「修好焦点」就是修好了这一发。
- 修复后 e2e 单发：`1 passed (4.0s)`。
- 新守卫：`Tests 8 passed (8)`。
- 变异机：`合计：killed 10/10，还原一致 10/10`（`WIRE_DEBUG=1` 逐发核对过失败断言行号与读数，见 §6 表）。
- `npx tsc -b` 与 `npx tsc -p tsconfig.test.json --noEmit`：两门 exit 0（页侧探针一律字符串 IIFE，没有用 `!`）。
- `test/arch/doc-refs.test.ts` / `claim-coords.test.ts`：全绿。本轮 `group.js` 净增 29 行 ⇒ 1648 行
  之后的 `group.js` 坐标全体重钉（0074 1 处、0075 4 处、0076 6 处、0077 4 处、0078 7 处 + SNAP 29 键
  按当前真实行内容逐条重 grep）；0079 新登记活坐标 **12 条**。⚠ 台账里的坐标引用一律写
  `文件:行号` 全形式：提取器只认带扩展名的 `file:line`，散文里省成 `:1467` 那种裸行号
  **不进快照、也不判** —— 看着像引用，其实是下一轮重钉时的漏网之鱼（本轮 §4/§7/§8 初版就是这么写的，
  补全后 SNAP 才拿到这 12 条）。另加一发 SNAP 键重复自检（`.workbuddy/round395-snap-dup-audit.mjs`）：
  对象字面量的重复键静默折叠 ⇒ 守卫按 `Object.keys` 遍历孤儿，被顶掉那条压根不在表里，
  于是「一条键写两遍」会让两条引用同时失去快照。本轮实测 301 键 / 重复 0。
- ⚠ **verify 与全量 vitest 并发 ⇒ 两发假红**（本轮实跑撞上，是「全量中勿跑 verify 系」的第三次复演，
  这次病因完整复原了）：`test/arch/exempt-pierce.test.ts` 的穿透探针在【磁盘上】临时改
  `docs/review/verify-open-invariants.mjs` —— 把豁免项 `["83697c`+`4", …]` 整条删掉、把 `"521daf21"`
  换成非 hex 的 `"zzzzzzz"`，spawn 子进程验完再逐字节还原。我在全量还在跑的时候起了 verify，正好落进
  那个窗口，于是同一趟红两条：① `83697c`+`4 @ .workbuddy\scratch\unit-run.txt:669 | 离真提交 83697c3
  只差一位`（豁免项刚被探针从表里删走，而 `83697c3` 是真提交 ⇒ ①d 直接算腐烂、不进任何跳过桶）；
  ② `zzzzzzz 在被扫 prose 里从不作为 token 出现`（探针注入的脏基准自己成了「从未出现」的豁免条目）。
  ⇒ **判定**：撞红先 `git status` 看 `M docs/review/verify-open-invariants.mjs`、`ps` 看有没有 vitest
  还活着，两样都干净再裸跑一发；本轮还原后裸跑 `exit 0`（腐烂=0，豁免表 17 条条条承重）。
  **别去动豁免表、也别删那份 scratch**：`.txt` 在采集面里（`walk` 收 `.txt|.md|.mjs`），删掉只是把
  这一格变成「没有读者」，而那正是本轮 §2 判的静默成因。
- ⚠ 上面那个假哈希在本篇一律写成 `` `83697c`+`4` ``（0056 §6b 的写法）。`test/arch/doc-coords.ts` 的
  `hashProblems` 对散文里【恰好 7 位且含 a-f】的 token 一律当作提交引用、且没有任何豁免口 —— 假哈希
  合写一次就红一发，而它不是引用、不该进豁免。所以别把它「顺手改回」连写。
