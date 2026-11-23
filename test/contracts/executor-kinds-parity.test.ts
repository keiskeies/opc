/**
 * EXECUTOR_KINDS（契约）与 0013 member_executors.kind 的 CHECK（DDL）逐字对齐。
 *
 * ── 位置为什么在仓库根 test/contracts/ ─────────────────────────────
 * contracts 包零测试依赖（见 test/org/validate.test.ts 文件头同一条先例），
 * 而这条守卫天生跨包：一侧 import @opc/contracts（走 dist，顺带证明前端拿得到），
 * 另一侧读 packages/hub/resources/migrations 的 SQL 文本。放任何一包内都别扭。
 *
 * ── 漂移的两种坏法（为什么必须双向断言）───────────────────────────
 *  DDL 收了第八种而契约没有 ⇒ 招聘 API 永远 422，那条 CHECK 白写；
 *  契约有而 DDL 没有 ⇒ 前端能提交、执行器能路由，落库瞬间 SQLite 拒绝，
 *  报错点（约束冲突）离病因（少了一条迁移）隔着整个调用链。
 *  单向断言只拦其中一种，所以两侧集合必须【相等】而不是包含。
 *
 * ── 反向对照（本仓纪律：判据必须在合成输入上有牙齿）────────────────
 * 真仓库全绿说明不了取材没坏：正则若匹配不到 CHECK，提取出空集合，
 * 「空 ⊆ 七元」成立 —— 单向判据就这样恒绿。下面的夹具把两侧各喂一个
 * 少一项/多一项的集合，确认双向断言真的会红。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EXECUTOR_KINDS, executorConfigSchema } from "@opc/contracts";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const MIG = join(
  ROOT,
  "packages",
  "hub",
  "resources",
  "migrations",
  "0013_members.sql",
);

/**
 * 从 member_executors 建表语句里抠出 kind 的 CHECK 枚举。
 *
 * 取材刻意分两步（先圈表块、再抠 CHECK）：直接全文扫 `('a','b',...)`
 * 会把同文件 hire_events.action 的枚举也扫进来 —— 那是另一张表的词表，
 * 混进来的症状恰好是「今天碰巧都绿，下次只改一边才红」。
 */
function ddlExecutorKinds(sql: string): string[] {
  const block = /CREATE TABLE member_executors \(([\s\S]*?)\n\);/u.exec(sql);
  if (block === null) {
    throw new Error("0013 里找不到 member_executors 建表块（取材坏了）");
  }
  const check = /kind\s+TEXT NOT NULL CHECK \(kind IN\s*\(([\s\S]*?)\)\)/u.exec(
    block[1] as string,
  );
  if (check === null) {
    throw new Error("member_executors 里找不到 kind 的 CHECK（取材坏了）");
  }
  return [...(check[1] as string).matchAll(/'([a-z-]+)'/gu)].map(
    (m) => m[1] as string,
  );
}

const ddl = ddlExecutorKinds(readFileSync(MIG, "utf8"));

describe("EXECUTOR_KINDS ↔ 0013 DDL 逐字对齐", () => {
  it("DDL 侧枚举非空且无重复（元守卫：提取退化成空集时本节不许全绿）", () => {
    expect(ddl.length).toBeGreaterThanOrEqual(7);
    expect(new Set(ddl).size).toBe(ddl.length);
  });

  it("两个集合相等（双向：DDL 不含契约的、契约不含 DDL 的，都不许有）", () => {
    expect(
      ddl.filter((k) => !(EXECUTOR_KINDS as readonly string[]).includes(k)),
      "DDL 收了契约里没有的执行器种类：招聘 API 会把它永远 422",
    ).toEqual([]);
    expect(
      (EXECUTOR_KINDS as readonly string[]).filter((k) => !ddl.includes(k)),
      "契约声明了 DDL 不收的执行器种类：落库瞬间才炸",
    ).toEqual([]);
  });

  it("每个契约 kind 都能用最小合法 config 过 executorConfigSchema", () => {
    // 判别联合的分支与 EXECUTOR_KINDS 也是同构关系：漏一个分支，
    // 对应 kind 在这里 parse 失败 —— 比招聘页 422 早一步暴露。
    const minimal: Record<string, Record<string, unknown>> = {
      "claude-cli": {},
      "codex-cli": {},
      "qoder-cli": {},
      "platform-webhook": { plugin_id: "p", tool_name: "t" },
      "builtin-plugin": { plugin_id: "p" },
      "pure-model": {},
      human: {},
    };
    for (const kind of EXECUTOR_KINDS) {
      const cfg = { kind, ...minimal[kind] };
      expect(
        executorConfigSchema.safeParse(cfg).success,
        `${kind} 的最小配置过不了判别联合`,
      ).toBe(true);
    }
  });
});

describe("反向对照：判据在合成输入上有牙齿", () => {
  it("DDL 多一种而契约没有 ⇒ 双向断言的红支抓到它", () => {
    const withExtra = [...ddl, "telepathy"];
    const drift = withExtra.filter(
      (k) => !(EXECUTOR_KINDS as readonly string[]).includes(k),
    );
    expect(drift).toEqual(["telepathy"]);
  });

  it("契约多一种而 DDL 没有 ⇒ 另一支抓到它", () => {
    const ddlMissing = ddl.filter((k) => k !== "human");
    const drift = (EXECUTOR_KINDS as readonly string[]).filter(
      (k) => !ddlMissing.includes(k),
    );
    expect(drift).toEqual(["human"]);
  });

  it("表块被改名 ⇒ 取材抛错而不是提取出空集合", () => {
    expect(() => ddlExecutorKinds("CREATE TABLE other (x INTEGER);")).toThrow(
      /取材坏了/u,
    );
    // 表块在但 CHECK 缺失，同样必须抛（空集合是这条守卫最危险的失效形状）。
    expect(() =>
      ddlExecutorKinds("CREATE TABLE member_executors (\n  x INTEGER\n);"),
    ).toThrow(/取材坏了/u);
  });
});
