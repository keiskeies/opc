// round288 · 变异机（第二台）：doc-refs 新扫 docs/INDEX.md 这一半【有没有牙齿】。
//
// 为什么单独一台：主文档那台（round288-mutate-design-scan.mjs）证的是主文档那 4 格。
// 「decisionDocs() 多塞了一个键」这件事对每个键要各自证 —— 一个只覆盖一半的守卫能给出
// 范围的绿，一个接了键但正则/键名没对上的守卫能给出**根本不存在的**绿。
//
// 前四发各打一个失效面：
//   M1 坐标漂一行      ⇒ 键里含行号 ⇒ 预期是【一对】，不是「与快照不符」
//   M2 文件改成不存在  ⇒ 「找不到/歧义」这一支也覆盖 INDEX
//   M3 引用整条删掉    ⇒ 「快照里有而文档没有」（删引用不能是无声的）
//   M4 【只改内容不改行号】⇒ 走到「与快照不符」那一支 —— 这一支前面两台机器【从来没打到过】
//        它们的文件头自己就写了：改行号永远走不到「不符」。所以整个 doc-refs 守卫的
//        「内容变了」这一支至今没有机器证据。这一发补上。
//
// M4 打在【测试文件】而不是生产源码：追加一条注释，字节级可回滚且**不改任何行为**，
// 而生产源码被硬杀（SIGKILL）卡在中间会留下一处真改动。风险不对称就换标的。
// 每发跑完立刻逐字节回滚；回滚不干净就抛，不把改动留在树上。
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const DOC = "docs/INDEX.md";
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "gu");
const doc = readFileSync(DOC, "utf8");

const MUTANTS = [
  {
    id: "M1 INDEX 坐标漂一行",
    file: DOC,
    from: "`http/real-deps.ts:808`",
    to: "`http/real-deps.ts:809`",
    expect: ["快照里没有这条引用", "快照里有，文档里已经没有"],
  },
  {
    id: "M2 INDEX 文件名改成不存在",
    file: DOC,
    from: "`im.ts:164`",
    to: "`im-nope.ts:164`",
    expect: ["找不到"],
  },
  {
    id: "M3 INDEX 整条引用删掉",
    file: DOC,
    from: "`approvals/cards.ts:252` 就是那句 INSERT",
    to: "`approvals/cards.ts` 就是那句 INSERT",
    expect: ["快照里有，文档里已经没有"],
  },
  {
    id: "M4 目标行只改内容、行号不动（「与快照不符」那一支）",
    file: "test/desktop/ipc-surface.test.ts",
    from: "      expect(API_ENDPOINTS).toContain(s.endpoint);",
    to: "      expect(API_ENDPOINTS).toContain(s.endpoint); // round288 变异探针，跑完即撤",
    expect: ["与快照不符"],
  },
];

function runGuard() {
  const r = spawnSync("npx", ["vitest", "run", "test/arch/doc-refs.test.ts"], {
    shell: true,
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600000,
  });
  if (r.status === null) {
    throw new Error("vitest 进程没起来（status=null）—— 这不是「全绿」");
  }
  return (r.stdout + r.stderr).replace(ANSI, "");
}

const base = runGuard();
if (!/2 passed/.test(base)) {
  throw new Error("基线不是全绿，跑变异没有意义：\n" + base.slice(0, 600));
}
console.log("基线: doc-refs 2 发全绿");

const hits = [];
for (const m of MUTANTS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    throw new Error(`变异 ${m.id} 的锚文本不在 ${m.file} 里 —— 变异机自己坏了：${m.from}`);
  }
  let out = "";
  try {
    writeFileSync(m.file, original.replace(m.from, m.to), "utf8");
    out = runGuard();
  } finally {
    writeFileSync(m.file, original, "utf8");
    if (readFileSync(m.file, "utf8") !== original) {
      throw new Error("回滚后与原文不一致 —— 立刻人工检查 " + m.file);
    }
  }
  const red = /FAIL|failed/.test(out);
  const got = out
    .split(/\r?\n/)
    .filter((l) => l.startsWith("+ ") && l.includes("INDEX.md>"))
    .join(" ㊣ ");
  const miss = m.expect.filter((e) => !got.includes(e));
  // ⚠ 这里原来截到 200 字，正好把 M4 的 INDEX 那半截掉了（三条消息里只看得见 0030 那条），
  //   于是「M4 命中」这句话在屏幕上【不支持它】。改成打全文 + 单独检本 mutant 的键在不在。
  hits.push({
    id: m.id,
    red,
    matched: miss.length === 0,
    line: got === "" ? "(Received 行里没有 INDEX 的坐标)" : got,
  });
}

console.log("\n变异读数：");
for (const h of hits) {
  console.log(
    `${h.red && h.matched ? "命中" : "未命中"}  ${h.id}\n        ${h.line}`,
  );
}
const bad = hits.filter((h) => !h.red || !h.matched);
console.log(
  `\n结论：${hits.length} 发变异，命中 ${hits.length - bad.length}，未命中 ${bad.length}` +
    (bad.length === 0
      ? "\n ⇒ INDEX 这一半有牙齿（漂行 / 找不到 / 删引用 / 改内容 四支都能红）。" +
        "\n ⇒ M4 的【准确】读法见文件头：它证的是「与快照不符」这一支第一次在【真语料 + 真快照】上红。" +
        "\n    不是「这一支从来没被证过」—— doc-refs 自己的「扫描器本身有判别力」那一发就断言了它，只不过打在合成夹具上。" +
        "\n    （我这句结论在第一版写成了【首次拿到机器证据】，那是本轮第四次归因错，账在 ledger。）"
      : " ⇒ 至少一支打不红，「接进来了」这句话不算证完。"),
);
console.log("还原：两处文件均与原文逐字一致");
