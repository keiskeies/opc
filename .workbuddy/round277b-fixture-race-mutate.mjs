/**
 * round277b：证明「运行期夹具竞态」这一族的两条新守卫真的会红。
 *
 * 为什么需要：这两条守卫治的是【随机红】。漏接名单的表现是 5 次里红 1 次，
 * 而随机红会被当成 flake 重跑掉，等于没有守卫。所以这里不用「跑并发撞它」，
 * 而是当场把判据的输入改掉，验它【恒红】。
 *
 * 三条变异，每条都自带预期：
 *   M1 抹掉 listHubSrc 的排除那一格   ⇒ 「探针真的存在时不列出它」必须红
 *   M2 新造一个调 readdirSync 的守卫文件 ⇒ 「每个使用者都在清单里过了一遍」必须红
 *   M3 抹掉 role-spawn-boundary 的 import ⇒ 「清单里说要排，代码没接上」必须红
 *
 * 自回滚：每条变异落地前要求锚点【恰好出现一次】，跑完按字节比对照原样恢复；
 * 新建的文件删除后再 stat 一次确认 ENOENT。任何一步不吻合就大声抛，不留半成品。
 *
 * 跑法：node .workbuddy/round277b-fixture-race-mutate.mjs
 */
import {
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const T = (p) => join(ROOT, "test", "arch", p);

/** [名字, 文件, 原样(新建用 null), 改成, 期望红的测试名片段] */
const MUTS = [
  [
    "M1 排除那一格被抹掉",
    T("claims-registry.ts"),
    '      if (!e.isDirectory() && isRuntimeFixture(e.name)) continue;\n',
    "",
    "接了名单的取材函数在【探针真的存在】时不列出它",
  ],
  [
    "M2 新造一个没登记的 readdirSync 使用者",
    T("m2-unlisted-probe.ts"),
    null,
    'import { readdirSync } from "node:fs";\nexport const n = readdirSync(".").length;\n',
    "每一个 readdirSync 的使用者都在名单里过了一遍",
  ],
  [
    "M3 名单接了但代码里 import 被拔掉",
    T("role-spawn-boundary.ts"),
    'import { isRuntimeFixture } from "./run-fixtures.js";\n',
    "",
    "每一个 readdirSync 的使用者都在名单里过了一遍",
  ],
  [
    "M4 walkFiles 的排除被抹掉（no-null-bytes 那一格【完全靠】它）",
    T("harness-invariants.ts"),
    "      if (isRuntimeFixture(e.name)) continue;\n",
    "",
    "接了名单的取材函数在【探针真的存在】时不列出它",
  ],
];

function run(file) {
  const r = spawnSync(
    "npx",
    ["vitest", "run", "test/arch/production-deps.test.ts"],
    { cwd: ROOT, encoding: "utf8", shell: true },
  );
  // vitest 的统计行里夹着 ANSI 转义序列，不先剥掉的话下面两条正则【恒不匹配】，
  // 于是 failed 一直是 -1 —— 探针自己坏掉的样子恰好就是它要抓的那种「静默不判」。
  const strip = (s) => s.replace(/\[[0-9;]*m/g, "");
  const out = strip((r.stdout || "") + (r.stderr || ""));
  const m = /Tests\s+(\d+) failed \| (\d+) passed \((\d+)\)/.exec(out);
  const failed = /FAIL\s+.*>\s+(.+)/.exec(out);
  void file;
  return {
    exit: r.status ?? 1,
    failed: m ? Number(m[1]) : -1,
    total: m ? Number(m[3]) : -1,
    firstFail: failed ? failed[1].trim() : "",
    out,
  };
}

const results = [];
for (const [name, file, from, to, expectRed] of MUTS) {
  const created = from === null;
  const origin = created ? null : readFileSync(file, "utf8");
  if (!created) {
    const n = origin.split(from).length - 1;
    if (n !== 1) throw new Error(name + "：锚点出现 " + n + " 次，要求恰好 1 次");
    writeFileSync(file, origin.replace(from, to));
  } else {
    if (existsSync(file)) throw new Error(name + "：目标文件已存在，不敢覆盖");
    writeFileSync(file, to);
  }
  let got;
  try {
    got = run(file);
  } finally {
    if (created) {
      rmSync(file, { force: true });
      if (existsSync(file)) throw new Error(name + "：新建文件没删掉");
    } else {
      writeFileSync(file, origin);
      const back = readFileSync(file, "utf8");
      if (back !== origin) throw new Error(name + "：回滚后字节不吻合");
    }
  }
  const red = got.exit !== 0;
  const named = got.out.includes(expectRed);
  results.push({
    name,
    exit: got.exit,
    failedTests: got.failed,
    total: got.total,
    redNamedIt: named,
    ok: red && named && got.failed === 1,
  });
}

/* 底座：不改任何东西必须先全绿，否则上面那些「红」说明不了任何事。 */
const base = run("baseline");
const baseOk = base.exit === 0;

console.log(
  JSON.stringify({ baselineGreen: baseOk, baseline: base.out.match(/Tests.*/) }, null, 1),
);
for (const r of results) console.log(JSON.stringify(r));
console.log("ALL MATCH:", baseOk && results.every((r) => r.ok));
process.exit(baseOk && results.every((r) => r.ok) ? 0 : 1);
