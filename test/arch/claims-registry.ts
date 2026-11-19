/**
 * 主张登记表：把文档与关键注释里所有「零 X」类断言抽成结构化条目。
 *
 * O14 动作 2（docs/OPC-OS-功能优化设计.md §O14）：文档里的「X 零调用方 /
 * 没有 X / 没有任何代码能写 X」这一类句子，要么机器可判，要么从文档里消失。
 * dead-modules.ts（零调用方）与 zero-producer.ts（零写入方）已经各自守了一族，
 * 但【散在 docs/ 里的主张】没有覆盖：那个文档不是 src，zero-producer 的取材
 * 不含 docs；dead-modules 的 claimSites 只做【位置报告】，不校验主张真伪。
 * 本表是【另一层】：登记表在 test/arch/ 下当数据，守卫校验每条都有判据、
 * 且判据对今天的仓库成立。
 *
 * ── 家规怎么落在这里 ────────────────────────────────────────────
 * docs/review/README.md 的家规原文：入口文档里不写会漂移的数。所以
 * docs/OPC-OS-功能优化设计.md 渲染的是【判据 + 上次核对时刻】，不渲染条数。
 * 条数由测试钉下限；渲染出的表只有判据与方法列，没有计数列。
 *
 * ── 为什么每条带一个可注入的判据（Files 参数）而不是一把共享扫描器 ──
 * 各条主张的判据形状各不相同（SQL 值字面量 / 调用方 / import 边 / 事件发布点 /
 * 另一守卫的登记表），硬拗成统一接口会把八种口径互相拉低。判据全是纯函数：
 * 吃（files: FilesReader）返回人话 —— 于是变异测试能喂合成语料而不碰磁盘，
 * 这正是 zero-producer 的「判据纯化，取材留在调用方」分工。
 *
 * ── 双向的另一半（登记了、判据没了）靠什么 ───────────────────────
 * 每条的 method 指名守卫测试名或探测命令。本表的三条（r5/r6/r7/r8）的 claim
 * 指向既有守卫的登记表/基线，判据是【去那张表里找对应档案还在不在】——
 * 守卫把那条主张照管起来之后，它若被从守卫的登记表里悄悄摘掉，这里当场红。
 *
 * ── 反向（文档里新出现一句『零 X』而没人登记）为什么不做全量自动判 ──
 * 那需要自然语言识别「这一句是不是『零 X』类断言」，而零-producer 那套
 * ZERO_CLAIM_RE 只扫 src、不覆盖 docs（docs 里「没有 X」四种写法 + 引号引用 +
 * 历史时态 + 否定句式混在一起，测过一个词表在 docs 上要么漏要么误报）。
 * 诚实的选择：不装一条【恒假或恒空】的假守卫。替代机制是 —— 每新增一句
 * 『零 X』主张，唯一的正道是来这里登记（r1 起每一条都是这么来的）；登记后它被
 * 判据与既有守卫一起照管。正文顺带把「文档里没登记的新主张」这件事在
 * .workbuddy/AUDIT-LEDGER.txt 里留了明确缺口声明，供下次核对时刻复查。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeFixture } from "./run-fixtures.js";

/** 仓库根：本文件在 <root>/test/arch/ 下。 */
export function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** 判据要的读文件能力。纯判据不碰盘；真仓库的 FilesReader 在这里实现，合成的写在测试里。 */
export interface Files {
  /** 读一个 src 相对文件；文件不存在抛错。 */
  src(name: string): string;
  /** 读 test/arch 下一个文件。 */
  arch(name: string): string;
  /**
   * 读 packages/hub 下【测试侧】的一个文件（`test/acceptance/….test.ts`）。
   *
   * ⚠ 它【存在】的唯一理由：r15 那条主张的内容就是「某个验收测试在场且仍在判某件事」，
   * 而 `src()` 只到 `packages/hub/src`、`arch()` 只到 `test/arch` —— 没有这一格，
   * 那条判据要么读不到自己要读的文件（恒红），要么退回去 grep 整个仓库（恒宽）。
   * 别把它当通用能力扩展：需要新前缀先想清楚判据是不是该换个口径。
   */
  hubTest(name: string): string;
  /**
   * 读 `packages/hub/resources/migrations/<name>` 一份迁移。
   *
   * ⚠ 为 r17 加的，理由与 `hubTest` 同一条：那条主张的内容是「台账那张表的
   * 【幂等键】是 (approval_id, channel_id)」，而那句话的权威落点在迁移 SQL 里 ——
   * `src()` 到不了 `resources/`，把它抄一份进 ts 就是又造一份手抄（本仓治过的那一族）。
   * 别拿它遍历迁移目录：需要"全部迁移"的口径属于 doc-ids / zero-producer 那两类守卫。
   */
  migration(name: string): string;
  /**
   * 读 `packages/contracts/src/<name>` 一份契约源码。
   *
   * ⚠ 为 r22 加的，理由与 `hubTest` / `migration` 同一条：那条主张的内容是
   * 「`orgChangeSchema` 有三种 kind，而 hub 的提交路径对每一种都【真调了一条判据】」，
   * 那句话的权威落点在 contracts 的 schema 与 validate 里 —— `src()` 只到
   * `packages/hub/src`，把 kind 名单抄一份进判据就是又造一份手抄（本仓治过的那一族：
   * 手抄的那份会在真那份改动后继续绿着）。
   * 别拿它遍历包目录：需要"整个 contracts 包"的口径属于 doc-refs 那类守卫。
   */
  contracts(name: string): string;
  /**
   * 递归数一个源码根下带某扩展名的文件数。给 r15 的【非空前提】用：
   * 「前端里 `add_edge` 零出现」这条，在取材读不到任何文件时会恒绿，而它读起来
   * 与「前端真的不发组织变更」逐字一样（本仓反复登记的那一族：否定式读数先怀疑问的位置）。
   */
  countFiles(dir: string, exts: readonly string[]): number;
  /** src 下全部非 poc、非 .test.ts 的相对路径（posix，含目录）。 */
  allSrc(): string[];
}

/** 真仓库 FilesReader。 */
export const realFiles: Files = {
  src(name: string): string {
    return readFileSync(
      join(repoRoot(), "packages", "hub", "src", name),
      "utf8",
    );
  },
  arch(name: string): string {
    return readFileSync(join(repoRoot(), "test", "arch", name), "utf8");
  },
  hubTest(name: string): string {
    return readFileSync(
      join(repoRoot(), "packages", "hub", "test", name),
      "utf8",
    );
  },
  migration(name: string): string {
    return readFileSync(
      join(repoRoot(), "packages", "hub", "resources", "migrations", name),
      "utf8",
    );
  },
  contracts(name: string): string {
    return readFileSync(
      join(repoRoot(), "packages", "contracts", "src", name),
      "utf8",
    );
  },
  countFiles(dir: string, exts: readonly string[]): number {
    const base = join(repoRoot(), dir);
    let n = 0;
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name === "node_modules" || e.name === "dist") continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (exts.some((x) => e.name.endsWith(x))) n += 1;
      }
    };
    walk(base);
    return n;
  },
  allSrc(): string[] {
    return listHubSrc(repoRoot());
  },
};

/**
 * packages/hub/src 下全部非 poc、非 .test.ts 的相对路径。
 *
 * 从 realFiles.allSrc 里单独拆出来只有一个理由：让【排除运行期夹具】这一格可测。
 * 挂在 realFiles 上就只能对真仓库读数，而真仓库里那个探针【平时不存在】——
 * 于是「有没有排除」在正常跑的时候永远是绿的，只有撞上下一个并发测试才偶发红。
 * 拆出 root 参数后，探针清单守卫拿一棵临时树就能【当场造出那个探针】并验证它没被列出。
 */
export function listHubSrc(root: string): string[] {
  const out: string[] = [];
  const base = join(root, "packages", "hub", "src");
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "poc") continue;
      // 运行期夹具随时会消失：不排掉就是随机红（同 run-fixtures.ts 文件头）。
      if (!e.isDirectory() && isRuntimeFixture(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + "/");
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) {
        out.push(rel + e.name);
      }
    }
  };
  walk(base, "");
  return out.sort();
}

/** 一条主张的出处（文档 + 行号 + 原文）。行号只在报错时用；渲染只放判据与核对时刻。 */
export interface ClaimSource {
  readonly doc: string;
  readonly line: number;
  readonly sentence: string;
}

/** 一条登记。 */
export interface RegistryEntry {
  readonly id: string;
  /** 主张（散文，不是数）。 */
  readonly claim: string;
  /** 判它的方法：守卫测试名 / 探测命令。 */
  readonly method: string;
  /**
   * 属哪一族：指向 test/arch/ 下那个判据的归属。
   *
   * ⚠ 这一格【曾经漂移过】，而且是【没有任何一道门禁看得见】的那种漂移：
   * r10 / r11 / r12 三条分别写了 "lint-baseline" / "plan-refs" / "plan-gate-paths"，
   * 而这个联合类型从建立起就没加过它们 ⇒ 三处类型错。它们活着的原因不是设计，
   * 是 `tsc -b` 只 include 了各包的 src 目录，`test/` 整体不在类型检查范围内
   * （复算：`npx tsc -p .workbuddy/tsconfig.tests.json` 报 test/arch 下 10 条，
   * 其中这 3 条就是这里）。所以名单在下面补齐 —— 补的是【已经发生的】，不是【预留的】：
   * 以后再加一族还是要改这里，而那一改会被那份 probe 报出来，不会再靠人想起来。
   */
  readonly judge:
    | "zero-producer"
    | "dead-modules"
    | "stub-terminal-write"
    | "claims-registry"
    | "lint-baseline"
    | "plan-refs"
    | "plan-gate-paths"
    | "role-spawn-boundary"
    | "claim-coords"
    | "test-type-baseline";
  /** 上次核对时刻（ISO，YYYY-MM-DD）。家规：这是时刻，不是条数。 */
  readonly checkedAt: string;
  readonly source: ClaimSource;
  /** 判据（纯函数，吃 Files）；成立返回 ""，不成立返回人话。 */
  readonly check: (f: Files) => string;
}

/* ═════════════════════ 逐条判据（纯函数）═════════════════════ */

/**
 * r1：budgets.hard_stop 写不出 0 —— 除了【登记过的那一处】显式软限入口。
 *
 * ⚠ 【round272：取材从写死三个文件改成全 src 扫】。原来那份写死了
 * `["budget/tracker.ts","charter/budget-sync.ts","engine/runtime.ts"]`，而 runtime 那份
 * 手抄 SQL 本轮删了 —— 写死的名单于是【指向一个不存在的 SQL】，判据本身差点变成
 * 「读一个不含这条 SQL 的文件然后什么都扫不到」。更糟的形状是：以后再有第四处 INSERT
 * 长在名单外的文件里，这条判据【恒绿】而主张读起来仍然成立。
 * ⚠ 条数【不在这里判】，判在同文件的「真仓库取材非空」那一发里（合成夹具只放一条语句，
 * 把条数下限写进 check 会让变异样本自己撞上它，红因从「写成 0」变成「条数不够」= 一次混两种故障）。
 *
 * ── round308 改了主张本身，不只是改判据 ─────────────────────────
 * 原文「没有任何代码能把它写成 0」已被源码否证：POST /budget 的 upsert
 * （http/budget.ts）把 hard_stop 作【绑定参数】写，界面那个「硬停」勾选框
 * 取消勾选 ⇒ 那一格就是 0。这是【设计上要有】的入口（CEO 显式把硬停改成软限），
 * 所以不能靠删功能让旧主张重新成立，只能把主张改成「记账路径写不出 0，
 * 写 0 只有登记过的这一处」，并让判据钉住「名单外没有第二处绑参写点」。
 * 旧文不消：登记表 source 里那句原文与它来自哪一行原样留着。
 *
 * 四条规则（一条判据一次只报一种故障）：
 *  A 字面量 0 ⇒ 红，任何文件（原主张那一半，逐字未动）；
 *  B hard_stop 那一格是【绑定参数】⇒ 该文件必须在名单里，否则红并点名它；
 *  C 名单里的文件必须【逐字含】它登记时那份形状 —— 否则名单会变成假证人
 *    （那处入口哪天被删掉，名单要当场红，而不是继续替一个不存在的功能担保）；
 *  D 名单外的文件里出现 `DO UPDATE ... hard_stop =` ⇒ 红（upsert 悄悄改停法，
 *    与 A 同一件事的另一半：改一条已有行比新建一行更没人看得见）。
 */
/**
 * 名单：允许 hard_stop 走【绑定参数】的写点 → 登记时逐字在场的形状片段。
 * 逐片段 includes 而不是拼成整段匹配：源码里那份 SQL 是跨行字符串拼接，
 * 拼成整段会被格式化重排打掉 —— C 规则抓的是【语义形状变了】，不该红在一次排版上。
 */
const HARD_STOP_BIND_WHITELIST: ReadonlyMap<string, readonly string[]> =
  new Map([
    [
      "http/budget.ts",
      [
        "VALUES (?, ?, ?, ?, ?, 0, ?) ",
        "DO UPDATE SET limit_cents = excluded.limit_cents, hard_stop = excluded.hard_stop",
      ],
    ],
  ]);

/**
 * 判序【必须】是 A→B→C→D，一条判据一次只报一种故障（round308 变异之六量出来的：
 * 第一版把 C 放在最前，于是「名单内那处把 hard_stop 改成字面量 0」报的是
 * 「名单失效」—— 那是真话但不是【最坏的那句真话】，读的人会去修名单而不是去掉那个 0）。
 * A 字面量 0（最严重，无条件下先扫）→ B 名单外的绑参写点 → C 名单形状漂移 →
 * D 名单外的 upsert 改停法。
 * ⚠ C 只对【在 allSrc() 里的】名单文件生效：判据不吃「文件整个不见了」这种输入
 * （`src()` 缺键会抛，而合成夹具少给一个键与「文件真没了」在判据里逐字一样 ——
 * fakeFiles 上面那段注释记过这一族）。删掉 http/budget.ts 由同文件那条【条数=4】
 * 的真仓库取材那一发抓，归因不同、各管各的。
 */
function hardStopZeroCheck(f: Files): string {
  const stmts: { name: string; full: string; v: string }[] = [];
  for (const name of f.allSrc()) {
    const text = f.src(name);
    if (!text.includes("INSERT INTO budgets")) continue;
    for (const m of text.matchAll(
      /INSERT\s+INTO\s+budgets[^;]*?VALUES\s*\((.*?)\)/gs,
    )) {
      // 只看有 hard_stop 列的 INSERT 形状：列序第七位，VALUES 第七位。
      if (!m[0].includes("hard_stop")) continue;
      const parts = ((m[1] ?? "").split(",")[6] ?? "").replace(/\s/g, "");
      stmts.push({ name, full: m[0], v: parts });
    }
  }
  // A
  for (const s of stmts) {
    if (s.v === "0")
      return "budgets.hard_stop 有代码能写成 0：" + s.full.slice(0, 80);
  }
  // B
  for (const s of stmts) {
    if (s.v !== "1" && !HARD_STOP_BIND_WHITELIST.has(s.name)) {
      return (
        "budgets.hard_stop 多了一处【绑定参数】写点 " +
        s.name +
        "（值是调用方给的，判据看不见它会不会是 0）。" +
        "要么改成字面量，要么把它加进 HARD_STOP_BIND_WHITELIST 并说清" +
        "为什么这一处写 0 是【设计要有】的。"
      );
    }
  }
  for (const name of f.allSrc()) {
    const text = f.src(name);
    // C
    const pinned = HARD_STOP_BIND_WHITELIST.get(name);
    if (pinned !== undefined) {
      for (const frag of pinned) {
        if (!text.includes(frag)) {
          return (
            "r1 名单失效：" +
            name +
            " 登记的 hard_stop 写点形状里这一段今天不在了 [" +
            frag +
            "] —— 那一处入口被改掉或删除了，请把名单与主张一起改，别留着当假证人。"
          );
        }
      }
    }
    // D
    if (pinned === undefined && text.includes("INSERT INTO budgets")) {
      if (/DO UPDATE[^;]{0,400}hard_stop\s*=/.test(text)) {
        return (
          "budgets 的 upsert 在 " +
          name +
          " 里改写 hard_stop，而这一处没登记：改一条已有行比新建一行更没人看得见。" +
          "（名单见 HARD_STOP_BIND_WHITELIST）"
        );
      }
    }
  }
  return hardStopReaderCheck(f);
}

/**
 * r1 的【读侧】那一半（2026-11-19）：`underTaskBudgetSql` 现在真读 `hard_stop`。
 *
 * ⚠ 这一半和 A–D 是【反着】的两格，读的人容易把它们读成互相矛盾：
 * A–D 判「除了登记的那一处，谁都写不出 0」，E 判「写得出 0 的那一处【有人在看】」。
 * 两句同时成立才叫开关 —— 写得出一列而没人读，那一列是装饰；有人读而写不出，那是恒真判据。
 * 本篇 §2 轴二那一格的原话就是这两件事中间隔着的东西。
 *
 * E1 判【读侧的字节在代码里】（剥注释：那一段函数头有整段在解释「为什么故意不看它」，
 * 判原文会让一句诚实的历史注释替「读了」投一票 —— 正是 r23/r24 立的口径）。
 * E2 判【最外层那层括号还在】。为什么不只在测试里判：
 *  ① 它是【行为级】判据，已经由 packages/hub/test/budget/hard-stop-gate.test.ts 那条
 *     IN_REVIEW + hard_stop=0 不发候选钉住了（全仓唯一看得见摘括号的那一发，
 *     由 .workbuddy/round309-mutate-hard-stop.mjs 的 M3 实测：摘掉它【只有那一发】红）；
 *  ② 这里再钉一次字节，是因为那一发在【测试文件】里，而测试文件可以被整份删掉；
 *     登记表这一格删不掉，它保证「那条行为测试防的东西」在主张层面也不许悄悄回来。
 * ⚠ 射程：E2 是【字节近似】，不是语义等价。把括号加到调用点上（让五个使用点全都
 * `AND ( <谓词> )`）会让 E2 红而那是对的写法 —— 那种情形下改这一格，别改成恒真。
 */
function hardStopReaderCheck(f: Files): string {
  let pump: string;
  try {
    pump = f.src("serve/charter-pump.ts");
  } catch {
    return (
      "packages/hub/src/serve/charter-pump.ts 不在了 —— 那道花钱的门连同它的读方一起没了，" +
      "「hard_stop 有读者」这一半主张失去执行者"
    );
  }
  const code = withoutComments(pump);
  if (!code.includes("SELECT b.hard_stop FROM budgets b ")) {
    return (
      "underTaskBudgetSql 不再读 budgets.hard_stop —— 那一列退回【写得出一句硬停而没人看】，" +
      "而 http/budget.ts 那个勾选框今天还在：界面上取消勾选【什么都不改变】，" +
      "比恒 1 更坏（恒 1 至少没人以为它能关）"
    );
  }
  if (!code.includes("), 1) = 0)")) {
    return (
      "读侧那半条的收尾字节 `, 1) = 0)` 不在了 —— 要么判据方向翻了（= 1 变成放行），" +
      "要么那层【最外层括号】被摘了。后者是本仓抓过的那族：五个使用点里两个裸拼，" +
      "SQLite 里 AND 比 OR 紧，摘括号把整条 WHERE 劈成「(状态 ∧ 卡 ∧ 钱) ∨ (hard_stop = 0)」" +
      "⇒ 任何 hard_stop = 0 的格子里【连状态都不判】就进候选"
    );
  }
  return "";
}

/**
 * r2：超时执行者【已接进】心跳巡检 —— serve/assemble.ts 的每一跳都调 runTimeoutPass。
 *
 * 这条登记的三次改史（0026 §4「主张随事实改，原文不消」在这里的完整落点）：
 * · 初版（round263）：「timeout_at 无执行者」，判据扫 UPDATE/DELETE approvals 含
 *   timeout_at。round265 造出执行者后它【没红而主张已假】（执行者 SELECT 读超时、
 *   UPDATE 不写 timeout_at，字面恒绿）——静默失效，见 round265 台账。
 * · 二版（round265）：「有执行者、零生产调用方」，judge 归 dead-modules 基线。
 *   基线格在 round268 接线那天如约变红 —— 那是它设计出来的死法。
 * · 今版（round268 接线后）：主张翻向【接线必须在场】。判据反向：assemble.ts 的
 *   心跳 job 里找不到 runTimeoutPass ⇒ 红。方向变了的原因：前两个方向守的都是
 *   「别谎报有」，接线之后该守的是「别悄悄退回去」——拔掉一根线比造一个模块便宜，
 *   而拔掉之后「到期什么都不发生」会静默复活，正是 §1.3 那三条过期主张的形状。
 */
function timeoutWiredCheck(f: Files): string {
  return f.src("serve/assemble.ts").includes("runTimeoutPass(")
    ? ""
    : "serve/assemble.ts 里不再调用 runTimeoutPass( —— 心跳的超时接线被拔掉了，" +
        "「到期什么都不发生」正在静默复活";
}

/**
 * r3：`makeChannelActorResolver` 那位【读者】还在 —— channels/approval-bridge.ts。
 *
 * 这条登记的两次改史（与 r2 同一个剧本，0026 §4「主张随事实改，原文不消」）：
 * · 初版（round277）：「零生产调用方」，判据扫 src 除定义文件外的调用 ⇒ 出现即红。
 *   它守的是「别谎报这座桥接上了」。round280 桥落地那天它如约变红 —— 那是它设计出来的死法。
 * · 今版（round280）：主张翻向【那位读者必须在场】。方向变了是因为该守的东西变了：
 *   接线之前怕的是谎报有，接线之后怕的是悄悄退回去。而这一格退回去的代价比 r2 那一格大 ——
 *   拔掉 `actorFor` 不是「少一个功能」，是所有入站回信一起回到未授权，
 *   而那条症状（手机上点了没反应）与「没接 IM」在用户侧长得一模一样。
 * 判据不吃定义文件（`bindings/im.ts` 自己那行 export 不算读者）。
 */
function resolverWiredCheck(f: Files): string {
  let bridge: string;
  try {
    bridge = f.src("channels/approval-bridge.ts");
  } catch {
    return (
      "channels/approval-bridge.ts 不在了 —— IM 决策那条链的装配点没了，" +
      "`makeChannelActorResolver` 重新变成「一个答案而没有读者」，" +
      "而 O12 那句端到端验收（acceptance/im-reply-approves-card.test.ts）会整条红"
    );
  }
  if (!bridge.includes("makeChannelActorResolver(")) {
    return (
      "channels/approval-bridge.ts 里不再调用 makeChannelActorResolver( —— " +
      "`actorFor` 那一格被换掉了。换成什么都会开出冒充通道：" +
      "`im_bindings` 是 `ceo_role DEFAULT 'ceo'` + `verified DEFAULT 0`，" +
      "不经 resolveBinding 的读法等于「有人插过一行绑定的账号默认就是 CEO」"
    );
  }
  return "";
}

/**
 * r16：一次带合法签名的 IM 回信【真的】落成一次决策，且审计行署的是绑定的那个角色。
 *
 * 这就是 O12 正文那句验收句。判据的形状与 r15 同族（核「验收测试在场 + 关键断言对象还在」），
 * 而它比 r15 多核两格【生产代码】—— 理由：O12 这条主张的主语是那条链，
 * 只核测试的话，把桥里的角色读取或不可逆那一遍摘掉，登记表照绿
 * （本仓反复治的那一族：守卫核的是证据在不在，不是被证的东西还在不在）。
 *
 * 五格各自防的失效：
 *  ① 验收测试整份不见 ⇒ 那句端到端重新变回一句散文（本篇一路在治的那一格）。
 *  ② 反空转那一格被摘掉（未验证绑定的那一发）⇒ 剩下几发照样全绿，
 *     而「不看 verified 的 actorFor」正是一条【能批准的冒充通道】且全绿。
 *  ③ actor 那三条断言（等于绑定角色 / 不是 system / 不是 ceo）少任何一条 ⇒ 红且红因不串。
 *     验收句原文只写了「不是 system」，而两条生产决策路径写的都是 `ceo`
 *     —— 只留「不是 system」的测试对「照抄 ceo」是绿的，那正是这条主张要防的写法。
 *  ④ 桥不再重查角色（`roleOf` 拔掉）⇒ 红。「撤权当场生效」那一格唯一的落点就是这次重查。
 *  ⑤ 桥落库前不再判不可逆 ⇒ 红。O11 那条「不可逆不许在 IM 批」今天有两道门，
 *     抽掉【落库点】这一道，防线就全寄在「调用方先过了 handleOne」上 ——
 *     而 `act` 是导出函数，装配方可直调。
 */
function imApprovalBridgeCheck(f: Files): string {
  let spec: string;
  try {
    spec = f.hubTest("acceptance/im-reply-approves-card.test.ts");
  } catch {
    return (
      "packages/hub/test/acceptance/im-reply-approves-card.test.ts 不在了 —— " +
      "O12 那句「手机上点一下，卡片真的被决定」重新变成一句散文"
    );
  }
  // ② 反空转：未验证绑定那一发（它比主链路更承重，理由见那文件的文件头）。
  if (
    !spec.includes("await bindPending(") ||
    !spec.includes('toEqual(["unauthorized"])')
  ) {
    return (
      "那发验收测试还在，但【反空转那一格】不见了（pending 绑定 ⇒ unauthorized 那一对）—— " +
      "剩下几发照样全绿，而它们对「不看 verified 的 actorFor」全绿，" +
      "那正是 im_bindings 那两个默认值造出来的冒充通道"
    );
  }
  // ③ actor 三条断言，逐条核（少了哪条就报哪条，红因不串）。
  const actorNeedles: readonly [string, string][] = [
    ['decided?.["actor_id"]).toBe(ROLE', "「actor 等于绑定的那个角色」"],
    [
      'decided?.["actor_id"]).not.toBe("system")',
      "「不是 system」（验收句原文那半）",
    ],
    [
      'decided?.["actor_id"]).not.toBe("ceo")',
      "「不是 ceo」（防照抄 HTTP 那条路）",
    ],
  ];
  for (const [needle, what] of actorNeedles) {
    if (!spec.includes(needle)) {
      return (
        "那发验收测试不再断言 " + what + " —— 剩下的断言对「照抄 ceo」是绿的"
      );
    }
  }
  // ④⑤ 生产代码那一半。
  let bridge: string;
  try {
    bridge = f.src("channels/approval-bridge.ts");
  } catch {
    return "channels/approval-bridge.ts 不在了（同 r3）—— 装配点没了，验收测试会整条红";
  }
  if (!bridge.includes("d.roleOf(req.actor.senderId, req.actor.channelId)")) {
    return (
      "桥不再在【落库那一刻】重查角色 —— 「点击在路上被撤权」那一发失去对象，" +
      "而那是这条链唯一一处撤权当场生效的位置"
    );
  }
  if (!bridge.includes("isIrreversibleApproval(")) {
    return (
      "桥落库前不再判可逆性 —— O11「不可逆不许在 IM 批」剩下的一道门在调用方身上，" +
      "而 act 是导出函数、装配方可直调（APPROVE_CARD_CALLERS 那条登记的凭据就是这一格）"
    );
  }
  /**
   * ⑥ round281/282 之后，这条主张的射程从「桥在不在」扩到「桥接没接上生产入口」。
   *
   * ⚠ 为什么这两格【必须】由本条守着而不是由死模块哨兵守着：`channels/abstraction.ts`
   * 与 `channels/approval-bridge.ts` 的基线条目在 round281 按设计摘除了（模块走得到了），
   * 于是「链断在装配层」从此只剩 `serve/im-channels.test.ts` 一份分母。
   * 那一份文件被删掉时，本守卫是唯一还能红的地方 —— 所以它判的是【文件在场 +
   * 那条最承重的断言在场】，不是判它绿（绿由 vitest 判）。
   */
  let imch: string;
  try {
    imch = f.hubTest("serve/im-channels.test.ts");
  } catch {
    return (
      "packages/hub/test/serve/im-channels.test.ts 不在了 —— 装配层从 round281 起" +
      "【只有这一份分母】（dead-modules 那两条基线已按设计摘除），" +
      "删掉它等于把「env → 通道 → 一轮入站 → 桥 → 库里那一行」重新变回一句散文"
    );
  }
  if (!imch.includes("actorFor")) {
    return (
      "装配层的测试不再提 actorFor —— 0030 §0 那句「那个可选钩子今天没人传」的" +
      "更正失去对象，而「装配时忘记传 actorFor」正是这条链最省事的坏写法"
    );
  }
  /**
   * ⑦ 轮询那一路的形状（round282 补的那一格）。
   *
   * 这一格为什么值得一句机器判据：`messageToEnvelope` 曾经把轮询读到的回传标成
   * `kind:"text"`，于是运行时第①步把每一条批准判成闲聊，而 `summarize` 对
   * `ignored_not_action` 刻意什么都不说 ⇒ 手机上点了批准，Hub 一行日志都不打。
   * 那种坏法【不会】让本条 ①–⑤ 里任何一发变红（它们走的是长连接那一路的信封）。
   */
  let feishuTest: string;
  try {
    feishuTest = f.hubTest("channels/feishu.test.ts");
  } catch {
    return (
      "packages/hub/test/channels/feishu.test.ts 不在了 —— feishu.ts 文件头与 " +
      "FEISHU_SHAPE_EVIDENCE 都写着「字段变了红的是这个文件」，它不在时那两句是假主张"
    );
  }
  if (!feishuTest.includes('kind).toBe("card_action")')) {
    return (
      "feishu.test.ts 不再断言轮询信封的 kind 是 card_action —— " +
      "「kind 写错 ⇒ 整条审批路静默空转」那个形状失去唯一的正面判据"
    );
  }
  return "";
}

/**
 * r17：发卡那一路接上了生产入口，且重复投递由【库里那一行】挡（O12 动作 4，round283）。
 *
 * 这条主张的形状与 r16 是同一族的另一半：r16 管「回得来」，本条管「推得过去」。
 * 它顶上的是 `zero-producer` 里那条 `other` 登记（「`deliverCard` 零生产调用方」），
 * 而那条登记的存在理由就是【这一格今天没有机器判据】—— 现在有了，那条登记随之删除。
 *
 * 为什么判据必须核【生产代码】而不只核测试在场（同 r16 的理由，这里更硬）：
 * 这条主张承重的一格是【顺序】—— 先插台账再发请求。把两行调换，测试文件一个字不改、
 * 那个测试文件里每一发的名字都还在，而行为翻成「每 60 秒给审批人重推同一张卡」。
 * 那种坏法比"删掉整个功能"更贵：它把人训练成忽略这张卡。所以 ③ 那格直接比字节。
 *
 * 七格各自防的失效：
 *  ① 迁移整份不见 ⇒ 台账那张表没了，`runDeliverPass` 每轮抛 no such table，主张翻回「推不过去」。
 *  ② 主键换成自增 id（哪怕配一条唯一索引）⇒ 「抢到了没有」的判据从「有没有这一行」
 *     变成「索引撞没撞」，而 `claimDelivery` 读的是 `changes()`。这两者只在 INSERT OR IGNORE
 *     这一种写法下等价；幂等键搬走之后那层等价关系没人维护（0009 文件头记的就是这一格）。
 *  ③ 顺序翻向（先发再插）⇒ 红。本轮变异 M1 实测红 10/17 发。
 *  ④ 装配层不再调 `runDeliverPass` ⇒ 函数有定义、零读者，正是被删掉的那条 `other` 登记。
 *  ⑤ 投递测试整份不见 ⇒ ①–④ 重新变回散文（本篇一路在治的那一格）。
 *  ⑥ 一轮里 `deliverRound()` 排到了 `runtime.pollAll()` 【之前】⇒ 审批人上一轮在手机上
 *     批掉的那张卡会在同一轮里被再推一次。顺序在函数体内，所以判据也在函数体内。
 *  ⑦ 外键那一格：`deliver.ts` 不再接住 FK 违例 ⇒ 一张在扫描之后被删的卡把整轮投递带走；
 *     而测试不再实测它 ⇒ 那条 catch 变成一段没有分母的防御代码（两者各判一次）。
 */
function cardDeliveryLedgerCheck(f: Files): string {
  // ①② 台账：表在，且幂等键还是那一对。
  let mig: string;
  try {
    mig = f.migration("0009_card_delivery_ledger.sql");
  } catch {
    return (
      "migrations/0009_card_delivery_ledger.sql 不在了 —— 台账那张表没了，" +
      "`claimDelivery` 每一轮都会抛 no such table，O12 动作 4 退回「回得来、推不过去」"
    );
  }
  if (!mig.includes("approval_id TEXT NOT NULL REFERENCES approvals(id)")) {
    return (
      "台账的 approval_id 不再外键指向 approvals —— 「这张卡还在不在」从此只能靠读侧猜。" +
      "那条 FK 是【故意不带 CASCADE】的：删一张已投递的卡现在会当场抛，" +
      "而 `runDeliverPass` 接住它并把那张卡单独记一笔失败（本轮变异 M2 就是摘掉这一格）"
    );
  }
  if (!mig.includes("PRIMARY KEY (approval_id, channel_id)")) {
    return (
      "台账的主键不再是 (approval_id, channel_id) —— 幂等键换了主人。" +
      "`claimDelivery` 判「抢到了没有」读的是 INSERT OR IGNORE 之后的 changes()，" +
      "它只在【那一对就是主键】时与「这一对送过没有」等价"
    );
  }
  // ③ 顺序 + 幂等写法（生产代码那一半）。
  let deliver: string;
  try {
    deliver = f.src("channels/deliver.ts");
  } catch {
    return (
      "channels/deliver.ts 不在了 —— 发卡那一趟没有实现，" +
      "而装配层每轮都会抛（import 失败 ⇒ Hub 起不来）"
    );
  }
  const claimAt = deliver.indexOf("claimed = await claimDelivery(");
  const sendAt = deliver.indexOf("= await deliverCard(");
  if (claimAt < 0 || sendAt < 0) {
    return (
      "channels/deliver.ts 里【抢台账】与【发请求】这两步有一步不见了 —— " +
      "本条主张的主语是它们的先后关系，任一步被换掉这句话就没有对象了"
    );
  }
  if (claimAt > sendAt) {
    return (
      "channels/deliver.ts 变成【先发再插】了 —— 那时发送失败不留行 ⇒ 下一轮重发 ⇒ " +
      "审批人每 60 秒收到一张重复卡。本轮变异 M1 打的正是这一格"
    );
  }
  if (!deliver.includes("INSERT OR IGNORE INTO card_deliveries")) {
    return (
      "台账不再是 INSERT OR IGNORE —— 抢不到的那一发从「changes() 为 0」变成【抛错】，" +
      "于是每一轮第一条已投递的卡会把整轮发卡带走（本轮变异 M3）"
    );
  }
  if (!deliver.includes('why.includes("FOREIGN KEY constraint failed")')) {
    return (
      "deliver.ts 不再接住外键违例 —— 一张在扫描之后被删掉的卡会让整轮投递 reject，" +
      "而不是只把那一张记成失败"
    );
  }
  // ④⑥ 装配：有读者，且排在判决之后。
  let imch: string;
  try {
    imch = f.src("serve/im-channels.ts");
  } catch {
    return "serve/im-channels.ts 不在了 —— 心跳里没有 IM 那一段，发卡与入站一起失去装配点";
  }
  if (!imch.includes("await runDeliverPass({")) {
    return (
      "serve/im-channels.ts 不再调用 runDeliverPass( —— `deliverCard` 重新变成" +
      "「有定义、零生产调用方」。这正是 round283 从 zero-producer 里删掉的那条 other 登记，" +
      "删它的凭据就是这一格【从此有机器判据】"
    );
  }
  const judgeAt = imch.indexOf("await runtime.pollAll()");
  const deliverAt = imch.indexOf("await deliverRound()");
  if (judgeAt < 0 || deliverAt < 0 || judgeAt > deliverAt) {
    return (
      "pollRound 里发卡排到了判决【之前】（或有一步不在了）—— " +
      "那时审批人上一轮在手机上批掉的那张卡会在同一轮里被再推一次"
    );
  }
  // ⑤⑦ 分母：投递测试在场，且实测了 FK 那一格。
  let spec: string;
  try {
    spec = f.hubTest("channels/deliver.test.ts");
  } catch {
    return (
      "packages/hub/test/channels/deliver.test.ts 不在了 —— " +
      "上面那六格重新变回散文（本轮那六道变异能红，靠的就是这份分母在场）"
    );
  }
  if (!spec.includes("/FOREIGN KEY/")) {
    return (
      "deliver.test.ts 不再实测外键违例 —— `deliver.ts` 里那句 catch 失去唯一的分母，" +
      "而它是那段防御代码【唯一】能被删不红的地方"
    );
  }
  return "";
}

/* ══════════════ r18：外网 HTTP 的自设截止（round284） ══════════════ */

/**
 * r18：那一发外网 HTTP【一定会结束】（O12 动作 2 登记的那件「没做」，round284 补）。
 *
 * 这条主张最容易写宽的地方不是「有没有超时」，而是【谁的超时】：适配器每次调用都交出
 * 一个 `AbortSignal.timeout`，而**掐不掐得掉由拿到它的那一方决定**。默认实现真掐（有分母），
 * 注入实现读不读【没有机器判据】。所以下面 ④ 那格专门守「分母还在默认实现那一侧」，
 * 而那句边界写在 r18 的正文里，不在判据里 —— 判据证明不了一件不存在的事。
 *
 * 各格防的失效：
 *  ① 截止被写死在调用点而不可配 ⇒ 「几十毫秒内看到超时确实发生」那一发跑不动，判据变散文；
 *     更要紧的是「交 0 = 关掉超时」那个坏形状 —— 畸形值必须回落，不能当关闭。
 *  ② 两处调用点各有一格：取 token（一轮的第一发）与 `#call`（读消息 + 发卡）。
 *     只挂一处 = 一半的外网调用仍然没有下限，而它读起来像「这条加过了」。
 *  ③ `FeishuFetchInit` 上没有 signal 成员 ⇒ 注入方收不到截止，超时退化成默认实现的私事，
 *     「同一个截止」这句话失去主语。
 *  ④ 分母必须【真的在那儿】：测试在场、真的 bind 了 `init.signal`、真的起了监听。
 *     三样缺任何一样，那 9 发就退化成「断言 init 里有一个字段」—— 摘掉整条超时也照样绿。
 *  ⑤ 全 hub/src 里调 `fetch(` 的文件必须自己也构造 `AbortSignal.timeout(`。
 *     这是本条唯一的【通用】部分：下一处外网调用不会悄悄没有截止。
 *     ⚠ 两处口径要说白：它数的是【文件】而不是【调用点】—— 一个文件里一发挂了一发没挂，
 *        这一格读不出来（那种坏法由 ② 点名管住今天这两处）；它是【文本扫描】，
 *        一句写着 `fetch(` 的注释也会绊住那个文件 —— 那一发报的是文件名的，人一眼能看出来，
 *        而误报的代价（改一句注释）远小于漏报（一处真没截止的外网调用安静上线）。
 */
function fetchDeadlineCheck(f: Files): string {
  let feishu: string;
  try {
    feishu = f.src("channels/feishu.ts");
  } catch {
    return "channels/feishu.ts 不在了 —— 那发外网 HTTP 连调用点都没了，主张失去对象";
  }
  if (!feishu.includes("export const FEISHU_FETCH_TIMEOUT_MS")) {
    return (
      "FEISHU_FETCH_TIMEOUT_MS 不在了 —— 截止要么被删，要么被写死在调用点。" +
      "写死那一种会让「几十毫秒内看到超时确实发生」那一发跑不动，判据随之变回散文"
    );
  }
  if (!feishu.includes("Number.isFinite(t) && t > 0")) {
    return (
      "fetchTimeoutMs 的合法性判据不在了 —— 交 0 / 负数 / NaN 从此可能被当成" +
      "【关掉超时】，而这一格存在的全部理由正是「一次永不返回的外网请求」"
    );
  }
  if (feishu.split("signal: AbortSignal.timeout(").length - 1 < 2) {
    return (
      "channels/feishu.ts 里带截止的调用点少于两处 —— 取 token 与 #call（读消息 + 发卡）" +
      "只挂了一处 ⇒ 一半的外网调用仍然没有下限，而它读起来像「这条加过了」"
    );
  }
  if (!feishu.includes("readonly signal?: AbortSignal;")) {
    return (
      "FeishuFetchInit 上没有 signal 成员 —— 注入实现收不到截止，" +
      "「适配器与注入方共用同一个截止」这句话失去主语，超时退化成默认实现的私事"
    );
  }
  let spec: string;
  try {
    spec = f.hubTest("channels/feishu-http.test.ts");
  } catch {
    return (
      "packages/hub/test/channels/feishu-http.test.ts 不在了 —— " +
      "上面那四格重新变回散文（本轮那四发变异能红，靠的就是这份分母在场）"
    );
  }
  if (!spec.includes("createServer")) {
    return (
      "那份测试不再开真监听 —— 「远端不答 ⇒ 到点掐掉」那一发是这条主张唯一的真分母；" +
      "换成假 fetch 之后它只剩「断言 init 里有个字段」，摘掉整条超时也照样绿"
    );
  }
  if (!spec.includes("init.signal")) {
    return (
      "那份测试不再把 init.signal 接出去 —— 「注入实现读这个信号」那一格的分母没了，" +
      "「契约通了」这句话退回到只有注释拦着"
    );
  }
  const offenders: string[] = [];
  for (const rel of f.allSrc()) {
    let body: string;
    try {
      body = f.src(rel);
    } catch {
      continue;
    }
    if (/\bfetch\(/.test(body) && !body.includes("AbortSignal.timeout(")) {
      offenders.push(rel);
    }
  }
  if (offenders.length > 0) {
    return (
      "hub/src 里这些文件调 fetch 而自己不构造 AbortSignal.timeout：" +
      offenders.join("、") +
      " —— 那一发外网请求【没有自设截止】。要么挂上截止，要么把这条主张的射程改窄并写明" +
      "为什么那一处可以例外（不写明就退化成「有超时的只是碰巧有的那几处」）"
    );
  }
  return "";
}

/* ══════════════ r19：测试语料的类型棘轮（round285） ══════════════ */

/**
 * r19：全部测试文件从「整体在类型检查射程外」翻向「有一个按目录的上限表看着」。
 *
 * 这条主张【不需要】本判据去跑 tsc —— 棘轮的真分母在 `test-type-baseline.test.ts`
 * 里（它自己跑两遍真检查）。本判据判的是另一件会静默烂掉的事：
 * **那份守卫还在，但它不再判那件事**。形状与 r10/r11/r12 同一族（「档案在 ≠ 还在判」），
 * 而这一族的每一条都是这么立的：不重跑被守的东西，只核对它的判据没被掏空。
 *
 * 每一格对应的掏空方式：
 *  ① 上限比较被摘（`n > allowed` 没了）⇒ 表还在、计数还在，但没人比了；棘轮变表格。
 *  ② 「基线外的新目录」那一支被摘 ⇒ 新开一个测试目录就能拿到一片从没登记过的类型错，
 *     而这正是「反正测试本来就不在 `tsc -b` 射程里」那句话说的那种混法。
 *  ③ 空壳豁免那一半被摘 ⇒ 修干净的目录把豁免留在表里，表开始替不存在的东西作证。
 *  ④ 那三条反假绿哨兵（语料下限 / 未解析必须为 0 / 退出码与读数自洽）被摘 ⇒
 *     「include 被改窄」或「诊断行解析不出来」都会朝【绿】的方向漂。
 *     ⚠ 这一格只核对「测试里还写着这些断言」，不核对它们真跑得动 —— 跑得动由
 *     那份守卫自己红，本判据不冒充第二把尺子。
 */
function testTypeRatchetCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("test-type-baseline.ts");
  } catch {
    return (
      "test/arch/test-type-baseline.ts 不在了 —— 测试语料的类型上限表没了，" +
      "那 157 个文件重新回到「没有任何东西经过它们」"
    );
  }
  if (!guard.includes("if (n > allowed)")) {
    return (
      "棘轮的上限比较不在了（`n > allowed`）—— 配额表与计数都还在，但没有任何东西" +
      "把它们放在一起比过 ⇒ 「只许减不许增」退回一张表格"
    );
  }
  if (!guard.includes("unregistered.push(")) {
    return (
      "「基线外的测试目录」那一支不在了 —— 新开一个目录就能收一片从没登记过的类型错，" +
      "而它在棘轮上是【绿】的方向（那正是「反正测试不在 tsc -b 射程里」的混法）"
    );
  }
  if (!guard.includes("staleTypeEntries")) {
    return (
      "空壳豁免那一半不在了 —— 修干净的目录会把豁免留在表里，" +
      "于是这张表开始替已经不存在的问题作证（「豁免不许比现实活得久」失去执行者）"
    );
  }
  let spec: string;
  try {
    spec = f.arch("test-type-baseline.test.ts");
  } catch {
    return (
      "test/arch/test-type-baseline.test.ts 不在了 —— 上面那三格重新变回散文，" +
      "而真仓库那一半（真跑 tsc 那两发）连载体都没了"
    );
  }
  if (!spec.includes(".workbuddy/tsconfig.tests.json")) {
    return (
      "那份守卫不再检查 `.workbuddy/tsconfig.tests.json` 那个 project —— " +
      "它可能在查另一份（更窄的）配置，而「测试语料在射程内」这句话的主语随之换了"
    );
  }
  if (
    !spec.includes("toBeGreaterThanOrEqual(") ||
    !spec.includes("run.unparsed")
  ) {
    return (
      "那三条反假绿哨兵被摘了其一（语料下限 / 未解析行数必须为 0）—— " +
      "「include 被改窄」与「诊断行解析不出来」这两族都朝【绿】的方向漂，" +
      "而少报一条错在棘轮上永远不会红"
    );
  }
  // ── round300 的三格：往上跳的仓外路径那一族（分工不许漂）─────────────
  // 三格都是【正向】的「那句话的权威字节此刻在代码里」，且【先切函数体再剥注释】：
  // 这一族的注释比代码长（三个函数头上各有一整段在讲 `../`），拿整份文件搜
  // `escapesUpward(` 会在改空函数体之后仍然绿 —— r22 的 method 记过的那两条
  // withoutComments 盲区之一（锚点恰好出现在注释里）就是这个形状。
  const body = (anchor: string): string => {
    const at = guard.indexOf(anchor);
    if (at === -1) return "";
    const end = guard.indexOf("\n}", at);
    return withoutComments(
      end === -1 ? guard.slice(at) : guard.slice(at, end + 2),
    );
  };
  if (!body("function escapesUpward(").includes('p.startsWith("../")')) {
    return (
      "`escapesUpward` 的函数体里那句前缀比较不在了 —— 「往上跳的仓外路径不许折进" +
      "仓内目录」这句话的权威字节没了，`../packages/hub/test/engine/…` 又会归成" +
      "一个已登记目录、花掉本仓的配额（round300 实测过那个坏读数：291 条读空）"
    );
  }
  if (!body("const file = escapesUpward(raw)").includes("escapesUpward(raw)")) {
    return (
      "parseTscOutput 不再调 `escapesUpward` —— 函数还在而这一处不调它 ⇒ " +
      "配额那一侧退回无条件归一（round300 变异机 M2 就是这个改法，红在两发上）"
    );
  }
  if (
    !body('if (rel === "" || isOutsideRepo(').includes(
      "isOutsideRepo(raw, rel)",
    )
  ) {
    return (
      "parseListFiles 不再调 `isOutsideRepo` —— 语料那一侧退回只判绝对式 ⇒ " +
      "`../…` 又给 filesChecked 灌水（round300 变异机 M3 就是这个改法）"
    );
  }
  return "";
}

/** r4：BudgetPaused 今天零发布点 —— src 里没有 `new BudgetTracker`（实例化即发布点）。 */
function budgetPausedNoEmitCheck(f: Files): string {
  const hits: string[] = [];
  for (const name of f.allSrc()) {
    if (/new\s+BudgetTracker/u.test(f.src(name))) hits.push(name);
  }
  return hits.length > 0
    ? "BudgetTracker 有 new 点（实例化即 BudgetPaused 的发布点）：" +
        hits.join(" | ")
    : "";
}

/** r5 / r6：零写入方族；judge 归 zero-producer。检查该守卫登记表里对应档案还在。 */
function zeroProducerHas(f: Files, table: string, expects: string): string {
  const t = f.arch("zero-producer.test.ts");
  return t.includes('table: "' + table + '"') &&
    t.includes('expects: "' + expects + '"')
    ? ""
    : "zero-producer.test.ts 里找不到 " +
        table +
        " / " +
        expects +
        " 的登记 —— 该表的主张已失去守卫";
}

/** r7 / r8：零调用方族；judge 归 dead-modules。检查 BASELINE 里的对应模块还在。 */
function deadModulesHas(f: Files, rel: string): string {
  const t = f.arch("dead-modules.ts");
  return t.includes('"' + rel + '"')
    ? ""
    : "dead-modules.ts 的 BASELINE 里没有 " +
        rel +
        " —— 「零调用方 / 零 import」主张失去守卫";
}

/**
 * r7（round269 改版）：O9 动作 1 把 autoApprove 接进了【读路径】
 * （approvals/query.ts 的影子判定），基线格随之按方向 B 摘除 —— 于是
 * 「无生产调用方」整句过期，主张翻窄成【无生产写者】。
 * 三版同一条主张的谱系与 r2 一样记在文档 O14/§O9：
 * 「零调用方」→（round269 起）「读路径有读者、写路径零调用」。
 * 判据扫全部 src：除定义文件外，谁调 recordAutoApproval（那条会改卡片 +
 * 署 policy-engine 的写路径）谁红。阶段一的整条边界钉在这一格上。
 */
function r7NoWriterCheck(f: Files): string {
  const hits: string[] = [];
  for (const name of f.allSrc()) {
    if (name === "policy/auto-approve.ts") continue;
    if (/recordAutoApproval\s*\(/u.test(f.src(name))) hits.push(name);
  }
  return hits.length === 0
    ? ""
    : "src 里出现了 recordAutoApproval 的调用方（" +
        hits.join(", ") +
        "）—— 阶段一【只报不批】被越过：影子判定还没攒出读数，写路径先动了";
}

/**
 * r9：岗位书那四个字段有读者 —— 读者是提示词渲染，不是执行器。
 *
 * 这条是【反向登记】：r1–r8 那一批守的都是「别谎报有」，这一条守的是「别谎报没有」。
 * §2 轴二那张表原本写着「`forbidden_actions` / `decision_scope` /
 * `honesty_boundaries` 无读者」，round272 复测【假的】—— `charter/prompt.ts` 逐字段
 * 渲染它们，而渲染结果就是 `engine/claude.ts` 的 `--append-system-prompt`。
 * 于是这条判据双向都拦：
 *  ① prompt.ts 不再读某个字段 ⇒ 红（那一格悄悄退回「无读者」，而表里写着有）；
 *  ② runtime 不再调 `renderCharterPrompt(` ⇒ 红（岗位书整个不进提示词，
 *     四条字段同时失去读者，而 ① 一条都不会红 —— 只看 ① 的守卫会在
 *     「渲染还在、没人调用」这种最像没事的故障上闭嘴）。
 * 为什么判 `c.<字段>` 这种**属性访问**而不是判字段名字符串：注释里也写字段名
 * （`charter/prompt.ts` 的块注释就写着 `budget* → 真闸在 CLI`），判字符串名会让
 * 一条注释替一个已失效的读者作证。
 */
const CHARTER_PROMPT_FIELDS: readonly string[] = [
  "acceptanceCriteria",
  "honestyBoundaries",
  "forbiddenActions",
  "decisionScope",
  "judgmentMode",
  "escalationTriggers",
];

function charterFieldsReadCheck(f: Files): string {
  const prompt = f.src("charter/prompt.ts");
  const dropped = CHARTER_PROMPT_FIELDS.filter(
    (k) => !new RegExp("c\\." + k + "\\b", "u").test(prompt),
  );
  if (dropped.length > 0) {
    return (
      "charter/prompt.ts 不再读岗位书字段（" +
      dropped.join(", ") +
      "）—— §2 轴二那一行写着这些字段有读者，现在它正在变成没有"
    );
  }
  return f.src("engine/runtime.ts").includes("renderCharterPrompt(")
    ? ""
    : "engine/runtime.ts 不再调 renderCharterPrompt( —— rolePrompt 不再由岗位书渲染，" +
        "上面那六个字段全体失去读者，而逐字段的判据一条都不会红";
}

/**
 * r10：`pnpm lint` 恒红这件事有机器看着 —— 判的是「守卫还在不在」，不是重测 lint。
 *
 * 这条与 r5/r6/r7/r8 同族（去守卫的档案里找对应条目还在不在），理由也一样：
 * 登记表若去重跑一遍 biome，它就成了第二条 lint 判据，而 lint 的判据已经有一份
 * 带基线表的了；两处各测一次 ⇒ 两处会漂（本轮量到的正是这个：0057/0059 手抄的
 * 286 与今天的 292）。所以这里只问一件事：**照管这条主张的档案有没有被摘掉**。
 *
 * 判三样，少一样红：
 *  ① `lint-baseline.ts` 还在（判据文件被删 ⇒ 主张失去守卫）；
 *  ② 那份档案里还写着 `pnpm verify`（判据还在但**它声称管的事**被摘了 ⇒ 空壳守卫）；
 *  ③ 守卫测试文件里还有一条真跑 biome 的用例（只剩数据表没有执行 ⇒ 表会被当证据）。
 * ② 是最有料的一格：它能区分「有人把 lint-baseline.ts 改成管别的事了」和
 * 「文件还在所以没事」—— 只看文件存在性的判据在前者面前是绿的。
 */
function r10LintGuardCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("lint-baseline.ts");
  } catch {
    return (
      "test/arch/lint-baseline.ts 不在了 —— 「`pnpm lint` 恒红、error 只许减不许增」" +
      "这条主张重新变成一句散文，而它当初就是因为只活在散文里才让 286 这个数漂到 292"
    );
  }
  if (!guard.includes("pnpm verify")) {
    return (
      "test/arch/lint-baseline.ts 还在，但正文里不再提 `pnpm verify` —— " +
      "它声称照管的那件事被摘走了，文件留着像个还在干活的空壳"
    );
  }
  if (!f.arch("lint-baseline.test.ts").includes("runBiomeJson(")) {
    return (
      "test/arch/lint-baseline.test.ts 不再调 runBiomeJson( —— 基线表还在但没人跑 biome，" +
      "于是它退化成本仓最擅长清理的那种东西：一份没人执行的期望表"
    );
  }
  return "";
}

/**
 * r11：计划编号引用有人看着 —— 判的是「那份守卫还管不管它声称管的事」。
 *
 * 与 r10 同一个理由：登记表不去重跑取材（那会造出第二份口径读数，而两份必然互相漂，
 * 本轮量到的正是这种漂），只问「照管这条主张的档案有没有被摘掉 / 掏空」。
 *
 * 判三样，少一样红：
 *  ① `plan-refs.ts` 还在；
 *  ② 它还在扫 `docs` 下的 markdown —— 这一格是 P4 那发变异【直接教出来的】：
 *     把取材改成「只读计划 + 全部 ts」之后，10 发测试全绿，而它对「漏掉本轮全部
 *     2 处真悬空的那个口径」完全失明。文件在、测试绿、判据已死；
 *  ③ 测试里还有一条真读仓库的用例（只剩合成夹具 ⇒ 夹具自证）。
 */
function r11PlanRefsGuardCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("plan-refs.ts");
  } catch {
    return (
      "test/arch/plan-refs.ts 不在了 —— 「每句指向计划的编号引用都指向真存在的小节」" +
      "重新变成一句散文。它当初就是因为没有守卫才让 2 处拆分后的旧编号安静地留在决策文档里"
    );
  }
  if (!guard.includes('collect(root, "docs", ".md")')) {
    return (
      "test/arch/plan-refs.ts 还在，但取材里不再扫 docs 下的 markdown —— " +
      "这就是 round275-P4 那发变异：10 发全绿，而它对『漏掉全部 2 处真悬空的那个口径』全瞎"
    );
  }
  if (!f.arch("plan-refs.test.ts").includes("readCorpus(")) {
    return (
      "test/arch/plan-refs.test.ts 不再调 readCorpus( —— 只剩合成夹具在自证，" +
      "真仓库那一半没人读，于是它对【真实】的悬空永久失明"
    );
  }
  return "";
}

/**
 * r12：门禁验收行的住址有人看着 —— 判的还是「守卫还在不在」，不重跑 existsSync。
 *
 * r10 / r11 同族第三条。理由一样：登记表若自己去 existsSync 一遍，它就成了第二份
 * 住址判据，而住址判据已经有一份带豁免账的了（本轮刚立的）。两处各测一次 = 两处会漂。
 *
 * 判三样，少一样红。这三格是【照着本轮三个真故障】设计的，不是随手列的：
 *  ① 守卫文件还在；
 *  ② 判据里还在真的调 exists(p) —— 这一格就是 G4 那发变异（把 exists 换成恒真）
 *     在登记表层的对应物：真仓库那 4 发全绿，只有合成读数抓得到；
 *  ③ 判据仍把豁免当【字节串】比（不是比语义）—— 它防的是有人把标记换成一句中文说明，
 *     那样豁免会从"一份可数的账"退回成"一句散文"，而散文正是 O14 整篇在治的东西。
 */
function r12GatePathGuardCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("plan-gate-paths.ts");
  } catch {
    return (
      "test/arch/plan-gate-paths.ts 不在了 —— 「每条验收行点名的工件路径逐字存在」" +
      "重新变成一句散文，而它当初就是因为没人核对，才让三道门拿着子串匹配绿了这么久"
    );
  }
  if (!/if\s*\(\s*!exists\(p\)\s*\)/u.test(guard)) {
    return (
      "test/arch/plan-gate-paths.ts 还在，但住址判据不再调 exists(p) —— " +
      "这就是 round276-G4：真仓库那几发全绿，而它对【任何】坏住址永久失明"
    );
  }
  if (
    !guard.includes("includes(NOT_BUILT_TAG)") ||
    !guard.includes("gate-path-not-built")
  ) {
    return (
      "test/arch/plan-gate-paths.ts 不再按那串字节比对豁免 —— 豁免会从「一份可数的账」" +
      "退回成一句人话说明，而散文正是本登记表整篇在治的东西"
    );
  }
  return "";
}

/**
 * r13：唯一生效的安全边界那条守卫，判的是【接线】不是【重跑】。
 *
 * 三条判据各对应一种【空壳化】路径，都是本轮别处真量到的形状：
 *  ① 文件被摘掉 ⇒ 主张退回散文。
 *  ② 相邻判据被换成「两个串都在文件里」⇒ 它对【任何】形状都返回真，而 11 发测试
 *     照过（那 11 发吃的是合成夹具，合成夹具改的是【夹具】不是【判据】）。
 *     这一条就是 r11 那条 P4「静默窄口径」在本登记表层的对应物。
 *  ③ 探针键名单被清空 ⇒ 第四判据恒真。
 * ⚠ 刻意【不重跑子进程探针】：真那一发在 claude.test.ts 里跑，这里再跑一次就是两处
 *     各测一遍、然后互相漂（同 r10 不重跑 biome 的理由）。
 */
function roleSpawnBoundaryGuardCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("role-spawn-boundary.ts");
  } catch {
    return (
      "test/arch/role-spawn-boundary.ts 不在了 —— 「那两个参数是唯一生效的安全边界」" +
      "重新变成一句散文；本轮变异 plan→bypassPermissions 在立它之前【全仓零红】"
    );
  }
  if (!guard.includes('s[k + 1] === "plan"')) {
    return (
      "test/arch/role-spawn-boundary.ts 还在，但相邻判据不再逐格比对数组的下一位 —— " +
      "换成「串在不在文件里」之后它对任何形状都返回真，而那 11 发合成变异照旧全绿"
    );
  }
  if (!guard.includes("for (const k of PROBE_KEYS)")) {
    return (
      "test/arch/role-spawn-boundary.ts 不再逐个核对探针键 —— 第四判据从此对【名单被清空】" +
      "这件事失明，而那正是「行为探针那一发还在不在」唯一的机器凭据"
    );
  }
  return "";
}

/**
 * r14：坐标核对在门禁里 —— 这一条是**自指**的，所以判据刻意只看【接线】不看【读数】。
 *
 * 三条各对应一种空壳化：
 *  ① 判据文件被摘掉 ⇒ 「坐标有人核」退回一句散文，而本篇正是拿这句话治别人的。
 *  ② 那句包含比较的判据被换成恒真 ⇒ 坐标可以整片漂走而全绿（本轮变异 C3 实测的形状）。
 *  ③ 取材非空那一发没了 ⇒ 空数组恒绿，「全部核对通过」与「一条都没有」逐字一样。
 * ⚠ 刻意【不重跑坐标核对】：claim-coords.test.ts 自己就在跑它，这里再跑一次就是两处
 *     各测一遍然后互相漂（同 r13 不重跑子进程、r10 不重跑 biome 的理由）。
 */
function claimCoordsGuardCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("claim-coords.ts");
  } catch {
    return (
      "test/arch/claim-coords.ts 不在了 —— 「登记表每条坐标有人核」重新变成一句散文，" +
      "而它此前【本来就只有脚本】：本轮往 §5 插一段就让四条坐标同时 STALE 而全仓 304 发绿"
    );
  }
  if (!guard.includes("located.includes(e.source.line)")) {
    return (
      "test/arch/claim-coords.ts 还在，但那一格【登记的行号命中了吗】的比较不见了 —— " +
      "掏空它之后真仓库那一发不红，红的只剩四条合成变异（变异 C3 就是这个形状）"
    );
  }
  let spec: string;
  try {
    spec = f.arch("claim-coords.test.ts");
  } catch {
    return (
      "test/arch/claim-coords.test.ts 不在了 —— 上面那条判据失去唯一跑它的地方，" +
      "而「取材非空」那一发也一起没了：REGISTRY 退化成空数组时它恒绿"
    );
  }
  if (!spec.includes("REGISTRY.length")) {
    return (
      "claim-coords.test.ts 不再核对登记表非空 —— 空数组与「全部核对通过」在断言上逐字一样，" +
      "这正是那条一次性脚本三代坑里最阴的一代"
    );
  }
  return "";
}

/**
 * r15：`POST /org` 提交不了一个新角色（三段证据）。
 *
 * 这条与 r1/r9 同族（判的是【在场 + 仍在判】），而它比它们多一格：被主张照着的那个
 * 东西是一发**验收测试**，不在 `src/` 也不在 `test/arch/` —— 所以 Files 多了一个
 * `hubTest`（它的存在理由写在那个方法的注释里，不在这里复述）。
 *
 * 五条判据各自防的失效：
 *  ① 验收测试整份不见 ⇒ 那条端到端重新变成一句散文（本篇一路在治的那一格）。
 *  ② 反空转那一发被摘掉 ⇒ 剩下的六发**照样全绿**，而它们只证明「名字进了图」，
 *     正是 O8 正文自己警告的假绿。这条判据核的是【那个角色名还在断言里】，
 *     不核断言文本 —— 名字是那一发的身份，改名 = 换了一发别的。
 *  ③ 前提那一发被摘掉 ⇒ 撞名那天没人红（变异 M6 的余量登记处）。
 *  ④ 前端取材看不见那个真发变更的文件 ⇒ 「界面发不出变更」恒绿。
 *
 * ⚠ ④ 在 round295 之前是【非空下限】（`web/src` + `desktop/src` 的 ts/tsx 数 ≥ 5），
 * 而它【量过、且通过】（实测 web=4 / desktop=7）—— 那是最贵的一种失效：
 * 一个数过不了关的数，量的位置不含那件能推翻主张的事。真控制室在
 * `packages/web/public/app.js`（`.js` 不在筛的扩展名里、`public` 不在筛的根里），
 * 于是那发证据③ 连着六轮绿着替「两个前端零出口」那句假话作证。
 * ⇒ 下限换成了【成员点名】：先核取材那张表本身列了 `web/public` 与 `.js`
 * （读不到那段字节 = 表被改了 ⇒ 红，不静默），再核三个根合起来非空。
 * 「量过」不等于「量对位置」，这一格买的就是这个区别。
 *
 *  ⑤ (round308 新加) 名单本身没人对账 ⇒ 文案与那发测试的期望值各说各的。
 *     round295 把主张从否定式翻成【正向点名】，可那份名单只活在那发测试的
 *     `expect(emitters).toEqual(…)` 里，本判据当时一格都没核它。round308 有人
 *     给界面补上 add_edge / add_node（正是那发注释预留的「产品决定」那天），
 *     文案里的两份空名单当场变假而【判据全绿】—— 与④ 是同一条教训的两半：
 *     ④ 管「取材看不看得见那个文件」，⑤ 管「点出来的名单有没有人对账」。
 *
 * ⚠ 与 r13 同一条纪律：本判据【不重跑】那 7 发，也不重跑那六发变异。它只核对
 * 那份验收文件在场、且那两个关键的断言对象还在里面。
 */
function orgAddNodeGapCheck(f: Files): string {
  let spec: string;
  try {
    spec = f.hubTest("acceptance/new-role-to-its-own-criteria.test.ts");
  } catch {
    return (
      "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts 不在了 —— " +
      "「POST /org 提交不了一个新角色」重新变成一句散文，而它此前【连一句都没有】：" +
      "O8 正文写的是「组织侧的写路径全在」，那句话今天是错的"
    );
  }
  // ② 反空转：那个【没播种的新角色名】必须在断言里。摘掉它 = 只证「名字进了图」。
  if (!spec.includes('rolePrompt("data")')) {
    return (
      "那发验收测试还在，但【反空转那一格】不见了（读 `data` 这个角色提示词的断言没了）—— " +
      "剩下几发照样全绿，而它们只证明「名字进了图」，正是 O8 正文警告的那件事"
    );
  }
  // ③ 前提：撞名那天要有人红。
  if (!spec.includes('expect(stems).not.toContain("translator")')) {
    return (
      "那发验收测试不再自证【前提】（新角色名不与模板文件名相同）—— " +
      "哪天有人把 translator 放进 resources/charter-templates，上面那条对照会悄悄变成假绿"
    );
  }
  // ④ 取材面必须真的含那个真发变更的文件所在的那一格。
  // 这一段字节是这条判据里唯一【新】的东西，也是唯一真拦住过事情的东西：
  // 旧的写法在这里数「web/src + desktop/src 的 ts/tsx ≥ 5」，实测 4+7=11 ⇒ 通过，
  // 而它一次也没看见 app.js（根少一个、扩展名少一种 ⇒ 恒绿六轮）。
  // ⇒ 现在核的是【那张表本身】：`FRONTEND_CORPUS` 那一段里必须同时出现
  //   "public" 与 ".js"。读不到那一段 ⇒ 红在「取材表不见了」，
  //   读到但少了那一格 ⇒ 红在「界面那个真发变更的文件不在取材里」。
  // 为什么不直接在这儿 countFiles("packages/web/public", [".js"])：
  // 那测的是【磁盘】，而这条主张的内容是【那发测试扫不扫它】。磁盘上有、
  // 而表里没列 = 主张假；表里列了、而磁盘上没有 = 那发测试自己会抛（它拒拿
  // 「零出现」冒充通过）。两种红各有各的修法，本判据只管前一种。
  const corpus = sliceFrom(spec, "const FRONTEND_CORPUS", "\nconst CONSOLE_JS");
  if (corpus === null) {
    return (
      "那发验收测试里读不到 `FRONTEND_CORPUS` 那一段（改名 / 整段删了 / 结束标记换了）—— " +
      "「界面发不出组织变更」这条主张的取材面【不可核对】，" +
      "而它此前六轮就绿在一份看不见真控制室的取材上"
    );
  }
  if (!corpus.includes('"public"') || !corpus.includes('".js"')) {
    return (
      "FRONTEND_CORPUS 那一段里读不到 packages/web/public 或 .js —— " +
      '`packages/web/public/app.js` 是【确实在发】kind: "reparent" 的那个文件，' +
      "它不在取材里 ⇒ 那发『每种 kind 谁都不发』会重新变成【读不到】换来的绿"
    );
  }
  // 非空下限仍然留着（口径换成三个根）：表写对了而目录整个没 ⇒ 那发会抛，
  // 但本判据不许在【合成语料】之外的地方静默失效，所以留一道便宜的兜。
  const web = f.countFiles("packages/web/src", [".ts", ".tsx"]);
  const pub = f.countFiles("packages/web/public", [".js", ".jsx"]);
  const desktop = f.countFiles("packages/desktop/src", [".ts", ".tsx"]);
  if (web + pub + desktop < 5) {
    return (
      "三个前端根一共只数出 " +
      (web + pub + desktop) +
      " 个文件（本轮实测 web/src=4 · web/public=1 · desktop/src=7）—— " +
      "「界面发不出某种变更」这个读数【不可信】：取材空了的时候，" +
      "一条否定式主张永远绿（本仓反复登记的那一族：先怀疑问的位置，再怀疑读到的数）"
    );
  }
  // ⑤ 名单本身（round308）。round295 把这条主张从否定式翻成正向点名，而点名点出来的
  // 那份名单【只活在那发测试的期望值里】—— 本判据当时没核对它。于是有人在界面上
  // 补上 add_edge / add_node（round308 正是那一天）之后，主张文案与那发测试各说各的，
  // 本判据一次也不会响。这跟④ 是同一条教训的另一半：④ 管「取材看不看得见那个文件」，
  // ⑤ 管「点出来的名单有没有人对账」。
  // ⚠ 位置【必须留在非空下限之后】，这是变异机器逼出来的（round308 那台第一版实测）：
  // 写在它【之前】时，「三个根全数出 0」那发变异红在【名单】上而不是【不可信】上 ——
  // 取材都没了，先报「名单不匹配」是把「读不到」当成「读到了不匹配」，而两者的修法相反
  // （前者修取材，后者修主张）。与 r1 那条「A→B→C→D 的严序」同一个道理：
  // 一格判据的【顺序】也是主张的一部分，它不靠注释维持，只有跑出来的红因分布能打它。
  // ⚠ 仍不核对「app.js 真的发了这三种 kind」—— 那是那发端到端的活（它自己会红）。
  // 这里只核对「文案点的那三名此刻在那发测试的期望字节里」，与本判据其余四格同一个口径。
  // 用 sliceFrom 而不是全文搜：全文搜会把「注释里提一句 add_edge: [consolePath]」
  // 当成名单还在（r22 为同一件事挨过一次变异，见它的 ① 那一格）。
  const roster = sliceFrom(spec, "expect(emitters).toEqual({", "// ② 前提自证");
  if (roster === null) {
    return (
      "那发验收测试里读不到证据③ 那份【名单】的边界（起锚 `expect(emitters).toEqual({` " +
      "或止锚 `// ② 前提自证` 改了名 / 整段删了）—— 于是「三种 kind 都由 app.js 发」" +
      "这一格退回【整份文件里搜一下】，而④ 那句红因写的是同一件事：那正是假证人的形状"
    );
  }
  for (const kind of ["reparent", "add_edge", "add_node"]) {
    // 不要求尾逗号：那会把判据钉在【行排版】上 —— 谁把三格压成一行（prettier 干得出来），
    // 最后一格没有逗号，这一格就假红。`]` 紧跟 consolePath 已经排除了
    // `[consolePathFoo]` 那种同前缀改名，逗号那一格再加只是脆，不是严。
    if (!roster.includes(`${kind}: [consolePath]`)) {
      return (
        `证据③ 的名单里 ${kind} 那一格不再是 \`[consolePath]\` —— 而 r15 的文案现在` +
        "点名的是【三种 kind 都由 app.js 发】。两种可能，别改错那一处：" +
        "要么界面又把这一种变更撤了（那是产品决定，文案跟着改口），" +
        "要么那发测试的期望值被顺手放宽（那正是本判据要拦的）"
      );
    }
  }
  return "";
}

/**
 * r20：§1.1 那张表的四条数从「配了一段描述」翻向「有一条能跑的命令」。
 *
 * 这条主张的【空转形状】比别条更隐蔽，所以判据一格都不能省：
 * census.ts 坏掉时不报「扫描失败」，它照常打印四个数（它只测量、不判定，
 * 这是刻意的 ⇒ 没有 assert 会替我响）。真正会静默失效的是这四件事：
 *  ① 脚本整份没了 ⇒ 那句「配了复算方法」重新变回一句散文（本篇一路在治的）。
 *  ② 它不再复用 ./dead-modules.ts 那张图，自己解析一遍 ⇒ 同一套误读同时作用于
 *     两侧 ⇒ 差集恒空 = 恒真判定（§7 第 4 格那一族）。本轮 grep 'store\.js'
 *     当场犯过一次同类误读（匹到的全是另一个 store），所以这一格判的是【import 关系】。
 *  ③ 悬空说明符不再抛 ⇒ 建立在坏图上的读数会被人手抄进文档。
 *  ④ 排除入口那一格被摘 ⇒ §1.1 表上那条口径（11 vs 7 的差）没人执行，
 *     而全量那条【照样能读出一个看着合理的数】。
 * 外加那两枚反向 canary 的在场：成员判据（解析器退化成立刻红）与
 * unresolved 会自报（证明那个 0 是算出来的不是写死的）。
 *
 * ⚠ 与 r13/r19 同一条纪律：本判据【不跑】那个脚本、也不重跑那 12 发。
 * 重跑一遍只会让两处口径互相漂，而这条主张的内容是「有这个方法」不是「数是多少」。
 */
function censusRecomputeCheck(f: Files): string {
  let script: string;
  try {
    script = f.arch("census.ts");
  } catch {
    return (
      "test/arch/census.ts 不在了 —— §1.1 那张表的「怎么复算」重新变成一段描述，" +
      "而本篇两处「每个数都配了复算方法」的说法（§8 末 / O14 动作 3）" +
      "在 round293 之前【正是这样假的】"
    );
  }
  if (
    !script.includes('from "./dead-modules.js"') ||
    !script.includes("collectModules")
  ) {
    return (
      "census.ts 不再从 ./dead-modules.js 拿取材与图 —— 它自己解析了一遍。" +
      "两处各解析一遍 = 同一套误读同时作用于两侧 ⇒ 差集恒空 = 恒真判定，" +
      "而 §1.1 当初数出 33 个假死模块的那条坑就是这么来的"
    );
  }
  if (!script.includes("if (c.unresolved > 0)")) {
    return (
      "census.ts 不再在悬空说明符非 0 时抛 —— 图坏了一半时它照样打印四条数，" +
      "而那四个数看着与好图上的逐字一样（少认一种 import 写法 = 一条真边静默消失）"
    );
  }
  if (!script.includes(".filter((r) => !r.isEntry)")) {
    return (
      "排除 scripts 入口那一格不在了 —— §1.1 表上那条「零 importer（排除入口）」" +
      "的口径没有执行者了，而剩下那条【全量】读数看着一样合理（今天 11 vs 7 的差就是它）"
    );
  }
  let spec: string;
  try {
    spec = f.arch("census.test.ts");
  } catch {
    return (
      "test/arch/census.test.ts 不在了 —— 上面那三格重新变回散文，" +
      "而「这个脚本到底有没有在测我以为的那件事」又一次只靠人想起来跑一遍"
    );
  }
  if (!spec.includes('expect(rels.has("db/write-queue.ts")).toBe(false)')) {
    return (
      "那发【成员】判据不见了（明知有调用方的模块必须不在零 importer 里）—— " +
      "解析器退化成零条边时，名单是【膨胀到 85】而不是缩小，只判数量下界的断言抓不到"
    );
  }
  if (!spec.includes("expect(bad.unresolved).toBe(1)")) {
    return (
      "那发【unresolved 会自报】的反 canary 不见了 —— 于是真仓库那条 `unresolved === 0`" +
      " 分不出「今天真没有悬空」与「那个 0 是写死的」"
    );
  }
  return "";
}

/**
 * r21：豁免那份【账】从「上下界」换成「钉死」之后，这条主张的成立条件。
 *
 * ⚠ 与 r12 / r20 同一条纪律：本判据【不重跑】existsSync、也不跑那台变异机器。
 * r21 的内容是「那份账被钉成了双向的」，所以它核的是【那几枚钉还在】：
 *  ① 守卫与测试都在场（否则退回散文）；
 *  ② 账还在按【字节串】数标记 —— r12 已判过这一格，这里再判一次不是重复：
 *     r12 判的是「住址守卫存在」，r21 判的是「那份账可数」，两者若只留一处，
 *     另一条主张会单独失效（本轮 §10 第 20 格记的正是「注释没有读者」）；
 *  ③ `expect(ex.length).toBe(1)` 那枚钉还在 —— 它是【双向】的唯一来源：
 *     原来的 `>0 且 ≤2` 在「最后一条豁免被静默摘光」时不红，而摘光后的红话
 *     长得像「计划里有个路径写错了」；
 *  ④ ⭐ 那发【反向 canary】还在（合成语料给两条标记 ⇒ 数出两条）——
 *     只有 ③ 的话，一个恒返回「一条」的坏计数器照样绿（filter 写成 find / 多一个 slice(0,1)）。
 *     这与 census 那两枚反 canary 同一条立场：**钉住一个读数的唯一办法，是让同一个
 *     判据在另一份语料上给出另一个数。**
 */
function gateExemptionAccountCheck(f: Files): string {
  let guard: string;
  try {
    guard = f.arch("plan-gate-paths.ts");
  } catch {
    return (
      "test/arch/plan-gate-paths.ts 不在了 —— 「豁免是一份可数的账」重新变成" +
      "守卫文件头里的一段话，而 round293 第二段量的正是那种话的下场：" +
      "判据读计划正文，不读自己的注释 ⇒ 注释里的「今天」过期得无声无息"
    );
  }
  // ⚠ 这里读的是【整条 filter 表达式】而不是 `includes(NOT_BUILT_TAG)` 那一段：
  //   后者在文件里有【两处】（missingGatePaths 里那句 `if (…) continue` 也含它），
  //   只判片段 ⇒ 摘掉 exemptedBlocks 的 filter 照样绿，而这正是 r20 之二那条教训的形状
  //   （「文本在场」不等于「我打的那一格还在」）。M3 那发变异打的就是这一整条。
  if (!guard.includes(".filter((b) => b.text.includes(NOT_BUILT_TAG))")) {
    return (
      "plan-gate-paths.ts 的 exemptedBlocks 不再按那串字节筛 —— 账还在数，" +
      "但它数的不再是【谁给了豁免】。豁免退回散文 = 本登记表整篇在治的东西"
    );
  }
  let spec: string;
  try {
    spec = f.arch("plan-gate-paths.test.ts");
  } catch {
    return (
      "test/arch/plan-gate-paths.test.ts 不在了 —— 上面那格没有执行者，" +
      "而「条数恰好 1」这件事没人钉，它就只是本轮的一句打算"
    );
  }
  if (!spec.includes("expect(exemptedBlocks(blocks)).toEqual([])")) {
    return (
      "真仓库那一发的【条数钉】不在了（或被换成上下界）—— 单向的界只挡「又多开一道" +
      "没建的门」，挡不住「豁免被人静默改数量」。2026-11-19 那条豁免正当摘掉之后，" +
      "这一枚钉的是【恰好 0】：清零不等于免账，它是那份账的一个读数"
    );
  }
  // ⭐ 2026-11-19 换形状的那一格：豁免账清零后，「死豁免」那条判据在真仓库上遍历的是
  // 【空名单】⇒ 判据的循环体永不执行。round298 那句「一个永远不可能进入的分支就是
  // 一句装饰」管的正是这种绿。所以判据搬进守卫导出的 deadExemptions，
  // 由合成语料（含一条「混合行」）真跑。下面两格一个判【实现还在且真在筛】、
  // 一个判【它在非空名单上真被执行过】—— 少后者，「return []」那种写法两格都过。
  if (!guard.includes("export function deadExemptions(")) {
    return (
      "deadExemptions 不再是守卫导出的判据 —— 「豁免贴错位置就该数出来」" +
      "又变回测试里那段在空名单上永不执行的循环（round298 的「装饰分支」那一族）"
    );
  }
  // ⚠ 读整条箭头表达式而不是读 `deadExemptions` 这个名字：名字在文件里出现多处
  //   （函数名、注释、导出），只判名字 ⇒ 把判据换成 `return []` 它照样绿。
  //   同 r20 之二 / r21 之二那条教训（「文本在场」≠「我打的那一格还在」）。
  if (
    !guard.includes("(e) => e.paths.filter((p) => !exists(p)).length === 0")
  ) {
    return (
      "deadExemptions 里那条「这条豁免行有没有【至少一条】路径真不在盘上」的筛法不在了 —— " +
      "函数名还在而判据被换成恒真/恒假，那条判据就只是它自己的名字"
    );
  }
  if (
    !spec.includes(
      'deadExemptions(acceptanceBlocks(md("test/e2e/dead.spec.ts"))',
    )
  ) {
    return (
      "「死豁免【该数出来】」那一发不在了 —— 于是 deadExemptions 在【非空名单】上" +
      "从没被执行过，今天真仓库那条清零的绿分不清「判据判对了」与「判据恒给空」"
    );
  }
  if (!spec.includes('["test/e2e/two.spec.ts"]')) {
    return (
      "那发【反向 canary】不在了（合成语料给两条标记 ⇒ 必须数出两条）—— " +
      "于是真仓库那个条数读数分不清「今天真是这个数」与「那个计数器恒给这个数」"
    );
  }
  return "";
}

/**
 * 把一份源码里的【注释字节】换成空行，只用于「这段字节是在代码里，还是只在一句注释里」。
 *
 * ⚠ 这是全仓第三份私有注释剥离（另两份在 `bindings/im.test.ts` 与
 * `web/renderer-criteria.test.ts`，0058 §5/§8 明写「本轮没修」并由 doc-refs 钉着快照）。
 * 不共用那份的理由：那一份的口径是「保 import 图的精度」，带一条已知缺陷
 * （行注释里的块注释起始串会吃掉真代码）；这一份的口径只有一句
 * ——【注释里的字节不算代码】——精度要求更低、实现更小才谈得上核对。
 *
 * 两个已知的洞。⚠ 这一格本轮被我写错过一次方向，下面的读数是量出来的：
 *  ① 字符串字面量里出现 `//`（例如一个 https 开头的 URL）会把那一行后半截吃掉 ⇒
 *     吃掉的是【同一行的真代码】。家族那一格被吃掉的是【真判据】⇒ 假绿。
 *     （分派那两格若被同样吃掉则是【假红】，方向随格子变；今天 commit.ts
 *     那三处字节所在的行都不带这种字符串，所以那一边没咬人。）
 *     钉它的合成用例：claims-registry.test.ts 的「变异 r22 之九·乙」，
 *     配一发【只把那句带双斜杠的字符串拿掉】的单变量对照 ⇒ 那一发必须红。
 *  ② 先去行注释、再去块注释，所以一段块注释里若含 `//`（URL 之类），收尾的那两个字符
 *     会先被吃掉 ⇒ 块【没能在此收尾】。⚠ 方向【不是】"注释字节留下 ⇒ 假红"：
 *     那个懒匹配的量词不会停在原地，它一路吞到【下一个真收尾】。今天
 *     validateNewNode 那一段里就有下一个真收尾（下面 heightBelow 的 JSDoc），
 *     实测连坐吞掉 role_exists / would_create_cycle / multiple_roots /
 *     depth_exceeded 四判的字节 ⇒ 整条判据隐身 ⇒ 【假绿，且比①宽得多】。
 *     钉它的合成用例：「变异 r22 之十·乙」，同样带单变量对照（去掉块里的
 *     `//` ⇒ 那一发必须红）。⇒ 泛用那条：**登记一个洞之前先把它的方向量出来**，
 *     写错方向的登记会让下一个人去防一支根本不存在的箭。
 *  今天两份真语料都没有这两种字节（这正是它们没咬人的唯一原因）。两发登记用的
 *  都是【函数体内】的注入：注在函数头之前的话 sliceFrom 取不到那一段，
 *  那一发就恒绿空转 —— 所以那两发各带一条"变异必须落在切片内"的位置自证。
 */
function withoutComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 取 `[start, next)` 之间的一段。
 *
 * ⚠ 两个标记【任一】读不到就返回 null，不返回「从 start 一路到文件末尾」那种残缺段。
 * 理由是那一格会【静默放宽作用面】：收尾标记被改名 ⇒ 段变大 ⇒ 判别式里那句话
 * 在更大的语料里更容得下 ⇒ 判据更容绿。红话「读不到那一段」说的是【取材】，
 * 而「退回整份文件搜」做的事正是①那条红话自己骂的那件（把「文本在场」
 * 当成「那一格还在」）。宁可响一声，不要安静地换口径。
 */
function sliceFrom(src: string, start: string, next: string): string | null {
  const a = src.indexOf(start);
  if (a === -1) return null;
  const b = src.indexOf(next, a + start.length);
  return b === -1 ? null : src.slice(a, b);
}

/**
 * r22：契约里那条「加角色」的正经路还在，且它仍然【带判据】（round294）。
 *
 * 这条主张的空转形状比别条更具体，它自己本轮就犯过一次：round292 那发验收测试的
 * 证据① 在 add_node 落地之后【照样是绿的】，因为它的断言对象是「旧形状写不出来」——
 * 一个被现实推翻的主张，只要断言写成否定式，就能在翻转之后继续绿着。所以本判据
 * 的每一格都写成【正向：那句话的权威字节此刻在代码里】，且分派那两格先剥注释
 * （那条主张的原话就是「分派仍在真调判据，而不是只剩一条注释」）。
 *
 * 读三份权威落点，一份都不抄：kind 的名单在 contracts 的 schema 里、判据在
 * contracts 的 validate 里、分派与落库在 hub 的 commit 里。把 kind 名单抄进本文件
 * 就是又造一份手抄 —— 手抄的那份会在真那份改动后继续绿着（本篇通篇在治的那一族）。
 *
 * 射程（比上面全部加起来重要）：
 *  · 它【不重跑】任何端到端请求，也不重跑那台变异机器（口径同 r12/r13/r21）。
 *    「新节点真能进库」「六种坏形状真拿到 422」由验收测试与单测负责，这里只核对
 *    那些测试所依据的【结构】还在。
 *  · 它【不判】「旁路被关掉了」—— 那条判据（「图必须等于 before 经 change 得到」）
 *    今天不存在，本轮台账「没做的下一格」登记的就是它。把本条读成「不能通过请求体
 *    加角色了」是误读。
 *  · 它【不判】类型层的兜底是否成立（加第四种 kind 而漏分派 ⇒ `tsc` 红）。
 *    这里只核对那个兜底【还在】：它一旦被换成默认放行，类型就不再多说话，
 *    而那正是它的函数头警告的那一种改法。
 */
function addNodeDispatchCheck(f: Files): string {
  // ── ① 契约：那条 kind 还在判别式里 ──────────────────────────────────
  let graph: string;
  try {
    graph = f.contracts("org/graph.ts");
  } catch {
    return (
      "packages/contracts/src/org/graph.ts 不在了 —— 「契约里有一条加角色的路」" +
      "重新变成一句散文。r22 的本体就是那张判别式，它没了就没有任何东西可判"
    );
  }
  // 只取 orgChangeSchema 那一段，不拿整份文件：`"add_node"` 在别的 schema 里
  // 出现（或在一句注释里出现）都不能算「判别式里有这一种 kind」。
  const union = sliceFrom(
    graph,
    "export const orgChangeSchema",
    "export type OrgChange",
  );
  if (union === null) {
    return (
      "org/graph.ts 还在，但读不到 `orgChangeSchema` 那一段了 —— 于是「三种 kind 都在判别式里」" +
      "这一格退回了【整份文件里搜一下】，而那正是把「文本在场」当成「那一格还在」"
    );
  }
  if (!union.includes('kind: z.literal("add_node")')) {
    return (
      "orgChangeSchema 的判别式里没有 add_node 那一支了 —— round294 那条「契约里有一条" +
      "带判据的加角色路」当场过期。它此前【有过】 ⇒ 这一格红的时候别去改主张，" +
      "先问是谁把那条路撤了（撤回是一次决定，不是一次清理）"
    );
  }
  // ── ② hub：那两处 分派【仍在真调判据】，不是只剩一条注释 ────────────
  let commit: string;
  try {
    commit = f.src("org/commit.ts");
  } catch {
    return (
      "packages/hub/src/org/commit.ts 不在了 —— 契约里那条 kind 失去了唯一的执行者，" +
      "「带判据」三个字没人兑现（形状在、判据在、但没人把它们接起来）"
    );
  }
  const code = withoutComments(commit);
  // ⚠ 这一格先于【调用在不在】那一格，是变异机器逼出来的：只判「文件里有
  // `validateNewNode(change.node, graph)`」时，把分派条件写成
  // `else if (false && change.kind === "add_node")` 那份【调用字节仍在】、
  // 只是永远走不到 ⇒ 判据绿。那一发（M8）实测过：端到端红而本判据不红。
  // 「调用在」不等于「那条分派活着」，与 r20 之二（抹 import 列表里那一行而函数体
  // 里还有同名调用 ⇒ 得手一个绿）是同一条教训的另一个方向。
  if (!code.includes('} else if (change.kind === "add_node") {')) {
    return (
      'commit.ts 的 revalidate 里那条【分派条件】不再是 `change.kind === "add_node"` —— ' +
      "下一格那句调用可能还在文件里，但它永远走不到（把条件短路成 false 是这一格最省字的改法）。" +
      "那种形状下 add_node 会掉进 noUntouchedKind 而抛，或掉进默认放行而静默不校验"
    );
  }
  if (!code.includes("validateNewNode(change.node, graph)")) {
    return (
      "commit.ts 的 revalidate 不再【调用】validateNewNode（剥掉注释之后那份文件里读不到" +
      "这个调用）—— 那条 kind 还在、那条判据也还在，中间那一根线断了，" +
      "而剩下的注释会替它说「新节点走 L1」。这是本判据唯一为「只剩一条注释」写的形状"
    );
  }
  if (!code.includes("nodes[change.node.role_id] = change.node")) {
    return (
      "commit.ts 的 applyChangeToGraph 不再把新节点【按 role_id 当键】写进 nodes —— " +
      "校验放行而图不变，比校验缺失更坏：审计里的 after 快照会说「图成了 A」而库里是 B" +
      "（那正是这个纯函数存在的理由）"
    );
  }
  if (!code.includes("function noUntouchedKind(change: never): never")) {
    return (
      "commit.ts 里那个【没有分派就抛】的类型兜底不在了 —— 它的函数头写的正是这一种改法：" +
      "「补判据，不要补 else 分支的默认放行」。换成默认放行 ⇒ 加第四种 kind 时" +
      "tsc 不再说话，而那种变更不校验就能进库"
    );
  }
  // ── ③ 分工：新节点那条判据仍然【不判】家族，整图那条仍然被调 ────────
  let validate: string;
  try {
    validate = f.contracts("org/validate.ts");
  } catch {
    return (
      "packages/contracts/src/org/validate.ts 不在了 —— 「add_node 的新节点逐条判过」" +
      "重新变成一句散文，而本判据②那一根线现在连向一个不存在的目标"
    );
  }
  const body = sliceFrom(
    validate,
    "export function validateNewNode(",
    "export function",
  );
  if (body === null) {
    return (
      "validate.ts 还在，但读不到 `validateNewNode` 的定义 —— 上面②那句调用连向一个不存在的东西，" +
      "而「读不到定义」与「定义改了名」在这里必须分开报：前者是取材，后者是主张过期"
    );
  }
  // 判【剥掉注释之后的函数体】：那个函数头此刻有三段话在解释「为什么这里【故意】不判
  // model_family」。如果只看原文，那些注释本身就会替「判了家族」投一票（它们反复提到
  // 那个 code），这一格会恒绿。
  const bodyCode = withoutComments(body);
  if (bodyCode.includes("model_family")) {
    return (
      "validateNewNode 的【代码】里出现了 model_family —— 同一件事从此有两处口径" +
      "（这里一处、everyNodeDeclaresModelFamily 一处），而两处会漂是本仓治过最久的那一族。" +
      "正确的修法不是删这里那一段，是把整件事收回【那一处】：缺家族由那条拦，" +
      "code 同为 unknown_model_family（测试钉的是【继承】）"
    );
  }
  if (!code.includes("everyNodeDeclaresModelFamily(after)")) {
    return (
      "commit.ts 不再对 after 图跑 everyNodeDeclaresModelFamily —— 于是上面那条「本函数" +
      "故意不判家族」从一次【分工】变成一次【漏判】：缺家族的新节点可以进库了，" +
      "而 round292 那条主张（旁路不再有免检）与 r22 的分工同时失守"
    );
  }
  return "";
}

/**
 * r23：那条「整图委派边门控」自检的【结构】还在（round298）。
 *
 * 为什么这条判据【不打开数据库】：那条自检的结论今天是 not_observable
 * （实测 dev.db 的 delegation_graphs 0 行），而「报告里那一格写着什么」由
 * integrity.test.ts 那 7 发钉 —— 这里再跑一遍库就是两处口径互抄。
 * 本判据只核那一族「结构还在 + 分工没漂」：注册在不在、扫描范围有没有被静默降级、
 * schema 那道判有没有被撤、以及那条 not_observable 文案里的假句子有没有回来。
 *
 * 五格里三格是【反向】的（诱人错法落下就红），因为它们对应的正是三个
 * 「看起来更合理」的改法：只扫最新版（"旧版本谁还在用"）、把 `!== true` 松成
 * `== null`（"false 至少填了东西"）、撤掉 schema 那道（"读取口本来就做强转，
 * 这里何必再判一次"）。每一个都比原写法省字，每一个都让那一格静默失效。
 */
function delegationEdgeSelfCheckCheck(f: Files): string {
  let text: string;
  try {
    text = f.src("db/integrity.ts");
  } catch {
    return (
      "packages/hub/src/db/integrity.ts 不在了 —— 「库里有一条跑在整图上的门控自检」" +
      "重新变成一句散文。r23 的本体就是那份自检，它没了就没有任何东西可判"
    );
  }
  const code = withoutComments(text);
  // ── ① 名单：那条名字还在 ────────────────────────────────────────────
  // 只取 CHECK_NAMES 那一段：那个名字在函数体里也出现（`const name: CheckName = …`），
  // 拿整份文件搜会把「名字还在名单里」判成「名字在文件里出现过」。
  const names = sliceFrom(
    text,
    "export const CHECK_NAMES = [",
    "export type CheckName",
  );
  if (names === null) {
    return (
      "integrity.ts 还在，但读不到 CHECK_NAMES 那一段了 —— 于是「名单里有这一格」退回了" +
      "【整份文件里搜一下】，而那正是把「文本在场」当成「那一格还在」（同 r22 之①）"
    );
  }
  if (!names.includes('"delegation_edges_gated"')) {
    return (
      "CHECK_NAMES 里没有 delegation_edges_gated 了 —— 报告不再声明这一格。" +
      "它此前【有过】⇒ 红的时候别去改主张，先问是谁把那一格撤了（撤回是一次决定）"
    );
  }
  // ── ② 注册：名字在名单里而没人跑它 ⇒ 比没有这一格更坏 ────────────────
  // 单列一格不与①合并：`guarded(` 那行被摘掉之后，报告里那一格【不会再出现】，
  // 而读报告的人看见的是「其余八格全 ok」—— 少一格和那一格报 ok 是两种假绿，
  // 后者会让人以为有人判过。两发的修法也相反（一个补名单，一个补注册）。
  if (!code.includes('guarded("delegation_edges_gated"')) {
    return (
      "delegation_edges_gated 还在名单里，而 auditCoherenceReport 的 guarded 数组不再跑它 —— " +
      "名字在报告里从此消失，于是「那条自检一直在报 ok」这种假绿变成了更隐蔽的" +
      "「那一格压根没出现」。名单里有而没人跑 = 一份恒绿的自检"
    );
  }
  // ── ③ 函数体：三格反向，各自对应一种「看起来更合理」的改法 ────────────
  const body = sliceFrom(
    text,
    "function delegationEdgeGateCheck(",
    "/** zod 错误压成",
  );
  if (body === null) {
    return (
      "integrity.ts 还在、注册那行还在，但读不到 delegationEdgeGateCheck 的定义 —— " +
      "上面那根线连向一个不存在的东西（读不到定义与定义改了名在这里同为红，" +
      "因为注册与定义缺一半都是同一件事故）"
    );
  }
  const bodyCode = withoutComments(body);
  // 反向之一：只扫最新版。这条是【最便宜的一次静默降级】—— SQL 里多一个 WHERE，
  // 今天的真库 0 行 ⇒ 两种写法读数【完全相同】，所以它不会在任何现存数据上红。
  if (
    !bodyCode.includes("FROM delegation_graphs ORDER BY version") ||
    bodyCode.includes("MAX(version)")
  ) {
    return (
      "delegationEdgeGateCheck 的 SQL 不再是「扫全部版本」—— 老版本是【活的】：" +
      "任务盖着自己的 graph_version 读图，而 readGraphByVersion 刻意在版本缺失时抛错、" +
      "不退回最新版。只扫最新 = 报告 ok 而那个老任务继续跑一条无门控的脏边。" +
      "⚠ 今天真库 0 行 ⇒ 这一格在真实数据上【不会】红，它只被夹具钉着（integrity.test.ts 那一发 v7 净 + v3 脏）"
    );
  }
  // 反向之二：`!== true` 松成 `== null`。false 是【填了】的值。
  if (!bodyCode.includes("e.review_gate !== true")) {
    return (
      "门控判据不再要求 `review_gate !== true` —— 换成「填没填」就把 false 放过去了，" +
      "而 false 恰恰是那条【显式关掉门控】的值（§8.2 第 4 条要防的就是它）"
    );
  }
  // 反向之三：撤掉 schema 那道，退回「信读取口的强转」。
  if (!bodyCode.includes("orgGraphSchema.safeParse(raw)")) {
    return (
      "读边之前不再过 orgGraphSchema —— 读取口今天全是 `JSON.parse(...) as OrgGraph` 强转，" +
      "强转把「契约说不」变成「没人知道」。`{nodes:{}, edges:{}}` 那种形状" +
      "（test/graph 的存根图当年就长这样）从此在这一格里隐身"
    );
  }
  // 分工那一格：空表【不许】混进 ok。
  if (!bodyCode.includes("if (edges === 0) {")) {
    return (
      "「整库一条委派边都没有」不再单独成栏 —— 空图会读成 ok，而本文件 ④ 节写的正是" +
      "「空不是通过」（0016 §4b 那一格）。没有对象的自检与合规的自检必须分得开"
    );
  }
  // ── ④ 文案：那条假句子不许回来（与 M5 同一格，口径不同）──────────────
  // M5 测的是「zero-producer 抓得到」；这里测的是「登记表不许它回来」。
  // 两处都抓不是重复：那台读的是「这句话与代码现状对不对得上」，
  // 这一格读的是「这句已经被证伪的话有没有被写回来」。
  // ⚠ 判【剥掉注释之后】的整份文件：那句假话落在 detail 的字符串字面量里（= 代码），
  // 而它随时可能被下一个人【写在注释里当反面教材】—— 判原文会因为一句诚实的注释而假红。
  // 方向不对称是这里的重点：判代码 ⟹ 注释豁免（该绿）；判原文 ⟹ 注释定罪（假红）。
  if (code.includes("没有任何 INSERT INTO delegation_graphs")) {
    return (
      "not_observable 的文案里出现了「src 里没有任何 INSERT INTO delegation_graphs」—— " +
      "那句是【假的】：写入方是 org/commit.ts 的 INSERT_DELEGATION_GRAPH_SQL，生产路径在调。" +
      "0063 / zero-producer.ts 那一格说的就是「文案里的事实断言会过期而文案本身恒绿」，" +
      "本轮 M5 实测过它抓得住 zero-producer，而 ⑤b 那两行 toContain【抓不到】"
    );
  }
  if (!bodyCode.includes("INSERT_DELEGATION_GRAPH_SQL")) {
    return (
      "空表那一格的文案不再指名写入方 —— 少了这个名字，读者只能从「表是空的」推回" +
      "「没人写得进去」，而那正是上面那条假句子的形状。指名字节比写一句形容词便宜，" +
      "而且它能被这一格核对"
    );
  }
  return "";
}

/**
 * r24 的判据：「节点键 === node.role_id」这条不变量今天【由 schema 判】。
 *
 * 权威落点只有一份：`packages/contracts/src/org/graph.ts` 的 orgGraphSchema。
 * 本文件不抄那条判据的字节，只做「那句话的权威字节此刻还在不在」的核对。
 *
 * 为什么值得单独一条主张，而不是算在 r22 名下：r22 判的是【add_node 那条路】
 * 的结构与分工，它自己的射程④ 明写「键与 role_id 不一致这一格今天没有任何判据」。
 * 那一格今天翻向了 —— 继续把它留在 r22 的射程里，那条主张就变成一句过期陈述。
 * 所以 r22 的射程④ 本轮要改口，而翻向后的事实由本条管。
 *
 * ⚠ 七格全判【剥掉注释之后】的字节（`withoutComments` 的两个洞见 r22 的 method）。
 *   这一族的注释比代码长得多：那段 superRefine 的函数头有整段在解释
 *   「为什么不落在 validate.ts」，判原文的话那些话会替「判了」投一票。
 *   两处前提格也剥注释，理由不同但更硬：那两格找的是「这条接线还在」，
 *   而断线之后最可能出现的一句话就是「这里以前用的是 orgGraphSchema」。
 *
 * ⚠ 三处读取各包 try（r23 那一族的纪律）：fakeFiles 缺键是【抛】，不包的话
 *   夹具自己的毛病会红成「权威落点没了」——把测试的 bug 伪装成主张过期。
 */
export function nodeKeyIdentityCheck(f: Files): string {
  // ⚠ 三处读取各包一层 try：fakeFiles 的 contracts()/src() 在【缺键】时抛，
  // 而抛出去的红与「文件真的没了」在断言上逐字一样（r23 同一族，那边踩过）。
  // 没有这层包装，夹具少给一个键会红成「那条判据没了」——那是本项目最坏的一种红：
  // 它把测试自己的毛病伪装成主张过期。
  let graph: string;
  try {
    graph = f.contracts("org/graph.ts");
  } catch {
    return (
      "packages/contracts/src/org/graph.ts 不在了 —— 「键必须等于 role_id 由 schema 判」" +
      "这句话的权威落点没了，本条无物可判。" +
      "（另一种触发方式是【夹具少交了这个键】，fakeFiles 的缺键就是抛；" +
      "所以合成用例每一发都得经 r24Good() 交出这个键，见 claims-registry.test.ts）"
    );
  }
  const seg = sliceFrom(
    graph,
    "export const orgGraphSchema = z",
    "export type OrgGraph",
  );
  if (seg === null) {
    return (
      "读不到 orgGraphSchema 那一段 —— 本条主张的权威落点改名或挪走了。" +
      "（读不到定义与定义被搬走在这里同为红：两种情况下这条判据都在核对一个它找不到的东西）"
    );
  }
  const code = withoutComments(seg);

  // ── ① 取材自证：切片【确实】切到了带 superRefine 的那一段 ──────────────
  // 没有这一格，下面每一发"没找到"都分不清是【判据被摘】还是【切片切早了】。
  if (!code.includes(".superRefine(")) {
    return (
      "orgGraphSchema 上不再有 superRefine —— 「键必须等于 node.role_id」这条【整个没了】。" +
      "键空间读者（gate 0 / handoff / modelFamily / 岗位书落库）与值空间读者" +
      "（汇报根 rootsOf、下级名单 subordinateRoles）会再度各说一半，" +
      "而升级判据那句 `上级 === CEO` 两头各拿一半 ⇒ 永不成立 ⇒ 升级永不触发。"
    );
  }
  // 遍历的是 nodes 而不是别的集合（round299 变异机 M3 那一发逼出来的格子）：
  // 写成 Object.entries(graph.edges) 时判据"存在"，而且凶到把合法图全拒。
  if (!code.includes("Object.entries(graph.nodes)")) {
    return (
      "那条 superRefine 还在，但它遍历的【不再是 nodes】—— 判据存在不等于判据判的是这件事。" +
      "（实测：换成遍历 edges，schema 会把每一张带委派边的合法图拒掉，" +
      "同时放过真正的键≠自称 —— 一种同时漏判与误判的错法）"
    );
  }
  // ── ② 比较【方向】：一致才跳过 ────────────────────────────────────────
  // 这是最像"修好了"的坏法：反着写照样会拒一批请求，所以只判"坏图被拒"抓不到它。
  if (!code.includes("if (node.role_id === key) continue;")) {
    return (
      "那条 superRefine 里读不到 `node.role_id === key` 这个方向 —— 判据方向" +
      "一旦翻成「不一致才跳过」，它会把所有合法图当坏图、把坏图当合法图，" +
      "而它【照样会拒请求】，所以只看状态码的测试发现不了"
    );
  }
  // ── ③ 诊断指得到那一个键 ─────────────────────────────────────────────
  // path 是两处消费者唯一读得出的字段（hub 的 org.ts issuesOf 出 422 正文、
  // hub 的 db/integrity.ts issueSummary 出自检报告），塌成一层就两边同时失去"是哪一个"。
  if (!code.includes('path: ["nodes", key, "role_id"]')) {
    return (
      "那条 superRefine 不再把 issue 的 path 指到 nodes.<键>.role_id —— " +
      "图【照样被拒】，但 422 正文与自检报告同时说不出是哪一个键自称了别的 id，" +
      "提交的人只能自己逐节点找（0006 §7 那一族：拒对了但没人能修）"
    );
  }
  // 报的是【每一个】坏键，不是遇到第一个就退：一次 422 要能看完就修完。
  if (code.includes("break;") || code.includes("return;")) {
    return (
      "那条 superRefine 里出现了 break/return —— 多个坏键时只报第一个，" +
      "CEO 要改一次发一次、连改 N 轮才看到全貌"
    );
  }

  // ── ④ HTTP 那一路【吃的就是这一份】schema ─────────────────────────────
  // 本条主张里有半句是「直接交一张新图【进不了库】」—— 那半句的成立前提是
  // 请求体里的 graph 字段用的就是上面那份 orgGraphSchema。api.ts 哪天内联一份
  // 自己的 graph 形状，这半句就过期，而上面三格会【全绿】（它们只判 schema 本身）。
  let api: string;
  try {
    api = f.contracts("api.ts");
  } catch {
    return (
      "packages/contracts/src/api.ts 不在了 —— 于是「HTTP 那一路吃的就是这份 schema」" +
      "这一格读不到了。⚠ 上面那几格在这一发下【照样是绿的】：它们判的是 schema 本身。"
    );
  }
  // ⚠ 判【剥掉注释之后】的字节，与上面五格同一口径。差别在这里更实用：这一格找的是
  // 「那个字段还挂着这份 schema」，而一份写着「graph 字段改成内联形状了，
  // 原本用 orgGraphSchema」的诚实注释，在判原文的口径下会替那条已经断掉的接线投一票。
  if (!withoutComments(api).includes("graph: orgGraphSchema")) {
    return (
      "api.ts 里 `graph:` 字段不再直接挂 orgGraphSchema —— 请求体吃的可能是另一份形状。" +
      "⚠ 上面三格在这一发下【全绿】：它们判的是 schema 本身，判不出【这条路上用的是它】。" +
      "（r23 那一条教过同一件事：读取口全是强转时，schema 判得再对也没人执行它）"
    );
  }
  // ── ⑤ 落库那一侧仍然只有一条 INSERT（否则"进不了库"这句要重算）────────
  // 主张说的是「这条路塞不进库」。hub 里若长出第二个写 delegation_graphs 的口子，
  // 那条 schema 判据管不到它，这句话就从"契约层"的实话变成"全局"的假话。
  let commit: string;
  try {
    commit = f.src("org/commit.ts");
  } catch {
    return (
      "packages/hub/src/org/commit.ts 不在了 —— 「键≠role_id 的图进不了库」那句的" +
      "前提（写入口就是那一条 INSERT）读不到了。" +
      "⚠ 上面那几格在这一发下【照样是绿的】。"
    );
  }
  // ⚠ 同样判剥注释后的字节：这个名字现在【只出现在代码里】（一份定义 + 三处调用，
  // 实测过），所以剥注释不会误伤；而将来一句「这条 SQL 以前叫 INSERT_DELEGATION_GRAPH_SQL」
  // 的注释会在判原文的口径下替一个已经不存在的写入口投一票。
  if (!withoutComments(commit).includes("INSERT_DELEGATION_GRAPH_SQL")) {
    return (
      "org/commit.ts 里不再出现 INSERT_DELEGATION_GRAPH_SQL —— " +
      "「键≠role_id 的图进不了库」这句话依赖【写入口就是这一条】这个前提，" +
      "前提漂了本条就得重算（而不是自动成立）"
    );
  }
  return "";
}

/* ═════════════════════ 登记表 ═════════════════════ */ export const REGISTRY: readonly RegistryEntry[] =
  [
    {
      id: "r1",
      claim:
        "budgets.hard_stop 的【记账路径】写不出 0：记账那几处（tracker 的 DO NOTHING、" +
        "budget-sync 的 DO UPDATE、dev-seed）hard_stop 全是字面量 1；唯一能写 0 的是 " +
        "POST /budget 的 upsert（http/budget.ts，绑定参数 = 界面那个「硬停」勾选框），" +
        "它是登记在 HARD_STOP_BIND_WHITELIST 里的显式软限入口 —— 名单外再多一处绑参写点、" +
        "或那一处形状变了/没了，判据红。" +
        "⚡【2026-11-19 补上另一半】那一列今天【有读方】：underTaskBudgetSql 读它，" +
        "hard_stop = 0 的那一格超预算不禁 spawn（五条 SQL 同源共用那一个函数）。" +
        "两句合起来才叫开关 —— 写得出一列而没人读是装饰，有人读而写不出是恒真判据。" +
        "⚠ 射程：它【不判】「读得对」，判的是【那半条字节还在且括号还在】；" +
        "语义那一格归 packages/hub/test/budget/hard-stop-gate.test.ts 那十发" +
        "（其中一条【摘掉外层括号就红】，全仓唯一看得见那件事的）",
      method:
        "test/arch/claims-registry.test.ts › r1 判据：扫 src 全部 INSERT INTO budgets 的 VALUES" +
        "（字面量 0 一律红；绑定参数只准名单内那一处，且名单内必须逐字含登记形状；" +
        "名单外的 upsert 改 hard_stop 也红）；取材非空由同文件真仓库那一发钉住。" +
        "读侧那一半（hardStopReaderCheck，判【剥掉注释之后】的字节，口径同 r23/r24）：" +
        "charter-pump.ts 里有 `SELECT b.hard_stop FROM budgets b` ⇒ 没有它红" +
        "（那一列退回没人读）；收尾那半条 `, 1) = 0)` 逐字在 ⇒ 不在就红" +
        "（判据方向翻或最外层括号被摘，两种都在这一格响）。" +
        "外加打在真字节上的变异：写侧四格见 .workbuddy/round309-mutate-hard-stop.mjs" +
        "（六发、命中 6/6、逐字节回滚；M1b 那一发【只跑旧的三个文件】全绿 = " +
        "那三条老测试对 hard_stop 零射程的证据；M4 那一发【全绿】= " +
        "COALESCE(hard_stop, 1) 的兜底值今天不承重，登记的盲区）。" +
        "读侧那两格另有合成变异打在【真 charter-pump.ts 文本】上（本文件 r1 读侧那一族，" +
        "含一发【抹掉代码而只留一句「这里以前读它」的注释】—— 那种形状必须【仍然红】，" +
        "它是「判剥注释后的字节」与「判原文」两种写法之间唯一的方向证据）",

      judge: "claims-registry",
      checkedAt: "2026-11-19",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 186,
        sentence: "没有任何代码能把它写成 0",
      },
      check: hardStopZeroCheck,
    },
    {
      id: "r2",
      claim:
        "超时执行者已接进心跳巡检（serve/assemble.ts 的每一跳调 runTimeoutPass，到期卡真的动）",
      method:
        "test/arch/claims-registry.test.ts › r2 判据：serve/assemble.ts 必须含 runTimeoutPass( 调用",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 183,
        sentence:
          "只被 GET /approvals 读出去展示；到期什么都不发生（旧主张，round265 划掉；round268 接线后本条翻向「接线必须在场」，落地块见 O10 节）",
      },
      check: timeoutWiredCheck,
    },
    {
      id: "r3",
      claim:
        "`makeChannelActorResolver`（把 channelId → 平台 → 角色的那座桥）的读者在场：" +
        "channels/approval-bridge.ts 的 actorFor 就是它（round280 之前这条是「零调用方」，" +
        "判据方向随之翻向「读者必须在场」，同 r2 那次的剧本）",
      method:
        "test/arch/claims-registry.test.ts › r3 判据：channels/approval-bridge.ts 在场且调用 makeChannelActorResolver(",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1339,
        sentence:
          "makeChannelActorResolver（把 channelId → 平台 → 角色的那座桥）零调用方",
      },
      check: resolverWiredCheck,
    },
    {
      id: "r4",
      claim: "BudgetPaused 事件今天零发布点（BudgetTracker 没有 new 点）",
      method:
        "test/arch/claims-registry.test.ts › r4 判据：扫 src 里 new BudgetTracker（实例化即发布点）",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1059,
        sentence:
          "BudgetTracker（全仓唯一算 breached、唯一发 BudgetPaused 的东西）没有 new 点",
      },
      check: budgetPausedNoEmitCheck,
    },
    {
      id: "r5",
      claim:
        "review_gates 表在 src 里零 INSERT（db/integrity.ts 与 role-memory.ts 都这么说）",
      method:
        "test/arch/zero-producer.test.ts › REGISTRY 里的 review_gates zero 条目（双向核对）",
      judge: "zero-producer",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 737,
        sentence:
          "review_gates 表仍然零 INSERT（db/integrity.ts 里有一条自检明说这件事）",
      },
      check: (f) => zeroProducerHas(f, "review_gates", "zero"),
    },
    {
      id: "r6",
      claim:
        "src 里没有任何 INSERT INTO approvals（该句是已过期主张的原文，登记为引用）",
      method:
        "test/arch/zero-producer.test.ts › REGISTRY 里的 approvals quoted 条目（原文被引用故为 quoted）",
      judge: "zero-producer",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 143,
        sentence:
          'approvals/cards.ts 文件头与 heartbeat/patrol.ts：grep -rn "INSERT INTO approvals" 在所有 src 目录下 0 命中（已过期）',
      },
      check: (f) => zeroProducerHas(f, "approvals", "quoted"),
    },
    {
      id: "r7",
      claim:
        "policy/auto-approve.ts 无生产【写者】（round269 起读路径有读者：approvals/query.ts 的影子判定调 autoApprove；写者=recordAutoApproval 的调用方仍为零）",
      method:
        "test/arch/claims-registry.test.ts › r7 判据：扫 src 除定义文件外对 recordAutoApproval 的调用 ＋ query.test.ts ⑦ 的调用方名单",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1217,
        sentence: "O9 自动批准：691 行判据，0 个调用方",
      },
      check: r7NoWriterCheck,
    },
    {
      id: "r8",
      claim:
        "harness/ 整目录对外零 import（约 3300 行安全层没有任何 src 内 importer）",
      method:
        "test/arch/dead-modules.ts › BASELINE 里 harness/* 四条（双向）；独立判据见死模块哨兵验收",
      judge: "dead-modules",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 901,
        sentence: "harness/ 整目录对外零 import",
      },
      check: (f) => {
        // ⚡ round312（O6 Step B 接线）：harness/gateway.ts 与 harness/safety.ts
        // 不再是死模块 —— runtime.runTurn 经 gateway-runner 真调 callHarness，安全层
        // 真的前置跑在每次 spawn 之前，且它们都弹出了 dead-modules 的 BASELINE（方向 B）。
        // 这一格只对账【仍在 BASELINE 里的那两家】：routing / verifier。
        // 文案一旦又要把 gateway/safety 当「零调用方」登记，是【它先红】而不是守卫先红。
        const needed = ["harness/routing.ts", "harness/verifier.ts"];
        return needed
          .map((n) => deadModulesHas(f, n))
          .filter((x) => x !== "")
          .join(" | ");
      },
    },
    {
      id: "r9",
      claim:
        "岗位书的 acceptanceCriteria / honestyBoundaries / forbiddenActions / decisionScope / judgmentMode / escalationTriggers 有读者：charter/prompt.ts 逐字段渲染，而渲染结果就是 engine/claude.ts 的 --append-system-prompt（读者=提示词，不是执行器）",
      method:
        "test/arch/claims-registry.test.ts › r9 判据：charter/prompt.ts 必须逐字段出现 c.<字段> 的属性访问，且 engine/runtime.ts 必须调 renderCharterPrompt(",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 180,
        sentence: "forbidden_actions / decision_scope / honesty_boundaries",
      },
      check: charterFieldsReadCheck,
    },
    {
      id: "r10",
      claim:
        "`pnpm lint`（= verify 的第一段）今天恒红，且红因是既有基线（HEAD 干净树同样红）" +
        "而非本轮新代码；这一格由一张「只许减不许增」的基线表看着，新增 error 种类当场红",
      method:
        "test/arch/lint-baseline.test.ts › 棘轮判据（合成读数变异）＋真仓库那一发；" +
        "本条判据只核对那份守卫的档案还在、且还声称管 `pnpm verify`（不重跑 biome，避免两处各测一次互相漂）",
      judge: "lint-baseline",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1805,
        sentence: "本篇之外还有一份计划文档，而它的出口门前提今天不成立",
      },
      check: r10LintGuardCheck,
    },
    {
      id: "r11",
      claim:
        "全仓每句指向计划的编号引用都指向计划里真存在的小节；且这条判据的取材必须同时覆盖 " +
        "docs 的 markdown 与全部 ts —— 只扫代码的那个口径曾漏掉全部 2 处真悬空。" +
        "⚠ 这里【不抄标题数与引用数】：本轮量到 58 / 1061，而 r10 那一格刚立的规矩是" +
        "「上限会随修复下调，期望值一定会过期」—— 读数由 plan-refs.test.ts 的分块下限看着，不活在主张里",
      method:
        "test/arch/plan-refs.test.ts › 四发合成变异（P1 哨兵 / P2 前缀匹配 / P3 计划缺失 / P4 静默窄口径）＋真仓库那一半；" +
        "本条判据不重跑取材，只核对那份守卫还在、且取材里仍有 docs 那一块（口径被悄悄改窄=空壳守卫）",
      judge: "plan-refs",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1896,
        sentence: "上一格那条计划引用守卫，落地后被自己的变异打回过一次",
      },
      check: r11PlanRefsGuardCheck,
    },
    {
      id: "r12",
      claim:
        "计划每一条【验收行】点名的工件路径逐字存在（或被一行显式豁免标着）；" +
        "本轮实测三条 Run 行点名的旧住址【逐字不存在而命令今天全绿】—— " +
        "因为 vitest 把参数当子串过滤器而不是当路径。⚠ 同样不抄读数：命中与豁免的数目由 plan-gate-paths.test.ts 钉",
      method:
        "test/arch/plan-gate-paths.test.ts › 五发合成变异 + 三发真仓库；" +
        "外加打在真文档上的 G1–G4（.workbuddy/round276-gate-path-mutate.mjs，自恢复）；" +
        "本条判据不重跑 existsSync，只核对那份守卫还在、且还在真的查住址",
      judge: "plan-gate-paths",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1927,
        sentence: "计划的 6 道出口门禁，今天",
      },
      check: r12GatePathGuardCheck,
    },
    {
      id: "r13",
      claim:
        "`--permission-mode plan` 是今天真的员工身上唯一生效的安全边界，且它由两层独立守卫看着：" +
        "静态四判据（spawn 点基线 / plan 与 FLAG 的【相邻性】/ 诚实标注在第一行代码之前 / 探针键名单非空）" +
        "＋一条真起子进程的行为探针【带正向对照】。立它之前的读数：把它改成 bypassPermissions ⇒ 全仓零红。" +
        "⚠ 三条已知余量写在守卫文件头，不进自动检查：改名 import 的 spawn 扫不出（变异 B5 把它钉成预期绿）、" +
        "换成 SDK 调用则整条失效、判据只查探针代码在而不重跑探针",
      method:
        "test/arch/role-spawn-boundary.test.ts › 底座一发（好夹具必须【不红】）+ B1–B6 六发合成变异 + 4 发真仓库；" +
        "外加打在真文件上的五发（.workbuddy/round277-boundary-mutate.mjs，自回滚，含 B5 预期绿）；" +
        "行为那一发在 packages/hub/test/engine/claude.test.ts，正向对照是它的一半价值；" +
        "本条判据不重跑子进程，只核对那份守卫还在、相邻判据仍逐格比对、探针键仍逐个核对",
      judge: "role-spawn-boundary",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1991,
        sentence:
          "今天真的员工身上唯一生效的安全边界，此前一条守卫都没有 —— 顺带量到 `tsc -b` 从不检查测试",
      },
      check: roleSpawnBoundaryGuardCheck,
    },
    {
      id: "r14",
      claim:
        "本登记表自己那些 `source.line` 有人核，且核它在【门禁里】而不只是一个要靠人想起来跑的脚本 —— " +
        "立它之前的读数：往 §5 插一段 ⇒ §7 全体下移 35 行 ⇒ r10–r13 四条同时 STALE 而 test/arch 304 发全绿" +
        "（`renderMarkdown` 不渲染 line ⇒ 那张表「逐字一致」的守卫对坐标是瞎的）。" +
        "⚠ 已知余量：锚点取主张首行的前 30 个字符，那一格被改写到 30 字以内不同就判漂；" +
        "同一句话在文档里多处命中时只要求【登记那一格命中】，不判唯一性",
      method:
        "test/arch/claim-coords.test.ts › 真仓库 3 发（逐条坐标 + 取材非空 + 锚点至少一处命中）+ 5 发合成变异；" +
        "外加打在【真文档】上的三发（.workbuddy/round278-claim-coords-mutate.mjs，自回滚 + 逐字节核对）：" +
        "C1 往 §5 插一行 = 本轮真发生的形状 / C2 换掉锚点句 / C3 掏空判据（真仓库那一发【不红】）；" +
        "本条判据不重跑坐标核对，只核对那份守卫在场、那句比较还在、非空那一发没被摘掉",
      judge: "claim-coords",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2047,
        sentence: "本篇自己的坐标从来没有门禁",
      },
      check: claimCoordsGuardCheck,
    },
    {
      id: "r15",
      claim:
        "【round294 撤回本条的标题】原标题「`POST /org` 提交不了一个新角色 —— 契约里没有" +
        "带判据的 `add_node`，而落库的是【请求体那张图】」—— 现在【提交得了】了，" +
        "契约里有 add_node，落库前逐条判过（见 r22）。留下这段话是因为它记的是一件" +
        "比「主张过期」更贵的事：本条的判据在翻转之后【照样全绿】，" +
        "而它绿的原因换了 —— 它变成了一个假证人。" +
        "【round292 改口，那时无效的是后半句】原文接着写「`revalidate` 只按 `reparent` 与 " +
        "`add_edge` 两种 kind 分派 ⇒ 一个新节点随一条与它【无关】的合法 `add_edge` " +
        "提交能拿 200 进库，全程没有判据过手它」—— 那句在 round279 那天是真的，" +
        "round292 起【不再真】：`everyNodeDeclaresModelFamily` 在开事务前逐节点判 after 图。" +
        "【round294 再改口，那次无效的是①】它们当时写着「① 契约里确实没有带判据的 " +
        "add_node（形状没变），③ 两个前端零出口（没变）」—— ① 被本轮自己亲手改假了。" +
        "【round295 再改口，这次无效的是③，而且它不是「过期」是【假证人】】" +
        "「两个前端零出口」连着六轮【绿着】，而 `packages/web/public/app.js` 从 2026-11-11" +
        '（`git log -S` 追到 2bcbdb0）就在真发 `kind: "reparent"` —— 那发证据的扫描根只列了 ' +
        "`web/src` 与 `desktop/src`、扩展名只筛 `.ts`/`.tsx`，真控制室【不在它的视野里】。" +
        "⇒ 【round308 再改口，这次翻的是名单本身】那句「界面发得出 reparent」下面点的" +
        "两份空名单已经不空了：`{reparent:[app.js], add_edge:[app.js], add_node:[app.js]}`，" +
        "发的人仍然只有 `packages/web/public/app.js` 一个（round308 实测三种 kind 各只有一份文件写着带引号的字面量）。" +
        "⚠ 它仍然【不】等于「O8 第一跳通了」：`POST /org` 那条通道在 desktop 侧被明确拒绝" +
        "（channels.ts 那句「提交那条 POST /org【没有】通道：self-escaping CEO 写」），" +
        "浏览器里点一次更没有本机证据（0039）。" +
        "⚠ 现在准确的形状仍然是【旁路还在，但它不再是无判据的旁路】——" +
        "声明了 model_family 的新节点随一条无关的 add_edge 照样能进库，" +
        "那发反向 canary 钉的就是这一格。别把它读成 O8 第一跳通了，也别读成" +
        "「现在不能通过请求体加角色了」（那是让实现层替 CEO 关掉一条产品目标）。",
      method:
        "packages/hub/test/acceptance/new-role-to-its-own-criteria.test.ts › 11 发（① 契约形状" +
        "【round294 翻向：现在钉的是 add_node 那一支【解析得通】+ 三种捎带形状解析不通】 / " +
        "② 旁路现在被拦 + 反向 canary 只差 model_family 就该 200 / ③【round295 翻向、round308 换名单：正向点名" +
        "每种 kind 由谁发 —— 三种 kind 都只有 web/public/app.js + 引号形状 + " +
        "扫描器自身的反向 canary + 『构造了载荷』≠『发得出去』那一发】 / 正题三跳 / " +
        "加节点成功那一发 / 六种坏形状逐条 code + 零残留 / 缺家族由继承拦 / " +
        "反空转对照 / 前提自证 / 占位串因果）；test/org/validate.test.ts › " +
        "「everyNodeDeclaresModelFamily」那 6 发（含反向 canary：非边端点也判）+ " +
        "本轮新增「L1 validateNewNode：加一个新节点」那 13 发（含⭐重名抢在自环之前 / " +
        "⭐森林 / ⭐与 model_family 不重叠 / ⭐空图那条通过不是「永远通过」），" +
        "另有 schema 那一节的⭐登记一条【没判的】：键 ≠ role_id —— 它记的是【另一维】" +
        "（形状层放行），不属 L1 那一节，别按 13 发去找它）；test/org/versioning.test.ts › ⑥ 那 3 发" +
        "（拒绝零残留 / 与 L1 的顺序 / 反面对照）。" +
        "round279 那六发变异（.workbuddy/round279-o8-acceptance-mutate.mjs）里 M3 打的是【旧世界】，" +
        "round292 另跑 .workbuddy/round292-mutate-org-node-criterion.mjs 七发：M0 控制 / " +
        "M1 摘掉提交路径的采纳（红 2 发 2 文件）/ M2 判 before —— 【该绿，变异等价，" +
        "当时那句话写的是「两种 kind 都不碰 model_family」，round294 起这句话的前提变了，" +
        "矩阵里留着它就是为了那天它会翻红】/ M3 丢 trim / M4 理由不点名角色 / " +
        "M5 退回只判边端点 / M6 「只判新增节点」那个看着更精准的恒真版本 —— 命中 7/7；" +
        "本轮另跑 .workbuddy/round294-mutate-add-node.mjs（打在 add_node 那一族生产字节上）；" +
        "round295 跑 .workbuddy/round295-mutate-frontend-egress.mjs 六发【打在 app.js 与 " +
        "web/src 的真字节上】：M0 控制（行尾空注释，该绿）/ M1 reparent→add_edge（红 1 发 1 文件）/ " +
        'M2 摘掉那次 api("POST","/org") 调用（红）/ M3 kind 改带尾空格 ⇒ 三种 kind 谁都不落（红，' +
        '只有它能证「空名单会红」）/ M4 注释里写【带引号的】"add_edge"（红 = 射程边界）/ ' +
        "M5 同一位置写【不带引号】的 add_edge（该绿）—— 命中 6/6，" +
        "证据 .workbuddy/round295-frontend-egress-mutation-evidence.txt。" +
        "⚠ M4/M5 那一对是本轮【我自己的预期被推翻】的地方：第一版把边界写成「注释里提到 kind 名就红」，" +
        "跑出来 0 红 —— 真口径是【两侧带引号才算发这个变更】，那发因此是空变异。" +
        "矩阵里「该红/该绿」的预期也是主张，它没有自证，只有跑出来的红绿分布能打它。" +
        "⚠ 本条判据【仍然只核对那五格字节】（验收测试在场 + 反空转那一格 + 前提那一格 + " +
        "前端取材表【成员点名】+ 名单那三格【逐字对账】），它【不核对】「契约里没有 add_node」—— 一句否定式主张只要留在判据里，" +
        "被推翻的那天它不会红，它会继续绿着替那句假话作证。本轮就是那一天的现场。" +
        "⚠ 第五格是 round308 补的，补的是【同一条坑的另一半】：round295 把主张换成正向清单，" +
        "却没给那份清单配读者，于是它又绿了六轮才在名单翻向的当天假一次 —— " +
        "「把否定式换成正向点名」本身不是修复，点名有人对账才是。" +
        "round308 的读者三发（之七 放宽成空 / 之七·乙 切片外留诱饵注释 ⇒ 仍红 / 之八 止锚改名 ⇒ 红在边界）" +
        "外加【顺序】一发（之九：名单坏 + 取材空 ⇒ 红因必须落「不可信」，不许名单抢报）；" +
        "之九 的供电另打一台（.workbuddy/round308-mutate-r15-order.mjs：把兜底短路成 false ⇒ 之九 翻红且红因=名单抢报，" +
        "命中 3/3、自回滚逐字节核对）—— 顺序那种缺陷逐格单看全对，只有短路一遍才知道那发是不是恒绿。" +
        "磁盘侧另有 .workbuddy/round308-mutate-r15-roster.mjs 五发打在【那发验收测试的真字节】上" +
        "（命中 5/5，证据 .workbuddy/round308-r15-mutation-evidence.txt）；" +
        "⚠ 那台第一版只读文件名、把「传得进判据」写成了「答不出哪一格」，改成逐条读【用例名】重跑才发现" +
        "只对了一半：M1/M2 点得到之七本体，M4 只红在控制组上 —— 原因是诱饵抢在 replace 的锚点前面" +
        "把变异自己中和了。【打在真字节上的矩阵】与【打在合成语料上的】各有一种自我中和的方式，" +
        "这台要完整分辨率还欠「mustRed 逐条点该红那发」（round300 口径）。" +
        "【round312 落地】：.workbuddy/round311-mutate-r15-roster-fullres.mjs 已建已跑" +
        "（机器自证 5/5，打盘 3/5、逐字节回滚；M3/M4 点不到名=点名器读 FAIL 行用例名的" +
        "可观测面，不是判据失灵 —— 那份机器的文件头与 round312 台账有逐字记录）。" +
        "「登记未做」不再是今天的形状。" +
        "「契约里那条路还在、还在真调判据」那一格从此由 r22 负责，口径不同、判据也不同",
      judge: "claims-registry",
      checkedAt: "2026-11-19",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2088,
        sentence: "O8 那条端到端验收写出来了",
      },
      check: orgAddNodeGapCheck,
    },
    {
      id: "r16",
      claim:
        "一次带合法签名的 IM 回信【真的】落成一次决策：卡片 approved，且审计行 actor 是绑定的" +
        "那个角色。⚠ 射程（round282 改过一次）：桥（channels/approval-bridge.ts）从生产入口" +
        "【走得到】了 —— boot 每轮心跳经 serve/im-channels.ts 装配真飞书适配器并派发一次入站，" +
        "dead-modules 基线里那两条（abstraction / approval-bridge）如约变红并已摘除；" +
        "0030 §0 那句「actorFor 是可选钩子且今天没人传」因此过期。" +
        "但本条主张的是【这条链接通了】，不是【线上有人在用手机批卡】，两样还缺：" +
        "① 真飞书接口在本机一次也没打通过（要真凭据），本条全部绿都绿在注入的 fetch 上；" +
        "② ⚠ round283 更正：这里原本还写着「发卡那半边（deliverCard）仍零生产调用方 " +
        "⇒ 今天的形状是回得来、推不过去」—— 那句随 O12 动作 4 落地而【过期】，" +
        "投递台账见 r17。剩下的缺口换了位置：一条通道以上没有路由依据，且投递台账答不了" +
        "「到没到人手里」。" +
        "⚠ round282 顺带修掉一条【本篇之前就在的】真 bug：轮询读到的回传曾被标成 " +
        "kind:text，运行时第①步把每条批准判成闲聊而 summarize 对它刻意不说 ⇒ " +
        "手机上点了批准，Hub 一行日志都不打。那条 bug 说明 r16 此前那句「链通了」" +
        "只对长连接那一路成立，轮询那一路当时是空转的",
      method:
        "packages/hub/test/acceptance/im-reply-approves-card.test.ts › 12 发（主链路 + 状态边同源 + " +
        "广播 seq=events.id + 重投只算一次 / 反空转四发：pending 绑定走运行时、未登记通道、" +
        "直调 act + pending 绑定、决策前重查被撤权 / 装配形状四发：无身份不落库、不可逆卡直调也拒、" +
        "loadCard 脏参数、两绑定换角色）；" +
        "packages/hub/test/serve/im-channels.test.ts › 31 发（装配层唯一分母：缺 env ⇒ absent 而 Hub 照起 / " +
        "起不来 ⇒ 每轮真的重试且只说一次 / 读失败后【真的】补读 / 端到端把卡批掉 / 判决翻成人话 / " +
        "溢出与关机）；packages/hub/test/channels/feishu.test.ts › 40 发（适配器纯函数与形状：kind、" +
        "入队闸门、时间窗、渲染三种「不知道」、value 上限、凭据不进错误串）；" +
        "外加打在【生产代码】上的十发变异：round280 那四发打在桥上（.workbuddy/round280-o12-bridge-mutate.mjs，" +
        "M1 actorId 退回写死 ceo ⇒ 红 4 发 / M2 角色判据换成裸 SELECT ceo_role ⇒ 红 2 发，" +
        "且【只有】绕开通道层直调 act 那一发抓得到 / M3 摘掉落库前不可逆 ⇒ 红 1 发 / M4 摘掉决策前重查 ⇒ 红 7 发）" +
        "+ round282 那六发打在适配器与装配点上（.workbuddy/round282-o12-adapter-mutate.mjs，同自回滚 + 逐字节核对）：" +
        "M1 kind 退回 text ⇒ 红 8 发 / M2 摘掉入队闸门 ⇒ 红 3 发 / M3 水位无条件提交 ⇒ 红 1 发 / " +
        "M4 水位只推进被收下的那条 ⇒ 红 1 发（⚠ 第一次跑【全绿】：夹具时间戳顺序让两种写法读数相同，" +
        "判据因此是补对的）/ M5 错误串带上凭据 ⇒ 红 2 发 / M6 notes 不排空 ⇒ 红 4 发。" +
        "本条判据不重跑那 83 发，只核对：两份验收/装配测试在场、actor 那三条断言一条不少、" +
        "桥里那两格（重查角色 + 判可逆）还在生产代码里、装配层测试仍提 actorFor、" +
        "适配器测试仍正面断言轮询信封的 kind",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1467,
        sentence:
          "里那条真的变成 `approved`，且审计行 actor 是绑定的那个角色而不是",
      },
      check: imApprovalBridgeCheck,
    },
    {
      id: "r17",
      claim:
        "发卡那一路接上了生产入口，且重复投递由【库里那一行】挡：迁移 0009 的 " +
        "`card_deliveries` 以 (approval_id, channel_id) 为【主键】（不是唯一索引 + 自增 id），" +
        "`runDeliverPass` 每张卡先 `INSERT OR IGNORE` 抢台账、抢到才发请求，" +
        "而 `serve/im-channels.ts` 每一轮心跳在【判决之后】调它一次 ⇒ " +
        "`deliverCard` 从「有定义、零生产调用方」翻向有读者、有幂等键。" +
        "⚠ 射程三条：① 台账答不了「到没到人手里」—— 抢台账与发送失败都留下同一行，" +
        "只有日志答得出那一格而日志跨不过重启；② 多于一条通道时【干脆不推】并把理由说出来，" +
        "因为库里没有任何一列说「这张卡走哪条通道」，路由表是那一天要先补的东西；" +
        "③ 顺序翻向（先发再插）是这条链最省事的坏写法，代价是每 60 秒给审批人重推一张重复卡",
      method:
        "packages/hub/test/channels/deliver.test.ts › 17 发（真库 + 真迁移：投出去 / 第二轮一行都不重发 / " +
        "两通道各一行 / 非 pending 不推 / 发送失败【仍然】留行 / 未注册通道当场抛 / " +
        "扫描后删卡 ⇒ 接住 FK 且台账不留行 / 重启后幂等 / 四档计数互斥 / summarizeDeliver 每档都说话）；" +
        "packages/hub/test/serve/im-channels.test.ts › 装配那一格 4 发（pending 卡真的 POST 出去并落一行台账 / " +
        "第二轮一次都不发而屏幕也不重复那句话 / 判决在前⇒同轮刚批掉的卡不推 / " +
        "平台拒收时台账那一行【留着】且那一组说清怎么重推）。" +
        "⚠ `not_routed` 那一档今天【没有活的分母】：装配选项上没有插第二条通道的口" +
        "（channels 恒为一条），硬凑只能直接调 runDeliverPass 塞两条 = 测函数而不是测装配。" +
        "所以那一格今天仍只有「三档都必须说话」这条纪律 + 人的复查，别把它读成「有测试守着」。" +
        "外加打在【装配层生产代码】上的四发（.workbuddy/round283-mutate-imch.mjs，同自回滚 + 逐字节核对）：" +
        "A1 deliverRound 挪到 pollAll 之前 ⇒ 红 4 / A2 装配层根本不调它 ⇒ 红 6 / " +
        "A3 摘掉「这一轮没起来就不推」那道门 ⇒ 红 2 / A4 失败那一句不再说怎么重推 ⇒ 红 1。" +
        "外加打在【生产代码】上的六发（.workbuddy/round283-mutate-deliver.mjs，自回滚 + 逐字节核对）：" +
        "M1 顺序翻向先发再插 ⇒ 红 10/17 / M2 摘掉 FK 那一支 ⇒ 红 1 / M3 摘掉 OR IGNORE ⇒ 红 3 / " +
        "M4 未注册通道返回零计数而不抛 ⇒ 红 1 / M5 发送失败抹掉台账行 ⇒ 红 2 / M6 不可逆卡不推 ⇒ 红 1。" +
        "本条判据不重跑那 21 发，只核对：迁移里那条外键与那一对主键还在、deliver.ts 里" +
        "【抢台账在发请求之前】这个先后关系成立、INSERT OR IGNORE 没被摘、FK 那一支还在、" +
        "装配层仍调 runDeliverPass 且排在 pollAll 之后、投递测试在场且仍实测 FK",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1430,
        sentence: "round283：动作 4 落地了",
      },
      check: cardDeliveryLedgerCheck,
    },
    {
      id: "r18",
      claim:
        "那一发外网 HTTP【一定会结束】：`FeishuChannel` 给每一发（取 token / 读消息 / 发卡）" +
        "挂一个 `AbortSignal.timeout(fetchTimeoutMs)`，缺省 `FEISHU_FETCH_TIMEOUT_MS` = 10s，" +
        "而 `FeishuFetchInit.signal` 让注入实现看见【同一个】截止 ⇒ " +
        "「一次挂在半路的外网请求把 watch 占到进程退出」那一格翻向「到点就 reject，" +
        "由原来那三档说出为什么这一轮没读到」。" +
        "⚠ 射程三条：① 一发有上限 ≠ 一轮有上限 —— 一轮最多 1 次取 token + N 页读 + 1 次发卡，" +
        "乘积可越过心跳下界 60s，那一格【可接受】只因为入站走派发而不是 await；" +
        "② 适配器交出信号但【管不住注入实现读不读它】，交一份忽略 `init.signal` 的实现" +
        "（真接 SDK 那天完全可能）就让这一格在结构上失效而没有任何一发会红" +
        "（round286 量过它的【反面】：默认实现自己不转发 signal ⇒ 那一格【有】一发会红，" +
        "所以 ② 只覆盖【外部注入方】，不覆盖仓里这一条路）；" +
        "③ 畸形值（0 / 负数 / 非有限数）回落到缺省值而【不是】关掉超时",
      method:
        "packages/hub/test/channels/feishu-http.test.ts › 9 发。A 组打在【默认实现】上：" +
        "一个【接受连接但永不应答】的真本地 socket ⇒ 抛、抛的那句里没有 app_secret、" +
        "且耗时落在 [100ms, 5s) 这一带（时间下界反空转：「根本没打出去就抛了别的东西」" +
        "同样满足前两句）；正对照一发证明秒答的服务器一切正常。" +
        "B 组钉适配器：取 token 与读消息【两发都】带未失效的信号、翻页那三发【各】一个信号" +
        "（共用一个 = 第二页被第一页的时间杀掉）、注入实现读了信号 ⇒ 到点 reject 而 " +
        "supportsActionReturn 仍是 false。C 组钉那个数：交 40ms 就到点 / 交 0 与什么都不交" +
        "都是「信号在而 200ms 内没到点」（两个读数而不是一个布尔，否则「0 = 关掉超时」" +
        "与「回落到 10s」分不开）/ 负数 NaN Infinity 同样回落。" +
        "外加打在【生产代码】上的四发（.workbuddy/round284-mutate-timeout.mjs，" +
        "自回滚 + 逐字节核对）：T1 摘掉取 token 那一发的信号 ⇒ 红 7 / " +
        "T2 摘掉 #call 那一发的信号 ⇒ 红 3 / T3 一轮共用一个信号 ⇒ 红 1 / " +
        "T4 把 0 当成关掉超时（畸形值不再回落）⇒ 红 2。" +
        "外加 round286 打在【真·网络出口】上的一发（.workbuddy/round286-mutate-egress.mjs，" +
        "自回滚 + 逐字节核对）：E1 让 `defaultFetch` 不再转发 `init.signal` ⇒ 红 1" +
        "（`feishu-http.test.ts` 那发⭐「挂住的服务器」）—— 这一发是射程 ② 那句【反面】的证据。" +
        "顺带把「绊线数文件不数调用点」这一格量清了口径：hub/src 里真·网络出口只有一处" +
        "（`fetch(` 不带接收者），另外两处 `fetch` 是调注入实现 ⇒ 复算见 " +
        "`.workbuddy/round286-egress.mjs`，别抄这个数。" +
        "⚠ 那条【通用】绊线的口径：hub/src 里调 `fetch(` 的文件必须自己也构造 " +
        "`AbortSignal.timeout(` —— 它数的是【文件】不是【调用点】，" +
        "「同一文件里一发挂了一发没挂」这一格读不出来，那一格由判据点名管住今天这两处。" +
        "本条判据不重跑上面那些（9 发测试 + 5 发变异），只核对：常量与畸形值判据在场、" +
        "带截止的调用点不少于两处、" +
        "契约上有 signal 成员、那份测试在场且仍开真监听并接 init.signal、" +
        "以及那条通用绊线没有新的 offenders",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1403,
        sentence: "这一格现在【有】机器判据：r18",
      },
      check: fetchDeadlineCheck,
    },
    {
      id: "r19",
      claim:
        "测试语料从「整体在类型检查射程外」翻向「有一张【按目录】的上限表看着」：" +
        "`test/arch/test-type-baseline.ts` 用 `.workbuddy/tsconfig.tests.json` 真跑一次 tsc，" +
        "把每条错归到它所在目录，逐目录判「不许超过登记数」⇒ " +
        "§7 第 13 格那句「刻意不接成门禁」不再是今天的形状，而清零是【目标状态】不是入场券。" +
        "⚠ 射程三条：① 它【不让】`pnpm typecheck` 变绿（那是 r10 那条 lint 基线的账）；" +
        "② 一个语法错会短路整个 program ⇒ 那一刻这一发测的不是完整语料，而语料下限那条哨兵" +
        "【管不到】这一族（`--listFilesOnly` 在有语法错时照样列全）；" +
        "③ 它跑在别的测试正在改的工作树上，同一次全量里偶发「少几条」是绿的方向、测不出来；" +
        "④ ⚠【round300 改口】round296 在那条射程的尾巴上登记「`parseTscOutput` 那一侧的仓外路径" +
        "没有单测，它红在『新目录』上」—— 前半句对，后半句【只对了一半】：绝对式" +
        "（`E:/other/repo/…`）确实红，但 `../` 式【不红】，它被 `toRepoRelative` 剥掉前缀后" +
        "归成一个地道的仓内目录 ⇒ 那些错【花掉本仓那个目录的配额】，实测把 TYPE_BASELINE " +
        "每一格按 `../<该格目录>/…` 灌满能读出 291 条而 `diffTypeBaseline` 返回空字符串 " +
        "⇒ 一次「include 指向隔壁仓」的事故会逐字读出本仓的配额表并宣布合格。" +
        "那一格今天【有判据了】（两发的错误侧 + 语料侧各一条，七发变异）。" +
        "留着这段改口是因为它记着一条比它自己更值钱的教训：射程里那句「它的失效方向是红」" +
        "和「不判 X」同样是【某个时刻按当时看到的形状量的读数】，" +
        "只量了一种形状就写下方向，会把「已经想清楚了」的错觉传给后面所有人。" +
        "本轮新射程残留：`test/../other/x.ts` 那种【中间】带 `..` 的混合写法不在判据里" +
        "（不是 tsc 会输出的形状，登记而不补）",
      method:
        "test/arch/test-type-baseline.test.ts › 25 发（round300 现数：23 → 25，" +
        "加的正是下面那条仓外形状两发）。合成那一半是主力（本文件自己也在被检查的语料里 " +
        "⇒ 合成目录一律用仓里不存在的 `synthetic/…`，否则守卫把自己判红）：控制组两发（恰好在基线上 / " +
        "比基线少 ⇒ 绿）+「全修干净 ⇒ 绿」那一反恒红控制 + 路径三种写法（Windows 反斜杠 / 绝对 / " +
        "相对 / 盘符大小写）归一到同一目录 + 仓外路径不计进语料（unix 式【与】windows 式）" +
        "及其单变量对照（同位置搬进仓内 ⇒ 立刻计数）+ `../` / `./` / 根自身三种前缀各一发 " +
        "（round296 补：那三种形状注释一直在吹「实测出来的」而【只有绝对路径那一型有测试】，" +
        "删掉剥 `../` 那一整行 HEAD 版 20 发全绿 —— 实测过，不是推断）+ " +
        "⭐ round300 两发：往上跳的仓外路径不许折进仓内目录（三格：配额侧点名 / " +
        "单变量搬回仓内 ⇒ 不报 / 语料侧不计，另带【方向相反】的两条前提自证 —— " +
        "坏形状确实长得像仓内路径 + 仓内绝对路径【仍然】归一成功，" +
        "缺第二条则「raw 里有斜杠就排除」这种恒拒写法也过）+ 仓外三种形状在错误侧【计数而不是丢掉】" +
        "（同一份路径清单同时喂两个消费者，两种口径各判一次）+ " +
        "解析器两发（带位置的行、续行不算新的一发；" +
        "TS18003 那一型【不带位置】必须计入未解析而不是静默丢）+ 目录配额的四发红（多一条 / " +
        "⭐ 总量降而某目录涨 / 基线外新目录 / 新目录藏在已有错后面）+ 配额表被清空仍红 + " +
        "空壳豁免报名单 + 基线表自证（无重复、无 0 配额、每条目录现在真存在）。" +
        "真仓库那一半三发：filesChecked 下限 + unparsed=0 + 退出码与读数自洽，另加「test/arch 自己必须 0 条」，" +
        "和一发【射程 ② 的实测】：临时 project 里一个语法错 + 三个各带类型错的文件 ⇒ " +
        "只报 1 条 TS1109、三条 TS2322 一条不出、而 filesChecked 仍是 4（证明那条哨兵管不到这一族）。" +
        "外加打在【判据自己】上的六发（.workbuddy/round285-mutate-type-ratchet.mjs，自回滚 + 逐字节核对）：" +
        "M1 超出判定加 10 条容差 ⇒ 红 2 / M2 基线外目录不再点名 ⇒ 红 3 / M3 dirOf 不归一分隔符 ⇒ 红 5 / " +
        "M4 解析不出的行静默丢 ⇒ 红 1 / M5 语料下限把 node_modules 也算进来 ⇒ 红 2 / " +
        "M6 空壳豁免永不报 ⇒ 红 1。" +
        "外加 round296 那台打在【路径归一 + 仓内判定】上的六发（.workbuddy/round296-mutate-path-normalization.mjs，" +
        "自回滚 + 逐字节核对，与上一台【分开跑】）：M0 控制组该绿 / M1 仓内判定退回旧口径 ⇒ 红在「仓外不计」那发 / " +
        "M2 调用点换回旧写法（函数还在而没人调）⇒ 同上 / M3 删剥 `../` ⇒ 红在「三种形状」那发 / " +
        "M4 不剥 `./` ⇒ 同上 / M5 盘符比较改成大小写敏感 ⇒ 红在「三种写法」那发。" +
        "外加 round300 那台打在【往上跳的仓外路径】上的七发（.workbuddy/round300-mutate-upward-escape.mjs，" +
        "命中 7/7、机器自证 6/6，与前两台【分开跑】）：M0 加空注释该绿 / M1 判据恒假 ⇒ 红在新那发 / " +
        "M2 错误侧调用点退回无条件归一 ⇒ 同上（函数在而没人调）/ M3 语料侧调用点退回只判绝对式 ⇒ 同上 " +
        "/ ⭐ M4 把绝对那一半改成读 raw（读起来【更严】的写法，实际把 unix checkout 的仓内绝对路径" +
        "整个错排掉）⇒ 必须【红在老那发「只数本仓自己的 .ts」而绿在新那发】—— " +
        "这一发同时钉两件事：新判据有效，且它不是靠【一律排除】蒙对的 / " +
        "M5 反向对照：两个判据换个顺序（语义一字未动）⇒ 该绿，M0 测「加注释不算」而它测「重排不算」/ " +
        "M6 把这一族【改成用丢掉来修】⇒ 同时红在两发上（那是本轮真的考虑过并否掉的写法：丢掉会把" +
        "「这个 project 吃进了仓外的文件」读成「那些文件没有类型错」）。" +
        "⚠ 那台比 round295 那台多读一格：FAIL 行里的【用例名】也读，mustRed 逐条点用例名而不是点文件 —— " +
        "点文件的分辨率是一份几十发的文件，里面任何一发红都算命中，而它可能红在别处。" +
        "本条判据不重跑 tsc（那是那份守卫自己的事，重跑一遍只会让两处口径互相漂），" +
        "只核对：上限比较 `n > allowed` 还在、`unregistered.push` 那一支还在、空壳豁免那一半还在、" +
        "测试仍指向那个 project、且那两条反假绿哨兵（语料下限 / 未解析=0）还写着",
      judge: "test-type-baseline",
      checkedAt: "2026-11-18",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2014,
        sentence: "round285：这一格接成了门禁，形状是棘轮（登记为 r19）",
      },
      check: testTypeRatchetCheck,
    },
    {
      id: "r20",
      claim:
        "§1.1 那张表上那四个读数从「配了一段对脚本形状的描述」翻向「有一条能跑的命令」：" +
        "`test/arch/census.ts` + `npx tsx` 现读，复用 `dead-modules.ts` 的取材与图，" +
        "只测量不判定（恒 exit 0，除解析器自报悬空说明符时【抛】）⇒ " +
        "§8 末「每个数都配了复算方法」与 O14 动作 3「全部标了口径 + 复算方法」这两句，" +
        "在 round293 之前是【把「写了口径」当成「给了方法」】，现在才逐字成立。" +
        "⚠ 射程四条：① 本轮第一次真复算，四条【全部】对不上（83→92 / 35216→40871 / " +
        "108→135，而「11」看着没变其实是【另一批成员】，换成表上那条口径今天给 7）—— " +
        "旧数按「改数就等于伪造那次测量」保留原样，新读数只写在 ⚡ 里；" +
        "② 它不 assert 任何一个数，所以【数变了这里不会红】，数变了归 dead-modules 的基线管；" +
        "③ 「排除入口」那条口径读第 ④ 栏，读第 ③ 栏会得到另一个数（今天 11 vs 7）；" +
        '④ 行数口径是 `split("\\n")`，以换行结尾的文件比 `wc -l` 【多 1】（实测 725 vs 724）',
      method:
        "test/arch/census.test.ts › 12 发。合成那一半：入口排除的【反向对照】（同一份语料、" +
        "同一个 solo.ts，标成入口才消失、不标就在 —— 少了这一发「排除入口」可写成 " +
        "filter(() => false) 而全绿）+ 排除只作用于零 importer 那一栏不改模块数与总行数 + " +
        "行数口径钉死（split 比 wc 多 1，第一版我连错的方向都没算对）+ " +
        "⭐ 悬空说明符【会】自报（unresolved=1）配真仓库那条 0 —— 证明那个 0 是算出来的。" +
        "真仓库那一半：取材非空下限 + ⭐【成员】判据（db/write-queue.ts 与 org/commit.ts " +
        "必须不在零 importer 里：解析器退化成零条边时名单是【膨胀到 85】而非缩小，" +
        "只判名单规模抓不到）+ 反向（harness/verifier.ts 仍在）+ 子集算术 + 入口自洽 + " +
        "unresolved=0 + 测试文件分桶非空。" +
        "外加打在【census.ts 生产字节】上的六发（.workbuddy/round293-mutate-census.mjs，" +
        "自回滚 + 逐字节核对，单独跑、不与任何测试并发）：" +
        "M1 不累计反向边 ⇒ 红 2 / M2 isEntry 恒 false ⇒ 红 3 / M3 underEntries 不排入口 ⇒ 红 2 / " +
        "M4 unresolved 写死 0 ⇒ 红 1 / M5 lineCount 少 1 ⇒ 红 1 / " +
        "M6 摘掉 sort ⇒ 【该绿】（12 发里没有任何一条判顺序，这一格是登记的射程余量，" +
        "记下来是因为【绿的一发】才能证出判据的边界）—— 这一组证的是【census.test.ts 不空转】。" +
        "另加打在本条判据【输入】上的八发（claims-registry.test.ts，合成语料不碰盘）：" +
        "控制组一字不改 ⇒ 返回空 / 换掉被 import 的【模块名】⇒ 红在恒真判定 / " +
        "摘掉悬空说明符那次抛 ⇒ 红 / 摘掉排除入口 ⇒ 红 / 测试整份不见 ⇒ 红 / " +
        "⭐ 摘掉成员判据 ⇒ 红 / ⭐ 摘掉「unresolved 会自报」⇒ 红，" +
        "其中四发各带一条 not.toContain 排除红因串扰。" +
        "（r20 之二的第一版抹的是 import 列表里【collectModules 那一行】⇒ 实得【绿】：" +
        "判据读的是文本在场，而函数体里还有 collectModules(root)。" +
        "换掉被 import 的模块名才是等价变异 —— 那一发若没被看见，就被记成判据通过了。）" +
        "本条判据不跑那个脚本（重跑一遍只会让两处口径互相漂），只核对：脚本与测试在场、" +
        "它仍从 ./dead-modules.js 拿图、悬空说明符仍会抛、排除入口那一格还在、" +
        "且那两枚反向 canary（成员判据 / unresolved 会自报）还在",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 1573,
        sentence: "round293 落地并登记为 r20",
      },
      check: censusRecomputeCheck,
    },
    {
      id: "r21",
      claim:
        "豁免那份账从【上下界】换成【钉死】，于是它是双向的：多开一道「东西没建」的门 ⇒ 红，" +
        "最后那条豁免被人静默摘光 ⇒ 也红。round293 第二段量到原写法（`>0` 且 `≤2`）" +
        "只有上界会响 —— 0 满足 `≤2`，而摘光之后那条红的措辞指错地方（说得像" +
        "「计划里有个路径写错了」，不像「有人动了豁免」）。" +
        "外加两处本篇自己的过期「今天」被当面拆掉：§10 第 10 格那三句（`test/e2e/` 不存在 / " +
        "playwright 不在任何 package.json / 全仓 `*.spec.ts` 零条）**三句全假**，" +
        "§5.1 Task 4.7 那半句「发卡那一路零生产调用方」**假的**（投递那一跳在 r17 就接进心跳了）。" +
        "⚠ 射程三条：① 那两处过期是【人肉复测】抓出来的，没有任何守卫判「这句话过期了」—— " +
        "能钉住的只有那份账，钉不住散文；② 新读数只证「盘上有 1 个 E2E」，" +
        '`git ls-files "*.spec.ts"` 今天仍是 0 ⇒「有」与「跟踪了」是两条主张；' +
        "③ Task 2.9 / 4.7 两道门**依然没过**，本轮只改了「为什么没过」的归因",
      method:
        "test/arch/plan-gate-paths.test.ts › 11 发（本轮 10 → 11）。真仓库那一半新增：计数恰好 1 + " +
        "每条豁免必须【真的】豁免掉一条不存在的路径（贴在「路径全都在」的位置上=死的豁免，红）+ " +
        "活着的那一条必须点名 mobile-approval.spec.ts（身份钉）。" +
        "⭐ 合成那一半新增反向 canary：同一份判据、合成语料给两条标记 ⇒ 必须数出两条，" +
        "配一发只给一条 ⇒ 数出 1（证明那个 2 不是「永远数出两条」）——" +
        "没有它，一个恒返回「一条」的坏计数器（filter 写成 find / map 前多一个 slice(0,1)）" +
        "在真仓库那一发上照样绿。" +
        "外加打在【真文档 + 真守卫字节】上的五发（.workbuddy/round293-mutate-gate-exemption.mjs，" +
        "自回滚 + 逐字节核对，单独跑、不与任何测试并发）：M0 控制组该绿 / " +
        "M1 把标记挪到路径存在的 ceo-loop 那格 ⇒ 红 2 / M2 静默删掉最后那条 ⇒ 红 2 / " +
        "M3 filter 换成恒真 ⇒ 红 1 / M4 只改那一格散文 ⇒ 【该绿】（判据对无关文案不敏感）。" +
        "那台机器自己错过两次，都伪装成被测对象的错：剥 ANSI 写成 /\\[[0-9;]*m/g 少了 ESC ⇒ " +
        "汇总行前留着 0x1b ⇒ 报「读不到汇总行」；catch 里无条件走汇总解析 ⇒ " +
        "「vitest 没起来」与「读不到汇总」同形、真诊断被吞 —— 这一组证的是" +
        "【plan-gate-paths.test.ts 那 11 发不空转】。" +
        "另加打在本条判据【输入】上的七发（claims-registry.test.ts，合成语料不碰盘）：" +
        "控制组一字不改 ⇒ 返回空 / 守卫不见 ⇒ 红 / ⭐ 摘掉 exemptedBlocks 的 filter ⇒ 红" +
        "（`includes(NOT_BUILT_TAG)` 在守卫里有【两处】，只判片段会绿 —— 同 r20 之二那条教训）/ " +
        "测试不见 ⇒ 红 / 把恰好 1 换回 toBeGreaterThan(0) ⇒ 红 / 摘身份钉 ⇒ 红 / " +
        "⭐ 摘掉那发数得出 2 的反向 canary ⇒ 红，其中三发各带一条 not.toContain 排除红因串扰。" +
        "本条判据不重跑 existsSync、也不跑那台机器，只核对：守卫与测试在场、账还在按字节筛、" +
        "那枚 toBe(1) 的钉还在、身份钉还在、且那发能数出 2 的反向 canary 还在",
      judge: "plan-gate-paths",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2328,
        sentence: "round293 第二段落地并登记为 r21",
      },
      check: gateExemptionAccountCheck,
    },
    {
      id: "r22",
      claim:
        "契约里有一条【带判据的】加角色路径，而它判的东西仍然在两处【不重叠】：" +
        "`orgChangeSchema` 的判别式里有 `add_node` 那一支 ⇒ hub 的 `revalidate` 对它" +
        "【真的调用】`validateNewNode`（不是只剩一条注释说它走了 L1）⇒ " +
        "`applyChangeToGraph` 真的把那个节点【按 role_id 当键】写进 after 图的 nodes ⇒ " +
        "而 `validateNewNode` 的【代码】里仍然一次也没出现 `model_family` —— " +
        "缺家族由 `everyNodeDeclaresModelFamily` 判【整张 after 图】那一处拦，" +
        "code 同为 `unknown_model_family`（round294 的 O8 §7 第 18 格那一格自己点名的修法）。" +
        "⚠ 射程四条：① 本条判的是【结构还在 + 分工没漂】，不判「新节点真能进库」" +
        "也不判「六种坏形状真拿到 422」—— 那两件事由那发验收测试与 test/org 单测负责；" +
        "② ⚠ 它【不判】「旁路被关掉」：在请求体图里塞一个声明了家族的节点、" +
        "变更本身挑一条无关的 `add_edge`，今天【照样能进库】。本轮关掉的只是" +
        "「那条旁路无判据」，关掉旁路本身需要的是「图必须等于 before 经 change 得到」" +
        "那条判据，它今天不存在（本轮台账「没做的下一格」）；" +
        "③ 类型层那格（加第四种 kind 而漏分派 ⇒ `tsc` 红）本条只核对那个兜底【还在】，" +
        "不重跑编译器；" +
        "④ ⚠【round299 改口】nodes 的【键】与 node.role_id 不一致这一格，本条登记时" +
        "写的是「今天没有任何判据」—— 那句话今天【过期了】：orgGraphSchema 上挂了一条 " +
        "superRefine 在判它，翻向后的事实归 r24 管，别在本条下面找它。" +
        "当时那句话本身是真的（zod 的 record 不比对键与值里那个 id，rejectMalformed 与 " +
        "validateNewNode 都不拦），留着这段改口是因为它记着本仓的一条家规：" +
        "射程里那句「不判 X」是【某个时刻的读数】，X 被关掉时主张要跟着改口，" +
        "否则下一条主张就建立在一句过期陈述上" +
        "（r22 自己判的「add_node 那条路带判据」与此无关，那格仍由本条的①–③管）",
      method:
        "test/arch/claims-registry.test.ts › r22 判据：读三份【权威落点】、一份都不抄 —— " +
        "kind 名单只在 contracts 的 schema 里（且只取 `orgChangeSchema` 到 `export type OrgChange` " +
        "那一段，不拿整份文件搜 `" +
        'kind: z.literal("add_node")' +
        "`），" +
        "分派与落库只在 hub 的 commit 里，家族那格只在 contracts 的 validate 里。" +
        "⭐ 判【剥掉注释之后】的字节，三格：① 分派【条件】本身必须是 " +
        '`change.kind === "add_node"` 而不是被短路成 false —— ' +
        "「那句调用还在文件里」与「那条分派活着」是两件事，这一格是变异机器 M8 逼出来的" +
        "（生产字节上端到端当场红而判据【那一版】不红）；② 调用/赋值真的在代码里 " +
        "（那条主张的原话就是「仍在真调判据，而不是只剩一条注释」）；" +
        "③ `validateNewNode` 的函数体里读不到 `model_family` —— " +
        "那个函数头有三段话在解释「为什么【故意】不判」，看原文的话那些注释会替「判了」投一票、" +
        "这一格当场恒绿。剥注释用的是本文件私有的 `withoutComments`，它有两个洞，" +
        "都朝【假绿】：字符串里的 `//` 吃掉同一行的真判据（家族格假绿，同样的字节" +
        "若落在分派那两格则是假红），块注释里含 `//` 则让那个块【没能在此收尾】" +
        "—— 懒匹配不停在原地而一路吞到下一个真收尾（heightBelow 的 JSDoc），" +
        "实测连坐吞掉四条 code 的字节、整条判据隐身。⚠ 后一个洞的方向本轮被我" +
        "写成过【假红】，是量出来才发现猜错的 —— 登记一个洞之前先把方向量出来。" +
        "另加打在合成语料上的十六发（claims-registry.test.ts，不碰盘）：三份取材之一不见 ⇒ 红 / " +
        "判别式那一段读不到 ⇒ 红（与「kind 被摘」分开报，两种红的修法不同）/ " +
        "摘掉 add_node 那一支 ⇒ 红 / commit.ts 不见 ⇒ 红 / " +
        "⭐ 把调用换成一句同义注释 ⇒ 红（本条唯一为「只剩一条注释」写的形状）/ " +
        "⭐⭐ 把分派条件短路成 false 而调用字节留着 ⇒ 红（M8 逼出来的那一格，" +
        "配一发【变异后调用字节仍在】的前提自证）/ 让 applyChangeToGraph 不加节点 ⇒ 红 / " +
        "把类型兜底换成默认放行 ⇒ 红 / ⭐ 往 validateNewNode 的【代码】里加一句判家族 ⇒ 红，" +
        "而同样的字节【只写进行注释】⇒ 该绿、【只写进干净的块注释】⇒ 该绿（两发反向对照：" +
        "行注释与块注释走的是两个分支，一个恒真的判据只要一个分支就够；" +
        "两发的字节都注在【函数体内】并各带一条位置自证 —— 注在函数头之前 sliceFrom " +
        "取不到，那一发就恒绿空转）/ " +
        "⭐⭐ 另两发把上面那两个洞【登记】下来（绿的形状本身就是证据）：各配一发" +
        "单变量对照 —— 只把那两个斜杠拿掉、真判据原样留着 ⇒ 那一发必须红，" +
        "否则『绿』分不出【洞】与【注入没进切片】/ " +
        "摘掉对 after 图那一跑 ⇒ 红 / validate.ts 不见 ⇒ 红 / 定义整段改名 ⇒ 红在【取材】。" +
        "外加打在【真生产字节】上的九发自回滚变异 + 一发读数自证" +
        "（.workbuddy/round294-mutate-add-node.mjs，逐字节核对、单独跑、不与任何测试并发；" +
        "⭐ 它比 round292 那台多两件事：逐文件归因，以及一发【这台机器自己的】反向 canary" +
        "（喂它一段合成的绿摘要与一段合成的红摘要，逼它数出红发数与那两份文件名 —— " +
        "「不该红的文件」这句话的全部价值取决于那个文件集合读得出东西，" +
        "而一个恒空的集合会让它变成废话））。" +
        "本条判据不重跑端到端请求、不重跑那台机器，口径同 r12/r13/r21",
      judge: "claims-registry",
      checkedAt: "2026-11-17",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2452,
        sentence: "round294 落地并登记为 r22",
      },
      check: addNodeDispatchCheck,
    },
    {
      id: "r23",
      claim:
        "「无门控委派边没人核对」那一格从【登记在文档里】翻向【库里有一条跑在整图上的自检】：" +
        "`integrity.ts` 的 `CHECK_NAMES` 里有 `delegation_edges_gated` 而 `auditCoherenceReport`" +
        "的 `guarded` 数组里【真的注册了它】⇒ 那条自检仍在扫【全部版本】的图而不是 `MAX(version)`、" +
        "仍在读边之前过一次 `orgGraphSchema`（读取口今天全是 `JSON.parse(...) as OrgGraph` 强转）、" +
        "判的是 `review_gate !== true` 而不是「填没填」，且那条 not_observable 文案仍写着" +
        "「空表 ≠ 没有写入方」。⚠ 射程五条：① 本条判的是【结构还在 + 分工没漂】，" +
        "它【不打开任何数据库】—— 那条自检在真库里今天报什么，归 integrity.test.ts 那 7 发；" +
        "② 它【不判】「脏边进不了库」：写侧那两半（HTTP 信请求体带来的整张图 + " +
        "`revalidate` 只看增量）今天都还在，本轮只加了读侧的兜底，" +
        "把本条读成「不能再通过请求体塞无门控边了」是误读（round298 台账「没做的下一格」）；" +
        "③ 老版本【必须】在射程内 —— 任务盖着自己的 graph_version 读图，" +
        "把扫描退回最新版是一次【静默降级】：报告 ok 而那个老任务照跑脏图；" +
        "④ 它不判「审阅真的发生过」，那一格归 author-reviewer / events；" +
        "⑤ `could_not_run` 不在本条射程内，那条文案区分的是「数据读不动」与「尺子放不下去」，" +
        "混起来会让一次 schema 损坏读成「这条判据没跑」，而后者不拦启动",
      method:
        "test/arch/claims-registry.test.ts › r23 判据：读一份【权威落点】、一格都不抄 —— " +
        "名单与函数体都在 `db/integrity.ts`，本文件不抄 CHECK_NAMES 的全表（抄一份就会在真那份" +
        "加第 9 条之后继续绿着）。五格全写成【正向：那句话的权威字节此刻在代码里】，" +
        "判的是【剥掉注释之后】那份（`withoutComments`，洞两条见 r22 的 method —— " +
        "这一族的注释比代码长，函数头有整段在解释「为什么故意不判」）。" +
        "⭐ 三格是【反向】的，即「诱人错法一旦落下就红」：只扫 `MAX(version)` ⇒ 红（M2 那一发）/ " +
        "把 `!== true` 换成 `== null` ⇒ 红（M1 那一发：false 是【填了】的值）/ " +
        "撤掉 `orgGraphSchema.safeParse` 退回信强转 ⇒ 红（M3 那一发）；" +
        "另外两格守的是【注册】与【文案】：名单里有名字而 `guarded(` 那行被摘 ⇒ 红" +
        "（恒绿的自检比没有自检更坏：报告里那一格会一直显示 ok），" +
        "not_observable 文案里那句假句子回归（「src 里没有任何 INSERT INTO…」）⇒ 红 —— " +
        "⭐ 与 M5 同一格，但口径不同：M5 测的是【zero-producer 抓得到】，" +
        "这里测的是【登记表不许它回来】。两处都抓不是重复：" +
        "那台读的是「这句话与代码现状对不对得上」，这台读的是「这句话有没有被写回来」。" +
        "另加打在合成语料上的十四发（claims-registry.test.ts，不碰盘）：取材自证一发 + 控制组一字不改 ⇒ 返回空 + " +
        "十二发变异：integrity.ts 整份不见 ⇒ 红 / 读不到 CHECK_NAMES 那一段 ⇒ 红在【取材】/ " +
        "名单里摘掉那一格 ⇒ 红 / " +
        "⭐ 名单留着而 `guarded(` 那行不见 ⇒ 红（与「摘名单」分开报：那两发的修法相反）/ " +
        "读不到函数定义 ⇒ 红 / SQL 退回 `MAX(version)` ⇒ 红 / 门控判据退回 `== null` ⇒ 红 / " +
        "撤 schema 那道 ⇒ 红 / 空表那格不再单独成栏（`if (edges === 0)` 短路成 false）⇒ 红 / " +
        "假句子【写进代码】⇒ 红 / ⭐⭐ 同一句假话【只写进注释】⇒【该绿】（④ 判剥注释后的字节，" +
        "这一发是那一格唯一的方向证据：判原文会因为一句诚实的反面教材注释而【假红】。" +
        "它自带两条前提自证 —— 那句【进了字节】且【在函数头之前】，否则" +
        "「绿」分不出【注释被豁免】与【锚点没注上】）/ 空表文案不再指名写入方 ⇒ 红；" +
        "除控制组外每发各带一条 not.toContain 排除红因串扰（八格串在一条判据里，" +
        "只判 toContain 会把「取材坏」与「主张过期」读成同一句话）。" +
        "外加打在【真生产字节】上的六发自回滚变异" +
        "（.workbuddy/round298-mutate-edge-gate.mjs，逐字节核对、单独跑、不与任何测试并发；" +
        "命中 6/6、机器自证 7/7，证据 .workbuddy/round298-edge-gate-mutation-evidence.txt）：" +
        "M0 控制组该绿 / M1 门控判成「有没有填」⇒ 红 2 / M2 只扫最新版 ⇒ 红 2 / " +
        "M3 撤 schema 那道 ⇒ 红 2 / M4 空表混进 ok ⇒ 红 2 / " +
        "⭐ M5 把假句子写回文案 ⇒ 红在【另一条守卫】（zero-producer.test.ts 点名 integrity.ts 那一行），" +
        "而⑤b 那发【全绿】—— 那 1 发全绿是本轮量出来的盲区，矩阵按【用例名】把它点名，" +
        "并在 ⑤b 的注释里明写「那两行 toContain 不是守卫，只是便宜取样」。" +
        "⚠ 这台比 round296 那台多两件事：每发变异【自己声明该由哪条守卫抓】（spec 逐发给），" +
        "以及装载失败那两种读法各带一发自证 —— 第一版用 `语法炸掉` 试「装载失败」而它是" +
        "【合法标识符】⇒ 运行期才炸 ⇒ 那条「读不到用例名就不造名」的分支【从没走通过】，" +
        "换成 `@@@` 那种真非法字节才量出读数（`Tests no tests` + 文件级 FAIL）⇒ " +
        "**一个永远不可能进入的分支就是一句装饰**，它要在【造出那种读数】之后才算被验证。" +
        "本条判据不打开数据库、不重跑那台机器，口径同 r12/r13/r21/r22",
      judge: "claims-registry",
      checkedAt: "2026-11-18",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2569,
        sentence: "round298 落地并登记为 r23",
      },
      check: delegationEdgeSelfCheckCheck,
    },
    {
      id: "r24",
      claim:
        "r22 射程④ 那一格（『nodes 的键与 node.role_id 不一致今天没有任何判据』）" +
        "从【登记】翻向【schema 判】：`orgGraphSchema` 上挂着一条 superRefine，" +
        "它遍历 `Object.entries(graph.nodes)`、按 `node.role_id === key` 这个方向判、" +
        "把 issue 的 path 指到 `nodes.<键>.role_id`，且【每个】坏键各报一条。" +
        "落点在 schema 而不是 validate.ts 有三个理由：rejectMalformed 在三个入口各调" +
        "一次、判的都是【本次变更之前】那张图，而 add_edge 那条根本不进 " +
        "validateNewNode（缝在图上就该由图的形状管）；orgGraphSchema 今天已经是" +
        "两处判据的公共入口（api.ts 的请求体 + integrity.ts 那条 delegation_edges_gated" +
        "逐版本 safeParse），落在这里 ⇒ 写侧拦新的、读侧自检顺手拿到同一条不变量；" +
        "validateNewNode 只收到一个 node，拿不到那个键。" +
        "⚠ 射程六条：① 本条判的是【那条判据的权威字节还在 + 这条路上用的是它】，" +
        "它不打开数据库、不重跑请求 —— 端到端那一发归 org-route.test.ts；" +
        "② 它【不判】「老库里没有这种图」：真库 delegation_graphs 今天 0 行（实测，" +
        ".workbuddy/probe-node-key.ts 可复算），而 0 行既可能是【没有坏图】也可能是" +
        "【根本没有图】—— 所以【这条收紧不破坏存量】这句话靠的不是那个 0，" +
        "是【仓内每一处生产节点的代码都按 role_id 取键】那份静态普查；" +
        "③ 判据方向翻成【不一致才跳过】时它【照样会拒请求】，所以只判状态码的测试" +
        "发现不了 —— 那一格由本条的比较方向那一发钉住；" +
        "④ 它不判「键≠role_id 一定会被 schema 抓到」这件事在【不走 schema 的调用】" +
        "上成立：把一张坏图直接喂给 rejectMalformed 它今天照样放行" +
        "（validate.test.ts 里那两发【旧注释里那两条也不管】仍在钉这件事）；" +
        "⑤ 键与值【同时】写错成另一个合法角色（键和 role_id 都写 bob）" +
        "这条判据看不见 —— 它判的是【同一个节点的两个身份来源不一致】，" +
        "不是【这个角色该不该存在】；" +
        "⑥ 它是【收紧】：一张仓外客户端提交的键≠自称的图，今天从 200 变 422。" +
        "那正是目的，但别把它读成【契约没变】。",
      method:
        "判据：test/arch/claims-registry.ts 的 nodeKeyIdentityCheck —— 读一份" +
        "【权威落点】（packages/contracts/src/org/graph.ts 里 orgGraphSchema 那一段，" +
        "用 sliceFrom 掐到 `export type OrgGraph` 之前）+ 两处【前提】各一格：" +
        "api.ts 的 `graph: orgGraphSchema`（请求体吃的就是这一份）、" +
        "hub 的 org/commit.ts 仍指名 INSERT_DELEGATION_GRAPH_SQL（写入口就是那一条）。" +
        "七格全判【剥掉注释之后】的字节 —— 那段 superRefine 的函数头注释比代码长得多，" +
        "判原文的话「为什么不落在 validate.ts」那几段话会替「判了」投一票；两处前提" +
        "同样剥注释，否则一句「这里以前挂的是 orgGraphSchema」的诚实注释会替一条" +
        "已经断掉的接线投一票。" +
        "⭐ 反向格三枚：遍历对象从 nodes 换成别的 ⇒ 红 / 比较方向翻 ⇒ 红 / " +
        "path 不再指到那一个键 ⇒ 红（那一发同时打中 422 正文与自检报告：issuesOf 与 " +
        "issueSummary 都只读 path）。另有一格判【不许 break/return】—— 只报第一个坏键" +
        "会让提交的人改一次发一次。" +
        "外加打在合成语料上的一族变异（claims-registry.test.ts 的 r24 那一族，不碰盘，" +
        "发数以那个文件当场为准；含两对【只差注释前缀】的对照 —— 之九/之十 钉 schema " +
        "那几格、之十二/之十二·乙 钉前提格：同一批字节在注释里该绿、在代码里该红）。" +
        "外加打在【真生产字节】上的六发自回滚变异" +
        "（.workbuddy/round299-mutate-node-key-gate.mjs，逐字节核对、单独跑、" +
        "不与任何测试并发；命中 6/6、机器自证 12/12，证据 " +
        ".workbuddy/round299-node-key-mutation-evidence.txt）：" +
        "M0 控制组该绿 / M1 比较方向翻 ⇒ 五发全红 / M2 摘掉遍历 ⇒ 红三发而" +
        "【两发反向对照按设计全绿】（反向对照只防恒红，防不了无判据 —— 登记的盲区）" +
        " / M3 遍历错集合 ⇒ 五发全红 / M4 诊断退化 ⇒ 只红甲那一发而【端到端那发全绿】" +
        "（它读的是 path 拼出来的点号串，正文可用性只有 schema 那一发挡）/ " +
        "M5 path 退化 ⇒ 甲乙双红。" +
        "⚠ 这台比 round298 那台多两件【打在自己身上】的自证：" +
        "(a) 变异打在 contracts 的【src】上而被测的吃【dist】 ⇒ 有一发自证真往 src " +
        "塞一个记号、重编、去 dist 里找它、再撤掉验它消失 —— 它验的是这台机器的【供电】，" +
        "不是判据；缺这一条，「改了 src 而 dist 是旧的」会让 6/6 全绿而那一格从没被测过。" +
        "⭐ (b) 那台的第一版把「盲区那一栏」的方向写反了（把【出现在 FAIL 行里】当成" +
        "仍绿），后果是 M0 控制组一份都没红却报「0/4 盲区仍绿」—— " +
        "一个恒不可能成立的判据就是一句装饰（round298 ⑥·乙 那条【在本机自己身上】复发），" +
        "现在有一发自证喂「一发红一发绿」的合成读数逼它两种各数一次。" +
        "本条判据不打开数据库、不重跑那台机器，口径同 r12/r13/r21/r22/r23",
      judge: "claims-registry",
      checkedAt: "2026-11-18",
      source: {
        doc: "docs/OPC-OS-功能优化设计.md",
        line: 2642,
        sentence: "round299 落地并登记为 r24",
      },
      check: nodeKeyIdentityCheck,
    },
  ];

/* ═════════════════════ 出口文档渲染 ═════════════════════ */

/** 渲染 docs/OPC-OS-功能优化设计.md 里那张表：只放【主张 + 判据方法 + 核对时刻】。 */
export function renderMarkdown(table: readonly RegistryEntry[]): string {
  const header = "| 主张 | 判它的方法 | 上次核对时刻 |";
  const sep = "| --- | --- | --- |";
  const rows = table.map(
    (r) => `| **${r.id}** ${r.claim} | ${r.method} | ${r.checkedAt} |`,
  );
  return [header, sep, ...rows].join("\n");
}
