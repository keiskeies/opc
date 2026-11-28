# 0083 · 登记调研那张表单没有「哪天」这一格 —— 昨天翻到的事只能记到今天

> 本轮编号：round402。落地范围：`packages/web/public/group.js` 单文件 + 一条 e2e 用例。
> 服务端、契约、数据库一行没动。0082 补的是「读」，本篇补的是「写」那一半。

## 1. 一句话

契约的创建请求里有 `day`（`packages/contracts/src/rhythm.ts:81`），服务层也认它
（`packages/hub/src/rhythm/service.ts:538` 是 `req.day ?? localDay(o.nowMs)`），HTTP 把请求体整个递进去
（`packages/hub/src/http/work.ts:374`）—— 只有「新增每日调研」那个弹窗里没有这一格输入，
于是它**永远**发不出 `day`，每张卡都落在服务端时钟的今天。

后果是 0082 那半件事的反面：0082 之后用户能把面板翻到昨天，看见昨天那一批；
可他坐在昨天的屏幕前想起一条昨天做的调研，登记下去却落进今天 ——
**看得到那一天，却写不进那一天**。翻回去只会看见「那一天还没有这条」。

## 2. 复算：这一格是怎么被指出来的

同 0082 的口径，把契约字段逐条抄下来去渲染侧找真发的人（`ui-caller-roster` 按路径形状匹配，
POST 有人调 ⇒ 它天然看不见）：

- **契约侧**：`packages/contracts/src/rhythm.ts:79` 的 `createResearchCardRequestSchema` 里
  `packages/contracts/src/rhythm.ts:81` 是 `day: z.string().regex(DAY_RE).optional()`；
- **服务侧**：`packages/hub/src/rhythm/service.ts:538` 缺省才落回今天；查重在
  `packages/hub/src/rhythm/service.ts:542` —— `WHERE day = ? AND url = ?`；
- **HTTP**：`packages/hub/src/http/work.ts:374` 直接 `createResearchRoute(deps, req)`，没有中间层；
- **渲染侧**：`researchCreateModal` 的 body 只有 `source / title / summary / url / group_id` 五个键。

## 3. 一次自我更正：0082 §9 说「三个问题都在产品那一格」，其中一个代码早答了

0082 「记下来但没动的」那条把 POST 的 `day` 押后，理由写了三件事：归到过去某天是补录还是错录、
去重按 `(day, url)` 还是按 `url`、以及那条路径的文案围着「今天」写。**第二条不成立**：
服务层 `packages/hub/src/rhythm/service.ts:542` 的查重条件里就带着 `day`，库里
`packages/hub/resources/migrations/0021_rhythm.sql:40` 更是把 `UNIQUE(day, url)` 直接建成部分唯一
索引 —— 去重一直是**按天按 URL**，今天一条同 URL 的卡挡不住昨天那条。这条不需要谁来拍板，
读一遍 SQL 就有答案。

顺带把那格读全，得到一条 0082 和本篇都没写过的：**没填 URL 的手动调研不查重**。服务层那段
`if (req.url !== undefined)` 把整段查重包住，而库里那个唯一索引自带 `WHERE url IS NOT NULL`
（`packages/hub/resources/migrations/0021_rhythm.sql:40`）—— 两层一致，是设计不是漏洞：
`packages/hub/resources/migrations/0021_rhythm.sql:38` 的 CHECK 允许无 URL 时 `source = 'manual'`。
于是手动卡想记两遍就记两遍，各带一份待办草稿与调研文档。本轮不动它（改了就是替产品决定
「手动调研该不该去重」），但它决定了本篇判据的形状：**查重那条线只能拿带 URL 的卡来证**
（见 §6 线 4），拿手动卡证的「重复」是假的。

真正留在产品那一格的只剩「归到过去某天算补录还是错录」。用户答复是「做」，于是本篇接上，
并把那条旧主张就地改成现在这个样子（§9）。

## 4. 修法：state 里早有那一格，弹窗只是没把它递给用户

服务端零改动。渲染侧三处：

1. `packages/web/public/group.js:3755` 打开弹窗时取 `const initialDay = state.researchDay;` ——
   默认跟随**屏上正在看的那一天**。这不是新发明：`state.researchDay`（0082 加的）本来就是
   「用户要的那一天」，空 = 不设那一天，面板与弹窗读的是同一格，不会出现「面板在昨天、弹窗在今天」。
2. `packages/web/public/group.js:3779` 弹窗里加一枚 `input("day", initialDay, "date")`，
   `packages/web/public/group.js:3817` 读它，`packages/web/public/group.js:3824` 用
   `...(day ? { day } : {})` 上线 —— 与 0082 的 GET 同一套哨兵纪律：**空 = 不发**，
   绝不发 `day=""`（契约那个 `DAY_RE` 会把空串判 422，弹窗不关、用户以为没点上）。
3. `packages/web/public/group.js:3834` 的 `dayLabel = day || localDayValue(0)` 把查重文案接回
   那一天：`packages/web/public/group.js:3839` 原来硬写「今日调研已存在」，用户填了昨天、
   界面却回答「今日已存在」，等于指他去查另一个日子。留空时才说今天。

`refreshAll()` 从不碰 `state.researchDay`（`packages/web/public/group.js:1040`），
所以登记完停在原地、不跳日子 —— 这一格是线 3 能判的前提，M9 专门剪它。

## 5. 新守卫：零

同 0082：参数级缺口没有任何机器判据可加（`ui-caller-roster` 的方法盲没修，属 0069 范围）。
本篇的承重全在那一条 e2e 和变异机上。

## 6. e2e：六段线，每段有自己的那次动作

`test/e2e/group-workbench.spec.ts:4059`，走**真界面**（0082 那条是 `page.evaluate` 直连 HTTP 灌数据，
本篇要证的就是界面发不发得出这个字段，必须点真按钮）：

| 线 | 判什么 | 为什么这样判 |
| --- | --- | --- |
| 前置 | 翻到昨天后，屏上那句汇总说的是昨天 | 判 `p.muted` 那句，**不判「屏上是空态」** —— 见 §7 末那次自曝 |
| 1 | 弹窗里有且只有一枚日期，且打开时就填着屏上那一天 | 未修时 `toHaveCount(1)` 当场红（`14 × 0 elements`） |
| 2 | 请求体里的 `day` == 表单那一格 | 判 `waitForRequest` 抓到的 **POST body**，不判卡片 DOM：DOM 上「昨天出现一张卡」也能靠「服务端今天建卡 + 面板不刷新」蒙过去，请求体蒙不了 |
| 3 | 仍停在昨天那一屏，刚登记的卡要出现 | 证 `refreshAll` 没把视角踢回今天（M9 是它唯一的目击者） |
| 4 | 同 `(day, url)` 再登记 ⇒ 文案说那一天、且不再出现「今日调研已存在」 | 只有带 URL 的卡才查重（§3），所以这一发必须填 URL |
| 5 | 清空那一格 ⇒ 请求体压根没有 `day` | **未修时也是绿的** —— 它是分母：没有它，「永远把今天硬写进 day」那种改法也能让线 2 变绿 |
| 6 | 不填那条落在今天：今天那屏看得见、昨天那屏没有 | 线 5 的**下游**，没有只有它才能杀的变异（M4/M5 两发全先红在线 5）；它钉的是服务端那一档没被本轮带坏，不是新接线 |

## 7. 变异机：9 根真线全红在各自那根线上，1 根控制组如预期活着

`.workbuddy/round402-wire-mutations.mjs`，锚点命中数 + 未变异先绿才开工，每发无论红绿都先还原再比 SHA。

- M1 整格摘掉 → 线 1；M2 默认值不跟随（`initialDay = ""`）→ 线 1；
- M3 填了也不上线（抹掉那行 spread）→ 线 2；
- M4 空值也上线（`day,`）→ 线 5；M5 留空时替用户发明天（`|| localDayValue(0)`）→ 线 5；
- M6 查重文案写死「今日」→ 线 4；M7 文案跟着服务端今天而不是表单那一天 → 线 4；
- M8 弹窗里塞两枚日期框 → 线 1；M9 登记完把视角踢回今天 → 线 3；
- C1 说明文字改掉 → **应当存活**（判据只认取值不认 help 文案），确实活了。

M9 是第二轮才加的：第一版 8 发跑完归因表里**线 3 没有任何一根线只红在它上面**（M3 剪掉 `day`
之后卡照样建、只是落在今天，线 2 先红，线 3 从没单独承重过）。补「登记完 `state.researchDay = ""`」
这一发，线 3 才有自己的目击者 —— round400 那条「机壳 N/N ≠ 每根线各自承重」这轮是**看归因表**
看出来的，不是靠直觉。

## 7b. 一次自曝：单跑绿了两次的判据，全量 e2e 里红了

前置那一格第一版写的是「翻到昨天 ⇒ 屏上是空态，空态里写着那一天」。它**单跑绿了两轮**
（红探针那次、落地那次都是 `-g` 单跑这一条），到全量 `npx playwright test` 才红：
`Locator: ... .state / Expected substring: "2026-11-27" / element(s) not found`。

原因不在代码，在判据本身：**同一个 e2e 文件共用一个库**（`test.afterAll` 才 `rmSync` 临时目录），
而排在它前面的 0082 那条用例刚往**昨天** POST 过一张卡。于是跑到本篇时昨天根本不空，
空态那块 DOM 压根不存在。这条判据从写下第一天起判的就是「今天恰好没人往昨天灌卡」，
单跑成立纯属顺序巧合。

修法是换尺子而不是放宽：判据改成 `p.muted` 那句「汇总 `<昨天>` 的调研卡」—— 同一件事
（面板确实切到那一天了），但**与库里有没有卡无关**。判据凡是带「恰好为空 / 恰好一条」这种
依赖库内既有数据的措辞，都得先问一句「前面哪条用例会往这一格里写东西」。

## 8. 坐标与台账同步

`group.js` 这次在 3752 之后分五段插入共 +13 行，分档增量取 `git diff -U0` 的逐项读数。
`.workbuddy/round402-repin-day.mjs` 先量两道门再动手：

- **门 0**：HEAD 那份按分档映射到当前文件，逐行比，只许 **1** 行不符（= 本轮真改写的那行文案）；
  行数差必须等于分档和 13。两项都对才准搬。
- **门 1**：整面（docs 递归 + `doc-refs.test.ts`）group.js 行号**集合**搬前搬后必须等势 ——
  0082 §8 门 2 那对自撞脚本的根因是「键集合认不全就动手」，这轮换判法：不认引号排版，
  只认坐标数字集合的双射，排版怎么变都判得了。
- 还有一道**停机条件**是这轮新加的：坐标若落在本轮改动区间内（`3752 < n <= 3821`），
  机器搬不了，直接停。本轮实测 0 处命中，全部坐标要么 ≤3752 不动、要么 ≥3822 一律 +13。

搬 **65 处**（8 篇台账 + INDEX + SNAP），SNAP 只动键、0 条值被改。0082 台账里那批 group.js 坐标
一并搬走 —— 它的引用是真引用，代码一动就得跟着动，这不是「改写旧主张」。

## 9. 记下来但没动的

- **0082 §9 那条押后的旧主张本篇已接上**（`day` 上线 + 文案跟着那一天）。同一条里那句
  「去重按 `(day, url)` 还是按 `url`」是**读漏了 SQL**：服务层一直按天去重，见 §3。
- **没填 URL 的手动调研不查重**（服务层 `packages/hub/src/rhythm/service.ts:542` 那段 `if` 只在有
  URL 时进，库里 `packages/hub/resources/migrations/0021_rhythm.sql:40` 的唯一索引同样带
  `WHERE url IS NOT NULL`）。同一条调研连点两下登记就出两张卡、两张各带一份待办草稿与调研文档。
  不动是产品口径。
- **改了 `day` 不能救回错录**：只有 GET / POST 两条路由（`packages/hub/src/http/work.ts:371`、
  `packages/hub/src/http/work.ts:374`），调研卡没有 PATCH ⇒ 归错某天只能删不掉地将就着
  （也没有 DELETE）。本篇让「归到哪天」可控，但**不可撤销**，这一点得说在前面。
- **`ui-caller-roster` 的方法盲仍未修**（0082 §9 同款）：参数级缺口至今零机器判据。
- 排版未过机器判定：弹窗里多一枚 date 输入只加在 `formGrid` 的第二个 `field`，间距沿用既有节奏。

## 10. 实跑读数

（以下每项都在最后一次文档改动之后重跑；坐标为写入时的读数，`group.js` 落地后 9667 行。）

- 红探针：对未改的 `group.js` 现场跑那条用例 → `1 failed`，判据
  `Expected: 1 / Received: 0`、`14 × locator resolved to 0 elements`，停在
  `toHaveCount(1)`。落地同一条 → `1 passed`。
- 变异机：预热 **10/10** 锚点恰命中 1 次（M1–M9 + C1）、未变异先绿才开工；
  归因 **9 根真线 KILLED**（每发红在自己那根线，M9 补上后线 3 才有独立目击者）
  + 1 根控制组 SURVIVED；每发无论红绿都先还原再比 SHA，无一发 `RESTORE-FAILED`、
  无一发 INDETERMINATE。逐发原文在 `.workbuddy/round402-machine-run4.log`
  （`*.log` 在 `.gitignore` 里 ⇒ 那份**不入库**，入库的是产生它的脚本）。
- 重钉：门 0 报「HEAD 9655 行按分档映射后仅 1 行不符」、门 1 报「整面 70 个不同行号搬后仍 70 个、
  无碰撞」、改写 **65 处**（面 94 个文件）。
- doc 守卫：doc-refs / doc-coords / doc-ids / plan-refs / commit-msg-refs 5 个文件
  **24 passed**，list-filter-repaint / history-cursor-producer 2 个文件 **13 passed**，
  claim-coords / claims-registry / lint-baseline 另 **208 passed**。0082 §9 就地改写后
  SNAP 键面同步重算（删 2 增 2，见该篇），doc-refs 先红在那 4 条出入、搬完转绿。
- SNAP：**410 键、0 重复**（HEAD 侧 388 ⇒ 净 **+22**：0083 新引 22 条；0082 §9 改写删 2 增 2
  净 0；`spec.ts` 那条键随用例标题行 3946→3947 改键名、净 0）。
- 全量 vitest：**205 files / 4241 passed | 6 skipped**（97.99s，exit 0）。
- 全量 e2e：**68 passed**（1.1m，exit 0，`round402-full-e2e2.log`）。
- `tsc -b` 与 `tsc -p tsconfig.test.json --noEmit`：**双双 exit 0**、零行输出。
- `pnpm lint`：biome 全面 **0 error / 101 warnings**，lint-baseline 守卫 13/13 判净新增 0
  （新增 SNAP 值里的 `${dayLabel}` 模板字面量未引入新告警类目）。
- `node docs/review/verify-open-invariants.mjs`：**SUCCESS**（exit 0，悬空提交引用 36 处
  为 `AUDIT-LEDGER.txt` 既有 `--amend` 中间态，非本轮引入）；`check-gate.mjs`：**exit 0**、
  不符项 0。
- 台账中文追加后 U+FFFD 计数：0082 / 0083 两篇均 **0**。
