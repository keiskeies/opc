/**
 * 全局搜索的「面」在渲染侧不许缺格（0076）。
 *
 * 为什么要有这个文件：契约 `SEARCH_FACES` 有七面，hub 侧七面各自有 SQL、
 * 各自有测试（`packages/hub/test/search/service.test.ts` 一发覆盖七面），
 * 而渲染侧的 `faceLabels` 只有六个键、`openSearchHit` 只有六条分支 ——
 * `group` 那一面在服务端真发命中，界面上却既没有中文标签也没有落点。
 * 而且它是【静默】的：`h()` 对 `undefined` 的属性是整条跳过，
 * 于是徽标是空白而不是报错；分支缺失则是下拉关掉、屏幕原地不动。
 *
 * 这个文件守的是【奇偶】而不是【正确性】：它证明「七面各自有一格标签、
 * 各自有一条分支」，不证明标签文案写得对、也不证明落点跳得对
 * （那两半在 test/e2e/group-workbench.spec.ts 的真浏览器闭环里）。
 *
 * ⚠ 提取器自己有判别力这件事在最后一发里自证（正负两组），
 * 否则这个文件是恒绿装饰（同 test/web/renderer-criteria.test.ts 的家法）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SEARCH_FACES } from "../../packages/contracts/src/search.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const groupSrc = readFileSync(
  join(REPO, "packages/web/public/group.js"),
  "utf8",
);

/** 从 `{` 起做括号配对，返回花括号内的内容（不含首尾花括号）。 */
function braceBody(src: string, openAt: number): string {
  let depth = 0;
  for (let i = openAt; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openAt + 1, i);
    }
  }
  throw new Error("花括号没有闭合，取材失败");
}

/** 取 faceLabels 字面量的键，保持源码顺序。 */
function faceLabelKeys(src: string): string[] {
  const at = src.indexOf("const faceLabels = {");
  if (at < 0) throw new Error("找不到 faceLabels，取材失败");
  const body = braceBody(src, src.indexOf("{", at));
  return [...body.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gmu)].map(
    (m) => m[1] as string,
  );
}

/** 取 openSearchHit 里判过的面名（`hit.face === "x"`），保持源码顺序。 */
function routedFaces(src: string): string[] {
  const at = src.indexOf("async function openSearchHit(");
  if (at < 0) throw new Error("找不到 openSearchHit，取材失败");
  const body = braceBody(src, src.indexOf("{", src.indexOf(")", at)));
  return [...body.matchAll(/hit\.face === "([a-z]+)"/gmu)].map(
    (m) => m[1] as string,
  );
}

describe("搜索的七面在渲染侧各有一格", () => {
  it("faceLabels 的键集与 SEARCH_FACES 完全一致（顺序也一致）", () => {
    // 顺序也钉：下拉里同一时间的命中按面归组展示时，顺序就是人的阅读顺序，
    // 而面名单本身是有意的（group 在最前 = 搜到群先看见群）。
    expect(faceLabelKeys(groupSrc)).toEqual([...SEARCH_FACES]);
  });

  it("openSearchHit 对每一面都有一条分支（少一面 = 点它静默什么都不发生）", () => {
    const routed = routedFaces(groupSrc);
    expect(SEARCH_FACES.filter((face) => !routed.includes(face))).toEqual([]);
    // 反向不许有面外的面名：面外的分支永远进不来，留着会让人以为那一面存在。
    expect(
      routed.filter((face) => !SEARCH_FACES.includes(face as never)),
    ).toEqual([]);
  });

  it("提取器本身有判别力（否则本节是恒绿装饰）", () => {
    // 负向：抹掉 group 的标签行与那一整条分支 ⇒ 两个提取器都要报出缺口。
    const noLabel = groupSrc.replace(/^(\s*)group: "群",\n/gmu, "$1");
    const cut = noLabel.replace(
      /(if \(hit\.face === "group"\) \{[\s\S]*?\n {4}\}\n)/u,
      "",
    );
    // 变异必须真抹掉字节 —— 字节没变就是假变异，量不到任何判据。
    expect(noLabel).not.toBe(groupSrc);
    expect(cut).not.toBe(noLabel);
    expect(faceLabelKeys(cut)).not.toContain("group");
    expect(routedFaces(cut)).not.toContain("group");
    // 正向：原文件两个提取器都取到七项，证明上面那次「取不到」不是取材恒空。
    expect(faceLabelKeys(groupSrc)).toHaveLength(SEARCH_FACES.length);
    expect(routedFaces(groupSrc)).toHaveLength(SEARCH_FACES.length);
    // 取材失败的形状也要成立：拿不到对象时是抛，不是悄悄返回空数组。
    expect(() => faceLabelKeys("const x = 1;")).toThrow(/取材失败/u);
  });
});
