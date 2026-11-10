/**
 * 策略引擎规则骨架（计划 Task 1.5，规格 §9.1）。
 *
 * 本期只做【分类 + 决策记录】，自动审批留到 Task 3.5 —— 这不是拖延：§9 的北极星指标
 * （八成审批由规则自动决定）要靠【历史决策模式】（§9.1 第二行「过去 10 次类似决策均
 * 批准且该决策可逆」），而历史得先攒出来。Phase 1 先把分类与 reason 落成可统计的审计，
 * Phase 3 才有模式可学。跳过这一步直接做自动审批，等于在没有数据时猜规则。
 *
 * 一条贯穿全文件的立场：【未知即不可逆】（fail-closed，计划 Test 项最后一条）。
 * 写这条的理由要具体：分类错了的两种后果不对称 ——
 *   把不可逆判成可逆 ⇒ 对外发布了、付了款、删了数据，无法回滚，且没有第二次机会；
 *   把可逆判成不可逆 ⇒ 多一次人工审批，CEO 多点一次按钮。
 * 两种错误的代价差几个数量级，所以模糊时【必须】往贵的那一侧偏。任何「看起来更聪明」
 * 的默认放行写法都要被拒（见 classifyAction 的 default 分支）。
 */

import type { RiskTier } from "@opc/contracts";
import { RISK_TIERS } from "@opc/contracts";

/** 一次待判定的动作。kind 是动作类别，detail 是给规则看的原文（命令、路径、URL…）。 */
export interface ActionDraft {
  readonly kind: string;
  readonly detail: string;
  readonly role_id?: string;
  /** 目标是否在本机仓库之外（外部 API、生产环境、公网）。 */
  readonly external?: boolean;
}

export interface PolicyContext {
  /** 角色岗位书里的 forbidden 条目（小写归一后比对）。 */
  readonly forbidden?: readonly string[];
  /** 该角色近期同类决策的历史（Task 3.5 的模式自动批准用；本期只记录不据此放行）。 */
  readonly recentSimilarApprovals?: number;
}

export type PolicyDecision =
  | { action: "auto_allow"; tier: RiskTier }
  | { action: "require_approval"; tier: RiskTier; reason: string }
  | { action: "forbidden"; tier: RiskTier; reason: string };

/**
 * 不可逆动作的识别串。
 *
 * 为什么用【子串表】而不是结构化枚举（比如让调用方传一个 flags 对象）：
 * 调用方是 agent，它交上来的就是自然语言/命令行形状的动作描述。要求它先自己分类
 * 就等于让被约束者自证清白 —— §8.2 的立场是门控不依赖 agent 的自觉。子串表 imperfect
 * 但方向正确：漏判时落到 default 的 irreversible，不误放行。
 *
 * 表的维护规则：只加不减。删一条就等于放开一类不可逆动作，而删除的动机往往来自
 * 「这个老被拦，烦」—— 那正是该由 CEO 而不是实现层决定的事（§4.4.3 收紧/放宽的归属）。
 */
export const IRREVERSIBLE_PATTERNS: readonly string[] = [
  "rm -rf",
  "rm -r",
  "drop table",
  "delete from",
  "truncate",
  "git push",
  "push to main",
  "merge to main",
  "force push",
  "发布",
  "上线",
  "部署",
  "deploy",
  "付款",
  "支付",
  "转账",
  "payment",
  "pay ",
  "charge",
  "对外发送",
  "发送邮件",
  "发推",
  "publish",
  "send email",
  "webhook",
  "uninstall",
  "格式化",
  "format disk",
];

/** 可逆动作：改工作区文件、建分支、本地实验。 */
export const REVERSIBLE_PATTERNS: readonly string[] = [
  "创建分支",
  "create branch",
  "git checkout",
  "git switch",
  "git commit",
  "编辑",
  "edit",
  "write file",
  "修改工作区",
  "refactor",
  "重命名",
  "rename",
  "add file",
  "create file",
];

/** 只读动作：读文件、跑测试、查资料。 */
export const READ_ONLY_PATTERNS: readonly string[] = [
  "读取",
  "read",
  "cat ",
  "grep",
  "搜索",
  "search",
  "跑测试",
  "运行测试",
  "run tests",
  "npm test",
  "pnpm test",
  "pnpm verify",
  "lint",
  "typecheck",
  "ls",
  "status",
  "diff",
  "log",
];

/** kind 的直接映射：调用方有时能给出确切类别（来自 harness 的结构化输出）。
 *
 * ⚠ 下面那 9 个 harness 工具名（read / edit / write / multiedit / notebookedit /
 * grep / glob / websearch / webfetch）**与上面那些语义 kind 不是同一类东西**，
 * 它们的来路是「白名单里会出现的字符串」，而把它们放进来是一个**有意的降噪**：
 *
 * 0021 §10 第 2 条记着一条已知的坏味道 —— harness 传进来的参数是机器形状
 * （`{"path":"/repo/x.ts"}`），而三张模式表全是人类语言子串，于是**每一次** harness
 * 工具调用都落到「默认不可逆」，接上线那天审批队列会变成**一条工具调用一张卡片**。
 * 当时我没有在 safety.ts 里另写一张表（那会得到「同一次调用两处判成不同档」），
 * 而是把它留给这一张表 —— 现在就是那一次。
 *
 * 加一条名字的**风险是有界的**，这点值得写清：命中 kind 之后，不可逆文本表
 * **仍然先判**（见 classifyAction 里那段「自报盖不住危险描述」），所以
 * `Write` 的 new_string 里写着「顺便发布一下」照样是 irreversible。也就是说
 * 这张表能改变的只有「**光看名字**时该按哪一档」，改不了「这次参数里写着什么」。
 * 于是每个取值断言的是一件与「这个名字到底存在于哪家 harness」无关的事：
 * **若**有这么个工具，它光看名字的效果是只读/可改工作区。
 * 名字写错（那家其实没有 Grep）没有代价；档位写错（把写工具写成 read_only）才有，
 * 而那正是下面每条都带一句效果依据的原因。
 *
 * 反过来，**没被列进来的名字仍然默认不可逆** —— 那是这张表的兜底，
 * 也是为什么 `Bash` 故意**不在**这里：它的光看名字什么都判不出来
 * （`git status` 与 `git push --force` 是同一个工具名），
 * 只能由参数文本决定，而参数文本走的就是那三张模式表。
 */
export const KIND_TIERS: Readonly<Record<string, RiskTier>> = {
  read_repo: "read_only",
  read_file: "read_only",
  run_tests: "read_only",
  search_web: "read_only",
  write_repo: "reversible",
  create_branch: "reversible",
  create_code_diff: "reversible",
  edit_file: "reversible",
  delete_data: "irreversible",
  payment: "irreversible",
  external_send: "irreversible",
  production_deploy: "irreversible",
  merge_to_main: "irreversible",
  // ↓ harness 工具名（classifyAction 会把 kind 转小写，所以这里必须小写）。
  // 白名单里出现过的形状见【规格】§4.1.3 的 ["Read","Edit","Bash(git:*)"] 与
  // 【规格】§12.5 / §12.6 的 --allowedTools "Read,Edit,Bash"。
  read: "read_only", // 读文件内容，无副作用
  grep: "read_only", // 检索，无副作用
  glob: "read_only", // 列文件，无副作用
  websearch: "read_only", // 与既有 search_web 同档；【规格】§13.3 的搜索策略是另一层，不在这里判
  webfetch: "read_only", // 取回一个页面；发出去的是请求，收回来的才是效果，两者都不改状态
  edit: "reversible", // 改工作区文件；越界由 safety 的 workspaceContainmentBlock 判，不是这里
  write: "reversible", // 同上（整文件覆盖，仍在工作区内 ⇒ 可回滚）
  multiedit: "reversible",
  notebookedit: "reversible",
};

function hit(haystack: string, needles: readonly string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * 三级分类。纯函数、不查网络、不读时钟。
 *
 * 判定顺序是【不可逆 → 只读 → 可逆 → 默认不可逆】：不可逆必须最先判，
 * 否则 "读取后要删除这个目录" 这种句子会先命中只读表而被放行 —— 一句话里有
 * 多个动词时，最危险的那个决定风险等级。
 */
export function classifyAction(a: ActionDraft): RiskTier {
  const kindKey = a.kind.trim().toLowerCase();
  const detail = (a.detail ?? "").trim().toLowerCase();

  // 显式 kind 命中映射表时【仍要】过一遍不可逆文本表：
  // kind 是调用方自报的，而自报不可信（上面的立场）。两边取更危险的那个。
  const kindTier = Object.hasOwn(KIND_TIERS, kindKey)
    ? (KIND_TIERS[kindKey] as RiskTier)
    : undefined;

  if (hit(detail, IRREVERSIBLE_PATTERNS) || a.external === true) {
    return "irreversible";
  }
  if (kindTier === "irreversible") return "irreversible";

  const readOnly = hit(detail, READ_ONLY_PATTERNS);
  const reversible = hit(detail, REVERSIBLE_PATTERNS);
  if (readOnly && !reversible) return tierAtLeast(kindTier, "read_only");
  if (reversible) return tierAtLeast(kindTier, "reversible");
  if (readOnly) return tierAtLeast(kindTier, "read_only");
  if (kindTier !== undefined) return kindTier;

  // 走到这里 = 既不认得 kind，也不认得 detail。计划 Test 项：未知动作默认 irreversible。
  return "irreversible";
}

/**
 * 取「显式 kind 声明的档位」与「文本判出的档位」中【更危险】的那个。
 *
 * 不这么做的后果很具体：kind 写 write_repo（可逆）而 detail 写「改完直接发布」，
 * 后判的 kind 会盖掉文本里的不可逆信号。取 max 让自报的温和分类盖不住危险描述。
 */
function tierAtLeast(declared: RiskTier | undefined, floor: RiskTier): RiskTier {
  if (declared === undefined) return floor;
  return RISK_TIERS.indexOf(declared) > RISK_TIERS.indexOf(floor)
    ? declared
    : floor;
}

/**
 * 分类 + 是否要人批。
 *
 * §9.1 的三级里，只读 = 自动放行；可逆与不可逆本期一律 require_approval
 * （「模式自动通过」那一档要等 Task 3.5 的历史模式，见文件头）。
 * 岗位书 forbidden 命中则直接 forbidden —— 黑名单优先于一切分级：
 * 一个在 forbidden 里的只读动作照样不能被放行，否则 §4 的黑名单退化成建议。
 */
export function policyDecide(
  a: ActionDraft,
  ctx: PolicyContext,
): PolicyDecision {
  const tier = classifyAction(a);

  const forbiddenHit = matchForbidden(a, ctx.forbidden ?? []);
  if (forbiddenHit !== undefined) {
    return {
      action: "forbidden",
      tier,
      reason:
        "命中岗位书黑名单条目 [" +
        forbiddenHit +
        "]（§4 黑名单 / §20.2 权限单调性）。黑名单优先于风险分级：即使这一动作" +
        "按分级属于只读或可逆，角色也不得执行。",
    };
  }

  if (tier === "read_only") {
    return { action: "auto_allow", tier };
  }
  return {
    action: "require_approval",
    tier,
    reason:
      tier === "irreversible"
        ? "不可逆动作（§9.1 必须人工）。分类依据：动作描述命中不可逆模式表，" +
          "或调用方未能说明它属于只读/可逆 —— 未知一律按不可逆处理。"
        : "可逆动作但本期不自动放行：§9.1 的「模式自动通过」依赖历史决策模式，" +
          "该能力在 Task 3.5 落地。",
  };
}

/**
 * 黑名单匹配。大小写不敏感 + 双向包含，而不是全等。
 *
 * 为什么不能全等：黑名单条目是中文短语（「自行合并到主干」），动作描述是
 * 「git push origin main」。全等永远匹配不上 ⇒ 黑名单形同虚设。
 * 双向包含（条目含于描述，或描述含于条目）是有意的宽松：这里的错判代价不对称 ——
 * 多拦一次人工可解，漏拦一次是越权（与 classifyAction 同一立场）。
 *
 * 【逐分量比对，不拼成一个长串】。第一版把 role_id + kind + detail 拼成一句再比，
 * 那会让【反方向】（描述含于条目）失效：岗位书条目「对外发布需 CEO 批准」含不住
 * "write_repo 发布" 这个拼接串，于是简短却明确踩线的动作（detail 就是「发布」）
 * 反而漏过 —— 而反方向恰恰是防「条目写得比动作长」那一类的唯一手段。
 * 拆成 kind / detail / role_id 三个候选各自双向比，两个方向才都真的在用。
 */
export function matchForbidden(
  a: ActionDraft,
  forbidden: readonly string[],
): string | undefined {
  const candidates = [a.role_id, a.kind, a.detail]
    .map((v) => (v ?? "").trim().toLowerCase())
    .filter((v) => v !== "");
  if (candidates.length === 0) return undefined;
  for (const f of forbidden) {
    const needle = f.trim().toLowerCase();
    if (needle === "") continue;
    const hit = candidates.some((c) => c.includes(needle) || needle.includes(c));
    if (hit) return f;
  }
  return undefined;
}
