/**
 * 主张登记表守卫。
 *
 * 分工同 zero-producer：判据在 claims-registry.ts（纯函数，吃注入的 Files）——
 * 变异测试能喂合成语料而不碰磁盘（合成输入与真仓库输入的同一个函数，正是
 * 「阳性对照与被检项共用同一个判定函数」那条家规）。
 *
 * ── 四段各自防什么 ─────────────────────────────────────────────
 * · 判据一（真仓库）：每条 check 对今天盘上的文件返回空。取材坏了、主张过期了
 *   都在这段先红。
 * · 变异（合成输入）：把判据的输入改坏，判据必须红 —— 防「判据恒绿装饰」。
 * · 出口文档渲染：docs/OPC-OS-功能优化设计.md 里那张表与 REGISTRY 渲染逐字一致
 *   —— 渲染变了、文档没同步改，当场红。
 * · 大院判据：judge 指向的守卫文件必须真的存在；登记表条数与判据函数不得为 0。
 *
 * ── 双向的另一半（登记了、原文没了）─ 由 zero-producer / dead-modules 自己管 ──
 * r5–r8 的 check 是「去既有守卫的登记表/基线找档案」。档案被摘 ⇒ 这里红。
 * 「文档里新增了『零 X』句子而没登记」这一方向做不了自然语言全量判 ——
 * 原因写在 claims-registry.ts 文件头，这里测试按「登记表非空 + 每条都有判据 +
 * judge 存在 + 渲染一致」把中间地带尽量收窄。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type Files,
  REGISTRY,
  realFiles,
  renderMarkdown,
} from "./claims-registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OPCOS = join(ROOT, "docs", "OPC-OS-功能优化设计.md");

/** 一张只含合成文本的 Files：不碰磁盘。 */
function fakeFiles(files: Record<string, string>, all?: string[]): Files {
  return {
    src(name: string): string {
      const v = files[name];
      if (v === undefined) throw new Error("fake src 缺失: " + name);
      return v;
    },
    arch(name: string): string {
      const v = files["arch:" + name];
      if (v === undefined) throw new Error("fake arch 缺失: " + name);
      return v;
    },
    hubTest(name: string): string {
      const v = files["hubTest:" + name];
      if (v === undefined) throw new Error("fake hubTest 缺失: " + name);
      return v;
    },
    /**
     * ⚠ 每一发合成用例都必须经各自那份 `rXXGood()` 交出这个键：判据读它是包在
     * `try` 里的，缺键时抛的错误会被那个 catch 收成「那份文件不在了」——
     * 于是「文件真的没了」与「夹具少给一个键」在断言上逐字一样。
     * `tsc -b` 抓不到缺方法（0047 量过它【从不检查测试】，本文件就是一份测试），
     * 所以这一格的守卫只能是写用例的纪律 + 下面那些变异各有一发【整份不见】。
     */
    migration(name: string): string {
      const v = files["migration:" + name];
      if (v === undefined) throw new Error("fake migration 缺失: " + name);
      return v;
    },
    /**
     * ⚠ 同 `migration` 那一条纪律（为 r22 加的）：每一发合成用例都必须经各自那份
     * `rXXGood()` 交出 `contracts:` 那两个键，缺键时抛的错误会被判据里那个 catch
     * 收成「那份文件不在了」——「文件真的没了」与「夹具少给一个键」在断言上逐字一样。
     */
    contracts(name: string): string {
      const v = files["contracts:" + name];
      if (v === undefined) throw new Error("fake contracts 缺失: " + name);
      return v;
    },
    countFiles(dir: string, exts: readonly string[]): number {
      // 合成侧的口径：一个目录数出多少文件，写在 `count:<dir>|<ext>` 里。
      // 缺键 ⇒ 0（= 取材空），于是「非空下限」那一判据在合成语料上默认可打。
      for (const ext of exts) {
        const v = files["count:" + dir + "|" + ext];
        if (v !== undefined) return Number(v);
      }
      return 0;
    },
    allSrc(): string[] {
      return all ?? Object.keys(files).filter((k) => !k.startsWith("arch:"));
    },
  };
}

const problems = (f: Files): string[] =>
  REGISTRY.map((r) => r.check(f)).filter((x) => x !== "");
/** 只跑某一条的判据（合成语料只提供那条判据需要的文件）。 */
const checkOne = (id: string, f: Files): string => {
  const r = REGISTRY.find((e) => e.id === id);
  if (r === undefined) throw new Error("登记表里没有 " + id);
  return r.check(f);
};

/** 真仓库 Files 的好坏例证：让真仓库输入对，同时用合成输入测判据本身。 */
describe("主张登记表：判据一（真实仓库今天成立）", () => {
  it("每条登记的 check 对今天的仓库返回空", () => {
    expect(problems(realFiles)).toEqual([]);
  });

  it("r1 判据能扫出 budgets INSERT（真仓库非空 = 取材没坏）", () => {
    const r = REGISTRY.find((e) => e.id === "r1");
    expect(r).toBeDefined();
    // 【round272 换了形状】原来这一发断言 tracker.ts 与 engine/runtime.ts 各含一条
    // `INSERT INTO budgets` —— 那两条字面量是同一件事的两份手抄，本轮把 runtime 那份删了。
    // 于是「取材没坏」今天长这样：① 全 src 扫到【恰好 4 条】带 hard_stop 的语句
    // （条数下限只能放在这里，不能放进 check —— 合成夹具一条语句就够测红绿，
    // 把条数写进判据会让变异样本自己撞上它，红因从「写成 0」变成「条数不够」）；
    // ② 引擎路线仍然在记账，只是改成【import 那唯一一条】。
    // 少了 ② 的话，删掉 runtime 的记账而 r1 照样绿，而那时"没有代码能写 0"
    // 会因为【根本没有代码在写】而成立 —— 那是假绿的新形状，比原来的假绿更难看出。
    // 【round308：2 → 4】POST /budget（http/budget.ts，CEO 显式改限额的写路径）与
    // dev-seed（演示播种）各带一条。4 条里只有 http/budget.ts 那条的 hard_stop 是
    // 绑定参数（= 界面「硬停」勾选框），它由判据的名单规则单独管 —— 见 registry 里
    // HARD_STOP_BIND_WHITELIST 那段；条数这一发只保证【取材没坏】，不担保停法。
    const stmts = realFiles
      .allSrc()
      .flatMap((name) => [
        ...realFiles
          .src(name)
          .matchAll(/INSERT\s+INTO\s+budgets[^;]*?VALUES\s*\((.*?)\)/gs),
      ])
      .filter((m) => m[0].includes("hard_stop"));
    expect(stmts.length).toBe(4);
    expect(realFiles.src("engine/runtime.ts")).toContain(
      "db.prepare(ENSERT_BUDGET_SQL)",
    );
    expect(realFiles.src("budget/tracker.ts")).toContain("INSERT INTO budgets");
  });

  it("r1 的另一半：引擎路线【复用】那条语句，而不是又抄一份（O6 动作 2 的落点）", () => {
    // 这一发守的是【收敛本身】，不是 hard_stop：把 SQL 抄回 runtime.ts 之后，
    // 上面那两发【照样全绿】（r1 扫全文，多一条写 1 的语句不红；取材那一发只数到 2）。
    // 所以「两份 SQL 改一处不带另一处」这个 O6/O7 记过名的结构，必须有一发专门拦。
    // 判据写成【字节】而不是【数量】：抄回来 = 红，抽到第三个模块 = 也红（那时该改的是
    // 这一发，并把住址一起改 —— 理由抄在下面的消息里，不让人猜）。
    const runtime = realFiles.src("engine/runtime.ts");
    const tracker = realFiles.src("budget/tracker.ts");
    for (const literal of [
      "INSERT INTO budgets",
      "INSERT INTO budget_events",
      "consumed_cents = consumed_cents + ?",
    ]) {
      expect(
        runtime.includes(literal),
        "engine/runtime.ts 里又出现了手抄的预算 SQL [" +
          literal +
          "]。budget/tracker.ts 有唯一一份，import 它 —— " +
          "两份的失效方式在 O6 动作 2 / O7 与 gateway.ts 文件头都记过：改一处不带着另一处。",
      ).toBe(false);
    }
    // 反向对照（否则「runtime 不含字面量」可以靠【删掉记账】白拿）：
    // 三句都得在，且用的就是 tracker 导出的那三个名字。
    // 匹配【标识符 + 紧邻的左括号】而不是整句 `db.prepare(X)` —— 格式化器会把长调用折行，
    // 按整句匹配的红因会是排版而不是语义。
    for (const use of [
      "ENSERT_BUDGET_SQL)",
      "IDEMPOTENT_INSERT_SQL)",
      "ADD_CONSUMED_SQL)",
    ]) {
      expect(
        runtime.includes(use),
        "引擎路线少了一句记账：" +
          use +
          "（删掉它比抄回来更坏 —— 账整个不分叉而是【不记】）",
      ).toBe(true);
    }
    expect(tracker).toContain("export const ENSERT_BUDGET_SQL");
    expect(tracker).toContain("export const IDEMPOTENT_INSERT_SQL");
    expect(tracker).toContain("export const ADD_CONSUMED_SQL");
  });

  it("r3 的桥今天确实存在于 src（主张有可指认的对象）", () => {
    expect(realFiles.allSrc()).toContain("channels/abstraction.ts");
    // 定义文件是 bindings/im.ts（r3 的 check 按这个文件排除）
    expect(realFiles.src("bindings/im.ts")).toMatch(
      /export\s+function\s+makeChannelActorResolver/,
    );
  });

  it("r4 的真实仓库没有 new BudgetTracker（今天零发布点确实成立）", () => {
    for (const name of realFiles.allSrc()) {
      expect(/new\s+BudgetTracker/u.test(realFiles.src(name))).toBe(false);
    }
  });

  it("r9 的真仓库那一半：rolePrompt 真的落到 --append-system-prompt", () => {
    // 主张说的是「读者 = 提示词」，而 r9 的判据只证到「runtime 调了渲染函数」。
    // 中间那一跳（渲染结果 → 真的进 CLI 参数）在 claude.ts，判据没覆盖，
    // 所以在这里钉一发：命令行上那面旗与喂给它的那个变量都得在场。
    const claude = realFiles.src("engine/claude.ts");
    expect(claude).toContain('"--append-system-prompt"');
    expect(claude).toContain("i.rolePrompt");
  });

  it("judge 指向的守卫文件确实存在于 test/arch/（防指向被删的守卫）", () => {
    const arch = readdirSync(join(ROOT, "test", "arch"));
    for (const r of REGISTRY) {
      if (r.judge === "claims-registry") continue;
      expect(
        arch.some((x) => x.startsWith(r.judge)),
        r.judge + " 对应的守卫文件不存在",
      ).toBe(true);
    }
  });

  it("登记表非空、判据函数非 0、id 互异", () => {
    expect(REGISTRY.length).toBeGreaterThanOrEqual(8);
    const ids = new Set(REGISTRY.map((r) => r.id));
    expect(ids.size).toBe(REGISTRY.length);
    for (const r of REGISTRY) {
      expect(typeof r.check).toBe("function");
      expect(r.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("主张登记表：变异判别力（真红，合成输入不碰盘）", () => {
  /* ── r1 的读侧那一半（2026-11-19）：写得出 0 的那一处【有人在看】────────
   * ⚠ 下面每一发都必须交出 `serve/charter-pump.ts` 这个键。判据读它是包在 try 里的，
   * 缺键抛的错误会被那个 catch 收成「那份文件不在了」——于是「读方没了」与
   * 「夹具少给一个键」在断言上逐字一样（fakeFiles 上面那段注释记过这一族，
   * 而本轮【真的踩了一次】：读侧那格刚加上去，四发老夹具就红了，红话是「文件不在了」，
   * 而那四发想测的是写侧名单。口径：合成夹具要交出判据要的【每一个】键，
   * 少交一个键测的就不是它以为在测的那件事）。
   */
  const R1_PUMP = "serve/charter-pump.ts";
  /** 读侧那两格要的【真字节】，从真仓库取，不在这里抄一份形状（抄的那份会漂）。 */
  const r1PumpReader = (): string => realFiles.src(R1_PUMP);
  /** 抹掉读侧那一半（写侧名单照旧）⇒ 判据必须红在读侧。 */
  const r1PumpNoReader = (): string =>
    r1PumpReader().replace(
      "SELECT b.hard_stop FROM budgets b ",
      "SELECT b.limit_cents FROM budgets b ",
    );

  const r1Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R1_PUMP]: r1PumpReader(),
    ...over,
  });

  it("变异 r1 之七：读侧没了（那一列退回没人读）⇒ 红，且不许红在名单上", () => {
    const f = fakeFiles(r1Good({ "http/budget.ts": r1GoodBind }));
    expect(checkOne("r1", f)).toBe(""); // 控制组：同一份夹具一字不改 ⇒ 空
    const mutated = fakeFiles(
      r1Good({
        [R1_PUMP]: r1PumpNoReader(),
        "http/budget.ts": r1GoodBind,
      }),
    );
    const msg = checkOne("r1", mutated);
    expect(msg).toContain("hard_stop");
    expect(msg).toContain("不再读");
    // 红因串扰排除：这一发测的是【读侧】，不许它其实红在写侧名单那一族。
    expect(msg).not.toContain("名单");
  });

  it("⭐ 变异 r1 之八：摘掉最外层括号 ⇒ 红（那层括号是本仓抓过的那族）", () => {
    // 只摘收尾那半个 `)` —— 判据读的是 `, 1) = 0)` 这六个字节，
    // 摘掉它同时是「括号没了」与「判据方向翻了」两种改法共同的落点，
    // 所以这一发证的是【那一格字节有执行者】，而语义那一格由
    // packages/hub/test/budget/hard-stop-gate.test.ts 的 IN_REVIEW 那一发挡（全仓唯一）。
    const spec = r1PumpReader().replace("), 1) = 0)", "), 1) = 0");
    expect(spec).not.toBe(r1PumpReader());
    const msg = checkOne(
      "r1",
      fakeFiles(r1Good({ [R1_PUMP]: spec, "http/budget.ts": r1GoodBind })),
    );
    expect(msg).toContain("括号");
    expect(msg).not.toContain("不再读");
  });

  it("⭐ 变异 r1 之九：抹掉代码而只留一句「这里以前读它」的注释 ⇒ 仍红（判的是剥注释后的字节）", () => {
    // 这一发是 r1 读侧那两格【唯一的方向证据】：没有它，「判原文」与「判剥注释后的
    // 字节」两种写法在真仓库上读起来逐字一样，而 charter-pump.ts 的函数头正躺着
    // 一整段解释「为什么故意不看它」的历史注释 —— 判原文会被那种诚实的注释喂绿。
    const base = r1PumpReader();
    // 前提自证：先确认那串字节【真在代码里】且在函数头【之后】，
    // 否则这一发的「红」分不出【注释被剥掉了】与【锚点压根没注在这个文件上】。
    const anchor = base.indexOf("export function underTaskBudgetSql");
    const at = base.indexOf("SELECT b.hard_stop FROM budgets b");
    expect(at).toBeGreaterThan(-1);
    expect(anchor).toBeLessThan(at);
    const commented = base.replace(
      "SELECT b.hard_stop FROM budgets b ",
      "SELECT b.LIMIT_NOT_REAL FROM budgets b ",
    );
    // 把抹掉的那句【以注释形态】放回去 ⇒ 仍【该红】：判的是剥掉注释后的字节，
    // 一句「这里以前读它」的诚实历史注释不许替「今天读了」投票。
    // 这一发同时是那一格的方向证据 —— 判【原文】的实现在这一发上会【绿】，
    // 因为那串字节确实在文件里（只是出现在注释里）。两种读法只在这一发上分得出。
    const withNote =
      "/* 历史：这里以前读 SELECT b.hard_stop FROM budgets b 那句 */\n" +
      commented;
    expect(
      checkOne(
        "r1",
        fakeFiles(
          r1Good({ [R1_PUMP]: withNote, "http/budget.ts": r1GoodBind }),
        ),
      ),
    ).toContain("不再读");
    // 而只【加一句注释】、代码一字不动 ⇒ 该绿（判据对无关文案不敏感）。
    expect(
      checkOne(
        "r1",
        fakeFiles(
          r1Good({
            [R1_PUMP]: "/* 这里解释过为什么不看 hard_stop */\n" + base,
            "http/budget.ts": r1GoodBind,
          }),
        ),
      ),
    ).toBe("");
  });

  it("变异 r1：budgets 的 hard_stop 写成 0 必须红", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      "budget/tracker.ts":
        'const s = "INSERT INTO budgets (… hard_stop) VALUES (?, ?, ?, ?, ?, 0, 0)";',
      "charter/budget-sync.ts": "",
      "engine/runtime.ts": "",
    });
    expect(checkOne("r1", f)).toContain("hard_stop");
  });

  it("变异 r1 反向：写 1 不红", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      "budget/tracker.ts":
        'const s = "INSERT INTO budgets (… hard_stop) VALUES (?, ?, ?, ?, ?, 0, 1)";',
      "charter/budget-sync.ts": "",
      "engine/runtime.ts": "",
    });
    expect(checkOne("r1", f)).toBe("");
  });

  // ── round308：主张改成「记账路径写不出 0，写 0 只有登记过的这一处」之后的三条新规则。
  //    名单内那一处（http/budget.ts）本身不重测——它由真仓库那一发覆盖；
  //    这里测的是【名单守不守得住】：B 拦名单外的绑参写点、C 拦名单变成假证人、
  //    D 拦名单外悄悄 upsert 停法。少了 C 的话，删掉那个入口而名单照旧，
  //    判据继续替一个不存在的功能担保 —— 与本文件 r10/r11/r12 那一族同一件事。
  const r1GoodBind =
    'const s = "INSERT INTO budgets (id, hard_stop) VALUES (?, ?, ?, ?, ?, 0, ?) ON CONFLICT(x) DO UPDATE SET limit_cents = excluded.limit_cents, hard_stop = excluded.hard_stop";';

  it("变异 r1 之三：名单外多一处绑参写 hard_stop ⇒ 红并点名那个文件", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      "http/budget.ts": r1GoodBind,
      "db/新来的.ts":
        'const s = "INSERT INTO budgets (id, hard_stop) VALUES (?, ?, ?, ?, ?, 0, ?)";',
    });
    expect(checkOne("r1", f)).toContain("db/新来的.ts");
  });

  it("变异 r1 之四：名单内那份形状被改 ⇒ 红在「名单失效」，不放过假证人", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      // 那一处入口改成写死 1（功能收窄是允许的），但【没人来改名单】。
      "http/budget.ts": r1GoodBind.replace(
        "?, ?, ?, ?, ?, 0, ?",
        "?, ?, ?, ?, ?, 0, 1",
      ),
    });
    expect(checkOne("r1", f)).toContain("名单失效");
  });

  it("变异 r1 之五：名单外一处 upsert 改写 hard_stop ⇒ 红（改已有行比新建更没人看见）", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      "http/budget.ts": r1GoodBind,
      "budget/别的路.ts":
        'const s = "INSERT INTO budgets (id, hard_stop) VALUES (?, ?, ?, ?, ?, 0, 1) ON CONFLICT(x) DO UPDATE SET hard_stop = excluded.hard_stop";',
    });
    expect(checkOne("r1", f)).toContain("没登记");
  });

  it("变异 r1 之六：名单内那处把字面量改成 0 ⇒ 仍红（名单只豁免绑参，不豁免 0）", () => {
    const f = fakeFiles({
      [R1_PUMP]: r1PumpReader(),
      "http/budget.ts": r1GoodBind.replace(
        "VALUES (?, ?, ?, ?, ?, 0, ?)",
        "VALUES (?, ?, ?, ?, ?, 0, 0)",
      ),
    });
    expect(checkOne("r1", f)).toContain("写成 0");
  });

  it("变异 r2：心跳里拔掉 runTimeoutPass 接线必须红", () => {
    const orig = realFiles
      .src("serve/assemble.ts")
      .replaceAll("runTimeoutPass(", "已拔掉的超时接线(");
    const f = fakeFiles({ "serve/assemble.ts": orig });
    expect(checkOne("r2", f)).toContain("runTimeoutPass");
  });

  it("变异 r2 反向：接线在场 ⇒ 绿（不是恒红装饰）", () => {
    const f = fakeFiles({
      "serve/assemble.ts": "await runTimeoutPass(q, db, now, publish);",
    });
    expect(checkOne("r2", f)).toBe("");
  });

  it("变异 r3 之一：那位【读者】整份不见 ⇒ 红", () => {
    // round280 之前这一发的形状是「出现新调用方 ⇒ 红」（那时主张是「零调用方」）。
    // 主张翻向后判据跟着翻：现在红的是【读者没了】。
    const f = fakeFiles(
      {
        "bindings/im.ts":
          "export function makeChannelActorResolver(x) { return x; }",
      },
      ["bindings/im.ts"],
    );
    expect(checkOne("r3", f)).toContain("channels/approval-bridge.ts 不在了");
  });

  it("变异 r3 之二：读者还在但不再调 resolver ⇒ 红，且红因与上一发不串", () => {
    const f = fakeFiles({
      "bindings/im.ts":
        "export function makeChannelActorResolver(x) { return x; }",
      "channels/approval-bridge.ts":
        "export const actorFor = (s) => ({ senderId: s, channelId: 'c' }); // 自己造身份",
    });
    const why = checkOne("r3", f);
    expect(why).toContain("不再调用 makeChannelActorResolver(");
    // 红因必须是【那一格】，不是「文件没了」——两发红因串了就等于只有一发在判。
    expect(why).not.toContain("不在了");
  });

  it("变异 r3 反向：合成里读者在场 → 判据绿（不是恒红）", () => {
    const f = fakeFiles({
      "bindings/im.ts":
        "export function makeChannelActorResolver(x) { return x; }",
      "channels/approval-bridge.ts":
        "makeChannelActorResolver(read, { platformOfChannel });",
    });
    expect(checkOne("r3", f)).toBe("");
  });

  /* ── r16：O12 那句验收句（四发，形状照 r15）────────────────────────── */

  /** r16 的合成语料：一份「什么都在」的最小形状，变异各发在上面摘一格。 */
  function r16Files(over: Record<string, string | null> = {}): Files {
    const spec = [
      "const verdicts = await h.pollOnce([clickEnvelope(approvalId)]);",
      "await bindPending(h.q);",
      'expect(verdicts).toEqual(["unauthorized"]);',
      'expect(decided?.["actor_id"]).toBe(ROLE);',
      'expect(decided?.["actor_id"]).not.toBe("system");',
      'expect(decided?.["actor_id"]).not.toBe("ceo");',
    ].join("\n");
    const bridge = [
      "const role = d.roleOf(req.actor.senderId, req.actor.channelId);",
      "if (isIrreversibleApproval(snap.approvalType, snap.parametersJson)) return;",
      "makeChannelActorResolver(read, { platformOfChannel });",
    ].join("\n");
    const files: Record<string, string> = {
      "hubTest:acceptance/im-reply-approves-card.test.ts": spec,
      "channels/approval-bridge.ts": bridge,
    };
    for (const [k, v] of Object.entries(over)) {
      if (v === null) delete files[k];
      else files[k] = v;
    }
    return fakeFiles(files);
  }

  it("变异 r16 之一：那发验收测试整份不见 ⇒ 红", () => {
    const f = r16Files({
      "hubTest:acceptance/im-reply-approves-card.test.ts": null,
    });
    expect(checkOne("r16", f)).toContain(
      "im-reply-approves-card.test.ts 不在了",
    );
  });

  it("变异 r16 之二：反空转那一格被摘掉 ⇒ 红且红因不串", () => {
    const f = r16Files({
      "hubTest:acceptance/im-reply-approves-card.test.ts": [
        'expect(decided?.["actor_id"]).toBe(ROLE);',
        'expect(decided?.["actor_id"]).not.toBe("system");',
        'expect(decided?.["actor_id"]).not.toBe("ceo");',
      ].join("\n"),
    });
    const why = checkOne("r16", f);
    expect(why).toContain("反空转那一格");
    expect(why).not.toContain("不在了");
  });

  it("变异 r16 之三：actor 三条断言少「不是 ceo」 ⇒ 红且点名那一半", () => {
    // 这一发是 r16 承重的一发：验收句原文只写了「不是 system」，
    // 而两条生产决策路径写的都是 ceo ⇒ 只留前两条的测试对「照抄 ceo」全绿。
    const f = r16Files({
      "hubTest:acceptance/im-reply-approves-card.test.ts": [
        "await bindPending(h.q);",
        'expect(verdicts).toEqual(["unauthorized"]);',
        'expect(decided?.["actor_id"]).toBe(ROLE);',
        'expect(decided?.["actor_id"]).not.toBe("system");',
      ].join("\n"),
    });
    const why = checkOne("r16", f);
    expect(why).toContain("不是 ceo");
    expect(why).not.toContain("反空转");
  });

  it("变异 r16 之四：桥不再重查角色 ⇒ 红", () => {
    const f = r16Files({
      "channels/approval-bridge.ts":
        "makeChannelActorResolver(read, { platformOfChannel });\n" +
        "if (isIrreversibleApproval(a, b)) return;",
    });
    expect(checkOne("r16", f)).toContain("重查角色");
  });

  it("变异 r16 之五：桥落库前不判可逆性 ⇒ 红", () => {
    const f = r16Files({
      "channels/approval-bridge.ts":
        "const role = d.roleOf(req.actor.senderId, req.actor.channelId);\n" +
        "makeChannelActorResolver(read, { platformOfChannel });",
    });
    expect(checkOne("r16", f)).toContain("不再判可逆性");
  });

  it("变异 r4：注入 new BudgetTracker 必须红（正文里出现 new 点）", () => {
    const f = fakeFiles({
      "budget/tracker.ts": "class BudgetTracker {}\nnew BudgetTracker_BAD();",
      "engine/runtime.ts": "",
    });
    // 只造一个不含对象字面量的简单 corpus；new BudgetTracker 必须被扫出来
    const plus = fakeFiles({
      "budget/tracker.ts":
        "class BudgetTracker {}\nlet t = new BudgetTracker();",
      "engine/runtime.ts": "",
    });
    expect(checkOne("r4", plus)).toContain("new 点");
    void f;
  });

  it("变异 r5：zero-producer 登记表被摘掉 review_gates 必须红", () => {
    const orig = realFiles
      .arch("zero-producer.test.ts")
      .replaceAll('table: "review_gates"', 'table: "review_gates_x"');
    const other = realFiles
      .arch("zero-producer.ts")
      .replaceAll('table: "review_gates"', 'table: "review_gates_x"');
    const f = fakeFiles({
      "arch:zero-producer.test.ts": orig,
    });
    // dead-modules 的 r5 只 rearch zero-producer.test.ts；但如果登记表改在判据文件里，
    // 判据也该读得到 —— r5 的 check 读的是 arch("zero-producer.test.ts")。
    expect(checkOne("r5", f)).toContain("review_gates");
    void other;
  });

  it("变异 r7（round269 改版）：写路径 recordAutoApproval 出现 src 调用方必须红", () => {
    // 主张已从「基线里还有没有这一格」翻成「写者是不是零」—— 判据跟着翻：
    // 影子判定攒出读数之前，任何 src 内的 recordAutoApproval 调用都越过了阶段一边界。
    const f = fakeFiles({
      "policy/auto-approve.ts":
        "export function recordAutoApproval(db: unknown): void {}",
      "engine/evil.ts":
        'import { recordAutoApproval } from "../policy/auto-approve.js";\nrecordAutoApproval(db, o);',
    });
    expect(checkOne("r7", f)).toContain("engine/evil.ts");
    // 反向对照：只有定义文件调自己（内部helper形状）⇒ 绿，判据不是「出现名字就红」。
    const ok = fakeFiles({
      "policy/auto-approve.ts": "recordAutoApproval(db, o);",
      "approvals/query.ts": "autoApprove({ action });",
    });
    expect(checkOne("r7", ok)).toBe("");
  });

  it("变异 r9 之一：提示词渲染里删掉一个字段的读者必须红", () => {
    // 模拟「有人把某一格从渲染里去掉」——整行删掉，不是改名（改名会让判据
    // 与真代码同时失去对象，那是另一种故障）。
    const drop = (key: string): string =>
      realFiles
        .src("charter/prompt.ts")
        .split("\n")
        .filter((l) => !l.includes("c." + key))
        .join("\n");
    for (const key of ["forbiddenActions", "escalationTriggers"]) {
      const f = fakeFiles({
        "charter/prompt.ts": drop(key),
        "engine/runtime.ts": realFiles.src("engine/runtime.ts"),
      });
      expect(checkOne("r9", f), key + " 的读者没了而判据不红").toContain(key);
    }
  });

  it("变异 r9 之二：runtime 不再调 renderCharterPrompt ⇒ 只有这一半抓得到", () => {
    // 这一发是 r9 存在的理由：字段级判据只看 prompt.ts 还在不在读字段，
    // 而「渲染函数还在、没人调用它」时六个字段全体失去读者、字段级判据【全绿】。
    // 所以反向对照不是「绿」，是「字段那一半绿而调用那一半红」。
    const prompt = realFiles.src("charter/prompt.ts");
    const runtime = realFiles
      .src("engine/runtime.ts")
      .replaceAll("renderCharterPrompt(", "renderNothing(");
    const f = fakeFiles({
      "charter/prompt.ts": prompt,
      "engine/runtime.ts": runtime,
    });
    const msg = checkOne("r9", f);
    expect(msg).toContain("renderCharterPrompt");
    expect(msg).not.toContain("不再读岗位书字段");
    // 同一份 prompt.ts 在字段级判据下【不红】：证明两半各判各的故障，不是重复。
    const onlyFields = fakeFiles({
      "charter/prompt.ts": prompt,
      "engine/runtime.ts": realFiles.src("engine/runtime.ts"),
    });
    expect(checkOne("r9", onlyFields)).toBe("");
  });

  it("变异 r10 之一：守卫文件被摘掉 ⇒ 红（主张重新变回一句散文）", () => {
    // fakeFiles 的 arch() 缺键即抛，正好模拟「文件不在了」。
    const f = fakeFiles({ "lint-baseline.test.ts": "runBiomeJson();" });
    expect(checkOne("r10", f)).toContain("只活在散文里");
  });

  it("变异 r10 之二：文件还在但不再声称管 verify ⇒ 红（只看存在性的判据在这一发面前是绿的）", () => {
    // 这一发挑的是判据的形状：如果 r10 只判「lint-baseline.ts 存在」，这里就绿了，
    // 而现实是「守卫还在，但它照管的那件事被摘走了」—— 一个还在干活的假象。
    const guard = realFiles
      .arch("lint-baseline.ts")
      .replaceAll("pnpm verify", "别的事");
    const f = fakeFiles({
      "arch:lint-baseline.ts": guard,
      "arch:lint-baseline.test.ts": realFiles.arch("lint-baseline.test.ts"),
    });
    const msg = checkOne("r10", f);
    expect(msg).toContain("它声称照管的那件事被摘走了");
    // 反向对照：只改这一处，第三格（runBiomeJson）仍在 ⇒ 红话只能来自第二格。
    expect(msg).not.toContain("没人跑 biome");
  });

  it("变异 r10 之三：守卫测试不再真跑 biome ⇒ 红（表会被当成证据）", () => {
    const test = realFiles
      .arch("lint-baseline.test.ts")
      .replaceAll("runBiomeJson(", "lookAtTheTable(");
    const f = fakeFiles({
      "arch:lint-baseline.ts": realFiles.arch("lint-baseline.ts"),
      "arch:lint-baseline.test.ts": test,
    });
    expect(checkOne("r10", f)).toContain("没人跑 biome");
  });

  it("变异 r11 之一：守卫文件被摘掉 ⇒ 红", () => {
    const f = fakeFiles({ "arch:plan-refs.test.ts": "readCorpus();" });
    expect(checkOne("r11", f)).toContain("重新变成一句散文");
  });

  it("变异 r11 之二：取材被悄悄改窄回只扫代码 ⇒ 红（这一格就是 P4 那发变异教出来的）", () => {
    // 这是 P4 在【登记表层】的对应物：plan-refs.test.ts 的 10 发里有分块下限兜着，
    // 但那是那条守卫自己的事。r11 判的是更前一格 —— 有人把 docs 那一块从取材里删掉时，
    // 主张「每句引用都有人核对」其实已经只对一半仓库成立，而文件还在、名字没改。
    const guard = realFiles
      .arch("plan-refs.ts")
      .replaceAll('collect(root, "docs", ".md"), ', "");
    const f = fakeFiles({
      "arch:plan-refs.ts": guard,
      "arch:plan-refs.test.ts": realFiles.arch("plan-refs.test.ts"),
    });
    const msg = checkOne("r11", f);
    expect(msg).toContain("round275-P4");
    // 反向对照：只改这一处 ⇒ 红话不许来自另外两格。
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("只剩合成夹具");
  });

  it("变异 r11 之三：测试不再读真仓库 ⇒ 红（合成夹具不能替真实语料作证）", () => {
    const test = realFiles
      .arch("plan-refs.test.ts")
      .replaceAll("readCorpus(", "makeFixture(");
    const f = fakeFiles({
      "arch:plan-refs.ts": realFiles.arch("plan-refs.ts"),
      "arch:plan-refs.test.ts": test,
    });
    expect(checkOne("r11", f)).toContain("只剩合成夹具");
  });

  it("变异 r12 之一：守卫文件被摘掉 ⇒ 红", () => {
    const f = fakeFiles({});
    expect(checkOne("r12", f)).toContain("重新变成一句散文");
  });

  it("变异 r12 之二：住址判据被换成恒真 ⇒ 红（G4 在登记表层的对应物）", () => {
    // G4 那发变异在 plan-gate-paths.test.ts 里的下场是：合成 5 发红、真仓库 4 发全绿。
    // 也就是说【那条守卫自己】抓不到这种退化有多危险 —— 所以登记表这一层要单独问一句：
    // 判据还在不在真的查住址？只看「文件存在」的判据在这一发面前是绿的。
    const guard = realFiles
      .arch("plan-gate-paths.ts")
      .replaceAll("if (!exists(p))", "if (!true)");
    const f = fakeFiles({ "arch:plan-gate-paths.ts": guard });
    const msg = checkOne("r12", f);
    expect(msg).toContain("round276-G4");
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("退回成一句人话说明");
  });

  it("变异 r12 之三：豁免改成比语义而不是比字节 ⇒ 红（豁免会退回成散文）", () => {
    // ⚠ 这一发第一版是【假的一发】：我改的是 NOT_BUILT_TAG 常量的【值】，
    //   而那个字符串字面量本来就写在常量定义里 ⇒ 判据「文件里还有这串字节」照样成立 ⇒ 判据返回空。
    //   一个「改了个东西，结果判据根本不看那个东西」的测试，比没有测试更糟：
    //   它会在报告里占一行绿。改成改【比对方式】—— 那才是判据真正盯着的一格。
    const guard = realFiles
      .arch("plan-gate-paths.ts")
      .replaceAll("includes(NOT_BUILT_TAG)", 'includes("没建，见台账")');
    const f = fakeFiles({ "arch:plan-gate-paths.ts": guard });
    expect(checkOne("r12", f)).toContain("退回成一句人话说明");
  });

  it("变异 r13 之一：守卫文件被摘掉 ⇒ 红", () => {
    const f = fakeFiles({});
    expect(checkOne("r13", f)).toContain("重新变成一句散文");
  });

  it("变异 r13 之二：相邻判据被换成【两个串都在文件里】⇒ 红", () => {
    // 这一发治的是 r11 那条 P4 的同族：判据还在文件里，但它对【任何】形状都返回真。
    // 而 role-spawn-boundary.test.ts 那 11 发【抓不到】—— 它们改的是合成夹具，
    // 判据本身一行没动就照样全绿。只有登记表这一层问「你还逐格比吗」才看得见。
    const real = realFiles.arch("role-spawn-boundary.ts");
    const guard = real.replaceAll('s[k + 1] === "plan"', 's.includes("plan")');
    // 先确认改到了东西：改不动的变异会伪装成一发绿（r12 之三那个教训）。
    expect(guard).not.toBe(real);
    const f = fakeFiles({ "arch:role-spawn-boundary.ts": guard });
    const msg = checkOne("r13", f);
    expect(msg).toContain("逐格比对");
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("失明");
  });

  it("变异 r13 之三：探针键不再逐个核对 ⇒ 红", () => {
    const real = realFiles.arch("role-spawn-boundary.ts");
    const guard = real.replaceAll(
      "for (const k of PROBE_KEYS)",
      "for (const k of [])",
    );
    expect(guard).not.toBe(real);
    const f = fakeFiles({ "arch:role-spawn-boundary.ts": guard });
    const msg = checkOne("r13", f);
    expect(msg).toContain("失明");
    expect(msg).not.toContain("逐格比对");
  });

  // ── r14：坐标核对在门禁里。这条是【自指】的，所以三发各打一种空壳化 ──
  it("变异 r14 之一：坐标守卫被摘掉 ⇒ 红", () => {
    const f = fakeFiles({});
    expect(checkOne("r14", f)).toContain("重新变成一句散文");
  });

  it("变异 r14 之二：那句「登记行命中了吗」的比较被掏空 ⇒ 红且红因不串", () => {
    // 这一发就是本轮变异 C3 在登记表层的对应物：判据文件还在、名字还在，
    // 只有那句比较不判了。claim-coords.test.ts 那 5 发合成变异【抓不到】——
    // 它们全都在判 coordDrifts 的输出，而掏空之后真仓库那一发【照绿】。
    const real = realFiles.arch("claim-coords.ts");
    const guard = real.replaceAll(
      "if (located.includes(e.source.line)) continue;",
      "if (located.length < 0) continue;",
    );
    expect(guard).not.toBe(real);
    const f = fakeFiles({
      "arch:claim-coords.ts": guard,
      "arch:claim-coords.test.ts": realFiles.arch("claim-coords.test.ts"),
    });
    const msg = checkOne("r14", f);
    expect(msg).toContain("登记的行号命中了吗");
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("非空");
  });

  it("变异 r14 之三：把「取材非空」那一发摘掉 ⇒ 红", () => {
    // 摘掉它之后，REGISTRY 退化成空数组时这条守卫恒绿，而输出与「十四条全对」逐字一样。
    const real = realFiles.arch("claim-coords.test.ts");
    const spec = real.replaceAll(
      "REGISTRY.length",
      "registryNonEmptyCheckDeleted",
    );
    expect(spec).not.toBe(real);
    const f = fakeFiles({
      "arch:claim-coords.ts": realFiles.arch("claim-coords.ts"),
      "arch:claim-coords.test.ts": spec,
    });
    const msg = checkOne("r14", f);
    expect(msg).toContain("非空");
    expect(msg).not.toContain("重新变成一句散文");
  });

  // ── r15：`POST /org` 加不了新角色。各发打一种「验收测试还在但已不判那件事」──
  const R15_KEY = "hubTest:acceptance/new-role-to-its-own-criteria.test.ts";
  /** r15 判据在合成语料下【不红】所需的最小一份好输入。 */
  const r15Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R15_KEY]: realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    ),
    "count:packages/web/src|.ts": "4",
    "count:packages/web/public|.js": "1",
    "count:packages/desktop/src|.ts": "7",
    ...over,
  });

  it("r15 的真仓库那一半：取材真的读得到那三个前端根与那发验收测试", () => {
    // 正向对照（本仓的家规：判据与被检项共用同一个函数，而「读到东西」要单独钉）。
    // 这一发红了说明【取材坏了】，而不是说明主张过期 —— 两种红的修法完全不同。
    expect(
      realFiles.countFiles("packages/web/src", [".ts", ".tsx"]),
    ).toBeGreaterThan(0);
    // ⚠ round295 新加的这一格就是本轮那个假证人的【位置】：旧的那发只钉了上下两个根，
    // 于是「web/public 一个文件都没扫到」这件事在这里也是绿的。
    expect(
      realFiles.countFiles("packages/web/public", [".js", ".jsx"]),
    ).toBeGreaterThan(0);
    expect(
      realFiles.countFiles("packages/desktop/src", [".ts", ".tsx"]),
    ).toBeGreaterThan(0);
    expect(
      realFiles.hubTest("acceptance/new-role-to-its-own-criteria.test.ts"),
    ).toContain("rolePrompt");
  });

  it("变异 r15 之一：那发验收测试整份不见 ⇒ 红", () => {
    expect(checkOne("r15", fakeFiles({}))).toContain("重新变成一句散文");
  });

  it("变异 r15 之二：反空转那一格被摘掉 ⇒ 红且红因不串", () => {
    // 剩下几发照样全绿，而它们只证明「名字进了图」—— 这正是 O8 正文警告的假绿。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replaceAll(
      'rolePrompt("data")',
      "rolePrompt(UNUSED_ANCHOR_REMOVED)",
    );
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("反空转那一格");
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("前提");
    expect(msg).not.toContain("不可信");
  });

  it("变异 r15 之三：前提自证那一格被摘掉 ⇒ 红（撞名那天必须有人红）", () => {
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replaceAll(
      'expect(stems).not.toContain("translator")',
      "expect(stems.length).toBeGreaterThanOrEqual(0)",
    );
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("前提");
    expect(msg).not.toContain("反空转那一格");
  });

  it("变异 r15 之四：三个前端根全数出 0 个文件 ⇒ 那条读数判不可信而不是绿", () => {
    // 恒真的否定式主张是本仓最贵的一族：目录改名/整个没 ⇒ 「零出现」自动成立。
    const msg = checkOne(
      "r15",
      fakeFiles(
        r15Good({
          "count:packages/web/src|.ts": "0",
          "count:packages/web/public|.js": "0",
          "count:packages/desktop/src|.ts": "0",
        }),
      ),
    );
    expect(msg).toContain("不可信");
    expect(msg).not.toContain("反空转那一格");
  });

  it("⭐⭐ 变异 r15 之五：取材表里摘掉 web/public 那一行 ⇒ 红（本轮那个假证人的形状）", () => {
    // 这一发是本轮的正题，也是 r15 那条判据【重写】的唯一理由：
    // 旧判据在这里数「web/src + desktop/src 的 ts/tsx ≥ 5」，实测 4+7=11 ⇒ 通过，
    // 而那份取材一次也没看见 app.js。所以【量过】不等于【量对位置】。
    // 变异打的是【取材表】而不是产品字节：把那一行抹掉，那发端到端照样绿，
    // 而它会重新变成「每种 kind 谁都不发」—— 本轮那份假证人的复活路径。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const line = `  { dir: join(HUB, "..", "web", "public"), exts: [".js", ".jsx"] },\n`;
    expect(real).toContain(line);
    const spec = real.replace(line, "");
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("app.js");
    // 红因不串：不许是「测试没了」/「反空转」/「前提」那三种红冒充这一格。
    expect(msg).not.toContain("重新变成一句散文");
    expect(msg).not.toContain("反空转那一格");
    expect(msg).not.toContain("不可信");
  });

  it("⭐ 变异 r15 之五·乙：只摘扩展名里的 .js（根留着）⇒ 也红", () => {
    // 之五抹的是整行，那一行同时带走了根与扩展名。本轮量到的事实是【两个洞各自
    // 独立够用】（根少一个 / 扩展名少一种都会漏掉 app.js），那就得有两发钉。
    // 这一发留着 `web/public` 那个根，只把 `.js` `.jsx` 换成 `.ts` `.tsx` ——
    // 那份取材仍然"扫 web/public"，而它在盘上一个文件都扫不到。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replace(
      '{ dir: join(HUB, "..", "web", "public"), exts: [".js", ".jsx"] }',
      '{ dir: join(HUB, "..", "web", "public"), exts: [".ts", ".tsx"] }',
    );
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("app.js");
    expect(msg).not.toContain("不可信");
  });

  it("⭐ 变异 r15 之五·丙：换掉【结束锚】⇒ 红在「不可核对」而不是绿到文件尾", () => {
    // 这一发钉的是【作用面有没有边界】。sliceFrom 缺任一标记都返回 null（它不退回
    // 「读到文件尾」），而退回文件尾那种写法恰好【也能让这一格绿】—— 差别要等
    // 那天有人在 CONSOLE_JS 之后写一段带 ".js" 的注释，那一格就悄悄恒绿了。
    // 所以这里量的是【结束锚有没有读者】：把它改名 ⇒ 必须红在「不可核对」。
    // 与之六分开：之六换【起锚】，这一发换【止锚】，两种坏是两处代码。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replaceAll("CONSOLE_JS", "CONSOLE_APP_JS");
    expect(spec).not.toBe(real);
    expect(spec).toContain('"public"'); // 那段字节还在 —— 红只能红在锚上
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("不可核对");
    expect(msg).not.toContain("app.js");
    expect(msg).not.toContain("不可信");
  });

  it("⭐ r15 之五的控制组：一字不改 ⇒ 返回空（否则上面三发红在变异之外）", () => {
    // 上面那三发只证了【改了会红】。没有这一发，判据也可能写成【恒红】——
    // 而恒红的守卫会被下一个人当环境噪音摘掉，比不写更坏（本仓 0055/0056/0057 三连）。
    expect(checkOne("r15", fakeFiles(r15Good()))).toBe("");
  });

  it("变异 r15 之六：FRONTEND_CORPUS 整段改名 ⇒ 红在【取材面不可核对】", () => {
    // 与「摘掉一行」分开报，因为两种红的修法不同：改名 = 判据的锚要先跟过去；
    // 摘一行 = 主张真的又变得不可信了。混成一条红会让人去改错的那一处。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replaceAll("FRONTEND_CORPUS", "SCAN_ROOTS");
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("不可核对");
    expect(msg).not.toContain("app.js");
    expect(msg).not.toContain("不可信");
  });

  it("⭐⭐ 变异 r15 之七：名单里 add_edge 那一格被放宽成空 ⇒ 红（round308 补的那格）", () => {
    // 本轮的正题：round295 把主张翻成【正向点名】，可那份名单只活在那发测试的
    // `expect(emitters).toEqual(…)` 里，判据一格都没核它。round308 界面补上
    // add_edge / add_node 之后，文案与名单各说各的而判据【全绿】—— 这一发钉的就是那次。
    // 方向选「放宽成空」：那是最省字、也最容易顺手做的一种改法（把名单改成 [] 就像在放松断言）。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replace("add_edge: [consolePath],", "add_edge: [],");
    expect(spec).not.toBe(real);
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("名单");
    expect(msg).toContain("add_edge");
    // 红因不串：不许是①②③④ 那四种红冒充这一格。
    expect(msg).not.toContain("反空转那一格");
    expect(msg).not.toContain("不可信");
    expect(msg).not.toContain("取材面");
  });

  it("⭐ 变异 r15 之七·乙：把名单写进【切片之外】的注释而清空真名单 ⇒ 仍红（切片边界有牙）", () => {
    // 之七 只证了「改了会红」。没有这一发，判⑤ 也可能被写成【整份文件搜一下】——
    // 那种写法在下面这发里会绿：真名单空了，但文件里别处留着同样那几个字节。
    // r22 为同一件事挨过一次变异（M8：调用字节留着而分派短路），这里复用的是同一条纪律。
    // ⚠ 诱饵必须放在【切片之外】：sliceFrom 取的是起锚到止锚之间，而
    // 「// ② 前提自证」就是止锚 —— 把诱饵插在那行【之前】等于插进名单里，
    // 那一格会因此变绿，而变绿的原因是变异打错了位置、不是判据有牙。第一版就写错过这一处。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real
      .replace("add_edge: [consolePath],", "add_edge: [],")
      .replace(
        "    expect(emitters).toEqual({",
        "    /* 切片之外的诱饵字节：add_edge: [consolePath], */\n    expect(emitters).toEqual({",
      );
    expect(spec).not.toBe(real);
    expect(spec).toContain("add_edge: [consolePath],"); // 字节在场，只是不在名单里
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("名单");
    expect(msg).toContain("add_edge");
  });

  it("⭐ 变异 r15 之八：名单的止锚改名 ⇒ 红在「名单边界读不到」，不退回全文搜", () => {
    // 与之六（起锚 FRONTEND_CORPUS 改名）成对：那发管取材表的边界，这发管名单的边界。
    // sliceFrom 缺任一标记返回 null，而不是【读到文件尾】—— 后者恰好也能让⑤ 绿，
    // 等哪天名单下面出现一段带同样字节的注释，那一格就悄悄恒绿了（与之五·丙同一族）。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    // ⚠ 「改名」必须真的把那串字节抹掉：第一版写成 `… 前提自证 RENAMED`，
    // 而 indexOf 找的是【子串】—— 那行仍以锚点开头 ⇒ 切片一字未变 ⇒ 这发是空变异
    // （跑出「绿」而原因在变异打不着，与上一发的诱饵放错位置同一种错）。
    const spec = real.replaceAll("// ② 前提自证", "// ② PREMISE SELF-CHECK");
    expect(spec).not.toContain("// ② 前提自证"); // 锚点真的不在了，否则这发什么都没说
    expect(spec).toContain("expect(emitters).toEqual({"); // 红只能红在锚上
    const msg = checkOne("r15", fakeFiles(r15Good({ [R15_KEY]: spec })));
    expect(msg).toContain("名单");
    expect(msg).not.toContain("取材面"); // 不是 cell ④ 那张表的红
    expect(msg).not.toContain("不可信");
  });

  it("⭐⭐ 变异 r15 之九：名单坏了【同时】取材也空了 ⇒ 红因必须是「不可信」而不是「名单」", () => {
    // 这一发钉的是【顺序】，不是任何单格。round308 那台矩阵的第一版把它量了出来：
    // 第五格最初写在「三个根非空」那道兜底【之前】，于是「三根全 0」那发红在
    // 名单不匹配上。取材都没了却先报名单 = 把【读不到】当成【读到了不匹配】，
    // 而两者的修法相反（一个去修取材根目录，一个去改主张文案）。
    // 单看每一格都对，串起来的顺序才是主张的一部分 —— 这种缺陷只有跑出来才看得见。
    const real = realFiles.hubTest(
      "acceptance/new-role-to-its-own-criteria.test.ts",
    );
    const spec = real.replace("add_edge: [consolePath],", "add_edge: [],");
    expect(spec).not.toBe(real);
    const msg = checkOne(
      "r15",
      fakeFiles(
        r15Good({
          [R15_KEY]: spec,
          "count:packages/web/src|.ts": "0",
          "count:packages/web/public|.js": "0",
          "count:packages/desktop/src|.ts": "0",
        }),
      ),
    );
    expect(msg).toContain("不可信");
    expect(msg).not.toContain("名单里 add_edge"); // 不许抢在兜底前面报这一格
  });

  // ── r17：发卡那一趟接上了生产入口。七发各打「证据还在但已不判那件事」的一种 ──
  const R17_MIG = "migration:0009_card_delivery_ledger.sql";
  const R17_DEL = "channels/deliver.ts";
  const R17_IMC = "serve/im-channels.ts";
  const R17_TST = "hubTest:channels/deliver.test.ts";
  /** r17 判据在合成语料下【不红】所需的最小一份好输入。 */
  const r17Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R17_MIG]: realFiles.migration("0009_card_delivery_ledger.sql"),
    [R17_DEL]: realFiles.src(R17_DEL),
    [R17_IMC]: realFiles.src(R17_IMC),
    [R17_TST]: realFiles.hubTest("channels/deliver.test.ts"),
    ...over,
  });

  it("r17 的真仓库那一半：三份取材都读得到，且顺序断言读的是真代码", () => {
    // 正向对照。这一发红说明【取材坏了】，而不是主张过期 —— 两种红的修法不同。
    expect(realFiles.migration("0009_card_delivery_ledger.sql")).toContain(
      "PRIMARY KEY (approval_id, channel_id)",
    );
    const d = realFiles.src(R17_DEL);
    expect(d.indexOf("claimed = await claimDelivery(")).toBeLessThan(
      d.indexOf("= await deliverCard("),
    );
    const s = realFiles.src(R17_IMC);
    expect(s.indexOf("await runtime.pollAll()")).toBeLessThan(
      s.indexOf("await deliverRound()"),
    );
  });

  it("变异 r17 之一：那份迁移整份不见 ⇒ 红", () => {
    const f = fakeFiles({
      ...r17Good(),
      [R17_MIG]: "",
    });
    // 空串走的是"读得到但那句没了"那一支，所以红因是 FK/主键，不是"不在了"。
    // ⇒ 整份不见必须用【缺键】来造，这一发与下面那一发各判一半。
    expect(checkOne("r17", f)).toContain("外键");
    const without = r17Good();
    delete without[R17_MIG];
    expect(checkOne("r17", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r17 之二：主键换成自增 id + 唯一索引 ⇒ 红（幂等键换了主人）", () => {
    const real = realFiles.migration("0009_card_delivery_ledger.sql");
    const mig = real.replaceAll(
      "PRIMARY KEY (approval_id, channel_id)",
      "id INTEGER PRIMARY KEY AUTOINCREMENT",
    );
    expect(mig).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_MIG]: mig })));
    expect(msg).toContain("幂等键换了主人");
    expect(msg).not.toContain("外键");
  });

  it("变异 r17 之三：deliver.ts 变成先发再插 ⇒ 红，且红因是顺序而不是别的", () => {
    // ⚠ 第一版这一发是【假的】：我在 claim 之前插了一句 `deliverCard(channel, {...})`
    // 就当它是"先发再插"，判据照绿 —— 因为判据认的是 `= await deliverCard(` 这个
    // 赋值形态，插进去那句不匹配。它红在 `expect(msg).toContain(...)` 拿到空串上，
    // 也就是【什么都没报】。教训与 0025 §3 第 ③ 条同一条：改不动的变异会伪装成一发绿，
    // 而这里更糟 —— 它伪装成一发红。⇒ 现在真做一次【两句互换】，并同时断言
    // 「改到了东西」+「红因是顺序」+「红因不是别的三格」。
    const real = realFiles.src(R17_DEL);
    const send = "    const r = await deliverCard(channel, snap);";
    expect(real.split(send).length - 1).toBe(1);
    const flipped = real
      .replace(send, "")
      .replace(
        "    let claimed: boolean;",
        send + "\n    let claimed: boolean;",
      );
    expect(flipped).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_DEL]: flipped })));
    expect(msg).toContain("先发再插");
    expect(msg).not.toContain("OR IGNORE");
    expect(msg).not.toContain("外键");
    expect(msg).not.toContain("不在了");
  });

  it("变异 r17 之四：摘掉 OR IGNORE ⇒ 红（抢台账从「changes 0」变成抛错）", () => {
    const real = realFiles.src(R17_DEL);
    const del = real.replaceAll(
      "INSERT OR IGNORE INTO card_deliveries",
      "INSERT INTO card_deliveries",
    );
    expect(del).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_DEL]: del })));
    expect(msg).toContain("OR IGNORE");
    expect(msg).not.toContain("先发再插");
  });

  it("变异 r17 之五：摘掉接外键那一支，但注释里那句话留着 ⇒ 仍然红", () => {
    // ⚠ 这一发是本轮踩到的那个坑本身：`FOREIGN KEY constraint failed` 在文件头
    // 那段实测里【也出现一次】，所以判据一度写的是那个裸串 —— 摘掉代码行、留着注释，
    // 判据照绿，而"接住外键"这条判据就此失去主人。needle 因此带上 `why.includes(`。
    const real = realFiles.src(R17_DEL);
    const del = real.replaceAll(
      'if (!why.includes("FOREIGN KEY constraint failed")) throw e;',
      "if (why.length >= 0) throw e;",
    );
    expect(del).not.toBe(real);
    expect(del).toContain("FOREIGN KEY constraint failed");
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_DEL]: del })));
    expect(msg).toContain("外键违例");
    expect(msg).not.toContain("OR IGNORE");
  });

  it("变异 r17 之六：装配层不再调 runDeliverPass ⇒ 红（那条 other 登记删得有依据）", () => {
    const real = realFiles.src(R17_IMC);
    const imc = real.replaceAll(
      "await runDeliverPass({",
      "await nothingHere({",
    );
    expect(imc).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_IMC]: imc })));
    expect(msg).toContain("零生产调用方");
    expect(msg).not.toContain("判决【之前】");
  });

  it("变异 r17 之七：发卡排到判决之前 ⇒ 红（同轮刚批掉的卡会被再推）", () => {
    const real = realFiles.src(R17_IMC);
    const imc = real.replaceAll(
      "const rounds = await runtime.pollAll();",
      "await deliverRound();\n      const rounds = await runtime.pollAll();",
    );
    expect(imc).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_IMC]: imc })));
    expect(msg).toContain("判决【之前】");
    expect(msg).not.toContain("零生产调用方");
  });

  it("变异 r17 之八：投递测试不再实测外键 ⇒ 红（那句 catch 失去唯一分母）", () => {
    const real = realFiles.hubTest("channels/deliver.test.ts");
    const spec = real.replaceAll("/FOREIGN KEY/", "/NEVER_MATCH_THIS/");
    expect(spec).not.toBe(real);
    const msg = checkOne("r17", fakeFiles(r17Good({ [R17_TST]: spec })));
    expect(msg).toContain("唯一");
    expect(msg).not.toContain("先发再插");
  });

  // ── r18：那一发外网 HTTP 一定会结束。判据最容易被写宽的地方是【谁的超时】，
  //    所以下面每一发都只打【自己那一格】，红因互不重叠（同 r17 的写法）。
  const R18_FEI = "channels/feishu.ts";
  const R18_TST = "hubTest:channels/feishu-http.test.ts";
  /** r18 判据在合成语料下【不红】所需的最小一份好输入。 */
  const r18Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R18_FEI]: realFiles.src(R18_FEI),
    [R18_TST]: realFiles.hubTest("channels/feishu-http.test.ts"),
    ...over,
  });

  it("r18 的真仓库那一半：取材读得到，且【两处】调用点各自挂着信号", () => {
    // 正向对照。这一发红说明取材坏了，而不是主张过期。
    expect(
      realFiles.src(R18_FEI).split("signal: AbortSignal.timeout(").length - 1,
    ).toBe(2);
    expect(realFiles.hubTest("channels/feishu-http.test.ts")).toContain(
      "createServer",
    );
  });

  it("变异 r18 之一：适配器整份不见 ⇒ 红在「不在了」", () => {
    const without = r18Good();
    delete without[R18_FEI];
    expect(checkOne("r18", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r18 之二：摘掉【取 token】那一发的信号 ⇒ 红在「少于两处」", () => {
    // 这条是本判据最值钱的一发：一轮只挂一半，读起来完全像「这条加过了」。
    const real = realFiles.src(R18_FEI);
    const at = real.indexOf("        signal: AbortSignal.timeout(");
    expect(at).toBeGreaterThan(-1);
    const end = real.indexOf("\n", at);
    const one = real.slice(0, at) + real.slice(end + 1);
    expect(one.split("signal: AbortSignal.timeout(").length - 1).toBe(1);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_FEI]: one })));
    expect(msg).toContain("少于两处");
    expect(msg).not.toContain("signal 成员");
  });

  it("变异 r18 之三：截止写死（常量整句没了）⇒ 红在「写死在调用点」", () => {
    const real = realFiles.src(R18_FEI);
    const fei = real.replace(
      "export const FEISHU_FETCH_TIMEOUT_MS = 10_000;",
      "const FETCH_TIMEOUT_INTERNAL = 10_000;",
    );
    expect(fei).not.toBe(real);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_FEI]: fei })));
    expect(msg).toContain("写死在调用点");
    expect(msg).not.toContain("少于两处");
  });

  it("变异 r18 之四：把 0 当成关掉超时（畸形值判据没了）⇒ 红", () => {
    const real = realFiles.src(R18_FEI);
    const fei = real.replace(
      "const usable = t !== undefined && Number.isFinite(t) && t > 0;",
      "const usable = t !== undefined && Number.isFinite(t);",
    );
    expect(fei).not.toBe(real);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_FEI]: fei })));
    expect(msg).toContain("关掉超时");
    expect(msg).not.toContain("写死在调用点");
  });

  it("变异 r18 之五：契约上没有 signal 成员 ⇒ 红（「同一个截止」失去主语）", () => {
    const real = realFiles.src(R18_FEI);
    const fei = real.replace("  readonly signal?: AbortSignal;", "");
    expect(fei).not.toBe(real);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_FEI]: fei })));
    expect(msg).toContain("signal 成员");
    expect(msg).not.toContain("少于两处");
  });

  it("变异 r18 之六：测试不再开真监听 ⇒ 红（那份分母退化成断言字段）", () => {
    const real = realFiles.hubTest("channels/feishu-http.test.ts");
    const spec = real.replaceAll("createServer", "pretendThereIsNoServer");
    expect(spec).not.toBe(real);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_TST]: spec })));
    expect(msg).toContain("真监听");
    expect(msg).not.toContain("init.signal");
    const without = r18Good();
    delete without[R18_TST];
    expect(checkOne("r18", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r18 之七：测试不再把 init.signal 接出去 ⇒ 红", () => {
    const real = realFiles.hubTest("channels/feishu-http.test.ts");
    const spec = real.replaceAll("init.signal", "init.body");
    expect(spec).not.toBe(real);
    const msg = checkOne("r18", fakeFiles(r18Good({ [R18_TST]: spec })));
    expect(msg).toContain("init.signal");
    expect(msg).not.toContain("真监听");
  });

  it("⭐ 变异 r18 之八：新加一处【没截止的 fetch】⇒ 那条通用绊线点名它", () => {
    // 这一发是 r18 与 r17 唯一实质不同的地方：它判的不是 feishu.ts，而是
    // 「下一处外网调用会不会悄悄没有截止」。没有它，这条主张只管今天这一处。
    const msg = checkOne(
      "r18",
      fakeFiles({
        ...r18Good(),
        "channels/another-remote.ts":
          "export async function hit(): Promise<number> {\n" +
          '  const res = await fetch("https://example.com", { method: "GET" });\n' +
          "  return res.status;\n" +
          "}\n",
      }),
    );
    expect(msg).toContain("channels/another-remote.ts");
    expect(msg).toContain("没有自设截止");
  });

  // ── r19：测试语料的类型棘轮。这一条判据【不跑 tsc】，它判的是「那份守卫还在，
  //    但不再判那件事」—— 与 r10/r11/r12 同族（档案在 ≠ 还在判）。每一发只摘一格。
  const R19_GUARD = "arch:test-type-baseline.ts";
  const R19_SPEC = "arch:test-type-baseline.test.ts";
  /** r19 判据在合成语料下【不红】所需的最小一份好输入。 */
  const r19Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R19_GUARD]: realFiles.arch("test-type-baseline.ts"),
    [R19_SPEC]: realFiles.arch("test-type-baseline.test.ts"),
    ...over,
  });

  it("r19 的真仓库那一半：两份取材读得到，且判据锚点今天逐字都在", () => {
    // 正向对照。这一发红说明取材坏了或锚点漂了，而不是主张过期。
    // ⚠ 锚点【不写死条数】（round300 从 3 加到 6 时改的口）：写「三格锚点」而数组里
    //   放六条，下一次加锚点就会红在这句话的措辞上 —— 那是最坏的一发红：
    //   红因不在判据而在注释，读红的人会被支去找一个不存在的塌方。
    const g = realFiles.arch("test-type-baseline.ts");
    for (const a of [
      "if (n > allowed)",
      "unregistered.push(",
      "staleTypeEntries",
      // round300 那三格（往上跳的仓外路径族）。
      '  return p === ".." || p.startsWith("../");',
      "const file = escapesUpward(raw)",
      'if (rel === "" || isOutsideRepo(raw, rel)',
    ]) {
      expect(g, "判据锚点漂了：" + a).toContain(a);
    }
    const s = realFiles.arch("test-type-baseline.test.ts");
    expect(s).toContain(".workbuddy/tsconfig.tests.json");
    expect(checkOne("r19", fakeFiles(r19Good()))).toBe("");
  });

  it("变异 r19 之一：判据整份不见 ⇒ 红在「不在了」", () => {
    const without = r19Good();
    delete without[R19_GUARD];
    expect(checkOne("r19", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r19 之二：摘掉上限比较 ⇒ 红在「退回一张表格」", () => {
    // 这条是本判据最值钱的一发：表还在、计数还在、红话的字符串还在，只是没人比了。
    const guard = realFiles
      .arch("test-type-baseline.ts")
      .replace("if (n > allowed)", "if (false)");
    expect(guard).not.toBe(realFiles.arch("test-type-baseline.ts"));
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("上限比较");
    expect(msg).not.toContain("基线外的测试目录");
  });

  it("变异 r19 之三：新目录不再点名 ⇒ 红，且红因不是「上限比较」", () => {
    const guard = realFiles
      .arch("test-type-baseline.ts")
      .replace('unregistered.push(dir + "=" + n);', "");
    expect(guard).not.toBe(realFiles.arch("test-type-baseline.ts"));
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("基线外的测试目录");
    expect(msg).not.toContain("上限比较");
  });

  it("变异 r19 之四：空壳豁免那一半没了 ⇒ 红（豁免开始比现实活得久）", () => {
    // 用 indexOf 切而不是正则：`}` 在带 u 的正则字面量里是【语法错】，
    // 而我第一次就是这么写的 —— 整份测试直接 SyntaxError，一发都没跑。
    const real = realFiles.arch("test-type-baseline.ts");
    const at = real.indexOf("export function staleTypeEntries");
    expect(at).toBeGreaterThan(-1);
    const end = real.indexOf("\n}\n", at);
    expect(end).toBeGreaterThan(at);
    const guard = real.slice(0, at) + real.slice(end + 3);
    expect(guard).not.toBe(real);
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("空壳豁免");
  });

  it("变异 r19 之五：测试整份不见 ⇒ 红（上面那三格重新变回散文）", () => {
    const without = r19Good();
    delete without[R19_SPEC];
    expect(checkOne("r19", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r19 之六：换查另一份（更窄的）project ⇒ 红在主语换了", () => {
    const spec = realFiles
      .arch("test-type-baseline.test.ts")
      .replaceAll(
        ".workbuddy/tsconfig.tests.json",
        ".workbuddy/tsconfig.arch-only.json",
      );
    expect(spec).not.toBe(realFiles.arch("test-type-baseline.test.ts"));
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_SPEC]: spec })));
    expect(msg).toContain("tsconfig.tests.json");
  });

  it("⭐ 变异 r19 之七：摘掉语料下限那条哨兵 ⇒ 红（少报在棘轮上是绿的方向）", () => {
    // include 被改窄时读数是「更少」，而「更少」在只许减不许增的判据上【永远是绿的】。
    // 那两条哨兵是这一族唯一的门 —— 所以「测试里还写着它们」本身就是被守护的东西。
    const spec = realFiles
      .arch("test-type-baseline.test.ts")
      .replace(
        /expect\(\s*run\.filesChecked,[\s\S]*?\)\.toBeGreaterThanOrEqual\(\d+\);/u,
        "",
      );
    expect(spec).not.toBe(realFiles.arch("test-type-baseline.test.ts"));
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_SPEC]: spec })));
    expect(msg).toContain("反假绿哨兵");
  });

  // ── round300 加进来的三格：往上跳的仓外路径那一族 ────────────────────
  // 共同的前提自证：`p.startsWith("../")` 在那份守卫里【整份出现三次】
  // （toRepoRelative 剥前缀那一行、escapesUpward 的返回值、注释里的一次），
  // 所以「判据函数体里在不在」与「整份文件里在不在」是【两个不同的读数】。
  // 这三发各自把一种「整份仍绿而函数体已空」的改法点名，见每发的 note。
  const guardWith = (from: string, to: string): string => {
    const real = realFiles.arch("test-type-baseline.ts");
    const guard = real.replace(from, to);
    expect(guard, "锚点没命中 = 这一发是空变异，它当然会『绿』").not.toBe(real);
    return guard;
  };

  it("变异 r19 之八：escapesUpward 恒假 ⇒ 红，且红因不是「上限比较」那一格", () => {
    const guard = guardWith(
      '  return p === ".." || p.startsWith("../");',
      "  return false;",
    );
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("escapesUpward");
    expect(msg).toContain("花掉本仓");
    // 红因排除：整份文件里那句前缀比较【还在两处】（toRepoRelative 那一行 + 注释），
    // 所以这一发同时是「判据必须切函数体而不是搜全文」的证据。
    expect(msg).not.toContain("上限比较");
    expect(guard).toContain('p.startsWith("../")');
  });

  it("变异 r19 之九：注释里写着 escapesUpward 而函数体空了 ⇒ 仍然红", () => {
    // ⭐ 这一发钉的是【取材口径】而不是判据本身：把整行调用换成一条注释之后，
    //   「整份文件包含 escapesUpward(raw)」仍然成立（注释里就有这几个字），
    //   只有【先切函数体、再剥注释】的写法会红。r22 的 method 记过的那条
    //   withoutComments 盲区（锚点恰好出现在注释里）就是这个形状，这里给它一发正向证据。
    const real = realFiles.arch("test-type-baseline.ts");
    const at = real.indexOf("    const file = escapesUpward(raw)");
    const end = real.indexOf(";", at);
    expect(at).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(at);
    const guard =
      real.slice(0, at) +
      "    // escapesUpward(raw) 决定 file 怎么来\n" +
      real.slice(end + 1);
    expect(guard).not.toBe(real);
    // 前提自证三条：字节【进了】注释、那条【调用】整条没了、而【定义】还在。
    // 第三条是这一发的重点：定义还在 ⇒ 判「文件里有没有 escapesUpward 这几个字」
    // 恒绿；第一条是那条「绿分不出【剥注释生效】与【锚点压根没注上】」的反证。
    // （这里【不能】写 expect(guard).toContain("escapesUpward(raw)") —— 函数定义
    // 本身就带那六个字，那句恒真，写了等于没写。）
    expect(guard).toContain("// escapesUpward(raw)");
    expect(guard).not.toContain("const file = escapesUpward(raw)");
    expect(guard).toContain("function escapesUpward(");
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("parseTscOutput 不再调");
    expect(msg).not.toContain("escapesUpward 的函数体");
  });

  it("变异 r19 之十：语料那一侧退回只判绝对式 ⇒ 红在 parseListFiles 那一格", () => {
    // round300 变异机 M3 的合成版：函数还在、名字还在，只是这一处不调它了。
    const guard = guardWith(
      'if (rel === "" || isOutsideRepo(raw, rel)',
      'if (rel === "" || isStillAbsolute(rel)',
    );
    const msg = checkOne("r19", fakeFiles(r19Good({ [R19_GUARD]: guard })));
    expect(msg).toContain("parseListFiles 不再调");
    // 前两格不许跟着红：三格是【分栏】的，混成一句话就看不出是哪一侧塌了。
    expect(msg).not.toContain("escapesUpward");
    expect(msg).not.toContain("parseTscOutput 不再调");
  });

  /* ── r20：census.ts 那三格 + 两枚 canary 的在场 ────────────────── */
  const R20_SCRIPT = "arch:census.ts";
  const R20_SPEC = "arch:census.test.ts";
  /** r20 判据要的两份文件，默认全给真的（改哪份就覆盖哪份；删键 = 那份不见）。 */
  const r20Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R20_SCRIPT]: realFiles.arch("census.ts"),
    [R20_SPEC]: realFiles.arch("census.test.ts"),
    ...over,
  });
  /** 变异必须真的改到字节：没改到的"变异"只是把原文喂回去，恒绿。 */
  const cut = (text: string, needle: string): string => {
    expect(text.includes(needle)).toBe(true);
    const out = text.replace(needle, "");
    expect(out).not.toBe(text);
    return out;
  };

  it("变异 r20 之一：脚本整份不见 ⇒ 红在「不在了」", () => {
    const without = r20Good();
    delete without[R20_SCRIPT];
    expect(checkOne("r20", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r20 之二：不再从 dead-modules 拿图（自己解析一遍）⇒ 红在恒真判定", () => {
    // ⚠ 第一版这里我打的是【import 列表里的 collectModules 那一行】，实得【绿】——
    //   因为 census() 函数体里还有一句 collectModules(root)，判据读的是【文本在场】，
    //   少一个 import 说明符根本不会让它红。那发"变异"什么都没测到。
    //   真正等价于「换了一份解析器」的写法是换掉那份被 import 的【模块】。
    const script = realFiles
      .arch("census.ts")
      .replace('} from "./dead-modules.js";', '} from "./my-own-parser.js";');
    expect(script).not.toBe(realFiles.arch("census.ts"));
    const msg = checkOne("r20", fakeFiles(r20Good({ [R20_SCRIPT]: script })));
    expect(msg).toContain("dead-modules.js");
  });

  it("⭐ 变异 r20 之三：悬空说明符不再抛 ⇒ 红（坏图上的数看着和好图一样）", () => {
    // 这一格是本判据里最值钱的：census.ts【只测量不判定】，它坏的时候不报错，
    // 照常打印四个数。唯一的静默失效通道就是「图坏了一半而抛没了」。
    const script = cut(realFiles.arch("census.ts"), "if (c.unresolved > 0) {");
    const msg = checkOne("r20", fakeFiles(r20Good({ [R20_SCRIPT]: script })));
    expect(msg).toContain("悬空说明符");
    expect(msg).not.toContain("排除");
  });

  it("变异 r20 之四：排除入口那一格被摘 ⇒ 红在口径没人执行", () => {
    const script = cut(
      realFiles.arch("census.ts"),
      "c.zeroImporter.filter((r) => !r.isEntry)",
    );
    const msg = checkOne("r20", fakeFiles(r20Good({ [R20_SCRIPT]: script })));
    expect(msg).toContain("排除");
    expect(msg).not.toContain("悬空说明符");
  });

  it("变异 r20 之五：测试整份不见 ⇒ 红（上面那三格重新变回散文）", () => {
    const without = r20Good();
    delete without[R20_SPEC];
    expect(checkOne("r20", fakeFiles(without))).toContain("不在了");
  });

  it("⭐ 变异 r20 之六：摘掉【成员】判据 ⇒ 红（解析器退化时名单是膨胀的）", () => {
    const spec = cut(
      realFiles.arch("census.test.ts"),
      'expect(rels.has("db/write-queue.ts")).toBe(false)',
    );
    const msg = checkOne("r20", fakeFiles(r20Good({ [R20_SPEC]: spec })));
    expect(msg).toContain("成员");
    expect(msg).not.toContain("写死");
  });

  it("⭐ 变异 r20 之七：摘掉 unresolved 会自报那发 ⇒ 红（那个 0 分不出真假）", () => {
    const spec = cut(
      realFiles.arch("census.test.ts"),
      "expect(bad.unresolved).toBe(1)",
    );
    const msg = checkOne("r20", fakeFiles(r20Good({ [R20_SPEC]: spec })));
    expect(msg).toContain("写死");
    expect(msg).not.toContain("成员");
  });

  it("r20 控制组：两份原文一字不改 ⇒ 判据返回空（上面每一发的对照组）", () => {
    // 少了这一发，上面七发里任何一发都可能红在【夹具少给一个键】上，
    // 而不是红在我声称要打掉的那一格 —— 那正是 fakeFiles 文件头登记过的形状。
    expect(checkOne("r20", fakeFiles(r20Good()))).toBe("");
  });

  /* ── r21：豁免那份【账】的三枚钉 + 反向 canary 的在场 ─────────────
   * 靶子是 plan-gate-paths 那两份，全部走 fakeFiles 的合成语料：
   * 这一族【不碰盘】—— 碰盘的那台是 .workbuddy/round293-mutate-gate-exemption.mjs，
   * 它改的是真文档字节，必须单独跑（round292 (b) 那条纪律）。两处分工别读反：
   * 那台证的是【plan-gate-paths.test.ts 那 11 发不空转】，这一组证的是
   * 【本条判据的输入一格都不能少】。
   */
  const R21_GUARD = "arch:plan-gate-paths.ts";
  const R21_SPEC = "arch:plan-gate-paths.test.ts";
  const r21Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R21_GUARD]: realFiles.arch("plan-gate-paths.ts"),
    [R21_SPEC]: realFiles.arch("plan-gate-paths.test.ts"),
    ...over,
  });

  it("变异 r21 之一：守卫整份不见 ⇒ 红（那份账退回文件头里的一段话）", () => {
    const without = r21Good();
    delete without[R21_GUARD];
    expect(checkOne("r21", fakeFiles(without))).toContain("不在了");
  });

  it("⭐ 变异 r21 之二：摘掉 exemptedBlocks 的 filter ⇒ 红，且不许红在旁边那句 continue 上", () => {
    // `includes(NOT_BUILT_TAG)` 在守卫里出现【两处】：missingGatePaths 里那句
    // `if (…) continue`，和 exemptedBlocks 的 filter。判据若只读那个片段，
    // 摘掉 filter 它照样绿 —— 与 r20 之二同形（文本在场 ≠ 我打的那一格还在）。
    // 所以这一发必须同时带一条 not.toContain：红话得说明它红在【筛】上。
    const guard = cut(
      realFiles.arch("plan-gate-paths.ts"),
      ".filter((b) => b.text.includes(NOT_BUILT_TAG))",
    );
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_GUARD]: guard })));
    expect(msg).toContain("字节筛");
    expect(msg).not.toContain("恰好 1");
  });

  it("变异 r21 之三：测试整份不见 ⇒ 红（那三枚钉没有执行者）", () => {
    const without = r21Good();
    delete without[R21_SPEC];
    expect(checkOne("r21", fakeFiles(without))).toContain("不在了");
  });

  it("⭐ 变异 r21 之四：把真仓库那个【精确条数】换成上界 ⇒ 红（单向的界挡不住改数量）", () => {
    const spec = realFiles
      .arch("plan-gate-paths.test.ts")
      .replace(
        "expect(exemptedBlocks(blocks)).toEqual([])",
        "expect(exemptedBlocks(blocks).length).toBeLessThanOrEqual(1)",
      );
    expect(spec).not.toBe(realFiles.arch("plan-gate-paths.test.ts"));
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_SPEC]: spec })));
    expect(msg).toContain("条数钉");
    expect(msg).not.toContain("deadExemptions");
  });

  it("变异 r21 之五：deadExemptions 不再是导出的判据 ⇒ 红（判据退回永不执行的循环）", () => {
    // 2026-11-19 那一格的全部理由：豁免账清零后，真仓库那一发遍历的是空名单，
    // 写在测试里的循环体【永不执行】。搬进守卫才有非空语料可喂。
    // 这一发证的是【本判据盯得住这次搬家】：把它搬回测试里，登记表要说出来。
    const guard = realFiles
      .arch("plan-gate-paths.ts")
      .replace("export function deadExemptions(", "function deadExemptions(");
    expect(guard).not.toBe(realFiles.arch("plan-gate-paths.ts"));
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_GUARD]: guard })));
    expect(msg).toContain("deadExemptions");
    expect(msg).not.toContain("条数钉");
  });

  it("⭐ 变异 r21 之六：函数在场而筛法被换成恒假 ⇒ 红（名字不等于判据）", () => {
    // round298 记过这一族：判据读【函数名】而不是读那条表达式，
    // 把函数体换成 `return []` 它照样绿。所以这里抹的是那条筛法本身。
    const guard = cut(
      realFiles.arch("plan-gate-paths.ts"),
      "(e) => e.paths.filter((p) => !exists(p)).length === 0",
    );
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_GUARD]: guard })));
    expect(msg).toContain("筛法");
    expect(msg).not.toContain("导出");
  });

  it("变异 r21 之七：摘掉「死豁免该数出来」那一发 ⇒ 红（非空名单从没被跑过）", () => {
    // 真仓库的名单是空的 ⇒ 判据在真仓库上【一次也没有为非空名单跑过】。
    // 那一发合成语料是它唯一的方向证据；摘掉它，恒返回空的实现与真判据读起来一样。
    const spec = cut(
      realFiles.arch("plan-gate-paths.test.ts"),
      'deadExemptions(acceptanceBlocks(md("test/e2e/dead.spec.ts"))',
    );
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_SPEC]: spec })));
    expect(msg).toContain("非空名单");
    expect(msg).not.toContain("条数钉");
  });

  it("⭐ 变异 r21 之八：摘掉那发数得出 2 的反向 canary ⇒ 红（那个读数分不出真假）", () => {
    // 没有它，一个恒返回「一条」的坏计数器（filter 写成 find / map 前多一个 slice(0,1)）
    // 在 `toBe(1)` 那一发上照样绿。这一发是本判据里唯一防住这一族的。
    const spec = cut(
      realFiles.arch("plan-gate-paths.test.ts"),
      '["test/e2e/two.spec.ts"]',
    );
    const msg = checkOne("r21", fakeFiles(r21Good({ [R21_SPEC]: spec })));
    expect(msg).toContain("反向 canary");
    expect(msg).not.toContain("身份钉");
  });

  it("r21 控制组：两份原文一字不改 ⇒ 判据返回空", () => {
    expect(checkOne("r21", fakeFiles(r21Good()))).toBe("");
  });

  /* ── r22：契约里那条加角色的路还在，且分工没漂 ─────────────────────
   * 这条判据读的是【三份权威落点】，所以合成语料要交出三个键。
   * 它最特别的一格是：有两处判【剥掉注释之后】的字节，所以除了「摘掉真代码」的变异，
   * 还必须有一发【只往注释里加那些字节】⇒ 该绿。少了那一发，
   * 「剥注释」这件事本身有没有生效就没人证过 —— 判据可能一直在读原文而全绿。 */
  const R22_GRAPH = "contracts:org/graph.ts";
  const R22_VALIDATE = "contracts:org/validate.ts";
  const R22_COMMIT = "org/commit.ts";
  /** r22 判据在合成语料下【不红】所需的最小一份好输入。 */
  const r22Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R22_GRAPH]: realFiles.contracts("org/graph.ts"),
    [R22_VALIDATE]: realFiles.contracts("org/validate.ts"),
    [R22_COMMIT]: realFiles.src(R22_COMMIT),
    ...over,
  });

  it("r22 的真仓库那一半：三份取材都读得到那三处字节", () => {
    // 正向对照。这一发红说明【取材坏了】（路径/文件名变了），而不是主张过期 ——
    // 两种红的修法完全不同，所以不能只靠上面那发「每条 check 返回空」兜。
    expect(realFiles.contracts("org/graph.ts")).toContain(
      'kind: z.literal("add_node")',
    );
    expect(realFiles.contracts("org/validate.ts")).toContain(
      "export function validateNewNode(",
    );
    expect(realFiles.src(R22_COMMIT)).toContain(
      "validateNewNode(change.node, graph)",
    );
  });

  it("r22 控制组：三份原文一字不改 ⇒ 判据返回空（剥注释那两格在真语料上不误伤）", () => {
    expect(checkOne("r22", fakeFiles(r22Good()))).toBe("");
  });

  it("变异 r22 之一：契约那份 schema 整份不见 ⇒ 红", () => {
    const without = r22Good();
    delete without[R22_GRAPH];
    // 三份取材的「不在了」各有一句红话：同一句红话覆盖三个文件时，
    // 「谁没了」就得靠猜，而猜错的那一种修法是把主张改口。
    expect(checkOne("r22", fakeFiles(without))).toContain(
      "org/graph.ts 不在了",
    );
  });

  it("⭐ 变异 r22 之二：读不到 orgChangeSchema 那一段 ⇒ 红在【取材】而不是红在「kind 被摘」", () => {
    // 两条红的修法不同：前者是有人改了那个 const 的名字（判据要跟着搬住址），
    // 后者是有人真的撤了那条路（那是一次决定，要回来改主张）。混成一条红话，
    // 下一个人就会去改主张。
    const graph = realFiles
      .contracts("org/graph.ts")
      .replaceAll("export type OrgChange", "export type CompanyChange");
    expect(graph).not.toBe(realFiles.contracts("org/graph.ts"));
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_GRAPH]: graph })));
    expect(msg).toContain("读不到");
    expect(msg).not.toContain("判别式里没有 add_node");
    expect(msg).not.toContain("重新变成一句散文");
  });

  it("变异 r22 之三：判别式里那一支被摘掉 ⇒ 红", () => {
    const graph = realFiles
      .contracts("org/graph.ts")
      .replaceAll(
        'kind: z.literal("add_node")',
        'kind: z.literal("add_person")',
      );
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_GRAPH]: graph })));
    expect(msg).toContain("判别式里没有 add_node");
    expect(msg).not.toContain("读不到");
  });

  it("变异 r22 之四：hub 那份 commit 整份不见 ⇒ 红（形状在、判据在，执行者没了）", () => {
    const without = r22Good();
    delete without[R22_COMMIT];
    expect(checkOne("r22", fakeFiles(without))).toContain("失去了唯一的执行者");
  });

  it("⭐ 变异 r22 之五：调用换成一句同义注释 ⇒ 红（本条唯一为「只剩一条注释」写的形状）", () => {
    const real = realFiles.src(R22_COMMIT);
    const mutated = real.replaceAll(
      "one = validateNewNode(change.node, graph);",
      "// 新节点走 L1，判据在 validateNewNode 里（本轮由注释代劳）",
    );
    expect(mutated).not.toBe(real);
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_COMMIT]: mutated })));
    expect(msg).toContain("不再【调用】validateNewNode");
    expect(msg).not.toContain("失去了唯一的执行者");
    expect(msg).not.toContain("按 role_id 当键");
  });

  it("⭐⭐ 变异 r22 之五·乙：分派条件短路成 false 而调用字节留着 ⇒ 红", () => {
    // 这一发是【变异机器逼出来的】：生产字节上的 M8 把分派写成
    // `else if (false && change.kind === "add_node")` ⇒ 端到端当场红，
    // 而判据【那一版】不红 —— 因为下一格要的那句调用字节【还在文件里】，
    // 只是永远走不到。「调用在」不等于「那条分派活着」。
    // 它与 r20 之二是同一条教训的两个方向：那一发抹的是 import 列表里那一行
    // （函数体里还有同名调用 ⇒ 绿），这一发留的是调用而抹条件（⇒ 曾经也绿）。
    const real = realFiles.src(R22_COMMIT);
    const mutated = real.replaceAll(
      '} else if (change.kind === "add_node") {',
      '} else if (false && change.kind === "add_node") {',
    );
    expect(mutated).not.toBe(real);
    // 前提自证：变异之后那句调用【确实还在】，否则这一发测的只是上一发。
    expect(mutated).toContain("validateNewNode(change.node, graph)");
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_COMMIT]: mutated })));
    expect(msg).toContain("分派条件");
    expect(msg).not.toContain("不再【调用】validateNewNode");
  });

  it("变异 r22 之六：applyChangeToGraph 收下节点而不写进 nodes ⇒ 红（审计与库里两张图）", () => {
    const real = realFiles.src(R22_COMMIT);
    const mutated = real.replaceAll(
      "nodes[change.node.role_id] = change.node;",
      "void change.node;",
    );
    expect(mutated).not.toBe(real);
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_COMMIT]: mutated })));
    expect(msg).toContain("按 role_id 当键");
    expect(msg).not.toContain("不再【调用】validateNewNode");
  });

  it("变异 r22 之七：类型兜底换成默认放行 ⇒ 红", () => {
    const real = realFiles.src(R22_COMMIT);
    const mutated = real.replaceAll(
      "function noUntouchedKind(change: never): never {",
      "function noUntouchedKind(change: unknown): { ok: true } {",
    );
    expect(mutated).not.toBe(real);
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_COMMIT]: mutated })));
    expect(msg).toContain("默认放行");
    expect(msg).not.toContain("按 role_id 当键");
  });

  it("⭐ 变异 r22 之八：往 validateNewNode 的【代码】里加一句判家族 ⇒ 红（两处口径会漂）", () => {
    const real = realFiles.contracts("org/validate.ts");
    // 锚点选 `const roleId = node.role_id;` 而不是 `const malformed = rejectMalformed(org);`：
    // 后者在那份文件里有【三处】（每个判据函数开头一句），`.replace` 只换第一处 ⇒
    // 变异会落在【别的函数】里，而判据读的只是 validateNewNode 那一段 ⇒ 得手一个绿，
    // 红因却是"变异打偏"。这一格踩的就是「抹字节抹错了地方」那一族，先在这里钉住。
    const mutated = real.replace(
      "  const roleId = node.role_id;",
      "  const roleId = node.role_id;\n" +
        '  if (node.model_family === undefined) return reject("unknown_model_family", "x");',
    );
    expect(mutated).not.toBe(real);
    expect(
      mutated.indexOf('reject("unknown_model_family", "x")') >
        real.indexOf("export function validateNewNode("),
      "变异必须落在 validateNewNode 那一段里，否则这一发测的是别的函数",
    ).toBe(true);
    const msg = checkOne(
      "r22",
      fakeFiles(r22Good({ [R22_VALIDATE]: mutated })),
    );
    expect(msg).toContain("两处口径");
    expect(msg).not.toContain("读不到 `validateNewNode`");
  });

  it("⭐ 变异 r22 之九（反向对照）：【函数体内】一句行注释带上那些字节 ⇒ 该绿", () => {
    // 这一发守的是【剥注释本身生效】。少了它，判据可能一直在读原文而全绿：
    // 反过来若有人把「剥注释」写成原样返回，上一发（之八）照样红，而注释里
    // 那些字节的恒红会被人当成「判据太敏感」删掉。
    // ⚠ 字节必须注在【函数体里】。第一版我把它们注在函数头之前 —— 而 sliceFrom
    // 是从锚点起取的，那一段【根本进不了语料】，于是这一发与下一发都是空转的绿
    // （空转的反向对照比没有反向对照更坏：它让「两个分支都有人钉」这句话失真）。
    // 位置自证因此是这一族的标配，不是装饰。
    const real = realFiles.contracts("org/validate.ts");
    const mutated = real.replace(
      "  const roleId = node.role_id;",
      "  // 备忘：这里将来可能会判 model_family（今天【故意】不判，判在那一处）\n" +
        "  const roleId = node.role_id;",
    );
    expect(mutated).not.toBe(real);
    expect(
      mutated.indexOf("备忘：这里将来可能会判") >
        mutated.indexOf("export function validateNewNode("),
      "注入的注释必须落在判据真正会读的那一段里",
    ).toBe(true);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: mutated }))),
    ).toBe("");
  });

  it("⭐ 变异 r22 之十（反向对照）：函数体内【干净的】块注释也不算代码 ⇒ 该绿", () => {
    // 之九只证了【行注释】那一路。块注释走的是另一个正则、另一个分支，
    // 「注释不算代码」这句话有两种实现，就得有两发钉。
    // 「干净的」= 注释里不含 `//` —— 含 `//` 的形状走之十·乙（那是个洞，不是绿）。
    const real = realFiles.contracts("org/validate.ts");
    const mutated = real.replace(
      "  const roleId = node.role_id;",
      "  /* 备忘：model_family 判在那一处，这里不判，也不走别的判据 */\n" +
        "  const roleId = node.role_id;",
    );
    expect(mutated).not.toBe(real);
    expect(
      mutated.indexOf("/* 备忘：model_family") >
        mutated.indexOf("export function validateNewNode("),
      "同上：块注释必须在切片内，否则这一发测的是空气",
    ).toBe(true);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: mutated }))),
    ).toBe("");
  });

  it("⭐⭐ 变异 r22 之九·乙：登记洞① —— 字符串里的 // 吃掉同一行的真判据 ⇒ 假绿", () => {
    // 这一发【绿得不对】，而它绿的形状正是 withoutComments 的洞①本身：
    // 同一行里 `"https://…"` 在先，真正的 model_family 判据在后 ⇒ 剥注释把
    // 那一行的后半截连同【真代码】一起吃掉 ⇒ 判据读不到那一句 ⇒ 返回空。
    // 判【家族】那格的假绿是全判据唯一朝「放行坏改动」方向的洞，必须有一发
    // 能重跑的证据。它和上面几发的区别：上面钉的是「判据对」，这一发钉的是
    // 「已知它在这一个形状上不对」—— 同「schema 不判键≠role_id」那发登记一个口径。
    // 若有人重写剥注释（带字符串感知），这一发会【变红】⇒ 回来把登记撤掉、删这一发。
    const real = realFiles.contracts("org/validate.ts");
    const mutated = real.replace(
      "  const roleId = node.role_id;",
      '  const specUrl = "https://spec"; if (node.model_family === undefined) ' +
        'return reject("unknown_model_family", "x");\n' +
        "  const roleId = node.role_id;",
    );
    expect(mutated).not.toBe(real);
    expect(
      mutated.indexOf('reject("unknown_model_family"') >
        mutated.indexOf("export function validateNewNode("),
      "变异必须落在切片内：否则这一发测的是【洞没被喂到】，不是洞",
    ).toBe(true);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: mutated }))),
    ).toBe("");

    // 单变量对照：把那句【带 // 的字符串】拿掉，同一行真判据原样留着 ⇒ 必须红。
    // 与上面那个绿并排 ⇒ 假绿的原因就是那两个斜杠，而不是"注入没进切片"。
    // 没有这一发，"绿"分不出【洞】与【空转】—— 那正是本轮反复抓的那族。
    const noUrl = real.replace(
      "  const roleId = node.role_id;",
      '  if (node.model_family === undefined) return reject("unknown_model_family", "x");\n' +
        "  const roleId = node.role_id;",
    );
    expect(noUrl).not.toBe(mutated);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: noUrl }))),
    ).toContain("两处口径");
  });

  it("⭐⭐ 变异 r22 之十·乙：登记洞② 的实测方向 —— 块注释收尾被 // 吃掉 ⇒ 连坐吞码 ⇒ 假绿（不是原猜的假红）", () => {
    // withoutComments 的函数头原本把洞②的方向写成【假红】（块没被剥 ⇒ 注释字节留下）。
    // 这一发实测下来那个方向【猜错了】，而且错向更坏的一边：
    // 收尾的 `*/` 被行注释刀吃掉之后，懒匹配 ( [\s\S]*? ) 不会停在原地 ——
    // 它一路吞到【下一个真 `*/`】。今天 validateNewNode 的切片里就有下一个 `*/`
    // （heightBelow 的 JSDoc 收尾，它在「下一个 export function」之前），
    // 于是从坏块起到那一带的【全部字节】被连坐吞掉，包括紧跟着的真判据 ⇒ 假绿。
    // 「假红」只是一次吵闹的错；「假绿 + 连坐吞码」能让真判据隐身。方向必须按量出来的写。
    // 今天两份真语料都没有这种字节（这正是它没咬人的原因），登记它是因为它【能】咬。
    const real = realFiles.contracts("org/validate.ts");
    const mutated = real.replace(
      "  const roleId = node.role_id;",
      "  /* 备忘 https://example.com 的说明 */\n" +
        '  if (node.model_family === undefined) return reject("unknown_model_family", "x");\n' +
        "  const roleId = node.role_id;",
    );
    expect(mutated).not.toBe(real);
    expect(
      mutated.indexOf('reject("unknown_model_family"') >
        mutated.indexOf("export function validateNewNode("),
      "同上：连坐吞码要成立，判据字节必须先进了切片",
    ).toBe(true);
    // 前提的另一半：吞到这里为止的那个 `*/` 确实在切片里（不在的话方向就不是连坐）。
    expect(
      real
        .slice(real.indexOf("export function validateNewNode("))
        .includes("*/"),
      "切片里必须存在下一个块注释收尾，否则这一发证的是【假红】那一支",
    ).toBe(true);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: mutated }))),
    ).toBe("");

    // ⭐ 单变量对照（这一发的牙齿，也是「这个绿是洞造成的」而非空转的证据）：
    // 同样的自身一行真判据、同样的块注释，唯一差别是把块里的 `//` 拿掉。
    // 没有 `//` ⇒ 块被正确剥掉 ⇒ 那行 model_family 留在代码里 ⇒ 必须【红】。
    // 与上面那个【绿】并排 ⇒ `//` 是假绿的唯一原因，且判据确实在读那一段。
    // 少了这一发，"returns 空" 既可能是洞、也可能是注入根本没进切片（空转），
    // 而这两种在该断言下长得一模一样 —— 那正是本轮反复抓的那族。
    const noSlash = real.replace(
      "  const roleId = node.role_id;",
      "  /* 备忘 example.com 的说明 */\n" +
        '  if (node.model_family === undefined) return reject("unknown_model_family", "x");\n' +
        "  const roleId = node.role_id;",
    );
    expect(noSlash).not.toBe(mutated);
    expect(
      checkOne("r22", fakeFiles(r22Good({ [R22_VALIDATE]: noSlash }))),
    ).toContain("两处口径");
  });

  it("变异 r22 之十一：摘掉对 after 图那一跑 ⇒ 红（分工变成漏判）", () => {
    const real = realFiles.src(R22_COMMIT);
    const mutated = real.replaceAll(
      "const families = everyNodeDeclaresModelFamily(after);",
      "const families: { ok: true } = { ok: true };",
    );
    expect(mutated).not.toBe(real);
    const msg = checkOne("r22", fakeFiles(r22Good({ [R22_COMMIT]: mutated })));
    expect(msg).toContain("从一次【分工】变成一次【漏判】");
    expect(msg).not.toContain("两处口径");
  });

  it("变异 r22 之十二：validate.ts 整份不见 ⇒ 红（②那根线连向一个不存在的目标）", () => {
    const without = r22Good();
    delete without[R22_VALIDATE];
    expect(checkOne("r22", fakeFiles(without))).toContain("重新变成一句散文");
  });

  it("⭐ 变异 r22 之十三：定义整段改名 ⇒ 红在【取材】而不是红在「判了家族」", () => {
    const real = realFiles.contracts("org/validate.ts");
    const mutated = real.replace(
      "export function validateNewNode(",
      "export function checkNewNode(",
    );
    expect(mutated).not.toBe(real);
    const msg = checkOne(
      "r22",
      fakeFiles(r22Good({ [R22_VALIDATE]: mutated })),
    );
    expect(msg).toContain("读不到 `validateNewNode` 的定义");
    expect(msg).not.toContain("两处口径");
  });
});

/* ── r23（round298）：那条整图门控自检的【结构】还在 ───────────────────
 * 取材只有一份文件（db/integrity.ts），所以这里的变异全是【同一份字节的局部改动】。
 * 家规照 r20/r21/r22：每一发都带一条 not.toContain，把"红在别的格"排除掉 ——
 * 一份判据里八格串联，只判 toContain("不在了") 会把「取材坏」与「主张过期」读成同一句话。 */
describe("主张登记表：变异 r23（整图委派边门控自检）", () => {
  const R23 = "db/integrity.ts";
  /** r23 判据在合成语料下【不红】所需的最小一份好输入 = 真字节原文。 */
  const r23Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R23]: realFiles.src(R23),
    ...over,
  });
  /** 换掉一段字节，并【先证明那段在】—— 锚点写错会变成空变异而测试"通过"。 */
  const swap = (text: string, from: string, to: string): string => {
    expect(text.includes(from)).toBe(true);
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };

  it("r23 的真仓库那一半：取材读得到那几处字节（红=取材坏了，不是主张过期）", () => {
    const t = realFiles.src(R23);
    expect(t).toContain('"delegation_edges_gated"');
    expect(t).toContain('guarded("delegation_edges_gated"');
    expect(t).toContain("function delegationEdgeGateCheck(");
    expect(t).toContain("FROM delegation_graphs ORDER BY version");
  });

  it("r23 控制组：原文一字不改 ⇒ 判据返回空（剥注释那几格在真语料上不误伤）", () => {
    expect(checkOne("r23", fakeFiles(r23Good()))).toBe("");
  });

  it("变异 r23 之一：integrity.ts 整份不见 ⇒ 红在「不在了」", () => {
    const without = r23Good();
    delete without[R23];
    expect(checkOne("r23", fakeFiles(without))).toContain("不在了");
  });

  it("变异 r23 之二：读不到 CHECK_NAMES 那一段 ⇒ 红在【取材】而不是红在「名字被摘」", () => {
    const mutated = swap(
      realFiles.src(R23),
      "export const CHECK_NAMES = [",
      "const RENAMED_NAMES = [",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("读不到 CHECK_NAMES 那一段");
    expect(msg).not.toContain("先问是谁把那一格撤了");
  });

  it("变异 r23 之三：名单里摘掉那一格 ⇒ 红（报告不再声明它）", () => {
    const mutated = swap(
      realFiles.src(R23),
      '  "delegation_edges_gated",\n',
      "",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("CHECK_NAMES 里没有 delegation_edges_gated");
    expect(msg).not.toContain("不再跑它");
  });

  it("⭐ 变异 r23 之四：名单留着而 guarded 那行被摘 ⇒ 红（恒绿的自检比没有更坏）", () => {
    // 与上一发【分开报】：那一发补名单，这一发补注册；而且这一发的假绿形状不同 ——
    // 报告里那一格不再出现，读报告的人看见的是"其余全 ok"。
    const mutated = swap(
      realFiles.src(R23),
      '    guarded("delegation_edges_gated", () => delegationEdgeGateCheck(o.db)),\n',
      "",
    );
    // 前提自证：摘掉注册之后，名字【还】在名单里 —— 少了这两行就分不清红在哪一格。
    expect(mutated).toContain('"delegation_edges_gated"');
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("还在名单里");
    expect(msg).not.toContain("先问是谁把那一格撤了");
  });

  it("变异 r23 之五：读不到函数定义 ⇒ 红在【注册连向不存在的东西】", () => {
    const mutated = swap(
      realFiles.src(R23),
      "function delegationEdgeGateCheck(",
      "function renamedEdgeCheck(",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("读不到 delegationEdgeGateCheck 的定义");
    expect(msg).not.toContain("MAX(version)");
  });

  it("⭐ 变异 r23 之六：SQL 退回只扫最新版 ⇒ 红（M2 那一发的登记形态）", () => {
    const mutated = swap(
      realFiles.src(R23),
      '"FROM delegation_graphs ORDER BY version",',
      '"FROM delegation_graphs " +\n        "WHERE version = (SELECT MAX(version) FROM delegation_graphs) ",',
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("不再是「扫全部版本」");
    expect(msg).not.toContain("review_gate");
  });

  it("⭐ 变异 r23 之七：门控判成「有没有填」⇒ 红（M1 那一发：false 是填了的值）", () => {
    const mutated = swap(
      realFiles.src(R23),
      "e.review_gate !== true",
      "e.review_gate == null",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("填没填");
    expect(msg).not.toContain("orgGraphSchema");
  });

  it("⭐ 变异 r23 之八：撤掉 orgGraphSchema 那道 ⇒ 红（M3：退回信强转）", () => {
    const mutated = swap(
      realFiles.src(R23),
      "const parsed = orgGraphSchema.safeParse(raw);",
      "const parsed = { success: true as const, data: raw as never };",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("不再过 orgGraphSchema");
    expect(msg).not.toContain("review_gate !== true");
  });

  it("变异 r23 之九：空表那格短路成 false ⇒ 红（空不是通过）", () => {
    const mutated = swap(
      realFiles.src(R23),
      "  if (edges === 0) {",
      "  if (false) {",
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("不再单独成栏");
    expect(msg).not.toContain("MAX(version)");
  });

  it("⭐ 变异 r23 之十：假句子【写进代码】⇒ 红（M5 同一格的登记形态）", () => {
    const mutated = swap(
      realFiles.src(R23),
      '"delegation_graphs 是空的 —— 这一份库还没提交过任何一版组织图，" +',
      '"delegation_graphs 是空的。src 里【没有任何 INSERT INTO delegation_graphs】" +',
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("那句是【假的】");
    expect(msg).not.toContain("不再指名写入方");
  });

  it("⭐⭐ 变异 r23 之十·乙（反向对照）：同一句假话【只写在注释里】⇒ 该绿", () => {
    /*
     * ④ 那一格判【剥掉注释之后】的字节，方向是有意选的：下一个人很可能把那句假话
     * 当【反面教材】写进注释（本仓到处就是这么干的）。判原文会因为一句诚实的注释而
     * 【假红】；判代码则注释豁免、字符串字面量（=真文案）照样定罪。
     * 这一发是那一格唯一的方向证据 —— 少了它，"剥注释"在 ④ 上有没有生效没人证过。
     */
    // 注在【函数头之前的一行行注释】里：④ 读的是剥掉注释之后的字节，
    // 所以这一句既进了语料（下一行自证）、又不该被 ④ 定罪。
    const anchor =
      "function delegationEdgeGateCheck(db: DatabaseSync): CheckResult {";
    const mutated = swap(
      realFiles.src(R23),
      anchor,
      "// 别把这句话写回文案：「src 里没有任何 INSERT INTO delegation_graphs」是假的。\n" +
        anchor,
    );
    // 前提自证：那句确实【进了字节】而【在函数头之前】，否则这一发是空转。
    expect(mutated).toContain("没有任何 INSERT INTO delegation_graphs");
    expect(mutated.indexOf("没有任何 INSERT")).toBeLessThan(
      mutated.indexOf(anchor),
    );
    expect(checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })))).toBe("");
  });

  it("变异 r23 之十一：空表文案不再指名写入方 ⇒ 红（假句子的形状就是这么回来的）", () => {
    const mutated = swap(
      realFiles.src(R23),
      '"INSERT_DELEGATION_GRAPH_SQL（生产路径经 commitOrgGraph）。",',
      '"（谁写得进来这里，本条不判）。",',
    );
    const msg = checkOne("r23", fakeFiles(r23Good({ [R23]: mutated })));
    expect(msg).toContain("不再指名写入方");
    expect(msg).not.toContain("那句是【假的】");
  });
});

/* ── r24（round299）：「节点键 === node.role_id」今天【由 schema 判】───────
 * 判据读三份落点：org/graph.ts 的那一段（权威）+ api.ts 与 org/commit.ts（前提）。
 * 家规照 r20–r23：每一发变异带 not.toContain 排除别的红因；【整份不见】各有一发，
 * 因为 fakeFiles 的缺键是【抛】——判据没包 try 时它会红成一句和「文件没了」逐字
 * 一样的话（r23 踩过，那边把这条纪律写进了 fakeFiles 的注释）。
 * 两枚反向对照走 r22 之九·乙的剧本：同一份字节【在注释里】该绿、【在代码里】该红 ——
 * 那一对是 withoutComments 在这一族上【方向】的唯一证据（只留绿的那发是空转）。 */
describe("主张登记表：变异 r24（节点键与 role_id 的 schema 判据）", () => {
  const R24_GRAPH = "contracts:org/graph.ts";
  const R24_API = "contracts:api.ts";
  const R24_COMMIT = "org/commit.ts";
  /** r24 判据在合成语料下【不红】所需的最小一份好输入 = 真字节原文。 */
  const r24Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R24_GRAPH]: realFiles.contracts("org/graph.ts"),
    [R24_API]: realFiles.contracts("api.ts"),
    [R24_COMMIT]: realFiles.src("org/commit.ts"),
    ...over,
  });
  /** 换掉一段字节，并【先证明那段在】—— 锚点写错会变成空变异而测试"通过"。 */
  const swap = (text: string, from: string, to: string): string => {
    expect(text.includes(from)).toBe(true);
    const out = text.replace(from, to);
    expect(out).not.toBe(text);
    return out;
  };
  /** superRefine 那一段的原文（从函数头到段尾），供「摘掉它」的几发整段替换。 */
  const superRefineBlock = (): string => {
    const t = realFiles.contracts("org/graph.ts");
    const a = t.indexOf("  .superRefine((graph, ctx) => {");
    expect(a).toBeGreaterThan(-1);
    const b = t.indexOf("export type OrgGraph", a);
    expect(b).toBeGreaterThan(a);
    return t.slice(a, b);
  };

  it("r24 的真仓库那一半：三处取材都读得到那几行字节（红=取材坏了）", () => {
    expect(realFiles.contracts("org/graph.ts")).toContain(".superRefine(");
    expect(realFiles.contracts("org/graph.ts")).toContain(
      "Object.entries(graph.nodes)",
    );
    expect(realFiles.contracts("api.ts")).toContain("graph: orgGraphSchema");
    expect(realFiles.src("org/commit.ts")).toContain(
      "INSERT_DELEGATION_GRAPH_SQL",
    );
  });

  it("r24 控制组：三份原文一字不改 ⇒ 判据返回空（剥注释那几格在真语料上不误伤）", () => {
    expect(checkOne("r24", fakeFiles(r24Good()))).toBe("");
  });

  it("变异 r24 之一：graph.ts 整份不见 ⇒ 红在【不在了】而不是红在「superRefine 没了」", () => {
    const without = r24Good();
    delete without[R24_GRAPH];
    const msg = checkOne("r24", fakeFiles(without));
    expect(msg).toContain("org/graph.ts 不在了");
    expect(msg).not.toContain("上不再有 superRefine");
  });

  it("变异 r24 之二：定义整段改名 ⇒ 红在【取材】而不是红在「判据被摘」", () => {
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      "export const orgGraphSchema = z",
      "export const orgGraphSchemaV2 = z",
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("读不到 orgGraphSchema 那一段");
    expect(msg).not.toContain("上不再有 superRefine");
  });

  it("变异 r24 之三：整条 superRefine 摘掉 ⇒ 红（主张本体没了）", () => {
    const mutated = realFiles
      .contracts("org/graph.ts")
      .replace(superRefineBlock(), "\n");
    expect(mutated).not.toContain(".superRefine(");
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("上不再有 superRefine");
    expect(msg).not.toContain("遍历的【不再是 nodes】");
  });

  it("⭐ 变异 r24 之四：摘掉后【留成块注释】⇒ 照样红（注释字节不许替「判了」投票）", () => {
    // 没有这一发，「判剥注释后的字节」在①上从没被验过：判据若退化成判原文，
    // 一份被摘掉却留了遗言的判据会在登记表里继续绿着 —— 正是本仓治过的那一族。
    const block = superRefineBlock();
    const wrapped =
      "  /* 摘掉过，留原文当反面教材：\n" +
      block
        .split("\n")
        .map((l) => "   *" + l)
        .join("\n") +
      "\n   */\n";
    const mutated = realFiles.contracts("org/graph.ts").replace(block, wrapped);
    // 前提自证：字节【进了语料】且被注释包着 —— 否则这一发是空转变异。
    expect(mutated).toContain(".superRefine(");
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("上不再有 superRefine");
  });

  it("变异 r24 之五（M3）：遍历对象从 nodes 换成 edges ⇒ 红（判据存在≠判的是这件事）", () => {
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      "Object.entries(graph.nodes)",
      "Object.entries(graph.edges)",
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("遍历的【不再是 nodes】");
    expect(msg).not.toContain("上不再有 superRefine");
    expect(msg).not.toContain("这个方向");
  });

  it("⭐ 变异 r24 之六（M1）：比较方向翻成 !== ⇒ 红（最像「修好了」的坏法）", () => {
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      "if (node.role_id === key) continue;",
      "if (node.role_id !== key) continue;",
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("这个方向");
    expect(msg).not.toContain("遍历的【不再是 nodes】");
    expect(msg).not.toContain("break/return");
  });

  it("变异 r24 之七（M5）：path 塌成一层 ⇒ 红（拒对了但说不出是哪一个键）", () => {
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      'path: ["nodes", key, "role_id"],',
      'path: ["nodes"],',
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("不再把 issue 的 path 指到");
    expect(msg).not.toContain("这个方向");
  });

  it("变异 r24 之八：加 break ⇒ 红（多坏键只报第一个）", () => {
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      "      ctx.addIssue({",
      "      if (reported >= 1) break;\n      ctx.addIssue({",
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("break/return");
    expect(msg).not.toContain("不再把 issue 的 path 指到");
  });

  it("⭐ 变异 r24 之九（反向对照）：那些锚点字节【只写在行注释里】⇒ 该绿", () => {
    const anchor =
      "    for (const [key, node] of Object.entries(graph.nodes)) {";
    const payload =
      "    // 曾经的错法存档：.superRefine( 曾遍历 graph.edges 还带 break;\n";
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      anchor,
      payload + anchor,
    );
    // 前提自证：注入【进了语料】且【在切片内】，且锚点字节真的多了一份 ——
    // 少任何一行自证，这一发就可能在测一个不存在的注入（空转绿）。
    expect(mutated.split(".superRefine(").length - 1).toBe(2);
    expect(mutated).toContain("break;");
    expect(checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })))).toBe(
      "",
    );
  });

  it("⭐ 变异 r24 之十（之九的单变量对照）：同一批字节【进了代码】⇒ 该红", () => {
    // 与上一发只差 `// ` 前缀：绿红各归其位才钉住「剥注释」的方向。
    // 若剥注释整个坏掉 ⇒ 之九转红（被上一发抓）；若剥过头把代码也剥掉 ⇒ 这一发红转绿。
    const anchor =
      "    for (const [key, node] of Object.entries(graph.nodes)) {";
    const mutated = swap(
      realFiles.contracts("org/graph.ts"),
      anchor,
      "    if (reported >= 1) break; // 曾遍历 graph.edges\n" + anchor,
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_GRAPH]: mutated })));
    expect(msg).toContain("break/return");
  });

  it("变异 r24 之十一：api.ts 整份不见 ⇒ 红在前提格（schema 那三格照样绿的形状）", () => {
    const without = r24Good();
    delete without[R24_API];
    const msg = checkOne("r24", fakeFiles(without));
    expect(msg).toContain("api.ts 不在了");
    expect(msg).not.toContain("上不再有 superRefine");
  });

  it("变异 r24 之十二：api.ts 的请求体内联一份自己的图形状 ⇒ 红（这条路上不用它了）", () => {
    const mutated = swap(
      realFiles.contracts("api.ts"),
      "graph: orgGraphSchema",
      "graph: z.record(z.string(), z.unknown())",
    );
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_API]: mutated })));
    expect(msg).toContain("不再直接挂 orgGraphSchema");
    // ⚠ 这一发的形状值得看清：schema 那三格在它下面【全绿】——红只来自前提格。
    expect(msg).not.toContain("上不再有 superRefine");
    expect(msg).not.toContain("遍历的【不再是 nodes】");
    expect(msg).not.toContain("这个方向");
  });

  it("⭐ 变异 r24 之十二·乙（反向对照）：接线断了但【注释里留着那句话】⇒ 照样红", () => {
    /*
     * 前提格判【剥掉注释之后】的字节，方向选得比 schema 那几格更实用：这一格找的是
     * 「api 的 graph 字段还挂着这份 schema」，而下一版本极可能有人写一句诚实的注释
     * （「这里改成内联形状了，原本用 orgGraphSchema」）。判原文的话那句注释会替一条
     * 已经断掉的接线投一票 —— 这是「手抄的那份会在真那份改动后继续绿着」的又一形状。
     * 与上一发只差那三行注释：两发红绿各归其位，才是「剥注释」在前提格上生效的证据。
     */
    const broken = swap(
      realFiles.contracts("api.ts"),
      "graph: orgGraphSchema",
      "graph: z.record(z.string(), z.unknown())",
    );
    const mutated = swap(
      broken,
      "  graph: z.record(z.string(), z.unknown()),",
      "  // 这里以前写的是 graph: orgGraphSchema，改成内联是为了前端草稿态\n" +
        "  graph: z.record(z.string(), z.unknown()),",
    );
    // 前提自证：那句话【进了语料】—— 少了这一行，这一发可能在测一个不存在的注入。
    expect(mutated).toContain("graph: orgGraphSchema");
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_API]: mutated })));
    expect(msg).toContain("不再直接挂 orgGraphSchema");
  });

  it("变异 r24 之十三：commit.ts 整份不见 ⇒ 红在前提格", () => {
    const without = r24Good();
    delete without[R24_COMMIT];
    const msg = checkOne("r24", fakeFiles(without));
    expect(msg).toContain("org/commit.ts 不在了");
    expect(msg).not.toContain("org/graph.ts 不在了");
  });

  it("变异 r24 之十四：commit.ts 把那条 SQL 改名 ⇒ 红（「进不了库」那句的前提漂了）", () => {
    const mutated = realFiles
      .src("org/commit.ts")
      .split("INSERT_DELEGATION_GRAPH_SQL")
      .join("WRITE_GRAPH_ROW_SQL");
    expect(mutated).not.toContain("INSERT_DELEGATION_GRAPH_SQL");
    const msg = checkOne("r24", fakeFiles(r24Good({ [R24_COMMIT]: mutated })));
    expect(msg).toContain("不再出现 INSERT_DELEGATION_GRAPH_SQL");
    expect(msg).not.toContain("不在了");
  });
});

describe("主张登记表：变异 r25（预算上限那一侧读列，round360）", () => {
  /* 判据只读一份文件，所以夹具只有一个键。⚠ 纪律同 r1/r22 那两段：每一发都必须经
   * r25Good() 交出这个键 —— 判据把读它包在 try 里，缺键抛的错误会被那个 catch 收成
   * 「那份文件不在了」，于是「门没了」与「夹具少给一个键」在断言上逐字一样。
   * 真字节一律从真仓库取，不在这里抄一份谓词形状（抄的那份会在生产改动后继续绿着）。
   */
  const R25_PUMP = "serve/charter-pump.ts";
  const r25Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    [R25_PUMP]: realFiles.src(R25_PUMP),
    ...over,
  });

  /** 把分母退回【裸参数】（列不再参与），E2 的尾巴与那唯一一条 `?` 都原样留着。 */
  const backToParam = (src: string): string =>
    src.replace(
      /"COALESCE\(\(SELECT b\.limit_cents FROM budgets b " \+\s*\n\s*"WHERE b\.scope_type = 'task' AND b\.scope_id = " \+\s*\n\s*t \+\s*\n\s*"\.id AND b\.period = 'per_task'\), \?\)"/u,
      '"?"',
    );

  it("变异 r25 之一：控制组该绿，而分母退回裸 `?` ⇒ 红在 E1 且不许红在别的格上", () => {
    const f = fakeFiles(r25Good());
    expect(checkOne("r25", f)).toBe(""); // 真仓库字节原样 ⇒ 空
    const mutated = backToParam(realFiles.src(R25_PUMP));
    // 前提自证：变异真抹掉了那串字节，而【尾巴与绑参没动】——
    // 少了这两行，「红在 E1」分不出是抹对了还是顺带把另两格也打坏了。
    expect(mutated).not.toContain("SELECT b.limit_cents FROM budgets b");
    expect(mutated).toContain(", 0) < ");
    const msg = checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: mutated })));
    expect(msg).toContain("limit_cents");
    expect(msg).toContain("分母");
    // 红因串扰排除：这一发测的是 E1。
    expect(msg).not.toContain("尾巴");
    expect(msg).not.toContain("切不出");
  });

  it("⭐ 变异 r25 之二：抹掉代码而只留一句「这里以前读列」的注释 ⇒ 仍红", () => {
    // 这一发是 E1 那一格的【方向证据】：判【原文】的实现在这一发上会绿，
    // 因为那串字节确实在文件里（只是出现在注释里）。两种读法只在这一发上分得出。
    const base = realFiles.src(R25_PUMP);
    const anchor = base.indexOf("export function underTaskBudgetSql");
    const at = base.indexOf("SELECT b.limit_cents FROM budgets b");
    expect(at).toBeGreaterThan(-1);
    expect(anchor).toBeLessThan(at); // 注在函数头之前的话切段取不到，那一发会恒绿空转
    const withNote =
      "/* 历史：这里以前读 COALESCE((SELECT b.limit_cents FROM budgets b 那句 */\n" +
      backToParam(base);
    expect(
      checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: withNote }))),
    ).toContain("不再 SELECT");
    // 而只【加一句注释】、代码一字不动 ⇒ 该绿（判据对无关文案不敏感）。
    expect(
      checkOne(
        "r25",
        fakeFiles(
          r25Good({
            [R25_PUMP]: "/* 这里解释过为什么上限读列而不读参数 */\n" + base,
          }),
        ),
      ),
    ).toBe("");
  });

  it("变异 r25 之三：比较方向翻成 >= ⇒ 红在 E2（E1 那格会被留在原地的 limit_cents 喂绿）", () => {
    const base = realFiles.src(R25_PUMP);
    const mutated = base.replace(", 0) < ", ", 0) >= ");
    expect(mutated).not.toBe(base);
    expect(mutated).toContain("SELECT b.limit_cents FROM budgets b"); // E1 照样满足
    const msg = checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: mutated })));
    expect(msg).toContain("尾巴");
    expect(msg).not.toContain("不再 SELECT");
  });

  it("变异 r25 之四：多绑一条 `?` ⇒ 红在 E3（五条 SQL 共用的绑参顺序是契约）", () => {
    const base = realFiles.src(R25_PUMP);
    const mutated = base.replace("'per_task'), ?)", "'per_task', ?), ?)");
    expect(mutated).not.toBe(base);
    const msg = checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: mutated })));
    expect(msg).toContain("2 个 `?`");
    expect(msg).not.toContain("尾巴");
  });

  it("变异 r25 之五：回落槽没了（0 个 `?`）⇒ 同样红在 E3", () => {
    // 与上一发同格、反方向：那一发证「多一个」红，这一发证「少一个」红。
    // 只登记一半的话，实现写成 `binds < 1` 或 `binds > 1` 都能过剩下的那一半。
    const base = realFiles.src(R25_PUMP);
    const mutated = base.replace("per_task'), ?)", "per_task'), 0)");
    expect(mutated).not.toBe(base);
    const msg = checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: mutated })));
    expect(msg).toContain("0 个 `?`");
    expect(msg).not.toContain("尾巴");
  });

  it("变异 r25 之六：函数改名 ⇒ 红在「切不出那一段」，而不是退回全文继续绿", () => {
    const base = realFiles.src(R25_PUMP);
    const mutated = base.split("underTaskBudgetSql").join("budgetGateSql");
    expect(mutated).not.toContain("underTaskBudgetSql");
    const msg = checkOne("r25", fakeFiles(r25Good({ [R25_PUMP]: mutated })));
    expect(msg).toContain("切不出");
    // 取材失败不许伪装成「判过了」：那一段全文另有几十条 SQL 的绑定参数，
    // 退回全文搜的话 E3 恒成立 —— 这一发钉的就是「宁可响一声」。
    expect(msg).not.toContain("个 `?`");
  });

  it("变异 r25 之七：那份文件整份不见 ⇒ 红在「不在了」而不是恒绿", () => {
    const without = r25Good();
    delete without[R25_PUMP];
    const msg = checkOne("r25", fakeFiles(without));
    expect(msg).toContain("charter-pump.ts 不在了");
    expect(msg).not.toContain("切不出");
  });

  // r26：真人席执行器已接进生产装配与 CoS 派发；判据认三处真实接线。
  const r26Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    "executors/production.ts": realFiles.src("executors/production.ts"),
    "dispatch/service.ts": realFiles.src("dispatch/service.ts"),
    "http/social.ts": realFiles.src("http/social.ts"),
    ...over,
  });

  it("变异 r26：生产装配摘掉 HumanExecutor ⇒ 红且点名真人席", () => {
    const msg = checkOne(
      "r26",
      fakeFiles(
        r26Good({
          "executors/production.ts": realFiles
            .src("executors/production.ts")
            .replace("new HumanExecutor", "removedHumanExecutor"),
        }),
      ),
    );
    expect(msg).toContain("HumanExecutor");
  });

  it("变异 r26 之二：只动无关行 ⇒ 仍绿（判据认三处接线，不是整表字数）", () => {
    const msg = checkOne(
      "r26",
      fakeFiles(
        r26Good({
          "dispatch/service.ts":
            realFiles.src("dispatch/service.ts") + "\n// unrelated comment\n",
        }),
      ),
    );
    expect(msg).toBe("");
  });

  it("变异 r26 之三：取材文件整份不见 ⇒ 响亮抛，不静默绿", () => {
    expect(() => checkOne("r26", fakeFiles({}))).toThrow(
      "executors/production.ts",
    );
  });

  // ── r27：分发规则配置面接通。四格各打一种「端点在但那条线断了」──
  const r27Good = (
    over: Record<string, string> = {},
  ): Record<string, string> => ({
    "http/registrars.ts": realFiles.src("http/registrars.ts"),
    "http/dispatch-rules.ts": realFiles.src("http/dispatch-rules.ts"),
    "dispatch/rules.ts": realFiles.src("dispatch/rules.ts"),
    "dispatch/co.ts": realFiles.src("dispatch/co.ts"),
    ...over,
  });

  it("变异 r27 之一：注册函数还在但生产装配不再调用 ⇒ 红在注册格", () => {
    const real = realFiles.src("http/registrars.ts");
    expect(
      checkOne("r27", fakeFiles(r27Good())),
      "真仓库字节原样必须绿，否则下面几发红在别处",
    ).toBe("");
    const msg = checkOne(
      "r27",
      fakeFiles(
        r27Good({
          "http/registrars.ts": real.replace(
            "registerDispatchRuleRoutes(router);",
            "/* 忘了接线 */",
          ),
        }),
      ),
    );
    expect(msg).toContain("registrars");
    expect(msg).not.toContain("router.add");
  });

  it("变异 r27 之二：三条路由砍掉 PATCH ⇒ 红在路由数（读侧在≠写侧在）", () => {
    const real = realFiles.src("http/dispatch-rules.ts");
    const cut = real.replace(
      '  router.add(\n    "PATCH',
      "  // 摘掉 PATCH 这一条",
    );
    expect(cut).not.toBe(real);
    const msg = checkOne(
      "r27",
      fakeFiles(r27Good({ "http/dispatch-rules.ts": cut })),
    );
    expect(msg).toContain("router.add");
    expect(msg).toContain("零写入方");
  });

  it("变异 r27 之三：抹掉消费侧一处 enabled = 1 ⇒ 红在停用不生效，而不是红在路由数", () => {
    const real = realFiles.src("dispatch/co.ts");
    const oneLess = real.replace(
      "WHERE enabled = 1 AND group_id IS NULL",
      "WHERE group_id IS NULL",
    );
    expect(oneLess).not.toBe(real);
    const msg = checkOne(
      "r27",
      fakeFiles(r27Good({ "dispatch/co.ts": oneLess })),
    );
    expect(msg).toContain("停用");
    expect(msg).not.toContain("router.add");
  });

  it("变异 r27 之四：INSERT 整条改写（取材落点漂）⇒ 红在落点已漂，不许恒绿", () => {
    const real = realFiles.src("dispatch/rules.ts");
    const msg = checkOne(
      "r27",
      fakeFiles(
        r27Good({
          "dispatch/rules.ts": real.replace(
            "INSERT INTO cos_dispatch_rules (rule_id",
            "INSERT INTO dispatch_rules_v2 (rule_id",
          ),
        }),
      ),
    );
    expect(msg).toContain("落点已漂");
    expect(msg).not.toContain("停用");
  });

  it("变异 r27 之五：只动无关行 ⇒ 仍绿（判据认那几处接线，不是整表字数）", () => {
    expect(
      checkOne(
        "r27",
        fakeFiles(
          r27Good({
            "dispatch/rules.ts":
              realFiles.src("dispatch/rules.ts") + "\n// unrelated\n",
          }),
        ),
      ),
    ).toBe("");
  });

  it("变异 r27 之六：取材文件整份不见 ⇒ 响亮抛，不静默绿", () => {
    expect(() => checkOne("r27", fakeFiles({}))).toThrow("http/registrars.ts");
  });
});

describe("主张登记表：出口文档渲染", () => {
  it("docs/OPC-OS-功能优化设计.md 有登记表小节，且与 REGISTRY 渲染逐字一致", () => {
    const md = readFileSync(OPCOS, "utf8");
    expect(md.includes("## O14 主张登记表")).toBe(true);
    const rendered = renderMarkdown(REGISTRY);
    // 渲染出来的每一行都必须在正文里；顺序一致（用包含整块断言）
    expect(md).toContain(rendered);
  });

  it("渲染只放判据与核对时刻，不放条数（家规）", () => {
    const rendered = renderMarkdown(REGISTRY);
    // 表头没有"条数/数量/几处"这类计数列
    // ⚠ 判的其实是【整张表】而不是只有表头 —— 这三处词的注释与实际射程不一致，
    //   round293 加 r20 时被它拦住过一次（主张里写「§1.1 那张表的四条数…」即红，
    //   而红话只给一句「expected … to not match」，看不出被拦的是正文不是列名）。
    //   这里【不收窄判据】：收窄 = 让「不写会漂移的数」这条家规少一道执行者，
    //   而它拦下来的是【新写的一句话】，改个说法就绿，不是随机红（0055 那类是另一回事）。
    //   要写的确实需要那三个词时（「上限条数」「未解析条数」这种判据名），
    //   先想清楚那句是不是在给某个数作证 —— 是的话它本来就该走判据而不是走文案。
    expect(rendered).not.toMatch(/条数|数量|共\s*\d/);
  });
});
