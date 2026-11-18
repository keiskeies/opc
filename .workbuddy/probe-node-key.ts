/**
 * 复算「delegation_graphs 里有多少节点的【键】不等于它自己的 role_id」——
 * r22 射程④ 那一格的分母：那一格登记的是「今天没有任何判据拦它」，
 * 而「拦不拦」和「盘上有没有」是两条主张。改判据之前必须先量后者，
 * 因为那个数决定修法：
 *   恒为 0  ⇒ 加严格判据是【纯收紧】，不会让任何现役请求从 200 变 422；
 *   非 0    ⇒ 加严格判据会【改变现役路由的接受集】，那是改产品行为，要走 CEO。
 * （本轮不重犯 round298 那一格：登记一个洞时「它怎么被踩到」「有没有被踩到」
 *   都是要复算的主张，不能从上一轮的记述里继承。）
 *
 * 跑法（库路径走 argv，【不写死】这台机器的 checkout 路径 —— 那条债本轮刚量过）：
 *   npx tsx .workbuddy/probe-node-key.ts .opc-os/dev.db
 * 只读打开，不写任何东西。
 *
 * ⚠ 只测量不判定：graph_json 读不成 JSON 的版本单独计数，不算进任何一种节点，
 * 它答的是「有几行、其中几行带这种节点」，不是「这份库合不合规」。
 */
import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("用法：probe-node-key.ts <库文件路径>");
const db = new DatabaseSync(path, { readOnly: true });

type Row = { v: number; g: string };
let rows = 0;
let unreadable = 0;
let badNodes = 0;
let totalNodes = 0;
const hitVersions: number[] = [];

try {
  const all = db
    .prepare("SELECT version AS v, graph_json AS g FROM delegation_graphs")
    .all() as Row[];
  rows = all.length;
  for (const r of all) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.g);
    } catch {
      unreadable++;
      continue;
    }
    const nodes = (parsed as { nodes?: unknown })?.nodes;
    if (nodes === null || typeof nodes !== "object" || Array.isArray(nodes))
      continue;
    let hit = 0;
    for (const [key, node] of Object.entries(nodes as Record<string, unknown>)) {
      totalNodes++;
      const roleId = (node as { role_id?: unknown } | null)?.role_id;
      if (roleId !== key) hit++;
    }
    if (hit > 0) {
      badNodes += hit;
      hitVersions.push(r.v);
    }
  }
} finally {
  db.close();
}

console.log(
  "delegation_graphs 行数 =",
  rows,
  "｜graph_json 读不动 =",
  unreadable,
  "｜节点总数 =",
  totalNodes,
  "｜键≠role_id 的节点 =",
  badNodes,
  "｜带这种节点的 version =",
  hitVersions.length === 0 ? "（无）" : hitVersions.join(","),
);
