/**
 * 比较型断言对「内容不在可枚举自有键上」的类型必须有分辨力。
 *
 * ── 这条文件为什么存在（本轮最值钱的一条，出处见 0016 §1）──────────────
 * 0009 §2 时代 vitest 装不上，测试由一份 /tmp 里的替身执行；0037 §7 / 0039 已把
 * 「装不上」证伪成「4.1.5 能装、pin 的 4.1.12 当时无实体」，随 2126e1e 起真 vitest
 * 4.1.12 在本仓跑起全量 2207 例，主体由真 vitest 执行。
 * 那份替身的 `toEqual` 原先这样判两个对象：取 `Object.keys` 比较键数与逐键值。
 * 而 **Set / Map / Date / RegExp 的内容根本不落在可枚举自有键上**（Set 与 Map 在内部槽，
 * Date 在 `[[DateValue]]`，RegExp 在 `source`/`lastIndex`），于是两边键数都是 0 ⇒ **判等**。
 * 实测过：`expect(new Set(["zzz"])).toEqual(new Set(["a"]))` **通过**。
 *
 * 后果是**假绿**，而且是单向的：全仓当时有 9 条 `toEqual(new Set(...))`
 * （packages/hub/test/policy/auto-approve.test.ts 七条、test/desktop/ipc-surface.test.ts 一条、
 * packages/hub/test/graph/e2e-linear.test.ts 一条）在离线夹具下**一条都没在比东西**。
 *
 * ── 为什么这条断言写在仓库里而不是只修 /tmp ──────────────────────────
 * 夹具在 /tmp，不在版本控制里。只修它，等于修一处**没有守卫的地方**：
 * 下次重建夹具（换机器、清 /tmp、换 node 版本）会重新生成一份瞎的，而**没有任何测试会红**。
 * 本文件就是把「比较器对 Set 有分辨力」这件事钉进版本控制。
 *
 * 关键：下面每条断言都是**真 vitest 语义下也成立**的命题，不是「替身恰好这么做」。
 * 所以将来真跑 `pnpm verify` 时它一样绿 —— 它测的是**比较语义**，与执行器无关。
 * 这也是它能进仓库的前提：一条只在替身下绿、在真 vitest 下红的断言，是往仓库里埋雷。
 *
 * ── 与 0014 §2 那条纪律的关系 ─────────────────────────────────────
 * 「负责发现 X 的守卫，必须内建一个人工构造的 X」。这里人工构造的 X 是
 * 「内容不同的两个 Set」，而 X 是**断言引擎本身失效**。往上一层：本文件的失效方式是
 * 「本文件恒红」（比较器坏到什么都判不等）或「本文件恒绿而比较器瞎」——
 * 后者正是它要消灭的状态，所以用 `.not.toEqual` 这一形把它变成**会红**的。
 */

import { describe, expect, it } from "vitest";

describe("比较型断言对无枚举键的类型有分辨力（夹具瞎过一次，见 0016 §1）", () => {
  it("内容不同的 Set 不相等", () => {
    // 这一发在瞎的夹具下**通过**（⇒ 本文件红），在真 vitest 与修好的替身下都绿。
    expect(new Set(["a"])).not.toEqual(new Set(["zzz"]));
    expect(new Set([1, 2])).not.toEqual(new Set([1]));
  });

  it("内容相同的 Set 相等，且不看插入序", () => {
    // 反向对照：只有上一节那两条会红，说明比较器被改成「什么都判不等」，
    // 那同样是坏的（一个恒红的比较器与一个恒绿的比较器一样不能用）。
    expect(new Set([1, 2])).toEqual(new Set([2, 1]));
    // 多重集合意义下 {1} ≠ {1,2}：夹具里那个「逐个消费」的实现要能区分重复计数。
    expect(new Set([1])).not.toEqual(new Set([1, 2]));
  });

  it("内容不同的 Map 不相等，键缺失也算不同", () => {
    expect(new Map([["k", 1]])).not.toEqual(new Map([["k", 2]]));
    expect(new Map([["k", 1]])).not.toEqual(new Map([["q", 1]]));
    expect(new Map([["k", 1]])).toEqual(new Map([["k", 1]]));
  });

  it("不同时刻的 Date 不相等", () => {
    expect(new Date(2)).not.toEqual(new Date(1));
    expect(new Date(5)).toEqual(new Date(5));
  });

  it("不同异常类型同 message 不算相等", () => {
    /*
     * 这一条的修法值得记：光在比较器里补 `a.name === b.name` **不够**，实测仍绿。
     * 因为 `message` 是 Error 的**不可枚举**自有属性，而比较器前面还有一支
     * 「两边可枚举键数相等 ⇒ 相等」会先短路 —— 必须把 Error 也排除出那一支。
     * 「补了判据但没补到被短路的那一支」这个形状，比原始缺陷更值得留着：
     * 它让人以为已经修好了。
     */
    expect(new TypeError("m")).not.toEqual(new RangeError("m"));
    expect(new TypeError("m")).not.toEqual(new TypeError("n"));
  });

  it("不同的 RegExp 不相等", () => {
    expect(/a/g).not.toEqual(/b/g);
    expect(/a/g).not.toEqual(/a/i);
    expect(/a/g).toEqual(/a/g);
  });

  it("嵌套在对象与数组里的 Set 同样有分辨力", () => {
    /*
     * 顶层那一发已经测过 Set 了，为什么还要嵌套？实测答的：夹具里 `toEqual` 走的是
     * 一个【先看两边可枚举键数】的分支，而嵌套的 `{s: Set}` 两边都有键 `s` ⇒
     * 它先递归进键值、再在**那一层**撞进同一个瞎分支。所以瞎的成因不是「嵌套」这个形状，
     * 而是那一个分支；顶层与嵌套是**同一条代码路径的两次进入**。
     *
     * 我原先在这条注释里写的是「修的时候有两处，只修一处时顶层已能区分而嵌套仍判等」——
     * 那是没实测就写下的因果，实测正好相反：只修比较器本体而不动那个短路分支时，
     * 顶层 Set 与嵌套 Set【都】仍然判等（拿部分修复态跑过）。
     * 真正能区分两条路径的是 **`toMatchObject`** —— 它按键直接走比较器本体，
     * 所以在同一个部分修复态下它已经能分辨，而 `toEqual` 还不能。
     * 一个 matcher 的两个入口**瞎的范围不一样**，这件事只有把每个入口单独测才知道。
     */
    expect({ s: new Set([1]) }).not.toEqual({ s: new Set([2]) });
    expect([{ s: new Set([1]) }]).not.toEqual([{ s: new Set([2]) }]);
    expect({ s: new Set([1, 2]) }).toEqual({ s: new Set([2, 1]) });
    // toMatchObject 走的是另一条入口，单独占一发。
    expect({ m: new Map([["k", 1]]) }).not.toMatchObject({
      m: new Map([["k", 2]]),
    });
    expect({ m: new Map([["k", 1]]) }).toMatchObject({ m: new Map([["k", 1]]) });
  });

  it("toMatchObject 是【递归子集】，数组那一维是【等长逐元素】", () => {
    /*
     * 这一节整条都是【真 vitest 语义】，不是替身行为：夹具原先把 toMatchObject 做成
     * 「顶层键逐个全等」，于是嵌套子集那种写法在本地红、在真门禁绿 ——
     * 方向上是【比门禁更严】，不会造出假绿，但它属于 0007 §4 取舍三那一类
     * （判据坏掉必须与『没问题』可区分），而且会把本来正确的写法逼人改错。
     *
     * 本仓原有 **11 处** toMatchObject（`grep` 出来的行数含注释与本文件自己新增的用例，
     * 所以这个数是**过掉注释行、并排除本文件之后**量的）**全是顶层键 + 标量值**
     * （11 处逐处读过：没有一处 expected 里带嵌套对象或数组），两种语义在那 11 处上
     * 结果相同 —— 所以这个差异此前**零影响**。写下来是为了别把它当成一次没成本的顺手修正。
     * 数量在这条注释里的作用只有一个：它决定【这次修正的影响面是零还是十一】，
     * 而我第一版凭 grep 的行数写了 9 —— 同一次 grep 把注释也算进去了。
     * 数组那一维是修的过程中第二次被自己的探针抓到：第一版把数组整个交给全等，
     * `[{a:1,b:2}]` 对 `[{a:1}]` 就过不了（真 vitest 是等长 + 逐元素子集）。
     */
    expect({ a: { x: 1, y: 2 } }).toMatchObject({ a: { x: 1 } });
    expect({ a: { x: 1 } }).not.toMatchObject({ a: { x: 2 } });
    expect([{ a: 1, b: 2 }]).toMatchObject([{ a: 1 }]);
    // 数组【不等长】是不匹配的：子集只发生在对象那一维，不发生在元素个数那一维。
    expect([{ a: 1 }]).not.toMatchObject([{ a: 1 }, { a: 2 }]);
    // 显式写 undefined 表示【那一格必须是 undefined】，不是【无所谓】。
    expect({ a: undefined }).toMatchObject({ a: undefined });
    expect({ a: 1 }).not.toMatchObject({ a: undefined });
  });

  it("普通对象、数组、类实例这三类一直是可靠的（否则全仓断言都不成立）", () => {
    /*
     * 这条不是凑数。上面的用例说「Set 那几类瞎过」，读的人会问「那别的呢」——
     * 而这个问题只能实测回答。测过（拿**旧的**瞎夹具单独跑过一遍）：这三类在旧夹具下
     * 也是正确的（它们的内容在可枚举键上），所以本文件的断言面精确到那五类，
     * 不暗示「所有比较都不可信」那种比实际更宽的主张。
     */
    expect({ a: [1, { b: 2 }] }).toEqual({ a: [1, { b: 2 }] });
    expect({ a: [1, { b: 2 }] }).not.toEqual({ a: [1, { b: 3 }] });
    expect([1, 2]).not.toEqual([1]);
    expect({ a: 1, b: 2 }).not.toEqual({ a: 1 });
    class Box {
      x = 1;
    }
    class Box2 {
      x = 2;
    }
    expect(new Box()).not.toEqual(new Box2());
    expect(new Box()).toEqual({ x: 1 }); // vitest 的 toEqual 不比较构造函数
    expect({ a: 1, b: undefined }).toEqual({ a: 1 }); // toEqual 忽略 undefined 值的键
  });

  it("toStrictEqual 不忽略 undefined 值的键（这一条测的是夹具实现到哪）", () => {
    /*
     * 单独一发，为的是**失败归因**：夹具补 toStrictEqual 之前，它与上面那发混在一起，
     * 旧夹具下这条红的理由是 `is not a function`，而其余几条红的理由是【比较语义错】。
     * 混在一起会让人以为「普通对象的比较也坏了」—— 那是比实际更宽的主张（上面那发的注释）。
     */
    expect({ a: 1, b: undefined }).not.toStrictEqual({ a: 1 });
    expect({ a: 1 }).toStrictEqual({ a: 1 });
    class Box3 {
      x = 1;
    }
    expect(new Box3()).not.toStrictEqual({ x: 1 }); // 严格比较看原型
  });
});
