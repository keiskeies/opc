/**
 * 崩溃续跑测试的子进程（Task 0.8 验收 ③，复用 Task 0.1 的双进程手法）。
 *
 * 为什么必须是独立进程：process.kill 之后"重启续跑"要检验的是【新进程从已提交的
 * checkpoint + 已提交事件里恢复】。同进程内做这件事，内存里的总线、未落盘的
 * 写队列、模块级缓存都还在，测出来的"能续上"是假的。
 *
 * 为什么在这里 import 测试夹具而不是复制一份装配代码：桩模型和岗位书映射一旦有两份，
 * 子进程跑的就不是被测路径 —— 「已完成节点不重复执行」会退化成自我确认。
 *
 * 用法：tsx e2e-crash-child.ts --db <path> --thread <id> --idea <text>
 *        [--kill-after-nodes N]   第 N 次节点执行结束时 SIGKILL 自己
 *        [--kill-event-index K]   写完第 K 条状态边之后 SIGKILL 自己
 *      不带 kill 参数 = 续跑一整趟（LangGraph 从上一个已提交超步之后接着跑）。
 *
 * 建库与任务行由【父进程】预置：这样断言针对的是"子进程崩溃"，而不是建库成没成。
 * 这里的 migrate / INSERT OR IGNORE 只是防御 —— 崩溃恢复测试若在预置阶段就重建库，
 * 测的就不是恢复了。
 */

import { SqliteWALSaver } from "../../../src/checkpoint/saver.js";
import { openDb } from "../../../src/db/driver.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DomainEvent, EventBus } from "../../../src/events/bus.js";
import { SuperStepAuditor } from "../../../src/graph/audit-middleware.js";
import { buildCompanyGraph } from "../../../src/graph/company.js";
import { StubRegistry } from "../../../src/graph/stub-model.js";
import { loadPresetRoles } from "../../../src/roles/preset.js";

class ChildBus implements EventBus {
  publishPersisted(_e: DomainEvent, _seq: number): void {}
  latestSeq(): number {
    return 0;
  }
  subscribe(): never {
    throw new Error("子进程不订阅总线");
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

globalThis.fetch = (() => {
  throw new Error("NOT_ALLOWED：崩溃子进程同样不得联网");
}) as typeof fetch;

const dbPath = arg("db");
const threadId = arg("thread");
const idea = arg("idea") ?? "默认想法";
const taskId = arg("task") ?? "T-CRASH";
const killAfterNodesRaw = arg("kill-after-nodes");
const killEventIndexRaw = arg("kill-event-index");
if (dbPath === undefined || threadId === undefined) {
  console.error("CHILD-ERR 缺少 --db / --thread");
  process.exit(70);
}

const db = openDb(dbPath);
migrate(db);
db.exec("PRAGMA foreign_keys = ON");
db.prepare(
  "INSERT OR IGNORE INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
).run(
  taskId,
  idea,
  "CHARTER_PENDING",
  "assistant",
  "intake",
  1700000000000,
  1700000000000,
);

const auditor = new SuperStepAuditor({
  db,
  bus: new ChildBus(),
  now: () => 1700000000000,
});
const saver = auditor.instrumentSaver(new SqliteWALSaver(db));

/** 第 K 条状态边写完就杀：这是最狠的崩溃点 —— 事件已 INSERT、超步事务尚未提交。 */
let eventsSeen = 0;
let nodesSeen = 0;
const killAfterNodes =
  killAfterNodesRaw === undefined ? null : Number(killAfterNodesRaw);
const killEventIndex =
  killEventIndexRaw === undefined ? null : Number(killEventIndexRaw);

function maybeKill(): void {
  if (killAfterNodes !== null && nodesSeen >= killAfterNodes) {
    process.kill(process.pid, "SIGKILL");
  }
}

const graph = buildCompanyGraph({
  // 必须是构造 auditor 的【同一条连接】：超步事务就是这条连接上的 BEGIN。
  // 换成另一条连接，UPDATE tasks 会 autocommit —— 崩溃后 events 回滚而 tasks.status
  // 留下了，两者停在不同的超步，V3 当场假绿。
  db,
  recorder: auditor.recorder,
  saver,
  roles: loadPresetRoles(),
  models: new StubRegistry(),
  taskId,
  observe: {
    onNodeEnter: (node) => {
      console.log("CHILD-ENTER " + node);
    },
    onNodeExit: (node) => {
      nodesSeen += 1;
      console.log("CHILD-EXIT " + node + " n=" + nodesSeen);
      maybeKill();
    },
    onStatusEdge: (from, to) => {
      eventsSeen += 1;
      console.log("CHILD-EDGE " + from + "->" + to + " k=" + eventsSeen);
      if (killEventIndex !== null && eventsSeen >= killEventIndex) {
        /*
         * 崩溃前用【同一条连接】数一次 events —— 这条连接上正挂着超步事务，
         * 所以能看见本事务尚未提交的行。这个数字把两种本来无法区分的失败模式分开：
         *   「已写入但被回滚」= 回滚能力被检验了（V3 想要的）
         *   「压根没写入」    = 什么都没检验（假绿）
         * 实测依据：变异 onStatusEdge 到 recorder.record 之前时，父侧"库里剩几条"
         * 完全不变（0 条边也能满足），只有这个数字会掉 —— 见 0005 §15。
         */
        const seen = db
          .prepare("SELECT count(*) AS n FROM events WHERE task_id = ?")
          .get(taskId) as { n: number | null };
        console.log("CHILD-UNCOMMITTED n=" + String(seen.n));
        console.log("CHILD-KILL at k=" + eventsSeen);
        // 关键时机：recorder 已 INSERT，但超步事务还没提交。SIGKILL 不给任何 flush 机会，
        // 于是"这条边到底留没留下"完全由 SQLite 的事务原子性决定 —— 那正是 V3 要验的东西。
        process.kill(process.pid, "SIGKILL");
      }
    },
  },
});

const cfg = { configurable: { thread_id: threadId } };
const resumed = killAfterNodes === null && killEventIndex === null;
const input = resumed
  ? null
  : { idea, currentNode: "intake", current: "CHARTER_PENDING" };

/**
 * 装配要点（实测得来，两处都是【静默失效】的坑，改回去不会报错、只会让测试假绿）：
 *  1) 必须包 auditor.invoke()。不包时 saver.put 里 onStepStart() 开的事务只在它自己的
 *     scope 帧内有效，节点执行时帧已退出 ⇒ record() 抛「丢失了事务作用域」。
 *     外层 run() 的帧包住整趟图，节点内的 record() 才落在活动 scope 里。
 *  2) compile 的选项名必须是 checkpointer（见 company.ts）。写成 { saver } 时
 *     put 永不被调用 ⇒ 超步边界完全不滚动，整趟压成一个事务，V3 当场失去意义 ——
 *     而图照样跑完、事件照样写出来，测试①②全绿。
 *
 * 崩溃时机（实测）：超步 N 的事件在【超步 N+1 的 put】里才提交。所以杀在 test 超步内
 * 任意一条边之后，库里只剩到 dev 为止的 4 条边，tasks.status 停在 EVIDENCE_SUBMITTED；
 * current / reworkUsed 通道也一起回滚 ⇒ 续跑重放 test 时走的是同一条回退分支，
 * 边序列才会恰好补齐到 14 条。这就是 §6.3「checkpoint 与 events 同事务」的兑现点。
 */
auditor
  .invoke(() => graph.invoke(input, cfg))
  .then((out) => {
    console.log(
      "CHILD-DONE resumed=" + resumed + " trail=" + JSON.stringify(out.trail),
    );
    return auditor.committedSteps;
  })
  .then((steps) => {
    console.log("CHILD-COMMITTED-STEPS " + steps);
    db.close();
  })
  .catch((e) => {
    console.log("CHILD-FAIL " + String(e && (e as Error).message));
    process.exit(1);
  });
