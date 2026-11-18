// round279 变异探针：O8 端到端那 7 发，删掉生产判据之后到底几发红。
// 用法：node .workbuddy/round279-o8-acceptance-mutate.mjs        （跑全部）
//       node .workbuddy/round279-o8-acceptance-mutate.mjs M1 M3  （只跑指定的）
// 每一条都【先断言锚点逐字命中一次】再改，跑完立刻按原文写回并逐字比对。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TEST = "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts";

/**
 * 六发。每一发写清「改哪一格的哪一句」与「预测哪发红」。
 * ⚠ 变异必须【真抹掉字节】：本仓记过 `0 && X` 对一条 grep 字符串的判据是空变异。
 */
const MUTATIONS = [
  {
    id: "M1",
    file: "packages/hub/src/engine/runtime.ts",
    // 「表里一个版本都没有 ⇒ 明说没有岗位书」那一支换成空串：空壳不再说话。
    from: "          ? NO_CHARTER_LINE\n",
    to: "          ? \"\"\n",
    expect: "反空转那一发 + 占位串那一发（两者都靠这句话表达「空壳」）",
  },
  {
    id: "M2",
    file: "packages/hub/src/charter/seed.ts",
    // 占位串判据数错一位：一份带占位串 = 放行（真模板七份全带 ⇒ 全播进去）。
    from: "    if (t.placeholders.length > 0) {",
    to: "    if (t.placeholders.length > 1) {",
    expect: "占位串那一发（退 0 / 写了一行 / 没有「一个角色都没写」三重红）",
  },
  {
    id: "M3",
    file: "packages/hub/src/org/commit.ts",
    // 让提交路径【开始】管新节点的 model_family：那条旁路被关上。
    from: "  const after = applyChangeToGraph(o.graph, o.change);\n",
    to:
      "  const after = applyChangeToGraph(o.graph, o.change);\n" +
      "  if (Object.values(after.nodes).some((n) => n.model_family === undefined)) {\n" +
      "    return { ok: false, reason: \"新节点没配 model_family\", code: \"unknown_model_family\" };\n" +
      "  }\n",
    expect: "证据②那一发（200 变 422）⇒ 它读的是真校验路径，不是夹具",
  },
  {
    id: "M4",
    file: "packages/hub/src/engine/dispatch.ts",
    // 身份提示词不再跟着【这一轮的角色】走：所有轮都拿 intake 的那一份。
    from: "      rolePrompt: deps.rolePrompt(task.role),",
    to: "      rolePrompt: deps.rolePrompt(\"intake\"),",
    expect: "正题那一发（新角色那一轮里没有它自己的标准）⇒ 第四跳真的走 dispatch 通道",
  },
  {
    id: "M5",
    file: "packages/hub/src/charter/prompt.ts",
    // 渲染器不再渲染任何一条真标准（占位那一支也随 real.length 归零而消失）。
    from: "  const real = c.acceptanceCriteria.filter(\n    (a) => !a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE),\n  );",
    to: "  const real = c.acceptanceCriteria.filter(\n    (a) => !a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE) && false,\n  );",
    expect: "正题那一发（标准不再进提示词）⇒ 断言吃的是真渲染器",
  },
  {
    id: "M6",
    file: "packages/hub/src/roles/preset.ts",
    // 预设节点名里挤进 translator：反空转的前提（名字不撞车）被踩。
    from: "  intake: \"assistant\",",
    to: "  translator: \"assistant\",",
    expect: "前提那一发（presetNodes 撞名）⇒ 撞车那天会红，而不是悄悄假绿",
  },
];

function runTests() {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", TEST], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    code = typeof e.status === "number" ? e.status : 1;
  }
  const esc = String.fromCharCode(27);
  const clean = out.replace(new RegExp(esc + "\\[[0-9;]*m", "gu"), "");
  const m = clean.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) failed)?(?: \((\d+)\))?/u);
  const failed = clean
    .split("\n")
    .filter((l) => /^\s+×\s/u.test(l))
    .map((l) => l.trim().slice(0, 90));
  return { code, failed, summary: m === null ? "(没解析到计数行)" : m[0], clean };
}

const wanted = process.argv.slice(2);
const picked = wanted.length === 0 ? MUTATIONS : MUTATIONS.filter((m) => wanted.includes(m.id));
if (picked.length === 0) {
  console.error("没有这样的变异 id：" + wanted.join(","));
  process.exit(2);
}

const results = [];
for (const m of picked) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(m.id + " 【跳过】锚点在 " + m.file + " 里命中 " + hits + " 次（要 1 次）⇒ 锚点过期，不是全绿");
    results.push({ id: m.id, status: "锚点过期" });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), "utf8");
  let r;
  try {
    r = runTests();
  } finally {
    writeFileSync(m.file, original, "utf8");
    const back = readFileSync(m.file, "utf8");
    if (back !== original) {
      console.log("⚠ " + m.id + " 回滚后字节不一致 —— 立刻手工核对 " + m.file);
      process.exitCode = 1;
    }
  }
  console.log("\n──── " + m.id + "  " + m.file);
  console.log("  预测：" + m.expect);
  console.log("  读数：" + r.summary + "  exit=" + r.code);
  for (const f of r.failed) console.log("    红 " + f);
  results.push({ id: m.id, status: r.failed.length > 0 ? "红 " + r.failed.length + " 发" : "【全绿 = 空变异】" });
}

console.log("\n══════ 汇总 ══════");
for (const r of results) console.log("  " + r.id + " ⇒ " + r.status);
if (results.some((r) => r.status.startsWith("【全绿"))) process.exitCode = 1;
