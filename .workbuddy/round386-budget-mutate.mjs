// round386 变异机：证明「预算门分母 = 那一列」这一根线，与屏幕上那句话，今天真承重。
// 每发真抹字节 → 跑对应那支 → finally 逐字节还原 + sha256 核对。
//
// ⚠ 锚点一律用 indexOf 切片 / 行正则取，不照记忆把整段源码重打一遍（0071 §5：
//   第一版 M4 就是这么写出一发【字节没变】的假变异，跑出来的绿毫无意义）。
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const REPO = "D:/item/opc";
const GATE = `${REPO}/packages/hub/src/serve/charter-pump.ts`;
const BUDGET = `${REPO}/packages/hub/src/http/budget.ts`;
const APP = `${REPO}/packages/web/public/app.js`;
const SPEC_HUB = "packages/hub/test/overview/driver-status.test.ts";
const SPEC_WEB = "test/web/app-pure.test.ts";
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

/** 门里上限那一侧「读列、参数只当回落」那一段（underTaskBudgetSql）。 */
const LIMIT_START = '"COALESCE((SELECT b.limit_cents FROM budgets b "';
const LIMIT_END = '".id AND b.period = \'per_task\'), ?)"';
/** 预算页那次保存的语句里「上限真的写进那一格」那一小段。 */
const WRITE_LIMIT =
  "DO UPDATE SET limit_cents = excluded.limit_cents, hard_stop";
/** 屏幕上钱那一档那一句所在的整行。 */
const LINE_RE = /^ *return `不再推：花到了这一格的单条上限[^\n]*$/m;

/** 取锚点切片 [start, end)，任一段没命中就当场抛 —— 不许悄悄拼出个 no-op。 */
function slice(src, from, to, what) {
  const i = src.indexOf(from);
  if (i < 0) throw new Error(`锚点没命中（起点）：${what}`);
  const j = src.indexOf(to, i);
  if (j < 0) throw new Error(`锚点没命中（终点）：${what}`);
  return [i, j + to.length];
}

/** 把 file 换成 mutated，跑 spec，返回是否"符合预期"。 */
function runOnce(label, file, mutated, expectRed) {
  const original = readFileSync(file);
  const oSha = sha(original);
  if (expectRed && mutated === original.toString()) {
    throw new Error(`${label}: 该发的字节一个字没变，变异本身不成立`);
  }
  writeFileSync(file, mutated);
  let red = null;
  let out = "";
  try {
    const r = spawnSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", file === APP ? SPEC_WEB : SPEC_HUB],
      { cwd: REPO, encoding: "utf8", timeout: 300000 },
    );
    out = (r.stdout ?? "") + (r.stderr ?? "");
    if (!/Test Files\s+/.test(out)) {
      throw new Error(`${label}: 读不到 vitest 摘要，中止（不算红也不算绿）`);
    }
    red = r.status !== 0;
  } finally {
    writeFileSync(file, original);
    if (sha(readFileSync(file)) !== oSha) {
      throw new Error(`${label}: 还原后 sha 不符！`);
    }
  }
  const pass = expectRed ? red === true : red === false;
  const failed = [...out.matchAll(/✕ (\S[^\n]*?)\s+\d+ms/g)].map((m) => m[1]);
  console.log(
    `${pass ? "OK  " : "FAIL"} ${label} 期望${expectRed ? "红" : "绿"} 实到${
      red === null ? "没跑" : red ? "红" : "绿"
    }` + (failed.length ? ` 点名: ${failed.join(" | ")}` : ""),
  );
  return pass;
}

const gateSrc = readFileSync(GATE, "utf8");
const budgetSrc = readFileSync(BUDGET, "utf8");
const appSrc = readFileSync(APP, "utf8");
const [ls, le] = slice(gateSrc, LIMIT_START, LIMIT_END, "门：上限那一侧");
const line = appSrc.match(LINE_RE);
if (!line) throw new Error("锚点没命中：屏幕上钱那一档那一行");
let all = true;

/* ── 预检：未变异 ⇒ 两支都该绿 ── */
all = runOnce("M0a 预检（未变异·hub 侧）", GATE, gateSrc, false) && all;
all = runOnce("M0b 预检（未变异·web 侧）", APP, appSrc, false) && all;

/* ── 门那一侧（都跑 hub 那支）── */

// M1 退回 round360 之前的门：命令行是唯一分母 ⇒ 「改列就开门」立刻是假的 ⇒ 该红
all =
  runOnce(
    "M1 退回「命令行是唯一分母」那扇门",
    GATE,
    gateSrc.slice(0, ls) + '"?"' + gateSrc.slice(le),
    true,
  ) && all;

// M2 另一种「看着更像保险」的写法：分母 = MAX(列, 命令行) ⇒ 命令行那份【也能】开门 ⇒ 该红。
// ⚠ 第一版想用 CASE WHEN ? > … THEN ? ELSE … END —— 那要多绑一个参数，
//   先撞 assertParamCount 报绑参不符，量不到判据。MAX(a, ?) 参数个数不变、形状相同。
// ⚠ 这一段是【拼出来的新代码】，用单引号 JS 字符串写清每一段，别照抄双引号那份。
all =
  runOnce(
    "M2 分母改成 MAX(列, 命令行)",
    GATE,
    gateSrc.slice(0, ls) +
      [
        `    "MAX(COALESCE((SELECT b.limit_cents FROM budgets b " +`,
        `    "WHERE b.scope_type = 'task' AND b.scope_id = " +`,
        `    t +`,
        `    ".id AND b.period = 'per_task'), 0), ?)"`,
      ].join("\n") +
      gateSrc.slice(le),
    true,
  ) && all;

// M3 预算页那次保存不再写 limit_cents ⇒ 「去预算页改那一行」落空 ⇒ 该红
all =
  runOnce(
    "M3 那次保存不写 limit_cents",
    BUDGET,
    budgetSrc.replace(WRITE_LIMIT, "DO UPDATE SET hard_stop"),
    true,
  ) && all;

/* ── 屏幕那一侧（都跑 web 那支）── */

// M4 抹掉「不必」⇒ 句子变成把人支去重启（今天走不通的那条）⇒ 该红
all =
  runOnce(
    "M4 把「不必重启」写成「重启」",
    APP,
    appSrc.replace(line[0], line[0].replace("，不必重启 ·", "，重启 ·")),
    true,
  ) && all;

// M5 退回本轮改掉的那句旧话（指回命令行 + 「屏幕上放开不了」+ 印一个没参与过判据的钱数）⇒ 该红
all =
  runOnce(
    "M5 退回旧那句（指回 --task-limit-cents 重启）",
    APP,
    appSrc.replace(
      line[0],
      "    return `不再推：花到了命令行那个单条上限（${money(driver.task_limit_cents)}）· 屏幕上放开不了，要它继续走得带更高的 --task-limit-cents 重启 · ${when}`;",
    ),
    true,
  ) && all;

// M6 只留「改大」、抹掉「（还没有那一行就新增一行）」⇒ CLI=0 那一档没了指路 ⇒ 该红
all =
  runOnce(
    "M6 抹掉「还没有那一行就新增一行」",
    APP,
    appSrc.replace(line[0], line[0].replace("（还没有那一行就新增一行）", "")),
    true,
  ) && all;

// M7 反向对照：那一行【不印路径】而只说「预算页」⇒ 指针不落地 ⇒ 该红
//    （钉的是"必须说出哪一行"，不是"必须出现 task/ 这三个字符"）
all =
  runOnce(
    "M7 抹掉 task/<id>/per_task 那一格的名字",
    APP,
    appSrc.replace(
      line[0],
      "    return `不再推：花到了这一格的单条上限 · 放开它在预算页：把这一行改大（还没有那一行就新增一行），不必重启 · ${when}`;",
    ),
    true,
  ) && all;

// M8 控制组：只加一行无关注释 ⇒ 判据不该被牵连 ⇒ 该绿
all =
  runOnce(
    "M8 控制组（只加无关注释）",
    APP,
    appSrc.replace(line[0], "    // 控制组：一行无关注释\n" + line[0]),
    false,
  ) && all;

console.log(all ? "\n全部符合预期" : "\n有不符合预期的发，看上面 FAIL 行");
process.exit(all ? 0 : 1);
