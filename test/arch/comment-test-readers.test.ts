/**
 * 第 31 道门禁：生产源码注释里点名的测试文件必须存在。
 *
 * 两半各管一件事，缺一不可：
 *  · 合成夹具那一半证明【判据有牙齿】—— 真仓库全绿本身说明不了任何事，
 *    取材坏了也绿（同 doc-refs / plan-gate-paths 的两段式形状）。
 *  · 真数据那一半钉住【今天确实干净】，并把两个数钉成断言：语料大小、引用条数，
 *    以及 retracted 的条数。数字一变就得重读那些撤回段，不许默默放过新增。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  missingReaders,
  type TestReaderRef,
  testReaderRefs,
} from "./comment-test-readers.js";
import { isRuntimeFixture } from "./run-fixtures.js";

const ROOT = join(__dirname, "../..");

/* ══════════════ 一、合成夹具：判据本身有判别力 ══════════════ */

/** 造一条引用，省掉夹具里重复的 file/line。 */
function ref(name: string, commentLine = "红的是 " + name): TestReaderRef {
  return { file: "packages/hub/src/x.ts", line: 1, name, commentLine };
}

const run = (
  refs: readonly TestReaderRef[],
  present: readonly string[],
  retracted: string[] = [],
  corpusSize = 1,
) => missingReaders(refs, (b) => present.includes(b), retracted, corpusSize);

describe("判据：点名了就要有那个文件", () => {
  it("控制的对照组：名字在场 ⇒ 0 条（否则本节是恒红装饰）", () => {
    expect(run([ref("real.test.ts")], ["real.test.ts"])).toEqual([]);
  });

  it("⭐ 名字查无此物 ⇒ 红，且报出是哪一行点的名", () => {
    const bad = run([ref("ghost.test.ts")], ["real.test.ts"]);
    expect(bad).toHaveLength(1);
    expect(bad[0]?.name).toBe("ghost.test.ts");
    expect(bad[0]?.file).toBe("packages/hub/src/x.ts");
  });

  it("按【基名】判：写全路径也算命中，住址漂了不算缺陷", () => {
    const r = testReaderRefs(
      "packages/hub/src/x.ts",
      "// 见 test/arch/deep/real.test.ts\nexport const a = 1;\n",
    );
    expect(r.map((x) => x.name)).toEqual(["real.test.ts"]);
    expect(run(r, ["real.test.ts"])).toEqual([]);
  });

  it("⭐ 只取注释：字符串字面量里的假名字不算引用", () => {
    // 这条是整套取材的地基。扫全文的话，fixture 里存的「看着像引用」的数据
    // 会变成引用（doc-refs 与 comment-citations 的文件头各记过一次同一个理由）。
    const src =
      'export const FIXTURE = "红的是 notATestFile.test.ts";\n' +
      "// 真正的注释里点名 real.test.ts\n";
    expect(testReaderRefs("p/src/x.ts", src).map((r) => r.name)).toEqual([
      "real.test.ts",
    ]);
  });
});

describe("【撤回】豁免：可数，且只在行首生效", () => {
  it("行首带标记 ⇒ 不报，但进 retracted 名单（错误事实不许静默删）", () => {
    const retracted: string[] = [];
    const r = [ref("gone.test.ts", "【撤回】原文说红的是 gone.test.ts")];
    expect(run(r, [], retracted)).toEqual([]);
    expect(retracted).toEqual(["packages/hub/src/x.ts:1 → gone.test.ts"]);
  });

  it("⭐ 标记不在行首 ⇒ 仍然红（否则一段讲豁免的注释会自己扩大豁免范围）", () => {
    const r = [ref("gone.test.ts", "注意：这里不使用【撤回】标记")];
    expect(run(r, [], [])).toHaveLength(1);
  });
});

describe("反假绿：0 不等于干净", () => {
  it("语料为空 ⇒ 红，不是「0 条缺陷」", () => {
    expect(missingReaders([ref("a.test.ts")], () => true, [], 0)).toEqual([
      { file: "<语料>", line: 0, name: "<一个源文件都没扫到>" },
    ]);
  });

  it("⭐ 有文件但一条引用都取不出 ⇒ 红（取材坏了会伪装成干净）", () => {
    expect(run([], ["a.test.ts"], [], 120)).toEqual([
      { file: "<语料>", line: 0, name: "<注释里一个测试文件名都没取到>" },
    ]);
  });
});

/* ══════════════ 二、真仓库 ══════════════ */

/**
 * 语料 = packages/**\/src/** 的 .ts/.tsx（范围为什么这么窄见实现文件头）。
 *
 * ⚠ 两处 walk 都过 `isRuntimeFixture`：dependency-boundary.test.ts 会往真源码目录里
 * 临时放一个探针文件（不放进去就证明不了 biome 边界真的挡），
 * 那个文件活着的那几百毫秒里任何并行的源码扫描都会看见它 —— 本守卫会把它当成
 * 「注释里点名了一个不存在的测试文件」而【随机红】。round277 数过这一族，
 * 漏接的四个全是「单跑恒绿、全量偶发红」。
 * ⚠ 这里刻意【不写探针的文件名】：那个字面量只许定义在 run-fixtures.ts 里，
 *    而 production-deps 有一发按【全文包含】查硬编码的消费者 —— 注释里提一句就会自我命中。
 *    接法口径见 production-deps.test.ts 那张 NEEDS/OUT_OF_SCOPE 清单。
 */
function srcCorpus(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (isRuntimeFixture(e.name)) continue;
      else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
    }
  };
  for (const pkg of readdirSync(join(ROOT, "packages"))) {
    const src = join(ROOT, "packages", pkg, "src");
    try {
      walk(src);
    } catch {
      /* 这个包没有 src 目录 */
    }
  }
  return out;
}

/** 全仓所有测试文件的基名（存在性按基名判，见实现文件头第二条收窄）。 */
function testBasenames(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (isRuntimeFixture(e.name)) continue;
      else if (e.name.endsWith(".test.ts") || e.name.endsWith(".test.tsx"))
        out.add(e.name);
    }
  };
  walk(ROOT);
  return out;
}

describe("真仓库：生产注释指派的读者都在场", () => {
  const files = srcCorpus();
  const refs = files.flatMap((f) =>
    testReaderRefs(
      f
        .slice(ROOT.length + 1)
        .split("\\")
        .join("/"),
      readFileSync(f, "utf8"),
    ),
  );
  const names = testBasenames();
  const retracted: string[] = [];
  const bad = missingReaders(
    refs,
    (b) => names.has(b),
    retracted,
    files.length,
  );

  it("一条都不缺（缺了就把具体是哪一行打出来）", () => {
    expect(
      bad
        .map((b) => b.file + ":" + b.line + " 点名了不存在的 " + b.name)
        .join("\n"),
    ).toBe("");
  });

  it("语料与取材都真的在跑（防「什么都没读到」换来的绿）", () => {
    expect(files.length).toBeGreaterThan(80);
    expect(refs.length).toBeGreaterThan(50);
  });

  it("retracted 的条数是账，改动它必须重读撤回段", () => {
    // 现数（round290）：1 条 —— replay/search.ts 那条【撤回】，
    // 原文给一条从未存在的 package-deps.test.ts 作证。
    // 数字往上走 = 有人又写了假证人然后贴标记；往下走 = 撤回记录被人静默删了。
    // 两个方向都要人来看一眼，所以钉死而不是给个下界。
    expect(retracted).toEqual([
      "packages/hub/src/replay/search.ts:50 → package-deps.test.ts",
    ]);
  });

  it("真数据里至少有一条【有读者】的引用（否则上面那发是空转）", () => {
    // 上面那条「0 条缺陷」可以被两种相反的东西满足：全都对，或者一条都没取到。
    // 前一条断言的 refs>50 挡的是后者，这一发再钉一个更具体的形状：
    // 存在性判据【真的命中过】，不是每次都走到「查无此物」那一支。
    const hits = refs.filter((r) => names.has(r.name));
    expect(hits.length).toBeGreaterThan(40);
  });
});
