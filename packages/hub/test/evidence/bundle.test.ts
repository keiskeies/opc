/**
 * Task 1.1 验收：证据包 schema 与内容寻址存储（规格 §5.10 / §8.2 第 2 条）。
 *
 * 这个文件要拦的不是「字段拼错」，而是三类【静默假绿】：
 *  1) evidence_refs 为空也通过校验 —— 那 §8.2「可验证的引用，不是总结」就只剩口号；
 *  2) verify() 在文件缺失/内容被改时仍报 ok —— 哈希对账形同虚设；
 *  3) 声明路径越出制品根目录 —— 那「制品放文件系统」变成「agent 可以写任意路径」。
 *
 * 与 test/db/schema-0001.test.ts 同一条立场：跑在【真迁移出来的 schema】上，
 * 不自造简化表。自造表证明的是「我写的表能用」，证明不了「迁移出来的那张表能用」。
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type EvidenceBundle,
  evidenceBundleSchema,
  requiredBundleType,
  unresolvableClaimIndexes,
} from "@opc/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fixtureTmp } from "../fixtures/fixture-dir.js";
import { migrate } from "../../src/db/migrate.js";
import {
  artifactPath,
  artifactsRoot,
  EvidenceStore,
  relativize,
  sha256Text,
} from "../../src/evidence/store.js";

const TMP = fixtureTmp("evidence", import.meta.url);

type Db = {
  prepare: (sql: string) => {
    all: (...a: unknown[]) => Record<string, unknown>[];
    get: (...a: unknown[]) => Record<string, unknown> | undefined;
    run: (...a: unknown[]) => { changes: number | bigint };
  };
  exec: (sql: string) => void;
  close: () => void;
};

const opened: Db[] = [];
let seq = 0;

async function migrated(): Promise<Db> {
  const { openDb } = await import("../../src/db/driver.js");
  const db = openDb(
    join(TMP, "ev-" + process.pid + "-" + ++seq + ".db"),
  ) as unknown as Db;
  opened.push(db);
  migrate(db);
  return db;
}

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

/** 一个形状合法的包，再按需覆盖字段（同 recorder.test.ts 的 evt() 立场）。 */
function bundle(
  over: { bundle_id?: string } & Record<string, unknown> = {},
): unknown {
  return {
    bundle_id: ID_A,
    task_id: "T-1",
    bundle_type: "code_diff",
    produced_by_role: "dev",
    produced_by_model_family: "claude",
    artifacts: [],
    claims: [{ text: "改动覆盖了登录路径", evidence_refs: ["src/a.ts"] }],
    honesty_boundaries: ["未覆盖并发场景"],
    ...over,
  };
}

function valid(over: Record<string, unknown> = {}): EvidenceBundle {
  const parsed = evidenceBundleSchema.safeParse(bundle(over));
  if (!parsed.success) {
    throw new Error("夹具本身不合法：" + JSON.stringify(parsed.error.issues));
  }
  return parsed.data;
}

let root: string;

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  root = join(TMP, "artifacts");
});

afterAll(() => {
  // Windows：不 close 就 rm 会 EBUSY
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("schema： claims 必须有依据", () => {
  it("evidence_refs 为空数组 → 拒绝", () => {
    const r = evidenceBundleSchema.safeParse(
      bundle({ claims: [{ text: "我保证没问题", evidence_refs: [] }] }),
    );
    expect(r.success).toBe(false);
  });

  it("claims 整体为空 → 通过（形状层不管，语义层管）", () => {
    // 有意区分：schema 只判形状。「一个主张都没有的包」形状合法，但门控会因为
    // 没有任何可判定的东西而拦它（unresolvableClaimIndexes 空 + criteria 判定）。
    // 若在 schema 里 min(1)，就等于把「语义充分性」焊死成结构要求，
    // 以后想允许「纯制品交接」（只有文件没有主张）会撞上契约层。
    expect(
      evidenceBundleSchema.safeParse(bundle({ claims: [] })).success,
    ).toBe(true);
  });

  it("refs 里含空串 → 拒绝（空串是「非空数组」最常见的蒙混方式）", () => {
    const r = evidenceBundleSchema.safeParse(
      bundle({ claims: [{ text: "x", evidence_refs: [""] }] }),
    );
    expect(r.success).toBe(false);
  });

  it("sha256 必须是 64 位小写十六进制", () => {
    const art = (sha: string): unknown => [
      { path: "a.ts", sha256: sha, bytes: 3 },
    ];
    expect(
      evidenceBundleSchema.safeParse(
        bundle({ artifacts: art("x".repeat(64)) }),
      ).success,
    ).toBe(false);
    expect(
      evidenceBundleSchema.safeParse(
        bundle({ artifacts: art(sha256Text("hi").toUpperCase()) }),
      ).success,
    ).toBe(false);
    expect(
      evidenceBundleSchema.safeParse(
        bundle({ artifacts: art(sha256Text("hi").slice(0, 63)) }),
      ).success,
    ).toBe(false);
    expect(
      evidenceBundleSchema.safeParse(
        bundle({ artifacts: art(sha256Text("hi")) }),
      ).success,
    ).toBe(true);
  });

  it("bytes 不得为负或小数", () => {
    for (const b of [-1, 1.5]) {
      expect(
        evidenceBundleSchema.safeParse(
          bundle({ artifacts: [{ path: "a", sha256: sha256Text("x"), bytes: b }] }),
        ).success,
      ).toBe(false);
    }
  });

  it("bundle_type 只认六个值；approval_card 也在内", () => {
    for (const t of [
      "spec",
      "design",
      "code_diff",
      "test_report",
      "ops_plan",
      "approval_card",
    ]) {
      expect(
        evidenceBundleSchema.safeParse(bundle({ bundle_type: t })).success,
      ).toBe(true);
    }
    // 附录 C 的旧口径（'prd' / 'tech_plan'）不再被接受 —— 以本 schema 为准（§5.11）
    expect(
      evidenceBundleSchema.safeParse(bundle({ bundle_type: "prd" })).success,
    ).toBe(false);
  });

  it("多带未知字段 → 拒绝（strict）。放行的话，字段改名会伪装成『老字段还在』", () => {
    expect(
      evidenceBundleSchema.safeParse(bundle({ model_family: "claude" })).success,
    ).toBe(false);
  });

  it("metrics 只能收有限数值；NaN/Infinity 被拒", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        evidenceBundleSchema.safeParse(bundle({ metrics: { coverage: v } }))
          .success,
      ).toBe(false);
    }
    expect(
      evidenceBundleSchema.safeParse(bundle({ metrics: { coverage: 81.5 } }))
        .success,
    ).toBe(true);
  });
});

describe("引用可解性：refs 非空 ≠ 引用成立", () => {
  it("ref 指向包内制品路径 → 可解", () => {
    const b = valid({
      artifacts: [{ path: "artifacts/T-1/code_diff/x.diff", sha256: sha256Text("d"), bytes: 1 }],
      claims: [{ text: "看这个 diff", evidence_refs: ["artifacts/T-1/code_diff/x.diff"] }],
    });
    expect(unresolvableClaimIndexes(b)).toEqual([]);
  });

  it("ref 形如 path#锚点 → 去锚点后比对，仍算可解", () => {
    const b = valid({
      artifacts: [{ path: "a.md", sha256: sha256Text("a"), bytes: 1 }],
      claims: [{ text: "见 §3", evidence_refs: ["a.md#3"] }],
    });
    expect(unresolvableClaimIndexes(b)).toEqual([]);
  });

  it("ref 是 http(s) 外链 → 算可解（§8.1 允许外部链接类依据）", () => {
    const b = valid({
      claims: [{ text: "线上看板", evidence_refs: ["https://example.com/dash"] }],
    });
    expect(unresolvableClaimIndexes(b)).toEqual([]);
  });

  it("ref 指向从未声明的制品 → 报出该 claim 的下标（不是只报布尔）", () => {
    const b = valid({
      artifacts: [{ path: "a.md", sha256: sha256Text("a"), bytes: 1 }],
      claims: [
        { text: "有据", evidence_refs: ["a.md"] },
        { text: "没据", evidence_refs: ["ghost.md"] },
        { text: "也没据", evidence_refs: ["ghost2.md"] },
      ],
    });
    expect(unresolvableClaimIndexes(b)).toEqual([1, 2]);
  });

  it("file:// 之类的非 http 协议不算可解（口径写死：只认 http/https 与包内路径）", () => {
    const b = valid({
      claims: [{ text: "本机文件", evidence_refs: ["file:///etc/passwd"] }],
    });
    expect(unresolvableClaimIndexes(b)).toEqual([0]);
  });
});

describe("交接方向 → 该来的包类型", () => {
  it("五个方向各有唯一包类型", () => {
    expect(requiredBundleType("product_to_tech")).toBe("spec");
    expect(requiredBundleType("tech_to_dev")).toBe("design");
    expect(requiredBundleType("dev_to_test")).toBe("code_diff");
    expect(requiredBundleType("test_upward")).toBe("test_report");
    expect(requiredBundleType("ops_to_ceo")).toBe("ops_plan");
  });

  it("拼错方向名 → 抛错而不是 undefined（undefined 会让门控对拼错的方向静默放行）", () => {
    expect(() => requiredBundleType("dev_to_tset")).toThrow(/dev_to_tset/u);
  });
});

describe("制品落盘与路径安全（§5.10）", () => {
  it("路径形状为 {root}/{task_id}/{bundle_type}/{bundle_id}.{ext}", () => {
    const p = artifactPath(
      "/r",
      { task_id: "T-1", bundle_type: "code_diff", bundle_id: ID_A },
      "diff",
    );
    expect(p).toBe(join("/r", "T-1", "code_diff", ID_A + ".diff"));
  });

  it("三段中任何一段含分隔符或上跳 → 抛错", () => {
    const bad = ["../../etc", "a/b", "a\\b", "..", "."];
    for (const v of bad) {
      for (const key of ["task_id", "bundle_type", "bundle_id"] as const) {
        expect(() =>
          artifactPath("/r", { task_id: "T-1", bundle_type: "code_diff", bundle_id: ID_A, [key]: v }, "diff"),
        ).toThrow();
      }
    }
  });

  it("含 NUL 的路径段 → 抛错（NUL 截断是路径注入的经典手法）", () => {
    expect(() =>
      artifactPath(
        "/r",
        { task_id: "T-1\0evil", bundle_type: "code_diff", bundle_id: ID_A },
        "diff",
      ),
    ).toThrow(/NUL/u);
  });

  it("ext 里的非法字符被剥掉，不会造出第二个目录层级", () => {
    const p = artifactPath(
      "/r",
      { task_id: "T-1", bundle_type: "code_diff", bundle_id: ID_A },
      "../sh",
    );
    expect(p.endsWith(ID_A + ".sh")).toBe(true);
    expect(p).not.toContain("..");
  });

  it("artifactsRoot 的默认形状是 ~/.opc-os/artifacts", () => {
    expect(artifactsRoot("/home/u")).toBe(join("/home/u", ".opc-os", "artifacts"));
  });

  it("relativize 把绝对路径折回 root 相对，且越界路径抛错", () => {
    expect(relativize("/r", join("/r", "T-1", "x.diff"))).toBe("T-1/x.diff");
    expect(() => relativize("/r", "/etc/passwd")).toThrow(/越出根目录/u);
  });
});

describe("store.verify：完整性对账", () => {
  /**
   * 造一个真写过制品的包：写盘 → 用真实哈希建包。
   *
   * 【每次调用换一个 bundle_id】是必须的，不是洁癖。writeArtifact 拒绝在同一
   * bundle_id 下写不同内容（那正是「两份证据挂同一个身份」那个守卫），而本 describe
   * 里多个用例都要改文件内容 —— 共用一个 id 时，先跑的那个用例把改过的字节留在盘上，
   * 后跑的就被那个守卫挡住了。第一版正是这样：报错来自上一个用例留下的文件，
   * 看起来像 verify 的 bug。用例之间【互不留痕】，失败才只可能是本用例造成的。
   */
  let artifactSeq = 0;
  const nextId = (): string => {
    const h = (++artifactSeq).toString(16).padStart(32, "0");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-8" + h.slice(17, 20) + "-" + h.slice(20, 32);
  };

  async function withArtifact(
    body = "覆盖率 91%\n",
  ): Promise<{ store: EvidenceStore; b: EvidenceBundle; file: string }> {
    await migrated(); // 真 schema：这条路径也要能在迁移出来的库上跑
    const store = new EvidenceStore({
      root,
      exec: () => {},
      now: () => 1700000000000,
    });
    const id = nextId();
    const head = {
      task_id: "T-V",
      bundle_type: "test_report" as const,
      bundle_id: id,
    };
    const w = store.writeArtifact(head, "txt", body);
    // 落盘位置逐字对齐 §5.10：{root}/{task_id}/{bundle_type}/{bundle_id}.{ext}
    expect(w.absolute).toBe(join(root, "T-V", "test_report", id + ".txt"));
    // 而库里存的声明形状是 root 相对（不含主目录）—— 两件事必须都能拿到
    expect(w.declared).toBe("T-V/test_report/" + id + ".txt");
    const b = valid({
      task_id: head.task_id,
      bundle_type: head.bundle_type,
      bundle_id: head.bundle_id,
      artifacts: [{ path: w.declared, sha256: w.sha256, bytes: w.bytes }],
      claims: [{ text: "报告见文件", evidence_refs: [w.declared] }],
    });
    return { store, b, file: w.absolute };
  }

  it("写盘后对账通过；§6.4 的 artifacts/ 前缀写法也能解析到同一份文件", async () => {
    const { store, b, file } = await withArtifact();
    expect(file.startsWith(root)).toBe(true);
    const r = store.verify(b);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
    expect(r.failures).toEqual([]);

    // 同一份字节，声明成 §6.4 的 "artifacts/…" 形状 ⇒ 必须解析到同一个物理文件。
    // 这一条钉的是「两套样例口径只差一层前缀」这个判断；哪天有人改了基准目录，
    // 这条会红，而不是让线上出现「一种写法能验、另一种永远 missing」。
    const prefixed: EvidenceBundle = {
      ...b,
      artifacts: [
        {
          path: "artifacts/" + (b.artifacts[0]?.path as string),
          sha256: b.artifacts[0]?.sha256 as string,
          bytes: b.artifacts[0]?.bytes as number,
        },
      ],
    };
    expect(store.verify(prefixed).ok).toBe(true);
  });

  it("声明路径越出 root → 抛错，不去读 root 外的文件", async () => {
    // 这条防的不是「哈希对不上」而是【目录穿越】。旧实现缺包含性检查时，它会读到
    // 真实的 /etc/passwd 然后报 hash_mismatch —— 安全问题伪装成数据问题，最难查的那种。
    const { store, b } = await withArtifact();
    const escaped: EvidenceBundle = {
      ...b,
      artifacts: [
        { path: "../../../../etc/passwd", sha256: sha256Text("x"), bytes: 1 },
      ],
    };
    expect(() => store.verify(escaped)).toThrow(/越出根目录/u);
  });

  it("外链类制品不磁盘对账，计入 skipped 且不能报 ok", async () => {
    const { store } = await withArtifact();
    const b = valid({
      artifacts: [
        { path: "https://example.com/board", sha256: sha256Text("x"), bytes: 1 },
      ],
    });
    const r = store.verify(b);
    expect(r.checked).toBe(0);
    expect(r.skipped).toBe(1);
    // 没比对过 ⇒ 不能报 ok。外链的内容在对方服务器上，提交后还能被改掉，
    // schema 里那条 sha256 永远无从核对 —— 「全靠外链」的包是最不可验证的那种。
    expect(r.ok).toBe(false);
  });

  it("本地制品 + 外链混合时：ok=true 但 skipped 如实报出盲区", async () => {
    const { store, b } = await withArtifact();
    const mixed: EvidenceBundle = {
      ...b,
      artifacts: [
        ...(b.artifacts as EvidenceBundle["artifacts"]),
        {
          path: "https://example.com/board",
          sha256: sha256Text("x"),
          bytes: 1,
        },
      ],
    };
    const r = store.verify(mixed);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(1);
    // 盲区必须可见：只报 ok=true 会让「一条都没核对的外链」被读成「全部核对过」
    expect(r.skipped).toBe(1);
  });

  it("制品文件缺失 → ok=false，cause=missing", async () => {
    const { store, b, file } = await withArtifact();
    rmSync(file);
    const r = store.verify(b);
    expect(r.ok).toBe(false);
    expect(r.failures.map((f) => f.cause)).toEqual(["missing"]);
    // 文件没了就不能算 checked：否则「查了 1 个、1 个都不在」会被读成「查过了」
    expect(r.checked).toBe(0);
  });

  it("内容被改过但【字节数相同】→ hash_mismatch", async () => {
    // 两侧字节数【必须相同】：store 先比 size 再算哈希（省一次全文读），字节数一变
    // 就先落到 size_mismatch，哈希那一维根本没被走到 —— 那是下面那条用例的内容。
    // 用 ASCII 也是刻意的：「覆盖率 91%」改成「覆盖率 100%」会多 3 字节，同样验不到哈希。
    const body = "coverage 91%\n";
    const tamperedBody = "coverage 100%";
    expect(Buffer.byteLength(tamperedBody)).toBe(Buffer.byteLength(body));
    const { store, b, file } = await withArtifact(body);
    writeFileSync(file, tamperedBody, "utf8");
    const r = store.verify(b);
    expect(r.ok).toBe(false);
    const f = r.failures[0];
    expect(f?.cause).toBe("hash_mismatch");
    if (f?.cause === "hash_mismatch") {
      // 两侧都要报：只报「不符」的报错无法判断是声明写错还是文件被改
      expect(f.declared).toBe(b.artifacts[0]?.sha256);
      expect(f.actual).toBe(sha256Text(tamperedBody));
    }
  });

  it("字节数不符 → 先报 size_mismatch（不必再读全文算哈希）", async () => {
    const { store, b } = await withArtifact();
    const tampered: EvidenceBundle = {
      ...b,
      artifacts: [
        {
          path: b.artifacts[0]?.path as string,
          sha256: b.artifacts[0]?.sha256 as string,
          bytes: 999_999,
        },
      ],
    };
    const r = store.verify(tampered);
    expect(r.failures.map((f) => f.cause)).toEqual(["size_mismatch"]);
  });

  it("空 artifacts 的包 → ok=false（every() 在空数组上恒真是经典假绿）", async () => {
    await migrated();
    const store = new EvidenceStore({ root, exec: () => {}, now: () => 1 });
    const r = store.verify(valid({ claims: [] }));
    expect(r.ok).toBe(false);
    expect(r.checked).toBe(0);
    expect(r.failures.length).toBe(1);
  });

  it("同一 bundle_id 写不同内容 → 抛错（身份污染，不能静默覆盖）", async () => {
    await migrated();
    const store = new EvidenceStore({ root, exec: () => {}, now: () => 1 });
    const head = {
      task_id: "T-D",
      bundle_type: "spec" as const,
      bundle_id: ID_A,
    };
    store.writeArtifact(head, "md", "第一版");
    expect(() => store.writeArtifact(head, "md", "第二版")).toThrow(
      /同一 bundle_id/u,
    );
    // 同内容重复写是 no-op，不抛
    expect(() => store.writeArtifact(head, "md", "第一版")).not.toThrow();
  });
});

describe("store.register：写 evidence_bundles 那一行", () => {
  it("十个字段全部落库，JSON 列读回来与写入逐字对得上", async () => {
    const db = await migrated();
    const captured: { sql: string; params: readonly unknown[] }[] = [];
    const store = new EvidenceStore({
      root,
      exec: (sql, params) => {
        captured.push({ sql, params });
        // assigned_role / current_node 是 NOT NULL —— 这一行以前只填了五个字段，
        // 在真 schema 上必然 NOT NULL failed（夹具自己不合法，测不到被测方）。
        // 状态名用状态机里真实存在的值：现在 tasks.status 没有 CHECK，编一个也能写进去，
        // 但将来补上 CHECK 时这条会先红，而红在【夹具】比红在断言好读。
        db.exec(
          "INSERT INTO tasks (id, title, status, assigned_role, current_node, " +
            "created_at, updated_at) " +
            "VALUES ('T-R', 't', 'IN_PROGRESS', 'dev', 'implement', " +
            "1700000000000, 1700000000000)",
        );
        db.prepare(
          "INSERT INTO evidence_bundles (id, task_id, producer_role, bundle_type, artifacts, " +
            "self_check, created_at, model_family, claims, honesty_boundaries) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(...(params as never[]));
      },
      now: () => 1700000000123,
    });
    const b = valid({ task_id: "T-R" });
    store.register(b, { passed: true, note: "自检，非独立验证" });

    expect(captured.length).toBe(1);
    const row = db
      .prepare("SELECT * FROM evidence_bundles WHERE id = ?")
      .get(ID_A) as Record<string, unknown>;
    expect(row["producer_role"]).toBe("dev");
    expect(row["bundle_type"]).toBe("code_diff");
    expect(row["model_family"]).toBe("claude");
    expect(row["created_at"]).toBe(1700000000123);
    // 读回来要与写进去逐字一致 —— 这就是「不做 camelCase 改名层」那条不变量的可执行形态
    expect(JSON.parse(row["artifacts"] as string)).toEqual(b.artifacts);
    expect(JSON.parse(row["claims"] as string)).toEqual(b.claims);
    expect(JSON.parse(row["honesty_boundaries"] as string)).toEqual(
      b.honesty_boundaries,
    );
    expect(JSON.parse(row["self_check"] as string)).toEqual({
      passed: true,
      note: "自检，非独立验证",
    });
  });

  it("不传 selfCheck → 存 NULL，而不是字符串 \"undefined\"", async () => {
    const db = await migrated();
    let stored: unknown = "未调用";
    const store = new EvidenceStore({
      root,
      exec: (sql, params) => {
        void sql;
        stored = params[5];
      },
      now: () => 1,
    });
    store.register(valid());
    expect(stored).toBeNull();
  });
});
