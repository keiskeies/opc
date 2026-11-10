/**
 * 跳过清单守卫的用例。判据本体在 pending-inventory.ts。
 *
 * 触发缺陷（实测）：把 test/arch/decision-index.test.ts 里一个真 it 改成 it.skip，
 * 全套 317 例退出码仍是 0 —— passed 少一条、pending 多一条，没有任何东西报警。
 * 刚装的 requireAssertions 也接不住：被 skip 的用例根本不执行，体内有没有断言
 * 都无从谈起。见 0006 §7 第 60 条。
 *
 * 这里的输入全是合成字符串，不碰仓库文件；真仓库那两条单独读盘。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ALLOW_SKIP_FILES,
  checkSkipCoverage,
  findCounters,
  findSkipForms,
} from "./pending-inventory.js";
import { looksLikeTest, parseFilesOnly } from "./test-inventory.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const NL = String.fromCharCode(10);

type TestFile = { path: string; text: string };

const one = (path: string, text: string): TestFile => {
  return { path: path, text: text };
};

const reasons = (
  files: readonly TestFile[],
  allowlist: readonly string[] = ALLOW_SKIP_FILES,
): string[] =>
  checkSkipCoverage(files, allowlist)
    .map((p: { why: string }): string => p.why)
    .sort();

describe("跳过写法扫描", () => {
  it("名单外出现 it.skip 必须报，且报出文件、行号与写法", () => {
    const text =
      "it(" +
      '"真的跑了"' +
      ", () => {});" +
      NL +
      "it.skip(" +
      '"悄悄不跑"' +
      ", () => {});";
    const got = reasons([one("pkg/a.test.ts", text)]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("pkg/a.test.ts");
    expect(got[0]).toContain("第 2 行");
    expect(got[0]).toContain("it.skip");
  });

  it("describe.skip、test.todo、it.only 都要认：同样让用例不执行", () => {
    const text =
      "describe.skip(" +
      '"整块不跑"' +
      ", () => {});" +
      NL +
      "test.todo(" +
      '"占位"' +
      ");" +
      NL +
      "it.only(" +
      '"独占"' +
      ", () => {});";
    const got = reasons([one("pkg/b.test.ts", text)]);
    expect(got.length).toBe(3);
    for (const form of ["describe.skip", "test.todo", "it.only"]) {
      expect(got.some((x: string): boolean => x.includes(form))).toBe(true);
    }
  });

  it("xit、xdescribe 这种没有点号的裸调用也要认：否则名单是假的", () => {
    const text = "xit(T, () => {});" + NL + "xdescribe(T, () => {});";
    const forms = findSkipForms("pkg/x.test.ts", text).map(
      (s: { form: string }): string => s.form,
    );
    expect(forms.sort()).toEqual(["xdescribe", "xit"]);
  });

  it("写在注释或字符串里的 it.skip 不算跳过：这是用 AST 的全部理由", () => {
    const text =
      "// 先例见 it.skip(title, fn) 这种写法" +
      NL +
      "export const QUOTED = " +
      '"it.skip(title, fn);"' +
      ";";
    expect(findSkipForms("pkg/c.test.ts", text).length).toBe(0);
    expect(reasons([one("pkg/c.test.ts", text)])).toEqual([]);
  });

  it("名单内的文件：有跳过且带【活着的】计数才算完好", () => {
    const path = "pkg/cond.test.ts";
    const text =
      "it.skip(T, () => {});" +
      NL +
      "let n = 0;" +
      NL +
      "n += 1;" +
      NL +
      "afterAll(() => { expect(n).toBe(1); });";
    expect(reasons([one(path, text)], [path])).toEqual([]);
    expect(findCounters(text).length).toBe(1);
  });

  it("名单内却没有【活着的】计数必须报：跳过多少用例无人知道", () => {
    const path = "pkg/cond.test.ts";
    const text = "it.skip(" + '"条件跳过"' + ", () => {});";
    const got = reasons([one(path, text)], [path]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("afterAll");
  });

  it("计数断言脱离 afterAll 必须报：文件里另有 afterAll 也不算数", () => {
    /* 实测过的刀：把名单内文件的 afterAll( 改成 const _unused = (，
       计数断言从此永不执行，全量 328 条退出码仍是 0。
       该文件本身还有另一处 afterAll，所以只数【有没有 afterAll】会被蒙过。 */
    const path = "pkg/cond.test.ts";
    const text =
      "it.skip(" +
      '"x"' +
      ", () => {});" +
      NL +
      "let n = 0;" +
      NL +
      "n += 1;" +
      NL +
      "afterAll(() => { expect(1).toBe(1); });" +
      NL +
      "const _unused = () => { expect(n).toBe(1); };";
    const got = reasons([one(path, text)], [path]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("计数");
  });

  it("计数从没自增过也要报：那是恒真断言，保护不了任何东西", () => {
    const path = "pkg/cond.test.ts";
    const text =
      "it.skip(T, () => {});" +
      NL +
      "let n = 0;" +
      NL +
      "afterAll(() => { expect(n).toBe(0); });";
    /* 先确认 findCounters 真看见了这个候选，否则【没数到】会被误当成【数到了零】 */
    const cs = findCounters(text);
    expect(cs.length).toBe(1);
    expect(cs[0].incremented).toBe(0);
    expect(cs[0].assertedInAfterAll).toBe(true);
    const got = reasons([one(path, text)], [path]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("运行计数");
  });

  it("计数挂在普通 it 上也不够：注册序会被 shuffle 打乱", () => {
    const path = "pkg/cond.test.ts";
    const text =
      "it.skip(" +
      '"x"' +
      ", () => {});" +
      NL +
      "let n = 0;" +
      NL +
      "n += 1;" +
      NL +
      "it(" +
      '"计数"' +
      ", () => { expect(n).toBe(1); });";
    expect(reasons([one(path, text)], [path]).length).toBe(1);
  });

  it("计数确实挂在 afterAll 上时才算完好", () => {
    const path = "pkg/cond.test.ts";
    const text =
      "it.skip(" +
      '"x"' +
      ", () => {});" +
      NL +
      "let n = 0;" +
      NL +
      "n += 1;" +
      NL +
      "afterAll(() => { expect(n).toBe(1); });";
    expect(reasons([one(path, text)], [path])).toEqual([]);
  });

  it("反向也要报：名单内的文件已不再跳过任何用例，说明名单过期了", () => {
    const path = "pkg/cond.test.ts";
    const text = "it(" + '"现在总跑"' + ", () => {});";
    const got = reasons([one(path, text)], [path]);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("已经不再跳过");
  });

  it("空输入与空名单都不许被当成【没问题】", () => {
    expect(reasons([])).toEqual([expect.stringContaining("空转")]);
    expect(
      reasons([one("pkg/a.test.ts", "it(" + '"x"' + ", () => {});")], []),
    ).toEqual([expect.stringContaining("掏空")]);
  });

  it("扫描器本身有判别力（否则本节是恒绿装饰）", () => {
    const clean = [
      one("pkg/a.test.ts", "it(" + '"跑"' + ", () => {});"),
      one("pkg/b.test.ts", "it(" + '"也跑"' + ", () => {});"),
    ];
    expect(reasons(clean)).toEqual([]);
    const dirty = [
      one("pkg/a.test.ts", "it.skip(" + '"不跑"' + ", () => {});"),
      one("pkg/b.test.ts", "it.skip(" + '"也不跑"' + ", () => {});"),
    ];
    expect(reasons(dirty).length).toBe(2);
  });
});

describe("真仓库", () => {
  const collect = (): TestFile[] => {
    const out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "list", "--files-only"],
      { cwd: ROOT, encoding: "utf8", maxBuffer: 120000000 },
    );
    return parseFilesOnly(out)
      .filter((p: string): boolean => looksLikeTest(p))
      .map((p: string): TestFile => {
        return { path: p, text: readFileSync(join(ROOT, p), "utf8") };
      });
  };

  it("被收集的真文件必须一条问题都不报，且扫描通路确实读到了东西", () => {
    const files = collect();
    /* 通路坏了也表现为【零问题】，所以先钉住它真的读了文件（§7 第 38 条） */
    expect(files.length).toBeGreaterThanOrEqual(21);
    expect(reasons(files).join(" | ")).toEqual("");
  });

  it("真仓库里唯一带跳过的文件，正是名单里那一个", () => {
    const files = collect();
    const skipping = files
      .filter(
        (f: TestFile): boolean => findSkipForms(f.path, f.text).length > 0,
      )
      .map((f: TestFile): string => f.path)
      .sort();
    expect(skipping).toEqual([...ALLOW_SKIP_FILES].sort());
    expect(skipping.length).toBeGreaterThan(0);
  });
});
