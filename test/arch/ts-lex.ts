/**
 * 全仓守卫共用的【一次词法扫描】：把源码分成「代码 / 注释 / 字符串」三类位置再交出去。
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────
 * 本仓有两处判据都需要「这条引用/这个字面量是在代码里还是在注释里」：
 *  ① `dead-modules.ts` 的 import 说明符（注释里举的反例不是边，实测错过一次假阳性）；
 *  ② 本模块的下游 `stub-terminal-write.ts` 的状态字面量（注释里写的
 *     「不再直写 ARCHIVED」如果算一条写点，守卫会从绿变红，方向相反但同样是假）。
 * 各写一份扫描器的后果本仓记过很多次（0006 §7 第 55、56 条那一族）：两份会漂移，
 * 而漂移的表现是【其中一份悄悄不判了】。所以这里只有一份，两边都从这里取。
 *
 * ── 它不是什么 ───────────────────────────────────────────────────
 * 不是 TypeScript 的 AST。上一版 dead-modules 试过「先把字符串挖成空格再跑正则」，
 * 那一步把【真】说明符一起挖掉了，边数从几百掉到 0 —— 判据坏起来不报「扫描失败」，
 * 只报「多出 77 个死模块」。这里的形状是【一次扫描同时定上下文】，
 * 不给「先抹平再匹配」那种两步写法留位置。
 *
 * 刻意不为的地方（都朝【会红】的方向坏，不是静默）：
 *  · 模板串的 `${}` 嵌套、正则字面量里的引号 —— 本仓 src 里没有那种形状；
 *    真出现了最坏是把一处读错，读错的后果由调用方的「非空 + 阳性对照」两条兜住。
 *  · 单引号串与模板串【不算双引号字面量】，但必须整个吃下去 —— 不吃的话它们内容里
 *    的一个 `"` 会被当成起点，凭空造出一条引用。这才是读它们的意义。
 */

/** 扫描器交给调用方的三类事件。三个都可选：只关心注释的人不必接字符串。 */
export interface LexSinks {
  /** 一段注释的【正文】（已去掉行注释与块注释的定界符）。 */
  onComment?(text: string): void;
  /**
   * 代码区里的一个完整标识符词（`fooimport` 里那个 `import` 不在词首，不会进来）。
   * `end` 是词尾下标，调用方要从那里接着匹配自己的后续形状。
   */
  onWord?(word: string, end: number): void;
  /**
   * 代码区里的一个字符串字面量。`kind` 是定界符；`body` 是内容（未去转义）；
   * `open` 是定界符自身的下标 —— 调用方要往回看「这个串在什么位置」时用它。
   * 注释里的引号【不会】到这里 —— 注释正文整段走 onComment。
   */
  onString?(kind: StrQuote, body: string, open: number): void;
}

export type StrQuote = '"' | "'" | "`";

/** 词法扫描。三个 sink 都在【同一次】从左到右的扫描里按出现顺序回调。 */
export function lexTs(src: string, sinks: LexSinks): void {
  let i = 0;
  /** 吃下一个字符串字面量（停在闭合定界符之后）。 */
  const skipStr = (quote: StrQuote, stopAtNewline: boolean): void => {
    const open = i;
    const start = i + 1;
    i++;
    while (i < src.length) {
      const c = src[i] as string;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) {
        const body = src.slice(start, i);
        i++;
        sinks.onString?.(quote, body, open);
        return;
      }
      if (stopAtNewline && c === "\n") {
        // 未闭合的单引号串：内容到换行为止。不当定界符吞掉后面整行。
        sinks.onString?.(quote, src.slice(start, i), open);
        return;
      }
      i++;
    }
    sinks.onString?.(quote, src.slice(start, src.length), open);
  };
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      i += 2;
      const start = i;
      while (i < src.length && src[i] !== "\n") i++;
      sinks.onComment?.(src.slice(start, i));
      continue;
    }
    if (c === "/" && n === "*") {
      const start = i + 2;
      const end = src.indexOf("*/", start);
      sinks.onComment?.(src.slice(start, end < 0 ? src.length : end));
      i = Math.min(end < 0 ? src.length : end + 2, src.length);
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // 单双引号串都不跨行（未闭合时不吞掉后面整篇），模板串跨行。
      // 三者都必须整个吃下去 —— 不吃的话它们内容里的一个 `"` 会被当成起点，
      // 凭空造出一条引用。这才是读它们的意义。
      skipStr(c, c !== "`");
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j] as string)) j++;
      sinks.onWord?.(src.slice(i, j), j);
      i = j;
      continue;
    }
    i++;
  }
}
