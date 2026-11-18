/**
 * 复算「delegation_graphs 今天有几行 / 全部版本合计几条委派边」——
 * round298 台账与 0064 §6 第 4 条那两段里那句「实测 dev.db 是 0 行」的复算方法。
 *
 * 为什么留在仓库里而不是删掉：那条读数是【一条主张的分母】
 * （「这条自检今天是 not_observable，因为没对象」）。本仓的家规是每个数配一条
 * 能跑的命令，而不是配一句"我跑过了"。跑法：
 *   npx tsx .workbuddy/probe-db-edge.ts .opc-os/dev.db
 * 只读打开（readOnly），不写任何东西。
 *
 * ⚠ 它【只测量不判定】：读不成 JSON 的那一行按 0 条边计，因为它答的是"有几行几条边"，
 * 不是"这份库合不合规"—— 后者是 integrity.ts 那条 delegation_edges_gated 的活。
 */
import { DatabaseSync } from "node:sqlite";
const path = process.argv[2];
if (!path) throw new Error("用法：probe-db-edge.ts <库文件路径>");
const db = new DatabaseSync(path, { readOnly: true });
const graphs = db
  .prepare("SELECT COUNT(*) AS n FROM delegation_graphs")
  .get() as { n: number };
let edges = 0;
let maxVer = "-";
for (const r of db
  .prepare("SELECT version AS v, graph_json AS g FROM delegation_graphs")
  .all() as { v: number; g: string }[]) {
  try {
    const parsed = JSON.parse(r.g) as { edges?: unknown[] };
    edges += Array.isArray(parsed.edges) ? parsed.edges.length : 0;
    maxVer = String(r.v);
  } catch {
    /* 读不成就算 0，本探针只数行数与边数 */
  }
}
console.log(
  "delegation_graphs 行数 =",
  graphs.n,
  " 全部版本边数合计 =",
  edges,
  " 最大 version =",
  maxVer,
);
