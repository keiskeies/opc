// round282 变异探针：O12 动作 2（真飞书适配器 + 接进 serve）删掉生产判据之后到底几发红。
// 用法：node .workbuddy/round282-o12-adapter-mutate.mjs          （跑全部）
//       node .workbuddy/round282-o12-adapter-mutate.mjs M1 M4   （只跑指定的）
// （纯 node：只 import node:fs / node:child_process，不碰 .ts ⇒ 不需要 tsx。
//   别顺手加 `as` 断言，.mjs 解析不了。）
//
// 每一条都【先断言锚点逐字命中一次】再改，跑完立刻按原文写回并逐字节比对。
// ⚠ 这一批打的全是【生产代码】。测试变异自己证不了任何事。
//
// ── 为什么这一批的【测试目标】是两个文件 ──────────────────────────────
// 适配器与装配点是一件事的两半，而它们的坏法各不相同：
//  · `feishu.ts` 坏在【一条消息被读成什么】（kind / 入队闸门 / 水位）；
//  · `im-channels.ts` 坏在【那一轮说了什么话】（notes 排空 / 错误去重）。
// 所以 TESTS 是两个文件一起跑：M4 与 M5 各自只红在其中一份上，
// 分开跑会得出「另一份的测试没用」这个错结论。
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const TESTS = [
  "packages/hub/test/channels/feishu.test.ts",
  "packages/hub/test/serve/im-channels.test.ts",
];
const FEISHU = "packages/hub/src/channels/feishu.ts";
const IMCH = "packages/hub/src/serve/im-channels.ts";

/**
 * 六发。每一发写清「改哪一格的哪一句」与「实测哪发红」。
 * ⚠ 变异必须【真抹掉字节】：本仓记过 `0 && X` 对一条 grep 字符串的判据是空变异。
 */
const MUTATIONS = [
  {
    id: "M1",
    file: FEISHU,
    // 本篇修的【真 bug】改回去：轮询读到的回传标成 kind:"text"。
    // 那一版轮询那一路整条空转，而 summarize 对 ignored_not_action 刻意不说 ⇒
    // 审批人从手机点了批准，Hub 一行日志都不打。这是本轮唯一一发「先有 bug 再补判据」。
    from:
      '    conversationId: "",\n' +
      "    text: t,\n" +
      "    atBot: false,\n" +
      '    kind: "card_action",\n',
    to:
      '    conversationId: "",\n' +
      "    text: t,\n" +
      "    atBot: false,\n" +
      '    kind: "text",\n',
    expect:
      "实测红 8 发（1 发在 feishu.test.ts 正面钉形状，7 发在 im-channels.test.ts 是后果）：" +
      "端到端那一发不再 acted / 读失败后补读那一发 / 第二轮不重播那一发 / " +
      "闲聊不入队 / 翻页截断不推水位 —— 后三发是因为【一条都不入队 ⇒ 水位不推进】。" +
      "最沉的是最后那发：「没绑定的账号点了 ⇒ warn 且不动库」跟着红，" +
      "意思是未授权点击也从『说一声』退化成【完全静默】。" +
      "两份都红是【对的】：一层钉形状，一层钉后果。",
  },
  {
    id: "M2",
    file: FEISHU,
    // 撤掉入站【入队闸门】：解不出决定的文本也塞进队列。
    // 坏的形状不是「崩溃」而是「不变式还在成立但不再说明任何事」：闲聊入队之后
    // 每轮 pollAll 为它记一条 handled，`got === handled.length` 照旧成立。
    from:
      "  return parseCardAction(message) === null\n" +
      "    ? null\n" +
      "    : {\n",
    to:
      "  return parseCardAction(message) === null\n" +
      "    ? {\n" +
      "        message,\n" +
      "        receivedAtMs: opts.receivedAtMs,\n" +
      "        deliveryId: null,\n" +
      "      }\n" +
      "    : {\n",
    expect:
      "实测红 3 发：feishu.test.ts 的「闲聊不入队」+「缺 resume 那一段也不入队」，" +
      "以及 im-channels.test.ts 的「闲聊与坏载荷不入队而水位照推进」。" +
      "⚠ 注意红的是【不入队】那几发而不是「判决变成 ignored_not_action」—— " +
      "因为后者根本不是这条判据的坏法（不变式照成立，只是不再说明任何事）。",
  },
  {
    id: "M3",
    file: FEISHU,
    // 水位【每轮无条件提交】：翻页被截断的那一轮也推。
    // 复合条件的防线（sort_type 被默默忽略 ⇒ 默认倒序 + 截断），不是当下正在发生的 bug。
    from: "    if (readComplete) this.#watermarkSec = candidateSec;\n",
    to: "    this.#watermarkSec = candidateSec;\n",
    expect:
      "实测红 1 发（如预测）：「翻页被截断的那一轮不推进水位」。" +
      "⚠ 与 M4 的对照值得一读：同样动水位，这一发【一次就红】，M4 第一次跑【全绿】。" +
      "差别不在判据而在夹具的【时间戳顺序】—— 见 M4 的 expect。",
  },
  {
    id: "M4",
    file: FEISHU,
    // 水位只推进【被收下的那一条】（源码注释里点名过的那个坏写法）。
    // 后果不是错而是成本：窗口停在旧位置 ⇒ 每轮把整段重读一遍 ⇒ 心跳越来越慢。
    // ⚠ 必须是【运行时成立】的写法：先算 en 再推水位。上一版把 `en` 写在它的
    //   声明之前 —— 那是 TDZ，红会红在 ReferenceError 上，把人带去查错的地方。
    //   那一版【没跑过】：第一次跑之前重读发现的。这里连那三行一起挪，是为了
    //   让红因只可能是「窗口没推进」这一种。
    from:
      "        if (Number.isFinite(created) && created > candidateSec) {\n" +
      "          candidateSec = created;\n" +
      "        }\n" +
      "        const en = messageToEnvelope({ channelId: this.id }, item, {\n" +
      "          receivedAtMs: this.#now(),\n" +
      "        });\n" +
      "        if (en !== null && this.#enqueue(en)) got += 1;\n",
    to:
      "        const en = messageToEnvelope({ channelId: this.id }, item, {\n" +
      "          receivedAtMs: this.#now(),\n" +
      "        });\n" +
      "        if (en !== null && this.#enqueue(en)) {\n" +
      "          got += 1;\n" +
      "          if (Number.isFinite(created) && created > candidateSec) {\n" +
      "            candidateSec = created;\n" +
      "          }\n" +
      "        }\n",
    expect:
      "实测红 1 发：「闲聊与坏载荷不入队，而水位【照它们推进】」。" +
      "⚠ 它是【成本】判据不是正确性判据：重读被 deliveryId 挡住了，所以只有专门盯" +
      "start_time 的那一发抓得到。" +
      "⚠ 这一发【第一次跑是全绿】：夹具把闲聊排在可批那条之前，两种写法的水位读数一样。" +
      "判据要能区分，夹具就得让两种写法给出不同的读数 ⇒ 那一格把时间戳顺序调反了重做，" +
      "现在批准在 SEC-7、闲聊在 SEC-6。这一条是【写完变异才补对的】。",
  },
  {
    id: "M5",
    file: FEISHU,
    // 「绝不带 body」那条改成调试期最常见的写法：把请求的那一对字段一起打出来。
    // 取 token 那一发的体里就是 app_secret ⇒ 一次失败重试把长期密钥写进日志。
    // ⚠ 必须是【运行时成立】的写法：vitest 只转译不查类型，所以「编译不过 / 引用
    //   不存在的名字」那种变异在这里也跑得起来，它测的是转译器不是判据。
    //   上一版就写了个不存在的函数 —— 那一版【没跑过】：写完这批探针、第一次跑之前重读发现的。
    //   别把它读成「实测出过这个坑」。
    from:
      '      throw new Error("取 tenant_access_token 时请求没走通：" + String(e));\n',
    to:
      "      throw new Error(\n" +
      '        "取 tenant_access_token 时请求没走通：" +\n' +
      "          String(e) +\n" +
      "          \" req=\" +\n" +
      "          JSON.stringify({\n" +
      "            app_id: this.#cfg.appId,\n" +
      "            app_secret: this.#cfg.appSecret,\n" +
      "          }),\n" +
      "      );\n",
    expect:
      "实测红 2 发：feishu.test.ts 那条凭据判据，加上 im-channels.test.ts 的" +
      "「token 请求根本没走通 ⇒ notes 恰一条 warn」—— 后者也判了 notes 里不含密钥。" +
      "两层各判一次不是重复：适配器那句抛错与装配层那句人话是两条独立的字符串，" +
      "改哪一条都可能单独把凭据带出去。",
  },
  {
    id: "M6",
    file: IMCH,
    // notes 不排空：把「这一轮要说的话」变成「攒着的话」。
    // 后果比噪音更坏 —— 第 1 轮那句「批掉 1 张」会在第 2、3 轮重播，
    // 让人以为这一轮真的又批掉了一张卡。
    from: "      const notes = pending;\n      pending = [];\n",
    to: "      const notes = pending;\n",
    expect:
      "实测红 4 发：「第二轮不重播上一轮的话」那一发（正是这一格的正面判据）+ " +
      "『同一句错误只说一次』『去重按同一句，换原因再说一遍』『溢出必须说话』。" +
      "后三发红得有价值：去重表 said 与 pending 是两条队列，notes 不排空意味着" +
      "每轮的 notes 里都【重播一遍历史上说过的每一句】，那连『重复』都算不上 —— " +
      "它把一次性提醒变成每 60 秒响一次的告警，正是本仓认定最贵的那一类噪音。",
  },
];

function runTests() {
  let out = "";
  let code = 0;
  try {
    out = execFileSync(
      process.execPath,
      ["node_modules/vitest/vitest.mjs", "run", ...TESTS],
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
