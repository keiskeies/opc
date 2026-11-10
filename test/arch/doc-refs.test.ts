/**
 * 决策文档里的「文件:行号」引用会漂移，而且漂移逃过全部现有检查。
 *
 * 一条 foo.ts:150 写下去，就等于对那一行的内容下了一个隐式断言，却没有任何东西守着它。
 * 2026-11-08 真漂过一次：往 step-tx.test.ts 插入 38 行测试（提交 8f181cc），把 0006 里引用的
 * 两个行号推到了别的语句上。目标行【非空】，所以「越界」和「空行」都抓不到；注释不参与编译，
 * tsc 无感；它不是断言，测试也无感。0006 §7 第 1 条立过「写引用时同时写下核查命令」，可「记得去核实」
 * 正是那条规矩要消灭的东西 —— 所以这里把「目标行的内容」变成显式快照：行号一漂，立刻变红。
 *
 * 取舍一：只认完整形态 foo.ts:123。同一行里的缩写续写（写完 a.test.ts:276 之后接着写 :261）
 * 【不覆盖】。理由不是省事，是它无法可靠地从文本里挣出来：决策文档里的 JSON 样例同样长着 :42
 * 的样子，把它们当引用会造出大量假阳，而假阳一多，守卫就会被人关掉（0007 §4.1 记的正是这个
 * 代价：假红比假绿更贵，因为人会动手关掉它）。缩写引用紧跟在同一句的完整引用后面，漂一起漂、
 * 改一起改，这部分由人工承担。
 *
 * 取舍二：更好的写法本来是把行号换成可 grep 的特征串（0006 里那三处本轮就是这么改的）。本守卫不
 * 负责把谁的写法改掉，它只保证「行号一旦漂移立刻变红」，而不是等下次有人恰好记得去读那一行。
 *
 * SNAP 是快照。它【应当】随被引用文件的真实改动一起更新：那是唯一诚实的更新时机 —— 你在改代码，
 * 顺手看到快照红了，才需要去核对那句引用还成不成立。不要写自动重写快照的脚本：那等于把这条守卫
 * 变成它要防止的东西。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const NL: string = String.fromCharCode(10);
const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DECISIONS: string = join(ROOT, "docs", "decisions");

// 不在仓库源码树里的引用：@langchain/core 的构建产物，行号随发版漂移，允许存在但必须在这里报名。
// 不在名单里又找不到文件，就当作【写错了的文件名】报出来 —— 决策文档里写一个不存在的路径，与本
// 守卫要抓的是同一类假事实。
const EXTERNAL: ReadonlySet<string> = new Set(["outputs.d.ts"]);

const FILE_REF: RegExp =
  /([A-Za-z0-9_./-]+[.](?:ts|tsx|mts|cts|js|mjs|cjs|md|sql))[:]([0-9]+)/g;

type Ref = { doc: string; file: string; ln: number };
type Problem = { key: string; why: string };

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (
      e.name === "node_modules" ||
      e.name === ".git" ||
      e.name === ".tmp" ||
      e.name === "dist"
    ) {
      continue;
    }
    const p: string = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(relative(ROOT, p).split(sep).join("/"));
  }
}

function repoNames(): string[] {
  const out: string[] = [];
  walk(ROOT, out);
  return out.sort();
}

function decisionDocs(): Map<string, string> {
  const m: Map<string, string> = new Map();
  for (const f of readdirSync(DECISIONS)
    .filter((x: string): boolean => x.endsWith(".md"))
    .sort()) {
    m.set(f, readFileSync(join(DECISIONS, f), "utf8"));
  }
  return m;
}

function extractRefs(docs: Map<string, string>): Ref[] {
  const refs: Ref[] = [];
  for (const [doc, text] of docs) {
    const lines: string[] = text.split(NL);
    for (const l of lines) {
      FILE_REF.lastIndex = 0;
      let m: RegExpExecArray | null = FILE_REF.exec(l);
      while (m !== null) {
        refs.push({ doc, file: m[1] ?? "", ln: Number(m[2]) });
        m = FILE_REF.exec(l);
      }
    }
  }
  return refs;
}

function keyOf(ref: Ref): string {
  return ref.doc + ">" + ref.file + ":" + ref.ln;
}

// 歧义要报：只写基名而有多个同名文件，说明这条引用没指定清楚是哪一个。
function resolveTarget(file: string, names: string[]): string | undefined {
  const direct: string[] = names.filter(
    (p: string): boolean => p === file || p.endsWith("/" + file),
  );
  if (direct.length === 1) return direct[0];
  if (direct.length > 1) return undefined;
  const base: string = file.split("/").pop() ?? "";
  const byBase: string[] = names.filter((p: string): boolean =>
    p.endsWith("/" + base),
  );
  return byBase.length === 1 ? byBase[0] : undefined;
}

function verify(
  docs: Map<string, string>,
  names: string[],
  read: (rel: string) => string | undefined,
  snap: Record<string, string>,
): Problem[] {
  const problems: Problem[] = [];
  const seen: Set<string> = new Set();
  for (const ref of extractRefs(docs)) {
    if (ref.file === "" || EXTERNAL.has(ref.file)) continue;
    const key: string = keyOf(ref);
    const rel: string | undefined = resolveTarget(ref.file, names);
    if (rel === undefined) {
      problems.push({ key, why: "仓库里找不到该文件，或同名歧义没指定目录" });
      continue;
    }
    seen.add(key);
    const src: string[] | undefined = read(rel)?.split(NL);
    if (src === undefined) {
      problems.push({ key, why: "读不到目标文件" });
      continue;
    }
    if (ref.ln < 1 || ref.ln > src.length) {
      problems.push({ key, why: "越界：目标文件只有 " + src.length + " 行" });
      continue;
    }
    const text: string = (src[ref.ln - 1] ?? "").trim();
    if (text === "") {
      problems.push({ key, why: "目标行是空行，引用没有内容可指" });
      continue;
    }
    const want: string | undefined = snap[key];
    if (want === undefined)
      problems.push({
        key,
        why: "快照里没有这条引用（新增，或文档里已被改写）",
      });
    else if (want !== text)
      problems.push({
        key,
        why: "目标行内容与快照不符：快照 [" + want + "] 现在是 [" + text + "]",
      });
  }
  for (const key of Object.keys(snap)) {
    if (!seen.has(key))
      problems.push({ key, why: "快照里有，文档里已经没有这条引用" });
  }
  return problems;
}

const SNAP: Record<string, string> = {
  "0006-cli-resume-and-identity.md>graph/thread.ts:24":
    "export function threadConfig(taskId: string): { configurable: { thread_id: string } } {",
  "0006-cli-resume-and-identity.md>graph/thread.ts:25":
    "return { configurable: { thread_id: taskId } };",
  "0006-cli-resume-and-identity.md>cli.ts:5":
    "* 验收对象是【命令行退出码】，必须能被真子进程执行来验证。计划 V13 实测过 ——",
  "0006-cli-resume-and-identity.md>cli.ts:479":
    'io.error("错误：" + p.error + "\\n\\n" + USAGE + "\\n");',
  "0006-cli-resume-and-identity.md>write-queue.test.ts:207":
    'it("失败之后立刻 close()：不得重抛旧失败，且必须真的关掉连接", async () => {',
  // §7-39 里为了举证【真正的消费者一掏空就红】而写下的坐标；登记同轮完成，不留红过夜。
  // 漂过一次：原本是第 225 行，本轮在同文件上方新增一条 it（scoped 子包扫描的回归），
  // 把它顶到第 258 行 —— 行内容一字未变，只有编号动。这正是本守卫的设计用途：
  // 【引用没变错、目标没变错，只是行号动了】也要能被看见，不然「行号引用」这件事
  // 根本没有可靠性可言。0006 正文里那句历史叙述刻意写成「第 225 行」而不是坐标形态，
  // 因为守卫会把手写的每一个 文件:行号 都当成当下的活坐标来要快照。
  "0006-cli-resume-and-identity.md>production-deps.test.ts:258":
    "expect(isRuntimeFixture(BOUNDARY_PROBE)).toBe(true);",
  // 同一轮里第二次被 doc-refs 抓住：正文写了坐标却没登记快照；连着两次 => 【登记快照】
  // 已是写文档的固定动作，见 0006 §7-40。
  "0007-test-type-coverage-blindspot.md>cli.ts:489": "try {",
  "0007-test-type-coverage-blindspot.md>db/driver.ts:64": "try {",
  "0007-test-type-coverage-blindspot.md>db/migrate.ts:120": "try {",
  "0007-test-type-coverage-blindspot.md>checkpoint/saver.ts:378": "try {",
  "0007-test-type-coverage-blindspot.md>checkpoint/tx-scope.ts:86": "try {",
  "0007-test-type-coverage-blindspot.md>graph/audit-middleware.ts:167": "try {",
  "0007-test-type-coverage-blindspot.md>db/migrate-cli.ts:120": "try {",
  "0007-test-type-coverage-blindspot.md>internal/direct-run.ts:19": "try {",
  // 235 → 258：Task 3.3 把 Writer / HubWriter 两个类型从 http/real-deps.ts 搬进
  // write-queue.ts（org/commit.ts 要排队写库，而 org/ 不该为了学「怎么排队」去 import
  // 一个 http 模块）。新增那 23 行落在 assertParamCount 之后、tx() 之前，
  // 于是 tx() 与 node() 里那两处 #rejected 各往下挪 23 行 —— 行内容一字未变。
  // 这是本守卫第【四】次抓到同一件事，而且这一次被挪的文件本身没被改坏：
  // 漂移是【搬类型】这种看起来最无害的改动带出来的。
  // 同一行里那个 `:284` 是简写形态（不带文件名），守卫不提取它 —— 所以那句
  // 【只登记一个坐标】是不够的：第二个站点靠人核对。本轮核对过：两处都是
  // `try {` + 紧接的 #rejected，判据不变。
  "0007-test-type-coverage-blindspot.md>db/write-queue.ts:258": "try {",
  // 369 → 375：本轮给 KIND_TO_ACTION / targetOf 各加了一条 case（新事件 kind
  // ApprovalDecided），把它下面那一行 try 顶下去 6 行。守卫又一次抓住同一件事：
  // 【代码没写错、文档也没写错，只是行号动了】。
  "0007-test-type-coverage-blindspot.md>events/recorder.ts:375": "try {",
  "0007-test-type-coverage-blindspot.md>recorder.ts:248":
    "// 默认必须【可见】而不是静默：投影失败是可用性事故（前端看不到进度），",
  "0007-test-type-coverage-blindspot.md>driver.ts:30":
    "export function openDb(path: string): DatabaseSync {",
  "0007-test-type-coverage-blindspot.md>driver-preflight.test.ts:17":
    'type Db = InstanceType<typeof import("node:sqlite")["DatabaseSync"]>;',
  "0007-test-type-coverage-blindspot.md>migrate.test.ts:17": "type Db = {",
  "0007-test-type-coverage-blindspot.md>schema-0001.test.ts:19": "type Db = {",
  "0007-test-type-coverage-blindspot.md>saver.contract.test.ts:448":
    "it.skip(title, fn);",
  // 0010 里那两条【承重实测】的出处。它们必须是活坐标而不是叙述：
  // 0010 §3 那一条改动的整个论据是「txScope 在 BEGIN 与 COMMIT 之间 await」，
  // 另一条给出的是 5000ms 这个具体数字（P5 那次「等了 5444ms 才报错」的出处）。
  // 任何一处挪动，都意味着 0010 那一段要么写错、要么已经不再成立。
  "0010-approval-write-path-and-lock.md>checkpoint/tx-scope.ts:82":
    "const result = await body();",
  "0010-approval-write-path-and-lock.md>db/pragmas.ts:19":
    "export const BUSY_TIMEOUT_MS = 5000;",
  // 0012 的三条活坐标。第一条是本篇整篇的**前提**：那个 `DEFAULT 1` 就是
  // 「每条任务的 graph_version 都是假的 1」这个论断的出处。它一旦被人改成
  // DEFAULT 0、或补上一个真的 v1 种子行，0012 §1 那段论证当场失效 ——
  // 所以它必须是活坐标，不能写成「初始化迁移里那个默认值」这种 grep 不出的叙述。
  "0012-org-versioned-commit-and-unwritten-graph-version.md>0001_init.sql:49":
    "graph_version INTEGER NOT NULL DEFAULT 1   -- 创建时组织图版本（§18.4）",
  // 后两条是 §7 那次【撤回】的替身：我原先拿「规格不列端点」当「端点名是冻结值」的依据，
  // 实测规格零命中，真正的契约面是下面这张表。登记的用处不只是举证，
  // 而是**下一次加端点时必须有人动这张表**：那张表一动，这段论证就要被重读一遍。
  // 注：`api.ts` 这个基名【有歧义】（另有 packages/desktop/src/preload/api.ts），
  // 所以两条都得写全路径 —— 只写 `api.ts:56` 会被 resolveTarget 判成歧义并报错。
  // 这是本守卫抓的第三类问题：前两类是行号漂移与目标行改写，这一类是【同名文件没指定目录】。
  //
  // 第二条的**行号在本篇写完后动过一次**（56 → 64）：Task 3.4 把 replay 搬进
  // IMPLEMENTED 之后，那张表头上多注释了一段。这正是活坐标该有的反应 ——
  // 快照当场红，逼人重读那段论证，而不是让文档继续指着一句 `/**` 讲 UNIMPLEMENTED。
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:29":
    "export const API_ENDPOINTS = [",
  "0012-org-versioned-commit-and-unwritten-graph-version.md>packages/contracts/src/api.ts:64":
    "export const UNIMPLEMENTED_ENDPOINTS: readonly ApiEndpoint[] = [];",
};

describe("决策文档里的「文件:行号」引用不漂移", () => {
  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    const names: string[] = ["pkg/a.test.ts", "pkg/b.test.ts"];
    const store: Map<string, string> = new Map([
      ["pkg/a.test.ts", "alpha" + NL + "beta"],
      ["pkg/b.test.ts", "gamma"],
    ]);
    const read = (rel: string): string | undefined => store.get(rel);
    const docs: Map<string, string> = new Map([
      [
        "0999-x.md",
        "看 a.test.ts:1 与 a.test.ts:2 与 zzz.ts:9 与 b.test.ts:3" + NL,
      ],
    ]);
    // 故意只给一条快照、且文本写错：三类问题必须各被抓到。
    const problems: Problem[] = verify(docs, names, read, {
      "0999-x.md>a.test.ts:1": "WRONG",
    });
    const why = (k: string): string | undefined =>
      problems.find((p: Problem): boolean => p.key === k)?.why;
    expect(why("0999-x.md>a.test.ts:1")).toContain("与快照不符");
    expect(why("0999-x.md>a.test.ts:2")).toContain("快照里没有");
    expect(why("0999-x.md>zzz.ts:9")).toContain("找不到");
    expect(why("0999-x.md>b.test.ts:3")).toContain("越界");
    // 快照多余一条（文档里的引用被删了）也要报，否则「删掉引用」是无声的。
    expect(why("0999-x.md>a.test.ts:7")).toBeUndefined();
    expect(
      verify(docs, names, read, { "ghost.md>c.ts:1": "alpha" }),
    ).toHaveLength(5);
    // 全对时必须零问题，否则本守卫是恒红。
    const okDocs: Map<string, string> = new Map([
      ["0999-x.md", "看 a.test.ts:2" + NL],
    ]);
    expect(
      verify(okDocs, names, read, { "0999-x.md>a.test.ts:2": "beta" }),
    ).toEqual([]);
  });

  it("全部完整形态引用与快照一致", () => {
    const docs: Map<string, string> = decisionDocs();
    const names: string[] = repoNames();
    const read = (rel: string): string | undefined => {
      try {
        return readFileSync(join(ROOT, rel), "utf8");
      } catch {
        return undefined;
      }
    };
    expect(
      verify(docs, names, read, SNAP)
        .map((p) => p.key + " " + p.why)
        .join(" | "),
    ).toEqual("");
    // 引用条数下界：解析被误写成恒真时，提取会变 0，这条会先红。
    expect(Object.keys(SNAP).length).toBeGreaterThanOrEqual(15);
  });
});
