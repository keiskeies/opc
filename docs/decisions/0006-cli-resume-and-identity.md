# 0006　CLI 的恢复语义、幂等契约，以及 `thread_id` 与 `task_id` 的同一性

关联：Task 0.10（`hub run` / `hub status` / `hub resume`）；规格 §23.3、§24 风险 1；
计划 V3、V11；前置 0003（事务作用域）、0005（超步边界与审计）。

## 1. 先给实测，再给结论

探针（`packages/hub/.probe-resume.mts`，跑完即删，未入库）在一条【已经跑到 END】的
thread 上分别试两种"恢复"：

| 输入 | 节点执行增量 | `events`（只读连接） | `committedSteps` | 结果 |
| --- | --- | --- | --- | --- |
| `invoke(null)` | **0** | 14 → 14 | 9 → 10 | 正常返回 |
| `new Command({ resume: null })` | 0 | 14 → 14 | — | **抛错 `Received empty Command input`** |

前置状态：`events=14`、`节点进入=9`、`state.next=[]`、`trail 长度=9`。

两条事实各自决定一条 CLI 规则：

- 已完成的 thread 上 `invoke(null)` **不重放任何节点、一条事件都不多写**；
- 图上【没有中断】时 `Command({ resume: null })` 会**直接抛错**，不是"什么都不做"。

## 2. 这与计划 V11 不矛盾，但必须写清适用边界

计划 V11 的原文结论是「恢复必须走 `new Command({ resume })`；重复 `invoke` = 整图重放」。
它成立的前提是**图停在 `interrupt()` 上** —— 那时 `invoke(null)` 会从被中断的那个超步
重放，实测确实重复写 `TaskStateChanged`（缺陷 A，见 0005 §11 与 D10）。

而 Task 0.8 的最小图【没有 interrupt】（`company.ts` 里已【诚实标注】门控是桩直通，
Phase 1 才落地）。所以在 Phase 0 的图上：

| 图的状态 | 正确的恢复输入 | 用错的后果 |
| --- | --- | --- |
| 停在 interrupt 上（Phase 1 起） | `Command({ resume: value })` | `invoke(null)` = 整图重放 ⇒ 重复事件 + 重复计费 |
| 跑到 END / 崩溃在半路（Phase 0） | `invoke(null)` | `Command({ resume: null })` ⇒ `Received empty Command input` |

**因此 `hub resume` 不能无条件选一种。** 规则（先读 checkpoint 再选，不是 try/catch 兜异常）：

```
const state = await graph.getState(config);
const hasInterrupt = (state.interrupts ?? []).length > 0;
input = hasInterrupt ? new Command({ resume: value }) : null;
```

理由：两种输入的失败模式是【静默的不同】—— 选错一种，要么重复烧钱、要么当场抛错。
把判断写成对 `state.interrupts` 的显式检查，是计划 §10.4 第 4 条「检查 `__interrupt__`，
不要 try/catch」在 CLI 侧的同一条纪律：靠 catch 区分"没有中断"和"别的错误"，会把真正的
故障也一起咽掉。

> 探针里 `state.next=[]` 而 `state.interrupts` 为空，正是这一分支的两个假样本；
> Phase 1 门控落地时必须补一条"停在 interrupt 上时走 Command"的用例（登记为 D10 的一部分）。

## 3. 幂等：V3 那句话在本仓不可判定，改写成可测的契约

计划 340 行的验收写的是「重复运行同一 `thread_id` **不重复计费**（V3）」。这句话在本仓
【不可判定】：Phase 0 一律用桩模型（计划 §10.4 第 7 条），桩不产生任何计费，
"不重复计费"在桩上恒真 —— 拿它当验收会得到一条永远绿的断言。

于是拆成两条本任务【真能测】的契约：

1. **重复 `hub run` 同一 `--task` 当场被拒**（退出码 2）。不是"跑了但没事"，是拒绝执行。
   守卫是【先查库】而不是靠 `INSERT OR IGNORE`：图内 `intake` 节点的 `INSERT OR IGNORE`
   是图自己的容错（崩溃续跑时那一行已经存在，必须忽略），CLI 不能拿它当幂等机制 ——
   否则重复 run 会把一条【已完成】的任务重新推一遍，而 `INSERT OR IGNORE` 一声不响。
2. **`hub resume` 在已完成的 thread 上只推进一个空超步**：`events` 行数不变、节点执行
   次数不变（就是 §1 实测到的 `9→10`、`14→14`）。

计费本身要到 Phase 1 接真实 provider 才可观测，届时补的不是这条断言的加强版，而是
一条【新的】断言（同 thread 二次 run 的 token 计数增量为 0）—— 现在不预先假装有。

## 4. `thread_id` 与 `task_id` 取同一个值（本任务的设计决定）

### 4.1 先把事实摆全 —— 以及本节初稿的一次编造

【撤回】本节初稿曾写「0001 §5.2 与 0003 §6.2 预留了 `thread_id = end:task_id` 命名空间」
和「规格 §6.1 的 `task_threads` 表区分 `thread_id` 与 `task_id`」。**两条都是假的**：
`grep` 过 0001 与 0003 全文，二者提到 `thread_id` 的地方只有索引讨论与空串键校验，没有
任何前缀方案；规格附录 C 的 18 条 `CREATE TABLE` 里【没有】`task_threads` 这张表。
机器核查见本节末。错误本身记在 §7。

核过之后的真实事实只有三条：

1. **规格把检查点挂在任务行上，且是单值列**（附录 C，规格 2103 行起）：
   `tasks` 表有 `graph_checkpoint_id TEXT` 与 `state_snapshot TEXT` 两列 —— 一个任务行
   指向【一个】检查点。规格里没有任何"一个任务持多个 thread"的结构。
2. **"端"的维度不在会话上**（规格 2317 行起）：`im_bindings` 把
   `platform`（`feishu` / `wecom` / `qq`）与 `external_user_id` 绑到 `ceo_role`，
   绑的是【人】，不是任务会话。所以多端隔离在规格里本来也不靠 thread 命名空间实现。
3. **Saver 对 `thread_id` 不做任何解析**（实测：`saver.ts` 里没有 `end:` / `wx:` /
   前缀切分逻辑，`thread_id` 全程当不透明字符串用）。

### 4.2 决定

**Phase 0 取 `thread_id = task_id`：一个值，两个列名。**

依据是事实 1：规格的建模就是一个任务一条图执行。既然规格没给出"一个任务多条会话"的
结构，CLI 就没必要提前发明它。

**为什么不顺手实现前缀**：`thread_id` 是 `checkpoints` 与 `writes` 主键的组成列
（0005 / 0003 里的 DDL 照抄官方）。前缀一旦写进库，改方案不是 ALTER 一张表 —— BLOB
载荷里没有旧前缀可改，得连历史检查点一起迁。而真正会触发分叉的东西在 desktop 包，
它现在只有一个 372 B 的占位文件。为一个还不存在的需求预支一次不可逆的键设计，
是拿将来的迁移自由度换现在的"看起来周到"。

### 4.3 什么时候必须重新决定

出现「同一个业务任务需要两条独立会话」时。判据写清楚，免得将来有人误以为是遗漏：

| 情形 | `thread_id` |
| --- | --- |
| Phase 0（CLI，单端，任务 ↔ 会话 1:1） | = `task_id` |
| 一个任务被多个来源各自跟进 | `<来源>:<task_id>` |
| 一个任务被同一来源开两轮（返工后重开） | `<来源>:<task_id>:<轮次>` —— 轮次必须显式，否则新会话覆盖旧审计 |
**CLI 因此只暴露 `--task`，不暴露 `--thread`**（计划 339–340 行本来也只要求前者）。
少一个参数就少一处漂移：两个自由字符串迟早有人传进一对不匹配的值，于是 `hub status`
查的是甲任务的审计、`hub resume` 续的是乙会话的进度 —— 而且两边都会给出"看起来合理"的输出。

副作用讲明白：这使"同一任务共享一条审计会话"成为【默认】。若将来要多端隔离，那是显式
再加的一层，不是这里顺手能省的。

### 4.4 核查方式（结论可以被推翻，方法要留下）

```text
grep -n "thread_id" docs/decisions/0001-sqlite-driver.md docs/decisions/0003-*.md   # → 只有索引与空串校验
grep -n "task_threads" docs/OPC-OS-设计文档.md                                       # → 无命中
grep -n "end:\|wx:\|owner:" packages/hub/src/checkpoint/saver.ts                     # → 无命中
```
## 5. 桩模型住在 `src/` 之后的护栏

Task 0.10 把桩模型与节点装配从 `test/` 搬进 `src/`（理由见提交 e539816：CLI 与测试
必须共用一份装配，两份必然漂移，§5.9 的档位断言会退化成"测 A 套跑 B 套"）。代价是
生产源码树里出现了一个假的模型实现。两条护栏：

1. 桩【单独成文件】`src/graph/stub-model.ts`，不往真实 registry 里塞 `if (stub)`；
   真实 provider 到 Phase 1 进独立文件，桩文件不参与那条装配路径。
2. CLI 每次装配都打印`模型：桩（Phase 0，不计费不联网）`，并把 `tasks.title` 记成
   想法原文 —— 让人从审计日志就能看出"这一趟用的是桩"，而不是事后猜。

顺带记一笔搬动照出的两个潜伏错误（根因：`tsc -b` 的 solution 不覆盖 `test/`）：
`ChatResult` 被从 `@langchain/core/messages` 导入（实在 `outputs`，`outputs.d.ts:58`），
以及桩返回对象里多一个不属于 `ChatResult` 的 `result: {}` 键。vitest 用 esbuild 只剥
类型、从不解析类型，所以 type-only 的错误 import 在测试里永远不会炸 —— 这就是为什么
"测试全绿"不能当作类型正确的证据。

## 6. 两处由本任务暴露的工程缺陷（都不是 CLI 行为，但会咬到生产）

### 6.1 生产代码 import 了 devDependency

`src/cli.ts` 与 `src/graph/company.ts` 都 import `@langchain/langgraph`，而它当时只在
packages/hub/package.json 的 devDependencies。计划里没有任何一条任务要求检查这件事，
它也不会被现有任何门禁抓到：

· 测试全绿 —— Node 解析模块只看 node_modules 里有没有，不看 package.json 的分组；
  pnpm 平时会把 devDependencies 一并装上，所以开发期与 CI 都察觉不到。
· 真炸的时机是 `pnpm install --prod` 之后：运行时 require 直接找不到模块。

修复是把它移进 dependencies（脱字符 `^1.7.1` 原样保留）。补了一条常驻门禁
`test/arch/production-deps.test.ts`：扫 `packages/*/src/**/*.ts` 的 import 说明符，要求
每个外部包都在 dependencies；并单独禁止 openai / @anthropic-ai/sdk / @langchain/openai /
@langchain/anthropic 出现在任何 dependencies —— 那是计划 §10.4 第 7 条（Phase 0 不许接
真实 provider）从 package.json 这一侧的守门。

两个踩过的坑，都值得记下来，因为它们都会让这类检查变成假绿：

1. **扫描正则必须行首锚定。** 我第一版写 `(?:from\s*|...)`，而 `\s*` 允许零个空格，
   于是 `assertKnown(from, "未知状态…")` 里的标识符 `from` 被当成 import，抓到 `" | "`、
   `");"` 这类假包名。这个仓库真实命中只有 2 条，两条垃圾正好把缺陷埋没。改成行首锚定的
   import/export/dynamic-import 四条正则后，命中恰好收敛到那 2 条真缺陷。
2. **扫描器要自我证明在做事。** 测试里有一条 `expect(seen.size).toBeGreaterThan(3)`：
   真包数远大于 3，而正则一旦失效就会只剩 0 条 —— 那样宁可让测试红，也不要它绿着漏检。

顺带一条工具用法：**在分组之间移动依赖不要用 `pnpm add`。** 我连试两次
`pnpm --filter @opc/hub add @langchain/langgraph@^1.7.1`，两次都同时做错两件事：包仍留在
devDependencies，且把说明符从 `^1.7.1` 静默降级成 `1.7.1`（只有 `git diff pnpm-lock.yaml`
看得见）。改用「手改 JSON + pnpm install」，并对 package.json 与 pnpm-lock.yaml 各看一次
git diff 才算完成。

### 6.2 与计划 Task 0.10 措辞的偏离（需要 CEO 认账）

计划 339 行写的是 `hub run --idea "..."` / `hub status` / `hub resume`，340 行的测试要求
是「重复运行同一 `thread_id` 不重复计费（V3）」。实现与这两句都不一致：

| 计划措辞 | 实现 | 理由 |
|---|---|---|
| 三个子命令都不带 --db / --task | 三者都要 `--db`（或环境变量 `OPC_DB`）与 `--task`；`--thread` 被显式拒绝 | Phase 0 没有配置系统，任何默认库路径都等于把库文件编到 cwd 附近；`thread_id` 由 `task_id` 推导（§4.2） |
| 不重复计费（V3） | 换成两条可测契约：重复 `hub run --task` 退出 2；已完成的 thread 上 `hub resume` 不改 events 行数 | 桩模型不计费，按原文断言会永远绿（§3） |

这是**偏离计划措辞**，不是推翻 §4 的同一性决定：CEO 若不接受，改的是 CLI 参数面
（补一个默认库路径 + 配置来源），`thread_id = task_id` 依然成立。

### 6.3 核查方式（§7 第 1 条的规矩，立刻用在 §4.2 这条新结论上）

§4.2 决定「CLI 只暴露 \`--task\`，\`--thread\` 必须被显式拒绝」。下面三条**都在本机跑过**，
\`→\` 后面是真实输出，不是我对输出的预期：

\`\`\`text
git grep --untracked -n "thread_id:" -- packages/hub/src/cli.ts
  → cli.ts:254  function config(taskId: string): { configurable: { thread_id: string } }
  → cli.ts:255    return { configurable: { thread_id: taskId } };
  两条 = config() 是 thread_id 的唯一拼装点，值就是 taskId。搜 "thread_id:"（带冒号，
  即【作为键出现】）而不是 "thread_id"：后者在 packages/hub/src 下命中 40 多处，绝大多数
  是 saver 与 checkpoint schema 的列名，对这条结论毫无信息量。

git grep --untracked -n -c -e "--thread" -- packages/hub/src/cli.ts
  → cli.ts:5     五处命中，读下来分别是文件头纪律 1 处、USAGE 1 处、拒绝分支 2 处、
                 错误消息 1 处 —— 也就是【只有一个拒绝分支】，没有第二处把 --thread 当成
                 取值选项处理。计数比"读一遍"更适合反复核查。

pnpm hub run --db .tmp/t.db --task T-1 --idea x --thread Z; echo $?
  → 退出码 2；stderr 首行：
      错误：不支持 --thread：thread_id 由 --task 推导（见 docs/decisions/0006 §4）。
    该行同时含 --thread 与 --task（拒绝 + 指路）；.tmp/t.db 不被创建。
    一次验完 §4.2 的三个后果：拒绝执行、指路、不留半个库文件。
\`\`\`

两个坑，都是我这一小节的第一版踩到的 —— 核查命令写错和结论写错一样贵：

· **必须带 \`--untracked\`。** 本任务的新文件（cli.ts 等）此刻还没 commit，而
  \`git grep\` 默认只搜已跟踪内容：不带这个开关时 \`grep -n "thread" .../cli.ts\` 返回
  **空**，核查者会以为"根本没有 --thread 拒绝分支"，把一条成立的结论读成被推翻。
  实测对照：同一 pattern，默认 0 命中，\`--untracked\` 12 命中。

· **别用裸 \`node\` 跑 .ts。** 文档初稿写的是 \`node packages/hub/src/cli.ts ...\`，实测
  \`ERR_MODULE_NOT_FOUND: Cannot find module '.../checkpoint/saver.js'\`、退出码 **1**：
  源码里的 import 带 \`.js\` 后缀（NodeNext 约定），只有 tsx 会解析回 .ts，而 Node 24 默认
  的类型剥离不处理这个映射。走 \`pnpm hub\`（根 package.json 的新脚本，就是 tsx + cli.ts），
  由它负责挑 Node 与加载器。顺带一条环境事实：在 DSH 的执行器里 \`process.execPath\` 是宿主
  \`DSH NEXT.exe\`，不是 Node —— 拿它 spawn 会得到恒 0 的退出码（见 §7 第 5 条）。

## 7. 本任务的失误记录

1. **在决策文档里编造了两处引用**（原文见 §4.1 的【撤回】块）：一处声称 0001/0003
   "预留了 `end:task_id` 命名空间"，一处声称规格 §6.1 有 `task_threads` 表。两者都
   没有对应的原文，是我按"这类系统一般会怎么写"编的。
   **为什么这类错误比死链更贵**：决策文档的作用就是给人省掉重新调查的成本，一条编造的
   引用会把读者引向一个不存在的结论，而且它带着"已经有人查过"的口吻 —— 比空白更危险。
   **规矩**：写引用时同时写下核查命令（见 §4.4），能被别人一键推翻的引用才是可用的引用。
2. **把探针的构造参数凭记忆写了一遍**，而装配的真实写法是
   `auditor.instrumentSaver(new SqliteWALSaver(db))` —— 少了 `instrumentSaver` 这一层，
   超步事务就不滚动（0005 §16 的第 1 类静默陷阱），探针会"成功"给出错误结论。
   **教训**：任何测量代码都必须照抄已验证过的装配路径，而不是重写一遍。

3. **变异 M6 上一轮是【侥幸】被杀的，我却把它记成"断言有效"。** 当时我往库里插的污染
   事件 payload 是非法 JSON，cmdStatus 在 JSON.parse 处崩掉、退出码变 1，测试因此变红
   —— 红在崩溃上，不是红在断言上。把 payload 换成合法 JSON，同一个变异就活了：那一行被
   渲染成 ? -> ?，行数与形状和真跃迁一模一样，edges.length === 14 照样通过。
   **判据要从"行数"挪到"语义"**：现在要求轨迹里每一对 from→to 都是 §7.1 的合法跃迁
   （isTaskTransitionLegal 对未知状态名【抛错】而不是返回 false，所以污染行会当场炸）。
   **规矩**：一个变异被杀之后，要能说出【是哪条断言、因为什么】杀的；说不出来就换一个
   更刁的变异重测。"测试变红"不是"断言有判别力"的证据。

4. **把变异 M7 误判成"等价变异"，而且两次都判错。** 第一次我援引验收标准 V13
   （"断言退出码而不是日志文本"）论证：删掉显式拒绝后仍然退出 2、仍然指名 --thread，
   契约相同，所以不必加断言。这个论证有两处错：
   · **它把决策本身变成了不可测的东西。**"显式拒绝并说明原因"正是 §4.2 的决定内容；
     如果承认它在消息层面不可断言，§4.2 就成了一条没有任何测试保护的决策。V13 反对的是
     【拿日志文本判断门禁有没有生效】（门禁看退出码），不是要求把用户可见的指引降格成
     自由文本。
   · **它的"实验"根本没生效。** 我把变异插在兜底分支之前的一行 continue，而真正的显式
     拒绝在它上游 40 行处先命中 —— 那段变异是死代码，既没被跳过也没被执行，我因此连
     "它真的等价"都不曾验证过。
   然后我第一次补的断言（三条 toContain）**又被 USAGE 段兜住了**：CLI 打印 parse 错误时
   会连着用法一起打（cli.ts:468），而用法里本来就有"没有 --thread：thread_id 由 --task
   推导（docs/decisions/0006 §4）"这样一行 —— 三条断言全部由这段公共文本满足，M7 于是在
   19 条测试下继续存活。
   **真正的修法**：判据落在【错误本体那一行】（首行；用法是空行之后的第二段），要求它
   同时指名被拒的选项和替代方案；再加一条完全不依赖文案的硬判据 —— **被拒时不得留下
   库文件**，这一条同时杀掉"删掉拒绝"和更危险的"静默忽略"（后者会让命令跑完、退出 0，
   使用者以为自己把审计与会话分开了，实际两边都是 task_id）。拆成三个变异后全部被杀。
   **教训**：断言要挑【公共兜底文本覆盖不到】的位置，否则它测的是用法说明书写得好不好。

5. **两次把被污染的证据当成证据。** 为了验证 §4.2 的行为差异，我用 process.execPath
   spawn 子进程跑 CLI。在 DSH 的 run_code 里 process.execPath 是**宿主 Electron**，不是
   Node：两次运行都退出 0、stderr 全是 GPU Cache Creation failed 之类的宿主噪声，而真正的
   CLI 从未执行。如果我就此下结论，就会得出"--thread 两种实现行为相同"—— 恰好替 M7 的
   存活编出一个"等价"的理由。
   **规矩**：spawn 前先确认子进程是 Node（测试里走 vitest 的真子进程，不受影响）；看到
   WSALookupServiceBegin / Gpu Cache 这类噪声就说明测量无效，重做而不是解释。
