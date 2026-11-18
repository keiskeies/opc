// round288 · intake 那一发 INSERT 到底在不在【超步事务】里。
//
// 为什么非要测：我在 company.ts 的注释里写了「这条只有那条连接，没有事务句柄 ⇒
// 取数与 INSERT 不是同一事务」。这句话和同文件 153 行那条既有事实直接冲突：
//   「tasks 更新【必须】用同一个 db 连接：超步事务就是这条连接上的 BEGIN」
// 而 audit-middleware.ts:154 确实是 `BEGIN IMMEDIATE`。⇒ 如果节点跑在 BEGIN 之后，
// 我那句「不是同一事务」就是假的，而它是【我刚刚写进生产代码】的假话 —— 第三类归因错
// 这次会长成「注释里的机制描述与同文件另一段矛盾」。
//
// 测法（不改生产代码，只在探针里包一层连接）：
//   node:sqlite 没有「我在事务里吗」这种查询 ⇒ 用行为判：在 intake 那次 prepare 的
//   【同一时刻】试着 exec("BEGIN")。
//     · 抛 "cannot start a transaction within a transaction" ⇒ 当时【有】事务开着
//     · BEGIN 成功 ⇒ 当时没事务 ⇒ 立刻 ROLLBACK 收起探针自己开的那一个
//   只在临时库上跑，且只对 INSERT INTO tasks 那一次拦截，别的不碰。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();
// Windows 上 import(绝对路径) 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME（第一版就是这么炸的）：
// import() 要的是 URL，不是路径。必须过 pathToFileURL。
const imp = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
process.env.NODE_NO_WARNINGS = "1";

const dir = mkdtempSync(join(ROOT, ".tmp", "round288-tx-"));
try {
  const { migrate } = await imp("packages/hub/src/db/migrate.ts");
  const { SuperStepAuditor } = await imp("packages/hub/src/graph/audit-middleware.ts");
  const { SqliteWALSaver } = await imp("packages/hub/src/checkpoint/saver.ts");
  const { buildCompanyGraph } = await imp("packages/hub/src/graph/company.ts");
  const { StubRegistry } = await imp("packages/hub/src/graph/stub-model.ts");
  const { loadPresetRoles } = await imp("packages/hub/src/roles/preset.ts");

  const real = new DatabaseSync(join(dir, "hub.db"));
  migrate(real);

  let verdict = "没拦到那条 INSERT（探针没生效，读数不成立）";
  const wrapped = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          if (String(sql).includes("INSERT OR IGNORE INTO tasks")) {
            // 就在【那一刻】试 BEGIN：这是唯一能区分"在同一事务里"与"只是同连接"的读法。
            try {
              target.exec("BEGIN");
              target.exec("ROLLBACK");
              verdict = "BEGIN 成功 ⇒ 那一刻【没有】事务 ⇒ 取数与 INSERT 只是同连接、不同事务";
            } catch (e) {
              const msg = String(e && e.message);
              verdict =
                /within a transaction/iu.test(msg)
                  ? "BEGIN 被拒（" + msg + "）⇒ 那一刻【有】事务开着 ⇒ 取数与 INSERT 在同一超步事务里"
                  : "BEGIN 抛了别的原因，读数不成立：" + msg;
            }
          }
          return target.prepare(sql);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  class FakeBus {
    publish() {}
    subscribe() {
      return () => {};
    }
  }
  const auditor = new SuperStepAuditor({ db: wrapped, bus: new FakeBus(), now: () => 1700000000000 });
  const saver = auditor.instrumentSaver(new SqliteWALSaver(wrapped));
  const graph = buildCompanyGraph({
    db: wrapped,
    recorder: auditor.recorder,
    saver,
    roles: loadPresetRoles(),
    models: new StubRegistry(),
    taskId: "T-TX",
  });
  try {
    await auditor.invoke(() =>
      graph.invoke(
        { idea: "量事务边界", current: "CHARTER_PENDING" },
        { configurable: { thread_id: "th-tx" } },
      ),
    );
  } catch (e) {
    console.log("（图跑挂了，不影响 BEGIN 那一发读数：" + String(e && e.message).slice(0, 200) + "）");
  }
  console.log("intake 那一刻的事务态：", verdict);
  const row = real.prepare("SELECT graph_version FROM tasks WHERE id = ?").get("T-TX");
  console.log("任务行 =", JSON.stringify(row));
  real.close();
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.log("⚠ 临时库没删掉：" + String(e && e.code));
  }
}
