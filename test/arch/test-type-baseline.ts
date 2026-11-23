/**
 * 测试语料的类型检查看得见的部分：`tsc -b` 从来看不到任何一个测试文件，
 * 这里把那个洞从「一句散文」变成一条只许减不许增的棘轮。
 *
 * ── 为什么必须有这一发 ─────────────────────────────────────────
 * round277 量的事实（不是推理）：根 `tsconfig.json` 只 reference `packages/*`，
 * 而 `packages/hub/tsconfig.json` 只 include `src` ⇒ 全部测试文件整体在类型检查
 * 射程之外。证据是一条注入：往 `test/arch/role-spawn-boundary.ts` 塞一句
 * `const 坏: number = "字符串"` ⇒ `tsc -b` 退出码 0。
 * 那个洞不是理论问题：`claims-registry` 的 `judge` 联合类型从 round274 起就缺
 * r10/r11/r12 三个名字，三处真类型错活了三轮，没有任何一道门禁经过它们。
 *
 * ── 为什么这一轮才做得成 ───────────────────────────────────────
 * round277 刻意【没有】把 `.workbuddy/tsconfig.tests.json` 接成门禁，理由写在它
 * 自己的 $comment 里：当时 289 条错，一条恒红的验收命令等于一条恒红断言
 * （0055 / 0056 / 0057 记了三遍的那个代价）。那个理由当时是对的，今天仍然对
 * 【那个形状】成立 —— 但它可以换一个形状：不是「现在就得零错」，而是
 * 「今天这么多，不许更多」。`pnpm lint` 那条棘轮（./lint-baseline.ts）治的就是
 * 同一类债，它没有要求任何人去修 lint，它只挡新增。
 *  ⇒ 这一发买的和 lint 那条一样，是**方向**，不是绿。
 *
 * ── 为什么按目录配额，而不是只钉一个总数 ───────────────────────
 * lint 那条按【规则类目】配额，这里按【目录】配额，两者治的是同一种作弊面：
 * 一个总数会被「这边修十条、那边加十条」顶掉，而 round275 的 P4 恰好量过这件事
 * ——「一个被撑大的总数会替一个空掉的分区作证」。按目录之后，把 `test/arch`
 * 修干净同时往 `test/org` 加错，是红的。
 *
 * ── 反向的一半 ─────────────────────────────────────────────────
 * 某目录修到 0 条 ⇒ 那条配额成了永真的空壳 ⇒ 报「请把这条删掉」而不是判红
 * （豁免不许比现实活得久，与 lint 基线 / zero-producer 同一立场）。
 *
 * ── ⚠ 射程，三条，比上面全部加起来重要 ─────────────────────────
 *  ① 它【不】让 `pnpm typecheck` 变绿，也【不】声称测试类型安全。它只挡新增。
 *     今天 291 条错里绝大多数是 `noUncheckedIndexedAccess` 下的索引与
 *     `exactOptionalPropertyTypes` 的实参形状问题 —— 是不是债逐条要人判，
 *     本守卫不替任何人判。
 *  ② 它跑在【别的测试正在改的工作树】上（同文件系统的并行 fork，pool: "forks"）。
 *     `src` 里一个语法错的探针会【关掉整个类型检查】：tsc 报出那一条、不再往下
 *     查，本守卫于是少报几十上百条 —— 方向上「只会更低」，所以不会假红，
 *     但它那一刻测的确实不是完整语料。这条不试图解决，只登记（见 .test.ts 里
 *     那一发把失效方向钉住的测试）。
 *  ③ include 的 glob 若被人改窄，配额表会对着一个空语料自证通过。⇒ 一条
 *     「检查过的文件数有下限」的哨兵拦它，出处是 0006 §7 第 41 条。
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 一个测试目录的基线：目录 + 当时实测条数（= 不许超过的上限）。 */
export interface TypeBaselineEntry {
  /** 仓库根相对、posix 分隔的目录。 */
  readonly dir: string;
  /** 当时实测条数，作为**上限**。往下调 = 有人在修，随时欢迎；往上调要点名。 */
  readonly atMost: number;
}

/**
 * 2026-11-17 现测（`npx tsc -p .workbuddy/tsconfig.tests.json`），共 291 条。
 * 这是**上限表**不是**期望表**：它不要求今天正好这么多，只要求不许更多。
 * ⚠ 这张表是数出来的，不是估的。复算（把每行错归到它所在目录再数）：
 *   `npx tsc -p .workbuddy/tsconfig.tests.json 2>&1 | grep 'error TS'`
 *   去列号去文件名后 `sort | uniq -c`（管道里那一步是「删掉第一个左括号之后的全部」，
 *   这里故意不把它原文抄进注释 —— 那个写法里的两个字符连起来会提前关掉这段注释，
 *   而本守卫自己就是靠【读得懂】tsc 的输出才成立的，注释里的语法错一样会让它红）。
 */
export const TYPE_BASELINE: readonly TypeBaselineEntry[] = [
  { dir: "packages/hub/test/engine", atMost: 70 },
  { dir: "packages/hub/test/serve", atMost: 62 },
  { dir: "packages/hub/test/overview", atMost: 36 },
  { dir: "packages/hub/test/http", atMost: 24 },
  { dir: "test/org", atMost: 15 },
  { dir: "packages/hub/test/approvals", atMost: 14 },
  { dir: "packages/hub/test/harness", atMost: 12 },
  { dir: "packages/hub/test/channels", atMost: 7 },
  { dir: "packages/hub/test/acceptance", atMost: 3 },
  { dir: "test/desktop", atMost: 3 },
  { dir: "test/web", atMost: 3 },
  { dir: "packages/hub/test/budget", atMost: 2 },
  { dir: "packages/hub/test/charter", atMost: 1 },
  { dir: "packages/hub/test/evidence", atMost: 1 },
  { dir: "packages/hub/test/gates", atMost: 1 },
  { dir: "packages/hub/test/graph", atMost: 1 },
  { dir: "packages/hub/test/graph/fixtures", atMost: 1 },
  { dir: "packages/hub/test/heartbeat", atMost: 1 },
  { dir: "packages/hub/test/memory", atMost: 1 },
  { dir: "packages/hub/test/policy", atMost: 1 },
  { dir: "packages/hub/test/search", atMost: 1 },
];

/** 一条类型错：文件 + TS 错误码。守卫只用到这两个字段。 */
export interface TypeErrorLike {
  /** 仓库根相对、posix 分隔的文件路径，如 `test/arch/x.test.ts`。 */
  readonly file: string;
  readonly code: string;
}

/**
 * 目录 = 去掉最后一段文件名；根上的文件归到 `.`。
 *
 * ⚠ 先归一分隔符再切。第一版只切 `/`，而本仓在 Windows 上跑 ⇒ 任何用 `join()`
 *   造出来的路径都会让这里退化成 `.`（`packages\hub\test\engine\x.ts` 里没有 `/`）。
 *   真实调用点拿的是 `toRepoRelative` 出来的 posix 路径，本来碰不到；但这个函数是
 *   【导出】的，下一个调用方用 join 就会踩，而那一次的症状是「所有错都堆进 `.`
 *   ⇒ 一条『基线外的目录 .』的假红」。守卫自己的夹具第一轮就是这么红的。
 */
export function dirOf(file: string): string {
  const p = file.split("\\").join("/");
  const i = p.lastIndexOf("/");
  return i < 0 ? "." : p.slice(0, i);
}

/** 按目录计数（纯函数，变异测试直接喂合成读数）。 */
export function countTypeErrorsByDir(
  errors: readonly TypeErrorLike[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of errors) {
    const d = dirOf(e.file);
    out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

/**
 * 棘轮判据。返回 "" 表示在基线内。
 *
 * ⚠ 顺序有讲究：先报「配额外的新目录」，再报「超出」。反过来会让人以为
 * 只是数字涨了，而真实情况是「多出一个从没登记过的测试目录」—— 那是要单独
 * 做一次决定的事（同 lint 那条对「基线外的新 error 类目」的处置）。
 *
 * ⚠ 仓外形状的红话【自己说清病灶】（round304 落 round300 的残留②）。这条红历史上
 *   对两类事返回同一副面孔：真新目录（处置 = 去 TYPE_BASELINE 点名）与
 *   include 指错吃到隔壁仓（处置 = 去改 tsconfig，【绝不能】登记进表 —— 登记等于
 *   让配额表永久接受隔壁仓下单）。两类处置动作相反，而旧红话让读的人自己认出
 *   「这是 include 指错」（round300 §残留② 原话）。现在区分句直接写进红话里，
 *   且【只】在 isOutsideRepo 命中时出现 —— 反向对照钉在 .test.ts：
 *   无条件拼尾巴会让真新目录也被指成 include 事故，那发必须红。
 */
export function diffTypeBaseline(
  counts: ReadonlyMap<string, number>,
  baseline: readonly TypeBaselineEntry[] = TYPE_BASELINE,
): string {
  const cap = new Map(baseline.map((b) => [b.dir, b.atMost]));
  const unregistered: string[] = [];
  let outsideCount = 0;
  const over: string[] = [];
  for (const [dir, n] of counts) {
    const allowed = cap.get(dir);
    if (allowed === undefined) {
      unregistered.push(dir + "=" + n);
      // 目录名自身就是那条路径的去尾形状：`../other-repo/pkg` 与 `E:/other/repo`
      // 在这里仍是仓外形状（raw 与 rel 同值传给 isOutsideRepo 是有意的，
      // 它的两个判据各读一侧：绝对式看 rel，`../` 式看 raw，见它的注释）。
      if (isOutsideRepo(dir, dir)) outsideCount++;
      continue;
    }
    if (n > allowed) over.push(dir + " " + allowed + "→" + n);
  }
  if (unregistered.length > 0) {
    const base =
      "出现了基线外的测试目录（" +
      unregistered.sort().join(", ") +
      "）—— 新目录里的类型错必须先在 TYPE_BASELINE 里点名并写明理由，" +
      "否则它会顺着「反正测试本来就不在 tsc -b 射程里」混过去";
    if (outsideCount === 0) return base;
    return (
      base +
      "。⚠ 其中 " +
      outsideCount +
      " 格是【仓外形状】（`../` 前缀或绝对路径）：这一发的病灶是【这个 tsc project " +
      "吃进了仓外的文件】，去查 tsconfig 的 include/project 引用并修掉它 ——" +
      " 把它们登记进 TYPE_BASELINE 等于让本仓的配额表永久接受隔壁仓下单。"
    );
  }
  if (over.length > 0) {
    return (
      "测试语料的类型错比基线多了（" +
      over.join("；") +
      "）。这一发是棘轮：只许减不许增。" +
      "要么改掉新增的那几条，要么在 TYPE_BASELINE 里点名并说清为什么值得。"
    );
  }
  return "";
}

/**
 * 反向的一半：某目录已经修干净了，表里那条豁免就是永真的空壳。
 * 不判红（修完是好事），报的是「请把这条从表里删掉」。
 */
export function staleTypeEntries(
  counts: ReadonlyMap<string, number>,
  baseline: readonly TypeBaselineEntry[] = TYPE_BASELINE,
): string[] {
  return baseline
    .filter((b) => (counts.get(b.dir) ?? 0) === 0)
    .map((b) => b.dir);
}

/** 类型错行的形状：`test/arch/x.test.ts(12,5): error TS2322: …`。 */
const DIAG = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/u;

/** tsc 原始 stdout（已合并 stderr）的解析结果。 */
export interface TscRun {
  readonly exitCode: number;
  /** 解析出来的类型错，路径已归一成「仓库根相对 + posix」。 */
  readonly errors: TypeErrorLike[];
  /** 匹配 `file(line,col): error TSxxxx:` 但【没能】解析成结构化的行数。 */
  readonly unparsed: number;
  /** `--listFilesOnly` 报出的 .ts 文件数（反「glob 被改窄 ⇒ 空语料自证通过」）。 */
  readonly filesChecked: number;
  /** 尾 1200 字，红的时候给人看。 */
  readonly tail: string;
}

/**
 * 把 tsc 的相对路径归到「仓库根相对 + posix」。
 *
 * 三种形状是实测出来的：相对调用目录（`test/arch/x.ts`）、相对根（`../…`）、
 * 以及绝对路径（`D:\item\opc\test\…`，Windows 上 tsc 对 project 外的文件会给绝对）。
 * 归一化不是风格问题：配额表按目录分组，`packages/hub/test/db` 和
 * `D:/item/opc/packages/hub/test/db` 会被数成两个目录，而第二个不在配额里
 * ⇒ 一条「基线外的新目录」假红。
 */
export function toRepoRelative(raw: string, root: string): string {
  let p = raw.split("\\").join("/");
  const r = root.split("\\").join("/").replace(/\/+$/u, "");
  // 盘符大小写在 Windows 上两种都会出现（D:/ 与 d:/）。
  if (p.toLowerCase() === r.toLowerCase() + "/") return "";
  if (p.toLowerCase().startsWith(r.toLowerCase() + "/")) {
    p = p.slice(r.length + 1);
  }
  while (p.startsWith("../")) p = p.slice(3);
  return p.replace(/^\.\//u, "");
}

/**
 * 解析 tsc 的整段输出。
 *
 * 结构化的那一型是 `file(line,col): error TSxxxx:`。另有一型【不带文件位置】的
 * 全局诊断（TS18003「config 没匹配到任何输入」、TS5083「读不到 config」），它们
 * 不能归进任何目录，但【必须计数】—— 否则「include 一个文件都没命中」会被读成
 * 「0 条类型错 ⇒ 绿」，而它真实的意思是「什么都没扫」。
 * 诊断的续行（`  Type 'undefined' is not assignable ...`）以空白开头，两型都不匹配，
 * 直接跳过 —— 它们不是新的一发错。
 *
 * ⚠ 仓外路径【保留原形状进 errors】，不折进仓内目录（round300）。两种形状在这儿
 * 汇成同一个读数：绝对式由 `toRepoRelative` 原样退回（`E:/other/repo/pkg/x.ts`），
 * `../` 式由这里【不剥前缀】地留下（`../other-repo/pkg/x.ts`）。两者都不是本仓的目录
 * ⇒ `diffTypeBaseline` 报「基线外的测试目录」并点名 ⇒ 红。
 * 为什么红着而不是丢掉：这条错是【真的】，它说的是「这个 project 吃进了仓外的文件」。
 * 丢掉它就把一次 include 事故读成「那些文件没有类型错」⇒ 绿 —— 正是这里要堵的方向。
 * 与 `parseListFiles` 的处置【相反】（那边仓外【不计】），也不矛盾：那边数的是
 * 「本仓的语料有多少」，把外来的算进来会让下限替本仓作证；这边问的是「谁有类型错」，
 * 外来的有类型错正是要人来看一眼的事。round296 对绝对式就是这个分工，
 * round300 只是把 `../` 式接回同一条口径。
 */
export function parseTscOutput(
  output: string,
  root: string,
): { errors: TypeErrorLike[]; unparsed: number } {
  const errors: TypeErrorLike[] = [];
  let unparsed = 0;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd();
    if (!/^(?:\S.*?: )?error TS\d+:/u.test(line)) continue;
    const m = DIAG.exec(line);
    if (m === null) {
      unparsed++;
      continue;
    }
    const raw = (m[1] as string).split("\\").join("/");
    // 往上跳的那一条【不交给 toRepoRelative】—— 它会把前缀整段抹掉，
    // 于是仓外文件领走一个已登记目录的配额。见 `escapesUpward`。
    const file = escapesUpward(raw)
      ? raw
      : toRepoRelative(m[1] as string, root);
    if (file === "") {
      unparsed++;
      continue;
    }
    errors.push({ file, code: m[4] as string });
  }
  return { errors, unparsed };
}

/**
 * 归一之后【仍然是绝对路径】吗 —— 也就是「这条不在仓内」。
 *
 * ⚠ 这一发是 round296 补的，起因是 `parseListFiles` 的注释一直写着
 * 「不在仓内的绝对路径也排除」而实现【只排掉了一半】：`toRepoRelative` 落在仓外时
 * 原样退回，unix 式退回成 `/some/where/x.ts`（有前导斜杠 ⇒ 旧判据抓得到），
 * windows 式退回成 `E:/other/repo/x.ts`（【没有】前导斜杠 ⇒ 旧判据抓不到，直接计进
 * 「本仓语料」）。本机就是 windows 式，所以漏的正是这里天天在用的那一型。
 * 危害方向是【绿】：`filesChecked` 被仓外文件灌水 ⇒ include 真被改窄时下限仍够 ⇒
 * 与 r19 守着的那一族（少报在棘轮上是绿的方向）同一个形状。
 */
function isStillAbsolute(rel: string): boolean {
  return rel.startsWith("/") || /^[A-Za-z]:\//u.test(rel);
}

/**
 * 归一之前【往上跳】吗 —— 也就是 `../…` 那一型。
 *
 * 只能在【归一之前】看见：`toRepoRelative` 的 `while (p.startsWith("../"))` 会把
 * 前缀整段抹掉，`../packages/hub/test/engine/x.ts` 出来是一条地道的仓内路径。
 * 所以这条判据读 raw，`isStillAbsolute` 读归一后的结果 —— 不是两种风格，是
 * 两种形状各自只在某一侧留痕：仓内绝对路径（`/d/item/opc/test/x.ts`）归一后
 * 盘符/前导斜杠已经没了 ⇒ 判据必须读结果，读 raw 会把 unix checkout 的【仓内】
 * 绝对路径整个错排掉；`../` 反过来只在 raw 上留痕。
 */
function escapesUpward(raw: string): boolean {
  const p = raw.split("\\").join("/");
  return p === ".." || p.startsWith("../");
}

/**
 * 这条【不在本仓】吗 —— 三种形状合并成一个定义。
 *
 * ⚠ 共用的是【定义】，不是【处置】：`parseListFiles` 拿它【排除】（那边数的是
 * 「本仓语料有多少」，外来的算进来会让下限替本仓作证）；`parseTscOutput` 反过来
 * 【保留】仓外那几条，只借用 `escapesUpward` 那一半阻止前缀被抹掉（那边问的是
 * 「谁有类型错」，外来的有类型错正是要人来看一眼的事）。两处口径相反是故意的，
 * 见 `parseTscOutput` 的注释 —— 但「什么叫仓外」只许有一个答案，所以判据只有这一处。
 *
 * round300 补的是 `../` 那一型，而它的方向与 round296 那一发【相反】：
 * 绝对式落在仓外是【红】的（带盘符的目录名进配额表 ⇒ 报「基线外的测试目录」，
 * 难看但看得见）；`../` 式落在仓外是【绿】的 —— 抹掉前缀之后它就落进一个
 * 【已登记的目录】里，于是那几条错【花掉的是本仓那个目录的配额】。
 * 实测（round300，`.workbuddy/probe300-fold.ts`）：把 TYPE_BASELINE 每一格按
 * `../<该格目录>/xN.ts` 灌满 ⇒ 归一出 291 条、`diffTypeBaseline` 返回空字符串。
 * 也就是一次「include 指向了隔壁仓」的事故会【逐字读出本仓的配额表并宣布合格】。
 * 同一个形状在 `parseListFiles` 那边给 `filesChecked` 灌水 ⇒ 0006 §7 第 41 条
 * 那条「语料被改窄」的哨兵会被仓外文件替本仓作证。两处都是【绿】的方向。
 *
 * 误判方向：真把人家的仓内路径判成仓外 ⇒ `parseTscOutput` 记一条 `unparsed`
 * （哨兵 2 当场红，且红话带尾 1200 字）⇒ 是【看得见】的那一侧；而漏判是
 * 读空字符串。不对称在这里，所以这一条宁可判宽。
 * 登记的残留：`test/../other/x.ts` 那种【中间】带 `..` 的混合写法不在射程内
 * （它归不归得对取决于前缀，且不是 tsc 会输出的形状）。
 */
function isOutsideRepo(raw: string, rel: string): boolean {
  return isStillAbsolute(rel) || escapesUpward(raw);
}

/**
 * 解析 `--listFilesOnly` 的输出，数出【本仓自己的】.ts 文件。
 *
 * 口径只有一条排除：`node_modules`。lib 的 `lib.dom.d.ts` 那一批就在
 * `node_modules/typescript/lib/` 下，所以这一条同时把它们挡掉了；剩下的就是
 * 这次检查真正吃进去的语料。不在仓内的路径也排除（跨仓 project 引用不属本守卫）
 * —— 见 `isOutsideRepo`：那条「注释里写了而实现只做一半」的病在 round296 犯过一次
 * （绝对式只排掉了 unix 那一半），round300 又在同一条口径的第二半上量到一次
 * （`../` 式整个被 `toRepoRelative` 洗成仓内路径 ⇒ 给语料灌水）。
 * 不用「必须以 test/ 或 packages/ 开头」那种前缀白名单：那种写法只对根 project 成立，
 * 拿它去量另一个 project 会恒 0，而恒 0 看起来正是「include 被改窄」想要报的形状。
 */
export function parseListFiles(output: string, root: string): number {
  let n = 0;
  for (const rawLine of output.split(/\r?\n/u)) {
    const raw = rawLine.trim().split("\\").join("/");
    const rel = toRepoRelative(raw, root);
    if (rel === "" || isOutsideRepo(raw, rel) || !rel.endsWith(".ts")) continue;
    if (rel.split("/").includes("node_modules")) continue;
    n++;
  }
  return n;
}

/**
 * 平台二进制定位：pnpm 的符号链接在 Windows 上要用 node.exe 起，
 * 直接 spawnSync 那个 .cmd shim 会 EINVAL / 权限失败。
 */
export function findTscCli(root: string): string {
  const pnpmRoot = join(root, "node_modules", ".pnpm");
  if (existsSync(pnpmRoot)) {
    for (const dir of readdirSync(pnpmRoot)) {
      if (!dir.startsWith("typescript@")) continue;
      const cand = join(
        pnpmRoot,
        dir,
        "node_modules",
        "typescript",
        "bin",
        "tsc",
      );
      if (existsSync(cand)) return cand;
    }
  }
  const flat = join(root, "node_modules", "typescript", "bin", "tsc");
  if (existsSync(flat)) return flat;
  throw new Error(
    "找不到 typescript 的 tsc CLI。宁可直接抛错，也不要空跑成「0 条错」的假通过。",
  );
}

/**
 * 本守卫自己所在的仓（`test/arch/` 退两层）。
 *
 * 为什么 tsc 的位置【不跟着被扫的那个 project 走】：.test.ts 里有一发要在临时目录
 * 里现造一个小 project（量「一个语法错会不会关掉整个检查」），那个目录没有
 * `node_modules`，从它下面找 tsc 必然抛。⇒ 二进制永远取自本仓，
 * 只有【路径归一】用调用方给的 root。
 */
const OWN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface RunOptions {
  /** tsc 的工作目录（相对 tsconfig 与相对输出路径都以它为基准）。 */
  readonly cwd: string;
  /** 相对 cwd 或绝对的 tsconfig 路径。 */
  readonly tsconfig: string;
  /** 把输出里的路径归一到「谁相对谁」。省略 = cwd。 */
  readonly root?: string;
}

/**
 * 真跑一次类型检查。反假绿三条：拿不到任何输出 / 一个文件都没检查 /
 * 有匹配行解析不出来 ⇒ 在 .test.ts 里红，不在这里红（这里只负责把事实交出去）。
 */
export function runTypeCheck(o: RunOptions): TscRun {
  const tsc = findTscCli(OWN_ROOT);
  const root = o.root ?? o.cwd;
  const common = {
    cwd: o.cwd,
    encoding: "utf8" as const,
    timeout: 600_000,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
  };
  const check = spawnSync(
    process.execPath,
    [tsc, "-p", o.tsconfig, "--noEmit"],
    common,
  );
  const listed = spawnSync(
    process.execPath,
    [tsc, "-p", o.tsconfig, "--noEmit", "--listFilesOnly"],
    common,
  );
  if (check.error) throw new Error("tsc 调用失败：" + check.error.message);
  const stdout = String(check.stdout ?? "");
  const stderr = String(check.stderr ?? "");
  const merged = stdout + (stderr.trim() === "" ? "" : "\n" + stderr);
  // ⚠ 这段的判定随 B5 翻了一面。立它的时候语料恒有 291 条错，tsc【必然】有输出，
  // 所以「空输出」只可能意味着 tsc 没真正跑 ⇒ 一律当故障抛。B5 把语料清到 0 错、
  // 并加了一份 0 错硬门（根 tsconfig.test.json）之后，「空输出」第一次有了一种
  // 合法读法：检查真的跑了、一条错都没有。于是按【退出码】分两支：
  //   · 空 + exit 0 ⇒ 真干净，读成 0 条错（不再是故障）；
  //   · 空 + 非零 exit ⇒ tsc 崩了/没跑起来，照样抛 —— 那是真故障。
  // 判「干净」靠的是退出码不是输出：`--noEmit` 下 tsc 0 错就是静默成功，
  // 输出里【没有】"Found 0 errors" 那句（实测），所以不能用「有没有输出」当判据。
  if (merged.trim() === "" && (check.status ?? 1) !== 0) {
    throw new Error(
      "tsc 一句输出都没有（退出码 " +
        check.status +
        "，非零）。空输出 + 非零退出 = tsc 没跑起来，这里不当它是干净。",
    );
  }
  const parsed = parseTscOutput(merged, root);
  return {
    exitCode: check.status ?? -1,
    errors: parsed.errors,
    unparsed: parsed.unparsed,
    filesChecked: parseListFiles(String(listed.stdout ?? ""), root),
    tail: merged.slice(-1200),
  };
}
