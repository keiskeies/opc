/**
 * 执行器注册表（T6）。「这个 hub 今天能派哪些活」的装配期答案。
 *
 * ── 为什么是构造期定表，而不是运行期随便 register ────────────────────
 * 注册表是【装配表】：七种 kind 各一份实现，在进程启动时一次登记（测试里则由
 * 用例自己拼一份最小表）。运行期随处可 register 的表，出问题时读不出
 * 「这条路由是谁在什么时候塞进来的」—— 所以这里把入口收成构造函数一个。
 *
 * ── executor_disabled 的语义：有实现但被裁剪 ─────────────────────────
 * 注册表里【有】实现、但被 registerDisabled 显式关掉（测试只想跑纯逻辑、
 * 裁剪版部署不带 CLI），失败码是 executor_disabled。
 * 「未注册」（装配漏了实现）与「已禁用」（装配故意裁掉）对路由器【同形】：
 * get() 都交 null，路由走同一支（合成 executor_disabled，retry false ——
 * 被裁掉的实现换它也没意义，下一个执行器才有机会）。
 * 两种成因在同形之下仍可指认：台账里查 registry.disabled ——
 * kind ∈ disabled ⇒ 故意裁剪；kind ∉ disabled 且 get 给 null ⇒ 装配真漏了，
 * 那是装配 bug，不是部署形状。禁用集就是「同形但可归因」的那份差分账。
 */
import type { ExecutorKind } from "@opc/contracts";
import type { Executor } from "./types.js";

export class ExecutorRegistry {
  /** kind → 实现。只收【启用】的：禁用的实现今天没有读取方，与其留着不如不留。 */
  readonly #byKind = new Map<ExecutorKind, Executor>();
  readonly #disabled = new Set<ExecutorKind>();
  /** 已启用的注册序（Map 保持插入序；list() 直接由它派生）。 */
  readonly #order: ExecutorKind[] = [];

  /**
   * 装配入口：一份 Executor[]，重复 kind ⇒【抛】。
   *
   * 为什么抛而不是「后注册覆盖先注册」：装配表是手写的，重复登记同一 kind
   * 只有两种可能 —— 抄表时多贴了一行，或合并分支时两份实现都没删。
   * 两种都是装配 bug，而覆盖语义会把其中一份实现【静默变成死代码】：
   * 代码里明明挂着 claude-cli 的壳，跑的却是另一份，故障推迟到线上才现形。
   * 响亮优于静默（与 executorRunRequestSchema 的 superRefine 同一立场）。
   */
  constructor(executors: Executor[] = []) {
    for (const ex of executors) {
      if (this.#byKind.has(ex.kind)) {
        throw new Error(
          "ExecutorRegistry：kind=" +
            ex.kind +
            " 重复注册。装配表手误要响亮 —— 覆盖语义会让先注册那份静默变死代码。",
        );
      }
      this.#byKind.set(ex.kind, ex);
      this.#order.push(ex.kind);
    }
  }

  /**
   * 显式裁剪一个 kind（部署裁剪 / 测试用）。幂等：重复禁用不抛。
   * 禁用的语义是「有实现也不给跑」——不要求事先注册过（装配表长什么样
   * 是使用方的事，禁用集记的是意图，两边不互为前提）。
   */
  registerDisabled(kind: ExecutorKind): void {
    this.#disabled.add(kind);
    // 从启用表里摘掉：get() 的「null = 不可用」必须只有一条判据（byKind 缺席），
    // 否则读取方要记得查两处 —— 忘查 disabled 的那份代码就是洞。
    // 注册序同步抹掉 ⇒ list() 恒等于「已启用 kinds，注册序」。
    this.#byKind.delete(kind);
    const at = this.#order.indexOf(kind);
    if (at >= 0) this.#order.splice(at, 1);
  }

  /**
   * 取实现。未注册或被禁用 ⇒ null（两种成因对路由器同形，见文件头）。
   */
  get(kind: ExecutorKind): Executor | null {
    return this.#byKind.get(kind) ?? null;
  }

  /** 被显式禁用的 kinds：台账用它把「同形」的两支归因回「裁剪」还是「漏装」。 */
  get disabled(): ReadonlySet<ExecutorKind> {
    return this.#disabled;
  }

  /** 已启用的 kinds，按注册序（禁用即从序里抹掉）。 */
  list(): readonly ExecutorKind[] {
    return this.#order;
  }
}
