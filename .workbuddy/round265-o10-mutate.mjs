/**
 * O10 变异实验：改掉守卫的判据，验证 timeout.test.ts 会红。
 *
 * 三发变异（每发都改 src/approvals/timeout.ts 或 cards.ts 的一个守卫，
 * 跑对应测试，然后还原）：
 *   1. actorId: "timeout-executor" → "ceo"   —— 机器决定署了人的名，第 ①/② 组必须红
 *   2. DUE_APPROVALS_SQL 去掉 "AND timeout_at <= ?" —— 到期判定失效，到期断言必须红
 *   3. 拒建判据（cards.ts）反向 —— 拒建用例必须红
 *
 * 注意：timeout.ts / cards.ts 都在工作区（含未跟踪文件），
 * git checkout 对未跟踪文件无效 ⇒ 每个变异都保存原串、事后反向替换还原，
 * 收尾再断言「原串回来了」。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const ROOT = "D:/item/opc";
const TARGET = "packages/hub/src/approvals/timeout.ts";
const CARDS = "packages/hub/src/approvals/cards.ts";
const TEST_SPEC = "packages/hub/test/approvals/timeout.test.ts";

function run() {
  try {
    execSync("cd " + ROOT + " && npx vitest run " + TEST_SPEC + " 2>&1", {
      stdio: ["pipe", "pipe", "pipe"],
    });
    return "PASS";
  } catch {
    return "FAIL";
  }
}

function read(path) {
  return readFileSync(pathOf(path), "utf8");
}
function write(path, s) {
  writeFileSync(pathOf(path), s);
}
function pathOf(p) {
  return ROOT + "/" + p;
}

console.log("baseline:", run());

// ---- 变异 1：actor 署成 ceo ----
{
  const s = read(TARGET);
  const from = 'actorId: "timeout-executor"';
  const to = 'actorId: "ceo"';
  if (!s.includes(from)) throw new Error("变异1 模板没命中");
  write(TARGET, s.replace(from, to));
  const r = run();
  console.log("变异1 (actor→ceo):", r, r === "FAIL" ? "✓ 红" : "✗ 没红");
  write(TARGET, s); // 反向替换还原
}

// ---- 变异 2：到期判定失效 ----
{
  const s = read(TARGET);
  const from = "AND timeout_at <= ?";
  if (!s.includes(from)) throw new Error("变异2 模板没命中");
  write(TARGET, s.replace(from, ""));
  const r = run();
  console.log("变异2 (去掉到期判定):", r, r === "FAIL" ? "✓ 红" : "✗ 没红");
  write(TARGET, s);
}

// ---- 变异 3：拒建判据反向（cards.ts）----
{
  const s = read(CARDS);
  const from =
    'parsed.data.parameters.timeout_behavior === "auto_approve" &&\n' +
    "    parsed.data.parameters.irreversible === true";
  const to =
    'parsed.data.parameters.timeout_behavior === "auto_approve" &&\n' +
    "    parsed.data.parameters.irreversible === false";
  if (!s.includes(from)) throw new Error("变异3 模板没命中");
  write(CARDS, s.replace(from, to));
  const r = run();
  console.log("变异3 (拒建条件反向):", r, r === "FAIL" ? "✓ 红" : "✗ 没红");
  write(CARDS, s);
}

// 收尾：断言原串都回来了
const finalTimeout = read(TARGET);
const finalCards = read(CARDS);
if (!finalTimeout.includes('actorId: "timeout-executor"')) {
  throw new Error("timeout.ts 没还原干净");
}
if (!finalTimeout.includes("AND timeout_at <= ?")) {
  throw new Error("timeout.ts 到期判定没还原干净");
}
if (!finalCards.includes("irreversible === true")) {
  throw new Error("cards.ts 拒建判据没还原干净");
}
console.log("还原校验: ✓ 三个文件都回到原样");
console.log("还原后:", run());
