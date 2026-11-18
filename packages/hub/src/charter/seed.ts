/**
 * `hub charter seed` —— 把 `resources/charter-templates/*.yaml` 装进 `role_charters`。
 *
 * ── 为什么要有这一条命令（O2 动作 2）─────────────────────────────────
 * 动手前量的事实（0015 §1 / store.ts 文件头 ①）：`role_charters` 唯一的生产 INSERT 是
 * `org/commit.ts` 的 `bumpCharter`，而它开头就是 `if (prev === undefined) continue;`
 * （没有上一版就跳过）⇒ 新角色直接跳过；真正的写入方 `charter/store.ts` 的
 * `saveCharterVersion` 在 `src` 里**零调用方**，跑完迁移那张表 0 行。于是「这个角色有
 * 岗位书」这句话落到库上**无处可存**，而 `engine/runtime.ts` 的 `rolePrompt` 每一轮只能
 * 走 `NO_CHARTER_LINE` 那一支（0058 §8 登记的「接好了但没通电」）。
 *
 * ⚠ **本文件让那一条「零调用方」过期了 —— 它是 `saveCharterVersion` 的第一个生产调用方。
 * 而缺口只是【上移了一环】，不是填上了**（同 phase3.test.ts 的 verifyFix 那发的形状）：
 *   以前缺的是「一条写岗位书的路」；现在有了，而它对 shipped 模板**恒拒** ——
 *   七份模板 0 份签过字（Task 0.9 要 CEO 本人替换占位串，开发者不得代笔）。
 *   实测：`pnpm hub:charter seed` 跑那七份 ⇒ 退出 1、七份全报、零写入。
 *   ⇒ **`role_charters` 今天仍然是 0 行**，`rolePrompt` 每一轮仍然走 `NO_CHARTER_LINE`。
 *   钉这一格的断言是 `store.test.ts` ④（期望值已从 `[]` 改成 `["charter/seed.ts"]`，
 *   改的理由与「先问缺口是否真消了」那一段写在那一发里）。
 *   剩下那一环的执行方是**人**：签七个文件。再写一条断言清不掉它。
 *
 * 设计文档给的两条路是「给那个 `continue` 补一条真路径」或「加一条**显式的**迁移命令」，
 * 并推荐后者，理由我认：播种是**运营动作**，不该藏在组织提交里悄悄发生 ——
 * 组织提交的语义是「人改了一张组织图，顺带把岗位书往前推一版」，而「第一次把这家公司
 * 配起来」是另一件事，混在一起的后果是「没人按下过播种这个动作，而库里凭空有七份岗位书」。
 *
 * ── 为什么入口是独立文件，不给 cli.ts 加一个 `charter` verb ────────────
 * 同一个理由**第五次**出现（thread.ts / real-deps.ts / assemble.ts / hub-serve.ts /
 * hub-work.ts）：`cli.ts` 顶层 import `@langchain/langgraph` 与整张图，而这里的新代码
 * 不需要那张图 —— **一个不需要图的操作，不该因为入口文件需要图而起不来**。
 * ⚠ 这一格靠的理由与 0041 那一批**已经不同**：`@langchain/*` 今天装得上也装好了
 * （实测见设计文档 §1.3），所以依据不是「离线装不上」，是「不需要它」。
 *
 * 还有一条更硬的理由：`cli.ts` 那三个 verb（run/status/resume）全是**桩路线**的，
 * 都过 `refuseStubOnForeignDb` 那套归属判据，而那条守卫的整个前提是
 * 「桩只许写桩自己的库」。播种**就是要往真库里写**。两边语义相反，硬挂会逼那条守卫
 * 开一个「这次不是桩」的口子，而那正是它最不该有的形状。
 *
 * ⚠ 因此命令名与设计文档写的 `hub charter seed` **差一层**：今天是 `pnpm hub:charter seed`。
 * 这一处偏离写在这里而不是悄悄做掉。
 *
 * ── 三条判据（都在 planSeed 里，纯函数）───────────────────────────────
 * A. **占位串不许进库**（O2 动作 3，验收 (b) 的本体）。七份模板的 `acceptance_criteria`
 *    现在全带着 `CEO-PLACEHOLDER-ACCEPTANCE`（`roles/charter.test.ts` 还专门断言它在）。
 *    带着它跑起来的后果不是崩，是「这一轮看起来有标准」：`charter/prompt.ts` 那一格
 *    挡的是它**进提示词**，而门控读的是**库** —— 提示词侧挡得住不等于库里那条是干净的。
 *    播种是唯一一条能把模板写进库的路，所以它就是该拦的地方。这是
 *    `guides/how-to-write-a-charter.md` §3 反例 ④ 的机械化。**开发者不得代笔**
 *    （计划 Task 0.9）：这条命令今天红着，正是它该有的读数。
 * B. **不覆盖已经不一样的那一版**。库里最新一版与模板**逐字不同** ⇒ 拒绝整次运行，
 *    而不是顺手升一版。理由是 `changeSummary`：它是要被人在回放里读的那句「为什么改」，
 *    而播种只能给出一句模板话。真要改岗位书走编辑器，那里那句 why 是人写的。
 *    同一条立场见 `budget-sync.ts` 的「刻意拒绝：为一次没发生的变更留一条删不掉的记录」。
 * C. **先全量判定，再动手写**。任一角色不合格 ⇒ 一条都不写、一条审计都不落，
 *    并把**所有**问题一次报完（不是撞到第一个就退）。半套岗位书比没有岗位书难查：
 *    七份里进了四份，另外三个角色下一轮走 `NO_CHARTER_LINE`，而屏幕上那四个看起来
 *    「配好了」—— 这正是 O2 整篇要治的「两份来源」的又一个形状。
 *
 * ── 幂等不是口头保证 ─────────────────────────────────────────────────
 * 库里最新一版的 config 原文与模板归一化后的 JSON **逐字相同** ⇒ 跳过并明说跳过，
 * 于是第二次 seed 是零写入 + 零审计 + 退出 0。这一条同时是判据 B 的**反面**：
 * 相同 ⇒ 什么都不做（不制造一次没发生的变更）；不同 ⇒ 什么都不做（不覆盖人的编辑）。
 * 两种"什么都不做"必须**分开报**，否则读输出的人分不清「已经播过了」与「被挡住了」。
 *
 * ── 一个不显眼的副作用，写在脸上而不是只写进审计 ─────────────────────
 * 走 `saveCharterVersion` 的默认 `applyBudgets: true` ⇒ 模板里的 budget 两格会**同时**
 * 落进 `budgets` 表并开始限流。这是刻意的：另开一条「只存岗位书不动预算」的开关，
 * 造出来的正是 store.ts 文件头 D 段治的那个形状（屏幕显示新数字、执行侧按老数字放行）。
 * 但它必须**看得见**，所以下面在第一次写入前打一行声明，指向审计里的
 * `limits_applied` 与 `alarm_silenced`（调低上限会让那一格的突破警报永久哑）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHARTER_PLACEHOLDER_ACCEPTANCE,
  type CharterInput,
} from "@opc/contracts";
import { parse as parseYaml } from "yaml";
import { migrate } from "../db/migrate.js";
import {
  assertParamCount,
  assertSingleStatement,
  WriteQueue,
} from "../db/write-queue.js";
import { EXIT_OK, EXIT_PROBLEM, EXIT_USAGE } from "../heartbeat/maintenance.js";
import { isDirectRun } from "../internal/direct-run.js";
import { readLatestGraph } from "../org/commit.js";
import { loadCharterText } from "../roles/loader.js";
import { LATEST_CHARTER_ROW_SQL, saveCharterVersion } from "./store.js";

/**
 * 默认模板目录：锚在**本模块的 URL** 上，不锚 `process.cwd()`。
 *
 * 与 `roles/preset.ts` 同一个写法、同一条理由（那个文件头记的坑是「两种 runner 的
 * 工作目录不保证相同」），但本命令多一重：它**收 `--from`**，而 `--from` 相对 cwd。
 * 一个相对路径 + 一个隐式默认 = 人可以在错误的目录里跑出「成功」。所以
 * 默认值锚模块（永远对），显式 `--from` 按 cwd 解析**并把解析后的绝对路径打出来**
 * （让人看得见自己实际读了哪里 —— 与 0051 那次「假读数」同一族防线：先让坐标可见）。
 */
const DEFAULT_TEMPLATES_DIR = resolve(
  fileURLToPath(new URL("../../resources/charter-templates/", import.meta.url)),
);

export const SEED_USAGE = [
  "用法：pnpm hub:charter seed --db <path> [--from <templates-dir>]",
  "      设置环境变量 OPC_DB 后可省略 --db",
  "",
  "说明：",
  "  · 把 <templates-dir>/*.yaml 逐份装进 role_charters（走 saveCharterVersion，",
  "    所以带审计、带 budget 同步，与编辑器保存同一条路径）。",
  "  · --from 默认 packages/hub/resources/charter-templates（解析后的绝对路径会打印出来）。",
  "  · 验收标准里还带占位串 CEO-PLACEHOLDER-ACCEPTANCE ⇒ 整次拒绝、退出 1（那一条要 CEO 签）。",
  "  · 库里最新一版与模板逐字不同 ⇒ 整次拒绝、退出 1（不覆盖人的编辑；改岗位书请走编辑器）。",
  "  · 已经逐字相同 ⇒ 跳过（幂等：第二次跑零写入、零审计、退出 0）。",
  "  · 任一角色不合格 ⇒ 一个角色都不写（半套岗位书比没有岗位书难查）。",
  "  · 刻意不创建库文件：空库里播出来的七份岗位书，与一次库丢失之后的空库，看不出来。",
].join("\n");

/* ──────────────────────────────────────────────────────────────────────
 * 判据本体（纯函数）。
 *
 * 抽出来的理由与 test/arch/dead-modules.ts、test/fixtures/fixture-dir.ts 同一族：
 * 这条判据要能被**变异**证明有判别力，而内联在 it 里的判据只能靠「我改对了」自证
 * （0057 §6 / 0058 §5 记的就是内联判据的下场）。
 * ────────────────────────────────────────────────────────────────────── */

/** 一份模板读完之后的样子。 */
export interface SeedTemplate {
  /** 相对模板目录的文件名，报错坐标用。 */
  readonly file: string;
  readonly roleId: string;
  /** `JSON.stringify(loadCharterFile 归一化之后的 Charter)` —— 与库里那一列同形状。 */
  readonly configJson: string;
  /**
   * `charterSchema` 的**输入**形状（snake_case 原文）。
   *
   * 为什么不从 configJson 倒推、也不手写 camel→snake 映射表：store.ts 文件头 ②
   * 记的是实测 —— 把 camelCase 的 `Charter` 递给 `saveCharterVersion` 会拿到
   * **14 条 invalid_type**，第一条是 `role_id`，而报错里没有「请用 snake_case」这句话。
   * 映射表是第二条 schema，会漂（0006 §7 那族「两份抄本」）。所以这里拿的是
   * **YAML 那份未经 transform 的原文**：归一化仍然只发生在 charterSchema 一处，
   * 而它在写入侧是唯一入口。
   */
  readonly input: CharterInput;
  /** 验收标准里还带着占位串的那些条（给人看的序号）。 */
  readonly placeholders: readonly string[];
}

/** 库里某个角色的最新一版。 */
export interface SeedExisting {
  readonly version: number;
  /** 那一列的**原文**（不解、不重校验 —— store.ts 读侧的立场）。 */
  readonly config: string;
}

/**
 * 「播进去的角色，运行时叫不叫得到」。
 *
 * 为什么这不是多余的一格：`role_charters` 的主键侧是 **role_id**，而运行时
 * 唯一那个读者 `engine/runtime.ts` 的 `rolePrompt(roleId)` 拿到的 roleId 是
 * **任务上的 `assigned_role`**，而任务能不能带着这个角色跑，先要过
 * `engine/dispatch.ts` 门 0 那句 `graph.nodes[task.role] === undefined ⇒ stop`。
 * ⇒ 一个角色**在岗位书表里存在**与**在组织图上存在**是两件事，而这两套 id
 * 今天并不自动相等：仓里的组织图节点叫 `intake` / `charter` / `report`，
 * 而它们挂的模板叫 `assistant` / `assistant` / `ceo`（`roles/preset.ts`）。
 * 所以「播种成功、写入 N 份」这句绿话可以在**一份都用不上**的库里打出来。
 *
 * 为什么是**警告而不是第四条拒**：判据 A/B/C 拒的是「这次写本身不该写」
 * （内容没签 / 会盖掉人的编辑 / 身份不一致）。这里写进去的岗位书**内容是对的**，
 * 缺的是另一张表上的一个名字，而那张表**可以晚于播种存在** —— 空库里
 * `delegation_graphs` 一行都没有，若把"图还没建"判成拒，全新库就永远播不进岗位书，
 * 而那条路线正是 O8 要的（先播种、`POST /org` 后建图）。
 * 所以这一格只负责**说出来**：不说的时候症状是「播种成功而 agent 仍说没有岗位书」，
 * 那句话与「播种失败」在人眼里长得一样。
 */
export interface Reachability {
  /** 最新组织图的版本；`null` = 库里还没有任何一版（此时不判，也不假装判了）。 */
  readonly graphVersion: number | null;
  /** 那一版图上的节点 id。`graphVersion === null` 时为空数组。 */
  readonly nodeIds: readonly string[];
  /** 本次处置过的 role_id 里，图上**没有**的那些（已排序）。 */
  readonly missing: readonly string[];
}

/**
 * 判一次可达性。读的是**最新版**图，而任务跑的是**创建时那一版**（§18.4）——
 * 这是刻意的偏差，方向也写在输出里：最新图上没有的名字，新建的任务同样不会有；
 * 反过来（老图有、新图删了）不在本格的射程内，那种"历史任务的角色被删"该由
 * 组织提交那一侧拦，不该由播种命令猜。
 */
export function reachabilityOf(
  w: WriteQueue,
  roleIds: readonly string[],
): Reachability {
  const latest = readLatestGraph(w.readConnection());
  if (latest === null) return { graphVersion: null, nodeIds: [], missing: [] };
  const nodes = Object.keys(latest.graph.nodes);
  const on = new Set(nodes);
  return {
    graphVersion: latest.version,
    nodeIds: nodes,
    missing: [...new Set(roleIds)].filter((r) => !on.has(r)).sort(),
  };
}

/**
 * 可达性的那句话（纯函数，为了它能被直接断言而不是靠肉眼跑一遍）。
 * 返回 0..2 行：**判了才说话**，判不了也要说一句"判不了"。
 */
export function reachabilityLines(r: Reachability): string[] {
  if (r.graphVersion === null) {
    return [
      "  ⚠ 没有判可达性：库里还没有任何一版组织图（delegation_graphs 为空）。",
      "    岗位书按 role_id 存，运行时按【组织图上的角色名】找它 —— 图建好之前，",
      "    这些行谁都读不到。建图走 POST /org（它会顺带给汇报关系变了的角色涨一版）。",
    ];
  }
  if (r.missing.length === 0) {
    return [
      "  ✓ 可达性：本次涉及的角色都在组织图 v" + r.graphVersion + " 上。",
    ];
  }
  return [
    "  ⚠ 写进去了，但运行时【叫不到】这些角色：" + r.missing.join("、"),
    "    组织图 v" +
      r.graphVersion +
      " 上没有它们的名字，而门 0 会先把带这些角色的任务拦下",
    "    （engine/dispatch.ts：graph.nodes[task.role] 不存在 ⇒ 不跑）。",
    "    岗位书表按 role_id（= 模板文件名）存，运行时按【图上的节点名】查 —— 这两套 id",
    "    今天不自动相等（preset 把节点 intake/charter/report 挂在模板 assistant/assistant/ceo 上）。",
    "    要对上只有两条路：改组织图让它用这些名字，或让模板文件名等于节点名。",
  ];
}

export type SeedProblemKind =
  | "模板目录里没有任何 yaml"
  | "模板读不进来"
  | "文件名与 role_id 不一致"
  | "同一个 role_id 出现在两份模板里"
  | "占位串未签"
  | "与库里最新一版不同";

export interface SeedProblem {
  readonly kind: SeedProblemKind;
  readonly roleId: string;
  readonly why: string;
}

export type SeedAction =
  | { readonly kind: "写入"; readonly roleId: string }
  | {
      readonly kind: "跳过";
      readonly roleId: string;
      readonly version: number;
    };

/**
 * 一次播种的计划。**判别联合，不是 `{actions, problems}` 两个数组** ——
 * 后者允许调用方只读 `actions` 就开写，而判据 C 的全部内容正是「有问题时一条都不写」。
 * 让编译器拒掉那种读法，比在注释里写「先看 problems」可靠：本仓记过多次
 * 「立场写在注释里而没有任何断言执行它」（0058 §5 那张 `EXCLUDED` 表的下场）。
 */
export type SeedPlan =
  | { readonly ok: false; readonly problems: readonly SeedProblem[] }
  | { readonly ok: true; readonly actions: readonly SeedAction[] };

/**
 * 一次播种的计划。零 IO、零时间、零随机 —— 所有判断都在这里，`runSeedCli` 只负责执行。
 *
 * @param templates 读好的模板。**读失败不进这个数组**：调用方把它转成一条
 *   `模板读不进来` 的 problem 传进 `readFailures`，这样"半个目录读不动"这种 IO
 *   形状不会污染判据的可测性（判据因此可以在不建临时目录的情况下被完整测到）。
 * @param existing  库里每个角色的最新一版；没有该角色 ⇒ 不含这个键。
 */
export function planSeed(
  templates: readonly SeedTemplate[],
  existing: ReadonlyMap<string, SeedExisting>,
  readFailures: readonly SeedProblem[] = [],
): SeedPlan {
  const problems: SeedProblem[] = [...readFailures];

  if (templates.length === 0) {
    // 这一条在 readFailures 非空时**也**加：目录里全是坏文件时，"一个都没读进来"
    // 与"每个文件各自的错"是两句不同的话，缺前者会让人以为只是某个文件的问题。
    problems.push({
      kind: "模板目录里没有任何 yaml",
      roleId: "",
      why:
        "一个角色都没读到 ⇒ 什么都不写、退出非 0。这里绝不能给退出 0：「播种成功」" +
        "而实际零写入，是这条命令能编出来的最坏的一句谎。",
    });
    return { ok: false, problems };
  }

  const actions: SeedAction[] = [];
  const seen = new Map<string, string>();

  for (const t of templates) {
    // ── 身份：文件名必须等于 role_id ────────────────────────────────────
    // 不查的话，一份内容写着 role_id: ceo 的 dev.yaml 会把 ceo 播两遍、dev 永远没有，
    // 而 `validateCharterDraft` 那条「roleId 不一致就拒」在这里**恒真** ——
    // 因为播种传给它的 roleId 就是从同一份模板里读出来的那一个。那条判据防的是
    // 「一次编辑改到另一个角色」，在这里被播种的取数方式整个绕过，所以必须单独判。
    // 仓里那七份有 roles/charter.test.ts 断言文件名 === roleId，但那是关于**那七份文件**
    // 的测试，管不着 --from 指过来的任意目录。
    const stem = t.file.replace(/\.ya?ml$/iu, "");
    if (stem !== t.roleId) {
      problems.push({
        kind: "文件名与 role_id 不一致",
        roleId: t.roleId,
        why:
          t.file +
          " 的文件名是 [" +
          stem +
          "] 而内容里的 role_id 是 [" +
          t.roleId +
          "]。播种按 role_id 写库，于是这个文件会写到 [" +
          t.roleId +
          "] 名下，" +
          "而找 [" +
          stem +
          "] 的那个人下一轮拿到的是「没有你的岗位书」。",
      });
      continue;
    }

    const dup = seen.get(t.roleId);
    if (dup !== undefined) {
      problems.push({
        kind: "同一个 role_id 出现在两份模板里",
        roleId: t.roleId,
        why:
          t.file +
          " 与 " +
          dup +
          " 都声明 role_id = [" +
          t.roleId +
          "]。同一次运行里写两次会让后一份变成 v2，而那不是什么「第二版岗位书」，" +
          "那是两个同名文件被手工挑进同一个目录。",
      });
      continue;
    }
    seen.set(t.roleId, t.file);

    // ── 判据 A：占位串 ─────────────────────────────────────────────────
    if (t.placeholders.length > 0) {
      problems.push({
        kind: "占位串未签",
        roleId: t.roleId,
        why:
          t.file +
          " 的 acceptance_criteria 里还有 " +
          t.placeholders.length +
          " 条带着 [" +
          CHARTER_PLACEHOLDER_ACCEPTANCE +
          "]：" +
          t.placeholders.join(" / ") +
          "。那一条要 CEO 本人替换（计划 Task 0.9：开发者不得代笔 —— 代笔只是把红灯" +
          "变成假绿）。播种不替你签，也不许你带着它跑起来。",
      });
      continue;
    }

    // ── 判据 B：与库里最新一版比 ────────────────────────────────────────
    const ex = existing.get(t.roleId);
    if (ex === undefined) {
      actions.push({ kind: "写入", roleId: t.roleId });
      continue;
    }
    if (ex.config === t.configJson) {
      actions.push({ kind: "跳过", roleId: t.roleId, version: ex.version });
      continue;
    }
    problems.push({
      kind: "与库里最新一版不同",
      roleId: t.roleId,
      why:
        "库里 [" +
        t.roleId +
        "] 已经有 v" +
        ex.version +
        "，而它与 " +
        t.file +
        " 逐字不同。播种**不覆盖**：它能给出的那句变更说明是一句模板话，" +
        "而 changeSummary 是要被人在回放里读的「为什么改」。真要改这一版，走岗位书编辑器" +
        "（那条路上那句话是人写的）；要改模板，就先把库里那一版也改到一致。",
    });
  }

  // 判据 C 在这一行落到类型上：只要有任何一条问题，这次计划就是【不可执行】，
  // 调用方拿不到 actions —— 它无法"只写没出问题的那几个"。
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, actions };
}

/* ──────────────────────────────────────────────────────────────────────
 * IO 与 CLI。
 * ────────────────────────────────────────────────────────────────────── */

export interface SeedIo {
  write(text: string): void;
  error(text: string): void;
}

export interface SeedResult {
  readonly code: number;
}

export interface SeedArgs {
  readonly dbPath: string;
  readonly fromDir?: string;
}

/** 参数解析的结果。形状照 work.ts 的 parse*：`{ok}` 判别联合，不抛。 */
export type SeedArgsResult =
  | { readonly ok: true; readonly args: SeedArgs }
  | { readonly ok: false; readonly error: string };

/**
 * 参数解析。错误返回 `{ok:false}` 而不是抛，让入口那一格统一打用法。
 * 可选字段用判别联合而不是 `string | undefined` 塞进同一个对象，是为了
 * 让调用方**不可能**在没判 ok 的路径上拿到 dbPath（`{error?, dbPath?}` 那种形状
 * 要靠一句 `as string` 才能编译，而那句 cast 就是我自己在给自己开洞）。
 */
export function parseSeedArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SeedArgsResult {
  let dbPath: string | undefined;
  let fromDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--db" || a === "--from") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: a + " 后面缺值" };
      if (a === "--db") {
        if (dbPath !== undefined)
          return { ok: false, error: "给了两个 --db：" + dbPath + " 与 " + v };
        dbPath = v;
      } else {
        if (fromDir !== undefined)
          return {
            ok: false,
            error: "给了两个 --from：" + fromDir + " 与 " + v,
          };
        fromDir = v;
      }
      continue;
    }
    if (a.startsWith("--db=")) {
      dbPath = a.slice(5);
      continue;
    }
    if (a.startsWith("--from=")) {
      fromDir = a.slice(7);
      continue;
    }
    return { ok: false, error: "未知参数 " + a };
  }

  // env 只做缺省，不覆盖显式参数；空白不算设置了它（同 maintenance / cli.ts 的 OPC_DB 口径）。
  const envDb = env["OPC_DB"];
  if (dbPath === undefined && envDb !== undefined && envDb.trim() !== "")
    dbPath = envDb;

  if (dbPath === undefined || dbPath.trim() === "") {
    return {
      ok: false,
      error: "缺 --db（或环境变量 OPC_DB）：刻意不猜默认库路径",
    };
  }
  return {
    ok: true,
    args: fromDir === undefined ? { dbPath } : { dbPath, fromDir },
  };
}

/**
 * 一个目录里要看的模板文件（按名字排序 ⇒ 输出与报错顺序不随文件系统漂）。
 *
 * 排序不是美观问题：不排序的话，同一份目录在两台机器上会给出不同的**第一条**报错，
 * 而「第一条报错」正是人一定会读的那一行。
 */
export function templateFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/iu.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * 读一份模板。IO / YAML / schema 三类失败都是**抛**（沿用 loader 的
 * CharterSyntaxError / CharterValidationError），由调用方转成 problem。
 * 抛而不是返回 problem：这三类失败的**信息量在异常类型里**，压成字符串会丢掉字段路径。
 */
export function readTemplate(dir: string, file: string): SeedTemplate {
  const path = join(dir, file);
  // 一次读，两用了。分两次读（loadCharterFile 一次、占位串扫描一次）留着的是
  // TOCTOU：两次之间文件被改，则**校验的是新内容而写进去的是旧内容**。
  // 播种这种一次性动作撞上的概率极低，低到不值得为它设计什么 —— 但一次读
  // 与两次读的成本相同，所以没有理由选那一个会留口子的写法。
  const text = readFileSync(path, "utf8");
  const charter = loadCharterText(text, path);
  // 归一化之后序列化：库里存的就是这一串（saveCharterVersion 同一写法），
  // 于是判据 B 的「逐字相同」比的是**将要落盘的两串字节**，不是两种形状。
  const configJson = JSON.stringify(charter);
  // snake_case 原文，见 SeedTemplate.input 那段注释。loadCharterText 已经放行，
  // 所以这一行不会再抛（它跑的是同一个 YAML 解析器、同一串文本）。
  const input = parseYaml(text) as CharterInput;
  const placeholders = charter.acceptanceCriteria.flatMap((a, i) =>
    // condition 与 message **两侧都查**。只查 condition 会漏过「占位串挪进 message」
    // 这种半只手改 —— 那仍然是没签，而它比整条没改更难看出来。判据严一侧的代价是
    // 一条合法标准若把那个常量当普通词写在 message 里会被挡住：那种写法本身就该重写。
    a.condition.includes(CHARTER_PLACEHOLDER_ACCEPTANCE) ||
    a.message.includes(CHARTER_PLACEHOLDER_ACCEPTANCE)
      ? ["第 " + (i + 1) + " 条"]
      : [],
  );
  return { file, roleId: charter.roleId, configJson, input, placeholders };
}

/**
 * 库里每个角色的最新一版。表为空 ⇒ 空表（这是今天所有真库的读数）。
 *
 * 一条 SQL 同时取 version 与 config 原文（`LATEST_CHARTER_ROW_SQL` 本来就 select 了
 * 那一列），而不是先 `latestCharterVersion` 再按版号回读 —— 两次读之间若有并发写，
 * 拿到的 config 会属于**另一个**版本号，而判据 B 比的正是「哪一版」。
 * 读的是 readConnection：本函数不写，而 WriteQueue 的写连接是单线程串行的，
 * 读连接才是给这种"看一眼"用的那条（0010 §2）。
 */
export function latestCharters(
  w: WriteQueue,
  roleIds: readonly string[],
): Map<string, SeedExisting> {
  const out = new Map<string, SeedExisting>();
  const db = w.readConnection();
  for (const roleId of roleIds) {
    const sql = LATEST_CHARTER_ROW_SQL;
    const params: unknown[] = [roleId];
    assertSingleStatement(sql);
    assertParamCount(sql, params);
    const row = db.prepare(sql).get(...(params as never[])) as
      | { version: number | bigint; config: string }
      | undefined;
    if (row === undefined) continue;
    out.set(roleId, { version: Number(row.version), config: row.config });
  }
  return out;
}

export async function runSeedCli(
  argv: readonly string[],
  io: SeedIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const p = parseSeedArgs(argv, env);
  if (!p.ok) {
    io.error("错误：" + p.error + "\n\n" + SEED_USAGE + "\n");
    return { code: EXIT_USAGE };
  }
  const { dbPath } = p.args;
  const fromDir =
    p.args.fromDir === undefined
      ? DEFAULT_TEMPLATES_DIR
      : isAbsolute(p.args.fromDir)
        ? p.args.fromDir
        : resolve(process.cwd(), p.args.fromDir);

  // 不创建库。openDb / new WriteQueue 都会建文件，而**空库里播出来的七份岗位书，
  // 与一次库丢失之后的空库，看起来一模一样**（同 maintenance 那句「空库的完整性检查
  // 全绿，那是最坏的一种检查通过」）。与 work.ts 的 cmdWork 同一个 existsSync 前置。
  if (!existsSync(dbPath)) {
    io.error(
      "错误：库文件不存在 —— " +
        dbPath +
        "\n播种刻意不建库：请先 pnpm migrate 建库。\n",
    );
    return { code: EXIT_USAGE };
  }
  if (!existsSync(fromDir)) {
    io.error("错误：模板目录不存在 —— " + fromDir + "\n");
    return { code: EXIT_USAGE };
  }

  io.write("播种岗位书（O2 动作 2）\n");
  io.write("  库文件：" + dbPath + "\n");
  io.write("  模板目录：" + fromDir + "\n");

  const problems: SeedProblem[] = [];
  const templates: SeedTemplate[] = [];
  for (const name of templateFiles(fromDir)) {
    try {
      templates.push(readTemplate(fromDir, name));
    } catch (e) {
      // 读不进来**不能**当成"跳过"：那会让一份坏掉的 YAML 从这次播种里安静地消失，
      // 而安静消失的那个角色下一轮拿到的是「没有你的岗位书」，屏幕上看不出来。
      problems.push({
        kind: "模板读不进来",
        roleId: name,
        why: name + " 读失败：" + (e instanceof Error ? e.message : String(e)),
      });
    }
  }

  const q = new WriteQueue(dbPath);
  try {
    // 已存在的库补迁移（与 cmdWork / cmdDecide 同一条：只补迁移，不建文件）。
    migrate(q.writeConnection());
    const plan = planSeed(
      templates,
      latestCharters(
        q,
        templates.map((t) => t.roleId),
      ),
      problems,
    );

    if (!plan.ok) {
      for (const pr of plan.problems) io.error("  ✗ " + pr.why + "\n");
      // 判据 C：一条都不写。这里必须说清"零写入"，否则人会以为其余那几份进去了。
      io.error(
        "\n播种被拒：" +
          plan.problems.length +
          " 条问题 ⇒ 一个角色都没写、一条审计都没落。\n" +
          "（不是「写了能写的那些」—— 半套岗位书比没有岗位书难查。）\n",
      );
      return { code: EXIT_PROBLEM };
    }
    const actions = plan.actions;

    let wrote = 0;
    let budgetsAnnounced = false;
    for (const act of actions) {
      if (act.kind === "跳过") {
        io.write(
          "  · 跳过 " +
            act.roleId +
            "：库里 v" +
            act.version +
            " 与模板逐字相同\n",
        );
        continue;
      }
      if (!budgetsAnnounced) {
        budgetsAnnounced = true;
        io.write(
          "  ⚠ 写入会同时把岗位书的 budget 两格落进 budgets 表并开始限流；\n" +
            "    结果挂在审计的 limits_applied / alarm_silenced 上（调低上限会让那一格的突破警报哑掉）。\n",
        );
      }
      const t = templates.find((x) => x.roleId === act.roleId) as SeedTemplate;
      const r = await saveCharterVersion(q, {
        roleId: act.roleId,
        config: t.input,
        nowMs: Date.now(),
        changeSummary: summaryOf(fromDir, templates.length),
      });
      if (!r.ok) {
        io.error("  ✗ " + act.roleId + " 写入被拒：" + r.reason + "\n");
        return { code: EXIT_PROBLEM };
      }
      wrote++;
      io.write(
        "  · 写入 " +
          act.roleId +
          " v" +
          r.version +
          "（审计 seq " +
          r.auditSeq +
          "）\n",
      );
    }

    const skipped = plan.actions.filter((x) => x.kind === "跳过").length;
    io.write("\n播种完成：写入 " + wrote + " 份，跳过 " + skipped + " 份。\n");
    if (wrote === 0 && skipped === 0) {
      // 既没问题也没动作。今天不可达（planSeed 在 templates 为空时必给一条 problem），
      // 但这一格正是「播种成功而什么都没做」那句谎唯一还可能藏身的地方 ——
      // 判据一改（比如有人删掉空目录那条 problem），这里就变成实际输出而不是注释。
      io.error(
        "⚠ 没有任何角色被处置。这条命令不该走到这里，去看 planSeed 的判据。\n",
      );
      return { code: EXIT_PROBLEM };
    }
    // 「播种完成」那句只说明**表里有行了**，不说明**有人读得到那些行**。两者之间的
    // 那道缝（role_charters 按 role_id 存 / 运行时按组织图节点名查）见 reachabilityOf。
    // 判据只算不拦，理由写在 Reachability 那段：缺的是另一张表上的名字，而那张表
    // 按 O8 的路线**可以晚于播种存在** —— 拦下来会让全新库永远播不进去。
    // 打在 stdout 而不是 stderr：**今天这条一次都不会打**（七份模板全没签 ⇒ 判据 A
    // 先拒、退出 1，根本走不到这里）。它说的是"将来播种真成功的那天" —— 而那天
    // 节点名与模板名仍然不相等（那是 preset 与文件名两套命名的既有事实），
    // 所以这句是那次成功的**附带条件**，不是那次成功的失败。
    for (const line of reachabilityLines(
      reachabilityOf(
        q,
        templates.map((t) => t.roleId),
      ),
    )) {
      io.write(line + "\n");
    }
    return { code: EXIT_OK };
  } finally {
    await q.close();
  }
}

/**
 * 那条审计的变更说明。
 *
 * 三件事：① **每个角色同一句** —— 角色名与版号已经在审计的 `target`
 * （`roleId + "@v" + n`）里，在这里重复一遍是两个源；② **不依赖 cwd** ——
 * 我第一版写的是 `relative(process.cwd(), dir)`，那会让同一次播种在仓库根跑与在
 * `packages/hub` 跑写出**两句不同的话**，而审计是只写一次的（0006 §7 那族
 * 「同一个事实两种抄法」在审计上的形状：回放里看不出这两条是同一次动作）；
 * ③ 不许是空串 —— `saveCharterVersion` 会拒，而它拒的理由（那是回放里唯一
 * 人可读的一句「为什么改」）正是这句话存在的理由。
 */
export function summaryOf(dir: string, count: number): string {
  return (
    "播种岗位书：hub charter seed（模板目录 " + dir + "，共 " + count + " 份）"
  );
}

/**
 * stdio 版：进程入口与测试都走这一条，只是 io 不同（hub-work.ts 的
 * `runEngineCliOnStdio` 同一形状 —— 测试不必 spawn 子进程就能验退出码与输出，
 * 而 spawn 那一发仍然留着，因为 `isDirectRun` 与 argv 的对应关系不在这条路上）。
 */
export async function runCharterCliOnStdio(
  argv: readonly string[],
): Promise<SeedResult> {
  const io: SeedIo = {
    write: (t) => {
      process.stdout.write(t);
    },
    error: (t) => {
      process.stderr.write(t);
    },
  };
  const r = await runCharterCli(argv, io);
  // 只有【一处】写 process.exitCode（hub-serve.ts 文件头那条同源纪律）。
  process.exitCode = r.code;
  return r;
}

/**
 * `hub charter seed` 的分发：吃掉子命令名，其余交给 runSeedCli。
 *
 * 为什么要这一层而不是让 `--db` 直接跟在 argv[0]：命令名是文档里写的那个形状
 * （`hub charter seed`），而 `runSeedCli` 判的是**参数**。两层混在一起的话，
 * `seed` 会被当成一个"未知参数"，报出来的是「未知参数 seed」—— 那句话既不对，
 * 也把人指错方向。
 */
export async function runCharterCli(
  argv: readonly string[],
  io: SeedIo,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SeedResult> {
  const verb = argv[0];
  const wantsHelp = verb === "--help" || verb === "-h" || verb === "help";
  if (wantsHelp || verb === undefined || verb === "") {
    // 与 hub-work.ts 同一条分界：主动问 ⇒ stdout + 0；什么都没敲是打错了 ⇒ stderr + 2。
    // 两种都不让人对着一个 exit 0 去查「为什么什么都没干」。
    (wantsHelp ? io.write : io.error)(SEED_USAGE + "\n");
    return { code: wantsHelp ? EXIT_OK : EXIT_USAGE };
  }
  if (verb !== "seed") {
    io.error(
      "错误：岗位书路线没有 [" +
        verb +
        "] 这个子命令。\n\n" +
        SEED_USAGE +
        "\n",
    );
    // 未知子命令给 2 而不是 1：改命令就行，不该被当成一次执行失败。
    // 这一格今天就有读者：设计文档 O2 写的命令是 `hub charter seed`，而本仓把它落成了
    // `pnpm hub:charter seed`（charter 是**脚本名**不是 verb，见文件头「命令名的一处偏离」）。
    // 一个人照着文档敲 `pnpm hub:charter charter seed` 就落在这里 —— 我自己在验收
    // 这一发时就是这么打错的。报「没有 [charter] 这个子命令」比报「未知参数 charter」
    // 或「缺 --db」离真因近得多：前者说明命令名多打了一层，后两条会让人去查参数。
    return { code: EXIT_USAGE };
  }
  try {
    return await runSeedCli(argv.slice(1), io, env);
  } catch (e) {
    // 兜底同 hub-work.ts：库损坏 / 迁移失败 / 守卫抛出来的那句话，
    // 让它冒出去的表现是「进程以 1 退出并打一段 stack」—— 码对了，但那一段 stack
    // 对人类是噪声，而脚本作者看不出这是「跑炸了」还是「参数错了」。
    // 守卫抛的那句话本来就写得比 stack 有用，所以打消息本身，码给 1。
    const msg = e instanceof Error ? e.message : String(e);
    io.error("执行失败：" + msg + "\n");
    return { code: EXIT_PROBLEM };
  }
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  await runCharterCliOnStdio(process.argv.slice(2));
}
