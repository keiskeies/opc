# 0014　策略引擎自动审批：写完才发现整个 `src/policy/` 在运行时一次都没被调过（同族缺陷第五次），而我的「接线断言」是一条怎么修都红的断言

> 本篇是 Task 3.5 的**实现记录**。编号顺接 0013（0002 按计划预约给 Task 4.6，仍空缺）。
> 落点：`packages/hub/src/policy/auto-approve.ts`（判定 + 写入 + 日报聚合 + 同类历史计数）、
> `packages/hub/src/replay/query.ts`（§22.3 第二条那条标注，本轮接上）、
> `packages/hub/test/policy/auto-approve.test.ts`（42 例）。
> §10 有一项**需要 CEO 拍**，已登记在 `docs/INDEX.md` 等待区。

## 1. 一句话

计划 Task 3.5 的四条 Test（自动通过写审计且含 `auto_approved_by`；任一条件缺失 → 降级人工；
不可逆永不自动通过；记入日报）全部落地，另加两条计划没要求的（条件**逐项点名**、
每次自动批准自带 `action_fingerprint`）。但本篇最该读的是 §3：
**写完去查调用方，发现 `src/policy/` 整个目录在运行期零调用方** ——
不是我这个文件没接上，是 Task 1.5 那个策略引擎从落地那天起就没有接进任何运行期。
于是「自动审批」今天的准确状态是：**判定与留痕的机制齐备，产生它的那一步不存在**。
我按这个状态收尾而没有造一个生产者，理由和代价都在 §3。

先给三条最值钱的：

1. **一条「怎么修都红」的断言比恒绿的更贵**（本篇 §8 第 2 项）。我写的接线断言是
   `expect(query.ts).toContain(AUTO_APPROVED_BY)`，而正确的读侧**刻意不写这个值**
   （它判 payload 的键 `auto_approved_by`，署名换不改读侧）⇒ 接上了它也永远红，
   唯一出路是被人删掉。
2. **`blocked_by` 的四个枚举值里有一个结构上到不了**（§4），而且它不是内部中间量，
   是写进对外类型的输出值。
3. **`json_extract` 对畸形 JSON 是抛错而不是返回 NULL**（§6，实测）。
   后果是一条与日报无关的坏行能让整页日报打不开，而报错里没有任何线索指向那一行。

## 2. 实现：三档各挡住什么

`autoApprove()` 是纯函数（不查库、不读时钟、不发消息），顺序本身就是判据：

```
黑名单 → policyDecide（forbidden + 分级）→ R3 不可逆短路 → R1 只读 → R2 可逆历史 → 条件未齐
```

| 规则 | 条件 | 挡住的失效 |
|---|---|---|
| **R1** `read_only_evidence_gate` | 只读 + 证据包对账 `ok` + 门控 `passed`（计划 Test 原文） | 「只读所以不用留证据」—— 只读动作也能泄敏感数据，§24 风险 1 要的正是可追问 |
| **R2** `pattern_reversible` | 可逆 + 同类历史 `nonApprovals === 0` 且 `approvals ≥ 10`（规格 §9.1 第 858 行） | 「攒够次数就批」—— 规格 §9.1 原话是『**均**批准』，一次打回就把模式打断，所以 `nonApprovals > 0` 是**断**而不是「扣一分」 |
| **R3** 不可逆短路 | 判 `irreversible` ⇒ 直接 `require_approval`，**不接受任何前置条件组合** | 错分类。它是**否决**而不是**条件**：混进 `missing` 数组的话，日报里「不可逆被拦下」与「证据没交」就成了同一格，而前者是**设计在工作** |

R3 排在最前，所以有一条对抗用例：`irreversible` + 证据齐 + 门控过 + 同类历史 999 次全批
⇒ 仍然 `blocked_by: "irreversible"` 且 `missing: []`。它带一条反向对照（同样前置全齐的
**可逆**动作确实被自动通过）—— 少了反向对照，「所有动作一律拦」这种实现也能让对抗用例绿。

条件缺失时**逐项点名**（`MISSING_REASONS` 七个值）。产品理由写在文件头：CEO 拿到一张
「需要人工」的卡片而不知道为什么，只能把整包证据重看一遍，那正是 §9 北极星（八成审批
由规则决定）想省掉的成本，一句模糊的降级会把它**加回来**。

写入侧 `recordAutoApproval()` 沿用 `applyDecision` 那三条纪律（`real-deps.ts`）：条件 UPDATE
先行（`CLAIM_APPROVAL_FOR_AUTO_SQL` 的 `AND status = 'pending'`）、抢不到就**一条审计都不写**、
actor 用 `{ system, policy-engine }`。两个细节值得单独说：

- `decided_by` 落 `policy-engine` 而**不是** `ceo`。规则没有签名权，写 `ceo` 是伪造审批签名。
- `action` 仍是 `approval`，不新开枚举值。§22.1 那张表（实测 10 个值）里没有「自动批准」，
  而新开一个值会让所有按 `action = 'approval'` 统计的面（收件箱计数、日报）当场少一批。
  区分靠 `actor_id` + `payload.auto_approved_by`。

## 3.【本轮最重要】`src/policy/` 在运行期零调用方：同族缺陷第五次

写完去补 §10 那张「谁产出、谁消费」的表，往下摸数据线，量到的是：

```
$ grep -rn "policyDecide" --include='*.ts' . | grep -v node_modules | grep -v "/dist/"
   ⇒ src 侧只有 policy/engine.ts 的定义与 policy/auto-approve.ts 的调用；其余全在 test/
$ grep -rn "classifyAction" --include='*.ts' . | grep -v node_modules | grep -v "/dist/"
   ⇒ 文件只有 policy/engine.ts（自身）与 test/policy/classify.test.ts
$ grep -rln "policy/" --include='*.ts' packages/hub/src | grep -v "src/policy/"
   ⇒ graph/routing/escalation.ts（只在注释里提到）、replay/query.ts（本轮我加的标注）
$ grep -rn "ActionDraft" --include='*.ts' packages/hub/src | sed 's/:.*//' | sort -u
   ⇒ 只有 policy/engine.ts 与 policy/auto-approve.ts 两个文件
```

四条合起来：**没有任何生产代码构造过 `ActionDraft`**。也就是 Task 1.5 交付的
`classifyAction` / `policyDecide` 到今天为止的运行时消费者是 0，
本文件交付的 `autoApprove` / `recordAutoApproval` 也是 0，
`readAutoApprovalReport` 也是 0。`policy/` 是一个自带全套测试的**孤岛**。

这不是我这个文件的孤立事故，而是同一族缺陷的**第五次**：
0011 §8（`validateOrgGraph` 三个函数零调用方）、0012 §7（`tasks.graph_version` 零写入方）、
0013 §7（`searchEvents` 22 条用例零调用方）、0013 §10.1（`approvals` 零 INSERT）。发现方式还是同一条 —— **不是想到去查调用方，
而是写文档时顺数据源往下摸**。这条差别本身值得记：四次都是写文档摸出来的，
说明「写完代码想一遍调用方」这个习惯我没建立起来，靠想到是无效的（前四次也没想到）。

**为什么不硬接一个生产者。** 今天唯一的运行期是 CLI 的桩图（`graph/company.ts`），
它的节点体只写状态边、不执行任何动作（实测：`company.ts` 里 `interrupt(` 0 处，
`ActionDraft` 0 处）。在那里调一次 `autoApprove` 等于给每次 `hub run` 伪造若干条
「策略引擎批准了某动作」的**不可删除**审计行（events 是 append-only，0001 那两个
`RAISE ABORT` 触发器）。这不是假设有风险的洁癖：
「自动批准可追溯」的**全部内容**就是那些行可信，往里写没发生过的事，
是拿这个任务唯一交付物去换一个绿色的演示。
**少一个生产者是可以接上的缺口；脏了的审计库删不掉。**

**0013 §10.1 给 Task 3.5 立的那条收尾要求，本轮【没有满足】。** 原话是：
『Task 3.5 收尾时必须有一条**存在性断言**（src 里 `"INSERT INTO approvals ("` 的命中数 > 0）』。
我落地的是**反向**的断言（⑧ 那节钉住命中数**等于 0**）。这不是忘掉那条要求，是它的
前提被本轮的实测否证了：那条要求假设「3.5 会创建卡片」，而创建卡片需要的是
**动作执行路径**（§3），不是审批模块本身。为了让那条断言变绿而往桩图里加一条 INSERT，
会同时违反本节上面那段（伪审计行）与 §10（范围变更）。
所以我做的是它的**意图**那一半 —— 不许「全绿而只作用于测试自己插进去的行」——
办法是把缺口本身钉成断言 + 登记等 CEO 拍（§10 的 α）。**这条偏离请当成偏离读**，
不要因为 ⑧ 那节全绿就把它读成「0013 要求的那条已经落地」。

**为什么仍然接消费侧。** 只有生产者没有消费者是白写，只有消费者没有生产者可接。
所以本轮真接上的是读侧那一半：`replay/query.ts` 的 `auto_approved` 标注（§22.3 第二条），
从真库走 `buildReplayView` 覆盖，并带一条人工批准的反向对照。生产者到位那天标注立刻有数据。

这条状态由测试钉住而不是由我这张嘴说：`auto-approve.test.ts` ⑧ 那节扫 `src` 目录，
断言「建卡片的人 0 条」「`autoApprove` 调用方 0 条」—— **接线那天它会红**，
逼着接线的人同时来更新本篇。同节还钉住「消费侧已经接上」（判据是 `query.ts`
含 `auto_approved_by` 与那句界面措辞）。

## 4. `blocked_by: "policy_forbidden"` 结构上到不了

`autoApprove` 第一发是自己调 `matchForbidden(a, o.forbidden ?? [])`（命中 ⇒
`blocked_by: "forbidden"`）；第二发 `policyDecide(a, { forbidden: o.forbidden ?? [] })`
内部判 forbidden 用的是**同一个 `matchForbidden`、同一组入参**，
于是第一发返回 `undefined` 之后第二发不可能判 forbidden。
**这两个 `blocked_by` 值是同一件事的两个名字。**

比 0013 那条「FTS 0 命中 ⇒ 降级 LIKE 永不可达」更糟一点：那个不可达分支不影响输出，
这一个不可达分支**是一个对外承诺的输出值** —— `BlockedBy` 把它列进枚举、注释写着
「策略侧同一条」。谁按它做统计会永远得 0，并把 0 读成「本周没有动作被策略拦下」，
而真相是被拦下的全记成了 `"forbidden"`。

处置：**保留分支**（它是「万一有人把上游那一发删了」的兜底；删掉反而把安全性
绑在调用顺序上），但把「两个名字其实是同一件事」钉成断言（测试 ⑩）：
`policyDecide` 判 forbidden 的四个动作，`autoApprove` 一律报 `"forbidden"`。
反向对照真跑代码 —— 同一批动作在黑名单为空时必须都不报 `forbidden`。
我第一版写的反向对照是 `expect(matrix.length).toBeGreaterThan(0)`，恒真，
属于 0013 §8 判掉的那一类（反向对照必须经过被测代码），已换掉。

## 5. R2 的输入今天在库里读不出来

规格 §9.1 那一档的输入是「过去 10 次**类似**决策」。类似要可比，可比要有指纹。实测：

- CEO 决策落库的 payload 只有两个键 —— `real-deps.ts` 里那句
  `const payload = { approvalId: o.approvalId, resume: o.resume };`，
  **不带被批准的是什么动作**。所以「同类」在人工决策那一侧根本没有字段可比。
- `approvals` 行里有 `approval_type`，是唯一的弱口径 —— 而 `approvals` 在 src 里
  一次 INSERT 都没有（0013 §10.1），连这个口径也没数据。

⇒ `SimilarHistory` 由**调用方传入**，缺 ⇒ 前置不齐 ⇒ 转人工。本模块**不**从库里猜一份历史：
猜出来的历史会让一次本该上人的审批自动通过，那不是分类错，是**证据凭空**。
`countSimilarApprovals()` 按 `approval_type` 读 `approvals`，在今天的真库上恒返回 0，
**那是正确答案而不是缺陷**（库里确实一张卡片都没有）。

这里有一个必须写下来的坏性质：因为历史是外部传入的，
**「没有历史」与「历史全是打回」在今天的运行期给出同一个结论**（都转人工），
而它们的修法完全不同（前者是数据没接上，后者是模式确实不成立）。
缺的那块地基是 `action_fingerprint`（sha256(角色 + 动作类别 + 动作描述) 前 16 位），
每次自动批准自带它 —— 从这一刻起新写入的自动批准才是可比的。
**但指纹要攒够 10 次才有意义，所以 R2 在生产里第一次真正可用是「接上生产者之后的第 10 次」**，
这条时间差没写在计划里，也不该由我抹掉（`PATTERN_MIN_APPROVALS` 改成 5 是收紧/放宽，§4.4.3 归 CEO）。

## 6. `json_extract` 抛错这件事（实测）

日报聚合走 SQL。三条实测事实：

| 事实 | 后果 |
|---|---|
| `json_extract(payload,'$.x')` 对 `{not json` ⇒ **抛** `malformed JSON`（不是 NULL） | WHERE 里的 `json_extract` 会对**同一时间窗里任何一行**求值，包括一条 `action='state_change'` 的坏行（它根本不会进结果集）。症状是「日报整页打不开」，报错里没有那条行的 id 也没有它的 action —— 把一次**数据事故**伪装成一次**功能故障**，人会去修没坏的那一半 |
| 修法：先用 `json_valid(payload) = 0` 探针点名（报 `id(action)`），再出数；探针命中 ⇒ **拒绝出数** | 「宁可不出数」与 0013 §2-① 同一条判据：给出错的行比给不出结果更坏，后者只会让人换个条件再查 |
| `COUNT(*) OVER ()` 在 `LIMIT` **之前**求值（`LIMIT 1` 时 `total_rows` 仍是 5） | 总数与这一页明细同源于**一次**查询。两次查询之间那一次写入会让「total = 7」配一份 8 行明细，而总数与明细矛盾时读的人无从判断哪一半真 |

**判据用 `json_extract` 而不是 `LIKE`**，也是实测选的：同一份夹具
`LIKE '%auto_approved_by%'` 给 6、`json_extract` 给 5，多出来那条只是**提到了这个字段名**
（一条写着「auto_approved_by 不可用」的报错审计）。测试里加了一条**元断言**
（0013 §8 那条规矩的执行）：直接断言「LIKE 数出 2 而日报数出 1」，
否则夹具一旦不再含那条假样本，这条用例就悄悄失去分辨力。

日期边界用 **UTC 日**：`created_at` 是毫秒 epoch，用本地时区会让同一份库在两台机器上
给出不同的「今天」，而日报的数字必须只有一个答案。时区展示是渲染层的事。

## 7. 规格自身的两处合并与一处空白

都不是我编的，逐字对过：

1. **规格 §22.3 第 1631 行把 §9.1 的三档合并成一句措辞。** 原文
   『策略引擎自动通过的决策 → 标注「基于模式的自动批准」』，
   而「基于模式的自动批准」在规格 §9.1 里是**第二档**（第 858 行）专属的短语，
   第一档叫「自动放行」。照字面实现，一条只读自动放行也会被标成「基于模式的自动批准」。
   我的处置：`annotation` 照规格逐字给（界面上那句归规格管，改它要过一次文档），
   同时把 `rule` 原样带进 payload 与回放条目，让界面**想分开时有数据可分**。
   规格的这处合并登记在此，等 CEO 或规格改动来消解（§10）。
2. **「日报」在计划里只出现在 Task 3.5 那一行**（实测 `grep '日报' 计划` 1 命中），
   没有任何任务立它；规格里它在三处（第 861 行、§16.3 的「自动决策摘要」、§16.5 的
   「策略摘要条」，实测 `grep '日报'` 的命中不含后两处的措辞 —— 那两节写的是「摘要」）。
   所以「记入日报」这个验收**没有承载物**。我做的是**那一格数据**
   （`readAutoApprovalReport(db, {day})` → 当天总数 / 按规则分组 / 卡片未认领数 / 明细 / `has_more`）
   并明确不新增 HTTP 端点 —— 加一个端点要同时动
   `contracts/api.ts`、`http/app.ts`、`desktop/main/channels.ts`、`preload/api.ts`，
   并被 `test/desktop/ipc-surface.test.ts` 的 `toEqual` 钉住（本机没有 Electron 可验）。
   这条成本 0009 §7 已经写过一次：Phase 2 的路线（R）与桌面端那套要一起等一个能装依赖的环境。日报的 UI 落点归 Phase 4/5（§16 那些页面）。
3. 顺带一条与本篇无关但同源的：§16.3/§16.5 那两行摘要写的是「24 小时」滑动窗口，
   而 §9.1 第 861 行写的是「日报」。**两种口径的数不一样**（一天前的批准在 24 小时口径里已划走）。
   我的 API 只给「按 UTC 日」那一种，因为它是可复现的唯一口径；滑动窗口是渲染层能算的，
   但**由谁来算得先定口径**。

## 8. 我这边做错的三件事，外加顺手修掉的守卫假绿一处

1. **夹具第五次说谎**（同 0013 §3 那一类）。我以为黑名单条目 `"读取 secrets"`
   会命中 detail `"读取 src/secrets.ts"`，实测**不命中** —— `matchForbidden` 是双向包含，
   而 " src/" 把两条含关系都切断了。那条「黑名单赢」的用例于是拿到 `auto_approved`。
   改成 detail `"读取 secrets 目录"`（实测命中）并补了反向对照。
   写这条不是因为红了，是因为**夹具假装具备的性质恰好是用例要证的性质**。
2. **一条怎么修都红的接线断言**（§3 提到的那条）。`toContain(AUTO_APPROVED_BY)`
   在正确实现下也永远不绿，因为读侧判的是 payload 的**键**、刻意不写署名的**值**。
   改成断言 `auto_approved_by` + 界面措辞两个字段名。附一条诚实说明：
   这条断言**仍然弱** —— grep 分不出代码与注释，而 `query.ts` 的注释里也写着那句话；
   真正有分辨力的是同一文件里那两节从真库走 `buildReplayView` 的用例。
   报「我加了一条接线断言」而不报它有多弱，就是我一直在犯的那个错。
3. **`exactOptionalPropertyTypes` 下索引访问可选属性带 `| undefined`**，
   展开进对象字面量当场 TS2375。我没用 `!` 或 `as` 糊过去，
   是把那个类型单独命名成 `AutoApprovedAnnotation`（「可选」只留在字段上）。
   记这条是因为它是我这一轮唯一一次**被类型系统纠正**而不是被测试纠正 ——
   而 tsc 在本机是 34 个既有错误（全是装不上的依赖）的环境里跑的，很容易把新错误当噪声放过。

外加一条**不是我写坏、但本轮由我修的**：

**`doc-coords` 的篇号前缀 `000[1-9]` 只认到 0009，于是 0010 之后的跨篇引用【从未被校验过】**。
   形状很坏：`0013` 正文里写 `0012 §7`，那组正则不匹配篇号 ⇒ 整条被当成【本篇的裸形 §7】，
   而本篇恰好也有 §7 ⇒ **被自己的编号洗白**，一路放行。
   这条是本轮把 `SEC_RE` 改成 `0\d{3}` 之后由守卫自己报出来的（探针脚本 `matchAll` 新旧两版
   对比，新识别出的跨篇前缀 0010 / 0011 / 0012 / 0013 共 20 处）。
   它与本篇主题同一条判据：一个【看起来在查、其实没查】的守卫，比没有守卫更贵，
   因为它会把「没查」生产成「查过了」。
   改完当场付了一次代价：我在新写的注释里举那个漏检形状时**写出了那个形状**，
   `comment-citations` 立刻报「目标决策文档不存在」—— 守卫是对的，改的是我的例子。
   记这条是因为它正好证明这类假绿**不是想防就能防住**：写正则的人（我）不知道它只认到 0009，
   直到有人把第 10 篇写进去。

## 9. 没做到（不写成「换种方式做到了」）

- **没有生产者**（§3）。规格 §9.1「模式自动通过」在生产里今天不可能触发。
- **没有日报面**（§7-2）。只有那一格数据。
- **R2 的「同类」仍不可计算**（§5）。新写入的自动批准自带指纹，但历史侧（人工决策）
  不带，所以「过去 10 次同类」目前只能由调用方自己数并自己负责。
- **`readAutoApprovalReport` 零消费者**，且**它不在 §22.3 那条标注的同一条通路上** ——
  回放标注是接上的，日报聚合是待接的。
- 未跑 `pnpm verify`（本机装不上依赖；沿 0009 §2）。本轮跑的是：
  `node --experimental-transform-types --test` 全量 **743 例 / 698 pass / 37 fail**
  （基线 701/656/37：用例数增加而失败数不变），红名单 60 行与 pin 住的基线
  `diff` **完全一致**；`tsc -b --force` **34 错**，与基线同数、且不含
  `policy/auto-approve.ts` 或 `replay/query.ts`；
  文档守卫（doc-coords / doc-ids / doc-refs / decision-index / pending-decisions /
  comment-citations / commit-msg-refs）**55/55 绿** —— 这三个数的口径都是
  「我最后一次跑的时候」，本篇每改一次措辞，用例数与 pass 数都可能再动，
  别把它当常数引（0006 §7 那条「随写而变的计数不该当事实」同一件事）。
  那 37 条红的成因是 `tsx/cli` 与 `@langchain/*` 装不上（14 条 CLI 子进程 + 若干
  arch/graph），不是本轮引入的回归 —— 但**这条结论靠的是红名单 diff，不是我的印象**。

## 10. 需要 CEO 决策

规格 §9 的北极星是「八成审批由规则决定」，§23.1 Phase 3 的验收是「自动通过的决策在日报
可见且可追溯」。实测（§3）：**策略引擎在今天的生产运行期里一次都不参与决策** ——
没有代码构造动作草案，所以三档分类、门控前的那一道、自动通过、日报聚合，
全部只在测试里跑过。这不是 Task 3.5 没做完，是**从 Task 1.5 起就缺一个把策略引擎
放进动作执行路径的人**，而那一步在计划 58 个任务里没有立项。

三个选项，各自的代价：

- **α 补一个任务**：在节点执行侧（真执行动作的地方）构造 `ActionDraft` 并过
  `policyDecide` / `autoApprove`，同时给 `approvals` 补 INSERT（卡片真的存在）。
  代价：那是**新的运行期行为**（每次动作前多一次判定 + 可能多一条审计），
  属范围变更，需你认账；且它依赖「角色真的执行动作」，而那要等 Phase 5 的真模型接入，
  现在接只能接在桩上（接桩就是我 §3 拒绝的那个东西）。
- **β 就地降级 §9 / §22.3 / §23.1 Phase 3 的措辞**：写明本期策略引擎是
  「可离线调用的判定与留痕库」，自动审批的可追溯性验收推到角色真执行动作的那个阶段。
  代价：Phase 3 那条验收不再由本期负责，我这份实现的**存在理由**推迟兑现。
- **γ 认定 §9.1 第二档过度设计、删掉模式自动通过**：只留自动放行与必须人工。
  代价：§9 那句北极星指标失去大半内容（自动放行本来就零成本、不留痕）。

**我倾向 β**：α 的落点今天不存在（不是没写，是没有「动作执行」这个概念），
硬造会把审计库弄脏；γ 会砍掉规格明确想要的产品能力，那更不该由实现层顺手做。
β 只需要改三处措辞 + 挂一条账。这一项**卡** Phase 3 出口门禁里
「自动审批可追溯」那条验收能否被判绿，**不卡** Task 3.6 / 3.7。

## 11. 复算命令

```bash
# ① policy/ 是不是孤岛（§3）。四条各自独立，src 侧命中数应全为「仅 policy/ 目录自身」
grep -rn "policyDecide\|classifyAction\|ActionDraft" --include='*.ts' packages/hub/src | grep -v "src/policy/"
# ② blocked_by 四个值里被真产出的有几个（§4）：期望只出现 forbidden / irreversible / conditions_unmet
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node --experimental-transform-types \
  --import /tmp/opc-harness/register.mjs --test packages/hub/test/policy/auto-approve.test.ts
# ③ json_extract 抛错（§6）—— 三行输出应分别是：抛错 / 0 / 1
PATH=~/.nvm/versions/node/v24.14.0/bin:$PATH node --experimental-transform-types -e '
const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");
d.exec("CREATE TABLE e(payload TEXT, created_at INTEGER)");
d.prepare("INSERT INTO e VALUES (?,1767398400000),(?,1767398400000)").run("{not json","{\"a\":1}");
try{d.prepare("SELECT id FROM e WHERE json_extract(payload,\x27$.x\x27) IS NULL").all();console.log("不抛（与本篇不符）");}
catch(x){console.log("抛：",x.message);}
console.log("json_valid 非法行 =",d.prepare("SELECT COUNT(*) c FROM e WHERE json_valid(payload)=0").get().c);
console.log("窗口函数在 LIMIT 前 =",d.prepare("SELECT COUNT(*) OVER () t FROM e LIMIT 1").get().t);'
```

①③ 只依赖仓库文件与本机 Node，任何人随时可跑。③ 里用 `require` 是因为 `-e` 走 CJS；
换成 `--input-type=module` 就得改 `import`。
② 那条依赖 `/tmp/opc-harness/`（我的离线夹具，按 0012 §7 的口径它不进仓库、
也不进 `node_modules`）—— 没有它就用 `pnpm test`。这条**是本篇里唯一不能当场复算的一条** ——
`/tmp` 会清，而按 0012 §7 的口径它不进仓库。没有那个夹具时 ② 只能整体跑 `pnpm test`，
而 `pnpm verify` 本机跑不了（0009 §2）。所以 ② 的准确身份是「我跑过、你能读到命令、
但不保证你现在能跑」，与 ①③ 那种【任何人随时可跑】不是一个等级，别混着读。
