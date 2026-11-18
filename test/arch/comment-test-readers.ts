/**
 * 生产源码注释里点名的测试文件，必须真的存在。
 *
 * ── 为什么是这一格（round282 的 bug 形状，本轮又抓到一条现成的） ──────────
 * 一个源文件常常在注释里写「字段变了红的是 `x.test.ts`」—— 那句话是在给一张形状表
 * 【指派读者】。round282 量到的真缺陷是：`feishu.ts` 的文件头与 `FEISHU_SHAPE_EVIDENCE`
 * 都写着「红的是 `feishu.test.ts`」，而那个文件【当时不存在】⇒ 那张表没有读者，
 * 漂移一路绿到真发请求那一刻。
 *
 * round290 用同一把尺子扫全仓（`.workbuddy/round290-probe-test-named-in-comment.mjs`），
 * 当场抓到第二条：`packages/hub/src/replay/search.ts` 的注释写着
 * 「`test/arch/package-deps.test.ts` 明令 web 禁止依赖 SQLite」，
 * 而那个文件在 git 全部历史里【零命中】—— 它从未存在过。
 * 那条比 feishu 那条更值得防：它指的不是"某个测试会不会红"，而是
 * 「有一道边界守卫在拦着」—— 为一条【不存在的守卫】作证，读的人会以为机器拦着，其实没有。
 * （web 禁止依赖 SQLite 这件事本身【有】守卫，是 `dependency-boundary.test.ts`，
 *   注释的结论没错，错的是它举的证人。）
 *
 * ── 已有守卫为什么盖不到 ───────────────────────────────────────────
 * · `comment-citations` 判的是注释里的 `000X §N.M` 这类【决策文档小节号】是否存在，不看测试文件名。
 * · `doc-refs` / `doc-coords` 的语料是 docs/，不碰 .ts 注释。
 * · `plan-gate-paths` 判的是【计划文档的验收行】点名的路径是否存在 —— 方向正好相反：
 *   它管「拿来当验收用的路径」，这里管「生产注释指派的读者」。
 * ⇒ 「源注释点名一个测试文件」这一格今天没有任何机器判据。
 *
 * ── 范围的三条收窄（每条都是为了不造出一个会被关掉的守卫） ─────────────
 * 一、只看 `packages/**\/src/**` 的 .ts/.tsx。test/ 与 test/arch/ 的注释里成片的
 *   `ghost.test.ts` / `here.test.ts` / `x.test.ts` 是【故意不存在的探针名】——
 *   round290 实测那 7 处「查无此物」里有 6 处在 test/arch 讲夹具。把它们收进来
 *   = 一条恒红守卫，而恒红的东西会被当环境噪音关掉，比不写更坏（0055/0056/0057）。
 *   生产注释不一样：它说的「红的是 x.test.ts」是一句【可核对的承诺】，不是构造出来的例子。
 * 二、按【基名】判存在，不按整条路径。注释里写 `test/arch/y.test.ts` 也能命中，
 *   方向是漏判而不是假阳（住址漂了不算缺陷，本守卫只答「有没有这个读者」）。
 * 三、注释行以【撤回】开头 ⇒ 不报，但计入 retracted 并由 .test.ts 断言条数。
 *   沿用 doc-coords 那条口径：静默删掉错误事实正是本守卫要防的事，
 *   所以被撤回的引用不许当缺陷报；而豁免必须【可数】，数字一变就得重读那些撤回段。
 *
 * 未闭合口径一条（round290 实测，写在 .test.ts 里钉住数字）：同名歧义【不判】。
 * 源注释只写基名而仓库里有两份同名测试时（实测 4 组基名、12 处引用），
 * 「红的是 charter.test.ts」指的是哪一份无从判定。判它会造出 12 条无法自证的红色，
 * 而真正的坑（两份同名导致验收命令跑到别的文件上）已由 plan-gate-paths 文件头记下。
 */

import { commentLines } from "./comment-citations.js";
import { isRetracted } from "./doc-coords.js";

/** 注释里的一个测试文件名：只认 `*.test.ts` / `*.test.tsx`，前面允许带任意路径。 */
export const TEST_NAME_RE = /\b([A-Za-z0-9][A-Za-z0-9._-]*\.test\.tsx?)\b/g;

export interface TestReaderRef {
  readonly file: string;
  readonly line: number;
  /** 注释里写的那个基名（路径前缀已被丢掉）。 */
  readonly name: string;
  /**
   * 那条引用【所在的那一行注释】，已剥掉 `*` 与前导空白。
   *
   * 为什么要把它带在引用上而不是回原文件按行号再取一次：原文那一行长这样
   * ` * 【撤回】……`，而 isRetracted 判的是 trimStart 之后以标记开头 ——
   * 拿原文判永远判不到（那行以 `*` 开头）。commentLines 恰好已经把 `*` 与空白剥了，
   * 所以判据只能吃它产出的文本。带在引用上，纯函数才拿得到判据要的那件事。
   */
  readonly commentLine: string;
}

/** 一个源文件的文本 → 注释里点名的测试文件引用（带原行号与所在注释行）。 */
export function testReaderRefs(file: string, text: string): TestReaderRef[] {
  const out: TestReaderRef[] = [];
  for (const c of commentLines(text)) {
    for (const m of c.text.matchAll(TEST_NAME_RE)) {
      const name: string = m[1] ?? "";
      if (name !== "") {
        out.push({ file, line: c.line, name, commentLine: c.text });
      }
    }
  }
  return out;
}

export interface MissingReader {
  readonly file: string;
  readonly line: number;
  readonly name: string;
}

/**
 * 判据（纯函数，便于用合成夹具证明它有牙齿）。
 *
 * ⚠ 反假绿两条，形状同 plan-gate-paths 与 test-inventory 里那两条哨兵：
 *  · refs 为空 ⇒ 红。注释取材坏了（TS API 变了、范围写错、目录搬家）会得到「0 条缺陷」，
 *    而那个 0 是【什么都没读到】换来的。
 *  · corpusSize 为 0 ⇒ 红。语料为空时上面那条也会红，分开报是为了分清
 *    「扫不到文件」与「扫到了文件但注释里取不出引用」—— 两种根因的修法相反。
 */
export function missingReaders(
  refs: ReadonlyArray<TestReaderRef>,
  exists: (basename: string) => boolean,
  retracted: string[],
  corpusSize: number,
): MissingReader[] {
  if (corpusSize === 0) {
    return [{ file: "<语料>", line: 0, name: "<一个源文件都没扫到>" }];
  }
  if (refs.length === 0) {
    return [
      { file: "<语料>", line: 0, name: "<注释里一个测试文件名都没取到>" },
    ];
  }
  const out: MissingReader[] = [];
  for (const r of refs) {
    const shown: string = r.file + ":" + r.line + " → " + r.name;
    if (exists(r.name)) continue;
    // 判据是【那一行注释以该标记开头】而不是【含该标记】：doc-coords 实测过，
    // 按「含」判会让一段解释豁免的文字自己扩大豁免范围 —— 不需要谁主动滥用，
    // 写一段讲豁免的注释就会悄悄把豁免范围撑大。
    if (isRetracted(r.commentLine)) {
      retracted.push(shown);
      continue;
    }
    out.push({ file: r.file, line: r.line, name: r.name });
  }
  return out;
}
