/**
 * 计划引用对账：注释与文档里每句「计划 Task X.Y」必须指向计划里真存在的小节。
 *
 * ── 为什么现在补这一发 ─────────────────────────────────────────
 * 计划文档 `docs/superpowers/plans/2026-11-06-opc-os-development-plan.md` 有 58 个
 * `### Task X.Y` 小节，而仓库里的注释与决策文档**大量**按编号引用它（本轮实测 964 处，
 * 含计划自己内部的前向引用）。此前这件事【一条守卫都没有】：
 * `doc-refs` 与 `doc-coords` 只管 `docs/decisions/` 里的短哈希与行号坐标，
 * `comment-citations` 管注释里的文件/符号引用 —— **计划编号不在任何一族的射程里**。
 * 于是「计划把某个 Task 拆了/删了/重编号」这件事在仓库里是【静默的】。
 *
 * 本轮它就不是假设：现数现抓到【2 处悬空】。计划把「Phase 0 第 4 号」拆成 0.4a（探针）与
 * 0.4b（实现），而 `docs/decisions/0001-sqlite-driver.md` 两处仍写【不带后缀的旧编号】。
 * 那两处不是笔误，是**拆分发生在写入之后** —— 正是这一族主张的标准死法：
 * 写下时是真的，改动落地时没人回头改引用，因为没有任何东西要求有人回头改。
 *
 * ⚠ 而写这一发的过程中【判据自己把自己判红了】：本文件这段注释原先照着
 * 「如实抄下那个坏掉的形状」写，于是它自己成了语料里的第 3、4 处悬空。
 * 这不是段子，是一条必须记住的约束：**扫全仓文本的判据，其自身的散文也在射程里**，
 * 所以描述坏形状时必须换一个不被自己匹配的写法（同族先例：0056 §2 为了不让
 * 「恰好 7 位 hex ⇒ 断言这是提交」那条守卫误判，规定哈希一律写全长而不是截断前缀）。
 *
 * ── 为什么扫 docs 也扫 ts，而不只扫 ts ─────────────────────────
 * 只扫代码是上一版探针的口径，而那正是【漏掉全部两处真悬空】的口径 ——
 * 那两处都在 `docs/decisions/`。所以这一发把 docs 下的 markdown 与全部 ts 一起扫。
 * ⇒ **一次口径选错，判据就永远碰不到真有病的那一侧**，而它照样绿。
 *
 * ── 为什么计划自己也扫 ────────────────────────────────────────
 * 计划正文里有大量「见 Task 0.3 的 include 调整」这类前向/后向引用，它们同样应当指向
 * 存在的小节。把计划排除在外 = 允许计划内部自相矛盾。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRuntimeFixture } from "./run-fixtures.js";

/** 计划文档里的小节标题：`### Task 0.4a　…`（编号后可带一个小写字母后缀）。 */
export const TASK_HEADING_RE = /^###\s+Task\s+([0-9]+\.[0-9]+[a-z]*)/gmu;

/** 一处引用：注释/正文里写下的 `Task 0.4b`。 */
export const TASK_REF_RE = /\bTask ([0-9]+\.[0-9]+[a-z]*)/gmu;

export const PLAN_PATH =
  "docs/superpowers/plans/2026-11-06-opc-os-development-plan.md";

/**
 * 一次匹配里的那个编号。
 *
 * 正则只有一组且不是可选组，所以运行期恒有值 —— 但 `noUncheckedIndexedAccess`
 * 不知道，而这一族【刻意不用 `as string` 断回去】：断言是「我说它有就有」，
 * 万一将来有人把组改成可选而忘了这里，undefined 会【静默混进集合】，
 * 于是 `have.has(id)` 的口径里多出一个不可能的成员，而没有任何一处会红。
 * 跳过 + 让它落到「小节集合为空 ⇒ 哨兵红」那条既有判据上，坏的时候才看得见。
 * （复算：`npx tsc -p .workbuddy/tsconfig.tests.json`，这一族今天 0 条错。）
 */
function groupId(m: RegExpExecArray | RegExpMatchArray): string | undefined {
  return m[1];
}

/** 计划里真实存在的小节编号集合。 */
export function planTaskIds(planMarkdown: string): Set<string> {
  const out = new Set<string>();
  for (const m of planMarkdown.matchAll(TASK_HEADING_RE)) {
    const id = groupId(m);
    if (id !== undefined) out.add(id);
  }
  return out;
}

/** 语料里出现过的 Task 编号 → 出现次数。 */
export function referencedTaskIds(
  files: ReadonlyMap<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const text of files.values()) {
    for (const m of text.matchAll(TASK_REF_RE)) {
      const id = groupId(m);
      if (id === undefined) continue;
      out.set(id, (out.get(id) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * 判据（纯函数）：返回悬空引用的人话清单，空表 = 全部指向存在的小节。
 *
 * ⚠ 反假绿两条，都由调用方的读数保证，这里只保证【不自欺】：
 *  - `have` 为空 ⇒ 一律判红。计划路径写错 / 标题格式变了 ⇒ 集合为空，
 *    那时「0 个悬空」是「什么都没解析到」换来的，不是"都对"。
 *  - 返回的是【引用侧】的差集，不看标题侧有多少 —— 标题变多不会让它红，
 *    这是有意的：本守卫判的是「引用指向不存在的东西」，不是「标题有没有被引用」。
 */
export function danglingTaskRefs(
  files: ReadonlyMap<string, string>,
  have: ReadonlySet<string>,
): Array<{ id: string; count: number }> {
  if (have.size === 0) {
    return [{ id: "<计划里一个 Task 小节都没解析到>", count: 0 }];
  }
  const out: Array<{ id: string; count: number }> = [];
  for (const [id, count] of referencedTaskIds(files)) {
    if (!have.has(id)) out.push({ id, count });
  }
  return out.sort((a, b) => b.count - a.count);
}

/**
 * 递归收集某目录下的指定扩展名文件（posix 相对路径）。不用 child_process：纯读盘不需要 shell。
 *
 * ⚠ `isRuntimeFixture` 那一格【round277 补的，补之前这里在随机红】。
 * dependency-boundary.test.ts 会往【真的】packages/desktop/src 与 packages/hub/src 里写一个
 * 运行期探针文件（写进系统临时目录就不落在 biome 那条边界规则的路径范围内，等于没测），
 * 跑完删掉。于是并发跑的时候这里有一条【目录项存在 → 文件消失】的窗口：
 *   复算：`npx vitest run test/arch/` 跑 5 次，3 次报读那个探针文件的 ENOENT，
 *   红的是【取材失败的那一发本身】（Failed Suites，289 而非 299），不是任何一条判据。
 * 这个洞是我 round275 立这条守卫时带进来的：no-native-deps / production-deps / lint-baseline
 * 三处【早就】按文件名排除它，而 plan-refs 是第四个消费者 —— 与 run-fixtures.ts 文件头记的
 * 那句一模一样：「探针名此前在两个文件里各写一遍，靠一句注释提醒同步 —— 注释不是机制，
 * 它没能拦住第三个消费者（也就是我自己）」。现在第四个也走同一份名单。
 * ⚠ 这段注释【原本写出了那个文件名】，于是被 production-deps 的「探针名只允许定义在
 * run-fixtures.ts」那条判据当场判红 —— 那是本仓库第 5 次踩中同一族坑（描述坏形状的散文
 * 自己落进自己的射程）。前 4 次见 0055/0056/0057 与本文件上面第二段。
 * 排除而不是 try/catch 忽略读错误：忽略读错误会把【真的取材失败】（磁盘坏、路径改）
 * 一起咽掉，而这条守卫的整条判据就建立在「取材失败必须炸」上（见 readCorpus 那句抛错）。
 */
export function collect(
  root: string,
  dir: string,
  ext: string,
  out: string[] = [],
): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    // node_modules 里也有 .ts（依赖自带的类型），扫它是纯粹的噪声。
    if (e.name === "node_modules" || e.name === ".git") continue;
    // 别的测试此刻正在跑的夹具：它不是仓库的一部分，且随时会消失。
    if (!e.isDirectory() && isRuntimeFixture(e.name)) continue;
    const rel = dir === "" ? e.name : dir + "/" + e.name;
    if (e.isDirectory()) collect(root, rel, ext, out);
    else if (e.name.endsWith(ext)) out.push(rel);
  }
  return out;
}

export interface Corpus {
  readonly files: Map<string, string>;
  readonly planIds: Set<string>;
}

/** 真仓库取材：计划文档 + docs 下全部 markdown + 全部 ts（计划自己也在 docs 下，一并计入）。 */
export function readCorpus(root: string): Corpus {
  const paths = [...collect(root, "docs", ".md"), ...collect(root, "", ".ts")];
  const files = new Map<string, string>();
  for (const rel of new Set(paths)) {
    files.set(rel, readFileSync(join(root, rel), "utf8"));
  }
  const plan = files.get(PLAN_PATH);
  if (plan === undefined) {
    throw new Error(
      "取材里没有计划文档 " +
        PLAN_PATH +
        " —— 路径或扩展名变了。" +
        "本守卫宁可直接抛，也不拿『0 个悬空』冒充通过。",
    );
  }
  return { files, planIds: planTaskIds(plan) };
}
