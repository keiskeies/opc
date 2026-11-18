/**
 * `hub charter seed`（O2 动作 2 与动作 3，验收 (b) 的本体）。
 *
 * ── 这个文件存在的唯一理由是验收 (b) 那一句 ──────────────────────────
 * 设计文档 O2 的验收 (b)：播种命令遇到带占位串的模板必须**退非 0**，且**这条要有测试**。
 * 下面 describe ③ 里那两发就是它，而它必须分两发放：
 *  ① 合成夹具（干净标准 / 带占位串的标准）—— 判据本身的判别力；
 *  ② 仓里那七份**真模板** —— 今天的实际读数。
 * 少了第 ② 发，本文件证的是"我造的夹具能被拦住"，而 CEO 打开终端跑那一条读的是
 * **真模板** —— 0057 §6 那判据的形状：一条测试可以全绿而它测的东西不在路上。
 *
 * ── 为什么 planSeed 单独一节（纯函数、不建库）───────────────────────
 * 判据要能被**变异**打，而内联在 CLI 里的判据只能靠"跑一遍看看红不红"。
 * 0058 §5 记的就是内联判据的下场（那个复现夹具杀不掉它声称要杀的变异）。
 * 所以 ① 一节覆盖每条判据的**组合**，特别是「一个合格 + 一个不合格」那一发 ——
 * 判据 C（半套不写）**只在混合输入上有内容**，全好或全坏都测不到它。
 *
 * ── 夹具为什么手写而不用 resources/charter-templates ─────────────────
 * 与 store.test.ts 同一条：那七份的 acceptance_criteria 带着
 * `CEO-PLACEHOLDER-ACCEPTANCE`（Task 0.9 等 CEO 签），把它们当"能播种的模板"
 * 等于**替 CEO 填了验收标准** —— 那正是本命令要拦的事。所以合成夹具用一眼假的
 * 条件串；真模板只出现在【断言它们被拒】那两发里，那两发不写任何库内容。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CharterInput } from "@opc/contracts";
import { afterAll, describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";
import {
  latestCharters,
  parseSeedArgs,
  planSeed,
  reachabilityLines,
  reachabilityOf,
  readTemplate,
  runCharterCli,
  runSeedCli,
  type SeedExisting,
  type SeedIo,
  type SeedTemplate,
  summaryOf,
  templateFiles,
} from "../../src/charter/seed.js";
import { migrate } from "../../src/db/migrate.js";
import { WriteQueue } from "../../src/db/write-queue.js";
import {
  EXIT_OK,
  EXIT_PROBLEM,
  EXIT_USAGE,
} from "../../src/heartbeat/maintenance.js";
import { NODE_TO_TEMPLATE } from "../../src/roles/preset.js";
import { fixtureTmp } from "../fixtures/fixture-dir.js";

const HUB = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REAL_TEMPLATES = join(HUB, "resources", "charter-templates");
const TMP = fixtureTmp("charter-seed", import.meta.url);
mkdirSync(TMP, { recursive: true });

/** 那个常量的字面量。这里**故意写死而不是 import 常量**：见下面『前提』那一发的理由。 */
const PLACEHOLDER = "CEO-PLACEHOLDER-ACCEPTANCE";

const queues: WriteQueue[] = [];
let fileSeq = 0;

async function newQ(): Promise<{ q: WriteQueue; path: string }> {
  const path = join(TMP, "seed-" + process.pid + "-" + ++fileSeq + ".db");
  const q = new WriteQueue(path);
  queues.push(q);
  migrate(q.writeConnection());
  return { q, path };
}

/**
 * 真库读数的三个计数器。审计只数岗位书那一类，别被迁移自己落的事件干扰。
 *
 * 放在模块层而不是 §③ 的 describe 里：§⑤ 也要判"播种确实成功了"，
 * 而 §③ 那份内联的看不见 —— 复制一份就是两个源，两处会漂（本仓一路在治的形状）。
 */
function counts(q: WriteQueue): {
  charters: number;
  audit: number;
  budgets: number;
} {
  const db = q.readConnection();
  const n = (sql: string): number => {
    const r = db.prepare(sql).get() as { c: number | bigint } | undefined;
    return r === undefined ? 0 : Number(r.c);
  };
  return {
    charters: n("SELECT COUNT(*) c FROM role_charters"),
    audit: n(
      "SELECT COUNT(*) c FROM events WHERE json_extract(payload,'$.kind')='charter_version_added'",
    ),
    budgets: n("SELECT COUNT(*) c FROM budgets"),
  };
}

/**
 * 往库里塞一版组织图。手写 graph_json 而不调 `commitOrgGraph`：那条路要扯进备份目录、
 * HMAC 演员、变更前 `VACUUM INTO` 快照一整套装配，而这两节要的只是「图上有这几个名字」。
 * 节点形状按 `orgNodeSchema`（role_id / can_manage / reports_to / model_family）给全，
 * 免得将来有人把这里当"随便一个 JSON"改坏了而 `readLatestGraph` 那边读得出来、这里读不出来。
 */
function putGraph(
  q: WriteQueue,
  version: number,
  nodeIds: readonly string[],
): void {
  const nodes: Record<string, unknown> = {};
  for (const id of nodeIds) {
    nodes[id] = {
      role_id: id,
      can_manage: id === "ceo",
      reports_to: id === "ceo" ? null : "ceo",
      model_family: "claude",
    };
  }
  q.writeConnection()
    .prepare(
      "INSERT INTO delegation_graphs (id, version, graph_json, effective_from, created_by, change_summary) VALUES (?,?,?,?,?,?)",
    )
    .run(
      "g" + version,
      version,
      JSON.stringify({ nodes, edges: [] }),
      1,
      "ceo",
      "夹具",
    );
}

/** 收集 io，让"打到哪条流"成为可断言的东西（退出码 + 流是这条命令的全部对外契约）。 */
function captureIo(): { io: SeedIo; out(): string; err(): string } {
  const o: string[] = [];
  const e: string[] = [];
  return {
    io: {
      write: (t) => {
        o.push(t);
      },
      error: (t) => {
        e.push(t);
      },
    },
    out: () => o.join(""),
    err: () => e.join(""),
  };
}

/**
 * 一份能过 charterSchema 的草案（snake_case = CharterInput）。
 * 与 store.test.ts 的 draft 同一形状、同一条理由：假数据，不会被读成真标准。
 * ⚠ condition 写的是【不合格的情形】配 reject（0008 §7.3 末段）—— 本仓有人
 * （我，两轮前）把 `coverage >= 80` 配 reject 写成「覆盖率好就拒」，全绿而门控从不拦。
 */
const draft = (over: Partial<CharterInput> = {}): CharterInput => ({
  role_id: "dev",
  display_name: "开发",
  version: 1,
  honesty_boundaries: ["不谎报测试结果"],
  acceptance_criteria: [
    {
      condition: "metric:coverage < 80",
      action: "reject",
      message: "覆盖率不足 80",
    },
  ],
  forbidden_actions: [],
  tool_permissions: ["read"],
  model_tier: "execution",
  budget: { daily_usd: 15, per_task_usd: 5 },
  decision_scope: { autonomous: [], requires_consultation: [], forbidden: [] },
  judgment_mode: {
    type: "strict_rules",
    strict_rules: [],
    bounded_judgment: [],
    full_discretion: [],
  },
  escalation_triggers: [],
  ...over,
});

/**
 * CharterInput → YAML 文本。
 *
 * 为什么交给 `yaml.stringify` 而不是手写字符串拼接（我第一版是手写的，40 行）：
 * 手写那一份是 **charterSchema 的第二份抄本**。schema 加一个可选字段而这里不跟着加时，
 * 测试**照样绿** —— 那一格只是没被写出来，于是那发测的是"少一格的岗位书"，
 * 而它自己看不出来（本仓一路在治的形状：0006 §7「两份抄本」、0058 §3 手抄名单）。
 * 我第一版拒绝它的理由是「库升级会改序列化风格，而判据 B 比逐字相同」—— 那是**错的**：
 * 判据 B 比的是 configJson 与库里那一列，**两边都是 JSON.stringify(解析后的 charter)**，
 * YAML 的缩进与引号风格根本进不了那次比较。一个错的理由换来一个真 bug
 * （`budget_discretion` 被我拼成了布尔值，而它是 optional object）。
 */
function yamlOf(c: CharterInput): string {
  return stringifyYaml(c);
}

/** 写一个模板目录，返回目录路径。同名目录复用（每个 describe 用独一名，见调用点）。 */
function templateDir(name: string, files: ReadonlyMap<string, string>): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of files) {
    const p = join(dir, file);
    rmSync(p, { force: true });
    writeFileSync(p, text, "utf8");
  }
  return dir;
}

/** 目录 → planSeed 的输入（判据要的是"读出来的东西"，不是路径）。 */
function templatesOf(dir: string): SeedTemplate[] {
  return templateFiles(dir).map((f) => readTemplate(dir, f));
}

/** 真模板的份数从**磁盘**派生，不写死 7：写死就是又一个会漂的抄本。 */
function realTemplateFiles(): string[] {
  return readdirSync(REAL_TEMPLATES).filter((f) => /\.ya?ml$/iu.test(f));
}

afterAll(async () => {
  for (const q of queues) {
    try {
      await q.close();
    } catch {
      /* 关不掉不影响别的 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⓪ 前提。这一发放最前面，因为下面「真模板被拒」那一发的**成立与否**全看它。
 * ══════════════════════════════════════════════════════════════════════ */
it("前提：真模板今天确实带着占位串（前提塌了要在这里红，而不是让验收那发空转）", () => {
  const files = realTemplateFiles();
  const withPlaceholder = files.filter((f) =>
    readFileSync(join(REAL_TEMPLATES, f), "utf8").includes(PLACEHOLDER),
  );
  // 为什么这一发不是装饰：上面那节『真模板 ⇒ 退 1』的断言形如
  // 「stderr 里 CEO-PLACEHOLDER-ACCEPTANCE 出现 N 次，N = 模板份数」。
  // 若哪天七份都签掉了，那份数表达式变成 0 == 0 —— 那一发**仍然绿**，
  // 而它已经什么都不判了。这里独立钉一次「份数 > 0 且份数 == 带占位串的份数」，
  // 于是模板被签掉那天，红的是**这一发**（一句真话过期），而不是一条静默的空判据。
  expect(withPlaceholder.length).toBe(files.length);
  expect(files.length).toBeGreaterThan(0);
});

/* ══════════════════════════════════════════════════════════════════════
 * ① 判据本体（纯函数，零 IO）
 * ══════════════════════════════════════════════════════════════════════ */
describe("① planSeed 判据", () => {
  const clean = templateDir(
    "clean",
    new Map([
      ["dev.yaml", yamlOf(draft())],
      ["ceo.yaml", yamlOf(draft({ role_id: "ceo", display_name: "CEO" }))],
    ]),
  );
  const ts = templatesOf(clean);

  it("库里一个角色都没有 ⇒ 全部按写入处置", () => {
    const p = planSeed(ts, new Map());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.actions.map((a) => a.kind + ":" + a.roleId).sort()).toEqual([
      "写入:ceo",
      "写入:dev",
    ]);
  });

  it("库里那一版与模板【逐字相同】⇒ 跳过（幂等的来源，不是口头保证）", () => {
    const existing = new Map<string, SeedExisting>(
      ts.map((t) => [t.roleId, { version: 3, config: t.configJson }]),
    );
    const p = planSeed(ts, existing);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.actions.every((a) => a.kind === "跳过")).toBe(true);
    // 版本号跟库里那一版走，不是 1：报出 v3 的人才知道"已经播过、而且被人升过版"。
    const first = p.actions[0];
    expect(first?.kind === "跳过" && first.version).toBe(3);
  });

  it("库里那一版与模板【不同】⇒ 整次拒绝，而不是顺手升一版", () => {
    const existing = new Map<string, SeedExisting>([
      ["dev", { version: 2, config: '{"roleId":"dev","version":2}' }],
    ]);
    const p = planSeed(ts, existing);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.kind)).toEqual(["与库里最新一版不同"]);
    // 那句话要把人**指到正确的修法**：不是"再跑一次"，是走编辑器。
    expect(p.problems[0]?.why).toContain("编辑器");
  });

  it("带占位串 ⇒ 拒绝，且问题里点名是哪一条（O2 动作 3）", () => {
    const dir = templateDir(
      "placeholder",
      new Map([
        [
          "dev.yaml",
          yamlOf(
            draft({
              acceptance_criteria: [
                {
                  condition: "metric:coverage < 80",
                  action: "reject",
                  message: "ok",
                },
                { condition: PLACEHOLDER, action: "reject", message: "没签" },
              ],
            }),
          ),
        ],
      ]),
    );
    const one = templatesOf(dir);
    expect(one[0]?.placeholders).toEqual(["第 2 条"]);
    const p = planSeed(one, new Map());
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems[0]?.kind).toBe("占位串未签");
    // 那句话必须能让人**不改代码就修好**：点名文件、点名第几条、点名那个常量。
    expect(p.problems[0]?.why).toContain("dev.yaml");
    expect(p.problems[0]?.why).toContain("第 2 条");
    expect(p.problems[0]?.why).toContain(PLACEHOLDER);
  });

  it("占位串挪进 message 一样拦（只查 condition 会漏过半只手改）", () => {
    const dir = templateDir(
      "placeholder-msg",
      new Map([
        [
          "dev.yaml",
          yamlOf(
            draft({
              acceptance_criteria: [
                {
                  condition: "metric:coverage < 80",
                  action: "reject",
                  message: PLACEHOLDER,
                },
              ],
            }),
          ),
        ],
      ]),
    );
    expect(templatesOf(dir)[0]?.placeholders).toEqual(["第 1 条"]);
  });

  it("判据 C：一个合格 + 一个带占位串 ⇒ 拿不到 actions（半套不写）", () => {
    // 这一发是本文件对判据 C 的**唯一**结构覆盖点，而它只在混合输入上有内容：
    // 把 planSeed 改成"能写的先写"，全好/全坏那两发都不会红，只有这一发会。
    const bad = templateDir(
      "mixed",
      new Map([
        ["ceo.yaml", yamlOf(draft({ role_id: "ceo", display_name: "CEO" }))],
        [
          "dev.yaml",
          yamlOf(
            draft({
              acceptance_criteria: [
                { condition: PLACEHOLDER, action: "reject", message: "没签" },
              ],
            }),
          ),
        ],
      ]),
    );
    const p = planSeed(templatesOf(bad), new Map());
    expect(p.ok).toBe(false);
    // 断言的是【类型上拿不到 actions】。若哪天 SeedPlan 退回 {actions, problems}
    // 两个数组，这一发就是"调用方可以只写没出问题的角色"那个口子重新打开的地方。
    expect("actions" in p).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.roleId)).toEqual(["dev"]);
  });

  it("模板一个都没有 ⇒ 给问题而不是给一个空的成功", () => {
    const p = planSeed([], new Map());
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.kind)).toEqual(["模板目录里没有任何 yaml"]);
  });

  it("目录里全是读不进的文件 ⇒ 既报各自的原因，也报一句「一个都没读进来」", () => {
    // 少了后一句，"整目录坏"会被读成"某个文件坏了"，而两者修法完全不同。
    const p = planSeed([], new Map(), [
      { kind: "模板读不进来", roleId: "x.yaml", why: "x.yaml 读失败：语法错" },
    ]);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.kind)).toEqual([
      "模板读不进来",
      "模板目录里没有任何 yaml",
    ]);
  });

  it("文件名 ≠ role_id ⇒ 拒（validateCharterDraft 那条在播种这条路上恒真、挡不住）", () => {
    // 身份错位在真实写入路径上**测不出来**：saveCharterVersion 收到的 roleId 与
    // config.role_id 来自同一份文件，那条「不一致就拒」永远成立。
    // 所以这一发必须打在 planSeed 上，打在 save 的往返上是空的。
    const dir = templateDir(
      "mismatch",
      new Map([["renamed.yaml", yamlOf(draft())]]),
    );
    const p = planSeed(templatesOf(dir), new Map());
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.kind)).toEqual(["文件名与 role_id 不一致"]);
    expect(p.problems[0]?.why).toContain("renamed.yaml");
  });

  it("同一个 role_id 出现在两份文件里 ⇒ 拒（否则后一份会变成 v2）", () => {
    // .yaml 与 .yml 两种扩展名都会被抓，所以构造同名最容易的方式是 dev.yaml + dev.yml。
    const dir = templateDir(
      "dup",
      new Map([
        ["dev.yaml", yamlOf(draft())],
        ["dev.yml", yamlOf(draft({ display_name: "开发2" }))],
      ]),
    );
    expect(templateFiles(dir)).toEqual(["dev.yaml", "dev.yml"]);
    const p = planSeed(templatesOf(dir), new Map());
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.problems.map((x) => x.kind)).toEqual([
      "同一个 role_id 出现在两份模板里",
    ]);
  });

  it("扩展名大小写不敏感（DEV.YAML 的后缀不会被当成 role_id 的一部分）", () => {
    const dir = templateDir("case", new Map([["dev.YAML", yamlOf(draft())]]));
    expect(templateFiles(dir)).toEqual(["dev.YAML"]);
    const p = planSeed(templatesOf(dir), new Map());
    expect(p.ok).toBe(true);
  });

  it("summaryOf 不依赖 cwd：同一次播种在任何目录跑，审计里那句话逐字相同", () => {
    // 审计是 append-only 的。若那句带上 relative(cwd, dir)，同一动作在仓库根与
    // packages/hub 会写出两条不同的「为什么改」，回放里看不出它们是同一次。
    // 我第一版就是这么写的，写完自己读到才发现。
    expect(summaryOf("D:\\x\\templates", 7)).toBe(
      summaryOf("D:\\x\\templates", 7),
    );
    expect(summaryOf("/srv/tpl", 7)).toContain("7 份");
    expect(summaryOf("/srv/tpl", 7).trim().length).toBeGreaterThan(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 参数与分发
 * ══════════════════════════════════════════════════════════════════════ */
describe("② 参数与分发", () => {
  it("--db / --db= / OPC_DB 三种给法都收，env 只做缺省", () => {
    for (const p of [
      parseSeedArgs(["--db", "a.db"], {}),
      parseSeedArgs(["--db=a.db"], {}),
      parseSeedArgs([], { OPC_DB: "a.db" }),
    ]) {
      expect(p.ok).toBe(true);
      if (p.ok) expect(p.args.dbPath).toBe("a.db");
    }
    // env 不覆盖显式参数：脚本里 `OPC_DB=x … --db y` 的意图是 y。
    const both = parseSeedArgs(["--db", "y.db"], { OPC_DB: "x.db" });
    expect(both.ok && both.args.dbPath).toBe("y.db");
  });

  it("空白的 OPC_DB 不算「设置了库」（否则会拿一个空路径去开库）", () => {
    expect(parseSeedArgs([], { OPC_DB: "   " }).ok).toBe(false);
    expect(parseSeedArgs([], {}).ok).toBe(false);
    expect(parseSeedArgs(["--db", "  "], {}).ok).toBe(false);
  });

  it("重复 / 缺值 / 未知参数都拒，且报的是那一个参数", () => {
    expect(parseSeedArgs(["--db", "a", "--db", "b"], {}).ok).toBe(false);
    expect(parseSeedArgs(["--db"], {}).ok).toBe(false);
    expect(parseSeedArgs(["--from"], {}).ok).toBe(false);
    const bad = parseSeedArgs(["--db", "a", "--nope"], {});
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain("--nope");
  });

  it("--help 走 stdout + 0；什么都没敲走 stderr + 2", async () => {
    const h = captureIo();
    expect((await runCharterCli(["--help"], h.io)).code).toBe(EXIT_OK);
    expect(h.out()).toContain("用法");
    expect(h.err()).toBe("");

    const n = captureIo();
    expect((await runCharterCli([], n.io)).code).toBe(EXIT_USAGE);
    expect(n.err()).toContain("用法");
    expect(n.out()).toBe("");
  });

  it("照设计文档敲 `charter seed` 的人落在「没有 [charter] 这个子命令」，不是「缺 --db」", async () => {
    // 设计文档写 `hub charter seed`，本仓落成 `pnpm hub:charter seed`（脚本名占掉了
    // 那一个 token）。这个错位是**已知偏离**，而它一定有读者：这一发钉的是
    // 「读者被指到正确的原因」，不是「这个分支可达」。
    const c = captureIo();
    const r = await runCharterCli(["charter", "seed", "--db", "x.db"], c.io);
    expect(r.code).toBe(EXIT_USAGE);
    expect(c.err()).toContain("没有 [charter] 这个子命令");
    expect(c.err()).not.toContain("缺 --db");
  });

  it("runCharterCli 吃掉 seed，runSeedCli 收到的是纯参数", async () => {
    // 两层混在一起时 seed 会被当成未知参数 —— 那句话既不对也把人指错方向。
    //
    // ⚠ 库路径必须在【夹具目录里】且不存在，不能写成仓库根的一个相对名。
    // 我第一版写的是 `--db=join-nothing.db`，而它在变异跑里泄漏过：判据 M6
    // （把 existsSync 那一格去掉的变异体）让这一发**真的把库建到了仓库根**，
    // 于是它留在磁盘上，之后每一次跑这一发都存在 → existsSync 通过 → 走到写库，
    // 这一发从此判的不再是「不存在的库要退 2」。一个测试**依赖某个文件不存在**，
    // 而它自己就是最可能创建那个文件的东西 —— 泄漏一次就永久变味，且不会自己恢复。
    const missing = join(TMP, "cli-layer-no-such-db");
    rmSync(missing, { force: true });
    const c = captureIo();
    const r = await runCharterCli(["seed", "--db=" + missing], c.io);
    expect(r.code).toBe(EXIT_USAGE); // 报的是"库不存在"，不是"未知参数 seed"
    expect(c.err()).toContain("库文件不存在");
    expect(c.err()).not.toContain("未知参数");
    expect(existsSync(missing)).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 端到端（真库 + 真 WriteQueue）—— 验收 (b)
 * ══════════════════════════════════════════════════════════════════════ */
describe("③ 端到端：验收 (b)", () => {
  it("仓里那七份真模板 ⇒ 退 1、零写入（验收 b 的正题：用的是真模板）", async () => {
    const { q, path } = await newQ();
    const c = captureIo();
    const r = await runSeedCli(["--db", path, "--from", REAL_TEMPLATES], c.io);
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(counts(q)).toEqual({ charters: 0, audit: 0, budgets: 0 });
    // 七份**全报**，不是撞到第一个就退：人要一次看完要改什么。
    const hits = (c.err().match(new RegExp(PLACEHOLDER, "gu")) ?? []).length;
    expect(hits).toBe(realTemplateFiles().length);
    expect(c.err()).toContain("一个角色都没写");
  });

  it("签掉占位串（合成夹具）⇒ 两份都写、退 0、budget 同步落库", async () => {
    const dir = templateDir(
      "signed",
      new Map([
        ["dev.yaml", yamlOf(draft())],
        ["ceo.yaml", yamlOf(draft({ role_id: "ceo", display_name: "CEO" }))],
      ]),
    );
    const { q, path } = await newQ();
    const c = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c.io)).code).toBe(
      EXIT_OK,
    );
    // 2 份岗位书 × 2 格预算 = 4 条 budgets。这一发同时是「播种会开始限流」的证据。
    expect(counts(q)).toEqual({ charters: 2, audit: 2, budgets: 4 });
    expect(c.out()).toContain("写入 dev v1");
    // 预算副作用**必须在屏幕上说出来**，不能只躺在审计 payload 里。
    expect(c.out()).toContain("budgets 表");
  });

  it("再跑一次 ⇒ 退 0、零新行、零新审计（幂等）", async () => {
    const dir = templateDir("idem", new Map([["dev.yaml", yamlOf(draft())]]));
    const { q, path } = await newQ();
    expect(
      (await runSeedCli(["--db", path, "--from", dir], captureIo().io)).code,
    ).toBe(EXIT_OK);
    const before = counts(q);
    const c = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c.io)).code).toBe(
      EXIT_OK,
    );
    expect(counts(q)).toEqual(before);
    expect(c.out()).toContain("跳过 dev");
    expect(c.out()).toContain("写入 0 份");
  });

  it("「已经播过了」与「被挡住了」在输出里分得开（两种「什么都不做」不能同形）", async () => {
    const dir = templateDir(
      "twoface",
      new Map([["dev.yaml", yamlOf(draft())]]),
    );
    const { q, path } = await newQ();
    await runSeedCli(["--db", path, "--from", dir], captureIo().io);

    const skip = captureIo();
    expect(
      (await runSeedCli(["--db", path, "--from", dir], skip.io)).code,
    ).toBe(EXIT_OK);
    expect(skip.out()).toContain("跳过");
    expect(skip.err()).toBe(""); // 跳过不是问题，不该出现在 stderr

    // 把库里那一版改脏 ⇒ 同一份模板从"播过了"变成"被挡住"。
    q.writeConnection()
      .prepare("UPDATE role_charters SET config = ? WHERE role_id = 'dev'")
      .run('{"roleId":"dev","version":1}');
    const blocked = captureIo();
    const r = await runSeedCli(["--db", path, "--from", dir], blocked.io);
    expect(r.code).toBe(EXIT_PROBLEM);
    expect(blocked.err()).toContain("播种被拒");
    expect(blocked.out()).not.toContain("跳过");
  });

  it("库里被人改过 ⇒ 整次拒绝，既不覆盖也不升版（判据 B 的端到端）", async () => {
    const dir = templateDir(
      "keep",
      new Map([
        ["dev.yaml", yamlOf(draft())],
        ["ceo.yaml", yamlOf(draft({ role_id: "ceo", display_name: "CEO" }))],
      ]),
    );
    const { q, path } = await newQ();
    await runSeedCli(["--db", path, "--from", dir], captureIo().io);
    q.writeConnection()
      .prepare("UPDATE role_charters SET config = ? WHERE role_id = 'dev'")
      .run('{"roleId":"dev","version":1,"acceptanceCriteria":[]}');
    const before = counts(q);
    const c = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c.io)).code).toBe(
      EXIT_PROBLEM,
    );
    // 一条都不动：既没有 v2，也没有新审计。（只改 config 那一列不会动 events/budgets，
    // 所以 counts 相等这一判据是真的在判"这次没写"，而不是被上一次播种的数字掩盖。）
    expect(counts(q)).toEqual(before);
    expect(c.err()).toContain("不覆盖");
  });

  it("库文件不存在 ⇒ 退 2 且【不创建它】", async () => {
    const dir = templateDir("nodb", new Map([["dev.yaml", yamlOf(draft())]]));
    const missing = join(TMP, "definitely-not-created.db");
    const c = captureIo();
    const r = await runSeedCli(["--db", missing, "--from", dir], c.io);
    expect(r.code).toBe(EXIT_USAGE);
    expect(c.err()).toContain("刻意不建库");
    // 断言的是**磁盘**。少了这一行，"不建库"只是注释里的一句话，
    // 而 new WriteQueue 会高高兴兴把文件建出来，读起来像成功。
    expect(existsSync(missing)).toBe(false);
  });

  it("坏 YAML 混在好模板里 ⇒ 零写入，且原因里带文件名（不会安静地少一个角色）", async () => {
    const dir = templateDir(
      "broken",
      new Map([
        ["dev.yaml", yamlOf(draft())],
        ["broken.yaml", "role_id: [broken\n  x: {"],
      ]),
    );
    const { q, path } = await newQ();
    const c = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c.io)).code).toBe(
      EXIT_PROBLEM,
    );
    expect(counts(q).charters).toBe(0);
    expect(c.err()).toContain("broken.yaml");
  });

  it("空目录 ⇒ 退 1（「播种成功」而零写入是这条命令能编的最坏的一句谎）", async () => {
    const dir = join(TMP, "empty-dir");
    mkdirSync(dir, { recursive: true });
    const { q, path } = await newQ();
    expect(
      (await runSeedCli(["--db", path, "--from", dir], captureIo().io)).code,
    ).toBe(EXIT_PROBLEM);
    expect(counts(q)).toEqual({ charters: 0, audit: 0, budgets: 0 });
  });

  it("模板目录不存在 ⇒ 退 2，且报的是解析后的绝对路径", async () => {
    const { path } = await newQ();
    const c = captureIo();
    expect(
      (await runSeedCli(["--db", path, "--from", "no-such-dir"], c.io)).code,
    ).toBe(EXIT_USAGE);
    // 相对 --from 按 **cwd** 解析（默认值才按模块解析，见 seed.ts 文件头），
    // 而报错打的是解析后的那一个。断言"打的是绝对路径"而不是"打了 TMP"：
    // 我第一版写的是后者，它红在一句"路径里没有 .tmp"上 —— 那句话对，
    // 而它指的方向是错的（这一发的输入本来就不该在 TMP 里）。
    const expected = join(process.cwd(), "no-such-dir");
    expect(c.err()).toContain(expected);
    expect(c.err()).not.toContain("—— no-such-dir");
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 读侧的三个口径
 * ══════════════════════════════════════════════════════════════════════ */
describe("④ 读侧口径", () => {
  it("configJson 是 camelCase（与库里那一列同形状），input 是 snake_case", () => {
    const dir = templateDir("shape", new Map([["dev.yaml", yamlOf(draft())]]));
    const t = readTemplate(dir, "dev.yaml");
    // 判据 B 比的是 configJson vs 库里的原文。若这里是 snake_case 而库里是 camelCase，
    // 「逐字相同」永不成立 ⇒ 第二次播种会报"与库里不同"，幂等直接失效 ——
    // 而那看起来像是判据 B 太严，不像自己形状搞错了。
    expect(JSON.parse(t.configJson)).toHaveProperty("roleId", "dev");
    expect(JSON.parse(t.configJson)).not.toHaveProperty("role_id");
    // 而 input 必须是 snake_case：递错形状给 saveCharterVersion 会得到 14 条
    // invalid_type，而报错里没有「请用 snake_case」这句话（store.ts 文件头 ②）。
    expect(t.input).toHaveProperty("role_id", "dev");
    expect(t.input).not.toHaveProperty("roleId");
  });

  it("latestCharters 表为空 ⇒ 空 Map（今天所有真库的读数）", async () => {
    const { q } = await newQ();
    expect(latestCharters(q, ["dev", "ceo"]).size).toBe(0);
  });

  it("latestCharters 取的是【最高版】那一版的原文，不是最小版", async () => {
    const { q } = await newQ();
    const ins = q
      .writeConnection()
      .prepare(
        "INSERT INTO role_charters (id, role_id, version, config, effective_from, created_by) VALUES (?,?,?,?,?,?)",
      );
    ins.run("a1", "dev", 1, "V1", 1, "ceo");
    ins.run("a2", "dev", 3, "V3", 1, "ceo");
    expect(latestCharters(q, ["dev"]).get("dev")).toEqual({
      version: 3,
      config: "V3",
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 可达性：「写进表里」与「运行时叫得到」是两件事
 *
 * 这一节存在的全部理由：`role_charters` 按 **role_id** 存，而唯一的读者
 * `runtime.ts` 的 `rolePrompt(roleId)` 收的是**任务上的角色名**，那个名字还要先过
 * `dispatch.ts` 门 0 的 `graph.nodes[task.role]`。仓里那两套 id 今天不相等
 * （节点 intake/charter/report ↔ 模板 assistant/assistant/ceo），
 * 所以"播种成功"这句绿话可以在一份都用不上的库里打出来。
 * ══════════════════════════════════════════════════════════════════════ */
describe("⑤ 可达性：播进去的角色运行时叫不叫得到", () => {
  it("库里没有组织图 ⇒ 判不了，而这句话【说出来】而不是沉默", async () => {
    // 必须现开一个库：借上一个 it 的连接会跟着别人的夹具走 —— 上一个用例刚往里
    // 插过 delegation_graphs，"没有图"这一支就再也测不到了（而它仍然绿）。
    const { q } = await newQ();
    const r = reachabilityOf(q, ["dev"]);
    expect(r).toEqual({ graphVersion: null, nodeIds: [], missing: [] });
    // 沉默是最坏的读数：它会与"全都可达"长得一模一样。
    const txt = reachabilityLines(r).join("\n");
    expect(txt).toContain("没有判可达性");
    expect(txt).toContain("POST /org"); // 这一支才该给建图那条路
    expect(txt).not.toContain("✓");
  });

  it("图上有这个名字 ⇒ 判「可达」，且那句带上图版本号", async () => {
    const { q } = await newQ();
    putGraph(q, 7, ["ceo", "dev", "test"]);
    const r = reachabilityOf(q, ["dev", "test"]);
    expect(r.graphVersion).toBe(7);
    expect(r.missing).toEqual([]);
    expect(reachabilityLines(r).join("")).toContain("v7");
  });

  it("图上没有 ⇒ 点名那个角色，并把【两条出路】说出来", async () => {
    const { q } = await newQ();
    putGraph(q, 3, ["ceo"]);
    // ⚠ 入参【故意逆序】：只有输入不带序，才测得出输出那一发 .sort() 在干活。
    // 变异实验实测：传 ["dev","ops"] 时把 .sort() 删掉【全绿】—— 那行排序
    // 就成了没被测到的死代码（0057 §6 那个判据的又一个现场）。
    const r = reachabilityOf(q, ["ops", "dev"]);
    expect(r.missing).toEqual(["dev", "ops"]);
    const txt = reachabilityLines(r).join("\n");
    expect(txt).toContain("叫不到");
    expect(txt).toContain("ops");
    expect(txt).toContain("v3");
    // 顺序在**那句话**里也要钉住，而不只钉在数组上：数组相等可能靠巧合同序。
    expect(txt).toContain("dev、ops");
    // 出路必须给出来。只说"不可达"而不说怎么对上，等于把人扔在一个他改不动的事实前。
    expect(txt).toContain("改组织图");
    expect(txt).toContain("模板文件名");
  });

  it("仓里那套真命名【今天就不相等】—— 这一发钉的是事实，不是我的例子", () => {
    // 这不是夹具能造出来的形状：intake / charter / report 三个节点挂的模板
    // 叫 assistant / assistant / ceo（roles/preset.ts 的 NODE_TO_TEMPLATE）。
    // 所以"播完种就能被叫到"在**默认装配**下必然为假。
    const mismatched = Object.entries(NODE_TO_TEMPLATE)
      .filter(([node, tpl]) => node !== tpl)
      .map(([node, tpl]) => node + "→" + tpl);
    expect(mismatched).toEqual([
      "intake→assistant",
      "charter→assistant",
      "report→ceo",
    ]);
    // 反面也要在：另四个节点是同名的 ⇒ 这不是"全都对不上"，是"一半对不上"。
    // 全不对上与一半不对上的处置完全不同，只看上面那串分不出来。
    const aligned = Object.entries(NODE_TO_TEMPLATE)
      .filter(([node, tpl]) => node === tpl)
      .map(([node]) => node);
    expect(aligned).toEqual(["product", "tech", "dev", "test"]);
  });

  it("播种成功时这句话打在【stdout】而不是 stderr，且不改变退出码", async () => {
    // 判据只算不拦（理由在 Reachability 那段注释：另一张表可以晚于播种存在，
    // 拦下来会让全新库永远播不进去）。而"警告"若走 stderr，脚本作者会把一次
    // 成功的播种读成失败 —— 这一发钉的就是这条分界。
    const dir = templateDir("reach", new Map([["dev.yaml", yamlOf(draft())]]));
    const { q, path } = await newQ();
    const c = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c.io)).code).toBe(
      EXIT_OK,
    );
    expect(c.out()).toContain("没有判可达性"); // 新库没有图 ⇒ 走那一支
    expect(c.err()).toBe(""); // 一个字都不该在 stderr
    // 播种本身确实成功了 —— 别让这句警告看起来像没写进去。
    expect(counts(q).charters).toBe(1);
  });

  it("同一份模板：图里有它 ⇒ 不响；图换成没它的版本 ⇒ 响（这句警告会被修好）", async () => {
    const dir = templateDir("reach2", new Map([["dev.yaml", yamlOf(draft())]]));
    const { q, path } = await newQ();
    // 第一遍：图里有 dev ⇒ 成功且不警告。
    putGraph(q, 1, ["ceo", "dev"]);
    const c1 = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c1.io)).code).toBe(
      EXIT_OK,
    );
    expect(c1.out()).toContain("可达性");
    expect(c1.out()).not.toContain("叫不到");
    // 第二遍：图换成没有 dev 的一版 ⇒ 同一份模板、同一句"跳过"，而警告出现。
    // 这一半证明的是那句警告**跟着图走**，不是恒响的装饰。
    putGraph(q, 2, ["ceo", "ops"]);
    const c2 = captureIo();
    expect((await runSeedCli(["--db", path, "--from", dir], c2.io)).code).toBe(
      EXIT_OK,
    );
    expect(c2.out()).toContain("跳过 dev"); // 播种仍然成功（幂等那一半没被动）
    expect(c2.out()).toContain("叫不到");
    expect(c2.out()).toContain("v2"); // 判的是最新那一版，不是 v1
  });
});
