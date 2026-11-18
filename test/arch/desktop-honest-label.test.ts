/**
 * desktop 诚实标注守卫的测试（判据在 desktop-honest-label.ts，理由写在那儿）。
 *
 * 三段：真仓库今天自洽 / 双向变异（合成输入不碰盘）/ 取材没坏（真文件读得到）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkHonestLabel,
  type DesktopFacts,
  hasDesktopEntry,
  hasElectronDep,
  HONEST_LABEL_MARKER,
} from "./desktop-honest-label.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string =>
  readFileSync(join(ROOT, rel), "utf8");

const facts = (): DesktopFacts => ({
  pkgJson: read("packages/desktop/package.json"),
  rootScripts: read("package.json"),
  indexTs: read("packages/desktop/src/index.ts"),
});

/** 今天自洽的三串，改其中一串喂变异。 */
const base = (): Record<keyof DesktopFacts, string> => ({ ...facts() });

describe("desktop 诚实标注：真仓库今天自洽", () => {
  it("今天的 packages/desktop 判据返回空", () => {
    expect(checkHonestLabel(facts())).toBe("");
  });

  it("取材没坏：三串都读到东西，且标注确实在 index.ts 文件头", () => {
    const f = facts();
    expect(f.pkgJson).toContain('"@opc/desktop"');
    expect(f.indexTs).toContain(HONEST_LABEL_MARKER);
    expect(hasElectronDep(f.pkgJson)).toBe(false);
    expect(hasDesktopEntry(f.rootScripts)).toBe(false);
  });
});

describe("desktop 诚实标注：双向变异（合成输入）", () => {
  it("方向 A：假包被摘掉标注 ⇒ 红", () => {
    const b = base();
    expect(
      checkHonestLabel({
        ...b,
        indexTs: b.indexTs.replaceAll(HONEST_LABEL_MARKER, "占位"),
      }),
    ).toContain(HONEST_LABEL_MARKER);
  });

  it("方向 B①：补上 electron 依赖而标注还在 ⇒ 红", () => {
    const b = base();
    const withElectron = b.pkgJson.replace(
      '"@opc/contracts"',
      '"electron": "^45.0.0", "@opc/contracts"',
    );
    expect(hasElectronDep(withElectron)).toBe(true);
    expect(
      checkHonestLabel({ ...b, pkgJson: withElectron }),
    ).toContain(HONEST_LABEL_MARKER);
  });

  it("方向 B②：根 scripts 加了指向本包的入口而标注还在 ⇒ 红", () => {
    const b = base();
    const withEntry = b.rootScripts.replace(
      '"dev":',
      '"desktop": "electron packages/desktop/dist/main/index.js", "dev":',
    );
    expect(hasDesktopEntry(withEntry)).toBe(true);
    expect(checkHonestLabel({ ...b, rootScripts: withEntry })).toContain(
      HONEST_LABEL_MARKER,
    );
  });

  it("反向对照：变真【且】摘掉标注 ⇒ 绿（判据不是恒红装饰）", () => {
    const b = base();
    expect(
      checkHonestLabel({
        pkgJson: b.pkgJson.replace(
          '"@opc/contracts"',
          '"electron": "^45.0.0", "@opc/contracts"',
        ),
        rootScripts: b.rootScripts,
        indexTs: b.indexTs.replaceAll(HONEST_LABEL_MARKER, "已接线的桌面壳"),
      }),
    ).toBe("");
  });

  it("判据不吃字符串噪声：注释里提 electron 不算变真", () => {
    const b = base();
    expect(
      hasElectronDep(b.pkgJson + "\n// 未来可能要装 electron 才能跑"),
    ).toBe(false);
    expect(hasElectronDep(b.pkgJson)).toBe(false);
  });
});
