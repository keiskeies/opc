/**
 * 测试夹具：门 4（§8.2 门控内核）要的那三格装配。
 *
 * ── 为什么要有这个文件 ──────────────────────────────────────────────
 * `DispatchDeps` 的 `gateCriteria` / `gateRoundNo` / `evidenceRoot` 三格是【必填】的，
 * 而必填的立场写在 dispatch.ts 那三段的注释里：可选 + 默认值会让「装配漏了一格」
 * 变成 TS 不响、测试照绿、只有真库看得见。于是每个直接 `makeDispatch({...})` 的
 * 测试都要回答这三格。
 *
 * 「必须回答」不等于「必须自己发明答案」。这里给的是【与 runtime.ts 同一个读法】：
 * 岗位书走 `gateCriteriaForRoleOrEmpty`，轮次走 `GATE_ROUND_NO_SQL` + 契约里那个
 * 方向名。测试若在这里手抄一句 `gateCriteria: () => []`，它测的门控就与产品跑的
 * 不是同一扇门 —— 那正是本仓最贵的那一族失效（夹具与装配漂移）。
 *
 * ── 为什么这里【没有】permissive 的假标准 ──────────────────────────
 * 不提供 `gateCriteria: () => [{...一定 satisfied}]` 那种替身。门 4 的结论必须由
 * 【这个角色真实的岗位书】决定：测试要让审阅过得去，正确做法是往库里存一份岗位书
 * （saveCharterVersion），也就是把这条不变量的载体补进夹具；而不是造一份
 * 「永远满足」的标准让门开 —— 那是把断言改成放行。
 *
 * 于是这里唯一的取值口径是「库里现在有什么」。今天 dev-seed 与测试库都不写
 * `role_charters`（实测 0 行），所以默认结论是 reject + 一张 `gate-blocked:` 卡
 * （CEO 口径「全量拦」）。
 *
 * ── evidenceRoot 为什么是参数而不是一句拼好的缺省 ──────────────────
 * 与 `DispatchDeps.evidenceRoot` 同条纪律（evidence/store.ts 量过的事故）：制品按
 * bundle_id 内容寻址、写完删不掉，所以根目录必须来自【调用方那个临时目录】。
 * 这里也不碰 `artifactsRoot()` —— 那会往真实用户的 HOME 里写。
 */
import type { DatabaseSync } from "node:sqlite";

import { ENGINE_REVIEW_GATE } from "@opc/contracts";
import { gateCriteriaForRoleOrEmpty } from "../../src/charter/store.js";
import type { DispatchDeps } from "../../src/engine/dispatch.js";
import { GATE_ROUND_NO_SQL } from "../../src/engine/runtime.js";

/**
 * 三格的读法。`db` 传测试手上那条连接即可（同一本库，读得到已提交的行）。
 *
 * ⚠ 与 runtime 的一处【刻意不同】：那边每次调用都 `read()` 取新连接，因为 CEO 可能
 * 在一轮中间存岗位书；这里复用调用方给的那条连接。这不影响结论 —— SQLite 同进程
 * 两条连接读到的都是已提交状态，而本仓测试是单写者队列（不存在并发写者）。
 */
export function gateDepsFrom(
  db: DatabaseSync,
  evidenceRoot: string,
): Pick<DispatchDeps, "gateCriteria" | "gateRoundNo" | "evidenceRoot"> {
  return {
    gateCriteria: (roleId) => gateCriteriaForRoleOrEmpty(db, roleId),
    gateRoundNo: (taskId) => {
      const row = db
        .prepare(GATE_ROUND_NO_SQL)
        .get(taskId, ENGINE_REVIEW_GATE) as { n: number | bigint } | undefined;
      return row === undefined ? 0 : Number(row.n);
    },
    evidenceRoot,
  };
}
