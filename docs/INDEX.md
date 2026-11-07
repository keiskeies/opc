# 文档索引

需求权威来源：`docs/OPC-OS-设计文档.md`（当前设计的唯一权威表述）。

## 决策记录（`decisions/`）

每条都带实测证据与变异测试记录，是「为什么这样实现」的唯一出处；改实现前先读对应条目。

- **0001** SQLite 驱动：选 D6-a（node:sqlite + 自研 Checkpoint Saver）
- **0003** Checkpoint 与 events 的事务作用域：原方案成立（ALS 贯穿框架调度）—— Task 0.4a / 0.4b
- **0004** 迁移 SQL 机械取自附录 C；写队列偏离 C.2 四处；SQLite 对少绑参数【不设防】—— Task 0.5
- **0005** 超步边界只有 `Saver.put`；审计的 seq 只能来自 `events.id`；interrupt 不走异常 —— Task 0.6
- **0006** CLI 的恢复语义（`invoke(null)` vs `Command(resume)`，先读 `state.interrupts` 再选）；幂等契约改写；`thread_id = task_id` 的取舍与重新决定的判据 —— Task 0.10

> 编号不连续：**0002 从未创建** —— `git log --all` 的全部历史里既没有该文件，提交消息中也无痕迹。
> 没有记录理由，也不补号；现有编号 0001 / 0003 / 0004 / 0005 按号引用即可。

## Spec 声明

```json
{
  "slug": "opc-os-dev-plan",
  "title": "OPC-OS 开发计划（需求文档拆分为可执行阶段计划）",
  "type": "design",
  "status": "draft",
  "spec_path": "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md",
  "implemented_by": null,
  "verified_by": null,
  "supersedes": [],
  "last_reviewed": null
}
```
