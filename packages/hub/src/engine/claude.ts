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
 * ── ⭐ 今天真的员工身上【唯一生效的安全边界】是本文件那两个参数 ──────────
 * 说这句话是为了防止一种具体的误读：`harness/` 里有四层预防（safety）、路由（routing）、
 * 预算门（gateway 的 checkBudget / settle）、独立复核（verifier），加起来约 3300 行，
 * 而**它们的注释读起来像是在跑**。事实是 `harness/` 整目录对本模块【零 import】
 * （复算口径见 docs/OPC-OS-功能优化设计.md §1.2：按目录对外的边数，不按文件对文件。
 * 逐模块说一遍是因为死模块哨兵按【模块名 + 否定词】找主张句，只写「整目录」它认不出来。
 * ⚠ 而【把名字和否定词分成两行】它一样认不出来 —— 本段第一版就中招了：四个模块名写在
 * 一行、"对外零 import" 落在下一行，claimSites 一处都没扫到，等于白写了一遍。所以这里
 * 同行写完：harness/gateway.ts、harness/safety.ts、harness/routing.ts、harness/verifier.ts 对外零 import，
 * 本模块一个都不经过。改这段话的人若把它重新排版，请先跑一遍 claimSites 再提交。）
 * 于是真的角色一轮实际经过的只有：
 *   ① `--permission-mode plan` —— 不给写文件的权力（这是 CLI 的一个参数，不是本仓的实现）
 *   ② `--max-budget-usd` —— 单次美元硬顶（同样是 CLI 侧的）
 *   ③ `env: process.env` —— **原样透传**，本层不加任何过滤
 * 这三条都是【真的】边界，别读成「没边界」；但它们也【不是】那四层。
 * 尤其：真给角色放开写权限的那天，必须先接 `harness/safety.ts`，
 * **顺序不能反** —— 先给写权限、后接安全层，中间那段时间里，仓库里躺着 3300 行
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
  const raw = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolveP) => {
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
        resolveP({ code: -1, stdout: "", stderr: String(e), timedOut: false });
      });
      p.on("close", (code) => {
        clearTimeout(t);
        resolveP({ code, stdout, stderr, timedOut });
      });
    },
  );

  if (raw.timedOut) {
    return { ok: false, text: "", sessionId: i.resumeSessionId ?? null, costUsd: 0, error: "执行超时，已杀死该角色进程" };
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
    };
  }
  return {
    ok: true,
    text: typeof j.result === "string" ? j.result : "",
    sessionId,
    costUsd: cost,
    error: null,
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
