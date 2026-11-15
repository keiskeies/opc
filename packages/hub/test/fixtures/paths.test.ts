/**
 * `paths.ts` 那三条判据的用例。
 *
 * ── 这一节存在的唯一理由：防"归一化把判据变成恒真" ──────────────────
 * 把取材侧归一化之后，一条原本【恒红】的断言会转绿。转绿有两种成因：
 *   A. 分隔符修好了，而断言指的接线缺口【仍然在】 ⇒ 这条断言恢复了分辨力；
 *   B. 归一化顺手把过滤条件也放宽了 ⇒ 名单被清空，缺口【看不见】了。
 * B 比原来那 8 发恒红更糟 —— 恒红至少会喊，而一条被归一化洗绿的守卫一声不吭
 * （0033 §6 那条「今天恒绿的守卫要自己声明恒绿」说的是同一族）。
 * 所以下面每一发都配一发**同函数**的正向对照：证明它拦得出来，才允许它报"干净"。
 *
 * ── 为什么不能只跑真机断言就够了 ──────────────────────────────
 * 真机上那 8 发只证「今天绿」，证不出「将来有人接上接线时会红」。
 * 这里喂合成输入，把"多一个调用方"这一态当场钉住 —— 不必真去 src 里造一个调用方
 * 再删掉（那种自证会留下一次真改动，而 0013 §9 / 0012 §5 记过两次"变异脚本自己
 * 写空了"，合成输入没有那个风险）。
 */

import { describe, expect, it } from "vitest";
import { posixJoin, relPosix, toPosix } from "./paths.js";

const BS: string = String.fromCharCode(92);
const SL: string = String.fromCharCode(47);

describe("toPosix", () => {
  it("反斜杠全部转成正斜杠", () => {
    expect(toPosix(["D:", "item", "opc", "src"].join(BS))).toBe(
      "D:/item/opc/src",
    );
  });

  it("正斜杠输入原样返回（幂等 ⇒ 重复调用安全）", () => {
    expect(toPosix("packages/hub/src/x.ts")).toBe("packages/hub/src/x.ts");
    expect(toPosix(toPosix(["a", "b"].join(BS)))).toBe("a/b");
  });

  it("⭐ 正向对照：混排（原生 base + 手写正斜杠尾段）也被拉平", () => {
    // 这正是那 8 发期望值长成的样子：join() 给的前缀 + 手写的 /a/b.ts。
    const mixed =
      ["D:", "item", "opc", "packages", "hub", "src"].join(BS) +
      SL +
      "harness" +
      SL +
      "verifier.ts";
    expect(toPosix(mixed)).toBe(
      "D:/item/opc/packages/hub/src/harness/verifier.ts",
    );
  });

  it("空串仍然是空串（不造出一个斜杠）", () => {
    expect(toPosix("")).toBe("");
  });
});

describe("relPosix", () => {
  it("剥掉归一化后的前缀，只剩仓库相对那一段", () => {
    const base = toPosix(
      ["D:", "item", "opc", "packages", "hub", "src"].join(BS),
    );
    const file = [
      "D:",
      "item",
      "opc",
      "packages",
      "hub",
      "src",
      "policy",
      "auto-approve.ts",
    ].join(BS);
    expect(relPosix(file, base)).toBe("policy/auto-approve.ts");
  });

  it("base 少给一层时剥剩一层目录【不报错也不再多剥】", () => {
    // base = …/hub 而 file = …/hub/src/x.ts ⇒ 剥掉 …/hub/ 剩 src/x.ts。
    // 这一发的价值在**反面**：判据不许"猜"要剥多少层。猜多了会把
    // hub/src/policy/a.ts 与 hub/other/policy/a.ts 压成同一个 policy/a.ts，
    // 于是 A 目录的命中会被读成 B 目录的命中（少算 —— 这一族断言不能承受的那一侧）。
    const base = toPosix(["D:", "item", "opc", "packages", "hub"].join(BS));
    const file = ["D:", "item", "opc", "packages", "hub", "src", "x.ts"].join(
      BS,
    );
    expect(relPosix(file, base)).toBe("src/x.ts");
  });

  it("⭐ 正向对照：base 与 file 不同根时【不剥】，把整条路径留在报错里", () => {
    // 剥不中时必须原样交出，而不是退化成"取最后两段"之类的聪明写法。
    const base = toPosix(["D:", "item", "alpha", "src"].join(BS));
    const file = ["D:", "item", "beta", "src", "x.ts"].join(BS);
    expect(relPosix(file, base)).toBe(file.split(BS).join(SL));
    expect(relPosix(file, base)).toBe("D:/item/beta/src/x.ts");
  });

  it("分隔符不同的 base 与 file 仍然能对上（本模块的全部用处）", () => {
    const base = "D:" + BS + "item" + BS + "opc" + BS + "src";
    const file = "D:/item/opc/src/engine/dispatch.ts";
    expect(relPosix(file, base)).toBe("engine/dispatch.ts");
  });
});

describe("posixJoin", () => {
  it("原生 base + 正斜杠段 ⇒ 纯正斜杠（期望值该长这样）", () => {
    const src = ["D:", "item", "opc", "packages", "hub", "src"].join(BS);
    expect(posixJoin(src, "harness", "verifier.ts")).toBe(
      "D:/item/opc/packages/hub/src/harness/verifier.ts",
    );
  });

  it("⭐ 反向对照：它【修不掉】的写法 —— 段里塞反斜杠", () => {
    // 记这条是因为它划出了本模块的射程：只归一化 base，不清洗段。
    // 于是"段里手写反斜杠"这种写法会留下一个混排串，而混排串比不中 ⇒ 红 ⇒ 有人来看。
    // 方向是误报（可以接受），而不是少算（不可接受）。
    expect(posixJoin("D:" + BS + "src", "a" + BS + "b.ts")).toBe(
      "D:/src/a\\b.ts",
    );
    expect(posixJoin("D:" + BS + "src", "a" + BS + "b.ts")).not.toBe(
      "D:/src/a/b.ts",
    );
  });

  it("⭐ 关键形状：归一化后的取材 能与 posixJoin 的期望 相等", () => {
    // 这一发是那 8 发的最小复现。断言用 posixJoin、取材用 toPosix，两侧同形。
    const src = ["D:", "item", "opc", "packages", "hub", "src"].join(BS);
    const scanned = [
      "D:",
      "item",
      "opc",
      "packages",
      "hub",
      "src",
      "harness",
      "verifier.ts",
    ].join(BS);
    expect(toPosix(scanned)).toBe(posixJoin(src, "harness", "verifier.ts"));
    // 而**旧的**拼法（base + "/" + 段）在这台机器上比不中 —— 那 8 发的成因钉在这里。
    expect(toPosix(scanned)).not.toBe(
      src + SL + "harness" + SL + "verifier.ts",
    );
  });
});
