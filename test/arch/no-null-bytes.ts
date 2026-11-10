/**
 * 源码与迁移文件里不许出现【字面 NUL 字节】（判据本体）。
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
