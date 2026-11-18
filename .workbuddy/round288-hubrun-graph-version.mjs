// round288 · `hub run` 建的那行任务，graph_version 到底是 0 还是 1。
//
// 为什么会去量这一格（不是我闲的）：`engine/work.ts` 的 WORK_USAGE 与 0041:229 都写着
//   「建任务走 hub run / POST /tasks（那条路会把 graph_version 与任务行放在同一事务里取，§18.4）」
// 而 hub run 实际发的那条 INSERT 在 graph/company.ts，列清单里【没有 graph_version】：
//   INSERT OR IGNORE INTO tasks (id,title,status,assigned_role,current_node,created_at,updated_at)
// 0012 §2 只证了【另一种写法】存在（real-deps.ts 那条带这一列的 INSERT，
// 由 test/org/versioning.test.ts 的 BEFORE UPDATE RAISE 触发器钉住不许两段写）。
// ⇒ 三处话两两不冲突，直到你去跑一次 hub run。
//
// 为什么【空图库】就是最干净的判据（这条不是我发明的口径，是仓库自己的）：
//   org/commit.ts 的 currentGraphVersion 在空表上返回 0，注释明写
//   「0 是【还没有任何版图】，不是『第 1 版』」；
//   test/org/versioning.test.ts:528 那条就叫
//   「一张图都没提交过时，新任务盖的是 0 而不是列默认值 1」。
// ⇒ 在一张【没有 delegation_graphs 行】的库里建任务：
//     写了那一列 ⇒ 落 0（= 诚实的「还没有版图」，readGraphByVersion(0) 会抛，看得见）
//     没写那一列 ⇒ 落 0001_init.sql:49 的 DEFAULT 1（= 声称有一张从没存在过的 v1，静默）
//   两者都是"一个数"，但只有第二个是假话。这条判据不需要摆任何图。
//
// ⚠ 探针自己踩过的两个坑（都记在 ledger，别再犯）：
//   · shell:true 不转义 args ⇒ 带空格的 --idea 会变成"多余的裸参数"，那是探针坏了不是产品坏了；
//   · hub run 拒写非桩库（user_version 对不上 9000001）⇒ 必须给它一个【不存在的路径】，
//     让它自己建库并认领。这正是它报错文案里给的第一条解法。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.cwd();

function sh(cmd, args) {
  const quoted = args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a));
  const r = spawnSync(cmd, quoted, {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
    timeout: 300000,
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

const dir = mkdtempSync(join(ROOT, ".tmp", "round288-hubrun-"));
try {
  const dbPath = join(dir, "stub.sqlite");
  const r = sh("npx tsx packages/hub/src/cli.ts", [
    "run",
    "--db",
    dbPath,
    "--task",
    "probe-1",
    "--idea",
    "只量graph_version",
  ]);
  console.log("hub run 退出码 =", r.code);
  const db = new DatabaseSync(dbPath);
  const graphs = Number(
    db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM delegation_graphs").get()["v"],
  );
  const t = db
    .prepare("SELECT graph_version, status, assigned_role FROM tasks WHERE id = ?")
    .get("probe-1");
  db.close();
  console.log("  建库时 delegation_graphs 的 MAX(version) =", graphs, "（0 = 一版都没有）");
  console.log("  任务行 =", JSON.stringify(t));
  if (t === undefined) {
    console.log("  ⇒ 任务行根本没建出来，上面这条读数不成立。输出尾巴：\n" + r.out.slice(-600));
  } else {
    const v = Number(t.graph_version);
    console.log(
      "  ⇒ 落 " + v + "：" +
        (v === 0
          ? "写了那一列，且取到诚实的「还没有版图」⇒ 那句 help 对 hub run 也成立"
          : v === 1
            ? "【躺在 0001_init.sql:49 的 DEFAULT 1 上】⇒ 这一列没被写过 ⇒ 那句 help 指错了路"
            : "既不是 0 也不是 1，读数超出判据，别猜，去读代码"),
    );
  }
  console.log(
    "\n对照：POST /tasks 走 http/real-deps.ts 的 INSERT_TASK_SQL，列清单里【有】graph_version，\n" +
      "     test/org/versioning.test.ts:528 钉的就是那条路在空图库上落 0。",
  );
} finally {
  try {
    rmSync(dir, { recursive: true, force: true });
    console.log("\n临时库已删");
  } catch (e) {
    console.log("\n⚠ 临时库没删掉（" + String(e && e.code) + "）：" + dir);
  }
}
