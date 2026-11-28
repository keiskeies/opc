# 0084 · 搜索的 `faces` 参数服务端早就认，界面上一个入口都没有

> 本轮编号：round403。落地范围：`packages/web/public/group.js` / `group.html` / `group.css`
> 三个文件 + 一条 e2e 用例。服务端、契约、数据库一行没动。

## 1. 一句话

契约的搜索查询里有 `faces`（`packages/contracts/src/search.ts:44`，最多 7 个面），HTTP 层把它
按逗号拆开（`packages/hub/src/http/catalog.ts:103`）、缺省时不传（同文件
`packages/hub/src/http/catalog.ts:106`），服务层照它决定读哪几张表 —— 而渲染侧的搜索框
**永远不发这个参数**，于是七张表每次都全查，用户只能靠眼睛在一坨混合结果里找他真正要的那一面。

后果不是「少个筛选器」这么轻：搜索面板一次最多铺 30 条（渲染侧写死 `limit=30`），命中的
东西越杂，用户越读不到他关心的那一面。而契约早就把这件事办完了 —— 缺的那半件事整整躺在
界面这一侧。

## 2. 复算：这一格是怎么被指出来的

同 0082/0083 的口径，把 `searchQuerySchema.shape` 逐条抄下来去渲染侧找真发的人：

- **契约侧**：`packages/contracts/src/search.ts:42` 是 `q`，`packages/contracts/src/search.ts:44`
  是 `faces: z.array(z.enum(SEARCH_FACES)).min(1).max(7).optional()`，面名来自
  `packages/contracts/src/search.ts:11` 的 `SEARCH_FACES`（七面：group / task / member /
  message / document / meeting / backlog）；
- **HTTP**：`packages/hub/src/http/catalog.ts:99` 取 `req.query["faces"]`，
  `packages/hub/src/http/catalog.ts:103` 拆逗号并逐段 `trim()`；
- **服务层**：`searchAll` 用 `new Set(query.faces ?? SEARCH_FACES)` 决定跳进哪几个 `queryRows`；
- **渲染侧**：`globalSearch` 的请求串只有 `q` 与 `limit=30` 两个键 —— `faces` 零个调用方。

`ui-caller-roster` 按【路径形状】匹配调用方，`GET /api/v1/search` 有人调 ⇒ 它天然不在缺口表里，
**对参数级缺口是方法盲的**（0080 的 `group_id`、0082 的 `day` 同族，方法盲本身仍未修，见 §9）。

## 3. 一个把整条判据定下来的数字：`.min(1)`

`packages/contracts/src/search.ts:44` 那个 `.min(1)` 决定了 UI 的形状，而且不是次要细节：

**空集不是「一面都不搜」**。用户把七枚芯片全点掉，界面不许发 `faces=`（空串过不了
`z.array(...).min(1)` ⇒ 422），也不许发「七面」（那等于替他改主意）。它要发的是
**不带 `faces`** —— 服务端的缺省就是七面全搜，与「没有筛」是同一件事。所以勾选集先过一道
归一化（`packages/web/public/group.js:9212`）：全集与空集都归成「不上 `faces`」。

这条还牵住 e2e 的生死：`watchBrowserErrors` 那对助手断言 `failedResponses` 必须是 `[]`，
所以只要 UI 在任何一步发出空 `faces`，那发 422 会当场把用例判红 —— **契约的 422 就是这条
判据的免费守卫**，不必另写断言。

## 4. 落地

服务端零改动，渲染侧四件事：

- **勾选集**：`packages/web/public/group.js:623` 的 `searchFaces: new Set(Object.keys(faceLabels))`
  —— 初值直接由 `faceLabels` 的键生成，不在第二处抄一遍七面。
- **芯片由 `faceLabels` 生成**：`renderSearchFaces`（`packages/web/public/group.js:9220`）遍历
  `Object.keys(faceLabels)` 建按钮。这不是省事，是让**契约加一面时不可能漏掉筛选条** ——
  `test/web/search-face-parity.test.ts:68` 已经判死 `faceLabels` 的键必须逐面等于
  `SEARCH_FACES`，于是新面会自动长出一枚芯片，漏不掉。
- **只在建缺格时重建**：`box.childElementCount !== faces.length` 才 `replaceChildren`，
  其余时候只翻 `aria-pressed`。每次勾选都重建会把**刚点中的那枚连焦点一起抹掉** ——
  线 2 里那发 `toBeFocused()` 判的正是这件事。
- **结构：外壳与列表分开**（`packages/web/public/group.html` 里 `id="searchPanel"` 那层）：
  `#searchResults` 是 `role="listbox"`，它的子元素**就是选项**（读屏按这个数报选项数、
  键盘 ArrowDown 也按这个顺序跳）。芯片挂进去 ⇒ 选项数凭空多七条、方向键得先跳遍芯片。
  所以 HTML 里是一层不带 `role` 的壳装两行：`.search-faces` + `.search-results`。

`toggleSearchFace`（`packages/web/public/group.js:9244`）在全不勾时把集合**复位成全集**
（点它等于点「全要」，界面不许停在一枚都不亮的状态上），然后拿当前输入重跑一次
`globalSearch`（`packages/web/public/group.js:9253`）。

CSS 一处教训：芯片内距我第一版写的是 `gap: 5px`，被 `space-scale` 守卫判红 ——
那根的硬门是「豁免值必须 < `var(--space-1)`=4px」，5px 压根不具备入册资格，round377
的折档规则第 ① 条（取最近一档）在这里兑现。折成 `var(--space-1)` 后 4 个 web 守卫 56 passed。

## 5. 判据：七根线各自独立，且分母是「同一词在两面各有一条命中」

`test/e2e/group-workbench.spec.ts:4189` 那条用例种一个同一个词命中的**群 + 待办**各一条，
然后按线拆：

| 线 | 判什么 | 不修时红在哪 |
| --- | --- | --- |
| 0 | 七枚芯片各一枚、未筛时请求**不带** `faces` | 计数 0（界面上压根没有芯片） |
| 1 | 芯片**不在** `role=listbox` 那一层里 | `#searchFaces` 里数不到芯片 / 祖先链出现 listbox |
| 2 | 取消勾选真的落到请求上（`faces=message,backlog`） | 请求永远不带 `faces` |
| 3 | 服务端真按面取数 | 勾掉那一面后它的行仍在 |
| 4 | 勾回来又能看见（分母） | 「消失」证不出是被筛掉的 |
| 5 | 全不勾 ⇒ 回到「没有筛」且七枚重新全亮 | 请求发空 `faces` ⇒ 422 |
| 6 | 空查询把整块收起 | 筛选条悬在屏上 |

**线 3 与线 4 是一对**：只证「勾掉 ⇒ 不见」证不了「被筛掉」，得再证「勾回 ⇒ 又见」；
而线 3 用的是**网络层读数**（`page.on("request")` 收集真正发出去的 `faces`）加 DOM 行数，
两头都判 —— 只有 DOM 会漏掉「客户端把别的行藏起来」这个假实现，只有请求串证不了渲染。

## 6. 一台撞了两次墙、最后补到每根线各有目击者的机器

`.workbuddy/round403-wire-mutations.mjs` 跨三个文件下钳子（GROUP / HTML / SERVICE 各带 `file`
字段，逐文件快照 + 还原后比 SHA）。线表仍从 spec 自己的 `// 线 N（…）` 注释现推（加线不改机壳）。

**⚡ 第一轮 12/12 全 KILLED，但归因表显示线 1 与线 3 没有目击者。** 两个成因形状不同：

- **线 1**：M3（把芯片挂进 `#searchResults`）确实红了，可它红在**线 0** —— 芯片挪进结果层后
  `#searchFaces` 是空的，`toHaveCount(7)` 先炸。结构线被数量线**代打**。HTML 侧那发同理会死在
  线 0：`resultBox.replaceChildren()` 会把搬进去的芯片直接抹掉，压根到不了祖先链断言。
  ⇒ 补 M10（给外壳 `#searchPanel` 加 `role="listbox"`）：数量线七枚照数、只有祖先链断言会红。
- **线 3**：JS 侧任何「faces 算错」的变异都被**线 2 的读数**（请求串）先抓住，服务端真按不按面
  取数这件事从未被单独判过。⇒ 补 M12（服务层 `new Set(query.faces ?? SEARCH_FACES)` →
  `new Set(SEARCH_FACES)`，即服务端收到 `faces` 也照样全搜）—— 客户端完全正确、只有服务端不认，
  于是只有线 3 红。

round400 那条「机壳 N/N ≠ 每根线各自承重」这轮**第一次跑就兑现**，而且是在「全红」这种最容易
让人收工的表情下兑现的。所以机壳现在多一段**逐线点名**：把每发 KILLED 的实红行映射回线名，
任何一根线没有目击者就硬停（exit 非 0），不把「12/12」当结论交出去。

## 7. 两次自曝：我把自己的读数绞杀了

这两次都不是代码错，是**读数的产生过程被破坏了**，而且两次都是我自己上一步的动作埋的。

### 7a. 一边跑全量 e2e，一边 `git stash -u`

我把全量 e2e 丢进后台，转身用 `git stash -u` → 跑 biome → `git stash pop` 做「本轮 vs HEAD」的
lint 分类对照。结果那条 e2e 跑的是被 stash 成 **HEAD** 的工作树 —— 而它要验的恰恰是我这轮的改动。
那份读数作废（`Test Files` 还没数完就被我停掉，连「多少 passed」都不该报）。

对照本身是对的（**按规则名逐条比、不比总数**：两侧 `lint/*` 分类计数 `diff` exit 0，
等于净新增 0；总警告数 101→102 那 1 条是警告，压根不是 lint-baseline 的判据）。
错的是**时机**：要 HEAD 基线就用 `git show HEAD:` 取单文件（0081/0083 红探针一直这么做），
绝不在别的工作在跑的时候动工作树。

### 7b. 一边跑变异机，一边跑读全量文档的守卫

变异机每发都会把 `group.js` 真改写几百毫秒。我在这期间跑了 `doc-refs`，它 walk 到那一行时
字节正在被换 ⇒ 报「目标行内容与快照不符」。这是**假红**，但比假红更糟的是它会诱导我
「按机器报的结果去改 SNAP」—— 那等于让变异机改写快照的值，正是 doc-refs 文件头警告的
「自动重写快照的脚本」。停掉、机器跑完后在稳定字节上重跑，红条自然消失。

⇒ 家规：**读全量文档 / 全仓字节的守卫，不与任何会临时改写源文件的机器并发**（变异机、
`git stash`、格式化都算）。

## 8. 坐标与台账同步

`group.js` 这次在 618 之后分五段插入共 +50 行（9667 → 9717），分档增量取 `git diff -U0` 的逐项
读数。`.workbuddy/round403-repin-search.mjs` 先量两道门再动手：

- **门 0**：HEAD 那份按分档映射到当前文件逐行比，只许 **4** 行不符（= 本轮真改写的 4 行）；
  行数差必须等于分档和 50。两项都对才准搬。
- **门 1**：整面（docs 递归 + `doc-refs.test.ts`）group.js 行号**集合**搬前搬后必须等势 ——
  实测「整面 77 个不同行号单趟搬运后仍 77 个、无碰撞」，不认引号排版（0082 §8 门 2 那对
  自撞脚本的根因正是「键集合认不全就动手」）。
- **停机条件**沿用 0083：坐标若落在本轮改动区间内，机器搬不了，直接停。

搬 **176 处**（面 95 个文件）。搬完的核对不靠眼看：用 hunk 状态机把 12 个被改文件（11 篇台账
+ SNAP）的 `-`/`+` 行**归一化后比多重集**，坐标数字换成占位符后两侧逐条相同 ⇒ 只动了坐标、
没动一个字（docs 75 行 + SNAP 86 行 = 161 行）。

⚠ **核对命令自己也会造出假不符。** 我第一次写 `-` 行过滤器用了 `!l.startsWith("---")`，
却漏了对称的 `+++`，更要紧的是台账的 markdown 列表项本身就是 `- ` 开头 —— 于是「非纯坐标搬运」
一次报出 6 篇。真正的错在我的过滤器，不在搬运。改成按 hunk 状态机解析（认到 `@@` 才开始收
`+`/`-`）后 12/12 判净。**报红先怀疑尺子**这条，这轮是第三次兑现。

`test/e2e/group-workbench.spec.ts` 里既有的 9 条 spec 坐标一条没搬：本轮那条用例插在 4189 行，
既有坐标全在 ≤4182，插入点在所有旧引用**之后**。这不是运气，是「新用例追加在文件末尾」
这条惯例的副产品 —— 反过来，往文件中间插测试会一次性把后面所有 spec 坐标推歪。

## 9. 记下来但没动的

- **`ui-caller-roster` 的方法盲仍未修**（0082/0083 同款）：它按路径形状匹配调用方，
  参数级缺口至今零机器判据。本篇这条 `faces` 缺口是靠人把 `*QuerySchema.shape` 抄下来
  去渲染侧 grep 找到的 —— 下一根同样的线还得靠人记得去抄。
- **搜索结果的「面」内排序/分组未动**：七面混排仍是服务端返回序。筛选条解决的是
  「我只要这一面」，没解决「这一面排在最前」。
- **勾选集不持久化**：`state.searchFaces` 活在一个会话里，刷新回全集。要不要记住是产品口径。
- **排版只过了守卫、没过截图**：`.search-face-chip` 与 `.search-panel` 的观感经
  `space-scale` / `compact-scale` / `tailwind-wiring` 三道机器判据，但没有截图对比。

## 10. 实跑读数

（`group.js` 落地后 9717 行。**对应字节**：源码三件在红探针还原后未再改一个字节，所以红探针 /
变异机 / e2e 三组读数与交付的源码是同一批字节；docs 在 e2e 之后还改过两次（§4 那句 CSS 教训
补写、标题与 INDEX 的假事实更正，见最后一项），故**受影响的全量 vitest 与 doc 守卫在最终
docs 字节上重跑**，读数取自重跑那次。e2e 不读 docs，故不重跑。）

- **红探针**：把 `group.js` / `group.html` / `group.css` 三件换成 `git show HEAD:` 版，对最终
  那版 e2e 现场跑那条用例 → `1 failed`，判据 `Received: 0`、`14 × locator resolved to 0 elements`，
  停在 `toHaveCount(7)`。按 sha256 逐字节还原三件（`0b518e…` / `9d47c0…` / `6f3659…` 与快照一致）
  → 同一条 `1 passed`。
- **变异机**（`.workbuddy/round403-wire-mutations.mjs`，最终字节上跑）：预热 **13/13** 锚点恰命中
  1 次（M1–M12 + C1）、未变异先 `1 passed` 才开工；归因 **12 根真线 KILLED** + **1 根控制组
  SURVIVED**（改加载中文案，如预期活）；逐线点名 **7/7 每根线各有目击者**（线 1←M10、线 3←M12、
  线 4←M11 三发是 §6 补的，各是那根线唯一目击者）；每发无论红绿先还原再比 SHA，`group.js` /
  `group.html` / `search/service.ts` 三件收尾 SHA 与起始一致，无 `RESTORE-FAILED`、无 INDETERMINATE。
  逐发原文在 `.workbuddy/round403-machine-run5.log`（`*.log` 在 `.gitignore` ⇒ **不入库**，入库的是产生它的脚本）。
- **重钉**：门 0「HEAD 9668 行按分档映射后仅 4 行不符」、门 1「整面 77 个不同行号搬后仍 77 个、
  无碰撞」、搬 **176 处**（面 95 文件）；搬完用 hunk 状态机把 12 个被改文件的 `-`/`+` 行归一化
  后比多重集 → 12/12 纯坐标搬运、161 行（docs 75 + SNAP 86），0 个字被改、0 条 SNAP 值被动。
- **SNAP**：**429 键、0 重复**（HEAD 侧 410 ⇒ 净 **+19** = 0084 新引 13 条 + INDEX 入口行 6 条；
  本轮无改写旧主张、无删键）。
- **doc 守卫**：doc-refs 单跑 2 passed；doc-coords / doc-ids / decision-index / claim-coords /
  claims-registry / commit-msg-refs / lint-baseline 7 文件 **208 passed**。
- **web 守卫**：space-scale / compact-scale / tailwind-wiring / search-face-parity 4 文件
  **56 passed**（`gap: 5px` 折成 `var(--space-1)` 后转绿，见 §4）。
- **全量 vitest**：**205 files / 4241 passed | 6 skipped**（130.22s，exit 0，含全部 arch + web 守卫）。
- **全量 e2e**：**69 passed**（1.2m，exit 0，基线 68 + 本篇 1；新用例 `test/e2e/group-workbench.spec.ts:4189` 报 `ok 51`），
  独占工作树跑（§7a 教训落地）。
- **`tsc -b` 与 `tsc -p tsconfig.test.json --noEmit`**：**双双 exit 0**、零行输出。
- **`pnpm lint`**：**0 error / 102 warnings**（exit 0）。净新增用【按规则名逐条比】判：工作树 vs
  `git stash` 到 HEAD 两侧的 `lint/*` 分类计数 `diff` **exit 0**（两侧总警告同为 102）——
  中途那发 `format=1` 是我手写的单行 CSS 触发，`biome format --write` 收掉、未登记 `LINT_BASELINE`。
- **`verify-open-invariants.mjs`**：**SUCCESS**（exit 0）；**`check-gate.mjs`**：C7 从 `★FAIL`
  （入口行含「本轮」相对指称）修到**不符项 0**、**exit 0**。
- **台账中文写入后 U+FFFD 计数**：INDEX / 0084 / 0076 / `doc-refs.test.ts` 均 **0**。
- ⚠ 顺带被守卫揪出的两处**我自己的假事实**（check-gate C7 + 自查）：① INDEX 入口行写「本轮改动」
  —— 入口里的轮次相对指称落不了地，改成 `round403`；② 标题「服务端认了三年」这个时间跨度我
  没有任何证据，改成「服务端早就认」（`faces` 从契约第一版就在，但「几年」是我脑补的）。
