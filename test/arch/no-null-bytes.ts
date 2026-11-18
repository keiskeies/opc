/**
 * 源码与迁移文件里不许出现【静默的坏字节】（判据本体）。
 *
 * ⚠ 本文件现在有【两条】判据，共用同一份取材：
 *  ① 字面 NUL 字节（`findNullBytes` / `nullByteHits`）—— 0029 那一族，文件名就来自它；
 *  ② U+FFFD 替换字符（`findReplacementChars` / `replacementCharHits`）—— 0056 §5
 *     明确「留给下一轮」的那一格，本轮补上。
 * 两条同住一个文件不是省事：扫描根、取材、以及「跳过的文件要计数」那条元守卫全都要一样，
 * 而本仓对口径重复的账记过太多次（两份会漂移，漂移的表现是其中一份悄悄不判了）。
 * 文件名【没】跟着改：0029 / 0056 两篇 ADR 按这个名字引用它，改名会把【历史叙述】
 * 变成坏引用 —— 那正是本仓 doc-refs 守的那件事，不该为了名字好看去制造它。
 *
 * ── 触发它的两件事（同一个错，两次，第二次是被 git 收进去之后才发现）──────
 * 1. `channels/abstraction.ts` 我写完发现 grep 报 "Binary file matches" ——
 *    Write 工具把源码里的 `"\x00"` 字符串字面量**当成真字节写了出来**。
 *    当时靠肉眼看 + 一次手写字节扫描抓到的。
 * 2. `harness/gateway.ts:380` 的 `tool + "\0" + …` —— 这一发是**已经 commit 进
 *    1877e8e 之后**才发现的，而且它**没让任何守卫变红**。
 *
 * ── 为什么「文件还能跑」不是一句安慰话 ──────────────────────────────
 * 一个含 NUL 的 .ts 在 Node 与 tsc 眼里**仍然是合法的 UTF-8 文本**：
 * 编译过、跑得对、测试全绿。坏的是**别的三件事**，而且全是静默的：
 *
 * 1. `grep -rn` 把它报成 "Binary file matches" 并**只打文件名、不打行、不算命中**。
 *    本仓大量的「动手前先 grep 一遍」纪律（0013 §10.1 那一次实测开了这一族）
 *    在这个文件上**恒返回 0 命中**，而 0 命中读起来正是「没有这个毛病」——
 *    一个假阴性会被当成**证据**。（本篇里现成的一例：那条
 *    `grep -rn "INSERT INTO approvals"` 的普查，如果写卡片的那个文件含 NUL，
 *    结论会从「1 处 INSERT」变成「0 处」，而那两个结论指向相反的下一步。）
 * 2. git 之后所有 diff / blame / log -S 对它显示 "Binary files differ"，
 *    一次改动**看不到改了什么**（review 时最值钱的那件东西没了）。
 * 3. Edit 工具的 `old_string` 匹配不到它 ⇒ 想改它只能整文件重写，
 *    而整文件重写含中文的文件正是 0027 §5-③ 那条纪律要防的事。
 *    本次修复本身就是这条的活证据：那个文件**只能**用字节级脚本改。
 *
 * ── 判据为什么扫【字节】而不是扫内容 ────────────────────────────────
 * 扫 `text.includes("\0")` 需要先读成字符串，而「读成什么编码」正是这件事坏掉的
 * 那一环。所以这里读 Buffer 直接看字节 0x00，并在报错时给出**行号**与前后文字，
 * 让下一次的人不必再手写一遍扫描脚本。
 */

/** 扫哪些后缀。只扫**源码与迁移**：二进制夹具（若有）本来就该含 NUL。 */
export const SCANNED_SUFFIXES: readonly string[] = [
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".js",
  ".sql",
  ".md",
  ".json",
  ".yaml",
  ".yml",
];

export interface NullHit {
  readonly path: string;
  readonly byteOffset: number;
  readonly line: number;
  /** 那一行里 NUL 前后各 30 字节，用 `<NUL>` 标出位置。给人一眼定位用。 */
  readonly context: string;
}

/** 找一个 Buffer 里所有 0x00。纯函数，不碰盘。 */
export function findNullBytes(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) out.push(i);
  }
  return out;
}

/** 把「字节偏移 + 原始 Buffer」翻成一条能读的命中。 */
export function describeNullHit(path: string, buf: Buffer, byteOffset: number): NullHit {
  // 行号 = 偏移之前的换行数 + 1（NUL 自己不是换行，latin1 下字节数=字符数）。
  const head = buf.subarray(0, byteOffset).toString("latin1");
  const line = (head.match(/\n/gu)?.length ?? 0) + 1;
  const from = Math.max(0, byteOffset - 30);
  const to = Math.min(buf.length, byteOffset + 31);
  const ctx = buf
    .subarray(from, to)
    .toString("utf8")
    .split("\x00")
    .join("<NUL>")
    .replace(/\s+/gu, " ");
  return { path, byteOffset, line, context: ctx };
}

/** 判据本体：给一批 (相对路径, 内容)，交出所有含 NUL 的命中。 */
export function nullByteHits(files: ReadonlyMap<string, Buffer>): NullHit[] {
  const hits: NullHit[] = [];
  for (const [path, buf] of files) {
    for (const off of findNullBytes(buf)) hits.push(describeNullHit(path, buf, off));
  }
  return hits;
}

/* ══════════════════════════════════════════════════════════════════════
 * 第二型静默坏字节：U+FFFD「替换字符」。
 *
 * 与 NUL 是同一族（写进去那一刻就坏了，之后【什么都不会红】），但机制不同，
 * 所以判据也不同：NUL 是「多了一个不该有的字节」，这个是「一个汉字被换成了一个
 * 坏字符」—— 文件仍是合法 UTF-8、仍能编译、grep 仍打得出行，坏的只有【那一个字】。
 *
 * ── 触发它的一次真事故，和一条【几乎注定写错】的实现 ──────────────────
 * 0056 §5 记过一次：docs/INDEX.md 里有个坏字符，当时靠「按内容扫」偶然撞到，
 * 并明写「本仓有 no-null-bytes 守 NUL，没有守 U+FFFD … 留给下一轮」。
 * 本轮动手时又扫出第二处：`0047 …md:130` 的「修的是」坏成「修的<U+FFFD><U+FFFD><U+FFFD>」，
 * 已 commit（0a5b2a7、f641db8 两个版本都带着），没有任何守卫红过。
 *
 * ⚠ 那三个 EF BF BD 是【合法 UTF-8】—— 它们是 U+FFFD 自己的正确编码。
 * 所以最直觉的那个实现【测不到这次事故】：
 *     new TextDecoder("utf-8", { fatal: true }).decode(buf)   // 不抛 ⇒ 判成干净
 * 实测口径差得很干脆：全仓 359 个文本文件里，fatal 解码报【0】处非法，
 * 而按内容扫 U+FFFD 报【1】处 —— 就是 0047 那一处。
 * ⇒ 判据必须扫【解码后文本里的 U+FFFD】，不是扫【解码会不会失败】。
 * 两种坏法下面都各有一发用例钉着，因为它们是两条独立的通道：
 *  · 原始字节非法（截断在多字节中间）→ 非 fatal 解码会把它映射成 U+FFFD，这一发抓得到；
 *  · 字节合法但内容就是 U+FFFD（本次事故）→ 只有扫内容抓得到。
 * ══════════════════════════════════════════════════════════════════════ */

/** U+FFFD 的码点。写成数字是为了【本文件里不出现那个字符本身】——
 * test/ 在扫描根里，守卫的源码要是含一个真的坏字符，就会把自己判红。
 * （NUL 那一侧同形：用例里写的是 `Buffer.from([0x00])` 而不是字面 NUL。） */
export const REPLACEMENT_CHAR = 0xfffd;

export interface ReplacementHit {
  readonly path: string;
  readonly line: number;
  /** 该行里坏字符前后各 30 字符，坏字符处标 `<FFFD>`。给人一眼定位用。 */
  readonly context: string;
}

/** 一段【已解码】文本里所有 U+FFFD 的字符下标。纯函数，不碰盘。 */
export function findReplacementChars(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === REPLACEMENT_CHAR) out.push(i);
  }
  return out;
}

/** 把「字符下标 + 整篇文本」翻成一条能读的命中（带行号，理由与 NUL 那侧一字不差）。 */
export function describeReplacementHit(
  path: string,
  text: string,
  index: number,
): ReplacementHit {
  const line = (text.slice(0, index).match(/\n/gu)?.length ?? 0) + 1;
  const from = Math.max(0, index - 30);
  const to = Math.min(text.length, index + 31);
  const context = text
    .slice(from, to)
    .split(String.fromCharCode(REPLACEMENT_CHAR))
    .join("<FFFD>")
    .replace(/\s+/gu, " ");
  return { path, line, context };
}

/**
 * 判据本体。入参仍是 Buffer（与 `nullByteHits` 同一份取材结果，两条守卫扫同一批文件）。
 *
 * 解码【不用 fatal】：这里要的是「坏字节和坏内容都落到同一个符号上」，
 * 而不是「坏字节抛错」。用非 fatal 解码，截断的多字节序列会被映射成 U+FFFD，
 * 于是两类坏法一次扫到；用 fatal 反而只抓到其中一类（见上面那段实测）。
 * 非 UTF-8 的【二进制】文件不在扫描后缀里，不会误伤。
 */
export function replacementCharHits(
  files: ReadonlyMap<string, Buffer>,
): ReplacementHit[] {
  const hits: ReplacementHit[] = [];
  for (const [path, buf] of files) {
    // 不与 nullByteHits 互相让位：一个文件同时含 NUL 与 U+FFFD 时两条都该报。
    // 「有 NUL 就跳过 FFFD 扫描」看着像去重，实际是把两个独立判据耦上 ——
    // NUL 那一侧哪天改口径（加豁免、改后缀），这一侧会静默少扫那批文件。
    const text = buf.toString("utf8");
    for (const i of findReplacementChars(text)) {
      hits.push(describeReplacementHit(path, text, i));
    }
  }
  return hits;
}
