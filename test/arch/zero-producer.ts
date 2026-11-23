/**
 * 「某张表在 src 里没有写入方」这类句子的事实核查。
 *
 * ── 为什么会长出一个这样的守卫 ──────────────────────────────────
 * 本仓有一整类句子长这样：「`harness_calls` 的 INSERT 在 src 里是【零】」。
 * 它们当年都是【当场 grep 出来的真读数】，写成现在时之后留在原地。而写入方是会长出来的
 * —— 长出来之后没有任何东西要求人回来改那句话。0063 §2 实测到 **5 件事、拆成 7 句已经假的**：
 *   · `db/integrity.ts` 那条 not_observable 文案说 harness_calls 零 INSERT，而
 *     `engine/runtime.ts` 那条 INSERT 由 `engine/driver.ts` 与 `serve/charter-pump.ts`
 *     在生产路径上调 —— 一条自检的【文案】在对自己撒谎，而判据本身还是好的。
 *   · `policy/auto-approve.ts` 写「今天的真库就是这种：src 里没有任何 INSERT INTO
 *     approvals」，而 `approvals/cards.ts` 正是补那个缺口的模块。
 *   · `charter/budget-sync.ts` 写 `budgets.consumed_cents`「除 ADD_CONSUMED_SQL 之外
 *     零写入方」，而引擎路线（`engine/runtime.ts` 当时手抄的 `ADD_TASK_BUDGET_SQL`，
 *     round272 起那份副本删了、import 的就是 ADD_CONSUMED_SQL）也在写同一列。
 *     ⚠ 这一句是【当时的取证记录】，不是今天的读数：今天语句只有一条而调用点两处。
 *     名字留着是为了让读到的人知道当年红的是哪一份代码，而不是让它假装还存在。
 *   · `channels/abstraction.ts` 两处：拿「`im_tokens` 零写入方」当类比（`http/tokens.ts`
 *     在插行），又说 `im_bindings` 「全仓没有任何一条 SQL 碰过它」（`bindings/im.ts`
 *     自己就是那个生产者，文件头第一行写的就是这件事）。
 * 五处成因同一个：**测于过去，写成现在时，没有东西把句子与它主张的那个读数绑在一起**。
 * 没有任何测试会因为它过期而红 —— `doc-coords` 判小节号，`comment-citations` 判 § 引用
 * 存在性，都不判「这句话今天还对不对」。
 *
 * ── 判据的形状：登记表 + 双向对账 ──────────────────────────────
 * 不做「从散文里猜哪张表被说成零」那种 NLP。做登记表：
 *   ① 扫 src 的原文抽出所有「零写入方」式句子 ⇒ 每处必须在登记表里点名；
 *      新写一句这种话而没登记 ⇒ 红。（防【下一句不在清单上】—— 取材清单式守卫的标准
 *      失效方式，0061 §7 / 0062 §6 各记过一遍。）
 *   ② 登记表每条带期望（`zero` / `has`）⇒ 与【扫代码字符串】得到的实际生产者对账
 *      ⇒ 不一致就红。（防【世界变了而句子没变】，就是上面那五处。）
 * 两个方向缺一都不能收口。只扫句子不登记，判据交给写句子的人；只登记不扫句子，
 * 将来新增的那句永远在射程外。
 *
 * ── 这句话能被判到什么程度（口径写死在这里，别读成更强的东西）────────
 * 判据的作用域是【src 这套源码里有没有那条 SQL】，不是【真库里有没有这行数据】，
 * 也不是【那条代码在生产里可达】。三件事各自独立：
 *   · 有 SQL 而生产不可达 —— `policy/auto-approve.ts` 就是（死模块基线里）；
 *   · 生产可达而本守卫看不见运行时 —— 全部。
 * 所以一条 `zero` 登记为真，说的是「今天 src 里搜不到往那张表插行的 SQL」。
 * 想表达"生产可达"的句子必须把「生产」两个字写进登记（`harness/safety.ts` 那条就是这么
 * 归进非表档的），否则它会被按【源码里有没有】判 —— 那是个更弱的口径，而它配不上
 * 「生产」这个词。这一格是口径，不是漏判：把它做成可达性分析需要跨过程数据流，
 * 本仓没有那个东西，也不该为一句注释造一个。
 *
 * ── 为什么生产者过 ts-lex 而声明不过 ─────────────────────────
 * 本仓 SQL 全在【字符串字面量】里，假句子在【注释】里。对全文 regex 会把两类位置混成一锅：
 * `approvals/cards.ts` 文件头那条「grep ⇒ 0 命中」是注释里的历史读数，不是写入方；
 * `integrity.ts` 的 not_observable 文案在字符串里，而它是散文不是 SQL。
 * 所以生产者一侧走 `lexTs` 的 `onString`，且只认【以 INSERT 开头】的串 —— 真 SQL 常量
 * 一定是那个形状（本仓 SQL 常量单语句），而「src 里【没有任何 INSERT INTO review_gates】」
 * 整串不是。这一条同时挡住两种假。
 * 声明一侧按行扫原文，不按 lexTs：多表那一行（「`review_gates` / `harness_calls` 的
 * INSERT 是【零】」）要一行挂两条登记，而词法扫描给的是整块正文、行号还得自己数回来。
 * 代价是【代码里的同名标识符也可能被当成声明】—— 实测本仓 src 里那种行数为 0，
 * 而它的假阳方向是「多要求登记一条」，不是漏判。
 *
 * ── notTable 那一档：必要，而它是最容易被滥用的地方 ────────────────
 * 19 处里有 5 处说的不是表：三处说「一个没有生产者的【取值形状】」（`app.ts` /
 * `today.ts`，讲的是类型上某个值没人构造），一处说 `tasks.consumed_cents`【那一列】，
 * 一处说 `events` 里某个【action 值】。它们不该被表对账管，但也【不能是一个垃圾桶】：
 * 谁都能把一句假话登记成"这不是表"。所以这一档的条数被测试里的【常量钉住】——
 * 想新增一条得改那个数，而那个数旁边写着它是什么意思。0054 那条「基线要能被重新数出来」
 * 说的是同一件事：说不清条数为什么是这个数的豁免，与没有豁免不可区分。
 */

import { lexTs } from "./ts-lex.js";

/** 「零写入方」式声明的写法。七种都是实测存在于 src 的（0063 §2 那张表）。 */
export const ZERO_CLAIM_RE =
  /零\s*INSERT|INSERT\s*是【零】|零写入方|没有任何\s*INSERT|没有生产者|零生产写入|读写方\s*\*{0,2}0/g;

/**
 * 一条 INSERT 的表名。
 *
 * ⚠ `(?:\s+OR\s+\w+)?` 那一段不是装饰：本仓有 `INSERT OR REPLACE INTO checkpoints`
 * （`checkpoint/saver.ts`）与 `INSERT OR IGNORE INTO tasks`（`graph/company.ts`）。
 * 只写 `INSERT INTO` 的话这两条【真的写入方】扫不出来，于是「这张表零写入方」会在
 * 【有写入方】的表上被判成真 —— 那正是本守卫要抓的那种假，而它由守卫自己犯。
 * （写这一条之前先 grep 了存量：全仓没有小写 `insert into`，所以不区分大小写是白拿的。）
 */
const INSERT_HEAD = /^\s*INSERT\b(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)/i;
/** 散文里点名某条 INSERT 的表名：`没有任何 INSERT INTO approvals`。 */
const TABLE_IN_SENTENCE = /INSERT\b(?:\s+\w+)*?\s+INTO\s+([a-z_][a-z0-9_]*)/i;
/** 反引号里的标识符候选。 */
const BACKTICK_IDENT = /`([a-z_][a-z0-9_]*)`/g;

/** src 里的一个写入方。 */
export interface Producer {
  readonly table: string;
  readonly file: string;
}

/**
 * 一条登记。`anchor` 用【内容】定位而不是行号：本仓坐标一律内容定位（0054 那条
 * 「行号会漂」的教训），改一行别的注释不该让这条登记变成幽灵。
 *
 * 判别式联合：`kind` 决定这条声明归不归【表对账】管。合成一个 interface 加可选字段
 * 是不行的 —— 那样 `kind: "other"` 的登记可以照样填一个 table，读者看不出它到底有没有
 * 被核对过（而 `other` 那一档能不能被滥用，正是本守卫最需要一条硬判据的地方，见下）。
 */
export type ZeroClaim = TableClaim | OtherClaim;

/** 登记里出现过的真实表名。`other` 那一档的硬判据用它来拒绝"把表的事装成非表"。 */
export const KNOWN_TABLES: ReadonlySet<string> = new Set<string>([
  "approvals",
  "artifacts_meta",
  "budget_events",
  "budgets",
  "budgets",
  // 0009（round283，O12 动作 4）建的卡片投递台账。列在这里的理由与 `checkpoints` 那条不同：
  // 这张表【在】migrations 的 CREATE TABLE 清单里，所以漏了它下面那条「迁移建了 X 而
  // KNOWN_TABLES 没有它」会红 —— 它红得有道理：一张不在名单里的表就是一张能走 `other`
  // 免检的表，而「`card_deliveries` 零写入方」这种话一旦能走 other 就永远不红。
  "card_deliveries",
  "charters",
  "delegation_graphs",
  "events",
  "evidence_bundles",
  "harness_calls",
  "im_bindings",
  "im_tokens",
  "meetings",
  "review_gates",
  "role_charters",
  "secrets",
  "skill_mounts",
  "tasks",
  "trust_scores",
  // 0005 之后加的。这张表【不在】migrations 的 CREATE TABLE 清单里 —— 它是 checkpoint
  // 那条路线自带的（`checkpoint/saver.ts` 的 INSERT OR REPLACE INTO checkpoints）。
  // 列在这里的意义是【让它不能走 other】：有人写「checkpoints 零写入方」时必须去对账，
  // 不能靠"这条不是表"绕过。
  "checkpoints",
  "schema_migrations",
  // 0011–0021（群角色上层）建的 22 张表。它们【在】migrations 的 CREATE TABLE 清单里，
  // 所以漏任何一张，上面那条「迁移建了 X 而 KNOWN_TABLES 没有它」就会红。红得有道理：
  // 名单里少一张表 = 那张表能走 `other` 免检，而「`groups` 零写入方」这种话一旦能走
  // other 就永远不红 —— 恰恰在这一点上，本轮新表比旧表更危险：它们【今天真的】
  // 一个写入方都没有（存储层在 T5 才接线），所以正是最容易写出真「零写入方」句子、
  // 也最需要被对账逼着在接线后改登记的一批。
  // 两张 FTS 影子表（messages_fts / documents_fts）不在这里：它们是
  // CREATE VIRTUAL TABLE，上面那条对账的正则只认 CREATE TABLE，不认不登记。
  // 顺序按迁移号，不按字典序：将来加 0022 时照着末尾续，不用在字母缝里找位置。
  "roles", // 0011
  "assets", // 0012
  "members", // 0013
  "member_skills",
  "member_executors",
  "hire_events",
  "groups", // 0014
  "group_members",
  "conversations", // 0015
  "messages",
  "message_reads",
  "documents", // 0016
  "document_versions",
  "document_permissions",
  "document_templates",
  "meeting_turns", // 0017
  "backlog_items", // 0018
  "plugins", // 0019
  "plugin_tools",
  "talent_market", // 0020
  "rhythm_events", // 0021
  "research_cards",
]);

/** 一句「某张表在 src 里没有写入方」的登记。 */
export interface TableClaim {
  readonly kind: "table";
  /** 声明所在文件的仓库相对路径（posix 分隔）。 */
  readonly file: string;
  /** 该处声明句里必须出现的子串。同一行可以挂多条（多表那一行就挂两条）。 */
  readonly anchor: string;
  /** 这条声明点名的表。 */
  readonly table: string;
  /**
   * `zero` = 句子（读成现在时）主张没有写入方；`has` = 已更正为"有"；
   * `quoted` = 这句话是在【引用】一句说过/写过的主张，不是主张它今天为真。
   *
   * `quoted` 这一档是【修 bug 的副作用长出来的】：更正一句假话的最佳写法就是把原话
   * 留着再补一句为什么错（本仓口径：原话不删，划掉留在原地），而原话里那句
   * 「harness_calls 在 src 里零 INSERT」会被本守卫重新扫成一句新声明。
   * ⚠ 而"我这只是在引用"是【最方便的逃生口】——任何假话都能自称引用。所以它要过一道
   * 真判据：anchor 必须与原文同一行的 `「…」` 构成引用关系（`insideQuote`）。
   * 引用标记不是历史时态标记的替代：`historical` 管"这句当时为真"，`quoted` 管"这句不是我说的"。
   */
  readonly expects: "zero" | "has" | "quoted";
  /**
   * 句子是历史时态（「当时 grep ⇒ 0」、「0028 §2 量的」）⇒ 今天有写入方【不红】。
   * ⚠ 这个名字原来叫 `then`，被 biome 的 noThenProperty 判成 thenable 危险名，
   * 且判据本身也怕这个：带 `then` 属性的对象塞进 await/Promise 通路会被【调用】。
   */
  readonly historical?: boolean;
}

/**
 * 一句【不是】「表没有写入方」的声明。`about` 必须写清它真正在说哪个东西。
 *
 * ⚠ 这一档是必要之恶，也是最容易被滥用的地方，所以它有一条【硬判据而不是约定】：
 * `about` 里【不许出现任何一张真实表名】（`KNOWN_TABLES`，由测试去数 migrations）。
 * 于是「`tasks.consumed_cents` 那一列」这种能登记，而把「`events` 表零写入方」
 * 写成 other 会当场红 —— 想躲开表对账的人必须先把表名从自己的说明里抹掉，
 * 而抹掉之后那句话就说不清了。口径本身仍然由【条数】钉住（见测试里的 OTHER_COUNT）：
 * 说不清"为什么是这个数"的豁免，与没有豁免不可区分（0054）。
 */
export interface OtherClaim {
  readonly kind: "other";
  readonly file: string;
  readonly anchor: string;
  /** 这句话真正的主张，例如「driver 注入点这个可选参数还没有传值方」。 */
  readonly about: string;
}

/** 源码文件。`path` 必须仓库相对 + posix 分隔 —— 登记表按它比对。 */
export interface SrcFile {
  readonly path: string;
  readonly text: string;
}

/** 原文里的一处「零写入方」句子。 */
export interface ClaimSite {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /**
   * 这一行 + 上面两行。时态由邻句承载（「0013 §10.1 量的」在上一行，下一行才是读数），
   * 所以判历史要看窗口；窗口大小是惯例值，写死在这里以免各处不一。
   */
  readonly near: string;
  /** 这一行唯一可指的表名；多个候选或抽不到时为 null（不猜，见 tableOnLine）。 */
  readonly table: string | null;
}

/** 历史判据要看几行上文。 */
const THEN_WINDOW = 3;

/**
 * 抽「零写入方」式句子。按行：一块注释里可能一行提两张表，
 * 按行抽才能一处一处登记，也不会把两个表名合成一条声明。
 */
export function findZeroClaims(files: readonly SrcFile[]): ClaimSite[] {
  const out: ClaimSite[] = [];
  for (const f of files) {
    const lines = f.text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      ZERO_CLAIM_RE.lastIndex = 0;
      if (!ZERO_CLAIM_RE.test(line)) continue;
      out.push({
        file: f.path,
        line: i + 1,
        text: line.trim(),
        near: lines.slice(Math.max(0, i - THEN_WINDOW + 1), i + 1).join("\n"),
        table: tableOnLine(line),
      });
    }
  }
  return out;
}

/**
 * 一行的表名：先认句子里的 `INSERT INTO t`（最硬，指向明确），再认【唯一】的反引号词。
 * 多个候选返回 null 而不是猜第一个：猜错 = 拿别的表去对账，那种假绿比红难查得多。
 * null 不报错 —— 登记时要么把表名写进 anchor 能覆盖的位置，要么归 notTable。
 */
function tableOnLine(line: string): string | null {
  const ins = TABLE_IN_SENTENCE.exec(line);
  if (ins !== null) return ins[1] as string;
  BACKTICK_IDENT.lastIndex = 0;
  const hits: string[] = [];
  let m: RegExpExecArray | null = BACKTICK_IDENT.exec(line);
  while (m !== null) {
    hits.push(m[1] as string);
    m = BACKTICK_IDENT.exec(line);
  }
  return hits.length === 1 ? (hits[0] as string) : null;
}

/**
 * 扫 src 的写入方：只看【字符串字面量】里以 INSERT 开头的串。
 * 拼接的 SQL 常量只看第一段（lexTs 一截一截回调），够用：表名一定在第一段。
 */
export function findProducers(files: readonly SrcFile[]): Producer[] {
  const out: Producer[] = [];
  for (const f of files) {
    lexTs(f.text, {
      onString: (_kind: '"' | "'" | "`", body: string): void => {
        const m = INSERT_HEAD.exec(body);
        if (m !== null) out.push({ table: m[1] as string, file: f.path });
      },
    });
  }
  return out;
}

/**
 * anchor 与 `「…」` 的关系是否构成"这是一句引用"。`quoted` 那一档的凭据。
 *
 * 两种形状都算，因为它们表达同一件事而写成哪种都有：
 *  (a) anchor 整段【在】某对「」之内 —— `「harness_calls 在 src 里零 INSERT」，它…`；
 *  (b) anchor 自己【带着】一对「」 —— `「零 INSERT」是那张表…`（这一行的引文内容
 *      就是「零 INSERT」四个字，想让它在本文件里唯一就只能把右括号吃进 anchor）。
 * ⚠ 不接受【行内没有成对引号】的 anchor：「我这只是在引用」是本守卫里最方便的逃生口，
 * 任何一句假话都能自称引用，所以引用要拿出引号。
 * 也不看跨行的引号：本仓一段引文占三行的情况有，但那类引文里的声明句要么自带半边
 * 引号、要么本来就不该按行登记 —— 需要时改窄 anchor，而不是放宽这里。
 * 放宽的方向是"少要求一点凭据"，那是本守卫最不想要的方向。
 */
function insideQuote(line: string, anchor: string): boolean {
  const at = line.indexOf(anchor);
  if (at < 0) return false;
  // (b) anchor 自带一对。
  const own = anchor.indexOf("「");
  if (own >= 0 && anchor.indexOf("」", own + 1) > own) return true;
  // (a) anchor 被行内某对包住。
  const open = line.slice(0, at).lastIndexOf("「");
  if (open < 0) return false;
  return line.slice(at + anchor.length).indexOf("」") >= 0;
}

/** 七类不符，分开返回才说得清是哪一类。 */
export interface ReconResult {
  /** 原文里说了"零写入方"而登记表里没点名。 */
  readonly unregistered: ClaimSite[];
  /** 登记表里有而原文找不到那句（句子被删/改词 ⇒ 登记成了幽灵）。 */
  readonly ghosts: ZeroClaim[];
  /** 登记 zero 而实际有写入方，且不是历史时态 ⇒ 句子在撒谎。 */
  readonly stale: readonly TableClaim[];
  /** 登记 has 而实际【真的】没有写入方 ⇒ 更正过头，或世界又变回去了。 */
  readonly wrongWay: readonly TableClaim[];
  /**
   * 登记写的表名与原句里点名的表名【不一致】。
   *
   * 这一维堵的是登记本表的作弊口：配对只按 `file + anchor` 认句子，所以一条登记
   * 可以指着「`harness_calls` 零 INSERT」那句话，把 `table` 写成一张真没有写入方的表
   * —— 于是"零写入方"与"有写入方"两个方向都不会红，而守卫看着是全的。
   * 原句能唯一指出一张表时（`tableOnLine` 非 null），登记必须给同一张。
   * 原句指不出（多表那一行、或表名不在反引号里）时不判这条 —— 那种句子的表名
   * 本来就只存在于登记里，多表那一行【正是】靠这个形状一行挂两条登记。
   */
  readonly tableMismatch: readonly { claim: TableClaim; inText: string }[];
  /**
   * 登记成历史时态（`historical: true`）而原句与上两行里【没有】任何过去标记词。
   *
   * 没有这一维，`historical` 就是一个静音按钮：一句现在时的假话标上 `historical: true` 就永远不红了，
   * 而登记表看起来是"核对过"的。所以历史登记必须【长得像历史】：句子里得有
   * 「量的 / 当时 / 此前 / 原先 / 写之前 / 变成…」这类词（名单见 `THEN_MARKERS`）。
   * ⚠ 「引用了决策编号」**不算**标记 —— `integrity.ts` 那句「src 里零 INSERT，0018 §9 复算」
   * 是现在时且是假的，编号是它援引的依据而不是它的时态。
   */
  readonly historicalWithoutMarker: readonly ZeroClaim[];
  /**
   * 登记成 `quoted`（「我只是在引用一句旧话」）而原句里【没有】把它括进 `「…」`。
   * 不给这一维，`quoted` 就是第二个静音按钮 —— 见 `TableClaim.expects` 那条。
   */
  readonly fakeQuote: readonly TableClaim[];
  /**
   * 登记成 `other`（「这句说的不是表」）而 `about` 里出现了真实表名。
   * `other` 那一档唯一的硬判据，见 `OtherClaim`。
   */
  readonly disguised: readonly OtherClaim[];
  /**
   * 一条登记的 anchor 在同文件里命中【多处】原句。
   *
   * 不给这一维，`anchor: "零写入方"` 这种万能锚就能一句抵十句：整个文件的新假句子
   * 都会被那条登记认领，而登记表上只有一行、看着像认真对过账。
   * 一处登记必须配一个【只指向那一处】的锚 —— 两处原句一模一样的话，anchor 得各带上
   * 邻句的差异，或者干脆把那两句合并改写（重复的读数句子本来就该只留一处）。
   */
  readonly anchorTooBroad: readonly { claim: ZeroClaim; hits: number }[];
}

/**
 * 历史时态的标记。⚠ 这份名单必须【窄】，因为它决定 `historical` 能不能白拿，而白拿的代价是
 * 一句现在时的假话永远不红 —— 那正好是本轮在修的东西。所以：
 *  · 「引用决策编号」**不算**历史标记。`integrity.ts` 那句「src 里零 INSERT，0018 §9 复算」
 *    是现在时、且是假的，引号里的出处是它【援引的依据】而不是它的时态。
 *    （我第一版把编号写进了标记，等于给本轮那条 bug 发通行证。这条取舍值得留在代码里：
 *    标记表宽一档，守卫就从"抓假话"变成"给假话盖章"。）
 *  · 「实测」也**不算** ——本仓现在时的读数句子同样写「实测」。
 * 标记可以是【上一两行】的：注释里时态由邻句承载（「0013 §10.1 量的」在上一行，
 * 下一行才是那句读数），一行窗口是任意的，三行是惯例。
 */
const THEN_MARKERS =
  /量的|当时|此前|原先|原本|曾经|写之前|之后不再|从恒|变成|早已|当年/;

/**
 * 三类对账一次跑完。纯函数：取材（读文件）留在调用方 —— 这样「登记表读成空数组」
 * 那种退化能被单测钉住（同 0062 那三层退化自检的理由）。
 */
export function reconcile(
  sites: readonly ClaimSite[],
  claims: readonly ZeroClaim[],
  producers: readonly Producer[],
): ReconResult {
  const matched = new Set<ZeroClaim>();
  const unregistered: ClaimSite[] = [];
  /** 每条登记命中的第一处原句：表名、时态窗口、引号判定【都从这一处取】。 */
  const siteByClaim = new Map<ZeroClaim, ClaimSite>();
  const hitsByClaim = new Map<ZeroClaim, number>();
  for (const s of sites) {
    const hits = claims.filter(
      (c: ZeroClaim): boolean => c.file === s.file && s.text.includes(c.anchor),
    );
    if (hits.length === 0) {
      unregistered.push(s);
      continue;
    }
    for (const c of hits) {
      matched.add(c);
      hitsByClaim.set(c, (hitsByClaim.get(c) ?? 0) + 1);
      if (!siteByClaim.has(c)) siteByClaim.set(c, s);
    }
  }

  const producing = new Set<string>(
    producers.map((p: Producer): string => p.table),
  );
  const ghosts: ZeroClaim[] = [];
  const stale: TableClaim[] = [];
  const wrongWay: TableClaim[] = [];
  const historicalWithoutMarker: ZeroClaim[] = [];
  const fakeQuote: TableClaim[] = [];
  const tableMismatch: { claim: TableClaim; inText: string }[] = [];
  const disguised: OtherClaim[] = [];
  const anchorTooBroad: { claim: ZeroClaim; hits: number }[] = [];
  for (const c of claims) {
    if (!matched.has(c)) ghosts.push(c);
    const broad = hitsByClaim.get(c) ?? 0;
    if (broad > 1) anchorTooBroad.push({ claim: c, hits: broad });
    const s = siteByClaim.get(c);
    if (c.kind === "other") {
      // other 那一档的硬判据：说明里不许出现真实表名（见 OtherClaim 那条）。
      if (namesRealTable(c.about)) disguised.push(c);
      continue;
    }
    const inText = s !== undefined && s.table !== null ? s.table : undefined;
    if (inText !== undefined && inText !== c.table) {
      tableMismatch.push({ claim: c, inText });
    }
    if (c.expects === "quoted") {
      // 引用必须【真的在引号里】。原句找不到时也算假引用：anchor 连一句都配不上，
      // 说"我只是引用"就没有任何凭据（ghosts 那一维会同时红，两条各说各的）。
      if (s === undefined || !insideQuote(s.text, c.anchor)) fakeQuote.push(c);
      continue;
    }
    // 历史登记必须长得像历史，否则 `historical` 是静音按钮。
    // ⚠ 这里【不看】能不能从原句抽到表名：抽不到表名的行（表名不在反引号里，
    // 如「全仓读写方 0 处」那句）正是 `historical` 最容易白拿的地方 —— 如果"抽不到表名"
    // 就跳过时态核对，那句最需要核对的句子反而免检。
    if (c.historical === true && s !== undefined) {
      THEN_MARKERS.lastIndex = 0;
      if (!THEN_MARKERS.test(s.near)) historicalWithoutMarker.push(c);
    }
    const has = producing.has(c.table);
    if (c.expects === "zero" && has && c.historical !== true) stale.push(c);
    if (c.expects === "has" && !has) wrongWay.push(c);
  }
  return {
    unregistered,
    ghosts,
    stale,
    wrongWay,
    tableMismatch,
    historicalWithoutMarker,
    fakeQuote,
    disguised,
    anchorTooBroad,
  };
}

/**
 * `about` 里是否出现了一张真实表名（词边界匹配，避免 `tasks` 命中 `tasks_extra`）。
 *
 * ⚠ 两个边界都必须允许【串首/串尾】。第一版写成 `[^字]t[^字] | ^t$`，于是
 * `about: "events 这张表的写入方"` 扫不出来 —— 表名恰好落在串首。那种漏法的后果不是
 * 少报一条噪声，是 `disguised` 这一维整个可以绕过：把 `about` 开头写成表名就行。
 * 反向对照丁就是钉这一条的（它的 about 故意以表名开头）。
 */
function namesRealTable(about: string): string | null {
  for (const t of KNOWN_TABLES) {
    const re = new RegExp("(^|[^A-Za-z0-9_])" + t + "($|[^A-Za-z0-9_])");
    if (re.test(about)) return t;
  }
  return null;
}

/** 报错文本：点名到 文件:行 + 原句 + 实际生产者在哪。 */
export function describe(
  r: ReconResult,
  producers: readonly Producer[],
): string {
  const where = (t: string): string =>
    producers
      .filter((p: Producer): boolean => p.table === t)
      .map((p: Producer): string => p.file)
      .join(", ") || "（无）";
  const lines: string[] = [];
  if (r.stale.length > 0) {
    lines.push(
      "【句子在撒谎】登记为 zero 而 src 里查到了写入方：" +
        r.stale
          .map(
            (c: TableClaim): string =>
              c.file + " » " + c.table + " 的写入方在 " + where(c.table),
          )
          .join(" ｜ "),
    );
  }
  if (r.wrongWay.length > 0) {
    lines.push(
      "【反向不符】登记为 has 而 src 里真的没有写入方：" +
        r.wrongWay
          .map((c: TableClaim): string => c.file + " » " + c.table)
          .join(" ｜ "),
    );
  }
  if (r.unregistered.length > 0) {
    lines.push(
      "【没登记的声明句】原文里说了零写入方这一类话而登记表里没有：" +
        r.unregistered
          .map((s: ClaimSite): string => s.file + ":" + s.line + " » " + s.text)
          .join(" ｜ "),
    );
  }
  if (r.ghosts.length > 0) {
    lines.push(
      "【幽灵登记】登记表里有而原文找不到那句：" +
        r.ghosts
          .map((c: ZeroClaim): string => c.file + "@" + c.anchor)
          .join(" ｜ "),
    );
  }
  if (r.tableMismatch.length > 0) {
    lines.push(
      "【登记与句子指的不是同一张表】防的是「拿一张干净的表给脏句子作保」：" +
        r.tableMismatch
          .map(
            (x: { claim: TableClaim; inText: string }): string =>
              x.claim.file +
              " 登记写 " +
              x.claim.table +
              " 而那句说的是 " +
              x.inText,
          )
          .join(" ｜ "),
    );
  }
  if (r.historicalWithoutMarker.length > 0) {
    lines.push(
      "【历史时态无凭据】标了 historical 而原句与上两行里没有过去标记词，所以那句话读起来是现在时：" +
        r.historicalWithoutMarker
          .map((c: ZeroClaim): string => c.file + "@" + c.anchor)
          .join(" ｜ "),
    );
  }
  if (r.fakeQuote.length > 0) {
    lines.push(
      "【假引用】登记成 quoted 而原句没把那句话括进「」：" +
        r.fakeQuote
          .map((c: TableClaim): string => c.file + "@" + c.anchor)
          .join(" ｜ "),
    );
  }
  if (r.disguised.length > 0) {
    lines.push(
      "【把表的事登记成了非表】other 的说明里出现了真实表名：" +
        r.disguised
          .map(
            (c: OtherClaim): string =>
              c.file +
              "@" +
              c.anchor +
              " 说的是 " +
              (namesRealTable(c.about) ?? "?"),
          )
          .join(" ｜ "),
    );
  }
  if (r.anchorTooBroad.length > 0) {
    lines.push(
      "【锚太宽】一条登记的 anchor 命中多处，等于一句抵好几句：" +
        r.anchorTooBroad
          .map(
            (x: { claim: ZeroClaim; hits: number }): string =>
              x.claim.file + "@" + x.claim.anchor + " 命中 " + x.hits + " 处",
          )
          .join(" ｜ "),
    );
  }
  return lines.join("\n");
}
