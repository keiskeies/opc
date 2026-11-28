# 0081 · 成员设置面板的技能和执行器是冻住的 —— 名单把「服务端有等价 POST」当成了「界面到得了」

**日期。** 2026-11-28（round400）。
**落地。** `packages/web/public/group.js`：抽出两行构造器 `skillSettingsRow`
（`packages/web/public/group.js:6862`）与 `executorSettingsRow`
（`packages/web/public/group.js:6886`），两者都带一个可选的 `remove` —— 已落库的行传服务端
DELETE，刚加还没存的行传「把这一行从 DOM 里撤掉」；`bindExecutorKind`
（`packages/web/public/group.js:6847`）把「换 kind 连带重写 config 骨架」从招聘弹窗里搬到
招聘与设置共用；新 handler `removeSkill`（`packages/web/public/group.js:8664`）与
`removeExecutor`（`packages/web/public/group.js:8677`）打那两条早就存在的 DELETE。服务端零改动。
新链路 e2e `test/e2e/group-workbench.spec.ts:3567`（17 段动作）；证据
`.workbuddy/round400-wire-mutations.mjs`（变异机 15 发、13 该红全红 + 2 控制组该活全活，逐发
sha256 自还原）。名单同步：`test/arch/ui-caller-roster.ts:242` 的
`NO_UI_CALLER_ROSTER` 从 12 条降到 **10 条 / 8 条路径**，0069 另起 §13 认账。

## 1. 一句话

`DELETE /api/v1/members/:id/skills/:skillId`（`packages/hub/src/http/people.ts:797`）与
`DELETE /api/v1/members/:id/executors/:seq`（`packages/hub/src/http/people.ts:871`）从第一天起
就接在服务端，0069 把它们登记进「渲染侧零调用方」名单时写的是**【覆盖】**，理由是
「设置面板走的是同一条整体替换 POST ⇒ 摘一件技能这件事在界面里已经能做」。这句话在服务端
一侧是对的，在界面一侧是错的：那一栏确实把技能与执行器渲染成一行行，但**行首行尾一个增删
控件都没有** —— 增删只做在招聘弹窗里（`packages/web/public/group.js:7088` 与
`packages/web/public/group.js:7099` 那两枚按钮属于 `hireForm`）。于是「已招进来的成员」的
技能与执行器列表在界面里是**冻住的**：能改一件技能的备注，摘不掉它，也加不上一件。

## 2. 复算：是判据把这一格顶出来的，不是我重新读了代码

0069 §2 那一条【覆盖】的举证写的是**实现形状**（「filter 掉一条再整体 setSkills」），不是
**界面上那个控件的名字**。这个差别在写下来的那一刻没有代价，代价在接线那天付：
`checkRoster` 是双向判的 —— 名单**外**冒出零调用方 ⇒ 红，名单**内**长出了调用方 ⇒ 也红。
所以「把两个控件接上」这个动作本身必然把这两格判红 ⇒ 复算不是「我又想到去看了一遍」，
而是**判据在指定时间、指定位置把我按回桌子前**。复算的结论与归因写在 0069 的 §13
那一节，INDEX 的 0069 入口行也标了 ⚡ 作废原读数。

⭐ **这一篇给下一位读者的口径先说在这里：【覆盖】的举证责任在界面侧，不在服务端侧。**
「服务端有一条等价的 POST」只说明不需要**新路由**，不说明**界面到得了**。要写【覆盖】，
reason 里得指得出界面上那个控件叫什么。

## 3. 为什么静默：四层各自「没毛病」，缺口长得和「本来就这样」一模一样

和 0077 的游标、0080 的按群筛同族，只是这次断点在**渲染层最内侧**：

- **服务端不响**：两条 DELETE 合法且已实现，没有报错的理由。
- **整体替换 POST 不响**：它工作得好好的 —— 备注改了能存，这就是「这一栏是活的」的全部错觉来源。
- **既有 e2e 不响**：从头到尾没有任何用例点过设置面板那一栏里「不存在」的按钮；断言只覆盖
  渲染出来的那些行，不覆盖本该渲染而没渲染的。
- **守卫不响**：`ui-caller-roster` 判的是「有没有人调这条路由」，而这一格当时被名单**主动
  豁免**了 —— 名单是允许「零调用方」存在的，它不追问豁免理由能不能在界面上指出来。

⇒ 缺口的表现和「这个成员的技能就是不能改」逐像素相同。要现形，只能**真招一个成员**（有技能、
有两档执行器），打开设置面板，然后去数按钮。红探针（`.workbuddy/round400-red-probe.log`，
对着 `git show HEAD:packages/web/public/group.js` 现跑取证、跑完按工作树那份的 sha256
（全值在 `.workbuddy/round400-group-sha.txt`，这里故意不抄前缀 —— 短 hex 前缀会被哈希核对
当成 git 对象）逐字节还原）的读数是**`14 × locator resolved to 0 elements`** ——
「添加技能」那一枚挂了 14 次等满超时，不是脚手架坏了，是屏幕上压根没有它。

## 4. 修法：行构造器带一个 `remove`，两种语义别混

设置面板原先把行直接内联在 `skillsEditor` / `executorsEditor` 的构造里，所以「加一行」无处可挂。
拆法是把一行的形状收进构造器，把「删」这件事做成传进去的参数：

- `skillSettingsRow(skill, remove)` 与 `executorSettingsRow(executor, remove)` 的末尾各接同一句
  （`packages/web/public/group.js:6881` 与 `packages/web/public/group.js:6916` 逐字符相同）：
  `remove` 为 null 就不渲染删除钮。
- **`remove` 有两种语义，这一格是这一篇最容易写错的地方**：已落库的行传
  `removeSkill(memberId, skillId)`（真发 DELETE）；刚点「添加技能」还在页面上的行传
  `(row) => row.remove()`（只撤 DOM）。把后者也接到 DELETE 上，服务端会回
  `skill_not_found`；把前者接到前者上，屏幕上行没了、库里还留着 —— 两边都得有自己的那条线，
  见 §6 的线 2b 与线 4c。
- 「添加技能」用 `insertBefore(…, querySelector("button[type=submit]"))` 把新行插在提交钮**之前**
  （`packages/web/public/group.js:8427`）—— 直接 `append` 会把新行甩到「保存」钮下面，
  视觉上变成表单外面。
- 「添加执行器」的默认序号是**现算**的：`Math.max(0, …行里的 seq) + 1`
  （`packages/web/public/group.js:8464`），不是「行数 + 1」。执行器链**允许有缝**
  （删中间那档合法，见 §6 线 6），所以 1/2/4 之后的下一档是 5；写成 `rows.length + 1`
  会撞上已经存在的 4，服务端按重复 seq 拒。
- **只剩一档执行器时不给删除钮**（`packages/web/public/group.js:8446`）：服务端的
  `empty_executor_chain`（`packages/hub/src/members/service.ts:915`）判的是同一件事
  —— 与其让用户撞一发 422，不如让界面先长成那个约束的形状。技能那一侧没有这条，
  契约允许空列表（`.max(20).default([])`），所以摘光之后是空态 + 「保存」仍在（线 8）。
- `kind` 与 `config` 的耦合搬进 `bindExecutorKind`（`packages/web/public/group.js:6847`）：
  `packages/contracts/src/member.ts:38` 的 `executorConfigSchema` 是**按 `kind` 判别的严格
  判别联合**，`packages/contracts/src/member.ts:80` 的 `superRefine` 还要求
  `config.kind === kind` —— 换了 kind 不重写骨架，提交必 422。招聘弹窗原来自己写了这一格，
  现在两边共用同一个函数（`packages/web/public/group.js:6849` 那个 change 监听器是唯一的一份）。
- 提交侧跟着补两格来源：`updateExecutors` 的 `kind` 从行里的下拉读
  （`packages/web/public/group.js:8648`），`enabled` 从行里的勾选读；`updateSkills`
  （`packages/web/public/group.js:8620`）的 `note` 走「空串就不写这个键」
  （`packages/web/public/group.js:8627`），避免把空串塞进可选字段。

## 5. 新守卫：零

这一篇**没有新增守卫**，而且这是有意的。名单本来就在判这件事（④「名单内长出调用方 ⇒ 红」），
再补一发「界面必须有添加钮」的源扫描守卫，等于把同一根线接两次保险 —— 而 0081 的教训恰恰
是**上一版那条保险是假的**（它假在 reason 的措辞，不假在判据形状）。承重交给 e2e 的 17 段动作
+ 变异机，名单继续双向判。

## 6. e2e：17 段动作，每段有自己的那次动作

`test/e2e/group-workbench.spec.ts:3567` 走真链路：HTTP 招一个成员（两件技能
`seed-skill-a/b` + 两档 `pure-model` 执行器 seq 1/2）⇒ `page.reload()` 让列表带上新成员 ⇒
进设置面板那一栏。线注释写在**该线动作与断言之后**（0080 §8 那条归因教训），要点：

- **线 0/1/2**：「添加技能」存在且只有一枚；每行一枚「删除这一件技能」，点它真发一条
  DELETE 且落库只剩乙；加一行真的多一行且此刻**不发**请求。
- **线 2b**：删掉那行**还没落库**的 ⇒ 行数回去、库里那条播种的还在，且**这一个动作的窗口内
  一条 DELETE 都没发出**（`page.on("request")` 只挂在点删钮那一下前后）。若把页面行接到
  DELETE，这里会收到 404 `skill_not_found`。
- **线 2c**：新行填 note ⇒ 保存后 `name` 与 `note` **由这一行自己带**上去（摘掉
  `packages/web/public/group.js:8627` 那格 ⇒ 这里读到 `undefined`）。
- **线 4b**：换 kind ⇒ 骨架连带重写（切 `builtin-plugin` ⇒ 值里出现 `plugin_id`/`tool_name`、
  placeholder 跟着换；切回 `pure-model` ⇒ 值逐字节等于那份骨架）。
- **线 4c/4d**：再加两行、删掉**不是最后一行**的那档 ⇒ 序号与落库各自对得上；
  1/2/4 之后的下一档是 **5**（这一发专杀 `rows.length + 1`）。
- **线 4e/5**：新行换成 `claude-cli` 且取消「启用」⇒ 保存后库里那一档的 `kind`、`config`、
  `enabled` 三项由那一行自己带（`kind` 写死 ⇒ 判别联合 422；`enabled` 写死 ⇒ 恒 true）。
- **线 6/7**：删中间那档 ⇒ 留缝合法；把剩下的两档依次摘掉 ⇒ **两次删除各等自己的那条
  DELETE 响应**（一次动作一条线，别拿上一次的响应冒充）；只剩一档时删除钮数为 0。
- **线 8/9**：技能全摘光 ⇒ 空态 + 「保存」仍在；上面加了五行、摘了五行、reload 过一次之后，
  控件仍各一份（不累加）。

## 7. 变异机：13 发该红全红，2 发控制组该活全活

`.workbuddy/round400-wire-mutations.mjs`（自回滚，逐发还原后比对 sha256，不符即 `exit 2`）。
线表从 spec 自己的 `// 线 N（…）` 注释现推，所以新加一条线不用改机壳。要点三条：

- **预热**：跑变异之前先跑一发未变异的绿，且每发的锚点必须**恰好命中一次**、`from !== to`
  （假变异防线），否则 `exit 3` 不动字节。
- **`--timeout=25000`**：M12/M13 把 DELETE 换成 GET 之后，测试等的是**那条 DELETE 响应**，
  它永远不会来 ⇒ 不打折就每发挂满 240s。未变异那一发实测 4s，25s 是六倍余量。
- **两发控制组应当 SURVIVED**：C1 改 help 文案、C2 改注释。没有它们，一把恒红的尺子和一把
  承重的尺子长得一样。

实跑：M1 添加技能按钮摘掉 / M2 技能行删除钮不渲染 / M3 技能页面行的撤销钮改打服务端 /
M4 备注那格不提交 / M5 执行器行删除钮不渲染 / M6 执行器页面行的撤销钮改打服务端 /
M7 序号改成数行数 / M8 换 kind 不重写 config / M9 kind 写死 / M10 enabled 写死 /
M11 只剩一档也给删除钮 / M12 技能 DELETE 不发 / M13 执行器 DELETE 不发 —— **13/13 KILLED**，
每发都红在自己的那根线上；**C1/C2 SURVIVED**；合计 **15/15 符合预期**，还原一致 **15/15**。

⚠ **机壳跑绿之前先补了五根线**：第一版写完变异清单，回头核对 M4/M8/M10 三发的**见证根本
不存在**（note 没填过、kind 没换过、勾选没取消过）—— 那三发按当时的 spec 必活。这不是判据
没牙齿，是**断言缺失 ⇒ 该发的线必活**。补上线 2c/4b/4e 之后才跑机，别拿一台没见证的机器交差。

⚠ **格式化之后必须重跑机，而且要看「红在哪条线」而不只看「15/15」**：`biome format` 把三处
锚点折成多行（`if (remove) row.append(…)` 拆成两行、`button("添加技能", () => {` 拆成整块），
机壳在预热就 `exit 3` 停机 —— 这一半是好事，锚点唯一性挡下了假绿。但**重跑通过之后归因表
变了两行**：M3 报「红在线 9 控件不累加」、M6 报「红在线 2b」。两发红的位置都不在预期的那
一根上，得分别取证才知道是「判据没牙齿」还是「归因表认错人」：

- **M6 是自己的线在红，归因表认错了人**。单发取证（`.workbuddy/round400-one-mutation.mjs`）
  看到的是 `toHaveCount(3)` 那一发：`Expected 3 / Received 4`，红的正是「撤掉刚加那一档 ⇒
  行数回到 3」这条断言本身（变异把 onClick 换成 `removeExecutor("", "99")` ⇒ 那一行撤不掉 ⇒
  多一行）。**为什么区间表把它报成线 2b，我没有复原出来** —— 只记下现象与复发判据：那次跑的
  是补线之前的 spec，补完线 2b 之后同一发报的是「线 4c」。归因表从线注释现推区间，所以
  区间边界一动，历史那次的对应关系就不可复现 ⇒ 以后凡是「红线与预期不符」，先跑单发取证看
  `> NNNN |` 那一行，别看机壳那一句。
- **M3 才是真问题**：它红在用例末尾那道**全用例共用的 console 清扫**（404 落在
  `/api/v1/members//skills/ghost`），而不是红线 2b 自己的断言 —— 线 2b 的注释写着「也不该发
  DELETE」，可它只断了「行数回去」与「库里那条还在」，**这一半从来没有自己的动作**。全局兜底
  能抓到它，是因为这条用例恰好没有别的失败请求，不是因为线 2b 在盯它。修法：给线 2b 补一组
  `page.on("request")` 计数，只挂在点删钮那一下前后，断言「这个窗口内 DELETE 数为 0」。
  补完 M3 红在 `线 2b 页面里那一行的删除钮`，与预期对齐。
  ⚠ 补第一版时我把计数按真成员号做了路径前缀 ⇒ **抓不到** M3 的 `removeSkill("", "ghost")`
  （那条路径的成员号是空串，`/api/v1/members//skills/ghost` 不落在 `/api/v1/members/<真号>/`
  前缀下）—— 判据要钉的是「这一个动作不该打服务端」，不是「不该打到这个成员」，所以按
  **任意 DELETE** 匹配。

改完最终一跑：**15/15 符合预期、每发红在自己那根线上**，证据
`.workbuddy/round400-mutation-final.log`（前一次 `.workbuddy/round400-mutation-rerun.log`
记的是补线之前那版归因，故意留着；两份 `.log` 都被 `.gitignore` 的 `*.log` 挡在库外，
复算请重跑 `.workbuddy/round400-wire-mutations.mjs`）。

## 8. 名单与旧台账的同步

`test/arch/ui-caller-roster.ts:242` 的名单摘掉那两条成员 DELETE ⇒ 现表 **10 条 / 8 条路径**，
处置 **【判断】3 / 【覆盖】3 / 【排期】4**（文件头那段口径说明里的计数一并改）。0069 §2 的
原句留着（它是「当时怎么读的」的记录），底下加 ⚠⚡ 标注指向本篇；0069 新起 §13 写复算过程；
`docs/INDEX.md` 的 0069 入口行追加作废说明。另把 group.js 位移带来的坐标全体重钉：
`git diff -U0` 的 hunk 头算出 6 处 SNAP 键 + 6 处散文引用平移，最终落点**全部 +103** ——
其中 **+100 来自本篇自己往 group.js 里插的那一百行**（行构造器 + 两个 handler + 注释：HEAD
9522 行 → 本篇改完 9622 行），**+3 来自 `biome format` 折行**（9622 → 9625）；本篇以下的坐标
整体被顶下去，本篇以上的坐标一条没动（0075 钉的那枚「新建模板」按钮、0076 钉的侧栏点群那一行
都在插入点之上）—— 这正好是「位移只发生在插入点之下」的形状，也是对映射表的一发交叉核对。按 hunk 算术改，不按内容 grep（round395
那次链式替换的失败形状）。格式化之前那一趟由 `.workbuddy/round400-repin.mjs`（0080 那篇带来的
hunk 算术脚本，只做映射、拿内容做校验）完成，产出 `.workbuddy/round400-line-map.json`；
格式化之后的收尾见下面第三条。

⚠ **这一格我踩了两次，形状值得记**：格式化之后坐标又动了一次，我用了两条**链式**的重钉脚本，
两条各自都「报成功」，合起来把台账改坏了：

1. 第一条按 MAP 搬键，同时**顺手重写了 SNAP 的值** —— SNAP 的值是「那一行的原文」，重钉坐标
   时改值等于**给旧主张换了个新标签**（旧主张从此再也红不了）。它把 0075/0076 两格的值改成
   了别的行的内容。
2. 第二条改成「保值只搬键」，但它的 SNAP 扫描只认单行写法那一种形态，认全的键集合不完整，
   拿到的映射不完整 ⇒ 应用后出现「同一条 group.js 路径出现两条同名键」（`9221 → 9224` 这一档
   映射与本来就存在的 `9224` 撞在一起）。dup 审计与 doc-refs 当场报「有键被顶掉」。
3. 而且它只遍历 `git ls-files` ⇒ **未跟踪的新台账（本篇自己）压根不在重钉面里**，所以脚本
   跑完本篇正文仍是格式化前的坐标。

**复原的做法**（比再写第三条脚本可靠）：`git checkout --` 那三篇被机械改过的旧台账（改之前
先用 `git diff --stat` 证明它们**只**含 group.js 数字引用这一类改动，否则不许 revert），
SNAP 键按**唯一内容锚点**现推目标行号（`.workbuddy/round400-audit-group-snap.mjs`：逐条拿值
在 group.js 里找命中，命中数 ≠ 1 就不许搬），一次性给出 `8834→8837 / 9170→9173 /
9171→9174 / 9221→9224 / 9224→9227` 这张表 —— **一次过**，`9221→9224` 与 `9224→9227` 必须
在同一趟里换，分两趟必然自撞。全程不碰任何值。终态由 `.workbuddy/round395-snap-dup-audit.mjs`
报「358 行 / 去重 358 / 重复 0」与 doc-refs 全绿一起验收。

## 9. 别当成做到了

- **服务端零改动**，也**零新界面栏目**：本篇只是把一栏本来就该有的增删接上，没有新增页面。
- 【排期】那 4 条（分发规则配置页三条 + 签票入口）**一条都没接线**，口径仍在 CEO 那一格；
  本篇动的是名单里被我**误判成【覆盖】**的两格，不是等人拍板的那一格。
- **CSS 没动**：每行多出来的那枚图标按钮落进 grid 的隐式 auto 列，招聘弹窗的行本来就是这个
  形状；除本篇 e2e 之外没有别的守卫量 `.skill-row` / `.executor-row` 的几何 ⇒ 「排版没变坏」
  这句**未被机器判过**，只做过目测。
- 「路由早就有」不等于「装配全通」：这两条 DELETE 的**权限/审计**面本篇没碰，测的是
  回环鉴权下的正常路径。
- **入库形状**：`.workbuddy/*.mjs` 是被跟踪的（变异机 `.workbuddy/round400-wire-mutations.mjs`、
  单发取证 `.workbuddy/round400-one-mutation.mjs`、锚点核对
  `.workbuddy/round400-anchor-check.mjs`、SNAP 审计
  `.workbuddy/round400-audit-group-snap.mjs`、两条**改坏过的**重钉脚本
  `.workbuddy/round400-repin-after-format.mjs` / `.workbuddy/round400-repin-by-content.mjs`
  一并入库，头部各写了自己为什么不能再照抄），`.workbuddy/scratch/` 不入库；
  ⚠ **日志不入库** —— `.gitignore` 第 39 行那条 `*.log` 把
  `.workbuddy/round400-mutation-final.log` 这类挡在外面（我先在本篇 §9 写过「证据日志入库」，
  那句是错的，照原样留着并在此更正）⇒ 上面那些读数**只有台账这一份**，复算要么照 §10 那条
  复算命令重跑机，要么信这一份。

## 10. 实跑读数

红探针 **`14 × 0 elements`**（HEAD 版 group.js 现跑取证，还原后与工作树那份逐字节一致，
三份 sha256 全值见 `.workbuddy/round400-group-sha.txt`：head / pre-format / post-format）
→ 落地 **1 passed (3.5s)** → 补五根线后 **1 passed (4.0s)**。

- **变异机跑过三趟**：格式化前 **15/15**；`biome format` 之后重跑 **15/15 但归因表变了两行**
  （M3 红在末尾的全局 console 清扫、M6 被区间表认成线 2b）→ 给线 2b 补上它自己的 DELETE
  计数之后第三趟 **15/15，每发红在自己那根线上**（`.workbuddy/round400-mutation-final.log`）；
  逐发还原 SHA **15/15 一致**。中间那趟的日志 `.workbuddy/round400-mutation-rerun.log` 留着，
  它是「机壳全绿但判据不承重」那件事的物证。
- **单发取证** `.workbuddy/round400-one-mutation.mjs`：M3 = `browser console errors: 404`
  红在 `group-workbench.spec.ts` 末尾那道全局清扫（`expectNoBrowserErrors` 里那句
  `toEqual([])`），M6 = `toHaveCount` 的 `Expected 3 / Received 4` 红在「行数回到 3」那一发自己。
- **全量** `npx vitest run`：**205 文件 / 4241 passed | 6 skipped**（4247）exit 0。
- **全量 e2e** `npx playwright test`：**66 passed (1.1m)**（基线 65 + 本篇新那一条）。
- **类型** `tsc -b` 与 `tsc -p tsconfig.test.json --noEmit` 均 exit 0。
- **biome** `pnpm lint` exit 0：**0 error / 93 warning**（本篇那三个文件曾被 `format` 判 3 条
  ⇒ 按纪律是**改代码**、不是往 `LINT_BASELINE` 里登记）。
- **文档守卫**：doc-refs 全绿 + `.workbuddy/round395-snap-dup-audit.mjs` 报
  **358 键 / 去重 358 / 重复 0**；doc-coords、doc-ids、claim-coords、claims-registry、
  ui-caller-roster、dead-modules、zero-producer、exempt-pierce、lint-baseline 全绿。
- **待决登记表**：`pending-decisions` 在本篇开工前就有一发**旧红**（`0080 §8` 声明在等决策、
  却没登记在入口处）。归属用两条 HEAD 侧的直查证明，不靠工作树复现：
  `git show HEAD:docs/decisions/0080-….md | grep -c '^## 8\..*CEO'` = **1**（那一节在 HEAD 就
  存在且带 CEO 字样 ⇒ 守卫认它是待决小节）、`git show HEAD:docs/INDEX.md | grep -c
  '^- \*\*0080 §8\*\*'` = **0**（HEAD 的登记表里没有那一行）⇒ 红在 HEAD 就成立，与本篇无关。
  补了 INDEX 那一行之后双向一致。
- **哈希核对** `node docs/review/verify-open-invariants.mjs` exit 0（本篇台账里那两个
  sha256 前缀已经**从正文删掉**：短前缀会被当成 git 对象 ⇒ 报悬空引用，全值改放证据文件）。
- **check-gate** `node docs/review/check-gate.mjs`：「判不了或不符的项：**0 无**」。
- **U+FFFD** 本篇台账、INDEX、两份旧台账、spec、doc-refs 各 **0**。
