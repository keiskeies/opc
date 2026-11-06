# OPC-OS

自托管的一人公司控制台：单文件 SQLite + LangGraph.js 编排 + 审阅门控 + 证据包。

- **需求权威**：[`docs/OPC-OS-设计文档.md`](docs/OPC-OS-设计文档.md)
- **开发计划**：[`docs/superpowers/plans/2026-11-06-opc-os-development-plan.md`](docs/superpowers/plans/2026-11-06-opc-os-development-plan.md)（58 个任务，7 个 Phase）
- **决策记录**：[`docs/decisions/`](docs/decisions/)（D6 SQLite 驱动 = `node:sqlite` 已定案）
- **实测证据**：[`docs/superpowers/evidence/phase0-poc/`](docs/superpowers/evidence/phase0-poc/)

## 前置要求

- **Node 24 LTS**（主版本锁死；`node:sqlite` 为实验性内置模块，见决策 0001 §4）
- **pnpm 10**（`corepack enable`）

## 当前状态

Phase 0 / Task 0.1：仓库初始化，把 Phase-0 可行性验证固化为仓库内测试。

```bash
pnpm i
pnpm test            # 跑全部测试
```