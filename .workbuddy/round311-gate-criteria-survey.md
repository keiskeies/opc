# round311 调研：「门控读岗位书」那半该不该现在接（只读复算，未跑 vitest）

产物：本文件。全程只读 + 只读 node 探针（:memory: 迁移复算 / dev.db readOnly 打开），
未改任何 src/harness、runtime、测试。探针原文贴在下面，任何人可原样重跑。

---

## ① 两条前提的复核结果

### 前提 1：`gateCriteriaForRole` 在 packages/hub/src 零生产调用方 —— 【成立】

本轮探针（不抄 round288 的数；仓库范围扫 `.workbuddy/node_modules/dist` 之外的全部 `.ts`，
按【调用语法】`(?<![.\w$])名字\s*\(` 匹配、定义行单独标 DEF、test 目录单独归类，
并把每一处命中原文打出来人工逐点确认）：

复算命令（原样可跑，Node ≥ 22）：
```
node -e 'const {readdirSync,readFileSync}=require("node:fs");const {join,sep}=require("node:path");
const SKIP=new Set(["node_modules",".git","dist",".workbuddy","coverage"]);
function walk(d,o){for(const e of readdirSync(d,{withFileTypes:true})){if(SKIP.has(e.name))continue;
const p=join(d,e.name);e.isDirectory()?walk(p,o):/\.(ts|tsx)$/.test(e.name)&&o.push(p.split(sep).join("/"))}return o}
for(const sym of ["gateCriteriaForRole","gateCriteriaForRoleAtVersion"]){
const CALL=new RegExp("(?<![.\\\\w$])"+sym+"\\\\s*\\\\(","u");
const DEF=new RegExp("(export\\\\s+)?function\\\\s+"+sym+"\\\\b","u");
for(const f of walk(".",[])){readFileSync(f,"utf8").split(/\r?\n/).forEach((l,i)=>{
if(DEF.test(l))console.log("DEF",f+":"+(i+1),"|",l.trim());
else if(CALL.test(l))console.log(f.includes("/test/")?"TEST":"OTHER",f+":"+(i+1),"|",l.trim().slice(0,110))})}}'
```
输出（2026-11-19 实测，扫 298 个 .ts）：全部命中逐条如下，**OTHER（非 test、非定义）为 0**：
- `DEF packages/hub/src/charter/store.ts:557` `export function gateCriteriaForRole(`
- `DEF packages/hub/src/charter/store.ts:578` `export function gateCriteriaForRoleAtVersion(`
- TEST ×7：`packages/hub/test/acceptance/phase3.test.ts:268,288,312,326,355,402,621`
  （形如 `gateCriteriaForRole(db as never, "dev")`，全是真调用不是提及）
- TEST ×4：`packages/hub/test/charter/store.test.ts:434,451,462,501`
- AtVersion 同理：TEST ×5（phase3:320,327 + store.test:494,495,496），OTHER 0。

注释提及（已人工确认全部是注释行，未计入）：`engine/runtime.ts:301`、
`charter/store.ts:453,555`、`test/arch/dead-modules.ts:409` —— 即文档警告过的
「第三次踩坑」那两处同源命中今天仍在，本探针按行首注释/逐点人工双保险剔除。
⇒ 文档 476-488 行那句「零生产调用方」今天**仍成立**；测试调用方仍是两个文件（phase3 七发 + store 四发）。

### 前提 2：`role_charters` 今天 0 行 —— 【主体成立，但有一条需要修正的读数】

三段证据：

(a) **新库恒 0**（复算）：把 `packages/hub/resources/migrations/` 全部 9 条 `.sql`
在 `:memory:` 依次执行后 `SELECT COUNT(*) FROM role_charters` ⇒ **0**。
迁移里没有任何 `INSERT INTO role_charters`（grep 全目录：无命中）。

(b) **播种路径恒拒**（代码复算，未跑 CLI）：
七份模板每份都含占位串 `CEO-PLACEHOLDER-ACCEPTANCE`（`grep -c` 七份各 2 处：
`packages/hub/resources/charter-templates/{assistant,ceo,dev,ops,product,tech,test}.yaml`）；
`charter/seed.ts:510-518` 对 condition 与 message **两侧**查占位串 ⇒ 七份全进 problems；
`seed.ts:347-361` 判据 A 报「占位串未签」；`seed.ts:620-629` 一条不写、返回
`EXIT_PROBLEM`（=1，`heartbeat/maintenance.ts:55`）。⇒ 「跑 seed 退出 1 且零写入」成立。

(c) **但本机 dev.db 不是 0 行**：只读打开 `D:\item\opc\.opc-os\dev.db`
（路径默认值出处 `serve/dev-entry.ts:106`，gitignored 一次性演示库）：
`role_charters` **1 行**：`role_id=dev_engineer, version=1, created_by=ceo`，
config 的 acceptanceCriteria 是 `{"condition":"e2e：产出可运行","action":"reject",...}`。
来源可考：`.workbuddy/ui-e2e-walk.mjs:76-92` 走 UI 表单 `POST /charter` 写入
（写入口 `http/charter.ts:195 saveCharterVersion`，装配于 `http/real-deps.ts:864`）。
`serve/dev-seed.ts:11` 明写「刻意不种 role_charters」，所以这行不是 dev-seed 种的。

⇒ **精确口径**：「0 行」对【迁移后的新库 + 播种路径】成立（这是文档 471-472 行的主张本体）；
对【任意被 POST /charter 摸过的本机演示库】不成立 —— 写入口今天已经存在且真的写过一次。
文档「缺的一环是没有人签字」这句话需要补半句：CEO（或 e2e 脚本）绕过模板**直接签一份自定义岗位书**
的路径已经打通并在 dev.db 留了痕。生产位置（`~/.opc-os/`、`OPC_DB`）本机不存在该目录/变量
（`ls ~/.opc-os` 无、`OPC_DB=` 空）—— 生产库有无数据【未复算】（本机无库可查），
但按 (a)(b) 任何只经迁移+播种的库都必然是 0 行。

### 生产里 evaluateGate / 状态机推进的真实调用链（自查结果）

- `evaluateGate` 定义：`graph/gates/evaluate.ts:174`；src 内**唯一**调用形态命中：
  `harness/verifier.ts:640`（grep `evaluateGate(` 全 src 仅此一处真调用，其余全是注释/类型引用；
  其它 packages 只有 contracts 的一条注释 `packages/contracts/src/evidence.ts:103`）。
- 但 `harness/verifier.ts` 文件头横幅（:2）自称「今天一行都不执行：对外零 import」—— 复核成立：
  `grep -rn "harness/" packages/hub/src` 的 import 命中为零（只有注释）。`verifyFix`
  （`verifier.ts:499`）src 内零调用方，被 `phase3.test.ts:815 callersOf("verifyFix")==[]` 钉着。
- **真状态机推进链**上没有 evaluateGate：`engine/work.ts:448` 与 `serve/driver-pump.ts:776`
  → `makeDispatch`（`engine/dispatch.ts:1012`）→ 一轮里只有
  `parseDecision` + `handoffGate`（:277，调用 :1138）+ `reviewGate`（:327，调用 :1163）。
  `dispatch.ts:28` 注释自证：「交接只带一句 summary，没有 bundle ⇒ §8.2 第 2 条（证据包）缺」。
- 岗位书今天的唯一真生产读者是**提示词**那半：`engine/runtime.ts:317 readLatestCharter`
  （O2 动作 1），无行 ⇒ `NO_CHARTER_LINE`，不抛。

---

## ② 「接上」在形状上意味着什么

`evaluateGate` 的 criteria 通道：`GateInput.criteria`（`graph/gates/evaluate.ts:72`）←
`VerifyInput.criteria`（`harness/verifier.ts:404`，必填）← 调用方原样透传
（`verifier.ts:656 criteria: [...input.criteria]`）。要让它来自库，两种接法：

**接法 A（最小字面解）：在某个生产文件里调 `gateCriteriaForRole(db, roleId)` 并把结果喂给
`verifyFix` 的 `criteria`。**
问题：`verifyFix` 本身零生产调用方。新调用点会落在**死模块的入参装配处**——
`charter/store.ts` 模块级已可达（死模块守卫不红），但那条调用在生产里一次也不会被执行。
这正是题目说的「永远走空的装饰性路径」，而且它比一般装饰更坏：`store.test.ts:535-548`
那条 `saveCharterVersion|gateCriteriaForRole` 混合扫描会多出一个文件 ⇒ 红，
逼你改期望值；改完守卫就绿了，而生产行为**一个字节没变**。

**接法 B（有行为的解，即文档 O6 的接线本体）：把 `verifyFix` 接进真推进链，criteria 现场取。**
要动的点（按现状形状，最小集）：
1. `packages/hub/src/engine/dispatch.ts:1012 makeDispatch` / `DispatchDeps`（:950）：
   注入一个 `db` 读口 + 在 `reviewGate` 通过、handoff 之前（:1163 之后、:1223 之前）加一次
   复核调用；当前 handoff 路径无 EvidenceBundle（`dispatch.ts:28`），bundle 的
   `assemble`/`artifacts.sha256` 必须由真产物算出（`verifier.ts` 文件头 §41-45 的立场），
   这是整件事最重的一块，不是改 criteria 一格。
2. criteria 来源改为 `gateCriteriaForRole(read(), reviewerRoleId)`：调用点新增在
   dispatch 或 runtime 注入层；`harness/verifier.ts:404/:656` 可保持透传不动
   （由调用方喂库读结果——verifier 不该 import charter/store，保持分层）。
3. `verifierCharter` 格（`verifier.ts:446`，必填）同源改读 `readLatestCharter`，
   否则 §13.3 第 1 层继续拿调用方手搓的岗位书。
4. 横幅自删机制：`harness/verifier.ts:2` + `test/arch/dead-modules.ts:422`
   基线格 —— 真 import 发生那天方向 B 红、点名、逼删横幅与基线格（这是设计好的，不是事故）。

无论 A/B，都有一个**先决语义坑**：见 ③。

---

## ③ 空库语义（确认，含一个此前没人贴出来的碰撞）

`gateCriteriaForRole` 空库分支（`charter/store.ts:561-573`）：**抛错**，
文案「在 role_charters 里【没有任何版本】…刻意不退回 resources/charter-templates/*.yaml」。
`gateCriteriaForRoleAtVersion` 对缺版同样抛（:583-593）。

碰撞点：真推进链上**绝大多数角色本来就没有岗位书行**——提示词侧的既有语义是
`NO_CHARTER_LINE`「明说 hub 没有你的岗位书、照常跑」(`engine/runtime.ts:317` 三分支②)。
若门控点直接调 `gateCriteriaForRole`，则「无岗位书」从「提示词里说一句」升级为
「整轮在门控处抛、这一轮不跑」——与 runtime.ts:303-316 写的三分支立场**不是同一个口径**，
接的人必须先拍：无行 ⇒ 抛（本轮停）还是无行 ⇒ 退回调用方原 criteria（门控不接岗位书）。
第二个坑：role_id ↔ 组织图节点名错位（`charter/seed.ts:192-233 reachabilityOf` 原文）：
模板存 `dev/test/…`，dev.db 图上节点是 `dev_engineer/qa_engineer/…`（实测图 v12 十节点，
仅 `ceo` 同名）——签了字播了种，`gateCriteriaForRole(db, task.role)` 按图节点名查照样抛。
第三：即使有行，shipped 标准若无 `metric:` 形状，`metricCriteriaEvaluator`
（`evaluate.ts:115-122`）全条 unresolved ⇒ 恒 escalate（`evaluate.ts:353+`）。
dev.db 那一行实测正是这种形状：`"e2e：产出可运行"` 非 metric ⇒ 若接上，该角色每轮 escalate。

---

## ④ 建议与代价

**建议：不接（指单独的接法 A）。接法 B 只能作为 O6 整包的一部分，且带三个先决条件。**

判定理由（每条都有上面的复算锚点）：
1. 现在接 A 造出的正是题目问的东西：新调用点的唯一消费者 `verifyFix` 零生产调用方
   （phase3.test.ts:815 钉），生产上永远走空。它还会**消掉一条真守卫的红**——
   `store.test.ts:548` 从两文件变三文件，改期望值后没人会再问「缺口真的消了吗」
   （这正是 474 行/815 行注释立过规矩要防的动作）。
2. 「接」而不带 O6 = 把装饰接在装饰上；带 O6 才第一次产生行为，而 O6 按设计文档
   （`docs/OPC-OS-功能优化设计.md:862-935`）有自己的硬顺序约束（O6-3 必须先于真员工拿写权限），
   criteria 只是其中一格，不该单飞。
3. 三个先决条件（缺一即恒抛/恒升级）：
   (a) 七份模板的占位串由 CEO 真人替换（否则 seed 恒拒，①(b) 复算）；
   (b) role_id 与图节点名对齐（改图或改模板名，`reachabilityOf` 的两条路）；
   (c) 拍板「无行 ⇒ 抛 / 退 original criteria」的语义，否则与 NO_CHARTER_LINE 打架。

「不接」的代价：O2 的「当场进门控」半句继续不兑现——但这句话**已被文档 476-488 行
如实登记**，且 `store.test.ts:548` + `phase3.test.ts:811-815` 两发守卫持续把它钉在
「今天成立、接上那天会红逼改文档」的状态。不接的边际成本 ≈ 0。

「接」各自会碰红的守卫（逐一）：
- 接法 A：`store.test.ts:548` 红（混合正则含 `gateCriteriaForRole(`），改期望值即绿，行为不变；
  dead-modules **不**红（charter/store.ts 已可达，`test/arch/dead-modules.ts:401-410` 注释自证）。
- 接法 B：`phase3.test.ts:815 callersOf("verifyFix")==[]` 红（设计如此：逼改 blockers 清单）；
  `dead-modules.ts:422` 方向 B 红 → 删基线格、删 `verifier.ts:2` 横幅；
  `harness/verifier.test.ts` 若 criteria 改由库注入需在装配层喂（verifier.test.ts:166-167 已预告
  「生产口径是 criteriaFromCharter(charter)」），fixture 形状本身不必动。
- 任何接法若新造包装文件且没人 import ⇒ dead-modules 新增死模块红。

## 附：本轮与既有文档主张的出入（登记用）
1. 「role_charters 今天 0 行」需限定为「新库/播种路径」；本机 `dev.db` 有 1 行
   （ui-e2e-walk 经 `POST /charter` 写入，2026-11-18）。写入口自 round 某起已是两条
   （seed + HTTP），store.test.ts 的注释自己也承认了这点。
2. `docs/OPC-OS-功能优化设计.md:482` 「非 test、非注释的调用点 0」本轮复算仍为 0，无需改。
