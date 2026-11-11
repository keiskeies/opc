# 0040　组织变更的保存按钮：一个「零生产调用方」关了快二十篇的入口（POST /org）

- **状态**：按授权代拍。这一篇写的是我就靠当前委托权限定下来的那条产品编排放进 `docs/`：
  **组织变更的生产入口长什么样、为什么只开回环、备份摆在哪**。三处都属「产品设计的出发角度 /
  设计逻辑 / 用户体验」这一档，不是 CEO 专属的不可逆账目决定。
- **产出**：`packages/contracts` `POST /org` 端点 + `commitOrgChangeRequestSchema` +
  `http/org.ts`（回环门 + handler + **`GET /org` 配套读侧**）+ `http/real-deps.ts` 的
  `makeCommitOrgChange`（备份在前、失败即拒）+ `makeReadOrgGraph`（读当前生效图）+
  `serve/assemble.ts` 用 `--backup-dir` 装这条链 + `http/org-route.test.ts` 新测试。
- **一句话结论**：⭐ **`commitOrgGraph` 在生产里整整关了二十篇的零调用方，本篇把那个洞补上**
  —— 而补的方式是由**三条能互相打红**的判据钉住的：`POST /org` 只开回环（self-escalating
  CEO 写）· actor 只从装配来 · **备份在提交之前、失败就拒绝提交**（【规格】§6.5 那两件事的落地形态）。

---

## 0. 这一篇在补什么：0012 §7 欠的那个真入口

0012 §7 原话写过：「commitOrgGraph **没有任何生产调用方** —— 需要 contracts endpoint +
ApiEndpoint union 值 + app.ts route 分支」。0011 到 0039 二十篇里，组织图**验证层**
（三关）与**提交层**（版本化事务）全部写完、各自有测试，而它们从没有一条运行时路径能走到
—— 那个「保存按钮」一直悬着。本仓反复抓「零生产调用方」这一族（0013/0014/#7/#8、0020、
0031、0032、0033 各记一次），这一次轮到组织图。

所以这一篇的验收不是「写了新功能」，是**把已经写完的东西接上一个真入口**，而且这个入口要
钉住三件事——回环、actor 来源、备份时机——因为它们才是这条入口**会出错会损失**的地方。

## 1. 第一个拍板：为什么不叫别的 / 为什么是 POST /org

端点名 `POST /org`。候选里有 `POST /org/commit`、`PUT /org`、`POST /graph` 几个：

- `POST /org/commit` 读着像「对一个叫 org 的资源做 commit」，而这里没有「先 GET 一个 org
  再 COMMIT 它」的既有资源模型—— `delegation_graphs` 是**版本序列**不是单资源；
- `PUT /org` 读着像「整体替换组织」，而这里提交的是一张 before 图 + **一条 change**，
  「替换」承诺了幂等，而一次 reparent 不是 PUT 的语义；
- 就只有 `POST /org` 干净：**一次变更的提交**，非幂等，符合 POST 的合同。

关键在**只有一段**。`matchRoute` 里我故意不写 `POST /org/:anything`：这条路由没有 id 段，
拼错一个字母（`/org/x`）应当 404 而不是把 x 当 section 名带下去（0031 §0 那条绑定路由的
同一判据；Route 类型旁那段写了为什么）。

## 2. 第二个拍板（最关键）：只开回环，跟 bindings 同一条线

组织变更是 **self-escalating 的 CEO 权限写**。[规格] §4.2.3 把组织权集中给 CEO——改汇报关系、
加委派边 = 改 【规格】§8.2「哪些门控绑在边上」= 改谁能批、批什么、升级路径能到哪。一次「把 A 汇报给 B」
可以被包装成许多墨黑的效果（改谁的上级、让某条审批永远够不到 CEO、让某条升级可达性失效）。

这一手比 bindings 里对应那条还重一档：0030 §9 原话「远程能自校验 = 任何人可以自己给自己发一个
CEO 身份」，那只是**一个账号自称谁**；这里远程可提交组织变更 = **直接改组织本身**。所以它
**只认回环对端**（isLoopbackAddress）+ HMAC —— 本机桌面端/CLI 拿得到密钥，远程（走一次性
token 通道的那条）打不进来。

⚠ 这条口子我宁可写死在 handler 里（每请求判一次），而不是只靠在 route() 那一道门：
route() 的第一道门（remoteTokenAuth 白名单只有 decide）今天确实挡着 org，但那道门改起来
很自然（「读收件箱要开远程端口时顺手把 org 也开进去」），而**那道门的放宽不该静默放过这条
self-escalating 写**。两道门各自独立成立，同 mintToken 的论证。

## 3. 第三个拍板：actor 只从装配来，永远不进请求体

`commitOrgChangeRequestSchema` 是 `.strict()`，里面**没有 actor 键**。（第二个拍板同款）——
actor 一旦进请求体，任何人 POST 一个 `{actor:{type:"human",id:"ceo"}}` 就是一次 CEO 动作，
而组织变更的审计（append-only，`events`）会记下一条「ceo 改的」。这条与
bindingVerifyRequestSchema 刻意没有 `verified_by` 是**同一个形状同一个理由**：
让签发者/动作来自请求体 = 把「谁干的」交给调用方自报，而 append-only 的审计是删不掉的。

所以 actor 由 real-deps 的 `ORG_COMMIT_ACTOR`（`{type:"human", id:CEO_ROLE_ID}`）在装配时
写死。能在 POST /org 到这一步的只有本机回环（backup 装配决定它接不接），而本机持有者是这台
机器的运营者 —— 这个来源比「请求里传什么」可信一档。

## 4. 第四个拍板（本篇真正的方法论产出）：备份摆在哪、失败怎么办

[规格] §6.5 是两件事：**每日备份** + **每次改组织都留一份能回到起点的快照**。后一件的落地
形态我把它定成 **「变更前先备份，备份成功才提交，备份失败就拒绝提交」**。

为什么是「先备成功才提交」而不是「先提交再备」或「备失败也照提」：

- **先提后备**：改图成功、备份失败 ⇒ 那次改图没有恢复点，手滑一次就永久无路可退（【规格】§6.5
  要防的正是这个）。半提交的样子 = **「图 v7 已写，而改图之前没有能回 v6 的快照」**。
- **备失败也照提**：等于没有 【规格】§6.5 的第二句「要留一份能回到起点的快照」——备份成了「最好有
  但不是必须有」的装饰，而本仓反复确认过「备份静默/可跳过 = 没有备份」（0018/0026/0036）。

所以 `makeCommitOrgChange` 的顺序是：**备份（VACUUM INTO）在前 → 备份不 `ran` 或 `!ok`
⇒ 返回 `{ok:false, code:"backup_failed"}`，不给新版本号 → 备份成功才落 commitOrgGraph 事务**。
备份失败时把 worker 的原文透传到响应里（`disk full` 之类），195 说「死人道歉」的场景（备份
文件没生成）当场点名，不浪费一次排查。

**那条「备份在事务前」是 can't-be-skipped 的**：它住在装配里（`makeCommitOrgChange`），不在
handler 里，也不在 commitOrgGraph 里 —— 于是「忘了备份」不可能是一行被顺手删掉的代码，它
是路由能用的**前提**。

## 5. 谁能碰到这条：三个 1xx 谁负责说

| 情况 | 码 | 谁判 | 为什么是这个而不是别的 |
| --- | --- | --- | --- |
| 非回环对端 | 401 | `assertLoopbackOrgRoute` | 未被授权的形状与凭据错逐字相同（不带 reason），不给远程探测到「这里有一道回环门」 |
| 装配没接 `commitOrgChange` | 501 | handler | 「路由在、契约里有，是这个装配没把备份+提交连起来（没配 --backup-dir）」。501 说得清修法（装配），不是 404「路由不存在」也不是 401「你没凭据」 |
| 请求体非法 | 422 | handler | 三键各守一条（见 schema 注释） |
| 备份失败 | 422 + `code:"backup_failed"` | makeCommitOrgChange 返回 | 提交被本可避免的状态挡下，reason 透传 |
| 校验（L1/L2/L3）不过 | 422 + code | commitOrgGraph 返回 | Hub 侧重跑、不复信前端 |

401 的第一道门（route() 的 remoteTokenAuth）与 `assertLoopbackOrgRoute` 互相独立成立（§2）。

## 6. 判据

- `matchRoute("POST","/org")` = `{kind:"commit_org", endpoint:"POST /org"}`；GET/DELETE、
  `/org/anything`、`/org/` 全是 null ⇒ 404。
- 回环门：非回环对端 `assertLoopbackOrgRoute` 返回 `{status:401, body:{error:"unauthorized"}}`；
  回环对端 null。
- actor：请求体带 `actor` 键 ⇒ `.strict()` 422；装配的 `ORG_COMMIT_ACTOR` = `{human, ceo}` 写进
  审计（validateOrgChange 收它）。
- **备份编排（三条能互红的）**：
  ① 成功路径：备份调一次、库里出现 v1、change_summary 正确；
  ② 备份失败：备份调一次、库里**没有** v1、`code:"backup_failed"`、reason 透传；
  ③ 校验不过（制造自环）：备份照跑一次（【规格】§6.5：改了组织就要有快照，哪怕这次没改成），
     库里没有 v1。
- 未装配（wired:false）⇒ 501，消息含 `--backup-dir`。

## 7. 与「更严」的距离

1. **没有把「备份产品自检」与「提交」放在同一事务里**。备份是 worker 单独产文件，commitOrgGraph
   是写连接上一笔事务；两者之间没有原子性 —— 「备份成功 + 提交成功」不是同一个 commit。
   但这不是缺陷：【规格】§6.5 要的快照是「改图**之前**能回起点」，快照落盘与改图不必同一时刻，中间隔
   的是「一个人手滑到改图」那一整段需要被保护的窗口 —— 快照已经落下了。
2. **`makeCommitOrgChange` 的 running tasks 查询在只读连接上、事务外**。它决定的是
   `needsConfirmation`（有运行中任务时那句「要 CEO 再确认」），差一条正在 superstep 中间的
   任务，最坏是多/少一次确认提示，不是权限或审计错。
3. **「改组织广播回看板」这一格已经按 0012 §9 的正确形态关闭，不是欠着**。0012 §9 记过
   组织变更不广播、消费掉的 seq 留空洞那件事，并【明确判定】：空洞已被检出（`action="gap"`/
   `link="stale"`）、处置本来就是重拉快照，所以正确做法是**补读端点**而不是给 commitOrgGraph
   接 publish（接 publish 会把「空转」换成「看得见拿不到」，只多一次无效重拉）。本篇补的就是
   读端点：`GET /org` 让「stale → 重拉快照」这一格【终于有内容】。广播本身依旧不接 —— 那是
   0012 §9 判定【不该做】的方向。
4. **桌面 IPC 侧没接**（`desktop/ipc-surface.ts` 的 `EXPOSED_ENDPOINTS = IMPLEMENTED_ENDPOINTS`
   是恒等式，所以 `POST /org` / `GET /org` 自动落进渲染进程可达面，但今天 `channelFor("commit_org")`
   仍返回 null —— 同 0027 §8 / 0031 那格的形状，桌面那条通道是跳过的判据不是漏做的）。

## 6.5 本篇还补的读侧：GET /org（0040 的配套读）

0012 §9 记着「检出之后拿不回组织图 —— 没有任何读端点」。POST /org 立了写约，本函数补上配套的读：

- `GET /org` 返回**当前生效**那份图（delegation_graphs 的 MAX(version)）+ 版本元数据 —— 把
  「保存按钮的成果显示出来」这一格补上：客户端判定「我落后了」时，重拉到的快照里终于有图。
- 【不是】回环专用：读不回写、不是 self-escalating 的 CEO 写，走与 GET /tasks / GET /approvals /
  GET /bindings 相同的统鉴权（回环 HMAC；远程 401 —— §20.3 只授权「审批」出本机）。分岔落在
  route() 那道门，handler 里不重复判回环（读不变更任何东西）。
- 空存（从没提交过）⇒ `{ graph: {nodes:{}, edges:[]}, graph_version: 0 }`：是「还没有这个资源」
  不是 404/500（同 GET /tasks 空列表回 [] 的口径）。
- 只做「当前生效」这一份；`?version=` 回放读推迟（readGraphByVersion 在版本缺失时抛错，§18.4 那行
  注释），那些属另一族消费方，不在本篇射程。

## 8. 别当成做到了

⚠ **这一篇证明「保存按钮的入口能跑」+「保存之后读侧能拿回那张图」**，不证明「组织图真的被桌面端/CLI
用起来」：`commitOrgGraph` 有了能打的 HTTP 入口，`GET /org` 有了配套读侧，而调用它们的**那条 UI/CLI 通道**
（拖拽落下的那一刻真的 POST /org、看板真的去 GET /org 显示）**今天仍没有**。α 档结论是「生产路径已备好」
+「已接线（有一处）」两条并排钉（同 0026 §7 那两处守卫），本篇钉了后者，前者照旧欠着 —— 桶身那个「保存」
按钮在哪。`pnpm verify` 仍跑不起来；下面那些绿是 harness 绿，不是门禁绿。

## 9. 实跑

- `http/org-route.test.ts` 新增 **13 发**（describe 分 ① 路由形状 2 · ② 回环门 1 · ③ 请求体严格 2 · ④ 装配与备份编排 4 · ⑤ GET /org 读侧 4）。
- `tsc -b --force` 回到 **34 = 基线**：本篇新增那三条（real-deps.ts 的 exactOptionalPropertyTypes 返回型、`BackupResult` union 的 `message` 收窄、`readConnection().prepare().all()` 的非法 cast）都消掉了，剩下的 34 都是 pre-existing 的 @langchain/yaml 离线 module-not-found 集合——提交里那一格不再是「34 = 基线」而是「进 3 出 3，回到 34」。
- `check-gate.mjs`「判不了或不符的项：**0 无**」。0040 入口里轮次相对指称 0 处。

## 10. 终跑口径

全量终跑 **1745 / 1697 / 40**（+ `cancelled 8` 恒等；基线 1712 / 1667 / 37 ⇒ **+33 / +30 / +3**）。红名单去重行 **60 行**（与基线 60 行**同数**），但⚠ 因为是后台开着跑的，那 60 行与基线那 60 行**不是逐字节相同**，差了 6 行：

- **6 行从基线换出去**（本轮绿了）：A/B/C/D 四个 CLI 子进程测 + `hub status` + `参数契约（退出码即契约，V13）」—— 全是**起真子进程**的 CLI 测，加载/时序敏感；
- **6 行换进来**（本轮红、且都不在基线）：`perf-thresholds.test.ts` 的 ①事件写入必须走批量事务 / ②心跳调度不得阻塞 / ④回放搜索期间提交不被阻塞 / 10 万行批量 vs 逐条 / 并发搜索期间写仍毫秒级落地 / 巡检并发时写仍在提交 —— **全是在断言墙钟延迟**（`< 500ms` / `< 2065ms` 那类阈值），后台满载跑时被时序饿死。

证据这 6 行是 load-flake 不是回归：`perf-thresholds.test.ts` **单独跑 8/8 全绿**（前台、无并发负载），且**没有任何一条红指向本篇代码**（`org-route` 不在红名单里；doc/arch 那 63 发守卫全绿）。⇒ 本篇**零新增真红**，红名单的抖动全部来自「跑全量时机器同时在忙」这个测试环境侧，不是行为回归。基线那 60 行红的内容（checkpoint / CLI 桩 / SQLite 依赖边界等）一字未动，逐字节核对过 `comm`：本轮 60 去重行去掉那 6 行 load-flake，其余 54 行与基线 `comm -12` 为空（即没有既有的红变成不红也没有新的红混进来）。

`pnpm verify` 仍跑不起来 ⇒ 上面那些绿是 node:test + 自制 harness 给的，**不是门禁绿**。

> **0040 之后的同篇迭代（GET /org 读侧 + 桌面 IPC 读通道）**：`org-route.test.ts` 从 9 发扩到 **13 发**
> （新增 ⑤ 读侧 4 发）；`desktop/ipc-surface.test.ts` 从 28 扩到 **31 发** + 一条把「组织写无通道、读有通道」
> 分开钉住的新断言。终跑 **1767 / 1721 / 38**；红名单对比只在去处重后出现一个「新」红 ——
> `graph/fixtures/e2e-crash-child.ts`（child-process fixture 自身 import saver.ts），隔离跑证实是
> `@langchain/langgraph-checkpoint` 离线缺失，与基线的 e2e-linear/step-tx/interrupt-resume 同一族，
> **不是本篇代码**；另外 6 行基线红（A/B/C/D + hub status + 参数契约）本轮转绿，是已知 CLI 时序 flake。
> tsc 仍 **34 = 基线**。desktop 侧：`channelFor("GET /org")` = `hub:getOrg`（读有通道），
> `channelFor("POST /org")` = null（self-escaping CEO 写刻意不进渲染进程，同 bindings 那组理由）。
