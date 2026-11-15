import type { Dirent } from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { isExemptPosix, readdirSurvives } from "./no-native-deps.js";
import { BOUNDARY_PROBE } from "./run-fixtures.js";

/**
 * D6-a 的机械防线：生产源码不得依赖任何原生 SQLite 模块。
 *
 * 为什么不能只靠规格里写一句「我们用 node:sqlite」：官方 SqliteSaver 依赖
 * better-sqlite3，它的 build/Release/better_sqlite3.node 实测就在仓库里（1.9MB）。
 * 有人在生产路径 import 一次，打包产物就会带上平台相关的 .node —— 这正是 D6 要消灭
 * 的失效模式，而且平时测试全绿，只在打包后的用户机器上暴露。
 *
 * 与 Task 0.2 的 dependency-boundary 是不同维度，不是重复：那条按 package 划界
 * （hub 内允许 SQLite），本条在 hub 内部再切一刀：hub 生产代码只许 node:sqlite。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PACKAGES = join(ROOT, "packages");

// 原生 / 第三方 SQLite 实现。node:sqlite 不在其中 —— 那正是我们要用的。
const FORBIDDEN = [
  "better-sqlite3",
  "@langchain/langgraph-checkpoint-sqlite",
  "sql.js",
];

const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);

/**
 * 刻意豁免：PoC 与 Phase 0 证据。
 *
 * packages/hub/src/poc、test/poc、docs/superpowers/evidence/phase0-poc 用官方
 * SqliteSaver 验证过 LangGraph 的 Checkpoint 语义（门禁 #2 的可复现证据），它们不是
 * 产品代码：.mjs 不在 hub tsconfig 的 include 内，不进 dist，也不进 Electron 产物。
 * 豁免必须显式列在这里，而不是靠「恰好没扫到」。
 */
const EXEMPT_DIRS = ["poc"];

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * walk 真正用到的只有这两个字段，所以依赖按这两个字段声明。
 * 不用 `as Dirent` 造假条目：Dirent 还有一堆别的成员，部分字面量强转是类型错误
 * (TS2352)，而 test 目录整棵不在 tsc 射程里（0007 §5），那种错误会静默留在树上。
 */
type DirEntryLike = Pick<Dirent, "name" | "isDirectory">;
type Readdir = (dir: string) => DirEntryLike[];

const realReaddir: Readdir = (dir) => readdirSync(dir, { withFileTypes: true });

/**
 * 读一个目录，「刚刚消失」返回 null，其余错误照抛。
 *
 * 目录可能在遍历途中被并行的另一条守卫删掉 —— 下面 TEST_FIXTURE 那段记的就是这一类
 * 碰撞，本文件早就为「文件被删」设了 readFileSync 的 try，唯独遍历自身漏了同一条。
 * 顶层也走这里：整个包目录消失的瞬间，walk(PACKAGES) 不该把整轮带走。
 *
 * 判据不在这里，在 readdirSurvives：撞得上是偶然，靠真撞证明不了什么，所以要能被
 * 合成输入单独钉住三种态（见文件末尾）。
 */
function readdirOrNull(dir: string, readdir: Readdir): DirEntryLike[] | null {
  let entries: DirEntryLike[] = [];
  if (
    !readdirSurvives(() => {
      entries = readdir(dir);
      return entries;
    })
  )
    return null;
  return entries;
}

/**
 * readdir 可注入。不是为了好看：「父目录的清单里还有那个子目录，等递归下去时它已经
 * 没了」是竞态的核心时序，而它【无法从外部安排】—— 删除必须正好落在 walk 内部两次
 * readdir 之间。实测把递归处改坏，用真磁盘造的确定性场景一条都抓不到（探针变异 8
 * 存活）。所以把 readdir 抽成参数，用假清单把那一毫秒直接摆出来。
 * 与 isExemptPosix / survivesStat 同一族做法：判据要能被变异证明有判别力。
 */
function walk(
  dir: string,
  readdir: Readdir = realReaddir,
  out: string[] = [],
): string[] {
  const entries = readdirOrNull(dir, readdir);
  if (entries === null) return out;
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "out"
      )
        continue;
      walk(full, readdir, out);
    } else if (/\.(ts|tsx|mts|mjs|js)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * dependency-boundary.test.ts 的运行期夹具名。
 *
 * 那个测试【故意】往 packages/{desktop,web,hub}/src/ 写含 better-sqlite3 的越界探针，
 * 用来验证 biome 拦得住；探针随它创建、随它删除，不被 git 跟踪。vitest 跨文件并行，
 * 本守卫与它并发就会撞上（实测 pnpm verify 里间歇性假失败，连跑三次中红一次）。
 *
 * 排除它的理由不是「让测试变绿」：本守卫守的是【可能进产物的源码】，而夹具不在构建
 * 输入里、也不进 Electron 包。名字由两边各自写死并互相注释指向，改名时两边都撞得见。
 */
const TEST_FIXTURE = BOUNDARY_PROBE;

function isExempt(file: string): boolean {
  const rel = file
    .slice(ROOT.length + 1)
    .split(/[\\/]/u)
    .join(posix.sep);
  return isExemptPosix(rel, EXEMPT_DIRS, TEST_FIXTURE);
}

/*
 * 豁免判定本身的单元测试。之所以要在【这里】测而不是只靠真扫描：
 * 真扫描的输入里 EXEMPT_DIRS 只有一个目录，而历史上的写法
 *   rel.split(posix.sep).includes(...EXEMPT_DIRS)
 * 在只有一个元素时【恰好正确】—— includes 只吃一个参数，展开一个元素就等于没展开。
 * 于是真数据永远照不出它：没有任何一次扫描会因为第二个豁免目录而变红。
 * 下面这条用合成输入专门钉住【第二个及以后的元素也必须生效】。
 */
it("豁免名单的第二个目录也必须生效（历史上这一条无人可测）", () => {
  const TWO = ["poc", "e2e"];
  // 第一个元素：新旧写法都得对
  expect(
    isExemptPosix("packages/hub/src/poc/graph.mjs", TWO, TEST_FIXTURE),
  ).toBe(true);
  // 第二个元素：只有【逐元素判断】的写法才对。历史上写成 includes(...名单)，
  // 等价于 includes("poc")，e2e 会被判成【不豁免】，而当时没有任何测试会发现。
  expect(
    isExemptPosix("packages/hub/src/e2e/thing.mjs", TWO, TEST_FIXTURE),
  ).toBe(true);
  // 名单外的目录不许被豁免 —— 否则上面两条会因为【恒真】而失去意义。
  expect(isExemptPosix("packages/hub/src/db/real.ts", TWO, TEST_FIXTURE)).toBe(
    false,
  );
  // 空名单必须谁都不豁免（恒真的判据在这里就会露出）
  expect(
    isExemptPosix("packages/hub/src/poc/graph.mjs", [], TEST_FIXTURE),
  ).toBe(false);
  // 并发夹具走的是尾巴匹配，与目录名单是两条独立的通道
  expect(
    isExemptPosix("packages/hub/src/" + TEST_FIXTURE, [], TEST_FIXTURE),
  ).toBe(true);
});

it("生产源码不依赖任何原生 SQLite 模块（D6-a）", () => {
  const files = walk(PACKAGES).filter((f) => !isExempt(f));
  // 元守卫：遍历失效会返回空清单，空清单绝不能当作「检查通过」
  expect(files.length, "扫描到 0 个文件 = 遍历失效").toBeGreaterThan(10);

  const hits: Hit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "latin1");
    } catch {
      continue;
    }
    text.split("\n").forEach((line, i) => {
      for (const mod of FORBIDDEN) {
        const quoted =
          line.includes(DQ + mod + DQ) || line.includes(SQ + mod + SQ);
        if (quoted) {
          hits.push({
            file: file.slice(ROOT.length + 1),
            line: i + 1,
            text: line.trim().slice(0, 90),
          });
        }
      }
    });
  }

  expect(
    hits,
    "原生 SQLite 依赖会毁掉 D6（零原生模块）。若确属 PoC 用途，请把所在目录加入 EXEMPT_DIRS 并写明理由：\n" +
      hits.map((h) => h.file + ":" + h.line + " " + h.text).join("\n"),
  ).toEqual([]);
});

/*
 * 遍历容错本身的单元测试。放在这里的理由与文件中间那段豁免名单的单测一样：真扫描
 * 撞不响。竞态窗口是「别的进程恰好在这一毫秒删掉这个目录」，实测 8 次高压并行 +
 * 5 次整轮跑，一次都没复现 —— 撞不响的一次通过不算通过。所以判据抽成注入式纯函数，
 * 三种态用合成输入逐个钉。
 */
it("遍历遇到刚消失的目录跳过；权限类错误必须照抛", () => {
  // 在：正常读完，原样放行
  let calls = 0;
  expect(
    readdirSurvives(() => {
      calls++;
      return [];
    }),
  ).toBe(true);
  expect(calls, "判据不许绕过被注入的读取去返回 true").toBe(1);

  // 消失了：当这一层没有内容，不抛
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const gone = Object.assign(new Error("vanished"), { code });
    expect(
      readdirSurvives(() => {
        throw gone;
      }),
      code + " 必须被宽容（并行删除撞上它是正常路径）",
    ).toBe(false);
  }

  // 权限类：照抛。这一条是上面那两条的负向对照 —— 把 readdirSurvives 掏空成恒返回
  // true，前两条全绿，只有这里会红；反过来写成恒返回 false，第一条就红。
  for (const code of ["EACCES", "EPERM", "EBUSY"]) {
    const denied = Object.assign(new Error("denied"), { code });
    expect(
      () =>
        readdirSurvives(() => {
          throw denied;
        }),
      code + " 若也被吞掉 = 零容忍扫描器静默少扫一整层目录",
    ).toThrow();
  }
  // 没有 code 的错误同样不许被吞：判据必须是「只认这两个 code」，不是「有 try 就 swallow」
  expect(() =>
    readdirSurvives(() => {
      throw new Error("no code");
    }),
  ).toThrow();
});

/*
 * 0053 §7 登记的那一格：非确定性的删除撞不上，就把【已经删完】的确定状态摆出来。
 *
 * 下面两发各钉一条路径。第一版只写了一发【真磁盘】的场景（父目录在、子目录已删），
 * 实测把 walk 退回裸 readdirSync，那一发【照样绿】—— 因为 walk 每次都重新 readdir，
 * 删掉的子目录根本不在清单里，压根走不到抛。那条已删：它测不到任何东西。
 *
 * 真正的失效点是【递归下去时那一层已经没了】：readdir 交出的清单是那一刻的快照，
 * 快照之后子目录才被并行进程删掉，快照里它仍然是目录。而「删除正好落在 walk 内部
 * 两次 readdir 之间」是时序，从外部安排不了 —— 所以把 readdir 换成假清单，把那一毫秒
 * 摆成静态状态。与实测抓到的那次同形：scandir 报的是 .tmp 里那个目录【自己】。
 */
it("递归下去时那一层已消失：跳过它，兄弟目录照扫（老代码在这一条上必红）", () => {
  const parent = join(ROOT, "packages");
  const gone = join(parent, "gone-mid-scan");
  const fake = (dir: string): DirEntryLike[] => {
    if (dir === parent) {
      return [
        { name: "gone-mid-scan", isDirectory: () => true },
        { name: "sibling.ts", isDirectory: () => false },
      ];
    }
    if (dir === gone) {
      // 快照之后被并行进程删掉 —— walk 递归进来就是对不存在的目录 scandir。
      throw Object.assign(new Error("scandir"), { code: "ENOENT" });
    }
    return [];
  };
  let out: string[] = [];
  expect(() => {
    out = walk(parent, fake);
  }).not.toThrow();
  expect(out).toEqual([join(parent, "sibling.ts")]);

  // 权限类错误不许在同一处被顺带吞掉：吞了就是「零容忍扫描器静默少扫一整层」。
  expect(() =>
    walk(parent, (dir) => {
      if (dir === parent) {
        return [{ name: "x", isDirectory: () => true }];
      }
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    }),
  ).toThrow();
});

/*
 * 真磁盘上的兜底：接到真 readdirSync 时，顶层目录不存在也不许抛。
 * 这一发【只】测得到顶层 —— 递归处需要过期快照，真磁盘造不出来，见上面那条的说明。
 * 两条都要：上一发用假清单证明了判据接对了线，这一发证明接的是【真的】readdirSync
 * 而不是一个恒返回空的替身（变异把 readdir 换成常量时，只有这一发会红）。
 */
it("真磁盘：顶层目录不存在时 walk 返回空清单，不抛", () => {
  const missing = join(PACKAGES, "no-such-package-9182736455");
  let out: string[] | undefined;
  expect(() => {
    out = walk(missing);
  }).not.toThrow();
  expect(out).toEqual([]);
  // 反向对照：同一个 walk 在真目录上必须扫得到东西，否则上面那条
  // toEqual([]) 只是因为 walk 恒返回空数组，等于什么都没钉住。
  expect(walk(join(ROOT, "test", "arch")).length).toBeGreaterThan(5);
  // readdirOrNull 直接对上真 readdirSync：兄弟还在就读得到，消失了就给 null。
  expect(readdirOrNull(join(ROOT, "test", "arch"), realReaddir)).not.toBeNull();
  expect(readdirOrNull(missing, realReaddir)).toBeNull();
});
