#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// 审计台两个 report-only 开放项的【可复算校验】—— 不注册为守卫，仅给 CEO/owner 复算。
// 跑法：node docs/review/verify-open-invariants.mjs
//
// round188 初版（isPidAlive 语义 + 6 个钉住哈希）；round206 扩到全量 prose 哈希扫描；
// round260 重写扫描段 —— 旧版【恒 exit 1】：门禁明确要求 CEO/owner 亲自跑的这条命令
// 从来没有绿过（0055 同形：一条恒不可能通过的验收命令 = 一条恒红的断言，
// 而恒红的信号会让人学会跳过它）。
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HUB = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "packages",
  "hub",
);
const ROOT = join(HUB, "..", "..");
const WORKBUDDY = join(ROOT, ".workbuddy");
const DOCS = join(ROOT, "docs");
const HASHLIST = [
  "1877e8e",
  "2126e1e",
  "c633cda",
  "fff255b",
  "ff08762",
  "4dfe197",
];
let fail = 0;
const ok = (name, pass, detail) => {
  console.log(
    (pass ? "PASS  " : "FAIL  ") + name + (detail ? "   -> " + detail : ""),
  );
  if (!pass) fail++;
};
const extractFn = (src) =>
  (src.match(/function isPidAlive[\s\S]*?\n\}/) || [""])[0];
const fx = extractFn(
  readFileSync(join(HUB, "test", "fixtures", "fixture-dir.ts"), "utf8"),
);
const lk = extractFn(
  readFileSync(join(HUB, "src", "serve", "lock.ts"), "utf8"),
);
const n = (re, s) => (s.match(re) || []).length;
const has = (re, s) => re.test(s);
ok(
  "isPidAlive 前置守卫(整数/正数)",
  has(/Number\.isInteger\(pid\) \|\| pid <= 0/, fx) &&
    has(/Number\.isInteger\(pid\) \|\| pid <= 0/, lk),
);
ok(
  "isPidAlive EPERM->true",
  has(/EPERM[\s\S]{0,40}return true/, fx) &&
    has(/EPERM[\s\S]{0,40}return true/, lk),
);
ok(
  "isPidAlive ESRCH->false",
  has(/ESRCH[\s\S]{0,40}return false/, fx) &&
    has(/ESRCH[\s\S]{0,40}return false/, lk),
);
ok(
  "isPidAlive 意外->true(判错代价非对称)",
  n(/return true/g, fx) >= 3 && n(/return true/g, lk) >= 3,
  "fx returns=" +
    n(/return true/g, fx) +
    " lock returns=" +
    n(/return true/g, lk),
);
for (const h of HASHLIST) {
  ok(
    "哈希 " + h,
    spawnSync("git", ["cat-file", "-e", h + "^{commit}"], {
      cwd: ROOT,
      encoding: "utf8",
    }).status === 0,
  );
}

/* ── round260 重写：prose 里的哈希引用 ───────────────────────────────────────
 * 旧版三处错，逐条【实测】（复算见 0056 §2）：
 *  ① 判据问错了问题。旧版对每个 token 只问 `cat-file -e <h>^{commit}`，于是把
 *    【内容摘要】当成【腐烂的提交引用】。当时那 3 条红全是误报：
 *      03bf24d = sha256(docs/decisions/0008-phase1-gate-semantics.md 的 HEAD 内容) 前缀
 *      3e1b069 = sha256(test/arch/config-match.test.ts 的 HEAD 内容) 前缀
 *      8823b0a = test/arch/config-match.test.ts 的 git blob sha1 前缀
 *    三者从来不是 commit ⇒ 台账没写错，而旧版汇总语「台账需更新」指向了错的对象。
 *  ② 网眼太窄反而漏掉真引用。只采【恰好 7 位小写】再排除 /^[0-9]{7}$/，于是
 *    6 个真提交引用从来没被看过：0575943（被那道纯数字 filter 吃掉）、3 个 40-hex
 *    的 HEAD 行、11cc7459d793、615d3d96。⇒「排除定义处的 filter 永不生效」那一族。
 *  ③ 没有下限。待验集若为空 ⇒ 失败数为 0 ⇒ 报「全部解析」而绿。写这次的同一轮
 *    我自己就撞了同类：`git cat-file --batch` 吃【对象名】不吃路径，喂错 ⇒
 *    450 个全 missing ⇒ 摘要集空 ⇒ 造出 40 条假红。所以下面是硬断言不是注释。
 *
 * 判据的核心是一条【不对称】，它决定什么才有资格叫腐烂：
 *   · 提交引用与时间无关 —— 一个 commit 哈希要么永远指向某个提交，要么当时就写错了。
 *     解析不了 = 当时就写错 ⇒ 真腐烂 ⇒ FAIL。
 *   · 内容摘要与时间有关 —— HEAD 会变，今天的 HEAD 对不上不能证明当时写错。
 *     ⇒ 匹配就 PASS；对不上也不 FAIL，因为【本脚本无法证伪它】，假装能验就是假绿。
 *   · 注入态/变异态的对照摘要：对象被【故意】删掉，机械上根本不可验 ⇒ 逐条豁免 + 理由。
 *
 * ⚠ 顺序是【先解析、后分类】，不是反过来。中间版本试过「读上下文判断这一格声称是
 *   提交引用还是摘要」，两个方向都错：`sha256 == HEAD blob 03bf24d…` 里既有 sha256
 *   又有 HEAD，正则按窗口先后判成「提交引用」⇒ 5 条假红；而同一个正则把
 *   `HEAD: b192b4a` 这类【真提交引用】漏判成「未判定」⇒ 173 个静默少算。
 *   解析是机械的、无歧义的；散文不是。所以只有【解析不了】的 token 才需要看上下文。
 * 豁免逐条写理由且必须可数（0006 §7 第 28 条：不可数的豁免等于没有判据）。
 * 旧版那张 31 项 FAKE 表里 29 项在被扫的 prose 里从未作为独立 token 出现 = 29 个放行口。
 * ⚠ 不扫本脚本自己的源码：它自己这张豁免表是几十个合成 token 的唯一来源，
 *   自我引用不是「对 git 的声称」。这条排除是显式的，不靠目录规则碰巧生效。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 逐条豁免，每条必须带实测理由；加一条要同时带来一条理由（0006 §7 第 28 条）。
 *  注意这张表【不该】收注入态摘要 —— 那些由紧邻前文的声明在 ② 处放过，
 *  写在这里反而会把「以后同一串被当成真引用」也一并放过。
 *  旧版那张 31 项表里 29 项在被扫 prose 里从未作为独立 token 出现 = 29 个放行口。 */
const EXEMPT = new Map([
  ["83697c4", "round159 变异探针：真提交 83697c3 改末位，从来不是引用"],
  // ⚠ 这里【不该】加 `be07d9b` / `0575942`（0056 §6b 那两个注入值）。第一版加了，实测两连击：
  //   ① 0056 自己被 ①d 判红（那两个值【恰好就是】「离真提交差一位」的形状）；
  //   ② 为压掉 ① 而做的【全局】具名豁免当场把 M1 弄瞎 —— M1 注入的正是 be07d9b，
  //      探针从 9/9 掉到 8/9，红的那条是「这一类缺陷判据没有分辨力」，正是本篇在修的东西。
  //   ⇒ 正确的修法在【写法】一侧，不在判据一侧（与 §5b 的「别原样贴坏字符」、
  //     本探针第 89 行「替换串拆两段写」同一个规矩）：注入值在散文里拆开写，
  //     任何一段都 < 7 位 hex ⇒ 采不到，而读者仍能对着真提交 `be07d9a` 逐字复算。
  //     拆开的代价只是少一点可粘贴性，【没有】少掉可核验性 —— 这不是「判据迁就行文」，
  //     因为这一格【本来就不是引用】：把一个伪造的腐烂值原样放进被扫文件，
  //     它和真腐烂在这个文件里长得一模一样，而那正是 §5b 处理过的那件事。
  // ⚠ 本条理由在 round260 之前写的是「故意不存在」—— 那句【是假的】，实测：
  //   `git rev-parse 7109a8c` = 7109a8cc480262e8…（"round247 临时载体（将被 reset 删除）"）
  //   ⇒ 它是【真提交对象】，只是不可达。但「不可达」要说准：
  //     `git log --all | grep -c ^7109a8cc` = 【0】⇒ 它【不在】脚本的 COMMITS 集合里
  //     ⇒ ① 判不掉它，它一路走到 ④b（existsLoose 认得）被当成【悬空提交引用】。
  //   所以这条豁免是【活的】：它今天生效在 ④，把这条已登记的探针产物挡在「悬空」计数之外。
  //   ⚠ 我第一版在这里写「① 处即被判掉、本条实为死豁免」，那是【照抄一份外部报告的说法没实测】
  //     —— 那份报告说它「present in git log --all」，而这条 grep 实测是 0。同 §7 第 1/2 条那一族。
  [
    "7109a8c",
    "round247 临时载体：真提交对象但不可达（不在 log --all）⇒ 走 ④/④b，已登记的探针产物",
  ],
  ["98a4b9d5", "台账自摘要：写入当时成立，之后台账被追加 ⇒ 过期不等于说过"],
  ["b1fe55c4", "同上（矩阵证据自摘要）"],
  ["bd3b2304", "同上（判定书自摘要）"],
  [
    "71f40f2363f22cad8ee77c462e0ef2fe",
    "0005 示例 payload 的 interrupt id，从来不是 git 对象",
  ],
  ["64e089380c436daff50997e56d8d15b4", "同上"],
  ["5ccb7f84", "POC 输出的 interrupt id，从来不是 git 对象"],
  // 注入态 blob 的对照值：注入文件还原即删 ⇒ 对象【故意】不存在。台账 round242/244 记着。
  // 为什么走【具名豁免】而不是把 "absent"/"blob" 之类词加进 ③ 的窗口判据：
  // 窗口判据会放行【任何】行内含该词的未来 token（一个新的腐烂哈希也可能写在
  // 同一行里），而具名豁免只放行这一串 —— 新腐烂照样红。宁可表长，不可口子宽。
  [
    "8396d239c517e60df96213d58cbcf5d87ad5b242",
    "round244 注入态 blob 对照值，文件已删 ⇒ 故意不存在",
  ],
  ["8396d239c517", "同上，短形式"],
  [
    "211a103257fb",
    "round242 注入态 blob 对照值，文件已删 ⇒ 故意不存在（round255 记 absent）",
  ],
  // round241 还原基准 = 0008 决策文件内容的 sha256（64 位），round255/260 各处按
  // 7/8/16 位截断引用。写入当时为真（round260 实测 `git log 0dbc7a4..HEAD` 该文件
  // 为空 ⇒ 内容从未变）；ffae248（round314 入库）改写 0008 后不再匹配任一 index。
  // 与 98a4b9d5（台账自摘要）同族：写入当时成立，过期不等于说过 —— 不是腐烂。
  // 三条覆盖全部现存截断形态（7/8/16 位），同族改文件后若再红应查新 blob 的 sha256。
  ["03bf24d", "round241 还原基准 = 0008 旧内容 sha256 截断，0008 被 ffae248 改写后过期"],
  ["03bf24d1", "同上（8 位截断）"],
  ["03bf24d15241da01", "同上（16 位截断）"],
  [
    "521daf21",
    "round237 注入目标 abstraction.ts 的 JSDoc 旧内容 sha256 截断，ffae248 改写后过期（同 03bf24d 族）",
  ],
  [
    "360ee441",
    "ui-e2e-walk 运行产物：引擎开的新卡的短 id（seed 卡 360ee441-… 的 8 位显示），运行时生成、非 git 对象",
  ],
]);

/** 紧邻前文（左边 <=40 字符）声明「这一格是对照摘要而非提交引用」。
 *  只在【已经解析不了】之后才查它 —— 见扫描循环的 ② 注释。
 *  ⚠ 这张表【故意不含】"blob" / 裸 "hash"：若含，M3 那发（把真 blob 引用改末位，
 *  写在「真实 HEAD blob 3b7d385f…」这句里）会被自己的措辞放过 —— 判据等于没验。 */
// round353m：从窗口判据摘掉 "absent" —— 154 行注释声明它【不该在③】，
//   实现却漏删（round353l 逐词探针实测 Δ0：删它今天零影响，transient 44→44）。
//   blob 当年删了就删了；absent 补上同一刀，让「未来新腐烂哈希写在 absent 旁」
//   不再被③静默放过 ⇒ 与作者「宁可表长，不可口子宽」的原意对齐。
const CLAIMS_TRANSIENT =
  /(sha256|sha-?256|摘要|digest|hash-object|注入|变异后|变异态|对照)/i;

/** 只在 ①c 用：这一格【已经机械地命中了 blob/摘要索引】，剩下的问题只是
 *  「作者写的是不是一次对象/摘要引用」，所以允许看整行、也允许出现 blob/hash 这类词。
 *  为什么这样放宽是安全的（不是「怎么写才绿」）：这条路【只救命中了真索引的 token】，
 *  而【改坏一位的哈希按定义就不再是真前缀】⇒ 它压根进不到这一桶，措辞救不了它。
 *  实测对照：M3（3b7d385e 改末位 → 3b7d385f）不命中任何索引，仍然红。
 *  残余风险只剩「改坏后【恰好】撞上另一个对象的前缀」+「同行又写着 blob/hash」两件事同时发生，
 *  这一桶的数量在输出里【报数并给样本】，不藏。 */
const CLAIMS_OBJECT =
  /(sha256|sha-?256|摘要|digest|hash|blob|对象|object|base64|sha1)/i;

const gitRaw = (args, input) =>
  spawnSync("git", args, {
    cwd: ROOT,
    encoding: null,
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/* 本仓 git 对象 id 的十六进制位数。从 git 现问而不是写死 40：
   写死了，将来迁 sha256 时这条判据会【静默变松】（>40 那条会放过真的对象 id）。
   拿不到答案就退回 40，但要把实际用值的位数打出来，别让人以为问到了。 */
const OBJECT_HEX_LEN = (() => {
  const r = spawnSync("git", ["rev-parse", "--show-object-format"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const fmt = (r.stdout || "").trim();
  if (r.status === 0 && fmt === "sha256") return 64;
  if (r.status === 0 && fmt === "sha1") return 40;
  console.log(
    "      ℹ git 没报 object format（stdout=" +
      JSON.stringify(fmt) +
      "），按 sha1=40 位处理",
  );
  return 40;
})();

const COMMITS = gitRaw(["log", "--all", "--format=%H"])
  .stdout.toString("utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const BLOBS = [
  ...new Set(
    gitRaw(["ls-tree", "-r", "HEAD"])
      .stdout.toString("utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split("\t")[0].split(/ +/)[2]),
  ),
];
const DIGESTS = [];
{
  const buf = gitRaw(
    ["cat-file", "--batch"],
    Buffer.from(BLOBS.join("\n") + "\n", "utf8"),
  ).stdout;
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const p = buf.subarray(i, nl).toString("utf8").split(" ");
    if (p.length === 3 && p[1] === "blob") {
      DIGESTS.push(sha256(buf.subarray(nl + 1, nl + 1 + Number(p[2]))));
      i = nl + 1 + Number(p[2]) + 1;
    } else {
      i = nl + 1;
    }
  }
}
// 下限：索引自己坏了必须立刻停，不能让「空集合 ⇒ 什么都匹配不上 ⇒ 全当跳过」冒充通过。
if (COMMITS.length < 100 || DIGESTS.length !== BLOBS.length) {
  console.log(
    "FAIL  索引自检  -> commits=" +
      COMMITS.length +
      " blobs=" +
      BLOBS.length +
      " digests=" +
      DIGESTS.length,
  );
  console.log("\n1 FAIL: 索引不完整，本次结果作废（不要读成「引用都好的」）");
  process.exit(1);
}
const prefixOf = (h, list) =>
  h.length <= 64 && list.some((x) => x.startsWith(h));
/** ①c 用的「位数够长」下限：让【随机改坏一位之后仍然撞中某条索引】的概率 ≤ 1e-12。
 *  从索引规模现算，不写死 —— 与 OBJECT_HEX_LEN 同一个理由：写死了，将来仓库文件数变了
 *  这条会【静默变松或变紧】。推导：要 n / 16^L <= 1e-12 ⇒ L >= log16(n*1e12)。
 *  实测本仓 n=448 ⇒ 门槛 = 13 位（16^13 = 4.5e15 ⇒ 448/4.5e15 = 1.0e-13；12 位是 1.6e-12
 *  还差一点，所以循环给的是 13 而不是我最初注释里写的 12 —— 注释错过一次，按代码为准）。
 *  为什么用位数而不是【读散文】：round255 那张矩阵表是 `| 前缀 | 路径 | MATCH |` 的表形，
 *  行内【没有】任何「sha256/摘要」字样（表头才有），靠措辞会把这些【为真的记录】判成腐烂，
 *  而「改坏一位就再也命不中索引」是与措辞无关的机械事实。
 *  ⚠ 它【不】放宽 M1/M2/M3 那一类：改坏一位的哈希压根不在索引里，多长都救不了它。 */
const MIN_UNIQUE_HEX_LEN = (() => {
  const n = Math.max(BLOBS.length, DIGESTS.length, 1);
  let L = 1;
  while (n / 16 ** L > 1e-12) L++;
  return Math.max(L, 8);
})();
/** 悬空对象：cat-file 认得但不在任何 ref 上（多为 --amend 中间态）⇒「当时存在过」仍真。 */
const existsLoose = (h) =>
  spawnSync("git", ["cat-file", "-e", h], { cwd: ROOT, encoding: "utf8" })
    .status === 0;

/* ①d 用的两张表与那条判据 —— 「这一串离一个真提交只差一位」。
 * 为什么需要它（两条【静默假绿】都是注入实测，不是推演）：
 *   · 数字形腐烂 `0575942`（真提交 0575943 改末位）原本走到 ④c 被【纯数字】放过、不点名；
 *   · 字母形腐烂 `be07d9b` 只要同一行左边出现「对照」就被 ③ 放过、也不点名。
 * 两者共同点：落进【跳过】桶，而那些桶放过的都是「机械上无法验」的东西 ——
 * 可这一串偏偏【能验】：它离一个真提交只差一位，而「差一位」正是腐烂的定义。
 * 判据只问这件机械事实，不看散文 ⇒ 与 ③/①c-乙 相反，它【不依赖措辞】。
 * ⚠ 误伤已实测（0056 §6b 那张表，逐桶过）：这条新增的红在【当前语料】上 = 0 个，
 *   唯一被抓到的 `83697c4` 是文档明写的探针产物，走具名豁免。⇒ 它不是恒红判据。
 *   ⚠ 这里【故意不写 token 总数】：写了就是一个会自己过期的数（本注释的前一版写着「当前 478 个」，
 *   而本篇文档每编辑一次这个数就涨 —— 本轮内它已经从 478 漂到 495）。
 *   读数口径永远是现跑现看：输出里「分项和 N = token N」那一行。
 *   要复算误伤而不是相信这句注释：见 0056 §6b 表下第 ④ 条（那个复算脚本自带一条
 *   「本脚本 token 数 == 主脚本报的数」的自检，不一致就直接 exit(2) 作废）。 */
const HEX_DIGITS = "0123456789abcdef";
/** 提交前缀全集（7 位 ~ 对象 id 位数减一），用来 O(1) 问「某个邻居是不是真提交前缀」。 */
const COMMIT_PREFIXES = new Set(
  COMMITS.flatMap((c) => {
    const out = [];
    for (let L = 7; L < OBJECT_HEX_LEN; L++) out.push(c.slice(0, L));
    return out;
  }),
);
/** 甲（7 <= 位数 < 对象 id）：逐位换一个 hex，能撞回某个真提交前缀就返回撞中的那个。 */
const oneEditFromCommit = (h) => {
  for (let i = 0; i < h.length; i++)
    for (const d of HEX_DIGITS)
      if (d !== h[i] && COMMIT_PREFIXES.has(h.slice(0, i) + d + h.slice(i + 1)))
        return h.slice(0, i) + d + h.slice(i + 1);
  return null;
};
/** 乙（位数 > 对象 id）：某个完整提交 id 恰是它的前缀 ⇒「引用后面多打了几位」，那也是腐烂。 */
const commitIsItsPrefix = (h) => COMMITS.find((c) => h.startsWith(c)) ?? null;

const walk = (dir, acc, depth) => {
  if (depth > 6) return acc;
  let ents;
  try {
    ents = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of ents) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!/node_modules|\.git|\.tmp|dist/.test(full))
        walk(full, acc, depth + 1);
    } else if (/\.(txt|md|mjs)$/.test(e)) acc.push(full);
  }
  return acc;
};
const SELF = join(DOCS, "review", "verify-open-invariants.mjs");
const files = [];
for (const base of [WORKBUDDY, DOCS])
  for (const f of walk(base, [], 0)) if (f !== SELF) files.push(f);

/* 每个 token 必须【恰好落进一个】桶 —— 下面 ok() 处断言求和 == tokens。
 * 之所以要这条断言而不是「看着对就行」：我在本轮中间版本里两次把同一个 token
 * 同时计进两个桶（短前缀既记 ambiguous 又记 digest），于是「计数:」那一行的
 * 分项加起来比总数大，而输出读起来完全正常。分项加起来不等于总数 = 判据自己
 * 在数两遍或漏数，正是这一族要抓的东西（0055 的 1+3≠3 同形）。 */
const t = {
  commit: 0, // ① 解析成真提交前缀
  digest: 0, // ①b 位数唯一指认（40 位 blob sha1 / 64 位 sha256）
  shortByEntropy: 0, // ①c-甲 短前缀命中索引 + 位数够长（撞中概率 <= 1e-12）
  shortByWording: 0, // ①c-乙 短前缀命中索引 + 同行写着 blob/hash/摘要…
  tooLong: 0, // ② 位数 > 对象 id 位数 ⇒ 不可能是本仓对象 id
  transient: 0, // ③ 向左 40 字符声明这是对照摘要/注入态
  exempt: 0, // ④ 具名豁免（逐条带理由）
  dangling: 0, // ④b 对象还在但不在 ref 上
  numeric: 0, // ④c 纯数字，不是 hash
};
const BUCKET_KEYS = Object.keys(t);
const rot = [];
const dangling = [];
const transientSamples = [];
const entropySamples = [];
const wordingSamples = [];
/** 豁免表活性：每条 key 在语料里作为独立 token 出现了几次。
 *  为什么要有这个计数 —— 旧版那张 31 项 FAKE 表里 **29 项从未出现**（0056 §2②），
 *  也就是那张表根本没被数据约束过。我重写了它，但【没有加任何断言】的话，
 *  这张新表会以同样的方式慢慢长回一堆没人核对过的放行口。 */
const exemptSeen = new Map(EXEMPT.keys().map((k) => [k, 0]));
/** 真正【在 ④ 被用掉】的那些 key。与上面那个计数分开是有原因的：
 *  「出现过」与「在这张表上被用掉」不是一回事 —— 台账自摘要那两条今天命中 ①b
 *  （内容与 HEAD 一致）就根本走不到 ④。合起来数就会把【前瞻豁免】误报成死条目。 */
const exemptHit = new Set();
let tokens = 0;
for (const f of files) {
  let src;
  try {
    src = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  src.split(/\r?\n/).forEach((line, idx) => {
    const where =
      f.replace(ROOT + "\\", "").replace(ROOT + "/", "") + ":" + (idx + 1);
    // UUID（8-4-4-4-12，如审批卡 id `af92c1e1-2173-…`）的四段都形似 hex hash，
    // 但整串【结构上】是运行时生成的 id，不是对 git 对象的声称 —— 在采集前整段
    // 换成非 hex 占位，避免它的每一段被当成独立引用（round315 实测 18 条假红全
    // 是这一族：round309 记录、seed.txt、ui-e2e-walk、ui-seed-run2 里的卡 id）。
    // 为什么用【整行替换】而不是在 match 处回看 36 字符：UUID 的 8 位首段
    // 恰好也有 8 位，会被 regex 单独采到，回看窗口装不下完整 36 位 UUID。
    const uuidSafe = line.replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      "UUID",
    );
    for (const m of uuidSafe.matchAll(/\b[0-9a-fA-F]{7,}\b/g)) {
      const h = m[0].toLowerCase();
      tokens++;
      if (exemptSeen.has(h)) exemptSeen.set(h, exemptSeen.get(h) + 1);
      // ① 先解析。机械、无歧义，不看散文。
      if (prefixOf(h, COMMITS)) {
        t.commit++;
        continue;
      }
      // ①b 【只有位数唯一指认一个对象】才允许被 blob/摘要索引硬放过。
      //     为什么不能像中间版那样直接 `prefixOf(h, BLOBS) || prefixOf(h, DIGESTS)`：
      //     blob 的 sha1 短前缀与【腐烂的提交引用】形状完全一样（7~40 位十六进制），
      //     而「改坏一位之后恰好也是某个 blob 的前缀」是有的 —— 实测当前语料里就有
      //     3 处短 blob 前缀（3b7d385e / 23175d7f / 8823b0a）。那条判据会把【改坏一位的
      //     真提交引用】报成「已核验的内容摘要」并计入通过数 ⇒ 假绿，且是最坏的一种：
      //     它长得像证据。完整 40 位（sha1 对象 id）/ 完整 64 位（sha256）不一样：
      //     位数本身排除了「同前缀的另一个对象」。
      if (h.length === OBJECT_HEX_LEN && prefixOf(h, BLOBS)) {
        t.digest++;
        continue;
      }
      if (h.length === 64 && prefixOf(h, DIGESTS)) {
        t.digest++;
        continue;
      }
      // ①c 短前缀但确实命中 blob/摘要索引：形状与「腐烂的提交引用」不可区分，所以
      //    【不接受机械硬通过】，只接受二者其一的【正面理由】：
      //      (甲) 位数 >= MIN_UNIQUE_HEX_LEN ⇒ 「改坏一位还撞得中索引」的概率 <= 1e-12，
      //          这是与措辞无关的机械事实。为什么要它：round255 那张矩阵表是
      //          `| 前缀 | 路径 | MATCH |` 的表形，行内没有「sha256/摘要」字样（只有表头有），
      //          纯靠措辞会把【为真的记录】判成腐烂 —— 第一版就是这么红了 4 条。
      //      (乙) 同一行正文明确写着 blob/hash/摘要/对象… ⇒ 作者自己说了这是对象引用。
      //    ⚠ 为什么这条放宽【不会】把 M1/M2/M3 那类放掉：它们都是【改坏一位】的产物，
      //    改坏之后就不再命中任何索引 ⇒ 压根进不到这一桶，多长的位数、多宽的措辞都救不了。
      //    实测复证：探针里「16 位摘要前缀改末位」仍然红（见 0056 §6）。
      //    残余风险只剩「改坏后恰好撞上另一条真索引的前缀」，其概率由 MIN_UNIQUE_HEX_LEN
      //    压到 1e-12 量级；短于该位数的只能靠(乙)，这一桶的数量在输出里【报数并给样本】。
      const prefixHitsIndex =
        (h.length < OBJECT_HEX_LEN && prefixOf(h, BLOBS)) ||
        (h.length < 64 && prefixOf(h, DIGESTS));
      if (prefixHitsIndex) {
        // 分两个计数器而不是合并成一个：两个放行口的【依据强度】完全不同（一个是概率、
        // 一个是散文措辞），合并报数就看不出「这一轮又有多少靠措辞过的」—— 而措辞是
        // 可以被人改写出来的，概率不行。看不见自己放了什么 = 没有判据。
        if (h.length >= MIN_UNIQUE_HEX_LEN) {
          t.shortByEntropy++;
          if (entropySamples.length < 8) entropySamples.push(h + " @ " + where);
          continue;
        }
        if (CLAIMS_OBJECT.test(line)) {
          t.shortByWording++;
          if (wordingSamples.length < 8) wordingSamples.push(h + " @ " + where);
          continue;
        }
      }
      // ①d 【离一个真提交只差一位】⇒ 不许静默跳过。round260 补，关掉两条实测到的静默假绿：
      //      · 数字形 `0575942`（真提交 0575943 改末位）原本走到 ④c 被【纯数字】放过、不点名；
      //      · 字母形 `be07d9b` 只要同一行左边出现「对照」就被 ③ 放过、也不点名。
      //    两条共同点：它们落进【跳过】桶，而那些桶放过的都是「机械上无法验」的东西 ——
      //    可这一串偏偏【能验】：它离一个真提交只差一位，而「差一位」就是腐烂的定义。
      //    判据只问这件机械事实，不看散文 ⇒ 与 ③/①c-乙 相反，它【不依赖措辞】。
      //    ⚠ 顺序：必须【先查豁免、再判这一条】，否则 `83697c4`（文档明写的「真提交 83697c3
      //      改末位」探针产物）会变红 —— 那是误伤而不是发现。实测见下面 ok() 那两条。
      if (!EXEMPT.has(h)) {
        const near =
          h.length >= 7 && h.length < OBJECT_HEX_LEN
            ? oneEditFromCommit(h)
            : commitIsItsPrefix(h);
        if (near) {
          // 直接算腐烂，不进任何跳过桶 —— 「进桶即放过」就是这一格要修的病。
          // 红因里【同时给出它撞中的那个真提交】，否则红了也读不出是哪种错法。
          rot.push(
            h +
              " @ " +
              where +
              " | 离真提交 " +
              near +
              " 只差一位（改坏一位的提交引用；豁免表里没有这一串）",
          );
          continue;
        }
      }
      // ② 长度本身就能【证明】它不可能是本仓的 git 对象 id：sha1 仓里对象 id 恰为 40 位，
      //    所以 >40 的只能是 sha256 一族（或其截断）。这条比读散文强：它不依赖措辞。
      //    位数从 git 现问，不写死 —— 将来迁 sha256 时这条会自己跟着变。
      //    ⚠ 它排在 ①d【之后】是重点：>40 里有一类是「引用后面多打了几位」，
      //      那一类【是】腐烂的形状，不能让长度这条「不依赖措辞」的规则把它放掉。
      if (h.length > OBJECT_HEX_LEN) {
        t.tooLong++;
        continue;
      }
      // ③ 解析不了【才】看上下文。方向很重要：这一步只会放过「本来就无法机械验证」的东西，
      //    不可能放过一个可解析的提交引用（那已经在 ① 判掉了）。所以这里的误判代价是
      //    「少验一个」，而不是「把腐烂说成好的」。
      if (
        CLAIMS_TRANSIENT.test(
          uuidSafe.slice(Math.max(0, m.index - 40), m.index),
        )
      ) {
        t.transient++;
        if (transientSamples.length < 8)
          transientSamples.push(h + " @ " + where);
        continue;
      }
      // ④ 已知的非引用（示例 payload 的 id、探针造出来的形似 hash、台账自摘要）。
      if (EXEMPT.has(h)) {
        t.exempt++;
        exemptHit.add(h);
        continue;
      }
      // ④b 悬空对象 = 对象还在（可能是 commit，也可能是 blob/tag），但不在任何 ref 上。
      //     round315 前只查 `<h>^{commit}`，于是「历史 blob 引用」（如 round260 记的
      //     3b7d385e…，ffae248 改写文件后掉出 HEAD 树）被漏进 ⑤ 误报成腐烂 —— 那一族
      //     与悬空提交同构：作者引用的对象当时真实存在，只是现在不可从 ref 到达。
      //     判据只问「这个对象在对象库存不存在」，裸 `-e h` 同时覆盖 commit 与 blob。
      if (h.length <= 40 && (existsLoose(h + "^{commit}") || existsLoose(h))) {
        t.dangling++;
        dangling.push(h + " @ " + where);
        continue;
      }
      if (/^[0-9]+$/.test(h)) {
        t.numeric++;
        continue;
      } // 1048576 / 1700000000000 这类
      // ⑤ 走到这里 = 看起来是个引用、既不可解析、也无声明也无豁免理由 ⇒ 红。
      rot.push(h + " @ " + where + " | " + line.trim().slice(0, 90));
    }
  });
}

ok(
  "prose 里的哈希引用全部可解析或有逐条理由（豁免 " + t.exempt + " 处）",
  rot.length === 0,
  rot.length
    ? rot.slice(0, 5).join("\n            ") +
        (rot.length > 5 ? "\n            …共 " + rot.length + " 条" : "")
    : "提交引用 " + (t.commit + t.dangling) + " 条 / 摘要 " + t.digest + " 条",
);
// 分项求和必须等于 token 数：多算/漏算都会让上面那句「全部可解析」变成没数过的话。
// rot 是第 ⑤ 桶（不在 t 里），所以断言带上它。
const bucketSum = BUCKET_KEYS.reduce((a, k) => a + t[k], 0) + rot.length;
ok(
  "桶分项求和 == token 数（防同一 token 计两遍 / 漏计）",
  bucketSum === tokens,
  "分项和 " +
    bucketSum +
    " vs token " +
    tokens +
    " —— 不等就是判据在数两遍或漏数",
);
// 豁免表必须【逐条被数据约束】：一条 key 如果在被扫语料里压根不作为 token 出现，
// 它就只是一个「我以为会出现」的条目 —— 旧版那张表 31 项里 29 项就是这个形状。
// ⚠ 只判「从未出现」这一种，不判「出现了但被更早的桶判掉」：后者是【前瞻豁免】，
//   例如台账自摘要那两条今天命中 ①b（内容与 HEAD 一致），等台账被追加之后才会落进 ④。
//   把它判红 = 惩罚一条写对了的豁免，那是在造新的恒红（本轮的主题）。⇒ 下面分开报。
const exemptDead = [...exemptSeen].filter(([, n]) => n === 0);
const exemptLater = [...exemptSeen].filter(
  ([k, n]) => n > 0 && !exemptHit.has(k),
);
ok(
  "豁免表逐条被数据约束（没有「从未出现」的放行口）",
  exemptDead.length === 0,
  exemptDead.length
    ? exemptDead.map(([k]) => k).join(", ") +
        " 在被扫 prose 里从不作为 token 出现"
    : "表长 " + EXEMPT.size + "，条条都出现过",
);
// round346：把「加了豁免却从不生效」从提示升成断言（0056 §8 明记的没修项）。
// 旧断言只数「出现过」—— `be07d9`+`b` 那条在旧断言下完全合格（它确实在语料里出现），
// 而它已经把 M1 弄瞎了。要防的形状是「每条豁免是否被④真的用掉」：
//   · exemptHit = 真正走到 ④ 被放行 ⇒ 承重；
//   · 「出现过、但被更早的桶判掉」= 前瞻豁免（台账自摘要族会先命中①b）——
//     它们不是死条目，但【今天没在④承重】，多一条就得当天踩到才证明不是空头。
//   ⇒ 一律断言「没有前瞻豁免」。今天 16 条全落④；将来有人加豁免却不生效/不承重，
//     这一条当场红，而不是等哪发探针撞巧。
ok(
  "豁免表每条都被④用掉（没有「加了却从不生效」的空头条目）",
  exemptLater.length === 0,
  exemptLater.length
    ? "今天没进④的豁免：" +
        exemptLater.map(([k]) => k + "(出现" + exemptSeen.get(k) + "次)").join(", ") +
        " —— 要么是本该被更早桶放行的前瞻豁免，要么是根本没人盯的死放行口"
    : "表长 " + EXEMPT.size + "，条条都在④承重",
);
// 采集面下限：token 数塌了 ⇒ 上面那句「全部可解析」就是没数过的假绿。
ok(
  "采集面下限（prose token >= 300）",
  tokens >= 300,
  "实得 " +
    tokens +
    " / 文件 " +
    files.length +
    " 个 —— 掉了说明 walk 或正则坏了，别读成「引用都好的」",
);
console.log(
  "      计数: 可达提交引用=" +
    t.commit +
    " 悬空提交引用=" +
    t.dangling +
    " 位数唯一指认的对象/摘要=" +
    t.digest +
    " 短前缀·按位数放过=" +
    t.shortByEntropy +
    " 短前缀·按措辞放过=" +
    t.shortByWording +
    " 纯数字=" +
    t.numeric +
    " 豁免=" +
    t.exempt +
    " 按声明跳过=" +
    t.transient +
    " 位数不可能是对象id=" +
    t.tooLong +
    " 腐烂=" +
    rot.length +
    " ｜分项和 " +
    bucketSum +
    " = token " +
    tokens,
);
// ①c 两个放行口必须【分别报数并给样本】：它们是本轮新开的口子，
// 不报就等于把「我没验」混进「我验过了」。位数那一档还有概率兜底，
// 措辞那一档【没有任何机械依据】，所以单独列出来、并把门槛位数打出来。
if (t.shortByEntropy) {
  console.log(
    "      ℹ 短前缀命中 blob/摘要索引、按【位数 >= " +
      MIN_UNIQUE_HEX_LEN +
      "】放过 " +
      t.shortByEntropy +
      " 处（改坏一位仍撞中索引的概率 <= 1e-12）—— " +
      entropySamples.join(", "),
  );
}
if (t.shortByWording) {
  console.log(
    "      ⚠ 短前缀命中索引、【只靠同行措辞】放过 " +
      t.shortByWording +
      " 处（这类只核到「作者说它是对象/摘要」，没有机械依据 —— 位数 < " +
      MIN_UNIQUE_HEX_LEN +
      "）—— " +
      wordingSamples.join(", "),
  );
}
// 按声明跳过的那批必须【报数并给样本】：否则「跳过了 40 个」与「压根没扫到」输出一样。
if (t.transient) {
  console.log(
    "      ℹ 按紧邻前文声明（sha256/摘要/注入态/对照…）跳过 " +
      t.transient +
      " 处，这类【机械上不可证伪】—— " +
      transientSamples.join(", "),
  );
}

if (t.dangling) {
  console.log(
    "      ⚠ 悬空提交引用 " +
      t.dangling +
      " 处：对象还在但不在任何 ref 上（多为 --amend 中间态）⇒ git gc 之后会真的解析不了 —— " +
      dangling.slice(0, 4).join(", "),
  );
}
console.log(
  "\n" +
    (fail === 0
      ? "SUCCESS: 提交引用全部可解析；内容摘要类引用不属本脚本可证伪范围，逐条豁免并写明理由"
      : fail + " FAIL: 见上"),
);
process.exit(fail === 0 ? 0 : 1);
