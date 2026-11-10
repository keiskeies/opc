/**
 * Harness 的四层安全防护（计划 Task 5.2，规格 §12.7 + §4.1.3 + §20.2）。
 *
 * ── 这个文件的立场只有一句 ─────────────────────────────────────────
 * 规格 §12.7 开头那句是「OPC-OS **不在 Gateway 里重建一套权限系统**，而是利用 harness
 * 原生权限机制，在外层叠加审阅门控」。所以这里每一条判据都必须回答一个问题：
 * **【这条是 harness 拦不住的吗？】** 拦得住的（比如沙箱内的文件权限）不重复实现，
 * 拦不住的（自动批准模式、提级、越界路径、禁用 flag）才在这里拦。
 * 重复实现的那一套会给人两种错觉：一是「我们有权限系统」，二是 harness 侧的
 * 配置可以放松 —— 而 §12.7 表头写的正是「与 harness 原生权限**叠加**」，两层都要在。
 *
 * ── 四层的顺序就是优先级，且【前一层不能替后一层说话】──────────────
 *   1 白名单     —— 这个工具根本不该被调
 *   2 沙箱档位   —— 这个档位的写权限不该出现在这一刻
 *   3 高风险暂停 —— 可以做，但要人看一眼（走 SDK 回调，不是解析输出）
 *   4 绝对禁止项 —— 永远不行，且运行时**不可覆盖**
 * 顺序里第 4 层其实可以最先判（它是绝对禁令），之所以放最后：**报错要给最近的那一层**，
 * 而「这个工具压根不在白名单」比「你传了 --yolo」更接近当事人真正该改的地方。
 * 唯一不受这条约束的是 forbidden_flags：它命中时**不再往下判**，也不因为白名单里有
 * 对应工具就放过 —— 白名单说「这个工具可以用」，禁令说「这个参数永远不能用」，两句不矛盾。
 *
 * ── 本文件不含 I/O，也不写审计 ─────────────────────────────────────
 * 全部函数是纯判定，返回的是【该写什么审计】而不是自己去写。理由与 org/validate.ts 同：
 * 一旦把 I/O 塞进判据，判据就没法在「库还没建好」的时候被问，而安全判据最需要被问的
 * 时机正是装配阶段。写审计的动作在 gateway.ts，它拿到 BlockResult 就落一条
 * unauthorized_attempt（action 用既有枚举，见 events/recorder.ts，不自造新的）。
 */
import {
  type ApprovalHandler,
  type ApprovalPolicy,
  type RiskTier,
  type SandboxTier,
  SANDBOX_TIERS,
  type ToolApprovalRequest,
} from "@opc/contracts";
import { classifyAction, type ActionDraft } from "../policy/engine.js";

/** 拒绝码。审计里要按码统计（「今天有多少次是提级尝试」），自由文本做不了。 */
export const SAFETY_BLOCK_CODES = [
  "tool_not_allowed",
  "sandbox_tier_raised",
  "sandbox_tier_unknown",
  "forbidden_flag",
  "workspace_escape",
  "approval_denied",
  "approval_handler_missing",
  "approval_too_late",
] as const;
export type SafetyBlockCode = (typeof SAFETY_BLOCK_CODES)[number];

export type SafetyVerdict =
  | { ok: true }
  | {
      ok: false;
      code: SafetyBlockCode;
      /** 给人看的那一句；必须可操作（「把 X 从白名单去掉」而不是「不合规」）。 */
      reason: string;
      /** 命中了哪一条绝对禁止项等，进审计 payload。 */
      detail?: Record<string, unknown>;
    };

function block(
  code: SafetyBlockCode,
  reason: string,
  detail?: Record<string, unknown>,
): SafetyVerdict {
  return detail === undefined ? { ok: false, code, reason } : { ok: false, code, reason, detail };
}

/**
 * 档位下标。**故意不做成 Record<SandboxTier, number> 常量表**：
 * 那样加一档时很容易只加键不改顺序，而这里的判据依赖的是**数组下标单调递增**这件事，
 * 它就挂在 contracts 里那条「排序有意义」的注释上。
 * 不认识的值 ⇒ 【最严】那一档的下标（= danger），而不是 -1 或抛错。
 *
 * ⚠ 但这个方向**只对请求侧成立**，所以授权侧由 sandboxTierBlock 单独先判（见那里）：
 *  - 请求侧不认识 ⇒ 当成 danger ⇒ 任何授权档位都算被提级 ⇒ **多拦**（方向正确）；
 *  - 授权侧不认识 ⇒ 当成 danger ⇒ 任何请求都不算提级 ⇒ **少拦**（方向错误）。
 * 一侧的下标函数服务不了两个相反的期望方向 —— 这就是本仓那一族
 * 「同一个函数在两个调用点上语义相反」的形状，我第一版没看出来它只有一边是对的。
 */
export function sandboxTierIndex(tier: string): number {
  const i: number = (SANDBOX_TIERS as readonly string[]).indexOf(tier);
  return i < 0 ? SANDBOX_TIERS.length - 1 : i;
}

/* ═════════════════ 第 4 层：绝对禁止项（先写，因为它最硬） ═════════════════ */

/**
 * 归一化一个命令行 flag，用于比对禁用项。
 *
 * 为什么必须归一而不是直接 `includes`：**这条判据的对抗面就是改写形状**。
 * 实测过的等价写法族（同一族错在 0019 §5 里记过多次「形状变了而语义没变」）：
 *   --yolo / --yolo=true / --yolo=true / --yolo / --YOLO
 * 不归一的话，`forbidden_flags: ["--yolo"]` 只挡得住第一种，而那正是最没人会用的写法。
 *
 * 口径（写死，两侧必须同一份实现所以只在这里有一份）：
 *  1. 转小写（`--YOLO` 与 `--yolo` 在真实 CLI 上是同一个开关，Windows 与多数 Node 解析器都大小写不敏感）；
 *  2. `=` 及其后的值**剥掉**（`--yolo=false` 也命中 —— 见下面那条解释）；
 *  3. 前导 `-` 全部去掉（`--yolo` 与 `-yolo` 等价对待）；
 *  4. 剩下的必须是 `[a-z0-9_-]+`，否则视为【无法归一】返回原串小写。
 *
 * 为什么 `--yolo=false` 也要拦：这是本文件里唯一一处**故意过度拦截**。
 * 直觉上「显式关掉危险开关」不该被拦，但 Gateway 读的是参数字符串，而
 * **各家 harness 的 flag 解析器对 `--flag=false` 的语义是否一致，我没有核验**
 * （本机无网络、依赖目录里只有 typescript / zod / @types / @opc，装不上任何 CLI
 * 参数解析库，也拿不到三家 SDK）。我能自己证的一半是：Node 生态里确实存在
 * 「带值的出现即视为开关被设置」这类解析约定，所以 `--yolo=false` 到底是不是关闭，
 * **取决于具体解析器，而这不是一个我们能在离线状态断言的事实**。
 * 所以判据不建在那个断言上：命中就拦。要表达「明确不用这个开关」，
 * 正确做法是**别传这个 flag**，而不是传一个 false —— 这条不依赖任何解析器行为，
 * 因此在三家上面都成立。过度拦截的代价（偶尔拦掉一个无害写法）
 * 与漏拦的代价（一次越权被执行且写进 append-only 审计）不对称。
 */
export function normalizeFlag(flag: string): string {
  const lower: string = String(flag).trim().toLowerCase();
  const head: string = lower.split("=")[0] as string;
  const bare: string = head.replace(/^-+/u, "");
  return /^[a-z0-9_-]+$/u.test(bare) ? bare : lower;
}

/**
 * 第 4 层：请求参数里有没有命中绝对禁止项。
 *
 * `runtimeAdded` 那一支是 §20.2「只能收窄不能放宽」的**执行点**：
 * 运行时可以往禁用项里**加**（收紧），不能**减**。这里的判据不是「长度没变短」
 * （那个判据被 `["--yolo"] → ["--yolo-2"]` 骗过去，也被
 * `["--yolo"] → ["--yolo","--yolo"]` 这种重复项骗过去），而是
 * **基线里每一条都还在**，且比较用的是归一化后的集合。
 */
export function forbiddenFlagBlock(o: {
  /** 岗位书声明的基线（不可减）。 */
  baseline: readonly string[];
  /** 本次调用实际生效的禁用项（基线 + 运行时追加）。 */
  effective: readonly string[];
  /** 本次调用要传给 harness 的参数。 */
  args: readonly string[];
}): SafetyVerdict {
  const base = new Set(o.baseline.map(normalizeFlag));
  const eff = new Set(o.effective.map(normalizeFlag));
  const dropped: string[] = [...base].filter((f: string): boolean => !eff.has(f));
  if (dropped.length > 0) {
    return block(
      "forbidden_flag",
      "运行时试图【缩短】绝对禁止项，被拒。规格 §20.2：权限只能收窄不能放宽 —— " +
        "被移除的条目：" +
        dropped.join(", ") +
        "。要调整禁止项请改岗位书并升 version，走审计。",
      { removed_flags: dropped },
    );
  }
  const hits: { arg: string; flag: string }[] = [];
  for (const a of o.args) {
    const n: string = normalizeFlag(a);
    if (eff.has(n)) hits.push({ arg: a, flag: n });
  }
  if (hits.length > 0) {
    return block(
      "forbidden_flag",
      "调用参数命中绝对禁止项，被拒且不会执行：" +
        hits.map((h) => h.arg + "（归一化 " + h.flag + "）").join("、") +
        "。规格 §4.1.3：forbidden_flags 不可覆盖 —— 即使 Agent 尝试传入，" +
        "Gateway 拒绝并记一次越权尝试。想表达「明确不用这个开关」，正确做法是【不传它】。",
      { hits },
    );
  }
  return { ok: true };
}

/* ═════════════════ 第 1 层：工具白名单 ═════════════════ */

/**
 * 白名单条目支持两种形状（规格 §4.1.3 那份 YAML 里【同时出现】了两种：
 * `"Edit"` 与 `"Bash(git:*)"`），所以不能只做全等比较。
 *
 * 口径：
 *  1. 全等（大小写敏感 —— Claude 的工具名 `Read` / `edit` 是两个不同值，
 *     这里做大小写不敏感就会把「只授了 Edit」扩成「Edit 与 edit 都授了」）；
 *  2. `Name(prefix:*)` 形状 ⇒ 放行 `Name` 带该前缀的参数（前缀比对的是
 *     argCandidates() 给出的**候选串**，见那个函数）；
 *  3. **不带括号的条目不放行任何带参数的形式**？不 —— 那样 `Bash` 授了却一次都调用不了。
 *     实际口径：不带括号 ⇒ 该工具任意参数都放行。这条**是**一个已知的宽松，
 *     写下来是因为它容易被误读成收紧：想要「只允许 git 子命令」必须写 `Bash(git:*)`。
 */
export function toolAllowed(
  tool: string,
  allowlist: readonly string[],
  args: unknown,
): boolean {
  for (const entry of allowlist) {
    if (entry === tool) return true;
    const m: RegExpMatchArray | null = /^([A-Za-z0-9_-]+)\((.+)\)$/u.exec(entry);
    if (m === null) continue;
    if (m[1] !== tool) continue;
    const patterns: string[] = (m[2] as string).split(",").map((s) => s.trim());
    const texts: string[] = argCandidates(args);
    for (const p of patterns) {
      // "git:*" 与 "git *" 两种写法都收（规格里是前者，Claude 文档里是后者）。
      const prefix: string = p.replace(/:\*$/u, "").replace(/\*$/u, "").trim();
      if (prefix === "") return true;
      if (texts.some((t: string): boolean => t.startsWith(prefix))) return true;
    }
  }
  return false;
}

/**
 * 参与前缀比对的**候选串**。
 *
 * 这条是测试逼出来的（test/harness/safety.test.ts 里那两条「Bash(git:*)」用例最初是红的）：
 * 我第一版把参数 `JSON.stringify` 之后比前缀，于是
 * `{command: "git status"}` 变成 `{"command":"git status"}` —— **以 `{` 开头**，
 * 永远不以任何命令名开头。后果是 §4.1.3 里 `"Bash(git:*)"` 那一条
 * 对**任何真实工具调用**都不生效（真实 harness 的参数一律是对象，不是裸字符串），
 * 而它的失效方向是「全拒」：看起来安全，实际是把岗位书里那条授权变成了废纸，
 * 于是接上真 harness 的那天所有人看到的是一屏 tool_not_allowed，
 * 修法必然是「先把白名单放松一下」—— 那就等于用一条写不通的授权换掉了一次收紧。
 *
 * 所以口径是：对象参数按**已知键**取出各自的值作为候选（一家一个键名也要能命中），
 * 再把整份 JSON 当一个候选兜着（保住「裸字符串参数」与将来新键的可用性）。
 * 取的是【startswith】语义所以键名本身不参与：不会出现「command 这个键名撞到 c 前缀」那种命中。
 */
const ARG_TEXT_KEYS = [
  "command",
  "cmd",
  "script",
  "args",
  "path",
  "file_path",
  "target",
  "url",
  "prompt",
] as const;

export function argCandidates(args: unknown): string[] {
  if (typeof args === "string") return [args];
  const out: string[] = [];
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    for (const k of ARG_TEXT_KEYS) {
      const v: unknown = (args as Record<string, unknown>)[k];
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
    }
  }
  out.push(argText(args));
  return out;
}

/**
 * 把参数压成一行文本。用于两处：白名单前缀比对的兜底候选，
 * 以及 classifyAction 的 detail（那张表是全子串匹配，所以整份 JSON 也能命中 `rm -rf `）。
 * 非字符串参数走 JSON，循环引用退化成 typeof。
 */
function argText(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return typeof args;
  }
}

/** 第 1 层判定。 */
export function toolWhitelistBlock(
  tool: string,
  allowlist: readonly string[],
  args: unknown,
): SafetyVerdict {
  if (toolAllowed(tool, allowlist, args)) return { ok: true };
  return block(
    "tool_not_allowed",
    "工具 [" +
      tool +
      "] 不在本次调用的白名单里（白名单：" +
      (allowlist.length > 0 ? allowlist.join(", ") : "【空】") +
      "）。白名单为空 ⇒ 任何工具都不放行，这是刻意的：一份没写 tool_permissions 的岗位书" +
      "不该得到一个全能的执行器。要放开请在岗位书 tool_permissions 里加。",
    { tool, allowlist },
  );
}

/* ═════════════════ 第 2 层：沙箱档位不得提级 ═════════════════ */

/**
 * 第 2 层。`granted` 是岗位书/路由给的档位，`requested` 是这一次调用想用的档位。
 *
 * 为什么要单独判这一条（harness 自己不会拒绝提级吗？）—— **不会**，
 * 因为提级动作在我们这一侧：Gateway 是把档位作为参数**交给** harness 的那一方。
 * harness 只会照办。所以「agent 要求从 read-only 提到 workspace-write」这件事
 * 只有在这里能被拦住，这也是计划 Task 5.2 把它列为四条必测绕过尝试之一的原因。
 *
 * 降档（requested < granted）⇒ **放行**。降档不放宽任何权限，
 * 而 §12.5 那个缺陷修复流程要求的正是「先 read-only 分析，再 workspace-write 修复」，
 * 一个把升降档一律拒的实现会直接把这个流程做不出来。
 */
export function sandboxTierBlock(
  granted: SandboxTier,
  requested: SandboxTier,
): SafetyVerdict {
  // 两侧任一是【没听过的档位】就先拒，不进入下标比较。
  // 走不到这里本来应该由 schema 保证（请求侧是 enum，授权侧类型是 SandboxTier），
  // 但授权侧的实际来源是岗位书 YAML / 路由表 —— 那是**读进来再转型**的，
  // 一个写错的 `sandbox: "workspace"` 在运行时就是一个字符串，类型拦不住它。
  // 让它进下标比较会得到「授权侧按 danger ⇒ 任何请求都放行」，
  // 也就是「岗位书里打错一个档位名 ⇒ 该角色拿到最高档」，这必须是拒而不是放。
  for (const [side, t] of [
    ["授权", granted],
    ["请求", requested],
  ] as const) {
    if (!(SANDBOX_TIERS as readonly string[]).includes(t)) {
      return block(
        "sandbox_tier_unknown",
        side + "侧的沙箱档位 [" +
          String(t) +
          "] 不是已知档位（已知：" +
          SANDBOX_TIERS.join(" < ") +
          "）。刻意【不按最严档放行也不按默认档处理】：一个写错的档位名意味着" +
          "『我们不知道这次授予/请求了什么权限』，而不知道就必须停下来问，" +
          "不能替它挑一个档位。请改岗位书或路由表里的 sandbox。",
        { side, tier: String(t), known: SANDBOX_TIERS },
      );
    }
  }
  const g: number = sandboxTierIndex(granted);
  const r: number = sandboxTierIndex(requested);
  if (r <= g) return { ok: true };
  return block(
    "sandbox_tier_raised",
    "沙箱档位提级被拒：授权 [" +
      granted +
      "]（第 " +
      g +
      " 档），本次想用 [" +
      requested +
      "]（第 " +
      r +
      " 档）。降档是允许的（§12.5 的缺陷修复正是 read-only 分析 → workspace-write 修复，" +
      "那是【分两次调用】而不是一次提级）。要更高档位只能改岗位书/路由表。",
    { granted, requested },
  );
}

/* ═════════════════ 工作区越界 ═════════════════ */

/**
 * 路径是否落在工作区内。**自己实现而不用 `path.relative` 的 startsWith("..")** 口径，
 * 因为那条判据在一件事上是错的：`/repo/../other/x` 的 relative 结果不以 ".." 开头
 * 的情况取决于两侧是否已 normalize，而 harness 拿到的常常是**未 normalize** 的串。
 * 这里的做法是先 normalize 两侧再比前缀，并要求边界落在路径分隔符上
 * （否则 `/repo-evil` 会被判成在 `/repo` 里面 —— 那是我第一版的写法，被自己那条
 * 反向对照用例抓住了）。
 *
 * 符号链接**不在这里解**（`realpath` 需要 fs，而本文件是纯判定）。
 * 这是本模块一条真实边界，写在 §「本模块挡不住什么」里而不是藏起来。
 */
export function isInsideWorkspace(workspace: string, target: string): boolean {
  const root: string = normalizeAbs(workspace);
  const p: string = normalizeAbs(target);
  if (p === root) return true;
  return p.startsWith(root.endsWith("/") ? root : root + "/");
}

function normalizeAbs(p: string): string {
  const parts: string[] = [];
  const abs: boolean = p.startsWith("/");
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!abs) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return (abs ? "/" : "") + parts.join("/");
}

/** 第 2 层的另一半：写操作的目标路径必须在工作区内。 */
export function workspaceContainmentBlock(
  workspace: string,
  target: string,
): SafetyVerdict {
  if (isInsideWorkspace(workspace, target)) return { ok: true };
  return block(
    "workspace_escape",
    "写操作目标越出工作区，被拒：工作区 [" +
      workspace +
      "]，目标 [" +
      target +
      "]。沙箱档位管的是【能改什么类型的东西】，这一条管的是【能改哪里的东西】，" +
      "两者不互相替代。",
    { workspace, target },
  );
}

/* ═════════════════ 第 3 层：高风险调用暂停 ═════════════════ */

/**
 * 这一次工具调用要不要停下来问人。
 *
 * 判据**复用 policy/engine.ts 的 classifyAction**，不在这里另写一份不可逆模式表。
 * 理由不是省事：规格 §9.1 那三档风险分级已经有了一份子串表，而「什么算不可逆」
 * 这件事如果有两份表，一定是一份加了 `git push --force` 而另一份没加 ——
 * 那正是 §9.1 与 §12.7 给出两种答案的形状（同一次调用，审批路由说安全、harness 层说不可逆）。
 * 两份表同源之后，「同一次调用两处判成不同档」在结构上不可能发生。
 *
 * ⚠ 这里【不看】`approval_policy`，是刻意的，所以干脆不把它做成入参
 * （做成入参而不用，下一个人会以为它被尊重了）。§12.8 允许的是
 * 「**车间内的自主**」—— harness 内部循环里逐工具的审批用 `never` 关掉是对的；
 * 但同一段最后一句把**向上交接的边界**划了出去。不可逆操作正落在边界上：
 * 「这个 harness 配了 never」不是「这次 `rm -rf` 可以批」的理由。
 * 换句话说 `approval_policy` 控制的是**第 3 层以下**的噪音，第 3 层本身不由它开关 ——
 * 能由被调用方的一个参数关掉的安全层，不是安全层。
 */
export function needsApproval(o: {
  tool: string;
  args: unknown;
  /** 工作区外的目标 ⇒ 一律高风险（外部 API / 生产环境，§12.7 第三层点名的升级条件）。 */
  external?: boolean;
}): boolean {
  return toolRiskTier(o) === "irreversible";
}

/**
 * 一次工具调用的**风险档**（§9.1 三级）。`needsApproval` 就是它等于 irreversible 那一档，
 * 而这个函数另外有一个消费者：路由（routing.ts）的**只读段闸门** ——
 * 【规格】§12.5 第 2 段要求「分析段不修改文件」，判据是
 * 「这一段里出现任何非只读动作即失败」，而那个「非只读」必须与审批用的是**同一个**判据。
 *
 * 为什么要有这一层而不是让路由自己调 classifyAction：那会得到**两条通向同一张表的路**，
 * 于是将来任何一方想加一层预处理（比如把 harness 工具名做别名归一）就会只加在一边，
 * 得到「同一次调用，审批说可逆、闸门说只读」。这一层是那个漂移的收口点。
 *
 * 方向仍然是【宁可报高不报低】：认不出的工具名落 irreversible ⇒ 在只读段里就是违规。
 * 一个 read-only 段被一次认不出的调用打断，看到的是「这一段被中止」，
 * 而反过来（报低了）是「分析段偷偷改了文件而没人知道」—— 后者正是【规格】§12.5
 * 那段流程第 2 步「不修改文件」这句话存在的全部理由。
 */
export function toolRiskTier(o: {
  tool: string;
  args: unknown;
  external?: boolean;
}): RiskTier {
  // `external` 只在**给了的时候**才进 draft：ActionDraft 那一侧是
  // `external?: boolean`（不是 `boolean | undefined`，本仓开了
  // exactOptionalPropertyTypes），直接 `external: o.external` 会把 undefined
  // 显式写进去而被拒 —— 这类错只有 tsc 报得出来，跑起来一切正常。
  const draft: ActionDraft =
    o.external === undefined
      ? { kind: o.tool, detail: argText(o.args) }
      : { kind: o.tool, detail: argText(o.args), external: o.external };
  return classifyAction(draft);
}

/**
 * 审批这一层特有的返回：在 SafetyVerdict 之外多带一格 `decidedBy`。
 *
 * 为什么要把「谁批的」提进返回值而不是只塞进 detail：§12.7 第四层要的
 * 「谁批准了什么」是审计里**要被读出来的一格**，不是一句人话。而我第一版只在
 * **拒绝**时把 decidedBy 放进 detail，放行那一次什么都不留 —— 于是审计里
 * 【只有被拒的审批】，而那恰好是这个问题唯一不需要回答的情形
 * （被拒的动作本来就没发生）。所以 ok 这一支也必须带得上。
 *
 * `decidedBy: null` 有两种来路，在审计里同值而含义不同，这点写清楚：
 * ① 没人可问（handler 缺失，那一支必然同时是 ok:false）；
 * ② 批了但审批者自报没署名。①不会与 ok:true 同时出现，所以读到
 * 「ok:true + decidedBy:null」的口径是【有个人批了但他没留名】，不是【没人批】。
 */
export type ApprovalVerdict =
  | { ok: true; decidedBy: string | null }
  | {
      ok: false;
      code: SafetyBlockCode;
      reason: string;
      detail?: Record<string, unknown>;
      decidedBy: string | null;
    };

/**
 * 第三层的执行：需要审批时**必须**有人可问。
 *
 * 这个函数存在的理由是那个最危险的失效方向：`approval_policy: never` 的适配器
 * 或者一个忘了传回调的调用方，会让「暂停」变成「继续」。所以缺回调 ⇒ **拒**，
 * 而不是「那就自动批」。理由与 evaluateGate 里「判不了 ⇒ escalate 而不是 pass」同一条：
 * 默认放行是最危险的静默失效，而这里默认放行连一条 unresolved 都不留。
 */
export async function approvalBlock(
  req: ToolApprovalRequest,
  handler: ApprovalHandler | undefined,
): Promise<ApprovalVerdict> {
  if (handler === undefined) {
    return {
      ...block(
        "approval_handler_missing",
        "这次调用被判定为不可逆（" +
          req.reason +
          "），但调用方【没给】审批回调，被拒。刻意不自动放行：那等于" +
          "「装配时漏传一个参数」换来一次不可逆操作被执行。",
        { tool: req.tool },
      ),
      decidedBy: null,
    };
  }
  const d = await handler(req);
  if (d.approved) return { ok: true, decidedBy: d.decidedBy ?? null };
  return {
    ...block(
      "approval_denied",
      "审批被拒：" +
        req.reason +
        (d.note === undefined || d.note === "" ? "" : "（备注：" + d.note + "）"),
      { tool: req.tool, decided_by: d.decidedBy ?? null },
    ),
    decidedBy: d.decidedBy ?? null,
  };
}

/* ═════════════════ 否决权到底有没有（enforced / observed_only） ═════════════════ */

/**
 * 这一次调用我们**有没有否决权**。
 *
 * 口径与 gateway 记审计时那一格**必须是同一份实现**，所以它在这里只有一份：
 *  - `enforced` —— 这台适配器具备审批回调，且策略要求它问（`approval_policy=on-request`）；
 *  - `observed_only` —— 其余全部。这不是「一定没拦住」，而是
 *    【我们无从知道自己有没有拦住】，而审计里「不知道」必须有它自己的值。
 *
 * 它有两个消费者，而这正是它必须同源的理由：
 *  1. **gateway 写审计**（那一行 harness_call 的 prevention 格）；
 *  2. **路由判该不该把任务派给它**（routing.ts；【规格】§12.7 会碰不可逆工具的岗位书
 *     不该被派给 observed_only 那一家）。
 * 两处各写一份 ternary 的话，加一项条件（比如以后按 harness 版本区分）就会只加在一边，
 * 得到「审计里写着 enforced 而路由当初是按 observed_only 判的」——
 * 那比两边都写错更难查，因为审计看起来是自证干净的。
 */
export function preventionFor(
  caps: { readonly toolApproval: boolean },
  policy: ApprovalPolicy,
): "enforced" | "observed_only" {
  return caps.toolApproval && policy === "on-request" ? "enforced" : "observed_only";
}

/* ═════════════════ 脱敏（§12.7 第四层「脱敏参数」） ═════════════════ */

/**
 * 看起来像密钥的键名。命中即整值替换，**不做长度/熵判断** ——
 * 熵判断会把「hunter2」这种弱密钥放过，而审计库里那条记录是给回放页看的，
 * 漏一个的代价是永久的（events 是 append-only，删不掉）。
 */
const SECRET_KEY =
  /(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential|access[_-]?key|private[_-]?key)/iu;

export const REDACTED = "[redacted]";

/**
 * 深拷贝 + 按键名脱敏。返回新对象，**不改入参**（入参可能来自 harness 的事件流，
 * 改了会污染适配器自己后续要用的那份数据）。
 *
 * 循环引用 ⇒ 该子树整体替换成 "[redacted]"（而不是抛错）：
 * 审计落不下去的代价是「这次调用没有留痕」，比留一条被打码的占位更糟。
 */
export function redact(v: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (v === null || typeof v !== "object") return v;
  if (seen.has(v as object)) return REDACTED;
  seen.add(v as object);
  if (Array.isArray(v)) return v.map((x) => redact(x, seen));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redact(val, seen);
  }
  return out;
}

/**
 * 脱敏一段命令行参数（数组形态：`["--token", "sk-xxx", "--sandbox", "read-only"]`）。
 * 键名脱敏对这种形状无效（没有键），所以按**位置**判：
 * `--token sk-xxx` 里第 2 项紧跟一个像密钥开关的项 ⇒ 替换。
 * `--token=sk-xxx` 那种由 redact/normalizeFlag 之外的路径处理：这里也一起处理，
 * 因为命令行是 harness 最常见的入口，漏它等于白做。
 */
const SECRET_FLAG = /^(--?)(api[-_]?key|token|secret|password|passwd|auth|authorization|credential)$/iu;

export function redactArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let eat = false;
  for (const a of args) {
    if (eat) {
      out.push(REDACTED);
      eat = false;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0 && SECRET_FLAG.test(a.slice(0, eq))) {
      out.push(a.slice(0, eq) + "=" + REDACTED);
      continue;
    }
    if (SECRET_FLAG.test(a)) {
      out.push(a);
      eat = true;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * 本模块【挡不住】什么（写在这里而不是等人踩）：
 *
 * 1. **符号链接 / 硬链接**：isInsideWorkspace 只做词法归一，不 realpath。
 *    一个指向 / 的软链接在工作区里，判据会放行。修法需要 fs，而本模块是纯判定。
 * 2. **参数里的路径**：workspaceContainmentBlock 要的是「调用方把目标路径交出来」。
 *    如果 harness 的参数是一段 shell 脚本（`Bash("cd .. && rm -rf x")`），
 *    这里看不到路径 —— 兜住它的是第 1 层（Bash 在不在白名单）与
 *    classifyAction 的不可逆子串表，不是这一条。
 * 3. **harness 侧的自主行为**：§12.7 表头写了「叠加」，不是「替代」。
 *    沙箱档位本身由 harness 执行；如果 harness 的档位实现有 bug，本层看不见。
 * 4. **绕过 Gateway 的调用**：本层只在 Gateway 上生效。今天 `harness_call` 审计
 *    在生产里零写入方（因为没有任何生产代码调用 Gateway，见 0020 §2 甲档），
 *    所以「所有 harness 调用都过了这四层」这句话当前的强度是
 *    **「凡是走 Gateway 的都过了」+「今天没人走 Gateway，因为还没有 harness 调用」**。
 *    接线那天，第 4 条必须靠「不写审计就调不动」来保证，而不是靠约定。
 */
