/**
 * 角色执行器：一个角色 = 一次 `claude -p` 会话（headless Claude Code）。
 *
 * 这一层刻意【不知道】组织、状态机、门控 —— 它只做一件事：把一个 prompt 交给
 * 一个真的 agent，把它的回答与账单拿回来。为什么这么切：
 *
 * ── 为什么不是 LangGraph ──────────────────────────────────────────
 * 产品的原始诉求是「每个角色像公司里的员工」，而 §5.4 那套是把流转**写死在图里**
 * （7 节点 / 8 条线性边）。员工的判断是【这一轮的产出决定下一步找谁】，那是
 * 运行期的决策，不是编译期的边。所以这里把「下一步找谁」交回 agent，
 * 把「这一步能不能过」留在 hub（见 dispatch.ts）。
 *
 * ⚠ 本模块【只认 CLI】：`claude --version` 实测存在 -p / --resume /
 *   --max-budget-usd / --permission-mode / --output-format json 这些参数。
 *   （版本号【故意不写在这里】：它变了不会让任何东西变红，写死了就是一条会过期的主张。）
 *   文档 §12.1 首选 @anthropic-ai/claude-agent-sdk（进程内、类型化 canUseTool 回调），
 *   本机装不上且【不能假装装了】（复算：`require("@anthropic-ai/claude-agent-sdk/package.json")`
 *   在根与 packages/hub 两处都取不到）。SDK 换进来时要替掉的只有本文件的 execute()
 *   一个函数 —— 这也是把它单独关在这里的原因。
 *
 * ── ⭐ 诚实标注：写文件这一维，今天【兜住写文件】的还是本文件那一个参数 ────
 * ⚠ 这一句是 test/arch/role-spawn-boundary.ts 第 ③ 格盯的字节（`兜住写文件`），
 *   它必须在【第一行代码之前】—— 删了它 ⇒ 那条守卫红。原句「今天唯一生效的安全
 *   边界是本文件那两个参数」round312 起不再是【唯一】（下面第 ⓪ 条是新增的那层），
 *   但【写文件这一维还是那一发兜住的】—— 这句话没过期，过期的是「唯一」两个字，
 *   所以标注跟着语义一起搬，不是把守卫关掉。
 * ~~说这句话是为了防止一种具体的误读：`harness/` 里有四层预防（safety）、路由（routing）、
 * 预算门（gateway 的 checkBudget / settle）、独立复核（verifier），加起来约 3300 行，
 * 而**它们的注释读起来像是在跑**。事实是 `harness/` 整目录对本模块【零 import】~~
 * 【round312 已解（O6 Step B）】本文件的调用方从 `engine/runtime.ts` 直调变成了
 * `harness/gateway-runner.ts` → `adapters/claude.ts` → 本文件 `execute()`。
 * 现在每一轮真的员工在【起进程之前】过的是 `harness/gateway.ts` 的三层判据
 * （forbidden_flags / 沙箱档位 / workspace 绝对性，判的就是 `harness/safety.ts` 的输出），
 * 事后留一行 harness_call 审计。
 * 仍然成立的那半边【继续明说】—— 逐模块说一遍是因为死模块哨兵按【模块名 + 否定词】找主张句，只写「整目录」它认不出来。
 * ⚠ 而【把名字和否定词分成两行】它一样认不出来 —— 本段第一版就中招了：四个模块名写在
 * 一行、"对外零 import" 落在下一行，claimSites 一处都没扫到，等于白写了一遍。所以这里
 * 同行写完：harness/routing.ts、harness/verifier.ts 对外零 import，
 * 本模块一个都不经过。改这段话的人若把它重新排版，请先跑一遍 claimSites 再提交。
 * 于是真的角色一轮实际经过的是：
 *   ⓪ `callHarness` 的四层防护里真在跑的三层 —— 判不过【连进程都不起】；
 *      第 4 层（工具白名单）今天恒空：① 的 plan 模式下没有工具调用可拦
 *   ① `--permission-mode plan` —— 不给写文件的权力（这是 CLI 的一个参数，不是本仓的实现）
 *   ② `--max-budget-usd` —— 单次美元硬顶（同样是 CLI 侧的）
 *   ③ `env: process.env` —— **原样透传**，gateway 与本层都不加过滤
 * 这几条都是【真的】边界，别读成「没边界」；gateway 的预算门（checkBudget / settle）
 * 【仍然没有调用方】，钱在 dispatch 的 onCost 那边记（装配边界，O7 的账）。
 * 尤其：真给角色放开写权限的那天，必须先接 `harness/routing.ts`（O6-3 的顺序硬约束），
 * **顺序不能反** —— 先给写权限、后接路由，中间那段时间里，仓库里躺着两个模块
 * 看起来像防线而一行都不执行的代码，而它比「根本没有防线」更危险，
 * 因为下一个人会以为已经防住了。缺口与接线顺序登记在
 * docs/OPC-OS-功能优化设计.md 的 O6。
 */

/** 一次执行的入参。cwd 决定这个 agent 能碰哪些文件（§12 的沙箱那一维）。 */
export interface RoleRunInput {
  readonly prompt: string;
  /** 角色身份 = 追加到系统提示。**不含**任何「你可以推进状态机」的授权。 */
  readonly rolePrompt: string;
  /** 上一轮会话 id；有值就 --resume，让员工接着上次的上下文说话而不是重头自我介绍。 */
  readonly resumeSessionId?: string;
  readonly cwd: string;
  /** 美元硬顶，直接给 --max-budget-usd。不是提示词里的「别花太多」。 */
  readonly maxBudgetUsd: number;
  readonly timeoutMs?: number;
  /** 二进制名/路径。测试注入桩 CLI 用这一格（不是「测试专用后门」，是同一个入口）。 */
  readonly bin?: string;
}

export interface RoleRunResult {
  readonly ok: boolean;
  readonly text: string;
  readonly sessionId: string | null;
  readonly costUsd: number;
  /** 失败时给人看的一句话。成功时 null。 */
  readonly error: string | null;
  /**
   * 子进程【真的起来过】吗 —— round305 为 Task 6.1 的接线加的判据字段。
   *
   * ⚠ 它【不是】`error` 的派生量，而这一句是整个设计的支点。
   * 我本来打算用「这次失败没花钱」（costUsd === 0）当「重试不会多烧钱」的判据，
   * 量完发现那条推不过去：`is_error:true` 那一支带【非零】 cost 而 JSON 解得出来
   * （CLI 跑起来了、活了、报了业务错 ⇒ 钱真花了），但同一条分支在
   * `total_cost_usd` 缺失时给的是 cost = 0 —— 「没记到钱」与「没花钱」在旧形状里
   * 【同一个读数】。拿一个分不出这两者的数去决定「要不要再花一次」是拿猜测当判据。
   * ⇒ 「有没有起过进程」必须由【走到哪条返回路径】结构性地知道，不能由钱反推。
   * 只有 `started === false`（spawn 自己抛 ENOENT/EACCES 这类）才是
   * 「进程没存在过 ⇒ 结构上不可能花过钱」，也才是重试唯一被允许介入的那一格。
   */
  readonly started: boolean;
  /**
   * `started === false` 时带 spawn 自己的 errno 名（ENOENT / EPERM / EMFILE …），
   * 其余情况是空串。为什么要把【errno 名】带出来而不是只带「没起来」：
   * 「进程没起来」这一族里既有【确定性】失败（ENOENT：二进制不存在，重试第 4 次
   * 与第 1 次一模一样）也有【瞬时】失败（EMFILE：进程表满了，几百毫秒后就有了），
   * 而 retry.ts 文件头那条立场明确写着确定性失败【不该】重试。只看布尔值就分不开
   * 这两类，就只能要么全重试（污染审计 + 白等退避）要么全不重试（Task 6.1 白接）。
   *
   * 实测本机（node v24，round305）三种形状：
   *   二进制不存在        ⇒ 异步 error 事件，code=ENOENT
   *   bin 指着一个目录    ⇒ 异步 error 事件，code=ENOENT（同上，别以为是 EISDIR）
   *   bin 指着普通文件    ⇒ 【同步】从 spawn() 抛出 EFTYPE，根本不走 error 事件
   * 第三型这一格单独说：同步抛出会被 Promise 构造器吞成 rejection，
   * 于是 runRole 本身 reject 而不是返回 ok:false —— 那是【本轮之前就有的】形状，
   * 本轮没有改它（改动会把「装配传错 bin」这种响亮的崩溃换成一条记录的失败轮），
   * 只把它登记在台账 round305 §④。
   */
  readonly spawnErrno: string;
}

/**
 * 「进程没起来」这一族里【该】重试的那几个 errno。
 *
 * 判据只有一句：这个失败是【下一次可能就没了】的吗。写白名单而不是黑名单，
 * 与 policy/engine.ts 的 fail-closed 同一个立场 —— 没听过的 errno 一律【不】重试，
 * 因为认错的代价不对称：漏一个瞬时错 = 少重试一次（今天的行为，无损），
 * 多放一个确定性错 = 每轮白等 1+2+4 秒并多三行日志。
 *
 * ⚠ 这张表今天【一个真样本都没有】：本轮在本机能造出来的 started:false 形状只有
 * ENOENT（确定性，已被排除在这一族之外），EAGAIN/EMFILE 这类要真把系统资源打满
 * 才出得来，本轮没有制造它。⇒ 表里这几个名字是【按 POSIX 语义列的候选】，
 * 不是【测出来的可自愈集合】；接线本身由 turn-retry.test.ts 用注入的假 runRole
 * 证明，那一族在真实机器上到底会不会自愈【仍未验】（台账 round305 §③）。
 */
export const SPAWN_TRANSIENT_ERRNOS: readonly string[] = Object.freeze([
  "EAGAIN", // 资源暂时不可用（fork/spawn 太快的经典形状）
  "EMFILE", // 本进程文件描述符用完
  "ENFILE", // 全系统文件表满
  "ECONNRESET",
  "EPIPE",
]);

/**
 * 这一轮失败【可以】重试吗 —— Task 6.1 的接线判据，round305。
 *
 * 两条都要成立，而且第一条【不是】「没花钱」：
 *  ① `!started` ⇒ 子进程从未存在 ⇒ 【结构上】不可能产生过任何账单。
 *     这条与机器快慢、CLI 版本、JSON 里有没有 total_cost_usd 全都无关，
 *     因为它由「进程没起来」这个事实推出，不是由任何读数推出。
 *  ② errno 在那张瞬时表上 ⇒ 这是一个【下一次可能就没了】的失败。
 *
 * ⚠ ① 反过来不成立，而这一句是本轮最要紧的一句：
 *   「没记到钱」【不等于】「没花钱」。超时那一支（被 SIGKILL 的进程没机会报账）
 *   和 `is_error:true` 而 cost 字段缺失那一支，costUsd 都是 0，钱都可能真花了。
 *   拿 costUsd===0 当判据会把这两种都放进重试，而重试一次就是【再花一次钱】。
 *   所以这里【不看钱】。
 *
 * 覆盖面因此【极小，这是量出来的而不是设计的】：本机可复现的 started:false 全是
 * ENOENT（确定性 ⇒ 被 ② 挡掉）⇒ 今天这条判据在真机上【一次都不会放行重试】。
 * 那为什么还要接：② 是那张瞬时 errno 表的执行者，而它的价值在装配错 bin 之外的
 * 资源型故障上（那种故障今天会让 hub 直接崩在 spawn 上而不是留痕）。
 * 剩下的那一大块（超时、CLI 业务错、网络抖动）等的是【每次尝试各自记一次账】，
 * 那要动 harness_calls 的写入形状与 dispatch 的记账 —— 那是 O6 接线的账，不在本轮，
 * 理由写在 .workbuddy/AUDIT-LEDGER.txt round305 段里。
 */
export function retryableWithoutCost(r: RoleRunResult): boolean {
  if (r.ok || r.started) return false;
  return (SPAWN_TRANSIENT_ERRNOS as readonly string[]).includes(r.spawnErrno);
}

/** claude -p --output-format json 的响应里我们读的字段。其余一律不猜。 */
interface HeadlessJson {
  readonly is_error?: boolean;
  readonly result?: unknown;
  readonly session_id?: unknown;
  readonly total_cost_usd?: unknown;
}

export async function runRole(i: RoleRunInput): Promise<RoleRunResult> {
  const args = [
    "-p",
    "--output-format",
    "json",
    // plan 模式：这一层不给任何角色写文件的权力。真让员工动手时，走 §12 的
    // harness 沙箱档位（workspace-write）+ 显式批准，而不是在这里放开。
    "--permission-mode",
    "plan",
    "--append-system-prompt",
    i.rolePrompt,
    "--max-budget-usd",
    String(i.maxBudgetUsd),
  ];
  if (i.resumeSessionId !== undefined && i.resumeSessionId !== "") {
    args.push("--resume", i.resumeSessionId);
  }

  const { spawn } = await import("node:child_process");
  const bin = i.bin ?? "claude";
  // Windows 下无法直接 exec 带 shebang 的 .js/.mjs 脚本（spawn 会报 EFTYPE/ENOENT）：
  // 当 bin 指向 JS 脚本时绕 process.execPath 跑，真的 claude 二进制仍直接跑。
  const raw = await new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    /** 见到过 close 吗 —— 也就是「那个进程存在过」。见 RoleRunResult.started。 */
    spawned: boolean;
    /** 只在 spawned=false 那一支有值：spawn 自己抛的 errno 名（ENOENT / EACCES / …）。 */
    spawnErrno: string;
  }>((resolveP) => {
    const argv = /\.[cm]?js$/.test(bin) ? [bin, ...args] : args;
    const p = spawn(/\.[cm]?js$/.test(bin) ? process.execPath : bin, argv, { cwd: i.cwd, env: process.env });
    // prompt 走 stdin 而不是 argv：想法文本由 CEO 输入，放进 argv 会出现在
    // `ps` 里，也会被下一个写适配器的人顺手拼进 shell 字符串。
    p.stdin.write(i.prompt);
    p.stdin.end();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, i.timeoutMs ?? 180_000);
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("error", (e) => {
      clearTimeout(t);
      // timedOut 必须是显式的 false：漏掉这个字段在【运行时】看不出问题（下面只读
      // raw.timedOut，undefined 一样是假），而类型上它救了一次「spawn 失败被当成超时」。
      // ⚠ spawned:false 走的是【这一支】而不是上面那个 setTimeout：node 对 ENOENT
      //   是【异步】发 error 事件（spawn() 本身不抛），所以「没起来」在今天只会以
      //   「stdout 空 + exit=-1」的形状出现 —— 而那个形状与「CLI 输出不是 JSON」
      //   在旧返回值里【完全同形】。errno 名要在这里取，出了这一支就没了。
      resolveP({
        code: -1,
        stdout: "",
        stderr: String(e),
        timedOut: false,
        spawned: false,
        // errno 名【只在这一支取得到】，出了这里就没了（下面的返回点全靠 Promise 带出来）。
        spawnErrno: typeof (e as { code?: unknown })["code"] === "string"
          ? String((e as { code?: unknown })["code"])
          : "",
      });
    });
    p.on("close", (code) => {
      clearTimeout(t);
      resolveP({ code, stdout, stderr, timedOut, spawned: true, spawnErrno: "" });
    });
  });

  if (raw.timedOut) {
    // started:true 而【不是】false，尽管这里 costUsd 写的是 0 —— 这一格是本轮
    // 最容易写错的一格：超时那一支报 0 成本，看起来「没花钱、可以重试」，
    // 真相是【被 SIGKILL 的那个进程没机会报账】。它可能已经跑了几十秒、
    // 烧掉了几十万 token 才按下停止键，而那笔钱不会出现在任何一个字段里。
    // ⇒ 「0 成本」在超时这一支的含义是【未知】，不是【零】。
    //   能声称结构上没花过钱的只有 spawned=false（进程从未存在）。
    return {
      ok: false,
      text: "",
      sessionId: i.resumeSessionId ?? null,
      costUsd: 0,
      error: "执行超时，已杀死该角色进程",
      started: true,
      spawnErrno: "",
    };
  }
  // 解析不猜形状：解不出来就是失败，并且把原文（截断）带回去。
  // 「stdout 半行 / 交错日志」正是 §12.1 列的 CLI 兜底路径故障模式，宁可报得难看。
  let j: HeadlessJson;
  try {
    j = JSON.parse(raw.stdout.trim()) as HeadlessJson;
  } catch {
    return {
      ok: false,
      text: "",
      sessionId: i.resumeSessionId ?? null,
      costUsd: 0,
      error:
        "CLI 输出不是预期的 JSON（exit=" + String(raw.code) + "）：" +
        (raw.stderr || raw.stdout).replace(/\s+/g, " ").slice(0, 300),
      // spawned=false 那一支（ENOENT 等）落在这里：stdout 是空串，JSON.parse 必然抛。
      // 这就是「找不到二进制」今天的形状，而它以前与「CLI 真的起来而输出坏了」同形。
      started: raw.spawned,
      spawnErrno: raw.spawnErrno,
    };
  }
  const cost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : 0;
  const sessionId = typeof j.session_id === "string" ? j.session_id : null;
  if (j.is_error === true || raw.code !== 0) {
    return {
      ok: false,
      text: typeof j.result === "string" ? j.result : "",
      sessionId,
      costUsd: cost,
      error: (typeof j.result === "string" ? j.result : "角色执行失败").slice(0, 400),
      started: raw.spawned,
      spawnErrno: raw.spawnErrno,
    };
  }
  return {
    ok: true,
    text: typeof j.result === "string" ? j.result : "",
    sessionId,
    costUsd: cost,
    error: null,
    // 走到这里 JSON 解出来了 ⇒ 进程必然存在过。写【字面量 true】而不是 raw.spawned：
    // 「成功蕴含起过进程」这一条如果由 raw.spawned 推，那么哪天有人给上面补一条
    // 「spawned=false 也往下走」的捷径，这里会静默跟着变 true 而没人察觉；
    // 写成常量则那条捷径会让这一支与那条捷径【互相矛盾地】红在测试里
    // （turn-retry.test.ts 里那发「ENOENT ⇒ started=false」第一个响）。
    started: true,
    spawnErrno: "",
  };
}

/**
 * 从员工的自由回答里取出「它决定下一步做什么」那一段。
 *
 * 员工的话是大段自然语言（那正是产品的价值 —— 它得像人在汇报），
 * 而 hub 需要一个可判定的东西。所以要求末尾带一段结构化决策，而不是
 * 让 hub 去**猜**「我觉得可以交给测试了」算不算交接 —— 猜错一次的代价是
 * 状态机自己走了一步，而那步没有人在场。
 *
 * 取不到就返回 null，由调用方判失败并【留在原状态】（而不是默认交接给下游）。
 * 「默认往下走」会让一次格式跑偏变成一次静默推进，那是本仓最恨的那类失效。
 */
export const DECISION_MARK = "<<<OPC_DECISION>>>";

/**
 * 四个而不是三个动作。§8.2 第 3 条给审阅者的三个出口是「通过 / 打回 / 升级」，
 * 而「打回」与「交给下属干活」在组织图上是【两个方向】（前者沿汇报树向上，
 * 后者向下）—— 只有 handoff 一个词的话，hub 无法区分「审阅者通过了这份产出」
 * 和「审阅者把活儿塞给某人」，而那两者对应的状态边完全不同（§7.1：
 * IN_REVIEW → APPROVED_UPWARD vs IN_REVIEW → REJECTED_DOWNWARD）。
 * 把方向压进提示词让 agent 用自然语言表达、再由 hub 猜，就是把判定交给猜。
 */
export const ROLE_ACTIONS = ["pass", "handoff", "blocked", "wait"] as const;
export type RoleAction = (typeof ROLE_ACTIONS)[number];

export interface RoleDecision {
  /**
   * pass=我这一轮做完了，按汇报树往上走 | handoff=交给某个【下属】角色做
   * | blocked=必须 CEO 拍板 | wait=还没做完，需要再推一次。
   */
  readonly action: RoleAction;
  readonly to_role?: string;
  readonly summary: string;
  readonly note?: string;
}

export function parseDecision(text: string): RoleDecision | null {
  const idx = text.lastIndexOf(DECISION_MARK);
  if (idx < 0) return null;
  const tail = text.slice(idx + DECISION_MARK.length).trim();
  const braceStart = tail.indexOf("{");
  const braceEnd = tail.lastIndexOf("}");
  if (braceStart < 0 || braceEnd <= braceStart) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail.slice(braceStart, braceEnd + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const action: string = typeof o["action"] === "string" ? o["action"] : "";
  if (!(ROLE_ACTIONS as readonly string[]).includes(action)) return null;
  if (typeof o["summary"] !== "string" || o["summary"].trim() === "") return null;
  const a = action as RoleAction;
  return {
    action: a,
    // 只有 handoff 带收件人。pass 的下一跳由【汇报树】决定，agent 点名也没用 ——
    // 所以这里刻意不把它塞进 to_role：留着就等于邀请调用方去读一个契约外的通道。
    ...(a === "handoff" ? { to_role: typeof o["to_role"] === "string" ? o["to_role"] : "" } : {}),
    summary: o["summary"].trim(),
    ...(typeof o["note"] === "string" ? { note: o["note"].trim() } : {}),
  };
}
