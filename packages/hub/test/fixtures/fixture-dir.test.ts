/**
 * 测试夹具目录必须按进程分开 —— 判据的用例，本体在 fixture-dir.ts。
 *
 * ── 触发它的是三次红，不是一个猜想 ─────────────────────────────────
 * 同一批 db 测试文件，顺序跑 89 / 87 / 2，两条并发跑 89 / 84 / 5 与 89 / 82 / 7，
 * 而**两串红互不相同**，报的是 `file is not a database` / errcode 1555 ——
 * 成因是 33 个测试文件把夹具目录写成固定名，`beforeAll` 又整目录 rmSync，
 * 于是两条运行互相删对方正在用的库（0025 §7 第 7 条记过，判后留给独立一篇）。
 *
 * ── 本文件里每条「判据有判别力」的断言都不是装饰 ────────────────────
 * 这条守卫是**源码普查**，而源码普查最容易坏成恒绿：正则写宽/写窄、
 * 或者射程算错（转换做完之后文件里不再有 `".tmp"` 字面量，
 * 「只看 .tmp」的射程会把所有文件排除掉 ⇒ `no-cleanup` 那一支永远走不到）。
 * 所以每一条主断言旁边都有一条**同夹具的反向对照**，
 * 而 `stripComments` 那发用的是「确实剥掉了东西而骨架还在」那三元元断言
 * （形状来自 `bindings/im.test.ts` 那条「先自检剥注释确实剥掉了东西」的元断言，
 * 0019 §5 第 4 条那次原地重犯换来的）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createsTmpDir,
  explainFixtureDirHit,
  fixtureDirHits,
  fixtureRoot,
  fixtureTmp,
  fixedTmpDirNames,
  GUARD_SELF_PATHS,
  helperFixtureNames,
  inScopeForFixtureGuard,
  isPidAlive,
  pidOfFixtureDir,
  staleFixtureDirs,
  stripComments,
} from "./fixture-dir.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 仓库根。`test/fixtures` 距根**四级**（fixtures → test → hub → packages → 根）。
 * 这一行第一次写成三级，得到的根是 `packages/`，于是第二棵树算成 `packages/test`
 * 而 ENOENT —— 报的是「找不到目录」，而错的是我自己数的层数。
 */
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
/** 判据扫的两棵树（与 vitest 的 include 同域）。 */
const SCAN_ROOTS = [resolve(HERE, ".."), join(REPO_ROOT, "test")];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".tmp" || e.name === "node_modules" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** 真仓库的两棵树，键是相对仓库根的路径（报错里要能直接点得开）。 */
function realSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const root of SCAN_ROOTS) {
    for (const abs of walk(root)) {
      const rel = abs.slice(REPO_ROOT.length + 1);
      out.set(rel, readFileSync(abs, "utf8"));
    }
  }
  return out;
}

describe("① 名字与属主：pid 后缀那一格的三种认法", () => {
  it("末尾那组数字才是属主：schema-0001-4242 的 pid 是 4242，不是 0001", () => {
    // 从前往后数的话，一份泄漏的 schema-0001 目录会被认成 pid 1
    // （macOS 上 launchd 恒在 ⇒ 永不清理），而更坏的是别的名字可能
    // 恰好撞上一个活着的无关 pid ⇒ 清理会去删别人的活目录。
    expect(pidOfFixtureDir("schema-0001-4242", "schema-0001")).toBe(4242);
    expect(pidOfFixtureDir("perf-9", "perf")).toBe(9);
  });

  it("三种「不该被清理」的形状各自认不出 pid", () => {
    expect(pidOfFixtureDir("bench", "bench")).toBeNull(); // 没后缀（bench-recompute.mjs 的产物）
    expect(pidOfFixtureDir("perf-x", "perf")).toBeNull(); // 后缀不是数字
    expect(pidOfFixtureDir("budget-12", "budget-sync")).toBeNull(); // 别人的名字
    expect(pidOfFixtureDir("budget-sync-12", "budget-sync")).toBe(12); // 反向对照
  });

  it("清理名单只收「同名字 + pid 已死 + 不是我们自己」", () => {
    const entries = [
      "migrate-111", // 死了 ⇒ 收
      "migrate-222", // 活着 ⇒ 不收
      "migrate-333", // 是我们自己 ⇒ 不收
      "migrate-x", // 不认 ⇒ 不收
      "migrate-cli-111", // 名字不同 ⇒ 不收（前缀重合是这一发的关键）
      "bench", // 无后缀 ⇒ 不收
    ];
    const got = staleFixtureDirs(entries, "migrate", 333, (pid) => pid === 222);
    expect(got).toEqual(["migrate-111"]);
  });

  it("反向对照：全活 ⇒ 一个都不该收（否则清掉的是别人正在用的库）", () => {
    expect(staleFixtureDirs(["migrate-111", "migrate-222"], "migrate", 999, () => true)).toEqual(
      [],
    );
  });

  it("探活函数自己：我们自己恒在，0 与负数恒不在", () => {
    // 这一发不是凑数：isPidAlive 恒真的话 staleFixtureDirs 交空表（漏清理，静默），
    // 恒假的话它会删掉并发那条运行正在用的目录 —— 本篇存在的理由本身。
    expect(isPidAlive(process.pid)).toBe(true);
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    // 一个几乎不可能存在的 pid。真跑起来 pid 上限远小于此（本机实测见 0035 §读数）。
    expect(isPidAlive(4_194_304)).toBe(false);
  });
});

describe("② fixtureTmp：路径形状与「不建目录」", () => {
  it("目录名 = <名字>-<本进程 pid>", () => {
    const dir = fixtureTmp("guardprobe", import.meta.url);
    expect(dir).toBe(join(fixtureRoot(import.meta.url), `guardprobe-${process.pid}`));
  });

  it("夹具根锚定 import.meta.url，不锚定 cwd", () => {
    const root = fixtureRoot(import.meta.url);
    expect(root.endsWith(join("packages", "hub", ".tmp"))).toBe(true);
    // 反向对照：cwd 是仓库根时它俩才相同，所以必须显式比一个不等于 cwd 的位置。
    expect(root).not.toBe(join(process.cwd(), ".tmp"));
  });

  it("非 file:// 的 callerUrl 必须抛，而不是悄悄落到别处", () => {
    // 名字用两字符以上：单字符会被 NAME_PATTERN 先拦掉（它要求首尾都是字母数字），
    // 那就变成在测另一条判据了 —— 我第一次就写了 "x"，红的是名字那发。
    expect(() => fixtureTmp("probe", "packages/hub/test/http/server.test.ts")).toThrow(
      /import\.meta\.url/,
    );
  });

  it("非法夹具名抛错：它会直接拼进磁盘路径", () => {
    for (const bad of ["", "Upper", "with space", "../escape", "trailing-"]) {
      expect(() => fixtureTmp(bad, import.meta.url), bad).toThrow(/夹具名/);
    }
  });

  it("prune:false 只是关清理，路径一字不变（判据要能单独钉住那一支）", () => {
    expect(fixtureTmp("guardprobe", import.meta.url, { prune: false })).toBe(
      fixtureTmp("guardprobe", import.meta.url),
    );
  });

  it("opts.root 换根时不碰默认根（test/poc 那一处靠这一格留在仓库根的 .tmp）", () => {
    const dir = fixtureTmp("guardprobe", import.meta.url, {
      root: "/tmp/definitely-not-a-fixture-root",
      prune: false,
    });
    expect(dir).toBe(`/tmp/definitely-not-a-fixture-root/guardprobe-${process.pid}`);
  });
});

describe("③ 判据本体：两条子判据各自能被打开", () => {
  /** 一份「已经转换完」的样子：走 helper + afterAll 里清 TMP。 */
  const CONVERTED = `
import { afterAll } from "vitest";
import { fixtureTmp } from "./fixture-dir.js";
const TMP = fixtureTmp("demo", import.meta.url);
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
`;

  it("⭐ 第一段是【调用】而不是标识符时也必须认出来", () => {
    // 这一发是被变异 O-B 逼出来的，不是补装饰：我原先的正则把第一段写成
    // `[^,()]+`，于是 `join(process.cwd(), ".tmp", "x")` 这种写法**完全看不见**，
    // 实测把 migrate.test.ts 改回那种固定名之后普查**零命中**。
    // 而 `join(process.cwd(), ".tmp", …)` 恰恰是「新建一个夹具」最省事的写法，
    // 判据照绿 ⇒ 竞态回来而没人报警。
    for (const src of [
      `const TMP = join(process.cwd(), ".tmp", "demo");`,
      `const TMP = join(resolve(a, b), ".tmp", "demo");`,
      `const TMP = join(HUB, ".tmp", "demo");`, // 原写法，反向对照
    ]) {
      expect(fixedTmpDirNames(src), src).toEqual(["demo"]);
      const hits = fixtureDirHits(new Map([["packages/hub/test/a/x.test.ts", src]]));
      expect(hits.length, src).toBe(1);
    }
  });

  it("已知漏口如实报数：第一段是两层嵌套时仍认不出", () => {
    // 记下来而不是修：修它要真解析 AST，代价与收益不称（0035 §别当成做到了）。
    // 这一发钉的是【漏口存在】这件事本身 —— 万一将来有人把判据当全知用，它会说话。
    const deep = `const TMP = join(a(b(c())), ".tmp", "demo");`;
    expect(fixedTmpDirNames(deep)).toEqual([]);
    expect(inScopeForFixtureGuard(deep)).toBe(true); // 在射程里，只是认不出
  });

  it("阳性对照：固定名的 join 被认出来", () => {
    const hits = fixtureDirHits(
      new Map([["packages/hub/test/a/x.test.ts", `const TMP = join(HUB, ".tmp", "demo");`]]),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.why).toBe("fixed-name");
    expect(hits[0]?.names).toEqual(["demo"]);
  });

  it("转换完的样子零命中（同一份判据的另一侧）", () => {
    expect(fixtureDirHits(new Map([["packages/hub/test/a/x.test.ts", CONVERTED]]))).toEqual([]);
  });

  it("⭐ no-cleanup 那一支真的走得通：用了 helper 而没清理 ⇒ 命中", () => {
    // 这一发是本判据最容易被写成恒不成立的地方：转换做完之后源码里
    // 不再有任何 ".tmp" 字面量，射程若只按 ".tmp" 算，这一支永远不执行。
    const noCleanup = CONVERTED.replace(
      /afterAll\([\s\S]*\}\);\n?/u,
      "",
    );
    expect(noCleanup).toContain('fixtureTmp("demo"');
    expect(noCleanup).not.toContain("rmSync");
    const hits = fixtureDirHits(new Map([["packages/hub/test/a/x.test.ts", noCleanup]]));
    expect(hits).toHaveLength(1);
    expect(hits[0]?.why).toBe("no-cleanup");
    expect(hits[0]?.names).toEqual(["demo"]);
  });

  it("射程不靠 \".tmp\" 字面量：转换后的源码仍在射程内", () => {
    expect(CONVERTED.includes('".tmp"')).toBe(false);
    expect(createsTmpDir(CONVERTED)).toBe(false);
    expect(inScopeForFixtureGuard(CONVERTED)).toBe(true);
  });

  it("「跳过名单」那种 .tmp 用法不算建目录", () => {
    // 全仓有 4 处把 .tmp 列进扫描跳过名单（e.name === ".tmp"）。
    // 要求名单带 pid 是荒谬的：磁盘上那个目录名恒为 .tmp，写成 .tmp-4242 才是真错。
    const skipList = `const SKIP = new Set(["node_modules", ".tmp"]);\nif (SKIP.has(name)) continue;`;
    expect(createsTmpDir(skipList)).toBe(false);
    expect(fixtureDirHits(new Map([["test/arch/y.test.ts", skipList]]))).toEqual([]);
  });

  it("名字是变量时不报，但也绝不假装它合法（射程照旧）", () => {
    const src = `const TMP = join(HUB, ".tmp", NAME);`;
    expect(fixedTmpDirNames(src)).toEqual([]);
    expect(inScopeForFixtureGuard(src)).toBe(true); // 在射程里，只是这一条认不出
    // 已知漏口（0035 §别当成做到了）：它不报。写宽会把人推向「改成字面量」这种绕法。
    expect(fixtureDirHits(new Map([["packages/hub/test/a/z.test.ts", src]]))).toEqual([]);
  });

  it("helper 名字解析只吃字面量", () => {
    expect(helperFixtureNames(`fixtureTmp("demo", import.meta.url)`)).toEqual(["demo"]);
    expect(helperFixtureNames(`fixtureTmp(name, import.meta.url)`)).toEqual([]);
  });

  it("报错文案给出**改法**而不是只说违规", () => {
    const hit = fixtureDirHits(
      new Map([["packages/hub/test/a/x.test.ts", `join(HUB, ".tmp", "demo")`]]),
    )[0]!;
    const text = explainFixtureDirHit(hit);
    expect(text).toContain("fixtureTmp(");
    expect(text).toContain("demo");
    // 症状也得写进去：下一个撞上同样红的人靠那三个词认出这是同一件事。
    expect(text).toContain("file is not a database");
  });

  it("剥注释：先证明它确实剥掉了东西（否则两条 not 断言会恒绿）", () => {
    const src = `/** join(HUB, ".tmp", "quoted-in-doc") */\n// join(HUB, ".tmp", "in-line")\nconst x = 1;\n`;
    const code = stripComments(src);
    expect(code.length).toBeLessThan(src.length - 20); // 真剥掉了
    expect(code).toContain("const x = 1;"); // 骨架还在
    expect(code).not.toContain("quoted-in-doc");
    // 反向对照：文档里那份**没剥之前**是会被认成命中的 —— 这就是必须先剥的证据。
    expect(fixedTmpDirNames(src)).toEqual(["quoted-in-doc", "in-line"]);
    expect(fixedTmpDirNames(code)).toEqual([]);
  });
});

describe("④ 真仓库普查：一棵树上不许再有两个进程共用一份夹具目录", () => {
  it("两棵树都扫到了（射程不是一棵空树）", () => {
    const files = realSources();
    expect(files.size).toBeGreaterThan(80);
    const inScope = [...files].filter(([, s]) => inScopeForFixtureGuard(stripComments(s)));
    expect(inScope.length).toBeGreaterThan(25);
    // ⚠ 断言的是「helper 用了几处」而不是「恰好 33」：数字会随测试文件增删变，
    // 而它唯一要证的是 `no-cleanup` 那一支有东西可判（不是恒不执行的装饰）。
    const helperFiles = inScope.filter(
      ([, s]) => helperFixtureNames(stripComments(s)).length > 0,
    );
    expect(helperFiles.length).toBeGreaterThan(25);
  });

  it("零命中：没有任何测试文件用固定名的夹具目录", () => {
    const hits = fixtureDirHits(realSources());
    expect(hits.map(explainFixtureDirHit)).toEqual([]);
  });

  it("每一条 fixtureTmp 的入参都是字面量（否则④那条普查证明不了什么）", () => {
    // 普查证的是「每个夹具目录都带 pid」，而它成立的前提是名字写得出来。
    // 写成 fixtureTmp(name, …) 的话，名字读不出 ⇒ 那一格变成看不见，而不是合法。
    const offenders: string[] = [];
    for (const [path, raw] of realSources()) {
      // 判据自己也调 fixtureTmp（自测那一组），而它里面那句
      // `export function fixtureTmp(` 同样匹配「一次调用」的形状 ——
      // 排除表必须与判据共用同一份，否则这条断言判的是判据本身。
      if (GUARD_SELF_PATHS.some((s) => path.endsWith(s))) continue;
      const code = stripComments(raw);
      const calls = (code.match(/fixtureTmp\(/gu) ?? []).length;
      if (calls === 0) continue;
      if (helperFixtureNames(code).length < calls) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it("例外表恰好两个文件，且都在扫描视野内", () => {
    const files = realSources();
    for (const self of GUARD_SELF_PATHS) {
      expect([...files.keys()].some((p) => p.endsWith(self)), self).toBe(true);
    }
    expect(GUARD_SELF_PATHS).toHaveLength(2);
    /*
     * ⚠ 下面这半段是**自我限定**，写出来是因为我原本给这一发配了更强的断言而它站不住。
     * 我第一版断言的是「去掉例外表，判据会命中 helper 自己」，实测**不成立**：
     * helper 拼的是模板字面量 `${name}-${process.pid}` 而不是字符串字面量，
     * `fixedTmpDirNames` 认不出它 ⇒ 即使不列例外，helper 也不命中。
     * 所以这条例外表**今天不是承重墙**。它防的是将来的另一种写法
     * （有人把 helper 里那行改成字符串拼接的固定名），而那种写法今天不存在。
     * 把这一格写成「它现在挡住了什么」就是假绿 —— 与 0033 §6 那条
     * 「今天恒绿的守卫要自己声明恒绿」同一件事。
     */
    const helper = files.get(
      [...files.keys()].find((p) => p.endsWith("test/fixtures/fixture-dir.ts"))!,
    )!;
    const code = stripComments(helper);
    expect(fixedTmpDirNames(code)).toEqual([]); // 例外表今天无实际作用，读数在此
    expect(inScopeForFixtureGuard(code)).toBe(true); // 而它在射程内（拼 .tmp 路径）
  });
});
