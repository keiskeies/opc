/**
 * 角色执行器的安全边界守卫（O6 那条「唯一生效的边界」第一次有了机器判据）。
 *
 * ── 这条守卫存在的理由，是一句没人核对的话 ─────────────────────────
 * `engine/claude.ts` 文件头写着：今天真的员工身上【唯一生效的安全边界】是本文件那两个
 * 参数，而 `harness/` 那 3300 行一行都不执行。这句话 round277 之前由两处守着：
 *   · `dead-modules` 的横幅可见性判据 —— 它只判「这句话在不在」，不判这句话对不对；
 *   · `claude.test.ts` 里的 argv 回显断言 —— 它只判「参数传到了」，不判「挡住了什么」。
 * 两个都不抓这件事：**把 plan 摘掉，仓库里没有任何一处会红**（变异 B1 实测）。
 *
 * ── 四格判据，各对一个不同的坏法 ────────────────────────────────
 *  ① 【起子进程的地方】就那几个。hub/src 里 `spawn(` 的调用点必须逐字落在名单里，
 *     多一个 ⇒ 红。这一格和另外三格不同向：它防的是「新开一个不受这个判据管的口子」，
 *     而新口子出现时那三格可以全都还是绿的。
 *  ② 【边界本身】：代码区里 `"--permission-mode"` 那一项的【下一项】必须是 `"plan"`。
 *     相邻而不是「文件里两处都有」：后者在 `--permission-mode` 被挪到别处、
 *     或值换成 `bypassPermissions` 时照样绿。
 *  ③ 【诚实标注】：第一行代码【之前】还要有那句「唯一生效的安全边界」。删了它 ⇒ 红 ——
 *     边界没变而读它的人被误导了，正是 O6 动作 1 当初立这条的原因。
 *  ④ 【行为探针】：`claude.test.ts` 里那个「拿不到 plan 就真写盘」的探针还在
 *     （写标记 + 正向对照两个键）。探针被摘掉 ⇒ 红，否则这句话又退回成一句回显。
 *
 * ── 承认的余量（都朝【绿】的方向坏，所以逐条写出来）─────────────────
 *  · ① 认 `spawn(` 这个词。`import { spawn as run }` 再 `run(...)` 看不见 ——
 *    与 stub-terminal-write 那条「席位权威认 import 不认同名变量」是同一个余量族，
 *    代价方向是【漏报】。所以 ① 之外另配了一条取材非空的下限（测试里那条）。
 *  · ② 只认 `RoleRunInput` 这一条路线。真换 SDK（claude.ts 文件头写明只替 execute()）
 *    时这条判据整体失效 —— 那时该改的是这条守卫，不是给它加个豁免。
 *  · ④ 判的是「探针代码在」，不重跑探针。真的那一发在 claude.test.ts 里跑。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeFixture } from "./run-fixtures.js";
import { lexTs } from "./ts-lex.js";

/** 仓库根：本文件在 <root>/test/arch/ 下。 */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 生产代码里【允许】起子进程的位置（posix 相对 packages/hub/src）。 */
export const SPAWN_SITES_BASELINE = [
  // 真的员工：一次 claude -p。安全边界就落在这里。
  "engine/claude.ts",
  // 开发入口：pnpm dev 起的 hub / web 两个子服务，不跑员工、不碰工作区。
  "serve/dev-entry.ts",
] as const;

/** 起子进程的调用点：代码区里 `spawn(` 这个词。注释里的不算，`spawnSync` 也不算。 */
export function spawnCallSites(src: string): number {
  let n = 0;
  lexTs(src, {
    onWord: (word, end) => {
      if (word !== "spawn") return;
      let k = end;
      while (k < src.length && /\s/u.test(src[k] as string)) k++;
      if (src[k] === "(") n++;
    },
  });
  return n;
}

/**
 * 代码区里的全部双引号串，按出现顺序。注释与模板串都不进来（见 ./ts-lex.ts）。
 * 顺序是这条判据的全部强度所在：② 判的是【相邻】。
 */
export function codeStrings(src: string): string[] {
  const out: string[] = [];
  lexTs(src, {
    onString: (kind, body) => {
      if (kind === '"') out.push(body);
    },
  });
  return out;
}

/** ②：`"--permission-mode"` 之后紧跟的那一项是不是 `"plan"`。 */
export function planModeAdjacent(src: string): boolean {
  const s = codeStrings(src);
  const k = s.indexOf("--permission-mode");
  return k >= 0 && s[k + 1] === "plan";
}

/** ③：诚实标注那句话的字节。改措辞 ⇒ 红，方向是对的（那句话是这条守卫的凭据）。 */
export const HONESTY_MARK = "唯一生效的安全边界";

/**
 * ③的范围：标注必须出现在【第一行代码之前】。
 *
 * 一开始这里写的是「文件头 15 行内」，那是我在自己机器上手数出来的一个数 ——
 * 而那句话今天在第 21 行，判据落地即红。这类数本仓已经记过一整族（「上限会随
 * 修复下调，期望值一定会过期」），所以换成一个【结构性】的口径：
 * 标注必须在第一个 `export` 之前，也就是「读代码之前先读到它」。
 * 它比行数抗腐烂（谁在文件头加两行说明都不会让它红），而语义反而更准：
 * 真正要防的是「那句话掉到代码堆里，于是等于没写」。
 */
export function firstExportAt(src: string): number {
  let at = -1;
  lexTs(src, {
    onWord: (word, end) => {
      // lexTs 只对【代码区】的完整标识符回调，所以注释里出现的 export 一词不会进来。
      if (at >= 0 || word !== "export") return;
      at = wordStart(src, end);
    },
  });
  return at;
}

/** 词的起始下标（lexTs 的 onWord 只给词尾）。 */
function wordStart(src: string, wordEnd: number): number {
  let k = wordEnd;
  while (k > 0 && /[\w$]/u.test(src[k - 1] as string)) k--;
  return k;
}

/** ④：行为探针的两个键。缺任何一个 ⇒ 那一半判据没了。 */
export const PROBE_KEYS = [
  "FAKE_CLAUDE_WRITE_TO",
  "FAKE_CLAUDE_NO_PLAN",
] as const;

/** 四格读数。真仓库与合成语料共用一份形状，所以变异能喂内存而不碰磁盘。 */
export interface BoundaryFacts {
  /** 生产 src 相对路径 → 该文件的 spawn( 调用点数。 */
  readonly spawns: ReadonlyMap<string, number>;
  /** 执行器源码。 */
  readonly adapter: string;
  /** 执行器的行为测试源码。 */
  readonly adapterTest: string;
}

/** 全跑一遍，返回人话（空 = 四格全过）。 */
export function checkBoundary(f: BoundaryFacts): string[] {
  const problems: string[] = [];
  const allowed = new Set<string>(SPAWN_SITES_BASELINE);
  for (const [rel, n] of f.spawns) {
    if (n === 0) continue;
    if (!allowed.has(rel)) {
      problems.push(
        "多出一个起子进程的位置 " +
          rel +
          "（spawn( 计数 " +
          n +
          "）—— 它不经过任何一条安全边界判据，先登记再说",
      );
    }
  }
  for (const rel of SPAWN_SITES_BASELINE) {
    if ((f.spawns.get(rel) ?? 0) === 0 && rel === "engine/claude.ts") {
      problems.push(
        "engine/claude.ts 不再 spawn( —— 员工换了执行方式，" +
          "这条守卫的四格判据整体作废，该重读 O6 而不是加豁免",
      );
    }
  }
  if (!planModeAdjacent(f.adapter)) {
    problems.push(
      'engine/claude.ts 的 argv 里 "--permission-mode" 的下一项不是 "plan" —— ' +
        "今天唯一生效的那条安全边界没了或换值了",
    );
  }
  const cut = firstExportAt(f.adapter);
  const head = cut < 0 ? f.adapter : f.adapter.slice(0, cut);
  if (!head.includes(HONESTY_MARK)) {
    problems.push(
      "engine/claude.ts 的第一行代码之前没有「" +
        HONESTY_MARK +
        "」那句 —— 边界可能还在，但读这个文件的人不再知道它是唯一的一条",
    );
  }
  for (const k of PROBE_KEYS) {
    if (!f.adapterTest.includes(k)) {
      problems.push(
        "claude.test.ts 里没有 " +
          k +
          " —— 那条「拿不到 plan 就真写盘」的行为探针被摘掉了，" +
          "于是这句话又退回成一句 argv 回显",
      );
    }
  }
  return problems;
}

/* ═════════════════════════ 取材（IO）═════════════════════════ */

/** 一个 src 文件的文本（相对 packages/hub/src，posix 分隔）。 */
export function readSrc(rel: string, root: string): string {
  return readFileSync(join(root, "packages", "hub", "src", rel), "utf8");
}

/** packages/hub/src 下全部非 poc、非测试的 .ts（posix 相对路径）。 */
export function listSrc(root: string): string[] {
  const out: string[] = [];
  const base = join(root, "packages", "hub", "src");
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "poc") continue;
      // 运行期夹具：它不是仓库的一部分，且【随时会消失】——不排掉就是随机红。
      // 本文件是第六个补这一格的 src 扫描器，前五个见 run-fixtures.ts 与本判据的台账。
      if (!e.isDirectory() && isRuntimeFixture(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + "/");
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts"))
        out.push(rel + e.name);
    }
  };
  walk(base, "");
  return out.sort();
}

/** 真仓库的那一份读数。 */
export function readFacts(root: string): BoundaryFacts {
  const spawns = new Map<string, number>();
  for (const rel of listSrc(root)) {
    const n = spawnCallSites(readSrc(rel, root));
    if (n > 0) spawns.set(rel, n);
  }
  return {
    spawns,
    adapter: readSrc("engine/claude.ts", root),
    adapterTest: readFileSync(
      join(root, "packages", "hub", "test", "engine", "claude.test.ts"),
      "utf8",
    ),
  };
}
