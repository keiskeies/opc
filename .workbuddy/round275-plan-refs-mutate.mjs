// round275：计划引用对账守卫的变异证据（自恢复）。
//
// 三发，各打一条这一轮新立的判据。跑法同 round274：apply → 跑 plan-refs.test.ts
// → 记下哪几发红 → revert。为什么要变异：真仓库那几发今天必然绿（悬空就是本轮刚修完的），
// 它们证明不了「下次再拆一个编号 / 再改一次取材口径时会红」—— 那句话只有变异能买。
//
//  P1 把「标题集为空 ⇒ 一律红」那道哨兵拔掉（have.size < 0 永假）
//     ⇒ 实测 3 发红：「解析不出小节」「标题降级成二级」「取材为空」。
//       【预期写错过一次】：这一发第一版只红 2 发 —— 「标题降级」那发我断的是
//       toHaveLength(1)，而哨兵被拔掉后「引用 0.1 不存在」也恰好返回一条，它就绿了。
//       数目相同、判据已死。改成比对红话本身（那条哨兵的 id）之后 P1 才真的抓到它。
//       ⇒ 记进设计文档：**「返回几条」不是判据，「红话是谁」才是**。
//  P2 把精确匹配换成前缀匹配（h.startsWith(id)）
//     ⇒ 实测 2 发红（「不存在的编号」+「拿 0.4 冒充 0.4a」），真仓库那几发仍绿。
//       这打的正是本轮真实故障的形状：编号拆成 a/b 后旧引用还在，前缀匹配对它完全失明。
//  P3 把取材口径改成「只扫 ts」
//     ⇒ 实测【比预期更狠】：整个文件直接抛，一发测试都没跑起来（计划被一起删出语料，
//       readCorpus 的「没有计划文档就抛」先动）。抛比静默好，但它顺带说明
//       「计划找不到」这一族的响法是【文件级】的，不是某一发测试的。
//  P4 静默版窄口径：计划仍读进来（不抛），其余只扫 ts —— 这才是本轮
//     【真实存在过】的口径（round274 那版探针只扫 packages + test）。
//     ⇒ 第一版实测：10 发【全绿】。也就是这一发守卫对「漏掉全部两处真悬空的那个口径」
//       完全失明 —— 而它当时已经钉了「总引用数 ≥ 500」，P4 下仍有 840，撑得住。
//       ⇒ 补的修法不是加判据，是把总数拆成【分块下限】（decisions ≥ 50 文件 / ≥ 100 引用，
//         计划 ≥ 1，ts ≥ 300）。改完 P4 红在第 8 发：「docs/decisions 的 md 几乎没进语料」。
//       ⇒ 记进设计文档：**一个被撑大的总数会替一个空掉的分区作证**。
//
// 用法：node .workbuddy/round275-plan-refs-mutate.mjs apply P1|P2|P3|P4
//       node .workbuddy/round275-plan-refs-mutate.mjs revert
import { readFileSync, writeFileSync, rmSync } from "node:fs";

const FILE = "test/arch/plan-refs.ts";

const MUTS = {
  P1: ["  if (have.size === 0) {", "  if (have.size < 0) {"],
  P2: [
    "    if (!have.has(id)) out.push({ id, count });",
    "    if (![...have].some((h) => h.startsWith(id))) out.push({ id, count });",
  ],
  P3: [
    '  const paths = [...collect(root, "docs", ".md"), ...collect(root, "", ".ts")];',
    '  const paths = [...collect(root, "", ".ts")];',
  ],
  P4: [
    '  const paths = [...collect(root, "docs", ".md"), ...collect(root, "", ".ts")];',
    '  const paths = [PLAN_PATH, ...collect(root, "", ".ts")];',
  ],
};

const origin = (key) => ".workbuddy/round275-plan-orig-" + key + ".ts";

const cmd = process.argv[2];
if (cmd === "apply") {
  const key = process.argv[3];
  const m = MUTS[key];
  if (m === undefined) throw new Error("P1|P2|P3，实到 " + key);
  const src = readFileSync(FILE, "utf8");
  const n = src.split(m[0]).length - 1;
  if (n !== 1) throw new Error(key + " 锚点出现 " + n + " 次，不是恰好一次，拒绝施加");
  writeFileSync(origin(key), src);
  writeFileSync(FILE, src.replace(m[0], m[1]));
  console.log("已施加 " + key);
} else if (cmd === "revert") {
  let any = false;
  for (const key of Object.keys(MUTS)) {
    let orig;
    try {
      orig = readFileSync(origin(key), "utf8");
    } catch {
      continue;
    }
    writeFileSync(FILE, orig);
    if (readFileSync(FILE, "utf8") !== orig) {
      throw new Error(key + " 还原后逐字节核对失败");
    }
    any = true;
    console.log("已还原 " + key + " 并核对一致");
    rmSync(origin(key), { force: true });
  }
  if (!any) console.log("没有待还原的原件（本轮尚未 apply，或已还原过）");
} else {
  throw new Error("用法: apply P1|P2|P3 | revert");
}
