/**
 * 决策文档里【指向别处的坐标】必须指向真实存在的东西：节号、§7 的条目号、提交短哈希。
 *
 * 为什么要有这个文件：一条 §8.2 引用写下去，就等于断言【那一节存在】，而注释不参与编译、
 * 正文不是断言，tsc 与测试对它一律无感。这一族在本仓真出过事：0006 §4.1 记了一次编造的
 * 跨篇引用；0006 §7 第 18 条记了一次【声称已上报但那一节不存在】；2026-11-08 本轮又抓到一条
 * 0005 §125 —— 作者想把行号写成节号，而 0005 没有 §125（那句承诺实际在 §8，l.125 ∈ §8 已由
 * 本节机械核过）。同一天还抓到本守卫的前一版注释里两个错编号（把规矩记成 §7 第 25 条、
 * 把出处记成 0007 §4.2），说明【靠人记得去核实】这件事已经连续失败过多次，只能交给守卫。
 *
 * 取舍一：只认两种形状 —— §N / §N.M / §N.M.K，以及【000X §7 第 N 条】（N 可并列）。
 * 【第 N 条】不加 §7 前缀的一律不认：实测那种写法绝大多数指的是别的东西（Phase 0 出口标准
 * 第 2 条、biome.json 数组的第 2 条、甚至【第 5 条边】这种量词加名词）。把它们当引用会造出
 * 大量假阳，而假阳一多守卫就会被人关掉（0007 §4.1 记的正是这个代价）。
 *
 * 取舍二：本文内的 §引用，合法域是【本篇 ∪ 设计文档 ∪ 开发计划】。本仓正文确实会跨到设计
 * 文档去引需求节（实测 3 处），不收进来就是假阳。代价是【写错到设计文档里真实存在的节号】
 * 抓不到 —— 那种错只能靠人读，守卫不负责。
 *
 * 取舍三：git 不可用时报【判据失效】而不是跳过。0006 §7 第 22 条：判据坏掉和判据给出【没问题】
 * 必须能区分开，否则【我没测到】就伪装成【测过了】。
 */

import { describe, expect, it } from "vitest";

const SEC: string = String.fromCharCode(167);

import type { HeadingSets, Problem, Ref, Row, World } from "./doc-coords.js";
import {
  decisionRows,
  extractRefs,
  hashProblems,
  hashTokenCount,
  headingSets,
  itemNumbers,
  repoShortHashes,
  secExists,
  verify,
  world,
} from "./doc-coords.js";

describe("决策文档里的坐标（节号 / §7 条目号 / 短哈希）指向真实存在的东西", () => {
  it("判据本身有判别力（否则本节是恒绿装饰）", () => {
    // 反向样例必须【真能失败】：只给二级标题时一级集必须为空，否则 ## 23.1 会被折成 §23。
    const onlySub: HeadingSets = headingSets([
      "## 23.1 阶段划分",
      "### 4.1.1 决策空间",
    ]);
    expect(onlySub.top.size).toBe(0);
    expect(secExists(onlySub, "23.1")).toBe(true);
    expect(secExists(onlySub, "23")).toBe(false);
    const mixed: HeadingSets = headingSets([
      "# 1. 定位",
      "## 1.1 子",
      "## 7. 失误",
      "### 4.2.1 孙",
    ]);
    expect(secExists(mixed, "7")).toBe(true);
    expect(secExists(mixed, "4.2.1")).toBe(true);
    expect(secExists(mixed, "1.9")).toBe(false);
    // §7 条目：只数 ## 7. 到下一个一级标题之间的粗体清单行
    const items: Set<number> = itemNumbers([
      "## 7. 失误",
      "1. **甲**",
      "2. **乙**",
      "## 8. 完",
      "3. **不该算**",
    ]);
    expect([...items].sort((a, b) => a - b)).toEqual([1, 2]);
    // 提取与判定：目标篇、本篇、以及不存在三种情形各来一条
    const rows: Row[] = [
      { doc: "0006", lines: ["## 7. 失误", "1. **甲**"] },
      // byDoc 是 Map：同一个 doc 写两行，后一行会【静默覆盖】前一行 —— 上一轮我就
      // 这么把新增的 §6 覆盖没了，规则永远不触发，canary 红在计数上而不是红在规则上。
      // 所以同一个 doc 的 fixture 只能有一行，且必须把该篇所有需要的节都写全。
      {
        doc: "0007",
        lines: [
          "## 4. 甲",
          "### 4.1 乙",
          "## 6. 本篇有此节",
          "## 7. 失误",
          "5. **丙**",
        ],
      },
    ];
    // canaryLines 既是被扫描的正文，也是 World.lines：行号必须对得上，否则撤回豁免测不到。
    const canaryLines: string[] = [
      SEC + "4.1 存在",
      SEC + "4.9 不存在",
      "0006 " + SEC + "4.9 篇在但节不在（跨篇分支）",
      "0006 " + SEC + "7 第 1 条 存在",
      "0006 " + SEC + "7 第 99 条 不存在",
      "0008 " + SEC + "1 目标篇根本不存在",
      SEC + "9 本篇没有，但设计文档有",
      "【撤回】本节初稿曾写 0008 " + SEC + "5.2 云云",
      // fixture 自身不要引入多余坐标：那句话原本写着【本篇有 §6 但无 6.2】，
      // 里面的 §6 又是一条真引用，凭空把 refs 数抬 1 —— 断言的数字就变得不可解释。
      "裸引用形状歧义（本篇有该父节、无该子节）：" + SEC + "6.2 云云",
      "有前缀就明确：" + "规格 " + SEC + "6.2 云云",
      // 限定词的传递边界：前一句的【规格】不该豁免下一句的裸形引用
      "上一句提过规格 §9 的事。跨句的裸形仍须报：" + SEC + "6.2 云云",
      // 同一句里的枚举共享限定词（【规格 §9、§6.3】是常规中文写法），必须放行
      "同句共享限定词：规格 §9、" + SEC + "6.2 云云",
      // 另一路分支：外部只有计划集合有 §6.9（规格集合没有）。文中不写限定词，
      // 旧 fixture 的计划集合是空集，elsewhere 的第二个分支从未被触及。
      "赤形只在另一份文档里出现：" + SEC + "6.9 云云",
    ];
    const w: World = {
      byDoc: world(rows, new Set<string>()).byDoc,
      spec: headingSets(["# 9. 设计节", "## 6.2 设计文档里有同名子节"]),
      plan: headingSets(["## 6.9 计划里有这个子节"]),
      hashes: new Set<string>(["abc1234"]),
      lines: new Map<string, string[]>([["0007", canaryLines]]),
    };
    const refs: Ref[] = extractRefs("0007", canaryLines);
    const retracted: string[] = [];
    const probs: Problem[] = verify(refs, w, retracted);
    const found: string[] = probs.map((p: Problem) => p.why);
    // 15 = 十三条 §引用 + 两个 §7 条目 token（§7 第 N 条 只由 ITEM_RE 计一次，不双计）。
    // 注释里的数字必须跟断言一致 —— 上一版这里注释写【8】而断言是【10】，本身就是
    // 0007 §4.1 要消灭的【注释说了一套、断言做了另一套】。
    expect(refs.length).toBe(15);
    expect(found.length).toBe(7);
    // 撤回豁免必须真的咬住一条，否则它是装饰
    expect(retracted.length).toBe(1);
    expect(retracted[0]?.endsWith("0008 " + SEC + "5.2")).toBe(true);
    expect(
      found.some((s: string) => s.includes("那一节在目标篇里不存在")),
    ).toBe(true);
    expect(found.some((s: string) => s.includes("§7 没有第 99 条"))).toBe(true);
    expect(found.some((s: string) => s.includes("目标决策文档不存在"))).toBe(
      true,
    );
    // 形状歧义：本篇有父节 §6、无 §6.2，设计文档有 §6.2 ⇒ 这个 §6.2 到底是【本篇的 6.2】
    // 还是【设计文档的 6.2】，光看形状挣不出来。守卫旧版靠【设计文档有就算对】兜住了它，
    // 于是【本篇内的错号】会被设计文档的同名节洗白 —— 这就是那条假绿。
    expect(found.some((s: string) => s.includes("形状歧义"))).toBe(true);
    // 计划那一路单独钉住：去掉 elsewhere 的第二个分支，这条会退成【不存在】。
    expect(
      probs.some(
        (p: Problem) => p.ref.includes("l.13") && p.why.includes("形状歧义"),
      ),
    ).toBe(true);
    // 限定词的传递范围两个方向都要钉住（变异 M5：去掉子句截断，远处一个【规格】就能
    // 豁免后面每一句的裸形 —— 那是漏报；反过来把限定词收紧成只许紧邻，又会误伤
    // 【规格 §9、§6.3】这种常规枚举 —— 那是误报）。l.11 必须报，l.12 必须不报。
    expect(probs.some((p: Problem) => p.ref.includes("l.11"))).toBe(true);
    expect(probs.some((p: Problem) => p.ref.includes("l.12"))).toBe(false);
    // 变异 M4：本篇有父节、本篇无该子节、外部【也没有】时，正确文案是【不存在】而不是
    // 【形状歧义】—— 报成歧义会把人支使去找一个根本不存在的目标，方向就指错了。
    const pNoTarget: Problem | undefined = probs.find((p: Problem) =>
      p.ref.includes("l.2"),
    );
    expect(pNoTarget?.why.includes("形状歧义")).toBe(false);
    // 短哈希一条样例覆盖四个边界：合法的哈希不报；坏哈希报；7 位纯数字是普通数字不报；
    // 8 位以上不是【恰好 7 位】也不报（实测文档里那种 32 位 interrupt id 就是靠这条不受伤）。
    const hp: Problem[] = hashProblems(
      "0006",
      ["提交 abc1234 与 deadbee 与 1234567 与 a1b2c3d4"],
      w.hashes,
    );
    expect(hp.length).toBe(1);
    expect(hp[0]?.ref.endsWith("deadbee")).toBe(true);
  });

  it("⭐ 英文单词不被切成短哈希，而真哈希挨着标点仍被扫到", () => {
    // 这一发是修一个【真实红过】的假阳：INDEX 里写了 `succeeded` flag，旧边界
    // (?<![0-9a-f]) 只看两侧是不是 hex 字符，于是从第 2 个字母起切出 `cceeded`
    // —— 七个合法 hex 字符、含字母（连「纯数字放过」那条豁免也挡不住），
    // 报成「仓库里没有这个提交」。写文档的人据此被要求改【措辞】，而坏的是【判据】。
    // （docs/INDEX.md 的 0025 条目今天仍原样写着 `succeeded` —— 它就是这个判据的活体
    //   反向样例，谁把边界改回去，全库那一发就当场红。这里不为此新增断言：
    //   强迫文档保留某个词，比让这个词自然消失更糟。）
    const hashes: Set<string> = repoShortHashes();
    // 夹具前置：下面拿这几个 token 当【必然报坏】的样本，它们哪天成了真提交，
    // 这一发就会绿在错位上 —— 前提要钉住，不能默认它成立。
    for (const t of ["deadbee", "beef00d", "cafe123"]) {
      expect(hashes.has(t)).toBe(false);
    }
    //
    // 三个词各代表一种切法都被旧判据误伤的形状；feedback 尤其要紧：它是 8 个字符，
    // 只把【左】边界改成非字母数字挡不住它（右侧 `k` 不是 hex，旧判据本来就过得去），
    // 所以两侧必须一起收紧 —— 少收紧一侧，这一发就还是红的。
    const words: Problem[] = hashProblems(
      "0025",
      ["succeeded flag 与 feedback 与 deadbeat 都不该被当成提交"],
      hashes,
    );
    expect(words).toEqual([]);
    // 反向对照：把上面那条改成「全都不报」也能绿，所以要钉【真哈希还在被扫】。
    // 括号、反引号、句号、中文紧邻 —— 这些边界全都【不是】字母数字，一条都不许漏。
    const real: Problem[] = hashProblems(
      "0025",
      ["(deadbee) 与 `beef00d` 与 cafe123. 与 从 cafe123 起"],
      hashes,
    );
    expect(real.map((p) => p.ref.split(" → ")[1])).toEqual([
      "deadbee",
      "beef00d",
      "cafe123",
      "cafe123",
    ]);
    // 计数与判错必须【同一个】正则：判据放宽而计数不放宽，覆盖自检
    // （tokens >= 15）就与真实扫描范围脱钩，「没数到东西」又能伪装成「全对」。
    // 注意这一行用的是 deadbeat【那个词】而不是 deadbee —— 后者本身就是合法的
    // 7 位十六进制 token，写错了会让这一发断言的正是它想否证的东西（当场红过一次）。
    expect(hashTokenCount(["succeeded feedback deadbeat"])).toBe(0);
    expect(hashTokenCount(["(deadbee) `beef00d`"])).toBe(2);
  });

  it("全部坐标引用与设计文档、计划、仓库提交对得上", () => {
    const rows: Row[] = decisionRows();
    expect(rows.length).toBeGreaterThanOrEqual(6);
    const w: World = world(rows, repoShortHashes());
    // 装配自检：权威集必须非空，否则【没数到东西】会伪装成【全对】（§7 第 21、22 条）
    expect(w.spec.top.size).toBeGreaterThanOrEqual(20);
    expect(secExists(w.spec, "23.1")).toBe(true);
    const own0006 = w.byDoc.get("0006");
    expect(own0006).toBeDefined();
    expect(own0006?.items.size ?? -1).toBeGreaterThanOrEqual(28);
    expect([...w.hashes].length).toBeGreaterThanOrEqual(50);
    const refs: Ref[] = [];
    const hashProbs: Problem[] = [];
    const retracted: string[] = [];
    for (const r of rows) {
      refs.push(...extractRefs(r.doc, r.lines));
      hashProbs.push(...hashProblems(r.doc, r.lines, w.hashes));
    }
    // 引用总数必须落在一个可解释的量级：真少到接近 0，说明提取器坏了而不是文档变干净了
    expect(refs.length).toBeGreaterThanOrEqual(100);
    // 覆盖计数：真扫到了坐标才允许说【没有坏引用】—— 否则【提取器坏了】会伪装成【文档很干净】。
    // 注意坏引用数本来就是 0（本轮的全部真缺陷都已修掉），它【不该】被断言大于 0。
    let tokens: number = 0;
    for (const r of rows) tokens += hashTokenCount(r.lines);
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(verify(refs, w, retracted)).toEqual([]);
    expect(hashProbs).toEqual([]);
    // 豁免条数钉死：实测 2 条，都在 0006 那一行以【撤回】开头的记录里（正是被撤回的错误引用本身，
    // 按 0007 §4.1 必须保留原文）。用【精确等号】是故意的 —— 数字一变，就是有人新增了撤回段，
    // 必须去读一遍那些段落再改这个数字，不许默默放过。注释里说【要断言】而断言没落地，
    // 本身就是 0007 §4.1 要消灭的东西：上一版就在这里漏了断言。
    expect(retracted.length).toBe(2);
  });
});
