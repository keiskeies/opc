/**
 * ui-caller-roster 的分母。两类输入各管一件事：
 * · 真仓库语料 —— 证明这张名单今天确实自洽，且【尺子量得出东西】（提取非空、
 *   已知有调用方的端点判成有调用方）。光靠合成语料证不了尺子没钝。
 * · 合成语料 —— 证明判据的每个分支各自会红，且红在它该红的那一格上。
 * 反向对照放了两发【真写法】的（0068 §4 那条：同一套扫描面对已知有调用方的东西必须非零命中）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkRoster,
  endpointPath,
  extractPathPatterns,
  hitsUi,
  isDegeneratePattern,
  NO_UI_CALLER_ROSTER,
  type NoUiCallerEntry,
  normalizePath,
  stripComments,
  UI_ROOT,
} from "./ui-caller-roster.js";

const ROOT: string = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".git", ".tmp", "dist", "vendor"]);

/** 被测源码里的模板插值起始串。拼出来而不写成字面量：这几串是【被测代码的字节】，
 *  直接写会被 biome 当成写错的模板串（noTemplateCurlyInString）。 */
const INTERP = "$" + "{";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** 真渲染侧：剥注释后提取路径模式。 */
function realUiPatterns(): ReadonlySet<string> {
  const files = walk(join(ROOT, UI_ROOT)).filter((f) =>
    /\.(js|html)$/u.test(f),
  );
  const all = new Set<string>();
  for (const f of files) {
    for (const p of extractPathPatterns(stripComments(readFileSync(f, "utf8"))))
      all.add(p);
  }
  return all;
}

/** 从契约里取 IMPLEMENTED_ENDPOINTS 的条目原文（与判据同一种取材形状）。 */
function realImplemented(): string[] {
  const src = readFileSync(
    join(ROOT, "packages", "contracts", "src", "api.ts"),
    "utf8",
  );
  const start = src.indexOf("export const IMPLEMENTED_ENDPOINTS");
  const block = src.slice(start, src.indexOf("];", start));
  return [...block.matchAll(/"((?:GET|POST|PATCH|PUT|DELETE) [^"]+)"/gu)].map(
    (m) => m[1] as string,
  );
}

const rosterOnly = (endpoints: readonly string[]): NoUiCallerEntry[] =>
  endpoints.map((endpoint) => ({ endpoint, reason: "【测试】合成理由" }));

describe("尺子：剥注释 + 提取路径表达式", () => {
  it("注释里的路径不算调用方（剥完就没，剥之前确实在）", () => {
    const src =
      'const a = 1; // 走 /bindings 这条路\n/* 另一条 /bindings/verify */\nrequest("/groups");';
    expect(src).toContain("/bindings");
    const stripped = stripComments(src);
    expect(stripped).not.toContain("/bindings");
    expect(stripped).not.toContain("/bindings/verify");
    const pats = extractPathPatterns(stripped);
    expect(pats.has("/groups")).toBe(true);
    expect(pats.has("/bindings")).toBe(false);
  });

  it("字符串里的双斜杠不被当成注释起点（否则半个文件会被吃掉）", () => {
    const src = 'const u = "http://x/api/thing"; request("/keep/me");';
    const pats = extractPathPatterns(stripComments(src));
    expect(pats.has("/keep/me")).toBe(true);
  });

  it("三种写法各归一成一个模式：模板插值 / 两段拼接 / 一段拼接", () => {
    // ⚠ 三种写法用【三条不同的路径】：共用同一条时，模板那条会把拼接那条的格子也喂绿
    // （变异机 M5「拼接不吃尾巴」第一版就是这么活下来的 —— 每根线要有自己的那次动作）。
    const src = [
      "request(`/members/" + INTERP + "encodeURIComponent(id)}/skills`);",
      'request("/documents/" + encodeURIComponent(id) + "/versions");',
      'api("GET", "/tasks/" + encodeURIComponent(id));',
    ].join("\n");
    const pats = extractPathPatterns(src);
    expect(pats.has("/members/{}/skills")).toBe(true);
    expect(pats.has("/documents/{}/versions")).toBe(true);
    expect(pats.has("/tasks/{}")).toBe(true);
  });

  it("query 被剥掉，非路径的字符串不会被误收", () => {
    const pats = extractPathPatterns(
      'request("/backlog?limit=200"); const c = "admin.css";',
    );
    expect(pats.has("/backlog")).toBe(true);
    expect(pats.has("admin.css")).toBe(false);
  });

  it("带空格的名字不收（这条由字符类挡，不是由「必须以 / 开头」挡）", () => {
    // 两根门是重叠的：startsWith("/") 挡掉 admin.css，字符类挡掉「带 / 但不是路径」的。
    // 各给一发，否则哪天删掉其中一根没人报警（0068 §4「每根线要有自己的那次动作」）。
    const pats = extractPathPatterns('label("/全部 待办 面板");');
    expect(pats.size).toBe(0);
  });

  it("裸斜杠不收（字符类要求 / 之后至少一个字符，否则它会盖住一切前缀）", () => {
    const pats = extractPathPatterns('const sep = "/"; request(sep + "org");');
    expect(pats.has("/")).toBe(false);
  });

  it("⭐ 分辨力：/approvals/{} 不等于 /approvals/{}/token（这正是那版钝尺子的死因）", () => {
    const pats = extractPathPatterns(
      'api("POST", "/approvals/" + encodeURIComponent(id));',
    );
    expect(pats.has("/approvals/{}")).toBe(true);
    expect(hitsUi("/approvals/{}/token", pats)).toBe(false);
    expect(hitsUi("/approvals/{}", pats)).toBe(true);
  });

  it("整条写死前缀的两种越写法都认（/api/v1/assets 与 /api/events）", () => {
    const pats = extractPathPatterns(
      'fetch("/api/events" + q); return `/api/v1/assets/' + INTERP + "x}`;",
    );
    expect(hitsUi("/events", pats)).toBe(true);
    expect(hitsUi("/assets/{}", pats)).toBe(true);
  });

  it("命中口径不是「后缀包含」（文件头批过的钝尺子形状，一边批一边用不行）", () => {
    // 这一发直接打在 hitsUi 上：语料里放整串 `/api/v1/dispatch/rules`，
    // 若口径退化成 endsWith，`/rules` 就被它喂绿 —— 变异机 M7 抓的就是这个。
    const pats = extractPathPatterns('request("/api/v1/dispatch/rules");');
    expect(pats.has("/api/v1/dispatch/rules")).toBe(true);
    expect(hitsUi("/api/v1/dispatch/rules", pats)).toBe(true);
    expect(hitsUi("/rules", pats)).toBe(false);
  });
});

describe("真仓库读数", () => {
  const implemented = realImplemented();
  const patterns = realUiPatterns();

  it("取材非空：尺子扫得出模式，契约表也取得出条目", () => {
    expect(implemented.length).toBeGreaterThan(50);
    expect(patterns.size).toBeGreaterThan(30);
  });

  it("⭐ 名单与今天的读数自洽（checkRoster 返回空串）", () => {
    expect(
      checkRoster({
        implemented,
        uiPatterns: patterns,
        roster: NO_UI_CALLER_ROSTER,
      }),
    ).toBe("");
  });

  it("反向对照：名单【之外】的端点在这一套提取下几乎全有调用方 —— 接线率是量出来的", () => {
    const listed = new Set(NO_UI_CALLER_ROSTER.map((e) => e.endpoint));
    const notListed = implemented.filter((e) => !listed.has(e));
    const withCaller = notListed.filter((e) =>
      hitsUi(normalizePath(endpointPath(e) as string), patterns),
    );
    // 断言的是「尺子能咬到大量端点」，不是某个具体分母：接线率低于九成 ⇒ 尺子钝了。
    expect(withCaller.length / notListed.length).toBeGreaterThan(0.9);
  });

  it("名单里每一条今天确实零调用方（名单自己复算，不靠 reason 里那句话）", () => {
    for (const e of NO_UI_CALLER_ROSTER) {
      expect(
        hitsUi(normalizePath(endpointPath(e.endpoint) as string), patterns),
      ).toBe(false);
    }
  });

  it("归一化在真契约上无碰撞（有碰撞时 checkRoster 先红，读数不作数）", () => {
    // 比对【不同路径】：67 条路径里 26 条挂了多个方法，条目级比对会把多方法当碰撞。
    const paths = [
      ...new Set(implemented.map((e) => endpointPath(e) as string)),
    ];
    const keys = paths.map((p) => normalizePath(p));
    expect(paths.length).toBeGreaterThan(50);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("同一路径挂多个方法不算碰撞（否则判据恒红，等于没有判据）", () => {
    expect(
      checkRoster({
        implemented: [
          "GET /tasks",
          "POST /tasks",
          "PATCH /tasks/:id",
          "DELETE /tasks/:id",
        ],
        uiPatterns: new Set(["/tasks", "/tasks/{}"]),
        roster: [],
      }),
    ).toBe("");
  });
});

describe("判据本体（合成语料：每一发对应一处能让名单静默失效的改法）", () => {
  const basePatterns = new Set(["/tasks", "/org"]);
  const base: Parameters<typeof checkRoster>[0] = {
    implemented: ["GET /tasks", "POST /org", "DELETE /tasks/:id"],
    uiPatterns: basePatterns,
    roster: rosterOnly(["DELETE /tasks/:id"]),
  };

  it("自洽时返回空串", () => {
    expect(checkRoster(base)).toBe("");
  });

  it("⭐ 归一化有碰撞 ⇒ 红，且红在归一那一格", () => {
    const msg = checkRoster({
      ...base,
      implemented: [
        "GET /a/:x/b",
        "GET /a/:y/b",
        "GET /tasks",
        "POST /org",
        "DELETE /tasks/:id",
      ],
    });
    expect(msg).toContain("归一化");
  });

  it("⭐ 名单外的零调用方端点 ⇒ 红（新写的缺口不能静默入库）", () => {
    const msg = checkRoster({
      ...base,
      implemented: [...base.implemented, "GET /brand-new"],
    });
    expect(msg).toContain("名单外");
    expect(msg).toContain("GET /brand-new");
  });

  it("⭐ 名单内出现了调用方 ⇒ 红（双向判的另一半：接了线就得回来改主张）", () => {
    const msg = checkRoster({
      ...base,
      uiPatterns: new Set([...basePatterns, "/tasks/{}"]),
    });
    expect(msg).toContain("有】渲染侧调用方");
  });

  it("名单里留了已从契约消失的端点 ⇒ 红；名单空掉不算错", () => {
    // 契约收缩后端点整条没了 ⇒ 空名单自洽（否则「删干净」反而被拦）；
    // 但【留着】一条已不存在的登记必须红 —— 那一格现在守的是一个不存在的东西。
    expect(
      checkRoster({
        ...base,
        implemented: ["GET /tasks", "POST /org"],
        roster: [],
      }),
    ).toBe("");
    const msg = checkRoster({
      ...base,
      implemented: ["GET /tasks", "POST /org"],
      roster: rosterOnly(["DELETE /tasks/:id", "GET /gone/away"]),
    });
    expect(msg).toContain("已不在 IMPLEMENTED_ENDPOINTS");
  });

  it("没有理由的登记 ⇒ 红（缺口不能靠空格登记成豁免）", () => {
    const msg = checkRoster({
      ...base,
      roster: [{ endpoint: "DELETE /tasks/:id", reason: "   " }],
    });
    expect(msg).toContain("没有理由");
  });

  it("同一条端点登记两次 ⇒ 红", () => {
    const msg = checkRoster({
      ...base,
      roster: [...base.roster, ...base.roster],
    });
    expect(msg).toContain("登记了两次");
  });

  it("⭐ 恒真形状的登记 ⇒ 红（`/:x` 归一后是 /{}，一条盖住任意路径）", () => {
    expect(isDegeneratePattern("/{}")).toBe(true);
    expect(isDegeneratePattern("/bindings")).toBe(false);
    const msg = checkRoster({
      ...base,
      implemented: [...base.implemented, "GET /:x"],
      roster: [...base.roster, ...rosterOnly(["GET /:x"])],
    });
    expect(msg).toContain("没有字面段");
  });

  it("契约表换了写法（取材解析不动）⇒ 红在取材而不是退回「全对」", () => {
    const msg = checkRoster({
      ...base,
      implemented: ["tasks.list", "org.create", "tasks.get"],
    });
    expect(msg).toContain("解析不出路径");
  });

  it('端点条目形状：两段才算，多段与空串退回 ""', () => {
    expect(endpointPath("GET /tasks")).toBe("/tasks");
    expect(endpointPath("GET")).toBe("");
    expect(endpointPath("")).toBe("");
  });
});

describe("名单内容：reason 必须说得出三类处置之一", () => {
  it("每一条都带【判断】/【覆盖】/【排期】之一 —— 三种以外就是没分类", () => {
    for (const e of NO_UI_CALLER_ROSTER) {
      expect(e.reason).toMatch(/【判断】|【覆盖】|【排期】/u);
    }
  });

  it("名单不重复，且端点条目形如 `METHOD /path`", () => {
    const set = new Set(NO_UI_CALLER_ROSTER.map((e) => e.endpoint));
    expect(set.size).toBe(NO_UI_CALLER_ROSTER.length);
    for (const e of NO_UI_CALLER_ROSTER) {
      expect(endpointPath(e.endpoint)).not.toBe("");
    }
  });
});
