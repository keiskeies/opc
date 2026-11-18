#!/usr/bin/env node
/**
 * round291：给 test/e2e/ceo-loop.spec.ts 量【牙齿】，不是量它绿。
 *
 * 一次通过的 E2E 比一次通过的单测更可疑：它绿得越快越像"什么都没断"。
 * 这一台机器上它 450ms 就绿了，所以必须逐发把【它声称成立的那件事】抹掉，
 * 看它是不是真的红、红在哪一步。
 *
 * 每发只改一处字节，跑完按字节还原（不是 git checkout —— 那样会把别的改动一起抹掉）。
 * 读的是 playwright 的【完整】输出再判，不看 tail：截断的失败输出会把红认成绿。
 *
 * 跑法：node .workbuddy/round291-mutate-ceo-loop.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.cwd();
const results = [];

/**
 * 待发的变异，先全部收进数组再跑。
 *
 * ⚠ 为什么先校锚点再跑第一发（本轮踩出来的）：第一版边跑边校，M0 绿了、M1 红了、
 * M2 才发现锚点不存在 —— 那 30 多秒是白烧的，更要紧的是【锚点静默失配】这件事
 * 本身：锚点一旦因为被测文件改名而消失，mutate 抛异常，那一发就【没跑过】,
 * 而矩阵里既没有它也没有红 —— 读矩阵的人会以为"这一族都验过了"。
 * 所以这里把【所有锚点在进场前逐一验存在】当成硬前提，抛错时不发任何一发。
 */
const MUTATIONS = [];
function plan(rel, from, to, label, expectRed, note) {
  const p = join(ROOT, rel);
  const text = readFileSync(p, "utf8");
  if (!text.includes(from)) {
    throw new Error(
      "锚点不在文件里 ⇒ 这一发【不会跑】，它不构成任何证据：" +
        rel +
        " :: " +
        from,
    );
  }
  if (to === from) {
    throw new Error("变异与原文一模一样 ⇒ 这一发是空操作，测不出任何事：" + rel);
  }
  MUTATIONS.push({ rel, from, to, label, expectRed, note });
}

function run(label, expectRed, note) {
  const r = spawnSync(
    process.execPath,
    [
      join(ROOT, "node_modules", "playwright", "cli.js"),
      "test",
      "--reporter=list",
      "--timeout=90000",
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 400_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const out = String(r.stdout) + String(r.stderr);
  const passed = /\b1 passed\b/.test(out);
  const failed = /\b1 failed\b/.test(out);
  const firstErr = (out.match(/Error: [^\n]*/) ?? ["(无 Error 行)"])[0].slice(0, 110);
  const hit = expectRed ? failed : passed;
  results.push([hit, label, expectRed ? "应红" : "应绿", "passed=" + passed + " failed=" + failed, firstErr, note]);
  console.log((hit ? "  命中  " : "  未命中") + "  " + label + "  → " + (expectRed ? "应红" : "应绿") + "  " + firstErr);
}

/**
 * 就地替换一发，跑一次，还原。
 *
 * ⚠ 还原写的是【进场时读到的那份字节】，不是 `now.replace(to, orig)`。
 * 第一版写的是后者，它当场把自己的文件写坏了 —— `orig` 里【含有】`to` 那一串
 * （M1 的 to 就是 orig 的一个前缀子串），于是 replace 又把刚换进去的那一发
 * 再换一遍，文件变成两份叠加。"还原"这件事只能靠字节，不能靠再一次模式替换。
 *
 * ⚠ 第二个坑：还原【必须在 finally 里】且在【校验之前】。第一版的 throw 写在
 * 还原之前，于是那一发的变异字节永久留在了文件里（当场把 spec 的 .click() 删掉了）。
 */
function execute(m) {
  const p = join(ROOT, m.rel);
  const orig = readFileSync(p, "utf8");
  writeFileSync(p, orig.replace(m.from, m.to));
  let restored = false;
  try {
    run(m.label, m.expectRed, m.note);
  } finally {
    writeFileSync(p, orig);
    restored = readFileSync(p, "utf8") === orig;
  }
  if (!restored) throw new Error("还原后字节不一致，必须手工修：" + m.rel);
}

/* ── M1：批准之后任务不再往前走 ─────────────────────────────
 * 把「点批准」这个人类动作换掉 ⇒ 最后那一格 CHARTER_APPROVED 必须拿不到。
 * 它证的是【最后那一跳真的由点击造成】，不是页面自己在动。 */
plan(
  "test/e2e/ceo-loop.spec.ts",
  'await page.locator("[data-decide]").first().click();',
  'await page.locator("[data-decide]").first();',
  "M1 不点批准",
  true,
  "看板不该变成 CHARTER_APPROVED",
);

/* ── M2：起草根本不跑（候选 SQL 的前置：组织图角色） ────────
 * 把组织图里的 intake 节点改名 ⇒ ensureCharterCard 判 org_blocked、一分钱不烧、
 * 不建卡。这一发要抓的是【收件箱那张卡其实来自别处】这种假绿。
 * ⚠ 锚点是【两行】：key 与 role_id 各占一行（本轮 format 之后变成这样的），
 *   只改 key 而 role_id 仍是 "intake" 的话，射程到底在哪一侧并不确定 ——
 *   两个一起改才让「这个角色不在图上」这句话成立。
 *   第一版这里锚的是单行 `intake: { role_id: "intake", can_manage: true`，
 *   那是格式化【之前】的形状 ⇒ 锚点静默失配，这一发【从未跑过】。 */
plan(
  "test/e2e/ceo-loop.spec.ts",
  '        intake: {\n          role_id: "intake",',
  '        intakeX: {\n          role_id: "intakeX",',
  "M2 起草角色不在组织图上",
  true,
  "起草不该跑，收件箱不该有卡",
);

/* ── M3：把 UI 的接口拆掉（签名代理签错 token） ──────────────
 * 两侧 token 不一致 ⇒ 每个 /api 全 401 ⇒ 页面渲染成连接错误。
 * 这一发证的是【这一圈真的经过那个签名代理】，不是浏览器直接读到了什么。 */
plan(
  "test/e2e/ceo-loop.spec.ts",
  'ORG_TOKEN: "e2e-token-not-a-secret",',
  'ORG_TOKEN: "a-different-token",',
  "M3 代理与 Hub 的 token 不一致",
  true,
  "页面该报连接错误",
);

/* ── M4：把断言本身放宽成恒真 —— 反向 canary ─────────────────
 * 如果判据坏掉时这一发【仍然绿】，说明前面那些红来自别处而不是这条断言。
 * 有牙齿的守卫在这一发必须【绿】（断言被掏空 ⇒ 什么都测不到 ⇒ 不该红）。 */
plan(
  "test/e2e/ceo-loop.spec.ts",
  'await expect(flowed.locator(".pill")).toHaveText("CHARTER_APPROVED");',
  'await expect(flowed.locator(".pill")).toContainText("");',
  "M4 把最后那条断言掏成恒真",
  false,
  "反向 canary：断言被掏空必须绿，否则红来自别处",
);

/* ── M5：zod 挂载点退回那条不存在的硬编码路径 ─────────────────
 * 这是本轮修掉的真缺陷。还原成 join(ROOT,"node_modules/zod") ⇒ /vendor/zod 404
 * ⇒ 浏览器模块图断 ⇒ [data-idea] 永远等不到。
 * ⚠ 它红的形状是【超时】而不是 404：服务端只把 404 写进响应，不写日志。
 *    这一发存在的理由是记录"这个缺陷安静到什么程度"。 */
plan(
  "packages/web/src/dev-server.ts",
  '"/vendor/zod/": zodDir(),',
  '"/vendor/zod/": join(ROOT, "node_modules/zod"),',
  "M5 zod 挂载退回硬编码 node_modules/zod",
  true,
  "白屏；pnpm isolated linker 下那个目录不存在",
);

/* ── 控制组先跑（锚点已在校验阶段全部通过，这里不会中途抛） ── */
run("M0 控制组：一字不改", false, "绿是后面每一发红的前提");
for (const m of MUTATIONS) execute(m);

console.log("\n══════════ round291 变异矩阵 ══════════");
let ok = 0;
for (const [hit, label, want, state, err, note] of results) {
  ok += hit ? 1 : 0;
  console.log((hit ? "✓" : "✗") + " " + label + "  [" + want + "] " + state + " | " + note + " | " + err);
}
console.log("命中 " + ok + " / " + results.length);
process.exitCode = ok === results.length ? 0 : 1;
