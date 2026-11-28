# 0082 · 每日调研面板把自己钉死在服务端时钟的「今天」上 —— 一个查询参数都没有，昨天的卡在界面上没有任何入口

> 本轮编号：round401。落地范围：`packages/web/public/group.js` 单文件 + 一条 e2e 用例。
> 服务端、契约、数据库一行没动 —— 这一格缺的从来不是能力，是渲染侧那一个参数。

## 1. 一句话

`GET /api/v1/research/today` 的查询里有一个 `day`，服务端拿它做 `WHERE day = ?`，缺省才落回「今天」；
渲染侧把这个端点写死成一条不带任何查询的 URL，整个 `group.js` 里连一枚 `type="date"` 的输入都没有。
后果不是「少一个筛选器」：调研卡按天成批，过了零点，昨天那一批在屏幕上**再也找不到入口** ——
列表、全局搜索、文档面都不读 `research_cards`，那一整天的调研只剩服务端还留着。

## 2. 复算：这一格是怎么被指出来的

不是「我又想到去看一遍前端」，是 0069/0081 那条口径反过来推了一遍：

- **契约侧**：`packages/contracts/src/rhythm.ts:58` 的 `listResearchQuerySchema` 是 `.strict()`，
  里面唯一的参数就是 `packages/contracts/src/rhythm.ts:61` 的 `day`，正则
  `packages/contracts/src/rhythm.ts:31` 只收 `YYYY-MM-DD`；
- **服务侧**：`packages/hub/src/rhythm/service.ts:348` 的 `listResearch` 在
  `packages/hub/src/rhythm/service.ts:359` 做 `parsed.data.day ?? localDay(nowMs)`，
  紧跟着 `packages/hub/src/rhythm/service.ts:362` 是 `WHERE day = ?`；`localDay` 本身在
  `packages/hub/src/rhythm/service.ts:127`；
- **HTTP**：`packages/hub/src/http/work.ts:371` 把 `req.query` 整个递进服务层，没有任何一层拦着；
- **渲染侧**：`packages/web/public/group.js:3270` 的 `let path = "/research/today";` 是死的，
  `packages/web/public/group.js:3271` 往下的 `if` 只分 `rhythm` 一档，调研这一档一个参数都不发。

四格里前三格都在说「这一天可以选」，最后一格替用户做了决定，而且做得**完全合法** ——
不传 `day` 是契约允许的形状，返回的就是今天那一批，不报错、不空、看起来没有任何不对。

## 3. 为什么静默：四层各自「没反应」，叠起来和「调研本来只看今天」逐像素相同

| 层 | 它的表现 | 为什么不响 |
| --- | --- | --- |
| 服务端 | 返回 200 + 今天那一批 | 「按今天返回」是合法语义，`?? localDay` 就是为缺省准备的 |
| 契约 | `day` 是 optional | optional 的含义是「可以不带」，不是「不该带」 |
| 既有 e2e | 全绿 | 从没灌过第二天的卡 —— 只有今天一批时，「只看今天」与「看全部」读数逐像素相同 |
| 守卫 | 全绿 | `ui-caller-roster` 按【路径形状】匹配调用方；`research/today` 有人调 ⇒ 天然不在缺口表里，**它对参数级缺口是方法盲的** |

第三行是本轮方法上最值钱的一格：**分母必须是两天的数据**。红探针先 POST 两张卡（今天一张、
昨天一张），再断言「昨天那张不在界面上」；只灌今天，这条探针永远证不了这件事 —— 同 0080 要灌
两个群才证得了「按群筛」。

第四行是找缺口口径的一处修正（写进 §9）：0069/0081 那条「契约参数有没有生产者」的判据，
`hitsUi` 只比路径、不比查询串，所以它抓得到「这个端点没人调」，抓不到「这个端点有人调但每次
都少带一个参数」。0080（`group_id`）与本轮（`day`）都是这一类，而它们都不在名单上、
也不会自己出现在名单上 —— 靠的是把 `packages/contracts/src/*.ts` 的 `*QuerySchema.shape`
逐条抄下来去渲染侧 grep 发没发，不是靠守卫把人按回桌子前。

## 4. 修法：state 加一格，URL 多一个分支，界面上多一枚输入

服务端零改动，四处落在同一个文件：

1. `packages/web/public/group.js:631` 的 `researchDay: ""` —— 空串是「不设那一天」的哨兵，
   不是「1970-01-01」这类假日期；读谁的那一天由服务端时钟定，界面上不假装知道。
2. `packages/web/public/group.js:94` 的 `localDayValue(offsetDays)` —— 与服务端 `localDay`
   同式（本地时区的 `YYYY-MM-DD`）。**不能用 `toISOString().slice(0, 10)`**：那是 UTC 日界，
   东八区早上八点前会翻到昨天去，界面上写的「今天」和服务端读到的「今天」就不是同一天。
   本轮机器实测的时区是 `Asia/Shanghai`（UTC+8），这个坑每天上午 8 点前都在。
3. `packages/web/public/group.js:3276` 起的 `else if (state.researchDay)` —— **只在非空时**拼
   `?day=`，走 `URLSearchParams`；空 ⇒ 整条查询不发，落回服务端的 `?? localDay`。
   这一格的真假在两头发：非空不发 = 翻不了天（M2）；空也照发 = 空串被 `.strict()` 的正则判
   422，初屏直接坏（M9）。
4. `packages/web/public/group.js:3601` 的 `const dayText = state.researchDay || localDayValue(0);`
   把「屏上写哪天」集中到一处，两处文案跟着它走：汇总句
   `packages/web/public/group.js:3608` 与空态标题 `packages/web/public/group.js:3629`。
   控件在 `packages/web/public/group.js:3613`，`value` 回填 `state.researchDay`，
   `onchange` 写 state + 重读 —— 与既有的 `state.rhythmGroup`（同文件
   `packages/web/public/group.js:3457`）同一形状，不新造轮子。

**为什么这一格可以整栏重画**（而 0079 那一族不行）：日期只在 `change` 时变，一次操作一个事件，
不存在「中文输入法的拼音还没上屏、承载它的节点已经被换掉」那个失败模式；而工具条是
`renderResearchView()` 每次新造的，不存在 0079 那种「往复用的 toolbar 上再挂一套」的累加路径。
`test/web/list-filter-repaint.test.ts` 点名判的是 `renderDocumentList` / `renderBacklogList`
两处「敲一个字符回调自己」，本函数不在其面内 —— 但「重画不累加控件」这件事不该靠推理，
所以线 5b 直接数：切三次日期之后 `toHaveCount(1)`，M8 往工具条多塞一枚就被它杀掉。

## 5. 新守卫：零

名单本来不判这一格（§3 第四行的方法盲），所以本轮**不补一发源扫描守卫**：路径形状的守卫对
参数级缺口加多少发都是盲的，要修得先把它换成「解析查询串再比参数名」那把尺子 —— 那是 0069
整篇的范围，不该塞进一篇功能修复里顺手做。真正的承重交给 e2e + 变异机（§7）。
**记在 §9**：`ui-caller-roster` 对参数级缺口方法盲，这一格至今没有任何机器判据，找它靠人工
「契约参数 → 渲染侧 grep」。

## 6. e2e：八段线，每段有自己的那次动作

`test/e2e/group-workbench.spec.ts:3947` 一条用例，前置先 POST 两张卡（今天 + 昨天）并断言都 2xx：

| 线 | 动作 | 断言 | 未修时 |
| --- | --- | --- | --- |
| 0 | 打开面板 | 有一枚且只有一枚「调研日期」，初值空 | **红**（`toHaveCount(1)` 收到 0） |
| 0b | 什么都不点 | 汇总句写的是「汇总 <今天> 的调研卡」 | 红（旧文案写死「今日调研」四个字） |
| 1 | 什么都不点 | 今天那张在、昨天那张不在 | **绿** —— 显式标注的**分母** |
| 2 | 填昨天 | 发一条 `day=昨天` 的 GET；昨天那张出现、今天那张消失 | 红 |
| 3 | 清空 | 回到今天那张 | 红 |
| 4 | 填前天 | 0 张卡 + 空态说的是【前天】且不含「今天还没有调研」 | 红 |
| 5 | 上一步之后 | 框里仍是前天（重画不丢读数） | 红 |
| 5b | 上一步之后 | 工具条仍只有一枚日期框（重画不累加） | 红 |

线 1 是**故意在「未修」时也绿**的那一发，注释里就写着它是分母：没有它，「把两天混在一起显示」
这种改法也能让线 2 变绿。它钉的是「不发 `day` 的那一发仍然按今天筛」，不是「切日期」这个动作。

## 7. 变异机：9 根线该红全红，1 根控制组该活全活

`.workbuddy/round401-wire-mutations.mjs`：逐根真抹字节 → 跑那一条 e2e → 按 SHA 还原（自回滚）；
锚点命中数在预热阶段判，未变异那一发必须先绿才准开工；线表从 spec 自己的 `// 线 N（…）`
注释现推（加线不改机壳）。

| 剪的线 | 结果 | 实红在 |
| --- | --- | --- |
| M1 日期框整枚摘掉 | KILLED | 线 0 |
| M2 选了日期也不带 `day` | KILLED | 线 2 |
| M3 发请求但 `day` 传空串 | KILLED | 线 2 |
| M4 空态文案写死「今天还没有调研」 | KILLED | 线 4 |
| M5 日期框不回填读数 | KILLED | 线 5 |
| M6 `onchange` 只改 state 不重读 | KILLED | 线 2 |
| M7 默认那档不走本地日界 | KILLED | 线 0b |
| M8 每次重画再塞一枚日期框 | KILLED | 线 0 |
| M9 清空也照发 `day=` | KILLED | 线 1（默认只看今天那两发） |
| C1 控制组：汇总句后半句改掉 | SURVIVED（如预期） | — |

两处值得单独记：

- **M7 是补了线 0b 才杀的**。第一版机器跑完 8 发全红，但核对归因表时发现 `localDayValue`
  没有任何一根线是**只有**它才能杀的：线 2/4/5 走的都是用户手填的那一天，把默认那档剪成空串，
  用户一填值全都照样绿。round400 记过同族教训（机壳 15/15 ≠ 每根线各自承重），本轮在**第一轮**
  就按那张表查出来了，补线 0b（初屏那句汇总句里的具体日子）之后 M7 才红在自己那根线上。
- **M9 的红不在我以为的那条线上**。我预期它走红后的线 3（清空 ⇒ 422），实际红在**初屏**：
  `state.researchDay` 初值就是空串，`!== null` 一判成立，第一次加载就带 `day=` 被 `.strict()`
  判 422。归因表把它报在「灌数据/初屏」那一段，而不是线 3 —— 这说明机器的归因比我诚实，
  也说明「空 ⇒ 不发」这一格比「清空 ⇒ 不发」更靠前：**它坏的是第一次打开面板**。

## 8. 坐标与台账同步

`group.js` 落地后从 9624 行变 9654 行（+29；`git diff -U0` 是 4 处插入 + 2 处改写，
按 HEAD 侧行数算是 +30 行位移）。全体 group.js 坐标单趟搬运，四条门写在脚本里，任一不过就停机：

- **门 0 映射自证**：HEAD 的 9624 行按分档映射搬到新行号后逐行比对，只许 2 行不符 ——
  正好是本轮真改写的那 2 行文案。这把「分档读数对不对」从抽查变成整文件判。
- **门 1 碰撞预检**：不同旧号映到同一新号、或落点撞上本轮不动的旧号 ⇒ 停（round400 那对
  `9221→9224` 撞 `9224` 就是这么来的）。实测 60 个行号、需搬 59 个、碰撞 0。
- **门 2 键集合等势**：SNAP 与 docs 两侧各 67 条、孤儿 0。**这一门是本轮唯一挡住事故的**：
  第一版正则只认「双引号值」，认到 44 条，而 docs 实际 67 条 —— biome 会因为代码里有 `"` 而把
  SNAP 的值留成单引号排版。round400 那对自撞脚本的根因正是「键集合认不全就动手」。
- **门 3 值落点**：每条 SNAP 的**值**在新行号上必须逐字节相同；66 条搬完即对位、1 条本就对位、
  **0 条需要动值**（改值等于给旧主张换新标签）。

落地面：8 篇决策文档 + `docs/INDEX.md` + SNAP，共改写 136 处坐标数字。

## 9. 记下来但没动的

- **POST 的 `day` 没接** —— 本篇押后，**0083 已接上**（表单加那一格 + 文案跟着那一天，
  见 0083 §4）。押后时写的理由里**第二条是读漏了 SQL**：去重一直是按 `(day, url)`，
  服务层 `packages/hub/src/rhythm/service.ts:542` 的查重条件带着 `day`，库里
  `packages/hub/resources/migrations/0021_rhythm.sql:40` 更是把 `UNIQUE(day, url)` 建成
  `WHERE url IS NOT NULL` 的部分唯一索引 —— 这一条不需要谁拍板，读一遍就有答案（0083 §3）。
  真正留在产品那一格的只剩「归到过去某天算补录还是错录」与「文案围着今天写」，前者用户已答「做」。
- **`ui-caller-roster` 的方法盲**（§3/§5）：它按路径形状匹配，看不见参数级缺口。0080 的
  `group_id` 与本轮的 `day` 都是它结构上抓不到的那类。修它要做查询串解析，属 0069 的范围。
- **调研卡仍然只有这一个出口**：`packages/hub/src/rhythm/service.ts` 是 `research_cards` 的唯一
  读者，全局搜索也不读它。所以「翻到某一天」是唯一的找回方式，这一格比一般的筛选器更吃重。
- 排版未做机器判定：新增一枚 input 只动了工具条，间距沿用 `toolbar team-toolbar` 既有节奏，
  「没变坏」这句只有目测。

## 10. 实跑读数

- **红探针**：对 `git show HEAD:` 版 `group.js` 现场 `14 × locator resolved to 0 elements`
  （`toHaveCount(1)` 收到 0）→ 落地 `1 passed`。
- **变异机**：9 根真线 KILLED（每发红在自己那根线）+ 1 根控制组 SURVIVED；锚点预热 **10/10** 恰一次
  （M1–M9 + C1，含补的那根 M9）、未变异先绿才开工；每发无论红绿都先还原再比 SHA，无一发
  `RESTORE-FAILED`。归因表落在 `.workbuddy/round401-machine-run.log`
  （`*.log` 在 `.gitignore` 里 ⇒ 那份逐发原文**不入库**，机壳脚本入库、上面三个读数是它的结论）。
- **文档守卫**：`doc-refs` / `doc-coords` / `doc-ids` / `plan-refs` / `commit-msg-refs` /
  `list-filter-repaint` / `history-cursor-producer` 七文件 **37 passed**；
  round400 的 dup 审计脚本复跑报 group.js 键 52 条、**值不符 0**。SNAP **389 键**
  （359 条搬运 + 30 条新钉），键数由两条独立路径各数一遍对上，重复 0。
- **全量 vitest**：**205 文件 / 4241 passed | 6 skipped**。**全量 e2e**：**67 passed**（0081 时 66 + 本篇 1）。
- **类型**：`tsc -b` exit 0；`tsc -p tsconfig.test.json --noEmit` exit 0。
- **biome**：exit 0，**97 warnings**（较此前 93 净增 4，全部是 `test/arch/doc-refs.test.ts` 里
  SNAP 值的 `noTemplateCurlyInString`：既有 789/1066/1242/1264 四条、本篇新增
  1589/1610/1628/1630 四条 —— SNAP 的值就是含 `${...}` 的快照字符串，规则的靶子按其定义成立；
  加 `biome-ignore` 要在快照映射里插行、会顶掉整张表的行号，按 0070/0075 先例留 warning 并在此逐条归因）。
- **check-gate**：exit 0（判不了或不符的项 0）。**verify-open-invariants**：exit 0 / SUCCESS，
  悬空提交引用 36 处 = 存量口径。U+FFFD：本篇、INDEX、spec、doc-refs、`group.js` 各 **0**。

过程账两条，都是自己的读数侧事故、当场自曝：

1. **把套件输出写成 `.txt` 会被自己的守卫当成交付物**。首跑全量是 `204 passed | 1 failed`，
   三发红全在 `exempt-pierce`（它就是跑 `verify-open-invariants` 的那个守卫）。红因不在代码：
   verify 的 walk 收 `.workbuddy` 下的 `txt|md|mjs`，而我把机器归因表与 vitest 输出直接落成了
   `.txt` —— 归因表第一行是「`group.js` 起始 SHA + 一枚 16 位十六进制串」，那个形状按守卫的口径
   就是一个该解析的提交引用（这里**故意不把那位数抄进正文**：抄进来这一行自己就成一个新悬空引用，
   0080 那条「别改回连写」是同一个坑的两种写法）。改成 `.log`（walk 只收 `txt|md|mjs`）后 verify 与
   exempt-pierce 一起回绿，全量复跑 205/205。**判据没坏，是我往判据的取材面里丢了一份带 hex 的
   运行产物** —— 且这是**同一条 house rule 的第二次复发**：0077 §实跑 已写过「证据落盘一律 `.log`
   不许 `.txt`」并当场记过一次，复发判据是**只要 walk 仍按扩展名收、就没有任何东西阻止我再写一次
   `.txt`**；这一格没有机械防线，下次落盘前先想扩展名，别指望守卫提醒（守卫提醒时红已经在了）。
2. **INDEX 的轮次相对指称门（C7）词的集合比我想的大**。第一版 INDEX 行写「本轮方法上的产出」被
   `★FAIL … l.671 含 本轮` 抓住，改掉两处后仍红 —— 词表里还有「这轮」，而「这轮在第一轮就兑现」
   正是我顺手写下的第三个。门只扫 `docs/INDEX.md`（决策记录正文里的「本轮」是作者第一人称时间锚点，
   门故意不管，见 check-gate 注释），所以修法是把入口行全部改成点名（「0082 方法上的产出」）。
