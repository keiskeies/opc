/**
 * 测试语料类型棘轮的守卫（判据在 ./test-type-baseline.ts）。
 *
 * 分工与 ./lint-baseline.test.ts 逐字同构：**合成那一半是主力**。真仓库那一发
 * 只能证明「今天的数在表内」，证明不了「数变坏时判据会红」—— 后者只能靠变异拿到。
 * 这一族本仓已经量过三次（round274-M3 / round276-G4 / round278-C3）：
 * **真仓库那一发对「判据被改成不判」是完全瞎的**，它今天必然绿，因为它的期望
 * 就是照着今天写的。所以这个文件里合成变异占多数，不是凑数。
 *
 * ⚠ 本文件自己也在类型检查语料里（include 命中 `test` 下全部 `.ts`）⇒ 这里写的每一个
 *   合成路径【不许】长得像真目录，否则守卫把自己判红（§7 第 10/11/12 格那条
 *   自匹配坑，本仓已撞过四次）。合成目录一律用 `synthetic/…` 这种仓里不存在的名字。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countTypeErrorsByDir,
  diffTypeBaseline,
  dirOf,
  findTscCli,
  parseListFiles,
  parseTscOutput,
  runTypeCheck,
  staleTypeEntries,
  TYPE_BASELINE,
  type TypeErrorLike,
  toRepoRelative,
} from "./test-type-baseline.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** 本守卫用的 project（round277 立的那份探针，本轮把它接成棘轮）。 */
const TSCONFIG = ".workbuddy/tsconfig.tests.json";

/** 合成错：目录一律 `synthetic/…`，仓里【不存在】这个顶层目录。 */
function err(file = "synthetic/a/x.test.ts", code = "TS2322"): TypeErrorLike {
  return { file, code };
}

/** 逐条照抄基线的合成读数：用它当「恰好在基线上」的控制组。 */
function atBaseline(): TypeErrorLike[] {
  const out: TypeErrorLike[] = [];
  for (const b of TYPE_BASELINE) {
    for (let i = 0; i < b.atMost; i++) out.push(err(join(b.dir, "x.test.ts")));
  }
  return out;
}

describe("类型棘轮：计数与路径归一", () => {
  it("按目录分组，不按文件（配额是目录级的）", () => {
    const counts = countTypeErrorsByDir([
      err("synthetic/a/x.test.ts"),
      err("synthetic/a/y.test.ts"),
      err("synthetic/b/x.test.ts"),
    ]);
    expect([...counts.entries()]).toEqual([
      ["synthetic/a", 2],
      ["synthetic/b", 1],
    ]);
  });

  it("仓库根上直接放的文件归到 `.`，不会被并进某个目录", () => {
    expect(dirOf("vitest.config.ts")).toBe(".");
    expect(countTypeErrorsByDir([err("vitest.config.ts")]).get(".")).toBe(1);
  });

  it("⭐ 路径三种写法归一到同一个目录（不归一就会报一条假的『基线外新目录』）", () => {
    const win = "D:\\item\\opc\\packages\\hub\\test\\db\\a.test.ts";
    const abs = "D:/item/opc/packages/hub/test/db/b.test.ts";
    const rel = "packages/hub/test/db/c.test.ts";
    const upper = "d:/item/opc/packages/hub/test/db/d.test.ts";
    const counts = countTypeErrorsByDir(
      [win, abs, rel, upper].map((p) => err(toRepoRelative(p, ROOT))),
    );
    expect(counts.get("packages/hub/test/db")).toBe(4);
    expect(counts.size).toBe(1);
  });

  it("解析 tsc 的原始行：只认带位置的那一型，续行不算新的一发", () => {
    const out = [
      "packages/hub/test/db/x.test.ts(12,5): error TS2322: Type 'a' is not assignable.",
      "  Type 'undefined' is not assignable to type 'string'.",
      "test/org/y.test.ts(3,1): error TS2532: Object is possibly 'undefined'.",
      "",
      "Found 2 errors in 2 files.",
    ].join("\n");
    const parsed = parseTscOutput(out, ROOT);
    expect(parsed.errors).toEqual([
      { file: "packages/hub/test/db/x.test.ts", code: "TS2322" },
      { file: "test/org/y.test.ts", code: "TS2532" },
    ]);
    expect(parsed.unparsed).toBe(0);
  });

  it("解析不出来的行【计数】而不是静默丢弃（静默丢 = 少报，而少报是绿的）", () => {
    // TS18003 是真实存在的一型：config 没匹配到任何输入。它带 `: error TS` 但【不带】
    // `(行,列)` ⇒ 不是一条能归目录的错，于是它既不进配额也不进 errors。
    // 若静默丢弃，「include 一个文件都没命中」就会被读成「0 条类型错 ⇒ 绿」。
    const parsed = parseTscOutput(
      "error TS18003: No inputs were found in config file 'tsconfig.json'.",
      ROOT,
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.unparsed).toBe(1);
  });

  it("--listFilesOnly 只数本仓自己的 .ts：node_modules（含 lib 与 @types）不进下限", () => {
    const out = [
      "D:/item/opc/test/arch/a.ts",
      "D:/item/opc/packages/hub/test/b.ts",
      "D:/item/opc/node_modules/typescript/lib/lib.dom.d.ts",
      "D:/item/opc/node_modules/zod/index.d.ts",
      "D:/item/opc/packages/hub/src/c.ts",
      "/usr/lib/node_modules/typescript/lib/lib.d.ts",
    ].join("\n");
    // 3 而不是 2：src 下的文件也算「这次检查吃进去的语料」，
    // 下限要挡的是【语料被改窄】，不是【只有测试被检查】。
    expect(parseListFiles(out, ROOT)).toBe(3);
  });
});

describe("类型棘轮：判据", () => {
  it("恰好在基线上 ⇒ 绿（控制组：判据不是恒红装饰）", () => {
    expect(diffTypeBaseline(countTypeErrorsByDir(atBaseline()))).toBe("");
  });

  it("比基线少 ⇒ 绿（只许减不许增，往下调正是它鼓励的）", () => {
    const fewer = atBaseline().slice(
      0,
      TYPE_BASELINE.reduce((n, b) => n + b.atMost - 1, 0),
    );
    expect(diffTypeBaseline(countTypeErrorsByDir(fewer))).toBe("");
  });

  it("全修干净 ⇒ 绿（绝不造出一条恒不可能通过的验收命令）", () => {
    // 0055 / 0056 / 0057 / 0060 记了四遍的那件事：恒红的验收命令会被学会跳过。
    // round277 正是因为当时 289 条错【必须清零才绿】才刻意没接成门禁 —— 换成棘轮
    // 之后，「清零」是目标状态而不是前提。
    expect(diffTypeBaseline(new Map())).toBe("");
  });

  it("变异：某个已登记目录多一条 ⇒ 红，且红话点名是哪个目录、从几到几", () => {
    const mutated = [...atBaseline(), err("test/org/extra.test.ts")];
    const msg = diffTypeBaseline(countTypeErrorsByDir(mutated));
    expect(msg).toContain("test/org 15→16");
    expect(msg).toContain("只许减不许增");
  });

  it("⭐ 变异：总量【下降】而某个目录上涨 ⇒ 仍然红（按目录配额的全部理由）", () => {
    // 只钉总数的话这一发是【绿】的：下面这份读数的总数比基线还少 4 条，
    // 而 `test/org` 实实在在长了 1 条。round275 的 P4 量过同一件事 ——
    // 「一个被撑大的总数会替一个空掉的分区作证」，这里连「撑大」都不需要。
    const engine = TYPE_BASELINE.find(
      (b) => b.dir === "packages/hub/test/engine",
    );
    const org = TYPE_BASELINE.find((b) => b.dir === "test/org");
    if (engine === undefined || org === undefined) {
      throw new Error("基线里缺 engine 或 test/org 那一格");
    }
    const others = atBaseline().filter((e) => {
      const d = dirOf(e.file);
      return d !== engine.dir && d !== org.dir;
    });
    const mk = (dir: string, n: number): TypeErrorLike[] =>
      Array.from({ length: n }, () => err(join(dir, "x.ts")));
    // 总数：基线 291 → 这里 287（少 4），而 test/org 从 15 涨到 16。
    const mutated = [
      ...others,
      ...mk(engine.dir, engine.atMost - 20),
      ...mk(org.dir, org.atMost + 1),
    ];
    expect(mutated.length).toBeLessThan(atBaseline().length);
    const msg = diffTypeBaseline(countTypeErrorsByDir(mutated));
    expect(msg).toContain("test/org 15→16");
    expect(msg).not.toContain("engine");
  });

  it("变异：冒出基线外的新测试目录 ⇒ 红并点名（防『反正测试不在 tsc -b 射程里』混过去）", () => {
    const mutated = [
      ...atBaseline(),
      err("packages/hub/test/newdir/x.test.ts"),
    ];
    const msg = diffTypeBaseline(countTypeErrorsByDir(mutated));
    expect(msg).toContain("基线外的测试目录");
    expect(msg).toContain("packages/hub/test/newdir=1");
  });

  it("变异：新目录藏在一条已有错后面 ⇒ 仍然点名（不是『只看最大值』那种假判据）", () => {
    const msg = diffTypeBaseline(
      countTypeErrorsByDir([err("test/org/x.ts"), err("synthetic/new/y.ts")]),
    );
    expect(msg).toContain("synthetic/new");
  });

  it("变异：配额表被清空 ⇒ 任何读数都算『基线外』 ⇒ 红（清空不等于放弃判断）", () => {
    const msg = diffTypeBaseline(countTypeErrorsByDir(atBaseline()), []);
    expect(msg).toContain("基线外的测试目录");
  });

  it("某目录修到 0 条 ⇒ 报「请把这条豁免删掉」（豁免不许比现实活得久）", () => {
    const partial = new Map<string, number>([["test/org", 4]]);
    const stale = staleTypeEntries(partial);
    expect(stale).toContain("packages/hub/test/engine");
    expect(stale).not.toContain("test/org");
    expect(staleTypeEntries(countTypeErrorsByDir(atBaseline()))).toEqual([]);
  });

  it("⭐ 基线表自证：没有重复目录、没有 0 配额、每条都对应一个真存在的目录", () => {
    const dirs = TYPE_BASELINE.map((b) => b.dir);
    expect(new Set(dirs).size).toBe(dirs.length);
    expect(dirs.filter((d) => d.length === 0)).toEqual([]);
    expect(TYPE_BASELINE.every((b) => b.atMost > 0)).toBe(true);
    // 每条都要【现在还存在】：目录被删了而豁免还留着 = 一条永远不会红的空壳。
    // 这一发是那条「豁免不许比现实活得久」的【正向】配对 —— staleTypeEntries 只在
    // 计数为 0 时报，目录整个没了它同样报 0，但那时该说的是「这条该删」而不是「修好了」。
    for (const d of dirs) {
      expect(existsSync(join(ROOT, d)), "基线里的目录已不存在：" + d).toBe(
        true,
      );
    }
  });
});

describe("类型棘轮：真仓库那一半", () => {
  it("tsc CLI 找得到（找不到就抛，不空跑成『0 条错』的假通过）", () => {
    expect(findTscCli(ROOT)).toMatch(/[/\\]tsc$/u);
  });

  it("真跑一次：今天的数在表内，且读数本身可信", () => {
    const run = runTypeCheck({ cwd: ROOT, tsconfig: TSCONFIG });
    // 哨兵 1：检查过的文件数有下限。include 命中 test/** + packages/*/test/**，
    // 本轮实测 269。下限取 200 是故意的 —— include 被改窄时（0006 §7 第 41 条
    // 「测试面被改窄，verify 整绿地通过」）这里先红，而不是让配额表对着空语料自证通过。
    expect(
      run.filesChecked,
      "只检查到 " + run.filesChecked + " 个 .ts，include 可能被改窄了",
    ).toBeGreaterThanOrEqual(200);
    // 哨兵 2：有匹配 `: error TS` 却解析不出来的行必须为 0。少解析一条就多放过一条，
    // 而「少报」在棘轮上是【绿】的方向 —— 这一发是那条方向上唯一的门。
    expect(run.unparsed, "有诊断行没被解析：\n" + run.tail).toBe(0);
    // 哨兵 3：非零退出必须真的对应「有错」。对不上说明我在读一份没跑起来的检查。
    expect(run.errors.length > 0).toBe(run.exitCode !== 0);

    const msg = diffTypeBaseline(countTypeErrorsByDir(run.errors));
    expect(
      msg,
      "类型棘轮红。先排除读数不可信：filesChecked=" +
        run.filesChecked +
        " errors=" +
        run.errors.length +
        " exit=" +
        run.exitCode +
        "\n尾 600 字：\n" +
        run.tail.slice(-600),
    ).toBe("");
  });

  it("test/arch 自己必须是 0 条（round277 清到 0，这一发钉住它不漂回去）", () => {
    const run = runTypeCheck({ cwd: ROOT, tsconfig: TSCONFIG });
    const arch = run.errors.filter((e) => dirOf(e.file) === "test/arch");
    expect(arch, "test/arch 下又长出类型错：" + JSON.stringify(arch)).toEqual(
      [],
    );
  });

  it("⭐ 射程 ② 不是散文：一个语法错的探针会【关掉整个类型检查】，本守卫的读数会塌", () => {
    // 这一发证明的是判据射程里那条【失效方向】：探针在场时 tsc 只报语法错、不再往下查，
    // 于是本守卫「少报」而不是「多报」。少报在棘轮上是绿的方向 ⇒ 那一刻测的不是完整语料。
    // 量法：临时目录建一个 project，一个语法错文件 + 三个各带类型错的文件，看 tsc 报几条。
    const dir = mkdtempSync(join(tmpdir(), "opc-tt-probe-"));
    try {
      writeFileSync(
        join(dir, "broken.ts"),
        "export const a: number = ;\n",
        "utf8",
      );
      for (let i = 0; i < 3; i++) {
        writeFileSync(
          join(dir, "e" + i + ".ts"),
          "const s: string = 1;\nexport {};\n",
          "utf8",
        );
      }
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, strict: true },
          include: ["*.ts"],
        }),
        "utf8",
      );
      const run = runTypeCheck({
        cwd: dir,
        tsconfig: "tsconfig.json",
        root: dir,
      });
      const codes = new Set(run.errors.map((e) => e.code));
      // 探针在场 ⇒ 三条 TS2322 一条都没报出来（实测：只有那一条 TS1109）。
      expect(
        run.errors.length,
        "探针没关掉检查 ⇒ 射程 ② 那句得改：" + run.tail,
      ).toBe(1);
      expect(codes.has("TS2322")).toBe(false);
      // 而【文件数】那条哨兵【挡不住】这一族：--listFilesOnly 照样把四个文件全列出来
      // （实测有探针/无探针都是 4）。⇒ filesChecked 管的是「include 被改窄」，
      // 这一族它管不到。两条哨兵各管各的，别把它们读成一条。
      expect(run.filesChecked).toBe(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
