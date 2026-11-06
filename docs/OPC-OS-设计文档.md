# OPC-OS 产品设计文档

**状态**：设计定稿，待 CEO 拍板 §25 的 9 项 ｜ **设计核对日期**：2026-11-06
**日期**：2026年11月
**状态**：设计定稿，待开发
**定位**：一人公司操作系统 —— 以科层制委派与审阅门控为原生工作流的个人 AI 公司控制台
**核心用户**：产品经理型 CEO（唯一人类决策者）

---

## 文档说明

本文件描述 **OPC-OS 的当前完整设计**，自洽成篇：正文所述即为结论，不含历史版本对照，也不含"某设计由某版修订而来"的叙述。需要回溯决策来源时，见同目录下的 **`附录A-对话溯源.md`**（28 条消息逐字转录 + 轮次索引）与 **`_source-deepseek-share-raw.json`**（原始接口数据，含思考片段与联网搜索记录）。

**术语约定**：正文中的 **v1.0 / v1.1 / Phase 0–6** 一律指**产品的交付分期**（要发布什么、先做什么），本文件不存在任何「文档版本」概念，也不含旧方案对照或演进叙述。

**读法提示**：文中凡出现被否掉的方案（独立数据库服务、消息中间件、对象存储、非 TS 运行时、其他 Agent 框架……），都只以「为什么不采用」的形式出现在选型论证里。它们是**已被排除的选项，不是待实现的遗留物**，也不存在「另一份文档描述它们」这种情况。

**依赖与事实的核对日期**：2026-11-06（npm registry、Node 24.21.0 内置 `node:sqlite` 实测）。标注为「推断」或「未验证」的条目，在开工前必须自行复核。

---

## 目录

| 章 | 标题 |
|---|---|
| 1 | 产品定位与核心原则 |
| 2 | 竞品研究与差异化取舍 |
| 3 | 组织架构设计 |
| 4 | 自由度与权力层级 |
| 5 | 技术架构与选型 |
| 6 | 数据模型（SQLite） |
| 7 | 任务流转状态机 |
| 8 | 审阅门控与证据包 |
| 9 | 审批层与策略引擎 |
| 10 | 会议机制 |
| 11 | IM 接入层 |
| 12 | 程序员与测试 Agent（Coding Harness Gateway） |
| 13 | 产品经理与技术总监 Agent |
| 14 | Skills 集成层（角色蒸馏） |
| 15 | 运营岗位子组织 |
| 16 | 前端设计（桌面端）与 CEO 操作模型 |
| 17 | 前端设计（移动端） |
| 18 | 组织层级可视化与拖拽编辑 |
| 19 | 风格设计规范 |
| 20 | 安全与权限 |
| 21 | 成本与预算治理 |
| 22 | 审计与回放 |
| 23 | 开发计划与里程碑 |
| 24 | 结构性风险与缓解策略 |
| 25 | 待 CEO 拍板的设计取舍清单 |
| 附录 B | 关键配置示例 |
| 附录 C | SQLite 建表脚本 · 驱动实测 · 中文检索实测 |
| 附录 D | 术语表 |

---

# 1. 产品定位与核心原则

## 1.1 一句话定位

一个**自托管**的、以“**委派 — 审阅 — 上报**”为原生工作流的个人 AI 公司控制台。CEO 只负责产生想法和战略拍板，组织内的一切拆解、执行、审阅、过滤由 AI 层级完成。

定位的关键分界线：**不做“AI 群聊”，做“AI 科层制”**。你不是在和一群 agent 聊天，你是在**经营一个组织**。

## 1.2 产品形态

- **桌面端（Electron 45 壳）**：主力工作台。UI 只是壳，**编排与执行在独立常驻的 `opc-hub` Node 进程内**（见 §5.1、§5.3），因此关闭 UI 窗口不影响 agent 继续跑。
- **移动端（iOS / Android，Capacitor 壳承载同一套 React 组件，或直接 PWA）**：**审批与例外处理**的轻量终端，不追求功能对等；经 HTTP/WS 访问 Hub，本地不落库（§5.7）。
- **IM（飞书为主）**：第二前端 —— 通知通道 + 审批终端 + 会议旁听席。
- 三端共享同一套前端组件与同一套编排后端；数据主库在桌面端本地（见 §5、§6）。

## 1.3 四条核心设计原则

**原则一：CEO 的默认状态是“不被打扰”。**
任何功能设计的首要判断标准：这个设计让 CEO 多按一次按钮，还是少按一次按钮？策略引擎能自动决定的可逆事项，不进入 CEO 收件箱。

**原则二：审阅必须有实质制衡。**
每一层级产出向上移动前，必须经过独立审阅者的显式验证。**产出者不能给自己打分**。助理不能“相信”总监的报告，助理必须看到总监附带的验证证据（测试通过率、代码 diff 摘要、PRD 与需求的逐条对照）。

**原则三：一切可审计、可回放。**
每一次状态变更、审阅决定、审批操作、工具调用、预算消耗写入 append-only 事件日志，支持任意任务的时间线回放。

**原则四：移动端只做“拍板”，不做“管理”。**
手机界面只承载审批卡片流、想法快速输入、只读状态三件事。不加载看板与组织配置的复杂组件。

## 1.4 成败判据（非技术判据）

OPC-OS 的成败不取决于选了什么模型，而取决于能否在 Phase 0 / Phase 1 把三件事定义清楚：

1. **什么叫做完了**（每个角色的完成定义）
2. **什么叫做合格**（每个角色的验收标准）
3. **什么情况下才应该来找 CEO**（升级触发条件）

定义清楚了，剩下的编码是工程问题；定义不清楚，再多的 agent 也只会把 CEO 的认知负担从“做事”转移到“读报告”。

---

# 2. 竞品研究与差异化取舍

## 2.1 市场全景判断

该品类在 2026 年初爆发，年中显著收敛。行业研究结论：**“两个月后，这个品类已经整合为一个赢家市场”** —— Paperclip 增长约 60% 至 70k stars 并注册为 Paperclip Labs, Inc.，名单下半部分的项目大多陷入沉寂；2026 年 10 月 GitHub 星数约 95.4k，月增约 +14.6k，是该品类中唯一同时具备**持续动量、公司实体、已交付治理功能**的项目。

品类的真正分界线：你买的是**一套“公司 OS”**（组织架构、预算、治理、审计）、**一个“流程框架”**（角色、任务、交接）、还是**一个“单点工具”**（只解决审批环节）。

## 2.2 分层与定位速览

| 层级 | 工具 | 一句话定位 | 成熟度信号 |
|---|---|---|---|
| 公司 OS（治理层） | **Paperclip** | 自托管 AI 公司控制平面：组织架构图、预算硬停、审计日志、心跳调度 | ~95k stars，Paperclip Labs Inc.，MIT，唯一被视为“生产就绪” |
| 公司 OS（组织仿真层） | **AgentCompany（Ai-Company）** | 完整模拟公司组织架构：高管层 + 产品/技术/测试/运营/市场/支持部，含会议系统 | 组织完整度在开源项目中突出，但社区信号薄弱 |
| 公司 OS（浏览器仿真层） | **OneManCompany** | 浏览器中的像素风 AI 办公室，含 HR 招聘/解雇、绩效评估、Talent Market | ~376–415 stars，叙事完整但社区极年轻 |
| 模板化公司生成器 | **Agent Company AI** | 一条命令拉起预设团队，内置 Stripe/Gumroad 收款 | 偏“轻公司 + 变现” |
| 层级审阅框架 | **agents-inc** | “你 — CoS — Lead — Worker”的科层式委派，作者绝不给自己打分 | 健康指数 54/100，**pre-MVP 实验性**，治理路径默认关闭 |
| 审批单点工具 | **Railse OPC** | 策略引擎自动审批 AI 编程 agent 的工具调用，定不了的推到手机收件箱 | 高度聚焦，Apache 2.0 |
| 底层框架 | **CrewAI** | 角色化 Crews + 可控 Flows，**不是公司 OS** | 55.6k stars |
| 底层框架 | **MetaGPT** | 一行 prompt 模拟软件公司 SOP（PM→架构→工程→QA），**不是公司 OS** | 47k stars，MIT，每任务约 $0.18 |

## 2.3 关键教训摘录

- **Paperclip**：治理层最强（预算硬停、审批队列、不可变审计日志、心跳），但它是**框架不是成品** —— 配置组织架构与 agent 职责是“数天到数周”的工作；且明确排除代码审查能力（“自带你的审查流程”）。成本预期：$5–20 试玩，$20–100/月一个活跃公司；单个中等活跃 worker agent 约 $3–15/月。
- **AgentCompany**：角色链条与本项目设想几乎一一对应，会议系统（需求评审会、技术方案会）本质就是审阅节点；但缺乏持续交付与社区验证，**适合当参考实现，不适合当生产依赖**。
- **OneManCompany**：把“质量门禁”明确设计在**每一级委派**上 —— 工作经审阅、迭代、质量检查点，最后通知 CEO 审批最终交付物；社区规模太小。
- **Railse OPC**：**“用一周后八成以上审批由规则自动决定”** —— 这是本项目审批收件箱的北极星指标；其第一版甚至明确把飞书/Telegram 渠道列为非目标，只做 Web PWA + Web Push（保守起点值得参考）。
- **WorkBuddy 的一人公司实践**：早期岗位书写得像简历（“你是一名资深设计师……”），产出华丽但不合规；真正有效的是把行业验收标准**焊死**在岗位书里（色值表、行数上限、12 条验收清单）。

## 2.4 OPC-OS 的取舍矩阵

| 竞品 | 吸收 | 避开 |
|---|---|---|
| Paperclip | 预算硬停、不可变审计日志、心跳调度、审批队列 | 数天到数周的配置曲线 |
| agents-inc | “作者绝不给自己打分”的层级审阅哲学 | pre-MVP 的工程成熟度 |
| Railse OPC | 策略引擎先过规则、例外才推到手机 | 只解决审批单点、不提供组织语义 |
| AgentCompany | 完整组织架构与会议系统的叙事 | 社区信号薄弱，不能作为唯一依赖 |
| CrewAI / MetaGPT | 角色化任务流转的直观性 | 缺乏持久化、预算、审计等公司级基础设施 |

**取舍结论**：以 **LangGraph 的有向图状态机** 作为编排内核（解决持久化与断点恢复），以 **“审阅门控”作为一等公民**（每次层级交接必须经过显式的通过 / 打回 / 升级），以 **“例外审批”而非“全量审批”** 作为 CEO 与系统之间的默认接口。CEO 不审批一切，只审批规则引擎无法决定的事项。

---

# 3. 组织架构设计

## 3.1 默认层级

```
CEO（你）
  └── 助理 / CoS
        ├── 产品总监
        │     └── 产品经理（可多个，挂载不同认知 skill）
        ├── 技术总监
        │     ├── 架构师
        │     ├── 开发工程师（Harness: Claude Code / Codex / Qoder）
        │     └── 测试工程师（Harness: 独立实例，对抗性审查）
        └── 运营总监
              ├── 内容策略 Agent
              ├── 内容创作与平台适配 Agent
              ├── 合规与质量审阅 Agent
              └── 数据复盘 Agent
```

层级**可配置**：可增加“增长负责人”，也可合并“产品总监与运营”。组织架构的修改权只属于 CEO（见 §4.2.3、§18）。

## 3.2 岗位书（Role Charter）：角色定义不是自由文本

每个角色的核心不是“简介”，而是**岗位书**：验收标准、禁止事项、决策空间、工具权限边界、升级触发条件。岗位书是结构化 YAML/JSON，创建角色时加载，运行时作为该 agent 的**系统级约束**注入。

结构骨架（完整示例见附录 B.1）：

```yaml
role_id: test_engineer
display_name: 测试工程师
reports_to: tech_director
acceptance_criteria:
  - condition: "coverage < 0.90"
    action: "reject"
    message: "覆盖率不足90%，不得标记通过"
  - condition: "p0_defect_count > 0"
    action: "escalate"
    target: tech_director
    message: "P0缺陷必须升级，不经过开发自我判定"
forbidden_actions: ["approve_own_work", "modify_source_code", "merge_to_main"]
tool_permissions: ["read_repo", "run_tests", "create_review_report"]
model_tier: execution          # 执行层模型
budget: { daily_usd: 15, per_task_usd: 5 }
escalation_triggers:
  - "review_conflict_rounds >= 3"
  - "irreversible_action_detected"
  - "budget_threshold_reached"
```

**版本化规则**：岗位书可在组织配置页编辑，变更后**仅对新任务生效**；正在运行的任务保持其创建时的版本（`role_charters.version`，见 §6）。

## 3.3 委派规则图

委派规则是一张有向图，与 LangGraph 的图结构一一对应。每条边定义：

| 字段 | 含义 |
|---|---|
| `handoff_artifact` | 交接物类型（PRD、技术方案、代码 diff、测试报告、内容包） |
| `review_gate` | 审阅门控配置（审阅者角色、通过条件、打回条件、升级条件、最大轮次） |
| `veto_power` | 否决权配置（能否否决、否决必须附的依据、最大否决次数、超限升级目标） |
| `parallel_allowed` | 是否允许并行分支 |

**冷启动约定**：Phase 0 的验收只要求**线性 + 单分支**跑通；并行分支与动态边在 Phase 3 之后按实际“绕行需求”逐步加入，避免过度设计。

---

# 4. 自由度与权力层级

这是 OPC-OS 设计的核心张力：**自由度太大，Agent 会越界、会幻觉、会绕过审阅；层级太死，Agent 会变成只会说“是”的执行机器，失去判断力**。系统要的不是“完全自由”或“绝对服从”，而是**受约束的自主** —— 每个角色在明确的决策空间内可以自由判断，但一旦越界或触及不可逆事项，层级门控必须生效。

## 4.1 自由度的四个维度及工程保证

### 4.1.1 决策空间（Decision Scope）

**定义**：这个角色在什么范围内可以自主做决定，不需要向上请示。

```yaml
role_id: tech_director
decision_scope:
  autonomous:
    - "技术栈选型（在已批准的技术雷达范围内）"
    - "工程任务拆解粒度"
    - "开发资源在任务间的分配（在角色预算内）"
    - "技术风险等级判定（P0/P1/P2）"
  requires_consultation:
    - "引入新技术雷达外的依赖" → consult: architect
    - "跨季度架构变更" → consult: ceo
  forbidden:
    - "修改产品需求优先级"
    - "直接操作生产环境"
    - "绕过测试门控标记任务完成"
```

- `autonomous` 内的决定**不需要请示**，直接执行并记录审计事件。
- `requires_consultation` 内的决定必须发起咨询事件，等待指定角色回应后才能继续。
- `forbidden` 内的动作由 **Gateway 在执行前硬拦截**，不靠 Agent“自觉”。

**核心设计**：`autonomous` 是**正向授权（白名单）**，不是“除了禁止的都能做”。白名单之外的一切默认需要请示或禁止 —— 这防止了 Agent 钻空子。

### 4.1.2 表达空间（Expression Space）

三个机制：

**机制一：异议权（Dissent Right）**

```yaml
dissent_rights:
  can_challenge:
    - "上游证据包的任何条目（附具体依据）"
    - "审阅者的打回理由（附反驳证据）"
  cannot_challenge:
    - "CEO的最终拍板（但可以记录保留意见）"
  escalation_path: "debate_meeting"   # 异议无法解决时进入辩论会
```

**机制二：辩论会的平等发言权**。辩论会子图（§10 类型 B）中所有参与者发言权**平等**，不因层级高低给不同权重；发言权由“竞价发言”分配，`recency_penalty` 防止同一 Agent 连续发言；裁决者**中立**（不挂载任何人名 skill，不隶属冲突任一方）。

**机制三：保留意见的记录权**。即使意见被否决，该角色的异议与依据**必须被记录在证据包中**并随任务向上流转。CEO 审批时可看到“技术总监否决了产品经理的方案，理由是 X；产品经理保留了异议，理由是 Y”。**表达空间不因层级而消失** —— 你可以不同意，但你的不同意会被看见。

### 4.1.3 执行空间（Execution Space）

```yaml
tool_permissions:
  granted: ["read_repo", "run_tests", "create_branch", "web_search"]   # web_search 受三层搜索策略约束
  denied:  ["merge_to_main", "deploy_production", "delete_data"]
  harness_defaults:
    claude_code:
      allowed_tools: ["Read", "Edit", "Bash(git:*)"]
      forbidden_flags: ["--yolo"]
    codex:
      sandbox: "workspace-write"
      approval_policy: "never"
      forbidden_flags: ["--full-auto"]
budget_discretion:
  daily_usd: 15
  can_reallocate_within_role: true   # 可在自己的任务间调配预算
  cannot_exceed: true                # 不能突破角色总预算
```

`forbidden_flags` **不可覆盖** —— 即使 Agent 运行时尝试传入 `--yolo`，Gateway 拒绝并记录一次“越权尝试”审计事件。预算给予角色在额度内的自主调配权，但不能突破总额 —— 这是“受约束的自由”在资源维度的体现。

### 4.1.4 判断空间（Judgment Space）

```yaml
judgment_mode:
  type: "bounded_judgment"      # 可选: strict_rules | bounded_judgment | full_discretion
  strict_rules:                 # 必须遵循的硬规则（不可覆盖）
    - "coverage < 0.90 → reject"
    - "p0_defect > 0 → escalate"
  bounded_judgment:             # 硬规则之外的自由裁量区
    - "P2缺陷是否可接受上线（需附风险评估）"
    - "技术方案的备选方案选择（需附ADR）"
  full_discretion: []           # 此角色无完全自由裁量领域
```

- `strict_rules` 是**确定性代码**，由 Gateway 执行，不依赖 LLM 判断。
- `bounded_judgment` 是自由裁量区，但裁量必须附带**可验证依据**（风险评估、ADR、证据引用），否则门控打回。
- `full_discretion` 通常只给 CEO 层 —— 但即使 CEO 的拍板也要记录决策理由，供回放审计。

**原则**：**自由度可以大，但必须可解释**。完全的自由裁量意味着 Agent 可以不做任何解释就做决定，这在 Agent 系统中是危险的。

## 4.2 权力层级的三个维度及工程保证

### 4.2.1 否决权（Veto Power）

“谁可以阻止谁的决定生效”，配置在委派边上：

```yaml
edge:
  from: product_director
  to: tech_director
  review_gate:
    reviewer: tech_director
    veto_power:
      can_reject: true
      rejection_requires: "technical_basis"   # 不能只说“难做”，必须附技术依据
      max_rejections: 3                       # 同一需求最多被打回3次
      escalation_on_exceed: "ceo"             # 超限自动升级CEO
```

**否决权是有条件的**：技术总监可以否决产品经理的需求，但必须附技术依据。`max_rejections` 防止无限打回循环 —— 3 次未收敛自动升级到 CEO，不在总监层内耗。

**否决权的对称性**：产品经理对技术总监的**代价评估**有质疑权 —— 技术总监说“需要 3 个工程日”，产品经理可质疑“估算依据是什么”，技术总监必须附估算依据（ADR、历史数据、复杂度分析）。**没有一方的否决权是绝对的** —— 除 CEO 的最终拍板。

### 4.2.2 升级权（Escalation Power）

“谁可以把问题往上递、递到哪一层”：

```yaml
escalation_triggers:
  - { condition: "review_conflict_rounds >= 3", target: "ceo", action: "create_approval_card" }
  - { condition: "irreversible_action_detected", target: "ceo", action: "pause_and_escalate" }
  - { condition: "budget_threshold_reached",     target: "ceo", action: "pause_and_escalate" }
  - { condition: "strategic_uncertainty_flagged", target: "ceo", action: "create_decision_meeting" }
```

**升级权是受限的** —— 不是“谁都能往 CEO 递”。只有满足触发条件，升级才被允许，防止 Agent 把日常决策甩给 CEO。每次升级写入审计事件，CEO 可看到“谁在什么情况下把什么问题递上来了”。

**升级权有层级性**：执行层（开发/测试）的升级目标通常是总监层，只有总监层无法解决的问题才升到 CEO。

### 4.2.3 资源分配权（Resource Allocation Power）

```yaml
resource_authority:
  company_budget: "ceo"                 # CEO控制公司总预算
  role_budget: "ceo"                    # CEO分配角色预算
  task_budget_within_role: "role_self"  # 角色在自己的预算内自主调配
  hire_fire: "ceo"                      # 只有CEO可增删角色
  tool_permission_grants: "ceo"         # 只有CEO可修改角色工具权限
  role_charter_edits: "ceo"             # 只有CEO可修改岗位书
```

**资源分配权集中在 CEO，不分散给 Agent**。Agent 可在自己预算内调配，但不能突破总额、不能给自己加工具权限、不能修改自己的岗位书。**框架本身的修改权只属于 CEO** —— 这是权力层级的硬边界。

## 4.3 自由与层级的调和：四个机制

| # | 机制 | 自由度体现 | 层级体现 | 调和逻辑 |
|---|---|---|---|---|
| 1 | 白名单授权 + 黑名单硬拦截 | `decision_scope.autonomous` | `forbidden_actions` / `forbidden_flags` 由 Gateway 硬拦 | Agent **在白名单内自由，在黑名单前止步**；中间灰色地带（`requires_consultation`）必须咨询 |
| 2 | 判断可自由，但必须可解释 | `bounded_judgment` | 解释义务：判断必须附可验证依据，否则门控打回 | **可以自由判断，但不能自由地不解释**；解释义务是自由度与层级之间的契约 |
| 3 | 异议可表达，但拍板权唯一 | `dissent_rights` | 最终决定权属 CEO，不属任何 Agent | **表达空间自由，决策权集中**；异议被记录、被看见、成为 CEO 决策输入，但不自动推翻已生效决定 |
| 4 | 同级制衡，上下门控 | 同级横向制衡（产品 ↔ 技术无服从关系，争论都须附依据） | 上下纵向门控（执行层产出须经总监层门控才上移） | **横向是制衡，纵向是门控**；防止同级互相放水与上级一言堂 |

## 4.4 动态调整：信任建立后的放宽与收紧

### 4.4.1 信任积分（Trust Score）

```yaml
trust_score:
  current: 0.85          # 0–1
  history_window: 50     # 最近50次决策
  components:
    review_pass_rate: 0.90        # 产出被上级审阅通过的比例
    escalation_accuracy: 0.80     # 升级到CEO的事项中CEO最终批准的比例
    unauthorized_attempts: 0      # 尝试执行 forbidden_actions 的次数
    rollback_rate: 0.05           # 产出被后续环节打回或回滚的比例
```

### 4.4.2 基于信任的动态调整

| 信任积分 | 调整 |
|---|---|
| **> 0.9** | `decision_scope.autonomous` 可扩展（如允许技术总监自主引入技术雷达内的新依赖，不需咨询架构师） |
| **0.7 – 0.9** | 保持当前配置 |
| **0.5 – 0.7** | `requires_consultation` 范围扩大（如技术总监的预算调配需咨询 CEO） |
| **< 0.5** | `judgment_mode` 降级为 `strict_rules`（暂时失去自由裁量权） |

**关键约束**：信任积分**不能自动修改岗位书** —— 调整建议由系统生成，**必须经 CEO 批准**才生效。这防止“系统自动放权导致失控”。CEO 在组织配置页看到“技术总监信任积分 0.92，建议扩展其自主决策范围”，点击批准后才生效。

### 4.4.3 越权尝试的即时收紧

任何一次 `forbidden_actions` 尝试（即使被 Gateway 拦截）立即触发：

1. 该角色信任积分扣减（幅度由 CEO 配置）；
2. 审计事件记录（`action='unauthorized_attempt'`）；
3. 同一角色 24 小时内越权尝试 ≥ 3 次 → 自动降级为 `strict_rules` 并通知 CEO。

**自由度的“可撤销性”**：Agent 的自由不是一次性授予的永久权利，而是**可随时收紧的临时授权**。

## 4.5 审计的双重职责：防滥用 + 防僵化

**防止自由度滥用**：记录每次 `bounded_judgment` 的判断/依据/审阅验证结果、每次 `autonomous` 决定的执行结果与是否被回滚、每次 `unauthorized_attempt` 被哪条规则拦截。回放视图可分析：**某角色自由裁量判断事后被证明正确的比例** —— 若频繁被后续环节推翻，说明自由度给得太大，CEO 应收紧 `decision_scope`。

**防止层级僵化**：记录每次 `rejection`（谁否决谁、依据、被否决方是否保留异议）、每次 `escalation`（谁升级、CEO 最终是否批准）、每次 `dissent`（谁表达异议、是否被采纳）。回放视图可分析：**某审阅者否决事后被证明正确的比例** —— 若技术总监频繁否决但 CEO 最终都批准产品经理的方案，说明否决权使用过度，应提高否决门槛（要求更充分的技术依据）。

**审计的核心价值**：它不是合规工具，是**组织调参的数据来源**。自由度和层级不是一次配置就固定的，而是持续调优的。

## 4.6 一句话总结

> **自由度** = 白名单内的自主决定 + 可解释的判断空间 + 可表达的异议权 + 预算内的资源调配权
> **权力层级** = 有条件的否决权 + 受限的升级权 + 集中的资源分配权 + 唯一的最终拍板权
>
> 两者通过“白名单授权 + 黑名单硬拦截”“判断自由但必须可解释”“异议可表达但拍板权唯一”“同级制衡 + 上下门控”四个机制调和。信任积分与审计回放提供动态调参能力，但**框架本身的修改权始终在 CEO 手里**。

---

# 5. 技术架构与选型

> **语言栈**：**TypeScript 单一语言**。桌面壳、事件总线、编排内核、Agent 运行时、Harness Gateway、MCP、Skills、IM 适配器、SQLite 访问全部由 TS 实现。
>
> **持久化**：**单个 SQLite 文件直绑软件**（`~/.opc-os/opc.db`，WAL 模式），不引入独立数据库服务、不引入消息中间件（论证见 §5.8），文件制品走本地文件系统（§5.10）。理由：单用户、低并发写、数据量中等 —— 一个 CEO、若干 agent、心跳 15 分钟一次、每次节点状态变更才写一次。**这不是高频交易系统。**

## 5.0 这套栈成立的四条前提，与必须付的三处代价

**成立的四条硬证据**（npm registry 实测，2026-11-06）：

1. **三个 harness 全部提供官方 TypeScript SDK** —— Harness Gateway 因此**不必解析 CLI 的 stream-json**，可直接用类型化 API（§12.1）：
   `@anthropic-ai/claude-agent-sdk` **0.3.318**（零依赖 + 按平台分发的 optionalDependencies 二进制）、`@openai/codex-sdk` **0.167.0**、`@qoder-ai/qoder-agent-sdk` **1.0.59**（本身即构建在 `@modelcontextprotocol/sdk` 之上）。
2. **LangGraph 有官方 JS 实现且在活跃发布**：`@langchain/langgraph` **1.7.1**（发布日 2026-11-06，即本文档核对当日）、`@langchain/langgraph-checkpoint` 1.2.2、`@langchain/langgraph-checkpoint-sqlite` 1.1.0。原设计选择 LangGraph 的三条理由（有向图状态机 / 每步 Checkpoint / 断点恢复与回放）在 JS 侧全部有对应能力。
3. **MCP 与 AG-UI 的官方 TS SDK 是一等公民**：`@modelcontextprotocol/sdk` **1.32.2**、`@ag-ui/client` **1.0.4**（rxjs + fast-json-patch，正是 §5.8 描述的“事件驱动增量更新、前端不轮询”）。MCP 规范本身以 TS/Python 双官方实现并行，**在 MCP 这一层 TS 不吃亏，甚至更顺**（与“后续 mcp/skills 都是 node”直接对齐）。
4. **飞书官方 Node SDK 存在且内置长连接**：`@larksuiteoapi/node-sdk` **1.76.0**（依赖 `ws`，支持“使用长连接接收事件”模式）→ §11 的 Channel 层可在 Node 内直接落地，不需要任何 Rust 适配器。

**要付代价的三处**（明确写出来，不当作不存在）：

1. **壳层内存与安装包体积**。桌面壳选 Electron（§5.2），已知代价是壳常驻内存 100MB 量级、安装包 80–200MB；轻量壳（Tauri / Neutralino）能把这两项压到 20MB / 2–10MB，代价是**要写 Rust**。本文档接受这份开销，量化论证见 §5.2，风险登记见风险 13。
2. **LangGraph.js 的能力面小于 Python 版**（社区长期共识，本文档未逐项穷尽验证）。落地前必须做一次**针对性 PoC**，验证清单见 §24 风险 11 —— 不要在 PoC 之前把编排逻辑写完再换框架。
3. **一旦有原生模块，Electron 就要重编译**。`@langchain/langgraph-checkpoint-sqlite` 依赖 **`better-sqlite3@^12.10.0`（node-addon-api + node-gyp 原生模块）**，Windows 构建需要 MSVC Build Tools，且每次 Electron 升版要跑 `@electron/rebuild`。是否接受这个原生依赖是一个**独立的决策点**，见 §5.6 与 §25-D6。

## 5.1 进程模型：一个 Hub 常驻，UI 只是壳

```
┌─ UI 层 ────────────────────────────────────────────────────
│  React + TypeScript + @ag-ui/client
│  桌面：Electron 渲染进程 ／ Web：浏览器 ／ 移动：Capacitor WebView 或 PWA
└───────────────────────────────┬───────────────────────────
                                │  IPC(preload) ／ HTTP+WS ／ SSE
┌───────────────────────────────▼─ OPC-OS Hub ───────────────
│  **Node 24 LTS + TypeScript，独立常驻进程**（§5.3）
│
│  编排与运行时   LangGraph.js 图执行（角色节点 / 审阅门控 / 升级路由）
│                角色 Agent 运行时 · 调研子图 · 策略引擎 · 心跳调度
│  接入与桥接     Harness Gateway（三家官方 TS SDK 为主，CLI 兜底）
│                MCP Client · A2A · Skills 加载器（解析 SKILL.md）
│                Channel 层（飞书 / 企微 / QQ 官方 Node SDK）
│  系统能力      **SQLite 唯一写者**（进程内写队列，§5.5、附录 C.2）
│                事件广播器（AsyncIterable，三出口，§5.8）
│                子进程监管 · 文件制品 · 签名验证 · 一次性 token
│                本地 HTTP/WS 服务（Hono）→ Web / 移动端 / 远程审批
└───────────────────────────────┬───────────────────────────
                                │
┌───────────────────────────────▼─ 存储层 ───────────────────
│  ~/.opc-os/opc.db       单个 SQLite 文件（WAL），Hub 独占写
│                         驱动：node:sqlite 或 better-sqlite3（§5.6 D6）
│  ~/.opc-os/artifacts/   文件制品（task_id / bundle_type / hash）
│  ~/.opc-os/backups/     VACUUM INTO 一致性快照
│  ~/.opc-os/secrets/     凭证加密存储（不进 events、不进日志）
└──────────────────────────────────────────────────────────
```

**关键性质：编排、运行时、数据写入、事件广播共处同一个 Node 进程。** 因此本设计中不存在跨语言 IPC 协议层，也不存在跨进程写协调 —— 写串行化是**进程内**的一个队列（§5.5），不是分布式问题。这条性质同时决定了：`node:sqlite` 只能出现在 Hub（§5.6.1），以及数据库驱动选择不受桌面壳构建约束。

## 5.2 桌面壳决策：Electron（建议）与三条备选

| 方案 | 语言 | 优点 | 代价 | 判定 |
|---|---|---|---|---|
| **A. Electron 45 + electron-vite + electron-builder** | **纯 TS** | 与全栈同语言；主进程即 Node → 可直接 `child_process` 起 harness、直连 SQLite、跑 LangGraph；无 ABI 之外的构建魔法（若不引入原生模块则连 ABI 问题都没有）；生态最成熟（打包 / 自动更新 / 代码签名 / Squirrel）；Electron 45 声明的 devDependency `@types/node` 为 ^24.9.0，**据此推断其内嵌 Node 与本机验证过 `node:sqlite` 的 Node 24.21.0 同代**（官方 Release Note 的对应字段本次未能直接取到 → **此项为推断，不是实测**；且见下方 §5.6.1 的关键限定） | 壳常驻内存 100MB 级、安装包 80–200MB（量化影响见下方与风险 13） | **建议采用** |
| B. **Web 化**：Hub 常驻 + 浏览器访问（localhost 或 Tailscale） | 纯 TS | 零壳依赖、零打包、天然跨平台、天然支持移动端与远程审批、最契合“Hub 才是本体”的事实 | 无系统集成（托盘、通知、开机自启需另做）；本地文件制品访问要走 HTTP；用户要自己开浏览器 | **强烈建议作为并行交付面**：Hub 暴露本地 HTTP/SSE，浏览器是一个零成本的第二前端（见 §5.7） |
| C. Tauri 2 但**一行 Rust 都不写**（只用官方插件） | TS + 预编译 Rust | 保住内存与体积优势；`@tauri-apps/plugin-shell`、`plugin-sql` 可覆盖大部分需求 | 一旦要自定义进程监管、签名、复杂文件系统桥接就**必须写 Rust**；SQLite 驱动在 Tauri 侧另成一套；调试要跨 JS/Rust 边界。**与“不用 Rust”的意图冲突**，只是把成本推迟 | 不采用 |
| D. Neutralino / Webium 等轻量壳 | TS | 体积极小 | 生态与长期维护风险高，harness 子进程监管能力弱 | 不采用 |

**内存代价的量化论证**（为什么这次可以接受）：OPC-OS 的真实内存主导项不是 UI 壳，而是**同时运行的 harness 子进程**（Claude Code / Codex 每个都是完整的 Node CLI 进程，单实例常驻即百 MB 量级）+ Hub 内的 LangGraph 运行时 + 多个角色 Agent 上下文。在“5 个任务并行、2 个 harness 在跑”的常态负载下，壳层从 20MB 变成 100MB，**在总占用中的占比是个位数百分比**，换取的是：删掉一整条 Rust 代码路径、删掉跨语言 JSON-RPC 协议层、删掉 §24 风险 9。这笔交换是划算的。

## 5.3 Hub 是独立常驻进程，UI 只是它的客户端

Hub 不是“桌面壳的主进程”，而是**可独立启动的 Node 守护进程**（`opc-hub`），桌面壳、浏览器、移动端、飞书都只是它的客户端。这个边界一举解决四个问题：

| 问题 | 由“Hub 独立进程”得到的结果 |
|---|---|
| 桌面端关机 → 移动端与飞书审批全部失效（风险 10） | Hub 可单独部署到 VPS / 树莓派常驻，**同一套代码同一台机器换一种跑法**，不需要第二套部署形态 |
| 移动端只能“纯 RPC”且依赖桌面机在线（§5.7） | RPC 目标从“我的桌面机”变成“任意常驻主机” |
| 审计与回放需要连续的历史数据（§22） | 中心化 Hub + 单一 SQLite，让“多台桌面机 → 一台 Hub”收敛为一种部署，**不做多端同步也成立** |
| 数据库驱动受桌面壳构建标志约束（§5.6.1） | Hub 跑在系统 Node 24 LTS 上，SQLite 驱动选择与壳彻底解耦 |
| UI 与 Hub 崩溃互相牵连 | 边界清晰：Hub 挂 → UI 降级为只读 + 重连；UI 挂 → agent 继续跑 |

**代价**：Hub 与 UI 分离后，UI 到 Hub 的 IPC 变成 HTTP/WS，需要本地鉴权（复用 §11.4 的一次性 token + 签名机制），并要明确 Hub 崩溃时的 UI 降级表现（只读缓存 + 重连）。

## 5.4 编排内核：LangGraph.js

| 项 | 选型 |
|---|---|
| 框架 | `@langchain/langgraph` **1.7.1**（官方 JS 实现，npm 核对日 2026-11-06） |
| Checkpoint | `@langchain/langgraph-checkpoint-sqlite` **1.1.0**（依赖 better-sqlite3）**或自研 Saver 走 `node:sqlite`** —— 取决于 §5.6 的 D6 判定 |
| Saver 基类（自研时用） | `@langchain/langgraph-checkpoint` 1.2.2 提供 `BaseCheckpointSaver` 接口 |
| 节点级模型配置 | 支持，模型经 `@langchain/anthropic` / `@langchain/openai` 等注入（§5.9） |
| 前端事件协议 | `@ag-ui/client` 1.0.4，SSE 事件语义（§5.8） |
| 客户端 SDK | `@langchain/langgraph-sdk` 1.14.0（Hub ↔ UI 可用） |

**PoC 门禁（Phase 0 的第 0 天工作，不可跳过）**：用一个最小图验证以下 5 项，任一不满足就触发 §25-D7 的框架替换：
1. 条件边 + 汇聚节点（评审会 = 多节点汇聚）能否表达；
2. 每步 Checkpoint 写入后**进程被 kill**，重启能否从断点恢复且不重复计费；
3. 并行分支（Phase 3 之后要加）Reducer 合并语义；
4. 中断/恢复（human-in-the-loop 的 interrupt 语义）能否映射到 §9 的审批卡片；
5. 子图（§10.2 辩论会作为节点内子图）能否嵌套并正确 Checkpoint。

**候选替换：Mastra**（`@mastra/core` **1.82.0** / `mastra` 1.38.0，TS 原生 Agent 框架，含 workflows/graphs）。它是 TS-first 设计，与 Node 生态摩擦更小；但它是另一套抽象、迁移成本与治理成熟度需单独评估。**默认用 LangGraph.js**（理由见 §5.4.1），仅在上述 PoC 失败时启用 Mastra。

### 5.4.1 为什么是 LangGraph，而不是 CrewAI / AutoGen

选型依据：**2026 年框架选型的核心标准是“状态能否持久化、多 Agent 并行时 Reducer 怎么合并、Checkpoint 崩了能否从断点恢复”，而不是“API 好不好写”。** 按这三条：

| 候选 | 判定 | 依据 |
|---|---|---|
| **LangGraph（JS）** | ✅ 采用 | 有向图状态机 + 每步自动 Checkpoint，直接满足“逐级委派、断点恢复、审计回放”；有向图与 §3.3 委派规则图**一一对应**（这是审阅门控能做成“图结构硬约束”而非提示词约定的前提） |
| **CrewAI** | ❌ 不采用 | 角色抽象直观，但 2026 年的生产就绪评估将其标记为 **“Limited; lacks persistence”**，更适合快速原型，而非需要长期运营、要审计要回放的公司系统 |
| **AutoGen** | ❌ 不采用 | 已进入**维护模式**，不应作为新项目的底座 |
| **Mastra** | ⚠ 备选（D7-b） | TS 原生、生态摩擦小，但抽象迁移成本与治理成熟度需单独评估；仅在 PoC 失败时启用 |
| **自研薄图执行器** | ⛔ 最后手段（D7-c） | 需自实现 Checkpoint 语义、重放、并发合并、中断恢复，估 3–4 周且长尾 bug 多（§25-D7） |

**编排层的三项设计要求**：① 整个“公司”= 一张图，节点是**角色**，边是**交接条件**；② 每个交接节点是一个**审阅门控**（§8），上游证据包通过验证后状态才沿边流转；③ CEO 的“战略拍板”是一个**不连在图内部**的特殊节点，由**升级路由**触发（§8.3）—— 这一点在 JS 侧对应 LangGraph 的 interrupt/中断-恢复语义，也正是 §5.4 PoC 门禁第 4 项要验证的东西。

## 5.5 关键决策：SQLite 写路径唯一（进程内写队列）

**必须串行化写**，理由不是理论洁癖而是实测结论：

- **原则**：SQLite 写路径唯一 —— 由 Hub 内一个 `writeQueue`（`AsyncQueue` + 单个 writer task）串行化，业务侧只入队。实现见附录 C.2。
- **并发的真实来源**：心跳调度、节点状态变更、Hub HTTP 服务触发的审批写入，三者都会写库。**不能指望 SQLite 自己排队** —— Node 24.21.0 / SQLite 3.53.4 实测：写事务持锁期间，另一连接即便设了 `busy_timeout=5000`，仍在等待 **5573ms** 后抛出 `database is locked`。因此应用层写队列是唯一可靠的串行化手段（§6.5）。
- **PRAGMA**：`journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`、`foreign_keys=ON`。
- **Checkpoint 与 events 必须同事务提交**（§6.3）：写 Checkpoint 与 `INSERT INTO events` 落在同一个事务里，否则回放会出现“状态变了但没有日志”。这条约束是 §5.6 禁止 D6-c 的原因。

## 5.6 SQLite 驱动决策（D6，需 CEO 拍板）

**驱动选型的判据来自实测，不来自文档**（Node 24.21.0 / SQLite 3.53.4，2026-11-06）：

| 能力 | node:sqlite 实测结果 | 对 OPC-OS 的影响 |
|---|---|---|
| WAL / busy_timeout / synchronous / foreign_keys | ✅ 全部可设（`journal_mode` 返回 `wal`） | §5.5 的 PRAGMA 组合可落地 |
| **append-only 触发器**（`RAISE(ABORT)` 拦 UPDATE/DELETE） | ✅ UPDATE 拦截 = true，DELETE 拦截 = true | §6.3 的审计不可变性**可以只用内置驱动实现** |
| FTS5 虚拟表 + 同步触发器 | ✅ 可建 | ⚠️ **默认 unicode61 分词检索“覆盖率”命中 0**；换 `tokenize='trigram'` 后命中 1（但 trigram 对任意子串如“件通”仍不命中）→ 中文事件检索必须 **trigram + LIKE 双路兜底**，DDL 已在附录 C 修正 |
| json1 `json_extract` | ✅ 返回 42 | §6.1 的 JSON 存 TEXT 方案成立 |
| 事务原子回滚 / SAVEPOINT | ✅ | Checkpoint + events 同事务可行 |
| `VACUUM INTO` 一致性快照 | ✅ 生成 45056 字节快照 | §6.5 备份策略可行 |
| `PRAGMA integrity_check` | ✅ 返回 ok | 启动自检可行 |
| 第二只读连接并发读 | ✅ 读到 2 行 | WAL 读不阻塞写成立 |
| 写吞吐 | 事务内 2000 条 **5ms（≈40 万条/秒）**；逐条自动提交 **约 2ms/条**（synchronous=NORMAL） | 两者相差 4 个数量级 → **必须批量事务写入**，逐条提交会让事件写入成为瓶颈（§6.5） |
| `db.backup()` 在线备份 API | ❌ **不存在** | 备份只能用 `VACUUM INTO`（附录 C 已按此写） |
| 稳定性 | ⚠️ 该内置模块在 Node 中仍处 **实验状态**，API 未来可能变动 | 需锁 Node 主版本，并在 §24 风险 12 记录 |

**三个选项**：

| 选项 | 做法 | 收益 | 代价 |
|---|---|---|---|
| **D6-a 全用 `node:sqlite`（业务表 + 自研 Checkpoint Saver）** | 实现 `BaseCheckpointSaver`（基于 `@langchain/langgraph-checkpoint` 基类）指向 node:sqlite | **整个二进制零原生依赖** → 免 node-gyp / 免 `@electron/rebuild` / Windows 打包只需 Node；体积与 CI 最简 | 要自己写并测试 Checkpoint Saver（估 3–5 天，含兼容性回归）；依赖实验性 API |
| **D6-b 全用 `better-sqlite3`**（官方 SqliteSaver 直接用） | 官方 SqliteSaver 开箱可用 | 零自研；成熟稳定；同步 API 性能好 | 引入**原生模块**：Electron 每次升级要 rebuild，Windows CI 需 MSVC Build Tools，prebuild 缺失时用户机器现场编译 |
| **D6-c 混合：业务表 node:sqlite + Checkpoint better-sqlite3** | 两套驱动指向**两个 db 文件** | 折中 | ⚠️ **破坏 §6.3“Checkpoint 与 events 同事务”**（跨文件无法原子提交）→ 审计完整性（风险 6）出现真实缺口。**不建议** |

**建议 D6-a**，并作为 **Phase 0 的第一个任务**：先花 3–5 天写 Saver + 跑通 PoC，成功后整个项目无 C++ 依赖。若 Saver 实现受阻，退回 D6-b 并接受原生依赖（成本可控，代价是 CI 变脏）。**D6-c 禁止。**

### 5.6.1 关键限定：`node:sqlite` 只在 Hub 进程使用（D6-a 的前提）

**§5.6 的实测环境是系统 Node 24.21.0**。**Electron 内嵌的 Node 是否同样暴露 `node:sqlite`，尚未验证** —— 该内置模块要求运行时构建时把 SQLite 编进去，而打包型运行时（Electron 尤其如此）常裁剪可选内置模块。这是**一条尚未消除的不确定性，不能靠“都是 Node 24”就假定可用**。

**本设计的进程边界已经把它化解**（§5.3）：

| 进程 | 运行时 | 是否 `require("node:sqlite")` |
|---|---|---|
| **`opc-hub`（唯一写者）** | **系统 / 自带 Node 24 LTS**（不受 Electron 构建标志影响） | ✅ **唯一允许的位置** |
| Electron 主进程（壳） | Electron 内嵌 Node | ⛔ **不直接使用** —— 一律经 IPC 向 Hub 取数 |
| Electron 渲染进程 / Web / 移动端 | Chromium 或 WebView | ⛔ 本来就没有 |

**写死的纪律（编译期强制）**：`node:sqlite` 只允许出现在 `packages/hub/**`；`packages/desktop/**`、`packages/web/**` 一旦 import 即构建失败（ESLint `no-restricted-imports` + 分目录 tsconfig）。

**由此得出的 D6 判定顺序**（Phase 0 第 0 天照此执行）：
1. 先在**系统 Node 24** 里跑通 Saver（本文档已证明底座可用）→ 可行则 D6-a 成立，**与 Electron 无关**；
2. 桌面壳只通过 IPC 向 Hub 要数据，**永不直接开库**；
3. 只有当你要求"单机一体化、不要独立 Hub 进程"时，Electron 内嵌 Node 的 `node:sqlite` 可用性才重新变成阻塞项 —— 那种形态下直接选 **D6-b**。

> 结论：**Hub 独立进程让数据库驱动的选择脱离桌面壳的构建约束。** 这也是“Hub 才是本体、壳只是客户端”（§5.1、§5.3）这条边界在依赖层面带来的直接收益。

## 5.7 多端策略

| 端 | 形态 | 数据访问 |
|---|---|---|
| **桌面** | Electron 45 壳（今日视图 / 看板 / 收件箱 / 组织配置 / 回放） | 经 IPC → Hub；**渲染进程不直连 SQLite** |
| **Web** | 浏览器直接访问 Hub 的本地/内网 HTTP + SSE（零额外代码，与桌面同一套 React 组件，仅路由裁剪） | HTTP/SSE |
| **移动** | **纯 RPC（§25-D5 选项 A）**：Capacitor 壳承载同一套审批卡片流 React 组件，或直接用 PWA；**本地不落库** | HTTP/WS → Hub |
| **飞书 / 企微 / QQ** | IM 审批通道（§11）：Channel 抽象层 + 各家官方 Node SDK，飞书走 `@larksuiteoapi/node-sdk` 长连接 | Hub 内直连，不经任何客户端本地数据 |

**本设计不做多端数据同步** —— 同步是另一个产品。SQLite 单文件、单一权威、Hub 独占写；Hub 跑在哪台机器是部署选择（§25-D9：桌面机 / 常驻小主机），不影响数据形态。

**飞书审批路径不依赖移动端**（§11）：它走飞书服务器 ↔ Hub 的长连接，与移动端本地数据无关，因此**即使完全不做移动端，移动审批仍然可用**。这是 Channel 层的设计价值 —— **它绕过了“多端数据同步”这个难题，而不是解决了它。**

## 5.8 事件总线：为什么不需要 Redis / 消息中间件

**不引入 Redis 或任何消息中间件。** 理由：所有消费者的订阅终点都是**同一个 Hub 进程内的同一个广播器** —— UI（桌面/浏览器/移动）与 IM 只是广播器的三个出口，没有跨机器、跨进程的订阅方。pub/sub 中间件在此场景是纯粹的过度设计：它解决的是“多个进程/多台机器各自订阅”，而本设计根本没有这种拓扑。

```
                    ┌── Electron 渲染进程（IPC / preload）
LangGraph 节点事件 →  Hub 内 BroadcastChannel（异步可迭代 + 有界队列）
                    ├── 本地 HTTP SSE（Web 前端 / 移动端）
                    └── IM 适配器（飞书卡片更新 / 会议摘要推送）
```

**实现要点（TS）**：
- 用 **`AsyncIterable` + 有界环形队列**做进程内广播，慢消费者**丢弃最旧事件并标记 `degraded`**（全量状态由 UI 重新拉取 REST 补齐，事件只做增量）—— 这与 §19.4 的“三层折叠”一致：UI 丢了几个增量事件不该丢真相。
- **不做 `events.unsafeDispatch` 式的“事件即状态”**：AG-UI 事件是**投影**，SQLite 的 `events` 表才是**事实源**（§22）。断线重连的恢复路径是“REST 拉快照 + 从游标续订 SSE”，不是回放事件流。
- **背压**：SSE 写失败即视为消费者断开，回收其队列；harness stdout 这类高速源单独限流。

**事件类型（Hub → 前端，与 `@ag-ui/client` 事件模型映射）**：

| 事件 | 触发 | 前端反应 |
|---|---|---|
| `TaskStateChanged` | §7.1 状态机迁移 | 看板卡片就地更新（层级列 + 摘要行） |
| `ReviewDecided` | 门控判定（通过/打回/升级） | 审阅链追加一条 |
| `ApprovalRequired` | §8.3 升级路由 / §9 卡片生成 | 收件箱计数 +1，琥珀色出现 |
| `BudgetPaused` | §7.4 预算硬停 | **非琥珀色**卡片 + 日消耗条变红 |
| `MeetingSummaryReady` | §10.3 会议产出 | 飞书卡片 + 回放视图新增会议节点 |
| `HeartbeatStalled` | §7.3 停滞追问 | “信息性”异常卡片（非决策卡） |

**前端不轮询**：开发工程师完成任务时，事件流把 `ReviewDecided` 推给测试节点的审阅者队列、看板同时更新；CEO 在手机上批准战略提案时，Hub 恢复该图的执行并广播 `TaskStateChanged`。**前端只消费事件、不承担业务逻辑**——这条纪律在 TS 里同样关键，否则渲染进程里会长出第二套状态机。

## 5.9 模型分层策略（节点级配置）

| 层级 | 模型档位 | 用途 |
|---|---|---|
| CEO 层 / 助理层 | **强推理模型** | 战略拆解、跨部门冲突裁决、审阅质量把关 |
| 总监层 | **强模型或中高模型** | 方案设计、跨职能协调 |
| 执行层（开发 / 测试 / 运营操作） | **成本优化模型** | 按任务复杂度动态路由 |

与 agents-inc“廉价模型做常规工作、昂贵模型做管理”的成本逻辑一致，但实现位置不同：**通过 LangGraph.js 的节点级模型配置注入**（模型实例挂在节点上，不是框架层硬编码、更不是提示词里写“你要节俭”），岗位书里的 `model_tier` 字段（附录 B.1 / B.2）驱动这张映射表。

**两条硬性约束**：
1. **审阅者模型家族必须与产出者不同**（§24 风险 1）：`review_gates.reviewer_model_family` 落库（附录 C），门控保存时校验“同家族审阅”需显式批准 —— 这条在 JS 里是**纯函数校验**，不需要任何特殊运行时。
2. **模型 Provider 统一走 `@langchain/core` 的 message API**（`@langchain/anthropic` 1.6.0 / `@langchain/openai` 1.8.0 等），供应商切换不动业务代码；harness 内部的模型由 harness 自己管，**不计入本表**，其成本经 Gateway 的 `get_cost` 单独入账（§21.2）。

## 5.10 制品存储、凭证与未来迁移路径

**文件制品：本地文件系统**（不用 S3 / MinIO 等对象存储 —— 单机场景足够），`~/.opc-os/artifacts/{task_id}/{bundle_type}/{bundle_id}.{ext}`，SQLite 只存路径与 sha256（§6.4）。未来需多端共享时再引入对象存储（v1.1 之后的独立工作项）。JS 侧用 Node 内置 `crypto.createHash("sha256")` 做完整性校验，无需新依赖。

**凭证**（§20.4 的落地方式）：API key、IM 签名密钥**不进 `events`、不进日志**。存储优先用 OS keyring（`node-keytar` 类方案），但它属**原生模块** —— 会与 §5.6 D6-a 的“零原生依赖”目标冲突。因此在 D6-a 成立的前提下，凭证存储采用**本地 AES 加密文件 + 机器绑定口令**。Hub 独占读取，渲染进程永远拿不到明文，只能请求 Hub 代发。

**未来若需迁移到 PostgreSQL 的路径**（当前**不做任何 PG 兼容层**，只保证 schema 可迁移）：

Schema 已按可迁移原则设计（避免 PG 特有类型：UUID→TEXT、时间→INTEGER、金额→美分 INTEGER、JSON→TEXT，见 §6.1）。届时四步：① 各表导出 CSV/JSON；② PG 建表（TEXT/INTEGER 直接映射，JSON→JSONB）；③ 导入；④ Checkpoint 从 SqliteSaver 切 PostgresSaver（JS 侧官方包 `@langchain/langgraph-checkpoint-postgres` **1.1.2** 已存在，npm 实测）。

**唯一合理的迁移触发条件**：Hub 长期常驻且被多台桌面机共用（§5.3、§25-D9），此时单文件 SQLite 成为真实瓶颈。**迁移是因为部署形态变了，不是因为 PG 更高级 —— 本设计不因“更体面”而引入独立数据库服务。**

## 5.11 语言栈一致性清单（写死，防止混栈回潮）

| 关注点 | 唯一选型 | 备注 |
|---|---|---|
| 运行时 | Node **24 LTS**（锁主版本） | 内置 `node:sqlite`（若采纳 D6-a）、原生 `fetch`、`test_runner`/`--experimental-strip-types` |
| 桌面壳 | Electron 45 + electron-vite 6 + electron-builder 26 | 自动更新 electron-updater 6 |
| 编排 | `@langchain/langgraph` 1.x | 见 §5.4 PoC 门禁 |
| 工具协议 | `@modelcontextprotocol/sdk` 1.x | MCP Server 一律写成 Node 包 |
| Skills 加载 | 自研 TS 加载器 + `gray-matter`（解析 SKILL.md frontmatter）+ zod 4 校验 | Skills = **Node 侧可加载的认知输入**（§14.5） |
| 校验/Schema | zod 4 | 岗位书、证据包、审批卡片的唯一 schema 来源 |
| 前端 | React 18/19 + TS + `@ag-ui/client` + `@xyflow/react` 12 + `@dagrejs/dagre` 3 + `@dnd-kit/core` 6 | 见 §18 |
| 本地服务 | Hono 4（或 Fastify 5）+ `ws` | 移动端与远程审批、SSE |
| 子进程 | `execa` + Node `child_process` | harness CLI 兜底路径 |
| 日志 | pino（结构化，落 `~/.opc-os/logs`） | 与 `events` 表分离：日志 ≠ 审计 |
| 测试 | vitest（含确定性门控测试，§24 风险 5） | Playwright 做 Electron E2E |
| 质量 | Biome 2（lint + fmt）+ tsc | — |

**禁止项**：不引入 Rust、不引入 Python 运行时、不为“性能”把任何模块改写成原生 addon。若未来确有 Python-only 能力需求（例如运营复盘要跑 pandas 类分析），走 **MCP 边车**（§5.11 语言栈纪律）：把它包成独立 MCP Server 进程，Hub 只通过 MCP 调用 —— 语言隔离在进程边界外，不进主栈。

---

# 6. 数据模型（SQLite）

完整建表脚本（含 PRAGMA、append-only 触发器、FTS5、备份与完整性校验）见 **附录 C**。

## 6.1 类型映射原则

| PostgreSQL | SQLite | 说明 |
|---|---|---|
| `UUID` | `TEXT` | 存 UUID 字符串，应用层生成 |
| `TIMESTAMPTZ` | `INTEGER` | 存 Unix 毫秒时间戳，避免时区与字符串比较问题 |
| `NUMERIC(10,2)` | `INTEGER` | 存**美分**，避免浮点误差 |
| `JSONB` | `TEXT` + json1 扩展 | SQLite 内置 `json_extract()`、`json_valid()` |
| `BIGSERIAL` | `INTEGER PRIMARY KEY AUTOINCREMENT` | 事件日志主键 |
| `BOOLEAN` | `INTEGER`（0/1） | SQLite 无原生布尔 |

## 6.2 核心表一览

| 表 | 用途 | 关键字段 |
|---|---|---|
| `tasks` | 任务树与状态机 | `parent_id`、`charter_id`、`status`、`assigned_role`、`current_node`、`budget_cents`、`consumed_cents`、`state_snapshot`、`graph_checkpoint_id`、**`graph_version`**（创建时组织图版本，见 §18.4） |
| `events` | append-only 审计日志 | `actor_type`（agent/human/system）、`actor_id`、`action`、`target`、`payload`、`state_snapshot`、`created_at` |
| `review_gates` | 审阅门控决定 | `gate_type`、`reviewer_role`、`evidence_bundle_id`、`decision`（approved/rejected/conditional/escalated）、`decision_reason`、`conditions` |
| `evidence_bundles` | 证据包 | `producer_role`、`bundle_type`、`artifacts`（路径 + sha256）、`self_check`（明确标注“自检，非独立验证”） |
| `approvals` | CEO 审批收件箱 | `approval_type`、`summary`、`parameters`、`recommendation`（标注“推荐，非决定”）、`recommendation_source`、`timeout_behavior`、`timeout_at`、`status` |
| `role_charters` | 岗位书版本化 | `role_id` + `version`（UNIQUE）、`config`、`effective_from`、`created_by` |
| `budgets` | 预算（公司/角色/任务三级） | `scope_type`、`scope_id`、`period`、`limit_cents`、`consumed_cents`、`hard_stop` |
| `delegation_graphs` | 组织/委派图版本化 | `version`、`graph_json`、`effective_from`、`change_summary`（见 §18.4） |
| `artifacts_meta` | 文件制品索引 | `task_id`、`bundle_id`、`kind`、`rel_path`、`sha256` |
| `charters` | 任务章程（想法结构化结果） | `business_goal`、`success_criteria`（3 条可量化）、`budget_cents`、`deadline`、`initial_roles`、`approved_by` |
| `meetings` | 会议记录（§10） | `meeting_type`（review/debate/decision）、`participants`、`convergence_score`、`consensus`、`divergences` |
| `trust_scores` | 角色信任积分（§4.4） | `current`、`history_window`、`components`、**`pending_change_id`**（待 CEO 批准的调整建议） |
| `skill_mounts` | Skills 挂载记录（§14.3） | `skill_id`、`skill_version`、`source`、`honesty_boundaries`、`mounted_by`（只有 CEO 可挂载/卸载） |
| `harness_calls` | Harness 调用留痕（§12.7 第 4 层） | `harness` + `harness_version`、`args_redacted`、`session_id`、`exit_code`、`diff_sha256`、`cost_cents`、`verified_by_gate` |
| `im_bindings` / `im_tokens` | IM 身份绑定与一次性 token（§11.4） | `platform`、`external_user_id`、`verified`；`token`、`approval_id`、`expires_at`、`used` |
| `secrets` | 敏感凭证，**加密 at rest**，仅 Hub 层可读（§20.4） | `key`、`ciphertext` |
| `events_fts` | FTS5 虚拟表（替代 PG 全文索引） | 经触发器与 `events` 同步；支撑回放视图的全文检索 |

## 6.3 事件日志的完整性保证

- `events` 表通过 **SQLite 触发器**禁止 UPDATE / DELETE（`RAISE(ABORT, 'events table is append-only')`）。
- 每条事件携带 `state_snapshot`（决定时的完整任务状态 JSON），确保回放可还原任意时刻上下文。
- 事件写入在 LangGraph 每个节点状态变更后同步执行，**与 Checkpoint 同一事务提交**，防止崩溃时“状态已变更但事件丢失”。

## 6.4 文件制品的组织

```
~/.opc-os/artifacts/
  └── {task_id}/
        ├── prd/{bundle_id}.json          # 结构化需求清单
        ├── prd/{bundle_id}.md            # 可读 PRD
        ├── code_diff/{bundle_id}.patch
        ├── test_report/{bundle_id}.json
        └── content_package/{bundle_id}/
```

`evidence_bundles.artifacts` 存 JSON，每个制品形如：

```json
{ "type": "code_diff", "path": "artifacts/{task_id}/code_diff/{bundle_id}.patch", "sha256": "..." }
```

回放时按路径读文件，按 `sha256` 校验完整性。

## 6.5 并发、性能与备份

**并发处理**

| 场景 | 处理（Hub 为单一 Node 进程） |
|---|---|
| 多个 agent 并行产生事件 | Hub 内**单写队列**（`AsyncQueue` + 单个 writer task）串行化，应用层无并发写 |
| UI 侧查询（渲染进程 / 浏览器 / 移动端） | **一律经 Hub**（IPC / HTTP），不直连 SQLite；Hub 可用独立只读连接 |
| 心跳调度写入 vs 节点状态写入 | 同一写队列，按入队顺序执行 |
| 外部连接尝试绕过写队列直接写 | `busy_timeout=5000` 兜底；实测持锁时另一连接**等待 5573ms 后报 `database is locked`** → **不能指望 SQLite 自动排队**，必须走应用层队列 |
| 批量事件写 | **必须批量事务**：实测逐条自动提交约 2ms/条（`synchronous=NORMAL`），事务内 2000 条仅 5ms（≈40 万条/秒）。差 4 个数量级 → 单事务内提交“Checkpoint + events + 预算累计” |

**性能预期**：单条事件写入 < 1ms（**前提：置于事务内**，实测事务内 ≈ 40 万条/秒；若逐条自动提交则退化到约 2ms/条，见上表）；任务列表查询 < 5ms（万级）；FTS5 全文搜索 < 20ms（十万级事件）。库体积估算：每任务约 50–200 条事件、平均 2KB/条 → 一万任务约 2–4GB，SQLite 单库支持 TB 级，无压力。

**备份策略**：每日 `VACUUM INTO` 生成一致性快照（**实测可用**；注意 `node:sqlite` **不提供** `db.backup()` 在线备份 API，`VACUUM INTO` 是唯一可用路径）到 `~/.opc-os/backups/opc-{date}.db`，保留最近 7 份；岗位书变更、委派规则图变更前自动触发一次备份。**备份不替代审计** —— 备份是灾难恢复，审计回放依赖 `events` 表完整性，两者独立。

---

# 7. 任务流转状态机

## 7.1 状态枚举

```
CHARTER_PENDING
  → CHARTER_APPROVED
    → DECOMPOSING
      → IN_PROGRESS
        → EVIDENCE_SUBMITTED
          → IN_REVIEW
            → APPROVED_UPWARD        （进入下一层级，重复 IN_PROGRESS → APPROVED_UPWARD）
            → REJECTED_DOWNWARD      （打回上游）
            → MEETING_REQUIRED       （进入辩论会 / 决策会子图）
            → ESCALATED_TO_CEO       （升级到审批收件箱）
            → BUDGET_PAUSED          （预算硬停）
            → BLOCKED                （心跳追问中）
  → FINAL_REVIEW
    → DELIVERED
      → ARCHIVED
```

## 7.2 完整流转示例：“做 AI 笔记应用”从想法到上线

| 步骤 | 状态变化 | 界面表现 | CEO 操作 |
|---|---|---|---|
| 0. 想法提交 | → CHARTER_PENDING | 输入框变确认条：“已收到。助理将在 5 分钟内返回章程提案。” | 输入想法，提交 |
| 1. 章程提案 | CHARTER_PENDING | 审批收件箱出现章程卡片（业务目标 / 3 条可量化成功标准 / 预算上限 / 时间约束 / 建议初始团队角色） | 展开阅读，点击“批准章程”或“修改后批准” |
| 2. 章程批准 | → CHARTER_APPROVED → DECOMPOSING | 看板产品列出现新卡片；LangGraph 图初始化，产品总监被唤醒 | 无 |
| 3. 产品拆解 | → IN_PROGRESS → EVIDENCE_SUBMITTED → IN_REVIEW | 产品列卡片“PRD 完成，12 项需求，等待技术评审” | 无 |
| 4. 技术评审会 | → APPROVED_UPWARD（**有条件通过**：3 项需求标为 P2 进入后续迭代） | 产品列卡片变灰“已通过”，技术列出现新卡片“技术方案拆解中”；飞书群收到摘要卡片 | 无（飞书摘要不需回复） |
| 5. 技术拆解 + 架构评审 | 技术层内部循环（另一道评审门控） | 技术列卡片流转 | 无 |
| 6. 开发执行 | → IN_PROGRESS → EVIDENCE_SUBMITTED | 执行列出现卡片“开发完成，等待测试” | 无 |
| 7. 测试审阅 | → IN_REVIEW → APPROVED_UPWARD（**有条件通过**，覆盖率 92%、3 个 P2 缺陷） | 测试列卡片变绿“有条件通过” | 无 |
| 8. 升级 CEO | → ESCALATED_TO_CEO（“是否接受 P2 缺陷上线”属产品决策，超出技术层权限） | 审批收件箱出现**琥珀色**卡片 | 展开看缺陷清单，点击“批准上线，P2 缺陷进入下一迭代” |
| 9. 交付 | → FINAL_REVIEW → DELIVERED → ARCHIVED | 看板卡片变绿“已交付” | 无（可选：回放查看完整历程） |

**打回路径说明**：CEO 打回时输入的意见会作为约束写回 LangGraph 对应节点，任务沿边回退到上游重新处理。

## 7.3 心跳与停滞处理

- 系统按配置间隔（默认 15 分钟）检查所有活跃任务。
- 若任务在某节点停留超过阈值且无状态变更，触发**追问**：等待外部资源？未处理错误？审阅者未响应？
- 追问结果：自动恢复，或生成**“异常”卡片**进入审批收件箱（标记为“信息性”，非琥珀色决策卡）。
- 心跳逻辑绑定在 LangGraph 节点状态上（每次心跳保存完整状态快照，支持崩溃后断点恢复），而非独立外部调度器。

## 7.4 预算硬停

- 达到预算阈值时自动暂停执行。
- 审批收件箱出现**非琥珀色**的“预算暂停”卡片（这是运营事件，不是战略决策），显示：哪个 agent、哪个任务、已消耗 / 上限、暂停前最后动作。
- 按钮：**追加预算 / 维持暂停 / 终止任务**。
- 决策后 agent 从 Checkpoint 恢复。日消耗 vs 预算在今日视图的组织状态卡片中以简洁条形持续可见。

---

# 8. 审阅门控与证据包

> 本章是产品的**核心差异化**。

## 8.1 证据包（Evidence Bundle）：可验证的引用，不是“总结”

| 交接方向 | 证据包内容 |
|---|---|
| 产品 → 技术 | PRD 文档 + 需求条目清单（每条含描述 / 优先级 P0-P2 / 可测量验收标准 / 来源标记：“基于章程第 X 条”或“基于调研发现 Y”）+ 竞品或市场依据（条件性，来源可追溯）+ 产品总监逐条通过标记（标注“自检，非独立验证”） |
| 技术 → 开发 | 技术方案 + 工程任务列表（输入 / 输出 / 验收方式 / 风险等级）+ 架构决策记录（ADR，含备选方案与选择理由）+ 风险预判清单 + 架构师评审意见 |
| 开发 → 测试 | 代码 diff（`git diff` 获取，不依赖 harness 输出格式）+ 自测结果 + 根因报告（缺陷修复类）+“我认为已覆盖的边界条件”声明 + 未解决阻塞清单 |
| 测试 → 上报 | 测试报告 + 覆盖率 + 未通过项清单 + 复现用例（测试自己生成）+ 测试工程师**独立判定**（通过 / 不通过 / 有条件通过）+ 对抗性审查附录（高风险任务） |
| 运营 → CEO | 内容策略简报 + 平台适配版本 + 合规检查清单（逐项，非“没问题”）+ 发布计划 |

## 8.2 审阅门控的硬约束

1. **作者不给自己打分**：一个节点的产出不能由该节点自身的后续节点直接标记“通过”并向上移动，必须经过至少一个**独立审阅节点**。这是图结构上的硬约束，不是提示词约定。
2. **通过必须附可验证证据**：测试报告、diff 摘要、需求逐条对照、覆盖率数值 —— 而不是一句“通过”。
3. **默认行为**：上游产出进入下游审阅者队列，下游审阅者必须在**查看证据包后**做出显式决定（通过 / 打回 / 升级）。
4. **不可绕过**：门控配置绑定在委派规则图的边上，不可在运行时被 Agent 绕过。
5. **门控是确定性代码**：门控验证逻辑检查覆盖率数值、证据包字段完整性、“作者不给自己打分”的图结构约束 —— 不依赖 LLM 判断，因此可用传统单元测试覆盖（见 §24 风险 5）。

## 8.3 升级路由触发条件

- 层级审阅 N 轮（默认 3 轮）未达成一致
- 触及预算硬停
- 涉及不可逆外部动作（付款、对外发送、删除数据、生产部署）
- 总监层主动标记“战略不确定性”

升级路由的目标：**CEO 看到的每一件事都是真正需要 CEO 的事**。

---

# 9. 审批层与策略引擎

> 这是 CEO 与系统之间的接口。北极星指标（源自 Railse OPC）：**用一周后，八成以上审批由规则自动决定。**

## 9.1 策略引擎三级分类

| 级别 | 行为 | 示例 |
|---|---|---|
| **自动放行** | 只读操作、项目内可逆改动 | 读取文件、运行测试、创建分支 |
| **模式自动通过** | 历史决策模式一致且可逆 | 过去 10 次类似决策均批准且该决策可逆 → 自动通过并记录“基于模式的自动批准” |
| **必须人工** | 不可逆操作、外部副作用、预算阈值突破 | git push 到 main、对外发送、付款、删除数据 |

“模式自动通过”的决策在**日报中可见且可追溯**，但不打扰 CEO。

## 9.2 审批卡片结构（三行固定 + 三按钮）

- **第一行：一行决策摘要**
  例：“开发完成支付模块，测试覆盖率 92%，技术总监标记‘有条件通过’，等待确认是否接受剩余 3 个 P2 缺陷上线。”
- **第二行：关键参数快照**
  金额（如有）/ 影响范围 / 不可逆性标记（可逆 · 不可逆）/ 推荐动作及理由（由总监层生成，**明确标注“推荐，非决定”**）/ 超时行为。
- **第三行：证据链接**
  点击展开完整证据包 —— 测试报告、缺陷清单、代码 diff 摘要。
- **操作按钮（只有三个）**：**批准 / 打回并附意见 / 标记为稍后深度审阅**。

## 9.3 超时行为

| 值 | 语义 | 适用 |
|---|---|---|
| `auto_approve` | N 小时未处理默认通过 | 仅限可逆事项 |
| `auto_reject` | N 小时未处理默认打回 | 涉及上线、对外发布等 |
| `escalate` | N 小时未处理升级到更深审阅流程 | 辩论会 / 决策会前置 |

## 9.4 批量操作

支持批量批准 / 批量打回，但**仅限同类型、同方向**的审批，且一次批量操作写入一条审计事件。

---

# 10. 会议机制

> 会议不是自由群聊，是**有状态、有议程、有产出、有门控的结构化事件**。会议不改变任务所在的主 LangGraph 图，会议结论作为**约束注入**任务的下一状态，不产生新的任务状态机。

## 10.1 三种会议类型

### 类型 A：评审会（固定触发，每个任务必经）

| 项 | 内容 |
|---|---|
| 触发 | 一个层级产出证据包后、进入下一层级之前 |
| 参与者 | 产出者、下一层级审阅者、相关同级（如产品方案评审时技术总监列席） |
| 议程（固定） | 产出者陈述证据包（5 分钟模拟时间）→ 审阅者逐条验证验收标准 → 同级提跨职能风险 → 主持人（通常是下一层审阅者）给出决定 |
| 决定 | 通过 / 打回 / 有条件通过 |
| 产出 | 审阅决定 + 条件清单，写入门控状态 |
| 实现 | **不需要额外框架** —— 它是 LangGraph 图上的多节点汇聚点，审阅门控本身就是“决议记录” |

### 类型 B：辩论会（条件触发，用于冲突裁决）

| 项 | 内容 |
|---|---|
| 触发 | 层级审阅 N 轮未达成一致；或两个总监对同一决策持相反意见 |
| 参与者 | 冲突双方 + **中立裁决者 Agent**（助理层或专门配置的“裁决者”角色，**不挂载任何人名 skill**） |
| 机制 | 参考 agent-roundtable 的顺序发言 + 共识/分歧追踪，或 Swarms GroupChat 的**竞价发言** —— 每个 agent 私下出价 0–1 的发言意愿分，最高且超阈值者获发言权，`recency_penalty` 防连续发言 |
| 产出 | 收敛度评分 + 共识点 / 分歧点清单 |
| 未收敛 | 收敛度低于阈值 → **自动升级到 CEO 审批收件箱** |
| 实现 | 作为 LangGraph 节点内部的**子图**运行，输出收敛结果后返回主图 |

### 类型 C：决策会（CEO 参与，用于战略拍板）

| 项 | 内容 |
|---|---|
| 触发 | 辩论会未收敛；或总监层标记“战略不确定性” |
| 参与者 | CEO + 相关总监 + 助理（记录和呈报） |
| 形式 | 桌面端结构化会议视图 = **异步文档流**：左侧议程与已提交证据包摘要，右侧各方立场摘要与推荐选项 |
| CEO 参与方式 | **不需要实时“参会”**，在方便时阅读立场摘要、选择选项或给出新指令 |
| 效力 | CEO 决策作为**最高优先级约束**注入图，辩论会结束 |

## 10.2 去偏机制（辩论会子图必须包含）

1. **独立裁决者角色**（不挂载任何人名 skill）；
2. **发言权轮转规则**；
3. **对“坚持度”的显式约束** —— 防止人格对抗演变为死循环；
4. **收敛度评分** —— 低于阈值自动升级，不无限辩论。

依据：AAAI 2026 研究指出 LLM 多 Agent 系统中的人格分配会引入**信任度偏差**与**坚持度偏差**，并存在显著的**内群体偏好**（更倾向顺从与自己人格相同的 Agent），且这些偏见在不同模型、群组规模、交互轮数下持续存在。因此**不能假设“把几个名人脑子放进群里就会高质量争论”**。

## 10.3 会议与 IM 联动

会议**结构化摘要**（不是原始聊天记录）推送到飞书群。摘要采用**三层折叠**：一行结论 + 关键分歧点 + 完整会议记录链接。CEO 在群里回复“同意”或“复议”，消息被解析为会议决策事件。会议记录永久存储，可在回放视图中作为任务时间线的一个节点展开。

## 10.4 会议的实时性取舍

评审会可以是**异步的**（各方在各自时间提交立场，主持人汇总决定）；辩论会可以是**回合制的**（不需要实时流式对话）。真正需要“实时”的只有 CEO 参与的决策会，而决策会也可以设计为异步文档流。**不要追求让所有 agent 实时流式开会** —— 那会制造大量不需要阅读的噪音。会议的价值在于**结构化产出**，不在于“热闹”。

---

# 11. IM 接入层

## 11.1 定位

IM 是**第二前端**：通知通道 + 审批终端 + 会议旁听席。桌面端与移动端仍是主工作台。IM 解决的是“你不在电脑前、不想打开 app 时，如何让公司找到你”。

## 11.2 平台优先级与能力边界

| 平台 | 接入方式 | 角色 | 限制与现实 |
|---|---|---|---|
| **飞书** | 企业自建应用 + **“使用长连接接收事件”**（无需公网 IP / 回调地址），订阅 `im.message.receive_v1`，开通“读取用户发给机器人的单聊消息”“接收群聊中 @机器人消息”“以应用身份发消息”权限；官方 Channel SDK 自动处理事件解析、去重、流式卡片回复与卡片按钮回调 | **首选审批通道** | 需企业自建应用审核 |
| **企业微信** | 自建应用 API 收发应用消息 | 次选通道 | “安全不封号”；若协作网络不在企微中可暂不接入 |
| **QQ** | **官方 Bot API**（开放平台注册开发者、创建机器人、取 AppID/AppSecret，支持 WebSocket 与 WebHook；个人认证开发者可创建 5 个机器人） | **只读查询通道**（@机器人查状态） | 群聊能力需审核开通；**以被动回复为主、主动消息有条数限制** → 不适合作审批主通道。不走社区 OneBot 路线（go-cqhttp 已停止维护，NapCat 等有风控风险） |
| **个人微信** | **不接入** | — | 协议逆向类方案有封号风险，不纳入设计 |

**飞书的具体用法**：审批卡片以**飞书消息卡片**推送到 CEO 私聊或指定“CEO 决策群”，卡片直接带按钮“批准 / 打回 / 稍后”；点击回调经长连接送回 Hub，审批状态同步到桌面端与移动端。会议“旁听”也走飞书群。

## 11.3 Channel 抽象层

**不要为每个 IM 平台写独立业务逻辑。** 一个 Channel 抽象层：

- 入站消息归一化为 `NormalizedMessage`：`平台 / 发送者 / 会话ID / 文本 / 是否@机器人 / 消息类型`
- 出站审批卡片归一化为 `ApprovalCard`，各平台适配器负责渲染成飞书卡片、QQ Ark 消息或企微应用消息
- 业务逻辑只面对归一化消息与事件，不感知平台差异（参考 OpenClaw 的“把多平台抽象为标准化通道，统一策略全局生效”）

## 11.4 安全约束

- IM 审批操作必须经**签名验证 + 一次性 token**（飞书卡片回调携带签名，Hub 验证后才处理审批决策）。
- **不可逆操作的审批禁止在 IM 中完成** —— IM 只处理可逆的、有超时默认行为的审批；不可逆操作强制在桌面端或移动端（有二次确认）完成。

## 11.5 通道优先级建议

**飞书优先 → 企业微信次之 → QQ 作只读查询 → 个人微信不接入。** 若协作网络完全不在飞书，可把移动端 PWA 作为审批主通道，IM 只做通知。

---

# 12. 程序员与测试 Agent（Coding Harness Gateway）

> 架构结论：OPC-OS **不自己“造”一个程序员，而是做一个“调度器”**。各家 harness 几乎全部提供**非交互（Headless）模式**或程序化 SDK，可被外部系统精确调用、约束、编排。OPC-OS 的程序员与测试 Agent 是这些 harness 之上的**策略层**，不是替代它们的执行层。

## 12.1 统一接入层：Gateway 接口

> **接入方式：进程内调用官方 SDK，不解析 CLI 输出。** 三家 harness 都有官方 TypeScript SDK（`@anthropic-ai/claude-agent-sdk` 0.3.318 / `@openai/codex-sdk` 0.167.0 / `@qoder-ai/qoder-agent-sdk` 1.0.59，npm registry 核对 2026-11-06）。**CLI 命令行是兜底路径**，仅用于 SDK 未覆盖的能力，或需要独立进程隔离的实验性任务。
>
> 为什么这样定：① **类型化** —— 审批回调（`canUseTool`）与用量报告（`CostReport`）不必从 JSON 流里猜字段，字段漂移在编译期就暴露；② **不需要 JSON 解析框架**，也没有"stdout 半行 / 交错日志"这类流解析故障模式；③ **审批转交宿主是回调而非字符串匹配** —— Qoder SDK 本身构建在 `@modelcontextprotocol/sdk` 之上，§12.7 第三层的「高风险工具调用暂停并推到审批队列」直接落在 SDK 回调点上。把审批建立在解析文本流上，等于把安全边界建在最脆弱的接口上。

业务逻辑（谁在什么条件下调用哪个 harness）不直接碰命令行或 SDK，只面对 Gateway。每个适配器实现：

```ts
execute(task_spec, workspace, policy) → ExecutionResult
resume(session_id, followup)          → ExecutionResult
get_cost(session_id)                  → CostReport
```

`ExecutionResult` 统一包含：最终输出、`session_id`（用于恢复）、退出码、结构化证据（若 harness 支持）、消耗报告。于是岗位书里写的是“当任务满足条件 X 时，以策略 Y 调用 harness Z”，而不是硬编码命令行。

**接入判据（三件套）**：是否提供 **非交互 + 可审批 + 可恢复** —— 缺任何一件，都不能作为 OPC-OS 的生产级执行单元。

## 12.2 一期接入（3 家）

| Harness | **TS SDK（首选）** | 非交互 CLI（兜底） | 审批 / 权限控制 | 会话与恢复 | 结构化输出 | 角色 |
|---|---|---|---|---|---|---|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` **0.3.318**（零依赖；按平台 optionalDependencies 分发预编译二进制 → **不是 node-gyp addon**） | `claude -p "..." --bare` | SDK 的 `canUseTool` 回调（**优先用它**，不用 `--allowedTools` 字符串匹配）；`maxBudgetUsd` 硬顶 | 支持（`--resume` / SDK session） | `--output-format json` | **主力开发 / 测试执行器**，生态最成熟 |
| **Codex CLI** | `@openai/codex-sdk` **0.167.0**（依赖同版本 `@openai/codex` 二进制） | `codex exec "..."` | 沙箱（read-only / workspace-write / danger）× 审批策略（never / on-request）**双轴** | 支持（`--ephemeral` 可禁用持久化） | `--json` + `--output-schema`（**结构化能力最强**，适合直接喂证据包） | **主力开发执行器**，沙箱模型最严谨 |
| **Qoder CLI** | `@qoder-ai/qoder-agent-sdk` **1.0.59**（**本身构建在 `@modelcontextprotocol/sdk` 之上** → 与 §5.11 的 MCP 选型同构；含 postinstall 脚本，安装时注意 CI 缓存） | `qodercli -p "..."` | `--permission-mode`（accept_edits / bypass_permissions）；stream-json 下审批请求**转交宿主程序决策** | 支持（`--session-id`） | text / json / stream-json | **可编程审批的理想候选**，与门控哲学天然对齐 |

## 12.3 二期 / 按需接入

| Harness | 角色 | 关键限制 |
|---|---|---|
| Kimi Code | 快速原型 / 低风险任务 | Print 模式隐式启用 `--afk`，**自动批准所有工具调用**，无审批回调 → OPC-OS 外层须拦截不可逆操作（例如禁止在 `main` 分支自动写入） |
| DeepSeek Harness（dsh） | 实验性 / 成本敏感任务 | 官方明示 **developer preview，存在破坏性变更** → **不可承担有交付时限的任务**，不能作为唯一依赖 |
| CodeGeeX CLI | 补充性轻量任务 | 审批控制信息有限，需自行验证 |
| Gemini CLI | 可选执行器 | Policy Engine（TOML：allow / deny / ask_user）；有 checkpointing / rewind |
| OpenCode | 常驻开发环境 | `run` 模式自动批准所有工具；`serve` 模式可接 MCP 审批桥 |

**反过度抽象原则**（SDK 化之后更重要）：一期**不要做“harness 无关的统一层”的过度抽象**。三家 SDK 的能力面并不对称（Claude SDK 有 `canUseTool` 与 `maxBudgetUsd`，Codex 强在沙箱双轴，Qoder 强在审批转交宿主），强行取交集会让每个适配器为兼容而牺牲原生能力。做法：适配器**内部**各用各家 SDK 的原生能力，**外部**只暴露 `execute` / `resume` / `get_cost` 三个方法，能力差异通过 `policy` 参数的**可选字段**表达，不做最小公分母抽象。
>
> 另注：三家 SDK 均按平台分发预编译二进制（optionalDependencies 形式），**不是 node-gyp 原生 addon** → 与 §5.6 讨论的“唯一原生依赖”问题无关，不会引入 Electron ABI 麻烦。

## 12.4 程序员 Agent 的任务路由

输入 = 技术总监拆解后的工程任务，附带任务类型（功能实现 / 缺陷修复 / 重构）、影响范围（文件列表 / 模块）、验收标准（测试要求）、风险等级（架构师评审时标记）。

| 任务类型 | 默认 Harness | 沙箱 / 审批策略 | 产出证据 |
|---|---|---|---|
| 新功能实现 | Claude Code 或 Codex CLI | `workspace-write` + 审批 `never`，但 **diff 必须经测试门控** | 代码 diff、自测记录、未解决阻塞清单 |
| 缺陷修复（P1 / P2） | Codex CLI | 先 `read-only` 分析根因，再 `workspace-write` 修复 | 根因分析、diff、回归测试结果 |
| 重构 / 技术债 | Claude Code | `workspace-write`，要求 harness 在**独立分支**运行，不直接改主干 | 重构前后对比、行为等价性证据 |
| 实验性 / 低风险 | Kimi Code | 自动批准，但**外层必须拦截不可逆操作** | 最终输出 + session 记录 |

## 12.5 程序员 Agent 调用流程（缺陷修复示例）

1. **预检**：工作区是否干净（`git status`）、目标文件是否存在、是否有未合并冲突分支。**预检失败直接打回技术总监，不调用 harness。**
2. **分析（只读）**：
   `codex exec -C /repo --sandbox read-only --ask-for-approval never "分析{bug}的根因，输出根因假设和修复建议，不修改文件"`
   → 产出根因分析报告。程序员 Agent **不自行判断根因是否正确**，报告作为证据包交测试 Agent 独立验证。
3. **根因验证**：测试 Agent 独立构造复现用例。**无法复现 → 打回根因报告。**
4. **修复（受限写入）**：
   `codex exec -C /repo --sandbox workspace-write --ask-for-approval never "根据根因报告修复{bug}，运行相关测试，记录未解决阻塞"`
   Claude Code 等价：`claude -p "..." --allowedTools "Read,Edit,Bash" --bare`
5. **证据包组装**：`git diff` 的 diff + 自测结果 + 根因报告 + 未解决阻塞清单 → 提交测试门控。
6. **关键约束**：**程序员 Agent 不能自己标记“完成”**，产出必须经测试 Agent 独立审阅才能向上移动。

**会话恢复与成本控制**：Gateway 为每次调用记录 `session_id`（Claude Code `--resume`、Codex session 机制、Qoder `--session-id`），打回时恢复上下文而非从零开始。成本通过 harness 自身预算参数实现（Claude Code Agent SDK 支持 `maxBudgetUsd` 硬顶，Codex 可配 `--max-turns` 或外部成本监控）。Gateway 调用前检查当前任务与角色剩余预算，超限则拒绝调用并触发预算暂停。

## 12.6 测试 Agent 的三项核心职责

1. **复现验证（修复之前）**：独立构造复现用例；无法复现 → 打回根因报告。复现用例本身是证据包的一部分。
2. **修复后独立验证**：**不阅读程序员的“自测通过”声明作为判断依据**，独立运行测试。可在隔离工作区调用独立 harness 实例：
   `claude -p "在 /tmp/test-workspace 运行完整测试套件，输出覆盖率报告和未通过项清单" --allowedTools "Read,Bash" --bare`
   岗位书硬约束：**覆盖率 < 90% 不得标记通过**；**P0 缺陷不得自行放行，必须升级到技术总监**。
3. **对抗性测试（高风险任务）**：调用**第二个独立 harness（与开发用的不同模型家族）** 做对抗性审查：
   `codex exec --sandbox read-only --ask-for-approval never "审查{repo}以下改动，寻找边界条件缺失、并发问题、错误处理漏洞：{diff}"`
   输出作为测试报告**附录**，不直接决定通过 / 不通过，但作为升级到 CEO 时的证据。

**“不可信输入”原则**：测试 Agent 的调用参数中**禁止把程序员 Agent 的“自测通过”文本作为可信输入**。它只接受 diff（客观产物）、自己生成的复现用例、测试套件的客观输出。若程序员的证据包写了“我已覆盖所有边界条件”，测试 Agent 岗位书要求它**忽略该文本**，转而用自己的测试用例去验证。这是“作者绝不给自己打分”在 harness 调用层面的具体实现。

## 12.7 四层安全防护（与 harness 原生权限叠加）

> OPC-OS 不在 Gateway 里重建一套权限系统，而是**利用 harness 原生权限机制，在外层叠加 OPC-OS 的审阅门控**。

| 层 | 内容 |
|---|---|
| **1 harness 原生沙箱** | Gateway 为每个角色**预设不可覆盖的 harness 参数**。程序员 Agent 默认禁止 `--yolo`（Codex）/ `bypass_permissions`（Qoder），除非任务标记“实验性”且工作区 disposable。Claude Code 的 `--bare` 是脚本化场景推荐选择，需显式设 `ANTHROPIC_API_KEY` 并用 `--allowedTools` 精确限定工具集 |
| **2 OPC-OS 审阅门控（不可绕过）** | 无论 harness 返回什么，程序员产出**不能直接进入“已交付”状态**，必须经测试 Agent 独立门控；测试 Agent 的“通过”本身也须附可验证证据 |
| **3 HITL 例外路由** | 仅以下情况升级 CEO：测试发现 P0 缺陷且 N 轮内无法修复；开发与测试对同一变更判定持续冲突；任务触及**不可逆操作**（生产部署、数据库迁移、对外 API 发布）。**常规代码审查不是 CEO 的事** —— 由测试 Agent 与架构师评审完成。Qoder 的 stream-json 在此特别有价值：把待审批权限请求转交宿主（OPC-OS Gateway）决策，实现“开发后台跑，高风险工具调用暂停并推到审批队列” |
| **4 审计留痕** | 每次 harness 调用记录：harness 名称与版本、脱敏参数、`session_id`、退出码、消耗、**diff 哈希**、测试验证结果。回放可还原“当时用的哪个模型、哪个 harness、什么参数、谁批准了什么” |

## 12.8 核心风险：自动批准模式与门控哲学的冲突

Kimi Code 的 Print 模式、Qoder 的 `--yolo`、Codex 的 `--full-auto` 本质都是**移除人类与上层系统的审批介入**。OPC-OS 的选择：

> **在开发和测试的内部循环中允许 harness 自主执行**（否则效率无从谈起），但**在向上交接的边界上强制门控**。
> harness 的自主性是“**车间内的自主**”，不是“**跨车间的自由通行**”。

**一句话职责定义**：程序员 Agent = 任务路由器 + Gateway 调用者 + 证据包组装器；测试 Agent = 独立验证者 + 复现构造者 + 门控守门人。OPC-OS 的价值不在“能调用它们”，而在**在其之上强制实施“作者不给自己打分、证据不可绕过、例外才找 CEO”的组织规则**。若只是把多个 harness 接进来让它们自由跑，你得到的是一堆更快的执行器，不是一个可以放心当 CEO 的公司。

---

# 13. 产品经理与技术总监 Agent

> 这两个角色**必须是“立场对立”的制衡结构**，而不是顺次传递的流水线。一个负责“业务上必须做”，一个负责“工程上能不能做、代价是什么”，两者冲突须在升级到 CEO 之前被结构化地暴露。联网搜索不是“要不要”，而是**按角色、按任务、按知识边界分层的条件性行为** —— 过度搜索浪费预算并引入噪音，完全不搜索则会在快速变化的领域产生幻觉。

## 13.1 产品经理 Agent：业务立场的“必要论”持有者

**输入**：CEO 批准的任务章程（charter）。**输出**：可供技术侧评审的证据包 —— 不是一段流畅的 PRD 文本，而是一组**可逐条验证的结构化需求**，每条附来源、优先级、验收标准。

**Step 1 知识边界判断与条件性调研**
起草任何内容之前先做显式的**知识边界检查**：“当前任务所需信息在我的参数化知识中是否足够稳定和充分”。

- *触发调研*：领域涉及快速变化的市场 / 竞品 / 技术趋势；章程中的成功标准需外部基准量化（如“月收入 100 万”需知同类产品定价与转化率）；涉及不熟悉的新赛道。
- *不触发*：稳定的通用需求（如“增加一个登录页面”）；章程本身已给出足够具体的约束；调研成本预计超过任务预算某比例。

调研采用**并行研究子图**，而非单线程“搜一下想一想”：Planner 拆解调研子任务 → Search 并行检索竞品 / 用户评论 / 功能信息 → Review 聚类痛点与机会点 → Writer 汇总为结构化输入。产品经理是**研究协调者**，不是搜索引擎调用者。

**Step 2 PRD 证据包组装**：需求条目清单（描述 / P0-P2 优先级 / 可测量验收标准 / 来源标记）+ 竞品与市场依据（条件性，来源**可追溯**，不能是“根据我的了解”）+ 自检标记（标注“自检，非独立验证”）。

**Step 3 交接时的立场声明**：“确保方案满足业务需求，不接受任何‘技术上难做’的借口。” 这不是人格表演，而是**在审阅门控中作为约束注入** —— 技术总监不能以“实现复杂”为由直接打回需求，必须给出具体工程代价评估并说明哪些需求在给定约束下确实不可行。产品经理有权反驳，反驳进入辩论会流程。

**行为边界**：**不做技术方案设计、不评估实现成本、不替技术总监做取舍。** 产出若包含“建议用 XX 技术栈”，门控应打回 —— 那是越界。职责边界是定义“**做什么**”和“**什么叫做完了**”，不是“怎么做”。

## 13.2 技术总监 Agent：工程立场的“可行性”与“代价”评估者

角色定位参考 P10 CTO 协议：**定战略**（技术栈选型、架构范式、项目边界、风险预判）、**造土壤**（质量门禁、工具链、记忆系统）、**断事用人**（冲突裁决、资源取舍）。

**Step 1 PRD 工程可行性审阅（门控 1）** —— 逐条判定：

| 判定 | 含义 | 必须附带 |
|---|---|---|
| **可行** | 现有栈与约束下可实现 | 预估复杂度 S / M / L |
| **有条件可行** | 需引入新依赖、改架构假设或显著加成本 | **具体代价说明**（如“需引入消息队列，增加约 3 个工程日”） |
| **不可行 / 高风险** | 给定约束下不可行 | **不可行的技术依据**（不是“难做”，而是“在 X 约束下会导致 Y 问题”） |

判定结果写入证据包，与审阅意见一起决定任务是有条件流转还是触发辩论。

**Step 2 技术拆解与架构决策**：工程任务列表（输入 = 依赖哪个需求条目 / 输出 = 交付什么 / 验收方式 = 测试要求 / 风险等级）+ **架构决策记录（ADR）**（凡涉及技术选型、接口设计、数据模型变更的决策必须附**备选方案及选择理由** —— 这是“作者不给自己打分”在技术层的体现，架构师后续独立评审，技术总监不能以“最终决定”姿态绕过）+ **风险预判清单**（技术 / 资源 / 时间风险，每条附缓解策略）。

**Step 3 条件性联网搜索**：技术总监搜的不是“市场和用户”，而是**“这个技术方案在当前时点的真实状态”**。

- *触发*：涉及快速演进的技术栈（框架版本兼容性、API 废弃计划、新版本行为变更）；需验证某架构模式在特定规模下的已知问题；需获取特定库 / 工具的最新安全公告或性能基准。
- *不触发*：参数化知识内稳定的教科书级工程原则（如“数据库索引的基本原理”）；搜索成本与决策影响不成比例。
- 搜索更**精确、以验证为导向**：不是“调研一下微服务”，而是“验证 X 框架在 Y 版本下是否仍支持 Z 特性”。搜索结果作为 **ADR 的支撑证据**附加，而不是作为决策本身。若结果显示关键依赖即将废弃 → **触发风险升级**，而非让技术总监“自己决定换个方案”（换方案涉及产品边界，需回到产品经理或升级 CEO）。

**Step 4 交接与升级**：技术拆解完成后，把证据包（PRD 审阅判定 + 工程任务列表 + ADR + 风险清单）提交架构师做独立技术评审。若架构师发现重大技术风险、或与产品经理立场冲突无法在总监层解决 → 标记 `MEETING_REQUIRED` 进入辩论会；未收敛则升级 CEO。

**立场声明**（与产品经理对立）：“确保方案可落地：评估并发、数据一致性、回滚能力，对‘拍脑袋方案’零容忍。” 这不是为了吵架，而是**在门控中强制暴露工程代价**，防止需求在无代价评估的情况下直接进入执行层。

**行为边界**：不以“实现复杂”为由直接打回需求，必须给出具体工程代价。技术选型涉及产品边界时须回到产品经理或升级 CEO。

## 13.3 联网搜索的三层策略（非全局开关）

| 层级 | 触发条件 | 行为 |
|---|---|---|
| **1 强制搜索** | 任务涉及明确标注“快速变化”的领域（竞品动态 / 框架版本 / 定价基准 / 安全公告） | 搜索是**门控的必要条件**：该领域证据包无来源引用 → **门控直接打回** |
| **2 条件搜索** | Agent 显式判断“参数化知识不足” | 输出**搜索必要性判断 + 理由**，可审计（AdaSearch 的核心洞察：**让 Agent 显式决定是否搜索**，不默认搜索也不默认不搜索，决策过程本身可审计） |
| **3 预算降级** | 搜索成本达任务预算比例阈值 | Gateway 强制降级：后续搜索请求需技术总监或 CEO 审批（取决于金额），防止在低价值调研上耗尽预算 |

**挂载方式**：Gateway 不为每个 harness 单独实现搜索。**搜索作为 MCP 工具挂载到需要它的 Agent 上**，MCP Client 用 `@modelcontextprotocol/sdk`（1.32.2），搜索类 MCP Server **一律写成 Node 包**，与 Hub 同栈、同进程池管理、同一套权限授予逻辑。由岗位书决定是否授予该权限。产品经理与技术总监默认工具集含搜索，但受上述三层策略约束。（Claude Code 内置 WebSearch，在 Anthropic 第一方 API 下无需外部密钥；Codex 等可经 MCP 接入搜索。）

## 13.4 关键取舍：调研子图 vs 单 Agent 搜索循环

产品经理的调研**不应是一个 Agent 在 ReAct 循环里反复“搜索-阅读-再搜索”** —— 单 Agent 搜索循环易陷入“上下文溢出、重复调用、被恶意页面注入”等失败模式。稳健设计是**调研子图**：主流程中的产品经理只负责“发起调研请求”与“消费调研结果”，搜索、抓取、筛选、聚类由并行子 Agent 完成，返回**结构化调研摘要与来源引用**，而非原始网页文本。

技术总监的搜索更轻量：通常只需**验证型搜索循环**（针对具体技术问题做 1–3 轮定向检索）。强制给技术总监套调研子图是过度设计，浪费预算并延迟决策。

## 13.5 门控关系总结

产品 ↔ 技术交接门控的核心，**不是“PRD 写得好不好”，而是“工程代价是否被显式暴露、业务必要性是否被技术合理性检验”**。产品经理的证据包必须让技术总监能逐条做工程判定；技术总监的判定必须附具体代价或不可行依据。冲突无法在总监层收敛时，辩论会结构化记录共识点与分歧点，**只有真正无法收敛的分歧才升级到 CEO 面前**。联网搜索的定位是：**让“必要论”和“可行性论”都建立在可追溯的事实基础上**，而不是模型参数中的过时记忆或幻觉 —— 不是越多越好，而是在被证明必要时才调用，且结果必须进入证据包、可审计、受预算约束。

---

# 14. Skills 集成层（角色蒸馏）

## 14.1 背景问题

能否用“女娲.skill”这类角色蒸馏工具，设立“乔布斯 skill 产品总监 + 多个产品经理（雷军 / 李想 / 余承东 skill）”？

**答案**：在“工具复用”层面成立，在“组织设计”层面会误导。skills 可以成为角色 Agent 的**认知输入**，但如果把它等同于“我雇了一个乔布斯当产品总监”，就会跳过 OPC-OS 真正需要解决的问题：**制衡、证据、以及谁为判断负责**。

## 14.2 定位：Skills 是认知输入层，不是组织角色层

> **角色 Agent = 岗位书（CEO 写的：职责边界 / 验收标准 / 权限） + 认知 skill（可替换：心智模型 / 决策启发式） + 证据责任（不可绕过：可验证引用）**

- 女娲.skill 等工具提炼的 SKILL.md（**3–7 个心智模型、5–10 条决策启发式、表达 DNA、反模式、诚实边界**）作为角色 Agent 的认知框架输入挂载。它输出的不是“乔布斯会喜欢这个设计”，而是“按聚焦原则，这个产品有 14 个功能，其中 11 个应该被砍掉，理由如下”—— 这是**可被审阅、可被反驳的结构化判断**，正好符合证据包要求。
- **可替换**：今天给产品经理挂雷军 skill，明天换李想 skill；但岗位书里“不接受‘技术上难做’的借口”“PRD 必须逐条附带来源”这些约束**不随 skill 变化**。
- **证据责任不可绕过**：无论 skill 输出多有说服力，都必须附来源引用与自检标记，进入审阅门控。
- 女娲智库（nvwaskills）的**群聊模式**（内置 14 位专家，多位专家在同一聊天流中按顺序发言、可支持或反对）可作为**辩论会子图的实现参考**。

**精确表述**：“乔布斯做产品总监”= 产品总监 Agent 的认知输入层挂载了乔布斯 skill。它用乔布斯的框架审视需求，但它不是乔布斯，不能替代技术总监的可行性制衡，也不能替代 CEO 的最终拍板。**skills 让角色“想得更好”，但不让角色“拥有权力”。**

## 14.3 Skills 在 TypeScript 侧的实现

Skills 是 **Node 侧可直接加载的资产** —— 与 Hub 同一运行时、同一包管理、同一套权限授予逻辑，不存在第二套 skill 加载机制。

| 关注点 | 方案 |
|---|---|
| 资产格式 | 沿用 SKILL.md：**YAML frontmatter（元数据：id / version / source / honesty_boundaries / model_tier_hint）+ Markdown 正文（心智模型、决策启发式、表达 DNA、反模式、诚实边界）** |
| 解析 | `gray-matter`（4.0.3）做 frontmatter 拆分；正文用 Markdown AST（remark）取出“心智模型 / 决策启发式”分节，**结构化挂载而非整段塞 prompt** |
| 校验 | zod 4 schema：缺 `honesty_boundaries` 或 `version` 的 skill **拒绝加载**并产生审计事件（对应 §14.4 红线二） |
| 存储 | `~/.opc-os/skills/{skill_id}/{version}/SKILL.md`；Hub 内 `SkillRegistry` 维护挂载关系（写 `skill_mounts` 表，附录 C） |
| 注入点 | 在**角色 Agent 节点的系统提示组装阶段**注入，注入内容标注 `skill_id@` —— 使 §22.3 的回放标注可直接从审计事件反查 |
| 可替换性 | 挂载关系是**版本化的一等记录**，切换 skill = 写一条新 `skill_mounts` 行（`mounted_to` 关闭旧行），岗位书不动（§14.2） |
| Skills 群聊（§14.2 参考的“女娲智库群聊模式”） | 作为 §10.2 辩论会子图的一种实现：**多个 skill 实例 = 同一 Node 进程内的多个子图节点**，无需任何跨语言胶水 |

**明确不做**：不在 v1.0 提供“运行时从远端下载并执行第三方 skill 代码”。SKILL.md 是**数据**；若未来允许 skill 附带可执行逻辑，那将是一个独立的插件系统与安全设计课题（届时走 MCP 边车，不进主进程）。

## 14.4 三条红线

1. **skills 角色只产出“建议”和“判断”，不产出“最终拍板”。** skill 蒸馏的是认知框架与表达模式，不包含组织权威、后果承担、以及真实决策中的胆识与直觉（“乔布斯最核心的能力之一是把工程师骂哭之后工程师还愿意加班；巴菲特的投资哲学一张 A4 纸写得完，但你缺的不是他的框架，是别人都在割肉时你敢满仓的那个胆”）。最终责任归属是 CEO。**skills 是认知杠杆，不是责任主体。**
2. **审计层必须记录每个角色 skill 的版本、来源与置信边界**，回放视图标注“该判断由蒸馏 skill X 生成，不属于经过验证的组织知识”。追责链条上不会有一个叫“雷军”的 Agent。
3. **辩论会子图必须包含去偏机制**（独立裁决者、发言权轮转、坚持度约束，见 §10.2），不假设“名人脑子放进群聊就会高质量争论”。

## 14.5 验证该设计的测试用例

不是“乔布斯 skill 和雷军 skill 辩论谁赢”，而是：

> 当乔布斯 skill 说“这个功能必须砍”、技术总监 Agent 说“砍掉会导致架构耦合”、而章程里写了“本季度必须上线”时，系统能否在**不崩溃**的情况下，把三方的依据**结构化地呈交给 CEO**，并让 CEO 在 **5 分钟内**做出一个**可审计**的决定。

通过 → skills 的角色定位是对的；不通过 → 说明把“名人脑子”误当成了“组织制衡”。

---

# 15. 运营岗位子组织

## 15.1 定位

运营**不是一个“全能账号操作员”**，而是一个**被审阅门控串联的微缩内容组织**。设计原则：**AI 做“流程的执行者”，而不是“账号的接管者”。**

## 15.2 “直接接管”平台的真实边界

“能发”和“能接管”是两回事，三个平台性质完全不同：

| 平台 | 现实 | 结论 |
|---|---|---|
| **B 站** | 唯一“脚本友好”的平台：接口签名风控最弱，社区有成熟开源投稿工具（如 biliup-rs） | **可靠自动化的试验田** |
| **抖音** | 官方“代替用户发布内容”能力的申请条件极苛刻：开发者主体需为**党政机关或事业单位**，只能做内部多媒体管理平台，**商业矩阵团队与工作室不在范围内**；市面大量工具走浏览器自动化或逆向 | **不作为全自动接管目标**，平台风控随时可能收紧 |
| **小红书** | 开放 API 不完整，生态高度依赖 **Playwright 浏览器自动化**（xhs-kit 及多个 MCP 实现底层均是） | 技术脆弱且接近风控灰色地带，**发布决策必须经 CEO 门控** |

**合规风险**：2026 年 9 月 1 日起施行的《互联网信息内容多渠道分发服务管理规定》要求 MCN 机构办理经营主体登记、明确内容管理负责人，矩阵运营第一次有**明确的法定责任主体**。抖音持续打击“矩阵号不当获利”“恶意营销号”，批量注册、同质群发、大小号互引是重点对象。账号与真实主体绑定越来越紧。**若运营 Agent 以“接管”姿态跑矩阵，一旦触发风控，被封的不是虚拟身份，而是与真实主体绑定的账号。**

**结论**：发布动作可由工具执行，但**账号策略、内容方向、发布节奏、合规判断这些“非可逆”决策，必须经过审阅门控**。

## 15.3 角色分工（四角色子组织）

| 角色 | 层级 | 职责 | 关键约束 |
|---|---|---|---|
| **内容策略 Agent** | 运营总监层 | 基于章程业务目标制定**内容策略简报**（目标受众、选题方向、各平台内容定位差异、发布节奏） | **不写稿、不发帖**；简报须经 CEO 或产品总监审阅后才进入创作环节 |
| **内容创作与平台适配 Agent** | 执行层 | 产出原始素材（文案、脚本、视觉 brief）+ 平台差异化适配（公众号深度长文 / 抖音开头钩子 / 小红书清单体例） | 可调用 HuiMei、Prism 等工具作为**发布执行器**，但**适配决策由运营子组织做出**，工具只负责“把已适配好的东西送出去” |
| **合规与质量审阅 Agent** | 门控层 | 独立检查：同质化群发特征、未授权引流或互引、素材版权、目标平台最新社区规则 | **不可绕过**；“通过”必须附**具体检查项清单**，不能是一句“没有问题”；无法判定 → 升级 CEO 收件箱 |
| **数据复盘 Agent** | 观测层 | 采集各平台数据（播放、互动、转化），产出复盘报告 | **不直接触发策略调整**，作为下一轮策略简报的输入证据（“监测但不自动决策”） |

## 15.4 流水线（最终作品方案如何产生）

```
策略简报 → 内容素材 → 平台适配版本 → 合规审阅 →（CEO 审批门控）→ 发布执行 → 数据复盘
```

每一步都有独立角色负责，每步产出都是**带证据的结构化交接物**，而非自由文本。**合规审阅与 CEO 审批门控是整条链上不可跳过的节点。** 发布工具（HuiMei、Prism 等）只是链末端的执行器，它们的存在不改变“谁为内容负责”。

## 15.5 参考实现（形态已被实践验证）

- **OpenClaw 16 Agent / 13 平台** 的三层架构：
  - 第一层**基础 Agent（后台支撑）**：总助协调分发、内容 Agent 写稿、设计 Agent 配图封面、增长 Agent 做数据与 SEO、安全 Agent 做合规检查 —— 共享底座，不直接面向平台；
  - 第二层**运营总监**：不写内容不操作平台，职责是“盯全局”（选题方向、数据汇总、异常上报）；
  - 第三层**平台 Agent（各自独立闭环）**：每个负责 1–2 个平台，跑“选题 → 调用内容 Agent 写稿 → 平台适配排版 → 发布 → 数据采集 → 复盘”完整流水线，各有独立 workspace，互不干扰。
- **AIMA 学术系统**：深度搜索 Agent 做趋势研究，内容策略 Agent 用多 LLM 投票机制做选题与策略，观测系统发布后监测数据，**发布前设 Human-in-the-loop 审批门控以确保品牌安全**。

## 15.6 一句话结论

运营岗位不追求“接管平台”。它追求：**把内容运营中可结构化的部分（策略拆解、素材创作、平台适配、合规检查、数据回收）交给 AI 子组织，把不可逆的部分（发布决策、账号策略、品牌风险判断）保留在审批门控之前。** “三层架构的运营子组织 + 合规门控 + CEO 作为最终发布审批人”，是当前技术与规则环境下可以站得住的形态。

---

# 16. 前端设计（桌面端）与 CEO 操作模型

## 16.1 CEO 的操作面：三个入口，一条主线

CEO 的操作被刻意压缩为三个动作：**扔想法、做决策、看回放**。其余一切在后台由层级 agent 完成。

| 入口 | 位置 | 交互 | 系统动作 |
|---|---|---|---|
| **扔想法** | 桌面端今日视图右栏底部常驻输入框；移动端底部悬浮“+ 想法”（语音为主） | 输入一句话（例：“做一个面向独立开发者的 AI 笔记应用，目标月收入 100 万”），提交后框内变**轻量确认条**：“已收到。助理将在 5 分钟内返回章程提案。”不需要等待，可继续做别的事 | 助理 agent 接收并起草章程 |
| **做决策** | 审批收件箱（桌面 / 移动 / 飞书同一队列） | 见 §9.2 卡片结构；三个按钮：批准 / 打回并附意见 / 稍后深度审阅。打回意见作为约束写回对应节点，任务沿边回退 | 策略引擎先过规则；只有规则无法决定的事项出现卡片 |
| **看回放** | 回放视图 | 选择任务 → 时间线 → 逐节点展开状态快照 | 用途不是合规审计，而是**以最低时间成本判断“哪个层级的岗位书需要改”** |

**唯一的主动非审批操作是“章程批准”**：5 分钟后审批收件箱出现“章程提案：{标题}”卡片，展开是结构化章程（**业务目标、3 条可量化成功标准、预算上限、时间约束、助理建议的初始团队角色**），底部两个按钮“批准章程 / 修改后批准”（修改会打开文本编辑器，修改意见作为约束注入章程）。章程批准后 LangGraph 图才开始运转。这是 CEO 与系统之间唯一一次主动的非审批操作 —— **因为“想法”的模糊性只能由 CEO 消除**。

## 16.2 页面总览

五页：**今日视图（默认首页）· 任务看板 · 审批收件箱 · 组织配置 · 回放**。

## 16.3 页面 1：今日视图

**两栏布局，左 2/3、右 1/3。**

- **左栏（自上而下）**
  1. **“需要你决策”区域**：琥珀色左边框的卡片列表，按紧急度排序。
  2. **“自动决策摘要”**：低对比度折叠区，一行摘要 —— “过去 24 小时策略引擎自动通过 17 项可逆决策，拦截 3 项进入人工”。
- **右栏**
  1. **组织状态卡片**：四个大数字 —— 活跃任务数 / 今日预算消耗比例 / 被阻塞任务数 / 过去 24 小时完成数。
  2. **想法输入框**：常驻右栏底部。

**设计意图**：打开第一眼看到的是“你的公司今天需要你做什么，以及它自己已经做了什么”，**不是一群 agent 在聊天**。（信息优先级参考 Paperclip 仪表盘：顶层待审批数与预算消耗，中层活跃 agent 与任务状态，底层最近活动流。）

## 16.4 页面 2：任务看板

- 顶部筛选栏：**“全部” / “需要我注意”**（过滤后只显示被升级或触及预算的任务）。
- 主体：**六列水平滚动看板**，列对应层级 —— 助理 → 产品 → 技术 → 架构 → 执行（开发/测试） → 运营。每列内卡片按最后状态变更时间倒序。
- 卡片正面：一行摘要 + 层级标签 + 最后变更时间（只展示“三层折叠”的第一层）。
- 点击卡片 → 右侧滑出**任务详情抽屉**（不离开看板上下文）：三层折叠（摘要 → 证据包指标 → 完整产出）+ 底部**审阅链**（每个门控节点的审阅者 / 决定 / 理由 / 时间戳）。

## 16.5 页面 3：审批收件箱

- 顶部**策略摘要条**：“过去 24 小时，策略引擎自动通过 X 项可逆决策，拦截 Y 项进入人工审批。当前待处理 Z 项。”
- 单列宽卡片流，默认折叠，展开显示参数快照与推荐理由。
- 支持批量操作（仅同类型同方向），一次批量写一条审计事件。

## 16.6 页面 4：组织配置

- 左侧角色列表（助理 / 产品总监 / 技术总监 / 架构师 / 开发 / 测试 / 运营）。
- 右侧选中角色的**岗位书编辑器** —— **结构化验收标准清单，非自由文本**。例如测试工程师岗位书含“覆盖率低于 90% 不得标记通过”“P0 缺陷必须直接升级到技术总监，不经过开发自我判定”。
- 底部委派规则图可视化缩略图（节点 = 角色，边 = 交接方向，**边上的小锁图标 = 审阅门控**），点击进入全屏图编辑。
- 本页为**三栏可拖拽编辑器**，规格详见 **§18**。
- 另含：预算分配、信任积分调整建议（§4.4）。

## 16.7 页面 5：回放

- 全屏时间线。上方任务摘要与最终状态，下方垂直事件流。
- 每个事件节点可展开状态快照（助理章程提案原文、产品总监拆解理由、每次审阅决定的证据与意见、每次预算消耗、最终交付物）。
- 支持按事件类型过滤（审阅决定 / 工具调用 / 预算 / 审批 / 会议）。
- **特殊标注**（§22.3）：蒸馏 skill 生成的判断、基于模式的自动批准、harness 名称与版本。

---

# 17. 前端设计（移动端）

移动端**不做响应式缩放**，做独立轻量界面；不加载看板与组织配置的复杂组件。路由层做条件裁剪 —— 移动端只注册审批与只读视图的路由。

## 17.1 页面 1：审批卡片流（默认页）

- 全屏卡片，每次一张，上下滑动切换。
- 卡片结构同桌面端审批卡，但**按钮更大、占满宽度**：批准 / 打回 / 稍后深度审阅。
- 推荐理由压缩为两行。
- 左右滑动 = 快速批准 / 快速打回的辅助手势，**需二次确认防误触**。
- 继承 Railse OPC 移动端原则：“先用一句人话说谁要做什么、在哪、为什么问你，下面是原样的命令，批准和拒绝各一个按钮。”

## 17.2 页面 2：想法快速输入

底部悬浮“+ 想法”弹出极简界面：**语音按钮（主）+ 文字输入（辅）**。提交后只显示确认条，**不展示后续拆解过程**。语音是一等输入方式，服务通勤与碎片时间“扔出一个想法”。

## 17.3 页面 3：状态只读

四个数字：活跃任务数 / 今日预算消耗比例 / 被阻塞任务数 / 待你审批数。每个数字可点击查看简要列表，**列表只读、无操作入口**。存在意义是“让你确认公司还在运转”，不是管理。

## 17.4 推送通知

**仅对“需要 CEO 决策”的事项推送**，不推送常规状态更新。

---

# 18. 组织层级可视化与拖拽编辑

> 结论：**技术上完全可行，React 生态有成熟方案。但组织架构不是白板上的便签，拖拽必须被约束在合法的组织变更语义内** —— 否则会拖出一个“测试工程师直接向 CEO 汇报、绕过技术总监”的非法结构，LangGraph 的图会直接崩掉。核心不是“能不能拖”，而是**拖拽被约束在合法的组织变更语义内**：非法操作回弹并解释原因，合法操作走确认面板，变更生成新版本而非就地修改。这与 §4 的“受约束的自主”原则一致：**UI 的自由度可以大，但落地的变更必须过门控。**

## 18.1 技术选型

| 方案 | 适用性 | 取舍 |
|---|---|---|
| **React Flow（xyflow）** | **首选** | 专为节点-边图设计，内置拖拽、连线、缩放、小地图、自定义节点；MIT 许可，社区活跃；组织架构图是其典型用例 |
| **dnd-kit** | 辅助 | 做“拖拽角色卡片到层级树”的列表式交互更轻量；但不擅长“边”的编辑 |
| React DnD | 不推荐 | 维护活跃度下降，API 较老 |
| 自研 SVG + 指针事件 | 不推荐 | 拖拽、连线、吸附、缩放全要自己实现，工作量数倍于用库 |

**决策**：**React Flow 做图式编辑，dnd-kit 做列表式排序**，两者共存于同一页面。包版本（npm 实测）：`@xyflow/react` **12.12.1**（React Flow v12 的新包名；旧 `reactflow` 11.11.4 已停止主要迭代，新项目用 `@xyflow/react`）、`@dnd-kit/core` **6.3.1**、`@dagrejs/dagre` **3.1.3**。
>
> **宿主环境**：Electron 渲染进程（Chromium）与 Capacitor WebView 对 React Flow / dnd-kit 均无已知兼容问题。两点要求：① Electron 侧需在 `onNodeDragStart` 期间**禁用窗口的导航与文件拖放拦截**，否则拖拽会被窗口级事件吞掉；② 若采纳 §5.7 的 Web 前端（§25-D8），React Flow 直接跑在浏览器里，无需任何壳层适配 —— 这是把"组织图编辑器"做成纯 Web 组件的额外理由。

## 18.2 拖拽语义分类：五种操作，三种合法、两种非法

### 合法操作

**A. 拖拽节点改变布局位置（自由移动）**
- 语义：只改视觉坐标，不改组织架构。约束：无。坐标存 `role_charters.config.ui_position`。
- 实现：React Flow `onNodeDragStop` → 保存 `{x, y}` 到该角色 UI 配置。用途：把图排得好看，纯视觉调整。

**B. 拖拽节点改变汇报关系（改 parent）**
- 语义：把“开发工程师”节点拖到“技术总监”节点的子区域，改变 `reports_to`。
- 约束：**必须过合法性校验**（§18.3）。非法则节点**回弹原位**并弹提示。
- 实现：`onNodeDragStop` 检测节点是否落在另一节点的 drop zone → 触发 `validateReparenting(child, newParent)` → 通过则更新 `role_charters.config.reports_to`，失败则 `setNodes` 回弹。
- 影响：**仅对新任务生效**（运行中任务保持旧图，§18.4）。

**C. 拖拽创建委派边（连线）**
- 语义：从节点 A 输出端口拖到节点 B 输入端口，创建委派边 A→B。
- 约束：**必须校验边合法性** —— 不能创建循环依赖、不能跳过审阅门控、不能违反层级约束。
- 实现：`onConnect` → `validateNewEdge(source, target)` → 通过后添加边并弹出**边配置面板**（证据包类型、审阅门控、否决权）。

### 非法操作（必须被拦截）

**D. 试图通过拖拽改变角色的“禁止事项”或“工具权限”** —— **不允许**。这些是岗位书的结构化字段，必须在右侧属性面板里显式编辑（带确认对话框）。拖拽语义太模糊，无法表达“把‘禁止 merge_to_main’从开发工程师身上摘下来”这种精确变更。

**E. 试图拖拽删除节点或边** —— **不允许直接拖到垃圾桶删除**。删除角色或委派边是高危操作，必须走“选中 → 点击删除按钮 → 确认对话框（显示影响范围：X 个运行中任务将受影响）”。拖拽删除误触率太高。

## 18.3 合法性校验：拖拽后的“门控”

**这是整个可拖拽设计中最重要的部分。拖拽本身是自由的，但落地必须过校验。** 校验分三层，**全部是确定性代码，不依赖 LLM**。

```ts
// 前端与 Hub 共用同一份校验实现（同一 TS 模块、同一 zod schema），避免两套逻辑漂移
type Verdict = { ok: true } | { ok: false; reason: string };

export function validateReparenting(
  childRole: RoleId, newParent: RoleId, org: OrgGraph,
): Verdict {
  if (getDescendants(childRole, org).includes(newParent))
    return { ok: false, reason: "不能将角色挂到自己的下级之下" };          // 1 不能形成环
  if (!org.nodes[newParent].canManage)
    return { ok: false, reason: `${newParent} 不是管理角色，不能接收汇报` };  // 2 非管理角色不收汇报
  if (getDepth(newParent, org) + 1 > MAX_DEPTH)
    return { ok: false, reason: `组织层级超过 ${MAX_DEPTH} 层上限` };        // 3 深度上限（默认 5 层）
  if (childRole === "ceo")
    return { ok: false, reason: "CEO 是组织根节点，不可改变汇报关系" };      // 4 CEO 不可被拖
  return { ok: true };
}
```

```ts
export function validateNewEdge(source: RoleId, target: RoleId, org: OrgGraph): Verdict {
  if (!hasReviewGate(source, target, org))
    return { ok: false, reason: "委派边必须配置审阅门控" };              // 1 不能跳过门控
  if (violatesNoSelfReview(source, target, org))
    return { ok: false, reason: "审阅者不能是产出者的直接执行者" };        // 2 §8.2 硬约束：作者不给自己打分
  if (!canReach(target, "ceo", org))
    return { ok: false, reason: "委派边会导致升级路径断裂，无法到达 CEO" }; // 3 升级路径必须可达 CEO
  if (wouldExceedMaxDepth(org, source, target))
    return { ok: false, reason: `新增边使层级超过 ${MAX_DEPTH} 层上限` };
  return { ok: true };
}
```

```ts
export function validateOrgChange(change: OrgChange, actor: Actor): Verdict | NeedsConfirmation {
  if (actor.type !== "human" || actor.id !== "ceo")
    return { ok: false, reason: "只有 CEO 可以修改组织架构" };            // §4.2.3 资源分配权集中在 CEO
  const running = getRunningTasks();                                      // status ∉ {DELIVERED, ARCHIVED}
  if (running.length > 0)
    return { ok: true, needsConfirmation: `当前有 ${running.length} 个任务在运行，变更仅对新任务生效` };
  return { ok: true };
}
```

> **三层校验必须是确定性代码**（§24 风险 5 同源要求）：纯函数 + zod 校验，不查 LLM、不读网络。前端用来做实时高亮与回弹，**Hub 在保存时再跑一遍同样的函数**（§18.4 阶段 2）—— 前端校验只是体验优化，安全边界在 Hub 内。

## 18.4 与后端 LangGraph 图的同步：“编辑时”拖拽，“提交”才生效

```
[拖拽编辑] → 前端内存图 → [点击“保存组织变更”] → 写入 role_charters + delegation_graphs → [系统重建 LangGraph 图]
```

1. **阶段 1 拖拽编辑（纯前端）**：React Flow 维护本地 `nodes`/`edges` 状态，拖拽只改本地状态，**不触发任何后端请求**；用户可连续拖拽直到满意。
2. **阶段 2 保存（写数据库）**：点击“保存组织变更”→ 图序列化为 JSON → **IPC（Electron preload）或 HTTP（Web / 移动端）→ `opc-hub` 进程**。Hub 内执行：① 鉴权（只有 CEO 身份 + 有效 token，§20.3 同款机制）；② **再次运行同一份三层校验**（前端校验不可信，§18.3）；③ 在**同一事务**内写入 `role_charters`（version + 1）与 `delegation_graphs`（新版本）+ 一条 `events` 审计事件（变更前后图快照）；④ **不立即重建运行中的 LangGraph 图**。
3. **阶段 3 重建 LangGraph（新任务生效）**：新任务章程批准时从 `delegation_graphs` 读**最新版本**初始化；旧任务从 Checkpoint 恢复时加载**创建时版本**的图定义（Checkpoint 内已存图结构，或经 `tasks.graph_version` 关联）。

**版本化 = “版本切换”，不是“就地修改”**：

```sql
CREATE TABLE delegation_graphs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,        -- nodes + edges + gates 的完整序列化
  effective_from INTEGER NOT NULL, -- Unix 毫秒
  created_by TEXT NOT NULL,
  change_summary TEXT              -- "开发工程师汇报关系改为架构师；新增运营→合规边"
);
ALTER TABLE tasks ADD COLUMN graph_version INTEGER NOT NULL DEFAULT 1;
```

回放视图可展示：“这个任务在**岗位书第 3 版**的组织图下运行，当时开发工程师向技术总监汇报；第 5 版之后改为向架构师汇报。”（此处 v3 / v5 指 `role_charters.version`，与本文档版本无关。）

## 18.5 实时交互反馈

- **拖拽中**：合法 drop 目标**高亮绿色边框**；非法目标显示**红色禁止图标**，光标变 `not-allowed`。
- **释放后非法**：节点**弹性动画回弹**到原位（`setNodes` + CSS transition），顶部 toast 显示拒绝原因（如“不能将测试工程师挂到 CEO 之下，会跳过技术总监的审阅门控”）。
- **释放后合法**：节点吸附新位置，弹出**变更确认面板** —— “开发工程师的汇报关系将从【技术总监】变更为【架构师】，影响：新任务的委派路径将经过架构师审阅。确认？”确认后才写数据库。

## 18.6 组织配置页三栏布局（§16.6 的展开）

```
┌──────────────┬─────────────────────────────┬──────────────┐
│ 角色列表      │  委派规则图（React Flow）      │ 属性面板      │
│ (dnd-kit)    │                             │              │
│              │   [CEO]                     │ 选中角色的    │
│ ▸ 助理        │     │                       │ 岗位书字段    │
│ ▸ 产品总监    │   [助理]                     │ - 汇报关系    │
│ ▸ 技术总监    │    ╱    ╲                    │ - 决策空间    │
│ ▸ 架构师      │  [产品]  [技术]               │ - 禁止事项    │
│ ▸ 开发        │          │                  │ - 工具权限    │
│ ▸ 测试        │      [架构师]                 │ - 审阅门控    │
│ ▸ 运营总监    │       ╱    ╲                 │              │
│              │   [开发]  [测试]               │ [保存变更]   │
└──────────────┴─────────────────────────────┴──────────────┘
```

- **左栏（角色列表）**：dnd-kit 可拖拽排序，拖角色卡片到图中对应位置等价于“创建节点”。
- **中栏（React Flow 画布）**：节点可拖拽改布局与汇报关系，端口可拖拽创建委派边。顶部有**“编辑模式 / 查看模式”切换** —— 查看模式下所有拖拽禁用，只读。
- **右栏（属性面板）**：选中节点或边后显示结构化字段。**禁止事项、工具权限、审阅门控的详细配置在这里编辑，不通过拖拽完成。**

## 18.7 布局策略取舍（自由布局 vs 自动布局）

| 方案 | 描述 | 缺点 |
|---|---|---|
| A 纯自由布局 | 用户拖到哪就是哪，坐标存 `ui_position` | 可能被拖得乱七八糟，下次打开一片混乱 |
| B Dagre 自动布局 + 锁定 | 按 `reports_to` 用 Dagre 自动分层（CEO 顶、总监中、执行层底），拖拽后坐标锁定，可“重置布局” | 用户失去完全自由的画布控制 |
| **C 混合（建议）** | 默认自动布局；用户拖拽后该节点进入“手动模式”（坐标锁定，标记 `manual_position: true`）；提供“恢复自动布局”一键重置 | — |

**建议方案 C**：组织架构图的价值在于**结构清晰**，不是自由画布。用户拖拽的主要目的是“改汇报关系”，不是“把节点摆成爱心形状”。自动布局保证图始终可读，手动微调满足个性化，重置按钮兜底。此项不影响后端设计，只影响 React Flow 的布局策略配置（用 `@dagrejs/dagre` 做初始布局）。

## 18.8 工作量估算

| 任务 | 工作量 |
|---|---|
| React Flow 集成 + 自定义节点 / 边渲染 | 3–4 天 |
| 三层校验的前端实现（实时高亮 + 回弹 + toast） | 2–3 天 |
| 属性面板（岗位书字段编辑） | 2–3 天 |
| 保存 → 版本化 → LangGraph 重建链路 | 3–4 天 |
| 自动布局 + 手动微调 + 重置 | 1–2 天 |
| 查看模式（只读）+ 回放视图的图版本展示 | 2 天 |
| **合计** | **约 13–18 个开发日** |

---

# 19. 风格设计规范

## 19.1 整体气质：控制室，不是聊天室

界面不应让人联想到 ChatGPT 或 Slack。主视觉隐喻是**控制室 / 驾驶舱**：信息密度高、层级清晰、状态可扫视。默认首页不是对话流，而是“需要你注意的事项 + 组织当前状态”的聚合视图。**聊天是手段之一，不是界面骨架。**

## 19.2 配色

| 用途 | 色值 | 规则 |
|---|---|---|
| 背景 | `#0F1117` | 深色为主，降低长时间扫视的视觉疲劳 |
| 卡片 | `#1A1D27` | — |
| **CEO 决策强调色** | `#E8A33D`（琥珀） | **全局仅用于“需要 CEO 决策”这一种状态**。眼睛在任何页面一扫，琥珀色出现处就是需要你动手的地方 |
| 进行中 | 低饱和蓝 | — |
| 已完成 | 低饱和绿 | — |
| 已归档 / 低对比度 | 灰 | “自动决策摘要”等折叠区用低对比度 |

## 19.3 字体

- **等宽字体**：任务 ID、金额、时间戳
- **无衬线字体**：正文与标题
- 信息密度优先于装饰性

## 19.4 信息架构：“三层折叠”

任何任务在 CEO 面前只展示三层：

1. **第一层**：一行摘要（“开发完成登录模块，测试通过率 94%，等待技术总监审阅”）
2. **第二层**：关键指标与证据摘要（测试覆盖率、diff 行数、未解决问题数）
3. **第三层**：完整产出（代码 diff、完整报告）

CEO 大多数时候只看第一层，偶尔看第二层，第三层只在深度介入时打开。

## 19.5 移动端风格

不做响应式缩放，做独立轻量界面：审批卡片占满宽度，上下文以可展开摘要呈现，操作只有三个按钮。语音输入是一等输入方式。

---

# 20. 安全与权限

## 20.1 Harness 层

- Gateway 为每个角色**预设不可覆盖**的 harness 参数。
- 程序员 Agent 默认禁止 `--yolo` / `bypass_permissions`，除非任务标记“实验性”且工作区 disposable。
- 不可逆操作（生产部署 / 数据库迁移 / 对外 API 发布）必须经 CEO 审批门控。
- `forbidden_flags` 命中 → 拒绝执行并记录 `unauthorized_attempt` 审计事件（联动信任积分，§4.4.3）。

## 20.2 Agent 层

- 每个 Agent 的 MCP 工具权限由**岗位书**限定。
- Agent 间 A2A 通信受委派规则图约束，**不能绕过门控直接向上交接**。
- Harness 调用的 `session_id`、脱敏参数、diff 哈希全部记录。
- 自由度与越权防护的完整设计见 **§4**（白名单授权 + 黑名单硬拦截）。

## 20.3 IM 层

- 审批操作必须经**签名验证 + 一次性 token**。
- **不可逆操作禁止在 IM 中完成**，强制在桌面端 / 移动端（有二次确认）完成。
- 飞书卡片回调携带签名，Hub 验证签名后才处理审批决策。

## 20.4 数据层（SQLite）

- `events` 表 append-only，**触发器**禁止 UPDATE / DELETE。
- 审计日志与 Checkpoint **在同一事务提交**，防止崩溃时事件丢失。
- 敏感凭证（API key、IM 签名密钥）存独立的 `secrets` 表，**加密 at rest，仅 Hub 层可读**（v1.0 可用 OS keyring / 本地加密文件，不引入外部 KMS）。
- 启动时执行 `PRAGMA integrity_check`；每日 `VACUUM INTO` 备份（§6.5、§24 风险 8）。

---

# 21. 成本与预算治理

## 21.1 预算三级

**公司级 → 角色级 → 任务级**。任一层级达到阈值自动暂停相关 agent 执行。（SQLite 中为 `budgets` 表，`scope_type` ∈ {company, role, task}，金额单位为**美分**。）

## 21.2 成本记录

每个 agent 的模型调用、工具调用、外部 API 消耗记录在 `budgets`（累计值）与 `events`（`action='budget_consume'`，含明细）。可按角色 / 任务 / 时间段聚合。

## 21.3 界面表现

- 今日视图右栏组织状态卡片中以**日消耗 vs 预算**的简洁条形持续可见，无需主动查询。
- 预算暂停 → 审批收件箱出现**非琥珀色**卡片（§7.4）。

## 21.4 搜索预算降级

搜索成本达任务预算比例阈值时，后续搜索请求需技术总监或 CEO 审批（§13.3 第三层）。

## 21.5 成本预期参考（竞品定价锚点）

| 项 | 量级 |
|---|---|
| 单家公司（Paperclip 口径） | $20–100 / 月；试玩 $5–20 |
| 单个中等活跃 worker agent | 约 $3–15 / 月（按 Anthropic 典型定价） |
| MetaGPT 每任务 | 约 $0.18（说明“按任务生成项目”的框架成本极低，但缺治理） |

---

# 22. 审计与回放

## 22.1 不可变事件日志

所有状态变更、审阅决定、审批操作、工具调用、预算消耗写入 `events` 表（append-only）。每条事件含 `actor_type` / `actor_id` / `action` / `target` / `payload` / `state_snapshot` / `created_at`。

**`action` 枚举**：`state_change` · `review_decision` · `approval` · `tool_call` · `budget_consume` · `meeting` · `harness_call` · `unauthorized_attempt` · `dissent` · `escalation`

## 22.2 任务回放

选择任意任务，以时间线回放：想法提出 → 章程提案 → 产品拆解 → 每次审阅决定与理由 → 每次预算消耗 → 最终交付物。

**回放目的**：让 CEO 以极低时间成本理解“组织是怎么运转的”，从而调整岗位书、委派规则或审阅门控 —— **审计是组织调参的数据来源，不是合规工具**（§4.5）。

## 22.3 回放视图的特殊标注

- 由蒸馏 skill 生成的判断 → 标注“该判断由蒸馏 skill X 生成，不属于经过验证的组织知识”（并显示 skill 版本、来源、置信边界）。
- 策略引擎自动通过的决策 → 标注“基于模式的自动批准”。
- Harness 调用 → 标注 harness 名称 / 版本 / 参数脱敏摘要 / session_id / 退出码 / diff 哈希。
- 组织图版本 → 标注该任务运行时的 `graph_version` 及其汇报关系（§18.4）。
- 审阅者模型家族 → 记录每次审阅的模型来源，可分析“**同一模型家族审阅通过率是否异常偏高**”（§24 风险 1）。

## 22.4 完整性校验（Phase 6 交付项）

定期扫描 `events` 表，验证：每个状态变更都有对应事件、每个门控决定都有对应证据包引用、每条 harness 调用都有对应消耗记录。

---

# 23. 开发计划与里程碑

## 23.1 阶段划分（桌面端优先，移动端延后）

假设由 CEO（主导设计 + 验收）+ 1 名全栈开发者（或 CEO 本人具备全栈能力）推进。周期为**日历时间**估算，按每周有效开发时间 25–30 小时计。

| 阶段 | 周期 | 核心交付物 | 验收标准（CEO 亲自判断） |
|---|---|---|---|
| **Phase 0 编排内核与数据模型** | **4 周** | **第 0 天先做 LangGraph.js PoC（§5.4 五项门禁，含 kill 重启恢复）+ SQLite 驱动定案（§5.6 D6）**；随后：LangGraph.js 图骨架（助理→产品→技术→开发→测试→运营的线性 + 单分支流转）、**SQLite（WAL）+ Checkpoint Saver**、事件日志表 + **append-only 触发器**、岗位书 YAML schema（zod 校验）、**预设岗位书模板**、**写队列与事务边界（§5.5）** | 通过测试想法（如“做一个落地页”）跑通完整流程；中途手动打断并从 Checkpoint 恢复；审计日志完整记录每个节点输入输出 |
| **Phase 1 审阅门控与证据包** | 3 周 | 证据包 schema、门控验证逻辑（“作者不给自己打分”的**确定性**硬约束）、升级路由触发条件、策略引擎规则骨架（只读 / 可逆 / 不可逆三级分类） | ①开发标记“完成”但不附测试报告 → 门控拒绝；②测试标记“通过”但覆盖率不足 → 拒绝；③触发一次预算突破 → 暂停 + 升级 |
| **Phase 2 桌面端前端（今日视图 + 看板 + 审批收件箱）** | 4 周 | **Electron 45 壳（electron-vite + electron-builder）+ `@ag-ui/client`**、今日视图、任务看板（六列 + 三层折叠）、审批收件箱、组织配置**只读**视图；**Hub 与 UI 分离的 IPC/HTTP 边界在本阶段定型**（§5.3） | 在桌面端完成“输入想法 → 看流转 → 收件箱审批 → 看板更新”完整闭环，**不需要接触命令行** |
| **Phase 3 组织配置 + 回放 + 策略引擎自动审批** | 3 周 | 岗位书编辑器、委派规则图编辑（**`@xyflow/react` + `@dnd-kit` + `@dagrejs/dagre`**，§18）、回放时间线（**FTS5 trigram + LIKE 双路**，附录 C.3）、策略引擎完整逻辑、预算层级配置、角色级记忆、**并行分支与动态边（按实际绕行需求）** | 修改岗位书验收标准后重跑同类任务，门控行为按新标准变化；自动通过的决策在日报可见且可追溯 |
| **Phase 4 移动端 + IM 接入（飞书）** | 3 周 | **Capacitor 8 打包（或 PWA）承载审批组件 + Hub 的本地/内网 HTTP+WS 服务**、移动端审批卡片流、语音/文字想法输入、只读状态、**移动端纯 RPC（选项 A，不做本地 SQLite）**、**`@larksuiteoapi/node-sdk` 飞书卡片推送 + 长连接回调** | 手机收到审批推送 → 查看摘要与参数快照 → 批准 / 打回 → 桌面端看板同步更新 |
| **Phase 5 Harness Gateway 一期（Claude Code / Codex / Qoder）** | 3 周 | 三个适配器（**官方 TS SDK 为主、CLI 为兜底，§12.1**）、程序员 Agent 任务路由、测试 Agent 独立验证、四层安全防护（含 `forbidden_flags` 硬拦截） | 缺陷修复任务跑通“只读分析 → 复现验证 → 修复 → 测试独立验证 → 上报”全链路 |
| **Phase 6 硬化与试运行** | 2 周 | 错误处理、重试机制、审计完整性校验、**SQLite 备份脚本 + `PRAGMA integrity_check` + FTS5 索引重建**、性能调优（心跳下的资源占用）、文档（岗位书写法、委派规则配置指南） | 连续运行一周无任务因未处理异常静默停滞；所有预算突破被处理；能在 5 分钟内通过回放理解任意已完成任务 |

**总周期：约 22 周（5.5 个月）**。若桌面端优先、移动端与 Harness 延后，可压缩至 **16–17 周**。

> **Phase 0 为什么是 4 周**：前 3 天被两项**证伪性验证**占住 —— LangGraph.js 的五项 PoC 门禁（§5.4）与 SQLite 驱动定案（§5.6 / §25-D6）。这不是保守，而是这两项**决定后面 18 周的代码形状**：驱动定错会让 §6.3 的"Checkpoint 与 events 同事务"做不到，框架定错要重写全部编排。任何省掉这 3 天的排期，都是在给自己埋一次推倒重来。
>
> **工具链只有一条**：`pnpm i && pnpm dev`（electron-vite 起 UI）+ `pnpm hub:dev`（tsx 起 Hub）。**Windows 开发机是否需要装 MSVC Build Tools，完全取决于 §5.6 是否采纳 D6-a** —— 这是 D6 里最影响日常开发体验的一条，也是它必须在 Phase 0 第 0 天定案的原因。
>
> **Web / 远程前端不额外占工期**：Hub 对外暴露 HTTP + SSE（§5.3、§5.7），浏览器端复用同一套 React 组件，因此"多一种访问方式"在 Phase 2 顺带完成，不新增阶段。

## 23.2 关键依赖：最大风险不在技术

**最大风险在岗位书的“验收标准”设计。** Phase 0 与 Phase 1 需要 CEO 投入最多**设计精力**，而非编码精力 —— 你必须亲自为每个角色定义“什么叫做完了”和“什么叫做合格”。这是系统能否真正替你过滤审阅负担的前提。

**第二个风险是 LangGraph 图的“边”过于刚性**：真实运营会出现预设委派规则未覆盖的路径（一个想法同时涉及产品与运营，需并行拆解而非串行）。缓解：Phase 0 图骨架预留并行分支与动态边**能力**，但 Phase 0 验收只要求线性 + 单分支跑通；并行与动态边在 Phase 3 之后按实际“绕行需求”逐步加入，避免过度设计。

**第三个风险是 CEO 自己的角色惯性**：产品经理型 CEO 天然倾向“看到问题就想自己改”。OPC-OS 要求把修改意图**表达为岗位书变更或委派规则变更**，而不是直接介入任务执行。Phase 2 验收标准特意包含“不需要接触命令行”，就是为了迫使交互面收敛到审批、配置、回放，而不是一个可以随时跳进去改代码的终端。

## 23.3 建议的第一步（最小可运行图）

从 Phase 0 的“**最小可运行图**”开始：**想法 → 章程 → 产品拆解 → 技术拆解 → 开发 → 测试 → 上报（线性无分支）**，用**预设岗位书模板**跑通一个端到端测试任务，再逐步加入审阅门控、策略引擎与前端。Harness 先只接 Claude Code 一家跑通，再接 Codex / Qoder。

---

# 24. 结构性风险与缓解策略

> 结论：**风险 1（审阅共谋）与风险 5（门控测试）是 Phase 1 必须验证的** —— 门控本身不可靠，整个系统的信任基础就不成立。**风险 4（冷启动）建议在 Phase 0 就提供预设模板**。**风险 7（法律责任）不是技术能解决的**，需在产品上线前由法律顾问审阅用户协议。

## 风险 1：Agent 审阅的“共谋”或“放水”

**问题**：若测试 Agent 与开发 Agent 使用同一 LLM 家族，它们可能系统性地放过彼此的问题（人格蒸馏研究显示 Agent 存在内群体偏好）。

**缓解**：
- 测试 Agent 的独立验证默认使用**与开发不同的 harness / 模型家族**（如开发用 Claude Code，测试用 Codex CLI）。
- 高风险任务启用对抗性测试（第二个独立 harness 做只读审查）。
- 审计层记录每次审阅的模型来源，回放视图可分析“同一模型家族审阅通过率是否异常偏高”。

## 风险 2：记忆与知识管理

**问题**：跨任务的上下文继承、组织知识的沉淀，当前产品（包括 Paperclip）没有很好解决。

**缓解（分期）**：
- Phase 0 只做**任务级记忆**（LangGraph Checkpoint 内的上下文）。
- Phase 3 引入**角色级记忆**（每个角色的历史审阅决定与理由，作为后续任务的 few-shot 参考）。
- **组织级知识库**（跨角色的经验沉淀）作为 Phase 6 之后的演进方向，**不在 v1.0 承诺**。

## 风险 3：多任务并行的资源调度

**问题**：5 个任务同时需要技术总监审阅时，审阅队列如何排序？预算如何分配？

**缓解**：
- 审阅队列按**任务优先级 + 等待时间**排序（优先级由章程中的业务目标决定）。
- 角色级预算在多任务间按**任务预算比例**动态分配。
- 某角色队列积压超过阈值 → 心跳触发“**审阅瓶颈**”告警进入 CEO 收件箱（**信息性卡片**），CEO 可决定是否临时追加预算或调整优先级。

## 风险 4：冷启动与渐进式复杂度

**问题**：用户第一天怎么用？不可能第一天就把所有岗位书写好。

**缓解**：
- 提供**预设岗位书模板**（助理 / 产品总监 / 技术总监 / 架构师 / 开发 / 测试 / 运营各一份默认 YAML），先跑通再逐步调整。
- Phase 0 验收只要求线性 + 单分支跑通；并行与动态边在 Phase 3 之后按实际绕行需求逐步加入。
- 不要求第一天配置所有 harness：先接 Claude Code 一家跑通，再逐步接入 Codex / Qoder。

## 风险 5：OPC-OS 自身的测试与回归

**问题**：Agent 行为是非确定性的，如何测试“审阅门控确实拦住了不合格产出”？

**缓解**：
- 门控验证逻辑是**确定性代码**（检查覆盖率数值、证据包字段完整性、“作者不给自己打分”的图结构约束），**不依赖 LLM 判断** → 可用传统单元测试覆盖。
- Agent 行为本身用**场景回放测试**：录制一组固定输入（测试想法 + 预设的 Agent 产出），断言门控在特定条件下触发拒绝 / 升级。
- **Phase 1 的验收标准就是一组这样的确定性测试用例。**

## 风险 6：数据一致性与审计完整性

**问题**：append-only 日志在崩溃时如何保证不丢事件？

**缓解**：
- 事件写入与 LangGraph Checkpoint 在**同一个 SQLite 事务**中提交（§5.5、§6.3）。这也是 §5.6 禁止 D6-c 的原因：两个 db 文件之间无法原子提交。
- 审计日志完整性校验作为 Phase 6 交付项（§22.4）：定期扫描 `events`，验证每个状态变更都有对应事件、每个门控决定都有对应证据包引用。

## 风险 7：法律责任的清晰化

**问题**：AI 生成内容的版权归属、Agent 行为的责任归属。

**缓解**：
- **产品层面**：用户协议明确“所有 AI 产出物在 CEO 审批通过前不构成对外承诺；CEO 审批通过后的行为责任归属用户”。
- **审计层面**：每条对外动作记录“触发角色 + 审批人 + 审批时间”，形成完整责任链。
- **运营层面**：内容发布前强制经合规审阅 + CEO 审批门控（§15），不追求全自动接管。
- 这是**产品设计层面无法完全解决**的问题，需在用户协议与实际运营中持续界定。**v1.0 的立场：AI 做流程执行者，CEO 做责任主体。**

## 风险 8：SQLite 文件损坏

**问题**：极端情况下（断电、磁盘满、文件系统错误）可能损坏。单文件意味着单点故障。

**缓解**：
- WAL + `synchronous=NORMAL` 在崩溃时保证数据库一致性（WAL 的 checkpoint 机制）。
- 每日 `VACUUM INTO` 备份，保留 7 份。
- 启动时执行 `PRAGMA integrity_check`，失败则提示从备份恢复。
- 关键操作（岗位书变更、委派规则变更）前自动备份。

## 风险 9：写路径漂移 —— 写串行化被绕过

**问题**：SQLite 的并发写会触发 `SQLITE_BUSY`，而"只有一个写者"这条纪律会在日常开发中悄悄被破坏。Hub 是单一 Node 进程，写路径设计上只有一条 —— 但下面三个来源会让它变成多条：

| 来源 | 说明 | 缓解 |
|---|---|---|
| 心跳调度 vs 节点状态变更 vs HTTP 审批写入 | 三者都在 Hub 内并发触发写 | 全部进**同一个写队列**（`AsyncQueue` + 单个 writer task），入队即串行 |
| 外部工具直接打开 db 文件（调试脚本、用户手贱、`sqlite3.exe`） | 绕过写队列 | ① DB 目录权限收紧；② 启动时记录 `PRAGMA data_version`，异常跳变告警；③ 文档明确“禁止外部写”，只开放只读连接 |
| **进程拆分**（例如把 Harness Gateway 隔离成独立进程做故障隔离） | 一旦出现跨进程写，`SQLITE_BUSY` 立刻回来 | **架构决策点**：拆分时把写权限**整体**迁到新主体，原主体改为经 IPC 写 —— **写者数量恒为 1，只允许换主体**。绝不允许两个写者并存 |

**实测证据（本机，Node 24 / SQLite 3.53）**：写事务持锁期间，另一连接即便设了 `busy_timeout=5000`，仍在等待 **5573ms** 后抛出 `database is locked`。→ **结论：不能指望 SQLite 替你排队，应用层写队列是唯一可靠手段。**

## 风险 10：Hub 不在线，所有远程端一起失效

**问题**：选项 A（纯 RPC）要求桌面端在线，移动端才能审批；桌面端关机则移动端与飞书审批都失效。

**缓解**：
- 这是**可接受的**：OPC-OS 的 agent 执行本身也依赖桌面端在线 —— 桌面端关机时整个公司本来就停摆。
- 若要求 7×24 可用：把 Hub 部署到常驻主机（VPS / 树莓派 / 家用 NAS）。因为 Hub 是独立进程（§5.3），**这纯粹是一个部署选择，不是工程项** —— 同一份 `opc-hub` 包换台机器跑，数据层设计不需要任何改动（§25-D9）。
- **若从第一天起就让 Hub 常驻、桌面 Electron 只当 UI，本风险直接归零。** 这是 D9 值得在开工前想清楚的原因：它改变的是"你的公司跑在哪台机器上"这个根本前提。

## 风险 11：LangGraph.js 的能力面可能不满足编排需求（高优先级）

**问题**：整个编排内核（§5.4）压在 LangGraph 上，而该框架以 **Python 为主实现、JS 为并行实现**。JS 侧发布节奏确实活跃（`@langchain/langgraph` 1.7.1 的发布日与本文档核对日为同一天），但**两版能力面是否对齐、interrupt / 子图 Checkpoint / 并行 Reducer 的边界行为是否一致，本文档未逐项穷尽验证** —— "官方包存在且活跃"不等于"能满足 §8 的门控与 §10.2 的子图"。**这是一条未消除的不确定性。**

**缓解**：
- **Phase 0 第 0 天的 PoC 门禁**（§5.4 五项）：条件边与汇聚节点、**进程被 kill 后从 Checkpoint 恢复且不重复计费**、并行 Reducer 合并、interrupt 映射到审批卡片、**子图嵌套 Checkpoint**（§10.2 辩论会）。
- PoC 不过 → 走 §25 **D7**：评估 Mastra（`@mastra/core` 1.82.0，TS 原生）或自研极薄图执行器。**自研薄执行器的成本被严重低估过**：需要自己实现 Checkpoint 语义、重放、并发合并、中断恢复，估算 3–4 周且长尾 bug 多，只应在两个框架都不满足时考虑。
- 版本策略：**锁 LangGraph 1.x 的 minor**，升级前跑门控确定性测试套件（风险 5）+ 回放一致性校验（风险 6）。

## 风险 12：`node:sqlite` 实验性 与 原生模块依赖，二选一

**问题**：两条路都带刺。**`node:sqlite`** 在 Node 中仍属**实验性内置模块**，API 可能变动（实测：**不提供** `db.backup()`；FTS5 默认分词对中文检索命中 0）；**官方 SqliteSaver** 则依赖 **`better-sqlite3`（原生 addon + node-gyp）**，Windows 打包需要 MSVC Build Tools，Electron 每次升主版本都要 `@electron/rebuild`。

**缓解**：
- 决策见 **§5.6 / §25-D6**。建议 **D6-a（全用 node:sqlite + 自研 Saver）**，并把 Saver 实现放在 Phase 0 前 3–5 天，**先证伪再往下写**。
- **子风险：Electron 内嵌 Node 是否暴露 `node:sqlite`，未经验证**（打包型运行时常裁剪可选内置模块）。**已用架构消解**：`node:sqlite` 仅在独立 `opc-hub`（系统 Node 24）内使用，Electron 侧一律经 IPC 取数，并用 lint + 分目录 tsconfig 编译期强制（§5.6.1）。**若取消独立 Hub，D6 必须直接改判 D6-b。**
- 无论选哪个：**锁定 Node 主版本（24 LTS）并在 CI 用 `actions/setup-node` 固定**，禁止开发机随意升 Node。
- **FTS5 中文检索的既定事实**：`tokenize='trigram'` 实测可命中"覆盖率"（默认 unicode61 命中 0），但对短子串（实测"件通"）仍不命中 → **搜索实现为 trigram 命中 + `LIKE '%…%'` 兜底双路**（附录 C.3），并把该约束写进回放视图的搜索 UI（提示"建议 ≥3 字关键词"）。
- 备份路径写死为 `VACUUM INTO`（实测可用），**不要在代码里调 `db.backup()`**（该 API 不存在）。

## 风险 13：Electron 的内存与安装包体积

**问题**：桌面壳用 Electron，代价是壳常驻内存 100MB 量级、安装包 80–200MB；轻量壳（Tauri 等）可压到 ~20MB / 2–10MB，但要写 Rust。**本设计用资源换语言统一**，这是明确付出的成本，不是免费的。

**缓解与量化**：
- §5.2 已论证：常态负载的内存主导项是 **harness 子进程（每个百 MB 量级）+ LangGraph 运行时 + 多角色上下文**，壳层的 +80MB 占比为个位数百分比。
- **把 §5.2-B 的 Web 前端当作减压阀**：对内存敏感的机器，浏览器直接访问 Hub 即可（同一套 React 组件），Electron 变成可选壳而非必需。
- 安装包体积用 electron-builder 的 **NSIS 压缩 + 分平台产物**控制；harness 二进制**不打进安装包**（首次运行时按需校验/引导用户安装，见 §12 前置检查）。
- **本设计的既定立场**：若 Electron 的常驻内存日后成为真实投诉点，**迁移路径是 Web 化（§5.2-B），不是再写一遍别的语言的壳**。这条写死，避免未来在压力下开第二条语言栈。

---

# 25. 待 CEO 拍板的设计取舍清单

以下 9 项是**本设计中仍未定、且必须由 CEO 本人拍板**的取舍。文档给出建议默认值，但决策权不在工程侧。

| # | 取舍 | 备选项 | 建议默认 | 出处 |
|---|---|---|---|---|
| 1 | **IM 接入优先级** | 飞书优先 + 企微次之 + QQ 只读 + 个人微信不接入 / 只做 Web PWA + Web Push | **飞书优先**（长连接免公网 IP、卡片交互最完整）；若协作网络不在飞书，则移动端 PWA 作审批主通道、IM 只做通知。Railse OPC 第一版把飞书与 Telegram 列为非目标，是**值得认真考虑的保守起点** | 讨论第 6 轮 · 取舍一 |
| 2 | **会议的实时性** | 全部实时流式群聊 / 评审会异步 + 辩论会回合制 + 决策会异步文档流 | **后者**。不追求让所有 agent 实时流式开会 —— 那会制造大量不需要阅读的噪音。会议价值在于**结构化产出**，不在于热闹 | 讨论第 6 轮 · 取舍二 |
| 3 | **看板的复杂度** | 六列看板作主界面 / 降级为只读层级状态概览并放到二级页面 | 若真实行为模式是“只看审批和回放”，则把最多空间给“需要你决策”与“想法输入”，**看板是备查工具不是主界面** | 讨论第 6 轮 · 取舍三 |
| 4 | **组织图布局策略** | A 纯自由布局 / B Dagre 自动布局 + 锁定 / C 混合 | **方案 C**：默认自动布局，拖拽后该节点转手动模式，提供“恢复自动布局”一键重置 | 讨论第 14 轮 |
| 5 | **移动端数据方案** | A 纯 RPC / B 只读副本 + 增量同步 / C 移动端延后 | **选项 A**（v1.0 不做多端同步）；若飞书审批已够用，选项 C 可接受 | 讨论第 12 轮 |
| **D6** | **SQLite 驱动**（**阻塞 Phase 0**） | **a** 全用内置 `node:sqlite` + 自研 Checkpoint Saver / **b** 全用 `better-sqlite3`（官方 SqliteSaver 直接用）/ **c** 混合（业务表 a + Checkpoint b，两个 db 文件） | **建议 a**：整个二进制零原生依赖，Windows 打包免 MSVC、Electron 升版免 `@electron/rebuild`，代价是先花 3–5 天写并测 Saver。**c 明令禁止** —— 跨 db 文件无法与 `events` 同事务提交，直接击穿 §6.3 审计完整性（风险 6）。**b 作为 a 失败时的退路**（成本可控，只是 CI 变脏） | §5.6、风险 12 |
| **D7** | **编排框架**（Phase 0 之后触发） | **a** LangGraph.js / **b** Mastra（`@mastra/core` 1.82.0，TS 原生）/ **c** 自研极薄图执行器 | **默认 a**；仅当 §5.4 五项 PoC 门禁失败才评估 b。**c 是最后手段**：需自实现 Checkpoint 语义、重放、并发合并、中断恢复，估 3–4 周且长尾 bug 多 | §5.4、风险 11 |
| **D8** | **桌面壳 vs Web 化** | A Electron 壳 / B 纯 Web（Hub + 浏览器）/ C 两者并行 | **建议 C 并行**：Electron 提供系统集成（托盘、通知、自启），Hub 的 HTTP+SSE 顺带白送一个零成本 Web 前端 —— 它同时是 §5.2 内存代价的减压阀与风险 13 的兜底 | §5.2、§5.7 |
| **D9** | **Hub 部署位置** | 桌面机 / 常驻小主机（VPS、树莓派、家用 NAS）/ 先桌面机后迁移 | **建议从一开始就问自己**：能否接受"桌面机关机 = 公司停摆"？若否，**第一天就让 Hub 常驻**，Electron 只当 UI。语言统一让这件事从"v1.1 工程项"降级为"一条配置" | §5.3、风险 10 |

**D6 之所以阻塞 Phase 0**：Saver 的选择决定 §6.3"Checkpoint 与 events 同一事务"能否成立、决定 CI 是否需要 MSVC、决定 Windows 开发者第一天装什么。**在 D6 定案前不要开始写业务代码。**

**Q3 原文（供决策参考）**：“六列看板是给‘想管理’的 CEO 看的。如果你的实际行为模式是‘只看审批和回放’，看板可以降级为一个只读的层级状态概览（每层显示活跃数 / 阻塞数），完整看板放在二级页面。”

---

# 附录 B　关键配置示例

## B.1 岗位书：测试工程师

```yaml
role_id: test_engineer
display_name: 测试工程师
reports_to: tech_director
acceptance_criteria:
  - condition: "coverage < 0.90"
    action: "reject"
    message: "覆盖率不足90%，不得标记通过"
  - condition: "p0_defect_count > 0"
    action: "escalate"
    target: tech_director
    message: "P0缺陷必须升级，不经过开发自我判定"
forbidden_actions:
  - "approve_own_work"
  - "modify_source_code"
  - "merge_to_main"
tool_permissions:
  - "read_repo"
  - "run_tests"
  - "create_review_report"
model_tier: execution            # 执行层模型
budget:
  daily_usd: 15
  per_task_usd: 5
escalation_triggers:
  - "review_conflict_rounds >= 3"
  - "irreversible_action_detected"
  - "budget_threshold_reached"
# ↓ 决策范围与判断模式（§4）
decision_scope:
  autonomous: ["测试用例设计", "测试环境配置", "缺陷等级判定(P0/P1/P2)"]
  requires_consultation: ["跨模块集成测试范围变更 → consult: tech_director"]
  forbidden: ["修改源代码", "自行放行P0缺陷", "合并到主干"]
judgment_mode:
  type: "bounded_judgment"
  strict_rules: ["coverage < 0.90 → reject", "p0_defect > 0 → escalate"]
  bounded_judgment: ["P2缺陷是否可接受上线（需附风险评估）"]
  full_discretion: []
dissent_rights:
  can_challenge: ["开发提交根因报告的任何条目（附具体依据）", "审阅者的打回理由（附反驳证据）"]
  cannot_challenge: ["CEO的最终拍板（但可以记录保留意见）"]
  escalation_path: "debate_meeting"
harness_defaults:
  codex:
    sandbox: "read-only"
    approval_policy: "never"
    forbidden_flags: ["--full-auto", "--yolo"]
budget_discretion:
  daily_usd: 15
  can_reallocate_within_role: true
  cannot_exceed: true
untrusted_inputs:               # §12.6 “不可信输入”原则
  - "developer.self_test_claim"
  - "developer.boundary_coverage_claim"
```

## B.2 岗位书：产品经理

```yaml
role_id: product_manager
display_name: 产品经理
reports_to: product_director
cognitive_skill: "leijun-skill-v2"   # 可替换（§14）
acceptance_criteria:
  - condition: "prd_items_without_source > 0"
    action: "reject"
    message: "每条需求必须附带来源标记（章程条款或调研引用）"
  - condition: "search_required == true AND source_citations == 0"
    action: "reject"
    message: "强制搜索领域必须附带可追溯来源"
forbidden_actions:
  - "propose_tech_stack"
  - "estimate_engineering_cost"
  - "approve_own_prd"
tool_permissions:
  - "read_charter"
  - "web_search"              # 受三层搜索策略约束（§13.3）
  - "create_prd_bundle"
model_tier: management
budget:
  daily_usd: 10
  per_task_usd: 3
escalation_triggers:
  - "tech_director_rejects_same_item >= 2"
  - "research_cost > 0.3 * task_budget"
stance: "确保方案满足业务需求，不接受“技术上难做”的借口"   # 门控中作为约束注入
research_subgraph:                # §13.1 并行研究子图
  planner: true
  parallel_search: true
  review_cluster: true
  writer_summary: true
```

## B.3 岗位书：技术总监（节选）

```yaml
role_id: tech_director
display_name: 技术总监
reports_to: chief_of_staff
model_tier: management
stance: "确保方案可落地：评估并发、数据一致性、回滚能力，对“拍脑袋方案”零容忍"
decision_scope:
  autonomous:
    - "技术栈选型（在已批准的技术雷达范围内）"
    - "工程任务拆解粒度"
    - "开发资源在任务间的分配（在角色预算内）"
    - "技术风险等级判定（P0/P1/P2）"
  requires_consultation:
    - "引入新技术雷达外的依赖 → consult: architect"
    - "跨季度架构变更 → consult: ceo"
  forbidden:
    - "修改产品需求优先级"
    - "直接操作生产环境"
    - "绕过测试门控标记任务完成"
search_policy:                     # §13.3
  tier_1_mandatory: ["framework_version_compat", "api_deprecation", "security_advisory", "benchmark"]
  tier_2_conditional: true
  tier_3_budget_downgrade_ratio: 0.15
deliverables:
  - "engineering_task_list（输入/输出/验收方式/风险等级）"
  - "adr（含备选方案与选择理由）"
  - "risk_register（每条附缓解策略）"
```

## B.4 委派规则边：产品 → 技术

```yaml
edge:
  from: product_director
  to: tech_director
  handoff_artifact: prd_evidence_bundle
  review_gate:
    reviewer: tech_director
    pass_conditions:
      - "every_requirement_has_feasibility_judgment"
      - "every_conditional_judgment_has_cost_estimate"
      - "no_requirement_marked_infeasible_without_technical_basis"
    reject_conditions:
      - "missing_feasibility_judgment"
      - "infeasible_without_basis"
    escalate_conditions:
      - "product_director_disputes_tech_judgment"
    max_rounds: 3
    veto_power:
      can_reject: true
      rejection_requires: "technical_basis"
      max_rejections: 3
      escalation_on_exceed: "ceo"
  parallel_allowed: false
```

## B.5 委派规则边：开发 → 测试

```yaml
edge:
  from: dev_engineer
  to: test_engineer
  handoff_artifact: code_diff_bundle
  review_gate:
    reviewer: test_engineer
    independent_verifier_harness_family: "codex"    # §24 风险1：与开发不同模型家族
    pass_conditions:
      - "coverage >= 0.90"
      - "p0_defect_count == 0"
      - "reproduction_case_executed_by_reviewer"
    reject_conditions:
      - "coverage < 0.90"
      - "missing_self_test_evidence"
    escalate_conditions:
      - "p0_defect_count > 0"
      - "review_conflict_rounds >= 3"
    max_rounds: 3
  parallel_allowed: false
```

## B.6 审批卡片示例（升级到 CEO）

```json
{
  "approval_type": "strategic",
  "summary": "开发完成支付模块，测试覆盖率92%，技术总监标记'有条件通过'，等待确认是否接受剩余3个P2缺陷上线",
  "parameters": {
    "task_id": "tsk_abc123",
    "coverage": 0.92,
    "p2_defect_count": 3,
    "irreversible": true,
    "impact_scope": "生产环境支付模块",
    "recommendation": "建议批准上线，P2缺陷进入下一迭代",
    "recommendation_source": "tech_director"
  },
  "timeout_behavior": "auto_reject",
  "timeout_hours": 8
}
```

## B.7 策略引擎规则

```yaml
rules:
  - name: "auto_approve_read_only"
    condition: "action.type in ['read_file', 'run_test', 'create_branch']"
    decision: "auto_approve"
  - name: "auto_approve_pattern_based"
    condition: "action.type == 'reversible_edit' AND historical_approval_rate >= 0.9 AND action.reversible == true"
    decision: "auto_approve_with_log"
  - name: "require_human_irreversible"
    condition: "action.irreversible == true OR action.external_side_effect == true"
    decision: "require_human"
  - name: "budget_hard_stop"
    condition: "role.consumed_usd >= role.budget_limit"
    decision: "pause_and_escalate"
```

## B.8 Harness 调用参数模板

```yaml
# 缺陷修复：只读分析阶段
codex_root_cause:
  cmd: 'codex exec -C {repo} --sandbox read-only --ask-for-approval never "{prompt}"'
  prompt: "分析{bug}的根因，输出根因假设和修复建议，不修改文件"
# 缺陷修复：受限写入阶段
codex_fix:
  cmd: 'codex exec -C {repo} --sandbox workspace-write --ask-for-approval never "{prompt}"'
  prompt: "根据根因报告修复{bug}，运行相关测试，记录未解决的阻塞"
# Claude Code 等价调用
claude_edit:
  cmd: 'claude -p "{prompt}" --allowedTools "Read,Edit,Bash" --bare'
  env: ["ANTHROPIC_API_KEY"]
# 测试：隔离工作区独立验证
claude_test_isolated:
  cmd: 'claude -p "在 /tmp/test-workspace 运行完整测试套件，输出覆盖率报告和未通过项清单" --allowedTools "Read,Bash" --bare'
# 对抗性审查（第二个模型家族）
codex_adversarial_review:
  cmd: 'codex exec --sandbox read-only --ask-for-approval never "审查{repo}以下改动，寻找边界条件缺失、并发问题、错误处理漏洞：{diff}"'
```

## B.9 Channel 归一化消息

```json
{ "NormalizedMessage": { "platform": "feishu", "sender": "ou_ceo", "chat_id": "oc_ceo_dm",
  "text": "同意", "mentioned_bot": false, "message_type": "text",
  "signature_verified": true, "one_time_token": "ot_9f3c..." } }

{ "ApprovalCard": { "approval_id": "apr_042", "approval_type": "strategic",
  "summary_line": "……", "parameters": {}, "recommendation": "……(推荐，非决定)",
  "actions": ["approve", "reject", "defer"], "irreversible": true,
  "allowed_platforms": ["desktop", "mobile"], "im_locked": true } }
```

---

# 附录 C　SQLite 建表脚本 · 驱动实测 · 中文检索实测

> 类型映射遵循 §6.1：UUID→TEXT、TIMESTAMPTZ→INTEGER（Unix 毫秒）、NUMERIC→INTEGER（美分）、JSONB→TEXT、BOOLEAN→INTEGER(0/1)。
>
> **驱动中立**：以下 DDL 在 `node:sqlite`（Node 24.21.0 / SQLite 3.53.4 实测通过）与 `better-sqlite3` 上**完全一致**，不依赖任何一方的私有扩展 —— 因此 §5.6 的 D6 判定**事后可以改判而不必重做 schema**。实测覆盖：append-only 触发器（`RAISE(ABORT)` 拦下 UPDATE 与 DELETE）、FTS5、json1（`json_extract`）、`VACUUM INTO` 快照、`PRAGMA integrity_check`。
>
> **一处驱动差异**：`node:sqlite` **不提供** `db.backup()`，备份只能用 `VACUUM INTO`（C.2 已按此写）。

```sql
-- ========== 全局 PRAGMA（每次连接时执行） ==========
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- ========== 任务 ==========
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                       -- UUID 字符串
  parent_id TEXT REFERENCES tasks(id),
  charter_id TEXT REFERENCES charters(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,                      -- 状态机枚举（§7.1）
  assigned_role TEXT NOT NULL,
  current_node TEXT NOT NULL,
  budget_cents INTEGER,                      -- 美分
  consumed_cents INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,               -- Unix 毫秒
  updated_at INTEGER NOT NULL,
  state_snapshot TEXT,                       -- JSON 字符串
  graph_checkpoint_id TEXT,
  graph_version INTEGER NOT NULL DEFAULT 1   -- 创建时组织图版本（§18.4）
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

-- ========== 事件日志（append-only） ==========
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(id),
  actor_type TEXT NOT NULL,                  -- 'agent' | 'human' | 'system'
  actor_id TEXT NOT NULL,                    -- role_id 或 'ceo'
  action TEXT NOT NULL,                      -- §22.1 枚举
  target TEXT,
  payload TEXT NOT NULL,                     -- JSON 字符串
  state_snapshot TEXT,                       -- 决定时的完整状态快照
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_task   ON events(task_id, created_at);
CREATE INDEX idx_events_action ON events(action, created_at);

-- 强制 append-only：禁止 UPDATE 和 DELETE（node:sqlite 实测：UPDATE/DELETE 均被成功拦截）
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events table is append-only'); END;

-- 全文搜索（替代 PG 全文索引）
-- ⚠ 分词器必须显式指定：默认 unicode61 对中文连续串按"整串一词"处理，
--   实测检索『覆盖率』命中 0；trigram 实测命中 1。见 C.3。
CREATE VIRTUAL TABLE events_fts USING fts5(
  payload,
  content='events',
  content_rowid='id',
  tokenize = 'trigram'
);
CREATE TRIGGER events_fts_insert AFTER INSERT ON events
BEGIN INSERT INTO events_fts(rowid, payload) VALUES (new.id, new.payload); END;

-- 删除/更新事件表时同步 FTS（external content 表必须手工维护）
CREATE TRIGGER events_fts_ad AFTER DELETE ON events
BEGIN INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload); END;
CREATE TRIGGER events_fts_au AFTER UPDATE ON events
BEGIN
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('delete', old.id, old.payload);
  INSERT INTO events_fts(events_fts, rowid, payload) VALUES('insert', new.id, new.payload);
END;
-- 注：events 上的 no_update/no_delete 触发器会先 RAISE(ABORT)，
--     因此这两个同步触发器实际是为"未来若放宽约束"预留，正常运行期不会被触发。

-- ========== 证据包 ==========
CREATE TABLE evidence_bundles (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  producer_role TEXT NOT NULL,
  bundle_type TEXT NOT NULL,                 -- 'prd'|'tech_plan'|'code_diff'|'test_report'|'content_package'
  artifacts TEXT NOT NULL,                   -- JSON: 文件路径 / sha256 / 外部链接
  self_check TEXT,                           -- JSON（标注“自检，非独立验证”）
  created_at INTEGER NOT NULL
);

-- ========== 审阅门控 ==========
CREATE TABLE review_gates (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  gate_type TEXT NOT NULL,                   -- 'product_to_tech'|'tech_to_dev'|'dev_to_test'|'test_upward'…
  reviewer_role TEXT NOT NULL,
  reviewer_model_family TEXT,                -- §24 风险1：审阅共谋分析
  evidence_bundle_id TEXT REFERENCES evidence_bundles(id),
  decision TEXT,                             -- 'approved'|'rejected'|'conditional'|'escalated'
  decision_reason TEXT,
  conditions TEXT,                           -- JSON 数组（有条件通过的条件清单）
  round_no INTEGER,
  decided_at INTEGER
);
CREATE INDEX idx_gates_task ON review_gates(task_id);

-- ========== CEO 审批收件箱 ==========
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  approval_type TEXT NOT NULL,               -- 'charter'|'strategic'|'irreversible_action'|'budget_override'|'meeting_escalation'
  summary TEXT NOT NULL,                     -- 一行摘要
  parameters TEXT NOT NULL,                  -- JSON: 金额/影响范围/不可逆性标记
  recommendation TEXT,                       -- 标注“推荐，非决定”
  recommendation_source TEXT,
  timeout_behavior TEXT,                     -- 'auto_approve'|'auto_reject'|'escalate'
  timeout_at INTEGER,
  status TEXT DEFAULT 'pending',             -- 'pending'|'approved'|'rejected'|'deferred'
  decided_by TEXT,
  decided_at INTEGER,
  decision_note TEXT
);
CREATE INDEX idx_approvals_status ON approvals(status, timeout_at);

-- ========== 岗位书（版本化） ==========
CREATE TABLE role_charters (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  config TEXT NOT NULL,                      -- 完整岗位书 YAML 的 JSON 表示
  effective_from INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(role_id, version)
);

-- ========== 委派 / 组织图（版本化，§18.4） ==========
CREATE TABLE delegation_graphs (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  graph_json TEXT NOT NULL,                  -- nodes + edges + gates 完整序列化
  effective_from INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  change_summary TEXT,
  UNIQUE(version)
);

-- ========== 预算（三级） ==========
CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,                  -- 'company'|'role'|'task'
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,                      -- 'daily'|'monthly'|'per_task'
  limit_cents INTEGER NOT NULL,
  consumed_cents INTEGER DEFAULT 0,
  hard_stop INTEGER DEFAULT 1
);
CREATE UNIQUE INDEX idx_budgets_scope ON budgets(scope_type, scope_id, period);

-- ========== 信任积分（§4.4） ==========
CREATE TABLE trust_scores (
  role_id TEXT PRIMARY KEY REFERENCES role_charters(role_id),
  current REAL NOT NULL,
  history_window INTEGER NOT NULL DEFAULT 50,
  components TEXT NOT NULL,                  -- JSON
  pending_change_id TEXT,                    -- 待 CEO 批准的调整建议
  updated_at INTEGER NOT NULL
);

-- ========== 章程 ==========
CREATE TABLE charters (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  business_goal TEXT NOT NULL,
  success_criteria TEXT NOT NULL,            -- JSON 数组：3 条可量化标准
  budget_cents INTEGER,
  deadline INTEGER,
  initial_roles TEXT,                        -- JSON
  approved_by TEXT, approved_at INTEGER
);

-- ========== 会议（§10） ==========
CREATE TABLE meetings (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  meeting_type TEXT NOT NULL,                -- 'review'|'debate'|'decision'
  participants TEXT NOT NULL,                -- JSON
  convergence_score REAL,                    -- 辩论会收敛度
  consensus TEXT, divergences TEXT,          -- JSON
  escalation_path TEXT,
  created_at INTEGER NOT NULL
);

-- ========== 文件制品索引（§6.4） ==========
CREATE TABLE artifacts_meta (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  kind TEXT NOT NULL,                        -- 'prd'|'code_diff'|'test_report'|'content_package'
  rel_path TEXT NOT NULL,                    -- artifacts/{task_id}/{kind}/{bundle_id}.*
  sha256 TEXT NOT NULL,
  size_bytes INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_artifacts_task ON artifacts_meta(task_id, kind);

-- ========== Skills 挂载记录（§14.3） ==========
CREATE TABLE skill_mounts (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,                    -- 如 'leijun-skill-v2'
  skill_version TEXT NOT NULL,
  source TEXT,                               -- 来源与蒸馏者
  honesty_boundaries TEXT,                   -- JSON：诚实边界
  mounted_from INTEGER NOT NULL, mounted_to INTEGER,
  mounted_by TEXT NOT NULL                   -- 只有 CEO 可挂载/卸载
);

-- ========== Harness 调用（§12.7 第4层） ==========
CREATE TABLE harness_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT, agent_role TEXT NOT NULL,
  harness TEXT NOT NULL, harness_version TEXT NOT NULL,
  args_redacted TEXT NOT NULL,               -- 脱敏后参数
  session_id TEXT, exit_code INTEGER,
  diff_sha256 TEXT, cost_cents INTEGER,
  verified_by_gate TEXT,                     -- 对应测试门控 id
  created_at INTEGER NOT NULL
);

-- ========== IM 通道（§11.3） ==========
CREATE TABLE im_bindings (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,                    -- 'feishu'|'wecom'|'qq'
  external_user_id TEXT NOT NULL,
  ceo_role TEXT NOT NULL DEFAULT 'ceo',
  verified INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE im_tokens (
  token TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0
);

-- ========== 预算/凭证分离（§20.4） ==========
CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,                  -- 加密 at rest，仅 Hub 层可读
  created_at INTEGER NOT NULL
);
```

## C.1 LangGraph Checkpoint

| 方案 | 包 | 驱动 | 说明 |
|---|---|---|---|
| **官方 Saver（对应 D6-b）** | `@langchain/langgraph-checkpoint-sqlite` **1.1.0** | `better-sqlite3@^12.10.0`（**原生 addon**，engines: node >=18） | 开箱可用；它自建 `checkpoints` / `writes` 系列表，**与上表同库不同表** |
| **自研 Saver（D6-a，建议）** | 实现 `@langchain/langgraph-checkpoint`（1.2.2）的 `BaseCheckpointSaver` | `node:sqlite`（内置，零原生依赖） | 自建同名表结构以保持与官方 Saver 的可迁移性（§6 / §5.6）；**必须与 `INSERT INTO events` 落在同一事务**（§6.3、风险 6） |

**运行时的真正风险**：LangGraph.js 跑在单线程事件循环上，而 `node:sqlite` 与 `better-sqlite3` **都是同步 API** —— 单条毫秒级查询无碍，但**扫大表的查询会冻结整个 Hub**（UI 无响应、心跳停摆）：`node:sqlite` 与 `better-sqlite3` 都是**同步 API**，单条毫秒级无碍，但**回放/全文搜索这类扫大表的查询会冻结 UI 与心跳**。处理：
- 大查询（回放时间线、FTS 检索、完整性扫描）走 **`worker_threads`** 或独立的只读连接 + 分页；
- 所有写入走 §5.5 写队列，且**批量事务**（实测：事务内 2000 条 5ms；逐条自动提交 2ms/条 —— 差 4 个数量级，§6.5）；
- 严禁在 UI 进程里直接跑 `integrity_check` 之类的全库扫描。

## C.2 备份与完整性（§6.5、§24 风险 8、§24 风险 12）

```sql
-- 每日一致性快照（不锁写，比 cp 更安全；实测在 node:sqlite 可用，生成 45056 字节）
-- ⚠ node:sqlite 不提供 db.backup()，这是唯一可用的在线备份路径
VACUUM INTO '~/.opc-os/backups/opc-{date}.db';

-- 启动时自检
PRAGMA integrity_check;      -- 期望返回 ok，否则提示从最近备份恢复

-- FTS 索引重建（Phase 6；注意 trigram 重建后需重跑中文检索冒烟测试）
INSERT INTO events_fts(events_fts) VALUES('rebuild');
```

```ts
// 写串行化：Hub 进程内唯一 writer（§5.5）—— node:sqlite 版本，零原生依赖
import { DatabaseSync } from "node:sqlite";

type Job = { sql: string; params: unknown[]; resolve: (v: void) => void; reject: (e: unknown) => void };

export class WriteQueue {
  #q: Job[] = [];
  #running = false;
  #db: DatabaseSync;

  constructor(dbPath: string) {
    this.#db = new DatabaseSync(dbPath);
    // 实测：journal_mode 返回 "wal"；busy_timeout 返回 { timeout: 5000 }
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA busy_timeout = 5000");
    this.#db.exec("PRAGMA synchronous = NORMAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
  }

  /** 单事务提交：Checkpoint + events + 预算累计 —— 缺一则审计回放出现"状态变了但没日志" */
  tx(stmts: Array<[string, unknown[]]>): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#q.push({ sql: JSON.stringify(stmts), params: [], resolve, reject });
      void this.#drain();
    });
  }

  async #drain(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    while (this.#q.length) {
      const job = this.#q.shift()!;
      const stmts: Array<[string, unknown[]]> = JSON.parse(job.sql);
      try {
        this.#db.exec("BEGIN IMMEDIATE");           // 立即取写锁，避免升级为死锁
        for (const [sql, params] of stmts) this.#db.prepare(sql).run(...(params as never[]));
        this.#db.exec("COMMIT");
        job.resolve(undefined);
      } catch (e) {
        try { this.#db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
        job.reject(e);                               // 失败上抛 → 风险 6：宁可停,不可丢事件
      }
    }
    this.#running = false;
  }
}
```

> **为什么不用 `db.function()` 或触发器做预算扣减**：`node:sqlite` 支持 `db.function()` 注册自定义函数（实测存在），但把业务规则塞进 SQL 会让"门控是确定性代码可单测"（风险 5）失效 —— **业务规则留在 TS，SQLite 只承担存储与不可变性约束**。

## C.3 事件全文检索：中文分词的实测与既定方案

本机对 `node:sqlite`（SQLite 3.53.4）实测（原文数据见 §5.6 表）：

| 检索式 | 分词器 | 命中 |
|---|---|---|
| `MATCH '覆盖率'` | 默认 unicode61 | **0** ← 不可用 |
| `MATCH '支付模块覆盖率92*'` | unicode61 + 前缀 | 1（必须整串打头） |
| `MATCH '覆盖率'` | `trigram` | **1** ← 可用 |
| `MATCH '件通'`（2 字子串） | `trigram` | **0** ← trigram 需 ≥3 字符 |
| `payload LIKE '%覆盖率%'` | — | **1** ← 兜底可用 |

**既定实现（写进回放视图搜索，不做事后诸葛）**：

```ts
// 三档策略：FTS(trigram) 优先，短查询与 0 命中时降级 LIKE
export function searchEvents(kw: string, limit: number) {
  const clean = kw.replace(/[\"]/g, '""');
  if ([...clean].length >= 3) {
    const hit = db.prepare(
      "SELECT rowid FROM events_fts WHERE events_fts MATCH ? LIMIT ?"
    ).all(`"${clean}"`, limit);          // trigram：短语查询，实测命中
    if (hit.length) return hydrate(hit);
  }
  return db.prepare(                     // LIKE 兜底：全表扫，配合时间/类型过滤收窄
    "SELECT id FROM events WHERE payload LIKE ? ORDER BY created_at DESC LIMIT ?"
  ).all(`%${clean}%`, limit);
}
```

**UI 约束**：回放搜索框提示"关键词建议 ≥3 个汉字"；搜索走只读连接 + 分页，必要时 `worker_threads`（C.1）。
**若采纳 D6-b（better-sqlite3）**：其捆绑的 SQLite 版本由包决定，**上线前须用同样的三条用例重跑本表**，不得假定行为一致。

---

# 附录 D　术语表

| 术语 | 定义 |
|---|---|
| **OPC-OS** | One-Person-Company OS，一人公司操作系统 |
| **CEO** | 唯一人类决策者（产品经理型创始人），只负责产生想法与战略拍板 |
| **CoS / 助理** | Chief of Staff，呈交章程与升级事项、过滤噪音、记录会议 |
| **Charter（章程）** | 想法被结构化后的任务契约：业务目标 + 3 条可量化成功标准 + 预算上限 + 时间约束 + 初始团队角色 |
| **岗位书（Role Charter）** | 角色的结构化定义：验收标准、禁止事项、决策空间、判断模式、工具权限、预算、升级触发条件；版本化，变更仅对新任务生效 |
| **委派规则图** | 角色为节点、交接为边的有向图，与 LangGraph 图结构一一对应；版本化存储在 `delegation_graphs` |
| **证据包（Evidence Bundle）** | 向上交接必须附带的**可验证引用**集合（不是“总结”），制品落文件、DB 存路径 + sha256 |
| **审阅门控（Review Gate）** | 委派边上的强制检查点：审阅者必须查看证据包后显式决定（通过 / 打回 / 升级）；由**确定性代码**执行，不依赖 LLM |
| **作者不给自己打分** | 图结构硬约束：节点产出不能由其自身或其后继节点标记“通过”上移，必经独立审阅节点 |
| **升级路由（Escalation Routing）** | 把真正需要 CEO 的事项送入审批收件箱的触发规则（审阅 N 轮未收敛、预算硬停、不可逆动作、战略不确定性） |
| **策略引擎** | 审批前置规则引擎：自动放行 / 模式自动通过 / 必须人工 三级分类 |
| **Harness** | 外部编码代理 CLI/SDK（Claude Code、Codex、Qoder、Kimi Code、dsh 等） |
| **Harness Gateway** | 统一封装 harness 调用的薄层：`execute` / `resume` / `get_cost`，并强制执行不可覆盖的沙箱与禁止参数。**默认走官方 TS SDK（claude-agent-sdk / codex-sdk / qoder-agent-sdk），CLI 为兜底**（§12.1） |
| **AG-UI / MCP / A2A** | 三层协议：Agent↔用户（SSE 事件）、Agent↔工具数据、Agent↔Agent 协调 |
| **Skills（认知 skill）** | 角色蒸馏得到的认知框架（心智模型、决策启发式、表达 DNA、反模式、诚实边界）；**可替换的认知输入层，不是权力层** |
| **信任积分（Trust Score）** | 基于历史表现（审阅通过率、升级准确率、越权次数、回滚率）的 0–1 分数，用于生成**建议**放宽/收紧，须经 CEO 批准 |
| **越权尝试（unauthorized_attempt）** | Agent 触碰 `forbidden_actions` 或 `forbidden_flags` 被 Gateway 拦截的事件 |
| **三层折叠** | 任何任务在 CEO 面前只展示：一行摘要 → 关键指标与证据摘要 → 完整产出 |
| **心跳（Heartbeat）** | 默认 15 分钟一轮的停滞检查与追问，绑定 LangGraph 节点状态并保存快照 |
| **预算硬停** | 任一层级预算达阈值即自动暂停 agent，并在收件箱生成**非琥珀色**卡片 |
| **FTS5** | SQLite 内置全文搜索虚拟表，用于事件日志检索 |
| **WAL** | SQLite 的 Write-Ahead Logging 模式，读不阻塞写 |
| **单写者（Single Writer）** | 任一时刻只有一个主体能写 SQLite 的架构原则。本设计中 = `opc-hub` 进程内的写队列（§5.5）；若拆分进程则写权限**整体**迁移到新主体，写者数量恒为 1（风险 9） |
| **`opc-hub`** | 常驻 Node 守护进程：编排 + Agent 运行时 + Harness Gateway + MCP + Channel + 写者 + 事件广播。**Hub 才是本体，桌面壳与浏览器只是它的 UI 客户端**（§5.1、§5.3） |
| **node:sqlite** | Node 内置 SQLite 驱动（本机实测 Node 24.21.0 / SQLite 3.53.4）。**零原生依赖**；实验性；无 `db.backup()`；FTS5 默认分词不适配中文 → §5.6、C.3、风险 12 |
| **trigram** | FTS5 分词器，按 3 字符滑窗索引，是中文事件检索的**必要条件**（≥3 字符），仍需 LIKE 兜底（C.3） |
| **PoC 门禁** | Phase 0 第 0 天的五项 LangGraph.js 验证（§5.4），未通过则触发 §25-D7 框架替换 |

---

**文档结束。**

> **下一步建议**：从 Phase 0 的“最小可运行图”（想法 → 章程 → 产品拆解 → 技术拆解 → 开发 → 测试 → 上报，线性无分支）开始，用预设岗位书模板跑通一个端到端测试任务，再逐步加入审阅门控、策略引擎和前端。**Phase 1 之前，请务必先把每个角色的“什么叫做完了、什么叫做合格、什么情况下才应该来找 CEO”写进岗位书 —— 这是整个系统能否成立的前提。**
