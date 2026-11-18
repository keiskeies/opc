/**
 * 复算「nodeKeyIdentityCheck 在真仓库上返回什么」—— 登记 r24 之前的前提自证。
 *
 * 两个问题分开答，因为它们会伪装成彼此：
 *   甲 判据返回空 = 真绿，还是【取材坏了 / 切片切早了】？
 *   乙 判据返回非空 = 主张过期，还是【withoutComments 吃掉了真判据】？
 *      （withoutComments 有两个已知洞，都朝假方向：字符串里的 `//` 吃掉同一行的
 *       真判据；块注释里含 `//` 会让那个块没在此收尾而一路吞到下一个真收尾。
 *       那段 superRefine 的函数头注释比代码长得多，正踩在这一族的射程里。）
 * 所以这里把【剥注释前后的切片】都打出来，让人自己看得见判据那几行还在不在。
 *
 * 跑法：npx tsx .workbuddy/probe-node-key-check.ts
 */
import {
  nodeKeyIdentityCheck,
  realFiles,
} from "../test/arch/claims-registry.ts";

const graph = realFiles.contracts("org/graph.ts");
const a = graph.indexOf("export const orgGraphSchema = z");
const b = graph.indexOf("export type OrgGraph", a + 1);
const seg = a === -1 || b === -1 ? null : graph.slice(a, b);

const verdict = nodeKeyIdentityCheck(realFiles);
console.log("甲 判据返回 =", verdict === "" ? "（空 = 绿）" : verdict);
console.log("乙 切片取到 =", seg === null ? "null（取材失败）" : seg.length + " 字节");

// 剥注释前后各数一次那三行判据，直接看「剥注释有没有把判据剥掉」。
const stripped = (seg ?? "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
  .join("\n");
for (const probe of [
  ".superRefine(",
  "Object.entries(graph.nodes)",
  "if (node.role_id === key) continue;",
  'path: ["nodes", key, "role_id"]',
]) {
  const inRaw = (seg ?? "").includes(probe);
  const inStripped = stripped.includes(probe);
  console.log(
    (inRaw && inStripped ? "✓ " : "✗ ") +
      "原文=" +
      inRaw +
      " 剥注释后=" +
      inStripped +
      "  ⇐ " +
      probe,
  );
}
// 反向对照：这一段里【不该】出现 break/return（那条格判的就是它）。
for (const bad of ["break;", "return;"]) {
  console.log(
    (stripped.includes(bad) ? "✗ 出现了" : "✓ 没有") + " " + bad,
  );
}
console.log(
  "丙 api.ts 挂的是这一份 =",
  realFiles.contracts("api.ts").includes("graph: orgGraphSchema"),
);
console.log(
  "丁 写入口仍指名 =",
  realFiles.src("org/commit.ts").includes("INSERT_DELEGATION_GRAPH_SQL"),
);
