/**
 * 测试夹具目录的唯一入口：`<夹具根>/<名字>-<pid>`（判据本体在本文件下半部）。
 *
 * ── 为什么需要这一处（0025 §7 第 7 条那一格）─────────────────────────
 * 全仓 33 个测试文件各自写 `const TMP = join(HUB, ".tmp", "<固定名字>")`，
 * 而 `beforeAll` 里跟着一条 `rmSync(TMP, {recursive: true, force: true})`。
 * 目录名**按测试文件分，不按进程分** ⇒ 同一个文件的两份运行（两条并发全量、
 * 或一条全量加一路手工复现）会**互相删对方正在用的库**。
 *
 * 复算（本篇 §0，脚本 `/tmp/probe-concurrent.mjs`）：同一批 4 个 db 测试文件
 *   顺序跑      → 89 / 87 / 2
 *   两条并发 A  → 89 / 84 / 5
 *   两条并发 B  → 89 / 82 / 7        ← 两串红还**互不相同**
 * 报错是 `file is not a database` / errcode 1555 / SQL logic error ——
 * 全是「库文件在我手底下被人换掉」的形状，**一条都不指向被改过的代码**。
 *
 * ── 为什么是「目录名带 pid」而不是「只删自己那些前缀」────────────────
 * 0025 当时记的是后者（把 `rmSync` 改成按前缀删）。那条不成立：
 * `integrity.test.ts` 的**库文件名**早就带了 pid（`ig-<pid>-<序号>.db`），
 * 而它照样红 —— 因为**目录名没带**，删的还是同一个目录。
 * 「文件名分开了、删的是同一个目录」正是「光是加 pid 不够」的确切成因，
 * 而它同时指出该动的是**目录**这一层：目录按 pid 分开之后，
 * 「整目录 rmSync」重新变成一个安全动作（删的必然是自己那份），
 * 不需要在 33 个文件里各写一遍「只删自己的」逻辑 ——
 * 那种写法**漏一处就红一次，而漏的那处在正常单跑下永远是绿的**。
 *
 * ── 本模块【不注册】清理钩子，这是刻意的 ────────────────────────────
 * 让 helper 顺手 `afterAll(rmSync)` 看着更省心，而它有两处实测代价：
 *  ① **钩子顺序**。`node:test` 的 `after` 是**先进先出**（实测：
 *     两个 after 打出 `ORDER=first-registered,second-registered`）。helper 的注册点
 *     在文件头的 `const TMP = ...` 那一行，**早于**各文件自己那个 afterAll，
 *     于是清理会跑在「afterAll 里关句柄 / 断言跑了多少发」**之前**。
 *     实测这个乱序对 SQLite 不致命（macOS 上先 `rm -rf` 目录、再写入、再 close
 *     都不抛：`/tmp/probe-close-after-rm.ts`、`/tmp/probe2.ts`），但那是
 *     **posix 的 unlink 语义**在替我们兜着，不是一条被声明的性质。
 *  ② 那会让 `afterAll` 从 node:test 取钩子，而本仓的离线夹具把 vitest 门面
 *     放在仓库外（`/tmp/opc-harness`，理由见那里）：一个**生产夹具模块**依赖
 *     测试框架的名字解析，等于把「夹具能不能跑」系在夹具上。
 * 所以清理**照旧留在各文件的 afterAll 里**（现存 33 处一条不缺，本篇一条没动），
 * 而「有没有漏写清理」由 `test/fixtures/fixture-dir.test.ts` 那条普查守着 ——
 * 判据落在守卫里，不落在约定里（`test/arch/run-fixtures.ts` 文件头那句
 * 「注释不是机制」在这里同样成立）。
 *
 * ── 换成 pid 目录会带进来一个新洞，所以顺手补上 ─────────────────────
 * 固定名时代「上一次崩留下的目录」会被下一次运行顺手删掉 —— 那**正是**竞态的来源。
 * 换成 pid 之后没人顺手删了 ⇒ 每崩一次留一摞 SQLite 库。
 * 所以 `fixtureTmp` 在建自己那份之前，先删**同名字而 pid 已死**的兄弟目录。
 * 这条为什么安全（也是它唯一的前提）：**目录名里的 pid 就是它的属主**，
 * 而活着的进程之间 pid 唯一 ⇒ 「pid 不在」等价于「属主已经没了」⇒ 那是泄漏不是引用。
 * 反过来，用「目录多久没动过」当判据是**错**的（慢用例正在写的库也可能很久没动），
 * 用「别人来删我的目录」当清理更是本篇刚消掉的那个动作本身。
 * 只删**完全匹配 `<本名字>-<数字>`** 的项：`.tmp/bench`（bench-recompute.mjs 的产物）
 * 这种不带 pid 后缀的一律不碰。
 */
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 夹具根（相对本文件）。绝对化在 `fixtureRoot()` 里做。 */
const FIXTURE_ROOT_REL = join("..", "..", ".tmp");

/**
 * 合法夹具名：小写字母数字与连字符，且**首尾都不能是连字符**。
 *
 * 尾部那条不是洁癖。改造前那 4 处正确写法长这样：
 * `join(HUB, ".tmp", "tokens-" + process.pid)` —— 名字自带尾横线，pid 靠拼接。
 * 换成 helper 时若照抄名字，会得到 `tokens-<pid>-<pid>` 这种怪形状，
 * 而它**照样带 pid、照样不出事** ⇒ 判据照绿 ⇒ 没人会去修。
 * 让名字校验把尾横线拒掉，等于强迫那 4 处在转换时就写对（名字去掉尾横线）。
 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/u;

/**
 * 由**调用方文件的 URL** 算出夹具根的绝对路径。
 *
 * 必须锚定 `import.meta.url` 而不是 `process.cwd()`：两种 runner 的工作目录不保证相同
 * （`test/poc/resume.test.ts` 文件头记的就是这个坑 —— 它原先写成相对量 `.tmp/poc`）。
 */
export function fixtureRoot(callerUrl: string): string {
  if (!callerUrl.startsWith("file://")) {
    throw new Error(
      "fixtureRoot 要的是 import.meta.url（一个 file:// URL），实得 " + callerUrl,
    );
  }
  return resolve(dirname(fileURLToPath(callerUrl)), FIXTURE_ROOT_REL);
}

/**
 * pid 探活。`process.kill(pid, 0)` 不发信号，只做存在性与权限检查。
 *
 * 与 `src/serve/lock.ts` 的 `isPidAlive` 同一套语义（EPERM = 在，意料之外 = 当成在），
 * 而这里是**自己一份**而不是 import 它：那一份属生产代码，
 * 测试夹具层依赖 `src/serve/` 只为了一个 `kill(pid, 0)` 不值，
 * 而两处语义若漂，漂的方向是「测试把自己的活目录删了」。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return true; // 意料之外 ⇒ 当成在（当成不在的代价是删掉别人正在用的目录）
  }
}

/**
 * `<名字>-<pid>` 里那个 pid。**必须是末尾那一组数字**：
 * `schema-0001-4242` 的 pid 是 4242 而不是 0001 —— 若从前往后数，
 * 一份叫 `schema-0001` 的泄漏目录会被认成 pid 1（macOS 上 launchd 恒在 ⇒ 永不清理，
 * 更坏的是别的名字可能被认成一个**恰好活着**的无关 pid）。
 */
export function pidOfFixtureDir(entry: string, name: string): number | null {
  if (!entry.startsWith(name + "-")) return null;
  const tail = entry.slice(name.length + 1);
  if (!/^\d+$/u.test(tail)) return null;
  return Number(tail);
}

/**
 * 该被清掉的兄弟目录：**同名字、带 pid、那个 pid 已经不在、且不是我们自己**。
 * 纯函数（`alive` 注入），所以「pid 复用」「目录不是我们的」这些态都能单测钉住，
 * 不必真造一个死进程去撞。
 */
export function staleFixtureDirs(
  entries: readonly string[],
  name: string,
  ourPid: number,
  alive: (pid: number) => boolean = isPidAlive,
): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    const pid = pidOfFixtureDir(entry, name);
    if (pid === null || pid === ourPid) continue;
    if (!alive(pid)) out.push(entry);
  }
  return out;
}

export interface FixtureTmpOptions {
  /** 换夹具根。只给「夹具本就不在包 .tmp 下」的调用方（今天只有 test/poc 那一处）。 */
  readonly root?: string;
  /** 关掉「顺手清掉 pid 已死的同名目录」。只给判据的自测用。 */
  readonly prune?: boolean;
}

/**
 * 本进程专属的夹具目录。**调用它即拿到带 pid 的路径**；目录本身不建
 * （`mkdirSync` 照旧由调用方在自己的 `beforeAll` / 文件顶层做 —— 33 处已有，一条不动）。
 *
 * @param name 夹具名，**必须写字面量**：`test/fixtures/fixture-dir.test.ts` 那条普查
 *   按字面量读名字，写成变量它就证明不了「每个目录都带 pid」。
 * @param callerUrl 调用方文件的 `import.meta.url`。
 */
export function fixtureTmp(
  name: string,
  callerUrl: string,
  opts: FixtureTmpOptions = {},
): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `夹具名必须是小写字母/数字/连字符（它直接拼进磁盘路径），实得 ${JSON.stringify(name)}`,
    );
  }
  // 自带 pid 后缀的写法（改造前那 4 处 `"tokens-" + process.pid`）在这里会被
  // 二次拼接成 tokens-<pid>-<pid>。不报错，但普查那条会把它抓出来 ——
  // 与其在这里静默接受一个怪形状，不如让它红在普查那一发上（原因可见）。
  const root = opts.root ?? fixtureRoot(callerUrl);
  if (opts.prune !== false) pruneStaleFixtureDirs(root, name);
  return join(root, `${name}-${process.pid}`);
}

/** 清掉同名字而属主已死的目录。删不掉就作罢：那是泄漏，不是错误。 */
function pruneStaleFixtureDirs(root: string, name: string): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return; // 夹具根还不存在 ⇒ 没有可清的
  }
  for (const entry of staleFixtureDirs(entries, name, process.pid)) {
    try {
      rmSync(join(root, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      /* 留着。它比「一次启动失败」轻，而 next 一次运行还会再试 */
    }
  }
}

/* ──────────────────────────────────────────────────────────────────────
 * 判据本体：「测试夹具目录必须按进程分开」。
 *
 * 形状与 `test/arch/no-native-deps.ts` 同一族 —— 纯函数，喂 (相对路径, 源码文本)，
 * 交命中。必须抽出来的理由：这条判据要能被**变异**证明有判别力，
 * 而变异一条内联在 it 里的正则只能靠「我改对了」自证。
 *
 * ── 命中形状与它的已知漏口 ──────────────────────────────────────────
 * 认的是 `join(<任意>, ".tmp", "<字符串字面量>")`。第二段是变量时**不报** ——
 * 读不出它会不会带 pid。这是**已知漏口**（0035 §别当成做到了）：
 * 漏的方向是「少报」，而把变量也算命中会让人去把变量改成字面量（绕开判据）。
 *
 * ⚠ 判据刻意**不**要求名字以 `-${process.pid}` 结尾。第一版那么写，
 * 于是它把**唯一那 4 处已经正确的写法**（`"tokens-" + process.pid` 那种拼接）
 * 判成违规。一条把正确写法判成错的判据，下场是被人放宽整条
 * （0033 §3 那条「更严的核对拒掉唯一正确的接法」讲的是同一件事）。
 * ────────────────────────────────────────────────────────────────────── */

/*
 * ⚠ 第一段那串 `(?:[^()]|\([^()]*\))*?` 不是随手写的，是被一次变异逼出来的：
 * 我原先写的是 `[^,()]+`，于是**第一段带括号的写法全部看不见** ——
 * 实测 `join(process.cwd(), ".tmp", "migrate")` 把已转换的文件改回固定名之后
 * **普查零命中**（而那正是最省事的新写法）。`join(HUB, …)` 那种纯标识符能匹配，
 * 掩盖了「只要参数是个调用就漏」。现在允许一层嵌套括号，两层以上仍会漏
 * （`join(a(b(c())), …)`），那是**已知漏口**，记在 0035 §别当成做到了。
 */
const FIXED_TMP_JOIN =
  /join\((?:[^()]|\([^()]*\))*?,\s*["']\.tmp["']\s*,\s*(?:"([^"]*)"|'([^']*)')/gu;

/** 扫出源码里所有「固定名的 .tmp 目录」。变量第二段不算（见上）。 */
export function fixedTmpDirNames(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(FIXED_TMP_JOIN)) {
    const literal = m[1] ?? m[2];
    if (literal !== undefined) out.push(literal);
  }
  return out;
}

/** 剥注释。两步走的那份与 `bindings/im.test.ts` 同源。 */
export function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/^\s*\/\/.*$/gmu, "");
}

/**
 * 是否把 `.tmp` 当**目录名**用（而不是 `e.name === ".tmp"` 那种比对）。
 *
 * 为什么要有这一发：`test/arch/test-inventory.ts` / `harness-invariants.ts` /
 * `doc-refs.test.ts` / `bindings/im.test.ts` 四处把 `.tmp` 列进「扫描时跳过」的名单。
 * 一条只看 `.tmp` 字符串的普查会要求那四处也「按进程分开」——
 * 而**跳过名单**里带 pid 是荒谬的（磁盘上那个目录名恒为 `.tmp`，
 * 名单里写成 `.tmp-4242` 才是真错）。所以判据必须分得开「建目录」与「比对名字」。
 */
export function createsTmpDir(source: string): boolean {
  return /["']\.tmp["']/.test(source) && /join\(/u.test(source);
}

/** 已经走 helper 的名字（`fixtureTmp("x", …)` 里的字面量）。 */
export function helperFixtureNames(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/fixtureTmp\(\s*["']([^"']+)["']/gu)) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

/**
 * 本判据的射程：文件里**建了 .tmp 目录**，**或**已经走了 `fixtureTmp()`。
 *
 * 后一半不是凑数 —— 转换做完之后，那些文件里**不再有** `".tmp"` 字面量，
 * 于是「只看 .tmp」的射程会把全部 33 个文件排除掉，`no-cleanup` 那一支
 * 就变成一条**永远走不到**的判据（0033 §6 那条「今天恒绿的守卫要自己声明恒绿」
 * 说的就是这种形状：它比没有守卫更糟，因为它长得像有守卫）。
 */
export function inScopeForFixtureGuard(source: string): boolean {
  return createsTmpDir(source) || helperFixtureNames(source).length > 0;
}

/**
 * 判据不看这两个文件 —— 它们是**判据自己**。
 *
 * 必须显式列而不是靠「它们不含 .tmp」：机制文件天生要把目录名拼出来给人看，
 * 所以它天生长得像违规。例外写成集合而不是 if 判断，是为了让下面那条测试能断言
 * 「例外恰好这两个」—— 无条件放行的例外是最容易被照着抄的隐身衣。
 */
export const GUARD_SELF_PATHS: readonly string[] = [
  "test/fixtures/fixture-dir.ts",
  "test/fixtures/fixture-dir.test.ts",
];

/** 命中原因。两种坏法修法不同，所以不压成一个布尔。 */
export type FixtureDirWhy = "fixed-name" | "no-cleanup";

export interface FixtureDirHit {
  readonly path: string;
  readonly names: readonly string[];
  readonly why: FixtureDirWhy;
}

/**
 * 判据本体。喂 (相对路径, 源码)，交出所有违规。
 *
 * 两条子判据：
 *  · `fixed-name`：建了固定名的 `.tmp` 目录而没走 `fixtureTmp()`；
 *  · `no-cleanup`：走了 `fixtureTmp()` 而整个文件里**找不到 afterAll 里的清理**
 *    —— 清理是本设计的不变量（本模块刻意不注册钩子，理由在文件头），
 *    漏了就每跑一次漏一份库。
 * 第二条只查「文件里 afterAll 之后出现过 rmSync(TMP」，不查删的就是那份目录：
 * 后者要真解析 AST，而把判据写宽会误伤（0025 §7 那条「误报让整套挂掉，代价比漏报高」）。
 */
export function fixtureDirHits(
  files: ReadonlyMap<string, string>,
): FixtureDirHit[] {
  const hits: FixtureDirHit[] = [];
  for (const [path, raw] of files) {
    if (!path.endsWith(".ts")) continue;
    if (GUARD_SELF_PATHS.some((s) => path.endsWith(s))) continue;
    const source = stripComments(raw);
    if (!inScopeForFixtureGuard(source)) continue;
    const usesHelper = helperFixtureNames(source).length > 0;
    if (!usesHelper) {
      const names = fixedTmpDirNames(source);
      if (names.length > 0) hits.push({ path, names, why: "fixed-name" });
      continue;
    }
    const cleans = /afterAll\([\s\S]*rmSync\(\s*TMP\b/u.test(source);
    if (!cleans) {
      hits.push({ path, names: helperFixtureNames(source), why: "no-cleanup" });
    }
  }
  return hits;
}

/**
 * 把命中翻成人话（含修法）。
 *
 * ⚠ 这一段的文案**不能**写成 `join(HUB, ".tmp", "名字")` 或 `fixtureTmp("名字"` 那种
 * 完整调用形状 —— 本模块的文案也在普查扫的树里，一条把修法写成完整调用形状的
 * 报错会让**判据自己命中自己的判据**（我第一次就踩了这条，靠那条「helper 自己
 * 零命中」的断言抓到的）。所以下面只给函数名与参数写法，不给可匹配的调用形状。
 */
export function explainFixtureDirHit(hit: FixtureDirHit): string {
  const where = hit.names.length > 0 ? ` [${hit.names.join(", ")}]` : "";
  if (hit.why === "no-cleanup") {
    return (
      `${hit.path}${where} 用了 fixtureTmp 而文件里没有「afterAll 里 rmSync(TMP, …)」那条清理。` +
      "目录名带 pid ⇒ 下一次运行【不会】顺手删它（那正是被消掉的竞态），" +
      "所以漏一次就漏一份 SQLite 库。补法：在文件末尾的 afterAll 里 " +
      "rmSync(TMP, { recursive: true, force: true })。"
    );
  }
  return (
    `${hit.path}${where} 建了固定名的夹具目录而没用 fixtureTmp()。` +
    "两个测试进程会互相删对方正在用的库（症状：file is not a database / errcode 1555，" +
    "一条都不指向被改过的代码）。修法：从 test/fixtures/fixture-dir.js import fixtureTmp，" +
    "把那个拼 .tmp 路径的常量换成对它的一次调用（第一参数写目录名字面量，" +
    "第二参数写 import.meta.url；层级按文件深浅调）。"
  );
}
