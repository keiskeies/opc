// round280 变异探针：O12 那条链（IM 回信 → 决策落库）删掉生产判据之后到底几发红。
// 用法：node .workbuddy/round280-o12-bridge-mutate.mjs          （跑全部）
//       node .workbuddy/round280-o12-bridge-mutate.mjs M1 M3   （只跑指定的）
// （纯 node 就够：本文件只 import node:fs / node:child_process，不碰 .ts ⇒
//   与 round279 那批同，不需要 tsx。别顺手加 `as` 断言，.mjs 解析不了。）
// 每一条都【先断言锚点逐字命中一次】再改，跑完立刻按原文写回并逐字节比对。
//
// ⚠ 这一批打的全是【生产代码】。测试自己变异自己（把那发验收测试里的断言删掉再跑它）
// 证不了任何事 —— 那种变异只会红在被删的那一发上，等于什么都没测。
// 家规与 round279 那批同源，见 claims-registry.test.ts 的「变异判别力」那一组。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TEST = "packages/hub/test/acceptance/im-reply-approves-card.test.ts";
const BRIDGE = "packages/hub/src/channels/approval-bridge.ts";

/**
 * 四发。每一发写清「改哪一格的哪一句」与「预测哪发红」。
 * ⚠ 变异必须【真抹掉字节】：本仓记过 `0 && X` 对一条 grep 字符串的判据是空变异。
 */
const MUTATIONS = [
  {
    id: "M1",
    file: BRIDGE,
    // 审计署名退回【照抄 ceo】。O12 验收句原文只写了「不是 system」，
    // 而两条生产决策路径写的都是 ceo ⇒ 这一发就是验收句那句断言真正的射程边界。
    from: "        actorId: role,\n",
    to: "        actorId: \"ceo\",\n",
    expect:
      "主链路那一发 + 两绑定换角色那一发（后者写死任何值都会红另一发）" +
      "；状态边同源那一发也红（两行署同一个名的前提没了）",
  },
  {
    id: "M2",
    file: BRIDGE,
    // 身份判据换成【不看 verified 的读法】：直接问库拿 ceo_role，不过 resolveBinding。
    // 这正是 im_bindings 那两个默认值造出来的冒充通道（ceo_role DEFAULT 'ceo' +
    // verified DEFAULT 0），也是抽象层文件头算了几十行的那一格。
    from:
      "    const r = resolveBinding(read, {\n" +
      "      platform,\n" +
      "      externalUserId: senderId,\n" +
      '      ...(o.knownRoles === undefined ? {} : { knownRoles: o.knownRoles }),\n' +
      "    });\n" +
      '    return r.kind === "resolved" ? r.binding.role : null;\n',
    to:
      "    const row = read\n" +
      "      .prepare('SELECT ceo_role FROM im_bindings WHERE platform = ? AND external_user_id = ?')\n" +
      "      .get(platform, senderId) as { ceo_role?: string } | undefined;\n" +
      "    return row?.ceo_role ?? null;\n",
    expect:
      "实测红 2 发：① 直调 act + pending 绑定那一发（拿到 'ceo' 并【真的批掉】）" +
      "② 撤权那一发（rebind 后 verified=0，这一读法照旧给角色）。" +
      "⚠ 走运行时那发 pending 绑定【照旧绿】—— 它的第一道门是 actorFor 自带的 resolver，" +
      "挡在 act 之前 ⇒ 这一格【只有绕开通道层直调 act 才测得到】。" +
      "这一发就是那格存在的理由：第一轮跑的时候它是空变异，10 发全绿。",
  },
  {
    id: "M3",
    file: BRIDGE,
    // 摘掉落库前的【不可逆】那一遍（保留抽象层 handleOne 那一道门）。
    // 抽象层那道管的是走运行时的调用方；`act` 是导出函数、装配方可直调 ⇒
    // 摘掉这一遍之后，O11 那条就全寄在调用顺序上。
    from:
      "    const snap = cardOf(req.approvalId);\n" +
      "    if (\n" +
      "      snap !== null &&\n" +
      "      isIrreversibleApproval(snap.approvalType, snap.parametersJson)\n" +
      "    ) {\n" +
      "      return { ok: false, why: IRREVERSIBLE_HINT };\n" +
      "    }\n",
    to: "    void cardOf;\n",
    expect:
      "不可逆直调那一发（act 现在会批掉一张不可逆卡）" +
      "；走运行时那一发【照旧绿】⇒ 证明第二道门是独立在判的，不是重复",
  },
  {
    id: "M4",
    file: BRIDGE,
    // 决策落库前【不再重查角色】：改成复用 actorFor 那次已经算好的结论。
    // 抽象层刻意让 ChannelActor 不带角色（0028 钉的「运行时不自己造身份」），
    // 所以这一格唯一的实装就是【再问一次】—— 拔掉它，撤权就不再当场生效。
    from: "    const role = d.roleOf(req.actor.senderId, req.actor.channelId);\n",
    to: "    const role = req.actor.senderId; // 复用点击那一刻算好的东西\n",
    expect:
      "撤权那一发（rebind 清回 verified=0 之后仍会落库）" +
      "；主链路那一发也红（落库的 actor 变成外部 id 而不是角色）",
  },
];

function runTests() {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", TEST],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (e) {
    out = String(e.stdout ?? "") + String(e.stderr ?? "");
    code = typeof e.status === "number" ? e.status : 1;
  }
  const esc = String.fromCharCode(27);
  const clean = out.replace(new RegExp(esc + "\\[[0-9;]*m", "gu"), "");
  const m = clean.match(
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed(?: \| (\d+) failed)?(?: \((\d+)\))?/u,
  );
  const failed = clean
    .split("\n")
    .filter((l) => /^\s+×\s/u.test(l))
    .map((l) => l.trim().slice(0, 95));
  return {
    code,
    failed,
    summary: m === null ? "(没解析到计数行)" : m[0],
  };
}

const wanted = process.argv.slice(2);
const picked =
  wanted.length === 0
    ? MUTATIONS
    : MUTATIONS.filter((m) => wanted.includes(m.id));
if (picked.length === 0) {
  console.error("没有这样的变异 id：" + wanted.join(","));
  process.exit(2);
}

// 先跑一次基线：不绿就先说明【现在】有什么问题，别把基线红算到变异头上。
const base = runTests();
console.log("基线：" + base.summary + "  exit=" + base.code);
for (const f of base.failed) console.log("  基线红 " + f);
if (base.failed.length > 0) {
  console.log("⚠ 基线不绿 ⇒ 变异读数没有意义，先修基线。");
  process.exit(1);
}

const results = [];
for (const m of picked) {
  const original = readFileSync(m.file, "utf8");
  const hits = original.split(m.from).length - 1;
  if (hits !== 1) {
    console.log(
      m.id +
        " 【跳过】锚点在 " +
        m.file +
        " 里命中 " +
        hits +
        " 次（要 1 次）⇒ 锚点过期，不是全绿",
    );
    results.push({ id: m.id, status: "锚点过期" });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), "utf8");
  let r;
  try {
    r = runTests();
  } finally {
    writeFileSync(m.file, original, "utf8");
    const back = readFileSync(m.file, "utf8");
    if (back !== original) {
      console.log("⚠ " + m.id + " 回滚后字节不一致 —— 立刻手工核对 " + m.file);
      process.exitCode = 1;
    }
  }
  console.log("\n──── " + m.id + "  " + m.file);
  console.log("  预测：" + m.expect);
  console.log("  读数：" + r.summary + "  exit=" + r.code);
  for (const f of r.failed) console.log("    红 " + f);
  results.push({
    id: m.id,
    status: r.failed.length > 0 ? "红 " + r.failed.length + " 发" : "【全绿 = 空变异】",
  });
}

console.log("\n══════ 汇总 ══════");
for (const r of results) console.log("  " + r.id + " ⇒ " + r.status);
if (results.some((r) => r.status.startsWith("【全绿"))) process.exitCode = 1;
