// round268 O10 动作 1 的行为变异证据（自恢复）。
//
// 变异：心跳调 runTimeoutPass 时把 nowMs 从「本轮时钟」换成 0 ——
// 于是没有任何卡算到期，超时巡检永远什么都不做，而【源码文本里 runTimeoutPass( 还在】。
// 这正是 r2 那条源码形状判据【看不见】的形状：接线在、参数错 ⇒ 到期照样不发生。
// 能看见它的只有 assemble.test.ts 那条行为发（ seeded 到期卡 ⇒ 首轮心跳该把它打成 rejected）。
//
// 用法：
//   node .workbuddy/round268-o10-wire-mutate.mjs apply   # 施加变异
//   node .workbuddy/round268-o10-wire-mutate.mjs revert  # 还原并逐字节核对
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "packages/hub/src/serve/assemble.ts";
const ORIGIN = ".workbuddy/round268-o10-wire-orig.ts";

const TARGET = [
  "      const to = await runTimeoutPass(",
  "        q,",
  "        q.readConnection(),",
  "        (o.now ?? scheduler.now)(),",
].join("\n");
const MUTATED = TARGET.replace("(o.now ?? scheduler.now)(),", "        0,");

const cmd = process.argv[2];
if (cmd === "apply") {
  const src = readFileSync(FILE, "utf8");
  const n = src.split(TARGET).length - 1;
  if (n !== 1) throw new Error("锚点出现 " + n + " 次，不是恰好一次，拒绝变异");
  writeFileSync(ORIGIN, src);
  writeFileSync(FILE, src.replace(TARGET, MUTATED));
  console.log("已施加变异：nowMs ⇒ 0（runTimeoutPass( 文本仍在，r2 该绿；行为发该红）");
} else if (cmd === "revert") {
  const orig = readFileSync(ORIGIN, "utf8");
  writeFileSync(FILE, orig);
  if (readFileSync(FILE, "utf8") !== orig) throw new Error("还原后逐字节核对失败");
  console.log("已还原并核对一致");
} else {
  throw new Error("用法: apply | revert");
}
